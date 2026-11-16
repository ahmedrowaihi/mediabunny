/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InvalidUsageError } from '../errors';
import { copyOf } from '../misc';
import { eachBox } from '../isobmff/isobmff-misc';

/**
 * A parsed ISOBMFF box that can be mutated and re-serialized (sizes are recomputed).
 *
 * @internal
 */
export type MutableBox = {
	type: string;
	/** Leaf payload (absent for pure containers). For sample entries this is the fixed prefix. */
	data?: Uint8Array;
	/** Child boxes (absent for leaves). */
	children?: MutableBox[];
};

// Pure container boxes whose payload is entirely child boxes.
const CONTAINERS = new Set([
	'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'mfra', 'sinf', 'schi', 'udta',
]);
// Sample-entry containers: a fixed-size prefix followed by child boxes.
const SAMPLE_ENTRY_PREFIX: Record<string, number> = {
	avc1: 78, avc3: 78, hvc1: 78, hev1: 78, encv: 78,
	mp4a: 28, enca: 28,
};

/** @internal */
export const readU32 = (bytes: Uint8Array, offset: number): number =>
	((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

/** @internal */
export const writeU32 = (bytes: Uint8Array, offset: number, value: number): void => {
	bytes[offset] = (value >>> 24) & 0xff;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
};

/** @internal */
export const u32Bytes = (value: number): number[] => [
	(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
];

/** @internal */
export const u64Bytes = (value: number): number[] => {
	const big = BigInt(value);
	return Array.from({ length: 8 }, (_, i) => Number((big >> BigInt(56 - i * 8)) & 0xffn));
};

/**
 * A FullBox's 24-bit flags, read from its payload.
 *
 * @internal
 */
export const boxFlags = (data: Uint8Array): number => (data[1]! << 16) | (data[2]! << 8) | data[3]!;

/** @internal */
const TFHD_BASE_DATA_OFFSET_PRESENT = 0x1;
/** @internal */
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT = 0x2;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x8;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x10;

/**
 * Byte offset of `data_offset` within a `trun` payload: version/flags(4) + sample_count(4).
 *
 * @internal
 */
export const TRUN_DATA_OFFSET_POSITION = 4 + 4;
/** @internal */
export const TRUN_DATA_OFFSET_PRESENT = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x4;
const TRUN_SAMPLE_DURATION_PRESENT = 0x100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x400;
const TRUN_SAMPLE_TIME_OFFSET_PRESENT = 0x800;

/** @internal */
export const trafsOf = (moof: MutableBox): MutableBox[] =>
	(moof.children ?? []).filter(box => box.type === 'traf');
/** @internal */
export const trunsOf = (traf: MutableBox): MutableBox[] =>
	(traf.children ?? []).filter(box => box.type === 'trun');
/** @internal */
export const tfhdOf = (traf: MutableBox): MutableBox | undefined =>
	(traf.children ?? []).find(box => box.type === 'tfhd');

/**
 * One `traf`'s resolved base. `followsMoof` is the only case in which growing the `moof` moves what its
 * offsets point at: a stated `base_data_offset` is a file offset that absorbs the same shift, and an
 * implicit base travels with the `mdat` instead.
 *
 * @internal
 */
export type ResolvedBase = { trackId: number; base: number; followsMoof: boolean };

/**
 * Where a fragment's `moof` and the sample data it describes sit in the file.
 *
 * @internal
 */
export type FragmentGeometry = {
	moofOffset: number;
	/** First byte of the `mdat` payload, i.e. past its header. */
	mdatDataStart: number;
	mdatLength: number;
};

/** `data_offset` is a signed int32, so an implicit base can be approached from either side. */
const trunDataOffset = (data: Uint8Array): number => readU32(data, TRUN_DATA_OFFSET_POSITION) | 0;

/** The default sample size a `tfhd` states, or 0 when it states none. */
const defaultSampleSizeOf = (tfhd: Uint8Array): number => {
	const flags = boxFlags(tfhd);
	if (!(flags & TFHD_DEFAULT_SAMPLE_SIZE_PRESENT)) {
		return 0;
	}

	let offset = 8;
	if (flags & TFHD_BASE_DATA_OFFSET_PRESENT) {
		offset += 8;
	}
	if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT) {
		offset += 4;
	}
	if (flags & TFHD_DEFAULT_SAMPLE_DURATION_PRESENT) {
		offset += 4;
	}
	return readU32(tfhd, offset);
};

/**
 * The byte span a `traf`'s samples occupy, relative to its base. Every term is `base + offset`, so the
 * walk is done once and each candidate base is tested by adding it.
 */
const trafDataSpan = (traf: MutableBox): { start: number; end: number } => {
	const tfhd = tfhdOf(traf);
	const defaultSampleSize = tfhd?.data === undefined ? 0 : defaultSampleSizeOf(tfhd.data);
	let cursor = 0;
	let start = Infinity;

	for (const trun of trunsOf(traf)) {
		const data = trun.data;
		if (data === undefined) {
			continue;
		}

		const flags = boxFlags(data);
		if (flags & TRUN_DATA_OFFSET_PRESENT) {
			cursor = trunDataOffset(data);
		}
		start = Math.min(start, cursor);

		const count = readU32(data, 4);
		let offset = 8 + ((flags & TRUN_DATA_OFFSET_PRESENT) ? 4 : 0)
			+ ((flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) ? 4 : 0);
		for (let i = 0; i < count; i++) {
			if (flags & TRUN_SAMPLE_DURATION_PRESENT) {
				offset += 4;
			}
			if (flags & TRUN_SAMPLE_SIZE_PRESENT) {
				cursor += readU32(data, offset);
				offset += 4;
			} else {
				cursor += defaultSampleSize;
			}
			if (flags & TRUN_SAMPLE_FLAGS_PRESENT) {
				offset += 4;
			}
			if (flags & TRUN_SAMPLE_TIME_OFFSET_PRESENT) {
				offset += 4;
			}
		}
	}

	return { start: start === Infinity ? 0 : start, end: cursor };
};

/**
 * Every `traf`'s `base_data_offset`, in `moof` order (ISO/IEC 14496-12 section 8.8.7): stated outright,
 * the enclosing `moof` under `default-base-is-moof`, and with neither stated the end of the previous
 * `traf`'s data - which for the fragment's first `traf` is the `moof` itself.
 *
 * That last case carries a fallback, because writers commonly omit `default-base-is-moof` and still
 * measure every `traf` from the `moof`. Read implicitly, such a file names samples past the end of its
 * own `mdat`; when the `moof` is where they actually are, that is the base whatever the flags left
 * unsaid.
 *
 * @internal
 */
export const baseDataOffsetsOf = (
	moof: MutableBox,
	geometry: FragmentGeometry,
): ResolvedBase[] => {
	const { moofOffset, mdatDataStart, mdatLength } = geometry;
	const resolved: ResolvedBase[] = [];
	let previousEnd = moofOffset;

	for (const traf of trafsOf(moof)) {
		const tfhd = tfhdOf(traf);
		const data = tfhd?.data;
		const flags = data === undefined ? 0 : boxFlags(data);
		const span = trafDataSpan(traf);
		const fits = (candidate: number): boolean =>
			candidate + span.start >= mdatDataStart && candidate + span.end <= mdatDataStart + mdatLength;
		let base: number;

		if (data !== undefined && (flags & TFHD_BASE_DATA_OFFSET_PRESENT)) {
			base = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8));
		} else if (flags & TFHD_DEFAULT_BASE_IS_MOOF) {
			base = moofOffset;
		} else {
			base = previousEnd !== moofOffset && !fits(previousEnd) && fits(moofOffset)
				? moofOffset
				: previousEnd;
		}

		resolved.push({
			trackId: data === undefined ? 0 : readU32(data, 4),
			base,
			// Only a base that is the moof moves what its offsets point at when that moof grows
			followsMoof: base === moofOffset,
		});
		previousEnd = base + span.end;
	}

	return resolved;
};

/**
 * Adds `delta` to every `trun` data offset in the `moof` that is measured from it, and hands back the
 * resolved bases so a caller needing them does not resolve the same `moof` twice.
 *
 * @internal
 */
export const shiftTrunDataOffsets = (
	moof: MutableBox,
	delta: number,
	geometry: FragmentGeometry,
): ResolvedBase[] => {
	const resolved = baseDataOffsetsOf(moof, geometry);

	for (const [index, traf] of trafsOf(moof).entries()) {
		if (!resolved[index]!.followsMoof) {
			continue;
		}

		for (const trun of trunsOf(traf)) {
			if (trun.data !== undefined && (boxFlags(trun.data) & TRUN_DATA_OFFSET_PRESENT)) {
				writeU32(
					trun.data,
					TRUN_DATA_OFFSET_POSITION,
					readU32(trun.data, TRUN_DATA_OFFSET_POSITION) + delta,
				);
			}
		}
	}

	return resolved;
};

/**
 * Parse a range of bytes into a list of boxes, recursing into known containers.
 *
 * @internal
 */
export const parseBoxes = (bytes: Uint8Array, start: number, end: number): MutableBox[] => {
	const boxes: MutableBox[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	eachBox(view, start, end, (type, contentStart, contentEnd) => {
		const sampleEntryPrefix = SAMPLE_ENTRY_PREFIX[type];

		if (CONTAINERS.has(type)) {
			boxes.push({ type, children: parseBoxes(bytes, contentStart, contentEnd) });
		} else if (type === 'stsd') {
			// FullBox(4) + entry_count(4), then sample entries as children.
			boxes.push({
				type,
				data: copyOf(bytes, contentStart, contentStart + 8),
				children: parseBoxes(bytes, contentStart + 8, contentEnd),
			});
		} else if (sampleEntryPrefix !== undefined) {
			const prefix = sampleEntryPrefix;
			boxes.push({
				type,
				data: copyOf(bytes, contentStart, contentStart + prefix),
				children: parseBoxes(bytes, contentStart + prefix, contentEnd),
			});
		} else {
			boxes.push({ type, data: copyOf(bytes, contentStart, contentEnd) });
		}
	});

	return boxes;
};

/**
 * Total serialized byte length of a box (with recomputed size).
 *
 * @internal
 */
export const measureBox = (box: MutableBox): number => {
	let size = 8 + (box.data?.byteLength ?? 0);
	if (box.children) {
		for (const child of box.children) {
			size += measureBox(child);
		}
	}
	return size;
};

/**
 * Write one box and its children into `out`, returning the offset just past it.
 *
 * The size header is backfilled once the children are placed, so a box is written exactly once
 * rather than being built in its own buffer and copied into its parent at every level.
 */
const writeBox = (box: MutableBox, out: Uint8Array, view: DataView, offset: number): number => {
	let end = offset + 8;
	if (box.data) {
		out.set(box.data, end);
		end += box.data.byteLength;
	}
	if (box.children) {
		for (const child of box.children) {
			end = writeBox(child, out, view, end);
		}
	}

	view.setUint32(offset, end - offset);
	for (let i = 0; i < 4; i++) {
		out[offset + 4 + i] = box.type.charCodeAt(i);
	}
	return end;
};

/**
 * Serialize a top-level box list to a single buffer.
 *
 * @internal
 */
export const serializeBoxes = (boxes: MutableBox[]): Uint8Array => {
	let total = 0;
	for (const box of boxes) {
		total += measureBox(box);
	}

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	let offset = 0;
	for (const box of boxes) {
		offset = writeBox(box, out, view, offset);
	}
	return out;
};

/**
 * Parses each entry as exactly one complete top-level box, which is what the insert helpers accept.
 *
 * @internal
 */
export const parseSingleBoxes = (boxes: Uint8Array[]): MutableBox[] => boxes.map((bytes) => {
	const boxList = parseBoxes(bytes, 0, bytes.length);
	if (boxList.length !== 1) {
		throw new InvalidUsageError('Each entry must be exactly one complete top-level box.');
	}
	return boxList[0]!;
});

/**
 * Depth-first find of the first box of `type`.
 *
 * @internal
 */
export const findBox = (boxes: MutableBox[], type: string): MutableBox | null => {
	for (const box of boxes) {
		if (box.type === type) {
			return box;
		}
		if (box.children) {
			const found = findBox(box.children, type);
			if (found !== null) {
				return found;
			}
		}
	}
	return null;
};
