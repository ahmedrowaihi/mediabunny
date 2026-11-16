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
import { bytesToHexString } from '../../src/misc.js';
import {
	buildSdp,
	frameSizeOf,
	lineSizeOf,
	PGROUPS,
	St2110Packetizer,
	St2110VideoSender,
	type St2110VideoFormat,
} from '../../packages/server/src/st2110.js';
import {
	ancChecksum,
	buildAncSdp,
	St2110AncPacketizer,
} from '../../packages/server/src/st2110-anc.js';
import {
	audioPayloadSize,
	buildAudioSdp,
	buildChannelOrder,
	channelsInOrder,
	framesPerPacket,
	receiverLevelsFor,
	St2110AudioPacketizer,
	type St2110AudioFormat,
} from '../../packages/server/src/st2110-audio.js';

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

// ---------------------------------------------------------------------------------------------
// ST 2110-40, ancillary data over RTP (IETF RFC 8331).
//
// The ANC data words are 10 bits and not byte aligned, so a packet carrying one word of user data
// has its checksum straddling three octets. The first test below asserts the exact octets of such a
// packet, worked out from the RFC by hand rather than from this implementation - an unpacker written
// against the same misreading as the packer would agree with it happily.

const unpackAnc = (packet: Uint8Array) => {
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const count = packet[16]!;
	const length = view.getUint16(14, false);
	const field = packet[17]! >> 6;

	let bitAt = 20 * 8;
	const readBits = (bits: number) => {
		let value = 0;
		for (let i = 0; i < bits; i++) {
			value = (value << 1) | ((packet[bitAt >> 3]! >> (7 - (bitAt & 7))) & 1);
			bitAt++;
		}
		return value;
	};

	const packets: {
		colorDifference: boolean;
		lineNumber: number;
		horizontalOffset: number;
		streamValid: boolean;
		streamNumber: number;
		did: number;
		sdid: number;
		dataCount: number;
		data: number[];
		checksum: number;
	}[] = [];

	for (let i = 0; i < count; i++) {
		const header = readBits(32);
		const did = readBits(10);
		const sdid = readBits(10);
		const dataCount = readBits(10);
		const data: number[] = [];
		for (let w = 0; w < (dataCount & 0xff); w++) {
			data.push(readBits(10));
		}
		const checksum = readBits(10);
		while (bitAt % 32 !== 0) {
			bitAt++;
		}

		packets.push({
			colorDifference: ((header >>> 31) & 1) === 1,
			lineNumber: (header >>> 20) & 0x7ff,
			horizontalOffset: (header >>> 8) & 0xfff,
			streamValid: ((header >>> 7) & 1) === 1,
			streamNumber: header & 0x7f,
			did,
			sdid,
			dataCount,
			data,
			checksum,
		});
	}

	return { count, length, field, packets, marker: (packet[1]! & 0x80) !== 0 };
};

test('one ancillary packet is packed exactly as RFC 8331 lays it out, bit for bit', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 0x11223344, initialSequenceNumber: 7 });
	const [packet] = packetizer.pack({
		// SCTE-104, one user data word
		packets: [{ did: 0x41, sdid: 0x07, data: new Uint8Array([0x01]), lineNumber: 9, horizontalOffset: 0 }],
		timestamp: 90_000,
	});

	// Worked out from the RFC: the ten-bit words are DID 0x241, SDID 0x107, Data_Count 0x101,
	// UDW 0x101 and Checksum 0x14A - each carrying b8 as even parity over b0..b7 and b9 as its
	// inverse, the checksum being their nine-bit sum modulo 512. Fifty bits of words after a 32-bit
	// header word is 82 bits, which word_align fills to 96: twelve octets.
	expect(packet!.length).toBe(12 + 8 + 12);

	const body = Array.from(packet!.subarray(12 + 8));
	expect(body.slice(0, 4)).toEqual([0x00, 0x90, 0x00, 0x00]); // C=0, line 9, offset 0, S=0
	expect(body.slice(4)).toEqual([0x90, 0x50, 0x74, 0x05, 0x01, 0x52, 0x80, 0x00]);

	// Length counts from the C bit and includes word_align, so it is 12 and not 20
	expect(new DataView(packet!.buffer).getUint16(14, false)).toBe(12);
	expect(packet![16]).toBe(1); // ANC_Count
});

test('an unpacker reads back what was packed, including the parity and the checksum', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1 });
	const data = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
	const [packet] = packetizer.pack({
		packets: [{
			did: 0x61,
			sdid: 0x01,
			data,
			lineNumber: 2047,
			horizontalOffset: 4095,
			colorDifference: true,
			streamNumber: 3,
		}],
		timestamp: 0,
	});

	const read = unpackAnc(packet!);
	expect(read.count).toBe(1);
	const first = read.packets[0]!;
	expect(first.colorDifference).toBe(true);
	expect(first.lineNumber).toBe(2047);
	expect(first.horizontalOffset).toBe(4095);
	expect(first.streamValid).toBe(true);
	expect(first.streamNumber).toBe(3);
	// The low eight bits are the value; b8/b9 are parity
	expect(first.did & 0xff).toBe(0x61);
	expect(first.sdid & 0xff).toBe(0x01);
	expect(first.data.map(word => word & 0xff)).toEqual(Array.from(data));
	// Every data word's parity holds: b8 is even parity over b0..b7, b9 its inverse
	for (const word of [first.did, first.sdid, ...first.data]) {
		const bits = (word & 0xff).toString(2).split('').filter(bit => bit === '1').length;
		expect(((word >> 8) & 1), `parity of ${word.toString(16)}`).toBe(bits % 2);
		expect((word >> 9) & 1).toBe(((word >> 8) & 1) ? 0 : 1);
	}
	// The checksum is not one of them: its b8 is the ninth bit of a nine-bit sum, so only b9 is
	// derived. Checking parity over its low eight bits would be checking the wrong thing.
	expect((first.checksum >> 9) & 1).toBe(((first.checksum >> 8) & 1) ? 0 : 1);
	// The words as they actually went on the wire, Data_Count included - reconstructing its parity
	// here would just be a second chance to get parity wrong
	expect(first.checksum).toBe(ancChecksum([first.did, first.sdid, first.dataCount, ...first.data]));
	expect(first.dataCount & 0xff).toBe(5);
});

test('the S bit says whether StreamNum means anything, which stream 0 cannot say by itself', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1 });
	const base = { did: 0x41, sdid: 0x07, data: new Uint8Array([1]), lineNumber: 10, horizontalOffset: 0 };

	const without = unpackAnc(packetizer.pack({ packets: [base], timestamp: 0 })[0]!);
	const zero = unpackAnc(packetizer.pack({ packets: [{ ...base, streamNumber: 0 }], timestamp: 0 })[0]!);

	expect(without.packets[0]!.streamValid).toBe(false);
	expect(zero.packets[0]!.streamValid).toBe(true);
	expect(zero.packets[0]!.streamNumber).toBe(0);
});

test('every ANC packet starts on a 32-bit boundary, whatever the one before it held', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1 });
	// Data counts 1 to 6: each leaves a different number of word_align bits, so a packer that padded
	// only to the octet would put the next header word off its boundary
	for (let count = 1; count <= 6; count++) {
		const packets = [1, 2, 3].map(line => ({
			did: 0x41,
			sdid: 0x07,
			data: new Uint8Array(count).fill(0xaa),
			lineNumber: line,
			horizontalOffset: 0,
		}));

		const [packet] = packetizer.pack({ packets, timestamp: 0 });
		const read = unpackAnc(packet!);

		expect(read.count, `data count ${count}`).toBe(3);
		expect(read.packets.map(entry => entry.lineNumber)).toEqual([1, 2, 3]);
		expect(read.packets.every(entry => entry.data.length === count)).toBe(true);
		// The payload after the 8-octet header is a whole number of 32-bit words
		expect((packet!.length - 12 - 8) % 4, `data count ${count}`).toBe(0);
		expect(read.length).toBe(packet!.length - 12 - 8);
	}
});

test('a frame carrying no ancillary data still sends a packet, with both counts zero', () => {
	// A receiver rebuilding a raster has to learn that a frame carried nothing, rather than wait
	const packetizer = new St2110AncPacketizer({ ssrc: 1 });
	const packets = packetizer.pack({ packets: [], timestamp: 900 });

	expect(packets).toHaveLength(1);
	expect(packets[0]!.length).toBe(12 + 8);
	expect(packets[0]![16]).toBe(0); // ANC_Count
	expect(new DataView(packets[0]!.buffer).getUint16(14, false)).toBe(0); // Length
	expect((packets[0]![1]! & 0x80) !== 0, 'the marker bit still ends the frame').toBe(true);
});

test('the field bits are the RFC values, and the invalid one cannot be written', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1 });
	const base = {
		packets: [{ did: 0x41, sdid: 0x07, data: new Uint8Array([1]), lineNumber: 9, horizontalOffset: 0 }],
		timestamp: 0,
	};

	expect(unpackAnc(packetizer.pack({ ...base, field: 'progressive' })[0]!).field).toBe(0b00);
	expect(unpackAnc(packetizer.pack({ ...base, field: 'first' })[0]!).field).toBe(0b10);
	expect(unpackAnc(packetizer.pack({ ...base, field: 'second' })[0]!).field).toBe(0b11);
	// 0b01 is the value the RFC calls invalid; there is deliberately no name for it
	expect(() => packetizer.pack({ ...base, field: 'invalid' as never })).toThrow(TypeError);
});

test('ancillary data too big for one datagram is split, and only the last carries the marker', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1, mtu: 300 });
	const packets = packetizer.pack({
		packets: Array.from({ length: 12 }, (unused, index) => ({
			did: 0x41,
			sdid: 0x07,
			data: new Uint8Array(60).fill(index),
			lineNumber: index + 1,
			horizontalOffset: 0,
		})),
		timestamp: 4500,
	});

	expect(packets.length).toBeGreaterThan(1);
	expect(packets.every(packet => packet.length <= 300 - 28)).toBe(true);
	expect(packets.slice(0, -1).every(packet => (packet[1]! & 0x80) === 0)).toBe(true);
	expect((packets[packets.length - 1]![1]! & 0x80) !== 0).toBe(true);

	// Same timestamp across the lot, different sequence numbers - which is what the RFC asks for
	const view = (packet: Uint8Array) => new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	expect(packets.every(packet => view(packet).getUint32(4, false) === 4500)).toBe(true);
	const sequences = packets.map(packet => view(packet).getUint16(2, false));
	expect(new Set(sequences).size).toBe(packets.length);

	// Every one of the twelve arrives exactly once, in order
	const lines = packets.flatMap(packet => unpackAnc(packet).packets.map(entry => entry.lineNumber));
	expect(lines).toEqual(Array.from({ length: 12 }, (unused, index) => index + 1));
});

test('ancillary data that cannot fit any datagram is refused by name', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1, mtu: 300 });
	expect(() => packetizer.pack({
		packets: [{
			did: 0x41,
			sdid: 0x07,
			data: new Uint8Array(255),
			lineNumber: 9,
			horizontalOffset: 0,
		}],
		timestamp: 0,
	})).toThrow(/needs \d+ octets and the MTU leaves/);
});

test('a Data_Count that cannot be stated in eight bits is refused, not truncated', () => {
	const packetizer = new St2110AncPacketizer({ ssrc: 1, mtu: 9000 });
	expect(() => packetizer.pack({
		packets: [{ did: 0x41, sdid: 0x07, data: new Uint8Array(256), lineNumber: 9, horizontalOffset: 0 }],
		timestamp: 0,
	})).toThrow(/Data_Count can state at most 255/);
});

test('the ancillary SDP names the stream smpte291 on the video clock', () => {
	const sdp = buildAncSdp({
		address: '239.10.20.30',
		port: 20000,
		didSdid: [{ did: 0x41, sdid: 0x07 }, { did: 0x61, sdid: 0x01 }],
		vpidCode: 133,
		ptpGrandmaster: '08-00-11-FF-FE-21-E1-B0:0',
	});

	expect(sdp).toContain('m=video 20000 RTP/AVP 100');
	expect(sdp).toContain('c=IN IP4 239.10.20.30/64');
	expect(sdp).toContain('a=rtpmap:100 smpte291/90000');
	expect(sdp).toContain('DID_SDID={0x41,0x07}');
	expect(sdp).toContain('DID_SDID={0x61,0x01}');
	expect(sdp).toContain('VPID_Code=133');
	expect(sdp).toContain('a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-21-E1-B0:0');
});

// ---------------------------------------------------------------------------------------------
// ST 2110-30, uncompressed PCM. The payload has no header at all, so everything a receiver needs -
// how much audio a packet holds, at what depth, in what channel order - is in the SDP. The
// conformance levels of Table 2 describe what a RECEIVER accepts, which is why nothing here writes a
// level into the SDP and `receiverLevelsFor` answers in the other direction.

const AUDIO_48K_STEREO_24: St2110AudioFormat = {
	sampleRate: 48000,
	depth: 24,
	channels: 2,
	packetTime: 1,
};

test('a packet holds what the packet time says, not what the MTU allows', () => {
	expect(framesPerPacket(AUDIO_48K_STEREO_24)).toBe(48);
	expect(audioPayloadSize(AUDIO_48K_STEREO_24)).toBe(48 * 2 * 3);
	// 125 us at 48 kHz is six frames, which is the whole point of the shorter packet time
	expect(framesPerPacket({ ...AUDIO_48K_STEREO_24, packetTime: 0.125 })).toBe(6);
	expect(framesPerPacket({ ...AUDIO_48K_STEREO_24, sampleRate: 96000 })).toBe(96);
});

test('a sample rate that does not divide into whole frames is refused', () => {
	// 44.1 kHz at 125 us is 5.5125 frames, and a packet carries whole frames
	expect(() => framesPerPacket({ ...AUDIO_48K_STEREO_24, sampleRate: 44100, packetTime: 0.125 }))
		.toThrow(/5\.5125 frames per packet/);
	// At 1 ms it is 44.1, which is also not whole
	expect(() => framesPerPacket({ ...AUDIO_48K_STEREO_24, sampleRate: 44100 })).toThrow(TypeError);
	// 48 kHz is fine at both
	expect(() => framesPerPacket(AUDIO_48K_STEREO_24)).not.toThrow();
});

test('the timestamp advances by frames, because the media clock runs at the sampling rate', () => {
	const packetizer = new St2110AudioPacketizer({
		format: AUDIO_48K_STEREO_24,
		ssrc: 5,
		initialTimestamp: 1000,
	});
	const packets = packetizer.pack(new Uint8Array(packetizer.payloadSize * 3));
	const view = (packet: Uint8Array) => new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

	expect(packets).toHaveLength(3);
	// 48 frames per packet, not 288 octets and not 90 kHz ticks
	expect(packets.map(packet => view(packet).getUint32(4, false))).toEqual([1000, 1048, 1096]);
	expect(packetizer.nextTimestamp).toBe(1144);
	// No marker bit: a continuous stream has no frame boundary to mark
	expect(packets.every(packet => (packet[1]! & 0x80) === 0)).toBe(true);
});

test('audio that does not fill a packet is held back rather than sent short', () => {
	// A short packet would misstate the packet time the receiver sized its buffer from
	const packetizer = new St2110AudioPacketizer({ format: AUDIO_48K_STEREO_24, ssrc: 5 });
	const size = packetizer.payloadSize;

	expect(packetizer.pack(new Uint8Array(size - 1))).toHaveLength(0);
	expect(packetizer.pendingOctets).toBe(size - 1);

	// One more octet completes it
	const packets = packetizer.pack(new Uint8Array(1));
	expect(packets).toHaveLength(1);
	expect(packets[0]!.length).toBe(12 + size);
	expect(packetizer.pendingOctets).toBe(0);
});

test('how the caller chunks the audio cannot change the bytes on the wire', () => {
	const pcm = new Uint8Array(audioPayloadSize(AUDIO_48K_STEREO_24) * 4);
	for (let i = 0; i < pcm.length; i++) {
		pcm[i] = (i * 31 + 7) & 0xff;
	}

	const whole = new St2110AudioPacketizer({ format: AUDIO_48K_STEREO_24, ssrc: 5 })
		.pack(pcm)
		.map(packet => bytesToHexString(packet.subarray(12)));

	for (const chunk of [1, 7, 100, 288, 577]) {
		const packetizer = new St2110AudioPacketizer({ format: AUDIO_48K_STEREO_24, ssrc: 5 });
		const payloads: string[] = [];
		for (let at = 0; at < pcm.length; at += chunk) {
			for (const packet of packetizer.pack(pcm.subarray(at, Math.min(at + chunk, pcm.length)))) {
				payloads.push(bytesToHexString(packet.subarray(12)));
			}
		}
		expect(payloads, `chunks of ${chunk}`).toEqual(whole);
	}
});

test('the conformance levels are the ones Table 2 states, read as receiver capability', () => {
	// Level A is the only mandatory one: 48 kHz, 1 to 8 channels, 1 ms
	expect(receiverLevelsFor({ sampleRate: 48000, depth: 24, channels: 2, packetTime: 1 }))
		.toEqual(['A', 'AX', 'B', 'BX', 'C', 'CX']);
	// 125 us at eight channels is B and above, never A
	expect(receiverLevelsFor({ sampleRate: 48000, depth: 24, channels: 8, packetTime: 0.125 }))
		.toEqual(['B', 'BX', 'C', 'CX']);
	// Above eight channels at 125 us is only C - this is the difference every secondary summary of
	// the standard gets wrong about level B
	expect(receiverLevelsFor({ sampleRate: 48000, depth: 24, channels: 64, packetTime: 0.125 }))
		.toEqual(['C', 'CX']);
	// 96 kHz at all is only the X levels
	expect(receiverLevelsFor({ sampleRate: 96000, depth: 24, channels: 4, packetTime: 1 }))
		.toEqual(['AX', 'BX', 'CX']);
	// Sixteen channels at 1 ms is in no level at all - valid AES67, but no conforming receiver has
	// to take it, which section 7's own note says to solve by sending several streams
	expect(receiverLevelsFor({ sampleRate: 48000, depth: 24, channels: 16, packetTime: 1 })).toEqual([]);
});

test('a channel order names the groups of Table 1 and must account for every channel', () => {
	expect(buildChannelOrder(['51', 'ST'])).toBe('SMPTE2110.(51,ST)');
	expect(channelsInOrder(['51', 'ST'])).toBe(8);
	expect(buildChannelOrder(['M', 'M', 'M', 'M', 'ST', 'U02'])).toBe('SMPTE2110.(M,M,M,M,ST,U02)');
	expect(channelsInOrder(['M', 'M', 'M', 'M', 'ST', 'U02'])).toBe(8);
	// An undefined group carries its size in the symbol, with a leading zero below ten
	expect(channelsInOrder(['U05'])).toBe(5);
	expect(channelsInOrder(['222'])).toBe(24);
	expect(channelsInOrder(['SGRP'])).toBe(4);

	expect(() => buildChannelOrder(['5.1' as never])).toThrow(/not a channel grouping symbol/);
	expect(() => buildChannelOrder(['U5' as never])).toThrow(/not a channel grouping symbol/);
	expect(() => buildChannelOrder(['U65' as never])).toThrow(/not a channel grouping symbol/);
	expect(() => buildChannelOrder([])).toThrow(TypeError);
});

test('an audio SDP states the depth, rate, channels and ptime', () => {
	const sdp = buildAudioSdp({
		format: AUDIO_48K_STEREO_24,
		address: '239.1.2.3',
		port: 5004,
		channelOrder: ['ST'],
		ptpGrandmaster: '08-00-11-FF-FE-21-E1-B0:0',
	});

	expect(sdp).toContain('m=audio 5004 RTP/AVP 97');
	expect(sdp).toContain('a=rtpmap:97 L24/48000/2');
	expect(sdp).toContain('a=fmtp:97 channel-order=SMPTE2110.(ST)');
	expect(sdp).toContain('a=ptime:1');
	expect(sdp).toContain('a=mediaclk:direct=0');
	expect(sdp).toContain('a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-21-E1-B0:0');

	// L16 at 125 us, which a receiver reads very differently
	expect(buildAudioSdp({
		format: { sampleRate: 48000, depth: 16, channels: 8, packetTime: 0.125 },
		address: '192.0.2.1',
		port: 5004,
	})).toContain('a=rtpmap:97 L16/48000/8');
	expect(buildAudioSdp({
		format: { sampleRate: 48000, depth: 16, channels: 8, packetTime: 0.125 },
		address: '192.0.2.1',
		port: 5004,
	})).toContain('a=ptime:0.125');
});

test('a channel order that does not match the stream is refused, not written', () => {
	// ST 2110-30 6.2.2 makes the undeclared channels Undefined, so a short order silently discards
	// the mix of everything past it
	expect(() => buildAudioSdp({
		format: { ...AUDIO_48K_STEREO_24, channels: 8 },
		address: '239.1.2.3',
		port: 5004,
		channelOrder: ['ST'],
	})).toThrow(/accounts for 2 channels and the stream carries 8/);
});
