/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
	ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output,
} from '../../src/index.js';

// This file must not call registerMediabunnyServer(): with no decoders registered, a forced
// transcode is undecodable, which is the condition under test. Vitest's `forks` pool keeps a
// registration in another file from leaking in here.

const initConversion = async (options: { width?: number; discardAudio?: boolean }) => {
	const input = new Input({
		source: new BufferSource(new Uint8Array(readFileSync(path.join(__dirname, '..', 'public', 'video.mp4')))),
		formats: ALL_FORMATS,
	});
	return Conversion.init({
		input,
		output: new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() }),
		// Resizing forces a decode + re-encode rather than a copy.
		video: options.width === undefined ? { discard: true } : { width: options.width },
		audio: options.discardAudio ? { discard: true } : {},
		showWarnings: false,
	});
};

describe('Conversion validity explanations', () => {
	test('a missing decoder names the source codec and the package that provides one', async () => {
		const conversion = await initConversion({ width: 160, discardAudio: true });

		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.map(x => x.reason)).toContain('undecodable_source_codec');

		const error = await conversion.execute().then(() => null, (e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		// The generic message names the *output* configuration, so without a decodability branch
		// this points the caller at the wrong end of the conversion.
		expect(error!.message).toContain('not able to decode the source codec \'avc\'');
		expect(error!.message).toContain('registerMediabunnyServer()');
		expect(error!.message).not.toContain('Check the discardedTracks field for more info.');
	});

	test('tracks discarded only by the user still get the generic explanation', async () => {
		const conversion = await initConversion({ discardAudio: true });

		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.every(x => x.reason === 'discarded_by_user')).toBe(true);

		const error = await conversion.execute().then(() => null, (e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error!.message).toContain('Check the discardedTracks field for more info.');
		expect(error!.message).not.toContain('not able to decode');
	});
});
