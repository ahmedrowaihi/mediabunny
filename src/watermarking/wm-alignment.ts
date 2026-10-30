/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { eachBox, parseSidxBoxContents, segmentsOf, type SidxBox } from '../isobmff/isobmff-misc';
import { variantLayoutOf, type VariantLayout } from './wm-layout';
import type { Source } from '../source';

/**
 * Why two renditions cannot be addressed by one set of byte ranges, or that they can.
 *
 * @group Watermarking
 * @public
 */
export type VariantAlignment = {
	/** Whether one set of byte ranges, and one `sidx`, addresses both renditions. */
	aligned: boolean;
	/** What differs first, or `null` when they are aligned. */
	reason: string | null;
	/** The first segment that differs, or `null` when the difference is not a segment's. */
	segmentIndex: number | null;
};

const ALIGNED: VariantAlignment = { aligned: true, reason: null, segmentIndex: null };

const notAligned = (reason: string, segmentIndex: number | null = null): VariantAlignment =>
	({ aligned: false, reason, segmentIndex });

const topLevelSidxBoxes = (bytes: Uint8Array): SidxBox[] => {
	const found: SidxBox[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	eachBox(view, 0, bytes.length, (name, contentStart, contentEnd, boxStart) => {
		if (name === 'sidx') {
			found.push(parseSidxBoxContents(
				bytes.subarray(contentStart, contentEnd), boxStart, contentEnd - boxStart,
			));
		}
	});
	return found;
};

const layoutOfBytes = (bytes: Uint8Array): VariantLayout => {
	const file = segmentsOf(bytes);
	return {
		init: file.init,
		segments: file.segments.map(segment => ({ offset: segment.offset, size: segment.size })),
		sidx: topLevelSidxBoxes(bytes).map(box => ({
			box: { offset: box.boxStart, size: box.boxSize },
			references: box.references.map(reference => ({
				referencedSize: reference.referencedSize,
				subsegmentDuration: reference.subsegmentDuration,
			})),
		})),
	};
};

/**
 * Compare two {@link VariantLayout}s. Pure and cheap, so a transport can hold a layout per
 * rendition and check a pair per request without reading either file again.
 *
 * @group Watermarking
 * @public
 */
export const layoutsAligned = (a: VariantLayout, b: VariantLayout): VariantAlignment => {
	if ((a.init === null) !== (b.init === null)) {
		return notAligned('one rendition has an init segment and the other does not');
	}
	if (a.init !== null && b.init !== null
		&& (a.init.offset !== b.init.offset || a.init.size !== b.init.size)) {
		return notAligned(
			`init segments differ: ${a.init.offset}+${a.init.size} against ${b.init.offset}+${b.init.size}`,
		);
	}

	if (a.segments.length !== b.segments.length) {
		return notAligned(`segment counts differ: ${a.segments.length} against ${b.segments.length}`);
	}
	for (let i = 0; i < a.segments.length; i++) {
		const x = a.segments[i]!;
		const y = b.segments[i]!;
		if (x.offset !== y.offset || x.size !== y.size) {
			return notAligned(`segment ${i} differs: ${x.offset}+${x.size} against ${y.offset}+${y.size}`, i);
		}
	}

	if (a.sidx.length !== b.sidx.length) {
		return notAligned(
			`one rendition carries ${a.sidx.length} sidx boxes and the other ${b.sidx.length}`,
		);
	}
	for (let i = 0; i < a.sidx.length; i++) {
		const x = a.sidx[i]!;
		const y = b.sidx[i]!;
		if (x.box.offset !== y.box.offset || x.box.size !== y.box.size) {
			return notAligned(
				`sidx ${i} sits at a different place: ${x.box.offset}+${x.box.size}`
				+ ` against ${y.box.offset}+${y.box.size}`,
			);
		}
		if (x.references.length !== y.references.length) {
			return notAligned(
				`sidx ${i} indexes ${x.references.length} subsegments against ${y.references.length}`,
			);
		}
		for (let j = 0; j < x.references.length; j++) {
			const p = x.references[j]!;
			const q = y.references[j]!;
			if (p.referencedSize !== q.referencedSize || p.subsegmentDuration !== q.subsegmentDuration) {
				return notAligned(
					`sidx ${i} reference ${j} differs: ${p.referencedSize} bytes / ${p.subsegmentDuration} ticks`
					+ ` against ${q.referencedSize} / ${q.subsegmentDuration}`,
				);
			}
		}
	}

	return ALIGNED;
};

/**
 * Derive both renditions' layouts from their sources and compare them, reading only box headers
 * rather than the media between them. This is the form a transport can use: neither rendition is
 * materialised, and a feature-length title costs about one small read per segment.
 *
 * @group Watermarking
 * @public
 */
export const sourcesAligned = async (a: Source, b: Source): Promise<VariantAlignment> => {
	let layouts;
	try {
		layouts = await Promise.all([variantLayoutOf(a), variantLayoutOf(b)]);
	} catch (error) {
		return notAligned(`a rendition could not be read as fragmented ISO BMFF: ${(error as Error).message}`);
	}
	return layoutsAligned(layouts[0], layouts[1]);
};

/**
 * Check that two renditions of the same content are byte-range aligned — that one set of byte
 * ranges, and one `sidx`, addresses both.
 *
 * A/B watermarking requires this: a device is served whichever variant its watermark pattern
 * calls for, against byte ranges published once for the content. A variant that is not aligned is
 * served at the *neutral* content's offsets and lengths, which yields the right number of bytes
 * from the wrong places — a 200 response that decodes to garbage, with nothing to attribute it to.
 * Re-encoding a variant rather than patching the original is the usual way to produce one.
 *
 * Compares the init segment's range, the number of segments, each segment's offset and length, and
 * any top-level `sidx`, naming the first thing that differs.
 *
 * @group Watermarking
 * @public
 */
export const variantsAligned = (a: Uint8Array, b: Uint8Array): VariantAlignment => {
	// Publisher-supplied bytes, so a rendition that does not parse is an answer of "no" rather than
	// an exception for the caller to handle on a verification path.
	let left, right;
	try {
		left = layoutOfBytes(a);
		right = layoutOfBytes(b);
	} catch (error) {
		return notAligned(`a rendition could not be read as fragmented ISO BMFF: ${(error as Error).message}`);
	}
	return layoutsAligned(left, right);
};
