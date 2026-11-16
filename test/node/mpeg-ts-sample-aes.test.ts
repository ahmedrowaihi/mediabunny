import { beforeAll, describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Conversion } from '../../src/conversion.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { FilePathSource, BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import { UnsupportedMediaError } from '../../src/errors.js';

beforeAll(() => {
	registerMediabunnyServer();
});

const KEY = new Uint8Array(16).fill(0x2b);
const IV = new Uint8Array(16).fill(0x11);
const SRC = './test/public/video.mp4';

const muxTs = async (sampleAesEncryption?: { key: Uint8Array; iv: Uint8Array }) => {
	using input = new Input({ source: new FilePathSource(SRC), formats: ALL_FORMATS });
	const output = new Output({
		format: new MpegTsOutputFormat(sampleAesEncryption ? { sampleAesEncryption } : {}),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec: 'avc', bitrate: 1_000_000, forceTranscode: true },
		audio: { codec: 'aac', bitrate: 128_000, forceTranscode: true },
	});
	await conversion.execute();
	return new Uint8Array(output.target.buffer!);
};

/** Reassemble the PMT from the 188-byte packets on PID 0x1000 and return its ES loop entries. */
const pmtEntries = (ts: Uint8Array) => {
	for (let offset = 0; offset + 188 <= ts.length; offset += 188) {
		const packet = ts.subarray(offset, offset + 188);
		const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
		if (pid !== 0x1000) {
			continue;
		}

		const hasAdaptation = (packet[3]! & 0x20) !== 0;
		let position = 4 + (hasAdaptation ? 1 + packet[4]! : 0);
		position += packet[position]! + 1; // pointer_field
		const sectionLength = ((packet[position + 1]! & 0x0f) << 8) | packet[position + 2]!;
		const section = packet.subarray(position, position + 3 + sectionLength);

		const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
		let cursor = 12 + programInfoLength;
		const end = section.length - 4; // before CRC_32

		const entries: { streamType: number; descriptors: Uint8Array[] }[] = [];
		while (cursor < end) {
			const streamType = section[cursor]!;
			const esInfoLength = ((section[cursor + 3]! & 0x0f) << 8) | section[cursor + 4]!;
			const info = section.subarray(cursor + 5, cursor + 5 + esInfoLength);

			const descriptors: Uint8Array[] = [];
			let d = 0;
			while (d < info.length) {
				descriptors.push(info.subarray(d, d + 2 + info[d + 1]!));
				d += 2 + info[d + 1]!;
			}

			entries.push({ streamType, descriptors });
			cursor += 5 + esInfoLength;
		}
		return entries;
	}
	throw new Error('no PMT found');
};

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

describe('MPEG-TS SAMPLE-AES', () => {
	test('the PMT signals encryption the way Apple specifies', { timeout: 300_000 }, async () => {
		const entries = pmtEntries(await muxTs({ key: KEY, iv: IV }));

		const video = entries.find(e => e.streamType === 0xdb);
		const audio = entries.find(e => e.streamType === 0xcf);
		expect(video, 'H.264 must be stream_type 0xDB').toBeDefined();
		expect(audio, 'AAC must be stream_type 0xCF').toBeDefined();

		// private_data_indicator_descriptor, tag 0x0F, big-endian four-character value
		expect(video!.descriptors).toHaveLength(1);
		expect(video!.descriptors[0]![0]).toBe(0x0f);
		expect(ascii(video!.descriptors[0]!.subarray(2))).toBe('zavc');

		expect(audio!.descriptors).toHaveLength(2);
		expect(audio!.descriptors[0]![0]).toBe(0x0f);
		expect(ascii(audio!.descriptors[0]!.subarray(2))).toBe('aacd');

		// registration_descriptor, tag 0x05: 'apad' then audio_setup_information()
		const setup = audio!.descriptors[1]!;
		expect(setup[0]).toBe(0x05);
		expect(ascii(setup.subarray(2, 6))).toBe('apad');
		expect(ascii(setup.subarray(6, 10))).toBe('zaac');
		expect(setup[10]).toBe(0x00); // priming
		expect(setup[11]).toBe(0x00);
		expect(setup[12]).toBe(0x01); // version
		expect(setup[13]).toBe(setup.length - 14); // setup_data_length covers the rest
	});

	test('a clear mux keeps the clear stream types', { timeout: 300_000 }, async () => {
		const entries = pmtEntries(await muxTs());

		expect(entries.map(e => e.streamType).sort()).toEqual([0x0f, 0x1b]);
		expect(entries.flatMap(e => e.descriptors)).toHaveLength(0);
	});

	test('the container stays clear and parseable, but the payloads do not', { timeout: 300_000 }, async () => {
		const [clear, encrypted] = await Promise.all([muxTs(), muxTs({ key: KEY, iv: IV })]);

		// Every 188-byte packet still starts with the sync byte and lands on a known PID: PES and
		// adaptation headers are untouched, so a packager can still cut and index this without the key.
		expect(encrypted.length % 188).toBe(0);
		const pids = new Set<number>();
		for (let offset = 0; offset < encrypted.length; offset += 188) {
			expect(encrypted[offset], `sync byte at packet ${offset / 188}`).toBe(0x47);
			pids.add(((encrypted[offset + 1]! & 0x1f) << 8) | encrypted[offset + 2]!);
		}
		expect(pids.has(0x0000)).toBe(true); // PAT
		expect(pids.has(0x1000)).toBe(true); // PMT

		// The elementary stream itself is not the clear one
		expect([...encrypted]).not.toEqual([...clear]);
	});

	test('our own demuxer does not silently read it as clear media', { timeout: 300_000 }, async () => {
		// 0xDB/0xCF are not the clear stream types, so a reader with no key finds no decodable track
		// rather than handing back ciphertext as if it were video.
		using input = new Input({ source: new BufferSource(await muxTs({ key: KEY, iv: IV })), formats: ALL_FORMATS });
		expect(await input.getPrimaryVideoTrack()).toBeNull();
	});

	test('a codec Apple does not specify is refused, not written in the clear', { timeout: 300_000 }, async () => {
		using input = new Input({ source: new FilePathSource(SRC), formats: ALL_FORMATS });
		const output = new Output({
			format: new MpegTsOutputFormat({ sampleAesEncryption: { key: KEY, iv: IV } }),
			target: new BufferTarget(),
		});
		const conversion = await Conversion.init({
			input,
			output,
			video: { codec: 'hevc', bitrate: 1_000_000, forceTranscode: true },
			audio: { discard: true },
		});

		await expect(conversion.execute()).rejects.toThrow(UnsupportedMediaError);
	});

	test('the key and IV must be 16 bytes', () => {
		expect(() => new MpegTsOutputFormat({ sampleAesEncryption: { key: new Uint8Array(8), iv: IV } }))
			.toThrow(TypeError);
		expect(() => new MpegTsOutputFormat({ sampleAesEncryption: { key: KEY, iv: new Uint8Array(15) } }))
			.toThrow(TypeError);
	});
});
