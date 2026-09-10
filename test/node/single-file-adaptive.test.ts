/*!
 * A single CMAF file can back both an HLS media playlist and a DASH MPD at once, each addressing
 * it by byte range. These tests pin that the two manifests describe the SAME bytes — a mismatch
 * means one of the two players is reading the wrong offsets.
 */
import { expect, test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import {
	AdaptiveOutputFormat,
	CmafOutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	Mp4OutputFormat,
} from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { assert } from '../../src/misc.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const __dirname = new URL('.', import.meta.url).pathname;

type WrittenFiles = Map<string, Uint8Array>;

const readBytes = (files: WrittenFiles, filePath: string) => {
	const bytes = files.get(filePath);
	assert(bytes);
	return bytes;
};

const readText = (files: WrittenFiles, filePath: string) => new TextDecoder().decode(readBytes(files, filePath));

const findPath = (files: WrittenFiles, pattern: RegExp) => {
	const filePath = [...files.keys()].find(candidate => pattern.test(candidate));
	assert(filePath);
	return filePath;
};

const MEDIA_FILE = /\.(m4s|mp4|cmf[va])$/;
const MEDIA_PLAYLIST = /playlist.*\.m3u8$/;

const readMediaFile = (files: WrittenFiles) => readBytes(files, findPath(files, MEDIA_FILE));

const buildSingleFile = async (segmentFormat: CmafOutputFormat | Mp4OutputFormat = new CmafOutputFormat()) => {
	const files: WrittenFiles = new Map();
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
};

const buildIndexedSingleFile = (sidxFragmentCapacity: number) =>
	buildSingleFile(new Mp4OutputFormat({ fastStart: 'fragmented', sidxFragmentCapacity }));

/** `#EXT-X-BYTERANGE:<length>@<offset>` describes the same span as DASH's `begin-end`. */
const spanFromHls = (byteRange: { length: number; offset: number | null }) => ({
	begin: byteRange.offset!,
	end: byteRange.offset! + byteRange.length - 1,
});

const spanFromDash = (range: string) => {
	const [begin, end] = range.split('-').map(Number);
	return { begin: begin!, end: end! };
};

test('one media file backs both the MPD and the m3u8', async () => {
	const files = await buildSingleFile();
	const mediaFiles = [...files.keys()].filter(candidate => MEDIA_FILE.test(candidate));

	expect(mediaFiles).toHaveLength(1);
	expect(files.has('master.mpd')).toBe(true);
});

test('the MPD and the m3u8 address identical byte ranges in that file', async () => {
	const files = await buildSingleFile();

	// Read the MPD's ranges textually — there is no DOMParser in the node test env, and the
	// assertion here is about byte-range agreement, not XML parsing (covered by the parser tests).
	const mpdText = readText(files, 'master.mpd');
	const dashInit = /<Initialization range="([^"]+)"/.exec(mpdText)?.[1];
	const dashSegments = [...mpdText.matchAll(/<SegmentURL mediaRange="([^"]+)"/g)].map(m => m[1]!);
	assert(dashInit);

	expect(mpdText).toContain('urn:mpeg:dash:profile:isoff-on-demand:2011');

	const playlist = parseHlsPlaylist(readText(files, findPath(files, MEDIA_PLAYLIST)));
	assert(playlist.kind === 'media');

	// Init segment: DASH <Initialization range> vs HLS #EXT-X-MAP BYTERANGE
	const hlsMap = playlist.segments[0]?.map;
	assert(hlsMap?.byteRange);
	expect(spanFromDash(dashInit)).toEqual(spanFromHls(hlsMap.byteRange));

	// Media segments: DASH <SegmentURL mediaRange> vs HLS #EXT-X-BYTERANGE
	expect(dashSegments).toHaveLength(playlist.segments.length);
	expect(dashSegments.length).toBeGreaterThan(1);

	dashSegments.forEach((mediaRange, i) => {
		const hlsByteRange = playlist.segments[i]!.byteRange;
		assert(hlsByteRange);
		expect(spanFromDash(mediaRange)).toEqual(spanFromHls(hlsByteRange));
	});

	// The ranges must run contiguously to the end of the file.
	expect(spanFromDash(dashSegments.at(-1)!).end).toBe(readMediaFile(files).length - 1);
});

test('the single file is a readable media file on its own', async () => {
	const files = await buildSingleFile();
	const bytes = readMediaFile(files);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await input.computeDuration()).toBeGreaterThan(0);
});

/**
 * With `sidxFragmentCapacity`, the file carries a top-level `sidx` covering every fragment, so the
 * MPD can point at that one range instead of listing each subsegment — the difference between a
 * one-line SegmentBase and a SegmentURL per segment.
 */
test('an indexed single file gets a SegmentBase whose indexRange holds the sidx', async () => {
	const files = await buildIndexedSingleFile(512);
	const mpdText = readText(files, 'master.mpd');

	const indexRange = /<SegmentBase indexRange="([^"]+)"/.exec(mpdText)?.[1];
	assert(indexRange);
	expect(mpdText).not.toContain('<SegmentURL');

	const bytes = readMediaFile(files);
	const [begin, end] = indexRange.split('-').map(Number);

	// The advertised range must actually be the sidx box.
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

	// One reference per `moof` in the file.
	const moofCount = readTopLevelBoxes(bytes).filter(b => b.name === 'moof').length;
	expect(sidx.references).toHaveLength(moofCount);

	// `firstOffset` is measured from the end of the sidx, so it has to clear the `free` padding.
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
