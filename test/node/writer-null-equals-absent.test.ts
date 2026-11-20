/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `null` means absent on every optional field of the writer factories. The type fixture proves the
// types admit it and the constructor test proves nothing throws, but neither proves the stronger
// thing a caller relies on: that passing null produces the SAME result as leaving the field out. A
// validator or a factory can accept null and then act on it - `X === undefined ? null : {...X}`
// builds an object out of the null, and `X !== undefined` reads it as "the caller asked for this".
//
// So this compares the two outputs field by field. The field list comes from the built declarations,
// so a field added later is covered without anyone updating a list here.

import { expect, test } from 'vitest';
import * as mb from '../../src/index.js';
import { optionalFieldsOfFactory } from './_nullable-fields.js';

/** The arguments each factory requires, so the optional fields can be varied around them. */
const REQUIRED: Record<string, Record<string, unknown>> = {
	hlsVariant: { uri: 'v.m3u8', bandwidth: 1e6 },
	hlsMediaRendition: { type: 'AUDIO', groupId: 'a', name: 'en' },
	hlsSegment: { uri: 's.m4s', duration: 2 },
	hlsPart: { uri: 'p.m4s', duration: 0.5 },
	hlsMasterPlaylist: { variants: [] },
	hlsMediaPlaylist: { segments: [], targetDuration: 2 },
	hlsKey: { method: 'AES-128' },
	hlsMap: { uri: 'init.mp4' },
	hlsStart: { timeOffset: 1 },
	hlsSessionData: { dataId: 'com.example.id' },
	hlsContentSteering: { serverUri: 'https://a/steer' },
	hlsSkip: { skippedSegments: 3 },
	hlsRenditionReport: { uri: 'r.m3u8' },
	hlsPreloadHint: { type: 'PART', uri: 'p.m4s' },
	hlsDateRange: { id: 'd1', startDate: '2026-01-01T00:00:00.000Z' },
	hlsIFrameStream: { uri: 'i.m3u8', bandwidth: 1e6 },
	hlsImageStream: { uri: 'img.m3u8', bandwidth: 1e5 },
	hlsTiles: { resolution: { width: 320, height: 180 }, layout: { columns: 5, rows: 5 }, duration: 2 },
	mpdSegmentList: { segments: ['s1.m4s'] },
	mpdSegmentTemplate: {},
	mpdRepresentation: { id: 'r', bandwidth: 1e6 },
	mpdAdaptationSet: { representations: [] },
	mpdPeriod: { adaptationSets: [] },
	mpd: { type: 'static', periods: [] },
	mpdServiceDescription: {},
	mpdBaseURL: { value: 'https://a/' },
	mpdContentSteering: { value: 'https://a/steer' },
};

const factories = mb as unknown as Record<string, (options: Record<string, unknown>) => unknown>;

for (const [name, required] of Object.entries(REQUIRED)) {
	test(`${name}: null is the same as absent on every optional field`, () => {
		// hlsTiles has no optional fields at all, so an empty list is a fact about it, not a
		// failure to read the declarations.
		const fields = optionalFieldsOfFactory(name);

		const absent = factories[name]!({ ...required });

		const differing: string[] = [];
		for (const field of fields) {
			let withNull: unknown;
			try {
				withNull = factories[name]!({ ...required, [field]: null });
			} catch {
				differing.push(`${field} (threw)`);
				continue;
			}

			// One field at a time, so a failure names the field rather than the factory.
			try {
				expect(withNull).toEqual(absent);
			} catch {
				differing.push(field);
			}
		}

		expect(differing, `${name}: fields where null differs from leaving it out`).toEqual([]);
	});
}
