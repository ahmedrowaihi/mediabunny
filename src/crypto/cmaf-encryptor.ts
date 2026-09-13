/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Box as ForkBox } from '../isobmff/isobmff-boxes';
import { type MutableBox, findBox, measureBox, parseBoxes, serializeBoxes } from './box-tree';
import {
	type SampleGroupRun,
	saio,
	saiz,
	sbgpSeig,
	seigEntry,
	senc as sencBox,
	sencEntrySizes,
	sgpdSeig,
} from './encryption-boxes';
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

/** Bytes from the start of a `senc` box to its first entry: box header, version/flags, sample_count. */
const SENC_ENTRIES_OFFSET = 8 + 4 + 4;

const TRUN_DATA_OFFSET_PRESENT = 0x1;
/** Byte offset of `data_offset` within a `trun` payload: version/flags(4) + sample_count(4). */
const TRUN_DATA_OFFSET = 4 + 4;

type Trun = {
	flags: number;
	sampleCount: number;
	dataOffsetPos: number;
	sizes: number[];
	durations: number[];
};

const parseTrun = (data: Uint8Array, defaultSampleSize: number, defaultSampleDuration: number): Trun => {
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
	const durations: number[] = [];
	for (let i = 0; i < sampleCount; i++) {
		let duration = defaultSampleDuration;
		if (flags & 0x100) {
			duration = u32(data, offset);
			offset += 4;
		}
		durations.push(duration);
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
	return { flags, sampleCount, dataOffsetPos, sizes, durations };
};

type TrackInfo = {
	trackId: number;
	trak: MutableBox;
	sampleEntry: MutableBox;
	kind: 'video' | 'audio';
	streamInfo: EncryptionStreamInfo;
	/** `trex.default_sample_duration`, the last fallback for a sample's decode duration. */
	defaultSampleDuration: number;
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

// AV1 (`av01`) and VP9 (`vp09`) carry no NAL units and need no codec config for subsample generation
// (the tile/uncompressed-header parsers read the frame directly); H26x needs avcC/hvcC for the NAL
// length size and slice-header parsing.
const videoStreamInfo = (sampleEntry: MutableBox): EncryptionStreamInfo => {
	if (sampleEntry.type === 'av01') {
		return { codec: 'av1', codecConfig: new Uint8Array(0), naluLengthSize: 0 };
	}
	if (sampleEntry.type === 'vp09') {
		return { codec: 'vp9', codecConfig: new Uint8Array(0), naluLengthSize: 0 };
	}
	const isHevc = sampleEntry.type === 'hvc1' || sampleEntry.type === 'hev1';
	const codecConfig = findBox([sampleEntry], isHevc ? 'hvcC' : 'avcC')!.data!;
	const naluLengthSize = (((isHevc ? codecConfig[21]! : codecConfig[4]!) & 0x03) + 1) as 1 | 2 | 4;
	return { codec: isHevc ? 'hevc' : 'avc', codecConfig, naluLengthSize };
};

// trex payload: version/flags(4), track_ID(4), sample_description_index(4), default_sample_duration(4).
const trexSampleDuration = (moov: MutableBox, trackId: number): number => {
	const mvex = (moov.children ?? []).find(box => box.type === 'mvex');
	for (const trex of (mvex?.children ?? []).filter(box => box.type === 'trex')) {
		if (trex.data !== undefined && u32(trex.data, 4) === trackId) {
			return u32(trex.data, 12);
		}
	}
	return 0;
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

		const defaultSampleDuration = trexSampleDuration(moov, trackId);
		if (handlerType === 'vide') {
			tracks.push({
				trackId,
				trak,
				sampleEntry,
				kind: 'video',
				streamInfo: videoStreamInfo(sampleEntry),
				defaultSampleDuration,
			});
		} else if (handlerType === 'soun') {
			tracks.push({
				trackId,
				trak,
				sampleEntry,
				kind: 'audio',
				streamInfo: { codec: audioCodec(sampleEntry.type), codecConfig: new Uint8Array(0), naluLengthSize: 0 },
				defaultSampleDuration,
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
	/** The 16-byte AES-128 content encryption key. Unused when {@link EncryptCmafOptions.trackKeys} is given. */
	key: Uint8Array;
	/**
	 * The 16-byte key ID identifying the key to the DRM system / CDM. Unused when
	 * {@link EncryptCmafOptions.trackKeys} is given.
	 */
	kid: Uint8Array;
	/** Constant IV for cbcs; the first per-sample IV for cenc/cens (8 bytes recommended for CTR). */
	iv: Uint8Array;
	/**
	 * Per-track key material, keyed by track ID, for encrypting each track under its own key instead
	 * of the whole file under `key`/`kid`. When given it must name every encryptable track of the
	 * file and no others: a track it omits is an error, not a fall back to `key`/`kid`. `iv` remains
	 * the IV of any entry that states none.
	 */
	trackKeys?: Map<number, CmafTrackKey>;
	/**
	 * Key rotation, keyed by track ID: the key periods a track's samples are encrypted under, in
	 * order. A track this omits does not rotate, and a track it names may not also appear in
	 * {@link EncryptCmafOptions.trackKeys}, which states one key for a whole track.
	 *
	 * The first period is the track's default — the key `tenc` announces — and a track fragment whose
	 * samples leave it carries a `seig` sample group (`sgpd` + `sbgp`) naming the periods it draws on.
	 * The IV sequence runs on across a period boundary rather than restarting, so `ivState` still
	 * holds one IV per track and no keystream is ever reused. Rotation needs a fragmented file: a
	 * progressive one has no `traf` to state a fragment's sample groups in.
	 */
	keyPeriods?: Map<number, CmafKeyPeriod[]>;
	/**
	 * Complete `pssh` boxes to write into the init's `moov`, as built by {@link buildWidevinePssh},
	 * {@link buildPlayReadyPssh} or {@link buildCommonPssh}. Omitted, no `pssh` is written and the
	 * output is unchanged — players that read their init data from the manifest need none.
	 */
	pssh?: Uint8Array[];
	/** CENC scheme. Defaults to `cbcs` (single copy for Widevine + PlayReady + FairPlay). */
	scheme?: ProtectionScheme;
	/** cbcs/cens pattern: encrypted 16-byte blocks per pattern cycle (video). Defaults to 1. */
	cryptByteBlock?: number;
	/** cbcs/cens pattern: clear 16-byte blocks per pattern cycle (video). Defaults to 9. */
	skipByteBlock?: number;
};

/**
 * The key material of one track, named by its track ID in {@link EncryptCmafOptions.trackKeys}.
 *
 * @group Encryption
 * @public
 */
export type CmafTrackKey = {
	/** The 16-byte AES-128 content encryption key for this track. */
	key: Uint8Array;
	/** The 16-byte key ID identifying this track's key to the DRM system / CDM. */
	kid: Uint8Array;
	/**
	 * This track's constant IV (cbcs) or first per-sample IV (cenc/cens). Omit to use
	 * {@link EncryptCmafOptions.iv}; when stated it must have the same length as that IV, since one
	 * IV size is declared for the whole file.
	 */
	iv?: Uint8Array;
};

/**
 * One key period of a track: the key material in force over a span of that track's decode timeline.
 * Modelled on the `ContentKeyPeriod` a SPEKE v2 / CPIX exchange states rotation with, which names a
 * period by its position in the sequence and how long it lasts.
 *
 * @group Encryption
 * @public
 */
export type CmafKeyPeriod = {
	/** The 16-byte AES-128 content encryption key in force over this period. */
	key: Uint8Array;
	/** The 16-byte key ID identifying this period's key to the DRM system / CDM. */
	kid: Uint8Array;
	/** The decode time, in the track's media timescale, at which this period begins. */
	start: number;
	/** How long this period lasts, in the track's media timescale. */
	duration: number;
};

type TrackKeyMaterial = { key: Uint8Array; kid: Uint8Array; iv: Uint8Array; periods?: CmafKeyPeriod[] };

const validateKeyPeriods = (trackId: number, periods: CmafKeyPeriod[]): void => {
	if (periods.length === 0) {
		throw new Error(
			`keyPeriods states an empty list for track ${trackId}; give it at least one period, or omit the`
			+ ' track to encrypt it under one key.',
		);
	}
	for (let i = 0; i < periods.length; i++) {
		const period = periods[i]!;
		if (period.duration <= 0) {
			throw new Error(
				`Key period ${i} of track ${trackId} lasts ${period.duration}; give every period a positive`
				+ ' duration, since a period covering no sample announces a key nothing is encrypted under.',
			);
		}
		const previous = periods[i - 1];
		if (previous !== undefined && period.start !== previous.start + previous.duration) {
			throw new Error(
				`Key period ${i} of track ${trackId} starts at ${period.start} while period ${i - 1} ends at`
				+ ` ${previous.start + previous.duration}; make the periods meet exactly, so no sample falls`
				+ ' under two keys or none.',
			);
		}
	}
};

const keyMaterial = (tracks: TrackInfo[], options: EncryptCmafOptions): Map<number, TrackKeyMaterial> => {
	const trackIds = tracks.map(track => track.trackId);
	const unknownPeriods = [...(options.keyPeriods?.keys() ?? [])].filter(id => !trackIds.includes(id));
	if (unknownPeriods.length > 0) {
		throw new Error(
			`keyPeriods names track ${unknownPeriods.join(', ')}, which this file has no encryptable track`
			+ ` for; its encryptable tracks are ${trackIds.join(', ')}.`,
		);
	}

	const material = new Map<number, TrackKeyMaterial>();
	if (options.trackKeys === undefined && options.keyPeriods === undefined) {
		for (const track of tracks) {
			material.set(track.trackId, { key: options.key, kid: options.kid, iv: options.iv });
		}
		return material;
	}

	const unknown = [...(options.trackKeys?.keys() ?? [])].filter(id => !trackIds.includes(id));
	if (unknown.length > 0) {
		throw new Error(
			`trackKeys names track ${unknown.join(', ')}, which this file has no encryptable track for;`
			+ ` its encryptable tracks are ${trackIds.join(', ')}.`,
		);
	}

	for (const track of tracks) {
		const stated = options.trackKeys?.get(track.trackId);
		const periods = options.keyPeriods?.get(track.trackId);
		if (stated !== undefined && periods !== undefined) {
			throw new Error(
				`Track ${track.trackId} is named by both trackKeys and keyPeriods; state its key material`
				+ ' once — as key periods if it rotates, as a trackKeys entry if it does not.',
			);
		}
		if (options.trackKeys !== undefined && stated === undefined && periods === undefined) {
			throw new Error(
				`trackKeys states no key for track ${track.trackId}; give every encryptable track`
				+ ` (${trackIds.join(', ')}) an entry, or omit trackKeys to encrypt them all under key/kid.`,
			);
		}
		const iv = stated?.iv ?? options.iv;
		if (iv.length !== options.iv.length) {
			throw new Error(
				`trackKeys states a ${iv.length}-byte IV for track ${track.trackId} while iv is`
				+ ` ${options.iv.length} bytes; one IV size is declared for the whole file, so make them equal.`,
			);
		}
		if (periods !== undefined) {
			validateKeyPeriods(track.trackId, periods);
			material.set(track.trackId, { key: periods[0]!.key, kid: periods[0]!.kid, iv, periods });
		} else {
			material.set(track.trackId, { key: stated?.key ?? options.key, kid: stated?.kid ?? options.kid, iv });
		}
	}
	return material;
};

const usesPerSampleIv = (scheme: ProtectionScheme): boolean =>
	scheme === 'cenc' || scheme === 'cens' || scheme === 'cbc1';

// Pattern encryption applies only in a pattern scheme (cbcs/cens) and only to video or AC-4; every
// other case (non-AC-4 audio, or the non-pattern cenc/cbc1 schemes) encrypts whole blocks with no
// pattern. Mirrors shaka's `EncryptionHandler::SetupProtectionPattern`.
const usesPatternEncryption = (track: TrackInfo, scheme: ProtectionScheme): boolean =>
	(scheme === 'cbcs' || scheme === 'cens') && (track.kind === 'video' || track.streamInfo.codec === 'ac4');

const patternFor = (track: TrackInfo, scheme: ProtectionScheme, cryptByteBlock: number, skipByteBlock: number) =>
	usesPatternEncryption(track, scheme) ? { cryptByteBlock, skipByteBlock } : { cryptByteBlock: 0, skipByteBlock: 0 };

// Rewrite each init sample entry to encv/enca + sinf/tenc, in place.
const transformInit = (
	tracks: TrackInfo[], scheme: ProtectionScheme, options: EncryptCmafOptions,
	material: Map<number, TrackKeyMaterial>,
): void => {
	// A second pass would leave the entry carrying two sinf boxes, declaring two schemes over samples
	// encrypted twice — a file that looks encrypted and plays back as neither.
	if (tracks.some(track => findBox([track.sampleEntry], 'sinf') !== null)) {
		throw new Error('The sample entries already declare protection; encrypt the cleartext input instead.');
	}

	for (const track of tracks) {
		const pattern = patternFor(track, scheme, options.cryptByteBlock ?? 1, options.skipByteBlock ?? 9);
		const { kid, iv } = material.get(track.trackId)!;
		const originalFormat = track.sampleEntry.type;
		track.sampleEntry.type = track.kind === 'video' ? 'encv' : 'enca';
		track.sampleEntry.children = [
			...(track.sampleEntry.children ?? []),
			toMutable(buildProtectionSinf({ originalFormat, scheme, kid, ...pattern, iv })),
		];
	}
};

const makeEncryptors = (
	tracks: TrackInfo[], scheme: ProtectionScheme, options: EncryptCmafOptions,
	material: Map<number, TrackKeyMaterial>, ivFor: (trackId: number, iv: Uint8Array) => Uint8Array,
): Map<number, SampleEncryptor> => {
	const encryptors = new Map<number, SampleEncryptor>();
	for (const track of tracks) {
		const { key, iv } = material.get(track.trackId)!;
		encryptors.set(track.trackId, new SampleEncryptor({
			streamInfo: track.streamInfo,
			streamType: track.kind,
			scheme,
			key,
			iv: ivFor(track.trackId, iv),
			cryptByteBlock: options.cryptByteBlock ?? 1,
			skipByteBlock: options.skipByteBlock ?? 9,
		}));
	}
	return encryptors;
};

/** Everything a rotating track needs at fragment time: its periods and their `seig` entries. */
type TrackRotation = { periods: CmafKeyPeriod[]; entries: Uint8Array[] };

// A `seig` entry states the same protection as `tenc` does, so it is built the same way and differs
// only in the KID. Mirrors `buildProtectionSinf`'s choice between a constant and a per-sample IV.
const rotationOf = (
	track: TrackInfo, scheme: ProtectionScheme, options: EncryptCmafOptions, material: TrackKeyMaterial,
): TrackRotation | null => {
	if (material.periods === undefined) {
		return null;
	}
	const pattern = patternFor(track, scheme, options.cryptByteBlock ?? 1, options.skipByteBlock ?? 9);
	return {
		periods: material.periods,
		entries: material.periods.map(period => seigEntry(usesPerSampleIv(scheme)
			? { kid: period.kid, ...pattern, perSampleIvSize: material.iv.length }
			: { kid: period.kid, ...pattern, constantIv: material.iv })),
	};
};

const periodIndexAt = (periods: CmafKeyPeriod[], decodeTime: number, trackId: number): number => {
	const index = periods.findIndex(period => decodeTime >= period.start
		&& decodeTime < period.start + period.duration);
	if (index < 0) {
		const last = periods[periods.length - 1]!;
		throw new Error(
			`Track ${trackId} has a sample at decode time ${decodeTime}, which no key period covers; they`
			+ ` span ${periods[0]!.start} to ${last.start + last.duration}. Extend them over every sample, or`
			+ ' a sample is encrypted under a key the manifest never announces.',
		);
	}
	return index;
};

const baseMediaDecodeTime = (traf: MutableBox, trackId: number): number => {
	const tfdt = findBox([traf], 'tfdt');
	if (tfdt?.data === undefined) {
		throw new Error(
			`The fragment for track ${trackId} carries no tfdt, so the decode time its key periods are`
			+ ' stated against is unknown. Write a tfdt into each traf, or encrypt the track under one key.',
		);
	}
	const view = new DataView(tfdt.data.buffer, tfdt.data.byteOffset, tfdt.data.byteLength);
	return tfdt.data[0] === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4);
};

/**
 * The distinct periods one track fragment draws on and the sample runs mapping onto them, or null
 * when every sample sits in the track's first period — which `tenc` already states, so that fragment
 * gains no sample group and stays as it was.
 */
const sampleGroups = (periodPerSample: number[]): { used: number[]; runs: SampleGroupRun[] } | null => {
	if (periodPerSample.every(period => period === 0)) {
		return null;
	}
	const used = [...new Set(periodPerSample)].sort((a, b) => a - b);
	const runs: SampleGroupRun[] = [];
	for (const period of periodPerSample) {
		const entryIndex = used.indexOf(period);
		const last = runs[runs.length - 1];
		if (last !== undefined && last.entryIndex === entryIndex) {
			last.sampleCount++;
		} else {
			runs.push({ sampleCount: 1, entryIndex });
		}
	}
	return { used, runs };
};

const encryptFragments = (
	boxes: MutableBox[], tracks: TrackInfo[], encryptors: Map<number, SampleEncryptor>,
	scheme: ProtectionScheme, options: EncryptCmafOptions, material: Map<number, TrackKeyMaterial>,
	offsetsBefore: number[],
): void => {
	const perSampleIvSize = usesPerSampleIv(scheme) ? options.iv.length : 0;
	const rotations = new Map<number, TrackRotation>();
	for (const track of tracks) {
		const rotation = rotationOf(track, scheme, options, material.get(track.trackId)!);
		if (rotation !== null) {
			rotations.set(track.trackId, rotation);
		}
	}
	// Every encryptor starts on its track's first period, which is what `tenc` states.
	const currentPeriod = new Map(tracks.map(track => [track.trackId, 0]));

	// A `sidx` indexes what follows it, so it may sit at the front or be chained per fragment.
	const indexes: number[] = [];
	for (let i = 0; i < boxes.length; i++) {
		if (boxes[i]!.type === 'sidx') {
			indexes.push(i);
		}
		if (boxes[i]!.type === 'moof' && boxes[i + 1]?.type === 'mdat') {
			encryptFragmentInPlace(
				boxes[i]!, boxes[i + 1]!, tracks, encryptors, perSampleIvSize, offsetsBefore[i]!,
				rotations, currentPeriod,
			);
		}
	}

	const offsetsAfter = boxOffsets(boxes);
	const movedOffsets = new Map<number, number>();
	for (let i = 0; i < offsetsBefore.length; i++) {
		movedOffsets.set(offsetsBefore[i]!, offsetsAfter[i]!);
	}
	for (const index of indexes) {
		restateSidx(boxes[index]!, index, movedOffsets, offsetsBefore, offsetsAfter);
	}

	const movedMoofs = new Map<number, number>();
	for (let i = 0; i < boxes.length; i++) {
		if (boxes[i]!.type === 'moof') {
			movedMoofs.set(offsetsBefore[i]!, offsetsAfter[i]!);
			restateBaseDataOffsets(boxes[i]!, offsetsAfter[i]! - offsetsBefore[i]!);
		}
	}

	for (const mfra of boxes.filter(box => box.type === 'mfra')) {
		for (const tfra of (mfra.children ?? []).filter(child => child.type === 'tfra')) {
			restateTfraOffsets(tfra, movedMoofs);
		}
	}
};

/**
 * `tfhd.base_data_offset`, when present, is the absolute offset the traf's `trun` offsets are
 * measured from, so it moves with the fragment. Unlike `tfra` this is the primary sample locator:
 * a reader honouring it reads the previous fragment's tail instead of the samples.
 */
const restateBaseDataOffsets = (moof: MutableBox, moofShift: number): void => {
	for (const traf of (moof.children ?? []).filter(box => box.type === 'traf')) {
		const tfhd = findBox([traf], 'tfhd');
		if (tfhd?.data === undefined || !(boxFlags(tfhd.data) & 0x1)) {
			continue;
		}
		const view = new DataView(tfhd.data.buffer, tfhd.data.byteOffset, tfhd.data.byteLength);
		view.setBigUint64(8, view.getBigUint64(8) + BigInt(moofShift));
	}
};

/**
 * `tfra` locates each fragment by absolute file offset, so every entry after the first points at
 * stale bytes once encryption grows the fragments ahead of it.
 */
const restateTfraOffsets = (tfra: MutableBox, movedMoofs: Map<number, number>): void => {
	const data = tfra.data;
	if (data === undefined) {
		return;
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = data[0];
	const lengths = data[11]!;
	// Each entry is time + moof_offset (both 64-bit in version 1), then three 1-to-4 byte numbers.
	const entrySize = (version === 1 ? 16 : 8)
		+ (((lengths >> 4) & 0x3) + 1) + (((lengths >> 2) & 0x3) + 1) + ((lengths & 0x3) + 1);
	const entryCount = view.getUint32(12);

	for (let i = 0; i < entryCount; i++) {
		const at = 16 + i * entrySize + (version === 1 ? 8 : 4);
		const stated = version === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
		const moved = movedMoofs.get(stated);
		if (moved === undefined) {
			// An entry naming something other than a fragment we re-wrote is not ours to restate.
			continue;
		}

		if (version === 1) {
			view.setBigUint64(at, BigInt(moved));
		} else {
			view.setUint32(at, moved);
		}
	}
};

/**
 * The start offset of each top-level box as the file arrived, ending with its total size. Read from
 * the raw bytes rather than the parsed tree because a 64-bit box header is 16 bytes there and 8 in
 * what we write, and every index being restated is stated against the arrival layout.
 */
const arrivedOffsets = (bytes: Uint8Array): number[] => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const offsets: number[] = [];
	let offset = 0;
	while (offset + 8 <= bytes.length) {
		offsets.push(offset);
		const stated = view.getUint32(offset);
		const size = stated === 1
			? Number(view.getBigUint64(offset + 8))
			: stated === 0 ? bytes.length - offset : stated;
		offset += size;
	}
	offsets.push(offset);
	return offsets;
};

const boxOffsets = (boxes: MutableBox[]): number[] => {
	const offsets: number[] = [];
	let offset = 0;
	for (const box of boxes) {
		offsets.push(offset);
		offset += measureBox(box);
	}
	offsets.push(offset);
	return offsets;
};

/**
 * Every distance a `sidx` states — `first_offset` and each `referenced_size` — spans fragments that
 * encryption grew. Each is the gap between two positions in the file, so each is restated by mapping
 * those positions from the layout that arrived to the one being written.
 */
const restateSidx = (
	sidx: MutableBox, sidxIndex: number, movedOffsets: Map<number, number>, before: number[], after: number[],
): void => {
	const data = sidx.data;
	if (data === undefined) {
		return;
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = data[0];
	// The next box's start IS this box's end, in each layout. Adding `measureBox` to an arrived
	// offset would mix the two, and they differ whenever the box arrived with a 64-bit size header.
	const endBefore = before[sidxIndex + 1]!;
	const endAfter = after[sidxIndex + 1]!;
	const endOfInput = before[before.length - 1]!;

	const restated = (position: number): number => {
		const moved = movedOffsets.get(position);
		if (moved === undefined) {
			throw new Error(
				'Cannot restate the sidx: it states a distance to a position that does not start a'
				+ ' top-level box, so what that distance spans cannot be determined.',
			);
		}
		return moved;
	};

	// version(1) + flags(3) + reference_ID(4) + timescale(4) + earliest_presentation_time, then
	// first_offset — 4 bytes each in version 0, 8 each in version 1.
	const firstOffsetPos = version === 0 ? 16 : 20;
	let cursor = endBefore
		+ (version === 0 ? view.getUint32(firstOffsetPos) : Number(view.getBigUint64(firstOffsetPos)));
	if (cursor > endOfInput) {
		// The sidx indexes material this call did not receive — a segment indexing the one after it —
		// so nothing it states was invalidated here.
		return;
	}

	const gapAfter = restated(cursor) - endAfter;
	if (version === 0) {
		view.setUint32(firstOffsetPos, gapAfter);
	} else {
		view.setBigUint64(firstOffsetPos, BigInt(gapAfter));
	}

	let offset = 12 + (version === 0 ? 8 : 16);
	const referenceCount = view.getUint16(offset + 2);
	offset += 4;

	for (let i = 0; i < referenceCount; i++) {
		const raw = u32(data, offset);
		// The top bit is reference_type, which the restated size has to keep.
		const next = cursor + (raw & 0x7fffffff);
		if (next > endOfInput) {
			return;
		}
		setU32(data, offset, (raw & 0x80000000) | (restated(next) - restated(cursor)));
		cursor = next;
		offset += 12;
	}
};

// Appended after the traks, where shaka-packager writes them.
const addPsshBoxes = (moov: MutableBox, boxes: Uint8Array[] | undefined): void => {
	if (boxes === undefined) {
		return;
	}

	for (const bytes of boxes) {
		const parsed = parseBoxes(bytes, 0, bytes.length);
		if (parsed.length !== 1 || parsed[0]!.type !== 'pssh') {
			throw new Error(
				'Each options.pssh entry must be exactly one complete pssh box, as built by buildWidevinePssh,'
				+ ' buildPlayReadyPssh or buildCommonPssh.',
			);
		}

		moov.children = [...(moov.children ?? []), parsed[0]!];
	}
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
 * Statically encrypt every video and audio track of a self-contained MP4 using a CENC scheme
 * (default `cbcs`), fragmented (`moov` + `moof`/`mdat`) or progressive (`moov` + `mdat`). Produces a
 * playable encrypted file: each sample entry becomes `encv`/`enca` + `sinf`/`tenc`. A fragmented
 * file gains a `senc` per fragment (plus `saiz`/`saio` when it carries auxiliary data) with `trun`
 * offsets corrected; a progressive one gains a `senc` per `trak` with `saiz`/`saio` in its `stbl`
 * and `stco`/`co64` corrected. Video keeps NAL/slice headers clear
 * (cbcs/cens 1:9 pattern, or cenc block-aligned subsamples); audio is full-sample encrypted.
 * cbcs uses a constant IV; cenc/cens use an advancing per-sample IV. For split `init.mp4`/`*.m4s`
 * delivery use {@link encryptCmafInit} + {@link encryptCmafSegment} instead.
 *
 * @group Encryption
 * @public
 */
export const encryptCmaf = (bytes: Uint8Array, options: EncryptCmafOptions): Uint8Array => {
	const scheme = options.scheme ?? 'cbcs';
	const boxes = parseBoxes(bytes, 0, bytes.length);
	// `tfra` and `stco` name positions in the file as it arrived, so this has to be read from the raw
	// bytes — before `transformInit` grows the `moov`, and independent of the headers we will write.
	const offsetsBefore = arrivedOffsets(bytes);
	const moov = requireMoov(boxes);
	const tracks = requireTracks(moov);
	const material = keyMaterial(tracks, options);
	transformInit(tracks, scheme, options, material);
	// Must precede the encryptors: they correct stco/tfra against the moov's final size.
	addPsshBoxes(moov, options.pssh);
	const encryptors = makeEncryptors(tracks, scheme, options, material, (_, iv) => iv);
	if (boxes.some((box, i) => box.type === 'moof' && boxes[i + 1]?.type === 'mdat')) {
		encryptFragments(boxes, tracks, encryptors, scheme, options, material, offsetsBefore);
	} else {
		const rotating = [...material].filter(([, track]) => track.periods !== undefined).map(([id]) => id);
		if (rotating.length > 0) {
			throw new Error(
				`keyPeriods states rotation for track ${rotating.join(', ')}, but this file is progressive:`
				+ ' its samples are located by the moov sample table, which holds no per-fragment sample'
				+ ' groups. Fragment the file into moof/mdat before rotating its keys.',
			);
		}
		encryptSampleTables(boxes, tracks, encryptors, usesPerSampleIv(scheme) ? options.iv.length : 0, offsetsBefore);
	}
	return serializeBoxes(boxes);
};

/**
 * Transform a CMAF init segment (`ftyp` + `moov`) for encryption: each sample entry becomes
 * `encv`/`enca` + `sinf`/`tenc`. Pair with {@link encryptCmafSegment} for each media segment.
 *
 * @group Encryption
 * @public
 */
export const encryptCmafInit = (init: Uint8Array, options: EncryptCmafOptions): Uint8Array => {
	const boxes = parseBoxes(init, 0, init.length);
	const moov = requireMoov(boxes);
	const tracks = requireTracks(moov);
	transformInit(tracks, options.scheme ?? 'cbcs', options, keyMaterial(tracks, options));
	addPsshBoxes(moov, options.pssh);
	return serializeBoxes(boxes);
};

/**
 * Encrypt one CMAF media segment (`moof`/`mdat`, optionally `styp`/`sidx`) against its (clear or
 * already-transformed) init segment, which supplies the track/codec info.
 *
 * @group Encryption
 * @public
 */
export const encryptCmafSegment = (
	init: Uint8Array,
	segment: Uint8Array,
	options: EncryptCmafOptions & {
		/**
		 * Each track's IV, carried from one segment to the next: create one empty map per encrypted
		 * presentation and pass it to every segment, in presentation order. It is updated in place, and
		 * holds nothing but bytes, so it can be serialised and restored. A constant-IV scheme (cbcs)
		 * leaves it unused. Key rotation does not widen it: one IV sequence runs on across a track's
		 * key periods, so a track still carries exactly one IV here.
		 */
		ivState: Map<number, Uint8Array>;
	},
): Uint8Array => {
	const scheme = options.scheme ?? 'cbcs';
	if (options.ivState === undefined) {
		throw new Error('encryptCmafSegment needs an ivState to carry each track\'s IV across segments.');
	}

	const tracks = requireTracks(requireMoov(parseBoxes(init, 0, init.length)));
	const material = keyMaterial(tracks, options);
	const encryptors = makeEncryptors(tracks, scheme, options, material, (id, iv) => options.ivState.get(id) ?? iv);
	const segmentBoxes = parseBoxes(segment, 0, segment.length);
	encryptFragments(segmentBoxes, tracks, encryptors, scheme, options, material, arrivedOffsets(segment));

	for (const [trackId, encryptor] of encryptors) {
		options.ivState.set(trackId, encryptor.nextIv());
	}
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

const trunsOf = (traf: MutableBox): MutableBox[] => (traf.children ?? []).filter(box => box.type === 'trun');

/** The offset a traf's `trun` data offsets are measured from: explicit, or the enclosing `moof`. */
const baseDataOffsetOf = (tfhd: MutableBox, moofOffset: number): number => {
	const data = tfhd.data!;
	if (!(boxFlags(data) & 0x1)) {
		return moofOffset;
	}
	return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8));
};

const encryptFragmentInPlace = (
	moof: MutableBox,
	mdat: MutableBox,
	tracks: TrackInfo[],
	encryptors: Map<number, SampleEncryptor>,
	perSampleIvSize: number,
	moofOffset: number,
	rotations: Map<number, TrackRotation>,
	currentPeriod: Map<number, number>,
): void => {
	const moofSizeBefore = measureBox(moof);
	const mdatDataStart = moofOffset + moofSizeBefore + 8;
	const auxTrafs: MutableBox[] = [];

	for (const track of tracks) {
		const traf = findTrafByTrackId(moof, track.trackId);
		if (traf === undefined) {
			continue;
		}
		if (findBox([traf], 'senc') !== null) {
			throw new Error(`The fragment for track ${track.trackId} is already encrypted; it carries a senc.`);
		}
		const tfhd = findBox([traf], 'tfhd')!;
		const base = baseDataOffsetOf(tfhd, moofOffset);
		const defaultSampleSize = defaultSampleSizeOf(tfhd);

		const encryptor = encryptors.get(track.trackId)!;
		const rotation = rotations.get(track.trackId);
		const subsamplesPerSample: SubsampleEntry[][] = [];
		const perSampleIvs: Uint8Array[] = [];
		const periodPerSample: number[] = [];
		let decodeTime = rotation === undefined ? 0 : baseMediaDecodeTime(traf, track.trackId);
		// A traf may hold several truns; each names its own contiguous run of samples in the mdat, and
		// a run without a data offset continues where the previous one ended.
		let cursor = moofSizeBefore + 8 - (mdatDataStart - base);
		for (const trun of trunsOf(traf)) {
			const parsed = parseTrun(trun.data!, defaultSampleSize, track.defaultSampleDuration);
			if (parsed.dataOffsetPos >= 0) {
				cursor = base + u32(trun.data!, parsed.dataOffsetPos) - mdatDataStart;
			}
			for (let i = 0; i < parsed.sizes.length; i++) {
				if (rotation !== undefined) {
					const index = periodIndexAt(rotation.periods, decodeTime, track.trackId);
					if (index !== currentPeriod.get(track.trackId)) {
						encryptor.useKey(rotation.periods[index]!.key);
						currentPeriod.set(track.trackId, index);
					}
					periodPerSample.push(index);
					decodeTime += parsed.durations[i]!;
				}
				const size = parsed.sizes[i]!;
				const encrypted = encryptor.encryptSample(mdat.data!.subarray(cursor, cursor + size));
				mdat.data!.set(encrypted.data, cursor);
				subsamplesPerSample.push(encrypted.subsamples);
				perSampleIvs.push(encrypted.iv);
				cursor += size;
			}
		}

		const groups = rotation === undefined ? null : sampleGroups(periodPerSample);
		if (groups !== null) {
			traf.children = [
				...(traf.children ?? []),
				toMutable(sgpdSeig(groups.used.map(period => rotation!.entries[period]!))),
				toMutable(sbgpSeig(groups.runs)),
			];
		}

		// senc carries aux data when there are subsamples (video) or per-sample IVs (cenc/cens).
		// Only a constant-IV full-sample track (cbcs audio) has empty entries → saiz/saio omitted.
		const perSample = perSampleIvSize > 0;
		const boxForSenc = toMutable(sencBox(subsamplesPerSample, perSample ? perSampleIvs : undefined));
		const hasAuxData = perSample || subsamplesPerSample.some(s => s.length > 0);
		if (hasAuxData) {
			const saizBox = toMutable(saiz(sencEntrySizes(subsamplesPerSample, perSampleIvSize)));
			traf.children = [...(traf.children ?? []), saizBox, toMutable(saio(0)), boxForSenc];
			auxTrafs.push(traf);
		} else {
			traf.children = [...(traf.children ?? []), boxForSenc];
		}
	}

	// The moof grew, so mdat (and every trun's sample data) shifts later by the total delta. This has
	// to happen before the saio offsets below, which chain off the final trun offsets.
	const delta = measureBox(moof) - moofSizeBefore;
	for (const traf of (moof.children ?? []).filter(b => b.type === 'traf')) {
		for (const trun of trunsOf(traf)) {
			// data_offset is the first optional field, so it sits right after version/flags+sample_count.
			if (boxFlags(trun.data!) & TRUN_DATA_OFFSET_PRESENT) {
				setU32(trun.data!, TRUN_DATA_OFFSET, u32(trun.data!, TRUN_DATA_OFFSET) + delta);
			}
		}
	}

	writeAuxInfoOffsets(moof, auxTrafs);
};

/**
 * Point each `saio` at its `senc` entries, measured from the `moof` — the origin `base_data_offset`
 * resolves to under `default-base-is-moof`, which CMAF requires (ISO/IEC 23000-19 §7.5.16).
 */
const writeAuxInfoOffsets = (moof: MutableBox, auxTrafs: MutableBox[]): void => {
	for (const traf of auxTrafs) {
		const senc = findBox([traf], 'senc')!;
		let trafEnd = 8;
		for (const child of moof.children ?? []) {
			trafEnd += measureBox(child);
			if (child === traf) {
				break;
			}
		}
		setU32(findBox([traf], 'saio')!.data!, 8, trafEnd - measureBox(senc) + SENC_ENTRIES_OFFSET);
	}
};

const sampleSizes = (stbl: MutableBox): number[] => {
	const stsz = findBox([stbl], 'stsz');
	if (stsz?.data !== undefined) {
		const uniform = u32(stsz.data, 4);
		const count = u32(stsz.data, 8);
		return Array.from({ length: count }, (_, i) => (uniform !== 0 ? uniform : u32(stsz.data!, 12 + i * 4)));
	}

	const stz2 = findBox([stbl], 'stz2');
	if (stz2?.data === undefined) {
		throw new Error('The sample table has neither an stsz nor an stz2, so its sample sizes are unknown.');
	}
	const data = stz2.data;
	const fieldSize = data[7]!;
	const count = u32(data, 8);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (fieldSize === 16) {
		return Array.from({ length: count }, (_, i) => view.getUint16(12 + i * 2));
	}
	if (fieldSize === 8) {
		return Array.from({ length: count }, (_, i) => data[12 + i]!);
	}
	if (fieldSize === 4) {
		// Two samples per byte, the first in the high nibble.
		return Array.from(
			{ length: count },
			(_, i) => (i % 2 === 0 ? data[12 + i / 2]! >> 4 : data[12 + (i - 1) / 2]! & 0xf),
		);
	}
	throw new Error(`The stz2 states a field size of ${fieldSize} bits, which ISO/IEC 14496-12 does not define.`);
};

const samplesPerChunk = (stbl: MutableBox, chunkCount: number): number[] => {
	const stsc = findBox([stbl], 'stsc')?.data;
	if (stsc === undefined) {
		throw new Error('The sample table has no stsc, so its samples cannot be located in their chunks.');
	}
	const entryCount = u32(stsc, 4);
	const counts: number[] = [];
	for (let i = 0; i < entryCount; i++) {
		const firstChunk = u32(stsc, 8 + i * 12);
		const perChunk = u32(stsc, 12 + i * 12);
		const nextFirstChunk = i + 1 < entryCount ? u32(stsc, 8 + (i + 1) * 12) : chunkCount + 1;
		for (let chunk = firstChunk; chunk < nextFirstChunk; chunk++) {
			counts.push(perChunk);
		}
	}
	return counts;
};

type ChunkOffsets = { box: MutableBox; wide: boolean; offsets: number[] };

const chunkOffsets = (stbl: MutableBox): ChunkOffsets => {
	const stco = findBox([stbl], 'stco');
	const co64 = findBox([stbl], 'co64');
	const box = stco ?? co64;
	if (box?.data === undefined) {
		throw new Error('The sample table has neither an stco nor a co64, so its chunks cannot be located.');
	}
	const wide = stco === null;
	const view = new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength);
	const count = u32(box.data, 4);
	return {
		box,
		wide,
		offsets: Array.from(
			{ length: count },
			(_, i) => (wide ? Number(view.getBigUint64(8 + i * 8)) : u32(box.data!, 8 + i * 4)),
		),
	};
};

const writeChunkOffsets = ({ box, wide, offsets }: ChunkOffsets): void => {
	const view = new DataView(box.data!.buffer, box.data!.byteOffset, box.data!.byteLength);
	offsets.forEach((offset, i) => {
		if (wide) {
			view.setBigUint64(8 + i * 8, BigInt(offset));
		} else {
			view.setUint32(8 + i * 4, offset);
		}
	});
};

/** Every leaf box that can hold sample data, with the file range it occupied on arrival. */
type MediaSpan = { box: MutableBox; start: number; end: number };

const mediaSpans = (boxes: MutableBox[], offsetsBefore: number[]): MediaSpan[] =>
	boxes.flatMap((box, i) => (box.data === undefined
		? []
		: [{ box, start: offsetsBefore[i + 1]! - box.data.byteLength, end: offsetsBefore[i + 1]! }]));

const offsetOf = (boxes: MutableBox[], target: MutableBox, base: number): number | null => {
	let offset = base;
	for (const box of boxes) {
		if (box === target) {
			return offset;
		}
		if (box.children !== undefined) {
			const found = offsetOf(box.children, target, offset + 8 + (box.data?.byteLength ?? 0));
			if (found !== null) {
				return found;
			}
		}
		offset += measureBox(box);
	}
	return null;
};

/**
 * Encrypt a progressive (non-fragmented) file, whose samples the `moov` sample table locates rather
 * than a `moof`. Each track's samples are read chunk by chunk out of the box that held them on
 * arrival, encrypted in place, and described by a `senc` added to the `trak` (ISO/IEC 23001-7 §7.2.1
 * allows the `trak` as its container) with `saiz`/`saio` added to the `stbl`.
 */
const encryptSampleTables = (
	boxes: MutableBox[], tracks: TrackInfo[], encryptors: Map<number, SampleEncryptor>,
	perSampleIvSize: number, offsetsBefore: number[],
): void => {
	const spans = mediaSpans(boxes, offsetsBefore);
	const sampleBytes = (offset: number, size: number): Uint8Array => {
		const span = spans.find(s => offset >= s.start && offset + size <= s.end);
		if (span === undefined) {
			throw new Error(`A chunk at offset ${offset} lies outside every box of the file that holds data.`);
		}
		return span.box.data!.subarray(offset - span.start, offset - span.start + size);
	};

	let encrypted = 0;
	const sencBoxes: { track: TrackInfo; senc: MutableBox }[] = [];
	for (const track of tracks) {
		const stbl = findBox([track.trak], 'stbl');
		if (stbl === null) {
			throw new Error(`Track ${track.trackId} has no stbl, so its samples cannot be located.`);
		}
		if (findBox([track.trak], 'senc') !== null) {
			throw new Error(`Track ${track.trackId} is already encrypted; it carries a senc.`);
		}

		const sizes = sampleSizes(stbl);
		const chunks = chunkOffsets(stbl);
		const perChunk = samplesPerChunk(stbl, chunks.offsets.length);
		const encryptor = encryptors.get(track.trackId)!;
		const subsamplesPerSample: SubsampleEntry[][] = [];
		const perSampleIvs: Uint8Array[] = [];

		let sample = 0;
		for (let chunk = 0; chunk < chunks.offsets.length; chunk++) {
			// Samples are contiguous within a chunk, which is what makes the chunk offset enough.
			let cursor = chunks.offsets[chunk]!;
			for (let i = 0; i < (perChunk[chunk] ?? 0) && sample < sizes.length; i++) {
				const size = sizes[sample]!;
				const target = sampleBytes(cursor, size);
				const result = encryptor.encryptSample(target);
				target.set(result.data);
				subsamplesPerSample.push(result.subsamples);
				perSampleIvs.push(result.iv);
				cursor += size;
				sample++;
			}
		}
		encrypted += sample;

		const senc = toMutable(sencBox(subsamplesPerSample, perSampleIvSize > 0 ? perSampleIvs : undefined));
		track.trak.children = [...(track.trak.children ?? []), senc];
		if (perSampleIvSize > 0 || subsamplesPerSample.some(s => s.length > 0)) {
			stbl.children = [
				...(stbl.children ?? []),
				toMutable(saiz(sencEntrySizes(subsamplesPerSample, perSampleIvSize))),
				toMutable(saio(0)),
			];
			sencBoxes.push({ track, senc });
		}
	}

	if (encrypted === 0) {
		throw new Error('No samples found: the file has neither moof/mdat fragments nor a populated sample table.');
	}

	// The moov grew by every sinf/senc/saiz/saio just added, so the media moved with it.
	const offsetsAfter = boxOffsets(boxes);
	const shifts = new Map<MutableBox, number>();
	for (let i = 0; i < boxes.length; i++) {
		shifts.set(boxes[i]!, offsetsAfter[i + 1]! - offsetsBefore[i + 1]!);
	}
	// Every track's chunks moved, not just the ones with samples to encrypt — a subtitle or metadata
	// track would otherwise keep offsets pointing before the shift.
	for (const trak of (requireMoov(boxes).children ?? []).filter(box => box.type === 'trak')) {
		const stbl = findBox([trak], 'stbl');
		if (stbl === null) {
			continue;
		}

		const chunks = chunkOffsets(stbl);
		chunks.offsets = chunks.offsets.map((offset) => {
			const span = spans.find(s => offset >= s.start && offset < s.end);
			return offset + (span === undefined ? 0 : shifts.get(span.box)!);
		});
		writeChunkOffsets(chunks);
	}

	// Outside a traf there is no base_data_offset to resolve against, so saio states an offset from
	// the start of the file (ISO/IEC 14496-12 §8.7.13).
	for (const { track, senc } of sencBoxes) {
		const stbl = findBox([track.trak], 'stbl')!;
		const at = offsetOf(boxes, senc, 0)! + SENC_ENTRIES_OFFSET;
		if (at > 0xffffffff) {
			throw new Error('The senc lies beyond 4 GiB into the file, which a version 0 saio cannot state.');
		}
		setU32((stbl.children ?? []).filter(b => b.type === 'saio').slice(-1)[0]!.data!, 8, at);
	}
};
