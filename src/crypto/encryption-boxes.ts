/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Box, box, fullBox } from '../isobmff/isobmff-boxes';
import type { SubsampleEntry } from './subsample-generator';

const chars = (text: string): number[] => [...text].map(c => c.charCodeAt(0));
const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number): number[] => [
	(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
];

/** Original Format Box (`frma`): the pre-encryption sample-entry codingname (e.g. `avc1`). */
export const frma = (originalFormat: string): Box => box('frma', chars(originalFormat));

/** Scheme Type Box (`schm`): the protection scheme (e.g. `cbcs`), scheme version 1.0. */
export const schm = (scheme: string): Box => fullBox('schm', 0, 0, [chars(scheme), u32(0x00010000)]);

/**
 * Track Encryption Box (`tenc`): default protection for the track. A non-zero pattern
 * (cbcs/cens) forces version 1. Pass `constantIv` for a constant-IV scheme (cbcs) — encoded with
 * `default_per_sample_iv_size = 0` followed by the IV; pass `perSampleIvSize` for a per-sample-IV
 * scheme (cenc/cens) — encoded with that size and no constant IV.
 */
export const tenc = (options: {
	kid: Uint8Array;
	cryptByteBlock: number;
	skipByteBlock: number;
	constantIv?: Uint8Array;
	perSampleIvSize?: number;
}): Box => {
	const version = options.cryptByteBlock !== 0 && options.skipByteBlock !== 0 ? 1 : 0;
	const pattern = (options.cryptByteBlock << 4) | options.skipByteBlock;
	const head = [
		0, // reserved
		pattern, // reserved (0) for v0; crypt<<4|skip for v1
		1, // default_is_protected
	];
	if (options.constantIv !== undefined) {
		return fullBox('tenc', version, 0, [
			...head,
			0, // default_per_sample_iv_size (0 → constant IV follows)
			[...options.kid],
			options.constantIv.length, // default_constant_iv_size
			[...options.constantIv],
		]);
	}
	return fullBox('tenc', version, 0, [
		...head,
		options.perSampleIvSize ?? 0, // default_per_sample_iv_size (no constant IV follows)
		[...options.kid],
	]);
};

/**
 * The body of a `seig` sample group entry — `CencSampleEncryptionInformationGroupEntry`, ISO/IEC
 * 23001-7 §6.2. Its fields are exactly what {@link tenc} carries after its FullBox header, so it is
 * built from one: the default entry and a rotated one can then never disagree on their layout.
 */
export const seigEntry = (options: Parameters<typeof tenc>[0]): Uint8Array => tenc(options).contents!.subarray(4);

/**
 * Sample Group Description Box (`sgpd`) of grouping type `seig`: the key material of each key period
 * a track fragment draws on. Version 1 with `default_length`, since every entry of one track is the
 * same size.
 */
export const sgpdSeig = (entries: Uint8Array[]): Box => fullBox('sgpd', 1, 0, [
	chars('seig'),
	u32(entries[0]!.byteLength),
	u32(entries.length),
	entries.map(entry => [...entry]),
]);

/**
 * A run of consecutive samples of one `sbgp`, mapped onto an entry of the `traf`'s {@link sgpdSeig}
 * by its zero-based position there.
 */
export type SampleGroupRun = {
	/** How many consecutive samples this run covers. */
	sampleCount: number;
	/** The zero-based index of the `sgpd` entry those samples are encrypted under. */
	entryIndex: number;
};

/** A `group_description_index` at or above this names an entry of the `traf`'s own `sgpd`. */
const TRACK_FRAGMENT_DESCRIPTION_INDEX_BASE = 0x10000;

/**
 * Sample to Group Box (`sbgp`) of grouping type `seig`: which samples of a track fragment use which
 * entry of its {@link sgpdSeig}. A fragment-local description index is offset by 0x10000 (ISO/IEC
 * 14496-12 §8.9.3), which is what distinguishes it from a movie-level one.
 */
export const sbgpSeig = (runs: SampleGroupRun[]): Box => fullBox('sbgp', 0, 0, [
	chars('seig'),
	u32(runs.length),
	runs.map(run => [
		u32(run.sampleCount),
		u32(TRACK_FRAGMENT_DESCRIPTION_INDEX_BASE + 1 + run.entryIndex),
	]),
]);

/** Scheme Information Box (`schi`): holds the `tenc`. */
export const schi = (tencBox: Box): Box => box('schi', undefined, [tencBox]);

/** Protection Scheme Information Box (`sinf`): `frma` + `schm` + `schi`, added to an encrypted sample entry. */
export const sinf = (originalFormat: string, scheme: string, tencBox: Box): Box =>
	box('sinf', undefined, [frma(originalFormat), schm(scheme), schi(tencBox)]);

/**
 * Sample Encryption Box (`senc`): per-sample encryption info. With a constant IV
 * (`perSampleIvs` omitted) each entry carries only its subsamples. The
 * `kUseSubsampleEncryption` flag (0x2) is set only when subsamples are present —
 * full-sample encryption (cbcs audio) writes just the per-sample IVs (none for a
 * constant IV), matching shaka's `MP4Fragmenter`.
 */
export const senc = (perSampleSubsamples: SubsampleEntry[][], perSampleIvs?: Uint8Array[]): Box => {
	const useSubsample = perSampleSubsamples.some(subsamples => subsamples.length > 0);
	const contents: number[][] = [u32(perSampleSubsamples.length)];
	for (let i = 0; i < perSampleSubsamples.length; i++) {
		if (perSampleIvs !== undefined) {
			contents.push([...perSampleIvs[i]!]);
		}
		if (useSubsample) {
			const subsamples = perSampleSubsamples[i]!;
			contents.push(u16(subsamples.length));
			for (const subsample of subsamples) {
				contents.push(u16(subsample.clearBytes), u32(subsample.cipherBytes));
			}
		}
	}
	return fullBox('senc', 0, useSubsample ? 0x2 : 0, contents);
};

/**
 * The byte size of each `senc` entry, to fill `saiz`. Mirrors the layout `senc` writes above: a
 * constant IV contributes no IV bytes, and without the subsample flag there is no count field either.
 */
export const sencEntrySizes = (perSampleSubsamples: SubsampleEntry[][], perSampleIvSize: number): number[] => {
	const useSubsample = perSampleSubsamples.some(subsamples => subsamples.length > 0);
	return perSampleSubsamples.map(
		subsamples => perSampleIvSize + (useSubsample ? 2 + subsamples.length * 6 : 0),
	);
};

/** Sample Auxiliary Information Sizes Box (`saiz`): size of each sample's `senc` entry. */
export const saiz = (sampleInfoSizes: number[]): Box => {
	const allEqual = sampleInfoSizes.every(s => s === sampleInfoSizes[0]);
	if (allEqual && sampleInfoSizes.length > 0) {
		return fullBox('saiz', 0, 0, [sampleInfoSizes[0]!, u32(sampleInfoSizes.length)]);
	}
	return fullBox('saiz', 0, 0, [0, u32(sampleInfoSizes.length), sampleInfoSizes]);
};

/**
 * Sample Auxiliary Information Offsets Box (`saio`): the offset to the auxiliary (`senc`)
 * data. The offset is resolved once the fragment layout is known.
 */
export const saio = (offset: number): Box => fullBox('saio', 0, 0, [u32(1), u32(offset)]);
