/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Scene-cut detection has to buy an intra frame at a cut WITHOUT moving a sync sample, because a ladder's
// rungs are aligned by their sync samples and a segment must not start at a cut. Measured: left to itself,
// x264 and x265 promote a cut past their own minimum interval to an IDR, which breaks both.

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
import { readVideoSliceType, type VideoSliceType } from '../../src/bitstream-info.js';

registerMediabunnyServer();

const FPS = 24;
const SECONDS = 8;
const KEY_FRAME_INTERVAL = 2;
const CUTS = [1.3, 3.7, 5.1];

/** Which shot a timestamp belongs to; each cut starts a visually unrelated shot. */
const shotAt = (timestamp: number) => CUTS.filter(cut => timestamp >= cut).length;

type Encoded = { timestamp: number; isSync: boolean; kind: VideoSliceType | null };

const encode = async (options: {
	codec: 'avc' | 'hevc';
	height: number;
	encoderControls?: VideoEncoderControls;
	fragmented?: boolean;
	quality?: Quality;
}) => {
	const width = Math.round(options.height * 16 / 9 / 2) * 2;
	const output = new Output({
		format: new Mp4OutputFormat(options.fragmented ? { fastStart: 'fragmented' } : {}),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({
		codec: options.codec,
		quality: options.quality ?? new Quality('low'),
		keyFrameInterval: KEY_FRAME_INTERVAL,
		hardwareAcceleration: 'prefer-software',
		encoderControls: options.encoderControls,
	});
	output.addVideoTrack(source);
	await output.start();

	const data = new Uint8Array(width * options.height * 4);
	for (let i = 0; i < SECONDS * FPS; i++) {
		const timestamp = i / FPS;
		const shot = shotAt(timestamp);
		// Each shot is a distinct low-entropy structure: cheap to code intra, expensive to predict across.
		// Measured: noise does not work as a fixture here - a cut into it is expensive either way, so x264's
		// metric does not trip and the detector stays silent on a cut that is plainly a cut.
		for (let pixel = 0; pixel < width * options.height; pixel++) {
			const x = pixel % width;
			const y = Math.floor(pixel / width);
			const value = shot === 0
				? (x * 2) & 0xff
				: shot === 1
					? (y * 3) & 0xff
					: shot === 2
						? ((((x >> 3) + (y >> 3)) % 2) ? 230 : 25)
						: (((y >> 4) % 2) ? 240 : 15);

			data[4 * pixel] = value;
			data[4 * pixel + 1] = value;
			data[4 * pixel + 2] = value;
		}

		using sample = new VideoSample(data, {
			format: 'RGBX',
			codedWidth: width,
			codedHeight: options.height,
			timestamp,
			duration: 1 / FPS,
		});
		await source.add(sample);
	}
	source.close();
	await output.finalize();

	using written = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await written.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packets: Encoded[] = [];
	let packetBytes = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packetBytes += packet.byteLength;
		packets.push({
			timestamp: Math.round(packet.timestamp * 1000) / 1000,
			isSync: packet.type === 'key',
			kind: readVideoSliceType(packet.data, decoderConfig, options.codec),
		});
	}

	return { packets, packetBytes };
};

const syncTimestamps = (packets: Encoded[]) => packets.filter(p => p.isSync).map(p => p.timestamp);
const intraNonSync = (packets: Encoded[]) =>
	packets.filter(p => !p.isSync && p.kind === 'i').map(p => p.timestamp);

/**
 * Whether every intra frame sits at a cut. Which cuts an encoder detects is its own heuristic on the content
 * - measured, x264 finds all three of this fixture's and x265 two of the three - so what the library can
 * promise is that detection is on and that an intra frame appears only where there is a cut, never mid-shot.
 */
const everyIntraSitsAtACut = (timestamps: number[]) =>
	timestamps.every(t => CUTS.some(cut => Math.abs(t - cut) <= 1 / FPS + 1e-6));

const RUNGS = [
	{ codec: 'avc' as const, height: 144 },
	{ codec: 'avc' as const, height: 180 },
	{ codec: 'hevc' as const, height: 144 },
	{ codec: 'hevc' as const, height: 180 },
];

// Row 1
test.each(RUNGS)(
	'sceneCut adds intra frames only at cuts, leaving the sync samples on the grid ($codec $height)',
	async ({ codec, height }) => {
		const on = await encode({ codec, height, encoderControls: { sceneCut: 40 } });

		// The forced grid, and nothing else: 8 s at a 2 s interval
		expect(syncTimestamps(on.packets)).toEqual([0, 2, 4, 6]);

		const intra = intraNonSync(on.packets);
		expect(intra.length).toBeGreaterThan(0);
		expect(everyIntraSitsAtACut(intra)).toBe(true);

		const off = await encode({ codec, height });
		expect(syncTimestamps(off.packets)).toEqual([0, 2, 4, 6]);
		expect(intraNonSync(off.packets)).toEqual([]);
	},
	600_000,
);

// Row 1, second half: with the control off, the output is what it was before the control existed
test('with sceneCut off the encoded bitstream is identical to one that states no controls', async () => {
	const without = await encode({ codec: 'avc', height: 144 });
	const explicitlyOff = await encode({ codec: 'avc', height: 144, encoderControls: { sceneCut: false } });

	// The packets, not the file: the container stamps a creation time, so two identical encodes differ there
	expect(explicitlyOff.packets).toEqual(without.packets);
	expect(explicitlyOff.packetBytes).toEqual(without.packetBytes);
}, 600_000);

// Row 2
test('every rung agrees on its sync sample timestamps, whatever its codec or height', async () => {
	const perRung = [];
	for (const rung of RUNGS) {
		perRung.push(syncTimestamps((await encode({ ...rung, encoderControls: { sceneCut: 40 } })).packets));
	}

	for (const timestamps of perRung) {
		expect(timestamps).toEqual(perRung[0]);
	}
}, 900_000);

// Row 3
test.each([['progressive', false], ['fragmented', true]] as const)(
	'no %s fragment starts on a scene-cut intra frame',
	async (_label, fragmented) => {
		const { packets } = await encode({
			codec: 'avc',
			height: 144,
			fragmented,
			encoderControls: { sceneCut: 40 },
		});

		// A fragment can only begin at a sync sample, so this is the property that keeps a cut out of one
		expect(syncTimestamps(packets)).toEqual([0, 2, 4, 6]);
		expect(intraNonSync(packets).length).toBeGreaterThan(0);
		expect(everyIntraSitsAtACut(intraNonSync(packets))).toBe(true);
		for (const cut of CUTS) {
			expect(syncTimestamps(packets)).not.toContain(Math.round(cut * 1000) / 1000);
		}
	},
	600_000,
);

// Row 4
test('two-pass and capped quality both keep the contract', async ({ onTestFinished }) => {
	const { mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const path = await import('node:path');
	const statsPath = path.join(mkdtempSync(path.join(tmpdir(), 'mb-scenecut-')), 'x264.log');
	onTestFinished(() => {});

	// A bitrate target, because x264 refuses two-pass alongside constant quality
	const twoPassQuality = new Quality({ bitrate: 800_000 });

	const firstPass = await encode({
		codec: 'avc',
		height: 144,
		quality: twoPassQuality,
		encoderControls: { sceneCut: 40, pass: { index: 1, statsPath } },
	});
	expect(syncTimestamps(firstPass.packets)).toEqual([0, 2, 4, 6]);

	const secondPass = await encode({
		codec: 'avc',
		height: 144,
		quality: twoPassQuality,
		encoderControls: { sceneCut: 40, pass: { index: 2, statsPath } },
	});
	expect(syncTimestamps(secondPass.packets)).toEqual([0, 2, 4, 6]);
	expect(everyIntraSitsAtACut(intraNonSync(secondPass.packets))).toBe(true);

	// Capped quality: a quantizer under a peak bitrate, which is a different rate control path
	const capped = await encode({
		codec: 'avc',
		height: 144,
		quality: new Quality({ quantizer: 28, maxBitrate: 1_500_000 }),
		encoderControls: { sceneCut: 40 },
	});
	expect(syncTimestamps(capped.packets)).toEqual([0, 2, 4, 6]);
	expect(intraNonSync(capped.packets).length).toBeGreaterThan(0);
	expect(everyIntraSitsAtACut(intraNonSync(capped.packets))).toBe(true);
}, 900_000);

test('sceneCut is refused where the encoder has no scene-cut detection, and validated as a threshold', () => {
	// vp9 goes to libvpx, which has no equivalent, so stating it is an error rather than a silent no-op
	expect(() => new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('low'),
		encoderControls: { sceneCut: 40 },
	})).not.toThrow(); // The refusal comes from the encoder, not the constructor

	expect(() => new VideoSampleSource({
		codec: 'avc',
		quality: new Quality('low'),
		encoderControls: { sceneCut: 0 },
	})).toThrow(/sceneCut/);

	expect(() => new VideoSampleSource({
		codec: 'avc',
		quality: new Quality('low'),
		encoderControls: { sceneCut: 101 },
	})).toThrow(/sceneCut/);
});

test('a vp9 encode refuses a stated sceneCut rather than ignoring it', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('low'),
		hardwareAcceleration: 'prefer-software',
		encoderControls: { sceneCut: 40 },
	});
	output.addVideoTrack(source);
	await output.start();

	const data = new Uint8Array(256 * 144 * 4).fill(80);
	using sample = new VideoSample(data, {
		format: 'RGBX', codedWidth: 256, codedHeight: 144, timestamp: 0, duration: 1 / FPS,
	});

	await expect((async () => {
		await source.add(sample);
		source.close();
		await output.finalize();
	})()).rejects.toThrow(/sceneCut/);
}, 120_000);
