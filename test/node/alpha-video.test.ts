/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A motion-graphics overlay is delivered as a .mov carrying its alpha in the one bitstream - QuickTime
// Animation or PNG - and MediaConvert's motion image inserter takes nothing else. Each case below reads
// one such file to the end and compares frame 0 to what ffmpeg decodes it to, byte for byte, so a
// dropped alpha channel or a premultiply fails rather than merely looking different.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import type { VideoCodec } from '../../src/codec.js';

registerMediabunnyServer();

const PUBLIC = path.join(new URL('.', import.meta.url).pathname, '../public');

/** ffmpeg's own decode of the same file, as the control: `rgba` is 8 bits per component, alpha last. */
const ffmpegRgba = (file: string, width: number, height: number) => {
	const raw = execFileSync(
		'ffmpeg',
		['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
		{ maxBuffer: 1 << 28 },
	);
	expect(raw.length).toBe(width * height * 4);
	return new Uint8Array(raw);
};

const CASES: {
	file: string;
	codec: VideoCodec;
	frames: number;
	width: number;
	height: number;
	/** The colour every pixel was synthesised as, where the fixture is a flat one. */
	pixel: [number, number, number, number] | null;
	/** Whether ffmpeg decodes the same file the same way, so its output can be the control. */
	ffmpegAgrees: boolean;
}[] = [
	{
		file: 'qtrle-alpha.mov', codec: 'qtrle', frames: 10, width: 64, height: 32,
		pixel: [255, 0, 0, 128], ffmpegAgrees: true,
	},
	{
		file: 'png-alpha.mov', codec: 'png', frames: 10, width: 64, height: 32,
		pixel: [255, 0, 0, 128], ffmpegAgrees: true,
	},
	// Already supported, and here so the alpha routes are asserted the same way. VP9 carries its alpha
	// as a second coded stream in a Matroska block addition rather than in the frame, which ffmpeg's
	// own decode drops - so it cannot be the control for this one.
	{
		file: 'transparency.webm', codec: 'vp9', frames: 0, width: 0, height: 0,
		pixel: null, ffmpegAgrees: false,
	},
];

test.each(CASES)('$codec: $file decodes with its alpha', async (testCase) => {
	const file = path.join(PUBLIC, testCase.file);
	using input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getCodec()).toBe(testCase.codec);
	expect(await track.canDecode()).toBe(true);

	const samples = [];
	for await (const sample of new VideoSampleSink(track).samples()) {
		samples.push(sample);
	}
	if (testCase.frames > 0) {
		expect(samples.length).toBe(testCase.frames);
	} else {
		expect(samples.length).toBeGreaterThan(0);
	}

	const first = samples[0]!;
	const width = testCase.width || first.codedWidth;
	const height = testCase.height || first.codedHeight;
	expect([first.codedWidth, first.codedHeight]).toEqual([width, height]);

	const pixels = new Uint8Array(first.allocationSize({ format: 'RGBA' }));
	await first.copyTo(pixels, { format: 'RGBA' });

	if (testCase.pixel) {
		// Named here rather than derived, so a decoder that drops alpha (255) or premultiplies (128,0,0)
		// fails on its own rather than agreeing with a control that made the same mistake. Half of 255
		// is not an integer, so the alpha is one off either way.
		expect([...pixels.subarray(0, 3)]).toEqual(testCase.pixel.slice(0, 3));
		expect(Math.abs(pixels[3]! - testCase.pixel[3])).toBeLessThanOrEqual(1);
	}

	// An alpha channel that came out opaque everywhere is the failure this whole file is about
	const alphas = new Set<number>();
	for (let i = 3; i < pixels.length; i += 4) {
		alphas.add(pixels[i]!);
	}
	expect([...alphas], 'every pixel opaque means the alpha channel was dropped').not.toEqual([255]);

	if (testCase.ffmpegAgrees) {
		const control = ffmpegRgba(file, width, height);
		let worst = 0;
		for (let i = 0; i < control.length; i++) {
			worst = Math.max(worst, Math.abs(pixels[i]! - control[i]!));
		}
		expect(worst, 'largest component difference against ffmpeg').toBeLessThanOrEqual(1);
	}

	for (const sample of samples) {
		sample.close();
	}
}, 120_000);
