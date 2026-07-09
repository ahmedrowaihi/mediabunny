/* eslint-disable @stylistic/max-len */
import { describe, expect, test } from 'vitest';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import type { HlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { serializeHls } from '../../src/hls/hls-serializer.js';

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

	test('#EXTINF durations render with 3 decimals', () => {
		const out = serializeHls(parseHlsPlaylist(MEDIA));
		expect(out).toContain('#EXTINF:6.000,');
		expect(out).toContain('#EXTINF:5.500,title text');
	});
});
