import { describe, expect, test } from 'vitest';

import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import {
	protectedBlockOffsets,
	sampleAesEncryptAudioFrame,
	sampleAesEncryptVideoNal,
} from '../../src/crypto/sample-aes.js';

const KEY = new Uint8Array(16).fill(0x2b);
const IV = new Uint8Array(16).fill(0x11);
const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 5) & 0xff);

// hls.js SampleAesDecrypter.decryptAacSample — the reference decrypt we must be the inverse of.
const hlsDecryptAac = (frame: Uint8Array): Uint8Array => {
	const out = new Uint8Array(frame);
	if (out.length <= 16) {
		return out;
	}
	const end = out.length - (out.length % 16);
	if (end <= 16) {
		return out;
	}
	const dec = new AesCbcDecryptor();
	dec.initializeWithIv(KEY, IV);
	dec.crypt(out.subarray(16, end));
	return out;
};

// hls.js getAvcEncryptedData + getAvcDecryptedUnit — gather protected blocks, CBC-decrypt, scatter back.
const hlsDecryptAvc = (nal: Uint8Array): Uint8Array => {
	const out = new Uint8Array(nal);
	const offsets: number[] = [];
	for (let pos = 32; pos < out.length - 16; pos += 160) {
		offsets.push(pos);
	}
	if (offsets.length === 0) {
		return out;
	}
	const gathered = new Uint8Array(offsets.length * 16);
	offsets.forEach((pos, i) => gathered.set(out.subarray(pos, pos + 16), i * 16));
	const dec = new AesCbcDecryptor();
	dec.initializeWithIv(KEY, IV);
	dec.crypt(gathered);
	offsets.forEach((pos, i) => out.set(gathered.subarray(i * 16, i * 16 + 16), pos));
	return out;
};

describe('SAMPLE-AES sample encryption (verified against hls.js reference decrypt)', () => {
	test('AAC: first 16 bytes + trailing partial block stay clear; middle round-trips', () => {
		for (const length of [10, 16, 31, 32, 40, 100, 4096, 4103]) {
			const original = bytes(length);
			const encrypted = sampleAesEncryptAudioFrame(original, { key: KEY, iv: IV });
			// Clear leader (16) and any trailing partial block are untouched.
			const end = length - (length % 16);
			const lead = Math.min(16, length);
			expect([...encrypted.subarray(0, lead)]).toEqual([...original.subarray(0, lead)]);
			expect([...encrypted.subarray(end)]).toEqual([...original.subarray(end)]);
			if (end > 16) {
				expect([...encrypted.subarray(16, end)]).not.toEqual([...original.subarray(16, end)]);
			}
			// hls.js decrypt recovers the original exactly.
			expect([...hlsDecryptAac(encrypted)]).toEqual([...original]);
		}
	});

	test('AVC: 1-in-10 block pattern from offset 32; round-trips via the hls.js decrypt', () => {
		for (const length of [40, 48, 49, 64, 200, 360, 1000, 5000]) {
			const original = bytes(length);
			const encrypted = sampleAesEncryptVideoNal(original, { key: KEY, iv: IV });
			// (this synthetic NAL has no emulation-prevention bytes, so length is preserved)
			expect(encrypted.length).toBe(length);
			const offsets = protectedBlockOffsets(length);
			// Clear leader (first 32 bytes) is untouched.
			expect([...encrypted.subarray(0, 32)]).toEqual([...original.subarray(0, 32)]);
			// Each protected block differs; the skipped bytes between them are unchanged.
			for (const pos of offsets) {
				expect([...encrypted.subarray(pos, pos + 16)]).not.toEqual([...original.subarray(pos, pos + 16)]);
				expect([...encrypted.subarray(pos + 16, Math.min(pos + 160, length))])
					.toEqual([...original.subarray(pos + 16, Math.min(pos + 160, length))]);
			}
			expect([...hlsDecryptAvc(encrypted)]).toEqual([...original]);
		}
	});

	test('protected-block count matches hls.js encryptedDataLen = floor((len-48)/160)*16 + 16', () => {
		for (const length of [49, 64, 200, 360, 500, 5000]) {
			const hlsLen = Math.floor((length - 48) / 160) * 16 + 16;
			expect(protectedBlockOffsets(length).length * 16).toBe(hlsLen);
		}
	});

	test('AVC strips emulation-prevention bytes before encrypting', () => {
		// 0x00 00 03 → 0x00 00 after stripping, so the output is shorter than the input.
		const nal = new Uint8Array(80);
		nal.set([0x00, 0x00, 0x03, 0x00, 0x00, 0x03], 40);
		const encrypted = sampleAesEncryptVideoNal(nal, { key: KEY, iv: IV });
		expect(encrypted.length).toBe(78); // two 0x03 emulation bytes removed
	});
});
