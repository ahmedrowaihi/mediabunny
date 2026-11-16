/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MPEG audio Layer II. No container states the layer - MPEG-TS stream types 0x03 and 0x04 name the MPEG
// version, and an MP4 esds object type indication of 0x6B or 0x69 says the same - so what separates MP2
// from MP3 is the `layer` field of the frame header. QuickTime is the exception: its `.mp2` sample entry
// names Layer II outright and carries no esds, which is what ffmpeg writes for `-f mov -c:a mp2`.
//
// Every claim about the written bytes is checked with ffprobe rather than by reading our own boxes back,
// and every file is decoded with ffmpeg so "it plays" is measured and not assumed.

import { execFileSync } from 'node:child_process';
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
import { assert } from '../../src/misc.js';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import { registerMediabunnyServer } from '@mediabunny/server';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

const hasFfmpeg = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** Re-encodes the source's audio to MP2 in the given container. */
const encodeMp2 = async (format: OutputFormat) => {
	using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: { discard: true },
		audio: { codec: 'mp2', bitrate: 256_000, sampleRate: 48_000, numberOfChannels: 2 },
	});

	expect(conversion.discardedTracks.filter(discarded => discarded.reason !== 'discarded_by_user')).toEqual([]);
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

// First row only: a transport stream can list the same programme more than once, so ffprobe prints a row
// per listing even for `a:0`
const probe = (file: string, fields: string) => execFileSync('ffprobe', [
	'-v', 'error', '-select_streams', 'a:0', '-show_entries', `stream=${fields}`, '-of', 'csv=p=0', file,
], { encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(Boolean)[0]!;

/**
 * The object type indication out of an `esds` payload: version and flags, then ES_Descr (tag 0x03) with
 * its ES_ID and flags, then DecoderConfigDescriptor (tag 0x04) whose first byte is what we want. Each
 * descriptor length is a variable-length integer, so it is stepped over rather than assumed to be a byte.
 */
const objectTypeIndicationOf = (esdsPayload: Uint8Array) => {
	const skipLength = (at: number) => {
		let pos = at;
		while (esdsPayload[pos]! & 0x80) {
			pos++;
		}
		return pos + 1;
	};

	let at = 4; // version and flags
	expect(esdsPayload[at]).toBe(0x03);
	at = skipLength(at + 1) + 3; // ES_ID (2) and the flags byte
	expect(esdsPayload[at]).toBe(0x04);
	return esdsPayload[skipLength(at + 1)];
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

test('mp2 is encodable and every container that should take it does', async () => {
	expect(await canEncode('mp2')).toBe(true);

	expect(new MpegTsOutputFormat().getSupportedAudioCodecs()).toContain('mp2');
	// The whole ordered list, which `test/browser/mpeg-ts-muxing.test.ts` asserts too. Stated here as
	// well so the literal over there can be checked without starting a browser.
	expect(new MpegTsOutputFormat().getSupportedCodecs())
		.toEqual(['avc', 'hevc', 'mpeg2', 'aac', 'mp3', 'mp2', 'ac3', 'eac3', 'dts']);
	expect(new Mp4OutputFormat().getSupportedAudioCodecs()).toContain('mp2');
	expect(new MovOutputFormat().getSupportedAudioCodecs()).toContain('mp2');
	expect(new MkvOutputFormat().getSupportedAudioCodecs()).toContain('mp2');
});

describe.skipIf(!hasFfmpeg)('what gets written, read by ffprobe', () => {
	// `codec_name` is what ffprobe reports; for MOV, MKV and TS it reads the layer and says mp2. MP4 is
	// the stated exception: the object type indication is all it has there, and 0x6B means mp3 to it.
	const cases = [
		{ name: 'mov', format: () => new MovOutputFormat(), codecName: 'mp2', entry: '.mp2' },
		{ name: 'mkv', format: () => new MkvOutputFormat(), codecName: 'mp2', entry: null },
		{ name: 'ts', format: () => new MpegTsOutputFormat(), codecName: 'mp2', entry: null },
		{ name: 'mp4', format: () => new Mp4OutputFormat(), codecName: 'mp3', entry: 'mp4a' },
	] as const;

	for (const { name, format, codecName, entry } of cases) {
		test(`${name}: ffprobe reads codec_name=${codecName}, and ffmpeg decodes it`, async () => {
			const bytes = await encodeMp2(format());

			withTempFile(`mp2.${name}`, bytes, (file) => {
				const [probedName, sampleRate, channels] = probe(file, 'codec_name,sample_rate,channels').split(',');
				expect(probedName).toBe(codecName);
				expect(sampleRate).toBe('48000');
				expect(channels).toBe('2');

				// It plays: a decode of every packet, with ffmpeg's own decoder
				execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], {
					encoding: 'utf8',
				});
			});

			if (entry !== null) {
				const stsd = findBox(parseBoxes(bytes, 0, bytes.length), 'stsd');
				expect(stsd!.children![0]!.type).toBe(entry);
			}
		}, 300_000);
	}

	test('MOV carries no esds, and MP4 carries one stating object type 0x6B', async () => {
		const mov = await encodeMp2(new MovOutputFormat());
		const mp4 = await encodeMp2(new Mp4OutputFormat());

		// QuickTime's `.mp2` entry is self-describing, which is exactly why ffprobe can say mp2 for it
		expect(findBox(parseBoxes(mov, 0, mov.length), 'esds')).toBeNull();

		const esds = findBox(parseBoxes(mp4, 0, mp4.length), 'esds');
		expect(esds?.data).toBeDefined();
		expect(objectTypeIndicationOf(esds!.data!)).toBe(0x6b);
	}, 300_000);
});

describe('reading it back', () => {
	const read = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		return {
			codec: await track.getCodec(),
			sampleRate: await track.getSampleRate(),
			channels: await track.getNumberOfChannels(),
		};
	};

	test('MOV, MKV and TS report mp2; MP4 reports mp3, as ffprobe does', async () => {
		expect(await read(await encodeMp2(new MovOutputFormat()))).toEqual({
			codec: 'mp2', sampleRate: 48_000, channels: 2,
		});
		expect(await read(await encodeMp2(new MkvOutputFormat()))).toMatchObject({ codec: 'mp2' });
		expect(await read(await encodeMp2(new MpegTsOutputFormat()))).toMatchObject({ codec: 'mp2' });
		// Stated limitation: an MP4 states only the object type, which names the MPEG version
		expect(await read(await encodeMp2(new Mp4OutputFormat()))).toMatchObject({ codec: 'mp3' });
	}, 300_000);

	test('Layer III still reports mp3, so the layer is what decides', async () => {
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { discard: true },
			audio: { codec: 'mp3', bitrate: 256_000, sampleRate: 48_000, numberOfChannels: 2 },
		});
		await conversion.execute();

		// The same stream type 0x03 as the MP2 case above, so only the frame header separates them
		expect(await read(new Uint8Array(output.target.buffer!))).toMatchObject({ codec: 'mp3' });
	}, 300_000);
});
