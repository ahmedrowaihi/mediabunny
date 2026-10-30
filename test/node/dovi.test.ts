import { beforeAll, describe, expect, test } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { doviCodecString, doviCompatibleBrand, parseDoviConfigRecord } from '../../src/dovi.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import type { InputVideoTrack } from '../../src/input-track.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource, VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { iterateHevcNalUnits } from '../../src/codec-data.js';
import { registerMediabunnyServer } from '@mediabunny/server';
import {
	type DoviConfig,
	HEVC_DOVI_RPU_NAL_TYPE,
	dolbyVisionRpuNalUnit,
	doviConfigBoxName,
	doviSampleEntryFourCc,
	doviSupplementalFourCc,
} from '../../src/dovi.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, DashOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';

const PUBLIC = path.join(new URL('.', import.meta.url).pathname, '../public');

// Build a dvcC/dvvC payload: major(8)=1 minor(8)=0 profile(7) level(6) rpu(1) el(1) bl(1) blCompat(4) + reserved.
const packDovi = (
	profile: number, level: number, rpu: number, el: number, bl: number, blCompat: number,
): Uint8Array => {
	const bits: number[] = [];
	const push = (value: number, n: number) => {
		for (let i = n - 1; i >= 0; i--) {
			bits.push((value >> i) & 1);
		}
	};
	push(1, 8);
	push(0, 8);
	push(profile, 7);
	push(level, 6);
	push(rpu, 1);
	push(el, 1);
	push(bl, 1);
	push(blCompat, 4);
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}
	const bytes = new Uint8Array(bits.length / 8);
	bits.forEach((bit, i) => {
		if (bit) {
			bytes[i >> 3]! |= 0x80 >> (i & 7);
		}
	});
	return bytes;
};

describe('Dolby Vision configuration record (shaka-faithful)', () => {
	test('parses profile/level/flags/compat id', () => {
		expect(parseDoviConfigRecord(packDovi(8, 6, 1, 0, 1, 4))).toEqual({
			profile: 8, level: 6, blSignalCompatibilityId: 4, rpuPresent: true, elPresent: false, blPresent: true,
		});
	});

	test('rejects a non-1.0 record', () => {
		expect(parseDoviConfigRecord(Uint8Array.from([2, 0, 0, 0, 0]))).toBeNull();
		expect(parseDoviConfigRecord(Uint8Array.from([1, 0]))).toBeNull(); // too short
	});

	test('codec string is fourcc.profile.level, zero-padded (shaka GetCodecString)', () => {
		const cfg = parseDoviConfigRecord(packDovi(5, 6, 1, 0, 1, 0))!;
		expect(doviCodecString('dvhe', cfg)).toBe('dvhe.05.06');
		expect(doviCodecString('dvh1', parseDoviConfigRecord(packDovi(8, 10, 1, 1, 1, 1))!)).toBe('dvh1.08.10');
	});

	test('the box and the sample entry follow the profile and the compatibility id', () => {
		const p5 = parseDoviConfigRecord(packDovi(5, 6, 1, 0, 1, 0))!;
		const p81 = parseDoviConfigRecord(packDovi(8, 4, 1, 0, 1, 1))!;
		const p84 = parseDoviConfigRecord(packDovi(8, 4, 1, 0, 1, 4))!;

		expect(doviConfigBoxName(p5)).toBe('dvcC');
		expect([doviConfigBoxName(p81), doviConfigBoxName(p84)]).toEqual(['dvvC', 'dvvC']);
		expect(doviConfigBoxName({ ...p81, profile: 11 })).toBe('dvwC');

		// Only a non-compatible base layer takes the Dolby entry; the others stay decodable as plain HEVC
		expect(doviSampleEntryFourCc('hevc', p5, false)).toBe('dvh1');
		expect(doviSampleEntryFourCc('hevc', p5, true)).toBe('dvhe');
		expect(doviSampleEntryFourCc('hevc', p81, false)).toBe('hvc1');
		expect(doviSampleEntryFourCc('hevc', p84, false)).toBe('hvc1');
		expect(doviSampleEntryFourCc('avc', p5, false)).toBe('dva1');

		expect(doviSupplementalFourCc('hevc', false)).toBe('dvh1');
		expect(doviCodecString(doviSupplementalFourCc('hevc', false), p81)).toBe('dvh1.08.04');
		expect(doviCodecString(doviSupplementalFourCc('hevc', false), p84)).toBe('dvh1.08.04');

		expect(doviCompatibleBrand(p84, 18)).toBe('db4h'); // 8.4 is the HLG profile
		expect(doviCompatibleBrand(p84, 14)).toBe('db4g');
	});

	test('compatible brand from bl_signal_compatibility_id + transfer characteristics (shaka)', () => {
		const cfg = parseDoviConfigRecord(packDovi(8, 6, 1, 0, 1, 4))!;
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 1 }, 16)).toBe('db1p');
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 2 }, 16)).toBe('db2g');
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 4 }, 14)).toBe('db4g'); // BT.2020 10-bit
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 4 }, 18)).toBe('db4h'); // HLG
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 0 }, 16)).toBeNull();
	});
});

/**
 * Both fixtures are MP4Box 26.07 muxes of an HEVC stream with dovi_tool-generated RPUs: `dv-p81.mp4`
 * is profile 8.1 in an `hvc1` entry with a `dvvC`, `dv-p5.mp4` is profile 5 in a `dvh1` entry.
 */
const FIXTURES = [
	['dv-p81.mp4', 'hvc1', {
		profile: 8, level: 4, blSignalCompatibilityId: 1, rpuPresent: true, elPresent: false, blPresent: true,
	}],
	['dv-p5.mp4', 'dvh1', {
		profile: 5, level: 4, blSignalCompatibilityId: 0, rpuPresent: true, elPresent: false, blPresent: true,
	}],
] as const;

/** RPU NAL units per sample, read off the length-prefixed packet data rather than off a flag. */
const rpuCounts = async (track: InputVideoTrack) => {
	const counts: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		let count = 0;
		const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
		for (let offset = 0; offset + 4 <= packet.data.byteLength;) {
			const length = view.getUint32(offset);
			if ((((packet.data[offset + 4] ?? 0) >> 1) & 0x3f) === HEVC_DOVI_RPU_NAL_TYPE) {
				count++;
			}
			offset += 4 + length;
		}
		counts.push(count);
	}
	return counts;
};

const remux = async (bytes: Uint8Array, strip: boolean) => {
	using input = new Input({ source: new BufferSource(bytes.buffer as ArrayBuffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = { ...(await track.getDecoderConfig())! };
	if (strip) {
		delete config.dolbyVision;
	}

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();
	let first = true;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packet, first ? { decoderConfig: config } : undefined);
		first = false;
	}
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

describe('Dolby Vision passthrough', () => {
	test.each(FIXTURES)('%s keeps its configuration record and its sample entry', async (name, fourCc, expected) => {
		const bytes = new Uint8Array(readFileSync(path.join(PUBLIC, name)));

		using source = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
		const sourceTrack = (await source.getPrimaryVideoTrack())!;
		expect((await sourceTrack.getDecoderConfig())!.dolbyVision).toEqual(expected);
		expect(await sourceTrack.getInternalCodecId()).toBe(fourCc);
		const sourceRpus = await rpuCounts(sourceTrack);
		expect(sourceRpus.every(count => count === 1)).toBe(true);

		using output = new Input({
			source: new BufferSource((await remux(bytes, false)).buffer),
			formats: ALL_FORMATS,
		});
		const outputTrack = (await output.getPrimaryVideoTrack())!;
		expect((await outputTrack.getDecoderConfig())!.dolbyVision).toEqual(expected);
		expect(await outputTrack.getInternalCodecId()).toBe(fourCc);
		expect(await rpuCounts(outputTrack)).toEqual(sourceRpus);
	}, 30_000);

	test('a track with no configuration record is written exactly as it would be without the field', async () => {
		const bytes = new Uint8Array(readFileSync(path.join(PUBLIC, 'dv-p81.mp4')));
		const stripped = await remux(bytes, true);

		using input = new Input({ source: new BufferSource(stripped.buffer), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect((await track.getDecoderConfig())!.dolbyVision).toBeUndefined();
		expect(await track.getInternalCodecId()).toBe('hvc1');
		// The RPUs ride in the bitstream either way; only the box is gone
		expect((await rpuCounts(track)).every(count => count === 1)).toBe(true);
	}, 30_000);
});

test('the segmented writer states the record in its init segment', async () => {
	const bytes = new Uint8Array(readFileSync(path.join(PUBLIC, 'dv-p81.mp4')));
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;

	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			mpdPath: 'manifest.mpd',
		}),
		target: new PathedTarget('manifest.mpd', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();
	let first = true;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packet, first ? { decoderConfig: config } : undefined);
		first = false;
	}
	await output.finalize();

	const init = [...files].find(([name]) => name.includes('init'))?.[1];
	expect(init).toBeDefined();
	expect(new TextDecoder('latin1').decode(init)).toContain('dvvC');
}, 30_000);

test.each(FIXTURES)('%s states the codec a player can act on', async (name, _fourCc, expected) => {
	const bytes = new Uint8Array(readFileSync(path.join(PUBLIC, name)));
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	const codec = await track.getCodecParameterString();
	if (expected.blSignalCompatibilityId === 0) {
		expect(codec).toBe(`dvh1.0${expected.profile}.0${expected.level}`);
	} else {
		expect(codec).toMatch(/^hvc1\./);
	}
	expect(await input.getMimeType()).toContain(codec!);
}, 30_000);

describe('Dolby Vision RPUs ride on the frame through a real encode', () => {
	beforeAll(() => {
		registerMediabunnyServer();
	});

	const DECLARED: DoviConfig = {
		profile: 8, level: 4, blSignalCompatibilityId: 1, rpuPresent: true, elPresent: false, blPresent: true,
	};
	const FRAME_COUNT = 5;

	// NAL type 62, layer 0, tid 0, then a payload distinct per frame so "in display order" is checkable.
	const rpuFor = (index: number) => Uint8Array.from([0x7c, 0x01, 0x19, 0x08, 0x10 + index, 0x42, 0x11]);

	const encode = async (options: { declare: boolean; rpus: boolean }) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({ codec: 'hevc', quality: new Quality('low') });
		output.addVideoTrack(source, options.declare ? { dolbyVision: DECLARED } : {});
		await output.start();

		const pixels = new Uint8Array(320 * 240 * 3 / 2).fill(0x80);
		for (let i = 0; i < FRAME_COUNT; i++) {
			using sample = new VideoSample(pixels, {
				format: 'I420',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / 30,
				duration: 1 / 30,
				dolbyVisionRpu: options.rpus ? rpuFor(i) : null,
			});
			await source.add(sample);
		}

		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	/** The NAL units of each packet, in order, so both the RPU's presence and its position are visible. */
	const nalUnitsPerPacket = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes.buffer as ArrayBuffer), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;
		const perPacket: { timestamp: number; nalUnits: Uint8Array[] }[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			perPacket.push({
				timestamp: packet.timestamp,
				nalUnits: [...iterateHevcNalUnits(packet.data, config)]
					.map(at => packet.data.subarray(at.offset, at.offset + at.length)),
			});
		}
		return { config, perPacket };
	};

	test('each encoded packet carries its own frame\'s RPU, ahead of the slice', async () => {
		const { config, perPacket } = await nalUnitsPerPacket(await encode({ declare: true, rpus: true }));

		expect(config.dolbyVision).toEqual(DECLARED);
		expect(perPacket).toHaveLength(FRAME_COUNT);

		perPacket.sort((a, b) => a.timestamp - b.timestamp);
		perPacket.forEach(({ nalUnits }, index) => {
			const rpuAt = nalUnits.findIndex(nalUnit => (nalUnit[0]! >> 1) === HEVC_DOVI_RPU_NAL_TYPE);
			const firstSliceAt = nalUnits.findIndex(nalUnit => (nalUnit[0]! >> 1) < 32);
			expect(rpuAt).toBeGreaterThanOrEqual(0);
			expect(rpuAt).toBeLessThan(firstSliceAt);
			expect(nalUnits.filter(nalUnit => (nalUnit[0]! >> 1) === HEVC_DOVI_RPU_NAL_TYPE)).toHaveLength(1);
			expect(nalUnits[rpuAt]).toEqual(rpuFor(index));
		});
	}, 60_000);

	test('a track declaring none is encoded without the box or the NAL units', async () => {
		const { config, perPacket } = await nalUnitsPerPacket(await encode({ declare: false, rpus: false }));

		expect(config.dolbyVision).toBeUndefined();
		for (const { nalUnits } of perPacket) {
			expect(nalUnits.filter(nalUnit => (nalUnit[0]! >> 1) === HEVC_DOVI_RPU_NAL_TYPE)).toHaveLength(0);
		}
	}, 60_000);

	test('frames stating an RPU on a track that declares none have it dropped, not written', async () => {
		const { config, perPacket } = await nalUnitsPerPacket(await encode({ declare: false, rpus: true }));

		expect(config.dolbyVision).toBeUndefined();
		expect(perPacket).toHaveLength(FRAME_COUNT);
		for (const { nalUnits } of perPacket) {
			expect(nalUnits.filter(nalUnit => (nalUnit[0]! >> 1) === HEVC_DOVI_RPU_NAL_TYPE)).toHaveLength(0);
		}
	}, 60_000);
});

test('the RPU NAL wrapper adds a header only where there is none', () => {
	const payload = Uint8Array.from([0x19, 0x08, 0x42]);
	// libavcodec's side data is measured to arrive without one
	expect(dolbyVisionRpuNalUnit(payload)).toEqual(Uint8Array.from([0x7c, 0x01, 0x19, 0x08, 0x42]));

	const nalUnit = Uint8Array.from([0x7c, 0x01, 0x19, 0x08, 0x42]);
	expect(dolbyVisionRpuNalUnit(nalUnit)).toBe(nalUnit);
});

test('a decode of a real Dolby Vision file states each frame\'s RPU on its sample', async () => {
	registerMediabunnyServer();

	const bytes = new Uint8Array(readFileSync(path.join(PUBLIC, 'dv-p81.mp4')));
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;

	// Keyed by presentation time, so the decoder's answer is compared against the source, not itself
	const fromPackets = new Map<number, string>();
	for await (const packet of new EncodedPacketSink(track).packets()) {
		for (const at of iterateHevcNalUnits(packet.data, config)) {
			const nalUnit = packet.data.subarray(at.offset, at.offset + at.length);
			if ((nalUnit[0]! >> 1) === HEVC_DOVI_RPU_NAL_TYPE) {
				fromPackets.set(packet.timestamp, [...nalUnit].join(','));
			}
		}
	}
	expect(fromPackets.size).toBeGreaterThan(0);

	const fromSamples = new Map<number, string>();
	for await (const sample of new VideoSampleSink(track).samples()) {
		if (sample.dolbyVisionRpu) {
			fromSamples.set(sample.timestamp, [...sample.dolbyVisionRpu].join(','));
		}
		sample.close();
	}

	expect(fromSamples).toEqual(fromPackets);
}, 60_000);
