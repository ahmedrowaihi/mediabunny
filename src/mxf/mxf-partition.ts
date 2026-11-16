/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// An MXF file is a run of partitions, each opening with a partition pack that states where the next
// one is and what the partition holds. The header partition carries the metadata; body partitions
// carry essence; the footer carries the index and a repeat of the metadata.
//
// Walking by the `ThisPartition`/`PreviousPartition`/`FooterPartition` offsets in the packs is what a
// seeking reader does, but those offsets are only trustworthy in a closed file. This walks forward
// through the KLV stream instead, which works on a file still being written, and uses the stated
// offsets only to jump to the footer.

import type { FileSlice } from '../reader';
import {
	INDEX_TABLE_SEGMENT,
	KLV_FILL,
	keyMatches,
	type LocalSet,
	partitionKind,
	PRIMER_PACK,
	readKlvHeader,
	readLocalSet,
	readPrimerPack,
	readU32Be,
	readU64Be,
	setTypeOf,
} from './mxf-klv';

export type MxfPartition = {
	kind: 'header' | 'body' | 'footer' | 'generic';
	/** Byte offset of the partition pack's key. */
	start: number;
	/** Byte offset of the first byte past the partition pack's value, where its contents begin. */
	contentsStart: number;
	/** Where the essence of this partition begins, relative to the file. */
	bodyOffset: number;
	/** Which essence container this partition's body belongs to; 0 where it carries none. */
	bodySid: number;
	/** Which index table this partition's index segments belong to; 0 where it carries none. */
	indexSid: number;
	/**
	 * Byte offset of the footer partition, as this pack states it, or 0 where it states none.
	 *
	 * The one stated offset worth trusting, and the reason it is kept: the footer holds the index, and
	 * it sits at the end of a file that may be far larger than any window a reader opens at the front.
	 * A file still being written states 0 here, and then there is no index to find.
	 */
	footerOffset: number;
};

/**
 * Reads a partition pack's body, which is a fixed-layout pack rather than a local set.
 *
 * Only the fields a reader needs are taken: the rest of the pack states sizes and the operational
 * pattern, which say nothing a caller cannot read from the metadata.
 */
const readPartitionPack = (slice: FileSlice, length: number) => {
	const end = slice.filePos + length;
	if (length < 64) {
		return null;
	}

	slice.skip(2 + 2); // MajorVersion, MinorVersion
	slice.skip(4); // KAGSize
	slice.skip(8); // ThisPartition
	slice.skip(8); // PreviousPartition
	const footer = readU64Be(slice);
	slice.skip(8); // HeaderByteCount
	slice.skip(8); // IndexByteCount
	const indexSid = readU32Be(slice);
	const bodyOffset = readU64Be(slice);
	const bodySid = readU32Be(slice);

	slice.skip(end - slice.filePos);
	return { footer, indexSid, bodyOffset, bodySid };
};

/**
 * Every partition in the file, in the order they appear.
 *
 * @internal
 */
export const readPartitions = (slice: FileSlice): MxfPartition[] => {
	const partitions: MxfPartition[] = [];

	for (;;) {
		const header = readKlvHeader(slice);
		if (!header) {
			break;
		}

		const kind = partitionKind(header.key);
		if (kind === null) {
			slice.skip(header.length);
			continue;
		}

		const pack = readPartitionPack(slice, header.length);
		if (!pack) {
			break;
		}

		partitions.push({
			kind,
			start: header.start,
			contentsStart: slice.filePos,
			bodyOffset: pack.bodyOffset,
			bodySid: pack.bodySid,
			indexSid: pack.indexSid,
			footerOffset: pack.footer,
		});
	}

	return partitions;
};

/**
 * Reads the header metadata that follows a partition pack: a primer, then local sets, until something
 * that is neither - the essence, an index table, or the next partition.
 *
 * The primer maps each local tag to the UL it stands for. It is returned rather than applied, since
 * every tag this demuxer reads is a standard one; a file using private tags needs it to tell them
 * apart, and nothing else does.
 *
 * @internal
 */
export const readHeaderMetadataSets = (slice: FileSlice) => {
	const sets = new Map<string, LocalSet>();
	const setTypes = new Map<string, number>();
	let primer: Map<number, Uint8Array> | null = null;

	for (;;) {
		const header = readKlvHeader(slice);
		if (!header) {
			break;
		}

		if (keyMatches(header.key, KLV_FILL)) {
			slice.skip(header.length);
			continue;
		}

		if (keyMatches(header.key, PRIMER_PACK)) {
			primer = readPrimerPack(slice, header.length);
			continue;
		}

		const type = setTypeOf(header.key);
		if (type === null) {
			// Past the metadata: the essence, an index table segment, or the next partition pack. The
			// slice is left at this item's key so a caller can carry on reading from it.
			slice.skip(header.start - slice.filePos);
			break;
		}

		const set = readLocalSet(slice, header.length);
		const uid = set.get(0x3c0a);
		if (!uid) {
			continue;
		}

		let key = '';
		for (const byte of uid) {
			key += byte.toString(16).padStart(2, '0');
		}

		sets.set(key, set);
		setTypes.set(key, type);
	}

	return { sets, setTypes, primer };
};

/**
 * Reads the index table segments a partition carries, from `slice` up to the next partition pack.
 *
 * Index segments sit alongside the metadata rather than after it in some writers' files, so this
 * skips anything that is not one instead of stopping at the first thing it does not recognise.
 *
 * @internal
 */
export const readIndexSegmentsIn = (slice: FileSlice): LocalSet[] => {
	const sets: LocalSet[] = [];

	for (;;) {
		const header = readKlvHeader(slice);
		if (!header || partitionKind(header.key) !== null) {
			break;
		}

		if (keyMatches(header.key, INDEX_TABLE_SEGMENT)) {
			sets.push(readLocalSet(slice, header.length));
			continue;
		}

		slice.skip(header.length);
	}

	return sets;
};
