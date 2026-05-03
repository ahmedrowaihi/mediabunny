/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2018 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/tag.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * Builds an HLS tag with a comma-separated argument list, matching the format
 * defined by RFC 8216 §4.3 (e.g. `#EXT-X-STREAM-INF:KEY1=VAL1,KEY2="VAL2"`).
 *
 * Use {@link Tag.addString} / {@link Tag.addQuotedString} / {@link Tag.addNumber} /
 * {@link Tag.addFloat} / {@link Tag.addNumberPair} / {@link Tag.addQuotedNumberPair}
 * to append fields in order, then {@link Tag.toString} to obtain the rendered tag.
 *
 * @group HLS
 * @public
 */
export class Tag {
	/** @internal */
	private result: string;
	/** @internal */
	private fields = 0;

	constructor(name: string) {
		this.result = `${name}:`;
	}

	/** Append a non-quoted string value. */
	addString(key: string, value: string): this {
		this.nextField();
		this.result += `${key}=${value}`;
		return this;
	}

	/** Append a quoted string value. */
	addQuotedString(key: string, value: string): this {
		this.nextField();
		this.result += `${key}="${value}"`;
		return this;
	}

	/** Append a non-quoted integer value. */
	addNumber(key: string, value: number): this {
		this.nextField();
		this.result += `${key}=${value}`;
		return this;
	}

	/** Append a non-quoted float value formatted with 3 decimal places. */
	addFloat(key: string, value: number): this {
		this.nextField();
		this.result += `${key}=${value.toFixed(3)}`;
		return this;
	}

	/** Append a pair of numbers separated by `separator` (e.g. `RESOLUTION=1920x1080`). */
	addNumberPair(key: string, number1: number, separator: string, number2: number): this {
		this.nextField();
		this.result += `${key}=${number1}${separator}${number2}`;
		return this;
	}

	/** Append a quoted pair of numbers separated by `separator` (e.g. `BYTERANGE="123@456"`). */
	addQuotedNumberPair(
		key: string,
		number1: number,
		separator: string,
		number2: number,
	): this {
		this.nextField();
		this.result += `${key}="${number1}${separator}${number2}"`;
		return this;
	}

	/** Returns the rendered tag (without trailing newline). */
	toString(): string {
		return this.result;
	}

	/** @internal */
	private nextField(): void {
		if (this.fields++ > 0) {
			this.result += ',';
		}
	}
}
