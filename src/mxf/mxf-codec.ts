/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// What a descriptor says the essence is, turned into the codec and decoder config a caller reads.
//
// A picture descriptor names its coding with a SMPTE universal label rather than a four-character
// code, and the label is a registry path: bytes 8-11 say "compressed picture coding", byte 12 names
// the family and byte 13 the codec within it. The labels below were read out of files rather than
// copied from a table - every one is confirmed against a file this repository can produce - except
// HEVC, whose range is from SMPTE ST 381-5 because nothing here writes HEVC into MXF.
//
// A codec this library has no name for is not an error. The track is still readable, still has a
// duration and a size, and still reports its label as the internal codec id; only `getCodec()` is
// null. Widening the public codec union is a separate decision from reading the files.

import type { AudioCodec, VideoCodec } from '../codec';
import { asKey, asRational, asUint, type LocalSet } from './mxf-klv';

/** PictureEssenceCoding. */
const TAG_PICTURE_ESSENCE_CODING = 0x3201;
/** SoundEssenceCompression; absent means the sound is not compressed. */
const TAG_SOUND_ESSENCE_COMPRESSION = 0x3d06;

const TAG_STORED_WIDTH = 0x3203;
const TAG_STORED_HEIGHT = 0x3202;
const TAG_SAMPLED_WIDTH = 0x3205;
const TAG_SAMPLED_HEIGHT = 0x3204;
const TAG_DISPLAY_WIDTH = 0x3209;
const TAG_DISPLAY_HEIGHT = 0x3208;
const TAG_FRAME_LAYOUT = 0x320c;
const TAG_ASPECT_RATIO = 0x320e;

const TAG_AUDIO_SAMPLING_RATE = 0x3d03;
const TAG_CHANNEL_COUNT = 0x3d07;
const TAG_QUANTIZATION_BITS = 0x3d01;

/** `04 01 02 02` at bytes 8-11: a compressed picture coding, which every entry below is one of. */
const isCompressedPicture = (ul: Uint8Array) =>
	ul.byteLength >= 14 && ul[8] === 0x04 && ul[9] === 0x01 && ul[10] === 0x02 && ul[11] === 0x02;

/**
 * The codec a PictureEssenceCoding label names, or null where this library has no name for it.
 *
 * Measured labels, from files produced here:
 * - MPEG-2 `…04010202 01 01 11 00`
 * - AVC `…04010202 01 31 60 01`
 * - ProRes `…04010202 03 06 04 00`
 * - DV `…04010202 02 01 02 00`, JPEG 2000 `…04010202 03 01 01 00`, VC-3 `…04010202 71 13 00 00`
 *
 * The last three have no codec in this library's union, so they read as null.
 */
export const pictureCodecOf = (ul: Uint8Array | undefined): VideoCodec | null => {
	if (!ul || !isCompressedPicture(ul)) {
		return null;
	}

	const family = ul[12]!;
	const kind = ul[13]!;

	if (family === 0x01) {
		// The MPEG family, where byte 13 is the range: ST 381-5 puts HEVC at 0x40-0x4f, AVC at
		// 0x30-0x3f, MPEG-4 part 2 at 0x20-0x2f, and MPEG-2 below that
		if (kind >= 0x40 && kind <= 0x4f) {
			return 'hevc';
		}
		if (kind >= 0x30 && kind <= 0x3f) {
			return 'avc';
		}
		if (kind >= 0x01 && kind <= 0x0f) {
			return 'mpeg2';
		}

		return null;
	}

	if (family === 0x03 && kind === 0x06) {
		return 'prores';
	}

	return null;
};

/**
 * The codec a sound descriptor names.
 *
 * Absent SoundEssenceCompression means uncompressed, which is what the AES3 and BWF mappings carry and
 * is by far the common case; the width then comes from QuantizationBits. MXF writes PCM little-endian.
 */
export const soundCodecOf = (descriptor: LocalSet): AudioCodec | null => {
	const compression = descriptor.get(TAG_SOUND_ESSENCE_COMPRESSION);
	const compressed = compression !== undefined && compression.some(byte => byte !== 0);
	if (compressed) {
		return null;
	}

	switch (asUint(descriptor.get(TAG_QUANTIZATION_BITS) ?? new Uint8Array())) {
		case 8: return 'pcm-s8';
		case 16: return 'pcm-s16';
		case 24: return 'pcm-s24';
		case 32: return 'pcm-s32';
		default: return null;
	}
};

export type MxfPictureInfo = {
	codec: VideoCodec | null;
	/** The label as hex, which is what a caller reads as the internal codec id. */
	internalId: string | null;
	/** What is presented, which is not what is stored: coding pads the stored size up to its grid. */
	displayWidth: number;
	displayHeight: number;
	codedWidth: number;
	codedHeight: number;
	/** Whether the essence is stored as two fields per frame rather than one progressive picture. */
	interlaced: boolean;
};

/** @internal */
export const readPictureInfo = (descriptor: LocalSet): MxfPictureInfo => {
	const ul = descriptor.get(TAG_PICTURE_ESSENCE_CODING);

	const pick = (display: number, sampled: number, stored: number) =>
		descriptor.has(display)
			? asUint(descriptor.get(display)!)
			: descriptor.has(sampled)
				? asUint(descriptor.get(sampled)!)
				: asUint(descriptor.get(stored) ?? new Uint8Array());

	const codedWidth = pick(TAG_DISPLAY_WIDTH, TAG_SAMPLED_WIDTH, TAG_STORED_WIDTH);
	const codedHeight = pick(TAG_DISPLAY_HEIGHT, TAG_SAMPLED_HEIGHT, TAG_STORED_HEIGHT);

	const layout = asUint(descriptor.get(TAG_FRAME_LAYOUT) ?? new Uint8Array([0]));
	const fieldsPerFrame = layout === 1 || layout === 4 ? 2 : 1;
	const frameHeight = codedHeight * fieldsPerFrame;

	const aspect = descriptor.has(TAG_ASPECT_RATIO)
		? asRational(descriptor.get(TAG_ASPECT_RATIO)!)
		: null;
	const displayWidth = aspect && aspect.num > 0 && aspect.den > 0
		? Math.round(frameHeight * aspect.num / aspect.den)
		: codedWidth;

	return {
		codec: pictureCodecOf(ul),
		internalId: ul ? asKey(ul) : null,
		displayWidth,
		displayHeight: frameHeight,
		codedWidth,
		codedHeight: frameHeight,
		interlaced: layout !== 0,
	};
};

export type MxfSoundInfo = {
	codec: AudioCodec | null;
	internalId: string | null;
	sampleRate: number;
	channelCount: number;
	/** Bits per sample, which is what tells the PCM widths apart. */
	quantizationBits: number;
};

/** @internal */
export const readSoundInfo = (descriptor: LocalSet): MxfSoundInfo => {
	const rate = descriptor.has(TAG_AUDIO_SAMPLING_RATE)
		? asRational(descriptor.get(TAG_AUDIO_SAMPLING_RATE)!)
		: null;
	const compression = descriptor.get(TAG_SOUND_ESSENCE_COMPRESSION);

	return {
		codec: soundCodecOf(descriptor),
		internalId: compression ? asKey(compression) : null,
		sampleRate: rate && rate.den > 0 ? rate.num / rate.den : 0,
		channelCount: asUint(descriptor.get(TAG_CHANNEL_COUNT) ?? new Uint8Array()),
		quantizationBits: asUint(descriptor.get(TAG_QUANTIZATION_BITS) ?? new Uint8Array()),
	};
};
