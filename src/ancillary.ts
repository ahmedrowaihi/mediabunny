/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SMPTE ST 436M ancillary data, which is how an MXF broadcast master carries VANC beside its picture:
// captions, AFD, timecode. Three layers nest here, and the captions are at the bottom of all three —
// a 436M frame holds ANC packets, a caption packet holds a SMPTE ST 334-2 CDP, and the CDP's `ccdata`
// section holds the same triplets every other caption carriage uses.
//
// The field widths below were read out of a file whose caption content was known rather than from the
// standards, which are not public: ffmpeg writes a 436M track when it muxes MXF, and decoding a frame
// whose captions were already known made each field unambiguous.

import type { ClosedCaptionBytePair } from './closed-captions';

/**
 * One ancillary data packet, as ST 436M wraps it.
 *
 * @group Codecs
 * @public
 */
export type AncillaryPacket = {
	/** The video line this packet was carried on. */
	lineNumber: number;
	/** `wrapping_type`: which field, or a whole frame, and VANC or HANC. */
	wrappingType: number;
	/** Data identifier. `0x61` is the one that carries captions. */
	did: number;
	/** Secondary data identifier. `0x01` beside DID `0x61` is CEA-708 in a CDP. */
	sdid: number;
	/** The packet's user data words, without the DID, SDID, count or checksum around them. */
	payload: Uint8Array;
};

/**
 * One edit unit of an ancillary data track, as {@link Input.getAncillaryFrames} returns it.
 *
 * @group Codecs
 * @public
 */
export type AncillaryFrame = {
	/** The id of the track this frame came from, matching the ids `Input.getTracks` gives. */
	trackId: number;
	/** In seconds. */
	timestamp: number;
	/** In seconds. */
	duration: number;
	/** The frame, ready for {@link ancillaryPacketsOf} or {@link ancillaryCaptionsOf}. */
	data: Uint8Array;
};

/** ST 334-1: DID 0x61 with SDID 0x01 is a caption distribution packet. */
const CAPTION_DID = 0x61;
const CAPTION_SDID = 0x01;

/** ST 334-2: every CDP opens with this. */
const CDP_IDENTIFIER = 0x9669;

/** Section tags inside a CDP. */
const CDP_CCDATA_SECTION = 0x72;

/**
 * Reads the ancillary packets of one ST 436M frame — the payload of a single edit unit of an ancillary
 * data track.
 *
 * Returns an empty array for data that is not a 436M frame, rather than throwing, so a caller can hand
 * it whatever a data track gave them.
 *
 * @group Codecs
 * @public
 */
export const ancillaryPacketsOf = (frame: Uint8Array): AncillaryPacket[] => {
	if (frame.length < 2) {
		return [];
	}

	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const count = view.getUint16(0);
	const packets: AncillaryPacket[] = [];
	let pos = 2;

	for (let i = 0; i < count; i++) {
		// line number, wrapping type, sample coding, sample count, then the array's length and the
		// size of one element
		if (pos + 14 > frame.length) {
			break;
		}

		const lineNumber = view.getUint16(pos);
		const wrappingType = frame[pos + 2]!;
		const arrayLength = view.getUint32(pos + 6);
		const elementSize = view.getUint32(pos + 10);
		pos += 14;

		const payloadLength = arrayLength * elementSize;
		if (payloadLength < 3 || pos + payloadLength > frame.length) {
			break;
		}

		const did = frame[pos]!;
		const sdid = frame[pos + 1]!;
		const dataCount = frame[pos + 2]!;
		// The user data words sit between the count and the checksum; a count longer than the array
		// states is a malformed packet rather than a reason to read past it
		const available = Math.max(0, Math.min(dataCount, payloadLength - 3));

		packets.push({
			lineNumber,
			wrappingType,
			did,
			sdid,
			payload: frame.subarray(pos + 3, pos + 3 + available),
		});

		// ST 436M pads each payload array to an even length
		pos += payloadLength + (payloadLength & 1);
	}

	return packets;
};

/**
 * Reads the CEA-608 byte pairs a ST 334-2 caption distribution packet states.
 *
 * @internal
 */
export const captionsFromCdp = (cdp: Uint8Array): ClosedCaptionBytePair[] => {
	if (cdp.length < 7 || ((cdp[0]! << 8) | cdp[1]!) !== CDP_IDENTIFIER) {
		return [];
	}

	// cdp_identifier(2), cdp_length(1), frame rate and reserved(1), flags(1), sequence counter(2)
	let pos = 7;
	const bytePairs: ClosedCaptionBytePair[] = [];

	while (pos < cdp.length) {
		const section = cdp[pos]!;
		pos++;

		if (section !== CDP_CCDATA_SECTION) {
			// Any other section - time code, service info, the footer - ends the walk: their lengths are
			// implied by their own contents, and nothing here needs them
			break;
		}

		if (pos >= cdp.length) {
			break;
		}

		// Three marker bits then cc_count
		const ccCount = cdp[pos]! & 0x1f;
		pos++;

		for (let i = 0; i < ccCount && pos + 2 < cdp.length; i++) {
			const flags = cdp[pos]!;
			const byte0 = cdp[pos + 1]!;
			const byte1 = cdp[pos + 2]!;
			pos += 3;

			// cc_valid is bit 2; the type is the low two bits, numbered as A/53 numbers them
			if ((flags & 0x04) !== 0) {
				bytePairs.push({ type: (flags & 0x03) as 0 | 1 | 2 | 3, byte0, byte1 });
			}
		}

		break;
	}

	return bytePairs;
};

/**
 * Reads the closed caption byte pairs an ST 436M ancillary frame carries, or an empty array when it
 * carries none.
 *
 * This is the ancillary counterpart of {@link parsePacketClosedCaptions}: where an AVC or HEVC stream
 * states its captions in an SEI message, an MXF broadcast master states them in an ancillary data
 * track, and this turns one of that track's frames into the same byte pairs.
 *
 * @group Codecs
 * @public
 */
export const ancillaryCaptionsOf = (frame: Uint8Array): ClosedCaptionBytePair[] => {
	const bytePairs: ClosedCaptionBytePair[] = [];

	for (const packet of ancillaryPacketsOf(frame)) {
		if (packet.did === CAPTION_DID && packet.sdid === CAPTION_SDID) {
			bytePairs.push(...captionsFromCdp(packet.payload));
		}
	}

	return bytePairs;
};
