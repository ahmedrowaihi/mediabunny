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
import type { SeiMessage } from './sei';
import type { SeiCodec } from './sei';
import {
	buildSeiNalUnit,
	iterateSeiMessages,
	iterateSeiNalUnits,
	rewriteSeiMessages,
	spliceNalUnitBeforeVcl,
} from './sei';

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

/** H.264 D.2.2: `time_offset_length` where no HRD parameters state one. */
const INFERRED_TIME_OFFSET_LENGTH = 24;

const PIC_STRUCT_BITS = 4;
/** One `clock_timestamp` with `full_timestamp_flag` set, before any `time_offset`. */
const CLOCK_TIMESTAMP_BITS = 37;

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

			if (sps.hrd) {
				bitstream.skipBits(sps.hrd.cpbRemovalDelayLength + sps.hrd.dpbOutputDelayLength);
			}

			const picStruct = bitstream.readBits(4);
			const count = CLOCK_TIMESTAMPS_PER_PIC_STRUCT[picStruct];
			if (count === undefined || count === 0) {
				continue;
			}

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

const TIMECODE_PATTERN = /^(\d{1,2}):(\d{2}):(\d{2})([:;.])(\d{1,3})$/;

/**
 * Reads a timecode written the way broadcast tools write one, `hh:mm:ss:ff`, or `hh:mm:ss;ff` for a
 * drop-frame count.
 *
 * The **separator before the frames states drop-frame**, which is the convention ffmpeg writes and
 * `ffprobe` prints, and the only thing in the string that can: `01:00:00;00` and `01:00:00:00` name
 * different instants on a 29.97 rate, and nothing else distinguishes them.
 *
 * @public
 * @group Miscellaneous
 */
export const parseTimecode = (text: string, frameRate: number): StartTimecode => {
	if (typeof text !== 'string') {
		throw new TypeError('text must be a string.');
	}
	if (!Number.isFinite(frameRate) || frameRate <= 0) {
		throw new TypeError('frameRate must be a positive number.');
	}

	const match = TIMECODE_PATTERN.exec(text.trim());
	if (!match) {
		throw new TypeError(
			`'${text}' is not a timecode. Write hh:mm:ss:ff, or hh:mm:ss;ff for a drop-frame count.`,
		);
	}

	const dropFrame = match[4] !== ':';
	const timecode: StartTimecode = {
		hours: Number(match[1]),
		minutes: Number(match[2]),
		seconds: Number(match[3]),
		frames: Number(match[5]),
		dropFrame,
		frameRate,
	};

	const perSecond = Math.round(frameRate);
	if (timecode.hours > 23 || timecode.minutes > 59 || timecode.seconds > 59 || timecode.frames >= perSecond) {
		throw new TypeError(
			`'${text}' is out of range for ${frameRate} fps: hours 0-23, minutes and seconds 0-59,`
			+ ` frames 0-${perSecond - 1}.`,
		);
	}

	if (dropFrame) {
		// The dropped numbers do not exist. 00:01:00;00 is not a time - the count goes ...;29 to ;02 -
		// and accepting it would write a timecode no receiver can show.
		const dropped = Math.round(frameRate / 15);
		if (timecode.seconds === 0 && timecode.minutes % 10 !== 0 && timecode.frames < dropped) {
			throw new TypeError(
				`'${text}' is a dropped number: a drop-frame count skips the first ${dropped} frames of`
				+ ' every minute but the tenth, so that timecode never occurs.',
			);
		}
	}

	return timecode;
};

/**
 * The frame number a timecode names, counted from `00:00:00:00` - the inverse of
 * {@link startTimecodeOf}.
 *
 * This is what a `tmcd` sample holds, and getting the drop-frame arithmetic backwards here puts every
 * timecode past the first minute out by a growing amount rather than failing.
 *
 * @internal
 */
export const frameNumberOf = (timecode: StartTimecode): number => {
	const perSecond = Math.round(timecode.frameRate);
	const counted = timecode.frames
		+ perSecond * timecode.seconds
		+ perSecond * 60 * timecode.minutes
		+ perSecond * 3600 * timecode.hours;

	if (!timecode.dropFrame) {
		return counted;
	}

	// Subtract the numbers that do not exist: `dropped` per minute, except every tenth
	const dropped = Math.round(timecode.frameRate / 15);
	const totalMinutes = 60 * timecode.hours + timecode.minutes;
	return counted - dropped * (totalMinutes - Math.floor(totalMinutes / 10));
};

/**
 * `units_field_based_flag`/`nuit_field_based_flag` 1, which is what ffmpeg's `ff_alloc_timecode_sei`
 * writes for every codec it carries a timecode in.
 *
 * `counting_type` is NOT fixed, and the claim that it could be cost a shipped bug. H.264 Table D-3 and
 * H.265 Table D.2 give 4 for "dropping of the two lowest n_frames counts when seconds_value is 0 and
 * minutes_value is not a multiple of 10" - which is exactly NTSC drop-frame - and 0 for no dropping at
 * all. **ffmpeg honours `cnt_dropped_flag` only for counting types 2 to 6**, so a drop-frame timecode
 * written under type 0 reads back as non-drop in every external tool: ffprobe shows `01:00:00:00`
 * where it should show `01:00:00;00`. Our own reader takes the flag at face value and was not affected,
 * which is why a round trip through it saw nothing wrong.
 */
const countingTypeFor = (timecode: StartTimecode) => (timecode.dropFrame ? 4 : 0);
const FIELD_BASED_FLAG = 1;

/**
 * An HEVC `time_code` SEI message stating one clock timestamp.
 *
 * @internal
 */
export const buildHevcTimecodeSeiMessage = (timecode: StartTimecode): SeiMessage => {
	// 43 bits of payload, then `payload_bit_equal_to_one` and four zeros to byte-align it
	const payload = new Uint8Array(6);
	const bitstream = new Bitstream(payload);

	bitstream.writeBits(2, 1); // num_clock_ts
	bitstream.writeBits(1, 1); // clock_timestamp_flag
	bitstream.writeBits(1, FIELD_BASED_FLAG); // units_field_based_flag
	bitstream.writeBits(5, countingTypeFor(timecode)); // counting_type
	bitstream.writeBits(1, 1); // full_timestamp_flag
	bitstream.writeBits(1, 0); // discontinuity_flag
	bitstream.writeBits(1, +timecode.dropFrame); // cnt_dropped_flag
	bitstream.writeBits(9, timecode.frames);
	bitstream.writeBits(6, timecode.seconds);
	bitstream.writeBits(6, timecode.minutes);
	bitstream.writeBits(5, timecode.hours);
	bitstream.writeBits(5, 0); // time_offset_length
	bitstream.writeBits(1, 1); // payload_bit_equal_to_one

	return { payloadType: TIME_CODE_SEI, payload };
};

/**
 * An H.264 `pic_timing` SEI message stating one clock timestamp, or null when this SPS's VUI gives
 * nowhere to put it.
 *
 * The message is not self-describing: a decoder reads it against the SPS, so one written for a stream
 * whose VUI declares no `pic_struct` is read as whatever the bits happen to mean there. Returning null
 * for that SPS is the only safe answer, which is why ffmpeg carries a timecode in HEVC and AV1 and never
 * in AVC.
 *
 * @internal
 */
export const buildAvcTimecodeSeiMessage = (
	timecode: StartTimecode,
	sps: AvcSpsInfo,
	/**
	 * The `pic_timing` message this access unit already carries, whose `pic_struct` and delay fields
	 * are then kept as they are and only the clock timestamps written. An interlaced stream always has
	 * one - x264 emits it on every picture to state the field order - and it is the stream whose SPS
	 * most often permits a timecode at all, so this is the ordinary case rather than an edge one.
	 */
	existing?: Uint8Array,
): SeiMessage | null => {
	if (!sps.picStructPresentFlag) {
		return null;
	}

	if (existing) {
		return rewriteAvcPicTiming(timecode, sps, existing);
	}

	const delayBits = sps.hrd ? sps.hrd.cpbRemovalDelayLength + sps.hrd.dpbOutputDelayLength : 0;
	// Absent HRD parameters do NOT mean a zero-width time offset: D.2.2 infers `time_offset_length`
	// to be 24 when no HRD states one, so the field is still there and a message written without it
	// is 24 bits short. ffmpeg's decoder reads such a message anyway; its conformance parser rejects
	// it with "Invalid value at time_offset: bitstream ended", which is how this was found.
	const timeOffsetBits = sps.hrd?.timeOffsetLength ?? INFERRED_TIME_OFFSET_LENGTH;
	const bits = delayBits + PIC_STRUCT_BITS + CLOCK_TIMESTAMP_BITS + timeOffsetBits;
	const payload = new Uint8Array(Math.ceil((bits + 1) / 8));
	const bitstream = new Bitstream(payload);

	if (sps.hrd) {
		// This picture's place in the HRD schedule, which a timecode says nothing about. Zero is the
		// value for a stream that does not model one, and is what the fields hold in every stream whose
		// encoder declared an HRD it does not drive.
		bitstream.writeBits(sps.hrd.cpbRemovalDelayLength, 0);
		bitstream.writeBits(sps.hrd.dpbOutputDelayLength, 0);
	}

	bitstream.writeBits(PIC_STRUCT_BITS, 0); // pic_struct: a frame, so one clock timestamp
	writeAvcClockTimestamp(bitstream, timecode, timeOffsetBits);
	bitstream.writeBits(1, 1); // payload_bit_equal_to_one

	return { payloadType: PIC_TIMING_SEI, payload };
};

/**
 * The timecode `frameCount` frames after a start timecode, on the same count.
 *
 * @internal
 */
export const advanceTimecode = (start: StartTimecode, frameCount: number): StartTimecode => ({
	...startTimecodeOf(
		frameNumberOf(start) + frameCount,
		Math.round(start.frameRate),
		start.dropFrame,
	),
	// The split counts whole frames per second, but the rate this is stated against is the real one:
	// 30 would make the next advance of a 29.97 count drop nothing
	frameRate: start.frameRate,
});

/**
 * An SEI NAL unit stating the timecode of the frame `frameIndex` frames after `start`, or null when this
 * stream cannot carry one.
 *
 * `sps` is read only for AVC, where the message is not self-describing; pass null for HEVC. A null return
 * means the stream's own SPS gives the message nowhere to live, not that the timecode was wrong.
 *
 * @internal
 */
export const buildTimecodeSeiNalUnit = (
	start: StartTimecode,
	frameIndex: number,
	codec: SeiCodec,
	sps: AvcSpsInfo | null,
): Uint8Array | null => {
	const timecode = advanceTimecode(start, frameIndex);
	const message = codec === 'hevc'
		? buildHevcTimecodeSeiMessage(timecode)
		: sps && buildAvcTimecodeSeiMessage(timecode, sps);

	return message ? buildSeiNalUnit([message], codec) : null;
};

/**
 * Writes an access unit's timecode into it, and says whether anything was written.
 *
 * AVC gets one message per access unit, not one more: an interlaced stream already carries a
 * `pic_timing` - that is how it states its field order - so the clock timestamps go **into** that
 * message rather than into a second one, which is not something a decoder can read and which would
 * also state `pic_struct` 0 over the field order the first one declares. HEVC's `time_code` is its own
 * payload type and simply joins the access unit.
 *
 * An access unit whose `pic_timing` already carries a clock timestamp keeps it: that is a timecode the
 * caller's own bitstream states, and this muxer does not overrule the bitstream it was handed.
 *
 * @internal
 */
export const writeTimecodeIntoAccessUnit = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
	sps: AvcSpsInfo | null,
	start: StartTimecode,
	frameIndex: number,
): Uint8Array => {
	const timecode = advanceTimecode(start, frameIndex);

	if (codec === 'hevc') {
		if (extractTimecodeFromHevcSei(packetData, decoderConfig, 1) !== null) {
			return packetData;
		}

		const message = buildHevcTimecodeSeiMessage(timecode);
		return spliceNalUnitBeforeVcl(packetData, decoderConfig, codec, buildSeiNalUnit([message], codec)!);
	}

	if (!sps) {
		return packetData;
	}
	if (extractTimecodeFromAvcSei(packetData, decoderConfig, sps, 1) !== null) {
		return packetData;
	}

	const existing = avcPicTimingOf(packetData, decoderConfig);
	if (existing) {
		const replacement = buildAvcTimecodeSeiMessage(timecode, sps, existing);
		if (!replacement) {
			return packetData;
		}

		const { data } = rewriteSeiMessages(packetData, decoderConfig, codec, message => (
			message.payloadType === PIC_TIMING_SEI ? replacement : message
		));
		return data;
	}

	const message = buildAvcTimecodeSeiMessage(timecode, sps);
	if (!message) {
		return packetData;
	}

	return spliceNalUnitBeforeVcl(packetData, decoderConfig, codec, buildSeiNalUnit([message], codec)!);
};

/**
 * Writes a timecode the way broadcast tools do, `hh:mm:ss:ff` - or `hh:mm:ss;ff` for a drop-frame count,
 * since the separator before the frames is the only thing in the string that states one.
 *
 * The inverse of {@link parseTimecode}, and what turns a timecode read off an input into one that can be
 * stated on an output track.
 *
 * @public
 * @group Miscellaneous
 */
export const formatTimecode = (timecode: StartTimecode): string => {
	const pad = (value: number, width = 2) => String(value).padStart(width, '0');
	const separator = timecode.dropFrame ? ';' : ':';

	return `${pad(timecode.hours)}:${pad(timecode.minutes)}:${pad(timecode.seconds)}`
		+ `${separator}${pad(timecode.frames)}`;
};

/** H.264 D.2.2 Table D-1: how many clock timestamps each `pic_struct` carries, as the reader states it. */
const clockTimestampsFor = (picStruct: number) => CLOCK_TIMESTAMPS_PER_PIC_STRUCT[picStruct] ?? 0;

/** Writes one `clock_timestamp` run, the part that is the same whether the message is new or rebuilt. */
const writeAvcClockTimestamp = (
	bitstream: Bitstream,
	timecode: StartTimecode,
	timeOffsetBits: number,
) => {
	bitstream.writeBits(1, 1); // clock_timestamp_flag
	bitstream.writeBits(2, 0); // ct_type: progressive
	bitstream.writeBits(1, FIELD_BASED_FLAG); // nuit_field_based_flag
	bitstream.writeBits(5, countingTypeFor(timecode)); // counting_type
	bitstream.writeBits(1, 1); // full_timestamp_flag
	bitstream.writeBits(1, 0); // discontinuity_flag
	bitstream.writeBits(1, +timecode.dropFrame); // cnt_dropped_flag
	bitstream.writeBits(8, timecode.frames);
	bitstream.writeBits(6, timecode.seconds);
	bitstream.writeBits(6, timecode.minutes);
	bitstream.writeBits(5, timecode.hours);

	if (timeOffsetBits > 0) {
		bitstream.writeBits(timeOffsetBits, 0); // time_offset
	}
};

/**
 * Rebuilds an existing `pic_timing` message with the clock timestamps filled in.
 *
 * Two things have to be carried over rather than written fresh. The **delay fields** hold this
 * picture's real place in the HRD schedule, which a timecode says nothing about and zeroing would
 * misstate. And **`pic_struct`** is how an interlaced stream states its field order - 3 is a top field
 * then a bottom one - so writing 0 over it would tell a decoder the picture is a progressive frame.
 * It also decides how many clock timestamps the message carries, which is two for a field pair.
 */
const rewriteAvcPicTiming = (
	timecode: StartTimecode,
	sps: AvcSpsInfo,
	existing: Uint8Array,
): SeiMessage | null => {
	const reader = new Bitstream(existing);
	const delayBits = sps.hrd ? sps.hrd.cpbRemovalDelayLength + sps.hrd.dpbOutputDelayLength : 0;
	const timeOffsetBits = sps.hrd?.timeOffsetLength ?? INFERRED_TIME_OFFSET_LENGTH;

	// Read past the delays without interpreting them, then the structure that decides the rest
	const delays: number[] = [];
	if (sps.hrd) {
		delays.push(reader.readBits(sps.hrd.cpbRemovalDelayLength));
		delays.push(reader.readBits(sps.hrd.dpbOutputDelayLength));
	}

	const picStruct = reader.readBits(4);
	const count = clockTimestampsFor(picStruct);
	if (count === 0) {
		return null; // A `pic_struct` with no clock timestamp to carry; leave the message alone
	}

	const bits = delayBits + PIC_STRUCT_BITS + count * (CLOCK_TIMESTAMP_BITS + timeOffsetBits);
	const payload = new Uint8Array(Math.ceil((bits + 1) / 8));
	const writer = new Bitstream(payload);

	for (const [index, value] of delays.entries()) {
		writer.writeBits(index === 0 ? sps.hrd!.cpbRemovalDelayLength : sps.hrd!.dpbOutputDelayLength, value);
	}

	writer.writeBits(4, picStruct);
	for (let i = 0; i < count; i++) {
		// Every field of a frame carries that frame's timecode: SMPTE 12M counts frames, and the
		// fields of one are the same instant
		writeAvcClockTimestamp(writer, timecode, timeOffsetBits);
	}

	writer.writeBits(1, 1); // payload_bit_equal_to_one

	return { payloadType: PIC_TIMING_SEI, payload };
};

/**
 * Whether an access unit's `pic_timing` already carries a clock timestamp, which is a timecode the
 * caller's own bitstream states and this muxer does not overrule.
 *
 * @internal
 */
export const avcPicTimingOf = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
): Uint8Array | null => {
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, 'avc')) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, 'avc')) {
			if (payloadType === PIC_TIMING_SEI) {
				return payload;
			}
		}
	}

	return null;
};
