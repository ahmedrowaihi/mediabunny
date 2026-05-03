/*!
 * Test cases for the DASH Period port. Each case is named after the shaka
 * test it adapts (`PeriodTest, X` upstream). Shaka uses gMock to verify
 * behavior on injected MockAdaptationSet; we use vi.spyOn on real
 * AdaptationSet methods to assert the same things.
 *
 * Original test source: shaka-packager packager/mpd/base/period_unittest.cc
 */
import { describe, expect, test, vi } from 'vitest';
import {
	AdaptationSet,
	type RepresentationCounter,
} from '../../src/dash/dash-adaptation-set.js';
import type { MediaInfo } from '../../src/dash/dash-media-info.js';
import { Period } from '../../src/dash/dash-period.js';
import {
	createDefaultMpdOptions,
	type MpdOptions,
} from '../../src/dash/dash-types.js';
import { expectXmlEqual } from './_xml-equal.js';

const DEFAULT_PERIOD_ID = 9;
const DEFAULT_PERIOD_START_TIME = 5.6;

const newOptions = (overrides: Partial<MpdOptions> = {}): MpdOptions => ({
	...createDefaultMpdOptions(),
	...overrides,
});

const newCounter = (): RepresentationCounter => ({ value: 0 });

const VIDEO_MEDIA_INFO: MediaInfo = {
	videoInfo: {
		codec: 'avc1',
		width: 1280,
		height: 720,
		timeScale: 10,
		frameDuration: 10,
		pixelWidth: 1,
		pixelHeight: 1,
	},
	containerType: 'mp4',
};

const TRICK_PLAY_MEDIA_INFO: MediaInfo = {
	videoInfo: {
		codec: 'avc1',
		width: 1280,
		height: 720,
		timeScale: 10,
		frameDuration: 10,
		pixelWidth: 1,
		pixelHeight: 1,
		playbackRate: 10,
	},
	containerType: 'mp4',
};

describe('Period — GetXml', () => {
	// shaka: TEST_F(PeriodTest, GetXml)
	test('GetXml', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		const set = period.getOrCreateAdaptationSet(
			{ ...VIDEO_MEDIA_INFO, mediaDurationSeconds: 60 },
			true,
		);
		expect(set).not.toBeNull();
		const xml = period.getXml(true)!;
		expect(xml.getAttribute('id')).toBe(String(DEFAULT_PERIOD_ID));
		expect(xml.getAttribute('duration')).toBe('PT60S');
	});

	// shaka: TEST_F(PeriodTest, DynamicMpdGetXml)
	test('DynamicMpdGetXml', () => {
		const period = new Period(
			DEFAULT_PERIOD_ID,
			DEFAULT_PERIOD_START_TIME,
			newOptions({ mpdType: 'dynamic' }),
			newCounter(),
		);
		const xml = period.getXml(false)!;
		expect(xml.getAttribute('start')).toBe('PT5.6S');
		expect(xml.getAttribute('duration')).toBeUndefined();
	});

	// shaka: TEST_F(PeriodTest, LowLatencyDashMpdGetXml)
	test('LowLatencyDashMpdGetXml', () => {
		const opts = newOptions({});
		opts.mpdParams.lowLatencyDashMode = true;
		opts.mpdParams.targetLatencySeconds = 1.5;
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, opts, newCounter());
		expectXmlEqual(
			period.getXml(true)!.toString(),
			'<Period id="9" duration="PT0S">'
			+ '  <ServiceDescription id="9">'
			+ '    <Latency target="1500"/>'
			+ '  </ServiceDescription>'
			+ '</Period>',
		);
	});

	// shaka: TEST_F(PeriodTest, SetDurationAndGetXml)
	test('SetDurationAndGetXml', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		period.setDurationSeconds(120);
		expect(period.getXml(true)!.getAttribute('duration')).toBe('PT120S');
	});
});

describe('Period — content type behaviour', () => {
	// shaka: TEST_F(PeriodTest, Text)
	test('Text', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		const set = period.getOrCreateAdaptationSet(
			{ textInfo: { codec: 'wvtt', language: 'en', type: 'subtitle' }, containerType: 'text' },
			true,
		);
		expect(set).not.toBeNull();
		const xml = set!.getXml()!;
		const align = xml.getAttribute('subsegmentAlignment') ?? xml.getAttribute('segmentAlignment');
		expect(align).toBe('true');
	});

	// shaka: TEST_F(PeriodTest, AudioAdaptationSetDefaultLanguage)
	test('AudioAdaptationSetDefaultLanguage', () => {
		const opts = newOptions({});
		opts.mpdParams.defaultLanguage = 'en';
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, opts, newCounter());
		const audio: MediaInfo = {
			audioInfo: {
				codec: 'mp4a.40.2',
				samplingFrequency: 44100,
				timeScale: 1200,
				numChannels: 2,
				language: 'eng',
			},
			containerType: 'mp4',
		};
		const set = period.getOrCreateAdaptationSet(audio, true)!;
		expect(set.getXml()!.toString()).toContain('value="main"');
	});

	// shaka: TEST_F(PeriodTest, AudioAdaptationSetNonDefaultLanguage)
	test('AudioAdaptationSetNonDefaultLanguage', () => {
		const opts = newOptions({});
		opts.mpdParams.defaultLanguage = 'en';
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, opts, newCounter());
		const audio: MediaInfo = {
			audioInfo: {
				codec: 'mp4a.40.2',
				samplingFrequency: 44100,
				timeScale: 1200,
				numChannels: 2,
				language: 'spa',
			},
			containerType: 'mp4',
		};
		const set = period.getOrCreateAdaptationSet(audio, true)!;
		expect(set.getXml()!.toString()).not.toContain('value="main"');
	});
});

describe('Period — closed captions', () => {
	// shaka: TEST_F(PeriodTest, ClosedCaptions) — CEA-608 channel
	test('ClosedCaptions emit Accessibility on video AdaptationSets', () => {
		const opts = newOptions({});
		opts.mpdParams.closedCaptions = [
			{ name: 'eng', language: 'eng', channel: 'CC1', isDefault: false, autoselect: true },
		];
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, opts, newCounter());
		const addAccessibilitySpy = vi.spyOn(AdaptationSet.prototype, 'addAccessibility');
		period.getOrCreateAdaptationSet(VIDEO_MEDIA_INFO, true);
		expect(addAccessibilitySpy).toHaveBeenCalledWith('urn:scte:dash:cc:cea-608:2015', 'CC1=eng');
		addAccessibilitySpy.mockRestore();
	});

	test('CEA-708 SERVICE channel emits cea-708 Accessibility', () => {
		const opts = newOptions({});
		opts.mpdParams.closedCaptions = [
			{ name: 'eng', language: 'eng', channel: 'SERVICE2', isDefault: false, autoselect: true },
		];
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, opts, newCounter());
		const addAccessibilitySpy = vi.spyOn(AdaptationSet.prototype, 'addAccessibility');
		period.getOrCreateAdaptationSet(VIDEO_MEDIA_INFO, true);
		expect(addAccessibilitySpy).toHaveBeenCalledWith('urn:scte:dash:cc:cea-708:2015', '2=lang:eng');
		addAccessibilitySpy.mockRestore();
	});

	// shaka: TEST_F(PeriodTest, NoClosedCaptionsForTrickPlay)
	test('NoClosedCaptionsForTrickPlay', () => {
		const opts = newOptions({});
		opts.mpdParams.closedCaptions = [
			{ name: 'name1', language: 'eng', channel: 'CC1', isDefault: true, autoselect: true },
		];
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, opts, newCounter());
		const addAccessibilitySpy = vi.spyOn(AdaptationSet.prototype, 'addAccessibility');
		const set = period.getOrCreateAdaptationSet(TRICK_PLAY_MEDIA_INFO, true);
		expect(set).not.toBeNull();
		expect(addAccessibilitySpy).not.toHaveBeenCalled();
		addAccessibilitySpy.mockRestore();
	});
});

describe('Period — trick play', () => {
	// shaka: TEST_F(PeriodTest, TrickPlayWithMatchingAdaptationSet)
	test('TrickPlayWithMatchingAdaptationSet', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		const trickPlayRefSpy = vi.spyOn(AdaptationSet.prototype, 'addTrickPlayReference');
		period.getOrCreateAdaptationSet(VIDEO_MEDIA_INFO, true);
		period.getOrCreateAdaptationSet(TRICK_PLAY_MEDIA_INFO, true);
		expect(period.trickplayCache().size).toBe(0);
		expect(trickPlayRefSpy).toHaveBeenCalledTimes(1);
		trickPlayRefSpy.mockRestore();
	});

	// shaka: TEST_F(PeriodTest, TrickPlayCacheWithMatchingAdaptationSet)
	test('TrickPlayCacheWithMatchingAdaptationSet', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		period.getOrCreateAdaptationSet(TRICK_PLAY_MEDIA_INFO, true);
		expect(period.trickplayCache().size).toBe(1);
		const trickPlayRefSpy = vi.spyOn(AdaptationSet.prototype, 'addTrickPlayReference');
		period.getOrCreateAdaptationSet(VIDEO_MEDIA_INFO, true);
		expect(period.trickplayCache().size).toBe(0);
		expect(trickPlayRefSpy).toHaveBeenCalledTimes(1);
		trickPlayRefSpy.mockRestore();
	});

	// shaka: TEST_F(PeriodTest, TrickPlayWithNoMatchingAdaptationSet)
	test('TrickPlayWithNoMatchingAdaptationSet', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		period.getOrCreateAdaptationSet(TRICK_PLAY_MEDIA_INFO, true);
		expect(period.trickplayCache().size).toBe(1);
	});
});

describe('Period — split adaptation sets', () => {
	// shaka: TEST_F(PeriodTest, SplitAdaptationSetsByLanguageAndCodec) — abridged
	test('SplitAdaptationSetsByLanguageAndCodec', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		const aacEng: MediaInfo = {
			audioInfo: {
				codec: 'mp4a.40.2',
				samplingFrequency: 44100,
				timeScale: 1200,
				numChannels: 2,
				language: 'eng',
			},
			referenceTimeScale: 50,
			containerType: 'mp4',
			mediaDurationSeconds: 10.5,
		};
		const aacGer: MediaInfo = { ...aacEng, audioInfo: { ...aacEng.audioInfo!, language: 'ger' } };
		const vorbisGer1: MediaInfo = {
			audioInfo: {
				codec: 'vorbis',
				samplingFrequency: 44100,
				timeScale: 1200,
				numChannels: 2,
				language: 'ger',
			},
			referenceTimeScale: 50,
			containerType: 'webm',
			mediaDurationSeconds: 10.5,
		};
		const vorbisGer2: MediaInfo = { ...vorbisGer1 };
		const a = period.getOrCreateAdaptationSet(aacEng, true)!;
		const b = period.getOrCreateAdaptationSet(aacGer, true)!;
		const c = period.getOrCreateAdaptationSet(vorbisGer1, true)!;
		const d = period.getOrCreateAdaptationSet(vorbisGer2, true)!;
		expect(a).not.toBe(b);
		expect(b).not.toBe(c);
		expect(c).toBe(d);
		expect(period.getAdaptationSets()).toHaveLength(3);
	});
});

describe('Period — accessors', () => {
	// shaka: TEST_F(PeriodTest, GetAdaptationSets)
	test('GetAdaptationSets', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		const a = period.getOrCreateAdaptationSet(VIDEO_MEDIA_INFO, true)!;
		const audioInfo: MediaInfo = {
			audioInfo: { codec: 'mp4a.40.2', samplingFrequency: 44100, timeScale: 1200, numChannels: 2 },
			containerType: 'mp4',
		};
		const b = period.getOrCreateAdaptationSet(audioInfo, true)!;
		const sets = period.getAdaptationSets();
		expect(sets).toHaveLength(2);
		expect(sets).toContain(a);
		expect(sets).toContain(b);
	});

	// shaka: TEST_F(PeriodTest, OrderedByAdaptationSetId)
	test('OrderedByAdaptationSetId', () => {
		const period = new Period(DEFAULT_PERIOD_ID, DEFAULT_PERIOD_START_TIME, newOptions(), newCounter());
		const audioInfo: MediaInfo = {
			audioInfo: { codec: 'mp4a.40.2', samplingFrequency: 44100, timeScale: 1200, numChannels: 2 },
			containerType: 'mp4',
		};
		const audioSet = period.getOrCreateAdaptationSet(audioInfo, true)!;
		const videoSet = period.getOrCreateAdaptationSet(VIDEO_MEDIA_INFO, true)!;
		expect(audioSet.hasId()).toBe(false);
		expect(videoSet.hasId()).toBe(false);
		period.getXml(true);
		expect(audioSet.id()).toBe(0);
		expect(videoSet.id()).toBe(1);
	});
});
