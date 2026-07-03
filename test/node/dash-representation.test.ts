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
	createDefaultMpdParams,
	type MpdOptions,
} from '../../src/dash/dash-types.js';
import { BandwidthEstimator } from '../../src/hls/hls-bandwidth-estimator.js';
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

describe('Representation — approximate SegmentTimeline', () => {
	// shaka: ApproximateSegmentTimelineTest fixture constants.
	// kScaledTargetSegmentDuration = 10, kDefaultTimeScale = 1000,
	// kTargetSegmentDurationInSeconds = 10 / 1000 = 0.01, kSampleDuration = 2.
	// 0.01 * 1000 = 10.000000000000002 in JS floats — the value that must be
	// truncated to 10 to mirror shaka's int64 cast.
	const SAMPLE_DURATION = 2;
	const SCALED_TARGET = 10;
	const TARGET_SEGMENT_DURATION_SECONDS = 0.01;

	const approxVideoMediaInfo = (): MediaInfo => ({
		videoInfo: {
			codec: 'avc1.010101',
			width: 720,
			height: 480,
			timeScale: 10,
			frameDuration: 2,
			pixelWidth: 1,
			pixelHeight: 1,
		},
		referenceTimeScale: 1000,
		containerType: 'mp4',
		initSegmentUrl: 'init.mp4',
		segmentTemplateUrl: '$Number$.mp4',
	});

	const approxOptions = (allowApproximate: boolean): MpdOptions => newOptions({
		mpdType: 'dynamic',
		mpdParams: {
			...createDefaultMpdParams(),
			targetSegmentDuration: TARGET_SEGMENT_DURATION_SECONDS,
			allowApproximateSegmentTimeline: allowApproximate,
		},
	});

	const createApproxRep = (allowApproximate: boolean, mediaInfo = approxVideoMediaInfo()): Representation => {
		const rep = new Representation(mediaInfo, approxOptions(allowApproximate), REPRESENTATION_ID);
		expect(rep.init()).toBe(true);
		rep.setSampleDuration(SAMPLE_DURATION);
		return rep;
	};

	// Mirrors SegmentTimelineTestBase::ExpectedXml (frameRate="10/2").
	const expectedVideoXml = (bandwidth: number, sElements: string): string =>
		`<Representation id="1" bandwidth="${bandwidth}"`
		+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
		+ ' width="720" height="480" frameRate="10/2">'
		+ '  <SegmentTemplate timescale="1000" initialization="init.mp4"'
		+ '   media="$Number$.mp4" startNumber="1">'
		+ `    <SegmentTimeline>${sElements}</SegmentTimeline>`
		+ '  </SegmentTemplate>'
		+ '</Representation>';

	// shaka instantiates the fixture with Bool() → both param values.
	for (const allowApproximate of [true, false]) {
		const suffix = `(allowApproximateSegmentTimeline=${allowApproximate})`;

		// shaka: TEST_P(ApproximateSegmentTimelineTest, SegmentDurationAdjusted)
		test(`SegmentDurationAdjusted ${suffix}`, () => {
			const kStartTime = 0;
			const kDurationSmaller = SCALED_TARGET - SAMPLE_DURATION / 2;
			const rep = createApproxRep(allowApproximate);
			rep.addNewSegment(kStartTime, kDurationSmaller, 128, 1);

			const sElements = allowApproximate
				? '<S t="0" d="10"/>'
				: '<S t="0" d="9"/>';
			expectXmlEqual(renderXml(rep), expectedVideoXml(113778, sElements));
		});

		// shaka: TEST_P(ApproximateSegmentTimelineTest, SegmentDurationAdjustedWithNonZeroStartTime)
		test(`SegmentDurationAdjustedWithNonZeroStartTime ${suffix}`, () => {
			const kStartTime = 12345;
			const kDurationSmaller = SCALED_TARGET - SAMPLE_DURATION / 2;
			const rep = createApproxRep(allowApproximate);
			rep.addNewSegment(kStartTime, kDurationSmaller, 128, 1);

			const sElements = allowApproximate
				? '<S t="12345" d="10"/>'
				: '<S t="12345" d="9"/>';
			expectXmlEqual(renderXml(rep), expectedVideoXml(113778, sElements));
		});

		// shaka: TEST_P(ApproximateSegmentTimelineTest, SegmentsWithSimilarDurations)
		test(`SegmentsWithSimilarDurations ${suffix}`, () => {
			const kStartTime = 0;
			const kDurationSmaller = SCALED_TARGET - SAMPLE_DURATION / 2;
			const kDurationLarger = SCALED_TARGET + SAMPLE_DURATION / 2;
			const rep = createApproxRep(allowApproximate);
			rep.addNewSegment(kStartTime, kDurationSmaller, 128, 1);
			rep.addNewSegment(kStartTime + kDurationSmaller, kDurationLarger, 128, 2);
			rep.addNewSegment(kStartTime + kDurationSmaller + kDurationLarger, kDurationSmaller, 128, 3);

			const sElements = allowApproximate
				? '<S t="0" d="10" r="2"/>'
				: '<S t="0" d="9"/><S t="9" d="11"/><S t="20" d="9"/>';
			expectXmlEqual(renderXml(rep), expectedVideoXml(113778, sElements));
		});

		// shaka: TEST_P(ApproximateSegmentTimelineTest, SegmentsWithSimilarDurations2)
		test(`SegmentsWithSimilarDurations2 ${suffix}`, () => {
			const kStartTime = 0;
			const kDurationLarger = SCALED_TARGET + SAMPLE_DURATION / 2;
			const rep = createApproxRep(allowApproximate);
			rep.addNewSegment(kStartTime, kDurationLarger, 128, 1);
			rep.addNewSegment(kStartTime + kDurationLarger, kDurationLarger, 128, 2);
			rep.addNewSegment(kStartTime + 2 * kDurationLarger, kDurationLarger, 128, 3);

			const sElements = allowApproximate
				? '<S t="0" d="10" r="1"/><S t="20" d="13"/>'
				: '<S t="0" d="11" r="2"/>';
			expectXmlEqual(renderXml(rep), expectedVideoXml(93091, sElements));
		});

		// shaka: TEST_P(ApproximateSegmentTimelineTest, FillSmallGap)
		test(`FillSmallGap ${suffix}`, () => {
			const kStartTime = 0;
			const kDuration = SCALED_TARGET;
			const kGap = SAMPLE_DURATION / 2;
			const rep = createApproxRep(allowApproximate);
			rep.addNewSegment(kStartTime, kDuration, 128, 1);
			rep.addNewSegment(kStartTime + kDuration + kGap, kDuration, 128, 2);
			rep.addNewSegment(kStartTime + 2 * kDuration + kGap, kDuration, 128, 3);

			const sElements = allowApproximate
				? '<S t="0" d="10" r="2"/>'
				: '<S t="0" d="10"/><S t="11" d="10" r="1"/>';
			expectXmlEqual(renderXml(rep), expectedVideoXml(102400, sElements));
		});

		// shaka: TEST_P(ApproximateSegmentTimelineTest, FillSmallOverlap)
		test(`FillSmallOverlap ${suffix}`, () => {
			const kStartTime = 0;
			const kDuration = SCALED_TARGET;
			const kOverlap = SAMPLE_DURATION / 2;
			const rep = createApproxRep(allowApproximate);
			rep.addNewSegment(kStartTime, kDuration, 128, 1);
			rep.addNewSegment(kStartTime + kDuration - kOverlap, kDuration, 128, 2);
			rep.addNewSegment(kStartTime + 2 * kDuration - kOverlap, kDuration, 128, 3);

			const sElements = allowApproximate
				? '<S t="0" d="10" r="2"/>'
				: '<S t="0" d="10"/><S t="9" d="10" r="1"/>';
			expectXmlEqual(renderXml(rep), expectedVideoXml(102400, sElements));
		});

		// shaka: TEST_P(ApproximateSegmentTimelineTest, NoSampleDuration)
		// Text stream with no sample duration (frameDuration stays 0) — segments
		// must still group when durations match exactly.
		// See shaka-project/shaka-packager#417.
		test(`NoSampleDuration ${suffix}`, () => {
			const textMediaInfo: MediaInfo = {
				textInfo: { codec: 'wvtt' },
				referenceTimeScale: 1000,
				containerType: 'mp4',
				initSegmentUrl: 'init.mp4',
				segmentTemplateUrl: '$Number$.mp4',
			};
			// shaka recreates the representation here WITHOUT SetSampleDuration.
			const rep = new Representation(textMediaInfo, approxOptions(allowApproximate), REPRESENTATION_ID);
			expect(rep.init()).toBe(true);

			const kDuration = SCALED_TARGET;
			rep.addNewSegment(0, kDuration, 128, 1);
			rep.addNewSegment(kDuration, kDuration, 128, 2);
			rep.addNewSegment(2 * kDuration, kDuration, 128, 3);

			expectXmlEqual(
				renderXml(rep),
				'<Representation id="1" bandwidth="102400" codecs="wvtt" mimeType="application/mp4">'
				+ '  <SegmentTemplate timescale="1000" initialization="init.mp4"'
				+ '   media="$Number$.mp4" startNumber="1">'
				+ '    <SegmentTimeline><S t="0" d="10" r="2"/></SegmentTimeline>'
				+ '  </SegmentTemplate>'
				+ '</Representation>',
			);
		});
	}
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

// shaka: representation_unittest.cc anonymous-namespace fixture constants.
// kDefaultTimeScale = 1000, kScaledTargetSegmentDuration = 10,
// kTargetSegmentDurationInSeconds = 10 / 1000, kSampleDuration = 2.
const DEFAULT_TIME_SCALE = 1000;
const SCALED_TARGET_SEGMENT_DURATION = 10;
const TARGET_SEGMENT_DURATION_SECONDS = SCALED_TARGET_SEGMENT_DURATION / DEFAULT_TIME_SCALE;
const DEFAULT_START_NUMBER = 1;

// shaka: GetDefaultMediaInfo() — SegmentTemplateTest fixture ($Time$, frame_duration 5).
const segmentTemplateMediaInfo = (): MediaInfo => ({
	videoInfo: {
		codec: 'avc1.010101',
		width: 720,
		height: 480,
		timeScale: 10,
		frameDuration: 5,
		pixelWidth: 1,
		pixelHeight: 1,
	},
	referenceTimeScale: DEFAULT_TIME_SCALE,
	containerType: 'mp4',
	initSegmentUrl: 'init.mp4',
	segmentTemplateUrl: '$Time$.mp4',
});

// shaka: SegmentTimelineTestBase fixture — same as above but $Number$ template and
// frame_duration 2.
const segmentTimelineMediaInfo = (): MediaInfo => ({
	videoInfo: {
		codec: 'avc1.010101',
		width: 720,
		height: 480,
		timeScale: 10,
		frameDuration: 2,
		pixelWidth: 1,
		pixelHeight: 1,
	},
	referenceTimeScale: DEFAULT_TIME_SCALE,
	containerType: 'mp4',
	initSegmentUrl: 'init.mp4',
	segmentTemplateUrl: '$Number$.mp4',
});

type SegmentHarness = {
	representation: Representation;
	estimator: BandwidthEstimator;
	addSegments: (startTime: number, duration: number, size: number, repeat: number) => void;
};

// Mirrors shaka's SegmentTemplateTest::AddSegments: pushes `repeat + 1` segments
// into the Representation (incrementing start time by `duration` each time) and
// feeds a parallel BandwidthEstimator so the expected bandwidth matches shaka's
// `bandwidth_estimator_.Max()`. Low-latency mode pushes a single segment and skips
// the estimator (the block is fed later by UpdateSegment).
const createSegmentHarness = (mediaInfo: MediaInfo, options: MpdOptions): SegmentHarness => {
	const representation = new Representation(mediaInfo, options, REPRESENTATION_ID);
	expect(representation.init()).toBe(true);
	const estimator = new BandwidthEstimator();
	const timeScale = mediaInfo.referenceTimeScale ?? 1;
	const lowLatency = options.mpdParams.lowLatencyDashMode;
	let segmentNumber = 1;
	const addSegments = (startTime: number, duration: number, size: number, repeat: number): void => {
		if (lowLatency) {
			representation.addNewSegment(startTime, duration, size, segmentNumber++);
			return;
		}
		for (let i = 0; i < repeat + 1; i++) {
			representation.addNewSegment(startTime, duration, size, segmentNumber++);
			startTime += duration;
			estimator.addBlock(size, duration / timeScale);
		}
	};
	return { representation, estimator, addSegments };
};

// shaka: SegmentTemplateTest::ExpectedXml (frameRate 10/5, media=$Time$.mp4).
const segmentTemplateExpectedXml = (bandwidth: number, sElements: string): string =>
	`<Representation id="1" bandwidth="${bandwidth}"`
	+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
	+ ' width="720" height="480" frameRate="10/5">'
	+ '  <SegmentTemplate timescale="1000" initialization="init.mp4"'
	+ '   media="$Time$.mp4" startNumber="1">'
	+ `    <SegmentTimeline>${sElements}</SegmentTimeline>`
	+ '  </SegmentTemplate>'
	+ '</Representation>';

// shaka: SegmentTimelineTestBase::ExpectedXml (frameRate 10/2, media=$Number$.mp4,
// variable startNumber).
const segmentTimelineExpectedXml = (bandwidth: number, sElements: string, startNumber: number): string =>
	`<Representation id="1" bandwidth="${bandwidth}"`
	+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
	+ ' width="720" height="480" frameRate="10/2">'
	+ `  <SegmentTemplate timescale="1000" initialization="init.mp4"`
	+ `   media="$Number$.mp4" startNumber="${startNumber}">`
	+ `    <SegmentTimeline>${sElements}</SegmentTimeline>`
	+ '  </SegmentTemplate>'
	+ '</Representation>';

describe('Representation — SegmentTemplate (dynamic MPD)', () => {
	const dynamicOptions = (overrides: Partial<MpdOptions['mpdParams']> = {}): MpdOptions => newOptions({
		mpdType: 'dynamic',
		mpdParams: { ...createDefaultMpdParams(), lowLatencyDashMode: false, ...overrides },
	});

	// shaka: TEST_F(SegmentTemplateTest, OneSegmentNormal)
	test('OneSegmentNormal', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(0, 10, 128, 0);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(harness.estimator.max(), '<S t="0" d="10"/>'),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, OneSegmentLowLatency)
	test('OneSegmentLowLatency', () => {
		const kChunkDuration = 5;
		const kChunkSize = 128;
		const kSegmentDuration = kChunkDuration * 1000;
		const kSegmentSize = kChunkSize * 1000;
		const options = dynamicOptions({
			lowLatencyDashMode: true,
			targetSegmentDuration: kSegmentDuration / DEFAULT_TIME_SCALE,
		});
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), options);
		harness.representation.setSampleDuration(kChunkDuration);
		harness.representation.setAvailabilityTimeOffset();
		harness.representation.setSegmentDuration();

		harness.addSegments(0, kChunkDuration, kChunkSize, 0);
		harness.representation.updateCompletedSegment(kSegmentDuration, kSegmentSize);
		harness.estimator.addBlock(kSegmentSize, kSegmentDuration / DEFAULT_TIME_SCALE);

		expectXmlEqual(
			renderXml(harness.representation),
			'<Representation id="1" bandwidth="204800"'
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">'
			+ '  <SegmentTemplate timescale="1000" duration="5000"'
			+ '   availabilityTimeOffset="4.995" availabilityTimeComplete="false"'
			+ '   initialization="init.mp4" media="$Time$.mp4" startNumber="1"/>'
			+ '</Representation>',
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, RepresentationClone)
	test('RepresentationClone', () => {
		const mediaInfo = { ...segmentTemplateMediaInfo(), segmentTemplateUrl: '$Number$.mp4' };
		const harness = createSegmentHarness(mediaInfo, dynamicOptions());
		harness.addSegments(0, 10, 128, 0);

		const clone = Representation.cloneFrom(harness.representation);
		expectXmlEqual(
			renderXml(clone),
			'<Representation id="1" bandwidth="0"'
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">'
			+ '  <SegmentTemplate timescale="1000" initialization="init.mp4"'
			+ '   media="$Number$.mp4" startNumber="1"></SegmentTemplate>'
			+ '</Representation>',
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, PresentationTimeOffset)
	test('PresentationTimeOffset', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(0, 10, 128, 0);
		harness.representation.setPresentationTimeOffset(2.3);
		expectXmlEqual(
			renderXml(harness.representation),
			`<Representation id="1" bandwidth="${harness.estimator.max()}"`
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">'
			+ '  <SegmentTemplate timescale="1000" presentationTimeOffset="2300"'
			+ '   initialization="init.mp4" media="$Time$.mp4" startNumber="1">'
			+ '    <SegmentTimeline><S t="0" d="10"/></SegmentTimeline>'
			+ '  </SegmentTemplate>'
			+ '</Representation>',
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, GetStartAndEndTimestamps)
	test('GetStartAndEndTimestamps', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		// No segments.
		expect(harness.representation.getStartAndEndTimestamps()).toBeNull();

		const kStartTime = 88;
		const kDuration = 10;
		harness.addSegments(kStartTime, kDuration, 128, 0);
		harness.addSegments(kStartTime + kDuration, kDuration, 128, 2);

		const ts = harness.representation.getStartAndEndTimestamps()!;
		expect(ts.start).toBe(kStartTime / DEFAULT_TIME_SCALE);
		expect(ts.end).toBe((kStartTime + kDuration * 4) / DEFAULT_TIME_SCALE);
	});

	// shaka: TEST_F(SegmentTemplateTest, NormalRepeatedSegmentDuration)
	test('NormalRepeatedSegmentDuration', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(0, 40000, 256, 2);
		harness.addSegments(120000, 54321, 256, 0);
		harness.addSegments(174321, 12345, 256, 0);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(
				harness.estimator.max(),
				'<S t="0" d="40000" r="2"/><S t="120000" d="54321"/><S t="174321" d="12345"/>',
			),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, RepeatedSegmentsFromNonZeroStartTime)
	test('RepeatedSegmentsFromNonZeroStartTime', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(0, 100000, 100000, 2);
		harness.addSegments(300000, 20000, 100000, 3);
		harness.addSegments(380000, 32123, 100000, 3);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(
				harness.estimator.max(),
				'<S t="0" d="100000" r="2"/><S t="300000" d="20000" r="3"/><S t="380000" d="32123" r="3"/>',
			),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, NonZeroStartTime)
	test('NonZeroStartTime', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(10, 22000, 123456, 1);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(harness.estimator.max(), '<S t="10" d="22000" r="1"/>'),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, NonContiguousLiveInfo)
	test('NonContiguousLiveInfo', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		const kDuration = 22000;
		harness.addSegments(10, kDuration, 123456, 0);
		harness.addSegments(kDuration + 100, kDuration, 123456, 0);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(
				harness.estimator.max(),
				'<S t="10" d="22000"/><S t="22100" d="22000"/>',
			),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, OutOfOrder)
	test('OutOfOrder', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(1000, 1000, 123456, 0);
		harness.addSegments(0, 1000, 123456, 0);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(
				harness.estimator.max(),
				'<S t="1000" d="1000"/><S t="0" d="1000"/>',
			),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, OverlappingSegments)
	test('OverlappingSegments', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(0, 1000, 123456, 0);
		harness.addSegments(500, 1000, 123456, 0);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(
				harness.estimator.max(),
				'<S t="0" d="1000"/><S t="500" d="1000"/>',
			),
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, OverlappingSegmentsWithinErrorRange)
	test('OverlappingSegmentsWithinErrorRange', () => {
		const harness = createSegmentHarness(segmentTemplateMediaInfo(), dynamicOptions());
		harness.addSegments(0, 1000, 123456, 0);
		harness.addSegments(999, 1000, 123456, 0);
		expectXmlEqual(
			renderXml(harness.representation),
			segmentTemplateExpectedXml(
				harness.estimator.max(),
				'<S t="0" d="1000"/><S t="999" d="1000"/>',
			),
		);
	});
});

describe('Representation — TimeShiftBufferDepth (sliding window)', () => {
	const timelineOptions = (timeShiftBufferDepth: number): MpdOptions => newOptions({
		mpdType: 'dynamic',
		mpdParams: {
			...createDefaultMpdParams(),
			targetSegmentDuration: TARGET_SEGMENT_DURATION_SECONDS,
			timeShiftBufferDepth,
		},
	});

	// shaka: INSTANTIATE_TEST_CASE_P(InitialStartTime, ..., Values(0, 1000)).
	for (const initialStartTime of [0, 1000]) {
		const suffix = `(initialStartTime=${initialStartTime})`;

		// shaka: TEST_P(TimeShiftBufferDepthTest, Normal)
		test(`Normal ${suffix}`, () => {
			const kTimeShiftBufferDepth = 10;
			const kDuration = DEFAULT_TIME_SCALE;
			const kRepeat = 1234;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration, 10000, kRepeat);

			const expectedRepeatsLeft = kTimeShiftBufferDepth;
			const expectedStartNumber = kRepeat - expectedRepeatsLeft + 1;
			const sElement = `<S t="${initialStartTime + kDuration * (kRepeat - expectedRepeatsLeft)}"`
				+ ` d="${kDuration}" r="${expectedRepeatsLeft}"/>`;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(harness.estimator.max(), sElement, expectedStartNumber),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, TimeShiftBufferDepthShorterThanSegmentLength)
		test(`TimeShiftBufferDepthShorterThanSegmentLength ${suffix}`, () => {
			const kTimeShiftBufferDepth = 10;
			const kDuration = DEFAULT_TIME_SCALE * (kTimeShiftBufferDepth + 1);
			const kRepeat = 1;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration, 10000, kRepeat);

			const sElement = `<S t="${initialStartTime}" d="${kDuration}" r="${kRepeat}"/>`;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(harness.estimator.max(), sElement, DEFAULT_START_NUMBER),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, Generic)
		test(`Generic ${suffix}`, () => {
			const kTimeShiftBufferDepth = 30;
			const kDuration = DEFAULT_TIME_SCALE;
			const kRepeat = 1000;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration, 10000, kRepeat);

			const firstSElementEndTime = initialStartTime + kDuration * (kRepeat + 1);
			const kMoreSegmentsRepeat = 1;
			const kTimeShiftBufferDepthDuration = DEFAULT_TIME_SCALE * kTimeShiftBufferDepth;
			harness.addSegments(firstSElementEndTime, kTimeShiftBufferDepthDuration, 10000, kMoreSegmentsRepeat);

			const sElement = `<S t="${firstSElementEndTime}" d="${kTimeShiftBufferDepthDuration}"`
				+ ` r="${kMoreSegmentsRepeat}"/>`;
			const expectedRemovedSegments = kRepeat + 1;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(
					harness.estimator.max(),
					sElement,
					DEFAULT_START_NUMBER + expectedRemovedSegments,
				),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, MoreThanOneS)
		test(`MoreThanOneS ${suffix}`, () => {
			const kTimeShiftBufferDepth = 100;
			const kSize = 20000;
			const kOneSecondDuration = DEFAULT_TIME_SCALE;
			const kOneSecondSegmentRepeat = 99;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kOneSecondDuration, kSize, kOneSecondSegmentRepeat);
			const firstSElementEndTime = initialStartTime + kOneSecondDuration * (kOneSecondSegmentRepeat + 1);

			const kTwoSecondDuration = 2 * DEFAULT_TIME_SCALE;
			const kTwoSecondSegmentRepeat = 20;
			harness.addSegments(firstSElementEndTime, kTwoSecondDuration, kSize, kTwoSecondSegmentRepeat);

			const expectedRemovedSegments = (kOneSecondSegmentRepeat + 1 + kTwoSecondSegmentRepeat * 2)
				- kTimeShiftBufferDepth;
			const sElement = `<S t="${initialStartTime + kOneSecondDuration * expectedRemovedSegments}"`
				+ ` d="${kOneSecondDuration}" r="${kOneSecondSegmentRepeat - expectedRemovedSegments}"/>`
				+ `<S t="${firstSElementEndTime}" d="${kTwoSecondDuration}" r="${kTwoSecondSegmentRepeat}"/>`;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(
					harness.estimator.max(),
					sElement,
					DEFAULT_START_NUMBER + expectedRemovedSegments,
				),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, UseLastSegmentInS)
		test(`UseLastSegmentInS ${suffix}`, () => {
			const kTimeShiftBufferDepth = 9;
			const kDuration1 = Math.trunc(DEFAULT_TIME_SCALE * 1.5);
			const kSize = 20000;
			const kRepeat1 = 1;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration1, kSize, kRepeat1);
			const firstSElementEndTime = initialStartTime + kDuration1 * (kRepeat1 + 1);

			const kTwoSecondDuration = 2 * DEFAULT_TIME_SCALE;
			const kTwoSecondSegmentRepeat = 4;
			harness.addSegments(firstSElementEndTime, kTwoSecondDuration, kSize, kTwoSecondSegmentRepeat);

			const sElement = `<S t="${initialStartTime + kDuration1}" d="${kDuration1}"/>`
				+ `<S t="${firstSElementEndTime}" d="${kTwoSecondDuration}" r="${kTwoSecondSegmentRepeat}"/>`;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(harness.estimator.max(), sElement, 2),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, NormalGap)
		test(`NormalGap ${suffix}`, () => {
			const kTimeShiftBufferDepth = 10;
			const kDuration = DEFAULT_TIME_SCALE;
			const kSize = 20000;
			const kRepeat = 6;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration, kSize, kRepeat);
			const firstSElementEndTime = initialStartTime + kDuration * (kRepeat + 1);

			const gapSElementStartTime = firstSElementEndTime + 1;
			harness.addSegments(gapSElementStartTime, kDuration, kSize, 0);

			const sElement = `<S t="${initialStartTime}" d="${kDuration}" r="${kRepeat}"/>`
				+ `<S t="${gapSElementStartTime}" d="${kDuration}"/>`;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(harness.estimator.max(), sElement, DEFAULT_START_NUMBER),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, HugeGap)
		test(`HugeGap ${suffix}`, () => {
			const kTimeShiftBufferDepth = 10;
			const kDuration = DEFAULT_TIME_SCALE;
			const kSize = 20000;
			const kRepeat = 6;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration, kSize, kRepeat);
			const firstSElementEndTime = initialStartTime + kDuration * (kRepeat + 1);

			const gapSElementStartTime = firstSElementEndTime + (kTimeShiftBufferDepth + 1) * DEFAULT_TIME_SCALE;
			const kSecondSElementRepeat = 9;
			harness.addSegments(gapSElementStartTime, kDuration, kSize, kSecondSElementRepeat);

			const sElement = `<S t="${initialStartTime + kRepeat * kDuration}" d="${kDuration}"/>`
				+ `<S t="${gapSElementStartTime}" d="${kDuration}" r="${kSecondSElementRepeat}"/>`;
			const expectedRemovedSegments = kRepeat;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(
					harness.estimator.max(),
					sElement,
					DEFAULT_START_NUMBER + expectedRemovedSegments,
				),
			);
		});

		// shaka: TEST_P(TimeShiftBufferDepthTest, ManySegments)
		test(`ManySegments ${suffix}`, () => {
			const kTimeShiftBufferDepth = 1;
			const kDuration = DEFAULT_TIME_SCALE;
			const kSize = 20000;
			const kRepeat = 10000;
			const kTotalNumSegments = kRepeat + 1;
			const harness = createSegmentHarness(segmentTimelineMediaInfo(), timelineOptions(kTimeShiftBufferDepth));
			harness.addSegments(initialStartTime, kDuration, kSize, kRepeat);

			const expectedSegmentsLeft = kTimeShiftBufferDepth + 1;
			const expectedSegmentsRepeat = expectedSegmentsLeft - 1;
			const expectedRemovedSegments = kTotalNumSegments - expectedSegmentsLeft;
			const expectedStartNumber = DEFAULT_START_NUMBER + expectedRemovedSegments;
			const sElement = `<S t="${initialStartTime + expectedRemovedSegments * kDuration}"`
				+ ` d="${kDuration}" r="${expectedSegmentsRepeat}"/>`;
			expectXmlEqual(
				renderXml(harness.representation),
				segmentTimelineExpectedXml(harness.estimator.max(), sElement, expectedStartNumber),
			);
		});
	}
});

describe('Representation — VP9 codec string in WebM', () => {
	// shaka: TEST_F(RepresentationTest, CheckVideoInfoVp9CodecInWebm)
	test('VP9 codec passes through unchanged in WebM', () => {
		const mediaInfo: MediaInfo = {
			videoInfo: {
				codec: 'vp09.00.00.08.01.01.00.00',
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
		expect(rep.getXml()!.getAttribute('codecs')).toBe('vp09.00.00.08.01.01.00.00');
	});
});

// shaka: RepresentationDeleteSegmentsTest — driven by File::Delete assertions. This
// port has no filesystem, so (mirroring the HLS DeleteSegments tests) it asserts on
// getSegmentsToBeRemoved(): names slid out of the live window are pushed there and the
// front is dropped once the preserved count is exceeded (that drop is our "deletion").
// shaka names segments from media_info.segment_template ("memory://$Number$.mp4").
describe('Representation — segment deletion (live window)', () => {
	const PRESERVED = 3;
	const TIME_SHIFT_BUFFER_DEPTH = 2;
	const DURATION = DEFAULT_TIME_SCALE; // kDuration == kDefaultTimeScale (one-second segments)
	const SIZE = 10;
	// kMaxNumSegmentsAvailable = timeShiftBufferDepth + 1 + preserved
	const MAX_AVAILABLE = TIME_SHIFT_BUFFER_DEPTH + 1 + PRESERVED;

	// shaka names by $Number$, 1-based.
	const segName = (index: number): string => `memory://${index + 1}.mp4`;

	const build = (numSegments: number): Representation => {
		const options = newOptions({
			mpdType: 'dynamic',
			mpdParams: {
				...createDefaultMpdParams(),
				targetSegmentDuration: TARGET_SEGMENT_DURATION_SECONDS,
				timeShiftBufferDepth: TIME_SHIFT_BUFFER_DEPTH,
				preservedSegmentsOutsideLiveWindow: PRESERVED,
			},
		});
		const mediaInfo: MediaInfo = {
			...segmentTimelineMediaInfo(),
			segmentTemplate: 'memory://$Number$.mp4',
			segmentTemplateUrl: 'video/$Number$.mp4',
		};
		const harness = createSegmentHarness(mediaInfo, options);
		for (let i = 0; i < numSegments; i++) {
			harness.addSegments(i * DURATION, DURATION, SIZE, 0);
		}
		return harness.representation;
	};

	// The preserved buffer after N segments holds the last PRESERVED names that left the
	// window: indices [N - MAX_AVAILABLE, N - MAX_AVAILABLE + PRESERVED).
	const expectedPreserved = (numSegments: number): string[] => {
		const firstPreservedIndex = numSegments - MAX_AVAILABLE;
		return Array.from({ length: PRESERVED }, (_, k) => segName(firstPreservedIndex + k));
	};

	// shaka: TEST_F(RepresentationDeleteSegmentsTest, NoSegmentsDeletedInitially)
	test('nothing is deleted until more than kMaxNumSegmentsAvailable exist', () => {
		const rep = build(MAX_AVAILABLE);
		expect(rep.getSegmentsToBeRemoved()).toEqual(expectedPreserved(MAX_AVAILABLE));
	});

	// shaka: TEST_F(RepresentationDeleteSegmentsTest, OneSegmentDeleted)
	test('the first segment is dropped once the buffer overflows', () => {
		const rep = build(MAX_AVAILABLE + 1);
		const removed = rep.getSegmentsToBeRemoved();
		expect(removed).toEqual(expectedPreserved(MAX_AVAILABLE + 1));
		expect(removed).not.toContain(segName(0)); // deleted
		expect(removed).toContain(segName(1)); // still preserved
	});

	// shaka: TEST_F(RepresentationDeleteSegmentsTest, ManyNonRepeatingSegments)
	test('only the newest preserved segments remain after many non-repeating segments', () => {
		const many = 50;
		const rep = build(many);
		const lastAvailableIndex = many - MAX_AVAILABLE;
		const removed = rep.getSegmentsToBeRemoved();
		expect(removed).toEqual(expectedPreserved(many));
		expect(removed).not.toContain(segName(lastAvailableIndex - 1)); // deleted
		expect(removed).toContain(segName(lastAvailableIndex)); // still preserved
	});

	// shaka: TEST_F(RepresentationDeleteSegmentsTest, ManyRepeatingSegments)
	test('only the newest preserved segments remain after many repeating segments', () => {
		const options = newOptions({
			mpdType: 'dynamic',
			mpdParams: {
				...createDefaultMpdParams(),
				targetSegmentDuration: TARGET_SEGMENT_DURATION_SECONDS,
				timeShiftBufferDepth: TIME_SHIFT_BUFFER_DEPTH,
				preservedSegmentsOutsideLiveWindow: PRESERVED,
			},
		});
		const mediaInfo: MediaInfo = {
			...segmentTimelineMediaInfo(),
			segmentTemplate: 'memory://$Number$.mp4',
			segmentTemplateUrl: 'video/$Number$.mp4',
		};
		const harness = createSegmentHarness(mediaInfo, options);
		const kLoops = 4;
		const kRepeat = 10;
		for (let i = 0; i < kLoops; i++) {
			harness.addSegments(i * DURATION * (kRepeat + 1), DURATION, SIZE, kRepeat);
		}
		const kNumSegments = kLoops * (kRepeat + 1);
		const lastAvailableIndex = kNumSegments - MAX_AVAILABLE;
		const removed = harness.representation.getSegmentsToBeRemoved();
		expect(removed).toEqual(expectedPreserved(kNumSegments));
		expect(removed).not.toContain(segName(lastAvailableIndex - 1)); // deleted
		expect(removed).toContain(segName(lastAvailableIndex)); // still preserved
	});

	// shaka: TEST_F(RepresentationDeleteSegmentsTest, FileAlreadyDeleted)
	// With no filesystem the drop is unconditional, so deletion is never blocked by an
	// already-missing file — the outcome shaka asserts holds by construction.
	test('dropping is not blocked when segments overflow further', () => {
		const rep = build(MAX_AVAILABLE + 2);
		const removed = rep.getSegmentsToBeRemoved();
		expect(removed).toEqual(expectedPreserved(MAX_AVAILABLE + 2));
		expect(removed).not.toContain(segName(1)); // deleted, not blocked
	});
});
