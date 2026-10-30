import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacket } from '../../src/packet.js';
import {
	belongsInSampleEntry,
	concatNalUnitsInAnnexB,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
} from '../../src/codec-data.js';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { FilePathSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { BufferSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { buildVideoEncoderConfigs, Quality, validateVideoEncodingAdditionalOptions } from '../../src/encode.js';
import { declaredVideoCodec } from '../../src/isobmff/isobmff-boxes.js';
import { HlsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import type { VideoCodec } from '../../src/codec.js';

const __dirname = new URL('.', import.meta.url).pathname;

// `hevc` is a registration-specific extension, so the DOM's VideoEncoderConfig does not declare it.
type BitstreamFormats = { avc?: { format: string }; hevc?: { format: string } };

const encoderConfig = (codec: VideoCodec, parameterSets?: 'inBand' | 'outOfBand'): BitstreamFormats =>
	buildVideoEncoderConfigs({
		codec,
		width: 640,
		height: 360,
		quality: new Quality('high'),
		framerate: 30,
		parameterSets,
	})[0]!.config as BitstreamFormats;

describe('the encoder is asked for the matching bitstream format', () => {
	test('AVC', () => {
		expect(encoderConfig('avc', 'inBand').avc).toEqual({ format: 'annexb' });
		expect(encoderConfig('avc', 'outOfBand').avc).toEqual({ format: 'avc' });
		expect(encoderConfig('avc').avc).toEqual({ format: 'avc' });
	});

	test('HEVC', () => {
		expect(encoderConfig('hevc', 'inBand').hevc).toEqual({ format: 'annexb' });
		expect(encoderConfig('hevc', 'outOfBand').hevc).toEqual({ format: 'hevc' });
		expect(encoderConfig('hevc').hevc).toEqual({ format: 'hevc' });
	});

	test('codecs without parameter sets are unaffected', () => {
		const config = encoderConfig('vp9', 'inBand');
		expect(config.avc).toBeUndefined();
		expect(config.hevc).toBeUndefined();
	});

	test('an unknown placement is rejected', () => {
		expect(() => validateVideoEncodingAdditionalOptions(
			'avc',
			{ parameterSets: 'annexb' as unknown as 'inBand' },
		)).toThrow(/parameterSets/);
	});
});

describe('the declared codec follows the sample entry', () => {
	const declared = (codec: VideoCodec, codecString: string, inBand: boolean) =>
		declaredVideoCodec(codec, codecString, new Mp4OutputFormat(), inBand);

	test('HEVC is only hev1 when the samples carry the parameter sets', () => {
		// mediabunny builds `hev1.` strings for every HEVC stream, so the string cannot be trusted here.
		expect(declared('hevc', 'hev1.1.6.L63.90', false)).toBe('hvc1.1.6.L63.90');
		expect(declared('hevc', 'hev1.1.6.L63.90', true)).toBe('hev1.1.6.L63.90');
		expect(declared('hevc', 'hvc1.1.6.L63.90', true)).toBe('hev1.1.6.L63.90');
	});

	test('AVC follows the bitstream, but an explicit avc3 caller string still wins', () => {
		expect(declared('avc', 'avc1.640028', false)).toBe('avc1.640028');
		expect(declared('avc', 'avc1.640028', true)).toBe('avc3.640028');
		// Both storages at once is legal (CMAF §9.3.2) and only the caller can signal it.
		expect(declared('avc', 'avc3.640028', false)).toBe('avc3.640028');
	});
});

describe('a remuxed track declares where its parameter sets are', () => {
	const remux = async (parameterSets?: 'inBand' | 'outOfBand') => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
			formats: ALL_FORMATS,
		});

		const inputTrack = await input.getPrimaryVideoTrack();
		assert(inputTrack);
		const decoderConfig = await inputTrack.getDecoderConfig();
		assert(decoderConfig?.description);

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(source, { parameterSets });

		await output.start();
		const sink = new EncodedPacketSink(inputTrack);
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			await source.add(packet, { decoderConfig });
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		return findBox(parseBoxes(bytes, 0, bytes.length), 'stsd')!.children![0]!.type;
	};

	test('in band is signalled as hev1, which a description alone cannot imply', async () => {
		expect(await remux('inBand')).toBe('hev1');
		expect(await remux('outOfBand')).toBe('hvc1');
		expect(await remux()).toBe('hvc1');
	});

	test('the CODECS attribute agrees with the sample entry', async () => {
		const codecsOf = async (parameterSets?: 'inBand' | 'outOfBand') => {
			using input = new Input({
				source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
				formats: ALL_FORMATS,
			});

			const inputTrack = await input.getPrimaryVideoTrack();
			assert(inputTrack);
			const decoderConfig = await inputTrack.getDecoderConfig();
			assert(decoderConfig?.description);

			const files = new Map<string, Uint8Array>();
			const output = new Output({
				format: new HlsOutputFormat({ segmentFormat: new Mp4OutputFormat() }),
				target: new PathedTarget('', (request) => {
					const target = new BufferTarget();
					target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
					return target;
				}),
			});
			const source = new EncodedVideoPacketSource('hevc');
			output.addVideoTrack(source, { parameterSets });

			await output.start();
			const sink = new EncodedPacketSink(inputTrack);
			for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
				await source.add(packet, { decoderConfig });
			}
			await output.finalize();

			return /CODECS="([^"]+)"/.exec(new TextDecoder().decode(files.get('')))![1];
		};

		expect(await codecsOf('inBand')).toMatch(/^hev1\./);
		expect(await codecsOf('outOfBand')).toMatch(/^hvc1\./);
		expect(await codecsOf()).toMatch(/^hvc1\./);
	});
});

// MPEG-TS carries its parameter sets in the samples, so an HLS-ingested segment remuxed to CMAF used to
// come out avc3/hev1 - which shaka plays and Safari's native HLS may not. `outOfBand` now moves them,
// which means stripping them from each sample as the Annex B transformation runs. Checked against
// ffprobe and ffmpeg's framemd5 rather than against another reading of our own boxes.
describe('Annex B from MPEG-TS can be written out of band', () => {
	const hasFfmpeg = (() => {
		try {
			execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
			execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	})();

	const remuxTs = async (source: string, parameterSets?: 'inBand' | 'outOfBand') => {
		using input = new Input({ source: new FilePathSource(source), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			// Forced, so a track needing a re-encode is discarded with a reason rather than quietly
			// transcoded: the whole point is that a copy can do this now. No decoder is registered here
			// either, so a transcode could not even run.
			copy: { mode: 'forced' },
			video: parameterSets === undefined ? {} : { parameterSets },
		});
		expect(conversion.discardedTracks.filter(discarded => discarded.reason === 'cannot_copy')).toEqual([]);
		await conversion.execute();

		return new Uint8Array(output.target.buffer!);
	};

	const VIDEO_SAMPLE_ENTRIES = ['avc1', 'avc3', 'hvc1', 'hev1'];

	/** The video track's sample entry; these files carry audio too, whose `stsd` comes first. */
	const sampleEntry = (bytes: Uint8Array) => {
		const boxes = parseBoxes(bytes, 0, bytes.length);
		const types: string[] = [];
		const walk = (list: typeof boxes) => {
			for (const box of list) {
				if (box.type === 'stsd') {
					for (const child of box.children ?? []) {
						if (VIDEO_SAMPLE_ENTRIES.includes(child.type)) {
							types.push(child.type);
						}
					}
				}
				walk(box.children ?? []);
			}
		};
		walk(boxes);

		expect(types).toHaveLength(1);
		return types[0]!;
	};

	/** Per-frame md5 of the decoded video, so "identical frames" is checked and not assumed. */
	const decodedFrames = (file: string) => execFileSync('ffmpeg', [
		'-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-',
	], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\n')
		.filter(line => line && !line.startsWith('#'))
		.map(line => line.split(',').pop()!.trim());

	const cases = [
		// `framesCompared: false`: ffmpeg's decode of this file's final frame is not stable. Measured - the
		// written MP4 is byte-identical across runs and so is the demux, and the same mismatch appears
		// between two in-band remuxes, so it is the decode of a trailing partial access unit and not this
		// change. It still carries the sample-entry claim.
		{ name: 'no-aud.ts', outOfBand: 'avc1', inBand: 'avc3', framesCompared: false },
		{ name: 'captioned-cea608.ts', outOfBand: 'avc1', inBand: 'avc3', framesCompared: true },
		{ name: 'trim-buck-bunny-ffmpeg.ts', outOfBand: 'avc1', inBand: 'avc3', framesCompared: true },
		{ name: 'hevc.ts', outOfBand: 'hvc1', inBand: 'hev1', framesCompared: true },
		{ name: 'entry24-segment3.ts', outOfBand: 'hvc1', inBand: 'hev1', framesCompared: true },
	] as const;

	for (const { name, outOfBand, inBand } of cases) {
		test(`${name} remuxes to ${outOfBand}, and still to ${inBand} when asked`, async () => {
			const source = path.join(__dirname, '../public', name);

			expect(sampleEntry(await remuxTs(source, 'outOfBand'))).toBe(outOfBand);
			// The other two answers are unchanged, so the default has not quietly moved
			expect(sampleEntry(await remuxTs(source, 'inBand'))).toBe(inBand);
			expect(sampleEntry(await remuxTs(source))).toBe(inBand);
		}, 300_000);
	}

	test.skipIf(!hasFfmpeg)('the frames are identical and the parameter sets are gone', async () => {
		for (const { name, outOfBand, framesCompared } of cases) {
			const source = path.join(__dirname, '../public', name);
			const written = path.join(tmpdir(), `mediabunny-oob-${name}.mp4`);
			const inBandWritten = path.join(tmpdir(), `mediabunny-inb-${name}.mp4`);
			writeFileSync(written, await remuxTs(source, 'outOfBand'));
			writeFileSync(inBandWritten, await remuxTs(source, 'inBand'));

			try {
				// ffprobe's own reading of the sample entry, not ours
				const probed = execFileSync('ffprobe', [
					'-v', 'error', '-select_streams', 'v:0',
					'-show_entries', 'stream=codec_tag_string', '-of', 'csv=p=0', written,
				], { encoding: 'utf8' }).trim();
				expect(probed).toBe(outOfBand);

				if (!framesCompared) {
					continue;
				}

				const fromSource = decodedFrames(source);
				const fromOutOfBand = decodedFrames(written);
				expect(fromSource.length).toBeGreaterThan(0);
				// Against the source, so the whole remux is held to it
				expect(fromOutOfBand).toEqual(fromSource);
				// And against the in-band remux, which isolates this change from the rest of the remux
				expect(fromOutOfBand).toEqual(decodedFrames(inBandWritten));
			} finally {
				rmSync(written, { force: true });
				rmSync(inBandWritten, { force: true });
			}
		}
	}, 600_000);

	// A pixel comparison cannot see a dropped SEI - the picture is the same without the captions - so the
	// NAL units themselves are counted. Only the parameter sets and the delimiter may go.
	test('only the parameter sets and the AUD are removed', async () => {
		for (const { name, inBand } of cases) {
			const codec = inBand.startsWith('avc') ? 'avc' as const : 'hevc' as const;
			const typeOf = codec === 'avc' ? extractNalUnitTypeForAvc : extractNalUnitTypeForHevc;

			const counts = async (bytes: Uint8Array | string, annexB: boolean) => {
				using input = new Input({
					source: typeof bytes === 'string' ? new FilePathSource(bytes) : new BufferSource(bytes),
					formats: ALL_FORMATS,
				});
				const track = (await input.getPrimaryVideoTrack())!;
				const sink = new EncodedPacketSink(track);
				const tally = new Map<number, number>();

				for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
					const locations = annexB
						? iterateNalUnitsInAnnexB(packet.data)
						: iterateNalUnitsInLengthPrefixed(packet.data, 4);
					for (const location of locations) {
						const type = typeOf(packet.data[location.offset]!);
						tally.set(type, (tally.get(type) ?? 0) + 1);
					}
				}

				return tally;
			};

			const source = path.join(__dirname, '../public', name);
			const before = await counts(source, true);
			const after = await counts(await remuxTs(source, 'outOfBand'), false);

			// Stated here rather than taken from `belongsInSampleEntry`, which is the thing under test:
			// asking it what to expect would move the expectation with any change to it. H.264 7, 8, 13,
			// 9; H.265 32, 33, 34, 35.
			const removed = codec === 'avc' ? [7, 8, 13, 9] : [32, 33, 34, 35];

			for (const [type, count] of before) {
				const expected = removed.includes(type) ? 0 : count;
				expect({ name, type, count: after.get(type) ?? 0 }).toEqual({ name, type, count: expected });
			}
			// Something was actually removed, and something was actually kept
			expect([...before.keys()].some(type => removed.includes(type))).toBe(true);
			expect([...after.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
		}
	}, 600_000);

	test('a parameter-set-only access unit is refused rather than written as a zero-byte sample', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/no-aud.ts')),
			formats: ALL_FORMATS,
		});
		const inputTrack = await input.getPrimaryVideoTrack();
		assert(inputTrack);

		const sink = new EncodedPacketSink(inputTrack);
		const first = (await sink.getFirstPacket())!;
		const nalUnits = [...iterateNalUnitsInAnnexB(first.data)]
			.map(loc => first.data.subarray(loc.offset, loc.offset + loc.length));
		const parameterSetsOnly = nalUnits.filter(
			unit => belongsInSampleEntry('avc', unit[0]!) && extractNalUnitTypeForAvc(unit[0]!) !== 9,
		);
		expect(parameterSetsOnly.length).toBeGreaterThan(0);

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, { parameterSets: 'outOfBand' });
		await output.start();

		await expect(source.add(new EncodedPacket(
			concatNalUnitsInAnnexB(parameterSetsOnly),
			'key',
			0,
			1 / 30,
		), { decoderConfig: (await inputTrack.getDecoderConfig())! })).rejects.toThrow(/zero-byte sample/);
	}, 300_000);
});
