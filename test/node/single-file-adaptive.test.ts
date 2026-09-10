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
import { AdaptiveOutputFormat, CmafOutputFormat, DashOutputFormat, HlsOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { assert } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

const buildSingleFile = async () => {
	const files = new Map<string, Uint8Array>();
	const shared = {
		segmentFormat: new CmafOutputFormat(),
		targetDuration: 2,
		singleFilePerPlaylist: true,
	} as const;

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
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	return files;
};

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
	const mediaFiles = [...files.keys()].filter(p => /\.(m4s|mp4|cmf[va])$/.test(p));

	expect(mediaFiles).toHaveLength(1);
	expect(files.has('master.mpd')).toBe(true);
});

test('the MPD and the m3u8 address identical byte ranges in that file', async () => {
	const files = await buildSingleFile();
	const decode = (p: string) => {
		const bytes = files.get(p);
		assert(bytes);
		return new TextDecoder().decode(bytes);
	};

	// Read the MPD's ranges textually — there is no DOMParser in the node test env, and the
	// assertion here is about byte-range agreement, not XML parsing (covered by the parser tests).
	const mpdText = decode('master.mpd');
	const dashInit = /<Initialization range="([^"]+)"/.exec(mpdText)?.[1];
	const dashSegments = [...mpdText.matchAll(/<SegmentURL mediaRange="([^"]+)"/g)].map(m => m[1]!);
	assert(dashInit);

	expect(mpdText).toContain('urn:mpeg:dash:profile:isoff-on-demand:2011');

	const mediaPlaylistPath = [...files.keys()].find(p => /playlist.*\.m3u8$/.test(p));
	assert(mediaPlaylistPath);
	const playlist = parseHlsPlaylist(decode(mediaPlaylistPath));
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
	const mediaPath = [...files.keys()].find(p => /\.(m4s|mp4|cmf[va])$/.test(p))!;
	expect(spanFromDash(dashSegments.at(-1)!).end).toBe(files.get(mediaPath)!.length - 1);
});

test('the single file is a readable media file on its own', async () => {
	const files = await buildSingleFile();
	const mediaPath = [...files.keys()].find(p => /\.(m4s|mp4|cmf[va])$/.test(p))!;

	using input = new Input({ source: new BufferSource(files.get(mediaPath)!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await input.computeDuration()).toBeGreaterThan(0);
});
