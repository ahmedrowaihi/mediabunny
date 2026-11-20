/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `encoderControls.nalHrd` writes the HRD parameters into the bitstream, so a receiver can check the
// stream against the buffer model it was encoded to.
//
// The gap this closes: a capped encode already bounds its own rate, but the stream SAYS nothing about
// it. Without `hrd_parameters` in the SPS nothing downstream can verify conformance or know what buffer
// to allocate, which is what a broadcast chain asking for "T-STD conformant" needs.
//
// Two oracles, because the two codecs state it in different places. For AVC the SPS's VUI is parsed by
// this library, and that parser is itself cross-checked here against ffmpeg's own `-nal-hrd` output.
// For HEVC nothing here parses the VUI, so `trace_headers` - ffmpeg's conformance parser - is read
// instead; it prints every syntax element by name.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { firstSpsFromAvcRecord, parseAvcSps } from '../../src/codec-data.js';
import { Quality } from '../../src/encode.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import type { VideoCodec } from '../../src/codec.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

const MAX_BITRATE = 1_500_000;
const BUFFER_SIZE = 3_000_000;

beforeAll(() => {
	registerMediabunnyServer();
});

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
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-hrd-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

type EncodeOptions = {
	nalHrd?: 'cbr' | 'vbr';
	codec?: VideoCodec;
	/** Omitted on purpose by the test that checks a buffer model is required. */
	cap?: boolean;
	/** `'constant'` is what makes a rate really constant, and what cbr_flag needs. */
	mode?: 'constant' | 'capped' | 'buffer-only';
};

const encode = async ({ nalHrd, codec = 'avc', cap = true, mode = 'capped' }: EncodeOptions) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			codec,
			// `new Quality(0.5, {...})` would silently drop the cap - the constructor takes one argument
			bitrate: !cap
				? 2e6
				: mode === 'buffer-only'
					// A buffer with no ceiling: x264 drops it, so nothing would be declared
					? new Quality({ bitrate: MAX_BITRATE, bufferSize: BUFFER_SIZE })
					: mode === 'constant'
					// No maxBitrate: for a constant rate the target IS the cap
						? new Quality({
							bitrate: MAX_BITRATE,
							bitrateMode: 'constant',
							bufferSize: BUFFER_SIZE,
						})
						: new Quality({ quality: 0.5, maxBitrate: MAX_BITRATE, bufferSize: BUFFER_SIZE }),
			encoderControls: nalHrd === undefined ? {} : { nalHrd },
		},
		trim: { start: 0, end: 0.4 },
	});
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

/** What the AVC stream's SPS says about the buffer model. */
const hrdOf = async (bytes: Uint8Array) => {
	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config?.description);

	const sps = firstSpsFromAvcRecord(toUint8Array(config.description));
	assert(sps);
	const info = parseAvcSps(sps);
	assert(info);
	return info.hrd;
};

// E.2.2 codes the rate as a mantissa and an exponent - BitRate = (value + 1) * 2^(6 + scale) - so a
// stated rate is quantised to a multiple of 64 bit/s at scale 0. 1,500,000 comes back as 1,499,968,
// and asserting the round number would fail for a reason that is not a defect.
const quantisedDown = (bits: number) => Math.floor(bits / 64) * 64;

describe('AVC states the buffer model in its SPS', () => {
	test('without the control the stream says nothing about its own cap', async () => {
		// The cap is still applied to the encoder; it is simply not declared, which is the gap
		expect(await hrdOf(await encode({}))).toBeNull();
	});

	test('with it, the stated rate and buffer are the cap that was asked for', async () => {
		const hrd = await hrdOf(await encode({ nalHrd: 'vbr' }));
		assert(hrd);

		expect(hrd.bitRate, 'the rate, quantised as E.2.2 codes it').toBe(quantisedDown(MAX_BITRATE));
		expect(hrd.cpbSize).toBe(BUFFER_SIZE);
		expect(hrd.constantBitRate, 'vbr states a bounded rate, not a constant one').toBe(false);
	});

	test('cbr sets the flag that says the arrival rate really is constant', async () => {
		const hrd = await hrdOf(await encode({ nalHrd: 'cbr', mode: 'constant' }));
		assert(hrd);

		expect(hrd.constantBitRate).toBe(true);
		expect(hrd.bitRate).toBe(quantisedDown(MAX_BITRATE));
		expect(hrd.cpbSize).toBe(BUFFER_SIZE);
	});

	test('cbr on a capped quantizer is refused, since its flag would say vbr', async () => {
		// Measured: x264 writes cbr_flag 0 for a capped CRF encode however tightly it is capped, so
		// accepting this would hand back a stream whose own signalling contradicts what was asked
		await expect(encode({ nalHrd: 'cbr', mode: 'capped' }))
			.rejects.toThrow(/needs bitrateMode 'constant'/);
	});

	test('the field widths a pic_timing SEI needs come with it', async () => {
		// These are stated in the HRD parameters and nowhere else, which is why a `pic_timing` message
		// cannot be read without its SPS - and why writing a timecode into one depends on them
		const hrd = await hrdOf(await encode({ nalHrd: 'vbr' }));
		assert(hrd);

		expect(hrd.cpbRemovalDelayLength).toBeGreaterThan(0);
		expect(hrd.dpbOutputDelayLength).toBeGreaterThan(0);
		expect(hrd.initialCpbRemovalDelayLength).toBeGreaterThan(0);
	});

	test('a buffer model is required, since that is what gets signalled', async () => {
		await expect(encode({ nalHrd: 'vbr', cap: false }))
			.rejects.toThrow(/needs a buffer model to state/);
	});

	test('a buffer size with no rate ceiling is refused, not quietly dropped', async () => {
		// x264 ignores `vbv-bufsize` without `vbv-maxrate` and writes
		// nal_hrd_parameters_present_flag 0, so this used to produce a stream declaring nothing while
		// the caller had asked for a declaration
		await expect(encode({ nalHrd: 'vbr', mode: 'buffer-only' }))
			.rejects.toThrow(/rate ceiling and a buffer size together/);
	});

	test('an encoder with no HRD option refuses rather than dropping it', async () => {
		await expect(encode({ nalHrd: 'vbr', codec: 'vp9' }))
			.rejects.toThrow(/nalHrd is not supported by the selected encoder/);
	});

	test('a mode that is neither cbr nor vbr is refused', async () => {
		await expect(encode({ nalHrd: 'constant' as 'cbr' }))
			.rejects.toThrow(/must be 'cbr' or 'vbr'/);
	});
});

describe.skipIf(!hasFfmpeg)('cross-checks against ffmpeg', () => {
	/** ffmpeg's own `-nal-hrd` output, as the reference for what these fields should read as. */
	const reference = (mode: 'cbr' | 'vbr', bitrate = MAX_BITRATE, bufferSize = BUFFER_SIZE) => {
		const file = path.join(workDir, `ref-${mode}-${bitrate}.ts`);
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=352x288:rate=25:duration=0.3',
			'-c:v', 'libx264', '-b:v', String(bitrate), '-maxrate', String(bitrate),
			'-bufsize', String(bufferSize), '-nal-hrd', mode, '-f', 'mpegts', file,
		]);
		return file;
	};

	/** The SPS of an elementary stream that carries its parameter sets in band. */
	const spsOfStream = async (file: string) => {
		const { EncodedPacketSink } = await import('../../src/media-sink.js');
		const {
			AvcNalUnitType,
			extractNalUnitTypeForAvc,
			iterateNalUnitsInAnnexB,
		} = await import('../../src/codec-data.js');

		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		assert(packet);

		for (const location of iterateNalUnitsInAnnexB(packet.data)) {
			const nalUnit = packet.data.subarray(location.offset, location.offset + location.length);
			if (extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.SPS) {
				return nalUnit;
			}
		}

		throw new Error('no SPS in the first packet');
	};

	test('the rate is decoded against its exponent, not assumed to be scale zero', async () => {
		// E.2.2: BitRate = (bit_rate_value_minus1 + 1) * 2^(6 + bit_rate_scale). x264 picks the scale to
		// fit the mantissa, so it is 0 at 1.5 Mbit/s and NOT 0 higher up - measured as 1 at 50 Mbit/s
		// and 4 at 400 Mbit/s. A decoder that assumed 64 bit/s granularity would be out by a factor of
		// 2 and 16 on those, and every test above would still pass, since they all sit at scale 0.
		for (const bitrate of [50_000_000, 400_000_000]) {
			const info = parseAvcSps(await spsOfStream(reference('vbr', bitrate, bitrate)));
			assert(info?.hrd);
			expect(info.hrd.bitRate, `${bitrate} bit/s`).toBe(bitrate);
		}
	}, 30_000);

	test('this library\'s SPS parser agrees with ffmpeg on the same stream', async () => {
		// The parser is the oracle for the tests above, so it is itself checked against a file this
		// library did not write. An MPEG-TS carries its parameter sets in band, so the config has no
		// description and the SPS is read off the first packet.
		for (const mode of ['vbr', 'cbr'] as const) {
			const info = parseAvcSps(await spsOfStream(reference(mode)));
			assert(info?.hrd);
			expect(info.hrd.bitRate, `${mode} rate`).toBe(quantisedDown(MAX_BITRATE));
			expect(info.hrd.cpbSize, `${mode} buffer`).toBe(BUFFER_SIZE);
			expect(info.hrd.constantBitRate, `${mode} flag`).toBe(mode === 'cbr');
		}
	}, 30_000);

	test('cbr pads with filler data and vbr does not', async () => {
		// The difference between stating a constant rate and actually producing one: x264 emits filler
		// NAL units (type 12) to take up the slack. Measured on ffmpeg's own output, so this records
		// what the mode means rather than what we hope it means.
		// Counted off the wire: an Annex B start code followed by a NAL header whose type is 12
		const fillerCount = (file: string) => {
			const bytes = readFileSync(file);
			let count = 0;
			for (let i = 0; i + 3 < bytes.length; i++) {
				if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3]! & 0x1f) === 12) {
					count++;
				}
			}
			return count;
		};

		expect(fillerCount(reference('vbr')), 'vbr states the model only').toBe(0);
		expect(fillerCount(reference('cbr')), 'cbr fills the gaps').toBeGreaterThan(0);
	}, 30_000);
});

describe.skipIf(!hasFfmpeg)('HEVC signals it too, read through ffmpeg\'s parser', () => {
	test('x265 turns its HRD signalling on', async () => {
		// Nothing here parses an HEVC VUI, so the check goes through `trace_headers`, which names every
		// syntax element it reads. x265 has only an on/off switch and takes the cbr_flag from the rate
		// control, so the mode is not asserted - only that the parameters are there at all.
		const file = path.join(workDir, 'hevc-hrd.mp4');
		writeFileSync(file, await encode({ nalHrd: 'vbr', codec: 'hevc' }));

		const dump = spawnSync('ffmpeg', [
			'-v', 'trace', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
		], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

		expect(dump.stderr).toMatch(/nal_hrd_parameters_present_flag\s+1 = 1/);
		expect(dump.stderr, 'with a schedule in it').toMatch(/bit_rate_value_minus1\[0\]/);
	}, 30_000);

	test('and says nothing without the control', async () => {
		const file = path.join(workDir, 'hevc-nohrd.mp4');
		writeFileSync(file, await encode({ codec: 'hevc' }));

		const dump = spawnSync('ffmpeg', [
			'-v', 'trace', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
		], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

		expect(dump.stderr).not.toMatch(/nal_hrd_parameters_present_flag\s+1 = 1/);
	}, 30_000);
});

describe.skipIf(!hasFfmpeg)('the VUI states the frame rate it was given', () => {
	// x264 takes `num_units_in_tick` and `time_scale` straight from the encoder's time base, so a
	// microsecond time base made every AVC stream declare a million frames a second - 2,000,000 over a
	// tick of 1 - while the track said 25. In MPEG-TS the SPS is the only place a receiver can read the
	// rate, so the stream was telling it something plainly untrue.
	//
	// The oracle is `trace_headers`, which decodes the SPS as a decoder would. This library's own SPS
	// parser skips the timing fields, so reading them back through it would prove nothing.
	beforeAll(() => {
		registerMediabunnyServer();
	});

	const vuiTiming = (file: string) => {
		const trace = execFileSync('sh', [
			'-c',
			`ffmpeg -v trace -i ${JSON.stringify(file)} -c copy -bsf:v trace_headers -f null - 2>&1 || true`,
		], { encoding: 'utf8', maxBuffer: 1 << 28 });

		const valueOf = (field: string) => {
			const match = trace.match(new RegExp(`(?:vui_)?${field}\\s+[01]*\\s+=\\s+(\\d+)`));
			return match ? Number(match[1]) : null;
		};

		return { numUnitsInTick: valueOf('num_units_in_tick'), timeScale: valueOf('time_scale') };
	};

	const writeAt = async (codec: 'avc' | 'hevc', frameRate: number) => {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		// Hardware encoders write no timing at all, which is theirs to fix, not this library's
		const source = new VideoSampleSource({
			codec,
			bitrate: 1e6,
			hardwareAcceleration: 'prefer-software',
		});
		output.addVideoTrack(source, { frameRate });
		await output.start();

		const pixels = new Uint8Array(320 * 240 * 3 / 2).fill(0x80);
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(pixels, {
				format: 'I420',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / frameRate,
				duration: 1 / frameRate,
			});
			await source.add(sample);
		}

		await output.finalize();

		const file = path.join(workDir, `vui-${codec}-${frameRate}.ts`);
		writeFileSync(file, new Uint8Array(output.target.buffer!));
		return file;
	};

	test('AVC: the rate is the one the track declares, not the PTS resolution', async () => {
		// H.264 E.2.1 reads the rate as time_scale / (2 * num_units_in_tick)
		const { numUnitsInTick, timeScale } = vuiTiming(await writeAt('avc', 25));
		assert(numUnitsInTick !== null && timeScale !== null);
		expect(timeScale / (2 * numUnitsInTick)).toBe(25);
	}, 60_000);

	test('and ffmpeg writes the same two values for the same rate', async () => {
		const file = path.join(workDir, 'vui-ref.ts');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=0.4',
			'-c:v', 'libx264', '-f', 'mpegts', file,
		]);

		expect(vuiTiming(await writeAt('avc', 25))).toEqual(vuiTiming(file));
	}, 60_000);

	test('a rate that is not an integer comes through as the rational it is', async () => {
		// 30000/1001 has no integer time base, and rounding it to 30 would be a different rate
		const { numUnitsInTick, timeScale } = vuiTiming(await writeAt('avc', 30000 / 1001));
		assert(numUnitsInTick !== null && timeScale !== null);
		expect(timeScale / (2 * numUnitsInTick)).toBeCloseTo(30000 / 1001, 6);
	}, 60_000);

	test('HEVC states it too, where it comes from the frame rate rather than the time base', async () => {
		// H.265 E.3.1 has no factor of two
		const { numUnitsInTick, timeScale } = vuiTiming(await writeAt('hevc', 25));
		assert(numUnitsInTick !== null && timeScale !== null);
		expect(timeScale / numUnitsInTick).toBe(25);
	}, 60_000);
}, 180_000);
