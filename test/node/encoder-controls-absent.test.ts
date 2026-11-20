/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Every `encoderControls` field takes null as "absent", and the encoder has to agree with the type.
// The fields are the fork's own in full - `VideoEncoderControls` does not exist upstream - and each
// one is read in `applyEncoderControls`, which runs while the encoder opens, far from the validator
// that admitted the value.
//
// Two oracles, because a broken guard shows up in two different ways:
//
// 1. Most of them throw. `setOrRefuse` hands the value to the encoder, so a null arrives as `null` or
//    as the string "null" and the option is refused; and `dnxProfile`/`d10` refuse outright on a codec
//    that is not theirs, which AVC is not. A guard reading null as a stated value turns an absent
//    field into `UnsupportedEncoderControlError`.
// 2. The rest are silent, and change a parameter instead. `closedGop` is the clearest: null is falsy,
//    so a broken guard writes `open-gop=1` rather than leaving the GOP structure alone. Nothing
//    throws. The decoder configuration is what catches those - it is the one part of this encode that
//    is stable run to run, which the encoded media is NOT. Two identical encodes here produce the same
//    packet count and the same length and different bytes, because the AVC encoder selected is
//    `h264_videotoolbox` and a hardware encoder's output varies per run. Comparing output bytes would
//    fail for a reason that is not a defect. Which encoder gets picked also depends on the controls -
//    the same request came out of libx264 once an interlaced parameter was in play - so nothing here
//    may assume a particular one.
//
// Four of the fields are entered with null and have no observable effect either way, so no oracle can
// cover them and this file does not claim to: `preset` and `tune` reach `setOrRefuse`, where the
// encoder accepts a null option and does nothing with it; `profile` and `level` sit behind
// `profile !== undefined`, and no profile is derived for either encoder measured here, so that branch
// is not entered at all. Their guards are still right - they stop a null being handed to the encoder -
// but a test cannot tell. Measured by instrumenting each branch and logging to a file, because the
// server encoder runs in a worker thread where console output does not reach the runner.

import { beforeAll, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert, toUint8Array } from '../../src/misc.js';
import type { VideoEncoderControls } from '../../src/encode.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

beforeAll(() => {
	registerMediabunnyServer();
});

/** Every field of `VideoEncoderControls`, each stated as null. */
const ALL_NULL: Record<string, null> = {
	profile: null, level: null, preset: null, tune: null, maxBFrames: null, closedGop: null,
	sceneCut: null, pass: null, dnxProfile: null, d10: null, nalHrd: null, picStruct: null,
	interlaced: null, options: null,
};

const encode = async (encoderControls: VideoEncoderControls, codec: 'avc' | 'mpeg2' = 'avc') => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec, bitrate: 1e6, encoderControls },
		trim: { start: 0, end: 0.4 },
	});
	await conversion.execute();
	return new Uint8Array(output.target.buffer!);
};

// MPEG-2 states its parameters in the bitstream rather than in a decoder configuration, so there is
// nothing to read out of the track for it. Everything ahead of the first picture start code is
// header - sequence header, its extensions, the GOP header - and those are deterministic for a given
// input, which the coded slices that follow are not.
const headersBeforeFirstPicture = (packet: Uint8Array) => {
	for (let i = 0; i + 3 < packet.length; i++) {
		if (packet[i] === 0 && packet[i + 1] === 0 && packet[i + 2] === 1 && packet[i + 3] === 0x00) {
			return Buffer.from(packet.subarray(0, i)).toString('hex');
		}
	}
	return null;
};

/** The parts of the result that do not move between two identical encodes. */
const stableShapeOf = async (bytes: Uint8Array) => {
	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config);

	let packetCount = 0;
	const keyFlags: boolean[] = [];
	let firstPacketHeaders: string | null = null;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (packetCount === 0) {
			firstPacketHeaders = headersBeforeFirstPicture(packet.data);
		}

		packetCount++;
		keyFlags.push(packet.type === 'key');
	}

	// One or the other has to be there, or this oracle is reading nothing and would pass whatever
	// happened - which is how a test ends up pointed at an empty string.
	assert(config.description || firstPacketHeaders);

	return {
		codec: config.codec,
		description: config.description
			? Buffer.from(toUint8Array(config.description)).toString('hex')
			: null,
		firstPacketHeaders,
		packetCount,
		keyFlags,
	};
};

test('every encoder control stated as null encodes as if it were absent', async () => {
	const absent = await stableShapeOf(await encode({}));
	const nulls = await stableShapeOf(await encode(ALL_NULL as VideoEncoderControls));
	expect(nulls).toEqual(absent);
}, 180_000);

// One field at a time, so a failure names the field rather than the bag. `dnxProfile` and `d10` are
// the sharpest of these: both refuse on any codec but their own, so a guard that reads null as stated
// refuses an AVC encode outright for a control the caller never set.
test.each(Object.keys(ALL_NULL))('a null %s alone encodes as if it were absent', async (field) => {
	const absent = await stableShapeOf(await encode({}));
	const withNull = await stableShapeOf(await encode({ [field]: null } as VideoEncoderControls));
	expect(withNull).toEqual(absent);
}, 180_000);

// AVC alone cannot settle `profile` and `level`. Their guard is one operand of
// `profile !== undefined && (controls?.profile != null || NAMES_H26X_PROFILES.has(name))`, and that
// set is `{libx264, libx265}` - so for AVC the second operand is already true and the first cannot
// change the outcome. MPEG-2 is not in it, which is what makes the guard decide there.
test('every encoder control stated as null encodes as if absent, on an encoder outside the H.26x set', async () => {
	const absent = await stableShapeOf(await encode({}, 'mpeg2'));
	const nulls = await stableShapeOf(await encode(ALL_NULL as VideoEncoderControls, 'mpeg2'));
	expect(nulls).toEqual(absent);
}, 180_000);

test.each(['profile', 'level', 'd10'])('a null %s alone encodes as if absent on MPEG-2', async (field) => {
	const absent = await stableShapeOf(await encode({}, 'mpeg2'));
	const withNull = await stableShapeOf(await encode({ [field]: null } as VideoEncoderControls, 'mpeg2'));
	expect(withNull).toEqual(absent);
}, 180_000);

// `interlaced` has two branches and the codec picks which. DNxHD takes it as a codec flag, which
// changes the CID the encoder writes - 1241 and 1242 are the interlaced identifiers of the classes
// 1235 and 1237 name progressively - so a null read as stated changes the essence, not just a
// parameter. Neither the AVC nor the MPEG-2 case above enters this branch.
test('a null interlaced is read as absent by the DNxHD branch too', async () => {
	const dnx = async (encoderControls: VideoEncoderControls) => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec: 'dnxhd', width: 1920, height: 1080, fit: 'fill', frameRate: 25,
				encoderControls: { dnxProfile: 'hq', ...encoderControls },
			},
			trim: { start: 0, end: 0.2 },
		});
		await conversion.execute();
		return new Uint8Array(output.target.buffer!);
	};

	const absent = await stableShapeOf(await dnx({}));
	const withNull = await stableShapeOf(await dnx({ interlaced: null }));
	expect(withNull).toEqual(absent);
}, 180_000);
