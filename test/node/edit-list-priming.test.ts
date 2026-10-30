/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// An AAC encoder emits priming samples a decoder needs and a player never presents, and the container states
// the skip in its edit list. This library maps media time to presentation time, so those samples come out
// below zero rather than being dropped - a muxer copying the track needs them. What was missing was any way
// to tell that span apart from a track that simply starts early.

import { expect, test } from 'vitest';
import path from 'node:path';
import { registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

registerMediabunnyServer();

/** ffmpeg, `sine` through its AAC encoder: one 1024-sample priming frame, skipped by an edit list. */
const FIXTURE = path.join(__dirname, '..', 'public/aac-priming.mp4');

const SAMPLE_RATE = 48000;
const PRIMING_SAMPLES = 1024;
const PRIMING = PRIMING_SAMPLES / SAMPLE_RATE;

// What ffprobe reports for the fixture, which is the presentation every player agrees on
const FFPROBE_START_TIME = 0;
const FFPROBE_DURATION = 2;

const readTrack = async (input: Input) => {
	const track = (await input.getPrimaryAudioTrack())!;
	const packets: { timestamp: number; duration: number }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push({ timestamp: packet.timestamp, duration: packet.duration });
	}

	return { track, packets };
};

test('the edit list priming is reported as an offset rather than left to be inferred', async () => {
	using input = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });
	const { track, packets } = await readTrack(input);

	expect(await track.getPresentationOffset()).toBeCloseTo(PRIMING, 10);

	// The raw first packet is still there, below zero, for a muxer that copies the track
	expect(packets[0]!.timestamp).toBeCloseTo(-PRIMING, 10);
	expect(packets.length).toBe(95);

	// And dropping what the offset covers leaves exactly the presentation ffprobe reports
	const presented = packets.filter(p => p.timestamp + p.duration > 0);
	expect(presented.length).toBe(packets.length - 1);
	expect(presented[0]!.timestamp).toBeCloseTo(FFPROBE_START_TIME, 10);

	const end = presented.at(-1)!.timestamp + presented.at(-1)!.duration;
	expect(Math.abs(end - FFPROBE_DURATION)).toBeLessThanOrEqual(PRIMING);
	expect(Math.abs(await track.computeDuration() - FFPROBE_DURATION)).toBeLessThanOrEqual(PRIMING);
});

test('a track whose container states no such offset reports zero, not a guess', async () => {
	// Same AAC codec, no edit list in the file at all: if the offset came from anywhere but the container's own
	// statement - the codec, a constant, a default - this would read as priming too.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/encoder-push-aac.mp4')),
		formats: ALL_FORMATS,
	});
	const { track, packets } = await readTrack(input);

	expect(await track.getPresentationOffset()).toBe(0);
	expect(packets[0]!.timestamp).toBeGreaterThanOrEqual(0);
});

test('a mediabunny-written file states the same presentation as the file it was copied from', async () => {
	using original = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input: original, output });
	await conversion.execute();

	using copy = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const { track, packets } = await readTrack(copy);

	expect(await track.getPresentationOffset()).toBeCloseTo(PRIMING, 10);
	expect(packets[0]!.timestamp).toBeCloseTo(-PRIMING, 10);

	const presented = packets.filter(p => p.timestamp + p.duration > 0);
	expect(presented[0]!.timestamp).toBeCloseTo(FFPROBE_START_TIME, 10);
	expect(Math.abs(await track.computeDuration() - FFPROBE_DURATION)).toBeLessThanOrEqual(PRIMING);
}, 300_000);

// Matroska states the same fact as CodecDelay rather than an edit list, and the demuxer already subtracted it
// to produce presentation timestamps. Opus carries a real pre-skip, so these files are not contrived.
test.each([
	{ file: 'demo.webm', expected: 0.007 },
	{ file: 'ac3.mkv', expected: 0.005 },
])('a Matroska CodecDelay is reported as the same offset ($file)', async ({ file, expected }) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', file)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const offset = await track.getPresentationOffset();

	expect(offset).toBeCloseTo(expected, 3);

	// The delay is exactly what the first packet sits below zero by, which is the whole claim
	expect(await track.getFirstTimestamp()).toBeCloseTo(-offset, 10);
}, 300_000);

test('a Matroska video track alongside a delayed audio track reports no offset of its own', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/demo.webm')),
		formats: ALL_FORMATS,
	});
	const video = (await input.getPrimaryVideoTrack())!;

	expect(await video.getPresentationOffset()).toBe(0);
}, 300_000);
