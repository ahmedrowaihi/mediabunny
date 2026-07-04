/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source:
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/media/codecs/h265_parser.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Bitstream } from '../../shared/bitstream';
import { parseProfileTierLevel, removeEmulationPreventionBytes } from '../codec-data';
import { readExpGolomb, readSignedExpGolomb } from '../misc';
import type { Nalu, VideoSliceHeaderParser } from './subsample-generator';

type Sps = {
	separateColourPlaneFlag: boolean;
	chromaArrayType: number;
	log2MaxPicOrderCntLsbMinus4: number;
	sampleAdaptiveOffsetEnabledFlag: boolean;
	numShortTermRefPicSets: number;
	stRpsNumDeltaPocs: number[];
	longTermRefPicsPresentFlag: boolean;
	numLongTermRefPicsSps: number;
	usedByCurrPicLtSpsFlag: boolean[];
	temporalMvpEnabledFlag: boolean;
};

type Pps = {
	spsId: number;
	dependentSliceSegmentsEnabledFlag: boolean;
	outputFlagPresentFlag: boolean;
	numExtraSliceHeaderBits: number;
	cabacInitPresentFlag: boolean;
	numRefIdxL0DefaultActiveMinus1: number;
	numRefIdxL1DefaultActiveMinus1: number;
	sliceChromaQpOffsetsPresentFlag: boolean;
	weightedPredFlag: boolean;
	weightedBipredFlag: boolean;
	tilesEnabledFlag: boolean;
	entropyCodingSyncEnabledFlag: boolean;
	loopFilterAcrossSlicesEnabledFlag: boolean;
	deblockingFilterOverrideEnabledFlag: boolean;
	listsModificationPresentFlag: boolean;
	sliceSegmentHeaderExtensionPresentFlag: boolean;
	picWidthInCtbsY: number;
};

const ceilLog2 = (n: number): number => Math.ceil(Math.log2(n));

const H265_BLA_W_LP = 16;
const H265_IDR_W_RADL = 19;
const H265_IDR_N_LP = 20;
const H265_RSV_IRAP_VCL23 = 23;
const kPSlice = 1;
const kBSlice = 0;

/** Extract VPS/SPS/PPS NAL units from an `hvcC` (HEVCDecoderConfigurationRecord) box. */
const parseHvccParameterSets = (config: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[] } | null => {
	if (config.length < 23 || config[0] !== 1) {
		return null;
	}
	const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
	let offset = 22;
	const numArrays = config[offset++]!;
	const sps: Uint8Array[] = [];
	const pps: Uint8Array[] = [];
	for (let a = 0; a < numArrays; a++) {
		if (offset + 3 > config.length) {
			return null;
		}
		const nalUnitType = config[offset++]! & 0x3f;
		const numNalus = view.getUint16(offset, false);
		offset += 2;
		for (let n = 0; n < numNalus; n++) {
			if (offset + 2 > config.length) {
				return null;
			}
			const length = view.getUint16(offset, false);
			offset += 2;
			if (offset + length > config.length) {
				return null;
			}
			const nal = config.subarray(offset, offset + length);
			offset += length;
			if (nalUnitType === 33) {
				sps.push(nal);
			} else if (nalUnitType === 34) {
				pps.push(nal);
			}
		}
	}
	return { sps, pps };
};

/**
 * Computes the clear slice-header size of H.265 video-slice NALs. Mirrors shaka-packager's
 * `H265VideoSliceHeaderParser` (+ the `H265Parser` slice-segment-header path). For header
 * *size* only bit consumption matters, so reference-picture-set values are parsed but not
 * fully reconstructed.
 */
export class H265VideoSliceHeaderParser implements VideoSliceHeaderParser {
	/** @internal */
	private readonly spsMap = new Map<number, Sps>();
	/** @internal */
	private readonly ppsMap = new Map<number, Pps>();

	initialize(codecConfig: Uint8Array): boolean {
		const record = parseHvccParameterSets(codecConfig);
		if (record === null) {
			return false;
		}
		for (const sps of record.sps) {
			if (!this.parseSps(sps)) {
				return false;
			}
		}
		for (const pps of record.pps) {
			if (!this.parsePps(pps)) {
				return false;
			}
		}
		return true;
	}

	processNalu(nalu: Nalu): boolean {
		switch (nalu.type) {
			case 33:
				return this.parseSps(nalu.data);
			case 34:
				return this.parsePps(nalu.data);
			default:
				return true;
		}
	}

	getHeaderSize(nalu: Nalu): number {
		const payload = removeEmulationPreventionBytes(nalu.data.subarray(nalu.headerSize));
		const bs = new Bitstream(payload);
		try {
			this.parseSliceHeader(bs, nalu.type);
			// Byte alignment: alignment_bit_equal_to_one + zero-padding to a byte boundary.
			bs.skipBits(1);
			bs.skipBits(bs.getBitsLeft() % 8);
		} catch {
			return -1;
		}
		return (payload.length * 8 - bs.getBitsLeft()) / 8;
	}

	/** @internal — parse a short-term ref-pic-set, returning delta-poc and used-by-curr counts. */
	private parseStRefPicSet(
		bs: Bitstream,
		stRpsIdx: number,
		numSets: number,
		prevNumDeltaPocs: number[],
	): { numDeltaPocs: number; numUsedByCurr: number } {
		let interPred = false;
		if (stRpsIdx !== 0) {
			interPred = bs.readBits(1) === 1;
		}
		if (interPred) {
			let refRpsIdx = stRpsIdx - 1;
			if (stRpsIdx === numSets) {
				refRpsIdx = stRpsIdx - (readExpGolomb(bs) + 1);
			}
			bs.skipBits(1); // delta_rps_sign
			readExpGolomb(bs); // abs_delta_rps_minus1
			const refNumDeltaPocs = prevNumDeltaPocs[refRpsIdx] ?? 0;
			let numDeltaPocs = 0;
			let numUsedByCurr = 0;
			for (let j = 0; j <= refNumDeltaPocs; j++) {
				const usedByCurr = bs.readBits(1) === 1;
				let useDelta = true;
				if (!usedByCurr) {
					useDelta = bs.readBits(1) === 1;
				}
				if (usedByCurr || useDelta) {
					numDeltaPocs++;
				}
				if (usedByCurr) {
					numUsedByCurr++;
				}
			}
			return { numDeltaPocs, numUsedByCurr };
		}
		const numNegative = readExpGolomb(bs);
		const numPositive = readExpGolomb(bs);
		let numUsedByCurr = 0;
		for (let i = 0; i < numNegative; i++) {
			readExpGolomb(bs); // delta_poc_s0_minus1
			if (bs.readBits(1) === 1) { // used_by_curr_pic_s0_flag
				numUsedByCurr++;
			}
		}
		for (let i = 0; i < numPositive; i++) {
			readExpGolomb(bs); // delta_poc_s1_minus1
			if (bs.readBits(1) === 1) { // used_by_curr_pic_s1_flag
				numUsedByCurr++;
			}
		}
		return { numDeltaPocs: numNegative + numPositive, numUsedByCurr };
	}

	/** @internal */
	private parseSps(nal: Uint8Array): boolean {
		try {
			const bs = new Bitstream(removeEmulationPreventionBytes(nal.subarray(2)));
			bs.skipBits(4); // sps_video_parameter_set_id
			const maxSubLayersMinus1 = bs.readBits(3);
			bs.skipBits(1); // sps_temporal_id_nesting_flag
			parseProfileTierLevel(bs, maxSubLayersMinus1);
			const spsId = readExpGolomb(bs); // sps_seq_parameter_set_id
			const chromaFormatIdc = readExpGolomb(bs);
			let separateColourPlaneFlag = false;
			if (chromaFormatIdc === 3) {
				separateColourPlaneFlag = bs.readBits(1) === 1;
			}
			readExpGolomb(bs); // pic_width_in_luma_samples
			readExpGolomb(bs); // pic_height_in_luma_samples
			if (bs.readBits(1) === 1) { // conformance_window_flag
				readExpGolomb(bs);
				readExpGolomb(bs);
				readExpGolomb(bs);
				readExpGolomb(bs);
			}
			readExpGolomb(bs); // bit_depth_luma_minus8
			readExpGolomb(bs); // bit_depth_chroma_minus8
			const log2MaxPicOrderCntLsbMinus4 = readExpGolomb(bs);
			const subLayerOrderingInfoPresent = bs.readBits(1) === 1;
			for (let i = subLayerOrderingInfoPresent ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
				readExpGolomb(bs); // sps_max_dec_pic_buffering_minus1
				readExpGolomb(bs); // sps_max_num_reorder_pics
				readExpGolomb(bs); // sps_max_latency_increase_plus1
			}
			readExpGolomb(bs); // log2_min_luma_coding_block_size_minus3
			readExpGolomb(bs); // log2_diff_max_min_luma_coding_block_size
			readExpGolomb(bs); // log2_min_luma_transform_block_size_minus2
			readExpGolomb(bs); // log2_diff_max_min_luma_transform_block_size
			readExpGolomb(bs); // max_transform_hierarchy_depth_inter
			readExpGolomb(bs); // max_transform_hierarchy_depth_intra
			if (bs.readBits(1) === 1) { // scaling_list_enabled_flag
				if (bs.readBits(1) === 1) { // sps_scaling_list_data_present_flag
					throw new Error('SPS scaling list data not supported');
				}
			}
			bs.skipBits(1); // amp_enabled_flag
			const sampleAdaptiveOffsetEnabledFlag = bs.readBits(1) === 1;
			if (bs.readBits(1) === 1) { // pcm_enabled_flag
				bs.skipBits(8); // pcm sample bit depths
				readExpGolomb(bs); // log2_min_pcm_luma_coding_block_size_minus3
				readExpGolomb(bs); // log2_diff_max_min_pcm_luma_coding_block_size
				bs.skipBits(1); // pcm_loop_filter_disabled_flag
			}

			const numShortTermRefPicSets = readExpGolomb(bs);
			const stRpsNumDeltaPocs: number[] = [];
			for (let i = 0; i < numShortTermRefPicSets; i++) {
				stRpsNumDeltaPocs[i]
					= this.parseStRefPicSet(bs, i, numShortTermRefPicSets, stRpsNumDeltaPocs).numDeltaPocs;
			}

			const longTermRefPicsPresentFlag = bs.readBits(1) === 1;
			let numLongTermRefPicsSps = 0;
			const usedByCurrPicLtSpsFlag: boolean[] = [];
			if (longTermRefPicsPresentFlag) {
				numLongTermRefPicsSps = readExpGolomb(bs);
				for (let i = 0; i < numLongTermRefPicsSps; i++) {
					bs.skipBits(log2MaxPicOrderCntLsbMinus4 + 4); // lt_ref_pic_poc_lsb_sps
					usedByCurrPicLtSpsFlag[i] = bs.readBits(1) === 1;
				}
			}
			const temporalMvpEnabledFlag = bs.readBits(1) === 1;
			// Remaining SPS fields are irrelevant to slice-header parsing.

			this.spsMap.set(spsId, {
				separateColourPlaneFlag,
				chromaArrayType: separateColourPlaneFlag ? 0 : chromaFormatIdc,
				log2MaxPicOrderCntLsbMinus4,
				sampleAdaptiveOffsetEnabledFlag,
				numShortTermRefPicSets,
				stRpsNumDeltaPocs,
				longTermRefPicsPresentFlag,
				numLongTermRefPicsSps,
				usedByCurrPicLtSpsFlag,
				temporalMvpEnabledFlag,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** @internal */
	private parsePps(nal: Uint8Array): boolean {
		try {
			const bs = new Bitstream(removeEmulationPreventionBytes(nal.subarray(2)));
			const ppsId = readExpGolomb(bs);
			const spsId = readExpGolomb(bs);
			const dependentSliceSegmentsEnabledFlag = bs.readBits(1) === 1;
			const outputFlagPresentFlag = bs.readBits(1) === 1;
			const numExtraSliceHeaderBits = bs.readBits(3);
			bs.skipBits(1); // sign_data_hiding_enabled_flag
			const cabacInitPresentFlag = bs.readBits(1) === 1;
			const numRefIdxL0DefaultActiveMinus1 = readExpGolomb(bs);
			const numRefIdxL1DefaultActiveMinus1 = readExpGolomb(bs);
			readSignedExpGolomb(bs); // init_qp_minus26
			bs.skipBits(1); // constrained_intra_pred_flag
			bs.skipBits(1); // transform_skip_enabled_flag
			if (bs.readBits(1) === 1) { // cu_qp_delta_enabled_flag
				readExpGolomb(bs); // diff_cu_qp_delta_depth
			}
			readSignedExpGolomb(bs); // pps_cb_qp_offset
			readSignedExpGolomb(bs); // pps_cr_qp_offset
			const sliceChromaQpOffsetsPresentFlag = bs.readBits(1) === 1;
			const weightedPredFlag = bs.readBits(1) === 1;
			const weightedBipredFlag = bs.readBits(1) === 1;
			bs.skipBits(1); // transquant_bypass_enabled_flag
			const tilesEnabledFlag = bs.readBits(1) === 1;
			const entropyCodingSyncEnabledFlag = bs.readBits(1) === 1;
			if (tilesEnabledFlag) {
				const numTileColumnsMinus1 = readExpGolomb(bs);
				const numTileRowsMinus1 = readExpGolomb(bs);
				if (bs.readBits(1) === 0) { // uniform_spacing_flag
					for (let i = 0; i < numTileColumnsMinus1; i++) {
						readExpGolomb(bs);
					}
					for (let i = 0; i < numTileRowsMinus1; i++) {
						readExpGolomb(bs);
					}
				}
				bs.skipBits(1); // loop_filter_across_tiles_enabled_flag
			}
			const loopFilterAcrossSlicesEnabledFlag = bs.readBits(1) === 1;
			const deblockingFilterControlPresentFlag = bs.readBits(1) === 1;
			let deblockingFilterOverrideEnabledFlag = false;
			if (deblockingFilterControlPresentFlag) {
				deblockingFilterOverrideEnabledFlag = bs.readBits(1) === 1;
				if (bs.readBits(1) === 0) { // pps_deblocking_filter_disabled_flag
					readSignedExpGolomb(bs); // pps_beta_offset_div2
					readSignedExpGolomb(bs); // pps_tc_offset_div2
				}
			}
			if (bs.readBits(1) === 1) { // pps_scaling_list_data_present_flag
				throw new Error('PPS scaling list data not supported');
			}
			const listsModificationPresentFlag = bs.readBits(1) === 1;
			readExpGolomb(bs); // log2_parallel_merge_level_minus2
			const sliceSegmentHeaderExtensionPresentFlag = bs.readBits(1) === 1;

			this.ppsMap.set(ppsId, {
				spsId,
				dependentSliceSegmentsEnabledFlag,
				outputFlagPresentFlag,
				numExtraSliceHeaderBits,
				cabacInitPresentFlag,
				numRefIdxL0DefaultActiveMinus1,
				numRefIdxL1DefaultActiveMinus1,
				sliceChromaQpOffsetsPresentFlag,
				weightedPredFlag,
				weightedBipredFlag,
				tilesEnabledFlag,
				entropyCodingSyncEnabledFlag,
				loopFilterAcrossSlicesEnabledFlag,
				deblockingFilterOverrideEnabledFlag,
				listsModificationPresentFlag,
				sliceSegmentHeaderExtensionPresentFlag,
				picWidthInCtbsY: 0,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** @internal */
	private parseSliceHeader(bs: Bitstream, naluType: number): void {
		bs.skipBits(1); // first_slice_segment_in_pic_flag
		if (naluType >= H265_BLA_W_LP && naluType <= H265_RSV_IRAP_VCL23) {
			bs.skipBits(1); // no_output_of_prior_pics_flag
		}
		const ppsId = readExpGolomb(bs);
		const pps = this.ppsMap.get(ppsId);
		if (pps === undefined) {
			throw new Error('Unknown PPS');
		}
		const sps = this.spsMap.get(pps.spsId);
		if (sps === undefined) {
			throw new Error('Unknown SPS');
		}

		// This port targets non-dependent slices with first_slice_segment_in_pic (segment_address absent).
		bs.skipBits(pps.numExtraSliceHeaderBits);
		const sliceType = readExpGolomb(bs);
		if (pps.outputFlagPresentFlag) {
			bs.skipBits(1); // pic_output_flag
		}
		if (sps.separateColourPlaneFlag) {
			bs.skipBits(2); // colour_plane_id
		}

		let numUsedByCurr = 0;
		let sliceTemporalMvpEnabled = false;
		if (naluType !== H265_IDR_W_RADL && naluType !== H265_IDR_N_LP) {
			bs.skipBits(sps.log2MaxPicOrderCntLsbMinus4 + 4); // slice_pic_order_cnt_lsb
			const shortTermSpsFlag = bs.readBits(1) === 1;
			if (!shortTermSpsFlag) {
				numUsedByCurr += this.parseStRefPicSet(
					bs,
					sps.numShortTermRefPicSets,
					sps.numShortTermRefPicSets,
					sps.stRpsNumDeltaPocs,
				).numUsedByCurr;
			} else if (sps.numShortTermRefPicSets > 1) {
				bs.skipBits(ceilLog2(sps.numShortTermRefPicSets)); // short_term_ref_pic_set_idx
			}
			if (sps.longTermRefPicsPresentFlag) {
				let numLongTermSps = 0;
				if (sps.numLongTermRefPicsSps > 0) {
					numLongTermSps = readExpGolomb(bs);
				}
				const numLongTermPics = readExpGolomb(bs);
				for (let i = 0; i < numLongTermSps + numLongTermPics; i++) {
					if (i < numLongTermSps) {
						let ltIdxSps = 0;
						if (sps.numLongTermRefPicsSps > 1) {
							ltIdxSps = bs.readBits(ceilLog2(sps.numLongTermRefPicsSps));
						}
						if (sps.usedByCurrPicLtSpsFlag[ltIdxSps]) {
							numUsedByCurr++;
						}
					} else {
						bs.skipBits(sps.log2MaxPicOrderCntLsbMinus4 + 4); // poc_lsb_lt
						if (bs.readBits(1) === 1) { // used_by_curr_pic_lt_flag
							numUsedByCurr++;
						}
					}
					if (bs.readBits(1) === 1) { // delta_poc_msb_present_flag
						readExpGolomb(bs); // delta_poc_msb_cycle_lt
					}
				}
			}
			if (sps.temporalMvpEnabledFlag) {
				sliceTemporalMvpEnabled = bs.readBits(1) === 1;
			}
		}

		if (sps.sampleAdaptiveOffsetEnabledFlag) {
			bs.skipBits(1); // slice_sao_luma_flag
			if (sps.chromaArrayType !== 0) {
				bs.skipBits(1); // slice_sao_chroma_flag
			}
		}

		if (sliceType === kPSlice || sliceType === kBSlice) {
			let numRefIdxL0 = pps.numRefIdxL0DefaultActiveMinus1;
			let numRefIdxL1 = pps.numRefIdxL1DefaultActiveMinus1;
			if (bs.readBits(1) === 1) { // num_ref_idx_active_override_flag
				numRefIdxL0 = readExpGolomb(bs);
				if (sliceType === kBSlice) {
					numRefIdxL1 = readExpGolomb(bs);
				}
			}
			const numPicTotalCurr = numUsedByCurr;
			if (pps.listsModificationPresentFlag && numPicTotalCurr > 1) {
				this.skipRefPicListModification(bs, sliceType, numRefIdxL0, numRefIdxL1, numPicTotalCurr);
			}
			if (sliceType === kBSlice) {
				bs.skipBits(1); // mvd_l1_zero_flag
			}
			if (pps.cabacInitPresentFlag) {
				bs.skipBits(1); // cabac_init_flag
			}
			if (sliceTemporalMvpEnabled) {
				let collocatedFromL0 = true;
				if (sliceType === kBSlice) {
					collocatedFromL0 = bs.readBits(1) === 1;
				}
				const refIdx = collocatedFromL0 ? numRefIdxL0 : numRefIdxL1;
				if (refIdx > 0) {
					readExpGolomb(bs); // collocated_ref_idx
				}
			}
			if ((pps.weightedPredFlag && sliceType === kPSlice) || (pps.weightedBipredFlag && sliceType === kBSlice)) {
				this.skipPredictionWeightTable(
					bs, sps.chromaArrayType, numRefIdxL0, numRefIdxL1, sliceType === kBSlice,
				);
			}
			readExpGolomb(bs); // five_minus_max_num_merge_cand
		}

		readSignedExpGolomb(bs); // slice_qp_delta
		if (pps.sliceChromaQpOffsetsPresentFlag) {
			readSignedExpGolomb(bs); // slice_cb_qp_offset
			readSignedExpGolomb(bs); // slice_cr_qp_offset
		}
		if (pps.deblockingFilterOverrideEnabledFlag) {
			if (bs.readBits(1) === 1) { // deblocking_filter_override_flag
				if (bs.readBits(1) === 0) { // slice_deblocking_filter_disabled_flag
					readSignedExpGolomb(bs); // slice_beta_offset_div2
					readSignedExpGolomb(bs); // slice_tc_offset_div2
				}
			}
		}
		if (pps.loopFilterAcrossSlicesEnabledFlag) {
			bs.skipBits(1); // slice_loop_filter_across_slices_enabled_flag
		}

		if (pps.tilesEnabledFlag || pps.entropyCodingSyncEnabledFlag) {
			const numEntryPointOffsets = readExpGolomb(bs);
			if (numEntryPointOffsets > 0) {
				const offsetLenMinus1 = readExpGolomb(bs);
				for (let i = 0; i < numEntryPointOffsets; i++) {
					bs.skipBits(offsetLenMinus1 + 1);
				}
			}
		}
		if (pps.sliceSegmentHeaderExtensionPresentFlag) {
			const length = readExpGolomb(bs);
			bs.skipBits(length * 8);
		}
	}

	/** @internal */
	private skipRefPicListModification(
		bs: Bitstream,
		sliceType: number,
		numRefIdxL0: number,
		numRefIdxL1: number,
		numPicTotalCurr: number,
	): void {
		const bits = ceilLog2(numPicTotalCurr);
		if (bs.readBits(1) === 1) { // ref_pic_list_modification_flag_l0
			for (let i = 0; i <= numRefIdxL0; i++) {
				bs.skipBits(bits);
			}
		}
		if (sliceType === kBSlice) {
			if (bs.readBits(1) === 1) { // ref_pic_list_modification_flag_l1
				for (let i = 0; i <= numRefIdxL1; i++) {
					bs.skipBits(bits);
				}
			}
		}
	}

	/** @internal */
	private skipPredictionWeightTable(
		bs: Bitstream,
		chromaArrayType: number,
		numRefIdxL0: number,
		numRefIdxL1: number,
		isB: boolean,
	): void {
		readExpGolomb(bs); // luma_log2_weight_denom
		if (chromaArrayType !== 0) {
			readSignedExpGolomb(bs); // delta_chroma_log2_weight_denom
		}
		this.skipPredictionWeightTablePart(bs, chromaArrayType, numRefIdxL0);
		if (isB) {
			this.skipPredictionWeightTablePart(bs, chromaArrayType, numRefIdxL1);
		}
	}

	/** @internal */
	private skipPredictionWeightTablePart(bs: Bitstream, chromaArrayType: number, numRefIdxMinus1: number): void {
		const lumaWeightFlag: boolean[] = [];
		for (let i = 0; i <= numRefIdxMinus1; i++) {
			lumaWeightFlag[i] = bs.readBits(1) === 1;
		}
		const chromaWeightFlag: boolean[] = [];
		if (chromaArrayType !== 0) {
			for (let i = 0; i <= numRefIdxMinus1; i++) {
				chromaWeightFlag[i] = bs.readBits(1) === 1;
			}
		}
		for (let i = 0; i <= numRefIdxMinus1; i++) {
			if (lumaWeightFlag[i]) {
				readSignedExpGolomb(bs); // delta_luma_weight
				readSignedExpGolomb(bs); // luma_offset
			}
			if (chromaWeightFlag[i]) {
				for (let j = 0; j < 2; j++) {
					readSignedExpGolomb(bs); // delta_chroma_weight
					readSignedExpGolomb(bs); // delta_chroma_offset
				}
			}
		}
	}
}
