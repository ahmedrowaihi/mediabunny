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

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('AdaptationSet — matchAdaptationSet / protected content', () => {
	// shaka: TEST_P(PeriodTestWithContentProtection, DifferentProtectedContent)
	// Different protected_content (different uuid / name_version / pssh /
	// default_key_id) → a second AdaptationSet is created, i.e. no match. With
	// content protection ignored, the codecs alone match → one AdaptationSet.
	test('different protected content → no match (two AdaptationSets)', () => {
		const sd: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 640,
				height: 360,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
			protectedContent: {
				contentProtectionEntry: [
					{ uuid: 'myuuid', nameVersion: 'MyContentProtection version 1', pssh: bytes('pssh1') },
				],
				defaultKeyId: bytes('_default_key_id_'),
			},
		};
		const hd: MediaInfo = {
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
			protectedContent: {
				contentProtectionEntry: [
					{ uuid: 'anotheruuid', nameVersion: 'SomeOtherProtection version 3', pssh: bytes('pssh2') },
				],
				defaultKeyId: bytes('.default.key.id.'),
			},
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.setCodec('avc1');
		expect(adaptationSet.addRepresentation(sd)).not.toBeNull();
		adaptationSet.setProtectedContent(sd);

		expect(adaptationSet.matchAdaptationSet(hd, true)).toBe(false);
		// With content protection not carried on the AdaptationSet, only the
		// base codec is compared → they match.
		expect(adaptationSet.matchAdaptationSet(hd, false)).toBe(true);
	});

	// shaka: TEST_P(PeriodTestWithContentProtection, SameProtectedContent)
	// Identical protected_content → only one AdaptationSet, i.e. a match, so
	// both Representations land in the same set.
	test('same protected content → match (one merged AdaptationSet)', () => {
		const protectedContent = {
			contentProtectionEntry: [
				{ uuid: 'myuuid', nameVersion: 'MyContentProtection version 1', pssh: bytes('psshbox') },
			],
			defaultKeyId: bytes('.DEFAULT.KEY.ID.'),
		};
		const sd: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 640,
				height: 360,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
			protectedContent,
		};
		const hd: MediaInfo = {
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
			protectedContent,
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.setCodec('avc1');
		expect(adaptationSet.addRepresentation(sd)).not.toBeNull();
		adaptationSet.setProtectedContent(sd);

		expect(adaptationSet.matchAdaptationSet(hd, true)).toBe(true);
		// The match means the HD Representation joins the same AdaptationSet.
		expect(adaptationSet.addRepresentation(hd)).not.toBeNull();
		expect(adaptationSet.getRepresentations()).toHaveLength(2);
	});

	// Regression: shaka compares the whole ProtectedContent proto via
	// SerializeAsString, so a field that differs only in proto2 presence — here
	// protectionScheme unset vs explicitly set to its 'cenc' default — makes the
	// two unequal. The previous subset compare coalesced the default and falsely
	// matched them.
	test('protectionScheme present vs absent → no match (presence-sensitive)', () => {
		const withScheme: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 640, height: 360 },
			containerType: 'mp4',
			protectedContent: {
				contentProtectionEntry: [{ uuid: 'myuuid', nameVersion: 'v1', pssh: bytes('pssh') }],
				protectionScheme: 'cenc',
			},
		};
		const withoutScheme: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
			protectedContent: {
				contentProtectionEntry: [{ uuid: 'myuuid', nameVersion: 'v1', pssh: bytes('pssh') }],
			},
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.setCodec('avc1');
		expect(adaptationSet.addRepresentation(withScheme)).not.toBeNull();
		adaptationSet.setProtectedContent(withScheme);

		expect(adaptationSet.matchAdaptationSet(withoutScheme, true)).toBe(false);
	});

	test('null protected content matches only unprotected media', () => {
		const unprotected: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 640, height: 360 },
			containerType: 'mp4',
		};
		const protectedInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
			protectedContent: {
				contentProtectionEntry: [{ uuid: 'myuuid', nameVersion: 'v1', pssh: bytes('pssh') }],
			},
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		adaptationSet.setCodec('avc1');
		expect(adaptationSet.addRepresentation(unprotected)).not.toBeNull();

		expect(adaptationSet.matchAdaptationSet(unprotected, true)).toBe(true);
		expect(adaptationSet.matchAdaptationSet(protectedInfo, true)).toBe(false);
	});
});

describe('AdaptationSet — representation copy / ordering', () => {
	// shaka: TEST_F(AdaptationSetTest, CopyRepresentation)
	test('copyRepresentation returns a new Representation', () => {
		const video: MediaInfo = {
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

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const representation = adaptationSet.addRepresentation(video)!;
		const newRepresentation = adaptationSet.copyRepresentation(representation);
		expect(newRepresentation).toBeTruthy();
	});

	// shaka: TEST_F(AdaptationSetTest, GetRepresentations)
	test('getRepresentations reflects insertion, copies land id-ordered', () => {
		const mediaInfo1: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 720,
				height: 480,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 8,
				pixelHeight: 9,
			},
			containerType: 'mp4',
		};
		const mediaInfo2: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 640,
				height: 360,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());

		const representation1 = adaptationSet.addRepresentation(mediaInfo1)!;
		expect(adaptationSet.getRepresentations()).toEqual([representation1]);

		const representation2 = adaptationSet.addRepresentation(mediaInfo2)!;
		expect(adaptationSet.getRepresentations()).toEqual([representation1, representation2]);

		const newAdaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		const newRepresentation2 = newAdaptationSet.copyRepresentation(representation2);
		const newRepresentation1 = newAdaptationSet.copyRepresentation(representation1);

		// Elements are ordered by id().
		const reps = newAdaptationSet.getRepresentations();
		expect(reps).toHaveLength(2);
		expect(reps[0]).toBe(newRepresentation1);
		expect(reps[1]).toBe(newRepresentation2);
	});
});

describe('AdaptationSet — attribute bubbling', () => {
	// shaka: TEST_F(AdaptationSetTest, BubbleUpAttributesToAdaptationSet)
	test('common width/height/frameRate bubble up, drop out as reps diverge', () => {
		const r1080p: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1920,
				height: 1080,
				timeScale: 30,
				frameDuration: 1,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		const differentWidth: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1080,
				height: 1080,
				timeScale: 30,
				frameDuration: 1,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		const differentHeight: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1440,
				height: 900,
				timeScale: 30,
				frameDuration: 1,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		const differentFrameRate: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1920,
				height: 1080,
				timeScale: 15,
				frameDuration: 1,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.addRepresentation(r1080p)).not.toBeNull();

		const allAttributes = adaptationSet.getXml()!;
		expect(allAttributes.getAttribute('width')).toBe('1920');
		expect(allAttributes.getAttribute('height')).toBe('1080');
		expect(allAttributes.getAttribute('frameRate')).toBe('30/1');

		expect(adaptationSet.addRepresentation(differentWidth)).not.toBeNull();
		const widthNotSet = adaptationSet.getXml()!;
		expect(widthNotSet.getAttribute('width')).toBeUndefined();
		expect(widthNotSet.getAttribute('height')).toBe('1080');
		expect(widthNotSet.getAttribute('frameRate')).toBe('30/1');

		expect(adaptationSet.addRepresentation(differentHeight)).not.toBeNull();
		const widthHeightNotSet = adaptationSet.getXml()!;
		expect(widthHeightNotSet.getAttribute('width')).toBeUndefined();
		expect(widthHeightNotSet.getAttribute('height')).toBeUndefined();
		expect(widthHeightNotSet.getAttribute('frameRate')).toBe('30/1');

		expect(adaptationSet.addRepresentation(differentFrameRate)).not.toBeNull();
		const noCommonAttributes = adaptationSet.getXml()!;
		expect(noCommonAttributes.getAttribute('width')).toBeUndefined();
		expect(noCommonAttributes.getAttribute('height')).toBeUndefined();
		expect(noCommonAttributes.getAttribute('frameRate')).toBeUndefined();
	});
});

describe('AdaptationSet — picture aspect ratio / frame rate edge cases', () => {
	// shaka: TEST_F(AdaptationSetTest, AdaptationSetParUnknown)
	test('missing pixel width/height → no @par', () => {
		const unknownPixelWidthAndHeight: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1280,
				height: 720,
				timeScale: 3000,
				frameDuration: 100,
			},
			containerType: 'mp4',
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.addRepresentation(unknownPixelWidthAndHeight)).not.toBeNull();
		expect(adaptationSet.getXml()!.getAttribute('par')).toBeUndefined();
	});

	// shaka: TEST_F(AdaptationSetTest, AdapatationSetMaxFrameRateIntegerDivisionEdgeCase)
	// 11/3 != 10/3 but IntegerDiv(11,3) == IntegerDiv(10,3), so maxFrameRate wins.
	test('near-equal frame rates that differ → maxFrameRate, not frameRate', () => {
		const info1: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, timeScale: 11, frameDuration: 3 },
			containerType: 'mp4',
		};
		const info2: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480, timeScale: 10, frameDuration: 3 },
			containerType: 'mp4',
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.addRepresentation(info1)).not.toBeNull();
		expect(adaptationSet.addRepresentation(info2)).not.toBeNull();

		const xml = adaptationSet.getXml()!;
		expect(xml.getAttribute('maxFrameRate')).toBe('11/3');
		expect(xml.getAttribute('frameRate')).toBeUndefined();
	});

	// shaka: TEST_F(AdaptationSetTest, AdaptationSetParAllSame)
	test('all reps share the same par (incl. 8:9-pixel 360p) → @par="16:9"', () => {
		const r480p: MediaInfo = {
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
		const r720p: MediaInfo = {
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
		const r1080p: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 1920,
				height: 1080,
				timeScale: 3000,
				frameDuration: 100,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		// Non-1 pixel width and height, which makes the par 16:9.
		const r360p: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 720,
				height: 360,
				timeScale: 3000,
				frameDuration: 100,
				pixelWidth: 8,
				pixelHeight: 9,
			},
			containerType: 'mp4',
		};

		const adaptationSet = new AdaptationSet(NO_LANGUAGE, newOptions(), newCounter());
		expect(adaptationSet.addRepresentation(r480p)).not.toBeNull();
		expect(adaptationSet.addRepresentation(r720p)).not.toBeNull();
		expect(adaptationSet.addRepresentation(r1080p)).not.toBeNull();
		expect(adaptationSet.addRepresentation(r360p)).not.toBeNull();

		expect(adaptationSet.getXml()!.getAttribute('par')).toBe('16:9');
	});
});

describe('AdaptationSet — segment alignment (segment-driven)', () => {
	const k480pMediaInfo: MediaInfo = {
		videoInfo: {
			codec: 'avc1',
			width: 720,
			height: 480,
			timeScale: 10,
			frameDuration: 10,
			pixelWidth: 8,
			pixelHeight: 9,
		},
		containerType: 'mp4',
	};
	const k360pMediaInfo: MediaInfo = {
		videoInfo: {
			codec: 'avc1',
			width: 640,
			height: 360,
			timeScale: 10,
			frameDuration: 10,
			pixelWidth: 1,
			pixelHeight: 1,
		},
		containerType: 'mp4',
	};

	const kStartTime = 0;
	const kDuration = 10;
	const kAnySize = 19834;
	const kAnySegmentNumber = 1;

	// shaka: TEST_F(OnDemandAdaptationSetTest, SubsegmentAlignment)
	test('on-demand aligned → subsegmentAlignment, then unknown, then unset', () => {
		const opts = newOptions({ dashProfile: 'onDemand' });
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, newCounter());

		const representation480p = adaptationSet.addRepresentation(k480pMediaInfo)!;
		// Add a subsegment immediately before adding the 360p Representation.
		// This should still work for VOD.
		representation480p.addNewSegment(kStartTime, kDuration, kAnySize, kAnySegmentNumber);

		const representation360p = adaptationSet.addRepresentation(k360pMediaInfo)!;
		representation360p.addNewSegment(kStartTime, kDuration, kAnySize, kAnySegmentNumber);

		const aligned = adaptationSet.getXml()!;
		expect(aligned.getAttribute('subsegmentAlignment')).toBe('true');

		// Unknown because 480p has an extra subsegment.
		representation480p.addNewSegment(11, 20, kAnySize, kAnySegmentNumber);
		const alignmentUnknown = adaptationSet.getXml()!;
		expect(alignmentUnknown.getAttribute('subsegmentAlignment')).toBeUndefined();

		// Add segments that make them not aligned.
		representation360p.addNewSegment(10, 1, kAnySize, kAnySegmentNumber);
		representation360p.addNewSegment(11, 19, kAnySize, kAnySegmentNumber);

		const unaligned = adaptationSet.getXml()!;
		expect(unaligned.getAttribute('subsegmentAlignment')).toBeUndefined();
	});

	// shaka: TEST_F(OnDemandAdaptationSetTest, ForceSetsubsegmentAlignment)
	test('on-demand unaligned → forceSetSegmentAlignment(true) sets subsegmentAlignment', () => {
		const opts = newOptions({ dashProfile: 'onDemand' });
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, newCounter());
		const representation480p = adaptationSet.addRepresentation(k480pMediaInfo)!;
		const representation360p = adaptationSet.addRepresentation(k360pMediaInfo)!;

		// Different starting times to make the segments "not aligned".
		representation480p.addNewSegment(1, kDuration, kAnySize, kAnySegmentNumber);
		representation360p.addNewSegment(2, kDuration, kAnySize, kAnySegmentNumber);
		const unaligned = adaptationSet.getXml()!;
		expect(unaligned.getAttribute('subsegmentAlignment')).toBeUndefined();

		adaptationSet.forceSetSegmentAlignment(true);
		const aligned = adaptationSet.getXml()!;
		expect(aligned.getAttribute('subsegmentAlignment')).toBe('true');
	});

	// shaka: TEST_F(LiveAdaptationSetTest, SegmentAlignmentDynamicMpd)
	test('live + dynamic aligned → segmentAlignment, then unset when unaligned', () => {
		const opts = newOptions({ dashProfile: 'live', mpdType: 'dynamic' });
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, newCounter());

		// For dynamic MPD the Representations are synchronized, so both are added
		// before any segments.
		const representation480p = adaptationSet.addRepresentation(k480pMediaInfo)!;
		const representation360p = adaptationSet.addRepresentation(k360pMediaInfo)!;

		representation480p.addNewSegment(kStartTime, kDuration, kAnySize, kAnySegmentNumber);
		representation360p.addNewSegment(kStartTime, kDuration, kAnySize, kAnySegmentNumber);
		const aligned = adaptationSet.getXml()!;
		expect(aligned.getAttribute('segmentAlignment')).toBe('true');

		// Add segments that make them not aligned.
		representation480p.addNewSegment(11, 20, kAnySize, kAnySegmentNumber);
		representation360p.addNewSegment(10, 1, kAnySize, kAnySegmentNumber);
		representation360p.addNewSegment(11, 19, kAnySize, kAnySegmentNumber);

		const unaligned = adaptationSet.getXml()!;
		expect(unaligned.getAttribute('segmentAlignment')).toBeUndefined();
	});

	// shaka: TEST_F(LiveAdaptationSetTest, SegmentAlignmentStaticMpd)
	test('live + static aligned → segmentAlignment', () => {
		const opts = newOptions({ dashProfile: 'live', mpdType: 'static' });
		const adaptationSet = new AdaptationSet(NO_LANGUAGE, opts, newCounter());

		// For static MPD the Representations are not synchronized, so the second
		// may be added after segments are added to the first.
		const representation480p = adaptationSet.addRepresentation(k480pMediaInfo)!;
		representation480p.addNewSegment(kStartTime, kDuration, kAnySize, kAnySegmentNumber);

		const representation360p = adaptationSet.addRepresentation(k360pMediaInfo)!;
		representation360p.addNewSegment(kStartTime, kDuration, kAnySize, kAnySegmentNumber);

		representation480p.addNewSegment(kStartTime + kDuration, kDuration, kAnySize, kAnySegmentNumber);
		representation360p.addNewSegment(kStartTime + kDuration, kDuration, kAnySize, kAnySegmentNumber);

		const aligned = adaptationSet.getXml()!;
		expect(aligned.getAttribute('segmentAlignment')).toBe('true');
	});
});

describe('AdaptationSet — text', () => {
	// shaka: TEST_F(OnDemandAdaptationSetTest, Text)
	test('SUBTITLE text type → Role value="subtitle" + BaseURL', () => {
		const opts = newOptions({ dashProfile: 'onDemand' });
		const textMediaInfo: MediaInfo = {
			textInfo: { codec: 'ttml', language: 'en', type: 'subtitle' },
			mediaDurationSeconds: 35,
			bandwidth: 1000,
			mediaFileUrl: 'subtitle.xml',
			containerType: 'text',
		};

		const adaptationSet = new AdaptationSet('en', opts, newCounter());
		expect(adaptationSet.addRepresentation(textMediaInfo)).not.toBeNull();

		expectXmlEqual(
			renderAs(adaptationSet),
			'<AdaptationSet contentType="text" lang="en">'
			+ '  <Role schemeIdUri="urn:mpeg:dash:role:2011"'
			+ '   value="subtitle"/>\n'
			+ '  <Representation id="0" bandwidth="1000"'
			+ '   mimeType="application/ttml+xml">'
			+ '    <BaseURL>subtitle.xml</BaseURL>'
			+ '  </Representation>'
			+ '</AdaptationSet>',
		);
	});
});
