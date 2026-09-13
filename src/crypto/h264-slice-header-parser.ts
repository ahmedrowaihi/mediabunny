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
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/media/codecs/h264_parser.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Bitstream } from '../../shared/bitstream';
import { removeEmulationPreventionBytes } from '../codec-data';
import { readExpGolomb, readSignedExpGolomb } from '../misc';
import type { Nalu, VideoSliceHeaderParser } from './subsample-generator';

/** Extract the SPS/PPS NAL units from an `avcC` (AVCDecoderConfigurationRecord) box. */
const parseAvccSpsPps = (config: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[] } | null => {
	if (config.length < 7 || config[0] !== 1) {
		return null;
	}
	let offset = 5;
	const readParameterSets = (count: number): Uint8Array[] | null => {
		const sets: Uint8Array[] = [];
		for (let i = 0; i < count; i++) {
			if (offset + 2 > config.length) {
				return null;
			}
			const size = (config[offset]! << 8) | config[offset + 1]!;
			offset += 2;
			if (offset + size > config.length) {
				return null;
			}
			sets.push(config.subarray(offset, offset + size));
			offset += size;
		}
		return sets;
	};

	const sps = readParameterSets(config[offset++]! & 0x1f);
	if (sps === null) {
		return null;
	}
	const pps = readParameterSets(config[offset++]!);
	if (pps === null) {
		return null;
	}
	return { sps, pps };
};

type Sps = {
	separateColourPlaneFlag: boolean;
	chromaArrayType: number;
	log2MaxFrameNumMinus4: number;
	picOrderCntType: number;
	log2MaxPicOrderCntLsbMinus4: number;
	deltaPicOrderAlwaysZeroFlag: boolean;
	frameMbsOnlyFlag: boolean;
};

type Pps = {
	spsId: number;
	entropyCodingModeFlag: boolean;
	bottomFieldPicOrderInFramePresentFlag: boolean;
	numRefIdxL0DefaultActiveMinus1: number;
	numRefIdxL1DefaultActiveMinus1: number;
	weightedPredFlag: boolean;
	weightedBipredIdc: number;
	deblockingFilterControlPresentFlag: boolean;
	redundantPicCntPresentFlag: boolean;
};

/** Read a scaling list, consuming the exact number of `se` codes (values discarded). */
const skipScalingList = (bs: Bitstream, size: number): void => {
	let lastScale = 8;
	let nextScale = 8;
	for (let j = 0; j < size; j++) {
		if (nextScale !== 0) {
			const deltaScale = readSignedExpGolomb(bs);
			nextScale = (lastScale + deltaScale + 256) & 0xff;
		}
		lastScale = nextScale === 0 ? lastScale : nextScale;
	}
};

/**
 * Computes the clear slice-header size of H.264 video-slice NALs, so cbcs/cenc encryption
 * starts on the first byte of slice data. Mirrors shaka-packager's
 * `H264VideoSliceHeaderParser` (+ the `H264Parser` slice-header path it delegates to).
 */
export class H264VideoSliceHeaderParser implements VideoSliceHeaderParser {
	/** @internal */
	private readonly spsMap = new Map<number, Sps>();
	/** @internal */
	private readonly ppsMap = new Map<number, Pps>();

	initialize(codecConfig: Uint8Array): boolean {
		const record = parseAvccSpsPps(codecConfig);
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
			case 7:
				return this.parseSps(nalu.data);
			case 8:
				return this.parsePps(nalu.data);
			default:
				return true;
		}
	}

	getHeaderSize(nalu: Nalu): number {
		const payload = removeEmulationPreventionBytes(nalu.data.subarray(nalu.headerSize));
		const bs = new Bitstream(payload);
		const nalRefIdc = (nalu.data[0]! >> 5) & 0x3;
		const idrPicFlag = nalu.type === 5;

		try {
			this.parseSliceHeader(bs, nalRefIdc, idrPicFlag);
		} catch {
			return -1;
		}

		const headerBits = payload.length * 8 - bs.getBitsLeft();
		return Math.ceil(headerBits / 8);
	}

	/** @internal — the NAL bytes include the 1-byte NAL header. */
	private parseSps(nal: Uint8Array): boolean {
		try {
			const bs = new Bitstream(removeEmulationPreventionBytes(nal.subarray(1)));
			const profileIdc = bs.readBits(8);
			bs.skipBits(8); // constraint flags (6) + reserved (2)
			bs.skipBits(8); // level_idc
			const spsId = readExpGolomb(bs);

			let chromaFormatIdc = 1;
			let separateColourPlaneFlag = false;
			const highProfile = [100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profileIdc);
			if (highProfile) {
				chromaFormatIdc = readExpGolomb(bs);
				if (chromaFormatIdc === 3) {
					separateColourPlaneFlag = bs.readBits(1) === 1;
				}
				readExpGolomb(bs); // bit_depth_luma_minus8
				readExpGolomb(bs); // bit_depth_chroma_minus8
				bs.skipBits(1); // qpprime_y_zero_transform_bypass_flag
				if (bs.readBits(1) === 1) { // seq_scaling_matrix_present_flag
					const count8x8 = chromaFormatIdc === 3 ? 6 : 2;
					for (let i = 0; i < 6; i++) {
						if (bs.readBits(1) === 1) {
							skipScalingList(bs, 16);
						}
					}
					for (let i = 0; i < count8x8; i++) {
						if (bs.readBits(1) === 1) {
							skipScalingList(bs, 64);
						}
					}
				}
			}
			const chromaArrayType = separateColourPlaneFlag ? 0 : chromaFormatIdc;

			const log2MaxFrameNumMinus4 = readExpGolomb(bs);
			const picOrderCntType = readExpGolomb(bs);
			let log2MaxPicOrderCntLsbMinus4 = 0;
			let deltaPicOrderAlwaysZeroFlag = false;
			if (picOrderCntType === 0) {
				log2MaxPicOrderCntLsbMinus4 = readExpGolomb(bs);
			} else if (picOrderCntType === 1) {
				deltaPicOrderAlwaysZeroFlag = bs.readBits(1) === 1;
				readSignedExpGolomb(bs); // offset_for_non_ref_pic
				readSignedExpGolomb(bs); // offset_for_top_to_bottom_field
				const numRefFrames = readExpGolomb(bs);
				for (let i = 0; i < numRefFrames; i++) {
					readSignedExpGolomb(bs); // offset_for_ref_frame[i]
				}
			}
			readExpGolomb(bs); // max_num_ref_frames
			bs.skipBits(1); // gaps_in_frame_num_value_allowed_flag
			readExpGolomb(bs); // pic_width_in_mbs_minus1
			readExpGolomb(bs); // pic_height_in_map_units_minus1
			const frameMbsOnlyFlag = bs.readBits(1) === 1;
			// Remaining SPS fields are irrelevant to slice-header parsing.

			this.spsMap.set(spsId, {
				separateColourPlaneFlag,
				chromaArrayType,
				log2MaxFrameNumMinus4,
				picOrderCntType,
				log2MaxPicOrderCntLsbMinus4,
				deltaPicOrderAlwaysZeroFlag,
				frameMbsOnlyFlag,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** @internal */
	private parsePps(nal: Uint8Array): boolean {
		try {
			const bs = new Bitstream(removeEmulationPreventionBytes(nal.subarray(1)));
			const ppsId = readExpGolomb(bs);
			const spsId = readExpGolomb(bs);

			const entropyCodingModeFlag = bs.readBits(1) === 1;
			const bottomFieldPicOrderInFramePresentFlag = bs.readBits(1) === 1;
			const numSliceGroupsMinus1 = readExpGolomb(bs);
			if (numSliceGroupsMinus1 > 1) {
				// Slice groups (FMO) not supported — matches shaka.
				return false;
			}
			const numRefIdxL0DefaultActiveMinus1 = readExpGolomb(bs);
			const numRefIdxL1DefaultActiveMinus1 = readExpGolomb(bs);
			const weightedPredFlag = bs.readBits(1) === 1;
			const weightedBipredIdc = bs.readBits(2);
			readSignedExpGolomb(bs); // pic_init_qp_minus26
			readSignedExpGolomb(bs); // pic_init_qs_minus26
			readSignedExpGolomb(bs); // chroma_qp_index_offset
			const deblockingFilterControlPresentFlag = bs.readBits(1) === 1;
			bs.skipBits(1); // constrained_intra_pred_flag
			const redundantPicCntPresentFlag = bs.readBits(1) === 1;

			this.ppsMap.set(ppsId, {
				spsId,
				entropyCodingModeFlag,
				bottomFieldPicOrderInFramePresentFlag,
				numRefIdxL0DefaultActiveMinus1,
				numRefIdxL1DefaultActiveMinus1,
				weightedPredFlag,
				weightedBipredIdc,
				deblockingFilterControlPresentFlag,
				redundantPicCntPresentFlag,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** @internal — throws on an unsupported/invalid header; the caller maps that to size -1. */
	private parseSliceHeader(bs: Bitstream, nalRefIdc: number, idrPicFlag: boolean): void {
		readExpGolomb(bs); // first_mb_in_slice
		const sliceType = readExpGolomb(bs);
		if (sliceType >= 10) {
			throw new Error('Invalid slice_type');
		}
		const baseType = sliceType % 5; // 0=P, 1=B, 2=I, 3=SP, 4=SI

		const ppsId = readExpGolomb(bs);
		const pps = this.ppsMap.get(ppsId);
		if (pps === undefined) {
			throw new Error('Unknown PPS');
		}
		const sps = this.spsMap.get(pps.spsId);
		if (sps === undefined) {
			throw new Error('Unknown SPS');
		}

		if (sps.separateColourPlaneFlag) {
			bs.skipBits(2); // colour_plane_id
		}
		bs.skipBits(sps.log2MaxFrameNumMinus4 + 4); // frame_num

		let fieldPicFlag = false;
		if (!sps.frameMbsOnlyFlag) {
			fieldPicFlag = bs.readBits(1) === 1;
			if (fieldPicFlag) {
				throw new Error('Field pictures are not supported');
			}
		}
		if (idrPicFlag) {
			readExpGolomb(bs); // idr_pic_id
		}

		if (sps.picOrderCntType === 0) {
			bs.skipBits(sps.log2MaxPicOrderCntLsbMinus4 + 4); // pic_order_cnt_lsb
			if (pps.bottomFieldPicOrderInFramePresentFlag && !fieldPicFlag) {
				readSignedExpGolomb(bs); // delta_pic_order_cnt_bottom
			}
		} else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZeroFlag) {
			readSignedExpGolomb(bs); // delta_pic_order_cnt[0]
			if (pps.bottomFieldPicOrderInFramePresentFlag && !fieldPicFlag) {
				readSignedExpGolomb(bs); // delta_pic_order_cnt[1]
			}
		}
		if (pps.redundantPicCntPresentFlag) {
			readExpGolomb(bs); // redundant_pic_cnt
		}

		const isP = baseType === 0;
		const isB = baseType === 1;
		const isSp = baseType === 3;
		if (isB) {
			bs.skipBits(1); // direct_spatial_mv_pred_flag
		}
		let numRefIdxL0 = pps.numRefIdxL0DefaultActiveMinus1;
		let numRefIdxL1 = pps.numRefIdxL1DefaultActiveMinus1;
		if (isP || isSp || isB) {
			if (bs.readBits(1) === 1) { // num_ref_idx_active_override_flag
				numRefIdxL0 = readExpGolomb(bs);
				if (isB) {
					numRefIdxL1 = readExpGolomb(bs);
				}
			}
		}

		this.parseRefPicListModifications(bs, baseType);

		if ((pps.weightedPredFlag && (isP || isSp)) || (pps.weightedBipredIdc === 1 && isB)) {
			this.parsePredWeightTable(bs, sps.chromaArrayType, numRefIdxL0, numRefIdxL1, isB);
		}
		if (nalRefIdc !== 0) {
			this.parseDecRefPicMarking(bs, idrPicFlag);
		}
		const isI = baseType === 2;
		const isSi = baseType === 4;
		if (pps.entropyCodingModeFlag && !isI && !isSi) {
			readExpGolomb(bs); // cabac_init_idc
		}
		readSignedExpGolomb(bs); // slice_qp_delta
		if (isSp || isSi) {
			if (isSp) {
				bs.skipBits(1); // sp_for_switch_flag
			}
			readSignedExpGolomb(bs); // slice_qs_delta
		}
		if (pps.deblockingFilterControlPresentFlag) {
			const disableDeblocking = readExpGolomb(bs); // disable_deblocking_filter_idc
			if (disableDeblocking !== 1) {
				readSignedExpGolomb(bs); // slice_alpha_c0_offset_div2
				readSignedExpGolomb(bs); // slice_beta_offset_div2
			}
		}
	}

	/** @internal */
	private parseRefPicListModifications(bs: Bitstream, baseType: number): void {
		const isI = baseType === 2;
		const isSi = baseType === 4;
		const isB = baseType === 1;
		if (!isI && !isSi) {
			if (bs.readBits(1) === 1) { // ref_pic_list_modification_flag_l0
				this.parseRefPicListModification(bs);
			}
		}
		if (isB) {
			if (bs.readBits(1) === 1) { // ref_pic_list_modification_flag_l1
				this.parseRefPicListModification(bs);
			}
		}
	}

	/** @internal */
	private parseRefPicListModification(bs: Bitstream): void {
		for (let i = 0; i < 32; i++) {
			const idc = readExpGolomb(bs); // modification_of_pic_nums_idc
			if (idc >= 4) {
				throw new Error('Invalid modification_of_pic_nums_idc');
			}
			if (idc === 0 || idc === 1) {
				readExpGolomb(bs); // abs_diff_pic_num_minus1
			} else if (idc === 2) {
				readExpGolomb(bs); // long_term_pic_num
			} else {
				// idc === 3: end of list.
				if (i === 0) {
					throw new Error('Empty ref_pic_list_modification');
				}
				return;
			}
		}
		if (readExpGolomb(bs) !== 3) {
			throw new Error('Missing ref_pic_list_modification end marker');
		}
	}

	/** @internal */
	private parsePredWeightTable(
		bs: Bitstream,
		chromaArrayType: number,
		numRefIdxL0: number,
		numRefIdxL1: number,
		isB: boolean,
	): void {
		readExpGolomb(bs); // luma_log2_weight_denom
		if (chromaArrayType !== 0) {
			readExpGolomb(bs); // chroma_log2_weight_denom
		}
		this.parseWeightingFactors(bs, chromaArrayType, numRefIdxL0);
		if (isB) {
			this.parseWeightingFactors(bs, chromaArrayType, numRefIdxL1);
		}
	}

	/** @internal */
	private parseWeightingFactors(bs: Bitstream, chromaArrayType: number, numRefIdxActiveMinus1: number): void {
		for (let i = 0; i < numRefIdxActiveMinus1 + 1; i++) {
			if (bs.readBits(1) === 1) { // luma_weight_flag
				readSignedExpGolomb(bs); // luma_weight
				readSignedExpGolomb(bs); // luma_offset
			}
			if (chromaArrayType !== 0) {
				if (bs.readBits(1) === 1) { // chroma_weight_flag
					for (let j = 0; j < 2; j++) {
						readSignedExpGolomb(bs); // chroma_weight
						readSignedExpGolomb(bs); // chroma_offset
					}
				}
			}
		}
	}

	/** @internal */
	private parseDecRefPicMarking(bs: Bitstream, idrPicFlag: boolean): void {
		if (idrPicFlag) {
			bs.skipBits(1); // no_output_of_prior_pics_flag
			bs.skipBits(1); // long_term_reference_flag
			return;
		}
		if (bs.readBits(1) === 0) { // adaptive_ref_pic_marking_mode_flag
			return;
		}
		for (let i = 0; i < 256; i++) {
			const op = readExpGolomb(bs); // memory_management_control_operation
			if (op === 0) {
				return;
			}
			if (op === 1 || op === 3) {
				readExpGolomb(bs); // difference_of_pic_nums_minus1
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
			if (op > 6) {
				throw new Error('Invalid memory_management_control_operation');
			}
		}
		throw new Error('Runaway dec_ref_pic_marking');
	}
}
