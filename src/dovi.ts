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
 * transfer characteristics (`14` = HLG). Returns `null` when there is no compatible brand. Mirrors
 * shaka's `GetDoViCompatibleBrand`.
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
