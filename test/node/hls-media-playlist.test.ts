/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { MediaPlaylist } from '../../src/hls/hls-media-playlist.js';
import type { HlsMediaInfo, HlsParams } from '../../src/hls/hls-types.js';

const TIME_SCALE = 90_000;
const MBYTES = 1_000_000;

const generatorBanner = (): { generatorUrl: string; generatorVersion: string } => ({
	generatorUrl: 'https://github.com/shaka-project/shaka-packager',
	generatorVersion: 'test',
});

const vodParams = (): HlsParams => ({
	playlistType: 'vod',
	...generatorBanner(),
});

const videoMediaInfo = (overrides: Partial<HlsMediaInfo> = {}): HlsMediaInfo => ({
	videoInfo: {
		codec: 'avc1.640028',
		width: 1920,
		height: 1080,
		timeScale: TIME_SCALE,
	},
	containerType: 'mp4',
	...overrides,
});

describe('MediaPlaylist — multi-segment', () => {
	test('SetMediaInfo fails when timescale is zero', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		expect(p.setMediaInfo({ videoInfo: { codec: 'avc1', width: 1, height: 1, timeScale: 0 } })).toBe(false);
	});

	test('SetMediaInfo accepts text-only info', () => {
		const p = new MediaPlaylist(vodParams(), 'subs.m3u8', 'subs', 'subs-group');
		expect(p.setMediaInfo({
			textInfo: { codec: 'wvtt' },
			referenceTimeScale: 1000,
		})).toBe(true);
		expect(p.getStreamType()).toBe('subtitle');
		expect(p.getCodec()).toBe('wvtt');
	});

	test('SetMediaInfo accepts video info and adjusts codec', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		expect(p.setMediaInfo(videoMediaInfo({
			videoInfo: { codec: 'avc3.640028', width: 1920, height: 1080, timeScale: TIME_SCALE },
		}))).toBe(true);
		expect(p.getStreamType()).toBe('video');
		// avc3 → avc1 per shaka's AdjustVideoCodec.
		expect(p.getCodec()).toBe('avc1.640028');
	});

	test('Display resolution applies pixel aspect ratio', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			videoInfo: {
				codec: 'avc1.640028',
				width: 1920,
				height: 818,
				timeScale: TIME_SCALE,
				pixelWidth: 16,
				pixelHeight: 15,
			},
		}));
		const r = p.getDisplayResolution()!;
		expect(r.height).toBe(818);
		// 1920 * (16/15) = 2048; shaka rounds the same way.
		expect(r.width).toBe(2048);
	});

	test('Empty playlist renders header + endlist', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo());
		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ '## Generated with https://github.com/shaka-project/shaka-packager version test\n'
			+ '#EXT-X-TARGETDURATION:0\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	test('Multi-segment playlist with explicit target duration', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({
			...videoMediaInfo(),
			segmentTemplateUrl: 'segment-$Number$.m4s',
		});
		p.addSegment('segment-1.m4s', 0, 10 * TIME_SCALE, 0, 0);
		p.addSegment('segment-2.m4s', 10 * TIME_SCALE, 10 * TIME_SCALE, 0, 0);
		p.setTargetDuration(10);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ '## Generated with https://github.com/shaka-project/shaka-packager version test\n'
			+ '#EXT-X-TARGETDURATION:10\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXTINF:10.000,\n'
			+ 'segment-1.m4s\n'
			+ '#EXTINF:10.000,\n'
			+ 'segment-2.m4s\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});
});

describe('MediaPlaylist — single-segment byterange', () => {
	test('InitRange emits #EXT-X-MAP with BYTERANGE', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			mediaFileUrl: 'file.mp4',
			initRange: { begin: 0, end: 500 },
		}));

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ '## Generated with https://github.com/shaka-project/shaka-packager version test\n'
			+ '#EXT-X-TARGETDURATION:0\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-MAP:URI="file.mp4",BYTERANGE="501@0"\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	test('InitRange with non-zero offset', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			mediaFileUrl: 'file.mp4',
			initRange: { begin: 16, end: 500 },
		}));

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ '## Generated with https://github.com/shaka-project/shaka-packager version test\n'
			+ '#EXT-X-TARGETDURATION:0\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-MAP:URI="file.mp4",BYTERANGE="485@16"\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	test('AddSegment with byterange — non-contiguous then contiguous', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			mediaFileUrl: 'file.mp4',
			initRange: { begin: 0, end: 500 },
		}));
		// First segment: starts at offset 1000, not 501 (gap = sidx box). Offset emitted.
		p.addSegment('file.mp4', 0, 10 * TIME_SCALE, 1000, 1 * MBYTES);
		// Second segment: contiguous with previous. Offset omitted.
		p.addSegment('file.mp4', 10 * TIME_SCALE, 10 * TIME_SCALE, 1001000, 2 * MBYTES);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ '## Generated with https://github.com/shaka-project/shaka-packager version test\n'
			+ '#EXT-X-TARGETDURATION:10\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-MAP:URI="file.mp4",BYTERANGE="501@0"\n'
			+ '#EXTINF:10.000,\n'
			+ '#EXT-X-BYTERANGE:1000000@1000\n'
			+ 'file.mp4\n'
			+ '#EXTINF:10.000,\n'
			+ '#EXT-X-BYTERANGE:2000000\n'
			+ 'file.mp4\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});
});

describe('MediaPlaylist — playlist types', () => {
	test('EVENT playlist omits #EXT-X-ENDLIST', () => {
		const p = new MediaPlaylist(
			{ playlistType: 'event', ...generatorBanner() },
			'media.m3u8',
			'video',
			'group',
		);
		p.setMediaInfo(videoMediaInfo());
		const out = p.build();
		expect(out).toContain('#EXT-X-PLAYLIST-TYPE:EVENT\n');
		expect(out).not.toContain('#EXT-X-ENDLIST');
	});

	test('EVENT promoted to VOD when end-stream + eventToVodOnEnd', () => {
		const p = new MediaPlaylist(
			{ playlistType: 'event', ...generatorBanner() },
			'media.m3u8',
			'video',
			'group',
		);
		p.setMediaInfo(videoMediaInfo());
		const out = p.build({ eventToVodOnEnd: true, endStream: true });
		expect(out).toContain('#EXT-X-PLAYLIST-TYPE:VOD\n');
		expect(out).toContain('#EXT-X-ENDLIST\n');
	});

	test('LIVE playlist with media-sequence and discontinuity-sequence', () => {
		const p = new MediaPlaylist(
			{ playlistType: 'live', mediaSequenceNumber: 12, discontinuitySequenceNumber: 3 },
			'media.m3u8',
			'video',
			'group',
		);
		p.setMediaInfo({ ...videoMediaInfo(), segmentTemplateUrl: 'seg-$Number$.m4s' });
		p.addSegment('seg-12.m4s', 0, 6 * TIME_SCALE, 0, 0);
		p.setTargetDuration(6);
		const out = p.build();
		expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:12\n');
		expect(out).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:3\n');
		// Live playlists omit ENDLIST and PLAYLIST-TYPE.
		expect(out).not.toContain('#EXT-X-ENDLIST');
		expect(out).not.toContain('#EXT-X-PLAYLIST-TYPE');
		// Forced media sequence > 0 inserts a discontinuity at the top.
		expect(out).toContain('#EXT-X-DISCONTINUITY\n#EXTINF:6.000,\nseg-12.m4s\n');
	});
});
