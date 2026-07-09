/*!
 * Tests for the HLS playlist builders in `src/hls/hls-playlist-builder.ts` — the construction
 * counterpart to `parseHlsPlaylist`. Build → serialize → parse should round-trip the fields.
 */
import { describe, expect, test } from 'vitest';
import {
	hlsMasterPlaylist,
	hlsMediaPlaylist,
	hlsMediaRendition,
	hlsSegment,
	hlsVariant,
	parseHlsPlaylist,
	serializeManifest,
} from '../../src/index.js';

describe('hls builders', () => {
	test('variant fills optional attributes with absent defaults', () => {
		const v = hlsVariant({ uri: 'v/1080.m3u8', bandwidth: 6_000_000, codecs: 'avc1.640028', resolution: { width: 1920, height: 1080 }, audioGroup: 'aud' });
		expect(v).toMatchObject({ uri: 'v/1080.m3u8', bandwidth: 6_000_000, audioGroup: 'aud', hdcpLevel: null, videoGroup: null, name: null });
	});

	test('master round-trips through serialize + parse', () => {
		const master = hlsMasterPlaylist({
			independentSegments: true,
			version: 7,
			media: [hlsMediaRendition({ type: 'AUDIO', groupId: 'aud', name: 'en', uri: 'a/en.m3u8', default: true, autoselect: true })],
			variants: [hlsVariant({ uri: 'v/1080.m3u8', bandwidth: 6_000_000, codecs: 'avc1.640028,mp4a.40.2', resolution: { width: 1920, height: 1080 }, audioGroup: 'aud' })],
		});
		const parsed = parseHlsPlaylist(serializeManifest({ format: 'hls', playlist: master }));
		if (parsed.kind !== 'master') throw new Error('expected master');
		expect(parsed.variants[0]).toMatchObject({ uri: 'v/1080.m3u8', bandwidth: 6_000_000, audioGroup: 'aud', resolution: { width: 1920, height: 1080 } });
		expect(parsed.media[0]).toMatchObject({ type: 'AUDIO', groupId: 'aud', name: 'en', uri: 'a/en.m3u8', default: true });
	});

	test('media playlist is live without endlist and carries the EXT-X-MAP', () => {
		const media = hlsMediaPlaylist({
			version: 7,
			targetDuration: 4,
			mediaSequence: 42,
			segments: [
				hlsSegment({ uri: 'v/1.m4s', duration: 4, mapUri: 'v/init.mp4' }),
				hlsSegment({ uri: 'v/2.m4s', duration: 4, mapUri: 'v/init.mp4' }),
			],
		});
		const text = serializeManifest({ format: 'hls', playlist: media });
		expect(text).not.toContain('#EXT-X-ENDLIST');
		expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:42');
		const parsed = parseHlsPlaylist(text);
		if (parsed.kind !== 'media') throw new Error('expected media');
		expect(parsed.segments).toHaveLength(2);
		expect(parsed.segments[0]).toMatchObject({ uri: 'v/1.m4s', duration: 4 });
		expect(parsed.endlist).toBe(false);
	});
});
