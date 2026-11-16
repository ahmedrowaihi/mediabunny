/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	Conversion,
	decodeWmPaceInfo,
	encodeWmPaceInfo,
	encryptCmaf,
	encryptCmafInit,
	encryptVariantSegment,
	variantEncryptor,
	Input,
	Mp4OutputFormat,
	neutralizeWatermarking,
	Output,
	readWmPaceInfo,
	readWmPaceInfoSei,
	readSegmentWmPaceInfo,
	readAllWmPaceInfo,
	readWmPaceInfoTsDescriptor,
	segmentsOf,
	serializeWmSidecar,
	variantFromSchemeIdUri,
	variantIv,
	variantsAligned,
	variantLayoutOf,
	sourcesAligned,
	variantSchemeIdUri,
	WM_PACE_INFO_SCHEME_ID_URI,
	WM_PACE_INFO_SEI_UUID,
	wmPaceInfoBox,
	wmPaceInfoSeiNalUnit,
	wmPaceInfoTsDescriptor,
	zeroPadWmPaceInfo,
	type WmPaceInfo,
	type WmVariantIvState,
} from '../../src/index.js';
import { parseManifest, serializeManifest } from '../../src/manifest.js';
import { mpd, mpdPeriod } from '../../src/dash/dash-mpd-factories.js';
import { serializeMpd } from '../../src/dash/dash-mpd-serializer.js';

// The worked example from DASH-IF Forensic A/B Watermarking (ETSI TS 104 002) clause 5.3.3.2.
const SPEC_EXAMPLE: WmPaceInfo = {
	watermarked: true,
	variant: 0,
	position: 33,
	firstPart: true,
	partCount: 1,
};

describe('WMPaceInfo', () => {
	test('encodes the spec example to the exact 48-bit layout', () => {
		// Pinned byte-for-byte rather than only round-tripped: a round trip agrees with itself
		// even when the bit packing is wrong in both directions.
		//   01        version 1
		//   00        variant 0
		//   80 21     emulation_1 = 1, then pos = 33 across the remaining 15 bits
		//   e0        firstpart = 1, emulation_2 = 1, iswm = 1, reserved = 0
		//   01        nbpart 1
		expect([...encodeWmPaceInfo(SPEC_EXAMPLE)]).toEqual([0x01, 0x00, 0x80, 0x21, 0xe0, 0x01]);
	});

	test('both emulation bits are always set', () => {
		const bytes = encodeWmPaceInfo({ ...SPEC_EXAMPLE, watermarked: false, firstPart: false, position: 0 });
		expect(bytes[2]! & 0x80).toBe(0x80);
		expect(bytes[4]! & 0x40).toBe(0x40);
	});

	test('round-trips every flag combination and the position range', () => {
		for (const watermarked of [true, false]) {
			for (const firstPart of [true, false]) {
				for (const position of [0, 1, 33, 0x7ffe, 0x7fff]) {
					const info = { watermarked, variant: 3, position, firstPart, partCount: 7 };
					expect(decodeWmPaceInfo(encodeWmPaceInfo(info))).toEqual(info);
				}
			}
		}
	});

	test('rejects values the structure cannot hold', () => {
		expect(() => encodeWmPaceInfo({ ...SPEC_EXAMPLE, position: 0x8000 })).toThrow(TypeError);
		expect(() => encodeWmPaceInfo({ ...SPEC_EXAMPLE, variant: 256 })).toThrow(TypeError);
		expect(() => encodeWmPaceInfo({ ...SPEC_EXAMPLE, partCount: -1 })).toThrow(TypeError);
	});

	test('rejects a truncated or unknown-version structure', () => {
		expect(() => decodeWmPaceInfo(new Uint8Array(5))).toThrow(/6 bytes/);
		const bytes = encodeWmPaceInfo(SPEC_EXAMPLE);
		bytes[0] = 2;
		expect(() => decodeWmPaceInfo(bytes)).toThrow(/version 2/);
	});
});

describe('wmpi box', () => {
	test('is a well-formed top-level box', () => {
		const bytes = wmPaceInfoBox(SPEC_EXAMPLE);
		expect(bytes.length).toBe(14);
		expect(new DataView(bytes.buffer).getUint32(0)).toBe(14);
		expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('wmpi');
		expect([...bytes.subarray(8)]).toEqual([...encodeWmPaceInfo(SPEC_EXAMPLE)]);
	});

	test('is found at the start of a segment, and absence reads as null', () => {
		// A plausible segment: the wmpi box, then a styp the box walk has to step over.
		const styp = new Uint8Array([0, 0, 0, 12, 0x73, 0x74, 0x79, 0x70, 0x63, 0x6d, 0x66, 0x63]);
		const box = wmPaceInfoBox(SPEC_EXAMPLE);
		const segment = new Uint8Array(box.length + styp.length);
		segment.set(box, 0);
		segment.set(styp, box.length);

		expect(readWmPaceInfo(segment)).toEqual(SPEC_EXAMPLE);
		expect(readWmPaceInfo(styp)).toBeNull();
	});
});

describe('DASH ingest signalling', () => {
	test('builds and reads the variant scheme id URI', () => {
		expect(variantSchemeIdUri('a')).toBe('http://dashif.org/guidelines/watermarking_variant#a');
		expect(variantSchemeIdUri('0')).toBe('http://dashif.org/guidelines/watermarking_variant#0');
		expect(variantFromSchemeIdUri(variantSchemeIdUri('b'))).toBe('b');
	});

	test('ignores any other scheme, including the sidecar one', () => {
		expect(variantFromSchemeIdUri(WM_PACE_INFO_SCHEME_ID_URI)).toBeNull();
		expect(variantFromSchemeIdUri('urn:mpeg:dash:role:2011')).toBeNull();
	});

	test('rejects a variant identity the spec does not define', () => {
		expect(() => variantSchemeIdUri('A')).toThrow(TypeError);
		expect(() => variantSchemeIdUri('ab')).toThrow(TypeError);
		expect(() => variantSchemeIdUri('')).toThrow(TypeError);
	});
});

describe('watermarking sidecar', () => {
	test('discrete form uses the specification field names, not ours', () => {
		const json: unknown = JSON.parse(serializeWmSidecar({
			segmentType: 'discrete',
			variantSubPaths: [{ variant: 0, subPath: 'a' }, { variant: 1, subPath: 'b' }],
			segments: [{ segmentRegex: 'video_segment_ .*?_123.mp4', wmPaceInfo: SPEC_EXAMPLE }],
		}));
		expect(json).toEqual({
			segmentType: 'discrete',
			variantSubPaths: [{ variant: 0, subPath: 'a' }, { variant: 1, subPath: 'b' }],
			segments: [{
				segmentRegex: 'video_segment_ .*?_123.mp4',
				WMPaceInfoObject: { version: 1, iswm: true, variant: 0, pos: 33, firstpart: true, nbpart: 1 },
			}],
		});
	});

	test('byterange form carries the ranges', () => {
		const json = JSON.parse(serializeWmSidecar({
			segmentType: 'byterange',
			variantSubPaths: [{ variant: 0, subPath: 'a' }],
			segments: [{
				startRange: 0,
				endRange: 1117,
				wmPaceInfo: { ...SPEC_EXAMPLE, watermarked: false, position: 0 },
			}],
		})) as { segments: { startRange: number; endRange: number; WMPaceInfoObject: { iswm: boolean } }[] };
		expect(json.segments[0]!.startRange).toBe(0);
		expect(json.segments[0]!.endRange).toBe(1117);
		expect(json.segments[0]!.WMPaceInfoObject.iswm).toBe(false);
	});
});

describe('HLS ingest signalling', () => {
	const MASTER = [
		'#EXTM3U',
		'#EXT-X-VERSION:4',
		'#EXT-X-INDEPENDENT-SEGMENTS',
		'#EXT-X-STREAM-INF:BANDWIDTH=5227200,CODECS="avc1.4d401f",RESOLUTION=1280x720,'
		+ 'AUDIO="program_audio",WATERMARKING-VARIANT="a"',
		'video_1.m3u8',
		'#EXT-X-STREAM-INF:BANDWIDTH=5227200,CODECS="avc1.4d401f",RESOLUTION=1280x720,'
		+ 'AUDIO="program_audio",WATERMARKING-VARIANT="b"',
		'video_4.m3u8',
		'#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="eng",NAME="Stadium ambiance",AUTOSELECT=YES,'
		+ 'DEFAULT=YES,GROUP-ID="program_audio",URI="audio_8.m3u8",WATERMARKING-VARIANT="a"',
		'',
	].join('\n');

	test('parses WATERMARKING-VARIANT on variants and renditions', () => {
		const playlist = parseManifest(MASTER);
		expect(playlist.format).toBe('hls');
		if (playlist.format !== 'hls' || playlist.playlist.kind !== 'master') {
			throw new Error('expected an HLS master playlist');
		}
		expect(playlist.playlist.variants.map(v => v.watermarkingVariant)).toEqual(['a', 'b']);
		expect(playlist.playlist.media[0]!.watermarkingVariant).toBe('a');
	});

	test('a playlist without the attribute reads as null, not as a variant', () => {
		const playlist = parseManifest(MASTER.replace(/,WATERMARKING-VARIANT="[ab]"/g, ''));
		if (playlist.format !== 'hls' || playlist.playlist.kind !== 'master') {
			throw new Error('expected an HLS master playlist');
		}
		expect(playlist.playlist.variants.map(v => v.watermarkingVariant)).toEqual([null, null]);
		expect(playlist.playlist.media[0]!.watermarkingVariant).toBeNull();
		expect(serializeManifest(playlist)).not.toContain('WATERMARKING-VARIANT');
	});

	test('round-trips the attribute through serialization', () => {
		const serialized = serializeManifest(parseManifest(MASTER));
		expect(serialized).toContain('WATERMARKING-VARIANT="a"');
		expect(serialized).toContain('WATERMARKING-VARIANT="b"');
		const reparsed = parseManifest(serialized);
		if (reparsed.format !== 'hls' || reparsed.playlist.kind !== 'master') {
			throw new Error('expected an HLS master playlist');
		}
		expect(reparsed.playlist.variants.map(v => v.watermarkingVariant)).toEqual(['a', 'b']);
		expect(reparsed.playlist.media[0]!.watermarkingVariant).toBe('a');
	});

	test('round-trips #EXT-X-WMPACEINFO on a media playlist', () => {
		const media = [
			'#EXTM3U',
			'#EXT-X-TARGETDURATION:8',
			'#EXT-X-VERSION:7',
			'#EXT-X-WMPACEINFO:"main_wm_pace_info"',
			'#EXTINF:7.98333,',
			'a/main.mp4',
			'',
		].join('\n');

		const playlist = parseManifest(media);
		if (playlist.format !== 'hls' || playlist.playlist.kind !== 'media') {
			throw new Error('expected an HLS media playlist');
		}
		expect(playlist.playlist.wmPaceInfoUri).toBe('main_wm_pace_info');

		const serialized = serializeManifest(playlist);
		expect(serialized).toContain('#EXT-X-WMPACEINFO:"main_wm_pace_info"');

		const without = parseManifest(media.replace('#EXT-X-WMPACEINFO:"main_wm_pace_info"\n', ''));
		if (without.format !== 'hls' || without.playlist.kind !== 'media') {
			throw new Error('expected an HLS media playlist');
		}
		expect(without.playlist.wmPaceInfoUri).toBeNull();
		expect(serializeManifest(without)).not.toContain('WMPACEINFO');
	});
});

describe('variant IV separation', () => {
	test('derives a distinct IV per variant and leaves the base untouched', () => {
		const base = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
		const a = variantIv(base, 0);
		const b = variantIv(base, 1);
		expect([...a]).toEqual([...base]);
		expect([...b]).toEqual([0x11, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
		// The variant sits where the IV does not advance, so sequences cannot converge.
		expect([...a.subarray(1)]).toEqual([...b.subarray(1)]);
		expect(base[0]).toBe(0x10);
	});

	test('every variant in range gets a different IV', () => {
		const base = new Uint8Array(16).fill(0xf0);
		const seen = new Set([...Array(256).keys()].map(v => variantIv(base, v).join(',')));
		expect(seen.size).toBe(256);
	});

	test('rejects an IV length or variant the scheme cannot carry', () => {
		expect(() => variantIv(new Uint8Array(12), 0)).toThrow(TypeError);
		expect(() => variantIv(new Uint8Array(8), 256)).toThrow(TypeError);
		expect(() => variantIv(new Uint8Array(8), -1)).toThrow(TypeError);
	});
});

describe('variant encryption does not reveal where variants differ', () => {
	const KEY = new Uint8Array(16).fill(7);
	const KID = new Uint8Array(16).fill(3);
	const BASE_IV = new Uint8Array(8).fill(1);

	const fragmented = async () => {
		const source = new BufferSource(new Uint8Array(
			readFileSync(path.join(__dirname, '..', 'public', 'video.mp4')),
		));
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({
			input: new Input({ source, formats: ALL_FORMATS }),
			output,
		})).execute();
		return new Uint8Array(output.target.buffer!);
	};

	/** Stand-in for a watermark embedder: a few bytes deep in the media, no structural change. */
	const asVariantB = (bytes: Uint8Array) => {
		const copy = bytes.slice();
		const marks: number[] = [];
		for (let i = 0; i < 6; i++) {
			const at = Math.floor(copy.length * (0.45 + i * 0.05));
			copy[at] = copy[at]! ^ 0xa5;
			marks.push(at);
		}
		return { bytes: copy, marks };
	};

	const split = (frag: Uint8Array) => {
		const layout = segmentsOf(frag);
		if (layout.init === null || layout.segments.length === 0) {
			throw new Error('expected a fragmented file with an init segment');
		}
		return {
			initBytes: frag.subarray(layout.init.offset, layout.init.offset + layout.init.size),
			segmentBytes: layout.segments.map(s => frag.subarray(s.offset, s.offset + s.size)),
		};
	};

	const differingBytes = (x: Uint8Array, y: Uint8Array) => {
		let count = 0;
		for (let i = 0; i < Math.min(x.length, y.length); i++) {
			if ((x[i]! ^ y[i]!) !== 0) {
				count++;
			}
		}
		return count;
	};

	test('a shared IV localises the watermark, a derived one does not', async () => {
		const variantA = await fragmented();
		const { bytes: variantB, marks } = asVariantB(variantA);
		const opts = { key: KEY, kid: KID, scheme: 'cenc' as const };

		const encA = encryptCmaf(variantA.slice(), { ...opts, iv: variantIv(BASE_IV, 0) });

		// The control: reusing one IV across variants. Without it, "the derived IVs are safe" could
		// pass against an attack that never worked on this input in the first place.
		const leaky = encryptCmaf(variantB.slice(), { ...opts, iv: variantIv(BASE_IV, 0) });
		expect(differingBytes(encA, leaky)).toBe(marks.length);

		const separated = encryptCmaf(variantB.slice(), { ...opts, iv: variantIv(BASE_IV, 1) });
		expect(differingBytes(encA, separated)).toBeGreaterThan(encA.length / 2);
	});

	test('cbcs works against a per-variant init and is refused against a shared one', async () => {
		const frag = await fragmented();
		const { initBytes, segmentBytes } = split(frag);
		const first = segmentBytes[0]!;
		const shared = { key: KEY, kid: KID, scheme: 'cbcs' as const };

		// One init per variant, each stating that variant's own constant IV.
		const initA = encryptCmafInit(initBytes, { ...shared, iv: variantIv(BASE_IV, 0) });
		const initB = encryptCmafInit(initBytes, { ...shared, iv: variantIv(BASE_IV, 1) });

		const ivState: WmVariantIvState = new Map();
		expect(() => encryptVariantSegment(initA, first, {
			...shared, baseIv: BASE_IV, variant: 0, ivState,
		})).not.toThrow();
		expect(() => encryptVariantSegment(initB, first, {
			...shared, baseIv: BASE_IV, variant: 1, ivState,
		})).not.toThrow();

		// Variant B against variant A's init is the sharing case, and it must not be expressible.
		expect(() => encryptVariantSegment(initA, first, {
			...shared, baseIv: BASE_IV, variant: 1, ivState,
		})).toThrow(/one init segment per variant/);

		// A clear init states no constant IV at all, which is also not a per-variant init.
		expect(() => encryptVariantSegment(initBytes, first, {
			...shared, baseIv: BASE_IV, variant: 0, ivState,
		})).toThrow(/states no constant IV/);

		// A cenc init carries a per-sample IV size instead of a constant IV, so it is not one
		// either — and it must be reported as missing rather than misread as a constant.
		const cencInit = encryptCmafInit(initBytes, { key: KEY, kid: KID, scheme: 'cenc', iv: BASE_IV });
		expect(() => encryptVariantSegment(cencInit, first, {
			...shared, baseIv: BASE_IV, variant: 0, ivState,
		})).toThrow(/states no constant IV/);
	});

	test('cbcs hides the watermark far less well than cenc, whatever the IVs', async () => {
		// Marked densely so the proportion landing in clear blocks is measurable rather than luck.
		const variantA = await fragmented();
		const variantB = variantA.slice();
		for (let i = 0; i < 200; i++) {
			const at = Math.floor(variantA.length * (0.30 + 0.0025 * i));
			variantB[at] = variantB[at]! ^ 0xa5;
		}

		/** A differing byte whose neighbourhood is otherwise identical sat in a clear block. */
		const isolatedDifferences = (x: Uint8Array, y: Uint8Array) => {
			let isolated = 0;
			for (let i = 0; i < Math.min(x.length, y.length); i++) {
				if (x[i] === y[i]) {
					continue;
				}
				let neighbours = 0;
				for (let j = Math.max(0, i - 32); j < Math.min(x.length, i + 32); j++) {
					if (j !== i && x[j] !== y[j]) {
						neighbours++;
					}
				}
				if (neighbours === 0) {
					isolated++;
				}
			}
			return isolated;
		};

		const encrypt = (bytes: Uint8Array, variant: number, scheme: 'cenc' | 'cbcs') =>
			encryptCmaf(bytes.slice(), { key: KEY, kid: KID, iv: variantIv(BASE_IV, variant), scheme });

		// cenc encrypts every byte, so separated IVs bury the watermark completely.
		const cencIsolated = isolatedDifferences(encrypt(variantA, 0, 'cenc'), encrypt(variantB, 1, 'cenc'));
		expect(cencIsolated).toBe(0);

		// cbcs encrypts one block in ten, so roughly half the marks sit in the clear and a keyless
		// observer comparing two variants can read their positions straight off.
		const cbcsIsolated = isolatedDifferences(encrypt(variantA, 0, 'cbcs'), encrypt(variantB, 1, 'cbcs'));
		expect(cbcsIsolated).toBeGreaterThan(50);
	});

	test('each variant advances its own IV state, never a shared one', async () => {
		const frag = await fragmented();
		const { initBytes, segmentBytes } = split(frag);
		const ivState: WmVariantIvState = new Map();
		const shared = { key: KEY, kid: KID, baseIv: BASE_IV, ivState, scheme: 'cenc' as const };

		for (const bytes of segmentBytes.slice(0, 2)) {
			encryptVariantSegment(initBytes, bytes, { ...shared, variant: 0 });
			encryptVariantSegment(initBytes, bytes, { ...shared, variant: 1 });
		}

		expect([...ivState.keys()].sort()).toEqual([0, 1]);
		const ivsOfA = [...ivState.get(0)!.values()].map(iv => iv.join(','));
		const ivsOfB = [...ivState.get(1)!.values()].map(iv => iv.join(','));
		expect(ivsOfA.length).toBeGreaterThan(0);
		expect(ivsOfA).not.toEqual(ivsOfB);
	});
});

describe('neutralizing an ingest manifest', () => {
	const INGEST_MASTER = [
		'#EXTM3U',
		'#EXT-X-VERSION:4',
		'#EXT-X-STREAM-INF:BANDWIDTH=5227200,CODECS="avc1.4d401f",RESOLUTION=1280x720,'
		+ 'AUDIO="program_audio",WATERMARKING-VARIANT="a"',
		'a/video_1.m3u8',
		'#EXT-X-STREAM-INF:BANDWIDTH=5227200,CODECS="avc1.4d401f",RESOLUTION=1280x720,'
		+ 'AUDIO="program_audio",WATERMARKING-VARIANT="b"',
		'b/video_1.m3u8',
		'#EXT-X-STREAM-INF:BANDWIDTH=1861200,CODECS="avc1.77.30",RESOLUTION=640x360,'
		+ 'AUDIO="program_audio",WATERMARKING-VARIANT="a"',
		'a/video_2.m3u8',
		'#EXT-X-STREAM-INF:BANDWIDTH=1861200,CODECS="avc1.77.30",RESOLUTION=640x360,'
		+ 'AUDIO="program_audio",WATERMARKING-VARIANT="b"',
		'b/video_2.m3u8',
		'#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="eng",NAME="Main",AUTOSELECT=YES,DEFAULT=YES,'
		+ 'GROUP-ID="program_audio",URI="a/audio.m3u8",WATERMARKING-VARIANT="a"',
		'#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="eng",NAME="Main",AUTOSELECT=YES,DEFAULT=YES,'
		+ 'GROUP-ID="program_audio",URI="b/audio.m3u8",WATERMARKING-VARIANT="b"',
		'',
	].join('\n');

	test('collapses the A/B duplicates and strips the attribute', () => {
		const neutral = neutralizeWatermarking()(parseManifest(INGEST_MASTER));
		if (neutral.format !== 'hls' || neutral.playlist.kind !== 'master') {
			throw new Error('expected an HLS master playlist');
		}
		// Two renditions in the ladder, not four, and the first of each pair survives.
		expect(neutral.playlist.variants.map(v => v.uri)).toEqual(['a/video_1.m3u8', 'a/video_2.m3u8']);
		expect(neutral.playlist.variants.every(v => v.watermarkingVariant === null)).toBe(true);
		expect(neutral.playlist.media.map(m => m.uri)).toEqual(['a/audio.m3u8']);

		const text = serializeManifest(neutral);
		expect(text).not.toContain('WATERMARKING-VARIANT');
	});

	test('drops #EXT-X-WMPACEINFO from a media playlist', () => {
		const media = parseManifest([
			'#EXTM3U',
			'#EXT-X-TARGETDURATION:8',
			'#EXT-X-WMPACEINFO:"main_wm_pace_info"',
			'#EXTINF:8.0,',
			'a/main.mp4',
			'',
		].join('\n'));
		const neutral = neutralizeWatermarking()(media);
		if (neutral.format !== 'hls' || neutral.playlist.kind !== 'media') {
			throw new Error('expected an HLS media playlist');
		}
		expect(neutral.playlist.wmPaceInfoUri).toBeNull();
		expect(serializeManifest(neutral)).not.toContain('WMPACEINFO');
	});

	test('strips both DASH schemes and collapses the per-variant adaptation sets', () => {
		const mpd = parseManifest(`<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"
  minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period id="p0">
    <AdaptationSet contentType="video" mimeType="video/mp4" id="1">
      <EssentialProperty schemeIdUri="http://dashif.org/guidelines/watermarking_variant#a" value="a/seg.mp4"/>
      <Representation id="r1" bandwidth="150000">
        <EssentialProperty schemeIdUri="http://dashif.org/guidelines/watermarking_wmpaceinfo" value="wm.json"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="video" mimeType="video/mp4" id="1">
      <EssentialProperty schemeIdUri="http://dashif.org/guidelines/watermarking_variant#b" value="b/seg.mp4"/>
      <Representation id="r1" bandwidth="150000"/>
    </AdaptationSet>
  </Period>
</MPD>`);
		const neutral = neutralizeWatermarking()(mpd);
		if (neutral.format !== 'dash') {
			throw new Error('expected a DASH manifest');
		}
		const sets = neutral.mpd.periods[0]!.adaptationSets;
		expect(sets.length).toBe(1);
		expect(sets[0]!.essentialProperties).toEqual([]);
		expect(sets[0]!.representations[0]!.essentialProperties).toEqual([]);
		expect(serializeManifest(neutral)).not.toContain('watermarking_');
	});

	test('leaves a manifest with no watermarking signalling untouched by reference', () => {
		const plain = parseManifest([
			'#EXTM3U',
			'#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.42e00a"',
			'v.m3u8',
			'',
		].join('\n'));
		expect(neutralizeWatermarking()(plain)).toBe(plain);
	});
});

describe('WMPaceInfo SEI carrier', () => {
	test('the UUID is the one the specification assigns', () => {
		expect([...WM_PACE_INFO_SEI_UUID].map(b => b.toString(16).padStart(2, '0')).join(''))
			.toBe('bec4f824170d47cfa826ce008083e355');
	});

	for (const codec of ['avc', 'hevc'] as const) {
		test(`round-trips through an ${codec} SEI NAL unit`, () => {
			const nalUnit = wmPaceInfoSeiNalUnit(SPEC_EXAMPLE, codec);
			expect(readWmPaceInfoSei(nalUnit, codec)).toEqual(SPEC_EXAMPLE);
		});

		test(`carries the UUID and payload inside the ${codec} NAL unit`, () => {
			const nalUnit = wmPaceInfoSeiNalUnit(SPEC_EXAMPLE, codec);
			const hex = [...nalUnit].map(b => b.toString(16).padStart(2, '0')).join('');
			expect(hex).toContain('bec4f824170d47cfa826ce008083e355');
			// payloadType 5, payloadSize 22 (16 UUID + 6 WMPaceInfo), immediately before the UUID.
			expect(hex).toContain('0516bec4f824');
		});
	}

	test('a position needing an escape byte still round-trips', () => {
		// pos = 0 puts 0x00 0x00 next to each other, which emulation prevention has to escape.
		const zeroed: WmPaceInfo = { ...SPEC_EXAMPLE, variant: 0, position: 0, partCount: 0 };
		const nalUnit = wmPaceInfoSeiNalUnit(zeroed, 'avc');
		expect(readWmPaceInfoSei(nalUnit, 'avc')).toEqual(zeroed);
	});

	test('an SEI under a different UUID reads as null', () => {
		const nalUnit = wmPaceInfoSeiNalUnit(SPEC_EXAMPLE, 'avc');
		const foreign = nalUnit.slice();
		// Corrupt the UUID wherever it sits, leaving the framing intact.
		const at = foreign.findIndex((_, i) => foreign[i] === 0xbe && foreign[i + 1] === 0xc4);
		expect(at).toBeGreaterThan(-1);
		foreign[at] = 0x00;
		expect(readWmPaceInfoSei(foreign, 'avc')).toBeNull();
	});
});

describe('WMPaceInfo MPEG-TS adaptation field descriptor', () => {
	test('lays out tag, length and the 48-bit structure', () => {
		const descriptor = wmPaceInfoTsDescriptor(SPEC_EXAMPLE, 0x42);
		expect([...descriptor]).toEqual([0x42, 0x06, 0x01, 0x00, 0x80, 0x21, 0xe0, 0x01]);
	});

	test('round-trips under the agreed tag only', () => {
		const descriptor = wmPaceInfoTsDescriptor(SPEC_EXAMPLE, 0x42);
		expect(readWmPaceInfoTsDescriptor(descriptor, 0x42)).toEqual(SPEC_EXAMPLE);
		// A descriptor carrying someone else's tag is not ours to decode.
		expect(readWmPaceInfoTsDescriptor(descriptor, 0x43)).toBeNull();
	});

	test('rejects a tag outside a byte, and a truncated descriptor', () => {
		expect(() => wmPaceInfoTsDescriptor(SPEC_EXAMPLE, 256)).toThrow(TypeError);
		expect(readWmPaceInfoTsDescriptor(new Uint8Array([0x42, 0x06, 0x01]), 0x42)).toBeNull();
	});
});

describe('zero-padding WMPaceInfo for egress', () => {
	const styp = new Uint8Array([0, 0, 0, 12, 0x73, 0x74, 0x79, 0x70, 0x63, 0x6d, 0x66, 0x63]);

	const segmentWithBox = () => {
		const box = wmPaceInfoBox(SPEC_EXAMPLE);
		const segment = new Uint8Array(styp.length + box.length + styp.length);
		segment.set(styp, 0);
		segment.set(box, styp.length);
		segment.set(styp, styp.length + box.length);
		return { segment, boxAt: styp.length, boxLength: box.length };
	};

	test('zeroes the payload without moving a single byte', () => {
		const { segment, boxAt, boxLength } = segmentWithBox();
		const padded = zeroPadWmPaceInfo(segment);

		// Removing the box would shift everything after it and break byte ranges and sidx.
		expect(padded.length).toBe(segment.length);
		expect([...padded.subarray(0, boxAt)]).toEqual([...segment.subarray(0, boxAt)]);
		expect([...padded.subarray(boxAt + boxLength)]).toEqual([...segment.subarray(boxAt + boxLength)]);

		// The box header survives, so the file still parses; only its contents are gone.
		expect([...padded.subarray(boxAt, boxAt + 8)]).toEqual([...segment.subarray(boxAt, boxAt + 8)]);
		expect([...padded.subarray(boxAt + 8, boxAt + boxLength)]).toEqual([0, 0, 0, 0, 0, 0]);
	});

	test('the metadata is no longer readable, and reads as absent rather than malformed', () => {
		const { segment } = segmentWithBox();
		expect(readWmPaceInfo(segment)).toEqual(SPEC_EXAMPLE);
		expect(readWmPaceInfo(zeroPadWmPaceInfo(segment))).toBeNull();
	});

	test('leaves the caller’s bytes alone and passes through a segment with no box', () => {
		const { segment } = segmentWithBox();
		const before = segment.slice();
		zeroPadWmPaceInfo(segment);
		expect([...segment]).toEqual([...before]);
		expect([...zeroPadWmPaceInfo(styp)]).toEqual([...styp]);
	});

	test('survives a 64-bit largesize box in the walk', () => {
		const large = new Uint8Array(16 + 4);
		new DataView(large.buffer).setUint32(0, 1);
		large.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
		new DataView(large.buffer).setBigUint64(8, BigInt(large.length));
		const box = wmPaceInfoBox(SPEC_EXAMPLE);
		const segment = new Uint8Array(large.length + box.length);
		segment.set(large, 0);
		segment.set(box, large.length);

		expect(readWmPaceInfo(zeroPadWmPaceInfo(segment))).toBeNull();
		expect([...zeroPadWmPaceInfo(segment).subarray(0, large.length)]).toEqual([...large]);
	});
});

describe('variant byte-range alignment', () => {
	const fragmentedFrom = async (file: string, options: { width?: number } = {}) => {
		const source = new BufferSource(new Uint8Array(
			readFileSync(path.join(__dirname, '..', 'public', file)),
		));
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({
			input: new Input({ source, formats: ALL_FORMATS }),
			output,
			...(options.width === undefined ? {} : { video: { width: options.width } }),
		})).execute();
		return new Uint8Array(output.target.buffer!);
	};

	test('a variant patched in place is aligned with the original', async () => {
		const neutral = await fragmentedFrom('video.mp4');
		// What a watermark embedder produces: same structure, different payload bytes.
		const variant = neutral.slice();
		for (let i = 0; i < 20; i++) {
			const at = Math.floor(neutral.length * (0.4 + i * 0.02));
			variant[at] = variant[at]! ^ 0x5a;
		}
		expect(variantsAligned(neutral, variant)).toEqual({ aligned: true, reason: null, segmentIndex: null });
	});

	/** Grow one segment's `mdat` by 16 bytes, keeping the file valid but moving every later offset. */
	const growSegmentMdat = (bytes: Uint8Array, segmentIndex: number) => {
		const layout = segmentsOf(bytes);
		const segment = layout.segments[segmentIndex]!;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let at = segment.offset;
		while (at + 8 <= segment.offset + segment.size) {
			const size = view.getUint32(at);
			const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
			if (type === 'mdat') {
				const out = new Uint8Array(bytes.length + 16);
				out.set(bytes.subarray(0, at), 0);
				out.set(bytes.subarray(at, at + size), at);
				new DataView(out.buffer).setUint32(at, size + 16);
				out.set(bytes.subarray(at + size), at + size + 16);
				return out;
			}
			if (size < 8) {
				break;
			}
			at += size;
		}
		throw new Error('no mdat in that segment');
	};

	test('a variant whose segments move is caught at the first one, with the init identical', async () => {
		const neutral = await fragmentedFrom('video.mp4');
		const shifted = growSegmentMdat(neutral, 1);

		const before = segmentsOf(neutral);
		const after = segmentsOf(shifted);
		// The point of this fixture: only the segment layout differs, so the per-segment comparison
		// is the only check that can catch it.
		expect(after.init).toEqual(before.init);
		expect(after.segments.length).toBe(before.segments.length);

		const result = variantsAligned(neutral, shifted);
		expect(result.aligned).toBe(false);
		expect(result.segmentIndex).toBe(1);
		expect(result.reason).toMatch(/^segment 1 differs/);
	});

	test('a re-encoded variant is caught, and the first divergence is named', async () => {
		const neutral = await fragmentedFrom('video.mp4');
		const reEncoded = await fragmentedFrom('video.mp4', { width: 160 });

		const result = variantsAligned(neutral, reEncoded);
		expect(result.aligned).toBe(false);
		expect(result.reason).toBeTruthy();
		// This is the failure that otherwise serves the right byte count from the wrong places.
		expect(result.reason).toMatch(/^init segments differ/);
	});

	test('a truncated rendition differs in segment count, not silently', async () => {
		const neutral = await fragmentedFrom('video.mp4');
		const layout = segmentsOf(neutral);
		if (layout.segments.length < 2) {
			throw new Error('fixture needs at least two segments to truncate one');
		}
		const last = layout.segments[layout.segments.length - 1]!;
		const short = neutral.subarray(0, last.offset);

		const result = variantsAligned(neutral, short);
		expect(result.aligned).toBe(false);
		expect(result.reason).toMatch(/segment counts differ/);
	});

	/** A version-0 `sidx` box with one reference, so two renditions can differ only in their index. */
	const sidxBox = (subsegmentDuration: number, referencedSize: number) => {
		const box = new Uint8Array(8 + 24 + 12);
		const view = new DataView(box.buffer);
		view.setUint32(0, box.length);
		box.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'
		view.setUint32(8, 0); // version 0, no flags
		view.setUint32(12, 1); // reference_ID
		view.setUint32(16, 90000); // timescale
		view.setUint32(20, 0); // earliest_presentation_time
		view.setUint32(24, 0); // first_offset
		view.setUint16(28, 0); // reserved
		view.setUint16(30, 1); // reference_count
		view.setUint32(32, referencedSize & 0x7fffffff); // reference_type 0 + referenced_size
		view.setUint32(36, subsegmentDuration);
		view.setUint32(40, 0x90000000); // starts_with_SAP = 1, SAP type 1
		return box;
	};

	/** Splice a box in after the init, so both renditions keep an identical segment layout. */
	const withSidx = (bytes: Uint8Array, sidx: Uint8Array) => {
		const layout = segmentsOf(bytes);
		const at = layout.init!.offset + layout.init!.size;
		const out = new Uint8Array(bytes.length + sidx.length);
		out.set(bytes.subarray(0, at), 0);
		out.set(sidx, at);
		out.set(bytes.subarray(at), at + sidx.length);
		return out;
	};

	test('two renditions whose sidx disagrees are caught, with the layout identical', async () => {
		const neutral = await fragmentedFrom('video.mp4');
		const a = withSidx(neutral, sidxBox(1000, 5000));
		const b = withSidx(neutral, sidxBox(2000, 5000));

		// Same box size at the same offset, so every segment range matches and only the index differs.
		expect(b.length).toBe(a.length);
		expect(segmentsOf(a).segments.map(x => [x.offset, x.size]))
			.toEqual(segmentsOf(b).segments.map(x => [x.offset, x.size]));

		expect(variantsAligned(a, a)).toEqual({ aligned: true, reason: null, segmentIndex: null });
		const result = variantsAligned(a, b);
		expect(result.aligned).toBe(false);
		expect(result.reason).toMatch(/sidx 0 reference 0 differs/);
	});

	test('a rendition that does not parse is answered, not thrown', async () => {
		const neutral = await fragmentedFrom('video.mp4');
		const layout = segmentsOf(neutral);
		const second = layout.segments[1]!;
		// Drop a byte inside the second segment: everything after it shifts.
		const shifted = new Uint8Array(neutral.length - 1);
		shifted.set(neutral.subarray(0, second.offset), 0);
		shifted.set(neutral.subarray(second.offset + 1), second.offset);

		// Dropping a byte corrupts the box structure rather than merely moving boundaries, and a
		// verification call on publisher bytes has to answer "no" rather than throw.
		const result = variantsAligned(neutral, shifted);
		expect(result.aligned).toBe(false);
		expect(result.reason).toMatch(/could not be read/);
	});
});

describe('reading a segment regardless of carrier', () => {
	test('finds it in the wmpi box', () => {
		const styp = new Uint8Array([0, 0, 0, 12, 0x73, 0x74, 0x79, 0x70, 0x63, 0x6d, 0x66, 0x63]);
		const box = wmPaceInfoBox(SPEC_EXAMPLE);
		const segment = new Uint8Array(box.length + styp.length);
		segment.set(box, 0);
		segment.set(styp, box.length);
		expect(readSegmentWmPaceInfo(segment)).toEqual(SPEC_EXAMPLE);
	});

	test('finds it in an SEI message with no box present', () => {
		const sei = wmPaceInfoSeiNalUnit(SPEC_EXAMPLE, 'avc');
		// Embedded the way it travels: inside other bytes, with no wmpi box anywhere.
		const segment = new Uint8Array(64 + sei.length + 64);
		segment.set(sei, 64);
		expect(readWmPaceInfo(segment)).toBeNull();
		expect(readSegmentWmPaceInfo(segment)).toEqual(SPEC_EXAMPLE);
	});

	test('un-escapes an SEI payload that needed emulation prevention', () => {
		// pos 0 and partCount 0 put zero bytes together, which the NAL escape splits.
		const zeroed: WmPaceInfo = { watermarked: true, variant: 0, position: 0, firstPart: true, partCount: 0 };
		const sei = wmPaceInfoSeiNalUnit(zeroed, 'hevc');
		const segment = new Uint8Array(16 + sei.length);
		segment.set(sei, 16);
		expect(readSegmentWmPaceInfo(segment)).toEqual(zeroed);
	});

	test('a segment carrying neither reads as null', () => {
		expect(readSegmentWmPaceInfo(new Uint8Array(256).fill(0x42))).toBeNull();
	});

	test('a zero-padded segment reads as null rather than as metadata', () => {
		const box = wmPaceInfoBox(SPEC_EXAMPLE);
		expect(readSegmentWmPaceInfo(zeroPadWmPaceInfo(box))).toBeNull();
	});
});

describe('reading every segment for a byterange sidecar', () => {
	test('reports one entry per segment plus the init, in order', async () => {
		const source = new BufferSource(new Uint8Array(
			readFileSync(path.join(__dirname, '..', 'public', 'video.mp4')),
		));
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({ input: new Input({ source, formats: ALL_FORMATS }), output })).execute();
		const frag = new Uint8Array(output.target.buffer!);

		const entries = readAllWmPaceInfo(frag);
		const layout = segmentsOf(frag);
		expect(entries.length).toBe(layout.segments.length + 1);
		// Contiguous and in order, which is what the sidecar's ranges require.
		expect(entries[0]!.offset).toBe(layout.init!.offset);
		for (let i = 1; i < entries.length; i++) {
			expect(entries[i]!.offset).toBeGreaterThan(entries[i - 1]!.offset);
		}
		// This file carries no watermarking, so every entry is null rather than absent.
		expect(entries.every(e => e.wmPaceInfo === null)).toBe(true);

		// The ranges feed serializeWmSidecar directly.
		const sidecar = JSON.parse(serializeWmSidecar({
			segmentType: 'byterange',
			variantSubPaths: [{ variant: 0, subPath: 'a' }],
			segments: entries.map(e => ({
				startRange: e.offset,
				endRange: e.offset + e.size - 1,
				wmPaceInfo: e.wmPaceInfo
					?? { watermarked: false, variant: 0, position: 0, firstPart: true, partCount: 1 },
			})),
		})) as { segments: { startRange: number; endRange: number }[] };
		expect(sidecar.segments.length).toBe(entries.length);
		expect(sidecar.segments[0]!.startRange).toBe(layout.init!.offset);
	});
});

describe('mpd() suggestedPresentationDelay', () => {
	test('is omitted when absent and emitted when given', () => {
		const periods = [mpdPeriod({ id: 'p0', adaptationSets: [] })];

		const without = mpd({ type: 'dynamic', periods });
		expect(without.suggestedPresentationDelay).toBeNull();
		expect(serializeMpd(without)).not.toContain('suggestedPresentationDelay');

		// Three target durations, which is what an HLS player is handed by default.
		const withDelay = mpd({ type: 'dynamic', periods, suggestedPresentationDelay: 6 });
		expect(withDelay.suggestedPresentationDelay).toBe(6);
		expect(serializeMpd(withDelay)).toContain('suggestedPresentationDelay="PT6S"');
	});
});

describe('encrypting a variant as a unit', () => {
	const KEY2 = new Uint8Array(16).fill(7);
	const KID2 = new Uint8Array(16).fill(3);
	const BASE2 = new Uint8Array(8).fill(1);

	const fragment = async () => {
		const source = new BufferSource(new Uint8Array(
			readFileSync(path.join(__dirname, '..', 'public', 'video.mp4')),
		));
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({ input: new Input({ source, formats: ALL_FORMATS }), output })).execute();
		const bytes = new Uint8Array(output.target.buffer!);
		const layout = segmentsOf(bytes);
		return {
			init: bytes.subarray(layout.init!.offset, layout.init!.offset + layout.init!.size),
			segments: layout.segments.map(s => bytes.subarray(s.offset, s.offset + s.size)),
		};
	};

	for (const scheme of ['cenc', 'cbcs'] as const) {
		test(`${scheme}: matches pairing the calls by hand, and both variants decrypt under one key`, async () => {
			const { init, segments } = await fragment();
			const shared = { key: KEY2, kid: KID2, scheme };

			const byHand = encryptCmafInit(init, { ...shared, iv: variantIv(BASE2, 1) });
			const ivState: WmVariantIvState = new Map();
			const handSegments = segments.map(s =>
				encryptVariantSegment(byHand, s, { ...shared, baseIv: BASE2, variant: 1, ivState }));

			const encryptor = variantEncryptor(init, { ...shared, baseIv: BASE2, variant: 1 });
			const unitSegments = segments.map(s => encryptor.encryptSegment(s));

			expect([...encryptor.init]).toEqual([...byHand]);
			expect(unitSegments.map(s => [...s])).toEqual(handSegments.map(s => [...s]));
		});
	}

	test('two variants get different keystreams without the caller pairing anything', async () => {
		const { init, segments } = await fragment();
		const shared = { key: KEY2, kid: KID2, scheme: 'cenc' as const, baseIv: BASE2 };

		const a = variantEncryptor(init, { ...shared, variant: 0 });
		const b = variantEncryptor(init, { ...shared, variant: 1 });
		const first = segments[0]!;

		// Same plaintext, different variants: the ciphertexts must not coincide anywhere much.
		const encA = a.encryptSegment(first);
		const encB = b.encryptSegment(first);
		let differing = 0;
		for (let i = 0; i < Math.min(encA.length, encB.length); i++) {
			if (encA[i] !== encB[i]) {
				differing++;
			}
		}
		expect(differing).toBeGreaterThan(encA.length / 4);

		// Under cenc the init states an IV size rather than an IV, so every variant's init is the
		// same bytes — there is nothing there to pair wrongly. cbcs is the opposite.
		expect([...a.init]).toEqual([...b.init]);
		const cbcsA = variantEncryptor(init, { key: KEY2, kid: KID2, scheme: 'cbcs', baseIv: BASE2, variant: 0 });
		const cbcsB = variantEncryptor(init, { key: KEY2, kid: KID2, scheme: 'cbcs', baseIv: BASE2, variant: 1 });
		expect([...cbcsA.init]).not.toEqual([...cbcsB.init]);
	});

	test('the init it produces is the one its segments were encrypted against', async () => {
		const { init, segments } = await fragment();
		// cbcs is where a mismatched init is detectable, so it is the one that can assert this.
		const encryptor = variantEncryptor(init, {
			key: KEY2, kid: KID2, scheme: 'cbcs', baseIv: BASE2, variant: 2,
		});
		expect(() => encryptor.encryptSegment(segments[0]!)).not.toThrow();

		// The same segments against a different variant's init must still be refused.
		const other = variantEncryptor(init, {
			key: KEY2, kid: KID2, scheme: 'cbcs', baseIv: BASE2, variant: 3,
		});
		const ivState: WmVariantIvState = new Map();
		expect(() => encryptVariantSegment(other.init, segments[0]!, {
			key: KEY2, kid: KID2, scheme: 'cbcs', baseIv: BASE2, variant: 2, ivState,
		})).toThrow(/one init segment per variant/);
	});
});

describe('deriving a layout without materialising the rendition', () => {
	const fragmentedBytes = async (options: { width?: number } = {}) => {
		const source = new BufferSource(new Uint8Array(
			readFileSync(path.join(__dirname, '..', 'public', 'video.mp4')),
		));
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({
			input: new Input({ source, formats: ALL_FORMATS }),
			output,
			...(options.width === undefined ? {} : { video: { width: options.width } }),
		})).execute();
		return new Uint8Array(output.target.buffer!);
	};

	test('the streamed layout matches what the in-memory walk finds', async () => {
		const bytes = await fragmentedBytes();
		const layout = await variantLayoutOf(new BufferSource(bytes));
		const file = segmentsOf(bytes);

		// If these drift, the cheap check and the format's own stop agreeing — which is the whole
		// risk of having two paths.
		expect(layout.init).toEqual(file.init);
		expect(layout.segments).toEqual(file.segments.map(s => ({ offset: s.offset, size: s.size })));
	});

	test('folds a segment prelude in exactly as the in-memory walk does', async () => {
		const bytes = await fragmentedBytes();
		const first = segmentsOf(bytes).segments[0]!;
		// A `styp` before the first `moof` belongs to the segment ahead of it, so both walks must
		// start that segment at the styp rather than at the moof.
		const styp = new Uint8Array([0, 0, 0, 12, 0x73, 0x74, 0x79, 0x70, 0x63, 0x6d, 0x66, 0x63]);
		const withPrelude = new Uint8Array(bytes.length + styp.length);
		withPrelude.set(bytes.subarray(0, first.offset), 0);
		withPrelude.set(styp, first.offset);
		withPrelude.set(bytes.subarray(first.offset), first.offset + styp.length);

		const layout = await variantLayoutOf(new BufferSource(withPrelude));
		const file = segmentsOf(withPrelude);
		expect(layout.segments).toEqual(file.segments.map(x => ({ offset: x.offset, size: x.size })));
		expect(layout.segments[0]!.offset).toBe(first.offset);
	});

	test('a styp opens each segment, so fragments after the first do not merge', async () => {
		const bytes = await fragmentedBytes();
		const styp = new Uint8Array([0, 0, 0, 12, 0x73, 0x74, 0x79, 0x70, 0x63, 0x6d, 0x66, 0x63]);
		// One styp before every moof, which is what a CMAF segmenter emits.
		const before = segmentsOf(bytes).segments.map(x => x.offset);
		let out = bytes;
		for (let i = before.length - 1; i >= 0; i--) {
			const at = before[i]! + i * 0;
			const next = new Uint8Array(out.length + styp.length);
			next.set(out.subarray(0, at), 0);
			next.set(styp, at);
			next.set(out.subarray(at), at + styp.length);
			out = next;
		}

		const layout = await variantLayoutOf(new BufferSource(out));
		const file = segmentsOf(out);
		expect(file.segments.length).toBe(before.length);
		expect(layout.segments).toEqual(file.segments.map(x => ({ offset: x.offset, size: x.size })));
	});

	test('reads far less than the rendition to do it', async () => {
		const bytes = await fragmentedBytes();
		let bytesRead = 0;
		class CountingSource extends BufferSource {
			override async readRange(start: number, end: number) {
				bytesRead += end - start;
				return super.readRange(start, end);
			}
		}
		await variantLayoutOf(new CountingSource(bytes));
		expect(bytesRead).toBeGreaterThan(0);
		expect(bytesRead).toBeLessThan(bytes.length / 2);
	});

	test('sourcesAligned agrees with variantsAligned on the same pair', async () => {
		const neutral = await fragmentedBytes();
		const patched = neutral.slice();
		for (let i = 0; i < 20; i++) {
			const at = Math.floor(neutral.length * (0.4 + i * 0.02));
			patched[at] = patched[at]! ^ 0x5a;
		}
		const reEncoded = await fragmentedBytes({ width: 160 });

		for (const [a, b] of [[neutral, patched], [neutral, reEncoded]] as const) {
			const fromBytes = variantsAligned(a, b);
			const fromSources = await sourcesAligned(new BufferSource(a), new BufferSource(b));
			expect(fromSources).toEqual(fromBytes);
		}
	});

	test('survives the caller freeing its last ref while the walk is in flight', async () => {
		const bytes = await fragmentedBytes();
		// A source whose reads do not settle until released, so the free lands mid-walk.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		class GatedSource extends BufferSource {
			override async readRange(start: number, end: number) {
				if (++reads === 2) {
					await gate;
				}
				return super.readRange(start, end);
			}
		}

		const source = new GatedSource(bytes);
		const callerRef = source.ref();
		const walk = variantLayoutOf(source);

		// The caller is done with the source and lets go of what it believes is the only ref.
		await Promise.resolve();
		callerRef.free();
		release();

		// Without a ref of its own the source would be disposed here and the next read would throw.
		const layout = await walk;
		expect(layout.segments).toEqual(
			segmentsOf(bytes).segments.map(x => ({ offset: x.offset, size: x.size })),
		);
	});

	test('a corrupt rendition is answered, not thrown, on the streaming path too', async () => {
		const bytes = await fragmentedBytes();
		const corrupt = bytes.slice();
		// A box length that cannot fit, which is what the peer's flipped fixture produced.
		new DataView(corrupt.buffer).setUint32(segmentsOf(bytes).segments[0]!.offset, 0xfffffff0);

		const result = await sourcesAligned(new BufferSource(bytes), new BufferSource(corrupt));
		expect(result.aligned).toBe(false);
		expect(result.reason).toMatch(/could not be read/);
	});
});

describe('the whole pipeline, as a packager would run it', () => {
	const KEY3 = new Uint8Array(16).fill(7);
	const KID3 = new Uint8Array(16).fill(3);
	const BASE3 = new Uint8Array(8).fill(1);

	const fragment = async (width?: number) => {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({
			input: new Input({
				source: new BufferSource(new Uint8Array(
					readFileSync(path.join(__dirname, '..', 'public', 'video.mp4')),
				)),
				formats: ALL_FORMATS,
			}),
			output,
			...(width === undefined ? {} : { video: { width } }),
		})).execute();
		return new Uint8Array(output.target.buffer!);
	};

	/** What a compressed-domain embedder produces: payload bytes changed, structure untouched. */
	const patchPayload = (bytes: Uint8Array) => {
		const out = bytes.slice();
		for (let i = 0; i < 20; i++) {
			const at = Math.floor(out.length * (0.4 + i * 0.02));
			out[at] = out[at]! ^ 0x5a;
		}
		return out;
	};

	const join = (parts: Uint8Array[]) => {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	};

	const encryptVariant = (bytes: Uint8Array, variant: number, scheme: 'cenc' | 'cbcs') => {
		const layout = segmentsOf(bytes);
		const encryptor = variantEncryptor(
			bytes.subarray(layout.init!.offset, layout.init!.offset + layout.init!.size),
			{ key: KEY3, kid: KID3, baseIv: BASE3, variant, scheme },
		);
		const segments = layout.segments.map(s =>
			encryptor.encryptSegment(bytes.subarray(s.offset, s.offset + s.size)));
		return { init: encryptor.init, segments, whole: join([encryptor.init, ...segments]) };
	};

	for (const scheme of ['cenc', 'cbcs'] as const) {
		test(`${scheme}: patched variants survive encryption aligned, and a re-encode does not`, async () => {
			const neutral = await fragment();
			const patched = patchPayload(neutral);

			// Alignment had only ever been checked on clear renditions; encryption inserts
			// senc/saiz/saio, so whether it survives is a separate question from whether it holds.
			expect(variantsAligned(neutral, patched).aligned).toBe(true);

			const a = encryptVariant(neutral, 0, scheme);
			const b = encryptVariant(patched, 1, scheme);
			expect(variantsAligned(a.whole, b.whole).aligned).toBe(true);

			// The control: the guard must still catch the mistake it exists for, post-encryption.
			const reEncoded = await fragment(160);
			const c = encryptVariant(reEncoded, 1, scheme);
			expect(variantsAligned(a.whole, c.whole).aligned).toBe(false);
		});
	}

	test('a patch that breaks slice headers fails encryption loudly, not silently misaligned', async () => {
		const neutral = await fragment();
		const broken = neutral.slice();
		const view = new DataView(broken.buffer);
		let touched = 0;
		for (const segment of segmentsOf(neutral).segments) {
			let at = segment.offset;
			while (at + 8 <= segment.offset + segment.size) {
				const size = view.getUint32(at);
				if (size < 8) {
					break;
				}
				const type = String.fromCharCode(broken[at + 4]!, broken[at + 5]!, broken[at + 6]!, broken[at + 7]!);
				if (type === 'mdat') {
					let p = at + 8;
					while (p + 4 < at + size) {
						const length = view.getUint32(p);
						if (length === 0 || p + 4 + length > at + size) {
							break;
						}
						broken[p + 5] = broken[p + 5]! ^ 0xff;
						touched++;
						p += 4 + length;
					}
				}
				at += size;
			}
		}
		expect(touched).toBeGreaterThan(0);

		// Structurally still aligned, so the alignment guard alone would pass it.
		expect(variantsAligned(neutral, broken).aligned).toBe(true);
		// Encryption is what refuses it, which is the behaviour to keep: a variant whose headers
		// no longer parse must not be encrypted into something that merely looks right.
		expect(() => encryptVariant(broken, 1, 'cenc')).toThrow(/slice header/);
	});

	test('ingest signalling, neutral egress, sidecar and zero-padded delivery', async () => {
		const neutral = await fragment();
		const patched = patchPayload(neutral);
		const a = encryptVariant(neutral, 0, 'cenc');
		const b = encryptVariant(patched, 1, 'cenc');

		// 1. The transcoder's pace info, attached to each variant's first segment.
		const paceInfo: WmPaceInfo = {
			watermarked: true, variant: 0, position: 7, firstPart: true, partCount: 1,
		};
		const carried = join([wmPaceInfoBox(paceInfo), a.segments[0]!]);
		expect(readSegmentWmPaceInfo(carried)).toEqual(paceInfo);

		// 2. The ingest master playlist names both variants.
		const ingest = parseManifest([
			'#EXTM3U',
			'#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.4d401f",WATERMARKING-VARIANT="a"',
			'a/video.m3u8',
			'#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.4d401f",WATERMARKING-VARIANT="b"',
			'b/video.m3u8',
			'',
		].join('\n'));
		if (ingest.format !== 'hls' || ingest.playlist.kind !== 'master') {
			throw new Error('expected an HLS master playlist');
		}
		expect(ingest.playlist.variants.map(v => v.watermarkingVariant)).toEqual(['a', 'b']);

		// 3. Egress is neutral: one entry, naming no variant.
		const egress = neutralizeWatermarking()(ingest);
		if (egress.format !== 'hls' || egress.playlist.kind !== 'master') {
			throw new Error('expected an HLS master playlist');
		}
		expect(egress.playlist.variants.length).toBe(1);
		expect(serializeManifest(egress)).not.toContain('WATERMARKING-VARIANT');

		// 4. The sidecar the edge fetches, built from the variant's own ranges.
		const entries = readAllWmPaceInfo(b.whole);
		const sidecar = JSON.parse(serializeWmSidecar({
			segmentType: 'byterange',
			variantSubPaths: [{ variant: 0, subPath: 'a' }, { variant: 1, subPath: 'b' }],
			segments: entries.map(entry => ({
				startRange: entry.offset,
				endRange: entry.offset + entry.size - 1,
				wmPaceInfo: entry.wmPaceInfo ?? { ...paceInfo, watermarked: false, position: 0 },
			})),
		})) as { variantSubPaths: unknown[]; segments: { startRange: number }[] };
		expect(sidecar.variantSubPaths.length).toBe(2);
		expect(sidecar.segments.length).toBe(entries.length);

		// 5. What reaches the device carries no pace info, with every byte still in place.
		const served = zeroPadWmPaceInfo(carried);
		expect(served.length).toBe(carried.length);
		expect(readSegmentWmPaceInfo(served)).toBeNull();
	});
});
