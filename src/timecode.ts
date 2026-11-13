/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Bitstream } from '../shared/bitstream';
import type { StartTimecode } from './input-track';
import type { AvcSpsInfo } from './codec-data';
import { iterateSeiMessages, iterateSeiNalUnits } from './sei';

/**
 * A frame number counted from 00:00:00:00 as a broadcast timecode.
 *
 * Drop-frame does not drop pictures: it skips *numbers*, two per minute at 29.97 and four at 59.94,
 * except every tenth minute, so the count stays near wall clock on a rate that is not an integer. The
 * frames therefore have to be renumbered before splitting into hours and minutes, or every timecode past
 * the first minute is wrong by a growing amount.
 *
 * @internal
 */
export const startTimecodeOf = (
	frameNumber: number,
	framesPerSecond: number,
	dropFrame: boolean,
): StartTimecode => {
	let frames = frameNumber;

	if (dropFrame) {
		const dropped = Math.round(framesPerSecond / 15); // 2 at 29.97, 4 at 59.94
		const perTenMinutes = framesPerSecond * 600 - 9 * dropped;
		const perMinute = framesPerSecond * 60 - dropped;
		const tenMinuteBlocks = Math.floor(frames / perTenMinutes);
		const within = frames % perTenMinutes;

		frames += 9 * dropped * tenMinuteBlocks
			+ dropped * Math.floor(Math.max(within - dropped, 0) / perMinute);
	}

	return {
		hours: Math.floor(frames / (framesPerSecond * 3600)) % 24,
		minutes: Math.floor(frames / (framesPerSecond * 60)) % 60,
		seconds: Math.floor(frames / framesPerSecond) % 60,
		frames: frames % framesPerSecond,
		dropFrame,
		frameRate: framesPerSecond,
	};
};

/** H.265 D.2.27 `time_code`. H.264's `pic_timing` is payload type 1 and needs SPS context to parse. */
const TIME_CODE_SEI = 136;

/**
 * The timecode an HEVC bitstream's `time_code` SEI states, or null when it carries none.
 *
 * Only the first clock timestamp is read: a message may carry up to three, for the fields of an
 * interlaced picture, and they are the same instant.
 *
 * @internal
 */
export const extractTimecodeFromHevcSei = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	frameRate: number,
): StartTimecode | null => {
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, 'hevc')) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, 'hevc')) {
			if (payloadType !== TIME_CODE_SEI) {
				continue;
			}

			const bitstream = new Bitstream(payload);
			if (bitstream.readBits(2) === 0) { // num_clock_ts
				continue;
			}
			if (!bitstream.readBits(1)) { // clock_timestamp_flag
				continue;
			}

			bitstream.skipBits(1 + 5); // units_field_based_flag, counting_type
			const fullTimestamp = bitstream.readBits(1);
			bitstream.skipBits(1); // discontinuity_flag
			const droppedFlag = bitstream.readBits(1);
			const frames = bitstream.readBits(9);

			// A partial timestamp states only the units it needs, each gated by the flag before it
			let seconds = 0;
			let minutes = 0;
			let hours = 0;
			if (fullTimestamp) {
				seconds = bitstream.readBits(6);
				minutes = bitstream.readBits(6);
				hours = bitstream.readBits(5);
			} else if (bitstream.readBits(1)) {
				seconds = bitstream.readBits(6);
				if (bitstream.readBits(1)) {
					minutes = bitstream.readBits(6);
					if (bitstream.readBits(1)) {
						hours = bitstream.readBits(5);
					}
				}
			}

			return {
				hours,
				minutes,
				seconds,
				frames,
				dropFrame: droppedFlag === 1,
				frameRate,
			};
		}
	}

	return null;
};

/** H.264 D.2.2 `pic_timing`. */
const PIC_TIMING_SEI = 1;

/** H.264 D.2.2 Table D-1: how many clock timestamps each `pic_struct` carries. */
const CLOCK_TIMESTAMPS_PER_PIC_STRUCT = [1, 1, 1, 2, 2, 3, 3, 2, 3];

/**
 * The timecode an H.264 bitstream's `pic_timing` SEI states, or null when it carries none.
 *
 * Unlike HEVC's `time_code`, this message is not self-describing: how many bits precede the clock
 * timestamp, and whether one is present at all, are stated only by the SPS's VUI, so the SPS has to be
 * parsed first and a stream whose VUI declares no `pic_struct` carries nothing to read.
 *
 * @internal
 */
export const extractTimecodeFromAvcSei = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	sps: AvcSpsInfo,
	frameRate: number,
): StartTimecode | null => {
	if (!sps.picStructPresentFlag) {
		return null;
	}

	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, 'avc')) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, 'avc')) {
			if (payloadType !== PIC_TIMING_SEI) {
				continue;
			}

			const bitstream = new Bitstream(payload);

			// The delays come first and are only present when the VUI declared an HRD, which is also the
			// only thing that states their width
			if (sps.hrd) {
				bitstream.skipBits(sps.hrd.cpbRemovalDelayLength + sps.hrd.dpbOutputDelayLength);
			}

			const picStruct = bitstream.readBits(4);
			const count = CLOCK_TIMESTAMPS_PER_PIC_STRUCT[picStruct];
			if (count === undefined || count === 0) {
				continue;
			}

			// Only the first: the rest are the other fields of the same picture, at the same instant
			if (!bitstream.readBits(1)) { // clock_timestamp_flag
				continue;
			}

			bitstream.skipBits(2 + 1 + 5); // ct_type, nuit_field_based_flag, counting_type
			const fullTimestamp = bitstream.readBits(1);
			bitstream.skipBits(1); // discontinuity_flag
			const droppedFlag = bitstream.readBits(1);
			const frames = bitstream.readBits(8);

			let seconds = 0;
			let minutes = 0;
			let hours = 0;
			if (fullTimestamp) {
				seconds = bitstream.readBits(6);
				minutes = bitstream.readBits(6);
				hours = bitstream.readBits(5);
			} else if (bitstream.readBits(1)) {
				seconds = bitstream.readBits(6);
				if (bitstream.readBits(1)) {
					minutes = bitstream.readBits(6);
					if (bitstream.readBits(1)) {
						hours = bitstream.readBits(5);
					}
				}
			}

			return {
				hours,
				minutes,
				seconds,
				frames,
				dropFrame: droppedFlag === 1,
				frameRate,
			};
		}
	}

	return null;
};
