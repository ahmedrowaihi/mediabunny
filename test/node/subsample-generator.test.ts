/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/media/crypto/subsample_generator_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import {
	type ProtectionScheme,
	SubsampleGenerator,
	type VideoSliceHeaderParser,
} from '../../src/crypto/subsample-generator.js';

const rangeInclusive = (from: number, to: number): number[] =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

// shaka's kFrame: three length-prefixed (1-byte) NALs — two video slices + one SPS.
const nal1 = [0x01, ...rangeInclusive(0x02, 0x09)]; // type 0x01 (non-IDR slice), size 9
const nal2 = [0x25, ...rangeInclusive(0x02, 0x27)]; // type 0x05 (IDR slice), size 0x27
const nal3 = [0x67, ...rangeInclusive(0x02, 0x32)]; // type 0x07 (SPS), size 0x32
const kFrame = new Uint8Array([
	nal1.length, ...nal1,
	nal2.length, ...nal2,
	nal3.length, ...nal3,
]);

// Mirrors shaka's MockVideoSliceHeaderParser: GetHeaderSize returns the injected sizes in order.
const mockParser = (headerSizes: number[]): VideoSliceHeaderParser => {
	let index = 0;
	return {
		initialize: () => true,
		processNalu: () => true,
		getHeaderSize: () => headerSizes[index++]!,
	};
};

describe('SubsampleGenerator', () => {
	// shaka: TEST_P(SubsampleGeneratorTest, H264SubsampleEncryption) over {cenc, cens, cbc1, cbcs}.
	const schemes: ProtectionScheme[] = ['cenc', 'cens', 'cbc1', 'cbcs'];
	test.each(schemes)('H264 subsample encryption (%s)', (scheme) => {
		const generator = new SubsampleGenerator(false, false);
		generator.initialize(scheme, { codec: 'avc', codecConfig: new Uint8Array(), naluLengthSize: 1 });
		generator.setVideoSliceHeaderParser(mockParser([4, 5]));

		const subsamples = generator.generateSubsamples(kFrame);

		if (scheme === 'cbcs') {
			// Unaligned: protected data starts right after NAL + slice header.
			expect(subsamples).toEqual([
				{ clearBytes: 6, cipherBytes: 4 },
				{ clearBytes: 7, cipherBytes: 0x21 },
				{ clearBytes: 0x33, cipherBytes: 0 },
			]);
		} else {
			// Aligned: protected data is a multiple of 16 bytes; clear-only runs merge.
			expect(subsamples).toEqual([
				{ clearBytes: 17, cipherBytes: 0x20 },
				{ clearBytes: 0x34, cipherBytes: 0 },
			]);
		}
	});

	// shaka: TEST_P(SubsampleGeneratorTest, AACFullSampleEncryption) — audio is full-sample encrypted.
	test('AAC audio is full-sample encrypted (no subsamples)', () => {
		const generator = new SubsampleGenerator(false, false);
		generator.initialize('cbcs', { codec: 'aac', codecConfig: new Uint8Array(), naluLengthSize: 0 });
		expect(generator.generateSubsamples(new Uint8Array(100))).toEqual([]);
	});

	// A malformed AV1 temporal unit must throw, never silently mis-encrypt.
	test('AV1 subsample encryption throws on a malformed frame', () => {
		const generator = new SubsampleGenerator(false, false);
		generator.initialize('cbcs', { codec: 'av1', codecConfig: new Uint8Array(), naluLengthSize: 0 });
		expect(() => generator.generateSubsamples(new Uint8Array(10))).toThrow(/Failed to parse AV1/);
	});
});
