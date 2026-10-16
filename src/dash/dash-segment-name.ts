/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/media/base/muxer_util.{h,cc}
 *   (GetSegmentName helper)
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * Apply a printf-style format spec to an unsigned integer. Mirrors the
 * subset of `absl::FormatUntyped` shaka uses: zero-padding (`%0Nd`),
 * unpadded (`%d`, `%u`), and the `%01d` default. Bare `%d` and `%u` are
 * treated equivalently. Throws on unsupported format specs.
 *
 * @internal
 */
const formatUInt = (formatTag: string, value: number): string => {
	// formatTag is shaped like '%01d', '%05d', '%d', '%u', etc.
	const match = /^%0?(\d*)[du]$/.exec(formatTag);
	if (!match) {
		throw new Error(`Unsupported format tag in segment template: "${formatTag}"`);
	}
	const width = match[1] ? parseInt(match[1], 10) : 0;
	const str = value.toString();
	if (width <= str.length) {
		return str;
	}
	// `%01d` / `%d` / `%u` zero-pad with leading zeros when the spec begins
	// with `%0`. Plain `%5d` (no zero) would space-pad, but shaka's templates
	// only use the zero-padded form so we follow that.
	return str.padStart(width, '0');
};

/**
 * Substitute `$Number$`, `$Time$`, `$Bandwidth$` placeholders inside a DASH
 * segment template string. Each identifier accepts an optional printf-style
 * format spec, e.g. `$Number%05d$`. Mirrors shaka-packager's `GetSegmentName`
 * helper from `media/base/muxer_util.cc`.
 *
 * - `$$` is the escape sequence for a literal `$`.
 * - Unknown identifiers throw — shaka uses a `DCHECK` here.
 *
 * @group DASH
 * @public
 */
export const getSegmentName = (
	segmentTemplate: string,
	segmentStartTime: number,
	segmentNumber: number,
	bandwidth: number,
): string => {
	const splits = segmentTemplate.split('$');
	if (splits.length % 2 !== 1) {
		throw new Error(`Invalid segment template "${segmentTemplate}": unbalanced "$"`);
	}

	let segmentName = '';
	for (let i = 0; i < splits.length; i++) {
		const part = splits[i]!;
		// Even indices are non-identifier text; copy verbatim.
		if (i % 2 === 0) {
			segmentName += part;
			continue;
		}
		// Odd indices are inside `$...$`. Empty means `$$` → literal `$`.
		if (part.length === 0) {
			segmentName += '$';
			continue;
		}
		const formatPos = part.indexOf('%');
		const identifier = formatPos === -1 ? part : part.slice(0, formatPos);
		// Default format is `%01d` per shaka.
		const formatTag = formatPos === -1 ? '%01d' : part.slice(formatPos);

		let value: number;
		switch (identifier) {
			case 'Number':
				value = segmentNumber;
				break;
			case 'Time':
				value = segmentStartTime;
				break;
			case 'Bandwidth':
				value = bandwidth;
				break;
			default:
				throw new Error(`Unknown segment-template identifier: "${identifier}"`);
		}
		segmentName += formatUInt(formatTag, value);
	}
	return segmentName;
};
