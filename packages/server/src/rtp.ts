/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** @internal */
export const RTP_VERSION = 2;
/** @internal */
export const RTP_HEADER_SIZE = 12;
/** MP2T, the payload type RFC 3551 assigns an MPEG-TS stream. @internal */
export const RTP_PAYLOAD_TYPE_MP2T = 33;

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

/** Signed 16-bit distance, so a comparison still holds across the 65535 to 0 wrap. @internal */
export const seqDistance = (a: number, b: number) => (((a - b) & 0xffff) ^ 0x8000) - 0x8000;

/** @internal */
export type RtpPacket = { seq: number; ssrc: number; payload: Uint8Array };

/**
 * Reads one RTP packet, returning its payload with the header, the CSRC list, the extension and any
 * padding taken off. Null for anything that is not a parseable RTP packet.
 *
 * @internal
 */
export const parseRtp = (bytes: Uint8Array): RtpPacket | null => {
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

/**
 * The PCR of the last MPEG-TS packet in `payload` that carries one, in 90 kHz ticks.
 *
 * The program clock reference is what states a transport stream's own rate, so it is what a sender
 * paces to (RFC 2250). It rides the adaptation field, which only some packets have, so a null here
 * means this datagram said nothing about time — not that the stream has no rate.
 *
 * @internal
 */
export const pcrOf = (payload: Uint8Array): number | null => {
	let found: number | null = null;

	for (let at = 0; at + TS_PACKET_SIZE <= payload.byteLength; at += TS_PACKET_SIZE) {
		if (payload[at] !== TS_SYNC_BYTE) {
			return found;
		}
		const control = (payload[at + 3]! >> 4) & 0x3;
		if (control !== 2 && control !== 3) {
			continue;
		}
		const fieldLength = payload[at + 4]!;
		if (fieldLength < 7 || !(payload[at + 5]! & 0x10)) {
			continue; // No PCR_flag, so no program_clock_reference_base to read
		}

		// 33-bit base at 90 kHz, then 6 reserved bits and a 9-bit 27 MHz extension this does not need
		found = payload[at + 6]! * 2 ** 25
			+ payload[at + 7]! * 2 ** 17
			+ payload[at + 8]! * 2 ** 9
			+ payload[at + 9]! * 2
			+ ((payload[at + 10]! >> 7) & 0x1);
	}

	return found;
};

/**
 * Whether these bytes are RTCP rather than RTP, by RFC 5761 §4: RTCP packet types 192 and 200-207 land
 * in the 7-bit field RTP reads as its payload type as 64-71 and 72-79, and RTP must not use those. This
 * is the only way to tell the two apart when they share one stream, which is what FFmpeg's `rtp://`
 * hands over - the RTCP it reads from the odd port arrives interleaved with the media.
 *
 * @internal
 */
export const isRtcp = (bytes: Uint8Array) => {
	if (bytes.length < 2) {
		return false;
	}

	const payloadType = bytes[1]! & 0x7f;
	return payloadType >= 64 && payloadType <= 79;
};

/**
 * How many out-of-order packets are held before a missing one is given up on. Network reordering is a
 * handful of packets; this is not a recovery window, because RTP alone has nothing to recover with -
 * MPEG-TS over RTP (RFC 2250) carries no retransmission, and FEC is the sender's and the host's.
 */
const REORDER_WINDOW = 16;

/**
 * Turns a stream of RTP datagrams into the payload stream they carry, in sequence order. RTCP is
 * dropped, and so is anything that does not parse.
 *
 * A gap stays a gap: once {@link REORDER_WINDOW} packets are waiting behind a missing one, it is
 * written off and the stream resumes at the lowest sequence number held. Nothing is fabricated to
 * fill it, because a TS reader resynchronises on the next sync byte and a made-up packet would not
 * let it.
 *
 * @internal
 */
export class RtpDepacketizer {
	private buffered = new Map<number, Uint8Array>();
	private expected: number | null = null;

	/** The payloads now ready to go on, in order. Empty while a packet is held for the ones before it. */
	push(datagram: Uint8Array): Uint8Array[] {
		if (isRtcp(datagram)) {
			return [];
		}

		const packet = parseRtp(datagram);
		if (!packet) {
			return [];
		}

		this.expected ??= packet.seq;

		if (seqDistance(packet.seq, this.expected) < 0 || this.buffered.has(packet.seq)) {
			return [];
		}

		this.buffered.set(packet.seq, packet.payload);

		const ready: Uint8Array[] = [];
		for (;;) {
			const next = this.buffered.get(this.expected);
			if (next) {
				this.buffered.delete(this.expected);
				this.expected = (this.expected + 1) & 0xffff;
				ready.push(next);
				continue;
			}

			if (this.buffered.size <= REORDER_WINDOW) {
				return ready;
			}

			let lowest: number | null = null;
			for (const seq of this.buffered.keys()) {
				if (lowest === null || seqDistance(seq, lowest) < 0) {
					lowest = seq;
				}
			}
			this.expected = lowest!;
		}
	}
}
