/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	addEmulationPreventionBytes,
	AvcNalUnitType,
	concatAvcNalUnits,
	concatHevcNalUnits,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateAvcNalUnits,
	iterateHevcNalUnits,
	type NalUnitLocation,
	removeEmulationPreventionBytes,
} from './codec-data';

/**
 * The codecs whose access units can carry SEI messages. H.264 and H.265 number and lay out the messages
 * identically; only the NAL unit framing them and the numbering that says where the slices begin differ.
 *
 * @internal
 */
export type SeiCodec = 'avc' | 'hevc';

/** One `sei_message()`: its `payloadType` and the payload bytes, with emulation prevention removed. @internal */
export type SeiMessage = {
	payloadType: number;
	payload: Uint8Array;
};

type SeiFraming = {
	nalHeader: number[];
	isSeiNalUnit: (firstByte: number) => boolean;
	isVcl: (firstByte: number) => boolean;
	iterateNalUnits: (packetData: Uint8Array, decoderConfig: VideoDecoderConfig) => Iterable<NalUnitLocation>;
	concatNalUnits: (nalUnits: Uint8Array[], decoderConfig: VideoDecoderConfig) => Uint8Array;
};

/** @internal */
export const SEI_FRAMINGS: Record<SeiCodec, SeiFraming> = {
	avc: {
		// forbidden_zero_bit = 0, nal_ref_idc = 0 (an SEI is never a reference picture), nal_unit_type = 6
		nalHeader: [AvcNalUnitType.SEI],
		isSeiNalUnit: firstByte => extractNalUnitTypeForAvc(firstByte) === AvcNalUnitType.SEI,
		// AVC VCL NAL unit types are 1..5; the parameter sets, AUD and SEI that may precede them are all above.
		isVcl: (firstByte) => {
			const type = extractNalUnitTypeForAvc(firstByte);
			return type >= AvcNalUnitType.NON_IDR_SLICE && type <= AvcNalUnitType.IDR;
		},
		iterateNalUnits: iterateAvcNalUnits,
		concatNalUnits: concatAvcNalUnits,
	},
	hevc: {
		// nuh_layer_id = 0, nuh_temporal_id_plus1 = 1
		nalHeader: [HevcNalUnitType.PREFIX_SEI_NUT << 1, 1],
		isSeiNalUnit: (firstByte) => {
			const type = extractNalUnitTypeForHevc(firstByte);
			return type === HevcNalUnitType.PREFIX_SEI_NUT || type === HevcNalUnitType.SUFFIX_SEI_NUT;
		},
		// HEVC VCL NAL unit types are 0..31; everything at or above VPS_NUT precedes them in an access unit.
		isVcl: firstByte => extractNalUnitTypeForHevc(firstByte) < HevcNalUnitType.VPS_NUT,
		iterateNalUnits: iterateHevcNalUnits,
		concatNalUnits: concatHevcNalUnits,
	},
};

/**
 * Walk the `sei_rbsp()` of one SEI NAL unit (including its NAL header), yielding each message it states.
 *
 * @internal
 */
export const iterateSeiMessages = function* (seiNalUnit: Uint8Array, codec: SeiCodec): Generator<SeiMessage> {
	const rbsp = removeEmulationPreventionBytes(seiNalUnit.subarray(SEI_FRAMINGS[codec].nalHeader.length));
	let pos = 0;

	while (pos < rbsp.length && rbsp[pos] !== 0x80) { // 0x80 = rbsp_trailing_bits
		let payloadType = 0;
		while (rbsp[pos] === 0xff) {
			payloadType += 255;
			pos++;
		}
		payloadType += rbsp[pos++]!;

		let payloadSize = 0;
		while (rbsp[pos] === 0xff) {
			payloadSize += 255;
			pos++;
		}
		payloadSize += rbsp[pos++]!;

		yield { payloadType, payload: rbsp.subarray(pos, pos + payloadSize) };
		pos += payloadSize;
	}
};

/**
 * Walk the SEI NAL units of one access unit, each including its NAL header. The decoder config is only read
 * for its `description`, which says whether the NAL units are length-prefixed or Annex B.
 *
 * @internal
 */
export const iterateSeiNalUnits = function* (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): Generator<Uint8Array> {
	const framing = SEI_FRAMINGS[codec];

	for (const location of framing.iterateNalUnits(packetData, decoderConfig)) {
		const nalUnit = packetData.subarray(location.offset, location.offset + location.length);

		if (framing.isSeiNalUnit(nalUnit[0]!)) {
			yield nalUnit;
		}
	}
};

// sei_message(): payload type and size are both coded as a run of 0xff bytes plus a final byte below 255.
const appendSeiMessage = (out: number[], message: SeiMessage) => {
	for (const value of [message.payloadType, message.payload.length]) {
		let remaining = value;
		while (remaining >= 255) {
			out.push(0xff);
			remaining -= 255;
		}
		out.push(remaining);
	}
	out.push(...message.payload);
};

/**
 * Build one SEI NAL unit (including its NAL header, emulation-prevented) carrying the given messages, or
 * `null` when there are none to carry.
 *
 * @internal
 */
export const buildSeiNalUnit = (messages: SeiMessage[], codec: SeiCodec): Uint8Array | null => {
	if (messages.length === 0) {
		return null;
	}

	const rbsp: number[] = [];
	for (const message of messages) {
		appendSeiMessage(rbsp, message);
	}

	rbsp.push(0x80); // rbsp_trailing_bits

	// Only the payload is escaped; the NAL header holds no zero byte, so no start-code pattern can straddle it.
	const framing = SEI_FRAMINGS[codec];
	const escaped = addEmulationPreventionBytes(new Uint8Array(rbsp));
	const nalUnit = new Uint8Array(framing.nalHeader.length + escaped.length);
	nalUnit.set(framing.nalHeader, 0);
	nalUnit.set(escaped, framing.nalHeader.length);

	return nalUnit;
};

/**
 * Splice an SEI NAL unit into one access unit, ahead of its first VCL NAL unit so that it follows any
 * in-band parameter sets. Every other NAL unit is copied verbatim, in the framing it came in.
 *
 * @internal
 */
export const spliceSeiNalUnit = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
	seiNalUnit: Uint8Array,
): Uint8Array => {
	const framing = SEI_FRAMINGS[codec];
	const nalUnits: Uint8Array[] = [];
	let firstVclIndex = -1;

	for (const location of framing.iterateNalUnits(packetData, decoderConfig)) {
		const nalUnit = packetData.subarray(location.offset, location.offset + location.length);

		if (firstVclIndex === -1 && framing.isVcl(nalUnit[0]!)) {
			firstVclIndex = nalUnits.length;
		}

		nalUnits.push(nalUnit);
	}

	if (firstVclIndex === -1) {
		throw new Error(`Expected a VCL NAL unit in the ${codec.toUpperCase()} access unit, found none.`);
	}

	nalUnits.splice(firstVclIndex, 0, seiNalUnit);

	return framing.concatNalUnits(nalUnits, decoderConfig);
};
