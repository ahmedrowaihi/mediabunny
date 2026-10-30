/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MalformedInputError } from '../errors';
import {
	MPEG_TS_TIMESCALE,
	PAT_PID,
	REGISTRATION_DESCRIPTOR_TAG,
	TIMESTAMP_MODULUS,
	TS_PACKET_SIZE,
} from './mpeg-ts-misc';

const SYNC_BYTE = 0x47;
const SPLICE_INFO_TABLE_ID = 0xfc;
/** 'CUEI', the registration that tells SCTE-35 apart from the Blu-ray meaning of stream type 0x86. */
const CUEI_FORMAT_IDENTIFIER = 0x43554549;
const SCTE35_STREAM_TYPE = 0x86;

/** `time_signal` and `splice_insert`, the two commands that carry a splice time. */
const SPLICE_INSERT = 0x05;

// SCTE 35 9.7.3 order: out_of_network 0x80, program_splice 0x40, duration 0x20, splice_immediate 0x10
const PROGRAM_SPLICE_FLAG = 0x40;
const SPLICE_IMMEDIATE_FLAG = 0x10;
const TIME_SIGNAL = 0x06;

/**
 * A `splice_info_section` read out of an MPEG-TS stream, as defined by SCTE 35.
 *
 * @group Miscellaneous
 * @public
 */
export type Scte35Section = {
	/** The complete section, from `table_id` through its CRC, ready to pass on verbatim. */
	section: Uint8Array;
	/**
	 * The splice point in seconds on the stream's own 90 kHz timeline — `pts_adjustment` plus the
	 * command's `splice_time`, wrapped into the 33-bit range as the stream states it.
	 *
	 * `null` when the command states no time: a `splice_null` heartbeat, a cancelled insert, or a
	 * `splice_insert` with `splice_immediate_flag` set, which means "now" rather than a stated point.
	 */
	time: number | null;
	/** `splice_command_type`, so a caller can tell a `time_signal` from an insert without reparsing. */
	commandType: number;
	/** The section's `pts_adjustment`, in 90 kHz ticks. */
	ptsAdjustment: number;
};

type SectionAssembly = {
	bytes: number[];
	remaining: number;
};

const readU16 = (bytes: Uint8Array, offset: number) => (bytes[offset]! << 8) | bytes[offset + 1]!;

const readU32 = (bytes: Uint8Array, offset: number) =>
	((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

/** A 33-bit timestamp split across a flag byte and four more, as SCTE 35 writes both of its times. */
const read33Bits = (bytes: Uint8Array, offset: number, lowBitsOfFirstByte: number) => {
	const high = bytes[offset]! & ((1 << lowBitsOfFirstByte) - 1);
	return high * 2 ** 32 + readU32(bytes, offset + 1);
};

/**
 * Pull the SCTE-35 `splice_info_section`s out of MPEG-TS bytes, with the splice time each one states.
 *
 * The PID is found from the program map rather than assumed: stream type `0x86` means SCTE-35 only when
 * the elementary stream carries a `CUEI` registration descriptor, and means DTS-HD Master Audio
 * otherwise, so a stream without that descriptor yields nothing.
 *
 * Sections are reassembled across packets, and a section still incomplete at the end of the buffer is
 * dropped rather than returned half-read. Pass whole packets; a buffer that does not start on a sync
 * byte is searched for the first one.
 *
 * @group Miscellaneous
 * @public
 */
export const readScte35Sections = (bytes: Uint8Array): Scte35Section[] => {
	const sections: Scte35Section[] = [];
	let pmtPid: number | null = null;
	let scte35Pid: number | null = null;
	const assembly = new Map<number, SectionAssembly>();

	let start = 0;
	while (start < bytes.length && bytes[start] !== SYNC_BYTE) {
		start++;
	}

	for (let offset = start; offset + TS_PACKET_SIZE <= bytes.length; offset += TS_PACKET_SIZE) {
		if (bytes[offset] !== SYNC_BYTE) {
			break; // Lost alignment; the rest cannot be trusted to be packets.
		}

		const pid = readU16(bytes, offset + 1) & 0x1fff;
		const payloadUnitStart = (bytes[offset + 1]! & 0x40) !== 0;
		const hasAdaptation = (bytes[offset + 3]! & 0x20) !== 0;
		const hasPayload = (bytes[offset + 3]! & 0x10) !== 0;
		if (!hasPayload) {
			continue;
		}

		let payloadStart = offset + 4;
		if (hasAdaptation) {
			payloadStart += 1 + bytes[payloadStart]!;
		}
		if (payloadStart >= offset + TS_PACKET_SIZE) {
			continue;
		}

		if (pid === PAT_PID) {
			pmtPid ??= readPmtPidFromPat(bytes, payloadStart, offset + TS_PACKET_SIZE, payloadUnitStart);
			continue;
		}

		if (pmtPid !== null && pid === pmtPid) {
			scte35Pid ??= readScte35PidFromPmt(bytes, payloadStart, offset + TS_PACKET_SIZE, payloadUnitStart);
			continue;
		}

		if (scte35Pid === null || pid !== scte35Pid) {
			continue;
		}

		collectSection(bytes, payloadStart, offset + TS_PACKET_SIZE, payloadUnitStart, pid, assembly, sections);
	}

	return sections;
};

const sectionStart = (bytes: Uint8Array, payloadStart: number, payloadEnd: number) => {
	// A section payload opens with a pointer_field naming how many bytes of a previous section precede it.
	const pointerField = bytes[payloadStart]!;
	const start = payloadStart + 1 + pointerField;
	return start < payloadEnd ? start : null;
};

const readPmtPidFromPat = (
	bytes: Uint8Array,
	payloadStart: number,
	payloadEnd: number,
	payloadUnitStart: boolean,
) => {
	if (!payloadUnitStart) {
		return null;
	}

	const start = sectionStart(bytes, payloadStart, payloadEnd);
	if (start === null || start + 12 > payloadEnd) {
		return null;
	}

	// Skip the 8-byte section header, then read program_number / program_map_PID pairs.
	for (let pos = start + 8; pos + 4 <= payloadEnd; pos += 4) {
		const programNumber = readU16(bytes, pos);
		const pid = readU16(bytes, pos + 2) & 0x1fff;
		if (programNumber !== 0) {
			return pid;
		}
	}

	return null;
};

const readScte35PidFromPmt = (
	bytes: Uint8Array,
	payloadStart: number,
	payloadEnd: number,
	payloadUnitStart: boolean,
) => {
	if (!payloadUnitStart) {
		return null;
	}

	const start = sectionStart(bytes, payloadStart, payloadEnd);
	if (start === null || start + 12 > payloadEnd) {
		return null;
	}

	const sectionLength = readU16(bytes, start + 1) & 0x0fff;
	const sectionEnd = Math.min(start + 3 + sectionLength, payloadEnd);
	const programInfoLength = readU16(bytes, start + 10) & 0x0fff;
	let pos = start + 12 + programInfoLength;

	// Four bytes of CRC close the section; an entry needs five bytes plus its descriptors.
	while (pos + 5 <= sectionEnd - 4) {
		const streamType = bytes[pos]!;
		const pid = readU16(bytes, pos + 1) & 0x1fff;
		const esInfoLength = readU16(bytes, pos + 3) & 0x0fff;
		const descriptorsEnd = Math.min(pos + 5 + esInfoLength, sectionEnd);

		if (streamType === SCTE35_STREAM_TYPE) {
			for (let d = pos + 5; d + 2 <= descriptorsEnd;) {
				const tag = bytes[d]!;
				const length = bytes[d + 1]!;
				if (
					tag === REGISTRATION_DESCRIPTOR_TAG
					&& length >= 4
					&& d + 6 <= descriptorsEnd
					&& readU32(bytes, d + 2) === CUEI_FORMAT_IDENTIFIER
				) {
					return pid;
				}
				d += 2 + length;
			}
		}

		pos = descriptorsEnd;
	}

	return null;
};

const collectSection = (
	bytes: Uint8Array,
	payloadStart: number,
	payloadEnd: number,
	payloadUnitStart: boolean,
	pid: number,
	assembly: Map<number, SectionAssembly>,
	out: Scte35Section[],
) => {
	let pos = payloadStart;

	if (payloadUnitStart) {
		const start = sectionStart(bytes, payloadStart, payloadEnd);
		if (start === null) {
			return;
		}
		if (bytes[start] !== SPLICE_INFO_TABLE_ID) {
			assembly.delete(pid);
			return;
		}
		if (start + 3 > payloadEnd) {
			return;
		}

		const sectionLength = readU16(bytes, start + 1) & 0x0fff;
		assembly.set(pid, { bytes: [], remaining: 3 + sectionLength });
		pos = start;
	}

	const pending = assembly.get(pid);
	if (!pending) {
		return;
	}

	const take = Math.min(pending.remaining, payloadEnd - pos);
	for (let i = 0; i < take; i++) {
		pending.bytes.push(bytes[pos + i]!);
	}
	pending.remaining -= take;

	if (pending.remaining === 0) {
		assembly.delete(pid);
		out.push(parseSpliceInfoSection(Uint8Array.from(pending.bytes)));
	}
};

/**
 * Read the header and splice time of a `splice_info_section`. The command bodies beyond the splice time
 * are left to the caller, which is why the whole section is handed back untouched.
 *
 * @group Miscellaneous
 * @public
 */
export const parseSpliceInfoSection = (section: Uint8Array): Scte35Section => {
	if (section.length < 14) {
		throw new MalformedInputError('SCTE-35 section is too short to hold its header.');
	}
	if (section[0] !== SPLICE_INFO_TABLE_ID) {
		throw new MalformedInputError(
			`SCTE-35 section states table_id 0x${section[0]!.toString(16)}, expected 0xfc.`,
		);
	}

	const ptsAdjustment = read33Bits(section, 4, 1);
	const encrypted = (section[4]! & 0x80) !== 0;
	const commandLength = readU16(section, 11) & 0x0fff;
	const commandType = section[13]!;
	let commandPos = 14;

	const wrap = (ticks: number) => (ticks % TIMESTAMP_MODULUS) / MPEG_TS_TIMESCALE;
	const noTime = { section, time: null, commandType, ptsAdjustment };

	// An encrypted section hides everything past pts_adjustment, so no time can be read from it.
	if (encrypted || commandLength === 0) {
		return noTime;
	}

	if (commandType === TIME_SIGNAL) {
		if (commandPos >= section.length) {
			return noTime;
		}
		const timeSpecified = (section[commandPos]! & 0x80) !== 0;
		if (!timeSpecified || commandPos + 5 > section.length) {
			return noTime;
		}
		return { section, time: wrap(ptsAdjustment + read33Bits(section, commandPos, 1)), commandType, ptsAdjustment };
	}

	if (commandType !== SPLICE_INSERT) {
		return noTime;
	}

	commandPos += 4; // splice_event_id
	if (commandPos >= section.length) {
		return noTime;
	}
	if ((section[commandPos]! & 0x80) !== 0) {
		return noTime; // splice_event_cancel_indicator: nothing follows
	}
	commandPos += 1;
	if (commandPos >= section.length) {
		return noTime;
	}

	const flags = section[commandPos]!;
	const programSplice = (flags & PROGRAM_SPLICE_FLAG) !== 0;
	const spliceImmediate = (flags & SPLICE_IMMEDIATE_FLAG) !== 0;
	commandPos += 1;

	// splice_immediate_flag means "now", and a non-program splice states a time per component instead.
	if (spliceImmediate || !programSplice) {
		return noTime;
	}
	if (commandPos >= section.length) {
		return noTime;
	}

	const timeSpecified = (section[commandPos]! & 0x80) !== 0;
	if (!timeSpecified || commandPos + 5 > section.length) {
		return noTime;
	}

	return { section, time: wrap(ptsAdjustment + read33Bits(section, commandPos, 1)), commandType, ptsAdjustment };
};
