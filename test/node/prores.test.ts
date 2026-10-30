import { beforeAll, expect } from 'vitest';
import { registerProresDecoder } from '@mediabunny/prores';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { makeNetworkTest } from './_network-test.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MovOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

const SAMPLE_URL = 'https://pub-1ee78aacb848486482b20a72b55b3121.r2.dev/turbores-sample.mov';

// Every test here downloads SAMPLE_URL and then transmuxes or decodes it. Under a full parallel run the
// download competes with the rest of the suite for bandwidth and CPU, and 20s was not enough: the two
// transmuxing tests timed out in 3 of 4 runs while reaching the network fine (no connect errors).
const NETWORK_TIMEOUT = 60_000;
const networkTest = makeNetworkTest(NETWORK_TIMEOUT);

// Fetched once, in beforeAll rather than inside a test. Five concurrent downloads of the same file
// put the slowest past the per-test timeout often enough to make this file's red meaningless, and
// downloading inside a test puts the transfer on the same budget as the work being measured.
let sampleFileBytes: Uint8Array | null = null;
let sampleFileError: Error | null = null;
const sampleFile = () => {
	if (sampleFileError !== null) {
		// Thrown here rather than out of the hook: a hook that throws fails the file, while this reaches
		// the network guard around each test, which skips on a connect failure and fails on anything else
		throw sampleFileError;
	}

	assert(sampleFileBytes);
	return sampleFileBytes;
};

// Cached on disk: the sample never changes, and re-downloading it every run is most of this file's wall
// clock. Delete the file to force a refetch.
const CACHE_PATH = join(tmpdir(), 'mediabunny-prores-sample.mov');

beforeAll(async () => {
	if (existsSync(CACHE_PATH)) {
		sampleFileBytes = new Uint8Array(readFileSync(CACHE_PATH));
		return;
	}

	try {
		// A deadline on the request, not just on the hook: an unanswered fetch hangs rather than
		// rejecting, and a hook that times out fails the file instead of reaching the skip below
		const response = await fetch(SAMPLE_URL, { signal: AbortSignal.timeout(90_000) });
		if (!response.ok) {
			throw new Error(`Fetching the ProRes sample failed: ${response.status} ${response.statusText}`);
		}

		sampleFileBytes = new Uint8Array(await response.arrayBuffer());
		writeFileSync(CACHE_PATH, sampleFileBytes);
	} catch (error) {
		sampleFileError = error instanceof Error ? error : new Error(String(error));
	}
}, 120_000);

networkTest('ProRes MOV file reading', async () => {
	using input = new Input({
		source: new BufferSource(sampleFile()),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect(await videoTrack.getCodedWidth()).toBe(1920);
	expect(await videoTrack.getCodedHeight()).toBe(1080);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

networkTest('ProRes transmuxing into MOV', async () => {
	using input = new Input({
		source: new BufferSource(sampleFile()),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			discard: true,
		},
		trim: {
			end: 0.5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

networkTest('ProRes transmuxing into MKV', async () => {
	using input = new Input({
		source: new BufferSource(sampleFile()),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			discard: true,
		},
		trim: {
			end: 0.5,
		},
	});
	await conversion.execute();

	// No 'icpf' means the frame container atom headers were successfully stripped from the ProRes packets
	let str = new TextDecoder('ascii').decode(output.target.buffer!);
	expect(str.includes('icpf')).toBe(false);

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(videoTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	// The frame container atom headers are added back when reading out the packets
	str = new TextDecoder('ascii').decode(firstPacket.data);
	expect(str.includes('icpf')).toBe(true);
});

networkTest.serial('Custom coder registration', async () => {
	using input = new Input({
		source: new BufferSource(sampleFile()),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');

	// Without a registered decoder, there's no way to decode ProRes in this environment
	expect(await videoTrack.canDecode()).toBe(false);

	registerProresDecoder();

	expect(await videoTrack.canDecode()).toBe(true);
});

networkTest.serial('ProRes decoding', async () => {
	registerProresDecoder();

	using input = new Input({
		source: new BufferSource(sampleFile()),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const firstTimestamp = await videoTrack.getFirstTimestamp();

	const sink = new VideoSampleSink(videoTrack);
	using sample = await sink.getSample(firstTimestamp);
	assert(sample);

	expect(sample.timestamp).toBe(firstTimestamp);
	expect(sample.duration).toBeGreaterThan(0);

	expect(sample.displayWidth).toBe(1920);
	expect(sample.displayHeight).toBe(1080);
	expect(sample.codedWidth).toBe(1920);
	expect(sample.codedHeight).toBe(1080); // Technically a lie but the field is ill-defined
	expect(sample.visibleRect).toEqual({
		left: 0,
		top: 0,
		width: 1920,
		height: 1080,
	});
	expect(sample.format).toBe('I422P10');

	const allocationSize = sample.allocationSize();
	expect(allocationSize).toBeGreaterThan(0);

	const pixels = new Uint8Array(allocationSize);
	await sample.copyTo(pixels);
	expect(pixels.some(byte => byte !== 0)).toBe(true);
});
