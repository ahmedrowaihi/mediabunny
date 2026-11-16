/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Writing AVC-Intra and XAVC into MOV, matching ffmpeg. Three things have to hold together, and they are
// not separable: the `ai**` sample entry, **no `avcC`**, and Annex B samples with the parameter sets in
// band. Any one of the three alone produces a file nothing can read.
//
// **QuickTime only, and that is measured.** ffmpeg writes `ai12` for `-f mov` and `avc1` with an `avcC`
// for `-f mp4` from the same essence, so these entries are a QuickTime convention rather than an ISOBMFF
// one. MP4, CMAF, HLS and DASH output is untouched.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

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

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-avciw-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/**
 * An AVC-Intra MOV as ffmpeg writes one: encode an intra elementary stream, then let its mov muxer pick
 * the sample entry with no tag asked for. The two passes matter - `h264_mp4toannexb` only acts on a
 * length-prefixed source, so going straight to MOV yields samples ffmpeg's own decoder rejects.
 */
const ffmpegReference = (name: string, geometry: string, fps: number, profile: string, pixelFormat: string) => {
	const elementary = path.join(workDir, `${name}.264`);
	const reference = path.join(workDir, `${name}-ffmpeg.mov`);

	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-i', SOURCE, '-an', '-t', '0.25',
		'-vf', `scale=${geometry},fps=${fps}`,
		'-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', pixelFormat,
		'-x264-params', 'keyint=1:repeat-headers=1', '-f', 'h264', elementary,
	]);
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-i', elementary, '-r', String(fps),
		'-c:v', 'copy', '-f', 'mov', reference,
	]);

	return reference;
};

/** The first `stsd` entry's four-character code, read off the bytes. */
const sampleEntryFourCc = (bytes: Uint8Array) => {
	const buffer = Buffer.from(bytes);
	const at = buffer.indexOf('stsd');
	return buffer.subarray(at + 16, at + 20).toString('latin1');
};

/** Per-packet CRC32, computed the same way for either file so the comparison is ours alone. */
const crc32 = (bytes: Uint8Array) => {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
		}
	}
	return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

const packetHashes = async (source: FilePathSource | BufferSource) => {
	using input = new Input({ source, formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const hashes: string[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		hashes.push(crc32(packet.data));
	}

	return { hashes, codec: await track.getCodec(), width: await track.getCodedWidth() };
};

/** Remuxes a file into MOV through this library, copying the packets. */
const remuxToMov = async (file: string) => {
	using input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
	const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });

	expect(conversion.discardedTracks.filter(discarded => discarded.reason === 'cannot_copy')).toEqual([]);
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

const decodeErrors = (file: string) => execFileSync('ffmpeg', [
	'-v', 'error', '-i', file, '-f', 'null', '-',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe.skipIf(!hasFfmpeg)('AVC-Intra is written as ffmpeg writes it', () => {
	const cases = [
		{ fourCc: 'ai12', geometry: '1920:1080', fps: 25, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai13', geometry: '1920:1080', fps: 24, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai1q', geometry: '1280:720', fps: 25, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai5q', geometry: '960:720', fps: 25, profile: 'high10', pixelFormat: 'yuv420p10le' },
		{ fourCc: 'ai52', geometry: '1440:1080', fps: 25, profile: 'high10', pixelFormat: 'yuv420p10le' },
	];

	for (const { fourCc, geometry, fps, profile, pixelFormat } of cases) {
		test(`${fourCc}: same entry, no avcC, same essence as ffmpeg`, async () => {
			const reference = ffmpegReference(fourCc, geometry, fps, profile, pixelFormat);

			const ours = await remuxToMov(reference);
			const written = path.join(workDir, `${fourCc}-ours.mov`);
			writeFileSync(written, ours);

			// The **family**, not the exact code. Which of a family's codes ffmpeg picks depends on the
			// frame rate its muxer had, and a raw elementary stream carries none - `-r` does not pin it
			// down identically across builds, so CI's ffmpeg picks `ai12` for a fixture this machine's
			// picks `ai13` for. The exact mapping is tested deterministically in avc-intra-entry.test.ts;
			// what belongs here is the carriage, which is the part a fixture can settle.
			const family = fourCc.startsWith('ai1') ? /^ai1[pq236]$/ : /^ai5[pq236]$/;
			expect(sampleEntryFourCc(ours)).toMatch(family);
			expect(Buffer.from(ours).includes('avcC')).toBe(false);

			// The essence, packet by packet, against ffmpeg's own file
			const theirs = await packetHashes(new FilePathSource(reference));
			const mine = await packetHashes(new BufferSource(ours));
			expect(mine.hashes.length).toBeGreaterThan(0);
			expect(mine.hashes).toEqual(theirs.hashes);

			// And both readers accept it
			expect(decodeErrors(written)).toBe('');
			expect(mine.codec).toBe('avc');
			expect(mine.width).toBe(Number(geometry.split(':')[0]));
		}, 300_000);
	}

	test('the two families are told apart by the chroma format and raster', async () => {
		// Within a family the code depends on a frame rate a fixture cannot pin down, but *which family*
		// follows from the chroma format and raster, which the bitstream does carry.
		const hundred = await remuxToMov(
			ffmpegReference('fam-100', '1920:1080', 25, 'high422', 'yuv422p10le'),
		);
		const fifty = await remuxToMov(
			ffmpegReference('fam-50', '960:720', 25, 'high10', 'yuv420p10le'),
		);

		expect(sampleEntryFourCc(hundred)).toMatch(/^ai1/);
		expect(sampleEntryFourCc(fifty)).toMatch(/^ai5/);
	}, 600_000);

	test('MP4 gets no AVC-Intra entry, and keeps its avcC', async () => {
		const reference = ffmpegReference('mp4case', '1920:1080', 25, 'high422', 'yuv422p10le');

		using input = new Input({ source: new FilePathSource(reference), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
		await conversion.execute();
		const bytes = new Uint8Array(output.target.buffer!);

		// The control for the whole feature: these entries are QuickTime's, so an MP4 of the same essence
		// gets none of them and keeps its `avcC`. The entry is `avc3` rather than ffmpeg's `avc1` because
		// the samples genuinely carry their parameter sets in band and this library says so - unchanged by
		// this work, and `parameterSets: 'outOfBand'` is how a caller asks for `avc1` (see R7).
		expect(sampleEntryFourCc(bytes).startsWith('ai')).toBe(false);
		expect(Buffer.from(bytes).includes('avcC')).toBe(true);

		const written = path.join(workDir, 'mp4case-ours.mp4');
		writeFileSync(written, bytes);
		expect(decodeErrors(written)).toBe('');
	}, 300_000);
});
