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
 * Write one whole PES payload into a private stream of an MPEG-TS output — the pass-through for DVB
 * teletext and DVB subtitles.
 *
 * The output's format must declare the stream:
 * `new MpegTsOutputFormat({ privateStreams: [{ pid: 0x1f00, descriptors: [teletextDescriptor] }] })`.
 * The descriptors are what identify it; the payload bytes are written unchanged, since the
 * `data_identifier`/`data_unit` framing of EN 300 472 and the segments of EN 300 743 are the caller's
 * to compose.
 *
 * The payload is placed among the media by its `time`, not by when this is called, so a cue may be
 * handed over early. {@link readPrivatePesPayloads} reads it back.
 *
 * @param output - An output whose format is an {@link MpegTsOutputFormat}.
 * @param payload - The PID to write to, the PTS in seconds, and the payload bytes.
 *
 * @example
 * ```ts
 * for (const cue of readPrivatePesPayloads(sourceStream, 0x1f00)) {
 * 	addPrivatePesPayload(output, { pid: 0x1f00, time: cue.time!, data: cue.data });
 * }
 * ```
 *
 * @group Miscellaneous
 * @public
 */
export const addPrivatePesPayload = (
	output: Output,
	payload: {
		/** The PID of a private stream the output's format declares. */
		pid: number;
		/** The PES `PTS` in seconds, which is where among the media the payload is written. */
		time: number;
		/** The payload bytes, written after the PES header unchanged. */
		data: Uint8Array;
	},
): void => {
	if (!payload || typeof payload !== 'object') {
		throw new TypeError('payload must be an object.');
	}
	if (!Number.isInteger(payload.pid)) {
		throw new TypeError('payload.pid must be an integer.');
	}
	if (!Number.isFinite(payload.time)) {
		throw new TypeError('payload.time must be a number of seconds.');
	}
	if (!(payload.data instanceof Uint8Array)) {
		throw new TypeError('payload.data must be a Uint8Array.');
	}

	const muxer = output._muxer;
	if (muxer instanceof SegmentPipelineMuxer) {
		// A segmented output opens a muxer per segment, so the payload waits in the pipeline until the
		// segment its time falls in is written
		muxer.writePrivatePesPayload(payload.pid, payload.time, payload.data);
		return;
	}

	if (!(muxer instanceof MpegTsMuxer)) {
		throw new InvalidUsageError(
			'Private PES payloads can only be written to an MpegTsOutputFormat output, or to a segmented'
			+ ' one whose segmentFormat is MpegTsOutputFormat.',
		);
	}

	muxer.writePrivatePesPayload(payload.pid, payload.time, payload.data);
};
