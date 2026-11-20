/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A cue used to be plain text with its WebVTT markup left in it, so every TTML document this library
// wrote escaped `<b>` into the text a viewer reads and put every paragraph in one bottom region. The
// cue now carries styled runs and a placement box, and the markup and cue settings a WebVTT file
// states are read into them.
//
// WebVTT states an ANCHOR rather than a box: `position` is where the given fraction of the line sits,
// and that fraction follows `align` unless `position` names its own. The expected origins below are
// that arithmetic, not a guess at what looks right.

import { expect, test } from 'vitest';
import {
	buildTtmlDocument,
	parseTtmlDocument,
	parseWebvttCueBody,
	parseWebvttSettings,
	SMPTE_TT_FULL_PROFILE,
	SMPTE_TT_NAMESPACE,
	SubtitleParser,
	ttmlDocumentOf,
	type SubtitleCue,
} from '../../src/subtitles.js';
import { SubtitleCueSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { CmafOutputFormat } from '../../src/output-format.js';

const cuesOf = (vtt: string) => {
	const cues: SubtitleCue[] = [];
	new SubtitleParser({ codec: 'webvtt', output: cue => void cues.push(cue) }).parse(vtt);
	return cues;
};

test('WebVTT markup becomes styled runs rather than literal text', () => {
	const runs = parseWebvttCueBody('plain <b>bold</b> and <i>italic</i> and <u>under</u>');

	expect(runs).toEqual([
		{ text: 'plain ' },
		{ text: 'bold', bold: true },
		{ text: ' and ' },
		{ text: 'italic', italic: true },
		{ text: ' and ' },
		{ text: 'under', underline: true },
	]);
});

test('nested markup carries both styles', () => {
	expect(parseWebvttCueBody('<b><i>both</i></b>')).toEqual([{ text: 'both', bold: true, italic: true }]);
});

test('a class names one of WebVTT\'s eight colours, and bg_ its background', () => {
	expect(parseWebvttCueBody('<c.yellow>warm</c>')).toEqual([{ text: 'warm', color: '#ffff00' }]);
	expect(parseWebvttCueBody('<c.bg_blue>cold</c>')).toEqual([{ text: 'cold', backgroundColor: '#0000ff' }]);
	// A class the spec does not name is a styling hook for a stylesheet, not a colour
	expect(parseWebvttCueBody('<c.speaker-1>who</c>')).toEqual([{ text: 'who' }]);
});

test('tags that carry no styling are dropped and their text kept as one run', () => {
	// A voice span, a language span and the karaoke timestamps. Keeping them as separate runs would
	// split one sentence into several spans that style nothing.
	expect(parseWebvttCueBody('<v Roy>one <00:00:01.000>two</v>')).toEqual([{ text: 'one two' }]);
	expect(parseWebvttCueBody('<lang en>text</lang>')).toEqual([{ text: 'text' }]);
});

test('a body with no markup produces no runs at all', () => {
	// Runs would say exactly what the text says, and every cue would carry a second copy of itself
	expect(parseWebvttCueBody('just words')).toBeNull();
});

test('cue settings become a placement box', () => {
	// align:start puts the anchor at the line's left edge, so the box starts at position
	expect(parseWebvttSettings('line:10% position:20% align:start')).toEqual({
		textAlign: 'start',
		origin: { x: 20, y: 10 },
		extent: { width: 80, height: 90 },
		displayAlign: 'before',
	});

	// align:center puts it at the middle, so a 40%-wide box starts 20% to the left of position
	expect(parseWebvttSettings('line:0% position:50% size:40% align:center')).toEqual({
		textAlign: 'center',
		origin: { x: 30, y: 0 },
		extent: { width: 40, height: 100 },
		displayAlign: 'before',
	});

	// position states its own anchor, which overrides what align would have said
	expect(parseWebvttSettings('position:50%,line-right size:40% align:start')?.origin).toEqual({ x: 10, y: 0 });
});

test('vertical text states a writing mode', () => {
	expect(parseWebvttSettings('vertical:rl')).toEqual({ writingMode: 'tbrl' });
	expect(parseWebvttSettings('vertical:lr')).toEqual({ writingMode: 'tblr' });
});

test('a line stated as a line number places nothing', () => {
	// How far down line 3 falls depends on the line height and the region, neither of which a cue
	// states, so a guess here would put the cue somewhere the author did not ask for
	expect(parseWebvttSettings('line:3')).toBeNull();
	expect(parseWebvttSettings('')).toBeNull();
});

test('a parsed WebVTT cue carries its runs and placement, and its text unchanged', () => {
	const cues = cuesOf(
		'WEBVTT\n\n'
		+ '1\n00:00:01.000 --> 00:00:03.000 line:10% position:20% align:start\n'
		+ 'a <b>bold</b> word\n',
	);

	expect(cues).toHaveLength(1);
	// Unchanged: a WebVTT writer puts this back verbatim, markup and all
	expect(cues[0]!.text).toBe('a <b>bold</b> word');
	expect(cues[0]!.runs).toEqual([{ text: 'a ' }, { text: 'bold', bold: true }, { text: ' word' }]);
	expect(cues[0]!.placement).toEqual({
		textAlign: 'start',
		origin: { x: 20, y: 10 },
		extent: { width: 80, height: 90 },
		displayAlign: 'before',
	});
});

test('the acceptance case: a placed, styled WebVTT cue becomes an IMSC1 p in its own region', () => {
	const cues = cuesOf(
		'WEBVTT\n\n'
		+ '00:00:01.000 --> 00:00:03.000 line:10% position:20% align:start\n'
		+ '<b>bold</b> and <i>italic</i>\n',
	);
	const xml = ttmlDocumentOf({ cues, language: 'eng' });

	expect(xml).toContain('<region xml:id="r1" tts:origin="20% 10%" tts:extent="80% 90%"'
		+ ' tts:displayAlign="before" tts:overflow="visible"/>');
	expect(xml).toContain('region="r1"');
	expect(xml).toContain('tts:textAlign="start"');
	expect(xml).toContain('<span tts:fontWeight="bold">bold</span>');
	expect(xml).toContain('<span tts:fontStyle="italic">italic</span>');
	// Nothing escaped: the markup became structure, not text a viewer reads
	expect(xml).not.toContain('&lt;b&gt;');
});

test('two cues placed the same way share one region', () => {
	const cues = cuesOf(
		'WEBVTT\n\n'
		+ '00:00:01.000 --> 00:00:02.000 line:10% position:20%\nfirst\n\n'
		+ '00:00:02.000 --> 00:00:03.000 line:10% position:20%\nsecond\n\n'
		+ '00:00:03.000 --> 00:00:04.000 line:80% position:20%\nthird\n',
	);
	const xml = ttmlDocumentOf({ cues, language: 'eng' });

	// r0 is the document's own default, then one per distinct box
	expect([...xml.matchAll(/<region /g)]).toHaveLength(3);
	expect([...xml.matchAll(/region="r1"/g)]).toHaveLength(2);
	expect(xml).toContain('region="r2"');
});

test('an unplaced cue names no region and sits in the default one', () => {
	const xml = ttmlDocumentOf({ cues: cuesOf('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nplain\n'), language: 'eng' });

	expect([...xml.matchAll(/<region /g)]).toHaveLength(1);
	expect(xml).toContain('<p begin="00:00:01.000" end="00:00:02.000">plain</p>');
});

test('a run that styles nothing is written as text, not as an empty span', () => {
	const xml = ttmlDocumentOf({
		cues: [{ timestamp: 0, duration: 1, text: 'a b', runs: [{ text: 'a ' }, { text: 'b', bold: true }] }],
		language: 'eng',
	});

	expect(xml).toContain('>a <span tts:fontWeight="bold">b</span></p>');
});

test('a line break inside a run is a br, and the text around it is escaped', () => {
	const xml = ttmlDocumentOf({
		cues: [{ timestamp: 0, duration: 1, text: '', runs: [{ text: 'a<x>\nb', italic: true }] }],
		language: 'eng',
	});

	expect(xml).toContain('<span tts:fontStyle="italic">a&lt;x&gt;<br/>b</span>');
});

test('writing mode and colours reach the document', () => {
	const xml = ttmlDocumentOf({
		cues: [{
			timestamp: 0,
			duration: 1,
			text: 'v',
			runs: [{ text: 'v', color: '#ffff00', backgroundColor: '#000000' }],
			placement: { writingMode: 'tbrl', displayAlign: 'center' },
		}],
		language: 'jpn',
	});

	expect(xml).toContain('tts:writingMode="tbrl"');
	expect(xml).toContain('tts:displayAlign="center"');
	expect(xml).toContain('tts:color="#ffff00"');
	expect(xml).toContain('tts:backgroundColor="#000000"');
});

test('the styling survives a round trip through our own reader', () => {
	// Our demuxer reads what our muxer writes, so a document that states styling the reader drops
	// would lose it on every remux through this library
	const cues = cuesOf(
		'WEBVTT\n\n'
		+ '00:00:01.000 --> 00:00:03.000 line:10% position:20% align:start\n'
		+ '<b>bold</b> and <i>italic</i>\n',
	);
	const read = parseTtmlDocument(ttmlDocumentOf({ cues, language: 'eng' }));

	expect(read).toHaveLength(1);
	expect(read[0]!.runs).toEqual([
		{ text: 'bold', bold: true },
		{ text: ' and ' },
		{ text: 'italic', italic: true },
	]);
	expect(read[0]!.placement).toEqual({
		origin: { x: 20, y: 10 },
		extent: { width: 80, height: 90 },
		displayAlign: 'before',
		textAlign: 'start',
	});
});

test('smpte-tt states its profile and namespace', () => {
	const xml = buildTtmlDocument({
		cues: [{ timestamp: 0, duration: 1, text: 'x' }],
		language: 'eng',
		profile: 'smpte-tt',
	});

	expect(xml).toContain(`xmlns:smpte="${SMPTE_TT_NAMESPACE}"`);
	expect(xml).toContain(`ttp:profile="${SMPTE_TT_FULL_PROFILE}"`);
	// It names itself through ttp:profile, so the IMSC content profile would be a second, different claim
	expect(xml).not.toContain('ttp:contentProfiles');
	expect(xml).not.toContain('ebuttm:conformsToStandard');
});

test('an smpte-tt track states both namespaces in its sample entry and is not branded im1t', async () => {
	const initTarget = new BufferTarget();
	const output = new Output({ format: new CmafOutputFormat(), target: new BufferTarget(), initTarget });
	const source = new SubtitleCueSource('ttml', { ttmlProfile: 'smpte-tt' });
	output.addSubtitleTrack(source, { languageCode: 'eng' });
	await output.start();
	await source.add({ timestamp: 0, duration: 1, text: 'x' });
	await output.finalize();

	// The sample entry and the ftyp are in the init, not in the segments
	const init = new TextDecoder('latin1').decode(new Uint8Array(initTarget.buffer!));

	// 14496-30 section 7.2: the field lists every namespace the documents use
	expect(init).toContain(`${'http://www.w3.org/ns/ttml'} ${SMPTE_TT_NAMESPACE}`);
	// im1t says IMSC1 text profile, which this is not
	expect(init).not.toContain('im1t');
});

test('an unknown profile is refused by name', () => {
	expect(() => ttmlDocumentOf({
		cues: [],
		language: 'eng',
		profile: 'smpte-tt-simplified' as never,
	})).toThrow(/imsc1, ebu-tt-d, smpte-tt/);
	expect(() => new SubtitleCueSource('ttml', { ttmlProfile: 'nope' as never }))
		.toThrow(/imsc1, ebu-tt-d, smpte-tt/);
});

test('a placement that states only part of a box fills the rest from the default region', () => {
	// A region with no extent covers the whole frame, so a cue that asked only for vertical text would
	// also have moved and grown. Only what it asked for differs from r0.
	const xml = ttmlDocumentOf({
		cues: [{ timestamp: 5, duration: 1, text: 'v', placement: { writingMode: 'tbrl' } }],
		language: 'jpn',
	});

	expect(xml).toContain('<region xml:id="r1" tts:origin="10% 10%" tts:extent="80% 80%"'
		+ ' tts:displayAlign="after" tts:writingMode="tbrl" tts:overflow="visible"/>');

	// And r0 is still written from the same numbers, so the two cannot drift apart
	expect(xml).toContain('<region xml:id="r0" tts:origin="10% 10%" tts:extent="80% 80%"'
		+ ' tts:displayAlign="after" tts:overflow="visible"/>');
});

test('a partial box keeps what it does state', () => {
	const xml = ttmlDocumentOf({
		cues: [{ timestamp: 0, duration: 1, text: 'x', placement: { origin: { x: 0, y: 70 } } }],
		language: 'eng',
	});

	// Its own origin, the default's extent and alignment
	expect(xml).toContain('<region xml:id="r1" tts:origin="0% 70%" tts:extent="80% 80%"'
		+ ' tts:displayAlign="after" tts:overflow="visible"/>');
});

test('an IMSC1 document names its profile both ways', () => {
	// IMSC 1.1 section 6.3: ttp:contentProfiles is 1.1's, and a 1.0.1 processor reads ttp:profile, so
	// a document stating only the former has no profile as far as that processor is concerned
	const xml = ttmlDocumentOf({ cues: [{ timestamp: 0, duration: 1, text: 'x' }], language: 'eng' });
	const designator = 'http://www.w3.org/ns/ttml/profile/imsc1/text';

	expect(xml).toContain(`ttp:profile="${designator}"`);
	expect(xml).toContain(`ttp:contentProfiles="${designator}"`);

	// The other two name themselves their own way, and neither is the IMSC text profile
	for (const profile of ['ebu-tt-d', 'smpte-tt'] as const) {
		const other = buildTtmlDocument({ cues: [{ timestamp: 0, duration: 1, text: 'x' }], language: 'eng', profile });
		expect(other).not.toContain(designator);
	}
});
