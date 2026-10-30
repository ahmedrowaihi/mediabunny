/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A packet's own type says 'key' or 'delta', and a codec string says nothing about film grain. Both are facts
// a consumer otherwise has to trace with ffprobe, which is the point of reading them out of the bitstream.

import { expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { Quality, type VideoEncoderControls } from '../../src/encode.js';
import { createAv1FilmGrainStateReader, readVideoSliceType, type VideoSliceType } from '../../src/bitstream-info.js';
import { extractVideoBitDepth, type VideoBitDepth } from '../../src/codec.js';
import {
	deserializeHevcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import { toUint8Array } from '../../src/misc.js';

registerMediabunnyServer();

const FPS = 24;
const FRAMES = 24;
const WIDTH = 256;
const HEIGHT = 144;

/** Moving structure, so the encoder has something to predict rather than coding every frame intra. */
const frameAt = (index: number) => {
	const data = new Uint8Array(WIDTH * HEIGHT * 4);
	for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
		const x = pixel % WIDTH;
		const y = Math.floor(pixel / WIDTH);
		const value = ((x + 3 * index) & 0x20) ^ ((y >> 3) & 1 ? 0xff : 0) ? 220 : 30;
		data[4 * pixel] = value;
		data[4 * pixel + 1] = value;
		data[4 * pixel + 2] = value;
	}

	return data;
};

const encode = async (options: {
	codec: 'avc' | 'hevc' | 'av1';
	encoderControls?: VideoEncoderControls;
	bitDepth?: VideoBitDepth;
	quality?: Quality;
}) => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new VideoSampleSource({
		codec: options.codec,
		quality: options.quality ?? new Quality('low'),
		keyFrameInterval: 10,
		hardwareAcceleration: 'prefer-software',
		encoderControls: options.encoderControls,
		bitDepth: options.bitDepth,
	});
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < FRAMES; i++) {
		using sample = new VideoSample(frameAt(i), {
			format: 'RGBX',
			codedWidth: WIDTH,
			codedHeight: HEIGHT,
			timestamp: i / FPS,
			duration: 1 / FPS,
		});
		await source.add(sample);
	}
	source.close();
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packets = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push({ type: packet.type, timestamp: packet.timestamp, data: packet.data });
	}

	return { decoderConfig, packets };
};

test.each(['avc', 'hevc'] as const)(
	'%s slice types name how each packet is coded, not whether it is a sync sample',
	async (codec) => {
		// B frames, so the result has to distinguish all three rather than only intra from inter
		const { decoderConfig, packets } = await encode({ codec, encoderControls: { maxBFrames: 3 } });
		const sliceTypes = packets.map(p => readVideoSliceType(p.data, decoderConfig, codec));

		expect(sliceTypes).not.toContain(null);

		// Every sync sample is intra-coded, which is the half of the mapping the packet type already implies
		for (const [index, { type }] of packets.entries()) {
			if (type === 'key') {
				expect(sliceTypes[index]).toBe('i');
			}
		}

		// The half it does not: a reader that returned a constant, or only ever 'i', would pass the above
		const kinds = new Set(sliceTypes as VideoSliceType[]);
		expect(kinds).toContain('i');
		expect(kinds).toContain('p');
		expect(kinds).toContain('b');

		// Decode order against presentation order, which is the container's account rather than this reader's:
		// a packet decoded after a frame it presents before can only be a B frame, and a P frame never is one.
		// Without this, a mapping with 'p' and 'b' swapped would satisfy every assertion above.
		let highestSoFar = -Infinity;
		let reordered = 0;
		for (const [index, packet] of packets.entries()) {
			if (packet.timestamp < highestSoFar) {
				reordered++;
				expect(sliceTypes[index]).toBe('b');
			} else {
				expect(sliceTypes[index]).not.toBe('b');
			}

			highestSoFar = Math.max(highestSoFar, packet.timestamp);
		}

		expect(reordered).toBeGreaterThan(0);
	},
	300_000,
);

test('readVideoSliceType reports nothing rather than guessing on data that carries no slice', async () => {
	const { decoderConfig } = await encode({ codec: 'avc' });

	expect(readVideoSliceType(new Uint8Array(0), decoderConfig, 'avc')).toBe(null);
	// A well-formed length prefix over a truncated slice header, which the exp-Golomb reader rejects
	expect(readVideoSliceType(new Uint8Array([0, 0, 0, 2, 0x65, 0x00]), decoderConfig, 'avc')).toBe(null);
}, 300_000);

test('AV1 film grain reads as absent unless the encoder was asked to synthesize it', async () => {
	const plain = await encode({ codec: 'av1' });
	const plainReader = createAv1FilmGrainStateReader(plain.decoderConfig.description);
	const plainStates = plain.packets.map(p => plainReader.read(p.data));

	expect(plainStates.every(state => state?.filmGrainParamsPresent === false)).toBe(true);
	expect(plainStates.some(state => state?.applyGrain)).toBe(false);

	// SVT-AV1's film-grain denoise level, which turns synthesis on
	const grainy = await encode({
		codec: 'av1',
		encoderControls: { options: { 'svtav1-params': 'film-grain=12' } },
	});
	const grainyReader = createAv1FilmGrainStateReader(grainy.decoderConfig.description);
	const grainyStates = grainy.packets.map(p => grainyReader.read(p.data));

	expect(grainyStates.every(state => state?.filmGrainParamsPresent === true)).toBe(true);
	expect(grainyStates.some(state => state?.applyGrain === true)).toBe(true);
}, 300_000);

// A profile only bounds the depth a stream may use. Reading the bound as the depth made every rung of a
// lossless 8-bit source 10-bit, so these assert the config's answer rather than the codec string's.
const BIT_DEPTH_CASES = [
	{
		// x264 goes lossless at quantizer 0, which forces High 4:4:4 Predictive - the profile whose permitted
		// depths run from 8 to 14, while this stream is 8-bit. This is the case that was read as 10-bit.
		label: 'avc lossless, High 4:4:4 Predictive, 8-bit',
		encode: { codec: 'avc' as const, quality: new Quality({ quantizer: 0 }) },
		expected: 8 as VideoBitDepth,
	},
	{
		label: 'avc High, 8-bit',
		encode: { codec: 'avc' as const, encoderControls: { profile: 'high' } },
		expected: 8 as VideoBitDepth,
	},
	{
		label: 'avc 10-bit',
		encode: { codec: 'avc' as const, bitDepth: 10 as VideoBitDepth },
		expected: 10 as VideoBitDepth,
	},
	{
		label: 'hevc Main, 8-bit',
		encode: { codec: 'hevc' as const, encoderControls: { profile: 'main' } },
		expected: 8 as VideoBitDepth,
	},
	{
		label: 'hevc Main 10',
		encode: { codec: 'hevc' as const, bitDepth: 10 as VideoBitDepth },
		expected: 10 as VideoBitDepth,
	},
	{
		// Asked for main444-8; x265 encodes Main instead, because the input is 4:2:0. Kept because the asked-for
		// depth is what matters here, but it is Main that is measured - this path reaches no RExt profile.
		label: 'hevc 4:4:4 8-bit requested',
		encode: { codec: 'hevc' as const, encoderControls: { profile: 'main444-8' } },
		expected: 8 as VideoBitDepth,
	},
];

test.each(BIT_DEPTH_CASES)(
	'bit depth comes from the decoder config, not the profile ($label)',
	async ({ encode: options, expected }) => {
		const { decoderConfig } = await encode(options);

		expect(extractVideoBitDepth(decoderConfig)).toBe(expected);
	},
	300_000,
);

test('the codec string alone cannot tell an 8-bit lossless AVC stream from a 10-bit one', async () => {
	const { decoderConfig } = await encode({ codec: 'avc', quality: new Quality({ quantizer: 0 }) });

	// profile_idc 244, High 4:4:4 Predictive, which permits 8 to 14 bits and states none of them
	expect(decoderConfig.codec.startsWith('avc1.f4')).toBe(true);

	// The bug: with only the string there is nothing to read but the profile's upper bound. Were this to start
	// agreeing with the config, the lossless row above would have stopped covering anything.
	expect(extractVideoBitDepth(decoderConfig.codec)).toBe(10);
	expect(extractVideoBitDepth(decoderConfig)).toBe(8);
}, 300_000);

test('hevc bit depth is read out of hvcC, which states depths no codec string carries', async () => {
	const { decoderConfig } = await encode({ codec: 'hevc', bitDepth: 10 });
	const record = deserializeHevcDecoderConfigurationRecord(toUint8Array(decoderConfig.description!))!;

	// A 12-bit Range Extensions stream. x265 reaches no RExt profile from 4:2:0 input, so the record is edited
	// rather than encoded - but hvcC's own field is what the HEVC branch reads, and this is that field.
	const rExt = { ...record, generalProfileIdc: 4, bitDepthLumaMinus8: 4, bitDepthChromaMinus8: 4 };
	const config = {
		codec: 'hvc1.4.4.L60.90',
		description: serializeHevcDecoderConfigurationRecord(rExt),
	};

	// RExt states its depth in the config alone; the string's profile number says nothing about it
	expect(extractVideoBitDepth(config.codec)).toBe(8);
	expect(extractVideoBitDepth(config)).toBe(12);
}, 300_000);
