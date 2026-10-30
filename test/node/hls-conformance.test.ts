/*!
 * Inputs draft-pantos-hls-rfc8216bis-22 says a client MUST fail to parse. The line this draws:
 * refuse what cannot be interpreted, warn about what is interpretable but non-conformant — a parser
 * that reads other people's playlists is worth less if it rejects them over a recoverable detail.
 */
import { describe, expect, test } from 'vitest';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { MalformedInputError } from '../../src/errors.js';
import { Logging } from '../../src/logging.js';

const media = (...body: string[]) =>
	['#EXTM3U', '#EXT-X-TARGETDURATION:4', ...body, '#EXT-X-ENDLIST', ''].join('\n');
const SEGMENT = ['#EXTINF:4,', 'a.ts'];
const master = (...body: string[]) => ['#EXTM3U', ...body, ''].join('\n');

describe('inputs the spec says MUST fail', () => {
	test.each([
		['two #EXT-X-VERSION tags (4.4.1.2)', media('#EXT-X-VERSION:3', '#EXT-X-VERSION:4', ...SEGMENT)],
		['#EXT-X-MEDIA-SEQUENCE after a segment (4.4.3.2)',
			media(...SEGMENT, '#EXT-X-MEDIA-SEQUENCE:5', ...SEGMENT)],
		['an unrecognised KEY METHOD (4.4.4.4)', media('#EXT-X-KEY:METHOD=FOO,URI="k"', ...SEGMENT)],
		['an IV that is not a hex sequence (4.4.4.4)',
			media('#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0xZZ', ...SEGMENT)],
		['a negative EXTINF duration (4.4.4.1)', media('#EXTINF:-4,', 'a.ts')],
		['an EXTINF with no comma (4.4.4.1)', media('#EXTINF:4', 'a.ts')],
		['a first #EXT-X-BYTERANGE with no offset (4.4.4.2)', media('#EXT-X-BYTERANGE:100', ...SEGMENT)],
		['#EXT-X-PART with no #EXT-X-PART-INF (4.4.5.1)',
			media('#EXT-X-PART:DURATION=1,URI="p.ts"', ...SEGMENT)],
		['a non-integer #EXT-X-TARGETDURATION (4.4.3.1)',
			['#EXTM3U', '#EXT-X-TARGETDURATION:4.5', ...SEGMENT, '#EXT-X-ENDLIST', ''].join('\n')],
		['a negative #EXT-X-TARGETDURATION (4.4.3.1)',
			['#EXTM3U', '#EXT-X-TARGETDURATION:-4', ...SEGMENT, '#EXT-X-ENDLIST', ''].join('\n')],
		['a CLOSED-CAPTIONS rendition with a URI (4.4.6.1)',
			master('#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="c",NAME="E",INSTREAM-ID="CC1",URI="x.m3u8"',
				'#EXT-X-STREAM-INF:BANDWIDTH=1000', 'v.m3u8')],
		['a negative BANDWIDTH (4.4.6.2)', master('#EXT-X-STREAM-INF:BANDWIDTH=-5', 'v.m3u8')],
		['a fractional BANDWIDTH (4.4.6.2)', master('#EXT-X-STREAM-INF:BANDWIDTH=1.5', 'v.m3u8')],
	])('refuses %s', (_name, text) => {
		expect(() => parseHlsPlaylist(text)).toThrow(MalformedInputError);
	});

	test('still accepts the conformant forms of all of them', () => {
		expect(() => parseHlsPlaylist(media(
			'#EXT-X-VERSION:5',
			'#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x0123456789abcdef0123456789abcdef',
			...SEGMENT,
		))).not.toThrow();
		expect(() => parseHlsPlaylist(master('#EXT-X-STREAM-INF:BANDWIDTH=1000', 'v.m3u8'))).not.toThrow();
	});
});

describe('non-conformant but interpretable input is reported as data, not refused or logged', () => {
	// An origin parses a relayed playlist on every request. A library writing to its console once per
	// tag per request is unusable there, so observations come back on the playlist.
	const notesFrom = (text: string) => {
		const logged: string[] = [];
		const stop = Logging.on('warn', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
		try {
			const playlist = parseHlsPlaylist(text);
			expect(logged, 'parsing must not write to the console').toEqual([]);
			return playlist.notes;
		} finally {
			stop();
		}
	};

	test('a segment past the target duration is noted, not thrown', () => {
		const notes = notesFrom(media('#EXTINF:9,', 'a.ts'));
		expect(notes).toEqual([
			{ kind: 'segment-past-target-duration', uri: 'a.ts', duration: 9, targetDuration: 4 },
		]);
	});

	test('a missing target duration is noted, not thrown', () => {
		const notes = notesFrom(['#EXTM3U', ...SEGMENT, '#EXT-X-ENDLIST', ''].join('\n'));
		expect(notes).toEqual([{ kind: 'missing-target-duration' }]);
	});

	test('an unmodelled tag is noted once, and kept', () => {
		const notes = notesFrom(media('#EXT-X-FUTURE:1', '#EXT-X-FUTURE:2', ...SEGMENT));
		expect(notes).toEqual([{ kind: 'unmodelled-tag', tag: '#EXT-X-FUTURE', line: 3 }]);
	});

	test('a conformant playlist reports nothing', () => {
		expect(notesFrom(media(...SEGMENT))).toEqual([]);
	});

	test('a target duration of zero still parses, since zero is a decimal-integer', () => {
		expect(() => parseHlsPlaylist(
			['#EXTM3U', '#EXT-X-TARGETDURATION:0', '#EXTINF:1,', 'a.ts', '#EXT-X-ENDLIST', ''].join('\n'),
		)).not.toThrow();
	});
});
