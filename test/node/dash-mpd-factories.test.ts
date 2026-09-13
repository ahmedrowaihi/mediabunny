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
