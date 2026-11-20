/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// VC-3 (DNxHD) and DNxHR, through `encoderControls.dnxProfile`.
//
// **A VC-3 class is a frame size.** 606,208 octets a frame for 145 and 917,504 for both 220s, at
// 1920x1080, whatever the frame rate — 145 Mbit/s at 29.97 and 120 at 25 are the same class and the
// same number of octets. So the per-packet size is what the tests assert, the way they do for D-10,
// rather than a bitrate that only averages out.
//
// The class-to-rate mapping is read out of ffmpeg's own `dnxhddata.c` CID table: 1237 and 1242 are the
// 145 class at 606,208, 1238 is 220 at 917,504, and 1235 and 1241 are the 10-bit 220x. ffmpeg matches a
// class by comparing the stated bitrate against that table, so only the exact value will do.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MxfTarget, registerMediabunnyServer } from '@mediabunny/server';
import { dnxProfileOf } from '../../packages/server/src/video-encoder.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

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
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-dnx-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

type EncodeOptions = {
	profile: '145' | '220' | '220x' | 'lb' | 'sq' | 'hq' | 'hqx' | '444';
	frameRate?: number;
	interlaced?: 'tff' | 'bff';
	width?: number;
	height?: number;
	/** `'mxf'` goes through MxfTarget, which remuxes into MXF OP1a with the DNxHD mapping. */
	container?: 'mov' | 'mp4' | 'mxf';
	name?: string;
};

const encode = async ({
	profile,
	frameRate = 25,
	interlaced,
	width = 1920,
	height = 1080,
	container = 'mov',
	name = 'out',
}: EncodeOptions) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const file = path.join(workDir, `${name}.${container}`);

	const output = container === 'mxf'
		? new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new MxfTarget(file),
		})
		: new Output({
			format: container === 'mov' ? new MovOutputFormat() : new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			codec: 'dnxhd',
			width,
			height,
			fit: 'fill',
			frameRate,
			encoderControls: { dnxProfile: profile, ...(interlaced ? { interlaced } : {}) },
		},
		// MXF carries frame-wrapped PCM, one track per channel
		...(container === 'mxf'
			? { audio: { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 } as const }
			: {}),
		trim: { start: 0, end: 0.3 },
	});
	await conversion.execute();

	if (container !== 'mxf') {
		const bytes = new Uint8Array((output.target as BufferTarget).buffer!);
		writeFileSync(file, bytes);
	}

	return file;
};

/** Every video packet's size, which is what a VC-3 class fixes. */
const frameSizes = (file: string) => new Set(
	execFileSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=size', '-of', 'csv=p=0', file,
	], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number),
);

/**
 * The CID each class is named by, progressively and interlaced, out of ffmpeg's `dnxhddata.c` table.
 * ffmpeg matches a class by comparing the stated bitrate against that table, so the identifier in the
 * frame header is what says which class the encoder actually chose.
 */
const CIDS = {
	'145': { progressive: 1237, interlaced: 1242 },
	'220': { progressive: 1238, interlaced: 1243 },
	'220x': { progressive: 1235, interlaced: 1241 },
} as const;

/**
 * The first frame's VC-3 header, taken off the elementary stream rather than out of a container, so no
 * part of this library is in the loop.
 */
const firstFrameHeader = (file: string) => {
	const raw = path.join(workDir, `${path.basename(file)}.raw`);
	execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'data', raw]);
	const bytes = new Uint8Array(readFileSync(raw));

	// dnxhddec.c: the header opens with 0x000002800100, the interlace flag is bit 1 of octet 5, and the
	// compression id is a big-endian 32-bit field at 0x28
	expect([...bytes.subarray(0, 5)], 'a VC-3 frame header').toEqual([0x00, 0x00, 0x02, 0x80, 0x01]);

	return {
		interlaced: (bytes[5]! & 2) !== 0,
		compressionId: new DataView(bytes.buffer, bytes.byteOffset).getUint32(0x28),
	};
};

const probe = (file: string, entries: string) => execFileSync('ffprobe', [
	'-v', 'error', '-select_streams', 'v', '-show_entries', entries, '-of', 'default=nw=1', file,
], { encoding: 'utf8' });

describe.skipIf(!hasFfprobe)('VC-3 classes, where the class is the frame size', () => {
	// The matrix the consumer named: 1080p and 1080i, at 145 (8-bit), 220 (8-bit) and 220x (10-bit),
	// at 29.97 and 25. Each cell states the octets a frame must be.
	const CASES = [
		['145', 25, undefined, 606_208],
		['145', 25, 'tff', 606_208],
		['145', 29.97, undefined, 606_208],
		['145', 29.97, 'tff', 606_208],
		['220', 25, undefined, 917_504],
		['220', 25, 'tff', 917_504],
		['220', 29.97, undefined, 917_504],
		['220', 29.97, 'tff', 917_504],
		['220x', 25, undefined, 917_504],
		['220x', 25, 'tff', 917_504],
		// 220x progressive at 29.97 has no identifier at all; the interlaced one does
		['220x', 29.97, 'tff', 917_504],
	] as const;

	test.each(CASES)('%s at %s fps, interlaced %s, is %i octets a frame', async (
		profile,
		frameRate,
		interlaced,
		expected,
	) => {
		const file = await encode({
			profile,
			frameRate,
			interlaced,
			name: `vc3-${profile}-${String(frameRate).replace('.', '')}-${interlaced ?? 'p'}`,
		});

		expect(frameSizes(file)).toEqual(new Set([expected]));
		expect(probe(file, 'stream=codec_name')).toMatch(/codec_name=dnxhd/);

		// Every VC-3 class has a progressive identifier and an interlaced one, and at 1920x1080 both carry
		// the same octets a frame - so the frame size alone cannot tell them apart, and ffprobe reports
		// `field_order=unknown` because neither container states it. The frame header does.
		const header = firstFrameHeader(file);
		expect(header.compressionId, 'the CID ffmpeg\'s dnxhddata.c table names for this class')
			.toBe(CIDS[profile][interlaced ? 'interlaced' : 'progressive']);
		expect(header.interlaced).toBe(interlaced !== undefined);
	}, 180_000);

	test('220x progressive at 29.97 is refused, naming what to do instead', async () => {
		// DNxHD defines no progressive 10-bit identifier at that rate. Refusing by name beats failing
		// inside the encoder with "video parameters incompatible with DNxHD".
		await expect(encode({ profile: '220x', frameRate: 29.97, name: 'bad220x' }))
			.rejects.toThrow(/exists only interlaced/);
	}, 120_000);

	test('a frame rate VC-3 does not define is refused', async () => {
		await expect(encode({ profile: '145', frameRate: 30, name: 'bad-rate' }))
			.rejects.toThrow(/defined at 25 and 29.97/);
	}, 120_000);
});

describe.skipIf(!hasFfprobe)('DNxHR profiles, which take any resolution', () => {
	const CASES = [
		['lb', 8],
		['sq', 8],
		['hq', 8],
		['hqx', 10],
		['444', 10],
	] as const;

	test.each(CASES)('%s encodes at 1280x720 and is %i-bit', async (profile, bitDepth) => {
		const file = await encode({
			profile,
			width: 1280,
			height: 720,
			frameRate: 25,
			name: `dnxhr-${profile}`,
		});

		expect(probe(file, 'stream=codec_name')).toMatch(/codec_name=dnxhd/);

		// The pixel format is what carries the depth and the chroma, and the profile chooses it:
		// 444 is the only 4:4:4 one, hqx and 444 the only 10-bit ones
		const pixelFormat = probe(file, 'stream=pix_fmt');
		expect(pixelFormat).toMatch(bitDepth === 10 ? /p10/ : /yuv42[20]p\s/);
		expect(pixelFormat).toMatch(profile === '444' ? /yuv444/ : /yuv422/);

		// Every frame the same size: DNxHR is intra-only and constant-rate per profile
		expect(frameSizes(file).size, 'one size for every frame').toBe(1);
	}, 180_000);
});

describe.skipIf(!hasFfprobe)('containers', () => {
	test('MOV states the AVdn sample entry', async () => {
		const file = await encode({ profile: 'sq', width: 1280, height: 720, name: 'entry', container: 'mov' });
		expect(probe(file, 'stream=codec_tag_string')).toMatch(/codec_tag_string=AVdn/);
	}, 120_000);

	test('MP4 does too, since the entry is the same either way', async () => {
		const file = await encode({ profile: 'sq', width: 1280, height: 720, name: 'entry4', container: 'mp4' });
		expect(probe(file, 'stream=codec_tag_string')).toMatch(/codec_tag_string=AVdn/);
	}, 120_000);

	test('MXF OP1a carries it through the DNxHD mapping', async () => {
		const file = await encode({ profile: '220', frameRate: 25, name: 'mxf', container: 'mxf' });
		expect(probe(file, 'stream=codec_name')).toMatch(/codec_name=dnxhd/);
		expect(frameSizes(file)).toEqual(new Set([917_504]));
	}, 180_000);

	test('and this library reads its own MOV back as dnxhd', async () => {
		const file = await encode({ profile: 'sq', width: 1280, height: 720, name: 'roundtrip' });
		const input = new Input({
			formats: ALL_FORMATS,
			source: new BufferSource(new Uint8Array(readFileSync(file))),
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getCodec()).toBe('dnxhd');
		// Intra-only: every packet stands alone
		expect(await track.getCodecParameterString()).toBe('AVdn');
	}, 120_000);
});

describe('refusals', () => {
	test('a profile that is neither a class nor a DNxHR name', async () => {
		await expect(encode({ profile: '180x' as '220x', name: 'bogus' }))
			.rejects.toThrow(/must be a VC-3 class/);
	});

	test('dnxProfile on a codec that is not dnxhd', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
		const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });

		await expect((async () => {
			const conversion = await Conversion.init({
				input,
				output,
				video: { codec: 'avc', bitrate: 2e6, encoderControls: { dnxProfile: 'sq' } },
				trim: { start: 0, end: 0.2 },
			});
			await conversion.execute();
		})()).rejects.toThrow(/dnxProfile is not supported by the selected encoder/);
	}, 120_000);
});

// `dnxProfile` accepts null as absent, and the read has to agree: with the field widened but the
// guard left at `=== undefined`, null reached `DNXHR_PROFILES[null]`, which is undefined, so the
// spread built a profile carrying neither a class nor a chroma format and the encode chose a pixel
// format from that instead of refusing. Nothing threw.
test('a null dnxProfile is read as absent, not as a profile', () => {
	expect(dnxProfileOf({ dnxProfile: null })).toBe(null);
	expect(dnxProfileOf({ dnxProfile: null })).toEqual(dnxProfileOf({}));
});
