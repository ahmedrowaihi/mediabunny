/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// RIST Simple Profile (VSF TR-06-1) on the send side, the counterpart to RistSource. node-av's FFmpeg
// has no librist - `rist://` is AVERROR_PROTOCOL_NOT_FOUND - so this speaks the protocol directly, as
// the reader already does: RTP on the URL's even port, RTCP on the next, and a retransmit buffer that
// answers the NACKs a receiver sends for what it did not get.

import { AppendOnlyStreamTarget } from 'mediabunny';
import { createSocket, type Socket } from 'node:dgram';
import { DEFAULT_MAX_QUEUE_BYTES, checkUrlAndOptions, positive } from './misc';

const RTP_VERSION = 2;
const RTP_HEADER_SIZE = 12;
/** MP2T, the payload type RFC 3551 assigns an MPEG-TS stream. */
const RTP_PAYLOAD_TYPE = 33;
/** 7 MPEG-TS packets, which is what a RIST datagram carries. */
const PAYLOAD_SIZE = 1316;
const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const MPEG_TS_CLOCK = 90_000;

const RTCP_RTPFB = 205;
const RTPFB_GENERIC_NACK = 1;
const RTCP_APP = 204;
/** 'RIST', the APP name TR-06-1 puts on its range NACK. */
const RIST_APP_NAME = 0x52495354;

/** How long a sent packet is kept for retransmission. A receiver asks within its own buffer. */
const DEFAULT_RETRANSMIT_BUFFER_MS = 1_000;

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
	 *
	 * A caller sends RTP straight to the URL's address. A listener binds those ports and sends to
	 * whichever address its first RTCP arrives from, which is how a receiver behind NAT is reached.
	 */
	mode?: 'listener' | 'caller';
	/**
	 * **Milliseconds** of sent packets kept for retransmission. Defaults to 1000, matching
	 * `RistSource`'s own buffer: a receiver cannot ask for what it has already given up on.
	 */
	retransmitBufferMs?: number;
	/** Bytes to queue before the target blocks the writer, or drops. Defaults to 2 MiB. */
	maxQueueBytes?: number;
	/**
	 * What to do once {@link RistTargetOptions.maxQueueBytes} is reached: `'block'` (the default) makes
	 * the writer wait for the socket to catch up, `'drop'` discards the write and counts it.
	 *
	 * Blocking is right for a relay, where losing bytes is worse than arriving late. Dropping is right
	 * for a live encode that must not be stalled by a slow receiver, and is what
	 * {@link RistTarget.droppedBytes} counts.
	 */
	onOverflow?: 'block' | 'drop';
	/**
	 * Send at the rate the stream itself states, read from the MPEG-TS PCR. On by default, and inert on
	 * a payload carrying no PCR — there is then no rate to pace to, and the bytes go out as fast as the
	 * socket takes them.
	 *
	 * An unpaced sender hands a whole segment to the kernel at once, which a receiver absorbs out of its
	 * de-jitter buffer or not at all.
	 */
	pacing?: boolean;
};

type Sent = { seq: number; datagram: Buffer; at: number };

/**
 * The PCR of the last MPEG-TS packet in `payload` that carries one, in 90 kHz ticks.
 *
 * The program clock reference is what states a transport stream's own rate, so it is what a sender paces
 * to (RFC 2250). It rides the adaptation field, which only some packets have, so a null here means this
 * datagram said nothing about time - not that the stream has no rate.
 */
const pcrOf = (payload: Uint8Array): number | null => {
	let found: number | null = null;

	for (let at = 0; at + TS_PACKET_SIZE <= payload.byteLength; at += TS_PACKET_SIZE) {
		if (payload[at] !== TS_SYNC_BYTE) {
			return found;
		}
		// adaptation_field_control: 2 means adaptation field only, 3 means field then payload
		const control = (payload[at + 3]! >> 4) & 0x3;
		if (control !== 2 && control !== 3) {
			continue;
		}
		const fieldLength = payload[at + 4]!;
		if (fieldLength < 7 || !(payload[at + 5]! & 0x10)) {
			continue; // No PCR_flag, so no program_clock_reference_base to read
		}

		// 33-bit base at 90 kHz, then 6 reserved bits and a 9-bit 27 MHz extension this does not need
		const base = payload[at + 6]! * 2 ** 25
			+ payload[at + 7]! * 2 ** 17
			+ payload[at + 8]! * 2 ** 9
			+ payload[at + 9]! * 2
			+ ((payload[at + 10]! >> 7) & 0x1);
		found = base;
	}

	return found;
};

/** Owns the two sockets, the sequence numbering and the retransmit buffer. */
class RistSink {
	readonly writable: WritableStream<Uint8Array>;

	private media: Socket | undefined;
	private control: Socket | undefined;
	private opening: Promise<void> | null = null;
	private failure: Error | null = null;
	private closed = false;

	private readonly partial = new Uint8Array(PAYLOAD_SIZE);
	private partialLength = 0;
	private queue: Uint8Array[] = [];
	queuedBytes = 0;
	private pumping: Promise<void> | null = null;

	/** Sent packets, oldest first, kept until they age out of the buffer window. */
	private history: Sent[] = [];
	private sequence = Math.floor(Math.random() * 0x10000);
	private readonly ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
	private peer: { address: string; port: number } | null = null;
	private startedAt = 0;

	sentPackets = 0;
	retransmittedPackets = 0;
	sentBytes = 0;
	droppedBytes = 0;
	droppedDatagrams = 0;

	/** Resolved every time a datagram leaves the queue, which is what a blocked writer waits on. */
	private drainWaiters: (() => void)[] = [];
	/** Media time of the last PCR seen, and the wall clock the stream started at, in 90 kHz ticks. */
	private mediaClock: number | null = null;
	private mediaStart: number | null = null;
	private wallStart = 0;

	constructor(
		private readonly host: string,
		private readonly mediaPort: number,
		private readonly mode: 'listener' | 'caller',
		private readonly retransmitBufferMs: number,
		readonly maxQueueBytes: number,
		private readonly onOverflow: 'block' | 'drop',
		private readonly pacing: boolean,
	) {
		this.writable = new WritableStream<Uint8Array>({
			write: chunk => this.enqueue(chunk),
			close: () => this.finish(),
			abort: () => this.finish(),
		});
	}

	private async open() {
		const media = createSocket({ type: 'udp4', reuseAddr: true });
		const control = createSocket({ type: 'udp4', reuseAddr: true });
		this.media = media;
		this.control = control;

		control.on('message', (message, from) => this.onControl(message, from));
		// A socket error is reported on the next write rather than thrown at the event loop
		const record = (error: Error) => {
			this.failure ??= error;
		};
		media.on('error', record);
		control.on('error', record);

		if (this.mode === 'listener') {
			// Bound, and the peer is learned from whichever address its RTCP arrives from
			await Promise.all([
				new Promise<void>(resolve => media.bind(this.mediaPort, resolve)),
				new Promise<void>(resolve => control.bind(this.mediaPort + 1, resolve)),
			]);
		} else {
			this.peer = { address: this.host, port: this.mediaPort };
			// An ephemeral pair, so the receiver's RTCP has somewhere to answer
			await Promise.all([
				new Promise<void>(resolve => media.bind(0, resolve)),
				new Promise<void>(resolve => control.bind(0, resolve)),
			]);
		}

		this.startedAt = Date.now();
	}

	/** Answers a NACK by resending what is still in the buffer, and learns the peer from its address. */
	private onControl(message: Buffer, from: { address: string; port: number }) {
		this.peer ??= { address: from.address, port: this.mediaPort };

		let offset = 0;
		while (offset + 4 <= message.length) {
			const packetType = message[offset + 1]!;
			const words = (message[offset + 2]! << 8) | message[offset + 3]!;
			const end = offset + (words + 1) * 4;
			if (end > message.length) {
				return;
			}

			if (packetType === RTCP_RTPFB && (message[offset]! & 0x1f) === RTPFB_GENERIC_NACK) {
				// RFC 4585: a feedback block is the lost sequence number plus a bitmask of the 16 after it
				for (let at = offset + 12; at + 4 <= end; at += 4) {
					const pid = (message[at]! << 8) | message[at + 1]!;
					const blp = (message[at + 2]! << 8) | message[at + 3]!;
					this.resend(pid);
					for (let bit = 0; bit < 16; bit++) {
						if (blp & (1 << bit)) {
							this.resend((pid + bit + 1) & 0xffff);
						}
					}
				}
			} else if (packetType === RTCP_APP && end >= offset + 12) {
				const name = ((message[offset + 8]! << 24) | (message[offset + 9]! << 16)
					| (message[offset + 10]! << 8) | message[offset + 11]!) >>> 0;
				if (name === RIST_APP_NAME) {
					// TR-06-1's range NACK: a start sequence and how many after it are missing
					for (let at = offset + 12; at + 4 <= end; at += 4) {
						const start = (message[at]! << 8) | message[at + 1]!;
						const extra = (message[at + 2]! << 8) | message[at + 3]!;
						for (let i = 0; i <= extra; i++) {
							this.resend((start + i) & 0xffff);
						}
					}
				}
			}

			offset = end;
		}
	}

	private resend(seq: number) {
		const held = this.history.find(entry => entry.seq === seq);
		if (held === undefined || this.peer === null || this.media === undefined) {
			return;
		}

		// A failed retransmission is not fatal: the receiver asks again while the packet is still held
		void this.handOff(held.datagram, this.peer.port, this.peer.address).catch(() => {});
		this.retransmittedPackets++;
	}

	private async enqueue(chunk: Uint8Array): Promise<void> {
		const pending = this.failure;
		if (pending) {
			throw pending;
		}

		if (this.queuedBytes + chunk.byteLength > this.maxQueueBytes && this.onOverflow === 'drop') {
			this.droppedBytes += chunk.byteLength;
			this.droppedDatagrams += Math.ceil(chunk.byteLength / PAYLOAD_SIZE);
			return;
		}

		this.queue.push(chunk);
		this.queuedBytes += chunk.byteLength;
		void this.kick();

		// Returning a pending promise is how a WritableStream applies backpressure, so the writer waits
		// here until the socket has taken enough for the queue to be under its bound again
		while (this.queuedBytes > this.maxQueueBytes && this.failure === null && !this.closed) {
			await new Promise<void>(resolve => this.drainWaiters.push(resolve));
		}

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}

	/** Wakes every writer blocked on the queue; called whenever bytes leave it. */
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

	/**
	 * Holds a datagram back until the stream's own clock says it is due, so a segment leaves at its
	 * media rate rather than at line rate.
	 */
	private async waitUntilDue(payload: Uint8Array) {
		if (!this.pacing) {
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
			return; // Nothing has stated a time yet, so nothing is overdue
		}

		const dueAt = this.wallStart + (this.mediaClock - this.mediaStart) / 90;
		const wait = dueAt - Date.now();
		if (wait > 1) {
			await new Promise(resolve => setTimeout(resolve, wait));
		}
	}

	/** Resolves once the datagram is handed to the OS, so a send error is raised rather than dropped. */
	private handOff(datagram: Buffer, port: number, address: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.media!.send(datagram, port, address, error => error ? reject(error) : resolve());
		});
	}

	/** Builds the RTP header for the next datagram and sends it. */
	private async sendPayload(payload: Uint8Array) {
		await this.waitUntilDue(payload);

		// Counted down here rather than when a chunk is dequeued: one `_flush` can hand over a whole
		// segment, and the bytes of it still waiting for a datagram are every bit as queued
		this.queuedBytes -= payload.byteLength;
		this.drained();

		const datagram = Buffer.allocUnsafe(RTP_HEADER_SIZE + payload.byteLength);
		const seq = this.sequence;
		this.sequence = (this.sequence + 1) & 0xffff;
		// The stream's own 90 kHz clock where it states one, and wall clock where it does not
		const timestamp = this.mediaClock !== null
			? this.mediaClock >>> 0
			: Math.round((Date.now() - this.startedAt) * (MPEG_TS_CLOCK / 1000)) >>> 0;

		datagram[0] = RTP_VERSION << 6;
		datagram[1] = RTP_PAYLOAD_TYPE;
		datagram.writeUInt16BE(seq, 2);
		datagram.writeUInt32BE(timestamp, 4);
		datagram.writeUInt32BE(this.ssrc, 8);
		datagram.set(payload, RTP_HEADER_SIZE);

		// Held before the send, so a NACK arriving mid-flight is answerable for this packet too
		const now = Date.now();
		this.history.push({ seq, datagram, at: now });

		if (this.peer !== null) {
			// Awaited: this is what makes the queue a queue, so a caller can see it filling rather than
			// only the drops afterwards, and it is where a send error surfaces
			await this.handOff(datagram, this.peer.port, this.peer.address);
			this.sentPackets++;
			this.sentBytes += payload.byteLength;
		}

		// Aged out rather than counted: a receiver asks within its own buffer and never beyond it
		while (this.history.length > 0 && now - this.history[0]!.at > this.retransmitBufferMs) {
			this.history.shift();
		}
	}

	private async pump() {
		try {
			if (this.media === undefined) {
				this.opening ??= this.open();
				await this.opening;
			}

			while (this.queue.length > 0) {
				const chunk = this.queue.shift()!;

				// Filled to exactly PAYLOAD_SIZE so each datagram carries whole TS packets
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

	/**
	 * Sends whatever is short of a full datagram now, instead of holding it for the bytes that would fill
	 * it. Waits for the pump first, since the buffer is mid-fill while one is running.
	 */
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

		// Copied and the length cleared before the await: the buffer is shared with the next pump
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
			// A short final datagram, which is how a stream not a multiple of the payload size ends.
			// Awaited, or the sockets below can close before it reaches the OS.
			await this.sendPayload(this.partial.subarray(0, this.partialLength)).catch(() => {});
			this.partialLength = 0;
		}

		// Held briefly so a receiver's last NACK can still be answered from the buffer
		await new Promise(resolve => setTimeout(resolve, Math.min(this.retransmitBufferMs, 250)));

		this.media?.close();
		this.control?.close();

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}
}

/**
 * An {@link https://mediabunny.dev/guide/writing-media-files#target | output target} that sends MPEG-TS
 * over RIST Simple Profile (VSF TR-06-1), the counterpart to {@link RistSource}.
 *
 * RTP goes to the URL's even port and RTCP is read on the next one, where a receiver's NACKs arrive; a
 * packet asked for is resent from a buffer of what was recently sent. The protocol is spoken directly
 * rather than through FFmpeg, which has no librist in this build.
 *
 * A byte sink, so the format decides what travels — for a live feed, `MpegTsOutputFormat`. Like
 * {@link SrtTarget} it drops rather than blocking: past
 * {@link RistTargetOptions.maxQueueBytes} the arriving bytes are dropped and counted.
 *
 * @example
 * ```ts
 * const output = new Output({
 * 	format: new MpegTsOutputFormat(),
 * 	target: new RistTarget('rist://receiver:9000'),
 * });
 * ```
 *
 * Speaks **Simple Profile** only. `@mediabunny/rist` has a `RistTarget` of the same name over librist
 * which defaults to main profile, supports encryption, and leaves the send queue to librist — the two
 * are not interchangeable.
 *
 * @group \@mediabunny/server
 * @public
 */
export class RistTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private readonly sink: RistSink;

	constructor(url: string, options: RistTargetOptions = {}) {
		checkUrlAndOptions(url, options);
		if (options.mode !== undefined && options.mode !== 'listener' && options.mode !== 'caller') {
			throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
		}
		positive(options.retransmitBufferMs, 'retransmitBufferMs');

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new TypeError(`RistTarget: ${JSON.stringify(url)} is not a URL.`);
		}
		if (parsed.protocol !== 'rist:') {
			throw new TypeError(`RistTarget: ${JSON.stringify(url)} is not a rist:// URL.`);
		}

		const port = Number(parsed.port);
		if (!Number.isInteger(port) || port <= 0 || port % 2 !== 0) {
			// TR-06-1 puts RTP on an even port and RTCP on the odd one above it
			throw new TypeError('RistTarget: the URL needs an even port, with RTCP on the one above it.');
		}
		if (
			options.maxQueueBytes !== undefined
			&& (!Number.isInteger(options.maxQueueBytes) || options.maxQueueBytes < PAYLOAD_SIZE)
		) {
			throw new TypeError(
				`options.maxQueueBytes, when provided, must be an integer of at least ${PAYLOAD_SIZE}.`,
			);
		}

		const sink = new RistSink(
			parsed.hostname,
			port,
			options.mode ?? 'caller',
			options.retransmitBufferMs ?? DEFAULT_RETRANSMIT_BUFFER_MS,
			options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
			options.onOverflow ?? 'block',
			options.pacing ?? true,
		);
		super(sink.writable);
		this.sink = sink;
	}

	/**
	 * Sends what is short of a full datagram now rather than waiting for the bytes that would fill it,
	 * the counterpart of {@link SrtTarget.flushPartialDatagram} — see there for the trade.
	 */
	async flushPartialDatagram(): Promise<void> {
		await this.sink.flushPartial();
	}

	/** RTP packets sent, not counting retransmissions. */
	get sentPackets(): number {
		return this.sink.sentPackets;
	}

	/** Packets sent again because a receiver asked for them. */
	get retransmittedPackets(): number {
		return this.sink.retransmittedPackets;
	}

	/** Payload bytes handed to the socket so far, not counting retransmissions. */
	get sentBytes(): number {
		return this.sink.sentBytes;
	}

	/**
	 * Bytes accepted but not yet handed to the socket, against the bound stated by
	 * {@link RistTarget.maxQueueBytes}. This is the headroom a caller has before anything is dropped,
	 * which is the only way to see it coming rather than after.
	 *
	 * Counted down per datagram rather than per chunk handed in, so it means bytes not yet on the wire
	 * rather than chunks not yet picked up. It reads 0 whenever the sender is keeping up, which on a
	 * healthy path is most of the time, and rises when a producer outruns the socket.
	 */
	get queuedBytes(): number {
		return this.sink.queuedBytes;
	}

	/** The bound {@link RistTarget.queuedBytes} is held against, from the options or the default. */
	get maxQueueBytes(): number {
		return this.sink.maxQueueBytes;
	}

	/**
	 * Bytes dropped because the queue was full. Not a count of what failed to arrive, and 0 unless
	 * `onOverflow: 'drop'` was asked for — the default blocks the writer instead.
	 */
	get droppedBytes(): number {
		return this.sink.droppedBytes;
	}

	/** Datagrams' worth of dropped bytes, which is the unit a receiver sees missing. */
	get droppedDatagrams(): number {
		return this.sink.droppedDatagrams;
	}
}
