/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// AMF0, which is what an FLV script data tag carries: a message name and one value, both in Adobe's
// Action Message Format. It is the only way to put timed data on an RTMP stream - `onCuePoint` for ad
// insertion markers and `onTextData` for subtitles and telemetry.
//
// Every number is a float64, including the ones that are obviously integers: AMF0 has no integer type,
// so a reader that gets an integer where it expected a number reads a different value entirely rather
// than failing.

const textEncoder = new TextEncoder();

/** AMF0 type markers. */
const NUMBER = 0x00;
const BOOLEAN = 0x01;
const STRING = 0x02;
const OBJECT = 0x03;
const NULL = 0x05;
const ECMA_ARRAY = 0x08;
const OBJECT_END = 0x09;
const STRICT_ARRAY = 0x0a;
const LONG_STRING = 0x0c;

/** A string's length is 16 bits, so anything longer is a different type. */
const MAX_SHORT_STRING = 0xffff;

/**
 * A value AMF0 can carry.
 *
 * @group \@mediabunny/server
 * @public
 */
export type AmfValue =
	| number
	| string
	| boolean
	| null
	| AmfValue[]
	| { [key: string]: AmfValue };

const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}

	return out;
};

const u16 = (value: number) => Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);

const u32 = (value: number) => Uint8Array.from([
	(value >>> 24) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 8) & 0xff,
	value & 0xff,
]);

const float64 = (value: number) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value, false);
	return bytes;
};

/** A property name, which is a bare length-prefixed string with no type marker of its own. */
const propertyName = (name: string) => {
	const bytes = textEncoder.encode(name);
	if (bytes.length > MAX_SHORT_STRING) {
		throw new Error('An AMF0 property name is at most 65535 octets.');
	}

	return concat([u16(bytes.length), bytes]);
};

/**
 * Encodes one value as AMF0.
 *
 * @internal
 */
export const encodeAmf0Value = (value: AmfValue): Uint8Array => {
	if (value === null) {
		return Uint8Array.from([NULL]);
	}

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(`AMF0 carries finite numbers only; ${String(value)} is not one.`);
		}

		return concat([Uint8Array.from([NUMBER]), float64(value)]);
	}

	if (typeof value === 'boolean') {
		return Uint8Array.from([BOOLEAN, value ? 1 : 0]);
	}

	if (typeof value === 'string') {
		const bytes = textEncoder.encode(value);
		return bytes.length > MAX_SHORT_STRING
			? concat([Uint8Array.from([LONG_STRING]), u32(bytes.length), bytes])
			: concat([Uint8Array.from([STRING]), u16(bytes.length), bytes]);
	}

	if (Array.isArray(value)) {
		return concat([
			Uint8Array.from([STRICT_ARRAY]),
			u32(value.length),
			...value.map(encodeAmf0Value),
		]);
	}

	const entries = Object.entries(value);
	return concat([
		Uint8Array.from([OBJECT]),
		...entries.flatMap(([name, property]) => [propertyName(name), encodeAmf0Value(property)]),
		// An object ends with an empty name followed by the end marker, which is why the marker alone
		// is not enough: a reader looks for the name first
		u16(0),
		Uint8Array.from([OBJECT_END]),
	]);
};

/**
 * Encodes a value as an AMF0 ECMA array - an object that states how many properties it has.
 *
 * `onMetaData` is written this way and some readers expect the same of anything beside it, so it is
 * offered rather than guessed at: the count is advisory and readers walk to the terminator regardless.
 *
 * @internal
 */
export const encodeAmf0EcmaArray = (value: Record<string, AmfValue>): Uint8Array => {
	const entries = Object.entries(value);
	return concat([
		Uint8Array.from([ECMA_ARRAY]),
		u32(entries.length),
		...entries.flatMap(([name, property]) => [propertyName(name), encodeAmf0Value(property)]),
		u16(0),
		Uint8Array.from([OBJECT_END]),
	]);
};

/**
 * The body of an FLV script data tag: the message name, then its single argument.
 *
 * @internal
 */
export const encodeAmfDataMessage = (name: string, value: AmfValue, asEcmaArray = false): Uint8Array => {
	if (!name) {
		throw new Error('An AMF data message must be named; the name is what a receiver dispatches on.');
	}

	const encoded = asEcmaArray && value !== null && typeof value === 'object' && !Array.isArray(value)
		? encodeAmf0EcmaArray(value)
		: encodeAmf0Value(value);

	return concat([encodeAmf0Value(name), encoded]);
};
