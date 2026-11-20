/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AppendOnlyStreamTarget } from 'mediabunny';
import { parseUrls, positive, type ResolvedPeer } from './rist-peer';
import { RistPath, type PathAddress } from './rist-transport';
import { buildSenderReport, requestedSequences } from './rist-rtcp';
import { pcrOf, RTP_HEADER_SIZE, RTP_PAYLOAD_TYPE_MP2T, RTP_VERSION } from './rtp';

/** 7 MPEG-TS packets, the payload a RIST datagram carries. */
const PAYLOAD_SIZE = 1316;
const MPEG_TS_CLOCK = 90_000;
const DEFAULT_RETRANSMIT_BUFFER_MS = 1_000;
const DEFAULT_MAX_QUEUE_BYTES = 2 * 1024 * 1024;
/** TR-06-1 §5.2 caps the gap between compound RTCP packets at 100 ms. */
const RTCP_INTERVAL_MS = 100;
/**
 * A receiver holds every data packet until a compound carrying SDES has identified the flow, so the
 * first payload has to wait for that compound to land. Without this the opening datagrams are dropped
 * and the stream starts short - which looks like loss and is not.
 */
const HANDSHAKE_SETTLE_MS = 250;

/**
 * Options for {@link RistTarget}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type RistTargetOptions = {
	/**
	 * Whether to send to a receiver that is listening (`'caller'`, the default) or to bind the URL's
	 * ports and wait for one to announce itself (`'listener'`).
	 */
	mode?: 'listener' | 'caller';
	/**
	 * Which RIST profile to speak. Defaults to `'simple'`, which is what MediaConnect speaks. librist's own tools
	 * default to main.
	 *
	 * **Both ends must agree.** A profile disagreement does not fail loudly: a main-profile receiver
	 * reads simple-profile RTP as non-conformant and delivers nothing.
	 *
	 * Encryption needs main profile. Simple profile has no key exchange at all, so a secret with
	 * `'simple'` throws rather than appearing to protect the stream.
	 */
	profile?: 'simple' | 'main';
	/** **Milliseconds** of sent packets kept for retransmission. Defaults to 1000. */
	retransmitBufferMs?: number;
	/** Pre-shared passphrase for main-profile encryption. Must match the receiver's. */
	secret?: string;
	/** AES key length to use with {@link RistTargetOptions.secret}. Defaults to 256. */
	aesType?: 128 | 256;
	/** Bytes to queue before the target blocks the writer, or drops. Defaults to 2 MiB. */
	maxQueueBytes?: number;
	/**
	 * What to do once {@link RistTargetOptions.maxQueueBytes} is reached: `'block'` (the default) makes
	 * the writer wait, `'drop'` discards the write and counts it in {@link RistTarget.droppedBytes}.
	 */
	onOverflow?: 'block' | 'drop';
	/**
	 * Send at the rate the stream itself states, read from the MPEG-TS PCR. On by default, and inert on
	 * a payload carrying no PCR.
	 */
	pacing?: boolean;
};

type Sent = { seq: number; payload: Uint8Array; timestamp: number; at: number };

type Resolved = ResolvedPeer & {
	retransmitBufferMs: number;
	maxQueueBytes: number;
	onOverflow: 'block' | 'drop';
	pacing: boolean;
};

/**
 * Cuts the byte stream into RIST payloads, numbers them once for every path, and answers the NACKs
 * that come back. The sequence numbering is shared across paths on purpose: that is what lets a
 * receiver merge several paths into one stream (TR-06-1 §5.4).
 */
class RistSink {
	readonly writable: WritableStream<Uint8Array>;

	private readonly paths: RistPath[] = [];
	private opening: Promise<void> | null = null;
	private failure: Error | null = null;
	private closed = false;
	private rtcpTimer: ReturnType<typeof setInterval> | undefined;

	private readonly partial = new Uint8Array(PAYLOAD_SIZE);
	private partialLength = 0;
	private queue: Uint8Array[] = [];
	private pumping: Promise<void> | null = null;
	private drainWaiters: (() => void)[] = [];

	private history: Sent[] = [];
	private sequence = Math.floor(Math.random() * 0x10000);
	/** LSB 0 marks an original packet; a retransmission sets it (TR-06-1 §5.3.2). */
	private readonly ssrc = (Math.floor(Math.random() * 0xffffffff) & ~1) >>> 0;
	private readonly cname = new TextEncoder().encode('mediabunny');
	private startedAt = 0;
	private nextPath = 0;

	private mediaClock: number | null = null;
	private mediaStart: number | null = null;
	private wallStart = 0;

	queuedBytes = 0;
	sentPackets = 0;
	sentBytes = 0;
	retransmittedPackets = 0;
	droppedBytes = 0;
	droppedDatagrams = 0;

	constructor(
		private readonly urls: { host: string; port: number }[],
		private readonly options: Resolved,
	) {
		this.writable = new WritableStream<Uint8Array>({
			write: chunk => this.enqueue(chunk),
			close: () => this.finish(),
			abort: () => this.finish(),
		});
	}

	get maxQueueBytes() {
		return this.options.maxQueueBytes;
	}

	private async open() {
		for (const { host, port } of this.urls) {
			const path = new RistPath({
				profile: this.options.profile,
				mode: this.options.mode,
				host,
				port,
				secret: this.options.secret,
				aesType: this.options.aesType ?? 256,
				onMedia: () => {
					// A sender is not sent media; anything arriving on that port is not ours to read
				},
				onControl: (payload, from) => this.onControl(payload, from, path),
				onError: (error) => {
					this.failure ??= error;
				},
			});
			await path.open();
			this.paths.push(path);
		}

		this.startedAt = Date.now();
		this.sendReports();
		this.rtcpTimer = setInterval(() => this.sendReports(), RTCP_INTERVAL_MS);
		await new Promise(resolve => setTimeout(resolve, HANDSHAKE_SETTLE_MS));
	}

	/**
	 * The compound packet TR-06-1 §5.2.1 requires of a sender. It is also what opens a main-profile
	 * session: a receiver holds every data packet until it has seen the SDES on one of these.
	 */
	private sendReports() {
		const report = buildSenderReport(this.ssrc, this.cname, {
			packets: this.sentPackets,
			octets: this.sentBytes,
			rtpTimestamp: this.rtpTimestamp(),
		});

		for (const path of this.paths) {
			path.sendKeepalive();
			if (path.peer) {
				path.sendControl(report);
			}
		}
	}

	private onControl(payload: Uint8Array, from: PathAddress, path: RistPath) {
		path.peer ??= from;
		for (const seq of requestedSequences(payload)) {
			this.resend(seq, path);
		}
	}

	/**
	 * A retransmission carries the same sequence number and timestamp as the original and differs only
	 * in the SSRC's low bit, which is how a receiver tells the two apart (TR-06-1 §5.3.2).
	 */
	private resend(seq: number, path: RistPath) {
		const held = this.history.find(entry => entry.seq === seq);
		if (!held || !path.peer) {
			return;
		}

		path.sendMedia(this.datagram(held.seq, held.timestamp, held.payload, true));
		this.retransmittedPackets++;
	}

	private datagram(seq: number, timestamp: number, payload: Uint8Array, retransmission: boolean) {
		const bytes = new Uint8Array(RTP_HEADER_SIZE + payload.byteLength);
		bytes[0] = RTP_VERSION << 6;
		bytes[1] = RTP_PAYLOAD_TYPE_MP2T;
		bytes[2] = (seq >> 8) & 0xff;
		bytes[3] = seq & 0xff;
		bytes[4] = (timestamp >>> 24) & 0xff;
		bytes[5] = (timestamp >>> 16) & 0xff;
		bytes[6] = (timestamp >>> 8) & 0xff;
		bytes[7] = timestamp & 0xff;
		const ssrc = retransmission ? (this.ssrc | 1) >>> 0 : this.ssrc;
		bytes[8] = (ssrc >>> 24) & 0xff;
		bytes[9] = (ssrc >>> 16) & 0xff;
		bytes[10] = (ssrc >>> 8) & 0xff;
		bytes[11] = ssrc & 0xff;
		bytes.set(payload, RTP_HEADER_SIZE);
		return bytes;
	}

	private rtpTimestamp() {
		return this.mediaClock !== null
			? this.mediaClock >>> 0
			: Math.round((Date.now() - this.startedAt) * (MPEG_TS_CLOCK / 1000)) >>> 0;
	}

	private async enqueue(chunk: Uint8Array): Promise<void> {
		const pending = this.failure;
		if (pending) {
			throw pending;
		}

		if (this.queuedBytes + chunk.byteLength > this.options.maxQueueBytes && this.options.onOverflow === 'drop') {
			this.droppedBytes += chunk.byteLength;
			this.droppedDatagrams += Math.ceil(chunk.byteLength / PAYLOAD_SIZE);
			return;
		}

		this.queue.push(chunk);
		this.queuedBytes += chunk.byteLength;
		void this.kick();

		while (this.queuedBytes > this.options.maxQueueBytes && this.failure === null && !this.closed) {
			await new Promise<void>(resolve => this.drainWaiters.push(resolve));
		}

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}

	private drained() {
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	private kick(): Promise<void> {
		this.pumping ??= this.pump().finally(() => {
			this.pumping = null;
		});
		return this.pumping;
	}

	private async waitUntilDue(payload: Uint8Array) {
		if (!this.options.pacing) {
			return;
		}

		const pcr = pcrOf(payload);
		if (pcr !== null) {
			// A 33-bit counter wraps, and a jump backwards is a discontinuity either way: restart from it
			// rather than stalling for the rest of the wrap
			if (this.mediaStart === null || this.mediaClock === null || pcr < this.mediaClock) {
				this.mediaStart = pcr;
				this.wallStart = Date.now();
			}
			this.mediaClock = pcr;
		}

		if (this.mediaStart === null || this.mediaClock === null) {
			return;
		}

		const wait = this.wallStart + (this.mediaClock - this.mediaStart) / 90 - Date.now();
		if (wait > 1) {
			await new Promise(resolve => setTimeout(resolve, wait));
		}
	}

	/** Splits the stream across the paths, which is what bonding several links for bandwidth means. */
	private async sendPayload(payload: Uint8Array) {
		await this.waitUntilDue(payload);

		this.queuedBytes -= payload.byteLength;
		this.drained();

		const seq = this.sequence;
		this.sequence = (this.sequence + 1) & 0xffff;
		const timestamp = this.rtpTimestamp();
		const kept = payload.slice();

		const now = Date.now();
		this.history.push({ seq, payload: kept, timestamp, at: now });
		while (this.history.length > 0 && now - this.history[0]!.at > this.options.retransmitBufferMs) {
			this.history.shift();
		}

		const live = this.paths.filter(path => path.peer !== null);
		if (live.length === 0) {
			return;
		}

		const path = live[this.nextPath++ % live.length]!;
		path.sendMedia(this.datagram(seq, timestamp, kept, false));
		this.sentPackets++;
		this.sentBytes += kept.byteLength;
	}

	private async pump() {
		try {
			if (this.paths.length === 0) {
				this.opening ??= this.open();
				await this.opening;
			}

			while (this.queue.length > 0) {
				const chunk = this.queue.shift()!;
				let offset = 0;
				while (offset < chunk.byteLength) {
					const take = Math.min(PAYLOAD_SIZE - this.partialLength, chunk.byteLength - offset);
					this.partial.set(chunk.subarray(offset, offset + take), this.partialLength);
					this.partialLength += take;
					offset += take;

					if (this.partialLength === PAYLOAD_SIZE) {
						await this.sendPayload(this.partial);
						this.partialLength = 0;
					}
				}
			}
		} catch (error) {
			this.failure ??= error instanceof Error ? error : new Error(String(error));
			this.queue = [];
			this.queuedBytes = 0;
			this.drained();
		}
	}

	async flushPartial(): Promise<void> {
		if (this.closed) {
			return;
		}

		while (this.pumping !== null || this.queue.length > 0) {
			await this.kick().catch(() => {});
		}

		if (this.failure || this.partialLength === 0) {
			return;
		}

		const datagram = this.partial.slice(0, this.partialLength);
		this.partialLength = 0;
		await this.sendPayload(datagram);
	}

	private async finish() {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.drained();

		while (this.pumping !== null || this.queue.length > 0) {
			await this.kick().catch(() => {});
		}

		if (this.partialLength > 0 && this.failure === null) {
			await this.sendPayload(this.partial.subarray(0, this.partialLength)).catch(() => {});
			this.partialLength = 0;
		}

		// A receiver can still ask for the tail, and nothing answers once the sockets are gone
		await new Promise(resolve => setTimeout(resolve, Math.min(this.options.retransmitBufferMs, 250)));

		clearInterval(this.rtcpTimer);
		for (const path of this.paths) {
			path.close();
		}

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}
}

/**
 * An {@link https://mediabunny.dev/guide/writing-media-files#target | output target} that sends
 * MPEG-TS over RIST, the counterpart to {@link RistSource}.
 *
 * Speaks the protocol directly — Simple Profile (VSF TR-06-1) or Main Profile (TR-06-2) with its GRE
 * framing and AES encryption. There is no native library and nothing to install.
 *
 * Several URLs bond several links: the payloads are split across them under one sequence numbering, so
 * a receiver merges them back into one stream.
 *
 * @example
 * ```ts
 * const output = new Output({
 * 	format: new MpegTsOutputFormat(),
 * 	target: new RistTarget('rist://receiver:9000', { secret: 'a shared passphrase' }),
 * });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class RistTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private readonly sink: RistSink;

	constructor(url: string | string[], options: RistTargetOptions = {}) {
		const { urls, peer } = parseUrls(url, options, 'RistTarget');
		if (
			options.maxQueueBytes !== undefined
			&& (!Number.isInteger(options.maxQueueBytes) || options.maxQueueBytes < PAYLOAD_SIZE)
		) {
			throw new TypeError(
				`options.maxQueueBytes, when provided, must be an integer of at least ${PAYLOAD_SIZE}.`,
			);
		}
		if (options.onOverflow !== undefined && !['block', 'drop'].includes(options.onOverflow)) {
			throw new TypeError('options.onOverflow, when provided, must be \'block\' or \'drop\'.');
		}

		const sink = new RistSink(urls, {
			...peer,
			retransmitBufferMs: positive(
				options.retransmitBufferMs, 'retransmitBufferMs', DEFAULT_RETRANSMIT_BUFFER_MS,
			),
			maxQueueBytes: options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
			onOverflow: options.onOverflow ?? 'block',
			pacing: options.pacing ?? true,
		});
		super(sink.writable);
		this.sink = sink;
	}

	/** Sends what is short of a full datagram now rather than waiting for the bytes that would fill it. */
	async flushPartialDatagram(): Promise<void> {
		await this.sink.flushPartial();
	}

	/** RTP packets sent, not counting retransmissions. */
	get sentPackets(): number {
		return this.sink.sentPackets;
	}

	/** Payload bytes handed to a socket so far, not counting retransmissions. */
	get sentBytes(): number {
		return this.sink.sentBytes;
	}

	/** Packets sent again because a receiver asked for them. */
	get retransmittedPackets(): number {
		return this.sink.retransmittedPackets;
	}

	/** Bytes accepted but not yet handed to a socket, against {@link RistTarget.maxQueueBytes}. */
	get queuedBytes(): number {
		return this.sink.queuedBytes;
	}

	/** The bound {@link RistTarget.queuedBytes} is held against. */
	get maxQueueBytes(): number {
		return this.sink.maxQueueBytes;
	}

	/** Bytes dropped because the queue was full; 0 unless `onOverflow: 'drop'` was asked for. */
	get droppedBytes(): number {
		return this.sink.droppedBytes;
	}

	/** Datagrams' worth of dropped bytes, which is the unit a receiver sees missing. */
	get droppedDatagrams(): number {
		return this.sink.droppedDatagrams;
	}
}
