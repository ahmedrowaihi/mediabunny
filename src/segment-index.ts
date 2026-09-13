/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Conversion } from './conversion';
import type { Input } from './input';
import type { InputVideoTrack } from './input-track';
import { EncodedPacketSink } from './media-sink';
import type { Output } from './output';

/**
 * One segment of a progressive file, as found by {@link segmentIndexOf}. Boundaries sit on sync samples, so a
 * segment can be decoded without the ones before it.
 *
 * @group Miscellaneous
 * @public
 */
export type SegmentBoundary = {
	/** 0-based index of the segment in the file. */
	index: number;
	/** Start time in seconds, the timestamp of the sync sample the segment opens on. */
	startTime: number;
	/** End time in seconds, exclusive: the start of the next segment, or the track's end for the last one. */
	endTime: number;
	/** Length in seconds, `endTime - startTime`. */
	duration: number;
};

/**
 * Index a progressive file into the segments it could be served as, cutting at sync samples so each one decodes
 * on its own. For a file that states a `sidx` (a fragmented or on-demand DASH file), read that instead through
 * {@link Input.getSegmentIndex} — this exists for the progressive `moov`+`mdat` layout, which carries no index
 * and would otherwise have to be read whole to find its boundaries.
 *
 * Boundaries come from the track's sync samples rather than a fixed grid, so a segment is at least
 * `targetDuration` long and ends at the first sync sample past it. A track whose only sync sample is its first
 * yields a single segment spanning the whole timeline; that is the file saying it cannot be cut, not an error.
 *
 * The returned segments tile the track: each one starts where the previous ended, with no gap and no overlap.
 *
 * @param targetDuration - The length to aim for, in seconds. Segments run at least this long, then to the next
 * sync sample.
 * @throws When the input holds no video track, since sync samples are what the boundaries are cut on.
 * @group Miscellaneous
 * @public
 */
export const segmentIndexOf = async (
	input: Input,
	options: {
		/** Target segment length in seconds. */
		targetDuration: number;
		/** The video track to cut on. Defaults to the input's primary video track. */
		track?: InputVideoTrack;
	},
): Promise<SegmentBoundary[]> => {
	if (!Number.isFinite(options.targetDuration) || options.targetDuration <= 0) {
		throw new TypeError('options.targetDuration must be a positive finite number.');
	}

	const track = options.track ?? await input.getPrimaryVideoTrack();
	if (!track) {
		throw new Error('segmentIndexOf needs a video track; its sync samples are where segments can be cut.');
	}

	const sink = new EncodedPacketSink(track);
	const first = await sink.getFirstKeyPacket();
	if (!first) {
		return [];
	}

	const end = await track.computeDuration();
	const starts: number[] = [first.timestamp];

	let current = first;
	for (;;) {
		const next = await sink.getNextKeyPacket(current);
		if (!next) {
			break;
		}

		current = next;
		// A segment runs at least the target, then to the first sync sample past it
		if (next.timestamp - starts[starts.length - 1]! >= options.targetDuration) {
			starts.push(next.timestamp);
		}
	}

	return starts.map((startTime, index) => {
		const endTime = starts[index + 1] ?? end;
		return { index, startTime, endTime, duration: endTime - startTime };
	});
};

/**
 * Write one segment of a progressive file, as a self-contained media file holding only that segment's media.
 * Pair with {@link segmentIndexOf}, whose boundaries already sit on sync samples, to serve a progressive source
 * segment by segment without remuxing the whole file per request.
 *
 * The copy shrinks rather than expands to the boundary, so a segment never carries media belonging to its
 * neighbours — segments written this way tile the source the way the index says they do.
 *
 * @group Miscellaneous
 * @public
 */
export const muxSegment = async (
	input: Input,
	boundary: SegmentBoundary,
	output: Output,
): Promise<void> => {
	const conversion = await Conversion.init({
		input,
		output,
		trim: { start: boundary.startTime, end: boundary.endTime },
		// A segment must not overlap its neighbours; expanding to the enclosing key frames would.
		copy: { boundaryPolicy: 'shrink' },
	});

	await conversion.execute();
};
