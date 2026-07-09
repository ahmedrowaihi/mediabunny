import { describe, expect, test } from 'vitest';
import type { Mpd } from '../../src/dash/dash-mpd-parser.js';
import { parseManifest, pipeManifest, serializeManifest } from '../../src/manifest.js';
import type { Manifest, ManifestTransform } from '../../src/manifest.js';

const HLS_MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-0.m4s
#EXT-X-ENDLIST
`;

const emptyMpd = (): Mpd => ({
	type: 'static',
	profiles: ['urn:mpeg:dash:profile:isoff-live:2011'],
	mediaPresentationDuration: null,
	minimumUpdatePeriod: null,
	availabilityStartTime: null,
	publishTime: null,
	timeShiftBufferDepth: null,
	suggestedPresentationDelay: null,
	maxSegmentDuration: null,
	minBufferTime: null,
	baseURLs: [],
	utcTiming: [],
	periods: [{ id: 'p0', start: null, duration: null, baseURLs: [], adaptationSets: [] }],
});

describe('Manifest facade', () => {
	test('parseManifest sniffs HLS and round-trips through serializeManifest', () => {
		const manifest = parseManifest(HLS_MEDIA);
		expect(manifest.format).toBe('hls');
		const reparsed = parseManifest(serializeManifest(manifest));
		expect(reparsed).toEqual(manifest);
	});

	test('parseManifest routes MPD text to the DASH parser', () => {
		// No DOMParser in the node test env, so the DASH branch surfaces parseMpd's own
		// error — which proves the sniff routed `<MPD>` to DASH, not HLS or the throw.
		expect(() => parseManifest('<?xml version="1.0"?><MPD></MPD>')).toThrow(/DOMParser/);
	});

	test('parseManifest throws on text matching neither format', () => {
		expect(() => parseManifest('not a manifest')).toThrow(/Unrecognized manifest/);
	});

	test('serializeManifest dispatches on format', () => {
		const dash: Manifest = { format: 'dash', mpd: emptyMpd() };
		expect(serializeManifest(dash)).toContain('<MPD');

		const hls = parseManifest(HLS_MEDIA);
		expect(serializeManifest(hls).startsWith('#EXTM3U')).toBe(true);
	});

	test('pipe threads transforms left to right', () => {
		const order: string[] = [];
		const mark = (name: string): ManifestTransform => (manifest) => {
			order.push(name);
			return manifest;
		};
		const dash: Manifest = { format: 'dash', mpd: emptyMpd() };
		const out = pipeManifest(dash, [mark('a'), mark('b'), mark('c')]);
		expect(order).toEqual(['a', 'b', 'c']);
		expect(out).toBe(dash);
	});

	test('pipe with no transforms returns the input unchanged', () => {
		const dash: Manifest = { format: 'dash', mpd: emptyMpd() };
		expect(pipeManifest(dash, [])).toBe(dash);
	});

	test('sniff tolerates a leading BOM and blank lines before #EXTM3U', () => {
		const withBom = `\uFEFF\n  \n${HLS_MEDIA}`;
		const manifest = parseManifest(withBom);
		expect(manifest.format).toBe('hls');
		if (manifest.format !== 'hls' || manifest.playlist.kind !== 'media') {
			throw new Error('expected an HLS media playlist');
		}
		expect(manifest.playlist.segments).toHaveLength(1);
	});

	test('sniff routes a namespace-prefixed MPD root to DASH, not the throw', () => {
		expect(() => parseManifest('<dash:MPD xmlns:dash="urn:mpeg:dash:schema:mpd:2011"></dash:MPD>'))
			.toThrow(/DOMParser/);
	});

	test('a bare <MPDeliver substring is not mistaken for an MPD root', () => {
		expect(() => parseManifest('<MPDeliver>not a manifest</MPDeliver>')).toThrow(/Unrecognized manifest/);
	});
});
