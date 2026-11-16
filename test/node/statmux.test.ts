/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The loop is driven here by a model of an encoder rather than by one, because the claim under test is
// about the control law and nothing else: at a given quantizer, content of a given difficulty produces
// a predictable number of bits. A real encoder adds noise that would only make these assertions weaker.
//
// The model is the one H.264 rate control is built on - six quantizer steps to a doubling - so
// `bits(q) = difficulty * 2 ** ((REFERENCE_QUANTIZER - q) / 6)`. What the tests check is what the loop
// does with that: whether the programs together come to the pool, whether the harder one ends up with
// more of it, and whether a floor or a ceiling is honoured when the two conflict.

import { expect, test } from 'vitest';
import { NodeAvVideoEncoder } from '../../packages/server/src/video-encoder.js';
import { buildVideoCodecString } from '../../src/codec.js';
import { EncodedPacket } from '../../src/packet.js';
import { VideoSample } from '../../src/sample.js';
import { StatMux, type StatMuxOptions } from '../../src/statmux.js';

const REFERENCE_QUANTIZER = 26;
const FPS = 25;

/** Bits per second this difficulty produces at `quantizer`, difficulty being its rate at the reference. */
const modelBitrate = (difficulty: number, quantizer: number) =>
	difficulty * 2 ** ((REFERENCE_QUANTIZER - quantizer) / 6);

/**
 * Runs the loop for `seconds` of media against fixed difficulties, reporting frame by frame so both
 * programs contribute to every window the way interleaved packets would.
 */
const run = (statMux: StatMux, difficulties: number[], seconds: number) => {
	const produced = difficulties.map(() => 0);

	for (let frame = 0; frame < seconds * FPS; frame++) {
		const timestamp = frame / FPS;
		const quantizers = statMux.quantizers;

		for (let program = 0; program < difficulties.length; program++) {
			const bits = modelBitrate(difficulties[program]!, quantizers[program]!) / FPS;
			produced[program]! += bits;
			statMux.report(program, bits / 8, timestamp);
		}
	}

	return { produced, averageBitrates: produced.map(bits => bits / seconds) };
};

test('the programs together come to the pool, from either side of it', () => {
	for (const start of [4, 46]) {
		const statMux = new StatMux({
			programs: [{ minBitrate: 1e5, maxBitrate: 5e7 }, { minBitrate: 1e5, maxBitrate: 5e7 }],
			totalBitrate: 10e6,
			codec: 'avc',
			interval: 2,
			initialQuantizer: start,
		});

		run(statMux, [6e6, 3e6], 120);

		// Started far too fine (4) or far too coarse (46), it has to find the same level either way
		expect(Math.abs(statMux.measuredTotal / 10e6 - 1), `from quantizer ${start}`).toBeLessThan(0.12);
	}
});

test('at one quality the harder programme takes more of the pool', () => {
	const statMux = new StatMux({
		programs: [{ minBitrate: 1e5, maxBitrate: 5e7 }, { minBitrate: 1e5, maxBitrate: 5e7 }],
		totalBitrate: 10e6,
		codec: 'avc',
		interval: 2,
	});

	// Four times the difficulty, nothing else said about it
	const { measuredBitrates } = (() => {
		run(statMux, [8e6, 2e6], 120);
		return { measuredBitrates: statMux.measuredBitrates };
	})();

	expect(measuredBitrates[0]!).toBeGreaterThan(measuredBitrates[1]!);

	// And by about the ratio of the difficulties, since neither bound is in play and both sit at the
	// same quantizer - that proportionality is the whole mechanism, not a side effect
	expect(measuredBitrates[0]! / measuredBitrates[1]!).toBeGreaterThan(3);
	expect(measuredBitrates[0]! / measuredBitrates[1]!).toBeLessThan(5);
	expect(statMux.quantizers[0]).toBe(statMux.quantizers[1]);
});

test('a ceiling holds the programme that would otherwise take the pool', () => {
	const statMux = new StatMux({
		programs: [{ minBitrate: 1e5, maxBitrate: 3e6 }, { minBitrate: 1e5, maxBitrate: 5e7 }],
		totalBitrate: 12e6,
		codec: 'avc',
		interval: 2,
	});

	// Program 0 is much harder, so at a shared quantizer it would run away with the pool
	run(statMux, [2e7, 2e6], 160);

	expect(statMux.measuredBitrates[0]!, 'held at its ceiling').toBeLessThan(3e6 * 1.2);
	// Held off the shared quantizer, which is what a per-programme bound costs
	expect(statMux.quantizers[0]!).toBeGreaterThan(statMux.quantizers[1]!);
});

test('a floor keeps a programme fed when the pool is under pressure', () => {
	const statMux = new StatMux({
		programs: [{ minBitrate: 4e6, maxBitrate: 5e7 }, { minBitrate: 1e5, maxBitrate: 5e7 }],
		totalBitrate: 10e6,
		codec: 'avc',
		interval: 2,
	});

	// Program 0's content is easy, so a shared quality would leave it far under its floor
	run(statMux, [5e5, 2e7], 160);

	expect(statMux.measuredBitrates[0]!, 'brought up to its floor').toBeGreaterThan(4e6 * 0.8);
	expect(statMux.quantizers[0]!).toBeLessThan(statMux.quantizers[1]!);
});

test('priority buys quality against identical content', () => {
	const statMux = new StatMux({
		programs: [
			{ minBitrate: 1e5, maxBitrate: 5e7, priority: 2 },
			{ minBitrate: 1e5, maxBitrate: 5e7 },
		],
		totalBitrate: 10e6,
		codec: 'avc',
		interval: 2,
	});

	run(statMux, [5e6, 5e6], 120);

	// Same content, so any difference is the priority alone: one doubling of it is one of bitrate
	expect(statMux.quantizers[0]!).toBeLessThan(statMux.quantizers[1]!);
	expect(statMux.measuredBitrates[0]! / statMux.measuredBitrates[1]!).toBeGreaterThan(1.6);
	expect(statMux.measuredBitrates[0]! / statMux.measuredBitrates[1]!).toBeLessThan(2.5);
});

test('the quantizer scale is the codec\'s own, not one borrowed from H.264', () => {
	// AV1 runs 0-255 where AVC runs 0-51, so the same correction is a different number of steps. A loop
	// that moved by six on both would barely move AV1 at all.
	const av1 = new StatMux({
		programs: [{ minBitrate: 1e5, maxBitrate: 5e7 }],
		totalBitrate: 5e6,
		codec: 'av1',
		interval: 2,
		initialQuantizer: 128,
	});
	const avc = new StatMux({
		programs: [{ minBitrate: 1e5, maxBitrate: 5e7 }],
		totalBitrate: 5e6,
		codec: 'avc',
		interval: 2,
		initialQuantizer: 26,
	});

	av1.report(0, 1e6, 0);
	av1.report(0, 1e6, 3);
	avc.report(0, 1e6, 0);
	avc.report(0, 1e6, 3);

	const av1Moved = Math.abs(av1.quantizers[0]! - 128);
	const avcMoved = Math.abs(avc.quantizers[0]! - 26);
	expect(av1Moved, `av1 moved ${av1Moved}, avc moved ${avcMoved}`).toBeGreaterThan(avcMoved * 2);
});

test('a pool that cannot hold the floors is refused by name', () => {
	expect(() => new StatMux({
		programs: [{ minBitrate: 6e6, maxBitrate: 1e7 }, { minBitrate: 6e6, maxBitrate: 1e7 }],
		totalBitrate: 10e6,
		codec: 'avc',
	})).toThrow(/come to 12000000 bits per second, which is more than the 10000000/);
});

test('the options are checked before anything is reported', () => {
	const ok: StatMuxOptions = { programs: [{ minBitrate: 1e6, maxBitrate: 2e6 }], totalBitrate: 5e6, codec: 'avc' };

	expect(() => new StatMux({ ...ok, programs: [] })).toThrow(/non-empty array/);
	expect(() => new StatMux({ ...ok, totalBitrate: 0 })).toThrow(/positive number of bits per second/);
	expect(() => new StatMux({ ...ok, interval: 0 })).toThrow(/positive number of seconds/);
	expect(() => new StatMux({ ...ok, codec: 'vp8' })).toThrow(/no quantizer-based rate control/);
	expect(() => new StatMux({ ...ok, programs: [{ minBitrate: 3e6, maxBitrate: 1e6 }] }))
		.toThrow(/above its maxBitrate/);
	expect(() => new StatMux({ ...ok, programs: [{ minBitrate: 1e6, maxBitrate: 2e6, priority: 0 }] }))
		.toThrow(/priority, when provided, must be positive/);
	expect(() => new StatMux({ ...ok, initialQuantizer: 99 })).toThrow(/between 0 and 51/);

	const statMux = new StatMux(ok);
	expect(() => statMux.report(1, 100, 0)).toThrow(/index between 0 and 0/);
	expect(() => statMux.encodeOptions(-1)).toThrow(/index between 0 and 0/);
	expect(() => statMux.report(0, -1, 0)).toThrow(/non-negative/);
});

test('the encode options carry the quantizer in the shape the codec wants', () => {
	const statMux = new StatMux({
		programs: [{ minBitrate: 1e6, maxBitrate: 2e6 }],
		totalBitrate: 5e6,
		codec: 'hevc',
		initialQuantizer: 30,
	});

	expect(statMux.encodeOptions(0)).toEqual({ hevc: { quantizer: 30 } });
});

// Everything above drives the loop with a model of an encoder. This drives it with a real one, which is
// the only thing that shows the two agree: that a quantizer handed to libx264 moves its output the way
// the control law assumes, and that the plumbing carrying it per frame works.

// Small and short on purpose: this runs two software encoders at once, and the suite runs test files
// in parallel - a few seconds of saturating every core starves the other workers and times them out.
// These three - the frame size, the pool and the one second interval - are a measurement regime, not
// arbitrary. Each reallocation reopens the encoder, and the drain flushes whatever it was holding into
// whichever window happens to be current, so a window's bits are not exactly the bits of the frames in
// it. At this size against this pool the error is noise; shrink the frames to 192x108 and drop the pool
// to 600 kb/s and it stops being noise - the trace then shows the total FALLING while the quantizer
// gets finer, which is physically impossible for one piece of content and is the attribution breaking
// down, not the loop misbehaving. If you make this cheaper, trace it before believing the result.
const REAL_WIDTH = 256;
const REAL_HEIGHT = 144;

/** Noise encodes large, a flat field encodes to almost nothing - two difficulties without a fixture. */
const framePixels = (hard: boolean, frameIndex: number) => {
	const data = new Uint8Array(REAL_WIDTH * REAL_HEIGHT * 4);
	if (!hard) {
		data.fill(0x7f);
		// A little motion, so it is easy rather than static - a frozen field encodes to nothing at all
		// and would make the floor the only thing under test
		data[(frameIndex % (REAL_WIDTH * REAL_HEIGHT)) * 4] = 0xff;
		return data;
	}

	let seed = 123456789 + frameIndex;
	for (let i = 0; i < data.length; i++) {
		seed = (seed * 48271) % 2147483647;
		data[i] = seed & 0xff;
	}
	return data;
};

const openEncoder = async (onPacket: (packet: EncodedPacket) => void) => {
	const encoder = new NodeAvVideoEncoder();
	// @ts-expect-error Readonly
	encoder.codec = 'avc';
	// @ts-expect-error Readonly
	encoder.config = {
		codec: buildVideoCodecString('avc', REAL_WIDTH, REAL_HEIGHT, 1e6, false),
		width: REAL_WIDTH,
		height: REAL_HEIGHT,
		bitrateMode: 'quantizer',
	} satisfies VideoEncoderConfig;
	// @ts-expect-error Readonly
	encoder.onPacket = (packet: EncodedPacket) => onPacket(packet);

	await encoder.init();
	return encoder;
};

test('against real encoders, the harder programme takes the larger share', { timeout: 180_000 }, async () => {
	const statMux = new StatMux({
		programs: [{ minBitrate: 5e4, maxBitrate: 1e7 }, { minBitrate: 5e4, maxBitrate: 1e7 }],
		totalBitrate: 2e6,
		codec: 'avc',
		interval: 1,
		initialQuantizer: 26,
	});

	const produced = [0, 0];
	const totals: number[] = [];
	const encoders = await Promise.all([0, 1].map(program => openEncoder((packet) => {
		produced[program]! += packet.data.byteLength * 8;
	})));

	const frames = 25 * 6;
	for (let frame = 0; frame < frames; frame++) {
		const timestamp = frame / 25;
		const before = statMux.measuredTotal;

		for (const program of [0, 1]) {
			using sample = new VideoSample(framePixels(program === 0, frame), {
				format: 'RGBX',
				codedWidth: REAL_WIDTH,
				codedHeight: REAL_HEIGHT,
				timestamp,
				duration: 1 / 25,
			});

			const sizeBefore = produced[program]!;
			await encoders[program]!.encode(sample, statMux.encodeOptions(program));
			statMux.report(program, (produced[program]! - sizeBefore) / 8, timestamp);
		}

		if (statMux.measuredTotal !== before && statMux.measuredTotal > 0) {
			totals.push(statMux.measuredTotal);
		}
	}

	for (const encoder of encoders) {
		await encoder.close();
	}

	expect(totals.length, 'the loop reallocated more than once').toBeGreaterThan(3);

	// Noise against a near-flat field is the whole point: at one quality the hard one takes the pool
	expect(produced[0]!, `hard ${produced[0]} vs easy ${produced[1]}`).toBeGreaterThan(produced[1]! * 3);

	// The loop had to coarsen: this content at the starting quantizer runs far over the pool, so a
	// quantizer still sitting where it began means nothing acted on that
	expect(statMux.quantizers[0]!, 'coarsened against content that overran the pool').toBeGreaterThan(26);

	// And it closed on the pool rather than drifting. The baseline is the *second* window, not the
	// first: an encoder holds frames before its first packets come out, so the opening window measures
	// a fraction of what was actually encoded in it and is not a rate at all. The bound is a ratio
	// against that in-run baseline, since what these encoders produce at a given quantizer is the
	// machine's business.
	const baseline = totals[1]!;
	const settled = totals[totals.length - 1]!;
	expect(Math.abs(Math.log2(settled / 2e6)), `from ${baseline.toFixed(0)} b/s to ${settled.toFixed(0)}`)
		.toBeLessThan(Math.abs(Math.log2(baseline / 2e6)) * 0.6);
});
