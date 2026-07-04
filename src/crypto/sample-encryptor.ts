/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AesCbcEncryptor } from './aes-cbc-encryptor';
import { AesCtrEncryptor } from './aes-ctr-encryptor';
import { AesPatternCryptor } from './aes-pattern-cryptor';
import { H264VideoSliceHeaderParser } from './h264-slice-header-parser';
import { H265VideoSliceHeaderParser } from './h265-slice-header-parser';
import {
	type EncryptionStreamInfo,
	type ProtectionScheme,
	SubsampleGenerator,
	type SubsampleEntry,
	type VideoSliceHeaderParser,
} from './subsample-generator';

/** The result of encrypting one sample: the ciphertext plus its `senc` info. */
export type EncryptedSample = {
	/** The encrypted sample bytes (same length as the input). */
	data: Uint8Array;
	/** Clear/cipher byte ranges (empty for full-sample encryption). Written to `senc`/`saiz`. */
	subsamples: SubsampleEntry[];
	/** The initialization vector used for this sample. Constant across samples for cbcs. */
	iv: Uint8Array;
};

/** The default cbcs pattern per CENC v3: encrypt 1 block, skip 9. */
const DEFAULT_CRYPT_BYTE_BLOCK = 1;
const DEFAULT_SKIP_BYTE_BLOCK = 9;

/** A per-sample cipher: transforms a cipher region and advances its IV between samples. */
type SampleCipher = {
	getIv(): Uint8Array;
	updateIv(): void;
	cryptRegion(region: Uint8Array): Uint8Array;
};

/**
 * Encrypts the samples of a single CMAF track using a CENC protection scheme. NAL/slice headers
 * of video stay clear (pattern encryption of the slice payload for cbcs/cens, block-aligned
 * subsample encryption for cenc), while audio is whole-block full-sample encrypted. cbcs uses a
 * constant IV; cenc/cens use a per-sample IV that advances after each sample. Mirrors
 * shaka-packager's `EncryptionHandler`/`AesEncryptorFactory`.
 */
export class SampleEncryptor {
	/** @internal */
	private readonly generator: SubsampleGenerator;
	/** @internal */
	private readonly cipher: SampleCipher;

	constructor(opts: {
		streamInfo: EncryptionStreamInfo;
		streamType: 'video' | 'audio';
		scheme: ProtectionScheme;
		key: Uint8Array;
		/** Initial IV — constant for cbcs, the first per-sample IV for cenc/cens. */
		iv: Uint8Array;
		/** cbcs/cens crypt-byte-block (video only). Defaults to 1. */
		cryptByteBlock?: number;
		/** cbcs/cens skip-byte-block (video only). Defaults to 9. */
		skipByteBlock?: number;
		/** Override the video slice-header parser (tests inject a mock). */
		videoSliceHeaderParser?: VideoSliceHeaderParser;
	}) {
		// VP9 defaults to subsample encryption (shaka's `vp9_subsample_encryption`); other codecs ignore it.
		this.generator = new SubsampleGenerator(opts.streamInfo.codec === 'vp9', false);
		this.generator.initialize(opts.scheme, opts.streamInfo);

		const parser = opts.videoSliceHeaderParser ?? this.createParser(opts.streamInfo);
		if (parser !== null) {
			this.generator.setVideoSliceHeaderParser(parser);
		}

		this.cipher = this.createCipher(opts);
	}

	/** Encrypt one sample, returning its ciphertext, subsamples and the IV that was used. */
	encryptSample(data: Uint8Array): EncryptedSample {
		const subsamples = this.generator.generateSubsamples(data);
		const iv = new Uint8Array(this.cipher.getIv());

		const out = new Uint8Array(data);
		if (subsamples.length === 0) {
			out.set(this.cipher.cryptRegion(out));
		} else {
			let offset = 0;
			for (const { clearBytes, cipherBytes } of subsamples) {
				offset += clearBytes;
				if (cipherBytes > 0) {
					out.set(this.cipher.cryptRegion(out.subarray(offset, offset + cipherBytes)), offset);
					offset += cipherBytes;
				}
			}
		}

		this.cipher.updateIv();
		return { data: out, subsamples, iv };
	}

	/** @internal */
	private createCipher(opts: {
		streamType: 'video' | 'audio';
		streamInfo: EncryptionStreamInfo;
		scheme: ProtectionScheme;
		key: Uint8Array;
		iv: Uint8Array;
		cryptByteBlock?: number;
		skipByteBlock?: number;
	}): SampleCipher {
		// Video and AC-4 use pattern encryption in a pattern scheme; other audio uses whole-block
		// full-sample encryption. Mirrors shaka's `EncryptionHandler::SetupProtectionPattern`.
		const usesPattern = opts.streamType === 'video' || opts.streamInfo.codec === 'ac4';
		const cryptByteBlock = usesPattern ? (opts.cryptByteBlock ?? DEFAULT_CRYPT_BYTE_BLOCK) : 1;
		const skipByteBlock = usesPattern ? (opts.skipByteBlock ?? DEFAULT_SKIP_BYTE_BLOCK) : 0;

		if (opts.scheme === 'cenc') {
			// cenc: block-aligned subsample encryption with AES-CTR (no pattern), per-sample IV.
			const ctr = new AesCtrEncryptor();
			ctr.initializeWithIv(opts.key, opts.iv);
			return {
				getIv: () => ctr.getIv(),
				updateIv: () => ctr.updateIv(),
				cryptRegion: (region) => {
					const copy = new Uint8Array(region);
					ctr.crypt(copy);
					return copy;
				},
			};
		}

		if (opts.scheme === 'cbc1') {
			// cbc1: block-aligned subsample encryption with AES-CBC (no pattern), per-sample IV.
			const cbc = new AesCbcEncryptor(false);
			cbc.initializeWithIv(opts.key, opts.iv);
			return {
				getIv: () => cbc.getIv(),
				updateIv: () => cbc.updateIv(),
				cryptRegion: (region) => {
					const copy = new Uint8Array(region);
					cbc.crypt(copy);
					return copy;
				},
			};
		}

		// cbcs: pattern over AES-CBC with a constant IV. cens: pattern over AES-CTR, per-sample IV.
		const pattern = new AesPatternCryptor(
			cryptByteBlock,
			skipByteBlock,
			'encryptIfCryptByteBlockRemaining',
			opts.scheme === 'cbcs',
			opts.scheme === 'cbcs' ? new AesCbcEncryptor() : new AesCtrEncryptor(),
		);
		pattern.initializeWithIv(opts.key, opts.iv);
		return {
			getIv: () => pattern.getIv(),
			updateIv: () => pattern.updateIv(),
			cryptRegion: region => pattern.crypt(region),
		};
	}

	/** @internal */
	private createParser(streamInfo: EncryptionStreamInfo): VideoSliceHeaderParser | null {
		if (streamInfo.codec === 'avc') {
			const parser = new H264VideoSliceHeaderParser();
			parser.initialize(streamInfo.codecConfig);
			return parser;
		}
		if (streamInfo.codec === 'hevc') {
			const parser = new H265VideoSliceHeaderParser();
			parser.initialize(streamInfo.codecConfig);
			return parser;
		}
		return null;
	}
}
