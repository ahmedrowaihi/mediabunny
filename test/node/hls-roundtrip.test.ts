import { describe, expect, test } from 'vitest';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { serializeHls } from '../../src/hls/hls-serializer.js';
import { MediaPlaylist } from '../../src/hls/hls-media-playlist.js';
import { MasterPlaylist } from '../../src/hls/hls-master-playlist.js';
import { hlsMediaPlaylist, hlsSegment } from '../../src/hls/hls-playlist-builder.js';
import { InvalidUsageError } from '../../src/errors.js';
import { assert } from '../../src/misc.js';
import { MalformedInputError } from '../../src/errors.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, HlsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';

const AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);
const AVC_METADATA: EncodedVideoChunkMetadata = {
	decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 },
};

/** Writes an HLS presentation into memory and serves it back by file name. */
const writeFiles = async (segmentCount: number) => {
	const files = new Map<string, Uint8Array>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 1 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < segmentCount * 2; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	return files;
};

const sourceOf = (files: Map<string, Uint8Array>) =>
	new CustomPathedSource('master.m3u8', ({ path }) => {
		const name = path.split('/').pop() ?? path;
		const body = files.get(name);
		if (!body) {
			throw new Error(`No such file in the written presentation: ${path}`);
		}
		return new BufferSource(body);
	});

const writePresentation = async (segmentCount: number) => sourceOf(await writeFiles(segmentCount));

test('a written HLS presentation reads back through the demuxer', async () => {
	using input = new Input({ source: await writePresentation(4), formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect(await track!.getCodec()).toBe('avc');
	expect(await track!.getDisplayWidth()).toBe(1280);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		timestamps.push(Number(packet.timestamp.toFixed(3)));
	}

	expect(timestamps.length).toBe(8);
	expect(timestamps[0]).toBe(0);
	expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
});

test('the HLS demuxer seeks by time through the playlist', async () => {
	using input = new Input({ source: await writePresentation(4), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	const packet = await new EncodedPacketSink(track).getPacket(2);
	expect(packet).not.toBeNull();
	expect(packet!.timestamp).toBeCloseTo(2, 3);
});

test('the delegating accessors report the track, not the base class', async () => {
	using input = new Input({ source: await writePresentation(4), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	// Each of these is answered either from the manifest entry or by delegating to the segment's
	// own backing; a base class that stopped doing either would still walk and seek correctly.
	expect(track.id).toBeGreaterThan(0);
	expect(await track.computeDuration()).toBeGreaterThan(0);
	expect(await track.getTimeResolution()).toBeGreaterThan(1);
	expect(await track.getLanguageCode()).toBe('und');
	// HLS swaps the meanings: EXT-X-MEDIA's DEFAULT marks the primary track, AUTOSELECT the default.
	const disposition = await track.getDisposition();
	expect(disposition.default).toBe(true);
	expect(disposition.primary).toBe(true);
});

describe('unmodelled tags survive a round trip', () => {
	const PLAYLIST = [
		'#EXTM3U',
		'#EXT-X-VERSION:7',
		'#EXT-X-TARGETDURATION:6',
		'#EXT-X-MEDIA-SEQUENCE:100',
		'#EXT-X-MAP:URI="init.mp4"',
		'#X-VENDOR-THING:foo=1',
		'#EXT-OATCLS-SCTE35:/DAlAAAAAAAAAP/wFAUAAAABf+/+AA==',
		'#EXT-X-CUE-OUT:30',
		'#EXTINF:6.000,',
		'seg-0.m4s',
		'#EXT-X-CUE-IN',
		'#EXTINF:6.000,',
		'seg-1.m4s',
		'#EXT-X-ENDLIST',
		'',
	].join('\n');

	test('nothing is dropped, and each tag stays with its segment', () => {
		const parsed = parseHlsPlaylist(PLAYLIST);
		assert(parsed.kind === 'media');

		// The ad cues are what an SCTE-35 relay reads; they must land on the segment they preceded
		expect(parsed.segments[0]!.unknownTags).toEqual([
			'#X-VENDOR-THING:foo=1',
			'#EXT-OATCLS-SCTE35:/DAlAAAAAAAAAP/wFAUAAAABf+/+AA==',
			'#EXT-X-CUE-OUT:30',
		]);
		expect(parsed.segments[1]!.unknownTags).toEqual(['#EXT-X-CUE-IN']);
		expect(parsed.unknownTags).toEqual([]);

		const out = serializeHls(parsed);
		for (const line of PLAYLIST.split('\n').filter(l => l.length > 0)) {
			expect(out, `lost: ${line}`).toContain(line);
		}
		// and in order, not hoisted
		expect(out.indexOf('#EXT-X-CUE-OUT:30')).toBeLessThan(out.indexOf('seg-0.m4s'));
		expect(out.indexOf('#EXT-X-CUE-IN')).toBeGreaterThan(out.indexOf('seg-0.m4s'));
		expect(out.indexOf('#EXT-X-CUE-IN')).toBeLessThan(out.indexOf('seg-1.m4s'));
	});

	test('tags before any segment are kept on the playlist', () => {
		const parsed = parseHlsPlaylist([
			'#EXTM3U',
			'#EXT-X-TARGETDURATION:6',
			'#X-ORIGIN-NOTE:relayed',
			'#EXT-X-ENDLIST',
			'',
		].join('\n'));
		assert(parsed.kind === 'media');

		expect(parsed.unknownTags).toEqual(['#X-ORIGIN-NOTE:relayed']);
		expect(serializeHls(parsed)).toContain('#X-ORIGIN-NOTE:relayed');
	});
});

describe('tags a player counts are not collapsed or invented', () => {
	test('a run of EXT-X-DISCONTINUITY survives, since each shifts the sequence number', () => {
		// draft-22 6.2.1: a segment's discontinuity sequence number is the playlist's plus the number
		// of EXT-X-DISCONTINUITY tags preceding its URI line. Collapsing two into one shifts every
		// later segment.
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4',
			'#EXT-X-DISCONTINUITY', '#EXT-X-DISCONTINUITY',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(playlist.kind === 'media');

		expect(playlist.segments[0]!.discontinuitiesBefore).toBe(2);
		expect(playlist.segments[0]!.discontinuityBefore).toBe(true);

		const out = serializeHls(playlist);
		expect(out.split('\n').filter(line => line === '#EXT-X-DISCONTINUITY')).toHaveLength(2);
	});

	test('an EXT-X-KEY that is not NONE must carry a URI', () => {
		// 4.4.4.4: URI is REQUIRED unless METHOD is NONE. Without it a player resolves "" against the
		// playlist's own URL and fetches the playlist as its key.
		expect(() => parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-KEY:METHOD=AES-128',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'))).toThrow(MalformedInputError);
	});

	test('METHOD=NONE still needs no URI', () => {
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-KEY:METHOD=NONE',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(playlist.kind === 'media');
		expect(playlist.segments[0]!.keys.every(key => key.method === 'NONE')).toBe(true);
	});
});

describe('master playlists get the same treatment as media ones', () => {
	test('a blank line or comment may sit between EXT-X-STREAM-INF and its URI', () => {
		// 4.1: blank lines are ignored and comments SHOULD be. Media playlists already allowed this.
		for (const body of [
			['#EXT-X-STREAM-INF:BANDWIDTH=1000', '', 'v.m3u8'],
			['#EXT-X-STREAM-INF:BANDWIDTH=1000', '# a note', 'v.m3u8'],
			['#EXT-X-STREAM-INF:BANDWIDTH=1000', '', '# note', '', 'v.m3u8'],
		]) {
			const playlist = parseHlsPlaylist(['#EXTM3U', ...body, ''].join('\n'));
			assert(playlist.kind === 'master');
			expect(playlist.variants).toHaveLength(1);
			expect(playlist.variants[0]!.uri).toBe('v.m3u8');
		}
	});

	test('two variants separated by blank lines both parse', () => {
		const playlist = parseHlsPlaylist([
			'#EXTM3U',
			'#EXT-X-STREAM-INF:BANDWIDTH=1000', '', 'a.m3u8',
			'#EXT-X-STREAM-INF:BANDWIDTH=2000', 'b.m3u8', '',
		].join('\n'));
		assert(playlist.kind === 'master');
		expect(playlist.variants.map(v => v.uri)).toEqual(['a.m3u8', 'b.m3u8']);
	});

	test('unmodelled tags are kept, as the warning promises', () => {
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#X-VENDOR:1', '#EXT-X-FUTURE-TAG:2',
			'#EXT-X-STREAM-INF:BANDWIDTH=1000', 'v.m3u8', '',
		].join('\n'));
		assert(playlist.kind === 'master');

		expect(playlist.unknownTags).toEqual(['#X-VENDOR:1', '#EXT-X-FUTURE-TAG:2']);
		const out = serializeHls(playlist);
		expect(out).toContain('#X-VENDOR:1');
		expect(out).toContain('#EXT-X-FUTURE-TAG:2');
	});

	test('EXT-X-START is written for a media playlist too, not only a master', () => {
		// 4.4.2: these tags "can appear in either" playlist kind
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-START:TIME-OFFSET=-12.5',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(playlist.kind === 'media');
		expect(playlist.start).not.toBeNull();

		expect(serializeHls(playlist)).toContain('#EXT-X-START:TIME-OFFSET=-12.5');
	});
});

describe('values that cannot be written are refused, not written wrong', () => {
	const one = (segment: Parameters<typeof hlsSegment>[0]) =>
		() => serializeHls(hlsMediaPlaylist({ targetDuration: 4, segments: [hlsSegment(segment)] }));

	test('a URI carrying a line break would inject tags', () => {
		// The remainder of the "URI" becomes playlist lines, so this writes an ENDLIST nobody asked for
		expect(one({ uri: 'a.ts\n#EXT-X-ENDLIST', duration: 4 })).toThrow(InvalidUsageError);
	});

	test('a quoted-string value carrying a quote ends the string early', () => {
		// 4.2: quoted-strings have no escape, so this cannot round-trip
		expect(one({ uri: 'a.ts', duration: 4, map: 'i"x.mp4' })).toThrow(InvalidUsageError);
	});

	test.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['a negative number', -4],
	])('a duration of %s is refused', (_name, duration) => {
		expect(one({ uri: 'a.ts', duration })).toThrow(InvalidUsageError);
	});

	test('ordinary values still serialize', () => {
		expect(one({ uri: 'a.ts', duration: 4, map: 'init.mp4' })).not.toThrow();
	});
});

/** Drops `lineNumber`: the writer's blank line after #EXTM3U shifts every source position. */
const withoutLineNumbers = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(withoutLineNumbers);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== 'lineNumber')
				.map(([key, inner]) => [key, withoutLineNumbers(inner)]),
		);
	}
	return value;
};

// The writer and the parser/serializer are separate stacks; nothing compared them.
test('every playlist the writer emits survives the parser and serializer', async () => {
	const files = await writeFiles(4);
	const playlists = [...files].filter(([name]) => name.endsWith('.m3u8'));
	expect(playlists.length).toBeGreaterThan(1); // a master and at least one media playlist

	for (const [name, bytes] of playlists) {
		const written = new TextDecoder().decode(bytes);
		const parsed = parseHlsPlaylist(written);
		const reparsed = parseHlsPlaylist(serializeHls(parsed));

		// Values, not text: the two format durations differently (`#EXTINF:1,` vs `#EXTINF:1.000,`).
		expect(withoutLineNumbers(reparsed), `${name} changed through the round trip`)
			.toEqual(withoutLineNumbers(parsed));

		const tagsOf = (text: string) => new Set(
			text.split('\n').map(line => /^#(EXT[A-Z0-9-]*)/.exec(line.trim())?.[1]).filter(Boolean),
		);
		for (const tag of tagsOf(written)) {
			expect(tagsOf(serializeHls(parsed)), `${name} lost tag #${tag}`).toContain(tag);
		}
	}
});

// The third HLS emitter: `MediaPlaylist`/`MasterPlaylist` are public API with no internal consumer,
// so nothing proved they agree with the parser/serializer the way the output path does above.
test('the shaka-port writer agrees with the parser and serializer', () => {
	const timeScale = 90_000;
	const playlist = new MediaPlaylist({ playlistType: 'vod' }, 'media.m3u8', 'video', 'group');
	playlist.setMediaInfo({
		videoInfo: { codec: 'avc1.640028', width: 1920, height: 1080, timeScale },
		containerType: 'mp4',
		initSegmentUrl: 'init.mp4',
		bandwidth: 2_000_000,
	});
	for (let i = 0; i < 4; i++) {
		playlist.addSegment(`seg-${i}.m4s`, i * timeScale, timeScale, i * 500_000, 500_000);
	}

	const master = new MasterPlaylist();
	master.addPlaylist(playlist);

	for (const [name, text] of [
		['media', playlist.build({ endStream: true })],
		['master', master.build({ baseUrl: '' })],
	] as const) {
		const parsed = parseHlsPlaylist(text);
		expect(withoutLineNumbers(parseHlsPlaylist(serializeHls(parsed))), `${name} changed through the round trip`)
			.toEqual(withoutLineNumbers(parsed));
	}
});
