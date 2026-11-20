/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// AIFF, which is IFF: RIFF's big-endian elder. Most of it is WAVE with the bytes the other way round,
// and the two places where it is not are both silent failures.
//
//   - **8-bit samples are SIGNED**, where WAVE's are unsigned. Read as the other, every sample is off
//     by half full scale, which is a square wave of noise rather than an error.
//   - **The sample rate is an 80-bit IEEE 754 extended float**, whose mantissa carries an EXPLICIT
//     integer bit. Treating it like the 32- and 64-bit formats and or-ing in a leading 1 yields a rate
//     exactly half or twice what was meant - a file that plays, at the wrong speed.
//
// Neither is reachable by round-tripping through our own reader, so the oracle throughout is ffmpeg:
// it writes the files we read, and reads the files we write, and the PCM is compared sample for sample
// rather than by anything either side merely states.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_FORMATS, AIFF } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { AiffOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { FileSlice } from '../../src/reader.js';
import type { Writer } from '../../src/writer.js';
import type { PcmAudioCodec } from '../../src/codec.js';
import { readExtendedFloat80, writeExtendedFloat80 } from '../../src/aiff/aiff-misc.js';

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
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-aiff-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** A tone ffmpeg writes, in whatever AIFF flavour its codec name picks. */
const ffmpegAiff = (name: string, ffmpegCodec: string, sampleRate = 44100, channels = 2) => {
	const file = path.join(workDir, `${name}.aiff`);
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=0.25`,
		'-ac', String(channels), '-c:a', ffmpegCodec, file,
	]);

	return file;
};

/** Every sample of a file, as signed 16-bit, through ffmpeg - so neither side reads the other's. */
const pcmOf = (file: string) => {
	const raw = path.join(workDir, `${path.basename(file)}.raw`);
	execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', 's16le', '-c:a', 'pcm_s16le', raw]);
	return new Int16Array(new Uint8Array(readFileSync(raw)).buffer);
};

const readTrack = async (file: string) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	return { input, track };
};

/** Collects what `writeExtendedFloat80` emits, which is all of a `Writer` it uses. */
const extendedBytesOf = (value: number) => {
	const written: number[] = [];
	writeExtendedFloat80(
		{ write: (data: Uint8Array) => written.push(...data) } as unknown as Writer,
		value,
	);

	return new Uint8Array(written);
};

const hex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

describe('the 80-bit extended float the sample rate is stated as', () => {
	// Asserted against the OCTETS, not against our own reader: a reader and a writer that share a
	// mistake round-trip perfectly. The exponent is excess-16383 and the mantissa's top bit is an
	// EXPLICIT integer bit, set for every normal value - 44100 is 1.345...x2^15, so the exponent field
	// is 16383 + 15 = 0x400e and the mantissa is 0xac44 followed by zeroes.
	const CASES: [number, string][] = [
		[44100, '400eac44000000000000'],
		[48000, '400ebb80000000000000'],
		[8000, '400bfa00000000000000'],
		[96000, '400fbb80000000000000'],
		[22050, '400dac44000000000000'],
		[1, '3fff8000000000000000'],
	];

	test.each(CASES)('%i is written as %s', (rate, expected) => {
		expect(hex(extendedBytesOf(rate))).toBe(expected);
	});

	test.each(CASES)('and %i reads back out of those octets', (rate, expected) => {
		const bytes = Uint8Array.from(expected.match(/../g)!.map(x => parseInt(x, 16)));
		expect(readExtendedFloat80(FileSlice.tempFromBytes(bytes))).toBe(rate);
	});

	test('an implied integer bit would be out by a factor of two, so check the top bit is set', () => {
		// This is the whole trap: 32- and 64-bit floats imply the leading 1, and 80-bit ones state it
		expect(extendedBytesOf(44100)[2]! & 0x80, 'bit 63 of the mantissa').toBe(0x80);
	});

	test('zero is zero rather than a denormal', () => {
		expect(readExtendedFloat80(FileSlice.tempFromBytes(new Uint8Array(10)))).toBe(0);
	});

	test('an infinity or a NaN is not a sample rate', () => {
		const bytes = Uint8Array.from([0x7f, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]);
		expect(readExtendedFloat80(FileSlice.tempFromBytes(bytes))).toBe(0);
	});
});

describe.skipIf(!hasFfmpeg)('files ffmpeg wrote', () => {
	const CASES: [string, string, PcmAudioCodec][] = [
		['plain 16-bit AIFF is big-endian signed', 'pcm_s16be', 'pcm-s16be'],
		['24-bit', 'pcm_s24be', 'pcm-s24be'],
		['32-bit', 'pcm_s32be', 'pcm-s32be'],
		['AIFF-C sowt is the little-endian one', 'pcm_s16le', 'pcm-s16'],
		['AIFF-C fl32', 'pcm_f32be', 'pcm-f32be'],
		['AIFF-C fl64', 'pcm_f64be', 'pcm-f64be'],
		['AIFF-C ulaw', 'pcm_mulaw', 'ulaw'],
		['AIFF-C alaw', 'pcm_alaw', 'alaw'],
	];

	test.each(CASES)('%s reads as %s', async (name, ffmpegCodec, expected) => {
		const file = ffmpegAiff(name.replace(/\W+/g, '-'), ffmpegCodec);
		const { track } = await readTrack(file);

		expect(await track.getCodec()).toBe(expected);
		expect(await track.getSampleRate()).toBe(44100);
		expect(await track.getNumberOfChannels()).toBe(2);
	}, 30_000);

	test('an 8-bit AIFF is SIGNED, which is where it differs from WAVE', async () => {
		const file = ffmpegAiff('eight-bit', 'pcm_s8');
		const { track } = await readTrack(file);
		expect(await track.getCodec()).toBe('pcm-s8');
	}, 30_000);

	test('the sample rate comes back exactly, not half or twice it', async () => {
		// The integer bit of an extended float's mantissa is explicit; treating it as implied doubles
		// or halves every rate, which is a file that plays at the wrong speed rather than one that fails
		for (const rate of [8000, 22050, 44100, 48000, 96000]) {
			const file = ffmpegAiff(`rate-${rate}`, 'pcm_s16be', rate, 1);
			const { track } = await readTrack(file);
			expect(await track.getSampleRate(), `${rate} Hz`).toBe(rate);
		}
	}, 60_000);

	test('the samples are the samples, not an offset copy of them', async () => {
		// A codec read as the wrong signedness or endianness still decodes, so the bytes have to be
		// compared. ffmpeg converts both sides to s16le, and this library's packets are concatenated
		// and handed back to ffmpeg as raw samples of the codec it says they are.
		const file = ffmpegAiff('samples', 'pcm_s16be', 44100, 1);
		const { track } = await readTrack(file);

		const chunks: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			chunks.push(packet.data);
		}

		const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let at = 0;
		for (const chunk of chunks) {
			joined.set(chunk, at);
			at += chunk.length;
		}

		const ours = path.join(workDir, 'ours.raw');
		writeFileSync(ours, joined);

		const converted = path.join(workDir, 'ours-s16le.raw');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 's16be', '-ar', '44100', '-ac', '1', '-i', ours,
			'-f', 's16le', '-c:a', 'pcm_s16le', converted,
		]);

		const theirs = pcmOf(file);
		const mine = new Int16Array(new Uint8Array(readFileSync(converted)).buffer);

		expect(mine.length).toBe(theirs.length);
		expect([...mine.subarray(0, 2000)]).toEqual([...theirs.subarray(0, 2000)]);
	}, 60_000);

	test('the duration is the one ffprobe reports', async () => {
		const file = ffmpegAiff('duration', 'pcm_s16be', 48000, 2);
		const { track } = await readTrack(file);

		const probed = Number(execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
		], { encoding: 'utf8' }).trim());

		expect(await track.computeDuration()).toBeCloseTo(probed, 3);
	}, 30_000);
});

describe.skipIf(!hasFfmpeg)('files this library writes', () => {
	const write = async (codec: PcmAudioCodec, source: string, name: string) => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(source) });
		const inputTrack = await input.getPrimaryAudioTrack();
		assert(inputTrack);
		const decoderConfig = await inputTrack.getDecoderConfig();
		assert(decoderConfig);

		const output = new Output({ format: new AiffOutputFormat(), target: new BufferTarget() });
		const audioSource = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(audioSource, { decoderConfig: { ...decoderConfig, codec } });
		await output.start();

		for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
			await audioSource.add(packet);
		}

		await output.finalize();

		const file = path.join(workDir, `${name}.aiff`);
		writeFileSync(file, new Uint8Array(output.target.buffer!));
		return file;
	};

	test('ffmpeg reads back what we wrote, sample for sample', async () => {
		// The source is already big-endian 16-bit, so its packets go in unchanged and any difference in
		// the samples afterwards is this writer's header
		const source = ffmpegAiff('roundtrip-src', 'pcm_s16be', 44100, 2);
		const written = await write('pcm-s16be', source, 'roundtrip');

		expect([...pcmOf(written)]).toEqual([...pcmOf(source)]);
	}, 60_000);

	test('ffprobe agrees on the codec, rate and channels', async () => {
		const source = ffmpegAiff('probe-src', 'pcm_s16be', 48000, 1);
		const written = await write('pcm-s16be', source, 'probe');

		const probed = execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels',
			'-of', 'default=nw=1', written,
		], { encoding: 'utf8' });

		expect(probed).toMatch(/codec_name=pcm_s16be/);
		expect(probed).toMatch(/sample_rate=48000/);
		expect(probed).toMatch(/channels=1/);
	}, 60_000);

	test('a little-endian codec is written as AIFF-C, which is what sowt means', async () => {
		const source = ffmpegAiff('aifc-src', 'pcm_s16le', 44100, 2);
		const written = await write('pcm-s16', source, 'aifc');

		const bytes = new Uint8Array(readFileSync(written));
		expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('AIFC');
		expect(new TextDecoder().decode(bytes.subarray(0, 200))).toContain('sowt');

		expect(execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', written,
		], { encoding: 'utf8' })).toMatch(/pcm_s16le/);
		expect([...pcmOf(written)]).toEqual([...pcmOf(source)]);
	}, 60_000);

	test('and this library reads its own file back', async () => {
		const source = ffmpegAiff('self-src', 'pcm_s24be', 48000, 2);
		const written = await write('pcm-s24be', source, 'self');

		const { track } = await readTrack(written);
		expect(await track.getCodec()).toBe('pcm-s24be');
		expect(await track.getSampleRate()).toBe(48000);
		expect(await track.getNumberOfChannels()).toBe(2);
	}, 60_000);
});

describe('format detection', () => {
	test('a FORM/AIFF header is matched and a FORM of anything else is not', async () => {
		const aiff = new Uint8Array(12);
		aiff.set([...'FORM'].map(c => c.charCodeAt(0)), 0);
		aiff.set([...'AIFF'].map(c => c.charCodeAt(0)), 8);

		const other = new Uint8Array(aiff);
		other.set([...'8SVX'].map(c => c.charCodeAt(0)), 8);

		const matched = async (bytes: Uint8Array) => {
			const input = new Input({ formats: [AIFF], source: new BufferSource(bytes) });
			try {
				await input.getFormat();
				return true;
			} catch {
				return false;
			}
		};

		expect(await matched(aiff), 'FORM/AIFF').toBe(true);
		expect(await matched(other), 'FORM/8SVX, which is a different IFF file').toBe(false);
	});

	test('a file with no COMM chunk is refused by name', async () => {
		const bytes = new Uint8Array(20);
		bytes.set([...'FORM'].map(c => c.charCodeAt(0)), 0);
		new DataView(bytes.buffer).setUint32(4, 12, false);
		bytes.set([...'AIFF'].map(c => c.charCodeAt(0)), 8);
		bytes.set([...'ANNO'].map(c => c.charCodeAt(0)), 12);

		const input = new Input({ formats: [AIFF], source: new BufferSource(bytes) });
		await expect(input.getTracks()).rejects.toThrow(/missing "COMM"/);
	});
});
