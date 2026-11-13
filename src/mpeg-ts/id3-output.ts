/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InvalidUsageError } from '../errors';
import type { Output } from '../output';
import { SegmentPipelineMuxer } from '../segment-pipeline-muxer';
import { MpegTsMuxer } from './mpeg-ts-muxer';

/**
 * The scheme an `emsg` carrying an ID3 tag states, as AOM registered it for CMAF. A reader matches on
 * this to tell an ID3 event from any other the segment carries.
 *
 * @group Miscellaneous
 * @public
 */
export const ID3_EMSG_SCHEME = 'https://aomedia.org/emsg/ID3';

/**
 * Write one ID3 tag into an output's timed-metadata stream, at `time` on the media timeline.
 *
 * Where it lands depends on what the segments are:
 *
 * - **MPEG-TS** — a PES packet on the PID
 *   {@link MpegTsOutputFormatOptions.timedMetadataPid} declares, which the PMT lists with
 *   `stream_type` 0x15 and the ID3 `metadata_descriptor`.
 * - **CMAF / fragmented MP4** — an `emsg` with scheme `https://aomedia.org/emsg/ID3`, written ahead of
 *   the `moof` of the fragment covering `time`.
 *
 * A segmented output has no one stream to write into, so the tag waits until the segment covering its
 * time is written — handing one over early is expected, and that is how a live caller states a tag for
 * media it has not supplied yet.
 *
 * The bytes are a complete ID3v2 tag, header included; composing frames is the caller's, since what
 * goes in them is theirs.
 *
 * @param output - An output whose format is, or whose segments are, MPEG-TS or fragmented MP4.
 * @param metadata - The time in seconds and the tag bytes.
 *
 * @group Miscellaneous
 * @public
 */
export const addId3Metadata = (
	output: Output,
	metadata: {
		/** Where on the media timeline the tag belongs, in seconds. */
		time: number;
		/** A complete ID3v2 tag, header included. */
		data: Uint8Array;
	},
): void => {
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError('metadata must be an object.');
	}
	if (!Number.isFinite(metadata.time)) {
		throw new TypeError('metadata.time must be a number of seconds.');
	}
	if (!(metadata.data instanceof Uint8Array)) {
		throw new TypeError('metadata.data must be a Uint8Array.');
	}
	if (metadata.data.byteLength === 0) {
		throw new InvalidUsageError('An ID3 tag cannot be empty.');
	}

	const muxer = output._muxer;
	if (muxer instanceof SegmentPipelineMuxer) {
		muxer.writeId3Metadata(metadata.time, metadata.data);
		return;
	}

	if (!(muxer instanceof MpegTsMuxer)) {
		throw new InvalidUsageError(
			'ID3 metadata can only be written to an MpegTsOutputFormat output, or to a segmented one.',
		);
	}

	const pid = muxer.timedMetadataPid;
	if (pid === null) {
		throw new InvalidUsageError(
			'MpegTsOutputFormat was not given a timedMetadataPid, so there is no stream to write ID3 into.',
		);
	}

	muxer.writePrivatePesPayload(pid, metadata.time, metadata.data);
};
