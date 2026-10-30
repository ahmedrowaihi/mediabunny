/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The clear slice-header size is where cbcs/cenc encryption starts, and encryption is symmetric: a stream
// encrypted from the wrong offset decrypts back to itself, so a round trip cannot see the mistake. These
// tests compare the measured size against ffmpeg's own reading of the same bitstreams instead.

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { FilePathSource } from '../../src/source.js';
import { SEI_FRAMINGS, type SeiCodec } from '../../src/sei.js';
import { H264VideoSliceHeaderParser } from '../../src/crypto/h264-slice-header-parser.js';
import { H265VideoSliceHeaderParser } from '../../src/crypto/h265-slice-header-parser.js';
import type { Nalu, VideoSliceHeaderParser } from '../../src/crypto/subsample-generator.js';
import {
	deserializeAvcDecoderConfigurationRecord,
	removeEmulationPreventionBytes,
	serializeAvcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import { Bitstream } from '../../shared/bitstream.js';
import { readExpGolomb, toUint8Array, writeExpGolomb } from '../../src/misc.js';

const NAL_HEADER_SIZE: Record<SeiCodec, number> = { avc: 1, hevc: 2 };

/**
 * Every video-slice NAL's clear header size, in the order the packets state them. Mirrors how
 * `createVideoQuantizerReader` walks a packet, since both need the parameter sets a slice header is read
 * against - from the config, and from any the stream sends in band.
 */
const measureHeaders = async (file: string, codec: SeiCodec, description?: AllowSharedBufferSource) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public', file)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const framing = SEI_FRAMINGS[codec];
	const headerSize = NAL_HEADER_SIZE[codec];
	const parser: VideoSliceHeaderParser = codec === 'avc'
		? new H264VideoSliceHeaderParser()
		: new H265VideoSliceHeaderParser();

	expect(parser.initialize(toUint8Array(description ?? decoderConfig.description!))).toBe(true);

	const sizes: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		for (const { offset, length } of framing.iterateNalUnits(packet.data, decoderConfig)) {
			const firstByte = packet.data[offset];
			if (firstByte === undefined) {
				continue;
			}

			const data = packet.data.subarray(offset, offset + length);
			const isVcl = framing.isVcl(firstByte);
			const nalu: Nalu = {
				type: codec === 'avc' ? firstByte & 0x1f : (firstByte >> 1) & 0x3f,
				headerSize,
				payloadSize: length - headerSize,
				isVideoSlice: isVcl,
				data,
			};

			if (isVcl) {
				sizes.push(parser.getHeaderSize(nalu));
			} else {
				expect(parser.processNalu(nalu)).toBe(true);
			}
		}
	}
	return sizes;
};

// Every value below came out of `ffmpeg -i <fixture> -c copy -bsf:v trace_headers -f null -`, as the bit
// position where the slice header's fields end less the NAL header, rounded up to whole bytes. H.264 pads
// with `cabac_alignment_one_bit`, which is zero or more bits, so its slice data starts in the byte the
// fields end in; H.265's `byte_alignment()` always writes an `alignment_bit_equal_to_one` first, so a
// header whose fields end byte-aligned spends one further byte on the alignment. Keeping these as a fixture
// means the expectation came from a second implementation rather than from this one.
const GROUND_TRUTH = JSON.parse(
	fs.readFileSync(path.join(__dirname, '_slice-header-sizes.json'), 'utf8'),
) as Record<string, { codec: SeiCodec; sizes: number[] }>;

test.each(Object.entries(GROUND_TRUTH))(
	'%s slice-header sizes match what ffmpeg traces in the bitstream',
	async (file, { codec, sizes: expected }) => {
		expect(await measureHeaders(file, codec)).toEqual(expected);
	},
	300_000,
);

// Three fixtures exist for constructs none of the others contain, each of which moves every slice header:
// x264's `fake-interlaced=1` clears `frame_mbs_only_flag`, putting a `field_pic_flag` in each header;
// x265's `slices=4` clears `first_slice_segment_in_pic_flag` on 3 of every 4 slices, putting a
// `slice_segment_address` in each; and x265's `scaling-list=<file>` sends `scaling_list_data()` in the SPS,
// a variable-length walk sitting ahead of every field a slice header is read against.
test('the fixtures carry the constructs they exist for', async () => {
	const slicesIn = (file: string) => GROUND_TRUTH[file]!.sizes.length;

	// 4 slice segments per picture, 3 of them stating an address
	expect(slicesIn('hevc-multi-slice.mp4')).toBe(4 * slicesIn('avc-fake-interlaced.mp4'));
	expect(slicesIn('hevc-scaling-list.mp4')).toBe(slicesIn('avc-fake-interlaced.mp4'));

	// A parser that gave up on the scaling list rather than walking it would read no header at all
	expect(await measureHeaders('hevc-scaling-list.mp4', 'hevc')).not.toContain(-1);
});

/** Writes a signed exponential-Golomb code, the inverse of `readSignedExpGolomb`'s mapping. */
const writeSignedExpGolomb = (bitstream: Bitstream, value: number) => {
	writeExpGolomb(bitstream, value > 0 ? 2 * value - 1 : -2 * value);
};

/**
 * Returns the given AVC SPS with scaling matrices spliced in, every later field left as it was. List 0 ends
 * early by driving the running scale to 0, and the rest run their full length, so the walk has to honour
 * both the termination rule and the list sizes to land on the next field.
 */
const withSeqScalingMatrix = (sps: Uint8Array) => {
	const source = new Bitstream(removeEmulationPreventionBytes(sps.subarray(1)));
	const patched = new Bitstream(new Uint8Array(sps.length + 32));

	// H.264 7.3.2.1.1, up to and including seq_scaling_matrix_present_flag
	patched.copyBits(8 + 8 + 8, source); // profile_idc, constraint flags, level_idc
	writeExpGolomb(patched, readExpGolomb(source)); // seq_parameter_set_id
	const chromaFormatIdc = readExpGolomb(source);
	writeExpGolomb(patched, chromaFormatIdc);
	expect(chromaFormatIdc).toBe(1); // 4:2:0, so 6 4x4 lists and 2 8x8 lists
	writeExpGolomb(patched, readExpGolomb(source)); // bit_depth_luma_minus8
	writeExpGolomb(patched, readExpGolomb(source)); // bit_depth_chroma_minus8
	patched.copyBits(1, source); // qpprime_y_zero_transform_bypass_flag
	expect(source.readBits(1)).toBe(0); // seq_scaling_matrix_present_flag, replaced
	patched.writeBits(1, 1);

	for (let i = 0; i < 6 + 2; i++) {
		patched.writeBits(1, 1); // seq_scaling_list_present_flag[i]
		if (i === 0) {
			// nextScale = (8 + -8 + 256) & 0xff = 0, which ends the list and leaves the other 15 unsent
			writeSignedExpGolomb(patched, -8);
			continue;
		}
		for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
			writeExpGolomb(patched, 0); // delta_scale, leaving the matrix flat
		}
	}
	patched.copyBits(source.getBitsLeft(), source);

	return new Uint8Array([...sps.subarray(0, 1), ...patched.bytes.subarray(0, Math.ceil(patched.pos / 8))]);
};

// x264 writes its matrices into the PPS, past where this parser stops reading, and no other encoder here
// writes any - so only a splice can tell a parser that walks the SPS lists from one that skips them. The
// matrices below change no field after them, so if the walk is right every slice header measures exactly as
// it did without them.
test('AVC scaling lists in the SPS are walked, not skipped', async () => {
	const file = 'video.mp4';
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public', file)),
		formats: ALL_FORMATS,
	});
	const config = (await (await input.getPrimaryVideoTrack())!.getDecoderConfig())!;
	const record = deserializeAvcDecoderConfigurationRecord(toUint8Array(config.description!))!;
	expect(record.sequenceParameterSets).toHaveLength(1);

	const patched = serializeAvcDecoderConfigurationRecord({
		...record,
		sequenceParameterSets: [withSeqScalingMatrix(record.sequenceParameterSets[0]!)],
	});

	expect(await measureHeaders(file, 'avc', patched)).toEqual(GROUND_TRUTH[file]!.sizes);
}, 300_000);
