/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AppendOnlyStreamTarget } from 'mediabunny';
import { lookup } from 'node:dns/promises';
import {
	getLibsrt,
	GROUP_CONFIG_SIZE,
	GROUP_DATA_SIZE,
	readGroupConfigResult,
	readGroupData,
	SRT_ERROR,
	SrtGroupType,
	SrtOption,
	writeGroupConfig,
	type Libsrt,
	type SrtMemberState,
} from './libsrt';

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** One MPEG-TS packet short of the 1316 SRT live default, which is 7 of them. */
const PAYLOAD_SIZE = 1316;
const DEFAULT_LATENCY_MS = 120;

/** @internal */
export type ResolvedLink = { host: string; port: number; weight: number; url: string };

/**
 * What one link of a bonded group is doing, as libsrt reports it.
 *
 * @group \@mediabunny/server
 * @public
 */
export type SrtLinkState = {
	/** The `srt://` URL this link was opened to, as it was given. */
	url: string;
	/** libsrt's own socket id for this link. */
	id: number;
	/** Whether the link is carrying data, standing by, still connecting, or has failed. */
	state: SrtMemberState;
	/** libsrt's result for this link's last operation; 0 while it is healthy. */
	result: number;
};

const positive = (value: number | undefined, name: string, fallback?: number): number => {
	if (value === undefined) {
		if (fallback === undefined) {
			throw new TypeError(`options.${name} is required.`);
		}
		return fallback;
	}
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`options.${name}, when provided, must be a positive number.`);
	}
	return value;
};

/** `srt://host:port`, which is the only shape libsrt's endpoints are stated in here. */
const parseSrtUrl = (url: string): { host: string; port: number } => {
	if (typeof url !== 'string') {
		throw new TypeError('Each url must be a string.');
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new TypeError(`'${url}' is not a URL.`);
	}
	if (parsed.protocol !== 'srt:') {
		throw new TypeError(`Expected an srt:// URL, got ${JSON.stringify(parsed.protocol)}.`);
	}
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new TypeError(`'${url}' states no usable port; SRT addresses each link by host and port.`);
	}

	return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port };
};

const assertLibsrt: (libsrt: Libsrt | null) => asserts libsrt is Libsrt = (libsrt) => {
	if (!libsrt) {
		throw new Error('The SRT group is not open.');
	}
};

/**
 * Sends one byte stream down several SRT links at once, which is what libsrt calls a socket group.
 *
 * FFmpeg's `srt` protocol cannot reach this: none of its options touch socket groups, so a bonded link
 * is unreachable through an `srt://` URL and this talks to libsrt itself.
 */
class SrtBondedSink {
	private libsrt: Libsrt | null = null;
	private group = SRT_ERROR;
	private links: ResolvedLink[] = [];

	/** Bytes not yet making up a whole payload. A write arrives at the muxer's convenience, not SRT's. */
	private pending = new Uint8Array(PAYLOAD_SIZE);
	private pendingLength = 0;

	sentPackets = 0;
	sentBytes = 0;

	constructor(
		private urls: string[],
		private options: {
			groupType: SrtGroupType;
			passphrase: string | undefined;
			latencyMs: number;
			payloadSize: number;
			streamId: string | undefined;
			weights: number[] | undefined;
		},
	) {}

	async start() {
		const libsrt = getLibsrt();
		this.libsrt = libsrt;

		// Resolved here rather than in the constructor: libsrt states each endpoint as a sockaddr, so a
		// host name has to become an address before any of them can be prepared. A literal is already one,
		// and asking a resolver about it only adds a way for this to fail.
		this.links = await Promise.all(this.urls.map(async (url, i) => {
			const { host, port } = parseSrtUrl(url);
			const address = IPV4_LITERAL.test(host) ? host : (await lookup(host, { family: 4 })).address;
			return { host: address, port, weight: this.options.weights?.[i] ?? 0, url };
		}));

		this.group = libsrt.createGroup(this.options.groupType);
		if (this.group === SRT_ERROR) {
			throw new Error(`libsrt could not create a socket group: ${libsrt.lastError()}`);
		}

		// No transtype: libsrt's group setter refuses the option outright, whatever its value.
		this.setInt(SrtOption.PAYLOADSIZE, this.options.payloadSize, 'payloadSize');
		this.setInt(SrtOption.PEERLATENCY, this.options.latencyMs, 'latency');
		this.setInt(SrtOption.RCVLATENCY, this.options.latencyMs, 'latency');
		if (this.options.passphrase !== undefined) {
			this.setString(SrtOption.PASSPHRASE, this.options.passphrase, 'passphrase');
		}
		if (this.options.streamId !== undefined) {
			this.setString(SrtOption.STREAMID, this.options.streamId, 'streamId');
		}

		const configs = new Uint8Array(GROUP_CONFIG_SIZE * this.links.length);
		for (let i = 0; i < this.links.length; i++) {
			const link = this.links[i]!;
			writeGroupConfig(configs, i, link.host, link.port, link.weight);
		}

		const connected = libsrt.connectGroup(this.group, configs, this.links.length);
		if (connected === SRT_ERROR) {
			const refused = this.links
				.map((link, i) => ({ link, ...readGroupConfigResult(configs, i) }))
				.filter(entry => entry.id === SRT_ERROR || entry.errorcode !== 0)
				.map(entry => `${entry.link.url} (error ${entry.errorcode})`);
			const detail = refused.length > 0 ? ` Refused: ${refused.join(', ')}.` : '';
			this.destroy();
			throw new Error(`libsrt could not connect the group: ${libsrt.lastError()}.${detail}`);
		}
	}

	private setInt(option: SrtOption, value: number, name: string) {
		assertLibsrt(this.libsrt);
		if (this.libsrt.setFlagInt(this.group, option, value) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt refused ${name}: ${message}`);
		}
	}

	private setString(option: SrtOption, value: string, name: string) {
		assertLibsrt(this.libsrt);
		if (this.libsrt.setFlagString(this.group, option, value) === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt refused ${name}: ${message}`);
		}
	}

	write(chunk: Uint8Array) {
		let offset = 0;
		while (offset < chunk.length) {
			const take = Math.min(PAYLOAD_SIZE - this.pendingLength, chunk.length - offset);
			this.pending.set(chunk.subarray(offset, offset + take), this.pendingLength);
			this.pendingLength += take;
			offset += take;

			if (this.pendingLength === PAYLOAD_SIZE) {
				this.flush();
			}
		}
	}

	private flush() {
		if (this.pendingLength === 0) {
			return;
		}
		assertLibsrt(this.libsrt);

		const sent = this.libsrt.send(this.group, this.pending, this.pendingLength);
		if (sent === SRT_ERROR) {
			const message = this.libsrt.lastError();
			this.destroy();
			throw new Error(`libsrt could not send: ${message}`);
		}

		this.sentPackets++;
		this.sentBytes += this.pendingLength;
		this.pendingLength = 0;
	}

	close(drain: boolean) {
		if (drain) {
			this.flush();
		}
		this.destroy();
	}

	/** What each link in the group is doing, as libsrt reports it. */
	linkStates(): SrtLinkState[] {
		if (!this.libsrt || this.group === SRT_ERROR) {
			return [];
		}

		const out = new Uint8Array(GROUP_DATA_SIZE * Math.max(this.links.length, 1));
		const inoutLen = [this.links.length];
		if (this.libsrt.groupData(this.group, out, inoutLen) === SRT_ERROR) {
			return [];
		}

		const count = Math.min(inoutLen[0]!, this.links.length);
		return Array.from({ length: count }, (_, i) => ({
			url: this.links[i]!.url,
			...readGroupData(out, i),
		}));
	}

	private destroy() {
		if (this.libsrt && this.group !== SRT_ERROR) {
			this.libsrt.close(this.group);
			this.group = SRT_ERROR;
		}
	}
}

/**
 * Options for {@link SrtBondedTarget}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type SrtBondedTargetOptions = {
	/**
	 * How the group spends its links. Defaults to `'broadcast'`.
	 *
	 * - `'broadcast'`: every payload goes down every link, and the receiver takes whichever copy arrives
	 *   first. This is the one that survives a link failing outright, at the cost of sending the stream
	 *   once per link.
	 * - `'backup'`: one link carries the stream and the others stand idle until it degrades. Link
	 *   {@link SrtBondedTargetOptions.weights} decide which is preferred.
	 */
	groupType?: 'broadcast' | 'backup';
	/** AES passphrase, 10 to 79 characters, which must match the receiver's. */
	passphrase?: string;
	/** **Milliseconds** of receiver buffer, set on both ends of the group. Defaults to 120. */
	latencyMs?: number;
	/** Bytes per SRT payload. Defaults to 1316, which is 7 MPEG-TS packets and fits one MTU. */
	payloadSize?: number;
	/** The stream id the listener sees, for routing by `streamid`. */
	streamId?: string;
	/**
	 * Per-link preference, in the order the URLs were given. Higher wins. Only `'backup'` reads it, and
	 * every link defaults to 0.
	 */
	weights?: number[];
};

/**
 * A target that sends one byte stream down several SRT links at once, over libsrt's socket groups.
 *
 * A bonded link is what carries a stream over two networks that each drop out on their own — the case a
 * single `srt://` connection cannot survive. FFmpeg's `srt` protocol does not expose socket groups at
 * all, so this binds libsrt directly.
 *
 * ```ts
 * const target = new SrtBondedTarget(['srt://a.example:9000', 'srt://b.example:9000']);
 * ```
 *
 * Requires libsrt **built with bonding** (`ENABLE_BONDING`, the default in 1.5.x) on the system
 * (`brew install srt`, `apt install libsrt1.5-openssl`), or `MEDIABUNNY_LIBSRT` pointing at it. A build
 * without it is refused at load with a message saying so, rather than failing on the first connect.
 *
 * @group \@mediabunny/server
 * @public
 */
export class SrtBondedTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private sink: SrtBondedSink;

	constructor(url: string | string[], options: SrtBondedTargetOptions = {}) {
		const urls = Array.isArray(url) ? url : [url];
		if (urls.length === 0) {
			throw new TypeError(
				'url states no link; give at least one srt:// URL, or several to bond them.',
			);
		}
		for (const one of urls) {
			parseSrtUrl(one);
		}
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.groupType !== undefined && !['broadcast', 'backup'].includes(options.groupType)) {
			throw new TypeError('options.groupType, when provided, must be \'broadcast\' or \'backup\'.');
		}
		if (options.passphrase !== undefined
			&& (typeof options.passphrase !== 'string'
				|| options.passphrase.length < 10
				|| options.passphrase.length > 79)) {
			throw new TypeError(
				'options.passphrase, when provided, must be a string of 10 to 79 characters, which is what'
				+ ' SRT accepts.',
			);
		}
		if (options.streamId !== undefined && typeof options.streamId !== 'string') {
			throw new TypeError('options.streamId, when provided, must be a string.');
		}
		if (options.weights !== undefined) {
			if (!Array.isArray(options.weights) || options.weights.length !== urls.length) {
				throw new TypeError(
					`options.weights, when provided, must state one weight per link (${urls.length} given).`,
				);
			}
			for (const weight of options.weights) {
				if (!Number.isInteger(weight) || weight < 0 || weight > 65535) {
					throw new TypeError('Each weight must be an integer from 0 to 65535.');
				}
			}
		}

		const sink = new SrtBondedSink(urls, {
			groupType: options.groupType === 'backup' ? SrtGroupType.BACKUP : SrtGroupType.BROADCAST,
			passphrase: options.passphrase,
			latencyMs: positive(options.latencyMs, 'latencyMs', DEFAULT_LATENCY_MS),
			payloadSize: positive(options.payloadSize, 'payloadSize', PAYLOAD_SIZE),
			streamId: options.streamId,
			weights: options.weights,
		});

		super(new WritableStream<Uint8Array>({
			start: () => sink.start(),
			write: chunk => sink.write(chunk),
			close: () => sink.close(true),
			abort: () => sink.close(false),
		}));

		this.sink = sink;
	}

	/** Payloads handed to libsrt. Not what left the wire — a broadcast group sends each one per link. */
	get sentPackets() {
		return this.sink.sentPackets;
	}

	/** Bytes handed to libsrt, counted once per payload rather than once per link. */
	get sentBytes() {
		return this.sink.sentBytes;
	}

	/**
	 * What each link is doing, as libsrt reports it: `'running'` for the ones carrying data, `'idle'`
	 * for a backup group's standby links, `'pending'` while connecting and `'broken'` once a link has
	 * failed. Empty before the group is open.
	 */
	get linkStates() {
		return this.sink.linkStates();
	}
}
