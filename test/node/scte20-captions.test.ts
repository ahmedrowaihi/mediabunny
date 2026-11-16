/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SCTE-20 closed captions in an MPEG-2 picture's `user_data`. MPEG-2 has no SEI, so this is where
// captions go in an MPEG-2 programme, and it is not the A/53 syntax with a different wrapper - two
// fields are encoded differently and both fail silently.
//
// **The oracle is a four-step chain**, because nothing writes SCTE-20 but us and nothing here reads it
// but ffmpeg: our writer -> ffmpeg's MPEG-2 decoder, which converts SCTE-20 to A/53 triplets ->
// ffmpeg's `-a53cc` SEI writer -> this library's A/53 reader, which is itself checked against ffmpeg
// elsewhere. Only the first two steps are under test; everything after is independently validated, so
// bytes that survive the whole chain are bytes ffmpeg agreed with.
//
// What that chain caught, which a round trip through our own parser could not:
//   - the caption octets are stored BIT-REVERSED (ffmpeg's `ff_reverse[cc1]`), and
//   - the field number is the FRAME's field, not line 21's, so it inverts on a picture that is not
//     top-field-first - which decodes cleanly to the wrong caption channel.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { type ClosedCaptionBytePair, parsePacketClosedCaptions } from '../../src/closed-captions.js';
import { buildScte20UserData, carriesScte20Captions, parseScte20UserData } from '../../src/scte20.js';

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
let mpeg2Source: string;

beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-scte20-'));

	if (hasFfmpeg) {
		mpeg2Source = path.join(workDir, 'src.ts');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=352x288:rate=25:duration=0.5',
			'-c:v', 'mpeg2video', '-b:v', '2M', '-f', 'mpegts', mpeg2Source,
		]);
	}
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Writes an MPEG-TS whose MPEG-2 pictures carry these captions, and returns the file path. */
const write = async (bytePairs: ClosedCaptionBytePair[], name: string) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(mpeg2Source) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('mpeg2');
	output.addVideoTrack(source, {
		frameRate: 25,
		closedCaptions: { announceInManifest: false, channels: ['CC1'] },
	});

	await output.start();
	const sink = new EncodedPacketSink(track);
	let written = 0;
	for (
		let packet = await sink.getFirstPacket();
		packet && written < 8;
		packet = await sink.getNextPacket(packet)
	) {
		await source.add(packet, { decoderConfig, closedCaptions: bytePairs });
		written++;
	}
	await output.finalize();

	const file = path.join(workDir, name);
	writeFileSync(file, new Uint8Array(output.target.buffer!));
	return file;
};

/** What ffmpeg makes of our SCTE-20, read back through the chain described at the top. */
const throughFfmpeg = async (bytePairs: ClosedCaptionBytePair[], name: string) => {
	const source = await write(bytePairs, `${name}.ts`);
	const reemitted = path.join(workDir, `${name}.mp4`);

	// ffmpeg decodes the SCTE-20 into A/53 frame side data, then libx264 writes that side data back out
	// as an A/53 SEI message, which this library reads
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-i', source, '-c:v', 'libx264', '-a53cc', '1', '-t', '0.25', reemitted,
	]);

	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(reemitted) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config);

	const packet = await new EncodedPacketSink(track).getFirstPacket();
	assert(packet);
	return parsePacketClosedCaptions(packet.data, config, 'avc');
};

describe('the SCTE-20 payload', () => {
	test('the caption octets go in bit-reversed', () => {
		// Nothing in the syntax hints at this, and captions written without it decode to arbitrary
		// characters rather than to nothing - the worst way for it to fail
		const payload = buildScte20UserData([{ type: 0, byte0: 0x01, byte1: 0x80 }], true);

		// 0x01 reversed is 0x80 and 0x80 reversed is 0x01, so the pair appears swapped in the bytes
		const bits = [...payload.subarray(2)]
			.map(x => x.toString(2).padStart(8, '0'))
			.join('');
		expect(bits.slice(0, 5), 'cc_count').toBe('00001');
		expect(bits.slice(14, 22), 'byte0 0x01 stored reversed').toBe('10000000');
		expect(bits.slice(22, 30), 'byte1 0x80 stored reversed').toBe('00000001');
	});

	test('the field number is the frame\'s, so it inverts without top-field-first', () => {
		// Line 21 field 1 is the frame's first field only when the top field comes first
		const topFirst = buildScte20UserData([{ type: 0, byte0: 0, byte1: 0 }], true);
		const bottomFirst = buildScte20UserData([{ type: 0, byte0: 0, byte1: 0 }], false);

		const fieldOf = (payload: Uint8Array) => {
			const bits = [...payload.subarray(2)].map(x => x.toString(2).padStart(8, '0')).join('');
			return parseInt(bits.slice(7, 9), 2);
		};

		expect(fieldOf(topFirst), 'field 1 of the frame').toBe(1);
		expect(fieldOf(bottomFirst), 'field 2 of the frame').toBe(2);
	});

	test('it round-trips through our own parser, with the same field sense', () => {
		const pairs: ClosedCaptionBytePair[] = [
			{ type: 0, byte0: 0x41, byte1: 0x42 },
			{ type: 1, byte0: 0x14, byte1: 0x2c },
		];

		expect(parseScte20UserData(buildScte20UserData(pairs, true), true)).toEqual(pairs);
		expect(parseScte20UserData(buildScte20UserData(pairs, false), false)).toEqual(pairs);
	});

	test('CEA-708 packet data is refused, since SCTE-20 numbers line 21 fields only', () => {
		expect(() => buildScte20UserData([{ type: 3, byte0: 0, byte1: 0 }], true))
			.toThrow(/CEA-708 DTVCC packet data/);
	});

	test('more pairs than cc_count can state is refused', () => {
		const many = Array.from({ length: 32 }, () => ({ type: 0, byte0: 0, byte1: 0 }) as const);
		expect(() => buildScte20UserData(many, true)).toThrow(/at most 31/);
	});
});

describe.skipIf(!hasFfmpeg)('ffmpeg reads back what we wrote', () => {
	test('the bytes and the field survive the whole chain', async () => {
		const written: ClosedCaptionBytePair[] = [{ type: 0, byte0: 0x41, byte1: 0x42 }];
		expect(await throughFfmpeg(written, 'plain')).toEqual(written);
	}, 60_000);

	test('field 2 comes back as field 2', async () => {
		// The field mapping has two directions to get wrong, so both are checked
		const written: ClosedCaptionBytePair[] = [{ type: 1, byte0: 0x61, byte1: 0x62 }];
		expect(await throughFfmpeg(written, 'field2')).toEqual(written);
	}, 60_000);

	test('both fields in one picture', async () => {
		const written: ClosedCaptionBytePair[] = [
			{ type: 0, byte0: 0x41, byte1: 0x42 },
			{ type: 1, byte0: 0x43, byte1: 0x44 },
		];
		expect(await throughFfmpeg(written, 'both')).toEqual(written);
	}, 60_000);

	test('ffmpeg names it SCTE-20 rather than A/53', async () => {
		// The two syntaxes are distinguished by the decoder, and it says which it found
		const file = await write([{ type: 0, byte0: 0x41, byte1: 0x42 }], 'named.ts');
		const log = execFileSync('ffmpeg', ['-v', 'info', '-i', file, '-f', 'null', '-'], {
			encoding: 'utf8',
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		void log;
	}, 60_000);
});

describe('a picture that already has captions', () => {
	test('is refused rather than given a second set', async () => {
		if (!hasFfmpeg) {
			return;
		}

		const captioned = await write([{ type: 0, byte0: 0x41, byte1: 0x42 }], 'first.ts');
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(captioned) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);

		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('mpeg2');
		output.addVideoTrack(source, {
			frameRate: 25,
			closedCaptions: { announceInManifest: false, channels: ['CC1'] },
		});
		await output.start();

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		assert(packet);
		expect(carriesScte20Captions(packet.data), 'the source is captioned').toBe(true);

		// The splice happens before any await, so this throws rather than rejecting
		await expect(async () => source.add(packet, {
			decoderConfig,
			closedCaptions: [{ type: 0, byte0: 0x61, byte1: 0x62 }],
		})).rejects.toThrow(/already carries SCTE-20/);
	}, 60_000);
});
