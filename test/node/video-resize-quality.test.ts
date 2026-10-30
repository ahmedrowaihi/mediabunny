/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The transform's resize is held to FFmpeg's own `scale=flags=lanczos+accurate_rnd+full_chroma_int`,
// because that is what a commercial ladder is graded against and swscale's no-flag default is bicubic -
// verified bit-exactly: `scale=320:180` and `scale=320:180:flags=bicubic` produce identical bytes, while
// bilinear and lanczos each differ.
//
// Compared with no encoder in between: the fork transforms decoded samples and the planes are compared
// against FFmpeg's rawvideo output of the same filter over the same source. The source is lossless
// H.264, so both sides decode the same pixels rather than each side's own lossy copy.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { Conversion } from '../../src/conversion.js';
import { registerMediabunnyServer } from '@mediabunny/server';

registerMediabunnyServer();

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== 'ENOENT';
	}
})();

const resizeTest = test.skipIf(!hasFfmpeg);

const SOURCE_FRAMES = 48;
let dir = '';
let source = '';
/** A real 360p source, so the upscale case resamples rather than passing the frame through. */
let source360 = '';

beforeAll(() => {
	if (!hasFfmpeg) {
		return;
	}

	dir = mkdtempSync(path.join(tmpdir(), 'mb-resize-'));
	source = path.join(dir, 'source.mp4');

	// mandelbrot: fine detail everywhere and continuous motion, which is the hard case for a resampler -
	// a flat synthetic gradient would pass on any kernel. Lossless, so both paths decode the same pixels.
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-f', 'lavfi', '-i', `mandelbrot=size=1920x1080:rate=50`,
		'-frames:v', String(SOURCE_FRAMES),
		'-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
		source, '-y',
	], { stdio: 'ignore' });

	source360 = path.join(dir, 'source-360.mp4');
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-i', source,
		'-vf', 'scale=640:360:flags=lanczos+accurate_rnd+full_chroma_int',
		'-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
		source360, '-y',
	], { stdio: 'ignore' });
});

afterAll(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** FFmpeg's own output for the filter the transform is meant to match, as raw yuv420p. */
const reference = (width: number, height: number, from = source) => {
	const out = path.join(dir, `ref-${path.basename(from)}-${width}x${height}.yuv`);
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-i', from,
		'-vf', `scale=${width}:${height}:flags=lanczos+accurate_rnd+full_chroma_int`,
		'-pix_fmt', 'yuv420p', '-f', 'rawvideo',
		out, '-y',
	], { stdio: 'ignore' });
	return new Uint8Array(readFileSync(out));
};

/** The fork's transform over every decoded sample, plus the timestamps on both sides. */
const throughTransform = async (width: number, height: number, from = source) => {
	using input = new Input({ source: new FilePathSource(from), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const planes: Uint8Array[] = [];
	const sourceTimestamps: number[] = [];
	const resultTimestamps: number[] = [];

	for await (const sample of new VideoSampleSink(track).samples()) {
		sourceTimestamps.push(sample.timestamp);
		using resized = await sample.transform({ width, height, fit: 'fill' });
		resultTimestamps.push(resized.timestamp);

		const buffer = new Uint8Array(resized.allocationSize());
		await resized.copyTo(buffer);
		planes.push(buffer);
		sample.close();
	}

	const total = planes.reduce((sum, plane) => sum + plane.byteLength, 0);
	const joined = new Uint8Array(total);
	let at = 0;
	for (const plane of planes) {
		joined.set(plane, at);
		at += plane.byteLength;
	}

	return { bytes: joined, sourceTimestamps, resultTimestamps, frames: planes.length };
};

/** PSNR in dB over one plane span; Infinity when the two are identical. */
const psnr = (a: Uint8Array, b: Uint8Array, start: number, length: number) => {
	let sum = 0;
	for (let i = start; i < start + length; i++) {
		const difference = a[i]! - b[i]!;
		sum += difference * difference;
	}
	const mse = sum / length;
	return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

/** Per-plane PSNR for a yuv420p buffer of `frames` frames at the given size. */
const planePsnr = (ours: Uint8Array, theirs: Uint8Array, width: number, height: number, frames: number) => {
	const luma = width * height;
	const chroma = (width / 2) * (height / 2);
	const frameBytes = luma + 2 * chroma;
	expect(ours.byteLength).toBe(frameBytes * frames);
	expect(theirs.byteLength).toBe(frameBytes * frames);

	let worstY = Infinity;
	let worstU = Infinity;
	let worstV = Infinity;
	for (let frame = 0; frame < frames; frame++) {
		const base = frame * frameBytes;
		worstY = Math.min(worstY, psnr(ours, theirs, base, luma));
		worstU = Math.min(worstU, psnr(ours, theirs, base + luma, chroma));
		worstV = Math.min(worstV, psnr(ours, theirs, base + luma + chroma, chroma));
	}
	return { worstY, worstU, worstV };
};

for (const [width, height] of [[960, 540], [640, 360], [1280, 720]] as const) {
	resizeTest(`downscaling to ${width}x${height} matches FFmpeg's lanczos`, async () => {
		const { bytes, sourceTimestamps, resultTimestamps, frames } = await throughTransform(width, height);

		expect(frames).toBe(SOURCE_FRAMES);
		expect(resultTimestamps).toEqual(sourceTimestamps);

		const { worstY, worstU, worstV } = planePsnr(bytes, reference(width, height), width, height, frames);

		expect(worstY).toBeGreaterThanOrEqual(50);
		expect(worstU).toBeGreaterThanOrEqual(48);
		expect(worstV).toBeGreaterThanOrEqual(48);
	}, 300_000);
}

resizeTest('upscaling 640x360 to 1920x1080 holds the same bounds', async () => {
	// From a real 360p source: with a 1080p source this size is a pass-through, and every kernel then
	// scores Infinity whether it resamples correctly or not
	const { bytes, frames, sourceTimestamps, resultTimestamps } = await throughTransform(1920, 1080, source360);

	expect(frames).toBe(SOURCE_FRAMES);
	expect(resultTimestamps).toEqual(sourceTimestamps);

	const reference1080 = reference(1920, 1080, source360);
	const { worstY, worstU, worstV } = planePsnr(bytes, reference1080, 1920, 1080, frames);

	expect(worstY).toBeGreaterThanOrEqual(50);
	expect(worstU).toBeGreaterThanOrEqual(48);
	expect(worstV).toBeGreaterThanOrEqual(48);
}, 300_000);

// The consumer's path, not just the transform's. A measurement of "fork 52.5 against ffmpeg bicubic
// 54.5" cannot be explained by the transform having been bicubic - same filter, same output - so
// something else resampled. It was the encoder's fallback scaler, which fires on a format mismatch
// alone: the transform leaves a 4:4:4 source at I444 (verified) and the encoder emits yuv420p, so it
// performs the chroma conversion. A format-only conversion still resamples CHROMA, and `fast_bilinear`
// against the transform's flags scores ~34 dB on it while leaving luma bit-identical.
//
// Compared A/B inside the fork, with no second encoder in the picture: the same lossless encode is fed
// either an I444 sample (the encoder converts) or an I420 sample FFmpeg already converted with the
// reference flags. At quantizer 0 the decode returns the pre-encode planes exactly, so the only
// difference between the two is who subsampled the chroma.
resizeTest('the encoder\'s own 4:4:4 -> 4:2:0 conversion matches FFmpeg\'s', async () => {
	const src444 = path.join(dir, 'src-444.mp4');
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-i', source,
		'-vf', 'scale=640:360:flags=lanczos+accurate_rnd+full_chroma_int',
		'-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p',
		src444, '-y',
	], { stdio: 'ignore' });

	// FFmpeg's chroma conversion, carried losslessly so the fork encodes identical pixels
	const src420 = path.join(dir, 'src-420.mp4');
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-i', src444,
		'-vf', 'scale=640:360:flags=lanczos+accurate_rnd+full_chroma_int',
		'-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
		src420, '-y',
	], { stdio: 'ignore' });

	/** Transform at the same size, encode losslessly, decode, and return the yuv420p planes. */
	const throughEncoder = async (file: string) => {
		using input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const sampleSource = new VideoSampleSource({ codec: 'avc', quality: new Quality({ quantizer: 0 }) });
		output.addVideoTrack(sampleSource);
		await output.start();

		for await (const sample of new VideoSampleSink(track).samples()) {
			using resized = await sample.transform({ width: 640, height: 360, fit: 'fill', alpha: 'discard' });
			await sampleSource.add(resized);
			sample.close();
		}
		await output.finalize();

		using back = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const backTrack = (await back.getPrimaryVideoTrack())!;
		const chunks: Uint8Array[] = [];
		for await (const sample of new VideoSampleSink(backTrack).samples()) {
			const buffer = new Uint8Array(sample.allocationSize());
			await sample.copyTo(buffer);
			chunks.push(buffer);
			sample.close();
		}

		const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const joined = new Uint8Array(total);
		let at = 0;
		for (const chunk of chunks) {
			joined.set(chunk, at);
			at += chunk.byteLength;
		}
		return { bytes: joined, frames: chunks.length };
	};

	const converted = await throughEncoder(src444);
	const preConverted = await throughEncoder(src420);

	expect(converted.frames).toBe(preConverted.frames);
	expect(converted.frames).toBeGreaterThan(0);

	const { worstY, worstU, worstV } = planePsnr(
		converted.bytes, preConverted.bytes, 640, 360, converted.frames,
	);

	// Chroma is the whole point: fast_bilinear scored ~34 dB on this conversion
	expect(worstY).toBeGreaterThanOrEqual(50);
	expect(worstU).toBeGreaterThanOrEqual(48);
	expect(worstV).toBeGreaterThanOrEqual(48);
}, 300_000);

// Decimation and resize composed, held to FFmpeg's own select-then-scale. The selection itself is
// covered over the rate and time base matrix in frame-rate.test.ts; what this adds is the real
// Conversion path, so a correct selection that the pipeline then mis-times or mis-scales still fails.
// 120 source frames because the float slot bug first bites at output 29.
resizeTest('halving the frame rate while resizing matches FFmpeg\'s select-then-scale', async () => {
	const source50 = path.join(dir, 'source-50.mp4');
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=50',
		'-frames:v', '120',
		'-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
		source50, '-y',
	], { stdio: 'ignore' });

	const referencePath = path.join(dir, 'ref-select-scale.yuv');
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-i', source50,
		'-vf', 'select=not(mod(n\\,2)),scale=320:180:flags=lanczos+accurate_rnd+full_chroma_int',
		// Without this the rawvideo muxer duplicates the selected frames back up to the source rate
		'-fps_mode', 'passthrough',
		'-pix_fmt', 'yuv420p', '-f', 'rawvideo',
		referencePath, '-y',
	], { stdio: 'ignore' });

	using input = new Input({ source: new FilePathSource(source50), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: {
			frameRate: 25,
			width: 320,
			height: 180,
			fit: 'fill',
			codec: 'avc',
			// Lossless, so the decode below returns the transform's own pixels rather than an encode of them
			quality: new Quality({ quantizer: 0 }),
		},
		audio: { discard: true },
	});
	await conversion.execute();

	using converted = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = (await converted.getPrimaryVideoTrack())!;

	const planes: Uint8Array[] = [];
	const indices: number[] = [];
	for await (const sample of new VideoSampleSink(track).samples()) {
		indices.push(Math.round(sample.timestamp * 25));
		const buffer = new Uint8Array(sample.allocationSize());
		await sample.copyTo(buffer);
		planes.push(buffer);
		sample.close();
	}

	expect(planes).toHaveLength(60);
	expect(indices).toEqual(Array.from({ length: 60 }, (_, k) => k));

	const ours = new Uint8Array(planes.reduce((sum, plane) => sum + plane.byteLength, 0));
	let at = 0;
	for (const plane of planes) {
		ours.set(plane, at);
		at += plane.byteLength;
	}

	const theirs = new Uint8Array(readFileSync(referencePath));
	const { worstY, worstU, worstV } = planePsnr(ours, theirs, 320, 180, 60);
	expect(worstY).toBe(Infinity);
	expect(worstU).toBe(Infinity);
	expect(worstV).toBe(Infinity);
}, 300_000);
