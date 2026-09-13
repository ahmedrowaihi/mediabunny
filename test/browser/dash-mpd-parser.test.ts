import { expect, test } from 'vitest';
import { parseMpd } from '../../src/dash/dash-mpd-parser.js';
import {
	normaliseKeyId,
	parseByteRange,
	parseFrameRate,
	parseISODuration,
	substituteTemplate,
} from '../../src/dash/dash-misc.js';

const PROFILE = 'urn:mpeg:dash:profile:isoff-live:2011';
const STATIC_ATTRS = `type="static" profiles="${PROFILE}"`;
const NS = 'xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"';

const wrap = (body: string, attrs: string = STATIC_ATTRS): string =>
	`<?xml version="1.0"?>\n<MPD ${NS} ${attrs}>\n${body}\n</MPD>`;

test('parseMpd: rejects invalid XML', () => {
	expect(() => parseMpd('not xml')).toThrow(/MPD parse error/);
});

test('parseMpd: rejects non-MPD root', () => {
	expect(() => parseMpd('<?xml version="1.0"?><foo></foo>')).toThrow(/expected <MPD>/);
});

test('parseMpd: rejects MPD with no periods', () => {
	expect(() => parseMpd('<?xml version="1.0"?><MPD></MPD>')).toThrow(/no <Period>/);
});

test('parseMpd: static MPD with SegmentTemplate, single Period, two video reps + one audio rep', () => {
	const mpd = parseMpd(wrap(
		`<Period id="p0" duration="PT30S">
			<AdaptationSet id="1" contentType="video" mimeType="video/mp4"
				codecs="avc1.640028" frameRate="30000/1001">
				<SegmentTemplate
					media="$RepresentationID$/seg-$Number%05d$.m4s"
					initialization="$RepresentationID$/init.mp4"
					timescale="90000" duration="180000" startNumber="1"/>
				<Representation id="v720" bandwidth="2500000" width="1280" height="720"/>
				<Representation id="v360" bandwidth="800000" width="640" height="360"/>
			</AdaptationSet>
			<AdaptationSet id="2" contentType="audio" mimeType="audio/mp4"
				codecs="mp4a.40.2" lang="en">
				<SegmentTemplate
					media="audio/seg-$Number$.m4s"
					initialization="audio/init.mp4"
					timescale="48000" duration="96000" startNumber="1"/>
				<Representation id="a128" bandwidth="128000" audioSamplingRate="48000"/>
			</AdaptationSet>
		</Period>`,
	));

	expect(mpd.type).toBe('static');
	expect(mpd.profiles).toEqual(['urn:mpeg:dash:profile:isoff-live:2011']);
	expect(mpd.periods).toHaveLength(1);

	const period = mpd.periods[0]!;
	expect(period.id).toBe('p0');
	expect(period.duration).toBe(30);
	expect(period.adaptationSets).toHaveLength(2);

	const videoAs = period.adaptationSets[0]!;
	expect(videoAs.contentType).toBe('video');
	expect(videoAs.mimeType).toBe('video/mp4');
	expect(videoAs.codecs).toBe('avc1.640028');
	expect(videoAs.frameRate).toEqual({ numerator: 30000, denominator: 1001 });
	expect(videoAs.representations).toHaveLength(2);
	expect(videoAs.segmentTemplate).not.toBeNull();
	expect(videoAs.segmentTemplate!.timescale).toBe(90000);
	expect(videoAs.segmentTemplate!.duration).toBe(180000);
	expect(videoAs.segmentTemplate!.media).toBe('$RepresentationID$/seg-$Number%05d$.m4s');

	const v720 = videoAs.representations[0]!;
	expect(v720.id).toBe('v720');
	expect(v720.bandwidth).toBe(2500000);
	expect(v720.width).toBe(1280);
	expect(v720.height).toBe(720);

	const audioAs = period.adaptationSets[1]!;
	expect(audioAs.contentType).toBe('audio');
	expect(audioAs.lang).toBe('en');
	expect(audioAs.representations[0]!.audioSamplingRate).toBe(48000);
});

test('parseMpd: SegmentTimeline produces typed entries with t/d/r', () => {
	const mpd = parseMpd(wrap(
		`<Period id="p0">
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<SegmentTemplate media="v-$Number$.m4s" timescale="90000">
					<SegmentTimeline>
						<S t="0" d="180000" r="2"/>
						<S d="90000"/>
						<S t="630000" d="270000"/>
					</SegmentTimeline>
				</SegmentTemplate>
				<Representation id="v1" bandwidth="1000000" codecs="avc1.42c01e"/>
			</AdaptationSet>
		</Period>`,
	));

	const tpl = mpd.periods[0]!.adaptationSets[0]!.segmentTemplate!;
	expect(tpl.timeline).toEqual([
		{ t: 0, d: 180000, r: 2 },
		{ t: null, d: 90000, r: 0 },
		{ t: 630000, d: 270000, r: 0 },
	]);
});

test('parseMpd: SegmentList collects SegmentURL + Initialization + byte ranges', () => {
	const mpd = parseMpd(wrap(
		`<Period>
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<Representation id="v1" bandwidth="1000000" codecs="avc1.42c01e">
					<SegmentList timescale="90000" duration="180000" startNumber="1">
						<Initialization sourceURL="init.mp4" range="0-799"/>
						<SegmentURL media="seg-1.m4s" mediaRange="800-1199"/>
						<SegmentURL media="seg-2.m4s" mediaRange="1200-1599"/>
					</SegmentList>
				</Representation>
			</AdaptationSet>
		</Period>`,
	));

	const list = mpd.periods[0]!.adaptationSets[0]!.representations[0]!.segmentList!;
	expect(list.initialization).toEqual({ sourceURL: 'init.mp4', range: { start: 0, end: 799 } });
	expect(list.segments).toEqual([
		{ media: 'seg-1.m4s', mediaRange: { start: 800, end: 1199 }, index: null, indexRange: null },
		{ media: 'seg-2.m4s', mediaRange: { start: 1200, end: 1599 }, index: null, indexRange: null },
	]);
});

test('parseMpd: SegmentBase with indexRange and inline Initialization', () => {
	const mpd = parseMpd(wrap(
		`<Period>
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<Representation id="v1" bandwidth="1000000" codecs="avc1.42c01e">
					<SegmentBase indexRange="900-1099" timescale="90000" presentationTimeOffset="0">
						<Initialization range="0-899"/>
					</SegmentBase>
				</Representation>
			</AdaptationSet>
		</Period>`,
	));

	const base = mpd.periods[0]!.adaptationSets[0]!.representations[0]!.segmentBase!;
	expect(base.timescale).toBe(90000);
	expect(base.indexRange).toEqual({ start: 900, end: 1099 });
	expect(base.initialization).toEqual({ sourceURL: null, range: { start: 0, end: 899 } });
});

test('parseMpd: BaseURL collected at MPD/Period/AS/Representation levels', () => {
	const mpd = parseMpd(wrap(
		`<BaseURL>https://cdn.example.com/v1/</BaseURL>
		<Period>
			<BaseURL>p0/</BaseURL>
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<BaseURL>video/</BaseURL>
				<Representation id="v1" bandwidth="1000000" codecs="avc1.42c01e">
					<BaseURL>720p/</BaseURL>
				</Representation>
			</AdaptationSet>
		</Period>`,
	));

	expect(mpd.baseURLs).toEqual(['https://cdn.example.com/v1/']);
	expect(mpd.periods[0]!.baseURLs).toEqual(['p0/']);
	expect(mpd.periods[0]!.adaptationSets[0]!.baseURLs).toEqual(['video/']);
	expect(mpd.periods[0]!.adaptationSets[0]!.representations[0]!.baseURLs).toEqual(['720p/']);
});

test('parseMpd: multi-Period', () => {
	const mpd = parseMpd(wrap(
		`<Period id="ad" start="PT0S" duration="PT15S">
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<Representation id="ad-v" bandwidth="2000000" codecs="avc1.42c01e"/>
			</AdaptationSet>
		</Period>
		<Period id="main" start="PT15S" duration="PT3600S">
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<Representation id="main-v" bandwidth="5000000" codecs="avc1.640028"/>
			</AdaptationSet>
		</Period>`,
	));

	expect(mpd.periods.map((p: { id: string | null }) => p.id)).toEqual(['ad', 'main']);
	expect(mpd.periods[0]!.duration).toBe(15);
	expect(mpd.periods[1]!.duration).toBe(3600);
});

test('parseMpd: ContentProtection with cenc:default_KID + pssh', () => {
	const psshBytes = new Uint8Array([0, 0, 0, 32, 112, 115, 115, 104, 0, 0, 0, 0]);
	const psshB64 = btoa(String.fromCharCode(...psshBytes));
	const mpd = parseMpd(wrap(
		`<Period>
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<ContentProtection
					schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
					cenc:default_KID="12345678-1234-1234-1234-1234567890AB"/>
				<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
					<cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">${psshB64}</cenc:pssh>
				</ContentProtection>
				<Representation id="v1" bandwidth="1000000" codecs="avc1.42c01e"/>
			</AdaptationSet>
		</Period>`,
	));

	const protections = mpd.periods[0]!.adaptationSets[0]!.contentProtections;
	expect(protections).toHaveLength(2);
	expect(protections[0]!.schemeIdUri).toBe('urn:mpeg:dash:mp4protection:2011');
	expect(protections[0]!.value).toBe('cenc');
	expect(protections[0]!.keyId).toBe('123456781234123412341234567890ab');
	expect(protections[1]!.schemeIdUri).toBe('urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
	expect(protections[1]!.psshBoxes).toHaveLength(1);
	expect(protections[1]!.psshBoxes[0]).toEqual(psshBytes);
});

test('parseMpd: dynamic MPD captures live attributes', () => {
	const mpd = parseMpd(wrap(
		`<Period>
			<AdaptationSet contentType="video" mimeType="video/mp4">
				<SegmentTemplate media="v-$Number$.m4s" timescale="90000" duration="180000"/>
				<Representation id="v1" bandwidth="1000000" codecs="avc1.42c01e"/>
			</AdaptationSet>
		</Period>`,
		[
			'type="dynamic"',
			'availabilityStartTime="2026-01-01T00:00:00Z"',
			'minimumUpdatePeriod="PT5S"',
			'publishTime="2026-01-01T00:00:05Z"',
			'timeShiftBufferDepth="PT1M"',
			'suggestedPresentationDelay="PT10S"',
		].join(' '),
	));

	expect(mpd.type).toBe('dynamic');
	expect(mpd.availabilityStartTime).toBe(Date.parse('2026-01-01T00:00:00Z'));
	expect(mpd.minimumUpdatePeriod).toBe(5);
	expect(mpd.timeShiftBufferDepth).toBe(60);
	expect(mpd.suggestedPresentationDelay).toBe(10);
});

test('parseMpd: Role elements collected with schemeIdUri + value', () => {
	const mpd = parseMpd(wrap(
		`<Period>
			<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
				<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
				<Role schemeIdUri="urn:mpeg:dash:role:2011" value="dub"/>
				<Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
			</AdaptationSet>
		</Period>`,
	));

	expect(mpd.periods[0]!.adaptationSets[0]!.roles).toEqual([
		{ schemeIdUri: 'urn:mpeg:dash:role:2011', value: 'main' },
		{ schemeIdUri: 'urn:mpeg:dash:role:2011', value: 'dub' },
	]);
});

test('substituteTemplate: handles $Number$ / $Time$ / $RepresentationID$ / $Bandwidth$ / $$ / width modifier', () => {
	expect(substituteTemplate('$RepresentationID$/seg-$Number%05d$.m4s', { number: 7, representationId: 'v720' }))
		.toBe('v720/seg-00007.m4s');
	expect(substituteTemplate('chunk-$Number$-$Time$.m4s', { number: 3, time: 540000 }))
		.toBe('chunk-3-540000.m4s');
	expect(substituteTemplate('$Bandwidth$bps/seg.m4s', { bandwidth: 2500000 }))
		.toBe('2500000bps/seg.m4s');
	expect(substituteTemplate('price$$.m4s', {})).toBe('price$.m4s');
	expect(substituteTemplate('$Number$', {})).toBe('$Number$'); // no substitution when missing
});

test('parseISODuration: standard forms', () => {
	expect(parseISODuration('PT30S')).toBe(30);
	expect(parseISODuration('PT1M30S')).toBe(90);
	expect(parseISODuration('PT1H')).toBe(3600);
	expect(parseISODuration('P1DT2H3M4S')).toBe(86400 + 2 * 3600 + 3 * 60 + 4);
	expect(parseISODuration('PT0.5S')).toBeCloseTo(0.5);
	expect(parseISODuration('-PT5S')).toBe(-5);
	expect(parseISODuration('bogus')).toBeNull();
	expect(parseISODuration(null)).toBeNull();
});

test('parseFrameRate: rational + integer + decimal forms', () => {
	expect(parseFrameRate('30000/1001')).toEqual({ numerator: 30000, denominator: 1001 });
	expect(parseFrameRate('30')).toEqual({ numerator: 30, denominator: 1 });
	expect(parseFrameRate('29.97')).toEqual({ numerator: 29.97, denominator: 1 });
	expect(parseFrameRate('1/0')).toBeNull();
	expect(parseFrameRate('')).toBeNull();
});

test('normaliseKeyId: UUID and stripped forms produce identical output', () => {
	expect(normaliseKeyId('12345678-1234-1234-1234-1234567890ab')).toBe('123456781234123412341234567890ab');
	expect(normaliseKeyId('123456781234123412341234567890AB')).toBe('123456781234123412341234567890ab');
	expect(normaliseKeyId('not-hex')).toBeNull();
	expect(normaliseKeyId('')).toBeNull();
	expect(normaliseKeyId('1234')).toBeNull();
});

test('parseByteRange: standard "start-end"', () => {
	expect(parseByteRange('0-799')).toEqual({ start: 0, end: 799 });
	expect(parseByteRange('1000-999')).toBeNull(); // end < start
	expect(parseByteRange('garbage')).toBeNull();
});
