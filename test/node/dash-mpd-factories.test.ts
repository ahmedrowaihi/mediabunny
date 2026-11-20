/*!
 * Tests for the MPD AST factories in `src/dash/dash-mpd-factories.ts` — the construction counterpart
 * to `parseMpd`. Build → serialize → parse should round-trip the fields.
 */
import { describe, expect, test } from 'vitest';
import {
	mpd,
	mpdAdaptationSet,
	mpdBaseURL,
	mpdPeriod,
	mpdRepresentation,
	mpdSegmentBase,
	mpdSegmentList,
	mpdSegmentTemplate,
	mpdSegmentUrl,
	parseMpd,
	serializeManifest,
	serializeMpd,
	type SegmentList,
} from '../../src/index.js';

describe('mpd factories', () => {
	test('segment list carries init + media URIs', () => {
		const list = mpdSegmentList({
			initializationUri: 'v/init.mp4',
			duration: 4,
			timescale: 1,
			segments: ['v/1.m4s', 'v/2.m4s'],
		});
		expect(list.initialization).toEqual({ sourceURL: 'v/init.mp4', range: null });
		expect(list.segments.map(s => s.media)).toEqual(['v/1.m4s', 'v/2.m4s']);
	});

	test('representation fills the boilerplate', () => {
		const r = mpdRepresentation({
			id: 'v0', bandwidth: 6_000_000, codecs: 'avc1.640028', width: 1920, height: 1080,
		});
		expect(r).toMatchObject({
			id: 'v0', bandwidth: 6_000_000, width: 1920, height: 1080,
			segmentTemplate: null, contentProtections: [], baseURLs: [],
		});
	});

	test('a live MPD serializes with the expected structure', () => {
		const built = mpd({
			type: 'dynamic',
			minimumUpdatePeriod: 2,
			minBufferTime: 2,
			periods: [mpdPeriod({
				id: '0',
				adaptationSets: [mpdAdaptationSet({
					contentType: 'video',
					mimeType: 'video/mp4',
					representations: [mpdRepresentation({
						id: 'v0',
						bandwidth: 6_000_000,
						codecs: 'avc1.640028',
						width: 1920,
						height: 1080,
						segmentList: mpdSegmentList({
							initializationUri: 'v/init.mp4', duration: 4, segments: ['v/1.m4s', 'v/2.m4s'],
						}),
					})],
				})],
			})],
		});
		// serializeManifest → serializeMpd builds the XML (no DOMParser needed on the write side).
		const xml = serializeManifest({ format: 'dash', mpd: built });
		expect(xml).toContain('type="dynamic"');
		expect(xml).toContain('<Representation');
		expect(xml).toContain('id="v0"');
		expect(xml).toContain('bandwidth="6000000"');
		expect(xml).toContain('width="1920"');
		expect(xml).toContain('<Initialization sourceURL="v/init.mp4"');
		expect(xml).toContain('<SegmentURL media="v/1.m4s"');
		expect(xml).toContain('<SegmentURL media="v/2.m4s"');
	});
});

describe('mpdSegmentTemplate', () => {
	test('defaults the schema-stated fields and leaves the rest absent', () => {
		const template = mpdSegmentTemplate({ media: '$Number$.m4s' });

		expect(template.timescale).toBe(1);
		expect(template.startNumber).toBe(1);
		expect(template.presentationTimeOffset).toBe(0);
		expect(template.availabilityTimeComplete).toBe(true);
		expect(template.eptDelta).toBeNull();
		expect(template.indexRangeExact).toBeNull();
	});

	test('every field the AST carries is settable', () => {
		const template = mpdSegmentTemplate({
			media: 'm', initialization: 'i', bitstreamSwitching: 'b', duration: 4, timescale: 1000,
			startNumber: 7, endNumber: 9, presentationTimeOffset: 12, availabilityTimeOffset: 1.5,
			availabilityTimeComplete: false, timeline: [], index: 'x', indexRange: '0-9',
			indexRangeExact: true, presentationDuration: 60, timeShiftBufferDepth: 30,
			eptDelta: -2, pdDelta: 3,
		});

		expect(Object.values(template).every(value => value !== undefined)).toBe(true);
		expect(template.endNumber).toBe(9);
		expect(template.pdDelta).toBe(3);
	});
});

test('scte214 supplemental codecs and profiles survive the factory, the serializer and the parser', () => {
	const built = mpd({
		type: 'static',
		periods: [mpdPeriod({
			id: 'P0',
			adaptationSets: [mpdAdaptationSet({
				contentType: 'video',
				supplementalCodecs: 'dvh1.08.02',
				supplementalProfiles: 'db1p',
				representations: [mpdRepresentation({
					id: 'v0',
					bandwidth: 1_000_000,
					codecs: 'hvc1.2.4.L93.90',
					supplementalCodecs: 'dvh1.08.02',
					supplementalProfiles: 'db1p',
				})],
			})],
		})],
	});

	const xml = serializeManifest({ format: 'dash', mpd: built });
	expect(xml).toContain('xmlns:scte214="urn:scte:dash:scte214-extensions"');
	expect(xml).toContain('scte214:supplementalCodecs="dvh1.08.02"');
	expect(xml).toContain('scte214:supplementalProfiles="db1p"');

	const set = parseMpd(xml).periods[0]!.adaptationSets[0]!;
	expect(set.supplementalCodecs).toBe('dvh1.08.02');
	expect(set.supplementalProfiles).toBe('db1p');
	expect(set.representations[0]!.supplementalCodecs).toBe('dvh1.08.02');
	expect(set.representations[0]!.supplementalProfiles).toBe('db1p');
});

test('an MPD stating neither is written without the scte214 namespace', () => {
	const xml = serializeManifest({ format: 'dash', mpd: mpd({
		type: 'static',
		periods: [mpdPeriod({
			id: 'P0',
			adaptationSets: [mpdAdaptationSet({
				contentType: 'video',
				representations: [mpdRepresentation({ id: 'v0', bandwidth: 1_000_000, codecs: 'hvc1.2.4.L93.90' })],
			})],
		})],
	}) });

	expect(xml).not.toContain('scte214');
});

// The reference MPD below is GPAC's, not ours: `MP4Box -dash 2000 -profile onDemand -out ondemand.mpd
// src.mp4` on a 4 s H.264 file. It is inline rather than a fixture because MP4Box is not installed in
// CI, and it is the oracle for what an on-demand `<SegmentBase>` manifest actually carries — reading
// our own output back cannot tell us we dropped an attribute nobody thought to assert on.
// Kept exactly as GPAC emitted it, attribute order and all, so it stays a reference rather than our
// reformatting of one.
/* eslint-disable @stylistic/max-len */
const GPAC_ON_DEMAND_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.500S" type="static" mediaPresentationDuration="PT0H0M4.000S" maxSubsegmentDuration="PT0H0M2.000S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
 <Period duration="PT0H0M4.000S">
  <AdaptationSet segmentAlignment="true" maxWidth="320" maxHeight="240" maxFrameRate="25" par="4:3" mimeType="video/mp4" startWithSAP="1" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
   <Representation id="1" codecs="avc1.64000D" width="320" height="240" frameRate="25" sar="1:1" bandwidth="56944">
    <BaseURL>src_dashinit.mp4</BaseURL>
    <SegmentBase indexRangeExact="true" indexRange="941-996">
     <Initialization range="0-900"/>
    </SegmentBase>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;
/* eslint-enable @stylistic/max-len */

describe('SegmentBase and the on-demand profile', () => {
	test('every attribute the GPAC on-demand MPD states survives a parse and reserialize', () => {
		const parsed = parseMpd(GPAC_ON_DEMAND_MPD);
		const base = parsed.periods[0]!.adaptationSets[0]!.representations[0]!.segmentBase;

		expect(base).toMatchObject({
			indexRange: { start: 941, end: 996 },
			indexRangeExact: true,
			initialization: { sourceURL: null, range: { start: 0, end: 900 } },
		});
		expect(parsed.maxSubsegmentDuration).toBe(2);

		const reserialized = serializeMpd(parsed);
		expect(reserialized).toContain('indexRangeExact="true"');
		expect(reserialized).toContain('indexRange="941-996"');
		expect(reserialized).toContain('maxSubsegmentDuration="PT2S"');
		expect(reserialized).toContain('<Initialization range="0-900"/>');
		// A second pass must change nothing, or one of the two directions is lossy.
		expect(serializeMpd(parseMpd(reserialized))).toBe(reserialized);
	});

	test('mpdSegmentBase builds what GPAC wrote, from the same values', () => {
		const built = mpdSegmentBase({
			indexRange: '941-996',
			indexRangeExact: true,
			initializationRange: { start: 0, end: 900 },
		});
		const reference = parseMpd(GPAC_ON_DEMAND_MPD)
			.periods[0]!.adaptationSets[0]!.representations[0]!.segmentBase;

		expect(built).toEqual(reference);
	});

	test('a range states the same thing as a string or as a pair', () => {
		expect(mpdSegmentBase({ indexRange: '941-996' }).indexRange).toEqual({ start: 941, end: 996 });
		expect(mpdSegmentBase({ indexRange: { start: 941, end: 996 } }).indexRange)
			.toEqual({ start: 941, end: 996 });
	});

	test('a malformed range is refused rather than silently dropped', () => {
		expect(() => mpdSegmentBase({ indexRange: '941..996' })).toThrow(/not a byte range/);
		expect(() => mpdSegmentUrl({ media: 's.m4s', mediaRange: 'nonsense' })).toThrow(/not a byte range/);
	});

	test('an Initialization with only a range is still written', () => {
		// GPAC's on-demand init states no sourceURL, so neither field alone may decide the element.
		expect(mpdSegmentBase({ initializationRange: '0-900' }).initialization)
			.toEqual({ sourceURL: null, range: { start: 0, end: 900 } });
		expect(mpdSegmentBase({ initializationUri: 'init.mp4' }).initialization)
			.toEqual({ sourceURL: 'init.mp4', range: null });
		expect(mpdSegmentBase({}).initialization).toBe(null);
	});
});

describe('SegmentURL entries', () => {
	test('a plain string and mpdSegmentUrl state the same segment', () => {
		expect(mpdSegmentList({ segments: ['v/1.m4s'] }).segments)
			.toEqual(mpdSegmentList({ segments: [mpdSegmentUrl({ media: 'v/1.m4s' })] }).segments);
	});

	test('an entry carries its ranges into the serialized SegmentURL', () => {
		const xml = serializeMpd(mpd({
			type: 'static',
			periods: [mpdPeriod({
				id: 'P0',
				adaptationSets: [mpdAdaptationSet({
					contentType: 'video',
					representations: [mpdRepresentation({
						id: 'v0',
						bandwidth: 1_000_000,
						codecs: 'avc1.640028',
						segmentList: mpdSegmentList({
							segments: [mpdSegmentUrl({
								media: 'v/all.mp4',
								mediaRange: '1000-1999',
								index: 'v/all.idx',
								indexRange: { start: 0, end: 99 },
							})],
						}),
					})],
				})],
			})],
		}));

		expect(xml).toContain('mediaRange="1000-1999"');
		expect(xml).toContain('index="v/all.idx"');
		expect(xml).toContain('indexRange="0-99"');
	});
});

describe('MPD-level attributes the factory used to hardcode', () => {
	const build = (options: Parameters<typeof mpd>[0]) => mpd(options);
	const minimal = {
		type: 'static' as const,
		periods: [mpdPeriod({
			id: 'P0',
			adaptationSets: [mpdAdaptationSet({
				contentType: 'video',
				representations: [mpdRepresentation({ id: 'v0', bandwidth: 1_000_000, codecs: 'avc1.640028' })],
			})],
		})],
	};

	test('id, publishTime, baseURLs, utcTiming and schemaLocation reach the MPD', () => {
		const built = build({
			...minimal,
			id: 'mpd-7',
			publishTime: Date.UTC(2026, 10, 27, 12, 0, 0),
			baseURLs: ['https://cdn.example/', mpdBaseURL({ value: 'https://b.example/', serviceLocation: 'b' })],
			utcTiming: [{ schemeIdUri: 'urn:mpeg:dash:utc:http-iso:2014', value: 'https://time.example/' }],
			maxSegmentDuration: 6,
			schemaLocation: 'urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd',
		});

		expect(built).toMatchObject({ id: 'mpd-7', maxSegmentDuration: 6 });
		expect(built.baseURLs.map(b => b.value)).toEqual(['https://cdn.example/', 'https://b.example/']);
		expect(built.baseURLs[1]!.serviceLocation).toBe('b');

		const xml = serializeMpd(built);
		expect(xml).toContain('id="mpd-7"');
		expect(xml).toContain('publishTime="2026-11-27T12:00:00.000Z"');
		expect(xml).toContain('maxSegmentDuration="PT6S"');
		expect(xml).toContain('xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"');
		expect(xml).toContain('<UTCTiming');

		// The attributes have to come back, or the MPD cannot be read, edited and rewritten.
		const reparsed = parseMpd(xml);
		expect(reparsed.id).toBe('mpd-7');
		expect(reparsed.publishTime).toBe(Date.UTC(2026, 10, 27, 12, 0, 0));
		expect(reparsed.utcTiming).toEqual(built.utcTiming);
		expect(reparsed.baseURLs.map(b => b.value)).toEqual(built.baseURLs.map(b => b.value));
	});

	test('each new option stated as null is read as absent', () => {
		const omitted = serializeMpd(build(minimal));
		const nulled = serializeMpd(build({
			...minimal,
			id: null, publishTime: null, baseURLs: null, utcTiming: null,
			maxSegmentDuration: null, maxSubsegmentDuration: null, schemaLocation: null,
		}));

		expect(nulled).toBe(omitted);
		// `<Period>` and `<Representation>` carry an `id` of their own, so this names the MPD element.
		expect(/<MPD[^>]*\sid=/.test(omitted)).toBe(false);
	});
});

describe('SegmentList initialization', () => {
	test('a range with no sourceURL is written, matching mpdSegmentBase', () => {
		// A single-resource SegmentList states `<Initialization range=…>` and no sourceURL, so neither
		// field alone may decide whether the element exists.
		expect(mpdSegmentList({ segments: ['s.mp4'], initializationRange: '0-900' }).initialization)
			.toEqual({ sourceURL: null, range: { start: 0, end: 900 } });
		expect(mpdSegmentList({ segments: ['s.mp4'], initializationRange: { start: 0, end: 900 } }).initialization)
			.toEqual(mpdSegmentBase({ initializationRange: '0-900' }).initialization);
		expect(mpdSegmentList({ segments: ['s.mp4'], initializationUri: 'i.mp4' }).initialization)
			.toEqual({ sourceURL: 'i.mp4', range: null });
		expect(mpdSegmentList({ segments: ['s.mp4'] }).initialization).toBe(null);
	});

	test('both states reach the serialized Initialization', () => {
		const xml = (list: SegmentList) => serializeMpd(mpd({
			type: 'static',
			periods: [mpdPeriod({
				id: 'P0',
				adaptationSets: [mpdAdaptationSet({
					contentType: 'video',
					representations: [mpdRepresentation({
						id: 'v0', bandwidth: 1_000_000, codecs: 'avc1.640028', segmentList: list,
					})],
				})],
			})],
		}));

		expect(xml(mpdSegmentList({ segments: ['s.mp4'], initializationRange: '0-900' })))
			.toContain('<Initialization range="0-900"/>');
		expect(xml(mpdSegmentList({
			segments: ['s.mp4'], initializationUri: 'i.mp4', initializationRange: '0-900',
		}))).toContain('sourceURL="i.mp4"');
	});

	test('a malformed range is refused here too', () => {
		expect(() => mpdSegmentList({ segments: ['s.mp4'], initializationRange: '0..900' }))
			.toThrow(/not a byte range/);
	});

	test('a null initializationRange is read as absent', () => {
		expect(mpdSegmentList({ segments: ['s.mp4'], initializationRange: null }))
			.toEqual(mpdSegmentList({ segments: ['s.mp4'] }));
	});
});
