/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `nuh_layer_id` straddles the byte boundary in the HEVC NAL unit header (H.265 7.3.1.2) - one bit at
// the end of the first byte, five at the start of the second - so the fixtures here are built bit by
// bit from the syntax rather than copied from a file. No encoder in this toolchain produces MV-HEVC,
// so a real stereo bitstream is not available to check against; what is checked is that the field is
// read exactly as the syntax defines it, including the cases where a wrong shift still looks plausible.
//
// A real HEVC packet from a real file is used as the control for the base-layer case, which is the one
// a fixture could get wrong without anyone noticing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import {
	buildLhvcConfigRecord,
	buildVexuBox,
	extractLayerIdForHevc,
	extractTemporalIdForHevc,
	lhvcConfigFromBitstream,
	vexuInfoFromVpsExtension,
	inspectHevcLayers,
	parseHevcVpsExtension,
	parseHvccConfigRecord,
	parseLhvcConfigRecord,
	parseVexuBox,
} from '../../src/mvhevc.js';
import {
	doviCodecString,
	doviConfigBoxName,
	parseDoviConfigRecord,
	serializeDoviConfigRecord,
} from '../../src/dovi.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { bytesToHexString } from '../../src/misc.js';
import { extractNalUnitTypeForHevc, iterateHevcNalUnits } from '../../src/codec-data.js';

/**
 * The base layer's `hvcC`, from the same Apple spatial example as the `lhvC` below it. Real rather
 * than hand-made: `numOfArrays` sits at octet 22, and a fixture that got the header length wrong
 * would make the parser look broken while it was right.
 */
const HVCC_BASE = '010220000000b000000000005df000fcfdfafa00000b04a00001003c40010c11ffff0220000003'
	+ '00b0000003000003005d15c15b5d200028245970602000000bd8000003000005d8d02f002f0a44c52b'
	+ 'f708500808080080a100010024420101022000000300b0000003000003005da005e200bc4d8815ee45'
	+ '95602d4040404020a2000100074401c02cbc14c9a7000100094e01b004040d002080';

/** A NAL unit header, built from the syntax: type, layer and temporal id into two bytes. */
const nalHeader = (type: number, layerId: number, temporalId: number) => [
	((type & 0x3f) << 1) | ((layerId >> 5) & 0x01),
	((layerId & 0x1f) << 3) | ((temporalId + 1) & 0x07),
];

/** Length-prefixed NAL units, which is how a packet out of an MP4 is laid out. */
const lengthPrefixed = (units: number[][]) => {
	const out: number[] = [];
	for (const unit of units) {
		out.push(0, 0, 0, unit.length, ...unit);
	}
	return new Uint8Array(out);
};

/** A decoder config with a description, which is what makes the iterator read length prefixes. */
const CONFIG = { codec: 'hvc1.1.6.L93.B0', description: new Uint8Array(23).fill(0) } as VideoDecoderConfig;

test('the layer id is read exactly as the syntax lays it out', () => {
	// Every value that distinguishes a correct read from a plausible wrong one
	expect(extractLayerIdForHevc(...nalHeader(1, 0, 0) as [number, number])).toBe(0);
	expect(extractLayerIdForHevc(...nalHeader(1, 1, 0) as [number, number])).toBe(1);

	// 31 fits in the second byte's five bits alone; 32 needs the bit carried from the first byte, and
	// an implementation that forgot that bit reads 32 as 0 and 63 as 31
	expect(extractLayerIdForHevc(...nalHeader(1, 31, 0) as [number, number])).toBe(31);
	expect(extractLayerIdForHevc(...nalHeader(1, 32, 0) as [number, number])).toBe(32);
	expect(extractLayerIdForHevc(...nalHeader(1, 63, 0) as [number, number])).toBe(63);

	// And the temporal id shares the second byte with it, so neither may bleed into the other
	for (const temporalId of [0, 1, 6]) {
		const [a, b] = nalHeader(1, 37, temporalId);
		expect(extractLayerIdForHevc(a!, b!), `layer 37 at temporal ${temporalId}`).toBe(37);
		expect(extractTemporalIdForHevc(b!), `temporal ${temporalId} at layer 37`).toBe(temporalId);
	}
});

test('a single-layer packet is not reported as layered', () => {
	const packet = lengthPrefixed([
		[...nalHeader(32, 0, 0), 0x01], // VPS
		[...nalHeader(33, 0, 0), 0x02], // SPS
		[...nalHeader(1, 0, 0), 0x03], // TRAIL_R slice
	]);

	expect(inspectHevcLayers(packet, CONFIG)).toEqual({
		layerIds: [0],
		isLayered: false,
		highestTemporalId: 0,
	});
});

test('a second view on layer 1 is what makes a bitstream layered', () => {
	const packet = lengthPrefixed([
		[...nalHeader(32, 0, 0), 0x01], // VPS, base layer
		[...nalHeader(33, 0, 0), 0x02], // SPS, base layer
		[...nalHeader(1, 0, 0), 0x03], // base view slice
		[...nalHeader(33, 1, 0), 0x04], // SPS for the second view
		[...nalHeader(1, 1, 0), 0x05], // second view slice
	]);

	const info = inspectHevcLayers(packet, CONFIG);
	expect(info.layerIds).toEqual([0, 1]);
	expect(info.isLayered, 'layer 1 is present, so this is not plain HEVC').toBe(true);

	// Dropping the layer-1 units leaves exactly the stream a decoder that ignores layers sees
	const baseOnly = lengthPrefixed([
		[...nalHeader(32, 0, 0), 0x01],
		[...nalHeader(33, 0, 0), 0x02],
		[...nalHeader(1, 0, 0), 0x03],
	]);
	expect(inspectHevcLayers(baseOnly, CONFIG).isLayered).toBe(false);
});

test('layers are reported in order and without duplicates, however they arrive', () => {
	const packet = lengthPrefixed([
		[...nalHeader(1, 2, 0), 0x01],
		[...nalHeader(1, 0, 0), 0x02],
		[...nalHeader(1, 2, 0), 0x03],
		[...nalHeader(1, 1, 0), 0x04],
		[...nalHeader(1, 0, 0), 0x05],
	]);

	expect(inspectHevcLayers(packet, CONFIG).layerIds).toEqual([0, 1, 2]);
});

test('the temporal sub-layer depth is the highest one present', () => {
	const packet = lengthPrefixed([
		[...nalHeader(1, 0, 0), 0x01],
		[...nalHeader(1, 0, 3), 0x02],
		[...nalHeader(1, 0, 1), 0x03],
	]);

	expect(inspectHevcLayers(packet, CONFIG).highestTemporalId).toBe(3);
});

test('a NAL unit too short to hold its own header is ignored, not misread', () => {
	// One byte of header: reading the second would run into the next unit's length prefix and could
	// report a layer that is not there
	const packet = new Uint8Array([0, 0, 0, 1, 0x02, 0, 0, 0, 3, ...nalHeader(1, 0, 0), 0x09]);

	expect(inspectHevcLayers(packet, CONFIG)).toEqual({
		layerIds: [0],
		isLayered: false,
		highestTemporalId: 0,
	});
});

test('a real HEVC packet reads as single-layer base video', async () => {
	// The control for the fixtures above: a packet from an actual file, which must come out as plain
	// HEVC. A reader that found layers here would be finding them in every ordinary stream.
	using input = new Input({
		source: new FilePathSource(new URL('../public/video-h265.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	expect(await track.getCodec()).toBe('hevc');
	const config = (await track.getDecoderConfig())!;

	let inspected = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		const info = inspectHevcLayers(packet.data, config);
		expect(info.layerIds, `packet ${inspected}`).toEqual([0]);
		expect(info.isLayered).toBe(false);
		if (++inspected === 20) {
			break;
		}
	}

	expect(inspected, 'the file had packets to inspect').toBe(20);
}, 60_000);

// `lhvC` is six octets and then NAL unit arrays laid out exactly as `hvcC`'s. That much is pinned by
// FFmpeg, which reads numOfArrays at octet 5 and appends these arrays onto hvcC's own list
// (libavformat/mov.c, mov_read_lhvc). The fields in between are pinned by GPAC, whose
// gf_odf_hevc_cfg_read_bs reads them under `is_lhvc`: reserved(4), min_spatial_segmentation_idc(12),
// reserved(6), parallelismType(2), reserved(2), numTemporalLayers(3), temporalIdNested(1),
// lengthSizeMinusOne(2), numOfArrays(8). Nothing in there is a complete_representation flag - that
// field belongs to AVC's svcC and mvcC - so the top bit of octet 1 is reserved and always set.

/** An `lhvC` payload: the six-octet header, then arrays in hvcC's format. */
const lhvcRecord = (
	header: {
		minSpatialSegmentationIdc: number;
		parallelismType: number;
		numTemporalLayers: number;
		temporalIdNested: boolean;
		lengthSizeMinusOne: number;
	},
	arrays: { complete: boolean; nalUnitType: number; nalUnits: number[][] }[],
) => {
	const out: number[] = [
		1, // configurationVersion
		0xf0 | ((header.minSpatialSegmentationIdc >> 8) & 0x0f),
		header.minSpatialSegmentationIdc & 0xff,
		0xfc | header.parallelismType,
		0xc0 | (header.numTemporalLayers << 3) | ((header.temporalIdNested ? 1 : 0) << 2)
		| header.lengthSizeMinusOne,
		arrays.length,
	];

	for (const array of arrays) {
		out.push((array.complete ? 0x80 : 0) | (array.nalUnitType & 0x3f));
		out.push((array.nalUnits.length >> 8) & 0xff, array.nalUnits.length & 0xff);
		for (const unit of array.nalUnits) {
			out.push((unit.length >> 8) & 0xff, unit.length & 0xff, ...unit);
		}
	}

	return new Uint8Array(out);
};

test('lhvC carries the parameter sets the base layer\'s hvcC does not', () => {
	// A VPS extension and an SPS for the second view, which is what a stereo track's lhvC holds
	const vpsForLayers = [...nalHeader(32, 0, 0), 0xaa, 0xbb];
	const spsForView1 = [...nalHeader(33, 1, 0), 0xcc];
	const ppsForView1 = [...nalHeader(34, 1, 0), 0xdd, 0xee];

	const record = lhvcRecord(
		{
			minSpatialSegmentationIdc: 0,
			parallelismType: 0,
			numTemporalLayers: 1,
			temporalIdNested: false,
			lengthSizeMinusOne: 3,
		},
		[
			{ complete: true, nalUnitType: 32, nalUnits: [vpsForLayers] },
			{ complete: true, nalUnitType: 33, nalUnits: [spsForView1] },
			{ complete: true, nalUnitType: 34, nalUnits: [ppsForView1] },
		],
	);

	const parsed = parseLhvcConfigRecord(record)!;
	expect(parsed).not.toBe(null);
	expect(parsed.configurationVersion).toBe(1);
	expect(parsed.lengthSizeMinusOne).toBe(3);

	expect(parsed.arrays.map(array => array.nalUnitType)).toEqual([32, 33, 34]);
	expect([...parsed.arrays[1]!.nalUnits[0]!]).toEqual(spsForView1);
	expect([...parsed.arrays[2]!.nalUnits[0]!]).toEqual(ppsForView1);

	// And the units it carries are themselves layer-1 units, which is the whole point of the box
	expect(extractLayerIdForHevc(parsed.arrays[1]!.nalUnits[0]![0]!, parsed.arrays[1]!.nalUnits[0]![1]!))
		.toBe(1);
	expect(extractLayerIdForHevc(parsed.arrays[0]!.nalUnits[0]![0]!, parsed.arrays[0]!.nalUnits[0]![1]!))
		.toBe(0); // the VPS itself is a base-layer unit
});

test('lhvC\'s advisory header fields are read off the octets they sit in', () => {
	const record = lhvcRecord(
		{
			minSpatialSegmentationIdc: 0x123,
			parallelismType: 2,
			numTemporalLayers: 5,
			temporalIdNested: true,
			lengthSizeMinusOne: 1,
		},
		[],
	);

	expect(parseLhvcConfigRecord(record)).toEqual({
		configurationVersion: 1,
		// 12 bits spanning two octets, four of them behind the reserved bits
		minSpatialSegmentationIdc: 0x123,
		parallelismType: 2,
		numTemporalLayers: 5,
		temporalIdNested: true,
		lengthSizeMinusOne: 1,
		arrays: [],
	});
});

test('a truncated or over-claiming lhvC is refused rather than half-read', () => {
	// Shorter than its own six-octet header
	expect(parseLhvcConfigRecord(new Uint8Array(5))).toBe(null);
	expect(parseLhvcConfigRecord(new Uint8Array(0))).toBe(null);

	// Says one array of one NAL unit 0xffff long, and holds nothing like it. A reader that trusted the
	// length would hand back a view running past the box.
	const overclaiming = new Uint8Array([1, 0xf0, 0, 0xfc, 0xff, 1, 0x80 | 33, 0, 1, 0xff, 0xff, 0x01]);
	expect(parseLhvcConfigRecord(overclaiming)).toBe(null);

	// The exact header with no arrays is valid, and is the shortest legal record
	expect(parseLhvcConfigRecord(new Uint8Array([1, 0xf0, 0, 0xfc, 0xff, 0]))).not.toBe(null);
});

// The VPS below is the real one out of MVHEVCS-A, a JCT-3V MV-HEVC draft conformance bitstream
// (itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/MV-HEVC/). 57 octets of
// parameter set, which is what makes this a deterministic test rather than a download.
//
// Its own description file is the ground truth every assertion below is taken from: "NumViews is equal
// to 2", "NumDirectRefLayers of the non-base view is equal to 1", "for each picture in the non-base
// view, inter-view prediction is enabled", two texture views at 1024x768.
//
// This is the test that matters. The synthetic fixtures above prove the NAL header field is read as
// the syntax defines it; only a real stream proves the walk through profile_tier_level, the sub-layer
// ordering loop, the layer sets and the extension's alignment lands on the right bit. It did not, at
// first: vps_extension() opens with a profile_tier_level whose profilePresentFlag is 0, and reading
// the profile's 88 bits anyway made the scalability masks come out as 1111000001000000 instead of
// 0100000000000000 - noise that still looked like a parse.
const MVHEVCS_A_VPS = Uint8Array.from(
	(
		'40010c11ffff01600000030000030000030000030078949056ff782000211a5c'
		+ '1808000003003e200000030001e23410000c02807e14a4f480'
	).match(/../g)!.map(byte => parseInt(byte, 16)),
);

test('a real MV-HEVC VPS reports two views, and says they are views', () => {
	const info = parseHevcVpsExtension(MVHEVCS_A_VPS)!;
	expect(info, 'the VPS declares an extension').not.toBe(null);

	// scalability_mask_flag[1] is ViewOrderIdx (Table F.1) - the only thing separating MV-HEVC from
	// SHVC, which the layer ids alone cannot tell you
	expect(info.isMultiview).toBe(true);
	expect(info.numViews, 'the stream states NumViews = 2').toBe(2);

	expect(info.layerIds).toEqual([0, 1]);
	expect(info.viewOrderIdx, 'the base view is 0 and the second view 1').toEqual([0, 1]);
	expect(info.viewIds).toEqual([1, 0]);

	// "NumDirectRefLayers of the non-base view is equal to 1" and inter-view prediction is enabled, so
	// layer 1 predicts from layer 0. This is the assertion that pinned the bit alignment: it reads 0
	// the moment anything above it is off, which is how the profile_tier_level mistake was caught.
	expect(info.directDependencies).toEqual([[0]]);
});

test('declaring a layer and carrying one are different questions', () => {
	// The VPS *declares* that layer 1 exists; the unit carrying that declaration is itself a base-layer
	// NAL unit. Those are the two functions here, and this is the difference between them - which is why
	// `inspectHevcLayers` has to be asked of a packet and `parseHevcVpsExtension` of the parameter set.
	const declared = parseHevcVpsExtension(MVHEVCS_A_VPS)!;
	expect(declared.layerIds).toEqual([0, 1]);

	const asAnnexB = new Uint8Array([0, 0, 0, 1, ...MVHEVCS_A_VPS]);
	const carried = inspectHevcLayers(asAnnexB, { codec: 'hvc1' } as VideoDecoderConfig);
	expect(carried.layerIds, 'the VPS itself rides on the base layer').toEqual([0]);
	expect(carried.isLayered, 'and nothing in this one packet is above the base layer').toBe(false);

	// Run over the whole 214 KB conformance bitstream rather than this one unit, `inspectHevcLayers`
	// reports layerIds [0, 1] with 51 NAL units on layer 0 and 50 on layer 1, and layer 1 carries its
	// own SPS and PPS but no VPS. Checked out of band on 2026-11-17; the stream is not committed here.
});

test('a VPS without an extension, or that is not a VPS, yields nothing', () => {
	// An SPS, not a VPS
	expect(parseHevcVpsExtension(Uint8Array.from([...nalHeader(33, 0, 0), 0x01]))).toBe(null);
	// Too short to hold a NAL header
	expect(parseHevcVpsExtension(new Uint8Array([0x40]))).toBe(null);
	// A VPS truncated mid-parse reads past its end rather than returning half an answer
	expect(parseHevcVpsExtension(MVHEVCS_A_VPS.subarray(0, 12))).toBe(null);
});

// The `lhvC` and `vexu` payloads below are the real ones from Apple's public spatial video example
// (developer.apple.com/streaming/examples -> "Spatial video stream", variant 5). Only these two box
// payloads are committed - 142 octets of structural metadata, no picture - which is enough to pin
// every layout question and keeps the test deterministic without a download.
//
// What they say, decoded: lhvC carries layer 1's SPS and PPS; vexu says both eyes are present, the
// left one leads, the cameras were 11.8 mm apart, the disparity adjustment is 200, and the picture is
// rectilinear.

const APPLE_LHVC = '01f000fccb02a10001000b42090e822e458ab0100501a20001000944094802cbc14da805';
const APPLE_VEXU = '00000052657965730000000d7374726900000000030000000d6865726f0000000001'
	+ '0000001863616d7300000010626c696e0000000000002e1800000018636d6679000000106461646a'
	+ '00000000000000c80000001870726f6a0000001070726a690000000072656374';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-mvhevc-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(byte => parseInt(byte, 16)));

/** What a `vexu` that states none of the less common things comes back with. */
const PLAIN_VEXU = {
	eyeViewsReversed: false,
	hasAdditionalViews: false,
	packing: null,
	requiredBoxTypes: [],
};

test('a vexu box says which eyes, which leads, how far apart and what projection', () => {
	const info = parseVexuBox(fromHex(APPLE_VEXU))!;

	expect(info).toEqual({
		...PLAIN_VEXU,
		hasLeftEye: true,
		hasRightEye: true,
		heroEye: 'left',
		// 0x2e18 micrometres: 11.8 mm between the cameras, not 11800 of anything else
		baselineMicrometres: 11800,
		disparityAdjustment: 200,
		projection: 'rect',
	});
});

test('stri names the eyes individually, which both-eyes content cannot distinguish', () => {
	// Apple's example has both bits set, so it cannot tell bit 0 from bit 1. A one-eyed view can.
	// eyes(21) { stri(13) { version+flags(4), one byte } }
	const withStri = (value: string) => `00000015${'65796573'}0000000d73747269` + `000000000${value}`;

	expect(parseVexuBox(fromHex(withStri('1')))).toMatchObject({ hasLeftEye: true, hasRightEye: false });
	expect(parseVexuBox(fromHex(withStri('2')))).toMatchObject({ hasLeftEye: false, hasRightEye: true });
	expect(parseVexuBox(fromHex(withStri('3')))).toMatchObject({ hasLeftEye: true, hasRightEye: true });
	expect(parseVexuBox(fromHex(withStri('0')))).toMatchObject({ hasLeftEye: false, hasRightEye: false });

	// The two flags above the eyes, each on its own: set together they could be swapped unnoticed.
	// has_additional_views is bit 2, eye_views_reversed bit 3.
	expect(parseVexuBox(fromHex(withStri('4')))).toMatchObject({
		hasAdditionalViews: true, eyeViewsReversed: false,
	});
	expect(parseVexuBox(fromHex(withStri('8')))).toMatchObject({
		hasAdditionalViews: false, eyeViewsReversed: true,
	});
	// A reversed pair is still a pair, so it is the only thing separating the eyes from each other
	expect(parseVexuBox(fromHex(withStri('b')))).toMatchObject({
		hasLeftEye: true, hasRightEye: true, eyeViewsReversed: true, hasAdditionalViews: false,
	});
});

test('a must box names the peers a reader has to understand', () => {
	// vexu { must(24) { version+flags, 'eyes', 0 (reserved padding), 'pack' }, eyes(21) { stri } }
	const vexu = '00000018' + '6d757374' + '00000000' + '65796573' + '00000000' + '7061636b'
		+ '00000015' + '65796573' + '0000000d' + '73747269' + '00000000' + '03';

	expect(parseVexuBox(fromHex(vexu))).toMatchObject({
		// The zero entry is reserved space, not a box type
		requiredBoxTypes: ['eyes', 'pack'],
		hasLeftEye: true,
		hasRightEye: true,
	});

	// A must with nothing in it is not a claim that nothing is required
	expect(parseVexuBox(fromHex('0000000c' + '6d757374' + '00000000'))!.requiredBoxTypes).toEqual([]);
});

test('a vexu carrying nothing understood still reads, rather than failing', () => {
	// Apple keeps adding boxes in here. A reader that refused the ones it did not know would start
	// rejecting spatial video on the next release.
	const unknown = fromHex('0000001078797a7a00000000deadbeef');
	expect(parseVexuBox(unknown)).toEqual({
		...PLAIN_VEXU,
		hasLeftEye: false,
		hasRightEye: false,
		heroEye: 'none',
		baselineMicrometres: null,
		disparityAdjustment: null,
		projection: null,
	});

	expect(parseVexuBox(new Uint8Array(4))).toBe(null);
});

test('a parametric-immersive projection is its own value, not an unknown one', () => {
	// HLS states this as PROJ-PRIM. Reading it as null makes a packager write plain CH-STEREO for
	// content that is not an ordinary rectilinear stereo pair.
	const withProj = (kind: string) => {
		const fourCc = [...kind].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
		return `0000001870726f6a0000001070726a6900000000${fourCc}`;
	};

	for (const kind of ['rect', 'equi', 'hequ', 'fish', 'prim'] as const) {
		expect(parseVexuBox(fromHex(withProj(kind)))!.projection, kind).toBe(kind);
	}
	// Still null for one this does not know, rather than passing a four-CC through as a projection
	expect(parseVexuBox(fromHex(withProj('zzzz')))!.projection).toBe(null);
});

test('the lhvC payload is layer 1\'s parameter sets, and reads as such', () => {
	const record = parseLhvcConfigRecord(fromHex(APPLE_LHVC))!;
	const nalUnits = record.arrays.flatMap(array => array.nalUnits);

	expect(nalUnits.length).toBeGreaterThan(0);
	// Every NAL in here belongs to the layer hvcC does NOT describe. The id straddles the two header
	// bytes, which is why reading only the second one would report these as layer 1 of nothing.
	for (const nalUnit of nalUnits) {
		expect(extractLayerIdForHevc(nalUnit[0]!, nalUnit[1]!)).toBe(1);
	}
	// An SPS and a PPS, which is what a second view needs to decode
	expect(record.arrays.map(array => array.nalUnitType).sort()).toEqual([33, 34]);
});

test('lhvC and vexu survive a remux byte for byte', async () => {
	// The acceptance that matters: a packager that writes segments must hand back the second view
	// untouched. Losing either box fails silently - the base layer still decodes, so the result is a
	// perfectly playable video with one eye.
	const lhvc = fromHex(APPLE_LHVC);
	const vexu = fromHex(APPLE_VEXU);

	const write = async (multiview: { layerConfiguration: Uint8Array; viewExtension?: Uint8Array } | undefined) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(source);
		await output.start();
		await source.add(
			new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x26, 0x01, 0xaf]), 'key', 0, 1 / 30),
			{
				decoderConfig: {
					codec: 'hvc1.2.20000000.L120.B0',
					codedWidth: 1280,
					codedHeight: 1280,
					description: fromHex(HVCC_BASE),
					...(multiview ? { multiview } : {}),
				},
			},
		);
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const bytes = await write({ layerConfiguration: lhvc, viewExtension: vexu });

	// In the file, in the sample entry, with the exact payloads
	expect(bytesToHexString(bytes)).toContain(APPLE_LHVC);
	expect(bytesToHexString(bytes)).toContain(APPLE_VEXU);
	// lhvC sits directly after hvcC, which is where Apple puts it
	const hvccAt = bytesToHexString(bytes).indexOf('68766343');
	const lhvcAt = bytesToHexString(bytes).indexOf('6c687643');
	expect(hvccAt).toBeGreaterThan(-1);
	expect(lhvcAt).toBeGreaterThan(hvccAt);

	// And back out through the reader, unchanged
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;

	expect(config.multiview).toBeDefined();
	expect(bytesToHexString(config.multiview!.layerConfiguration)).toBe(APPLE_LHVC);
	expect(bytesToHexString(config.multiview!.viewExtension!)).toBe(APPLE_VEXU);
	// Still says the same thing after the trip
	expect(parseVexuBox(config.multiview!.viewExtension!)!.projection).toBe('rect');

	// A track with no second view writes neither box, rather than an empty one
	const mono = await write(undefined);
	expect(bytesToHexString(mono)).not.toContain('6c687643');
	expect(bytesToHexString(mono)).not.toContain('76657875');
});

test('the hvcC and lhvC arrays sit behind different headers, and each parser knows which', () => {
	// Both records carry their NAL arrays in the same format, behind headers of twenty-two and six
	// octets. Reading one at the other's offset lands inside a parameter set and still produces
	// arrays that parse without complaint - which is why reaching into an hvcC by hand is a trap.
	const hvcc = fromHex(HVCC_BASE);
	const base = parseHvccConfigRecord(hvcc)!;

	expect(base).not.toBe(null);
	const baseNals = base.flatMap(array => array.nalUnits);
	expect(baseNals.length).toBeGreaterThan(0);
	// Everything hvcC describes is the base layer, by definition
	for (const nalUnit of baseNals) {
		expect(extractLayerIdForHevc(nalUnit[0]!, nalUnit[1]!)).toBe(0);
	}

	// And the lhvC parser on the same bytes gives something different, since the header is not the
	// same length - the two are not interchangeable even though the array format is
	expect(parseHvccConfigRecord(fromHex(APPLE_LHVC))).not.toEqual(
		parseLhvcConfigRecord(fromHex(APPLE_LHVC))!.arrays,
	);

	expect(parseHvccConfigRecord(new Uint8Array(8))).toBe(null);
});

test('Dolby Vision profile 20 states dvwC and its own codec string', () => {
	// Apple's stereo dvh1.20. The box rule is "7 or below dvcC, 10 or below dvvC, otherwise dvwC", so
	// a profile above 10 must not fall back to dvvC - a player reading the wrong box reads the wrong
	// fields entirely.
	const config = {
		profile: 20,
		level: 9,
		blSignalCompatibilityId: 0,
		rpuPresent: true,
		elPresent: false,
		blPresent: true,
	};

	expect(doviConfigBoxName(config)).toBe('dvwC');
	expect(doviCodecString('dvh1', config)).toBe('dvh1.20.09');
	// Seven bits of profile, so 20 survives the record rather than wrapping
	expect(parseDoviConfigRecord(serializeDoviConfigRecord(config))).toEqual(config);
});

test('MPEG-TS carries layer 1\'s parameter sets, after the base layer\'s', async () => {
	// `hvcC` describes the base layer alone, so without `lhvC` in the elementary stream a decoder
	// sees layer 1's slices with no SPS to read them against and drops them. The stream plays - with
	// one eye - which is why nothing fails loudly.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	// A VCL NAL on the base layer, so the access unit is well-formed enough to be written
	const vcl = new Uint8Array([0, 0, 0, 5, 0x26, 0x01, 0xaf, 0x00, 0x00]);
	await source.add(new EncodedPacket(vcl, 'key', 0, 1 / 30), {
		decoderConfig: {
			codec: 'hvc1.2.20000000.L120.B0',
			codedWidth: 1280,
			codedHeight: 1280,
			description: fromHex(HVCC_BASE),
			multiview: { layerConfiguration: fromHex(APPLE_LHVC) },
		},
	});
	await output.finalize();

	const stream = bytesToHexString(new Uint8Array(output.target.buffer!));
	const layered = parseLhvcConfigRecord(fromHex(APPLE_LHVC))!;
	const base = parseHvccConfigRecord(fromHex(HVCC_BASE))!;

	// Layer 1's sets are in the stream at all
	const layer1 = layered.arrays.flatMap(array => array.nalUnits);
	expect(layer1.length).toBeGreaterThan(0);
	for (const nalUnit of layer1) {
		expect(extractLayerIdForHevc(nalUnit[0]!, nalUnit[1]!)).toBe(1);
		expect(stream, 'layer 1 parameter set present').toContain(bytesToHexString(nalUnit));
	}

	// And after the base layer's, which they depend on
	const baseSps = base.find(array => array.nalUnitType === 33)!.nalUnits[0]!;
	const layerSps = layered.arrays.find(array => array.nalUnitType === 33)!.nalUnits[0]!;
	expect(stream.indexOf(bytesToHexString(baseSps)))
		.toBeLessThan(stream.indexOf(bytesToHexString(layerSps)));

	// A track with no second view writes none of this rather than an empty set
	const mono = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const monoSource = new EncodedVideoPacketSource('hevc');
	mono.addVideoTrack(monoSource);
	await mono.start();
	await monoSource.add(new EncodedPacket(vcl, 'key', 0, 1 / 30), {
		decoderConfig: {
			codec: 'hvc1.2.20000000.L120.B0',
			codedWidth: 1280,
			codedHeight: 1280,
			description: fromHex(HVCC_BASE),
		},
	});
	await mono.finalize();
	const monoStream = bytesToHexString(new Uint8Array(mono.target.buffer!));
	expect(monoStream).not.toContain(bytesToHexString(layerSps));
});

test('MPEG-TS carries the decoder config\'s declarative SEI, after the parameter sets', async () => {
	// An `hvcC` keeps a declarative SEI out of band - Apple's spatial config carries 3D reference
	// displays info, payload type 176 - and a transport stream has no decoder configuration at all. A
	// receiver that only ever sees the elementary stream has nowhere else to learn it from, so it has
	// to ride each IRAP, where a prefix SEI follows the parameter sets it applies after.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	const vcl = new Uint8Array([0, 0, 0, 5, 0x26, 0x01, 0xaf, 0x00, 0x00]);
	const config = {
		codec: 'hvc1.2.20000000.L120.B0',
		codedWidth: 1280,
		codedHeight: 1280,
		description: fromHex(HVCC_BASE),
		multiview: { layerConfiguration: fromHex(APPLE_LHVC) },
	} as VideoDecoderConfig;

	// Two key frames with a delta between them: the SEI belongs on each IRAP, not once at the head
	await source.add(new EncodedPacket(vcl, 'key', 0, 1 / 30), { decoderConfig: config });
	await source.add(new EncodedPacket(vcl, 'delta', 1 / 30, 1 / 30));
	await source.add(new EncodedPacket(vcl, 'key', 2 / 30, 1 / 30));
	await output.finalize();

	// Read back as access units rather than searched for in the transport stream: a NAL unit of this
	// length straddles the 188-octet packets, so a hex search of the stream finds nothing either way
	using input = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!).buffer),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const units: { type: 'key' | 'delta'; hex: string }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		units.push({ type: packet.type, hex: bytesToHexString(packet.data) });
	}

	const base = parseHvccConfigRecord(fromHex(HVCC_BASE))!;
	const layered = parseLhvcConfigRecord(fromHex(APPLE_LHVC))!;
	const sei = base.find(array => array.nalUnitType === 39)!.nalUnits[0]!;
	// The fixture's own SEI, which is what the peer measured against
	expect(bytesToHexString(sei)).toBe('4e01b004040d002080');

	expect(units.length).toBe(3);
	for (const unit of units) {
		const occurrences = [...unit.hex.matchAll(new RegExp(bytesToHexString(sei), 'g'))];

		if (unit.type === 'delta') {
			expect(occurrences, 'a delta frame carries no parameter sets, so no SEI either').toHaveLength(0);
			continue;
		}

		expect(occurrences, 'once per IRAP').toHaveLength(1);

		// After every parameter set it applies to, which is where a prefix SEI sits in an access unit
		const sets = [
			...base.filter(array => array.nalUnitType !== 39).flatMap(array => array.nalUnits),
			...layered.arrays.flatMap(array => array.nalUnits),
		];
		expect(sets.length).toBeGreaterThan(0);
		for (const set of sets) {
			const hex = bytesToHexString(set);
			// Once: a second copy would be a parameter set the access unit states twice
			expect([...unit.hex.matchAll(new RegExp(hex, 'g'))], hex.slice(0, 8)).toHaveLength(1);
			expect(unit.hex.indexOf(hex), hex.slice(0, 8))
				.toBeLessThan(unit.hex.indexOf(bytesToHexString(sei)));
		}

		// And before the slice data it applies to
		expect(unit.hex.indexOf(bytesToHexString(sei))).toBeLessThan(unit.hex.indexOf('2601af'));
	}
});

test('everything an lhvC record models survives the serializer', () => {
	const parsed = parseLhvcConfigRecord(fromHex(APPLE_LHVC))!;

	// Byte-exact, against a record this library did not write: every field position and every
	// reserved run has to be right, not merely consistent between the parser and the builder
	expect(bytesToHexString(buildLhvcConfigRecord(parsed))).toBe(APPLE_LHVC);

	// Apple's record leaves temporalIdNested clear and states one temporal layer, so a record that
	// says otherwise has to make the trip too - otherwise dropping either from the builder is free
	const nested = parseLhvcConfigRecord(lhvcRecord(
		{
			minSpatialSegmentationIdc: 0,
			parallelismType: 0,
			numTemporalLayers: 7,
			temporalIdNested: true,
			lengthSizeMinusOne: 3,
		},
		[{ complete: true, nalUnitType: 33, nalUnits: [[...nalHeader(33, 1, 0), 0xcc]] }],
	))!;

	expect(parseLhvcConfigRecord(buildLhvcConfigRecord(nested))).toEqual(nested);
	expect(nested.temporalIdNested).toBe(true);
	expect(nested.numTemporalLayers).toBe(7);
});

test('an lhvC is built from the bitstream for a track that arrived without one', async () => {
	// A track demuxed from a transport stream has no decoder configuration at all: its parameter sets
	// are in band and nothing declares them. Writing it into an MP4 needs an lhvC, because hvcC
	// describes the base layer alone and a reader given only that drops every layer above it.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	// A base-layer slice and a layer-1 slice: the second view's picture data, which is on the layer
	// this collects parameter sets from and must not be collected as one
	const vcl = new Uint8Array([
		0, 0, 0, 5, 0x26, 0x01, 0xaf, 0x00, 0x00,
		0, 0, 0, 5, 0x02, 0x09, 0xaf, 0x00, 0x00,
	]);
	expect(extractLayerIdForHevc(0x02, 0x09)).toBe(1);

	await source.add(new EncodedPacket(vcl, 'key', 0, 1 / 30), {
		decoderConfig: {
			codec: 'hvc1.2.20000000.L120.B0',
			codedWidth: 1280,
			codedHeight: 1280,
			description: fromHex(HVCC_BASE),
			multiview: { layerConfiguration: fromHex(APPLE_LHVC) },
		},
	});
	await source.add(new EncodedPacket(vcl, 'key', 1 / 30, 1 / 30));
	await output.finalize();

	using input = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!).buffer),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet.data);
	}
	expect(packets.length).toBe(2);

	const built = lhvcConfigFromBitstream({ packets, decoderConfig: config })!;
	expect(built).not.toBeNull();

	// Exactly layer 1's parameter sets, and each one once even though both IRAPs carried them
	const original = parseLhvcConfigRecord(fromHex(APPLE_LHVC))!;
	const flatten = (arrays: typeof original.arrays) => arrays
		.flatMap(array => array.nalUnits.map(unit => `${array.nalUnitType}:${bytesToHexString(unit)}`))
		.sort();
	expect(flatten(built.arrays)).toEqual(flatten(original.arrays));

	// Every unit it collected is above the base layer, which is what hvcC does not carry
	for (const array of built.arrays) {
		for (const unit of array.nalUnits) {
			// Asserted rather than defaulted: the fallbacks below never fire for a real NAL unit
			expect(unit.length).toBeGreaterThanOrEqual(2);
			expect(extractLayerIdForHevc(unit[0] ?? 0, unit[1] ?? 0)).toBeGreaterThan(0);
		}
	}

	// And the sample layout is the base layer's, since both records describe the same track
	expect(built.lengthSizeMinusOne).toBe(parseLhvcConfigRecord(fromHex(APPLE_LHVC))!.lengthSizeMinusOne);
});

test('ordinary HEVC yields no lhvC at all', async () => {
	// Not an empty record: a single-layer track has nothing above the base layer to declare, and an
	// lhvC saying so would make every plain HEVC file claim to be layered
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	const vcl = new Uint8Array([0, 0, 0, 5, 0x26, 0x01, 0xaf, 0x00, 0x00]);
	await source.add(new EncodedPacket(vcl, 'key', 0, 1 / 30), {
		decoderConfig: {
			codec: 'hvc1.2.20000000.L120.B0',
			codedWidth: 1280,
			codedHeight: 1280,
			description: fromHex(HVCC_BASE),
		},
	});
	await output.finalize();

	using input = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!).buffer),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet.data);
	}

	expect(lhvcConfigFromBitstream({ packets, decoderConfig: config })).toBeNull();
});

test('a vexu built from what a real VPS states says both eyes and nothing else', () => {
	// The bitstream says there are two views and that they are views. Which view is which eye, how far
	// apart the cameras were and what projection was used come from the camera, not the encoder.
	const layers = parseHevcVpsExtension(MVHEVCS_A_VPS)!;
	const info = vexuInfoFromVpsExtension(layers)!;

	expect(info).toEqual({
		...PLAIN_VEXU,
		hasLeftEye: true,
		hasRightEye: true,
		heroEye: 'none',
		baselineMicrometres: null,
		disparityAdjustment: null,
		projection: null,
	});

	const box = buildVexuBox(info)!;
	expect(parseVexuBox(box)).toEqual(info);

	// A stri and nothing else: no hero eye, no baseline, no projection claimed. Counted rather than
	// copied: `eyes` is 8 + 13, and `stri` is its 8-octet header, four octets of version and flags,
	// and the one flags octet, 0x03 being left and right.
	expect(box.length).toBe(8 + (8 + 4 + 1));
	expect(bytesToHexString(box)).toBe('00000015' + '65796573' + '0000000d' + '73747269' + '00000000' + '03');
});

test('a one-view stream gets no vexu at all', () => {
	// `stri` saying both eyes are present would be a claim about the stream rather than a description
	expect(vexuInfoFromVpsExtension({
		isMultiview: false, numViews: 1, layerIds: [0], viewOrderIdx: [0], viewIds: [0],
		directDependencies: [[]],
	})).toBeNull();
	expect(vexuInfoFromVpsExtension({
		isMultiview: true, numViews: 3, layerIds: [0, 1, 2], viewOrderIdx: [0, 1, 2], viewIds: [0, 1, 2],
		directDependencies: [[], [0], [0]],
	})).toBeNull();
});

test('a vexu carrying every field round-trips', () => {
	const info = {
		hasLeftEye: true,
		hasRightEye: true,
		eyeViewsReversed: true,
		hasAdditionalViews: true,
		heroEye: 'left' as const,
		baselineMicrometres: 63500,
		disparityAdjustment: -1200,
		packing: 'over' as const,
		projection: 'equi' as const,
		requiredBoxTypes: ['eyes', 'proj'],
	};

	expect(parseVexuBox(buildVexuBox(info)!)).toEqual(info);
});

test('an info stating nothing produces no box rather than an empty one', () => {
	expect(buildVexuBox({
		...PLAIN_VEXU,
		hasLeftEye: false,
		hasRightEye: false,
		heroEye: 'none',
		baselineMicrometres: null,
		disparityAdjustment: null,
		projection: null,
	})).toBeNull();
});

test('one eye is told from the other, which both-eyes content cannot distinguish', () => {
	// Swapping the two flags is invisible whenever both are set, which every stereo track has
	const base = {
		...PLAIN_VEXU,
		heroEye: 'none' as const,
		baselineMicrometres: null,
		disparityAdjustment: null,
		projection: null,
	};

	const leftOnly = buildVexuBox({ ...base, hasLeftEye: true, hasRightEye: false })!;
	const rightOnly = buildVexuBox({ ...base, hasLeftEye: false, hasRightEye: true })!;

	// Apple's Stereo Video ISOBMFF Extensions, StereoViewInformationBox: reserved(4),
	// eye_views_reversed, has_additional_views, has_right_eye_view, has_left_eye_view - so the left
	// eye is the LOW bit
	expect(leftOnly[leftOnly.length - 1]).toBe(0x01);
	expect(rightOnly[rightOnly.length - 1]).toBe(0x02);

	expect(parseVexuBox(leftOnly)).toEqual({ ...base, hasLeftEye: true, hasRightEye: false });
	expect(parseVexuBox(rightOnly)).toEqual({ ...base, hasLeftEye: false, hasRightEye: true });
});

test('a prefix SEI between a layered picture\'s two views does not split the access unit', async () => {
	// The shape Apple's spatial content has, and the one that loses an eye: a base-layer picture, a
	// declarative SEI, then the second view. H.265 F.7.4.2.4.4 starts an access unit only before the
	// BASE layer's first slice of a new picture, so that SEI is mid-unit - but the single-layer rule
	// "a non-VCL NAL after a slice begins the next unit" cuts there, and what follows has no
	// base-layer slice in it at all. It used to be dropped: the stream still decodes, with one eye.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	// first_slice_segment_in_pic_flag is the top bit of the slice payload, so 0x80 starts a picture
	const accessUnit = new Uint8Array([
		// IDR_W_RADL on the base layer
		0, 0, 0, 5, 0x28, 0x01, 0x80, 0x00, 0x00,
		// A layer-0 prefix SEI sitting between the two views, which is what did the damage
		0, 0, 0, 6, 0x4e, 0x01, 0xb0, 0x04, 0x04, 0x80,
		// CRA_NUT on layer 1: the second view of the same picture
		0, 0, 0, 5, 0x2a, 0x09, 0x80, 0x00, 0x00,
	]);

	for (let i = 0; i < 3; i++) {
		await source.add(new EncodedPacket(accessUnit, 'key', i / 30, 1 / 30), i === 0
			? {
					decoderConfig: {
						codec: 'hvc1.2.20000000.L120.B0',
						codedWidth: 1280,
						codedHeight: 1280,
						description: fromHex(HVCC_BASE),
						multiview: { layerConfiguration: fromHex(APPLE_LHVC) },
					},
				}
			: undefined);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!).buffer),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;

	// Layer ids alone are not enough: the layer-1 SPS and PPS sit in the packet too, so a packet that
	// lost the second view entirely still reports layers [0, 1]. What has to be there is a layer-1
	// VCL slice - the picture.
	const secondViewSlices: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		let found = 0;
		for (const location of iterateHevcNalUnits(packet.data, config)) {
			const first = packet.data[location.offset] ?? 0;
			const second = packet.data[location.offset + 1] ?? 0;
			const type = extractNalUnitTypeForHevc(first);
			const isVcl = type <= 21;
			if (isVcl && extractLayerIdForHevc(first, second) === 1) {
				found++;
			}
		}
		secondViewSlices.push(found);
	}

	// One packet per access unit, not two, and every one carries the second view's picture
	expect(secondViewSlices).toEqual([1, 1, 1]);
});

// Everything above is built from the syntax, because no encoder in this toolchain writes MV-HEVC. The
// block below reads files that were not produced by anything here: an Apple spatial video and a second
// writer's MV-HEVC, fetched by `npm run capture-mvhevc-fixtures`. Where ffprobe is present, the numbers
// are taken from it rather than stated, so a wrong reading of a field cannot agree with itself.

const MVHEVC_FIXTURES = path.join(__dirname, '../fixtures/mvhevc');
const hasMvhevcFixtures = existsSync(path.join(MVHEVC_FIXTURES, 'multiview.mov'));

const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** The video stream's `Stereo 3D` and `Spherical Mapping` side data, as ffprobe reports them. */
const ffprobeSideData = (file: string) => {
	const json = execFileSync('ffprobe', [
		'-hide_banner', '-v', 'error', '-select_streams', 'v:0',
		'-show_entries', 'stream_side_data', '-of', 'json', file,
	], { encoding: 'utf8' });

	const list = (JSON.parse(json) as {
		streams?: { side_data_list?: Record<string, string | number>[] }[];
	}).streams?.[0]?.side_data_list ?? [];

	return Object.fromEntries(list.map(entry => [entry['side_data_type'] as string, entry]));
};

const multiviewOf = async (file: string) => {
	using input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	return config.multiview;
};

describe.skipIf(!hasMvhevcFixtures)('files no part of this library wrote', () => {
	test('an Apple spatial video states its eyes, baseline, disparity, projection and field of view', async () => {
		const multiview = (await multiviewOf(path.join(MVHEVC_FIXTURES, 'multiview.mov')))!;
		expect(multiview).toBeDefined();

		const info = parseVexuBox(multiview.viewExtension!)!;
		expect(info).toEqual({
			hasLeftEye: true,
			hasRightEye: true,
			eyeViewsReversed: false,
			hasAdditionalViews: false,
			heroEye: 'none',
			baselineMicrometres: 19240,
			disparityAdjustment: 200,
			packing: null,
			projection: 'rect',
			requiredBoxTypes: [],
		});

		// `hfov` is a sibling of `vexu` in the sample entry, not a child of it. 63.400 degrees.
		expect(multiview.fieldOfViewMillidegrees).toBe(63400);
	});

	test.skipIf(!hasFfprobe)('and states them as ffprobe reads them off the same file', async () => {
		const file = path.join(MVHEVC_FIXTURES, 'multiview.mov');
		const multiview = (await multiviewOf(file))!;
		const info = parseVexuBox(multiview.viewExtension!)!;
		const sideData = ffprobeSideData(file);

		const stereo = sideData['Stereo 3D']!;
		expect(Number(stereo['baseline'])).toBe(info.baselineMicrometres);
		// ffprobe prints these as the rationals the boxes imply: 1/10000 of a view width, and
		// 1/1000 of a degree
		expect(stereo['horizontal_disparity_adjustment']).toBe(`${info.disparityAdjustment}/10000`);
		expect(stereo['horizontal_field_of_view']).toBe(`${multiview.fieldOfViewMillidegrees}/1000`);
		expect(stereo['primary_eye']).toBe(info.heroEye);
		expect(stereo['inverted']).toBe(info.eyeViewsReversed ? 1 : 0);
		expect(sideData['Spherical Mapping']!['projection']).toBe('rectilinear');
		expect(info.projection).toBe('rect');
	});

	test('its lhvC states one temporal layer and layer 1\'s parameter sets', async () => {
		const multiview = (await multiviewOf(path.join(MVHEVC_FIXTURES, 'multiview.mov')))!;
		const record = parseLhvcConfigRecord(multiview.layerConfiguration)!;

		expect(record.configurationVersion).toBe(1);
		expect(record.minSpatialSegmentationIdc).toBe(0);
		expect(record.parallelismType).toBe(0);
		// 0xcb at octet 4: numTemporalLayers 1, temporalIdNested 0, lengthSizeMinusOne 3. Read as a
		// complete_representation flag plus reserved bits, octet 4 would say nothing at all.
		expect(record.numTemporalLayers).toBe(1);
		expect(record.temporalIdNested).toBe(false);
		expect(record.lengthSizeMinusOne).toBe(3);
		expect(record.arrays.map(array => array.nalUnitType).sort()).toEqual([33, 34]);

		for (const nalUnit of record.arrays.flatMap(array => array.nalUnits)) {
			expect(extractLayerIdForHevc(nalUnit[0]!, nalUnit[1]!)).toBe(1);
		}
	});

	test('an lhvC this library builds is byte for byte the one Apple wrote', async () => {
		// Nothing here states an expected byte: the record goes through the parser and back out
		// through the builder, and the file it came from is the expectation. Every reserved run and
		// every field position has to be right for this to hold, which no self-built fixture can say.
		for (const name of ['multiview.mov', 'pico-mv-hevc.mp4']) {
			const multiview = (await multiviewOf(path.join(MVHEVC_FIXTURES, name)))!;
			const rebuilt = buildLhvcConfigRecord(parseLhvcConfigRecord(multiview.layerConfiguration)!);

			expect(bytesToHexString(rebuilt), name).toBe(bytesToHexString(multiview.layerConfiguration));
		}
	});

	test('a second writer\'s lhvC reads the same way, so one file\'s quirks are not the format', async () => {
		const multiview = (await multiviewOf(path.join(MVHEVC_FIXTURES, 'pico-mv-hevc.mp4')))!;
		const record = parseLhvcConfigRecord(multiview.layerConfiguration)!;

		// 0xc3 at octet 4, against the other file's 0xcb: this writer left the temporal layer count
		// unstated, which is what zero means here, and the other stated one
		expect(record.numTemporalLayers).toBe(0);
		expect(record.temporalIdNested).toBe(false);
		expect(record.lengthSizeMinusOne).toBe(3);
		expect(record.arrays.map(array => array.nalUnitType).sort()).toEqual([33, 34]);
		// This one carries no vexu at all, which is what makes it MV-HEVC and not spatial video
		expect(multiview.viewExtension).toBeUndefined();
		expect(multiview.fieldOfViewMillidegrees).toBeUndefined();
	});

	test.skipIf(!hasFfprobe)('what we write back is what ffprobe read in', async () => {
		const source = path.join(MVHEVC_FIXTURES, 'multiview.mov');
		const multiview = (await multiviewOf(source))!;

		const write = async (carried: typeof multiview | undefined) => {
			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			const packets = new EncodedVideoPacketSource('hevc');
			output.addVideoTrack(packets);
			await output.start();
			await packets.add(
				new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x26, 0x01, 0xaf]), 'key', 0, 1 / 30),
				{
					decoderConfig: {
						codec: 'hvc1.1.6.L120.90',
						codedWidth: 1920,
						codedHeight: 1080,
						description: fromHex(HVCC_BASE),
						...(carried ? { multiview: carried } : {}),
					},
				},
			);
			await output.finalize();

			const file = path.join(workDir, `remux-${carried ? 'spatial' : 'plain'}.mp4`);
			writeFileSync(file, new Uint8Array(output.target.buffer!));
			return file;
		};

		const theirs = ffprobeSideData(source)['Stereo 3D']!;
		const ours = ffprobeSideData(await write(multiview))['Stereo 3D'];

		expect(ours).toBeDefined();
		for (const field of [
			'baseline', 'horizontal_disparity_adjustment', 'horizontal_field_of_view', 'primary_eye',
			'view', 'inverted',
		]) {
			expect(ours![field], field).toBe(theirs[field]);
		}

		// And the same track without the boxes has nothing for ffprobe to report, so the assertions
		// above are about what we wrote rather than about what ffprobe says of any HEVC track
		expect(ffprobeSideData(await write(undefined))['Stereo 3D']).toBeUndefined();
	});

	test.skipIf(!hasFfprobe)('dropping the hfov costs the field of view and nothing else', async () => {
		const source = path.join(MVHEVC_FIXTURES, 'multiview.mov');
		const multiview = (await multiviewOf(source))!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const packets = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(packets);
		await output.start();
		await packets.add(
			new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x26, 0x01, 0xaf]), 'key', 0, 1 / 30),
			{
				decoderConfig: {
					codec: 'hvc1.1.6.L120.90',
					codedWidth: 1920,
					codedHeight: 1080,
					description: fromHex(HVCC_BASE),
					multiview: { ...multiview, fieldOfViewMillidegrees: undefined },
				},
			},
		);
		await output.finalize();

		const file = path.join(workDir, 'remux-no-hfov.mp4');
		writeFileSync(file, new Uint8Array(output.target.buffer!));

		const stereo = ffprobeSideData(file)['Stereo 3D']!;
		// ffprobe prints an absent field of view as the zero rational rather than omitting it
		expect(stereo['horizontal_field_of_view']).toBe('0/1');
		expect(ffprobeSideData(source)['Stereo 3D']!['horizontal_field_of_view']).toBe('63400/1000');
		// Which is the whole of the loss: the baseline still arrives
		expect(Number(stereo['baseline'])).toBe(19240);
	});
});
