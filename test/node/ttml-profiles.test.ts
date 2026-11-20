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
import {
	buildTtmlDocument,
	EBUTTM_NAMESPACE,
	EBUTTS_NAMESPACE,
	TTML_NAMESPACE,
	ttmlDocumentOf,
} from '../../src/subtitles.js';
import { SubtitleCueSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { CmafOutputFormat } from '../../src/output-format.js';

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
		.toThrow('imsc1, ebu-tt-d, smpte-tt');
	// The default stays IMSC1
	expect(new SubtitleCueSource('ttml')._ttmlProfile).toBe('imsc1');
	expect(new SubtitleCueSource('ttml', { ttmlProfile: 'ebu-tt-d' })._ttmlProfile).toBe('ebu-tt-d');
});

// Signalling: what the init and the document say about which profile this is. Before these, the two
// profiles produced byte-identical inits, so a receiver had nothing to read.

test('an IMSC1 document names its profile, and EBU-TT-D says what it is its own way', () => {
	const imsc1 = buildTtmlDocument({ cues: CUES, language: 'en' });
	expect(imsc1).toContain('ttp:contentProfiles="http://www.w3.org/ns/ttml/profile/imsc1/text"');

	// EBU-TT-D states conformance through ebuttm, so contentProfiles would be a second, redundant claim
	const ebu = buildTtmlDocument({ cues: CUES, language: 'en', profile: 'ebu-tt-d' });
	expect(ebu).not.toContain('ttp:contentProfiles');
	expect(ebu).toContain('ebuttm:conformsToStandard');
});

test('the stpp entry lists every namespace the documents use, which is what names the profile', async () => {
	const write = async (profile: 'imsc1' | 'ebu-tt-d') => {
		const initTarget = new BufferTarget();
		const output = new Output({
			format: new CmafOutputFormat(),
			target: new BufferTarget(),
			initTarget,
		});
		const source = new SubtitleCueSource('ttml', { ttmlProfile: profile });
		output.addSubtitleTrack(source, { languageCode: 'eng' });
		await output.start();
		for (const cue of CUES) {
			await source.add(cue);
		}
		await output.finalize();

		const decode = (buffer: ArrayBuffer | null) =>
			new TextDecoder('latin1').decode(new Uint8Array(buffer ?? new ArrayBuffer(0)));
		// Kept apart: the init carries the sample entry and the ftyp, the segments carry the styp, and
		// a brand on only one of them would satisfy a test that ran them together
		return { init: decode(initTarget.buffer), segments: decode(output.target.buffer) };
	};

	const imsc1 = await write('imsc1');
	const ebu = await write('ebu-tt-d');

	// 14496-30 section 7.2: a space-separated list, not just the document element's namespace
	expect(imsc1.init).toContain(TTML_NAMESPACE);
	expect(imsc1.init).not.toContain(EBUTTS_NAMESPACE);
	expect(ebu.init).toContain(`${TTML_NAMESPACE} ${EBUTTS_NAMESPACE} ${EBUTTM_NAMESPACE}`);

	// The whole point: the two inits are no longer the same bytes
	expect(imsc1.init).not.toBe(ebu.init);

	// And CMAF brands an IMSC1 text track im1t - on the ftyp in the init AND the styp on every
	// segment, since a receiver handed one segment has only that to read
	expect(imsc1.init, 'ftyp').toContain('im1t');
	expect(imsc1.segments, 'styp').toContain('im1t');
	expect(ebu.init).not.toContain('im1t');
	expect(ebu.segments).not.toContain('im1t');
});

test('ttmlDocumentOf writes the same document without an Output', () => {
	// Caption delivery is often a sidecar file rather than a muxed track
	const viaHelper = ttmlDocumentOf({ cues: CUES, language: 'en', profile: 'ebu-tt-d' });
	expect(viaHelper).toBe(buildTtmlDocument({ cues: CUES, language: 'en', profile: 'ebu-tt-d' }));
	expect(ttmlDocumentOf({ cues: CUES, language: 'en' })).toContain('ttp:contentProfiles');

	expect(() => ttmlDocumentOf({ cues: CUES, language: '' })).toThrow(TypeError);
	expect(() => ttmlDocumentOf({ cues: CUES, language: 'en', profile: 'imsc2' as 'imsc1' })).toThrow(TypeError);
});
