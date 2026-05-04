import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert, getFrameDurationFromRate } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('InputVideoTrack.getFrameRate reads non-fragmented MP4 stts directly', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const rate = await track.getFrameRate();
	assert(rate);
	expect(rate.num).toBe(25);
	expect(rate.den).toBe(1);
});

test('InputVideoTrack.getFrameRate handles fragmented MP4 via packet sampling', async () => {
	using progressive = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const fragmentedOutput = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({
		input: progressive,
		output: fragmentedOutput,
		showWarnings: false,
	});
	await conversion.execute();

	using fragmented = new Input({
		source: new BufferSource(fragmentedOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await fragmented.getPrimaryVideoTrack();
	assert(track);

	const rate = await track.getFrameRate();
	assert(rate);
	expect(rate.num).toBeGreaterThan(0);
	expect(rate.den).toBeGreaterThan(0);
});

test('InputVideoTrack.getFrameRate accepts a sampleCount bound', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const fast = await track.getFrameRate(5);
	const slow = await track.getFrameRate(Infinity);
	expect(fast).toEqual(slow);
});

test('InputVideoTrack.getFrameRateMode reports constant for CFR sources', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getFrameRateMode()).toBe('constant');
});

describe('getFrameDurationFromRate', () => {
	test('NTSC 30000/1001 in a 90000 timescale yields 3003 ticks/frame', () => {
		expect(getFrameDurationFromRate({ num: 30000, den: 1001 }, 90_000)).toBe(3003);
	});

	test('25/1 in a 90000 timescale yields 3600 ticks/frame', () => {
		expect(getFrameDurationFromRate({ num: 25, den: 1 }, 90_000)).toBe(3600);
	});

	test('rounds non-integer results', () => {
		expect(getFrameDurationFromRate({ num: 29, den: 1 }, 1000)).toBe(34);
	});

	test('returns 0 for invalid inputs', () => {
		expect(getFrameDurationFromRate({ num: 0, den: 1 }, 1000)).toBe(0);
		expect(getFrameDurationFromRate({ num: 30, den: 1 }, 0)).toBe(0);
	});
});
