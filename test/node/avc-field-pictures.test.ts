/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A field-coded (PAFF) stream used to be unencryptable: the slice-header parser threw on
// field_pic_flag, so every slice measured -1 and CENC could not place its subsamples. x264 only emits
// MBAFF, so the fixture is written by scripts/build-avc-field-pictures.py - the SPS and PPS come from
// avc-fake-interlaced.mp4, which already states frame_mbs_only_flag = 0, and only the slice headers are
// hand-built per H.264 7.3.3.
//
// The expectations below are ffmpeg's reading of that same file, not this parser's:
// `ffmpeg -i avc-field-pictures.264 -c copy -bsf:v trace_headers -f null -` puts bottom_field_flag at
// bit 22 and the four slice_qp_deltas at 0, 2, -4 and 7, with the headers ending at bits 30, 34, 36, 36.
// ffmpeg also warns that it cannot read the slice *data*, which is true and deliberate: the fixture
// carries headers only, which is all either parser reads.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { H264VideoSliceHeaderParser } from '../../src/crypto/h264-slice-header-parser.js';
import type { Nalu } from '../../src/crypto/subsample-generator.js';
import { serializeAvcDecoderConfigurationRecord } from '../../src/codec-data.js';

/** Splits an Annex-B stream on its start codes. */
const annexBNalus = (bytes: Uint8Array): Uint8Array[] => {
	const starts: number[] = [];
	for (let i = 0; i + 4 <= bytes.length; i++) {
		if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
			starts.push(i + 4);
		}
	}
	return starts.map((start, index) => bytes.subarray(
		start,
		index + 1 < starts.length ? starts[index + 1]! - 4 : bytes.length,
	));
};

const parserForFixture = () => {
	const bytes = new Uint8Array(readFileSync(path.join(__dirname, '../public/avc-field-pictures.264')));
	const nalus = annexBNalus(bytes);
	const sps = nalus.filter(nalu => (nalu[0]! & 0x1f) === 7);
	const pps = nalus.filter(nalu => (nalu[0]! & 0x1f) === 8);
	const slices = nalus.filter(nalu => (nalu[0]! & 0x1f) === 5);

	expect(sps).toHaveLength(1);
	expect(pps).toHaveLength(1);
	expect(slices).toHaveLength(4);

	const parser = new H264VideoSliceHeaderParser();
	expect(parser.initialize(serializeAvcDecoderConfigurationRecord({
		configurationVersion: 1,
		avcProfileIndication: sps[0]![1]!,
		profileCompatibility: sps[0]![2]!,
		avcLevelIndication: sps[0]![3]!,
		lengthSizeMinusOne: 3,
		sequenceParameterSets: sps,
		pictureParameterSets: pps,
		chromaFormat: null,
		bitDepthLumaMinus8: null,
		bitDepthChromaMinus8: null,
		sequenceParameterSetExt: null,
	}))).toBe(true);

	return {
		parser,
		slices: slices.map((data): Nalu => ({
			type: data[0]! & 0x1f,
			headerSize: 1,
			payloadSize: data.length - 1,
			isVideoSlice: true,
			data,
		})),
	};
};

test('a field picture is measured rather than refused', () => {
	const { parser, slices } = parserForFixture();

	const sizes = slices.map(slice => parser.getHeaderSize(slice));

	// -1 is what this returned for every slice before field pictures were read at all
	expect(sizes).not.toContain(-1);
	// ffmpeg's trace ends these headers at bits 30, 34, 36 and 36, less the 8-bit NAL header
	expect(sizes).toEqual([3, 4, 4, 4]);
});

test('the quantizer is read from past bottom_field_flag, not over it', () => {
	const { parser, slices } = parserForFixture();

	// The PPS states pic_init_qp_minus26 = -3, and ffmpeg traces the four deltas as 0, 2, -4, 7
	expect(slices.map(slice => parser.getSliceQp(slice))).toEqual([23, 25, 19, 30]);
});

test('both field parities parse, so bottom_field_flag is read and not assumed', () => {
	const { parser, slices } = parserForFixture();

	// The fixture alternates bottom_field_flag 0, 1, 0, 1; a parser that skipped the bit would read
	// every later field one bit early and the quantizers above would not land
	expect(slices.every(slice => parser.getSliceQp(slice) !== null)).toBe(true);
});
