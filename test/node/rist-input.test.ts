/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from 'vitest';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { DEFAULT_RIST_BUFFER_MS, RistSource, registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ristSender } from './_rist-sender.js';

registerMediabunnyServer();

const HERE = new URL('.', import.meta.url).pathname;
const FIXTURE = path.join(HERE, '../public/captioned-cea608.ts');
const TS = new Uint8Array(readFileSync(FIXTURE));
const SENDER = path.join(HERE, '_live-sender.ts');

// Probed, not guessed: a receiver needs an even port and the odd one above it, and the suite's other
// network tests bind their own guesses across this span
let nextPort = 25_000 + Math.floor(Math.random() * 400) * 2;
const freePort = async () => {
	for (let attempt = 0; ; attempt++) {
		const port = (nextPort += 2);
		const probes = [
			createSocket({ type: 'udp4', reuseAddr: false }),
			createSocket({ type: 'udp4', reuseAddr: false }),
		];
		try {
			await Promise.all(probes.map((probe, index) => new Promise<void>((resolve, reject) => {
				probe.once('error', reject);
				probe.bind(port + index, '127.0.0.1', () => resolve());
			})));
			return port;
		} catch (error) {
			if (attempt >= 50) {
				throw error;
			}
		} finally {
			for (const probe of probes) {
				try {
					probe.close();
				} catch {
					// Never bound, so there is nothing to close.
				}
			}
		}
	}
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The packets of the fixture read straight from disk, which every receive is compared against. */
const expectedPackets = async () => {
	using input = new Input({ source: new BufferSource(TS.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const out: { timestamp: number; bytes: number }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		out.push({ timestamp: packet.timestamp, bytes: packet.data.byteLength });
	}
	return out;
};

const receive = async (
	port: number,
	sender: ReturnType<typeof ristSender>,
	options: { bufferMs?: number; readTimeout?: number } = {},
) => {
	const source = new RistSource(`rist://127.0.0.1:${port}`, {
		bufferMs: options.bufferMs ?? 200,
		readTimeout: options.readTimeout ?? 2,
	});
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		const out: { timestamp: number; bytes: number }[] = [];
		if (track) {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				out.push({ timestamp: packet.timestamp, bytes: packet.data.byteLength });
			}
		}
		return out;
	})();

	await sleep(100);
	await sender.send();
	const packets = await reading;
	sender.close();
	return packets;
};

test('a RIST sender with no loss delivers the stream byte for byte', async () => {
	const port = await freePort();
	const sender = ristSender('127.0.0.1', port, TS);

	expect(await receive(port, sender)).toEqual(await expectedPackets());
}, 60_000);

test('a packet lost on the first send is recovered by NACK, naming exactly what was dropped', async () => {
	const port = await freePort();
	const dropped = new Set([3, 11, 12, 40, 41, 42]);
	const sender = ristSender('127.0.0.1', port, TS, { drop: seq => dropped.has(seq) });

	expect(await receive(port, sender)).toEqual(await expectedPackets());
	expect(new Set(sender.nacked())).toEqual(dropped);
}, 60_000);

test('packets swapped in pairs come out in order', async () => {
	const port = await freePort();
	const sender = ristSender('127.0.0.1', port, TS, { swapPairs: true });

	expect(await receive(port, sender)).toEqual(await expectedPackets());
}, 60_000);

test('loss the sender never retransmits leaves a gap rather than stalling', async () => {
	const port = await freePort();
	const sender = ristSender('127.0.0.1', port, TS, {
		drop: seq => seq >= 20 && seq < 24,
		retransmit: false,
	});

	const packets = await receive(port, sender, { bufferMs: 100 });
	const expected = await expectedPackets();

	// The stream continues past what was lost, and the demuxer picks up at the next sync byte
	expect(packets.length).toBeGreaterThan(expected.length / 2);
	expect(packets.length).toBeLessThan(expected.length);
	expect(sender.nacked().length).toBeGreaterThan(0);
}, 60_000);

test('a sequence number wrapping from 65535 to 0 mid-stream stays byte for byte', async () => {
	const port = await freePort();
	// Loss across the boundary, so recovery has to compare sequences that straddle it rather than only
	// walking them in order, which works by masking alone
	const dropped = new Set([65_534, 65_535, 0, 1]);
	const sender = ristSender('127.0.0.1', port, TS, {
		firstSequence: 65_500,
		drop: seq => dropped.has(seq),
	});

	expect(await receive(port, sender)).toEqual(await expectedPackets());
	expect(new Set(sender.nacked())).toEqual(dropped);
}, 60_000);

test('readTimeout ends the stream once the sender stops, and dispose frees both ports', async () => {
	const port = await freePort();
	const sender = ristSender('127.0.0.1', port, TS.subarray(0, 188 * 70));

	const started = Date.now();
	await receive(port, sender, { readTimeout: 1 });
	const elapsed = (Date.now() - started) / 1000;

	expect(elapsed).toBeGreaterThan(0.9);
	expect(elapsed).toBeLessThan(10);

	// Bound without reuseAddr, so these fail outright while the source still holds either port
	for (const bound of [port, port + 1]) {
		const probe = createSocket({ type: 'udp4', reuseAddr: false });
		await new Promise<void>((resolve, reject) => {
			probe.once('error', reject);
			probe.bind(bound, '127.0.0.1', () => resolve());
		});
		probe.close();
	}
}, 60_000);

test('an RTP sender with no RTCP at all is still received', async () => {
	const port = await freePort();
	const sender = ristSender('127.0.0.1', port, TS, { control: false });

	expect(await receive(port, sender)).toEqual(await expectedPackets());
}, 60_000);

test('the buffer default is exported, so a caller can state latency against it', () => {
	expect(DEFAULT_RIST_BUFFER_MS).toBeGreaterThan(0);
	expect(() => new RistSource('rist://127.0.0.1:21001', {})).toThrow(/even port/);
	expect(() => new RistSource('srt://127.0.0.1:21000', {})).toThrow(/not a rist/);
	expect(() => new RistSource('rist://127.0.0.1:21000', { bufferMs: 0 })).toThrow(/positive number/);
});

// The others check against _rist-sender.ts, written from the same reading of TR-06-1; this one takes its
// framing, sequence start and SR from libavformat
test('a stream from libavformat\'s own RTP sender is received', async () => {
	const port = await freePort();
	const source = new RistSource(`rist://127.0.0.1:${port}`, { bufferMs: 200, readTimeout: 3 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		const out: { pts: number; dts: number }[] = [];
		if (track) {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				out.push({ pts: packet.timestamp, dts: packet.decodeTimestamp });
			}
		}
		return out;
	})();

	const sender = spawn(
		process.execPath,
		['--import', 'tsx', SENDER, path.join(HERE, '../public/scene-cut-50fps.mp4'),
			`rtp://127.0.0.1:${port}`, '--stop-after=50'],
		{ stdio: 'ignore' },
	);

	try {
		const packets = await reading;
		expect(packets.length).toBeGreaterThan(20);
		for (let i = 1; i < packets.length; i++) {
			expect(packets[i]!.dts).toBeGreaterThanOrEqual(packets[i - 1]!.dts);
		}
	} finally {
		sender.kill('SIGKILL');
	}
}, 60_000);

test('a caller announces itself and is found at the port below the one it announced from', async () => {
	const port = await freePort();
	const sender = ristSender('127.0.0.1', port, TS, { discover: true });
	const source = new RistSource(`rist://127.0.0.1:${port}`, {
		mode: 'caller',
		bufferMs: 200,
		readTimeout: 2,
	});
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		const out: { timestamp: number; bytes: number }[] = [];
		if (track) {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				out.push({ timestamp: packet.timestamp, bytes: packet.data.byteLength });
			}
		}
		return out;
	})();

	await sender.send();
	expect(await reading).toEqual(await expectedPackets());
	sender.close();
}, 60_000);
