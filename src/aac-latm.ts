/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// LOAS/LATM framing for AAC, ISO/IEC 14496-3 §1.7.3: the carriage MPEG-TS stream type 0x11 names, and
// what European broadcast feeds use instead of ADTS.
//
// Two things make it unlike ADTS. The `StreamMuxConfig` embeds the **AudioSpecificConfig itself**, so
// the configuration travels in the stream rather than beside it - and it is embedded as an exact run of
// BITS, so the number of bits the config occupies has to be known, not guessed. And the payload is
// written **unaligned**, continuing from wherever the config left off, so the whole frame is one bit
// stream rather than a header followed by bytes.
//
// The layout follows ffmpeg's `libavformat/latmenc.c` field for field, which is the reference every
// decoder is tested against.

import { Bitstream } from '../shared/bitstream';
import type { AacAudioSpecificConfig } from '../shared/aac-misc';

/** `AudioSyncStream`'s syncword, 11 bits. */
const LOAS_SYNCWORD = 0x2b7;

/** 13 bits of `audioMuxLengthBytes`. */
const MAX_AUDIO_MUX_LENGTH = 0x1fff;

/**
 * Object types whose `AudioSpecificConfig` this can measure, and so embed.
 *
 * ffmpeg refuses anything above AOT 5 (`"Muxing MPEG-4 AOT %d in LATM is not supported"`), and the
 * reason to refuse rather than try is that the config goes in as a bit run: a length that is wrong by
 * one bit does not corrupt the config, it shifts every field after it - `frameLengthType`,
 * `latmBufferFullness` - and the frame decodes as something else entirely.
 */
const MEASURABLE_OBJECT_TYPES = new Set([1, 2, 3, 4, 5]);

/**
 * How many bits of the `AudioSpecificConfig` belong in a `StreamMuxConfig`.
 *
 * This is ffmpeg's `off + 3`: the config's own header, plus the three `GASpecificConfig` bits
 * (`frameLengthFlag`, `dependsOnCoreCoder`, `extensionFlag`) that follow it when the stream is neither
 * scalable nor dependent on a core coder.
 *
 * @internal
 */
export const audioSpecificConfigBitLength = (description: Uint8Array): number => {
	const bitstream = new Bitstream(description);

	const readObjectType = () => {
		const value = bitstream.readBits(5);
		return value === 31 ? 32 + bitstream.readBits(6) : value;
	};
	const readSamplingFrequency = () => {
		if (bitstream.readBits(4) === 0x0f) {
			bitstream.skipBits(24); // samplingFrequency
		}
	};

	const objectType = readObjectType();
	readSamplingFrequency();
	const channelConfiguration = bitstream.readBits(4);

	if (objectType === 5 || objectType === 29) {
		// Explicit hierarchical signalling: the output rate and the core coder follow
		readSamplingFrequency();
		if (readObjectType() === 22) {
			bitstream.skipBits(4); // extensionChannelConfiguration
		}
	}

	if (!MEASURABLE_OBJECT_TYPES.has(objectType) && objectType !== 29) {
		throw new Error(
			`AAC object type ${objectType} cannot be written as LATM: the StreamMuxConfig embeds the`
			+ ' AudioSpecificConfig as an exact run of bits, and this object type\'s config length is not'
			+ ' modelled here. Write ADTS framing instead.',
		);
	}
	if (channelConfiguration === 0) {
		// A program config element follows, whose length depends on the element lists inside it
		throw new Error(
			'An AAC stream whose channelConfiguration is 0 carries a program config element, which this'
			+ ' LATM writer does not measure. Write ADTS framing instead.',
		);
	}

	return bitstream.pos + 3;
};

/**
 * Writes one `AudioSyncStream` frame around an AAC access unit.
 *
 * `statesConfig` is false for every frame but the first, which sets `useSameStreamMux` and leaves the
 * configuration out — the decoder keeps the one it has. A receiver that joins mid-stream has to wait for
 * a frame that carries it, which is why `configInterval` exists on the caller's side.
 *
 * @internal
 */
export const buildLoasFrame = (
	accessUnit: Uint8Array,
	description: Uint8Array,
	configBitLength: number,
	statesConfig: boolean,
): Uint8Array => {
	// The frame is one bit stream: config bits, then the length info, then the payload unaligned behind
	// it. 3 octets of LOAS header, and a generous bound for everything after it.
	const buffer = new Uint8Array(3 + description.byteLength + accessUnit.byteLength + 16);
	const writer = new Bitstream(buffer);
	writer.seekToByte(3);

	writer.writeBits(1, statesConfig ? 0 : 1); // useSameStreamMux

	if (statesConfig) {
		writer.writeBits(1, 0); // audioMuxVersion
		writer.writeBits(1, 1); // allStreamsSameTimeFraming
		writer.writeBits(6, 0); // numSubFrames
		writer.writeBits(4, 0); // numProgram
		writer.writeBits(3, 0); // numLayer

		writer.copyBits(configBitLength, new Bitstream(description));

		writer.writeBits(3, 0); // frameLengthType: the length is stated per frame, below
		writer.writeBits(8, 0xff); // latmBufferFullness: unknown
		writer.writeBits(1, 0); // otherDataPresent
		writer.writeBits(1, 0); // crcCheckPresent
	}

	// PayloadLengthInfo for frameLengthType 0: 0xff for each whole 255 octets, then the remainder
	let remaining = accessUnit.byteLength;
	while (remaining >= 255) {
		writer.writeBits(8, 255);
		remaining -= 255;
	}
	writer.writeBits(8, remaining);

	// PayloadMux, bit-aligned to whatever precedes it rather than to an octet
	writer.copyBits(8 * accessUnit.byteLength, new Bitstream(accessUnit));

	// Whatever is left of the last octet is zero, which is what flushing a bit writer leaves
	const length = Math.ceil(writer.pos / 8) - 3;
	if (length > MAX_AUDIO_MUX_LENGTH) {
		throw new Error(
			`A LATM frame of ${length} octets exceeds the 13-bit audioMuxLengthBytes field, whose maximum`
			+ ` is ${MAX_AUDIO_MUX_LENGTH}. The access unit is too large for this carriage.`,
		);
	}

	// `audioMuxLengthBytes` counts the octets after the 3-octet header: syncword 0x2b7 in 11 bits, then
	// the length's 13, which is why the second octet carries 3 bits of syncword and 5 of length
	buffer[0] = LOAS_SYNCWORD >> 3;
	buffer[1] = ((LOAS_SYNCWORD & 0b111) << 5) | ((length >> 8) & 0x1f);
	buffer[2] = length & 0xff;

	return buffer.subarray(0, 3 + length);
};

/**
 * Reads back the frames of a LOAS stream: where each starts and how long its payload says it is.
 *
 * @internal
 */
export const iterateLoasFrames = function* (bytes: Uint8Array): Generator<{ start: number; length: number }> {
	let pos = 0;

	while (pos + 3 <= bytes.length) {
		const syncword = (bytes[pos]! << 3) | (bytes[pos + 1]! >> 5);
		if (syncword !== LOAS_SYNCWORD) {
			pos++;
			continue;
		}

		const length = ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
		if (pos + 3 + length > bytes.length) {
			return;
		}

		yield { start: pos, length };
		pos += 3 + length;
	}
};

/** @internal */
export type AacLatmConfig = {
	description: Uint8Array;
	configBitLength: number;
	/** Reported so a caller can refuse a config the framing cannot carry before writing anything. */
	parsed: AacAudioSpecificConfig;
};
