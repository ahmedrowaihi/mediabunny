/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source:
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/media/crypto/subsample_generator.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { AES_128_BLOCK_SIZE } from '../aes';
import { iterateNalUnitsInLengthPrefixed } from '../codec-data';
import { parseAc4TocSizeBits } from './ac4-parser';
import { type Av1TileParser, createAv1TileParser } from './av1-parser';
import { createVp9FrameParser, type Vp9FrameParser } from './vp9-parser';

/**
 * CENC protection scheme FourCC. Mirrors shaka's `FourCC` for encryption.
 *
 * @group Encryption
 * @public
 */
export type ProtectionScheme = 'cenc' | 'cbc1' | 'cens' | 'cbcs' | 'cbcs-apple-sample-aes';

/** Codec of the stream being encrypted. */
export type EncryptionCodec = 'avc' | 'hevc' | 'aac' | 'ac3' | 'eac3' | 'ac4' | 'av1' | 'vp9';

/**
 * One encryption subsample: a run of clear bytes followed by a run of encrypted
 * bytes. Mirrors shaka's `SubsampleEntry` (`clear_bytes` is u16, `cipher_bytes` is u32).
 */
export type SubsampleEntry = {
	clearBytes: number;
	cipherBytes: number;
};

/** A single NAL unit within a NAL-structured (AVC/HEVC) frame. Mirrors shaka's `Nalu`. */
export type Nalu = {
	/** NAL unit type (H264: `nal_unit_type`; H265: 6-bit type). */
	type: number;
	/** Size of the NAL header (1 for H264, 2 for H265). */
	headerSize: number;
	/** Size of the NAL minus the header. */
	payloadSize: number;
	/** Whether this NAL carries a coded video slice. */
	isVideoSlice: boolean;
	/** The NAL bytes (header + payload), excluding the length prefix. */
	data: Uint8Array;
};

/**
 * Computes the size of the (clear) slice header of a video-slice NAL so encryption
 * can start on the first byte of slice data. Mirrors shaka's `VideoSliceHeaderParser`;
 * injectable so {@link SubsampleGenerator} can be tested with a mock (as shaka does)
 * and the real H264/H265 parsers can be dropped in.
 */
export type VideoSliceHeaderParser = {
	/** Initialize with the codec configuration record (SPS/PPS). Returns false on failure. */
	initialize(codecConfig: Uint8Array): boolean;
	/** Process a NAL unit (SPS/PPS carry state for later slice headers). Returns false on failure. */
	processNalu(nalu: Nalu): boolean;
	/** Returns the slice header size in bytes, or a negative value on failure. */
	getHeaderSize(nalu: Nalu): number;
};

/** Stream information needed to set up subsample generation. */
export type EncryptionStreamInfo = {
	codec: EncryptionCodec;
	/** Codec configuration record (avcC / hvcC / …). */
	codecConfig: Uint8Array;
	/** NAL unit length prefix size (1, 2 or 4) for NAL-structured video; 0 otherwise. */
	naluLengthSize: 0 | 1 | 2 | 4;
};

/**
 * Whether the protected portion of each subsample must be a multiple of the AES
 * block size. Mirrors shaka's `ShouldAlignProtectedData`. Notably FALSE for `cbcs`:
 * the pattern cryptor owns block structure, and protected data starts on the first
 * byte of slice data. TRUE for `cenc`/`cbc1`/`cens`.
 */
export const shouldAlignProtectedData = (
	scheme: ProtectionScheme,
	vp9SubsampleEncryption: boolean,
	codec: EncryptionCodec,
): boolean => {
	if (codec === 'vp9') {
		return vp9SubsampleEncryption;
	}
	return scheme === 'cbc1' || scheme === 'cens' || scheme === 'cenc';
};

const UINT16_MAX = 0xffff;

/**
 * Accumulates subsamples, merging consecutive clear-only runs, splitting when the
 * clear-byte count exceeds the u16 limit, and block-aligning the protected data when
 * required. Mirrors shaka's `SubsampleOrganizer`.
 * @internal
 */
class SubsampleOrganizer {
	private accumulatedClearBytes = 0;

	constructor(
		private readonly alignProtectedData: boolean,
		private readonly subsamples: SubsampleEntry[],
	) {}

	addSubsample(clearBytes: number, cipherBytes: number): void {
		let cipher = cipherBytes;
		let clearAtEnd = 0;
		if (this.alignProtectedData && cipher !== 0) {
			clearAtEnd = cipher % AES_128_BLOCK_SIZE;
			cipher -= clearAtEnd;
		}

		this.accumulatedClearBytes += clearBytes;
		if (cipher === 0) {
			this.accumulatedClearBytes += clearAtEnd;
			return;
		}

		this.pushSubsample(this.accumulatedClearBytes, cipher);
		this.accumulatedClearBytes = clearAtEnd;
	}

	/** Flush any trailing clear-only bytes. Must be called after the last `addSubsample`. */
	finalize(): void {
		if (this.accumulatedClearBytes > 0) {
			this.pushSubsample(this.accumulatedClearBytes, 0);
			this.accumulatedClearBytes = 0;
		}
	}

	private pushSubsample(clearBytes: number, cipherBytes: number): void {
		let clear = clearBytes;
		while (clear > UINT16_MAX) {
			this.subsamples.push({ clearBytes: UINT16_MAX, cipherBytes: 0 });
			clear -= UINT16_MAX;
		}
		this.subsamples.push({ clearBytes: clear, cipherBytes });
	}
}

const readNalus = (codec: 'avc' | 'hevc', naluLengthSize: 1 | 2 | 4, frame: Uint8Array): Nalu[] => {
	const nalus: Nalu[] = [];
	for (const loc of iterateNalUnitsInLengthPrefixed(frame, naluLengthSize)) {
		const data = frame.subarray(loc.offset, loc.offset + loc.length);
		if (codec === 'avc') {
			const type = data[0]! & 0x1f;
			nalus.push({
				type,
				headerSize: 1,
				payloadSize: loc.length - 1,
				isVideoSlice: type === 1 || type === 5,
				data,
			});
		} else {
			// H265: 16-bit header; type = (header >> 9) & 0x3F, i.e. (data[0] >> 1) & 0x3F. VCL types are 0–31.
			const type = (data[0]! >> 1) & 0x3f;
			nalus.push({
				type,
				headerSize: 2,
				payloadSize: loc.length - 2,
				isVideoSlice: type <= 31,
				data,
			});
		}
	}
	return nalus;
};

/**
 * Parses a video/audio frame and produces its encryption subsamples (clear/encrypted
 * byte ranges). Mirrors shaka-packager's `SubsampleGenerator`. NAL-structured video
 * (AVC/HEVC) keeps NAL/slice headers clear and encrypts the slice payload; audio is
 * full-sample encrypted (empty subsamples) unless a leading clear region applies
 * (Apple SAMPLE-AES).
 */
export class SubsampleGenerator {
	/** @internal */
	private codec: EncryptionCodec = 'avc';
	/** @internal */
	private naluLengthSize: 0 | 1 | 2 | 4 = 0;
	/** @internal */
	private alignProtectedData = false;
	/** @internal */
	private leadingClearBytesSize = 0;
	/** @internal */
	private minProtectedDataSize = 0;
	/** @internal */
	private headerParser: VideoSliceHeaderParser | null = null;
	// VP9/AV1 carry reference state across frames, so one stateful parser is reused for the whole track.
	/** @internal */
	private vp9Parser: Vp9FrameParser | null = null;
	/** @internal */
	private av1Parser: Av1TileParser | null = null;

	constructor(
		/** Whether VP9 uses subsample (vs full-sample) encryption. Only relevant for VP9. */
		private readonly vp9SubsampleEncryption: boolean,
		/** Whether to use CENC v1 (only the NAL header is clear) instead of v3 for H26x. */
		private readonly cencv1: boolean,
	) {}

	/** Inject a slice-header parser (real or, in tests, a mock). Mirrors shaka's test injection. */
	setVideoSliceHeaderParser(parser: VideoSliceHeaderParser): void {
		this.headerParser = parser;
	}

	initialize(scheme: ProtectionScheme, streamInfo: EncryptionStreamInfo): void {
		this.codec = streamInfo.codec;
		this.naluLengthSize = streamInfo.naluLengthSize;
		this.alignProtectedData = shouldAlignProtectedData(scheme, this.vp9SubsampleEncryption, this.codec);

		if (scheme === 'cbcs-apple-sample-aes') {
			const H264_LEADING_CLEAR_BYTES = 32;
			const AUDIO_LEADING_CLEAR_BYTES = 16;
			switch (this.codec) {
				case 'avc': {
					this.leadingClearBytesSize = H264_LEADING_CLEAR_BYTES;
					this.minProtectedDataSize = this.leadingClearBytesSize + AES_128_BLOCK_SIZE + 1;
					break;
				}
				case 'aac':
				case 'ac3': {
					this.leadingClearBytesSize = AUDIO_LEADING_CLEAR_BYTES;
					this.minProtectedDataSize = this.leadingClearBytesSize + AES_128_BLOCK_SIZE;
					break;
				}
				case 'eac3': {
					// E-AC3 SAMPLE-AES leading clear bytes are handled by a dedicated cryptor.
					this.leadingClearBytesSize = 0;
					this.minProtectedDataSize = AES_128_BLOCK_SIZE;
					break;
				}
				default:
					throw new Error(`Unexpected codec for SAMPLE-AES: ${this.codec}`);
			}
		}
	}

	generateSubsamples(frame: Uint8Array): SubsampleEntry[] {
		const subsamples: SubsampleEntry[] = [];
		switch (this.codec) {
			case 'avc':
			case 'hevc': {
				this.generateFromH26xFrame(frame, subsamples);
				break;
			}
			case 'ac4': {
				this.generateFromAc4Frame(frame, subsamples);
				break;
			}
			case 'vp9': {
				// VP9 is subsample-encrypted only when requested; otherwise full-sample (no subsamples).
				if (this.vp9SubsampleEncryption) {
					this.generateFromVp9Frame(frame, subsamples);
				}
				break;
			}
			case 'av1': {
				this.generateFromAv1Frame(frame, subsamples);
				break;
			}
			default: {
				// Full-sample encrypted unless there is a leading clear region (SAMPLE-AES audio).
				if (this.leadingClearBytesSize > 0) {
					const organizer = new SubsampleOrganizer(this.alignProtectedData, subsamples);
					const clearBytes = Math.min(frame.length, this.leadingClearBytesSize);
					organizer.addSubsample(clearBytes, frame.length - clearBytes);
					organizer.finalize();
				}
				// Otherwise: full sample encrypted, no subsamples.
				break;
			}
		}
		return subsamples;
	}

	/** @internal */
	private generateFromH26xFrame(frame: Uint8Array, subsamples: SubsampleEntry[]): void {
		if (this.naluLengthSize === 0) {
			throw new Error('AnnexB stream is not supported for subsample generation.');
		}
		if (this.leadingClearBytesSize === 0 && this.headerParser === null) {
			throw new Error('A VideoSliceHeaderParser is required for cbcs/cenc H26x encryption.');
		}

		const organizer = new SubsampleOrganizer(this.alignProtectedData, subsamples);
		const nalus = readNalus(this.codec === 'hevc' ? 'hevc' : 'avc', this.naluLengthSize, frame);

		for (const nalu of nalus) {
			if (this.leadingClearBytesSize === 0 && !this.headerParser!.processNalu(nalu)) {
				throw new Error(`Failed to process NAL unit: type ${nalu.type}`);
			}

			const naluTotalSize = nalu.headerSize + nalu.payloadSize;
			let clearBytes: number;
			if (this.cencv1) {
				// CENC v1: only the NAL header is clear.
				clearBytes = nalu.headerSize;
			} else if (nalu.isVideoSlice && naluTotalSize >= this.minProtectedDataSize) {
				clearBytes = this.leadingClearBytesSize;
				if (clearBytes === 0) {
					// Keep the NAL header + slice header clear; encrypt the slice data.
					const sliceHeaderSize = this.headerParser!.getHeaderSize(nalu);
					if (sliceHeaderSize < 0) {
						throw new Error('Failed to read slice header.');
					}
					clearBytes = nalu.headerSize + sliceHeaderSize;
				}
			} else {
				// Non-video-slice or too-small NAL: fully clear.
				clearBytes = naluTotalSize;
			}
			organizer.addSubsample(this.naluLengthSize + clearBytes, naluTotalSize - clearBytes);
		}
		organizer.finalize();
	}

	/** @internal */
	private generateFromAv1Frame(frame: Uint8Array, subsamples: SubsampleEntry[]): void {
		this.av1Parser ??= createAv1TileParser();
		const tiles = this.av1Parser.parse(frame);
		if (tiles === null) {
			throw new Error('Failed to parse AV1 frame.');
		}
		const organizer = new SubsampleOrganizer(this.alignProtectedData, subsamples);
		// Per AV1-in-ISOBMFF, only tile data is encrypted; the gaps between tiles stay clear.
		let lastTileEnd = 0;
		for (const { startOffset, size } of tiles) {
			organizer.addSubsample(startOffset - lastTileEnd, size);
			lastTileEnd = startOffset + size;
		}
		if (lastTileEnd < frame.length) {
			organizer.addSubsample(frame.length - lastTileEnd, 0);
		}
		organizer.finalize();
	}

	/** @internal */
	private generateFromVp9Frame(frame: Uint8Array, subsamples: SubsampleEntry[]): void {
		this.vp9Parser ??= createVp9FrameParser();
		const vpxFrames = this.vp9Parser.parse(frame);
		if (vpxFrames === null) {
			throw new Error('Failed to parse vpx frame.');
		}
		const organizer = new SubsampleOrganizer(this.alignProtectedData, subsamples);
		let totalSize = 0;
		for (const { frameSize, uncompressedHeaderSize } of vpxFrames) {
			organizer.addSubsample(uncompressedHeaderSize, frameSize - uncompressedHeaderSize);
			totalSize += frameSize;
		}
		// A superframe carries a trailing index (clear) after the last frame.
		if (vpxFrames.length > 1) {
			organizer.addSubsample(frame.length - totalSize, 0);
		}
		organizer.finalize();
	}

	/** @internal */
	private generateFromAc4Frame(frame: Uint8Array, subsamples: SubsampleEntry[]): void {
		const organizer = new SubsampleOrganizer(this.alignProtectedData, subsamples);
		// A failed TOC parse leaves toc_size 0 → the whole frame is encrypted (shaka's fallback).
		const tocSizeBits = parseAc4TocSizeBits(frame) ?? 0;
		// shaka rounds the TOC bit count up to the next multiple of 8 and treats it as clear bytes.
		const clearBytes = Math.min(frame.length, Math.floor((tocSizeBits + 7) / 8) * 8);
		organizer.addSubsample(clearBytes, frame.length - clearBytes);
		organizer.finalize();
	}
}
