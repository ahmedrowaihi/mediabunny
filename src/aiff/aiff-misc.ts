/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// AIFF is IFF, so it is RIFF's big-endian elder: `FORM` instead of `RIFF`, chunk sizes big-endian,
// and samples big-endian unless a compression type says otherwise.
//
// The one field that is not a plain integer is the sample rate, which AIFF states as an 80-bit IEEE 754
// extended float - a format no JavaScript runtime has. Unlike the 32- and 64-bit ones its mantissa
// carries an EXPLICIT integer bit rather than an implied one, so the usual "or in the leading 1" is
// wrong here and would put every rate out by a factor of two.

import { Writer } from '../writer';
import { FileSlice, readBytes } from '../reader';
import { textEncoder } from '../misc';

/** The exponent of a value of 1: an 80-bit extended float's exponent is excess-16383. */
const EXTENDED_EXPONENT_BIAS = 16383;

/** The mantissa is 64 bits wide, with its integer bit at the top. */
const EXTENDED_MANTISSA_BITS = 64;

/** Reads the 80-bit IEEE 754 extended float AIFF states its sample rate as. */
export const readExtendedFloat80 = (slice: FileSlice): number => {
	const bytes = readBytes(slice, 10);
	const sign = (bytes[0]! & 0x80) !== 0 ? -1 : 1;
	const exponent = ((bytes[0]! & 0x7f) << 8) | bytes[1]!;

	let mantissa = 0n;
	for (let i = 2; i < 10; i++) {
		mantissa = (mantissa << 8n) | BigInt(bytes[i]!);
	}

	if (exponent === 0 && mantissa === 0n) {
		return 0;
	}

	// 0x7fff is an infinity or a NaN, neither of which is a sample rate
	if (exponent === 0x7fff) {
		return 0;
	}

	const scale = exponent - EXTENDED_EXPONENT_BIAS - (EXTENDED_MANTISSA_BITS - 1);
	return sign * Number(mantissa) * 2 ** scale;
};

/** Writes a positive, finite number as the 80-bit IEEE 754 extended float AIFF wants. */
export const writeExtendedFloat80 = (writer: Writer, value: number) => {
	const bytes = new Uint8Array(10);

	if (value > 0 && Number.isFinite(value)) {
		const exponent = Math.floor(Math.log2(value));
		// The integer bit is explicit, so the mantissa is the value scaled until its bit 63 is the one
		const mantissa = BigInt(Math.round(value * 2 ** (EXTENDED_MANTISSA_BITS - 1 - exponent)));
		const biased = exponent + EXTENDED_EXPONENT_BIAS;

		bytes[0] = (biased >> 8) & 0x7f;
		bytes[1] = biased & 0xff;
		for (let i = 0; i < 8; i++) {
			bytes[2 + i] = Number((mantissa >> BigInt(8 * (7 - i))) & 0xffn);
		}
	}

	writer.write(bytes);
};

/** @internal */
export class AiffWriter {
	private helper = new Uint8Array(8);
	private helperView = new DataView(this.helper.buffer);

	constructor(private writer: Writer) {}

	writeU16(value: number) {
		this.helperView.setUint16(0, value, false);
		this.writer.write(this.helper.subarray(0, 2));
	}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeAscii(text: string) {
		this.writer.write(textEncoder.encode(text));
	}

	/** A Pascal string: a length octet, the text, then a pad octet to an even total. */
	writePascalString(text: string) {
		const bytes = textEncoder.encode(text);
		const padded = (1 + bytes.length) % 2 === 0 ? bytes.length : bytes.length + 1;
		const out = new Uint8Array(1 + padded);
		out[0] = bytes.length;
		out.set(bytes, 1);
		this.writer.write(out);
	}
}
