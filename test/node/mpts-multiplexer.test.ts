/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A multi-program transport stream is read back here off the 188-byte packets and with ffprobe, never
// with this library's own demuxer: the point of restating a PID or a clock is that something else reads
// it, and our demuxer would unwrap the very timestamps these tests are about.
//
// The two structural claims are that a program's media passes through unchanged except for a single
// constant shift of its timestamps, and that every PCR means the byte position it ends up at. Together
// those are what keeps a receiver's buffer model intact across the remultiplex.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { computeMpegTsCrc32 } from '../../src/mpeg-ts/mpeg-ts-misc.js';
import { MptsMultiplexer } from '../../src/mpeg-ts/mpts-multiplexer.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import { rawPesTimestamps } from './_pes-timestamps.js';

const PACKET = 188;
const MUX_RATE = 8_000_000;
const CLOCK_LEAD_TICKS = 90_000; // the one second of lead the multiplexer starts every clock with

/** A single-program transport stream of `seconds` of a real file's packets, replayed on a 25 fps grid. */
const singleProgram = async (
	file: string,
	videoCodec: 'avc' | 'hevc',
	seconds: number,
	withAudio = true,
	extras: { languageCode?: string; scte35Pid?: number } = {},
) => {
	using source = new Input({
		source: new FilePathSource(new URL(`../public/${file}`, import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await source.getPrimaryVideoTrack())!;
	const videoConfig = (await videoTrack.getDecoderConfig())!;
	const videoPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		videoPackets.push(packet);
		if (videoPackets.length === 25) {
			break;
		}
	}

	const audioTrack = withAudio ? await source.getPrimaryAudioTrack() : null;
	const audioConfig = audioTrack ? (await audioTrack.getDecoderConfig())! : null;
	const audioPackets: EncodedPacket[] = [];
	if (audioTrack) {
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			audioPackets.push(packet);
			if (audioPackets.length === 40) {
				break;
			}
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat(extras.scte35Pid ? { scte35Pid: extras.scte35Pid } : {}),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource(videoCodec);
	output.addVideoTrack(videoSource);
	const audioSource = audioConfig ? new EncodedAudioPacketSource('aac') : null;
	if (audioSource) {
		output.addAudioTrack(audioSource, extras.languageCode ? { languageCode: extras.languageCode } : {});
	}
	await output.start();

	for (let i = 0; i < Math.round(seconds * 25); i++) {
		const packet = videoPackets[i % videoPackets.length]!;
		await videoSource.add(
			new EncodedPacket(packet.data, i % 25 === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: videoConfig },
		);
	}
	if (audioSource && audioConfig) {
		const frameDuration = 1024 / 48_000;
		for (let i = 0; i < Math.ceil(seconds / frameDuration); i++) {
			const packet = audioPackets[i % audioPackets.length]!;
			await audioSource.add(
				new EncodedPacket(packet.data, 'key', i * frameDuration, frameDuration),
				{ decoderConfig: audioConfig },
			);
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

type Section = { pid: number; bytes: Uint8Array };

/** Every complete PSI section on `pid`, reassembled across packets. */
const sectionsOn = (bytes: Uint8Array, pid: number): Section[] => {
	const out: Section[] = [];
	let buffer: Uint8Array | null = null;
	let have = 0;

	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		expect(bytes[at]).toBe(0x47);
		if ((((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!) !== pid) {
			continue;
		}

		const control = (bytes[at + 3]! >> 4) & 0x3;
		let payloadAt = control === 2 || control === 3 ? at + 5 + bytes[at + 4]! : at + 4;
		if (payloadAt >= at + PACKET) {
			continue;
		}

		if (bytes[at + 1]! & 0x40) {
			payloadAt += 1 + bytes[payloadAt]!;
			const length = ((bytes[payloadAt + 1]! & 0x0f) << 8) | bytes[payloadAt + 2]!;
			buffer = new Uint8Array(3 + length);
			have = 0;
		} else if (!buffer) {
			continue;
		}

		const take = Math.min(buffer.length - have, at + PACKET - payloadAt);
		buffer.set(bytes.subarray(payloadAt, payloadAt + take), have);
		have += take;
		if (have === buffer.length) {
			out.push({ pid, bytes: buffer });
			buffer = null;
		}
	}

	return out;
};

const parsePat = (section: Uint8Array) => {
	expect(section[0]).toBe(0x00);
	const end = 3 + (((section[1]! & 0x0f) << 8) | section[2]!) - 4;
	const out: { programNumber: number; pmtPid: number }[] = [];
	for (let at = 8; at + 4 <= end; at += 4) {
		const programNumber = (section[at]! << 8) | section[at + 1]!;
		if (programNumber !== 0) {
			out.push({ programNumber, pmtPid: ((section[at + 2]! & 0x1f) << 8) | section[at + 3]! });
		}
	}
	return out;
};

const parsePmt = (section: Uint8Array) => {
	expect(section[0]).toBe(0x02);
	const end = 3 + (((section[1]! & 0x0f) << 8) | section[2]!) - 4;
	const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
	const streams: { pid: number; streamType: number; descriptors: Uint8Array }[] = [];

	let at = 12 + programInfoLength;
	while (at + 5 <= end) {
		const esInfoLength = ((section[at + 3]! & 0x0f) << 8) | section[at + 4]!;
		streams.push({
			streamType: section[at]!,
			pid: ((section[at + 1]! & 0x1f) << 8) | section[at + 2]!,
			descriptors: section.subarray(at + 5, at + 5 + esInfoLength),
		});
		at += 5 + esInfoLength;
	}

	return {
		programNumber: (section[3]! << 8) | section[4]!,
		pcrPid: ((section[8]! & 0x1f) << 8) | section[9]!,
		programDescriptors: section.subarray(12, 12 + programInfoLength),
		streams,
	};
};

/** Every PCR in the stream, as (packet index, PID, 27 MHz ticks), plus how much of the rate went to nulls. */
const clockOf = (bytes: Uint8Array) => {
	const pcrs: { packet: number; pid: number; ticks: number }[] = [];
	let nullPackets = 0;

	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		if (pid === 0x1fff) {
			nullPackets++;
		}

		const control = (bytes[at + 3]! >> 4) & 0x3;
		if ((control === 2 || control === 3) && bytes[at + 4]! >= 7 && (bytes[at + 5]! & 0x10)) {
			const base = bytes[at + 6]! * 2 ** 25
				+ bytes[at + 7]! * 2 ** 17
				+ bytes[at + 8]! * 2 ** 9
				+ bytes[at + 9]! * 2
				+ ((bytes[at + 10]! >> 7) & 0x1);
			const extension = ((bytes[at + 10]! & 0x1) << 8) | bytes[at + 11]!;
			pcrs.push({ packet: at / PACKET, pid, ticks: base * 300 + extension });
		}
	}

	return { pcrs, nullPackets, packets: Math.floor(bytes.byteLength / PACKET) };
};

const probe = (bytes: Uint8Array, entries: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-mpts-'));
	const file = path.join(dir, 'multiplex.ts');
	writeFileSync(file, bytes);
	try {
		return execFileSync(
			'ffprobe',
			['-v', 'error', '-show_entries', entries, '-of', 'compact=nokey=0', file],
			{ encoding: 'utf8' },
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const hasFfprobe = () => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const multiplexed = new Map<number, Promise<{
	hd: Uint8Array;
	sd: Uint8Array;
	multiplexer: MptsMultiplexer;
	bytes: Uint8Array;
}>>();

/**
 * Two programs of unlike content, so a stream placed under the wrong one is visible. Memoized: most of
 * what follows reads the same multiplex, and building it is two full decodes of a real file.
 */
const twoPrograms = (seconds = 2) => {
	let result = multiplexed.get(seconds);
	if (!result) {
		result = buildTwoPrograms(seconds);
		multiplexed.set(seconds, result);
	}
	return result;
};

const buildTwoPrograms = async (seconds: number) => {
	const [hd, sd] = await Promise.all([
		singleProgram('demo.mp4', 'avc', seconds),
		singleProgram('video-h265.mp4', 'hevc', seconds, false),
	]);

	const target = new BufferTarget();
	const multiplexer = new MptsMultiplexer({
		programs: [{ source: new BufferSource(hd) }, { source: new BufferSource(sd), programNumber: 9 }],
		target,
		muxRate: MUX_RATE,
		transportStreamId: 77,
	});
	await multiplexer.execute();

	return { hd, sd, multiplexer, bytes: new Uint8Array(target.buffer!) };
};

test('the PAT names every program, and nothing shares a PID', async () => {
	const { multiplexer, bytes } = await twoPrograms();

	const pat = sectionsOn(bytes, 0x0000);
	expect(pat.length, 'the PAT is repeated, not written once').toBeGreaterThan(1);

	const entries = parsePat(pat[0]!.bytes);
	expect(entries.map(x => x.programNumber)).toEqual([1, 9]);
	expect(new Set(entries.map(x => x.pmtPid)).size).toBe(2);

	// Every PID the multiplex uses, which must be unique across programs - two independently produced
	// programs both number their video 0x0100, and that collision is the whole reason for remapping
	const pids: number[] = [];
	for (const entry of entries) {
		const sections = sectionsOn(bytes, entry.pmtPid);
		expect(sections.length, `program ${entry.programNumber} repeats its PMT`).toBeGreaterThan(1);

		const pmt = parsePmt(sections[0]!.bytes);
		expect(pmt.programNumber).toBe(entry.programNumber);
		expect(pmt.streams.map(x => x.pid)).toContain(pmt.pcrPid);

		pids.push(entry.pmtPid, ...pmt.streams.map(x => x.pid));
	}

	expect(new Set(pids).size, `PIDs collide: ${pids.map(x => x.toString(16)).join(' ')}`).toBe(pids.length);

	// Program 1 came from a file with video and audio, program 9 from one with video alone
	expect(multiplexer.programs.map(x => x.streams.length)).toEqual([2, 1]);
	expect(multiplexer.programs.map(x => x.programNumber)).toEqual([1, 9]);
}, 120_000);

test('each program\'s timestamps survive as one constant shift, on its new PIDs', async () => {
	const { hd, sd, multiplexer, bytes } = await twoPrograms();
	const output = rawPesTimestamps(bytes);

	for (const [index, input] of [hd, sd].entries()) {
		const program = multiplexer.programs[index]!;
		const inputStamps = rawPesTimestamps(input);

		for (const stream of program.streams) {
			const before = inputStamps.filter(x => x.pid === stream.inputPid).map(x => x.pts);
			const after = output.filter(x => x.pid === stream.pid).map(x => x.pts);

			expect(before.length, `program ${program.programNumber} input PID ${stream.inputPid}`)
				.toBeGreaterThan(0);
			expect(after, `program ${program.programNumber} PID ${stream.pid}`).toHaveLength(before.length);

			// One shift for the whole program: every stream of it moves by the same number of ticks, or
			// the streams would drift apart from each other
			const shifts = new Set(before.map((pts, i) => (pts - after[i]!) % 2 ** 33));
			expect(shifts.size, `program ${program.programNumber} PID ${stream.pid} shifts: ${
				[...shifts].join(', ')
			}`).toBe(1);
		}

		// And that shift puts the program's own first PCR at the one second of lead the output starts with
		const firstPcr = clockOf(input).pcrs[0]!.ticks;
		const stream = program.streams[0]!;
		const before = inputStamps.find(x => x.pid === stream.inputPid)!.pts;
		const after = output.find(x => x.pid === stream.pid)!.pts;
		expect(before - after).toBe(Math.floor(firstPcr / 300) - CLOCK_LEAD_TICKS);
	}
}, 120_000);

test('every PCR means the byte position it ended up at, for each program', async () => {
	const { multiplexer, bytes } = await twoPrograms();
	const { pcrs, nullPackets, packets } = clockOf(bytes);

	expect(nullPackets, 'a constant rate pads with null packets').toBeGreaterThan(0);
	expect(multiplexer.nullPacketCount).toBe(nullPackets);
	expect(multiplexer.packetCount).toBe(packets);

	for (const program of multiplexer.programs) {
		const own = pcrs.filter(x => x.pid === program.pcrPid);
		expect(own.length, `program ${program.programNumber} states a PCR`).toBeGreaterThan(10);

		// Exact to the tick: the PCR is stamped from the byte position rather than carried over, which is
		// what makes this multiplex's clock and its rate agree
		for (let i = 1; i < own.length; i++) {
			const expected = (own[i]!.packet - own[i - 1]!.packet) * PACKET * 8 * 27_000_000 / MUX_RATE;
			expect(Math.abs((own[i]!.ticks - own[i - 1]!.ticks) - expected), `program ${
				program.programNumber
			} PCR ${i}`).toBeLessThanOrEqual(1);
		}

		// Both programs run on the one output clock, so they start together
		expect(own[0]!.ticks / 27_000_000).toBeCloseTo(1 + own[0]!.packet * PACKET * 8 / MUX_RATE, 3);
	}
}, 120_000);

test('each program keeps its buffer delay, which is what a receiver sizes its buffer by', async () => {
	const { hd, sd, multiplexer, bytes } = await twoPrograms();

	for (const [index, input] of [hd, sd].entries()) {
		const program = multiplexer.programs[index]!;
		const stream = program.streams[0]!;

		// PTS minus the PCR in force where that PES began, which is the delay the encoder stated
		const delayOf = (ts: Uint8Array, pid: number, pcrPid: number) => {
			const pcrs = clockOf(ts).pcrs.filter(x => x.pid === pcrPid);
			const pes = rawPesTimestamps(ts).find(x => x.pid === pid)!;
			let at = pcrs[0]!;
			for (const pcr of pcrs) {
				if (pcr.ticks / 300 <= pes.pts) {
					at = pcr;
				}
			}
			return pes.pts - at.ticks / 300;
		};

		const before = delayOf(input, stream.inputPid, clockOf(input).pcrs[0]!.pid);
		const after = delayOf(bytes, stream.pid, program.pcrPid);

		// Within a packet slot of the input's: the only loss is which output slot the packet landed in
		expect(Math.abs(after - before), `program ${program.programNumber}`)
			.toBeLessThan(0.05 * 90_000);
	}
}, 120_000);

test.skipIf(!hasFfprobe())('ffprobe reads both programs and places every stream', async () => {
	const { bytes } = await twoPrograms();

	const programs = probe(bytes, 'program=program_num,pmt_pid,pcr_pid,nb_streams');
	expect(programs).toContain('program_num=1');
	expect(programs).toContain('program_num=9');

	const streams = probe(bytes, 'stream=codec_name,program_id');
	// A PID ffprobe cannot place reads as `unknown`, which is what a mispatched PMT looks like
	expect(streams).not.toContain('codec_name=unknown');
	expect(streams).toContain('codec_name=h264');
	expect(streams).toContain('codec_name=aac');
	expect(streams).toContain('codec_name=hevc');

	const format = probe(bytes, 'format=nb_programs');
	expect(format).toContain('nb_programs=2');
}, 120_000);

test('the stated rate is the rate the file comes out at', async () => {
	const { multiplexer, bytes } = await twoPrograms(4);
	const { pcrs } = clockOf(bytes);

	const span = (pcrs[pcrs.length - 1]!.ticks - pcrs[0]!.ticks) / 27_000_000;
	const rate = (pcrs[pcrs.length - 1]!.packet - pcrs[0]!.packet) * PACKET * 8 / span;
	expect(Math.abs(rate / MUX_RATE - 1), 'within 0.5% of muxRate').toBeLessThan(0.005);

	// The programs between them used some of it and the nulls the rest, with neither at zero
	expect(multiplexer.nullPacketCount).toBeGreaterThan(0);
	expect(multiplexer.packetCount - multiplexer.nullPacketCount).toBeGreaterThan(0);
	expect(bytes.byteLength % PACKET).toBe(0);
}, 120_000);

test('programs that together need more than muxRate are refused, naming the rate they needed', async () => {
	const hd = await singleProgram('demo.mp4', 'avc', 3);
	const sd = await singleProgram('video-h265.mp4', 'hevc', 3, false);

	const multiplexer = new MptsMultiplexer({
		programs: [{ source: new BufferSource(hd) }, { source: new BufferSource(sd) }],
		target: new BufferTarget(),
		muxRate: 200_000,
	});

	await expect(multiplexer.execute()).rejects.toThrow(/muxRate is 200000 bits per second/);
}, 120_000);

test('a program whose PMT carries descriptors keeps them', async () => {
	// The AAC stream's language descriptor is written by the single-program muxer and means nothing to
	// the multiplexer, which is exactly why the PMT is patched rather than rebuilt from what it understood
	const hd = await singleProgram('demo.mp4', 'avc', 1, true, { languageCode: 'fra', scte35Pid: 0x1f00 });
	const inputPmtPid = parsePat(sectionsOn(hd, 0x0000)[0]!.bytes)[0]!.pmtPid;
	const inputPmt = parsePmt(sectionsOn(hd, inputPmtPid)[0]!.bytes);
	const inputDescriptors = inputPmt.streams.map(x => [...x.descriptors].join(','));
	expect(inputDescriptors.some(x => x.length > 0), 'the input states some descriptor').toBe(true);

	const target = new BufferTarget();
	const multiplexer = new MptsMultiplexer({
		programs: [{ source: new BufferSource(hd) }],
		target,
		muxRate: MUX_RATE,
	});
	await multiplexer.execute();
	const bytes = new Uint8Array(target.buffer!);

	const outputPmt = parsePmt(sectionsOn(bytes, multiplexer.programs[0]!.pmtPid)[0]!.bytes);
	expect(outputPmt.streams.map(x => [...x.descriptors].join(','))).toEqual(inputDescriptors);
	expect(outputPmt.streams.map(x => x.streamType)).toEqual(inputPmt.streams.map(x => x.streamType));

	// SCTE 35 puts its CUEI registration in the program's own descriptor loop, which sits before the
	// stream loop the patch walks - so a patch that miscounted it would lose it
	expect([...outputPmt.programDescriptors]).toEqual([...inputPmt.programDescriptors]);
	expect([...inputPmt.programDescriptors].length, 'the input states a program descriptor')
		.toBeGreaterThan(0);
}, 120_000);

test('the options are checked before anything is read', async () => {
	const target = () => new BufferTarget();
	const source = () => new BufferSource(new Uint8Array(PACKET));

	expect(() => new MptsMultiplexer({ programs: [], target: target(), muxRate: 1e6 }))
		.toThrow(/non-empty array/);
	expect(() => new MptsMultiplexer({
		programs: [{ source: source() }],
		target: target(),
		muxRate: 0,
	})).toThrow(/positive number of bits per second/);
	expect(() => new MptsMultiplexer({
		programs: [{ source: source() }, { source: source() }],
		target: target(),
		muxRate: 1e6,
	// A receiver selects a program by its number, so two programs sharing one is unresolvable
	})).not.toThrow();
	expect(() => new MptsMultiplexer({
		programs: [{ source: source(), programNumber: 4 }, { source: source(), programNumber: 4 }],
		target: target(),
		muxRate: 1e6,
	})).toThrow(/another program\s+already uses|already uses/);
	expect(() => new MptsMultiplexer({
		programs: [{ source: source(), programNumber: 0 }],
		target: target(),
		muxRate: 1e6,
	})).toThrow(/reserved for the network information table/);
	expect(() => new MptsMultiplexer({
		programs: [{ source: {} as never }],
		target: target(),
		muxRate: 1e6,
	})).toThrow(/must be a Source/);
	expect(() => new MptsMultiplexer({
		programs: [{ source: source() }],
		target: {} as never,
		muxRate: 1e6,
	})).toThrow(/must be a Target/);
});

test('a stream that is not a transport stream is refused by name', async () => {
	const multiplexer = new MptsMultiplexer({
		programs: [{ source: new BufferSource(new Uint8Array(PACKET * 4).fill(0x11)) }],
		target: new BufferTarget(),
		muxRate: 1e6,
	});

	await expect(multiplexer.execute()).rejects.toThrow(/not aligned to 188-byte transport packets/);
});

test('a transport stream with no program in it is refused by name', async () => {
	// Well-formed null packets and nothing else: aligned, but carrying no PAT
	const nulls = new Uint8Array(PACKET * 8).fill(0xff);
	for (let at = 0; at < nulls.length; at += PACKET) {
		nulls[at] = 0x47;
		nulls[at + 1] = 0x1f;
		nulls[at + 2] = 0xff;
		nulls[at + 3] = 0x10;
	}

	const multiplexer = new MptsMultiplexer({
		programs: [{ source: new BufferSource(nulls) }],
		target: new BufferTarget(),
		muxRate: 1e6,
	});

	await expect(multiplexer.execute()).rejects.toThrow(/ended before stating a PAT/);
});

/** A 188-byte packet, with a PCR in its adaptation field when one is given. */
const tsPacket = (pid: number, pusi: boolean, cc: number, payload: Uint8Array, pcr?: number) => {
	const packet = new Uint8Array(PACKET).fill(0xff);
	packet[0] = 0x47;
	packet[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
	packet[2] = pid & 0xff;

	let at = 4;
	if (pcr === undefined) {
		packet[3] = 0x10 | (cc & 0x0f);
	} else {
		packet[3] = 0x30 | (cc & 0x0f); // adaptation field and payload
		packet[4] = 7; // adaptation_field_length
		packet[5] = 0x10; // PCR_flag
		const base = Math.floor(pcr / 300);
		const extension = pcr % 300;
		packet[6] = Math.floor(base / 2 ** 25) & 0xff;
		packet[7] = Math.floor(base / 2 ** 17) & 0xff;
		packet[8] = Math.floor(base / 2 ** 9) & 0xff;
		packet[9] = Math.floor(base / 2) & 0xff;
		packet[10] = ((base % 2) << 7) | 0x7e | ((extension >> 8) & 0x1);
		packet[11] = extension & 0xff;
		at = 12;
	}

	packet.set(payload.subarray(0, PACKET - at), at);
	return packet;
};

/** A PES header stating a PTS and nothing else, which is all these tests read back. */
const pesHeader = (streamId: number, pts: number) => {
	const header = new Uint8Array(14);
	header[2] = 0x01; // packet_start_code_prefix
	header[3] = streamId;
	header[6] = 0x80; // '10', no scrambling
	header[7] = 0x80; // PTS only
	header[8] = 5; // PES_header_data_length
	header[9] = 0x20 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1) | 0x1;
	header[10] = Math.floor(pts / 2 ** 22) & 0xff;
	header[11] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 0x1;
	header[12] = Math.floor(pts / 2 ** 7) & 0xff;
	header[13] = ((pts % 2 ** 7) << 1) | 0x1;
	return header;
};

const psiPacket = (pid: number, section: Uint8Array) => {
	const payload = new Uint8Array(184).fill(0xff);
	payload[0] = 0x00; // pointer_field
	payload.set(section, 1);
	return tsPacket(pid, true, 0, payload);
};

const withCrc = (section: Uint8Array) => {
	const end = section.length - 4;
	const crc = computeMpegTsCrc32(section.subarray(0, end));
	section[end] = (crc >>> 24) & 0xff;
	section[end + 1] = (crc >>> 16) & 0xff;
	section[end + 2] = (crc >>> 8) & 0xff;
	section[end + 3] = crc & 0xff;
	return section;
};

/**
 * A transport stream whose PCR rides a stream of its own that stays quiet for `leadingPackets` while
 * another stream sends - which is a program whose clock simply starts late. Those packets have nothing
 * to date them, so they all share one time and draining them takes real output time while that time
 * stands still. Read as the multiplex falling behind, it is a spurious "muxRate too low".
 */
const lateClockProgram = (leadingPackets: number) => {
	const videoPid = 0x0100;
	const audioPid = 0x0101;
	const packets: Uint8Array[] = [];

	const pat = withCrc(new Uint8Array([
		0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
		0x00, 0x01, 0xe0 | 0x10, 0x00, // program 1 on PMT PID 0x1000
		0, 0, 0, 0,
	]));
	const pmt = withCrc(new Uint8Array([
		0x02, 0xb0, 0x17, 0x00, 0x01, 0xc1, 0x00, 0x00,
		0xe0 | ((audioPid >> 8) & 0x1f), audioPid & 0xff, // PCR_PID: the audio, which starts late
		0xf0, 0x00, // program_info_length 0
		0x1b, 0xe0 | ((videoPid >> 8) & 0x1f), videoPid & 0xff, 0xf0, 0x00,
		0x0f, 0xe0 | ((audioPid >> 8) & 0x1f), audioPid & 0xff, 0xf0, 0x00,
		0, 0, 0, 0,
	]));
	packets.push(psiPacket(0x0000, pat), psiPacket(0x1000, pmt));

	let videoCc = 0;
	let audioCc = 0;
	const body = new Uint8Array(184).fill(0x5a);

	for (let i = 0; i < leadingPackets; i++) {
		const payload = i === 0
			? new Uint8Array([...pesHeader(0xe0, 90_000), ...body.subarray(14)])
			: body;
		packets.push(tsPacket(videoPid, i === 0, videoCc++ & 0x0f, payload));
	}

	// Three seconds of a clock, with a little of each stream between PCRs
	for (let i = 0; i < 75; i++) {
		const pcr = Math.round((1 + i * 0.04) * 27_000_000);
		packets.push(tsPacket(
			audioPid,
			i === 0,
			audioCc++ & 0x0f,
			i === 0 ? new Uint8Array([...pesHeader(0xc0, 90_000), ...body.subarray(14)]) : body,
			pcr,
		));
		for (let k = 0; k < 4; k++) {
			packets.push(tsPacket(videoPid, false, videoCc++ & 0x0f, body));
		}
	}

	const bytes = new Uint8Array(packets.length * PACKET);
	packets.forEach((packet, i) => bytes.set(packet, i * PACKET));
	return bytes;
};

test('a program whose clock starts late is not mistaken for the multiplex running behind', async () => {
	// 800 packets before the first PCR is 1.2 Mbit, which at this rate is 0.6 s of output time - past
	// the half second the multiplex is allowed to fall behind by, while the whole stream needs 0.6 Mbps
	const bytes = lateClockProgram(800);
	const target = new BufferTarget();
	const multiplexer = new MptsMultiplexer({
		programs: [{ source: new BufferSource(bytes) }],
		target,
		muxRate: 2_000_000,
	});

	await multiplexer.execute();
	expect(multiplexer.programs[0]!.streams).toHaveLength(2);

	// All of it came through, undated packets included
	const written = new Uint8Array(target.buffer!);
	const pids = new Set(multiplexer.programs[0]!.streams.map(x => x.pid));
	let media = 0;
	for (let at = 0; at + PACKET <= written.byteLength; at += PACKET) {
		if (pids.has(((written[at + 1]! & 0x1f) << 8) | written[at + 2]!)) {
			media++;
		}
	}
	expect(media).toBe(800 + 75 * 5);
}, 120_000);

test('the multiplex alternates between programs rather than sending each in bursts', async () => {
	const { multiplexer, bytes } = await twoPrograms();

	const owner = new Map<number, number>();
	for (const program of multiplexer.programs) {
		for (const stream of program.streams) {
			owner.set(stream.pid, program.programNumber);
		}
	}

	// A packet's time is interpolated between the two PCRs that bound it, so a program's packets are
	// spread across the interval they belong to. Dating them all from the PCR before them instead makes
	// them eligible at once, and each program then goes out in one burst per PCR period - measured at
	// 150 packets against a typical 3 here, with a 25th of the alternations.
	const runs: number[] = [];
	let run = 0;
	let current = -1;
	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const who = owner.get(((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!);
		if (who === undefined) {
			continue; // a null packet or a table
		}
		if (who === current) {
			run++;
		} else {
			if (run > 0) {
				runs.push(run);
			}
			current = who;
			run = 1;
		}
	}
	runs.push(run);

	// Counting the alternations rather than bounding the longest run: the packets at either end of a
	// program - before its first PCR and after its last - have no clock to pace them and go out in one
	// burst whatever this does, so a bound on the longest run would be measuring those instead.
	expect(runs.length, `the multiplex changes program often, ${runs.length} times here`)
		.toBeGreaterThan(500);
	expect(Math.max(...runs), 'and no single run is a large share of the stream')
		.toBeLessThan(0.02 * multiplexer.packetCount);
}, 120_000);

/** Every elementary stream's payload bytes, in order, keyed by PID. */
const payloadsOf = (bytes: Uint8Array, pids: Set<number>, continuationsOnly: boolean) => {
	const out = new Map<number, number[]>();

	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		if (!pids.has(pid)) {
			continue;
		}
		if (continuationsOnly && (bytes[at + 1]! & 0x40)) {
			continue; // a PES header starts here, and its timestamps are meant to differ
		}

		const control = (bytes[at + 3]! >> 4) & 0x3;
		const payloadAt = control === 2 || control === 3 ? at + 5 + bytes[at + 4]! : at + 4;
		if (control === 0 || control === 2 || payloadAt >= at + PACKET) {
			continue;
		}

		const into = out.get(pid) ?? [];
		for (let i = payloadAt; i < at + PACKET; i++) {
			into.push(bytes[i]!);
		}
		out.set(pid, into);
	}

	return out;
};

test('the media itself passes through byte for byte', async () => {
	const { hd, sd, multiplexer, bytes } = await twoPrograms();

	for (const [index, input] of [hd, sd].entries()) {
		const program = multiplexer.programs[index]!;

		const before = payloadsOf(input, new Set(program.streams.map(x => x.inputPid)), true);
		const after = payloadsOf(bytes, new Set(program.streams.map(x => x.pid)), true);

		for (const stream of program.streams) {
			const was = before.get(stream.inputPid)!;
			const is = after.get(stream.pid)!;

			expect(was.length, `program ${program.programNumber} input PID ${stream.inputPid}`)
				.toBeGreaterThan(0);
			// Only the PID, the PCR and the PES timestamps are the multiplexer's to touch. Every
			// continuation packet of an elementary stream must come out exactly as it went in - a PCR
			// written over a packet that had no adaptation field lands in the middle of this.
			expect(is.length, `program ${program.programNumber} PID ${stream.pid} length`).toBe(was.length);
			const firstDifference = is.findIndex((byte, i) => byte !== was[i]);
			expect(firstDifference, `program ${program.programNumber} PID ${stream.pid} differs at byte ${
				firstDifference
			}`).toBe(-1);
		}
	}
}, 120_000);

test('every table the multiplex writes carries a correct CRC', async () => {
	const { multiplexer, bytes } = await twoPrograms();

	const check = (section: Uint8Array, what: string) => {
		const end = 3 + (((section[1]! & 0x0f) << 8) | section[2]!) - 4;
		const stated = (section[end]! * 2 ** 24) + (section[end + 1]! << 16)
			+ (section[end + 2]! << 8) + section[end + 3]!;
		// A section whose CRC does not check out is discarded by a conformant receiver, which reads as
		// the program simply not being there. ffprobe does not verify it, so nothing else here would.
		expect(stated, what).toBe(computeMpegTsCrc32(section.subarray(0, end)));
	};

	const pat = sectionsOn(bytes, 0x0000);
	expect(pat.length).toBeGreaterThan(1);
	pat.forEach((section, i) => check(section.bytes, `PAT ${i}`));

	for (const program of multiplexer.programs) {
		const sections = sectionsOn(bytes, program.pmtPid);
		expect(sections.length).toBeGreaterThan(1);
		sections.forEach((section, i) => check(section.bytes, `program ${program.programNumber} PMT ${i}`));
	}
}, 120_000);
