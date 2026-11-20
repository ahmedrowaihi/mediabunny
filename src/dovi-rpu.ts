/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Generating a Dolby Vision RPU for profile 8.1 - an HDR10 base layer with Dolby Vision metadata on
// top of it, which is the profile every HDR10 source can be given without re-encoding the pictures.
//
// The RPU is one bit-packed structure per frame: a header stating the profile and the bit depths, a
// mapping (identity, for 8.1 - the base layer IS the picture), and the display management data, which
// is where the metadata a colourist sets actually lives. It ends with a CRC-32/MPEG-2 over everything
// but its own prefix octet, and then rides the bitstream as HEVC NAL unit type 62.
//
// **The syntax is not public.** Every field order and width here was read out of `dovi_tool`
// (quietvoid/dovi_tool, `dolby_vision/src/rpu/`), which is also the oracle the tests use: for the same
// inputs, this writes the same octets `dovi_tool generate` does, which is the only check available.

import { DOLBY_VISION_RPU_NAL_PREFIX, HEVC_DOVI_RPU_NAL_TYPE } from './dovi';

/**
 * L1: how bright the frame actually is, in 12-bit PQ.
 *
 * Stated per frame, and the only block that is. A player uses it to decide how to map the frame onto
 * a display that cannot show its full range, so values that do not describe the picture produce
 * visibly wrong tone mapping rather than an error.
 *
 * @group Codecs
 * @public
 */
export type DolbyVisionLevel1 = {
	/** The darkest pixel in the frame, as a 12-bit PQ code. */
	minPq: number;
	/** The brightest pixel in the frame, as a 12-bit PQ code. */
	maxPq: number;
	/** The frame's average, as a 12-bit PQ code. */
	avgPq: number;
};

/**
 * L5: the active area, as offsets from each edge in pixels.
 *
 * This is what tells a player where the picture is inside the coded frame, so letterbox bars are not
 * treated as content. Zero on every side means the whole frame is active.
 *
 * @group Codecs
 * @public
 */
export type DolbyVisionLevel5 = {
	/** In pixels. */
	left: number;
	/** In pixels. */
	right: number;
	/** In pixels. */
	top: number;
	/** In pixels. */
	bottom: number;
};

/**
 * L6: the HDR10 static metadata, carried so a player that falls back to HDR10 still has it.
 *
 * These are the same four numbers as the `mdcv` and `clli` boxes, in the same units.
 *
 * @group Codecs
 * @public
 */
export type DolbyVisionLevel6 = {
	/** In cd/m², as ST 2086 states it. */
	maxDisplayMasteringLuminance: number;
	/** In units of 0.0001 cd/m², as ST 2086 states it. */
	minDisplayMasteringLuminance: number;
	/** MaxCLL, in cd/m². */
	maxContentLightLevel: number;
	/** MaxFALL, in cd/m². */
	maxFrameAverageLightLevel: number;
};

/**
 * What one profile 8.1 RPU states.
 *
 * @group Codecs
 * @public
 */
export type DolbyVisionRpuOptions = {
	/**
	 * Whether this frame begins a shot. The first frame of each shot sets it, and a player takes it as
	 * the point to apply new metadata from rather than easing into it.
	 */
	sceneCut?: boolean;
	/** The frame's own brightness. Omitted, the RPU states a full-range frame. */
	level1?: DolbyVisionLevel1;
	/** The active area. Omitted, the whole frame is active. */
	level5?: DolbyVisionLevel5;
	/** The HDR10 static metadata. Omitted, 1000 cd/m² mastering with no content light levels. */
	level6?: DolbyVisionLevel6;
	/**
	 * The mastering display's own range, as 12-bit PQ codes. Omitted, both are derived from
	 * {@link DolbyVisionRpuOptions.level6}, which is what `dovi_tool` does.
	 */
	sourceMinPq?: number;
	/** See {@link DolbyVisionRpuOptions.sourceMinPq}. */
	sourceMaxPq?: number;
};

/** A bit writer that grows, since an RPU's length is not known until it is written. */
class RpuBitWriter {
	private bytes = new Uint8Array(512);
	private bitLength = 0;

	private ensure(bits: number) {
		const needed = (this.bitLength + bits + 7) >> 3;
		if (needed <= this.bytes.length) {
			return;
		}

		const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
		grown.set(this.bytes);
		this.bytes = grown;
	}

	/** Writes the low `count` bits of `value`, most significant first. */
	writeBits(count: number, value: number) {
		this.ensure(count);

		for (let i = count - 1; i >= 0; i--) {
			const bit = (value >>> i) & 1;
			if (bit) {
				this.bytes[this.bitLength >> 3]! |= 0x80 >> (this.bitLength & 7);
			}

			this.bitLength++;
		}
	}

	/** Two's complement in `count` bits, which is how every signed field here is stated. */
	writeSignedBits(count: number, value: number) {
		this.writeBits(count, value < 0 ? value + (1 << count) : value);
	}

	/** More than 31 bits at a time, for the 32-bit fields. */
	writeBits32(value: number) {
		this.writeBits(16, (value >>> 16) & 0xffff);
		this.writeBits(16, value & 0xffff);
	}

	/** Unsigned exp-Golomb. */
	writeUe(value: number) {
		const code = value + 1;
		let bits = 0;
		while (code >>> (bits + 1) !== 0) {
			bits++;
		}

		this.writeBits(bits, 0);
		this.writeBits(bits + 1, code);
	}

	/** Signed exp-Golomb, which maps a signed value onto an unsigned one. */
	writeSe(value: number) {
		this.writeUe(value > 0 ? 2 * value - 1 : -2 * value);
	}

	byteAlign() {
		while ((this.bitLength & 7) !== 0) {
			this.writeBits(1, 0);
		}
	}

	/** Zero bits, which is what every alignment and padding field in an RPU is. */
	pad(bits: number) {
		for (let i = 0; i < bits; i++) {
			this.writeBits(1, 0);
		}
	}

	get bitsWritten() {
		return this.bitLength;
	}

	finish() {
		return this.bytes.subarray(0, (this.bitLength + 7) >> 3);
	}
}

/**
 * CRC-32/MPEG-2: the ordinary CRC-32 polynomial, but with no reflection of input or output and no
 * final xor. An RPU written with the reflected variant parses and then fails its checksum.
 */
const crc32Mpeg2 = (data: Uint8Array) => {
	let crc = 0xffffffff;

	for (const byte of data) {
		crc ^= byte << 24;
		for (let i = 0; i < 8; i++) {
			crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
		}
	}

	return crc >>> 0;
};

/**
 * Inserts an emulation prevention octet wherever the payload would otherwise contain a start code.
 *
 * The walk begins at the fourth octet, matching the writer every reader of these was built against:
 * the first three cannot be a start code's tail without the NAL header that precedes them.
 */
const addEmulationPrevention = (data: Uint8Array) => {
	const out = [...data];

	// Walked over the GROWING array, so an inserted octet becomes the `i - 1` of the next check and
	// ends the run of zeroes. Counting the zeroes of the input instead escapes every third octet of a
	// long run rather than every third of the output, which is a different and wrong answer.
	let i = 0;
	while (i < out.length) {
		if (i > 2 && out[i - 2] === 0 && out[i - 1] === 0 && out[i]! <= 3) {
			out.splice(i, 0, 3);
		}

		i++;
	}

	return Uint8Array.from(out);
};

/** Profile 8.1's colour transforms, which are fixed: a BT.2020 PQ base layer mapped to itself. */
const YCC_TO_RGB_COEFFICIENTS = [9574, 0, 13802, 9574, -1540, -5348, 9574, 17610, 0];
const YCC_TO_RGB_OFFSETS = [16777216, 134217728, 134217728];
const RGB_TO_LMS_COEFFICIENTS = [7222, 8771, 390, 2654, 12430, 1300, 0, 422, 15962];

/** The mastering display range each L6 maximum implies, where the caller states none. */
const sourcePqFromLevel6 = (level6: DolbyVisionLevel6) => {
	const minLuminance = level6.minDisplayMasteringLuminance;
	const sourceMinPq = minLuminance <= 10 ? 7 : minLuminance === 50 ? 62 : 0;

	const sourceMaxPq = { 1000: 3079, 2000: 3388, 4000: 3696, 10000: 4095 }[
		level6.maxDisplayMasteringLuminance
	] ?? 3079;

	return { sourceMinPq, sourceMaxPq };
};

/** One extension metadata block, already packed, with the length its container states. */
type PackedBlock = { level: number; lengthBytes: number; write: (writer: RpuBitWriter) => void };

const DEFAULT_LEVEL_6: DolbyVisionLevel6 = {
	maxDisplayMasteringLuminance: 1000,
	minDisplayMasteringLuminance: 1,
	maxContentLightLevel: 0,
	maxFrameAverageLightLevel: 0,
};

const blocksOf = (options: DolbyVisionRpuOptions): PackedBlock[] => {
	const blocks: PackedBlock[] = [];

	// Sorted by level, which is the order a container states them in
	if (options.level1) {
		const { minPq, maxPq, avgPq } = options.level1;
		blocks.push({
			level: 1,
			lengthBytes: 5,
			write: (writer) => {
				writer.writeBits(12, minPq);
				writer.writeBits(12, maxPq);
				writer.writeBits(12, avgPq);
			},
		});
	}

	// L5 is written even when the caller states none: an RPU with no active area is not one a player
	// expects, and all-zero offsets are what "the whole frame" means
	const level5 = options.level5 ?? { left: 0, right: 0, top: 0, bottom: 0 };
	blocks.push({
		level: 5,
		lengthBytes: 7,
		write: (writer) => {
			writer.writeBits(13, level5.left);
			writer.writeBits(13, level5.right);
			writer.writeBits(13, level5.top);
			writer.writeBits(13, level5.bottom);
		},
	});

	const level6 = options.level6 ?? DEFAULT_LEVEL_6;
	blocks.push({
		level: 6,
		lengthBytes: 8,
		write: (writer) => {
			writer.writeBits(16, level6.maxDisplayMasteringLuminance);
			writer.writeBits(16, level6.minDisplayMasteringLuminance);
			writer.writeBits(16, level6.maxContentLightLevel);
			writer.writeBits(16, level6.maxFrameAverageLightLevel);
		},
	});

	return blocks;
};

const writeHeader = (writer: RpuBitWriter) => {
	writer.writeBits(6, 2); // rpu_type
	writer.writeBits(11, 18); // rpu_format
	writer.writeBits(4, 1); // vdr_rpu_profile: 1 for profiles 4, 7 and 8
	writer.writeBits(4, 0); // vdr_rpu_level
	writer.writeBits(1, 1); // vdr_seq_info_present_flag

	writer.writeBits(1, 0); // chroma_resampling_explicit_filter_flag
	writer.writeBits(2, 0); // coefficient_data_type: fixed point
	writer.writeUe(23); // coefficient_log2_denom
	writer.writeBits(2, 1); // vdr_rpu_normalized_idc
	writer.writeBits(1, 0); // bl_video_full_range_flag

	writer.writeUe(2); // bl_bit_depth_minus8: 10-bit base layer
	writer.writeUe(2); // el_bit_depth_minus8, with ext_mapping_idc 0 in its upper octet
	writer.writeUe(4); // vdr_bit_depth_minus8
	writer.writeBits(1, 0); // spatial_resampling_filter_flag
	writer.writeBits(3, 0); // reserved_zero_3bits
	writer.writeBits(1, 0); // el_spatial_resampling_filter_flag
	// No enhancement layer, which with vdr_rpu_profile 1 is what makes this profile 8 rather than 7
	writer.writeBits(1, 1); // disable_residual_flag

	writer.writeBits(1, 1); // vdr_dm_metadata_present_flag
	writer.writeBits(1, 0); // use_prev_vdr_rpu_flag
};

/** The number of bits a coefficient takes, which `coefficient_log2_denom` fixes. */
const COEFFICIENT_BITS = 23;

/** 10-bit base layer, so the pivots are stated in 10 bits. */
const BL_BIT_DEPTH = 10;

const writeMapping = (writer: RpuBitWriter) => {
	writer.writeUe(0); // vdr_rpu_id
	writer.writeUe(0); // mapping_color_space
	writer.writeUe(0); // mapping_chroma_format_idc

	for (let component = 0; component < 3; component++) {
		writer.writeUe(0); // num_pivots_minus2: one piece
		writer.writeBits(BL_BIT_DEPTH, 0);
		writer.writeBits(BL_BIT_DEPTH, 1023);
	}

	// `disable_residual_flag` is set, so there is no NLQ section

	writer.writeUe(0); // num_x_partitions_minus1
	writer.writeUe(0); // num_y_partitions_minus1

	for (let component = 0; component < 3; component++) {
		writer.writeUe(0); // mapping_idc: polynomial
		writer.writeUe(0); // poly_order_minus1
		writer.writeBits(1, 0); // linear_interp_flag

		// An identity map: the output is the input, so the constant term is 0 and the linear one is 1.
		// Both are written as an integer part and a fraction, and the fractions are zero.
		writer.writeSe(0);
		writer.writeBits(COEFFICIENT_BITS, 0);
		writer.writeSe(1);
		writer.writeBits(COEFFICIENT_BITS, 0);
	}
};

const writeDisplayManagement = (writer: RpuBitWriter, options: DolbyVisionRpuOptions) => {
	writer.writeUe(0); // affected_dm_metadata_id
	writer.writeUe(0); // current_dm_metadata_id
	writer.writeUe(options.sceneCut ? 1 : 0); // scene_refresh_flag

	for (const coefficient of YCC_TO_RGB_COEFFICIENTS) {
		writer.writeSignedBits(16, coefficient);
	}
	for (const offset of YCC_TO_RGB_OFFSETS) {
		writer.writeBits32(offset);
	}
	for (const coefficient of RGB_TO_LMS_COEFFICIENTS) {
		writer.writeSignedBits(16, coefficient);
	}

	writer.writeBits(16, 65535); // signal_eotf: PQ
	writer.writeBits(16, 0); // signal_eotf_param0
	writer.writeBits(16, 0); // signal_eotf_param1
	writer.writeBits32(0); // signal_eotf_param2

	writer.writeBits(5, 12); // signal_bit_depth
	writer.writeBits(2, 0); // signal_color_space
	writer.writeBits(2, 0); // signal_chroma_format
	writer.writeBits(2, 1); // signal_full_range_flag

	const derived = sourcePqFromLevel6(options.level6 ?? DEFAULT_LEVEL_6);
	writer.writeBits(12, options.sourceMinPq ?? derived.sourceMinPq);
	writer.writeBits(12, options.sourceMaxPq ?? derived.sourceMaxPq);
	writer.writeBits(10, 42); // source_diagonal: a 42-inch display, which is the default

	const blocks = blocksOf(options);
	writer.writeUe(blocks.length);
	writer.byteAlign(); // dm_alignment_zero_bit

	for (const block of blocks) {
		writer.writeUe(block.lengthBytes);
		writer.writeBits(8, block.level);

		const before = writer.bitsWritten;
		block.write(writer);
		// ext_dm_alignment_zero_bit: a block is padded out to the length its container stated, so a
		// reader that knows nothing of its level can still skip it
		writer.pad(8 * block.lengthBytes - (writer.bitsWritten - before));
	}
};

/**
 * Builds a Dolby Vision profile 8.1 RPU as a complete HEVC NAL unit, ready for
 * {@link VideoSampleInit.dolbyVisionRpu} or {@link EncodedVideoPacketSource}.
 *
 * Profile 8.1 is Dolby Vision metadata on top of an HDR10 (BT.2020 PQ, 10-bit) base layer, with no
 * enhancement layer and an identity mapping — the pictures are the HDR10 pictures, and the RPU only
 * says how to present them. So an HDR10 encode can be given Dolby Vision without re-encoding, which is
 * what this is for.
 *
 * One RPU describes one frame. {@link DolbyVisionRpuOptions.level1} is the per-frame part and should
 * be measured from the frame; everything else is usually constant for a shot or for the whole file.
 *
 * @group Codecs
 * @public
 */
export const buildDolbyVisionProfile81Rpu = (options: DolbyVisionRpuOptions = {}): Uint8Array => {
	validateRpuOptions(options);

	const writer = new RpuBitWriter();
	writer.writeBits(8, DOLBY_VISION_RPU_NAL_PREFIX);
	writeHeader(writer);
	writeMapping(writer);
	writeDisplayManagement(writer, options);
	writer.byteAlign();

	const body = writer.finish();

	// The checksum covers everything after the prefix octet, and is followed by a fixed trailing octet
	const payload = new Uint8Array(body.length + 5);
	payload.set(body, 0);

	const crc = crc32Mpeg2(body.subarray(1));
	payload[body.length] = (crc >>> 24) & 0xff;
	payload[body.length + 1] = (crc >>> 16) & 0xff;
	payload[body.length + 2] = (crc >>> 8) & 0xff;
	payload[body.length + 3] = crc & 0xff;
	payload[body.length + 4] = 0x80;

	const escaped = addEmulationPrevention(payload);

	const nalUnit = new Uint8Array(2 + escaped.length);
	nalUnit[0] = HEVC_DOVI_RPU_NAL_TYPE << 1;
	nalUnit[1] = 1;
	nalUnit.set(escaped, 2);

	return nalUnit;
};

const checkInteger = (value: number, bits: number, name: string) => {
	if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
		throw new TypeError(`${name} must be an integer in [0, ${2 ** bits - 1}]; got ${value}.`);
	}
};

const validateRpuOptions = (options: DolbyVisionRpuOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('Dolby Vision RPU options must be an object.');
	}

	if (options.level1) {
		for (const field of ['minPq', 'maxPq', 'avgPq'] as const) {
			checkInteger(options.level1[field], 12, `level1.${field}`);
		}

		if (options.level1.minPq > options.level1.maxPq) {
			throw new TypeError('level1.minPq cannot exceed level1.maxPq; they bound the same frame.');
		}
	}

	if (options.level5) {
		for (const field of ['left', 'right', 'top', 'bottom'] as const) {
			checkInteger(options.level5[field], 13, `level5.${field}`);
		}
	}

	if (options.level6) {
		for (
			const field of [
				'maxDisplayMasteringLuminance',
				'minDisplayMasteringLuminance',
				'maxContentLightLevel',
				'maxFrameAverageLightLevel',
			] as const
		) {
			checkInteger(options.level6[field], 16, `level6.${field}`);
		}
	}

	for (const field of ['sourceMinPq', 'sourceMaxPq'] as const) {
		if (options[field] !== undefined) {
			checkInteger(options[field], 12, field);
		}
	}
};
