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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { registerMediabunnyServer } from '@mediabunny/server';
import { startTimecodeOf } from '../../src/timecode.js';

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

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
// Both SEI fixtures are built by `scripts/build-timecode-sei-fixture.py`, and both were MALFORMED until
// 2026-11-19: the generator omitted `rbsp_trailing_bits`, so `payload_size` consumed the whole NAL unit
// and left nothing for the trailer. ffmpeg's decoder read them anyway and so does this library's reader -
// it unescapes first and then clamps a payload that runs past the end - which is exactly why neither
// noticed. This asserts a conformant parser accepts them, so a fixture cannot quietly go bad again.
test.skipIf(!hasFfmpeg)('the SEI fixtures are accepted by a conformance parser', () => {
	for (const name of ['timecode-sei-avc.mp4', 'timecode-sei-hevc.mp4']) {
		const run = spawnSync('ffmpeg', [
			'-v', 'error', '-i', path.join(__dirname, '../public', name),
			'-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
		], { encoding: 'utf8' });

		// ffmpeg exits 0 while printing the error, so its stderr is the signal
		expect(run.stderr.trim(), `${name} must parse cleanly`).toBe('');
	}
});

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

describe('a transport stream states it in the bitstream and reads it back', () => {
	// MPEG-TS has no timecode track, so the muxer writes a `time_code` SEI onto every access unit - and
	// the reader had no implementation at all, so a stream this library had just written read back as
	// having no timecode. Both ends are this fork's, so the round trip is the whole point.
	let workDir: string;
	beforeAll(() => {
		registerMediabunnyServer();
		workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-tc-'));
	});
	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/** Writes a transport stream whose pictures carry this timecode, and returns the file. */
	const writeTimecode = async (codec: 'avc' | 'hevc', timecode: string, frameRate: number, name: string) => {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec,
			bitrate: 1e6,
			hardwareAcceleration: 'prefer-software',
		});
		output.addVideoTrack(source, { frameRate, timecode });
		await output.start();

		const pixels = new Uint8Array(320 * 240 * 3 / 2).fill(0x80);
		for (let i = 0; i < 8; i++) {
			using sample = new VideoSample(pixels, {
				format: 'I420',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / frameRate,
				duration: 1 / frameRate,
			});
			await source.add(sample);
		}

		await output.finalize();

		const file = path.join(workDir, `${codec}-${name}.ts`);
		writeFileSync(file, new Uint8Array(output.target.buffer!));
		return file;
	};

	const roundTrip = async (codec: 'avc' | 'hevc', timecode: string, frameRate: number) => {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec,
			bitrate: 1e6,
			// No encoder controls: a track that states a timecode gets `pic_struct_present_flag` on its
			// own, which is the whole point - stating it by hand is not something a caller could guess
			hardwareAcceleration: 'prefer-software',
		});
		output.addVideoTrack(source, { frameRate, timecode });
		await output.start();

		const pixels = new Uint8Array(320 * 240 * 3 / 2).fill(0x80);
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(pixels, {
				format: 'I420',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / frameRate,
				duration: 1 / frameRate,
			});
			await source.add(sample);
		}

		await output.finalize();

		using input = new Input({
			source: new BufferSource(new Uint8Array(output.target.buffer!)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		// Awaited inside the `using` scope: returning the promise would dispose the input first
		return await track.getStartTimecode();
	};

	test('AVC states it in a pic_timing SEI', async () => {
		expect(await roundTrip('avc', '10:00:00:00', 25)).toEqual({
			hours: 10,
			minutes: 0,
			seconds: 0,
			frames: 0,
			dropFrame: false,
			frameRate: 25,
		});
	}, 60_000);

	test('a timecode that is not the top of an hour comes back whole', async () => {
		// Each field is its own run of bits, so one that was dropped or misread would show here and not
		// on a timecode that is all zeroes below the hour
		expect(await roundTrip('avc', '04:05:06:07', 25)).toEqual({
			hours: 4,
			minutes: 5,
			seconds: 6,
			frames: 7,
			dropFrame: false,
			frameRate: 25,
		});
	}, 60_000);

	test.each([['avc'], ['hevc']] as const)(
		'%s drop-frame states counting_type 4, which is what makes the drop flag count',
		async (codec) => {
			// H.264 Table D-3 and H.265 Table D.2 give `counting_type` 4 for "dropping of the two lowest
			// n_frames counts when seconds_value is 0 and minutes_value is not a multiple of 10", which
			// is NTSC drop-frame. ffmpeg honours `cnt_dropped_flag` ONLY for types 2 to 6, so under type
			// 0 a drop-frame timecode reads back as non-drop everywhere outside this library - our own
			// reader takes the flag at face value, so a round trip through it cannot catch this.
			const rate = 30000 / 1001;
			const file = await writeTimecode(codec, '01:00:00;00', rate, 'df');

			// What an external reader makes of it. A transport stream states the timecode in the
			// bitstream, so ffprobe surfaces it as SMPTE 12-1 frame side data rather than a stream tag,
			// and a SEMICOLON before the frames is what says drop-frame.
			const probed = execFileSync('ffprobe', [
				'-v', 'error', '-show_frames', '-show_entries', 'side_data=timecodes',
				'-of', 'default=nw=1', file,
			], { encoding: 'utf8' });

			const timecodes = [...probed.matchAll(/value=(\S+)/g)].map(match => match[1]);
			expect(timecodes.length, 'ffprobe found a timecode at all').toBeGreaterThan(0);
			expect(timecodes[0], 'ffprobe reads it as drop-frame').toBe('01:00:00;00');
		},
		60_000,
	);

	test('and a non-drop timecode states counting_type 0', async () => {
		const file = await writeTimecode('avc', '01:00:00:00', 25, 'ndf');

		const trace = execFileSync('sh', [
			'-c',
			`ffmpeg -v trace -i ${JSON.stringify(file)} -c copy -bsf:v trace_headers -f null - 2>&1 || true`,
		], { encoding: 'utf8', maxBuffer: 1 << 28 });

		expect(trace.match(/counting_type\s+[01]*\s+=\s+(\d+)/)?.[1]).toBe('0');
		expect(trace.match(/cnt_dropped_flag\s+[01]*\s+=\s+(\d+)/)?.[1]).toBe('0');
	}, 60_000);

	test('HEVC states it in a time_code SEI', async () => {
		expect(await roundTrip('hevc', '04:05:06:07', 25)).toEqual({
			hours: 4,
			minutes: 5,
			seconds: 6,
			frames: 7,
			dropFrame: false,
			frameRate: 25,
		});
	}, 60_000);
}, 180_000);
