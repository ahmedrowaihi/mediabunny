import { readFile } from 'node:fs/promises';
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
	schemaLocation: null,
	serviceDescriptions: [],
	utcTiming: [],
	periods: [{ id: 'p0', start: null, duration: null, baseURLs: [], serviceDescriptions: [], adaptationSets: [] }],
});

describe('Manifest facade', () => {
	test('parseManifest sniffs HLS and round-trips through serializeManifest', () => {
		const manifest = parseManifest(HLS_MEDIA);
		expect(manifest.format).toBe('hls');
		const reparsed = parseManifest(serializeManifest(manifest));
		expect(reparsed).toEqual(manifest);
	});

	test('a media playlist keeps its discontinuity sequence through a round trip', () => {
		const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-DISCONTINUITY-SEQUENCE:7
#EXTINF:6.000,
seg-5.m4s
#EXT-X-DISCONTINUITY
#EXTINF:6.000,
seg-6.m4s
#EXT-X-ENDLIST
`;
		const manifest = parseManifest(text);
		if (manifest.format !== 'hls' || manifest.playlist.kind !== 'media') {
			throw new Error('expected an HLS media playlist');
		}
		expect(manifest.playlist.discontinuitySequence).toBe(7);

		const out = serializeManifest(manifest);
		expect(out).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:7');
		// Sibling counter and the plain tag already survived, so a red here is the sequence alone
		expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:5');
		expect(out).toContain('#EXT-X-DISCONTINUITY\n');
	});

	test('parseManifest routes MPD text to the DASH parser', () => {
		// parseMpd's own error proves the sniff routed `<MPD>` to DASH
		expect(() => parseManifest('<?xml version="1.0"?><MPD></MPD>')).toThrow(/MPD parse error/);
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
			.toThrow(/MPD parse error/);
	});

	test('a bare <MPDeliver substring is not mistaken for an MPD root', () => {
		expect(() => parseManifest('<MPDeliver>not a manifest</MPDeliver>')).toThrow(/Unrecognized manifest/);
	});
});

// A factory that pins a field to a constant makes that part of the AST unreachable to callers: parse can read it,
// serialize can write it, and no builder can set it. That gap is invisible to round-trip tests, which never go
// through a builder, so it is checked here against the AST types the parsers return.
describe('AST builders can reach every field the parsers model', () => {
	const unreachableFields = (typeSource: string, factorySource: string, typePattern: RegExp) => {
		const types = new Map<string, string[]>();
		for (const match of typeSource.matchAll(typePattern)) {
			const fields = [...match[2]!.matchAll(/^\t(\w+)\??:/gm)].map(f => f[1]!);
			if (fields.length > 0) {
				types.set(match[1]!, fields);
			}
		}

		const dead: string[] = [];
		const factories = factorySource.matchAll(
			/export const (\w+) = \(options: \{(?:.*?)\n\}\): (\w+)(?:\[\])? => \(\{(.*?)\n\}\);/gs,
		);
		for (const [, name, returnType, body] of factories) {
			for (const field of types.get(returnType!) ?? []) {
				// `lineNumber` and the `kind` discriminant are set by the factory by definition.
				if (field === 'lineNumber' || field === 'kind') {
					continue;
				}
				if (new RegExp(`^\\t${field}: (?!.*options\\.).*$`, 'm').test(body!)) {
					dead.push(`${name}() cannot set ${returnType}.${field}`);
				}
			}
		}
		return dead;
	};

	const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf-8');

	test('every HLS AST field is settable through hls* factories', async () => {
		const dead = unreachableFields(
			await read('../../src/hls/hls-playlist-parser.ts'),
			await read('../../src/hls/hls-playlist-builder.ts'),
			/export type (Hls\w+) = \{(.*?)\n\};/gs,
		);
		expect(dead).toEqual([]);
	});

	test('every DASH AST field is settable through mpd* factories', async () => {
		const dead = unreachableFields(
			await read('../../src/dash/dash-mpd-parser.ts'),
			await read('../../src/dash/dash-mpd-factories.ts'),
			/export type (Mpd\w+|Segment\w+) = \{(.*?)\n\};/gs,
		);
		expect(dead).toEqual([]);
	});

	// A type with no factory is one a caller must spell out field by field, and tsc reveals a nested type's missing
	// fields only after the outer ones are filled — so each level of nesting costs a whole typecheck to discover.
	// This is the axis above field reachability: not "can the factory set it" but "is there a factory at all".
	const typesWithoutFactory = (typeSource: string, factorySource: string, typePattern: RegExp) => {
		const sizes = new Map<string, number>();
		for (const match of typeSource.matchAll(typePattern)) {
			const fields = [...match[2]!.matchAll(/^\t(\w+)\??:/gm)];
			if (fields.length > 0) {
				sizes.set(match[1]!, fields.length);
			}
		}

		const produced = new Set([...factorySource.matchAll(/\}\): (\w+) => \(\{/g)].map(m => m[1]!));
		return [...sizes.keys()]
			.filter(name => !produced.has(name))
			// Only types a caller is actually asked to supply, by name or by indexed access.
			.filter(name => new RegExp(`\\b${name}\\b`).test(factorySource))
			.sort();
	};

	test('every HLS AST type a builder asks for has a factory', async () => {
		expect(typesWithoutFactory(
			await read('../../src/hls/hls-playlist-parser.ts'),
			await read('../../src/hls/hls-playlist-builder.ts'),
			/export type (Hls\w+) = \{(.*?)\n\};/gs,
		)).toEqual([]);
	});

	test('every DASH AST type a factory asks for has a factory', async () => {
		expect(typesWithoutFactory(
			await read('../../src/dash/dash-mpd-parser.ts'),
			await read('../../src/dash/dash-mpd-factories.ts'),
			/export type (Mpd\w+) = \{(.*?)\n\};/gs,
		)).toEqual([]);
	});
});
