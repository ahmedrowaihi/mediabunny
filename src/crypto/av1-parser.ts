/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2018 Google LLC. All rights reserved.
 * Original source: shaka-packager/packager/media/codecs/av1_parser.cc
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Bitstream } from '../../shared/bitstream';

const OBU_SEQUENCE_HEADER = 1;
const OBU_FRAME_HEADER = 3;
const OBU_TILE_GROUP = 4;
const OBU_FRAME = 6;
const OBU_REDUNDANT_FRAME_HEADER = 7;

const KEY_FRAME = 0;
const INTER_FRAME = 1;
const INTRA_ONLY_FRAME = 2;
const SWITCH_FRAME = 3;

const CP_BT_709 = 1;
const TC_SRGB = 13;
const MC_IDENTITY = 0;

const SELECT_SCREEN_CONTENT_TOOLS = 2;
const SELECT_INTEGER_MV = 2;
const PRIMARY_REF_NONE = 7;
const NUM_REF_FRAMES = 8;
const REFS_PER_FRAME = 7;
const ALL_FRAMES = (1 << NUM_REF_FRAMES) - 1;
const MAX_SEGMENTS = 8;
const SEG_LVL_MAX = 8;

// RefFrameName offsets (relative to LAST_FRAME) for ref_frame_idx indexing.
const ALTREF_FRAME = 7;

/** A parsed AV1 tile: its byte offset within the frame and its size in bytes (the encrypted region). */
export type Av1Tile = {
	startOffset: number;
	size: number;
};

/**
 * Parse an AV1 temporal unit into its coded tiles, returning each tile's byte offset and size
 * (per the AV1-in-ISOBMFF subsample-encryption rule, only tile data is encrypted), or `null` on a
 * malformed bitstream. Mirrors shaka-packager's `AV1Parser::Parse`.
 * @internal
 */
export const parseAv1Tiles = (data: Uint8Array): Av1Tile[] | null => {
	try {
		return new Av1Parser().parse(data);
	} catch {
		return null;
	}
};

/** A stateful AV1 tile parser whose reference-frame state carries across temporal units. */
export type Av1TileParser = {
	/** Parse the next temporal unit's tiles, or `null` on a malformed unit. State persists across calls. */
	parse(data: Uint8Array): Av1Tile[] | null;
};

/**
 * Create a stateful AV1 tile parser. Inter frames reference prior frames' state, so a stream must be
 * parsed in decode order with one parser (mirroring shaka's reused `av1_parser_` member).
 * @internal
 */
export const createAv1TileParser = (): Av1TileParser => {
	const parser = new Av1Parser();
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

const clip3 = (min: number, max: number, value: number): number =>
	value < min ? min : value > max ? max : value;

const floorLog2 = (x: number): number => {
	let s = 0;
	let v = x;
	while (v !== 0) {
		v >>= 1;
		s++;
	}
	return s - 1;
};

const tileLog2 = (blkSize: number, target: number): number => {
	let k = 0;
	while ((blkSize << k) < target) {
		k++;
	}
	return k;
};

class Av1ParseError extends Error {}

type ColorConfig = {
	bitDepth: number;
	monoChrome: number;
	numPlanes: number;
	colorPrimaries: number;
	transferCharacteristics: number;
	matrixCoefficients: number;
	colorRange: number;
	subsamplingX: number;
	subsamplingY: number;
	separateUvDeltaQ: number;
};

type SequenceHeader = {
	seqProfile: number;
	reducedStillPictureHeader: number;
	decoderModelInfoPresentFlag: boolean;
	operatingPointsCntMinus1: number;
	operatingPointIdc: number[];
	decoderModelPresentForThisOp: boolean[];
	frameWidthBitsMinus1: number;
	frameHeightBitsMinus1: number;
	maxFrameWidthMinus1: number;
	maxFrameHeightMinus1: number;
	frameIdNumbersPresentFlag: number;
	deltaFrameIdLengthMinus2: number;
	additionalFrameIdLengthMinus1: number;
	use128x128Superblock: number;
	enableWarpedMotion: number;
	enableOrderHint: number;
	enableRefFrameMvs: number;
	orderHintBits: number;
	seqForceScreenContentTools: number;
	seqForceIntegerMv: number;
	enableSuperres: number;
	enableCdef: number;
	enableRestoration: number;
	filmGrainParamsPresent: number;
	equalPictureInterval: boolean;
	bufferDelayLengthMinus1: number;
	bufferRemovalTimeLengthMinus1: number;
	framePresentationTimeLengthMinus1: number;
	colorConfig: ColorConfig;
};

type ReferenceFrame = {
	orderHint: number;
	frameType: number;
	upscaledWidth: number;
	frameWidth: number;
	frameHeight: number;
	renderWidth: number;
	renderHeight: number;
	miCols: number;
	miRows: number;
	subsamplingX: number;
	subsamplingY: number;
	bitDepth: number;
};

const newColorConfig = (): ColorConfig => ({
	bitDepth: 8, monoChrome: 0, numPlanes: 3, colorPrimaries: 0, transferCharacteristics: 0,
	matrixCoefficients: 0, colorRange: 0, subsamplingX: 0, subsamplingY: 0, separateUvDeltaQ: 0,
});

class Av1Parser {
	private readonly bitstream = new Bitstream(new Uint8Array(0));

	private readonly seq: SequenceHeader = {
		seqProfile: 0, reducedStillPictureHeader: 0, decoderModelInfoPresentFlag: false,
		operatingPointsCntMinus1: 0, operatingPointIdc: new Array<number>(32).fill(0),
		decoderModelPresentForThisOp: new Array<boolean>(32).fill(false),
		frameWidthBitsMinus1: 0, frameHeightBitsMinus1: 0, maxFrameWidthMinus1: 0, maxFrameHeightMinus1: 0,
		frameIdNumbersPresentFlag: 0, deltaFrameIdLengthMinus2: 0, additionalFrameIdLengthMinus1: 0,
		use128x128Superblock: 0, enableWarpedMotion: 0, enableOrderHint: 0, enableRefFrameMvs: 0,
		orderHintBits: 0, seqForceScreenContentTools: 0, seqForceIntegerMv: 0, enableSuperres: 0,
		enableCdef: 0, enableRestoration: 0, filmGrainParamsPresent: 0, equalPictureInterval: false,
		bufferDelayLengthMinus1: 0, bufferRemovalTimeLengthMinus1: 0, framePresentationTimeLengthMinus1: 0,
		colorConfig: newColorConfig(),
	};

	// Frame-header state carried across OBUs of a temporal unit.
	private seenFrameHeader = false;
	private showExistingFrame = 0;
	private frameToShowMapIdx = 0;
	private frameType = KEY_FRAME;
	private refreshFrameFlags = 0;
	private orderHint = 0;
	private frameWidth = 0;
	private frameHeight = 0;
	private upscaledWidth = 0;
	private renderWidth = 0;
	private renderHeight = 0;
	private miCols = 0;
	private miRows = 0;
	private refFrameIdx = new Array<number>(REFS_PER_FRAME).fill(0);
	private baseQIdx = 0;
	private deltaQydc = 0;
	private deltaQudc = 0;
	private deltaQuac = 0;
	private deltaQvdc = 0;
	private deltaQvac = 0;
	private segmentationEnabled = 0;
	private featureEnabled: boolean[][] = [];
	private featureData: number[][] = [];
	private tileColsLog2 = 0;
	private tileRowsLog2 = 0;
	private tileCols = 0;
	private tileRows = 0;
	private tileSizeBytes = 0;

	private readonly refs: ReferenceFrame[] = Array.from({ length: NUM_REF_FRAMES }, () => ({
		orderHint: 0, frameType: 0, upscaledWidth: 0, frameWidth: 0, frameHeight: 0,
		renderWidth: 0, renderHeight: 0, miCols: 0, miRows: 0, subsamplingX: 0, subsamplingY: 0, bitDepth: 0,
	}));

	parse(data: Uint8Array): Av1Tile[] {
		this.bitstream.bytes = data;
		this.bitstream.pos = 0;
		const tiles: Av1Tile[] = [];
		while (this.bitstream.getBitsLeft() > 0) {
			this.parseOpenBitstreamUnit(tiles);
		}
		return tiles;
	}

	// --- bit-reader primitives (shaka BitReader semantics) ---

	private rb(n: number): number {
		if (n === 0) {
			return 0;
		}
		if (this.bitstream.getBitsLeft() < n) {
			throw new Av1ParseError();
		}
		return this.bitstream.readBits(n);
	}

	private skip(n: number): void {
		if (this.bitstream.getBitsLeft() < n) {
			throw new Av1ParseError();
		}
		this.bitstream.skipBits(n);
	}

	private skipBitsConditional(condition: boolean, n: number): void {
		const bit = this.rb(1) !== 0;
		if (bit === condition) {
			this.skip(n);
		}
	}

	private get pos(): number {
		return this.bitstream.pos;
	}

	private readUvlc(): number {
		let leadingZeros = 0;
		for (;;) {
			if (this.rb(1)) {
				break;
			}
			leadingZeros++;
		}
		if (leadingZeros >= 32) {
			return 0xffffffff;
		}
		const value = this.rb(leadingZeros);
		return value + (1 << leadingZeros) - 1;
	}

	private readLe(n: number): number {
		let t = 0;
		for (let i = 0; i < n; i++) {
			t += this.rb(8) * 2 ** (i * 8);
		}
		return t;
	}

	private readLeb128(): number {
		let value = 0;
		for (let i = 0; i < 8; i++) {
			const byte = this.rb(8);
			value += (byte & 0x7f) * 2 ** (i * 7);
			if (!(byte & 0x80)) {
				break;
			}
		}
		if (value > 2 ** 32 - 1) {
			throw new Av1ParseError();
		}
		return value;
	}

	private readSu(n: number): number {
		let value = this.rb(n);
		const signMask = 1 << (n - 1);
		if (value & signMask) {
			value = value - 2 * signMask;
		}
		return value;
	}

	private readNs(n: number): number {
		const w = floorLog2(n) + 1;
		const m = (1 << w) - n;
		const value = this.rb(w - 1);
		if (value < m) {
			return value;
		}
		const extraBit = this.rb(1);
		return (value << 1) - m + extraBit;
	}

	// --- OBU framing ---

	private parseOpenBitstreamUnit(tiles: Av1Tile[]): void {
		const { obuType, obuHasSizeField, temporalId, spatialId } = this.parseObuHeader();
		const obuSize = obuHasSizeField ? this.readLeb128() : Math.floor(this.bitstream.getBitsLeft() / 8);

		const startPosition = this.pos;
		switch (obuType) {
			case OBU_SEQUENCE_HEADER:
				this.parseSequenceHeaderObu();
				break;
			case OBU_FRAME_HEADER:
			case OBU_REDUNDANT_FRAME_HEADER:
				this.parseFrameHeaderObu(temporalId, spatialId);
				break;
			case OBU_TILE_GROUP:
				this.parseTileGroupObu(obuSize, tiles);
				break;
			case OBU_FRAME:
				this.parseFrameObu(obuSize, temporalId, spatialId, tiles);
				break;
			default:
				this.skip(obuSize * 8);
				break;
		}

		const payloadBits = this.pos - startPosition;
		if (obuType === OBU_TILE_GROUP || obuType === OBU_FRAME) {
			if (payloadBits !== obuSize * 8) {
				throw new Av1ParseError();
			}
		} else if (obuSize > 0) {
			if (payloadBits > obuSize * 8) {
				throw new Av1ParseError();
			}
			this.parseTrailingBits(obuSize * 8 - payloadBits);
		}
	}

	private parseObuHeader(): { obuType: number; obuHasSizeField: number; temporalId: number; spatialId: number } {
		if (this.rb(1) !== 0) {
			throw new Av1ParseError(); // obu_forbidden_bit
		}
		const obuType = this.rb(4);
		const obuExtensionFlag = this.rb(1);
		const obuHasSizeField = this.rb(1);
		this.skip(1); // obu_reserved_1bit
		let temporalId = 0;
		let spatialId = 0;
		if (obuExtensionFlag) {
			temporalId = this.rb(3);
			spatialId = this.rb(2);
			this.skip(3); // extension_header_reserved_3bits
		}
		return { obuType, obuHasSizeField, temporalId, spatialId };
	}

	private parseTrailingBits(nbBits: number): void {
		if (this.rb(1) !== 1) {
			throw new Av1ParseError(); // trailing_one_bit
		}
		let remaining = nbBits - 1;
		while (remaining > 0) {
			if (this.rb(1) !== 0) {
				throw new Av1ParseError(); // trailing_zero_bit
			}
			remaining--;
		}
	}

	private byteAlignment(): void {
		while (this.pos & 7) {
			if (this.rb(1) !== 0) {
				throw new Av1ParseError();
			}
		}
	}

	// --- sequence header (5.5) ---

	private parseSequenceHeaderObu(): void {
		const seq = this.seq;
		seq.seqProfile = this.rb(3);
		this.skip(1); // still_picture
		seq.reducedStillPictureHeader = this.rb(1);
		if (seq.reducedStillPictureHeader) {
			seq.decoderModelInfoPresentFlag = false;
			seq.operatingPointsCntMinus1 = 0;
			seq.operatingPointIdc[0] = 0;
			this.skip(5); // seq_level_idx[0]
			seq.decoderModelPresentForThisOp[0] = false;
		} else {
			const timingInfoPresentFlag = this.rb(1);
			let decoderModelInfoPresentFlag = false;
			if (timingInfoPresentFlag) {
				this.parseTimingInfo();
				decoderModelInfoPresentFlag = this.rb(1) !== 0;
				if (decoderModelInfoPresentFlag) {
					this.parseDecoderModelInfo();
				}
			}
			seq.decoderModelInfoPresentFlag = decoderModelInfoPresentFlag;
			const initialDisplayDelayPresentFlag = this.rb(1);
			seq.operatingPointsCntMinus1 = this.rb(5);
			for (let i = 0; i <= seq.operatingPointsCntMinus1; i++) {
				seq.operatingPointIdc[i] = this.rb(12);
				const seqLevelIdxI = this.rb(5);
				if (seqLevelIdxI > 7) {
					this.skip(1); // seq_tier[i]
				}
				if (seq.decoderModelInfoPresentFlag) {
					seq.decoderModelPresentForThisOp[i] = this.rb(1) !== 0;
					if (seq.decoderModelPresentForThisOp[i]) {
						this.skipOperatingParametersInfo();
					}
				} else {
					seq.decoderModelPresentForThisOp[i] = false;
				}
				if (initialDisplayDelayPresentFlag) {
					this.skipBitsConditional(true, 4);
				}
			}
		}

		seq.frameWidthBitsMinus1 = this.rb(4);
		seq.frameHeightBitsMinus1 = this.rb(4);
		seq.maxFrameWidthMinus1 = this.rb(seq.frameWidthBitsMinus1 + 1);
		seq.maxFrameHeightMinus1 = this.rb(seq.frameHeightBitsMinus1 + 1);

		if (seq.reducedStillPictureHeader) {
			seq.frameIdNumbersPresentFlag = 0;
		} else {
			seq.frameIdNumbersPresentFlag = this.rb(1);
		}
		if (seq.frameIdNumbersPresentFlag) {
			seq.deltaFrameIdLengthMinus2 = this.rb(4);
			seq.additionalFrameIdLengthMinus1 = this.rb(3);
		}

		seq.use128x128Superblock = this.rb(1);
		this.skip(1 + 1); // enable_filter_intra, enable_intra_edge_filter

		if (seq.reducedStillPictureHeader) {
			seq.enableWarpedMotion = 0;
			seq.enableOrderHint = 0;
			seq.enableRefFrameMvs = 0;
			seq.orderHintBits = 0;
			seq.seqForceScreenContentTools = SELECT_SCREEN_CONTENT_TOOLS;
			seq.seqForceIntegerMv = SELECT_INTEGER_MV;
		} else {
			this.skip(1 + 1); // enable_interintra_compound, enable_masked_compound
			seq.enableWarpedMotion = this.rb(1);
			this.skip(1); // enable_dual_filter
			seq.enableOrderHint = this.rb(1);
			if (seq.enableOrderHint) {
				this.skip(1); // enable_jnt_comp
				seq.enableRefFrameMvs = this.rb(1);
			} else {
				seq.enableRefFrameMvs = 0;
			}

			const seqChooseScreenContentTools = this.rb(1);
			if (seqChooseScreenContentTools) {
				seq.seqForceScreenContentTools = SELECT_SCREEN_CONTENT_TOOLS;
			} else {
				seq.seqForceScreenContentTools = this.rb(1);
			}

			if (seq.seqForceScreenContentTools > 0) {
				const seqChooseIntegerMv = this.rb(1);
				if (seqChooseIntegerMv) {
					seq.seqForceIntegerMv = SELECT_INTEGER_MV;
				} else {
					seq.seqForceIntegerMv = this.rb(1);
				}
			} else {
				seq.seqForceIntegerMv = SELECT_INTEGER_MV;
			}

			if (seq.enableOrderHint) {
				seq.orderHintBits = this.rb(3) + 1;
			} else {
				seq.orderHintBits = 0;
			}
		}

		seq.enableSuperres = this.rb(1);
		seq.enableCdef = this.rb(1);
		seq.enableRestoration = this.rb(1);
		this.parseColorConfig();
		seq.filmGrainParamsPresent = this.rb(1);
	}

	private parseColorConfig(): void {
		const cc = this.seq.colorConfig;
		const highBitdepth = this.rb(1);
		if (this.seq.seqProfile === 2 && highBitdepth) {
			cc.bitDepth = this.rb(1) ? 12 : 10;
		} else if (this.seq.seqProfile <= 2) {
			cc.bitDepth = highBitdepth ? 10 : 8;
		}

		if (this.seq.seqProfile === 1) {
			cc.monoChrome = 0;
		} else {
			cc.monoChrome = this.rb(1);
		}
		cc.numPlanes = cc.monoChrome ? 1 : 3;

		const colorDescriptionPresentFlag = this.rb(1);
		if (colorDescriptionPresentFlag) {
			cc.colorPrimaries = this.rb(8);
			cc.transferCharacteristics = this.rb(8);
			cc.matrixCoefficients = this.rb(8);
		} else {
			cc.colorPrimaries = 2; // CP_UNSPECIFIED
			cc.transferCharacteristics = 2; // TC_UNSPECIFIED
			cc.matrixCoefficients = 2; // MC_UNSPECIFIED
		}

		if (cc.monoChrome) {
			cc.colorRange = this.rb(1);
			cc.subsamplingX = 1;
			cc.subsamplingY = 1;
			cc.separateUvDeltaQ = 0;
			return;
		} else if (
			cc.colorPrimaries === CP_BT_709
			&& cc.transferCharacteristics === TC_SRGB
			&& cc.matrixCoefficients === MC_IDENTITY
		) {
			cc.colorRange = 1;
			cc.subsamplingX = 0;
			cc.subsamplingY = 0;
		} else {
			cc.colorRange = this.rb(1);
			if (this.seq.seqProfile === 0) {
				cc.subsamplingX = 1;
				cc.subsamplingY = 1;
			} else if (this.seq.seqProfile === 1) {
				cc.subsamplingX = 0;
				cc.subsamplingY = 0;
			} else {
				if (cc.bitDepth === 12) {
					cc.subsamplingX = this.rb(1);
					cc.subsamplingY = cc.subsamplingX ? this.rb(1) : 0;
				} else {
					cc.subsamplingX = 1;
					cc.subsamplingY = 0;
				}
			}
			if (cc.subsamplingX && cc.subsamplingY) {
				this.skip(2); // chroma_sample_position
			}
		}
		cc.separateUvDeltaQ = this.rb(1);
	}

	private parseTimingInfo(): void {
		this.skip(32 + 32); // num_units_in_display_tick, time_scale
		this.seq.equalPictureInterval = this.rb(1) !== 0;
		if (this.seq.equalPictureInterval) {
			this.readUvlc(); // num_ticks_per_picture_minus_1
		}
	}

	private parseDecoderModelInfo(): void {
		this.seq.bufferDelayLengthMinus1 = this.rb(5);
		this.skip(32); // num_units_in_decoding_tick
		this.seq.bufferRemovalTimeLengthMinus1 = this.rb(5);
		this.seq.framePresentationTimeLengthMinus1 = this.rb(5);
	}

	private skipOperatingParametersInfo(): void {
		const n = this.seq.bufferDelayLengthMinus1 + 1;
		this.skip(n + n + 1);
	}

	// --- frame header (5.9) ---

	private parseFrameHeaderObu(temporalId: number, spatialId: number): void {
		if (this.seenFrameHeader) {
			return;
		}
		this.seenFrameHeader = true;
		this.parseUncompressedHeader(temporalId, spatialId);
		if (this.showExistingFrame) {
			this.decodeFrameWrapup();
			this.seenFrameHeader = false;
		} else {
			this.seenFrameHeader = true;
		}
	}

	private parseUncompressedHeader(temporalId: number, spatialId: number): void {
		const seq = this.seq;
		let idLen = 0;
		if (seq.frameIdNumbersPresentFlag) {
			idLen = seq.additionalFrameIdLengthMinus1 + 1 + seq.deltaFrameIdLengthMinus2 + 2;
		}

		let frameIsIntra = false;
		let showFrame = false;
		let showableFrame = false;
		let errorResilientMode = false;

		if (seq.reducedStillPictureHeader) {
			this.showExistingFrame = 0;
			this.frameType = KEY_FRAME;
			frameIsIntra = true;
			showFrame = true;
			showableFrame = false;
		} else {
			this.showExistingFrame = this.rb(1);
			if (this.showExistingFrame) {
				this.frameToShowMapIdx = this.rb(3);
				if (seq.decoderModelInfoPresentFlag && !seq.equalPictureInterval) {
					this.skipTemporalPointInfo();
				}
				this.refreshFrameFlags = 0;
				if (seq.frameIdNumbersPresentFlag) {
					this.skip(idLen); // display_frame_id
				}
				this.frameType = this.refs[this.frameToShowMapIdx]!.frameType;
				if (this.frameType === KEY_FRAME) {
					this.refreshFrameFlags = ALL_FRAMES;
				}
				return;
			}

			this.frameType = this.rb(2);
			frameIsIntra = this.frameType === INTRA_ONLY_FRAME || this.frameType === KEY_FRAME;
			showFrame = this.rb(1) !== 0;
			if (showFrame && seq.decoderModelInfoPresentFlag && !seq.equalPictureInterval) {
				this.skipTemporalPointInfo();
			}
			if (showFrame) {
				showableFrame = this.frameType !== KEY_FRAME;
			} else {
				showableFrame = this.rb(1) !== 0;
			}

			if (this.frameType === SWITCH_FRAME || (this.frameType === KEY_FRAME && showFrame)) {
				errorResilientMode = true;
			} else {
				errorResilientMode = this.rb(1) !== 0;
			}
		}

		if (this.frameType === KEY_FRAME && showFrame) {
			for (let i = 0; i < NUM_REF_FRAMES; i++) {
				this.refs[i]!.orderHint = 0;
			}
		}

		const disableCdfUpdate = this.rb(1);
		let allowScreenContentTools = false;
		if (seq.seqForceScreenContentTools === SELECT_SCREEN_CONTENT_TOOLS) {
			allowScreenContentTools = this.rb(1) !== 0;
		} else {
			allowScreenContentTools = seq.seqForceScreenContentTools !== 0;
		}

		let forceIntegerMv = 0;
		if (allowScreenContentTools) {
			if (seq.seqForceIntegerMv === SELECT_INTEGER_MV) {
				forceIntegerMv = this.rb(1);
			} else {
				forceIntegerMv = seq.seqForceIntegerMv;
			}
		}
		if (frameIsIntra) {
			forceIntegerMv = 1;
		}

		if (seq.frameIdNumbersPresentFlag) {
			this.skip(idLen); // current_frame_id
		}

		let frameSizeOverrideFlag = false;
		if (this.frameType === SWITCH_FRAME) {
			frameSizeOverrideFlag = true;
		} else if (seq.reducedStillPictureHeader) {
			frameSizeOverrideFlag = false;
		} else {
			frameSizeOverrideFlag = this.rb(1) !== 0;
		}

		this.orderHint = this.rb(seq.orderHintBits);
		let primaryRefFrame = 0;
		if (frameIsIntra || errorResilientMode) {
			primaryRefFrame = PRIMARY_REF_NONE;
		} else {
			primaryRefFrame = this.rb(3);
		}

		if (seq.decoderModelInfoPresentFlag) {
			const bufferRemovalTimePresentFlag = this.rb(1);
			if (bufferRemovalTimePresentFlag) {
				for (let opNum = 0; opNum <= seq.operatingPointsCntMinus1; opNum++) {
					if (seq.decoderModelPresentForThisOp[opNum]) {
						const opPtIdc = seq.operatingPointIdc[opNum]!;
						const inTemporalLayer = (opPtIdc >> temporalId) & 1;
						const inSpatialLayer = (opPtIdc >> (spatialId + 8)) & 1;
						if (opPtIdc === 0 || (inTemporalLayer && inSpatialLayer)) {
							this.skip(seq.bufferRemovalTimeLengthMinus1 + 1);
						}
					}
				}
			}
		}

		let allowHighPrecisionMv = false;
		let allowIntrabc = false;

		if (this.frameType === SWITCH_FRAME || (this.frameType === KEY_FRAME && showFrame)) {
			this.refreshFrameFlags = ALL_FRAMES;
		} else {
			this.refreshFrameFlags = this.rb(8);
		}
		if (!frameIsIntra || this.refreshFrameFlags !== ALL_FRAMES) {
			if (errorResilientMode && seq.enableOrderHint) {
				for (let i = 0; i < NUM_REF_FRAMES; i++) {
					this.skip(seq.orderHintBits); // ref_order_hint[i]
				}
			}
		}

		if (frameIsIntra) {
			this.parseFrameSize(frameSizeOverrideFlag);
			this.parseRenderSize();
			if (allowScreenContentTools && this.upscaledWidth === this.frameWidth) {
				allowIntrabc = this.rb(1) !== 0;
			}
		} else {
			let frameRefsShortSignaling = false;
			if (seq.enableOrderHint) {
				frameRefsShortSignaling = this.rb(1) !== 0;
				if (frameRefsShortSignaling) {
					const lastFrameIdx = this.rb(3);
					const goldFrameIdx = this.rb(3);
					this.setFrameRefs(lastFrameIdx, goldFrameIdx);
				}
			}
			for (let i = 0; i < REFS_PER_FRAME; i++) {
				if (!frameRefsShortSignaling) {
					this.refFrameIdx[i] = this.rb(3);
				}
				if (seq.frameIdNumbersPresentFlag) {
					this.skip(seq.deltaFrameIdLengthMinus2 + 2); // delta_frame_id_minus_1
				}
			}
			if (frameSizeOverrideFlag && !errorResilientMode) {
				this.parseFrameSizeWithRefs(frameSizeOverrideFlag);
			} else {
				this.parseFrameSize(frameSizeOverrideFlag);
				this.parseRenderSize();
			}

			if (forceIntegerMv) {
				allowHighPrecisionMv = false;
			} else {
				allowHighPrecisionMv = this.rb(1) !== 0;
			}

			this.skipBitsConditional(false, 2); // interpolation filter
			this.skip(1); // is_motion_mode_switchable
			if (!errorResilientMode && seq.enableRefFrameMvs) {
				this.skip(1); // use_ref_frame_mvs
			}
		}

		if (!seq.reducedStillPictureHeader && !disableCdfUpdate) {
			this.skip(1); // disable_frame_end_update_cdf
		}

		this.parseTileInfo();
		this.parseQuantizationParams();
		this.parseSegmentationParams(primaryRefFrame);

		const deltaQPresent = this.skipDeltaQParams();
		this.skipDeltaLfParams(deltaQPresent, allowIntrabc);

		let codedLossless = true;
		for (let segmentId = 0; segmentId < MAX_SEGMENTS; segmentId++) {
			const qindex = this.getQIndex(segmentId);
			const lossless = qindex === 0 && this.deltaQydc === 0 && this.deltaQuac === 0
				&& this.deltaQudc === 0 && this.deltaQvac === 0 && this.deltaQvdc === 0;
			if (!lossless) {
				codedLossless = false;
			}
		}
		const allLossless = codedLossless && this.frameWidth === this.upscaledWidth;

		this.parseLoopFilterParams(codedLossless, allowIntrabc);
		this.parseCdefParams(codedLossless, allowIntrabc);
		this.parseLrParams(allLossless, allowIntrabc);
		if (!codedLossless) {
			this.skip(1); // tx_mode_select
		}
		const referenceSelect = frameIsIntra ? false : this.rb(1) !== 0;
		this.skipSkipModeParams(frameIsIntra, referenceSelect);

		if (!(frameIsIntra || errorResilientMode || !seq.enableWarpedMotion)) {
			this.rb(1); // allow_warped_motion
		}
		this.skip(1); // reduced_tx_set

		this.skipGlobalMotionParams(frameIsIntra, allowHighPrecisionMv);
		this.skipFilmGrainParams(showFrame, showableFrame);
	}

	private getRelativeDist(a: number, b: number): number {
		if (!this.seq.enableOrderHint) {
			return 0;
		}
		let diff = a - b;
		const m = 1 << (this.seq.orderHintBits - 1);
		diff = (diff & (m - 1)) - (diff & m);
		return diff;
	}

	private parseFrameSize(frameSizeOverrideFlag: boolean): void {
		if (frameSizeOverrideFlag) {
			this.frameWidth = this.rb(this.seq.frameWidthBitsMinus1 + 1) + 1;
			this.frameHeight = this.rb(this.seq.frameHeightBitsMinus1 + 1) + 1;
		} else {
			this.frameWidth = this.seq.maxFrameWidthMinus1 + 1;
			this.frameHeight = this.seq.maxFrameHeightMinus1 + 1;
		}
		this.parseSuperresParams();
		this.computeImageSize();
	}

	private parseRenderSize(): void {
		if (this.rb(1)) {
			this.renderWidth = this.rb(16) + 1;
			this.renderHeight = this.rb(16) + 1;
		} else {
			this.renderWidth = this.upscaledWidth;
			this.renderHeight = this.frameHeight;
		}
	}

	private parseFrameSizeWithRefs(frameSizeOverrideFlag: boolean): void {
		let foundRef = false;
		for (let i = 0; i < REFS_PER_FRAME; i++) {
			foundRef = this.rb(1) !== 0;
			if (foundRef) {
				const ref = this.refs[this.refFrameIdx[i]!]!;
				this.upscaledWidth = ref.upscaledWidth;
				this.frameWidth = this.upscaledWidth;
				this.frameHeight = ref.frameHeight;
				this.renderWidth = ref.renderWidth;
				this.renderHeight = ref.renderHeight;
				break;
			}
		}
		if (!foundRef) {
			this.parseFrameSize(frameSizeOverrideFlag);
			this.parseRenderSize();
		} else {
			this.parseSuperresParams();
			this.computeImageSize();
		}
	}

	private parseSuperresParams(): void {
		const SUPERRES_NUM = 8;
		const SUPERRES_DENOM_MIN = 9;
		const SUPERRES_DENOM_BITS = 3;
		let useSuperres = false;
		if (this.seq.enableSuperres) {
			useSuperres = this.rb(1) !== 0;
		}
		let superresDenom: number;
		if (useSuperres) {
			superresDenom = this.rb(SUPERRES_DENOM_BITS) + SUPERRES_DENOM_MIN;
		} else {
			superresDenom = SUPERRES_NUM;
		}
		this.upscaledWidth = Math.floor(
			(this.frameWidth * SUPERRES_NUM + Math.floor(superresDenom / 2)) / superresDenom,
		);
	}

	private computeImageSize(): void {
		this.miCols = 2 * ((this.frameWidth + 7) >> 3);
		this.miRows = 2 * ((this.frameHeight + 7) >> 3);
	}

	private parseLoopFilterParams(codedLossless: boolean, allowIntrabc: boolean): void {
		if (codedLossless || allowIntrabc) {
			return;
		}
		const level0 = this.rb(6);
		const level1 = this.rb(6);
		if (this.seq.colorConfig.numPlanes > 1) {
			if (level0 || level1) {
				this.skip(6 + 6); // loop_filter_level[2], [3]
			}
		}
		this.skip(3); // loop_filter_sharpness
		if (this.rb(1)) { // loop_filter_delta_enabled
			if (this.rb(1)) { // loop_filter_delta_update
				for (let i = 0; i < 8; i++) {
					this.skipBitsConditional(true, 1 + 6);
				}
				for (let i = 0; i < 2; i++) {
					this.skipBitsConditional(true, 1 + 6);
				}
			}
		}
	}

	private parseQuantizationParams(): void {
		const cc = this.seq.colorConfig;
		this.baseQIdx = this.rb(8);
		this.deltaQydc = this.readDeltaQ();
		if (cc.numPlanes > 1) {
			let diffUvDelta = false;
			if (cc.separateUvDeltaQ) {
				diffUvDelta = this.rb(1) !== 0;
			}
			this.deltaQudc = this.readDeltaQ();
			this.deltaQuac = this.readDeltaQ();
			if (diffUvDelta) {
				this.deltaQvdc = this.readDeltaQ();
				this.deltaQvac = this.readDeltaQ();
			} else {
				this.deltaQvdc = this.deltaQudc;
				this.deltaQvac = this.deltaQuac;
			}
		} else {
			this.deltaQudc = 0;
			this.deltaQuac = 0;
			this.deltaQvdc = 0;
			this.deltaQvac = 0;
		}
		if (this.rb(1)) { // using_qmatrix
			this.skip(4 + 4); // qm_y, qm_u
			if (cc.separateUvDeltaQ) {
				this.skip(4); // qm_v
			}
		}
	}

	private readDeltaQ(): number {
		if (this.rb(1)) { // delta_coded
			return this.readSu(1 + 6);
		}
		return 0;
	}

	private parseSegmentationParams(primaryRefFrame: number): void {
		this.featureEnabled = Array.from({ length: MAX_SEGMENTS }, () => new Array<boolean>(SEG_LVL_MAX).fill(false));
		this.featureData = Array.from({ length: MAX_SEGMENTS }, () => new Array<number>(SEG_LVL_MAX).fill(0));

		this.segmentationEnabled = this.rb(1);
		if (!this.segmentationEnabled) {
			return;
		}
		let segmentationUpdateData = false;
		if (primaryRefFrame === PRIMARY_REF_NONE) {
			segmentationUpdateData = true;
		} else {
			this.skipBitsConditional(true, 1); // update_map / temporal_update
			segmentationUpdateData = this.rb(1) !== 0;
		}
		if (!segmentationUpdateData) {
			return;
		}
		const featureBits = [8, 6, 6, 6, 6, 3, 0, 0];
		const featureSigned = [1, 1, 1, 1, 1, 0, 0, 0];
		const MAX_LOOP_FILTER = 63;
		const featureMax = [255, MAX_LOOP_FILTER, MAX_LOOP_FILTER, MAX_LOOP_FILTER, MAX_LOOP_FILTER, 7, 0, 0];
		for (let i = 0; i < MAX_SEGMENTS; i++) {
			for (let j = 0; j < SEG_LVL_MAX; j++) {
				const enabled = this.rb(1) !== 0;
				this.featureEnabled[i]![j] = enabled;
				let clippedValue = 0;
				if (enabled) {
					const bitsToRead = featureBits[j]!;
					const limit = featureMax[j]!;
					if (featureSigned[j]) {
						clippedValue = clip3(-limit, limit, this.readSu(1 + bitsToRead));
					} else {
						clippedValue = clip3(0, limit, this.rb(bitsToRead));
					}
				}
				this.featureData[i]![j] = clippedValue;
			}
		}
	}

	private parseTileInfo(): void {
		const MAX_TILE_WIDTH = 4096;
		const MAX_TILE_AREA = 4096 * 2304;
		const MAX_TILE_ROWS = 64;
		const MAX_TILE_COLS = 64;

		const use128 = this.seq.use128x128Superblock;
		const sbCols = use128 ? (this.miCols + 31) >> 5 : (this.miCols + 15) >> 4;
		const sbRows = use128 ? (this.miRows + 31) >> 5 : (this.miRows + 15) >> 4;
		const sbShift = use128 ? 5 : 4;
		const sbSize = sbShift + 2;
		const maxTileWidthSb = MAX_TILE_WIDTH >> sbSize;
		let maxTileAreaSb = MAX_TILE_AREA >> (2 * sbSize);
		const minLog2TileCols = tileLog2(maxTileWidthSb, sbCols);
		const maxLog2TileCols = tileLog2(1, Math.min(sbCols, MAX_TILE_COLS));
		const maxLog2TileRows = tileLog2(1, Math.min(sbRows, MAX_TILE_ROWS));
		const minLog2Tiles = Math.max(minLog2TileCols, tileLog2(maxTileAreaSb, sbRows * sbCols));

		if (this.rb(1)) { // uniform_tile_spacing_flag
			this.tileColsLog2 = minLog2TileCols;
			while (this.tileColsLog2 < maxLog2TileCols) {
				if (this.rb(1)) {
					this.tileColsLog2++;
				} else {
					break;
				}
			}
			const tileWidthSb = (sbCols + (1 << this.tileColsLog2) - 1) >> this.tileColsLog2;
			let i = 0;
			for (let startSb = 0; startSb < sbCols; startSb += tileWidthSb) {
				i++;
			}
			this.tileCols = i;

			const minLog2TileRows = Math.max(minLog2Tiles - this.tileColsLog2, 0);
			this.tileRowsLog2 = minLog2TileRows;
			while (this.tileRowsLog2 < maxLog2TileRows) {
				if (this.rb(1)) {
					this.tileRowsLog2++;
				} else {
					break;
				}
			}
			const tileHeightSb = (sbRows + (1 << this.tileRowsLog2) - 1) >> this.tileRowsLog2;
			i = 0;
			for (let startSb = 0; startSb < sbRows; startSb += tileHeightSb) {
				i++;
			}
			this.tileRows = i;
		} else {
			let widestTileSb = 0;
			let startSb = 0;
			let i = 0;
			for (; startSb < sbCols; i++) {
				const maxWidth = Math.min(sbCols - startSb, maxTileWidthSb);
				const sizeSb = this.readNs(maxWidth) + 1;
				widestTileSb = Math.max(sizeSb, widestTileSb);
				startSb += sizeSb;
			}
			this.tileCols = i;
			this.tileColsLog2 = tileLog2(1, this.tileCols);

			if (minLog2Tiles > 0) {
				maxTileAreaSb = (sbRows * sbCols) >> (minLog2Tiles + 1);
			} else {
				maxTileAreaSb = sbRows * sbCols;
			}
			const maxTileHeightSb = Math.max(Math.floor(maxTileAreaSb / widestTileSb), 1);

			startSb = 0;
			i = 0;
			for (; startSb < sbRows; i++) {
				const maxHeight = Math.min(sbRows - startSb, maxTileHeightSb);
				const sizeSb = this.readNs(maxHeight) + 1;
				startSb += sizeSb;
			}
			this.tileRows = i;
			this.tileRowsLog2 = tileLog2(1, this.tileRows);
		}
		if (this.tileColsLog2 > 0 || this.tileRowsLog2 > 0) {
			this.skip(this.tileRowsLog2 + this.tileColsLog2); // context_update_tile_id
			this.tileSizeBytes = this.rb(2) + 1;
		}
	}

	private skipDeltaQParams(): boolean {
		let deltaQPresent = false;
		if (this.baseQIdx > 0) {
			deltaQPresent = this.rb(1) !== 0;
		}
		if (deltaQPresent) {
			this.skip(2); // delta_q_res
		}
		return deltaQPresent;
	}

	private skipDeltaLfParams(deltaQPresent: boolean, allowIntrabc: boolean): void {
		if (deltaQPresent) {
			let deltaLfPresent = false;
			if (!allowIntrabc) {
				deltaLfPresent = this.rb(1) !== 0;
			}
			if (deltaLfPresent) {
				this.skip(2 + 1); // delta_lf_res, delta_lf_multi
			}
		}
	}

	private parseCdefParams(codedLossless: boolean, allowIntrabc: boolean): void {
		if (codedLossless || allowIntrabc || !this.seq.enableCdef) {
			return;
		}
		this.skip(2); // cdef_damping_minus_3
		const cdefBits = this.rb(2);
		for (let i = 0; i < (1 << cdefBits); i++) {
			this.skip(4 + 2); // cdef_y_pri_strength, cdef_y_sec_strength
			if (this.seq.colorConfig.numPlanes > 1) {
				this.skip(4 + 2); // cdef_uv_pri_strength, cdef_uv_sec_strength
			}
		}
	}

	private parseLrParams(allLossless: boolean, allowIntrabc: boolean): void {
		if (allLossless || allowIntrabc || !this.seq.enableRestoration) {
			return;
		}
		const remapLrType = [0, 3, 1, 2]; // RESTORE_NONE, SWITCHABLE, WIENER, SGRPROJ
		let usesLr = false;
		let usesChromaLr = false;
		for (let i = 0; i < this.seq.colorConfig.numPlanes; i++) {
			const frameRestorationType = remapLrType[this.rb(2)]!;
			if (frameRestorationType !== 0) {
				usesLr = true;
				if (i > 0) {
					usesChromaLr = true;
				}
			}
		}
		if (usesLr) {
			if (this.seq.use128x128Superblock) {
				this.skip(1); // lr_unit_shift
			} else {
				this.skipBitsConditional(true, 1); // lr_unit_shift, lr_unit_extra_shift
			}
			if (this.seq.colorConfig.subsamplingX && this.seq.colorConfig.subsamplingY && usesChromaLr) {
				this.skip(1); // lr_uv_shift
			}
		}
	}

	private skipSkipModeParams(frameIsIntra: boolean, referenceSelect: boolean): void {
		let skipModeAllowed = false;
		if (frameIsIntra || !referenceSelect || !this.seq.enableOrderHint) {
			skipModeAllowed = false;
		} else {
			let forwardIdx = -1;
			let forwardHint = 0;
			let backwardIdx = -1;
			let backwardHint = 0;
			for (let i = 0; i < REFS_PER_FRAME; i++) {
				const refHint = this.refs[this.refFrameIdx[i]!]!.orderHint;
				if (this.getRelativeDist(refHint, this.orderHint) < 0) {
					if (forwardIdx < 0 || this.getRelativeDist(refHint, forwardHint) > 0) {
						forwardIdx = i;
						forwardHint = refHint;
					}
				} else if (this.getRelativeDist(refHint, this.orderHint) > 0) {
					if (backwardIdx < 0 || this.getRelativeDist(refHint, backwardHint) < 0) {
						backwardIdx = i;
						backwardHint = refHint;
					}
				}
			}
			if (forwardIdx < 0) {
				skipModeAllowed = false;
			} else if (backwardIdx >= 0) {
				skipModeAllowed = true;
			} else {
				let secondForwardIdx = -1;
				let secondForwardHint = 0;
				for (let i = 0; i < REFS_PER_FRAME; i++) {
					const refHint = this.refs[this.refFrameIdx[i]!]!.orderHint;
					if (this.getRelativeDist(refHint, forwardHint) < 0) {
						if (secondForwardIdx < 0 || this.getRelativeDist(refHint, secondForwardHint) > 0) {
							secondForwardIdx = i;
							secondForwardHint = refHint;
						}
					}
				}
				skipModeAllowed = secondForwardIdx >= 0;
			}
		}
		if (skipModeAllowed) {
			this.skip(1); // skip_mode_present
		}
	}

	private skipGlobalMotionParams(frameIsIntra: boolean, allowHighPrecisionMv: boolean): void {
		if (frameIsIntra) {
			return;
		}
		// ref runs LAST_FRAME(1)..ALTREF_FRAME(7); count is what matters, not the value.
		for (let ref = 1; ref <= ALTREF_FRAME; ref++) {
			let type = 0; // IDENTITY
			if (this.rb(1)) { // is_global
				if (this.rb(1)) { // is_rot_zoom
					type = 2; // ROTZOOM
				} else {
					type = this.rb(1) ? 1 : 3; // TRANSLATION : AFFINE
				}
			}
			if (type >= 2) { // ROTZOOM
				this.skipGlobalParam(type, 2, allowHighPrecisionMv);
				this.skipGlobalParam(type, 3, allowHighPrecisionMv);
				if (type === 3) { // AFFINE
					this.skipGlobalParam(type, 4, allowHighPrecisionMv);
					this.skipGlobalParam(type, 5, allowHighPrecisionMv);
				}
			}
			if (type >= 1) { // TRANSLATION
				this.skipGlobalParam(type, 0, allowHighPrecisionMv);
				this.skipGlobalParam(type, 1, allowHighPrecisionMv);
			}
		}
	}

	private skipGlobalParam(type: number, idx: number, allowHighPrecisionMv: boolean): void {
		const GM_ABS_TRANS_BITS = 12;
		const GM_ABS_TRANS_ONLY_BITS = 9;
		const GM_ABS_ALPHA_BITS = 12;
		let absBits = GM_ABS_ALPHA_BITS;
		if (idx < 2) {
			if (type === 1) { // TRANSLATION
				absBits = GM_ABS_TRANS_ONLY_BITS - (allowHighPrecisionMv ? 0 : 1);
			} else {
				absBits = GM_ABS_TRANS_BITS;
			}
		}
		const mx = 1 << absBits;
		this.skipDecodeSubexp((mx + 1) - -mx); // decode_signed_subexp_with_ref(-mx, mx+1)
	}

	private skipDecodeSubexp(numSyms: number): void {
		let i = 0;
		let mk = 0;
		const k = 3;
		for (;;) {
			const b2 = i ? k + i - 1 : k;
			const a = 1 << b2;
			if (numSyms <= mk + 3 * a) {
				this.readNs(numSyms - mk); // subexp_final_bits
				return;
			}
			if (this.rb(1)) { // subexp_more_bits
				i++;
				mk += a;
			} else {
				this.skip(b2); // subexp_bits
				return;
			}
		}
	}

	private skipFilmGrainParams(showFrame: boolean, showableFrame: boolean): void {
		const cc = this.seq.colorConfig;
		if (!this.seq.filmGrainParamsPresent || (!showFrame && !showableFrame)) {
			return;
		}
		if (!this.rb(1)) { // apply_grain
			return;
		}
		this.skip(16); // grain_seed
		let updateGrain = 1;
		if (this.frameType === INTER_FRAME) {
			updateGrain = this.rb(1);
		}
		if (!updateGrain) {
			this.skip(3); // film_grain_params_ref_idx
			return;
		}
		const numYPoints = this.rb(4);
		this.skip((8 + 8) * numYPoints);

		let chromaScalingFromLuma = false;
		if (!cc.monoChrome) {
			chromaScalingFromLuma = this.rb(1) !== 0;
		}
		let numCbPoints = 0;
		let numCrPoints = 0;
		if (cc.monoChrome || chromaScalingFromLuma
			|| (cc.subsamplingX && cc.subsamplingY && numYPoints === 0)) {
			numCbPoints = 0;
			numCrPoints = 0;
		} else {
			numCbPoints = this.rb(4);
			this.skip((8 + 8) * numCbPoints);
			numCrPoints = this.rb(4);
			this.skip((8 + 8) * numCrPoints);
		}

		this.skip(2); // grain_scaling_minus_8
		const arCoeffLag = this.rb(2);
		const numPosLuma = 2 * arCoeffLag * (arCoeffLag + 1);
		let numPosChroma = numPosLuma;
		if (numYPoints) {
			numPosChroma = numPosLuma + 1;
			this.skip(8 * numPosLuma);
		}
		if (chromaScalingFromLuma || numCbPoints) {
			this.skip(8 * numPosChroma);
		}
		if (chromaScalingFromLuma || numCrPoints) {
			this.skip(8 * numPosChroma);
		}
		this.skip(2 + 2); // ar_coeff_shift_minus_6, grain_scale_shift
		if (numCbPoints) {
			this.skip(8 + 8 + 9); // cb_mult, cb_luma_mult, cb_offset
		}
		if (numCrPoints) {
			this.skip(8 + 8 + 9); // cr_mult, cr_luma_mult, cr_offset
		}
		this.skip(1 + 1); // overlap_flag, clip_to_restricted_range
	}

	private skipTemporalPointInfo(): void {
		this.skip(this.seq.framePresentationTimeLengthMinus1 + 1);
	}

	// --- frame / tile group (5.10, 5.11) ---

	private parseFrameObu(size: number, temporalId: number, spatialId: number, tiles: Av1Tile[]): void {
		const startBitPos = this.pos;
		this.parseFrameHeaderObu(temporalId, spatialId);
		this.byteAlignment();
		const headerBytes = (this.pos - startBitPos) / 8;
		this.parseTileGroupObu(size - headerBytes, tiles);
	}

	private parseTileGroupObu(size: number, tiles: Av1Tile[]): void {
		let remaining = size;
		const startBitPos = this.pos;
		const numTiles = this.tileCols * this.tileRows;
		let tileStartAndEndPresentFlag = false;
		if (numTiles > 1) {
			tileStartAndEndPresentFlag = this.rb(1) !== 0;
		}
		let tgStart = 0;
		let tgEnd = numTiles - 1;
		if (numTiles > 1 && tileStartAndEndPresentFlag) {
			const tileBits = this.tileColsLog2 + this.tileRowsLog2;
			tgStart = this.rb(tileBits);
			tgEnd = this.rb(tileBits);
		}
		this.byteAlignment();
		const headerBytes = (this.pos - startBitPos) / 8;
		remaining -= headerBytes;

		for (let tileNum = tgStart; tileNum <= tgEnd; tileNum++) {
			const lastTile = tileNum === tgEnd;
			let tileSize = remaining;
			if (!lastTile) {
				const tileSizeMinus1 = this.readLe(this.tileSizeBytes);
				tileSize = tileSizeMinus1 + 1;
				remaining -= tileSize + this.tileSizeBytes;
			}
			tiles.push({ startOffset: this.pos / 8, size: tileSize });
			this.skip(tileSize * 8);
		}

		if (tgEnd === numTiles - 1) {
			this.decodeFrameWrapup();
			this.seenFrameHeader = false;
		}
	}

	private segFeatureActiveIdx(idx: number, feature: number): boolean {
		return this.segmentationEnabled !== 0 && Boolean(this.featureEnabled[idx]?.[feature]);
	}

	private getQIndex(segmentId: number): number {
		const SEG_LVL_ALT_Q = 0;
		if (this.segFeatureActiveIdx(segmentId, SEG_LVL_ALT_Q)) {
			const data = this.featureData[segmentId]![SEG_LVL_ALT_Q]!;
			return clip3(0, 255, this.baseQIdx + data);
		}
		return this.baseQIdx;
	}

	private decodeFrameWrapup(): void {
		const refreshFrameFlags = this.refreshFrameFlags;
		if (this.showExistingFrame && this.frameType === KEY_FRAME) {
			const ref = this.refs[this.frameToShowMapIdx]!;
			this.upscaledWidth = ref.upscaledWidth;
			this.frameWidth = ref.frameWidth;
			this.frameHeight = ref.frameHeight;
			this.renderWidth = ref.renderWidth;
			this.renderHeight = ref.renderHeight;
			this.miCols = ref.miCols;
			this.miRows = ref.miRows;
			this.seq.colorConfig.subsamplingX = ref.subsamplingX;
			this.seq.colorConfig.subsamplingY = ref.subsamplingY;
			this.seq.colorConfig.bitDepth = ref.bitDepth;
			this.orderHint = ref.orderHint;
		}
		for (let i = 0; i < NUM_REF_FRAMES; i++) {
			if ((refreshFrameFlags >> i) & 1) {
				const ref = this.refs[i]!;
				ref.upscaledWidth = this.upscaledWidth;
				ref.frameWidth = this.frameWidth;
				ref.frameHeight = this.frameHeight;
				ref.renderWidth = this.renderWidth;
				ref.renderHeight = this.renderHeight;
				ref.miCols = this.miCols;
				ref.miRows = this.miRows;
				ref.frameType = this.frameType;
				ref.subsamplingX = this.seq.colorConfig.subsamplingX;
				ref.subsamplingY = this.seq.colorConfig.subsamplingY;
				ref.bitDepth = this.seq.colorConfig.bitDepth;
				ref.orderHint = this.orderHint;
			}
		}
	}

	private setFrameRefs(lastFrameIdx: number, goldFrameIdx: number): void {
		for (let i = 0; i < REFS_PER_FRAME; i++) {
			this.refFrameIdx[i] = -1;
		}
		this.refFrameIdx[0] = lastFrameIdx; // LAST_FRAME - LAST_FRAME
		this.refFrameIdx[3] = goldFrameIdx; // GOLDEN_FRAME - LAST_FRAME

		const usedFrame = new Array<boolean>(NUM_REF_FRAMES).fill(false);
		usedFrame[lastFrameIdx] = true;
		usedFrame[goldFrameIdx] = true;

		const curFrameHint = 1 << (this.seq.orderHintBits - 1);
		const shiftedOrderHints = new Array<number>(NUM_REF_FRAMES);
		for (let i = 0; i < NUM_REF_FRAMES; i++) {
			shiftedOrderHints[i] = curFrameHint + this.getRelativeDist(this.refs[i]!.orderHint, this.orderHint);
		}

		if (!(shiftedOrderHints[lastFrameIdx]! < curFrameHint)) {
			throw new Av1ParseError();
		}
		if (!(shiftedOrderHints[goldFrameIdx]! < curFrameHint)) {
			throw new Av1ParseError();
		}

		const findLatestBackward = (): number => {
			let ref = -1;
			let latest = 0;
			for (let i = 0; i < NUM_REF_FRAMES; i++) {
				const hint = shiftedOrderHints[i]!;
				if (!usedFrame[i] && hint >= curFrameHint && (ref < 0 || hint >= latest)) {
					ref = i;
					latest = hint;
				}
			}
			return ref;
		};
		const findEarliestBackward = (): number => {
			let ref = -1;
			let earliest = 0;
			for (let i = 0; i < NUM_REF_FRAMES; i++) {
				const hint = shiftedOrderHints[i]!;
				if (!usedFrame[i] && hint >= curFrameHint && (ref < 0 || hint < earliest)) {
					ref = i;
					earliest = hint;
				}
			}
			return ref;
		};
		const findLatestForward = (): number => {
			let ref = -1;
			let latest = 0;
			for (let i = 0; i < NUM_REF_FRAMES; i++) {
				const hint = shiftedOrderHints[i]!;
				if (!usedFrame[i] && hint < curFrameHint && (ref < 0 || hint >= latest)) {
					ref = i;
					latest = hint;
				}
			}
			return ref;
		};

		let ref = findLatestBackward();
		if (ref >= 0) {
			this.refFrameIdx[6] = ref; // ALTREF_FRAME - LAST_FRAME
			usedFrame[ref] = true;
		}
		ref = findEarliestBackward();
		if (ref >= 0) {
			this.refFrameIdx[4] = ref; // BWDREF_FRAME - LAST_FRAME
			usedFrame[ref] = true;
		}
		ref = findEarliestBackward();
		if (ref >= 0) {
			this.refFrameIdx[5] = ref; // ALTREF2_FRAME - LAST_FRAME
			usedFrame[ref] = true;
		}
		// LAST2, LAST3, BWDREF, ALTREF2, ALTREF (offsets relative to LAST_FRAME).
		const refFrameList = [1, 2, 4, 5, 6];
		for (const refFrame of refFrameList) {
			if (this.refFrameIdx[refFrame]! < 0) {
				ref = findLatestForward();
				if (ref >= 0) {
					this.refFrameIdx[refFrame] = ref;
					usedFrame[ref] = true;
				}
			}
		}
		ref = -1;
		let earliestOrderHint = 0;
		for (let i = 0; i < NUM_REF_FRAMES; i++) {
			const hint = shiftedOrderHints[i]!;
			if (ref < 0 || hint < earliestOrderHint) {
				ref = i;
				earliestOrderHint = hint;
			}
		}
		for (let i = 0; i < REFS_PER_FRAME; i++) {
			if (this.refFrameIdx[i]! < 0) {
				this.refFrameIdx[i] = ref;
			}
		}
	}
}
