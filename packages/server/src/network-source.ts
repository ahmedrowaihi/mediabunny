/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ReadableStreamSource } from 'mediabunny';
import { IOContext } from 'node-av';
import { AVIO_FLAG_READ } from 'node-av/constants';
import { wakePendingAccept } from './misc';

/** 7 MPEG-TS packets, the usual UDP/SRT payload. */
const READ_CHUNK_SIZE = 1316;

/** Microseconds. Only the accept bound's unit varies between protocols. */
const READ_BOUND_PER_SECOND = 1e6;

type Bounds = {
	/** The option that bounds waiting for a sender, with its unit and the query that selects listening. */
	accept?: { name: string; perSecond: number; listenQuery: [string, string] };
	/** The option that bounds a connected but silent sender. */
	read: string;
};

// FFmpeg ignores an option name it does not know in silence, leaving the infinite default — so a wrong
// name here reads as "unboundable". Units differ per protocol on purpose; see FORK.md.
const BOUNDS_BY_SCHEME: Record<string, Bounds> = {
	srt: { accept: { name: 'listen_timeout', perSecond: 1e6, listenQuery: ['mode', 'listener'] }, read: 'timeout' },
	tcp: { accept: { name: 'listen_timeout', perSecond: 1e3, listenQuery: ['listen', '1'] }, read: 'timeout' },
	udp: { read: 'timeout' },
	rtp: { read: 'timeout' },
	http: { read: 'rw_timeout' },
	https: { read: 'rw_timeout' },
};

/**
 * Options for {@link NetworkSource}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type NetworkSourceOptions = {
	/**
	 * Seconds to wait for a sender to appear, listening or connecting out. Defaults to 30. Never
	 * infinite: a wait cannot be cancelled once started.
	 */
	connectTimeout?: number;
	/**
	 * Seconds to wait for data from a connected sender before failing. Defaults to 30. When calling
	 * out, the protocol bounds the connect with this same option, so the larger of the two applies.
	 */
	readTimeout?: number;
	/** Maximum bytes to keep for re-reads. Passed through to Mediabunny's `ReadableStreamSource`. */
	maxCacheSize?: number;
};

type BoundedUrl = { url: string; listening: boolean };

const boundedUrl = (rawUrl: string, connectTimeout: number, readTimeout: number): BoundedUrl => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new TypeError(`NetworkSource: ${JSON.stringify(rawUrl)} is not a URL.`);
	}

	const scheme = url.protocol.slice(0, -1);
	if (scheme === 'rtmp' || scheme === 'rtmps') {
		throw new TypeError(
			`NetworkSource: ${scheme} ignores URL query options, so it cannot be bounded or put into listen mode here.`,
		);
	}

	const bounds = BOUNDS_BY_SCHEME[scheme];
	if (!bounds) {
		throw new TypeError(
			`NetworkSource: unsupported scheme ${JSON.stringify(scheme)}.`
			+ ` Supported: ${Object.keys(BOUNDS_BY_SCHEME).join(', ')}.`,
		);
	}

	const ticks = (seconds: number, perSecond: number) => String(Math.max(1, Math.round(seconds * perSecond)));
	const [listenKey, listenValue] = bounds.accept?.listenQuery ?? [];
	const listening = listenKey !== undefined && url.searchParams.get(listenKey) === listenValue;

	// Set, not defaulted: a caller-supplied value for one of these would reinstate the hang this class
	// exists to prevent. Every other query parameter stays the caller's.
	if (bounds.accept && listening) {
		url.searchParams.set(bounds.accept.name, ticks(connectTimeout, bounds.accept.perSecond));
	}

	// One option governs both the connect and later reads, so a caller's connect would otherwise be
	// bounded by readTimeout alone. Whichever is longer has to fit.
	const readSeconds = listening ? readTimeout : Math.max(connectTimeout, readTimeout);
	url.searchParams.set(bounds.read, ticks(readSeconds, READ_BOUND_PER_SECOND));

	return { url: url.toString(), listening };
};

/** Holds the libav IO state for one stream, so a reader's in-flight work is visible to `cancel`. */
class NetworkStreamReader {
	private io: IOContext | undefined;
	private pendingRead: Promise<unknown> | null = null;
	private pendingOpen: Promise<unknown> | null = null;
	private opened = false;
	private canceled = false;
	private ioClosed = false;

	constructor(private url: string, private listening: boolean) {}

	private async closeIo() {
		if (!this.io || this.ioClosed) {
			return;
		}

		this.ioClosed = true;
		await this.io.closep();
	}

	private async open() {
		// Opened on the first read rather than up front, so constructing a NetworkSource binds no port.
		const context = new IOContext();
		const open = context.open2(this.url, AVIO_FLAG_READ);
		this.pendingOpen = open;

		let ret: number;
		try {
			ret = await open;
		} finally {
			this.pendingOpen = null;
			this.opened = true;
		}

		if (ret < 0) {
			throw new Error(`NetworkSource: could not open ${this.url} (AVERROR ${ret}).`);
		}

		this.io = context;
	}

	async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
		if (this.canceled) {
			return;
		}

		if (!this.io) {
			await this.open();
		}

		const read = this.io!.read(READ_CHUNK_SIZE);
		this.pendingRead = read;

		let result: Awaited<typeof read>;
		try {
			result = await read;
		} finally {
			this.pendingRead = null;
		}

		// Cancel tore the stream down while this read was in flight and owns the context now
		if (this.canceled) {
			return;
		}

		// A number is an AVERROR, EOF included: the sender went away, which ends the stream
		if (typeof result === 'number' || result.length === 0) {
			await this.closeIo();
			controller.close();
			return;
		}

		controller.enqueue(result);
	}

	async cancel() {
		this.canceled = true;

		// A pending accept outlives a close
		if (this.listening && !this.opened && this.pendingOpen) {
			await wakePendingAccept(this.url);
		}

		await this.pendingOpen?.catch(() => {});
		// Freeing the context under a blocked read aborts the process; nothing can interrupt one
		await this.pendingRead?.catch(() => {});
		await this.closeIo();
	}
}

const openStream = (url: string, listening: boolean): ReadableStream<Uint8Array> => {
	const reader = new NetworkStreamReader(url, listening);

	return new ReadableStream<Uint8Array>({
		pull: controller => reader.pull(controller),
		cancel: () => reader.cancel(),
	// Room to run ahead of the consumer: on UDP or SRT a stalled reader means a dropped packet rather
	// than backpressure.
	}, { highWaterMark: 32 });
};

/**
 * A {@link https://mediabunny.dev/guide/reading-media-files#source | Source} that reads a live network
 * stream — SRT, or MPEG-TS over UDP, RTP, TCP or HTTP — so an `Input` can read it like any other source.
 *
 * Supplies bytes only; Mediabunny does the demuxing. The socket is opened on the first read, so
 * constructing one never blocks. Listens (`srt://0.0.0.0:9000?mode=listener`) or calls out
 * (`srt://host:9000`). RTMP is not supported; see FORK.md.
 *
 * @example
 * ```ts
 * const input = new Input({
 * 	source: new NetworkSource('srt://0.0.0.0:9000?mode=listener'),
 * 	formats: ALL_FORMATS,
 * });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class NetworkSource extends ReadableStreamSource {
	constructor(url: string, options: NetworkSourceOptions = {}) {
		if (typeof url !== 'string') {
			throw new TypeError('url must be a string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.connectTimeout !== undefined
			&& (!Number.isFinite(options.connectTimeout) || options.connectTimeout <= 0)
		) {
			throw new TypeError('options.connectTimeout, when provided, must be a positive number.');
		}
		if (
			options.readTimeout !== undefined
			&& (!Number.isFinite(options.readTimeout) || options.readTimeout <= 0)
		) {
			throw new TypeError('options.readTimeout, when provided, must be a positive number.');
		}

		const resolved = boundedUrl(url, options.connectTimeout ?? 30, options.readTimeout ?? 30);

		// 0: bytes are pushed, so there is nothing to wait before retrying.
		super(
			openStream(resolved.url, resolved.listening),
			{ liveRefreshInterval: 0, maxCacheSize: options.maxCacheSize },
		);
	}
}
