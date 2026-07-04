/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Box } from '../isobmff/isobmff-boxes';
import { saiz, senc, sencEntrySize, sinf, tenc } from './encryption-boxes';
import { SampleEncryptor } from './sample-encryptor';
import type {
	EncryptionStreamInfo,
	ProtectionScheme,
	SubsampleEntry,
	VideoSliceHeaderParser,
} from './subsample-generator';

/** Whether a scheme carries a per-sample IV (cenc/cens) or a single constant IV (cbcs). */
const usesPerSampleIv = (scheme: ProtectionScheme): boolean => scheme === 'cenc' || scheme === 'cens';

/** The cbcs-encrypted samples of one CMAF fragment plus the boxes describing them. */
export type EncryptedFragment = {
	/** Each sample encrypted in place (same length as its input). */
	encryptedSamples: Uint8Array[];
	/** Clear/cipher subsample ranges per sample. */
	subsamplesPerSample: SubsampleEntry[][];
	/** The `senc` box (constant IV → subsamples only; per-sample IV → IV + subsamples). */
	sencBox: Box;
	/** The `saiz` box (size of each `senc` entry). */
	saizBox: Box;
};

/**
 * Encrypt every sample of one CMAF track fragment with a CENC scheme. The caller splices the
 * returned `senc`/`saiz` (+ a `saio`) into the `traf` and swaps the mdat sample bytes for
 * {@link EncryptedFragment.encryptedSamples}. Defaults to `cbcs` (single constant IV).
 */
export const encryptFragment = (opts: {
	samples: Uint8Array[];
	streamInfo: EncryptionStreamInfo;
	streamType: 'video' | 'audio';
	key: Uint8Array;
	/** Initial IV (8 or 16 bytes): the constant IV for cbcs, the first per-sample IV for cenc/cens. */
	iv: Uint8Array;
	scheme?: ProtectionScheme;
	cryptByteBlock?: number;
	skipByteBlock?: number;
	/** Override the video slice-header parser (tests inject a mock). */
	videoSliceHeaderParser?: VideoSliceHeaderParser;
}): EncryptedFragment => {
	const scheme = opts.scheme ?? 'cbcs';
	const encryptor = new SampleEncryptor({
		streamInfo: opts.streamInfo,
		streamType: opts.streamType,
		scheme,
		key: opts.key,
		iv: opts.iv,
		cryptByteBlock: opts.cryptByteBlock,
		skipByteBlock: opts.skipByteBlock,
		videoSliceHeaderParser: opts.videoSliceHeaderParser,
	});

	const encryptedSamples: Uint8Array[] = [];
	const subsamplesPerSample: SubsampleEntry[][] = [];
	const perSampleIvs: Uint8Array[] = [];
	for (const sample of opts.samples) {
		const encrypted = encryptor.encryptSample(sample);
		encryptedSamples.push(encrypted.data);
		subsamplesPerSample.push(encrypted.subsamples);
		perSampleIvs.push(encrypted.iv);
	}

	const perSample = usesPerSampleIv(scheme);
	const ivSize = perSample ? opts.iv.length : 0;
	return {
		encryptedSamples,
		subsamplesPerSample,
		sencBox: senc(subsamplesPerSample, perSample ? perSampleIvs : undefined),
		saizBox: saiz(subsamplesPerSample.map(subsamples => sencEntrySize(subsamples, ivSize))),
	};
};

/**
 * Build the `sinf` protection box for an encrypted sample entry (added when the entry's
 * codingname is changed to `encv`/`enca` in the init segment). cbcs carries a constant IV in
 * `tenc`; cenc/cens declare a per-sample IV size instead.
 */
export const buildProtectionSinf = (opts: {
	originalFormat: string;
	scheme: ProtectionScheme;
	kid: Uint8Array;
	cryptByteBlock: number;
	skipByteBlock: number;
	iv: Uint8Array;
}): Box => sinf(
	opts.originalFormat,
	opts.scheme,
	tenc(usesPerSampleIv(opts.scheme)
		? {
				kid: opts.kid,
				cryptByteBlock: opts.cryptByteBlock,
				skipByteBlock: opts.skipByteBlock,
				perSampleIvSize: opts.iv.length,
			}
		: {
				kid: opts.kid,
				cryptByteBlock: opts.cryptByteBlock,
				skipByteBlock: opts.skipByteBlock,
				constantIv: opts.iv,
			}),
);
