/* eslint-disable @stylistic/max-len */
import { describe, expect, test } from 'vitest';
import type {
	ContentProtection,
	Mpd,
	MpdAdaptationSet,
	MpdPeriod,
	MpdRepresentation,
	SegmentTemplate,
} from '../../src/dash/dash-mpd-parser.js';
import { serializeMpd } from '../../src/dash/dash-mpd-serializer.js';
import { rebaseManifest } from '../../src/manifest-transforms.js';
import { assert } from '../../src/misc.js';
import {
	mpd as mpdFactory,
	mpdAdaptationSet,
	mpdBaseURL,
	mpdContentSteering,
	mpdPeriod,
	mpdRepresentation,
	mpdThumbnailTile,
	readMpdThumbnailTile,
} from '../../src/dash/dash-mpd-factories.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, DashOutputFormat, type DashOutputFormatOptions } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { parseMpd } from '../../src/dash/dash-mpd-parser.js';
import { parseRootElement, type ParsedXmlNode } from './_xml-equal.js';

const parse = (xml: string) => parseMpd(xml);

const representation = (over: Partial<MpdRepresentation> = {}): MpdRepresentation => ({
	// Spread the factory so a new AST field needs no mirror here
	...mpdRepresentation({ id: 'v0', bandwidth: 1_200_000, width: 1920, height: 1080,
		codecs: 'avc1.640028', mimeType: 'video/mp4' }),
	...over,
});

const adaptationSet = (over: Partial<MpdAdaptationSet> = {}): MpdAdaptationSet => ({
	...mpdAdaptationSet({ id: '0', contentType: 'video', mimeType: 'video/mp4',
		representations: [representation()] }),
	...over,
});

const period = (over: Partial<MpdPeriod> = {}): MpdPeriod => ({
	...mpdPeriod({ adaptationSets: [adaptationSet()] }),
	...over,
});

const mpd = (over: Partial<Mpd> = {}): Mpd => ({
	...mpdFactory({ type: 'static', profiles: ['urn:mpeg:dash:profile:isoff-live:2011'],
		periods: [period()] }),
	...over,
});

const template = (over: Partial<SegmentTemplate> = {}): SegmentTemplate => ({
	media: '$RepresentationID$/$Number$.m4s',
	initialization: '$RepresentationID$/init.mp4',
	bitstreamSwitching: null,
	startNumber: 1,
	timescale: 1,
	duration: null,
	presentationTimeOffset: 0,
	availabilityTimeOffset: 0,
	availabilityTimeComplete: true,
	timeline: null,
	index: null,
	endNumber: null,
	indexRange: null,
	indexRangeExact: null,
	presentationDuration: null,
	timeShiftBufferDepth: null,
	eptDelta: null,
	pdDelta: null,
	...over,
});

describe('serializeMpd', () => {
	test('emits the XML declaration and default MPD namespace', () => {
		const out = serializeMpd(mpd());
		expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(out).toContain('<MPD ');
		expect(out).toContain('xmlns="urn:mpeg:dash:schema:mpd:2011"');
		expect(out).toContain('type="static"');
		expect(out).toContain('profiles="urn:mpeg:dash:profile:isoff-live:2011"');
	});

	test('durations render as ISO-8601 PT#S and datetimes as ISO', () => {
		const out = serializeMpd(mpd({
			mediaPresentationDuration: 634.566,
			minBufferTime: 2,
			availabilityStartTime: Date.parse('2026-01-02T03:04:05.000Z'),
		}));
		expect(out).toContain('mediaPresentationDuration="PT634.566S"');
		expect(out).toContain('minBufferTime="PT2S"');
		expect(out).toContain('availabilityStartTime="2026-01-02T03:04:05.000Z"');
	});

	test('frameRate renders as a bare integer or a ratio', () => {
		const bare = serializeMpd(mpd({
			periods: [period({ adaptationSets: [adaptationSet({
				representations: [representation({ frameRate: { numerator: 30, denominator: 1 } })],
			})] })],
		}));
		expect(bare).toContain('frameRate="30"');

		const ratio = serializeMpd(mpd({
			periods: [period({ adaptationSets: [adaptationSet({
				representations: [representation({ frameRate: { numerator: 30000, denominator: 1001 } })],
			})] })],
		}));
		expect(ratio).toContain('frameRate="30000/1001"');
	});

	test('coalesced defaults are omitted; non-defaults are emitted', () => {
		const omitted = serializeMpd(mpd({
			periods: [period({ adaptationSets: [adaptationSet({
				segmentTemplate: template(),
			})] })],
		}));
		expect(omitted).toContain('<SegmentTemplate ');
		expect(omitted).not.toContain('timescale=');
		expect(omitted).not.toContain('startNumber=');
		expect(omitted).not.toContain('presentationTimeOffset=');

		const emitted = serializeMpd(mpd({
			periods: [period({ adaptationSets: [adaptationSet({
				segmentTemplate: template({ timescale: 90000, startNumber: 5, presentationTimeOffset: 900 }),
			})] })],
		}));
		expect(emitted).toContain('timescale="90000"');
		expect(emitted).toContain('startNumber="5"');
		expect(emitted).toContain('presentationTimeOffset="900"');
	});

	test('SegmentTimeline emits one <S> per entry, @r only when non-zero', () => {
		const out = serializeMpd(mpd({
			periods: [period({ adaptationSets: [adaptationSet({
				segmentTemplate: template({
					timescale: 48000,
					timeline: [
						{ t: 0, d: 96000, r: 4 },
						{ t: null, d: 48000, r: 0 },
					],
				}),
			})] })],
		}));
		expect(out).toContain('<SegmentTimeline>');
		expect(out).toContain('<S t="0" d="96000" r="4"/>');
		expect(out).toContain('<S d="48000"/>');
	});

	test('ContentProtection injects xmlns:cenc, dashed cenc:default_KID, and base64 cenc:pssh', () => {
		const cp: ContentProtection = {
			schemeIdUri: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
			value: 'Widevine',
			keyId: '1234567890abcdef1234567890abcdef',
			psshBoxes: [new Uint8Array([0, 1, 2, 3])],
			foreignXml: [],
		};
		const out = serializeMpd(mpd({
			periods: [period({ adaptationSets: [adaptationSet({ contentProtections: [cp] })] })],
		}));
		expect(out).toContain('xmlns:cenc="urn:mpeg:cenc:2013"');
		expect(out).toContain('cenc:default_KID="12345678-90ab-cdef-1234-567890abcdef"');
		expect(out).toContain('schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"');
		expect(out).toContain('<cenc:pssh>AAECAw==</cenc:pssh>');
	});

	test('BaseURL is emitted verbatim, not percent-encoded', () => {
		const out = serializeMpd(mpd({
			baseURLs: [{ value: 'https://cdn.example.com/vod/?token=abc123&exp=99', serviceLocation: null }, { value: 'already%20encoded/path/', serviceLocation: null }],
		}));
		expect(out).toContain('<BaseURL>https://cdn.example.com/vod/?token=abc123&amp;exp=99</BaseURL>');
		expect(out).toContain('<BaseURL>already%20encoded/path/</BaseURL>');
		expect(out).not.toContain('%3F');
		expect(out).not.toContain('%2520');
	});

	test('multiple periods and representations serialize in document order', () => {
		const out = serializeMpd(mpd({
			periods: [
				period({ id: 'p0' }),
				period({ id: 'p1', adaptationSets: [adaptationSet({
					representations: [representation({ id: 'a', bandwidth: 1 }), representation({ id: 'b', bandwidth: 2 })],
				})] }),
			],
		}));
		expect(out.indexOf('id="p0"')).toBeLessThan(out.indexOf('id="p1"'));
		expect(out.indexOf('id="a"')).toBeLessThan(out.indexOf('id="b"'));
	});

	test('SegmentTemplate@availabilityTimeComplete round-trips, and the default is omitted', () => {
		const withTemplate = (segmentTemplate: ReturnType<typeof template>) => serializeMpd(mpd({ periods: [period({
			adaptationSets: [adaptationSet({ representations: [representation({ segmentTemplate })] })],
		})] }));
		const parsedTemplate = (xml: string) =>
			parse(xml).periods[0]!.adaptationSets[0]!.representations[0]!.segmentTemplate!;

		const xml = withTemplate(template({ availabilityTimeOffset: 1.48, availabilityTimeComplete: false }));
		expect(xml).toContain('availabilityTimeOffset="1.48" availabilityTimeComplete="false"');
		expect(parsedTemplate(xml).availabilityTimeOffset).toBe(1.48);
		expect(parsedTemplate(xml).availabilityTimeComplete).toBe(false);

		expect(serializeMpd(mpd())).not.toContain('availabilityTimeComplete');
		expect(parsedTemplate(withTemplate(template())).availabilityTimeComplete).toBe(true);
	});

	// Every element path mapped to its attribute names and child element names
	const outline = (xml: string) => {
		const result = new Map<string, string[]>();
		const walk = (node: ParsedXmlNode, path: string) => {
			const names = [...node.attributes.keys()].map(name => `@${name}`);
			result.set(path, [...(result.get(path) ?? []), ...names, ...node.children.map(child => `<${child.name}>`)]);
			node.children.forEach(child => walk(child, `${path}/${child.name}`));
		};
		const root = parseRootElement(xml);
		walk(root, root.name);
		return result;
	};

	test.each([
		['static', {}],
		['single-file on-demand', { singleFilePerPlaylist: true }],
		['live low-latency', {
			live: true,
			partDuration: 0.5,
			targetDuration: 2,
			mpdParams: { lowLatencyDashMode: true, targetLatencySeconds: 3 },
		}],
	] as [string, Partial<DashOutputFormatOptions>][])(
		'an MPD the fork writes (%s) keeps every attribute and element through parse and serialize',
		{ timeout: 60_000 },
		async (_, options) => {
			let written = '';
			using input = new Input({ source: new FilePathSource('./test/public/video.mp4'), formats: ALL_FORMATS });
			const output = new Output({
				format: new DashOutputFormat({
					segmentFormat: new CmafOutputFormat(),
					mpdPath: 'manifest.mpd',
					onMpd: (content) => {
						written = content;
					},
					...options,
				}),
				target: new PathedTarget('', () => new BufferTarget()),
			});
			await (await Conversion.init({ input, output })).execute();

			const before = outline(written);
			const after = outline(serializeMpd(parse(written)));
			for (const [path, items] of before) {
				// startNumber="1" is the spec default, which serializeMpd omits; the value itself survives
				const expected = items.filter(item => !(path.endsWith('/SegmentTemplate') && item === '@startNumber'));
				expect(after.get(path) ?? [], path).toEqual(expect.arrayContaining(expected));
			}
		},
	);

	test('live MPD fields, AdaptationSet attributes and ServiceDescription round-trip by value', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd" type="dynamic"
 profiles="urn:mpeg:dash:profile:isoff-live:2011" availabilityStartTime="2026-09-14T06:30:51.000Z"
 publishTime="2026-09-14T06:31:00.000Z" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT30S"
 suggestedPresentationDelay="PT3S" minBufferTime="PT2S">
  <ServiceDescription id="7">
    <Latency referenceId="1" target="3000" min="2000" max="6000"/>
    <PlaybackRate min="0.96" max="1.04"/>
  </ServiceDescription>
  <Period id="0" start="PT0S">
    <ServiceDescription id="0">
      <Latency target="3000"/>
    </ServiceDescription>
    <AdaptationSet id="0" contentType="video" width="1920" height="1080" par="16:9" startWithSAP="1"
     subsegmentStartsWithSAP="1" segmentAlignment="true" subsegmentAlignment="2">
      <Representation id="v" bandwidth="4000000" codecs="avc1.640028" mimeType="video/mp4">
        <SegmentTemplate timescale="90000" startNumber="42" presentationTimeOffset="900000"
         availabilityTimeOffset="1.48" availabilityTimeComplete="false" initialization="init.m4s"
         media="$Number$.m4s" duration="180000"/>
      </Representation>
    </AdaptationSet>
  </Period>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="https://time.akamai.com/?iso"/>
</MPD>`;

		const first = parse(xml);
		expect(parse(serializeMpd(first))).toEqual(first);

		expect(first).toMatchObject({
			type: 'dynamic',
			availabilityStartTime: Date.parse('2026-09-14T06:30:51Z'),
			publishTime: Date.parse('2026-09-14T06:31:00Z'),
			minimumUpdatePeriod: 2,
			timeShiftBufferDepth: 30,
			suggestedPresentationDelay: 3,
			schemaLocation: 'urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd',
			serviceDescriptions: [{
				id: 7,
				latency: { referenceId: 1, target: 3000, min: 2000, max: 6000, qualityLatency: [] },
				playbackRate: { min: 0.96, max: 1.04 },
			}],
			utcTiming: [{ schemeIdUri: 'urn:mpeg:dash:utc:http-iso:2014', value: 'https://time.akamai.com/?iso' }],
		});
		const period = first.periods[0]!;
		expect(period.serviceDescriptions).toEqual([
			{
				id: 0,
				latency: { referenceId: null, target: 3000, min: null, max: null, qualityLatency: [] },
				playbackRate: null,
				scopes: [],
				operatingQuality: [],
				operatingBandwidth: [],
			},
		]);
		expect(period.adaptationSets[0]).toMatchObject({
			width: 1920,
			height: 1080,
			par: '16:9',
			startWithSAP: 1,
			subsegmentStartsWithSAP: 1,
			segmentAlignment: true,
			subsegmentAlignment: 2,
		});
		expect(period.adaptationSets[0]!.representations[0]!.segmentTemplate).toMatchObject({
			startNumber: 42,
			presentationTimeOffset: 900000,
			availabilityTimeOffset: 1.48,
			availabilityTimeComplete: false,
		});
	});
});

test('MPDs parse without a DOMParser, including CDATA, character references and comments', () => {
	const mpd = parse(`<?xml version="1.0"?>
<!DOCTYPE MPD>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S">
	<!-- a comment with <markup> -->
	<BaseURL><![CDATA[https://media.example/a?b=1&c=<2>]]></BaseURL>
	<Period><AdaptationSet><Representation id="r&amp;&#x42;&#67;" bandwidth="1"/></AdaptationSet></Period>
</MPD>`);
	expect(mpd.baseURLs)
		.toEqual([{ value: 'https://media.example/a?b=1&c=<2>', serviceLocation: null }]);
	expect(mpd.periods[0]!.adaptationSets[0]!.representations[0]!.id).toBe('r&BC');

	expect(() => parse('<MPD><Period></MPD>')).toThrow('MPD parse error');
	expect(() => parse('<MPD type=static></MPD>')).toThrow('MPD parse error');
	expect(() => parse('<MPD>&nbsp;</MPD>')).toThrow('MPD parse error');
});

// Every attribute below is one parseMpd models. A spec attribute the parser reads but the serializer never writes
// is invisible to a value assertion, and where the schema gives a default (bitstreamSwitching) the dropped
// attribute reads back as its opposite — so the check compares attribute SETS, per element, in both directions.
describe('MPD round-trip keeps every modelled attribute', () => {
	const SOURCE = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT60.288S" minBufferTime="PT2S">
  <Period id="0" start="PT0S" duration="PT60.288S" bitstreamSwitching="true">
    <AdaptationSet id="1" group="1" contentType="video" mimeType="video/mp4" codecs="avc1.64001f" lang="en" par="16:9" sar="1:1" bitstreamSwitching="true" segmentAlignment="true" subsegmentAlignment="true" startWithSAP="1" subsegmentStartsWithSAP="1" maxWidth="1920" maxHeight="1080" minWidth="640" minHeight="360" maxBandwidth="6000000" minBandwidth="400000" maxFrameRate="30000/1001" minFrameRate="24" audioSamplingRate="48000" scanType="progressive" codingDependency="true" maxPlayoutRate="2" maximumSAPPeriod="4" selectionPriority="3" tag="hd" profiles="urn:mpeg:dash:profile:isoff-live:2011" segmentProfiles="dash" containerProfiles="cmfc" initializationSetRef="1,2" initializationPrincipal="init.mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="12345678-1234-1234-1234-123456789012"/>
      <Representation id="v0" bandwidth="1200000" codecs="avc1.64001f" mimeType="video/mp4" width="1280" height="720" sar="1:1" audioSamplingRate="48000" startWithSAP="1" qualityRanking="2" dependencyId="v1" associationId="a0" associationType="soun" mediaStreamStructureId="s1" scanType="progressive" codingDependency="true" maxPlayoutRate="2" maximumSAPPeriod="4" selectionPriority="3" tag="hd" profiles="urn:mpeg:dash:profile:isoff-live:2011" segmentProfiles="dash" containerProfiles="cmfc">
        <SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4" index="idx.mp4" bitstreamSwitching="bs.mp4" duration="4" timescale="1000" startNumber="137" endNumber="500" indexRange="0-999" indexRangeExact="true" presentationDuration="60288" timeShiftBufferDepth="PT30S" eptDelta="-2" pdDelta="3" presentationTimeOffset="12" availabilityTimeOffset="1.5"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

	const attributesByElement = (xml: string) => {
		const out: Record<string, Set<string>> = {};
		for (const [, name, attrs] of xml.matchAll(/<(MPD|Period|AdaptationSet|Representation|SegmentTemplate)\s([^>]*?)\/?>/g)) {
			const set = out[name!] ??= new Set();
			for (const [, attr] of attrs!.matchAll(/([\w:]+)="/g)) {
				set.add(attr!);
			}
		}
		return out;
	};

	test('no attribute present in the source is missing from the output', () => {
		const before = attributesByElement(SOURCE);
		const after = attributesByElement(serializeMpd(parseMpd(SOURCE)));

		expect(Object.keys(before).sort()).toEqual(
			['AdaptationSet', 'MPD', 'Period', 'Representation', 'SegmentTemplate'],
		);

		const lost: string[] = [];
		for (const [element, attrs] of Object.entries(before)) {
			for (const attr of attrs) {
				if (!after[element]?.has(attr)) {
					lost.push(`${element}@${attr}`);
				}
			}
		}

		expect(lost).toEqual([]);
	});
});

// One MPD carrying every element DASH-MPD.xsd defines on the elements we parse. The attribute audit above cannot
// see a whole element going missing, which is how SCTE-35 `<EventStream>` was dropped silently: parsed by nothing,
// emitted by nothing, and invisible to any check that compares attributes of elements that survived.
describe('MPD round-trip keeps every schema element', () => {
	const EVERY_ELEMENT = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <ProgramInformation lang="en" moreInformationURL="https://x/info"><Title>T</Title><Source>S</Source><Copyright>C</Copyright></ProgramInformation>
  <Location>https://x/mpd</Location>
  <PatchLocation ttl="60">https://x/patch</PatchLocation>
  <Metrics metrics="BufferLevel"><Range starttime="PT0S" duration="PT10S"/><Reporting schemeIdUri="urn:dvb:dash:reporting:2014" value="1"/></Metrics>
  <LeapSecondInformation availabilityStartLeapOffset="0" nextAvailabilityStartLeapOffset="1" nextLeapChangeTime="2026-12-31T23:59:60Z"/>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="https://x/time"/>
  <ServiceDescription id="0"><Scope schemeIdUri="urn:x"/><Latency referenceId="1" target="3000" min="2000" max="6000"><QualityLatency type="urn:q">1 2</QualityLatency></Latency><PlaybackRate min="0.9" max="1.1"/><OperatingQuality type="urn:oq" min="1" max="9" target="5" maxDifference="2"/><OperatingBandwidth min="100" max="900" target="500"/></ServiceDescription>
  <Period id="1" start="PT0S" bitstreamSwitching="true">
    <AssetIdentifier schemeIdUri="urn:org:dashif:asset-id:2013" value="asset"/>
    <EventStream schemeIdUri="urn:scte:scte35:2014:xml+bin" timescale="1000"><Event presentationTime="1" duration="2" id="3"><Signal xmlns="http://www.scte.org/schemas/35/2016"><Binary>AAA=</Binary></Signal></Event></EventStream>
    <Subset contains="0 1" id="s1"/>
    <GroupLabel id="1" lang="en">G</GroupLabel>
    <AdaptationSet id="1" mimeType="video/mp4" contentType="video">
      <Accessibility schemeIdUri="urn:tva" value="1"/>
      <Rating schemeIdUri="urn:r" value="PG"/>
      <Viewpoint schemeIdUri="urn:v" value="1"/>
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <ContentComponent id="1" lang="en" contentType="video" par="16:9" tag="t"><Accessibility schemeIdUri="urn:a" value="1"/><Role schemeIdUri="urn:r2" value="main"/><Rating schemeIdUri="urn:r3" value="G"/><Viewpoint schemeIdUri="urn:v2" value="2"/></ContentComponent>
      <FramePacking schemeIdUri="urn:fp" value="3"/>
      <OutputProtection schemeIdUri="urn:op" value="hdcp"/>
      <InbandEventStream schemeIdUri="urn:mpeg:dash:event:2012" value="1"><Event id="9" messageData="m"/></InbandEventStream>
      <ProducerReferenceTime id="0" inband="true" type="encoder" wallClockTime="2026-01-01T00:00:00Z" presentationTime="0"><UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="https://x/t"/></ProducerReferenceTime>
      <RandomAccess interval="2" type="closed" minBufferTime="PT1S" bandwidth="100"/>
      <Resync type="1" dT="100" dImax="2.5" dImin="0.5" marker="true"/>
      <Switching interval="4" type="media"/>
      <ContentPopularityRate><PR popularityRate="50" start="0" r="2"/></ContentPopularityRate>
      <Label id="2" lang="en">L</Label>
      <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      <SupplementalProperty schemeIdUri="urn:sp" value="1" id="sp1"/>
      <EssentialProperty schemeIdUri="urn:ep" value="1"/>
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <Representation id="v0" bandwidth="1200000" codecs="avc1.64001f">
        <ExtendedBandwidth vbr="true"><ModelPair bufferTime="PT2S" bandwidth="900000"/></ExtendedBandwidth>
        <SubRepresentation level="0" dependencyLevel="1 2" bandwidth="400000" contentComponent="1"><Resync type="2" dT="50"/></SubRepresentation>
        <SegmentTemplate media="$Number$.m4s" initialization="init.mp4" duration="4" startNumber="7"><SegmentTimeline><S t="0" d="4" r="2"/></SegmentTimeline></SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;

	const elementNames = (xml: string) => new Set(
		[...xml.matchAll(/<([A-Za-z][\w:]*)[\s/>]/g)].map(match => match[1]!),
	);

	test('no element present in the source is missing from the output', () => {
		const before = elementNames(EVERY_ELEMENT);
		const after = elementNames(serializeMpd(parseMpd(EVERY_ELEMENT)));

		expect(before.size).toBeGreaterThan(50);
		expect([...before].filter(name => !after.has(name)).sort()).toEqual([]);
	});

	test('an SCTE-35 Signal survives verbatim, including its foreign namespace', () => {
		const out = serializeMpd(parseMpd(EVERY_ELEMENT));

		expect(out).toContain('<Signal xmlns="http://www.scte.org/schemas/35/2016">');
		expect(out).toContain('<Binary>AAA=</Binary>');
		expect(out).toContain('schemeIdUri="urn:scte:scte35:2014:xml+bin"');
	});

	test('a second pass changes nothing', () => {
		const once = serializeMpd(parseMpd(EVERY_ELEMENT));

		expect(serializeMpd(parseMpd(once))).toBe(once);
	});

	test('a dateTime stating microseconds round-trips at full precision', () => {
		// Date.parse stops at milliseconds, so this used to come back truncated to ...015Z.
		const source = (publishTime: string) =>
			`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minBufferTime="PT2S" `
			+ `publishTime="${publishTime}"><Period id="0"/></MPD>`;
		const publishTimeIn = (xml: string) => /publishTime="([^"]+)"/.exec(xml)?.[1];

		expect(publishTimeIn(serializeMpd(parseMpd(source('2026-10-15T22:54:01.015781Z')))))
			.toBe('2026-10-15T22:54:01.015781Z');
		expect(publishTimeIn(serializeMpd(parseMpd(source('2026-10-15T22:54:01.015Z')))))
			.toBe('2026-10-15T22:54:01.015Z');
	});
});

describe('Content steering', () => {
	// Steering is only usable when both halves survive: the element names the steering server, and
	// `@serviceLocation` on each BaseURL is what a returned pathway is matched against.
	const steeringMpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <BaseURL serviceLocation="cdn-a">https://a.example.com/</BaseURL>
  <BaseURL serviceLocation="cdn-b">https://b.example.com/</BaseURL>
  <ContentSteering defaultServiceLocation="cdn-a" queryBeforeStart="true" proxyServerURL="https://proxy.example.com/">https://steer.example.com/manifest</ContentSteering>
  <Period id="0"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v0" bandwidth="100000"/></AdaptationSet></Period>
</MPD>`;

	test('a steering element and its service locations survive a parse', () => {
		const mpd = parse(steeringMpd);

		expect(mpd.contentSteering).not.toBeNull();
		expect(mpd.contentSteering!.value).toBe('https://steer.example.com/manifest');
		expect(mpd.contentSteering!.defaultServiceLocation).toBe('cdn-a');
		expect(mpd.contentSteering!.queryBeforeStart).toBe(true);
		expect(mpd.contentSteering!.proxyServerURL).toBe('https://proxy.example.com/');

		expect(mpd.baseURLs).toEqual([
			{ value: 'https://a.example.com/', serviceLocation: 'cdn-a' },
			{ value: 'https://b.example.com/', serviceLocation: 'cdn-b' },
		]);
	});

	test('and survive a round trip back out', () => {
		const out = serializeMpd(parse(steeringMpd));

		expect(out).toContain('<ContentSteering');
		expect(out).toContain('https://steer.example.com/manifest');
		expect(out).toContain('defaultServiceLocation="cdn-a"');
		expect(out).toContain('queryBeforeStart="true"');
		expect(out).toContain('serviceLocation="cdn-a"');
		expect(out).toContain('serviceLocation="cdn-b"');

		const reparsed = parse(out);
		expect(reparsed.contentSteering).toEqual(parse(steeringMpd).contentSteering);
		expect(reparsed.baseURLs).toEqual(parse(steeringMpd).baseURLs);
	});

	test('factories build a steered MPD that serializes and parses back', () => {
		const built = mpd({
			type: 'static',
			// Steering is the subject here; borrow a period that already parses.
			periods: parse(steeringMpd).periods,
			contentSteering: mpdContentSteering({
				value: 'https://steer.example.com/manifest',
				defaultServiceLocation: 'cdn-a',
				queryBeforeStart: true,
			}),
		});
		built.baseURLs = [
			mpdBaseURL({ value: 'https://a.example.com/', serviceLocation: 'cdn-a' }),
			mpdBaseURL({ value: 'https://b.example.com/' }),
		];

		const reparsed = parse(serializeMpd(built));
		expect(reparsed.contentSteering).toEqual(built.contentSteering);
		expect(reparsed.baseURLs).toEqual(built.baseURLs);
		// An omitted serviceLocation must not appear as an empty attribute
		expect(serializeMpd(built)).not.toContain('serviceLocation=""');
	});

	test('rewriting the URLs keeps each serviceLocation attached to its own URL', () => {
		// A parallel list of plain strings went stale here: rebaseManifest rewrote the strings, the
		// attributes kept the originals, and the serializer emitted the un-rebased URL.
		const parsed = parse(steeringMpd);
		parsed.baseURLs = [
			{ value: 'media-a/', serviceLocation: 'cdn-a' },
			{ value: 'media-b/', serviceLocation: 'cdn-b' },
		];
		const rebased = rebaseManifest('https://edge.example.net/vod/')({ format: 'dash', mpd: parsed });
		assert(rebased.format === 'dash');

		expect(rebased.mpd.baseURLs).toEqual([
			{ value: 'https://edge.example.net/vod/media-a/', serviceLocation: 'cdn-a' },
			{ value: 'https://edge.example.net/vod/media-b/', serviceLocation: 'cdn-b' },
		]);
		const out = serializeMpd(rebased.mpd);
		expect(out).toContain('serviceLocation="cdn-a">https://edge.example.net/vod/media-a/<');
	});

	test('an MPD without steering emits no element and no stray attribute', () => {
		const mpd = parse(steeringMpd);
		mpd.contentSteering = null;
		mpd.baseURLs = mpd.baseURLs.map(x => ({ ...x, serviceLocation: null }));

		const out = serializeMpd(mpd);
		expect(out).not.toContain('ContentSteering');
		expect(out).not.toContain('serviceLocation');
		expect(parse(out).contentSteering).toBeNull();
	});
});

describe('Thumbnail tiles', () => {
	const tiledMpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="0">
    <AdaptationSet id="3" contentType="image" mimeType="image/jpeg">
      <SegmentTemplate media="$RepresentationID$/tile_$Number$.jpg" duration="60" startNumber="1"/>
      <Representation id="thumbs" bandwidth="16460" width="1600" height="360">
        <EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="5x2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

	const representationOf = (xml: string) => parse(xml).periods[0]!.adaptationSets[0]!.representations[0]!;

	test('a tile grid is read off an image representation', () => {
		const set = parse(tiledMpd).periods[0]!.adaptationSets[0]!;
		expect(set.contentType).toBe('image');
		expect(readMpdThumbnailTile(representationOf(tiledMpd).essentialProperties)).toEqual({ columns: 5, rows: 2 });
	});

	test('the scheme spelling without /guidelines/ is accepted too', () => {
		const legacy = tiledMpd.replace('dashif.org/guidelines/thumbnail_tile', 'dashif.org/thumbnail_tile');
		expect(readMpdThumbnailTile(representationOf(legacy).essentialProperties)).toEqual({ columns: 5, rows: 2 });
	});

	test('the grid survives a round trip and is written in the canonical spelling', () => {
		const out = serializeMpd(parse(tiledMpd));
		expect(out).toContain('contentType="image"');
		expect(out).toContain('http://dashif.org/guidelines/thumbnail_tile');
		expect(out).toContain('value="5x2"');
		expect(readMpdThumbnailTile(representationOf(out).essentialProperties)).toEqual({ columns: 5, rows: 2 });
	});

	test('the factory produces a descriptor the reader understands, and junk reads as absent', () => {
		expect(readMpdThumbnailTile([mpdThumbnailTile({ columns: 10, rows: 1 })])).toEqual({ columns: 10, rows: 1 });
		expect(readMpdThumbnailTile([])).toBeNull();
		expect(readMpdThumbnailTile([
			{ schemeIdUri: 'http://dashif.org/guidelines/thumbnail_tile', value: '0x5', id: null },
			{ schemeIdUri: 'http://example.com/other', value: '5x2', id: null },
		])).toBeNull();
	});
});
