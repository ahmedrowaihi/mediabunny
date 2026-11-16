/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MXF OP1a, remuxed from the fragmented MP4 an Output writes. Everything asserted here is read back with
// ffprobe or decoded with ffmpeg: the point of going through FFmpeg's muxer rather than writing KLV by
// hand is that conformance is not ours to claim.
//
// Two bitstream filters are required and FFmpeg's CLI inserts them silently, which is the trap this
// covers: `h264_mp4toannexb`, because MXF carries AVC as Annex B, and `pcm_rechunk` at the video frame
// rate, because OP1a is frame-wrapped.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MxfTarget, registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

const hasFfmpeg = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-mxf-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Converts the fixture into MXF at `name`, through a fragmented MP4 as the target requires. */
const writeMxf = async (
	name: string,
	options: Parameters<typeof MxfTarget>[1] = {},
	video: { codec?: 'mpeg2' } = {},
) => {
	const file = path.join(workDir, name);
	using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
	const target = new MxfTarget(file, options);
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target,
	});

	const conversion = await Conversion.init({
		input,
		output,
		// All-intra, which is what MXF OP1a delivery is for - AVC-Intra has no B-frames. A reordered
		// stream remuxes into MXF with non-monotonic DTS, and **ffmpeg's own CLI does the same on the
		// same input**, so that is a property of putting B-frames in MXF rather than of this target.
		video: video.codec === 'mpeg2'
			// XDCAM HD422's own shape, which is what the bit rate below is stated for
			? { codec: 'mpeg2' as const, bitrate: 50_000_000, keyFrameInterval: 0.5 }
			: { keyFrameInterval: 0 },
		// MXF carries frame-wrapped PCM, never AAC, so the audio is converted
		audio: { codec: 'pcm-s24', sampleRate: 48_000 },
		trim: { end: 0.4 },
	});
	await conversion.execute();

	return { file, target };
};

/** The MPEG-2 video descriptor's set key (SMPTE 377M), whose local tag 0x8000 is its `BitRate`. */
const MPEG_VIDEO_DESCRIPTOR_KEY = Uint8Array.from([
	0x06, 0x0e, 0x2b, 0x34, 0x02, 0x53, 0x01, 0x01, 0x0d, 0x01, 0x01, 0x01, 0x01, 0x01, 0x51, 0x00,
]);

/** The `BitRate` of the first MPEG-2 video descriptor in the file, read out of the KLV. */
const mpegVideoBitRate = (bytes: Buffer): number => {
	const at = bytes.indexOf(Buffer.from(MPEG_VIDEO_DESCRIPTOR_KEY));
	expect(at, 'the file has no MPEG-2 video descriptor').toBeGreaterThanOrEqual(0);

	// BER length: a high bit means the byte counts the length bytes that follow
	let pos = at + MPEG_VIDEO_DESCRIPTOR_KEY.length;
	const first = bytes[pos]!;
	let length: number;
	if (first & 0x80) {
		const count = first & 0x7f;
		length = Number(bytes.subarray(pos + 1, pos + 1 + count).reduce((sum, b) => sum * 256 + b, 0));
		pos += 1 + count;
	} else {
		length = first;
		pos += 1;
	}

	const end = pos + length;
	while (pos + 4 <= end) {
		const tag = bytes.readUInt16BE(pos);
		const size = bytes.readUInt16BE(pos + 2);
		pos += 4;
		if (tag === 0x8000) {
			expect(size).toBe(4);
			return bytes.readUInt32BE(pos);
		}
		pos += size;
	}

	throw new Error('The MPEG-2 video descriptor states no BitRate.');
};

/**
 * ffmpeg's complaints go to stderr, and `execFileSync` returns stdout - which is always empty for a null
 * decode, so asserting on it proves nothing. This captures stderr instead.
 */
const decodeErrors = (file: string, map: string[] = []) => {
	const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, ...map, '-f', 'null', '-'], {
		encoding: 'utf8',
	});
	return result.stderr.trim();
};

/** ffprobe prefixes metadata with `TAG:`, which is dropped so a caller can ask for the key it named. */
const probe = (file: string, entries: string) => execFileSync('ffprobe', [
	'-v', 'error', '-show_entries', entries, '-of', 'default=noprint_wrappers=1', file,
], { encoding: 'utf8' })
	.trim()
	.split('\n')
	.map(line => line.replace(/^TAG:/, '').trim())
	.filter(Boolean);

describe.skipIf(!hasFfmpeg)('MxfTarget', () => {
	test('writes an OP1a file that ffprobe reads as mxf and ffmpeg decodes', async () => {
		const { file, target } = await writeMxf('plain.mxf');

		const format = probe(file, 'format=format_name');
		expect(format).toContain('format_name=mxf');

		// FFmpeg's own muxer identity, which is what makes "OP1a" a fact rather than a claim. The
		// operational pattern UL ends 01010900 for OP1a.
		const tags = probe(file, 'format_tags=operational_pattern_ul,product_name');
		expect(tags.join(' ')).toMatch(/operational_pattern_ul=060e2b34\.04010101\.0d010201\.01010900/);
		expect(tags.join(' ')).toMatch(/product_name=OP1a Muxer/);

		// Every stream decodes, with nothing on stderr
		expect(decodeErrors(file)).toBe('');

		expect(target.writtenPackets).toBeGreaterThan(0);
	}, 300_000);

	test('the video essence is Annex B, read off the first packet', async () => {
		const { file } = await writeMxf('annexb.mxf');

		// The first bytes of the first video packet, which is the only place this is decidable: an Annex B
		// start code, or a four-byte length prefix. Nothing here inserts a bitstream filter - libavformat's
		// mxf muxer does its own conversion - so this is what makes that claim checkable rather than
		// assumed.
		const first = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_data',
			'-read_intervals', '%+#1', '-of', 'default=noprint_wrappers=1', file,
		], { encoding: 'utf8' });

		const dump = first.split('\n').find(line => /^00000000:/.test(line.trim()));
		expect(dump).toBeDefined();
		expect(dump!.trim().replace(/\s+/g, ' ')).toMatch(/^00000000: 0000 0001/);

		// And the decoder agrees, which is the claim that matters
		expect(decodeErrors(file, ['-map', '0:v:0'])).toBe('');
	}, 300_000);

	test('audio MXF cannot carry is refused by name, not as a muxer error', async () => {
		// AAC is the trap: MXF takes frame-wrapped PCM, and the muxer's own refusal is a bare
		// `Invalid argument` - ffmpeg's CLI fails identically on the same input.
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new MxfTarget(path.join(workDir, 'aac.mxf')),
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: { keyFrameInterval: 0 },
			audio: { codec: 'aac' },
			trim: { end: 0.4 },
		});

		await expect(conversion.execute()).rejects.toThrow(/frame-wrapped PCM audio/);
	}, 300_000);

	test('a start timecode becomes the file timecode', async () => {
		const { file } = await writeMxf('timecode.mxf', { startTimecode: '10:00:00:00' });
		expect(probe(file, 'format_tags=timecode')).toContain('timecode=10:00:00:00');

		// The control. MXF always carries a timecode track - FFmpeg's muxer writes one either way - so the
		// claim is that the option changed it, not that it created it.
		const { file: plain } = await writeMxf('no-timecode.mxf');
		expect(probe(plain, 'format_tags=timecode')).toEqual(['timecode=00:00:00:00']);
	}, 300_000);

	// MXF is the one container here where identical input does not give an identical file: mxfenc draws
	// the UMIDs at random. The essence repeats exactly either way; it is those bytes that move.
	// The existing test above writes twice back to back. A consumer saw two MXF writes differ once in a
	// loaded suite and read it as FFmpeg stamping the wall clock into the Preface's LastModifiedDate and
	// each Identification set's ModificationDate. Measured, that is not what differs: pinning those dates
	// leaves the files differing at their UMIDs, which `bitexact` is what suppresses. And the two runs
	// have to mux **the same encode** - re-encoding twice varies in the essence, which is the encoder's
	// doing and nothing the MXF writer can fix.
	test('the same essence muxed twice across a second boundary is byte-identical', async () => {
		const crossSecond = async () => {
			const second = Math.floor(Date.now() / 1000);
			while (Math.floor(Date.now() / 1000) === second) {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
		};

		const first = await writeMxf('second-a.mxf', { bitexact: true });
		await crossSecond();
		const second = await writeMxf('second-b.mxf', { bitexact: true });

		expect(readFileSync(second.file).equals(readFileSync(first.file))).toBe(true);
	}, 300_000);

	test('creationTime pins the file dates, and defaults to the epoch', async () => {
		const byDefault = await writeMxf('epoch.mxf');
		expect(probe(byDefault.file, 'format_tags=modification_date').join(' '))
			.toContain('1970-01-01T00:00:00.000000Z');

		const stated = await writeMxf('dated.mxf', { creationTime: new Date('2001-02-03T04:05:06Z') });
		expect(probe(stated.file, 'format_tags=modification_date').join(' '))
			.toContain('2001-02-03T04:05:06.000000Z');
	}, 300_000);

	test('bitexact makes two writes byte-identical, and its absence does not', async () => {
		const first = await writeMxf('exact-a.mxf', { bitexact: true, startTimecode: '10:00:00:00' });
		const second = await writeMxf('exact-b.mxf', { bitexact: true, startTimecode: '10:00:00:00' });
		expect(readFileSync(second.file).equals(readFileSync(first.file))).toBe(true);

		// Still a conformant OP1a with the timecode intact, which is what the flag must not cost
		expect(probe(first.file, 'format=format_name')).toContain('format_name=mxf');
		expect(probe(first.file, 'format_tags=operational_pattern_ul').join(' '))
			.toMatch(/0d010201\.01010900/);
		expect(probe(first.file, 'format_tags=timecode')).toContain('timecode=10:00:00:00');
		expect(decodeErrors(first.file)).toBe('');

		// The control: without it the two differ, so the flag is doing the work
		const loose = await writeMxf('loose-a.mxf');
		const looseAgain = await writeMxf('loose-b.mxf');
		expect(readFileSync(looseAgain.file).equals(readFileSync(loose.file))).toBe(false);
	}, 600_000);

	// RDD 9 wants the rung's nominal rate in the MPEG2VideoDescriptor's BitRate. ffprobe reports
	// `bit_rate=N/A` for an MXF video stream whatever is written there - FFmpeg's mxf *demuxer* never
	// reads that field - so this reads the descriptor out of the file instead.
	test('the video descriptor states the bit rate it is given', async () => {
		const stated = await writeMxf('bitrate.mxf', { videoBitRate: 50_000_000 }, { codec: 'mpeg2' });
		expect(mpegVideoBitRate(readFileSync(stated.file))).toBe(50_000_000);

		// The control: left alone, the descriptor carries the rate the input stated, which for a short
		// trim is the measured average rather than any nominal one
		const carried = await writeMxf('bitrate-default.mxf', {}, { codec: 'mpeg2' });
		const measured = mpegVideoBitRate(readFileSync(carried.file));
		expect(measured).toBeGreaterThan(0);
		expect(measured).not.toBe(50_000_000);

		// And ffprobe still cannot see either of them, which is what made this look like a gap
		expect(probe(stated.file, 'stream=bit_rate').join(' ')).toContain('N/A');
	}, 600_000);

	test('an out-of-range option is refused at construction', () => {
		const file = path.join(workDir, 'unused.mxf');
		expect(() => new MxfTarget(file, { videoBitRate: 0 })).toThrow(/positive/);
		expect(() => new MxfTarget(file, { videoBitRate: NaN })).toThrow(/positive/);
		expect(() => new MxfTarget(file, { startTimecode: '10:00:00' })).toThrow(/hh:mm:ss:ff/);
		expect(() => new MxfTarget(file, { startTimecode: 'not a timecode' })).toThrow(/hh:mm:ss:ff/);
		expect(() => new MxfTarget('', {})).toThrow(/non-empty string/);
		expect(() => new MxfTarget(file, { storeUserComments: 1 as unknown as boolean })).toThrow(/boolean/);
		expect(() => new MxfTarget(file, { bitexact: 'yes' as unknown as boolean })).toThrow(/boolean/);
		// Drop frame is accepted
		expect(() => new MxfTarget(file, { startTimecode: '10:00:00;00' })).not.toThrow();
	});
});
