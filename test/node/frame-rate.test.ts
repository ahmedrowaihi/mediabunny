import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, Input, FilePathSource, EncodedPacketSink } from '../../src/index.js';
import { findUnderlyingFrameRate } from '../../src/input-track.js';
import { assert, floorToDivisor } from '../../src/misc.js';

test('findUnderlyingFrameRate with 30 FPS at 30 Hz time resolution', () => {
	const ticks = makeTicks(30, 30);
	expect(findUnderlyingFrameRate(ticks, 30)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz time resolution', () => {
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.floor }), 1000)).toBe(30);
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.round }), 1000)).toBe(30);
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.ceil }), 1000)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 30 Hz with dropped frames', () => {
	const ticks = makeTicks(30, 30, { dropFrame: dropSomeFrames });
	expect(findUnderlyingFrameRate(ticks, 30)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz with dropped frames', () => {
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.floor, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.round, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.ceil, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 24000 Hz time resolution', () => {
	const ticks = makeTicks(24000 / 1001, 24000);
	expect(findUnderlyingFrameRate(ticks, 24000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 1000 Hz time resolution (1 minute)', () => {
	const frameCount = Math.floor(60 * 24000 / 1001);
	const ticks = makeTicks(24000 / 1001, 1000, { frameCount });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 1000 Hz time resolution (60 minutes)', () => {
	const frameCount = Math.floor(3600 * 24000 / 1001);
	const ticks = makeTicks(24000 / 1001, 1000, { frameCount });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz starting at 1e9 seconds', () => {
	const ticks = makeTicks(30, 1000, { startTime: 1e9 });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(30);
});

test('findUnderlyingFrameRate with 60 FPS at 90000 Hz with one tick of jitter', () => {
	// Every timestamp lies on the 60 FPS lattice, give or take one tick
	const ticks = new Float64Array(300).map((_, i) => 1500 * i + (i % 3 === 1 ? 1 : 0));
	expect(findUnderlyingFrameRate(ticks, 90000)).toBe(60);
});

test('findUnderlyingFrameRate with 60/1.001 FPS at 90000 Hz with dropped frames and ceil quantization', () => {
	const ticks = makeTicks(60000 / 1001, 90000, {
		frameCount: 257,
		quantize: Math.ceil,
		dropFrame: dropSomeFrames,
	});
	expect(findUnderlyingFrameRate(ticks, 90000)).toBe(60000 / 1001);
});

test('findUnderlyingFrameRate with irregular timestamps yields null', () => {
	const ticks = new Float64Array([0, 0.2, 0.5].map(x => Math.round(x * 100)));
	expect(findUnderlyingFrameRate(ticks, 100)).toBe(null);
});

test('findUnderlyingFrameRate with cursed VFR timestamps yields null', async () => {
	const { ticks, timeResolution } = await getSortedTrackTicks(publicPath('cursed-vfr.mp4'));
	expect(findUnderlyingFrameRate(ticks, timeResolution)).toBe(null);
});

test('computeFrameRateMetrics with constant frame rate video', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();

	expect(metrics.underlyingFrameRate).toBe(25);
	expect(metrics.bestGuessFrameRate).toBe(25);
	expect(metrics.minFrameRate).toBe(25);
	expect(metrics.maxFrameRate).toBe(25);
	expect(metrics.averageFrameRate).toBe(25);
	expect(metrics.medianFrameRate).toBe(25);
	expect(metrics.frameRateIsConstant).toBe(true);
});

test('computeFrameRateMetrics with cursed VFR video', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('cursed-vfr.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();

	expect(metrics.underlyingFrameRate).toBe(null);
	expect(metrics.bestGuessFrameRate).toBe(30);
	expect(metrics.minFrameRate).toBe(0.6369426751592356);
	expect(metrics.maxFrameRate).toBe(188.85245901639345);
	expect(metrics.averageFrameRate).toBe(8.664659340979288);
	expect(metrics.medianFrameRate).toBe(30.165016356826754);
	expect(metrics.frameRateIsConstant).toBe(false);
});

test('computeFrameRateMetrics with one tick of jitter', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('193039199_mp4_h264_aac_fhd_7.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();
	expect(metrics.underlyingFrameRate).toBe(60);
	expect(metrics.bestGuessFrameRate).toBe(60);
	expect(metrics.frameRateIsConstant).toBe(true);
});

const makeTicks = (
	frameRate: number,
	timeResolution: number,
	options: {
		frameCount?: number;
		startTime?: number;
		quantize?: (value: number) => number;
		dropFrame?: (index: number) => boolean;
	} = {},
) => {
	const frameCount = options.frameCount ?? 300;
	const startTime = options.startTime ?? 0;
	const quantize = options.quantize ?? Math.round;

	const ticks: number[] = [];

	for (let i = 0; i < frameCount; i++) {
		if (options.dropFrame?.(i)) {
			continue;
		}

		ticks.push(quantize((startTime + i / frameRate) * timeResolution));
	}

	return new Float64Array(ticks);
};

const dropSomeFrames = (index: number) => index % 11 === 4 || index % 17 === 9;

const getSortedTrackTicks = async (filePath: string) => {
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timeResolution = await videoTrack.getTimeResolution();
	const sink = new EncodedPacketSink(videoTrack);
	const ticks: number[] = [];

	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		ticks.push(Math.round(packet.timestamp * timeResolution));
	}

	ticks.sort((a, b) => a - b);

	const dedupedTicks = ticks.filter((tick, index) => index === 0 || tick !== ticks[index - 1]);

	return { ticks: new Float64Array(dedupedTicks), timeResolution };
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicPath = (file: string) => path.join(__dirname, '../public', file);

// Frame rate decimation. `transform.frameRate` assigns each incoming sample an output slot with
// `floorToDivisor(timestamp, frameRate)` and encodes the first sample of each new slot, so the slot a
// sample lands in is the whole of the frame selection. Timestamps are floats in seconds - a sample
// carries no ticks by the time it reaches the encoder - and 1/25 is not exact in binary, so a time
// mathematically on a slot boundary can land ulps below it and floor into the previous slot. That makes
// the slot's opener source frame 2k + 1 rather than 2k, for 37 of 750 outputs on a 50 -> 25 minute.
//
// Which parity opens the slots depends on the source's own phase, so it is only 2k when the first
// timestamp sits on the output grid. What must hold for every source is that the phase is constant and
// that each slot is opened exactly once: a selection that wanders between 2k and 2k + 1 is the defect.

/** Source frame `n`'s presentation time, as a demuxer computes it: integer ticks over the time base. */
const frameTime = (startTicks: number, n: number, inRate: number, timeBase: number) =>
	(startTicks + Math.round(n * timeBase / inRate)) / timeBase;

/** Replays the selector: the source frames that open a new output slot, and the slots they opened. */
const selectFrames = (
	{ inRate, outRate, timeBase, start, frames }:
	{ inRate: number; outRate: number; timeBase: number; start: number; frames: number },
) => {
	const startTicks = Math.round(start * timeBase);
	const openers: number[] = [];
	const slots: number[] = [];
	let last: number | null = null;

	for (let n = 0; n < frames; n++) {
		const slot = floorToDivisor(frameTime(startTicks, n, inRate, timeBase), outRate);
		if (last === null || slot > last) {
			openers.push(n);
			slots.push(slot);
			last = slot;
		}
	}

	return { openers, slots };
};

const halfRateCases = [
	{ name: '50 -> 25', inRate: 50, outRate: 25, timeBases: [12800, 90000, 1000] },
	{ name: '60 -> 30', inRate: 60, outRate: 30, timeBases: [15360, 90000] },
	{ name: '60000/1001 -> 30000/1001', inRate: 60000 / 1001, outRate: 30000 / 1001, timeBases: [60000, 90000] },
	{ name: '30 -> 15', inRate: 30, outRate: 15, timeBases: [30000] },
];

for (const { name, inRate, outRate, timeBases } of halfRateCases) {
	for (const timeBase of timeBases) {
		// 95443.7s is just under the 33-bit PCR wrap, and lands mid-slot at every one of these rates
		for (const start of [0, 10, 95443.7]) {
			test(`${name} at 1/${timeBase} from ${start}s halves the rate at a constant phase`, () => {
				const frames = Math.floor(inRate * 60);
				const { openers, slots } = selectFrames({ inRate, outRate, timeBase, start, frames });

				// Every slot opened exactly once, so no frame pair collapses and no slot needs padding
				for (let i = 1; i < slots.length; i++) {
					expect(Math.round((slots[i]! - slots[i - 1]!) * outRate)).toBe(1);
				}
				expect(openers.length).toBeGreaterThanOrEqual(Math.floor(frames / 2));
				expect(openers.length).toBeLessThanOrEqual(Math.floor(frames / 2) + 1);

				// Frame 0 always emits, whatever its phase; the rest must agree on one
				const parities = new Set(openers.slice(1).map(n => n % 2));
				expect(parities.size).toBe(1);

				// And on a source whose first frame is on the output grid, that phase is 2k
				const onGrid = Number.isInteger(start * outRate);
				expect(parities.has(0)).toBe(onGrid);
			});
		}
	}
}

test('a gap gives its slot to the first frame at or after the boundary', () => {
	const slotOf = (n: number) => floorToDivisor((n * 256) / 12800, 25);

	// Frame 58 is the opener of slot 29; dropping it leaves 59, whose slot is the same
	expect(slotOf(59)).toBe(slotOf(58));
	expect(slotOf(59)).toBeGreaterThan(slotOf(57));
});
