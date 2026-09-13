/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { bytesToHexString, toDataView, uint8ArraysAreEqual } from '../misc';
import { FileSlice } from '../reader';
import { MIN_BOX_HEADER_SIZE, readBoxHeader } from './isobmff-reader';

export const buildIsobmffMimeType = (info: {
	isQuickTime: boolean;
	hasVideo: boolean;
	hasAudio: boolean;
	codecStrings: string[];
}) => {
	const base = info.hasVideo
		? 'video/'
		: info.hasAudio
			? 'audio/'
			: 'application/';

	let string = base + (info.isQuickTime ? 'quicktime' : 'mp4');

	if (info.codecStrings.length > 0) {
		const uniqueCodecMimeTypes = [...new Set(info.codecStrings)];
		string += `; codecs="${uniqueCodecMimeTypes.join(', ')}"`;
	}

	return string;
};

/**
 * Represents a Protection System Specific Header box as used by ISOBMFF Common Encryption. Contains
 * DRM system-specific data that can be used to obtain a decryption key.
 *
 * @group Miscellaneous
 * @public
 */
export type PsshBox = {
	/** The system ID as a 32-bit lowercase hex string. */
	systemId: string;
	/**
	 * The list of key IDs (32-bit lowercase hex strings) this box applies to, or `null` if it applies to all key IDs.
	 */
	keyIds: string[] | null;
	/** The content protection system-specific data. */
	data: Uint8Array;
	/**
	 * The original `pssh` box bytes — full ISO/IEC 23001-7 layout (size + `'pssh'` + version+flags +
	 * systemId + optional keyIds + dataSize + data). Use this when re-emitting the box into a manifest
	 * (`<cenc:pssh>`, HLS `data:` URI, etc.) — it skips a re-serialization round-trip and preserves any
	 * vendor-specific layout details verbatim.
	 */
	bytes: Uint8Array;
};

/**
 * Parsed view of a `pssh` box's contents (everything after the 8-byte box header). Returned by
 * {@link parsePsshBoxContents}; lacks the original `bytes` field carried by a full {@link PsshBox}.
 *
 * @group Miscellaneous
 * @public
 */
export type PsshBoxContents = Omit<PsshBox, 'bytes'>;

/**
 * Parse the contents of a `pssh` box (everything after the box header) into structured fields.
 * Supports v0 (no key IDs) and v1 (with key IDs) layouts. The result lacks the original `bytes`
 * field — callers that have the full box should attach it manually:
 *
 * ```ts
 * const box: PsshBox = { ...parsePsshBoxContents(contents), bytes: fullBoxBytes };
 * ```
 *
 * @group Miscellaneous
 * @public
 */
export const parsePsshBoxContents = (contents: Uint8Array): PsshBoxContents => {
	const view = toDataView(contents);
	let pos = 0;

	const version = view.getUint8(pos);
	pos += 1;

	pos += 3; // Flags

	const systemId = bytesToHexString(contents.subarray(pos, pos + 16));
	pos += 16;

	let keyIds: string[] | null = null;
	if (version > 0) {
		const kidCount = view.getUint32(pos);
		pos += 4;

		if (kidCount > 0) {
			keyIds = [];
			for (let i = 0; i < kidCount; i++) {
				keyIds.push(bytesToHexString(contents.subarray(pos, pos + 16)));
				pos += 16;
			}
		}
	}

	const dataSize = view.getUint32(pos);
	pos += 4;

	return {
		systemId,
		keyIds,
		data: contents.slice(pos, pos + dataSize),
	};
};

/**
 * Returns `true` when two {@link PsshBox} values describe the same DRM system and carry
 * byte-identical system-specific data. Key ID lists are not compared (they are derived from
 * the same data and may legitimately be omitted in v0 boxes).
 *
 * @group Miscellaneous
 * @public
 */
export const psshBoxesAreEqual = (a: PsshBox, b: PsshBox) => (
	a.systemId === b.systemId
	&& uint8ArraysAreEqual(a.data, b.data)
);

/**
 * Common Encryption track-level descriptor parsed from `tenc` (under
 * `sinf.schi`). One per encrypted track.
 *
 * @group Miscellaneous
 * @public
 */
export type TrackEncryptionInfo = {
	/** Protection scheme — `cenc` (CTR mode), `cens` (CTR pattern), or `cbcs` (CBC subsample). */
	scheme: 'cenc' | 'cens' | 'cbcs';
	/** Default Key ID as a 32-character lowercase hex string, or `null` when the track is unprotected. */
	defaultKid: string | null;
	/** Whether samples in this track are protected by default. */
	defaultIsProtected: boolean | null;
	/** Default `IV` size in bytes (8 or 16). `null` when constant IV is used instead. */
	defaultPerSampleIvSize: number | null;
	/** Default constant `IV` bytes (16 bytes, used by `cbcs`). `null` when per-sample IVs are used instead. */
	defaultConstantIv: Uint8Array | null;
	/** Pattern: number of encrypted blocks per cycle. `null` when the scheme doesn't use patterns. */
	defaultCryptByteBlock: number | null;
	/** Pattern: number of skipped blocks per cycle. `null` when the scheme doesn't use patterns. */
	defaultSkipByteBlock: number | null;
};

/**
 * One subsegment reference within a {@link SidxBox}.
 *
 * @group Miscellaneous
 * @public
 */
export type SidxReference = {
	/** `0` for a media subsegment, `1` for a nested `sidx`. */
	referenceType: 0 | 1;
	/** Size of the referenced subsegment in bytes. */
	referencedSize: number;
	/** Duration of the referenced subsegment, in the parent sidx's timescale. */
	subsegmentDuration: number;
	/** `1` if the subsegment starts with a Stream Access Point. */
	startsWithSAP: 0 | 1;
	/** SAP type (0-7) when `startsWithSAP` is `1`. */
	sapType: number;
	/** Offset from the subsegment start to the SAP, in the parent sidx's timescale. */
	sapDeltaTime: number;
};

/**
 * Represents a Segment Index box (`sidx`) in a fragmented MP4. Provides per-subsegment byte
 * offsets, durations and SAP markers — the data needed to address subsegments by byte range.
 *
 * @group Miscellaneous
 * @public
 */
export type SidxBox = {
	/** The track ID this index applies to. */
	referenceID: number;
	/** Timescale of durations and timestamps in this index. */
	timescale: number;
	/** Earliest presentation time of the first subsegment, in this index's timescale. */
	earliestPresentationTime: number;
	/** Byte offset from after this `sidx` box to the first referenced subsegment. Usually `0`. */
	firstOffset: number;
	/** One entry per referenced subsegment, in order. */
	references: SidxReference[];
	/** Absolute byte offset of this `sidx` box in the file. */
	boxStart: number;
	/** Total size of this `sidx` box in bytes. */
	boxSize: number;
};

export const parseSidxBoxContents = (
	contents: Uint8Array,
	boxStart: number,
	boxSize: number,
): SidxBox => {
	const view = toDataView(contents);
	let pos = 0;

	const version = view.getUint8(pos);
	pos += 1;
	pos += 3; // Flags

	const referenceID = view.getUint32(pos);
	pos += 4;
	const timescale = view.getUint32(pos);
	pos += 4;

	let earliestPresentationTime: number;
	let firstOffset: number;
	if (version === 0) {
		earliestPresentationTime = view.getUint32(pos);
		pos += 4;
		firstOffset = view.getUint32(pos);
		pos += 4;
	} else {
		const eptHi = view.getUint32(pos);
		const eptLo = view.getUint32(pos + 4);
		earliestPresentationTime = eptHi * 2 ** 32 + eptLo;
		pos += 8;
		const foHi = view.getUint32(pos);
		const foLo = view.getUint32(pos + 4);
		firstOffset = foHi * 2 ** 32 + foLo;
		pos += 8;
	}

	pos += 2; // Reserved
	const referenceCount = view.getUint16(pos);
	pos += 2;

	const requiredBytes = referenceCount * 12;
	if (pos + requiredBytes > view.byteLength) {
		throw new Error(
			`Incomplete sidx reference table; ${referenceCount} references need ${requiredBytes} bytes,`
			+ ` only ${view.byteLength - pos} available.`,
		);
	}

	const references: SidxReference[] = [];
	for (let i = 0; i < referenceCount; i++) {
		const sizeWord = view.getUint32(pos);
		pos += 4;
		const subsegmentDuration = view.getUint32(pos);
		pos += 4;
		const sapWord = view.getUint32(pos);
		pos += 4;

		references.push({
			referenceType: ((sizeWord >>> 31) & 0x1) as 0 | 1,
			referencedSize: sizeWord & 0x7fffffff,
			subsegmentDuration,
			startsWithSAP: ((sapWord >>> 31) & 0x1) as 0 | 1,
			sapType: (sapWord >>> 28) & 0x7,
			sapDeltaTime: sapWord & 0x0fffffff,
		});
	}

	return {
		referenceID,
		timescale,
		earliestPresentationTime,
		firstOffset,
		references,
		boxStart,
		boxSize,
	};
};

/**
 * Inclusive byte range — `[begin, end]`, both endpoints included.
 * Used throughout mediabunny for byte-range descriptors (sidx-derived
 * ranges, DASH `MediaInfo.initRange` / `indexRange` /
 * `subsegmentRanges`, and HTTP `Range` requests).
 *
 * @group Miscellaneous
 * @public
 */
export type ByteRange = {
	/** First byte of the range (inclusive). */
	begin: number;
	/** Last byte of the range (inclusive). */
	end: number;
};

/**
 * Returns the inclusive byte range of the initialization segment — every
 * byte in the file before the `sidx` box (typically `ftyp` + `moov`,
 * possibly with extra boxes like `free` / `pdin`).
 *
 * @group Miscellaneous
 * @public
 */
export const getSidxInitRange = (sidx: SidxBox): ByteRange => ({
	begin: 0,
	end: sidx.boxStart - 1,
});

/**
 * Returns the inclusive byte range of the `sidx` box itself, suitable
 * for DASH `<SegmentBase @indexRange>` emission.
 *
 * @group Miscellaneous
 * @public
 */
export const getSidxIndexRange = (sidx: SidxBox): ByteRange => ({
	begin: sidx.boxStart,
	end: sidx.boxStart + sidx.boxSize - 1,
});

/**
 * Returns one byte offset per referenced subsegment, in order. Each
 * offset is the absolute byte position in the file where that
 * subsegment begins. Mirrors shaka-packager's
 * `SingleSegmentSegmenter::GetSegmentRanges` algorithm but operates on
 * a parsed (read-side) `SidxBox`.
 *
 * @group Miscellaneous
 * @public
 */
export const getSidxSegmentOffsets = (sidx: SidxBox): number[] => {
	const offsets: number[] = [];
	let cursor = sidx.boxStart + sidx.boxSize + sidx.firstOffset;
	for (const ref of sidx.references) {
		offsets.push(cursor);
		cursor += ref.referencedSize;
	}
	return offsets;
};

/**
 * Returns the peak per-subsegment bitrate in bits per second, rounded
 * to the nearest integer. Returns `0` for sidx boxes with no
 * references or zero timescale.
 *
 * Matches the per-segment-peak heuristic used by every mainstream
 * packager (shaka-packager, ffmpeg, Bento4) for DASH
 * `<Representation @bandwidth>` and HLS `BANDWIDTH`. Note that the
 * DASH spec (ISO/IEC 23009-1 §5.3.5.2) technically defines
 * `@bandwidth` as the max bitrate over any sliding window of size
 * `minBufferTime`; computing that requires bitstream inspection, not
 * sidx data. The per-segment approximation is the *de facto*
 * implementation across the industry.
 *
 * @group Miscellaneous
 * @public
 */
export const getSidxPeakBitrate = (sidx: SidxBox): number => {
	if (sidx.references.length === 0 || sidx.timescale === 0) {
		return 0;
	}
	let max = 0;
	for (const ref of sidx.references) {
		const seconds = ref.subsegmentDuration / sidx.timescale;
		if (seconds > 0) {
			const bps = (ref.referencedSize * 8) / seconds;
			if (bps > max) {
				max = bps;
			}
		}
	}
	return Math.round(max);
};

/**
 * Returns the total span covered by the sidx's referenced subsegments
 * in seconds. Equals media duration when the sidx covers the entire
 * file (the standard CMAF VOD layout). Returns `0` for sidx boxes
 * with no references or zero timescale.
 *
 * @group Miscellaneous
 * @public
 */
export const getSidxDurationSeconds = (sidx: SidxBox): number => {
	if (sidx.references.length === 0 || sidx.timescale === 0) {
		return 0;
	}
	let total = 0;
	for (const ref of sidx.references) {
		total += ref.subsegmentDuration;
	}
	return total / sidx.timescale;
};

/**
 * Returns the duration of the longest single subsegment in seconds.
 * Useful for setting DASH `MPD@minBufferTime` (which must be ≥ the
 * largest segment duration so a player can fully buffer any one
 * segment before playback starts). Returns `0` for sidx boxes with no
 * references or zero timescale.
 *
 * @group Miscellaneous
 * @public
 */
export const getSidxMaxSegmentDuration = (sidx: SidxBox): number => {
	if (sidx.references.length === 0 || sidx.timescale === 0) {
		return 0;
	}
	let max = 0;
	for (const ref of sidx.references) {
		const seconds = ref.subsegmentDuration / sidx.timescale;
		if (seconds > max) {
			max = seconds;
		}
	}
	return max;
};

/**
 * Returns `true` when `segment` is a CMAF / fragmented-MP4 **initialization** segment (a `moov` appears
 * before any `moof`), `false` for a **media** segment (a `moof` appears first). Defaults to `false`
 * when neither top-level box is present. Useful for routing an ingest stream where init and media
 * objects arrive on the same channel.
 *
 * @group Miscellaneous
 * @public
 */
export const isInitializationSegment = (segment: Uint8Array): boolean => {
	const slice = FileSlice.tempFromBytes(segment);
	while (slice.remainingLength >= MIN_BOX_HEADER_SIZE) {
		const boxStart = slice.filePos;
		const header = readBoxHeader(slice);
		if (!header) {
			break;
		}
		if (header.name === 'moov') {
			return true;
		}
		if (header.name === 'moof') {
			return false;
		}
		slice.filePos = boxStart + header.totalSize;
	}
	return false;
};

const TFDT_CONTAINERS = new Set(['moof', 'traf']);

// Depth-first walk of moof → traf, invoking `visit` on each tfdt's content-start offset (on the slice's
// own DataView, shared across subslices). `visit` returns `true` to stop the walk early.
const walkTfdts = (slice: FileSlice, visit: (view: DataView, contentStart: number) => boolean): boolean => {
	while (slice.remainingLength >= MIN_BOX_HEADER_SIZE) {
		const boxStart = slice.filePos;
		const header = readBoxHeader(slice);
		if (!header) {
			break;
		}
		const contentStart = slice.filePos;
		if (header.name === 'tfdt') {
			if (visit(slice.view, contentStart)) {
				return true;
			}
		} else if (
			TFDT_CONTAINERS.has(header.name)
			&& walkTfdts(slice.slice(contentStart, header.contentSize), visit)
		) {
			return true;
		}
		slice.filePos = boxStart + header.totalSize;
	}
	return false;
};

// baseMediaDecodeTime sits after the tfdt version (1) + flags (3); it's u32 (v0) or u64 (v1).
const readBaseMediaDecodeTime = (view: DataView, contentStart: number): number =>
	view.getUint8(contentStart) === 1 ? Number(view.getBigUint64(contentStart + 4)) : view.getUint32(contentStart + 4);

/**
 * Read the `baseMediaDecodeTime` of a fragmented-MP4 (CMAF) segment's first `tfdt`, in that track's
 * own timescale — i.e. where the segment sits on the media timeline. Returns `null` when there is no
 * `tfdt` (an init segment or non-fragmented MP4). Pair with {@link rebaseSegmentDecodeTime} to splice
 * segments onto a continuous timeline: `rebaseSegmentDecodeTime(seg, target - getSegmentDecodeTime(seg))`.
 *
 * @group Miscellaneous
 * @public
 */
export const getSegmentDecodeTime = (segment: Uint8Array): number | null => {
	let time: number | null = null;
	walkTfdts(FileSlice.tempFromBytes(segment), (view, contentStart) => {
		time = readBaseMediaDecodeTime(view, contentStart);
		return true; // first tfdt only
	});
	return time;
};

/**
 * Return a fresh copy of a fragmented-MP4 (CMAF) media segment with every `tfdt` `baseMediaDecodeTime`
 * shifted by `deltaTicks`, expressed in that track's own timescale. Use it to re-time or splice segments
 * onto a continuous timeline — e.g. concatenating segments into a monotonic live feed — without a full
 * demux/remux; only the `tfdt` fields change, all other bytes are copied verbatim. Input with no `moof`
 * (an init segment, or non-fragmented MP4) is copied through unchanged. The result is always a distinct
 * buffer the caller owns.
 *
 * @group Miscellaneous
 * @public
 */
export const rebaseSegmentDecodeTime = (segment: Uint8Array, deltaTicks: number): Uint8Array => {
	const out = segment.slice(); // always a distinct, caller-owned buffer
	if (deltaTicks !== 0) {
		walkTfdts(FileSlice.tempFromBytes(out), (view, contentStart) => {
			const fieldPos = contentStart + 4; // after version (1) + flags (3)
			if (view.getUint8(contentStart) === 1) {
				view.setBigUint64(fieldPos, view.getBigUint64(fieldPos) + BigInt(deltaTicks));
			} else {
				view.setUint32(fieldPos, (view.getUint32(fieldPos) + deltaTicks) >>> 0);
			}
			return false; // every tfdt
		});
	}
	return out;
};

/**
 * A box found by {@link iterateIsobmffBoxes}. Offsets are into the bytes that were iterated.
 *
 * @group Miscellaneous
 * @public
 */
export type IsobmffBoxInfo = {
	/** Four-character box type, e.g. `'moof'`. */
	type: string;
	/** Offset of the box's first byte. */
	start: number;
	/** Size of the whole box, header included, in bytes. */
	size: number;
	/**
	 * Size of the box header in bytes; the content starts at `start + headerSize`. Includes a 64-bit size and a
	 * `uuid` box's 16-byte user type when present.
	 */
	headerSize: number;
};

/**
 * Iterates the ISO BMFF boxes laid end to end in `bytes`, between `start` and `end`. Boxes are not descended
 * into: to walk a box's children, iterate its content,
 * `iterateIsobmffBoxes(bytes, box.start + box.headerSize, box.start + box.size)` — skipping the 4 bytes of
 * version and flags first for a full box such as `meta`. A box of size 0 extends to `end`.
 *
 * @throws When a box header is truncated, or a box's size doesn't fit between its start and `end`.
 * @group Miscellaneous
 * @public
 */
export const iterateIsobmffBoxes = function* (
	bytes: Uint8Array,
	start = 0,
	end = bytes.byteLength,
): Generator<IsobmffBoxInfo> {
	if (start < 0 || end > bytes.byteLength || start > end) {
		throw new RangeError(`Box range [${start}, ${end}) is outside the ${bytes.byteLength} bytes given.`);
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = start;

	while (pos < end) {
		const remaining = end - pos;
		if (remaining < MIN_BOX_HEADER_SIZE) {
			throw new Error(`Truncated ISO BMFF box header at offset ${pos}: ${remaining} bytes left.`);
		}

		let size = view.getUint32(pos);
		const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
		let headerSize = MIN_BOX_HEADER_SIZE;

		if (size === 1) {
			if (remaining < 16) {
				throw new Error(`Truncated 64-bit size of ISO BMFF box '${type}' at offset ${pos}.`);
			}
			size = Number(view.getBigUint64(pos + 8));
			headerSize = 16;
		} else if (size === 0) {
			size = remaining;
		}

		if (type === 'uuid') {
			headerSize += 16;
		}

		if (size < headerSize || size > remaining) {
			throw new Error(
				`ISO BMFF box '${type}' at offset ${pos} declares ${size} bytes, which doesn't fit in the`
				+ ` ${remaining} bytes left.`,
			);
		}

		yield { type, start: pos, size, headerSize };
		pos += size;
	}
};

const childBoxes = (bytes: Uint8Array, parent: IsobmffBoxInfo) =>
	iterateIsobmffBoxes(bytes, parent.start + parent.headerSize, parent.start + parent.size);

// tkhd track_ID and mdhd timescale sit at the same offset in their full box: after version/flags and the
// creation and modification times, which are 32-bit in version 0 and 64-bit in version 1.
const readFullBoxU32AfterTimes = (bytes: Uint8Array, view: DataView, box: IsobmffBoxInfo) => {
	const contentStart = box.start + box.headerSize;
	return view.getUint32(contentStart + (bytes[contentStart] === 1 ? 20 : 12));
};

/**
 * One chunk of a fragmented-MP4 (CMAF) segment, as found by {@link chunksOf}.
 *
 * @group Miscellaneous
 * @public
 */
export type IsobmffChunkInfo = {
	/** Offset of the chunk's first byte, into the bytes that were given. */
	offset: number;
	/** Size of the whole chunk in bytes: its `moof`, its `mdat`, and anything between them. */
	size: number;
	/**
	 * `baseMediaDecodeTime` of the chunk's first `tfdt`, in that track's own timescale, or null when the
	 * chunk states none. Divide by the track's timescale (see {@link getInitSegmentTimescales}) for seconds.
	 */
	decodeTime: number | null;
	/** Track ID of the `traf` the timing fields are read from, or null when the chunk states none. */
	trackId: number | null;
	/** Summed sample duration of that `traf`, in the same timescale, or null when it states no durations. */
	duration: number | null;
	/**
	 * Whether the `traf`'s first sample can be decoded on its own, so playback can start at this chunk — the
	 * `INDEPENDENT=YES` of an `EXT-X-PART`. Null when the chunk states no sample flags.
	 */
	independent: boolean | null;
};

// ISO/IEC 14496-12 sample_flags: sample_depends_on is bits 25-24, sample_is_non_sync_sample is bit 16.
const isIndependentSample = (flags: number): boolean => {
	const dependsOn = (flags >>> 24) & 0x3;
	if (dependsOn !== 0) {
		return dependsOn === 2; // 2 = depends on nothing, 1 = depends on others
	}
	return ((flags >>> 16) & 0x1) === 0;
};

/**
 * Per-track sample defaults from an init segment's `mvex`/`trex`. A `trun` that states neither per-sample
 * durations nor a `tfhd` default — shaka-packager's usual output — leaves these the only source.
 */
const readTrexDefaults = (init: Uint8Array): Map<number, { duration: number; flags: number }> => {
	const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
	const defaults = new Map<number, { duration: number; flags: number }>();

	for (const moov of iterateIsobmffBoxes(init)) {
		if (moov.type !== 'moov') {
			continue;
		}

		for (const mvex of childBoxes(init, moov)) {
			if (mvex.type !== 'mvex') {
				continue;
			}

			for (const trex of childBoxes(init, mvex)) {
				if (trex.type !== 'trex') {
					continue;
				}

				const content = trex.start + trex.headerSize;
				defaults.set(view.getUint32(content + 4), {
					duration: view.getUint32(content + 12),
					flags: view.getUint32(content + 20),
				});
			}
		}
	}

	return defaults;
};

/** Timing of a chunk's first `traf`; CMAF segments carry one track, so the first is the one that matters. */
const readTrafTiming = (
	bytes: Uint8Array,
	view: DataView,
	traf: IsobmffBoxInfo,
	trexDefaults: Map<number, { duration: number; flags: number }>,
) => {
	let trackId: number | null = null;
	let duration: number | null = null;
	let independent: boolean | null = null;
	let defaultSampleDuration: number | null = null;
	let defaultSampleFlags: number | null = null;

	const boxes = [...childBoxes(bytes, traf)];

	// tfhd first: it names the track, whose trex defaults stand in for anything the tfhd and trun omit
	for (const box of boxes) {
		if (box.type !== 'tfhd') {
			continue;
		}

		const content = box.start + box.headerSize;
		const flags = view.getUint32(content) & 0xffffff;
		trackId = view.getUint32(content + 4);

		let pos = content + 8;
		pos += flags & 0x1 ? 8 : 0; // base_data_offset
		pos += flags & 0x2 ? 4 : 0; // sample_description_index
		if (flags & 0x8) {
			defaultSampleDuration = view.getUint32(pos);
			pos += 4;
		}
		pos += flags & 0x10 ? 4 : 0; // default_sample_size
		if (flags & 0x20) {
			defaultSampleFlags = view.getUint32(pos);
		}
	}

	// A trex writes 0 where it stated nothing — the format has no absent value for these — and a
	// zeroed sample_flags decodes as "sync, depends on nothing", which would be a confident wrong answer
	const fromTrex = trackId === null ? undefined : trexDefaults.get(trackId);
	if (defaultSampleDuration === null && fromTrex?.duration) {
		defaultSampleDuration = fromTrex.duration;
	}
	if (defaultSampleFlags === null && fromTrex?.flags) {
		defaultSampleFlags = fromTrex.flags;
	}

	for (const box of boxes) {
		const content = box.start + box.headerSize;

		if (box.type === 'trun' && duration === null) {
			const flags = view.getUint32(content) & 0xffffff;
			const sampleCount = view.getUint32(content + 4);

			let pos = content + 8;
			pos += flags & 0x1 ? 4 : 0; // data_offset
			let firstSampleFlags: number | null = null;
			if (flags & 0x4) {
				firstSampleFlags = view.getUint32(pos);
				pos += 4;
			}

			const perSampleDuration = Boolean(flags & 0x100);
			const perSampleFlags = Boolean(flags & 0x400);
			const sampleSize = (perSampleDuration ? 4 : 0) + (flags & 0x200 ? 4 : 0)
				+ (perSampleFlags ? 4 : 0) + (flags & 0x800 ? 4 : 0);

			if (perSampleDuration) {
				let total = 0;
				for (let i = 0; i < sampleCount; i++) {
					total += view.getUint32(pos + i * sampleSize);
				}
				duration = total;
			} else if (defaultSampleDuration !== null) {
				duration = defaultSampleDuration * sampleCount;
			}

			const flagsOfFirstSample = firstSampleFlags
				?? (perSampleFlags && sampleCount > 0
					? view.getUint32(pos + (perSampleDuration ? 4 : 0) + (flags & 0x200 ? 4 : 0))
					: defaultSampleFlags);
			if (flagsOfFirstSample !== null) {
				independent = isIndependentSample(flagsOfFirstSample);
			}
		}
	}

	return { trackId, duration, independent };
};

/**
 * Splits a fragmented-MP4 (CMAF) segment into the chunks it is made of. A chunk runs from the first box after
 * the previous chunk through its own `mdat`, so `styp`, `sidx`, `prft` and `emsg` belong to the chunk they
 * precede — `styp` opens a segment and the others describe the media that follows them. The chunks therefore
 * tile the segment: their ranges concatenate back into exactly the bytes given, which is what lets them be
 * published as `EXT-X-PART` byte ranges. Returns an empty array for bytes holding no `moof`, such as an
 * initialization segment.
 *
 * Offsets are into the bytes given, so to address parts of a segment as served, pass the bytes as served —
 * encryption moves them, and running this over the output of {@link encryptCmafSegment} states where the
 * chunks ended up rather than where they were before.
 *
 * @param init - The segment's initialization segment, read only for the `trex` sample defaults. Without it,
 * a chunk whose `trun` states no per-sample durations and whose `tfhd` states no default — the usual shape —
 * reports a null {@link IsobmffChunkInfo.duration}, since the segment alone does not carry one.
 * @throws When a box is malformed or runs past the end of the bytes.
 * @group Miscellaneous
 * @public
 */
export const chunksOf = (segment: Uint8Array, init?: Uint8Array): IsobmffChunkInfo[] => {
	const chunks: IsobmffChunkInfo[] = [];
	const trexDefaults = init === undefined
		? new Map<number, { duration: number; flags: number }>()
		: readTrexDefaults(init);

	const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);

	let start: number | null = null;
	let moof: IsobmffBoxInfo | null = null;

	for (const box of iterateIsobmffBoxes(segment)) {
		// A chunk opens at the first box after the previous one: styp opens a segment, and prft and emsg
		// describe the media that follows them, so they belong to the chunk ahead, not the one behind
		start ??= box.start;

		if (box.type === 'moof') {
			moof = box;
		} else if (box.type === 'mdat' && moof !== null) {
			let decodeTime: number | null = null;
			walkTfdts(FileSlice.tempFromBytes(segment.subarray(moof.start, moof.start + moof.size)), (v, at) => {
				decodeTime = readBaseMediaDecodeTime(v, at);
				return true;
			});

			const traf = [...childBoxes(segment, moof)].find(child => child.type === 'traf');
			const timing = traf ? readTrafTiming(segment, view, traf, trexDefaults) : null;

			chunks.push({
				offset: start,
				size: box.start + box.size - start,
				decodeTime,
				trackId: timing?.trackId ?? null,
				duration: timing?.duration ?? null,
				independent: timing?.independent ?? null,
			});

			start = null;
			moof = null;
		}
	}

	// Anything trailing the last mdat joins that chunk, so the chunks always tile the whole segment
	const last = chunks.length > 0 ? chunks[chunks.length - 1]! : null;
	if (last !== null && start !== null) {
		last.size = segment.byteLength - last.offset;
	}

	return chunks;
};

/**
 * Reads each track's media timescale from an initialization segment, synchronously: every `moov`/`trak` maps
 * its `tkhd` track ID to its `mdia`/`mdhd` timescale. Returns an empty map when there is no `moov`, as for a
 * media segment. Pairs with {@link setSegmentDecodeTime}: `id => timescales.get(id)`.
 *
 * @throws When a `trak` lacks a `tkhd` or an `mdhd`, or a box is malformed.
 * @group Miscellaneous
 * @public
 */
export const getInitSegmentTimescales = (init: Uint8Array): Map<number, number> => {
	const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
	const timescales = new Map<number, number>();

	for (const moov of iterateIsobmffBoxes(init)) {
		if (moov.type !== 'moov') {
			continue;
		}

		for (const trak of childBoxes(init, moov)) {
			if (trak.type !== 'trak') {
				continue;
			}

			let trackId: number | null = null;
			let timescale: number | null = null;
			for (const box of childBoxes(init, trak)) {
				if (box.type === 'tkhd') {
					trackId = readFullBoxU32AfterTimes(init, view, box);
				} else if (box.type === 'mdia') {
					for (const mdiaChild of childBoxes(init, box)) {
						if (mdiaChild.type === 'mdhd') {
							timescale = readFullBoxU32AfterTimes(init, view, mdiaChild);
						}
					}
				}
			}

			if (trackId === null || timescale === null) {
				throw new Error(`The 'trak' at offset ${trak.start} is missing its 'tkhd' or 'mdhd'.`);
			}
			timescales.set(trackId, timescale);
		}
	}

	return timescales;
};

/**
 * Returns a copy of a fragmented-MP4 (CMAF) media segment re-timed so that it starts at `seconds`, per track:
 * each track's first `tfdt` becomes `round(seconds × timescale)` in that track's own timescale, and the track's
 * later `tfdt`s in the segment (one per `moof` chunk) move by the same amount, keeping their spacing. Unlike
 * {@link rebaseSegmentDecodeTime}, tracks with different timescales in one `moof` each get the right value.
 * All other bytes are copied verbatim, including a `sidx`, whose earliest presentation time is not updated.
 *
 * @param timescaleOf - The media timescale of a track ID, e.g. from {@link getInitSegmentTimescales}.
 * @throws When a `traf` has no `tfhd` or `tfdt`, `timescaleOf` returns `undefined`, or a version 0 `tfdt`
 * can't hold the new value — rather than wrapping it.
 * @group Miscellaneous
 * @public
 */
export const setSegmentDecodeTime = (
	segment: Uint8Array,
	seconds: number,
	timescaleOf: (trackId: number) => number | undefined,
): Uint8Array => {
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new RangeError(`seconds must be a non-negative finite number, got ${seconds}.`);
	}

	const out = segment.slice();
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	const deltas = new Map<number, bigint>();

	for (const moof of iterateIsobmffBoxes(out)) {
		if (moof.type !== 'moof') {
			continue;
		}

		for (const traf of childBoxes(out, moof)) {
			if (traf.type !== 'traf') {
				continue;
			}

			let trackId: number | null = null;
			let tfdt: IsobmffBoxInfo | null = null;
			for (const box of childBoxes(out, traf)) {
				if (box.type === 'tfhd') {
					trackId = view.getUint32(box.start + box.headerSize + 4);
				} else if (box.type === 'tfdt') {
					tfdt = box;
				}
			}

			if (trackId === null || !tfdt) {
				throw new Error(`The 'traf' at offset ${traf.start} is missing its 'tfhd' or 'tfdt'.`);
			}

			const fieldPos = tfdt.start + tfdt.headerSize + 4;
			const isVersion1 = out[tfdt.start + tfdt.headerSize] === 1;
			const current = isVersion1 ? view.getBigUint64(fieldPos) : BigInt(view.getUint32(fieldPos));

			let delta = deltas.get(trackId);
			if (delta === undefined) {
				const timescale = timescaleOf(trackId);
				if (timescale === undefined) {
					throw new Error(`No timescale for track ${trackId}.`);
				}

				const target = Math.round(seconds * timescale);
				if (!Number.isSafeInteger(target)) {
					throw new RangeError(`${seconds} s at timescale ${timescale} is not representable exactly.`);
				}

				delta = BigInt(target) - current;
				deltas.set(trackId, delta);
			}

			const value = current + delta;
			if (isVersion1) {
				view.setBigUint64(fieldPos, value);
			} else {
				if (value > 0xFFFFFFFFn) {
					throw new RangeError(
						`Track ${trackId}'s version 0 'tfdt' at offset ${tfdt.start} can't hold ${value}; it needs a`
						+ ' version 1 (64-bit) tfdt.',
					);
				}
				view.setUint32(fieldPos, Number(value));
			}
		}
	}

	return out;
};
