import { expect, test } from 'vitest';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample } from '../../src/sample.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';

test('Output buffer boundary with fractional chunk endpoint', async () => {
	const output: number[] = [];
	const outputLengths: number[] = [];
	const resampler = new AudioResampler({
		targetSampleRate: 12,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			output.push(...data);
			outputLengths.push(sample.numberOfFrames);
			sample.close();
		},
	});

	// At 5 Hz in and 12 Hz out, the second chunk ends at output frame 62.4, past the end of the first buffer
	const samples = [
		{ frames: 1, timestamp: 0 },
		{ frames: 25, timestamp: 1 / 5 },
		{ frames: 4, timestamp: 26 / 5 },
	].map(({ frames, timestamp }) => new AudioSample({
		format: 'f32',
		sampleRate: 5,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(frames).fill(0.75),
	}));

	for (const sample of samples) {
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	// 30 input frames at 5 Hz is 6 seconds, so 72 output frames at 12 Hz, across however many buffers
	expect(outputLengths.reduce((a, b) => a + b, 0)).toBe(72);
	expect(output.slice(58, 63)).toEqual([0.75, 0.75, 0.75, 0.75, 0.75]);
});

test('Exact output frame count across chunks', async () => {
	let outputFrames = 0;
	const resampler = new AudioResampler({
		targetSampleRate: 48000,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			outputFrames += sample.numberOfFrames;
			sample.close();
		},
	});

	// The last chunk's end lands exactly on an output frame, which plain float time math overshoots
	for (let i = 0; i < 343; i++) {
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 22050,
			numberOfChannels: 1,
			timestamp: 1152 * i / 22050,
			data: new Float32Array(1152).fill(0.5),
		});
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	expect(outputFrames).toBe(343 * 1152 * 48000 / 22050);
});

test('a sample rate transform absorbs a change of input rate', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({
		codec: 'pcm-s16',
		// The whole point of pinning the rate: what reaches the encoder is constant even when the
		// source changes, which is what a failover between two inputs looks like.
		transform: { sampleRate: 48_000 },
	});
	output.addAudioTrack(source);
	await output.start();

	const sampleAt = (sampleRate: number, timestamp: number) => new AudioSample({
		format: 'f32',
		sampleRate,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(sampleRate / 10),
	});

	await source.add(sampleAt(44_100, 0));
	await source.add(sampleAt(48_000, 0.1));

	source.close();
	await output.finalize();
	expect(output.target.buffer!.byteLength).toBeGreaterThan(0);
}, 60_000);

test('without a transform, a change of input rate is still rejected', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();

	const sampleAt = (sampleRate: number, timestamp: number) => new AudioSample({
		format: 'f32',
		sampleRate,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(sampleRate / 10),
	});

	await source.add(sampleAt(44_100, 0));
	await expect(source.add(sampleAt(48_000, 0.1))).rejects.toThrow(/must remain constant/);

	await output.cancel();
}, 60_000);
