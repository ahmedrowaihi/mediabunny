/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The manifests this fork writes are read back by its own parser everywhere else in the suite, which
// cannot catch the two of them agreeing on something no player accepts. libavformat is the foreign reader.

import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Demuxer } from 'node-av/api';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, DashOutputFormat, HlsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);

const writeTo = async (dir: string, manifest: string, format: 'hls' | 'dash') => {
	const output = new Output({
		format: format === 'hls'
			? new HlsOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 1 })
			: new DashOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 1, mpdPath: manifest }),
		target: new PathedTarget(manifest, (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				const full = path.join(dir, request.path);
				mkdirSync(path.dirname(full), { recursive: true });
				writeFileSync(full, new Uint8Array(target.buffer!));
			});
			return target;
		}),
	});
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < 8; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? { decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 } } : undefined,
		);
	}
	await output.finalize();
	return path.join(dir, manifest);
};

test.each([['hls', 'index.m3u8'], ['dash', 'manifest.mpd']] as const)(
	'%s output opens in libavformat',
	async (format, manifest) => {
		const dir = mkdtempSync(path.join(tmpdir(), `mb-${format}-`));
		const file = await writeTo(dir, manifest, format);

		const demuxer = await Demuxer.open(file);
		const stream = demuxer.video();
		expect(stream).not.toBeNull();

		let packets = 0;
		for await (const packet of demuxer.packets()) {
			if (packet) {
				packets++;
			}
			if (packets >= 8) {
				break;
			}
		}
		await demuxer.close();

		expect(packets).toBe(8);
	},
	60_000,
);

type Frame = { pts: number; dts: number; type: 'key' | 'delta' };

/** Writes the frames as an MP4 and reads the timestamps back with libavformat, in milliseconds. */
const timestampsThroughLibav = async (frames: readonly Frame[], fragmented: boolean) => {
	const output = new Output({
		format: new Mp4OutputFormat(fragmented ? { fastStart: 'fragmented' } : {}),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	for (const [index, frame] of frames.entries()) {
		await source.add(
			new EncodedPacket(
				AVC_PACKET, frame.type, frame.pts, 0.1,
				undefined, undefined, undefined, frame.dts,
			),
			index === 0
				? { decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 } }
				: undefined,
		);
	}

	await output.finalize();

	const file = path.join(mkdtempSync(path.join(tmpdir(), 'mb-ts-')), 'out.mp4');
	writeFileSync(file, new Uint8Array(output.target.buffer!));

	const demuxer = await Demuxer.open(file);
	const stream = demuxer.video()!;
	const scale = (stream.timeBase.num / stream.timeBase.den) * 1000;
	const read: { pts: number; dts: number }[] = [];
	for await (const packet of demuxer.packets()) {
		if (packet) {
			read.push({
				pts: Math.round(Number(packet.pts) * scale),
				dts: Math.round(Number(packet.dts) * scale),
			});
		}
	}
	await demuxer.close();

	return read;
};

const ms = (frames: readonly Frame[]) =>
	frames.map(frame => ({ pts: Math.round(frame.pts * 1000), dts: Math.round(frame.dts * 1000) }));

// An open GOP: the key frame presents after the samples decoded behind it, so the GOP's presentation
// times are not the same set as its decode times. Reconstructing the decode times from the presentation
// times cannot represent that, which is what used to put a sample's DTS past its own PTS.
const OPEN_GOP: readonly Frame[] = [
	{ pts: 0.0, dts: 0.0, type: 'key' },
	{ pts: 0.1, dts: 0.1, type: 'delta' },
	{ pts: 0.5, dts: 0.2, type: 'key' },
	{ pts: 0.3, dts: 0.3, type: 'delta' },
	{ pts: 0.4, dts: 0.4, type: 'delta' },
];

const IN_ORDER: readonly Frame[] = [
	{ pts: 0.0, dts: 0.0, type: 'key' },
	{ pts: 0.1, dts: 0.1, type: 'delta' },
	{ pts: 0.2, dts: 0.2, type: 'delta' },
];

// A stream whose first decoded sample is not its first presented one has to decode ahead of presentation, so
// its decode timeline starts before zero. The edit list is what puts presentation back at zero.
const REORDER_DELAY: readonly Frame[] = [
	{ pts: 0.2, dts: -0.2, type: 'key' },
	{ pts: 0.0, dts: -0.1, type: 'delta' },
	{ pts: 0.1, dts: 0.0, type: 'delta' },
];

describe.each([['regular', false], ['fragmented', true]] as const)('%s MP4 timestamps', (_label, fragmented) => {
	test.each([
		['in order', IN_ORDER],
		['an open GOP', OPEN_GOP],
	])('%s keeps the decode times the packets stated', async (_name, frames) => {
		expect(await timestampsThroughLibav(frames, fragmented)).toEqual(ms(frames));
	}, 30_000);

	test('a reorder delay never puts a decode time past its own presentation time', async () => {
		const read = await timestampsThroughLibav(REORDER_DELAY, fragmented);
		expect(read.filter(packet => packet.dts > packet.pts)).toEqual([]);

		// The absolute values depend on whether the reader applies the edit list, the spacing does not.
		const first = read[0]!.pts;
		expect(read.map(packet => packet.pts - first)).toEqual([0, -200, -100]);
	}, 30_000);
});
