/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SHA-1 by hand, because a packing list's hashes have to be checked without reading a track file
// into memory. `crypto.subtle.digest` takes one buffer and has no incremental form, and an IMF track
// file is routinely tens of gigabytes, so the only way to use it would be to hold the whole asset at
// once. This keeps a 64-octet block and five words.
//
// SHA-1 is broken for signatures and fine here: a packing list states what a delivery contained, so
// this answers "did these octets arrive intact", not "did an adversary substitute them". The format
// names the algorithm and we do not get to pick it.

/** @internal */
export const SHA1_DIGEST_SIZE = 20;

const BLOCK_SIZE = 64;

/**
 * Incremental SHA-1. Feed it any sized chunks; the block boundary is kept across calls.
 *
 * @internal
 */
export class Sha1 {
	private h0 = 0x67452301;
	private h1 = 0xefcdab89;
	private h2 = 0x98badcfe;
	private h3 = 0x10325476;
	private h4 = 0xc3d2e1f0;

	private block = new Uint8Array(BLOCK_SIZE);
	private blockLength = 0;
	private totalLength = 0;
	private words = new Uint32Array(80);
	private finished = false;

	update(data: Uint8Array) {
		if (this.finished) {
			throw new Error('SHA-1: update after digest.');
		}

		this.totalLength += data.length;
		let offset = 0;

		// Top up a partial block first, so a caller's chunking cannot change the result
		if (this.blockLength > 0) {
			const wanted = Math.min(BLOCK_SIZE - this.blockLength, data.length);
			this.block.set(data.subarray(0, wanted), this.blockLength);
			this.blockLength += wanted;
			offset = wanted;

			if (this.blockLength < BLOCK_SIZE) {
				return;
			}

			this.compress(this.block, 0);
			this.blockLength = 0;
		}

		while (offset + BLOCK_SIZE <= data.length) {
			this.compress(data, offset);
			offset += BLOCK_SIZE;
		}

		if (offset < data.length) {
			this.block.set(data.subarray(offset), 0);
			this.blockLength = data.length - offset;
		}
	}

	digest(): Uint8Array {
		if (this.finished) {
			throw new Error('SHA-1: digest called twice.');
		}
		this.finished = true;

		// 0x80, then zeroes, then the length in BITS as a 64-bit big-endian count. The length has to
		// land in the last 8 octets of a block, so a message that leaves more than 55 octets in its
		// final block needs one extra block.
		const bitLength = this.totalLength * 8;
		const padded = new Uint8Array(this.blockLength <= 55 ? BLOCK_SIZE : BLOCK_SIZE * 2);
		padded.set(this.block.subarray(0, this.blockLength), 0);
		padded[this.blockLength] = 0x80;

		const view = new DataView(padded.buffer);
		// Two 32-bit halves rather than a BigInt: the high half only matters above 2^32 bits, i.e.
		// 512 MB, which track files exceed
		view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
		view.setUint32(padded.length - 4, bitLength >>> 0, false);

		for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
			this.compress(padded, offset);
		}

		const out = new Uint8Array(SHA1_DIGEST_SIZE);
		const outView = new DataView(out.buffer);
		outView.setUint32(0, this.h0 >>> 0, false);
		outView.setUint32(4, this.h1 >>> 0, false);
		outView.setUint32(8, this.h2 >>> 0, false);
		outView.setUint32(12, this.h3 >>> 0, false);
		outView.setUint32(16, this.h4 >>> 0, false);
		return out;
	}

	private compress(data: Uint8Array, offset: number) {
		const w = this.words;

		for (let i = 0; i < 16; i++) {
			const at = offset + i * 4;
			w[i] = (data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!;
		}
		for (let i = 16; i < 80; i++) {
			const mixed = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
			w[i] = (mixed << 1) | (mixed >>> 31);
		}

		let a = this.h0;
		let b = this.h1;
		let c = this.h2;
		let d = this.h3;
		let e = this.h4;

		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}

			const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
			e = d;
			d = c;
			c = (b << 30) | (b >>> 2);
			b = a;
			a = temp;
		}

		this.h0 = (this.h0 + a) | 0;
		this.h1 = (this.h1 + b) | 0;
		this.h2 = (this.h2 + c) | 0;
		this.h3 = (this.h3 + d) | 0;
		this.h4 = (this.h4 + e) | 0;
	}
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 without `btoa`, which takes a string and would need the bytes laundered through one first.
 *
 * @internal
 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
	let out = '';

	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i]!;
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];

		out += BASE64_ALPHABET[b0 >> 2];
		out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
		out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
		out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
	}

	return out;
};
