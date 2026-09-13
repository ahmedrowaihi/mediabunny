/* eslint-disable @stylistic/max-len */
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import type { HlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { serializeHls } from '../../src/hls/hls-serializer.js';
import { Logging } from '../../src/logging.js';

/** Drop `lineNumber` (source-position metadata) so structural equality ignores layout. */
const strip = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(strip);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (key !== 'lineNumber') {
				out[key] = strip(v);
			}
		}
		return out;
	}
	return value;
};

const expectRoundTrip = (text: string): HlsPlaylist => {
	const ast = parseHlsPlaylist(text);
	const reparsed = parseHlsPlaylist(serializeHls(ast));
	expect(strip(reparsed)).toEqual(strip(ast));
	return ast;
};

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",FORCED=NO,URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1100000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30,AUDIO="aud",SUBTITLES="subs",CLOSED-CAPTIONS=NONE
video/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=640000,CODECS="avc1.4d401f",RESOLUTION=1280x720,FRAME-RATE=29.97,AUDIO="aud"
video/720.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,CODECS="avc1.640028",RESOLUTION=1920x1080,URI="video/1080-iframe.m3u8"
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-04-22T10:36:00.000Z
#EXTINF:6.000,
seg-0.m4s
#EXTINF:5.500,title text
seg-1.m4s
#EXT-X-DISCONTINUITY
#EXTINF:6.000,
seg-2.m4s
#EXT-X-ENDLIST
`;

const BYTERANGE = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="all.mp4",BYTERANGE="800@0"
#EXT-X-BYTERANGE:1000@800
#EXTINF:6.000,
all.mp4
#EXT-X-BYTERANGE:1200
#EXTINF:6.000,
all.mp4
#EXT-X-ENDLIST
`;

const MULTI_DRM = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYID=0x1234567890abcdef1234567890abcdef,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,BBBB",KEYFORMAT="com.microsoft.playready",KEYFORMATVERSIONS="1"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-0.m4s
#EXTINF:6.000,
seg-1.m4s
#EXT-X-ENDLIST
`;

const LOW_LATENCY = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.560
#EXT-X-PART-INF:PART-TARGET=0.520
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PART:DURATION=0.520,URI="seg-0.m4s",BYTERANGE="1000@0",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.480,URI="seg-0.m4s",BYTERANGE="900@1000"
#EXTINF:1.000,
seg-0.m4s
#EXT-X-PART:DURATION=0.520,URI="seg-1.m4s",BYTERANGE="1100@0",INDEPENDENT=YES
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg-1.m4s",BYTERANGE-START=1100
`;

describe('serializeHls — parse → serialize → parse round-trip', () => {
	test('master playlist', () => {
		const ast = expectRoundTrip(MASTER);
		expect(ast.kind).toBe('master');
	});

	test('media playlist (map, PDT, discontinuity, title)', () => {
		expectRoundTrip(MEDIA);
	});

	test('single-file byterange playlist', () => {
		expectRoundTrip(BYTERANGE);
	});

	test('multi-DRM keeps one #EXT-X-KEY per KEYFORMAT, preserving KEYID', () => {
		const ast = expectRoundTrip(MULTI_DRM);
		if (ast.kind !== 'media') {
			throw new Error('expected media playlist');
		}
		expect(ast.segments[0]!.keys).toHaveLength(3);

		const out = serializeHls(ast);
		expect(out.match(/#EXT-X-KEY:/g)).toHaveLength(3);
		expect(out).toContain('com.apple.streamingkeydelivery');
		expect(out).toContain('com.microsoft.playready');
		expect(out).toContain('KEYID=0x1234567890abcdef1234567890abcdef');
	});

	test('#EXT-X-MEDIA RESOLUTION survives round-trip', () => {
		const media = [
			'#EXTM3U',
			'#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="v",NAME="hi",RESOLUTION=1920x1080,URI="v.m3u8"',
			'#EXT-X-STREAM-INF:BANDWIDTH=1280000,VIDEO="v"',
			'v.m3u8',
			'',
		].join('\n');
		const ast = expectRoundTrip(media);
		if (ast.kind !== 'master') {
			throw new Error('expected master playlist');
		}
		expect(ast.media[0]!.resolution).toEqual({ width: 1920, height: 1080 });
		expect(serializeHls(ast)).toContain('RESOLUTION=1920x1080');
	});

	test('low-latency playlist keeps parts per segment, the edge segment\'s parts and the preload hint', () => {
		const ast = expectRoundTrip(LOW_LATENCY);
		if (ast.kind !== 'media') {
			throw new Error('expected media playlist');
		}

		expect(ast.serverControl).toEqual({ canBlockReload: true,
			canSkipDateRanges: false, partHoldBack: 1.56, holdBack: null, canSkipUntil: null });
		expect(ast.partTarget).toBe(0.52);
		expect(ast.segments[0]!.parts).toEqual([
			{ uri: 'seg-0.m4s', duration: 0.52, byteRange: { length: 1000, offset: 0 }, independent: true, gap: false },
			{ uri: 'seg-0.m4s', duration: 0.48, byteRange: { length: 900, offset: 1000 }, independent: false, gap: false },
		]);
		expect(ast.trailingParts).toHaveLength(1);
		expect(ast.preloadHints).toEqual([{ type: 'PART', uri: 'seg-1.m4s', byteRangeStart: 1100, byteRangeLength: null }]);

		expect(serializeHls(ast)).toBe(LOW_LATENCY);
	});

	test('#EXTINF durations render with 3 decimals', () => {
		const out = serializeHls(parseHlsPlaylist(MEDIA));
		expect(out).toContain('#EXTINF:6.000,');
		expect(out).toContain('#EXTINF:5.500,title text');
	});
});

describe('round-trip fidelity', () => {
	const roundTrip = (text: string) => serializeHls(parseHlsPlaylist(text));

	test('master-level tags survive a round trip', () => {
		const out = roundTrip(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-START:TIME-OFFSET=-30
#EXT-X-SESSION-DATA:DATA-ID="com.x.title",VALUE="Demo"
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-CONTENT-STEERING:SERVER-URI="/steer",PATHWAY-ID="A"
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001f"
v1.m3u8
`);
		expect(out).toContain('#EXT-X-SESSION-KEY:');
		expect(out).toContain('skd://key');
		expect(out).toContain('#EXT-X-SESSION-DATA:');
		expect(out).toContain('#EXT-X-START:');
		expect(out).toContain('#EXT-X-CONTENT-STEERING:');
	});

	test('variant and rendition attributes survive a round trip', () => {
		const out = roundTrip(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",STABLE-RENDITION-ID="r1",BIT-DEPTH=16,SAMPLE-RATE=48000,URI="a.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001f",SCORE=2.5,SUPPLEMENTAL-CODECS="dvh1.05.01",STABLE-VARIANT-ID="v1",PATHWAY-ID="A",REQ-VIDEO-LAYOUT="CH-STEREO"
v1.m3u8
`);
		for (const attr of ['SCORE', 'SUPPLEMENTAL-CODECS', 'STABLE-VARIANT-ID', 'PATHWAY-ID', 'REQ-VIDEO-LAYOUT',
			'STABLE-RENDITION-ID', 'BIT-DEPTH', 'SAMPLE-RATE']) {
			expect(out, attr).toContain(attr);
		}
	});

	test('low-latency delta-update tags survive a round trip', () => {
		const out = roundTrip(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-SKIP:SKIPPED-SEGMENTS=12,RECENTLY-REMOVED-DATERANGES="ad1\tad2"
#EXTINF:6.000,
s1.m4s
#EXT-X-RENDITION-REPORT:URI="../audio/index.m3u8",LAST-MSN=42,LAST-PART=3
`);
		expect(out).toContain('#EXT-X-SKIP:SKIPPED-SEGMENTS=12');
		expect(out).toContain('ad1\tad2');
		expect(out).toContain('#EXT-X-RENDITION-REPORT:');
		expect(out).toContain('LAST-MSN=42');
		expect(out).toContain('LAST-PART=3');
	});

	test('an unmodelled tag warns once instead of vanishing silently', () => {
		const warnings: string[] = [];
		const off = Logging.on('warn', args => void warnings.push(String(args[0])));
		try {
			parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-FUTURE:A=1
#EXT-X-FUTURE:A=2
#EXTINF:6.000,
s.m4s
`);
		} finally {
			off();
		}

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('#EXT-X-FUTURE');
	});

	test('a fully modelled playlist warns about nothing', () => {
		const warnings: string[] = [];
		const off = Logging.on('warn', args => void warnings.push(String(args[0])));
		try {
			parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-SKIP:SKIPPED-SEGMENTS=2
#EXT-X-GAP
#EXT-X-BITRATE:1200
#EXTINF:6.000,
s.m4s
#EXT-X-ENDLIST
`);
		} finally {
			off();
		}

		expect(warnings).toEqual([]);
	});

	test('media-level tags survive a round trip', () => {
		const out = roundTrip(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-BITRATE:1200
#EXT-X-DATERANGE:ID="ad1",START-DATE="2026-01-01T00:00:00Z",DURATION=15
#EXTINF:6.000,
s1.m4s
#EXT-X-GAP
#EXTINF:6.000,
s2.m4s
#EXT-X-ENDLIST
`);
		expect(out).toContain('#EXT-X-BITRATE:');
		expect(out).toContain('#EXT-X-DATERANGE:');
		expect(out).toContain('#EXT-X-GAP');
	});

	test('absent, YES and NO stay distinct on #EXT-X-MEDIA', () => {
		const out = roundTrip(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,AUTOSELECT=NO,URI="a.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="fr",FORCED=NO,URI="s.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="de",URI="d.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001f"
v1.m3u8
`);
		const lines = out.split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:'));
		expect(lines[0]).toContain('DEFAULT=YES');
		expect(lines[0]).toContain('AUTOSELECT=NO');
		expect(lines[1]).toContain('FORCED=NO');
		expect(lines[2]).not.toContain('DEFAULT');
		expect(lines[2]).not.toContain('AUTOSELECT');
		expect(lines[2]).not.toContain('FORCED');
	});

	test('#EXT-X-I-FRAME-STREAM-INF keeps its content-protection attributes', () => {
		const out = roundTrip(`#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,CODECS="avc1.64001f",RESOLUTION=640x360,VIDEO-RANGE=PQ,HDCP-LEVEL=TYPE-1,ALLOWED-CPC="com.example.drm:SMART-TV",REQ-VIDEO-LAYOUT="CH-STEREO",URI="iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001f"
v1.m3u8
`);
		const line = out.split('\n').find(l => l.startsWith('#EXT-X-I-FRAME-STREAM-INF:'))!;
		expect(line).toContain('VIDEO-RANGE=PQ');
		expect(line).toContain('HDCP-LEVEL=TYPE-1');
		expect(line).toContain('ALLOWED-CPC="com.example.drm:SMART-TV"');
		expect(line).toContain('REQ-VIDEO-LAYOUT="CH-STEREO"');
	});
});

// Attribute lexical types from draft-pantos-hls-rfc8216bis-17. The serializer picks the emitted token form per
// attribute, and a wrong choice is well-formed-looking output that a strict parser may reject (INSTREAM-ID shipped
// unquoted this way), so the table is pinned here rather than left to each call site.
describe('emitted attribute lexical types match the spec', () => {
	const QUOTED = 'addQuotedString';
	const BARE = 'addString';
	const INT = 'addNumber';
	const FLOAT = 'addFloat';
	const RESOLUTION = 'addNumberPair';

	const SPEC_TYPE: Record<string, string | string[]> = {
		'ALLOWED-CPC': QUOTED, 'ASSOC-LANGUAGE': QUOTED, 'AUDIO': QUOTED, 'BYTERANGE': QUOTED,
		'CHANNELS': QUOTED, 'CHARACTERISTICS': QUOTED, 'CLASS': QUOTED, 'CODECS': QUOTED,
		'DATA-ID': QUOTED, 'END-DATE': QUOTED, 'GROUP-ID': QUOTED, 'INSTREAM-ID': QUOTED,
		'KEYFORMAT': QUOTED, 'KEYFORMATVERSIONS': QUOTED, 'LANGUAGE': QUOTED, 'NAME': QUOTED,
		'PATHWAY-ID': QUOTED, 'RECENTLY-REMOVED-DATERANGES': QUOTED, 'REQ-VIDEO-LAYOUT': QUOTED,
		'SERVER-URI': QUOTED, 'STABLE-RENDITION-ID': QUOTED, 'STABLE-VARIANT-ID': QUOTED,
		'START-DATE': QUOTED, 'SUBTITLES': QUOTED, 'SUPPLEMENTAL-CODECS': QUOTED, 'URI': QUOTED,
		'VALUE': QUOTED, 'VIDEO': QUOTED, 'ID': QUOTED,
		// Not an RFC 8216 attribute: the Image Media Playlist spec's tile grid, COLUMNSxROWS.
		'LAYOUT': RESOLUTION,
		// Not an RFC 8216 attribute: DASH-IF A/B watermarking ingest signalling, quoted in its spec.
		'WATERMARKING-VARIANT': QUOTED,
		// CLOSED-CAPTIONS is a quoted-string group ID or the enumerated-string NONE.
		'CLOSED-CAPTIONS': [QUOTED, BARE],

		'AUTOSELECT': BARE, 'CAN-BLOCK-RELOAD': BARE, 'CAN-SKIP-DATERANGES': BARE, 'CUE': BARE,
		'DEFAULT': BARE, 'END-ON-NEXT': BARE, 'FORCED': BARE, 'FORMAT': BARE, 'GAP': BARE,
		'HDCP-LEVEL': BARE, 'INDEPENDENT': BARE, 'METHOD': BARE, 'PRECISE': BARE, 'TYPE': BARE,
		'VIDEO-RANGE': BARE,
		// hexadecimal-sequence; KEYID and the SCTE35 attributes are likewise bare hex.
		'IV': BARE, 'KEYID': BARE, 'SCTE35-CMD': BARE, 'SCTE35-OUT': BARE, 'SCTE35-IN': BARE,

		'AVERAGE-BANDWIDTH': INT, 'BANDWIDTH': INT, 'BIT-DEPTH': INT, 'BYTERANGE-LENGTH': INT,
		'BYTERANGE-START': INT, 'LAST-MSN': INT, 'LAST-PART': INT, 'SAMPLE-RATE': INT,
		'SKIPPED-SEGMENTS': INT,

		'CAN-SKIP-UNTIL': FLOAT, 'DURATION': FLOAT, 'FRAME-RATE': FLOAT, 'HOLD-BACK': FLOAT,
		'PART-HOLD-BACK': FLOAT, 'PART-TARGET': FLOAT, 'PLANNED-DURATION': FLOAT, 'SCORE': FLOAT,
		'TIME-OFFSET': FLOAT,

		'RESOLUTION': RESOLUTION,
	};

	test('every emitted attribute uses the token form its spec type requires', async () => {
		const source = await readFile(new URL('../../src/hls/hls-serializer.ts', import.meta.url), 'utf-8');
		const calls = [...source.matchAll(/tag\.(add\w+)\('([A-Z0-9-]+)'/g)]
			.map(([, fn, attr]) => ({ fn: fn!, attr: attr! }));

		expect(calls.length).toBeGreaterThan(50);

		const wrong = calls.filter(({ fn, attr }) => {
			const expected = SPEC_TYPE[attr];
			if (expected === undefined) {
				return true;
			}

			return Array.isArray(expected) ? !expected.includes(fn) : fn !== expected;
		});

		expect(wrong.map(w => `${w.attr} emitted with ${w.fn}`)).toEqual([]);
	});
});

describe('Trick-play thumbnails (Image Media Playlist)', () => {
	// Verbatim shapes from the Image Media Playlist spec: RESOLUTION on the master tag is the size of
	// ONE tile, not of the image fetched, and #EXT-X-TILES sits between #EXTINF and the segment URI.
	const master = `#EXTM3U
#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=16460,RESOLUTION=320x180,CODECS="jpeg",URI="5x4_320x180/320x180-5x4.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401e"
v0.m3u8
`;
	const imagePlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:61
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-IMAGES-ONLY
#EXTINF:60.060,
#EXT-X-TILES:RESOLUTION=320x180,LAYOUT=5x4,DURATION=3.003
0.jpg
#EXT-X-ENDLIST
`;

	test('an image stream is parsed off the master playlist', () => {
		const parsed = parseHlsPlaylist(master);
		expect(parsed.kind).toBe('master');
		if (parsed.kind !== 'master') return;

		expect(parsed.imageStreams).toHaveLength(1);
		const stream = parsed.imageStreams[0]!;
		expect(stream.uri).toBe('5x4_320x180/320x180-5x4.m3u8');
		expect(stream.bandwidth).toBe(16460);
		expect(stream.codecs).toBe('jpeg');
		expect(stream.resolution).toEqual({ width: 320, height: 180 });
		// It must not be mistaken for a normal variant or an I-frame rendition
		expect(parsed.variants).toHaveLength(1);
		expect(parsed.iFrameStreams).toHaveLength(0);
	});

	test('the tile grid is parsed off the image media playlist', () => {
		const parsed = parseHlsPlaylist(imagePlaylist);
		expect(parsed.kind).toBe('media');
		if (parsed.kind !== 'media') return;

		expect(parsed.imagesOnly).toBe(true);
		expect(parsed.segments).toHaveLength(1);
		expect(parsed.segments[0]!.tiles).toEqual({
			resolution: { width: 320, height: 180 },
			layout: { columns: 5, rows: 4 },
			duration: 3.003,
		});
	});

	test('both survive a round trip', () => {
		for (const source of [master, imagePlaylist]) {
			const once = serializeHls(parseHlsPlaylist(source));
			expect(strip(parseHlsPlaylist(once))).toEqual(strip(parseHlsPlaylist(source)));
		}

		const out = serializeHls(parseHlsPlaylist(imagePlaylist));
		expect(out).toContain('#EXT-X-IMAGES-ONLY');
		// Order is load-bearing: the tag describes the URI that follows it
		expect(out.indexOf('#EXT-X-TILES')).toBeGreaterThan(out.indexOf('#EXTINF'));
		expect(out.indexOf('#EXT-X-TILES')).toBeLessThan(out.indexOf('0.jpg'));
	});

	test('a playlist with no thumbnails emits none of the tags', () => {
		const out = serializeHls(parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
a.ts
#EXT-X-ENDLIST
`));
		expect(out).not.toContain('IMAGES-ONLY');
		expect(out).not.toContain('EXT-X-TILES');
	});
});
