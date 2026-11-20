/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A segment source evicted from the reader's input cache is abandoned to GC, not disposed, so its ref
// is collected unfreed. The warning for that is aimed at callers, who cannot fix it here.

import { afterAll, beforeAll, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { Logging } from '../../src/logging.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import {
	hasHlsFixtures,
	LIVE_SEGMENT_DURATION,
	startHlsFixtureServer,
	type HlsFixtureServer,
} from '../node/_hls-fixture-server.js';

const collect = async () => {
	for (let i = 0; i < 5; i++) {
		(globalThis as unknown as { gc: () => void }).gc();
		await new Promise(resolve => setTimeout(resolve, 10));
	}
};

let server: HlsFixtureServer;
beforeAll(async () => {
	server = await startHlsFixtureServer();
});
afterAll(async () => {
	await server?.close();
});

// Without this the checks below pass in a run where the warning cannot be observed at all.
test('the check can see an unfreed ref at all', async () => {
	const warnings: unknown[][] = [];
	const off = Logging.on('warn', args => void warnings.push(args));

	const source = new UrlSource(server.liveUrl);
	((s: UrlSource) => void s.ref())(source);
	await collect();
	off();

	expect(warnings.filter(args => String(args[0]).includes('SourceRef'))).toHaveLength(1);
});

// The cache holds four, so nothing shows until a read has spanned more than four segments.
test.runIf(hasHlsFixtures)(
	'following a live playlist past the segment cache frees every source it opens',
	async () => {
		const warnings: unknown[][] = [];
		const off = Logging.on('warn', args => void warnings.push(args));

		try {
			const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(server.liveUrl) });
			const track = await input.getPrimaryVideoTrack();
			expect(track).not.toBeNull();

			// Relative to the first packet: MPEG-TS timestamps start at the stream's clock, not at zero.
			const sink = new EncodedPacketSink(track!);
			let packet = await sink.getFirstPacket();
			const first = packet?.timestamp ?? 0;
			let span = 0;
			while (packet && span < 6 * LIVE_SEGMENT_DURATION) {
				span = packet.timestamp - first;
				packet = await sink.getNextPacket(packet);
			}

			expect(span).toBeGreaterThan(4 * LIVE_SEGMENT_DURATION);
			input.dispose();
			await collect();
		} finally {
			off();
		}

		expect(
			warnings.filter(args => String(args[0]).includes('SourceRef')).map(args => String(args[0])),
			'a segment source evicted from the cache was collected without being freed',
		).toEqual([]);
	},
	120_000,
);

// A live pull torn down mid-read, where a ref freed only by a completion callback would be abandoned.
test.runIf(hasHlsFixtures)('disposing mid-read frees every source already opened', async () => {
	const warnings: unknown[][] = [];
	const off = Logging.on('warn', args => void warnings.push(args));

	try {
		const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(server.liveUrl) });
		const track = await input.getPrimaryVideoTrack();
		const sink = new EncodedPacketSink(track!);

		// A handful of packets, then tear down without draining the segment.
		let packet = await sink.getFirstPacket();
		for (let i = 0; i < 3 && packet; i++) {
			packet = await sink.getNextPacket(packet);
		}

		input.dispose();
		await collect();
	} finally {
		off();
	}

	expect(
		warnings.filter(args => String(args[0]).includes('SourceRef')).map(args => String(args[0])),
		'a source opened before disposal was collected without being freed',
	).toEqual([]);
});
