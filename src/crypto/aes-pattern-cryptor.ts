/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/media/base/aes_pattern_cryptor.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { AES_128_BLOCK_SIZE } from '../aes';
import type { BlockCryptor } from './aes-cbc-encryptor';

/**
 * Behaviour for the trailing (partial-pattern) blocks. Mirrors shaka's
 * `AesPatternCryptor::PatternEncryptionMode`.
 * @internal
 */
export type PatternEncryptionMode =
	// Encrypt all remaining full 16-byte blocks even if fewer than crypt_byte_block remain.
	| 'encryptIfCryptByteBlockRemaining'
	// Leave the remaining blocks unencrypted (HLS SAMPLE-AES). Skip if ≤ crypt_byte_block remain.
	| 'skipIfCryptByteBlockRemaining';

/**
 * Pattern-based (cbcs / cbcs-like) encryption: encrypts `cryptByteBlock` 16-byte
 * blocks, skips `skipByteBlock` blocks, and repeats. The underlying {@link BlockCryptor}
 * only ever sees the encrypted blocks, so cipher chaining spans them alone — the cbcs
 * invariant. Mirrors shaka-packager's `AesPatternCryptor`.
 * @internal
 */
export class AesPatternCryptor {
	/** @internal */
	private cryptByteBlock: number;
	/** @internal */
	private readonly skipByteBlock: number;
	/** @internal */
	private readonly encryptionMode: PatternEncryptionMode;
	/** @internal */
	private readonly cryptor: BlockCryptor;
	/**
	 * When true (cbcs), each `crypt` call restarts from the stored IV — every subsample's
	 * protected data begins at the sample IV. Mirrors shaka's `kUseConstantIv`.
	 * @internal
	 */
	private readonly useConstantIv: boolean;
	/** @internal */
	private iv: Uint8Array = new Uint8Array(16);

	constructor(
		cryptByteBlock: number,
		skipByteBlock: number,
		encryptionMode: PatternEncryptionMode,
		useConstantIv: boolean,
		cryptor: BlockCryptor,
	) {
		// Treat pattern 0:0 as 1:0.
		if (cryptByteBlock === 0 && skipByteBlock === 0) {
			cryptByteBlock = 1;
		}
		this.cryptByteBlock = cryptByteBlock;
		this.skipByteBlock = skipByteBlock;
		this.encryptionMode = encryptionMode;
		this.useConstantIv = useConstantIv;
		this.cryptor = cryptor;
	}

	initializeWithIv(key: Uint8Array, iv: Uint8Array): void {
		this.iv = iv;
		this.cryptor.initializeWithIv(key, iv);
	}

	setIv(iv: Uint8Array): void {
		this.iv = iv;
		this.cryptor.setIv(iv);
	}

	/** The underlying cipher's current IV (recorded per-sample in `senc` for per-sample-IV schemes). */
	getIv(): Uint8Array {
		return this.cryptor.getIv();
	}

	/** Advance the underlying cipher's IV for the next sample (no-op under a constant IV). */
	updateIv(): void {
		this.cryptor.updateIv();
		this.iv = this.cryptor.getIv();
	}

	/** Apply pattern encryption over `text`, returning a new same-sized buffer. */
	crypt(text: Uint8Array): Uint8Array {
		// With a constant IV, each call restarts from the stored sample IV.
		if (this.useConstantIv) {
			this.cryptor.setIv(this.iv);
		}
		// Skipped ranges stay verbatim, so start from a copy and only encrypt the crypt ranges.
		const cryptText = new Uint8Array(text);
		let offset = 0;
		let remaining = cryptText.length;

		while (remaining > 0) {
			const cryptByteSize = this.cryptByteBlock * AES_128_BLOCK_SIZE;

			if (remaining <= cryptByteSize) {
				const needEncrypt = this.encryptionMode !== 'skipIfCryptByteBlockRemaining'
					&& remaining >= AES_128_BLOCK_SIZE;
				if (needEncrypt) {
					// The partial pattern's full blocks are encrypted; a trailing partial block stays clear.
					const alignedCryptByteSize = Math.floor(remaining / AES_128_BLOCK_SIZE) * AES_128_BLOCK_SIZE;
					this.cryptor.crypt(cryptText.subarray(offset, offset + alignedCryptByteSize));
					offset += alignedCryptByteSize;
					remaining -= alignedCryptByteSize;
				}
				return cryptText;
			}

			this.cryptor.crypt(cryptText.subarray(offset, offset + cryptByteSize));
			offset += cryptByteSize;
			remaining -= cryptByteSize;

			// The skipped blocks are left unencrypted.
			const skipByteSize = Math.min(this.skipByteBlock * AES_128_BLOCK_SIZE, remaining);
			offset += skipByteSize;
			remaining -= skipByteSize;
		}
		return cryptText;
	}
}
