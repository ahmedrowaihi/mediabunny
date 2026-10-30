/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// RIST over librist, which owns the wire: sequencing, the retransmit buffer, the two sockets, the
// handshake, encryption and rate control. This file only cuts the byte stream into RIST-sized payloads,
// hands them over, and reads librist's counters back out.
//
// That is a deliberately different division of labour from `@mediabunny/server`'s `RistTarget`, which
// speaks Simple Profile itself because node-av's FFmpeg carries no librist. The two are not
// interchangeable, and the options and counters here say so rather than pretending to match.

import { AppendOnlyStreamTarget } from 'mediabunny';
import { getLibrist, type Librist } from './librist';
import { checkPeerOptions, peerUrl, positive, profileOf, type ResolvedPeer } from './peer-url';

/** 7 MPEG-TS packets, the payload a RIST datagram carries. */
const PAYLOAD_SIZE = 1316;

/** A receiver cannot ask for what it has already given up on, so this matches `RistSource`'s buffer. */
const DEFAULT_RETRANSMIT_BUFFER_MS = 1_000;

/**
 * Coarse on purpose. koffi services a value-returning callback on the main loop and blocks librist's
 * stats thread until it does, and librist raises stats holding its `stats_lock`.
 */
const DEFAULT_STATS_INTERVAL_MS = 1_000;

/**
 * librist has no drain call, so destroying the context straight after the last write loses whatever its
 * sender thread has not picked up — the trailing partial payload, every time. A close waits this long
 * instead. Measured: the tail is lost at 50ms and delivered at 100ms, so this is margin, not a bound.
 * Bounded either way — a queue deeper than this still loses its tail.
 */
const DRAIN_GRACE_MS = 250;

/**
 * Options for {@link RistTarget}.
 *
 * @group \@mediabunny/rist
 * @public
 */
export type RistTargetOptions = {
	/**
	 * Whether to send to a receiver that is listening (`'caller'`, the default) or to bind the URL's
	 * ports and wait for one to announce itself (`'listener'`).
	 */
	mode?: 'listener' | 'caller';
	/**
	 * Which RIST profile to speak. Defaults to `'main'`, which is also what librist's own `ristsender`
	 * and `ristreceiver` default to.
	 *
	 * **Both ends must agree.** A simple-profile sender against a main-profile receiver does not fail
	 * loudly — the receiver logs `Non conformant main profile packet received` and delivers nothing.
	 *
	 * Encryption needs main profile: `'simple'` accepts a secret and does not enforce it, so passing
	 * one with `'simple'` throws rather than appearing to protect the stream.
	 */
	profile?: 'simple' | 'main';
	/**
	 * **Milliseconds** of sent packets librist keeps for retransmission. Defaults to 1000.
	 */
	retransmitBufferMs?: number;
	/**
	 * Pre-shared passphrase for main-profile encryption. Without it the stream is sent in the clear,
	 * which a receiver reports as `Encryption is disabled for this peer`.
	 */
	secret?: string;
	/** AES key length to use with {@link RistTargetOptions.secret}. Defaults to 256. */
	aesType?: 128 | 256;
	/**
	 * **Kilobits per second** librist may use, retransmissions included. Left unset, librist paces
	 * itself from its own congestion control.
	 *
	 * This is librist's rate control, not pacing from the stream's own PCR — that is what
	 * `@mediabunny/server`'s `RistTarget` does, and the two produce different inter-packet timing for
	 * the same input. Bytes librist declines to send under this cap are counted by
	 * {@link RistTarget.skippedPackets}.
	 */
	bandwidthKbps?: number;
	/** How often librist's counters are read, in **milliseconds**. Defaults to 1000. */
	statsIntervalMs?: number;
	/**
	 * Enables the main-profile GRE tunnel, which carries arbitrary packets alongside the media. Off by
	 * default, and refused on simple profile, which has no GRE layer for them.
	 *
	 * The channel is bidirectional: both ends send with `sendTunnelPacket` and read with
	 * `readTunnelPacket`.
	 */
	tunnel?: boolean;
};

/** The fields read out of librist's stats JSON, which reports each interval's delta. */
type PeerStatsDelta = {
	sent: number;
	retransmitted: number;
	retransmitted_bytes: number;
	bandwidth_skipped: number;
	bloat_skipped: number;
	retransmit_skipped: number;
};

/**
 * Cuts the byte stream into RIST payloads and hands them to librist, accumulating librist's own
 * counters as it goes.
 */
class RistSink {
	private librist: Librist;
	private ctx: unknown = null;
	private peerHandle: unknown = null;
	private stopStats: (() => void) | null = null;

	/** Bytes not yet making up a whole payload. A write arrives at the muxer's convenience, not RIST's. */
	private pending = new Uint8Array(PAYLOAD_SIZE);
	private pendingLength = 0;

	sentPackets = 0;
	sentBytes = 0;
	retransmittedPackets = 0;
	retransmittedBytes = 0;
	skippedPackets = 0;

	constructor(
		private url: string,
		private statsIntervalMs: number,
		private tunnel: boolean,
		private peer: ResolvedPeer,
	) {
		this.librist = getLibrist();
	}

	start() {
		const ctxOut: unknown[] = [null];
		if (this.librist.senderCreate(ctxOut, profileOf(this.peer.profile), 0, null) !== 0) {
			throw new Error('librist could not create a sender context.');
		}
		this.ctx = ctxOut[0];

		const configOut: unknown[] = [null];
		if (this.librist.parseAddress(peerUrl(this.url, this.peer), configOut) !== 0) {
			this.destroyNow();
			throw new Error(`librist could not parse ${this.url} as a peer address.`);
		}

		const peerOut: unknown[] = [null];
		const created = this.librist.peerCreate(this.ctx, peerOut, configOut[0]);
		this.librist.peerConfigFree(configOut);
		this.peerHandle = peerOut[0];
		if (created !== 0) {
			this.destroyNow();
			throw new Error(`librist could not create a peer for ${this.url}.`);
		}

		// Before `rist_start`, as oob.h requires
		if (this.tunnel && this.librist.oobEnable(this.ctx) !== 0) {
			this.destroyNow();
			throw new Error('librist refused to enable the tunnel channel.');
		}

		this.stopStats = this.librist.statsCallbackSet(
			this.ctx,
			this.statsIntervalMs,
			json => this.absorbStats(json),
		);

		if (this.librist.start(this.ctx) !== 0) {
			// No grace here, unlike `close`: nothing has been handed over, so there is nothing to drain
			this.destroyNow();
			throw new Error(`librist could not start sending to ${this.url}.`);
		}
	}

	/**
	 * librist reports each interval's **delta**, not a running total, so these accumulate. Reading the
	 * latest report as the total gives a keepalive interval's figure, which looks plausible and is not.
	 */
	private absorbStats(json: string) {
		let peers: { stats: PeerStatsDelta }[];
		try {
			peers = (JSON.parse(json) as {
				'sender-stats'?: { peers?: { stats: PeerStatsDelta }[] };
			})['sender-stats']?.peers ?? [];
		} catch {
			return; // A report this binding cannot read is not worth failing a live stream over
		}

		for (const { stats } of peers) {
			this.retransmittedPackets += stats.retransmitted ?? 0;
			this.retransmittedBytes += stats.retransmitted_bytes ?? 0;
			this.skippedPackets += (stats.bandwidth_skipped ?? 0)
				+ (stats.bloat_skipped ?? 0)
				+ (stats.retransmit_skipped ?? 0);
		}
	}

	write(chunk: Uint8Array) {
		let at = 0;
		while (at < chunk.byteLength) {
			const take = Math.min(PAYLOAD_SIZE - this.pendingLength, chunk.byteLength - at);
			this.pending.set(chunk.subarray(at, at + take), this.pendingLength);
			this.pendingLength += take;
			at += take;

			if (this.pendingLength === PAYLOAD_SIZE) {
				this.send(this.pending.subarray(0, PAYLOAD_SIZE));
				this.pendingLength = 0;
			}
		}
	}

	private send(payload: Uint8Array) {
		const written = this.librist.senderWrite(this.ctx, payload);

		if (written < 0) {
			throw new Error('librist refused a payload; the sender is no longer usable.');
		}

		this.sentPackets++;
		this.sentBytes += payload.byteLength;
	}

	sendTunnelPacket(data: Uint8Array) {
		if (!this.tunnel) {
			throw new Error('The tunnel is not enabled; pass `tunnel: true`.');
		}
		if (!this.librist.oobWrite(this.ctx, this.peerHandle, data)) {
			throw new Error('librist dropped the tunnel packet.');
		}
	}

	readTunnelPacket() {
		if (!this.tunnel) {
			throw new Error('The tunnel is not enabled; pass `tunnel: true`.');
		}
		return this.librist.oobRead(this.ctx);
	}

	flush() {
		if (this.pendingLength > 0) {
			this.send(this.pending.subarray(0, this.pendingLength));
			this.pendingLength = 0;
		}
	}

	async close(drain: boolean) {
		this.flush();

		if (drain && this.ctx) {
			await new Promise(resolve => setTimeout(resolve, DRAIN_GRACE_MS));
		}

		this.destroyNow();
	}

	private destroyNow() {
		// Stats first: the callback must not be able to fire into a destroyed context
		this.stopStats?.();
		this.stopStats = null;
		if (this.ctx) {
			this.librist.destroy(this.ctx);
			this.ctx = null;
		}
	}
}

/**
 * A target that sends the output over RIST using librist.
 *
 * librist owns the wire — sequencing, the retransmit buffer, the handshake, encryption and rate
 * control — so this target has no send queue of its own and no queue-bound options. What librist
 * declines to send is reported by {@link RistTarget.skippedPackets} rather than dropped here.
 *
 * Requires librist on the system (`brew install librist`, `apt install librist4`), or
 * `MEDIABUNNY_LIBRIST` pointing at it.
 *
 * {@link RistTarget.sentPackets} and {@link RistTarget.sentBytes} are counted here, at hand-over to
 * librist. The rest come from librist's own stats, so they lag by up to
 * {@link RistTargetOptions.statsIntervalMs}, and the interval still in progress when the target closes
 * is never reported — a retransmission count read right after close is an undercount.
 *
 * @group \@mediabunny/rist
 * @public
 */
export class RistTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private sink: RistSink;

	constructor(url: string, options: RistTargetOptions = {}) {
		checkPeerOptions(url, options);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.mode !== undefined && !['listener', 'caller'].includes(options.mode)) {
			throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
		}
		if (options.profile !== undefined && !['simple', 'main'].includes(options.profile)) {
			throw new TypeError('options.profile, when provided, must be \'simple\' or \'main\'.');
		}
		if (options.aesType !== undefined && ![128, 256].includes(options.aesType)) {
			throw new TypeError('options.aesType, when provided, must be 128 or 256.');
		}
		if (options.secret !== undefined && typeof options.secret !== 'string') {
			throw new TypeError('options.secret, when provided, must be a string.');
		}

		const statsIntervalMs = positive(options.statsIntervalMs, 'statsIntervalMs', DEFAULT_STATS_INTERVAL_MS);
		const sink = new RistSink(url, statsIntervalMs, options.tunnel ?? false, {
			listener: options.mode === 'listener',
			profile: options.profile ?? 'main',
			bufferMs: positive(options.retransmitBufferMs, 'retransmitBufferMs', DEFAULT_RETRANSMIT_BUFFER_MS),
			secret: options.secret,
			aesType: options.aesType,
			bandwidthKbps: positive(options.bandwidthKbps, 'bandwidthKbps'),
		});
		super(new WritableStream<Uint8Array>({
			start: () => sink.start(),
			write: chunk => sink.write(chunk),
			close: () => sink.close(true),
			// An abort has abandoned the stream, so it must not wait out the drain grace
			abort: () => sink.close(false),
		}));

		this.sink = sink;
	}

	/** Payloads handed to librist. Not what left the wire — librist may retransmit or skip. */
	get sentPackets() {
		return this.sink.sentPackets;
	}

	/** Payload bytes handed to librist, not counting retransmissions. */
	get sentBytes() {
		return this.sink.sentBytes;
	}

	/** Packets librist sent again because a receiver asked for them. */
	get retransmittedPackets() {
		return this.sink.retransmittedPackets;
	}

	/** Bytes librist sent again because a receiver asked for them. */
	get retransmittedBytes() {
		return this.sink.retransmittedBytes;
	}

	/**
	 * Packets librist declined to send — over the bandwidth cap, over its own buffer bloat limit, or a
	 * retransmission it would not make. This is the closest thing to a drop count, and it is librist's
	 * decision rather than this target's.
	 */
	get skippedPackets() {
		return this.sink.skippedPackets;
	}

	/**
	 * Sends one packet down the GRE tunnel, alongside the media. Requires
	 * {@link RistTargetOptions.tunnel}.
	 *
	 * @throws when the tunnel is not enabled, or librist has no peer to send it to.
	 */
	sendTunnelPacket(data: Uint8Array) {
		this.sink.sendTunnelPacket(data);
	}

	/**
	 * Takes the next packet the peer sent down the tunnel, or null when none is waiting. librist queues
	 * them, so this polls rather than blocks.
	 */
	readTunnelPacket() {
		return this.sink.readTunnelPacket();
	}

	/** The path librist was loaded from, which is where a failure to interoperate starts. */
	get libristPath() {
		return getLibrist().path;
	}
}
