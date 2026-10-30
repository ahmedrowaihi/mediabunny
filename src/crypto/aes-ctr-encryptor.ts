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
import * as nodeAlias from '../node';
import { advanceCencIv, type BlockCryptor } from './aes-cbc-encryptor';

const node = typeof nodeAlias !== 'undefined'
	? nodeAlias // Aliasing it prevents some bundler warnings
	: undefined!;

// crypt() runs in browsers, unlike the other Node-only paths here, and what stands in for this
// module there varies: bundlers stub it to an empty module, but Vite serves a shim whose `crypto`
// is a real object without the ciphers. Only the function itself is worth testing for.
const nativeCrypto: typeof nodeAlias.crypto | undefined
	= typeof node?.crypto?.createCipheriv === 'function' ? node.crypto : undefined;

const ZERO_IV = new Uint8Array(AES_128_BLOCK_SIZE);

/**
 * Below this, a native cipher costs more than the JS keystream it replaces — both to construct and
 * to call, since `update()` allocates its output and crosses into C++. Tuned by timing cenc at
 * 1024/512/256/128 across renditions: 256 is the knee, ~20% ahead of 1024 on low-bytes-per-frame
 * content and level on high-bitrate, with 128 regressing on both. This test is load-bearing and
 * cannot be amortised away by holding one cipher per IV epoch; FORK.md records that measurement.
 */
const NATIVE_CRYPT_THRESHOLD = 256;

const LOW_64_LIMIT = 1n << 64n;

/** The low 64 bits of the counter block, which is the part CENC increments. */
const low64 = (counter: Uint8Array): bigint => {
	let value = 0n;
	for (let i = 8; i < AES_128_BLOCK_SIZE; i++) {
		value = (value << 8n) | BigInt(counter[i]!);
	}
	return value;
};

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
	private key: Uint8Array | null = null;
	private iv = new Uint8Array(AES_128_BLOCK_SIZE);
	private readonly counter = new Uint8Array(AES_128_BLOCK_SIZE);
	private readonly encryptedCounter = new Uint8Array(AES_128_BLOCK_SIZE);
	private blockOffset = 0;
	private numCryptBytes = 0;

	initializeWithIv(key: Uint8Array, iv: Uint8Array): void {
		this.context.init({ key, iv: ZERO_IV });
		this.key = key;
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
		advanceCencIv(this.iv, this.numCryptBytes);
		this.resetCounter();
	}

	crypt(text: Uint8Array): void {
		if (this.cryptNative(text)) {
			return;
		}

		// Run block-at-a-time rather than byte-at-a-time: the keystream only changes on a block
		// boundary, so the per-byte branch and modulo cost as much as the AES they fed.
		let blockOffset = this.blockOffset;
		for (let i = 0; i < text.length;) {
			if (blockOffset === 0) {
				this.encryptCounter();
				increment64(this.counter);
			}
			const run = Math.min(AES_128_BLOCK_SIZE - blockOffset, text.length - i);
			for (let j = 0; j < run; j++) {
				text[i + j]! ^= this.encryptedCounter[blockOffset + j]!;
			}
			i += run;
			blockOffset = (blockOffset + run) % AES_128_BLOCK_SIZE;
		}
		this.blockOffset = blockOffset;
		this.numCryptBytes += text.length;
	}

	/**
	 * Node's AES-CTR for whole-block runs starting on a block boundary, which is where the bytes
	 * are. Returns false when the run does not qualify and the JS keystream has to handle it:
	 * mid-block starts and partial trailing blocks would leave keystream state to carry, and
	 * Node carries into the high 64 bits of the counter where CENC wraps within the low 64.
	 */
	private cryptNative(text: Uint8Array): boolean {
		if (
			nativeCrypto === undefined
			|| this.key === null
			|| this.blockOffset !== 0
			|| text.length < NATIVE_CRYPT_THRESHOLD
			|| text.length % AES_128_BLOCK_SIZE !== 0
		) {
			return false;
		}

		const blocks = BigInt(text.length / AES_128_BLOCK_SIZE);
		if (low64(this.counter) + blocks >= LOW_64_LIMIT) {
			return false;
		}

		const cipher = nativeCrypto.createCipheriv('aes-128-ctr', this.key, this.counter);
		text.set(cipher.update(text));

		let advanced = low64(this.counter) + blocks;
		for (let i = AES_128_BLOCK_SIZE - 1; i >= 8; i--) {
			this.counter[i] = Number(advanced & 0xffn);
			advanced >>= 8n;
		}
		this.numCryptBytes += text.length;
		return true;
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
