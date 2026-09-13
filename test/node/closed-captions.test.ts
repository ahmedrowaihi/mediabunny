import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
	buildClosedCaptionSeiMessage,
	carriesClosedCaptions,
	type ClosedCaptionBytePair,
	validateClosedCaptionBytePairs,
	validateClosedCaptionsMetadata,
} from '../../src/closed-captions.js';
import {
	buildSeiNalUnit,
	iterateSeiMessages,
	iterateSeiNalUnits,
	type SeiCodec,
	spliceSeiNalUnit,
} from '../../src/sei.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { Input } from '../../src/input.js';
import {
	AdaptiveOutputFormat,
	CmafOutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
} from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, NullTarget, PathedTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = new URL('.', import.meta.url).pathname;

const CC1_POP_ON: ClosedCaptionBytePair[] = [
	{ type: 0, byte0: 0x94, byte1: 0x20 },
	{ type: 1, byte0: 0xc8, byte1: 0x49 },
];

const ASSETS: Record<SeiCodec, string> = {
	avc: 'public/video.mp4',
	hevc: 'public/video-h265.mp4',
};

// A minimal Annex B AVC access unit: AUD, SPS, PPS, then an IDR slice.
const ANNEX_B_AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);
const ANNEX_B_AVC_METADATA: EncodedVideoChunkMetadata = {
	decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 },
};

const closedCaptionSeiPayloads = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): Uint8Array[] => {
	const payloads: Uint8Array[] = [];
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, codec)) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, codec)) {
			if (payloadType === 4 && payload[0] === 0xb5) {
				payloads.push(payload);
			}
		}
	}
	return payloads;
};

describe('the ATSC A/53 caption packet', () => {
	test('lays the bytes out as ATSC A/53 Part 4 specifies', () => {
		const { payloadType, payload } = buildClosedCaptionSeiMessage(CC1_POP_ON);

		expect(payloadType).toBe(4);
		expect([...payload]).toEqual([
			0xb5, // itu_t_t35_country_code, USA
			0x00, 0x31, // itu_t_t35_provider_code, ATSC
			0x47, 0x41, 0x39, 0x34, // user_identifier, 'GA94'
			0x03, // user_data_type_code, cc_data
			0xc2, // process_em_data_flag | process_cc_data_flag, additional_data_flag 0, cc_count 2
			0xff, // em_data
			0xfc, 0x94, 0x20, // marker bits, cc_valid, cc_type 0
			0xfd, 0xc8, 0x49, // marker bits, cc_valid, cc_type 1
			0xff, // marker_bits
		]);
	});

	test('states a cc_count that matches the pairs it carries', () => {
		for (const count of [1, 7, 31]) {
			const pairs = Array.from({ length: count }, () => CC1_POP_ON[0]!);
			const { payload } = buildClosedCaptionSeiMessage(pairs);

			expect(payload[8]! & 0x1f).toBe(count);
			// 8-byte ATSC header, the flags byte, em_data, the pairs, then the trailing marker byte.
			expect(payload.length).toBe(11 + count * 3);
		}
	});

	test('is found behind another SEI message in the same NAL unit', () => {
		const filler = { payloadType: 5, payload: new Uint8Array(16).fill(0x11) };
		const captions = buildClosedCaptionSeiMessage(CC1_POP_ON);
		const seiNalUnit = buildSeiNalUnit([filler, captions], 'avc')!;

		const walked = [...iterateSeiMessages(seiNalUnit, 'avc')];
		expect(walked.map(message => message.payloadType)).toEqual([5, 4]);
		expect([...walked[1]!.payload]).toEqual([...captions.payload]);

		const packet = spliceIntoAnnexB(ANNEX_B_AVC_PACKET, seiNalUnit);
		expect(carriesClosedCaptions(packet, { codec: 'avc1.4d401e' }, 'avc')).toBe(true);
	});

	test('refuses caption data an ATSC caption packet cannot state', () => {
		expect(() => validateClosedCaptionBytePairs([], 'meta.closedCaptions'))
			.toThrow(/must be a non-empty array/);
		expect(() => validateClosedCaptionBytePairs(
			Array.from({ length: 32 }, () => CC1_POP_ON[0]!),
			'meta.closedCaptions',
		)).toThrow(/at most 31/);
		expect(() => validateClosedCaptionBytePairs(
			[{ type: 4 as 0, byte0: 0, byte1: 0 }],
			'meta.closedCaptions',
		)).toThrow(/cc_type/);
		expect(() => validateClosedCaptionBytePairs(
			[{ type: 0, byte0: 256, byte1: 0 }],
			'meta.closedCaptions',
		)).toThrow(/byte0/);
		expect(() => validateClosedCaptionBytePairs(
			[{ type: 0, byte0: 0, byte1: -1 }],
			'meta.closedCaptions',
		)).toThrow(/byte1/);
	});

	test('refuses a track declaration that cannot be announced', () => {
		expect(() => validateClosedCaptionsMetadata(
			{ channels: [], announceInManifest: true },
			'metadata.closedCaptions',
		)).toThrow(/non-empty array/);
		expect(() => validateClosedCaptionsMetadata(
			{ channels: ['CC1', 'CC1'], announceInManifest: true },
			'metadata.closedCaptions',
		)).toThrow(/must not repeat/);
		expect(() => validateClosedCaptionsMetadata(
			{ channels: ['CC5' as 'CC1'], announceInManifest: true },
			'metadata.closedCaptions',
		)).toThrow(/Invalid CEA-608 channel/);
		expect(() => validateClosedCaptionsMetadata(
			{ channels: ['CC1'], announceInManifest: undefined as unknown as boolean },
			'metadata.closedCaptions',
		)).toThrow(/announceInManifest must be a boolean/);
	});
});

describe('the captions reach the bitstream', () => {
	// Enough access units to prove the claim; the fixtures run far longer than the claim needs.
	const REMUX_PACKET_LIMIT = 30;

	const remux = async (codec: SeiCodec, options: { captions: boolean }) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', ASSETS[codec])),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource(codec);
		output.addVideoTrack(source, options.captions
			? { closedCaptions: { channels: ['CC1'], announceInManifest: true } }
			: {});
		await output.start();

		const sink = new EncodedPacketSink(track);
		let first = true;
		let remaining = REMUX_PACKET_LIMIT;

		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			await source.add(
				new EncodedPacket(packet.data, packet.type, packet.timestamp, packet.duration),
				{
					...(first ? { decoderConfig: config } : {}),
					...(options.captions ? { closedCaptions: CC1_POP_ON } : {}),
				},
			);
			first = false;
			if (--remaining === 0) {
				break;
			}
		}

		await output.finalize();
		return output.target.buffer!;
	};

	const readPackets = async (buffer: ArrayBuffer) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;
		const sink = new EncodedPacketSink(track);
		const packets: EncodedPacket[] = [];
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			packets.push(packet);
		}
		return { config, packets };
	};

	for (const codec of ['avc', 'hevc'] as const) {
		test(`every ${codec} access unit states exactly one caption packet`, async () => {
			const { config, packets } = await readPackets(await remux(codec, { captions: true }));
			const expected = buildClosedCaptionSeiMessage(CC1_POP_ON).payload;

			expect(packets.length).toBeGreaterThan(1);
			for (const packet of packets) {
				const payloads = closedCaptionSeiPayloads(packet.data, config, codec);
				expect(payloads).toHaveLength(1);
				expect([...payloads[0]!]).toEqual([...expected]);
			}
		});

		test(`a ${codec} file without captions does not gain a single byte`, async () => {
			const withCaptions = await remux(codec, { captions: true });
			const without = await remux(codec, { captions: false });

			expect(without.byteLength).toBeLessThan(withCaptions.byteLength);
		});
	}

	test('the caption SEI precedes the first slice, so in-band parameter sets still come first', () => {
		const seiNalUnit = buildSeiNalUnit([buildClosedCaptionSeiMessage(CC1_POP_ON)], 'avc')!;
		const spliced = spliceIntoAnnexB(ANNEX_B_AVC_PACKET, seiNalUnit);

		const types = [...annexBNalUnitTypes(spliced)];
		expect(types).toEqual([9, 7, 8, 6, 5]);
	});
});

const annexBNalUnitTypes = function* (data: Uint8Array): Generator<number> {
	for (let i = 0; i + 3 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
			yield data[i + 3]! & 0x1f;
		}
	}
};

// `spliceSeiNalUnit` reads the framing off the decoder config; no description means Annex B.
const spliceIntoAnnexB = (packetData: Uint8Array, seiNalUnit: Uint8Array): Uint8Array =>
	spliceSeiNalUnit(packetData, { codec: 'avc1.4d401e' }, 'avc', seiNalUnit);

describe('captions the caller supplied are never dropped, and never claimed when absent', () => {
	const startAnnexBOutput = async (closedCaptions?: { channels: ['CC1']; announceInManifest: boolean }) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, closedCaptions ? { closedCaptions } : {});
		await output.start();
		return { output, source };
	};

	test('refuses caption bytes the track never declared', async () => {
		const { output, source } = await startAnnexBOutput();

		expect(() => source.add(
			new EncodedPacket(ANNEX_B_AVC_PACKET, 'key', 0, 0.04),
			{ ...ANNEX_B_AVC_METADATA, closedCaptions: CC1_POP_ON },
		)).toThrow(/does not declare metadata\.closedCaptions/);

		await output.cancel();
	});

	test('refuses to finalize a declared track that never carried captions', async () => {
		const { output, source } = await startAnnexBOutput({ channels: ['CC1'], announceInManifest: true });

		await source.add(new EncodedPacket(ANNEX_B_AVC_PACKET, 'key', 0, 0.04), ANNEX_B_AVC_METADATA);

		await expect(output.finalize()).rejects.toThrow(/no packet supplied any caption bytes/);
	});

	test('refuses to write a second caption packet into an access unit that already has one', async () => {
		const { output, source } = await startAnnexBOutput({ channels: ['CC1'], announceInManifest: true });

		const seiNalUnit = buildSeiNalUnit([buildClosedCaptionSeiMessage(CC1_POP_ON)], 'avc')!;
		const alreadyCaptioned = spliceIntoAnnexB(ANNEX_B_AVC_PACKET, seiNalUnit);
		expect(carriesClosedCaptions(alreadyCaptioned, { codec: 'avc1.4d401e' }, 'avc')).toBe(true);

		expect(() => source.add(
			new EncodedPacket(alreadyCaptioned, 'key', 0, 0.04),
			{ ...ANNEX_B_AVC_METADATA, closedCaptions: CC1_POP_ON },
		)).toThrow(/already states a caption SEI message/);

		await output.cancel();
	});

	for (const singleFilePerPlaylist of [false, true]) {
		test(
			`captions sitting in one segment still finalize, singleFilePerPlaylist ${singleFilePerPlaylist}`,
			async () => {
				const output = new Output({
					format: new HlsOutputFormat({
						segmentFormat: new CmafOutputFormat(),
						targetDuration: 1,
						singleFilePerPlaylist,
					}),
					target: new PathedTarget('master.m3u8', () => new NullTarget()),
				});

				const source = new EncodedVideoPacketSource('avc');
				output.addVideoTrack(source, {
					closedCaptions: { channels: ['CC1'], announceInManifest: true },
				});
				await output.start();

				for (const timestamp of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
					await source.add(
						new EncodedPacket(
							ANNEX_B_AVC_PACKET,
							timestamp % 1 === 0 ? 'key' : 'delta',
							timestamp,
							0.5,
						),
						timestamp === 0
							? { ...ANNEX_B_AVC_METADATA, closedCaptions: CC1_POP_ON }
							: undefined,
					);
				}

				await expect(output.finalize()).resolves.toBeUndefined();
			},
		);
	}

	test('refuses a caption declaration on a codec with no SEI to carry it', () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

		expect(() => output.addVideoTrack(new EncodedVideoPacketSource('vp9'), {
			closedCaptions: { channels: ['CC1'], announceInManifest: true },
		})).toThrow(/has no bitstream that can carry them/);

		expect(() => output.addAudioTrack(new EncodedAudioPacketSource('aac'))).not.toThrow();
	});

	test('a packet without caption bytes is passed through untouched', async () => {
		const { output, source } = await startAnnexBOutput({ channels: ['CC1'], announceInManifest: true });

		await source.add(
			new EncodedPacket(ANNEX_B_AVC_PACKET, 'key', 0, 0.04),
			{ ...ANNEX_B_AVC_METADATA, closedCaptions: CC1_POP_ON },
		);
		await source.add(new EncodedPacket(ANNEX_B_AVC_PACKET, 'delta', 0.04, 0.04), undefined);

		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;
		const sink = new EncodedPacketSink(track);

		const first = (await sink.getFirstPacket())!;
		const second = (await sink.getNextPacket(first))!;

		expect(closedCaptionSeiPayloads(first.data, config, 'avc')).toHaveLength(1);
		expect(closedCaptionSeiPayloads(second.data, config, 'avc')).toHaveLength(0);
	});
});

describe('the manifests announce the captions only when told to', () => {
	const emitManifests = async (announceInManifest: boolean | null) => {
		const files = new Map<string, string>();
		const shared = { segmentFormat: new MpegTsOutputFormat(), targetDuration: 2 };

		const output = new Output({
			format: new AdaptiveOutputFormat({
				formats: [
					new HlsOutputFormat({ ...shared }),
					new DashOutputFormat({ ...shared, mpdPath: 'master.mpd' }),
				],
			}),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new TextDecoder().decode(target.buffer!)));
				return target;
			}),
		});

		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, announceInManifest === null
			? {}
			: { closedCaptions: { channels: ['CC1', 'CC3'], announceInManifest } });

		await output.start();

		for (const timestamp of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
			await source.add(
				new EncodedPacket(ANNEX_B_AVC_PACKET, timestamp % 2 === 0 ? 'key' : 'delta', timestamp, 0.5),
				{
					...(timestamp === 0 ? ANNEX_B_AVC_METADATA : {}),
					...(announceInManifest === null ? {} : { closedCaptions: CC1_POP_ON }),
				},
			);
		}

		await output.finalize();
		return { master: files.get('master.m3u8')!, mpd: files.get('master.mpd')! };
	};

	test('announces every declared channel when the caller asked for it', async () => {
		const { master, mpd } = await emitManifests(true);

		expect(master).toContain('#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"');
		expect(master).toContain('#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC3",INSTREAM-ID="CC3"');
		expect(master).toContain('CLOSED-CAPTIONS="cc"');
		expect(mpd).toContain('schemeIdUri="urn:scte:dash:cc:cea-608:2015"');
		expect(mpd).toContain('value="CC1;CC3"');
	});

	test('stays silent when the caller asked it to, though the bitstream still carries them', async () => {
		const { master, mpd } = await emitManifests(false);

		expect(master).not.toContain('CLOSED-CAPTIONS');
		expect(mpd).not.toContain('cea-608');
	});

	test('says nothing at all about a track that carries no captions', async () => {
		const { master, mpd } = await emitManifests(null);

		expect(master).not.toContain('CLOSED-CAPTIONS');
		expect(mpd).not.toContain('cea-608');
	});

	test('an announced variant with no playlist still writes a valid master', async () => {
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
			target: new PathedTarget('', () => new NullTarget()),
		});

		expect(() => output.addVideoTrack(new EncodedVideoPacketSource('hevc'), {
			closedCaptions: { channels: ['CC4'], announceInManifest: false },
		})).not.toThrow();
	});
});
