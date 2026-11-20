/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A caller awaiting each `add` expects the encoder's backpressure to reach it, so a live pipeline stays
// within a packet or two of its encoder. Anything that buffers samples on the way to the encoder breaks
// that silently: `add` resolves, the caller runs ahead, and the backlog only shows up at `finalize`.

import { expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { AudioSampleSource, VideoSampleSource } from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { NullTarget } from '../../src/target.js';
import { Quality, type AudioEncodingConfig, type VideoEncodingConfig } from '../../src/encode.js';

registerMediabunnyServer();

const SAMPLE_COUNT = 500;
const FRAMES_PER_SAMPLE = 1024;
const VIDEO_FRAME_COUNT = 120;

/**
 * The largest number of added samples the encoder had not yet emitted a packet for. How deep this sits with no
 * transform is the encoder's own business - libx264 holds far more frames than videotoolbox does - so it is only
 * ever read against the same source's no-transform measurement, never against a number.
 */
type Backlog = { mostQueued: number };

const measureAudio = async (
	transform: AudioEncodingConfig['transform'],
	input: { sampleRate: number; numberOfChannels: number },
): Promise<Backlog> => {
	let encoded = 0;
	const source = new AudioSampleSource({
		codec: 'aac',
		quality: new Quality({ bitrate: 64_000 }),
		onEncodedPacket: () => void encoded++,
		transform,
	});

	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new NullTarget() });
	output.addAudioTrack(source);
	await output.start();

	let mostQueued = 0;
	for (let i = 0; i < SAMPLE_COUNT; i++) {
		using sample = new AudioSample({
			format: 'f32-planar',
			data: new Float32Array(FRAMES_PER_SAMPLE * input.numberOfChannels),
			numberOfChannels: input.numberOfChannels,
			sampleRate: input.sampleRate,
			timestamp: (i * FRAMES_PER_SAMPLE) / input.sampleRate,
		});
		await source.add(sample);
		mostQueued = Math.max(mostQueued, i + 1 - encoded);
	}

	source.close();
	await output.finalize();

	return { mostQueued };
};

const measureVideo = async (transform: VideoEncodingConfig['transform']): Promise<Backlog> => {
	let encoded = 0;
	const source = new VideoSampleSource({
		codec: 'avc',
		bitrate: 500_000,
		onEncodedPacket: () => void encoded++,
		transform,
	});

	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new NullTarget() });
	output.addVideoTrack(source);
	await output.start();

	let mostQueued = 0;
	for (let i = 0; i < VIDEO_FRAME_COUNT; i++) {
		using sample = new VideoSample(new Uint8Array(320 * 240 * 3 / 2).fill(i), {
			format: 'I420',
			codedWidth: 320,
			codedHeight: 240,
			timestamp: i / 30,
			duration: 1 / 30,
		});
		await source.add(sample);
		mostQueued = Math.max(mostQueued, i + 1 - encoded);
	}

	source.close();
	await output.finalize();

	return { mostQueued };
};

test('an audio transform does not let the caller run ahead of its encoder', async () => {
	const plain = await measureAudio(undefined, { sampleRate: 48_000, numberOfChannels: 2 });
	// Same rate and channel count: the transform states what the encoder must see, nothing is resampled
	const pinned = await measureAudio(
		{ sampleRate: 48_000, numberOfChannels: 2 },
		{ sampleRate: 48_000, numberOfChannels: 2 },
	);
	// A real resample, which is why a live pipeline states the transform in the first place
	const resampled = await measureAudio(
		{ sampleRate: 48_000, numberOfChannels: 2 },
		{ sampleRate: 44_100, numberOfChannels: 1 },
	);

	// Packets came out while the loop was still adding, without which the comparisons below say nothing
	expect(plain.mostQueued).toBeLessThan(SAMPLE_COUNT);

	expect(pinned.mostQueued).toBeLessThanOrEqual(plain.mostQueued + 4);
	expect(resampled.mostQueued).toBeLessThanOrEqual(plain.mostQueued + 4);
}, 300_000);

test('a video transform does not let the caller run ahead of its encoder', async () => {
	const plain = await measureVideo(undefined);
	const scaled = await measureVideo({ width: 160, height: 120, fit: 'fill' });

	expect(plain.mostQueued).toBeLessThan(VIDEO_FRAME_COUNT);
	expect(scaled.mostQueued).toBeLessThanOrEqual(plain.mostQueued + 4);
}, 300_000);
