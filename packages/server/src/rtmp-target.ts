/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AppendOnlyStreamTarget } from 'mediabunny';
import { Demuxer, Muxer } from 'node-av/api';
import * as NodeAv from 'node-av';
import { FFmpegError } from 'node-av';
import { Readable } from 'node:stream';
import { checkUrlAndOptions } from './misc';
import { type AmfValue, encodeAmfDataMessage } from './amf';

/**
 * Options for {@link RtmpTarget}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type RtmpTargetOptions = Record<string, never>;

/** Whether an error is the server having closed the connection rather than a failure to write. */
const isPeerClosed = (error: unknown) =>
	error instanceof FFmpegError && (error.isEIO || error.isEPIPE || error.isEOF);

/**
 * Remuxes the fragmented MP4 the caller writes into FLV, and publishes that over RTMP. Separate from
 * the target so the writable exists before `super()` runs.
 */
class RtmpSink {
	readonly writable: WritableStream<Uint8Array>;

	/** What the caller writes into, and what ffmpeg's demuxer reads out of. */
	private readonly source: Readable;
	private pump: Promise<void> | null = null;
	private failure: Error | null = null;
	private closed = false;
	private drained: (() => void) | null = null;

	publishedPackets = 0;

	/**
	 * Messages waiting for a media packet to be written beside.
	 *
	 * They cannot go out on their own: the FLV header is written with the first packet, and a script
	 * tag before it would be refused. Draining them inside the packet loop also keeps them in step with
	 * the media rather than racing the muxer's own queues.
	 */
	private pendingMessages: { payload: Uint8Array; timestamp: number | null }[] = [];
	private dataStreamIndex: number | null = null;
	private formatContext: NodeAv.FormatContext | null = null;
	amfMessagesSent = 0;

	constructor(private readonly url: string) {
		this.source = new Readable({ read: () => this.wake() });

		this.writable = new WritableStream<Uint8Array>({
			write: chunk => this.write(chunk),
			close: () => this.finish(),
			abort: () => this.finish(),
		});
	}

	private wake() {
		const resolve = this.drained;
		this.drained = null;
		resolve?.();
	}

	private async write(chunk: Uint8Array) {
		const pending = this.failure;
		if (pending) {
			throw pending;
		}

		// Started on the first write, so constructing an RtmpTarget opens no connection
		this.pump ??= this.run().catch((error: unknown) => {
			this.failure ??= error instanceof Error ? error : new Error(String(error));
			this.source.destroy();
			this.wake();
		});

		if (!this.source.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
			await new Promise<void>((resolve) => {
				this.drained = resolve;
			});
		}

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}

	/** @internal */
	private async run() {
		const demuxer = await Demuxer.open(this.source, { format: 'mp4' });
		const muxer = await Muxer.open(this.url, { format: 'flv' });

		const outputIndices = new Map<number, number>();
		for (const stream of demuxer.streams) {
			outputIndices.set(stream.index, muxer.addStream(stream));
		}

		// A data stream, so timed AMF can be written as FLV script tags. Added through the format
		// context because node-av's `Muxer` only takes streams copied from a demuxer or driven by an
		// encoder, and there is neither here; it must exist before the header is written.
		const formatContext = muxer.getFormatContext();
		const dataStream = formatContext.newStream(null);
		dataStream.codecpar.codecType = NodeAv.AVMEDIA_TYPE_DATA;
		// `NONE` is what makes ffmpeg's FLV muxer write the packet verbatim as the tag body; with
		// `TEXT` it builds an `onTextData` message of its own around the bytes instead
		dataStream.codecpar.codecId = NodeAv.AV_CODEC_ID_NONE;
		dataStream.timeBase = new NodeAv.Rational(1, 1000);

		this.formatContext = formatContext;
		this.dataStreamIndex = dataStream.index;

		try {
			for await (const packet of demuxer.packets()) {
				if (!packet) {
					continue;
				}

				const index = outputIndices.get(packet.streamIndex);
				if (index !== undefined) {
					await muxer.writePacket(packet, index);
					this.publishedPackets++;

					await this.drainMessages(this.millisecondsOf(packet));
				}
			}
		} catch (error) {
			if (!isPeerClosed(error)) {
				throw error;
			}
		} finally {
			await muxer.close().catch(() => {});
			await demuxer.close().catch(() => {});
		}
	}

	/** A packet's presentation time in milliseconds, which is the time base an FLV tag is stamped in. */
	private millisecondsOf(packet: { pts: bigint; timeBase: NodeAv.Rational }) {
		const { num, den } = packet.timeBase;
		if (!den || !num) {
			return 0;
		}

		return Math.max(0, Math.round(Number(packet.pts) * 1000 * num / den));
	}

	private async drainMessages(defaultTimestamp: number) {
		if (this.pendingMessages.length === 0 || this.formatContext === null || this.dataStreamIndex === null) {
			return;
		}

		const messages = this.pendingMessages;
		this.pendingMessages = [];

		for (const message of messages) {
			const packet = new NodeAv.Packet();
			packet.alloc();
			packet.data = Buffer.from(message.payload);
			packet.streamIndex = this.dataStreamIndex;

			const timestamp = BigInt(message.timestamp ?? defaultTimestamp);
			packet.pts = timestamp;
			packet.dts = timestamp;
			packet.timeBase = new NodeAv.Rational(1, 1000);

			const ret = await this.formatContext.interleavedWriteFrame(packet);
			FFmpegError.throwIfError(ret, 'Write AMF data message');
			this.amfMessagesSent++;
		}
	}

	/** @internal */
	queueMessage(payload: Uint8Array, timestamp: number | null) {
		if (this.closed) {
			throw new Error('RtmpTarget: the stream has been finalized, so nothing more can be sent on it.');
		}

		this.pendingMessages.push({ payload, timestamp });
	}

	private async finish() {
		if (this.closed) {
			return;
		}
		this.closed = true;

		this.source.push(null);
		this.wake();
		await this.pump?.catch(() => {});

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}
}

/**
 * An {@link https://mediabunny.dev/guide/writing-media-files#target | output target} that publishes over
 * RTMP, the counterpart to {@link RtmpSource}.
 *
 * RTMP carries FLV, which this library does not mux, so the target takes the **fragmented MP4** an
 * `Output` writes and remuxes it: `new Mp4OutputFormat({ fastStart: 'fragmented' })`, whose empty
 * `moov` is what lets the stream be read before it ends. A non-fragmented format cannot be published,
 * since its `moov` is only written at the end.
 *
 * The connection opens on the first write, so constructing one never blocks, and a server that drops
 * the publish ends the stream rather than erroring — reconnecting is the caller's, by building a new
 * `Output`.
 *
 * @example
 * ```ts
 * const output = new Output({
 * 	format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
 * 	target: new RtmpTarget('rtmp://server/live/streamkey'),
 * });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class RtmpTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private readonly sink: RtmpSink;

	constructor(url: string, options: RtmpTargetOptions = {}) {
		checkUrlAndOptions(url, options);

		const scheme = url.slice(0, url.indexOf(':'));
		if (scheme !== 'rtmp' && scheme !== 'rtmps') {
			throw new TypeError(`RtmpTarget: ${JSON.stringify(url)} is not an rtmp:// or rtmps:// URL.`);
		}

		const sink = new RtmpSink(url);
		super(sink.writable);
		this.sink = sink;
	}

	/** Packets published so far, which stays 0 until the server has taken the first one. */
	get publishedPackets(): number {
		return this.sink.publishedPackets;
	}

	/** AMF data messages written so far. */
	get amfMessagesSent(): number {
		return this.sink.amfMessagesSent;
	}

	/**
	 * Sends a timed AMF data message, which RTMP carries as an FLV script data tag.
	 *
	 * This is the only way to put timed data on an RTMP stream: there is no data track to add to an
	 * `Output`, so the message is handed to the target directly. It is written beside the next media
	 * packet rather than at once - an FLV's header is written with the first packet, and a script tag
	 * ahead of it would be refused - so sending before any media has flowed queues it rather than
	 * failing. Nothing is sent at all if the stream ends before a packet does.
	 *
	 * @param name - What a receiver dispatches on, such as `'onCuePoint'` or `'onTextData'`.
	 * @param value - The message's single argument, usually an object of properties.
	 */
	sendAmfData(
		name: string,
		value: AmfValue,
		options: {
			/** When the message applies, in seconds. Defaults to the time of the packet it rides beside. */
			timestamp?: number;
			/**
			 * Encodes the argument as an ECMA array rather than an object, which is how `onMetaData` is
			 * written and what some receivers expect of everything beside it.
			 */
			asEcmaArray?: boolean;
		} = {},
	): void {
		if (typeof name !== 'string') {
			throw new TypeError('RtmpTarget: the message name must be a string.');
		}
		if (options.timestamp !== undefined && (!Number.isFinite(options.timestamp) || options.timestamp < 0)) {
			throw new TypeError('RtmpTarget: options.timestamp, when provided, must be a non-negative number.');
		}

		this.sink.queueMessage(
			encodeAmfDataMessage(name, value, options.asEcmaArray ?? false),
			options.timestamp === undefined ? null : Math.round(options.timestamp * 1000),
		);
	}

	/**
	 * Sends an `onCuePoint` message, which is how an ad break or a chapter boundary is marked on a live
	 * stream.
	 *
	 * The shape is Adobe's: a name, a type of `'event'` or `'navigation'`, the time in SECONDS, and
	 * whatever parameters the receiver has agreed to read.
	 */
	sendCuePoint(cuePoint: {
		/** What the cue point is called, which is what a receiver matches on. */
		name: string;
		/** `'event'` for something that happens, `'navigation'` for a seekable point. Defaults to `'event'`. */
		type?: 'event' | 'navigation';
		/** In seconds. Also stamped on the tag itself. */
		time: number;
		/** Whatever the receiver has agreed to read beside the three fields above. */
		parameters?: Record<string, AmfValue>;
	}): void {
		if (!cuePoint || typeof cuePoint.name !== 'string' || !cuePoint.name) {
			throw new TypeError('RtmpTarget: a cue point must be named.');
		}
		if (!Number.isFinite(cuePoint.time) || cuePoint.time < 0) {
			throw new TypeError('RtmpTarget: a cue point\'s time must be a non-negative number of seconds.');
		}

		this.sendAmfData('onCuePoint', {
			name: cuePoint.name,
			type: cuePoint.type ?? 'event',
			time: cuePoint.time,
			parameters: cuePoint.parameters ?? {},
		}, { timestamp: cuePoint.time });
	}

	/**
	 * Sends an `onTextData` message, which carries a line of text - a caption, a telemetry reading - at
	 * a point in the stream.
	 */
	sendTextData(text: string, options: {
		/** When the text applies, in seconds. Defaults to the time of the packet it rides beside. */
		timestamp?: number;
		/** An ISO 639 code, stated beside the text where the receiver can use one. */
		language?: string;
	} = {}): void {
		if (typeof text !== 'string') {
			throw new TypeError('RtmpTarget: the text must be a string.');
		}

		const value: Record<string, AmfValue> = { text };
		if (options.language !== undefined) {
			value['language'] = options.language;
		}

		this.sendAmfData('onTextData', value, { timestamp: options.timestamp });
	}
}
