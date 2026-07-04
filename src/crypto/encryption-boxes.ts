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
export const tenc = (opts: {
	kid: Uint8Array;
	cryptByteBlock: number;
	skipByteBlock: number;
	constantIv?: Uint8Array;
	perSampleIvSize?: number;
}): Box => {
	const version = opts.cryptByteBlock !== 0 && opts.skipByteBlock !== 0 ? 1 : 0;
	const pattern = (opts.cryptByteBlock << 4) | opts.skipByteBlock;
	const head = [
		0, // reserved
		pattern, // reserved (0) for v0; crypt<<4|skip for v1
		1, // default_is_protected
	];
	if (opts.constantIv !== undefined) {
		return fullBox('tenc', version, 0, [
			...head,
			0, // default_per_sample_iv_size (0 → constant IV follows)
			[...opts.kid],
			opts.constantIv.length, // default_constant_iv_size
			[...opts.constantIv],
		]);
	}
	return fullBox('tenc', version, 0, [
		...head,
		opts.perSampleIvSize ?? 0, // default_per_sample_iv_size (no constant IV follows)
		[...opts.kid],
	]);
};

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

/** The byte size of one `senc` entry (used to fill `saiz`). Constant IV → no IV bytes. */
export const sencEntrySize = (subsamples: SubsampleEntry[], perSampleIvSize: number): number =>
	perSampleIvSize + 2 + subsamples.length * 6;

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
