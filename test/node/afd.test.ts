/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Active Format Description (SMPTE ST 2016-1), written as an ATSC A/53 `user_data_registered_itu_t_t35`
// SEI message under the `DTG1` identifier.
//
// The two payload octets were settled by writing one and having ffmpeg read it back, not by reading the
// standard: the `active_format_flag` is in the FIRST octet and the code in the SECOND octet's low
// nibble. ffmpeg's `libavcodec/itut35.c` agrees - it consumes the flag octet during the header walk and
// then takes `*payload & 0xf` from what follows. Getting the two the other way round yields a message
// ffmpeg ignores entirely, which a round trip through our own reader would not notice.

import { beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource, VideoSampleSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { VideoSample } from '../../src/sample.js';
import { registerMediabunnyServer } from '@mediabunny/server';
import { type Afd, AFD_CODES, parsePacketAfd } from '../../src/afd.js';
import {
	buildSeiNalUnit,
	iterateSeiMessages,
	iterateSeiNalUnits,
	spliceNalUnitBeforeVcl,
} from '../../src/sei.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');
const HEVC_SOURCE = path.join(__dirname, '../public/video-h265.mp4');

const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-afd-'));
});

type WriteOptions = {
	afd?: Afd;
	format?: 'mp4' | 'ts';
	source?: string;
	packetLimit?: number;
	/** Splices this AFD into each packet BEFORE the muxer sees it, as a remux of signalled content. */
	preSignalled?: Afd;
};

const write = async ({
	afd,
	format = 'mp4',
	source = SOURCE,
	packetLimit = 8,
	preSignalled,
}: WriteOptions) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(source) });
	const inputTrack = await input.getPrimaryVideoTrack();
	assert(inputTrack);
	const codec = await inputTrack.getCodec();
	assert(codec === 'avc' || codec === 'hevc');
	const decoderConfig = await inputTrack.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({
		format: format === 'ts' ? new MpegTsOutputFormat() : new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const packetSource = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(packetSource, { frameRate: 30, activeFormatDescription: afd });

	await output.start();
	const sink = new EncodedPacketSink(inputTrack);
	let written = 0;
	for (
		let packet = await sink.getFirstPacket();
		packet && written < packetLimit;
		packet = await sink.getNextPacket(packet)
	) {
		let toAdd = packet;
		if (preSignalled !== undefined) {
			const nalUnit = buildSeiNalUnit([{
				payloadType: 4,
				payload: new Uint8Array([
					0xb5, 0x00, 0x31, 0x44, 0x54, 0x47, 0x31, 0x41, 0xf0 | preSignalled,
				]),
			}], codec);
			assert(nalUnit);
			toAdd = packet.clone({
				data: spliceNalUnitBeforeVcl(packet.data, decoderConfig, codec, nalUnit),
			});
		}

		await packetSource.add(toAdd, { decoderConfig });
		written++;
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

/** The AFD each packet of a written file states, read back through this library. */
const afdsOf = async (bytes: Uint8Array) => {
	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const codec = await track.getCodec();
	assert(codec === 'avc' || codec === 'hevc');
	const config = await track.getDecoderConfig();
	assert(config);

	const sink = new EncodedPacketSink(track);
	const found: (Afd | null)[] = [];
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		found.push(parsePacketAfd(packet.data, config, codec));
	}

	return found;
};

/**
 * How many AFD messages each packet carries.
 *
 * Reading the first one is not enough: a second message spliced in beside an existing one sits AFTER it
 * (both go ahead of the first slice), so a reader that stops at the first still returns the original and
 * a duplicate goes unnoticed. Two messages state two shapes for one picture.
 */
const afdMessageCounts = async (bytes: Uint8Array) => {
	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const codec = await track.getCodec();
	assert(codec === 'avc' || codec === 'hevc');
	const config = await track.getDecoderConfig();
	assert(config);

	const sink = new EncodedPacketSink(track);
	const counts: number[] = [];
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		let count = 0;
		for (const nalUnit of iterateSeiNalUnits(packet.data, config, codec)) {
			for (const message of iterateSeiMessages(nalUnit, codec)) {
				// 0xb5 0x00 0x31 'DTG1'
				const isAfd = message.payloadType === 4
					&& [0xb5, 0x00, 0x31, 0x44, 0x54, 0x47, 0x31]
						.every((byte, i) => message.payload[i] === byte);
				if (isAfd) {
					count++;
				}
			}
		}
		counts.push(count);
	}

	return counts;
};

/** What ffmpeg's own decoder makes of the same file, which is the check that matters. */
const probedAfds = (bytes: Uint8Array, name: string) => {
	const file = path.join(workDir, name);
	writeFileSync(file, bytes);

	const dump = execFileSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v', '-show_frames', '-of', 'json', file,
	], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

	return (JSON.parse(dump) as {
		frames: { side_data_list?: { side_data_type: string; active_format?: number }[] }[];
	}).frames.flatMap(frame => (frame.side_data_list ?? [])
		.filter(x => x.side_data_type === 'Active format description')
		.map(x => x.active_format!));
};

describe('writing an active format description', () => {
	test('every frame carries it, not just the key frames', async () => {
		// A receiver joining mid-GOP has to learn the picture's shape too, and ST 2016-1 signalling is
		// per frame
		const bytes = await write({ afd: 10 });

		const found = await afdsOf(bytes);
		expect(found.length).toBeGreaterThan(1);
		expect(found.every(x => x === 10), `got ${JSON.stringify(found)}`).toBe(true);

		const counts = await afdMessageCounts(bytes);
		expect(counts.every(x => x === 1), `one message per frame, got ${JSON.stringify(counts)}`)
			.toBe(true);
	});

	test('no AFD stated means no message at all', async () => {
		expect((await afdsOf(await write({}))).every(x => x === null)).toBe(true);
	});

	test('each of the ten defined codes round-trips', async () => {
		// The code sits in a nibble beside four reserved bits, so a writer that masked wrongly would
		// come back right for some values and wrong for others
		for (const afd of AFD_CODES) {
			const found = await afdsOf(await write({ afd, packetLimit: 2 }));
			expect(found[0], `AFD ${afd}`).toBe(afd);
		}
	});

	test('a reserved code is refused rather than written', async () => {
		await expect(write({ afd: 7 as Afd })).rejects.toThrow(/7 is reserved/);
		await expect(write({ afd: 0 as Afd })).rejects.toThrow(/0 is reserved/);
	});

	test('a codec with no SEI message for it is refused', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		expect(() => output.addVideoTrack(new EncodedVideoPacketSource('vp9'), {
			frameRate: 30,
			activeFormatDescription: 10,
		})).toThrow(/has no SEI message to carry one/);
		void input;
	});

	test('a packet that already states one keeps its own', async () => {
		// Remuxing someone else's signalled stream must not end up with two messages stating two
		// shapes for one picture
		const bytes = await write({ afd: 9, preSignalled: 14, packetLimit: 4 });

		const found = await afdsOf(bytes);
		expect(found.every(x => x === 14), `got ${JSON.stringify(found)}`).toBe(true);

		// And exactly one message, not the original plus ours: reading the value alone would pass
		// either way, since a spliced second message lands after the one already there
		const counts = await afdMessageCounts(bytes);
		expect(counts.every(x => x === 1), `message counts ${JSON.stringify(counts)}`).toBe(true);
	});

	test('MPEG-TS carries it too, in Annex B framing', async () => {
		const found = await afdsOf(await write({ afd: 11, format: 'ts' }));
		expect(found.length).toBeGreaterThan(1);
		expect(found.every(x => x === 11)).toBe(true);
	});

	test('HEVC carries it in its own SEI framing', async () => {
		const found = await afdsOf(await write({ afd: 10, source: HEVC_SOURCE, packetLimit: 4 }));
		expect(found.every(x => x === 10), `got ${JSON.stringify(found)}`).toBe(true);
	});
});

describe.skipIf(!hasFfprobe)('ffmpeg reads back what we wrote', () => {
	test('the stated code is the one ffmpeg decodes', async () => {
		// Our own reader agreeing proves only that the two halves match each other. This is the check
		// that the octets are in the order the standard puts them.
		const probed = probedAfds(await write({ afd: 10 }), 'afd10.mp4');
		expect(probed.length).toBeGreaterThan(1);
		expect(new Set(probed)).toEqual(new Set([10]));
	});

	test('every defined code decodes as itself', async () => {
		for (const afd of AFD_CODES) {
			const probed = probedAfds(await write({ afd, packetLimit: 2 }), `afd-${afd}.mp4`);
			expect(probed[0], `AFD ${afd}`).toBe(afd);
		}
	}, 60_000);

	test('and an MPEG-TS does too', async () => {
		const probed = probedAfds(await write({ afd: 15, format: 'ts' }), 'afd15.ts');
		expect(new Set(probed)).toEqual(new Set([15]));
	});

	test('HEVC too', async () => {
		const probed = probedAfds(
			await write({ afd: 9, source: HEVC_SOURCE, packetLimit: 4 }),
			'afd-hevc.mp4',
		);
		expect(new Set(probed)).toEqual(new Set([9]));
	});
});

describe('an encoded track states it too, not only a packet track', () => {
	// `EncodedVideoPacketSource.add` spliced the message and the encoder path did not, so a track fed
	// `VideoSample`s declared an AFD in its metadata and wrote a bitstream carrying none - the manifests
	// announced a shape the pictures never stated.
	beforeAll(() => {
		registerMediabunnyServer();
	});

	const encode = async (afd: Afd | undefined) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({ codec: 'avc', bitrate: 1e6 });
		output.addVideoTrack(source, afd === undefined
			? { frameRate: 25 }
			: { frameRate: 25, activeFormatDescription: afd });
		await output.start();

		const pixels = new Uint8Array(320 * 240 * 3 / 2).fill(0x80);
		for (let i = 0; i < 8; i++) {
			using sample = new VideoSample(pixels, {
				format: 'I420',
				codedWidth: 320,
				codedHeight: 240,
				timestamp: i / 25,
				duration: 1 / 25,
			});
			await source.add(sample);
		}

		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	test('every encoded frame carries the declared code', async () => {
		const found = await afdsOf(await encode(10));
		expect(found.length).toBeGreaterThan(1);
		expect(found.every(x => x === 10), `got ${JSON.stringify(found)}`).toBe(true);
	}, 60_000);

	test('and a track that declares none still states none', async () => {
		expect((await afdsOf(await encode(undefined))).every(x => x === null)).toBe(true);
	}, 60_000);
}, 120_000);
