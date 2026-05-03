/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/tag.cc
 */
import { describe, expect, test } from 'vitest';
import { Tag } from '../../src/hls/hls-tag.js';

describe('Tag', () => {
	test('renders bare tag with no fields', () => {
		expect(new Tag('#EXT-X-FOO').toString()).toBe('#EXT-X-FOO:');
	});

	test('appends one non-quoted string field', () => {
		const t = new Tag('#EXT-X-MEDIA').addString('TYPE', 'AUDIO');
		expect(t.toString()).toBe('#EXT-X-MEDIA:TYPE=AUDIO');
	});

	test('appends multiple fields separated by commas', () => {
		const t = new Tag('#EXT-X-STREAM-INF')
			.addNumber('BANDWIDTH', 5000000)
			.addQuotedString('CODECS', 'avc1.640028,mp4a.40.2')
			.addNumberPair('RESOLUTION', 1920, 'x', 1080)
			.addFloat('FRAME-RATE', 29.97);
		expect(t.toString()).toBe(
			'#EXT-X-STREAM-INF:BANDWIDTH=5000000,'
			+ 'CODECS="avc1.640028,mp4a.40.2",'
			+ 'RESOLUTION=1920x1080,'
			+ 'FRAME-RATE=29.970',
		);
	});

	test('quotes string values', () => {
		const t = new Tag('#EXT-X-MAP').addQuotedString('URI', 'init.m4s');
		expect(t.toString()).toBe('#EXT-X-MAP:URI="init.m4s"');
	});

	test('renders integer fields without decimals', () => {
		const t = new Tag('#EXT-X-TARGETDURATION').addNumber('VAL', 6);
		expect(t.toString()).toBe('#EXT-X-TARGETDURATION:VAL=6');
	});

	test('renders quoted number pair (BYTERANGE-style)', () => {
		const t = new Tag('#EXT-X-MAP').addQuotedNumberPair('BYTERANGE', 3128, '@', 0);
		expect(t.toString()).toBe('#EXT-X-MAP:BYTERANGE="3128@0"');
	});

	test('formats floats to 3 decimals', () => {
		const t = new Tag('#EXT-X-STREAM-INF').addFloat('FRAME-RATE', 23.9760239);
		expect(t.toString()).toBe('#EXT-X-STREAM-INF:FRAME-RATE=23.976');
	});
});
