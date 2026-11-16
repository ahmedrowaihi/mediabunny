/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Field widths here come from ETSI EN 300 468 V1.20.1: the teletext_descriptor of 6.2.43 (tag 0x56,
// five bytes per entry) and the subtitling_descriptor of 6.2.41 (tag 0x59, eight bytes per entry).
// Both ride on stream type 0x06, so the descriptor is the only thing that tells them apart.

import { MPEG_TS_TIMESCALE, PAT_PID, TIMESTAMP_MODULUS, TS_PACKET_SIZE } from './mpeg-ts-misc';

const SYNC_BYTE = 0x47;
const TELETEXT_DESCRIPTOR_TAG = 0x56;
const SUBTITLING_DESCRIPTOR_TAG = 0x59;
const PRIVATE_DATA_STREAM_TYPE = 0x06;
const TELETEXT_ENTRY_SIZE = 5;
const SUBTITLING_ENTRY_SIZE = 8;

const readU16 = (bytes: Uint8Array, offset: number) => (bytes[offset]! << 8) | bytes[offset + 1]!;

const language = (bytes: Uint8Array, offset: number) =>
	String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!);

/**
 * One entry of a `teletext_descriptor` (ETSI EN 300 468 6.2.43).
 *
 * @group Miscellaneous
 * @public
 */
export type TeletextPage = {
	/** `ISO_639_language_code`, three characters. */
	language: string;
	/** `teletext_type`, 5 bits. 0x02 is a subtitle page and 0x05 one for the hearing impaired. */
	type: number;
	/** `teletext_magazine_number`, 3 bits. Magazine 0 stands for magazine 8. */
	magazine: number;
	/**
	 * The page as a viewer states it — magazine 8, page 0x88 is 888. The descriptor carries the page as
	 * two hex digits, so a decimal reading of the raw byte would be wrong.
	 */
	page: number;
};

/**
 * One entry of a `subtitling_descriptor` (ETSI EN 300 468 6.2.41).
 *
 * @group Miscellaneous
 * @public
 */
export type DvbSubtitleStream = {
	/** `ISO_639_language_code`, three characters. */
	language: string;
	/** `subtitling_type`, coded as `component_type` for `stream_content` 0x03 — 0x20 and up is HoH. */
	type: number;
	/** `composition_page_id`, the page whose segments carry the subtitles. */
	compositionPageId: number;
	/** `ancillary_page_id`, equal to the composition page when there is no ancillary one. */
	ancillaryPageId: number;
};

/**
 * A private elementary stream an MPEG-TS programme carries, as its PMT declares it.
 *
 * @group Miscellaneous
 * @public
 */
export type MpegTsPrivateStream = {
	/** The PID its PES packets are on. */
	pid: number;
	/** `stream_type` from the PMT, 0x06 for both of these. */
	streamType: number;
	/** Present when the stream carries a `teletext_descriptor`, one entry per page it declares. */
	teletext?: TeletextPage[];
	/** Present when the stream carries a `subtitling_descriptor`, one entry per subtitle stream. */
	subtitles?: DvbSubtitleStream[];
};

/**
 * A PES payload read off a private stream, with the time the PES header states for it.
 *
 * @group Miscellaneous
 * @public
 */
export type PrivatePesPayload = {
	/** The PID it came from. */
	pid: number;
	/** The PES `PTS` in seconds on the stream's 90 kHz clock, or null when the header states none. */
	time: number | null;
	/** The PES packet's payload, after its header — the bytes EN 300 472 or EN 300 743 describes. */
	data: Uint8Array;
};

type Packet = {
	pid: number;
	payloadUnitStart: boolean;
	payloadStart: number;
	payloadEnd: number;
};

/** Walks the 188-byte packets, yielding each one's payload range. Shared by both readers below. */
const iteratePackets = function* (bytes: Uint8Array): Generator<Packet> {
	for (let offset = 0; offset + TS_PACKET_SIZE <= bytes.length; offset += TS_PACKET_SIZE) {
		if (bytes[offset] !== SYNC_BYTE) {
			continue;
		}

		const pid = readU16(bytes, offset + 1) & 0x1fff;
		const payloadUnitStart = (bytes[offset + 1]! & 0x40) !== 0;
		const adaptationFieldControl = (bytes[offset + 3]! >> 4) & 0x3;
		if ((adaptationFieldControl & 0x1) === 0) {
			continue; // adaptation field only, no payload
		}

		let payloadStart = offset + 4;
		if (adaptationFieldControl === 0x3) {
			payloadStart += 1 + bytes[offset + 4]!;
		}
		if (payloadStart >= offset + TS_PACKET_SIZE) {
			continue;
		}

		yield { pid, payloadUnitStart, payloadStart, payloadEnd: offset + TS_PACKET_SIZE };
	}
};

/** The section's first byte, past the pointer_field a payload-unit-start packet opens with. */
const sectionStart = (bytes: Uint8Array, payloadStart: number, payloadEnd: number) => {
	const pointer = bytes[payloadStart]!;
	const start = payloadStart + 1 + pointer;
	return start < payloadEnd ? start : null;
};

const readTeletextEntries = (bytes: Uint8Array, start: number, end: number): TeletextPage[] => {
	const pages: TeletextPage[] = [];

	for (let at = start; at + TELETEXT_ENTRY_SIZE <= end; at += TELETEXT_ENTRY_SIZE) {
		const packed = bytes[at + 3]!;
		const magazine = packed & 0x7;
		const page = bytes[at + 4]!;
		pages.push({
			language: language(bytes, at),
			type: (packed >> 3) & 0x1f,
			magazine,
			// Two hex digits for the page, and magazine 0 means 8, so 888 reads back as 888
			page: (magazine === 0 ? 8 : magazine) * 100 + (page >> 4) * 10 + (page & 0xf),
		});
	}

	return pages;
};

const readSubtitlingEntries = (bytes: Uint8Array, start: number, end: number): DvbSubtitleStream[] => {
	const streams: DvbSubtitleStream[] = [];

	for (let at = start; at + SUBTITLING_ENTRY_SIZE <= end; at += SUBTITLING_ENTRY_SIZE) {
		streams.push({
			language: language(bytes, at),
			type: bytes[at + 3]!,
			compositionPageId: readU16(bytes, at + 4),
			ancillaryPageId: readU16(bytes, at + 6),
		});
	}

	return streams;
};

const pmtPidFromPat = (bytes: Uint8Array, packet: Packet): number | null => {
	const start = sectionStart(bytes, packet.payloadStart, packet.payloadEnd);
	if (start === null || start + 12 > packet.payloadEnd) {
		return null;
	}

	for (let pos = start + 8; pos + 4 <= packet.payloadEnd; pos += 4) {
		if (readU16(bytes, pos) !== 0) {
			return readU16(bytes, pos + 2) & 0x1fff;
		}
	}

	return null;
};

const privateStreamsFromPmt = (bytes: Uint8Array, packet: Packet): MpegTsPrivateStream[] => {
	const start = sectionStart(bytes, packet.payloadStart, packet.payloadEnd);
	if (start === null || start + 12 > packet.payloadEnd) {
		return [];
	}

	const sectionLength = readU16(bytes, start + 1) & 0x0fff;
	const sectionEnd = Math.min(start + 3 + sectionLength, packet.payloadEnd);
	const programInfoLength = readU16(bytes, start + 10) & 0x0fff;
	const out: MpegTsPrivateStream[] = [];
	let pos = start + 12 + programInfoLength;

	// Four bytes of CRC close the section; an entry needs five bytes plus its descriptors
	while (pos + 5 <= sectionEnd - 4) {
		const streamType = bytes[pos]!;
		const pid = readU16(bytes, pos + 1) & 0x1fff;
		const esInfoLength = readU16(bytes, pos + 3) & 0x0fff;
		const descriptorsEnd = Math.min(pos + 5 + esInfoLength, sectionEnd);

		if (streamType === PRIVATE_DATA_STREAM_TYPE) {
			const stream: MpegTsPrivateStream = { pid, streamType };

			for (let d = pos + 5; d + 2 <= descriptorsEnd;) {
				const tag = bytes[d]!;
				const length = bytes[d + 1]!;
				const end = Math.min(d + 2 + length, descriptorsEnd);

				if (tag === TELETEXT_DESCRIPTOR_TAG) {
					stream.teletext = readTeletextEntries(bytes, d + 2, end);
				} else if (tag === SUBTITLING_DESCRIPTOR_TAG) {
					stream.subtitles = readSubtitlingEntries(bytes, d + 2, end);
				}

				d += 2 + length;
			}

			if (stream.teletext || stream.subtitles) {
				out.push(stream);
			}
		}

		pos = descriptorsEnd;
	}

	return out;
};

/**
 * The teletext and DVB subtitle streams an MPEG-TS programme declares, read straight out of its PMT.
 *
 * Both ride on stream type 0x06, so a stream is identified by the descriptor it carries rather than by
 * its type: a `teletext_descriptor` (tag 0x56) or a `subtitling_descriptor` (tag 0x59). A stream with
 * neither is not returned, since nothing distinguishes it from any other private data.
 *
 * Reads only what fits a single PMT packet, which is where a programme of this size puts it.
 *
 * @group Miscellaneous
 * @public
 */
export const readMpegTsPrivateStreams = (bytes: Uint8Array): MpegTsPrivateStream[] => {
	let pmtPid: number | null = null;
	const found = new Map<number, MpegTsPrivateStream>();

	for (const packet of iteratePackets(bytes)) {
		if (!packet.payloadUnitStart) {
			continue;
		}

		if (packet.pid === PAT_PID) {
			pmtPid ??= pmtPidFromPat(bytes, packet);
		} else if (pmtPid !== null && packet.pid === pmtPid) {
			for (const stream of privateStreamsFromPmt(bytes, packet)) {
				found.set(stream.pid, stream);
			}
		}
	}

	return [...found.values()];
};

/** Reads a 33-bit PTS out of the five bytes PES states it in (13818-1 2.4.3.7). */
const readPts = (bytes: Uint8Array, at: number) => {
	const high = (bytes[at]! >> 1) & 0x7;
	const mid = ((bytes[at + 1]! << 8) | bytes[at + 2]!) >>> 1;
	const low = ((bytes[at + 3]! << 8) | bytes[at + 4]!) >>> 1;
	return high * 2 ** 30 + mid * 2 ** 15 + low;
};

/**
 * The PES payloads a private stream carries, with the time each PES header states.
 *
 * The payload is handed back as it arrived — the `data_identifier`/`data_unit` framing of EN 300 472
 * for teletext, or the segments of EN 300 743 for DVB subtitles — so a caller parses what it needs
 * without this having to understand either.
 *
 * A packet whose header states no PTS yields `time: null` rather than being dropped: teletext in
 * particular often omits it, and discarding those payloads would lose cues.
 *
 * **Every payload returned is complete.** A PES is emitted once its `PES_packet_length` has arrived, or,
 * where that field is 0 and the packet is therefore unbounded, once the next `payload_unit_start_indicator`
 * on the PID ends it. A packet the buffer cuts short is left out rather than returned short, because a
 * reader scanning a sliding window cuts the last one every time and a half payload is indistinguishable
 * from a whole one — teletext carries no end marker to check. The consequence to know: in a stream whose
 * private PES states length 0, the final packet is never returned, since nothing says it ended.
 *
 * @param bytes - A transport stream, 188-byte packets.
 * @param pid - The PID to read, as {@link readMpegTsPrivateStreams} reports it.
 *
 * @group Miscellaneous
 * @public
 */
export const readPrivatePesPayloads = (bytes: Uint8Array, pid: number): PrivatePesPayload[] => {
	const out: PrivatePesPayload[] = [];
	// `expected` is the payload length the PES header stated, or null where it stated 0 and the packet
	// therefore runs until the next one starts
	let current: { time: number | null; chunks: number[]; expected: number | null } | null = null;

	/**
	 * Emits the packet being assembled, but only if it is whole: a stated length that has arrived, or an
	 * unstated one that the next unit start has just ended. Anything else is a packet the buffer cut.
	 */
	const finish = (atUnitStart: boolean) => {
		if (current === null) {
			current = null;
			return;
		}

		const { time, chunks, expected } = current;
		current = null;

		if (expected === null) {
			if (atUnitStart && chunks.length > 0) {
				out.push({ pid, time, data: new Uint8Array(chunks) });
			}
			return;
		}

		if (chunks.length >= expected) {
			// Trimmed to the stated length: what follows it on this PID belongs to no packet
			out.push({ pid, time, data: new Uint8Array(chunks.slice(0, expected)) });
		}
	};

	for (const packet of iteratePackets(bytes)) {
		if (packet.pid !== pid) {
			continue;
		}

		if (packet.payloadUnitStart) {
			finish(true);

			const at = packet.payloadStart;
			// packet_start_code_prefix 0x000001, then stream_id; anything else is not a PES packet
			if (at + 9 > packet.payloadEnd || bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 1) {
				continue;
			}

			const headerLength = bytes[at + 8]!;
			const payloadStart = at + 9 + headerLength;
			if (payloadStart > packet.payloadEnd) {
				continue;
			}

			// PES_packet_length counts everything after itself: 2 flag bytes, the header length byte, the
			// header, then the payload. 0 is 13818-1's "unbounded", which only the next unit start ends.
			const packetLength = (bytes[at + 4]! << 8) | bytes[at + 5]!;
			const expected = packetLength === 0 ? null : packetLength - 3 - headerLength;
			if (expected !== null && expected < 0) {
				continue; // A length that cannot hold its own header describes no packet
			}

			const ptsPresent = (bytes[at + 7]! & 0x80) !== 0;
			const time = ptsPresent && at + 14 <= packet.payloadEnd
				? (readPts(bytes, at + 9) % TIMESTAMP_MODULUS) / MPEG_TS_TIMESCALE
				: null;

			current = { time, chunks: [], expected };
			for (let i = payloadStart; i < packet.payloadEnd; i++) {
				current.chunks.push(bytes[i]!);
			}
		} else if (current !== null) {
			for (let i = packet.payloadStart; i < packet.payloadEnd; i++) {
				current.chunks.push(bytes[i]!);
			}
		}
	}

	// Not a unit start: a packet still open at the end of the buffer was cut by it, not finished
	finish(false);

	return out;
};
