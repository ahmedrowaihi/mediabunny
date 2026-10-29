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
	ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, Logging, Mp4OutputFormat, Output,
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

describe('Duplicate-copy diagnosis', () => {
	const LOADED = Symbol.for('mediabunny loaded');

	// A second copy of the library is what strands an extension's codecs on the instance the caller is not
	// holding; the conversion then discards every track as undecodable with nothing naming the real cause.
	const warningWithCopies = async (copies: number) => {
		const globals = globalThis as Record<symbol, number>;
		const before = globals[LOADED];
		globals[LOADED] = copies;

		const captured: string[] = [];
		const off = Logging.on('warn', args => captured.push(args.map(a => String(a)).join(' ')));
		try {
			const bytes = readFileSync(path.join(__dirname, '..', 'public', 'video.mp4'));
			const input = new Input({
				source: new BufferSource(new Uint8Array(bytes)),
				formats: ALL_FORMATS,
			});
			await Conversion.init({
				input,
				output: new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() }),
				video: { width: 160 },
				audio: { discard: true },
			});
		} finally {
			off();
			globals[LOADED] = before!;
		}
		return captured.join('\n');
	};

	test('an undecodable track names the duplicate copy when there is one', async () => {
		expect(await warningWithCopies(2)).toContain('More than one copy of Mediabunny is loaded');
	});

	test('and stays quiet about it when there is not', async () => {
		const warning = await warningWithCopies(1);
		expect(warning).toContain('discarded from the conversion');
		expect(warning).not.toContain('More than one copy of Mediabunny is loaded');
	});
});
