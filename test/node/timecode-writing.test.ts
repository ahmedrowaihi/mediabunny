/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Writing a broadcast timecode, in the carriage each format has for one: a `tmcd` track in a
// non-fragmented MP4 or MOV, and a bitstream SEI message everywhere else.
//
// The expected frame numbers here are derived from the timecode and the rate, never from a run of our
// own writer: 01:00:00;00 on a 29.97 drop-frame count is 107,892 frames because an hour drops two
// numbers a minute for 54 of its 60 minutes. ffmpeg's own file holds exactly that value, which is where
// the `tmcd` layout was read from.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { formatTimecode, parseTimecode } from '../../src/timecode.js';
import { findBox, parseBoxes, readU32, type MutableBox } from '../../src/crypto/box-tree.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');
const HEVC_SOURCE = path.join(__dirname, '../public/video-h265.mp4');

const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-tc-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

type WriteOptions = {
	timecode?: string;
	frameRate?: number;
	format?: 'mp4' | 'mov' | 'ts';
	fragmented?: boolean;
	/** Defaults to the AVC demo file; the HEVC one is what can carry a timecode in its bitstream. */
	source?: string;
	/** Stops after this many packets, for a test that only needs the first few frames. */
	packetLimit?: number;
	/** Starts at the key frame at or before this time, so the track does not begin at timestamp zero. */
	startAt?: number;
};

/** Remuxes a source file's video into a new file, stating the given timecode on the video track. */
const write = async ({
	timecode,
	frameRate,
	format = 'mp4',
	fragmented = false,
	source = SOURCE,
	packetLimit = Infinity,
	startAt,
}: WriteOptions) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(source) });
	const inputTrack = await input.getPrimaryVideoTrack();
	assert(inputTrack);
	const decoderConfig = await inputTrack.getDecoderConfig();
	assert(decoderConfig);

	const options = { fastStart: fragmented ? ('fragmented' as const) : (false as const) };
	const output = new Output({
		format: format === 'ts'
			? new MpegTsOutputFormat()
			: format === 'mov' ? new MovOutputFormat(options) : new Mp4OutputFormat(options),
		target: new BufferTarget(),
	});

	const codec = await inputTrack.getCodec();
	assert(codec);
	const packetSource = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(packetSource, { frameRate, timecode });

	await output.start();
	const sink = new EncodedPacketSink(inputTrack);
	let written = 0;
	const first = startAt === undefined ? await sink.getFirstPacket() : await sink.getKeyPacket(startAt);
	for (
		let packet = first;
		packet && written < packetLimit;
		packet = await sink.getNextPacket(packet)
	) {
		await packetSource.add(packet, { decoderConfig });
		written++;
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const traks = (bytes: Uint8Array) => {
	const moov = findBox(parseBoxes(bytes, 0, bytes.length), 'moov');
	assert(moov?.children);
	return moov.children.filter(x => x.type === 'trak');
};

const sampleEntryOf = (trak: MutableBox) => findBox([trak], 'stsd')?.children?.[0];
const timecodeTrak = (bytes: Uint8Array) => traks(bytes).find(trak => sampleEntryOf(trak)?.type === 'tmcd');
const dataOf = (box: MutableBox | null | undefined) => {
	assert(box?.data);
	return box.data;
};

/** The u32 the timecode track's single sample holds, reached through that track's own sample table. */
const statedFrameNumber = (bytes: Uint8Array) => {
	const trak = timecodeTrak(bytes);
	assert(trak);

	const stsz = dataOf(findBox([trak], 'stsz'));
	const stco = dataOf(findBox([trak], 'stco'));

	expect(readU32(stsz, 8), 'a timecode track holds exactly one sample').toBe(1);
	// `stsz` states one size for every sample, or zero and then a table of them
	const uniformSize = readU32(stsz, 4);
	expect(uniformSize || readU32(stsz, 12), 'which is a four-octet frame number').toBe(4);
	expect(readU32(stco, 4), 'in one chunk').toBe(1);

	return readU32(bytes, readU32(stco, 8));
};

describe('a tmcd track in a non-fragmented file', () => {
	test('the sample is the frame number the timecode names, dropped numbers and all', async () => {
		// 3600 s x 30000/1001 would be 107,892.1 frames; the count is 108,000 less the two numbers
		// dropped in each of the hour's 54 non-tenth minutes
		expect(statedFrameNumber(await write({ timecode: '01:00:00;00', frameRate: 30000 / 1001 })))
			.toBe(107_892);

		// Nothing is dropped at 25, so ten hours is exactly ten hours of frames
		expect(statedFrameNumber(await write({ timecode: '10:00:00:00', frameRate: 25 })))
			.toBe(25 * 3600 * 10);

		// The same written time on a non-drop 29.97 count names a different instant
		expect(statedFrameNumber(await write({ timecode: '01:00:00:00', frameRate: 30000 / 1001 })))
			.toBe(108_000);
	});

	test('the sample entry states the rate as a rational, not as 29.97', async () => {
		const entry = dataOf(sampleEntryOf(timecodeTrak(await write({
			timecode: '01:00:00;00',
			frameRate: 30000 / 1001,
		}))!));

		// 6 reserved + 2 data reference index + 4 reserved, then flags, timescale, frame duration
		expect(readU32(entry, 12), 'flags bit 0 states a drop-frame count').toBe(1);
		expect(readU32(entry, 16)).toBe(30_000);
		expect(readU32(entry, 20)).toBe(1001);
		expect(entry[24], 'frames per second, rounded').toBe(30);

		const nonDrop = dataOf(sampleEntryOf(timecodeTrak(await write({
			timecode: '01:00:00:00',
			frameRate: 30000 / 1001,
		}))!));
		expect(readU32(nonDrop, 12) & 1, 'and is clear for a non-drop count').toBe(0);
		expect(readU32(nonDrop, 16), 'while the rate is the same either way').toBe(30_000);
	});

	test('the video track points at it, and it is neither enabled nor presented', async () => {
		const bytes = await write({ timecode: '01:00:00;00', frameRate: 30000 / 1001 });

		const tkhd = dataOf(findBox([timecodeTrak(bytes)!], 'tkhd'));
		const timecodeTrackId = readU32(tkhd, 12);

		const videoTrak = traks(bytes).find(x => sampleEntryOf(x)?.type !== 'tmcd');
		assert(videoTrak);

		// The reference goes on the video track and names the timecode track: the timecode is that
		// track's, not the file's. `tref` holds its child box whole, so the type and id are read out of it
		const tref = dataOf(findBox([videoTrak], 'tref'));
		expect(String.fromCharCode(...tref.subarray(4, 8))).toBe('tmcd');
		expect(readU32(tref, 8)).toBe(timecodeTrackId);

		// A timecode track is read, never shown: track-in-movie without track-enabled
		const flags = readU32(tkhd, 0) & 0xffffff;
		expect(flags & 0x1, 'the timecode track must not be enabled').toBe(0);
		expect(flags & 0x2, 'but it is in the movie').toBe(0x2);

		// While the video track it labels stays enabled
		expect(readU32(dataOf(findBox([videoTrak], 'tkhd')), 0) & 0x1).toBe(0x1);
	});

	test('no timecode means no track and no reference', async () => {
		const bytes = await write({});
		expect(timecodeTrak(bytes)).toBeUndefined();
		expect(findBox([traks(bytes)[0]!], 'tref')).toBeNull();
	});

	test('MOV carries it the same way', async () => {
		expect(statedFrameNumber(await write({
			timecode: '01:00:00;00',
			frameRate: 30000 / 1001,
			format: 'mov',
		}))).toBe(107_892);
	});

	test('a timecode without a frame rate is refused rather than guessed', async () => {
		await expect(write({ timecode: '01:00:00:00' })).rejects.toThrow(/alongside metadata.frameRate/);
	});
});

describe.skipIf(!hasFfprobe)('ffprobe reads back what we wrote', () => {
	const probe = async (options: WriteOptions, name: string) => {
		const file = path.join(workDir, name);
		writeFileSync(file, await write(options));
		// A STREAM tag, not a format one: the timecode belongs to the video track it is referenced by,
		// and `format_tags=timecode` comes back empty for ffmpeg's own files too
		return execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v',
			'-show_entries', 'stream_tags=timecode', '-of', 'default=nw=1:nk=1', file,
		], { encoding: 'utf8' }).trim();
	};

	test('a drop-frame timecode comes back with its semicolon', async () => {
		expect(await probe({ timecode: '01:00:00;00', frameRate: 30000 / 1001 }, 'drop.mp4'))
			.toBe('01:00:00;00');
	});

	test('a non-drop timecode comes back with its colon', async () => {
		expect(await probe({ timecode: '10:00:00:00', frameRate: 25 }, 'nondrop.mp4'))
			.toBe('10:00:00:00');
		expect(await probe({ timecode: '01:00:00:00', frameRate: 30000 / 1001 }, 'nondrop2997.mp4'))
			.toBe('01:00:00:00');
	});

	test('an odd timecode survives, not just the round hours', async () => {
		expect(await probe({ timecode: '13:47:29;21', frameRate: 30000 / 1001 }, 'odd.mp4'))
			.toBe('13:47:29;21');
	});

	test('MOV too, which is where the layout came from', async () => {
		expect(await probe({ timecode: '01:00:00;00', frameRate: 30000 / 1001, format: 'mov' }, 'drop.mov'))
			.toBe('01:00:00;00');
	});
});

// MPEG-TS has no timecode track, so the only carriage is the bitstream, and the message states the
// picture it rides rather than the stream: a different value on every frame. ffmpeg's own HEVC parser
// reads these back as SMPTE 12-1 side data, which is what makes it an oracle rather than a round trip
// through our own reader.
describe.skipIf(!hasFfprobe)('a time_code SEI in an MPEG-TS', () => {
	/** Every frame's decoded timecode, in the order ffprobe reports them. */
	const decodedTimecodes = async (options: WriteOptions, name: string) => {
		const file = path.join(workDir, name);
		writeFileSync(file, await write({ format: 'ts', source: HEVC_SOURCE, ...options }));

		const dump = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v', '-show_frames', '-of', 'json', file,
		], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

		return (JSON.parse(dump) as {
			frames: { side_data_list?: { side_data_type: string; timecodes?: { value: string }[] }[] }[];
		}).frames.flatMap(frame => (frame.side_data_list ?? [])
			.filter(x => x.side_data_type === 'SMPTE 12-1 timecode')
			.map(x => x.timecodes![0]!.value));
	};

	test('every frame carries its own timecode, counting up from the first', async () => {
		// The source is 300 frames at 30 fps, so the labels are exactly 01:00:00:00 through 01:00:09:29 -
		// a set, because ffprobe reports frames in decode order while the label follows presentation time
		const decoded = await decodedTimecodes({ timecode: '01:00:00:00', frameRate: 30 }, 'hevc.ts');
		const expected = Array.from({ length: 300 }, (_, n) =>
			`01:00:${String(Math.floor(n / 30)).padStart(2, '0')}:${String(n % 30).padStart(2, '0')}`);

		expect(decoded).toHaveLength(300);
		expect(new Set(decoded).size, 'no two frames share a timecode').toBe(300);
		expect([...decoded].sort()).toEqual(expected.sort());
	// Decoding 300 frames takes about a second alone and over five under the parallel suite
	}, 30_000);

	// These assert on the SET of labels rather than the first few in order. ffprobe reports frames as it
	// decodes them while the label follows presentation time, so the order is the stream's reordering and
	// says nothing about the writer; what the labels ARE is the property under test.
	test('a drop-frame count skips the numbers that do not exist, across the minute', async () => {
		// Starting one frame before a minute, the count goes ...;29 then 00:01:00;02. 00:01:00;00 and
		// ;01 are the two numbers a drop-frame count skips there: a writer that merely incremented would
		// emit timecodes that never occur.
		// Three seconds of frames is enough to cross the minute; the labels are what is under test, so
		// the truncated tail costs nothing
		const labels = await decodedTimecodes(
			{ timecode: '00:00:59;29', frameRate: 30000 / 1001, packetLimit: 90 },
			'drop-boundary.ts',
		);
		const decoded = new Set(labels);

		expect(decoded.size, 'one distinct label per frame').toBe(labels.length);
		expect(decoded).toContain('00:00:59;29');
		expect(decoded, 'the minute opens on ;02').toContain('00:01:00;02');
		expect(decoded, '00:01:00;00 does not exist on a drop-frame count').not.toContain('00:01:00;00');
		expect(decoded).not.toContain('00:01:00;01');
	});

	test('the tenth minute drops nothing, so the count runs straight through it', async () => {
		const decoded = new Set(await decodedTimecodes(
			{ timecode: '00:09:59;29', frameRate: 30000 / 1001, packetLimit: 90 },
			'tenth-minute.ts',
		));
		// The minute after it drops again, which is the same stream a minute on
		const eleventh = new Set(await decodedTimecodes(
			{ timecode: '00:10:59;29', frameRate: 30000 / 1001, packetLimit: 90 },
			'eleventh-minute.ts',
		));

		expect(eleventh, '00:11:00;00 does not exist').not.toContain('00:11:00;00');
		expect(eleventh).toContain('00:11:00;02');

		expect(decoded, 'the tenth minute keeps its ;00').toContain('00:10:00;00');
		expect(decoded).toContain('00:10:00;01');
	});

	test('the stated timecode lands on the first frame, not on time zero', async () => {
		const decoded = await decodedTimecodes({ timecode: '04:30:00:00', frameRate: 30 }, 'offset.ts');

		// The earliest label is the stated one, and 300 frames at 30 fps reach exactly ten seconds later
		expect([...decoded].sort()[0]).toBe('04:30:00:00');
		expect([...decoded].sort().at(-1)).toBe('04:30:09:29');
	}, 30_000);

	test('a track that begins part way in still gets the timecode on its own first frame', async () => {
		// The source's second key frame is at 8.3333 s, so starting there the first picture written is
		// the one the timecode labels. Counting the frame index off the timestamp instead would start
		// this track at 04:30:08:10 - right only for a track that happens to begin at zero.
		const decoded = await decodedTimecodes(
			{ timecode: '04:30:00:00', frameRate: 30, startAt: 9 },
			'late-start.ts',
		);

		expect(decoded.length, 'the tail of the source, not all of it').toBeGreaterThan(20);
		expect(decoded.length).toBeLessThan(300);
		expect([...decoded].sort()[0]).toBe('04:30:00:00');
	}, 30_000);
});

describe('refusals, where a bitstream cannot carry one', () => {
	test('a fragmented AVC file whose SPS declares no pic_struct is refused, not written wrong', async () => {
		// `pic_timing` is read against the SPS rather than being self-describing, so a message written
		// into a stream that declares no `pic_struct` would be parsed as whatever those bits mean there
		await expect(write({ timecode: '01:00:00:00', frameRate: 30, fragmented: true }))
			.rejects.toThrow(/pic_struct_present_flag/);
	});

	test('the same AVC track is fine non-fragmented, where the tmcd track carries it', async () => {
		expect(statedFrameNumber(await write({ timecode: '01:00:00:00', frameRate: 30 })))
			.toBe(30 * 3600);
	});

	test('a fragmented HEVC file carries it in the bitstream instead of a tmcd track', async () => {
		const bytes = await write({
			timecode: '01:00:00:00',
			frameRate: 30,
			fragmented: true,
			source: HEVC_SOURCE,
			packetLimit: 4,
		});

		expect(timecodeTrak(bytes), 'no tmcd track in a fragmented file').toBeUndefined();

		// A length-prefixed prefix SEI NAL unit: 11 octets of `4e 01` (PREFIX_SEI_NUT, layer 0, tid 1),
		// payload type 136, payload size 6, then the six octets of the message
		const seiHeader = [0x00, 0x00, 0x00, 0x0b, 0x4e, 0x01, 136, 6];
		const found = bytes.findIndex((_, i) => seiHeader.every((byte, j) => bytes[i + j] === byte));
		expect(found, 'a time_code SEI must be in the samples').toBeGreaterThan(0);

		// One per access unit, since each states its own picture's timecode
		let count = 0;
		for (let i = 0; i < bytes.length; i++) {
			if (seiHeader.every((byte, j) => bytes[i + j] === byte)) {
				count++;
			}
		}
		expect(count, 'one per frame, not one per key frame').toBe(4);
	});
});

// Reading and writing have to meet: a timecode read off an input, stated back on an output track, must
// name the same instant. `formatTimecode` is the join, and without it a caller holding a StartTimecode
// has no way to say it.
describe('a timecode survives a read and a write', () => {
	const roundTrip = async (fixture: string, format: 'mp4' | 'mov' = 'mp4') => {
		const input = new Input({
			formats: ALL_FORMATS,
			source: new FilePathSource(path.join(__dirname, '../public', fixture)),
		});
		const inputTrack = await input.getPrimaryVideoTrack();
		assert(inputTrack);

		const read = await inputTrack.getStartTimecode();
		assert(read);

		return {
			read,
			written: await write({
				timecode: formatTimecode(read),
				frameRate: read.frameRate,
				source: path.join(__dirname, '../public', fixture),
				format,
			}),
		};
	};

	test('a drop-frame timecode comes back as the same frame number', async () => {
		const { read, written } = await roundTrip('timecode-df-2997.mov');

		expect(read.dropFrame).toBe(true);
		expect(formatTimecode(read)).toBe('01:00:00;00');
		expect(statedFrameNumber(written)).toBe(107_892);
	});

	test('a non-drop timecode too, at a different rate', async () => {
		const { read, written } = await roundTrip('timecode-ndf-25.mov', 'mov');

		expect(read.dropFrame).toBe(false);
		expect(formatTimecode(read)).toBe('10:00:00:00');
		expect(statedFrameNumber(written)).toBe(25 * 3600 * 10);
	});

	test('the written string is what parseTimecode reads back', () => {
		// The pair has to be inverses, or a read-then-write loses the drop-frame count
		for (const text of ['01:00:00;00', '10:00:00:00', '23:59:59:24', '00:01:00;02']) {
			const rate = text.includes(';') ? 30000 / 1001 : 25;
			expect(formatTimecode(parseTimecode(text, rate))).toBe(text);
		}
	});
});

// An interlaced AVC stream is the AVC case that CAN carry a timecode — x264 sets
// `pic_struct_present_flag` to state the field order — and it is therefore the case that already has a
// `pic_timing` SEI on every picture. The clock timestamps have to go INTO that message: a second one is
// not something a decoder can read, and it would also state `pic_struct` 0 over the field order the
// first one declares, telling the decoder a field pair is a progressive frame.
//
// ffprobe's DECODER cannot see either fault — it read the timecode back happily from a stream carrying
// two malformed messages. `trace_headers` is ffmpeg's conformance parser and does, which is the only
// reason this was caught; see the note on `time_offset` below.
/**
 * Every `pic_timing` SEI payload in an elementary stream, in bitstream order.
 *
 * `annexB` walks start codes, which is a transport stream's framing once de-packetized; `lengthPrefixed`
 * walks four-octet lengths inside an `mdat`, which is an MP4's.
 */
const picTimingPayloads = (bytes: Uint8Array, framing: 'annexB' | 'lengthPrefixed') => {
	const payloads: Uint8Array[] = [];
	const source = framing === 'annexB' ? elementaryStreamOf(bytes) : bytes;

	const readMessage = (at: number) => {
		let pos = at;
		let payloadType = 0;
		while (source[pos] === 0xff) {
			payloadType += 255;
			pos++;
		}
		payloadType += source[pos]!;
		pos++;

		let payloadSize = 0;
		while (source[pos] === 0xff) {
			payloadSize += 255;
			pos++;
		}
		payloadSize += source[pos]!;
		pos++;

		if (payloadType === 1) {
			payloads.push(source.subarray(pos, pos + payloadSize));
		}
	};

	if (framing === 'annexB') {
		for (let i = 0; i + 3 < source.length; i++) {
			if (source[i] === 0 && source[i + 1] === 0 && source[i + 2] === 1 && (source[i + 3]! & 0x1f) === 6) {
				readMessage(i + 4);
			}
		}
		return payloads;
	}

	// Walk the file for `mdat`, then its samples' NAL units. The box walk is deliberately shallow: the
	// only thing needed is the run of length-prefixed NAL units.
	const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
	let pos = 0;
	while (pos + 8 <= source.length) {
		const size = view.getUint32(pos);
		const type = String.fromCharCode(...source.subarray(pos + 4, pos + 8));
		if (type === 'mdat') {
			let at = pos + 8;
			const end = size === 0 ? source.length : pos + size;
			while (at + 4 <= end) {
				const length = view.getUint32(at);
				if (length === 0 || at + 4 + length > end) {
					break;
				}
				if ((source[at + 4]! & 0x1f) === 6) {
					readMessage(at + 5);
				}
				at += 4 + length;
			}
		}
		if (size < 8) {
			break;
		}
		pos += size;
	}

	return payloads;
};

/** The video PID's payload bytes of an MPEG-TS, concatenated. */
const elementaryStreamOf = (ts: Uint8Array, videoPid = 0x100) => {
	const out: number[] = [];
	for (let off = 0; off + 188 <= ts.length; off += 188) {
		if (ts[off] !== 0x47) {
			continue;
		}
		if ((((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!) !== videoPid) {
			continue;
		}

		const adaptationControl = (ts[off + 3]! >> 4) & 0b11;
		if (adaptationControl === 0b10) {
			continue;
		}

		let start = off + 4;
		if (adaptationControl === 0b11) {
			start += 1 + ts[off + 4]!;
		}
		for (let i = start; i < off + 188; i++) {
			out.push(ts[i]!);
		}
	}

	return new Uint8Array(out);
};

describe.skipIf(!hasFfprobe)('interlaced AVC, where a pic_timing already exists', () => {
	let interlaced: string;

	beforeAll(() => {
		interlaced = path.join(workDir, 'interlaced.mp4');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=352x288:rate=25:duration=1',
			'-vf', 'setfield=tff,format=yuv420p', '-c:v', 'libx264',
			'-x264opts', 'interlaced=1:tff=1', '-flags', '+ilme+ildct', interlaced,
		]);
	});

	/** The SEI payload types in each access unit of an MPEG-TS, split on the access unit delimiters. */
	const seiPerAccessUnit = (file: string, videoPid = 0x100) => {
		const ts = readFileSync(file);
		const elementary: number[] = [];

		for (let off = 0; off + 188 <= ts.length; off += 188) {
			if (ts[off] !== 0x47) {
				continue;
			}
			if ((((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!) !== videoPid) {
				continue;
			}

			const adaptationControl = (ts[off + 3]! >> 4) & 0b11;
			if (adaptationControl === 0b10) {
				continue; // Adaptation field only, no payload
			}

			let start = off + 4;
			if (adaptationControl === 0b11) {
				start += 1 + ts[off + 4]!;
			}
			for (let i = start; i < off + 188; i++) {
				elementary.push(ts[i]!);
			}
		}

		const bytes = new Uint8Array(elementary);
		const accessUnits: Record<number, number>[] = [];
		const payloadSizes: Record<number, number>[] = [];
		let current: Record<number, number> = {};
		let sizes: Record<number, number> = {};

		for (let i = 0; i + 3 < bytes.length; i++) {
			if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) {
				continue;
			}

			const type = bytes[i + 3]! & 0x1f;
			if (type === 9) { // Access unit delimiter
				if (Object.keys(current).length > 0) {
					accessUnits.push(current);
					payloadSizes.push(sizes);
				}
				current = {};
				sizes = {};
			}
			if (type === 6) { // SEI
				let at = i + 4;
				let payloadType = 0;
				while (bytes[at] === 0xff) {
					payloadType += 255;
					at++;
				}
				payloadType += bytes[at]!;
				at++;
				let payloadSize = 0;
				while (bytes[at] === 0xff) {
					payloadSize += 255;
					at++;
				}
				payloadSize += bytes[at]!;

				current[payloadType] = (current[payloadType] ?? 0) + 1;
				sizes[payloadType] = payloadSize;
			}
		}
		if (Object.keys(current).length > 0) {
			accessUnits.push(current);
			payloadSizes.push(sizes);
		}

		return { accessUnits, payloadSizes };
	};

	test('the existing pic_timing is rewritten, not joined by a second', async () => {
		const file = path.join(workDir, 'interlaced-tc.ts');
		writeFileSync(file, await write({
			timecode: '01:00:00:00',
			frameRate: 25,
			format: 'ts',
			source: interlaced,
		}));

		const { accessUnits, payloadSizes } = seiPerAccessUnit(file);
		expect(accessUnits.length, 'a second of 25 fps').toBe(25);
		for (const [index, unit] of accessUnits.entries()) {
			expect(unit[1], `access unit ${index} must carry exactly one pic_timing`).toBe(1);
		}

		// The message's width is fixed by the SPS and `pic_struct`, so it can be stated outright:
		// pic_struct (4 bits) + two clock timestamps, each 37 bits plus a 24-bit time_offset that
		// D.2.2 INFERS because this SPS declares no HRD, then the alignment bit. 127 bits, 16 octets.
		// A writer that took absent HRD to mean a zero-width offset emits 10, and ffmpeg's conformance
		// parser does not flag that - it catches a message running past the end of its NAL unit, not
		// one that merely disagrees with its own declared payload size.
		const expectedBits = 4 + 2 * (37 + 24) + 1;
		for (const [index, sizes] of payloadSizes.entries()) {
			expect(sizes[1], `access unit ${index}'s pic_timing width`).toBe(Math.ceil(expectedBits / 8));
		}
	});

	test('ffmpeg\'s conformance parser accepts the rewritten message', async () => {
		const file = path.join(workDir, 'interlaced-strict.ts');
		writeFileSync(file, await write({
			timecode: '01:00:00:00',
			frameRate: 25,
			format: 'ts',
			source: interlaced,
		}));

		// `trace_headers` reads every syntax element against the SPS, and catches a message that runs
		// past the end of its NAL unit - which is what a second, short `pic_timing` appended in its own
		// NAL does. Measured limit: it does NOT flag a message that merely disagrees with its own
		// declared payload size, so the width is asserted outright in the test above rather than left
		// to this. ffmpeg also exits 0 while printing the error, so stderr is the signal, not the status.
		// ffmpeg writes its diagnostics to stderr, which `execFileSync` does not return
		const run = spawnSync('ffmpeg', [
			'-v', 'error', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
		], { encoding: 'utf8' });

		expect(run.stderr).not.toMatch(/time_offset/);
		expect(run.stderr.trim(), 'the parser must report nothing at all').toBe('');
		expect(run.status).toBe(0);
	});

	test('an HRD stream keeps its own delay fields rather than having them zeroed', async () => {
		// `cpb_removal_delay` and `dpb_output_delay` hold this picture's place in the HRD schedule,
		// which a timecode says nothing about. Rebuilding the message with zeros there would misstate
		// the buffer model of a stream whose whole point is conforming to one.
		const hrdSource = path.join(workDir, 'hrd.mp4');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=352x288:rate=25:duration=1',
			'-vf', 'setfield=tff,format=yuv420p', '-c:v', 'libx264',
			'-x264opts', 'interlaced=1:tff=1:nal-hrd=vbr:vbv-maxrate=2000:vbv-bufsize=4000',
			'-flags', '+ilme+ildct', hrdSource,
		]);

		const file = path.join(workDir, 'hrd-tc.ts');
		writeFileSync(file, await write({
			timecode: '01:00:00:00',
			frameRate: 25,
			format: 'ts',
			source: hrdSource,
		}));

		// This SPS states cpbRemovalDelayLength 13 and dpbOutputDelayLength 7, so the delays are the
		// payload's leading 20 bits; timeOffsetLength is 0, so no time_offset follows the timestamps
		const delaysOf = (payloads: Uint8Array[]) => payloads.map((payload) => {
			let bits = '';
			for (const byte of payload.subarray(0, 3)) {
				bits += byte.toString(2).padStart(8, '0');
			}
			return [parseInt(bits.slice(0, 13), 2), parseInt(bits.slice(13, 20), 2)] as const;
		});

		const ours = delaysOf(picTimingPayloads(readFileSync(file), 'annexB'));
		const theirs = delaysOf(picTimingPayloads(readFileSync(hrdSource), 'lengthPrefixed'));

		expect(ours.length).toBe(25);
		expect(theirs.length).toBe(25);
		// Compared against the source's own values, not merely checked for being non-zero: the
		// encoder's schedule is the only thing that says what belongs here
		expect(new Set(ours.map(String))).toEqual(new Set(theirs.map(String)));
		expect(new Set(ours.map(x => x[0])).size, 'the removal delays genuinely vary').toBeGreaterThan(1);
	});

	test('the field order survives, and every frame gets its own timecode', async () => {
		const file = path.join(workDir, 'interlaced-fields.ts');
		writeFileSync(file, await write({
			timecode: '01:00:00:00',
			frameRate: 25,
			format: 'ts',
			source: interlaced,
		}));

		// `pic_struct` 3 is a top field then a bottom one. Writing a fresh message over it would make
		// this read `progressive`, and the stream would play with its fields swapped.
		// An MPEG-TS reports a stream group as well as the stream, so this prints twice
		const fieldOrder = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=field_order',
			'-of', 'default=nw=1:nk=1', file,
		], { encoding: 'utf8' }).trim().split('\n');
		expect(fieldOrder[0], 'top field first, top coded first').toBe('tt');

		const dump = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v', '-show_frames', '-of', 'json', file,
		], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
		const frames = (JSON.parse(dump) as {
			frames: { side_data_list?: { side_data_type: string; timecodes?: { value: string }[] }[] }[];
		}).frames;

		// A field pair carries TWO clock timestamps, one per field, both stating the frame's timecode:
		// SMPTE 12M counts frames, and the two fields of one are the same instant
		const perFrame = frames.map(frame => (frame.side_data_list ?? [])
			.filter(x => x.side_data_type === 'SMPTE 12-1 timecode')
			.flatMap(x => x.timecodes!.map(t => t.value)));

		expect(perFrame).toHaveLength(25);
		expect(perFrame.every(x => x.length === 2), 'two clock timestamps per field pair').toBe(true);
		expect(perFrame.every(([a, b]) => a === b), 'both fields state the frame').toBe(true);
		expect(new Set(perFrame.map(x => x[0]!))).toEqual(
			new Set(Array.from({ length: 25 }, (_, n) => `01:00:00:${String(n).padStart(2, '0')}`)),
		);
	});
});
