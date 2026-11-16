/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// An index table segment maps edit units to byte offsets within an essence container, and is the only
// thing that makes an MXF file seekable: the essence itself is a run of KLV items with no back
// pointers, so without an index a reader can only walk forward.
//
// Two shapes, and a file uses whichever suits its essence. Constant bit rate states one
// `EditUnitByteCount` and no entries at all - every edit unit is that many bytes, so the offset is a
// multiplication. Variable bit rate states one entry per edit unit, carrying the offset, whether the
// unit can be decoded from cold, and how far its presentation time sits from its decode order.
//
// A segment covers a range of edit units, not the whole file, and a long file has several. They are
// kept as a list and searched, rather than being flattened into one array per file, because a
// constant-bit-rate segment covering an hour would otherwise become an hour of entries.
//
// Not handled: the DeltaEntryArray, which places several essence elements inside one edit unit, and
// the slice offsets that go with it. Both only apply where a container interleaves more than one
// element per edit unit; a segment that declares them is read for its entries all the same, and the
// offsets then name the start of the edit unit rather than of an element within it.

import { MalformedInputError } from '../errors';
import type { FileSlice } from '../reader';
import { asRational, asUint, type LocalSet, readU32Be, readU8 } from './mxf-klv';

const TAG_EDIT_RATE = 0x3f0b;
const TAG_INDEX_START_POSITION = 0x3f0c;
const TAG_INDEX_DURATION = 0x3f0d;
const TAG_EDIT_UNIT_BYTE_COUNT = 0x3f05;
const TAG_INDEX_SID = 0x3f06;
const TAG_BODY_SID = 0x3f07;
const TAG_SLICE_COUNT = 0x3f08;
const TAG_POS_TABLE_COUNT = 0x3f0e;
const TAG_INDEX_ENTRY_ARRAY = 0x3f0a;

export type MxfIndexEntry = {
	/** Byte offset of this edit unit from the start of its essence container. */
	streamOffset: number;
	/**
	 * Whether this edit unit can be decoded without an earlier one.
	 *
	 * Taken from either signal the entry carries, because writers disagree about which to set: ffmpeg
	 * leaves the random-access flag clear on every entry and states it only by pointing the key frame
	 * offset at the entry itself. Reading the flag alone reports a long-GOP file as having exactly one
	 * key frame, which is the sort of wrong that still seeks - just always to the start.
	 */
	isKeyFrame: boolean;
	/**
	 * Edit units from this entry back to the one that must be decoded first. Zero for a key frame, and
	 * negative for anything that depends on an earlier unit.
	 */
	keyFrameOffset: number;
	/**
	 * Edit units between this unit's position in decode order and its position in presentation order.
	 * Non-zero only where the coding reorders, which is what turns a stored order into a timeline.
	 */
	temporalOffset: number;
};

export type MxfIndexSegment = {
	indexSid: number;
	bodySid: number;
	editRate: { num: number; den: number } | null;
	/** The first edit unit this segment covers. */
	startPosition: number;
	/** How many edit units it covers, or null where it does not say. */
	duration: number | null;
	/**
	 * Bytes per edit unit where the essence is constant bit rate, in which case there are no entries:
	 * the offset of unit n is `n * editUnitByteCount`. Zero means the entries carry the offsets.
	 */
	editUnitByteCount: number;
	entries: MxfIndexEntry[];
};

/**
 * Reads an index table segment's local set.
 *
 * @internal
 */
export const readIndexTableSegment = (set: LocalSet): MxfIndexSegment => {
	const sliceCount = asUint(set.get(TAG_SLICE_COUNT) ?? new Uint8Array([0]));
	const posTableCount = asUint(set.get(TAG_POS_TABLE_COUNT) ?? new Uint8Array([0]));

	const segment: MxfIndexSegment = {
		indexSid: asUint(set.get(TAG_INDEX_SID) ?? new Uint8Array()),
		bodySid: asUint(set.get(TAG_BODY_SID) ?? new Uint8Array()),
		editRate: set.has(TAG_EDIT_RATE) ? asRational(set.get(TAG_EDIT_RATE)!) : null,
		startPosition: asUint(set.get(TAG_INDEX_START_POSITION) ?? new Uint8Array()),
		duration: set.has(TAG_INDEX_DURATION) ? asUint(set.get(TAG_INDEX_DURATION)!) : null,
		editUnitByteCount: asUint(set.get(TAG_EDIT_UNIT_BYTE_COUNT) ?? new Uint8Array()),
		entries: [],
	};

	const array = set.get(TAG_INDEX_ENTRY_ARRAY);
	if (!array || array.byteLength < 8) {
		return segment;
	}

	const data = new DataView(array.buffer, array.byteOffset, array.byteLength);
	const count = data.getUint32(0);
	const entrySize = data.getUint32(4);
	// 11 fixed bytes, then one 32-bit offset per slice and one 8-byte rational per pos table entry
	const minimum = 11 + 4 * sliceCount + 8 * posTableCount;
	if (entrySize < minimum) {
		throw new MalformedInputError(
			`An MXF index entry states ${entrySize} bytes, too few for the ${sliceCount} slice(s) and`
			+ ` ${posTableCount} pos table entries the segment declares.`,
		);
	}

	for (let i = 0; i < count && 8 + (i + 1) * entrySize <= array.byteLength; i++) {
		const at = 8 + i * entrySize;
		const keyFrameOffset = data.getInt8(at + 1);
		segment.entries.push({
			temporalOffset: data.getInt8(at),
			keyFrameOffset,
			// Bit 7 of the flags is random access; an offset of zero says the same thing by pointing the
			// entry at itself
			isKeyFrame: keyFrameOffset === 0 || (data.getUint8(at + 2) & 0x80) !== 0,
			streamOffset: Number(data.getBigUint64(at + 3)),
		});
	}

	return segment;
};

/**
 * The index segments found in one KLV run, read with `read` until it returns null.
 *
 * @internal
 */
export const readIndexSegments = (
	read: (slice: FileSlice) => LocalSet | null,
	slice: FileSlice,
): MxfIndexSegment[] => {
	const segments: MxfIndexSegment[] = [];
	for (;;) {
		const set = read(slice);
		if (!set) {
			break;
		}

		segments.push(readIndexTableSegment(set));
	}

	return segments;
};

/**
 * Where one edit unit begins within its essence container, and what it is, or null where no segment
 * covers it.
 *
 * @internal
 */
export const locateEditUnit = (
	segments: MxfIndexSegment[],
	position: number,
): { streamOffset: number; isKeyFrame: boolean; temporalOffset: number; size: number | null } | null => {
	for (const segment of segments) {
		const offset = position - segment.startPosition;
		// A stated duration of zero means the segment is not bounded - it covers whatever the container
		// holds. ffmpeg writes exactly this for a constant-bit-rate index, where there is nothing to
		// count: every unit is the same size, so the segment describes all of them.
		const bounded = segment.duration !== null && segment.duration > 0;
		if (offset < 0 || (bounded && offset >= segment.duration!)) {
			continue;
		}

		if (segment.editUnitByteCount > 0) {
			// Constant bit rate: every unit is the same size, and all of them are decodable alone, which
			// is what makes the shape usable in the first place
			return {
				streamOffset: offset * segment.editUnitByteCount,
				isKeyFrame: true,
				temporalOffset: 0,
				size: segment.editUnitByteCount,
			};
		}

		const entry = segment.entries[offset];
		if (!entry) {
			continue;
		}

		const next = segment.entries[offset + 1];
		return {
			streamOffset: entry.streamOffset,
			isKeyFrame: entry.isKeyFrame,
			temporalOffset: entry.temporalOffset,
			// The last entry of a segment states no end, so its size is only known from the essence
			size: next ? next.streamOffset - entry.streamOffset : null,
		};
	}

	return null;
};

/**
 * The last key frame at or before `position`, which is where a decoder has to start to present it.
 *
 * @internal
 */
export const keyEditUnitBefore = (segments: MxfIndexSegment[], position: number): number | null => {
	let best: number | null = null;

	for (const segment of segments) {
		if (segment.editUnitByteCount > 0) {
			// Every unit is a key frame, so the answer is the position itself where the segment holds it
			const offset = position - segment.startPosition;
			const bounded = segment.duration !== null && segment.duration > 0;
			if (offset >= 0 && (!bounded || offset < segment.duration!)) {
				return position;
			}

			continue;
		}

		for (const [index, entry] of segment.entries.entries()) {
			const at = segment.startPosition + index;
			if (at > position) {
				break;
			}
			if (entry.isKeyFrame && (best === null || at > best)) {
				best = at;
			}
		}
	}

	return best;
};

export { readU8, readU32Be };

/**
 * Maps each stored edit unit to the position it is presented at.
 *
 * One index entry array is indexed two different ways at once, which is the single most misleading
 * thing in an MXF index. `StreamOffset` and the flags belong to the edit unit *stored* at that
 * position, while `TemporalOffset` belongs to the unit *displayed* at it: entry n says where the n-th
 * displayed unit is stored, as `n + temporalOffset`. Reading both as one order yields timestamps that
 * are plausible, monotonic, and wrong only where the coding reorders - so a file without B-frames
 * never shows it.
 *
 * Verified against an ffmpeg long-GOP file: display 1 (a B-frame) is stored at 2 and states +1,
 * display 3 (the P-frame) is stored at 1 and states -2.
 *
 * @internal
 */
export const presentationOrder = (segments: MxfIndexSegment[]): Map<number, number> => {
	const displayOf = new Map<number, number>();

	for (const segment of segments) {
		for (const [display, entry] of segment.entries.entries()) {
			const stored = display + entry.temporalOffset;
			displayOf.set(segment.startPosition + stored, segment.startPosition + display);
		}
	}

	return displayOf;
};
