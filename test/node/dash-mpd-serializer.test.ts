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
	id: 'v0',
	bandwidth: 1_200_000,
	width: 1920,
	height: 1080,
	frameRate: null,
	codecs: 'avc1.640028',
	mimeType: 'video/mp4',
	sar: null,
	audioSamplingRate: null,
	startWithSAP: null,
	labels: [],
	audioChannelConfigurations: [],
	supplementalProperties: [],
	essentialProperties: [],
	baseURLs: [],
	contentProtections: [],
	segmentTemplate: null,
	segmentList: null,
	segmentBase: null,
	...over,
});

const adaptationSet = (over: Partial<MpdAdaptationSet> = {}): MpdAdaptationSet => ({
	id: '0',
	group: null,
	contentType: 'video',
	mimeType: 'video/mp4',
	codecs: null,
	lang: null,
	maxWidth: null,
	maxHeight: null,
	width: null,
	height: null,
	audioSamplingRate: null,
	par: null,
	startWithSAP: null,
	subsegmentStartsWithSAP: null,
	segmentAlignment: null,
	subsegmentAlignment: null,
	frameRate: null,
	roles: [],
	labels: [],
	audioChannelConfigurations: [],
	supplementalProperties: [],
	essentialProperties: [],
	baseURLs: [],
	contentProtections: [],
	segmentTemplate: null,
	segmentList: null,
	representations: [representation()],
	...over,
});

const period = (over: Partial<MpdPeriod> = {}): MpdPeriod => ({
	id: null,
	start: null,
	duration: null,
	baseURLs: [],
	serviceDescriptions: [],
	adaptationSets: [adaptationSet()],
	...over,
});

const mpd = (over: Partial<Mpd> = {}): Mpd => ({
	type: 'static',
	profiles: ['urn:mpeg:dash:profile:isoff-live:2011'],
	mediaPresentationDuration: null,
	minimumUpdatePeriod: null,
	availabilityStartTime: null,
	publishTime: null,
	timeShiftBufferDepth: null,
	suggestedPresentationDelay: null,
	maxSegmentDuration: null,
	minBufferTime: null,
	baseURLs: [],
	schemaLocation: null,
	serviceDescriptions: [],
	utcTiming: [],
	periods: [period()],
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
			baseURLs: ['https://cdn.example.com/vod/?token=abc123&exp=99', 'already%20encoded/path/'],
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
				latency: { referenceId: 1, target: 3000, min: 2000, max: 6000 },
				playbackRate: { min: 0.96, max: 1.04 },
			}],
			utcTiming: [{ schemeIdUri: 'urn:mpeg:dash:utc:http-iso:2014', value: 'https://time.akamai.com/?iso' }],
		});
		const period = first.periods[0]!;
		expect(period.serviceDescriptions).toEqual([
			{ id: 0, latency: { referenceId: null, target: 3000, min: null, max: null }, playbackRate: null },
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
	expect(mpd.baseURLs).toEqual(['https://media.example/a?b=1&c=<2>']);
	expect(mpd.periods[0]!.adaptationSets[0]!.representations[0]!.id).toBe('r&BC');

	expect(() => parse('<MPD><Period></MPD>')).toThrow('MPD parse error');
	expect(() => parse('<MPD type=static></MPD>')).toThrow('MPD parse error');
	expect(() => parse('<MPD>&nbsp;</MPD>')).toThrow('MPD parse error');
});
