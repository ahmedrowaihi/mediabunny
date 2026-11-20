/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A live origin that loses its input for a stretch has to put *something* in the gap, and the only
// thing a player's decoder will accept there is a frame coded against the stream's own parameter sets.
// These build that frame: a P picture in which every macroblock or coding unit is skipped, so it
// decodes to exactly the picture before it.
//
// Nothing here encodes pixels. The whole output is a slice header plus the one syntax element that
// says "every block in this picture is copied", which is why it can be built from an `avcC` or `hvcC`
// alone with no encoder present.

import { Bitstream } from '../shared/bitstream';
import {
	addEmulationPreventionBytes,
	HevcSpsInfo,
	parseHevcSps,
	removeEmulationPreventionBytes,
} from './codec-data';
import { BitWriter, readExpGolomb, readSignedExpGolomb, toUint8Array } from './misc';
import {
	type AvcPps,
	type AvcSps,
	type HevcPps,
	ReferencePictureNotHeldError,
	referencePicturesAfter,
	parameterSetsFromAvcC,
	parameterSetsFromHvcC,
	parseAvcPpsForSkip,
	parseAvcSpsForSkip,
	parseHevcPpsForSkip,
} from './reference-pictures';

/**
 * The slice header of a P picture every macroblock of which is skipped, written against the stream's
 * own SPS and PPS. Every field that could vary is stated at its neutral value, so the picture is
 * decoded with the parameter sets the stream already carries and nothing else.
 */
const writeAvcSkipSliceHeader = (
	writer: BitWriter,
	sps: AvcSps,
	pps: AvcPps,
	frameNum: number,
	picOrderCntLsb: number,
	copyFromDistance: number,
	marking: { op: number; differenceOfPicNumsMinus1: number }[] | null,
) => {
	writer.writeUe(0); // first_mb_in_slice
	writer.writeUe(5); // slice_type: P, and every slice of the picture is P
	writer.writeUe(pps.id);

	if (sps.separateColourPlaneFlag) {
		writer.writeBits(2, 0); // colour_plane_id
	}

	writer.writeBits(sps.log2MaxFrameNum, frameNum & ((1 << sps.log2MaxFrameNum) - 1));

	if (!sps.frameMbsOnlyFlag) {
		writer.writeBits(1, 0); // field_pic_flag: coded as a frame
	}

	if (sps.picOrderCntType === 0) {
		writer.writeBits(sps.log2MaxPicOrderCntLsb, picOrderCntLsb & ((1 << sps.log2MaxPicOrderCntLsb) - 1));
		if (pps.bottomFieldPicOrderInFramePresentFlag) {
			writer.writeSe(0); // delta_pic_order_cnt_bottom
		}
	} else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZeroFlag) {
		writer.writeSe(0); // delta_pic_order_cnt[0]
		if (pps.bottomFieldPicOrderInFramePresentFlag) {
			writer.writeSe(0); // delta_pic_order_cnt[1]
		}
	}

	if (pps.redundantPicCntPresentFlag) {
		writer.writeUe(0); // redundant_pic_cnt
	}

	// One active reference, overriding the PPS. A skip macroblock only ever reads index 0, and the
	// PPS default is usually larger than the number of pictures that exist behind a fresh key frame,
	// which makes the decoder build the list with holes it has to fill with a default picture.
	writer.writeBits(1, 1); // num_ref_idx_active_override_flag
	writer.writeUe(0); // num_ref_idx_l0_active_minus1
	if (copyFromDistance > 1) {
		// Reorder so index 0 is the stated picture rather than the most recently decoded reference.
		writer.writeBits(1, 1); // ref_pic_list_modification_flag_l0
		writer.writeUe(0); // modification_of_pic_nums_idc: subtract from the predicted picture number
		writer.writeUe(copyFromDistance - 1); // abs_diff_pic_num_minus1
		writer.writeUe(3); // modification_of_pic_nums_idc: end of the list
	} else {
		writer.writeBits(1, 0); // ref_pic_list_modification_flag_l0
	}

	if (pps.weightedPredFlag) {
		// Every weight defaulted. A skip macroblock is still predicted through this table, so it has to
		// be written even though it changes nothing.
		writer.writeUe(0); // luma_log2_weight_denom
		if (pps.chromaFormatIdc !== 0) {
			writer.writeUe(0); // chroma_log2_weight_denom
		}
		writer.writeBits(1, 0); // luma_weight_l0_flag
		if (pps.chromaFormatIdc !== 0) {
			writer.writeBits(1, 0); // chroma_weight_l0_flag
		}
	}

	// nal_ref_idc is non-zero for these, so each one can be the reference the next one copies.
	if (marking) {
		writer.writeBits(1, 1); // adaptive_ref_pic_marking_mode_flag
		for (const { op, differenceOfPicNumsMinus1 } of marking) {
			writer.writeUe(op); // memory_management_control_operation
			if (op === 1 || op === 3) {
				writer.writeUe(differenceOfPicNumsMinus1);
			}
			if (op === 2) {
				writer.writeUe(differenceOfPicNumsMinus1); // long_term_pic_num
			}
			if (op === 3 || op === 6) {
				writer.writeUe(0); // long_term_frame_idx
			}
			if (op === 4) {
				writer.writeUe(1); // max_long_term_frame_idx_plus1
			}
		}

		writer.writeUe(0); // the list ends with operation 0
	} else {
		writer.writeBits(1, 0); // adaptive_ref_pic_marking_mode_flag
	}

	if (pps.entropyCodingModeFlag) {
		writer.writeUe(0); // cabac_init_idc
	}

	writer.writeSe(0); // slice_qp_delta: SliceQPY is the PPS's own pic_init_qp

	if (pps.deblockingFilterControlPresentFlag) {
		writer.writeUe(0); // disable_deblocking_filter_idc
		writer.writeSe(0); // slice_alpha_c0_offset_div2
		writer.writeSe(0); // slice_beta_offset_div2
	}
};

// ---------------------------------------------------------------------------------------------
// The CABAC arithmetic encoder of H.264 9.3.4, which H.265 9.3.4 reuses unchanged. Only the context
// initialisation and which syntax elements are coded differ between them.
// ---------------------------------------------------------------------------------------------

/** H.264 Table 9-44 / H.265 Table 9-46: the LPS sub-range per state and per quantised range. */
const RANGE_TAB_LPS: readonly (readonly number[])[] = [
	[128, 176, 208, 240], [128, 167, 197, 227], [128, 158, 187, 216], [123, 150, 178, 205],
	[116, 142, 169, 195], [111, 135, 160, 185], [105, 128, 152, 175], [100, 122, 144, 166],
	[95, 116, 137, 158], [90, 110, 130, 150], [85, 104, 123, 142], [81, 99, 117, 135],
	[77, 94, 111, 128], [73, 89, 105, 122], [69, 85, 100, 116], [66, 80, 95, 110],
	[62, 76, 90, 104], [59, 72, 86, 99], [56, 69, 81, 94], [53, 65, 77, 89],
	[51, 62, 73, 85], [48, 59, 69, 80], [46, 56, 66, 76], [43, 53, 63, 72],
	[41, 50, 59, 69], [39, 48, 56, 65], [37, 45, 54, 62], [35, 43, 51, 59],
	[33, 41, 48, 56], [32, 39, 46, 53], [30, 37, 43, 50], [29, 35, 41, 48],
	[27, 33, 39, 45], [26, 31, 37, 43], [24, 30, 35, 41], [23, 28, 33, 39],
	[22, 27, 32, 37], [21, 26, 30, 35], [20, 24, 29, 33], [19, 23, 27, 31],
	[18, 22, 26, 30], [17, 21, 25, 28], [16, 20, 23, 27], [15, 19, 22, 25],
	[14, 18, 21, 24], [14, 17, 20, 23], [13, 16, 19, 22], [12, 15, 18, 21],
	[12, 14, 17, 20], [11, 14, 16, 19], [11, 13, 15, 18], [10, 12, 15, 17],
	[10, 12, 14, 16], [9, 11, 13, 15], [9, 11, 12, 14], [8, 10, 12, 14],
	[8, 9, 11, 13], [7, 9, 11, 12], [7, 9, 10, 12], [7, 8, 10, 11],
	[6, 8, 9, 11], [6, 7, 9, 10], [6, 7, 8, 9], [2, 2, 2, 2],
];

/** Table 9-45: the state a bin takes after coding an LPS, and after coding an MPS. */
const TRANS_IDX_LPS = [
	0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21, 21,
	22, 22, 23, 24, 24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33, 33, 33, 34, 34, 35,
	35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
];
const TRANS_IDX_MPS = [
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
	28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
	53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 62, 63,
];

const clip3 = (low: number, high: number, value: number) => Math.min(Math.max(value, low), high);

/** One adaptive context: its probability state and which bin value is currently the likely one. */
type CabacContext = { stateIdx: number; valMps: number };

/** 9.3.1.1, which both codecs share once their own `m` and `n` have been derived. */
const initCabacContext = (m: number, n: number, qp: number): CabacContext => {
	const preCtxState = clip3(1, 126, ((m * clip3(0, 51, qp)) >> 4) + n);
	return preCtxState <= 63
		? { stateIdx: 63 - preCtxState, valMps: 0 }
		: { stateIdx: preCtxState - 64, valMps: 1 };
};

class CabacEncoder {
	private low = 0;
	private range = 510;
	private firstBitPending = true;
	private outstanding = 0;

	constructor(private readonly writer: BitWriter) {}

	/**
	 * 9.3.4.2. The first bit is withheld and the carries behind it counted, because a carry out of
	 * `low` has to propagate into bits that have not been written yet.
	 */
	private putBit(bit: number) {
		if (this.firstBitPending) {
			this.firstBitPending = false;
		} else {
			this.writer.writeBits(1, bit);
		}

		while (this.outstanding > 0) {
			this.writer.writeBits(1, 1 - bit);
			this.outstanding--;
		}
	}

	private renormalize() {
		while (this.range < 256) {
			if (this.low < 256) {
				this.putBit(0);
			} else if (this.low >= 512) {
				this.low -= 512;
				this.putBit(1);
			} else {
				this.low -= 256;
				this.outstanding++;
			}

			this.range <<= 1;
			this.low <<= 1;
		}
	}

	/** 9.3.4.3, a bin coded against an adaptive context. */
	encodeDecision(context: CabacContext, bin: number) {
		const rangeLps = RANGE_TAB_LPS[context.stateIdx]![(this.range >> 6) & 3]!;
		this.range -= rangeLps;

		if (bin !== context.valMps) {
			this.low += this.range;
			this.range = rangeLps;
			if (context.stateIdx === 0) {
				context.valMps = 1 - context.valMps;
			}

			context.stateIdx = TRANS_IDX_LPS[context.stateIdx]!;
		} else {
			context.stateIdx = TRANS_IDX_MPS[context.stateIdx]!;
		}

		this.renormalize();
	}

	/** 9.3.4.5, the bin that ends a slice. A `1` terminates the stream and flushes it. */
	encodeTerminate(bin: number) {
		this.range -= 2;
		if (bin !== 0) {
			this.low += this.range;
			this.flush();
		} else {
			this.renormalize();
		}
	}

	/**
	 * 9.3.4.6. The last of the two bits written here is a `1`, and a decoder reads it as the RBSP stop
	 * bit — so a slice flushed this way must not be given a stop bit of its own.
	 */
	private flush() {
		this.range = 2;
		this.renormalize();
		this.putBit((this.low >> 9) & 1);
		this.writer.writeBits(2, ((this.low >> 7) & 3) | 1);
	}
}

/**
 * `mb_skip_flag` for a P slice is context 11 plus one for each neighbour that is *not* skipped
 * (9.3.3.1.1.1). Every macroblock here is skipped, so both neighbours contribute nothing and the
 * context never moves off 11 — which is the whole reason an all-skip slice needs just one context.
 */
const MB_SKIP_FLAG_INIT = { m: 23, n: 33 }; // Table 9-13, cabac_init_idc 0

const writeAvcSkipSliceData = (writer: BitWriter, sps: AvcSps, pps: AvcPps) => {
	if (!pps.entropyCodingModeFlag) {
		writer.writeUe(sps.picSizeInMbs); // mb_skip_run: every macroblock of the picture
		writer.writeBits(1, 1); // rbsp_stop_one_bit
		writer.byteAlign();
		return;
	}

	while (writer.bitsWritten % 8 !== 0) {
		writer.writeBits(1, 1); // cabac_alignment_one_bit
	}

	const sliceQp = 26 + pps.picInitQpMinus26;
	const context = initCabacContext(MB_SKIP_FLAG_INIT.m, MB_SKIP_FLAG_INIT.n, sliceQp);
	const cabac = new CabacEncoder(writer);

	for (let mb = 0; mb < sps.picSizeInMbs; mb++) {
		cabac.encodeDecision(context, 1); // mb_skip_flag
		cabac.encodeTerminate(mb === sps.picSizeInMbs - 1 ? 1 : 0); // end_of_slice_flag
	}

	// The flush already wrote the stop bit, so only the alignment is left.
	writer.byteAlign();
};

/**
 * How a run of skip frames is placed on the stream it fills a gap in.
 *
 * @group Codecs
 * @public
 */
export type SkipFrameOptions = {
	/** How many frames to build. */
	count: number;
	/**
	 * `frame_num` of the first one. A skip frame is a reference picture, so this continues from the
	 * frame before the gap: a stream whose last frame had `frame_num` N starts here at N + 1. It wraps
	 * at the SPS's `log2_max_frame_num`, which is done here.
	 *
	 * AVC only, and required there unless {@link SkipFrameOptions.precedingSamples} is given, which
	 * states it instead. HEVC codes no `frame_num` and numbers its pictures by
	 * {@link SkipFrameOptions.picOrderCntLsb} alone, so this is ignored there.
	 */
	frameNum?: number;
	/**
	 * `pic_order_cnt_lsb` of the first one, where the SPS states picture order count type 0. Later
	 * frames step by `picOrderCntStep`. Wrapping is done here.
	 */
	picOrderCntLsb?: number;
	/**
	 * What `pic_order_cnt_lsb` advances by per frame. Two for a stream that counts in fields, which is
	 * what most encoders emit; one where it counts in frames.
	 */
	picOrderCntStep?: number;
	/**
	 * How far back the picture these frames copy is, counted from the first of them. AVC counts it in
	 * `frame_num` and HEVC in picture order count, because that is what each builds its reference list
	 * from. It defaults to the picture immediately before: 1 for AVC, `picOrderCntStep` for HEVC.
	 *
	 * State it where the last picture a viewer saw is not the last reference the decoder read, which a
	 * B pyramid produces whenever a segment ends on a complete mini-GOP: the most recently decoded
	 * reference is then a B picture from the middle of that GOP, and frames left to copy it show a
	 * picture the stream has already moved past.
	 *
	 * Only a picture the decoder still holds as a reference can be copied. Where the last picture
	 * displayed is a non-reference B, nothing stated here reaches it, and holding the last key frame
	 * is the only correct fill.
	 */
	copyFromDistance?: number;
	/**
	 * The coded samples before the gap, in decode order and framed as the configuration states,
	 * starting at the key frame the run belongs to.
	 *
	 * Stating them lets this run the reference marking process rather than be told its result:
	 * `frameNum` and `picOrderCntLsb` are then derived instead of computed by the caller, and
	 * {@link SkipFrameOptions.copyPictureOrderCount} can name the copied picture outright.
	 */
	precedingSamples?: Uint8Array[];
	/**
	 * The picture order count of the picture to copy. Requires
	 * {@link SkipFrameOptions.precedingSamples}, since which pictures are still held is a result of
	 * the marking process and not of any one slice header.
	 *
	 * Raises {@link ReferencePictureNotHeldError} where that picture is not a reference at the end of
	 * those samples, so a caller falls back rather than filling with the wrong picture.
	 */
	copyPictureOrderCount?: number;
	/**
	 * Writes an adaptive reference picture marking into every frame, which nothing in the public
	 * surface needs: it exists so a test can produce a stream whose marking this does not model, since
	 * no encoder available emits one. See `test/node/reference-pictures.test.ts`.
	 *
	 * @internal
	 */
	__marking?: { op: number; differenceOfPicNumsMinus1: number }[];
};

/**
 * Base of every refusal `buildSkipFrames` and `buildKeyFrameFill` make about the stream or sample
 * they were given. A caller passing an out-of-range option gets a `TypeError` instead, which is a
 * mistake to fix rather than a case to branch on.
 *
 * @group Codecs
 * @public
 */
export class FrameFillError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FrameFillError';
	}
}

/**
 * The codec cannot carry the frames that were asked for: anything but AVC and HEVC for
 * `buildSkipFrames`, and anything but AVC for `buildKeyFrameFill`, whose `idr_pic_id` only AVC has.
 *
 * @group Codecs
 * @public
 */
export class UnsupportedFillCodecError extends FrameFillError {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedFillCodecError';
	}
}

/**
 * The codec description carries no parameter sets these frames can be coded against, or its first
 * PPS names a different SPS than its first one.
 *
 * @group Codecs
 * @public
 */
export class MissingParameterSetsError extends FrameFillError {
	constructor(message: string) {
		super(message);
		this.name = 'MissingParameterSetsError';
	}
}

/**
 * The PPS enables tiles, so a picture would have to be divided on tile boundaries into one substream
 * each.
 *
 * @group Codecs
 * @public
 */
export class UnsupportedTilesError extends FrameFillError {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedTilesError';
	}
}

/**
 * The sample handed to `buildKeyFrameFill` carries no IDR slice, so there is no key frame to repeat.
 *
 * @group Codecs
 * @public
 */
export class MissingKeyFrameError extends FrameFillError {
	constructor(message: string) {
		super(message);
		this.name = 'MissingKeyFrameError';
	}
}

/**
 * Builds frames that decode to a repeat of the picture before them, against a stream's own decoder
 * configuration — a P picture in which every macroblock or coding unit is skipped.
 *
 * This is what a live origin serves in place of media it never received: the frames carry no residual
 * and no motion, so a decoder holds the last picture it had for as long as they run, and they decode
 * under the parameter sets already in the stream rather than needing an init of their own.
 *
 * Returns one packet per frame, in the same framing the configuration states — length-prefixed where
 * the description is an `avcC` or `hvcC`, with the prefix size that record declares. Throws where the
 * configuration states something this cannot build against, naming it.
 *
 * @group Codecs
 * @public
 */
export const buildSkipFrames = (
	decoderConfig: VideoDecoderConfig,
	options: SkipFrameOptions,
): Uint8Array[] => {
	const codec = decoderConfig.codec.split('.')[0]!;
	validateSkipFrameOptions(options, codec === 'avc1' || codec === 'avc3');

	const description = decoderConfig.description;
	if (!description) {
		throw new MissingParameterSetsError(
			'decoderConfig.description is required: a skip frame is coded against the stream\'s own'
			+ ' parameter sets, which is what that record carries.',
		);
	}

	const resolved = options.precedingSamples
		? resolveAgainstReferences(decoderConfig, options)
		: options;

	const bytes = toUint8Array(description);
	if (codec === 'avc1' || codec === 'avc3') {
		return buildAvcSkipFrames(bytes, resolved);
	}
	if (codec === 'hev1' || codec === 'hvc1') {
		return buildHevcSkipFrames(bytes, resolved);
	}

	throw new UnsupportedFillCodecError(
		`Skip frames can be built for AVC and HEVC; '${decoderConfig.codec}' is neither.`,
	);
};

const validateSkipFrameOptions = (options: SkipFrameOptions, isAvc: boolean) => {
	if (!Number.isInteger(options.count) || options.count < 0) {
		throw new TypeError('count must be a non-negative integer.');
	}
	if (options.frameNum !== undefined
		&& (!Number.isInteger(options.frameNum) || options.frameNum < 0)) {
		throw new TypeError('frameNum must be a non-negative integer.');
	}
	if (isAvc && options.frameNum === undefined && !options.precedingSamples) {
		throw new TypeError(
			'frameNum is required for AVC unless precedingSamples is given to derive it from.',
		);
	}
	if (options.copyPictureOrderCount !== undefined && !options.precedingSamples) {
		throw new TypeError('copyPictureOrderCount requires precedingSamples.');
	}
	if (options.picOrderCntLsb !== undefined
		&& (!Number.isInteger(options.picOrderCntLsb) || options.picOrderCntLsb < 0)) {
		throw new TypeError('picOrderCntLsb must be a non-negative integer.');
	}
	if (options.picOrderCntStep !== undefined
		&& (!Number.isInteger(options.picOrderCntStep) || options.picOrderCntStep < 1)) {
		throw new TypeError('picOrderCntStep must be a positive integer.');
	}
	if (options.copyFromDistance !== undefined
		&& (!Number.isInteger(options.copyFromDistance) || options.copyFromDistance < 1)) {
		throw new TypeError('copyFromDistance must be a positive integer.');
	}
};

/**
 * Turns a stated picture identity into the numbers the slice writers take: what `frame_num` and
 * picture order count the fill continues at, and how far back the copied picture sits.
 *
 * The distance is the same quantity `copyFromDistance` states, which is why it is resolved here
 * rather than inside either writer — `frame_num` for AVC and picture order count for HEVC are
 * exactly what each codec's reference list is ordered by.
 */
const resolveAgainstReferences = (
	decoderConfig: VideoDecoderConfig,
	options: SkipFrameOptions,
): SkipFrameOptions => {
	const codec = decoderConfig.codec.split('.')[0]!;
	const isHevc = codec === 'hev1' || codec === 'hvc1';
	const set = referencePicturesAfter(decoderConfig, options.precedingSamples!);
	const step = options.picOrderCntStep ?? (isHevc ? 1 : 2);

	const frameNum = options.frameNum ?? set.nextFrameNum ?? 0;
	const picOrderCntLsb = options.picOrderCntLsb ?? set.lastDisplayedPictureOrderCount + step;

	let copyFromDistance = options.copyFromDistance;
	if (options.copyPictureOrderCount !== undefined) {
		const target = set.pictures.find(
			p => p.pictureOrderCount === options.copyPictureOrderCount,
		);
		if (!target) {
			throw new ReferencePictureNotHeldError(
				`No reference picture with picture order count ${options.copyPictureOrderCount} is held`
				+ ` after those samples. Held: ${
					set.pictures.map(p => p.pictureOrderCount).sort((a, b) => a - b).join(', ') || 'none'
				}.`,
			);
		}
		if (target.term === 'long') {
			throw new ReferencePictureNotHeldError(
				'Copying a long term reference is not modelled; it would need a long_term_pic_num in the'
				+ ' reference list modification.',
			);
		}

		// AVC reaches a short term picture by a frame_num distance, HEVC by a picture order count one.
		// The AVC distance is modular: `frame_num` wraps at MaxFrameNum, so a fill numbered just after
		// a wrap sits below the picture it copies.
		copyFromDistance = isHevc
			? picOrderCntLsb - target.pictureOrderCount
			: modulo(frameNum - target.frameNum!, maxFrameNumOf(decoderConfig));

		if (copyFromDistance < 1) {
			throw new ReferencePictureNotHeldError(
				'The picture to copy is not behind the first frame being built; a fill can only copy a'
				+ ' picture that precedes it.',
			);
		}
	}

	return { ...options, frameNum, picOrderCntLsb, copyFromDistance };
};

const modulo = (value: number, by: number) => ((value % by) + by) % by;

/** MaxFrameNum, which `frame_num` and every picture number distance wrap at. */
const maxFrameNumOf = (decoderConfig: VideoDecoderConfig) => {
	const { spsList } = parameterSetsFromAvcC(toUint8Array(decoderConfig.description!));
	const sps = spsList.length > 0 ? parseAvcSpsForSkip(spsList[0]!) : null;
	if (!sps) {
		throw new MissingParameterSetsError('The avcC carries no SPS to read log2_max_frame_num from.');
	}

	return 1 << sps.log2MaxFrameNum;
};

const buildAvcSkipFrames = (description: Uint8Array, options: SkipFrameOptions): Uint8Array[] => {
	const { spsList, ppsList, lengthSizeMinusOne } = parameterSetsFromAvcC(description);
	const pps = ppsList.length > 0 ? parseAvcPpsForSkip(ppsList[0]!, 1) : null;
	const sps = spsList.length > 0 ? parseAvcSpsForSkip(spsList[0]!) : null;
	if (!sps || !pps) {
		throw new MissingParameterSetsError('The avcC carries no SPS and PPS this can build a skip frame against.');
	}
	if (pps.spsId !== sps.id) {
		throw new MissingParameterSetsError('The avcC\'s first PPS names a different SPS than its first one.');
	}

	const step = options.picOrderCntStep ?? 2;
	const frames: Uint8Array[] = [];

	for (let i = 0; i < options.count; i++) {
		const writer = new BitWriter();
		writeAvcSkipSliceHeader(
			writer,
			sps,
			pps,
			(options.frameNum ?? 0) + i,
			(options.picOrderCntLsb ?? 0) + i * step,
			// Only the first frame reorders. The modification is relative to this picture's own number,
			// and every frame after this one copies the frame before it, which is already at index 0.
			i === 0 ? (options.copyFromDistance ?? 1) : 1,
			options.__marking ?? null,
		);
		writeAvcSkipSliceData(writer, sps, pps);

		// nal_ref_idc 2 rather than 0: each of these is the reference the next one copies.
		const header = Uint8Array.from([(2 << 5) | 1]); // non-IDR coded slice
		const payload = addEmulationPreventionBytes(writer.finish());
		const nal = new Uint8Array(header.length + payload.length);
		nal.set(header, 0);
		nal.set(payload, header.length);

		frames.push(withLengthPrefix(nal, lengthSizeMinusOne + 1));
	}

	return frames;
};

const withLengthPrefix = (nal: Uint8Array, prefixSize: number): Uint8Array => {
	const out = new Uint8Array(prefixSize + nal.length);
	for (let i = 0; i < prefixSize; i++) {
		out[i] = (nal.length >>> (8 * (prefixSize - 1 - i))) & 0xff;
	}

	out.set(nal, prefixSize);
	return out;
};

// ---------------------------------------------------------------------------------------------
// HEVC. The arithmetic coder above is reused unchanged; what differs is the slice header, the
// quadtree the skip flags hang off, and that a picture may be split into one substream per CTU row.
// ---------------------------------------------------------------------------------------------

/**
 * Table 9-7 initValues for a P slice (initType 1).
 *
 * `cu_skip_flag` takes three contexts, selected by how many neighbours are themselves skipped.
 * `split_cu_flag` takes three too, selected by how many neighbours are at a greater depth — but only
 * its first is ever reachable here, because the only splits this writes are the ones the picture edge
 * forces, and those sit at the right and bottom edges where depth never decreases. A left or above
 * neighbour is therefore never deeper than the block being coded.
 */
const HEVC_SPLIT_CU_FLAG_INIT = 107;
const HEVC_CU_SKIP_FLAG_INIT = [197, 185, 201];
const HEVC_CU_TRANSQUANT_BYPASS_INIT = 154;

/** 9.3.2.2: an initValue packs the slope and offset the shared initialisation needs. */
const hevcContext = (initValue: number, qp: number) =>
	initCabacContext((initValue >> 4) * 5 - 45, ((initValue & 15) << 3) - 16, qp);

type HevcSkipContexts = {
	splitCuFlag: CabacContext;
	cuSkipFlag: CabacContext[];
	transquantBypass: CabacContext;
};

const initHevcSkipContexts = (qp: number): HevcSkipContexts => ({
	splitCuFlag: hevcContext(HEVC_SPLIT_CU_FLAG_INIT, qp),
	cuSkipFlag: HEVC_CU_SKIP_FLAG_INIT.map(v => hevcContext(v, qp)),
	transquantBypass: hevcContext(HEVC_CU_TRANSQUANT_BYPASS_INIT, qp),
});

const copyHevcSkipContexts = (from: HevcSkipContexts): HevcSkipContexts => ({
	splitCuFlag: { ...from.splitCuFlag },
	cuSkipFlag: from.cuSkipFlag.map(c => ({ ...c })),
	transquantBypass: { ...from.transquantBypass },
});

/**
 * The slice segment header of a P picture every coding unit of which is skipped. Three of these
 * values are chosen rather than copied, and each one removes syntax that would otherwise have to be
 * coded: SAO off removes the per-CTU filter elements, temporal MVP off removes the collocated
 * picture, and one merge candidate removes `merge_idx` from every prediction unit.
 */
const writeHevcSkipSliceHeader = (
	writer: BitWriter,
	sps: HevcSpsInfo,
	pps: HevcPps,
	picOrderCntLsb: number,
	copyFromDistance: number,
) => {
	writer.writeBits(1, 1); // first_slice_segment_in_pic_flag
	writer.writeUe(pps.id);

	for (let i = 0; i < pps.numExtraSliceHeaderBits; i++) {
		writer.writeBits(1, 0); // slice_reserved_flag[i]
	}

	writer.writeUe(1); // slice_type: P

	if (pps.outputFlagPresentFlag) {
		writer.writeBits(1, 1); // pic_output_flag
	}
	if (sps.separateColourPlaneFlag) {
		writer.writeBits(2, 0); // colour_plane_id
	}

	writer.writeBits(sps.log2MaxPicOrderCntLsb, picOrderCntLsb & ((1 << sps.log2MaxPicOrderCntLsb) - 1));

	// A short term reference picture set written here rather than chosen out of the SPS, naming one
	// picture: the one immediately before this. That is the picture every skip unit copies.
	writer.writeBits(1, 0); // short_term_ref_pic_set_sps_flag
	if (sps.numShortTermRefPicSets !== 0) {
		writer.writeBits(1, 0); // inter_ref_pic_set_prediction_flag
	}

	writer.writeUe(1); // num_negative_pics
	writer.writeUe(0); // num_positive_pics
	writer.writeUe(copyFromDistance - 1); // delta_poc_s0_minus1[0]
	writer.writeBits(1, 1); // used_by_curr_pic_s0_flag[0]

	if (sps.longTermRefPicsPresentFlag) {
		writer.writeUe(0); // num_long_term_pics, with num_long_term_sps absent while none are in the SPS
	}
	if (sps.spsTemporalMvpEnabledFlag) {
		writer.writeBits(1, 0); // slice_temporal_mvp_enabled_flag
	}
	if (sps.sampleAdaptiveOffsetEnabledFlag) {
		writer.writeBits(1, 0); // slice_sao_luma_flag
		if (hevcChromaArrayType(sps) !== 0) {
			writer.writeBits(1, 0); // slice_sao_chroma_flag
		}
	}

	// One active reference, for the same reason as in AVC: the list is otherwise sized by the PPS and
	// the decoder fills what does not exist yet with a default picture.
	writer.writeBits(1, 1); // num_ref_idx_active_override_flag
	writer.writeUe(0); // num_ref_idx_l0_active_minus1

	// ref_pic_lists_modification is absent: it is conditioned on NumPicTotalCurr > 1, and the set
	// written above names exactly one picture.

	if (pps.cabacInitPresentFlag) {
		writer.writeBits(1, 0); // cabac_init_flag, so the contexts above are the initType 1 ones
	}
	if (pps.weightedPredFlag) {
		writer.writeUe(0); // luma_log2_weight_denom
		if (hevcChromaArrayType(sps) !== 0) {
			writer.writeSe(0); // delta_chroma_log2_weight_denom
		}

		writer.writeBits(1, 0); // luma_weight_l0_flag[0]
		if (hevcChromaArrayType(sps) !== 0) {
			writer.writeBits(1, 0); // chroma_weight_l0_flag[0]
		}
	}

	writer.writeUe(4); // five_minus_max_num_merge_cand: MaxNumMergeCand 1, so merge_idx is never coded
	writer.writeSe(0); // slice_qp_delta: SliceQpY is the PPS's own init_qp

	if (pps.ppsSliceChromaQpOffsetsPresentFlag) {
		writer.writeSe(0); // slice_cb_qp_offset
		writer.writeSe(0); // slice_cr_qp_offset
	}
	if (pps.deblockingFilterOverrideEnabledFlag) {
		writer.writeBits(1, 0); // deblocking_filter_override_flag
	}
	if (pps.ppsLoopFilterAcrossSlicesEnabledFlag && !pps.ppsDeblockingFilterDisabledFlag) {
		// The SAO flags above are both zero, so this is conditioned on deblocking alone.
		writer.writeBits(1, 1); // slice_loop_filter_across_slices_enabled_flag
	}
	if (pps.tilesEnabledFlag || pps.entropyCodingSyncEnabledFlag) {
		// The substreams are written, but their offsets are not. They index the picture for a decoder
		// that wants to run its rows in parallel, and stating none of them is allowed.
		writer.writeUe(0); // num_entry_point_offsets
	}
	if (pps.sliceSegmentHeaderExtensionPresentFlag) {
		writer.writeUe(0); // slice_segment_header_extension_length
	}

	writer.writeBits(1, 1); // alignment_bit_equal_to_one
	writer.byteAlign();
};

const hevcChromaArrayType = (sps: HevcSpsInfo) =>
	sps.separateColourPlaneFlag === 0 ? sps.chromaFormatIdc : 0;

/**
 * The coding tree of a picture in which every unit is skipped.
 *
 * Two things stop this being one flag per CTU. A CTU that hangs over the right or bottom edge has no
 * `split_cu_flag` of its own — the split is inferred — so the tree has to be walked and only the
 * quadrants inside the picture coded, which leaves the edge of the picture at a greater depth than
 * the middle. That depth is then what `split_cu_flag`'s context is selected by, so it is tracked per
 * coding block rather than assumed.
 */
const writeHevcSkipSliceData = (
	writer: BitWriter,
	sps: HevcSpsInfo,
	pps: HevcPps,
	sliceQp: number,
) => {
	const ctbLog2 = sps.log2CtbSizeY;
	const ctbSize = 1 << ctbLog2;
	const picWidth = sps.picWidthInLumaSamples;
	const picHeight = sps.picHeightInLumaSamples;
	const widthInCtbs = Math.ceil(picWidth / ctbSize);
	const heightInCtbs = Math.ceil(picHeight / ctbSize);

	const minCbLog2 = sps.log2MinCbSizeY;

	let contexts = initHevcSkipContexts(sliceQp);
	let saved: HevcSkipContexts | null = null;
	let cabac = new CabacEncoder(writer);

	const writeCodingUnit = (x0: number, y0: number) => {
		if (pps.transquantBypassEnabledFlag) {
			cabac.encodeDecision(contexts.transquantBypass, 0); // cu_transquant_bypass_flag
		}

		// Every neighbour that exists is itself skipped, so the context is picked by availability
		// alone (9.3.4.2.2).
		const ctxInc = (x0 > 0 ? 1 : 0) + (y0 > 0 ? 1 : 0);
		cabac.encodeDecision(contexts.cuSkipFlag[ctxInc]!, 1); // cu_skip_flag

		// prediction_unit(): MaxNumMergeCand is 1, so merge_idx is not coded and the unit is complete.
	};

	const writeQuadtree = (x0: number, y0: number, log2CbSize: number) => {
		const size = 1 << log2CbSize;
		const fits = x0 + size <= picWidth && y0 + size <= picHeight;

		if (fits) {
			if (log2CbSize > minCbLog2) {
				cabac.encodeDecision(contexts.splitCuFlag, 0); // split_cu_flag
			}

			writeCodingUnit(x0, y0);
			return;
		}

		// Hanging over an edge: the split is inferred, so no bin is written for it.
		const half = size >> 1;
		const x1 = x0 + half;
		const y1 = y0 + half;
		writeQuadtree(x0, y0, log2CbSize - 1);
		if (x1 < picWidth) {
			writeQuadtree(x1, y0, log2CbSize - 1);
		}
		if (y1 < picHeight) {
			writeQuadtree(x0, y1, log2CbSize - 1);
		}
		if (x1 < picWidth && y1 < picHeight) {
			writeQuadtree(x1, y1, log2CbSize - 1);
		}
	};

	for (let ctb = 0; ctb < widthInCtbs * heightInCtbs; ctb++) {
		const column = ctb % widthInCtbs;
		const row = (ctb - column) / widthInCtbs;

		if (pps.entropyCodingSyncEnabledFlag && column === 0 && ctb !== 0) {
			// A new substream: its contexts come from the row above, two CTUs in, and the arithmetic
			// coder starts again.
			contexts = saved ? copyHevcSkipContexts(saved) : initHevcSkipContexts(sliceQp);
			cabac = new CabacEncoder(writer);
		}

		writeQuadtree(column * ctbSize, row * ctbSize, ctbLog2);

		if (pps.entropyCodingSyncEnabledFlag && column === Math.min(1, widthInCtbs - 1)) {
			saved = copyHevcSkipContexts(contexts);
		}

		const last = ctb === widthInCtbs * heightInCtbs - 1;
		cabac.encodeTerminate(last ? 1 : 0); // end_of_slice_segment_flag

		if (last) {
			break;
		}
		if (pps.entropyCodingSyncEnabledFlag && column === widthInCtbs - 1) {
			cabac.encodeTerminate(1); // end_of_subset_one_bit
			writer.byteAlign();
		}
	}

	// The flush that ended the last substream already wrote the stop bit.
	writer.byteAlign();
};

const buildHevcSkipFrames = (description: Uint8Array, options: SkipFrameOptions): Uint8Array[] => {
	const { spsList, ppsList, lengthSizeMinusOne } = parameterSetsFromHvcC(description);
	const sps = spsList.length > 0 ? parseHevcSps(spsList[0]!) : null;
	const pps = ppsList.length > 0 ? parseHevcPpsForSkip(ppsList[0]!) : null;
	if (!sps || !pps) {
		throw new MissingParameterSetsError('The hvcC carries no SPS and PPS this can build a skip frame against.');
	}
	if (pps.tilesEnabledFlag) {
		throw new UnsupportedTilesError(
			'Skip frames cannot be built for a stream whose PPS enables tiles: each tile is a substream'
			+ ' whose boundaries the picture would have to be divided on.',
		);
	}

	const step = options.picOrderCntStep ?? 1;
	const sliceQp = 26 + pps.initQpMinus26;
	const frames: Uint8Array[] = [];

	for (let i = 0; i < options.count; i++) {
		const writer = new BitWriter();
		writeHevcSkipSliceHeader(
			writer,
			sps,
			pps,
			(options.picOrderCntLsb ?? 0) + i * step,
			i === 0 ? (options.copyFromDistance ?? step) : step,
		);
		writeHevcSkipSliceData(writer, sps, pps, sliceQp);

		// TRAIL_R: a trailing picture that is itself a reference, so the next one can copy it.
		const header = Uint8Array.from([1 << 1, 1]);
		const payload = addEmulationPreventionBytes(writer.finish());
		const nal = new Uint8Array(header.length + payload.length);
		nal.set(header, 0);
		nal.set(payload, header.length);

		frames.push(withLengthPrefix(nal, lengthSizeMinusOne + 1));
	}

	return frames;
};

/**
 * How a key frame is repeated to hold a picture over a gap.
 *
 * @group Codecs
 * @public
 */
export type KeyFrameFillOptions = {
	/** How many access units to build. */
	count: number;
};

/**
 * Builds access units that repeat a key frame, for a gap no skip frame can fill — where the picture
 * last displayed is not one the decoder still holds as a reference.
 *
 * Each one decodes to the same picture as `sample`, and consecutive IDR pictures are required to carry
 * different `idr_pic_id` values (7.4.3), including against the real key frame a caller places after
 * the run. That is handled here: the values differ from each other and from the one `sample` states,
 * so the original can follow the last of these directly.
 *
 * AVC only. HEVC has no such field, so its key frames may be repeated as they are.
 *
 * @group Codecs
 * @public
 */
export const buildKeyFrameFill = (
	sample: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	options: KeyFrameFillOptions,
): Uint8Array[] => {
	if (!Number.isInteger(options.count) || options.count < 0) {
		throw new TypeError('count must be a non-negative integer.');
	}

	const codec = decoderConfig.codec.split('.')[0]!;
	if (codec !== 'avc1' && codec !== 'avc3') {
		throw new UnsupportedFillCodecError(
			`Repeating a key frame needs its idr_pic_id rewritten, which only AVC has; `
			+ `'${decoderConfig.codec}' does not.`,
		);
	}
	if (!decoderConfig.description) {
		throw new MissingParameterSetsError(
			'decoderConfig.description is required: the slice headers are read against the stream\'s own'
			+ ' parameter sets, which is what that record carries.',
		);
	}

	const { spsList, ppsList, lengthSizeMinusOne } = parameterSetsFromAvcC(
		toUint8Array(decoderConfig.description),
	);
	const sps = spsList.length > 0 ? parseAvcSpsForSkip(spsList[0]!) : null;
	const pps = ppsList.length > 0 ? parseAvcPpsForSkip(ppsList[0]!, sps?.chromaFormatIdc ?? 1) : null;
	if (!sps || !pps) {
		throw new MissingParameterSetsError('The avcC carries no SPS and PPS to read the slice headers against.');
	}

	const prefixSize = lengthSizeMinusOne + 1;
	const units = splitLengthPrefixed(sample, prefixSize);
	const stated = statedIdrPicId(units, sps, pps);
	if (stated === null) {
		throw new MissingKeyFrameError('The sample carries no IDR slice to repeat.');
	}

	const frames: Uint8Array[] = [];
	for (let i = 0; i < options.count; i++) {
		// Walk away from the value the sample states, so the last of these also differs from it.
		const idrPicId = (stated + 1 + (i % 2)) % 65536;
		const rewritten: Uint8Array[] = [];
		for (const unit of units) {
			rewritten.push(
				(unit[0]! & 0x1f) === 5
					? withLengthPrefix(rewriteIdrPicId(unit, sps, pps, idrPicId), prefixSize)
					: withLengthPrefix(unit, prefixSize),
			);
		}

		frames.push(concatenate(rewritten));
	}

	return frames;
};

const splitLengthPrefixed = (sample: Uint8Array, prefixSize: number) => {
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

const concatenate = (parts: Uint8Array[]) => {
	let length = 0;
	for (const part of parts) {
		length += part.length;
	}

	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}

	return out;
};

const statedIdrPicId = (units: Uint8Array[], sps: AvcSps, pps: AvcPps) => {
	for (const unit of units) {
		if ((unit[0]! & 0x1f) !== 5) {
			continue;
		}

		const bs = new Bitstream(removeEmulationPreventionBytes(unit));
		bs.skipBits(8);
		const header = readIdrSliceHeaderPrefix(bs, sps, pps);
		if (header) {
			return header.idrPicId;
		}
	}

	return null;
};

/** The slice header fields up to and including `idr_pic_id`, which is the one being replaced. */
const readIdrSliceHeaderPrefix = (bs: Bitstream, sps: AvcSps, pps: AvcPps) => {
	const firstMbInSlice = readExpGolomb(bs);
	const sliceType = readExpGolomb(bs);
	if (sliceType !== 2 && sliceType !== 7) {
		return null; // An IDR carries I slices; anything else is not this
	}

	const ppsId = readExpGolomb(bs);
	const colourPlaneId = sps.separateColourPlaneFlag ? bs.readBits(2) : null;
	const frameNum = bs.readBits(sps.log2MaxFrameNum);

	let fieldPicFlag = 0;
	let bottomFieldFlag: number | null = null;
	if (!sps.frameMbsOnlyFlag) {
		fieldPicFlag = bs.readBits(1);
		if (fieldPicFlag) {
			bottomFieldFlag = bs.readBits(1);
		}
	}

	const idrPicId = readExpGolomb(bs);
	void pps;

	return { firstMbInSlice, sliceType, ppsId, colourPlaneId, frameNum, fieldPicFlag, bottomFieldFlag,
		idrPicId };
};

/**
 * Re-emits an IDR slice with a different `idr_pic_id`. The field is an `ue(v)`, so replacing it moves
 * every bit after it — the rest of the header is read and written back rather than copied, and the
 * entropy-coded data is re-aligned behind it.
 */
const rewriteIdrPicId = (
	unit: Uint8Array,
	sps: AvcSps,
	pps: AvcPps,
	idrPicId: number,
): Uint8Array => {
	const rbsp = removeEmulationPreventionBytes(unit);
	const bs = new Bitstream(rbsp);
	bs.skipBits(8); // NAL header

	const prefix = readIdrSliceHeaderPrefix(bs, sps, pps);
	if (!prefix) {
		return unit; // Not a slice this understands; leave it as it is
	}

	// The rest of the header, read so it can be written back at its new position.
	let picOrderCntLsb: number | null = null;
	let deltaPicOrderCntBottom: number | null = null;
	const deltaPicOrderCnt: number[] = [];
	if (sps.picOrderCntType === 0) {
		picOrderCntLsb = bs.readBits(sps.log2MaxPicOrderCntLsb);
		if (pps.bottomFieldPicOrderInFramePresentFlag && !prefix.fieldPicFlag) {
			deltaPicOrderCntBottom = readSignedExpGolomb(bs);
		}
	} else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZeroFlag) {
		deltaPicOrderCnt.push(readSignedExpGolomb(bs));
		if (pps.bottomFieldPicOrderInFramePresentFlag && !prefix.fieldPicFlag) {
			deltaPicOrderCnt.push(readSignedExpGolomb(bs));
		}
	}

	const redundantPicCnt = pps.redundantPicCntPresentFlag ? readExpGolomb(bs) : null;
	const noOutputOfPriorPicsFlag = bs.readBits(1);
	const longTermReferenceFlag = bs.readBits(1);
	const sliceQpDelta = readSignedExpGolomb(bs);

	let disableDeblockingFilterIdc: number | null = null;
	let sliceAlphaC0OffsetDiv2 = 0;
	let sliceBetaOffsetDiv2 = 0;
	if (pps.deblockingFilterControlPresentFlag) {
		disableDeblockingFilterIdc = readExpGolomb(bs);
		if (disableDeblockingFilterIdc !== 1) {
			sliceAlphaC0OffsetDiv2 = readSignedExpGolomb(bs);
			sliceBetaOffsetDiv2 = readSignedExpGolomb(bs);
		}
	}

	const writer = new BitWriter();
	writer.writeBits(8, unit[0]!);
	writer.writeUe(prefix.firstMbInSlice);
	writer.writeUe(prefix.sliceType);
	writer.writeUe(prefix.ppsId);
	if (prefix.colourPlaneId !== null) {
		writer.writeBits(2, prefix.colourPlaneId);
	}

	writer.writeBits(sps.log2MaxFrameNum, prefix.frameNum);
	if (!sps.frameMbsOnlyFlag) {
		writer.writeBits(1, prefix.fieldPicFlag);
		if (prefix.bottomFieldFlag !== null) {
			writer.writeBits(1, prefix.bottomFieldFlag);
		}
	}

	writer.writeUe(idrPicId);

	if (picOrderCntLsb !== null) {
		writer.writeBits(sps.log2MaxPicOrderCntLsb, picOrderCntLsb);
		if (deltaPicOrderCntBottom !== null) {
			writer.writeSe(deltaPicOrderCntBottom);
		}
	}
	for (const delta of deltaPicOrderCnt) {
		writer.writeSe(delta);
	}
	if (redundantPicCnt !== null) {
		writer.writeUe(redundantPicCnt);
	}

	writer.writeBits(1, noOutputOfPriorPicsFlag);
	writer.writeBits(1, longTermReferenceFlag);
	writer.writeSe(sliceQpDelta);

	if (disableDeblockingFilterIdc !== null) {
		writer.writeUe(disableDeblockingFilterIdc);
		if (disableDeblockingFilterIdc !== 1) {
			writer.writeSe(sliceAlphaC0OffsetDiv2);
			writer.writeSe(sliceBetaOffsetDiv2);
		}
	}

	if (pps.entropyCodingModeFlag) {
		// The arithmetic data starts on a byte boundary, so it is re-aligned here and then copied
		// whole. Where the header's own length changed, the padding differs; the data does not.
		while (writer.bitsWritten % 8 !== 0) {
			writer.writeBits(1, 1); // cabac_alignment_one_bit
		}
		while (bs.pos % 8 !== 0) {
			bs.skipBits(1);
		}

		const payload = rbsp.subarray(bs.pos / 8);
		const header = writer.finish();
		const out = new Uint8Array(header.length + payload.length);
		out.set(header, 0);
		out.set(payload, header.length);
		return addEmulationPreventionBytes(out);
	}

	// Variable length data follows the header bit by bit, so it moves with it.
	const totalBits = rbsp.length * 8;
	while (bs.pos + 8 <= totalBits) {
		writer.writeBits(8, bs.readBits(8));
	}
	if (bs.pos < totalBits) {
		const left = totalBits - bs.pos;
		writer.writeBits(left, bs.readBits(left));
	}

	return addEmulationPreventionBytes(writer.finish());
};

/**
 * Every `idr_pic_id` an access unit states, in slice order. Exists so a test can check that
 * consecutive repeats differ without re-implementing the slice header walk.
 *
 * @internal
 */
export const __idrPicIdsOf = (sample: Uint8Array, decoderConfig: VideoDecoderConfig): number[] => {
	const { spsList, ppsList, lengthSizeMinusOne } = parameterSetsFromAvcC(
		toUint8Array(decoderConfig.description!),
	);
	const sps = parseAvcSpsForSkip(spsList[0]!);
	const pps = parseAvcPpsForSkip(ppsList[0]!, sps?.chromaFormatIdc ?? 1);
	if (!sps || !pps) {
		return [];
	}

	const ids: number[] = [];
	for (const unit of splitLengthPrefixed(sample, lengthSizeMinusOne + 1)) {
		if ((unit[0]! & 0x1f) !== 5) {
			continue;
		}

		const bs = new Bitstream(removeEmulationPreventionBytes(unit));
		bs.skipBits(8);
		const header = readIdrSliceHeaderPrefix(bs, sps, pps);
		if (header) {
			ids.push(header.idrPicId);
		}
	}

	return ids;
};
