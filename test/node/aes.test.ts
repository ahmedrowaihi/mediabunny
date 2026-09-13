import { describe, expect, test } from 'vitest';
import { Reader } from '../../src/reader.js';
import { BufferSource } from '../../src/source.js';
import { Aes128CbcContext, createAes128CbcDecryptStream } from '../../src/aes.js';

const hex = (s: string): Uint8Array => {
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};
const toHex = (b: Uint8Array): string =>
	[...b].map(x => x.toString(16).padStart(2, '0')).join('');

// getRandomValues is length-limited, so let's just do this
export const fillRandom = <T extends Uint8Array>(buffer: T) => {
	for (let i = 0; i < buffer.length; i++) {
		buffer[i] = Math.floor(Math.random() * 256);
	}

	return buffer;
};

test('createAesDecryptStream', async () => {
	// Test for all paddings
	for (let i = 0; i < 16; i++) {
		const plaintextLength = Math.floor(Math.random() * 2 ** 18) + i;

		const plaintext = fillRandom(new Uint8Array(plaintextLength));
		const key = fillRandom(new Uint8Array(16));
		const iv = fillRandom(new Uint8Array(16));

		const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
		const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, plaintext));

		const source = new BufferSource(ciphertext);
		const reader = new Reader(source);

		const stream = createAes128CbcDecryptStream(reader, () => ({ key, iv }), () => {});
		const streamReader = stream.getReader();

		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await streamReader.read();
			if (done) {
				break;
			}

			chunks.push(value);
		}

		// Concatenate chunks
		const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const decrypted = new Uint8Array(totalLength);

		let offset = 0;
		for (const chunk of chunks) {
			decrypted.set(chunk, offset);
			offset += chunk.length;
		}

		expect(decrypted.length).toBe(plaintext.length);

		// .toEqual is slow, so we do this instead
		for (let j = 0; j < plaintext.length; j++) {
			if (decrypted[j] !== plaintext[j]) {
				throw new Error(`Mismatch at byte ${j} for padding ${16 - (i % 16)}`);
			}
		}
	}
});

// NIST SP 800-38A §F.2.1 (CBC-AES128.Encrypt) — the authoritative AES-128-CBC vectors.
const KEY = '2b7e151628aed2a6abf7158809cf4f3c';
const IV = '000102030405060708090a0b0c0d0e0f';
const BLOCKS: [string, string][] = [
	['6bc1bee22e409f96e93d7e117393172a', '7649abac8119b246cee98e9b12e9197d'],
	['ae2d8a571e03ac9c9eb76fac45af8e51', '5086cb9b507219ee95db113a917678b2'],
	['30c81c46a35ce411e5fbc1191a0a52ef', '73bed6b8e3c1743b7116e69e22229516'],
	['f69f2445df4f9b17ad2b417be66c3710', '3ff1caa1681fac09120eca307586e1a7'],
];

describe('Aes128CbcContext — encrypt (NIST SP 800-38A F.2.1)', () => {
	test('encrypts the 4 chained CBC blocks to the NIST ciphertext', () => {
		const ctx = new Aes128CbcContext();
		ctx.init({ key: hex(KEY), iv: hex(IV) });
		for (const [pt, expected] of BLOCKS) {
			ctx.in.set(hex(pt));
			ctx.encrypt();
			expect(toHex(ctx.out)).toBe(expected);
		}
	});

	test('encrypt → decrypt round-trips the plaintext', () => {
		const enc = new Aes128CbcContext();
		enc.init({ key: hex(KEY), iv: hex(IV) });
		const cipher: Uint8Array[] = [];
		for (const [pt] of BLOCKS) {
			enc.in.set(hex(pt));
			enc.encrypt();
			cipher.push(new Uint8Array(enc.out));
		}

		const dec = new Aes128CbcContext();
		dec.init({ key: hex(KEY), iv: hex(IV) });
		for (let i = 0; i < cipher.length; i++) {
			dec.in.set(cipher[i]!);
			dec.decrypt();
			expect(toHex(dec.out)).toBe(BLOCKS[i]![0]);
		}
	});
});
