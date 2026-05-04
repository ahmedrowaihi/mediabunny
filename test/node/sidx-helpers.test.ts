/*!
 * Tests for the read-side `SidxBox` derivation helpers in
 * `src/isobmff/isobmff-misc.ts`. Mediabunny owns the sidx parser, so
 * these helpers (init/index byte ranges, per-subsegment offsets, peak
 * bitrate, total duration) live next to the type they describe.
 */
import { describe, expect, test } from 'vitest';
import {
	getSidxDurationSeconds,
	getSidxIndexRange,
	getSidxInitRange,
	getSidxMaxSegmentDuration,
	getSidxPeakBitrate,
	getSidxSegmentOffsets,
	type SidxBox,
} from '../../src/index.js';

const sidx = (overrides: Partial<SidxBox> = {}): SidxBox => ({
	referenceID: 1,
	timescale: 90_000,
	earliestPresentationTime: 0,
	firstOffset: 0,
	references: [],
	boxStart: 1000,
	boxSize: 200,
	...overrides,
});

const ref = (size: number, durationSeconds: number, timescale = 90_000) => ({
	referenceType: 0 as const,
	referencedSize: size,
	subsegmentDuration: durationSeconds * timescale,
	startsWithSAP: 1 as const,
	sapType: 1,
	sapDeltaTime: 0,
});

describe('getSidxInitRange', () => {
	test('covers bytes 0..boxStart-1', () => {
		expect(getSidxInitRange(sidx({ boxStart: 1000 }))).toEqual({ begin: 0, end: 999 });
	});

	test('handles sidx at offset 0 (no init bytes)', () => {
		expect(getSidxInitRange(sidx({ boxStart: 0 }))).toEqual({ begin: 0, end: -1 });
	});
});

describe('getSidxIndexRange', () => {
	test('covers the sidx box itself', () => {
		expect(getSidxIndexRange(sidx({ boxStart: 1000, boxSize: 200 }))).toEqual({
			begin: 1000,
			end: 1199,
		});
	});
});

describe('getSidxSegmentOffsets', () => {
	test('first subsegment starts immediately after sidx + firstOffset', () => {
		const s = sidx({
			boxStart: 1000,
			boxSize: 200,
			firstOffset: 50,
			references: [ref(500_000, 4), ref(600_000, 4)],
		});
		// 1000 (boxStart) + 200 (boxSize) + 50 (firstOffset) = 1250
		// Then accumulate referencedSize: 1250 + 500_000 = 501_250
		expect(getSidxSegmentOffsets(s)).toEqual([1250, 501_250]);
	});

	test('returns one offset per reference, accumulating referencedSize', () => {
		const s = sidx({
			boxStart: 1000,
			boxSize: 200,
			references: [ref(100, 4), ref(200, 4), ref(300, 4)],
		});
		// Start at 1200 (1000+200+0). Then 1200+100=1300, 1300+200=1500.
		expect(getSidxSegmentOffsets(s)).toEqual([1200, 1300, 1500]);
	});

	test('returns empty array when no references', () => {
		expect(getSidxSegmentOffsets(sidx())).toEqual([]);
	});
});

describe('getSidxPeakBitrate', () => {
	test('returns max bps across references, rounded', () => {
		const s = sidx({
			references: [
				ref(1_000_000, 4), // 2 Mbps
				ref(1_500_000, 4), // 3 Mbps  ← peak
				ref(800_000, 4), // 1.6 Mbps
			],
		});
		expect(getSidxPeakBitrate(s)).toBe(3_000_000);
	});

	test('uses the sidx timescale', () => {
		// Same byte count, different timescale → different bitrate.
		const fast = sidx({ timescale: 1000, references: [ref(125_000, 1, 1000)] });
		expect(getSidxPeakBitrate(fast)).toBe(1_000_000);
	});

	test('returns 0 for empty references', () => {
		expect(getSidxPeakBitrate(sidx())).toBe(0);
	});

	test('returns 0 for zero timescale', () => {
		expect(getSidxPeakBitrate(sidx({ timescale: 0, references: [ref(100, 4)] }))).toBe(0);
	});

	test('skips references with zero duration (avoids divide-by-zero)', () => {
		const s = sidx({
			references: [
				{ ...ref(1_000_000, 4), subsegmentDuration: 0 },
				ref(500_000, 4), // 1 Mbps
			],
		});
		expect(getSidxPeakBitrate(s)).toBe(1_000_000);
	});
});

describe('getSidxDurationSeconds', () => {
	test('sums subsegmentDuration across references and divides by timescale', () => {
		const s = sidx({
			timescale: 90_000,
			references: [ref(1, 4), ref(1, 4), ref(1, 4)],
		});
		expect(getSidxDurationSeconds(s)).toBe(12);
	});

	test('returns 0 for empty references', () => {
		expect(getSidxDurationSeconds(sidx())).toBe(0);
	});

	test('returns 0 for zero timescale', () => {
		expect(getSidxDurationSeconds(sidx({ timescale: 0, references: [ref(1, 4)] }))).toBe(0);
	});
});

describe('getSidxMaxSegmentDuration', () => {
	test('returns the longest single-subsegment duration in seconds', () => {
		const s = sidx({
			timescale: 90_000,
			references: [ref(1, 2), ref(1, 6), ref(1, 4)],
		});
		expect(getSidxMaxSegmentDuration(s)).toBe(6);
	});

	test('uses the sidx timescale', () => {
		const s = sidx({ timescale: 1000, references: [ref(1, 3, 1000)] });
		expect(getSidxMaxSegmentDuration(s)).toBe(3);
	});

	test('returns 0 for empty references', () => {
		expect(getSidxMaxSegmentDuration(sidx())).toBe(0);
	});

	test('returns 0 for zero timescale', () => {
		expect(getSidxMaxSegmentDuration(sidx({ timescale: 0, references: [ref(1, 4)] }))).toBe(0);
	});
});
