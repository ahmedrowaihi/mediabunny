/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { modEuclid } from '../misc';

export const MPEG_TS_TIMESCALE = 90_000; // MPEG-TS timestamps run on a 90 kHz clock
export const TIMESTAMP_MODULUS = 2 ** 33;
export const TS_PACKET_SIZE = 188;

export type TimestampWrapInfo = {
	reference: number;
	offset: number;
};

export const enum MpegTsStreamType {
	MP3_MPEG1 = 0x03,
	MP3_MPEG2 = 0x04,
	AAC = 0x0f,
	AC3_SYSTEM_A = 0x81,
	EAC3_SYSTEM_A = 0x87,
	DTS = 0x82,
	DTS_ATSC = 0x8a,
	BLU_RAY_DTS_HD = 0x85,
	BLU_RAY_DTS_HD_MASTER = 0x86,
	BLU_RAY_DTS_EXPRESS_SECONDARY = 0xa2,
	PRIVATE_DATA = 0x06,
	AVC = 0x1b,
	HEVC = 0x24,

	// HLS SAMPLE-AES replaces the clear stream types with these
	SAMPLE_AES_AVC = 0xdb,
	SAMPLE_AES_AAC = 0xcf,
	SAMPLE_AES_AC3 = 0xc1,
	SAMPLE_AES_EAC3 = 0xc2,
}

const fourCc = (code: string) => [...code].map(character => character.charCodeAt(0));

/**
 * `private_data_indicator_descriptor` (tag 0x0F), which is how HLS SAMPLE-AES marks an elementary
 * stream as encrypted: 'zavc' for H.264, 'aacd' for AAC, 'ac3d' and 'ec3d' for AC-3 and E-AC-3.
 * @internal
 */
export const buildPrivateDataIndicatorDescriptor = (code: string) =>
	new Uint8Array([0x0f, 0x04, ...fourCc(code)]);

/**
 * `registration_descriptor` (tag 0x05) carrying 'apad' and an `audio_setup_information()`:
 * audio_type (4), priming (2), version (1), setup_data_length (1), then setup_data. Apple requires
 * it alongside the private data indicator for an encrypted audio stream.
 * @internal
 */
export const buildAudioSetupDescriptor = (audioType: string, setupData: Uint8Array) => {
	const descriptor = new Uint8Array(2 + 4 + 8 + setupData.length);
	descriptor[0] = 0x05;
	descriptor[1] = descriptor.length - 2;
	descriptor.set(fourCc('apad'), 2);
	descriptor.set(fourCc(audioType), 6);
	// priming: Apple's encoder supplies it; 0 is the documented fallback
	descriptor[10] = 0x00;
	descriptor[11] = 0x00;
	descriptor[12] = 0x01; // version
	descriptor[13] = setupData.length;
	descriptor.set(setupData, 14);
	return descriptor;
};

export const buildMpegTsMimeType = (codecStrings: (string | null)[]) => {
	let string = 'video/MP2T';

	const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
	if (uniqueCodecStrings.length > 0) {
		string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
	}

	return string;
};

export const secondsToMpegTsTimestamp = (seconds: number) => {
	// This supports writing negative timestamps by simply Euclid-modding them. It is then up to the demuxer to
	// interpret them as negative, if it wants to.
	return modEuclid(Math.round(MPEG_TS_TIMESCALE * seconds), TIMESTAMP_MODULUS);
};

export const createTimestampWrapInfo = (firstTimestamp: number): TimestampWrapInfo => {
	const tolerance = 60 * MPEG_TS_TIMESCALE;
	return {
		reference: firstTimestamp - tolerance,
		offset: firstTimestamp >= TIMESTAMP_MODULUS - tolerance
			? -TIMESTAMP_MODULUS // Timestamps close to the modulus are treated as negative
			: TIMESTAMP_MODULUS,
	};
};

export const normalizeWrappedTimestamp = (timestamp: number, wrapInfo: TimestampWrapInfo) => {
	const { reference, offset } = wrapInfo;
	if (
		(offset < 0 && timestamp >= reference)
		|| (offset > 0 && timestamp < reference)
	) {
		return timestamp + offset;
	}

	return timestamp;
};
