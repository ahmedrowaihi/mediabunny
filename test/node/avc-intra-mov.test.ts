/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// AVC-Intra and XAVC in MOV, as cameras and Avid write them. Read side only; this fork keeps writing
// `avc1`.
//
// These sample entries are not a retag of `avc1`: they carry no `avcC` at all and their samples are
// Annex B with the parameter sets in band. A file retagged from an `avc1` source without converting the
// samples is unreadable - ffmpeg says `No start code is found`.
//
// **ffmpeg chooses the four-character code itself**, from the intra profile together with the chroma
// format, the raster and the frame rate, and it overrides an explicit `-tag:v` - asking for `avc1` on a
// 1080p25 High 4:2:2 Intra stream still writes `ai12`. So the fixtures below state no tag: what ffmpeg
// picks *is* the expectation, which is the strongest form this check can take.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { FilePathSource } from '../../src/source.js';
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
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-avci-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/**
 * Two passes, and the second one matters: `h264_mp4toannexb` only does its job on a length-prefixed
 * source, so encoding straight to the tag produces a file whose samples are misaligned and which
 * ffmpeg's own decoder rejects (`deblocking_filter_idc 27 out of range`).
 */
const buildFixture = (name: string, geometry: string, fps: number, profile: string, pixelFormat: string) => {
	const lengthPrefixed = path.join(workDir, `${name}-step1.mov`);
	const annexB = path.join(workDir, `${name}.mov`);

	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-i', SOURCE, '-an', '-t', '0.25',
		'-vf', `scale=${geometry},fps=${fps}`,
		'-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', pixelFormat,
		'-x264-params', 'keyint=1:repeat-headers=1', '-f', 'mov', lengthPrefixed,
	]);
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-i', lengthPrefixed,
		'-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'mov', annexB,
	]);

	return annexB;
};

/** How many frames ffmpeg finds, which differs by ffmpeg version and so is never hardcoded. */
const ffprobeFrameCount = (file: string) => Number(execFileSync('ffprobe', [
	'-v', 'error', '-select_streams', 'v:0', '-count_frames',
	'-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
], { encoding: 'utf8' }).trim());

/** The four-character code in the first `stsd` entry, read off the bytes. */
const sampleEntryFourCc = (file: string) => {
	const bytes = readFileSync(file);
	const at = bytes.indexOf('stsd');
	return bytes.subarray(at + 16, at + 20).toString('latin1');
};

/** Per-packet CRC32 as ffprobe computes it, so "the same essence" is decoder-independent. */
const ffprobePacketHashes = (file: string) => execFileSync('ffprobe', [
	'-v', 'error', '-select_streams', 'v:0', '-show_packets',
	'-show_data_hash', 'CRC32', '-of', 'default=noprint_wrappers=1', file,
], { encoding: 'utf8' })
	.split('\n')
	.filter(line => line.startsWith('data_hash='))
	.map(line => line.slice('data_hash='.length).trim());

const crc32 = (bytes: Uint8Array) => {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
		}
	}
	return `CRC32:${((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`;
};

const readTrack = async (file: string) => {
	using input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const config = await track.getDecoderConfig();
	const packets: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet.data);
	}

	return {
		codec: await track.getCodec(),
		width: await track.getCodedWidth(),
		height: await track.getCodedHeight(),
		configCodec: config?.codec,
		description: config?.description,
		packets,
	};
};

describe.skipIf(!hasFfmpeg)('AVC-Intra sample entries are read', () => {
	// Measured: this is which code ffmpeg picks for each shape. AVC-Intra 50 is the 4:2:0 subsampled
	// raster and AVC-Intra 100 is 4:2:2, which is why the two families differ by more than a number.
	const cases = [
		{ fourCc: 'ai12', geometry: '1920:1080', fps: 25, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai13', geometry: '1920:1080', fps: 24, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai1q', geometry: '1280:720', fps: 25, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai1p', geometry: '1280:720', fps: 24, profile: 'high422', pixelFormat: 'yuv422p10le' },
		{ fourCc: 'ai52', geometry: '1440:1080', fps: 25, profile: 'high10', pixelFormat: 'yuv420p10le' },
		{ fourCc: 'ai53', geometry: '1440:1080', fps: 24, profile: 'high10', pixelFormat: 'yuv420p10le' },
		{ fourCc: 'ai5q', geometry: '960:720', fps: 25, profile: 'high10', pixelFormat: 'yuv420p10le' },
		{ fourCc: 'ai5p', geometry: '960:720', fps: 24, profile: 'high10', pixelFormat: 'yuv420p10le' },
	];

	for (const { fourCc, geometry, fps, profile, pixelFormat } of cases) {
		test(`${fourCc} opens as avc with the right dimensions`, async () => {
			const file = buildFixture(fourCc, geometry, fps, profile, pixelFormat);

			// ffmpeg picked this code with no tag asked for, and reads the file back itself
			expect(sampleEntryFourCc(file)).toBe(fourCc);
			expect(execFileSync('ffprobe', [
				'-v', 'error', '-select_streams', 'v:0',
				'-show_entries', 'stream=codec_name,codec_tag_string', '-of', 'csv=p=0', file,
			], { encoding: 'utf8' }).trim()).toBe(`h264,${fourCc}`);

			// Not a constant: how many frames 0.25 s yields differs by ffmpeg version, so the count is
			// whatever ffmpeg finds and our reading has to agree with it
			const frames = ffprobeFrameCount(file);
			expect(frames).toBeGreaterThan(0);

			const [width, height] = geometry.split(':').map(Number);
			const read = await readTrack(file);
			expect(read.codec).toBe('avc');
			expect(read.width).toBe(width);
			expect(read.height).toBe(height);
			// The configuration record comes off the in-band parameter sets, there being no avcC, and the
			// string says in-band because that is where they are
			expect(read.configCodec).toMatch(/^avc3\./);
			expect(read.description).toBeUndefined();
			expect(read.packets).toHaveLength(frames);
		}, 300_000);
	}

	test('the packets handed over are the essence ffmpeg reads, byte for byte', async () => {
		const file = buildFixture('crc', '1920:1080', 25, 'high422', 'yuv422p10le');
		const read = await readTrack(file);

		expect(read.packets.length).toBeGreaterThan(0);
		expect(read.packets.map(crc32)).toEqual(ffprobePacketHashes(file));

		// Annex B: every access unit opens on a start code, in either of its lengths
		for (const packet of read.packets) {
			const head = [...packet.subarray(0, 4)];
			expect(head[0] === 0 && head[1] === 0 && (head[2] === 1 || (head[2] === 0 && head[3] === 1)))
				.toBe(true);
		}
	}, 300_000);

	// ffmpeg will not write these - its own selection overrides any `-tag:v` - so the four-character code
	// is patched in place. It is the same four bytes, so no box size changes and the samples are untouched.
	test.each(['AVin', 'aivx', 'ai15', 'ai16'])('%s is recognised too', async (fourCc) => {
		const built = buildFixture(`patch-${fourCc}`, '1920:1080', 25, 'high422', 'yuv422p10le');
		const bytes = readFileSync(built);
		const at = bytes.indexOf('stsd') + 16;
		expect(bytes.subarray(at, at + 4).toString('latin1')).toBe('ai12');
		bytes.write(fourCc, at, 'latin1');

		const patched = path.join(workDir, `${fourCc}-patched.mov`);
		writeFileSync(patched, bytes);
		expect(sampleEntryFourCc(patched)).toBe(fourCc);

		const read = await readTrack(patched);
		expect(read.codec).toBe('avc');
		expect(read.width).toBe(1920);
		expect(read.packets).toHaveLength(ffprobeFrameCount(built));
	}, 300_000);
});
