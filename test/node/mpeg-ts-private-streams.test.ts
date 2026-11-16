/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The fixture is synthesised by scripts/build-dvb-private-fixture.py, because no broadcast sample in
// this repo carries teletext or DVB subtitles. It is not checked against the writer that made it:
// `ffprobe` reads the same file as `dvb_teletext` on PID 0x200 with language eng and `dvb_subtitle` on
// 0x201, so the descriptors are confirmed by an implementation that is not this one. Field widths come
// from ETSI EN 300 468 V1.20.1 — teletext_descriptor 6.2.43, subtitling_descriptor 6.2.41.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readMpegTsPrivateStreams, readPrivatePesPayloads } from '../../src/mpeg-ts/private-streams.js';
import type { PrivatePesPayload } from '../../src/mpeg-ts/private-streams.js';
import { addPrivatePesPayload } from '../../src/mpeg-ts/private-streams-output.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { bytesToHexString } from '../../src/misc.js';

const fixture = () => new Uint8Array(
	readFileSync(path.join(__dirname, '../public/dvb-teletext-subtitles.ts')),
);

test('the PMT names a teletext stream and a DVB subtitle stream', () => {
	const streams = readMpegTsPrivateStreams(fixture());

	expect(streams).toHaveLength(2);
	expect(streams.map(stream => stream.pid)).toEqual([0x200, 0x201]);
	// Both ride stream type 0x06, so only the descriptor tells them apart
	expect(streams.every(stream => stream.streamType === 0x06)).toBe(true);
});

test('the teletext descriptor reads back page 888', () => {
	const teletext = readMpegTsPrivateStreams(fixture()).find(stream => stream.teletext)!;

	expect(teletext.pid).toBe(0x200);
	expect(teletext.subtitles).toBeUndefined();
	// Two entries, so a wrong stride cannot read the first one and look right
	expect(teletext.teletext).toEqual([
		{
			language: 'eng',
			// 0x02 is a subtitle page per EN 300 468 table 102
			type: 0x02,
			// Magazine 0 on the wire stands for magazine 8, and the page is two hex digits, not decimal:
			// magazine 8 with page 0x88 is the 888 a viewer asks for
			magazine: 0,
			page: 888,
		},
		{ language: 'deu', type: 0x01, magazine: 1, page: 150 },
	]);
});

test('the subtitling descriptor reads back its pages and type', () => {
	const subtitles = readMpegTsPrivateStreams(fixture()).find(stream => stream.subtitles)!;

	expect(subtitles.pid).toBe(0x201);
	expect(subtitles.teletext).toBeUndefined();
	expect(subtitles.subtitles).toEqual([
		{
			language: 'eng',
			// 0x10 is ordinary subtitles; 0x20 and up are the hard-of-hearing variants
			type: 0x10,
			compositionPageId: 1,
			ancillaryPageId: 1,
		},
		{ language: 'deu', type: 0x20, compositionPageId: 3, ancillaryPageId: 4 },
	]);
});

test('a page number is read as hex digits, not as a decimal byte', () => {
	// The one arithmetic worth stating: a decimal reading of 0x88 would give 136, and 8 * 100 + 136 is
	// not a page anyone can ask for. This is the test that fails if the BCD rule is dropped.
	const teletext = readMpegTsPrivateStreams(fixture()).find(stream => stream.teletext)!;

	expect(teletext.teletext![0]!.page).toBe(888);
	expect(teletext.teletext![0]!.page).not.toBe(8 * 100 + 0x88);
});

test('teletext PES payloads come back whole, with the time the header states', () => {
	const payloads = readPrivatePesPayloads(fixture(), 0x200);

	expect(payloads.length).toBeGreaterThan(1);
	expect(payloads.every(payload => payload.pid === 0x200)).toBe(true);

	// The fixture states 90000 ticks for the first and steps 3600 (40 ms) per packet
	expect(payloads[0]!.time).toBeCloseTo(1, 6);
	expect(payloads[1]!.time).toBeCloseTo(1 + 3600 / 90_000, 6);

	// EN 300 472 framing is handed over untouched: data_identifier 0x10, then a data unit
	const first = payloads[0]!.data;
	expect(first[0]).toBe(0x10);
	expect(first[1]).toBe(0x03); // data_unit_id 0x03, EBU subtitle data
	expect(first[2]).toBe(0x2c); // data_unit_length 44
	// Four data units, so the PES spans more than one TS packet and the continuations must be joined
	expect(first.byteLength).toBe(1 + 4 * 46);
});

test('DVB subtitle PES payloads come back whole, with their segment header', () => {
	const payloads = readPrivatePesPayloads(fixture(), 0x201);

	expect(payloads.length).toBeGreaterThan(1);

	// EN 300 743: data_identifier 0x20, subtitle_stream_id 0x00, then 0x0f-prefixed segments
	const first = payloads[0]!.data;
	expect(first[0]).toBe(0x20);
	expect(first[1]).toBe(0x00);
	expect(first[2]).toBe(0x0f);
	expect(first[3]).toBe(0x10); // page composition segment
	expect(first[first.byteLength - 1]).toBe(0xff); // end_of_PES_data_field_marker
});

test('every payload on a PID is distinct, so none is a repeat of the assembly buffer', () => {
	const payloads = readPrivatePesPayloads(fixture(), 0x200);
	const seen = payloads.map(payload => `${payload.time}:${bytesToHexString(payload.data)}`);

	expect(new Set(seen).size).toBe(seen.length);
});

test('a PID with nothing on it reads as empty rather than throwing', () => {
	expect(readPrivatePesPayloads(fixture(), 0x1fff)).toEqual([]);
	expect(readMpegTsPrivateStreams(new Uint8Array(0))).toEqual([]);
	// Not a transport stream at all: no sync bytes, so nothing is claimed
	expect(readMpegTsPrivateStreams(new Uint8Array(1000).fill(0xab))).toEqual([]);
});

// A live reader scanning a sliding window cuts the last PES every time, so a truncated one must not come
// back looking whole: the DVB payload has a 0xFF end marker a caller could check, but teletext has none.
// Every payload returned is complete, and a packet the buffer cut is left out.
const PACKET = 188;

/** The byte offset of each TS packet on `pid`, so a buffer can be cut exactly at a boundary. */
const packetStartsOn = (bytes: Uint8Array, pid: number) => {
	const starts: number[] = [];
	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		if ((((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!) === pid) {
			starts.push(at);
		}
	}
	return starts;
};

test('a PES the buffer cuts short is never returned as whole', () => {
	const whole = fixture();
	const complete = readPrivatePesPayloads(whole, 0x200);
	expect(complete.length).toBeGreaterThan(1);

	const starts = packetStartsOn(whole, 0x200);
	expect(starts.length).toBeGreaterThan(complete.length); // multi-packet PES, or there is nothing to cut

	let sawAShortenedList = false;

	// Cut at every TS boundary on the PID, which lands mid-PES as often as not
	for (const cut of starts) {
		const got = readPrivatePesPayloads(whole.subarray(0, cut), 0x200);

		// Whatever survives is a prefix of the whole read, byte for byte - so the packets before the cut
		// are untouched and the cut one is absent rather than short
		expect(got.length).toBeLessThanOrEqual(complete.length);
		for (let i = 0; i < got.length; i++) {
			expect(bytesToHexString(got[i]!.data)).toBe(bytesToHexString(complete[i]!.data));
			expect(got[i]!.time).toBe(complete[i]!.time);
		}
		if (got.length < complete.length) {
			sawAShortenedList = true;
		}
	}

	// The cuts have to have actually dropped something, or this proves nothing
	expect(sawAShortenedList).toBe(true);
});

test('with PES_packet_length 0, a packet ends only at the next unit start', () => {
	const whole = fixture();
	const starts = packetStartsOn(whole, 0x200);

	// Zero the PES_packet_length of every PES on the PID, making each one unbounded
	const unbounded = new Uint8Array(whole);
	let zeroed = 0;
	for (const at of starts) {
		if (!(unbounded[at + 1]! & 0x40)) {
			continue; // Not a unit start, so no PES header here
		}
		const adaptation = (unbounded[at + 3]! >> 4) & 0x3;
		const payloadAt = adaptation === 2 || adaptation === 3 ? at + 5 + unbounded[at + 4]! : at + 4;
		if (unbounded[payloadAt] === 0 && unbounded[payloadAt + 1] === 0 && unbounded[payloadAt + 2] === 1) {
			unbounded[payloadAt + 4] = 0;
			unbounded[payloadAt + 5] = 0;
			zeroed++;
		}
	}
	expect(zeroed).toBeGreaterThan(1);

	const bounded = readPrivatePesPayloads(whole, 0x200);
	const got = readPrivatePesPayloads(unbounded, 0x200);

	// One fewer: each packet now ends at the next unit start, and the last has no next
	expect(got).toHaveLength(bounded.length - 1);
	for (let i = 0; i < got.length; i++) {
		expect(got[i]!.time).toBe(bounded[i]!.time);
		// Unbounded runs to the next unit start, so it carries the stuffing a stated length excluded
		expect(bytesToHexString(got[i]!.data).startsWith(bytesToHexString(bounded[i]!.data))).toBe(true);
	}
});

// The write side. A private stream is declared on the format and its payloads handed over whole, which
// is the MPEG-TS pass-through for teletext and DVB subtitles: nothing here composes either payload, so
// the descriptors are what identify the stream and both are written byte for byte.

const TELETEXT_PID = 0x1f00;
const SUBTITLE_PID = 0x1f01;
/** teletext_descriptor, EN 300 468 6.2.43: eng, subtitle page, magazine 0 page 0x88 — 888. */
const TELETEXT_DESCRIPTOR = new Uint8Array([0x56, 0x05, 0x65, 0x6e, 0x67, 0x10, 0x88]);
/** subtitling_descriptor, 6.2.41: eng, type 0x10, composition page 1, ancillary page 1. */
const SUBTITLING_DESCRIPTOR = new Uint8Array([
	0x59, 0x08, 0x65, 0x6e, 0x67, 0x10, 0x00, 0x01, 0x00, 0x01,
]);

const videoSample = async () => {
	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === 25) {
			break;
		}
	}
	return { packets, config };
};

/** A second of 25 fps video with the given private payloads written into it. */
const buildWithPrivateStreams = async (payloads: { pid: number; time: number; data: Uint8Array }[]) => {
	const { packets, config } = await videoSample();

	const output = new Output({
		format: new MpegTsOutputFormat({
			timestampOffset: 0,
			privateStreams: [
				{ pid: TELETEXT_PID, descriptors: [TELETEXT_DESCRIPTOR] },
				{ pid: SUBTITLE_PID, descriptors: [SUBTITLING_DESCRIPTOR] },
			],
		}),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	for (const payload of payloads) {
		addPrivatePesPayload(output, payload);
	}

	for (let i = 0; i < 25; i++) {
		await videoSource.add(
			new EncodedPacket(packets[i]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

/** Each PMT entry's stream_type, PID and descriptor bytes, straight off the wire. */
const pmtEntries = (bytes: Uint8Array) => {
	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		if (pid !== 0x1000 || !(bytes[at + 1]! & 0x40)) {
			continue;
		}

		const control = (bytes[at + 3]! >> 4) & 0x3;
		const payloadAt = control === 3 ? at + 5 + bytes[at + 4]! : at + 4;
		const start = payloadAt + 1 + bytes[payloadAt]!;
		const sectionEnd = start + 3 + (((bytes[start + 1]! & 0x0f) << 8) | bytes[start + 2]!);
		const programInfoLength = ((bytes[start + 10]! & 0x0f) << 8) | bytes[start + 11]!;
		const entries: { streamType: number; pid: number; descriptors: string }[] = [];

		// Four bytes of CRC close the section
		for (let pos = start + 12 + programInfoLength; pos + 5 <= sectionEnd - 4;) {
			const esInfoLength = ((bytes[pos + 3]! & 0x0f) << 8) | bytes[pos + 4]!;
			entries.push({
				streamType: bytes[pos]!,
				pid: ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!,
				descriptors: bytesToHexString(bytes.subarray(pos + 5, pos + 5 + esInfoLength)),
			});
			pos += 5 + esInfoLength;
		}

		return entries;
	}

	throw new Error('no PMT in the stream');
};

test('the PMT lists each declared private stream with its descriptors byte for byte', async () => {
	const stream = await buildWithPrivateStreams([]);
	const entries = pmtEntries(stream);

	expect(entries.find(entry => entry.pid === TELETEXT_PID)).toEqual({
		pid: TELETEXT_PID,
		streamType: 0x06,
		descriptors: bytesToHexString(TELETEXT_DESCRIPTOR),
	});
	expect(entries.find(entry => entry.pid === SUBTITLE_PID)).toEqual({
		pid: SUBTITLE_PID,
		streamType: 0x06,
		descriptors: bytesToHexString(SUBTITLING_DESCRIPTOR),
	});

	// Read back by the parser rather than by the test's own walker, which is a second opinion on the
	// bytes: a descriptor written one byte off parses to something else or to nothing at all
	const parsed = readMpegTsPrivateStreams(stream);
	expect(parsed.find(entry => entry.pid === TELETEXT_PID)!.teletext)
		.toEqual([{ language: 'eng', type: 0x02, magazine: 0, page: 888 }]);
	expect(parsed.find(entry => entry.pid === SUBTITLE_PID)!.subtitles)
		.toEqual([{ language: 'eng', type: 0x10, compositionPageId: 1, ancillaryPageId: 1 }]);
});

test('the declared streams are in every PMT repeat, not just the first', async () => {
	const stream = await buildWithPrivateStreams([]);

	let repeats = 0;
	for (let at = 0; at + PACKET <= stream.byteLength; at += PACKET) {
		const pid = ((stream[at + 1]! & 0x1f) << 8) | stream[at + 2]!;
		if (pid === 0x1000 && (stream[at + 1]! & 0x40)) {
			repeats++;
			// Read from this copy onwards, so a declaration present only in the first PMT would be seen
			expect(pmtEntries(stream.subarray(at)).filter(entry => entry.pid >= TELETEXT_PID))
				.toHaveLength(2);
		}
	}

	// A second of stream at the 0.1 s default
	expect(repeats).toBeGreaterThan(5);
});

test('a payload read off a stream, written, and read back is byte-identical with the same PTS', async () => {
	const sourceStream = fixture();
	const teletext = readPrivatePesPayloads(sourceStream, 0x200)
		.filter(payload => payload.time !== null);
	const subtitles = readPrivatePesPayloads(sourceStream, 0x201)
		.filter(payload => payload.time !== null);
	expect(teletext.length).toBeGreaterThan(0);
	expect(subtitles.length).toBeGreaterThan(0);

	// Onto the output's own timeline, which is a second of 25 fps video
	const onto = (payloads: PrivatePesPayload[], pid: number) =>
		payloads.map((payload, index) => ({ pid, time: index * 0.04, data: payload.data }));
	const written = [...onto(teletext, TELETEXT_PID), ...onto(subtitles, SUBTITLE_PID)];

	const stream = await buildWithPrivateStreams(written);

	for (const pid of [TELETEXT_PID, SUBTITLE_PID]) {
		const expected = written.filter(payload => payload.pid === pid);
		const read = readPrivatePesPayloads(stream, pid);

		expect(read).toHaveLength(expected.length);
		for (const [index, payload] of read.entries()) {
			expect(bytesToHexString(payload.data)).toBe(bytesToHexString(expected[index]!.data));
			expect(payload.time).toBeCloseTo(expected[index]!.time, 5);
		}
	}
});

test('a payload lands among the media at its own time, not where it was handed over', async () => {
	// All four queued before any media packet is added, and spread across the second
	const payloads = [0.1, 0.4, 0.7, 0.95].map((time, index) => ({
		pid: TELETEXT_PID,
		time,
		data: new Uint8Array([0x10, index, 0xff, 0xff]),
	}));
	const stream = await buildWithPrivateStreams(payloads);

	// The video PTS in force when each private packet appears, which is what an interleave means here
	let videoPts = -1;
	const seenAt: number[] = [];
	for (let at = 0; at + PACKET <= stream.byteLength; at += PACKET) {
		const pid = ((stream[at + 1]! & 0x1f) << 8) | stream[at + 2]!;
		if (!(stream[at + 1]! & 0x40)) {
			continue;
		}

		const control = (stream[at + 3]! >> 4) & 0x3;
		const payloadAt = control === 3 ? at + 5 + stream[at + 4]! : at + 4;
		if (stream[payloadAt] !== 0 || stream[payloadAt + 1] !== 0 || stream[payloadAt + 2] !== 1) {
			continue;
		}

		const pts = (((stream[payloadAt + 9]! >> 1) & 0x7) * 2 ** 30
			+ ((((stream[payloadAt + 10]! << 8) | stream[payloadAt + 11]!) >>> 1) * 2 ** 15)
			+ ((((stream[payloadAt + 12]! << 8) | stream[payloadAt + 13]!) >>> 1))) / 90_000;

		if (pid === 0x100) {
			videoPts = pts;
		} else if (pid === TELETEXT_PID) {
			seenAt.push(videoPts);
		}
	}

	expect(seenAt).toHaveLength(4);
	// Each one is written once the media has reached it and before the media has passed it by a frame
	for (const [index, mediaTime] of seenAt.entries()) {
		expect(mediaTime).toBeGreaterThanOrEqual(payloads[index]!.time - 0.041);
		expect(mediaTime).toBeLessThanOrEqual(payloads[index]!.time + 0.001);
	}
});

test('a payload for an undeclared PID is refused rather than written nowhere', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat({
			privateStreams: [{ pid: TELETEXT_PID, descriptors: [TELETEXT_DESCRIPTOR] }],
		}),
		target: new BufferTarget(),
	});
	output.addVideoTrack(new EncodedVideoPacketSource('avc'));
	await output.start();

	expect(() => addPrivatePesPayload(output, { pid: 0x1f02, time: 0, data: new Uint8Array(4) }))
		.toThrow(/declares no private stream/);
	// A PTS is what places it in the interleave, so a payload without one has nowhere to go
	expect(() => addPrivatePesPayload(
		output,
		{ pid: TELETEXT_PID, time: null as unknown as number, data: new Uint8Array(4) },
	)).toThrow(TypeError);
});

test('a descriptor whose length byte disagrees with its size is refused', () => {
	// It is copied into the PMT verbatim, so a wrong length shifts everything after it
	expect(() => new MpegTsOutputFormat({
		privateStreams: [{ pid: TELETEXT_PID, descriptors: [new Uint8Array([0x56, 0x09, 0x65])] }],
	})).toThrow(TypeError);
	expect(() => new MpegTsOutputFormat({
		privateStreams: [{ pid: 0x0001, descriptors: [TELETEXT_DESCRIPTOR] }],
	})).toThrow(TypeError);
});

// An implementation that is not this one reading the result. The round-trip above proves the bytes come
// back through our own reader; what a receiver makes of the descriptors is a separate claim, and ffprobe
// is the cheapest way to settle it. It skips where the binary is absent.
const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

test.skipIf(!hasFfprobe)('ffprobe reads the streams as dvb_teletext and dvb_subtitle', async () => {
	const stream = await buildWithPrivateStreams([
		{ pid: TELETEXT_PID, time: 0.1, data: new Uint8Array([0x10, 0x02, 0xff, 0xff]) },
		{ pid: SUBTITLE_PID, time: 0.2, data: new Uint8Array([0x20, 0x0f, 0x10, 0x00]) },
	]);
	const file = path.join(mkdtempSync(path.join(tmpdir(), 'mb-private-')), 'private.ts');
	writeFileSync(file, stream);

	const probe = JSON.parse(execFileSync('ffprobe', [
		'-v', 'error',
		'-print_format', 'json',
		'-show_streams',
		file,
	], { encoding: 'utf8' })) as { streams: { codec_name?: string; id?: string }[] };

	const codecs = new Map(probe.streams.map(entry => [parseInt(entry.id ?? '0', 16), entry.codec_name]));
	expect(codecs.get(TELETEXT_PID)).toBe('dvb_teletext');
	expect(codecs.get(SUBTITLE_PID)).toBe('dvb_subtitle');
});
