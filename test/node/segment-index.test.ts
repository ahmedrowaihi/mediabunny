import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { segmentIndexOf, muxSegment } from '../../src/segment-index.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

const __dirname = new URL('.', import.meta.url).pathname;
// 5 seconds with a sync sample every second, so the cuts are actually exercised; video.mp4 has a single
// key packet and would make every boundary assertion trivially true.
const progressive = () => new FilePathSource(path.join(__dirname, '../public/demo.mp4'));

const keyTimestamps = async (input: Input) => {
	const track = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(track);
	const times: number[] = [];
	let packet = await sink.getFirstKeyPacket();
	while (packet) {
		times.push(packet.timestamp);
		packet = await sink.getNextKeyPacket(packet);
	}
	return times;
};

describe('segmentIndexOf', () => {
	test('cuts only on sync samples', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		const syncPoints = await keyTimestamps(input);
		const segments = await segmentIndexOf(input, { targetDuration: 1 });

		expect(segments.length).toBeGreaterThan(0);
		for (const segment of segments) {
			expect(syncPoints).toContain(segment.startTime);
		}
	});

	test('the segments tile the track with no gap or overlap', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const duration = await track.computeDuration();
		const segments = await segmentIndexOf(input, { targetDuration: 1 });

		expect(segments[0]!.startTime).toBe((await keyTimestamps(input))[0]);
		for (let i = 1; i < segments.length; i++) {
			expect(segments[i]!.startTime).toBe(segments[i - 1]!.endTime);
		}
		expect(segments[segments.length - 1]!.endTime).toBeCloseTo(duration, 6);
		expect(segments.every(s => s.duration > 0)).toBe(true);
	});

	test('a segment runs at least the target, then to the next sync sample', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		const segments = await segmentIndexOf(input, { targetDuration: 1 });

		// Every segment but the last opens a new one only once the target is reached
		for (const segment of segments.slice(0, -1)) {
			expect(segment.duration).toBeGreaterThanOrEqual(1);
		}
	});

	test('the target decides which sync samples become cuts', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });

		// Sync samples at 0,1,2,3,4 over 5s: a 1s target cuts at every one of them
		const fine = await segmentIndexOf(input, { targetDuration: 1 });
		expect(fine.map(s => s.startTime)).toEqual([0, 1, 2, 3, 4]);
		expect(fine.map(s => s.endTime)).toEqual([1, 2, 3, 4, 5]);

		// A 2s target skips every other one, since a segment runs to the first sync sample past the target
		const coarse = await segmentIndexOf(input, { targetDuration: 2 });
		expect(coarse.map(s => s.startTime)).toEqual([0, 2, 4]);
		expect(coarse.map(s => s.duration)).toEqual([2, 2, 1]);

		// Longer than the whole track: nothing left to cut on, so one segment spanning it
		const whole = await segmentIndexOf(input, { targetDuration: 60 });
		expect(whole).toHaveLength(1);
		expect(whole[0]!.duration).toBeCloseTo(5, 6);
	});

	test('refuses a target that is not a positive duration', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		await expect(segmentIndexOf(input, { targetDuration: 0 })).rejects.toThrow(TypeError);
		await expect(segmentIndexOf(input, { targetDuration: -1 })).rejects.toThrow(TypeError);
	});
});

describe('muxSegment', () => {
	test('writes a segment holding only its own media', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		const segments = await segmentIndexOf(input, { targetDuration: 1 });
		expect(segments.length).toBeGreaterThan(1);

		const boundary = segments[0]!;
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await muxSegment(input, boundary, output);

		using written = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const track = (await written.getPrimaryVideoTrack())!;
		const duration = await track.computeDuration();

		// Shrinking to the boundary means the segment never carries its neighbour's media
		expect(duration).toBeGreaterThan(0);
		expect(duration).toBeLessThanOrEqual(boundary.duration + 1e-6);
	});

	test('each segment carries its own media, not the first segment again', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		const segments = await segmentIndexOf(input, { targetDuration: 1 });
		expect(segments).toHaveLength(5);

		// Durations alone cannot tell correct slicing from re-emitting segment 0 every time, since every
		// segment here is one second long; the media itself is what discriminates.
		const digests: string[] = [];
		for (const boundary of segments) {
			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			await muxSegment(input, boundary, output);

			using written = new Input({
				source: new BufferSource(output.target.buffer!),
				formats: ALL_FORMATS,
			});
			const sink = new EncodedPacketSink((await written.getPrimaryVideoTrack())!);
			const first = (await sink.getFirstPacket())!;
			digests.push(createHash('sha1').update(first.data).digest('hex'));
		}

		expect(new Set(digests).size).toBe(segments.length);
	});

	test('every segment of the index writes and decodes', async () => {
		using input = new Input({ source: progressive(), formats: ALL_FORMATS });
		const segments = await segmentIndexOf(input, { targetDuration: 2 });

		let total = 0;
		for (const boundary of segments) {
			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			await muxSegment(input, boundary, output);

			using written = new Input({
				source: new BufferSource(output.target.buffer!),
				formats: ALL_FORMATS,
			});
			const track = await written.getPrimaryVideoTrack();
			expect(track).not.toBe(null);

			const sink = new EncodedPacketSink(track!);
			const first = await sink.getFirstPacket();
			expect(first).not.toBe(null);
			// A segment must open on a key frame, or it cannot be served on its own
			expect((await sink.getFirstKeyPacket())!.timestamp).toBe(first!.timestamp);

			total += await track!.computeDuration();
		}

		expect(total).toBeGreaterThan(0);
	});
});
