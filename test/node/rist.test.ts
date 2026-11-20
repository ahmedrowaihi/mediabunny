/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// RIST, spoken directly rather than through a native library. Nothing here needs anything installed to
// build, so the wire format is this package's own claim - which makes interop with librist's `ristsender`
// and `ristreceiver` the only test that settles whether the claim is true. A round trip between this
// package's two halves would pass just as happily on a format librist has never seen.
//
// Both ends must agree on the profile. `ristsender`/`ristreceiver` default to main.
//
// Simple profile occupies two UDP ports, `port` for RTP and `port + 1` for RTCP; main profile carries
// both over `port` alone, inside GRE. A helper bound on `port + 1` steals simple profile's RTCP channel
// and the handshake never completes, so the helper ports here sit well clear.
//
// `@mediabunny/server` owns RIST: it is a server-side transport, beside RtmpTarget and NetworkSource.
// It defaults to simple profile, so every main-profile case here states `profile: 'main'`.
//
// This file owns 9800-9999. The other live bands: rist-target 16000+, srt-target 17000+, rtmp-target
// 18200+, rtmp-input 19000+, live-network-input 21000+, rist-input 25000+.

import { execFileSync, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { RistSource, RistTarget } from '@mediabunny/server';

// Both tools print their usage and exit 1, so a zero exit is not the test for presence - only ENOENT
// says the binary is absent. Probing by exit code skipped this whole file silently.
const canRun = (command: string) => {
	try {
		execFileSync(command, ['--help'], { stdio: 'ignore' });
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== 'ENOENT';
	}
};

const hasTools = canRun('ristsender') && canRun('ristreceiver');
const interop = test.skipIf(!hasTools);

/** Deterministic and distinct per index, so a payload delivered out of order is visible. */
const payloads = (count: number) =>
	Array.from({ length: count }, (_, index) => new Uint8Array(1316).fill((index % 255) + 1));

const joined = (list: Uint8Array[]) => Buffer.concat(list.map(one => Buffer.from(one)));

/** Collects a UDP flow to a buffer, which is how librist's tools hand their output over. */
const collect = async (port: number) => {
	const chunks: Buffer[] = [];
	const socket = createSocket('udp4');
	socket.on('message', message => chunks.push(Buffer.from(message)));
	await new Promise<void>(resolve => socket.bind(port, '127.0.0.1', resolve));
	return {
		stop: () => socket.close(),
		bytes: () => Buffer.concat(chunks),
	};
};

/**
 * A packet lost at the very end of a stream cannot be recovered by any NACK protocol: a gap is seen
 * when a later sequence number arrives, and for the last packet none ever does. Live streams do not
 * end, so the recovery tests send trailing payloads past the span they compare rather than asserting
 * a property RIST does not have.
 */
const TRAILING = 6;

const sendAll = async (target: RistTarget, list: Uint8Array[], gapMs = 8) => {
	target._setMonotonicity(true);
	target._start();

	let at = 0;
	for (const payload of list) {
		target._write(payload, at);
		at += payload.byteLength;
		await sleep(gapMs);
	}

	await target._flush();
	await target._close();
};

const readAll = async (source: RistSource, atLeast: number, timeoutMs: number) => {
	const reader = (source as never as { _stream: ReadableStream<Uint8Array> })._stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const deadline = Date.now() + timeoutMs;

	while (total < atLeast && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			chunks.push(value);
			total += value.byteLength;
		}
	}

	await reader.cancel().catch(() => {});
	return joined(chunks);
};

/**
 * Drops one media datagram in `dropEvery` on its way from the sender, and passes everything else both
 * ways. The control flow is never touched: a relay that ate NACKs would be testing nothing but its own
 * ability to break a stream.
 */
const lossyRelay = async (
	listenPort: number,
	forwardPort: number,
	dropEvery: number,
	profile: 'simple' | 'main',
	phase = 0,
) => {
	const sockets: ReturnType<typeof createSocket>[] = [];
	let forwarded = 0;
	let dropped = 0;

	// Main profile multiplexes control into the media port, so there is only one socket to relay
	const offsets = profile === 'simple' ? [0, 1] : [0];

	for (const offset of offsets) {
		const socket = createSocket('udp4');
		let senderAddress: { address: string; port: number } | null = null;

		socket.on('message', (message, from) => {
			if (from.port === forwardPort + offset) {
				if (senderAddress) {
					socket.send(message, senderAddress.port, senderAddress.address);
				}
				return;
			}

			senderAddress = { address: from.address, port: from.port };
			// Main profile's control rides here too, and dropping it would stall the handshake rather
			// than lose media. Its datagrams are far smaller than a 1316-byte payload.
			const isMedia = offset === 0 && message.length > 1000;
			if (isMedia && (++forwarded + phase) % dropEvery === 0) {
				dropped++;
				return;
			}
			socket.send(message, forwardPort + offset, '127.0.0.1');
		});

		await new Promise<void>(resolve => socket.bind(listenPort + offset, '127.0.0.1', resolve));
		sockets.push(socket);
	}

	return {
		stop: () => sockets.forEach(socket => socket.close()),
		counts: () => ({ forwarded, dropped }),
	};
};

const spawnTool = (command: string, args: string[]) => {
	const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
	let log = '';
	child.stderr.on('data', (chunk: Buffer) => {
		log += chunk.toString();
	});
	return { child, log: () => log };
};

// ---------------------------------------------------------------------------
// Validation. Needs nothing installed, so this part runs everywhere.
// ---------------------------------------------------------------------------

test('a link list must name at least one URL', () => {
	expect(() => new RistTarget([])).toThrow('at least one rist:// URL');
});

test('every URL in the list is checked, not just the first', () => {
	expect(() => new RistTarget(['rist://127.0.0.1:9800', 'http://127.0.0.1:9802']))
		.toThrow('not a rist:// URL');
	expect(() => new RistTarget(['rist://127.0.0.1:9800', 'rist://127.0.0.1:9803']))
		.toThrow('even port');
});

test('an odd port is refused, since RTCP uses the one above it', () => {
	expect(() => new RistSource('rist://127.0.0.1:9801')).toThrow('even port');
});

test('a secret is refused on simple profile, which has no encryption at all', () => {
	expect(() => new RistTarget('rist://127.0.0.1:9800', { profile: 'simple', secret: 'x'.repeat(16) }))
		.toThrow('require options.profile');
	expect(() => new RistSource('rist://127.0.0.1:9800', { profile: 'simple', aesType: 128 }))
		.toThrow('require options.profile');
});

test('an unknown profile is refused at construction', () => {
	expect(() => new RistTarget('rist://127.0.0.1:9800', {
		profile: 'advanced' as unknown as 'main',
	})).toThrow('\'simple\' or \'main\'');
});

// ---------------------------------------------------------------------------
// Interop with librist's own tools, which is what decides the wire format.
// ---------------------------------------------------------------------------

for (const profile of ['simple', 'main'] as const) {
	interop(`a target is read by ristreceiver on ${profile} profile, byte for byte`, async () => {
		const port = profile === 'simple' ? 9810 : 9814;
		const sink = port + 120;
		const out = await collect(sink);
		const { child, log } = spawnTool('ristreceiver', [
			'-p', profile === 'simple' ? '0' : '1',
			'-i', `rist://@127.0.0.1:${port}?buffer=400`,
			'-o', `udp://127.0.0.1:${sink}`,
		]);
		await sleep(1500);

		const list = payloads(30);
		const target = new RistTarget(`rist://127.0.0.1:${port}`, { profile, pacing: false });
		await sendAll(target, list);
		await sleep(1500);

		child.kill();
		await sleep(300);
		const received = out.bytes();
		out.stop();

		expect(received.byteLength, log()).toBe(30 * 1316);
		expect(received.equals(joined(list))).toBe(true);
	}, 40_000);
}

interop('a matching secret delivers over AES-256, and a wrong one delivers nothing', async () => {
	const results: number[] = [];

	for (const [index, secret] of ['sharedpassphrase1', 'a-different-passphrase'].entries()) {
		const port = 9820 + index * 2;
		const out = await collect(port + 120);
		const { child } = spawnTool('ristreceiver', [
			'-p', '1',
			'-i', `rist://@127.0.0.1:${port}?secret=sharedpassphrase1&aes-type=256&buffer=400`,
			'-o', `udp://127.0.0.1:${port + 120}`,
		]);
		await sleep(1500);

		const target = new RistTarget(
			`rist://127.0.0.1:${port}`,
			{ profile: 'main', secret, aesType: 256, pacing: false },
		);
		await sendAll(target, payloads(20));
		await sleep(1200);

		child.kill();
		await sleep(300);
		results.push(out.bytes().byteLength);
		out.stop();
	}

	expect(results[0]).toBe(20 * 1316);
	// The whole point: the wrong key does not merely garble the payload, it never arrives
	expect(results[1]).toBe(0);
}, 60_000);

interop('a source reads what ristsender sends, byte for byte', async () => {
	const port = 9830;
	// ristsender takes udp:// or rtp:// in and rist:// out, so the payloads are fed to it over UDP
	const feed = 9832;
	const list = payloads(40);

	const source = new RistSource(`rist://0.0.0.0:${port}`, {
		profile: 'main',
		mode: 'listener',
		bufferMs: 400,
		readTimeout: 8,
	});
	const reading = readAll(source, 40 * 1316, 25_000);
	await sleep(800);

	const { child, log } = spawnTool('ristsender', [
		'-p', '1',
		'-i', `udp://127.0.0.1:${feed}`,
		'-o', `rist://127.0.0.1:${port}?buffer=400`,
	]);
	await sleep(1500);

	const socket = createSocket('udp4');
	for (const payload of list) {
		socket.send(payload, feed, '127.0.0.1');
		await sleep(10);
	}

	const received = await reading;
	socket.close();
	child.kill();

	expect(received.byteLength, log()).toBeGreaterThanOrEqual(40 * 1316);
	expect(received.subarray(0, 40 * 1316).equals(joined(list))).toBe(true);
}, 45_000);

// ---------------------------------------------------------------------------
// This package's two halves against each other: recovery and merging, which the
// tools above cannot be made to exercise on demand.
// ---------------------------------------------------------------------------

test('a target and a source carry the bytes unchanged', async () => {
	const list = payloads(30);
	const source = new RistSource(
		'rist://0.0.0.0:9840',
		{ profile: 'main', mode: 'listener', bufferMs: 300, readTimeout: 8 },
	);
	const reading = readAll(source, 30 * 1316, 20_000);
	await sleep(500);

	const target = new RistTarget('rist://127.0.0.1:9840', { profile: 'main', pacing: false });
	await sendAll(target, list);

	const received = await reading;
	expect(received.byteLength).toBeGreaterThanOrEqual(30 * 1316);
	expect(received.subarray(0, 30 * 1316).equals(joined(list))).toBe(true);
}, 40_000);

test('packets lost in flight are asked for again and the stream arrives whole', async () => {
	const list = payloads(60);
	const source = new RistSource(
		'rist://0.0.0.0:9850',
		{ profile: 'main', mode: 'listener', bufferMs: 900, readTimeout: 10 },
	);
	const reading = readAll(source, 60 * 1316, 25_000);
	await sleep(500);

	// One datagram in six never reaches the receiver on its first try
	const relay = await lossyRelay(9854, 9850, 6, 'main');
	const target = new RistTarget('rist://127.0.0.1:9854', { profile: 'main', pacing: false });
	await sendAll(target, [...list, ...payloads(TRAILING)], 12);

	const received = await reading;
	const { dropped } = relay.counts();
	relay.stop();

	// Without this the test would pass on a relay that silently dropped nothing
	expect(dropped).toBeGreaterThan(5);
	expect(received.byteLength).toBeGreaterThanOrEqual(60 * 1316);
	expect(received.subarray(0, 60 * 1316).equals(joined(list))).toBe(true);
	expect(target.retransmittedPackets).toBeGreaterThan(0);
}, 45_000);

test('a stream split across two paths is only whole if both paths are read', async () => {
	// Retransmission off: with nothing held for resend, a packet that arrives on the path it was sent
	// down is the only copy there will ever be. A receiver reading one path gets half a stream, so this
	// fails on any implementation that does not actually merge.
	const list = payloads(40);
	const source = new RistSource(
		['rist://0.0.0.0:9880', 'rist://0.0.0.0:9882'],
		{ profile: 'main', mode: 'listener', bufferMs: 600, readTimeout: 8 },
	);
	const reading = readAll(source, 40 * 1316, 25_000);
	await sleep(500);

	const target = new RistTarget(
		['rist://127.0.0.1:9880', 'rist://127.0.0.1:9882'],
		{ profile: 'main', pacing: false, retransmitBufferMs: 1 },
	);
	await sendAll(target, [...list, ...payloads(TRAILING)], 12);

	const received = await reading;
	expect(received.byteLength).toBeGreaterThanOrEqual(40 * 1316);
	expect(received.subarray(0, 40 * 1316).equals(joined(list))).toBe(true);
}, 45_000);

test('two paths each losing a disjoint tenth recover across each other', async () => {
	const list = payloads(80);
	const source = new RistSource(
		['rist://0.0.0.0:9860', 'rist://0.0.0.0:9862'],
		{ profile: 'main', mode: 'listener', bufferMs: 900, readTimeout: 10 },
	);
	const reading = readAll(source, 80 * 1316, 30_000);
	await sleep(500);

	// Disjoint: the two relays drop on opposite phases, so no sequence number is lost on both at once
	const first = await lossyRelay(9864, 9860, 10, 'main', 0);
	const second = await lossyRelay(9866, 9862, 10, 'main', 5);

	const target = new RistTarget(
		['rist://127.0.0.1:9864', 'rist://127.0.0.1:9866'],
		{ profile: 'main', pacing: false },
	);
	await sendAll(target, [...list, ...payloads(TRAILING)], 12);

	const received = await reading;
	const losses = first.counts().dropped + second.counts().dropped;
	first.stop();
	second.stop();

	expect(losses).toBeGreaterThan(5);
	expect(received.byteLength).toBeGreaterThanOrEqual(80 * 1316);
	expect(received.subarray(0, 80 * 1316).equals(joined(list))).toBe(true);
}, 60_000);

test('a source with no sender ends on its read timeout rather than hanging', async () => {
	const source = new RistSource('rist://0.0.0.0:9870', { mode: 'listener', readTimeout: 2 });
	const started = Date.now();
	const received = await readAll(source, 1316, 10_000);

	expect(received.byteLength).toBe(0);
	expect(Date.now() - started).toBeLessThan(8_000);
}, 20_000);
