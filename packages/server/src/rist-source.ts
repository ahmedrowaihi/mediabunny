/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ReadableStreamSource } from 'mediabunny';
import { createSocket, type Socket } from 'node:dgram';

/**
 * Milliseconds the reorder buffer holds a packet before giving up on the ones missing before it.
 *
 * @group \@mediabunny/server
 * @public
 */
export const DEFAULT_RIST_BUFFER_MS = 1000;

const RTP_VERSION = 2;
const RTP_HEADER_SIZE = 12;

const RTCP_SR = 200;
const RTCP_RR = 201;
const RTCP_SDES = 202;
const RTCP_APP = 204;
const RTCP_RTPFB = 205;
const RTPFB_GENERIC_NACK = 1;

// TR-06-1 names its range NACK with this, in an RTCP APP packet of subtype 0
const RIST_APP_NAME = 0x52495354; // 'RIST'

/**
 * Options for {@link RistSource}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type RistSourceOptions = {
	/**
	 * Whether to bind and wait for a sender (`'listener'`, the default) or to announce this receiver to one
	 * (`'caller'`). A caller binds an ephemeral port pair and sends RTCP to the URL's address until media
	 * arrives, which is what lets a sender behind NAT learn where to send.
	 */
	mode?: 'listener' | 'caller';
	/**
	 * Milliseconds a packet may wait for the ones before it, which is also how long a lost packet has to be
	 * retransmitted. Defaults to {@link DEFAULT_RIST_BUFFER_MS}. This is the latency knob MediaConnect
	 * states as "max latency".
	 */
	bufferMs?: number;
	/** Seconds without media before the stream ends. Defaults to 30. */
	readTimeout?: number;
	/** Milliseconds between NACKs for the same missing packet. Defaults to 20. */
	nackIntervalMs?: number;
	/** Maximum bytes to keep for re-reads. Passed through to Mediabunny's `ReadableStreamSource`. */
	maxCacheSize?: number;
};

type Resolved = Required<Omit<RistSourceOptions, 'maxCacheSize'>>;

const positive = (value: number | undefined, name: string) => {
	if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
		throw new TypeError(`options.${name}, when provided, must be a positive number.`);
	}
};

/** Signed 16-bit distance, so a comparison still holds across the 65535 to 0 wrap. */
const seqDistance = (a: number, b: number) => (((a - b) & 0xffff) ^ 0x8000) - 0x8000;

type RtpPacket = { seq: number; ssrc: number; payload: Uint8Array };

const parseRtp = (bytes: Uint8Array): RtpPacket | null => {
	if (bytes.length < RTP_HEADER_SIZE || bytes[0]! >> 6 !== RTP_VERSION) {
		return null;
	}

	let start = RTP_HEADER_SIZE + (bytes[0]! & 0x0f) * 4;
	if (bytes[0]! & 0x10) { // extension
		if (bytes.length < start + 4) {
			return null;
		}
		start += 4 + (((bytes[start + 2]! << 8) | bytes[start + 3]!) * 4);
	}

	const end = bytes.length - (bytes[0]! & 0x20 ? bytes[bytes.length - 1]! : 0);
	if (start >= end) {
		return null;
	}

	return {
		seq: (bytes[2]! << 8) | bytes[3]!,
		ssrc: (bytes[8]! << 24 | bytes[9]! << 16 | bytes[10]! << 8 | bytes[11]!) >>> 0,
		payload: bytes.subarray(start, end),
	};
};

const rtcpHeader = (bytes: Uint8Array, offset: number, count: number, packetType: number, words: number) => {
	bytes[offset] = (RTP_VERSION << 6) | count;
	bytes[offset + 1] = packetType;
	bytes[offset + 2] = words >> 8;
	bytes[offset + 3] = words & 0xff;
};

const writeU32 = (bytes: Uint8Array, offset: number, value: number) => {
	bytes[offset] = (value >>> 24) & 0xff;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
};

/** One RFC 4585 generic NACK per missing packet, plus TR-06-1's range NACK, in one compound packet. */
const buildNacks = (ourSsrc: number, senderSsrc: number, missing: number[]): Uint8Array => {
	const ranges: { start: number; extra: number }[] = [];
	for (const seq of missing) {
		const last = ranges[ranges.length - 1];
		if (last && seq === ((last.start + last.extra + 1) & 0xffff) && last.extra < 0xffff) {
			last.extra++;
		} else {
			ranges.push({ start: seq, extra: 0 });
		}
	}

	// Both lengths are in 32-bit words minus one, as RTCP states them
	const genericWords = 2 + missing.length;
	const appWords = 2 + ranges.length;
	const bytes = new Uint8Array((genericWords + 1) * 4 + (appWords + 1) * 4);

	rtcpHeader(bytes, 0, RTPFB_GENERIC_NACK, RTCP_RTPFB, genericWords);
	writeU32(bytes, 4, ourSsrc);
	writeU32(bytes, 8, senderSsrc);
	missing.forEach((seq, i) => writeU32(bytes, 12 + i * 4, (seq << 16) >>> 0));

	const offset = (genericWords + 1) * 4;
	rtcpHeader(bytes, offset, 0, RTCP_APP, appWords);
	writeU32(bytes, offset + 4, ourSsrc);
	writeU32(bytes, offset + 8, RIST_APP_NAME);
	ranges.forEach(({ start, extra }, i) => {
		writeU32(bytes, offset + 12 + i * 4, ((start << 16) | extra) >>> 0);
	});

	return bytes;
};

/** An RR with one report block, and the SDES CNAME beside it that TR-06-1 asks a receiver to send. */
const buildReceiverReport = (
	ourSsrc: number,
	senderSsrc: number,
	state: { highestSeq: number; lost: number; received: number },
): Uint8Array => {
	const cname = new TextEncoder().encode('mediabunny');
	const sdesTextWords = Math.ceil((4 + 2 + cname.length + 1) / 4);
	const bytes = new Uint8Array(8 * 4 + (sdesTextWords + 1) * 4);

	rtcpHeader(bytes, 0, senderSsrc === 0 ? 0 : 1, RTCP_RR, senderSsrc === 0 ? 1 : 7);
	writeU32(bytes, 4, ourSsrc);
	if (senderSsrc !== 0) {
		writeU32(bytes, 8, senderSsrc);
		const expected = Math.max(1, state.received + state.lost);
		bytes[12] = Math.min(255, Math.round((state.lost / expected) * 256));
		writeU32(bytes, 16, state.lost & 0xffffff);
		writeU32(bytes, 20, state.highestSeq);
	}

	const offset = 8 * 4;
	rtcpHeader(bytes, offset, 1, RTCP_SDES, sdesTextWords + 1);
	writeU32(bytes, offset + 4, ourSsrc);
	bytes[offset + 8] = 1; // CNAME
	bytes[offset + 9] = cname.length;
	bytes.set(cname, offset + 10);

	return bytes;
};

/** The sender SSRC of the first SR or SDES in a compound packet, or null. */
const senderSsrcOf = (bytes: Uint8Array): number | null => {
	let offset = 0;
	while (offset + 8 <= bytes.length) {
		const words = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
		const packetType = bytes[offset + 1]!;
		if (packetType === RTCP_SR || packetType === RTCP_SDES) {
			return (bytes[offset + 4]! << 24 | bytes[offset + 5]! << 16
				| bytes[offset + 6]! << 8 | bytes[offset + 7]!) >>> 0;
		}
		offset += (words + 1) * 4;
	}
	return null;
};

const parseUrl = (url: string) => {
	const parsed = new URL(url);
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port <= 0 || port >= 65535) {
		throw new TypeError(`RistSource: ${JSON.stringify(url)} must state a port below 65535.`);
	}
	if (port % 2 !== 0) {
		throw new TypeError(`RistSource: ${JSON.stringify(url)} must state an even port; RTCP uses the next one.`);
	}
	return { host: parsed.hostname || '0.0.0.0', port };
};

/** Attempts before an ephemeral even/odd pair is given up on; a collision is rare and retried. */
const PAIR_BIND_ATTEMPTS = 20;

const newSocket = () => createSocket({ type: 'udp4', reuseAddr: true });

const bind = (socket: Socket, bindOptions: { address?: string; port: number }) =>
	new Promise<void>((resolve, reject) => {
		socket.once('error', reject);
		socket.bind(bindOptions, () => resolve());
	});

const closeIfBound = (socket: Socket) => {
	try {
		socket.close();
	} catch {
		// Never bound, so there is nothing to close
	}
};

/**
 * The media socket and the control socket above it. A listener takes the URL's pair; a caller takes any
 * adjacent pair, since a sender facing one derives its media port as the control port minus one.
 */
const bindPair = async (
	mode: Resolved['mode'],
	host: string,
	port: number,
): Promise<[Socket, Socket]> => {
	if (mode === 'listener') {
		const pair: [Socket, Socket] = [newSocket(), newSocket()];
		await bind(pair[0], { address: host, port });
		await bind(pair[1], { address: host, port: port + 1 });
		return pair;
	}

	let lastError: unknown;
	for (let attempt = 0; attempt < PAIR_BIND_ATTEMPTS; attempt++) {
		const pair: [Socket, Socket] = [newSocket(), newSocket()];
		const base = 1024 + Math.floor(Math.random() * 32_000) * 2;

		try {
			await bind(pair[0], { port: base });
			await bind(pair[1], { port: base + 1 });
			return pair;
		} catch (error) {
			lastError = error;
			pair.forEach(closeIfBound);
		}
	}

	throw lastError;
};

/**
 * One RIST stream: the reorder buffer, the NACK bookkeeping and the two sockets. Held as fields rather
 * than in a closure so the timers and handlers all act on the same visible state.
 */
class RistStreamReader {
	private readonly ourSsrc = (Math.random() * 0xffffffff) >>> 0;
	private media: Socket | undefined;
	private control: Socket | undefined;
	private closed = false;
	private canceled = false;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	private silenceTimer: ReturnType<typeof setInterval> | undefined;
	private releaseTimer: ReturnType<typeof setInterval> | undefined;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

	/** Packets waiting for the ones before them, and when each arrived. */
	private readonly buffered = new Map<number, { payload: Uint8Array; at: number }>();
	/** When each missing sequence number was last asked for, so a NACK is not repeated too soon. */
	private readonly requested = new Map<number, number>();
	private expected: number | null = null;
	private anchorAt = 0;
	private senderSsrc = 0;
	private senderAddress: { address: string; port: number } | null = null;
	private learnedControl = false;
	private emittedAny = false;
	private lastByteAt = 0;
	private received = 0;
	private lost = 0;
	private highestSeq = 0;

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly options: Resolved,
	) {}

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

	private stopEverything() {
		clearInterval(this.silenceTimer);
		clearInterval(this.releaseTimer);
		clearInterval(this.keepaliveTimer);
		this.media?.close();
		this.control?.close();
		this.media = undefined;
		this.control = undefined;
	}

	private emit(payload: Uint8Array) {
		if (this.canceled || this.closed) {
			return;
		}

		this.emittedAny = true;
		this.controller?.enqueue(payload);
	}

	/** Releases what is in order, and once a gap has waited out its buffer, releases past it. */
	private release() {
		if (this.expected === null) {
			return;
		}

		// Nothing leaves before the buffer has filled once: until then the lowest sequence seen is not
		// known to be the lowest there is, and releasing it would discard whatever arrives below it.
		if (!this.emittedAny) {
			if (Date.now() < this.anchorAt) {
				return;
			}
			for (const seq of this.buffered.keys()) {
				if (seqDistance(seq, this.expected) < 0) {
					this.expected = seq;
				}
			}
		}

		for (;;) {
			const next = this.buffered.get(this.expected);
			if (next) {
				this.buffered.delete(this.expected);
				this.requested.delete(this.expected);
				this.expected = (this.expected + 1) & 0xffff;
				this.emit(next.payload);
				continue;
			}

			if (this.buffered.size === 0) {
				return;
			}

			let oldest = Infinity;
			let lowest: number | null = null;
			for (const [seq, held] of this.buffered) {
				oldest = Math.min(oldest, held.at);
				if (lowest === null || seqDistance(seq, lowest) < 0) {
					lowest = seq;
				}
			}

			if (Date.now() - oldest < this.options.bufferMs) {
				return;
			}

			const resumeAt = lowest!;
			this.lost += Math.max(1, seqDistance(resumeAt, this.expected));
			for (let seq: number = this.expected; seq !== resumeAt; seq = (seq + 1) & 0xffff) {
				this.requested.delete(seq);
			}
			this.expected = resumeAt;
		}
	}

	private sendNacks() {
		if (!this.control || !this.senderAddress || this.expected === null || this.buffered.size === 0) {
			return;
		}

		const now = Date.now();
		const missing: number[] = [];
		for (let seq = this.expected; seq !== this.highestSeq; seq = (seq + 1) & 0xffff) {
			if (this.buffered.has(seq)) {
				continue;
			}

			const asked = this.requested.get(seq) ?? 0;
			if (now - asked >= this.options.nackIntervalMs) {
				this.requested.set(seq, now);
				missing.push(seq);
			}
			if (missing.length === 64) {
				break;
			}
		}

		if (missing.length > 0) {
			this.control.send(
				buildNacks(this.ourSsrc, this.senderSsrc, missing),
				this.senderAddress.port,
				this.senderAddress.address,
			);
		}
	}

	private onMedia = (bytes: Buffer, from: { address: string; port: number }) => {
		const packet = parseRtp(new Uint8Array(bytes));
		if (!packet) {
			return;
		}

		this.lastByteAt = Date.now();
		this.received++;
		// TR-06-1 pairs the sender's ports as it does the receiver's, but a sender that sends RTCP states
		// its control address outright, so that one wins
		if (!this.learnedControl) {
			this.senderAddress = { address: from.address, port: from.port + 1 };
		}
		if (this.senderSsrc === 0) {
			this.senderSsrc = packet.ssrc;
		}

		if (this.expected === null) {
			this.expected = packet.seq;
			this.highestSeq = packet.seq;
			this.anchorAt = Date.now() + this.options.bufferMs;
		}

		// Before anything is released the anchor is just the lowest seen, so a stream whose first datagrams
		// arrive swapped does not lose the ones below it. After that, a lower one is a late retransmission.
		if (seqDistance(packet.seq, this.expected) < 0) {
			if (this.emittedAny) {
				return;
			}
			this.expected = packet.seq;
		}
		if (seqDistance(packet.seq, this.highestSeq) > 0) {
			this.highestSeq = packet.seq;
		}

		if (!this.buffered.has(packet.seq)) {
			this.buffered.set(packet.seq, { payload: packet.payload, at: Date.now() });
		}

		this.release();
		this.sendNacks();
	};

	private onControl = (bytes: Buffer, from: { address: string; port: number }) => {
		const ssrc = senderSsrcOf(new Uint8Array(bytes));
		if (ssrc !== null && this.senderSsrc === 0) {
			this.senderSsrc = ssrc;
		}

		this.senderAddress = { address: from.address, port: from.port };
		this.learnedControl = true;

		this.control?.send(
			buildReceiverReport(this.ourSsrc, this.senderSsrc, this.reportCounts()),
			this.senderAddress.port,
			this.senderAddress.address,
		);
	};

	private reportCounts() {
		return { highestSeq: this.highestSeq, lost: this.lost, received: this.received };
	}

	/** Announces this receiver to the sender until media arrives, which is what a caller mode is for. */
	private startAnnouncing() {
		this.senderAddress = { address: this.host, port: this.port + 1 };
		const announce = () => {
			if (!this.senderAddress || this.received > 0) {
				return;
			}

			this.control?.send(
				buildReceiverReport(this.ourSsrc, 0, this.reportCounts()),
				this.senderAddress.port,
				this.senderAddress.address,
			);
		};

		announce();
		this.keepaliveTimer = setInterval(announce, 200);
	}

	async start(controller: ReadableStreamDefaultController<Uint8Array>) {
		this.controller = controller;

		const [media, control] = await bindPair(this.options.mode, this.host, this.port);
		this.media = media;
		this.control = control;

		media.on('message', this.onMedia);
		control.on('message', this.onControl);
		media.on('error', error => controller.error(error));
		control.on('error', error => controller.error(error));

		if (this.options.mode === 'caller') {
			this.startAnnouncing();
		}

		this.lastByteAt = Date.now();
		this.silenceTimer = setInterval(() => {
			if (!this.closed && Date.now() - this.lastByteAt >= this.options.readTimeout * 1000) {
				this.release();
				this.closeOnce();
				this.stopEverything();
			}
		}, Math.max(50, Math.min(500, this.options.readTimeout * 250)));

		// A gap's deadline passes without any packet arriving to notice it
		this.releaseTimer = setInterval(() => this.release(), Math.max(10, Math.round(this.options.bufferMs / 4)));
	}

	cancel() {
		this.canceled = true;
		this.closeOnce();
		this.stopEverything();
	}
}

const openStream = (url: string, options: Resolved): ReadableStream<Uint8Array> => {
	const { host, port } = parseUrl(url);
	const reader = new RistStreamReader(host, port, options);

	return new ReadableStream<Uint8Array>({
		start: controller => reader.start(controller),
		cancel: () => reader.cancel(),
	});
};

/**
 * Reads a RIST Simple Profile stream (VSF TR-06-1) as an MPEG-TS byte stream: RTP on the URL's even port
 * carries the transport stream, RTCP on the next port carries the NACKs that ask for what was lost.
 *
 * Packets are released in sequence order once their predecessors arrive or `bufferMs` runs out, so a
 * stream with loss beyond recovery continues with a gap rather than stalling.
 *
 * @group \@mediabunny/server
 * @public
 */
export class RistSource extends ReadableStreamSource {
	constructor(url: string, options: RistSourceOptions = {}) {
		if (typeof url !== 'string') {
			throw new TypeError('url must be a string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.mode !== undefined && options.mode !== 'listener' && options.mode !== 'caller') {
			throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
		}
		positive(options.bufferMs, 'bufferMs');
		positive(options.readTimeout, 'readTimeout');
		positive(options.nackIntervalMs, 'nackIntervalMs');

		const scheme = url.slice(0, url.indexOf(':'));
		if (scheme !== 'rist') {
			throw new TypeError(`RistSource: ${JSON.stringify(url)} is not a rist:// URL.`);
		}

		const resolved: Resolved = {
			mode: options.mode ?? 'listener',
			bufferMs: options.bufferMs ?? DEFAULT_RIST_BUFFER_MS,
			readTimeout: options.readTimeout ?? 30,
			nackIntervalMs: options.nackIntervalMs ?? 20,
		};

		super(openStream(url, resolved), { maxCacheSize: options.maxCacheSize });
	}
}
