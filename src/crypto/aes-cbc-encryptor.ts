/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AES_128_BLOCK_SIZE, Aes128CbcContext } from '../aes';

/**
 * A block cryptor that transforms the full 16-byte blocks of a buffer in place,
 * chaining cipher state across calls. Consumed by {@link AesPatternCryptor} so the
 * pattern (cbcs) logic can be tested independently of the underlying cipher.
 * @internal
 */
export type BlockCryptor = {
	/** (Re)initialize the cryptor with a key and IV. */
	initializeWithIv(key: Uint8Array, iv: Uint8Array): void;
	/** Reset the IV between samples without re-deriving the key schedule. */
	setIv(iv: Uint8Array): void;
	/** The current IV (base IV for CTR). Recorded per-sample in `senc` when per-sample IVs are used. */
	getIv(): Uint8Array;
	/**
	 * Advance the IV for the next sample. A no-op under a constant IV (cbcs); CTR increments per
	 * the CENC spec (8-byte IV: +1; 16-byte IV: + block count of the last sample).
	 */
	updateIv(): void;
	/** Encrypt the whole-block portion of `text` in place, chaining state across calls. */
	crypt(text: Uint8Array): void;
};

/**
 * AES-128-CBC encryptor with no padding: encrypts the full 16-byte blocks of the
 * input in place (chaining the cipher block state across `crypt` calls) and leaves
 * any trailing partial block untouched. Equivalent to shaka-packager's
 * `AesCbcEncryptor(kNoPadding)`, backed by the fork's own {@link Aes128CbcContext}.
 * @internal
 */
export class AesCbcEncryptor implements BlockCryptor {
	private readonly context = new Aes128CbcContext();
	private iv = new Uint8Array(AES_128_BLOCK_SIZE);

	initializeWithIv(key: Uint8Array, iv: Uint8Array): void {
		// init() needs a 16-byte IV for the key schedule; seed with zeros then set the real IV.
		this.context.init({ key, iv: new Uint8Array(AES_128_BLOCK_SIZE) });
		this.setIv(iv);
	}

	setIv(iv: Uint8Array): void {
		this.iv = new Uint8Array(iv);
		this.context.setIv(iv);
	}

	getIv(): Uint8Array {
		return this.iv;
	}

	updateIv(): void {}

	crypt(text: Uint8Array): void {
		const fullBlocks = Math.floor(text.length / AES_128_BLOCK_SIZE);
		for (let i = 0; i < fullBlocks; i++) {
			const offset = i * AES_128_BLOCK_SIZE;
			this.context.in.set(text.subarray(offset, offset + AES_128_BLOCK_SIZE));
			this.context.encrypt();
			text.set(this.context.out, offset);
		}
	}
}

/**
 * AES-128-CBC decryptor with no padding — the inverse of {@link AesCbcEncryptor}. Used to
 * verify (round-trip) encryption output. Decrypts the full 16-byte blocks in place, leaving
 * any trailing partial block untouched.
 * @internal
 */
export class AesCbcDecryptor implements BlockCryptor {
	private readonly context = new Aes128CbcContext();
	private iv = new Uint8Array(AES_128_BLOCK_SIZE);

	initializeWithIv(key: Uint8Array, iv: Uint8Array): void {
		this.context.init({ key, iv: new Uint8Array(AES_128_BLOCK_SIZE) });
		this.setIv(iv);
	}

	setIv(iv: Uint8Array): void {
		this.iv = new Uint8Array(iv);
		this.context.setIv(iv);
	}

	getIv(): Uint8Array {
		return this.iv;
	}

	updateIv(): void {}

	crypt(text: Uint8Array): void {
		const fullBlocks = Math.floor(text.length / AES_128_BLOCK_SIZE);
		for (let i = 0; i < fullBlocks; i++) {
			const offset = i * AES_128_BLOCK_SIZE;
			this.context.in.set(text.subarray(offset, offset + AES_128_BLOCK_SIZE));
			this.context.decrypt();
			text.set(this.context.out, offset);
		}
	}
}
