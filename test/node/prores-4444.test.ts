/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// ProRes 4444 and 4444 XQ are 4:4:4 by definition - the four-character code fixes the chroma format, it
// is not a preference. What gets written is read with ffprobe rather than from our own boxes.

import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MovOutputFormat } from '../../src/output-format.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';

registerMediabunnyServer();

const WIDTH = 160;
const HEIGHT = 96;
const FPS = 25;
const FRAMES = 4;

/** A gradient with a moving band, so the chroma planes carry something a 4:2:2 subsample would blur. */
const frameAt = (index: number) => {
	const data = new Uint8Array(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const at = (y * WIDTH + x) * 4;
			data[at] = (x * 255 / WIDTH) | 0;
			data[at + 1] = (y * 255 / HEIGHT) | 0;
			data[at + 2] = ((x + index * 8) % 2) * 255;
			data[at + 3] = 255;
		}
	}
	return data;
};

const encodeProres = async (fullCodecString: string, alpha: 'keep' | 'discard') => {
	const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });
	const source = new VideoSampleSource({
		codec: 'prores',
		fullCodecString,
		alpha,
		quality: new Quality('high'),
		hardwareAcceleration: 'prefer-software',
	});
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < FRAMES; i++) {
		using sample = new VideoSample(frameAt(i), {
			format: 'RGBA',
			codedWidth: WIDTH,
			codedHeight: HEIGHT,
			timestamp: i / FPS,
			duration: 1 / FPS,
		});
		await source.add(sample);
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** Keyed rather than CSV: ffprobe prints the fields in its own order, not the order asked for. */
const probeVideo = (bytes: Uint8Array, name: string) => {
	const file = path.join(tmpdir(), `mediabunny-${name}.mov`);
	writeFileSync(file, bytes);

	try {
		const lines = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0',
			'-show_entries', 'stream=pix_fmt,profile,codec_tag_string',
			'-of', 'default=noprint_wrappers=1', file,
		], { encoding: 'utf8' }).trim().split('\n');

		const fields = new Map(lines.map(line => line.split('=') as [string, string]));
		return {
			pixFmt: fields.get('pix_fmt'),
			profile: fields.get('profile'),
			tag: fields.get('codec_tag_string'),
		};
	} finally {
		rmSync(file, { force: true });
	}
};

describe.skipIf(!hasFfprobe)('the four-character code fixes the chroma format', () => {
	// 4:4:4 whether or not alpha is kept. Before this, discarding alpha fell through to the encoder's
	// first advertised format, which is 4:2:2 - a 4:4:4 profile carrying half the chroma.
	test.each([
		['ap4h', '4444'],
		['ap4x', 'XQ'],
	])('%s without alpha is still 4:4:4', async (fourCc, profile) => {
		const probed = probeVideo(await encodeProres(fourCc, 'discard'), `prores-${fourCc}-noalpha`);

		expect(probed.tag).toBe(fourCc);
		expect(probed.profile).toBe(profile);
		expect(probed.pixFmt).toBe('yuv444p12le');
	}, 300_000);

	test.each([
		['ap4h', '4444'],
		['ap4x', 'XQ'],
	])('%s with alpha keeps an alpha plane', async (fourCc, profile) => {
		const probed = probeVideo(await encodeProres(fourCc, 'keep'), `prores-${fourCc}-alpha`);

		expect(probed.profile).toBe(profile);
		expect(probed.pixFmt).toBe('yuva444p12le');
	}, 300_000);

	// The control: the 4:2:2 codes must stay 4:2:2, so the fix is not "always 4:4:4"
	test.each([
		['apco', 'Proxy'],
		['apcs', 'LT'],
		['apcn', 'Standard'],
		['apch', 'HQ'],
	])('%s stays 4:2:2', async (fourCc, profile) => {
		const probed = probeVideo(await encodeProres(fourCc, 'discard'), `prores-${fourCc}`);

		expect(probed.tag).toBe(fourCc);
		expect(probed.profile).toBe(profile);
		expect(probed.pixFmt).toBe('yuv422p10le');
	}, 300_000);
});
