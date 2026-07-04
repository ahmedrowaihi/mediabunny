import { describe, expect, test } from 'vitest';
import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { AesPatternCryptor } from '../../src/crypto/aes-pattern-cryptor.js';
import { buildProtectionSinf, encryptFragment } from '../../src/crypto/fragment-encryptor.js';
import type { Box } from '../../src/isobmff/isobmff-boxes.js';
import type { SubsampleEntry, VideoSliceHeaderParser } from '../../src/crypto/subsample-generator.js';

const fillRandom = (n: number): Uint8Array => {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		b[i] = Math.floor(Math.random() * 256);
	}
	return b;
};

const decryptSample = (
	data: Uint8Array,
	subsamples: SubsampleEntry[],
	key: Uint8Array,
	iv: Uint8Array,
	cryptByteBlock: number,
	skipByteBlock: number,
): Uint8Array => {
	const cryptor = new AesPatternCryptor(
		cryptByteBlock, skipByteBlock, 'encryptIfCryptByteBlockRemaining', true, new AesCbcDecryptor(),
	);
	cryptor.initializeWithIv(key, new Uint8Array(16));
	cryptor.setIv(iv);
	const out = new Uint8Array(data.length);
	if (subsamples.length === 0) {
		out.set(cryptor.crypt(data));
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		out.set(data.subarray(offset, offset + clearBytes), offset);
		offset += clearBytes;
		if (cipherBytes > 0) {
			out.set(cryptor.crypt(data.subarray(offset, offset + cipherBytes)), offset);
			offset += cipherBytes;
		}
	}
	return out;
};

const findBoxType = (b: Box, type: string): boolean =>
	b.type === type || (b.children ?? []).some(c => c !== null && findBoxType(c, type));

const KEY = new Uint8Array(16).fill(0x2b);
const IV = new Uint8Array(16).fill(0x11);

const mockParser: VideoSliceHeaderParser = {
	initialize: () => true,
	processNalu: () => true,
	getHeaderSize: () => 2,
};

describe('encryptFragment (cbcs)', () => {
	test('video: encrypts every sample, builds senc/saiz, and each sample round-trips', () => {
		// Three length-prefixed video-slice NAL samples.
		const samples = [220, 340, 512].map((size) => {
			const nal = new Uint8Array([0x01, ...fillRandom(size - 1)]);
			// 2-byte length prefix so sizes > 255 fit.
			return new Uint8Array([(nal.length >> 8) & 0xff, nal.length & 0xff, ...nal]);
		});

		const result = encryptFragment({
			samples,
			streamInfo: { codec: 'avc', codecConfig: new Uint8Array(), naluLengthSize: 2 },
			streamType: 'video',
			key: KEY,
			iv: IV,
			videoSliceHeaderParser: mockParser,
		});

		expect(result.encryptedSamples).toHaveLength(3);
		expect(result.subsamplesPerSample.every(s => s.length === 1)).toBe(true);
		// clear = naluLengthSize(2) + nalHeader(1) + sliceHeader(2) = 5.
		expect(result.subsamplesPerSample[0]![0]!.clearBytes).toBe(5);
		expect(findBoxType(result.sencBox, 'senc')).toBe(true);
		expect(findBoxType(result.saizBox, 'saiz')).toBe(true);

		for (let i = 0; i < samples.length; i++) {
			const roundTripped = decryptSample(
				result.encryptedSamples[i]!, result.subsamplesPerSample[i]!, KEY, IV, 1, 9,
			);
			expect([...roundTripped]).toEqual([...samples[i]!]);
		}
	});

	test('audio: full-sample encryption of every sample round-trips', () => {
		const samples = [400, 512, 630].map(fillRandom);
		const result = encryptFragment({
			samples,
			streamInfo: { codec: 'aac', codecConfig: new Uint8Array(), naluLengthSize: 0 },
			streamType: 'audio',
			key: KEY,
			iv: IV,
		});

		expect(result.subsamplesPerSample.every(s => s.length === 0)).toBe(true);
		for (let i = 0; i < samples.length; i++) {
			const roundTripped = decryptSample(result.encryptedSamples[i]!, [], KEY, IV, 1, 0);
			expect([...roundTripped]).toEqual([...samples[i]!]);
		}
	});

	test('buildProtectionSinf produces sinf → frma + schm(cbcs) + schi(tenc)', () => {
		const box = buildProtectionSinf({
			originalFormat: 'avc1',
			scheme: 'cbcs',
			kid: new Uint8Array(16).fill(0xaa),
			cryptByteBlock: 1,
			skipByteBlock: 9,
			iv: IV,
		});
		expect(box.type).toBe('sinf');
		expect(findBoxType(box, 'frma')).toBe(true);
		expect(findBoxType(box, 'schm')).toBe(true);
		expect(findBoxType(box, 'tenc')).toBe(true);
	});
});
