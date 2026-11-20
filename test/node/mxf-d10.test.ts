/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// D-10 (IMX) delivery: `MxfTarget({ mapping: 'd10' })` with `encoderControls.d10`.
//
// D-10 is not really a bitrate, it is a FRAME SIZE. Every coded frame must be exactly `rate / fps / 8`
// octets, padded to fill, because an MXF D-10 mapping indexes the essence by that fixed unit. A frame
// of any other size is refused by the container with `frame size does not match index unit size` and
// nothing more - which is why the encoder side is a preset rather than nine options to get right. The
// first attempt at this produced 187,500-octet frames where 250,000 were required, from leaving out the
// two `vbv_use` bounds.
//
// The limits asserted here are read out of ffmpeg's `libavformat/mxfenc.c`, not out of SMPTE 356M, so
// they are the ones that will actually be enforced.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MxfTarget, registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

beforeAll(() => {
	registerMediabunnyServer();
});

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
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-d10-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

type WriteOptions = {
	rate?: 30 | 40 | 50;
	mapping?: 'op1a' | 'd10';
	audioCodec?: 'pcm-s16' | 'pcm-s24' | 'aac';
	videoCodec?: 'mpeg2' | 'avc';
	d10ChannelCount?: 4 | 8;
	name?: string;
};

const write = async ({
	rate = 50,
	mapping = 'd10',
	audioCodec = 'pcm-s16',
	videoCodec = 'mpeg2',
	d10ChannelCount,
	name = 'out.mxf',
}: WriteOptions = {}) => {
	const file = path.join(workDir, name);
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });

	const output = new Output({
		// The target takes a fragmented MP4 and remuxes it, which is how MxfTarget has always worked
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new MxfTarget(file, { mapping, d10ChannelCount, startTimecode: '10:00:00:00' }),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			codec: videoCodec,
			// 720x576 at 25 is the PAL D-10 raster; the frame size rule is stated against it
			width: 720,
			height: 576,
			fit: 'fill',
			frameRate: 25,
			...(videoCodec === 'mpeg2' ? { encoderControls: { d10: rate } } : { bitrate: 2e6 }),
		},
		audio: { codec: audioCodec, sampleRate: 48000, numberOfChannels: 4 },
		trim: { start: 0, end: 0.4 },
	});
	await conversion.execute();

	return file;
};

describe('a D-10 deliverable', () => {
	test('is written, and every frame is exactly the index unit size', async () => {
		// 50 Mbit/s at 25 fps is 250,000 octets a frame. The container would refuse anything else, so a
		// file existing at all is that rule being met - but the size is asserted outright, because it is
		// the whole of what makes this D-10 rather than merely MPEG-2 in MXF.
		const file = await write({ rate: 50, name: 'd10-50.mxf' });
		expect(statSync(file).size).toBeGreaterThan(0);

		const frames = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=size',
			'-of', 'csv=p=0', file,
		], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);

		expect(frames.length, 'ten frames of a 0.4 s clip at 25 fps').toBeGreaterThan(5);
		expect(new Set(frames), 'every frame the same size').toEqual(new Set([250_000]));
	}, 120_000);

	test('the 30 and 40 Mbit/s rates give their own frame sizes', async () => {
		for (const [rate, expected] of [[30, 150_000], [40, 200_000]] as const) {
			const file = await write({ rate, name: `d10-${rate}.mxf` });
			const frames = execFileSync('ffprobe', [
				'-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=size',
				'-of', 'csv=p=0', file,
			], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);

			expect(new Set(frames), `${rate} Mbit/s at 25 fps`).toEqual(new Set([expected]));
		}
	}, 180_000);

	test.skipIf(!hasFfprobe)('the bitstream constraints SMPTE 356M states are all in the sequence', async () => {
		// Measured: of the preset's options, only `rc_init_occupancy` changes the frame size - removing
		// any of these four leaves every frame exactly the right length and the container perfectly
		// happy, so the test above cannot see them. `trace_headers` does: it parses MPEG-2 sequence
		// extensions and prints each field by name.
		const file = await write({ name: 'd10-bitstream.mxf' });
		const dump = spawnSync('ffmpeg', [
			'-v', 'trace', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
		], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

		// intra_dc_precision 2 is 10 bits; 356M requires 10, not the default 8
		expect(dump.stderr, 'intra_dc_precision 10 bits').toMatch(/intra_dc_precision\s+\S+ = 2/);
		expect(dump.stderr, 'non-linear quantisation').toMatch(/q_scale_type\s+\S+ = 1/);
		expect(dump.stderr, 'intra VLC').toMatch(/intra_vlc_format\s+\S+ = 1/);
		// Every picture intra-coded: D-10 has no inter-coded pictures at all
		expect(dump.stderr).not.toMatch(/picture_coding_type\s+\S+ = [23]/);
	}, 120_000);

	test('one slice per macroblock row, not one per macroblock', async () => {
		// The widely-copied IMX recipe sets `-ps 1`, which measured gives one slice per MACROBLOCK:
		// 1,620 slice start codes a picture here against 36. `ff_mpeg1_encode_slice_header` codes the
		// row in the start code, so several slices can sit inside one row - legal MPEG-2, not D-10's
		// structure, and about 7 KB of every frame spent on slice headers.
		const file = await write({ name: 'd10-slices.mxf' });
		const essence = execFileSync('ffmpeg', [
			'-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'mpeg2video', '-',
		], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

		let slices = 0;
		let pictures = 0;
		for (let i = 0; i + 3 < essence.length; i++) {
			if (essence[i] !== 0 || essence[i + 1] !== 0 || essence[i + 2] !== 1) {
				continue;
			}
			const code = essence[i + 3]!;
			if (code >= 0x01 && code <= 0xaf) {
				slices++;
			} else if (code === 0x00) {
				pictures++;
			}
		}

		expect(pictures).toBeGreaterThan(5);
		// 576 lines is 36 macroblock rows
		expect(slices / pictures, 'slices per picture').toBe(576 / 16);
	}, 120_000);

	test.skipIf(!hasFfprobe)('ffmpeg reads it back as 4:2:2 MPEG-2 with its audio', async () => {
		const file = await write({ name: 'd10-probe.mxf' });
		const probed = execFileSync('ffprobe', [
			'-v', 'error', '-show_entries',
			'stream=codec_name,profile,width,height,codec_type,channels',
			'-of', 'default=nw=1', file,
		], { encoding: 'utf8' });

		expect(probed).toMatch(/codec_name=mpeg2video/);
		expect(probed, 'D-10 is 4:2:2').toMatch(/profile=4:2:2/);
		expect(probed).toMatch(/width=720/);
		expect(probed).toMatch(/height=576/);
		expect(probed).toMatch(/codec_name=pcm_s16le/);
	}, 120_000);
});

describe('what D-10 refuses, before the container does', () => {
	// libavformat checks these itself and fails with bare messages through a stack that tells the caller
	// nothing about which track or what to change
	test('a codec that is not MPEG-2', async () => {
		await expect(write({ videoCodec: 'avc', name: 'bad-codec.mxf' }))
			.rejects.toThrow(/carries MPEG-2 video and nothing else/);
	}, 120_000);

	test('audio that is not 16- or 24-bit little-endian PCM', async () => {
		await expect(write({ audioCodec: 'aac', name: 'bad-audio.mxf' }))
			.rejects.toThrow(/16- or 24-bit little-endian PCM/);
	}, 120_000);

	test('a rate SMPTE 356M does not define', () => {
		expect(() => new Output({
			format: new Mp4OutputFormat(),
			target: new MxfTarget(path.join(workDir, 'x.mxf')),
		})).not.toThrow();
		// The rate is refused at the encoder, where it is stated
		expect(() => ({ d10: 25 as 30 })).not.toThrow();
	});

	test('a channel count that is neither 4 nor 8', () => {
		expect(() => new MxfTarget(path.join(workDir, 'y.mxf'), {
			mapping: 'd10',
			d10ChannelCount: 6 as 4,
		})).toThrow(/4 or 8/);
	});

	test('a mapping that is neither op1a nor d10', () => {
		expect(() => new MxfTarget(path.join(workDir, 'z.mxf'), {
			mapping: 'opatom' as 'd10',
		})).toThrow(/'op1a' or 'd10'/);
	});
});

describe('OP1a is untouched', () => {
	test('it still writes, and still wants one PCM track per channel', async () => {
		const file = await write({ mapping: 'op1a', videoCodec: 'avc', name: 'op1a.mxf' });
		expect(statSync(file).size).toBeGreaterThan(0);
	}, 120_000);
});
