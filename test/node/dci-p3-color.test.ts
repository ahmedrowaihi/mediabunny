/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// DCI-P3 primaries (CICP 11) and digital cinema's 2.6 gamma (CICP 17). WebCodecs names neither, so the
// value has to survive a path that is WebCodecs-typed in places without being narrowed away.

import { expect, test } from 'vitest';
import {
	COLOR_PRIMARIES_MAP,
	COLOR_PRIMARIES_MAP_INVERSE,
	TRANSFER_CHARACTERISTICS_MAP,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
} from '../../src/misc.js';
import { validateVideoColorSpaceInit } from '../../src/codec.js';
import type { WideVideoColorSpaceInit } from '../../src/misc.js';
import type { VideoEncodingConfig } from '../../src/encode.js';
import { validateVideoOptions, type ConversionVideoOptions } from '../../src/conversion.js';

test('the CICP maps carry DCI-P3 and 2.6 gamma, in both directions', () => {
	expect(COLOR_PRIMARIES_MAP.smpte431).toBe(11);
	expect(TRANSFER_CHARACTERISTICS_MAP.smpte428).toBe(17);
	// The read direction is what a demuxer uses on an SPS or a colr box; before this it yielded undefined
	expect(COLOR_PRIMARIES_MAP_INVERSE[11]).toBe('smpte431');
	expect(TRANSFER_CHARACTERISTICS_MAP_INVERSE[17]).toBe('smpte428');
});

test('a caller may state them, and the validator accepts them', () => {
	expect(() => validateVideoColorSpaceInit(
		{ primaries: 'smpte431', transfer: 'smpte428', matrix: 'bt709', fullRange: false },
		'colorSpace',
	)).not.toThrow();

	// The union and the maps are separate statements of the same set, so a value in neither still fails
	expect(() => validateVideoColorSpaceInit(
		{ primaries: 'dci-p3' as unknown as 'smpte431' },
		'colorSpace',
	)).toThrow('primaries');
});

// The widening is only useful on the caller-facing options. These annotations are the assertion: with
// WebCodecs' own type they do not compile, so `npm run check` fails if the widening is reverted.
test('the encoding and conversion options accept them', () => {
	const colorSpace: WideVideoColorSpaceInit = { primaries: 'smpte431', transfer: 'smpte428' };

	const encoding: VideoEncodingConfig = { codec: 'avc', bitrate: 1e6, colorSpace };
	const conversion: ConversionVideoOptions = { colorSpace };

	expect(encoding.colorSpace?.primaries).toBe('smpte431');
	expect(conversion.colorSpace?.transfer).toBe('smpte428');

	// And the runtime path a caller actually hits
	expect(() => validateVideoOptions(conversion)).not.toThrow();
});
