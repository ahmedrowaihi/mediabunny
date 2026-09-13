import { expect, test } from 'vitest';
import {
	AvcNalUnitType,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateNalUnitsInLengthPrefixed,
} from '../../src/codec-data.js';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { CanvasSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Input } from '../../src/input.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { Conversion } from '../../src/conversion.js';
import { Quality } from '../../src/encode.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import type { VideoCodec } from '../../src/codec.js';

const encode = async (codec: VideoCodec, parameterSets: 'inBand' | 'outOfBand') => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(320, 240);
	const context = canvas.getContext('2d')!;
	const source = new CanvasSource(canvas, { codec, quality: new Quality('low'), parameterSets });
	output.addVideoTrack(source);

	await output.start();
	for (let i = 0; i < 6; i++) {
		context.fillStyle = i % 2 === 0 ? 'red' : 'blue';
		context.fillRect(0, 0, 320, 240);
		await source.add(i / 30, 1 / 30);
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const describeOutput = async (bytes: Uint8Array, codec: VideoCodec) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packet = (await new EncodedPacketSink(track).getFirstPacket())!;

	const types = [...iterateNalUnitsInLengthPrefixed(packet.data, 4)]
		.map(location => (codec === 'hevc'
			? extractNalUnitTypeForHevc(packet.data[location.offset]!)
			: extractNalUnitTypeForAvc(packet.data[location.offset]!)));
	const parameterSetTypes: number[] = codec === 'hevc'
		? [HevcNalUnitType.VPS_NUT, HevcNalUnitType.SPS_NUT, HevcNalUnitType.PPS_NUT]
		: [AvcNalUnitType.SPS, AvcNalUnitType.PPS];

	const stsd = findBox(parseBoxes(bytes, 0, bytes.length), 'stsd')!;

	return {
		codecString: config.codec,
		fourcc: stsd.children![0]!.type,
		inSamples: parameterSetTypes.every(type => types.includes(type)),
	};
};

const CASES = [
	{ codec: 'avc' as VideoCodec, outOfBand: 'avc1', inBand: 'avc3' },
	{ codec: 'hevc' as VideoCodec, outOfBand: 'hvc1', inBand: 'hev1' },
];

test.each(CASES)(
	'$codec outOfBand keeps the parameter sets in the sample entry',
	{ timeout: 30_000 },
	async ({ codec, outOfBand }) => {
		const result = await describeOutput(await encode(codec, 'outOfBand'), codec);

		expect(result.inSamples).toBe(false);
		expect(result.fourcc).toBe(outOfBand);
		expect(result.codecString.startsWith(outOfBand)).toBe(true);
	},
);

test.each(CASES)(
	'$codec inBand repeats them in the samples and renames the entry',
	{ timeout: 30_000 },
	async ({ codec, inBand }) => {
		const result = await describeOutput(await encode(codec, 'inBand'), codec);

		expect(result.inSamples).toBe(true);
		expect(result.fourcc).toBe(inBand);
		expect(result.codecString.startsWith(inBand)).toBe(true);
	},
);

// The option ships on the encoder config, but a server-side caller reaches it through Conversion —
// which forwards only the fields it lists, and silently drops the rest.
test.each(CASES)('$codec reaches the encoder through Conversion', { timeout: 30_000 }, async ({ codec, inBand }) => {
	const source = await encode(codec, 'outOfBand');

	using input = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec, parameterSets: 'inBand' },
	});
	await conversion.execute();

	const result = await describeOutput(new Uint8Array(output.target.buffer!), codec);
	expect(result.inSamples).toBe(true);
	expect(result.fourcc).toBe(inBand);
});
