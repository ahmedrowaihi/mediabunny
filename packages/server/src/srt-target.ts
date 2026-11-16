/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AppendOnlyStreamTarget } from 'mediabunny';
import { IOContext } from 'node-av';
import { AVIO_FLAG_WRITE } from 'node-av/constants';
import {
	DEFAULT_MAX_QUEUE_BYTES, checkPassphrase, checkUrlAndOptions, installSecretRedactingLog, positive,
	redactUrl, throwFailedOpen, wakePendingAccept,
} from './misc';

/** 7 MPEG-TS packets, which is what SRT carries in a live-mode datagram. */
const PAYLOAD_SIZE = 1316;

/** Seconds `close` may spend delivering what is still buffered. SRT's live-mode default is 0. */
const DEFAULT_LINGER_SECONDS = 5;

/**
 * Options for {@link SrtTarget}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type SrtTargetOptions = {
	/**
	 * **Seconds** to wait for a peer - for a caller to answer, or for one to arrive while listening.
	 * Defaults to 30. Never infinite: a wait cannot be cancelled once started.
	 */
	connectTimeout?: number;
	/** AES passphrase. SRT requires 10 to 79 characters. Without one the stream is unencrypted. */
	passphrase?: string;
	/** AES key length in bits. Defaults to 128. Only meaningful alongside a passphrase. */
	keyLength?: 128 | 192 | 256;
	/**
	 * SRT latency budget in **milliseconds**, the window it has to recover lost packets in.
	 *
	 * Named for its unit because the timeouts beside it are in seconds, which is easy to cross.
	 */
	latencyMs?: number;
	/**
	 * SRT latency budget in milliseconds.
	 *
	 * @deprecated Use {@link SrtTargetOptions.latencyMs}, which states its unit. Still milliseconds, so
	 * a value that worked here still works there.
	 */
	latency?: number;
	/**
	 * Bytes to hold for a receiver that is not keeping up, before the target starts dropping. Defaults
	 * to 2 MiB. See {@link SrtTarget} for what dropping means.
	 */
	maxQueueBytes?: number;
};

type Queued = { chunks: Uint8Array[]; bytes: number };

/**
 * Owns the libav IO state, the outbound queue and the pump that drains one into the other. Separate
 * from the target so the writable can be built before `super()` runs.
 */
class SrtSink {
	readonly writable: WritableStream<Uint8Array>;

	private io: IOContext | undefined;
	private opening = false;
	private pumping: Promise<void> | null = null;
	private failure: Error | null = null;
	private closed = false;

	private queue: Queued = { chunks: [], bytes: 0 };
	private readonly partial = new Uint8Array(PAYLOAD_SIZE);
	private partialLength = 0;

	droppedBytes = 0;
	droppedDatagrams = 0;
	sentBytes = 0;

	get queuedBytes(): number {
		return this.queue.bytes;
	}

	constructor(
		private readonly url: string,
		readonly maxQueueBytes: number,
		private readonly listening: boolean,
		private readonly encrypted: boolean,
	) {
		this.writable = new WritableStream<Uint8Array>({
			write: chunk => this.enqueue(chunk),
			close: () => this.finish(),
		});
	}

	/**
	 * Takes the bytes and returns rather than awaiting the socket: pushing back here would stall the
	 * muxer for as long as the receiver was behind, which on a live feed is unbounded. Past the queue
	 * bound the *arriving* bytes go, not the queued ones, so what is queued stays a contiguous run.
	 */
	private enqueue(chunk: Uint8Array): void {
		if (this.failure) {
			throw this.failure;
		}

		if (this.queue.bytes + chunk.byteLength > this.maxQueueBytes) {
			this.droppedBytes += chunk.byteLength;
			this.droppedDatagrams += Math.ceil(chunk.byteLength / PAYLOAD_SIZE);
			return;
		}

		this.queue.chunks.push(chunk);
		this.queue.bytes += chunk.byteLength;
		void this.kick();
	}

	/** Starts the pump unless one is already running, which is the only way one ever starts. */
	private kick(): Promise<void> {
		this.pumping ??= this.pump().finally(() => {
			this.pumping = null;
		});
		return this.pumping;
	}

	private async writeDatagram(bytes: Uint8Array) {
		const io = this.io!;
		await io.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

		// write resolves without a count, so the context's own error is the only report of a dead peer
		if (io.error < 0) {
			throw new Error(`SrtTarget: the peer stopped accepting data (AVERROR ${io.error}).`);
		}

		this.sentBytes += bytes.byteLength;
	}

	private async pump() {
		try {
			if (!this.io) {
				const context = new IOContext();
				this.opening = true;
				const ret = await context.open2(this.url, AVIO_FLAG_WRITE);
				if (ret < 0) {
					await throwFailedOpen(context, 'SrtTarget', this.url, ret, this.encrypted);
				}
				this.io = context;
			}

			while (this.queue.chunks.length > 0) {
				const chunk = this.queue.chunks.shift()!;
				this.queue.bytes -= chunk.byteLength;

				// Datagrams are filled to exactly PAYLOAD_SIZE so each one carries whole TS packets; the
				// remainder waits for the next chunk rather than going out short.
				let offset = 0;
				while (offset < chunk.byteLength) {
					const take = Math.min(PAYLOAD_SIZE - this.partialLength, chunk.byteLength - offset);
					this.partial.set(chunk.subarray(offset, offset + take), this.partialLength);
					this.partialLength += take;
					offset += take;

					if (this.partialLength === PAYLOAD_SIZE) {
						await this.writeDatagram(this.partial);
						this.partialLength = 0;
					}
				}
			}
		} catch (error) {
			this.failure ??= error instanceof Error ? error : new Error(String(error));
			// Nothing queued can reach a peer that has gone, and holding it only grows memory
			this.queue = { chunks: [], bytes: 0 };
		}
	}

	/** Drains what is queued, then closes. Awaited by the output's `finalize()`. */
	/**
	 * Sends whatever is short of a full datagram now, instead of holding it for the bytes that would fill
	 * it. Waits for the pump first, since the buffer is mid-fill while one is running.
	 */
	async flushPartial(): Promise<void> {
		if (this.closed) {
			return;
		}

		while (this.pumping !== null || this.queue.chunks.length > 0) {
			await this.kick().catch(() => {});
		}

		if (this.failure || !this.io || this.partialLength === 0) {
			return;
		}

		// Copied and the length cleared before the await: the buffer is shared with the next pump
		const datagram = this.partial.slice(0, this.partialLength);
		this.partialLength = 0;
		await this.writeDatagram(datagram);
		await this.io.flush().catch(() => {});
	}

	private async finish() {
		if (this.closed) {
			return;
		}
		this.closed = true;

		// A parked accept outlives a close and cannot be interrupted, so a listener with no receiver is
		// satisfied by dialling its own URL. Without this, closing waits out the whole listen_timeout.
		if (this.listening && this.io === undefined && this.opening) {
			await wakePendingAccept(this.url);
		}

		// Drain to empty rather than awaiting one pump: a chunk enqueued just as a pump ended starts a
		// new one, and closing under that would cut the tail off and interleave with its writes.
		while (this.pumping !== null || this.queue.chunks.length > 0) {
			await this.kick().catch(() => {});
		}

		if (!this.failure && this.io && this.partialLength > 0) {
			// A short final datagram is how a stream that is not a multiple of the payload size ends
			await this.writeDatagram(this.partial.subarray(0, this.partialLength)).catch((error: unknown) => {
				this.failure ??= error instanceof Error ? error : new Error(String(error));
			});
		}

		if (this.io) {
			await this.io.flush().catch(() => {});
			await this.io.closep().catch(() => {});
		}

		if (this.failure) {
			throw this.failure;
		}
	}
}

const srtUrl = (rawUrl: string, options: SrtTargetOptions): { url: string; listening: boolean } => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new TypeError(`SrtTarget: ${JSON.stringify(redactUrl(rawUrl))} is not a URL.`);
	}
	if (url.protocol !== 'srt:') {
		throw new TypeError(`SrtTarget: expected an srt:// URL, got ${JSON.stringify(url.protocol)}.`);
	}

	const connectTimeout = options.connectTimeout ?? 30;
	const micros = (seconds: number) => String(Math.max(1, Math.round(seconds * 1e6)));

	// Live transport and a 7-packet payload are what a Smooth/MPEG-TS receiver expects; both stay the
	// caller's if they stated them.
	if (!url.searchParams.has('transtype')) {
		url.searchParams.set('transtype', 'live');
	}
	if (!url.searchParams.has('payload_size')) {
		url.searchParams.set('payload_size', String(PAYLOAD_SIZE));
	}
	if (!url.searchParams.has('mode')) {
		url.searchParams.set('mode', 'caller');
	}
	// Live mode defaults SRTO_LINGER to 0, which discards whatever is still in the send buffer the moment
	// the socket closes - so a short stream, or the tail of any stream, never reaches the receiver.
	if (!url.searchParams.has('linger')) {
		url.searchParams.set('linger', String(DEFAULT_LINGER_SECONDS));
	}

	if (options.passphrase !== undefined) {
		url.searchParams.set('passphrase', options.passphrase);
		url.searchParams.set('pbkeylen', String((options.keyLength ?? 128) / 8));
	}
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- the one place it has to be read
	const latencyMs = options.latencyMs ?? options.latency;
	if (latencyMs !== undefined) {
		// libsrt states latency in microseconds, not the milliseconds this option takes
		url.searchParams.set('latency', String(Math.max(1, Math.round(latencyMs * 1000))));
	}

	// Set, not defaulted: a caller-supplied value here would reinstate the unbounded wait this guards
	// against. `listen_timeout` bounds an accept, `timeout` a connect - in microseconds, both.
	if (url.searchParams.get('mode') === 'listener') {
		url.searchParams.set('listen_timeout', micros(connectTimeout));
	}
	url.searchParams.set('timeout', micros(connectTimeout));

	return { url: url.toString(), listening: url.searchParams.get('mode') === 'listener' };
};

/**
 * An {@link https://mediabunny.dev/guide/writing-media-files#target | output target} that sends bytes over
 * SRT, so an `Output` can stream to an SRT receiver the way it writes to a file. A byte sink: it carries
 * whatever the format writes, which for a live feed means `MpegTsOutputFormat`.
 *
 * Calls out by default, or listens with `?mode=listener`. The socket is opened on the first write, so
 * constructing one never blocks, and every wait is bounded by `connectTimeout`.
 *
 * Writes are queued and sent by a pump, so a slow receiver is dropped for rather than blocking the
 * muxer - see {@link SrtTarget.droppedBytes}. A dead peer stops the bytes and errors on close;
 * reconnecting is the caller's, by building a new `Output`.
 *
 * @example
 * ```ts
 * const target = new SrtTarget('srt://receiver:9000', { passphrase: 'a-good-passphrase', latency: 200 });
 * const output = new Output({ format: new MpegTsOutputFormat(), target });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class SrtTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private readonly sink: SrtSink;

	constructor(url: string, options: SrtTargetOptions = {}) {
		installSecretRedactingLog();
		checkUrlAndOptions(url, options);
		positive(options.connectTimeout, 'connectTimeout');
		checkPassphrase(options);
		positive(options.latencyMs, 'latencyMs');
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- validated for the same reason
		positive(options.latency, 'latency');
		if (
			options.maxQueueBytes !== undefined
			&& (!Number.isInteger(options.maxQueueBytes) || options.maxQueueBytes < PAYLOAD_SIZE)
		) {
			throw new TypeError(
				`options.maxQueueBytes, when provided, must be an integer of at least ${PAYLOAD_SIZE}.`,
			);
		}

		const resolved = srtUrl(url, options);
		const sink = new SrtSink(
			resolved.url,
			options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
			resolved.listening,
			resolved.url.includes('passphrase='),
		);
		super(sink.writable);
		this.sink = sink;
	}

	/**
	 * Sends what is short of a full datagram now rather than waiting for the bytes that would fill it.
	 *
	 * A datagram is packed to 1316 bytes so each one carries whole MPEG-TS packets, which means a tail
	 * shorter than that waits for more data — and at a low bitrate that wait is latency. Calling this
	 * trades the packing for promptness. `TargetWriter.flush()` deliberately does not do it: it is the
	 * normal per-fragment flush, and sending a short datagram at each one would spend the payload
	 * efficiency the packing exists for.
	 */
	async flushPartialDatagram(): Promise<void> {
		await this.sink.flushPartial();
	}

	/** Bytes handed to the socket so far. */
	get sentBytes(): number {
		return this.sink.sentBytes;
	}

	/**
	 * Bytes waiting to go to the socket. Against {@link SrtTarget.maxQueueBytes} this is the headroom a
	 * caller has before anything is dropped, which is the only way to see it coming rather than after.
	 */
	get queuedBytes(): number {
		return this.sink.queuedBytes;
	}

	/** The bound {@link SrtTarget.queuedBytes} is held against, from the options or the default. */
	get maxQueueBytes(): number {
		return this.sink.maxQueueBytes;
	}

	/** Bytes dropped because the receiver was not keeping up. Stays 0 for a receiver that keeps up. */
	get droppedBytes(): number {
		return this.sink.droppedBytes;
	}

	/** Datagrams' worth of dropped bytes, which is the unit a receiver sees missing. */
	get droppedDatagrams(): number {
		return this.sink.droppedDatagrams;
	}
}
