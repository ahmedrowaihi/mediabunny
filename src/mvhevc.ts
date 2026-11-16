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
import { bytesToHexString, readExpGolomb, toDataView, toUint8Array } from './misc';

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
	/** Advisory; see the note on {@link parseLhvcConfigRecord}. */
	minSpatialSegmentationIdc: number;
	/** Advisory; see the note on {@link parseLhvcConfigRecord}. */
	parallelismType: number;
	/** How many temporal sub-layers the layered stream has; zero where the writer did not say. */
	numTemporalLayers: number;
	/** Whether every picture's temporal sub-layer nests, as `sps_temporal_id_nesting_flag` states. */
	temporalIdNested: boolean;
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
 * `hvcC`'s own list (`libavformat/mov.c`, `mov_read_lhvc`). The fields between are the layered record
 * of ISO/IEC 14496-15 as GPAC writes and reads it (`gf_odf_hevc_cfg_read_bs`, `is_lhvc` branch):
 * four reserved bits, `min_spatial_segmentation_idc`, six reserved, `parallelismType`, two reserved,
 * `numTemporalLayers`, `temporalIdNested`, `lengthSizeMinusOne`, `numOfArrays`. FFmpeg reads none of
 * them, so treat the first two as advisory and the arrays as the substance.
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
			minSpatialSegmentationIdc: ((byte1 & 0x0f) << 8) | view.getUint8(2),
			parallelismType: view.getUint8(3) & 0x03,
			numTemporalLayers: (view.getUint8(4) >> 3) & 0x07,
			temporalIdNested: ((view.getUint8(4) >> 2) & 0x01) === 1,
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

// `vexu` - Video Extended Usage - is where Apple states what a stereo track actually is: which eyes
// are present, which is the hero, how far apart the cameras were, and what projection the picture is
// in. None of it is in the bitstream, so a packager that drops the box turns a spatial video into an
// ordinary one that happens to be two views wide.
//
// Layouts below are read off Apple's own spatial example rather than from prose:
//   vexu
//     eyes
//       stri  full box + 1 byte  : bit 0 has-left, bit 1 has-right
//       hero  full box + 1 byte  : 0 none, 1 left, 2 right
//       cams -> blin  full box + u32 : camera baseline in MICROmetres
//       cmfy -> dadj  full box + i32 : horizontal disparity adjustment
//     proj
//       prji  full box + 4CC  : rect, equi, hequ, fish

/**
 * How the picture is projected, as `prji` states it: rectilinear, equirectangular, half
 * equirectangular, fisheye, or parametric immersive.
 *
 * @public
 * @group Codecs
 */
export type VexuProjection = 'rect' | 'equi' | 'hequ' | 'fish' | 'prim';

// `prim` is parametric immersive, which HLS states as PROJ-PRIM in REQ-VIDEO-LAYOUT
// (draft-pantos-hls-rfc8216bis-22). Without it here a packager cannot tell one from an ordinary
// rectilinear stereo pair, and writes plain CH-STEREO for content that is not.
const PROJECTION_KINDS: readonly VexuProjection[] = ['rect', 'equi', 'hequ', 'fish', 'prim'];

const asProjection = (kind: string): VexuProjection | null =>
	PROJECTION_KINDS.find(known => known === kind) ?? null;

/**
 * Which eye a single-eye view belongs to, or which eye leads a stereo pair.
 *
 * @public
 * @group Codecs
 */
export type VexuEye = 'none' | 'left' | 'right';

/**
 * How two views are arranged within one decoded frame, as `pkin` states it: side by side, each view
 * half the frame's width, or over and under, each view half its height.
 *
 * @public
 * @group Codecs
 */
export type VexuPacking = 'side' | 'over';

const PACKING_KINDS: readonly VexuPacking[] = ['side', 'over'];

/**
 * What a `vexu` box says about a video track.
 *
 * @public
 * @group Codecs
 */
export type VexuInfo = {
	/** Whether a left-eye view is present. */
	hasLeftEye: boolean;
	/** Whether a right-eye view is present. */
	hasRightEye: boolean;
	/**
	 * Whether the two eyes are stored in the reverse of the default order, so the right view sits
	 * where the left one would. A renderer that ignores this shows each eye the other's picture.
	 */
	eyeViewsReversed: boolean;
	/** Whether views beyond the left and right eyes are present, such as a centreline view. */
	hasAdditionalViews: boolean;
	/** The eye to show when only one can be, where the track names one. */
	heroEye: VexuEye;
	/** Distance between the two cameras in micrometres, where `blin` states it. */
	baselineMicrometres: number | null;
	/**
	 * Horizontal disparity adjustment, where `dadj` states it: a signed value over -10000 to 10000,
	 * mapping -1.0 to 1.0 of a view's image width. Half of it is added to the left eye and
	 * subtracted from the right.
	 */
	disparityAdjustment: number | null;
	/**
	 * How two views share one decoded frame, where `pkin` states it. Null for a track whose views are
	 * separately coded, which is what MV-HEVC does.
	 */
	packing: VexuPacking | null;
	/** The projection, where `prji` states one. */
	projection: VexuProjection | null;
	/**
	 * The box types a reader must understand for the `vexu` to mean what it says, from the top-level
	 * `must`. The specification says to ignore the track when one of these is unrecognized, so a
	 * reader that finds a type here it does not know about should treat the track as unplayable
	 * rather than present it as flat video.
	 */
	requiredBoxTypes: string[];
};

const readU32At = (data: Uint8Array, at: number) =>
	data[at]! * 2 ** 24 + data[at + 1]! * 2 ** 16 + data[at + 2]! * 2 ** 8 + data[at + 3]!;

/** Walks the boxes directly inside `[at, end)`, calling back with each one's type and body range. */
const eachBox = (
	data: Uint8Array,
	at: number,
	end: number,
	visit: (type: string, bodyAt: number, bodyEnd: number) => void,
) => {
	while (at + 8 <= end) {
		const size = readU32At(data, at);
		if (size < 8 || at + size > end) {
			return;
		}

		const type = String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!);
		visit(type, at + 8, at + size);
		at += size;
	}
};

/**
 * Reads a `vexu` box payload - everything after its size and type.
 *
 * Returns null only when the payload is too short to be one. Everything inside is optional, so a
 * `vexu` carrying nothing this understands comes back with every field at its default rather than as
 * a failure: Apple keeps adding boxes here, and a reader that refused unknown ones would break on the
 * next release.
 *
 * @public
 * @group Codecs
 */
export const parseVexuBox = (data: Uint8Array): VexuInfo | null => {
	if (data.length < 8) {
		return null;
	}

	const info: VexuInfo = {
		hasLeftEye: false,
		hasRightEye: false,
		eyeViewsReversed: false,
		hasAdditionalViews: false,
		heroEye: 'none',
		baselineMicrometres: null,
		disparityAdjustment: null,
		packing: null,
		projection: null,
		requiredBoxTypes: [],
	};

	eachBox(data, 0, data.length, (type, bodyAt, bodyEnd) => {
		if (type === 'must') {
			// A full box, then a four-octet box type per entry; a zero entry is reserved padding,
			// which is also what the version and flags octets read as, so they skip themselves
			for (let at = bodyAt + 4; at + 4 <= bodyEnd; at += 4) {
				if (readU32At(data, at) !== 0) {
					info.requiredBoxTypes.push(
						String.fromCharCode(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!),
					);
				}
			}
		} else if (type === 'eyes') {
			eachBox(data, bodyAt, bodyEnd, (eyeType, eyeAt, eyeEnd) => {
				// Each of these is a full box, so four octets of version and flags come first
				const payloadAt = eyeAt + 4;
				if (eyeType === 'stri' && payloadAt < eyeEnd) {
					// reserved(4) eye_views_reversed has_additional_views has_right_eye_view
					// has_left_eye_view - the left eye is the LOW bit, which a file carrying both
					// eyes cannot tell you
					const flags = data[payloadAt]!;
					info.hasLeftEye = (flags & 0x01) !== 0;
					info.hasRightEye = (flags & 0x02) !== 0;
					info.hasAdditionalViews = (flags & 0x04) !== 0;
					info.eyeViewsReversed = (flags & 0x08) !== 0;
				} else if (eyeType === 'hero' && payloadAt < eyeEnd) {
					const eye = data[payloadAt]!;
					info.heroEye = eye === 1 ? 'left' : eye === 2 ? 'right' : 'none';
				} else if (eyeType === 'cams') {
					eachBox(data, eyeAt, eyeEnd, (camType, camAt, camEnd) => {
						if (camType === 'blin' && camAt + 8 <= camEnd) {
							info.baselineMicrometres = readU32At(data, camAt + 4);
						}
					});
				} else if (eyeType === 'cmfy') {
					eachBox(data, eyeAt, eyeEnd, (comfyType, comfyAt, comfyEnd) => {
						if (comfyType === 'dadj' && comfyAt + 8 <= comfyEnd) {
							info.disparityAdjustment = readU32At(data, comfyAt + 4) | 0;
						}
					});
				}
			});
		} else if (type === 'pack') {
			eachBox(data, bodyAt, bodyEnd, (packType, packAt, packEnd) => {
				if (packType === 'pkin' && packAt + 8 <= packEnd) {
					const kind = String.fromCharCode(
						data[packAt + 4]!,
						data[packAt + 5]!,
						data[packAt + 6]!,
						data[packAt + 7]!,
					);
					info.packing = PACKING_KINDS.find(known => known === kind) ?? null;
				}
			});
		} else if (type === 'proj') {
			eachBox(data, bodyAt, bodyEnd, (projType, projAt, projEnd) => {
				if (projType === 'prji' && projAt + 8 <= projEnd) {
					const kind = String.fromCharCode(
						data[projAt + 4]!,
						data[projAt + 5]!,
						data[projAt + 6]!,
						data[projAt + 7]!,
					);
					info.projection = asProjection(kind);
				}
			});
		}
	});

	return info;
};

/** Octets of `hvcC` before its `numOfArrays` field. */
const HVCC_NUM_ARRAYS_OFFSET = 22;

/**
 * The NAL unit arrays of an `hvcC` record - the base layer's parameter sets.
 *
 * The companion to {@link parseLhvcConfigRecord}, and the reason it exists separately: the two
 * records carry their arrays in the same format but behind different headers, `hvcC`'s being
 * twenty-two octets to `lhvC`'s six. Reading one with the other's offset lands inside a parameter set
 * and produces arrays that parse without complaint, so a consumer wanting the base layer's sets needs
 * a function that knows which record it is holding.
 *
 * @public
 * @group Codecs
 */
export const parseHvccConfigRecord = (data: Uint8Array): LhvcConfig['arrays'] | null => {
	// No length guard: reading past the end throws, which the catch turns into the same null. One that
	// looked like it was doing the checking would be a claim nothing can test.
	try {
		const view = toDataView(data);
		const numOfArrays = view.getUint8(HVCC_NUM_ARRAYS_OFFSET);
		const { arrays } = readHevcNalUnitArrays(data, view, HVCC_NUM_ARRAYS_OFFSET + 1, numOfArrays);
		return arrays;
	} catch {
		return null;
	}
};

/**
 * Writes an `lhvC` configuration record, the inverse of {@link parseLhvcConfigRecord}.
 *
 * **Not a byte-exact rewriter.** A real record carries octets this library does not model — the
 * published drafts disagree about them and FFmpeg reads none of them — so what it does not model it
 * writes as zero. That is sound because nothing ever re-serialises someone else's record: a track that
 * arrived with an `lhvC` has its bytes written through verbatim, and this is for a track that did not.
 *
 * @public
 * @group Codecs
 */
export const buildLhvcConfigRecord = (config: LhvcConfig): Uint8Array => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('config must be an object.');
	}
	if (!Array.isArray(config.arrays)) {
		throw new TypeError('config.arrays must be an array.');
	}

	let length = LHVC_HEADER_SIZE;
	for (const array of config.arrays) {
		length += 3; // the array header and its unit count
		for (const nalUnit of array.nalUnits) {
			length += 2 + nalUnit.byteLength;
		}
	}

	const data = new Uint8Array(length);
	const view = toDataView(data);

	view.setUint8(0, config.configurationVersion);
	// Every reserved run in this record is specified as all ones, which is what GPAC and Apple both
	// write; zeros here read as a record whose reserved bits are wrong
	view.setUint8(1, 0xf0 | ((config.minSpatialSegmentationIdc >> 8) & 0x0f));
	view.setUint8(2, config.minSpatialSegmentationIdc & 0xff);
	view.setUint8(3, 0xfc | (config.parallelismType & 0x03));
	view.setUint8(4, 0xc0
	| ((config.numTemporalLayers & 0x07) << 3)
	| ((config.temporalIdNested ? 1 : 0) << 2)
	| (config.lengthSizeMinusOne & 0x03));
	view.setUint8(5, config.arrays.length);

	let offset = LHVC_HEADER_SIZE;
	for (const array of config.arrays) {
		view.setUint8(offset++, ((array.arrayCompleteness & 0x01) << 7) | (array.nalUnitType & 0x3f));
		view.setUint16(offset, array.nalUnits.length, false);
		offset += 2;

		for (const nalUnit of array.nalUnits) {
			view.setUint16(offset, nalUnit.byteLength, false);
			offset += 2;
			data.set(nalUnit, offset);
			offset += nalUnit.byteLength;
		}
	}

	return data;
};

/** The NAL unit types an `lhvC` carries, in the order a record states them. */
const LHVC_PARAMETER_SET_TYPES = [
	HevcNalUnitType.VPS_NUT,
	HevcNalUnitType.SPS_NUT,
	HevcNalUnitType.PPS_NUT,
	HevcNalUnitType.PREFIX_SEI_NUT,
];

/**
 * Builds an `lhvC` configuration from the bitstream itself, for a layered track that arrived without
 * one.
 *
 * An MV-HEVC track demuxed from a transport stream, or read as an Annex B elementary stream, has no
 * decoder configuration at all: its parameter sets are in band and nothing declares them. Writing it
 * into an MP4 needs an `lhvC`, because `hvcC` describes the base layer alone and a reader given only
 * that drops every layer above it - the file plays, with one eye, which is why nothing fails loudly.
 *
 * Only parameter sets **above the base layer** are collected, since those are exactly what `hvcC` does
 * not carry. Sets repeat at every IRAP, so identical units are collected once. Returns `null` when the
 * packets carry nothing above layer 0, which is the answer for ordinary HEVC.
 *
 * `lengthSizeMinusOne` is taken from the base layer's configuration where one is given, since both
 * records describe the same track's sample layout.
 *
 * @public
 * @group Codecs
 */
export const lhvcConfigFromBitstream = (options: {
	/** The access units to read, in any order; one IRAP is enough. */
	packets: Uint8Array[];
	/** The base layer's configuration, which says how the packets are framed. */
	decoderConfig: VideoDecoderConfig;
}): LhvcConfig | null => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (!Array.isArray(options.packets)) {
		throw new TypeError('options.packets must be an array.');
	}
	if (!options.decoderConfig || typeof options.decoderConfig !== 'object') {
		throw new TypeError('options.decoderConfig must be a VideoDecoderConfig.');
	}

	const byType = new Map<number, Uint8Array[]>();
	const seen = new Set<string>();

	for (const packetData of options.packets) {
		for (const location of iterateHevcNalUnits(packetData, options.decoderConfig)) {
			if (location.length < 2) {
				continue;
			}

			const firstByte = packetData[location.offset]!;
			const secondByte = packetData[location.offset + 1]!;
			if (extractLayerIdForHevc(firstByte, secondByte) === 0) {
				continue; // The base layer's own sets are the `hvcC`'s business
			}

			const nalUnitType = extractNalUnitTypeForHevc(firstByte);
			if (!LHVC_PARAMETER_SET_TYPES.includes(nalUnitType)) {
				continue; // Slice data is not configuration
			}

			const nalUnit = packetData.subarray(location.offset, location.offset + location.length);
			const key = `${nalUnitType}:${bytesToHexString(nalUnit)}`;
			if (seen.has(key)) {
				continue; // The same set again, at the next IRAP
			}
			seen.add(key);

			const list = byType.get(nalUnitType) ?? [];
			list.push(nalUnit.slice());
			byType.set(nalUnitType, list);
		}
	}

	if (byType.size === 0) {
		return null;
	}

	const description = options.decoderConfig.description;
	// `hvcC` octet 21 and `lhvC` octet 4 end in the same three fields, so the base layer's record
	// states them rather than this having to guess
	const base = description ? parseHvccTemporalAndLengthFields(toUint8Array(description)) : null;

	return {
		configurationVersion: 1,
		minSpatialSegmentationIdc: 0,
		parallelismType: 0,
		// Zero is "not stated" rather than "no layers", so an unstated count stays unstated
		numTemporalLayers: base?.numTemporalLayers ?? 0,
		temporalIdNested: base?.temporalIdNested ?? false,
		lengthSizeMinusOne: base?.lengthSizeMinusOne ?? 3,
		// The collection loop above decides WHAT goes in; this only decides the order, so that a
		// record lists its sets the way one written by hand does
		arrays: [...byType.keys()]
			.sort((a, b) => LHVC_PARAMETER_SET_TYPES.indexOf(a) - LHVC_PARAMETER_SET_TYPES.indexOf(b))
			.map(type => ({
				// Every unit of this type that the packets carried, which is all this can promise
				arrayCompleteness: 0,
				nalUnitType: type,
				nalUnits: byType.get(type)!,
			})),
	};
};

/** Octet 21 of an `hvcC` ends with `numTemporalLayers`, `temporalIdNested` and `lengthSizeMinusOne`. */
const parseHvccTemporalAndLengthFields = (data: Uint8Array) =>
	data.byteLength > 21
		? {
				numTemporalLayers: (data[21]! >> 3) & 0x07,
				temporalIdNested: ((data[21]! >> 2) & 0x01) === 1,
				lengthSizeMinusOne: data[21]! & 0x03,
			}
		: null;

const boxBytes = (type: string, body: number[]): number[] => {
	const size = 8 + body.length;
	return [
		(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
		type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3),
		...body,
	];
};

const u32Bytes = (value: number): number[] =>
	[(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/**
 * Writes a `vexu` box payload - everything after its own size and type - from what it should say.
 *
 * Only the parts the info states are written: a `vexu` is a container of optional boxes, and one that
 * claims a baseline or a hero eye it does not know would be read as fact. An info stating no eyes at
 * all produces no `eyes` box, and a `vexu` with nothing in it is not written at all.
 *
 * The inverse of {@link parseVexuBox}, for the fields that function models.
 *
 * @public
 * @group Codecs
 */
export const buildVexuBox = (info: VexuInfo): Uint8Array | null => {
	if (!info || typeof info !== 'object') {
		throw new TypeError('info must be an object.');
	}

	const eyes: number[] = [];

	if (info.hasLeftEye || info.hasRightEye || info.hasAdditionalViews) {
		// A full box: version 0 and no flags, then the one octet of eye flags
		eyes.push(...boxBytes('stri', [0, 0, 0, 0,
			(info.hasLeftEye ? 0x01 : 0)
			| (info.hasRightEye ? 0x02 : 0)
			| (info.hasAdditionalViews ? 0x04 : 0)
			| (info.eyeViewsReversed ? 0x08 : 0),
		]));
	}

	if (info.heroEye !== 'none') {
		eyes.push(...boxBytes('hero', [0, 0, 0, 0, info.heroEye === 'left' ? 1 : 2]));
	}

	if (info.baselineMicrometres !== null) {
		eyes.push(...boxBytes('cams', boxBytes('blin', [0, 0, 0, 0, ...u32Bytes(info.baselineMicrometres)])));
	}

	if (info.disparityAdjustment !== null) {
		eyes.push(...boxBytes(
			'cmfy',
			boxBytes('dadj', [0, 0, 0, 0, ...u32Bytes(info.disparityAdjustment >>> 0)]),
		));
	}

	const payload: number[] = [];

	// A `must` names its peers, so it comes before them, as the box's syntax states. These two fields
	// postdate the first release of this function, so an info written against that release still
	// builds rather than throwing.
	const requiredBoxTypes = info.requiredBoxTypes ?? [];
	const packing = info.packing ?? null;

	if (requiredBoxTypes.length > 0) {
		payload.push(...boxBytes('must', [0, 0, 0, 0, ...requiredBoxTypes.flatMap(type => [
			type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3),
		])]));
	}

	if (eyes.length > 0) {
		payload.push(...boxBytes('eyes', eyes));
	}

	if (packing !== null) {
		const kind = packing;
		payload.push(...boxBytes('pack', boxBytes('pkin', [
			0, 0, 0, 0,
			kind.charCodeAt(0), kind.charCodeAt(1), kind.charCodeAt(2), kind.charCodeAt(3),
		])));
	}

	if (info.projection !== null) {
		const kind = info.projection;
		payload.push(...boxBytes('proj', boxBytes('prji', [
			0, 0, 0, 0,
			kind.charCodeAt(0), kind.charCodeAt(1), kind.charCodeAt(2), kind.charCodeAt(3),
		])));
	}

	return payload.length > 0 ? new Uint8Array(payload) : null;
};

/**
 * What a `vexu` can honestly say about a track from its bitstream alone, for one that arrived without
 * the box.
 *
 * A multiview VPS extension states how many views there are and that they are views - which is enough
 * to say both eyes are present, and is what tells a player the track is stereoscopic at all. It states
 * nothing about **which** view is which eye, how far apart the cameras were, or what projection was
 * used: `hero`, `blin`, `dadj` and `prji` come from the camera, not from the encoder, and are left
 * unset rather than guessed. Fill them in from the capture's own metadata if you have it.
 *
 * Returns `null` unless the extension describes exactly two views, since a `stri` saying both eyes are
 * present would be a claim about a one-view or many-view stream rather than a description of it.
 *
 * @public
 * @group Codecs
 */
export const vexuInfoFromVpsExtension = (layers: HevcVpsLayerInfo): VexuInfo | null => {
	if (!layers || typeof layers !== 'object') {
		throw new TypeError('layers must be an object.');
	}
	if (!layers.isMultiview || layers.numViews !== 2) {
		return null;
	}

	return {
		hasLeftEye: true,
		hasRightEye: true,
		eyeViewsReversed: false,
		hasAdditionalViews: false,
		heroEye: 'none',
		baselineMicrometres: null,
		disparityAdjustment: null,
		// Separately coded views are the opposite of packed ones
		packing: null,
		projection: null,
		requiredBoxTypes: [],
	};
};
