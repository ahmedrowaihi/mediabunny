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
		} else if (TFDT_CONTAINERS.has(header.name) && walkTfdts(slice.slice(contentStart, header.contentSize), visit)) {
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
