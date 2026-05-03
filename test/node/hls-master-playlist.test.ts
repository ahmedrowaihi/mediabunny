/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/master_playlist_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { MasterPlaylist } from '../../src/hls/hls-master-playlist.js';
import { MediaPlaylist } from '../../src/hls/hls-media-playlist.js';
import type { HlsParams } from '../../src/hls/hls-types.js';

const TIME_SCALE = 90_000;
const SHAKA_BANNER = '## Generated with https://github.com/shaka-project/shaka-packager version test';

const masterOpts = (extra: Partial<{
	independentSegments: boolean;
	defaultAudioLanguage: string;
	defaultSubtitleLanguage: string;
}> = {}) => ({
	generatorBanner: SHAKA_BANNER,
	defaultAudioLanguage: 'en',
	defaultSubtitleLanguage: 'en',
	...extra,
});

const vodParams = (): HlsParams => ({ playlistType: 'vod' });

const createVideoPlaylist = (opts: {
	fileName: string;
	codec: string;
	maxBitrate: number;
	avgBitrate: number;
	width?: number;
	height?: number;
	frameRate?: number;
}): MediaPlaylist => {
	const p = new MediaPlaylist(vodParams(), opts.fileName, '', '');
	const frameDuration = opts.frameRate ? Math.round(TIME_SCALE / opts.frameRate) : undefined;
	p.setMediaInfo({
		videoInfo: {
			codec: opts.codec,
			width: opts.width ?? 800,
			height: opts.height ?? 600,
			timeScale: TIME_SCALE,
			frameDuration,
		},
		bandwidth: opts.maxBitrate,
		containerType: 'mp4',
	});
	return p;
};

const createAudioPlaylist = (opts: {
	fileName: string;
	name: string;
	groupId: string;
	codec: string;
	language: string;
	channels: number;
	maxBitrate: number;
	avgBitrate: number;
}): MediaPlaylist => {
	const p = new MediaPlaylist(vodParams(), opts.fileName, opts.name, opts.groupId);
	p.setMediaInfo({
		audioInfo: {
			codec: opts.codec,
			timeScale: TIME_SCALE,
			numChannels: opts.channels,
			language: opts.language,
		},
		bandwidth: opts.maxBitrate,
		containerType: 'mp4',
	});
	return p;
};

describe('MasterPlaylist — single video', () => {
	test('emits one variant stream with CODECS, RESOLUTION, CLOSED-CAPTIONS=NONE', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'media1.m3u8',
			codec: 'avc1',
			maxBitrate: 435889,
			avgBitrate: 235889,
		}));

		expect(m.build({ baseUrl: 'http://myplaylistdomain.com/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=435889,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="avc1",RESOLUTION=800x600,CLOSED-CAPTIONS=NONE\n'
			+ 'http://myplaylistdomain.com/media1.m3u8\n',
		);
	});

	test('renders #EXT-X-INDEPENDENT-SEGMENTS when set', () => {
		const m = new MasterPlaylist(masterOpts({ independentSegments: true }));
		m.addPlaylist(createVideoPlaylist({
			fileName: 'media1.m3u8',
			codec: 'avc1',
			maxBitrate: 435889,
			avgBitrate: 235889,
		}));

		expect(m.build({ baseUrl: 'http://myplaylistdomain.com/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n#EXT-X-INDEPENDENT-SEGMENTS\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=435889,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="avc1",RESOLUTION=800x600,CLOSED-CAPTIONS=NONE\n'
			+ 'http://myplaylistdomain.com/media1.m3u8\n',
		);
	});

	test('emits FRAME-RATE=60.000 when frame duration is set', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'media1.m3u8',
			codec: 'avc1',
			maxBitrate: 435889,
			avgBitrate: 235889,
			frameRate: 60,
		}));

		expect(m.build({ baseUrl: 'http://myplaylistdomain.com/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=435889,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="avc1",RESOLUTION=800x600,FRAME-RATE=60.000,'
			+ 'CLOSED-CAPTIONS=NONE\n'
			+ 'http://myplaylistdomain.com/media1.m3u8\n',
		);
	});
});

describe('MasterPlaylist — video + audio', () => {
	test('emits #EXT-X-MEDIA tags + AUDIO group reference on streams', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'sd.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
		}));
		m.addPlaylist(createVideoPlaylist({
			fileName: 'hd.m3u8',
			codec: 'hdvideocodec',
			maxBitrate: 700000,
			avgBitrate: 400000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng.m3u8',
			name: 'english',
			groupId: 'audiogroup',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 40000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'spa.m3u8',
			name: 'espanol',
			groupId: 'audiogroup',
			codec: 'audiocodec',
			language: 'es',
			channels: 5,
			maxBitrate: 60000,
			avgBitrate: 30000,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/eng.m3u8",'
			+ 'GROUP-ID="audiogroup",LANGUAGE="en",NAME="english",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/spa.m3u8",'
			+ 'GROUP-ID="audiogroup",LANGUAGE="es",NAME="espanol",'
			+ 'DEFAULT=NO,AUTOSELECT=YES,CHANNELS="5"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=360000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec,audiocodec",'
			+ 'RESOLUTION=800x600,AUDIO="audiogroup",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/sd.m3u8\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=760000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="hdvideocodec,audiocodec",'
			+ 'RESOLUTION=800x600,AUDIO="audiogroup",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/hd.m3u8\n',
		);
	});
});

describe('MasterPlaylist — audio-only master', () => {
	test('emits stream-inf entries pointing at audio playlists when no video', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng.m3u8',
			name: 'english',
			groupId: 'audiogroup',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 40000,
		}));

		const out = m.build({ baseUrl: 'http://x/' });
		expect(out).toContain('#EXT-X-MEDIA:TYPE=AUDIO');
		expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="audiocodec",AUDIO="audiogroup",CLOSED-CAPTIONS=NONE');
		expect(out).toContain('http://x/eng.m3u8');
	});
});
