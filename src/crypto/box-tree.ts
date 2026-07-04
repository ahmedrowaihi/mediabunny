/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** A parsed ISOBMFF box that can be mutated and re-serialized (sizes are recomputed). */
export type MutableBox = {
	type: string;
	/** Leaf payload (absent for pure containers). For sample entries this is the fixed prefix. */
	data?: Uint8Array;
	/** Child boxes (absent for leaves). */
	children?: MutableBox[];
};

// Pure container boxes whose payload is entirely child boxes.
const CONTAINERS = new Set([
	'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'mfra', 'sinf', 'schi', 'udta',
]);
// Sample-entry containers: a fixed-size prefix followed by child boxes.
const SAMPLE_ENTRY_PREFIX: Record<string, number> = {
	avc1: 78, avc3: 78, hvc1: 78, hev1: 78, encv: 78,
	mp4a: 28, enca: 28,
};

const readU32 = (bytes: Uint8Array, offset: number): number =>
	((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

const boxType = (bytes: Uint8Array, offset: number): string =>
	String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);

/** Parse a range of bytes into a list of boxes, recursing into known containers. */
export const parseBoxes = (bytes: Uint8Array, start: number, end: number): MutableBox[] => {
	const boxes: MutableBox[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = readU32(bytes, offset);
		const type = boxType(bytes, offset + 4);
		let headerSize = 8;
		if (size === 1) {
			// 64-bit size — not expected in these fragments; read low 32 bits.
			size = readU32(bytes, offset + 12);
			headerSize = 16;
		} else if (size === 0) {
			size = end - offset;
		}
		const contentStart = offset + headerSize;
		const contentEnd = offset + size;
		const sampleEntryPrefix = SAMPLE_ENTRY_PREFIX[type];

		if (CONTAINERS.has(type)) {
			boxes.push({ type, children: parseBoxes(bytes, contentStart, contentEnd) });
		} else if (type === 'stsd') {
			// FullBox(4) + entry_count(4), then sample entries as children.
			boxes.push({
				type,
				data: bytes.slice(contentStart, contentStart + 8),
				children: parseBoxes(bytes, contentStart + 8, contentEnd),
			});
		} else if (sampleEntryPrefix !== undefined) {
			const prefix = sampleEntryPrefix;
			boxes.push({
				type,
				data: bytes.slice(contentStart, contentStart + prefix),
				children: parseBoxes(bytes, contentStart + prefix, contentEnd),
			});
		} else {
			boxes.push({ type, data: bytes.slice(contentStart, contentEnd) });
		}
		offset = contentEnd;
	}
	return boxes;
};

/** Total serialized byte length of a box (with recomputed size). */
export const measureBox = (box: MutableBox): number => {
	let size = 8 + (box.data?.byteLength ?? 0);
	if (box.children) {
		for (const child of box.children) {
			size += measureBox(child);
		}
	}
	return size;
};

/** Serialize a box (and its children) to bytes, writing the correct size header. */
export const serializeBox = (box: MutableBox): Uint8Array => {
	const size = measureBox(box);
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, size);
	out.set([...box.type].map(c => c.charCodeAt(0)), 4);
	let offset = 8;
	if (box.data) {
		out.set(box.data, offset);
		offset += box.data.byteLength;
	}
	if (box.children) {
		for (const child of box.children) {
			const childBytes = serializeBox(child);
			out.set(childBytes, offset);
			offset += childBytes.byteLength;
		}
	}
	return out;
};

/** Serialize a top-level box list to a single buffer. */
export const serializeBoxes = (boxes: MutableBox[]): Uint8Array => {
	const parts = boxes.map(serializeBox);
	const total = parts.reduce((s, p) => s + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
};

/** Depth-first find of the first box of `type`. */
export const findBox = (boxes: MutableBox[], type: string): MutableBox | null => {
	for (const box of boxes) {
		if (box.type === type) {
			return box;
		}
		if (box.children) {
			const found = findBox(box.children, type);
			if (found !== null) {
				return found;
			}
		}
	}
	return null;
};
