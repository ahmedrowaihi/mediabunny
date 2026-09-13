import { describe, expect, test } from 'vitest';
import { hlsReloadDirective, hlsReloadState, hlsRetainsParts } from '../../src/hls/hls-reload.js';

// Media sequence 10 with two complete segments, so the last is 11, and two parts of the one in progress.
const withTrailingParts = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5
#EXT-X-PART-INF:PART-TARGET=0.5
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:2,
seg-10.m4s
#EXTINF:2,
seg-11.m4s
#EXT-X-PART:DURATION=0.5,URI="seg-12.m4s",BYTERANGE="100@0"
#EXT-X-PART:DURATION=0.5,URI="seg-12.m4s",BYTERANGE="100@100"
`;

// The same window with nothing of the next segment published yet.
const withoutTrailingParts = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-PART-INF:PART-TARGET=0.5
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:2,
seg-10.m4s
#EXTINF:2,
seg-11.m4s
`;

describe('hlsReloadState', () => {
	test('waits for what is coming and refuses what is too far ahead', () => {
		// The segment in progress, whose part the playlist already lists
		expect(hlsReloadState(withTrailingParts, { msn: 12, part: 1 }, 4)).toBe('ready');
		// The same segment, but a part it has not published yet
		expect(hlsReloadState(withTrailingParts, { msn: 12, part: 3 }, 4)).toBe('wait');
		// A segment naming no part at all cannot be answered until it exists
		expect(hlsReloadState(withTrailingParts, { msn: 12, part: null }, 4)).toBe('wait');
		// More than two segments ahead is refused on count alone
		expect(hlsReloadState(withTrailingParts, { msn: 14, part: null }, 4)).toBe('too-far');
	});

	test('the Advance Part Limit is three target durations, counted in parts', () => {
		// PART-TARGET is 0.5s, so the limit is six parts, not three
		expect(hlsReloadState(withTrailingParts, { msn: 12, part: 7 }, 16)).toBe('wait');
		expect(hlsReloadState(withTrailingParts, { msn: 12, part: 8 }, 16)).toBe('too-far');
	});

	test('RFC 8216bis 6.2.5.2: a part past a segment\'s last is part 0 of the next segment', () => {
		// Segment 11 has four parts; asking for its fifth means part 0 of segment 12, which has none yet
		expect(hlsReloadState(withoutTrailingParts, { msn: 11, part: 4 }, 4)).toBe('wait');
		// Without the roll forward this would be answerable, since segment 11 is already complete
		expect(hlsReloadState(withoutTrailingParts, { msn: 11, part: 3 }, 4)).toBe('ready');
	});

	test('a reload for a segment the window has already evicted is answerable at once', () => {
		// Below the media sequence entirely: the playlist has moved past it, so serve rather than strand
		expect(hlsReloadState(withTrailingParts, { msn: 3, part: null }, 4)).toBe('ready');
		expect(hlsReloadState(withTrailingParts, { msn: 10, part: 2 }, 4)).toBe('ready');
	});

	test('a master playlist is refused rather than guessed at', () => {
		const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n';
		expect(() => hlsReloadState(master, { msn: 1, part: null }, 1)).toThrow(/media playlist/);
	});
});

describe('hlsReloadDirective', () => {
	test('no directive is not the same answer as a malformed one', () => {
		// Absent: serve the playlist normally
		expect(hlsReloadDirective(undefined, undefined)).toBe(null);
		// Malformed: refuse, rather than answering as if nothing had been asked
		expect(hlsReloadDirective(undefined, '2')).toBe('invalid');
	});

	test('reads a well-formed directive, with or without a part', () => {
		expect(hlsReloadDirective('12', '3')).toEqual({ msn: 12, part: 3 });
		expect(hlsReloadDirective('12', undefined)).toEqual({ msn: 12, part: null });
		expect(hlsReloadDirective('0', '0')).toEqual({ msn: 0, part: 0 });
	});

	test('a value that is not a non-negative integer is invalid', () => {
		expect(hlsReloadDirective('abc', undefined)).toBe('invalid');
		expect(hlsReloadDirective('12', 'abc')).toBe('invalid');
		expect(hlsReloadDirective('-1', undefined)).toBe('invalid');
		expect(hlsReloadDirective('1.5', undefined)).toBe('invalid');
		// Present but empty is malformed, not absent
		expect(hlsReloadDirective('', undefined)).toBe('invalid');
	});
});

describe('hlsRetainsParts', () => {
	test('holds parts for three target durations past their segment', () => {
		const retains = hlsRetainsParts([2, 2, 2, 2]);
		expect(retains(6, 8)).toBe(true); // two seconds old
		expect(retains(2, 8)).toBe(true); // exactly six seconds: the bound is inclusive
		expect(retains(1, 8)).toBe(false); // seven seconds, past three target durations
	});

	test('rounds the target up, so a fractional segment is not under-held', () => {
		// 1.5s segments round to 2, giving a six second window rather than 4.5
		const retains = hlsRetainsParts([1.5, 1.5]);
		expect(retains(2, 8)).toBe(true);
		expect(retains(1, 8)).toBe(false);
	});

	test('a sub-second segment still holds at least three seconds of parts', () => {
		const retains = hlsRetainsParts([0.4, 0.4]);
		expect(retains(5, 8)).toBe(true);
		expect(retains(4, 8)).toBe(false);
	});
});
