/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Box as ForkBox } from '../isobmff/isobmff-boxes';
import { type MutableBox, findBox, measureBox, parseBoxes, serializeBoxes } from './box-tree';
import { saio, saiz, senc, sencEntrySize } from './encryption-boxes';
import { buildProtectionSinf } from './fragment-encryptor';
import { SampleEncryptor } from './sample-encryptor';
import type {
	EncryptionCodec,
	EncryptionStreamInfo,
	ProtectionScheme,
	SubsampleEntry,
} from './subsample-generator';

/** Serialize a fork `Box` (from `isobmff-boxes`) to bytes, then re-parse it as a MutableBox. */
const forkBoxToBytes = (box: ForkBox): Uint8Array => {
	const childBytes = (box.children ?? []).filter((c): c is ForkBox => c != null).map(forkBoxToBytes);
	const contentLen = (box.contents?.byteLength ?? 0) + childBytes.reduce((s, c) => s + c.byteLength, 0);
	const size = 8 + contentLen;
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, size);
	out.set([...box.type].map(c => c.charCodeAt(0)), 4);
	let offset = 8;
	if (box.contents) {
		out.set(box.contents, offset);
		offset += box.contents.byteLength;
	}
	for (const child of childBytes) {
		out.set(child, offset);
		offset += child.byteLength;
	}
	return out;
};

const measureForkBox = (box: ForkBox): number =>
	8 + (box.contents?.byteLength ?? 0)
	+ (box.children ?? []).filter((c): c is ForkBox => c != null).reduce((s, c) => s + measureForkBox(c), 0);
const toMutable = (box: ForkBox): MutableBox => parseBoxes(forkBoxToBytes(box), 0, measureForkBox(box))[0]!;

const u32 = (data: Uint8Array, offset: number): number =>
	new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
const setU32 = (data: Uint8Array, offset: number, value: number): void =>
	new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value);
const boxFlags = (data: Uint8Array): number => (data[1]! << 16) | (data[2]! << 8) | data[3]!;

type Trun = { flags: number; sampleCount: number; dataOffsetPos: number; sizes: number[] };

const parseTrun = (data: Uint8Array, defaultSampleSize: number): Trun => {
	const flags = boxFlags(data);
	const sampleCount = u32(data, 4);
	let offset = 8;
	let dataOffsetPos = -1;
	if (flags & 0x1) {
		dataOffsetPos = offset;
		offset += 4;
	}
	if (flags & 0x4) {
		offset += 4;
	}
	const sizes: number[] = [];
	for (let i = 0; i < sampleCount; i++) {
		if (flags & 0x100) {
			offset += 4;
		}
		let size = defaultSampleSize;
		if (flags & 0x200) {
			size = u32(data, offset);
			offset += 4;
		}
		sizes.push(size);
		if (flags & 0x400) {
			offset += 4;
		}
		if (flags & 0x800) {
			offset += 4;
		}
	}
	return { flags, sampleCount, dataOffsetPos, sizes };
};

type TrackInfo = {
	trackId: number;
	sampleEntry: MutableBox;
	kind: 'video' | 'audio';
	streamInfo: EncryptionStreamInfo;
};

const audioCodec = (sampleEntryType: string): EncryptionCodec => {
	if (sampleEntryType === 'ac-3') {
		return 'ac3';
	}
	if (sampleEntryType === 'ec-3') {
		return 'eac3';
	}
	return 'aac';
};

const findEncryptableTracks = (moov: MutableBox): TrackInfo[] => {
	const tracks: TrackInfo[] = [];
	for (const trak of (moov.children ?? []).filter(b => b.type === 'trak')) {
		const hdlr = findBox([trak], 'hdlr');
		if (hdlr?.data === undefined) {
			continue;
		}
		const handlerType = String.fromCharCode(...hdlr.data.subarray(8, 12));
		const tkhd = findBox([trak], 'tkhd')!;
		const trackId = u32(tkhd.data!, tkhd.data![0]! === 1 ? 20 : 12);
		const sampleEntry = findBox([trak], 'stsd')!.children![0]!;

		if (handlerType === 'vide') {
			const isHevc = sampleEntry.type === 'hvc1' || sampleEntry.type === 'hev1';
			const codecConfig = findBox([sampleEntry], isHevc ? 'hvcC' : 'avcC')!.data!;
			const naluLengthSize = (((isHevc ? codecConfig[21]! : codecConfig[4]!) & 0x03) + 1) as 1 | 2 | 4;
			tracks.push({
				trackId,
				sampleEntry,
				kind: 'video',
				streamInfo: { codec: isHevc ? 'hevc' : 'avc', codecConfig, naluLengthSize },
			});
		} else if (handlerType === 'soun') {
			tracks.push({
				trackId,
				sampleEntry,
				kind: 'audio',
				streamInfo: { codec: audioCodec(sampleEntry.type), codecConfig: new Uint8Array(0), naluLengthSize: 0 },
			});
		}
	}
	return tracks;
};

/**
 * Options shared by the whole-file, init and per-segment CMAF encryptors.
 *
 * @group Encryption
 * @public
 */
export type EncryptCmafOptions = {
	/** The 16-byte AES-128 content encryption key. */
	key: Uint8Array;
	/** The 16-byte key ID identifying the key to the DRM system / CDM. */
	kid: Uint8Array;
	/** Constant IV for cbcs; the first per-sample IV for cenc/cens (8 bytes recommended for CTR). */
	iv: Uint8Array;
	/** CENC scheme. Defaults to `cbcs` (single copy for Widevine + PlayReady + FairPlay). */
	scheme?: ProtectionScheme;
	/** cbcs/cens pattern: encrypted 16-byte blocks per pattern cycle (video). Defaults to 1. */
	cryptByteBlock?: number;
	/** cbcs/cens pattern: clear 16-byte blocks per pattern cycle (video). Defaults to 9. */
	skipByteBlock?: number;
};

const usesPerSampleIv = (scheme: ProtectionScheme): boolean => scheme === 'cenc' || scheme === 'cens';

// Video carries the pattern (cbcs/cens); audio uses whole-block full-sample encryption (no pattern).
const patternFor = (kind: 'video' | 'audio', cryptByteBlock: number, skipByteBlock: number) =>
	kind === 'video' ? { cryptByteBlock, skipByteBlock } : { cryptByteBlock: 0, skipByteBlock: 0 };

// Rewrite each init sample entry to encv/enca + sinf/tenc, in place.
const transformInit = (tracks: TrackInfo[], scheme: ProtectionScheme, opts: EncryptCmafOptions): void => {
	for (const track of tracks) {
		const pattern = patternFor(track.kind, opts.cryptByteBlock ?? 1, opts.skipByteBlock ?? 9);
		const originalFormat = track.sampleEntry.type;
		track.sampleEntry.type = track.kind === 'video' ? 'encv' : 'enca';
		track.sampleEntry.children = [
			...(track.sampleEntry.children ?? []),
			toMutable(buildProtectionSinf({ originalFormat, scheme, kid: opts.kid, ...pattern, iv: opts.iv })),
		];
	}
};

const makeEncryptors = (
	tracks: TrackInfo[], scheme: ProtectionScheme, opts: EncryptCmafOptions, iv: Uint8Array,
): Map<number, SampleEncryptor> => {
	const encryptors = new Map<number, SampleEncryptor>();
	for (const track of tracks) {
		encryptors.set(track.trackId, new SampleEncryptor({
			streamInfo: track.streamInfo,
			streamType: track.kind,
			scheme,
			key: opts.key,
			iv,
			cryptByteBlock: opts.cryptByteBlock ?? 1,
			skipByteBlock: opts.skipByteBlock ?? 9,
		}));
	}
	return encryptors;
};

const encryptFragments = (
	boxes: MutableBox[], tracks: TrackInfo[], encryptors: Map<number, SampleEncryptor>,
	scheme: ProtectionScheme, ivLength: number,
): void => {
	const perSampleIvSize = usesPerSampleIv(scheme) ? ivLength : 0;
	for (let i = 0; i < boxes.length - 1; i++) {
		if (boxes[i]!.type === 'moof' && boxes[i + 1]!.type === 'mdat') {
			encryptFragmentInPlace(boxes[i]!, boxes[i + 1]!, tracks, encryptors, perSampleIvSize);
		}
	}
};

// Advance a per-sample IV by `sampleOffset` (big-endian add) so per-segment encryption continues the
// CTR IV sequence across segments. Matches shaka's 8-byte-IV +1-per-sample rule; constant-IV cbcs is
// unaffected. (A 16-byte IV increments by block count, not sample count, so cross-segment continuity
// there needs stateful threading — out of scope; 8-byte cenc/cens and cbcs cover the real cases.)
const advanceIv = (iv: Uint8Array, sampleOffset: number): Uint8Array => {
	const out = new Uint8Array(iv);
	let carry = sampleOffset;
	for (let i = out.length - 1; carry > 0 && i >= 0; i--) {
		carry += out[i]!;
		out[i] = carry & 0xff;
		carry = Math.floor(carry / 256);
	}
	return out;
};

const requireMoov = (boxes: MutableBox[]): MutableBox => {
	const moov = findBox(boxes, 'moov');
	if (moov === null) {
		throw new Error('No moov box found.');
	}
	return moov;
};

const requireTracks = (moov: MutableBox): TrackInfo[] => {
	const tracks = findEncryptableTracks(moov);
	if (tracks.length === 0) {
		throw new Error('No encryptable track found.');
	}
	return tracks;
};

/**
 * Statically encrypt every video and audio track of a self-contained fragmented CMAF file (one
 * buffer holding `moov` + `moof`/`mdat` fragments) using a CENC scheme (default `cbcs`). Produces a
 * playable encrypted file: each init sample entry becomes `encv`/`enca` + `sinf`/`tenc`, and each
 * fragment gains a `senc` (plus `saiz`/`saio` when it carries auxiliary data) with its samples
 * encrypted in the `mdat` and `trun` offsets corrected. Video keeps NAL/slice headers clear
 * (cbcs/cens 1:9 pattern, or cenc block-aligned subsamples); audio is full-sample encrypted.
 * cbcs uses a constant IV; cenc/cens use an advancing per-sample IV. For split `init.mp4`/`*.m4s`
 * delivery use {@link encryptCmafInit} + {@link encryptCmafSegment} instead.
 *
 * @group Encryption
 * @public
 */
export const encryptCmaf = (bytes: Uint8Array, opts: EncryptCmafOptions): Uint8Array => {
	const scheme = opts.scheme ?? 'cbcs';
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const tracks = requireTracks(requireMoov(boxes));
	transformInit(tracks, scheme, opts);
	const encryptors = makeEncryptors(tracks, scheme, opts, opts.iv);
	encryptFragments(boxes, tracks, encryptors, scheme, opts.iv.length);
	return serializeBoxes(boxes);
};

/**
 * Transform a CMAF init segment (`ftyp` + `moov`) for encryption: each sample entry becomes
 * `encv`/`enca` + `sinf`/`tenc`. Pair with {@link encryptCmafSegment} for each media segment.
 *
 * @group Encryption
 * @public
 */
export const encryptCmafInit = (init: Uint8Array, opts: EncryptCmafOptions): Uint8Array => {
	const boxes = parseBoxes(init, 0, init.length);
	transformInit(requireTracks(requireMoov(boxes)), opts.scheme ?? 'cbcs', opts);
	return serializeBoxes(boxes);
};

/**
 * Encrypt one CMAF media segment (`moof`/`mdat`, optionally `styp`/`sidx`) against its (clear or
 * already-transformed) init segment, which supplies the track/codec info. For per-sample-IV schemes
 * (cenc/cens) pass `sampleIndexOffset` — the number of samples in earlier segments — so the IV
 * sequence continues; cbcs ignores it (constant IV).
 *
 * @group Encryption
 * @public
 */
export const encryptCmafSegment = (
	init: Uint8Array, segment: Uint8Array, opts: EncryptCmafOptions & { sampleIndexOffset?: number },
): Uint8Array => {
	const scheme = opts.scheme ?? 'cbcs';
	const tracks = requireTracks(requireMoov(parseBoxes(init, 0, init.length)));
	const iv = usesPerSampleIv(scheme) ? advanceIv(opts.iv, opts.sampleIndexOffset ?? 0) : opts.iv;
	const encryptors = makeEncryptors(tracks, scheme, opts, iv);
	const segmentBoxes = parseBoxes(segment, 0, segment.length);
	encryptFragments(segmentBoxes, tracks, encryptors, scheme, opts.iv.length);
	return serializeBoxes(segmentBoxes);
};

const findTrafByTrackId = (moof: MutableBox, trackId: number): MutableBox | undefined =>
	(moof.children ?? []).filter(b => b.type === 'traf').find((traf) => {
		const tfhd = findBox([traf], 'tfhd');
		return tfhd?.data !== undefined && u32(tfhd.data, 4) === trackId;
	});

const defaultSampleSizeOf = (tfhd: MutableBox): number => {
	const flags = boxFlags(tfhd.data!);
	// tfhd optional fields (by flag): base_data_offset(8,0x1), sample_description_index(4,0x2),
	// default_sample_duration(4,0x8), then default_sample_size(4,0x10).
	let offset = 8;
	if (flags & 0x1) {
		offset += 8;
	}
	if (flags & 0x2) {
		offset += 4;
	}
	if (flags & 0x8) {
		offset += 4;
	}
	return flags & 0x10 ? u32(tfhd.data!, offset) : 0;
};

const encryptFragmentInPlace = (
	moof: MutableBox,
	mdat: MutableBox,
	tracks: TrackInfo[],
	encryptors: Map<number, SampleEncryptor>,
	perSampleIvSize: number,
): void => {
	const moofSizeBefore = measureBox(moof);
	const auxTrafs: MutableBox[] = [];

	for (const track of tracks) {
		const traf = findTrafByTrackId(moof, track.trackId);
		if (traf === undefined) {
			continue;
		}
		const trun = findBox([traf], 'trun')!;
		const parsed = parseTrun(trun.data!, defaultSampleSizeOf(findBox([traf], 'tfhd')!));

		// The samples are a contiguous run in mdat starting at (data_offset - moof_size - 8).
		const dataOffset = parsed.dataOffsetPos >= 0 ? u32(trun.data!, parsed.dataOffsetPos) : moofSizeBefore + 8;
		let cursor = dataOffset - moofSizeBefore - 8;

		const encryptor = encryptors.get(track.trackId)!;
		const subsamplesPerSample: SubsampleEntry[][] = [];
		const perSampleIvs: Uint8Array[] = [];
		for (const size of parsed.sizes) {
			const encrypted = encryptor.encryptSample(mdat.data!.subarray(cursor, cursor + size));
			mdat.data!.set(encrypted.data, cursor);
			subsamplesPerSample.push(encrypted.subsamples);
			perSampleIvs.push(encrypted.iv);
			cursor += size;
		}

		// senc carries aux data when there are subsamples (video) or per-sample IVs (cenc/cens).
		// Only a constant-IV full-sample track (cbcs audio) has empty entries → saiz/saio omitted.
		const perSample = perSampleIvSize > 0;
		const sencBox = toMutable(senc(subsamplesPerSample, perSample ? perSampleIvs : undefined));
		const hasAuxData = perSample || subsamplesPerSample.some(s => s.length > 0);
		if (hasAuxData) {
			const saizBox = toMutable(saiz(subsamplesPerSample.map(s => sencEntrySize(s, perSampleIvSize))));
			traf.children = [...(traf.children ?? []), saizBox, toMutable(saio(0)), sencBox];
			auxTrafs.push(traf);
		} else {
			traf.children = [...(traf.children ?? []), sencBox];
		}
	}

	// saio points at the senc auxiliary data, moof-relative. Mirrors shaka Segmenter:
	// end-of-traf position − senc box size + senc header (8) + sample_count (4).
	for (const traf of auxTrafs) {
		const senc = findBox([traf], 'senc')!;
		let trafEnd = 8;
		for (const child of moof.children ?? []) {
			trafEnd += measureBox(child);
			if (child === traf) {
				break;
			}
		}
		setU32(findBox([traf], 'saio')!.data!, 8, trafEnd - measureBox(senc) + 8 + 4);
	}

	// The moof grew, so mdat (and every trun's sample data) shifts later by the total delta.
	const delta = measureBox(moof) - moofSizeBefore;
	for (const traf of (moof.children ?? []).filter(b => b.type === 'traf')) {
		const trun = findBox([traf], 'trun');
		if (trun?.data === undefined) {
			continue;
		}
		const p = parseTrun(trun.data, 0);
		if (p.dataOffsetPos >= 0) {
			setU32(trun.data, p.dataOffsetPos, u32(trun.data, p.dataOffsetPos) + delta);
		}
	}
};
