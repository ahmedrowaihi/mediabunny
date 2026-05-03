/*!
 * Live-profile Representation tests ported from shaka's
 * `representation_unittest.cc` SegmentTemplateTest fixture (line 451+).
 * Each case is named after the shaka test it adapts.
 *
 * Original test source: shaka-packager packager/mpd/base/representation_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { BandwidthEstimator } from '../../src/hls/hls-bandwidth-estimator.js';
import type { MediaInfo } from '../../src/dash/dash-media-info.js';
import { Representation } from '../../src/dash/dash-representation.js';
import {
	createDefaultMpdOptions,
	type MpdOptions,
} from '../../src/dash/dash-types.js';
import { expectXmlEqual } from './_xml-equal.js';

const REPRESENTATION_ID = 1;
const DEFAULT_TIME_SCALE = 1000;

const defaultMediaInfo = (): MediaInfo => ({
	videoInfo: {
		codec: 'avc1.010101',
		width: 720,
		height: 480,
		timeScale: 10,
		frameDuration: 5,
		pixelWidth: 1,
		pixelHeight: 1,
	},
	containerType: 'mp4',
	referenceTimeScale: DEFAULT_TIME_SCALE,
	initSegmentUrl: 'init.mp4',
	segmentTemplateUrl: '$Time$.mp4',
});

const dynamicOptions = (): MpdOptions => {
	const opts = createDefaultMpdOptions();
	opts.mpdType = 'dynamic';
	opts.mpdParams.lowLatencyDashMode = false;
	return opts;
};

/**
 * Mirrors shaka's SegmentTemplateTest fixture: tracks expected `<S>` elements
 * and accumulates a BandwidthEstimator for the @bandwidth assertion.
 */
class SegmentTemplateFixture {
	representation: Representation;
	expectedSElements = '';
	private segmentNumber = 1;
	private readonly bandwidthEstimator = new BandwidthEstimator();
	private readonly opts: MpdOptions;

	constructor(opts: MpdOptions = dynamicOptions(), mediaInfo = defaultMediaInfo()) {
		this.opts = opts;
		this.representation = new Representation(mediaInfo, opts, REPRESENTATION_ID);
		expect(this.representation.init()).toBe(true);
	}

	addSegments(startTime: number, duration: number, size: number, repeat: number): void {
		if (this.opts.mpdParams.lowLatencyDashMode) {
			// Low-latency: only the first chunk is registered; the segment
			// info is updated later by updateSegment().
			this.representation.addNewSegment(startTime, duration, size, this.segmentNumber++);
			return;
		}

		if (repeat === 0) {
			this.expectedSElements += `<S t="${startTime}" d="${duration}"/>`;
		} else {
			this.expectedSElements += `<S t="${startTime}" d="${duration}" r="${repeat}"/>`;
		}

		let st = startTime;
		for (let i = 0; i < repeat + 1; i++) {
			this.representation.addNewSegment(st, duration, size, this.segmentNumber++);
			st += duration;
			this.bandwidthEstimator.addBlock(size, duration / DEFAULT_TIME_SCALE);
		}
	}

	updateSegment(duration: number, size: number): void {
		this.representation.updateCompletedSegment(duration, size);
		this.bandwidthEstimator.addBlock(size, duration / DEFAULT_TIME_SCALE);
	}

	expectedXml(): string {
		const bandwidth = this.bandwidthEstimator.max();
		return ''
			+ `<Representation id="1" bandwidth="${bandwidth}"`
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">\n'
			+ '  <SegmentTemplate timescale="1000"'
			+ '   initialization="init.mp4" media="$Time$.mp4"'
			+ '   startNumber="1">\n'
			+ '    <SegmentTimeline>\n'
			+ `      ${this.expectedSElements}\n`
			+ '    </SegmentTimeline>\n'
			+ '  </SegmentTemplate>\n'
			+ '</Representation>\n';
	}
}

describe('SegmentTemplateTest', () => {
	// shaka: TEST_F(SegmentTemplateTest, OneSegmentNormal)
	test('OneSegmentNormal', () => {
		const fix = new SegmentTemplateFixture();
		fix.addSegments(0, 10, 128, 0);
		fix.expectedSElements = '<S t="0" d="10"/>';
		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, OneSegmentLowLatency)
	test('OneSegmentLowLatency', () => {
		const opts = dynamicOptions();
		opts.mpdParams.lowLatencyDashMode = true;
		opts.mpdParams.targetSegmentDuration = 5;
		const fix = new SegmentTemplateFixture(opts);
		fix.representation.setSampleDuration(5);
		fix.representation.setAvailabilityTimeOffset();
		fix.representation.setSegmentDuration();
		fix.addSegments(0, 5, 128, 0);
		fix.updateSegment(5000, 128 * 1000);
		expectXmlEqual(
			fix.representation.getXml()!.toString(),
			'<Representation id="1" bandwidth="204800"'
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">\n'
			+ '  <SegmentTemplate timescale="1000"'
			+ '   duration="5000" availabilityTimeOffset="4.995"'
			+ '   availabilityTimeComplete="false" initialization="init.mp4"'
			+ '   media="$Time$.mp4" startNumber="1"/>\n'
			+ '</Representation>\n',
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, RepresentationClone)
	test('RepresentationClone', () => {
		const mediaInfo: MediaInfo = {
			...defaultMediaInfo(),
			segmentTemplateUrl: '$Number$.mp4',
		};
		const fix = new SegmentTemplateFixture(dynamicOptions(), mediaInfo);
		fix.addSegments(0, 10, 128, 0);
		const cloned = Representation.cloneFrom(fix.representation);
		expectXmlEqual(
			cloned.getXml()!.toString(),
			'<Representation id="1" bandwidth="0"'
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">\n'
			+ '  <SegmentTemplate timescale="1000" initialization="init.mp4"'
			+ '   media="$Number$.mp4" startNumber="1">\n'
			+ '  </SegmentTemplate>\n'
			+ '</Representation>\n',
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, PresentationTimeOffset)
	test('PresentationTimeOffset', () => {
		const fix = new SegmentTemplateFixture();
		fix.addSegments(0, 10, 128, 0);
		fix.representation.setPresentationTimeOffset(2.3);
		expectXmlEqual(
			fix.representation.getXml()!.toString(),
			'<Representation id="1" bandwidth="102400"'
			+ ' codecs="avc1.010101" mimeType="video/mp4" sar="1:1"'
			+ ' width="720" height="480" frameRate="10/5">\n'
			+ '  <SegmentTemplate timescale="1000" presentationTimeOffset="2300"'
			+ '   initialization="init.mp4" media="$Time$.mp4" startNumber="1">\n'
			+ '    <SegmentTimeline>\n'
			+ '      <S t="0" d="10"/>\n'
			+ '    </SegmentTimeline>\n'
			+ '  </SegmentTemplate>\n'
			+ '</Representation>\n',
		);
	});

	// shaka: TEST_F(SegmentTemplateTest, GetStartAndEndTimestamps)
	test('GetStartAndEndTimestamps', () => {
		const fix = new SegmentTemplateFixture();
		// No segments yet.
		expect(fix.representation.getStartAndEndTimestamps()).toBeNull();
		const startTime = 88;
		const duration = 10;
		const size = 128;
		fix.addSegments(startTime, duration, size, 0);
		fix.addSegments(startTime + duration, duration, size, 2);
		const ts = fix.representation.getStartAndEndTimestamps()!;
		expect(ts.start).toBe(startTime / DEFAULT_TIME_SCALE);
		expect(ts.end).toBe((startTime + duration * 4) / DEFAULT_TIME_SCALE);
	});

	// shaka: TEST_F(SegmentTemplateTest, NormalRepeatedSegmentDuration)
	test('NormalRepeatedSegmentDuration', () => {
		const fix = new SegmentTemplateFixture();
		const size = 256;
		let startTime = 0;
		let duration = 40000;
		let repeat = 2;
		fix.addSegments(startTime, duration, size, repeat);

		startTime += duration * (repeat + 1);
		duration = 54321;
		repeat = 0;
		fix.addSegments(startTime, duration, size, repeat);

		startTime += duration * (repeat + 1);
		duration = 12345;
		repeat = 0;
		fix.addSegments(startTime, duration, size, repeat);

		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, RepeatedSegmentsFromNonZeroStartTime)
	test('RepeatedSegmentsFromNonZeroStartTime', () => {
		const fix = new SegmentTemplateFixture();
		const size = 100000;
		let startTime = 0;
		let duration = 100000;
		let repeat = 2;
		fix.addSegments(startTime, duration, size, repeat);

		startTime += duration * (repeat + 1);
		duration = 20000;
		repeat = 3;
		fix.addSegments(startTime, duration, size, repeat);

		startTime += duration * (repeat + 1);
		duration = 32123;
		repeat = 3;
		fix.addSegments(startTime, duration, size, repeat);

		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, NonZeroStartTime)
	test('NonZeroStartTime', () => {
		const fix = new SegmentTemplateFixture();
		fix.addSegments(10, 22000, 123456, 1);
		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, NonContiguousLiveInfo)
	test('NonContiguousLiveInfo', () => {
		const fix = new SegmentTemplateFixture();
		const startTime = 10;
		const duration = 22000;
		const size = 123456;
		fix.addSegments(startTime, duration, size, 0);
		const startTimeOffset = 100;
		fix.addSegments(duration + startTimeOffset, duration, size, 0);
		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, OutOfOrder)
	test('OutOfOrder', () => {
		const fix = new SegmentTemplateFixture();
		fix.addSegments(1000, 1000, 123456, 0);
		fix.addSegments(0, 1000, 123456, 0);
		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, OverlappingSegments)
	test('OverlappingSegments', () => {
		const fix = new SegmentTemplateFixture();
		fix.addSegments(0, 1000, 123456, 0);
		// Overlap: starts at duration/2.
		fix.addSegments(500, 1000, 123456, 0);
		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});

	// shaka: TEST_F(SegmentTemplateTest, OverlappingSegmentsWithinErrorRange)
	test('OverlappingSegmentsWithinErrorRange', () => {
		const fix = new SegmentTemplateFixture();
		fix.addSegments(0, 1000, 123456, 0);
		// Overlap: starts at duration-1 (within rounding-error tolerance).
		fix.addSegments(999, 1000, 123456, 0);
		expectXmlEqual(fix.representation.getXml()!.toString(), fix.expectedXml());
	});
});
