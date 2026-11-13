/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// RIST Simple Profile both ways, in process: RistSource listens on the URL's port pair and RistTarget
// calls into it. node-av has no librist, so both sides speak the protocol directly - RTP on the even
// port, RTCP on the odd one - which is what makes this a round trip rather than a mock.

import { expect, test } from 'vitest';
import { RistSource, RistTarget, registerMediabunnyServer } from '@mediabunny/server';
import { createSocket } from 'node:dgram';
import { bytesToHexString } from '../../src/misc.js';

registerMediabunnyServer();

// Even ports, clear of the other live bands: srt-target 17000+, rtmp-target 18200+, rtmp-input 19000+,
// live-network-input 21000+, rist-input 25000+
let nextPort = 16_000 + Math.floor(Math.random() * 200) * 2;
const freePort = () => (nextPort += 2);

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

/** Drives a target the way an `Output` does. `_write` only accumulates, so the flush matters. */
const startSending = async (target: RistTarget, chunks: Uint8Array[]) => {
	target._setMonotonicity(true);
	target._start();

	let position = 0;
	for (const chunk of chunks) {
		target._write(chunk, position);
		position += chunk.byteLength;
	}
	await target._flush();
};

const readAll = async (source: RistSource, expectedBytes: number, timeoutMs: number) => {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = source._stream.getReader();
	const deadline = Date.now() + timeoutMs;

	while (total < expectedBytes && Date.now() < deadline) {
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

	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
};

test('a calling target and a listening source carry the bytes unchanged', async () => {
	const port = freePort();
	const payload = filler(1316 * 30);
	// The receiver binds on its first read, so the read starts before the sender dials
	const source = new RistSource(`rist://127.0.0.1:${port}`, {
		mode: 'listener',
		readTimeout: 20,
		bufferMs: 500,
	});
	const target = new RistTarget(`rist://127.0.0.1:${port}`, { maxQueueBytes: 512 * 1316 });

	// Stated back, so the bound a caller reads is the one it asked for rather than the default
	expect(target.maxQueueBytes).toBe(512 * 1316);

	const reading = readAll(source, payload.byteLength, 25_000);
	await new Promise(resolve => setTimeout(resolve, 400));
	await startSending(target, [payload]);
	const received = await reading;
	await target._finalize();

	expect(received.byteLength).toBe(payload.byteLength);
	expect(bytesToHexString(received)).toBe(bytesToHexString(payload));
	expect(target.sentPackets).toBe(30);

	// Every byte written reached the socket, and nothing was dropped for a receiver that keeps up.
	// `queuedBytes` back at 0 is what catches an unbalanced count - it reads the whole payload if the
	// per-datagram decrement is dropped. That it ever holds anything is the bounded test's job.
	expect(target.sentBytes).toBe(payload.byteLength);
	expect(target.queuedBytes).toBe(0);
	expect(target.droppedBytes).toBe(0);
	expect(target.droppedDatagrams).toBe(0);
}, 120_000);

test('many small writes are regrouped into whole datagrams', async () => {
	const port = freePort();
	const payload = filler(1316 * 12);
	const chunks: Uint8Array[] = [];
	// 188 at a time, as a TS muxer hands them over
	for (let at = 0; at < payload.byteLength; at += 188) {
		chunks.push(payload.subarray(at, at + 188));
	}

	const source = new RistSource(`rist://127.0.0.1:${port}`, { mode: 'listener', readTimeout: 20 });
	const target = new RistTarget(`rist://127.0.0.1:${port}`);

	const reading = readAll(source, payload.byteLength, 25_000);
	await new Promise(resolve => setTimeout(resolve, 400));
	await startSending(target, chunks);
	const received = await reading;
	await target._finalize();

	expect(bytesToHexString(received)).toBe(bytesToHexString(payload));
	// 12 whole datagrams, not 96 small ones
	expect(target.sentPackets).toBe(12);
}, 120_000);

test('a short final datagram is sent, so a stream need not be a payload multiple', async () => {
	const port = freePort();
	const payload = filler(1316 * 3 + 9);
	const source = new RistSource(`rist://127.0.0.1:${port}`, { mode: 'listener', readTimeout: 20 });
	const target = new RistTarget(`rist://127.0.0.1:${port}`);

	const reading = readAll(source, payload.byteLength, 25_000);
	await new Promise(resolve => setTimeout(resolve, 400));
	await startSending(target, [payload]);
	// The remainder only leaves on close
	await target._finalize();
	const received = await reading;

	expect(target.sentPackets).toBe(4);
	expect(received.byteLength).toBe(payload.byteLength);
	expect(bytesToHexString(received)).toBe(bytesToHexString(payload));
}, 120_000);

// Read off a plain UDP socket rather than through RistSource, which does not check these fields: the
// payload type and the SSRC are what a conformant receiver uses to tell this stream from another on the
// same port, so they have to be asserted against the wire and not against our own reader.
test('the RTP header on the wire is what TR-06-1 asks for', async () => {
	const port = freePort();
	const payload = filler(1316 * 4);
	const socket = createSocket({ type: 'udp4', reuseAddr: true });
	const datagrams: Buffer[] = [];
	socket.on('message', message => datagrams.push(message));
	await new Promise<void>(resolve => socket.bind(port, resolve));

	const target = new RistTarget(`rist://127.0.0.1:${port}`);
	await startSending(target, [payload]);
	await target._finalize();
	await new Promise(resolve => setTimeout(resolve, 300));
	socket.close();

	expect(datagrams.length).toBe(4);

	const first = datagrams[0]!;
	expect(first.length).toBe(12 + 1316);
	expect(first[0]! >> 6).toBe(2); // RTP version 2
	expect(first[1]! & 0x7f).toBe(33); // MP2T, the payload type RFC 3551 gives an MPEG-TS stream
	expect(first.readUInt32BE(8)).not.toBe(0); // an SSRC that identifies this sender

	// One SSRC for the whole stream, and sequence numbers advancing by one with wraparound
	const ssrc = first.readUInt32BE(8);
	for (const [index, datagram] of datagrams.entries()) {
		expect(datagram.readUInt32BE(8)).toBe(ssrc);
		expect(datagram.readUInt16BE(2)).toBe((first.readUInt16BE(2) + index) & 0xffff);
		expect(datagram[1]! & 0x7f).toBe(33);
	}

	// And the payload is the bytes handed in, after the 12-byte header
	expect(bytesToHexString(new Uint8Array(datagrams[0]!.subarray(12))))
		.toBe(bytesToHexString(payload.subarray(0, 1316)));
}, 120_000);

test('the queue is bounded, and what it drops is counted', async () => {
	const port = freePort();
	// Nobody listens, a one-datagram queue, and dropping asked for: blocking is the default
	const target = new RistTarget(`rist://127.0.0.1:${port}`, { maxQueueBytes: 1316, onOverflow: 'drop' });

	// Stated back, so the bound a caller reads is the one it asked for rather than the default
	expect(target.maxQueueBytes).toBe(1316);

	target._setMonotonicity(true);
	target._start();
	let position = 0;
	let peakQueued = 0;
	for (let i = 0; i < 100; i++) {
		target._write(filler(1316), position);
		position += 1316;
		const flushing = target._flush();
		peakQueued = Math.max(peakQueued, target.queuedBytes);
		await flushing;
		peakQueued = Math.max(peakQueued, target.queuedBytes);
	}

	expect(target.droppedBytes).toBeGreaterThan(0);
	// Every write here is exactly one datagram, so the two counters have to agree on how many were lost
	expect(target.droppedDatagrams).toBe(target.droppedBytes / 1316);

	// This is the path where the producer outruns the sender, so it is the one where the queue is seen
	// holding bytes rather than reading 0 - a gauge hardwired to 0 would pass every other assertion here
	expect(peakQueued).toBeGreaterThan(0);
	expect(peakQueued).toBeLessThanOrEqual(target.maxQueueBytes);

	await target._finalize().catch(() => {});
}, 120_000);

test('the URL and options are checked at the boundary', () => {
	expect(() => new RistTarget('srt://127.0.0.1:9000')).toThrow(/rist/);
	expect(() => new RistTarget('rist://127.0.0.1:9001')).toThrow(/even port/);
	expect(() => new RistTarget('not a url')).toThrow(TypeError);
	expect(() => new RistTarget('rist://127.0.0.1:9000', { mode: 'x' as 'caller' })).toThrow(/listener/);
	expect(() => new RistTarget('rist://127.0.0.1:9000', { retransmitBufferMs: 0 })).toThrow(/positive/);
	expect(() => new RistTarget('rist://127.0.0.1:9000', { maxQueueBytes: 10 })).toThrow(/at least/);
});

// Blocking is the default, so a bound far below what the writer hands over costs latency, not bytes.
// With `onOverflow: 'drop'` the same shape loses almost all of it - that is the test above.
test('the writer is blocked rather than dropped, so a tiny queue loses nothing', async () => {
	const port = freePort();
	const payload = filler(1316 * 60);
	const source = new RistSource(`rist://127.0.0.1:${port}`, {
		mode: 'listener',
		readTimeout: 20,
		bufferMs: 500,
	});
	// One datagram of headroom against 60 of them: every write after the first has to wait
	const target = new RistTarget(`rist://127.0.0.1:${port}`, { maxQueueBytes: 1316 });

	const reading = readAll(source, payload.byteLength, 25_000);
	await new Promise(resolve => setTimeout(resolve, 400));
	await startSending(target, [payload]);
	const received = await reading;
	await target._finalize();

	expect(received.byteLength).toBe(payload.byteLength);
	expect(bytesToHexString(received)).toBe(bytesToHexString(payload));
	expect(target.droppedBytes).toBe(0);
	expect(target.droppedDatagrams).toBe(0);
}, 120_000);

/** `count` TS packets on one PID, every 7th stating a PCR that advances by `stepMs`. */
const tsWithPcr = (count: number, stepMs: number): Uint8Array => {
	const out = new Uint8Array(count * 188);
	for (let i = 0; i < count; i++) {
		const at = i * 188;
		out[at] = 0x47;
		out[at + 1] = 0x01;
		out[at + 2] = 0x00;
		if (i % 7 === 0) {
			out[at + 3] = 0x30; // adaptation field then payload
			out[at + 4] = 7; // adaptation_field_length
			out[at + 5] = 0x10; // PCR_flag
			const pcr = Math.round((i / 7) * stepMs * 90);
			out[at + 6] = (pcr / 2 ** 25) & 0xff;
			out[at + 7] = (pcr / 2 ** 17) & 0xff;
			out[at + 8] = (pcr / 2 ** 9) & 0xff;
			out[at + 9] = (pcr / 2) & 0xff;
			out[at + 10] = (pcr & 0x1) << 7;
		} else {
			out[at + 3] = 0x10; // payload only
		}
	}
	return out;
};

// Without pacing the whole stream is handed to the kernel at once, which is what a receiver's de-jitter
// buffer has to absorb. Paced, it leaves at the rate its own PCR states. The same bytes either way, so
// the difference is only in how long it takes - which is the thing being asserted.
test('a stream carrying PCR is sent at the rate it states, and unpaced when asked', async () => {
	const stream = tsWithPcr(7 * 40, 25); // 40 PCRs, 25 ms apart: just under a second of media
	const elapsedFor = async (pacing: boolean) => {
		const port = freePort();
		const source = new RistSource(`rist://127.0.0.1:${port}`, {
			mode: 'listener',
			readTimeout: 20,
			bufferMs: 500,
		});
		const target = new RistTarget(`rist://127.0.0.1:${port}`, { pacing });

		const reading = readAll(source, stream.byteLength, 25_000);
		await new Promise(resolve => setTimeout(resolve, 400));
		// Timed to delivery, not to the write: the queue accepts the segment at once and the pump is what
		// paces it, so measuring `_flush` would measure nothing
		const startedAt = Date.now();
		await startSending(target, [stream]);
		const received = await reading;
		const elapsed = Date.now() - startedAt;
		await target._finalize();

		expect(bytesToHexString(received)).toBe(bytesToHexString(stream));
		return elapsed;
	};

	const paced = await elapsedFor(true);
	const unpaced = await elapsedFor(false);

	// 39 steps of 25 ms is 975 ms of media; the last datagram is due at the last PCR, not after it
	expect(paced).toBeGreaterThan(700);

	// Compared as a difference, not a ratio: the receiver's own de-jitter buffer is a fixed cost both
	// runs pay, so it cancels here and would swamp a ratio
	expect(paced - unpaced).toBeGreaterThan(300);
}, 180_000);
