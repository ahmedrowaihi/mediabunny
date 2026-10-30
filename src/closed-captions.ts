/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { iterateSeiMessages, iterateSeiNalUnits, type SeiCodec, type SeiMessage } from './sei';

/**
 * A CEA-608 caption channel, spelled the way HLS spells it in `INSTREAM-ID` and DASH in the value of its
 * CEA-608 `Accessibility` descriptor.
 *
 * @group Codecs
 * @public
 */
export type ClosedCaptionChannel = 'CC1' | 'CC2' | 'CC3' | 'CC4';

/** @internal */
export const CLOSED_CAPTION_CHANNELS: readonly ClosedCaptionChannel[] = ['CC1', 'CC2', 'CC3', 'CC4'];

/**
 * One `cc_data` entry of an ATSC A/53 caption packet: the two caption bytes for one field of one frame.
 * A frame of NTSC-rate video carries one entry per field; higher frame rates carry the same bytes at the
 * same wall-clock rate, so a caption packet may hold several.
 *
 * @group Codecs
 * @public
 */
export type ClosedCaptionBytePair = {
	/**
	 * `cc_type`: `0` and `1` are CEA-608 field 1 and field 2, `2` and `3` are CEA-708 DTVCC packet data.
	 */
	type: 0 | 1 | 2 | 3;
	/** `cc_data_1`, the first of the two caption bytes, odd parity bit included. An integer from 0 to 255. */
	byte0: number;
	/** `cc_data_2`, the second of the two caption bytes, odd parity bit included. An integer from 0 to 255. */
	byte1: number;
};

/**
 * Declares that a video track's packets carry closed captions inside their video bitstream, and says whether
 * the manifests announce them.
 *
 * Captions are not a track of their own: they ride in the AVC or HEVC bitstream as ATSC A/53 SEI messages.
 * See {@link VideoTrackMetadata.closedCaptions} for where the bytes come from and what declaring does.
 *
 * @group Codecs
 * @public
 */
export type ClosedCaptionsMetadata = {
	/**
	 * The CEA-608 channels the track's caption bytes drive, announced as HLS `INSTREAM-ID` values and in the
	 * value of the DASH CEA-608 `Accessibility` descriptor. Must hold at least one channel and no duplicates.
	 */
	channels: ClosedCaptionChannel[];
	/**
	 * Whether the HLS master playlist and the DASH MPD announce the captions. When `false`, the caption bytes
	 * are still written into the bitstream and no manifest mentions them, so only a player that looks into the
	 * bitstream of its own accord will find them.
	 */
	announceInManifest: boolean;
};

// ATSC A/53 Part 4 §6.2.3 carries cc_data in SEI payload type 4, user_data_registered_itu_t_t35:
// country code 0xB5 (USA), provider code 0x0031 (ATSC), user_identifier 'GA94', user_data_type_code 0x03.
const USER_DATA_REGISTERED_ITU_T_T35 = 4;
const ATSC_CC_DATA_HEADER = [0xb5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34, 0x03];

/** @internal */
export const MAX_CLOSED_CAPTION_BYTE_PAIRS = 31;

/** @internal */
export const buildClosedCaptionSeiMessage = (bytePairs: readonly ClosedCaptionBytePair[]): SeiMessage => {
	const payload = new Uint8Array(ATSC_CC_DATA_HEADER.length + 2 + bytePairs.length * 3 + 1);
	payload.set(ATSC_CC_DATA_HEADER, 0);

	let pos = ATSC_CC_DATA_HEADER.length;
	// process_em_data_flag = 1, process_cc_data_flag = 1, additional_data_flag = 0, then cc_count.
	payload[pos++] = 0xc0 | bytePairs.length;
	payload[pos++] = 0xff; // em_data, which no decoder reads while additional_data_flag is 0

	for (const bytePair of bytePairs) {
		// Five marker bits, then cc_valid = 1 (a pair the caller states is a pair it wants seen), then cc_type.
		payload[pos++] = 0xfc | bytePair.type;
		payload[pos++] = bytePair.byte0;
		payload[pos++] = bytePair.byte1;
	}

	payload[pos] = 0xff; // marker_bits

	return { payloadType: USER_DATA_REGISTERED_ITU_T_T35, payload };
};

/**
 * Reads `cc_data` triplets — one marker-and-type byte then the two caption bytes — into byte pairs,
 * dropping the entries the marker says carry nothing. This is the inverse of
 * {@link buildClosedCaptionSeiMessage}'s payload, and the shape FFmpeg's A/53 frame side data holds.
 *
 * @internal
 */
export const parseClosedCaptionBytePairs = (ccData: Uint8Array): ClosedCaptionBytePair[] | null => {
	const bytePairs: ClosedCaptionBytePair[] = [];

	for (let i = 0; i + 2 < ccData.length; i += 3) {
		const header = ccData[i]!;
		if ((header & 0b100) === 0) { // cc_valid
			continue;
		}

		bytePairs.push({
			type: (header & 0b11) as ClosedCaptionBytePair['type'],
			byte0: ccData[i + 1]!,
			byte1: ccData[i + 2]!,
		});
	}

	// Null rather than a throw: one odd frame must not end a decode
	if (bytePairs.length === 0 || bytePairs.length > MAX_CLOSED_CAPTION_BYTE_PAIRS) {
		return null;
	}

	return bytePairs;
};

const isAtscCcData = (payload: Uint8Array): boolean =>
	payload.length >= ATSC_CC_DATA_HEADER.length
	&& ATSC_CC_DATA_HEADER.every((byte, i) => payload[i] === byte);

/** @internal */
export const carriesClosedCaptions = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): boolean => {
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, codec)) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, codec)) {
			if (payloadType === USER_DATA_REGISTERED_ITU_T_T35 && isAtscCcData(payload)) {
				return true;
			}
		}
	}

	return false;
};

/**
 * Read the CEA-608/708 caption byte pairs an encoded video packet carries in its ATSC A/53 SEI messages, or
 * `null` when it carries none. `decoderConfig` states the size of the bitstream's NAL length prefixes; data in
 * Annex B form is walked by start code instead.
 *
 * This is the read side of {@link VideoTrackMetadata.closedCaptions}: what it returns of a packet this library
 * wrote is the byte pairs that were declared for it.
 *
 * @group Codecs
 * @public
 */
export const parsePacketClosedCaptions = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): ClosedCaptionBytePair[] | null => {
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, codec)) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, codec)) {
			if (payloadType !== USER_DATA_REGISTERED_ITU_T_T35 || !isAtscCcData(payload)) {
				continue;
			}

			const flagsAndCount = payload[ATSC_CC_DATA_HEADER.length] ?? 0;
			// process_cc_data_flag: a decoder ignores the cc_data when it is clear, so this reader does too
			if ((flagsAndCount & 0x40) === 0) {
				continue;
			}

			// cc_count triplets, after the em_data byte
			const start = ATSC_CC_DATA_HEADER.length + 2;
			const bytePairs = parseClosedCaptionBytePairs(
				payload.subarray(start, start + (flagsAndCount & 0x1f) * 3),
			);
			if (bytePairs) {
				return bytePairs;
			}
		}
	}

	return null;
};

/** @internal */
export const validateClosedCaptionsMetadata = (metadata: ClosedCaptionsMetadata, prefix: string) => {
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError(`${prefix} must be an object.`);
	}
	if (typeof metadata.announceInManifest !== 'boolean') {
		throw new TypeError(`${prefix}.announceInManifest must be a boolean.`);
	}
	if (!Array.isArray(metadata.channels) || metadata.channels.length === 0) {
		throw new TypeError(`${prefix}.channels must be a non-empty array of CEA-608 channels.`);
	}
	for (const channel of metadata.channels) {
		if (!CLOSED_CAPTION_CHANNELS.includes(channel)) {
			throw new TypeError(
				`Invalid CEA-608 channel in ${prefix}.channels: ${String(channel)}.`
				+ ` Must be one of ${CLOSED_CAPTION_CHANNELS.join(', ')}.`,
			);
		}
	}
	if (new Set(metadata.channels).size !== metadata.channels.length) {
		throw new TypeError(`${prefix}.channels must not repeat a channel.`);
	}
};

/** @internal */
export const validateClosedCaptionBytePairs = (bytePairs: readonly ClosedCaptionBytePair[], prefix: string) => {
	// Array.isArray narrows a readonly array to any[], which would untype every check below it
	const value: unknown = bytePairs;
	if (!Array.isArray(value) || bytePairs.length === 0) {
		throw new TypeError(`${prefix} must be a non-empty array of caption byte pairs.`);
	}
	if (bytePairs.length > MAX_CLOSED_CAPTION_BYTE_PAIRS) {
		throw new TypeError(
			`${prefix} holds ${bytePairs.length} byte pairs, but an ATSC A/53 caption packet can state at most`
			+ ` ${MAX_CLOSED_CAPTION_BYTE_PAIRS}.`,
		);
	}
	for (const bytePair of bytePairs) {
		if (!bytePair || typeof bytePair !== 'object') {
			throw new TypeError(`${prefix} must only hold objects.`);
		}
		if (![0, 1, 2, 3].includes(bytePair.type)) {
			throw new TypeError(
				`Invalid caption cc_type in ${prefix}: ${String(bytePair.type)}. Must be 0, 1, 2 or 3.`,
			);
		}
		for (const key of ['byte0', 'byte1'] as const) {
			const byte = bytePair[key];
			if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
				throw new TypeError(
					`Invalid caption ${key} in ${prefix}: ${String(byte)}. Must be an integer from 0 to 255.`,
				);
			}
		}
	}
};
