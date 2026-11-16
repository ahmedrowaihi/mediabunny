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

describe('foreign attributes on properties below the Period', () => {
	// ETSI TS 103 285 7.2.1 states a downloadable font entirely in foreign attributes: the
	// schemeIdUri says "a font" and `dvb:url`, `dvb:fontFamily` and `dvb:mimeType` say which one. The
	// serializer wrote SupplementalProperty and EssentialProperty through a helper that kept only
	// schemeIdUri and value, so what came out signalled a font and named none. Period level used a
	// different helper and was always right, which is what made the two comparable.
	const fontMpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:dvb="urn:dvb:dash-extensions:2014-1"
    profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT10S"
    minBufferTime="PT2S">
  <Period id="p0">
    <SupplementalProperty schemeIdUri="urn:dvb:dash:fontdownload:2014" value="1"
        dvb:url="https://example.com/period.woff" dvb:fontFamily="PeriodFont"
        dvb:mimeType="application/font-woff"/>
    <AdaptationSet id="1" contentType="text" mimeType="application/mp4" lang="en">
      <SupplementalProperty schemeIdUri="urn:dvb:dash:fontdownload:2014" value="1"
          dvb:url="https://example.com/set.woff" dvb:fontFamily="SetFont"
          dvb:mimeType="application/font-woff"/>
      <EssentialProperty schemeIdUri="urn:dvb:dash:fontdownload:2014" value="2" id="ess-1"
          dvb:url="https://example.com/essential.woff" dvb:fontFamily="EssentialFont"
          dvb:mimeType="application/font-woff"/>
      <Representation id="r1" bandwidth="1000" codecs="stpp">
        <SupplementalProperty schemeIdUri="urn:dvb:dash:fontdownload:2014" value="1"
            dvb:url="https://example.com/rep.woff" dvb:fontFamily="RepFont"
            dvb:mimeType="application/font-woff"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

	test('a DVB font download survives a round trip at every level that can carry one', () => {
		const written = serializeMpd(parseMpd(fontMpd));

		for (const [level, family, url] of [
			['Period', 'PeriodFont', 'https://example.com/period.woff'],
			['AdaptationSet', 'SetFont', 'https://example.com/set.woff'],
			['EssentialProperty', 'EssentialFont', 'https://example.com/essential.woff'],
			['Representation', 'RepFont', 'https://example.com/rep.woff'],
		] as const) {
			expect(written, `${level}: dvb:fontFamily`).toContain(`dvb:fontFamily="${family}"`);
			expect(written, `${level}: dvb:url`).toContain(`dvb:url="${url}"`);
		}

		// Three downloads below the Period plus the Period's own, each with its mime type
		expect(written.match(/dvb:mimeType="application\/font-woff"/g)).toHaveLength(4);
		// And the namespace it is all declared in, or a reader cannot resolve any of it
		expect(written).toContain('xmlns:dvb="urn:dvb:dash-extensions:2014-1"');
	});

	test('a property`s own id survives too, since that is what a ref points at', () => {
		const written = serializeMpd(parseMpd(fontMpd));
		expect(written).toContain('id="ess-1"');
	});

	test('parsing and reserialising twice changes nothing further', () => {
		// A round trip that loses attributes loses them on the first pass; one that reorders them would
		// keep changing. Neither should happen.
		const once = serializeMpd(parseMpd(fontMpd));
		expect(serializeMpd(parseMpd(once))).toBe(once);
	});
});

describe('ContentProtection above the AdaptationSet', () => {
	// ISO/IEC 23009-1 5th edition allows <ContentProtection> on MPD and Period as well as on the sets
	// below them, and that is the point of @refId: state the protection data once high up, and have
	// every AdaptationSet point at it with @ref instead of repeating a PSSH per set per period.
	const referencedMpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"
    profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT10S"
    minBufferTime="PT2S">
  <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
      cenc:default_KID="43215678-1234-5678-1234-567812345678" refId="mpd-cenc"/>
  <Period id="p0">
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" refId="period-widevine"/>
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" ref="mpd-cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" ref="period-widevine"/>
      <Representation id="r1" bandwidth="1000" codecs="avc1.64001f" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`;

	test('a protection stated on the MPD or the Period survives a round trip', () => {
		const parsed = parseMpd(referencedMpd);

		expect(parsed.contentProtections).toHaveLength(1);
		expect(parsed.contentProtections[0]!.refId).toBe('mpd-cenc');
		expect(parsed.periods[0]!.contentProtections).toHaveLength(1);
		expect(parsed.periods[0]!.contentProtections[0]!.refId).toBe('period-widevine');

		const written = serializeMpd(parsed);
		expect(written).toContain('refId="mpd-cenc"');
		expect(written).toContain('refId="period-widevine"');
		// The references below still point at them, which is the whole arrangement
		expect(written).toContain('ref="mpd-cenc"');
		expect(written).toContain('ref="period-widevine"');
		// And the default_KID rides along, since that is the data the references stand in for
		expect(written).toContain('cenc:default_KID="43215678-1234-5678-1234-567812345678"');
	});

	test('each sits where its schema puts it, since the order is part of being valid', () => {
		const written = serializeMpd(parseMpd(referencedMpd));

		// MPDtype: ContentProtection comes before the first Period
		expect(written.indexOf('refId="mpd-cenc"')).toBeLessThan(written.indexOf('<Period'));
		// PeriodType: after ServiceDescription and before AdaptationSet
		expect(written.indexOf('refId="period-widevine"')).toBeLessThan(written.indexOf('<AdaptationSet'));
		expect(written.indexOf('<Period')).toBeLessThan(written.indexOf('refId="period-widevine"'));
	});

	test('reserialising twice changes nothing further', () => {
		const once = serializeMpd(parseMpd(referencedMpd));
		expect(serializeMpd(parseMpd(once))).toBe(once);
	});

	test('an MPD with no protection above the sets writes none', () => {
		const plain = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
    type="static" mediaPresentationDuration="PT10S" minBufferTime="PT2S">
  <Period id="p0">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <Representation id="r1" bandwidth="1000" codecs="avc1.64001f" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`;
		const parsed = parseMpd(plain);
		expect(parsed.contentProtections).toEqual([]);
		expect(parsed.periods[0]!.contentProtections).toEqual([]);
		expect(serializeMpd(parsed)).not.toContain('ContentProtection');
	});
});
