/* eslint-disable @stylistic/max-len */
/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { MediaPlaylist } from '../../src/hls/hls-media-playlist.js';
import type { HlsMediaInfo, HlsParams } from '../../src/hls/hls-types.js';

const TIME_SCALE = 90_000;
const MBYTES = 1_000_000;
const SHAKA_BANNER = '## Generated with https://github.com/shaka-project/shaka-packager version test';

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

describe('MediaPlaylist — encryption (DRM)', () => {
	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, WriteToFileWithEncryptionInfo)
	test('SAMPLE-AES with IV + KEYFORMATVERSIONS + KEYFORMAT', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addEncryptionInfo({
			method: 'SAMPLE-AES',
			url: 'http://example.com',
			iv: '0x12345678',
			keyFormat: 'com.widevine',
			keyFormatVersions: '1/2/4',
		});
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:30\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://example.com",IV=0x12345678,KEYFORMATVERSIONS="1/2/4",KEYFORMAT="com.widevine"\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXTINF:30.000,\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, WriteToFileWithEncryptionInfoEmptyIv)
	test('SAMPLE-AES with KEYFORMAT only (no IV, no versions)', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addEncryptionInfo({
			method: 'SAMPLE-AES',
			url: 'http://example.com',
			keyFormat: 'com.widevine',
		});
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:30\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://example.com",KEYFORMAT="com.widevine"\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXTINF:30.000,\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, WriteToFileWithClearLead)
	test('inserts EXT-X-DISCONTINUITY before the first key when there is clear lead', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);
		p.addEncryptionInfo({
			method: 'SAMPLE-AES',
			url: 'http://example.com',
			iv: '0x12345678',
			keyFormat: 'com.widevine',
			keyFormatVersions: '1/2/4',
		});
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:30\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXT-X-DISCONTINUITY\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://example.com",IV=0x12345678,KEYFORMATVERSIONS="1/2/4",KEYFORMAT="com.widevine"\n'
			+ '#EXTINF:30.000,\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, SampleAesCenc)
	test('SAMPLE-AES-CTR method', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addEncryptionInfo({
			method: 'SAMPLE-AES-CTR',
			url: 'http://example.com',
			iv: '0x12345678',
			keyFormat: 'com.widevine',
			keyFormatVersions: '1/2/4',
		});
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:30\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="http://example.com",IV=0x12345678,KEYFORMATVERSIONS="1/2/4",KEYFORMAT="com.widevine"\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXTINF:30.000,\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, MultipleEncryptionInfo)
	test('multiple keys at the start emit consecutive #EXT-X-KEY lines (no discontinuity between them)', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({ ...videoMediaInfo(), segmentTemplateUrl: '$Number$.ts' });
		p.addEncryptionInfo({
			method: 'SAMPLE-AES',
			url: 'http://example.com',
			iv: '0x12345678',
			keyFormat: 'com.widevine',
			keyFormatVersions: '1/2/4',
		});
		p.addEncryptionInfo({
			method: 'SAMPLE-AES',
			url: 'http://mydomain.com',
			keyId: '0xfedc',
			iv: '0x12345678',
			keyFormat: 'com.widevine.someother',
			keyFormatVersions: '1',
		});
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:30\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://example.com",IV=0x12345678,KEYFORMATVERSIONS="1/2/4",KEYFORMAT="com.widevine"\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://mydomain.com",KEYID=0xfedc,IV=0x12345678,KEYFORMATVERSIONS="1",KEYFORMAT="com.widevine.someother"\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXTINF:30.000,\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});
});

describe('MediaPlaylist — placement opportunity & program date time', () => {
	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, WriteToFileWithSegmentsAndPlacementOpportunity)
	test('emits #EXT-X-PLACEMENT-OPPORTUNITY between segments', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);
		p.addPlacementOpportunity();
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:30\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXT-X-PLACEMENT-OPPORTUNITY\n'
			+ '#EXTINF:30.000,\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, ProgramDateTime)
	test('emits #EXT-X-PROGRAM-DATE-TIME before the first segment when reference time is set', () => {
		const p = new MediaPlaylist({
			...vodParams(),
			addProgramDateTime: true,
		}, 'media.m3u8', 'video', 'group');
		p.setReferenceTime(Date.UTC(2025, 9, 12, 14, 0, 0, 0));
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, 1_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:10\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-PROGRAM-DATE-TIME:2025-10-12T14:00:00.000Z\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(MediaPlaylistMultiSegmentTest, ProgramDateTimeWithDiscontinuity)
	test('emits PDT after every discontinuity (clear-lead → encrypted)', () => {
		const p = new MediaPlaylist({
			...vodParams(),
			addProgramDateTime: true,
		}, 'media.m3u8', 'video', 'group');
		p.setReferenceTime(Date.UTC(2025, 9, 12, 14, 0, 0, 0));
		p.setMediaInfo({ ...videoMediaInfo(), referenceTimeScale: TIME_SCALE, segmentTemplateUrl: '$Number$.ts' });
		p.addSegment('file1.ts', 10 * TIME_SCALE, 10 * TIME_SCALE, 0, 1_000_000);
		// addEncryptionInfo inserts a discontinuity since there is clear-lead.
		p.addEncryptionInfo({ method: 'SAMPLE-AES', url: 'http://example.com' });
		p.addSegment('file2.ts', 25 * TIME_SCALE, 10 * TIME_SCALE, 0, 1_000_000);
		p.addSegment('file3.ts', 25 * TIME_SCALE, 10 * TIME_SCALE, 0, 1_000_000);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:10\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-PROGRAM-DATE-TIME:2025-10-12T14:00:10.000Z\n'
			+ '#EXTINF:10.000,\n'
			+ 'file1.ts\n'
			+ '#EXT-X-DISCONTINUITY\n'
			+ '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://example.com"\n'
			+ '#EXT-X-PROGRAM-DATE-TIME:2025-10-12T14:00:25.000Z\n'
			+ '#EXTINF:10.000,\n'
			+ 'file2.ts\n'
			+ '#EXTINF:10.000,\n'
			+ 'file3.ts\n'
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

describe('MediaPlaylist — I-frame-only', () => {
	// shaka: TEST_F(IFrameMediaPlaylistTest, MediaPlaylistType)
	test('AddKeyFrame promotes stream type to videoIFramesOnly', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo());
		expect(p.getStreamType()).toBe('video');
		p.addKeyFrame(0, 1000, 2345);
		// Stream type flips to I-frame only after the first AddKeyFrame.
		expect(p.getStreamType()).toBe('videoIFramesOnly');
	});

	// shaka: TEST_F(IFrameMediaPlaylistTest, SingleSegment)
	test('SingleSegment — keyframes flushed by enclosing AddSegment with byterange', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			mediaFileUrl: 'file.mp4',
			initRange: { begin: 0, end: 500 },
		}));
		p.addKeyFrame(0, 1000, 2345);
		p.addKeyFrame(2 * TIME_SCALE, 5000, 6345);
		p.addSegment('file.mp4', 0, 10 * TIME_SCALE, 0, MBYTES);
		p.addKeyFrame(11 * TIME_SCALE, MBYTES + 1000, 2345);
		p.addKeyFrame(15 * TIME_SCALE, MBYTES + 3345, 12345);
		p.addSegment('file.mp4', 10 * TIME_SCALE, 10 * TIME_SCALE, 1001000, 2 * MBYTES);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:9\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-I-FRAMES-ONLY\n'
			+ '#EXT-X-MAP:URI="file.mp4",BYTERANGE="501@0"\n'
			+ '#EXTINF:2.000,\n'
			+ '#EXT-X-BYTERANGE:2345@1000\n'
			+ 'file.mp4\n'
			+ '#EXTINF:9.000,\n'
			+ '#EXT-X-BYTERANGE:6345@5000\n'
			+ 'file.mp4\n'
			+ '#EXTINF:4.000,\n'
			+ '#EXT-X-BYTERANGE:2345@1001000\n'
			+ 'file.mp4\n'
			+ '#EXTINF:5.000,\n'
			+ '#EXT-X-BYTERANGE:12345\n'
			+ 'file.mp4\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(IFrameMediaPlaylistTest, MultiSegment)
	test('MultiSegment — keyframes flushed across two media files', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			referenceTimeScale: TIME_SCALE,
			segmentTemplateUrl: 'file$Number$.ts',
		}));
		p.addKeyFrame(0, 1000, 2345);
		p.addKeyFrame(2 * TIME_SCALE, 5000, 6345);
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, MBYTES);
		p.addKeyFrame(11 * TIME_SCALE, 1000, 2345);
		p.addKeyFrame(15 * TIME_SCALE, 3345, 12345);
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5 * MBYTES);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:25\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-I-FRAMES-ONLY\n'
			+ '#EXTINF:2.000,\n'
			+ '#EXT-X-BYTERANGE:2345@1000\n'
			+ 'file1.ts\n'
			+ '#EXTINF:9.000,\n'
			+ '#EXT-X-BYTERANGE:6345@5000\n'
			+ 'file1.ts\n'
			+ '#EXTINF:4.000,\n'
			+ '#EXT-X-BYTERANGE:2345@1000\n'
			+ 'file2.ts\n'
			+ '#EXTINF:25.000,\n'
			+ '#EXT-X-BYTERANGE:12345\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});

	// shaka: TEST_F(IFrameMediaPlaylistTest, MultiSegmentWithPlacementOpportunity)
	test('MultiSegment with placement opportunity between segments', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			referenceTimeScale: TIME_SCALE,
			segmentTemplateUrl: 'file$Number$.ts',
		}));
		p.addKeyFrame(0, 1000, 2345);
		p.addKeyFrame(2 * TIME_SCALE, 5000, 6345);
		p.addSegment('file1.ts', 0, 10 * TIME_SCALE, 0, MBYTES);
		p.addPlacementOpportunity();
		p.addKeyFrame(11 * TIME_SCALE, 1000, 2345);
		p.addKeyFrame(15 * TIME_SCALE, 3345, 12345);
		p.addSegment('file2.ts', 10 * TIME_SCALE, 30 * TIME_SCALE, 0, 5 * MBYTES);

		expect(p.build({ endStream: true })).toBe(
			'#EXTM3U\n'
			+ '#EXT-X-VERSION:6\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-TARGETDURATION:25\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ '#EXT-X-I-FRAMES-ONLY\n'
			+ '#EXTINF:2.000,\n'
			+ '#EXT-X-BYTERANGE:2345@1000\n'
			+ 'file1.ts\n'
			+ '#EXTINF:9.000,\n'
			+ '#EXT-X-BYTERANGE:6345@5000\n'
			+ 'file1.ts\n'
			+ '#EXT-X-PLACEMENT-OPPORTUNITY\n'
			+ '#EXTINF:4.000,\n'
			+ '#EXT-X-BYTERANGE:2345@1000\n'
			+ 'file2.ts\n'
			+ '#EXTINF:25.000,\n'
			+ '#EXT-X-BYTERANGE:12345\n'
			+ 'file2.ts\n'
			+ '#EXT-X-ENDLIST\n',
		);
	});
});

describe('MediaPlaylist — VIDEO-RANGE', () => {
	// shaka: covered by GetVideoRange tests in media_playlist_unittest.cc transfer_characteristics ranges.
	test('returns "" when transferCharacteristics is unset', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo());
		expect(p.getVideoRange()).toBe('');
	});

	test('TC=1 (BT.709) → SDR', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			videoInfo: { codec: 'avc1.640028', width: 1920, height: 1080, timeScale: TIME_SCALE, transferCharacteristics: 1 },
		}));
		expect(p.getVideoRange()).toBe('SDR');
	});

	test('TC=16 (PQ) → PQ', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			videoInfo: { codec: 'hvc1.2.4.L150.B0', width: 3840, height: 2160, timeScale: TIME_SCALE, transferCharacteristics: 16 },
		}));
		expect(p.getVideoRange()).toBe('PQ');
	});

	test('TC=18 (HLG) → HLG', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			videoInfo: { codec: 'hvc1.2.4.L150.B0', width: 3840, height: 2160, timeScale: TIME_SCALE, transferCharacteristics: 18 },
		}));
		expect(p.getVideoRange()).toBe('HLG');
	});

	test('Dolby Vision (dvh1) → PQ regardless of transfer characteristics', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			videoInfo: { codec: 'dvh1.05.06', width: 3840, height: 2160, timeScale: TIME_SCALE },
		}));
		expect(p.getVideoRange()).toBe('PQ');
	});

	test('TC=14 with db4g compatible brand and supplemental codec → HLG (Dolby Vision profile 8.4)', () => {
		const p = new MediaPlaylist(vodParams(), 'media.m3u8', 'video', 'group');
		p.setMediaInfo(videoMediaInfo({
			videoInfo: {
				codec: 'hvc1.2.4.L150.B0',
				width: 3840,
				height: 2160,
				timeScale: TIME_SCALE,
				transferCharacteristics: 14,
				supplementalCodec: 'dvh1.08.07',
				compatibleBrand: 'db4g',
			},
		}));
		expect(p.getVideoRange()).toBe('HLG');
	});
});
