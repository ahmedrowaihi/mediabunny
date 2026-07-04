import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
	buildClliBox,
	buildContentLightPayload,
	buildMasteringDisplayPayload,
	buildMdcvBox,
	type ContentLightLevel,
	type HdrStaticMetadata,
	type MasteringDisplayMetadata,
	parseContentLightLevel,
	parseHevcSeiHdrMetadata,
	parseMasteringDisplayMetadata,
} from '../../src/hdr-metadata.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const __dirname = new URL('.', import.meta.url).pathname;

// Real HEVC prefix-SEI NAL units from an ffmpeg-encoded HDR10 clip (x265 master-display
// "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)" + max-cll 1000,400).
// The mastering NAL contains an 0x00 00 03 emulation-prevention sequence in the min-luminance field.
const CONTENT_LIGHT_NAL = Uint8Array.from([0x4e, 0x01, 0x90, 0x04, 0x03, 0xe8, 0x01, 0x90, 0x80]);
const MASTERING_NAL = Uint8Array.from([
	0x4e, 0x01, 0x89, 0x18, 0x33, 0xc2, 0x86, 0xc4, 0x1d, 0x4c, 0x0b, 0xb8, 0x84, 0xd0, 0x3e,
	0x80, 0x3d, 0x13, 0x40, 0x42, 0x00, 0x98, 0x96, 0x80, 0x00, 0x00, 0x03, 0x00, 0x01, 0x80,
]);

const EXPECTED_MASTERING: MasteringDisplayMetadata = {
	displayPrimaries: [[13250, 34500], [7500, 3000], [34000, 16000]],
	whitePoint: [15635, 16450],
	maxDisplayMasteringLuminance: 10000000,
	minDisplayMasteringLuminance: 1,
};
const EXPECTED_CONTENT_LIGHT: ContentLightLevel = { maxContentLightLevel: 1000, maxPicAverageLightLevel: 400 };

describe('HDR10 static metadata (verified against ffmpeg-generated SEI)', () => {
	test('parses the mastering-display SEI (137), unescaping emulation-prevention bytes', () => {
		expect(parseHevcSeiHdrMetadata(MASTERING_NAL).masteringDisplay).toEqual(EXPECTED_MASTERING);
	});

	test('parses the content-light SEI (144)', () => {
		expect(parseHevcSeiHdrMetadata(CONTENT_LIGHT_NAL).contentLight).toEqual(EXPECTED_CONTENT_LIGHT);
	});

	test('mastering-display payload round-trips (SEI body == mdcv box body)', () => {
		const payload = buildMasteringDisplayPayload(EXPECTED_MASTERING);
		expect(payload.length).toBe(24);
		expect(parseMasteringDisplayMetadata(payload)).toEqual(EXPECTED_MASTERING);
	});

	test('content-light payload round-trips', () => {
		const payload = buildContentLightPayload(EXPECTED_CONTENT_LIGHT);
		expect(payload.length).toBe(4);
		expect(parseContentLightLevel(payload)).toEqual(EXPECTED_CONTENT_LIGHT);
	});

	test('mdcv / clli boxes wrap the payload with the right size + fourcc', () => {
		const mdcv = buildMdcvBox(EXPECTED_MASTERING);
		expect(mdcv.length).toBe(8 + 24);
		expect(String.fromCharCode(...mdcv.subarray(4, 8))).toBe('mdcv');
		expect(parseMasteringDisplayMetadata(mdcv.subarray(8))).toEqual(EXPECTED_MASTERING);

		const clli = buildClliBox(EXPECTED_CONTENT_LIGHT);
		expect(clli.length).toBe(8 + 4);
		expect(String.fromCharCode(...clli.subarray(4, 8))).toBe('clli');
		expect(parseContentLightLevel(clli.subarray(8))).toEqual(EXPECTED_CONTENT_LIGHT);
	});
});

describe('HDR10 static metadata round-trips through the ISOBMFF muxer + demuxer', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	const indexOfBox = (bytes: Uint8Array, tag: string): number => {
		const t = [...tag].map(c => c.charCodeAt(0));
		for (let i = 0; i < bytes.length - t.length; i++) {
			if (t.every((b, j) => bytes[i + j] === b)) {
				return i;
			}
		}
		return -1;
	};

	test('mdcv / clli survive a HEVC transmux and re-read identically', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public/video-h265.mp4')),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('hevc');
		const config = (await track.getDecoderConfig())!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(source);
		await output.start();

		const sink = new EncodedPacketSink(track);
		let first = true;
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			await source.add(packet, first ? { decoderConfig: { ...config, hdrStaticMetadata: HDR } } : undefined);
			first = false;
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		expect(indexOfBox(bytes, 'mdcv')).toBeGreaterThan(-1);
		expect(indexOfBox(bytes, 'clli')).toBeGreaterThan(-1);

		using roundTripped = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const rtTrack = (await roundTripped.getPrimaryVideoTrack())!;
		const rtConfig = (await rtTrack.getDecoderConfig())! as VideoDecoderConfig & {
			hdrStaticMetadata?: HdrStaticMetadata;
		};
		expect(rtConfig.hdrStaticMetadata).toEqual(HDR);
	});

	test('no HDR metadata → no mdcv / clli boxes emitted', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public/video-h265.mp4')),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(source);
		await output.start();

		const sink = new EncodedPacketSink(track);
		let first = true;
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			await source.add(packet, first ? { decoderConfig: config } : undefined);
			first = false;
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		expect(indexOfBox(bytes, 'mdcv')).toBe(-1);
		expect(indexOfBox(bytes, 'clli')).toBe(-1);
	});
});
