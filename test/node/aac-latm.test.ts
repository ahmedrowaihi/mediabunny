/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// LOAS/LATM framing for AAC in MPEG-TS, stream type 0x11 - what DVB feeds carry where North American
// practice and HLS use ADTS.
//
// The assertion that matters is the last one: the same source, written both ways, must DECODE to
// byte-identical PCM through ffmpeg. Framing is exactly the kind of thing where a file can look right -
// right stream type, right sample rate, plausible frame boundaries - and still decode to noise, because
// the payload is written UNALIGNED behind a variable-length config and a single misplaced bit shifts
// everything after it.

import { beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { audioSpecificConfigBitLength, iterateLoasFrames } from '../../src/aac-latm.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

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
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-latm-'));
});

type WriteOptions = {
	framing?: 'adts' | 'latm';
	latmConfigInterval?: number;
	packetLimit?: number;
};

const write = async ({ framing = 'latm', latmConfigInterval, packetLimit = 120 }: WriteOptions = {}) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const codec = await track.getCodec();
	assert(codec);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({
		format: new MpegTsOutputFormat({ aacFraming: framing, latmConfigInterval }),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource(codec);
	output.addAudioTrack(source);

	await output.start();
	const sink = new EncodedPacketSink(track);
	let written = 0;
	for (
		let packet = await sink.getFirstPacket();
		packet && written < packetLimit;
		packet = await sink.getNextPacket(packet)
	) {
		await source.add(packet, { decoderConfig });
		written++;
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

/**
 * The audio PID's payload, de-packetized, which is where the LOAS frames live.
 *
 * The PES header is stepped over only on a packet whose payload_unit_start_indicator is set: a PES
 * packet spans several transport packets, and the continuation ones carry payload from the first octet.
 */
const elementaryStream = (ts: Uint8Array) => {
	// The PID that carries PES packets, which is not simply the first one above the reserved range -
	// the PMT sits at 0x1000 and would be picked by that rule
	let audioPid: number | undefined;
	for (let off = 0; off + 188 <= ts.length && audioPid === undefined; off += 188) {
		if (ts[off] !== 0x47 || (ts[off + 1]! & 0x40) === 0) {
			continue;
		}

		const adaptationControl = (ts[off + 3]! >> 4) & 0b11;
		let start = off + 4;
		if (adaptationControl === 0b11) {
			start += 1 + ts[off + 4]!;
		} else if (adaptationControl !== 0b01) {
			continue;
		}

		if (ts[start] === 0 && ts[start + 1] === 0 && ts[start + 2] === 1) {
			audioPid = ((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!;
		}
	}
	assert(audioPid !== undefined);

	const out: number[] = [];
	for (let off = 0; off + 188 <= ts.length; off += 188) {
		if (ts[off] !== 0x47 || (((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!) !== audioPid) {
			continue;
		}

		const payloadStart = (ts[off + 1]! & 0x40) !== 0;
		const adaptationControl = (ts[off + 3]! >> 4) & 0b11;
		if (adaptationControl === 0b10 || adaptationControl === 0b00) {
			continue;
		}

		let start = off + 4;
		if (adaptationControl === 0b11) {
			start += 1 + ts[off + 4]!;
		}
		if (payloadStart) {
			assert(ts[start] === 0 && ts[start + 1] === 0 && ts[start + 2] === 1);
			start += 9 + ts[start + 8]!; // PES header, whose remaining length is its ninth octet
		}

		for (let i = start; i < off + 188; i++) {
			out.push(ts[i]!);
		}
	}

	return new Uint8Array(out);
};

const decodedPcm = (bytes: Uint8Array, name: string) => {
	const file = path.join(workDir, name);
	writeFileSync(file, bytes);
	const pcm = path.join(workDir, `${name}.pcm`);

	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-i', file, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 's16le', pcm,
	]);

	const raw = readFileSync(pcm);
	return { size: raw.byteLength, hash: createHash('md5').update(raw).digest('hex') };
};

describe('the LOAS frame structure', () => {
	test('every frame is found by its syncword and states its own length', async () => {
		const frames = [...iterateLoasFrames(elementaryStream(await write({ packetLimit: 30 })))];

		expect(frames.length, 'one per access unit').toBeGreaterThan(20);
		// Contiguous: each frame begins exactly where the previous one's stated length ended, which is
		// only true if the length field is right
		for (const [index, frame] of frames.entries()) {
			if (index > 0) {
				const previous = frames[index - 1]!;
				expect(frame.start, `frame ${index} follows frame ${index - 1}`)
					.toBe(previous.start + 3 + previous.length);
			}
		}
	});

	test('the configuration is repeated as often as asked', async () => {
		// A receiver can only start decoding at a frame that states the configuration, so the interval
		// is what makes a stream joinable. The first bit of each AudioMuxElement is `useSameStreamMux`,
		// which is 0 exactly on the frames that carry one.
		const statesConfig = async (interval: number | undefined) => {
			const stream = elementaryStream(await write({ latmConfigInterval: interval, packetLimit: 24 }));
			return [...iterateLoasFrames(stream)]
				.map(frame => (stream[frame.start + 3]! & 0x80) === 0);
		};

		expect((await statesConfig(undefined)).every(x => x), 'every frame by default').toBe(true);

		const everyFourth = await statesConfig(4);
		expect(everyFourth.length).toBeGreaterThan(8);
		expect(everyFourth.filter((_, i) => i % 4 === 0).every(x => x), 'on the fourth').toBe(true);
		expect(everyFourth.filter((_, i) => i % 4 !== 0).some(x => x), 'and not between').toBe(false);
	});
});

describe('measuring the AudioSpecificConfig', () => {
	test('a plain AAC-LC config is thirteen bits plus the three GASpecificConfig ones', async () => {
		// objectType 5 + samplingFrequencyIndex 4 + channelConfiguration 4 = 13, then frameLengthFlag,
		// dependsOnCoreCoder and extensionFlag. Exactly the two octets such a config occupies.
		expect(audioSpecificConfigBitLength(new Uint8Array([0x11, 0x88]))).toBe(16);
	});

	test('an explicit SBR config is longer, because the core coder follows', async () => {
		// objectType 5 (SBR), then extensionSamplingFrequencyIndex and the core object type
		// 00101 0011 0010 0100 010 -> AOT 5, freq 3, chan 2, ext freq 4, core AOT 2
		expect(audioSpecificConfigBitLength(new Uint8Array([0x29, 0x32, 0x20, 0x00]))).toBe(13 + 4 + 5 + 3);
	});

	test('a config this cannot measure is refused, not guessed', async () => {
		// channelConfiguration 0 means a program config element follows, whose length depends on the
		// element lists inside it. A length that is wrong by ONE bit does not corrupt the config - it
		// shifts frameLengthType and latmBufferFullness, and the frame decodes as something else.
		expect(() => audioSpecificConfigBitLength(new Uint8Array([0x10, 0x00])))
			.toThrow(/program config element/);
		// Object type 23 (ER AAC LD) is not modelled
		expect(() => audioSpecificConfigBitLength(new Uint8Array([0xb8, 0x80])))
			.toThrow(/cannot be written as LATM/);
	});
});

describe.skipIf(!hasFfmpeg)('ffmpeg reads it as LATM and decodes it', () => {
	test('the stream type and the configuration inside it are what ffmpeg reports', async () => {
		const file = path.join(workDir, 'probe.ts');
		writeFileSync(file, await write({ packetLimit: 40 }));

		const probed = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'a', '-show_entries',
			'stream=codec_name,codec_tag_string,sample_rate,channels,profile',
			'-of', 'default=nw=1', file,
		], { encoding: 'utf8' });

		// The rate and channel count come from the StreamMuxConfig, not from any PMT descriptor, so
		// reading them back right is the config having been embedded right
		expect(probed).toMatch(/codec_name=aac_latm/);
		expect(probed, 'stream type 0x11').toMatch(/codec_tag_string=\[17\]/);
		expect(probed).toMatch(/sample_rate=48000/);
		expect(probed).toMatch(/channels=1/);
		expect(probed).toMatch(/profile=LC/);
	}, 30_000);

	test('and it decodes to byte-identical audio with the ADTS framing of the same source', async () => {
		// The check that a framing is right rather than merely plausible. One misplaced bit in the
		// unaligned payload shifts everything after it, and the file would still probe correctly.
		const adts = decodedPcm(await write({ framing: 'adts' }), 'adts.ts');
		const latm = decodedPcm(await write({ framing: 'latm' }), 'latm.ts');

		expect(latm.size, 'the same number of samples').toBe(adts.size);
		expect(latm.size).toBeGreaterThan(0);
		expect(latm.hash, 'and the same samples').toBe(adts.hash);
	}, 60_000);

	test('a config repeated less often still decodes the same', async () => {
		const every = decodedPcm(await write({ latmConfigInterval: 1 }), 'every.ts');
		const sparse = decodedPcm(await write({ latmConfigInterval: 10 }), 'sparse.ts');

		expect(sparse.hash).toBe(every.hash);
	}, 60_000);
});

describe('refusals', () => {
	test('LATM without a decoder config description is refused', async () => {
		// The StreamMuxConfig carries the AudioSpecificConfig, so there is nothing to write without one
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const output = new Output({
			format: new MpegTsOutputFormat({ aacFraming: 'latm' }),
			target: new BufferTarget(),
		});
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		assert(packet);

		// A description-less config is how ADTS-wrapped input arrives, and it is exactly the input LATM
		// cannot take: the ADTS header would land inside the payload
		await expect(source.add(packet, {
			decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1 },
		})).rejects.toThrow(/needs the AAC AudioSpecificConfig/);
	});

	test('a framing that is neither is refused', () => {
		expect(() => new MpegTsOutputFormat({ aacFraming: 'loas' as 'latm' }))
			.toThrow(/must be 'adts' or 'latm'/);
	});

	test('a config interval below one is refused', () => {
		expect(() => new MpegTsOutputFormat({ aacFraming: 'latm', latmConfigInterval: 0 }))
			.toThrow(/must be a positive integer/);
	});
});
