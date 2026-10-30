/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MPEG-2 video. It carries no out-of-band configuration: the sequence header and its extension ride in
// the stream ahead of every closed GOP, which is why nothing here keeps a description and why the
// dimensions and profile are read off the packets. The chroma format is the profile - 4:2:0 Main against
// 4:2:2 Profile - and the object type indication in the codec string is how it is asked for, the way a
// ProRes four-character code is.
//
// What was written is read with ffprobe and decoded with ffmpeg, never from our own boxes alone.

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import {
	MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, MpegTsOutputFormat, OutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { canEncode } from '../../src/encode.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { registerMediabunnyServer } from '@mediabunny/server';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

// 5 seconds of 640x360 at 25 fps
const FRAME_RATE = 25;
const FRAMES = 125;
const KEY_FRAME_INTERVAL = 1;

const hasFfmpeg = (() => {
	try {
		spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
	} catch {
		return false;
	}
})();

/** Re-encodes the source's video to MPEG-2 in the given container. */
const encodeMpeg2 = async (format: OutputFormat) => {
	using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		audio: { discard: true },
		video: { codec: 'mpeg2', bitrate: 4_000_000, keyFrameInterval: KEY_FRAME_INTERVAL },
	});

	expect(conversion.discardedTracks.filter(discarded => discarded.reason !== 'discarded_by_user')).toEqual([]);
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

/** Encodes synthetic frames, which is the only path that takes a `fullCodecString` and so a profile. */
const encodeWithCodecString = async (
	fullCodecString: string,
	width: number,
	height: number,
	format: OutputFormat = new MpegTsOutputFormat(),
) => {
	const output = new Output({ format, target: new BufferTarget() });
	const source = new VideoSampleSource({
		codec: 'mpeg2',
		fullCodecString,
		bitrate: 8_000_000,
		hardwareAcceleration: 'prefer-software',
	});
	output.addVideoTrack(source, { frameRate: FRAME_RATE });
	await output.start();

	for (let i = 0; i < FRAME_RATE; i++) {
		// Chroma detail a 4:2:0 subsample would lose, so the two profiles cannot come out identical
		const data = new Uint8Array(width * height * 4);
		for (let pixel = 0; pixel < width * height; pixel++) {
			const at = pixel * 4;
			data[at] = (pixel % 2) * 255;
			data[at + 1] = ((pixel + i) % 3) * 127;
			data[at + 2] = (pixel * 5) % 256;
			data[at + 3] = 255;
		}

		using sample = new VideoSample(data, {
			format: 'RGBX',
			codedWidth: width,
			codedHeight: height,
			timestamp: i / FRAME_RATE,
			duration: 1 / FRAME_RATE,
		});
		await source.add(sample);
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

/** Keyed, because ffprobe prints the fields in the stream's own order and not the order they are asked in. */
const probe = (file: string, fields: string) => {
	const result = spawnSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=${fields}`,
		'-of', 'default=noprint_wrappers=1', file,
	], { encoding: 'utf8' });
	expect(result.stderr ?? '').toBe('');

	const entries = new Map<string, string>();
	for (const line of (result.stdout ?? '').split('\n')) {
		const at = line.indexOf('=');
		// First listing only: a transport stream can list the same programme more than once
		if (at !== -1 && !entries.has(line.slice(0, at))) {
			entries.set(line.slice(0, at), line.slice(at + 1).trim());
		}
	}

	return entries;
};

/** Decodes every packet with ffmpeg's own decoder, which is the only thing that calls the bytes legal. */
const decode = (file: string) => {
	const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], {
		encoding: 'utf8',
	});
	expect((result.stderr ?? '').trim()).toBe('');
	expect(result.status).toBe(0);
};

const withTempFile = <T>(name: string, bytes: Uint8Array, body: (file: string) => T): T => {
	const file = path.join(tmpdir(), `mediabunny-${name}`);
	writeFileSync(file, bytes);
	try {
		return body(file);
	} finally {
		rmSync(file, { force: true });
	}
};

/**
 * Every start code in an MPEG-2 elementary stream, by code. 13818-2 table 6-1: a three-byte prefix and
 * the code byte, with any number of leading zero bytes allowed before the prefix.
 */
const startCodesOf = (bytes: Uint8Array) => {
	const codes: { code: number; offset: number }[] = [];

	for (let i = 0; i + 3 < bytes.byteLength; i++) {
		if (bytes[i] === 0x00 && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x01) {
			codes.push({ code: bytes[i + 3]!, offset: i });
			i += 2;
		}
	}

	return codes;
};

test('mpeg2 is encodable and MPEG-TS takes it', async () => {
	expect(await canEncode('mpeg2')).toBe(true);

	// The whole ordered list, which `test/browser/mpeg-ts-muxing.test.ts` asserts too
	expect(new MpegTsOutputFormat().getSupportedCodecs())
		.toEqual(['avc', 'hevc', 'mpeg2', 'aac', 'mp3', 'mp2', 'ac3', 'eac3', 'dts']);
	expect(new MpegTsOutputFormat().getSupportedVideoCodecs()).toContain('mpeg2');
	expect(new Mp4OutputFormat().getSupportedVideoCodecs()).toContain('mpeg2');
	expect(new MovOutputFormat().getSupportedVideoCodecs()).toContain('mpeg2');
});

describe.skipIf(!hasFfmpeg)('what gets written, read by ffprobe', () => {
	const cases = [
		{ name: 'ts', format: () => new MpegTsOutputFormat() },
		{ name: 'mp4', format: () => new Mp4OutputFormat() },
		{ name: 'mov', format: () => new MovOutputFormat() },
	] as const;

	for (const { name, format } of cases) {
		test(`${name}: ffprobe reads codec_name=mpeg2video, and ffmpeg decodes it`, async () => {
			const bytes = await encodeMpeg2(format());

			withTempFile(`mpeg2.${name}`, bytes, (file) => {
				const entries = probe(file, 'codec_name,profile,pix_fmt,width,height');

				expect(entries.get('codec_name')).toBe('mpeg2video');
				// No chroma format was asked for, so the default 4:2:0 Main Profile is what it must be
				expect(entries.get('profile')).toBe('Main');
				expect(entries.get('pix_fmt')).toBe('yuv420p');
				expect(entries.get('width')).toBe('640');
				expect(entries.get('height')).toBe('360');

				decode(file);
			});

			// Read back with our own demuxer: an MPEG-2 file we write that we cannot read is half a format
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const track = (await input.getVideoTracks())[0]!;
			expect(await track.getCodec()).toBe('mpeg2');
			expect(await track.getDisplayWidth()).toBe(640);
			expect(await track.getDisplayHeight()).toBe(360);

			const sink = new EncodedPacketSink(track);
			let packetCount = 0;
			for await (const packet of sink.packets()) {
				packetCount++;
				expect(await track.determinePacketType(packet)).toBe(packet.type);
			}
			expect(packetCount).toBe(FRAMES);
		});
	}

	test('4:2:2 Profile is what the 0x65 object type asks for, and 4:2:0 Main what 0x61 does', async () => {
		const main = await encodeWithCodecString('mp4v.61', 640, 360);
		const chroma422 = await encodeWithCodecString('mp4v.65', 640, 360);

		// The knob has to move the bytes, or the two profiles are one measurement
		expect(Buffer.from(chroma422).equals(Buffer.from(main))).toBe(false);

		withTempFile('mpeg2-main.ts', main, (file) => {
			const entries = probe(file, 'profile,pix_fmt');
			expect(entries.get('profile')).toBe('Main');
			expect(entries.get('pix_fmt')).toBe('yuv420p');
			decode(file);
		});

		withTempFile('mpeg2-422.ts', chroma422, (file) => {
			const entries = probe(file, 'profile,pix_fmt');
			expect(entries.get('profile')).toBe('4:2:2');
			expect(entries.get('pix_fmt')).toBe('yuv422p');
			decode(file);
		});
	});

	// The level is a bound the encoder derives from the raster and the rate, not something the profile
	// fixes: measured against the ffmpeg CLI, 4:2:2 Profile comes out at level code 5 (Main) for
	// 640x360p25 and 2 (High) for 1920x1080p50. So nothing here pins it to a constant.
	test('the level follows the raster and the rate, it is not fixed by the profile', async () => {
		const small = await encodeWithCodecString('mp4v.65', 640, 360);
		const large = await encodeWithCodecString('mp4v.65', 1920, 1088);

		const levelOf = (name: string, bytes: Uint8Array) =>
			withTempFile(name, bytes, file => probe(file, 'level').get('level')!);

		expect(Number(levelOf('mpeg2-422-small.ts', small)))
			.toBeGreaterThan(Number(levelOf('mpeg2-422-large.ts', large)));
	});
});

describe('the profile a stream states, read back', () => {
	const containers = [
		{ name: 'ts', format: () => new MpegTsOutputFormat() },
		{ name: 'mp4', format: () => new Mp4OutputFormat() },
		{ name: 'mov', format: () => new MovOutputFormat() },
		{ name: 'mkv', format: () => new MkvOutputFormat() },
	] as const;

	// The object type indication names the profile, and only the sequence extension states it: `m2v1`
	// and `V_MPEG2` carry no box for it, and an `esds` only repeats what the writer claimed.
	for (const { name, format } of containers) {
		for (const codecString of ['mp4v.61', 'mp4v.65']) {
			test(`${name}: ${codecString} reads back as ${codecString}`, async () => {
				const bytes = await encodeWithCodecString(codecString, 640, 360, format());

				using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
				const track = (await input.getVideoTracks())[0]!;

				expect(await track.getCodec()).toBe('mpeg2');
				expect(await track.getCodecParameterString()).toBe(codecString);
			});
		}
	}
});

describe('the elementary stream, read back', () => {
	test('each forced key frame opens a closed GOP with its own sequence header', async () => {
		const bytes = await encodeMpeg2(new MpegTsOutputFormat());

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getCodec()).toBe('mpeg2');
		expect(await track.getDisplayWidth()).toBe(640);
		expect(await track.getDisplayHeight()).toBe(360);

		const sink = new EncodedPacketSink(track);
		const packets = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}

		// The access unit splitting has to find every picture, not merely most of them
		expect(packets.length).toBe(FRAMES);

		// Against the first packet, not against zero: MPEG-2 states a one-frame reorder delay whether or
		// not it uses it, so the first decode time is negative and the muxer shifts the whole programme
		// to keep it from going below zero
		const start = packets[0]!.timestamp;
		expect(packets[0]!.type).toBe('key');

		const keyFrameTimestamps = packets
			.filter(packet => packet.type === 'key')
			.map(packet => Math.round((packet.timestamp - start) * FRAME_RATE) / FRAME_RATE);
		expect(keyFrameTimestamps).toEqual([0, 1, 2, 3, 4]);

		for (const packet of packets) {
			// The transport stream states the random access points in its adaptation fields, so this is a
			// second, independent reading: the picture header's own `picture_coding_type`
			expect(await track.determinePacketType(packet)).toBe(packet.type);

			const codes = startCodesOf(packet.data);
			const pictures = codes.filter(({ code }) => code === 0x00);
			const gopHeaders = codes.filter(({ code }) => code === 0xb8);
			const sequenceHeaders = codes.filter(({ code }) => code === 0xb3);

			expect(pictures.length).toBe(1);

			if (packet.type === 'key') {
				// A decoder joining here has nothing out of band to configure it from
				expect(sequenceHeaders.length).toBe(1);
				expect(gopHeaders.length).toBe(1);

				// 13818-2 6.2.2.6: 25 bits of time code, then `closed_gop`
				const gopPayload = packet.data.subarray(gopHeaders[0]!.offset + 4);
				expect((gopPayload[3]! >> 6) & 1).toBe(1);
			} else {
				expect(gopHeaders.length).toBe(0);
			}
		}
	});

	test('the same bytes come out of every run', async () => {
		const first = await encodeMpeg2(new MpegTsOutputFormat());
		const second = await encodeMpeg2(new MpegTsOutputFormat());

		expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
	});
});
