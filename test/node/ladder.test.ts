import { beforeAll, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { InvalidUsageError } from '../../src/errors.js';
import { encodeVideoLadder } from '../../src/ladder.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { FilePathSource, BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

beforeAll(() => {
	registerMediabunnyServer();
});

const LADDER = [
	{ width: 1280, height: 720, bitrate: 3_000_000 },
	{ width: 854, height: 480, bitrate: 1_200_000 },
	{ width: 426, height: 240, bitrate: 400_000 },
];

const makeRungs = () => LADDER.map(rung => ({
	output: new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() }),
	video: {
		codec: 'avc' as const,
		bitrate: rung.bitrate,
		transform: { width: rung.width, height: rung.height, fit: 'fill' as const },
	},
}));

const describeRendition = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();

	const sink = new EncodedPacketSink(track!);
	const keyTimestamps: number[] = [];
	let packet = await sink.getFirstPacket({ metadataOnly: true });
	let packetCount = 0;

	while (packet) {
		packetCount++;
		if (packet.type === 'key') {
			keyTimestamps.push(Number(packet.timestamp.toFixed(4)));
		}
		packet = await sink.getNextPacket(packet, { metadataOnly: true });
	}

	return {
		size: `${await track!.getDisplayWidth()}x${await track!.getDisplayHeight()}`,
		keyTimestamps,
		packetCount,
	};
};

// Also the regression test for frames being fanned out to more than one scaling encoder: the filter
// graph in transformVideoSample unrefs the frame it is handed, so handing it the decoded sample's own
// frame emptied it for every other rendition. With three rungs this threw "Failed to create filter"
// before the fix.
test('a ladder gives every rendition the same key frames', { timeout: 300_000 }, async () => {
	using input = new Input({ source: new FilePathSource('./test/public/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();

	const rungs = makeRungs();
	await encodeVideoLadder({ track: track!, rungs, keyFrameInterval: 1 });

	const renditions = await Promise.all(
		rungs.map(rung => describeRendition(new Uint8Array((rung.output.target).buffer!))),
	);

	expect(renditions.map(r => r.size)).toEqual(['1280x720', '854x480', '426x240']);

	for (const rendition of renditions) {
		expect(rendition.keyTimestamps).toEqual(renditions[0]!.keyTimestamps);
		expect(rendition.packetCount).toBe(renditions[0]!.packetCount);
	}

	expect(renditions[0]!.keyTimestamps.length).toBeGreaterThan(1);
});

test('a rung may not set its own key frame interval', async () => {
	using input = new Input({ source: new FilePathSource('./test/public/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();

	const rungs = makeRungs().map(rung => ({ ...rung, video: { ...rung.video, keyFrameInterval: 4 } }));

	await expect(encodeVideoLadder({ track: track!, rungs })).rejects.toThrow(InvalidUsageError);
});

test('an aborted ladder cancels every output', async () => {
	using input = new Input({ source: new FilePathSource('./test/public/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();

	const rungs = makeRungs();
	const controller = new AbortController();
	controller.abort(new Error('nope'));

	await expect(encodeVideoLadder({ track: track!, rungs, signal: controller.signal })).rejects.toThrow('nope');
});
