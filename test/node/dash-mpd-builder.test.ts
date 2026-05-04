/*!
 * MpdBuilder tests ported from shaka's `mpd_builder_unittest.cc`.
 * Each case is named after the shaka test it adapts.
 *
 * Original test source: shaka-packager packager/mpd/base/mpd_builder_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import type { MediaInfo } from '../../src/dash/dash-media-info.js';
import { MpdBuilder } from '../../src/dash/dash-mpd-builder.js';
import type { Period } from '../../src/dash/dash-period.js';
import {
	createDefaultMpdOptions,
	type DashProfile,
	type MpdOptions,
} from '../../src/dash/dash-types.js';
import { expectXmlEqual } from './_xml-equal.js';

const VIDEO_MEDIA_INFO_1: MediaInfo = {
	bandwidth: 7620,
	videoInfo: {
		codec: 'avc1.010101',
		width: 720,
		height: 480,
		timeScale: 10,
		frameDuration: 1,
		pixelWidth: 1,
		pixelHeight: 1,
	},
	initRange: { begin: 0, end: 120 },
	indexRange: { begin: 121, end: 221 },
	referenceTimeScale: 1000,
	containerType: 'mp4',
	mediaFileName: 'test_output_file_name1.mp4',
	mediaFileUrl: 'test_output_file_name1.mp4',
	mediaDurationSeconds: 10.5,
};

const VIDEO_MEDIA_INFO_2: MediaInfo = {
	bandwidth: 5000,
	videoInfo: {
		codec: 'avc1.010101',
		width: 480,
		height: 360,
		timeScale: 20,
		frameDuration: 20,
		pixelWidth: 2,
		pixelHeight: 1,
	},
	initRange: { begin: 0, end: 53 },
	indexRange: { begin: 54, end: 100 },
	referenceTimeScale: 50,
	containerType: 'mp4',
	mediaFileName: 'test_output_file_name2.mp4',
	mediaFileUrl: 'test_output_file_name2.mp4',
	mediaDurationSeconds: 10.5,
};

const AUDIO_MEDIA_INFO_1: MediaInfo = {
	bandwidth: 400,
	audioInfo: {
		codec: 'mp4a.40.2',
		samplingFrequency: 44100,
		timeScale: 1200,
		numChannels: 2,
	},
	referenceTimeScale: 50,
	containerType: 'mp4',
	mediaFileName: 'test_output_file_name_audio1.mp4',
	mediaFileUrl: 'test_output_file_name_audio1.mp4',
	mediaDurationSeconds: 10.5,
};

const onDemandOptions = (): MpdOptions => {
	const opts = createDefaultMpdOptions();
	opts.dashProfile = 'onDemand';
	return opts;
};

const fixedClock = (iso: string): () => Date => {
	const ms = Date.parse(iso + 'Z');
	return () => new Date(ms);
};

/**
 * Mirrors shaka's `MpdBuilderTest<DashProfile::kOnDemand>` fixture.
 */
class OnDemandMpdBuilderFixture {
	mpd: MpdBuilder;
	period: Period;

	constructor() {
		this.mpd = new MpdBuilder(onDemandOptions());
		this.period = this.mpd.getOrCreatePeriod(0.0);
	}

	addRepresentation(mediaInfo: MediaInfo): void {
		const set = this.period.getOrCreateAdaptationSet(mediaInfo, true);
		expect(set).not.toBeNull();
		const rep = set!.addRepresentation(mediaInfo);
		expect(rep).not.toBeNull();
	}
}

/**
 * Mirrors shaka's `LiveMpdBuilderTest`. `availabilityStartTime` is anchored
 * so output doesn't depend on the wall clock; the test clock returns
 * 2016-01-11T15:10:24Z.
 */
class LiveMpdBuilderFixture {
	mpd: MpdBuilder;

	constructor(profile: DashProfile = 'live') {
		const opts = createDefaultMpdOptions();
		opts.dashProfile = profile;
		opts.mpdType = 'dynamic';
		this.mpd = new MpdBuilder(opts);
		this.mpd.setPackagerVersionForTesting('<tag>-<hash>-<test>');
		this.mpd.setAvailabilityStartTimeForTesting('2011-12-25T12:30:00');
		this.mpd.injectClockForTesting(fixedClock('2016-01-11T15:10:24'));
	}
}

/**
 * Add a single segment to a period via a fresh AdaptationSet+Representation.
 * Mirrors shaka's `AddSegmentToPeriod` helper in MpdBuilderTest.
 */
const addSegmentToPeriod = (
	startTimeSeconds: number,
	durationSeconds: number,
	period: Period,
): void => {
	const mediaInfo = { ...VIDEO_MEDIA_INFO_1 };
	const set = period.getOrCreateAdaptationSet(mediaInfo, true);
	expect(set).not.toBeNull();
	const rep = set!.addRepresentation(mediaInfo);
	expect(rep).not.toBeNull();
	const refScale = mediaInfo.referenceTimeScale!;
	rep!.addNewSegment(
		startTimeSeconds * refScale,
		durationSeconds * refScale,
		1000,
		1,
	);
};

describe('OnDemandMpdBuilderTest', () => {
	// shaka: TEST_F(OnDemandMpdBuilderTest, Video)
	test('Video', () => {
		const fix = new OnDemandMpdBuilderFixture();
		fix.addRepresentation(VIDEO_MEDIA_INFO_1);
		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expectXmlEqual(
			out!,
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xmlns:xlink="http://www.w3.org/1999/xlink"'
			+ ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"'
			+ ' minBufferTime="PT2S" type="static"'
			+ ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"'
			+ ' mediaPresentationDuration="PT10.5S">\n'
			+ '  <Period id="0">\n'
			+ '    <AdaptationSet contentType="video" width="720" height="480" frameRate="10/1"'
			+ ' par="3:2" id="0">\n'
			+ '      <Representation id="0" bandwidth="7620" codecs="avc1.010101"'
			+ ' mimeType="video/mp4" sar="1:1">\n'
			+ '        <BaseURL>test_output_file_name1.mp4</BaseURL>\n'
			+ '        <SegmentBase indexRange="121-221" timescale="1000">\n'
			+ '          <Initialization range="0-120"/>\n'
			+ '        </SegmentBase>\n'
			+ '      </Representation>\n'
			+ '    </AdaptationSet>\n'
			+ '  </Period>\n'
			+ '</MPD>\n',
		);
	});

	// shaka: TEST_F(OnDemandMpdBuilderTest, TwoVideosWithDifferentResolutions)
	test('TwoVideosWithDifferentResolutions', () => {
		const fix = new OnDemandMpdBuilderFixture();
		fix.addRepresentation(VIDEO_MEDIA_INFO_1);
		fix.addRepresentation(VIDEO_MEDIA_INFO_2);
		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expectXmlEqual(
			out!,
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xmlns:xlink="http://www.w3.org/1999/xlink"'
			+ ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"'
			+ ' minBufferTime="PT2S" type="static"'
			+ ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"'
			+ ' mediaPresentationDuration="PT10.5S">\n'
			+ '  <Period id="0">\n'
			+ '    <AdaptationSet contentType="video" maxWidth="720" maxHeight="480"'
			+ ' maxFrameRate="10/1" id="0">\n'
			+ '      <Representation id="0" bandwidth="7620" codecs="avc1.010101"'
			+ ' mimeType="video/mp4" width="720" height="480" frameRate="10/1" sar="1:1">\n'
			+ '        <BaseURL>test_output_file_name1.mp4</BaseURL>\n'
			+ '        <SegmentBase indexRange="121-221" timescale="1000">\n'
			+ '          <Initialization range="0-120"/>\n'
			+ '        </SegmentBase>\n'
			+ '      </Representation>\n'
			+ '      <Representation id="1" bandwidth="5000" codecs="avc1.010101"'
			+ ' mimeType="video/mp4" width="480" height="360" frameRate="20/20" sar="2:1">\n'
			+ '        <BaseURL>test_output_file_name2.mp4</BaseURL>\n'
			+ '        <SegmentBase indexRange="54-100" timescale="50">\n'
			+ '          <Initialization range="0-53"/>\n'
			+ '        </SegmentBase>\n'
			+ '      </Representation>\n'
			+ '    </AdaptationSet>\n'
			+ '  </Period>\n'
			+ '</MPD>\n',
		);
	});

	// shaka: TEST_F(OnDemandMpdBuilderTest, VideoAndAudio)
	test('VideoAndAudio', () => {
		const fix = new OnDemandMpdBuilderFixture();
		fix.addRepresentation(VIDEO_MEDIA_INFO_1);
		fix.addRepresentation(AUDIO_MEDIA_INFO_1);
		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expectXmlEqual(
			out!,
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xmlns:xlink="http://www.w3.org/1999/xlink"'
			+ ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"'
			+ ' minBufferTime="PT2S" type="static"'
			+ ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"'
			+ ' mediaPresentationDuration="PT10.5S">\n'
			+ '  <Period id="0">\n'
			+ '    <AdaptationSet contentType="video" width="720" height="480" frameRate="10/1"'
			+ ' par="3:2" id="0">\n'
			+ '      <Representation id="0" bandwidth="7620" codecs="avc1.010101"'
			+ ' mimeType="video/mp4" sar="1:1">\n'
			+ '        <BaseURL>test_output_file_name1.mp4</BaseURL>\n'
			+ '        <SegmentBase indexRange="121-221" timescale="1000">\n'
			+ '          <Initialization range="0-120"/>\n'
			+ '        </SegmentBase>\n'
			+ '      </Representation>\n'
			+ '    </AdaptationSet>\n'
			+ '    <AdaptationSet contentType="audio" subsegmentStartsWithSAP="1" id="1">\n'
			+ '      <Representation id="1" bandwidth="400" codecs="mp4a.40.2"'
			+ ' mimeType="audio/mp4" audioSamplingRate="44100">\n'
			+ '        <AudioChannelConfiguration'
			+ ' schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"'
			+ ' value="2"/>\n'
			+ '        <BaseURL>test_output_file_name_audio1.mp4</BaseURL>\n'
			+ '        <SegmentBase timescale="50"/>\n'
			+ '      </Representation>\n'
			+ '    </AdaptationSet>\n'
			+ '  </Period>\n'
			+ '</MPD>\n',
		);
	});

	// shaka: TEST_F(OnDemandMpdBuilderTest, CheckXmlTest)
	test('CheckXmlTest', () => {
		const mpd = new MpdBuilder(onDemandOptions());
		const period = mpd.getOrCreatePeriod(0.0);
		addSegmentToPeriod(0.2, 3.0, period);
		const out = mpd.toString();
		expect(out).not.toBeNull();
		expect(out).toContain('<Period id="0">\n');
		expect(out).toContain(
			'<SegmentBase indexRange="121-221" timescale="1000" presentationTimeOffset="200">',
		);
	});

	// shaka: TEST_F(OnDemandMpdBuilderTest, MultiplePeriodTest)
	test('MultiplePeriodTest', () => {
		const mpd = new MpdBuilder(onDemandOptions());
		const period = mpd.getOrCreatePeriod(1.0);
		expect(period).not.toBeNull();
		expect(period.startTimeSeconds()).toBe(1.0);

		// Periods within 1.0s drift threshold are reused.
		const period2 = mpd.getOrCreatePeriod(1.1);
		expect(period2).toBe(period);
		expect(period2.startTimeSeconds()).toBe(1.0);

		const period3 = mpd.getOrCreatePeriod(5.0);
		expect(period3).not.toBe(period);
		expect(period3.startTimeSeconds()).toBe(5.0);
	});

	// shaka: TEST_F(OnDemandMpdBuilderTest, MultiplePeriodCheckXmlTest)
	test('MultiplePeriodCheckXmlTest', () => {
		const mpd = new MpdBuilder(onDemandOptions());
		const p1 = mpd.getOrCreatePeriod(0.0);
		addSegmentToPeriod(0.2, 3.0, p1);
		const p2 = mpd.getOrCreatePeriod(3.1);
		addSegmentToPeriod(5.5, 10.5, p2);
		const p3 = mpd.getOrCreatePeriod(8.0);
		addSegmentToPeriod(1.5, 10.0, p3);

		const out = mpd.toString();
		expect(out).not.toBeNull();
		expect(out).toContain('<Period id="0" duration="PT3S">\n');
		expect(out).toContain(
			'<SegmentBase indexRange="121-221" timescale="1000" presentationTimeOffset="200">',
		);
		expect(out).toContain('<Period id="1" duration="PT10.5S">\n');
		expect(out).toContain(
			'<SegmentBase indexRange="121-221" timescale="1000" presentationTimeOffset="5500">',
		);
		expect(out).toContain('<Period id="2" duration="PT10S">\n');
		expect(out).toContain(
			'<SegmentBase indexRange="121-221" timescale="1000" presentationTimeOffset="1500">',
		);
	});
});

describe('LiveMpdBuilderTest', () => {
	// shaka: TEST_F(LiveMpdBuilderTest, MultiplePeriodCheckXmlTest)
	test('MultiplePeriodCheckXmlTest', () => {
		const fix = new LiveMpdBuilderFixture();
		fix.mpd.getOrCreatePeriod(0.0);
		fix.mpd.getOrCreatePeriod(3.1);
		fix.mpd.getOrCreatePeriod(8.0);
		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expect(out).toContain(
			'  <Period id="0" start="PT0S"/>\n'
			+ '  <Period id="1" start="PT3.1S"/>\n'
			+ '  <Period id="2" start="PT8S"/>\n',
		);
	});

	// shaka: TEST_F(LiveMpdBuilderTest, DynamicCheckMpdAttributes)
	test('DynamicCheckMpdAttributes', () => {
		const fix = new LiveMpdBuilderFixture();
		const opts = fix.mpd.mpdOptionsForTesting();
		opts.mpdType = 'dynamic';
		opts.mpdParams.minimumUpdatePeriod = 2;
		opts.mpdParams.utcTimings = [
			{
				schemeIdUri: 'urn:mpeg:dash:utc:http-xsdate:2014',
				value: 'http://foo.bar/my_body_is_the_current_date_and_time',
			},
			{
				schemeIdUri: 'urn:mpeg:dash:utc:http-head:2014',
				value: 'http://foo.bar/check_me_for_the_date_header',
			},
		];

		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expect(out).toContain(
			'<!--Generated with https://github.com/shaka-project/shaka-packager'
			+ ' version <tag>-<hash>-<test>-->',
		);
		expectXmlEqual(
			out!,
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"'
			+ ' profiles="urn:mpeg:dash:profile:isoff-live:2011"'
			+ ' minBufferTime="PT2S"'
			+ ' type="dynamic"'
			+ ' publishTime="2016-01-11T15:10:24Z"'
			+ ' availabilityStartTime="2011-12-25T12:30:00"'
			+ ' minimumUpdatePeriod="PT2S">\n'
			+ '  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014"'
			+ ' value="http://foo.bar/my_body_is_the_current_date_and_time"/>\n'
			+ '  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014"'
			+ ' value="http://foo.bar/check_me_for_the_date_header"/>\n'
			+ '</MPD>\n',
		);
	});

	// shaka: TEST_F(LiveMpdBuilderTest, DynamicConvertToVoDCheckMpdAttributes)
	test('DynamicConvertToVoDCheckMpdAttributes', () => {
		const fix = new LiveMpdBuilderFixture();
		const opts = fix.mpd.mpdOptionsForTesting();
		opts.mpdType = 'dynamic';
		opts.mpdParams.minimumUpdatePeriod = 2;
		opts.mpdParams.eventToVodOnEndOfStream = true;
		fix.mpd.finalizeDynamicMpd();

		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expect(out).toContain(
			'<!--Generated with https://github.com/shaka-project/shaka-packager'
			+ ' version <tag>-<hash>-<test>-->',
		);
		expectXmlEqual(
			out!,
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"'
			+ ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"'
			+ ' minBufferTime="PT2S"'
			+ ' type="static" mediaPresentationDuration="PT0S"/>\n',
		);
	});

	// shaka: TEST_F(LiveMpdBuilderTest, StaticCheckMpdAttributes)
	test('StaticCheckMpdAttributes', () => {
		const fix = new LiveMpdBuilderFixture();
		const opts = fix.mpd.mpdOptionsForTesting();
		opts.mpdType = 'static';
		// Ignored in static MPD.
		opts.mpdParams.minimumUpdatePeriod = 2;
		opts.mpdParams.utcTimings = [
			{
				schemeIdUri: 'urn:mpeg:dash:utc:http-xsdate:2014',
				value: 'http://foo.bar/my_body_is_the_current_date_and_time',
			},
			{
				schemeIdUri: 'urn:mpeg:dash:utc:http-head:2014',
				value: 'http://foo.bar/check_me_for_the_date_header',
			},
		];

		const out = fix.mpd.toString();
		expect(out).not.toBeNull();
		expect(out).toContain(
			'<!--Generated with https://github.com/shaka-project/shaka-packager'
			+ ' version <tag>-<hash>-<test>-->',
		);
		expectXmlEqual(
			out!,
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"'
			+ ' profiles="urn:mpeg:dash:profile:isoff-live:2011"'
			+ ' minBufferTime="PT2S"'
			+ ' type="static"'
			+ ' mediaPresentationDuration="PT0S"/>\n',
		);
	});
});

describe('RelativePaths', () => {
	const MEDIA_FILE = 'foo/bar/media.mp4';
	const MEDIA_FILE_BASE = 'media.mp4';
	const INIT_SEGMENT = 'foo/bar/init.mp4';
	const INIT_SEGMENT_BASE = 'init.mp4';
	const SEGMENT_TEMPLATE = 'foo/bar/segment-$Number$.mp4';
	const SEGMENT_TEMPLATE_BASE = 'segment-$Number$.mp4';
	const PATH_MODIFIED_MPD = 'foo/bar/media.mpd';
	const PATH_NOT_MODIFIED_MPD = 'foo/baz/media.mpd';

	// shaka: TEST(RelativePaths, PathsModified)
	test('PathsModified', () => {
		const mediaInfo: MediaInfo = {
			mediaFileName: MEDIA_FILE,
			initSegmentName: INIT_SEGMENT,
			segmentTemplate: SEGMENT_TEMPLATE,
		};
		MpdBuilder.makePathsRelativeToMpd(PATH_MODIFIED_MPD, mediaInfo);
		expect(mediaInfo.mediaFileUrl).toBe(MEDIA_FILE_BASE);
		expect(mediaInfo.initSegmentUrl).toBe(INIT_SEGMENT_BASE);
		expect(mediaInfo.segmentTemplateUrl).toBe(SEGMENT_TEMPLATE_BASE);
	});

	// shaka: TEST(RelativePaths, PathsNotModified)
	test('PathsNotModified', () => {
		const mediaInfo: MediaInfo = {
			mediaFileName: MEDIA_FILE,
			initSegmentName: INIT_SEGMENT,
			segmentTemplate: SEGMENT_TEMPLATE,
		};
		MpdBuilder.makePathsRelativeToMpd(PATH_NOT_MODIFIED_MPD, mediaInfo);
		expect(mediaInfo.mediaFileUrl).toBe(MEDIA_FILE);
		expect(mediaInfo.initSegmentUrl).toBe(INIT_SEGMENT);
		expect(mediaInfo.segmentTemplateUrl).toBe(SEGMENT_TEMPLATE);
	});
});
