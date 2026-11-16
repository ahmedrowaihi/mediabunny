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

import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import {
	extractLayerIdForHevc,
	extractTemporalIdForHevc,
	inspectHevcLayers,
	parseHevcVpsExtension,
	parseLhvcConfigRecord,
} from '../../src/mvhevc.js';
import { FilePathSource } from '../../src/source.js';

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
// (libavformat/mov.c, mov_read_lhvc). The four fields in between come from the MPEG working document;
// published drafts disagree about them, so the tests below assert the arrays and the count hard, and
// the advisory fields only against a record this test built.

/** An `lhvC` payload: the six-octet header, then arrays in hvcC's format. */
const lhvcRecord = (
	header: {
		completeRepresentation: boolean;
		minSpatialSegmentationIdc: number;
		parallelismType: number;
		lengthSizeMinusOne: number;
	},
	arrays: { complete: boolean; nalUnitType: number; nalUnits: number[][] }[],
) => {
	const out: number[] = [
		1, // configurationVersion
		(header.completeRepresentation ? 0x80 : 0) | 0x70 | ((header.minSpatialSegmentationIdc >> 8) & 0x0f),
		header.minSpatialSegmentationIdc & 0xff,
		0xfc | header.parallelismType,
		0xfc | header.lengthSizeMinusOne,
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
			completeRepresentation: true,
			minSpatialSegmentationIdc: 0,
			parallelismType: 0,
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
	expect(parsed.completeRepresentation).toBe(true);
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
			completeRepresentation: false,
			minSpatialSegmentationIdc: 0x123,
			parallelismType: 2,
			lengthSizeMinusOne: 1,
		},
		[],
	);

	expect(parseLhvcConfigRecord(record)).toEqual({
		configurationVersion: 1,
		completeRepresentation: false,
		// 12 bits spanning two octets, four of them behind the reserved bits
		minSpatialSegmentationIdc: 0x123,
		parallelismType: 2,
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
