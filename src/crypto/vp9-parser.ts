/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2015 Google LLC. All rights reserved.
 * Original source: shaka-packager/packager/media/codecs/vp9_parser.cc
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Bitstream } from '../../shared/bitstream';

const VP9_FRAME_MARKER = 2;
const VP9_SYNC_CODE = 0x498342;
const REFS_PER_FRAME = 3;
const REF_FRAMES_LOG2 = 3;
const REF_FRAMES = 1 << REF_FRAMES_LOG2;
const FRAME_CONTEXTS_LOG2 = 2;
const MAX_REF_LF_DELTAS = 4;
const MAX_MODE_LF_DELTAS = 2;
const QINDEX_BITS = 8;
const MAX_SEGMENTS = 8;
const SEG_TREE_PROBS = MAX_SEGMENTS - 1;
const PREDICTION_PROBS = 3;
const SEG_LVL_MAX = 4;
const MI_SIZE_LOG2 = 3;
const MI_BLOCK_SIZE_LOG2 = 6 - MI_SIZE_LOG2;
const MIN_TILE_WIDTH_B64 = 4;
const MAX_TILE_WIDTH_B64 = 64;
const VPX_COLOR_SPACE_SRGB = 7;

const SEG_FEATURE_DATA_SIGNED = [true, true, false, false];
const SEG_FEATURE_DATA_MAX_BITS = [8, 6, 2, 0];

/** Per-frame result of {@link parseVp9Frames}: the frame's byte size and its uncompressed-header size. */
export type Vp9FrameInfo = {
	frameSize: number;
	uncompressedHeaderSize: number;
};

/**
 * Parse a VP9 superframe into its constituent frames, returning each frame's size and
 * uncompressed-header size (the CENC clear-byte boundary), or `null` if the bitstream is malformed.
 * Mirrors shaka-packager's `VP9Parser::Parse`.
 * @internal
 */
export const parseVp9Frames = (data: Uint8Array): Vp9FrameInfo[] | null => {
	try {
		return new Vp9Parser().parse(data);
	} catch {
		return null;
	}
};

/** A stateful VP9 parser whose frame dimensions carry across frames (needed for inter frames). */
export type Vp9FrameParser = {
	/** Parse the next frame/superframe, or `null` if malformed. Dimension state persists across calls. */
	parse(data: Uint8Array): Vp9FrameInfo[] | null;
};

/**
 * Create a stateful VP9 parser. Inter frames read tile columns from the prior frame's width, so a
 * stream must be parsed in decode order with one parser (mirroring shaka's reused `vpx_parser_`).
 * @internal
 */
export const createVp9FrameParser = (): Vp9FrameParser => {
	const parser = new Vp9Parser();
	return {
		parse: (data) => {
			try {
				return parser.parse(data);
			} catch {
				return null;
			}
		},
	};
};

const roundupShift = (value: number, n: number): number => (value + (1 << n) - 1) >> n;
const getNumMiUnits = (pixels: number): number => roundupShift(pixels, MI_SIZE_LOG2);
const getNumBlocks = (miUnits: number): number => roundupShift(miUnits, MI_BLOCK_SIZE_LOG2);

const getMinLog2TileCols = (sb64Cols: number): number => {
	let minLog2 = 0;
	while ((MAX_TILE_WIDTH_B64 << minLog2) < sb64Cols) {
		minLog2++;
	}
	return minLog2;
};

const getMaxLog2TileCols = (sb64Cols: number): number => {
	let maxLog2 = 1;
	while ((sb64Cols >> maxLog2) >= MIN_TILE_WIDTH_B64) {
		maxLog2++;
	}
	return maxLog2 - 1;
};

class Vp9ParseError extends Error {}

class Vp9Parser {
	private readonly bitstream: Bitstream;
	private width = 0;
	private height = 0;
	private profile = 0;

	constructor() {
		this.bitstream = new Bitstream(new Uint8Array(0));
	}

	parse(data: Uint8Array): Vp9FrameInfo[] {
		const frames = this.parseSuperframeIndex(data);
		let offset = 0;
		for (const frame of frames) {
			this.parseFrameHeader(data.subarray(offset, offset + frame.frameSize), frame);
			offset += frame.frameSize;
		}
		return frames;
	}

	/** shaka's ParseIfSuperframeIndex: split a superframe into frames, or a single frame. */
	private parseSuperframeIndex(data: Uint8Array): Vp9FrameInfo[] {
		const marker = data[data.length - 1]!;
		if ((marker & 0xe0) !== 0xc0) {
			return [{ frameSize: data.length, uncompressedHeaderSize: 0 }];
		}
		const numFrames = (marker & 0x07) + 1;
		const frameSizeLength = ((marker >> 3) & 0x03) + 1;
		const indexSize = 2 + numFrames * frameSizeLength;
		if (data.length < indexSize) {
			throw new Vp9ParseError();
		}
		if (data[data.length - indexSize] !== marker) {
			throw new Vp9ParseError();
		}
		let pos = data.length - indexSize + 1;
		let totalFrameSizes = 0;
		const frames: Vp9FrameInfo[] = [];
		for (let f = 0; f < numFrames; f++) {
			let frameSize = 0;
			for (let i = 0; i < frameSizeLength; i++) {
				frameSize |= data[pos]! << (i * 8);
				pos++;
			}
			totalFrameSizes += frameSize;
			frames.push({ frameSize, uncompressedHeaderSize: 0 });
		}
		if (totalFrameSizes + indexSize !== data.length) {
			throw new Vp9ParseError();
		}
		return frames;
	}

	private rb(n: number): number {
		if (this.bitstream.getBitsLeft() < n) {
			throw new Vp9ParseError();
		}
		return this.bitstream.readBits(n);
	}

	private skip(n: number): void {
		if (this.bitstream.getBitsLeft() < n) {
			throw new Vp9ParseError();
		}
		this.bitstream.skipBits(n);
	}

	/** shaka BitReader::SkipBitsConditional: read one bit, skip `n` more if it equals `condition`. */
	private skipBitsConditional(condition: boolean, n: number): void {
		const bit = this.rb(1) !== 0;
		if (bit === condition) {
			this.skip(n);
		}
	}

	private parseFrameHeader(frame: Uint8Array, info: Vp9FrameInfo): void {
		this.bitstream.bytes = frame;
		this.bitstream.pos = 0;
		const frameSize = frame.length;

		if (this.rb(2) !== VP9_FRAME_MARKER) {
			throw new Vp9ParseError();
		}
		this.readProfile();

		const showExistingFrame = this.rb(1);
		if (showExistingFrame) {
			this.skip(3); // ref_frame_index
			if (this.bitstream.getBitsLeft() >= 8) {
				throw new Vp9ParseError();
			}
			info.uncompressedHeaderSize = frameSize;
			return;
		}

		const isInterframe = this.rb(1);
		const isKeyframe = !isInterframe;
		const showFrame = this.rb(1);
		const errorResilientMode = this.rb(1);

		if (isKeyframe) {
			this.readSyncCode();
			this.readBitDepthAndColorSpace();
			this.readFrameSizes();
		} else {
			let intraOnly = 0;
			if (!showFrame) {
				intraOnly = this.rb(1);
			}
			if (!errorResilientMode) {
				this.skip(2); // reset_frame_context
			}
			if (intraOnly) {
				this.readSyncCode();
				if (this.profile > 0) {
					this.readBitDepthAndColorSpace();
				}
				this.skip(REF_FRAMES); // refresh_frame_flags
				this.readFrameSizes();
			} else {
				this.skip(REF_FRAMES); // refresh_frame_flags
				this.skip(REFS_PER_FRAME * (REF_FRAMES_LOG2 + 1));
				this.readFrameSizesWithRefs();
				this.skip(1); // allow_high_precision_mv
				const interpFilter = this.rb(1);
				if (!interpFilter) {
					this.skip(2); // interp_filter
				}
			}
		}

		if (!errorResilientMode) {
			this.skip(1); // refresh_frame_context
			this.skip(1); // frame_parallel_decoding_mode
		}
		this.skip(FRAME_CONTEXTS_LOG2); // frame_context_idx

		this.readLoopFilter();
		this.readQuantization();
		this.readSegmentation();
		this.readTileInfo();

		const headerSize = this.rb(16);
		const bitsAvailable = this.bitstream.getBitsLeft();
		info.uncompressedHeaderSize = frameSize - Math.floor(bitsAvailable / 8);
		if (headerSize === 0 || headerSize * 8 > bitsAvailable) {
			throw new Vp9ParseError();
		}
	}

	private readProfile(): void {
		const bit0 = this.rb(1);
		const bit1 = this.rb(1);
		this.profile = bit0 | (bit1 << 1);
		if (this.profile === 3) {
			if (this.rb(1) !== 0) {
				throw new Vp9ParseError(); // reserved bit must be zero
			}
		}
	}

	private readSyncCode(): void {
		if (this.rb(24) !== VP9_SYNC_CODE) {
			throw new Vp9ParseError();
		}
	}

	private readBitDepthAndColorSpace(): void {
		if (this.profile >= 2) {
			this.skip(1); // use_vpx_bits_12 (bit depth)
		}
		const colorSpace = this.rb(3);
		if (colorSpace !== VPX_COLOR_SPACE_SRGB) {
			this.skip(1); // yuv_full_range
			if (this.profile & 1) {
				const subsampling = this.rb(2);
				if (subsampling === 3) {
					throw new Vp9ParseError(); // 4:2:0 not allowed in profile 1/3
				}
				if (this.rb(1) !== 0) {
					throw new Vp9ParseError(); // reserved
				}
			}
		} else {
			if (this.profile & 1) {
				if (this.rb(1) !== 0) {
					throw new Vp9ParseError(); // reserved
				}
			} else {
				throw new Vp9ParseError(); // 4:4:4 not allowed in profile 0/2
			}
		}
	}

	private readFrameSize(): { width: number; height: number } {
		const width = this.rb(16) + 1;
		const height = this.rb(16) + 1;
		return { width, height };
	}

	private readDisplayFrameSize(): void {
		if (this.rb(1)) {
			this.readFrameSize();
		}
	}

	private readFrameSizes(): void {
		const { width, height } = this.readFrameSize();
		this.width = width;
		this.height = height;
		this.readDisplayFrameSize();
	}

	private readFrameSizesWithRefs(): void {
		let found = false;
		for (let i = 0; i < REFS_PER_FRAME; i++) {
			found = this.rb(1) !== 0;
			if (found) {
				break;
			}
		}
		if (!found) {
			this.readFrameSizes();
		} else {
			this.readDisplayFrameSize();
		}
	}

	private readLoopFilter(): void {
		this.skip(9); // filter_level, sharpness_level
		if (!this.rb(1)) {
			return; // mode_ref_delta_enabled
		}
		if (!this.rb(1)) {
			return; // mode_ref_delta_update
		}
		for (let i = 0; i < MAX_REF_LF_DELTAS + MAX_MODE_LF_DELTAS; i++) {
			this.skipBitsConditional(true, 6 + 1);
		}
	}

	private readQuantization(): void {
		this.skip(QINDEX_BITS);
		for (let i = 0; i < 3; i++) {
			this.skipBitsConditional(true, 4 + 1); // delta_q
		}
	}

	private readSegmentation(): void {
		if (!this.rb(1)) {
			return; // enabled
		}
		const updateMap = this.rb(1);
		if (updateMap) {
			for (let i = 0; i < SEG_TREE_PROBS; i++) {
				this.skipBitsConditional(true, 8);
			}
			const temporalUpdate = this.rb(1);
			if (temporalUpdate) {
				for (let j = 0; j < PREDICTION_PROBS; j++) {
					this.skipBitsConditional(true, 8);
				}
			}
		}
		const updateData = this.rb(1);
		if (updateData) {
			this.skip(1); // abs_delta
			for (let i = 0; i < MAX_SEGMENTS; i++) {
				for (let j = 0; j < SEG_LVL_MAX; j++) {
					if (this.rb(1)) {
						this.skip(SEG_FEATURE_DATA_MAX_BITS[j]!);
						if (SEG_FEATURE_DATA_SIGNED[j]) {
							this.skip(1); // signedness
						}
					}
				}
			}
		}
	}

	private readTileInfo(): void {
		const miCols = getNumMiUnits(this.width);
		const sb64Cols = getNumBlocks(miCols);
		const minLog2TileCols = getMinLog2TileCols(sb64Cols);
		const maxLog2TileCols = getMaxLog2TileCols(sb64Cols);
		const maxOnes = maxLog2TileCols - minLog2TileCols;

		let log2TileCols = minLog2TileCols;
		for (let k = 0; k < maxOnes; k++) {
			if (!this.rb(1)) {
				break; // has_more
			}
			log2TileCols++;
		}
		if (log2TileCols > 6) {
			throw new Vp9ParseError();
		}
		this.skipBitsConditional(true, 1); // log2_tile_rows
	}
}
