/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/media/base/fourccs.h
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * Convert a 32-bit FourCC code into its 4-character ASCII string representation.
 * Mirrors shaka's `FourCCToString` from `media/base/fourccs.h`. Bytes are taken
 * big-endian (MSB first), matching the way shaka stores FourCCs as `uint32`.
 *
 * Example: `0x64623467` → `'db4g'`
 *
 * @group DASH
 * @public
 */
export const fourCCToString = (fourcc: number): string => {
	const b0 = (fourcc >>> 24) & 0xff;
	const b1 = (fourcc >>> 16) & 0xff;
	const b2 = (fourcc >>> 8) & 0xff;
	const b3 = fourcc & 0xff;
	return String.fromCharCode(b0, b1, b2, b3);
};
