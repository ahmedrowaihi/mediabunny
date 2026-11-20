/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Which pictures a decoder still holds as references, after a run of coded samples.
//
// A gap filler has to name the picture it copies, and the only name a reference list understands is
// one derived from the marking process: `frame_num` distances for AVC short-term pictures, picture
// order counts for HEVC. That process is not a function of the slice headers alone - a sliding
// window depends on how many references are already held, and `mmco` overrides the window outright -
// so it has to be run forward over the samples rather than inferred from the last one.
//
// The parameter-set parsing lives here rather than beside the writer because both the writer and this
// need it, and a second copy would be a second opinion.

import { Bitstream } from '../shared/bitstream';
import { removeEmulationPreventionBytes, parseHevcSps, type HevcSpsInfo } from './codec-data';
import { readExpGolomb, readSignedExpGolomb, toUint8Array } from './misc';

/** What a skip slice needs out of an AVC SPS. */
/** @internal */
export type AvcSps = {
	id: number;
	separateColourPlaneFlag: boolean;
	log2MaxFrameNum: number;
	picOrderCntType: number;
	log2MaxPicOrderCntLsb: number;
	deltaPicOrderAlwaysZeroFlag: boolean;
	frameMbsOnlyFlag: boolean;
	picSizeInMbs: number;
	maxNumRefFrames: number;
	gapsInFrameNumValueAllowedFlag: boolean;
	chromaFormatIdc: number;
};

/** What a skip slice needs out of an AVC PPS. */
/** @internal */
export type AvcPps = {
	id: number;
	spsId: number;
	entropyCodingModeFlag: boolean;
	bottomFieldPicOrderInFramePresentFlag: boolean;
	numRefIdxL0ActiveMinus1: number;
	weightedPredFlag: boolean;
	weightedBipredIdc: number;
	picInitQpMinus26: number;
	deblockingFilterControlPresentFlag: boolean;
	redundantPicCntPresentFlag: boolean;
	chromaFormatIdc: number;
};

const AVC_HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

const skipScalingList = (bs: Bitstream, size: number) => {
	let lastScale = 8;
	let nextScale = 8;
	for (let i = 0; i < size; i++) {
		if (nextScale !== 0) {
			nextScale = (lastScale + readSignedExpGolomb(bs) + 256) % 256;
		}
		lastScale = nextScale === 0 ? lastScale : nextScale;
	}
};

/** @internal */
export const parseAvcSpsForSkip = (nal: Uint8Array): AvcSps | null => {
	try {
		const bs = new Bitstream(removeEmulationPreventionBytes(nal.subarray(1)));
		const profileIdc = bs.readBits(8);
		bs.skipBits(16); // constraint flags, reserved, level_idc
		const id = readExpGolomb(bs);

		let chromaFormatIdc = 1;
		let separateColourPlaneFlag = false;
		if (AVC_HIGH_PROFILES.includes(profileIdc)) {
			chromaFormatIdc = readExpGolomb(bs);
			if (chromaFormatIdc === 3) {
				separateColourPlaneFlag = bs.readBits(1) === 1;
			}
			readExpGolomb(bs); // bit_depth_luma_minus8
			readExpGolomb(bs); // bit_depth_chroma_minus8
			bs.skipBits(1); // qpprime_y_zero_transform_bypass_flag
			if (bs.readBits(1) === 1) {
				const count8x8 = chromaFormatIdc === 3 ? 6 : 2;
				for (let i = 0; i < 6; i++) {
					if (bs.readBits(1) === 1) skipScalingList(bs, 16);
				}
				for (let i = 0; i < count8x8; i++) {
					if (bs.readBits(1) === 1) skipScalingList(bs, 64);
				}
			}
		}

		const log2MaxFrameNum = readExpGolomb(bs) + 4;
		const picOrderCntType = readExpGolomb(bs);
		let log2MaxPicOrderCntLsb = 0;
		let deltaPicOrderAlwaysZeroFlag = false;
		if (picOrderCntType === 0) {
			log2MaxPicOrderCntLsb = readExpGolomb(bs) + 4;
		} else if (picOrderCntType === 1) {
			deltaPicOrderAlwaysZeroFlag = bs.readBits(1) === 1;
			readSignedExpGolomb(bs);
			readSignedExpGolomb(bs);
			const count = readExpGolomb(bs);
			for (let i = 0; i < count; i++) readSignedExpGolomb(bs);
		}

		const maxNumRefFrames = readExpGolomb(bs);
		const gapsInFrameNumValueAllowedFlag = bs.readBits(1) === 1;
		const picWidthInMbs = readExpGolomb(bs) + 1;
		const picHeightInMapUnits = readExpGolomb(bs) + 1;
		const frameMbsOnlyFlag = bs.readBits(1) === 1;

		return {
			id,
			separateColourPlaneFlag,
			log2MaxFrameNum,
			picOrderCntType,
			log2MaxPicOrderCntLsb,
			deltaPicOrderAlwaysZeroFlag,
			frameMbsOnlyFlag,
			maxNumRefFrames,
			gapsInFrameNumValueAllowedFlag,
			chromaFormatIdc,
			// A field picture is half a frame's macroblocks; these frames are always coded as frames.
			picSizeInMbs: picWidthInMbs * picHeightInMapUnits * (frameMbsOnlyFlag ? 1 : 2),
		};
	} catch {
		return null;
	}
};

/** @internal */
export const parseAvcPpsForSkip = (nal: Uint8Array, chromaFormatIdc: number): AvcPps | null => {
	try {
		const bs = new Bitstream(removeEmulationPreventionBytes(nal.subarray(1)));
		const id = readExpGolomb(bs);
		const spsId = readExpGolomb(bs);
		const entropyCodingModeFlag = bs.readBits(1) === 1;
		const bottomFieldPicOrderInFramePresentFlag = bs.readBits(1) === 1;
		const numSliceGroupsMinus1 = readExpGolomb(bs);
		if (numSliceGroupsMinus1 > 0) {
			return null; // Slice groups put macroblocks in a map this does not model
		}

		const numRefIdxL0ActiveMinus1 = readExpGolomb(bs);
		readExpGolomb(bs); // num_ref_idx_l1_default_active_minus1
		const weightedPredFlag = bs.readBits(1) === 1;
		const weightedBipredIdc = bs.readBits(2);
		const picInitQpMinus26 = readSignedExpGolomb(bs);
		readSignedExpGolomb(bs); // pic_init_qs_minus26
		readSignedExpGolomb(bs); // chroma_qp_index_offset
		const deblockingFilterControlPresentFlag = bs.readBits(1) === 1;
		bs.skipBits(1); // constrained_intra_pred_flag
		const redundantPicCntPresentFlag = bs.readBits(1) === 1;

		return {
			id,
			spsId,
			entropyCodingModeFlag,
			bottomFieldPicOrderInFramePresentFlag,
			numRefIdxL0ActiveMinus1,
			weightedPredFlag,
			weightedBipredIdc,
			picInitQpMinus26,
			deblockingFilterControlPresentFlag,
			redundantPicCntPresentFlag,
			chromaFormatIdc,
		};
	} catch {
		return null;
	}
};

/** The parameter sets an `avcC` carries, as NAL units with their headers. */
/** @internal */
export const parameterSetsFromAvcC = (description: Uint8Array) => {
	const spsList: Uint8Array[] = [];
	const ppsList: Uint8Array[] = [];
	let at = 5;
	const lengthSizeMinusOne = description[4]! & 0x03;

	const readSet = (into: Uint8Array[], count: number) => {
		for (let i = 0; i < count; i++) {
			const size = (description[at]! << 8) | description[at + 1]!;
			into.push(description.subarray(at + 2, at + 2 + size));
			at += 2 + size;
		}
	};

	readSet(spsList, description[at++]! & 0x1f);
	readSet(ppsList, description[at++]!);

	return { spsList, ppsList, lengthSizeMinusOne };
};

/** What a skip slice needs out of an HEVC PPS. */
/** @internal */
export type HevcPps = {
	id: number;
	spsId: number;
	dependentSliceSegmentsEnabledFlag: boolean;
	outputFlagPresentFlag: boolean;
	numExtraSliceHeaderBits: number;
	cabacInitPresentFlag: boolean;
	initQpMinus26: number;
	ppsSliceChromaQpOffsetsPresentFlag: boolean;
	weightedPredFlag: boolean;
	transquantBypassEnabledFlag: boolean;
	tilesEnabledFlag: boolean;
	entropyCodingSyncEnabledFlag: boolean;
	ppsLoopFilterAcrossSlicesEnabledFlag: boolean;
	deblockingFilterOverrideEnabledFlag: boolean;
	ppsDeblockingFilterDisabledFlag: boolean;
	listsModificationPresentFlag: boolean;
	sliceSegmentHeaderExtensionPresentFlag: boolean;
};

/** @internal */
export const parseHevcPpsForSkip = (pps: Uint8Array): HevcPps | null => {
	try {
		const bs = new Bitstream(removeEmulationPreventionBytes(pps));
		bs.skipBits(16); // NAL header

		const id = readExpGolomb(bs);
		const spsId = readExpGolomb(bs);
		const dependentSliceSegmentsEnabledFlag = !!bs.readBits(1);
		const outputFlagPresentFlag = !!bs.readBits(1);
		const numExtraSliceHeaderBits = bs.readBits(3);
		bs.skipBits(1); // sign_data_hiding_enabled_flag
		const cabacInitPresentFlag = !!bs.readBits(1);
		readExpGolomb(bs); // num_ref_idx_l0_default_active_minus1
		readExpGolomb(bs); // num_ref_idx_l1_default_active_minus1
		const initQpMinus26 = readSignedExpGolomb(bs);
		bs.skipBits(1); // constrained_intra_pred_flag
		bs.skipBits(1); // transform_skip_enabled_flag
		if (bs.readBits(1)) { // cu_qp_delta_enabled_flag
			readExpGolomb(bs); // diff_cu_qp_delta_depth
		}

		readSignedExpGolomb(bs); // pps_cb_qp_offset
		readSignedExpGolomb(bs); // pps_cr_qp_offset
		const ppsSliceChromaQpOffsetsPresentFlag = !!bs.readBits(1);
		const weightedPredFlag = !!bs.readBits(1);
		bs.skipBits(1); // weighted_bipred_flag
		const transquantBypassEnabledFlag = !!bs.readBits(1);
		const tilesEnabledFlag = !!bs.readBits(1);
		const entropyCodingSyncEnabledFlag = !!bs.readBits(1);

		if (tilesEnabledFlag) {
			const numTileColumnsMinus1 = readExpGolomb(bs);
			const numTileRowsMinus1 = readExpGolomb(bs);
			if (!bs.readBits(1)) { // uniform_spacing_flag
				for (let i = 0; i < numTileColumnsMinus1; i++) {
					readExpGolomb(bs); // column_width_minus1[i]
				}
				for (let i = 0; i < numTileRowsMinus1; i++) {
					readExpGolomb(bs); // row_height_minus1[i]
				}
			}

			bs.skipBits(1); // loop_filter_across_tiles_enabled_flag
		}

		const ppsLoopFilterAcrossSlicesEnabledFlag = !!bs.readBits(1);

		let deblockingFilterOverrideEnabledFlag = false;
		let ppsDeblockingFilterDisabledFlag = false;
		if (bs.readBits(1)) { // deblocking_filter_control_present_flag
			deblockingFilterOverrideEnabledFlag = !!bs.readBits(1);
			ppsDeblockingFilterDisabledFlag = !!bs.readBits(1);
			if (!ppsDeblockingFilterDisabledFlag) {
				readSignedExpGolomb(bs); // pps_beta_offset_div2
				readSignedExpGolomb(bs); // pps_tc_offset_div2
			}
		}

		if (bs.readBits(1)) { // pps_scaling_list_data_present_flag
			skipHevcScalingListData(bs);
		}

		const listsModificationPresentFlag = !!bs.readBits(1);
		readExpGolomb(bs); // log2_parallel_merge_level_minus2
		const sliceSegmentHeaderExtensionPresentFlag = !!bs.readBits(1);

		return {
			id,
			spsId,
			dependentSliceSegmentsEnabledFlag,
			outputFlagPresentFlag,
			numExtraSliceHeaderBits,
			cabacInitPresentFlag,
			initQpMinus26,
			ppsSliceChromaQpOffsetsPresentFlag,
			weightedPredFlag,
			transquantBypassEnabledFlag,
			tilesEnabledFlag,
			entropyCodingSyncEnabledFlag,
			ppsLoopFilterAcrossSlicesEnabledFlag,
			deblockingFilterOverrideEnabledFlag,
			ppsDeblockingFilterDisabledFlag,
			listsModificationPresentFlag,
			sliceSegmentHeaderExtensionPresentFlag,
		};
	} catch {
		return null;
	}
};

const skipHevcScalingListData = (bs: Bitstream) => {
	for (let sizeId = 0; sizeId < 4; sizeId++) {
		for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
			if (!bs.readBits(1)) { // scaling_list_pred_mode_flag
				readExpGolomb(bs); // scaling_list_pred_matrix_id_delta
			} else {
				const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
				if (sizeId > 1) {
					readSignedExpGolomb(bs); // scaling_list_dc_coef_minus8
				}
				for (let i = 0; i < coefNum; i++) {
					readSignedExpGolomb(bs); // scaling_list_delta_coef
				}
			}
		}
	}
};

/** The parameter sets an `hvcC` carries, as NAL units with their headers. */
/** @internal */
export const parameterSetsFromHvcC = (description: Uint8Array) => {
	const lengthSizeMinusOne = description[21]! & 0x03;
	const spsList: Uint8Array[] = [];
	const ppsList: Uint8Array[] = [];

	let at = 23;
	const arrayCount = description[22]!;
	for (let i = 0; i < arrayCount; i++) {
		const nalUnitType = description[at]! & 0x3f;
		const count = (description[at + 1]! << 8) | description[at + 2]!;
		at += 3;

		for (let j = 0; j < count; j++) {
			const size = (description[at]! << 8) | description[at + 1]!;
			const unit = description.subarray(at + 2, at + 2 + size);
			at += 2 + size;

			if (nalUnitType === 33) {
				spsList.push(unit);
			} else if (nalUnitType === 34) {
				ppsList.push(unit);
			}
		}
	}

	return { spsList, ppsList, lengthSizeMinusOne };
};

// ---------------------------------------------------------------------------------------------
// The marking process. AVC's is run forward over the samples (8.2.1 for picture order counts,
// 8.2.5 for marking); HEVC states its reference set outright in each slice header, so there is
// nothing to accumulate.
// ---------------------------------------------------------------------------------------------

/** What this models. Anything else is refused by name rather than approximated. */
const SUPPORTED_MMCO = [0, 1];

/** A picture a decoder still holds, and the names a reference list can reach it by. */
type TrackedPicture = {
	pictureOrderCount: number;
	frameNum: number;
	/** `FrameNumWrap`, which is what the sliding window and `PicNum` distances are derived from. */
	frameNumWrap: number;
	term: 'short' | 'long';
};

/** One AVC picture's slice header, only as far as the marking process needs it. */
type AvcPictureHeader = {
	isIdr: boolean;
	isReference: boolean;
	frameNum: number;
	picOrderCntLsb: number;
	deltaPicOrderCntBottom: number;
	/** `null` where the picture marks with a sliding window rather than stating operations. */
	mmco: { op: number; differenceOfPicNumsMinus1: number }[] | null;
	longTermReferenceFlag: boolean;
};

const AVC_SLICE_TYPE_I = [2, 7];

const readAvcPictureHeader = (
	nal: Uint8Array,
	sps: AvcSps,
	pps: AvcPps,
): AvcPictureHeader | null => {
	const nalUnitType = nal[0]! & 0x1f;
	if (nalUnitType !== 1 && nalUnitType !== 5) {
		return null; // not a coded slice of a picture
	}

	const bs = new Bitstream(removeEmulationPreventionBytes(nal));
	bs.skipBits(8); // NAL header

	const nalRefIdc = (nal[0]! >> 5) & 3;
	const isIdr = nalUnitType === 5;

	if (readExpGolomb(bs) !== 0) {
		return null; // a later slice of a picture already accounted for
	}

	const sliceType = readExpGolomb(bs);
	readExpGolomb(bs); // pic_parameter_set_id

	if (sps.separateColourPlaneFlag) {
		bs.skipBits(2); // colour_plane_id
	}

	const frameNum = bs.readBits(sps.log2MaxFrameNum);

	if (!sps.frameMbsOnlyFlag && bs.readBits(1)) {
		return null; // a field, which this does not model
	}
	if (isIdr) {
		readExpGolomb(bs); // idr_pic_id
	}

	let picOrderCntLsb = 0;
	let deltaPicOrderCntBottom = 0;
	if (sps.picOrderCntType === 0) {
		picOrderCntLsb = bs.readBits(sps.log2MaxPicOrderCntLsb);
		if (pps.bottomFieldPicOrderInFramePresentFlag) {
			deltaPicOrderCntBottom = readSignedExpGolomb(bs);
		}
	} else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZeroFlag) {
		readSignedExpGolomb(bs); // delta_pic_order_cnt[0]
		if (pps.bottomFieldPicOrderInFramePresentFlag) {
			readSignedExpGolomb(bs); // delta_pic_order_cnt[1]
		}
	}

	if (pps.redundantPicCntPresentFlag) {
		readExpGolomb(bs); // redundant_pic_cnt
	}

	// Everything between here and dec_ref_pic_marking depends on the slice type, and a non-reference
	// picture has no marking to read at all.
	if (nalRefIdc === 0) {
		return {
			isIdr,
			isReference: false,
			frameNum,
			picOrderCntLsb,
			deltaPicOrderCntBottom,
			mmco: null,
			longTermReferenceFlag: false,
		};
	}

	const sliceTypeModulo = sliceType % 5;
	if (sliceTypeModulo === 1) { // B
		bs.skipBits(1); // direct_spatial_mv_pred_flag
	}

	let numRefIdxL0ActiveMinus1 = pps.numRefIdxL0ActiveMinus1;
	if (sliceTypeModulo === 0 || sliceTypeModulo === 1 || sliceTypeModulo === 3) {
		if (bs.readBits(1)) { // num_ref_idx_active_override_flag
			numRefIdxL0ActiveMinus1 = readExpGolomb(bs);
			if (sliceTypeModulo === 1) {
				readExpGolomb(bs); // num_ref_idx_l1_active_minus1
			}
		}
	}

	if (!AVC_SLICE_TYPE_I.includes(sliceType) && sliceTypeModulo !== 2 && sliceTypeModulo !== 4) {
		skipAvcRefPicListModification(bs);
		if (sliceTypeModulo === 1) {
			skipAvcRefPicListModification(bs);
		}
	}

	if (
		(pps.weightedPredFlag && (sliceTypeModulo === 0 || sliceTypeModulo === 3))
		|| (pps.weightedBipredIdc === 1 && sliceTypeModulo === 1)
	) {
		skipAvcPredWeightTable(bs, numRefIdxL0ActiveMinus1, sliceTypeModulo === 1 ? 0 : -1, pps);
	}

	// dec_ref_pic_marking
	let mmco: AvcPictureHeader['mmco'] = null;
	let longTermReferenceFlag = false;
	if (isIdr) {
		bs.skipBits(1); // no_output_of_prior_pics_flag
		longTermReferenceFlag = bs.readBits(1) === 1;
	} else if (bs.readBits(1)) { // adaptive_ref_pic_marking_mode_flag
		mmco = [];
		for (;;) {
			const op = readExpGolomb(bs);
			if (op === 0) {
				break;
			}

			let differenceOfPicNumsMinus1 = 0;
			if (op === 1 || op === 3) {
				differenceOfPicNumsMinus1 = readExpGolomb(bs);
			}
			if (op === 2) {
				readExpGolomb(bs); // long_term_pic_num
			}
			if (op === 3 || op === 6) {
				readExpGolomb(bs); // long_term_frame_idx
			}
			if (op === 4) {
				readExpGolomb(bs); // max_long_term_frame_idx_plus1
			}

			mmco.push({ op, differenceOfPicNumsMinus1 });
			if (mmco.length > 64) {
				return null; // not a marking list any encoder writes
			}
		}
	}

	return { isIdr, isReference: true, frameNum, picOrderCntLsb, deltaPicOrderCntBottom, mmco,
		longTermReferenceFlag };
};

const skipAvcRefPicListModification = (bs: Bitstream) => {
	if (!bs.readBits(1)) {
		return;
	}

	for (;;) {
		const idc = readExpGolomb(bs);
		if (idc === 3) {
			break;
		}

		readExpGolomb(bs); // abs_diff_pic_num_minus1, long_term_pic_num or abs_diff_view_idx_minus1
	}
};

const skipAvcPredWeightTable = (
	bs: Bitstream,
	numRefIdxL0ActiveMinus1: number,
	numRefIdxL1ActiveMinus1: number,
	pps: AvcPps,
) => {
	readExpGolomb(bs); // luma_log2_weight_denom
	if (pps.chromaFormatIdc !== 0) {
		readExpGolomb(bs); // chroma_log2_weight_denom
	}

	const skipList = (count: number) => {
		for (let i = 0; i <= count; i++) {
			if (bs.readBits(1)) { // luma_weight_l0_flag
				readSignedExpGolomb(bs);
				readSignedExpGolomb(bs);
			}
			if (pps.chromaFormatIdc !== 0 && bs.readBits(1)) { // chroma_weight_l0_flag
				for (let j = 0; j < 2; j++) {
					readSignedExpGolomb(bs);
					readSignedExpGolomb(bs);
				}
			}
		}
	};

	skipList(numRefIdxL0ActiveMinus1);
	if (numRefIdxL1ActiveMinus1 >= 0) {
		skipList(numRefIdxL1ActiveMinus1);
	}
};

/**
 * Raised where a stream states marking this does not model, rather than returning a reference set
 * derived from a guess. Carries what it saw, so a caller can fall back on something specific.
 *
 * @group Codecs
 * @public
 */
export class UnsupportedReferenceMarkingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedReferenceMarkingError';
	}
}

/**
 * A picture the decoder still holds as a reference.
 *
 * @group Codecs
 * @public
 */
export type ReferencePicture = {
	/** Its picture order count, which is what display order is derived from. */
	pictureOrderCount: number;
	/** `frame_num` as coded. HEVC has no such field and states `null`. */
	frameNum: number | null;
	/** Whether a reference list reaches it by a picture number distance or by a long term index. */
	term: 'short' | 'long';
};

/**
 * What a decoder holds after a run of coded samples.
 *
 * @group Codecs
 * @public
 */
export type ReferencePictureSet = {
	/** Every picture still marked as used for reference, in no particular order. */
	pictures: ReferencePicture[];
	/**
	 * The picture order count of the last picture in display order, whether or not it is a reference.
	 * A fill can only copy the picture a viewer last saw where this appears in `pictures`.
	 */
	lastDisplayedPictureOrderCount: number;
	/** What `frame_num` the next coded picture takes, which a fill after these samples has to state. */
	nextFrameNum: number | null;
};

/**
 * Which pictures a decoder still holds as references after `samples`, and what names a reference list
 * can reach them by.
 *
 * `samples` are the coded samples before the point of interest, in decode order, framed as the
 * configuration states — the run has to start at a key frame, because the marking process has no
 * defined state before one.
 *
 * This runs the marking process rather than inferring it: AVC's sliding window depends on how many
 * references are already held, and `mmco` overrides the window outright, so neither can be read off
 * the last slice header. {@link UnsupportedReferenceMarkingError} is raised for marking this does not
 * model — `mmco` operations other than 0 and 1, long term references, and picture order count type 1
 * — so that a caller falls back rather than acting on a guess.
 *
 * @group Codecs
 * @public
 */
export const referencePicturesAfter = (
	decoderConfig: VideoDecoderConfig,
	samples: Uint8Array[],
): ReferencePictureSet => {
	const codec = decoderConfig.codec.split('.')[0]!;
	const description = decoderConfig.description;
	if (!description) {
		throw new TypeError(
			'decoderConfig.description is required: the marking process runs against the stream\'s own'
			+ ' parameter sets, which is what that record carries.',
		);
	}

	const bytes = toUint8Array(description);
	if (codec === 'avc1' || codec === 'avc3') {
		return avcReferencePicturesAfter(bytes, samples);
	}
	if (codec === 'hev1' || codec === 'hvc1') {
		return hevcReferencePicturesAfter(bytes, samples);
	}

	throw new TypeError(
		`Reference pictures can be read for AVC and HEVC; '${decoderConfig.codec}' is neither.`,
	);
};

/** Each NAL unit of a length-prefixed sample, with its header byte first. */
const nalUnitsOf = (sample: Uint8Array, prefixSize: number) => {
	const units: Uint8Array[] = [];
	let at = 0;
	while (at + prefixSize <= sample.length) {
		let size = 0;
		for (let i = 0; i < prefixSize; i++) {
			size = (size << 8) | sample[at + i]!;
		}

		at += prefixSize;
		if (size <= 0 || at + size > sample.length) {
			break;
		}

		units.push(sample.subarray(at, at + size));
		at += size;
	}

	return units;
};

const avcReferencePicturesAfter = (
	description: Uint8Array,
	samples: Uint8Array[],
): ReferencePictureSet => {
	const { spsList, ppsList, lengthSizeMinusOne } = parameterSetsFromAvcC(description);
	const sps = spsList.length > 0 ? parseAvcSpsForSkip(spsList[0]!) : null;
	const pps = ppsList.length > 0 ? parseAvcPpsForSkip(ppsList[0]!, sps?.chromaFormatIdc ?? 1) : null;
	if (!sps || !pps) {
		throw new TypeError('The avcC carries no SPS and PPS to run the marking process against.');
	}
	if (sps.picOrderCntType === 1) {
		throw new UnsupportedReferenceMarkingError(
			'Picture order count type 1 is not modelled: its cycle is stated in the SPS and no stream'
			+ ' available to test it against exists here.',
		);
	}

	const maxFrameNum = 1 << sps.log2MaxFrameNum;
	const maxPicOrderCntLsb = 1 << sps.log2MaxPicOrderCntLsb;

	let held: TrackedPicture[] = [];
	let prevPicOrderCntMsb = 0;
	let prevPicOrderCntLsb = 0;
	// 8.2.1.3 keeps its own running offset, which is what makes a wrapped `frame_num` keep counting up
	// rather than starting over.
	let prevFrameNumOffset = 0;
	let prevFrameNum = 0;
	let lastDisplayed = Number.NEGATIVE_INFINITY;
	let nextFrameNum: number | null = null;
	let sawKeyFrame = false;

	for (const sample of samples) {
		for (const nal of nalUnitsOf(sample, lengthSizeMinusOne + 1)) {
			const header = readAvcPictureHeader(nal, sps, pps);
			if (!header) {
				continue;
			}

			if (header.isIdr) {
				// An IDR empties the buffer and restarts the picture order count.
				held = [];
				prevPicOrderCntMsb = 0;
				prevPicOrderCntLsb = 0;
				prevFrameNumOffset = 0;
				prevFrameNum = 0;
				sawKeyFrame = true;
				if (header.longTermReferenceFlag) {
					throw new UnsupportedReferenceMarkingError(
						'An IDR marking itself as a long term reference is not modelled.',
					);
				}
			} else if (!sawKeyFrame) {
				throw new UnsupportedReferenceMarkingError(
					'The samples do not start at a key frame, so the marking process has no state to'
					+ ' run from.',
				);
			}

			// 8.2.1.1, for picture order count type 0; type 2 counts in decode order outright.
			let pictureOrderCount: number;
			if (sps.picOrderCntType === 0) {
				let picOrderCntMsb: number;
				if (header.isIdr) {
					picOrderCntMsb = 0;
				} else if (
					header.picOrderCntLsb < prevPicOrderCntLsb
					&& prevPicOrderCntLsb - header.picOrderCntLsb >= maxPicOrderCntLsb / 2
				) {
					picOrderCntMsb = prevPicOrderCntMsb + maxPicOrderCntLsb;
				} else if (
					header.picOrderCntLsb > prevPicOrderCntLsb
					&& header.picOrderCntLsb - prevPicOrderCntLsb > maxPicOrderCntLsb / 2
				) {
					picOrderCntMsb = prevPicOrderCntMsb - maxPicOrderCntLsb;
				} else {
					picOrderCntMsb = prevPicOrderCntMsb;
				}

				pictureOrderCount = picOrderCntMsb + header.picOrderCntLsb;
				if (header.isReference) {
					// Only a reference picture advances the predictor.
					prevPicOrderCntMsb = picOrderCntMsb;
					prevPicOrderCntLsb = header.picOrderCntLsb;
				}
			} else {
				// 8.2.1.3. The offset carries across every `frame_num` wrap, and a picture that is not a
				// reference sits one count below the reference it follows.
				const frameNumOffset = header.isIdr
					? 0
					: prevFrameNum > header.frameNum
						? prevFrameNumOffset + maxFrameNum
						: prevFrameNumOffset;

				pictureOrderCount = 2 * (frameNumOffset + header.frameNum) - (header.isReference ? 0 : 1);
				prevFrameNumOffset = frameNumOffset;
				prevFrameNum = header.frameNum;
			}

			lastDisplayed = Math.max(lastDisplayed, pictureOrderCount);

			if (!header.isReference) {
				continue;
			}

			nextFrameNum = (header.frameNum + 1) % maxFrameNum;

			// FrameNumWrap of what is already held, relative to this picture (8.2.4.1).
			for (const picture of held) {
				picture.frameNumWrap = picture.frameNum > header.frameNum
					? picture.frameNum - maxFrameNum
					: picture.frameNum;
			}

			if (header.mmco) {
				for (const { op, differenceOfPicNumsMinus1 } of header.mmco) {
					if (!SUPPORTED_MMCO.includes(op)) {
						throw new UnsupportedReferenceMarkingError(
							`memory_management_control_operation ${op} is not modelled; only 0 and 1 are.`,
						);
					}

					// mmco 1: the short term picture at this picture number distance stops being a
					// reference.
					const picNum = header.frameNum - (differenceOfPicNumsMinus1 + 1);
					const at = held.findIndex(p => p.term === 'short' && p.frameNumWrap === picNum);
					if (at !== -1) {
						held.splice(at, 1);
					}
				}
			} else if (held.length >= sps.maxNumRefFrames) {
				// Sliding window: the short term picture with the smallest FrameNumWrap leaves.
				let oldest = -1;
				for (let i = 0; i < held.length; i++) {
					if (held[i]!.term !== 'short') {
						continue;
					}
					if (oldest === -1 || held[i]!.frameNumWrap < held[oldest]!.frameNumWrap) {
						oldest = i;
					}
				}

				if (oldest !== -1) {
					held.splice(oldest, 1);
				}
			}

			held.push({
				pictureOrderCount,
				frameNum: header.frameNum,
				frameNumWrap: header.frameNum,
				term: 'short',
			});
		}
	}

	return {
		pictures: held.map(p => ({
			pictureOrderCount: p.pictureOrderCount,
			frameNum: p.frameNum,
			term: p.term,
		})),
		lastDisplayedPictureOrderCount: lastDisplayed === Number.NEGATIVE_INFINITY ? 0 : lastDisplayed,
		nextFrameNum,
	};
};

/**
 * HEVC states its reference picture set in each slice header, so the set after a run of samples is
 * the last one read plus the picture that stated it — there is no window to accumulate. Long term
 * references are refused rather than modelled, for the same reason as in AVC.
 */
const hevcReferencePicturesAfter = (
	description: Uint8Array,
	samples: Uint8Array[],
): ReferencePictureSet => {
	const { spsList, ppsList, lengthSizeMinusOne } = parameterSetsFromHvcC(description);
	const sps = spsList.length > 0 ? parseHevcSps(spsList[0]!) : null;
	const pps = ppsList.length > 0 ? parseHevcPpsForSkip(ppsList[0]!) : null;
	if (!sps || !pps) {
		throw new TypeError('The hvcC carries no SPS and PPS to read a reference picture set from.');
	}

	const maxPicOrderCntLsb = 1 << sps.log2MaxPicOrderCntLsb;
	let prevPicOrderCntMsb = 0;
	let prevPicOrderCntLsb = 0;
	let lastDisplayed = Number.NEGATIVE_INFINITY;
	let current: { pictureOrderCount: number; isReference: boolean } | null = null;
	let retainedDeltas: number[] = [];
	let sawKeyFrame = false;
	// What the run has actually decoded. A set may name a picture a broken or trimmed stream never
	// carried, and reporting one would offer a fill something to copy that is not there.
	const decoded = new Set<number>();

	for (const sample of samples) {
		for (const nal of nalUnitsOf(sample, lengthSizeMinusOne + 1)) {
			const nalUnitType = (nal[0]! >> 1) & 0x3f;
			if (nalUnitType > 21 || (nalUnitType > 9 && nalUnitType < 16)) {
				continue; // not a coded slice
			}

			const read = readHevcPictureHeader(nal, nalUnitType, sps, pps);
			if (!read) {
				continue;
			}

			const isIrap = nalUnitType >= 16 && nalUnitType <= 21;
			if (isIrap) {
				prevPicOrderCntMsb = 0;
				prevPicOrderCntLsb = 0;
				sawKeyFrame = true;
			} else if (!sawKeyFrame) {
				throw new UnsupportedReferenceMarkingError(
					'The samples do not start at a key frame, so there is no reference picture set to'
					+ ' read from.',
				);
			}

			// 8.3.1, the same derivation as AVC's picture order count type 0.
			const isIdr = nalUnitType === 19 || nalUnitType === 20;
			let picOrderCntMsb: number;
			if (isIdr) {
				picOrderCntMsb = 0;
			} else if (
				read.picOrderCntLsb < prevPicOrderCntLsb
				&& prevPicOrderCntLsb - read.picOrderCntLsb >= maxPicOrderCntLsb / 2
			) {
				picOrderCntMsb = prevPicOrderCntMsb + maxPicOrderCntLsb;
			} else if (
				read.picOrderCntLsb > prevPicOrderCntLsb
				&& read.picOrderCntLsb - prevPicOrderCntLsb > maxPicOrderCntLsb / 2
			) {
				picOrderCntMsb = prevPicOrderCntMsb - maxPicOrderCntLsb;
			} else {
				picOrderCntMsb = prevPicOrderCntMsb;
			}

			const pictureOrderCount = picOrderCntMsb + read.picOrderCntLsb;
			prevPicOrderCntMsb = picOrderCntMsb;
			prevPicOrderCntLsb = read.picOrderCntLsb;
			lastDisplayed = Math.max(lastDisplayed, pictureOrderCount);
			decoded.add(pictureOrderCount);

			// A sub-layer non-reference picture is never put in a later set.
			const isReference = nalUnitType % 2 === 1 || isIrap;
			current = { pictureOrderCount, isReference };
			retainedDeltas = read.retainedDeltas;
		}
	}

	// What the next picture could reach: the pictures the last one named, plus the last one itself.
	const pictures: ReferencePicture[] = [];
	if (current) {
		if (current.isReference) {
			pictures.push({ pictureOrderCount: current.pictureOrderCount, frameNum: null, term: 'short' });
		}

		for (const delta of retainedDeltas) {
			const poc = current.pictureOrderCount - delta;
			if (decoded.has(poc) && !pictures.some(p => p.pictureOrderCount === poc)) {
				pictures.push({ pictureOrderCount: poc, frameNum: null, term: 'short' });
			}
		}
	}

	return {
		pictures,
		lastDisplayedPictureOrderCount: lastDisplayed === Number.NEGATIVE_INFINITY ? 0 : lastDisplayed,
		nextFrameNum: null,
	};
};

/** An HEVC slice header, as far as the reference picture set needs it. */
const readHevcPictureHeader = (
	nal: Uint8Array,
	nalUnitType: number,
	sps: HevcSpsInfo,
	pps: HevcPps,
): { picOrderCntLsb: number; retainedDeltas: number[] } | null => {
	const bs = new Bitstream(removeEmulationPreventionBytes(nal));
	bs.skipBits(16); // NAL header

	if (!bs.readBits(1)) {
		return null; // a later segment of a picture already accounted for
	}
	if (nalUnitType >= 16 && nalUnitType <= 23) {
		bs.skipBits(1); // no_output_of_prior_pics_flag
	}

	readExpGolomb(bs); // slice_pic_parameter_set_id

	for (let i = 0; i < pps.numExtraSliceHeaderBits; i++) {
		bs.skipBits(1); // slice_reserved_flag[i]
	}

	readExpGolomb(bs); // slice_type
	if (pps.outputFlagPresentFlag) {
		bs.skipBits(1); // pic_output_flag
	}
	if (sps.separateColourPlaneFlag) {
		bs.skipBits(2); // colour_plane_id
	}

	const isIdr = nalUnitType === 19 || nalUnitType === 20;
	if (isIdr) {
		return { picOrderCntLsb: 0, retainedDeltas: [] };
	}

	const picOrderCntLsb = bs.readBits(sps.log2MaxPicOrderCntLsb);
	// Every picture the set names is retained, not only the ones this picture itself uses: an entry
	// with `used_by_curr_pic` clear is kept for a later picture to reference.
	const retainedDeltas: number[] = [];

	if (bs.readBits(1)) { // short_term_ref_pic_set_sps_flag
		// The set is one of the SPS's, which this does not re-parse: the sets are stated there and a
		// stream using them states no deltas here.
		throw new UnsupportedReferenceMarkingError(
			'A slice selecting a short term reference picture set out of the SPS is not modelled; only'
			+ ' a set stated in the slice header is.',
		);
	}

	// st_ref_pic_set, stated inline
	if (sps.numShortTermRefPicSets !== 0 && bs.readBits(1)) { // inter_ref_pic_set_prediction_flag
		throw new UnsupportedReferenceMarkingError(
			'A short term reference picture set predicted from another is not modelled.',
		);
	}

	const numNegativePics = readExpGolomb(bs);
	const numPositivePics = readExpGolomb(bs);
	let delta = 0;
	for (let i = 0; i < numNegativePics; i++) {
		delta += readExpGolomb(bs) + 1; // delta_poc_s0_minus1[i]
		bs.skipBits(1); // used_by_curr_pic_s0_flag[i]
		retainedDeltas.push(delta);
	}

	// Forward entries are retained too. They are later in display order but earlier in decode order -
	// a trailing B names the anchor P it sits between - so the picture is already in the buffer and a
	// fill placed after the gap can copy it.
	let forward = 0;
	for (let i = 0; i < numPositivePics; i++) {
		forward += readExpGolomb(bs) + 1; // delta_poc_s1_minus1[i]
		bs.skipBits(1); // used_by_curr_pic_s1_flag[i]
		retainedDeltas.push(-forward);
	}

	if (sps.longTermRefPicsPresentFlag) {
		throw new UnsupportedReferenceMarkingError(
			'Long term reference pictures are not modelled.',
		);
	}

	return { picOrderCntLsb, retainedDeltas };
};

/**
 * Raised where a fill is asked to copy a picture the decoder no longer holds as a reference. The
 * decoded picture buffer is the limit, not this API: a picture that was never a reference, or whose
 * marking has since released it, cannot be copied however it is named.
 *
 * @group Codecs
 * @public
 */
export class ReferencePictureNotHeldError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReferencePictureNotHeldError';
	}
}
