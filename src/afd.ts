/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Active Format Description: SMPTE ST 2016-1, carried in AVC and HEVC as an ATSC A/53 Part 4
// `user_data_registered_itu_t_t35` SEI message under the `DTG1` identifier.
//
// The two payload octets are not what a reading of the standard suggests at a glance, and they were
// settled by writing one and having ffmpeg read it back: the flag is in the FIRST octet and the code in
// the SECOND's low nibble, which ffmpeg's `libavcodec/itut35.c` confirms - it consumes the flag octet
// during the header walk, then takes `*payload & 0xf` from what follows.

import type { SeiCodec, SeiMessage } from './sei';
import { iterateSeiMessages, iterateSeiNalUnits, USER_DATA_REGISTERED_ITU_T_T35 } from './sei';

/**
 * An active format description: which part of the coded frame carries the picture, so a receiver whose
 * display has a different shape knows what it may crop and what it must letterbox.
 *
 * The codes are SMPTE ST 2016-1 Table 1. `0` and `1` are reserved there and `2`-`15` are the ones a
 * stream states; the names below are the table's own.
 *
 * @group Codecs
 * @public
 */
export type Afd =
	/** 16:9 letterbox image at the top of a 4:3 coded frame. */
	| 2
	/** 14:9 letterbox image at the top of a 4:3 coded frame. */
	| 3
	/** Letterbox image wider than 16:9, vertically centred. */
	| 4
	/** The coded frame is the active picture, whatever its ratio. */
	| 8
	/** 4:3 active picture, centred. */
	| 9
	/** 16:9 active picture, centred. */
	| 10
	/** 14:9 active picture, centred. */
	| 11
	/** 4:3 active picture with a 14:9 centre of interest. */
	| 13
	/** 16:9 active picture with a 14:9 centre of interest. */
	| 14
	/** 16:9 active picture with a 4:3 centre of interest. */
	| 15;

/**
 * The codes ST 2016-1 Table 1 defines; 0, 1, 5, 6, 7 and 12 are reserved.
 *
 * @group Codecs
 * @public
 */
export const AFD_CODES: readonly Afd[] = [2, 3, 4, 8, 9, 10, 11, 13, 14, 15];

/**
 * ATSC A/53 Part 4 §6.2 carries `afd_data` in `user_data_registered_itu_t_t35`: country code 0xB5
 * (USA), provider code 0x0031 (ATSC), user_identifier `DTG1`.
 */
const ATSC_AFD_HEADER = [0xb5, 0x00, 0x31, 0x44, 0x54, 0x47, 0x31];

/**
 * First payload octet: a zero bit, `active_format_flag` set, then the six reserved bits ST 2016-1
 * states as `000001`. A reader that finds the flag clear ignores the message, so it is never written
 * clear - a stream with no AFD to state carries no message at all.
 */
const ACTIVE_FORMAT_FLAG_OCTET = 0x41;

/** Second payload octet: four reserved bits set, then the code. */
const afdOctet = (afd: Afd) => 0xf0 | afd;

/**
 * Builds the SEI message stating an active format description.
 *
 * @internal
 */
export const buildAfdSeiMessage = (afd: Afd): SeiMessage => ({
	payloadType: USER_DATA_REGISTERED_ITU_T_T35,
	payload: new Uint8Array([...ATSC_AFD_HEADER, ACTIVE_FORMAT_FLAG_OCTET, afdOctet(afd)]),
});

const isAtscAfdData = (payload: Uint8Array): boolean =>
	payload.length >= ATSC_AFD_HEADER.length + 2
	&& ATSC_AFD_HEADER.every((byte, i) => payload[i] === byte);

/**
 * Reads the active format description an encoded video packet states, or `null` when it states none.
 * `decoderConfig` states the size of the bitstream's NAL length prefixes; data in Annex B form is
 * walked by start code instead.
 *
 * This is the read side of {@link VideoTrackMetadata.activeFormatDescription}.
 *
 * @group Codecs
 * @public
 */
export const parsePacketAfd = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): Afd | null => {
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, codec)) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, codec)) {
			if (payloadType !== USER_DATA_REGISTERED_ITU_T_T35 || !isAtscAfdData(payload)) {
				continue;
			}

			// A message whose flag is clear states nothing, which is not the same as there being none
			if ((payload[ATSC_AFD_HEADER.length]! & 0x40) === 0) {
				continue;
			}

			const afd = payload[ATSC_AFD_HEADER.length + 1]! & 0x0f;
			if ((AFD_CODES as readonly number[]).includes(afd)) {
				return afd as Afd;
			}
		}
	}

	return null;
};

/** @internal */
export const validateAfd = (afd: number, prefix: string) => {
	if (!(AFD_CODES as readonly number[]).includes(afd)) {
		throw new TypeError(
			`${prefix} must be one of ${AFD_CODES.join(', ')} (SMPTE ST 2016-1 Table 1); ${afd} is`
			+ ' reserved.',
		);
	}
};
