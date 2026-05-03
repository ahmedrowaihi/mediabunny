/*!
 * Test cases for the DASH RepresentationXmlNode + RepresentationBaseXmlNode
 * port. Where shaka has equivalent unit tests they are referenced inline by
 * name and the expected XML strings are pasted verbatim from shaka's
 * `xml_node_unittest.cc`. We use a tree-aware matcher (`expectXmlEqual`)
 * mirroring shaka's `XmlNodeEqual` so attribute-order / whitespace /
 * self-closing-form differences don't cause spurious failures.
 *
 * Original test source: shaka-packager packager/mpd/base/xml/xml_node_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import type { ContentProtectionElement } from '../../src/dash/dash-content-protection.js';
import {
	RepresentationBaseXmlNode,
	RepresentationXmlNode,
} from '../../src/dash/dash-representation-xml-node.js';
import { expectXmlEqual } from './_xml-equal.js';

describe('RepresentationBaseXmlNode — content protection', () => {
	// shaka: TEST(XmlNodeTest, AddContentProtectionElements)
	test('AddContentProtectionElements emits one <ContentProtection> per descriptor with subelements', () => {
		const widevine: ContentProtectionElement = {
			value: 'SOME bogus Widevine DRM version',
			schemeIdUri: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
			additionalAttributes: new Map(),
			subelements: [
				{ name: 'AnyElement', attributes: new Map(), content: 'any content', subelements: [] },
			],
		};
		const clearkey: ContentProtectionElement = {
			value: '',
			schemeIdUri: 'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b',
			additionalAttributes: new Map(),
			subelements: [],
		};

		const repr = new RepresentationXmlNode();
		expect(repr.addContentProtectionElements([widevine, clearkey])).toBe(true);

		expectXmlEqual(
			repr.toString(),
			'<Representation>\n'
			+ ' <ContentProtection\n'
			+ '   schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n'
			+ '   value="SOME bogus Widevine DRM version">\n'
			+ '     <AnyElement>any content</AnyElement>\n'
			+ ' </ContentProtection>\n'
			+ ' <ContentProtection\n'
			+ '   schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b">\n'
			+ ' </ContentProtection>\n'
			+ '</Representation>',
		);
	});

	test('top-level value/schemeIdUri win over duplicates in additionalAttributes', () => {
		const cp: ContentProtectionElement = {
			value: 'official',
			schemeIdUri: 'urn:uuid:abcd',
			additionalAttributes: new Map([
				['value', 'duplicate'],
				['schemeIdUri', 'duplicate'],
				['cenc:default_KID', 'kept'],
			]),
			subelements: [],
		};
		const repr = new RepresentationXmlNode();
		expect(repr.addContentProtectionElement(cp)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <ContentProtection schemeIdUri="urn:uuid:abcd" value="official"'
			+ '                     cenc:default_KID="kept"/>'
			+ '</Representation>',
		);
	});

	test('addSupplementalProperty / addEssentialProperty render the right tag names', () => {
		class TestNode extends RepresentationBaseXmlNode {
			constructor() {
				super('Test');
			}
		}
		const node = new TestNode();
		expect(node.addSupplementalProperty('urn:scheme:supp', 'val1')).toBe(true);
		expect(node.addEssentialProperty('urn:scheme:ess', 'val2')).toBe(true);
		expectXmlEqual(
			node.toString(),
			'<Test>'
			+ '  <SupplementalProperty schemeIdUri="urn:scheme:supp" value="val1"/>'
			+ '  <EssentialProperty schemeIdUri="urn:scheme:ess" value="val2"/>'
			+ '</Test>',
		);
	});

	test('descriptor without value omits value attribute', () => {
		class TestNode extends RepresentationBaseXmlNode {
			constructor() {
				super('Test');
			}
		}
		const node = new TestNode();
		expect(node.addSupplementalProperty('urn:scheme:no-value', '')).toBe(true);
		expectXmlEqual(
			node.toString(),
			'<Test><SupplementalProperty schemeIdUri="urn:scheme:no-value"/></Test>',
		);
	});
});

describe('RepresentationXmlNode — addVideoInfo', () => {
	test('basic width/height/frameRate emission', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVideoInfo({
			codec: 'avc1.640028',
			width: 1920,
			height: 1080,
			timeScale: 30000,
			frameDuration: 1001,
		}, true, true, true)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation width="1920" height="1080" frameRate="30000/1001"/>',
		);
	});

	test('SAR emitted from pixelWidth:pixelHeight', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVideoInfo({
			width: 1920,
			height: 818,
			pixelWidth: 16,
			pixelHeight: 15,
		}, true, true, false)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation sar="16:15" width="1920" height="818"/>',
		);
	});

	test('SuppressFlag suppresses width / height / frameRate independently', () => {
		const repr = new RepresentationXmlNode();
		repr.addVideoInfo({
			width: 1920,
			height: 1080,
			timeScale: 30000,
			frameDuration: 1001,
		}, false, true, false);
		expectXmlEqual(repr.toString(), '<Representation height="1080"/>');
	});

	test('trick play sets maxPlayoutRate + codingDependency=false', () => {
		const repr = new RepresentationXmlNode();
		repr.addVideoInfo({
			width: 1920,
			height: 1080,
			playbackRate: 4,
		}, true, true, true);
		expectXmlEqual(
			repr.toString(),
			'<Representation width="1920" height="1080" maxPlayoutRate="4" codingDependency="false"/>',
		);
	});

	test('returns false when width or height missing', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVideoInfo({ codec: 'avc1' }, true, true, true)).toBe(false);
	});
});

describe('RepresentationXmlNode — addAudioInfo', () => {
	// shaka: TEST(XmlNodeTest, AddEC3AudioInfo)
	test('EC-3 with NO_MAPPING uses Dolby channel mask hex', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'ec-3',
			samplingFrequency: 48000,
			codecSpecificData: { channelMask: 0xF801, channelMpegValue: 0xFFFFFFFF },
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">\n'
			+ '  <AudioChannelConfiguration\n'
			+ '   schemeIdUri="tag:dolby.com,2014:dash:audio_channel_configuration:2011"\n'
			+ '   value="F801"/>\n'
			+ '</Representation>',
		);
	});

	// shaka: TEST(XmlNodeTest, AddEC3AudioInfoMPEGScheme)
	test('EC-3 with MPEG channel value uses urn:mpeg:mpegB:cicp scheme', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'ec-3',
			samplingFrequency: 48000,
			codecSpecificData: { channelMask: 0xF801, channelMpegValue: 6 },
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">\n'
			+ '  <AudioChannelConfiguration\n'
			+ '   schemeIdUri="urn:mpeg:mpegB:cicp:ChannelConfiguration"\n'
			+ '   value="6"/>\n'
			+ '</Representation>',
		);
	});

	// shaka: TEST(XmlNodeTest, AddEC3AudioInfoMPEGSchemeJOC)
	test('EC-3 with JOC complexity adds two SupplementalProperty descriptors', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'ec-3',
			samplingFrequency: 48000,
			codecSpecificData: { channelMask: 0xF801, channelMpegValue: 6, ec3JocComplexity: 16 },
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">\n'
			+ '  <AudioChannelConfiguration\n'
			+ '   schemeIdUri="urn:mpeg:mpegB:cicp:ChannelConfiguration"\n'
			+ '   value="6"/>\n'
			+ '  <SupplementalProperty\n'
			+ '   schemeIdUri="tag:dolby.com,2018:dash:EC3_ExtensionType:2018"\n'
			+ '   value="JOC"/>\n'
			+ '  <SupplementalProperty\n'
			+ '   schemeIdUri="tag:dolby.com,2018:dash:EC3_ExtensionComplexityIndex:2018"\n'
			+ '   value="16"/>\n'
			+ '</Representation>',
		);
	});

	// shaka: TEST(XmlNodeTest, AddAC4AudioInfo)
	test('AC-4 with NO_MAPPING uses Dolby AC-4 channel mask hex (6 digits)', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'ac-4.02.01.02',
			samplingFrequency: 48000,
			codecSpecificData: {
				channelMask: 0x0000C7,
				channelMpegValue: 0xFFFFFFFF,
				ac4ImsFlag: false,
			},
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">\n'
			+ '  <AudioChannelConfiguration\n'
			+ '   schemeIdUri="tag:dolby.com,2015:dash:audio_channel_configuration:2015"\n'
			+ '   value="0000C7"/>\n'
			+ '</Representation>',
		);
	});

	// shaka: TEST(XmlNodeTest, AddAC4AudioInfoMPEGScheme)
	test('AC-4 with MPEG channel value uses urn:mpeg:mpegB:cicp scheme', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'ac-4.02.01.00',
			samplingFrequency: 48000,
			codecSpecificData: {
				channelMask: 0x000001,
				channelMpegValue: 2,
				ac4ImsFlag: false,
			},
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">\n'
			+ '  <AudioChannelConfiguration\n'
			+ '   schemeIdUri="urn:mpeg:mpegB:cicp:ChannelConfiguration"\n'
			+ '   value="2"/>\n'
			+ '</Representation>',
		);
	});

	// shaka: TEST(XmlNodeTest, AddAC4AudioInfoMPEGSchemeIMS)
	test('AC-4 IMS sets virtualized_content SupplementalProperty', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'ac-4.02.02.00',
			samplingFrequency: 48000,
			codecSpecificData: {
				channelMask: 0x000001,
				channelMpegValue: 2,
				ac4ImsFlag: true,
			},
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">\n'
			+ '  <AudioChannelConfiguration\n'
			+ '   schemeIdUri="urn:mpeg:mpegB:cicp:ChannelConfiguration"\n'
			+ '   value="2"/>\n'
			+ '  <SupplementalProperty\n'
			+ '   schemeIdUri="tag:dolby.com,2016:dash:virtualized_content:2016"\n'
			+ '   value="1"/>\n'
			+ '</Representation>',
		);
	});

	test('DTS-C uses dts:2014 scheme with numChannels value', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'dtsc',
			samplingFrequency: 48000,
			numChannels: 6,
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">'
			+ '  <AudioChannelConfiguration'
			+ '   schemeIdUri="tag:dts.com,2014:dash:audio_channel_configuration:2012"'
			+ '   value="6"/>'
			+ '</Representation>',
		);
	});

	test('DTS-X uses dts:2018 scheme with 8-digit hex channelMask', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'dtsx',
			samplingFrequency: 48000,
			codecSpecificData: { channelMask: 0x12345678 },
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">'
			+ '  <AudioChannelConfiguration'
			+ '   schemeIdUri="tag:dts.com,2018:uhd:audio_channel_configuration"'
			+ '   value="12345678"/>'
			+ '</Representation>',
		);
	});

	test('generic codec uses urn:mpeg:dash:23003:3 scheme with numChannels value', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'mp4a.40.2',
			samplingFrequency: 48000,
			numChannels: 2,
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation audioSamplingRate="48000">'
			+ '  <AudioChannelConfiguration'
			+ '   schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"'
			+ '   value="2"/>'
			+ '</Representation>',
		);
	});

	test('audio without samplingFrequency omits audioSamplingRate', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addAudioInfo({
			codec: 'mp4a.40.2',
			numChannels: 2,
		})).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <AudioChannelConfiguration'
			+ '   schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"'
			+ '   value="2"/>'
			+ '</Representation>',
		);
	});
});

describe('RepresentationXmlNode — addVODOnlyInfo', () => {
	test('emits BaseURL + SegmentBase with init+index ranges and timescale', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVODOnlyInfo({
			mediaFileUrl: 'media.mp4',
			initRange: { begin: 0, end: 999 },
			indexRange: { begin: 1000, end: 1999 },
			referenceTimeScale: 90000,
		}, false, 0)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <BaseURL>media.mp4</BaseURL>'
			+ '  <SegmentBase indexRange="1000-1999" timescale="90000">'
			+ '    <Initialization range="0-999"/>'
			+ '  </SegmentBase>'
			+ '</Representation>',
		);
	});

	test('useSegmentList emits SegmentList without indexRange', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVODOnlyInfo({
			mediaFileUrl: 'media.mp4',
			initRange: { begin: 0, end: 999 },
			referenceTimeScale: 90000,
			subsegmentRanges: [
				{ begin: 1000, end: 5000 },
				{ begin: 5001, end: 9999 },
			],
		}, true, 4)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <BaseURL>media.mp4</BaseURL>'
			+ '  <SegmentList timescale="90000" duration="360000">'
			+ '    <Initialization range="0-999"/>'
			+ '    <SegmentURL mediaRange="1000-5000"/>'
			+ '    <SegmentURL mediaRange="5001-9999"/>'
			+ '  </SegmentList>'
			+ '</Representation>',
		);
	});

	test('text + presentationTimeOffset uses single-segment SegmentList with media= URL', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVODOnlyInfo({
			mediaFileUrl: 'subs.vtt',
			textInfo: { codec: 'wvtt' },
			presentationTimeOffset: 0,
		}, false, 0)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <SegmentList presentationTimeOffset="0">'
			+ '    <SegmentURL media="subs.vtt"/>'
			+ '  </SegmentList>'
			+ '</Representation>',
		);
	});

	test('returns true with no segment-base/list when only mediaFileUrl is present', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addVODOnlyInfo({
			mediaFileUrl: 'media.mp4',
		}, false, 0)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <BaseURL>media.mp4</BaseURL>'
			+ '</Representation>',
		);
	});

	test('mediaFileUrl is URL-encoded inside BaseURL', () => {
		const repr = new RepresentationXmlNode();
		repr.addVODOnlyInfo({ mediaFileUrl: 'a b/c.mp4' }, false, 0);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <BaseURL>a%20b%2Fc.mp4</BaseURL>'
			+ '</Representation>',
		);
	});
});

describe('RepresentationXmlNode — addLiveOnlyInfo', () => {
	// shaka: TEST_F(LiveSegmentTimelineTest, OneSegmentInfoNonZeroStartTime)
	test('SegmentTemplate with SegmentTimeline child for one segment-info', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addLiveOnlyInfo(
			{ segmentTemplateUrl: '$Number$.m4s' },
			[{ startTime: 500, duration: 100, repeat: 9, startSegmentNumber: 1 }],
			false,
		)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <SegmentTemplate media="$Number$.m4s" startNumber="1">'
			+ '    <SegmentTimeline>'
			+ '      <S t="500" d="100" r="9"/>'
			+ '    </SegmentTimeline>'
			+ '  </SegmentTemplate>'
			+ '</Representation>',
		);
	});

	// shaka: TEST_F(LiveSegmentTimelineTest, OneSegmentInfo) — needs the
	// `--segment_template_constant_duration` flag passed.
	test('flagSegmentTemplateConstantDuration collapses to SegmentTemplate@duration when starts match', () => {
		const repr = new RepresentationXmlNode();
		// Segment starts at 0, repeat=9, duration=100 → all match S@r structure.
		expect(repr.addLiveOnlyInfo(
			{ segmentTemplateUrl: '$Number$.m4s' },
			[{ startTime: 0, duration: 100, repeat: 9, startSegmentNumber: 1 }],
			false,
			false, // dash_add_last_segment_number_when_needed
			true, // segment_template_constant_duration
		)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <SegmentTemplate media="$Number$.m4s" startNumber="1" duration="100"/>'
			+ '</Representation>',
		);
	});

	test('low-latency sets availabilityTimeComplete=false and skips SegmentTimeline', () => {
		const repr = new RepresentationXmlNode();
		expect(repr.addLiveOnlyInfo(
			{ segmentTemplateUrl: '$Number$.m4s', availabilityTimeOffset: 0.5 },
			[{ startTime: 0, duration: 100, repeat: 0, startSegmentNumber: 1 }],
			true,
		)).toBe(true);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <SegmentTemplate availabilityTimeOffset="0.5" availabilityTimeComplete="false"'
			+ '                   media="$Number$.m4s" startNumber="1"/>'
			+ '</Representation>',
		);
	});

	test('initSegmentUrl emits as initialization attribute', () => {
		const repr = new RepresentationXmlNode();
		repr.addLiveOnlyInfo(
			{
				segmentTemplateUrl: '$Number$.m4s',
				initSegmentUrl: 'init.m4s',
				referenceTimeScale: 90000,
			},
			[],
			false,
		);
		expectXmlEqual(
			repr.toString(),
			'<Representation>'
			+ '  <SegmentTemplate timescale="90000" initialization="init.m4s"'
			+ '                   media="$Number$.m4s" startNumber="1"/>'
			+ '</Representation>',
		);
	});
});
