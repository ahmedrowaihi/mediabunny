/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The AVC-Intra sample entry mapping, on synthetic SPS info so it is decided by the table and nothing
// else. This exists because the mapping cannot be tested through ffmpeg fixtures: the code it picks
// depends on the frame rate its muxer had at the time, which a raw elementary stream does not carry and
// `-r` does not pin down identically across builds - measured, CI's ffmpeg picked `ai12` for a fixture
// this machine's picks `ai13` for, and labelled a long-GOP stream AVC-Intra where this machine's does
// not. Those are facts about an x264 build. The carriage is what the fixture test checks; this checks
// the table, including the four interlaced codes no fixture here can produce.

import { expect, test } from 'vitest';
import { avcIntraSampleEntry } from '../../src/codec-data.js';
import type { AvcSpsInfo } from '../../src/codec-data.js';

/** Only the fields the selection reads; the rest of an SPS does not enter into it. */
const sps = (options: {
	profileIdc: number;
	intra?: boolean;
	chromaFormatIdc: number;
	width: number;
	height: number;
	interlaced?: boolean;
}): AvcSpsInfo => ({
	profileIdc: options.profileIdc,
	// constraint_set3_flag, which is what makes a High profile an Intra one
	constraintFlags: options.intra === false ? 0 : 1 << 4,
	chromaFormatIdc: options.chromaFormatIdc,
	displayWidth: options.width,
	displayHeight: options.height,
	frameMbsOnlyFlag: options.interlaced ? 0 : 1,
} as unknown as AvcSpsInfo);

const intra100 = (width: number, height: number, interlaced = false) =>
	sps({ profileIdc: 122, chromaFormatIdc: 2, width, height, interlaced });
const intra50 = (width: number, height: number, interlaced = false) =>
	sps({ profileIdc: 110, chromaFormatIdc: 1, width, height, interlaced });

test('every AVC-Intra code the format names is reachable', () => {
	// AVC-Intra 100: 4:2:2 at full raster
	expect(avcIntraSampleEntry(intra100(1920, 1080), 25)).toBe('ai12');
	expect(avcIntraSampleEntry(intra100(1920, 1080), 50)).toBe('ai12');
	expect(avcIntraSampleEntry(intra100(1920, 1080), 24)).toBe('ai13');
	expect(avcIntraSampleEntry(intra100(1920, 1080), 30)).toBe('ai13');
	expect(avcIntraSampleEntry(intra100(1920, 1080), 60)).toBe('ai13');
	expect(avcIntraSampleEntry(intra100(1280, 720), 25)).toBe('ai1q');
	expect(avcIntraSampleEntry(intra100(1280, 720), 24)).toBe('ai1p');
	// Interlaced, keyed on 50 against 60 rather than on the progressive split
	expect(avcIntraSampleEntry(intra100(1920, 1080, true), 50)).toBe('ai15');
	expect(avcIntraSampleEntry(intra100(1920, 1080, true), 60)).toBe('ai16');

	// AVC-Intra 50: 4:2:0 on the subsampled raster
	expect(avcIntraSampleEntry(intra50(1440, 1080), 25)).toBe('ai52');
	expect(avcIntraSampleEntry(intra50(1440, 1080), 24)).toBe('ai53');
	expect(avcIntraSampleEntry(intra50(960, 720), 25)).toBe('ai5q');
	expect(avcIntraSampleEntry(intra50(960, 720), 24)).toBe('ai5p');
	expect(avcIntraSampleEntry(intra50(1440, 1080, true), 50)).toBe('ai55');
	expect(avcIntraSampleEntry(intra50(1440, 1080, true), 60)).toBe('ai56');

	// All twelve, and no two shapes sharing one
	const picked = new Set([
		avcIntraSampleEntry(intra100(1920, 1080), 25), avcIntraSampleEntry(intra100(1920, 1080), 24),
		avcIntraSampleEntry(intra100(1280, 720), 25), avcIntraSampleEntry(intra100(1280, 720), 24),
		avcIntraSampleEntry(intra100(1920, 1080, true), 50), avcIntraSampleEntry(intra100(1920, 1080, true), 60),
		avcIntraSampleEntry(intra50(1440, 1080), 25), avcIntraSampleEntry(intra50(1440, 1080), 24),
		avcIntraSampleEntry(intra50(960, 720), 25), avcIntraSampleEntry(intra50(960, 720), 24),
		avcIntraSampleEntry(intra50(1440, 1080, true), 50), avcIntraSampleEntry(intra50(1440, 1080, true), 60),
	]);
	expect(picked.size).toBe(12);
});

test('NTSC rates count as their nominal value', () => {
	expect(avcIntraSampleEntry(intra100(1920, 1080), 30000 / 1001)).toBe('ai13');
	expect(avcIntraSampleEntry(intra100(1920, 1080), 60000 / 1001)).toBe('ai13');
	expect(avcIntraSampleEntry(intra100(1920, 1080, true), 60000 / 1001)).toBe('ai16');
	expect(avcIntraSampleEntry(intra50(960, 720), 24000 / 1001)).toBe('ai5p');
});

test('a stream that is not AVC-Intra gets no entry', () => {
	// The shape is right and only `constraint_set3_flag` is missing, which is the whole distinction
	expect(avcIntraSampleEntry(
		sps({ profileIdc: 122, intra: false, chromaFormatIdc: 2, width: 1920, height: 1080 }), 25,
	)).toBeNull();

	// An intra profile, but not one of the profiles these codes name
	expect(avcIntraSampleEntry(
		sps({ profileIdc: 100, chromaFormatIdc: 1, width: 1920, height: 1080 }), 25,
	)).toBeNull();

	// Right profile, wrong chroma format for that raster: 1920x1080 is the 4:2:2 family's
	expect(avcIntraSampleEntry(intra50(1920, 1080), 25)).toBeNull();

	// A raster the format does not name at all
	expect(avcIntraSampleEntry(intra100(3840, 2160), 25)).toBeNull();

	// No frame rate to choose the pair with
	expect(avcIntraSampleEntry(intra100(1920, 1080), null)).toBeNull();
	expect(avcIntraSampleEntry(intra100(1920, 1080), 0)).toBeNull();
});
