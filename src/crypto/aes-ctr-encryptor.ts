/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/media/base/aes_encryptor.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { AES_128_BLOCK_SIZE, Aes128CbcContext } from '../aes';
import type { BlockCryptor } from './aes-cbc-encryptor';

const ZERO_IV = new Uint8Array(AES_128_BLOCK_SIZE);

// Increment the least-significant 8 bytes of the 16-byte counter block (network byte order),
// as specified in ISO/IEC 23001-7 for CTR mode.
const increment64 = (counter: Uint8Array): void => {
	for (let i = AES_128_BLOCK_SIZE - 1; i >= 8; i--) {
		counter[i] = (counter[i]! + 1) & 0xff;
		if (counter[i] !== 0) {
			return;
		}
	}
};

/**
 * AES-128-CTR counter-mode cipher (encrypt == decrypt). The keystream is `AES(counter)` XORed
 * with the data; the low 64 bits of the counter increment per block. Never uses a constant IV —
 * {@link updateIv} advances the per-sample IV. Mirrors shaka-packager's `AesCtrEncryptor`
 * (which `AesCtrDecryptor` aliases). Backed by the fork's {@link Aes128CbcContext} run as a raw
 * block cipher (zero IV) to encrypt the counter.
 * @internal
 */
export class AesCtrEncryptor implements BlockCryptor {
	private readonly context = new Aes128CbcContext();
	private iv = new Uint8Array(AES_128_BLOCK_SIZE);
	private readonly counter = new Uint8Array(AES_128_BLOCK_SIZE);
	private readonly encryptedCounter = new Uint8Array(AES_128_BLOCK_SIZE);
	private blockOffset = 0;
	private numCryptBytes = 0;

	initializeWithIv(key: Uint8Array, iv: Uint8Array): void {
		this.context.init({ key, iv: ZERO_IV });
		this.setIv(iv);
	}

	setIv(iv: Uint8Array): void {
		this.iv = new Uint8Array(iv);
		this.resetCounter();
	}

	getIv(): Uint8Array {
		return this.iv;
	}

	updateIv(): void {
		// 8-byte IV: increment by 1. 16-byte IV: add the block count of the last sample.
		let increment = this.iv.length === 8 ? 1 : Math.ceil(this.numCryptBytes / AES_128_BLOCK_SIZE);
		for (let i = this.iv.length - 1; increment > 0 && i >= 0; i--) {
			increment += this.iv[i]!;
			this.iv[i] = increment & 0xff;
			increment = Math.floor(increment / 256);
		}
		this.resetCounter();
	}

	crypt(text: Uint8Array): void {
		for (let i = 0; i < text.length; i++) {
			if (this.blockOffset === 0) {
				this.encryptCounter();
				increment64(this.counter);
			}
			text[i]! ^= this.encryptedCounter[this.blockOffset]!;
			this.blockOffset = (this.blockOffset + 1) % AES_128_BLOCK_SIZE;
		}
		this.numCryptBytes += text.length;
	}

	private resetCounter(): void {
		this.blockOffset = 0;
		this.numCryptBytes = 0;
		this.counter.fill(0);
		this.counter.set(this.iv.subarray(0, AES_128_BLOCK_SIZE));
	}

	private encryptCounter(): void {
		this.context.setIv(ZERO_IV); // zero IV → the CBC context computes a raw AES block.
		this.context.in.set(this.counter);
		this.context.encrypt();
		this.encryptedCounter.set(this.context.out);
	}
}
