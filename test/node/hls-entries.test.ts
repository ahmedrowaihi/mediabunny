/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import {
	DiscontinuityEntry,
	PlacementOpportunityEntry,
	ProgramDateTimeEntry,
	SegmentInfoEntry,
} from '../../src/hls/hls-entries';

describe('SegmentInfoEntry', () => {
	test('renders without byte range', () => {
		const e = new SegmentInfoEntry({
			fileName: 'segment-001.m4s',
			startTime: 0,
			durationSeconds: 6.0,
			useByteRange: false,
			startByteOffset: 0,
			segmentFileSize: 0,
			previousSegmentEndOffset: 0,
		});
		expect(e.toString()).toBe('#EXTINF:6.000,\nsegment-001.m4s');
	});

	test('renders byte range with explicit offset when not contiguous', () => {
		const e = new SegmentInfoEntry({
			fileName: 'master.cmfv',
			startTime: 0,
			durationSeconds: 6.0,
			useByteRange: true,
			startByteOffset: 3128,
			segmentFileSize: 524288,
			previousSegmentEndOffset: 0,
		});
		expect(e.toString()).toBe(
			'#EXTINF:6.000,\n#EXT-X-BYTERANGE:524288@3128\nmaster.cmfv',
		);
	});

	test('omits offset when segment is contiguous with previous one', () => {
		const e = new SegmentInfoEntry({
			fileName: 'master.cmfv',
			startTime: 0,
			durationSeconds: 6.0,
			useByteRange: true,
			startByteOffset: 527416,
			segmentFileSize: 498102,
			previousSegmentEndOffset: 527415,
		});
		expect(e.toString()).toBe(
			'#EXTINF:6.000,\n#EXT-X-BYTERANGE:498102\nmaster.cmfv',
		);
	});

	test('uses 3-decimal duration formatting', () => {
		const e = new SegmentInfoEntry({
			fileName: 'segment.m4s',
			startTime: 0,
			durationSeconds: 5.9837425,
			useByteRange: false,
			startByteOffset: 0,
			segmentFileSize: 0,
			previousSegmentEndOffset: 0,
		});
		expect(e.toString().split('\n')[0]).toBe('#EXTINF:5.984,');
	});

	test('exposes start time and duration getters', () => {
		const e = new SegmentInfoEntry({
			fileName: 's.m4s',
			startTime: 90000,
			durationSeconds: 6.0,
			useByteRange: false,
			startByteOffset: 0,
			segmentFileSize: 0,
			previousSegmentEndOffset: 0,
		});
		expect(e.getStartTime()).toBe(90000);
		expect(e.getDurationSeconds()).toBe(6.0);
		e.setDurationSeconds(5.5);
		expect(e.getDurationSeconds()).toBe(5.5);
	});
});

describe('DiscontinuityEntry', () => {
	test('renders #EXT-X-DISCONTINUITY', () => {
		expect(new DiscontinuityEntry().toString()).toBe('#EXT-X-DISCONTINUITY');
	});
});

describe('PlacementOpportunityEntry', () => {
	test('renders #EXT-X-PLACEMENT-OPPORTUNITY', () => {
		expect(new PlacementOpportunityEntry().toString()).toBe('#EXT-X-PLACEMENT-OPPORTUNITY');
	});
});

describe('ProgramDateTimeEntry', () => {
	test('formats UTC time to ISO 8601 with millisecond precision', () => {
		const ms = Date.UTC(2026, 3, 22, 10, 36, 0, 123); // 2026-04-22T10:36:00.123Z
		expect(new ProgramDateTimeEntry(ms).toString()).toBe(
			'#EXT-X-PROGRAM-DATE-TIME:2026-04-22T10:36:00.123Z',
		);
	});

	test('pads single-digit fields with zeros', () => {
		const ms = Date.UTC(2026, 0, 5, 7, 8, 9, 4); // 2026-01-05T07:08:09.004Z
		expect(new ProgramDateTimeEntry(ms).toString()).toBe(
			'#EXT-X-PROGRAM-DATE-TIME:2026-01-05T07:08:09.004Z',
		);
	});
});
