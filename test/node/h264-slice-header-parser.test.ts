/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/media/codecs/video_slice_header_parser_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { H264VideoSliceHeaderParser } from '../../src/crypto/h264-slice-header-parser.js';
import type { Nalu } from '../../src/crypto/subsample-generator.js';

// avcC extra data from bear-640x360.mp4 (SPS + PPS).
const kExtraData = new Uint8Array([
	0x01, 0x64, 0x00, 0x1e, 0xff,
	0xe1, // SPS count (1)
	0x00, 0x19, // SPS size (25)
	0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0x40, 0xa0,
	0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x03, 0x03,
	0xe9, 0x00, 0x00, 0xea, 0x60, 0x0f, 0x16, 0x2d, 0x96,
	0x01, // PPS count (1)
	0x00, 0x06, // PPS size (6)
	0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0,
]);

// A slice NAL (IDR, type 5); incomplete but enough for the header.
const kData = new Uint8Array([
	0x65, 0x88, 0x84, 0x00, 0x21, 0xff, 0xcf, 0x73, 0xc7, 0x24,
	0xc8, 0xc3, 0xa5, 0xcb, 0x77, 0x60, 0x50, 0x85, 0xd9, 0xfc,
]);

const nalu = (data: Uint8Array): Nalu => ({
	type: data[0]! & 0x1f,
	headerSize: 1,
	payloadSize: data.length - 1,
	isVideoSlice: true,
	data,
});

describe('H264VideoSliceHeaderParser', () => {
	// shaka: TEST(H264VideoSliceHeaderParserTest, BasicSupport)
	test('computes the slice-header size (34 bits → 5 bytes)', () => {
		const parser = new H264VideoSliceHeaderParser();
		expect(parser.initialize(kExtraData)).toBe(true);
		expect(parser.getHeaderSize(nalu(kData))).toBe(5);
	});
});
