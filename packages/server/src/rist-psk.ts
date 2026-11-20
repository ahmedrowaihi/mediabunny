/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

/** librist's `RIST_PBKDF2_HMAC_SHA256_ITERATIONS`. Both ends must agree, so this is not a knob. */
const PBKDF2_ITERATIONS = 1024;
const NONCE_SIZE = 4;
const IV_SIZE = 16;

/** @internal */
export type RistKey = {
	/** The 4 bytes that ride the GRE header and salt the key, so a receiver can derive the same one. */
	nonce: Uint8Array;
	aesKey: Buffer;
	bits: 128 | 192 | 256;
};

/**
 * A nonce with the even/odd key bit of TR-06-2 set as asked. librist reads bit 7 of the first byte to
 * pick between its two keys, so a nonce that sets it by accident selects the wrong one.
 *
 * @internal
 */
export const newNonce = (odd = false): Uint8Array => {
	const nonce = new Uint8Array(randomBytes(NONCE_SIZE));
	// A zero nonce is refused outright by librist, and would also make the key derivable
	if (nonce.every(byte => byte === 0)) {
		nonce[0] = 1;
	}
	nonce[0] = odd ? nonce[0]! | 0x80 : nonce[0]! & 0x7f;
	return nonce;
};

/** @internal */
export const isOddNonce = (nonce: Uint8Array) => (nonce[0]! & 0x80) !== 0;

/** @internal */
export const deriveKey = (passphrase: string, nonce: Uint8Array, bits: 128 | 192 | 256): RistKey => ({
	nonce: nonce.slice(),
	aesKey: pbkdf2Sync(passphrase, Buffer.from(nonce), PBKDF2_ITERATIONS, bits / 8, 'sha256'),
	bits,
});

/**
 * AES-CTR over one datagram's payload, keyed by {@link deriveKey} and counted from the GRE sequence
 * number. CTR is its own inverse, so this both encrypts and decrypts.
 *
 * @internal
 */
export const cryptPayload = (key: RistKey, greSeq: number, payload: Uint8Array): Uint8Array => {
	// The sequence is the IV's high word and the counter runs in the low bytes, so each datagram starts
	// a fresh keystream and a 1316-byte payload cannot reach the next one's
	const iv = Buffer.alloc(IV_SIZE);
	iv.writeUInt32BE(greSeq >>> 0, 0);

	const cipher = createCipheriv(`aes-${key.bits}-ctr`, key.aesKey, iv);
	return new Uint8Array(Buffer.concat([cipher.update(payload), cipher.final()]));
};
