/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { extractNalUnitTypeForHevc, HevcNalUnitType, removeEmulationPreventionBytes } from './codec-data';
import { createAv1FilmGrainReader } from './crypto/av1-parser';
import { Bitstream } from '../shared/bitstream';
import { readExpGolomb, toUint8Array } from './misc';
import { SEI_FRAMINGS, type SeiCodec } from './sei';

/**
 * How a coded picture's slices are coded, independent of whether the picture is a random access point.
 * An `'i'` packet whose `EncodedPacket.type` is `'delta'` is an intra-coded picture that cannot be
 * seeked to, which is what a scene-cut detector produces.
 *
 * @group Codecs
 * @public
 */
export type VideoSliceType = 'i' | 'p' | 'b';

/** The slice header carries `slice_type` within its first bytes; stripping the whole NAL unit would be wasteful. */
const SLICE_HEADER_PREFIX_SIZE = 24;

const avcSliceType = (nalUnit: Uint8Array): VideoSliceType | null => {
	const bitstream = new Bitstream(removeEmulationPreventionBytes(nalUnit.subarray(1, SLICE_HEADER_PREFIX_SIZE)));

	readExpGolomb(bitstream); // first_mb_in_slice

	// 5..9 state that every slice in the picture has that type, so they fold onto 0..4
	switch (readExpGolomb(bitstream) % 5) {
		case 0: return 'p';
		case 1: return 'b';
		case 2: return 'i';
		default: return null; // SP and SI, which only the Extended profile codes
	}
};

const hevcSliceType = (nalUnit: Uint8Array): VideoSliceType | null => {
	const nalUnitType = extractNalUnitTypeForHevc(nalUnit[0]!);
	const bitstream = new Bitstream(removeEmulationPreventionBytes(nalUnit.subarray(2, SLICE_HEADER_PREFIX_SIZE)));

	bitstream.skipBits(1); // first_slice_segment_in_pic_flag
	if (nalUnitType >= HevcNalUnitType.BLA_W_LP && nalUnitType <= HevcNalUnitType.RSV_IRAP_VCL23) {
		bitstream.skipBits(1); // no_output_of_prior_pics_flag
	}

	// A dependent slice segment states no slice_type of its own, but the first segment of a picture never is one
	readExpGolomb(bitstream); // slice_pic_parameter_set_id

	switch (readExpGolomb(bitstream)) {
		case 0: return 'b';
		case 1: return 'p';
		case 2: return 'i';
		default: return null;
	}
};

/**
 * Read how an encoded video packet's first coded slice is coded, or `null` when the bitstream states nothing
 * this library reads. Use it alongside `EncodedPacket.type`, which says whether the packet is a random
 * access point but not how it is coded: a packet that is `'i'` and `'delta'` is an intra frame that no reader
 * can seek to, and only the pair distinguishes one from a sync sample.
 *
 * `decoderConfig` states the size of the bitstream's NAL length prefixes; data in Annex B form is walked by
 * start code instead.
 *
 * @group Codecs
 * @public
 */
export const readVideoSliceType = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): VideoSliceType | null => {
	const framing = SEI_FRAMINGS[codec];

	for (const { offset, length } of framing.iterateNalUnits(packetData, decoderConfig)) {
		const firstByte = packetData[offset];
		if (firstByte === undefined || !framing.isVcl(firstByte)) {
			continue;
		}

		const nalUnit = packetData.subarray(offset, offset + length);
		try {
			return codec === 'avc' ? avcSliceType(nalUnit) : hevcSliceType(nalUnit);
		} catch {
			return null; // A truncated slice header, which readExpGolomb rejects
		}
	}

	return null;
};

/** `marker`/`version`, the two profile/level bytes and the flags byte that precede an `av1C` box's configOBUs. */
const AV1C_HEADER_SIZE = 4;

/**
 * What an AV1 bitstream states about film grain synthesis.
 *
 * @group Codecs
 * @public
 */
export type Av1FilmGrainState = {
	/**
	 * The sequence header's `film_grain_params_present`: whether the stream may carry grain parameters at all.
	 * A stream encoded without film grain synthesis states this once and never applies grain.
	 */
	filmGrainParamsPresent: boolean;
	/** The frame header's `apply_grain`: whether grain is synthesized over this particular frame. */
	applyGrain: boolean;
};

/**
 * An AV1 film-grain reader, which reads a stream's temporal units in decode order.
 *
 * @group Codecs
 * @public
 */
export type Av1FilmGrainStateReader = {
	/**
	 * Read one temporal unit's film-grain state, or `null` when the unit is malformed or states no frame
	 * header of its own. Units must be passed in decode order, starting with the first.
	 */
	read(packetData: Uint8Array): Av1FilmGrainState | null;
};

/**
 * Create a reader for what an AV1 stream states about film grain synthesis, which neither the container nor
 * the codec string carries. Pass `description` (an `av1C` box, from `getDecoderConfig().description`) so the
 * reader starts with the sequence header the stream's packets may not repeat.
 *
 * The reader is stateful because `apply_grain` sits at the end of the uncompressed frame header, past fields
 * an inter frame reads out of its reference frames' state. Pass every packet, in decode order; a reader given
 * only some of them reads the rest as malformed.
 *
 * @group Codecs
 * @public
 */
export const createAv1FilmGrainStateReader = (
	description?: AllowSharedBufferSource | null,
): Av1FilmGrainStateReader => {
	const reader = createAv1FilmGrainReader();

	if (description) {
		// The av1C box's fixed header precedes the configOBUs that carry the sequence header
		reader.read(toUint8Array(description).subarray(AV1C_HEADER_SIZE));
	}

	return { read: packetData => reader.read(packetData) };
};
