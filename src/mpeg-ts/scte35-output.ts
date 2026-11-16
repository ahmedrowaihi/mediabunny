/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InvalidUsageError } from '../errors';
import type { Output } from '../output';
import { MpegTsMuxer } from './mpeg-ts-muxer';
import { SegmentPipelineMuxer } from '../segment-pipeline-muxer';

/**
 * Write a `splice_info_section` into an MPEG-TS output's SCTE-35 cue stream, at the current point in
 * the stream.
 *
 * The output's format must declare the PID — `new MpegTsOutputFormat({ scte35Pid: 0x1f00 })` — which is
 * what puts it in the PMT with stream type 0x86 and the `CUEI` registration descriptor.
 *
 * **Timing is the section's own.** SCTE 35 carries the splice point in `pts_adjustment` plus the
 * command's `splice_time`, so this takes no time argument: where the section lands among the media
 * packets is decided by when it is called, and a section placed a little early is normal — a receiver
 * reads the time out of the section rather than from its position. Call it before the media the cue
 * refers to.
 *
 * The section is written verbatim, CRC included, since composing a splice is a decision this library
 * has no part in. {@link readScte35Sections} reads them back.
 *
 * @example
 * ```ts
 * const output = new Output({
 * 	format: new MpegTsOutputFormat({ scte35Pid: 0x1f00 }),
 * 	target: new BufferTarget(),
 * });
 * await output.start();
 * addScte35Section(output, mySpliceInfoSection);
 * ```
 *
 * @group Miscellaneous
 * @public
 */
/**
 * What the playlist marker should say about a section, where the caller knows better than the bytes do.
 *
 * Which `segmentation_type_id`s open an avail is an origin's decision rather than this library's — a
 * MediaTailor deployment and a broadcast playout disagree about Ad Block and overlay types — so a
 * caller that has already made that decision states it here instead of having it re-derived. Both
 * fields default to what {@link parseSpliceInfoSection} reads from the section.
 *
 * Only the marker is affected. The section itself is written into the transport stream verbatim either
 * way, since it is the caller's bytes.
 *
 * @group Miscellaneous
 * @public
 */
export type Scte35SectionOptions = {
	/**
	 * Whether this section opens a break (`true`), closes one (`false`), or opens none at all (`null`,
	 * which writes an `#EXT-X-DATERANGE` with `SCTE35-CMD` and no `#EXT-X-CUE-OUT`).
	 */
	outOfNetwork?: boolean | null;
	/** How long the break runs, in seconds, or `null` for an open-ended one. */
	breakDuration?: number | null;
};

/**
 * Write a `splice_info_section` into an MPEG-TS output's SCTE-35 cue stream, at the current point in
 * the stream.
 *
 * The output's format must declare the PID — `new MpegTsOutputFormat({ scte35Pid: 0x1f00 })` — which is
 * what puts it in the PMT with stream type 0x86 and the `CUEI` registration descriptor.
 *
 * **Timing is the section's own.** SCTE 35 carries the splice point in `pts_adjustment` plus the
 * command's `splice_time`, so this takes no time argument: where the section lands among the media
 * packets is decided by when it is called, and a section placed a little early is normal — a receiver
 * reads the time out of the section rather than from its position. Call it before the media the cue
 * refers to.
 *
 * The section is written verbatim, CRC included, since composing a splice is a decision this library
 * has no part in. {@link readScte35Sections} reads them back.
 *
 * @example
 * ```ts
 * const output = new Output({
 * 	format: new MpegTsOutputFormat({ scte35Pid: 0x1f00 }),
 * 	target: new BufferTarget(),
 * });
 * await output.start();
 * addScte35Section(output, mySpliceInfoSection);
 * ```
 *
 * @group Miscellaneous
 * @public
 */
export const addScte35Section = (
	output: Output,
	section: Uint8Array,
	options: Scte35SectionOptions = {},
): void => {
	if (!(section instanceof Uint8Array)) {
		throw new TypeError('section must be a Uint8Array.');
	}
	// table_id, then the 12-bit section_length its own header states
	if (section.length < 3) {
		throw new InvalidUsageError('A splice_info_section is at least three bytes.');
	}

	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (
		options.outOfNetwork !== undefined
		&& options.outOfNetwork !== null
		&& typeof options.outOfNetwork !== 'boolean'
	) {
		throw new TypeError('options.outOfNetwork, when provided, must be a boolean or null.');
	}
	if (
		options.breakDuration !== undefined
		&& options.breakDuration !== null
		&& !(options.breakDuration >= 0)
	) {
		throw new TypeError('options.breakDuration, when provided, must be a non-negative number or null.');
	}

	const muxer = output._muxer;
	if (muxer instanceof SegmentPipelineMuxer) {
		// A segmented output opens a muxer per segment, so the section waits in the pipeline until the
		// segment its splice point falls in is written
		muxer.writeScte35Section(section, options);
		return;
	}

	if (!(muxer instanceof MpegTsMuxer)) {
		throw new InvalidUsageError(
			'SCTE-35 sections can only be written to an MpegTsOutputFormat output, or to a segmented one'
			+ ' whose segmentFormat is MpegTsOutputFormat.',
		);
	}

	muxer.writeScte35Section(section);
};
