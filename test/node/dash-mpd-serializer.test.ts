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
});
