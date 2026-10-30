/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InvalidUsageError, MalformedInputError } from './errors';
import {
	boxFlags,
	measureBox,
	type MutableBox,
	parseBoxes,
	parseSingleBoxes,
	readU32,
	serializeBoxes,
	shiftTrunDataOffsets,
	tfhdOf,
	trafsOf,
	u32Bytes,
	u64Bytes,
	writeU32,
} from './crypto/box-tree';
import { iterateIsobmffBoxes, shiftBaseDataOffsets } from './isobmff/isobmff-misc';

const UUID_TYPE = [0x75, 0x75, 0x69, 0x64]; // 'uuid'

// MS-SSTR 2.2.4.4 and 2.2.4.5 state these as the extended types of the two boxes.
const TFXD_UUID = [
	0x6d, 0x1d, 0x9b, 0x05, 0x42, 0xd5, 0x44, 0xe6, 0x80, 0xe2, 0x14, 0x1d, 0xaf, 0xf7, 0x57, 0xb2,
];
const TFRF_UUID = [
	0xd4, 0x80, 0x7e, 0xf2, 0xca, 0x39, 0x46, 0x95, 0x8e, 0x54, 0x26, 0xcb, 0x9e, 0x46, 0xa7, 0x9f,
];

const uuidBox = (uuid: number[], body: number[]): Uint8Array =>
	Uint8Array.from([...u32Bytes(8 + uuid.length + body.length), ...UUID_TYPE, ...uuid, ...body]);

const checkTime = (label: string, value: number): void => {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a non-negative integer below 2^53.`);
	}
};

/**
 * One fragment's absolute position on a Smooth Streaming track's timeline, in the track's timescale.
 *
 * @group ISO BMFF segments
 * @public
 */
export type SmoothFragmentTiming = {
	/** The absolute timestamp of the fragment's first sample. */
	time: number;
	/** The total duration of the fragment's samples. */
	duration: number;
};

/**
 * Build the `tfxd` box (MS-SSTR 2.2.4.4), which states where a fragment sits on the track's absolute
 * timeline. Written as version 1, so both fields are 64-bit.
 *
 * It is a `uuid` box belonging inside a `traf` — pair it with {@link insertBoxesIntoTraf}, not with
 * `insertBoxesBeforeMoof`, which places top-level boxes a Smooth client will not look at.
 *
 * @group ISO BMFF segments
 * @public
 */
export const buildTfxdBox = (timing: SmoothFragmentTiming): Uint8Array => {
	checkTime('time', timing.time);
	checkTime('duration', timing.duration);

	return uuidBox(TFXD_UUID, [1, 0, 0, 0, ...u64Bytes(timing.time), ...u64Bytes(timing.duration)]);
};

/**
 * Options for {@link buildTfrfBox}.
 *
 * @group ISO BMFF segments
 * @public
 */
export type TfrfOptions = {
	/**
	 * Width of the fragment-count field. MS-SSTR 2.2.4.5's ABNF says `UINT8`; its prose field table says
	 * 4 bytes. The default follows the ABNF - set this to 4 if the client you serve disagrees.
	 */
	fragmentCountBytes?: 1 | 4;
};

/**
 * Build the `tfrf` box (MS-SSTR 2.2.4.5), the lookahead that announces the fragments following this one
 * so a live Smooth client knows what to request next. Written as version 1, so every field is 64-bit.
 *
 * @group ISO BMFF segments
 * @public
 */
export const buildTfrfBox = (
	fragments: SmoothFragmentTiming[],
	options: TfrfOptions = {},
): Uint8Array => {
	if (fragments.length === 0) {
		throw new InvalidUsageError('A tfrf box must announce at least one fragment.');
	}

	const countBytes = options.fragmentCountBytes ?? 1;
	if (countBytes !== 1 && countBytes !== 4) {
		throw new InvalidUsageError('fragmentCountBytes must be 1 or 4.');
	}
	if (countBytes === 1 && fragments.length > 255) {
		throw new InvalidUsageError('A one-byte fragment count cannot state more than 255 fragments.');
	}

	const body = [1, 0, 0, 0, ...(countBytes === 1 ? [fragments.length] : u32Bytes(fragments.length))];
	for (const fragment of fragments) {
		checkTime('time', fragment.time);
		checkTime('duration', fragment.duration);
		body.push(...u64Bytes(fragment.time), ...u64Bytes(fragment.duration));
	}

	return uuidBox(TFRF_UUID, body);
};

/** Grows every `saio` entry, for a `traf` whose offsets were found to follow the `moof`. */
const shiftSaioOffsets = (traf: MutableBox, added: number): void => {
	for (const saio of (traf.children ?? []).filter(box => box.type === 'saio')) {
		const data = saio.data;
		if (data === undefined) {
			continue;
		}

		const version = data[0];
		// version/flags(4) + optional aux_info_type(4) + aux_info_type_parameter(4), then entry_count
		let position = 4 + ((boxFlags(data) & 0x1) ? 8 : 0);
		const entryCount = readU32(data, position);
		position += 4;

		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let i = 0; i < entryCount; i++) {
			if (version === 0) {
				writeU32(data, position, readU32(data, position) + added);
				position += 4;
			} else {
				view.setBigUint64(position, view.getBigUint64(position) + BigInt(added));
				position += 8;
			}
		}
	}
};

// A sidx ahead of the fragments measures first_offset to the first of them and referenced_size across
// each one. Growing a moof leaves the distance to it alone but lengthens the fragment it belongs to -
// the mirror of insertBoxesBeforeMoof, which lengthens the distance and leaves the fragments alone.
const growSidxReferencedSizeAt = (bytes: Uint8Array, sidxStart: number, fragmentIndex: number, added: number) => {
	const content = sidxStart + 8;
	const version = bytes[content]!;
	// version/flags(4) + reference_ID(4) + timescale(4) + earliest/first (8 or 16) + reserved(2)
	const position = content + 4 + 4 + 4 + (version === 0 ? 8 : 16) + 2;
	const referenceCount = (bytes[position]! << 8) | bytes[position + 1]!;
	if (fragmentIndex >= referenceCount) {
		return;
	}

	// Each reference is 12 bytes, opening with reference_type(1 bit) + referenced_size(31 bits)
	const at = position + 2 + fragmentIndex * 12;
	const word = readU32(bytes, at);
	const grown = (word & 0x7fff_ffff) + added;
	if (grown > 0x7fff_ffff) {
		throw new InvalidUsageError('The grown fragment no longer fits a sidx referenced_size.');
	}
	writeU32(bytes, at, (word & 0x8000_0000) | grown);
};

/**
 * Insert complete boxes into a fragment's `traf`, immediately after its last `trun`, and restate every
 * offset the growth moves - `trun` data offsets, `saio`, a `tfhd` `base_data_offset`, and a preceding
 * `sidx`'s `referenced_size`.
 *
 * For Smooth Streaming's {@link buildTfxdBox | `tfxd`} and {@link buildTfrfBox | `tfrf`}, which are
 * `traf`-level `uuid` boxes: `insertBoxesBeforeMoof` is the wrong tool for them, as it writes top-level
 * boxes where no Smooth client looks. The boxes go after the last `trun` rather than at the end of the
 * `traf`, which keeps `senc` last where the encryption path expects it.
 *
 * @param segment - A packaged segment or fragment, which may hold several `moof`/`mdat` pairs.
 * @param trackId - The `tfhd` track ID naming the `traf` to insert into.
 * @param boxes - Complete top-level boxes, each exactly one box.
 *
 * @group ISO BMFF segments
 * @public
 */
export const insertBoxesIntoTraf = (segment: Uint8Array, trackId: number, boxes: Uint8Array[]): Uint8Array => {
	if (boxes.length === 0) {
		return segment;
	}

	const inserted = parseSingleBoxes(boxes);
	const added = inserted.reduce((total, box) => total + measureBox(box), 0);

	// Walked rather than parsed: this finds the moof's byte range without copying any payload, which
	// for a segment that is mostly mdat is the difference between touching a kilobyte and a megabyte.
	let fragmentIndex = -1;
	let targetIndex = -1;
	let moofStart = -1;
	let moofEnd = -1;
	const sidxes: { start: number; firstFragment: number }[] = [];

	for (const box of iterateIsobmffBoxes(segment)) {
		if (box.type === 'sidx') {
			sidxes.push({ start: box.start, firstFragment: fragmentIndex + 1 });
			continue;
		}
		if (box.type !== 'moof') {
			continue;
		}

		fragmentIndex++;
		if (moofStart !== -1) {
			continue;
		}

		const children = parseBoxes(segment, box.start + box.headerSize, box.start + box.size);
		const found = children.filter(child => child.type === 'traf').findIndex((traf) => {
			const tfhd = tfhdOf(traf);
			return tfhd?.data !== undefined && readU32(tfhd.data, 4) === trackId;
		});
		if (found !== -1) {
			moofStart = box.start;
			moofEnd = box.start + box.size;
			targetIndex = fragmentIndex;
		}
	}

	if (moofStart === -1) {
		throw new MalformedInputError(`The segment has no traf for track ${trackId}.`);
	}

	const moof: MutableBox = {
		type: 'moof',
		children: parseBoxes(segment, moofStart + 8, moofEnd),
	};
	const trafs = trafsOf(moof);
	const traf = trafs.find((candidate) => {
		const tfhd = tfhdOf(candidate);
		return tfhd?.data !== undefined && readU32(tfhd.data, 4) === trackId;
	})!;

	const children = traf.children ?? [];
	const lastTrun = children.map(box => box.type).lastIndexOf('trun');
	if (lastTrun === -1) {
		throw new MalformedInputError(`The traf for track ${trackId} has no trun to insert after.`);
	}
	traf.children = [...children.slice(0, lastTrun + 1), ...inserted, ...children.slice(lastTrun + 1)];

	// The mdat follows the moof, and its payload is what every data offset has to land inside
	const geometry = {
		moofOffset: moofStart,
		mdatDataStart: moofEnd + 8,
		mdatLength: readU32(segment, moofEnd) - 8,
	};

	// Resolved once: the shift hands back the bases it used, and re-resolving would read the offsets it
	// just mutated
	const resolved = shiftTrunDataOffsets(moof, added, geometry);

	// Aux info only moves if it sits after the insertion, so earlier tracks keep their offsets
	for (let index = trafs.indexOf(traf); index < trafs.length; index++) {
		if (resolved[index]!.followsMoof) {
			shiftSaioOffsets(trafs[index]!, added);
		}
	}

	const rebuilt = serializeBoxes([moof]);
	const out = new Uint8Array(segment.byteLength + added);
	out.set(segment.subarray(0, moofStart), 0);
	out.set(rebuilt, moofStart);
	out.set(segment.subarray(moofEnd), moofStart + rebuilt.byteLength);

	for (const { start, firstFragment } of sidxes) {
		if (targetIndex >= firstFragment) {
			growSidxReferencedSizeAt(out, start, targetIndex - firstFragment, added);
		}
	}

	// base_data_offset is a file offset, so it follows the moof - but only this fragment's mdat and
	// whatever comes after it moved, so the fragments ahead of it must be left alone
	shiftBaseDataOffsets(out.subarray(moofStart), added);

	return out;
};
