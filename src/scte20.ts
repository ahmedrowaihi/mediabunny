/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SCTE-20 closed captions, carried in an MPEG-2 picture's `user_data` rather than in an SEI message:
// MPEG-2 has no SEI, so this is where captions go in an MPEG-2 programme.
//
// Two things here are not guessable and are taken from ffmpeg's `mpeg12dec.c`, which is what will read
// these back. The caption bytes are stored **bit-reversed** relative to the A/53 ordering every other
// carriage uses (`cap[1] = ff_reverse[cc1]`), so a writer that copies them across produces captions that
// decode to nothing recognisable. And the field is numbered 1 and 2 with 0 forbidden, where A/53's
// `cc_type` numbers the same two fields 0 and 1.

import { Bitstream } from '../shared/bitstream';
import type { ClosedCaptionBytePair } from './closed-captions';

/** `user_data_start_code`, which introduces a `user_data` element in an MPEG-2 picture. */
export const MPEG2_USER_DATA_START_CODE = 0xb2;

/**
 * SCTE-20 §8.2.1 marks its payload with these two octets. ffmpeg matches on
 * `p[0] == 0x03 && (p[1] & 0x7f) == 0x01`, so the high bit of the second is not part of the
 * identification; it is written clear.
 */
const SCTE20_HEADER = [0x03, 0x01];

/**
 * Reads `top_field_first` out of a picture coding extension, defaulting to true where there is none.
 *
 * SCTE-20 numbers the FIELDS OF THE FRAME, 1 for the first transmitted and 2 for the second, while
 * A/53's `cc_type` numbers the two line 21 fields. The two agree only on a top-field-first picture; on
 * any other, field 1 of the frame is line 21's second field. ffmpeg's decoder flips on exactly this
 * (`if (!top_field_first) field = !field`), so a writer that ignores it puts CC1 text on CC3's field -
 * which decodes cleanly to the wrong caption channel rather than failing.
 */
const topFieldFirstOf = (pictureData: Uint8Array): boolean => {
	for (let i = 0; i + 7 < pictureData.length; i++) {
		if (
			pictureData[i] !== 0 || pictureData[i + 1] !== 0 || pictureData[i + 2] !== 1
			|| pictureData[i + 3] !== 0xb5
		) {
			continue;
		}

		// extension_start_code_identifier 8 is the picture coding extension; `top_field_first` is the
		// high bit of its fourth octet
		if ((pictureData[i + 4]! >> 4) === 8) {
			return (pictureData[i + 7]! & 0x80) !== 0;
		}
	}

	return true;
};

/** Each entry is 26 bits: priority, field, line offset, two caption octets and a marker. */
const BITS_PER_ENTRY = 26;

/** `cc_count` is five bits wide. */
export const MAX_SCTE20_BYTE_PAIRS = 31;

/**
 * Reverses the bits of an octet.
 *
 * SCTE-20 stores each caption octet with its bits the other way round from every other carriage, which
 * is what ffmpeg's `ff_reverse` lookup undoes when it reads one. Nothing about the surrounding syntax
 * hints at it, and captions written without it decode to arbitrary characters rather than to nothing -
 * so it fails silently in the worst way.
 */
const reverseBits = (byte: number) => {
	let out = 0;
	for (let i = 0; i < 8; i++) {
		out = (out << 1) | ((byte >> i) & 1);
	}

	return out;
};

/**
 * Builds the `user_data` payload stating these caption byte pairs, without its start code.
 *
 * @internal
 */
export const buildScte20UserData = (
	bytePairs: readonly ClosedCaptionBytePair[],
	topFieldFirst: boolean,
): Uint8Array => {
	if (bytePairs.length > MAX_SCTE20_BYTE_PAIRS) {
		throw new Error(
			`SCTE-20 states cc_count in five bits, so a picture carries at most ${MAX_SCTE20_BYTE_PAIRS}`
			+ ` caption byte pairs; ${bytePairs.length} were given.`,
		);
	}

	const bits = 5 + bytePairs.length * BITS_PER_ENTRY;
	const payload = new Uint8Array(SCTE20_HEADER.length + Math.ceil(bits / 8));
	payload.set(SCTE20_HEADER, 0);

	const bitstream = new Bitstream(payload.subarray(SCTE20_HEADER.length));
	bitstream.writeBits(5, bytePairs.length); // cc_count

	for (const pair of bytePairs) {
		if (pair.type > 1) {
			// SCTE-20 numbers one of two line-21 fields, so there is no room for DTVCC packet data; A/53
			// in an SEI message is where CEA-708 goes
			throw new Error(
				`SCTE-20 carries the two CEA-608 line 21 fields and nothing else, so a byte pair of type`
				+ ` ${pair.type} (CEA-708 DTVCC packet data) cannot be written into it.`,
			);
		}

		bitstream.writeBits(2, 0); // cc_priority
		// A/53 numbers the line 21 fields 0 and 1; SCTE-20 numbers the frame's fields 1 and 2, with 0
		// forbidden - and the two only line up on a top-field-first picture
		const lineTwentyOneField = pair.type === 0 ? 0 : 1;
		const frameField = topFieldFirst ? lineTwentyOneField : 1 - lineTwentyOneField;
		bitstream.writeBits(2, frameField + 1); // field_number
		// Line 21 is where line 21 captions live, counted from the field's own start
		bitstream.writeBits(5, 21 - 10); // line_offset
		bitstream.writeBits(8, reverseBits(pair.byte0));
		bitstream.writeBits(8, reverseBits(pair.byte1));
		bitstream.writeBits(1, 1); // marker_bits
	}

	return payload;
};

/**
 * Reads the caption byte pairs an SCTE-20 `user_data` payload states, or null when it is not one.
 *
 * @internal
 */
export const parseScte20UserData = (
	payload: Uint8Array,
	topFieldFirst = true,
): ClosedCaptionBytePair[] | null => {
	if (
		payload.length < SCTE20_HEADER.length + 1
		|| payload[0] !== SCTE20_HEADER[0]
		|| (payload[1]! & 0x7f) !== SCTE20_HEADER[1]
	) {
		return null;
	}

	const bitstream = new Bitstream(payload.subarray(SCTE20_HEADER.length));
	const count = bitstream.readBits(5);
	const available = 8 * (payload.length - SCTE20_HEADER.length) - 5;
	if (count === 0 || available < count * BITS_PER_ENTRY) {
		return null;
	}

	const bytePairs: ClosedCaptionBytePair[] = [];
	for (let i = 0; i < count; i++) {
		bitstream.skipBits(2); // cc_priority
		const field = bitstream.readBits(2);
		bitstream.skipBits(5); // line_offset
		const byte0 = reverseBits(bitstream.readBits(8));
		const byte1 = reverseBits(bitstream.readBits(8));
		bitstream.skipBits(1); // marker_bits

		if (field === 0) {
			continue; // Forbidden, and ffmpeg zeroes the triplet rather than reading it
		}

		const frameField = field === 1 ? 0 : 1;
		const lineTwentyOneField = topFieldFirst ? frameField : 1 - frameField;
		bytePairs.push({ type: lineTwentyOneField === 0 ? 0 : 1, byte0, byte1 });
	}

	return bytePairs.length > 0 ? bytePairs : null;
};

/**
 * Splices a `user_data` element carrying these captions into an MPEG-2 picture.
 *
 * It goes after the picture header and any picture coding extension, which is where a decoder looks
 * for picture-level user data and where every encoder that writes captions puts them. A picture that
 * already carries SCTE-20 user data keeps it.
 *
 * @internal
 */
export const spliceScte20UserData = (
	pictureData: Uint8Array,
	bytePairs: readonly ClosedCaptionBytePair[],
): Uint8Array => {
	const payload = buildScte20UserData(bytePairs, topFieldFirstOf(pictureData));
	let insertAt = -1;

	// Walk the start codes: picture_start_code is 0x00, extensions are 0xb5, user data is 0xb2. The
	// insertion point is after the last extension that follows the picture header.
	for (let i = 0; i + 3 < pictureData.length; i++) {
		if (pictureData[i] !== 0 || pictureData[i + 1] !== 0 || pictureData[i + 2] !== 1) {
			continue;
		}

		const code = pictureData[i + 3]!;
		if (code === 0x00) { // picture_start_code
			insertAt = -2; // Found the picture; take the position after it or after its extensions
		} else if (insertAt === -2 && code === 0xb5) { // extension_start_code
			continue;
		} else if (insertAt === -2) {
			insertAt = i;
			break;
		}
	}

	if (insertAt < 0) {
		throw new Error(
			'No MPEG-2 picture header was found in this packet, so there is nowhere to put the caption'
			+ ' user data. Captions can only be written onto a picture.',
		);
	}

	const out = new Uint8Array(pictureData.length + 4 + payload.length);
	out.set(pictureData.subarray(0, insertAt), 0);
	out.set([0, 0, 1, MPEG2_USER_DATA_START_CODE], insertAt);
	out.set(payload, insertAt + 4);
	out.set(pictureData.subarray(insertAt), insertAt + 4 + payload.length);

	return out;
};

/**
 * Whether an MPEG-2 picture already carries SCTE-20 captions.
 *
 * @internal
 */
export const carriesScte20Captions = (pictureData: Uint8Array): boolean => {
	for (let i = 0; i + 3 < pictureData.length; i++) {
		if (
			pictureData[i] === 0 && pictureData[i + 1] === 0 && pictureData[i + 2] === 1
			&& pictureData[i + 3] === MPEG2_USER_DATA_START_CODE
			&& parseScte20UserData(pictureData.subarray(i + 4)) !== null
		) {
			return true;
		}
	}

	return false;
};
