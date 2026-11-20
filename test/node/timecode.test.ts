/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Drop-frame does not drop pictures, it skips NUMBERS: two per minute at 29.97 and four at 59.94,
// except every tenth minute. Getting that arithmetic backwards does not fail - it puts every timecode
// past the first minute out by an amount that grows through the day, which is why the round trip below
// walks a whole day rather than a handful of values.

import { expect, test } from 'vitest';
import {
	buildAvcTimecodeSeiMessage,
	buildHevcTimecodeSeiMessage,
	frameNumberOf,
	parseTimecode,
	startTimecodeOf,
} from '../../src/timecode.js';
import type { AvcSpsInfo } from '../../src/codec-data.js';

test('a timecode and a frame number are inverses, for every frame of a day', () => {
	const counts = [[30000 / 1001, true], [60000 / 1001, true], [25, false], [30, false]] as const;

	for (const [frameRate, dropFrame] of counts) {
		const perSecond = Math.round(frameRate);
		const framesInADay = perSecond * 3600 * 24
			- (dropFrame ? Math.round(frameRate / 15) * (60 * 24 - Math.floor(60 * 24 / 10)) : 0);

		// Every 97th frame: a prime stride lands on every position within a minute and within a
		// ten-minute block, which is where the dropped numbers live
		for (let frame = 0; frame < framesInADay; frame += 97) {
			const timecode = startTimecodeOf(frame, perSecond, dropFrame);
			expect(frameNumberOf({ ...timecode, frameRate }), `${frameRate} fps, frame ${frame}`)
				.toBe(frame);
		}
	}
});

test('the separator before the frames is what states drop-frame', () => {
	// The only thing in the string that can, and the two name different instants: on a 29.97 count,
	// 01:00:00;00 is 107,892 frames and 01:00:00:00 is 108,000
	const drop = parseTimecode('01:00:00;00', 30000 / 1001);
	const nonDrop = parseTimecode('01:00:00:00', 30000 / 1001);

	expect(drop.dropFrame).toBe(true);
	expect(nonDrop.dropFrame).toBe(false);
	expect(frameNumberOf(drop)).toBe(107_892);
	expect(frameNumberOf(nonDrop)).toBe(108_000);
	expect(frameNumberOf(nonDrop) - frameNumberOf(drop)).toBe(108); // 54 minutes x 2 dropped
});

test('a dropped number is refused rather than written', () => {
	// The count goes ...;29 to 00:01:00;02, so ;00 and ;01 of that minute never occur. Accepting one
	// writes a timecode no receiver can display.
	expect(() => parseTimecode('00:01:00;00', 30000 / 1001)).toThrow(/dropped number/);
	expect(() => parseTimecode('00:01:00;01', 30000 / 1001)).toThrow(/dropped number/);
	// The tenth minute drops nothing, so there it is a real time
	expect(parseTimecode('00:10:00;00', 30000 / 1001).frames).toBe(0);
	// And at 59.94 four numbers go, not two
	expect(() => parseTimecode('00:01:00;03', 60000 / 1001)).toThrow(/dropped number/);
	expect(parseTimecode('00:01:00;04', 60000 / 1001).frames).toBe(4);
});

test('a timecode outside its rate is refused', () => {
	expect(() => parseTimecode('01:00:00:30', 30000 / 1001)).toThrow(/frames 0-29/);
	expect(() => parseTimecode('01:00:00:25', 25)).toThrow(/frames 0-24/);
	expect(() => parseTimecode('24:00:00:00', 25)).toThrow(/hours 0-23/);
	expect(() => parseTimecode('01:60:00:00', 25)).toThrow(/minutes and seconds 0-59/);
	expect(() => parseTimecode('1h', 25)).toThrow(/is not a timecode/);
});

test('the frame count a day holds differs between the two counts', () => {
	// 2,589,408 against 2,592,000: the 2,592 numbers a day of drop-frame skips. A reader that treated
	// them alike would drift by 86 frames an hour.
	const lastDrop = startTimecodeOf(2_589_407, 30, true);
	const lastNonDrop = startTimecodeOf(2_591_999, 30, false);

	expect(`${lastDrop.hours}:${lastDrop.minutes}:${lastDrop.seconds}`).toBe('23:59:59');
	expect(`${lastNonDrop.hours}:${lastNonDrop.minutes}:${lastNonDrop.seconds}`).toBe('23:59:59');
	expect(frameNumberOf({ ...lastDrop, frameRate: 30000 / 1001 })).toBe(2_589_407);
});

// The SEI payload, octet by octet. No decoder validates the trailing alignment bit - ffmpeg's own
// writer pads with zeros instead - so a byte-level assertion is the only thing that can hold it.
//
// 01:00:00:00, non-drop, derived from H.265 D.2.27's field order:
//   num_clock_ts         01
//   clock_timestamp_flag 1
//   units_field_based    1
//   counting_type        00000
//   full_timestamp       1
//   discontinuity        0
//   cnt_dropped          0
//   n_frames             000000000
//   seconds              000000
//   minutes              000000
//   hours                00001
//   time_offset_length   00000
//   payload_bit_eq_one   1, then zeros to the octet
// which lays out as 0111 0000 | 0100 0000 | 0000 0000 | 0000 0000 | 0000 0100 | 0001 0000.
test('the HEVC time_code payload is the bits the spec orders, aligned with a one', () => {
	const { payload, payloadType } = buildHevcTimecodeSeiMessage(parseTimecode('01:00:00:00', 30));

	expect(payloadType, 'time_code').toBe(136);
	expect([...payload]).toEqual([0x70, 0x40, 0x00, 0x00, 0x04, 0x10]);

	// Drop-frame moves TWO fields, not one. `cnt_dropped_flag` is the twelfth bit, so the second octet
	// goes 0100 0000 -> 0101 0000; and `counting_type` becomes 4 (Table D.2: dropping the two lowest
	// n_frames counts when seconds is 0 and minutes is not a multiple of 10), which occupies bits 4 to
	// 8, so the first octet goes 0111 0000 -> 0111 0010. ffmpeg honours the drop flag only for counting
	// types 2 to 6, so with 0 there the timecode reads back as non-drop everywhere outside this
	// library - which is how it shipped in beta.806.
	const drop = buildHevcTimecodeSeiMessage(parseTimecode('01:00:00;00', 30000 / 1001));
	expect([...drop.payload]).toEqual([0x72, 0x50, 0x00, 0x00, 0x04, 0x10]);

	// 23:59:59:29 fills every field: n_frames 29, seconds and minutes 59, hours 23
	const full = buildHevcTimecodeSeiMessage(parseTimecode('23:59:59:29', 30));
	const bits = [...full.payload].map(x => x.toString(2).padStart(8, '0')).join('');
	expect(bits.slice(12, 21), 'n_frames 29').toBe((29).toString(2).padStart(9, '0'));
	expect(bits.slice(21, 27), 'seconds 59').toBe((59).toString(2).padStart(6, '0'));
	expect(bits.slice(27, 33), 'minutes 59').toBe((59).toString(2).padStart(6, '0'));
	expect(bits.slice(33, 38), 'hours 23').toBe((23).toString(2).padStart(5, '0'));
	expect(bits.slice(38, 43), 'time_offset_length 0').toBe('00000');
	expect(bits.slice(43), 'the alignment one, then zeros').toBe('10000');
});

test('an AVC pic_timing is written only where the SPS gives it a place', () => {
	const timecode = parseTimecode('01:00:00:00', 30);

	// pic_struct_present_flag is what makes the message readable: without it a decoder never looks
	expect(buildAvcTimecodeSeiMessage(timecode, { picStructPresentFlag: false, hrd: null } as AvcSpsInfo))
		.toBeNull();

	const message = buildAvcTimecodeSeiMessage(
		timecode,
		{ picStructPresentFlag: true, hrd: null } as AvcSpsInfo,
	);
	expect(message?.payloadType, 'pic_timing').toBe(1);

	// pic_struct 0000, clock_timestamp_flag 1, ct_type 00, nuit_field_based 1, counting_type 00000,
	// full_timestamp 1, discontinuity 0, cnt_dropped 0, then n_frames in EIGHT bits, not nine
	const bits = [...message!.payload].map(x => x.toString(2).padStart(8, '0')).join('');
	// pic_struct 0-3, clock_timestamp_flag 4, ct_type 5-6, nuit_field_based 7, counting_type 8-12,
	// full_timestamp 13, discontinuity 14, cnt_dropped 15, n_frames 16-23, s 24-29, m 30-35, h 36-40
	expect(bits.slice(0, 4), 'pic_struct: a frame').toBe('0000');
	expect(bits.slice(4, 5), 'clock_timestamp_flag').toBe('1');
	expect(bits.slice(8, 13), 'counting_type, five bits').toBe('00000');
	expect(bits.slice(13, 14), 'full_timestamp_flag').toBe('1');
	expect(bits.slice(16, 24), 'n_frames, eight bits wide here, not nine').toBe('00000000');
	expect(bits.slice(36, 41), 'hours 1').toBe('00001');
	// An SPS with no HRD still gets a time_offset: D.2.2 infers time_offset_length as 24 where none
	// is stated, so a message written without it is 24 bits short. ffmpeg's DECODER reads such a
	// message anyway; its conformance parser rejects it, which is how this was found.
	expect(bits.slice(41, 65), 'a 24-bit time_offset, inferred').toBe('0'.repeat(24));
	expect(bits.slice(65), 'then the alignment one and zeros').toBe('1000000');

	// An SPS declaring an HRD pushes the clock timestamp back by the delay fields it states
	const withHrd = buildAvcTimecodeSeiMessage(timecode, {
		picStructPresentFlag: true,
		hrd: { cpbRemovalDelayLength: 5, dpbOutputDelayLength: 5, timeOffsetLength: 0 },
	} as AvcSpsInfo);
	const hrdBits = [...withHrd!.payload].map(x => x.toString(2).padStart(8, '0')).join('');
	expect(hrdBits.slice(0, 10), 'the two delays, zero').toBe('0000000000');
	expect(hrdBits.slice(10, 14), 'then pic_struct').toBe('0000');
	expect(hrdBits.slice(46, 51), 'and hours, ten bits further along').toBe('00001');
	// This SPS states time_offset_length 0, so here there really is no time_offset field
	expect(hrdBits.slice(51), 'the alignment one follows at once').toBe('10000');
});
