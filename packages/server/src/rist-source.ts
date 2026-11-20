/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ReadableStreamSource } from 'mediabunny';
import { parseUrls, positive, type ResolvedPeer } from './rist-peer';
import { buildNacks, buildReceiverReport, senderSsrcOf } from './rist-rtcp';
import { parseRtp, seqDistance } from './rtp';
import { RistPath, type PathAddress } from './rist-transport';

/**
 * Milliseconds the reorder buffer holds a packet before giving up on the ones missing before it.
 *
 * @group \@mediabunny/server
 * @public
 */
export const DEFAULT_RIST_BUFFER_MS = 1000;

/** TR-06-1 §5.2 caps the gap between compound RTCP packets at 100 ms. */
const RTCP_INTERVAL_MS = 100;
/** Sequence numbers asked for in one NACK. TR-06-1 §5.3.1.3 suggests keeping these packets small. */
const MAX_NACKS_PER_PACKET = 64;

/**
 * Options for {@link RistSource}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type RistSourceOptions = {
	/**
	 * Whether to bind the URL's ports and wait for a sender (`'listener'`, the default) or to announce
	 * this receiver to one (`'caller'`). A caller sends RTCP to the URL until media arrives, which is
	 * what lets a sender behind NAT learn where to send.
	 */
	mode?: 'listener' | 'caller';
	/**
	 * Which RIST profile to speak. Defaults to `'simple'`, which is what MediaConnect speaks; librist's
	 * own tools default to main. **Both ends must agree** — a profile disagreement delivers nothing
	 * rather than failing loudly.
	 */
	profile?: 'simple' | 'main';
	/**
	 * **Milliseconds** a packet may wait for the ones before it, which is also how long a lost packet
	 * has to be retransmitted. Defaults to {@link DEFAULT_RIST_BUFFER_MS}. This is the latency knob
	 * MediaConnect states as "max latency".
	 */
	bufferMs?: number;
	/** **Seconds** without media before the stream ends. Defaults to 30. */
	readTimeout?: number;
	/** **Milliseconds** between NACKs for the same missing packet. Defaults to 20. */
	nackIntervalMs?: number;
	/** Pre-shared passphrase for main-profile encryption. Must match the sender's. */
	secret?: string;
	/** AES key length to use with {@link RistSourceOptions.secret}. Defaults to 256. */
	aesType?: 128 | 256;
	/** Maximum bytes to keep for re-reads. Passed through to Mediabunny's `ReadableStreamSource`. */
	maxCacheSize?: number;
};

type Resolved = ResolvedPeer & {
	bufferMs: number;
	readTimeout: number;
	nackIntervalMs: number;
};

/**
 * One RIST stream, however many paths carry it.
 *
 * The reorder buffer is shared across every path rather than one per path: that is what merging is.
 * Packets are keyed by RTP sequence number, so a packet replicated down two links is held once and
 * released once (SMPTE 2022-7), and a stream split across two links is put back in order.
 */
class RistStreamReader {
	private readonly ourSsrc = (Math.random() * 0xffffffff) >>> 0;
	private readonly cname = new TextEncoder().encode('mediabunny');
	private readonly paths: RistPath[] = [];
	private closed = false;
	private cancelled = false;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	private silenceTimer: ReturnType<typeof setInterval> | undefined;
	private releaseTimer: ReturnType<typeof setInterval> | undefined;
	private rtcpTimer: ReturnType<typeof setInterval> | undefined;

	/** Packets waiting for the ones before them, and when each arrived. */
	private readonly buffered = new Map<number, { payload: Uint8Array; at: number }>();
	/** When each missing sequence number was last asked for, so a NACK is not repeated too soon. */
	private readonly requested = new Map<number, number>();
	private expected: number | null = null;
	private anchorAt = 0;
	private senderSsrc = 0;
	private emittedAny = false;
	private lastByteAt = 0;
	private received = 0;
	private lost = 0;
	private highestSeq = 0;
	/** Payloads that arrived on more than one path, which is what replication buys and costs. */
	duplicates = 0;

	constructor(
		private readonly urls: { host: string; port: number }[],
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
			// Already closed
		}
	}

	private stopEverything() {
		clearInterval(this.silenceTimer);
		clearInterval(this.releaseTimer);
		clearInterval(this.rtcpTimer);
		for (const path of this.paths) {
			path.close();
		}
	}

	private emit(payload: Uint8Array) {
		if (this.cancelled || this.closed) {
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

		// Before anything has gone out, the lowest sequence number held is the right place to start, but
		// only once the paths have had their buffer to deliver: a later path may still carry an earlier
		// packet, and starting at the first arrival would write it off unseen
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

	/**
	 * Asks for what is missing. The request goes out on every live path: a packet lost on one may be
	 * resent down another, and a path whose NACK never arrives cannot be the only one asking.
	 */
	private sendNacks() {
		if (this.expected === null || this.buffered.size === 0) {
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
			if (missing.length === MAX_NACKS_PER_PACKET) {
				break;
			}
		}

		if (missing.length === 0) {
			return;
		}

		const nacks = buildNacks(this.ourSsrc, this.senderSsrc, missing);
		for (const path of this.paths) {
			if (path.peer) {
				path.sendControl(nacks);
			}
		}
	}

	private onMedia = (bytes: Uint8Array, from: PathAddress, path: RistPath) => {
		const packet = parseRtp(bytes);
		if (!packet) {
			return;
		}

		// A sender's media tells a listener where that sender's control port is, which is the only
		// address a NACK can go to before any RTCP has arrived
		path.peer ??= { address: from.address, port: from.port };

		this.lastByteAt = Date.now();
		this.received++;
		if (this.senderSsrc === 0) {
			// TR-06-1 §5.3.2 marks a retransmission with the SSRC's low bit; the other 31 name the flow,
			// so the flow id is what identifies the stream across originals and retransmissions alike
			this.senderSsrc = (packet.ssrc & ~1) >>> 0;
		}

		if (this.expected === null) {
			this.expected = packet.seq;
			this.highestSeq = packet.seq;
			this.anchorAt = Date.now() + this.options.bufferMs;
		}

		if (seqDistance(packet.seq, this.expected) < 0) {
			if (this.emittedAny) {
				return; // Already released past this one; a late copy is not a second packet
			}
			this.expected = packet.seq;
		}
		if (seqDistance(packet.seq, this.highestSeq) > 0) {
			this.highestSeq = packet.seq;
		}

		if (this.buffered.has(packet.seq)) {
			this.duplicates++;
			return;
		}

		this.buffered.set(packet.seq, { payload: packet.payload.slice(), at: Date.now() });
		this.release();
		this.sendNacks();
	};

	private onControl = (bytes: Uint8Array, from: PathAddress, path: RistPath) => {
		const ssrc = senderSsrcOf(bytes);
		if (ssrc !== null && this.senderSsrc === 0) {
			this.senderSsrc = ssrc;
		}
		path.peer = from;
	};

	private sendReports() {
		const report = buildReceiverReport(this.ourSsrc, this.senderSsrc, this.cname, {
			highestSeq: this.highestSeq,
			lost: this.lost,
			received: this.received,
		});

		for (const path of this.paths) {
			path.sendKeepalive();
			if (path.peer) {
				path.sendControl(report);
			}
		}
	}

	async start(controller: ReadableStreamDefaultController<Uint8Array>) {
		this.controller = controller;

		for (const { host, port } of this.urls) {
			const path: RistPath = new RistPath({
				profile: this.options.profile,
				mode: this.options.mode,
				host,
				port,
				secret: this.options.secret,
				aesType: this.options.aesType ?? 256,
				onMedia: (payload, from) => this.onMedia(payload, from, path),
				onControl: (payload, from) => this.onControl(payload, from, path),
				onError: error => controller.error(error),
			});
			await path.open();
			this.paths.push(path);
		}

		this.lastByteAt = Date.now();
		// A caller announces itself from the first tick; a listener's reports start once a peer is known
		this.sendReports();
		this.rtcpTimer = setInterval(() => this.sendReports(), RTCP_INTERVAL_MS);

		this.silenceTimer = setInterval(() => {
			if (!this.closed && Date.now() - this.lastByteAt >= this.options.readTimeout * 1000) {
				this.release();
				this.closeOnce();
				this.stopEverything();
			}
		}, Math.max(50, Math.min(500, this.options.readTimeout * 250)));

		this.releaseTimer = setInterval(
			() => this.release(),
			Math.max(10, Math.round(this.options.bufferMs / 4)),
		);
	}

	cancel() {
		this.cancelled = true;
		this.closeOnce();
		this.stopEverything();
	}
}

/**
 * Reads a RIST stream as an MPEG-TS byte stream — Simple Profile (VSF TR-06-1) or Main Profile
 * (TR-06-2) with its GRE framing and AES encryption. The protocol is spoken directly: there is no
 * native library and nothing to install.
 *
 * Packets are released in sequence order once their predecessors arrive or `bufferMs` runs out, so a
 * stream with loss beyond recovery continues with a gap rather than stalling. What is missing is asked
 * for by NACK until the buffer runs out.
 *
 * Several URLs merge several paths into one stream by RTP sequence number: a packet carried down two
 * links is delivered once, and a stream split across two links is put back in order (TR-06-1 §5.4,
 * SMPTE 2022-7).
 *
 * @example
 * ```ts
 * const input = new Input({
 * 	formats: [new MpegTsInputFormat()],
 * 	source: new RistSource(['rist://0.0.0.0:9000', 'rist://0.0.0.0:9002'], { mode: 'listener' }),
 * });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class RistSource extends ReadableStreamSource {
	/** @internal */
	private readonly reader: RistStreamReader;

	constructor(url: string | string[], options: RistSourceOptions = {}) {
		const { urls, peer } = parseUrls(url, options, 'RistSource');

		const reader = new RistStreamReader(urls, {
			...peer,
			// A receiver defaults to listening, where a sender defaults to calling
			mode: (options.mode ?? 'listener'),
			bufferMs: positive(options.bufferMs, 'bufferMs', DEFAULT_RIST_BUFFER_MS),
			readTimeout: positive(options.readTimeout, 'readTimeout', 30),
			nackIntervalMs: positive(options.nackIntervalMs, 'nackIntervalMs', 20),
		});

		super(
			new ReadableStream<Uint8Array>({
				start: controller => reader.start(controller),
				cancel: () => reader.cancel(),
			}),
			{ maxCacheSize: options.maxCacheSize },
		);
		this.reader = reader;
	}

	/**
	 * Payloads that arrived on more than one path and were delivered once. On replicated links this is
	 * the protection working; on links meant to be split it means the sender is not splitting.
	 */
	get duplicates(): number {
		return this.reader.duplicates;
	}
}
