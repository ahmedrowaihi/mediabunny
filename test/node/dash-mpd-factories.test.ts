/*!
 * Tests for the MPD AST factories in `src/dash/dash-mpd-factories.ts` — the construction counterpart
 * to `parseMpd`. Build → serialize → parse should round-trip the fields.
 */
import { describe, expect, test } from 'vitest';
import {
	mpd,
	mpdAdaptationSet,
	mpdPeriod,
	mpdRepresentation,
	mpdSegmentList,
	mpdSegmentTemplate,
	parseMpd,
	serializeManifest,
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
