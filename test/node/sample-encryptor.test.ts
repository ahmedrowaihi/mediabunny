import { describe, expect, test } from 'vitest';
import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { AesPatternCryptor } from '../../src/crypto/aes-pattern-cryptor.js';
import { SampleEncryptor } from '../../src/crypto/sample-encryptor.js';
import type { SubsampleEntry, VideoSliceHeaderParser } from '../../src/crypto/subsample-generator.js';

const fillRandom = (n: number): Uint8Array => {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		b[i] = Math.floor(Math.random() * 256);
	}
	return b;
};

// Inverse of SampleEncryptor.encryptSample: decrypts the cbcs subsamples back to plaintext.
const decrypt = (
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

const KEY = new Uint8Array(16).fill(0x2b);
const IV = new Uint8Array(16).fill(0x11);

describe('SampleEncryptor (cbcs)', () => {
	test('audio: whole-block full-sample encryption round-trips', () => {
		const sample = fillRandom(1000);
		const encryptor = new SampleEncryptor({
			streamInfo: { codec: 'aac', codecConfig: new Uint8Array(), naluLengthSize: 0 },
			streamType: 'audio',
			scheme: 'cbcs',
			key: KEY,
			iv: IV,
		});
		const enc = encryptor.encryptSample(sample);

		expect(enc.subsamples).toEqual([]); // full sample, no subsamples
		expect([...enc.data]).not.toEqual([...sample]); // actually encrypted
		expect([...decrypt(enc.data, enc.subsamples, KEY, IV, 1, 0)]).toEqual([...sample]);
	});

	test('video: pattern (1:9) subsample encryption keeps headers clear and round-trips', () => {
		// One length-prefixed (1-byte) video-slice NAL: type 1, 200-byte payload.
		const payload = fillRandom(200);
		const nal = new Uint8Array([0x01, ...payload]);
		const frame = new Uint8Array([nal.length, ...nal]);

		const mockParser: VideoSliceHeaderParser = {
			initialize: () => true,
			processNalu: () => true,
			getHeaderSize: () => 2,
		};
		const encryptor = new SampleEncryptor({
			streamInfo: { codec: 'avc', codecConfig: new Uint8Array(), naluLengthSize: 1 },
			streamType: 'video',
			scheme: 'cbcs',
			key: KEY,
			iv: IV,
			videoSliceHeaderParser: mockParser,
		});
		const enc = encryptor.encryptSample(frame);

		// clear = naluLengthSize(1) + nalHeader(1) + sliceHeader(2) = 4; cipher = 201 - 3 = 198.
		expect(enc.subsamples).toEqual([{ clearBytes: 4, cipherBytes: 198 }]);
		// The clear leader (length prefix + NAL/slice header) is untouched.
		expect([...enc.data.subarray(0, 4)]).toEqual([...frame.subarray(0, 4)]);
		// The protected region is actually changed.
		expect([...enc.data.subarray(4)]).not.toEqual([...frame.subarray(4)]);
		// And it round-trips.
		expect([...decrypt(enc.data, enc.subsamples, KEY, IV, 1, 9)]).toEqual([...frame]);
	});
});
