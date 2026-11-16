import { describe, expect, test } from 'vitest';
import { hlsVersionOf } from '../../src/hls/hls-version.js';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { serializeHls } from '../../src/hls/hls-serializer.js';
import { hlsMediaPlaylist, hlsSegment } from '../../src/hls/hls-playlist-builder.js';
import { InvalidUsageError } from '../../src/errors.js';
import { assert } from '../../src/misc.js';

const media = (...body: string[]) => parseHlsPlaylist(
	['#EXTM3U', '#EXT-X-TARGETDURATION:10', ...body, '#EXT-X-ENDLIST', ''].join('\n'),
);
const SEG = ['#EXTINF:6,', 'a.ts'];

describe('hlsVersionOf', () => {
	test('any playlist with segments needs 3, because EXTINF is written in decimal form', () => {
		// 4.4.4.1 permits decimal-floating-point only from version 3. This serializer always writes
		// three decimals (shaka parity), so that is what every playlist it writes requires — the
		// version is derived from the rendering rather than guessing at it.
		expect(hlsVersionOf(media(...SEG))).toBe(3);
		expect(hlsVersionOf(media('#EXTINF:6.5,', 'a.ts'))).toBe(3);
	});

	test('a playlist with no segments needs nothing beyond version 1', () => {
		expect(hlsVersionOf(parseHlsPlaylist(
			['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-ENDLIST', ''].join('\n'),
		))).toBe(1);
	});

	test('an IV needs 2, which the EXTINF rule then raises to 3', () => {
		expect(hlsVersionOf(media(
			'#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x0123456789abcdef0123456789abcdef', ...SEG,
		))).toBe(3);
	});

	test('BYTERANGE and I-FRAMES-ONLY need 4', () => {
		expect(hlsVersionOf(media('#EXT-X-BYTERANGE:1000@0', ...SEG))).toBe(4);
		expect(hlsVersionOf(media('#EXT-X-I-FRAMES-ONLY', ...SEG))).toBe(4);
	});

	test('SAMPLE-AES and KEYFORMAT need 5, a bare identity key does not', () => {
		expect(hlsVersionOf(media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"', ...SEG))).toBe(5);
		expect(hlsVersionOf(media('#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.x"', ...SEG))).toBe(5);
		expect(hlsVersionOf(media('#EXT-X-KEY:METHOD=AES-128,URI="k"', ...SEG))).toBe(3);
	});

	test('MAP is 6 on its own, but 5 alongside I-FRAMES-ONLY', () => {
		expect(hlsVersionOf(media('#EXT-X-MAP:URI="init.mp4"', ...SEG))).toBe(6);
		expect(hlsVersionOf(media('#EXT-X-I-FRAMES-ONLY', '#EXT-X-MAP:URI="init.mp4"', ...SEG))).toBe(5);
	});

	test('SKIP is 9, and 10 when it replaces dateranges', () => {
		expect(hlsVersionOf(media('#EXT-X-SKIP:SKIPPED-SEGMENTS=3', ...SEG))).toBe(9);
		expect(hlsVersionOf(media('#EXT-X-SKIP:SKIPPED-SEGMENTS=3,RECENTLY-REMOVED-DATERANGES="a"', ...SEG)))
			.toBe(10);
	});

	test('a SERVICE INSTREAM-ID is 7; a non-closed-caption INSTREAM-ID is 13', () => {
		const master = (mediaTag: string) => parseHlsPlaylist([
			'#EXTM3U', mediaTag, '#EXT-X-STREAM-INF:BANDWIDTH=1000', 'v.m3u8', '',
		].join('\n'));

		expect(hlsVersionOf(master(
			'#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="E",INSTREAM-ID="SERVICE1"',
		))).toBe(7);
		expect(hlsVersionOf(master(
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="E",INSTREAM-ID="CC1"',
		))).toBe(13);
	});

	test('the highest requirement wins', () => {
		expect(hlsVersionOf(media(
			'#EXT-X-MAP:URI="init.mp4"',
			'#EXT-X-SKIP:SKIPPED-SEGMENTS=3,RECENTLY-REMOVED-DATERANGES="a"',
			'#EXTINF:6.5,', 'a.ts',
		))).toBe(10);
	});
});

describe('hlsVersionOf agrees with what serializeHls writes', () => {
	// The rule reads a duration's numeric value; the serializer chooses its syntax. When those two
	// disagree the playlist contradicts its own EXT-X-VERSION, and too low is the dangerous
	// direction — a client trusts it and tries to play what it cannot. Asserting against the TEXT is
	// the point: re-parsing turns "4.000" back into the number 4, so an AST round-trip sees nothing.
	const cases: [string, Parameters<typeof hlsMediaPlaylist>[0]][] = [
		['integer durations', { targetDuration: 4, segments: [hlsSegment({ uri: 'a.ts', duration: 4 })] }],
		['float durations', { targetDuration: 4, segments: [hlsSegment({ uri: 'a.ts', duration: 4.5 })] }],
		['mixed durations', {
			targetDuration: 4,
			segments: [hlsSegment({ uri: 'a.ts', duration: 4 }), hlsSegment({ uri: 'b.ts', duration: 3.5 })],
		}],
		['a map, which forces 6', {
			targetDuration: 4,
			segments: [hlsSegment({ uri: 'a.m4s', duration: 4, map: 'init.mp4' })],
		}],
	];

	test.each(cases)('%s: the written EXTINF syntax matches the declared version', (_name, options) => {
		const playlist = hlsMediaPlaylist(options);
		const version = hlsVersionOf(playlist);
		const text = serializeHls({ ...playlist, version });

		expect(text).toContain(`#EXT-X-VERSION:${version}`);

		const extinfs = text.split('\n').filter(line => line.startsWith('#EXTINF:'));
		expect(extinfs.length).toBeGreaterThan(0);
		for (const line of extinfs) {
			const duration = line.slice('#EXTINF:'.length, line.indexOf(','));
			if (version < 3) {
				// 4.4.4.1: below version 3 durations MUST be integers, and "4.000" is not one
				expect(duration, `${line} is floating-point syntax at version ${version}`).not.toContain('.');
			}
		}

		// and the text does not need more than it declares
		expect(hlsVersionOf(parseHlsPlaylist(text))).toBeLessThanOrEqual(version);
	});

	test('a version too low for its own durations is refused, not written wrong', () => {
		const playlist = hlsMediaPlaylist({
			targetDuration: 4,
			segments: [hlsSegment({ uri: 'a.ts', duration: 4.5 })],
		});

		expect(() => serializeHls({ ...playlist, version: 1 })).toThrow(InvalidUsageError);
	});
});

describe('serializeHls states a version its content can live under', () => {
	test('a parsed playlist that understates its version is refused', () => {
		// MAP needs 6; the input claims 3
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4',
			'#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'a.m4s', '#EXT-X-ENDLIST', '',
		].join('\n'));

		expect(() => serializeHls(playlist)).toThrow(InvalidUsageError);
	});

	test('a playlist with no version gets the one it needs', () => {
		const playlist = hlsMediaPlaylist({
			targetDuration: 4,
			segments: [hlsSegment({ uri: 'a.m4s', duration: 4, map: 'init.mp4' })],
		});
		expect(playlist.version).toBeNull();

		const text = serializeHls({ ...playlist, version: null });
		expect(text).toContain('#EXT-X-VERSION:6');
	});

	test('a playlist with no segments writes no version tag, since 1 is the absence of it', () => {
		const playlist = hlsMediaPlaylist({ targetDuration: 4, segments: [] });
		expect(serializeHls({ ...playlist, version: null })).not.toContain('#EXT-X-VERSION');
	});

	test('a version higher than needed is honoured, not lowered', () => {
		const playlist = hlsMediaPlaylist({
			targetDuration: 4, segments: [hlsSegment({ uri: 'a.ts', duration: 4 })],
		});
		expect(serializeHls({ ...playlist, version: 7 })).toContain('#EXT-X-VERSION:7');
	});

	test('what hlsVersionOf states is what the written playlist needs', () => {
		// The bug this guards: the version said 1 and the bytes said "#EXTINF:4.000,", which needs 3.
		for (const durations of [[4], [4.5], [4, 3.5], [6, 6]]) {
			const playlist = hlsMediaPlaylist({
				targetDuration: 10,
				segments: durations.map((duration, i) => hlsSegment({ uri: `${i}.ts`, duration })),
			});
			const stated = hlsVersionOf(playlist);
			const text = serializeHls({ ...playlist, version: stated });

			expect(text).toContain(`#EXT-X-VERSION:${stated}`);
			expect(hlsVersionOf(parseHlsPlaylist(text))).toBeLessThanOrEqual(stated);
		}
	});
});

describe('attributes are neither invented nor flattened', () => {
	test('an absent KEYFORMATVERSIONS is not written back as "1"', () => {
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-KEY:METHOD=AES-128,URI="k"',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(playlist.kind === 'media');

		expect(playlist.segments[0]!.keys[0]!.keyFormatVersions).toEqual([]);
		expect(serializeHls(playlist)).not.toContain('KEYFORMATVERSIONS');
	});

	test('a stated KEYFORMATVERSIONS survives and needs version 5', () => {
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-VERSION:5', '#EXT-X-TARGETDURATION:4',
			'#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMATVERSIONS="1/2"',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(playlist.kind === 'media');

		expect(playlist.segments[0]!.keys[0]!.keyFormatVersions).toEqual([1, 2]);
		expect(hlsVersionOf(playlist)).toBe(5);
		expect(serializeHls(playlist)).toContain('KEYFORMATVERSIONS="1/2"');
	});

	test('an empty RECENTLY-REMOVED-DATERANGES differs from an absent one', () => {
		// The spec allows the empty string and REQUIRES the attribute once a daterange was skipped,
		// so present-but-empty must survive and still demand version 10.
		const withEmpty = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4',
			'#EXT-X-SKIP:SKIPPED-SEGMENTS=3,RECENTLY-REMOVED-DATERANGES=""',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		const without = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-SKIP:SKIPPED-SEGMENTS=3',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(withEmpty.kind === 'media' && without.kind === 'media');

		expect(withEmpty.skip!.recentlyRemovedDateRanges).toEqual([]);
		expect(without.skip!.recentlyRemovedDateRanges).toBeNull();

		expect(hlsVersionOf(withEmpty)).toBe(10);
		expect(hlsVersionOf(without)).toBe(9);
		expect(serializeHls(withEmpty)).toContain('RECENTLY-REMOVED-DATERANGES=""');
		expect(serializeHls(without)).not.toContain('RECENTLY-REMOVED-DATERANGES');
	});
});
