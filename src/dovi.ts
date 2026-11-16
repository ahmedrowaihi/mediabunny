/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2019 Google LLC. All rights reserved.
 * Original source: shaka-packager/packager/media/codecs/dovi_decoder_configuration_record.cc
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Bitstream } from '../shared/bitstream';

/**
 * A parsed Dolby Vision configuration record (the payload of a `dvcC` / `dvvC` box).
 *
 * @group Codecs
 * @public
 */
export type DoviConfig = {
	/** Dolby Vision profile (e.g. 5, 8). */
	profile: number;
	/** Dolby Vision level. */
	level: number;
	/** Base-layer signal cross-compatibility ID, selects the compatible brand. */
	blSignalCompatibilityId: number;
	/** Whether an RPU (reference processing unit) substream is present. */
	rpuPresent: boolean;
	/** Whether an enhancement-layer substream is present. */
	elPresent: boolean;
	/** Whether a base-layer substream is present. */
	blPresent: boolean;
};

/**
 * Parse a Dolby Vision configuration record (`dvcC` / `dvvC` box payload). Returns `null` if it is
 * not a version-1.0 record. Mirrors shaka-packager's `DOVIDecoderConfigurationRecord::Parse`
 * (Dolby Vision Streams Within the ISO Base Media File Format v2.0).
 *
 * @group Codecs
 * @public
 */
export const parseDoviConfigRecord = (data: Uint8Array): DoviConfig | null => {
	if (data.length < 5) {
		return null;
	}
	const bitstream = new Bitstream(data);
	const majorVersion = bitstream.readBits(8);
	const minorVersion = bitstream.readBits(8);
	if (majorVersion !== 1 || minorVersion !== 0) {
		return null;
	}
	const profile = bitstream.readBits(7);
	const level = bitstream.readBits(6);
	const rpuPresent = bitstream.readBits(1) !== 0;
	const elPresent = bitstream.readBits(1) !== 0;
	const blPresent = bitstream.readBits(1) !== 0;
	const blSignalCompatibilityId = bitstream.readBits(4);
	return { profile, level, blSignalCompatibilityId, rpuPresent, elPresent, blPresent };
};

/**
 * Build the Dolby Vision codec string — `{fourcc}.{profile}.{level}`, each zero-padded to 2 digits
 * (e.g. `dvhe.05.06`). Mirrors shaka's `GetCodecString`. `fourcc` is the DoVi sample entry / codec
 * FourCC (`dvhe`, `dvh1`, `dvav`, `dvc1`, `hev1`, `hvc1`, …).
 *
 * @group Codecs
 * @public
 */
export const doviCodecString = (fourcc: string, config: DoviConfig): string => {
	const pad = (n: number) => n.toString().padStart(2, '0');
	return `${fourcc}.${pad(config.profile)}.${pad(config.level)}`;
};

/**
 * Derive the Dolby Vision compatible-brand FourCC from the base-layer signal-compatibility ID and the
 * transfer characteristics (ITU-T H.273: `14` is BT.2020 10-bit, `18` is HLG). Returns `null` when there
 * is no compatible brand. Mirrors shaka's `GetDoViCompatibleBrand`.
 *
 * @group Codecs
 * @public
 */
export const doviCompatibleBrand = (config: DoviConfig, transferCharacteristics: number): string | null => {
	switch (config.blSignalCompatibilityId) {
		case 1:
			return 'db1p';
		case 2:
			return 'db2g';
		case 4:
			return transferCharacteristics === 14 ? 'db4g' : 'db4h';
		default:
			return null;
	}
};

/**
 * The configuration box a Dolby Vision profile is carried in: `dvcC` up to profile 7, `dvvC` for
 * profiles 8 to 10, `dvwC` above that (Dolby Vision Streams Within the ISO Base Media File Format).
 *
 * @group Codecs
 * @public
 */
export const doviConfigBoxName = (config: DoviConfig): 'dvcC' | 'dvvC' | 'dvwC' => {
	if (config.profile <= 7) {
		return 'dvcC';
	}
	if (config.profile <= 10) {
		return 'dvvC';
	}

	return 'dvwC';
};

/**
 * Serialize a {@link DoviConfig} back into the 24-byte configuration record that `dvcC` / `dvvC` /
 * `dvwC` carries.
 *
 * @group Codecs
 * @public
 */
export const serializeDoviConfigRecord = (config: DoviConfig): Uint8Array => {
	const data = new Uint8Array(24);
	data[0] = 1; // dv_version_major
	data[1] = 0; // dv_version_minor
	data[2] = (config.profile << 1) | ((config.level >> 5) & 1);
	data[3] = ((config.level & 0b11111) << 3)
		| (config.rpuPresent ? 0b100 : 0)
		| (config.elPresent ? 0b10 : 0)
		| (config.blPresent ? 1 : 0);
	data[4] = config.blSignalCompatibilityId << 4;
	return data;
};

/** Sample entry FourCCs per codec, each pair stated as `[outOfBand, inBand]` (ISO/IEC 14496-15 §5.2). */
const SAMPLE_ENTRIES = {
	hevc: { plain: ['hvc1', 'hev1'], dolby: ['dvh1', 'dvhe'] },
	avc: { plain: ['avc1', 'avc3'], dolby: ['dva1', 'dvav'] },
} as const;

const sampleEntryFourCc = (
	codec: 'avc' | 'hevc',
	kind: 'plain' | 'dolby',
	inBandParameterSets: boolean,
): string => SAMPLE_ENTRIES[codec][kind][inBandParameterSets ? 1 : 0];

/**
 * The sample entry FourCC a Dolby Vision track uses. A stream whose base layer is cross-compatible
 * (`blSignalCompatibilityId` other than 0) keeps the plain `hvc1` / `hev1` / `avc1` / `avc3` entry so
 * a non-DV player can decode it; a non-compatible one (profile 5) must state the Dolby entry.
 *
 * @group Codecs
 * @public
 */
export const doviSampleEntryFourCc = (
	codec: 'avc' | 'hevc',
	config: DoviConfig,
	inBandParameterSets: boolean,
): string => sampleEntryFourCc(
	codec,
	config.blSignalCompatibilityId === 0 ? 'dolby' : 'plain',
	inBandParameterSets,
);

/**
 * The FourCC a Dolby Vision codec string uses, which is always the Dolby one — unlike
 * {@link doviSampleEntryFourCc}, whose answer for a cross-compatible stream is the base entry so a
 * non-DV player can decode it. This is what `SUPPLEMENTAL-CODECS` and DASH's
 * `scte214:supplementalCodecs` name, and what a non-compatible stream states as its own codec.
 *
 * @group Codecs
 * @public
 */
export const doviSupplementalFourCc = (
	codec: 'avc' | 'hevc',
	inBandParameterSets: boolean,
): string => sampleEntryFourCc(codec, 'dolby', inBandParameterSets);

/** The record states each of these in the given number of bits, so a larger value cannot be written. */
const RECORD_FIELD_BITS = { profile: 7, level: 6, blSignalCompatibilityId: 4 } as const;

/** @internal */
export const validateDoviConfig = (config: DoviConfig, prefix: string): void => {
	if (!config || typeof config !== 'object') {
		throw new TypeError(`${prefix} must be an object.`);
	}
	for (const [field, bits] of Object.entries(RECORD_FIELD_BITS)) {
		const value = config[field as keyof typeof RECORD_FIELD_BITS];
		if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
			throw new TypeError(`${prefix}.${field} must be an integer the record's ${bits} bits can hold.`);
		}
	}
	for (const field of ['rpuPresent', 'elPresent', 'blPresent'] as const) {
		if (typeof config[field] !== 'boolean') {
			throw new TypeError(`${prefix}.${field} must be a boolean.`);
		}
	}
};

/**
 * HEVC NAL unit type 62, which is where a Dolby Vision RPU rides (ITU-T H.265 reserves 48–63).
 * @internal
 */
export const HEVC_DOVI_RPU_NAL_TYPE = 62;

/**
 * The RPU as a complete HEVC NAL unit, from bytes that may or may not already carry the two-byte NAL
 * header: libavcodec's `AV_FRAME_DATA_DOVI_RPU_BUFFER` and a NAL read straight out of an access unit
 * differ on that, so the header is detected rather than assumed.
 *
 * @internal
 */
export const dolbyVisionRpuNalUnit = (payload: Uint8Array): Uint8Array => {
	if (payload.length >= 2 && (payload[0]! >> 1) === HEVC_DOVI_RPU_NAL_TYPE) {
		return payload;
	}

	const nalUnit = new Uint8Array(payload.length + 2);
	nalUnit[0] = HEVC_DOVI_RPU_NAL_TYPE << 1;
	nalUnit[1] = 1; // nuh_layer_id 0, nuh_temporal_id_plus1 1
	nalUnit.set(payload, 2);
	return nalUnit;
};
