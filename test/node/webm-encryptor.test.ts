import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { AesCtrEncryptor } from '../../src/crypto/aes-ctr-encryptor.js';
import { encryptWebm, encryptWebmInit, encryptWebmSegment } from '../../src/crypto/webm-encryptor.js';

const WEBM = path.join(
	new URL('.', import.meta.url).pathname,
	'../../../shaka-packager/packager/media/test/data/bear-320x240-vp9.webm',
);
const KEY = new Uint8Array(16).fill(0x2b);
const KID = new Uint8Array(16).fill(0xa0);
const IV = new Uint8Array(8).fill(0x11);

const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_CONTENT_ENCRYPTION = 0x5035;
const RECURSED = new Set([ID_SEGMENT, ID_TRACKS, 0xae, ID_CLUSTER, 0xa0, 0x6d80, 0x6240, 0x5035, 0x47e7]);

type Node = { id: number; children?: Node[]; data?: Uint8Array };

const readVint = (b: Uint8Array, p: number): { value: number; length: number } => {
	const first = b[p]!;
	let length = 1;
	let mask = 0x80;
	while (mask !== 0 && (first & mask) === 0) {
		length++;
		mask >>= 1;
	}
	let value = first & (mask - 1);
	for (let i = 1; i < length; i++) {
		value = value * 256 + b[p + i]!;
	}
	return { value, length };
};

const parse = (b: Uint8Array, start: number, end: number): Node[] => {
	const nodes: Node[] = [];
	let pos = start;
	while (pos < end) {
		const idInfo = readVint(b, pos);
		let id = 0;
		for (let i = 0; i < idInfo.length; i++) {
			id = id * 256 + b[pos + i]!;
		}
		const size = readVint(b, pos + idInfo.length);
		const dataStart = pos + idInfo.length + size.length;
		const dataEnd = dataStart + size.value;
		nodes.push(RECURSED.has(id)
			? { id, children: parse(b, dataStart, dataEnd) }
			: { id, data: b.subarray(dataStart, dataEnd) });
		pos = dataEnd;
	}
	return nodes;
};

const find = (nodes: Node[], id: number): Node[] => nodes.filter(n => n.id === id);

// Minimal EBML serializer (mirror of the module's) so the test can split a muxed file into an init
// segment (EBML header + Segment{Info, Tracks}) and a bare media segment (Clusters).
const idLen = (id: number): number => {
	let length = 1;
	while (id >= 2 ** (8 * length)) {
		length++;
	}
	return length;
};
const writeBig = (value: number, length: number): Uint8Array => {
	const out = new Uint8Array(length);
	let remaining = value;
	for (let i = length - 1; i >= 0; i--) {
		out[i] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	return out;
};
const writeVint = (value: number): Uint8Array => {
	let length = 1;
	while (value >= 2 ** (7 * length) - 1) {
		length++;
	}
	const out = writeBig(value, length);
	out[0]! |= 0x80 >> (length - 1);
	return out;
};
const serialize = (nodes: Node[]): Uint8Array => {
	const parts = nodes.map((n) => {
		const data = n.children !== undefined ? serialize(n.children) : n.data!;
		const id = writeBig(n.id, idLen(n.id));
		const size = writeVint(data.length);
		const out = new Uint8Array(id.length + size.length + data.length);
		out.set(id, 0);
		out.set(size, id.length);
		out.set(data, id.length + size.length);
		return out;
	});
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
};

// Collect the raw frame payload of every SimpleBlock in a list of clusters, keyed by track number.
const framesFromClusters = (clusters: Node[]): Map<number, Uint8Array[]> => {
	const out = new Map<number, Uint8Array[]>();
	for (const cluster of clusters) {
		for (const block of find(cluster.children!, ID_SIMPLE_BLOCK)) {
			const b = block.data!;
			const { length: trackLen, value: track } = readVint(b, 0);
			const frame = b.subarray(trackLen + 3); // + int16 timecode + flags
			if (!out.has(track)) {
				out.set(track, []);
			}
			out.get(track)!.push(frame);
		}
	}
	return out;
};

const framesByTrack = (nodes: Node[]): Map<number, Uint8Array[]> =>
	framesFromClusters(find(find(nodes, ID_SEGMENT)[0]!.children!, ID_CLUSTER));

// Split a muxed WebM into an init segment (EBML header + Segment without clusters) and its clusters.
const splitWebm = (bytes: Uint8Array): { initBytes: Uint8Array; segmentBytes: Uint8Array; clusters: Node[] } => {
	const nodes = parse(bytes, 0, bytes.length);
	const segment = find(nodes, ID_SEGMENT)[0]!;
	const clusters = find(segment.children!, ID_CLUSTER);
	const header = nodes.filter(n => n.id !== ID_SEGMENT);
	const nonClusters = segment.children!.filter(n => n.id !== ID_CLUSTER);
	return {
		initBytes: serialize([...header, { id: ID_SEGMENT, children: nonClusters }]),
		segmentBytes: serialize(clusters),
		clusters,
	};
};

// Reverse the WebM encryption framing + AES-CTR to recover the original frame.
const decryptWebmFrame = (framed: Uint8Array): Uint8Array => {
	const signal = framed[0]!;
	if (signal === 0x00) {
		return framed.subarray(1);
	}
	const iv = framed.subarray(1, 9);
	const ctr = new AesCtrEncryptor();
	ctr.initializeWithIv(KEY, iv);
	ctr.setIv(iv);
	if ((signal & 0x02) === 0) {
		const data = new Uint8Array(framed.subarray(9));
		ctr.crypt(data);
		return data;
	}
	const numPartitions = framed[9]!;
	const offsets: number[] = [];
	const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
	for (let i = 0; i < numPartitions; i++) {
		offsets.push(view.getUint32(10 + 4 * i));
	}
	const data = new Uint8Array(framed.subarray(10 + 4 * numPartitions));
	// Regions alternate clear/cipher starting with clear; decrypt the cipher (odd-index) regions.
	const bounds = [0, ...offsets, data.length];
	for (let i = 0; i < bounds.length - 1; i++) {
		if (i % 2 === 1) {
			ctr.crypt(data.subarray(bounds[i], bounds[i + 1]));
		}
	}
	return data;
};

// De-lace an EBML-laced block payload (after the flags byte) into frames.
const deLaceEbml = (payload: Uint8Array): Uint8Array[] => {
	const numFrames = payload[0]! + 1;
	let pos = 1;
	const first = readVint(payload, pos);
	const sizes = [first.value];
	pos += first.length;
	for (let i = 1; i < numFrames - 1; i++) {
		const raw = readVint(payload, pos);
		sizes.push(sizes[i - 1]! + (raw.value - (2 ** (7 * raw.length - 1) - 1)));
		pos += raw.length;
	}
	const frames: Uint8Array[] = [];
	for (const size of sizes) {
		frames.push(payload.subarray(pos, pos + size));
		pos += size;
	}
	frames.push(payload.subarray(pos));
	return frames;
};

// Build a minimal single-audio-track WebM whose one Cluster holds a laced SimpleBlock of `frames`.
const laceXiph = (frames: Uint8Array[]): Uint8Array => {
	const sizeBytes: number[] = [];
	for (let i = 0; i < frames.length - 1; i++) {
		let remaining = frames[i]!.length;
		while (remaining >= 255) {
			sizeBytes.push(0xff);
			remaining -= 255;
		}
		sizeBytes.push(remaining);
	}
	const body = [0x81, 0x00, 0x00, 0x02, frames.length - 1, ...sizeBytes]; // track 1, tc 0, Xiph lacing
	for (const f of frames) {
		body.push(...f);
	}
	return Uint8Array.from(body);
};

const writeSignedVintTest = (delta: number): Uint8Array => {
	let length = 1;
	const bias = (l: number) => 2 ** (7 * l - 1) - 1;
	while (delta < -bias(length) || delta > bias(length)) {
		length++;
	}
	const out = writeVint(delta + bias(length));
	// writeVint picks its own length; re-pack at the length the delta needed.
	if (out.length === length) {
		return out;
	}
	const packed = writeBig(delta + bias(length), length);
	packed[0]! |= 0x80 >> (length - 1);
	return packed;
};

// Fixed lacing: no size list; all frames equal length.
const laceFixed = (frames: Uint8Array[]): Uint8Array => {
	const body = [0x81, 0x00, 0x00, 0x04, frames.length - 1];
	for (const f of frames) {
		body.push(...f);
	}
	return Uint8Array.from(body);
};

// EBML lacing input: size0 as a vint, then signed-vint deltas.
const laceEbmlInput = (frames: Uint8Array[]): Uint8Array => {
	const body: number[] = [0x81, 0x00, 0x00, 0x06, frames.length - 1, ...writeVint(frames[0]!.length)];
	for (let i = 1; i < frames.length - 1; i++) {
		body.push(...writeSignedVintTest(frames[i]!.length - frames[i - 1]!.length));
	}
	for (const f of frames) {
		body.push(...f);
	}
	return Uint8Array.from(body);
};

const craftLacedWebm = (block: Uint8Array): Uint8Array => serialize([
	{ id: 0x1a45dfa3, data: new Uint8Array(0) }, // EBML header (content irrelevant here)
	{
		id: ID_SEGMENT,
		children: [
			{
				id: ID_TRACKS,
				children: [{
					id: 0xae,
					children: [
						{ id: 0xd7, data: Uint8Array.from([0x01]) }, // TrackNumber 1
						{ id: 0x83, data: Uint8Array.from([0x02]) }, // TrackType audio
						{ id: 0x86, data: new TextEncoder().encode('A_VORBIS') }, // CodecID
					],
				}],
			},
			{
				id: ID_CLUSTER,
				children: [
					{ id: 0xe7, data: Uint8Array.from([0x00]) }, // Timestamp
					{ id: ID_SIMPLE_BLOCK, data: block },
				],
			},
		],
	},
]);

describe('encryptWebm (WebM Encryption, AES-CTR)', () => {
	test('encrypts VP9 + Vorbis of bear-320x240-vp9.webm; every frame round-trips', () => {
		const original = new Uint8Array(readFileSync(WEBM));
		const originalFrames = framesByTrack(parse(original, 0, original.length));
		expect(originalFrames.size).toBe(2); // video + audio

		const encrypted = encryptWebm(original, { key: KEY, kid: KID, iv: IV });

		const encNodes = parse(encrypted, 0, encrypted.length);
		// Both tracks now carry a ContentEncryption element.
		const trackEntries = find(find(find(encNodes, ID_SEGMENT)[0]!.children!, ID_TRACKS)[0]!.children!, 0xae);
		expect(trackEntries.length).toBe(2);
		for (const entry of trackEntries) {
			expect(find(entry.children!, 0x6d80).length).toBe(1); // ContentEncodings
			expect(find(find(find(entry.children!, 0x6d80)[0]!.children!, 0x6240)[0]!.children!, ID_CONTENT_ENCRYPTION))
				.toHaveLength(1);
		}

		// Every encrypted frame decrypts back to the original bytes.
		const encFrames = framesByTrack(encNodes);
		expect([...encFrames.keys()].sort()).toEqual([...originalFrames.keys()].sort());
		for (const [track, frames] of encFrames) {
			const originals = originalFrames.get(track)!;
			expect(frames.length).toBe(originals.length);
			for (let i = 0; i < frames.length; i++) {
				expect(frames[i]![0]! & 0x01).toBe(0x01); // encrypted signal
				expect([...decryptWebmFrame(frames[i]!)]).toEqual([...originals[i]!]);
			}
		}
	});

	test('VP9 video frames use partitioned subsample encryption (header clear)', () => {
		const original = new Uint8Array(readFileSync(WEBM));
		const encrypted = encryptWebm(original, { key: KEY, kid: KID, iv: IV });
		const encFrames = framesByTrack(parse(encrypted, 0, encrypted.length));
		// The video track (lower track number in this file) has partitioned frames (signal bit 0x02).
		const videoTrack = Math.min(...encFrames.keys());
		expect(encFrames.get(videoTrack)!.some(f => (f[0]! & 0x02) === 0x02)).toBe(true);
	});

	test('encrypts AV1 (bear-av1.webm) with tile subsample partitions; frames round-trip', () => {
		const av1Webm = path.join(
			new URL('.', import.meta.url).pathname,
			'../../../shaka-packager/packager/media/test/data/bear-av1.webm',
		);
		const original = new Uint8Array(readFileSync(av1Webm));
		const originalFrames = framesByTrack(parse(original, 0, original.length));
		const encrypted = encryptWebm(original, { key: KEY, kid: KID, iv: IV });
		const encFrames = framesByTrack(parse(encrypted, 0, encrypted.length));

		for (const [track, frames] of encFrames) {
			const originals = originalFrames.get(track)!;
			expect(frames.length).toBe(originals.length);
			expect(frames.some(f => (f[0]! & 0x02) === 0x02)).toBe(true); // AV1 video → partitioned
			for (let i = 0; i < frames.length; i++) {
				expect([...decryptWebmFrame(frames[i]!)]).toEqual([...originals[i]!]);
			}
		}
	});

	test('split init/segment (JIT) API: init signals encryption, segment frames round-trip', () => {
		const original = new Uint8Array(readFileSync(WEBM));
		const { initBytes, segmentBytes, clusters } = splitWebm(original);
		const originalFrames = framesFromClusters(clusters);

		const encInit = encryptWebmInit(initBytes, { key: KEY, kid: KID, iv: IV });
		const encSegment = encryptWebmSegment(initBytes, segmentBytes, { key: KEY, kid: KID, iv: IV });

		// The init's tracks now carry ContentEncryption.
		const initSegment = find(parse(encInit, 0, encInit.length), ID_SEGMENT)[0]!;
		const initTracks = find(find(initSegment.children!, ID_TRACKS)[0]!.children!, 0xae);
		expect(initTracks.length).toBe(2);
		for (const entry of initTracks) {
			expect(find(entry.children!, 0x6d80).length).toBe(1);
		}

		// The separately-encrypted segment's frames still decrypt back byte-exact.
		const encFrames = framesFromClusters(parse(encSegment, 0, encSegment.length));
		for (const [track, frames] of encFrames) {
			const originals = originalFrames.get(track)!;
			expect(frames.length).toBe(originals.length);
			for (let i = 0; i < frames.length; i++) {
				expect([...decryptWebmFrame(frames[i]!)]).toEqual([...originals[i]!]);
			}
		}
	});

	test('frameOffset continues the IV sequence so segments never reuse a keystream', () => {
		const original = new Uint8Array(readFileSync(WEBM));
		const { initBytes, segmentBytes } = splitWebm(original);

		const encA = encryptWebmSegment(initBytes, segmentBytes, { key: KEY, kid: KID, iv: IV, frameOffset: 0 });
		const encB = encryptWebmSegment(initBytes, segmentBytes, { key: KEY, kid: KID, iv: IV, frameOffset: 100 });
		const framesA = framesFromClusters(parse(encA, 0, encA.length));
		const framesB = framesFromClusters(parse(encB, 0, encB.length));
		const track = Math.min(...framesA.keys());
		// Same frame, different offset → different IV in the header (bytes 1..9), so keystreams never collide.
		expect([...framesA.get(track)![0]!.subarray(1, 9)]).not.toEqual([...framesB.get(track)![0]!.subarray(1, 9)]);
	});

	test('a Xiph-laced block is de-laced, each frame encrypted, and re-laced (EBML); frames round-trip', () => {
		const frames = [
			Uint8Array.from({ length: 5 }, (_, i) => i + 1),
			Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff),
			Uint8Array.from({ length: 7 }, (_, i) => 200 + i),
		];
		const webm = craftLacedWebm(laceXiph(frames));

		const encrypted = encryptWebm(webm, { key: KEY, kid: KID, iv: IV });

		const cluster = find(find(parse(encrypted, 0, encrypted.length), ID_SEGMENT)[0]!.children!, ID_CLUSTER)[0]!;
		const block = find(cluster.children!, ID_SIMPLE_BLOCK)[0]!.data!;
		// The output uses EBML lacing (flags bits 0x06) since encryption makes the frame sizes uneven.
		expect((block[3]! >> 1) & 0x3).toBe(3);

		const encFrames = deLaceEbml(block.subarray(4)); // after track(1) + timecode(2) + flags(1)
		expect(encFrames.length).toBe(3);
		for (let i = 0; i < frames.length; i++) {
			expect(encFrames[i]![0]! & 0x01).toBe(0x01); // each laced frame independently encrypted
			expect([...decryptWebmFrame(encFrames[i]!)]).toEqual([...frames[i]!]);
		}
	});

	const expectLacedRoundTrip = (frames: Uint8Array[], block: Uint8Array) => {
		const encrypted = encryptWebm(craftLacedWebm(block), { key: KEY, kid: KID, iv: IV });
		const cluster = find(find(parse(encrypted, 0, encrypted.length), ID_SEGMENT)[0]!.children!, ID_CLUSTER)[0]!;
		const out = find(cluster.children!, ID_SIMPLE_BLOCK)[0]!.data!;
		const encFrames = deLaceEbml(out.subarray(4));
		expect(encFrames.length).toBe(frames.length);
		for (let i = 0; i < frames.length; i++) {
			expect([...decryptWebmFrame(encFrames[i]!)]).toEqual([...frames[i]!]);
		}
	};

	test('fixed-lacing input round-trips (equal-size frames)', () => {
		const frames = [0, 1, 2].map(n => Uint8Array.from({ length: 8 }, (_, i) => n * 8 + i));
		expectLacedRoundTrip(frames, laceFixed(frames));
	});

	test('EBML-lacing input round-trips (vint + signed deltas)', () => {
		const frames = [
			Uint8Array.from({ length: 20 }, (_, i) => i),
			Uint8Array.from({ length: 5 }, (_, i) => 100 + i), // negative delta
			Uint8Array.from({ length: 40 }, (_, i) => 200 + (i & 0x1f)),
		];
		expectLacedRoundTrip(frames, laceEbmlInput(frames));
	});
});
