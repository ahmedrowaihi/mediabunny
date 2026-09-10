/*!
 * Everything `sidx`: the read-side `SidxBox` derivation helpers in `src/isobmff/isobmff-misc.ts`,
 * the fragment lookup table the demuxer seeds from an index, and the write-side index the muxer
 * reserves for DASH's `<SegmentBase @indexRange>`.
 */
import { describe, expect, test } from 'vitest';
import path from 'node:path';
import {
	getSidxDurationSeconds,
	getSidxIndexRange,
	getSidxInitRange,
	getSidxMaxSegmentDuration,
	getSidxPeakBitrate,
	getSidxSegmentOffsets,
	type SidxBox,
} from '../../src/index.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import {
	AdaptiveOutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	Mp4OutputFormat,
} from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const __dirname = new URL('.', import.meta.url).pathname;

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

/**
 * A file with an index but no `mfra` — the DASH on-demand / CMAF layout — has to seek through that
 * index rather than walk `moof` by `moof` from byte 0. Built with the muxer's own index emission so
 * these assertions track the real encoder, with `mfra` stripped so `tfra` doesn't take precedence.
 */
const indexedFragmentedFile = async () => {
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: 'fragmented',
			minimumFragmentDuration: 0.5,
			sidxFragmentCapacity: 512,
		}),
		target: new BufferTarget(),
	});

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
		formats: ALL_FORMATS,
	});
	await (await Conversion.init({ input, output })).execute();

	return stripBoxes(new Uint8Array(output.target.buffer!), 'mfra');
};

const stripBoxes = (bytes: Uint8Array, name: string) => {
	const kept = readTopLevelBoxes(bytes).filter(box => box.name !== name);
	const out = new Uint8Array(kept.reduce((sum, box) => sum + box.size, 0));

	let at = 0;
	for (const box of kept) {
		out.set(bytes.subarray(box.start, box.start + box.size), at);
		at += box.size;
	}

	return out;
};

const countingSource = (bytes: Uint8Array) => {
	const counter = { bytesRead: 0 };
	const source = new CustomSource({
		getSize: () => bytes.length,
		read: (start, end) => {
			counter.bytesRead += end - start;
			return bytes.subarray(start, end);
		},
	});

	return { source, counter };
};

const measureVideoDuration = async (bytes: Uint8Array) => {
	const { source, counter } = countingSource(bytes);
	using input = new Input({ source, formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	return { duration: await track.computeDuration(), bytesRead: counter.bytesRead };
};

const lookupTableOf = (track: object) => (track as {
	_backing: { internalTrack: { fragmentLookupTable: { moofOffset: number }[] } };
})._backing.internalTrack.fragmentLookupTable;

test('a sidx lets computeDuration skip to the last fragment instead of walking the file', async () => {
	const indexed = await indexedFragmentedFile();

	const withSidx = await measureVideoDuration(indexed);
	const withoutSidx = await measureVideoDuration(stripBoxes(indexed, 'sidx'));

	expect(withSidx.duration).toBeCloseTo(withoutSidx.duration, 6);
	expect(withSidx.bytesRead).toBeLessThan(withoutSidx.bytesRead / 2);
});

test('a sidx indexes every subsegment, not just the first', async () => {
	const bytes = await indexedFragmentedFile();
	using input = new Input({ source: countingSource(bytes).source, formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	await track.computeDuration();

	const moofOffsets = readTopLevelBoxes(bytes).filter(box => box.name === 'moof').map(box => box.start);
	expect(lookupTableOf(track).map(entry => entry.moofOffset)).toEqual(moofOffsets);
});

test('a sidx naming one track still locates the fragments of every track', async () => {
	const bytes = await indexedFragmentedFile();
	using input = new Input({ source: countingSource(bytes).source, formats: ALL_FORMATS });

	const tracks = await input.getTracks();
	expect(tracks.length).toBeGreaterThan(1);

	// The index names a single track, but a subsegment boundary is a `moof` boundary and every track
	// in the fragment shares that `moof`.
	for (const track of tracks) {
		await track.computeDuration();
		expect(lookupTableOf(track).length).toBeGreaterThan(1);
	}
});

/**
 * The write side: `sidxFragmentCapacity` reserves room after `moov` for an index covering the whole
 * file, which is what a DASH `<SegmentBase @indexRange>` points at.
 */
type WrittenFiles = Map<string, Uint8Array>;

const readBytes = (files: WrittenFiles, filePath: string) => {
	const bytes = files.get(filePath);
	assert(bytes);
	return bytes;
};

const readText = (files: WrittenFiles, filePath: string) => new TextDecoder().decode(readBytes(files, filePath));

const readMediaFile = (files: WrittenFiles) => {
	const filePath = [...files.keys()].find(candidate => /\.(m4s|mp4|cmf[va])$/.test(candidate));
	assert(filePath);
	return readBytes(files, filePath);
};

const indexedOutputs = new Map<number, Promise<WrittenFiles>>();

const buildIndexedSingleFile = (sidxFragmentCapacity: number) => {
	const cached = indexedOutputs.get(sidxFragmentCapacity);
	if (cached) {
		return cached;
	}

	const built = (async (): Promise<WrittenFiles> => {
		const files: WrittenFiles = new Map();
		const segmentFormat = new Mp4OutputFormat({ fastStart: 'fragmented', sidxFragmentCapacity });
		const shared = { segmentFormat, targetDuration: 2, singleFilePerPlaylist: true } as const;

		const output = new Output({
			format: new AdaptiveOutputFormat({
				formats: [
					new HlsOutputFormat({ ...shared, m3u8Path: 'master.m3u8' }),
					new DashOutputFormat({ ...shared, mpdPath: 'master.mpd' }),
				],
			}),
			target: new PathedTarget('', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});

		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});
		await (await Conversion.init({ input, output })).execute();

		return files;
	})();

	indexedOutputs.set(sidxFragmentCapacity, built);
	return built;
};

test('an indexed single file gets a SegmentBase whose indexRange holds the sidx', async () => {
	const files = await buildIndexedSingleFile(512);
	const mpdText = readText(files, 'master.mpd');

	const indexRange = /<SegmentBase indexRange="([^"]+)"/.exec(mpdText)?.[1];
	assert(indexRange);
	expect(mpdText).not.toContain('<SegmentURL');

	const bytes = readMediaFile(files);
	const [begin, end] = indexRange.split('-').map(Number);

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(String.fromCharCode(...bytes.subarray(begin! + 4, begin! + 8))).toBe('sidx');
	expect(view.getUint32(begin!)).toBe(end! - begin! + 1);
});

test('the emitted sidx indexes every fragment and points past its own padding', async () => {
	const files = await buildIndexedSingleFile(512);
	const bytes = readMediaFile(files);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const [sidxBoxes, duration] = await Promise.all([input.getSegmentIndex(), input.computeDuration()]);

	expect(sidxBoxes).toHaveLength(1);
	const sidx = sidxBoxes[0]!;

	const moofCount = readTopLevelBoxes(bytes).filter(b => b.name === 'moof').length;
	expect(sidx.references).toHaveLength(moofCount);

	const firstSubsegment = sidx.boxStart + sidx.boxSize + sidx.firstOffset;
	expect(String.fromCharCode(...bytes.subarray(firstSubsegment + 4, firstSubsegment + 8))).toBe('moof');

	const indexedDuration = sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) / sidx.timescale;
	expect(indexedDuration).toBeCloseTo(duration, 2);
});

test('no sidx is written unless a capacity is asked for', async () => {
	const files = await buildIndexedSingleFile(0);
	const bytes = readMediaFile(files);

	expect(readTopLevelBoxes(bytes).map(b => b.name)).not.toContain('sidx');
	expect(readText(files, 'master.mpd')).not.toContain('indexRange');

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect(await input.computeDuration()).toBeGreaterThan(0);
});

test('a capacity smaller than the fragment count leaves the slot as free space', async () => {
	const files = await buildIndexedSingleFile(1);
	const bytes = readMediaFile(files);
	const names = readTopLevelBoxes(bytes).map(b => b.name);

	// Rather than write a truncated index that would misreport the file.
	expect(names.filter(n => n === 'moof').length).toBeGreaterThan(1);
	expect(names).not.toContain('sidx');
	expect(readText(files, 'master.mpd')).not.toContain('indexRange');

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect(await input.computeDuration()).toBeGreaterThan(0);
});
