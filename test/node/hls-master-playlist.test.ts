/* eslint-disable @stylistic/max-len */
/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/master_playlist_unittest.cc
 * Last synced with shaka commit: b1580dd (2026-05-06).
 */
import { describe, expect, test } from 'vitest';
import { MasterPlaylist } from '../../src/hls/hls-master-playlist.js';
import { MediaPlaylist } from '../../src/hls/hls-media-playlist.js';
import type { HlsCeaCaption, HlsParams } from '../../src/hls/hls-types.js';

const TIME_SCALE = 90_000;
const SHAKA_BANNER = '## Generated with https://github.com/shaka-project/shaka-packager version test';

const masterOpts = (extra: Partial<{
	independentSegments: boolean;
	defaultAudioLanguage: string;
	defaultSubtitleLanguage: string;
	createSessionKeys: boolean;
}> = {}) => ({
	generatorBanner: SHAKA_BANNER,
	defaultAudioLanguage: 'en',
	defaultSubtitleLanguage: 'en',
	...extra,
});

const vodParams = (): HlsParams => ({ playlistType: 'vod' });

// shaka mocks AvgBitrate() to a fixed value; our MediaPlaylist.getAvgBitrate()
// instead derives from real segments via BandwidthEstimator. A single segment of
// `avgBitrate` bytes spanning 8s yields estimate() = ceil(avgBitrate * 8 / 8) =
// avgBitrate exactly, so AVERAGE-BANDWIDTH matches shaka verbatim. getMaxBitrate()
// still returns the caller-supplied MediaInfo.bandwidth, so BANDWIDTH is unaffected.
const AVG_SEGMENT_SECONDS = 8;
const emitAvgBitrate = (p: MediaPlaylist, avgBitrate: number): void => {
	p.addSegment('seg-0.m4s', 0, AVG_SEGMENT_SECONDS * TIME_SCALE, 0, avgBitrate);
};

const createVideoPlaylist = (opts: {
	fileName: string;
	codec: string;
	maxBitrate: number;
	avgBitrate: number;
	width?: number;
	height?: number;
	frameRate?: number;
	index?: number;
	emitAvgSegment?: boolean;
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
		index: opts.index,
	});
	if (opts.emitAvgSegment) {
		emitAvgBitrate(p, opts.avgBitrate);
	}
	return p;
};

const createIframePlaylist = (opts: {
	fileName: string;
	codec: string;
	maxBitrate: number;
	avgBitrate: number;
}): MediaPlaylist => {
	const p = createVideoPlaylist(opts);
	// One AddKeyFrame promotes the playlist to videoIFramesOnly.
	p.addKeyFrame(0, 0, 1000);
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
	characteristics?: string[];
	index?: number;
	emitAvgSegment?: boolean;
	ec3JocComplexity?: number;
	ac4ImsFlag?: boolean;
	ac4CbiFlag?: boolean;
}): MediaPlaylist => {
	const p = new MediaPlaylist(vodParams(), opts.fileName, opts.name, opts.groupId);
	const codecSpecificData = opts.ec3JocComplexity !== undefined
		|| opts.ac4ImsFlag !== undefined
		|| opts.ac4CbiFlag !== undefined
		? {
				ec3JocComplexity: opts.ec3JocComplexity,
				ac4ImsFlag: opts.ac4ImsFlag,
				ac4CbiFlag: opts.ac4CbiFlag,
			}
		: undefined;
	p.setMediaInfo({
		audioInfo: {
			codec: opts.codec,
			timeScale: TIME_SCALE,
			numChannels: opts.channels,
			language: opts.language,
			codecSpecificData,
		},
		bandwidth: opts.maxBitrate,
		containerType: 'mp4',
		hlsCharacteristics: opts.characteristics,
		index: opts.index,
	});
	if (opts.emitAvgSegment) {
		emitAvgBitrate(p, opts.avgBitrate);
	}
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

describe('MasterPlaylist — encryption / session keys', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistWithEncryption)
	test('emits #EXT-X-SESSION-KEY collected from media playlists when createSessionKeys', () => {
		const m = new MasterPlaylist(masterOpts({ createSessionKeys: true }));
		const video = createVideoPlaylist({
			fileName: 'video-1.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
		});
		const audio = createAudioPlaylist({
			fileName: 'audio-1.m3u8',
			name: 'audio 1',
			groupId: 'audio-group-1',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		});
		const encInfo = {
			method: 'SAMPLE-AES' as const,
			url: 'http://example.com',
			iv: '0x12345678',
			keyFormat: 'com.widevine',
			keyFormatVersions: '1/2/4',
		};
		video.addEncryptionInfo(encInfo);
		audio.addEncryptionInfo(encInfo);
		m.addPlaylist(video);
		m.addPlaylist(audio);

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="http://example.com",'
			+ 'IV=0x12345678,KEYFORMATVERSIONS="1/2/4",KEYFORMAT="com.widevine"\n'
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-1.m3u8",'
			+ 'GROUP-ID="audio-group-1",LANGUAGE="en",NAME="audio 1",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=350000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec,audiocodec",RESOLUTION=800x600,'
			+ 'AUDIO="audio-group-1",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/video-1.m3u8\n',
		);
	});

	test('deduplicates identical session keys across playlists', () => {
		const m = new MasterPlaylist(masterOpts({ createSessionKeys: true }));
		const v1 = createVideoPlaylist({ fileName: 'v1.m3u8', codec: 'avc1', maxBitrate: 100000, avgBitrate: 100000 });
		const v2 = createVideoPlaylist({ fileName: 'v2.m3u8', codec: 'avc1', maxBitrate: 200000, avgBitrate: 200000 });
		const enc = { method: 'SAMPLE-AES' as const, url: 'http://example.com', iv: '0xabc', keyFormat: 'k', keyFormatVersions: 'v' };
		v1.addEncryptionInfo(enc);
		v2.addEncryptionInfo(enc);
		m.addPlaylist(v1);
		m.addPlaylist(v2);

		const out = m.build({ baseUrl: '' });
		// Only one SESSION-KEY line despite two playlists carrying the same key.
		expect(out.match(/#EXT-X-SESSION-KEY:/g)?.length).toBe(1);
	});
});

describe('MasterPlaylist — I-frame stream', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistOneIframePlaylist)
	test('emits #EXT-X-I-FRAME-STREAM-INF with URI attribute (no FRAME-RATE)', () => {
		const m = new MasterPlaylist(masterOpts());
		const video = createVideoPlaylist({
			fileName: 'media1.m3u8',
			codec: 'avc1',
			maxBitrate: 435889,
			avgBitrate: 235889,
		});
		// One AddKeyFrame promotes the playlist to videoIFramesOnly.
		video.addKeyFrame(0, 0, 1000);
		m.addPlaylist(video);

		expect(m.build({ baseUrl: 'http://myplaylistdomain.com/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=435889,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="avc1",RESOLUTION=800x600,'
			+ 'URI="http://myplaylistdomain.com/media1.m3u8"\n',
		);
	});
});

describe('MasterPlaylist — VIDEO-RANGE', () => {
	test('emits VIDEO-RANGE=PQ for HDR (PQ transfer) variant', () => {
		const m = new MasterPlaylist(masterOpts());
		const p = new MediaPlaylist(vodParams(), 'hdr.m3u8', '', '');
		p.setMediaInfo({
			videoInfo: {
				codec: 'hvc1.2.4.L150.B0',
				width: 3840,
				height: 2160,
				timeScale: TIME_SCALE,
				transferCharacteristics: 16,
			},
			bandwidth: 8000000,
			containerType: 'mp4',
		});
		m.addPlaylist(p);

		const out = m.build({ baseUrl: '' });
		expect(out).toContain('RESOLUTION=3840x2160,VIDEO-RANGE=PQ,CLOSED-CAPTIONS=NONE');
	});

	test('emits VIDEO-RANGE=SDR for BT.709 variant', () => {
		const m = new MasterPlaylist(masterOpts());
		const p = new MediaPlaylist(vodParams(), 'sdr.m3u8', '', '');
		p.setMediaInfo({
			videoInfo: {
				codec: 'avc1.640028',
				width: 1920,
				height: 1080,
				timeScale: TIME_SCALE,
				transferCharacteristics: 1,
			},
			bandwidth: 3000000,
			containerType: 'mp4',
		});
		m.addPlaylist(p);

		const out = m.build({ baseUrl: '' });
		expect(out).toContain('RESOLUTION=1920x1080,VIDEO-RANGE=SDR,CLOSED-CAPTIONS=NONE');
	});

	test('omits VIDEO-RANGE when transferCharacteristics is unset', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'v.m3u8',
			codec: 'avc1',
			maxBitrate: 1000,
			avgBitrate: 1000,
		}));

		const out = m.build({ baseUrl: '' });
		expect(out).not.toContain('VIDEO-RANGE');
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

const createTextPlaylist = (opts: {
	fileName: string;
	name: string;
	groupId: string;
	codec: string;
	language: string;
	characteristics?: string[];
	forcedSubtitle?: boolean;
	index?: number;
}): MediaPlaylist => {
	const p = new MediaPlaylist(vodParams(), opts.fileName, opts.name, opts.groupId);
	p.setMediaInfo({
		textInfo: { codec: opts.codec, language: opts.language },
		containerType: 'text',
		referenceTimeScale: TIME_SCALE,
		hlsCharacteristics: opts.characteristics,
		forcedSubtitle: opts.forcedSubtitle,
		index: opts.index,
	});
	return p;
};

describe('MasterPlaylist — multiple audio groups', () => {
	test('emits one variant per audio group', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video-1.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng.m3u8',
			name: 'english',
			groupId: 'audio-en',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'fra.m3u8',
			name: 'french',
			groupId: 'audio-fr',
			codec: 'audiocodec',
			language: 'fr',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));

		const out = m.build({ baseUrl: '' });
		expect(out.match(/AUDIO="audio-en"/g)?.length).toBe(1);
		expect(out.match(/AUDIO="audio-fr"/g)?.length).toBe(1);
		expect(out.match(/#EXT-X-STREAM-INF:/g)?.length).toBe(2);
	});
});

describe('MasterPlaylist — sorted group codecs', () => {
	// Targeted addition (no single shaka unittest isolates >1 codec per group;
	// shaka's groups are typically single-codec). shaka's GetGroupCodecString
	// returns a std::set, so codecs within a group are alphabetically sorted.
	// Insert 'zcodec' before 'acodec' to prove the output is re-sorted, not left
	// in insertion order.
	test('codecs within one audio group are emitted alphabetically in CODECS', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video.m3u8',
			codec: 'videocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'z.m3u8',
			name: 'z',
			groupId: 'audio',
			codec: 'zcodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'a.m3u8',
			name: 'a',
			groupId: 'audio',
			codec: 'acodec',
			language: 'fr',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));

		const out = m.build({ baseUrl: '' });
		// Playlist codec first, then the group's audio codecs sorted alphabetically.
		expect(out).toContain('CODECS="videocodec,acodec,zcodec"');
	});
});

describe('MasterPlaylist — videos + texts', () => {
	test('emits SUBTITLES group reference on each variant', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'sd.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'eng.m3u8',
			name: 'english subs',
			groupId: 'text-group',
			codec: 'wvtt',
			language: 'en',
		}));

		const out = m.build({ baseUrl: '' });
		expect(out).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES');
		expect(out).toMatch(/SUBTITLES="text-group"/);
	});
});

describe('MasterPlaylist — video + audio + text', () => {
	test('cartesian variant matrix over audio × subtitle groups', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-en.m3u8',
			name: 'english',
			groupId: 'audio-en',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-fr.m3u8',
			name: 'french',
			groupId: 'audio-fr',
			codec: 'audiocodec',
			language: 'fr',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'sub-en.m3u8',
			name: 'sub-en',
			groupId: 'text-en',
			codec: 'wvtt',
			language: 'en',
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'sub-fr.m3u8',
			name: 'sub-fr',
			groupId: 'text-fr',
			codec: 'wvtt',
			language: 'fr',
		}));

		const out = m.build({ baseUrl: '' });
		// 2 audio groups × 2 subtitle groups = 4 variant rows.
		expect(out.match(/#EXT-X-STREAM-INF:/g)?.length).toBe(4);
		expect(out).toMatch(/AUDIO="audio-en".*SUBTITLES="text-en"/);
		expect(out).toMatch(/AUDIO="audio-en".*SUBTITLES="text-fr"/);
		expect(out).toMatch(/AUDIO="audio-fr".*SUBTITLES="text-en"/);
		expect(out).toMatch(/AUDIO="audio-fr".*SUBTITLES="text-fr"/);
	});
});

describe('MasterPlaylist — input order', () => {
	// shaka commit b1580dd: emit #EXT-X-MEDIA tags in command-line order. In shaka
	// this is realized through the per-stream index (--force_cl_index), so setting
	// indices that follow input order makes the tags interleave two audio groups
	// in that order rather than group_id order.
	test('interleaved audio groups are emitted in index (input) order', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
			index: 0,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'a-en.m3u8',
			name: 'a-en',
			groupId: 'audio-a',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			index: 1,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'b-en.m3u8',
			name: 'b-en',
			groupId: 'audio-b',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			index: 2,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'a-fr.m3u8',
			name: 'a-fr',
			groupId: 'audio-a',
			codec: 'audiocodec',
			language: 'fr',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			index: 3,
		}));

		const out = m.build({ baseUrl: '' });
		const aEn = out.indexOf('a-en.m3u8');
		const bEn = out.indexOf('b-en.m3u8');
		const aFr = out.indexOf('a-fr.m3u8');
		expect(aEn).toBeGreaterThan(-1);
		expect(bEn).toBeGreaterThan(-1);
		expect(aFr).toBeGreaterThan(-1);
		expect(aEn).toBeLessThan(bEn);
		expect(bEn).toBeLessThan(aFr);
	});
});

describe('MasterPlaylist — characteristics + forced subtitle', () => {
	test('CHARACTERISTICS attribute rendered on subtitle media tag', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'v.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 't.m3u8',
			name: 't',
			groupId: 'text-group',
			codec: 'wvtt',
			language: 'en',
			characteristics: ['public.accessibility.transcribes-spoken-dialog'],
		}));

		expect(m.build({ baseUrl: '' })).toMatch(
			/CHARACTERISTICS="public\.accessibility\.transcribes-spoken-dialog"/,
		);
	});

	test('forced subtitle gets FORCED=YES', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'v.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'forced.m3u8',
			name: 'forced',
			groupId: 'text-group',
			codec: 'wvtt',
			language: 'en',
			forcedSubtitle: true,
		}));

		expect(m.build({ baseUrl: '' })).toMatch(/FORCED=YES/);
	});
});

describe('MasterPlaylist — same audio group, same language', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistSameAudioGroupSameLanguage)
	// A group MUST NOT have more than one DEFAULT=YES member: only the first
	// rendition per (group, language) gets DEFAULT=YES,AUTOSELECT=YES; the second
	// same-(group, language) rendition gets DEFAULT=NO and NO AUTOSELECT.
	test('only the first en rendition gets DEFAULT/AUTOSELECT', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video.m3u8',
			codec: 'videocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng_lo.m3u8',
			name: 'english',
			groupId: 'audio',
			codec: 'audiocodec',
			language: 'en',
			channels: 1,
			maxBitrate: 50000,
			avgBitrate: 40000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng_hi.m3u8',
			name: 'english',
			groupId: 'audio',
			codec: 'audiocodec',
			language: 'en',
			channels: 8,
			maxBitrate: 100000,
			avgBitrate: 80000,
		}));

		expect(m.build({ baseUrl: 'http://anydomain.com/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://anydomain.com/eng_lo.m3u8",'
			+ 'GROUP-ID="audio",LANGUAGE="en",NAME="english",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="1"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://anydomain.com/eng_hi.m3u8",'
			+ 'GROUP-ID="audio",LANGUAGE="en",NAME="english",DEFAULT=NO,'
			+ 'CHANNELS="8"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=400000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="videocodec,audiocodec",RESOLUTION=800x600,AUDIO="audio",'
			+ 'CLOSED-CAPTIONS=NONE\n'
			+ 'http://anydomain.com/video.m3u8\n',
		);
	});
});

describe('MasterPlaylist — DVS audio', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistVideoAndDvsAudio)
	// A DVS rendition is AUTOSELECT=YES but never DEFAULT, and does not consume
	// the per-language default slot, so the following normal en rendition is
	// still DEFAULT=YES.
	test('DVS rendition gets AUTOSELECT=YES but not DEFAULT', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'sd.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'dvs_eng.m3u8',
			name: 'DVS english',
			groupId: 'audiogroup',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			characteristics: ['public.accessibility.describes-video'],
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng.m3u8',
			name: 'english',
			groupId: 'audiogroup',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/dvs_eng.m3u8",'
			+ 'GROUP-ID="audiogroup",LANGUAGE="en",NAME="DVS english",DEFAULT=NO,'
			+ 'AUTOSELECT=YES,CHARACTERISTICS="public.accessibility.describes-video",'
			+ 'CHANNELS="2"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/eng.m3u8",'
			+ 'GROUP-ID="audiogroup",LANGUAGE="en",NAME="english",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=350000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec,audiocodec",RESOLUTION=800x600,'
			+ 'AUDIO="audiogroup",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/sd.m3u8\n',
		);
	});
});

describe('MasterPlaylist — closed captions', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistWithClosedCaptions)
	// Registered CEA captions render #EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS tags (all
	// in the "CC" group) and flip the variant's CLOSED-CAPTIONS from NONE to "CC".
	test('emits CLOSED-CAPTIONS media tags and references the CC group on the variant', () => {
		const closedCaptions: HlsCeaCaption[] = [
			{ name: 'fr', language: 'fre', channel: 'CC1', isDefault: true, autoselect: true },
			{ name: 'en', language: 'eng', channel: 'CC2', isDefault: false, autoselect: true },
		];
		const m = new MasterPlaylist({ ...masterOpts(), closedCaptions });
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
			+ '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="CC",NAME="fr",'
			+ 'LANGUAGE="fre",DEFAULT=YES,AUTOSELECT=YES,INSTREAM-ID="CC1"\n'
			+ '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="CC",NAME="en",'
			+ 'LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,INSTREAM-ID="CC2"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=435889,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="avc1",RESOLUTION=800x600,CLOSED-CAPTIONS="CC"\n'
			+ 'http://myplaylistdomain.com/media1.m3u8\n',
		);
	});
});

describe('MasterPlaylist — index sort', () => {
	// shaka: TEST_F(MasterPlaylistTest,
	//   WriteMasterPlaylistSameAudioGroupSameLanguageOutOfOrderInput)
	// When every playlist has an index, renditions are emitted in index order.
	// Input order is [lo, hi] but index order is [hi, lo], so eng_hi is emitted
	// first and — being first per (group, language) — gets DEFAULT/AUTOSELECT.
	test('same audio group/language: out-of-order input emitted by index', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video.m3u8',
			codec: 'videocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
			index: 0,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng_lo.m3u8',
			name: 'english',
			groupId: 'audio',
			codec: 'audiocodec',
			language: 'en',
			channels: 1,
			maxBitrate: 50000,
			avgBitrate: 40000,
			index: 2,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'eng_hi.m3u8',
			name: 'english',
			groupId: 'audio',
			codec: 'audiocodec',
			language: 'en',
			channels: 8,
			maxBitrate: 100000,
			avgBitrate: 80000,
			index: 1,
		}));

		expect(m.build({ baseUrl: 'http://anydomain.com/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://anydomain.com/eng_hi.m3u8",'
			+ 'GROUP-ID="audio",LANGUAGE="en",NAME="english",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="8"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://anydomain.com/eng_lo.m3u8",'
			+ 'GROUP-ID="audio",LANGUAGE="en",NAME="english",DEFAULT=NO,'
			+ 'CHANNELS="1"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=400000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="videocodec,audiocodec",RESOLUTION=800x600,AUDIO="audio",'
			+ 'CLOSED-CAPTIONS=NONE\n'
			+ 'http://anydomain.com/video.m3u8\n',
		);
	});

	// shaka: TEST_F(MasterPlaylistTest,
	//   WriteMasterPlaylistTextsMultipleLanguagesOutOfOrderInput)
	// Input order is [en, fr] but index order is [fr, en]; fr is emitted first and
	// matches the default subtitle language, so it gets DEFAULT=YES.
	test('texts multiple languages: out-of-order input emitted by index', () => {
		const m = new MasterPlaylist(masterOpts({ defaultSubtitleLanguage: 'fr' }));
		m.addPlaylist(createVideoPlaylist({
			fileName: 'sd.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
			index: 0,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'en.m3u8',
			name: 'english',
			groupId: 'textgroup',
			codec: 'textcodec',
			language: 'en',
			index: 2,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'fr.m3u8',
			name: 'french',
			groupId: 'textgroup',
			codec: 'textcodec',
			language: 'fr',
			index: 1,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://playlists.org/fr.m3u8",'
			+ 'GROUP-ID="textgroup",LANGUAGE="fr",NAME="french",'
			+ 'DEFAULT=YES,AUTOSELECT=YES\n'
			+ '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://playlists.org/en.m3u8",'
			+ 'GROUP-ID="textgroup",LANGUAGE="en",NAME="english",'
			+ 'DEFAULT=NO,AUTOSELECT=YES\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec,textcodec",RESOLUTION=800x600,'
			+ 'SUBTITLES="textgroup",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/sd.m3u8\n',
		);
	});
});

describe('MasterPlaylist — group-id sort fallback', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistMixedPlaylistsDifferentGroups)
	// No playlist carries an index, so audio and subtitle renditions are ordered
	// by GROUP-ID (matching shaka's std::map), while video / I-frame stay in input
	// order. Full cartesian variant matrix over the two audio × two subtitle groups.
	test('mixed playlists across different groups sort audio/subtitle by group id', () => {
		const m = new MasterPlaylist(masterOpts({ defaultSubtitleLanguage: 'fr' }));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-1.m3u8',
			name: 'audio 1',
			groupId: 'audio-group-1',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-2.m3u8',
			name: 'audio 2',
			groupId: 'audio-group-2',
			codec: 'audiocodec',
			language: 'fr',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'text-1.m3u8',
			name: 'text 1',
			groupId: 'text-group-1',
			codec: 'textcodec',
			language: 'en',
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'text-2.m3u8',
			name: 'text 2',
			groupId: 'text-group-2',
			codec: 'textcodec',
			language: 'fr',
		}));
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video-1.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createVideoPlaylist({
			fileName: 'video-2.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 100000,
		}));
		m.addPlaylist(createIframePlaylist({
			fileName: 'iframe-1.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 100000,
			avgBitrate: 80000,
		}));
		m.addPlaylist(createIframePlaylist({
			fileName: 'iframe-2.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 100000,
			avgBitrate: 80000,
		}));

		const streamInf = (audio: string, subtitle: string, file: string): string =>
			'#EXT-X-STREAM-INF:BANDWIDTH=350000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec,audiocodec,textcodec",RESOLUTION=800x600,'
			+ `AUDIO="${audio}",SUBTITLES="${subtitle}",`
			+ 'CLOSED-CAPTIONS=NONE\n'
			+ `http://playlists.org/${file}\n`;

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-1.m3u8",'
			+ 'GROUP-ID="audio-group-1",LANGUAGE="en",NAME="audio 1",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-2.m3u8",'
			+ 'GROUP-ID="audio-group-2",LANGUAGE="fr",NAME="audio 2",'
			+ 'DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://playlists.org/text-1.m3u8",'
			+ 'GROUP-ID="text-group-1",LANGUAGE="en",NAME="text 1",'
			+ 'DEFAULT=NO,AUTOSELECT=YES\n'
			+ '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://playlists.org/text-2.m3u8",'
			+ 'GROUP-ID="text-group-2",LANGUAGE="fr",NAME="text 2",'
			+ 'DEFAULT=YES,AUTOSELECT=YES\n'
			+ '\n'
			+ streamInf('audio-group-1', 'text-group-1', 'video-1.m3u8')
			+ streamInf('audio-group-1', 'text-group-1', 'video-2.m3u8')
			+ '\n'
			+ streamInf('audio-group-1', 'text-group-2', 'video-1.m3u8')
			+ streamInf('audio-group-1', 'text-group-2', 'video-2.m3u8')
			+ '\n'
			+ streamInf('audio-group-2', 'text-group-1', 'video-1.m3u8')
			+ streamInf('audio-group-2', 'text-group-1', 'video-2.m3u8')
			+ '\n'
			+ streamInf('audio-group-2', 'text-group-2', 'video-1.m3u8')
			+ streamInf('audio-group-2', 'text-group-2', 'video-2.m3u8')
			+ '\n'
			+ '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec",RESOLUTION=800x600,'
			+ 'URI="http://playlists.org/iframe-1.m3u8"\n'
			+ '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,AVERAGE-BANDWIDTH=0,'
			+ 'CODECS="sdvideocodec",RESOLUTION=800x600,'
			+ 'URI="http://playlists.org/iframe-2.m3u8"\n',
		);
	});
});

describe('MasterPlaylist — audio-only full render', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistAudioOnly)
	// Two single-rendition audio groups, no video: each group emits its own
	// audio-only #EXT-X-STREAM-INF pointing at the group's playlist.
	test('two audio groups render one stream-inf each', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-1.m3u8',
			name: 'audio 1',
			groupId: 'audio-group-1',
			codec: 'audiocodec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			emitAvgSegment: true,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-2.m3u8',
			name: 'audio 2',
			groupId: 'audio-group-2',
			codec: 'audiocodec',
			language: 'fr',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			emitAvgSegment: true,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-1.m3u8",'
			+ 'GROUP-ID="audio-group-1",LANGUAGE="en",NAME="audio 1",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-2.m3u8",'
			+ 'GROUP-ID="audio-group-2",LANGUAGE="fr",NAME="audio 2",'
			+ 'DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audiocodec",AUDIO="audio-group-1",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-1.m3u8\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audiocodec",AUDIO="audio-group-2",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-2.m3u8\n',
		);
	});
});

describe('MasterPlaylist — Dolby channel signaling', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistAudioOnlyJOC)
	// EC-3 JOC complexity renders CHANNELS="<complexity>/JOC".
	test('EC-3 JOC complexity renders CHANNELS="16/JOC"', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-1.m3u8',
			name: 'audio 1',
			groupId: 'audio-group-1',
			codec: 'audiocodec',
			language: 'en',
			channels: 6,
			maxBitrate: 50000,
			avgBitrate: 30000,
			ec3JocComplexity: 0,
			emitAvgSegment: true,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-2.m3u8',
			name: 'audio 2',
			groupId: 'audio-group-2',
			codec: 'audiocodec',
			language: 'en',
			channels: 6,
			maxBitrate: 50000,
			avgBitrate: 30000,
			ec3JocComplexity: 16,
			emitAvgSegment: true,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-1.m3u8",'
			+ 'GROUP-ID="audio-group-1",LANGUAGE="en",NAME="audio 1",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-2.m3u8",'
			+ 'GROUP-ID="audio-group-2",LANGUAGE="en",NAME="audio 2",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="16/JOC"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audiocodec",AUDIO="audio-group-1",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-1.m3u8\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audiocodec",AUDIO="audio-group-2",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-2.m3u8\n',
		);
	});

	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistAudioOnlyAC4IMS)
	// AC-4 IMS flag renders CHANNELS="<channels>/IMSA".
	test('AC-4 IMS flag renders CHANNELS="2/IMSA"', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-1.m3u8',
			name: 'audio 1',
			groupId: 'audio-group-1',
			codec: 'audio1codec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			ac4ImsFlag: true,
			emitAvgSegment: true,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-2.m3u8',
			name: 'audio 2',
			groupId: 'audio-group-2',
			codec: 'audio2codec',
			language: 'en',
			channels: 2,
			maxBitrate: 50000,
			avgBitrate: 30000,
			ac4ImsFlag: false,
			emitAvgSegment: true,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-1.m3u8",'
			+ 'GROUP-ID="audio-group-1",LANGUAGE="en",NAME="audio 1",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2/IMSA"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-2.m3u8",'
			+ 'GROUP-ID="audio-group-2",LANGUAGE="en",NAME="audio 2",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audio1codec",AUDIO="audio-group-1",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-1.m3u8\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audio2codec",AUDIO="audio-group-2",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-2.m3u8\n',
		);
	});

	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistAudioOnlyAC4CBI)
	// AC-4 CBI flag renders CHANNELS="<channels>/IMSA".
	test('AC-4 CBI flag renders CHANNELS="8/IMSA"', () => {
		const m = new MasterPlaylist(masterOpts());
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-1.m3u8',
			name: 'audio 1',
			groupId: 'audio-group-1',
			codec: 'audiocodec',
			language: 'en',
			channels: 6,
			maxBitrate: 50000,
			avgBitrate: 30000,
			ac4CbiFlag: false,
			emitAvgSegment: true,
		}));
		m.addPlaylist(createAudioPlaylist({
			fileName: 'audio-2.m3u8',
			name: 'audio 2',
			groupId: 'audio-group-2',
			codec: 'audiocodec',
			language: 'en',
			channels: 8,
			maxBitrate: 50000,
			avgBitrate: 30000,
			ac4CbiFlag: true,
			emitAvgSegment: true,
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-1.m3u8",'
			+ 'GROUP-ID="audio-group-1",LANGUAGE="en",NAME="audio 1",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6"\n'
			+ '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://playlists.org/audio-2.m3u8",'
			+ 'GROUP-ID="audio-group-2",LANGUAGE="en",NAME="audio 2",'
			+ 'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="8/IMSA"\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audiocodec",AUDIO="audio-group-1",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-1.m3u8\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=50000,AVERAGE-BANDWIDTH=30000,'
			+ 'CODECS="audiocodec",AUDIO="audio-group-2",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/audio-2.m3u8\n',
		);
	});
});

describe('MasterPlaylist — video + multiple text groups', () => {
	// shaka: TEST_F(MasterPlaylistTest, WriteMasterPlaylistVideoAndTextGroups)
	// Two subtitle groups (no index) sort by group id and produce one variant
	// each over the single video, separated by a blank line.
	test('two text groups produce two subtitle variants', () => {
		const m = new MasterPlaylist(masterOpts({ defaultSubtitleLanguage: 'fr' }));
		m.addPlaylist(createVideoPlaylist({
			fileName: 'sd.m3u8',
			codec: 'sdvideocodec',
			maxBitrate: 300000,
			avgBitrate: 200000,
			emitAvgSegment: true,
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'eng.m3u8',
			name: 'english',
			groupId: 'en-text-group',
			codec: 'textcodec',
			language: 'en',
		}));
		m.addPlaylist(createTextPlaylist({
			fileName: 'fr.m3u8',
			name: 'french',
			groupId: 'fr-text-group',
			codec: 'textcodec',
			language: 'fr',
		}));

		expect(m.build({ baseUrl: 'http://playlists.org/' })).toBe(
			'#EXTM3U\n'
			+ `${SHAKA_BANNER}\n`
			+ '\n'
			+ '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://playlists.org/eng.m3u8",'
			+ 'GROUP-ID="en-text-group",LANGUAGE="en",NAME="english",'
			+ 'DEFAULT=NO,AUTOSELECT=YES\n'
			+ '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://playlists.org/fr.m3u8",'
			+ 'GROUP-ID="fr-text-group",LANGUAGE="fr",NAME="french",'
			+ 'DEFAULT=YES,AUTOSELECT=YES\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=200000,'
			+ 'CODECS="sdvideocodec,textcodec",RESOLUTION=800x600,'
			+ 'SUBTITLES="en-text-group",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/sd.m3u8\n'
			+ '\n'
			+ '#EXT-X-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=200000,'
			+ 'CODECS="sdvideocodec,textcodec",RESOLUTION=800x600,'
			+ 'SUBTITLES="fr-text-group",CLOSED-CAPTIONS=NONE\n'
			+ 'http://playlists.org/sd.m3u8\n',
		);
	});
});
