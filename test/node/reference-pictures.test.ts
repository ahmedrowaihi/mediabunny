/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Which pictures a decoder still holds, checked against a decoder that holds them.
//
// `_reference-lists.json` is ffmpeg's own short term reference list after every coded picture of each
// fixture, captured by `_capture-reference-lists.ts`. It is captured rather than read at test
// time because `ffmpeg -debug mmco` is a debug log with no stable format - how many blocks it prints
// per picture, and whether the probe reports a stream's opening pictures twice, both differ between
// builds, and a test reading it directly failed in CI on the log's shape rather than on the code. The
// expected values are still a decoder's and not ours; what moved is when they were read.
//
// Every prefix is compared, not just the whole run. A marking process that is wrong in the middle and
// right at the end would pass a single comparison, and the sliding window and `mmco` only diverge
// once enough pictures are held for the choice of which one leaves to matter.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { buildSkipFrames } from '../../src/skip-frames.js';
import {
	ReferencePictureNotHeldError,
	UnsupportedReferenceMarkingError,
	referencePicturesAfter,
} from '../../src/reference-pictures.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (name: string) => path.join(__dirname, '../public/', name);

const codedSamples = async (file: string) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const sink = new EncodedPacketSink(track);
	const samples: Uint8Array[] = [];
	let packet = await sink.getFirstPacket();
	while (packet) {
		samples.push(packet.data);
		packet = await sink.getNextPacket(packet);
	}

	return { decoderConfig, samples };
};

const decoderLists = JSON.parse(
	readFileSync(path.join(__dirname, '_reference-lists.json'), 'utf8'),
) as Record<string, { frameNum: number; pictureOrderCount: number }[][]>;

describe('the marking process agrees with a decoder', () => {
	// Between them these cover `mmco 1` (every x264 B pyramid stream here uses it), a pure sliding
	// window with more than one picture held, several key frames in one run, a `frame_num` that wraps,
	// and both picture order count types.
	const cases: [label: string, fixture: string][] = [
		['b pyramid with mmco', 'video.mp4'],
		['b pyramid, second stream', 'demo.mp4'],
		['long run with mmco', 'edts.mp4'],
		['seven key frames', 'bear-640x360-av_frag.mp4'],
		['sliding window, three held', 'missing-tfdt.mp4'],
		['sliding window, four held', 'missing-reorder-metadata-v1.mp4'],
		['picture order count type 2', 'avc-range-full.mp4'],
		['high 4:4:4', 'avc-high444-8bit.mp4'],
		['high 10', 'avc-high10.mp4'],
	];

	test.each(cases)('%s', async (_label, fixture) => {
		const { decoderConfig, samples } = await codedSamples(publicFile(fixture));
		const expected = decoderLists[fixture];
		assert(expected);
		expect(expected).toHaveLength(samples.length);

		const asKey = (pictures: { frameNum: number | null; pictureOrderCount: number }[]) =>
			pictures.map(p => `${p.frameNum}/${p.pictureOrderCount}`).sort().join(' ');

		for (let n = 1; n <= samples.length; n++) {
			const mine = referencePicturesAfter(decoderConfig, samples.slice(0, n));
			expect(asKey(mine.pictures), `after ${n} samples of ${fixture}`)
				.toBe(asKey(expected[n - 1]!));
		}
	});
});

// A consumer falls back on these by class, so their identity is part of the contract. No encoder
// available emits the markings they cover, so the streams that carry them are built here: a real key
// frame followed by skip frames whose `dec_ref_pic_marking` states the operation under test. That
// makes the branch genuinely reached rather than reasoned about.
describe('the refusals a caller falls back on', () => {
	const withMarking = async (marking: { op: number; differenceOfPicNumsMinus1: number }[]) => {
		const { decoderConfig, samples } = await codedSamples(publicFile('video.mp4'));
		const keyFrame = samples[0]!;
		const marked = buildSkipFrames(decoderConfig, {
			count: 1,
			frameNum: 1,
			picOrderCntLsb: 2,
			__marking: marking,
		});

		return { decoderConfig, samples: [keyFrame, ...marked] };
	};

	test.each([
		[2, 'a long term picture'],
		[3, 'assigning a long term index'],
		[4, 'a long term index bound'],
		[5, 'resetting the buffer'],
		[6, 'marking the current picture long term'],
	])('memory_management_control_operation %i (%s) is refused', async (op) => {
		const { decoderConfig, samples } = await withMarking([{ op, differenceOfPicNumsMinus1: 0 }]);

		expect(() => referencePicturesAfter(decoderConfig, samples))
			.toThrow(UnsupportedReferenceMarkingError);
		expect(() => referencePicturesAfter(decoderConfig, samples))
			.toThrow(new RegExp(`operation ${op} is not modelled`));
	});

	test('operation 1, which is modelled, is not refused', async () => {
		// Without this the cases above would pass on a reader that refused every adaptive marking.
		const { decoderConfig, samples } = await withMarking([{ op: 1, differenceOfPicNumsMinus1: 0 }]);
		expect(() => referencePicturesAfter(decoderConfig, samples)).not.toThrow();
	});

	test('both error classes keep the names a consumer catches', () => {
		expect(new UnsupportedReferenceMarkingError('x').name).toBe('UnsupportedReferenceMarkingError');
		expect(new ReferencePictureNotHeldError('x').name).toBe('ReferencePictureNotHeldError');
		expect(new UnsupportedReferenceMarkingError('x')).toBeInstanceOf(Error);
		expect(new ReferencePictureNotHeldError('x')).toBeInstanceOf(Error);
	});
});

// A run may legitimately start at a mid-stream IRAP, and the pictures around a CRA carry negative
// picture order counts. What is reported has to be what the run decoded, not what is non-negative.
describe('a run starting at a mid-stream key frame', () => {
	test('holds the pictures it decoded, including negative picture order counts', async () => {
		const { decoderConfig, samples } = await codedSamples(publicFile('video-h265.mp4'));

		// The CRA this stream carries partway through.
		let craIndex = -1;
		for (let i = 1; i < samples.length; i++) {
			if (((samples[i]![4]! >> 1) & 0x3f) === 21) {
				craIndex = i;
				break;
			}
		}

		expect(craIndex, 'the fixture has to carry a mid-stream CRA').toBeGreaterThan(0);

		const set = referencePicturesAfter(decoderConfig, samples.slice(craIndex, craIndex + 6));
		const counts = set.pictures.map(p => p.pictureOrderCount).sort((a, b) => a - b);

		expect(counts.length).toBeGreaterThan(0);
		expect(counts.some(c => c < 0), 'pictures around a CRA count below zero').toBe(true);
		// Every reported picture is one this run actually decoded.
		expect(counts).toContain(set.lastDisplayedPictureOrderCount);
	});
});

describe('what referencePicturesAfter refuses', () => {
	test('a configuration with no parameter sets', () => {
		expect(() => referencePicturesAfter({ codec: 'avc1.640028', codedWidth: 64, codedHeight: 64 }, []))
			.toThrow(/description is required/);
	});

	test('a codec with no marking process to run', () => {
		expect(() => referencePicturesAfter(
			{ codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) },
			[],
		)).toThrow(/neither/);
	});

	test('samples that do not start at a key frame', async () => {
		const { decoderConfig, samples } = await codedSamples(publicFile('video.mp4'));
		// The second sample is a P picture, so the marking process has no state to run from.
		expect(() => referencePicturesAfter(decoderConfig, samples.slice(1, 3)))
			.toThrow(/do not start at a key frame/);
	});
});
