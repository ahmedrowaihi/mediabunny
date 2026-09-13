import { describe, expect, test } from 'vitest';
import { concatMpdPeriods } from '../../src/dash/dash-concat.js';
import { secondsToXmlDuration } from '../../src/dash/dash-mpd-utils.js';
import { MinimalDomParser } from '../../src/dash/dash-xml-dom-parser.js';

const mpd = (duration: string, body: string, rootAttributes = '') => `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:vendor="urn:example:vendor" type="static"
	profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" mediaPresentationDuration="${duration}"${rootAttributes}>
	<ProgramInformation><Title>A title</Title></ProgramInformation>
	${body}
</MPD>`;

const period = (duration: string, id: string) => `<Period duration="${duration}">
		<AdaptationSet contentType="video" vendor:custom="keep">
			<Representation id="${id}" bandwidth="1000"/>
		</AdaptationSet>
	</Period>`;

const parse = (xml: string) => new MinimalDomParser().parseFromString(xml).documentElement;
const periodsOf = (xml: string) => parse(xml).children.filter(child => child.localName === 'Period');

describe('concatMpdPeriods', () => {
	test('stitches the first Period of each input and renumbers them in order', () => {
		const result = concatMpdPeriods([
			{ xml: mpd('PT10S', period('PT10S', 'v0')) },
			{ xml: mpd('PT5S', period('PT5S', 'v1')) },
		]);

		expect(result.totalDurationSeconds).toBe(15);

		const periods = periodsOf(result.xml);
		expect(periods.map(p => p.getAttribute('id'))).toEqual(['0', '1']);
		expect(periods.map(p => p.getAttribute('start')))
			.toEqual([secondsToXmlDuration(0), secondsToXmlDuration(10)]);
		expect(periods.map(p => p.getAttribute('duration')))
			.toEqual([secondsToXmlDuration(10), secondsToXmlDuration(5)]);
		expect(parse(result.xml).getAttribute('mediaPresentationDuration')).toBe(secondsToXmlDuration(15));
	});

	test('runs without a global DOMParser', () => {
		expect(typeof DOMParser).toBe('undefined');
		expect(() => concatMpdPeriods([{ xml: mpd('PT10S', period('PT10S', 'v0')) }])).not.toThrow();
	});

	test('a stated baseURL becomes the first child of its Period', () => {
		const result = concatMpdPeriods([
			{ xml: mpd('PT10S', period('PT10S', 'v0')), baseURL: 'https://example.test/a/' },
			{ xml: mpd('PT5S', period('PT5S', 'v1')) },
		]);

		const [first, second] = periodsOf(result.xml);
		expect(first!.children[0]!.localName).toBe('BaseURL');
		expect(first!.children[0]!.textContent).toBe('https://example.test/a/');
		expect(second!.children[0]!.localName).toBe('AdaptationSet');
	});

	test('keeps root attributes, namespaces, non-Period children and unmodelled markup', () => {
		const result = concatMpdPeriods([{ xml: mpd('PT10S', period('PT10S', 'v0')) }]);
		const root = parse(result.xml);

		expect(root.getAttribute('profiles')).toBe('urn:mpeg:dash:profile:isoff-on-demand:2011');
		expect(root.getAttribute('xmlns')).toBe('urn:mpeg:dash:schema:mpd:2011');
		expect(root.getAttribute('xmlns:vendor')).toBe('urn:example:vendor');
		expect(root.children.some(child => child.localName === 'ProgramInformation')).toBe(true);

		const adaptationSet = root.getElementsByTagName('AdaptationSet')[0]!;
		expect(adaptationSet.getAttribute('vendor:custom')).toBe('keep');
	});

	test('falls back to the root mediaPresentationDuration when a Period states none', () => {
		const result = concatMpdPeriods([{ xml: mpd('PT8S', '<Period><AdaptationSet/></Period>') }]);
		expect(result.totalDurationSeconds).toBe(8);
	});

	test('rejects bad input', () => {
		expect(() => concatMpdPeriods([])).toThrow(/at least one input/);
		expect(() => concatMpdPeriods([{ xml: '<NotAnMpd/>' }])).toThrow(/expected <MPD>/);
		expect(() => concatMpdPeriods([{ xml: mpd('PT10S', '') }])).toThrow(/has no <Period>/);
		expect(() => concatMpdPeriods([{ xml: '<MPD><Period></MPD>' }])).toThrow(/parse error/);
	});
});
