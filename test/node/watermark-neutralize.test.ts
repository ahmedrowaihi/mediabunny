/*!
 * The neutralizer strips a title's watermarking signalling before it reaches a device. Every place
 * the AST keeps text is a place it has to cover: when master playlists gained `unknownTags`, an
 * #EXT-X-WMPACEINFO written at that level started surviving as verbatim text.
 */
import { describe, expect, test } from 'vitest';
import { parseManifest, serializeManifest } from '../../src/manifest.js';
import { neutralizeWatermarking } from '../../src/manifest-transforms.js';

const WATERMARKING_MARKERS = ['WMPACEINFO', 'wmpi', 'urn:dashif:wmpi'];

const neutralized = (text: string) => serializeManifest(neutralizeWatermarking()(parseManifest(text)));

describe('no watermarking signalling survives anywhere', () => {
	test.each([
		['a master playlist, tag at playlist level', [
			'#EXTM3U',
			'#EXT-X-WMPACEINFO:URI="wm/pace.bin"',
			'#EXT-X-STREAM-INF:BANDWIDTH=1000',
			'v.m3u8',
			'',
		].join('\n')],
		['a media playlist, tag at playlist level', [
			'#EXTM3U',
			'#EXT-X-TARGETDURATION:4',
			'#EXT-X-WMPACEINFO:URI="wm/pace.bin"',
			'#EXTINF:4,',
			'a.ts',
			'#EXT-X-ENDLIST',
			'',
		].join('\n')],
		['a media playlist, tag sitting on a segment', [
			'#EXTM3U',
			'#EXT-X-TARGETDURATION:4',
			'#EXTINF:4,',
			'a.ts',
			'#EXT-X-WMPACEINFO:URI="wm/pace.bin"',
			'#EXTINF:4,',
			'b.ts',
			'#EXT-X-ENDLIST',
			'',
		].join('\n')],
	])('%s', (_name, text) => {
		// the fixture must actually carry it, or the test proves nothing
		expect(text).toContain('WMPACEINFO');

		const out = neutralized(text);
		for (const marker of WATERMARKING_MARKERS) {
			expect(out, `${marker} survived neutralizing`).not.toContain(marker);
		}
	});

	test('everything else in the playlist is left alone', () => {
		const out = neutralized([
			'#EXTM3U',
			'#X-VENDOR:keep-me',
			'#EXT-X-WMPACEINFO:URI="wm/pace.bin"',
			'#EXT-X-STREAM-INF:BANDWIDTH=1000',
			'v.m3u8',
			'',
		].join('\n'));

		expect(out).toContain('#X-VENDOR:keep-me');
		expect(out).toContain('BANDWIDTH=1000');
		expect(out).not.toContain('WMPACEINFO');
	});
});
