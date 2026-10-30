import { describe, expect, test, vi } from 'vitest';
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

	test('crypting in chunks that split blocks matches the NIST ciphertext', () => {
		const cryptor = new AesCtrEncryptor();
		cryptor.initializeWithIv(KEY, IV);
		const out = new Uint8Array(PLAINTEXT);
		// Unaligned runs: the keystream offset has to carry from one call into the next.
		for (let at = 0; at < out.length;) {
			const run = Math.min([5, 11, 1, 20, 27][at % 5]!, out.length - at);
			cryptor.crypt(out.subarray(at, at + run));
			at += run;
		}
		expect(out).toEqual(CIPHERTEXT);
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

	test('native and JS runs chain across calls, aligned or not', () => {
		// Mixed run lengths: large aligned ones take the native cipher, the 13-byte run cannot and
		// leaves the keystream mid-block, which the run after it has to resume from. Encrypting the
		// same bytes in 16-byte calls never reaches the native threshold, so it is the reference.
		const plaintext = new Uint8Array(16384);
		for (let i = 0; i < plaintext.length; i++) {
			plaintext[i] = (i * 17 + 3) & 0xff;
		}

		// 1500 is over the native threshold but not a whole number of blocks, so it must stay on
		// the JS keystream; the run after it would otherwise resume from the wrong place.
		const runs = [2048, 1500, 13, 2048, 16, 1040, 3, 1024];
		const total = runs.reduce((sum, run) => sum + run, 0);

		const measure = (crypter: (enc: AesCtrEncryptor, out: Uint8Array) => void) => {
			const enc = new AesCtrEncryptor();
			enc.initializeWithIv(KEY, IV);
			const out = new Uint8Array(plaintext);
			crypter(enc, out);
			// updateIv advances the IV by the bytes crypted so far, so it reads numCryptBytes back.
			enc.updateIv();
			crypter(enc, out.subarray(total));
			return out.subarray(0, total * 2);
		};

		const actual = measure((enc, out) => {
			let at = 0;
			for (const run of runs) {
				enc.crypt(out.subarray(at, at + run));
				at += run;
			}
		});
		const expected = measure((enc, out) => {
			for (let i = 0; i < total; i += 16) {
				enc.crypt(out.subarray(i, Math.min(i + 16, total)));
			}
		});
		expect([...actual]).toEqual([...expected]);
	});

	test('still crypts when the Node module is stubbed away, as bundlers do for browsers', async () => {
		// The browser field maps './node' to an empty module, so the namespace exists but its
		// bindings do not. Checking the namespace instead of the binding crashed every browser.
		vi.resetModules();
		// Both shapes a browser actually produces: a stubbed-away binding, and Vite's shim object
		// that has a `crypto` but none of the ciphers on it. The second one is what broke.
		vi.doMock('../../src/node.js', () => ({ crypto: { randomUUID: () => '' }, fs: undefined }));
		try {
			const { AesCtrEncryptor: Browser } = await import('../../src/crypto/aes-ctr-encryptor.js');
			const stubbed = new Browser();
			stubbed.initializeWithIv(KEY, IV);
			const plaintext = new Uint8Array(4096).fill(0xab);
			const viaStub = new Uint8Array(plaintext);
			stubbed.crypt(viaStub);

			const withNode = new AesCtrEncryptor();
			withNode.initializeWithIv(KEY, IV);
			const viaNative = new Uint8Array(plaintext);
			withNode.crypt(viaNative);
			expect([...viaStub]).toEqual([...viaNative]);
		} finally {
			vi.doUnmock('../../src/node.js');
			vi.resetModules();
		}
	});

	test('low-64 overflow wraps on a run long enough to take the native cipher', () => {
		// Large and block-aligned, so this takes the native path where one exists — which carries
		// into the high 64 bits, where CENC wraps within the low 64. Encrypting the same bytes in
		// 16-byte calls stays under the native threshold, so it is the JS keystream to check against.
		const ivNearMax = new Uint8Array([
			1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf0,
		]);
		const plaintext = new Uint8Array(4096);
		for (let i = 0; i < plaintext.length; i++) {
			plaintext[i] = (i * 31) & 0xff;
		}

		const whole = new AesCtrEncryptor();
		whole.initializeWithIv(KEY, ivNearMax);
		const inOneCall = crypt(whole, plaintext);

		const piecewise = new AesCtrEncryptor();
		piecewise.initializeWithIv(KEY, ivNearMax);
		const expected = new Uint8Array(plaintext);
		for (let at = 0; at < expected.length; at += 16) {
			piecewise.crypt(expected.subarray(at, at + 16));
		}
		expect([...inOneCall]).toEqual([...expected]);
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
