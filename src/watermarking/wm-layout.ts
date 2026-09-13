/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseSidxBoxContents } from '../isobmff/isobmff-misc';
import type { Source } from '../source';

/** Read this much at each box boundary, so a `moof` header and the `mdat` after it come together. */
const HEADER_WINDOW = 4096;

/** A byte range within a rendition. @group Watermarking @public */
export type LayoutRange = {
	/** Offset of the first byte. */
	offset: number;
	/** Size in bytes. */
	size: number;
};

/**
 * A rendition's addressable structure: what byte ranges exist, without the media behind them.
 *
 * Small enough to cache beside a source and compare per request, which is what separates it from
 * holding two renditions in memory. Derive it once per rendition with {@link variantLayoutOf}, then
 * compare with {@link layoutsAligned}.
 *
 * @group Watermarking
 * @public
 */
export type VariantLayout = {
	/** The init segment's range, or `null` when the rendition carries none. */
	init: LayoutRange | null;
	/** The media segments that follow, in order. */
	segments: LayoutRange[];
	/** Every top-level `sidx`, with the part of each that has to match between variants. */
	sidx: {
		/** Where the box sits and how large it is. */
		box: LayoutRange;
		/** One entry per referenced subsegment, in order. */
		references: {
			/** Size of the referenced subsegment in bytes. */
			referencedSize: number;
			/** Duration of the referenced subsegment, in the index's timescale. */
			subsegmentDuration: number;
		}[];
	}[];
};

/** Boxes that open a segment ahead of the `moof` they precede. Mirrors `segmentsOf`. */
const SEGMENT_PRELUDE = new Set(['styp', 'sidx', 'prft', 'emsg']);

type BoxHeader = { type: string; start: number; size: number };

/**
 * Derive a rendition's {@link VariantLayout} by seeking its box headers, reading only those rather
 * than the media between them. A feature-length rendition can be described without materialising
 * it, which is what makes the result usable from a transport.
 *
 * Costs roughly one small read per fragment, since a `moof` header and the `mdat` after it fall in
 * the same window. Over a URL source that is still a request per fragment, so derive once per
 * rendition and cache the result rather than calling this per request.
 *
 * Segments the file exactly as `segmentsOf` does — a `styp` opens a segment that may hold several
 * fragments, and without any `styp` each fragment is its own segment — so the two agree.
 *
 * @group Watermarking
 * @public
 */
export const variantLayoutOf = async (source: Source): Promise<VariantLayout> => {
	// Freeing a source's *last* ref disposes it, so a caller releasing one while this is in flight
	// would dispose the source mid-walk and the next read would throw. Holding one for the duration
	// is what Input does for the same reason, and this spreads many reads over time.
	const ref = source.ref();
	try {
		return await walkLayout(source);
	} finally {
		ref.free();
	}
};

const walkLayout = async (source: Source): Promise<VariantLayout> => {
	const size = await source.getSize();
	const headers: BoxHeader[] = [];
	const sidx: VariantLayout['sidx'] = [];

	let at = 0;
	while (at + 8 <= size) {
		const window = await source.readRange(at, Math.min(at + HEADER_WINDOW, size));
		if (window === null || window.length < 8) {
			break;
		}
		const view = new DataView(window.buffer, window.byteOffset, window.byteLength);

		let cursor = 0;
		while (cursor + 8 <= window.length) {
			let boxSize = view.getUint32(cursor);
			let headerSize = 8;
			if (boxSize === 1) {
				if (cursor + 16 > window.length) {
					break;
				}
				boxSize = Number(view.getBigUint64(cursor + 8));
				headerSize = 16;
			} else if (boxSize === 0) {
				boxSize = size - (at + cursor);
			}
			if (boxSize < headerSize || at + cursor + boxSize > size) {
				throw new Error(
					`ISO BMFF box at offset ${at + cursor} declares ${boxSize} bytes,`
					+ ` which does not fit in the ${size - (at + cursor)} remaining.`,
				);
			}

			const start = at + cursor;
			const type = String.fromCharCode(
				window[cursor + 4]!, window[cursor + 5]!, window[cursor + 6]!, window[cursor + 7]!,
			);
			headers.push({ type, start, size: boxSize });

			if (type === 'sidx') {
				const contents = await source.readRange(start + headerSize, start + boxSize);
				if (contents !== null) {
					const parsed = parseSidxBoxContents(contents, start, boxSize);
					sidx.push({
						box: { offset: start, size: boxSize },
						references: parsed.references.map(reference => ({
							referencedSize: reference.referencedSize,
							subsegmentDuration: reference.subsegmentDuration,
						})),
					});
				}
			}

			cursor += boxSize;
			if (cursor > window.length) {
				break;
			}
		}

		if (cursor === 0) {
			break;
		}
		at += cursor;
	}

	return { ...segmentHeaders(headers, size), sidx };
};

/** The same segmentation rule `segmentsOf` applies, over box headers rather than bytes. */
const segmentHeaders = (
	headers: BoxHeader[],
	fileSize: number,
): Pick<VariantLayout, 'init' | 'segments'> => {
	const firstMoof = headers.findIndex(header => header.type === 'moof');
	if (firstMoof === -1) {
		return { init: fileSize > 0 ? { offset: 0, size: fileSize } : null, segments: [] };
	}

	let firstSegmentBox = firstMoof;
	while (firstSegmentBox > 0 && SEGMENT_PRELUDE.has(headers[firstSegmentBox - 1]!.type)) {
		firstSegmentBox--;
	}
	const mediaStart = headers[firstSegmentBox]!.start;
	const init = mediaStart > 0 ? { offset: 0, size: mediaStart } : null;

	const lastMdat = headers.filter(header => header.type === 'mdat').at(-1);
	const mediaEnd = lastMdat === undefined ? fileSize : lastMdat.start + lastMdat.size;

	// One fragment per moof, opening at the prelude run before it and closing at its mdat.
	const fragments: (LayoutRange & { opensSegment: boolean })[] = [];
	for (let i = firstSegmentBox; i < headers.length; i++) {
		const header = headers[i]!;
		if (header.start >= mediaEnd) {
			break;
		}
		if (header.type !== 'moof') {
			continue;
		}
		let open = i;
		while (open > firstSegmentBox && SEGMENT_PRELUDE.has(headers[open - 1]!.type)) {
			open--;
		}
		const mdat = headers.slice(i).find(candidate => candidate.type === 'mdat');
		const end = mdat === undefined ? mediaEnd : mdat.start + mdat.size;
		fragments.push({
			offset: headers[open]!.start,
			size: end - headers[open]!.start,
			opensSegment: headers.slice(open, i).some(candidate => candidate.type === 'styp'),
		});
	}

	// Without any styp every fragment is a segment; with them, a styp is what opens one.
	const anyStyp = fragments.some(fragment => fragment.opensSegment);
	const segments: LayoutRange[] = [];
	for (const fragment of fragments) {
		const current = segments.at(-1);
		if (current === undefined || !anyStyp || fragment.opensSegment) {
			segments.push({ offset: fragment.offset, size: fragment.size });
		} else {
			current.size += fragment.size;
		}
	}
	return { init, segments };
};
