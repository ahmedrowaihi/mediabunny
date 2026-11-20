/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { CustomVideoEncoder, registerEncoder } from '../../src/custom-coder.js';
import { VideoCodec } from '../../src/codec.js';
import { VideoSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { VideoSampleSource } from '../../src/media-source.js';

/** Where the double raises its error: from a packet it emits, during a frame, or when flushing. */
let throwOn: 'encode' | 'flush' | 'onPacket' = 'flush';

// A buffering encoder, which is the shape that hides an error: SVT-AV1 and x264 with a lookahead emit
// nothing per frame and everything on flush.
class ThrowingEncoder extends CustomVideoEncoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp8';
	}

	private buffered: VideoSample[] = [];

	init() {}

	encode(videoSample: VideoSample) {
		if (throwOn === 'encode') {
			throw new Error('encoder failed on a frame');
		}

		if (throwOn === 'onPacket') {
			// Emitting a packet the wrapper refuses, which is how a live encoder dies mid-stream: the throw
			// comes out of the wrapper's own onPacket, inside this encode call.
			this.onPacket(
				new EncodedPacket(new Uint8Array([0]), 'key', videoSample.timestamp, videoSample.duration),
				{ decoderConfig: null as unknown as VideoDecoderConfig },
			);
			return;
		}

		this.buffered.push(videoSample.clone());
	}

	flush() {
		for (const sample of this.buffered) {
			sample.close();
		}
		this.buffered.length = 0;

		throw new Error('encoder failed while flushing');
	}

	close() {}
}

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);

beforeEach(() => {
	unhandled.length = 0;
	process.on('unhandledRejection', onUnhandled);
	registerEncoder(ThrowingEncoder);
});

afterEach(() => {
	process.off('unhandledRejection', onUnhandled);
});

const encodeOneFrame = async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new VideoSampleSource({ codec: 'vp8', bitrate: 1e6 });
	output.addVideoTrack(source);
	await output.start();

	using sample = new VideoSample(new Uint8Array(64 * 64 * 4).fill(0xff), {
		format: 'RGBX',
		codedWidth: 64,
		codedHeight: 64,
		timestamp: 0,
		duration: 1 / 30,
	});

	// Either this or finalize() must carry the error; which one depends on when the encoder raises it.
	const addResult = await source.add(sample).then(() => null, (error: unknown) => error);
	const finalizeResult = await output.finalize().then(() => null, (error: unknown) => error);

	// A microtask turn, so a rejection nothing handled would have been reported by now
	await new Promise(resolve => setTimeout(resolve, 50));

	return { addResult, finalizeResult };
};

test('an error raised while a custom encoder flushes rejects finalize rather than going unhandled', async () => {
	throwOn = 'flush';

	const { addResult, finalizeResult } = await encodeOneFrame();

	expect(addResult).toBeNull();
	expect(finalizeResult).toBeInstanceOf(Error);
	expect((finalizeResult as Error).message).toBe('encoder failed while flushing');
	expect(unhandled).toEqual([]);
});

test('an error raised while a custom encoder encodes reaches the caller too', async () => {
	throwOn = 'encode';

	const { addResult, finalizeResult } = await encodeOneFrame();

	const raised = (addResult ?? finalizeResult) as Error;
	expect(raised).toBeInstanceOf(Error);
	expect(raised.message).toBe('encoder failed on a frame');
	expect(unhandled).toEqual([]);
});

test('after the encoder errors, the next add rejects — a live encode never calls finalize', async () => {
	throwOn = 'onPacket';

	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const source = new VideoSampleSource({ codec: 'vp8', bitrate: 1e6 });
	output.addVideoTrack(source);
	await output.start();

	const data = new Uint8Array(64 * 64 * 4).fill(0xff);
	const results: unknown[] = [];

	for (let i = 0; i < 10; i++) {
		using sample = new VideoSample(data, {
			format: 'RGBX',
			codedWidth: 64,
			codedHeight: 64,
			timestamp: i / 30,
			duration: 1 / 30,
		});
		results.push(await source.add(sample).then(() => null, (error: unknown) => error));
	}

	await new Promise(resolve => setTimeout(resolve, 50));

	// A live encoder keeps handing frames over for hours, so the error has to come back on an add rather
	// than waiting for a finalize that never happens.
	const firstRejection = results.findIndex(x => x !== null);
	expect(firstRejection).toBeGreaterThan(-1);
	expect(firstRejection).toBeLessThan(4);
	expect(unhandled).toEqual([]);
});
