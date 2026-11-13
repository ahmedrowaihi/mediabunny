/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MXF is a flat sequence of KLV triplets (SMPTE 336M): a 16-byte Universal Label, a BER-encoded
// length, and that many bytes of value. Everything else - partitions, header metadata, index tables,
// essence - is a key this file knows how to tell apart and a value someone else parses.

import { MalformedInputError } from '../errors';
import { FileSlice, readBytes, readU8, readU16Be, readU32Be, readU64Be } from '../reader';

/** The first four bytes of every SMPTE Universal Label, which is what finds one in a buffer. */
export const SMPTE_UL_PREFIX = [0x06, 0x0e, 0x2b, 0x34] as const;

export const KEY_LENGTH = 16;

/**
 * A key, its value's length, and where the value starts. Keys are compared by their bytes rather than
 * parsed: a UL carries a registry designator and a version byte that differ between files describing
 * the same thing, so the comparisons that matter are stated per key below.
 */
export type KlvHeader = {
	key: Uint8Array;
	/** Byte offset of the key itself. */
	start: number;
	/** Byte offset of the first value byte. */
	valueStart: number;
	length: number;
};

/**
 * A BER length: either a short form in one byte, or a long form stating how many bytes carry it.
 * MXF also allows a 4-byte or 8-byte fixed form, which is the long form with a stated count.
 */
export const readBerLength = (slice: FileSlice): number => {
	const first = readU8(slice);
	if ((first & 0x80) === 0) {
		return first;
	}

	const count = first & 0x7f;
	if (count === 0) {
		throw new MalformedInputError('An MXF BER length states the indefinite form, which MXF forbids.');
	}
	if (count > 8) {
		throw new MalformedInputError(`An MXF BER length states ${count} bytes, more than the 8 MXF allows.`);
	}

	let value = 0;
	for (let i = 0; i < count; i++) {
		value = value * 256 + readU8(slice);
	}

	if (!Number.isSafeInteger(value)) {
		throw new MalformedInputError('An MXF BER length is too large to be represented exactly.');
	}

	return value;
};

/** How many bytes a BER length occupies at `slice`'s position, without consuming it. */
export const berLengthSize = (first: number): number => ((first & 0x80) === 0 ? 1 : 1 + (first & 0x7f));

/** Reads one KLV header, or null where the slice does not hold a whole one. */
export const readKlvHeader = (slice: FileSlice): KlvHeader | null => {
	const start = slice.filePos;
	if (slice.remainingLength < KEY_LENGTH + 1) {
		return null;
	}

	const key = readBytes(slice, KEY_LENGTH);
	for (let i = 0; i < SMPTE_UL_PREFIX.length; i++) {
		if (key[i] !== SMPTE_UL_PREFIX[i]) {
			throw new MalformedInputError(
				`Expected an MXF key at offset ${start}, but the bytes are not a SMPTE universal label.`,
			);
		}
	}

	const lengthSize = berLengthSize(slice.view.getUint8(slice.bufferPos));
	if (slice.remainingLength < lengthSize) {
		return null;
	}

	const length = readBerLength(slice);
	return { key, start, valueStart: slice.filePos, length };
};

/**
 * Whether a key matches a pattern, ignoring the bytes that vary between files saying the same thing:
 * byte 7 is the registry version and byte 14 is the set's own version, and a `null` in the pattern
 * skips any other byte a caller does not care about.
 */
export const keyMatches = (key: Uint8Array, pattern: readonly (number | null)[]): boolean => {
	for (let i = 0; i < KEY_LENGTH; i++) {
		const expected = pattern[i];
		if (expected !== undefined && expected !== null && key[i] !== expected) {
			return false;
		}
	}

	return true;
};

/** `0d010201 01……00`: a partition pack, whose low bytes say which kind and how complete it is. */
// Deliberately not exported: bytes 13 and 14 are open here, so this also matches the primer pack,
// whose key differs only in them. `partitionKind` is the predicate; it pins byte 13.
const PARTITION_PACK = [
	0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, null,
	0x0d, 0x01, 0x02, 0x01, 0x01, null, null, 0x00,
] as const;

/**
 * Which partition a key names, or null where it names none - including the primer pack, which shares
 * every byte of the partition key but the two that say which one it is.
 *
 * Header, body and footer partitions differ in byte 13: 2, 3 and 4, with 1 for a generic one.
 */
export const partitionKind = (key: Uint8Array): 'header' | 'body' | 'footer' | 'generic' | null => {
	if (!keyMatches(key, PARTITION_PACK)) {
		return null;
	}

	switch (key[13]) {
		case 0x02: return 'header';
		case 0x03: return 'body';
		case 0x04: return 'footer';
		case 0x01: return 'generic';
		default: return null;
	}
};

export const PRIMER_PACK = [
	0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, null,
	0x0d, 0x01, 0x02, 0x01, 0x01, 0x05, 0x01, 0x00,
] as const;

export const KLV_FILL = [
	0x06, 0x0e, 0x2b, 0x34, 0x01, 0x01, 0x01, null,
	0x03, 0x01, 0x02, 0x10, 0x01, 0x00, 0x00, 0x00,
] as const;

/**
 * `060e2b34 0102 01 ?? 0d010301 <4>`: an essence element, whose last four bytes are the TrackNumber of
 * the track it belongs to. That number is the only link between the essence and the metadata - the
 * element key says nothing else about which track it is.
 */
export const ESSENCE_ELEMENT = [
	0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, null,
	0x0d, 0x01, 0x03, 0x01, null, null, null, null,
] as const;

/** The TrackNumber an essence element key names, or null where the key is not one. */
export const essenceTrackNumber = (key: Uint8Array): number | null => {
	if (!keyMatches(key, ESSENCE_ELEMENT)) {
		return null;
	}

	return ((key[12]! << 24) | (key[13]! << 16) | (key[14]! << 8) | key[15]!) >>> 0;
};

export const INDEX_TABLE_SEGMENT = [
	0x06, 0x0e, 0x2b, 0x34, 0x02, 0x53, 0x01, null,
	0x0d, 0x01, 0x02, 0x01, 0x01, 0x10, 0x01, 0x00,
] as const;

/**
 * A header metadata set: `060e2b34 0253 01 ?? 0d010101 01 ?? ?? 00`, where bytes 13 and 14 name the
 * set. They are read as one 16-bit value so a set can be named by the number SMPTE 377M gives it.
 */
export const HEADER_METADATA_SET = [
	0x06, 0x0e, 0x2b, 0x34, 0x02, 0x53, 0x01, null,
	0x0d, 0x01, 0x01, 0x01, 0x01, null, null, 0x00,
] as const;

export const setTypeOf = (key: Uint8Array): number | null =>
	keyMatches(key, HEADER_METADATA_SET) ? ((key[13]! << 8) | key[14]!) : null;

/** The sets this demuxer reads, by the number SMPTE 377M gives each one. */
export enum MxfSetType {
	Preface = 0x012f,
	Identification = 0x0130,
	ContentStorage = 0x0118,
	EssenceContainerData = 0x0123,
	MaterialPackage = 0x0136,
	SourcePackage = 0x0137,
	Track = 0x013b,
	EventTrack = 0x0139,
	StaticTrack = 0x013a,
	Sequence = 0x010f,
	SourceClip = 0x0111,
	TimecodeComponent = 0x0114,
	FileDescriptor = 0x0125,
	GenericPictureEssenceDescriptor = 0x0127,
	CdciEssenceDescriptor = 0x0128,
	RgbaEssenceDescriptor = 0x0129,
	GenericSoundEssenceDescriptor = 0x0142,
	MultipleDescriptor = 0x0144,
	WaveAudioDescriptor = 0x0148,
	Aes3AudioDescriptor = 0x0147,
	Mpeg2VideoDescriptor = 0x0151,
	JpegJ2kSubDescriptor = 0x015a,
}

/** A local set's entries, by their 16-bit local tag. A tag's meaning comes from the primer pack. */
export type LocalSet = Map<number, Uint8Array>;

/**
 * Local sets use 2-byte tags and 2-byte lengths, which is what the `0x53` in byte 5 of the key states.
 * A tag's meaning is the UL the primer pack maps it to; the handful this demuxer needs are matched by
 * their standard tags, which the primer confirms.
 */
export const readLocalSet = (slice: FileSlice, length: number): LocalSet => {
	const set: LocalSet = new Map();
	const end = slice.filePos + length;

	while (slice.filePos + 4 <= end) {
		const tag = readU16Be(slice);
		const size = readU16Be(slice);
		if (slice.filePos + size > end) {
			throw new MalformedInputError(
				`An MXF local set entry with tag 0x${tag.toString(16)} states ${size} bytes, which run past`
				+ ' the set.',
			);
		}

		set.set(tag, readBytes(slice, size));
	}

	return set;
};

/** The primer pack maps each local tag to the UL it stands for, so a non-standard tag can be read. */
export const readPrimerPack = (slice: FileSlice, length: number): Map<number, Uint8Array> => {
	const end = slice.filePos + length;
	const entries = new Map<number, Uint8Array>();
	if (slice.filePos + 8 > end) {
		return entries;
	}

	const count = readU32Be(slice);
	const entrySize = readU32Be(slice);
	if (entrySize < 2 + KEY_LENGTH) {
		throw new MalformedInputError(`An MXF primer pack states ${entrySize}-byte entries, too small for one.`);
	}

	for (let i = 0; i < count && slice.filePos + entrySize <= end; i++) {
		const tag = readU16Be(slice);
		entries.set(tag, readBytes(slice, KEY_LENGTH));
		slice.skip(entrySize - 2 - KEY_LENGTH);
	}

	return entries;
};

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A local set value as an unsigned integer of its own width, which is how MXF states most numbers. */
export const asUint = (bytes: Uint8Array): number => {
	let value = 0;
	for (const byte of bytes) {
		value = value * 256 + byte;
	}

	return value;
};

/** A rational, which MXF writes as two 32-bit values. */
export const asRational = (bytes: Uint8Array): { num: number; den: number } | null => {
	if (bytes.byteLength < 8) {
		return null;
	}

	const data = view(bytes);
	return { num: data.getUint32(0), den: data.getUint32(4) };
};

/** A 16-byte UMID or UL value, returned as its own bytes so it can be compared or used as a key. */
export const asKey = (bytes: Uint8Array): string => {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}

	return out;
};

export { readU8, readU16Be, readU32Be, readU64Be };
