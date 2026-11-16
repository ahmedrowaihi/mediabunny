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
	getLibsrt,
	SRT_ERROR,
	SrtOption,
	SRTT_LIVE,
	writeSockaddrIn,
	type Libsrt,
} from './libsrt';
import {
	DEFAULT_MAX_QUEUE_BYTES, checkPassphrase, checkUrlAndOptions, installSecretRedactingLog, positive,
	redactUrl, throwFailedOpen, wakePendingAccept,
} from './misc';
import { type SrtCallerInfo } from './srt-bonded-source';

/** 7 MPEG-TS packets, which is what SRT carries in a live-mode datagram. */
const PAYLOAD_SIZE = 1316;

/** Seconds `close` may spend delivering what is still buffered. SRT's live-mode default is 0. */
const DEFAULT_LINGER_SECONDS = 5;

const SRT_EASYNCSND = 6001;
const SRT_EASYNCRCV = 6002;
const SOCKADDR_IN_SIZE = 16;
const POLL_MS = 4;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Options for {@link SrtTarget}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type SrtTargetOptions = {
	/**
	 * Whether to connect out to a receiver (`'caller'`, the default) or to bind the URL's port and wait
	 * for one (`'listener'`). The URL's own `?mode=` wins if it states one, since that is how the other
	 * SRT options are passed through too.
	 *
	 * A listener's wait is bounded by {@link SrtTargetOptions.connectTimeout} like a caller's, but
	 * through libsrt's `listen_timeout` rather than `timeout` — they are different options and setting
	 * the wrong one leaves the default standing silently.
	 */
	mode?: 'caller' | 'listener';
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
	/**
	 * Decides whether a receiver that called in may have the stream, which is how a sending listener
	 * enforces an allowlist. Called once per accepted connection, before a single byte is sent;
	 * returning `false` closes that socket and the listener goes back to waiting.
	 *
	 * Implies `mode: 'listener'` - a caller has nobody to vet. Passing both this and `mode: 'caller'`
	 * is an error rather than a silently ignored option.
	 *
	 * Providing it switches the socket from FFmpeg's `srt://` protocol to the libsrt build shipped in
	 * this package, because FFmpeg offers no hook between SRT's handshake and the first byte of data.
	 * The option mapping is the same either way; what changes is that the address must be an IPv4
	 * literal, since the bind names it directly rather than resolving it.
	 */
	accept?: (peer: SrtCallerInfo) => boolean;
};

type Queued = { chunks: Uint8Array[]; bytes: number };

/**
 * The socket under the sink. One implementation goes through FFmpeg's `srt://` protocol, the other
 * through the libsrt build shipped here; the queue, the drop accounting and the datagram packing above
 * are the same either way, and belong to the sink rather than to either socket.
 */
type SrtTransport = {
	/** Opens the socket, waiting for a peer if that is what this transport does. Called once. */
	open: () => Promise<void>;
	write: (bytes: Uint8Array) => Promise<void>;
	flush: () => Promise<void>;
	/** Unblocks an `open` that is still waiting for a peer, so a close does not wait out the timeout. */
	wake: () => Promise<void>;
	/** Releases the socket. Called once, after the queue has drained, whether the open finished or not. */
	close: () => Promise<void>;
	/** Callers an allowlist turned away. Always 0 for a transport that cannot vet one. */
	readonly refusedCallers: number;
};

/** Sends over FFmpeg's `srt://` protocol, which is every case that does not vet its peer. */
class IoContextTransport implements SrtTransport {
	private io: IOContext | undefined;
	readonly refusedCallers = 0;

	constructor(
		private readonly url: string,
		private readonly listening: boolean,
		private readonly encrypted: boolean,
	) {}

	async open(): Promise<void> {
		const context = new IOContext();
		const ret = await context.open2(this.url, AVIO_FLAG_WRITE);
		if (ret < 0) {
			await throwFailedOpen(context, 'SrtTarget', this.url, ret, this.encrypted);
		}
		this.io = context;
	}

	async write(bytes: Uint8Array): Promise<void> {
		const io = this.io!;
		await io.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

		if (io.error < 0) {
			throw new Error(`SrtTarget: the peer stopped accepting data (AVERROR ${io.error}).`);
		}
	}

	async flush(): Promise<void> {
		await this.io?.flush().catch(() => {});
	}

	async wake(): Promise<void> {
		if (this.listening && this.io === undefined) {
			await wakePendingAccept(this.url);
		}
	}

	async close(): Promise<void> {
		if (this.io) {
			await this.io.flush().catch(() => {});
			await this.io.closep().catch(() => {});
			this.io = undefined;
		}
	}
}

/**
 * Listens with the bundled libsrt so a receiver can be vetted between SRT's handshake and the first
 * byte of data. The refusal is a close just after the handshake: the caller sees a connection that ends
 * immediately rather than one that was never offered, and gets no media either way.
 */
class LibsrtListenerTransport implements SrtTransport {
	private libsrt: Libsrt;
	private listener = SRT_ERROR;
	private connection = SRT_ERROR;
	private cancelled = false;
	refusedCallers = 0;

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly options: SrtTargetOptions,
	) {
		this.libsrt = getLibsrt();
	}

	async open(): Promise<void> {
		this.listener = this.libsrt.createSocket();
		if (this.listener === SRT_ERROR) {
			throw new Error(`SrtTarget: libsrt could not create a socket: ${this.libsrt.lastError()}`);
		}

		// Every call stays non-blocking: a blocking accept or send would hold the one thread koffi calls
		// libsrt on, and nothing else in the process would run until the peer moved
		this.setInt(SrtOption.RCVSYN, 0, 'non-blocking mode');
		this.setInt(SrtOption.SNDSYN, 0, 'non-blocking mode');
		this.setInt(SrtOption.TRANSTYPE, SRTT_LIVE, 'transtype');
		this.setInt(SrtOption.PAYLOADSIZE, PAYLOAD_SIZE, 'payload size');
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated alias is still read
		const latencyMs = this.options.latencyMs ?? this.options.latency;
		if (latencyMs !== undefined) {
			this.setInt(SrtOption.RCVLATENCY, Math.round(latencyMs), 'latency');
			this.setInt(SrtOption.PEERLATENCY, Math.round(latencyMs), 'latency');
		}
		if (this.options.passphrase !== undefined) {
			this.setInt(SrtOption.PBKEYLEN, (this.options.keyLength ?? 128) / 8, 'keyLength');
			this.setString(SrtOption.PASSPHRASE, this.options.passphrase, 'passphrase');
		}

		const address = new Uint8Array(SOCKADDR_IN_SIZE);
		writeSockaddrIn(address, 0, this.host, this.port);
		if (this.libsrt.bind(this.listener, address, SOCKADDR_IN_SIZE) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`SrtTarget: libsrt could not bind ${this.host}:${this.port}: ${message}`);
		}
		if (this.libsrt.listen(this.listener, 5) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`SrtTarget: libsrt could not listen: ${message}`);
		}

		const deadline = Date.now() + (this.options.connectTimeout ?? 30) * 1000;
		while (!this.cancelled) {
			if (Date.now() >= deadline) {
				this.destroy();
				throw new Error(
					`SrtTarget: no receiver connected to ${this.host}:${this.port} within`
					+ ` ${this.options.connectTimeout ?? 30} seconds.`,
				);
			}

			const { socket: accepted, peer } = this.libsrt.accept(this.listener);
			if (accepted === SRT_ERROR) {
				if (this.libsrt.lastErrorCode() !== SRT_EASYNCRCV) {
					const message = this.libsrt.lastError();
					this.destroy();
					throw new Error(`SrtTarget: libsrt could not accept: ${message}`);
				}
				await sleep(POLL_MS);
				continue;
			}

			if (!this.allowed(accepted, peer)) {
				this.libsrt.close(accepted);
				this.refusedCallers++;
				await sleep(POLL_MS);
				continue;
			}

			this.libsrt.setFlagInt(accepted, SrtOption.SNDSYN, 0);
			this.connection = accepted;
			return;
		}

		this.destroy();
		throw new Error('SrtTarget: closed before a receiver connected.');
	}

	/** Asks the allowlist about a caller. The stream id is read off the accepted socket, not the listener. */
	private allowed(socket: number, peer: { address: string; port: number; family: 'ipv4' | 'ipv6' } | null): boolean {
		const decide = this.options.accept;
		if (!decide) {
			return true;
		}

		const streamId = this.libsrt.getFlagString(socket, SrtOption.STREAMID);
		return decide({
			address: peer?.address ?? null,
			port: peer?.port ?? null,
			family: peer?.family ?? null,
			streamId: streamId === null || streamId === '' ? null : streamId,
		});
	}

	/**
	 * Retries while the send buffer is full rather than dropping there: the sink's own queue bound is
	 * what decides when bytes are given up on, and a second, hidden one here would make that number wrong.
	 */
	async write(bytes: Uint8Array): Promise<void> {
		while (!this.cancelled) {
			const sent = this.libsrt.send(this.connection, bytes, bytes.byteLength);
			if (sent >= 0) {
				return;
			}
			if (this.libsrt.lastErrorCode() !== SRT_EASYNCSND) {
				throw new Error(`SrtTarget: the peer stopped accepting data: ${this.libsrt.lastError()}`);
			}
			await sleep(POLL_MS);
		}
	}

	/** SRT sends each payload as it is given; there is nothing held back to flush. */
	async flush(): Promise<void> {}

	async wake(): Promise<void> {
		this.cancelled = true;
	}

	async close(): Promise<void> {
		this.cancelled = true;
		this.destroy();
	}

	private setInt(option: number, value: number, name: string) {
		if (this.libsrt.setFlagInt(this.listener, option, value) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`SrtTarget: libsrt refused ${name}: ${message}`);
		}
	}

	private setString(option: number, value: string, name: string) {
		if (this.libsrt.setFlagString(this.listener, option, value) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`SrtTarget: libsrt refused ${name}: ${message}`);
		}
	}

	private destroy() {
		if (this.connection !== SRT_ERROR) {
			this.libsrt.close(this.connection);
			this.connection = SRT_ERROR;
		}
		if (this.listener !== SRT_ERROR) {
			this.libsrt.close(this.listener);
			this.listener = SRT_ERROR;
		}
	}
}

/**
 * Owns the outbound queue and the pump that drains it into the transport. Separate from the target so
 * the writable can be built before `super()` runs.
 */
class SrtSink {
	readonly writable: WritableStream<Uint8Array>;

	private opened = false;
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

	get refusedCallers(): number {
		return this.transport.refusedCallers;
	}

	constructor(
		private readonly transport: SrtTransport,
		readonly maxQueueBytes: number,
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
		await this.transport.write(bytes);
		this.sentBytes += bytes.byteLength;
	}

	private async pump() {
		try {
			if (!this.opened) {
				this.opening = true;
				try {
					await this.transport.open();
				} finally {
					this.opening = false;
				}
				this.opened = true;
			}

			while (this.queue.chunks.length > 0) {
				const chunk = this.queue.chunks.shift()!;
				this.queue.bytes -= chunk.byteLength;

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

		if (this.failure || !this.opened || this.partialLength === 0) {
			return;
		}

		const datagram = this.partial.slice(0, this.partialLength);
		this.partialLength = 0;
		await this.writeDatagram(datagram);
		await this.transport.flush();
	}

	private async finish() {
		if (this.closed) {
			return;
		}
		this.closed = true;

		if (this.opening) {
			await this.transport.wake();
		}

		while (this.pumping !== null || this.queue.chunks.length > 0) {
			await this.kick().catch(() => {});
		}

		if (!this.failure && this.opened && this.partialLength > 0) {
			await this.writeDatagram(this.partial.subarray(0, this.partialLength)).catch((error: unknown) => {
				this.failure ??= error instanceof Error ? error : new Error(String(error));
			});
		}

		await this.transport.close();

		if (this.failure) {
			throw this.failure;
		}
	}
}

/**
 * Resolves the `srt://` URL libsrt is actually opened with. Exported so the option-to-parameter mapping
 * can be asserted without opening a socket: the parameter names are libsrt's, and a misnamed one leaves
 * its default standing with no error anywhere.
 *
 * @internal
 */
export const srtUrl = (
	rawUrl: string,
	options: SrtTargetOptions,
): { url: string; listening: boolean; host: string; port: number } => {
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

	if (!url.searchParams.has('transtype')) {
		url.searchParams.set('transtype', 'live');
	}
	if (!url.searchParams.has('payload_size')) {
		url.searchParams.set('payload_size', String(PAYLOAD_SIZE));
	}
	if (!url.searchParams.has('mode')) {
		url.searchParams.set('mode', options.mode ?? 'caller');
	}
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
		url.searchParams.set('latency', String(Math.max(1, Math.round(latencyMs * 1000))));
	}

	if (url.searchParams.get('mode') === 'listener') {
		url.searchParams.set('listen_timeout', micros(connectTimeout));
	}
	url.searchParams.set('timeout', micros(connectTimeout));

	return {
		url: url.toString(),
		listening: url.searchParams.get('mode') === 'listener',
		host: url.hostname,
		port: Number(url.port),
	};
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
		if (options.mode !== undefined && options.mode !== 'caller' && options.mode !== 'listener') {
			throw new TypeError('options.mode, when provided, must be \'caller\' or \'listener\'.');
		}
		if (options.accept !== undefined && typeof options.accept !== 'function') {
			throw new TypeError('options.accept, when provided, must be a function.');
		}
		if (options.accept !== undefined && options.mode === 'caller') {
			throw new TypeError(
				'options.accept vets a receiver that called in, so it needs \'listener\' mode; a caller has'
				+ ' nobody to vet.',
			);
		}
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

		const resolved = srtUrl(url, options.accept ? { ...options, mode: 'listener' } : options);
		if (options.accept !== undefined && !resolved.listening) {
			throw new TypeError(
				'options.accept vets a receiver that called in, so the URL may not state ?mode=caller.',
			);
		}

		const transport: SrtTransport = options.accept
			? new LibsrtListenerTransport(resolved.host, resolved.port, { ...options, mode: 'listener' })
			: new IoContextTransport(
				resolved.url,
				resolved.listening,
				resolved.url.includes('passphrase='),
			);
		const sink = new SrtSink(transport, options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES);
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

	/**
	 * Receivers {@link SrtTargetOptions.accept} turned away, which an allowlist is judged by. Stays 0
	 * without one.
	 */
	get refusedCallers(): number {
		return this.sink.refusedCallers;
	}
}
