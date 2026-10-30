import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { CustomSource } from '../../src/source.js';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { readFileSync } from 'node:fs';
import { registerMediabunnyServer } from '@mediabunny/server';
import { VideoSample, VideoSampleColorSpace } from '../../src/sample.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Behaviour of upstream's that a fork rebase deleted and shipped, because the fork's own tests never
// covered it and diff-equality was the only thing that caught it afterwards. One test each, so the
// next bad conflict resolution fails here instead of in a release.
//
// `scripts/check-upstream-deletions.ts` is the other half: it fails when an upstream line goes missing
// without being declared. These tests are what make the behaviour, rather than the text, load-bearing.

// Upstream #555: a platform `VideoFrame` may carry colour values outside the WebCodecs enums, and
// `VideoSampleColorSpace`'s constructor throws on exactly those. A rebase deleted the sanitization, so
// such a frame threw on construction instead of being kept with the out-of-spec fields dropped.
//
// Node has no `VideoFrame`, so the branch that does the sanitizing (`src/sample.ts`, `data instanceof
// VideoFrame`) is unreachable here without standing one up. The class only has to satisfy `instanceof`
// and carry the fields that branch reads.
class FakeVideoFrame {
	readonly format = 'RGBX';
	readonly codedWidth = 2;
	readonly codedHeight = 2;
	readonly displayWidth = 2;
	readonly displayHeight = 2;
	readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
	readonly timestamp = 0;
	readonly duration = 1_000_000;
	readonly colorSpace = {
		primaries: 'not-a-primary',
		transfer: 'not-a-transfer',
		matrix: 'not-a-matrix',
		fullRange: true,
	};
}

test('out-of-spec colour on a VideoFrame is dropped, not thrown (#555)', () => {
	const globals = globalThis as { VideoFrame?: unknown };
	const had = 'VideoFrame' in globals;
	const previous = globals.VideoFrame;
	globals.VideoFrame = FakeVideoFrame;

	try {
		const frame = new FakeVideoFrame();

		// The control: these are the values the constructor rejects, which is what #555 was about. If this
		// stops throwing, the test below proves nothing and the assertion needs rewriting.
		expect(() => new VideoSampleColorSpace(
			frame.colorSpace as unknown as ConstructorParameters<typeof VideoSampleColorSpace>[0],
		)).toThrow();

		const sample = new VideoSample(frame as unknown as VideoFrame);
		expect(sample.colorSpace.primaries).toBe(null);
		expect(sample.colorSpace.transfer).toBe(null);
		expect(sample.colorSpace.matrix).toBe(null);
		// `fullRange` is a boolean, never out of spec, so it survives.
		expect(sample.colorSpace.fullRange).toBe(true);
	} finally {
		if (had) {
			globals.VideoFrame = previous;
		} else {
			delete globals.VideoFrame;
		}
	}
});

// Upstream #567 (6f1a9c15), "Remove excessive packet pressure when decoder sample queue is empty". A
// rebase reinstated the superseded 40/8 `computeMaxQueueSize` heuristic, which lets the decoder be fed
// up to 40 encoded packets whenever the decoded-sample queue is empty — which it is for most of a
// sequential read. The cap is now a flat 4, refilled by `onDequeue`.
//
// The cap itself is module-private and a custom decoder cannot see the queue (its calls are serialized,
// so it only ever sees one packet in flight). What is observable is how far ahead the *source* is asked
// to read, with prefetching and caching turned off so reads follow demand:
//
//   fixed:    38 reads /  674 KB before the first sample, then ~2 reads per further sample
//   reverted: 86 reads / 1.42 MB before the first sample, and the whole 1.99 MB file by the second
test('the decoder is not fed the whole file before it emits a sample (#567)', { timeout: 60_000 }, async () => {
	const bytes = new Uint8Array(readFileSync(path.join(__dirname, '../public/video.mp4')));
	const reads: { start: number; end: number }[] = [];

	using input = new Input({
		source: new CustomSource({
			getSize: () => bytes.byteLength,
			read: (start, end) => {
				reads.push({ start, end });
				return bytes.subarray(start, end);
			},
			// Both off, so a read means the pipeline wanted those bytes rather than a heuristic did.
			prefetchProfile: 'none',
			maxCacheSize: 0,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const afterMetadata = reads.length;
	const mediaBytes = () => reads.slice(afterMetadata).reduce((sum, r) => sum + (r.end - r.start), 0);

	const sink = new VideoSampleSink(track);
	let pulled = 0;
	let bytesAtFirstSample = 0;
	let readsAtThirdSample = 0;

	for await (const sample of sink.samples()) {
		sample.close();
		pulled++;

		if (pulled === 1) {
			bytesAtFirstSample = mediaBytes();
		}
		if (pulled === 3) {
			readsAtThirdSample = reads.length;
		}
		if (pulled >= 5) {
			break;
		}

		// Pulled slowly on purpose: the pressure only shows when the consumer is slower than the decoder.
		await new Promise(resolve => setTimeout(resolve, 150));
	}

	expect(pulled).toBe(5);

	// Half the file is already far more slack than the fixed cap needs, and well under what the
	// reverted heuristic reads.
	expect(bytesAtFirstSample).toBeLessThan(bytes.byteLength / 2);

	// And it must still be streaming: under the old heuristic the entire file is read by the second
	// sample, so the read count stops moving.
	expect(reads.length).toBeGreaterThan(readsAtThirdSample);
});
