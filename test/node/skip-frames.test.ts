/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A skip frame is written here and read back by ffmpeg's decoder, never by ours. Nothing in this
// repository can judge a CABAC bin: a reader of our own would agree with whatever the writer did,
// including the state tables, which were taken from the standard and are the part most likely to be
// wrong. What the decoder cannot hide is the picture - a skip frame that codes anything other than
// "copy the last one" decodes to different pixels, which is what these assert on.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert } from '../../src/misc.js';
import { Decoder, Demuxer } from 'node-av/api';
import { registerMediabunnyServer } from '@mediabunny/server';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { BufferSource } from '../../src/source.js';
import {
	__idrPicIdsOf,
	buildKeyFrameFill,
	buildSkipFrames,
	FrameFillError,
	MissingKeyFrameError,
	MissingParameterSetsError,
	UnsupportedFillCodecError,
	UnsupportedTilesError,
	type SkipFrameOptions,
} from '../../src/skip-frames.js';
import {
	parameterSetsFromHvcC,
	parseHevcPpsForSkip,
	ReferencePictureNotHeldError,
	referencePicturesAfter,
} from '../../src/reference-pictures.js';
import { BitWriter, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (name: string) => path.join(__dirname, '../public/', name);

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-skip-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/**
 * The md5 of each decoded frame, in display order, through libavformat and libavcodec. Decoding
 * raises rather than returns on a broken bitstream, so a test that gets hashes back has already
 * established that the frames decode.
 */
const frameHashes = async (file: string) => {
	const input = await Demuxer.open(file);
	try {
		const stream = input.video();
		assert(stream);
		const decoder = await Decoder.create(stream);
		const hashes: string[] = [];

		for await (const frame of decoder.frames(input.packets(stream.index))) {
			if (!frame) {
				continue;
			}

			hashes.push(createHash('md5').update(frame.toBuffer()).digest('hex'));
			frame.free();
		}

		return hashes;
	} finally {
		await input.close();
	}
};

const SKIP_COUNT = 5;

/** A file holding one real key frame followed by `SKIP_COUNT` built skip frames. */
const keyFrameThenSkips = async (label: string, sourceName: string) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile(sourceName)) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const codec = await track.getCodec();
	assert(codec === 'avc' || codec === 'hevc');

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();

	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);
	await source.add(firstPacket, { decoderConfig });

	// AVC counts picture order in fields, HEVC in frames, so the step differs between them.
	const step = codec === 'hevc' ? 1 : 2;
	const skips = buildSkipFrames(decoderConfig, {
		count: SKIP_COUNT,
		frameNum: 1,
		picOrderCntLsb: step,
		picOrderCntStep: step,
	});
	expect(skips).toHaveLength(SKIP_COUNT);

	for (let i = 0; i < SKIP_COUNT; i++) {
		await source.add(new EncodedPacket(skips[i]!, 'delta', (i + 1) / 25, 1 / 25));
	}

	await output.finalize();
	assert(output.target.buffer);

	const file = path.join(workDir, `${label}.mp4`);
	writeFileSync(file, Buffer.from(output.target.buffer));
	return file;
};

describe('skip frames decode to the picture before them', () => {
	// Each of these reaches a different part of the writer: the two AVC entropy coders, HEVC with and
	// without the per-row substreams that wavefront parallelism needs, a PPS carrying a scaling list,
	// and a 4:4:4 stream whose chroma arrays change which syntax the slice header has to state.
	const cases: [label: string, fixture: string][] = [
		['avc-cabac', 'video.mp4'],
		['avc-high10', 'avc-high10.mp4'],
		['avc-high444', 'avc-high444-8bit.mp4'],
		['hevc-wpp', 'video-h265.mp4'],
		['hevc-no-wpp', 'sps-only-sar-hevc.mp4'],
		['hevc-multi-slice', 'hevc-multi-slice.mp4'],
		['hevc-scaling-list', 'hevc-scaling-list.mp4'],
		['hevc-444', 'timecode-sei-hevc.mp4'],
	];

	test.each(cases)('%s', async (label, fixture) => {
		const file = await keyFrameThenSkips(label, fixture);

		// Decoding raises on a broken bitstream, so reaching the assertions is itself the check that
		// every frame decoded.
		const hashes = await frameHashes(file);
		expect(hashes.length).toBeGreaterThan(1);
		// Every frame after the key frame is the key frame again.
		expect(new Set(hashes).size).toBe(1);
	});

	test('the same comparison separates frames that are not repeats', async () => {
		// Without this, a decoder that returned one frame forever would satisfy every case above.
		const hashes = (await frameHashes(publicFile('video.mp4'))).slice(0, 1 + SKIP_COUNT);
		expect(hashes.length).toBe(1 + SKIP_COUNT);
		expect(new Set(hashes).size).toBe(1 + SKIP_COUNT);
	});
});

/**
 * A file holding the first `prefix` packets of `source` in decode order, then `count` skip frames.
 * Returns the hashes of that file's frames and of the prefix alone, so a filler can be matched
 * against the picture it copied by its position in display order.
 */
const fillAfterPrefix = async (
	label: string,
	source: string,
	prefix: number,
	skipOptions: SkipFrameOptions | null,
) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(source) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const codec = await track.getCodec();
	assert(codec === 'avc' || codec === 'hevc');

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const packetSource = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(packetSource, { frameRate: 25 });
	await output.start();

	const sink = new EncodedPacketSink(track);
	let packet = await sink.getFirstPacket();
	let n = 0;
	while (packet && n < prefix) {
		await packetSource.add(packet, n === 0 ? { decoderConfig } : undefined);
		packet = await sink.getNextPacket(packet);
		n++;
	}

	if (skipOptions) {
		const skips = buildSkipFrames(decoderConfig, skipOptions);
		for (let i = 0; i < skips.length; i++) {
			await packetSource.add(new EncodedPacket(skips[i]!, 'delta', (n + i) / 25, 1 / 25));
		}
	}

	await output.finalize();
	assert(output.target.buffer);
	const file = path.join(workDir, `${label}.mp4`);
	writeFileSync(file, Buffer.from(output.target.buffer));
	return frameHashes(file);
};

// `test/public/video.mp4` is a B pyramid: decode order is IDR, P(poc 8), Bref(4), b(2), b(6),
// P(16), Bref(12), b(10), b(14). Cut after nine pictures and the viewer has last seen the P at
// poc 16, while the most recently decoded reference is the Bref at poc 12 - which is what an
// unmodified reference list puts at index 0.
const PYRAMID_PREFIX = 9;
const PYRAMID_FRAME_NUM = 5;
const PYRAMID_FILL_POC = 18;

describe('copyFromDistance, where the last reference is not the last picture', () => {
	test('left to itself, the fill copies a picture the stream has moved past', async () => {
		const base = await fillAfterPrefix('pyr-base', publicFile('video.mp4'), PYRAMID_PREFIX, null);
		const filled = await fillAfterPrefix('pyr-default', publicFile('video.mp4'), PYRAMID_PREFIX,
			{ count: 5, frameNum: PYRAMID_FRAME_NUM, picOrderCntLsb: PYRAMID_FILL_POC });

		const filler = filled.slice(base.length);
		expect(filler).toHaveLength(5);
		expect(new Set(filler).size).toBe(1);
		// Two display positions behind the last picture, which is the defect copyFromDistance exists for.
		expect(base.indexOf(filler[0]!)).toBe(base.length - 3);
	});

	test('stating the distance copies the last displayed picture', async () => {
		const base = await fillAfterPrefix('pyr-base2', publicFile('video.mp4'), PYRAMID_PREFIX, null);
		const filled = await fillAfterPrefix('pyr-stated', publicFile('video.mp4'), PYRAMID_PREFIX, {
			count: 5,
			frameNum: PYRAMID_FRAME_NUM,
			picOrderCntLsb: PYRAMID_FILL_POC,
			copyFromDistance: 2,
		});

		const filler = filled.slice(base.length);
		expect(filler).toHaveLength(5);
		// Every one of them, not just the first: the modification is relative to each picture's own
		// number, so only the first frame may carry it.
		expect(new Set(filler).size).toBe(1);
		expect(base.indexOf(filler[0]!)).toBe(base.length - 1);
	});
});

describe('copyFromDistance counts picture order in HEVC', () => {
	// Twenty-two samples rather than the whole file: this stream's last two pictures are decoded after
	// the one with the highest picture order count, so cutting here leaves the last picture displayed
	// also held as a reference. Naming a picture the decoder has already released is no test of
	// anything - ffmpeg tolerates it and returns the right pixels, so the assertion would pass for the
	// wrong reason.
	//
	// Only the distance that names the last displayed picture is asserted here, because display
	// position is what can be checked against a decoder and the counts do not run in step with it once
	// pictures are reordered. The arithmetic for larger distances is covered on the AVC side, and the
	// picture order count domain by the identity test below.
	test('a distance of one copies the last picture displayed', async () => {
		const source = publicFile('hevc-multi-slice.mp4');
		const base = await fillAfterPrefix('hevc-distance-base', source, 22, null);
		const filled = await fillAfterPrefix('hevc-distance', source, 22, {
			count: 4,
			frameNum: 0,
			picOrderCntLsb: 24,
			picOrderCntStep: 1,
			copyFromDistance: 1,
		});

		const filler = filled.slice(base.length);
		expect(filler).toHaveLength(4);
		expect(new Set(filler).size).toBe(1);
		expect(base.indexOf(filler[0]!)).toBe(base.length - 1);
	});
});

describe('naming the copied picture instead of its distance', () => {
	const samplesOf = async (fixture: string, count: number) => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile(fixture)) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);

		const sink = new EncodedPacketSink(track);
		const samples: Uint8Array[] = [];
		let packet = await sink.getFirstPacket();
		while (packet && samples.length < count) {
			samples.push(packet.data);
			packet = await sink.getNextPacket(packet);
		}

		return { decoderConfig, samples };
	};

	test('the picture the viewer last saw is copied, with no arithmetic from the caller', async () => {
		const { decoderConfig, samples } = await samplesOf('video.mp4', PYRAMID_PREFIX);
		const set = referencePicturesAfter(decoderConfig, samples);

		// The defect this exists for: the last picture displayed is held, but it is not the one an
		// unmodified reference list puts at index 0.
		expect(set.pictures.some(p => p.pictureOrderCount === set.lastDisplayedPictureOrderCount))
			.toBe(true);

		const base = await fillAfterPrefix('ident-base', publicFile('video.mp4'), PYRAMID_PREFIX, null);
		const filled = await fillAfterPrefix('ident', publicFile('video.mp4'), PYRAMID_PREFIX, {
			count: 5,
			precedingSamples: samples,
			copyPictureOrderCount: set.lastDisplayedPictureOrderCount,
		});

		const filler = filled.slice(base.length);
		expect(filler).toHaveLength(5);
		expect(new Set(filler).size).toBe(1);
		expect(base.indexOf(filler[0]!)).toBe(base.length - 1);
	});

	test('frameNum and picOrderCntLsb are derived from the samples', async () => {
		const { decoderConfig, samples } = await samplesOf('video.mp4', PYRAMID_PREFIX);
		const set = referencePicturesAfter(decoderConfig, samples);

		// What the caller would otherwise have had to work out, and what this run of fixtures states.
		expect(set.nextFrameNum).toBe(PYRAMID_FRAME_NUM);
		expect(set.lastDisplayedPictureOrderCount).toBe(16);

		// Stating neither still builds, because the samples state both.
		expect(buildSkipFrames(decoderConfig, { count: 3, precedingSamples: samples })).toHaveLength(3);
	});

	test('HEVC names the picture by picture order count, not by frame_num', async () => {
		// The AVC fixture gives the same number either way - a frame_num distance of two and a picture
		// order count distance of two - so only HEVC separates the two domains.
		const { decoderConfig, samples } = await samplesOf('hevc-multi-slice.mp4', 22);
		const set = referencePicturesAfter(decoderConfig, samples);
		expect(set.nextFrameNum).toBeNull();
		expect(set.pictures.some(p => p.pictureOrderCount === set.lastDisplayedPictureOrderCount))
			.toBe(true);

		const base = await fillAfterPrefix('hevc-ident-base', publicFile('hevc-multi-slice.mp4'), 22, null);
		const filled = await fillAfterPrefix('hevc-ident', publicFile('hevc-multi-slice.mp4'), 22, {
			count: 4,
			picOrderCntStep: 1,
			precedingSamples: samples,
			copyPictureOrderCount: set.lastDisplayedPictureOrderCount,
		});

		const filler = filled.slice(base.length);
		expect(filler).toHaveLength(4);
		expect(new Set(filler).size).toBe(1);
		expect(base.indexOf(filler[0]!)).toBe(base.length - 1);
	});

	test('the derived picture order counts continue past the last picture', async () => {
		const { decoderConfig, samples } = await samplesOf('video.mp4', PYRAMID_PREFIX);
		const set = referencePicturesAfter(decoderConfig, samples);
		const step = 2;

		const skips = buildSkipFrames(decoderConfig, { count: 3, precedingSamples: samples });

		// Read the fill back with the marking process, which is checked against a decoder in
		// reference-pictures.test.ts - so it can be used here as an instrument. A fill that started at
		// the last picture's own count rather than past it would collide with a picture already
		// decoded, which no pixel comparison can see.
		const after = referencePicturesAfter(decoderConfig, [...samples, ...skips]);
		const expectedFirst = set.lastDisplayedPictureOrderCount + step;
		expect(after.lastDisplayedPictureOrderCount).toBe(expectedFirst + step * (skips.length - 1));
		expect(after.pictures.map(p => p.pictureOrderCount).sort((a, b) => a - b))
			.toContain(expectedFirst);
	});

	test('a picture that is not held refuses by name', async () => {
		const { decoderConfig, samples } = await samplesOf('video.mp4', PYRAMID_PREFIX);

		expect(() => buildSkipFrames(decoderConfig, {
			count: 1,
			precedingSamples: samples,
			copyPictureOrderCount: 99999,
		})).toThrow(ReferencePictureNotHeldError);

		// A picture that WAS decoded but is no longer a reference is refused the same way; poc 0 is the
		// key frame, which this stream's marking has already released by then.
		const released = referencePicturesAfter(decoderConfig, samples);
		expect(released.pictures.some(p => p.pictureOrderCount === 0)).toBe(false);
		expect(() => buildSkipFrames(decoderConfig, {
			count: 1,
			precedingSamples: samples,
			copyPictureOrderCount: 0,
		})).toThrow(ReferencePictureNotHeldError);
	});

	test('a picture that is not behind the fill is refused', async () => {
		const { decoderConfig, samples } = await samplesOf('hevc-multi-slice.mp4', 22);
		const set = referencePicturesAfter(decoderConfig, samples);
		const target = set.lastDisplayedPictureOrderCount;

		// Placing the fill AT that picture's own count rather than past it leaves nothing behind it to
		// copy, which is a caller error rather than something to encode as a zero distance.
		expect(() => buildSkipFrames(decoderConfig, {
			count: 1,
			picOrderCntLsb: target,
			picOrderCntStep: 1,
			precedingSamples: samples,
			copyPictureOrderCount: target,
		})).toThrow(/only copy a picture that precedes it/);
	});

	test('copyPictureOrderCount without the samples is refused', () => {
		const config = { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) };
		expect(() => buildSkipFrames(config, { count: 1, frameNum: 0, copyPictureOrderCount: 4 }))
			.toThrow(/requires precedingSamples/);
	});

	test('frameNum is required when there are no samples to derive it from', () => {
		const config = { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) };
		expect(() => buildSkipFrames(config, { count: 1 })).toThrow(/frameNum is required/);
	});
});

// A fill numbered just after a `frame_num` wrap sits below the picture it copies, so the distance
// between them is modular. Both fixtures wrap within the file.
describe.each(['video.mp4', 'missing-tfdt.mp4'])('%s: a frame_num wrap does not refuse a held picture', (fixture) => {
	test('every prefix whose last displayed picture is held builds', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile(fixture)) });
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

		let built = 0;
		const wrapped: number[] = [];
		const refused: string[] = [];
		for (let n = 1; n <= samples.length; n++) {
			const prefix = samples.slice(0, n);
			const set = referencePicturesAfter(decoderConfig, prefix);
			const target = set.lastDisplayedPictureOrderCount;
			const held = set.pictures.find(p => p.pictureOrderCount === target);
			if (!held) {
				continue;
			}

			// The case that used to throw: the next number is below the one being copied.
			if (set.nextFrameNum !== null && set.nextFrameNum <= held.frameNum!) {
				wrapped.push(n);
			}

			try {
				buildSkipFrames(decoderConfig, {
					count: 1,
					precedingSamples: prefix,
					copyPictureOrderCount: target,
				});
				built++;
			} catch (error) {
				refused.push(`${n}: ${(error as Error).name}`);
			}
		}

		expect(wrapped.length, 'the fixture has to reach a wrap for this to test anything')
			.toBeGreaterThan(0);
		expect(refused).toEqual([]);
		expect(built).toBeGreaterThan(0);

		// Building is not enough: a distance taken on the wrong modulus still builds, it just names a
		// picture that is not there. Decode the wrapped ones and check which picture came out.
		for (const n of wrapped.slice(0, 3)) {
			const set = referencePicturesAfter(decoderConfig, samples.slice(0, n));
			const base = await fillAfterPrefix(`${fixture}-wrap-${n}-base`, publicFile(fixture), n, null);
			const filled = await fillAfterPrefix(`${fixture}-wrap-${n}`, publicFile(fixture), n, {
				count: 2,
				precedingSamples: samples.slice(0, n),
				copyPictureOrderCount: set.lastDisplayedPictureOrderCount,
			});

			const filler = filled.slice(base.length);
			expect(filler, `prefix ${n}`).toHaveLength(2);
			expect(new Set(filler).size, `prefix ${n}`).toBe(1);
			expect(base.indexOf(filler[0]!), `prefix ${n}`).toBe(base.length - 1);
		}
	}, 120_000);
});

// HEVC retains the forward entries of a reference picture set: they are later in display order but
// earlier in decode order, so the picture is in the buffer and a fill can copy it.
describe.each(['hevc-multi-slice.mp4', 'hevc-scaling-list.mp4'])(
	'%s: forward reference set entries are held',
	(fixture) => {
		test('every prefix can copy the picture last displayed', async () => {
			const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile(fixture)) });
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

			const notHeld: number[] = [];
			for (let n = 2; n <= samples.length; n++) {
				const set = referencePicturesAfter(decoderConfig, samples.slice(0, n));
				if (!set.pictures.some(p => p.pictureOrderCount === set.lastDisplayedPictureOrderCount)) {
					notHeld.push(n);
				}
			}

			expect(notHeld).toEqual([]);
		}, 120_000);
	});

// Repeating a key frame is the fill for a gap no skip frame can cover. Consecutive IDR pictures must
// state different `idr_pic_id` values (7.4.3), including against the real key frame placed after them.
describe('buildKeyFrameFill', () => {
	const fillThenOriginal = async (label: string, decoderConfig: VideoDecoderConfig, keyFrame: Uint8Array) => {
		const fill = buildKeyFrameFill(keyFrame, decoderConfig, { count: 3 });
		expect(fill).toHaveLength(3);

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, { frameRate: 25 });
		await output.start();
		for (let i = 0; i < fill.length; i++) {
			await source.add(
				new EncodedPacket(fill[i]!, 'key', i / 25, 1 / 25),
				i === 0 ? { decoderConfig } : undefined,
			);
		}

		// The real key frame directly after the run, which is what the ids have to differ from.
		await source.add(new EncodedPacket(keyFrame, 'key', fill.length / 25, 1 / 25));
		await output.finalize();
		assert(output.target.buffer);

		const file = path.join(workDir, `${label}.mp4`);
		writeFileSync(file, Buffer.from(output.target.buffer));

		const ids = [...fill, keyFrame].map(unit => __idrPicIdsOf(unit, decoderConfig));
		return { file, ids };
	};

	test('a repeated key frame decodes to the same picture, with ids that differ', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile('video.mp4')) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		const keyFrame = await new EncodedPacketSink(track).getFirstPacket();
		assert(keyFrame);

		const { file, ids } = await fillThenOriginal('kff-single', decoderConfig, keyFrame.data);

		// Four access units, one picture.
		const hashes = await frameHashes(file);
		expect(hashes).toHaveLength(4);
		expect(new Set(hashes).size).toBe(1);

		// One slice each here, and no two in a row state the same id.
		expect(ids.every(perUnit => perUnit.length === 1)).toBe(true);
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i]![0], `unit ${i}`).not.toBe(ids[i - 1]![0]);
		}
	}, 120_000);

	test('a multi-slice key frame has every slice rewritten', async () => {
		registerMediabunnyServer();

		// Nothing in test/public carries more than one slice per IDR, so one is encoded. The software
		// encoder is required: the hardware one has no slice control and ignores the option in silence.
		const encoded = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const encodeSource = new VideoSampleSource({
			codec: 'avc',
			bitrate: 2e6,
			keyFrameInterval: 1,
			hardwareAcceleration: 'prefer-software',
			encoderControls: { options: { 'x264-params': 'slices=4' } },
		});
		encoded.addVideoTrack(encodeSource);
		await encoded.start();

		const pixels = new Uint8Array(320 * 240 * 4);
		for (let i = 0; i < pixels.length; i++) {
			pixels[i] = (i * 7) & 0xff;
		}
		for (let i = 0; i < 3; i++) {
			using sample = new VideoSample(pixels, {
				format: 'RGBX',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / 25,
				duration: 1 / 25,
			});
			await encodeSource.add(sample);
		}

		encodeSource.close();
		await encoded.finalize();
		assert(encoded.target.buffer);

		const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(encoded.target.buffer) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		const keyFrame = await new EncodedPacketSink(track).getFirstPacket();
		assert(keyFrame);

		const { file, ids } = await fillThenOriginal('kff-multi', decoderConfig, keyFrame.data);

		expect(ids[0]!.length, 'the encode has to carry several slices per picture').toBeGreaterThan(1);
		// Every slice of one access unit states the same id, and it differs from the unit before.
		for (const perUnit of ids) {
			expect(new Set(perUnit).size).toBe(1);
		}
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i]![0], `unit ${i}`).not.toBe(ids[i - 1]![0]);
		}

		const hashes = await frameHashes(file);
		expect(hashes).toHaveLength(4);
		expect(new Set(hashes).size).toBe(1);
	}, 120_000);

	test('what it refuses', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile('video.mp4')) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		const keyFrame = await new EncodedPacketSink(track).getFirstPacket();
		assert(keyFrame);

		expect(() => buildKeyFrameFill(keyFrame.data, decoderConfig, { count: -1 })).toThrow(/count/);
		expect(() => buildKeyFrameFill(keyFrame.data, { ...decoderConfig, codec: 'hvc1.1.6.L93.B0' },
			{ count: 1 })).toThrow(/only AVC has/);
		expect(() => buildKeyFrameFill(keyFrame.data, { ...decoderConfig, description: undefined },
			{ count: 1 })).toThrow(/description is required/);
		// A delta packet carries no IDR slice to repeat.
		const second = await new EncodedPacketSink(track).getNextPacket(keyFrame);
		assert(second);
		expect(() => buildKeyFrameFill(second.data, decoderConfig, { count: 1 }))
			.toThrow(/no IDR slice/);
	});
});

describe('what buildSkipFrames refuses', () => {
	test('a configuration with no parameter sets', () => {
		expect(() => buildSkipFrames({ codec: 'avc1.640028', codedWidth: 64, codedHeight: 64 },
			{ count: 1, frameNum: 0 })).toThrow(/description is required/);
	});

	test('a codec that has no skip picture to build', () => {
		expect(() => buildSkipFrames(
			{ codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) },
			{ count: 1, frameNum: 0 },
		)).toThrow(/neither/);
	});

	test('counts and numbers that are not whole', () => {
		const config = { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) };
		expect(() => buildSkipFrames(config, { count: -1, frameNum: 0 })).toThrow(/count/);
		expect(() => buildSkipFrames(config, { count: 1, frameNum: -1 })).toThrow(/frameNum/);
		expect(() => buildSkipFrames(config, { count: 1, frameNum: 0, picOrderCntStep: 0 }))
			.toThrow(/picOrderCntStep/);
		expect(() => buildSkipFrames(config, { count: 1, frameNum: 0, copyFromDistance: 0 }))
			.toThrow(/copyFromDistance/);
	});

	test('a count of zero builds nothing', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile('video.mp4')) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);

		expect(buildSkipFrames(decoderConfig, { count: 0, frameNum: 1 })).toEqual([]);
	});
});

describe('every refusal buildSkipFrames and buildKeyFrameFill make is named', () => {
	test('a codec neither function can code', () => {
		expect(() => buildSkipFrames(
			{ codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) },
			{ count: 1, frameNum: 0 },
		)).toThrow(UnsupportedFillCodecError);

		// Only AVC states idr_pic_id, so HEVC is refused here while buildSkipFrames accepts it.
		expect(() => buildKeyFrameFill(
			new Uint8Array(8),
			{ codec: 'hvc1.1.6.L93.B0', codedWidth: 64, codedHeight: 64, description: new Uint8Array(32) },
			{ count: 1 },
		)).toThrow(UnsupportedFillCodecError);
	});

	test('a configuration carrying no parameter sets', () => {
		expect(() => buildSkipFrames(
			{ codec: 'avc1.640028', codedWidth: 64, codedHeight: 64 },
			{ count: 1, frameNum: 0 },
		)).toThrow(MissingParameterSetsError);

		expect(() => buildKeyFrameFill(
			new Uint8Array(8),
			{ codec: 'avc1.640028', codedWidth: 64, codedHeight: 64 },
			{ count: 1 },
		)).toThrow(MissingParameterSetsError);

		// An avcC whose arrays are empty parses, and then has no SPS or PPS to code against.
		expect(() => buildSkipFrames(
			{ codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) },
			{ count: 1, frameNum: 0 },
		)).toThrow(MissingParameterSetsError);
	});

	test('a PPS that enables tiles', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile('video-h265.mp4')) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const config = await track.getDecoderConfig();
		assert(config?.description);

		const description = hvcCWithTiledPps(toUint8Array(config.description));

		// The oracle for the input is the PPS parser, not the refusal being tested: it must report the
		// flag set, and the preceding fields at the neutral values written below.
		const { ppsList } = parameterSetsFromHvcC(description);
		const parsed = parseHevcPpsForSkip(ppsList[0]!);
		expect(parsed?.tilesEnabledFlag).toBe(true);
		expect(parsed?.id).toBe(0);
		expect(parsed?.spsId).toBe(0);
		expect(parsed?.initQpMinus26).toBeCloseTo(0);

		// No frameNum: HEVC codes none, so reaching the refusal at all also shows it is not demanded here.
		expect(() => buildSkipFrames(
			{ ...config, description },
			{ count: 1, picOrderCntLsb: 1 },
		)).toThrow(UnsupportedTilesError);
	});

	test('a sample with no IDR slice to repeat', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(publicFile('video.mp4')) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const config = await track.getDecoderConfig();
		assert(config);

		const sink = new EncodedPacketSink(track);
		const key = await sink.getFirstPacket();
		assert(key);
		const delta = await sink.getNextPacket(key);
		assert(delta);
		expect(delta.type).toBe('delta');

		expect(() => buildKeyFrameFill(delta.data, config, { count: 1 })).toThrow(MissingKeyFrameError);
	});

	test('frameNum is required for AVC and ignored for HEVC', async () => {
		const avc = { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) };
		expect(() => buildSkipFrames(avc, { count: 1 })).toThrow(/frameNum is required for AVC/);

		// The same call against HEVC gets past validation and is refused for the stream instead.
		const hevc = { codec: 'hvc1.1.6.L93.B0', codedWidth: 64, codedHeight: 64, description: new Uint8Array(32) };
		expect(() => buildSkipFrames(hevc, { count: 1 })).toThrow(MissingParameterSetsError);
	});

	test('each named refusal is a FrameFillError, and a bad option is not', () => {
		const config = { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: new Uint8Array(8) };

		for (const build of [
			() => buildSkipFrames({ ...config, codec: 'vp09.00.10.08' }, { count: 1, frameNum: 0 }),
			() => buildSkipFrames(config, { count: 1, frameNum: 0 }),
		]) {
			expect(build).toThrow(FrameFillError);
		}

		// A caller passing nonsense is a mistake to fix, not a case to branch on.
		expect(() => buildSkipFrames(config, { count: -1, frameNum: 0 })).toThrow(TypeError);
		expect(() => buildSkipFrames(config, { count: -1, frameNum: 0 })).not.toThrow(FrameFillError);
	});
});

/**
 * The fixture's own hvcC with its PPS replaced by one that enables tiles. H.265 7.3.2.3 field order,
 * every other field at a neutral value; written out rather than discovered by flipping bits, so the
 * input states what it is instead of being whatever happened to produce the refusal.
 */
const hvcCWithTiledPps = (original: Uint8Array) => {
	const { spsList } = parameterSetsFromHvcC(original);
	assert(spsList.length > 0);

	const w = new BitWriter();
	w.writeBits(8, 34 << 1); // nal_unit_type 34 (PPS_NUT)
	w.writeBits(8, 1); // nuh_temporal_id_plus1
	w.writeUe(0); // pps_pic_parameter_set_id
	w.writeUe(0); // pps_seq_parameter_set_id
	w.writeBits(1, 0); // dependent_slice_segments_enabled_flag
	w.writeBits(1, 0); // output_flag_present_flag
	w.writeBits(3, 0); // num_extra_slice_header_bits
	w.writeBits(1, 0); // sign_data_hiding_enabled_flag
	w.writeBits(1, 0); // cabac_init_present_flag
	w.writeUe(0); // num_ref_idx_l0_default_active_minus1
	w.writeUe(0); // num_ref_idx_l1_default_active_minus1
	w.writeSe(0); // init_qp_minus26
	w.writeBits(1, 0); // constrained_intra_pred_flag
	w.writeBits(1, 0); // transform_skip_enabled_flag
	w.writeBits(1, 0); // cu_qp_delta_enabled_flag
	w.writeSe(0); // pps_cb_qp_offset
	w.writeSe(0); // pps_cr_qp_offset
	w.writeBits(1, 0); // pps_slice_chroma_qp_offsets_present_flag
	w.writeBits(1, 0); // weighted_pred_flag
	w.writeBits(1, 0); // weighted_bipred_flag
	w.writeBits(1, 0); // transquant_bypass_enabled_flag
	w.writeBits(1, 1); // tiles_enabled_flag
	w.writeBits(1, 0); // entropy_coding_sync_enabled_flag
	w.writeUe(1); // num_tile_columns_minus1
	w.writeUe(0); // num_tile_rows_minus1
	w.writeBits(1, 1); // uniform_spacing_flag
	w.writeBits(1, 1); // loop_filter_across_tiles_enabled_flag
	w.writeBits(1, 1); // pps_loop_filter_across_slices_enabled_flag
	w.writeBits(1, 0); // deblocking_filter_control_present_flag
	w.writeBits(1, 0); // pps_scaling_list_data_present_flag
	w.writeBits(1, 0); // lists_modification_present_flag
	w.writeUe(0); // log2_parallel_merge_level_minus2
	w.writeBits(1, 0); // slice_segment_header_extension_present_flag
	w.writeBits(1, 0); // pps_extension_present_flag
	w.writeBits(1, 1); // rbsp_stop_one_bit
	w.byteAlign();
	const pps = w.finish();

	const sps = spsList[0]!;
	const header = original.subarray(0, 22);
	const out: number[] = [...header, 2]; // numOfArrays: one SPS array, one PPS array
	for (const [nalUnitType, unit] of [[33, sps], [34, pps]] as [number, Uint8Array][]) {
		out.push(0x80 | nalUnitType, 0, 1, (unit.length >> 8) & 0xff, unit.length & 0xff, ...unit);
	}

	return new Uint8Array(out);
};
