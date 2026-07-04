/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * WebM Encryption framing ported from Shaka Packager, Copyright 2015 Google LLC. All rights reserved.
 * Original source: shaka-packager/packager/media/formats/webm/encryptor.cc
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License (original) and MPL-2.0 (mediabunny).
 */

import { AesCtrEncryptor } from './aes-ctr-encryptor';
import { SampleEncryptor } from './sample-encryptor';
import type { EncryptionCodec, SubsampleEntry } from './subsample-generator';

// EBML element IDs (with their marker bits). The structural ones mirror the fork's `EBMLId`; the
// encryption-signaling ones are not in that enum, so they are defined here.
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_CONTENT_ENCODING = 0x6240;
const ID_CONTENT_ENCODING_ORDER = 0x5031;
const ID_CONTENT_ENCODING_SCOPE = 0x5032;
const ID_CONTENT_ENCODING_TYPE = 0x5033;
const ID_CONTENT_ENCRYPTION = 0x5035;
const ID_CONTENT_ENC_ALGO = 0x47e1;
const ID_CONTENT_ENC_KEY_ID = 0x47e2;
const ID_CONTENT_ENC_AES_SETTINGS = 0x47e7;
const ID_AES_SETTINGS_CIPHER_MODE = 0x47e8;

// Elements whose children we walk/mutate; everything else stays an opaque leaf and is re-emitted verbatim.
const RECURSED_MASTERS = new Set([ID_SEGMENT, ID_TRACKS, ID_TRACK_ENTRY, ID_CLUSTER, ID_BLOCK_GROUP]);

const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;

// shaka-packager/webm_constants.h
const WEBM_IV_SIZE = 8;
const WEBM_ENCRYPTED_SIGNAL = 0x01;
const WEBM_PARTITIONED_SIGNAL = 0x02;

/**
 * Options for {@link encryptWebm}, {@link encryptWebmInit} and {@link encryptWebmSegment}.
 *
 * @group Encryption
 * @public
 */
export type EncryptWebmOptions = {
	/** The 16-byte AES-128 content encryption key. */
	key: Uint8Array;
	/** The key ID written to each encrypted track's `ContentEncKeyID`. */
	kid: Uint8Array;
	/** The initial 8-byte per-frame IV; each frame increments it by one (per track). */
	iv: Uint8Array;
};

type EbmlNode = { id: number; children?: EbmlNode[]; data?: Uint8Array };

/**
 * Encrypt a WebM/Matroska file in place with WebM Encryption (AES-CTR): every video (VP9/AV1) and
 * audio track gets a `ContentEncryption` element and each frame is CTR-encrypted and reframed with a
 * signal byte + IV (+ subsample partition offsets for video). Mirrors shaka-packager's WebM encryptor.
 *
 * VP9/AV1 video uses partitioned subsample encryption (the codec header/tiles stay clear); other
 * tracks are whole-frame encrypted. Laced blocks are not supported.
 *
 * @group Encryption
 * @public
 */
export const encryptWebm = (bytes: Uint8Array, opts: EncryptWebmOptions): Uint8Array => {
	const nodes = parseEbml(bytes, 0, bytes.length);
	const encryptors = new Map<number, TrackEncryptor>();
	forEachTrackEntry(requireSegment(nodes), (entry) => {
		const meta = trackMeta(entry);
		if (meta === null) {
			return;
		}
		addContentEncryption(entry, opts.kid);
		encryptors.set(meta.trackNumber, buildTrackEncryptor(meta, opts, 0));
	});
	for (const cluster of collectClusters(nodes)) {
		encryptCluster(cluster, encryptors);
	}
	return serializeEbml(nodes);
};

/**
 * Transform a WebM init segment (EBML header + `Segment` with `Info`/`Tracks`, no clusters): add a
 * `ContentEncryption` element to each encryptable track. Pair with {@link encryptWebmSegment}.
 *
 * @group Encryption
 * @public
 */
export const encryptWebmInit = (init: Uint8Array, opts: EncryptWebmOptions): Uint8Array => {
	const nodes = parseEbml(init, 0, init.length);
	forEachTrackEntry(requireSegment(nodes), (entry) => {
		if (trackMeta(entry) !== null) {
			addContentEncryption(entry, opts.kid);
		}
	});
	return serializeEbml(nodes);
};

/**
 * Encrypt one WebM media segment (a run of `Cluster`s, optionally wrapped in `Segment`) against its
 * init segment, which supplies the track/codec info. Pass `frameOffset` — the number of frames in
 * earlier segments — so each track's per-frame IV sequence continues without repeating (matching
 * {@link encryptCmafSegment}'s `sampleIndexOffset`; a single value per demuxed representation).
 *
 * @group Encryption
 * @public
 */
export const encryptWebmSegment = (
	init: Uint8Array, segment: Uint8Array, opts: EncryptWebmOptions & { frameOffset?: number },
): Uint8Array => {
	const encryptors = new Map<number, TrackEncryptor>();
	forEachTrackEntry(requireSegment(parseEbml(init, 0, init.length)), (entry) => {
		const meta = trackMeta(entry);
		if (meta !== null) {
			encryptors.set(meta.trackNumber, buildTrackEncryptor(meta, opts, opts.frameOffset ?? 0));
		}
	});
	const nodes = parseEbml(segment, 0, segment.length);
	for (const cluster of collectClusters(nodes)) {
		encryptCluster(cluster, encryptors);
	}
	return serializeEbml(nodes);
};

const requireSegment = (nodes: EbmlNode[]): EbmlNode => {
	const segment = nodes.find(n => n.id === ID_SEGMENT);
	if (segment?.children === undefined) {
		throw new Error('No Segment found in WebM.');
	}
	return segment;
};

const forEachTrackEntry = (segment: EbmlNode, cb: (entry: EbmlNode) => void): void => {
	for (const tracks of (segment.children ?? []).filter(n => n.id === ID_TRACKS)) {
		for (const entry of tracks.children ?? []) {
			if (entry.id === ID_TRACK_ENTRY) {
				cb(entry);
			}
		}
	}
};

// Clusters live under the Segment in a whole file, but a bare media segment carries them at top level.
const collectClusters = (nodes: EbmlNode[]): EbmlNode[] => {
	const segment = nodes.find(n => n.id === ID_SEGMENT);
	return (segment?.children ?? nodes).filter(n => n.id === ID_CLUSTER);
};

// Add `n` (big-endian) to an 8-byte IV so a track's per-frame CTR sequence continues across segments.
const advanceIv = (iv: Uint8Array, n: number): Uint8Array => {
	const out = new Uint8Array(iv);
	let carry = n;
	for (let i = out.length - 1; carry > 0 && i >= 0; i--) {
		carry += out[i]!;
		out[i] = carry & 0xff;
		carry = Math.floor(carry / 256);
	}
	return out;
};

type TrackEncryptor = {
	trackNumber: number;
	encryptFrame(frame: Uint8Array): Uint8Array;
};

const codecOf = (codecId: string): EncryptionCodec | null => {
	if (codecId === 'V_VP9') {
		return 'vp9';
	}
	if (codecId === 'V_AV1' || codecId === 'V_AV01') {
		return 'av1';
	}
	return null; // other tracks are whole-frame encrypted; no subsample codec needed
};

type TrackMeta = { trackNumber: number; trackType: number; codecId: string };

// Read a track's number/type/codec, or null if it is not an encryptable video/audio track.
const trackMeta = (entry: EbmlNode): TrackMeta | null => {
	let trackNumber = 0;
	let trackType = 0;
	let codecId = '';
	for (const child of entry.children ?? []) {
		if (child.id === ID_TRACK_NUMBER && child.data) {
			trackNumber = readUint(child.data);
		} else if (child.id === ID_TRACK_TYPE && child.data) {
			trackType = readUint(child.data);
		} else if (child.id === ID_CODEC_ID && child.data) {
			codecId = new TextDecoder().decode(child.data);
		}
	}
	if (trackType !== TRACK_TYPE_VIDEO && trackType !== TRACK_TYPE_AUDIO) {
		return null;
	}
	return { trackNumber, trackType, codecId };
};

const addContentEncryption = (entry: EbmlNode, kid: Uint8Array): void => {
	entry.children = [...(entry.children ?? []), contentEncryptionElement(kid)];
};

const buildTrackEncryptor = (meta: TrackMeta, opts: EncryptWebmOptions, frameOffset: number): TrackEncryptor => {
	const iv = advanceIv(opts.iv.slice(0, WEBM_IV_SIZE), frameOffset);
	const videoCodec = meta.trackType === TRACK_TYPE_VIDEO ? codecOf(meta.codecId) : null;
	return videoCodec !== null
		? subsampleEncryptor(meta.trackNumber, videoCodec, opts, iv)
		: wholeFrameEncryptor(meta.trackNumber, opts, iv);
};

// VP9/AV1: reuse SampleEncryptor (cenc = AES-CTR + the ported subsample generators), then WebM-frame.
const subsampleEncryptor = (
	trackNumber: number, codec: EncryptionCodec, opts: EncryptWebmOptions, iv: Uint8Array,
): TrackEncryptor => {
	const sampleEncryptor = new SampleEncryptor({
		streamInfo: { codec, codecConfig: new Uint8Array(0), naluLengthSize: 0 },
		streamType: 'video',
		scheme: 'cenc',
		key: opts.key,
		iv,
	});
	return {
		trackNumber,
		encryptFrame: (frame) => {
			const { data, subsamples, iv: frameIv } = sampleEncryptor.encryptSample(frame);
			return joinFrame(webmFrameHeader(frameIv, subsamples), data);
		},
	};
};

// Audio / other tracks: whole-frame AES-CTR with an 8-byte IV incremented per frame.
const wholeFrameEncryptor = (trackNumber: number, opts: EncryptWebmOptions, iv: Uint8Array): TrackEncryptor => {
	const ctr = new AesCtrEncryptor();
	ctr.initializeWithIv(opts.key, iv);
	return {
		trackNumber,
		encryptFrame: (frame) => {
			const iv = new Uint8Array(ctr.getIv());
			const encrypted = new Uint8Array(frame);
			ctr.crypt(encrypted);
			ctr.updateIv();
			return joinFrame(webmFrameHeader(iv, []), encrypted);
		},
	};
};

// | signal_byte | iv | [num_partitions | partition_offset × n] |  (shaka WriteEncryptedFrameHeader)
const webmFrameHeader = (iv: Uint8Array, subsamples: SubsampleEntry[]): Uint8Array => {
	if (subsamples.length === 0) {
		return Uint8Array.from([WEBM_ENCRYPTED_SIGNAL, ...iv]);
	}
	const last = subsamples[subsamples.length - 1]!;
	const numPartitions = 2 * subsamples.length - 1 - (last.cipherBytes === 0 ? 1 : 0);
	const offsets: number[] = [];
	let partitionOffset = 0;
	for (let i = 0; i < subsamples.length - 1; i++) {
		partitionOffset += subsamples[i]!.clearBytes;
		offsets.push(partitionOffset);
		partitionOffset += subsamples[i]!.cipherBytes;
		offsets.push(partitionOffset);
	}
	if (last.cipherBytes !== 0) {
		partitionOffset += last.clearBytes;
		offsets.push(partitionOffset);
	}

	const header = new Uint8Array(1 + WEBM_IV_SIZE + 1 + 4 * numPartitions);
	const view = new DataView(header.buffer);
	header[0] = WEBM_ENCRYPTED_SIGNAL | WEBM_PARTITIONED_SIGNAL;
	header.set(iv, 1);
	header[1 + WEBM_IV_SIZE] = numPartitions;
	for (let i = 0; i < offsets.length; i++) {
		view.setUint32(1 + WEBM_IV_SIZE + 1 + 4 * i, offsets[i]!);
	}
	return header;
};

const joinFrame = (header: Uint8Array, data: Uint8Array): Uint8Array => {
	const out = new Uint8Array(header.length + data.length);
	out.set(header, 0);
	out.set(data, header.length);
	return out;
};

const contentEncryptionElement = (kid: Uint8Array): EbmlNode => ({
	id: ID_CONTENT_ENCODINGS,
	children: [{
		id: ID_CONTENT_ENCODING,
		children: [
			{ id: ID_CONTENT_ENCODING_ORDER, data: Uint8Array.from([0]) },
			{ id: ID_CONTENT_ENCODING_SCOPE, data: Uint8Array.from([1]) }, // all frames
			{ id: ID_CONTENT_ENCODING_TYPE, data: Uint8Array.from([1]) }, // encryption
			{
				id: ID_CONTENT_ENCRYPTION,
				children: [
					{ id: ID_CONTENT_ENC_ALGO, data: Uint8Array.from([5]) }, // AES
					{ id: ID_CONTENT_ENC_KEY_ID, data: kid },
					{
						id: ID_CONTENT_ENC_AES_SETTINGS,
						children: [{ id: ID_AES_SETTINGS_CIPHER_MODE, data: Uint8Array.from([1]) }], // CTR
					},
				],
			},
		],
	}],
});

const encryptCluster = (cluster: EbmlNode, encryptors: Map<number, TrackEncryptor>): void => {
	for (const child of cluster.children ?? []) {
		if (child.id === ID_SIMPLE_BLOCK && child.data) {
			child.data = encryptBlock(child.data, encryptors);
		} else if (child.id === ID_BLOCK_GROUP) {
			for (const inner of child.children ?? []) {
				if (inner.id === ID_BLOCK && inner.data) {
					inner.data = encryptBlock(inner.data, encryptors);
				}
			}
		}
	}
};

const LACE_NONE = 0;
const LACE_XIPH = 1;
const LACE_FIXED = 2;
const LACE_EBML = 3;

// A (Simple)Block payload: | track number (vint) | timecode (int16) | flags | frame(s) |. Only the
// frame data is transformed (each frame encrypted + WebM-framed); the track/timecode header is kept.
// Laced blocks (multiple frames) are de-laced, each frame encrypted, then re-laced as EBML lacing
// (the per-frame encryption headers make frame sizes uneven, so fixed/Xiph lacing can't be preserved).
const encryptBlock = (block: Uint8Array, encryptors: Map<number, TrackEncryptor>): Uint8Array => {
	const { value: trackNumber, length: trackLen } = readVint(block, 0);
	const encryptor = encryptors.get(trackNumber);
	if (encryptor === undefined) {
		return block;
	}
	const flagsOffset = trackLen + 2;
	const flags = block[flagsOffset]!;
	const laceType = (flags >> 1) & 0x3;
	const payload = block.subarray(flagsOffset + 1);

	if (laceType === LACE_NONE) {
		return joinBlockHeader(block, flagsOffset, flags, encryptor.encryptFrame(payload));
	}
	const encryptedFrames = deLace(payload, laceType).map(frame => encryptor.encryptFrame(frame));
	const newFlags = (flags & ~0x06) | (LACE_EBML << 1);
	return joinBlockHeader(block, flagsOffset, newFlags, reLaceEbml(encryptedFrames));
};

// Rebuild a block: keep the header before the flags byte, write `flags`, then the new body.
const joinBlockHeader = (
	block: Uint8Array, flagsOffset: number, flags: number, body: Uint8Array,
): Uint8Array => {
	const out = new Uint8Array(flagsOffset + 1 + body.length);
	out.set(block.subarray(0, flagsOffset), 0);
	out[flagsOffset] = flags;
	out.set(body, flagsOffset + 1);
	return out;
};

// Split a laced block payload (after the flags byte) into its individual frames.
const deLace = (payload: Uint8Array, laceType: number): Uint8Array[] => {
	const numFrames = payload[0]! + 1;
	if (laceType === LACE_FIXED) {
		const each = (payload.length - 1) / numFrames;
		return Array.from({ length: numFrames }, (_, i) => payload.subarray(1 + i * each, 1 + (i + 1) * each));
	}
	// Xiph/EBML: read the first numFrames-1 sizes; the last frame's size is the remainder.
	const sizes: number[] = [];
	let pos = 1;
	if (laceType === LACE_XIPH) {
		for (let i = 0; i < numFrames - 1; i++) {
			let size = 0;
			while (payload[pos] === 0xff) {
				size += 255;
				pos++;
			}
			size += payload[pos]!;
			pos++;
			sizes.push(size);
		}
	} else { // LACE_EBML
		const first = readVint(payload, pos);
		sizes.push(first.value);
		pos += first.length;
		for (let i = 1; i < numFrames - 1; i++) {
			const delta = readSignedVint(payload, pos);
			sizes.push(sizes[i - 1]! + delta.value);
			pos += delta.length;
		}
	}
	const frames: Uint8Array[] = [];
	for (const size of sizes) {
		frames.push(payload.subarray(pos, pos + size));
		pos += size;
	}
	frames.push(payload.subarray(pos));
	return frames;
};

// Re-lace frames as EBML lacing: | num_frames-1 | size0 (vint) | Δsize (signed vint) … | frames |.
const reLaceEbml = (frames: Uint8Array[]): Uint8Array => {
	const parts: Uint8Array[] = [Uint8Array.from([frames.length - 1]), writeVint(frames[0]!.length)];
	for (let i = 1; i < frames.length - 1; i++) {
		parts.push(writeSignedVint(frames[i]!.length - frames[i - 1]!.length));
	}
	parts.push(...frames);
	return concat(parts);
};

const concat = (parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

// --- EBML primitives ---

const readUint = (data: Uint8Array): number => {
	let value = 0;
	for (const byte of data) {
		value = value * 256 + byte;
	}
	return value;
};

// A vint (element size, or a block's track number): the first set bit marks the length; the remaining
// bits (with the marker cleared) are the value.
const readVint = (bytes: Uint8Array, pos: number): { value: number; length: number } => {
	const first = bytes[pos]!;
	let length = 1;
	let mask = 0x80;
	while (mask !== 0 && (first & mask) === 0) {
		length++;
		mask >>= 1;
	}
	let value = first & (mask - 1);
	for (let i = 1; i < length; i++) {
		value = value * 256 + bytes[pos + i]!;
	}
	return { value, length };
};

const idByteLength = (id: number): number => {
	let length = 1;
	while (id >= 2 ** (8 * length)) {
		length++;
	}
	return length;
};

const parseEbml = (bytes: Uint8Array, start: number, end: number): EbmlNode[] => {
	const nodes: EbmlNode[] = [];
	let pos = start;
	while (pos < end) {
		const idInfo = readVint(bytes, pos);
		// The element ID keeps its marker bits; re-read it as a raw big-endian number of `idInfo.length` bytes.
		let id = 0;
		for (let i = 0; i < idInfo.length; i++) {
			id = id * 256 + bytes[pos + i]!;
		}
		const sizeInfo = readVint(bytes, pos + idInfo.length);
		const dataStart = pos + idInfo.length + sizeInfo.length;
		// An all-ones size vint means "unknown length" — the element runs to the end of its parent
		// (used for the streamed `Segment` of a DASH init segment).
		const unknownSize = sizeInfo.value === 2 ** (7 * sizeInfo.length) - 1;
		const dataEnd = unknownSize ? end : dataStart + sizeInfo.value;
		if (RECURSED_MASTERS.has(id)) {
			nodes.push({ id, children: parseEbml(bytes, dataStart, dataEnd) });
		} else {
			nodes.push({ id, data: bytes.subarray(dataStart, dataEnd) });
		}
		pos = dataEnd;
	}
	return nodes;
};

const writeVint = (value: number): Uint8Array => {
	let length = 1;
	while (value >= 2 ** (7 * length) - 1) {
		length++;
	}
	const out = new Uint8Array(length);
	let remaining = value;
	for (let i = length - 1; i >= 0; i--) {
		out[i] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	out[0]! |= 0x80 >> (length - 1); // length marker
	return out;
};

// EBML lacing sizes after the first are signed deltas: a vint biased by 2^(7·len-1)-1 so it centres on 0.
const signedVintBias = (length: number): number => 2 ** (7 * length - 1) - 1;

const readSignedVint = (bytes: Uint8Array, pos: number): { value: number; length: number } => {
	const { value, length } = readVint(bytes, pos);
	return { value: value - signedVintBias(length), length };
};

const writeSignedVint = (delta: number): Uint8Array => {
	let length = 1;
	while (delta < -signedVintBias(length) || delta > signedVintBias(length)) {
		length++;
	}
	const stored = delta + signedVintBias(length);
	const out = new Uint8Array(length);
	let remaining = stored;
	for (let i = length - 1; i >= 0; i--) {
		out[i] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	out[0]! |= 0x80 >> (length - 1);
	return out;
};

const writeId = (id: number): Uint8Array => {
	const length = idByteLength(id);
	const out = new Uint8Array(length);
	let remaining = id;
	for (let i = length - 1; i >= 0; i--) {
		out[i] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	return out;
};

const serializeNode = (node: EbmlNode): Uint8Array => {
	const data = node.children !== undefined ? serializeEbml(node.children) : node.data!;
	const idBytes = writeId(node.id);
	const sizeBytes = writeVint(data.length);
	const out = new Uint8Array(idBytes.length + sizeBytes.length + data.length);
	out.set(idBytes, 0);
	out.set(sizeBytes, idBytes.length);
	out.set(data, idBytes.length + sizeBytes.length);
	return out;
};

const serializeEbml = (nodes: EbmlNode[]): Uint8Array => {
	const parts = nodes.map(serializeNode);
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
