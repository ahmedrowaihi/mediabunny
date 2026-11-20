/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Captures a decoder's own reference picture lists into `_reference-lists.json`, which
// `reference-pictures.test.ts` then compares the marking process against.
//
// This is captured rather than recomputed at test time because `ffmpeg -debug mmco` is a debug log
// with no stable format: how many blocks it prints per picture, and whether a stream's opening
// pictures are reported twice by the probe, both differ between builds. Running it in CI made the
// test fail on the log's shape rather than on anything about the code. The data below is still the
// decoder's, not ours - what moved is when it was read.
//
// The ffmpeg CLI is used here, and only here, because the lists are internal decoder bookkeeping with
// no API that reaches them. NodeAV cannot stand in: it exposes `Log.setLevel`/`Log.setCallback`, but
// the callback receives nothing - measured at `AV_LOG_TRACE` across demuxing, decoder creation and
// decoding, zero lines arrive - so FFmpeg's diagnostics are not reachable from in-process.
//
// Run with `npx tsx test/node/_capture-reference-lists.ts`, which needs an ffmpeg whose h264 decoder
// prints two list blocks per reference picture. It refuses to write anything it cannot structurally
// verify, so a build that prints a different shape fails here rather than quietly recording nonsense.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (name: string) => path.join(__dirname, '../public/', name);

const FIXTURES = [
	'video.mp4',
	'demo.mp4',
	'edts.mp4',
	'bear-640x360-av_frag.mp4',
	'missing-tfdt.mp4',
	'missing-reorder-metadata-v1.mp4',
	'avc-range-full.mp4',
	'avc-high444-8bit.mp4',
	'avc-high10.mp4',
];

/** The decoder's short term list after each coded picture, as the debug log reports it. */
const reportedLists = (file: string) => {
	const run = spawnSync('ffmpeg', ['-v', 'debug', '-debug', 'mmco', '-i', file, '-f', 'null', '-'], {
		encoding: 'utf8',
		maxBuffer: 1 << 28,
	});
	const lines = (run.stderr ?? '')
		.split('\n')
		.map(line => line.replace(/^\[h264 @ 0x[0-9a-f]*\] */, '').trim());

	const perPicture: { frameNum: number; pictureOrderCount: number }[][][] = [];
	for (const line of lines) {
		if (/^nal_unit_type: (1|5)\(/.test(line)) {
			perPicture.push([]);
			continue;
		}

		const current = perPicture[perPicture.length - 1];
		if (!current) {
			continue;
		}
		if (line === 'short term list:') {
			current.push([]);
			continue;
		}

		const entry = /^\d+ fn:(-?\d+) poc:(-?\d+)/.exec(line);
		if (entry && current.length > 0) {
			current[current.length - 1]!.push({
				frameNum: Number(entry[1]),
				pictureOrderCount: Number(entry[2]),
			});
		}
	}

	// The state after a picture is the last block it printed; one that printed none left it alone.
	const after: { frameNum: number; pictureOrderCount: number }[][] = [];
	let held: { frameNum: number; pictureOrderCount: number }[] = [];
	for (const blocks of perPicture) {
		const last = blocks[blocks.length - 1];
		if (last) {
			held = last;
		}

		after.push(held);
	}

	return after;
};

/** How many coded samples the fixture has, which is how many pictures the log must account for. */
const sampleCount = async (file: string) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
	const track = await input.getPrimaryVideoTrack();
	if (!track) {
		throw new Error(`${file} has no video track.`);
	}

	const sink = new EncodedPacketSink(track);
	let count = 0;
	let packet = await sink.getFirstPacket();
	while (packet) {
		count++;
		packet = await sink.getNextPacket(packet);
	}

	return count;
};

const captured: Record<string, { frameNum: number; pictureOrderCount: number }[][]> = {};

for (const fixture of FIXTURES) {
	const file = publicFile(fixture);
	const samples = await sampleCount(file);
	const all = reportedLists(file);

	// The probe decode runs before the real one, so the trailing records are the real decode.
	if (all.length < samples) {
		throw new Error(
			`${fixture}: ffmpeg reported ${all.length} pictures for ${samples} samples. This build does`
			+ ' not print a list per picture; capture with one that does.',
		);
	}

	const aligned = all.slice(all.length - samples);

	// Structural check, independent of our own marking process: the run has to begin at a key frame,
	// which holds exactly itself. A build printing the pre-marking block instead would start empty.
	if (aligned[0]!.length !== 1) {
		throw new Error(
			`${fixture}: the first aligned picture holds ${aligned[0]!.length} references, not 1. This`
			+ ' build log shape differs; capture with one that prints the post-marking block last.',
		);
	}

	// ffmpeg carries its own picture order count base, which differs between order count types. The
	// key frame is zero by definition, so its reported count is the base.
	const base = aligned[0]![0]!.pictureOrderCount;
	captured[fixture] = aligned.map(entries => entries
		.map(e => ({ frameNum: e.frameNum, pictureOrderCount: e.pictureOrderCount - base }))
		.sort((a, b) => a.pictureOrderCount - b.pictureOrderCount));

	console.log(`${fixture}: captured ${aligned.length} pictures`);
}

const out = path.join(__dirname, '_reference-lists.json');
writeFileSync(out, `${JSON.stringify(captured, null, '\t')}\n`);
console.log(`wrote ${out}`);
