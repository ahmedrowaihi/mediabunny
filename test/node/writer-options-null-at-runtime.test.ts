/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The runtime twin of test/types/writer-options-accept-null.ts. That one proves the TYPES admit null;
// this proves the validators do. The two come apart: a validator takes its value as `unknown` and
// shape-checks it at runtime, so `typeof null === 'object'` has to be rejected explicitly - and when
// it is, a field whose type accepts null still throws. `MpegTsOutputFormat({ service: null })` did
// exactly that, and no amount of type checking could have seen it.
//
// The field names come out of the built declarations rather than a list here, so a field added later
// is covered without anyone remembering to add it.

import { expect, test } from 'vitest';
import {
	DashOutputFormatOptions, HlsOutputFormatOptions, MpegTsOutputFormat, MpegTsOutputFormatOptions,
	Mp4OutputFormat, HlsOutputFormat, DashOutputFormat, WebMOutputFormat, BufferTarget,
	EncodedVideoPacketSource, Output, VideoEncoderControls, VideoEncodingConfig, VideoSampleSource,
	VideoTrackMetadata,
} from '../../src/index.js';
import { nullableFieldsOfType } from './_nullable-fields.js';

const expectNullAccepted = (typeName: string, construct: (options: Record<string, null>) => unknown) => {
	const fields = nullableFieldsOfType(typeName);
	expect(fields.length, `${typeName}: no nullable fields found in dist/mediabunny.d.ts`).toBeGreaterThan(0);

	// One field at a time, so a failure names the field rather than the bag.
	const rejected: string[] = [];
	for (const field of fields) {
		try {
			construct({ [field]: null });
		} catch {
			rejected.push(field);
		}
	}
	expect(rejected, `${typeName} fields that accept null in the type but throw at runtime`).toEqual([]);

	// And all of them together, which is how a caller spreading their own options hits it.
	expect(() => construct(Object.fromEntries(fields.map(f => [f, null])))).not.toThrow();
};

test('every nullable MpegTsOutputFormat option is accepted at runtime', () => {
	expectNullAccepted('MpegTsOutputFormatOptions', o => new MpegTsOutputFormat(o as MpegTsOutputFormatOptions));
});

test('every nullable HlsOutputFormat option is accepted at runtime', () => {
	expectNullAccepted('HlsOutputFormatOptions', o => new HlsOutputFormat(
		{ segmentFormat: new MpegTsOutputFormat(), ...o } as unknown as HlsOutputFormatOptions,
	));
});

test('every nullable DashOutputFormat option is accepted at runtime', () => {
	expectNullAccepted('DashOutputFormatOptions', o => new DashOutputFormat(
		{ segmentFormat: new Mp4OutputFormat(), mpdPath: 'manifest.mpd', ...o } as unknown as DashOutputFormatOptions,
	));
});

test('every nullable Mp4OutputFormat and WebM option is accepted at runtime', () => {
	expectNullAccepted('IsobmffOutputFormatOptions', o => new Mp4OutputFormat(o));
	expectNullAccepted('MkvOutputFormatOptions', o => new WebMOutputFormat(o));
});

test('every nullable VideoEncoderControls option is accepted at runtime', () => {
	expectNullAccepted('VideoEncoderControls', o => new VideoSampleSource({
		codec: 'avc', bitrate: 1e6, encoderControls: o as VideoEncoderControls,
	}));
});

test('every nullable video encoding option is accepted at runtime', () => {
	expectNullAccepted('VideoEncodingAdditionalOptions', o => new VideoSampleSource(
		{ codec: 'avc', bitrate: 1e6, ...o } as VideoEncodingConfig,
	));
});

test('every nullable VideoTrackMetadata field is accepted at runtime', () => {
	expectNullAccepted('VideoTrackMetadata', (o) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		output.addVideoTrack(new EncodedVideoPacketSource('avc'), o as VideoTrackMetadata);
	});
});

// Both of these threw before the guards read null as absent, and neither is a type error: the field
// was stated as null, the validator saw a value, and refused the track for a reason the caller never
// gave it. They are named rather than left to the generic sweep above because the refusal message is
// what a caller would have reported.
test('a null timecode does not demand a frameRate alongside it', () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	expect(() => output.addVideoTrack(
		new EncodedVideoPacketSource('avc'), { timecode: null } as VideoTrackMetadata,
	)).not.toThrow();
});

test('a null activeFormatDescription does not demand a codec that carries SEI', () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	expect(() => output.addVideoTrack(
		new EncodedVideoPacketSource('vp9'), { activeFormatDescription: null } as VideoTrackMetadata,
	)).not.toThrow();
});
