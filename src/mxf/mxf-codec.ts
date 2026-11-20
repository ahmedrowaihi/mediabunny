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

/**
 * PixelLayout, on an RGBA descriptor: up to eight (code, depth) pairs, terminated by a zero code.
 * The code is an ASCII letter naming the component - `R`, `G`, `B`, `A`, `Y`, `U`, `V`, `F` for fill.
 */
const TAG_PIXEL_LAYOUT = 0x3401;

const TAG_AUDIO_SAMPLING_RATE = 0x3d03;
const TAG_CHANNEL_COUNT = 0x3d07;
const TAG_QUANTIZATION_BITS = 0x3d01;

/** `04 01 02 02` at bytes 8-11: a compressed picture coding, which every entry below is one of. */
const isCompressedPicture = (ul: Uint8Array) =>
	ul.byteLength >= 14 && ul[8] === 0x04 && ul[9] === 0x01 && ul[10] === 0x02 && ul[11] === 0x02;

/**
 * The codec a PictureEssenceCoding label names, or null where this library has no name for it.
 *
 * Measured labels, from files produced here and from third-party files:
 * - MPEG-2 `…04010202 01 01 11 00`
 * - AVC `…04010202 01 31 60 01`
 * - MPEG-4 part 2 `…04010202 01 20 02 04`
 * - ProRes `…04010202 03 06 01 00`
 * - VC-3 `…04010202 71 28 00 00`
 * - DV `…04010202 02 01 02 00`, JPEG 2000 `…04010202 03 01 01 00`
 *
 * DV, JPEG 2000 and MPEG-4 part 2 have no codec in this library's union, so they read as null.
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

	// VC-3 (SMPTE 2019-4) has a family of its own, and byte 13 names the compression - 0x28 in the
	// two DNxHD files here. FFmpeg compares 13 octets for it, so every kind under 0x71 is VC-3.
	// This used to look for `03 02`, a label no file carries: both DNxHD files read as codec-less.
	if (family === 0x71) {
		return 'dnxhd';
	}

	return null;
};

/**
 * The Y4M colour-space tag for an uncompressed picture descriptor, or null where this library has no
 * way to state its layout.
 *
 * `rawvideo` carries its pixel layout in the decoder config's `description`, as a Y4M tag, because an
 * uncompressed frame says nothing about itself - that is how the Y4M reader already does it. Y4M's
 * tag space is luma and YUV only, so a layout with more than one component (RGB, RGBA, and every
 * subsampled YUV layout, which states its subsampling in different fields again) has no tag to carry
 * and reads as codec-less rather than as a guess. The one uncompressed file in the corpus is an Avid
 * alpha matte whose layout is a single `A` component of 8 bits, which ffmpeg also reads as `gray`.
 */
const rawPixelTagOf = (descriptor: LocalSet): string | null => {
	const layout = descriptor.get(TAG_PIXEL_LAYOUT);
	if (!layout || layout.byteLength < 2) {
		return null;
	}

	const components: { code: number; depth: number }[] = [];
	for (let at = 0; at + 1 < layout.byteLength && layout[at] !== 0; at += 2) {
		components.push({ code: layout[at]!, depth: layout[at + 1]! });
	}

	if (components.length !== 1) {
		return null;
	}

	const { depth } = components[0]!;
	if (depth === 8) {
		return 'Cmono';
	}

	return depth === 16 ? 'Cmono16' : null;
};

/**
 * What a SoundEssenceCompression label says the essence is, or null for a compression this library
 * has no codec for.
 *
 * An absent label means uncompressed, and so does a label of all zeros - but so does `…04020201 7F`,
 * which states "uncompressed" explicitly and which reading any non-zero byte as "compressed" got
 * wrong: Apple writes it, and both of that file's tracks read as codec-less. `7E` is the same thing
 * big-endian, which FFmpeg records as coming from an Omneon file. The labels and their lengths are
 * FFmpeg's `ff_mxf_codec_uls`.
 */
const soundCodingOf = (ul: Uint8Array): 'pcm-le' | 'pcm-be' | 'alaw' | null => {
	// `060e2b34 040101?? 040202 ..`: byte 11 is 01 for the uncompressed labels and 02 for the coded
	// ones, and the bytes after it name the coding within either
	if (ul[8] !== 0x04 || ul[9] !== 0x02 || ul[10] !== 0x02) {
		return null;
	}

	if (ul[11] === 0x01) {
		if (ul[12] === 0x00 || ul[12] === 0x7f) {
			return 'pcm-le';
		}

		return ul[12] === 0x7e ? 'pcm-be' : null;
	}

	// A-law, which XDCAM proxy writes: `…040202 02 03 01 01 00`
	if (ul[11] === 0x02 && ul[12] === 0x03 && ul[13] === 0x01 && ul[14] === 0x01) {
		return 'alaw';
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
	const coding = compression && compression.byteLength >= 16 ? soundCodingOf(compression) : 'pcm-le';

	if (coding === null) {
		return null;
	}
	if (coding === 'alaw') {
		return 'alaw';
	}

	const bits = asUint(descriptor.get(TAG_QUANTIZATION_BITS) ?? new Uint8Array());
	const bigEndian = coding === 'pcm-be';
	switch (bits) {
		case 8: return 'pcm-s8';
		case 16: return bigEndian ? 'pcm-s16be' : 'pcm-s16';
		case 24: return bigEndian ? 'pcm-s24be' : 'pcm-s24';
		case 32: return bigEndian ? 'pcm-s32be' : 'pcm-s32';
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
	/**
	 * How many octets one uncompressed frame occupies, for `rawvideo` only. The stored element is
	 * padded up to the container's alignment grid and is therefore larger than this - 2,080,768 octets
	 * against 2,073,600 in the corpus file, which is 508 x 4096 - so a frame is its leading
	 * `rawFrameBytes`, exactly as ffmpeg's rawvideo decoder takes them.
	 */
	rawFrameBytes: number | null;
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

	// An absent PictureEssenceCoding means the essence is uncompressed; what it is then comes from the
	// descriptor's own pixel layout rather than from any label
	const rawTag = ul ? null : rawPixelTagOf(descriptor);
	const storedWidth = asUint(descriptor.get(TAG_STORED_WIDTH) ?? new Uint8Array());
	const storedHeight = asUint(descriptor.get(TAG_STORED_HEIGHT) ?? new Uint8Array());
	const rawFrameBytes = rawTag === null || storedWidth === 0 || storedHeight === 0
		? null
		: storedWidth * storedHeight * (rawTag === 'Cmono' ? 1 : 2);

	return {
		codec: pictureCodecOf(ul) ?? (rawTag === null ? null : 'rawvideo'),
		internalId: ul ? asKey(ul) : rawTag,
		displayWidth,
		displayHeight: frameHeight,
		codedWidth,
		codedHeight: frameHeight,
		interlaced: layout !== 0,
		rawFrameBytes,
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
