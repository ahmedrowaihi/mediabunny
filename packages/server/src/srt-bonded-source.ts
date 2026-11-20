/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ReadableStreamSource } from 'mediabunny';
import {
	getLibsrt,
	SRT_ERROR,
	SrtOption,
	SRTT_LIVE,
	writeSockaddrIn,
	type Libsrt,
} from './libsrt';

const SRT_EASYNCRCV = 6002;
const SRT_ECONNLOST = 2001;
const SRT_ENOCONN = 2002;
const SOCKADDR_IN_SIZE = 16;
const POLL_MS = 4;

/**
 * Options for {@link SrtBondedSource}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type SrtBondedSourceOptions = {
	/**
	 * Receiver buffer depth in milliseconds, which bounds how long a link has to deliver a packet
	 * before the group gives up on it. Defaults to 120.
	 */
	latencyMs?: number;
	/** Bytes per SRT payload. Must match the sender's. Defaults to 1316, seven MPEG-TS packets. */
	payloadSize?: number;
	/** Shared secret, when the sender encrypts. */
	passphrase?: string;
	/** Stream ID a listener matches callers against. */
	streamId?: string;
	/** Seconds to wait for a link to deliver before the stream ends. Defaults to 10. */
	readTimeout?: number;
	/**
	 * Decides whether a caller may connect, which is how a host enforces an allowlist. Called once per
	 * accepted connection, before a single byte of it is read; returning `false` closes that socket and
	 * the listener goes back to waiting.
	 *
	 * `address` is null only when libsrt reported an address this binding could not read, which is
	 * neither of the two families it knows — refuse on null rather than letting an unidentified caller
	 * through an allowlist.
	 *
	 * The refusal happens just after SRT's handshake rather than during it, so the caller sees a
	 * connection that closes immediately rather than one that was never offered. It delivers nothing
	 * either way.
	 */
	accept?: (peer: SrtCallerInfo) => boolean;
	/** Maximum bytes to keep for re-reads. Passed through to Mediabunny's `ReadableStreamSource`. */
	maxCacheSize?: number;
};

/**
 * What is known about a caller when {@link SrtBondedSourceOptions.accept} is asked about it.
 *
 * @group \@mediabunny/server
 * @public
 */
export type SrtCallerInfo = {
	/** The caller's address: dotted-quad for IPv4, RFC 5952 form for IPv6. Null if it could not be read. */
	address: string | null;
	/** The caller's source port, or null when its address is not known. */
	port: number | null;
	/** Which family {@link SrtCallerInfo.address} is in, so a CIDR check knows how to parse it. */
	family: 'ipv4' | 'ipv6' | null;
	/** `SRTO_STREAMID` as the caller set it, or null when it set none. */
	streamId: string | null;
};

type Resolved = {
	host: string;
	port: number;
	latencyMs: number;
	payloadSize: number;
	passphrase: string | undefined;
	streamId: string | undefined;
	readTimeout: number;
	accept: ((peer: SrtCallerInfo) => boolean) | undefined;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class SrtBondedReader {
	private libsrt: Libsrt;
	private listener = SRT_ERROR;
	private connection = SRT_ERROR;
	private cancelled = false;
	private buffer: Uint8Array;
	refused = 0;

	constructor(private options: Resolved) {
		this.libsrt = getLibsrt();
		this.buffer = new Uint8Array(options.payloadSize);
	}

	start() {
		this.listener = this.libsrt.createSocket();
		if (this.listener === SRT_ERROR) {
			throw new Error(`libsrt could not create a socket: ${this.libsrt.lastError()}`);
		}

		// Every call stays non-blocking: a blocking accept or receive would hold the only thread koffi
		// calls libsrt on, and nothing else in the process would run until a packet arrived.
		this.setInt(SrtOption.RCVSYN, 0, 'non-blocking mode');
		this.setInt(SrtOption.TRANSTYPE, SRTT_LIVE, 'transtype');
		this.setInt(SrtOption.PAYLOADSIZE, this.options.payloadSize, 'payloadSize');
		this.setInt(SrtOption.RCVLATENCY, this.options.latencyMs, 'latency');
		this.setInt(SrtOption.PEERLATENCY, this.options.latencyMs, 'latency');
		// Without this a bonded sender's members are refused one by one, with the listener reporting
		// only that the peer did not answer with a group ID
		this.setInt(SrtOption.GROUPCONNECT, 1, 'groupconnect');
		if (this.options.passphrase !== undefined) {
			this.setString(SrtOption.PASSPHRASE, this.options.passphrase, 'passphrase');
		}
		if (this.options.streamId !== undefined) {
			this.setString(SrtOption.STREAMID, this.options.streamId, 'streamId');
		}

		const address = new Uint8Array(SOCKADDR_IN_SIZE);
		writeSockaddrIn(address, 0, this.options.host, this.options.port);
		if (this.libsrt.bind(this.listener, address, SOCKADDR_IN_SIZE) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt could not bind ${this.options.host}:${this.options.port}: ${message}`);
		}
		if (this.libsrt.listen(this.listener, 5) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt could not listen: ${message}`);
		}
	}

	async read(): Promise<Uint8Array | null> {
		const deadline = Date.now() + this.options.readTimeout * 1000;

		while (!this.cancelled && Date.now() < deadline) {
			if (this.connection === SRT_ERROR) {
				const { socket: accepted, peer } = this.libsrt.accept(this.listener);
				if (accepted === SRT_ERROR) {
					if (this.libsrt.lastErrorCode() !== SRT_EASYNCRCV) {
						throw new Error(`libsrt could not accept: ${this.libsrt.lastError()}`);
					}
					await sleep(POLL_MS);
					continue;
				}

				if (!this.allowed(accepted, peer)) {
					this.libsrt.close(accepted);
					this.refused++;
					await sleep(POLL_MS);
					continue;
				}

				this.connection = accepted;
				this.libsrt.setFlagInt(this.connection, SrtOption.RCVSYN, 0);
			}

			const received = this.libsrt.receive(this.connection, this.buffer, this.buffer.length);
			if (received > 0) {
				return this.buffer.slice(0, received);
			}

			if (received === SRT_ERROR) {
				const code = this.libsrt.lastErrorCode();
				if (code === SRT_ECONNLOST || code === SRT_ENOCONN) {
					return null;
				}
				if (code !== SRT_EASYNCRCV) {
					throw new Error(`libsrt could not receive: ${this.libsrt.lastError()}`);
				}
			}

			await sleep(POLL_MS);
		}

		return null;
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

	cancel() {
		this.cancelled = true;
		this.destroy();
	}

	private setInt(option: number, value: number, name: string) {
		if (this.libsrt.setFlagInt(this.listener, option, value) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt refused ${name}: ${message}`);
		}
	}

	private setString(option: number, value: string, name: string) {
		if (this.libsrt.setFlagString(this.listener, option, value) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt refused ${name}: ${message}`);
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

const positive = (value: number | undefined, fallback: number, name: string): number => {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`options.${name}, when provided, must be a positive number.`);
	}

	return value;
};

const parseListenUrl = (url: string): { host: string; port: number } => {
	if (typeof url !== 'string') {
		throw new TypeError('url must be a string.');
	}

	const match = /^srt:\/\/([^:/?]*)(?::(\d+))?/.exec(url);
	if (!match || match[2] === undefined) {
		throw new TypeError(`'${url}' is not an srt:// URL with a port.`);
	}

	const port = Number(match[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new TypeError(`'${url}' states no port in 1 to 65535.`);
	}

	return { host: match[1] === '' ? '0.0.0.0' : match[1]!, port };
};

/**
 * A source that receives an SRT stream over a bonded link group, using libsrt.
 *
 * This is the receiving half of {@link SrtBondedTarget}. It listens with `SRTO_GROUPCONNECT` set, which
 * is what lets a sender's member links join one group rather than be refused one by one; libsrt then
 * merges them, so a packet lost on one path is taken from another and this source yields the single
 * recovered flow.
 *
 * One group, one listener: every link of a bonded sender connects to this same address, over whatever
 * different network paths carry them. Pointing a sender's links at separate listeners is not bonding -
 * each listener would see its own unrelated group.
 *
 * ```ts
 * const source = new SrtBondedSource('srt://0.0.0.0:9000');
 * ```
 *
 * Requires a libsrt built with bonding (`ENABLE_BONDING`), or `MEDIABUNNY_LIBSRT` pointing at one.
 * Homebrew's build does not have it; Debian's and Ubuntu's `libsrt1.5-openssl` does.
 *
 * @group \@mediabunny/server
 * @public
 */
export class SrtBondedSource extends ReadableStreamSource {
	/** @internal */
	private reader: SrtBondedReader;

	constructor(url: string, options: SrtBondedSourceOptions = {}) {
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.passphrase !== undefined && typeof options.passphrase !== 'string') {
			throw new TypeError('options.passphrase, when provided, must be a string.');
		}
		if (options.streamId !== undefined && typeof options.streamId !== 'string') {
			throw new TypeError('options.streamId, when provided, must be a string.');
		}
		if (options.accept !== undefined && typeof options.accept !== 'function') {
			throw new TypeError('options.accept, when provided, must be a function.');
		}

		const { host, port } = parseListenUrl(url);
		const resolved: Resolved = {
			host,
			port,
			latencyMs: positive(options.latencyMs, 120, 'latencyMs'),
			payloadSize: positive(options.payloadSize, 1316, 'payloadSize'),
			passphrase: options.passphrase,
			streamId: options.streamId,
			readTimeout: positive(options.readTimeout, 10, 'readTimeout'),
			accept: options.accept,
		};

		const reader = new SrtBondedReader(resolved);
		super(
			new ReadableStream<Uint8Array>({
				start: () => reader.start(),
				pull: async (controller) => {
					const payload = await reader.read();
					if (payload === null) {
						reader.cancel();
						controller.close();
						return;
					}
					controller.enqueue(payload);
				},
				cancel: () => reader.cancel(),
			}),
			{ maxCacheSize: options.maxCacheSize },
		);
		this.reader = reader;
	}

	/** Callers {@link SrtBondedSourceOptions.accept} turned away, which an allowlist is judged by. */
	get refusedCallers(): number {
		return this.reader.refused;
	}

	/** Stops listening and releases the socket. */
	close() {
		this.reader.cancel();
	}
}
