/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The RTCP subset TR-06-1 §5.2 requires, and the two NACK formats of §5.3.1. Both profiles use these
// unchanged: simple profile puts them on the odd port, main profile wraps them in GRE. librist will not
// deliver a main-profile stream until it has seen a compound packet carrying SDES, so the CNAME here is
// a handshake requirement, not decoration.

/** @internal */
export const RTCP_SR = 200;
/** @internal */
export const RTCP_RR = 201;
/** @internal */
export const RTCP_SDES = 202;
/** @internal */
export const RTCP_APP = 204;
/** @internal */
export const RTCP_RTPFB = 205;
/** @internal */
export const RTPFB_GENERIC_NACK = 1;

/** `RIST`, the APP name TR-06-1 §5.3.1.2 puts on its range NACK. */
const RIST_APP_NAME = 0x52495354;

const RTP_VERSION = 2;

const writeU32 = (bytes: Uint8Array, at: number, value: number) => {
	bytes[at] = (value >>> 24) & 0xff;
	bytes[at + 1] = (value >>> 16) & 0xff;
	bytes[at + 2] = (value >>> 8) & 0xff;
	bytes[at + 3] = value & 0xff;
};

const readU32 = (bytes: Uint8Array, at: number) =>
	((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const header = (bytes: Uint8Array, at: number, count: number, packetType: number, words: number) => {
	bytes[at] = (RTP_VERSION << 6) | count;
	bytes[at + 1] = packetType;
	bytes[at + 2] = (words >> 8) & 0xff;
	bytes[at + 3] = words & 0xff;
};

/** The SDES chunk is padded to a 32-bit boundary with at least one zero byte ending the item list. */
const sdesWords = (cname: Uint8Array) => Math.ceil((4 + 2 + cname.byteLength + 1) / 4);

const writeSdes = (bytes: Uint8Array, at: number, ssrc: number, cname: Uint8Array) => {
	header(bytes, at, 1, RTCP_SDES, sdesWords(cname));
	writeU32(bytes, at + 4, ssrc);
	bytes[at + 8] = 1; // CNAME
	bytes[at + 9] = cname.byteLength;
	bytes.set(cname, at + 10);
};

/** @internal */
export type ReceptionCounts = { highestSeq: number; lost: number; received: number };

/** @internal */
export type SenderCounts = { packets: number; octets: number; rtpTimestamp: number };

/**
 * A sender's compound packet: SR with no report blocks, then SDES with a CNAME.
 *
 * @internal
 */
export const buildSenderReport = (ssrc: number, cname: Uint8Array, counts: SenderCounts): Uint8Array => {
	const bytes = new Uint8Array(7 * 4 + (sdesWords(cname) + 1) * 4);

	header(bytes, 0, 0, RTCP_SR, 6);
	writeU32(bytes, 4, ssrc);

	// NTP epoch is 1900, 2208988800 seconds before the Unix one
	const now = Date.now();
	writeU32(bytes, 8, (Math.floor(now / 1000) + 2208988800) >>> 0);
	writeU32(bytes, 12, Math.floor(((now % 1000) / 1000) * 2 ** 32) >>> 0);
	writeU32(bytes, 16, counts.rtpTimestamp);
	writeU32(bytes, 20, counts.packets);
	writeU32(bytes, 24, counts.octets);

	writeSdes(bytes, 28, ssrc, cname);
	return bytes;
};

/**
 * A receiver's compound packet: an RR with one report block for the sender, or an empty RR while no
 * sender is known yet, then SDES with a CNAME.
 *
 * @internal
 */
export const buildReceiverReport = (
	ssrc: number,
	senderSsrc: number,
	cname: Uint8Array,
	counts: ReceptionCounts,
): Uint8Array => {
	const empty = senderSsrc === 0;
	const reportBytes = empty ? 2 * 4 : 8 * 4;
	const bytes = new Uint8Array(reportBytes + (sdesWords(cname) + 1) * 4);

	header(bytes, 0, empty ? 0 : 1, RTCP_RR, empty ? 1 : 7);
	writeU32(bytes, 4, ssrc);
	if (!empty) {
		writeU32(bytes, 8, senderSsrc);
		const expected = Math.max(1, counts.received + counts.lost);
		bytes[12] = Math.min(255, Math.round((counts.lost / expected) * 256));
		writeU32(bytes, 16, counts.lost & 0xffffff);
		writeU32(bytes, 20, counts.highestSeq);
	}

	writeSdes(bytes, reportBytes, ssrc, cname);
	return bytes;
};

/**
 * Both retransmission request formats in one compound packet: RFC 4585 generic NACKs and TR-06-1's
 * range NACK. A sender must support both and may implement either, so sending both costs one small
 * packet and removes the question of which the far end chose.
 *
 * @internal
 */
export const buildNacks = (ssrc: number, senderSsrc: number, missing: number[]): Uint8Array => {
	const ranges: { start: number; extra: number }[] = [];
	for (const seq of missing) {
		const last = ranges[ranges.length - 1];
		if (last && seq === ((last.start + last.extra + 1) & 0xffff) && last.extra < 0xffff) {
			last.extra++;
		} else {
			ranges.push({ start: seq, extra: 0 });
		}
	}

	const genericWords = 2 + missing.length;
	const appWords = 2 + ranges.length;
	const bytes = new Uint8Array((genericWords + 1) * 4 + (appWords + 1) * 4);

	header(bytes, 0, RTPFB_GENERIC_NACK, RTCP_RTPFB, genericWords);
	writeU32(bytes, 4, ssrc);
	writeU32(bytes, 8, senderSsrc);
	missing.forEach((seq, i) => writeU32(bytes, 12 + i * 4, (seq << 16) >>> 0));

	const at = (genericWords + 1) * 4;
	header(bytes, at, 0, RTCP_APP, appWords);
	writeU32(bytes, at + 4, senderSsrc);
	writeU32(bytes, at + 8, RIST_APP_NAME);
	ranges.forEach(({ start, extra }, i) => writeU32(bytes, at + 12 + i * 4, ((start << 16) | extra) >>> 0));

	return bytes;
};

/** @internal */
export type RtcpPart = { packetType: number; count: number; start: number; end: number };

/**
 * Walks a compound packet. Stops at the first part whose stated length runs past the buffer, so a
 * truncated packet yields what was whole rather than throwing.
 *
 * @internal
 */
export const parseCompound = function* (bytes: Uint8Array): Generator<RtcpPart> {
	let at = 0;
	while (at + 4 <= bytes.byteLength) {
		const words = (bytes[at + 2]! << 8) | bytes[at + 3]!;
		const end = at + (words + 1) * 4;
		if (end > bytes.byteLength) {
			return;
		}
		yield { packetType: bytes[at + 1]!, count: bytes[at]! & 0x1f, start: at, end };
		at = end;
	}
};

/**
 * The originating SSRC of the first SR or SDES in a compound packet, which is how a receiver learns
 * which stream it is being sent.
 *
 * @internal
 */
export const senderSsrcOf = (bytes: Uint8Array): number | null => {
	for (const part of parseCompound(bytes)) {
		if ((part.packetType === RTCP_SR || part.packetType === RTCP_SDES) && part.start + 8 <= bytes.byteLength) {
			return readU32(bytes, part.start + 4);
		}
	}
	return null;
};

/**
 * Every sequence number a compound packet asks to have resent, from either NACK format.
 *
 * @internal
 */
export const requestedSequences = (bytes: Uint8Array): number[] => {
	const wanted: number[] = [];

	for (const part of parseCompound(bytes)) {
		if (part.packetType === RTCP_RTPFB && part.count === RTPFB_GENERIC_NACK) {
			for (let at = part.start + 12; at + 4 <= part.end; at += 4) {
				const pid = (bytes[at]! << 8) | bytes[at + 1]!;
				const blp = (bytes[at + 2]! << 8) | bytes[at + 3]!;
				wanted.push(pid);
				for (let bit = 0; bit < 16; bit++) {
					if (blp & (1 << bit)) {
						wanted.push((pid + bit + 1) & 0xffff);
					}
				}
			}
		} else if (part.packetType === RTCP_APP && part.end >= part.start + 12) {
			if (readU32(bytes, part.start + 8) !== RIST_APP_NAME) {
				continue;
			}
			for (let at = part.start + 12; at + 4 <= part.end; at += 4) {
				const start = (bytes[at]! << 8) | bytes[at + 1]!;
				const extra = (bytes[at + 2]! << 8) | bytes[at + 3]!;
				for (let i = 0; i <= extra; i++) {
					wanted.push((start + i) & 0xffff);
				}
			}
		}
	}

	return wanted;
};
