/* eslint-disable @stylistic/max-len */
import { describe, expect, test } from 'vitest';
import type { Mpd, MpdAdaptationSet, MpdRepresentation } from '../../src/dash/dash-mpd-parser.js';
import { FAIRPLAY_UUID, WIDEVINE_UUID } from '../../src/crypto/manifest-protection.js';
import { PLAYREADY_SYSTEM_ID } from '../../src/crypto/pssh.js';
import {
	capResolution,
	drm,
	dropByColorRange,
	dropCodecs,
	dropSubtitles,
	filterBitrate,
	filterChannels,
	filterFramerate,
	filterRenditions,
	keepCodecs,
	mapSegmentUrls,
	rebaseManifest,
	toSegmentTemplate,
} from '../../src/manifest-transforms.js';
import type { SegmentTemplate } from '../../src/dash/dash-mpd-parser.js';
import type { Manifest } from '../../src/manifest.js';
import { parseManifest, pipeManifest, serializeManifest } from '../../src/manifest.js';
import { hexStringToBytes } from '../../src/misc.js';

/** Minimal v0 `pssh` box: header + systemId + dataSize + data (data = the PlayReady Object for PR). */
const psshBox = (systemUuid: string, data: Uint8Array): Uint8Array => {
	const systemId = hexStringToBytes(systemUuid.replace(/-/g, ''));
	const box = new Uint8Array(32 + data.length);
	const view = new DataView(box.buffer);
	view.setUint32(0, box.length);
	box.set([0x70, 0x73, 0x73, 0x68], 4); // 'pssh', version+flags = 0
	box.set(systemId, 12);
	view.setUint32(28, data.length);
	box.set(data, 32);
	return box;
};

const rep = (id: string, codecs: string | null, over: Partial<MpdRepresentation> = {}): MpdRepresentation => ({
	id,
	bandwidth: 1_000_000,
	width: null,
	height: null,
	frameRate: null,
	codecs,
	mimeType: null,
	sar: null,
	audioSamplingRate: null,
	startWithSAP: null,
	labels: [],
	audioChannelConfigurations: [],
	supplementalProperties: [],
	essentialProperties: [],
	baseURLs: [],
	contentProtections: [],
	segmentTemplate: null,
	segmentList: null,
	segmentBase: null,
	...over,
});

const set = (over: Partial<MpdAdaptationSet>): MpdAdaptationSet => ({
	id: null,
	group: null,
	contentType: 'video',
	mimeType: null,
	codecs: null,
	lang: null,
	maxWidth: null,
	maxHeight: null,
	frameRate: null,
	roles: [],
	labels: [],
	audioChannelConfigurations: [],
	supplementalProperties: [],
	essentialProperties: [],
	baseURLs: [],
	contentProtections: [],
	segmentTemplate: null,
	segmentList: null,
	representations: [],
	...over,
});

const dashManifest = (sets: MpdAdaptationSet[], mpdBaseURLs: string[] = []): Manifest => {
	const mpd: Mpd = {
		type: 'static',
		profiles: [],
		mediaPresentationDuration: null,
		minimumUpdatePeriod: null,
		availabilityStartTime: null,
		publishTime: null,
		timeShiftBufferDepth: null,
		suggestedPresentationDelay: null,
		maxSegmentDuration: null,
		minBufferTime: null,
		baseURLs: mpdBaseURLs,
		utcTiming: [],
		periods: [{ id: 'p0', start: null, duration: null, baseURLs: [], adaptationSets: sets }],
	};
	return { format: 'dash', mpd };
};

const HLS_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="hvc1.1.6.L93.B0,mp4a.40.2",SUBTITLES="subs"
hevc/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"
avc/1080.m3u8
`;

const HLS_MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-0.m4s
#EXT-X-ENDLIST
`;

describe('manifest transforms', () => {
	describe('dropCodecs', () => {
		test('DASH: drops matching representations and prunes empty sets', () => {
			const manifest = dashManifest([
				set({ representations: [rep('v-hevc', 'hev1.1.6'), rep('v-avc', 'avc1.640028')] }),
				set({ id: 'hevc-only', representations: [rep('h0', 'hvc1.1.6')] }),
			]);
			const out = dropCodecs(['hev1', 'hvc1'])(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets).toHaveLength(1);
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations.map(r => r.id)).toEqual(['v-avc']);
		});

		test('DASH: representation inherits the set codec when its own is null', () => {
			const manifest = dashManifest([set({ codecs: 'hev1.1.6', representations: [rep('r0', null)] })]);
			const out = dropCodecs(['hev1'])(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets).toHaveLength(0);
		});

		test('HLS master: drops matching variants', () => {
			const out = dropCodecs(['hev1', 'hvc1'])(parseManifest(HLS_MASTER));
			if (out.format !== 'hls' || out.playlist.kind !== 'master') {
				throw new Error('expected hls master');
			}
			expect(out.playlist.variants).toHaveLength(1);
			expect(out.playlist.variants[0]!.codecs).toContain('avc1');
		});
	});

	describe('dropSubtitles', () => {
		test('DASH: drops text AdaptationSets', () => {
			const manifest = dashManifest([
				set({ contentType: 'video', representations: [rep('v', 'avc1.640028')] }),
				set({ contentType: 'text', representations: [rep('t', 'wvtt')] }),
			]);
			const out = dropSubtitles()(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets.map(s => s.contentType)).toEqual(['video']);
		});

		test('HLS master: removes SUBTITLES renditions and clears variant group refs', () => {
			const out = dropSubtitles()(parseManifest(HLS_MASTER));
			if (out.format !== 'hls' || out.playlist.kind !== 'master') {
				throw new Error('expected hls master');
			}
			expect(out.playlist.media).toHaveLength(0);
			expect(out.playlist.variants.every(v => v.subtitlesGroup === null)).toBe(true);
			expect(serializeManifest(out)).not.toContain('SUBTITLES');
		});
	});

	describe('rebaseManifest', () => {
		test('DASH: injects a BaseURL when none exists', () => {
			const manifest = dashManifest([set({ representations: [rep('r', 'avc1.640028')] })]);
			const out = rebaseManifest('https://cdn.example.com/vod/')(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.baseURLs).toEqual(['https://cdn.example.com/vod/']);
		});

		test('DASH: resolves an existing relative BaseURL against base', () => {
			const manifest = dashManifest([set({ representations: [rep('r', 'avc1.640028')] })], ['media/']);
			const out = rebaseManifest('https://cdn.example.com/vod/')(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.baseURLs).toEqual(['https://cdn.example.com/vod/media/']);
		});

		test('HLS media: resolves segment and map URIs, leaves opaque key URI untouched', () => {
			const out = rebaseManifest('https://cdn.example.com/hls/v0/')(parseManifest(HLS_MEDIA));
			if (out.format !== 'hls' || out.playlist.kind !== 'media') {
				throw new Error('expected hls media');
			}
			const segment = out.playlist.segments[0]!;
			expect(segment.uri).toBe('https://cdn.example.com/hls/v0/seg-0.m4s');
			expect(segment.map!.uri).toBe('https://cdn.example.com/hls/v0/init.mp4');
			expect(segment.keys[0]!.uri).toBe('skd://key-id');
		});

		test('DASH: preserves the nested BaseURL chain (mpd → set → rep)', () => {
			const manifest = dashManifest(
				[set({ baseURLs: ['set/'], representations: [{ ...rep('r', 'avc1.640028'), baseURLs: ['rep/'] }] })],
				['root/'],
			);
			const out = rebaseManifest('https://origin.example/live/manifest.mpd')(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.baseURLs).toEqual(['https://origin.example/live/root/']);
			expect(out.mpd.periods[0]!.adaptationSets[0]!.baseURLs).toEqual(['https://origin.example/live/root/set/']);
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations[0]!.baseURLs)
				.toEqual(['https://origin.example/live/root/set/rep/']);
		});

		test('DASH: an absolute ancestor BaseURL keeps children on its CDN', () => {
			const manifest = dashManifest(
				[set({ baseURLs: ['https://abs.cdn/set/'], representations: [{ ...rep('r', 'avc1.640028'), baseURLs: ['rep/'] }] })],
				['root/'],
			);
			const out = rebaseManifest('https://origin.example/live/manifest.mpd')(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations[0]!.baseURLs)
				.toEqual(['https://abs.cdn/set/rep/']);
		});
	});

	test('dropSubtitles: DASH drops a set marked only by Role=subtitle', () => {
		const manifest = dashManifest([
			set({ contentType: 'video', representations: [rep('v', 'avc1.640028')] }),
			set({
				contentType: null,
				roles: [{ schemeIdUri: 'urn:mpeg:dash:role:2011', value: 'subtitle' }],
				representations: [rep('t', 'wvtt')],
			}),
		]);
		const out = dropSubtitles()(manifest);
		if (out.format !== 'dash') {
			throw new Error('expected dash');
		}
		expect(out.mpd.periods[0]!.adaptationSets).toHaveLength(1);
		expect(out.mpd.periods[0]!.adaptationSets[0]!.contentType).toBe('video');
	});

	test('pipeManifest composes transforms on an HLS master', () => {
		const out = pipeManifest(parseManifest(HLS_MASTER), [
			dropCodecs(['hev1', 'hvc1']),
			dropSubtitles(),
			rebaseManifest('https://cdn.example.com/hls/'),
		]);
		const text = serializeManifest(out);
		expect(text).not.toContain('hvc1');
		expect(text).not.toContain('SUBTITLES');
		expect(text).toContain('https://cdn.example.com/hls/avc/1080.m3u8');
	});

	describe('purity + structural sharing', () => {
		test('the input manifest is never mutated', () => {
			const manifest = dashManifest([set({ representations: [rep('v-hevc', 'hev1.1.6'), rep('v-avc', 'avc1.640028')] })]);
			const before = JSON.stringify(manifest);
			const out = dropCodecs(['hev1'])(manifest);
			expect(JSON.stringify(manifest)).toBe(before); // original untouched
			expect(out).not.toBe(manifest); // a new manifest was produced
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations.map(r => r.id)).toEqual(['v-avc']);
		});

		test('untouched subtrees keep their reference (structural sharing)', () => {
			const audio = set({ id: 'a', contentType: 'audio', representations: [rep('a0', 'mp4a.40.2')] });
			const video = set({ id: 'v', representations: [rep('v-hevc', 'hev1.1.6'), rep('v-avc', 'avc1.640028')] });
			const manifest = dashManifest([audio, video]);
			const out = dropCodecs(['hev1'])(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			const sets = out.mpd.periods[0]!.adaptationSets;
			expect(sets[0]).toBe(audio); // audio set untouched → same reference
			expect(sets[1]).not.toBe(video); // video set was edited → new reference
		});

		test('a no-op transform returns the exact same manifest reference', () => {
			const manifest = dashManifest([set({ representations: [rep('v', 'avc1.640028')] })]);
			expect(dropCodecs(['hev1'])(manifest)).toBe(manifest); // nothing matched → identity
		});
	});

	describe('quality atoms', () => {
		test('keepCodecs keeps only listed codecs, retaining codec-less renditions', () => {
			const manifest = dashManifest([
				set({ representations: [rep('v-avc', 'avc1.640028'), rep('v-hevc', 'hev1.1.6')] }),
				set({ contentType: 'audio', representations: [rep('a-aac', 'mp4a.40.2'), rep('a-ac3', 'ac-3')] }),
			]);
			const out = keepCodecs(['avc1', 'mp4a'])(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			const ids = out.mpd.periods[0]!.adaptationSets.flatMap(s => s.representations.map(r => r.id));
			expect(ids).toEqual(['v-avc', 'a-aac']);
		});

		test('capResolution drops video above the height cap, keeps audio', () => {
			const manifest = dashManifest([
				set({ representations: [
					rep('sd', 'avc1', { width: 1280, height: 720 }),
					rep('hd', 'avc1', { width: 1920, height: 1080 }),
					rep('uhd', 'hev1', { width: 3840, height: 2160 }),
				] }),
				set({ contentType: 'audio', representations: [rep('a', 'mp4a')] }),
			]);
			const out = capResolution({ maxHeight: 1080 })(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			const ids = out.mpd.periods[0]!.adaptationSets.flatMap(s => s.representations.map(r => r.id));
			expect(ids).toEqual(['sd', 'hd', 'a']); // uhd dropped, audio kept
		});

		test('filterBitrate keeps renditions within the range', () => {
			const manifest = dashManifest([set({ representations: [
				rep('low', 'avc1', { bandwidth: 800_000 }),
				rep('mid', 'avc1', { bandwidth: 3_000_000 }),
				rep('high', 'avc1', { bandwidth: 12_000_000 }),
			] })]);
			const out = filterBitrate({ max: 9_000_000 })(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations.map(r => r.id)).toEqual(['low', 'mid']);
		});

		test('filterFramerate keeps renditions within the range', () => {
			const manifest = dashManifest([set({ representations: [
				rep('p25', 'avc1', { frameRate: { numerator: 25, denominator: 1 } }),
				rep('p30', 'avc1', { frameRate: { numerator: 30000, denominator: 1001 } }),
				rep('p60', 'avc1', { frameRate: { numerator: 60, denominator: 1 } }),
			] })]);
			const out = filterFramerate({ max: 30 })(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations.map(r => r.id)).toEqual(['p25', 'p30']);
		});

		test('filterChannels drops surround audio, keeps stereo and non-audio', () => {
			const mpeg = 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011';
			const manifest = dashManifest([
				set({ representations: [rep('video', 'avc1', { width: 1920, height: 1080 })] }),
				set({ contentType: 'audio', representations: [
					rep('stereo', 'mp4a.40.2', { audioChannelConfigurations: [{ schemeIdUri: mpeg, value: '2' }] }),
					rep('surround', 'ec-3', { audioChannelConfigurations: [{ schemeIdUri: mpeg, value: '6' }] }),
				] }),
			]);
			const out = filterChannels({ max: 2 })(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			const ids = out.mpd.periods[0]!.adaptationSets.flatMap(s => s.representations.map(r => r.id));
			expect(ids).toEqual(['video', 'stereo']); // surround dropped, video (null channels) kept
		});

		test('filterChannels (HLS) reaches audio media groups and prunes dangling variant refs', () => {
			const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="en",LANGUAGE="en",CHANNELS="2",URI="a/stereo.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="surround",NAME="en",LANGUAGE="en",CHANNELS="6",URI="a/surround.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,ec-3",AUDIO="surround"
v/hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="stereo"
v/lo.m3u8
`;
			const out = filterChannels({ max: 2 })(parseManifest(master));
			if (out.format !== 'hls' || out.playlist.kind !== 'master') {
				throw new Error('expected hls master');
			}
			// The 6-channel audio group is dropped (previously invisible to the filter); stereo survives.
			expect(out.playlist.media.map(m => m.groupId)).toEqual(['stereo']);
			// The variant that named the now-gone "surround" group has its audioGroup pruned; stereo kept.
			expect(out.playlist.variants.find(v => v.uri === 'v/hi.m3u8')?.audioGroup).toBe(null);
			expect(out.playlist.variants.find(v => v.uri === 'v/lo.m3u8')?.audioGroup).toBe('stereo');
		});

		test('filterChannels resolves CICP index and Dolby hex-mask schemes', () => {
			const cicp = 'urn:mpeg:mpegB:cicp:ChannelConfiguration';
			const dolby = 'tag:dolby.com,2014:dash:audio_channel_configuration:2011';
			const manifest = dashManifest([set({ contentType: 'audio', representations: [
				rep('cicp-71', 'ec-3', { audioChannelConfigurations: [{ schemeIdUri: cicp, value: '7' }] }), // 7.1 → 8
				rep('dolby-51', 'ec-3', { audioChannelConfigurations: [{ schemeIdUri: dolby, value: 'F801' }] }), // mask → 6
				rep('stereo', 'mp4a.40.2', { audioChannelConfigurations: [{ schemeIdUri: cicp, value: '2' }] }),
			] })]);
			const out = filterChannels({ max: 6 })(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations.map(r => r.id)).toEqual(['dolby-51', 'stereo']);
		});

		test('filterChannels keeps the AudioChannelConfiguration descriptor through serialization', () => {
			const mpeg = 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011';
			const manifest = dashManifest([set({ contentType: 'audio', representations: [
				rep('a-51', 'ec-3', { audioChannelConfigurations: [{ schemeIdUri: mpeg, value: '6' }] }),
				rep('a-stereo', 'mp4a.40.2', { audioChannelConfigurations: [{ schemeIdUri: mpeg, value: '2' }] }),
			] })]);
			const out = filterChannels({ max: 2 })(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.periods[0]!.adaptationSets[0]!.representations.map(r => r.id)).toEqual(['a-stereo']);
			// The surviving rendition's descriptor is emitted back (lossless round-trip through the serializer).
			expect(serializeManifest(out)).toContain(`<AudioChannelConfiguration schemeIdUri="${mpeg}" value="2"`);
		});

		test('dropByColorRange (HLS) drops HDR variants, keeps SDR and unmarked', () => {
			const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=12000000,CODECS="hvc1.2.4.L153.B0",RESOLUTION=3840x2160,VIDEO-RANGE=PQ
uhd-hdr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="hvc1.2.4.L150.B0",RESOLUTION=3840x2160,VIDEO-RANGE=HLG
uhd-hlg.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028",RESOLUTION=1920x1080,VIDEO-RANGE=SDR
hd-sdr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f",RESOLUTION=1280x720
sd.m3u8
`;
			const out = dropByColorRange(['PQ', 'HLG'])(parseManifest(master));
			if (out.format !== 'hls' || out.playlist.kind !== 'master') {
				throw new Error('expected hls master');
			}
			expect(out.playlist.variants.map(v => v.uri)).toEqual(['hd-sdr.m3u8', 'sd.m3u8']); // HDR dropped, SDR + unmarked kept
			expect(serializeManifest(out)).toContain('VIDEO-RANGE=SDR'); // survives round-trip
		});

		test('dropByColorRange (DASH) reads CICP TransferCharacteristics, keeps SDR and audio', () => {
			const transfer = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
			const manifest = dashManifest([
				set({ representations: [
					rep('hdr', 'hvc1.2.4', { essentialProperties: [{ schemeIdUri: transfer, value: '16' }] }), // PQ
					rep('sdr', 'avc1', { essentialProperties: [{ schemeIdUri: transfer, value: '1' }] }), // BT.709 SDR
					rep('unmarked', 'avc1'),
				] }),
				set({ contentType: 'audio', representations: [rep('a', 'mp4a')] }),
			]);
			const out = dropByColorRange(['PQ', 'HLG'])(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			const ids = out.mpd.periods[0]!.adaptationSets.flatMap(s => s.representations.map(r => r.id));
			expect(ids).toEqual(['sdr', 'unmarked', 'a']); // only the PQ rendition dropped
			expect(serializeManifest(out)).toContain(`<EssentialProperty schemeIdUri="${transfer}" value="1"`);
		});

		test('filterRenditions HLS master filters variants by the predicate', () => {
			const out = filterRenditions(r => (r.bandwidth ?? 0) <= 4_000_000)(parseManifest(HLS_MASTER));
			if (out.format !== 'hls' || out.playlist.kind !== 'master') {
				throw new Error('expected hls master');
			}
			expect(out.playlist.variants).toHaveLength(1);
			expect(out.playlist.variants[0]!.bandwidth).toBe(3_000_000);
		});
	});

	describe('drm', () => {
		const widevinePssh = new Uint8Array([0, 1, 2, 3]);
		const playreadyPro = new Uint8Array([9, 8, 7, 6, 5]);
		const options = {
			scheme: 'cbcs',
			defaultKid: hexStringToBytes('1234567890abcdef1234567890abcdef'),
			systems: [
				{ uuid: WIDEVINE_UUID, pssh: psshBox(WIDEVINE_UUID, widevinePssh) },
				{ uuid: PLAYREADY_SYSTEM_ID, pssh: psshBox(PLAYREADY_SYSTEM_ID, playreadyPro) },
				{ uuid: FAIRPLAY_UUID },
			],
			fairplayKeyUri: 'skd://12345678-90ab-cdef-1234-567890abcdef',
		};

		test('DASH: prepends mp4protection + per-system ContentProtection, skips FairPlay', () => {
			const manifest = dashManifest([set({ representations: [rep('v', 'avc1.640028')] })]);
			const out = drm(options)(manifest);
			const text = serializeManifest(out);
			expect(text).toContain('schemeIdUri="urn:mpeg:dash:mp4protection:2011"');
			expect(text).toContain('value="cbcs"');
			expect(text).toContain('cenc:default_KID="12345678-90ab-cdef-1234-567890abcdef"');
			expect(text).toContain(`schemeIdUri="urn:uuid:${WIDEVINE_UUID}"`);
			expect(text).toContain(`schemeIdUri="urn:uuid:${PLAYREADY_SYSTEM_ID}"`);
			expect(text).not.toContain(FAIRPLAY_UUID); // DASH cannot signal FairPlay
			expect(text).toContain('<cenc:pssh>');
		});

		test('HLS media: one #EXT-X-KEY per system (widevine data, playready PRO, fairplay skd)', () => {
			const media = parseManifest(HLS_MEDIA);
			const out = drm(options)(media);
			if (out.format !== 'hls' || out.playlist.kind !== 'media') {
				throw new Error('expected hls media');
			}
			expect(out.playlist.segments[0]!.keys).toHaveLength(3);
			const text = serializeManifest(out);
			expect(text.match(/#EXT-X-KEY:/g)).toHaveLength(3);
			expect(text).toContain(`KEYFORMAT="urn:uuid:${WIDEVINE_UUID}"`);
			expect(text).toContain('KEYFORMAT="com.microsoft.playready"');
			expect(text).toContain('KEYFORMAT="com.apple.streamingkeydelivery"');
			expect(text).toContain('URI="skd://12345678-90ab-cdef-1234-567890abcdef"');
			// PlayReady key carries the PRO (pssh data payload), not the whole pssh box.
			expect(text).toContain('charset=UTF-16');
		});

		test('HLS master: unchanged (keys live in media playlists)', () => {
			const master = parseManifest(HLS_MASTER);
			expect(drm(options)(master)).toBe(master);
		});

		test('does not mutate the input', () => {
			const manifest = dashManifest([set({ representations: [rep('v', 'avc1.640028')] })]);
			const before = JSON.stringify(manifest);
			drm(options)(manifest);
			expect(JSON.stringify(manifest)).toBe(before);
		});
	});

	describe('mapSegmentUrls', () => {
		const HLS_MEDIA_MULTI = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-0.m4s
#EXTINF:6.000,
seg-1.m4s
#EXT-X-ENDLIST
`;

		test('HLS media: rewrites segment + init URIs, with the sticky map rewritten once', () => {
			const calls: Array<[string, string]> = [];
			const out = mapSegmentUrls((url, kind) => {
				calls.push([kind, url]);
				return `/proxy/${kind}/${url}`;
			})(parseManifest(HLS_MEDIA_MULTI));
			if (out.format !== 'hls' || out.playlist.kind !== 'media') {
				throw new Error('expected hls media');
			}
			expect(out.playlist.segments.map(s => s.uri)).toEqual(['/proxy/segment/seg-0.m4s', '/proxy/segment/seg-1.m4s']);
			// The shared #EXT-X-MAP is rewritten once and both segments point at the same object.
			expect(out.playlist.segments[0]!.map!.uri).toBe('/proxy/init/init.mp4');
			expect(out.playlist.segments[1]!.map).toBe(out.playlist.segments[0]!.map);
			expect(calls.filter(([k]) => k === 'init')).toHaveLength(1);
			expect(calls.filter(([k]) => k === 'segment')).toHaveLength(2);
		});

		test('HLS media: mapper gets a per-kind 0-based index in playback order', () => {
			const out = mapSegmentUrls((_url, kind, index) => `/proxy/${kind}/${index}`)(parseManifest(HLS_MEDIA_MULTI));
			if (out.format !== 'hls' || out.playlist.kind !== 'media') {
				throw new Error('expected hls media');
			}
			// segments number 0, 1 independently of the sticky init (which is index 0 of its own kind).
			expect(out.playlist.segments.map(s => s.uri)).toEqual(['/proxy/segment/0', '/proxy/segment/1']);
			expect(out.playlist.segments[0]!.map!.uri).toBe('/proxy/init/0');
		});

		test('HLS master: rewrites variant URIs', () => {
			const out = mapSegmentUrls((url, kind) => `${kind}:${url}`)(parseManifest(HLS_MASTER));
			if (out.format !== 'hls' || out.playlist.kind !== 'master') {
				throw new Error('expected hls master');
			}
			expect(out.playlist.variants.map(v => v.uri)).toEqual(['variant:hevc/1080.m3u8', 'variant:avc/1080.m3u8']);
		});

		test('DASH: rewrites SegmentTemplate media/init and BaseURLs by kind', () => {
			const manifest = dashManifest(
				[set({ representations: [{
					...rep('v', 'avc1.640028'),
					segmentTemplate: {
						media: '$RepresentationID$/$Number$.m4s',
						initialization: '$RepresentationID$/init.mp4',
						bitstreamSwitching: null,
						startNumber: 1,
						timescale: 1,
						duration: null,
						presentationTimeOffset: 0,
						availabilityTimeOffset: 0,
						timeline: null,
					},
				}] })],
				['origin/'],
			);
			const out = mapSegmentUrls((url, kind) => `${kind}|${url}`)(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			expect(out.mpd.baseURLs).toEqual(['baseUrl|origin/']);
			const template = out.mpd.periods[0]!.adaptationSets[0]!.representations[0]!.segmentTemplate!;
			expect(template.media).toBe('segment|$RepresentationID$/$Number$.m4s');
			expect(template.initialization).toBe('init|$RepresentationID$/init.mp4');
		});

		test('does not mutate the input', () => {
			const manifest = parseManifest(HLS_MEDIA_MULTI);
			const before = serializeManifest(manifest);
			mapSegmentUrls(url => `/x/${url}`)(manifest);
			expect(serializeManifest(manifest)).toBe(before);
		});
	});

	describe('toSegmentTemplate', () => {
		const template: SegmentTemplate = {
			media: '/proxy/$Number$.m4s',
			initialization: '/proxy/init',
			bitstreamSwitching: null,
			startNumber: 1,
			timescale: 48000,
			duration: null,
			presentationTimeOffset: 0,
			availabilityTimeOffset: 0,
			timeline: [{ t: 0, d: 96000, r: 4 }],
		};

		test('replaces SegmentBase with the built SegmentTemplate and drops the single-file BaseURL', () => {
			const byteRangeRep = {
				...rep('v', 'avc1.640028', { baseURLs: ['video.mp4'] }),
				segmentBase: {
					timescale: 48000,
					presentationTimeOffset: 0,
					indexRange: { start: 0, end: 999 },
					initialization: { sourceURL: null, range: { start: 0, end: 799 } },
				},
			};
			const manifest = dashManifest([set({ representations: [byteRangeRep] })]);
			const out = toSegmentTemplate(() => template)(manifest);
			if (out.format !== 'dash') {
				throw new Error('expected dash');
			}
			const outRep = out.mpd.periods[0]!.adaptationSets[0]!.representations[0]!;
			expect(outRep.segmentBase).toBeNull();
			expect(outRep.segmentTemplate).toBe(template);
			expect(outRep.baseURLs).toEqual([]);
		});

		test('leaves a Representation untouched when build returns null, and non-SegmentBase reps', () => {
			const manifest = dashManifest([set({ representations: [rep('v', 'avc1.640028')] })]); // no segmentBase
			expect(toSegmentTemplate(() => template)(manifest)).toBe(manifest); // identity: nothing eligible
		});
	});
});
