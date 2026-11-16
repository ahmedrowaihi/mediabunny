/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Essence sits in body partitions as a run of KLV elements, and the only thing saying which track an
// element belongs to is the last four bytes of its key: the TrackNumber the metadata gave that track.
//
// Two wrappings, and they want opposite things from a reader. Frame wrapping gives each edit unit its
// own element, so the elements of the tracks interleave and a reader walking forward gets them in the
// order a player wants. Clip wrapping gives a whole track one element spanning the file, so the
// elements do not interleave at all and every edit unit inside one has to be found by arithmetic or by
// the index - there is no per-frame structure in the bytes to walk.
//
// Which one a file uses is stated by the essence container label, byte 14: 0x01 frame, 0x02 clip.

import type { FileSlice } from '../reader';
import { essenceTrackNumber, readKlvHeader, partitionKind } from './mxf-klv';

export type MxfEssenceElement = {
	trackNumber: number;
	/**
	 * Byte offset of the element's key. An index states its offsets from here, not from the value: an
	 * edit unit is the whole KLV triplet.
	 */
	keyStart: number;
	/** Byte offset of the element's value, which is the essence itself. */
	start: number;
	length: number;
};

/** How a track's essence is laid out in the container. */
export type MxfWrapping = 'frame' | 'clip';

/**
 * Which wrapping a track uses, from the shape of its own essence.
 *
 * Deliberately not read from the essence container label. The label does state it, but where it
 * states it differs per mapping - byte 15 for the MPEG and AVC mappings, byte 14 for VC-3, JPEG 2000
 * and ProRes - so reading it means a table of mappings, which is wrong for every mapping not in the
 * table. The count is the same fact without the table: frame wrapping writes one element per edit
 * unit, clip wrapping writes one element for the whole track.
 */
export const wrappingOf = (elementCount: number, editUnitCount: number | null): MxfWrapping => {
	// A single element covering a track that runs for more than one edit unit can only be clip wrapped.
	// A track that is one edit unit long is both at once, and frame is the answer that then reads it
	// correctly either way.
	if (elementCount === 1 && editUnitCount !== null && editUnitCount > 1) {
		return 'clip';
	}

	return 'frame';
};

/**
 * Walks the essence elements from `slice` until the next partition pack, handing each to `onElement`.
 *
 * Stopping at the partition rather than at the end of the slice is what keeps a body partition's walk
 * from running into the footer's index and reading it as essence.
 *
 * @internal
 */
export const walkEssenceElements = (
	slice: FileSlice,
	onElement: (element: MxfEssenceElement) => boolean | void,
) => {
	for (;;) {
		const header = readKlvHeader(slice);
		if (!header || partitionKind(header.key) !== null) {
			break;
		}

		const trackNumber = essenceTrackNumber(header.key);
		if (trackNumber === null) {
			// Fill, an index segment, metadata repeated in a body partition - anything but essence
			slice.skip(header.length);
			continue;
		}

		const stop = onElement({
			trackNumber,
			keyStart: header.start,
			start: header.valueStart,
			length: header.length,
		});
		slice.skip(header.length);
		if (stop === true) {
			break;
		}
	}
};

/**
 * Where one edit unit of a clip-wrapped track lives inside its single element.
 *
 * Clip wrapping has no per-frame structure in the bytes, so this is the index's arithmetic and
 * nothing else: without a constant size or an index entry there is no way to find edit unit n short of
 * decoding everything before it.
 *
 * @internal
 */
export const clipWrappedRange = (
	element: MxfEssenceElement,
	streamOffset: number,
	size: number | null,
): { start: number; length: number } | null => {
	if (streamOffset < 0 || streamOffset >= element.length) {
		return null;
	}

	const available = element.length - streamOffset;
	return {
		start: element.start + streamOffset,
		length: size === null ? available : Math.min(size, available),
	};
};
