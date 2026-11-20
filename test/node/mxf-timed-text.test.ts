/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SMPTE ST 2067-5 describes an IMF timed text track file with a set SMPTE 377M does not define. The
// standard is not public, so the bytes below are lifted from a real IMSC text track file - the IMF
// plugfest sample in Netflix photon's test resources - rather than written from a table. The whole
// file is not committed; what is, is the part that decides whether the parse is right.

import { expect, test } from 'vitest';
import { hexStringToBytes } from '../../src/misc.js';
import { decodeTimedTextDocument, readTimedTextInfo } from '../../src/mxf/mxf-timed-text.js';
import { parseTtmlDocument } from '../../src/subtitles.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { FilePathSource } from '../../src/source.js';
import { SubtitleCueSink } from '../../src/media-sink.js';
import { InputSubtitleTrack } from '../../src/input-track.js';
import type { LocalSet } from '../../src/mxf/mxf-klv.js';

/**
 * The timed text descriptor's value bytes, verbatim from that file: local tag, 16-bit length, value.
 *
 * Note the tags it uses for the ST 2067-5 properties - `0xfffc` to `0xffff`. Those are **dynamic**,
 * assigned by this file's own primer pack, and another writer will number them differently.
 */
const DESCRIPTOR_HEX
	= '3c0a0010a2f8a3b881db40e2a4428b21910a756b'
		+ '30060004000000023001000800005dc0000003e93002000800000000000018603004'
		+ '0010060e2b340401010a0d01030102130101'
		+ 'ffff0010f11df6823d2f4b4a862fe460b94bd366'
		+ 'fffe000a005500540046002d0038'
		+ 'fffd00580068007400740070003a002f002f007700770077002e00770033002e006f00720067002f006e0073002f'
		+ '00740074006d006c002f00700072006f00660069006c0065002f0069006d007300630031002f0074006500780074'
		+ 'fffc00040065006e';

/** The item ULs this file's primer maps those four tags to, verbatim from its primer pack. */
const PRIMER_ENTRIES: [number, string][] = [
	[0xffff, '060e2b340101010c0101151200000000'], // ResourceID
	[0xfffe, '060e2b340101010c0409050000000000'], // UCSEncoding
	[0xfffd, '060e2b34010101080102010501000000'], // NamespaceURI
	[0xfffc, '060e2b340101010e0301010202160000'], // RFC5646LanguageTagList
];

const parseSet = (hex: string): LocalSet => {
	const bytes = hexStringToBytes(hex);
	const set: LocalSet = new Map();

	let at = 0;
	while (at + 4 <= bytes.length) {
		const tag = (bytes[at]! << 8) | bytes[at + 1]!;
		const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
		set.set(tag, bytes.subarray(at + 4, at + 4 + length));
		at += 4 + length;
	}

	return set;
};

const primerOf = (entries: [number, string][]) =>
	new Map(entries.map(([tag, ul]) => [tag, hexStringToBytes(ul)]));

test('a real timed text descriptor reads as what the file states', () => {
	const info = readTimedTextInfo(parseSet(DESCRIPTOR_HEX), primerOf(PRIMER_ENTRIES))!;

	expect(info).not.toBeNull();
	expect(info.encoding).toBe('UTF-8');
	expect(info.languages).toBe('en');
	expect(info.resourceId).toBe('f11df6823d2f4b4a862fe460b94bd366');
	// Named for a namespace, but what a real file puts there is the IMSC text PROFILE
	expect(info.namespaceUri).toBe('http://www.w3.org/ns/ttml/profile/imsc1/text');
});

test('the properties are matched by UL, never by the tag number', () => {
	// The same descriptor renumbered: a writer is free to assign any dynamic tags it likes, so a
	// reader keyed on 0xfffc..0xffff reads a different file as having no timed text in it at all
	const original = parseSet(DESCRIPTOR_HEX);
	const renumbered: LocalSet = new Map();
	const moved = new Map([[0xffff, 0x8001], [0xfffe, 0x8002], [0xfffd, 0x8003], [0xfffc, 0x8004]]);
	for (const [tag, value] of original) {
		renumbered.set(moved.get(tag) ?? tag, value);
	}

	const primer = primerOf(PRIMER_ENTRIES.map(([tag, ul]) => [moved.get(tag)!, ul]));
	expect(readTimedTextInfo(renumbered, primer)).toEqual(
		readTimedTextInfo(original, primerOf(PRIMER_ENTRIES)),
	);
});

test('a string stops at its terminator rather than carrying a null through', () => {
	// MXF writers pad these to a fixed width; a reader that kept going returns a language tag with
	// nulls on the end, which compares equal to nothing
	const padded = parseSet('fffc000a0065006e000000000000');
	const info = readTimedTextInfo(padded, primerOf(PRIMER_ENTRIES))!;

	expect(info.languages).toBe('en');
});

test('a descriptor stating none of these properties is not timed text', () => {
	// Set 0x0164 is this and nothing else today, but a reader that answered on the set number alone
	// would describe any future set carrying it as a subtitle track
	const other = parseSet('3c0a0010a2f8a3b881db40e2a4428b21910a756b30060004000000023001000800005dc0000003e9');
	expect(readTimedTextInfo(other, primerOf(PRIMER_ENTRIES))).toBeNull();
	expect(readTimedTextInfo(parseSet(DESCRIPTOR_HEX), null)).toBeNull();
	expect(readTimedTextInfo(null, primerOf(PRIMER_ENTRIES))).toBeNull();
});

test('the document is decoded as the encoding the descriptor states', () => {
	const xml = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"/>';
	const utf8 = new TextEncoder().encode(xml);

	expect(decodeTimedTextDocument(utf8, 'UTF-8')).toBe(xml);
	// Absent, which is what a descriptor carrying no encoding leaves: UTF-8 is the one every file uses
	expect(decodeTimedTextDocument(utf8, null)).toBe(xml);

	// A byte order mark does not reach the document: TextDecoder consumes one, which is why nothing
	// here strips it
	const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
	expect(decodeTimedTextDocument(withMark, 'UTF-8')).toBe(xml);
});

// The same plugfest file's document exercises every TTML time expression on purpose - that is what a
// conformance sample is for - and three of the five used to be refused outright.
const ratesAndTimes = (times: string[]) =>
	'<?xml version="1.0"?>'
	+ '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"'
	+ ' ttp:timeBase="media" ttp:frameRate="24" ttp:frameRateMultiplier="1000 1001" ttp:tickRate="1000">'
	+ '<body><div>'
	+ times.map((time, index) => `<p begin="${time}" dur="1s">cue ${index}</p>`).join('')
	+ '</div></body></tt>';

test('frames, ticks and frame-based clock times are read against the rates the document states', () => {
	const cues = parseTtmlDocument(ratesAndTimes(['216f', '255255t', '00:04:12:06', '246.246s', '00:00:52.052']));

	expect(cues).toHaveLength(5);
	// 24 x 1000/1001 frames per second, so 216 frames is 216 x 1001 / 24000
	expect(cues[0]!.timestamp).toBeCloseTo(216 * 1001 / 24000, 6);
	// Ticks are divided by the stated tick rate, not by the frame rate
	expect(cues[1]!.timestamp).toBeCloseTo(255.255, 6);
	// A colon before the last field makes it frames; a dot would have made it hundredths
	expect(cues[2]!.timestamp).toBeCloseTo(4 * 60 + 12 + 6 * 1001 / 24000, 6);
	expect(cues[3]!.timestamp).toBeCloseTo(246.246, 6);
	expect(cues[4]!.timestamp).toBeCloseTo(52.052, 6);
});

test('a fraction and a frame count are told apart by the separator', () => {
	// 00:00:01.06 is 60 ms; 00:00:01:06 is six frames, a quarter of a second at this rate. One
	// character apart, and nothing else in the document says which was meant.
	const [fraction] = parseTtmlDocument(ratesAndTimes(['00:00:01.06']));
	const [frames] = parseTtmlDocument(ratesAndTimes(['00:00:01:06']));

	expect(fraction!.timestamp).toBeCloseTo(1.06, 6);
	expect(frames!.timestamp).toBeCloseTo(1 + 6 * 1001 / 24000, 6);
});

test('the multiplier is applied, and a document stating no rates still reads', () => {
	const noMultiplier = '<?xml version="1.0"?>'
		+ '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"'
		+ ' ttp:timeBase="media" ttp:frameRate="24">'
		+ '<body><div><p begin="24f" dur="1s">x</p></div></body></tt>';
	// No multiplier, so 24 frames is exactly one second rather than 1001/1000 of one
	expect(parseTtmlDocument(noMultiplier)[0]!.timestamp).toBeCloseTo(1, 6);

	// TTML's default frame rate is 30 where the document states none
	const noRates = '<?xml version="1.0"?>'
		+ '<tt xmlns="http://www.w3.org/ns/ttml" ttp:timeBase="media">'
		+ '<body><div><p begin="30f" dur="1s">x</p></div></body></tt>';
	expect(parseTtmlDocument(noRates)[0]!.timestamp).toBeCloseTo(1, 6);
});

/** The plugfest file itself; see FORK.md for where it comes from and why it is committed. */
const SAMPLE = new URL('../public/imf-timed-text.mxf', import.meta.url).pathname;

test('an IMF timed text track file reads as a subtitle track', async () => {
	// The whole chain on real bytes: a data track admitted, its ST 2067-5 descriptor recognised, the
	// document decoded, and its cues read. Every link was derived from this file, so this is the test
	// that says the derivation was right.
	using input = new Input({ source: new FilePathSource(SAMPLE), formats: ALL_FORMATS });
	const tracks = await input.getTracks();

	expect(tracks).toHaveLength(1);
	const track = tracks[0]!;
	expect(track.type).toBe('subtitle');
	expect(track).toBeInstanceOf(InputSubtitleTrack);
	// From RFC5646LanguageTagList, which is where a track file states it
	expect(await track.getLanguageCode()).toBe('en');

	const subtitle = track as InputSubtitleTrack;
	expect(await subtitle.getCodec()).toBe('ttml');

	const cues: { timestamp: number; text: string }[] = [];
	for await (const cue of new SubtitleCueSink(subtitle).cues()) {
		cues.push({ timestamp: cue.timestamp, text: cue.text });
	}

	// One per timed <p>, including paragraphs that differ in nothing a cue carries: four of them sit
	// at 65.065 s with the same string, differing only in ruby positioning, and a reader that
	// deduplicates on time and text reports 33 instead. A consumer that positions per paragraph needs
	// all four.
	expect(cues).toHaveLength(36);

	// Five sit at 65.065 s, and four of those five carry the SAME string - they differ only in ruby
	// positioning, which a cue does not carry. Deduplicating on time and text collapses those four
	// into one and reports 33 cues, which is what this read did until the consumer counted them.
	const together = cues.filter(cue => Math.abs(cue.timestamp - 65.065) < 1e-6);
	expect(together).toHaveLength(5);
	const texts = new Map<string, number>();
	for (const cue of together) {
		texts.set(cue.text, (texts.get(cue.text) ?? 0) + 1);
	}
	expect([...texts.values()].sort((a, b) => b - a)).toEqual([4, 1]);
	// The first cue begins at 216f, which at 24 x 1000/1001 is 9.009 s - a frame expression this
	// reader refused outright until the file made the case
	expect(cues[0]!.timestamp).toBeCloseTo(216 * 1001 / 24000, 3);
	expect(cues[0]!.text).toContain('10% in from each side');

	// Never going backwards - two cues may share a time, since a document can show two regions at
	// once, but a misread form would put one out of order
	for (let i = 1; i < cues.length; i++) {
		expect(cues[i]!.timestamp).toBeGreaterThanOrEqual(cues[i - 1]!.timestamp);
	}

	// The last cue begins at 255255t against a tick rate of 1000. Reading ticks as frames, or frames
	// as hundredths, lands somewhere else entirely while still producing an ordered list.
	expect(cues[cues.length - 1]!.timestamp).toBeCloseTo(255.255, 3);
}, 120_000);
