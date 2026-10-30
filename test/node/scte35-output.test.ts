/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The section layout is confirmed from tsduck's own serializer (src/libtsduck/dtv/tables/scte/
// tsSpliceInformationTable.cpp): table_id 0xFC, then protocol_version u8, encrypted_packet 1b,
// encryption_algorithm 6b, pts_adjustment 33b, cw_index u8, tier 12b, splice_command_length 12b,
// splice_command_type u8, and a trailing CRC_32. The PMT carries stream type 0x86 with the CUEI
// registration descriptor, which is what tells a cue stream from the Blu-ray use of the same type.
//
// Stated coverage limit: every section here is written while the tables are still pending, so it is
// emitted right behind the first PMT. A stream this short never flushes its tables before finalize -
// traced, not assumed - so the branch that writes a section straight out once the tables already exist
// is not reached by these tests, and two mutations of it stay green. It is the branch a live stream
// uses, which is why it is still there.

import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, HlsOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { addScte35Section, type Scte35SectionOptions } from '../../src/mpeg-ts/scte35-output.js';
import { readScte35Sections } from '../../src/mpeg-ts/scte35.js';
import { bytesToHexString } from '../../src/misc.js';
import { Logging } from '../../src/logging.js';
import { Conversion } from '../../src/conversion.js';
import { BufferSource } from '../../src/source.js';

const SCTE35_PID = 0x1f00;

/** MPEG-2 CRC-32, computed here rather than imported so the section stays this test's own. */
const crc32Mpeg = (data: Uint8Array) => {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte << 24;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
			crc >>>= 0;
		}
	}
	return crc >>> 0;
};

/** A `time_signal` section, built to the layout tsduck serializes, with a real CRC. */
const spliceSection = (
	ptsAdjustment: number,
	spliceTime: number,
	/** A break to state in a segmentation_descriptor, which a bare time_signal carries none of. */
	segmentation?: { outOfNetwork?: boolean; typeId?: number; duration?: number },
) => {
	// splice_command: time_signal() = time_specified_flag 1b, reserved 6b, pts_time 33b
	const command = new Uint8Array(5);
	command[0] = 0x80 | 0x7e | ((spliceTime / 2 ** 32) & 0x1);
	command[1] = (spliceTime >>> 24) & 0xff;
	command[2] = (spliceTime >>> 16) & 0xff;
	command[3] = (spliceTime >>> 8) & 0xff;
	command[4] = spliceTime & 0xff;

	const body: number[] = [];
	body.push(0x00); // protocol_version
	// encrypted_packet 1b + encryption_algorithm 6b + the top bit of the 33-bit pts_adjustment
	body.push(((ptsAdjustment / 2 ** 32) & 0x1) | 0x00);
	body.push((ptsAdjustment >>> 24) & 0xff);
	body.push((ptsAdjustment >>> 16) & 0xff);
	body.push((ptsAdjustment >>> 8) & 0xff);
	body.push(ptsAdjustment & 0xff);
	body.push(0x00); // cw_index
	body.push(0x0f, 0xf0 | ((command.length >> 8) & 0x0f)); // tier 0xFFF, splice_command_length high
	body.push(command.length & 0xff);
	body.push(0x06); // splice_command_type: time_signal
	body.push(...command);

	// segmentation_descriptor: Provider Placement Opportunity Start (0x34) or End (0x35)
	const descriptor = segmentation === undefined
		? []
		: (() => {
				const duration = segmentation.duration;
				const fields = [
					0x43, 0x55, 0x45, 0x49, // 'CUEI'
					0, 0, 0, 1, // segmentation_event_id
					0x7f, // segmentation_event_cancel_indicator=0 + reserved
					// program_segmentation=1, segmentation_duration_flag, delivery_not_restricted=1
					0x80 | (duration === undefined ? 0 : 0x40) | 0x3f,
					...(duration === undefined
						? []
						: [
								Math.floor(duration / 2 ** 32) & 0xff,
								(duration >>> 24) & 0xff,
								(duration >>> 16) & 0xff,
								(duration >>> 8) & 0xff,
								duration & 0xff,
							]),
					0x01, 0x00, // segmentation_upid_type, segmentation_upid_length
					segmentation.typeId ?? (segmentation.outOfNetwork ? 0x34 : 0x35),
					0x01, 0x01, // segment_num, segments_expected
				];
				return [0x02, fields.length, ...fields];
			})();

	body.push((descriptor.length >> 8) & 0xff, descriptor.length & 0xff); // descriptor_loop_length
	body.push(...descriptor);

	const sectionLength = body.length + 4; // + CRC_32
	const withoutCrc = new Uint8Array([
		0xfc,
		0x30 | ((sectionLength >> 8) & 0x0f), // section_syntax_indicator 0, private 1, then length
		sectionLength & 0xff,
		...body,
	]);
	const out = new Uint8Array(withoutCrc.length + 4);
	out.set(withoutCrc);
	const crc = crc32Mpeg(withoutCrc);
	out[out.length - 4] = (crc >>> 24) & 0xff;
	out[out.length - 3] = (crc >>> 16) & 0xff;
	out[out.length - 2] = (crc >>> 8) & 0xff;
	out[out.length - 1] = crc & 0xff;
	return out;
};

/**
 * A TS with one video track. The callback is handed the output and a function that writes the next
 * `count` video packets, so a section can be placed genuinely between media rather than only ahead of
 * it — before any packet the muxer has no track data yet and the section has to be queued, which is a
 * different path from writing one into a stream already running.
 */
const buildStream = async (
	place: (output: Output, writePackets: (count: number) => Promise<void>) => void | Promise<void>,
) => {
	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === 20) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID, timestampOffset: 0 }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	let next = 0;
	const writePackets = async (count: number) => {
		for (let i = 0; i < count && next < packets.length; i++, next++) {
			await videoSource.add(packets[next]!, { decoderConfig: config });
		}
	};

	await place(output, writePackets);
	await writePackets(packets.length);
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

/** Every PID the PMT lists, with its stream type and whether it carries the CUEI registration. */
const pmtEntries = (bytes: Uint8Array) => {
	const out: { streamType: number; pid: number; cuei: boolean }[] = [];

	for (let at = 0; at + 188 <= bytes.length; at += 188) {
		if (bytes[at] !== 0x47) {
			continue;
		}
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		if (pid !== 0x1000 || (bytes[at + 1]! & 0x40) === 0) {
			continue;
		}

		const start = at + 4 + 1 + bytes[at + 4]!;
		const sectionLength = ((bytes[start + 1]! & 0x0f) << 8) | bytes[start + 2]!;
		const sectionEnd = start + 3 + sectionLength;
		const programInfoLength = ((bytes[start + 10]! & 0x0f) << 8) | bytes[start + 11]!;
		let pos = start + 12 + programInfoLength;

		while (pos + 5 <= sectionEnd - 4) {
			const streamType = bytes[pos]!;
			const entryPid = ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
			const esInfoLength = ((bytes[pos + 3]! & 0x0f) << 8) | bytes[pos + 4]!;
			const descriptors = bytes.subarray(pos + 5, pos + 5 + esInfoLength);
			out.push({
				streamType,
				pid: entryPid,
				cuei: bytesToHexString(descriptors).includes('050443554549'),
			});
			pos += 5 + esInfoLength;
		}
		return out;
	}

	return out;
};

test('the PMT lists the cue PID with type 0x86 and the CUEI registration', async () => {
	const bytes = await buildStream(output => addScte35Section(output, spliceSection(0, 450_000)));
	const entries = pmtEntries(bytes);

	const cue = entries.find(entry => entry.pid === SCTE35_PID)!;
	expect(cue.streamType).toBe(0x86);
	expect(cue.cuei).toBe(true);
	// The video track is still there and is not the cue stream
	expect(entries.some(entry => entry.pid !== SCTE35_PID && entry.streamType !== 0x86)).toBe(true);
}, 300_000);

test('a section written before the first video packet reads back byte for byte', async () => {
	const section = spliceSection(0, 450_000);
	const bytes = await buildStream(output => addScte35Section(output, section));

	const read = readScte35Sections(bytes);
	expect(read).toHaveLength(1);
	expect(bytesToHexString(read[0]!.section)).toBe(bytesToHexString(section));
	// 450000 ticks at 90 kHz is 5 s, and pts_adjustment is 0
	expect(read[0]!.time).toBeCloseTo(5, 6);
	expect(read[0]!.commandType).toBe(0x06);
}, 300_000);

test('a section written mid-stream reads back too, and both are kept apart', async () => {
	const first = spliceSection(0, 450_000);
	const second = spliceSection(90_000, 900_000);

	const bytes = await buildStream(async (output, writePackets) => {
		// Before any media: the muxer has no track data yet, so this one is queued behind the tables
		addScte35Section(output, first);
		// And then genuinely mid-stream, with packets already written, which takes the other path
		await writePackets(8);
		addScte35Section(output, second);
	});

	const read = readScte35Sections(bytes);
	expect(read).toHaveLength(2);
	expect(bytesToHexString(read[0]!.section)).toBe(bytesToHexString(first));
	expect(bytesToHexString(read[1]!.section)).toBe(bytesToHexString(second));
	// pts_adjustment 90000 plus a 900000-tick splice time is 11 s
	expect(read[1]!.time).toBeCloseTo(11, 6);
	expect(read[1]!.ptsAdjustment).toBe(90_000);
}, 300_000);

test('a section written once the tables are out goes straight into the stream', async () => {
	const section = spliceSection(180_000, 1_350_000);

	// Every packet first. A short stream keeps its tables until finalize, so this is what it takes to
	// reach the path that writes a section immediately rather than queueing it behind the tables.
	const bytes = await buildStream(async (output, writePackets) => {
		await writePackets(Number.MAX_SAFE_INTEGER);
		addScte35Section(output, section);
	});

	const read = readScte35Sections(bytes);
	expect(read).toHaveLength(1);
	expect(bytesToHexString(read[0]!.section)).toBe(bytesToHexString(section));
	// 180000 + 1350000 ticks at 90 kHz is 17 s
	expect(read[0]!.time).toBeCloseTo(17, 6);
}, 300_000);

test('a cue stream has to be declared, and only a TS output has one', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});
	await output.start();
	expect(() => addScte35Section(output, spliceSection(0, 0))).toThrow(/scte35Pid/);

	const declared = new Output({
		format: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
		target: new BufferTarget(),
	});
	await declared.start();
	expect(() => addScte35Section(declared, new Uint8Array(2))).toThrow(/three bytes/);
	expect(() => addScte35Section(declared, [1, 2, 3] as unknown as Uint8Array)).toThrow(TypeError);
}, 300_000);

test('a PID outside the usable range is refused', () => {
	expect(() => new MpegTsOutputFormat({ scte35Pid: 0x000f })).toThrow(/0x0010/);
	expect(() => new MpegTsOutputFormat({ scte35Pid: 0x1fff })).toThrow(/0x1ffe/);
	expect(() => new MpegTsOutputFormat({ scte35Pid: 1.5 })).toThrow(TypeError);
});

/** The warnings the demuxer emits while reading `bytes`, as whole strings. */
const warningsWhileDemuxing = async (bytes: Uint8Array) => {
	const warnings: string[] = [];
	const off = Logging.on('warn', args => void warnings.push(args.join(' ')));

	try {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		await input.getTracks();
	} finally {
		off();
	}

	return warnings;
};

test('a cue PID does not warn, but the same type without CUEI still does', async () => {
	const bytes = await buildStream(output => addScte35Section(output, spliceSection(0, 450_000)));

	// The clean stream goes first: the demuxer warns once per stream type process-wide, so warning here
	// would also mask the control below
	const clean = await warningsWhileDemuxing(bytes);
	expect(clean.filter(line => line.includes('0x86'))).toEqual([]);

	// Strip the registration that makes it a cue stream. The demuxer never checks the section CRC, so
	// the identifier can be overwritten in place.
	const stripped = bytes.slice();
	const at = bytesToHexString(stripped).indexOf('050443554549') / 2;
	expect(at).toBeGreaterThan(0);
	stripped.set([0x48, 0x44, 0x4d, 0x56], at + 2); // 'HDMV'

	const warnings = await warningsWhileDemuxing(stripped);
	expect(warnings.filter(line => line.includes('0x86'))).toHaveLength(1);
}, 300_000);

// A segmented output has no one transport stream to write into: it opens a muxer per segment. A cue
// therefore waits in the pipeline until the segment its splice point falls in is written, which is the
// segment a receiver reaches it by.
//
// Splice times are on the **output's own** media timeline, which `mediaTimestampBase` shifts - 10
// seconds by default for HLS. A time on the input's timeline lands exactly that much early, and the
// library says so rather than quietly putting the cue in the first segment.
describe('a cue stream through a segmented output', () => {
	const HLS_BASE = 10; // SegmentedOutputFormatOptions.mediaTimestampBase, default

	const publish = async (
		spliceSeconds: number | null,
		options: { segmentFormat?: 'mpeg-ts' | 'cmaf' } = {},
	) => {
		using input = new Input({
			source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
			formats: ALL_FORMATS,
		});

		const segments: Uint8Array[] = [];
		const warnings: string[] = [];
		const off = Logging.on('warn', args => void warnings.push(args.join(' ')));

		try {
			const output = new Output({
				format: new HlsOutputFormat({
					segmentFormat: options.segmentFormat === 'cmaf'
						? new CmafOutputFormat()
						: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
					targetDuration: 2,
					onSegment: target => void segments.push(new Uint8Array((target as BufferTarget).buffer!)),
				}),
				target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
			});

			const conversion = await Conversion.init({ input, output, audio: { discard: true } });
			if (spliceSeconds !== null) {
				addScte35Section(output, spliceSection(0, Math.round(spliceSeconds * 90_000)));
			}
			await conversion.execute();
		} finally {
			off();
		}

		return {
			warnings,
			// Which segment each cue landed in, and the splice time read back out of it
			found: segments.map((segment, index) => ({
				segment: index + 1,
				cues: readScte35Sections(segment).map(cue => cue.time),
			})),
		};
	};

	test('the cue lands in the segment covering its splice point', async () => {
		const { found, warnings } = await publish(HLS_BASE + 2.5);

		// Segments run 10-12, 12-14, 14-15 on the media timeline, so a splice at 12.5 is the second one
		expect(found.map(entry => entry.cues.length)).toEqual([0, 1, 0]);
		expect(found[1]!.cues[0]).toBeCloseTo(HLS_BASE + 2.5, 4);
		expect(warnings).toEqual([]);
	}, 300_000);

	test('a splice in the first segment lands there, not in a later one', async () => {
		const { found, warnings } = await publish(HLS_BASE + 0.5);

		expect(found.map(entry => entry.cues.length)).toEqual([1, 0, 0]);
		expect(warnings).toEqual([]);
	}, 300_000);

	test('a splice on the input\'s timeline is placed and named rather than silently misplaced', async () => {
		// 2.5 rather than 12.5: a caller who forgot that mediaTimestampBase shifts the output's timeline
		const { found, warnings } = await publish(2.5);

		expect(found.map(entry => entry.cues.length)).toEqual([1, 0, 0]);
		expect(warnings.join('\n')).toMatch(/more than one segment behind/);
		expect(warnings.join('\n')).toMatch(/mediaTimestampBase/);
	}, 300_000);

	test('a splice past the end of the media is named rather than dropped in silence', async () => {
		const { found, warnings } = await publish(HLS_BASE + 60);

		expect(found.every(entry => entry.cues.length === 0)).toBe(true);
		expect(warnings.join('\n')).toMatch(/never written/);
	}, 300_000);

	test('a CMAF segment has no cue PID, and that is not an error', async () => {
		const { warnings } = await publish(HLS_BASE + 2.5, { segmentFormat: 'cmaf' });
		expect(warnings).toEqual([]);
	}, 300_000);
});

// Each variant writes its own segments, so a cue belongs in every one of them. Consuming it on the
// first playlist to reach the splice would leave the other renditions without the break, and a player
// switching bitrate mid-break would miss its end.
test('a cue reaches every variant, not just the first to be written', async () => {
	using input = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === 50) {
			break;
		}
	}

	const perPlaylist = new Map<string, Uint8Array[]>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
			targetDuration: 1,
			onSegment: (target, info) => {
				const key = String(info.playlist.n);
				const list = perPlaylist.get(key) ?? [];
				list.push(new Uint8Array((target as BufferTarget).buffer!));
				perPlaylist.set(key, list);
			},
		}),
		target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
	});

	const sources = [new EncodedVideoPacketSource('avc'), new EncodedVideoPacketSource('avc')];
	for (const source of sources) {
		output.addVideoTrack(source, { group: new OutputTrackGroup() });
	}
	await output.start();

	// 10 is the default mediaTimestampBase, so 11.5 is 1.5 s into the media
	addScte35Section(output, spliceSection(0, Math.round(11.5 * 90_000)));

	for (const source of sources) {
		for (let i = 0; i < packets.length; i++) {
			const packet = packets[i]!;
			await source.add(
				new EncodedPacket(packet.data, i % 25 === 0 ? 'key' : 'delta', i / 25, 1 / 25),
				i === 0 ? { decoderConfig: config } : undefined,
			);
		}
	}
	await output.finalize();

	const variants = [...perPlaylist.values()];
	expect(variants).toHaveLength(2);
	for (const [index, segments] of variants.entries()) {
		const cues = segments.flatMap(segment => readScte35Sections(segment));
		expect(cues.length, `variant ${index + 1}`).toBe(1);
		expect(cues[0]!.time).toBeCloseTo(11.5, 4);
	}
}, 300_000);

// The playlist is what a player reads: the section in the transport stream tells an origin where the
// break is, and these tags tell the player. Every assertion below is on the playlist text, which is
// also what Apple's mediastreamvalidator would be given.
describe('ad markers in the media playlist', () => {
	const ANCHOR = new Date('2026-11-13T08:00:00.000Z');
	const HLS_BASE = 10;

	const publish = async (
		adMarkers: 'none' | 'daterange' | 'elemental-scte35' | 'elemental',
		cues: { section: number[]; options?: Scte35SectionOptions }[],
		options: { programDateTime?: Date } = {},
	) => {
		using input = new Input({
			source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
			formats: ALL_FORMATS,
		});

		const playlists: string[] = [];
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
				targetDuration: 1,
				adMarkers,
				...(options.programDateTime ? { programDateTime: options.programDateTime } : {}),
				onPlaylist: content => void playlists.push(content),
			}),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		const conversion = await Conversion.init({ input, output, audio: { discard: true } });
		for (const cue of cues) {
			addScte35Section(output, Uint8Array.from(cue.section), cue.options);
		}
		await conversion.execute();

		return playlists[playlists.length - 1]!;
	};

	/** A break opening at `seconds` and running for `duration`, then its matching close. */
	const breakOut = (seconds: number, duration: number) => spliceSection(
		0,
		Math.round(seconds * 90_000),
		{ outOfNetwork: true, duration: Math.round(duration * 90_000) },
	);
	const breakIn = (seconds: number) =>
		spliceSection(0, Math.round(seconds * 90_000), { outOfNetwork: false });

	test('daterange states the cue on the playlist\'s own wall clock', async () => {
		const playlist = await publish(
			'daterange',
			[{ section: [...breakOut(HLS_BASE + 1.5, 4)] }],
			{ programDateTime: ANCHOR },
		);

		const line = playlist.split('\n').find(l => l.startsWith('#EXT-X-DATERANGE'));
		expect(line, playlist).toBeDefined();
		expect(line).toMatch(/ID="1"/);
		expect(line).toMatch(/SCTE35-OUT=0x[0-9A-F]+/);
		expect(line).toMatch(/PLANNED-DURATION=4/);

		// START-DATE is the date of the segment the cue landed in, on the stated clock
		const startDate = /START-DATE="([^"]+)"/.exec(line!)![1]!;
		const offset = (Date.parse(startDate) - ANCHOR.getTime()) / 1000;
		expect(offset).toBeGreaterThanOrEqual(1);
		expect(offset).toBeLessThanOrEqual(2);

		// And it sits on the same date the segment's own PROGRAM-DATE-TIME states
		const lines = playlist.split('\n');
		const at = lines.indexOf(line!);
		const pdt = lines.slice(at).find(l => l.startsWith('#EXT-X-PROGRAM-DATE-TIME'));
		expect(pdt).toBe(`#EXT-X-PROGRAM-DATE-TIME:${startDate}`);
	}, 300_000);

	test('daterange without a clock says so rather than writing an invalid tag', async () => {
		const warnings: string[] = [];
		const off = Logging.on('warn', args => void warnings.push(args.join(' ')));

		try {
			const playlist = await publish('daterange', [{ section: [...breakOut(HLS_BASE + 1.5, 4)] }]);
			expect(playlist).not.toContain('#EXT-X-DATERANGE');
		} finally {
			off();
		}

		expect(warnings.join('\n')).toMatch(/programDateTime/);
	}, 300_000);

	test('the elemental tags open, continue and close the break', async () => {
		const playlist = await publish('elemental-scte35', [
			{ section: [...breakOut(HLS_BASE + 1, 3)] },
			{ section: [...breakIn(HLS_BASE + 4)] },
		]);

		expect(playlist).toContain('#EXT-OATCLS-SCTE35:');
		expect(playlist).toContain('#EXT-X-CUE-OUT:3');
		expect(playlist).toContain('#EXT-X-CUE-IN');
		// A segment inside the break says how far in it is, so a player joining mid-break knows
		expect(playlist).toMatch(/#EXT-X-CUE-OUT-CONT:\d+(\.\d+)?\/3/);

		// The out comes before the in, and every CONT between them
		const lines = playlist.split('\n').filter(l => l.startsWith('#EXT-X-CUE') || l.startsWith('#EXT-OATCLS'));
		const out = lines.findIndex(l => l.startsWith('#EXT-X-CUE-OUT:'));
		const back = lines.findIndex(l => l.startsWith('#EXT-X-CUE-IN'));
		expect(out).toBeGreaterThanOrEqual(0);
		expect(back).toBeGreaterThan(out);
		for (const [index, line] of lines.entries()) {
			if (line.startsWith('#EXT-X-CUE-OUT-CONT')) {
				expect(index).toBeGreaterThan(out);
				expect(index).toBeLessThan(back);
			}
		}
	}, 300_000);

	test('elemental without the OATCLS tag writes the cue tags alone', async () => {
		const playlist = await publish('elemental', [{ section: [...breakOut(HLS_BASE + 1, 3)] }]);

		expect(playlist).not.toContain('#EXT-OATCLS-SCTE35');
		expect(playlist).toContain('#EXT-X-CUE-OUT:3');
	}, 300_000);

	test('none writes no marker at all, and the section still rides in the segment', async () => {
		const playlist = await publish('none', [{ section: [...breakOut(HLS_BASE + 1, 3)] }]);

		expect(playlist).not.toContain('#EXT-X-DATERANGE');
		expect(playlist).not.toContain('#EXT-X-CUE-OUT');
		expect(playlist).not.toContain('#EXT-OATCLS-SCTE35');
	}, 300_000);

	test('an unknown mode is refused at construction', () => {
		expect(() => new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			adMarkers: 'oatcls' as unknown as 'none',
		})).toThrow(/adMarkers/);
	});
});

// Which segmentation types open an avail is an origin's decision, not this library's: a MediaTailor
// deployment counts {0x22, 0x30, 0x32, 0x34, 0x36}, a broadcast playout may count Ad Block or overlay
// types too. The derived answer is only the default.
describe('the caller\'s own decision about a cue', () => {
	const ANCHOR = new Date('2026-11-13T08:00:00.000Z');
	const HLS_BASE = 10;

	const playlistFor = async (
		section: number[],
		cueOptions: Scte35SectionOptions | undefined,
		adMarkers: 'daterange' | 'elemental' = 'elemental',
	) => {
		using input = new Input({
			source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
			formats: ALL_FORMATS,
		});

		const playlists: string[] = [];
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
				targetDuration: 1,
				adMarkers,
				programDateTime: ANCHOR,
				onPlaylist: content => void playlists.push(content),
			}),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		const conversion = await Conversion.init({ input, output, audio: { discard: true } });
		addScte35Section(output, Uint8Array.from(section), cueOptions);
		await conversion.execute();

		return playlists[playlists.length - 1]!;
	};

	/** An avail by the default rule, which the caller may still override. */
	const availStart = [...spliceSection(0, Math.round((HLS_BASE + 1) * 90_000), {
		outOfNetwork: true,
		duration: Math.round(5 * 90_000),
	})];

	/** The same section with a type id outside the avail set, stated rather than patched in. */
	const nonAvail = (typeId: number) => [...spliceSection(0, Math.round((HLS_BASE + 1) * 90_000), {
		typeId,
		duration: Math.round(5 * 90_000),
	})];

	test('a type the default calls no avail writes no CUE-OUT', async () => {
		const playlist = await playlistFor(nonAvail(0x46), undefined);

		expect(playlist).not.toContain('#EXT-X-CUE-OUT');
		expect(playlist).not.toContain('#EXT-X-CUE-IN');
	}, 300_000);

	test('the caller calling it a break writes one anyway', async () => {
		const playlist = await playlistFor(nonAvail(0x46), { outOfNetwork: true, breakDuration: 5 });

		expect(playlist).toContain('#EXT-X-CUE-OUT:5');
	}, 300_000);

	test('the caller can override a derived break back to nothing', async () => {
		const playlist = await playlistFor([...availStart], { outOfNetwork: null });

		expect(playlist).not.toContain('#EXT-X-CUE-OUT');
	}, 300_000);

	test('a stated duration beats the section\'s own', async () => {
		const playlist = await playlistFor([...availStart], { breakDuration: 12 });

		expect(playlist).toContain('#EXT-X-CUE-OUT:12');
		expect(playlist).not.toContain('#EXT-X-CUE-OUT:5');
	}, 300_000);

	test('a cue that opens no avail is SCTE35-CMD, never SCTE35-OUT', async () => {
		const playlist = await playlistFor(nonAvail(0x10), undefined, 'daterange');

		const line = playlist.split('\n').find(l => l.startsWith('#EXT-X-DATERANGE'));
		expect(line, playlist).toBeDefined();
		expect(line).toMatch(/SCTE35-CMD=0x/);
		expect(line).not.toMatch(/SCTE35-OUT/);
		// And no PLANNED-DURATION: there is no break being planned
		expect(line).not.toMatch(/PLANNED-DURATION/);
	}, 300_000);

	test('an out-of-range override is refused', () => {
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 1 }),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		const section = Uint8Array.from(availStart);
		expect(() => addScte35Section(output, section, { outOfNetwork: 1 as unknown as boolean }))
			.toThrow(/boolean or null/);
		expect(() => addScte35Section(output, section, { breakDuration: -1 }))
			.toThrow(/non-negative/);
	});
});

// A splice is normally stated exactly on a segment boundary, which is the case that was wrong: the
// placement compared the splice against the furthest any track's last packet reached rather than
// against the cut, and an audio frame overhanging the boundary by a few milliseconds pulled the cue
// into the segment before the one that starts there. Audio is kept here for exactly that reason.
describe('a splice on a segment boundary', () => {
	const ANCHOR = new Date('2026-11-13T08:00:00.000Z');
	// A playlist dates its segments from the start of the presentation, while a splice is stated on the
	// output's own media timeline - the one mediaTimestampBase shifts. The two differ by exactly that.
	const BASE = 10;

	/** Each segment's start, as the playlist dates it: zero-based, not on the media timeline. */
	const segmentStarts = (playlist: string) => {
		const starts: number[] = [];
		for (const line of playlist.split('\n')) {
			const pdt = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(line);
			if (pdt) {
				starts.push((Date.parse(pdt[1]!) - ANCHOR.getTime()) / 1000);
			}
		}

		return starts;
	};

	/** The date of the segment the CUE-OUT belongs to: the first one stated after the marker. */
	const markedSegmentDate = (playlist: string) => {
		const lines = playlist.split('\n');
		const at = lines.findIndex(line => line.startsWith('#EXT-X-CUE-OUT:'));
		if (at === -1) {
			return null;
		}

		for (const line of lines.slice(at)) {
			const pdt = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(line);
			if (pdt) {
				return (Date.parse(pdt[1]!) - ANCHOR.getTime()) / 1000;
			}
		}

		return null;
	};

	const publish = async (spliceSeconds: number) => {
		using input = new Input({
			source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
			formats: ALL_FORMATS,
		});

		const playlists: string[] = [];
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
				targetDuration: 2,
				adMarkers: 'elemental',
				programDateTime: ANCHOR,
				onPlaylist: content => void playlists.push(content),
			}),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		const conversion = await Conversion.init({ input, output });
		addScte35Section(output, spliceSection(0, Math.round(spliceSeconds * 90_000), {
			outOfNetwork: true,
			duration: Math.round(4 * 90_000),
		}));
		await conversion.execute();

		return playlists[playlists.length - 1]!;
	};

	// The cuts are whatever the key-frame grid makes them, so the expected segment is derived from the
	// playlist's own dates rather than from a boundary assumed here.
	test.each([0, 0.002, 0.5])('a splice %s s past a cut is marked on the segment that starts there', async (
		offset,
	) => {
		// The cuts are whatever the key-frame grid makes them, so they are read off a probe run rather
		// than assumed here
		const starts = segmentStarts(await publish(BASE));
		expect(starts.length, 'no PROGRAM-DATE-TIME to locate the cuts by').toBeGreaterThan(2);

		const cut = starts[1]!;
		const playlist = await publish(BASE + cut + offset);

		// Every offset here lands inside the segment that starts at `cut`, so all three expect its date
		expect(
			markedSegmentDate(playlist),
			`cuts ${starts.join(',')}, splice ${BASE + cut + offset}`,
		).toBeCloseTo(cut, 3);
	}, 300_000);
});

// A cue that opens no break gets no cue tags, and #EXT-OATCLS-SCTE35 is a cue tag: it only ever
// accompanies a CUE-OUT or a CUE-IN.
test('a cue that opens no avail gets no OATCLS line either', async () => {
	using input = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const playlists: string[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
			targetDuration: 2,
			adMarkers: 'elemental-scte35',
			programDateTime: new Date('2026-11-13T08:00:00.000Z'),
			onPlaylist: content => void playlists.push(content),
		}),
		target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
	});

	const conversion = await Conversion.init({ input, output, audio: { discard: true } });
	addScte35Section(
		output,
		spliceSection(0, Math.round(11.5 * 90_000), { outOfNetwork: true, duration: 90_000 }),
		{ outOfNetwork: null },
	);
	await conversion.execute();

	const playlist = playlists[playlists.length - 1]!;
	expect(playlist).not.toContain('#EXT-OATCLS-SCTE35');
	expect(playlist).not.toContain('#EXT-X-CUE-OUT');
	expect(playlist).not.toContain('#EXT-X-CUE-IN');
}, 300_000);

// A segment inside a break that happens to carry a section of its own - a heartbeat, a Program Start -
// is still inside the break, and a player joining there needs its position.
test('a segment carrying a non-avail cue still gets its CUE-OUT-CONT', async () => {
	using input = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const playlists: string[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
			targetDuration: 2,
			adMarkers: 'elemental',
			programDateTime: new Date('2026-11-13T08:00:00.000Z'),
			onPlaylist: content => void playlists.push(content),
		}),
		target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
	});

	const conversion = await Conversion.init({ input, output, audio: { discard: true } });
	// A break opening at the first cut, and a heartbeat landing inside it
	addScte35Section(output, spliceSection(0, Math.round(11 * 90_000), {
		outOfNetwork: true,
		duration: Math.round(4 * 90_000),
	}));
	addScte35Section(output, spliceSection(0, Math.round(13.5 * 90_000)), { outOfNetwork: null });
	await conversion.execute();

	const playlist = playlists[playlists.length - 1]!;
	expect(playlist).toContain('#EXT-X-CUE-OUT:4');
	expect(playlist, 'the heartbeat segment lost its CONT').toMatch(/#EXT-X-CUE-OUT-CONT:/);
}, 300_000);
