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
	cryptRegion(region: Uint8Array): void;
};

type CipherOptions = {
	streamType: 'video' | 'audio';
	streamInfo: EncryptionStreamInfo;
	scheme: ProtectionScheme;
	key: Uint8Array;
	iv: Uint8Array;
	cryptByteBlock?: number;
	skipByteBlock?: number;
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
	private cipher: SampleCipher;
	/** @internal */
	private readonly cipherOptions: CipherOptions;

	constructor(options: {
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
		this.generator = new SubsampleGenerator(options.streamInfo.codec === 'vp9', false);
		this.generator.initialize(options.scheme, options.streamInfo);

		const parser = options.videoSliceHeaderParser ?? this.createParser(options.streamInfo);
		if (parser !== null) {
			this.generator.setVideoSliceHeaderParser(parser);
		}

		this.cipherOptions = {
			streamType: options.streamType,
			streamInfo: options.streamInfo,
			scheme: options.scheme,
			key: options.key,
			iv: options.iv,
			cryptByteBlock: options.cryptByteBlock,
			skipByteBlock: options.skipByteBlock,
		};
		this.cipher = this.createCipher(this.cipherOptions);
	}

	/** Encrypt one sample, returning its ciphertext, subsamples and the IV that was used. */
	encryptSample(data: Uint8Array): EncryptedSample {
		const subsamples = this.generator.generateSubsamples(data);
		const iv = new Uint8Array(this.cipher.getIv());

		const out = new Uint8Array(data);
		if (subsamples.length === 0) {
			this.cipher.cryptRegion(out);
		} else {
			let offset = 0;
			for (const { clearBytes, cipherBytes } of subsamples) {
				offset += clearBytes;
				if (cipherBytes > 0) {
					this.cipher.cryptRegion(out.subarray(offset, offset + cipherBytes));
					offset += cipherBytes;
				}
			}
		}

		this.cipher.updateIv();
		return { data: out, subsamples, iv };
	}

	/**
	 * The IV the next {@link encryptSample} will use. Carry it into the encryptor of the following
	 * segment so the per-sample IV sequence continues instead of repeating the keystream.
	 */
	nextIv(): Uint8Array {
		return new Uint8Array(this.cipher.getIv());
	}

	/**
	 * Switch to `key` for every sample from here on — call it at a key-period boundary, between two
	 * {@link encryptSample} calls. The IV sequence carries across the switch instead of restarting, so
	 * a period that reuses an earlier period's key still never reuses its keystream.
	 */
	useKey(key: Uint8Array): void {
		this.cipher = this.createCipher({ ...this.cipherOptions, key, iv: new Uint8Array(this.cipher.getIv()) });
	}

	/** @internal */
	private createCipher(options: CipherOptions): SampleCipher {
		// Video and AC-4 use pattern encryption in a pattern scheme; other audio uses whole-block
		// full-sample encryption. Mirrors shaka's `EncryptionHandler::SetupProtectionPattern`.
		const usesPattern = options.streamType === 'video' || options.streamInfo.codec === 'ac4';
		const cryptByteBlock = usesPattern ? (options.cryptByteBlock ?? DEFAULT_CRYPT_BYTE_BLOCK) : 1;
		const skipByteBlock = usesPattern ? (options.skipByteBlock ?? DEFAULT_SKIP_BYTE_BLOCK) : 0;

		// A pattern scheme applied to a track that takes no pattern is just its base cipher. For cens
		// that base is AES-CTR, which needs no block alignment — routing it through the pattern cryptor
		// instead would leave the sample's trailing partial block in the clear, and a reader doing
		// plain CTR would decrypt those bytes into noise.
		if (options.scheme === 'cenc' || (options.scheme === 'cens' && skipByteBlock === 0)) {
			const ctr = new AesCtrEncryptor();
			ctr.initializeWithIv(options.key, options.iv);
			return {
				getIv: () => ctr.getIv(),
				updateIv: () => ctr.updateIv(),
				cryptRegion: region => ctr.crypt(region),
			};
		}

		if (options.scheme === 'cbc1') {
			// cbc1: block-aligned subsample encryption with AES-CBC (no pattern), per-sample IV.
			const cbc = new AesCbcEncryptor(false);
			cbc.initializeWithIv(options.key, options.iv);
			return {
				getIv: () => cbc.getIv(),
				updateIv: () => cbc.updateIv(),
				cryptRegion: region => cbc.crypt(region),
			};
		}

		// cbcs: pattern over AES-CBC with a constant IV. cens: pattern over AES-CTR, per-sample IV.
		const pattern = new AesPatternCryptor(
			cryptByteBlock,
			skipByteBlock,
			'encryptIfCryptByteBlockRemaining',
			options.scheme === 'cbcs',
			options.scheme === 'cbcs' ? new AesCbcEncryptor() : new AesCtrEncryptor(),
		);
		pattern.initializeWithIv(options.key, options.iv);
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
