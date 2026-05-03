/*!
 * Test cases for the DASH AdaptationSet port. Where shaka has equivalent unit
 * tests they are referenced inline by name and the expected XML strings are
 * pasted verbatim from shaka's `adaptation_set_unittest.cc`. Verified with
 * the tree-aware xmlEqual matcher.
 *
 * Original test source: shaka-packager packager/mpd/base/adaptation_set_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import {
	AdaptationSet,
	type RepresentationCounter,
} from '../../src/dash/dash-adaptation-set.js';
import type { ContentProtectionElement } from '../../src/dash/dash-content-protection.js';
import type { MediaInfo } from '../../src/dash/dash-media-info.js';
import {
	createDefaultMpdOptions,
	type MpdOptions,
} from '../../src/dash/dash-types.js';
import { expectXmlEqual } from './_xml-equal.js';

const NO_LANGUAGE = '';

const newOptions = (overrides: Partial<MpdOptions> = {}): MpdOptions => ({
	...createDefaultMpdOptions(),
	...overrides,
});

const newCounter = (): RepresentationCounter => ({ value: 0 });

const renderAs = (set: AdaptationSet): string => {
	const node = set.getXml();
	if (!node) {
		throw new Error('getXml() returned null');
	}
	return node.toString();
};

describe('AdaptationSet — empty', () => {
	// shaka: TEST_F(AdaptationSetTest, AddAdaptationSetSwitching)
	test('AddAdaptationSetSwitching emits Adaptation-Set-Switching SupplementalProperty', () => {
		const counter = newCounter();
		const opts = newOptions();
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, counter);

		const set1 = new AdaptationSet(NO_LANGUAGE, opts, counter);
		set1.setId(1);
		adaptationSet.addAdaptationSetSwitching(set1);

		const set2 = new AdaptationSet(NO_LANGUAGE, opts, counter);
		set2.setId(2);
		adaptationSet.addAdaptationSetSwitching(set2);

		const set8 = new AdaptationSet(NO_LANGUAGE, opts, counter);
		set8.setId(8);
		adaptationSet.addAdaptationSetSwitching(set8);

		expectXmlEqual(
			renderAs(adaptationSet),
			'<AdaptationSet contentType="">'
			+ '  <SupplementalProperty'
			+ '   schemeIdUri="urn:mpeg:dash:adaptation-set-switching:2016"'
			+ '   value="1,2,8"/>'
			+ '</AdaptationSet>',
		);
	});

	// shaka: TEST_F(AdaptationSetTest, CheckAdaptationSetId)
	test('setId reflects in @id attribute', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.setId(42);
		expect(adaptationSet.getXml()!.getAttribute('id')).toBe('42');
	});

	// shaka: TEST_F(AdaptationSetTest, CheckLanguageAttributeSet)
	test('lang attribute is set when language is non-empty / non-und', () => {
		const adaptationSet = new AdaptationSet('en', newOptions(), newCounter());
		expect(adaptationSet.getXml()!.getAttribute('lang')).toBe('en');
	});

	test('lang attribute is omitted for "und"', () => {
		const adaptationSet = new AdaptationSet('und', newOptions(), newCounter());
		expect(adaptationSet.getXml()!.getAttribute('lang')).toBeUndefined();
	});

	// shaka: TEST_F(AdaptationSetTest, AddAccessibilityElement)
	test('AddAccessibility emits Accessibility child', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.addAccessibility('urn:tva:metadata:cs:AudioPurposeCS:2007', '2');
		expectXmlEqual(
			renderAs(adaptationSet),
			'<AdaptationSet contentType="">\n'
			+ '  <Accessibility schemeIdUri="urn:tva:metadata:cs:AudioPurposeCS:2007" value="2"/>\n'
			+ '</AdaptationSet>',
		);
	});

	// shaka: TEST_F(AdaptationSetTest, AdaptationAddRoleElementMain)
	test('AddRole emits Role child with urn:mpeg:dash:role:2011 scheme', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.addRole('main');
		expectXmlEqual(
			renderAs(adaptationSet),
			'<AdaptationSet contentType="">\n'
			+ '  <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>\n'
			+ '</AdaptationSet>',
		);
	});
});

describe('AdaptationSet — content type derivation', () => {
	// shaka: TEST_F(AdaptationSetTest, CheckAdaptationSetVideoContentType)
	test('video_info → contentType=video', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const mediaInfo: MediaInfo = {
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
		expect(adaptationSet.addRepresentation(mediaInfo)).not.toBeNull();
		expect(adaptationSet.getXml()!.getAttribute('contentType')).toBe('video');
	});

	// shaka: TEST_F(AdaptationSetTest, CheckAdaptationSetAudioContentType)
	test('audio_info → contentType=audio', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const mediaInfo: MediaInfo = {
			audioInfo: {
				codec: 'mp4a.40.2',
				samplingFrequency: 44100,
				timeScale: 1200,
				numChannels: 2,
			},
			containerType: 'mp4',
		};
		expect(adaptationSet.addRepresentation(mediaInfo)).not.toBeNull();
		expect(adaptationSet.getXml()!.getAttribute('contentType')).toBe('audio');
	});

	// shaka: TEST_F(AdaptationSetTest, CheckAdaptationSetTextContentType)
	test('text_info → contentType=text', () => {
		const adaptationSet = new AdaptationSet('en', newOptions(), newCounter());
		const mediaInfo: MediaInfo = {
			textInfo: { codec: 'ttml', language: 'en' },
			containerType: 'text',
		};
		expect(adaptationSet.addRepresentation(mediaInfo)).not.toBeNull();
		expect(adaptationSet.getXml()!.getAttribute('contentType')).toBe('text');
	});
});

describe('AdaptationSet — width / height / frame rate aggregation', () => {
	// shaka: TEST_F(AdaptationSetTest, AdapatationSetFrameRate)
	test('all reps share the same frame rate → frameRate, no maxFrameRate', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const sameFrameRate: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, timeScale: 10, frameDuration: 3 },
			containerType: 'mp4',
		};
		expect(adaptationSet.addRepresentation(sameFrameRate)).not.toBeNull();
		expect(adaptationSet.addRepresentation(sameFrameRate)).not.toBeNull();
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('frameRate')).toBe('10/3');
		expect(xml.getAttribute('maxFrameRate')).toBeUndefined();
	});

	// shaka: TEST_F(AdaptationSetTest, AdapatationSetMaxFrameRate)
	test('reps with different rates → maxFrameRate, no frameRate', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const r30fps: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, timeScale: 3000, frameDuration: 100 },
			containerType: 'mp4',
		};
		const r15fps: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, timeScale: 3000, frameDuration: 200 },
			containerType: 'mp4',
		};
		expect(adaptationSet.addRepresentation(r30fps)).not.toBeNull();
		expect(adaptationSet.addRepresentation(r15fps)).not.toBeNull();
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('maxFrameRate')).toBe('3000/100');
		expect(xml.getAttribute('frameRate')).toBeUndefined();
	});

	// shaka: TEST_F(AdaptationSetTest, SetAdaptationFrameRateUsingRepresentationSetSampleDuration)
	test('Representation.setSampleDuration propagates frame rate up to AdaptationSet', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const r480p: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, timeScale: 10, pixelWidth: 8, pixelHeight: 9 },
			containerType: 'mp4',
		};
		const r360p: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 640, height: 360, timeScale: 10, pixelWidth: 1, pixelHeight: 1 },
			containerType: 'mp4',
		};
		const rep480 = adaptationSet.addRepresentation(r480p)!;
		const rep360 = adaptationSet.addRepresentation(r360p)!;

		// Without frame durations, neither attribute is set.
		const noFrameRate = adaptationSet.getXml()!;
		expect(noFrameRate.getAttribute('frameRate')).toBeUndefined();
		expect(noFrameRate.getAttribute('maxFrameRate')).toBeUndefined();

		// Equal frame durations → frameRate set, no maxFrameRate.
		rep480.setSampleDuration(3);
		rep360.setSampleDuration(3);
		const sameFrameRate = adaptationSet.getXml()!;
		expect(sameFrameRate.getAttribute('frameRate')).toBe('10/3');
		expect(sameFrameRate.getAttribute('maxFrameRate')).toBeUndefined();

		// Different frame durations → maxFrameRate set.
		rep480.setSampleDuration(2);
		const maxFrameRate = adaptationSet.getXml()!;
		expect(maxFrameRate.getAttribute('maxFrameRate')).toBe('10/2');
		expect(maxFrameRate.getAttribute('frameRate')).toBeUndefined();
	});

	// shaka: TEST_F(AdaptationSetTest, AdaptationSetParAllSame) — abridged
	test('all reps share par → @par attribute set', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const r480: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 854,
				height: 480,
				timeScale: 3000,
				frameDuration: 100,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		const r720: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1280,
				height: 720,
				timeScale: 3000,
				frameDuration: 100,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		expect(adaptationSet.addRepresentation(r480)).not.toBeNull();
		expect(adaptationSet.addRepresentation(r720)).not.toBeNull();
		expect(adaptationSet.getXml()!.getAttribute('par')).toBe('16:9');
	});

	test('mixed pars → @par attribute is omitted', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const r1: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, pixelWidth: 1, pixelHeight: 1 },
			containerType: 'mp4',
		};
		const r2: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, pixelWidth: 9, pixelHeight: 8 },
			containerType: 'mp4',
		};
		expect(adaptationSet.addRepresentation(r1)).not.toBeNull();
		expect(adaptationSet.addRepresentation(r2)).not.toBeNull();
		expect(adaptationSet.getXml()!.getAttribute('par')).toBeUndefined();
	});
});

describe('AdaptationSet — width/height aggregation', () => {
	test('single resolution → width/height attributes set, suppressed on Representation', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
		};
		const rep = adaptationSet.addRepresentation(mediaInfo)!;
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('width')).toBe('1280');
		expect(xml.getAttribute('height')).toBe('720');
		expect(xml.getAttribute('maxWidth')).toBeUndefined();
		expect(xml.getAttribute('maxHeight')).toBeUndefined();
		// Reflushing the adaptation set re-suppresses the representation
		// attributes on the next emission. Here we verify that getXml() of
		// the rep alone (without going through AdaptationSet's GetXml) still
		// emits its own width/height — i.e. suppression is one-shot.
		const rXml = rep.getXml()!;
		expect(rXml.getAttribute('width')).toBe('1280');
		expect(rXml.getAttribute('height')).toBe('720');
	});

	test('multiple resolutions → maxWidth/maxHeight set', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.addRepresentation({
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
		})).not.toBeNull();
		expect(adaptationSet.addRepresentation({
			videoInfo: { codec: 'avc1', width: 1920, height: 1080, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
		})).not.toBeNull();
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('maxWidth')).toBe('1920');
		expect(xml.getAttribute('maxHeight')).toBe('1080');
		expect(xml.getAttribute('width')).toBeUndefined();
		expect(xml.getAttribute('height')).toBeUndefined();
	});
});

describe('AdaptationSet — content protection / role / representation order', () => {
	// shaka: TEST_F(AdaptationSetTest, CheckContentProtectionRoleRepresentationOrder)
	test('children render in order: ContentProtection → Role → Representation', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.addRole('main');
		const cp: ContentProtectionElement = {
			value: '',
			schemeIdUri: 'any_scheme',
			additionalAttributes: new Map(),
			subelements: [],
		};
		adaptationSet.addContentProtectionElement(cp);
		const audio: MediaInfo = {
			audioInfo: { codec: 'mp4a.40.2', samplingFrequency: 44100, timeScale: 1200, numChannels: 2 },
			containerType: 'mp4',
		};
		expect(adaptationSet.addRepresentation(audio)).not.toBeNull();

		expectXmlEqual(
			renderAs(adaptationSet),
			'<AdaptationSet contentType="audio">\n'
			+ '  <ContentProtection schemeIdUri="any_scheme"/>\n'
			+ '  <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>\n'
			+ '  <Representation id="0" bandwidth="0" codecs="mp4a.40.2"\n'
			+ '   mimeType="audio/mp4" audioSamplingRate="44100">\n'
			+ '    <AudioChannelConfiguration\n'
			+ '     schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"\n'
			+ '     value="2"/>\n'
			+ '  </Representation>\n'
			+ '</AdaptationSet>',
		);
	});
});

describe('AdaptationSet — segment alignment', () => {
	test('on-demand profile + aligned segments → subsegmentAlignment="true"', () => {
		const opts = newOptions({ dashProfile: 'onDemand' });
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, newCounter());
		// Two reps with identical segment-start timelines.
		const v: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
			referenceTimeScale: 90000,
		};
		const r1 = adaptationSet.addRepresentation(v)!;
		const r2 = adaptationSet.addRepresentation(v)!;
		r1.addNewSegment(0, 360000, 1_000_000, 1);
		r2.addNewSegment(0, 360000, 1_000_000, 1);
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('subsegmentAlignment')).toBe('true');
		expect(xml.getAttribute('segmentAlignment')).toBeUndefined();
	});

	test('live profile + aligned segments → segmentAlignment="true"', () => {
		const opts = newOptions({ dashProfile: 'live' });
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, newCounter());
		// ForceSetSegmentAlignment(true) since dynamic alignment requires
		// segments + tracking; we isolate the attribute path here.
		adaptationSet.forceSetSegmentAlignment(true);
		expect(adaptationSet.getXml()!.getAttribute('segmentAlignment')).toBe('true');
	});

	test('forceSetSegmentAlignment(false) → no alignment attribute', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.forceSetSegmentAlignment(false);
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('subsegmentAlignment')).toBeUndefined();
		expect(xml.getAttribute('segmentAlignment')).toBeUndefined();
	});
});

describe('AdaptationSet — SAP forcing', () => {
	test('forceSubsegmentStartsWithSAP emits subsegmentStartsWithSAP', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.forceSubsegmentStartsWithSAP(1);
		expect(adaptationSet.getXml()!.getAttribute('subsegmentStartsWithSAP')).toBe('1');
	});

	test('forceStartWithSAP emits startWithSAP', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.forceStartWithSAP(2);
		expect(adaptationSet.getXml()!.getAttribute('startWithSAP')).toBe('2');
	});

	test('subsegmentStartsWithSAP wins over startWithSAP when both are set', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.forceStartWithSAP(2);
		adaptationSet.forceSubsegmentStartsWithSAP(1);
		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('subsegmentStartsWithSAP')).toBe('1');
		expect(xml.getAttribute('startWithSAP')).toBeUndefined();
	});
});

describe('AdaptationSet — id / sortIndex / setProtectedContent', () => {
	test('hasId, id, setId roundtrip', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.hasId()).toBe(false);
		expect(() => adaptationSet.id()).toThrow();
		adaptationSet.setId(7);
		expect(adaptationSet.hasId()).toBe(true);
		expect(adaptationSet.id()).toBe(7);
	});

	test('sortIndex returns explicit index when set, otherwise id', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.sortIndex()).toBeUndefined();
		adaptationSet.setId(3);
		expect(adaptationSet.sortIndex()).toBe(3);
		// Adding a representation with index propagates to AdaptationSet.indexValue
		adaptationSet.addRepresentation({
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
			index: 1,
		});
		expect(adaptationSet.sortIndex()).toBe(1);
	});

	test('setProtectedContent throws if called twice', () => {
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
			protectedContent: { protectionScheme: 'cenc' },
		};
		adaptationSet.setProtectedContent(mediaInfo);
		expect(() => adaptationSet.setProtectedContent(mediaInfo)).toThrow();
	});
});
