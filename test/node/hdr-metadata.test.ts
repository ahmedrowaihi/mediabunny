import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
	buildClliBox,
	buildContentLightPayload,
	buildMasteringDisplayPayload,
	buildSeiHdrNalUnit,
	buildMdcvBox,
	extractSeiHdrMetadata,
	type ContentLightLevel,
	type HdrStaticMetadata,
	type MasteringDisplayMetadata,
	parseContentLightLevel,
	parseSeiHdrMetadata,
	parseMasteringDisplayMetadata,
} from '../../src/hdr-metadata.js';
import * as NodeAv from 'node-av';
import { registerMediabunnyServer } from '@mediabunny/server';
import { choosePixelFormat, transferForOutputBitDepth } from '../../packages/server/src/video-encoder.js';
import { transformVideoSample } from '../../packages/server/src/video-sample.js';
import { validateVideoOptions } from '../../src/conversion.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, type Source } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource, VideoSampleSource } from '../../src/media-source.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import {
	buildVideoCodecString,
	extractVideoBitDepth,
	outputCarriesHdrSignal,
	validateHdrStaticMetadata,
	type VideoBitDepth,
	type VideoCodec,
} from '../../src/codec.js';
import {
	buildVideoEncoderConfigs,
	Quality,
	validateVideoEncodingAdditionalOptions,
} from '../../src/encode.js';
import { Conversion, type ConversionVideoOptions } from '../../src/conversion.js';
import { CustomVideoDecoder, CustomVideoEncoder, registerDecoder, registerEncoder } from '../../src/custom-coder.js';
import { registerVideoSampleTransformer, VideoSample, type VideoSamplePixelFormat } from '../../src/sample.js';
import { EncodedPacket, type PacketType } from '../../src/packet.js';
import {
	AvcNalUnitType,
	concatAvcNalUnits,
	concatHevcNalUnits,
	concatNalUnitsInLengthPrefixed,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateAvcNalUnits,
	iterateHevcNalUnits,
	removeEmulationPreventionBytes,
} from '../../src/codec-data.js';
import { assert, last } from '../../src/misc.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { spliceNalUnitBeforeVcl } from '../../src/sei.js';

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
		expect(parseSeiHdrMetadata(MASTERING_NAL, 'hevc').masteringDisplay).toEqual(EXPECTED_MASTERING);
	});

	test('parses the content-light SEI (144)', () => {
		expect(parseSeiHdrMetadata(CONTENT_LIGHT_NAL, 'hevc').contentLight).toEqual(EXPECTED_CONTENT_LIGHT);
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

	test('a non-SEI NAL whose bytes read like SEI 137 is not mined for metadata', () => {
		// A slice's bits are not SEI messages, so whatever they happen to spell is not a mastering display. This
		// payload would parse as EXPECTED_MASTERING if the walk ever fed a VCL NAL to the SEI parser.
		const vclNalUnit = Uint8Array.from([
			0x02, 0x01, // NAL header, nal_unit_type 1 (TRAIL_R)
			137, 24, ...buildMasteringDisplayPayload(EXPECTED_MASTERING), 0x80,
		]);
		// A 4-byte length prefix, which is what bytes[21] & 0b11 == 0b11 states.
		const description = new Uint8Array(23);
		description[21] = 0b11;

		expect(parseSeiHdrMetadata(vclNalUnit, 'hevc').masteringDisplay).toEqual(EXPECTED_MASTERING);
		expect(extractSeiHdrMetadata(
			concatNalUnitsInLengthPrefixed([vclNalUnit], 4),
			{ codec: 'hev1.2.4.L93.90', description },
			'hevc',
		)).toEqual({});
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

const indexOfBox = (bytes: Uint8Array, tag: string): number => {
	const t = [...tag].map(c => c.charCodeAt(0));
	for (let i = 0; i < bytes.length - t.length; i++) {
		if (t.every((b, j) => bytes[i + j] === b)) {
			return i;
		}
	}
	return -1;
};

describe('HDR10 static metadata round-trips through the ISOBMFF muxer + demuxer', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
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

describe('the HDR10 SEI is written back exactly as x265 writes it', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	test('each payload rebuilds the real ffmpeg NAL unit byte for byte', () => {
		expect(buildSeiHdrNalUnit({ masteringDisplay: EXPECTED_MASTERING }, 'hevc')).toEqual(MASTERING_NAL);
		expect(buildSeiHdrNalUnit({ contentLight: EXPECTED_CONTENT_LIGHT }, 'hevc')).toEqual(CONTENT_LIGHT_NAL);
	});

	test('both payloads share one prefix SEI NAL unit that parses back to what went in', () => {
		const nalUnit = buildSeiHdrNalUnit(HDR, 'hevc');
		assert(nalUnit);

		expect(extractNalUnitTypeForHevc(nalUnit[0]!)).toBe(HevcNalUnitType.PREFIX_SEI_NUT);
		expect(nalUnit[1]).toBe(1); // nuh_layer_id = 0, nuh_temporal_id_plus1 = 1
		expect(last([...nalUnit])).toBe(0x80); // rbsp_trailing_bits
		expect(parseSeiHdrMetadata(nalUnit, 'hevc')).toEqual(HDR);
	});

	test('nothing to state means no NAL unit, never an empty one', () => {
		expect(buildSeiHdrNalUnit({}, 'hevc')).toBeNull();
	});

	test('the payload is emulation-prevented, so no start-code pattern survives in the NAL unit', () => {
		const nalUnit = buildSeiHdrNalUnit(HDR, 'hevc');
		assert(nalUnit);

		// min_display_mastering_luminance = 1 serializes as 00 00 00 01, which must be escaped to 00 00 03 00 01.
		for (let i = 0; i + 2 < nalUnit.length; i++) {
			const isStartCodePattern = nalUnit[i] === 0 && nalUnit[i + 1] === 0 && nalUnit[i + 2]! < 3;
			expect(isStartCodePattern).toBe(false);
		}
		expect(removeEmulationPreventionBytes(nalUnit.subarray(2)).length).toBe(nalUnit.length - 3);
	});
});

type PacketMapper = (data: Uint8Array, type: PacketType, config: VideoDecoderConfig) => Uint8Array;

const readPackets = async (buffer: ArrayBuffer) => {
	using result = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = (await result.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;

	const sink = new EncodedPacketSink(track);
	const packets: { data: Uint8Array; type: PacketType }[] = [];
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		packets.push({ data: packet.data, type: packet.type });
	}

	return { config, packets };
};

describe('the HDR10 SEI reaches the bitstream, not just the boxes', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	const remuxHevc = async (options: { hdrStaticMetadata?: HdrStaticMetadata; mapPacketData?: PacketMapper }) => {
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

		const written: Uint8Array[] = [];
		const sink = new EncodedPacketSink(track);
		let first = true;

		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			const data = options.mapPacketData?.(packet.data, packet.type, config) ?? packet.data;
			written.push(data);

			await source.add(
				new EncodedPacket(data, packet.type, packet.timestamp, packet.duration),
				first ? { decoderConfig: { ...config, hdrStaticMetadata: options.hdrStaticMetadata } } : undefined,
			);
			first = false;
		}

		await output.finalize();
		return { written, buffer: output.target.buffer! };
	};

	const withHdrSei: PacketMapper = (data, type, config) => {
		if (type !== 'key') {
			return data;
		}

		const nalUnits = [...iterateHevcNalUnits(data, config)]
			.map(location => data.subarray(location.offset, location.offset + location.length));
		return concatHevcNalUnits([MASTERING_NAL, CONTENT_LIGHT_NAL, ...nalUnits], config);
	};

	test('every key packet states the metadata the boxes state, and no delta packet does', async () => {
		const { config, packets } = await readPackets((await remuxHevc({ hdrStaticMetadata: HDR })).buffer);

		expect(packets.filter(packet => packet.type === 'key').length).toBeGreaterThan(0);
		expect(packets.filter(packet => packet.type === 'delta').length).toBeGreaterThan(0);

		for (const packet of packets) {
			expect(extractSeiHdrMetadata(packet.data, config, 'hevc')).toEqual(packet.type === 'key' ? HDR : {});
		}
	});

	test('the SEI sits after the parameter sets and ahead of the first slice', async () => {
		const { config, packets } = await readPackets((await remuxHevc({ hdrStaticMetadata: HDR })).buffer);
		const keyPacket = packets.find(packet => packet.type === 'key')!;

		const types = [...iterateHevcNalUnits(keyPacket.data, config)]
			.map(location => extractNalUnitTypeForHevc(keyPacket.data[location.offset]!));
		const seiIndex = types.indexOf(HevcNalUnitType.PREFIX_SEI_NUT);
		const firstVclIndex = types.findIndex(type => type < HevcNalUnitType.VPS_NUT);

		expect(seiIndex).toBeGreaterThan(-1);
		expect(firstVclIndex).toBe(seiIndex + 1);
	});

	test('without HDR metadata not one packet byte changes', async () => {
		const { written, buffer } = await remuxHevc({});
		const { packets } = await readPackets(buffer);

		expect(packets.map(packet => [...packet.data])).toEqual(written.map(data => [...data]));
	});

	test('packets that already state it are left alone rather than stating it twice', async () => {
		const { written, buffer } = await remuxHevc({ hdrStaticMetadata: HDR, mapPacketData: withHdrSei });
		const { packets } = await readPackets(buffer);

		expect(packets.map(packet => [...packet.data])).toEqual(written.map(data => [...data]));
	});

	test('a value the packets already state is never restated, not even a differing one', async () => {
		const { written, buffer } = await remuxHevc({
			hdrStaticMetadata: { ...HDR, contentLight: { maxContentLightLevel: 4000, maxPicAverageLightLevel: 400 } },
			mapPacketData: withHdrSei,
		});
		const { packets } = await readPackets(buffer);

		expect(packets.map(packet => [...packet.data])).toEqual(written.map(data => [...data]));
	});

	test('only the field the packets leave unstated is added', async () => {
		const masteringOnly: PacketMapper = (data, type, config) => {
			if (type !== 'key') {
				return data;
			}

			const nalUnits = [...iterateHevcNalUnits(data, config)]
				.map(location => data.subarray(location.offset, location.offset + location.length));
			return concatHevcNalUnits([MASTERING_NAL, ...nalUnits], config);
		};

		const { config, packets } = await readPackets(
			(await remuxHevc({ hdrStaticMetadata: HDR, mapPacketData: masteringOnly })).buffer,
		);
		const keyPacket = packets.find(packet => packet.type === 'key')!;

		const seiNalUnits = [...iterateHevcNalUnits(keyPacket.data, config)]
			.map(location => keyPacket.data.subarray(location.offset, location.offset + location.length))
			.filter(nalUnit => extractNalUnitTypeForHevc(nalUnit[0]!) === HevcNalUnitType.PREFIX_SEI_NUT);

		expect(seiNalUnits.map(nalUnit => parseSeiHdrMetadata(nalUnit, 'hevc')))
			.toEqual([{ masteringDisplay: EXPECTED_MASTERING }, { contentLight: EXPECTED_CONTENT_LIGHT }]);
	});
});

// H.264 states the same SEI messages as H.265 behind a 1-byte NAL header (nal_unit_type 6), so the ffmpeg-verified
// HEVC NAL units above are the AVC ones with their 2-byte header swapped for it.
const AVC_MASTERING_NAL = Uint8Array.from([AvcNalUnitType.SEI, ...MASTERING_NAL.subarray(2)]);
const AVC_CONTENT_LIGHT_NAL = Uint8Array.from([AvcNalUnitType.SEI, ...CONTENT_LIGHT_NAL.subarray(2)]);

describe('the same HDR10 SEI messages are framed as H.264 NAL units', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	test('each payload is the ffmpeg message body behind a 1-byte AVC NAL header', () => {
		expect(buildSeiHdrNalUnit({ masteringDisplay: EXPECTED_MASTERING }, 'avc')).toEqual(AVC_MASTERING_NAL);
		expect(buildSeiHdrNalUnit({ contentLight: EXPECTED_CONTENT_LIGHT }, 'avc')).toEqual(AVC_CONTENT_LIGHT_NAL);
	});

	test('both payloads share one SEI NAL unit that parses back to what went in', () => {
		const nalUnit = buildSeiHdrNalUnit(HDR, 'avc');
		assert(nalUnit);

		expect(nalUnit[0]).toBe(0x06); // forbidden_zero_bit = 0, nal_ref_idc = 0, nal_unit_type = 6
		expect(extractNalUnitTypeForAvc(nalUnit[0]!)).toBe(AvcNalUnitType.SEI);
		expect(last([...nalUnit])).toBe(0x80); // rbsp_trailing_bits
		expect(parseSeiHdrMetadata(nalUnit, 'avc')).toEqual(HDR);
	});

	test('nothing to state means no NAL unit, never an empty one', () => {
		expect(buildSeiHdrNalUnit({}, 'avc')).toBeNull();
	});

	test('the payload is emulation-prevented, so no start-code pattern survives in the NAL unit', () => {
		const nalUnit = buildSeiHdrNalUnit(HDR, 'avc');
		assert(nalUnit);

		// min_display_mastering_luminance = 1 serializes as 00 00 00 01, which must be escaped to 00 00 03 00 01.
		for (let i = 0; i + 2 < nalUnit.length; i++) {
			const isStartCodePattern = nalUnit[i] === 0 && nalUnit[i + 1] === 0 && nalUnit[i + 2]! < 3;
			expect(isStartCodePattern).toBe(false);
		}
		expect(removeEmulationPreventionBytes(nalUnit.subarray(1)).length).toBe(nalUnit.length - 2);
	});

	test('a non-SEI NAL whose bytes read like SEI 137 is not mined for metadata', () => {
		const vclNalUnit = Uint8Array.from([
			0x65, // NAL header, nal_ref_idc 3, nal_unit_type 5 (IDR)
			137, 24, ...buildMasteringDisplayPayload(EXPECTED_MASTERING), 0x80,
		]);
		// A 4-byte length prefix, which is what bytes[4] & 0b11 == 0b11 states.
		const description = new Uint8Array(7);
		description[4] = 0b11;

		expect(parseSeiHdrMetadata(vclNalUnit, 'avc').masteringDisplay).toEqual(EXPECTED_MASTERING);
		expect(extractSeiHdrMetadata(
			concatNalUnitsInLengthPrefixed([vclNalUnit], 4),
			{ codec: 'avc1.640028', description },
			'avc',
		)).toEqual({});
	});
});

describe('the HDR10 SEI reaches the AVC bitstream, not just the boxes', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	const remuxAvc = async (options: { hdrStaticMetadata?: HdrStaticMetadata; mapPacketData?: PacketMapper }) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public/video.mp4')),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('avc');
		const config = (await track.getDecoderConfig())!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();

		const written: Uint8Array[] = [];
		const sink = new EncodedPacketSink(track);
		let first = true;

		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			const data = options.mapPacketData?.(packet.data, packet.type, config) ?? packet.data;
			written.push(data);

			await source.add(
				new EncodedPacket(data, packet.type, packet.timestamp, packet.duration),
				first ? { decoderConfig: { ...config, hdrStaticMetadata: options.hdrStaticMetadata } } : undefined,
			);
			first = false;
		}

		await output.finalize();
		return { written, buffer: output.target.buffer! };
	};

	const withHdrSei: PacketMapper = (data, type, config) => {
		if (type !== 'key') {
			return data;
		}

		const nalUnits = [...iterateAvcNalUnits(data, config)]
			.map(location => data.subarray(location.offset, location.offset + location.length));
		return concatAvcNalUnits([AVC_MASTERING_NAL, AVC_CONTENT_LIGHT_NAL, ...nalUnits], config);
	};

	test('every key packet states the metadata the boxes state, and no delta packet does', async () => {
		const { config, packets } = await readPackets((await remuxAvc({ hdrStaticMetadata: HDR })).buffer);

		expect(packets.filter(packet => packet.type === 'key').length).toBeGreaterThan(0);
		expect(packets.filter(packet => packet.type === 'delta').length).toBeGreaterThan(0);

		for (const packet of packets) {
			expect(extractSeiHdrMetadata(packet.data, config, 'avc')).toEqual(packet.type === 'key' ? HDR : {});
		}
	});

	test('the SEI sits ahead of the first slice', async () => {
		const { config, packets } = await readPackets((await remuxAvc({ hdrStaticMetadata: HDR })).buffer);
		const keyPacket = packets.find(packet => packet.type === 'key')!;

		// The source's key packets carry SEI messages of their own, so the HDR one is found by what it states.
		const nalUnits = [...iterateAvcNalUnits(keyPacket.data, config)]
			.map(location => keyPacket.data.subarray(location.offset, location.offset + location.length));
		const seiIndex = nalUnits.findIndex(
			nalUnit => extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.SEI
				&& !!parseSeiHdrMetadata(nalUnit, 'avc').masteringDisplay,
		);
		const firstVclIndex = nalUnits.findIndex((nalUnit) => {
			const type = extractNalUnitTypeForAvc(nalUnit[0]!);
			return type >= AvcNalUnitType.NON_IDR_SLICE && type <= AvcNalUnitType.IDR;
		});

		expect(seiIndex).toBeGreaterThan(-1);
		expect(firstVclIndex).toBe(seiIndex + 1);
	});

	test('without HDR metadata not one packet byte changes', async () => {
		const { written, buffer } = await remuxAvc({});
		const { packets } = await readPackets(buffer);

		expect(packets.map(packet => [...packet.data])).toEqual(written.map(data => [...data]));
	});

	test('packets that already state it are left alone rather than stating it twice', async () => {
		const { written, buffer } = await remuxAvc({ hdrStaticMetadata: HDR, mapPacketData: withHdrSei });
		const { packets } = await readPackets(buffer);

		expect(packets.map(packet => [...packet.data])).toEqual(written.map(data => [...data]));
	});

	test('a value the packets already state is never restated, not even a differing one', async () => {
		const { written, buffer } = await remuxAvc({
			hdrStaticMetadata: { ...HDR, contentLight: { maxContentLightLevel: 4000, maxPicAverageLightLevel: 400 } },
			mapPacketData: withHdrSei,
		});
		const { packets } = await readPackets(buffer);

		expect(packets.map(packet => [...packet.data])).toEqual(written.map(data => [...data]));
	});

	test('only the field the packets leave unstated is added', async () => {
		const masteringOnly: PacketMapper = (data, type, config) => {
			if (type !== 'key') {
				return data;
			}

			const nalUnits = [...iterateAvcNalUnits(data, config)]
				.map(location => data.subarray(location.offset, location.offset + location.length));
			return concatAvcNalUnits([AVC_MASTERING_NAL, ...nalUnits], config);
		};

		const { config, packets } = await readPackets(
			(await remuxAvc({ hdrStaticMetadata: HDR, mapPacketData: masteringOnly })).buffer,
		);
		const keyPacket = packets.find(packet => packet.type === 'key')!;

		const seiNalUnits = [...iterateAvcNalUnits(keyPacket.data, config)]
			.map(location => keyPacket.data.subarray(location.offset, location.offset + location.length))
			.filter(nalUnit => extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.SEI);

		// The source's own SEI messages state no HDR10 metadata, so they drop out here.
		expect(seiNalUnits.map(nalUnit => parseSeiHdrMetadata(nalUnit, 'avc')).filter(md => md.masteringDisplay
			|| md.contentLight))
			.toEqual([{ masteringDisplay: EXPECTED_MASTERING }, { contentLight: EXPECTED_CONTENT_LIGHT }]);
	});
});

// The DOM's color space enums predate BT.2100, so these values have to be cast in; mediabunny accepts them.
const HDR10_COLOR_SPACE = {
	primaries: 'bt2020',
	transfer: 'pq',
	matrix: 'bt2020-ncl',
	fullRange: false,
} as unknown as VideoColorSpaceInit;

const codecStringFor = (codec: VideoCodec, bitDepth: VideoBitDepth | undefined) =>
	buildVideoCodecString(codec, 1920, 1080, 5e6, false, bitDepth);

describe('the codec string states the bit depth it was asked for', () => {
	test('AVC picks High or High 10', () => {
		expect(codecStringFor('avc', 8)).toMatch(/^avc1\.64/);
		expect(codecStringFor('avc', undefined)).toMatch(/^avc1\.64/);
		expect(codecStringFor('avc', 10)).toMatch(/^avc1\.6e/);
	});

	test('HEVC picks Main or Main 10, with matching compatibility flags', () => {
		expect(codecStringFor('hevc', 8)).toMatch(/^hvc1\.1\.6\./);
		expect(codecStringFor('hevc', undefined)).toMatch(/^hvc1\.1\.6\./);
		expect(codecStringFor('hevc', 10)).toMatch(/^hvc1\.2\.4\./);
	});

	test('VP9 moves profile and bit depth together, since profile 0 is 8-bit only', () => {
		expect(codecStringFor('vp9', 8)).toMatch(/^vp09\.00\.\d\d\.08$/);
		expect(codecStringFor('vp9', undefined)).toMatch(/^vp09\.00\.\d\d\.08$/);
		expect(codecStringFor('vp9', 10)).toMatch(/^vp09\.02\.\d\d\.10$/);
		expect(codecStringFor('vp9', 12)).toMatch(/^vp09\.02\.\d\d\.12$/);
	});

	test('AV1 Main carries both depths, so only the bit depth moves', () => {
		expect(codecStringFor('av1', 8)).toMatch(/^av01\.0\.\d\d[MH]\.08$/);
		expect(codecStringFor('av1', undefined)).toMatch(/^av01\.0\.\d\d[MH]\.08$/);
		expect(codecStringFor('av1', 10)).toMatch(/^av01\.0\.\d\d[MH]\.10$/);
	});

	test('a depth the codec has no profile for is refused, never silently downgraded', () => {
		expect(() => codecStringFor('vp8', 10)).toThrow(/no 10-bit profile/);
		expect(() => codecStringFor('avc', 12)).toThrow(/no 12-bit profile/);
		expect(() => codecStringFor('hevc', 12)).toThrow(/no 12-bit profile/);
		expect(() => codecStringFor('av1', 12)).toThrow(/no 12-bit profile/);
		// ProRes stores 10 or 12 bits depending on the four-character code, which `alpha` and the bitrate pick.
		expect(() => codecStringFor('prores', 10)).toThrow(/follows from the profile/);
	});

	test('a transfer function the demanded depth cannot carry is refused on every entry path', () => {
		// PQ and HLG are defined from 10 bits up, so the pair demands a file that states a transfer its
		// samples cannot carry. Both paths that accept the pair have to refuse it.
		for (const transfer of ['pq', 'hlg'] as unknown as VideoTransferCharacteristics[]) {
			expect(() => validateVideoEncodingAdditionalOptions('hevc', { bitDepth: 8, colorSpace: { transfer } }))
				.toThrow(/needs at least 10 bits/);
			expect(() => validateVideoOptions({ bitDepth: 8, colorSpace: { transfer } }))
				.toThrow(/needs at least 10 bits/);
		}

		expect(() => validateVideoEncodingAdditionalOptions('hevc', {
			bitDepth: 10,
			colorSpace: { transfer: 'pq' as unknown as VideoTransferCharacteristics },
		})).not.toThrow();
		expect(() => validateVideoEncodingAdditionalOptions('hevc', { bitDepth: 8, colorSpace: { transfer: 'bt709' } }))
			.not.toThrow();
	});

	test('a malformed bit depth is rejected by the encoding options', () => {
		expect(() => validateVideoEncodingAdditionalOptions('avc', { bitDepth: 9 as unknown as VideoBitDepth }))
			.toThrow(/bitDepth/);
		expect(() => validateVideoEncodingAdditionalOptions('avc', { bitDepth: '10' as unknown as VideoBitDepth }))
			.toThrow(/bitDepth/);
		// The codec string already fixes the profile, so a second, possibly contradicting source is refused.
		expect(() => validateVideoEncodingAdditionalOptions('avc', { fullCodecString: 'avc1.640028', bitDepth: 10 }))
			.toThrow(/cannot both be provided/);
	});

	test('a malformed color space is rejected by the encoding options', () => {
		expect(() => validateVideoEncodingAdditionalOptions('avc', {
			colorSpace: { transfer: 'smpte2084' as unknown as VideoTransferCharacteristics },
		})).toThrow(/colorSpace transfer/);
		expect(() => validateVideoEncodingAdditionalOptions('avc', {
			colorSpace: 'bt2020' as unknown as VideoColorSpaceInit,
		})).toThrow(/colorSpace, when provided, must be an object/);
		expect(() => validateVideoEncodingAdditionalOptions('avc', { colorSpace: HDR10_COLOR_SPACE })).not.toThrow();
	});

	test('the encoder is configured with the requested profile', () => {
		const configFor = (bitDepth: VideoBitDepth | undefined) => buildVideoEncoderConfigs({
			codec: 'vp9',
			width: 1920,
			height: 1080,
			quality: new Quality('high'),
			framerate: 30,
			bitDepth,
		})[0]!.config.codec;

		expect(configFor(10)).toMatch(/^vp09\.02\./);
		expect(configFor(undefined)).toMatch(/^vp09\.00\./);
	});
});

// Node has no WebCodecs, so the conversion below is driven by registered custom coders. They stand in for the
// browser's encoder and decoder; what is under test is what Conversion hands them and what the muxer is told after.
const VP9_TEN_BIT = 'vp09.02.10.10';
const encoderConfigs: VideoEncoderConfig[] = [];

// What RecordingVp9Encoder states about its own output, and what the stand-in transformer claims about the samples
// it hands back; undefined means they say nothing about color
let reportedColorSpace: VideoColorSpaceInit | undefined;
let transformedColorSpace: VideoColorSpaceInit | undefined;

const encodedSampleColorSpaces: VideoColorSpaceInit[] = [];
const encodedSampleFormats: (VideoSamplePixelFormat | null)[] = [];

// When set, the 8-bit sRGB stand-in declines the transformation and the depth-preserving one handles it instead
let preservingTransform = false;
// The doubles below are registered first and so win over node-av's real transformer; the real-node-av block stands
// them down to exercise the filter graph itself.
let useRealTransformer = false;

class RecordingVp9Encoder extends CustomVideoEncoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp9' || codec === 'vp8';
	}

	init() {
		encoderConfigs.push(this.config);
	}

	encode(videoSample: VideoSample) {
		encodedSampleColorSpaces.push(videoSample.colorSpace.toJSON());
		encodedSampleFormats.push(videoSample.format);

		this.onPacket(
			new EncodedPacket(new Uint8Array([0]), 'key', videoSample.timestamp, videoSample.duration),
			{
				decoderConfig: {
					codec: this.config.codec,
					codedWidth: this.config.width,
					codedHeight: this.config.height,
					colorSpace: reportedColorSpace,
				},
			},
		);
	}

	flush() {}
	close() {}
}

class Hdr10Vp9Decoder extends CustomVideoDecoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp9';
	}

	init() {}

	decode(packet: EncodedPacket) {
		this.onSample(new VideoSample(new Uint8Array(320 * 240 * 3), {
			format: 'I420P10',
			codedWidth: 320,
			codedHeight: 240,
			timestamp: packet.timestamp,
			duration: packet.duration,
			colorSpace: HDR10_COLOR_SPACE,
		}));
	}

	flush() {}
	close() {}
}

/** An MP4 whose VP9 track declares 10-bit BT.2020/PQ, standing in for a real HDR10 master. */
const buildHdr10Input = async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/bear-320x240-vp9.webm')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	const sink = new EncodedPacketSink(track);
	let first = true;
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		await source.add(packet, first
			? {
					decoderConfig: {
						codec: VP9_TEN_BIT,
						codedWidth: 320,
						codedHeight: 240,
						colorSpace: HDR10_COLOR_SPACE,
					},
				}
			: undefined);
		first = false;
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const convert = async (videoOptions: ConversionVideoOptions) => {
	using input = new Input({ source: new BufferSource(await buildHdr10Input()), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({ input, output, video: videoOptions });
	await conversion.execute();
	expect(conversion.discardedTracks).toEqual([]);

	using result = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!)),
		formats: ALL_FORMATS,
	});
	const track = await result.getPrimaryVideoTrack();
	assert(track);

	return {
		encoderConfig: last(encoderConfigs)!,
		colorSpace: await track.getColorSpace(),
	};
};

describe('HDR static metadata never outlives the signal it describes', () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};
	const pq = 'pq' as unknown as VideoTransferCharacteristics;
	const hlg = 'hlg' as unknown as VideoTransferCharacteristics;

	test('the predicate holds exactly for a PQ or HLG output at a depth that can carry it', () => {
		expect(outputCarriesHdrSignal(pq, 10)).toBe(true);
		expect(outputCarriesHdrSignal(hlg, 12)).toBe(true);
		// An unreadable codec string leaves the depth unknown, so the transfer that got written is the whole story.
		expect(outputCarriesHdrSignal(pq, null)).toBe(true);

		// Each of these is an output whose mastering-display box would describe a grade the output no longer states.
		expect(outputCarriesHdrSignal(pq, 8)).toBe(false);
		expect(outputCarriesHdrSignal(hlg, 8)).toBe(false);
		expect(outputCarriesHdrSignal('bt709', 10)).toBe(false);
		expect(outputCarriesHdrSignal(undefined, 10)).toBe(false);
		expect(outputCarriesHdrSignal(null, null)).toBe(false);
	});

	test('declaring the metadata without the transfer it describes is refused on every entry path', () => {
		expect(() => validateVideoEncodingAdditionalOptions('hevc', { hdrStaticMetadata: HDR }))
			.toThrow(/describes a PQ or HLG grade/);
		expect(() => validateVideoEncodingAdditionalOptions('hevc', {
			hdrStaticMetadata: HDR,
			colorSpace: { transfer: 'bt709' },
		})).toThrow(/describes a PQ or HLG grade/);
		expect(() => validateVideoOptions({ hdrStaticMetadata: HDR }))
			.toThrow(/options\.video\.hdrStaticMetadata describes a PQ or HLG grade/);

		for (const transfer of [pq, hlg]) {
			expect(() => validateVideoEncodingAdditionalOptions('hevc', { hdrStaticMetadata: HDR, colorSpace: {
				transfer,
			} })).not.toThrow();
			expect(() => validateVideoOptions({ hdrStaticMetadata: HDR, colorSpace: { transfer } })).not.toThrow();
		}
	});

	test('demanding the metadata at a depth its transfer cannot reach is refused', () => {
		expect(() => validateVideoOptions({ hdrStaticMetadata: HDR, colorSpace: { transfer: pq }, bitDepth: 8 }))
			.toThrow(/needs at least 10 bits/);
	});

	test('an inherited pairing is not a claim the caller made, so it is not refused here', () => {
		// A source can carry the boxes while stating no HDR transfer. Conversion inherits both, and what the output
		// ends up stating is only known at the encoder, so that pairing is dropped there rather than refused here.
		expect(() => validateVideoEncodingAdditionalOptions('hevc', {
			hdrStaticMetadata: HDR,
			_hdrStaticMetadataIsInherited: true,
		})).not.toThrow();
	});

	test('a value too large for the box field it is written to is refused, never wrapped', () => {
		expect(() => validateHdrStaticMetadata({
			contentLight: { maxContentLightLevel: 65536, maxPicAverageLightLevel: 400 },
		}, 'x')).toThrow(/\[0, 65535\]/);
		expect(() => validateHdrStaticMetadata({
			masteringDisplay: { ...EXPECTED_MASTERING, whitePoint: [15635, -1] },
		}, 'x')).toThrow(/\[0, 65535\]/);
		expect(() => validateHdrStaticMetadata({
			masteringDisplay: { ...EXPECTED_MASTERING, maxDisplayMasteringLuminance: 2 ** 32 },
		}, 'x')).toThrow(/\[0, 4294967295\]/);
		expect(() => validateHdrStaticMetadata({
			masteringDisplay: {
				...EXPECTED_MASTERING,
				displayPrimaries: [[0, 0], [0, 0]] as unknown as MasteringDisplayMetadata['displayPrimaries'],
			},
		}, 'x')).toThrow(/three \[x, y\] pairs/);
		expect(() => validateHdrStaticMetadata(HDR, 'x')).not.toThrow();
	});
});

describe('a transcode carries the input\'s color and bit depth to the output', () => {
	beforeAll(() => {
		registerEncoder(RecordingVp9Encoder);
		registerDecoder(Hdr10Vp9Decoder);
		// Stands in for the 2D canvas the browser re-render path uses, which yields 8-bit sRGB samples, or for
		// node-av's filter graph, which hands back a frame still carrying some of the source's color.
		registerVideoSampleTransformer((sample, description) => preservingTransform || useRealTransformer
			? null
			: new VideoSample(
				new Uint8Array(description.width * description.height * 4),
				{
					format: 'RGBA',
					codedWidth: description.width,
					codedHeight: description.height,
					timestamp: sample.timestamp,
					duration: sample.duration,
					colorSpace: transformedColorSpace,
				},
			));

		// Stands in for node-av's filter graph scaling YUV to YUV: the samples come out of it at the depth they went
		// in at, so nothing about the input's depth has stopped being true.
		registerVideoSampleTransformer((sample, description) => useRealTransformer
			? null
			: new VideoSample(
				new Uint8Array(description.width * description.height * 3),
				{
					format: 'I420P10',
					codedWidth: description.width,
					codedHeight: description.height,
					timestamp: sample.timestamp,
					duration: sample.duration,
					colorSpace: transformedColorSpace,
				},
			));
	});

	beforeEach(() => {
		encoderConfigs.length = 0;
		encodedSampleColorSpaces.length = 0;
		encodedSampleFormats.length = 0;
		reportedColorSpace = undefined;
		transformedColorSpace = undefined;
		preservingTransform = false;
		useRealTransformer = false;
	});

	test('the input\'s 10-bit BT.2020/PQ survives a re-encode', async () => {
		const { encoderConfig, colorSpace } = await convert({ codec: 'vp9', forceTranscode: true });

		expect(encoderConfig.codec).toMatch(/^vp09\.02\.\d\d\.10$/);
		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	test('an explicit bit depth is honoured over the input\'s', async () => {
		const { encoderConfig, colorSpace } = await convert({
			codec: 'vp9',
			bitDepth: 12,
			colorSpace: HDR10_COLOR_SPACE,
		});

		expect(encoderConfig.codec).toMatch(/^vp09\.02\.\d\d\.12$/);
		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	test('a re-render drops the inherited color rather than mislabelling 8-bit sRGB samples', async () => {
		const { encoderConfig, colorSpace } = await convert({
			codec: 'vp9',
			width: 160,
			height: 120,
			fit: 'fill',
		});

		expect(encoderConfig.codec).toMatch(/^vp09\.00\.\d\d\.08$/);
		expect(colorSpace.transfer).not.toBe('pq');
		expect(colorSpace.primaries).not.toBe('bt2020');
	});

	test('a resize keeping the samples 10-bit is labelled 10-bit, not 8-bit carrying HDR', async () => {
		// The default ladder rung: a resolution change with no bitDepth from the caller. The samples come out of the
		// transform at the depth they went in at, so nothing here justifies demanding the 8-bit profile of them.
		preservingTransform = true;
		transformedColorSpace = { ...HDR10_COLOR_SPACE, primaries: null };

		const { encoderConfig } = await convert({ codec: 'vp9', width: 160, height: 120, fit: 'fill' });

		expect(encodedSampleFormats.length).toBeGreaterThan(0);
		expect([...new Set(encodedSampleFormats)]).toEqual(['I420P10']);
		expect(extractVideoBitDepth(encoderConfig.codec)).toBe(10);
	});

	test('a demanded depth and color survive a re-render that flattens the samples', async () => {
		// Both came from the caller, so they are theirs to be held to, not something a re-render may quietly revise.
		const { encoderConfig, colorSpace } = await convert({
			codec: 'vp9',
			width: 160,
			height: 120,
			fit: 'fill',
			bitDepth: 10,
			colorSpace: HDR10_COLOR_SPACE,
		});

		expect(encoderConfig.codec).toMatch(/^vp09\.02\.\d\d\.10$/);
		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	test('a process function that hands back 8-bit sRGB drops the inherited depth and color too', async () => {
		// No resize here: the samples are replaced wholesale by the caller's function, which is just as capable of
		// flattening them as a canvas re-render is.
		const { encoderConfig, colorSpace } = await convert({
			codec: 'vp9',
			process: sample => new VideoSample(new Uint8Array(sample.codedWidth * sample.codedHeight * 4), {
				format: 'RGBA',
				codedWidth: sample.codedWidth,
				codedHeight: sample.codedHeight,
				timestamp: sample.timestamp,
				duration: sample.duration,
			}),
		});

		expect(extractVideoBitDepth(encoderConfig.codec)).toBe(8);
		expect(colorSpace.transfer).not.toBe('pq');
		expect(colorSpace.primaries).not.toBe('bt2020');
	});

	test('a re-rendered sample reaches the encoder with no color at all, not a partial one', async () => {
		// What FFmpeg's filter graph hands back: transfer and matrix survive the scale, primaries don't. Carried onto
		// the encoder, that labels canvas-derived bytes as PQ.
		transformedColorSpace = { ...HDR10_COLOR_SPACE, primaries: null };

		const { colorSpace } = await convert({ codec: 'vp9', width: 160, height: 120, fit: 'fill' });

		expect(encodedSampleColorSpaces.length).toBeGreaterThan(0);
		for (const sampleColorSpace of encodedSampleColorSpaces) {
			expect(sampleColorSpace).toEqual({ primaries: null, transfer: null, matrix: null, fullRange: null });
		}

		expect(colorSpace.transfer).not.toBe('pq');
		expect(colorSpace.matrix).not.toBe('bt2020-ncl');
	});

	test('a same-size transcode keeps the samples\' full color on the way to the encoder', async () => {
		const { colorSpace } = await convert({ codec: 'vp9', forceTranscode: true });

		expect(encodedSampleColorSpaces.length).toBeGreaterThan(0);
		for (const sampleColorSpace of encodedSampleColorSpaces) {
			expect(sampleColorSpace).toEqual(HDR10_COLOR_SPACE);
		}

		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	test('a declared color space the samples contradict is an error, not a silent relabel', async () => {
		await expect(convert({
			codec: 'vp9',
			forceTranscode: true,
			colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
		})).rejects.toThrow(/samples reaching the encoder report/);
	});

	test('an unreachable inherited bit depth falls back instead of discarding the track', async () => {
		// vp8 has no 10-bit profile, so inheriting the input's depth must not cost the track.
		const { encoderConfig } = await convert({ codec: 'vp8', forceTranscode: true });
		expect(encoderConfig.codec).toBe('vp8');
	});

	// The samples and the track both state genuine 10-bit BT.2020/PQ, so only the encoder's own report can
	// contradict the declaration.
	const encodeDeclaredHdr10Sample = async () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec: 'vp9',
			quality: new Quality('low'),
			bitDepth: 10,
			colorSpace: HDR10_COLOR_SPACE,
		});
		output.addVideoTrack(source);
		await output.start();

		using sample = new VideoSample(new Uint8Array(320 * 240 * 3), {
			format: 'I420P10',
			codedWidth: 320,
			codedHeight: 240,
			timestamp: 0,
			duration: 1 / 30,
			colorSpace: HDR10_COLOR_SPACE,
		});

		try {
			await source.add(sample);
			await output.finalize();
		} catch (error) {
			await output.cancel();
			throw error;
		}

		return output;
	};

	test('an encoder producing SDR while the declaration says HDR is an error, not a stamped output', async () => {
		// The defect this pins: the encoder downconverts to 8-bit BT.709 while the conversion inherited BT.2020/PQ
		// from the input, which used to be stamped onto the output regardless.
		reportedColorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

		await expect(encodeDeclaredHdr10Sample())
			.rejects.toThrow(/declares colorSpace primaries 'bt2020', but the encoder produced 'bt709'/);
	});

	test('an inherited color the encoder contradicts is dropped, never stamped onto its output', async () => {
		// Nobody demanded the color here, it came from the input, so the conversion is free to fall back to an
		// honestly-labelled SDR encode. What it may never do is keep the BT.2020/PQ label over BT.709 bytes.
		reportedColorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

		const { colorSpace } = await convert({ codec: 'vp9', forceTranscode: true });

		expect(colorSpace.primaries).not.toBe('bt2020');
		expect(colorSpace.transfer).not.toBe('pq');
	});

	test('an encoder that states the declared color space is taken at its word', async () => {
		reportedColorSpace = HDR10_COLOR_SPACE;

		const output = await encodeDeclaredHdr10Sample();

		using result = new Input({
			source: new BufferSource(new Uint8Array(output.target.buffer!)),
			formats: ALL_FORMATS,
		});
		const track = await result.getPrimaryVideoTrack();
		assert(track);

		expect(await track.getColorSpace()).toEqual(HDR10_COLOR_SPACE);
	});

	test('a malformed option is rejected', async () => {
		using input = new Input({ source: new BufferSource(await buildHdr10Input()), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

		await expect(Conversion.init({
			input,
			output,
			video: { bitDepth: 9 as unknown as VideoBitDepth },
		})).rejects.toThrow(/options\.video\.bitDepth/);

		await expect(Conversion.init({
			input,
			output,
			video: { colorSpace: { transfer: 'smpte2084' as unknown as VideoTransferCharacteristics } },
		})).rejects.toThrow(/options\.video\.colorSpace transfer/);
	});
});

describe('the node-av encoder picks a pixel format that carries the depth it was asked for', () => {
	const choose = (options: {
		supportedPixelFormats: NodeAv.AVPixelFormat[] | null;
		requestedBitDepth: VideoBitDepth | null;
		incomingBitDepth: VideoBitDepth | null;
		wantsAlpha?: boolean;
	}) => choosePixelFormat({
		codecName: 'libx265',
		wantsAlpha: false,
		...options,
	});

	test('a demanded depth the encoder can reach picks a format that stores it', () => {
		expect(choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV420P, NodeAv.AV_PIX_FMT_YUV420P10LE],
			requestedBitDepth: 10,
			incomingBitDepth: 10,
		})).toBe(NodeAv.AV_PIX_FMT_YUV420P10LE);

		// Semi-planar 10-bit counts too; hardware encoders offer nothing else
		expect(choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV420P, NodeAv.AV_PIX_FMT_P010LE],
			requestedBitDepth: 10,
			incomingBitDepth: 8,
		})).toBe(NodeAv.AV_PIX_FMT_P010LE);
	});

	test('a demanded depth the encoder cannot reach throws, naming the encoder and the depth', () => {
		expect(() => choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV420P, NodeAv.AV_PIX_FMT_NV12],
			requestedBitDepth: 10,
			incomingBitDepth: 10,
		})).toThrow(/libx265.*10-bit/);

		expect(() => choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV420P10LE],
			requestedBitDepth: 10,
			incomingBitDepth: 10,
			wantsAlpha: true,
		})).toThrow(/10-bit video with alpha/);
	});

	test('with no depth demanded, the incoming frames\' depth is preserved where the encoder can', () => {
		expect(choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV420P, NodeAv.AV_PIX_FMT_YUV420P10LE],
			requestedBitDepth: null,
			incomingBitDepth: 10,
		})).toBe(NodeAv.AV_PIX_FMT_YUV420P10LE);
	});

	test('an inherited depth out of the encoder\'s reach falls back to its default format', () => {
		// Inherited, not demanded: the codec string says nothing about the depth, so 8-bit output is correctly
		// labelled and the encode should proceed rather than fail.
		expect(choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV420P],
			requestedBitDepth: null,
			incomingBitDepth: 10,
		})).toBe(NodeAv.AV_PIX_FMT_YUV420P);

		// ProRes offers no 8-bit format at all, so its first advertised format stands
		expect(choose({
			supportedPixelFormats: [NodeAv.AV_PIX_FMT_YUV422P10LE, NodeAv.AV_PIX_FMT_YUV444P10LE],
			requestedBitDepth: null,
			incomingBitDepth: null,
		})).toBe(NodeAv.AV_PIX_FMT_YUV422P10LE);
	});
});

describe('the node-av encoder signals no transfer its output cannot carry', () => {
	test('PQ and HLG go when the output is encoded shallower than the 10 bits they need', () => {
		expect(transferForOutputBitDepth(NodeAv.AVCOL_TRC_SMPTE2084, 8)).toBe(NodeAv.AVCOL_TRC_UNSPECIFIED);
		expect(transferForOutputBitDepth(NodeAv.AVCOL_TRC_ARIB_STD_B67, 8)).toBe(NodeAv.AVCOL_TRC_UNSPECIFIED);
	});

	test('a depth that carries them keeps them, and an SDR transfer is never touched', () => {
		expect(transferForOutputBitDepth(NodeAv.AVCOL_TRC_SMPTE2084, 10)).toBe(NodeAv.AVCOL_TRC_SMPTE2084);
		expect(transferForOutputBitDepth(NodeAv.AVCOL_TRC_ARIB_STD_B67, 12)).toBe(NodeAv.AVCOL_TRC_ARIB_STD_B67);
		// A format we can't name says nothing about the depth, so there is nothing for the label to contradict
		expect(transferForOutputBitDepth(NodeAv.AVCOL_TRC_SMPTE2084, null)).toBe(NodeAv.AVCOL_TRC_SMPTE2084);
		expect(transferForOutputBitDepth(NodeAv.AVCOL_TRC_BT709, 8)).toBe(NodeAv.AVCOL_TRC_BT709);
	});
});

// Registered last, so the custom coders above keep serving the conversions they were written for.
describe('a real HDR10 encode through node-av', () => {
	beforeAll(() => {
		registerMediabunnyServer();
		useRealTransformer = true;
	});

	// Flat gray would encode fine either way; a ramp makes a lost low bit visible
	const tenBitRamp = () => {
		const data = new Uint8Array(320 * 240 * 3);
		for (let i = 0; i < 320 * 240; i++) {
			data[2 * i] = i & 0xff;
			data[2 * i + 1] = (i >> 8) & 0x03;
		}
		return data;
	};

	const encodeTenBitHdrFile = async (
		declareColorSpace: boolean,
		bitDepth: VideoBitDepth = 10,
		hdrStaticMetadata?: HdrStaticMetadata,
	) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec: 'hevc',
			quality: new Quality('low'),
			bitDepth,
			colorSpace: declareColorSpace ? HDR10_COLOR_SPACE : undefined,
			hdrStaticMetadata,
		});
		output.addVideoTrack(source);
		await output.start();

		const data = tenBitRamp();
		for (let i = 0; i < 5; i++) {
			using sample = new VideoSample(data, {
				format: 'I420P10',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / 30,
				duration: 1 / 30,
				colorSpace: HDR10_COLOR_SPACE,
			});
			await source.add(sample);
		}

		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};

	const encodeTenBitHdr = async (declareColorSpace: boolean, bitDepth: VideoBitDepth = 10) => {
		using result = new Input({
			source: new BufferSource(await encodeTenBitHdrFile(declareColorSpace, bitDepth)),
			formats: ALL_FORMATS,
		});
		const track = await result.getPrimaryVideoTrack();
		assert(track);

		const config = await track.getDecoderConfig();
		assert(config);

		return { codec: config.codec, colorSpace: await track.getColorSpace() };
	};

	test('10-bit BT.2020/PQ samples come back out as 10-bit BT.2020/PQ', { timeout: 30_000 }, async () => {
		const { codec, colorSpace } = await encodeTenBitHdr(true);

		// The codec string is read back out of the encoder's own parameter sets, so this is what the encoder wrote,
		// not what it was asked for
		expect(extractVideoBitDepth(codec)).toBe(10);
		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	test('8 bits demanded of HDR frames comes back out unlabelled, not stamped PQ', { timeout: 30_000 }, async () => {
		// The depth was demanded, so the downconvert is right and it is the transfer that has to go: BT.2020 primaries
		// and matrix still describe these samples, PQ no longer does.
		const { codec, colorSpace } = await encodeTenBitHdr(false, 8);

		expect(extractVideoBitDepth(codec)).toBe(8);
		expect([null, undefined]).toContain(colorSpace.transfer);
		expect(colorSpace.primaries).toBe('bt2020');
		expect(colorSpace.matrix).toBe('bt2020-ncl');
	});

	test('the encoder states the color it encoded, with nothing declared to stamp', { timeout: 30_000 }, async () => {
		const { codec, colorSpace } = await encodeTenBitHdr(false);

		expect(extractVideoBitDepth(codec)).toBe(10);
		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	test('an 8-bit transcode drops the inherited HDR transfer instead of stamping it', { timeout: 30_000 },
		async () => {
		// No resize, so nothing routes through the filter graph and the inherited color reaches the output
		// track directly. PQ needs 10 bits, so the encoder writes no transfer - refilling it from the
		// inherited value would put an HDR label on 8-bit samples.
			using input = new Input({
				source: new BufferSource(await encodeTenBitHdrFile(true)),
				formats: ALL_FORMATS,
			});
			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			const conversion = await Conversion.init({
				input,
				output,
				video: { forceTranscode: true, bitDepth: 8 },
			});
			await conversion.execute();
			expect(conversion.discardedTracks).toEqual([]);

			using result = new Input({
				source: new BufferSource(new Uint8Array(output.target.buffer!)),
				formats: ALL_FORMATS,
			});
			const track = await result.getPrimaryVideoTrack();
			assert(track);
			const colorSpace = await track.getColorSpace();

			expect(extractVideoBitDepth((await track.getDecoderConfig())!.codec)).toBe(8);
			expect(colorSpace.transfer).not.toBe('pq');
			// Primaries and matrix are carried fine at 8 bits, so they must survive.
			expect(colorSpace.primaries).toBe('bt2020');
			expect(colorSpace.matrix).toBe('bt2020-ncl');
		});

	// A resize routes every sample through the node-av filter graph. Matrix and range are libavfilter link
	// properties, so a buffer source that doesn't state them hands back frames with those two unstated - the
	// encoder then has nothing to write and the rung comes out color_space=unknown.
	const rescaleTenBitHdr = async (width: number) => {
		using input = new Input({
			source: new BufferSource(await encodeTenBitHdrFile(true)),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

		const video = { width, height: 120, fit: 'fill', bitDepth: 10 } as const;
		const conversion = await Conversion.init({ input, output, video });
		await conversion.execute();
		expect(conversion.discardedTracks).toEqual([]);

		using result = new Input({
			source: new BufferSource(new Uint8Array(output.target.buffer!)),
			formats: ALL_FORMATS,
		});
		const track = await result.getPrimaryVideoTrack();
		assert(track);

		const config = await track.getDecoderConfig();
		assert(config);

		return { codec: config.codec, colorSpace: await track.getColorSpace() };
	};

	test('a rescaled rung keeps the matrix and range the source stated', { timeout: 60_000 }, async () => {
		const { codec, colorSpace } = await rescaleTenBitHdr(160);

		expect(extractVideoBitDepth(codec)).toBe(10);
		expect(colorSpace).toEqual(HDR10_COLOR_SPACE);
	});

	const HDR_STATIC: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	const readBack = async (bytes: Uint8Array) => {
		using result = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await result.getPrimaryVideoTrack();
		assert(track);

		const config = await track.getDecoderConfig();
		assert(config);

		return {
			bitDepth: extractVideoBitDepth(config.codec),
			colorSpace: await track.getColorSpace(),
			hdrStaticMetadata: config.hdrStaticMetadata,
		};
	};

	const convertHdr10 = async (video: ConversionVideoOptions) => {
		using input = new Input({
			source: new BufferSource(await encodeTenBitHdrFile(true, 10, HDR_STATIC)),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, video });
		await conversion.execute();
		expect(conversion.discardedTracks).toEqual([]);

		return readBack(new Uint8Array(output.target.buffer!));
	};

	test('a 10-bit PQ encode writes the mastering display and content light it was given',
		{ timeout: 30_000 }, async () => {
			const read = await readBack(await encodeTenBitHdrFile(true, 10, HDR_STATIC));

			expect(read.bitDepth).toBe(10);
			expect(read.colorSpace).toEqual(HDR10_COLOR_SPACE);
			expect(read.hdrStaticMetadata).toEqual(HDR_STATIC);
		});

	test('nothing is written when nothing was given - the values are never invented',
		{ timeout: 30_000 }, async () => {
			const read = await readBack(await encodeTenBitHdrFile(true));

			expect(read.colorSpace).toEqual(HDR10_COLOR_SPACE);
			expect(read.hdrStaticMetadata).toBeUndefined();
		});

	test('a transcode inherits it from the input, because a re-encode does not regrade the content',
		{ timeout: 60_000 }, async () => {
			const read = await convertHdr10({ forceTranscode: true });

			expect(read.bitDepth).toBe(10);
			expect(read.colorSpace).toEqual(HDR10_COLOR_SPACE);
			expect(read.hdrStaticMetadata).toEqual(HDR_STATIC);
		});

	test('a rescaled rung still carries it, since it is still the same 10-bit PQ grade',
		{ timeout: 60_000 }, async () => {
			const read = await convertHdr10({ width: 160, height: 120, fit: 'fill', bitDepth: 10 });

			expect(read.bitDepth).toBe(10);
			expect(read.colorSpace).toEqual(HDR10_COLOR_SPACE);
			expect(read.hdrStaticMetadata).toEqual(HDR_STATIC);
		});

	test('an 8-bit transcode loses it together with the transfer it describes, not one without the other',
		{ timeout: 60_000 }, async () => {
			const read = await convertHdr10({ forceTranscode: true, bitDepth: 8 });

			expect(read.bitDepth).toBe(8);
			expect([null, undefined]).toContain(read.colorSpace.transfer);
			expect(read.hdrStaticMetadata).toBeUndefined();
			// Primaries and matrix are carried fine at 8 bits, so only what PQ described goes.
			expect(read.colorSpace.primaries).toBe('bt2020');
			expect(read.colorSpace.matrix).toBe('bt2020-ncl');
		});

	// ffmpeg's mp4 muxer writes neither mdcv nor clli, so a normal x265 HDR10 master states its static metadata only
	// in the SEI of its first access unit. Rebuild that exact shape: remux a file, prepending the real ffmpeg SEI NAL
	// units to the first access unit, and let the muxer write whatever boxes the config asks for.
	const remuxWithSei = async (inputSource: Source) => {
		using input = new Input({ source: inputSource, formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const config = await track.getDecoderConfig();
		assert(config);

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(source);
		await output.start();

		const sink = new EncodedPacketSink(track);
		let first = true;

		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			let injected = packet;

			if (first) {
				const data = packet.data;
				const nalUnits = [...iterateHevcNalUnits(data, config)]
					.map(location => data.subarray(location.offset, location.offset + location.length));
				injected = packet.clone({
					data: concatHevcNalUnits([MASTERING_NAL, CONTENT_LIGHT_NAL, ...nalUnits], config),
				});
			}

			await source.add(injected, first ? { decoderConfig: config } : undefined);
			first = false;
		}

		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};

	const seiOnlyHdr10File = async () => remuxWithSei(new BufferSource(await encodeTenBitHdrFile(true)));

	const convertSeiOnlyHdr10 = async (video: ConversionVideoOptions) => {
		using input = new Input({ source: new BufferSource(await seiOnlyHdr10File()), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, video });
		await conversion.execute();
		expect(conversion.discardedTracks).toEqual([]);

		return readBack(new Uint8Array(output.target.buffer!));
	};

	test('a PQ track with no mdcv / clli gets its static metadata out of the HEVC SEI',
		{ timeout: 60_000 }, async () => {
			const bytes = await seiOnlyHdr10File();
			expect(indexOfBox(bytes, 'mdcv')).toBe(-1);
			expect(indexOfBox(bytes, 'clli')).toBe(-1);

			const read = await readBack(bytes);

			expect(read.colorSpace.transfer).toBe('pq');
			expect(read.hdrStaticMetadata).toEqual(HDR_STATIC);
		});

	test('an SDR track carrying the same SEI is never probed for it', { timeout: 60_000 }, async () => {
		// The probe is gated on the track already claiming a PQ or HLG transfer, so a BT.709 file pays no packet
		// read - and metadata describing a grade this track does not state must not be reported for it either.
		const bytes = await remuxWithSei(new FilePathSource(path.join(__dirname, '..', 'public/video-h265.mp4')));
		const read = await readBack(bytes);

		expect(read.colorSpace.transfer).not.toBe('pq');
		expect(read.hdrStaticMetadata).toBeUndefined();
	});

	test('a box beats the SEI that disagrees with it, while the SEI still fills the box that is missing',
		{ timeout: 60_000 }, async () => {
			// Only mdcv is written, and with a luminance the SEI does not state - so the probe runs for the missing
			// clli, and the mastering display it also finds there must not displace the box's.
			const boxed = { ...EXPECTED_MASTERING, maxDisplayMasteringLuminance: 4000000 };
			const read = await readBack(
				await remuxWithSei(new BufferSource(await encodeTenBitHdrFile(true, 10, { masteringDisplay: boxed }))),
			);

			expect(read.hdrStaticMetadata).toEqual({
				masteringDisplay: boxed,
				contentLight: EXPECTED_CONTENT_LIGHT,
			});
		});

	test('a transcode of a SEI-only master carries it into the output boxes', { timeout: 60_000 }, async () => {
		const read = await convertSeiOnlyHdr10({ forceTranscode: true });

		expect(read.bitDepth).toBe(10);
		expect(read.colorSpace).toEqual(HDR10_COLOR_SPACE);
		expect(read.hdrStaticMetadata).toEqual(HDR_STATIC);
	});

	test('a rescaled rung of a SEI-only master carries it too', { timeout: 60_000 }, async () => {
		const read = await convertSeiOnlyHdr10({ width: 160, height: 120, fit: 'fill', bitDepth: 10 });

		expect(read.bitDepth).toBe(10);
		expect(read.colorSpace).toEqual(HDR10_COLOR_SPACE);
		expect(read.hdrStaticMetadata).toEqual(HDR_STATIC);
	});

	test('an 8-bit transcode of a SEI-only master loses it with the transfer, exactly as a boxed one does',
		{ timeout: 60_000 }, async () => {
			const read = await convertSeiOnlyHdr10({ forceTranscode: true, bitDepth: 8 });

			expect(read.bitDepth).toBe(8);
			expect([null, undefined]).toContain(read.colorSpace.transfer);
			expect(read.hdrStaticMetadata).toBeUndefined();
		});

	// The container cannot tell an unstated range from a limited one - HEVC's video_full_range_flag defaults to 0 -
	// so the range half of the filter graph's link only shows up on the sample handed to the encoder.
	test('all four fields survive the filter graph itself', { timeout: 60_000 }, async () => {
		using input = new Input({
			source: new BufferSource(await encodeTenBitHdrFile(true)),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const sink = new VideoSampleSink(track);
		let transformed = 0;

		for await (using sample of sink.samples()) {
			expect(sample.colorSpace).toEqual(HDR10_COLOR_SPACE);

			using scaled = await transformVideoSample(sample, {
				crop: { left: 0, top: 0, width: sample.codedWidth, height: sample.codedHeight },
				width: sample.codedWidth / 2,
				height: sample.codedHeight / 2,
				fit: 'fill',
				flip: false,
				rotation: 0,
				alpha: 'discard',
			});
			assert(scaled);

			expect(scaled.codedWidth).toBe(sample.codedWidth / 2);
			expect(scaled.colorSpace).toEqual(HDR10_COLOR_SPACE);
			transformed++;
		}

		expect(transformed).toBeGreaterThan(0);
	});
});

describe('HDR10 static metadata from the bitstream, where a transport stream is the only place it lives',
	() => {
		const HDR: HdrStaticMetadata = {
			masteringDisplay: EXPECTED_MASTERING,
			contentLight: EXPECTED_CONTENT_LIGHT,
		};

		/** The fixture's packets with an HDR SEI spliced into the first access unit, as an encoder would. */
		const captionedLikeAnEncoder = async () => {
			using input = new Input({
				source: new FilePathSource(path.join(__dirname, '..', 'public/video-h265.mp4')),
				formats: ALL_FORMATS,
			});
			const track = (await input.getPrimaryVideoTrack())!;
			const config = (await track.getDecoderConfig())!;
			const seiNalUnit = buildSeiHdrNalUnit(HDR, 'hevc')!;

			const packets: EncodedPacket[] = [];
			const sink = new EncodedPacketSink(track);
			for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
				packets.push(packets.length === 0
					? packet.clone({ data: spliceNalUnitBeforeVcl(packet.data, config, 'hevc', seiNalUnit) })
					: packet);
			}

			return { config, packets };
		};

		const remuxTo = async (format: Mp4OutputFormat | MpegTsOutputFormat) => {
			const { config, packets } = await captionedLikeAnEncoder();
			const output = new Output({ format, target: new BufferTarget() });
			const source = new EncodedVideoPacketSource('hevc');
			output.addVideoTrack(source);
			await output.start();

			// A PQ grade, so the comparison is between two readers rather than against the ISOBMFF path's
			// transfer gate, which an SDR-signalled source closes
			const hdrConfig: VideoDecoderConfig = { ...config, colorSpace: HDR10_COLOR_SPACE };

			for (const [i, packet] of packets.entries()) {
				await source.add(packet, i === 0 ? { decoderConfig: hdrConfig } : undefined);
			}

			source.close();
			await output.finalize();

			using remuxed = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const track = (await remuxed.getPrimaryVideoTrack())!;
			return (await track.getDecoderConfig())!.hdrStaticMetadata;
		};

		test('MPEG-TS states the grade its SEI carries', async () => {
			expect(await remuxTo(new MpegTsOutputFormat())).toEqual(HDR);
		}, 60_000);

		test('and states the same grade the MP4 form of the same source does', async () => {
			const [fromTs, fromMp4] = await Promise.all([
				remuxTo(new MpegTsOutputFormat()),
				remuxTo(new Mp4OutputFormat()),
			]);

			expect(fromTs).toEqual(fromMp4);
		}, 60_000);
	});

test('an AVC HDR10 file with no mdcv / clli boxes still states the grade its SEI carries', async () => {
	const HDR: HdrStaticMetadata = {
		masteringDisplay: EXPECTED_MASTERING,
		contentLight: EXPECTED_CONTENT_LIGHT,
	};

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	expect(await track.getCodec()).toBe('avc');
	const config = (await track.getDecoderConfig())!;
	const seiNalUnit = buildSeiHdrNalUnit(HDR, 'avc')!;

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	const sink = new EncodedPacketSink(track);
	let first = true;
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		await source.add(
			first
				? packet.clone({ data: spliceNalUnitBeforeVcl(packet.data, config, 'avc', seiNalUnit) })
				: packet,
			// A PQ grade with no hdrStaticMetadata on the config, so the muxer writes no mdcv or clli and
			// the SEI in the bitstream is the only statement of it
			first ? { decoderConfig: { ...config, colorSpace: HDR10_COLOR_SPACE } } : undefined,
		);
		first = false;
	}

	source.close();
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	expect(indexOfBox(bytes, 'mdcv')).toBe(-1);
	expect(indexOfBox(bytes, 'clli')).toBe(-1);

	using remuxed = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const remuxedTrack = (await remuxed.getPrimaryVideoTrack())!;
	expect((await remuxedTrack.getDecoderConfig())!.hdrStaticMetadata).toEqual(HDR);
}, 60_000);

// HDR10+ (SMPTE ST 2094-40) rides in the bitstream as a T.35 SEI, not as frame side data we can reach:
// node-av binds the `AV_FRAME_DATA_DYNAMIC_HDR_PLUS` constant but no `av_dynamic_hdr_plus_to_t35`, and
// what `getSideData` hands back is 11304 bytes of `AVDynamicHDRPlus` struct, identical on every frame.
// So the payload is read from the SEI and written back as one. The fixture carries it on all 24 frames.
describe('HDR10+ passthrough', () => {
	beforeAll(() => {
		registerMediabunnyServer();
		useRealTransformer = true;
	});

	const SOURCE = path.join(__dirname, '../public/hdr10-plus.mp4');

	/** ffprobe's own count of frames carrying ST 2094-40, which is not this library reading its own work. */
	const hdr10PlusFrames = (file: string) => {
		const result = spawnSync(
			'ffprobe',
			['-v', 'error', '-select_streams', 'v:0', '-show_frames', file],
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
		);
		expect(result.stderr.trim()).toBe('');
		return result.stdout.split('SMPTE2094-40').length - 1;
	};

	test('the fixture really carries it, on every frame', () => {
		expect(hdr10PlusFrames(SOURCE)).toBe(24);
	});

	test('a decoded sample carries the T.35 payload', async () => {
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;

		const payloads: Uint8Array[] = [];
		for await (const sample of new VideoSampleSink(track).samples()) {
			if (sample.hdr10Plus) {
				payloads.push(sample.hdr10Plus);
			}
			sample.close();
			if (payloads.length === 4) {
				break;
			}
		}

		expect(payloads).toHaveLength(4);
		for (const payload of payloads) {
			// The T.35 header that identifies it: country 0xB5, provider 0x003C, oriented 0x0001, app id 4
			expect([...payload.subarray(0, 6)]).toEqual([0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04]);
		}
		// The payload is per-frame data, so two frames must not be byte-identical
		expect(Buffer.from(payloads[0]!).equals(Buffer.from(payloads[1]!))).toBe(false);
	}, 120_000);

	test('a sample keeps it through clone', async () => {
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;

		for await (const sample of new VideoSampleSink(track).samples()) {
			const clone = sample.clone();
			expect(clone.hdr10Plus).not.toBeNull();
			expect([...clone.hdr10Plus!]).toEqual([...sample.hdr10Plus!]);
			clone.close();
			sample.close();
			break;
		}
	}, 120_000);

	// AV1 carries the same payload in a `METADATA_TYPE_ITUT_T35` metadata OBU. `scripts/build-av1-hdr10plus-
	// fixture.py` builds the file: it parses the HEVC fixture's SEI with its own parser and injects those
	// real payloads, so what the reader is held to is not something this library wrote. The intermediate
	// AV1 is all-intra on purpose - with hidden alt-ref frames, metadata does not follow the
	// `show_existing_frame` that re-displays them and ffprobe versions then disagree on the count.
	// Measured: 11 on CI against 8 locally, which is what first made this red.
	test('an AV1 source\'s metadata OBUs are read into the same field', async () => {
		const file = path.join(__dirname, '../public/hdr10-plus-av1.mp4');
		expect(hdr10PlusFrames(file)).toBe(8);

		using input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('av1');

		const payloads: Uint8Array[] = [];
		for await (const sample of new VideoSampleSink(track).samples()) {
			if (sample.hdr10Plus) {
				payloads.push(sample.hdr10Plus);
			}
			sample.close();
		}

		expect(payloads).toHaveLength(8);
		for (const payload of payloads) {
			expect([...payload.subarray(0, 6)]).toEqual([0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04]);
			// The OBU's trailing byte is framing, not payload, and must not survive into the field
			expect(payload[payload.length - 1]).not.toBe(0x80);
		}
		expect(Buffer.from(payloads[0]!).equals(Buffer.from(payloads[1]!))).toBe(false);
	}, 120_000);

	test('an AV1 re-encode keeps it on every frame', async () => {
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { codec: 'av1', bitrate: 1_000_000, keyFrameInterval: 1 },
			audio: { discard: true },
		});
		await conversion.execute();

		const file = path.join(tmpdir(), `mediabunny-hdr10plus-av1-${process.pid}.mp4`);
		writeFileSync(file, new Uint8Array(output.target.buffer!));
		try {
			expect(hdr10PlusFrames(file)).toBe(24);
		} finally {
			rmSync(file, { force: true });
		}
	}, 300_000);

	test('an HEVC re-encode keeps it on every frame', async () => {
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { codec: 'hevc', bitrate: 1_000_000, keyFrameInterval: 1 },
			audio: { discard: true },
		});
		await conversion.execute();

		const file = path.join(tmpdir(), `mediabunny-hdr10plus-${process.pid}.mp4`);
		writeFileSync(file, new Uint8Array(output.target.buffer!));
		try {
			expect(hdr10PlusFrames(file)).toBe(24);
		} finally {
			rmSync(file, { force: true });
		}
	}, 300_000);
});
