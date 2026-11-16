/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A broadcast source states where its media sits on a timeline, which is not a duration: 01:00:00;00 is
// a label, and a consumer burning in MediaConvert's EMBEDDED timecode needs the label. MP4 and MOV carry
// it in a QuickTime `tmcd` track whose single sample is a frame number counted from 00:00:00:00.
//
// Drop-frame is the part worth testing: it drops *numbers*, not pictures - two a minute at 29.97, four at
// 59.94, except every tenth minute - so a frame number has to be renumbered before it is split into
// hours and minutes. Read naively, an hour of drop-frame reads as 00:59:56;12.

import path from 'node:path';
import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { startTimecodeOf } from '../../src/timecode.js';

const __dirname = new URL('.', import.meta.url).pathname;

const read = async (file: string) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public', file)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	return track.getStartTimecode();
};

test('a drop-frame 29.97 MOV reads its timecode, drop-frame flagged', async () => {
	// `ffmpeg -timecode '01:00:00;00'` on a 30000/1001 source
	expect(await read('timecode-df-2997.mov')).toEqual({
		hours: 1,
		minutes: 0,
		seconds: 0,
		frames: 0,
		dropFrame: true,
		frameRate: 30,
	});
});

test('a non-drop-frame 25 fps MOV reads its timecode', async () => {
	// `ffmpeg -timecode '10:00:00:00'` on a 25 fps source
	expect(await read('timecode-ndf-25.mov')).toEqual({
		hours: 10,
		minutes: 0,
		seconds: 0,
		frames: 0,
		dropFrame: false,
		frameRate: 25,
	});
});

// ffmpeg writes a `tmcd` track for `-timecode`, never the SEI, so this fixture is built by
// `scripts/build-hevc-timecode-fixture.py`, which lays out H.265 D.2.27 by hand and injects it as a
// prefix SEI. It carries no timecode track at all, so only the bitstream path can answer.
test('an HEVC time_code SEI is read when there is no timecode track', async () => {
	expect(await read('timecode-sei-hevc.mp4')).toEqual({
		hours: 4,
		minutes: 5,
		seconds: 6,
		frames: 7,
		dropFrame: false,
		frameRate: 25,
	});
});

// H.264's `pic_timing` is not self-describing: how many bits precede the clock timestamp, and whether
// one is there at all, are stated only by the SPS's VUI. x264 emits the message with
// `clock_timestamp_flag` 0, so the fixture's is injected by the same script as the HEVC one.
test('an H.264 pic_timing SEI is read when there is no timecode track', async () => {
	expect(await read('timecode-sei-avc.mp4')).toEqual({
		hours: 4,
		minutes: 5,
		seconds: 6,
		frames: 7,
		dropFrame: false,
		frameRate: 25,
	});
});

test('a file with no timecode track reads null', async () => {
	expect(await read('demo.mp4')).toBe(null);
});

// The arithmetic on its own, where the renumbering is visible. Frame counts are what a `tmcd` sample
// holds, so these are the values the reader above actually converts.
test('drop-frame renumbering', () => {
	const at = (frames: number) => {
		const { hours, minutes, seconds, frames: f } = startTimecodeOf(frames, 30, true);
		return `${hours}:${minutes}:${seconds};${f}`;
	};

	expect(at(0)).toBe('0:0:0;0');
	// The first minute keeps all 1800 of its numbers; the drop happens as the minute increments, so the
	// frame after it is ;02 rather than ;00. Every later minute is then 1798 numbers long.
	expect(at(1799)).toBe('0:0:59;29');
	expect(at(1800)).toBe('0:1:0;2');
	// The tenth minute is the exception: no numbers are skipped there
	expect(at(17982)).toBe('0:10:0;0');
	expect(at(107892)).toBe('1:0:0;0');

	// Without the renumbering an hour would read as 00:59:56;12, which is the bug this guards
	const naive = startTimecodeOf(107892, 30, false);
	expect(`${naive.hours}:${naive.minutes}:${naive.seconds}:${naive.frames}`).toBe('0:59:56:12');
});

test('59.94 drops four numbers a minute, not two', () => {
	const { minutes, seconds, frames } = startTimecodeOf(60 * 60, 60, true);
	expect(`${minutes}:${seconds};${frames}`).toBe('1:0;4');
});
