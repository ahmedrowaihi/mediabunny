/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ReadableStreamSource } from 'mediabunny';
import { Demuxer, Muxer } from 'node-av/api';
import { FFmpegError } from 'node-av';
import { wakePendingAccept } from './misc';
import { Writable } from 'node:stream';

/** Microseconds. */
const PER_SECOND = 1e6;

// `rw_timeout` bounds one read rather than the session, so it is given the bound unscaled: below it a stall
// in a healthy stream is cut mid-packet, above it an ended stream takes longer to notice. See FORK.md.

const MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof';

/**
 * Options for {@link RtmpSource}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type RtmpSourceOptions = {
	/**
	 * Whether to accept a publisher (`'listener'`) or dial out to one (`'caller'`). Defaults to
	 * `'caller'`, so a URL names something to connect to unless listening is asked for.
	 */
	mode?: 'listener' | 'caller';
	/**
	 * Seconds to wait for a publisher to appear while listening. Defaults to 30. Never infinite: a wait
	 * cannot be cancelled once started.
	 *
	 * Applies to `'listener'` mode only. rtmp's `timeout` option implies listen mode, so it cannot be
	 * given to a caller without turning it into a listener; a caller's connect is bounded by the
	 * protocol instead, at around five seconds. See FORK.md.
	 */
	connectTimeout?: number;
	/**
	 * Seconds to wait for data from a connected publisher before ending the stream. Defaults to 30.
	 */
	readTimeout?: number;
	/**
	 * Seconds of media per fMP4 fragment, defaulting to 0.5. Smaller means lower latency and more
	 * container overhead.
	 */
	fragmentDuration?: number;
	/** Maximum bytes to keep for re-reads. Passed through to Mediabunny's `ReadableStreamSource`. */
	maxCacheSize?: number;
};

type Resolved = Required<Omit<RtmpSourceOptions, 'maxCacheSize'>>;

const positive = (value: number | undefined, name: string) => {
	if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
		throw new TypeError(`options.${name}, when provided, must be a positive number.`);
	}
};

// rtmp ignores URL query options, so bounds and listen mode travel as real AVOptions.
const inputOptions = (options: Resolved): Record<string, string> => {
	const result: Record<string, string> = {
		rw_timeout: String(Math.max(1, Math.round(options.readTimeout * PER_SECOND))),
	};
	if (options.mode === 'listener') {
		result['listen'] = '1';
		// Seconds here, unlike every other bound in this file. Listener only: rtmp reads `timeout` as
		// implying listen mode, so giving it to a caller makes the caller try to bind.
		result['timeout'] = String(Math.max(1, Math.round(options.connectTimeout)));
	}
	return result;
};

/** Remuxes one RTMP stream to fragmented MP4, holding the pump's state where `cancel` can see it. */
/** Whether an error is the publisher having closed the connection, rather than a failure to read from it. */
const isPeerClosed = (error: unknown) => {
	return error instanceof FFmpegError && (error.isEIO || error.isEPIPE || error.isEOF);
};

class RtmpStreamReader {
	private demuxer: Demuxer | undefined;
	private pump: Promise<void> | null = null;
	private pendingOpen: Promise<unknown> | null = null;
	private canceled = false;
	private notify: (() => void) | null = null;
	private lastByteAt = 0;
	private silent = false;
	private closed = false;
	private silenceTimer: ReturnType<typeof setInterval> | undefined;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

	constructor(private url: string, private options: Resolved) {}

	private closeOnce() {
		if (this.closed) {
			return;
		}

		this.closed = true;
		try {
			this.controller?.close();
		} catch {
			// Already closed or errored; nothing to end
		}
	}

	/** Resolves whoever is parked in `pull`, so a chunk or an ending reaches the consumer at once. */
	private wake() {
		const resolve = this.notify;
		this.notify = null;
		resolve?.();
	}

	/**
	 * Ends the stream between fragments rather than leaving it to `rw_timeout`, which would interrupt a
	 * read and resume off a packet boundary.
	 */
	private startSilenceClock() {
		const silenceMs = this.options.readTimeout * 1000;
		this.silenceTimer = setInterval(() => {
			// `lastByteAt` stays 0 until the first byte: waiting for a publisher is the connect bound's
			// business, and timing it here would cut the stream before it started
			if (this.canceled || this.lastByteAt === 0 || Date.now() - this.lastByteAt < silenceMs) {
				return;
			}

			this.silent = true;
			// Closed here rather than at the next `pull`, or a consumer that is not asking would leave the
			// stream open until the backstop fired
			clearInterval(this.silenceTimer);
			this.closeOnce();
			this.wake();
		}, Math.max(50, Math.min(silenceMs / 4, 1000)));
		this.silenceTimer.unref?.();
	}

	private sink() {
		return new Writable({
			write: (chunk: Buffer, _encoding, callback) => {
				// `closed` as well as `canceled`: the silence clock may have ended the stream mid-fragment,
				// and enqueuing onto a closed controller throws back into the pump
				if (!this.canceled && !this.closed) {
					this.lastByteAt = Date.now();
					this.controller?.enqueue(new Uint8Array(chunk));
					this.wake();
				}

				callback();
			},
		});
	}

	private async run(controller: ReadableStreamDefaultController<Uint8Array>) {
		this.controller = controller;
		this.startSilenceClock();

		const opening = Demuxer.open(this.url, { options: inputOptions(this.options) });
		this.pendingOpen = opening;
		try {
			this.demuxer = await opening;
		} finally {
			this.pendingOpen = null;
		}

		// A callback-backed muxer context is freed rather than closed, so there is no socket here to race
		// a cancel against; the demuxer's read is the only thing cancel has to wait for
		const muxer = await Muxer.open(this.sink(), {
			format: 'mp4',
			options: {
				movflags: MOVFLAGS,
				frag_duration: String(Math.max(1, Math.round(this.options.fragmentDuration * PER_SECOND))),
			},
		});

		const outputIndices = new Map<number, number>();
		for (const stream of this.demuxer.streams) {
			outputIndices.set(stream.index, muxer.addStream(stream));
		}

		try {
			for await (const packet of this.demuxer.packets()) {
				if (this.canceled || this.silent) {
					break;
				}
				if (!packet) {
					continue;
				}

				const index = outputIndices.get(packet.streamIndex);
				if (index !== undefined) {
					await muxer.writePacket(packet, index);
				}
			}
		} catch (error) {
			// A publisher going away is how a live publish normally ends, and it ends by closing the socket -
			// which libavformat reports as EIO, having no EOF for one. node-av 6.2 stopped translating a read
			// failure into a clean end of stream, so that arrives here as an error and has to be read as the end.
			if (!isPeerClosed(error)) {
				throw error;
			}
		}
	}

	pull(controller: ReadableStreamDefaultController<Uint8Array>) {
		// Started on the first read, so constructing an RtmpSource binds no port
		this.pump ??= this.run(controller)
			.then(() => {
				if (!this.canceled) {
					this.closeOnce();
				}
			})
			.catch((error: unknown) => {
				if (!this.canceled && !this.closed) {
					this.closed = true;
					controller.error(error);
				}
			})
			.finally(() => {
				clearInterval(this.silenceTimer);
				this.wake();
			});

		// Resolves on the next chunk rather than immediately: the pump enqueues on its own schedule, and
		// returning now would have the stream call `pull` in a loop
		return new Promise<void>((resolve) => {
			this.notify = resolve;
		});
	}

	async cancel() {
		this.canceled = true;
		clearInterval(this.silenceTimer);

		// A pending accept outlives a close
		if (this.options.mode === 'listener' && this.pendingOpen) {
			await wakePendingAccept(this.url);
		}

		// The pump is parked inside a native read that nothing can interrupt, and closing the demuxer
		// under it aborts the process. Waiting is bounded by the read timeout; see FORK.md.
		await this.pump?.catch(() => {});
		await this.demuxer?.close().catch(() => {});
	}
}

const openStream = (url: string, options: Resolved): ReadableStream<Uint8Array> => {
	const reader = new RtmpStreamReader(url, options);

	return new ReadableStream<Uint8Array>({
		pull: controller => reader.pull(controller),
		cancel: () => reader.cancel(),
	// Room to run ahead of the consumer, as a live publisher does not wait.
	}, { highWaterMark: 64 });
};

/**
 * A {@link https://mediabunny.dev/guide/reading-media-files#source | Source} that reads a live RTMP
 * stream, so an `Input` can read it like any other source.
 *
 * The FLV is remuxed to fragmented MP4 in process — no relay, no temporary files — and Mediabunny
 * demuxes the result. AVC and HEVC pass through without re-encoding. The socket is opened on the first
 * read, so constructing one never blocks.
 *
 * @example
 * ```ts
 * const input = new Input({
 * 	source: new RtmpSource('rtmp://0.0.0.0:1935/live/key', { mode: 'listener' }),
 * 	formats: ALL_FORMATS,
 * });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class RtmpSource extends ReadableStreamSource {
	constructor(url: string, options: RtmpSourceOptions = {}) {
		if (typeof url !== 'string') {
			throw new TypeError('url must be a string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.mode !== undefined && options.mode !== 'listener' && options.mode !== 'caller') {
			throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
		}
		positive(options.connectTimeout, 'connectTimeout');
		positive(options.readTimeout, 'readTimeout');
		positive(options.fragmentDuration, 'fragmentDuration');

		const scheme = url.slice(0, url.indexOf(':'));
		if (scheme !== 'rtmp' && scheme !== 'rtmps') {
			throw new TypeError(`RtmpSource: ${JSON.stringify(url)} is not an rtmp:// or rtmps:// URL.`);
		}

		super(openStream(url, {
			mode: options.mode ?? 'caller',
			connectTimeout: options.connectTimeout ?? 30,
			readTimeout: options.readTimeout ?? 30,
			fragmentDuration: options.fragmentDuration ?? 0.5,
		}), { liveRefreshInterval: 0, maxCacheSize: options.maxCacheSize });
	}
}
