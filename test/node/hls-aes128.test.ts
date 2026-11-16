import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { buildHlsAes128KeyTag, encryptHlsAes128 } from '../../src/crypto/hls-aes128.js';

const publicPath = (file: string) => path.join(new URL('.', import.meta.url).pathname, '../public', file);
const KEY = new Uint8Array(16).fill(0x2b);
const IV = new Uint8Array(16).fill(0x11);

describe('encryptHlsAes128 (HLS AES-128 full-segment)', () => {
	test('a whole MPEG-TS segment round-trips through AES-128-CBC + PKCS#7', () => {
		const original = new Uint8Array(readFileSync(publicPath('eac3.ts')));
		const encrypted = encryptHlsAes128(original, { key: KEY, iv: IV });

		// Output is padded to a whole number of blocks and differs from the input.
		expect(encrypted.length % 16).toBe(0);
		expect(encrypted.length).toBe(original.length + (16 - (original.length % 16)));
		expect([...encrypted.subarray(0, 16)]).not.toEqual([...original.subarray(0, 16)]);

		// Decrypt (AES-128-CBC) and strip PKCS#7 padding → the original bytes exactly.
		const decryptor = new AesCbcDecryptor();
		decryptor.initializeWithIv(KEY, IV);
		const buffer = new Uint8Array(encrypted);
		decryptor.crypt(buffer);
		const padLength = buffer[buffer.length - 1]!;
		expect(padLength).toBeGreaterThanOrEqual(1);
		expect(padLength).toBeLessThanOrEqual(16);
		expect([...buffer.subarray(0, buffer.length - padLength)]).toEqual([...original]);
	});

	test('a segment whose length is already a multiple of 16 gets a full padding block', () => {
		const original = new Uint8Array(32).fill(0xaa);
		const encrypted = encryptHlsAes128(original, { key: KEY, iv: IV });
		expect(encrypted.length).toBe(48); // 32 + a full 16-byte padding block

		const decryptor = new AesCbcDecryptor();
		decryptor.initializeWithIv(KEY, IV);
		const buffer = new Uint8Array(encrypted);
		decryptor.crypt(buffer);
		expect(buffer[buffer.length - 1]).toBe(16);
		expect([...buffer.subarray(0, 32)]).toEqual([...original]);
	});

	test('buildHlsAes128KeyTag emits a valid #EXT-X-KEY line', () => {
		expect(buildHlsAes128KeyTag({ uri: 'https://keys.example/k1' }))
			.toBe('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1"');
		expect(buildHlsAes128KeyTag({ uri: 'k1', iv: new Uint8Array(16).fill(0x11) }))
			.toBe('#EXT-X-KEY:METHOD=AES-128,URI="k1",IV=0x11111111111111111111111111111111');
	});
});
