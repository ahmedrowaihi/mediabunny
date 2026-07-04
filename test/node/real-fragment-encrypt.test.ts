import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { AesPatternCryptor } from '../../src/crypto/aes-pattern-cryptor.js';
import { encryptFragment } from '../../src/crypto/fragment-encryptor.js';
import type { EncryptionCodec, SubsampleEntry } from '../../src/crypto/subsample-generator.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { FilePathSource } from '../../src/source.js';

const __dirname = new URL('.', import.meta.url).pathname;
const publicPath = (name: string) => path.join(__dirname, '../public', name);

const KEY = new Uint8Array(16).fill(0x2b);
const IV = new Uint8Array(16).fill(0x11);

const decryptSample = (
	data: Uint8Array, subsamples: SubsampleEntry[], cryptByteBlock: number, skipByteBlock: number,
): Uint8Array => {
	const cryptor = new AesPatternCryptor(
		cryptByteBlock, skipByteBlock, 'encryptIfCryptByteBlockRemaining', true, new AesCbcDecryptor(),
	);
	cryptor.initializeWithIv(KEY, new Uint8Array(16));
	cryptor.setIv(IV);
	const out = new Uint8Array(data.length);
	if (subsamples.length === 0) {
		out.set(cryptor.crypt(data));
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		out.set(data.subarray(offset, offset + clearBytes), offset);
		offset += clearBytes;
		if (cipherBytes > 0) {
			out.set(cryptor.crypt(data.subarray(offset, offset + cipherBytes)), offset);
			offset += cipherBytes;
		}
	}
	return out;
};

const readVideo = async (file: string) => {
	using input = new Input({ source: new FilePathSource(publicPath(file)), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const codecConfig = new Uint8Array(config.description!);
	const codec: EncryptionCodec = (config.codec ?? '').startsWith('avc') ? 'avc' : 'hevc';
	// lengthSizeMinusOne lives at byte 4 in avcC but byte 21 in hvcC.
	const lengthSizeByte = (codec === 'avc' ? codecConfig[4] : codecConfig[21]) ?? 0;
	const naluLengthSize = ((lengthSizeByte & 0x03) + 1) as 1 | 2 | 4;

	const sink = new EncodedPacketSink(track);
	const samples: Uint8Array[] = [];
	for await (const packet of sink.packets()) {
		samples.push(packet.data);
	}
	return { samples, codec, codecConfig, naluLengthSize };
};

describe('encrypt real CMAF fragments (via the fork demuxer + real slice-header parsers)', () => {
	// The end-to-end proof: real fMP4 video samples encrypted with the real H.264/H.265
	// slice-header parsers, then decrypted back to the original bytes.
	for (const file of ['video.mp4', 'video-h265.mp4']) {
		test(`${file}: every real sample encrypts (headers clear) and round-trips`, async () => {
			const { samples, codec, codecConfig, naluLengthSize } = await readVideo(file);
			expect(samples.length).toBeGreaterThan(0);

			const result = encryptFragment({
				samples,
				streamInfo: { codec, codecConfig, naluLengthSize },
				streamType: 'video',
				key: KEY,
				iv: IV,
			});

			// The real slice-header parser produced a genuine clear leader + protected region.
			const anyEncrypted = result.subsamplesPerSample.some(
				subs => subs.some(s => s.cipherBytes > 0),
			);
			expect(anyEncrypted).toBe(true);
			// The clear leader is the length prefix + NAL/slice header (> just the length prefix).
			const firstVideoSlice = result.subsamplesPerSample.find(subs => subs.some(s => s.cipherBytes > 0))!;
			expect(firstVideoSlice[0]!.clearBytes).toBeGreaterThan(naluLengthSize);

			// Every real sample round-trips exactly.
			for (let i = 0; i < samples.length; i++) {
				const roundTripped = decryptSample(result.encryptedSamples[i]!, result.subsamplesPerSample[i]!, 1, 9);
				expect([...roundTripped]).toEqual([...samples[i]!]);
			}
		});
	}
});
