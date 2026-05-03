/*!
 * Test cases for the DASH Representation port. Where shaka has equivalent
 * unit tests they are referenced inline by name and the expected XML strings
 * are pasted verbatim from shaka's `representation_unittest.cc`. Verified
 * with the tree-aware xmlEqual matcher.
 *
 * Original test source: shaka-packager packager/mpd/base/representation_unittest.cc
 */
import { describe, expect, test, vi } from 'vitest';
import type { MediaInfo } from '../../src/dash/dash-media-info.js';
import {
	Representation,
	type RepresentationStateChangeListener,
	SuppressFlag,
} from '../../src/dash/dash-representation.js';
import {
	createDefaultMpdOptions,
	type MpdOptions,
} from '../../src/dash/dash-types.js';
import { expectXmlEqual } from './_xml-equal.js';

const REPRESENTATION_ID = 1;

const newOptions = (overrides: Partial<MpdOptions> = {}): MpdOptions => ({
	...createDefaultMpdOptions(),
	...overrides,
});

const renderXml = (rep: Representation): string => {
	const node = rep.getXml();
	if (!node) {
		throw new Error('getXml() returned null');
	}
	return node.toString();
};

describe('Representation — init() validation', () => {
	// shaka: TEST_F(RepresentationTest, ValidMediaInfo)
	test('valid video MediaInfo passes init()', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: {
				codec: 'avc1',
				width: 720,
				height: 480,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
	});

	// shaka: TEST_F(RepresentationTest, VideoAudioTextInfoNotSet)
	test('init() fails when none of video / audio / text info is set', () => {
		const mediaInfo: MediaInfo = { containerType: 'mp4' };
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(false);
	});

	// shaka: TEST_F(RepresentationTest, VideoAndAudioInfoSet)
	test('init() fails when both video and audio info are set', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', height: 480, timeScale: 10, frameDuration: 10 },
			audioInfo: { codec: 'mp4a.40.2', samplingFrequency: 44100, timeScale: 1200, numChannels: 2 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(false);
	});

	// shaka: TEST_F(RepresentationTest, InvalidMediaInfo)
	test('init() fails when video width is missing', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', height: 480, timeScale: 10, frameDuration: 10, pixelWidth: 1, pixelHeight: 1 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(false);
	});

	test('init() fails when container_type is unknown', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 720, height: 480 },
			containerType: 'unknown',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(false);
	});
});

describe('Representation — getXml() basic emission', () => {
	// shaka: TEST_F(RepresentationTest, CheckVideoInfoReflectedInXml)
	test('video info reflected in XML', () => {
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
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		expectXmlEqual(
			renderXml(rep),
			'<Representation id="1" bandwidth="0"'
			+ ' codecs="avc1" mimeType="video/mp4"'
			+ ' sar="1:1" width="1280" height="720"'
			+ ' frameRate="10/10"/>',
		);
	});

	// shaka: TEST_F(RepresentationTest, CheckVideoInfoVp8CodecInMp4)
	test('VP8 codec passes through unchanged in MP4', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: {
				codec: 'vp08.00.00.08.01.01.00.00',
				width: 1280,
				height: 720,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		const node = rep.getXml()!;
		expect(node.getAttribute('codecs')).toBe('vp08.00.00.08.01.01.00.00');
	});

	// shaka: TEST_F(RepresentationTest, CheckVideoInfoVp8CodecInWebm) — VP8 in WebM rewrites to "vp8"
	test('VP8 codec in WebM rewrites to "vp8"', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: {
				codec: 'vp08.00.00.08.01.01.00.00',
				width: 1280,
				height: 720,
				timeScale: 10,
				frameDuration: 10,
				pixelWidth: 1,
				pixelHeight: 1,
			},
			containerType: 'webm',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		const node = rep.getXml()!;
		expect(node.getAttribute('codecs')).toBe('vp8');
	});

	// shaka: TEST_F(RepresentationTest, TtmlMp4MimeType)
	test('TTML in MP4 emits mimeType=application/mp4', () => {
		const mediaInfo: MediaInfo = {
			textInfo: { codec: 'ttml' },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		const node = rep.getXml()!;
		expect(node.getAttribute('mimeType')).toBe('application/mp4');
	});

	// shaka: TEST_F(RepresentationTest, TtmlXmlMimeType)
	test('TTML in text container emits mimeType=application/ttml+xml', () => {
		const mediaInfo: MediaInfo = {
			textInfo: { codec: 'ttml' },
			containerType: 'text',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		const node = rep.getXml()!;
		expect(node.getAttribute('mimeType')).toBe('application/ttml+xml');
	});

	// shaka: TEST_F(RepresentationTest, WebVttMimeType)
	test('WebVTT in text container emits mimeType=text/vtt', () => {
		const mediaInfo: MediaInfo = {
			textInfo: { codec: 'wvtt' },
			containerType: 'text',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		const node = rep.getXml()!;
		expect(node.getAttribute('mimeType')).toBe('text/vtt');
	});

	// shaka: TEST_F(RepresentationTest, CheckRepresentationId)
	test('id attribute matches the constructor argument', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), 42);
		expect(rep.init()).toBe(true);
		expect(rep.id()).toBe(42);
		expect(rep.getXml()!.getAttribute('id')).toBe('42');
	});

	// shaka: TEST_F(RepresentationTest, SuppressRepresentationAttributes)
	test('suppressOnce(WIDTH | HEIGHT) hides those attributes for one getXml() call', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		rep.suppressOnce(SuppressFlag.WIDTH | SuppressFlag.HEIGHT);
		const first = rep.getXml()!;
		expect(first.getAttribute('width')).toBeUndefined();
		expect(first.getAttribute('height')).toBeUndefined();
		// Subsequent calls reset the flags.
		const second = rep.getXml()!;
		expect(second.getAttribute('width')).toBe('1280');
		expect(second.getAttribute('height')).toBe('720');
	});

	test('suppressOnce(FRAME_RATE) hides only frameRate', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		rep.init();
		rep.suppressOnce(SuppressFlag.FRAME_RATE);
		const node = rep.getXml()!;
		expect(node.getAttribute('frameRate')).toBeUndefined();
		expect(node.getAttribute('width')).toBe('1280');
	});
});

describe('Representation — supplemental codecs / profiles', () => {
	test('Dolby Vision supplemental codec + brand emit scte214 attributes', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: {
				codec: 'hvc1.2.4.L150.B0',
				width: 3840,
				height: 2160,
				timeScale: 30000,
				frameDuration: 1001,
				supplementalCodec: 'dvh1.08.07',
				compatibleBrand: 0x64623467, // 'db4g'
			},
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		const node = rep.getXml()!;
		expect(node.getAttribute('scte214:supplementalCodecs')).toBe('dvh1.08.07');
		expect(node.getAttribute('scte214:supplementalProfiles')).toBe('db4g');
	});
});

describe('Representation — segment management', () => {
	test('addNewSegment with start_time=0 and duration=0 is a no-op', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
			referenceTimeScale: 90000,
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		rep.addNewSegment(0, 0, 1000, 1);
		expect(rep.getStartAndEndTimestamps()).toBeNull();
	});

	test('addNewSegment populates segment_infos and getStartAndEndTimestamps', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
			referenceTimeScale: 90000,
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		// Three contiguous, equal-duration segments → a single SegmentInfo with repeat=2.
		rep.addNewSegment(0, 90000 * 4, 1_000_000, 1);
		rep.addNewSegment(90000 * 4, 90000 * 4, 1_000_000, 2);
		rep.addNewSegment(90000 * 8, 90000 * 4, 1_000_000, 3);
		const ts = rep.getStartAndEndTimestamps()!;
		expect(ts.start).toBe(0);
		expect(ts.end).toBe(12);
	});

	test('contiguous segments with mismatched duration produce a second SegmentInfo', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
			referenceTimeScale: 90000,
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		rep.addNewSegment(0, 90000 * 4, 1_000_000, 1);
		rep.addNewSegment(90000 * 4, 90000 * 5, 1_000_000, 2);
		const ts = rep.getStartAndEndTimestamps()!;
		expect(ts.start).toBe(0);
		expect(ts.end).toBe(9);
	});
});

describe('Representation — state change listener', () => {
	test('onNewSegmentForRepresentation fires for each addNewSegment', () => {
		const listener: RepresentationStateChangeListener = {
			onNewSegmentForRepresentation: vi.fn(),
			onSetFrameRateForRepresentation: vi.fn(),
		};
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 10, frameDuration: 10 },
			containerType: 'mp4',
			referenceTimeScale: 90000,
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID, listener);
		rep.addNewSegment(0, 90000 * 4, 1_000_000, 1);
		const fn = listener.onNewSegmentForRepresentation;
		expect(fn).toHaveBeenCalledWith(0, 90000 * 4);
	});

	test('onSetFrameRateForRepresentation fires from setSampleDuration', () => {
		const listener: RepresentationStateChangeListener = {
			onNewSegmentForRepresentation: vi.fn(),
			onSetFrameRateForRepresentation: vi.fn(),
		};
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720, timeScale: 90000 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID, listener);
		rep.setSampleDuration(3000);
		const fn = listener.onSetFrameRateForRepresentation;
		expect(fn).toHaveBeenCalledWith(3000, 90000);
	});
});

describe('Representation — content protection', () => {
	test('addContentProtectionElement removes duplicate value/schemeIdUri attributes', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: { codec: 'avc1', width: 1280, height: 720 },
			containerType: 'mp4',
		};
		const rep = new Representation(mediaInfo, newOptions(), REPRESENTATION_ID);
		rep.init();
		rep.addContentProtectionElement({
			value: 'WV',
			schemeIdUri: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
			additionalAttributes: new Map([
				['value', 'duplicate'],
				['schemeIdUri', 'duplicate'],
				['cenc:default_KID', 'kept'],
			]),
			subelements: [],
		});
		const xml = renderXml(rep);
		expectXmlEqual(
			xml,
			'<Representation id="1" bandwidth="0" codecs="avc1" mimeType="video/mp4" width="1280" height="720">'
			+ '  <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'
			+ '                     value="WV" cenc:default_KID="kept"/>'
			+ '</Representation>',
		);
	});
});
