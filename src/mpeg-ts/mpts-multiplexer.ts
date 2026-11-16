/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A multi-program transport stream is a remultiplex rather than a mux: every program arrives already
// packetized, and its PES payloads and per-PID continuity counters pass through byte for byte. Three
// things do change.
//
// 1. PIDs. Two independently produced programs both number their video 0x0100, so each program's
//    streams are moved onto a range of their own.
// 2. The tables. One PAT names every program in the multiplex; each program keeps a PMT of its own,
//    patched rather than rebuilt so that descriptors this library has no opinion about - AC-3, DVB
//    subtitling, SCTE-35 registration - survive.
// 3. The clocks. A PCR states the byte position the packet occupies in *its* stream, so it means
//    nothing here and is restated from this multiplex's own byte position. PTS and DTS shift by the
//    same constant, which is what keeps each program's decoder buffer delay (PTS - PCR) intact.
//
// Packets go out in the order their own PCRs date them, interpolated between PCRs by packet position,
// and the gaps are filled with null packets - so the output is constant bit rate by construction.

import { InvalidUsageError } from '../errors';
import { assert, modEuclid } from '../misc';
import { Reader } from '../reader';
import { Source } from '../source';
import { Target } from '../target';
import { Writer } from '../writer';
import {
	computeMpegTsCrc32,
	createTimestampWrapInfo,
	MPEG_TS_TIMESCALE,
	NULL_PACKET_PID,
	normalizeWrappedTimestamp,
	PAT_PID,
	TIMESTAMP_MODULUS,
	TS_PACKET_SIZE,
	type TimestampWrapInfo,
} from './mpeg-ts-misc';

const PCR_TIMESCALE = 27_000_000;
const PCR_MODULUS = TIMESTAMP_MODULUS * 300;
const SYNC_BYTE = 0x47;

const DEFAULT_PAT_INTERVAL = 0.1;
const DEFAULT_PMT_INTERVAL = 0.1;

/**
 * The output clock starts here rather than at zero: a program's first PTS can precede its first PCR -
 * a B-frame's presentation time, AAC priming - and would otherwise land below zero and wrap.
 */
const CLOCK_LEAD = 1;

/**
 * How far behind the output's byte clock a program's packets may fall before the rate is declared too
 * low. Half a second, matching what the single-program muxer allows a key frame to burst by.
 */
const LATE_ALLOWANCE = 0.5;

/** Elementary PIDs are handed out from here upwards, PMT PIDs from {@link PMT_PID_BASE}. */
const ES_PID_BASE = 0x0100;
const ES_PID_LIMIT = 0x0fff;
const PMT_PID_BASE = 0x1000;
const PMT_PID_LIMIT = 0x1ffe;

const READ_BLOCK = TS_PACKET_SIZE * 256;
const FLUSH_EVERY = TS_PACKET_SIZE * 1024;

/**
 * One program of the multiplex, read from a transport stream that carries it on its own.
 *
 * @public
 * @group Miscellaneous
 */
export type MptsProgram = {
	/**
	 * The transport stream carrying this program. It must hold exactly one program, be aligned to
	 * 188-byte packets, and state a PCR - which is everything {@link MpegTsOutputFormat} writes, and
	 * everything FFmpeg's `mpegts` muxer writes.
	 */
	source: Source;
	/**
	 * The `program_number` this program takes in the output's PAT, defaulting to its position in the
	 * list plus one. Numbers must be distinct, and 0 is reserved for the NIT.
	 */
	programNumber?: number;
};

/**
 * Options for {@link MptsMultiplexer}.
 *
 * @public
 * @group Miscellaneous
 */
export type MptsMultiplexerOptions = {
	/** The programs to carry, in the order the PAT lists them. At least one. */
	programs: MptsProgram[];
	/** Where the multiplex is written. */
	target: Target;
	/**
	 * Bits per second to write the multiplex at. Null packets fill whatever the programs do not, and
	 * every PCR is stamped from the byte position it ends up at, so the stream's own clock and its bit
	 * rate agree - as a cable, satellite or ASI path requires.
	 *
	 * Programs that together need more than this are refused rather than written over rate, naming the
	 * time it ran out and the rate it would have needed. A full T-STD buffer model (13818-1 Annex D) is
	 * **not** simulated, so a stream that passes here can still fail a conformance checker.
	 */
	muxRate: number;
	/** The `transport_stream_id` the PAT states, defaulting to 1. */
	transportStreamId?: number;
	/** Seconds between repeats of the PAT, defaulting to 0.1. `Infinity` writes it once at the start. */
	patInterval?: number;
	/** Seconds between repeats of every PMT, defaulting to 0.1. `Infinity` writes them once at the start. */
	pmtInterval?: number;
};

/**
 * What a program ended up as in the multiplex, which is what a manifest or an SDT would state.
 *
 * @public
 * @group Miscellaneous
 */
export type MptsProgramResult = {
	/** The `program_number` the PAT and this program's PMT state. */
	programNumber: number;
	/** The PID the program's PMT is written on. */
	pmtPid: number;
	/** The PID carrying this program's PCR. */
	pcrPid: number;
	/** Each of the program's elementary streams, as the output's PMT lists it. */
	streams: {
		/** The PID it takes in the multiplex. */
		pid: number;
		/** Its `stream_type`, carried over unread. */
		streamType: number;
		/** The PID it sat on in the stream it came from. */
		inputPid: number;
	}[];
};

const payloadOffsetOf = (packet: Uint8Array) => {
	const adaptationControl = (packet[3]! >> 4) & 0x3;
	if (adaptationControl === 1) {
		return 4;
	}
	if (adaptationControl === 2 || adaptationControl === 3) {
		return 5 + packet[4]!;
	}
	return TS_PACKET_SIZE; // no payload
};

const pidOf = (packet: Uint8Array) => ((packet[1]! & 0x1f) << 8) | packet[2]!;

const setPid = (packet: Uint8Array, pid: number) => {
	packet[1] = (packet[1]! & 0xe0) | ((pid >> 8) & 0x1f);
	packet[2] = pid & 0xff;
};

/** The 27 MHz PCR in this packet's adaptation field, or null when it carries none. */
const readPcr = (packet: Uint8Array) => {
	const adaptationControl = (packet[3]! >> 4) & 0x3;
	if (adaptationControl !== 2 && adaptationControl !== 3) {
		return null;
	}
	if (packet[4]! < 7 || !(packet[5]! & 0x10)) {
		return null;
	}

	// 33 bits of base, so this has to be arithmetic rather than shifts
	const base = packet[6]! * 2 ** 25
		+ packet[7]! * 2 ** 17
		+ packet[8]! * 2 ** 9
		+ packet[9]! * 2
		+ ((packet[10]! >> 7) & 0x1);
	const extension = ((packet[10]! & 0x1) << 8) | packet[11]!;

	return base * 300 + extension;
};

const writePcr = (packet: Uint8Array, pcr: number) => {
	const value = modEuclid(Math.round(pcr), PCR_MODULUS);
	const base = Math.floor(value / 300);
	const extension = value % 300;

	packet[6] = Math.floor(base / 2 ** 25) & 0xff;
	packet[7] = Math.floor(base / 2 ** 17) & 0xff;
	packet[8] = Math.floor(base / 2 ** 9) & 0xff;
	packet[9] = Math.floor(base / 2) & 0xff;
	packet[10] = ((base % 2) << 7) | 0x7e | ((extension >> 8) & 0x1); // 6 reserved bits, all set
	packet[11] = extension & 0xff;
};

const readPesTimestamp = (packet: Uint8Array, at: number) =>
	((packet[at]! >> 1) & 0x07) * 2 ** 30
	+ packet[at + 1]! * 2 ** 22
	+ ((packet[at + 2]! >> 1) & 0x7f) * 2 ** 15
	+ packet[at + 3]! * 2 ** 7
	+ (packet[at + 4]! >> 1);

/** Rewrites the value in place, leaving the leading 4-bit prefix - which says which field this is - alone. */
const writePesTimestamp = (packet: Uint8Array, at: number, timestamp: number) => {
	const value = modEuclid(Math.round(timestamp), TIMESTAMP_MODULUS);

	packet[at] = (packet[at]! & 0xf0) | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 0x1;
	packet[at + 1] = Math.floor(value / 2 ** 22) & 0xff;
	packet[at + 2] = (((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 0x1) & 0xff;
	packet[at + 3] = Math.floor(value / 2 ** 7) & 0xff;
	packet[at + 4] = ((value % 2 ** 7) << 1) | 0x1;
};

/**
 * Shifts this packet's PTS and DTS by `offset` 90 kHz ticks, if it starts a PES packet that states
 * them. The PES header is at most 19 bytes and a payload-unit-start packet has at least 184, so it is
 * never split; a packet that somehow splits it is left alone rather than half-rewritten.
 */
const shiftPesTimestamps = (packet: Uint8Array, offset: number) => {
	if (!(packet[1]! & 0x40)) {
		return; // not a payload_unit_start
	}

	const at = payloadOffsetOf(packet);
	if (at + 14 > TS_PACKET_SIZE) {
		return;
	}
	if (packet[at] !== 0x00 || packet[at + 1] !== 0x00 || packet[at + 2] !== 0x01) {
		return;
	}
	if ((packet[at + 6]! & 0xc0) !== 0x80) {
		return; // stream_id without the optional PES header: padding, private_stream_2, ECM, EMM
	}

	const flags = packet[at + 7]! & 0xc0;
	if (flags === 0) {
		return;
	}

	const ptsAt = at + 9;
	writePesTimestamp(packet, ptsAt, readPesTimestamp(packet, ptsAt) - offset);

	if (flags === 0xc0) {
		if (ptsAt + 10 > TS_PACKET_SIZE) {
			return;
		}
		writePesTimestamp(packet, ptsAt + 5, readPesTimestamp(packet, ptsAt + 5) - offset);
	}
};

/**
 * Reassembles PSI sections from the packets of one PID. A PMT with many streams or long descriptors
 * runs past the 184 bytes one packet carries, so taking only the first packet silently loses streams.
 */
class SectionAssembler {
	private buffer: Uint8Array | null = null;
	private have = 0;

	/** The completed section, or null while more packets are needed. */
	push(packet: Uint8Array): Uint8Array | null {
		let at = payloadOffsetOf(packet);
		if (at >= TS_PACKET_SIZE) {
			return null;
		}

		if (packet[1]! & 0x40) {
			at += 1 + packet[at]!; // pointer_field
			if (at + 3 > TS_PACKET_SIZE) {
				return null;
			}

			const sectionLength = ((packet[at + 1]! & 0x0f) << 8) | packet[at + 2]!;
			this.buffer = new Uint8Array(3 + sectionLength);
			this.have = 0;
		} else if (!this.buffer) {
			return null; // joined this section mid-way
		}

		const buffer = this.buffer;
		assert(buffer);

		const take = Math.min(buffer.length - this.have, TS_PACKET_SIZE - at);
		buffer.set(packet.subarray(at, at + take), this.have);
		this.have += take;

		if (this.have < buffer.length) {
			return null;
		}

		this.buffer = null;
		return buffer;
	}
}

type DatedPacket = {
	/** Seconds on the multiplex's timeline, this program's first PCR being zero. */
	time: number;
	bytes: Uint8Array;
	pid: number;
	/**
	 * Set on the packets no PCR could date - those before the program's first, and those after its last.
	 * They all carry the same time, so draining them takes output time while their time stands still,
	 * which is not the multiplex running behind and must not be read as it.
	 */
	undated?: boolean;
};

/** Reads one program's transport stream, handing out its media packets dated by its own PCR. */
class ProgramReader {
	readonly ready: DatedPacket[] = [];
	/** Input elementary PID to the PID it takes in the multiplex. */
	readonly pidMap = new Map<number, number>();
	readonly streamTypes = new Map<number, number>();

	outputPmtPid = -1;
	outputPcrPid = -1;
	inputPcrPid = -1;
	/** This program's PMT with its PIDs remapped, ready to be written as-is. */
	pmtSection: Uint8Array | null = null;
	/** 90 kHz ticks subtracted from every PTS and DTS, so the program's clock starts at {@link CLOCK_LEAD}. */
	timestampOffset = 0;
	/**
	 * Seconds between this program's own timeline and the output's, fixed when its first dated packet
	 * goes out. A program whose PCR starts late has data to send before its clock says anything, and the
	 * output time that takes is a constant it is behind by from then on - not the multiplex running
	 * behind, which is what {@link LATE_ALLOWANCE} is there to catch.
	 */
	scheduleOffset: number | null = null;

	private readonly reader: Reader;
	private readonly patAssembler = new SectionAssembler();
	private readonly pmtAssembler = new SectionAssembler();

	private pos = 0;
	private block: Uint8Array | null = null;
	private blockAt = 0;
	private atEof = false;

	private inputPmtPid = -1;
	private inputProgramNumber = -1;

	/** Read, but not datable until the PCR that bounds them arrives. */
	private pending: { bytes: Uint8Array; pid: number }[] = [];
	private firstPcr: number | null = null;
	private lastTime: number | null = null;
	private wrapInfo: TimestampWrapInfo | null = null;

	constructor(source: Source, readonly programNumber: number, readonly label: string) {
		this.reader = new Reader(source);
	}

	get done() {
		return this.atEof && this.ready.length === 0;
	}

	get head(): DatedPacket | null {
		return this.ready[0] ?? null;
	}

	shift() {
		const packet = this.ready.shift();
		assert(packet);
		return packet;
	}

	/** Reads until at least one dated packet is available, or the stream ends. */
	async fill() {
		while (this.ready.length === 0 && !this.atEof) {
			const packet = await this.nextPacket();
			if (!packet) {
				this.atEof = true;
				this.drainPending();
				break;
			}

			this.consume(packet);
		}
	}

	/** Everything the PMT declared, in the order the PMT listed it. */
	result(): MptsProgramResult {
		return {
			programNumber: this.programNumber,
			pmtPid: this.outputPmtPid,
			pcrPid: this.outputPcrPid,
			streams: [...this.pidMap].map(([inputPid, pid]) => ({
				pid,
				streamType: this.streamTypes.get(inputPid)!,
				inputPid,
			})),
		};
	}

	private async nextPacket(): Promise<Uint8Array | null> {
		if (!this.block || this.blockAt + TS_PACKET_SIZE > this.block.length) {
			const slice = await this.reader.requestSliceRange(this.pos, TS_PACKET_SIZE, READ_BLOCK);
			if (!slice) {
				return null;
			}

			// The slice is a view into the source's own buffer, which the next read may reuse
			const available = Math.floor((slice.end - slice.start) / TS_PACKET_SIZE) * TS_PACKET_SIZE;
			this.block = slice.bytes.slice(slice.bufferPos, slice.bufferPos + available);
			this.blockAt = 0;
			this.pos += available;
		}

		const packet = this.block.subarray(this.blockAt, this.blockAt + TS_PACKET_SIZE);
		this.blockAt += TS_PACKET_SIZE;

		if (packet[0] !== SYNC_BYTE) {
			throw new InvalidUsageError(
				`${this.label} is not aligned to 188-byte transport packets: the byte at`
				+ ` ${this.pos - (this.block.length - this.blockAt) - TS_PACKET_SIZE} is`
				+ ` 0x${packet[0]!.toString(16)} where a sync byte 0x47 was expected.`,
			);
		}

		return packet;
	}

	private consume(packet: Uint8Array) {
		const pid = pidOf(packet);

		if (pid === PAT_PID) {
			if (this.inputPmtPid < 0) {
				this.readPat(packet);
			}
			return;
		}
		if (pid === NULL_PACKET_PID) {
			return;
		}
		if (pid === this.inputPmtPid) {
			if (!this.pmtSection) {
				this.readPmt(packet);
			}
			return;
		}
		if (!this.pidMap.has(pid)) {
			return; // not a stream this program's PMT declares
		}

		const bytes = packet.slice();

		if (pid === this.inputPcrPid) {
			const pcr = readPcr(bytes);
			if (pcr !== null) {
				this.dateWithPcr(bytes, pid, pcr);
				return;
			}
		}

		this.pending.push({ bytes, pid });
	}

	private readPat(packet: Uint8Array) {
		const section = this.patAssembler.push(packet);
		if (!section || section[0] !== 0x00) {
			return;
		}

		const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!;
		const end = 3 + sectionLength - 4; // less the CRC

		const programs: { programNumber: number; pmtPid: number }[] = [];
		for (let at = 8; at + 4 <= end; at += 4) {
			const programNumber = (section[at]! << 8) | section[at + 1]!;
			if (programNumber === 0) {
				continue; // network_PID, not a program
			}
			programs.push({
				programNumber,
				pmtPid: ((section[at + 2]! & 0x1f) << 8) | section[at + 3]!,
			});
		}

		if (programs.length === 0) {
			throw new InvalidUsageError(`${this.label} has a PAT that names no program.`);
		}
		if (programs.length > 1) {
			throw new InvalidUsageError(
				`${this.label} carries ${programs.length} programs (${
					programs.map(x => x.programNumber).join(', ')
				}). Each program of the multiplex is read from a stream that carries it on its own.`,
			);
		}

		this.inputProgramNumber = programs[0]!.programNumber;
		this.inputPmtPid = programs[0]!.pmtPid;
	}

	private readPmt(packet: Uint8Array) {
		const section = this.pmtAssembler.push(packet);
		if (!section || section[0] !== 0x02) {
			return;
		}

		const programNumber = (section[3]! << 8) | section[4]!;
		if (programNumber !== this.inputProgramNumber) {
			return; // a PMT of another program sharing this PID
		}

		const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!;
		const end = 3 + sectionLength - 4;

		this.inputPcrPid = ((section[8]! & 0x1f) << 8) | section[9]!;

		const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
		let at = 12 + programInfoLength;
		while (at + 5 <= end) {
			const streamType = section[at]!;
			const esPid = ((section[at + 1]! & 0x1f) << 8) | section[at + 2]!;
			const esInfoLength = ((section[at + 3]! & 0x0f) << 8) | section[at + 4]!;

			this.streamTypes.set(esPid, streamType);
			this.pidMap.set(esPid, -1); // filled once the multiplex allocates PIDs

			at += 5 + esInfoLength;
		}

		if (this.pidMap.size === 0) {
			throw new InvalidUsageError(`${this.label} has a PMT that declares no elementary stream.`);
		}

		this.pmtSection = section;
	}

	/**
	 * Allocates this program's output PIDs and patches its PMT onto them. Called once, after the PMT
	 * has been read.
	 */
	assignPids(pmtPid: number, nextEsPid: () => number) {
		assert(this.pmtSection);

		this.outputPmtPid = pmtPid;
		for (const inputPid of this.pidMap.keys()) {
			this.pidMap.set(inputPid, nextEsPid());
		}

		const pcrOutputPid = this.pidMap.get(this.inputPcrPid);
		if (pcrOutputPid === undefined) {
			// 13818-1 allows a PCR on a PID of its own, carrying no elementary stream. Nothing in the
			// program's media then paces the clock, and this reads packets rather than producing them.
			throw new InvalidUsageError(
				`${this.label} states its PCR on PID 0x${this.inputPcrPid.toString(16)}, which carries none`
				+ ' of its elementary streams. A program whose PCR rides on a stream of its own cannot be'
				+ ' remultiplexed, since its packets have nothing to date them.',
			);
		}
		this.outputPcrPid = pcrOutputPid;

		const patched = this.pmtSection.slice();
		patched[3] = (this.programNumber >> 8) & 0xff;
		patched[4] = this.programNumber & 0xff;
		patched[8] = (patched[8]! & 0xe0) | ((this.outputPcrPid >> 8) & 0x1f);
		patched[9] = this.outputPcrPid & 0xff;

		const sectionLength = ((patched[1]! & 0x0f) << 8) | patched[2]!;
		const end = 3 + sectionLength - 4;
		const programInfoLength = ((patched[10]! & 0x0f) << 8) | patched[11]!;

		let at = 12 + programInfoLength;
		while (at + 5 <= end) {
			const inputPid = ((patched[at + 1]! & 0x1f) << 8) | patched[at + 2]!;
			const outputPid = this.pidMap.get(inputPid)!;
			patched[at + 1] = (patched[at + 1]! & 0xe0) | ((outputPid >> 8) & 0x1f);
			patched[at + 2] = outputPid & 0xff;

			at += 5 + (((patched[at + 3]! & 0x0f) << 8) | patched[at + 4]!);
		}

		const crc = computeMpegTsCrc32(patched.subarray(0, end));
		patched[end] = (crc >>> 24) & 0xff;
		patched[end + 1] = (crc >>> 16) & 0xff;
		patched[end + 2] = (crc >>> 8) & 0xff;
		patched[end + 3] = crc & 0xff;

		this.pmtSection = patched;
	}

	/** Has the PMT, so the PIDs and the PCR PID are known. */
	get described() {
		return this.pmtSection !== null;
	}

	/**
	 * Dates every packet since the previous PCR. A packet's time is interpolated by its position between
	 * the two PCRs that bound it, which is as much as the stream itself says about when it was meant to
	 * go out.
	 */
	private dateWithPcr(bytes: Uint8Array, pid: number, pcr: number) {
		if (this.firstPcr === null) {
			this.firstPcr = pcr;
			this.wrapInfo = createTimestampWrapInfo(Math.floor(pcr / 300));
			this.timestampOffset = Math.floor(pcr / 300) - CLOCK_LEAD * MPEG_TS_TIMESCALE;
			this.lastTime = 0;

			for (const packet of this.pending) {
				this.ready.push({ time: 0, bytes: packet.bytes, pid: packet.pid, undated: true });
			}
			this.pending.length = 0;
			this.ready.push({ time: 0, bytes, pid });
			return;
		}

		assert(this.wrapInfo !== null && this.lastTime !== null);
		const base = normalizeWrappedTimestamp(Math.floor(pcr / 300), this.wrapInfo);
		const seconds = (base * 300 + (pcr % 300) - this.firstPcr) / PCR_TIMESCALE;

		// A PCR that does not advance is a discontinuity the input did not flag. Holding the previous
		// time keeps the merge ordered; the packets simply bunch up at that instant.
		const time = Math.max(seconds, this.lastTime);
		const steps = this.pending.length + 1;

		for (let i = 0; i < this.pending.length; i++) {
			const packet = this.pending[i]!;
			this.ready.push({
				time: this.lastTime + (time - this.lastTime) * (i + 1) / steps,
				bytes: packet.bytes,
				pid: packet.pid,
			});
		}
		this.pending.length = 0;

		this.ready.push({ time, bytes, pid });
		this.lastTime = time;
	}

	/** At the end of the stream there is no following PCR to interpolate against. */
	private drainPending() {
		const time = this.lastTime ?? 0;
		for (const packet of this.pending) {
			this.ready.push({ time, bytes: packet.bytes, pid: packet.pid, undated: true });
		}
		this.pending.length = 0;
	}
}

const buildMultiProgramPat = (
	transportStreamId: number,
	programs: { programNumber: number; pmtPid: number }[],
) => {
	const sectionLength = 5 + 4 * programs.length + 4;
	const section = new Uint8Array(3 + sectionLength);

	section[0] = 0x00; // table_id
	section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f); // section_syntax_indicator=1, '0', reserved=11
	section[2] = sectionLength & 0xff;
	section[3] = (transportStreamId >> 8) & 0xff;
	section[4] = transportStreamId & 0xff;
	section[5] = 0xc1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number

	let at = 8;
	for (const program of programs) {
		section[at] = (program.programNumber >> 8) & 0xff;
		section[at + 1] = program.programNumber & 0xff;
		section[at + 2] = 0xe0 | ((program.pmtPid >> 8) & 0x1f); // reserved=111
		section[at + 3] = program.pmtPid & 0xff;
		at += 4;
	}

	const crc = computeMpegTsCrc32(section.subarray(0, at));
	section[at] = (crc >>> 24) & 0xff;
	section[at + 1] = (crc >>> 16) & 0xff;
	section[at + 2] = (crc >>> 8) & 0xff;
	section[at + 3] = crc & 0xff;

	return section;
};

/**
 * Combines several single-program transport streams into one multi-program transport stream, at a
 * constant bit rate.
 *
 * Each program keeps its own PMT and PCR, and its media passes through untouched: what changes is the
 * PID every stream sits on, the tables that name them, and the clocks, which are restated for this
 * multiplex's byte positions. This is the transport an MPTS contribution path carries - a cable or
 * satellite channel lineup, an ASI feed - where one stream holds several services.
 *
 * ```ts
 * const multiplexer = new MptsMultiplexer({
 *     programs: [{ source: hd }, { source: sd }, { source: radio }],
 *     target: new BufferTarget(),
 *     muxRate: 20_000_000,
 * });
 * await multiplexer.execute();
 * ```
 *
 * Statistical multiplexing - sharing the rate out between programs by how much each one needs - is a
 * decision for whatever produced the programs, since it can only be acted on by their encoders. This
 * class carries whatever rates it is given and refuses the ones that do not fit.
 *
 * @public
 * @group Miscellaneous
 */
export class MptsMultiplexer {
	/** @internal */
	private readonly readers: ProgramReader[];
	/** @internal */
	private readonly options: MptsMultiplexerOptions;
	/** @internal */
	private state: 'idle' | 'executing' | 'done' = 'idle';

	/** How many 188-byte packets have been written, null packets included. */
	packetCount = 0;
	/** How many of those were null packets, which is the rate the programs did not use. */
	nullPacketCount = 0;

	constructor(options: MptsMultiplexerOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Array.isArray(options.programs) || options.programs.length === 0) {
			throw new TypeError('options.programs must be a non-empty array.');
		}
		if (!(options.target instanceof Target)) {
			throw new TypeError('options.target must be a Target.');
		}
		if (!Number.isFinite(options.muxRate) || options.muxRate <= 0) {
			throw new TypeError('options.muxRate must be a positive number of bits per second.');
		}
		for (const name of ['transportStreamId'] as const) {
			const value = options[name];
			if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffff)) {
				throw new TypeError(`options.${name} must be an integer between 0 and 65535.`);
			}
		}
		for (const name of ['patInterval', 'pmtInterval'] as const) {
			const value = options[name];
			if (value !== undefined && !(value > 0)) {
				throw new TypeError(`options.${name} must be a positive number of seconds, or Infinity.`);
			}
		}

		const used = new Set<number>();
		this.readers = options.programs.map((program, index) => {
			if (!program || typeof program !== 'object') {
				throw new TypeError(`options.programs[${index}] must be an object.`);
			}
			if (!(program.source instanceof Source)) {
				throw new TypeError(`options.programs[${index}].source must be a Source.`);
			}

			const programNumber = program.programNumber ?? index + 1;
			if (!Number.isInteger(programNumber) || programNumber < 1 || programNumber > 0xffff) {
				throw new TypeError(
					`options.programs[${index}].programNumber must be an integer between 1 and 65535;`
					+ ' 0 is reserved for the network information table.',
				);
			}
			if (used.has(programNumber)) {
				throw new TypeError(
					`options.programs[${index}].programNumber is ${programNumber}, which another program`
					+ ' already uses. A receiver selects a program by this number, so they must be distinct.',
				);
			}
			used.add(programNumber);

			return new ProgramReader(program.source, programNumber, `options.programs[${index}].source`);
		});

		this.options = options;
	}

	/** What each program ended up as. Available once {@link MptsMultiplexer.execute} has resolved. */
	get programs(): MptsProgramResult[] {
		if (this.state !== 'done') {
			throw new Error('The programs are only known once execute() has resolved.');
		}
		return this.readers.map(reader => reader.result());
	}

	/** Writes the multiplex. Resolves once every program has ended and the target is finalized. */
	async execute() {
		if (this.state !== 'idle') {
			throw new Error('An MptsMultiplexer can only be executed once.');
		}
		this.state = 'executing';

		const { muxRate, target } = this.options;
		const transportStreamId = this.options.transportStreamId ?? 1;
		const patInterval = this.options.patInterval ?? DEFAULT_PAT_INTERVAL;
		const pmtInterval = this.options.pmtInterval ?? DEFAULT_PMT_INTERVAL;
		const packetDuration = TS_PACKET_SIZE * 8 / muxRate;

		// 1. Read each program far enough to know what it carries, then hand out the PIDs. Programs are
		// numbered and PID-ranged by their position in the list, so the layout is the caller's to predict.
		for (const reader of this.readers) {
			await reader.fill();
			if (!reader.described) {
				throw new InvalidUsageError(
					`${reader.label} ended before stating a PAT, a PMT and a PCR, so there is no program in`
					+ ' it to carry.',
				);
			}
		}

		let nextEsPid = ES_PID_BASE;
		this.readers.forEach((reader, index) => {
			const pmtPid = PMT_PID_BASE + index;
			if (pmtPid > PMT_PID_LIMIT) {
				throw new InvalidUsageError(`Too many programs to give each a PMT of its own (${index + 1}).`);
			}

			reader.assignPids(pmtPid, () => {
				if (nextEsPid > ES_PID_LIMIT) {
					throw new InvalidUsageError('Too many elementary streams across the programs to give each a PID.');
				}
				return nextEsPid++;
			});
		});

		const pat = buildMultiProgramPat(
			transportStreamId,
			this.readers.map(reader => ({ programNumber: reader.programNumber, pmtPid: reader.outputPmtPid })),
		);

		// 2. Merge, paced by the output's own byte clock.
		const writer = new Writer(target, true);
		writer.start();

		const continuityCounters = new Map<number, number>();
		const nullPacket = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
		nullPacket[0] = SYNC_BYTE;
		nullPacket[1] = (NULL_PACKET_PID >> 8) & 0x1f;
		nullPacket[2] = NULL_PACKET_PID & 0xff;
		nullPacket[3] = 0x10; // no adaptation field, payload only, continuity_counter=0

		const writePacket = (bytes: Uint8Array) => {
			writer.write(bytes);
			this.packetCount++;
		};

		/** A PSI section as TS packets, continuing the PID's own counter. */
		const writeSection = (pid: number, section: Uint8Array) => {
			let at = 0;
			let isFirst = true;

			while (at < section.length) {
				const pointerField = isFirst ? 1 : 0;
				const chunk = Math.min(184 - pointerField, section.length - at);
				const packet = new Uint8Array(TS_PACKET_SIZE).fill(0xff);

				const cc = ((continuityCounters.get(pid) ?? -1) + 1) & 0x0f;
				continuityCounters.set(pid, cc);

				packet[0] = SYNC_BYTE;
				packet[1] = (isFirst ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
				packet[2] = pid & 0xff;
				packet[3] = 0x10 | cc;
				if (isFirst) {
					packet[4] = 0x00; // pointer_field
				}
				packet.set(section.subarray(at, at + chunk), 4 + pointerField);

				writePacket(packet);
				at += chunk;
				isFirst = false;
			}
		};

		let lastPat: number | null = null;
		let lastPmt: number | null = null;
		let flushedAt = 0;

		const isDue = (interval: number, last: number | null, now: number) => {
			if (last === null) {
				return true;
			}
			return Number.isFinite(interval) && now - last >= interval;
		};

		while (true) {
			const outputTime = this.packetCount * packetDuration;

			if (isDue(patInterval, lastPat, outputTime)) {
				lastPat = outputTime;
				writeSection(PAT_PID, pat);
				continue;
			}
			if (isDue(pmtInterval, lastPmt, outputTime)) {
				lastPmt = outputTime;
				for (const reader of this.readers) {
					assert(reader.pmtSection);
					writeSection(reader.outputPmtPid, reader.pmtSection);
				}
				continue;
			}

			/** When the multiplex owes this packet, on the output's own clock. */
			const dueAt = (reader: ProgramReader, packet: DatedPacket) =>
				packet.undated ? -Infinity : packet.time + (reader.scheduleOffset ?? 0);

			let next: ProgramReader | null = null;
			for (const reader of this.readers) {
				if (reader.ready.length === 0 && !reader.done) {
					await reader.fill();
				}

				const head = reader.head;
				if (head && (!next || dueAt(reader, head) < dueAt(next, next.head!))) {
					next = reader;
				}
			}

			if (!next) {
				break; // every program has ended
			}

			const head = next.head!;
			const due = dueAt(next, head);
			if (due > outputTime) {
				writePacket(nullPacket);
				this.nullPacketCount++;
			} else {
				if (head.undated) {
					// No time of its own, so there is nothing for it to be behind
				} else if (next.scheduleOffset === null) {
					next.scheduleOffset = outputTime - head.time;
				} else if (due < outputTime - LATE_ALLOWANCE) {
					const needed = (this.packetCount - this.nullPacketCount) * TS_PACKET_SIZE * 8
						/ Math.max(outputTime, packetDuration);
					throw new InvalidUsageError(
						`muxRate is ${muxRate} bits per second, which by ${outputTime.toFixed(3)}s is not enough`
						+ ` for these ${this.readers.length} programs: program ${next.programNumber} has fallen`
						+ ` ${(outputTime - due).toFixed(3)}s behind, and the media alone needs about`
						+ ` ${Math.round(needed)}. Raise muxRate or lower a program's bitrate.`,
					);
				}

				next.shift();
				const bytes = head.bytes;
				setPid(bytes, next.pidMap.get(head.pid)!);
				shiftPesTimestamps(bytes, next.timestampOffset);
				// Only where one is actually present: on a packet without an adaptation field, bytes 6
				// through 11 are media.
				if (head.pid === next.inputPcrPid && readPcr(bytes) !== null) {
					writePcr(bytes, (CLOCK_LEAD + outputTime) * PCR_TIMESCALE);
				}

				writePacket(bytes);
			}

			if (writer.getPos() - flushedAt >= FLUSH_EVERY) {
				flushedAt = writer.getPos();
				await writer.flush();
			}
		}

		await writer.finalize();
		await target._close();

		this.state = 'done';
	}
}
