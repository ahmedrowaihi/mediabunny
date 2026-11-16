/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// EBU Tech 3380 v1.0.1, section numbers as cited. The IMSC1 output already meets what it marks
// #REQUIRED, so the profile adds signalling and box styling rather than a different document.

import { expect, test } from 'vitest';
import { buildTtmlDocument } from '../../src/subtitles.js';
import { SubtitleCueSource } from '../../src/media-source.js';

const CUES = [
	{ timestamp: 1, duration: 2, text: 'Hildy!', identifier: undefined, settings: undefined, notes: undefined },
	{
		timestamp: 3.5, duration: 1.25, text: 'Two\nlines',
		identifier: undefined, settings: undefined, notes: undefined,
	},
];

const build = (profile?: 'imsc1' | 'ebu-tt-d') =>
	buildTtmlDocument({ cues: CUES, language: 'eng', profile });

test('both profiles satisfy what Tech 3380 marks as required', () => {
	for (const xml of [build(), build('imsc1'), build('ebu-tt-d')]) {
		// #REQUIRED on tt:tt, Annex B
		expect(xml).toContain('ttp:timeBase="media"');
		expect(xml).toContain('xml:lang="eng"');
		// tt:head shall contain one tt:styling and one tt:layout
		expect(xml).toContain('<styling>');
		expect(xml).toContain('<layout>');
		// #REQUIRED on tt:region
		expect(xml).toMatch(/<region xml:id="[^"]+"[^>]*tts:origin="[^"]+"[^>]*tts:extent="[^"]+"/);
		// #REQUIRED on tt:style
		expect(xml).toMatch(/<style xml:id="[^"]+"/);

		// §4.12 ebuttdt:distributionMediaTimingType
		for (const time of xml.matchAll(/(?:begin|end)="([^"]+)"/g)) {
			expect(time[1]).toMatch(/^\d{2,}:[0-5]\d:[0-5]\d\.\d{1,3}$/);
		}

		// Annex B does not list tts:extent on tt:tt
		expect(/<tt\b[^>]*tts:extent/.test(xml)).toBe(false);
	}
});

test('only the EBU-TT-D profile signals conformance and styles for a box', () => {
	const imsc1 = build('imsc1');
	const ebu = build('ebu-tt-d');

	// §2.9
	expect(ebu).toContain('<ebuttm:conformsToStandard>urn:ebu:tt:distribution:2018-04</ebuttm:conformsToStandard>');
	expect(ebu).toContain('xmlns:ebuttm="urn:ebu:tt:metadata"');
	// §2.6
	expect(ebu).toContain('xmlns:ebutts="urn:ebu:tt:style"');
	expect(ebu).toContain('ebutts:linePadding="0.5c"');
	expect(ebu).toContain('tts:backgroundColor="black"');
	expect(ebu).toContain('tts:lineHeight="125%"');

	// None of it leaks into the default profile
	for (const marker of [
		'ebuttm:conformsToStandard', 'urn:ebu:tt:style', 'urn:ebu:tt:metadata',
		'ebutts:linePadding', 'tts:backgroundColor',
	]) {
		expect(imsc1, `IMSC1 should not carry ${marker}`).not.toContain(marker);
	}

	// The cues themselves are untouched by the profile
	const cuesOf = (xml: string) => xml.match(/<p[^>]*>.*?<\/p>/gs);
	expect(cuesOf(ebu)).toEqual(cuesOf(imsc1));
});

test('the profile is refused where it cannot apply, rather than ignored', () => {
	expect(() => new SubtitleCueSource('webvtt', { ttmlProfile: 'ebu-tt-d' }))
		.toThrow('only applies to the \'ttml\' codec');
	expect(() => new SubtitleCueSource('ttml', { ttmlProfile: 'ebu-ttd' as unknown as 'ebu-tt-d' }))
		.toThrow('\'imsc1\' or \'ebu-tt-d\'');
	// The default stays IMSC1
	expect(new SubtitleCueSource('ttml')._ttmlProfile).toBe('imsc1');
	expect(new SubtitleCueSource('ttml', { ttmlProfile: 'ebu-tt-d' })._ttmlProfile).toBe('ebu-tt-d');
});
