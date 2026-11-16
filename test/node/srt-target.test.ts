/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SrtTarget is a byte sink, so most of these drive it through the Target protocol directly rather than
// through a muxer: what has to hold is that the bytes handed in are the bytes that come out, and no
// amount of TS muxing in between makes that clearer. One test goes through MpegTsOutputFormat for the
// real path. Everything runs over loopback.

import { waitUntil } from './_network-test.js';
import { describe, expect, test } from 'vitest';
import { NetworkSource, SrtTarget, registerMediabunnyServer } from '@mediabunny/server';
import type { SrtTargetOptions } from '@mediabunny/server';
import { __resetSecretRedactingLogForTests } from '../../packages/server/src/misc.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { bytesToHexString } from '../../src/misc.js';
import { InvalidUsageError } from '../../src/errors.js';
import { TargetWriter } from '../../src/target-writer.js';

registerMediabunnyServer();

// Below every ephemeral range - macOS allocates from 49152 and Linux from 32768 - so an outgoing socket
// in this same process is never handed a port one of these listeners is about to bind. Picking inside
// that range gives an EADDRINUSE that looks exactly like a flaky network. Also clear of the suite's
// other live bands: rtmp-input 19000+, live-network-input 21000+, rist-input 25000+.
let nextPort = 17_000 + Math.floor(Math.random() * 800);
const freePort = () => nextPort++;

/** Deterministic filler, so a byte that arrives out of place is visible rather than plausible. */
const filler = (bytes: number): Uint8Array => {
	const out = new Uint8Array(bytes);
	let state = 0x2b;
	for (let i = 0; i < bytes; i++) {
		state = (state * 1103515245 + 12345) & 0x7fff_ffff;
		out[i] = (state >>> 16) & 0xff;
	}
	return out;
};

/**
 * Drives a target the way an `Output` does, which is the only way to hand it exact bytes, and stops
 * short of closing. The `_flush` matters: `_write` only accumulates, so without it nothing reaches the
 * socket at all.
 *
 * Closing is left to the caller because a receiver may lose what is still buffered when the sender
 * closes - ffmpeg's SRT read reports EOF on a broken connection rather than draining first. So a test
 * that wants every byte reads them while the sender is still connected, and closes afterwards.
 */
const startSending = async (target: SrtTarget, chunks: Uint8Array[]) => {
	target._setMonotonicity(true);
	target._start();

	let position = 0;
	for (const chunk of chunks) {
		target._write(chunk, position);
		position += chunk.byteLength;
	}
	await target._flush();
};

/**
 * The receiver listens and the target dials it. That ordering is deterministic - a listener is bound
 * before it is read from, so nothing has to retry - and it is also the common deployment, a packager
 * pushing to a waiting receiver. The reverse pairing is exercised by the late-caller test alone, where
 * the target listening is the thing under test.
 */
const listeningSource = (port: number, transtype = 'file'): NetworkSource =>
	new NetworkSource(
		`srt://0.0.0.0:${port}?mode=listener&transtype=${transtype}`,
		{ connectTimeout: 25, readTimeout: 25 },
	);

/**
 * Byte-exact tests run SRT's reliable mode. `live` is latency-bounded and drops rather than
 * retransmitting past its window, so on a loaded runner it loses whole datagrams - 6 of 40 on CI once.
 * Asserting lossless delivery of a lossy transport measures the runner's spare capacity, not this code.
 * What `live` is held to has its own test below: everything handed to the socket, nothing dropped by us.
 */
const reliableTarget = (port: number, options: SrtTargetOptions = {}): SrtTarget =>
	new SrtTarget(`srt://127.0.0.1:${port}?transtype=file`, { connectTimeout: 20, ...options });

/** The chunk the connect had to take to know it had connected, so the caller does not lose it. */
type Connected = { source: NetworkSource; first: Uint8Array };

/**
 * A caller dialling a listener that is still binding gets EIO, so it retries. Only the tests where the
 * target is the listener need this, since it binds on its first flush.
 */
const connect = async (port: number, transtype = 'file'): Promise<Connected> => {
	let last: unknown = new Error(`srt://127.0.0.1:${port} never answered.`);

	for (let attempt = 1; attempt <= 40; attempt++) {
		// Both ends have to agree on transtype, or the handshake fails with EIO
		const source = new NetworkSource(
			`srt://127.0.0.1:${port}?transtype=${transtype}`,
			{ connectTimeout: 5, readTimeout: 25 },
		);
		const reader = source._stream.getReader();
		try {
			const { done, value } = await reader.read();
			// A stream that ends on its first read never reached a sender, so it is a failed attempt too
			if (!done && value && value.byteLength > 0) {
				reader.releaseLock();
				return { source, first: value };
			}
			await reader.cancel().catch(() => {});
		} catch (error) {
			last = error;
			reader.releaseLock();
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}

	throw last;
};

/** Compares by length and first difference, since a truncated hex diff of 50 kB names nothing. */
const expectSameBytes = (received: Uint8Array, expected: Uint8Array) => {
	if (received.byteLength !== expected.byteLength) {
		throw new Error(`received ${received.byteLength} bytes, expected ${expected.byteLength}`);
	}
	for (let i = 0; i < expected.byteLength; i++) {
		if (received[i] !== expected[i]) {
			throw new Error(
				`byte ${i} of ${expected.byteLength} is 0x${received[i]!.toString(16)},`
				+ ` expected 0x${expected[i]!.toString(16)}`,
			);
		}
	}
};

const readAll = async (
	source: NetworkSource,
	expectedBytes: number,
	timeoutMs: number,
	first?: Uint8Array,
) => {
	const received: Uint8Array[] = [];
	let total = 0;

	if (first) {
		received.push(first);
		total += first.byteLength;
	}

	// The source's own stream, since what is under test is the bytes it receives, not a demux
	const reader = source._stream.getReader();
	const deadline = Date.now() + timeoutMs;
	while (total < expectedBytes && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			received.push(value);
			total += value.byteLength;
		}
	}
	await reader.cancel().catch(() => {});

	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of received) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
};

test('a calling target and a listening source carry the bytes unchanged', async () => {
	const port = freePort();
	const payload = filler(1316 * 40);
	// The receiver is bound before the sender dials, so neither side has to retry into the other
	const source = listeningSource(port);
	const target = reliableTarget(port);
	const reading = readAll(source, payload.byteLength, 25_000);
	await startSending(target, [payload]);
	const received = await reading;
	await target._finalize();

	expectSameBytes(received, payload);
	expect(target.sentBytes).toBe(payload.byteLength);
	expect(target.droppedBytes).toBe(0);
}, 120_000);

test('a short final datagram is written, so a stream need not be a payload multiple', async () => {
	const port = freePort();
	// 1316 * 2 + 7: the remainder has to go out on close rather than be held back
	const whole = 1316 * 2;
	const payload = filler(whole + 7);
	const source = listeningSource(port);
	const target = reliableTarget(port);

	// The two full datagrams go out on the flush, so they can be drained while the sender is connected
	const reading = readAll(source, whole, 25_000);
	await startSending(target, [payload]);
	const received = await reading;
	expectSameBytes(received.subarray(0, whole), payload.subarray(0, whole));

	// The 7-byte remainder is only written by close, and a receiver can lose what is buffered when the
	// sender closes - so that it was written is the claim, which does not depend on the drain
	await target._finalize();
	expect(target.sentBytes).toBe(payload.byteLength);
	expect(target.droppedBytes).toBe(0);
}, 120_000);
test('many small writes are regrouped into whole datagrams', async () => {
	const port = freePort();
	const payload = filler(1316 * 10);
	// 188 at a time is what a TS muxer hands over, well under one datagram
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < payload.byteLength; at += 188) {
		chunks.push(payload.subarray(at, at + 188));
	}
	const source = listeningSource(port);
	const target = reliableTarget(port);
	const reading = readAll(source, payload.byteLength, 25_000);
	await startSending(target, chunks);
	const received = await reading;
	await target._finalize();

	expectSameBytes(received, payload);
}, 120_000);

test('in live mode everything is handed to the socket and nothing is dropped by us', async () => {
	const port = freePort();
	const payload = filler(1316 * 40);
	// Live is the default, and the claim is about this target's accounting rather than SRT's delivery:
	// a latency-bounded transport may discard datagrams, and that is not the same as the target dropping
	// them for a full queue. Whatever arrives is SRT's business; what we handed it is ours.
	const source = listeningSource(port, 'live');
	const target = new SrtTarget(`srt://127.0.0.1:${port}`, { connectTimeout: 20, latencyMs: 500 });
	const reading = readAll(source, payload.byteLength, 25_000);
	await startSending(target, [payload]);
	const received = await reading;
	await target._finalize();

	expect(target.sentBytes).toBe(payload.byteLength);
	expect(target.droppedBytes).toBe(0);
	expect(received.byteLength).toBeGreaterThan(0);
	expect(received.byteLength).toBeLessThanOrEqual(payload.byteLength);
}, 120_000);

test('a caller that arrives late still gets every byte', async () => {
	const port = freePort();
	const payload = filler(1316 * 8);
	const target = new SrtTarget(`srt://0.0.0.0:${port}?mode=listener&transtype=file`, {
		connectTimeout: 25,
	});

	// The target parks in accept here; nothing is listening on the other side yet
	const sending = startSending(target, [payload]);
	await new Promise(resolve => setTimeout(resolve, 1_500));

	const connected = await connect(port);
	const received = await readAll(connected.source, payload.byteLength, 25_000, connected.first);
	await sending;
	await target._finalize();

	expectSameBytes(received, payload);
}, 120_000);
test('a passphrase mismatch is refused rather than carried in the clear', async () => {
	const port = freePort();
	const payload = filler(1316 * 4);
	const source = new NetworkSource(`srt://0.0.0.0:${port}?mode=listener&transtype=file`, {
		connectTimeout: 10,
		readTimeout: 10,
		passphrase: 'wrong-horse-battery',
		keyLength: 256,
	});
	const target = reliableTarget(port, {
		connectTimeout: 10,
		passphrase: 'correct-horse-battery',
		keyLength: 256,
	});

	const sending = startSending(target, [payload])
		.then(() => target._finalize())
		.then(() => 'sent', (error: unknown) => error);
	const reading = readAll(source, payload.byteLength, 15_000).catch((error: unknown) => error);
	const [sendResult, readResult] = await Promise.all([sending, reading]);

	// The claim is only that nothing crossed. Which side reports it is SRT's business: the receiver's
	// handshake is rejected, and the sender then finds no peer and times out on its own accept.
	const receivedBytes = readResult instanceof Uint8Array ? readResult.byteLength : 0;
	expect(receivedBytes).toBe(0);
	expect(sendResult === 'sent' || sendResult instanceof Error).toBe(true);
}, 120_000);
test('a matching passphrase carries the bytes', async () => {
	const port = freePort();
	const payload = filler(1316 * 6);
	const passphrase = 'correct-horse-battery';
	// Through the option on both sides, which is what keeps it out of the messages either end throws
	const source = new NetworkSource(`srt://0.0.0.0:${port}?mode=listener&transtype=file`, {
		connectTimeout: 25,
		readTimeout: 25,
		passphrase,
		keyLength: 128,
	});
	const target = reliableTarget(port, { passphrase, keyLength: 128 });

	const reading = readAll(source, payload.byteLength, 25_000);
	await startSending(target, [payload]);
	const received = await reading;
	await target._finalize();

	expectSameBytes(received, payload);
}, 120_000);
test('a receiver that goes away stops the bytes and errors on close', async () => {
	const port = freePort();
	const target = new SrtTarget(`srt://0.0.0.0:${port}?mode=listener`, {
		connectTimeout: 20,
		// Small, so the queue overflows soon after the receiver leaves rather than after megabytes
		maxQueueBytes: 1316 * 32,
	});

	target._setMonotonicity(true);
	target._start();

	const opening = filler(1316);
	target._write(opening, 0);
	const flushing = target._flush().catch(() => {});
	// Live, matching this target: what is under test is the send buffer filling behind a departed peer
	const { source } = await connect(port, 'live');
	await flushing;
	expect(target.sentBytes).toBeGreaterThan(0);

	await source._stream.cancel().catch(() => {});

	// Keep pushing past the departure. This has to stay bounded and finish, not park forever.
	let position = opening.byteLength;
	for (let i = 0; i < 400; i++) {
		target._write(filler(1316), position);
		position += 1316;
		await target._flush().catch(() => {});
	}

	// Bounded: the queue caps and the rest is dropped and counted
	expect(target.droppedBytes).toBeGreaterThan(0);

	// And the departure is reported rather than swallowed
	const outcome = await target._finalize().then(() => 'finished', (error: unknown) => error);
	expect(outcome).toBeInstanceOf(Error);
	expect((outcome as Error).message).toMatch(/peer stopped accepting data/);
}, 180_000);

test('closing a listener nobody dialled does not wait out its accept', async () => {
	const port = freePort();
	// 20 s, so a close that waits out the accept is unmistakable against one that wakes it
	const target = new SrtTarget(`srt://0.0.0.0:${port}?mode=listener`, { connectTimeout: 20 });

	target._setMonotonicity(true);
	target._start();
	target._write(filler(1316), 0);
	await target._flush().catch(() => {});

	// The pump is parked in the native accept now, which a close cannot interrupt - it has to be dialled
	const started = Date.now();
	await target._finalize().catch(() => {});
	const elapsed = Date.now() - started;

	expect(elapsed).toBeLessThan(5_000);
}, 120_000);

test('a receiver that is too slow is dropped for, and the drops are counted', async () => {
	const port = freePort();
	// A queue of one datagram, so anything written while the pump is busy is dropped
	const target = new SrtTarget(`srt://0.0.0.0:${port}?mode=listener`, {
		connectTimeout: 20,
		maxQueueBytes: 1316,
	});

	target._setMonotonicity(true);
	target._start();

	// No receiver ever arrives, so the pump parks in accept and everything after the first write queues.
	// Each write is flushed on its own, since _write alone only accumulates inside the StreamTarget.
	let position = 0;
	for (let i = 0; i < 200; i++) {
		target._write(filler(1316), position);
		position += 1316;
		await target._flush();
	}

	expect(target.droppedBytes).toBeGreaterThan(0);
	expect(target.droppedDatagrams).toBeGreaterThan(0);
	// Nothing reached a peer, so the drop accounting is the whole story minus what is still queued
	expect(target.sentBytes).toBe(0);
	expect(target.droppedBytes).toBeLessThanOrEqual(position);

	await target._finalize().catch(() => {});
}, 120_000);

// A relay wants the bytes a source received, not demuxed tracks. `Source.readRange` is the public way to
// get them - no byte-stream API of its own is needed - and reading forward is the access pattern
// ReadableStreamSource's cache is sized for.
test('a source hands back the raw bytes it received, through readRange', async () => {
	const port = freePort();
	const payload = filler(1316 * 20);
	const source = listeningSource(port);
	const target = reliableTarget(port);

	const reading = (async () => {
		const out: number[] = [];
		// Forward only, a datagram at a time, which is how a relay would copy a PID-for-PID stream
		for (let at = 0; at < payload.byteLength; at += 1316) {
			const chunk = await source.readRange(at, Math.min(at + 1316, payload.byteLength));
			if (chunk === null) {
				break;
			}
			out.push(...chunk);
		}
		return new Uint8Array(out);
	})();

	await startSending(target, [payload]);
	const received = await reading;
	await target._finalize();

	expectSameBytes(received, payload);
}, 120_000);

// MP4 stores H.264 length-prefixed and MPEG-TS stores it Annex-B, so the control cannot be the source
// file - it has to be the same conversion written to a buffer. What this adds over the byte-identity
// tests above is that a real muxer's write pattern survives the transport.
test('MPEG-TS written over SRT demuxes to the same packets the same conversion to a buffer gives', async () => {
	const port = freePort();
	const demoPath = new URL('../public/demo.mp4', import.meta.url).pathname;

	const packetsOf = async (input: Input) => {
		const track = (await input.getPrimaryVideoTrack())!;
		const out: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			out.push(bytesToHexString(packet.data));
		}
		return out;
	};

	const convert = async (target: SrtTarget | BufferTarget) => {
		using input = new Input({ source: new FilePathSource(demoPath), formats: ALL_FORMATS });
		const output = new Output({ format: new MpegTsOutputFormat(), target });
		await (await Conversion.init({ input, output, showWarnings: false })).execute();
	};

	// MP4 stores H.264 length-prefixed and MPEG-TS stores it Annex-B, so the control cannot be the source
	// file - it has to be the same conversion written to a buffer.
	const buffered = new BufferTarget();
	await convert(buffered);
	using control = new Input({
		source: new BufferSource(new Uint8Array(buffered.buffer!)),
		formats: ALL_FORMATS,
	});
	const expected = await packetsOf(control);
	expect(expected.length).toBeGreaterThan(10);

	// A Conversion closes its own output, so the socket cannot be held open while the receiver drains -
	// and a receiver can lose what is still buffered when the sender closes. So the claim here is that
	// what arrives is uncorrupted and in order, not that the tail of the file made it.
	const source = listeningSource(port);
	const reading = readAll(source, buffered.buffer!.byteLength, 30_000);
	const target = reliableTarget(port, { connectTimeout: 25 });
	await convert(target);
	const received = await reading;

	using overSrt = new Input({ source: new BufferSource(received), formats: ALL_FORMATS });
	const got = await packetsOf(overSrt);

	expect(got.length).toBeGreaterThan(expected.length * 0.8);
	expect(got.length).toBeLessThanOrEqual(expected.length);

	// Every access unit but the last has to match outright
	const whole = got.slice(0, -1);
	expect(whole).toEqual(expected.slice(0, whole.length));

	// The cut lands wherever the sender's close did, which can be partway through a PES - so the final
	// access unit may be short (measured: 1077 bytes of 2976). It still has to be a *prefix* of the one
	// it should have been, which is the difference between losing the tail and garbling it.
	const lastExpected = expected[whole.length]!;
	const lastGot = got[whole.length]!;
	// An empty one would satisfy startsWith without saying anything
	expect(lastGot.length).toBeGreaterThan(0);
	expect(lastExpected.startsWith(lastGot), 'the final access unit is not a prefix of its original')
		.toBe(true);

	expect(target.droppedBytes).toBe(0);
}, 300_000);

// A relay carries bytes that are already a transport stream, so it needs to write them without an
// Output in the way. TargetWriter is that path, and these are the three claims it makes: the bytes
// arrive unchanged, close drains, and flush is where backpressure lands.
describe('TargetWriter over SrtTarget', () => {
	test('bytes written are the bytes readRange hands back', async () => {
		const port = freePort();
		const payload = filler(1316 * 20);
		const source = listeningSource(port);
		const target = reliableTarget(port);
		const writer = new TargetWriter(target);

		const reading = (async () => {
			const out = new Uint8Array(payload.byteLength);
			let at = 0;
			while (at < payload.byteLength) {
				const chunk = await source.readRange(at, Math.min(at + 1316, payload.byteLength));
				if (chunk === null) {
					break;
				}
				out.set(chunk, at);
				at += chunk.byteLength;
			}
			return out.subarray(0, at);
		})();

		// 188 at a time, as a relay copying TS packets would
		for (let at = 0; at < payload.byteLength; at += 188) {
			writer.write(payload.subarray(at, at + 188));
		}
		await writer.flush();
		const received = await reading;
		await writer.close();

		expectSameBytes(received, payload);
		expect(writer.position).toBe(payload.byteLength);
		expect(target.sentBytes).toBe(payload.byteLength);
		expect(target.droppedBytes).toBe(0);
	}, 120_000);

	test('close drains what flush had not written out', async () => {
		const port = freePort();
		// A remainder, so the tail only leaves on close
		const payload = filler(1316 * 3 + 11);
		const source = listeningSource(port);
		const target = reliableTarget(port);
		const writer = new TargetWriter(target);

		const reading = readAll(source, 1316 * 3, 25_000);
		writer.write(payload);
		await writer.flush();
		expectSameBytes((await reading).subarray(0, 1316 * 3), payload.subarray(0, 1316 * 3));

		await writer.close();
		expect(target.sentBytes).toBe(payload.byteLength);
	}, 120_000);

	test('a writer that never wrote closes without opening a socket', async () => {
		const port = freePort();
		const target = new SrtTarget(`srt://127.0.0.1:${port}`, { connectTimeout: 2 });
		const writer = new TargetWriter(target);

		// No write, so no connect was ever attempted and close has nothing to wait for
		const started = Date.now();
		await writer.close();

		expect(Date.now() - started).toBeLessThan(1_000);
		expect(target.sentBytes).toBe(0);
	}, 60_000);

	test('a closed writer refuses further use rather than dropping it silently', async () => {
		const port = freePort();
		const source = listeningSource(port);
		const target = reliableTarget(port);
		const writer = new TargetWriter(target);

		const reading = readAll(source, 1316, 25_000);
		writer.write(filler(1316));
		await writer.flush();
		await reading;
		await writer.close();

		expect(() => writer.write(filler(188))).toThrow(InvalidUsageError);
		await expect(writer.flush()).rejects.toThrow(InvalidUsageError);
		// Closing twice is a no-op, so a caller's cleanup path does not have to track it
		await expect(writer.close()).resolves.toBeUndefined();
	}, 120_000);

	test('zero-length writes and a non-Uint8Array are handled at the boundary', () => {
		const target = new SrtTarget(`srt://127.0.0.1:${freePort()}`, { connectTimeout: 2 });
		const writer = new TargetWriter(target);

		writer.write(new Uint8Array(0));
		expect(writer.position).toBe(0);
		expect(() => writer.write([1, 2, 3] as unknown as Uint8Array)).toThrow(TypeError);
		expect(() => new TargetWriter({} as unknown as SrtTarget)).toThrow(TypeError);
	});
});

// The rest of what a relay needs to see: that a target cannot be driven by two writers at once, that
// the queue's headroom is readable before anything is dropped, and that a departed receiver is reported
// rather than absorbed.
describe('TargetWriter and the relay contract', () => {
	test('a target cannot be driven by a TargetWriter and an Output at once', async () => {
		const target = new SrtTarget(`srt://127.0.0.1:${freePort()}`, { connectTimeout: 2 });
		const writer = new TargetWriter(target);
		expect(writer.position).toBe(0);

		// Whichever comes second loses. An Output takes its writer when it starts, not when it is
		// constructed, so that is where it finds the target already claimed.
		expect(() => new TargetWriter(target)).toThrow(InvalidUsageError);
		await expect(new Output({ format: new MpegTsOutputFormat(), target }).start()).rejects.toThrow();

		const taken = new SrtTarget(`srt://127.0.0.1:${freePort()}`, { connectTimeout: 2 });
		await new Output({ format: new MpegTsOutputFormat(), target: taken }).start();
		expect(() => new TargetWriter(taken)).toThrow(InvalidUsageError);
	});

	test('the queue headroom is readable before anything is dropped', async () => {
		const port = freePort();
		// Nobody ever dials, so the pump parks in accept and everything after the first write queues
		const target = new SrtTarget(`srt://0.0.0.0:${port}?mode=listener`, {
			connectTimeout: 20,
			maxQueueBytes: 1316 * 8,
		});
		const writer = new TargetWriter(target);

		expect(target.maxQueueBytes).toBe(1316 * 8);
		expect(target.queuedBytes).toBe(0);

		// Fill to just under the bound: the caller can see this coming, which is the point
		for (let i = 0; i < 6; i++) {
			writer.write(filler(1316));
			await writer.flush();
		}
		expect(target.queuedBytes).toBeGreaterThan(0);
		expect(target.queuedBytes).toBeLessThanOrEqual(target.maxQueueBytes);
		expect(target.droppedBytes).toBe(0);

		// Past it, and only now does anything go
		for (let i = 0; i < 40; i++) {
			writer.write(filler(1316));
			await writer.flush();
		}
		expect(target.droppedBytes).toBeGreaterThan(0);

		await writer.close().catch(() => {});
	}, 120_000);

	test('a receiver that dies is reported to the writer within a bounded time', async () => {
		const port = freePort();
		const target = new SrtTarget(`srt://0.0.0.0:${port}?mode=listener`, {
			connectTimeout: 20,
			maxQueueBytes: 1316 * 16,
		});
		const writer = new TargetWriter(target);

		writer.write(filler(1316));
		const flushing = writer.flush().catch(() => {});
		const { source } = await connect(port, 'live');
		await flushing;
		await source._stream.cancel().catch(() => {});

		// Push past the departure, then close. One of the two has to report it.
		const started = Date.now();
		let reported: unknown = null;
		for (let i = 0; i < 200 && reported === null; i++) {
			try {
				writer.write(filler(1316));
				await writer.flush();
			} catch (error) {
				reported = error;
			}
		}
		if (reported === null) {
			reported = await writer.close().then(() => null, (error: unknown) => error);
		}

		expect(reported).toBeInstanceOf(Error);
		expect(Date.now() - started).toBeLessThan(60_000);
	}, 180_000);
});

// A datagram is packed to 1316 bytes so each carries whole MPEG-TS packets, so a tail shorter than that
// waits for the bytes that would fill it - which at a low bitrate is latency rather than efficiency.
// `flushPartialDatagram` is the way out, and the point is that it arrives *before* close.
test('a short tail can be flushed on demand, before the target is closed', async () => {
	const port = freePort();
	const payload = filler(1316 + 500); // One full datagram, then 500 bytes that would otherwise wait
	const source = listeningSource(port);
	const target = reliableTarget(port);

	const reading = readAll(source, payload.byteLength, 25_000);
	await startSending(target, [payload]);

	// `_flush` returns once the queue has the bytes; the pump is still connecting at that point
	await waitUntil(() => target.sentBytes > 0, 25_000, 'the first datagram to go out');

	// Only the full datagram has gone: the 500-byte tail is held for the bytes that would fill it
	expect(target.sentBytes).toBe(1316);

	await target.flushPartialDatagram();
	expect(target.sentBytes).toBe(payload.byteLength);

	const received = await reading;
	expectSameBytes(received, payload);

	// Idempotent: nothing is left, so a second call is a no-op rather than a duplicate datagram
	await target.flushPartialDatagram();
	expect(target.sentBytes).toBe(payload.byteLength);

	await target._finalize();
}, 120_000);

// REPRODUCES AN OPEN BUG, so it is skipped rather than left red. A file-mode caller that closes straight
// after its last write loses a tail, and only under load: green on its own, and 1 run in 6 here with two
// other suites alongside - which matches the rate it was reported at. What the measurements say:
//
//   - `sentBytes` always reaches the full payload, so the sender wrote every datagram.
//   - `flush()` and `closep()` both succeed; neither reports an error that the close path swallows.
//   - The receiver's stream ends on EIO (-5) with the tail missing. EIO is how every one of these
//     streams ends, passing runs included, so it is not EIO itself - it is EIO arriving before libsrt
//     hands over what it still holds.
//   - The tail is not a fixed size: 1 datagram in one failure, 3 in another. A short final datagram is
//     not involved, since the payload here is an exact multiple of 1316.
//
// So it is not the drain in `finish()` and not a swallowed error, which were the two cheap explanations.
// `linger` is real and applied (libavformat/libsrt.c sets SO_LINGER when it is >= 0) and this target
// sets it for every transtype. What is left is SRT tearing the connection down before the receiver has
// read what is buffered, which needs a sender-side wait for the peer to acknowledge - something
// libavformat does not expose. Unskip this when that is in.
//
// How much `linger` is worth, measured over 40 attempts of this scenario per value: `linger=0` is short
// on 7, `linger=5` on 3, `linger=30` on 2, and the target's own default on 3 - the same as the explicit
// 5, which is what says the default is applied. So it halves the loss and is worth setting, and raising
// it sixfold does not close the gap, which is what rules out "the send buffer just needs longer" as the
// explanation. The remaining wait is on the peer's acknowledgement (`SRTO_SNDDATA`), and node-av's
// `IOContext` exposes no way to read a socket option back, so there is nothing to wait on from here.
// A smaller sample said the opposite - an explicit `linger=5` was clean 15 times out of 15 - so this
// rate needs tens of attempts per value, not a handful.
test.skip('a file-mode caller that closes straight after its last write loses nothing', async () => {
	for (let attempt = 0; attempt < 6; attempt++) {
		const port = freePort();
		// Exact multiple of the payload size: every datagram is full, so this is the full-datagram path
		const payload = filler(1316 * 12);
		const source = listeningSource(port);
		const target = reliableTarget(port);

		const reading = readAll(source, payload.byteLength, 25_000);
		await startSending(target, [payload]);
		// No drain, no settle: finalize is the next thing after the write
		await target._finalize();

		const received = await reading;
		// sentBytes first: it says whether the sender wrote the datagram at all, which separates a drain
		// bug in finish() from a loss in close or transport
		expect(target.sentBytes, `attempt ${attempt} sentBytes`).toBe(payload.byteLength);
		expect(target.droppedBytes, `attempt ${attempt}`).toBe(0);
		expect(received.byteLength, `attempt ${attempt} received`).toBe(payload.byteLength);
		expectSameBytes(received, payload);
	}
}, 180_000);

describe('a passphrase stays out of every message', () => {
	const SECRET = 'correct-horse-battery';

	/** Everything the fork wrote to stderr while `body` ran, which is where its log callback writes. */
	const stderrDuring = async (body: () => Promise<void>) => {
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
			written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
			return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof process.stderr.write;

		try {
			await body();
		} finally {
			process.stderr.write = original;
		}

		return written.join('');
	};

	test('a refused SrtTarget connect names the passphrase without printing it', async () => {
		const target = reliableTarget(freePort(), { connectTimeout: 2, passphrase: SECRET, keyLength: 256 });

		let thrown: unknown;
		const stderr = await stderrDuring(async () => {
			target._setMonotonicity(true);
			target._start();
			target._write(filler(1316), 0);
			thrown = await target._flush().then(() => null, (error: unknown) => error);
			if (thrown === null) {
				thrown = await target._finalize().then(() => null, (error: unknown) => error);
			}
		});

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		// Redaction is doing work rather than the secret happening to be absent
		expect(message).toContain('passphrase=%5Bredacted%5D');
		expect(message).not.toContain(SECRET);
		expect(message).toMatch(/passphrase and key length/);

		// FFmpeg prints `Connection to <url> failed` from C at AV_LOG_ERROR; the fork's log callback is
		// the only thing that can redact it
		expect(stderr).toContain('failed');
		expect(stderr).not.toContain(SECRET);
	}, 60_000);

	test('a refused NetworkSource read reports the same way', async () => {
		const source = new NetworkSource(`srt://127.0.0.1:${freePort()}?transtype=file`, {
			connectTimeout: 2,
			readTimeout: 2,
			passphrase: SECRET,
			keyLength: 128,
		});

		let thrown: unknown;
		const stderr = await stderrDuring(async () => {
			const reader = source._stream.getReader();
			thrown = await reader.read().then(() => null, (error: unknown) => error);
			reader.releaseLock();
		});

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain('passphrase=%5Bredacted%5D');
		expect((thrown as Error).message).not.toContain(SECRET);
		expect((thrown as Error).message).toMatch(/passphrase and key length/);
		expect(stderr).not.toContain(SECRET);
	}, 60_000);

	test('a secret written into the URL by hand is redacted too', () => {
		// A caller who puts it in the query rather than the options must not be punished for it
		expect(() => new SrtTarget(`srt://127.0.0.1:1?passphrase=${SECRET}`, { latencyMs: -1 }))
			.toThrow(/latencyMs/);
		expect(() => new NetworkSource(`not a url?passphrase=${SECRET}`)).toThrow(TypeError);

		try {
			new NetworkSource(`not a url?passphrase=${SECRET}`);
			expect.unreachable();
		} catch (error) {
			expect((error as Error).message).not.toContain(SECRET);
			expect((error as Error).message).toContain('[redacted]');
		}
	});

	// The redaction used to be installed only by `registerMediabunnyServer`, so a host that constructed
	// these classes directly still got FFmpeg's unredacted `Connection to <url> failed` line. The reset
	// undoes the installation this file's own `registerMediabunnyServer()` performed, so whatever
	// redacts afterwards can only have been installed by the constructor.
	test('a target redacts with no registerMediabunnyServer having run', async () => {
		__resetSecretRedactingLogForTests();

		const target = reliableTarget(freePort(), { connectTimeout: 2, passphrase: SECRET, keyLength: 256 });
		const stderr = await stderrDuring(async () => {
			target._setMonotonicity(true);
			target._start();
			target._write(filler(1316), 0);
			await target._flush().catch(() => {});
			await target._finalize().catch(() => {});
		});

		// The line has to have been printed at all, or this proves nothing. FFmpeg's line is redacted as
		// text, so the marker is literal; a thrown message goes through `redactUrl`, which percent-encodes
		// it via URLSearchParams.
		expect(stderr).toMatch(/failed/);
		expect(stderr).toContain('passphrase=[redacted]');
		expect(stderr).not.toContain(SECRET);
	}, 60_000);

	test('a source redacts with no registerMediabunnyServer having run', async () => {
		__resetSecretRedactingLogForTests();

		const source = new NetworkSource(`srt://127.0.0.1:${freePort()}?transtype=file`, {
			connectTimeout: 2,
			readTimeout: 2,
			passphrase: SECRET,
		});

		const stderr = await stderrDuring(async () => {
			const reader = source._stream.getReader();
			await reader.read().catch(() => {});
			reader.releaseLock();
		});

		expect(stderr).toMatch(/failed/);
		expect(stderr).toContain('passphrase=[redacted]');
		expect(stderr).not.toContain(SECRET);
	}, 60_000);

	test('an out-of-range passphrase or key length is refused at construction', () => {
		for (const make of [
			(options: SrtTargetOptions) => new SrtTarget('srt://127.0.0.1:1', options),
			(options: SrtTargetOptions) => new NetworkSource('srt://127.0.0.1:1', options),
		]) {
			expect(() => make({ passphrase: 'too-short' })).toThrow(/10 to 79 characters/);
			expect(() => make({ passphrase: 'x'.repeat(80) })).toThrow(/10 to 79 characters/);
			expect(() => make({ passphrase: 123 as unknown as string })).toThrow(/10 to 79 characters/);
			expect(() => make({ passphrase: SECRET, keyLength: 64 as unknown as 128 })).toThrow(/128, 192 or 256/);
			// The bound itself holds: 10 and 79 are inside it
			expect(() => make({ passphrase: 'x'.repeat(10) })).not.toThrow();
			expect(() => make({ passphrase: 'x'.repeat(79), keyLength: 192 })).not.toThrow();
		}
	});

	test('a passphrase is refused on a URL that is not SRT', () => {
		expect(() => new NetworkSource('udp://127.0.0.1:1', { passphrase: SECRET })).toThrow(/is SRT's/);
		expect(() => new NetworkSource('http://example.invalid/x', { passphrase: SECRET })).toThrow(/is SRT's/);
	});
});
