import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { FilePathSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
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
