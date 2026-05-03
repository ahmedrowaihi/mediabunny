/*!
 * Test cases for the DASH mpd_utils port. Where shaka has equivalent unit
 * tests they are referenced inline by name. The shaka mpd_utils_unittest.cc
 * focuses on AddContentProtectionElements (Phase 3+ when entities exist);
 * the pure helpers below get coverage via these tests instead.
 */
import { describe, expect, test } from 'vitest';
import type { ContentProtectionElement } from '../../src/dash/dash-content-protection.js';
import {
	atLeastOneTrue,
	floatToXmlString,
	getAdaptationSetKey,
	getBaseCodec,
	getCodecs,
	getDurationAttribute,
	getLanguage,
	getSupplementalCodecs,
	getSupplementalProfiles,
	hasLiveOnlyFields,
	hasVodOnlyFields,
	hexToUUID,
	moreThanOneTrue,
	onlyOneTrue,
	removeDuplicateAttributes,
	secondsToXmlDuration,
	TRANSFER_FUNCTION_PQ,
	updateContentProtectionPsshHelper,
} from '../../src/dash/dash-mpd-utils.js';
import { XmlNode } from '../../src/dash/dash-xml-node.js';

describe('floatToXmlString', () => {
	test('integer renders without decimal point', () => {
		expect(floatToXmlString(1)).toBe('1');
		expect(floatToXmlString(0)).toBe('0');
	});

	test('half renders as 0.5 (trailing zeros trimmed)', () => {
		expect(floatToXmlString(0.5)).toBe('0.5');
	});

	test('preserves up to 6 decimals', () => {
		expect(floatToXmlString(1.234567)).toBe('1.234567');
	});

	test('rounds beyond 6 decimals', () => {
		expect(floatToXmlString(1.2345678)).toBe('1.234568');
	});

	test('negative values keep sign', () => {
		expect(floatToXmlString(-2.5)).toBe('-2.5');
	});
});

describe('secondsToXmlDuration', () => {
	test('formats with PT...S wrapper', () => {
		expect(secondsToXmlDuration(0)).toBe('PT0S');
		expect(secondsToXmlDuration(12.345)).toBe('PT12.345S');
		expect(secondsToXmlDuration(3600)).toBe('PT3600S');
	});
});

describe('boolean helpers', () => {
	test('moreThanOneTrue', () => {
		expect(moreThanOneTrue(false, false, false)).toBe(false);
		expect(moreThanOneTrue(true, false, false)).toBe(false);
		expect(moreThanOneTrue(false, true, false)).toBe(false);
		expect(moreThanOneTrue(false, false, true)).toBe(false);
		expect(moreThanOneTrue(true, true, false)).toBe(true);
		expect(moreThanOneTrue(true, false, true)).toBe(true);
		expect(moreThanOneTrue(false, true, true)).toBe(true);
		expect(moreThanOneTrue(true, true, true)).toBe(true);
	});

	test('atLeastOneTrue', () => {
		expect(atLeastOneTrue(false, false, false)).toBe(false);
		expect(atLeastOneTrue(true, false, false)).toBe(true);
		expect(atLeastOneTrue(false, true, false)).toBe(true);
		expect(atLeastOneTrue(false, false, true)).toBe(true);
		expect(atLeastOneTrue(true, true, true)).toBe(true);
	});

	test('onlyOneTrue', () => {
		expect(onlyOneTrue(false, false, false)).toBe(false);
		expect(onlyOneTrue(true, false, false)).toBe(true);
		expect(onlyOneTrue(false, true, false)).toBe(true);
		expect(onlyOneTrue(false, false, true)).toBe(true);
		expect(onlyOneTrue(true, true, false)).toBe(false);
		expect(onlyOneTrue(true, true, true)).toBe(false);
	});
});

describe('hexToUUID', () => {
	test('formats 16 bytes into 8-4-4-4-12 lowercase UUID', () => {
		const bytes = new Uint8Array([
			0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce,
			0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed,
		]);
		expect(hexToUUID(bytes)).toBe('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
	});

	test('returns null when length is not 16', () => {
		expect(hexToUUID(new Uint8Array(15))).toBeNull();
		expect(hexToUUID(new Uint8Array(17))).toBeNull();
		expect(hexToUUID(new Uint8Array(0))).toBeNull();
	});
});

describe('hasVodOnlyFields / hasLiveOnlyFields', () => {
	test('VOD: media_file_url marks the info as VOD', () => {
		expect(hasVodOnlyFields({ mediaFileUrl: 'foo.mp4' })).toBe(true);
		expect(hasLiveOnlyFields({ mediaFileUrl: 'foo.mp4' })).toBe(false);
	});

	test('VOD: init_range / index_range mark VOD', () => {
		expect(hasVodOnlyFields({ initRange: { begin: 0, end: 100 } })).toBe(true);
		expect(hasVodOnlyFields({ indexRange: { begin: 100, end: 200 } })).toBe(true);
	});

	test('LIVE: init_segment_url / segment_template_url mark LIVE', () => {
		expect(hasLiveOnlyFields({ initSegmentUrl: 'init.m4s' })).toBe(true);
		expect(hasLiveOnlyFields({ segmentTemplateUrl: 'seg-$Number$.m4s' })).toBe(true);
		expect(hasVodOnlyFields({ initSegmentUrl: 'init.m4s' })).toBe(false);
	});

	test('empty media info has neither flag set', () => {
		expect(hasVodOnlyFields({})).toBe(false);
		expect(hasLiveOnlyFields({})).toBe(false);
	});
});

describe('getLanguage', () => {
	test('audio language preferred over text', () => {
		expect(getLanguage({ audioInfo: { language: 'eng' }, textInfo: { language: 'spa' } })).toBe('en');
	});

	test('text language used when no audio', () => {
		expect(getLanguage({ textInfo: { language: 'spa' } })).toBe('es');
	});

	test('returns empty for video-only', () => {
		expect(getLanguage({ videoInfo: { codec: 'avc1' } })).toBe('');
	});

	test('passes through unknown 3-letter codes', () => {
		expect(getLanguage({ audioInfo: { language: 'mis' } })).toBe('mis');
	});
});

describe('getCodecs / getBaseCodec / getSupplementalCodecs / getSupplementalProfiles', () => {
	test('video codec passthrough', () => {
		expect(getCodecs({ videoInfo: { codec: 'avc1.640028' } })).toBe('avc1.640028');
	});

	test('audio codec passthrough', () => {
		expect(getCodecs({ audioInfo: { codec: 'mp4a.40.2' } })).toBe('mp4a.40.2');
	});

	test('text in MP4 rewrites ttml → stpp', () => {
		expect(getCodecs({
			textInfo: { codec: 'ttml' },
			containerType: 'mp4',
		})).toBe('stpp');
	});

	test('text in text container returns empty', () => {
		expect(getCodecs({
			textInfo: { codec: 'ttml' },
			containerType: 'text',
		})).toBe('');
	});

	test('webm vp08 → vp8 legacy rewrite', () => {
		expect(getCodecs({
			videoInfo: { codec: 'vp08.00.10.08' },
			containerType: 'webm',
		})).toBe('vp8');
	});

	test('webm vp09 left untouched (legacy flag off by default)', () => {
		expect(getCodecs({
			videoInfo: { codec: 'vp09.00.10.08' },
			containerType: 'webm',
		})).toBe('vp09.00.10.08');
	});

	test('getBaseCodec strips profile/level after first dot', () => {
		expect(getBaseCodec({ videoInfo: { codec: 'avc1.640028' } })).toBe('avc1');
		expect(getBaseCodec({ audioInfo: { codec: 'mp4a.40.2' } })).toBe('mp4a');
		expect(getBaseCodec({ videoInfo: { codec: 'hvc1' } })).toBe('hvc1');
	});

	test('getSupplementalCodecs returns Dolby Vision supplemental codec when present', () => {
		expect(getSupplementalCodecs({
			videoInfo: { codec: 'hvc1', supplementalCodec: 'dvh1.08.07' },
		})).toBe('dvh1.08.07');
	});

	test('getSupplementalProfiles returns FourCC string of compatible_brand', () => {
		expect(getSupplementalProfiles({
			videoInfo: { codec: 'hvc1', compatibleBrand: 0x64623467 },
		})).toBe('db4g');
	});

	test('getCodecs throws when more than one of {video,audio,text} is set', () => {
		expect(() => getCodecs({
			videoInfo: { codec: 'avc1' },
			audioInfo: { codec: 'mp4a' },
		})).toThrow();
	});
});

describe('getAdaptationSetKey', () => {
	test('video: type:label:container:codec:transfer:lang', () => {
		const key = getAdaptationSetKey({
			videoInfo: {
				codec: 'avc1.640028',
				transferCharacteristics: 1,
			},
			containerType: 'mp4',
			dashLabel: 'main',
		}, false);
		expect(key).toBe('video:main:CONTAINER_MP4:avc1:1:');
	});

	test('audio: type:container:codec:lang (no transfer)', () => {
		const key = getAdaptationSetKey({
			audioInfo: {
				codec: 'mp4a.40.2',
				language: 'eng',
			},
			containerType: 'mp4',
		}, false);
		expect(key).toBe('audio:CONTAINER_MP4:mp4a:en');
	});

	test('text: TextType_Name:container:codec:lang', () => {
		const key = getAdaptationSetKey({
			textInfo: {
				codec: 'wvtt',
				language: 'eng',
				type: 'subtitle',
			},
			containerType: 'mp4',
		}, false);
		expect(key).toBe('SUBTITLE:CONTAINER_MP4:wvtt:en');
	});

	test('Dolby Vision (dvh*) forces transfer characteristics to PQ', () => {
		const key = getAdaptationSetKey({
			videoInfo: {
				codec: 'dvh1.08.07',
				transferCharacteristics: 14,
			},
			containerType: 'mp4',
		}, false);
		expect(key).toBe(`video:CONTAINER_MP4:dvh1:${TRANSFER_FUNCTION_PQ}:`);
	});

	test('ignoreCodec drops codec + transfer characteristics', () => {
		const key = getAdaptationSetKey({
			videoInfo: { codec: 'avc1', transferCharacteristics: 1 },
			containerType: 'mp4',
		}, true);
		expect(key).toBe('video:CONTAINER_MP4:');
	});

	test('trick play marker appears when playback_rate is set', () => {
		const key = getAdaptationSetKey({
			videoInfo: { codec: 'avc1', playbackRate: 4 },
			containerType: 'mp4',
		}, false);
		expect(key).toContain(':trick_play');
	});

	test('accessibility / roles suffixes', () => {
		const key = getAdaptationSetKey({
			audioInfo: { codec: 'mp4a' },
			containerType: 'mp4',
			dashAccessibilities: ['urn:tva:metadata:cs:AudioPurposeCS:2007=1'],
			dashRoles: ['caption', 'main'],
		}, false);
		expect(key).toContain(':accessibility_urn:tva:metadata:cs:AudioPurposeCS:2007=1');
		expect(key).toContain(':roles_captionmain');
	});
});

describe('removeDuplicateAttributes', () => {
	test('strips duplicate value/schemeIdUri from additionalAttributes when set', () => {
		const cp: ContentProtectionElement = {
			value: 'WV',
			schemeIdUri: 'urn:uuid:edef8ba9',
			additionalAttributes: new Map([
				['value', 'will-be-removed'],
				['schemeIdUri', 'will-be-removed'],
				['cenc:default_KID', 'keep-me'],
			]),
			subelements: [],
		};
		removeDuplicateAttributes(cp);
		expect(cp.additionalAttributes.get('value')).toBeUndefined();
		expect(cp.additionalAttributes.get('schemeIdUri')).toBeUndefined();
		expect(cp.additionalAttributes.get('cenc:default_KID')).toBe('keep-me');
	});

	test('leaves additionalAttributes alone when top-level fields are empty', () => {
		const cp: ContentProtectionElement = {
			value: '',
			schemeIdUri: '',
			additionalAttributes: new Map([['value', 'kept']]),
			subelements: [],
		};
		removeDuplicateAttributes(cp);
		expect(cp.additionalAttributes.get('value')).toBe('kept');
	});
});

describe('updateContentProtectionPsshHelper', () => {
	test('adds an empty ContentProtection when none exists for the DRM uuid', () => {
		const list: ContentProtectionElement[] = [];
		updateContentProtectionPsshHelper('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', new Uint8Array(), list);
		expect(list).toHaveLength(1);
		expect(list[0]!.schemeIdUri).toBe('urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
		expect(list[0]!.subelements).toEqual([]);
	});

	test('removes existing pssh subelement (mirroring shaka behaviour for player compat)', () => {
		const list: ContentProtectionElement[] = [{
			value: '',
			schemeIdUri: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
			additionalAttributes: new Map(),
			subelements: [
				{ name: 'cenc:pssh', attributes: new Map(), content: 'old', subelements: [] },
			],
		}];
		updateContentProtectionPsshHelper('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', new Uint8Array(), list);
		expect(list[0]!.subelements).toEqual([]);
	});

	test('leaves unrelated DRM ContentProtection untouched', () => {
		const list: ContentProtectionElement[] = [{
			value: '',
			schemeIdUri: 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
			additionalAttributes: new Map(),
			subelements: [
				{ name: 'cenc:pssh', attributes: new Map(), content: 'pr-pssh', subelements: [] },
			],
		}];
		updateContentProtectionPsshHelper('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', new Uint8Array(), list);
		// Unchanged PlayReady + new empty Widevine
		expect(list).toHaveLength(2);
		expect(list[0]!.subelements).toHaveLength(1);
	});
});

describe('getDurationAttribute', () => {
	test('returns parsed float from duration attribute', () => {
		const node = new XmlNode('S');
		node.setStringAttribute('duration', '4.5');
		expect(getDurationAttribute(node)).toBe(4.5);
	});

	test('returns null when attribute is absent', () => {
		const node = new XmlNode('S');
		expect(getDurationAttribute(node)).toBeNull();
	});

	test('returns null when attribute is unparsable', () => {
		const node = new XmlNode('S');
		node.setStringAttribute('duration', 'not-a-number');
		expect(getDurationAttribute(node)).toBeNull();
	});
});
