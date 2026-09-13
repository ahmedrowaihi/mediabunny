/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { measureBox, MutableBox, parseBoxes, serializeBoxes } from './crypto/box-tree';
import { textEncoder } from './misc';

/**
 * An Event Message (`emsg`) box, as defined by ISO/IEC 23009-1 §5.10.3.3. Carries a timed event —
 * an SCTE-35 splice, an ID3 tag, an application cue — alongside the media it belongs to.
 *
 * @group Miscellaneous
 * @public
 */
export type EmsgOptions = {
	/** The scheme the event belongs to, e.g. `'urn:scte:scte35:2013:bin'`. */
	schemeIdUri: string;
	/** Scheme-specific value. Defaults to the empty string. */
	value?: string;
	/** Ticks per second that {@link EmsgOptions.presentationTime} and the duration are stated in. */
	timescale: number;
	/**
	 * The event's time on the media timeline, writing a version 1 box. State exactly one of this and
	 * {@link EmsgOptions.presentationTimeDelta}.
	 */
	presentationTime?: number;
	/**
	 * The event's time relative to the segment's earliest presentation time, writing a version 0 box.
	 * State exactly one of this and {@link EmsgOptions.presentationTime}.
	 */
	presentationTimeDelta?: number;
	/** Event duration in `timescale` ticks. `0xffffffff` states an unknown duration. */
	eventDuration: number;
	/** Identifier, unique within the scheme and value. */
	id: number;
	/** The event payload, e.g. an SCTE-35 splice_info_section. Defaults to empty. */
	messageData?: Uint8Array;
};

const nullTerminated = (text: string): number[] => [...textEncoder.encode(text), 0];

const u32Bytes = (value: number): number[] => [
	(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
];

const u64Bytes = (value: number): number[] => {
	const big = BigInt(value);
	return Array.from({ length: 8 }, (_, i) => Number((big >> BigInt(56 - i * 8)) & 0xffn));
};

/**
 * Build an Event Message (`emsg`) box. Pair with {@link insertBoxesBeforeMoof} to place it into an
 * already-packaged segment.
 *
 * @group Miscellaneous
 * @public
 */
export const buildEmsgBox = (options: EmsgOptions): Uint8Array => {
	const { presentationTime, presentationTimeDelta } = options;
	if ((presentationTime === undefined) === (presentationTimeDelta === undefined)) {
		throw new TypeError('Exactly one of presentationTime and presentationTimeDelta must be stated.');
	}
	if (!Number.isInteger(options.timescale) || options.timescale <= 0) {
		throw new TypeError('timescale must be a positive integer.');
	}

	const value = options.value ?? '';
	const messageData = options.messageData ?? new Uint8Array(0);
	const body = presentationTime !== undefined
		? [
				1, 0, 0, 0,
				...u32Bytes(options.timescale),
				...u64Bytes(presentationTime),
				...u32Bytes(options.eventDuration),
				...u32Bytes(options.id),
				...nullTerminated(options.schemeIdUri),
				...nullTerminated(value),
				...messageData,
			]
		: [
				0, 0, 0, 0,
				...nullTerminated(options.schemeIdUri),
				...nullTerminated(value),
				...u32Bytes(options.timescale),
				...u32Bytes(presentationTimeDelta!),
				...u32Bytes(options.eventDuration),
				...u32Bytes(options.id),
				...messageData,
			];

	return Uint8Array.from([...u32Bytes(8 + body.length), 0x65, 0x6d, 0x73, 0x67, ...body]);
};

// first_offset spans from the end of the sidx to the first fragment, so anything inserted between
// them lengthens it. The fragments themselves are untouched, so referenced_size stays as it is.
const growSidxFirstOffset = (sidx: MutableBox, added: number): void => {
	const data = sidx.data;
	if (data === undefined) {
		return;
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const position = data[0] === 0 ? 16 : 20;
	if (data[0] === 0) {
		view.setUint32(position, view.getUint32(position) + added);
	} else {
		view.setBigUint64(position, view.getBigUint64(position) + BigInt(added));
	}
};

/**
 * Insert complete top-level boxes into an already-packaged segment, immediately before its first
 * `moof`, and restate any preceding `sidx` so it still names the fragments that follow. Use it to
 * add an {@link buildEmsgBox | `emsg`} to a segment this library — or anything else — already wrote.
 *
 * @group Miscellaneous
 * @public
 */
export const insertBoxesBeforeMoof = (segment: Uint8Array, boxes: Uint8Array[]): Uint8Array => {
	if (boxes.length === 0) {
		return segment;
	}

	const parsed = parseBoxes(segment, 0, segment.length);
	const moofIndex = parsed.findIndex(box => box.type === 'moof');
	if (moofIndex === -1) {
		throw new Error('The segment has no moof to insert before.');
	}

	const inserted = boxes.map((bytes) => {
		const boxList = parseBoxes(bytes, 0, bytes.length);
		if (boxList.length !== 1) {
			throw new Error('Each entry must be exactly one complete top-level box.');
		}
		return boxList[0]!;
	});

	const added = inserted.reduce((total, box) => total + measureBox(box), 0);
	for (let i = 0; i < moofIndex; i++) {
		if (parsed[i]!.type === 'sidx') {
			growSidxFirstOffset(parsed[i]!, added);
		}
	}

	parsed.splice(moofIndex, 0, ...inserted);
	return serializeBoxes(parsed);
};
