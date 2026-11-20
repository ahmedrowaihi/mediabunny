/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A segmented output opens one muxer per segment, and the decode anchor of a track whose decode timeline
// starts below zero is a property of the **track**: the init's edit list states it once, so a segment
// that worked it out for itself - zero, since its own first decode time is positive - is read under an
// edit list that shifts it, and presents that much early.
//
// Every row below reads the first presentation time back out of init + segment with **both** this
// library's demuxer and ffprobe, and compares it to the timestamp that was fed in. The `tfdt` and the
// `sidx`'s earliest presentation time are read out of the boxes.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat } from '../../src/output-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import {
	getInitSegmentTracks,
	getSegmentCompositionOffset,
	getSegmentDecodeTime,
	getSegmentPresentationTime,
	iterateIsobmffBoxes,
} from '../../src/isobmff/isobmff-misc.js';

registerMediabunnyServer();

const __dirname = new URL('.', import.meta.url).pathname;
const SOURCE = path.join(__dirname, '../public/demo.mp4');

/** The first `sidx`'s earliest presentation time, or null where the segment carries no index. */
const sidxPresentationTime = (segment: Uint8Array) => {
	const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
	for (const box of iterateIsobmffBoxes(segment)) {
		if (box.type !== 'sidx') {
			continue;
		}

		const at = box.start + box.headerSize;
		return view.getUint8(at) === 0 ? view.getUint32(at + 12) : Number(view.getBigUint64(at + 12));
	}

	return null;
};

/** ffprobe's own reading of init + segment, so the check does not rest on our demuxer alone. */
const ffprobeFirstPts = (bytes: Uint8Array) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-anchor-'));
	const file = path.join(dir, 'joined.mp4');
	writeFileSync(file, bytes);
	try {
		const out = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
			'-read_intervals', '%+#1', '-of', 'csv=p=0', file,
		], { encoding: 'utf8' });
		return Number(out.trim().split(',')[0]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

type Row = {
	segment: number;
	tfdt: number;
	sidx: number | null;
	ours: number;
	ffprobe: number;
	/** `getSegmentPresentationTime` in seconds, which is what a caller without a demuxer reads. */
	stated: number;
};

const write = async (options: { live: boolean; base: number; withAudio: boolean }): Promise<{
	rows: Row[];
	fed: number[];
	keyFrames: number[];
}> => {
	using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const audioTrack = (await input.getPrimaryAudioTrack())!;

	// Shifted so the video's first *presentation* time is zero, which puts its decode time below zero -
	// the case the anchor exists for. `mediaTimestampBase` then either leaves it there or lifts it clear.
	const shift = -(await videoTrack.getFirstTimestamp());
	const videoConfig = (await videoTrack.getDecoderConfig())!;
	const audioConfig = (await audioTrack.getDecoderConfig())!;

	let init: Uint8Array | null = null;
	const segments: Uint8Array[] = [];

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource((await audioTrack.getCodec())!);
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 2,
			mediaTimestampBase: options.base,
			live: options.live,
			onInit: target => void (init = new Uint8Array((target as BufferTarget).buffer!)),
			onSegment: target => void segments.push(new Uint8Array((target as BufferTarget).buffer!)),
		}),
		target: new PathedTarget('index.m3u8', () => new BufferTarget()),
	});
	output.addVideoTrack(videoSource);
	if (options.withAudio) {
		output.addAudioTrack(audioSource);
	}
	await output.start();

	const fed: number[] = [];
	const keyFrames: number[] = [];
	let firstVideo = true;
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		const shifted = packet.clone({
			timestamp: packet.timestamp + shift,
			decodeTimestamp: packet.decodeTimestamp + shift,
		});
		fed.push(shifted.timestamp);
		if (shifted.type === 'key') {
			keyFrames.push(shifted.timestamp);
		}
		await videoSource.add(shifted, firstVideo ? { decoderConfig: videoConfig } : undefined);
		firstVideo = false;
	}

	if (options.withAudio) {
		let firstAudio = true;
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			await audioSource.add(
				packet.clone({ timestamp: packet.timestamp + shift }),
				firstAudio ? { decoderConfig: audioConfig } : undefined,
			);
			firstAudio = false;
		}
	}

	await output.finalize();
	expect(init).not.toBeNull();
	expect(segments.length).toBeGreaterThan(2);

	const rows: Row[] = [];
	for (const [index, segment] of segments.entries()) {
		const joined = new Uint8Array([...init!, ...segment]);
		using read = new Input({ source: new BufferSource(joined), formats: ALL_FORMATS });
		const packet = await new EncodedPacketSink((await read.getPrimaryVideoTrack())!).getFirstPacket();

		const timescale = getInitSegmentTracks(init!)
			.find(track => track.handler === 'vide')!.timescale;

		rows.push({
			segment: index + 1,
			tfdt: getSegmentDecodeTime(segment)!,
			sidx: sidxPresentationTime(segment),
			ours: packet!.timestamp,
			ffprobe: ffprobeFirstPts(joined),
			stated: getSegmentPresentationTime(segment, init!) / timescale,
		});
	}

	return { rows, fed, keyFrames };
};

describe('the decode anchor is a track constant across segments', () => {
	const CASES = [
		{ live: false, base: 0, withAudio: false },
		{ live: false, base: 0, withAudio: true },
		{ live: true, base: 0, withAudio: false },
		{ live: true, base: 0, withAudio: true },
		{ live: false, base: 5, withAudio: false },
		{ live: false, base: 5, withAudio: true },
		{ live: true, base: 5, withAudio: false },
		{ live: true, base: 5, withAudio: true },
	];

	test.each(CASES)(
		'live=$live base=$base audio=$withAudio: every segment presents at the time it was fed',
		async (options) => {
			const { rows, fed, keyFrames } = await write(options);
			expect(keyFrames.length).toBeGreaterThanOrEqual(rows.length);
			expect(fed.length).toBeGreaterThan(keyFrames.length);

			for (const row of rows) {
				// A segment opens at a key frame, so its first packet presents at a key frame's own fed
				// time plus the base the pipeline states. Asserting merely that it was *some* fed time is
				// vacuous: the wrong value the per-segment anchor produced - one reorder delay low - is
				// itself a delta frame's timestamp on a 25 fps grid, and passes that.
				const expected = keyFrames.find(
					timestamp => Math.abs(timestamp + options.base - row.ours) < 1e-6,
				);
				expect(
					expected,
					`segment ${row.segment} presents at ${row.ours}, which is no key frame's time`
					+ ` (key frames: ${keyFrames.slice(0, 5).join(', ')})`,
				).toBeDefined();

				// And ffprobe reads the same thing out of the same bytes, as does reading the boxes alone
				expect(row.ffprobe, `segment ${row.segment} by ffprobe`).toBeCloseTo(row.ours, 3);
				expect(row.stated, `segment ${row.segment} by getSegmentPresentationTime`)
					.toBeCloseTo(row.ours, 3);
			}

			// The segments run forward and the tfdt rises with them: a segment whose tfdt did not get the
			// shift sits one reorder delay below where its presentation time says it is
			for (let i = 1; i < rows.length; i++) {
				expect(rows[i]!.tfdt, `segment ${i + 1} tfdt`).toBeGreaterThan(rows[i - 1]!.tfdt);
				expect(rows[i]!.ours, `segment ${i + 1} start`).toBeGreaterThan(rows[i - 1]!.ours);
			}

			// Where a sidx is written, it is on the same timeline as the tfdt it indexes
			for (const row of rows) {
				if (row.sidx !== null) {
					expect(row.sidx, `segment ${row.segment} sidx`).toBeGreaterThanOrEqual(row.tfdt);
				}
			}
		},
		300_000,
	);
});

// The helper is read by callers who have no demuxer in the path, so it is also checked against a file
// this library did not write and against one with no edit list at all, where it must collapse to the
// sum it is built from.
describe('getSegmentPresentationTime', () => {
	const write = (args: string[], name: string) => {
		const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-pts-'));
		const file = path.join(dir, name);
		execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', SOURCE, '-an', ...args, file]);
		return { dir, file };
	};

	const firstPtsPerSegment = (file: string) => execFileSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
		'-of', 'csv=p=0', file,
	], { encoding: 'utf8' }).trim().split('\n').map(Number);

	test.each([
		['with an edit list', ['-c:v', 'libx264', '-bf', '2', '-g', '50', '-use_editlist', '1']],
		['without one', ['-c:v', 'libx264', '-bf', '0', '-g', '50', '-use_editlist', '0']],
	])('an ffmpeg CMAF %s reads back as ffprobe reads it', (label, codecArgs) => {
		const { dir, file } = write(
			[...codecArgs, '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov', '-f', 'mp4'],
			'whole.mp4',
		);

		try {
			const bytes = new Uint8Array(readFileSync(file));
			const boxes = [...iterateIsobmffBoxes(bytes)];
			const firstMoof = boxes.findIndex(box => box.type === 'moof');
			expect(firstMoof).toBeGreaterThan(0);

			const init = bytes.subarray(0, boxes[firstMoof]!.start);
			const segment = bytes.subarray(boxes[firstMoof]!.start);
			const track = getInitSegmentTracks(init).find(candidate => candidate.handler === 'vide')!;

			// ffprobe's own first presentation time of the same bytes
			const expected = Math.min(...firstPtsPerSegment(file));
			expect(getSegmentPresentationTime(segment, init) / track.timescale).toBeCloseTo(expected, 3);

			// And where there is no edit list the helper is exactly the sum it is built from, which is the
			// case the two readings of a fragment agree in
			if (label === 'without one') {
				expect(track.editMediaTime).toBe(0);
				expect(getSegmentPresentationTime(segment, init))
					.toBe(getSegmentDecodeTime(segment)! + getSegmentCompositionOffset(segment, init));
			} else {
				expect(track.editMediaTime).toBeGreaterThan(0);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 300_000);
});
