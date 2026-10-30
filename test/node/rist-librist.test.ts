/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Interoperability with librist's own `ristsender` and `ristreceiver`, both directions. The point of
// binding librist rather than implementing RIST is that the wire format is then librist's, so the only
// test that means anything is against librist's own tools - not against this package's other half.
//
// Both ends must agree on the profile. `ristsender`/`ristreceiver` default to main, and a simple-profile
// sender against them logs `Non conformant main profile packet received` and delivers nothing.
//
// RIST occupies two UDP ports: `port` for RTP and `port + 1` for RTCP. A UDP helper bound on `port + 1`
// steals the RTCP channel and the handshake never completes, so the helper ports here sit well clear.
//
// This file owns 9800-9999. The other live bands: rist-target 16000+, srt-target 17000+, rtmp-target
// 18200+, rtmp-input 19000+, live-network-input 21000+, rist-input 25000+.

import { execFileSync, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { RistSource, RistTarget, type RistTargetOptions } from '@mediabunny/rist';
import { getLibrist, RistProfile } from '../../packages/rist/src/librist.js';
import { checkPeerOptions, peerUrl } from '../../packages/rist/src/peer-url.js';

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

const hasLibrist = (() => {
	try {
		getLibrist();
		return true;
	} catch {
		return false;
	}
})();

/** Interop needs librist's CLI tools as the other end. */
const ristTest = test.skipIf(!hasTools || !hasLibrist);
/** Loading the library needs no other end, so this runs wherever librist is installed - CI included. */
const libristTest = test.skipIf(!hasLibrist);

/** Deterministic, and distinct per index, so a payload delivered out of order is visible. */
const payloads = (count: number) =>
	Array.from({ length: count }, (_, index) => new Uint8Array(1316).fill(index + 1));

// Gated on the library alone: Ubuntu packages `librist4` but no `ristsender`/`ristreceiver`, so this is
// the one librist test CI can run - and it is the assertion most worth running against a distro build of
// a different version, since `getLibrist` refuses to load a library whose `rist_data_block` is not the
// 72 bytes this binding was written against.
libristTest('librist loads and its data block matches the layout this binding declares', () => {
	const librist = getLibrist();
	expect(librist.path).toBeTruthy();
});

ristTest('a sender bound here is read by ristreceiver, byte for byte', async () => {
	const librist = getLibrist();
	const port = 9860;
	const out = 9960; // clear of the port/port+1 pair

	const received: Buffer[] = [];
	const udp = createSocket('udp4');
	udp.on('message', message => received.push(message));
	await new Promise<void>(resolve => udp.bind(out, '127.0.0.1', resolve));

	const receiver = spawn('ristreceiver', [
		'-i', `rist://@127.0.0.1:${port}`,
		'-o', `udp://127.0.0.1:${out}`,
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let receiverLog = '';
	receiver.stderr.on('data', (chunk: Buffer) => {
		receiverLog += chunk.toString();
	});

	await sleep(1500);

	const ctxOut: unknown[] = [null];
	expect(librist.senderCreate(ctxOut, RistProfile.MAIN, 0, null)).toBe(0);
	const ctx = ctxOut[0];

	const configOut: unknown[] = [null];
	expect(librist.parseAddress(`rist://127.0.0.1:${port}`, configOut)).toBe(0);
	const peerOut: unknown[] = [null];
	expect(librist.peerCreate(ctx, peerOut, configOut[0])).toBe(0);
	librist.peerConfigFree(configOut);
	expect(librist.start(ctx)).toBe(0);

	await sleep(1000);

	const sent = payloads(20);
	for (const payload of sent) {
		const written = librist.senderWrite(ctx, payload);
		expect(written).toBe(payload.byteLength);
		await sleep(20);
	}

	await sleep(2500);
	librist.destroy(ctx);
	receiver.kill('SIGINT');
	await sleep(400);
	udp.close();

	// The log, not just the count: `Non conformant main profile packet received` is how a profile
	// disagreement presents, and it would otherwise read as a plain delivery failure
	expect(receiverLog).not.toContain('Non conformant');
	expect(received).toHaveLength(sent.length);
	for (const [index, datagram] of received.entries()) {
		expect(Buffer.from(sent[index]!).equals(datagram)).toBe(true);
	}
}, 60_000);

ristTest('a receiver bound here reads what ristsender sends, byte for byte', async () => {
	const librist = getLibrist();
	const port = 9870;
	const feed = 9970;

	const ctxOut: unknown[] = [null];
	expect(librist.receiverCreate(ctxOut, RistProfile.MAIN, null)).toBe(0);
	const ctx = ctxOut[0];

	const configOut: unknown[] = [null];
	expect(librist.parseAddress(`rist://@127.0.0.1:${port}`, configOut)).toBe(0);
	const peerOut: unknown[] = [null];
	expect(librist.peerCreate(ctx, peerOut, configOut[0])).toBe(0);
	librist.peerConfigFree(configOut);
	expect(librist.start(ctx)).toBe(0);

	const sender = spawn('ristsender', [
		'-i', `udp://@127.0.0.1:${feed}`,
		'-o', `rist://127.0.0.1:${port}`,
	], { stdio: ['ignore', 'ignore', 'pipe'] });

	await sleep(2000);

	const sent = payloads(20);
	const udp = createSocket('udp4');
	for (const payload of sent) {
		await new Promise<void>(resolve => udp.send(payload, feed, '127.0.0.1', () => resolve()));
		await sleep(25);
	}
	udp.close();

	const got: Uint8Array[] = [];
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && got.length < sent.length) {
		const blockOut: unknown[] = [null];
		const remaining = await librist.receiverReadAsync(ctx, blockOut, 250);
		if (remaining > 0 && blockOut[0]) {
			got.push(librist.payloadOf(blockOut[0]));
			librist.dataBlockFree(blockOut);
		}
	}

	sender.kill('SIGINT');
	await sleep(300);
	librist.destroy(ctx);

	expect(got).toHaveLength(sent.length);
	for (const [index, payload] of got.entries()) {
		expect(Buffer.from(payload).equals(Buffer.from(sent[index]!))).toBe(true);
	}
}, 60_000);

/**
 * Sends with the given passphrase to a `ristreceiver` configured with `receiverSecret`, and reports how
 * much arrived. Both the key and the cipher are query parameters librist's own URL parser reads, which
 * is why main-profile PSK needs no struct field set from here.
 */
const sendWithSecret = async (
	port: number,
	out: number,
	senderSecret: string,
	receiverSecret: string,
	aesType: 128 | 256,
) => {
	const librist = getLibrist();

	const received: Buffer[] = [];
	const udp = createSocket('udp4');
	udp.on('message', message => received.push(message));
	await new Promise<void>(resolve => udp.bind(out, '127.0.0.1', resolve));

	const receiver = spawn('ristreceiver', [
		'-i', `rist://@127.0.0.1:${port}?secret=${receiverSecret}&aes-type=${aesType}`,
		'-o', `udp://127.0.0.1:${out}`,
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let receiverLog = '';
	receiver.stderr.on('data', (chunk: Buffer) => {
		receiverLog += chunk.toString();
	});

	await sleep(1500);

	const ctxOut: unknown[] = [null];
	librist.senderCreate(ctxOut, RistProfile.MAIN, 0, null);
	const ctx = ctxOut[0];
	const configOut: unknown[] = [null];
	const parsed = librist.parseAddress(
		`rist://127.0.0.1:${port}?secret=${senderSecret}&aes-type=${aesType}`,
		configOut,
	);
	const peerOut: unknown[] = [null];
	librist.peerCreate(ctx, peerOut, configOut[0]);
	librist.peerConfigFree(configOut);
	librist.start(ctx);

	await sleep(1000);

	const sent = payloads(20);
	for (const payload of sent) {
		librist.senderWrite(ctx, payload);
		await sleep(20);
	}

	await sleep(2500);
	librist.destroy(ctx);
	receiver.kill('SIGINT');
	await sleep(400);
	udp.close();

	return { parsed, received, receiverLog, sent };
};

ristTest('a matching passphrase delivers over AES-256, and the receiver reports encryption on', async () => {
	const { parsed, received, receiverLog, sent } = await sendWithSecret(
		9880, 9980, 'a-good-passphrase', 'a-good-passphrase', 256,
	);

	expect(parsed).toBe(0);
	// The negative of the test below: without this, "nothing arrived" would pass for any reason at all
	expect(received).toHaveLength(sent.length);
	expect(Buffer.from(sent[0]!).equals(received[0]!)).toBe(true);
	expect(receiverLog).not.toContain('Encryption is disabled for this peer');
}, 60_000);

ristTest('a wrong passphrase is refused: nothing is delivered', async () => {
	const { received, receiverLog } = await sendWithSecret(
		9884, 9984, 'a-good-passphrase', 'the-wrong-passphrase', 256,
	);

	expect(received).toHaveLength(0);
	expect(receiverLog).not.toContain('Encryption is disabled for this peer');
}, 60_000);

// The stats callback is the only way to read librist's own counters - retransmissions above all, which
// nothing on this side can count. It runs on librist's thread, so this also checks that koffi carries a
// foreign thread into JS at all, and that freeing the container in the callback does not fault.
ristTest('the stats callback delivers librist\'s own counters as JSON', async () => {
	const librist = getLibrist();
	const port = 9890;
	const out = 9990;

	const udp = createSocket('udp4');
	await new Promise<void>(resolve => udp.bind(out, '127.0.0.1', resolve));
	const receiver = spawn('ristreceiver', [
		'-i', `rist://@127.0.0.1:${port}`,
		'-o', `udp://127.0.0.1:${out}`,
	], { stdio: ['ignore', 'ignore', 'ignore'] });

	await sleep(1500);

	const ctxOut: unknown[] = [null];
	expect(librist.senderCreate(ctxOut, RistProfile.MAIN, 0, null)).toBe(0);
	const ctx = ctxOut[0];
	const configOut: unknown[] = [null];
	expect(librist.parseAddress(`rist://127.0.0.1:${port}`, configOut)).toBe(0);
	const peerOut: unknown[] = [null];
	expect(librist.peerCreate(ctx, peerOut, configOut[0])).toBe(0);
	librist.peerConfigFree(configOut);

	const reports: string[] = [];
	const stopStats = librist.statsCallbackSet(ctx, 250, (json: string) => reports.push(json));
	expect(librist.start(ctx)).toBe(0);

	const payloadCount = 40;
	for (const payload of payloads(payloadCount)) {
		librist.senderWrite(ctx, payload);
		await sleep(25);
	}

	await sleep(1200);
	stopStats();
	librist.destroy(ctx);
	receiver.kill('SIGINT');
	await sleep(400);
	udp.close();

	expect(reports.length).toBeGreaterThan(1);

	type PeerStats = { stats: Record<string, number> };
	const peersOf = (report: Record<string, unknown>) =>
		(report['sender-stats'] as { peers?: PeerStats[] } | undefined)?.peers ?? [];

	const parsed = reports.map(report => JSON.parse(report) as Record<string, unknown>);
	const withPeers = parsed.filter(report => peersOf(report).length > 0);
	expect(withPeers.length).toBeGreaterThan(1);

	// The shape the counters are read from, not just that something arrived: a rename upstream would
	// otherwise leave every counter reading zero
	expect(parsed[0]!['schema_version']).toBe(5);
	const first = peersOf(withPeers[0]!)[0]!;
	expect(first.stats['sent']).toBeTypeOf('number');
	expect(first.stats['retransmitted']).toBeTypeOf('number');
	expect(first.stats['retransmitted_bytes']).toBeTypeOf('number');

	// librist reports each interval's DELTA, not a running total. Taking the last report as the total
	// would read a keepalive interval - plausible, and wrong - so the sum must exceed any one interval.
	const sentPerInterval = withPeers.map(report => peersOf(report)[0]!.stats['sent']!);
	const total = sentPerInterval.reduce((sum, value) => sum + value, 0);
	expect(total).toBeGreaterThan(Math.max(...sentPerInterval));
	expect(total).toBeGreaterThanOrEqual(payloadCount);
}, 60_000);

/**
 * The receiver's de-jitter buffer, in milliseconds. librist defaults it to 1000, and every packet is
 * held that long before the receiver puts it out - so the last payload of a stream appears a full
 * second after it was sent, which reads exactly like a sender that never flushed it.
 */
const RECEIVER_BUFFER_MS = 100;

/** Deterministic filler, so a byte out of place is visible rather than plausible. */
const filler = (bytes: number): Uint8Array => {
	const out = new Uint8Array(bytes);
	let state = 0x2b;
	for (let i = 0; i < bytes; i++) {
		state = (state * 1103515245 + 12345) & 0x7fff_ffff;
		out[i] = (state >>> 16) & 0xff;
	}
	return out;
};

/** Drives a target the way an `Output` does: `_write` only accumulates, so the flush matters. */
const sendThrough = async (target: RistTarget, chunks: Uint8Array[]) => {
	target._setMonotonicity(true);
	target._start();

	// The handshake, and the key exchange when a secret is set, happen after the context starts. Writing
	// straight away loses the early payloads - which presents as a partial stream, not as a failure.
	await sleep(1000);

	let position = 0;
	for (const chunk of chunks) {
		target._write(chunk, position);
		position += chunk.byteLength;
		await sleep(20);
	}
	await target._flush();
};

/**
 * Runs a `RistTarget` against librist's own `ristreceiver`, returning what the receiver put back out on
 * UDP. The receiver's log comes back too: a profile or key disagreement presents there, and reads as a
 * plain delivery failure without it.
 */
const againstRistReceiver = async (
	port: number,
	out: number,
	options: RistTargetOptions,
	receiverArgs: string[],
	bytes = 1316 * 12,
	receiverQuery = '',
) => {
	const received: Buffer[] = [];
	const udp = createSocket('udp4');
	udp.on('message', message => received.push(message));
	await new Promise<void>(resolve => udp.bind(out, '127.0.0.1', resolve));

	const receiver = spawn('ristreceiver', [
		'-i', `rist://@127.0.0.1:${port}?buffer=${RECEIVER_BUFFER_MS}${receiverQuery}`,
		'-o', `udp://127.0.0.1:${out}`,
		...receiverArgs,
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let receiverLog = '';
	receiver.stderr.on('data', (chunk: Buffer) => {
		receiverLog += chunk.toString();
	});

	await sleep(2000);

	const target = new RistTarget(`rist://127.0.0.1:${port}`, options);
	const payload = filler(bytes);
	// Chunked unevenly on purpose: a muxer writes at its own convenience, not in RIST payloads
	const chunks = [payload.subarray(0, 700), payload.subarray(700, 5000), payload.subarray(5000)];
	await sendThrough(target, chunks);

	await sleep(2500);
	await target._close();
	receiver.kill('SIGINT');
	await sleep(400);
	udp.close();

	return { target, payload, received, receiverLog };
};

ristTest('RistTarget delivers to ristreceiver, byte for byte', async () => {
	const { target, payload, received, receiverLog } = await againstRistReceiver(9900, 9800, {}, []);

	expect(receiverLog).not.toContain('Non conformant');

	const joined = Buffer.concat(received);
	expect(joined.byteLength).toBe(payload.byteLength);
	expect(joined.equals(Buffer.from(payload))).toBe(true);

	// The counters, against what was actually handed over: 12 whole payloads and nothing left pending
	expect(target.sentPackets).toBe(12);
	expect(target.sentBytes).toBe(payload.byteLength);
	expect(target.retransmittedPackets).toBe(0);
}, 60_000);

ristTest('a trailing partial payload is still delivered', async () => {
	const odd = 1316 * 3 + 517;
	const { target, payload, received } = await againstRistReceiver(9904, 9804, {}, [], odd);

	expect(target.sentPackets).toBe(4);
	expect(target.sentBytes).toBe(odd);
	expect(Buffer.concat(received).equals(Buffer.from(payload))).toBe(true);
}, 60_000);

ristTest('a matching secret delivers and the receiver reports encryption on', async () => {
	const { target, payload, received, receiverLog } = await againstRistReceiver(
		9908, 9808, { secret: 'a-good-passphrase', aesType: 256 }, [], 1316 * 12,
		'&secret=a-good-passphrase&aes-type=256',
	);

	// Both ends must state the key length. The receiver's own `-s` flag defaults to AES-128, and a
	// sender at 256 against it logs `Malformed packet, rtp flag value is 2d instead of 0x80` and never
	// completes the handshake - which reads like a corrupt stream rather than a key length disagreement.
	expect(receiverLog).toContain('Using 256 bits secret key');
	expect(receiverLog).not.toContain('Encryption is disabled for this peer');
	expect(Buffer.concat(received).equals(Buffer.from(payload))).toBe(true);
	expect(target.sentPackets).toBe(12);
}, 60_000);

ristTest('a wrong secret delivers nothing', async () => {
	const { received } = await againstRistReceiver(
		9912, 9812, { secret: 'a-good-passphrase', aesType: 256 }, [], 1316 * 12,
		'&secret=the-wrong-passphrase&aes-type=256',
	);

	expect(received).toHaveLength(0);
}, 60_000);

// EAP-SRP does not complete yet, so this is skipped rather than red or deleted, and `RistTarget` exposes
// no `auth` option - an option that silently fails to authenticate is worse than an absent one.
//
// Where it stops, against `ristreceiver -F <ristsrppasswd file>`: credentials belong in the URL
// (`?username=&password=`), not in a `rist_enable_eap_srp` call. With the call, the receiver logs
// `Failed to process EAPOL pkt, return code: -1` every half second; with the URL those stop and the
// receiver logs `Peer has been authenticated` for one peer, then `Waiting for EAP authentication to
// happen for peer connecting on port N` forever for another. Main profile carries more than one peer and
// it is the data peer that never authenticates. The receiver also reports `Encryption is disabled for
// this peer` throughout, so whatever key SRP should derive is not reaching the data path either.
//
// Read against librist 0.2.20's own source, that is a gap in librist and not in this binding - three
// places make it, so no option passed from here can close it:
//   - `rist-common.c:4006` gates per peer: a non-EAPOL payload from a peer whose own `eap_ctx` is not
//     authenticated is dropped, and that is the `Waiting for EAP authentication` log.
//   - `eap.c:1164 eap_clone_ctx` copies `config` and `srp_legacy_pad` only, so a peer discovered later
//     starts out unauthenticated rather than inheriting the parent's state.
//   - `rist-common.c:3718` clones that context onto the new peer and then calls
//     `_librist_proto_eap_start` only `if (p->multicast_receiver)`. Nothing starts EAP for a unicast
//     peer, and the authenticatee's own start (`eap.c:1572`) already ran, on the peer that existed when
//     the credentials were set.
// So the first peer authenticates, the data peer librist discovers afterwards never initiates, and the
// gate drops its traffic for the life of the session.
test.skip('EAP-SRP credentials authenticate, and a wrong password does not', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mb-srp-'));
	try {
		// The verifier lines come from librist's own tool; a hand-written file would test this against itself
		const entry = execFileSync('ristsrppasswd', ['alice', 'hunter2hunter2'], { encoding: 'utf8' });
		expect(entry.startsWith('alice:')).toBe(true);
		const srpFile = path.join(dir, 'srp.txt');
		writeFileSync(srpFile, entry);

		const good = await againstRistReceiver(9916, 9816, {}, ['-F', srpFile]);
		expect(Buffer.concat(good.received).equals(Buffer.from(good.payload))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

/**
 * Forwards one UDP port pair between a sender and a receiver, dropping every `dropEvery`-th datagram on
 * the way out. Deterministic rather than random, so the test is not flaky.
 *
 * Only the sender-to-receiver direction loses anything: dropping the reverse would discard the NACKs
 * this test exists to provoke, and the run would then prove nothing at all.
 */
const lossyRelay = async (listenPort: number, forwardPort: number, dropEvery: number) => {
	const sockets: ReturnType<typeof createSocket>[] = [];
	let forwarded = 0;
	let dropped = 0;

	for (const offset of [0, 1]) {
		const socket = createSocket('udp4');
		let senderAddress: { address: string; port: number } | null = null;

		socket.on('message', (message, from) => {
			const fromReceiver = from.port === forwardPort + offset;
			if (fromReceiver) {
				if (senderAddress) {
					socket.send(message, senderAddress.port, senderAddress.address);
				}
				return;
			}

			senderAddress = { address: from.address, port: from.port };
			// Only the media port loses packets; the RTCP port carries the NACKs
			if (offset === 0 && ++forwarded % dropEvery === 0) {
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

// The retransmission counter is the one thing only librist can report, and `toBe(0)` elsewhere would
// pass just as well if it were wired to nothing. This makes it move: 1 in 60 datagrams is dropped
// between the two, and the receiver must still get every byte, recovered inside its buffer window.
ristTest('packets lost in flight are retransmitted and the stream arrives whole', async () => {
	const relayPort = 9940;
	const receiverPort = 9950;
	const out = 9860;

	const received: Buffer[] = [];
	const udp = createSocket('udp4');
	udp.on('message', message => received.push(message));
	await new Promise<void>(resolve => udp.bind(out, '127.0.0.1', resolve));

	const receiver = spawn('ristreceiver', [
		'-i', `rist://@127.0.0.1:${receiverPort}?buffer=${RECEIVER_BUFFER_MS}`,
		'-o', `udp://127.0.0.1:${out}`,
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let receiverLog = '';
	receiver.stderr.on('data', (chunk: Buffer) => {
		receiverLog += chunk.toString();
	});

	const relay = await lossyRelay(relayPort, receiverPort, 60);
	await sleep(2000);

	const target = new RistTarget(`rist://127.0.0.1:${relayPort}`, { retransmitBufferMs: 1000 });
	const payload = filler(1316 * 240);
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < payload.byteLength; at += 1316 * 10) {
		chunks.push(payload.subarray(at, Math.min(at + 1316 * 10, payload.byteLength)));
	}
	await sendThrough(target, chunks);

	await sleep(3000);
	await target._close();
	relay.stop();
	receiver.kill('SIGINT');
	await sleep(400);
	udp.close();

	const { dropped } = relay.counts();

	// The relay really did lose packets, or there was nothing to recover from and the rest means nothing
	expect(dropped).toBeGreaterThan(0);
	expect(receiverLog).not.toContain('Non conformant');

	// Recovered: every byte present despite the loss
	expect(Buffer.concat(received).equals(Buffer.from(payload))).toBe(true);

	// And librist says it resent them, which is the counter being wired to something
	expect(target.retransmittedPackets).toBeGreaterThan(0);
	expect(target.retransmittedBytes).toBeGreaterThan(0);
}, 120_000);

// Everything librist is told about a peer travels in this URL, so it is the boundary worth asserting:
// what librist then does with `buffer` is librist's own behaviour, not this package's. The recovery test
// above cannot pin the sender's window down - over a local relay the round trip is under a millisecond,
// so even a 5ms window answers every NACK in time - which is why the mapping is checked here instead.
test('the URL handed to librist carries the resolved peer', () => {
	const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
	const base = { listener: false, profile: 'main', bufferMs: 1000 } as const;

	expect(query(peerUrl('rist://1.2.3.4:5000', base))).toEqual({ buffer: '1000', profile: '1' });

	expect(query(peerUrl('rist://1.2.3.4:5000', {
		listener: false,
		profile: 'simple',
		bufferMs: 250,
		secret: 'hunter2',
		aesType: 128,
		bandwidthKbps: 6000,
	}))).toEqual({
		buffer: '250',
		profile: '0',
		secret: 'hunter2',
		'aes-type': '128',
		bandwidth: '6000',
	});

	// A listener binds the URL's ports instead of sending to them, which librist spells with a leading @
	expect(peerUrl('rist://1.2.3.4:5000', { ...base, listener: true })).toContain('rist://@1.2.3.4:5000?');
	expect(peerUrl('rist://1.2.3.4:5000', base)).toContain('rist://1.2.3.4:5000?');

	// AES is only reached through a secret, so a key length on its own must not look like encryption
	expect(query(peerUrl('rist://1.2.3.4:5000', { ...base, aesType: 256 }))['aes-type']).toBeUndefined();

	expect(() => peerUrl('srt://1.2.3.4:5000', base)).toThrow(TypeError);
});

// Both halves of this package against each other. It proves the two agree, which the interop tests
// against librist's own tools already settle for the wire - what it adds is the Source's own read loop,
// its silence deadline and the cancellation path, none of which ristsender exercises.
ristTest('RistTarget to RistSource carries the bytes unchanged', async () => {
	const port = 9960;
	const payload = filler(1316 * 8);

	const source = new RistSource(`rist://127.0.0.1:${port}`, { bufferMs: 100, readTimeout: 8 });
	const reader = source._stream.getReader();

	await sleep(1500);

	const target = new RistTarget(`rist://127.0.0.1:${port}`, {});
	await sendThrough(target, [payload.subarray(0, 4000), payload.subarray(4000)]);

	const chunks: Uint8Array[] = [];
	let total = 0;
	const deadline = Date.now() + 15_000;
	while (total < payload.byteLength && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			chunks.push(value);
			total += value.byteLength;
		}
	}

	await target._close();
	await reader.cancel();

	expect(Buffer.concat(chunks.map(c => Buffer.from(c))).equals(Buffer.from(payload))).toBe(true);
}, 60_000);

// RistSource against librist's own sender, which is the only test that settles the wire for the read
// side: a round trip against this package's own target would pass even if both halves were wrong
// together.
ristTest('RistSource reads what ristsender sends, byte for byte', async () => {
	const port = 9970;
	const feed = 9870;

	const source = new RistSource(`rist://127.0.0.1:${port}`, { bufferMs: 100, readTimeout: 10 });
	const reader = source._stream.getReader();

	const sender = spawn('ristsender', [
		'-i', `udp://@127.0.0.1:${feed}`,
		'-o', `rist://127.0.0.1:${port}?buffer=100`,
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let senderLog = '';
	sender.stderr.on('data', (chunk: Buffer) => {
		senderLog += chunk.toString();
	});

	await sleep(2500);

	const sent = payloads(16);
	const udp = createSocket('udp4');
	for (const payload of sent) {
		await new Promise<void>(resolve => udp.send(payload, feed, '127.0.0.1', () => resolve()));
		await sleep(25);
	}
	udp.close();

	const got: Uint8Array[] = [];
	const deadline = Date.now() + 15_000;
	while (got.length < sent.length && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			got.push(value);
		}
	}

	sender.kill('SIGINT');
	await sleep(300);
	await reader.cancel();

	expect(senderLog).not.toContain('Non conformant');
	expect(got).toHaveLength(sent.length);
	for (const [index, payload] of got.entries()) {
		expect(Buffer.from(payload).equals(Buffer.from(sent[index]!))).toBe(true);
	}
}, 60_000);

// The silence deadline is what ends a stream whose sender has gone away, so a consumer is not left
// waiting on a reader that never resolves.
ristTest('a source with no sender ends on its read timeout', async () => {
	const source = new RistSource('rist://127.0.0.1:9974', { bufferMs: 100, readTimeout: 2 });
	const reader = source._stream.getReader();

	const startedAt = Date.now();
	const { done } = await reader.read();
	const elapsed = Date.now() - startedAt;

	expect(done).toBe(true);
	// Bounded on both sides: closing early would truncate a slow stream, never closing would hang
	expect(elapsed).toBeGreaterThanOrEqual(1800);
	expect(elapsed).toBeLessThan(9000);
}, 30_000);

// The main-profile GRE tunnel, which carries arbitrary packets beside the media. There is no control
// against librist's own tools - they reach the tunnel only through a TUN device (`-t`), which needs root
// - but librist encodes and decodes both ends, so a wrong `rist_oob_block` layout or return-code
// reading cannot survive this.
//
// Both return codes in oob.h are wrong about their own implementation: `rist_oob_write` returns 0 on
// SUCCESS, and `rist_oob_read` returns >=1 when it hands over a packet. Reading them as the header
// states makes a working tunnel look dead.
ristTest('the GRE tunnel carries packets both ways alongside the media', async () => {
	const port = 9980;
	const media = filler(1316 * 4);
	const upstream = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]);
	const downstream = new Uint8Array(200).fill(0x5a);

	const source = new RistSource(`rist://127.0.0.1:${port}`, {
		bufferMs: 100,
		readTimeout: 8,
		tunnel: true,
	});
	const reader = source._stream.getReader();

	await sleep(1500);

	const target = new RistTarget(`rist://127.0.0.1:${port}`, { tunnel: true });
	await sendThrough(target, [media]);

	target.sendTunnelPacket(downstream);
	source.sendTunnelPacket(upstream);

	/** Polls both ends, since librist queues tunnel packets rather than pushing them. */
	const drain = async () => {
		let atSource: Uint8Array | null = null;
		let atTarget: Uint8Array | null = null;
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && (!atSource || !atTarget)) {
			atSource ??= source.readTunnelPacket();
			atTarget ??= target.readTunnelPacket();
			await sleep(100);
		}
		return { atSource, atTarget };
	};
	const { atSource, atTarget } = await drain();

	// The media must still arrive: the tunnel shares the GRE layer with it
	const chunks: Uint8Array[] = [];
	let total = 0;
	const mediaDeadline = Date.now() + 8000;
	while (total < media.byteLength && Date.now() < mediaDeadline) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			chunks.push(value);
			total += value.byteLength;
		}
	}

	await target._close();
	await reader.cancel();

	expect(atSource).not.toBeNull();
	expect(Buffer.from(atSource!).equals(Buffer.from(downstream))).toBe(true);
	expect(atTarget).not.toBeNull();
	expect(Buffer.from(atTarget!).equals(Buffer.from(upstream))).toBe(true);
	expect(Buffer.concat(chunks.map(c => Buffer.from(c))).equals(Buffer.from(media))).toBe(true);
}, 90_000);

test('the tunnel is refused on simple profile, which has no GRE layer', () => {
	expect(() => new RistTarget('rist://127.0.0.1:9984', { tunnel: true, profile: 'simple' }))
		.toThrow(TypeError);
	expect(() => new RistSource('rist://127.0.0.1:9984', { tunnel: true, profile: 'simple' }))
		.toThrow(TypeError);
	expect(() => checkPeerOptions('rist://1.2.3.4:5000', { profile: 'main', tunnel: true })).not.toThrow();
});

// The methods refuse rather than silently no-op when the tunnel was never enabled. Gated, because
// constructing a target opens a librist context.
ristTest('the tunnel methods refuse when the tunnel is off', () => {
	const target = new RistTarget('rist://127.0.0.1:9988', {});
	expect(() => target.readTunnelPacket()).toThrow();
	expect(() => target.sendTunnelPacket(new Uint8Array([1]))).toThrow();
});

// Simple profile accepts a secret and logs `Using 256 bits secret key` on both ends, but does not
// enforce it: measured, a receiver holding a DIFFERENT secret still received the stream, where the same
// mismatch under main profile delivers nothing. A secret that reads as protection and provides none is
// refused rather than documented.
test('a secret is refused on simple profile, which does not enforce one', () => {
	expect(() => new RistTarget('rist://127.0.0.1:9790', { profile: 'simple', secret: 'hunter2' }))
		.toThrow(TypeError);
	expect(() => new RistSource('rist://127.0.0.1:9790', { profile: 'simple', secret: 'hunter2' }))
		.toThrow(TypeError);
	expect(() => new RistTarget('rist://127.0.0.1:9790', { profile: 'simple', aesType: 256 }))
		.toThrow(TypeError);

	// The accepting cases go through the validator, not a constructor: constructing either class opens a
	// librist context eagerly, and whether a given librist build parses a URL is a different question
	expect(() => checkPeerOptions('rist://1.2.3.4:5000', { profile: 'main', secret: 'hunter2' }))
		.not.toThrow();
	expect(() => checkPeerOptions('rist://1.2.3.4:5000', { profile: 'simple' })).not.toThrow();
});
