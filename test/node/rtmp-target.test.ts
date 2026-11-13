/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// RTMP carries FLV, which this library does not mux, so RtmpTarget takes the fragmented MP4 an Output
// writes and remuxes it — the inverse of what RtmpSource does on the way in. Both ends run in process:
// the source listens, the target publishes into it.
//
// Stated coverage limit: the demo fixture never outruns ffmpeg, so the Readable's buffer never fills
// and the backpressure branch is not exercised - a mutation that ignores `push`'s return stays green.
// It needs a stream long enough to get ahead of the socket, which a unit test is the wrong place for.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { RtmpSource, RtmpTarget, registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import type { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = path.join(__dirname, '../public/demo.mp4');

// Clear of the other live bands: srt-target 17000+, rtmp-input 19000+, live-network-input 21000+
let nextPort = 18_200 + Math.floor(Math.random() * 400);
const freePort = () => nextPort++;

const timesOf = async (track: InputAudioTrack | InputVideoTrack) => {
	const times: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		times.push(packet.timestamp);
	}
	return times;
};

test('a published stream is read back by RtmpSource, with its timestamps', async () => {
	const port = freePort();
	const url = `rtmp://127.0.0.1:${port}/live/key`;

	// The listener has to be accepting before the publisher dials, and RtmpSource listens on its first
	// read - so the read starts first and the publish follows.
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 25, readTimeout: 15 });
	using received = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => ({
		video: await timesOf((await received.getPrimaryVideoTrack())!),
		audio: await timesOf((await received.getPrimaryAudioTrack())!),
	}))();

	// Fragmented, which is what lets the stream be demuxed before it ends
	const target = new RtmpTarget(url);
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target,
	});
	using input = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });
	await (await Conversion.init({ input, output, showWarnings: false })).execute();

	const got = await reading;
	const times = got.video;

	// The source's own presentation times, to compare against. Sorted on both sides: packets arrive in
	// decode order, so with B-frames the presentation times are not monotonic and never were.
	using original = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });
	const expected = await timesOf((await original.getPrimaryVideoTrack())!);
	const expectedAudio = await timesOf((await original.getPrimaryAudioTrack())!);

	// Two things a publish over FLV cannot preserve, and pretending otherwise would be a false test:
	// a live publish loses both ends (the listener is not accepting for the first fragment, and a
	// Conversion closes its own output while the receiver is still reading), and FLV timestamps are
	// integer milliseconds on a timeline ffmpeg restarts at zero, so the absolute values shift.
	//
	// What does survive is the shape of the timeline: the same frame interval, no reordering beyond the
	// source's own, no duplicates. That is what this asserts.
	expect(times.length).toBeGreaterThan(expected.length * 0.8);
	expect(times.length).toBeLessThanOrEqual(expected.length);

	const sorted = [...times].sort((a, b) => a - b);
	expect(new Set(sorted).size).toBe(sorted.length); // no duplicates

	const sourceSorted = [...expected].sort((a, b) => a - b);
	const sourceInterval = sourceSorted[1]! - sourceSorted[0]!;
	expect(sourceInterval).toBeGreaterThan(0);

	// From the second sample on, the grid is the source's own interval, offset by however much ffmpeg's
	// millisecond timeline restarted by. The first sample sits off that grid - measured, not assumed -
	// because the publish begins mid-fragment, so the interval is checked from the second step.
	for (let i = 2; i < sorted.length; i++) {
		expect(sorted[i]! - sorted[i - 1]!).toBeCloseTo(sourceInterval, 2);
	}

	// And the whole run spans what that many frames should span, so nothing was dropped in the middle
	const span = sorted[sorted.length - 1]! - sorted[1]!;
	expect(span).toBeCloseTo(sourceInterval * (sorted.length - 2), 2);

	expect(target.publishedPackets).toBeGreaterThan(10);

	// Both tracks ride the same restarted timeline, so each is shifted by one constant and the two
	// constants are the same one. A video track whose decode timeline starts below zero is the case that
	// gets this wrong: nothing but the fragmented init can state that delay, and a publisher that leaves
	// it unstated hands the receiver a video track its own reorder depth late against the audio.
	const shiftOf = (got: number[], source: number[], label: string) => {
		// A live publish loses the head, so the comparison starts at whatever the receiver's first packet
		// is; drops in the middle would show up as a shift that does not hold.
		const dropped = source.length - got.length;
		expect(dropped, label).toBeGreaterThanOrEqual(0);

		const shift = got[0]! - source[dropped]!;
		for (let i = 0; i < got.length; i++) {
			expect(got[i]! - source[dropped + i]!, `${label} packet ${i}`).toBeCloseTo(shift, 2);
		}

		return shift;
	};

	expect(got.audio.length).toBeGreaterThan(expectedAudio.length * 0.8);
	const videoShift = shiftOf(got.video, expected, 'video');
	const audioShift = shiftOf(got.audio, expectedAudio, 'audio');

	// FLV states integer milliseconds, so the two shifts agree to one of them rather than exactly
	expect(audioShift - videoShift).toBeCloseTo(0, 2);
}, 300_000);

test('only an rtmp URL is accepted, and the options are checked', () => {
	expect(() => new RtmpTarget('srt://127.0.0.1:9000')).toThrow(/rtmp/);
	expect(() => new RtmpTarget(123 as unknown as string)).toThrow(TypeError);
	// rtmps is the same protocol over TLS and is accepted
	expect(() => new RtmpTarget(`rtmps://127.0.0.1:${freePort()}/live/k`)).not.toThrow();
});
