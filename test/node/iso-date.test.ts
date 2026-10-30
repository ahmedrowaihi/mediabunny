/*!
 * Manifest timelines are absolute. `Date.parse` reads a zoneless ISO date-time as LOCAL time, so
 * without normalisation the same manifest means different instants on servers in different zones —
 * a live MPD's availabilityStartTime moved by hours with the host's TZ.
 */
import { describe, expect, test } from 'vitest';
import { parseIsoDateTimeAsUtc } from '../../src/iso-date.js';
import { parseMpd } from '../../src/dash/dash-mpd-parser.js';
import { parseHlsPlaylist } from '../../src/hls/hls-playlist-parser.js';
import { assert } from '../../src/misc.js';

describe('zoneless ISO date-times are UTC', () => {
	const EXPECTED = Date.UTC(2024, 0, 1, 0, 0, 0);

	test('a zoneless time does not depend on the host zone', () => {
		expect(parseIsoDateTimeAsUtc('2024-01-01T00:00:00')).toBe(EXPECTED);
	});

	test('an explicit designator is still honoured', () => {
		expect(parseIsoDateTimeAsUtc('2024-01-01T00:00:00Z')).toBe(EXPECTED);
		expect(parseIsoDateTimeAsUtc('2024-01-01T03:00:00+03:00')).toBe(EXPECTED);
		expect(parseIsoDateTimeAsUtc('2024-01-01T03:00:00+0300')).toBe(EXPECTED);
		expect(parseIsoDateTimeAsUtc('2023-12-31T19:00:00-05:00')).toBe(EXPECTED);
	});

	test('an MPD availabilityStartTime reads as UTC', () => {
		const mpd = parseMpd('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"'
			+ ' profiles="p" availabilityStartTime="2024-01-01T00:00:00"><Period/></MPD>');
		expect(mpd.availabilityStartTime).toBe(EXPECTED);
	});

	test('EXT-X-PROGRAM-DATE-TIME reads as UTC', () => {
		const playlist = parseHlsPlaylist([
			'#EXTM3U', '#EXT-X-TARGETDURATION:4',
			'#EXT-X-PROGRAM-DATE-TIME:2024-01-01T00:00:00',
			'#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', '',
		].join('\n'));
		assert(playlist.kind === 'media');
		expect(playlist.segments[0]!.programDateTime).toBe(EXPECTED);
	});
});
