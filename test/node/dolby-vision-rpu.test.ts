/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Generating a Dolby Vision profile 8.1 RPU: metadata on top of an HDR10 base layer, with no
// enhancement layer and an identity mapping, so an HDR10 encode can be given Dolby Vision without
// re-encoding a pixel.
//
// **The syntax is not public, so the oracle is `dovi_tool`**: for the same inputs, this library must
// write the same octets `dovi_tool generate` does. That is a far stronger check than a round trip
// through our own reader - there isn't one - and it is not satisfiable by accident: an RPU is a single
// bit-packed run with no byte boundaries to resynchronise on, so one field of the wrong width shifts
// everything after it and fails the comparison outright. The CRC at the end fails it a second time.
//
// `dovi_tool info` is used as well, on OUR octets, so the test also states what the fields mean rather
// than only that two files match.

import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	buildDolbyVisionProfile81Rpu,
	type DolbyVisionRpuOptions,
} from '../../src/dovi-rpu.js';
import { HEVC_DOVI_RPU_NAL_TYPE } from '../../src/dovi.js';

const hasDoviTool = (() => {
	try {
		execFileSync('dovi_tool', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

const workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-rpu-'));

type GenerateConfig = {
	level5?: Record<string, number>;
	level6?: Record<string, number>;
	default_metadata_blocks?: unknown[];
	source_min_pq?: number;
	source_max_pq?: number;
	length?: number;
};

/** What `dovi_tool generate` writes for this config, as one RPU per frame, without the start codes. */
const reference = (name: string, config: GenerateConfig) => {
	const file = path.join(workDir, `${name}.json`);
	writeFileSync(file, JSON.stringify({
		cm_version: 'V29',
		profile: '8.1',
		length: 1,
		...config,
	}));

	const out = path.join(workDir, `${name}.rpu`);
	execFileSync('dovi_tool', ['generate', '-j', file, '-o', out]);

	const bytes = new Uint8Array(readFileSync(out));

	// Each RPU in the file is `00 00 00 01` then the NAL unit without its two-octet header
	const frames: Uint8Array[] = [];
	let at = 0;
	while (at < bytes.length) {
		let next = at + 4;
		while (
			next + 3 < bytes.length
			&& !(bytes[next] === 0 && bytes[next + 1] === 0 && bytes[next + 2] === 0 && bytes[next + 3] === 1)
		) {
			next++;
		}

		frames.push(bytes.subarray(at + 4, next + 3 < bytes.length ? next : bytes.length));
		at = next + 3 < bytes.length ? next : bytes.length;
	}

	return frames;
};

const hex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

/** Our own RPU, with the two-octet NAL header taken off so it lines up with `dovi_tool`'s file. */
const ours = (options: DolbyVisionRpuOptions) => buildDolbyVisionProfile81Rpu(options).subarray(2);

/** What `dovi_tool info` makes of octets we wrote. */
const parseOurs = (name: string, options: DolbyVisionRpuOptions) => {
	const nalUnit = buildDolbyVisionProfile81Rpu(options);
	const file = path.join(workDir, `${name}-ours.rpu`);

	const out = new Uint8Array(4 + nalUnit.length - 2);
	out.set([0, 0, 0, 1], 0);
	out.set(nalUnit.subarray(2), 4);
	writeFileSync(file, out);

	return JSON.parse(execFileSync('dovi_tool', ['info', '-i', file, '-f', '0'], {
		encoding: 'utf8',
	}).replace(/^Parsing RPU file\.\.\.\n/, '')) as {
		dovi_profile: number;
		header: Record<string, unknown>;
		vdr_dm_data: {
			scene_refresh_flag: number;
			source_min_pq: number;
			source_max_pq: number;
			cmv29_metadata: { ext_metadata_blocks: Record<string, Record<string, number>>[] };
		};
	};
};

const L6_1000: Record<string, number> = {
	max_display_mastering_luminance: 1000,
	min_display_mastering_luminance: 1,
	max_content_light_level: 1000,
	max_frame_average_light_level: 400,
};

const level6Of = (l6: Record<string, number>) => ({
	maxDisplayMasteringLuminance: l6['max_display_mastering_luminance']!,
	minDisplayMasteringLuminance: l6['min_display_mastering_luminance']!,
	maxContentLightLevel: l6['max_content_light_level']!,
	maxFrameAverageLightLevel: l6['max_frame_average_light_level']!,
});

describe.skipIf(!hasDoviTool)('byte for byte against dovi_tool', () => {
	test('the plain case: L6 and a default active area', () => {
		const [theirs] = reference('plain', { level6: L6_1000 });
		expect(hex(ours({ sceneCut: true, level6: level6Of(L6_1000) }))).toBe(hex(theirs!));
	});

	test('a frame that does not begin a shot clears scene_refresh_flag', () => {
		// Two frames: dovi_tool sets the flag on the first of a shot and not after
		const frames = reference('scene-cut', { level6: L6_1000, length: 2 });
		expect(frames.length).toBe(2);

		expect(hex(ours({ sceneCut: true, level6: level6Of(L6_1000) }))).toBe(hex(frames[0]!));
		expect(hex(ours({ sceneCut: false, level6: level6Of(L6_1000) }))).toBe(hex(frames[1]!));

		// And the two differ, so the flag is really being read rather than both matching the same thing
		expect(hex(frames[0]!)).not.toBe(hex(frames[1]!));
	});

	test('an active area, which is the one block with four fields of the same width', () => {
		const level5 = {
			active_area_left_offset: 240,
			active_area_right_offset: 241,
			active_area_top_offset: 10,
			active_area_bottom_offset: 11,
		};

		const [theirs] = reference('l5', { level5, level6: L6_1000 });
		expect(hex(ours({
			sceneCut: true,
			level5: { left: 240, right: 241, top: 10, bottom: 11 },
			level6: level6Of(L6_1000),
		}))).toBe(hex(theirs!));
	});

	test('L1, the per-frame block, which sorts ahead of the other two', () => {
		const [theirs] = reference('l1', {
			level6: L6_1000,
			default_metadata_blocks: [{ Level1: { min_pq: 0, max_pq: 2828, avg_pq: 1229 } }],
		});

		expect(hex(ours({
			sceneCut: true,
			level1: { minPq: 0, maxPq: 2828, avgPq: 1229 },
			level6: level6Of(L6_1000),
		}))).toBe(hex(theirs!));
	});

	test('all three blocks at once', () => {
		const level5 = {
			active_area_left_offset: 0,
			active_area_right_offset: 0,
			active_area_top_offset: 276,
			active_area_bottom_offset: 276,
		};

		const [theirs] = reference('all', {
			level5,
			level6: L6_1000,
			default_metadata_blocks: [{ Level1: { min_pq: 7, max_pq: 3079, avg_pq: 1234 } }],
		});

		expect(hex(ours({
			sceneCut: true,
			level1: { minPq: 7, maxPq: 3079, avgPq: 1234 },
			level5: { left: 0, right: 0, top: 276, bottom: 276 },
			level6: level6Of(L6_1000),
		}))).toBe(hex(theirs!));
	});

	// The mastering luminance is not written into the stream as-is: it picks the PQ codes the whole
	// display management is stated against, by a table with no formula behind it
	test.each([
		[1000, 3079],
		[2000, 3388],
		[4000, 3696],
		[10000, 4095],
		[600, 3079], // Anything unlisted falls back to the 1000 entry
	])('a mastering maximum of %i nits states source_max_pq %i', (nits, expected) => {
		const level6 = { ...L6_1000, max_display_mastering_luminance: nits };
		const [theirs] = reference(`mdl-${nits}`, { level6 });

		const options = { sceneCut: true, level6: level6Of(level6) };
		expect(hex(ours(options))).toBe(hex(theirs!));

		if (hasDoviTool) {
			expect(parseOurs(`mdl-${nits}`, options).vdr_dm_data.source_max_pq).toBe(expected);
		}
	});

	test.each([
		[1, 7],
		[10, 7],
		[50, 62],
		[100, 0],
	])('a mastering minimum of %i states source_min_pq %i', (minimum, expected) => {
		const level6 = { ...L6_1000, min_display_mastering_luminance: minimum };
		const [theirs] = reference(`mdl-min-${minimum}`, { level6 });

		const options = { sceneCut: true, level6: level6Of(level6) };
		expect(hex(ours(options))).toBe(hex(theirs!));
		expect(parseOurs(`mdl-min-${minimum}`, options).vdr_dm_data.source_min_pq).toBe(expected);
	});

	test('stated source levels win over the ones L6 implies', () => {
		const [theirs] = reference('source-pq', {
			level6: L6_1000,
			source_min_pq: 62,
			source_max_pq: 3388,
		});

		expect(hex(ours({
			sceneCut: true,
			level6: level6Of(L6_1000),
			sourceMinPq: 62,
			sourceMaxPq: 3388,
		}))).toBe(hex(theirs!));
	});
});

describe.skipIf(!hasDoviTool)('what dovi_tool makes of our octets', () => {
	test('it is a profile 8 RPU with the header profile 8.1 requires', () => {
		const parsed = parseOurs('header', { sceneCut: true, level6: level6Of(L6_1000) });

		expect(parsed.dovi_profile, 'profile 8').toBe(8);
		expect(parsed.header['vdr_rpu_profile']).toBe(1);
		// No enhancement layer and no residual: that is what makes this 8 rather than 7
		expect(parsed.header['disable_residual_flag']).toBe(true);
		expect(parsed.header['el_spatial_resampling_filter_flag']).toBe(false);
		expect(parsed.header['bl_bit_depth_minus8'], 'a 10-bit base layer').toBe(2);
		expect(parsed.header['vdr_dm_metadata_present_flag']).toBe(true);
	});

	test('the blocks come back with the values that went in', () => {
		const parsed = parseOurs('blocks', {
			sceneCut: true,
			level1: { minPq: 12, maxPq: 3000, avgPq: 1500 },
			level5: { left: 1, right: 2, top: 3, bottom: 4 },
			level6: level6Of(L6_1000),
		});

		const blocks = parsed.vdr_dm_data.cmv29_metadata.ext_metadata_blocks;
		expect(blocks.length, 'L1, L5 and L6').toBe(3);

		expect(blocks[0]!['Level1']).toMatchObject({ min_pq: 12, max_pq: 3000, avg_pq: 1500 });
		expect(blocks[1]!['Level5']).toMatchObject({
			active_area_left_offset: 1,
			active_area_right_offset: 2,
			active_area_top_offset: 3,
			active_area_bottom_offset: 4,
		});
		expect(blocks[2]!['Level6']).toMatchObject({
			max_display_mastering_luminance: 1000,
			min_display_mastering_luminance: 1,
			max_content_light_level: 1000,
			max_frame_average_light_level: 400,
		});

		expect(parsed.vdr_dm_data.scene_refresh_flag).toBe(1);
	});

	test('a 13-bit active area offset survives, which a 12-bit field would not', () => {
		// 4096 needs the thirteenth bit; a field written one bit short loses it AND shifts every bit
		// after it, so the CRC fails too
		const parsed = parseOurs('wide-l5', {
			level5: { left: 4096, right: 8191, top: 0, bottom: 0 },
			level6: level6Of(L6_1000),
		});

		expect(parsed.vdr_dm_data.cmv29_metadata.ext_metadata_blocks[0]!['Level5']).toMatchObject({
			active_area_left_offset: 4096,
			active_area_right_offset: 8191,
		});
	});
});

describe('the NAL unit it comes wrapped in', () => {
	test('it is HEVC type 62, which is where an RPU rides', () => {
		const nalUnit = buildDolbyVisionProfile81Rpu({ sceneCut: true });
		expect(nalUnit[0]! >> 1).toBe(HEVC_DOVI_RPU_NAL_TYPE);
		expect(nalUnit[1], 'layer 0, temporal id 1').toBe(1);
		expect(nalUnit[2], 'the RPU prefix octet').toBe(0x19);
	});

	test('it carries no start code of its own, whatever the payload', () => {
		// An RPU is mostly zeroes, so without escaping it is full of accidental start codes and the
		// access unit it is spliced into ends early
		const nalUnit = buildDolbyVisionProfile81Rpu({
			level1: { minPq: 0, maxPq: 0, avgPq: 0 },
			level5: { left: 0, right: 0, top: 0, bottom: 0 },
			level6: {
				maxDisplayMasteringLuminance: 0,
				minDisplayMasteringLuminance: 0,
				maxContentLightLevel: 0,
				maxFrameAverageLightLevel: 0,
			},
		});

		for (let i = 2; i + 2 < nalUnit.length; i++) {
			const isStartCode = nalUnit[i] === 0 && nalUnit[i + 1] === 0 && nalUnit[i + 2]! <= 1;
			expect(isStartCode, `at ${i}`).toBe(false);
		}
	});
});

describe('refusals', () => {
	test('a PQ code that does not fit in twelve bits', () => {
		expect(() => buildDolbyVisionProfile81Rpu({ level1: { minPq: 0, maxPq: 4096, avgPq: 0 } }))
			.toThrow(/level1\.maxPq must be an integer in \[0, 4095\]/);
	});

	test('a minimum brighter than the maximum, which describes no frame', () => {
		expect(() => buildDolbyVisionProfile81Rpu({ level1: { minPq: 100, maxPq: 50, avgPq: 60 } }))
			.toThrow(/cannot exceed/);
	});

	test('an active area offset wider than its thirteen bits', () => {
		expect(() => buildDolbyVisionProfile81Rpu({
			level5: { left: 8192, right: 0, top: 0, bottom: 0 },
		})).toThrow(/level5\.left must be an integer in \[0, 8191\]/);
	});

	test('a non-integer, which would be written as whatever its bits happen to be', () => {
		expect(() => buildDolbyVisionProfile81Rpu({ level1: { minPq: 0.5, maxPq: 10, avgPq: 1 } }))
			.toThrow(/must be an integer/);
	});
});
