/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MV-HEVC carries more than one view - a stereo pair, usually - in a single HEVC bitstream, by putting
// each view on its own layer. Nothing about the samples says so: a decoder that ignores layers decodes
// the base view and never knows the others were there, which is exactly the design, and why a stereo
// file plays as flat video everywhere that does not look.
//
// What marks a layer is `nuh_layer_id` in the two-byte NAL unit header (H.265 7.3.1.2):
//
//   byte 0:  forbidden_zero_bit(1) nal_unit_type(6) nuh_layer_id's high bit(1)
//   byte 1:  nuh_layer_id's low 5 bits(5) nuh_temporal_id_plus1(3)
//
// so the field straddles the byte boundary, which is the only reason reading it is worth a function.

import { Bitstream } from '../shared/bitstream';
import {
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateHevcNalUnits,
	parseProfileTierLevel,
	readHevcNalUnitArrays,
	removeEmulationPreventionBytes,
} from './codec-data';
import { readExpGolomb, toDataView } from './misc';

/**
 * `nuh_layer_id` from the two bytes of an HEVC NAL unit header (H.265 7.3.1.2). The field spans the
 * boundary: one bit at the end of the first byte, five at the start of the second.
 *
 * @public
 * @group Codecs
 */
export const extractLayerIdForHevc = (firstByte: number, secondByte: number) =>
	((firstByte & 0x01) << 5) | (secondByte >> 3);

/**
 * `nuh_temporal_id_plus1 - 1` from the second byte of an HEVC NAL unit header. Zero is the base
 * temporal sub-layer.
 *
 * @public
 * @group Codecs
 */
export const extractTemporalIdForHevc = (secondByte: number) => (secondByte & 0x07) - 1;

/**
 * What an HEVC packet's layers say about it.
 *
 * @public
 * @group Codecs
 */
export type HevcLayerInfo = {
	/** Every distinct `nuh_layer_id` the packet carries, ascending. The base layer is 0. */
	layerIds: number[];
	/**
	 * Whether anything above the base layer is present, which is what makes a bitstream MV-HEVC (or
	 * SHVC - the layer mechanism is shared, and the bitstream alone does not distinguish them).
	 */
	isLayered: boolean;
	/** The highest `nuh_temporal_id_plus1 - 1` seen, which is the packet's temporal sub-layer depth. */
	highestTemporalId: number;
};

/**
 * Reads the layers out of one HEVC packet.
 *
 * A stereoscopic MV-HEVC stream looks like ordinary HEVC to anything that does not read
 * `nuh_layer_id`: the base view decodes on its own and the second view rides along on layer 1. This is
 * how to tell the two apart, and it has to be asked of a *packet* rather than of the decoder
 * configuration, because `hvcC` describes the base layer only - a layered stream's extra views are
 * declared in an `lhvC` box that this does not read, and in the VPS extension.
 *
 * The same layer mechanism carries SHVC's scalability layers, so `isLayered` means "more than the base
 * layer is present", not "this is stereo". What the layers *are* is in the VPS extension.
 *
 * @public
 * @group Codecs
 */
export const inspectHevcLayers = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
): HevcLayerInfo => {
	const layerIds = new Set<number>();
	let highestTemporalId = -1;

	for (const location of iterateHevcNalUnits(packetData, decoderConfig)) {
		// A NAL unit shorter than its own header says nothing; a truncated packet should not be read as
		// a layered one
		if (location.length < 2) {
			continue;
		}

		const firstByte = packetData[location.offset]!;
		const secondByte = packetData[location.offset + 1]!;

		layerIds.add(extractLayerIdForHevc(firstByte, secondByte));

		const temporalId = extractTemporalIdForHevc(secondByte);
		if (temporalId > highestTemporalId) {
			highestTemporalId = temporalId;
		}
	}

	const sorted = [...layerIds].sort((a, b) => a - b);
	return {
		layerIds: sorted,
		isLayered: sorted.some(id => id > 0),
		highestTemporalId: Math.max(0, highestTemporalId),
	};
};

/**
 * The `lhvC` box's layered HEVC configuration record.
 *
 * @public
 * @group Codecs
 */
export type LhvcConfig = {
	/** 1 in every record written so far. */
	configurationVersion: number;
	/**
	 * Whether this track is part of a complete encoded set. A track with it clear can be removed
	 * without losing any of the original encoded data.
	 */
	completeRepresentation: boolean;
	/** Advisory; see the note on {@link parseLhvcConfigRecord}. */
	minSpatialSegmentationIdc: number;
	/** Advisory; see the note on {@link parseLhvcConfigRecord}. */
	parallelismType: number;
	/** Length prefix size minus one, as in `hvcC`. */
	lengthSizeMinusOne: number;
	/**
	 * The parameter sets for the layers above the base one - typically the VPS extension, and an SPS
	 * and PPS per additional view. These are what the base layer's `hvcC` does **not** carry.
	 */
	arrays: {
		/** 1 when the array holds every NAL unit of its type in the stream. */
		arrayCompleteness: number;
		/** The HEVC NAL unit type every unit in this array has. */
		nalUnitType: number;
		/** The units themselves, without length prefixes. */
		nalUnits: Uint8Array[];
	}[];
};

/** Octets of `lhvC` before its NAL unit arrays begin. */
const LHVC_HEADER_SIZE = 6;

/**
 * Parses an `lhvC` box's payload, which is where a layered HEVC track declares the parameter sets its
 * extra layers need. The base layer's `hvcC` describes only the base layer, so a stereo track's second
 * view is configured here and nowhere else.
 *
 * The record is six octets and then NAL unit arrays laid out exactly as `hvcC`'s are. That much is
 * corroborated by FFmpeg, whose demuxer reads `numOfArrays` at octet 5 and appends these arrays onto
 * `hvcC`'s own list (`libavformat/mov.c`, `mov_read_lhvc`). The four fields between are taken from the
 * MPEG working document's field order; published drafts disagree about them, and FFmpeg reads none of
 * them, so treat them as advisory and the arrays as the substance.
 *
 * Returns null for a record too short to hold its own header, or one whose arrays run past the end.
 *
 * @public
 * @group Codecs
 */
export const parseLhvcConfigRecord = (data: Uint8Array): LhvcConfig | null => {
	if (data.byteLength < LHVC_HEADER_SIZE) {
		return null;
	}

	try {
		const view = toDataView(data);

		const configurationVersion = view.getUint8(0);
		const byte1 = view.getUint8(1);
		const numOfArrays = view.getUint8(5);

		const { arrays, offset } = readHevcNalUnitArrays(data, view, LHVC_HEADER_SIZE, numOfArrays);
		if (offset > data.byteLength) {
			return null; // an array claimed more bytes than the box holds
		}

		return {
			configurationVersion,
			completeRepresentation: ((byte1 >> 7) & 0x01) === 1,
			minSpatialSegmentationIdc: ((byte1 & 0x0f) << 8) | view.getUint8(2),
			parallelismType: view.getUint8(3) & 0x03,
			lengthSizeMinusOne: view.getUint8(4) & 0x03,
			arrays,
		};
	} catch {
		return null; // a truncated record reads past its end rather than reporting a short one
	}
};

/**
 * What the VPS extension says about a layered stream's layers.
 *
 * @public
 * @group Codecs
 */
export type HevcVpsLayerInfo = {
	/** `nuh_layer_id` of each layer the VPS declares, the base layer first. */
	layerIds: number[];
	/**
	 * Whether the layers are **views** rather than scales. This is `scalability_mask_flag[1]`,
	 * `ViewOrderIdx` in H.265 Table F.1 - the one thing that separates MV-HEVC from SHVC, and the
	 * reason a bitstream's layer ids alone cannot tell you a file is stereoscopic.
	 */
	isMultiview: boolean;
	/** `ViewOrderIdx` per layer, aligned with {@link HevcVpsLayerInfo.layerIds}; 0 for the base layer. */
	viewOrderIdx: number[];
	/** How many views the VPS declares, which for a stereo pair is 2. */
	numViews: number;
	/** `view_id_val` as the VPS states it, one per view. Empty where `view_id_len` is 0. */
	viewIds: number[];
	/**
	 * For each layer after the base one, the layers it predicts from, by `nuh_layer_id`. A stereo
	 * stream with inter-view prediction has the second view depending on the first.
	 */
	directDependencies: number[][];
};

/**
 * Reads the layer declarations out of an HEVC video parameter set.
 *
 * `inspectHevcLayers` can tell you a bitstream carries more than the base layer; only the VPS says
 * *what* the layers are. `isMultiview` here is the answer to "is this stereo rather than scalable",
 * and `numViews` and `viewIds` are what a player needs to pick an eye.
 *
 * Returns null when the unit is not a VPS, when it declares no extension (so there is nothing beyond
 * the base layer), or when the VPS carries HRD parameters - that structure is not parsed here, and
 * guessing its length would silently shift every field after it.
 *
 * @public
 * @group Codecs
 */
export const parseHevcVpsExtension = (vps: Uint8Array): HevcVpsLayerInfo | null => {
	try {
		if (vps.byteLength < 2 || extractNalUnitTypeForHevc(vps[0]!) !== HevcNalUnitType.VPS_NUT) {
			return null;
		}

		const bitstream = new Bitstream(removeEmulationPreventionBytes(vps));
		bitstream.skipBits(16); // NAL unit header

		bitstream.readBits(4); // vps_video_parameter_set_id
		const baseLayerInternal = bitstream.readBits(1);
		bitstream.readBits(1); // vps_base_layer_available_flag
		const maxLayersMinus1 = bitstream.readBits(6);
		const maxSubLayersMinus1 = bitstream.readBits(3);
		bitstream.readBits(1); // vps_temporal_id_nesting_flag
		bitstream.readBits(16); // vps_reserved_0xffff_16bits

		parseProfileTierLevel(bitstream, maxSubLayersMinus1);

		const subLayerOrderingInfo = bitstream.readBits(1);
		for (let i = subLayerOrderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
			readExpGolomb(bitstream); // vps_max_dec_pic_buffering_minus1
			readExpGolomb(bitstream); // vps_max_num_reorder_pics
			readExpGolomb(bitstream); // vps_max_latency_increase_plus1
		}

		const maxLayerId = bitstream.readBits(6);
		const numLayerSetsMinus1 = readExpGolomb(bitstream);
		for (let i = 1; i <= numLayerSetsMinus1; i++) {
			for (let j = 0; j <= maxLayerId; j++) {
				bitstream.readBits(1); // layer_id_included_flag
			}
		}

		if (bitstream.readBits(1)) { // vps_timing_info_present_flag
			bitstream.readBits(32); // vps_num_units_in_tick
			bitstream.readBits(32); // vps_time_scale
			if (bitstream.readBits(1)) { // vps_poc_proportional_to_timing_flag
				readExpGolomb(bitstream); // vps_num_ticks_poc_diff_one_minus1
			}
			if (readExpGolomb(bitstream) > 0) { // vps_num_hrd_parameters
				// hrd_parameters() is not parsed here, and its length is not a constant - skipping it by
				// guess would land every field below on the wrong bit and report confident nonsense
				return null;
			}
		}

		if (!bitstream.readBits(1)) { // vps_extension_flag
			return null; // no extension, so nothing above the base layer is declared
		}

		// vps_extension_alignment_bit_equal_to_one, until byte aligned
		while (bitstream.pos % 8 !== 0) {
			bitstream.readBits(1);
		}

		// F.7.3.2.1.1 opens with a profile_tier_level whose profilePresentFlag is 0 - it begins at the
		// level, not the profile. Reading the profile's 88 bits here is what makes the scalability masks
		// below come out as noise.
		if (maxLayersMinus1 > 0 && baseLayerInternal) {
			parseProfileTierLevel(bitstream, maxSubLayersMinus1, false);
		}

		const splittingFlag = bitstream.readBits(1);

		const scalabilityMask: number[] = [];
		for (let i = 0; i < 16; i++) {
			scalabilityMask.push(bitstream.readBits(1));
		}
		const numScalabilityTypes = scalabilityMask.reduce((sum, flag) => sum + flag, 0);

		const dimensionIdLen: number[] = [];
		for (let j = 0; j < numScalabilityTypes - splittingFlag; j++) {
			dimensionIdLen.push(bitstream.readBits(3) + 1);
		}

		const nuhLayerIdPresent = bitstream.readBits(1);

		const layerIds = [0];
		const dimensionIds: number[][] = [[]];
		for (let i = 1; i <= maxLayersMinus1; i++) {
			layerIds.push(nuhLayerIdPresent ? bitstream.readBits(6) : i);

			const dimensions: number[] = [];
			if (!splittingFlag) {
				for (let j = 0; j < numScalabilityTypes; j++) {
					dimensions.push(bitstream.readBits(dimensionIdLen[j]!));
				}
			}
			dimensionIds.push(dimensions);
		}

		// Table F.1: index 1 is ViewOrderIdx. Its place in each layer's dimension_id list is the number
		// of scalability types declared before it.
		const isMultiview = scalabilityMask[1] === 1;
		const viewOrderIdxAt = scalabilityMask[0] ?? 0;
		const viewOrderIdx = dimensionIds.map(dimensions =>
			isMultiview ? (dimensions[viewOrderIdxAt] ?? 0) : 0);
		const numViews = 1 + Math.max(0, ...viewOrderIdx);

		const viewIdLen = bitstream.readBits(4);
		const viewIds: number[] = [];
		if (viewIdLen > 0) {
			for (let i = 0; i < numViews; i++) {
				viewIds.push(bitstream.readBits(viewIdLen));
			}
		}

		const directDependencies: number[][] = [];
		for (let i = 1; i <= maxLayersMinus1; i++) {
			const dependsOn: number[] = [];
			for (let j = 0; j < i; j++) {
				if (bitstream.readBits(1)) {
					dependsOn.push(layerIds[j]!);
				}
			}
			directDependencies.push(dependsOn);
		}

		return { layerIds, isMultiview, viewOrderIdx, numViews, viewIds, directDependencies };
	} catch {
		return null; // a truncated VPS reads past its end rather than reporting half a parse
	}
};
