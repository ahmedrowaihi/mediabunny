import { describe, expect, test } from 'vitest';
import { AesCtrEncryptor } from '../../src/crypto/aes-ctr-encryptor.js';

// NIST SP 800-38a F.5.1 CTR-AES128 (same vectors as shaka's aes_cryptor_unittest.cc).
const KEY = new Uint8Array([
	0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf, 0x4f, 0x3c,
]);
const IV = new Uint8Array([
	0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
]);
const PLAINTEXT = new Uint8Array([
	0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96, 0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93, 0x17, 0x2a,
	0xae, 0x2d, 0x8a, 0x57, 0x1e, 0x03, 0xac, 0x9c, 0x9e, 0xb7, 0x6f, 0xac, 0x45, 0xaf, 0x8e, 0x51,
	0x30, 0xc8, 0x1c, 0x46, 0xa3, 0x5c, 0xe4, 0x11, 0xe5, 0xfb, 0xc1, 0x19, 0x1a, 0x0a, 0x52, 0xef,
	0xf6, 0x9f, 0x24, 0x45, 0xdf, 0x4f, 0x9b, 0x17, 0xad, 0x2b, 0x41, 0x7b, 0xe6, 0x6c, 0x37, 0x10,
]);
const CIPHERTEXT = new Uint8Array([
	0x87, 0x4d, 0x61, 0x91, 0xb6, 0x20, 0xe3, 0x26, 0x1b, 0xef, 0x68, 0x64, 0x99, 0x0d, 0xb6, 0xce,
	0x98, 0x06, 0xf6, 0x6b, 0x79, 0x70, 0xfd, 0xff, 0x86, 0x17, 0x18, 0x7b, 0xb9, 0xff, 0xfd, 0xff,
	0x5a, 0xe4, 0xdf, 0x3e, 0xdb, 0xd5, 0xd3, 0x5e, 0x5b, 0x4f, 0x09, 0x02, 0x0d, 0xb0, 0x3e, 0xab,
	0x1e, 0x03, 0x1d, 0xda, 0x2f, 0xbe, 0x03, 0xd1, 0x79, 0x21, 0x70, 0xa0, 0xf3, 0x00, 0x9c, 0xee,
]);

const crypt = (cryptor: AesCtrEncryptor, data: Uint8Array): Uint8Array => {
	const out = new Uint8Array(data);
	cryptor.crypt(out);
	return out;
};

describe('AesCtrEncryptor', () => {
	test('NIST SP 800-38a F.5.1 encrypt + decrypt round-trip', () => {
		const enc = new AesCtrEncryptor();
		enc.initializeWithIv(KEY, IV);
		expect([...crypt(enc, PLAINTEXT)]).toEqual([...CIPHERTEXT]);

		const dec = new AesCtrEncryptor(); // CTR is symmetric (AesCtrDecryptor aliases AesCtrEncryptor)
		dec.initializeWithIv(KEY, IV);
		expect([...crypt(dec, CIPHERTEXT)]).toEqual([...PLAINTEXT]);
	});

	test('128-bit IV UpdateIv adds the last sample block count', () => {
		// IV = kIv128Max64 (low 64 bits all-ones). After crypting 4 blocks, +4 rolls the low word
		// to 3 and increments the high word to 1 → kIv128OneAndThree.
		const iv = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
		const enc = new AesCtrEncryptor();
		enc.initializeWithIv(KEY, iv);
		crypt(enc, PLAINTEXT); // 4 blocks
		enc.updateIv();
		expect([...enc.getIv()]).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3]);
	});

	test('64-bit IV UpdateIv increments by one regardless of block count', () => {
		const iv = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
		const enc = new AesCtrEncryptor();
		enc.initializeWithIv(KEY, iv);
		crypt(enc, PLAINTEXT); // 4 blocks
		enc.updateIv();
		expect([...enc.getIv()]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
	});

	test('128-bit IV boundary: block after low-64 overflow wraps the counter, not the high 64', () => {
		// First block encrypted with IV=max64, subsequent blocks with counter 0..3 — verified by
		// re-encrypting piecewise from a zero counter and comparing (shaka 128BitIVBoundaryCase).
		const ivMax64 = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
		const enc = new AesCtrEncryptor();
		enc.initializeWithIv(KEY, ivMax64);
		const whole = crypt(enc, PLAINTEXT);

		const verify = new Uint8Array(PLAINTEXT.length);
		const a = new AesCtrEncryptor();
		a.initializeWithIv(KEY, ivMax64);
		verify.set(crypt(a, PLAINTEXT.subarray(0, 16)), 0);
		const b = new AesCtrEncryptor();
		b.initializeWithIv(KEY, new Uint8Array(16));
		verify.set(crypt(b, PLAINTEXT.subarray(16, 64)), 16);
		expect([...whole]).toEqual([...verify]);
	});
});
