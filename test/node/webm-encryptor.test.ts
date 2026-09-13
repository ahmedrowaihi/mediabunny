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
const decryptWebmFrame = (framed: Uint8Array, key: Uint8Array = KEY): Uint8Array => {
	const signal = framed[0]!;
	if (signal === 0x00) {
		return framed.subarray(1);
	}
	const iv = framed.subarray(1, 9);
	const ctr = new AesCtrEncryptor();
	ctr.initializeWithIv(key, iv);
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
		const encSegment = encryptWebmSegment(initBytes, segmentBytes, {
			key: KEY, kid: KID, iv: IV, ivState: new Map(),
		});

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

	// `ivState` is a required parameter, so TypeScript refuses this call outright; the runtime check
	// behind it is the backstop for a caller that is not type-checked.
	test('a segment encrypted without ivState is refused rather than repeating the keystream', () => {
		const { initBytes, segmentBytes } = splitWebm(new Uint8Array(readFileSync(WEBM)));
		// @ts-expect-error omitting ivState is a compile error, which is the point
		expect(() => encryptWebmSegment(initBytes, segmentBytes, { key: KEY, kid: KID, iv: IV }))
			.toThrow(/ivState/);
	});

	// Tracks consume their IVs at different rates — 82 video frames against 167 audio in this file —
	// so no single frame count can continue both. The whole-file encryption is the sequence to match:
	// any divergence means that track's segment replays counters the previous segment already used,
	// and every WebM frame here is AES-CTR encrypted, so that is real keystream reuse.
	test('per-segment IVs continue the whole-file sequence on every track', () => {
		const original = new Uint8Array(readFileSync(WEBM));
		const nodes = parse(original, 0, original.length);
		const clusters = find(find(nodes, ID_SEGMENT)[0]!.children!, ID_CLUSTER);
		const initBytes = splitWebm(original).initBytes;

		const ivsByTrack = (frames: Map<number, Uint8Array[]>) =>
			new Map([...frames].map(([track, list]) => [track, list.map(frame => [...frame.subarray(1, 9)])]));

		const whole = ivsByTrack(framesByTrack(parse(
			encryptWebm(original, { key: KEY, kid: KID, iv: IV }), 0, original.length * 2,
		)));

		const half = Math.ceil(clusters.length / 2);
		const ivState = new Map<number, Uint8Array>();
		const split = [clusters.slice(0, half), clusters.slice(half)]
			.map(part => encryptWebmSegment(initBytes, serialize(part), { key: KEY, kid: KID, iv: IV, ivState }))
			.flatMap(part => parse(part, 0, part.length));
		const perSegment = ivsByTrack(framesFromClusters(split));

		expect(whole.size).toBe(2);
		for (const [track, list] of whole) {
			expect(list.length).toBeGreaterThan(0);
			expect(perSegment.get(track)).toEqual(list);
			// No IV is used twice: whole-frame CTR consumes keystream for every frame of every track.
			expect(new Set(list.map(iv => iv.join(','))).size).toBe(list.length);
		}
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

const VIDEO_KEY = new Uint8Array(16).fill(0x31);
const VIDEO_KID = new Uint8Array(16).fill(0xb1);
const AUDIO_KEY = new Uint8Array(16).fill(0x62);
const AUDIO_KID = new Uint8Array(16).fill(0xc2);
const AUDIO_IV = new Uint8Array(8).fill(0x77);

const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_CONTENT_ENCODING = 0x6240;
const ID_CONTENT_ENC_KEY_ID = 0x47e2;

const bigEndian = (data: Uint8Array): number => data.reduce((value, byte) => value * 256 + byte, 0);

const trackEntriesOf = (nodes: Node[]): Node[] =>
	find(find(find(nodes, ID_SEGMENT)[0]!.children!, ID_TRACKS)[0]!.children!, ID_TRACK_ENTRY);

const trackNumberOfType = (nodes: Node[], trackType: number): number => {
	const entry = trackEntriesOf(nodes)
		.find(e => bigEndian(find(e.children!, ID_TRACK_TYPE)[0]!.data!) === trackType)!;
	return bigEndian(find(entry.children!, ID_TRACK_NUMBER)[0]!.data!);
};

// The ContentEncKeyID of one track, which is where WebM states a key ID: per TrackEntry, since it
// has no file-wide `tenc` to state one in.
const kidOf = (nodes: Node[], trackNumber: number): Uint8Array => {
	const entry = trackEntriesOf(nodes)
		.find(e => bigEndian(find(e.children!, ID_TRACK_NUMBER)[0]!.data!) === trackNumber)!;
	const encoding = find(find(entry.children!, ID_CONTENT_ENCODINGS)[0]!.children!, ID_CONTENT_ENCODING)[0]!;
	const encryption = find(encoding.children!, ID_CONTENT_ENCRYPTION)[0]!;
	return find(encryption.children!, ID_CONTENT_ENC_KEY_ID)[0]!.data!;
};

describe('encryptWebm with per-track keys', () => {
	const load = () => {
		const original = new Uint8Array(readFileSync(WEBM));
		const nodes = parse(original, 0, original.length);
		return { original, video: trackNumberOfType(nodes, 1), audio: trackNumberOfType(nodes, 2) };
	};

	const trackKeysOf = (video: number, audio: number) => new Map([
		[video, { key: VIDEO_KEY, kid: VIDEO_KID }],
		[audio, { key: AUDIO_KEY, kid: AUDIO_KID, iv: AUDIO_IV }],
	]);

	test('each track carries its own ContentEncKeyID and decrypts only under its own key', () => {
		const { original, video, audio } = load();
		const originalFrames = framesByTrack(parse(original, 0, original.length));

		const encrypted = encryptWebm(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: trackKeysOf(video, audio),
		});
		const encNodes = parse(encrypted, 0, encrypted.length);

		expect([...kidOf(encNodes, video)]).toEqual([...VIDEO_KID]);
		expect([...kidOf(encNodes, audio)]).toEqual([...AUDIO_KID]);

		const encFrames = framesByTrack(encNodes);
		// The audio track's own IV starts its sequence, not the file-wide one.
		expect([...encFrames.get(audio)![0]!.subarray(1, 9)]).toEqual([...AUDIO_IV]);
		expect([...encFrames.get(video)![0]!.subarray(1, 9)]).toEqual([...IV]);

		for (const [track, key] of [[video, VIDEO_KEY], [audio, AUDIO_KEY]] as const) {
			const frames = encFrames.get(track)!;
			const originals = originalFrames.get(track)!;
			expect(frames.length).toBe(originals.length);
			for (let i = 0; i < frames.length; i++) {
				expect([...decryptWebmFrame(frames[i]!, key)]).toEqual([...originals[i]!]);
			}
		}

		// No keystream is shared between the tracks: every frame of each track resists both the other
		// track's key and the top-level key.
		for (const [track, otherKey] of [[video, AUDIO_KEY], [audio, VIDEO_KEY]] as const) {
			const frames = encFrames.get(track)!;
			const originals = originalFrames.get(track)!;
			for (let i = 0; i < frames.length; i++) {
				expect([...decryptWebmFrame(frames[i]!, otherKey)]).not.toEqual([...originals[i]!]);
				expect([...decryptWebmFrame(frames[i]!, KEY)]).not.toEqual([...originals[i]!]);
			}
		}
	});

	test('the split init/segment API is byte-identical to the whole-file output under the same keys', () => {
		const { original, video, audio } = load();
		const { initBytes, segmentBytes, clusters } = splitWebm(original);
		const originalFrames = framesFromClusters(clusters);
		const trackKeys = trackKeysOf(video, audio);

		const encInit = encryptWebmInit(initBytes, { key: KEY, kid: KID, iv: IV, trackKeys });
		const encSegment = encryptWebmSegment(initBytes, segmentBytes, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys,
			ivState: new Map(),
		});

		const initNodes = parse(encInit, 0, encInit.length);
		expect([...kidOf(initNodes, video)]).toEqual([...VIDEO_KID]);
		expect([...kidOf(initNodes, audio)]).toEqual([...AUDIO_KID]);

		// Whole-file and split delivery must produce the same encrypted clusters, byte for byte.
		const whole = encryptWebm(original, { key: KEY, kid: KID, iv: IV, trackKeys });
		const wholeSegment = find(parse(whole, 0, whole.length), ID_SEGMENT)[0]!;
		const wholeClusters = serialize(find(wholeSegment.children!, ID_CLUSTER));
		expect([...encSegment]).toEqual([...wholeClusters]);

		const encFrames = framesFromClusters(parse(encSegment, 0, encSegment.length));
		for (const [track, key] of [[video, VIDEO_KEY], [audio, AUDIO_KEY]] as const) {
			const frames = encFrames.get(track)!;
			const originals = originalFrames.get(track)!;
			expect(frames.length).toBe(originals.length);
			for (let i = 0; i < frames.length; i++) {
				expect([...decryptWebmFrame(frames[i]!, key)]).toEqual([...originals[i]!]);
			}
		}
	});

	test('a trackKeys that does not name every encryptable track is refused', () => {
		const { original, video, audio } = load();
		expect(() => encryptWebm(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([[video, { key: VIDEO_KEY, kid: VIDEO_KID }]]),
		})).toThrow(new RegExp(`states no key for track ${audio}`));
	});

	test('a trackKeys naming a track the file does not have is refused', () => {
		const { original, video, audio } = load();
		expect(() => encryptWebm(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([
				[video, { key: VIDEO_KEY, kid: VIDEO_KID }],
				[audio, { key: AUDIO_KEY, kid: AUDIO_KID }],
				[99, { key: KEY, kid: KID }],
			]),
		})).toThrow(/trackKeys names track 99/);
	});

	test('a per-track IV that is not the 8 bytes a WebM frame header states is refused', () => {
		const { original, video, audio } = load();
		expect(() => encryptWebm(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([
				[video, { key: VIDEO_KEY, kid: VIDEO_KID, iv: new Uint8Array(16) }],
				[audio, { key: AUDIO_KEY, kid: AUDIO_KID }],
			]),
		})).toThrow(/16-byte IV for track/);
	});

	test('the init segment refuses the same trackKeys mistakes as the whole file', () => {
		const { original, video } = load();
		const { initBytes } = splitWebm(original);
		expect(() => encryptWebmInit(initBytes, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([[video, { key: VIDEO_KEY, kid: VIDEO_KID }]]),
		})).toThrow(/states no key for track/);
	});
});
