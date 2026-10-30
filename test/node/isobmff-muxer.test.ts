import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, HlsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert, toDataView } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { getInitSegmentTimescales, iterateIsobmffBoxes } from '../../src/isobmff/isobmff-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const originalVideoSink = new EncodedPacketSink(videoTrack);
	const originalTimestamps: number[] = [];
	for await (const packet of originalVideoSink.packets()) {
		originalTimestamps.push(packet.timestamp);
	}

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(originalTimestamps);
});

test('Zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);
});

test('Non-zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') && str.includes('elst')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Non-zero start timestamp, fragmented MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Negative start timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, false);
});

test('Negative start timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, true);
});

test('Wholly negative timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, false);
});

test('Wholly negative timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, true);
});

const testNegativeTimestampRoundTrip = async (
	timestamps: number[],
	duration: number,
	fragmented: boolean,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : false }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate: 10 });

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const inputPackets = timestamps.map((timestamp, index) => new EncodedPacket(
		new Uint8Array(1024).fill(index),
		'key',
		timestamp,
		duration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(inputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	})));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual({
			timestamp: inputPacket.timestamp,
			duration: inputPacket.duration,
		});
	}
};

test('PCM audio', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test('PCM audio with non-zero timestamp', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(1);
});

test('PCM audio, silence padding', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 48000 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

test('PCM audio, no silence padding with approximate timestamps', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	// 0.006 is 256/48000 "rounded up", but it's close enough for silence padding not to kick in
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0.006, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 256 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

// https://github.com/Vanilagy/mediabunny/pull/391
test('At least one track is enabled even if all are added disabled', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	const source1 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source1, { disposition: { default: false } });

	const source2 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source2, { disposition: { default: false } });

	await output.start();

	await source1.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source2.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks.length).toBe(2);

	// Even though both tracks were added disabled, the muxer forces the first one to be enabled
	expect((await tracks[0]!.getDisposition()).default).toBe(true);
	expect((await tracks[1]!.getDisposition()).default).toBe(false);
});

test('btrt boxes computed from packet sizes, regular MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat());
	const boxes = findBtrtBoxes(bytes);

	expect(boxes).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 3275296,
			avgBitrate: 2858330,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 318224,
			avgBitrate: 317375,
		},
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getBitrate()).toBe(3275296);
	expect(await videoTrack.getAverageBitrate()).toBe(2858330);
	expect(await audioTrack.getBitrate()).toBe(318224);
	expect(await audioTrack.getAverageBitrate()).toBe(317375);
});

test('btrt boxes copied from input metadata in conversion, fragmented MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat({ fastStart: 'fragmented' }));

	// These are equal to what was in the input file
	expect(findBtrtBoxes(bytes)).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 2858329,
			avgBitrate: 2858329,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 320000,
			avgBitrate: 317375,
		},
	]);
});

test('No btrt boxes, fragmented MP4 without bitrate metadata', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource((await audioTrack.getCodec())!);
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();

	const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: (await audioTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([]);
});

const copyVideoMp4 = async (format: Mp4OutputFormat) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

const findBtrtBoxes = (bytes: Uint8Array) => {
	const view = toDataView(bytes);
	const boxes: { bufferSizeDB: number; maxBitrate: number; avgBitrate: number }[] = [];

	for (let i = 0; i < bytes.length - 4; i++) {
		if (bytes[i] !== 0x62 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x72 || bytes[i + 3] !== 0x74) {
			continue;
		}

		const boxSize = view.getUint32(i - 4);
		expect(boxSize).toBe(20);

		boxes.push({
			bufferSizeDB: view.getUint32(i + 4),
			maxBitrate: view.getUint32(i + 8),
			avgBitrate: view.getUint32(i + 12),
		});
	}

	return boxes;
};

test('Chunks written in chronological order, no Fast Start', async () => {
	await testChunkOrder(false);
});

test('Chunks written in chronological order, in-memory Fast Start', async () => {
	await testChunkOrder('in-memory');
});

test('Chunks written in chronological order, reserved Fast Start', async () => {
	await testChunkOrder('reserve');
});

const testChunkOrder = async (fastStart: false | 'in-memory' | 'reserve') => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 1000 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 1000 });

	await output.start();

	// Add all video before all audio, so the muxer can't just write chunks in the order they complete
	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	for (let i = 0; i < 150; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), i === 0 ? 'key' : 'delta', i / 30, 1 / 30);
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	for (let i = 0; i < 200; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), 'key', 0.01 + 1152 * i / 48000, 1152 / 48000);
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	// Packet data read from a BufferSource is a view into the file, so its byte offset is its position in the file
	const packets: { trackIndex: number; timestamp: number; offset: number }[] = [];
	const tracks = await input.getTracks();
	for (let i = 0; i < tracks.length; i++) {
		for await (const packet of new EncodedPacketSink(tracks[i]!).packets()) {
			packets.push({
				trackIndex: i,
				timestamp: packet.timestamp,
				offset: packet.data.byteOffset,
			});
		}
	}

	expect(packets).toHaveLength(350);
	const packetsInFileOrder = packets.sort((a, b) => a.offset - b.offset);

	const chunkStartTimestamps: number[] = [];
	for (let i = 0; i < packetsInFileOrder.length; i++) {
		if (i === 0 || packetsInFileOrder[i]!.trackIndex !== packetsInFileOrder[i - 1]!.trackIndex) {
			chunkStartTimestamps.push(packetsInFileOrder[i]!.timestamp);
		}
	}

	expect(chunkStartTimestamps.length).toBeGreaterThan(10);
	expect(chunkStartTimestamps).toEqual([...chunkStartTimestamps].sort((a, b) => a - b));
};

test('Reserved Fast Start rejects a maximum packet count beyond u32', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});
	output.addVideoTrack(new EncodedVideoPacketSource('vp8'), { maximumPacketCount: 2 ** 32 });

	await expect(output.start()).rejects.toThrow('exceeds the maximum');
});

// This used to cause an assertion failure in the box writing code
test('Reserved Fast Start with a B-frame GOP completed before all tracks are known', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 100 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 100 });

	await output.start();

	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const videoTimestamps = [0, 0.2, 0.1, 0.3];
	for (let i = 0; i < videoTimestamps.length; i++) {
		const type = i === 0 || i === 3 ? 'key' : 'delta';
		await videoSource.add(new EncodedPacket(new Uint8Array(8), type, videoTimestamps[i]!, 0.1), videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	await audioSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1152 / 48000), audioMeta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(videoTimestamps);
});

test('Fragmented MP4 preserves interior key packets', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 10 }),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 6; i++) {
		await source.add(new EncodedPacket(new Uint8Array(1), i % 2 === 0 ? 'key' : 'delta', i, 1), {
			decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 },
		});
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const first = await sink.getFirstKeyPacket({ metadataOnly: true });
	assert(first);

	expect((await sink.getNextKeyPacket(first, { metadataOnly: true }))?.timestamp).toBe(2);
	expect((await sink.getKeyPacket(4.1, { metadataOnly: true }))?.timestamp).toBe(4);
});

const muxWithCreationTime = async (creationTime: Date) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	await (await Conversion.init({ input, output, tags: { creationTime } })).execute();
	return new Uint8Array(output.target.buffer!);
};

test('creationTime is written into the container and makes muxing reproducible', { timeout: 30_000 }, async () => {
	const early = new Date('2020-01-01T00:00:00Z');
	const [first, second] = [await muxWithCreationTime(early), await muxWithCreationTime(early)];
	const late = await muxWithCreationTime(new Date('2021-06-15T12:00:00Z'));

	// Equality alone would also hold if the option were ignored and both runs landed in the same
	// wall-clock second, so a second date is what proves the value reaches the file.
	expect(second).toEqual(first);
	expect(late).not.toEqual(first);
});

test('creationTime rejects a value that would write a garbage timestamp', () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	expect(() => output.setMetadataTags({ creationTime: new Date('nope') })).toThrow(/valid Date/);
});

// Regression: two concurrent encoders finishing in a different order must not change the file. Before the
// non-fragmented path queued its samples, chunks were written on arrival, so one audio and one video chunk
// could swap places around a chunk boundary — byte-identical media laid out two different ways.
const twoTrackMp4 = async (arrival: 'ordered' | 'videoRunsAhead') => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	// Pinned: the default creation time is `new Date()` floored to whole seconds, so two outputs made
	// moments apart differ by a second whenever they straddle one, and this comparison is byte-exact.
	output.setMetadataTags({ creationTime: new Date('2026-01-01T00:00:00Z') });
	const video = new EncodedVideoPacketSource('vp8');
	const audio = new EncodedAudioPacketSource('pcm-s16');
	output.addVideoTrack(video);
	output.addAudioTrack(audio);
	await output.start();

	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 240 } };
	const audioMeta = { decoderConfig: { codec: 'pcm-s16', sampleRate: 44100, numberOfChannels: 1 } };
	const videoPacket = (i: number) =>
		new EncodedPacket(new Uint8Array(1024).fill(i & 0xff), i % 10 === 0 ? 'key' : 'delta', i * 0.1, 0.1);
	const audioPacket = (i: number) =>
		new EncodedPacket(new Uint8Array(512).fill(i & 0xff), 'key', i * 0.1, 0.1);

	const count = 40;
	if (arrival === 'ordered') {
		for (let i = 0; i < count; i++) {
			await video.add(videoPacket(i), i === 0 ? videoMeta : undefined);
			await audio.add(audioPacket(i), i === 0 ? audioMeta : undefined);
		}
	} else {
		// The video encoder gets a long way ahead before the audio encoder delivers anything
		await video.add(videoPacket(0), videoMeta);
		await audio.add(audioPacket(0), audioMeta);
		for (let i = 1; i < count; i++) {
			await video.add(videoPacket(i));
		}
		for (let i = 1; i < count; i++) {
			await audio.add(audioPacket(i));
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

test('Non-fragmented output is byte-identical regardless of the order tracks deliver samples in', async () => {
	const ordered = await twoTrackMp4('ordered');
	const videoAhead = await twoTrackMp4('videoRunsAhead');

	expect(videoAhead.length).toBe(ordered.length);
	// Named offset and hashes, so one failure is enough to diagnose rather than `false to be true`.
	const differsAt = ordered.findIndex((byte, i) => byte !== videoAhead[i]);
	if (differsAt !== -1) {
		const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
		expect.fail(
			`differ at byte ${differsAt}: ordered=0x${ordered[differsAt]!.toString(16)}`
			+ ` videoAhead=0x${videoAhead[differsAt]!.toString(16)};`
			+ ` sha256 ${digest(ordered)} vs ${digest(videoAhead)}`,
		);
	}
});

// A minimal Annex B AVC access unit: AUD, SPS, PPS, then an IDR slice.
const AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);

// A player reads a fragment's presentation times as tfdt's baseMediaDecodeTime plus each sample's trun
// composition offset. Reading them back through this library's own demuxer instead hides a shift between the
// two, because the demuxer applies the edit list that a progressive file carries and a fragment does not.
const firstPresentationTime = (segment: Uint8Array, timescale: number) => {
	// A holder, because a value a closure assigns is narrowed away at the read below
	const found: { baseMediaDecodeTime: number | null; compositionOffset: number | null } = {
		baseMediaDecodeTime: null,
		compositionOffset: null,
	};

	const walk = (data: Uint8Array) => {
		for (const box of iterateIsobmffBoxes(data)) {
			const content = box.start + box.headerSize;
			const view = toDataView(data);

			if (box.type === 'moof' || box.type === 'traf') {
				walk(data.subarray(content, box.start + box.size));
			} else if (box.type === 'tfdt') {
				found.baseMediaDecodeTime ??= view.getUint8(content) === 1
					? Number(view.getBigUint64(content + 4))
					: view.getUint32(content + 4);
			} else if (box.type === 'trun') {
				const version = view.getUint8(content);
				const flags = (view.getUint8(content + 1) << 16)
					| (view.getUint8(content + 2) << 8)
					| view.getUint8(content + 3);

				let pos = content + 8;
				for (const [flag, size] of [[0x1, 4], [0x4, 4], [0x100, 4], [0x200, 4], [0x400, 4]] as const) {
					if (flags & flag) {
						pos += size;
					}
				}

				found.compositionOffset ??= flags & 0x800
					// Signed only in version 1; version 0 cannot state a frame presented before its own decode
					? (version === 1 ? view.getInt32(pos) : view.getUint32(pos))
					: 0;
			}
		}
	};
	walk(segment);

	assert(found.baseMediaDecodeTime !== null);
	assert(found.compositionOffset !== null);

	return (found.baseMediaDecodeTime + found.compositionOffset) / timescale;
};

test('each CMAF segment presents from its own key frame, not from the reorder delay past it', async () => {
	// What libx264 emits for a 2-frame reorder at 25 fps: the key frame presents first but decodes 0.08 s
	// before it, so every frame's decode time sits below its presentation time.
	const frames: { pts: number; dts: number; type: 'key' | 'delta' }[] = [];
	for (let gop = 0; gop < 3; gop++) {
		const reordered = [0, 0.16, 0.08, 0.04, 0.2, 0.12];
		for (const [index, offset] of reordered.entries()) {
			frames.push({
				pts: gop * 2 + offset,
				dts: gop * 2 - 0.08 + index * 0.04,
				type: index === 0 ? 'key' : 'delta',
			});
		}
		for (let offset = 0.24; offset < 2; offset += 0.04) {
			frames.push({ pts: gop * 2 + offset, dts: gop * 2 + offset, type: 'delta' });
		}
	}
	frames.sort((a, b) => a.dts - b.dts);

	const segments: Uint8Array[] = [];
	let initSegment: Uint8Array | null = null;

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 2 }),
		target: new PathedTarget('index.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				const bytes = new Uint8Array(target.buffer!);
				if (/init/.test(request.path)) {
					initSegment = bytes;
				} else if (/\.m4s$/.test(request.path)) {
					segments.push(bytes);
				}
			});
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	for (const [index, frame] of frames.entries()) {
		await source.add(
			new EncodedPacket(AVC_PACKET, frame.type, frame.pts, 0.04, undefined, undefined, undefined, frame.dts),
			index === 0
				? { decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 } }
				: undefined,
		);
	}

	await output.finalize();

	assert(initSegment !== null);
	const timescale = [...getInitSegmentTimescales(initSegment).values()][0]!;
	expect(segments).toHaveLength(3);

	// The media timeline is based at HLS's own offset, so the key frames present 2 s apart from there
	const first = firstPresentationTime(segments[0]!, timescale);
	expect(segments.map(segment => Math.round((firstPresentationTime(segment, timescale) - first) * 1000)))
		.toEqual([0, 2000, 4000]);

	// And the first segment starts exactly on its key frame: stating the chunk's lowest presentation time as
	// its baseMediaDecodeTime put every segment one reorder delay late, 0.08 s here.
	expect(Math.round(first * 1000) % 2000).toBe(0);
}, 60_000);

// A packet may state its own decode timestamp, and then the muxer writes that timeline rather than
// deriving one from presentation order. Nothing checked that the stated times were in decode order, so a
// caller that rebuilt packets and restated each presentation timestamp as the decode timestamp - which on
// a reordered stream runs backwards - got a bare `Assertion failed` out of `finalize`, naming nothing.
//
// It throws rather than repairing the order: the stated timeline is the caller's claim about how the
// media decodes, and silently resorting it would write a file whose timing is not the one asked for.
test('decode timestamps that go backwards are named, not asserted', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === 4) {
			break;
		}
	}

	// Same packets, each stating a decode timestamp earlier than the one before
	for (const [index, packet] of packets.entries()) {
		await source.add(
			new EncodedPacket(
				packet.data,
				packet.type,
				packet.timestamp,
				packet.duration,
				packet.sequenceNumber,
				undefined,
				undefined,
				(packets.length - index) / 30,
			),
			{ decoderConfig: config },
		);
	}

	const thrown = await output.finalize().then(() => null, (error: unknown) => error as Error);
	expect(thrown).toBeInstanceOf(Error);
	expect(thrown!.message).not.toMatch(/Assertion failed/);
	expect(thrown!.message).toMatch(/Decode timestamps must not go backwards/);
	// The three numbers a caller needs to find the offending packet
	expect(thrown!.message).toMatch(/presenting at [-0-9.]+s/);
	expect(thrown!.message).toMatch(/states a decode timestamp of [-0-9.]+s/);
	expect(thrown!.message).toMatch(/before the previous packet's [-0-9.]+s/);
}, 60_000);
