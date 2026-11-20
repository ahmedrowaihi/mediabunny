/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// YUV4MPEG2: a text header, then `FRAME\n` and a whole uncompressed picture, over and over. There is
// no index and no compression, so every position in the file is arithmetic - which is exactly why the
// colour space matters more here than anywhere else. It fixes the size of a frame, so reading it
// wrong does not fail: it reads the second frame from the middle of the first and every one after at
// the wrong offset, which looks like corrupt video rather than a defect.
//
// So the tests assert on the FRAME SIZE and on the pixels, both against ffmpeg, rather than on what
// either side says about itself. The frame header is not a fixed width either - a frame may carry
// parameters of its own - so the walk is tested against a file that has them.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS, Y4M } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Y4mOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { Y4M_COLOR_SPACES, y4mColorSpaceOf, y4mFrameSize } from '../../src/y4m/y4m-misc.js';

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-y4m-'));
	registerMediabunnyServer();
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** A Y4M ffmpeg wrote, in whatever pixel format is asked for. */
const ffmpegY4m = (name: string, pixelFormat: string, width = 64, height = 48, frames = 5) => {
	const file = path.join(workDir, `${name}.y4m`);
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-f', 'lavfi',
		'-i', `testsrc=size=${width}x${height}:rate=25:duration=${frames / 25}`,
		// ffmpeg calls the high-bit-depth tags unofficial and refuses them without this
		'-pix_fmt', pixelFormat, '-strict', '-1', '-f', 'yuv4mpegpipe', file,
	]);

	return file;
};

const readTrack = async (file: string) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	return track;
};

describe('a frame is exactly as many octets as its colour space says', () => {
	test('a duration read overlapping a timestamp read does not count a frame twice', async () => {
		// The frame walk reads `frameOffsets.length`, awaits a slice, then pushes. Two overlapping
		// readers both compute the same next offset across that await and both push it, so a 50-frame
		// file measures 51 and reports 2.04 s - and the duplicate is cached, so later sequential calls
		// get it too. 2.04 is 2 + one frame, which is the signature.
		const frames = 50;
		const header = new TextEncoder().encode('YUV4MPEG2 W16 H16 F25:1 Ip A1:1 C420\n');
		const frameHeader = new TextEncoder().encode('FRAME\n');
		const pictureSize = 16 * 16 + 2 * (8 * 8);
		const bytes = new Uint8Array(header.byteLength + frames * (frameHeader.byteLength + pictureSize));
		bytes.set(header, 0);
		let at = header.byteLength;
		for (let i = 0; i < frames; i++) {
			bytes.set(frameHeader, at);
			at += frameHeader.byteLength;
			bytes.fill(i, at, at + pictureSize);
			at += pictureSize;
		}

		// Both orders, repeatedly: a race that only sometimes loses would pass once.
		for (let run = 0; run < 8; run++) {
			{
				using input = new Input({ source: new BufferSource(bytes), formats: [Y4M] });
				const track = (await input.getPrimaryVideoTrack())!;
				expect(await Promise.all([track.getFirstTimestamp(), track.computeDuration()])).toEqual([0, 2]);
				// The walk is cached, so a sequential call afterwards must not read a poisoned value.
				expect(await track.computeDuration()).toBe(2);
			}
			{
				using input = new Input({ source: new BufferSource(bytes), formats: [Y4M] });
				const track = (await input.getPrimaryVideoTrack())!;
				expect(await Promise.all([track.computeDuration(), track.getFirstTimestamp()])).toEqual([2, 0]);
				expect(await track.computeDuration()).toBe(2);
			}
		}
	}, 120_000);

	test('4:2:0 at an odd size rounds the chroma planes UP', () => {
		// A 4:2:0 picture of odd width still has a chroma sample for the last column. Truncating puts
		// every frame after the first out of step, and the file still "reads".
		const space = y4mColorSpaceOf('420jpeg')!;
		expect(y4mFrameSize(space, 3, 3), '9 luma + 2 x 2x2 chroma').toBe(9 + 8);
		expect(y4mFrameSize(space, 4, 4)).toBe(16 + 8);
	});

	test('each subsampling and depth is the size it should be', () => {
		const cases: [string, number][] = [
			['420jpeg', 64 * 48 * 3 / 2],
			['422', 64 * 48 * 2],
			['444', 64 * 48 * 3],
			['411', 64 * 48 + 2 * 16 * 48],
			['mono', 64 * 48],
			['420p10', 64 * 48 * 3 / 2 * 2],
			['422p12', 64 * 48 * 2 * 2],
			['444p16', 64 * 48 * 3 * 2],
			['mono16', 64 * 48 * 2],
		];

		for (const [tag, expected] of cases) {
			expect(y4mFrameSize(y4mColorSpaceOf(tag)!, 64, 48), tag).toBe(expected);
		}
	});

	test('every colour space has a distinct tag', () => {
		const tags = Y4M_COLOR_SPACES.map(space => space.tag);
		expect(new Set(tags).size).toBe(tags.length);
	});
});

describe.skipIf(!hasFfmpeg)('files ffmpeg wrote', () => {
	// The frame size is stated OUTRIGHT, not computed with `y4mFrameSize`: asserting a reader against
	// the same arithmetic it uses passes whatever that arithmetic says. At 64x48 the luma plane is
	// 3072 samples and the chroma planes are that divided by the subsampling, twice, doubled beyond
	// 8 bits.
	const CASES: [string, string, number][] = [
		['yuv420p', '420jpeg', 3072 + 2 * 32 * 24],
		['yuv422p', '422', 3072 + 2 * 32 * 48],
		['yuv444p', '444', 3072 * 3],
		['yuv420p10le', '420p10', (3072 + 2 * 32 * 24) * 2],
		['yuv422p10le', '422p10', (3072 + 2 * 32 * 48) * 2],
		['yuv444p10le', '444p10', 3072 * 3 * 2],
		['gray', 'mono', 3072],
	];

	test.each(CASES)('%s is read as C%s, %i octets a frame', async (pixelFormat, tag, frameSize) => {
		const file = ffmpegY4m(`read-${pixelFormat}`, pixelFormat);
		const track = await readTrack(file);

		expect(await track.getCodec()).toBe('rawvideo');
		expect(await track.getCodedWidth()).toBe(64);
		expect(await track.getCodedHeight()).toBe(48);

		const config = await track.getDecoderConfig();
		assert(config?.description);
		expect(new TextDecoder().decode(new Uint8Array(config.description as ArrayBuffer))).toBe(tag);

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		assert(packet);
		expect(packet.byteLength).toBe(frameSize);

		// And the file is exactly its header plus five of those frames, each behind its own `FRAME\n`
		const fileSize = readFileSync(file).length;
		const headerLength = readFileSync(file).indexOf(0x0a) + 1;
		expect(fileSize - headerLength).toBe(5 * ('FRAME\n'.length + frameSize));
	}, 30_000);

	test('every frame is found, and no partial one is invented', async () => {
		const file = ffmpegY4m('count', 'yuv420p', 64, 48, 7);
		const track = await readTrack(file);

		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			expect(packet.byteLength).toBe(64 * 48 * 3 / 2);
			count++;
		}

		expect(count).toBe(7);
	}, 30_000);

	test('a truncated last frame is not a frame', async () => {
		// Half a picture read as a whole one is a torn frame rather than an error, so the walk stops
		// where a whole frame no longer fits
		const whole = readFileSync(ffmpegY4m('truncated-src', 'yuv420p', 64, 48, 3));
		const cut = path.join(workDir, 'truncated.y4m');
		writeFileSync(cut, whole.subarray(0, whole.length - 1000));

		const track = await readTrack(cut);
		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
			count++;
		}

		expect(count, 'the third frame is incomplete, so there are two').toBe(2);
	}, 30_000);

	test('a frame header carrying parameters of its own does not shift the walk', async () => {
		// `FRAME` may be followed by parameters, so the header is not a fixed width and the picture
		// offsets cannot be computed by multiplication
		const source = readFileSync(ffmpegY4m('params-src', 'yuv420p', 16, 16, 3));
		const frameSize = 16 * 16 * 3 / 2;

		const headerEnd = source.indexOf(0x0a) + 1;
		const out: number[] = [...source.subarray(0, headerEnd)];
		const pictures: Uint8Array[] = [];

		let at = headerEnd;
		for (let i = 0; i < 3; i++) {
			at = source.indexOf(0x0a, at) + 1;
			pictures.push(new Uint8Array(source.subarray(at, at + frameSize)));
			at += frameSize;
		}

		for (const [index, picture] of pictures.entries()) {
			out.push(...new TextEncoder().encode(`FRAME Xmediabunny=${index}\n`));
			out.push(...picture);
		}

		const file = path.join(workDir, 'params.y4m');
		writeFileSync(file, new Uint8Array(out));

		const track = await readTrack(file);
		const read: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			read.push(packet.data);
		}

		expect(read.length).toBe(3);
		for (const [index, picture] of pictures.entries()) {
			expect([...read[index]!], `frame ${index}`).toEqual([...picture]);
		}
	}, 30_000);

	test('the pixels are the pixels, decoded', async () => {
		// The planes have to be handed to the decoder at the right stride; a colour space read wrong
		// still decodes, into a sheared picture
		const file = ffmpegY4m('pixels', 'yuv420p', 64, 48, 2);
		const track = await readTrack(file);

		const sample = await new VideoSampleSink(track).getSample(0);
		assert(sample);
		expect(sample.codedWidth).toBe(64);
		expect(sample.codedHeight).toBe(48);

		const ours = new Uint8Array(sample.allocationSize({ format: 'I420' }));
		await sample.copyTo(ours, { format: 'I420' });
		sample.close();

		const raw = path.join(workDir, 'pixels.raw');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', raw,
		]);

		expect([...ours]).toEqual([...new Uint8Array(readFileSync(raw))]);
	}, 30_000);

	test('the frame rate the header states is the one the packets are timed at', async () => {
		const file = path.join(workDir, 'rate.y4m');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=30000/1001:duration=0.2',
			'-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', file,
		]);

		const track = await readTrack(file);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		assert(packet);
		expect(packet.duration).toBeCloseTo(1001 / 30000, 9);
	}, 30_000);

	test('the duration is the frames it actually holds, not zero', async () => {
		// `computeDuration` asks the backing for the packet at Infinity, and Y4M has no index to clamp
		// that against - so without a walk to the end it answered "no such packet" and the track
		// reported a duration of zero while reading every one of its frames perfectly. A consumer that
		// clips by duration refuses such a file.
		const file = ffmpegY4m('duration', 'yuv420p', 320, 180, 50);
		const track = await readTrack(file);

		expect(await track.computeDuration()).toBeCloseTo(2, 6);

		const probed = Number(execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
		], { encoding: 'utf8' }).trim());
		expect(await track.computeDuration()).toBeCloseTo(probed, 3);
	}, 60_000);

	test('a seek past the end gives the last frame rather than nothing', async () => {
		const file = ffmpegY4m('seek-past', 'yuv420p', 64, 48, 5);
		const track = await readTrack(file);

		const packet = await new EncodedPacketSink(track).getPacket(1000);
		assert(packet);
		expect(packet.sequenceNumber, 'the fifth and last frame').toBe(4);
	}, 30_000);

	test('a colour space this library does not know is refused by name', async () => {
		const file = path.join(workDir, 'bogus.y4m');
		writeFileSync(file, new TextEncoder().encode('YUV4MPEG2 W16 H16 F25:1 Ip A1:1 C9000\nFRAME\n'));

		const input = new Input({ formats: [Y4M], source: new FilePathSource(file) });
		await expect(input.getTracks()).rejects.toThrow(/Unsupported Y4M colour space/);
	});
});

describe.skipIf(!hasFfmpeg)('files this library writes', () => {
	test('ffmpeg reads back every frame, pixel for pixel', async () => {
		// Copied straight through, so any difference afterwards is this writer's header or framing
		const source = ffmpegY4m('write-src', 'yuv420p', 64, 48, 5);
		const track = await readTrack(source);
		const config = await track.getDecoderConfig();
		assert(config);

		const output = new Output({ format: new Y4mOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('rawvideo');
		output.addVideoTrack(videoSource, { frameRate: 25 });
		await output.start();

		for await (const packet of new EncodedPacketSink(track).packets()) {
			await videoSource.add(packet, { decoderConfig: config });
		}

		await output.finalize();

		const written = path.join(workDir, 'written.y4m');
		writeFileSync(written, new Uint8Array(output.target.buffer!));

		const ourRaw = path.join(workDir, 'written.raw');
		const theirRaw = path.join(workDir, 'source.raw');
		for (const [input, out] of [[written, ourRaw], [source, theirRaw]] as const) {
			execFileSync('ffmpeg', [
				'-v', 'error', '-y', '-i', input, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', out,
			]);
		}

		expect([...new Uint8Array(readFileSync(ourRaw))])
			.toEqual([...new Uint8Array(readFileSync(theirRaw))]);
	}, 60_000);

	test('ffprobe agrees on the size, rate and pixel format', async () => {
		const source = ffmpegY4m('probe-src', 'yuv422p', 64, 48, 3);
		const track = await readTrack(source);
		const config = await track.getDecoderConfig();
		assert(config);

		const output = new Output({ format: new Y4mOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('rawvideo');
		output.addVideoTrack(videoSource, { frameRate: 25 });
		await output.start();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await videoSource.add(packet, { decoderConfig: config });
		}
		await output.finalize();

		const written = path.join(workDir, 'probed.y4m');
		writeFileSync(written, new Uint8Array(output.target.buffer!));

		const probed = execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'stream=width,height,pix_fmt,r_frame_rate',
			'-of', 'default=nw=1', written,
		], { encoding: 'utf8' });

		expect(probed).toMatch(/width=64/);
		expect(probed).toMatch(/height=48/);
		expect(probed).toMatch(/pix_fmt=yuv422p/);
		expect(probed).toMatch(/r_frame_rate=25\/1/);
	}, 60_000);

	test('a frame of the wrong size is refused rather than shifting the file', async () => {
		const source = ffmpegY4m('bad-size-src', 'yuv420p', 64, 48, 2);
		const track = await readTrack(source);
		const config = await track.getDecoderConfig();
		assert(config);

		const output = new Output({ format: new Y4mOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('rawvideo');
		output.addVideoTrack(videoSource, { frameRate: 25 });
		await output.start();

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		assert(packet);
		const short = packet.clone({ data: packet.data.subarray(0, packet.data.length - 10) });

		await expect(videoSource.add(short, { decoderConfig: config }))
			.rejects.toThrow(/would silently shift every frame after it/);
	}, 60_000);

	test('a whole conversion to Y4M, decoded and re-encoded', async () => {
		// The full path: an AVC file in, raw frames out, which is what Y4M is here for
		const avc = path.join(workDir, 'conv-src.mp4');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=25:duration=0.2',
			'-c:v', 'libx264', '-pix_fmt', 'yuv420p', avc,
		]);

		const file = path.join(workDir, 'converted.y4m');
		const output = new Output({ format: new Y4mOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input: new Input({ formats: ALL_FORMATS, source: new FilePathSource(avc) }),
			output,
			video: { codec: 'rawvideo' },
		});
		await conversion.execute();
		writeFileSync(file, new Uint8Array(output.target.buffer!));

		const probed = execFileSync('ffprobe', [
			'-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,pix_fmt,nb_read_frames',
			'-of', 'default=nw=1', file,
		], { encoding: 'utf8' });

		expect(probed).toMatch(/width=64/);
		expect(probed).toMatch(/height=48/);
		expect(probed).toMatch(/pix_fmt=yuv420p/);
		expect(probed).toMatch(/nb_read_frames=5/);
	}, 120_000);

	test('and this library reads its own file back', async () => {
		const source = ffmpegY4m('self-src', 'yuv444p', 32, 32, 3);
		const track = await readTrack(source);
		const config = await track.getDecoderConfig();
		assert(config);

		const output = new Output({ format: new Y4mOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('rawvideo');
		output.addVideoTrack(videoSource, { frameRate: 25 });
		await output.start();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await videoSource.add(packet, { decoderConfig: config });
		}
		await output.finalize();

		const input = new Input({
			formats: ALL_FORMATS,
			source: new BufferSource(new Uint8Array(output.target.buffer!)),
		});
		const readBack = await input.getPrimaryVideoTrack();
		assert(readBack);

		expect(await readBack.getCodec()).toBe('rawvideo');
		expect(await readBack.getCodedWidth()).toBe(32);
		expect(await readBack.getCodedHeight()).toBe(32);

		const readConfig = await readBack.getDecoderConfig();
		assert(readConfig?.description);
		expect(new TextDecoder().decode(new Uint8Array(readConfig.description as ArrayBuffer))).toBe('444');
	}, 60_000);
});
