/*!
 * Foreign markup an MPD carries at its extension points. Two ways it went wrong: an element was
 * kept while the `xmlns:` that declares its prefix was dropped, leaving XML a DOMParser rejects
 * (Namespaces in XML section 5); and `<ContentProtection>` children were dropped outright, taking a
 * PlayReady PRO and a licence URL with them.
 */
import { describe, expect, test } from 'vitest';
import { parseMpd } from '../../src/dash/dash-mpd-parser.js';
import { serializeMpd } from '../../src/dash/dash-mpd-serializer.js';

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:scte35="urn:scte:scte35:2014:xml+bin"
     xmlns:mspr="urn:microsoft:playready" xmlns:dashif="https://dashif.org/"
     type="static" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="p0">
    <EventStream schemeIdUri="urn:scte:scte35:2014:xml+bin">
      <Event presentationTime="0" duration="100" id="1">
        <scte35:Signal><scte35:Binary>/DAlAAA=</scte35:Binary></scte35:Signal>
      </Event>
    </EventStream>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" value="MSPR 2.0">
        <mspr:pro>PRO_DATA_HERE</mspr:pro>
        <dashif:laurl>https://license.example/acquire</dashif:laurl>
      </ContentProtection>
      <Representation id="v0" bandwidth="1000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('foreign markup survives a round trip', () => {
	const out = serializeMpd(parseMpd(MPD));

	test.each([
		'scte35:Signal', 'scte35:Binary', '/DAlAAA=',
		'mspr:pro', 'PRO_DATA_HERE',
		'dashif:laurl', 'https://license.example/acquire',
	])('keeps %s', (needle) => {
		expect(out).toContain(needle);
	});

	test.each(['scte35', 'mspr', 'dashif'])('declares xmlns:%s for what it kept', (prefix) => {
		expect(out).toContain(`xmlns:${prefix}=`);
	});

	test('every prefix used is declared, so the XML parses', () => {
		const declared = new Set([...out.matchAll(/xmlns:([A-Za-z_][\w.-]*)=/g)].map(m => m[1]!));
		const used = new Set([...out.matchAll(/<\s*([A-Za-z_][\w.-]*):/g)].map(m => m[1]!));

		for (const prefix of used) {
			expect(declared, `<${prefix}:…> is used but xmlns:${prefix} is not declared`).toContain(prefix);
		}
	});

	test('the ContentProtection keeps its own children on the AST', () => {
		const mpd = parseMpd(MPD);
		const protection = mpd.periods[0]!.adaptationSets[0]!.contentProtections[0]!;
		expect(protection.foreignXml).toHaveLength(2);
		expect(protection.foreignXml.join('')).toContain('PRO_DATA_HERE');
	});
});

describe('an SCTE-35 splice signal is modelled, not just carried', () => {
	// SCTE-214-1 defines this; it is a standard, and an ad splicer reads the payload directly rather
	// than re-parsing markup. Reading it must not change what gets written back.
	const mpd = parseMpd(MPD);
	const event = mpd.periods[0]!.eventStreams[0]!.events[0]!;

	test('the payload is readable without touching the XML', () => {
		expect(event.scte35Binary).toBe('/DAlAAA=');
	});

	test('the original Signal is still written back verbatim', () => {
		const out = serializeMpd(mpd);
		expect(out).toContain('scte35:Signal');
		// exactly one, not the original plus a synthesized copy
		expect([...out.matchAll(/<\s*(?:\w+:)?Signal[\s>]/g)]).toHaveLength(1);
	});

	test('an event with no Signal of its own gets one when the payload is set', () => {
		const built = structuredClone(mpd);
		const target = built.periods[0]!.eventStreams[0]!.events[0]!;
		target.foreignXml = [];
		target.scte35Binary = 'ABCD';

		const out = serializeMpd(built);
		expect(out).toContain('<scte35:Binary>ABCD</scte35:Binary>');
		expect(out).toContain('xmlns:scte35=');
	});

	test('an event that is not a splice reads as null', () => {
		const plain = parseMpd(MPD.replace(
			/<scte35:Signal>[\s\S]*?<\/scte35:Signal>/,
			'',
		));
		expect(plain.periods[0]!.eventStreams[0]!.events[0]!.scte35Binary).toBeNull();
	});
});
