import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { iterateAvcNalUnits } from '../../src/codec-data.js';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Annex B to length-prefixed conversion, MP4', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/annex-b-avc.mkv')),
		formats: ALL_FORMATS,
	});
	const originalVideoTrack = (await originalInput.getPrimaryVideoTrack())!;
	const originalDecoderConfig = (await originalVideoTrack.getDecoderConfig())!;
	expect(originalDecoderConfig.description).toBeUndefined();
	expect(await originalVideoTrack.getCodec()).toBe('avc');

	const originalSink = new EncodedPacketSink(originalVideoTrack);
	const originalFirstPacket = await originalSink.getFirstPacket();
	expect([...originalFirstPacket!.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

	const originalNalUnits = [...iterateAvcNalUnits(originalFirstPacket!.data, originalDecoderConfig)]
		.map(loc => originalFirstPacket!.data.subarray(loc.offset, loc.offset + loc.length));

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const newVideoTrack = (await newInput.getPrimaryVideoTrack())!;
	const newDecoderConfig = (await newVideoTrack.getDecoderConfig())!;
	expect(newDecoderConfig.description).toBeDefined();
	expect(await newVideoTrack.getCodec()).toBe('avc');

	const newSink = new EncodedPacketSink(newVideoTrack);
	const newFirstPacket = await newSink.getFirstPacket();
	expect([...newFirstPacket!.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]); // Successfully converted

	const newNalUnits = [...iterateAvcNalUnits(newFirstPacket!.data, newDecoderConfig)]
		.map(loc => newFirstPacket!.data.subarray(loc.offset, loc.offset + loc.length));
	expect(newNalUnits).toEqual(originalNalUnits); // Content is the same though
});

test('the sample entry names avc3 when the samples carry the parameter sets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/annex-b-avc.mkv')),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	await (await Conversion.init({ input, output })).execute();

	const bytes = new Uint8Array(output.target.buffer!);
	const moov = readTopLevelBoxes(bytes).find(box => box.name === 'moov')!;
	const stsd = findBox(parseBoxes(bytes, moov.start + 8, moov.start + moov.size), 'stsd')!;

	expect(stsd.children!.map(entry => entry.type)).toEqual(['avc3']);
});

// The sample entry and the manifest derive the same fact separately, so asserting only one of them
// passes even when they disagree — which is the failure players actually see.
test('the HLS CODECS attribute agrees with the sample entry', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/annex-b-avc.mkv')),
		formats: ALL_FORMATS,
	});

	let masterPlaylist = '';
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 2,
			onMaster: text => void (masterPlaylist = text),
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});
	await (await Conversion.init({ input, output })).execute();

	expect(masterPlaylist).toMatch(/CODECS="avc3\./);
});
