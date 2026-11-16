/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AppendOnlyStreamTarget } from 'mediabunny';
import { Demuxer, Muxer } from 'node-av/api';
import { FFmpegError } from 'node-av';
import { Readable } from 'node:stream';
import { checkUrlAndOptions } from './misc';

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

	constructor(private readonly url: string) {
		// Paused until read: ffmpeg pulls at its own rate, and pushing ahead of it would buffer the
		// whole stream in this process rather than in the socket
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

		// push returns false when ffmpeg is behind, which is the backpressure a live publish needs
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
		// The format is stated because a stream cannot be probed by seeking, and `options` is also what
		// selects the Readable overload rather than the path/Buffer one
		const demuxer = await Demuxer.open(this.source, { format: 'mp4' });
		// No write bound to pass: `rw_timeout` is not an option the flv muxer takes, and rtmp ignores URL
		// query options, so the connect and the writes are bounded by the protocol itself.
		const muxer = await Muxer.open(this.url, { format: 'flv' });

		const outputIndices = new Map<number, number>();
		for (const stream of demuxer.streams) {
			outputIndices.set(stream.index, muxer.addStream(stream));
		}

		try {
			for await (const packet of demuxer.packets()) {
				if (!packet) {
					continue;
				}

				const index = outputIndices.get(packet.streamIndex);
				if (index !== undefined) {
					await muxer.writePacket(packet, index);
					this.publishedPackets++;
				}
			}
		} catch (error) {
			// A server dropping the publish closes the socket, which libavformat reports as EIO: that is
			// the end of a publish rather than a failure to make one
			if (!isPeerClosed(error)) {
				throw error;
			}
		} finally {
			await muxer.close().catch(() => {});
			await demuxer.close().catch(() => {});
		}
	}

	private async finish() {
		if (this.closed) {
			return;
		}
		this.closed = true;

		// Ends the demuxer's read, which is what lets the pump finish the file it is remuxing
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
}
