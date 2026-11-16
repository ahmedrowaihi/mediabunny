/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The reassembler below is written from RFC 4175 section 4, not from the packetizer - it parses the
// payload headers the way a receiver has to and rebuilds the frame from what they say. That is the
// point: a round trip through the packetizer's own idea of its output would pass whatever the
// packetizer did. Everything here is read off the wire bytes.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
	buildSdp,
	frameSizeOf,
	lineSizeOf,
	PGROUPS,
	St2110Packetizer,
	St2110VideoSender,
	type St2110VideoFormat,
} from '../../packages/server/src/st2110.js';

const RTP_HEADER_SIZE = 12;

type Parsed = {
	sequence: number;
	extendedSequence: number;
	timestamp: number;
	ssrc: number;
	marker: boolean;
	payloadType: number;
	runs: { length: number; line: number; field: boolean; offsetPixels: number; data: Uint8Array }[];
};

/** Parses one packet exactly as RFC 4175 4.2 describes it. */
const parse = (packet: Uint8Array): Parsed => {
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	expect(packet[0]! >> 6, 'RTP version').toBe(2);

	const headers: { length: number; line: number; field: boolean; offsetPixels: number }[] = [];
	let at = RTP_HEADER_SIZE + 2; // past the extended sequence number
	let continues = true;
	while (continues) {
		const length = view.getUint16(at, false);
		const lineWord = view.getUint16(at + 2, false);
		const offsetWord = view.getUint16(at + 4, false);
		continues = (offsetWord & 0x8000) !== 0;
		headers.push({
			length,
			line: lineWord & 0x7fff,
			field: (lineWord & 0x8000) !== 0,
			offsetPixels: offsetWord & 0x7fff,
		});
		at += 6;
	}

	const runs = headers.map((header) => {
		const data = packet.subarray(at, at + header.length);
		at += header.length;
		return { ...header, data };
	});
	expect(at, 'the payload ends exactly where the headers say it does').toBe(packet.byteLength);

	return {
		sequence: view.getUint16(2, false),
		extendedSequence: view.getUint16(RTP_HEADER_SIZE, false),
		timestamp: view.getUint32(4, false),
		ssrc: view.getUint32(8, false),
		marker: (packet[1]! & 0x80) !== 0,
		payloadType: packet[1]! & 0x7f,
		runs,
	};
};

/** Rebuilds a frame from the packets, placing each run where its own header says it goes. */
const reassemble = (packets: Uint8Array[], format: St2110VideoFormat) => {
	const lineSize = lineSizeOf(format);
	const frame = new Uint8Array(frameSizeOf(format));
	const written = new Uint8Array(frame.byteLength);
	const pgroup = PGROUPS[format.sampling][format.depth];

	for (const packet of packets) {
		for (const run of parse(packet).runs) {
			const offsetOctets = (run.offsetPixels / pgroup.pixels) * pgroup.octets;
			const at = run.line * lineSize + offsetOctets;
			frame.set(run.data, at);
			written.fill(1, at, at + run.data.byteLength);
		}
	}

	return { frame, covered: written.every(byte => byte === 1) };
};

/** A frame whose every octet differs from its neighbours, so a misplaced run cannot hide. */
const testFrame = (size: number) => {
	const frame = new Uint8Array(size);
	let seed = 2463534242;
	for (let i = 0; i < size; i++) {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		frame[i] = seed & 0xff;
	}
	return frame;
};

const HD: St2110VideoFormat = {
	width: 1920,
	height: 1080,
	sampling: 'YCbCr-4:2:2',
	depth: 10,
	exactFrameRate: { numerator: 30000, denominator: 1001 },
};

test('the pgroup table is the one RFC 4175 4.3 states', () => {
	// 4:2:2 is two adjacent pixels at 4, 5, 6 or 8 octets
	expect(PGROUPS['YCbCr-4:2:2']).toEqual({
		8: { octets: 4, pixels: 2 },
		10: { octets: 5, pixels: 2 },
		12: { octets: 6, pixels: 2 },
		16: { octets: 8, pixels: 2 },
	});
	// 4:4:4 at 10 bits is four adjacent pixels in 15 octets, which is not two in five
	expect(PGROUPS['YCbCr-4:4:4'][10]).toEqual({ octets: 15, pixels: 4 });
	expect(PGROUPS['RGB'][8]).toEqual({ octets: 3, pixels: 1 });
	expect(PGROUPS['RGB'][16]).toEqual({ octets: 6, pixels: 1 });

	// 1920 pixels of 4:2:2 10-bit is 960 pgroups of 5 octets
	expect(lineSizeOf(HD)).toBe(4800);
	expect(frameSizeOf(HD)).toBe(4800 * 1080);
});

test('a frame comes back out of its packets byte for byte', () => {
	const packetizer = new St2110Packetizer({ format: HD, ssrc: 0x11223344, initialSequenceNumber: 0 });
	const frame = testFrame(packetizer.frameSize);

	const packets = packetizer.packetize(frame, 123456);
	const { frame: rebuilt, covered } = reassemble(packets, HD);

	expect(covered, 'every octet of the frame was carried by some packet').toBe(true);
	const differsAt = rebuilt.findIndex((byte, i) => byte !== frame[i]);
	expect(differsAt, `rebuilt frame differs at octet ${differsAt}`).toBe(-1);
});

test('every packet fits the MTU and carries whole pgroups', () => {
	for (const mtu of [1500, 1200, 9000]) {
		const packetizer = new St2110Packetizer({ format: HD, ssrc: 1, mtu, initialSequenceNumber: 0 });
		const packets = packetizer.packetize(testFrame(packetizer.frameSize), 0);

		for (const packet of packets) {
			// 28 octets of IPv4 and UDP come off the MTU before any of this
			expect(packet.byteLength + 28, `at mtu ${mtu}`).toBeLessThanOrEqual(mtu);

			for (const run of parse(packet).runs) {
				expect(run.length % 5, 'RFC 4175 4.2: length MUST be a multiple of the pgroup').toBe(0);
			}
		}

		// A larger MTU is fewer packets, which is the only reason to raise it
		expect(packets.length).toBeGreaterThan(0);
	}

	const small = new St2110Packetizer({ format: HD, ssrc: 1, mtu: 1200, initialSequenceNumber: 0 });
	const large = new St2110Packetizer({ format: HD, ssrc: 1, mtu: 9000, initialSequenceNumber: 0 });
	expect(small.packetize(testFrame(small.frameSize), 0).length)
		.toBeGreaterThan(large.packetize(testFrame(large.frameSize), 0).length);
});

test('the marker bit ends the frame and nothing else', () => {
	const packetizer = new St2110Packetizer({ format: HD, ssrc: 1, initialSequenceNumber: 0 });
	const packets = packetizer.packetize(testFrame(packetizer.frameSize), 90_000);

	const marked = packets.map(packet => parse(packet).marker);
	expect(marked[marked.length - 1], 'the last packet of a frame is marked').toBe(true);
	expect(marked.slice(0, -1).some(Boolean), 'and no other packet is').toBe(false);
});

test('one frame is one timestamp, and the sequence number is 32 bits across two fields', () => {
	const packetizer = new St2110Packetizer({ format: HD, ssrc: 7, initialSequenceNumber: 0xfffe });
	const first = packetizer.packetize(testFrame(packetizer.frameSize), 1000);
	const second = packetizer.packetize(testFrame(packetizer.frameSize), 4004);

	// RFC 4175 4.1: every packet of a frame carries that frame's sampling instant
	expect(new Set(first.map(packet => parse(packet).timestamp))).toEqual(new Set([1000]));
	expect(new Set(second.map(packet => parse(packet).timestamp))).toEqual(new Set([4004]));
	expect(new Set(first.map(packet => parse(packet).ssrc))).toEqual(new Set([7]));

	// The extended sequence number carries the high half, so the count keeps going past 65535
	const all = [...first, ...second].map(parse);
	for (const [index, packet] of all.entries()) {
		const expected = (0xfffe + index) >>> 0;
		expect((packet.extendedSequence << 16 | packet.sequence) >>> 0, `packet ${index}`).toBe(expected);
	}
	expect(all[1]!.extendedSequence).toBe(0);
	expect(all[2]!.extendedSequence, 'rolled into the high half rather than wrapping to zero').toBe(1);
});

test('a line too wide for one packet is split, and a narrow one shares', () => {
	// 4800 octets a line against ~1450 of payload: four packets per line, three of them continuing it
	const packetizer = new St2110Packetizer({ format: HD, ssrc: 1, initialSequenceNumber: 0 });
	const perLine = packetizer.packetize(testFrame(packetizer.frameSize), 0).length / HD.height;
	expect(perLine, 'an HD line does not fit one packet').toBeGreaterThan(1);

	// A line of 160 octets leaves room for three of them in one packet, which is the SRD cap
	const narrow: St2110VideoFormat = { ...HD, width: 64, height: 9 };
	const narrowPacketizer = new St2110Packetizer({ format: narrow, ssrc: 1, initialSequenceNumber: 0 });
	const packets = narrowPacketizer.packetize(testFrame(narrowPacketizer.frameSize), 0);

	expect(lineSizeOf(narrow)).toBe(160);
	expect(packets).toHaveLength(3); // 9 lines, three to a packet
	for (const packet of packets) {
		const runs = parse(packet).runs;
		expect(runs).toHaveLength(3);
		expect(runs.map(run => run.offsetPixels), 'each run starts its own line').toEqual([0, 0, 0]);
	}
	expect(parse(packets[0]!).runs.map(run => run.line)).toEqual([0, 1, 2]);

	const { covered } = reassemble(packets, narrow);
	expect(covered).toBe(true);
});

test('an interlaced stream marks the second field', () => {
	const interlaced: St2110VideoFormat = { ...HD, height: 1080, interlaced: true };
	const packetizer = new St2110Packetizer({ format: interlaced, ssrc: 1, initialSequenceNumber: 0 });

	// One field per timestamp, so a field is half the lines
	expect(packetizer.frameSize).toBe(lineSizeOf(interlaced) * 540);

	const firstField = packetizer.packetize(testFrame(packetizer.frameSize), 0, false);
	const secondField = packetizer.packetize(testFrame(packetizer.frameSize), 0, true);

	expect(parse(firstField[0]!).runs.every(run => !run.field)).toBe(true);
	expect(parse(secondField[0]!).runs.every(run => run.field)).toBe(true);
});

test('the format and its packing are checked before a frame is cut up', () => {
	const ok = { format: HD, ssrc: 1 };

	expect(() => new St2110Packetizer({ ...ok, format: { ...HD, width: 0 } }))
		.toThrow(/width must be a positive integer/);
	expect(() => new St2110Packetizer({ ...ok, format: { ...HD, sampling: 'YUV' as never } }))
		.toThrow(/sampling must be one of/);
	expect(() => new St2110Packetizer({ ...ok, format: { ...HD, depth: 9 as never } }))
		.toThrow(/depth must be 8, 10, 12 or 16/);
	expect(() => new St2110Packetizer({ ...ok, format: { ...HD, interlaced: true, height: 487 } }))
		.toThrow(/height must be even/);
	expect(() => new St2110Packetizer({
		...ok,
		format: { ...HD, exactFrameRate: { numerator: 29.97, denominator: 1 } as never },
	})).toThrow(/ratio of positive integers/);
	expect(() => new St2110Packetizer({ ...ok, ssrc: -1 })).toThrow(/ssrc must be an integer/);
	expect(() => new St2110Packetizer({ ...ok, payloadType: 200 })).toThrow(/payloadType must be/);
	expect(() => new St2110Packetizer({ ...ok, mtu: 40 })).toThrow(/leaves no room for a pgroup/);

	const packetizer = new St2110Packetizer(ok);
	expect(() => packetizer.packetize(new Uint8Array(10), 0))
		.toThrow(/is 10 octets where this format's frame is 5184000/);
});

// Everything above reads the packets with a parser written from the same RFC the packetizer was written
// from, which proves they agree with each other. This sends them to FFmpeg instead - an implementation
// that owes this one nothing - and checks the pixels that come out the far end. If the 10-bit packing
// or the SRD geometry were wrong in a way both of mine shared, this is what would catch it.

/** Packs Cb-Y0-Cr-Y1 into one 5-octet 4:2:2 10-bit pgroup, MSB first (RFC 4175 4.3). */
const packPgroup422x10 = (cb: number, y0: number, cr: number, y1: number) => [
	cb >> 2,
	((cb & 0x3) << 6) | (y0 >> 4),
	((y0 & 0xf) << 4) | (cr >> 6),
	((cr & 0x3f) << 2) | (y1 >> 8),
	y1 & 0xff,
];

const hasFfmpeg = () => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

test.skipIf(!hasFfmpeg())('FFmpeg decodes the stream to the pixels that went in', async () => {
	const format: St2110VideoFormat = {
		width: 64,
		height: 16,
		sampling: 'YCbCr-4:2:2',
		depth: 10,
		exactFrameRate: { numerator: 25, denominator: 1 },
	};
	const port = 21_000 + Math.floor(Math.random() * 2000);

	// A gradient in luma and a fixed chroma, so a misread sample is a wrong number rather than noise
	const luma: number[] = [];
	const packed: number[] = [];
	for (let y = 0; y < format.height; y++) {
		for (let x = 0; x < format.width; x += 2) {
			const y0 = (y * 64 + x * 4) & 0x3ff;
			const y1 = (y * 64 + x * 4 + 4) & 0x3ff;
			luma.push(y0, y1);
			packed.push(...packPgroup422x10(512, y0, 512, y1));
		}
	}
	const frame = new Uint8Array(packed);

	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-2110-'));
	const sdpPath = path.join(dir, 'stream.sdp');
	const outPath = path.join(dir, 'out.raw');
	writeFileSync(sdpPath, buildSdp({ format, address: '127.0.0.1', port }));

	const ffmpeg = spawn('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-protocol_whitelist', 'file,udp,rtp',
		'-i', sdpPath,
		// Several, and the last is the one compared: a receiver that binds mid-frame emits that
		// partial frame as zeros, and with a paced sender that is the common case rather than the rare one
		'-frames:v', '4',
		'-f', 'rawvideo', '-pix_fmt', 'yuv422p10le',
		'-y', outPath,
	]);
	const finished = new Promise<number>(resolve => ffmpeg.on('close', code => resolve(code ?? -1)));

	const sender = await St2110VideoSender.open({ format, address: '127.0.0.1', port, ssrc: 0x2110 });
	try {
		// The sender writes its own SDP, and this is the one FFmpeg was handed - so what is under test
		// is the description the sender publishes, not one the test made up to suit it
		expect(sender.sdp).toBe(buildSdp({ format, address: '127.0.0.1', port }));

		// Repeat the frame: FFmpeg binds the port after this test starts it, and whatever is sent before
		// that is simply gone - there is no handshake in RTP to wait on
		const deadline = Date.now() + 20_000;
		let done = false;
		void finished.then(() => {
			done = true;
		});

		while (!done && Date.now() < deadline) {
			await sender.send(frame);
		}

		const code = await finished;
		expect(code, 'ffmpeg read the stream').toBe(0);

		// yuv422p10le: the luma plane is width*height little-endian 16-bit samples, then two half-width
		// chroma planes
		const out = new Uint8Array(readFileSync(outPath));
		const frameBytes = format.width * format.height * 2 * 2;
		expect(out.byteLength, 'four whole frames came out').toBe(frameBytes * 4);

		const last = out.subarray(out.byteLength - frameBytes);
		const decoded = new Uint16Array(
			last.buffer.slice(last.byteOffset, last.byteOffset + frameBytes),
			0,
			format.width * format.height,
		);
		const differsAt = luma.findIndex((value, i) => decoded[i] !== value);
		expect(
			differsAt,
			`luma differs at sample ${differsAt}: sent ${luma[differsAt]}, ffmpeg read ${decoded[differsAt]}`,
		).toBe(-1);

		// And the chroma it read is the 512 that went in, on both planes
		const chromaBytes = last.buffer.slice(
			last.byteOffset + format.width * format.height * 2,
			last.byteOffset + frameBytes,
		);
		const chroma = new Uint16Array(chromaBytes, 0, format.width * format.height);
		expect([...new Set(chroma)], 'both chroma planes carry the constant that was sent').toEqual([512]);
	} finally {
		await sender.close();
		ffmpeg.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

test('the sender spreads a frame across its own interval rather than bursting it', async () => {
	const format: St2110VideoFormat = {
		width: 1280,
		height: 72,
		sampling: 'YCbCr-4:2:2',
		depth: 10,
		exactFrameRate: { numerator: 50, denominator: 1 },
	};

	// Nothing is listening: a UDP sender does not care, which is what makes this a pacing measurement
	// rather than a delivery one
	const sender = await St2110VideoSender.open({
		format,
		address: '127.0.0.1',
		port: 23_456,
		ssrc: 1,
	});

	try {
		const packets = new St2110Packetizer({ format, ssrc: 1 })
			.packetize(new Uint8Array(frameSizeOf(format)), 0).length;
		expect(packets, 'enough packets for pacing to mean something').toBeGreaterThan(20);

		const start = performance.now();
		await sender.send(new Uint8Array(frameSizeOf(format)));
		const elapsed = (performance.now() - start) / 1000;

		expect(sender.packetsSent).toBe(packets);
		expect(sender.framesSent).toBe(1);

		// A frame at 50 fps takes its 20 ms rather than going out as fast as the socket accepts it
		expect(elapsed, `took ${(elapsed * 1000).toFixed(1)} ms`).toBeGreaterThan(0.012);
		expect(elapsed, 'and does not overrun the interval badly').toBeLessThan(0.1);

		// And the SDP says wide, because this is what a timer can do - claiming narrow would have a
		// receiver size its buffer for a sender that does not exist
		expect(sender.sdp).toContain('TP=2110TPW');
		expect(sender.worstPacingError, 'pacing error is measured, not assumed').toBeGreaterThan(0);
		expect(sender.worstPacingError).toBeLessThan(0.02);
	} finally {
		await sender.close();
	}
}, 30_000);

test('a closed sender refuses further frames rather than dropping them silently', async () => {
	const format: St2110VideoFormat = {
		width: 64,
		height: 4,
		sampling: 'YCbCr-4:2:2',
		depth: 10,
		exactFrameRate: { numerator: 25, denominator: 1 },
	};
	const sender = await St2110VideoSender.open({ format, address: '127.0.0.1', port: 23_457, ssrc: 1 });

	await sender.send(new Uint8Array(frameSizeOf(format)));
	await sender.close();
	await sender.close(); // idempotent

	await expect(sender.send(new Uint8Array(frameSizeOf(format)))).rejects.toThrow(/has been closed/);
});

test('the sender checks where it is being asked to send', async () => {
	const format: St2110VideoFormat = {
		width: 64,
		height: 4,
		sampling: 'YCbCr-4:2:2',
		depth: 10,
		exactFrameRate: { numerator: 25, denominator: 1 },
	};

	await expect(St2110VideoSender.open({ format, address: '', port: 1234, ssrc: 1 }))
		.rejects.toThrow(/address must be a non-empty string/);
	await expect(St2110VideoSender.open({ format, address: '127.0.0.1', port: 0, ssrc: 1 }))
		.rejects.toThrow(/port must be an integer between 1 and 65535/);
});
