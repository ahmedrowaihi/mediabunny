/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2018 Google LLC. All rights reserved.
 * Original source: shaka-packager/packager/media/codecs/ac4_parser.cc
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Bitstream } from '../../shared/bitstream';

// ch_mode constants (TS 103 190-2 table 78) — only those tested against for bit-consumption.
const CH_MODE_MONO = 0;
const CH_MODE_STEREO = 1;
const CH_MODE_3_0 = 2;
const CH_MODE_5_0 = 3;
const CH_MODE_5_1 = 4;
const CH_MODE_70_34 = 5;
const CH_MODE_71_34 = 6;
const CH_MODE_70_52 = 7;
const CH_MODE_71_52 = 8;
const CH_MODE_70_322 = 9;
const CH_MODE_71_322 = 10;
const CH_MODE_7_0_4 = 11;
const CH_MODE_7_1_4 = 12;
const CH_MODE_9_0_4 = 13;
const CH_MODE_9_1_4 = 14;
const CH_MODE_22_2 = 15;
const CH_MODE_RESERVED = 16;
const CH_MODE_ESCAPE = 0b111111111;

/**
 * Parses an AC-4 raw frame's Table of Contents and returns its size in **bits** (mirroring
 * shaka's `AC4Parser::GetAc4TocSize`), or `null` if the TOC is malformed. Only the bit-consumption
 * of the TOC is reproduced — every field read purely for shaka's discarded structs is skipped by
 * the same bit count, and control-flow-dead state (frame-rate factor is invariably 1; the
 * presentation version never changes a `ReadBits` count) is elided. Verified against shaka's
 * `ac4_parser_unittest` vector (906 bits).
 * @internal
 */
export const parseAc4TocSizeBits = (frame: Uint8Array): number | null => {
	try {
		return new Ac4TocParser(frame).parse();
	} catch {
		return null;
	}
};

// A bit ran past the end of the frame — shaka's RCHECK failure path.
class Ac4ParseError extends Error {}

class Ac4TocParser {
	private readonly bitstream: Bitstream;
	private bitstreamVersion = 0;
	private frameRateIndex = 0;
	private fsIndex = 0;
	private maxGroupIndex = 0;

	constructor(frame: Uint8Array) {
		this.bitstream = new Bitstream(frame);
	}

	parse(): number {
		const start = this.bitstream.pos;
		this.parseToc();
		return this.bitstream.pos - start;
	}

	/** @internal */
	private readBits(n: number): number {
		if (this.bitstream.getBitsLeft() < n) {
			throw new Ac4ParseError();
		}
		return this.bitstream.readBits(n);
	}

	/** Skip a fixed number of bits, mirroring a checked `ReadBits` run (advances regardless of alignment). */
	private skipBitsChecked(bits: number): void {
		if (this.bitstream.getBitsLeft() < bits) {
			throw new Ac4ParseError();
		}
		this.bitstream.skipBits(bits);
	}

	// shaka's BitReader::SkipBytes only advances when byte-aligned with enough bytes left; otherwise it
	// is a silent no-op (its `false` return is unchecked at every AC-4 call site). Reproduce exactly —
	// a mid-byte SkipBytes leaves the position untouched, which the downstream parse then reads through.
	private skipBytesAligned(n: number): void {
		if (this.bitstream.pos % 8 !== 0) {
			return;
		}
		if (this.bitstream.getBitsLeft() < n * 8) {
			return;
		}
		this.bitstream.skipBits(n * 8);
	}

	/** ETSI TS 103 190-1 variable_bits: read `nBits` chunks while the continuation bit is set. */
	private readVariableBits(nBits: number): number {
		let value = 0;
		let moreBits = 0;
		do {
			value += this.readBits(nBits);
			moreBits = this.readBits(1);
			if (moreBits === 1) {
				value <<= nBits;
				value += (1 << nBits);
			}
		} while (moreBits === 1);
		return value;
	}

	private parseToc(): void {
		this.bitstreamVersion = this.readBits(2);
		if (this.bitstreamVersion === 3) {
			this.bitstreamVersion = this.readVariableBits(2);
		}
		this.readBits(10); // sequence_counter
		const bWaitFrames = this.readBits(1);
		if (bWaitFrames) {
			const waitFrames = this.readBits(3);
			if (waitFrames > 0) {
				this.readBits(2); // br_code
			}
		}
		this.fsIndex = this.readBits(1);
		this.frameRateIndex = this.readBits(4);
		this.readBits(1); // b_iframe_global

		let nPresentations = 0;
		const bSinglePresentation = this.readBits(1);
		if (bSinglePresentation) {
			nPresentations = 1;
		} else {
			const bMorePresentations = this.readBits(1);
			if (bMorePresentations) {
				nPresentations = this.readVariableBits(2) + 2;
			}
		}

		const bPayloadBase = this.readBits(1);
		if (bPayloadBase) {
			const payloadBase = this.readBits(5) + 1;
			if (payloadBase === 0x20) {
				this.readVariableBits(3);
			}
		}

		if (this.bitstreamVersion > 1) {
			const bProgramId = this.readBits(1);
			if (bProgramId) {
				this.readBits(16); // short_program_id
				const bProgramUuidPresent = this.readBits(1);
				if (bProgramUuidPresent) {
					this.skipBitsChecked(128); // program_uuid: 16 × ReadBits(8)
				}
			}
			for (let i = 0; i < nPresentations; i++) {
				this.parsePresentationV1Info();
			}
			const totalSubstreamGroups = this.maxGroupIndex + 1;
			for (let j = 0; j < totalSubstreamGroups; j++) {
				this.parseSubstreamGroupInfo();
			}
		}

		// ETSI TS 103 190-1 substream_size table.
		let nSubstreams = this.readBits(2);
		if (nSubstreams === 0) {
			nSubstreams = this.readVariableBits(2) + 4;
		}
		const bSizePresent = nSubstreams === 1 ? this.readBits(1) : 1;
		if (bSizePresent) {
			for (let s = 0; s < nSubstreams; s++) {
				const bMoreBits = this.readBits(1);
				this.readBits(10); // substream_size
				if (bMoreBits) {
					this.readVariableBits(2);
				}
			}
		}
	}

	private parsePresentationV1Info(): void {
		let presentationConfig = 0;
		let bAddEmdfSubstreams = 0;
		const bSingleSubstreamGroup = this.readBits(1);
		if (bSingleSubstreamGroup !== 1) {
			presentationConfig = this.readBits(3);
			if (presentationConfig === 7) {
				presentationConfig = this.readVariableBits(2);
			}
		}
		if (this.bitstreamVersion !== 1) {
			// presentation_version(): unary count of set bits.
			while (this.readBits(1)) {
				// count only — value is dead for bit-consumption
			}
		}
		if (bSingleSubstreamGroup !== 1 && presentationConfig === 6) {
			bAddEmdfSubstreams = 1;
		} else {
			if (this.bitstreamVersion !== 1) {
				this.readBits(3); // mdcompat
			}
			const bPresentationId = this.readBits(1);
			if (bPresentationId) {
				this.readVariableBits(2);
			}
			this.parseFrameRateMultiplyInfo();
			this.parseFrameRateFractionsInfo();
			this.parseEmdfInfo();

			const bPresentationFilter = this.readBits(1);
			if (bPresentationFilter) {
				this.readBits(1); // b_enable_presentation
			}
			if (bSingleSubstreamGroup === 1) {
				this.markGroupIndex(this.parseSgiSpecifier());
			} else {
				this.readBits(1); // b_multi_pid
				this.parsePresentationConfig(presentationConfig);
			}
			this.readBits(1); // b_pre_virtualized
			bAddEmdfSubstreams = this.readBits(1);
			this.parsePresentationSubstreamInfo();
		}
		if (bAddEmdfSubstreams) {
			let nAddEmdfSubstreams = this.readBits(2);
			if (nAddEmdfSubstreams === 0) {
				nAddEmdfSubstreams = this.readVariableBits(2) + 4;
			}
			for (let i = 0; i < nAddEmdfSubstreams; i++) {
				this.parseEmdfInfo();
			}
		}
	}

	private parsePresentationConfig(presentationConfig: number): void {
		// Each config reads a fixed set of ac4_sgi_specifier()s (their count varies), then bookkeeps
		// the highest group index. Config 5 reads an explicit count; the default reads an ext block.
		const specifierCounts: Record<number, number> = { 0: 2, 1: 2, 2: 2, 3: 3, 4: 3 };
		const count = specifierCounts[presentationConfig];
		if (count !== undefined) {
			for (let i = 0; i < count; i++) {
				this.markGroupIndex(this.parseSgiSpecifier());
			}
			return;
		}
		if (presentationConfig === 5) {
			let nSubstreamGroups = this.readBits(2) + 2;
			if (nSubstreamGroups === 5) {
				nSubstreamGroups += this.readVariableBits(2);
			}
			for (let sg = 0; sg < nSubstreamGroups; sg++) {
				this.markGroupIndex(this.parseSgiSpecifier());
			}
			return;
		}
		this.parsePresentationConfigExtInfo();
	}

	private markGroupIndex(groupIndex: number): void {
		if (groupIndex > this.maxGroupIndex) {
			this.maxGroupIndex = groupIndex;
		}
	}

	private parseFrameRateMultiplyInfo(): void {
		switch (this.frameRateIndex) {
			case 2:
			case 3:
			case 4: {
				const bMultiplier = this.readBits(1);
				if (bMultiplier) {
					this.readBits(1); // multiplier_bit
				}
				break;
			}
			case 0:
			case 1:
			case 7:
			case 8:
			case 9: {
				this.readBits(1); // b_multiplier
				break;
			}
			default:
				break;
		}
	}

	private parseFrameRateFractionsInfo(): void {
		if (this.frameRateIndex >= 5 && this.frameRateIndex <= 9) {
			this.readBits(1); // b_frame_rate_fraction
		}
		if (this.frameRateIndex >= 10 && this.frameRateIndex <= 12) {
			const bFrameRateFraction = this.readBits(1);
			if (bFrameRateFraction === 1) {
				this.readBits(1); // b_frame_rate_fraction_is_4
			}
		}
	}

	private parseEmdfInfo(): void {
		const emdfVersion = this.readBits(2);
		if (emdfVersion === 3) {
			this.readVariableBits(2);
		}
		const keyId = this.readBits(3);
		if (keyId === 7) {
			this.readVariableBits(3);
		}
		const bEmdfPayloadsSubstreamInfo = this.readBits(1);
		if (bEmdfPayloadsSubstreamInfo) {
			const substreamIndex = this.readBits(2);
			if (substreamIndex === 3) {
				this.readVariableBits(2);
			}
		}
		const protectionLengthPrimary = this.readBits(2);
		const protectionLengthSecondary = this.readBits(2);
		this.skipProtectionBits(protectionLengthPrimary, false);
		this.skipProtectionBits(protectionLengthSecondary, true);
	}

	private skipProtectionBits(protectionLength: number, secondary: boolean): void {
		switch (protectionLength) {
			case 0:
				if (!secondary) {
					throw new Ac4ParseError(); // primary length 0 is invalid
				}
				break;
			case 1:
				this.readBits(8);
				break;
			case 2:
				this.skipBitsChecked(32); // 4 × ReadBits(8)
				break;
			case 3:
				this.skipBitsChecked(128); // 16 × ReadBits(8)
				break;
			default:
				throw new Ac4ParseError();
		}
	}

	private parsePresentationSubstreamInfo(): void {
		this.readBits(1); // b_alternative
		this.readBits(1); // b_pres_ndot
		const substreamIndex = this.readBits(2);
		if (substreamIndex === 3) {
			this.readVariableBits(2);
		}
	}

	private parseSgiSpecifier(): number {
		if (this.bitstreamVersion === 1) {
			return 0; // ac4_substream_group_info() — not reached for the versions we handle
		}
		let groupIndex = this.readBits(3);
		if (groupIndex === 7) {
			groupIndex += this.readVariableBits(2);
		}
		return groupIndex;
	}

	private parsePresentationConfigExtInfo(): void {
		let nSkipBytes = this.readBits(1);
		const bMoreSkipBytes = this.readBits(1);
		if (bMoreSkipBytes) {
			nSkipBytes += this.readVariableBits(2) << 5;
		}
		for (let i = 0; i < nSkipBytes; i++) {
			this.skipBytesAligned(8);
		}
	}

	private parseSubstreamGroupInfo(): void {
		const bSubstreamsPresent = this.readBits(1);
		const bHsfExt = this.readBits(1);
		const bSingleSubstream = this.readBits(1);
		let nLfSubstreams = 1;
		if (!bSingleSubstream) {
			nLfSubstreams = this.readBits(2) + 2;
			if (nLfSubstreams === 5) {
				nLfSubstreams += this.readVariableBits(2);
			}
		}
		const bChannelCoded = this.readBits(1);
		// frame_rate_factor is invariably 1: shaka never assigns dsi_frame_rate_multiply_info.
		const frameRateFactor = 1;
		if (bChannelCoded) {
			for (let sus = 0; sus < nLfSubstreams; sus++) {
				this.parseSubstreamInfoChan(frameRateFactor, bSubstreamsPresent);
				if (bHsfExt) {
					this.parseHsfExtSubstreamInfo(bSubstreamsPresent);
				}
			}
		} else {
			const bOamdSubstream = this.readBits(1);
			if (bOamdSubstream) {
				this.parseOamdSubstreamInfo(bSubstreamsPresent);
			}
			for (let sus = 0; sus < nLfSubstreams; sus++) {
				const bAjoc = this.readBits(1);
				if (bAjoc) {
					this.parseSubstreamInfoAjoc(frameRateFactor, bSubstreamsPresent);
				} else {
					this.parseSubstreamInfoObj(frameRateFactor, bSubstreamsPresent);
				}
				if (bHsfExt) {
					this.parseHsfExtSubstreamInfo(bSubstreamsPresent);
				}
			}
		}
		const bContentType = this.readBits(1);
		if (bContentType) {
			this.parseContentType();
		}
	}

	private parseContentType(): void {
		this.readBits(3); // content_classifier
		const bLanguageIndicator = this.readBits(1);
		if (bLanguageIndicator) {
			const bSerializedLanguageTag = this.readBits(1);
			if (bSerializedLanguageTag) {
				this.readBits(1); // b_start_tag
				this.readBits(16); // language_tag_chunk
			} else {
				const nLanguageTagBytes = this.readBits(6);
				for (let i = 0; i < nLanguageTagBytes; i++) {
					this.readBits(8);
				}
			}
		}
	}

	private parseOamdSubstreamInfo(bSubstreamsPresent: number): void {
		this.readBits(1); // b_oamd_ndot
		if (bSubstreamsPresent === 1) {
			const substreamIndex = this.readBits(2);
			if (substreamIndex === 3) {
				this.readVariableBits(2);
			}
		}
	}

	private parseHsfExtSubstreamInfo(bSubstreamsPresent: number): void {
		if (bSubstreamsPresent === 1) {
			const substreamIndex = this.readBits(2);
			if (substreamIndex === 3) {
				this.readVariableBits(2);
			}
		}
	}

	private parseSubstreamInfoChan(frameRateFactor: number, bSubstreamsPresent: number): void {
		let channelMode = this.parseChannelMode();
		if (channelMode === CH_MODE_ESCAPE) {
			channelMode += this.readVariableBits(2);
		}
		if (channelMode >= CH_MODE_7_0_4 && channelMode <= CH_MODE_9_1_4) {
			this.readBits(1); // b_4_back_channels_present
			this.readBits(1); // b_centre_present
			this.readBits(2); // top_channels_present
		}
		if (this.fsIndex === 1) {
			const bSfMultiplier = this.readBits(1);
			if (bSfMultiplier) {
				this.readBits(1); // sf_multiplier
			}
		}
		this.readBitrateInfo();
		if (channelMode >= CH_MODE_70_52 && channelMode <= CH_MODE_71_322) {
			this.readBits(1); // add_ch_base
		}
		for (let i = 0; i < frameRateFactor; i++) {
			this.readBits(1); // b_audio_ndot
		}
		this.readSubstreamIndex(bSubstreamsPresent);
	}

	private parseSubstreamInfoAjoc(frameRateFactor: number, bSubstreamsPresent: number): void {
		this.readBits(1); // b_lfe
		const bStaticDmx = this.readBits(1);
		let nFullbandDmxSignals = 5;
		if (!bStaticDmx) {
			nFullbandDmxSignals = this.readBits(4) + 1;
			this.parseBedDynObjAssignment(nFullbandDmxSignals);
		}
		const bOamdCommonDataPresent = this.readBits(1);
		if (bOamdCommonDataPresent) {
			this.parseOamdCommonData();
		}
		let nFullbandUpmixSignalsMinus1 = this.readBits(4);
		if (nFullbandUpmixSignalsMinus1 + 1 === 16) {
			nFullbandUpmixSignalsMinus1 += this.readVariableBits(3);
		}
		this.parseBedDynObjAssignment(nFullbandUpmixSignalsMinus1 + 1);
		if (this.fsIndex === 1) {
			const bSfMultiplier = this.readBits(1);
			if (bSfMultiplier) {
				this.readBits(1); // sf_multiplier
			}
		}
		this.readBitrateInfo();
		for (let i = 0; i < frameRateFactor; i++) {
			this.readBits(1); // b_audio_ndot
		}
		this.readSubstreamIndex(bSubstreamsPresent);
	}

	private parseBedDynObjAssignment(nSignals: number): void {
		const bDynObjectsOnly = this.readBits(1);
		if (bDynObjectsOnly !== 0) {
			return;
		}
		const bIsf = this.readBits(1);
		if (bIsf) {
			this.readBits(3); // isf_config
			return;
		}
		const bChAssignCode = this.readBits(1);
		if (bChAssignCode) {
			this.readBits(3); // bed_chan_assign_code
			return;
		}
		const bChanAssignMask = this.readBits(1);
		if (bChanAssignMask) {
			const bNonstd = this.readBits(1);
			if (bNonstd) {
				this.readBits(17); // nonstd_bed_channel_assignment_mask
			} else {
				this.readBits(10); // std_bed_channel_assignment_mask
			}
			return;
		}
		let nBedSignals = 1;
		if (nSignals > 1) {
			const bedChBits = Math.ceil(Math.log2(nSignals));
			nBedSignals = this.readBits(bedChBits) + 1;
		}
		for (let b = 0; b < nBedSignals; b++) {
			this.readBits(4); // nonstd_bed_channel_assignment
		}
	}

	private parseOamdCommonData(): void {
		const bDefaultScreenSizeRatio = this.readBits(1);
		if (bDefaultScreenSizeRatio === 0) {
			this.readBits(5); // master_screen_size_ratio_code
		}
		this.readBits(1); // b_bed_object_chan_distribute
		const bAdditionalData = this.readBits(1);
		if (bAdditionalData) {
			let addDataBytes = this.readBits(1) + 1;
			if (addDataBytes === 2) {
				addDataBytes += this.readVariableBits(2);
			}
			this.skipBytesAligned(addDataBytes);
		}
	}

	private parseSubstreamInfoObj(frameRateFactor: number, bSubstreamsPresent: number): void {
		this.readBits(3); // n_objects_code
		const bDynamicObjects = this.readBits(1);
		if (bDynamicObjects) {
			this.readBits(1); // b_lfe
		} else {
			const bBedObjects = this.readBits(1);
			if (bBedObjects) {
				const bBedStart = this.readBits(1);
				if (bBedStart) {
					const bChAssignCode = this.readBits(1);
					if (bChAssignCode) {
						this.readBits(3); // bed_chan_assign_code
					} else {
						const bNonstd = this.readBits(1);
						if (bNonstd) {
							this.readBits(17); // nonstd_bed_channel_assignment_mask
						} else {
							this.readBits(10); // std_bed_channel_assignment_mask
						}
					}
				}
			} else {
				const bIsf = this.readBits(1);
				if (bIsf) {
					const bIsfStart = this.readBits(1);
					if (bIsfStart) {
						this.readBits(1); // isf_config
					}
				} else {
					const resBytes = this.readBits(4);
					this.bitstream.skipBits(resBytes * 8);
				}
			}
		}
		if (this.fsIndex === 1) {
			const bSfMultiplier = this.readBits(1);
			if (bSfMultiplier) {
				this.readBits(1); // sf_multiplier
			}
		}
		this.readBitrateInfo();
		for (let i = 0; i < frameRateFactor; i++) {
			this.readBits(1); // b_audio_ndot
		}
		this.readSubstreamIndex(bSubstreamsPresent);
	}

	private readBitrateInfo(): void {
		const bBitrateInfo = this.readBits(1);
		if (bBitrateInfo) {
			const bitrateIndicator = this.readBits(3);
			if ((bitrateIndicator & 0x1) === 1) {
				this.readBits(2); // extends bitrate_indicator
			}
		}
	}

	private readSubstreamIndex(bSubstreamsPresent: number): void {
		if (bSubstreamsPresent === 1) {
			const substreamIndex = this.readBits(2);
			if (substreamIndex === 3) {
				this.readVariableBits(2);
			}
		}
	}

	/** ac4_presentation channel_mode(): a variable-length prefix code (TS 103 190-2 table 78). */
	private parseChannelMode(): number {
		let code = this.readBits(1);
		if (code === 0) {
			return CH_MODE_MONO;
		}
		code = (code << 1) | this.readBits(1);
		if (code === 2) {
			return CH_MODE_STEREO;
		}
		code = (code << 2) | this.readBits(2);
		switch (code) {
			case 12: return CH_MODE_3_0;
			case 13: return CH_MODE_5_0;
			case 14: return CH_MODE_5_1;
			default: break;
		}
		code = (code << 3) | this.readBits(3);
		switch (code) {
			case 120: return CH_MODE_70_34;
			case 121: return CH_MODE_71_34;
			case 122: return CH_MODE_70_52;
			case 123: return CH_MODE_71_52;
			case 124: return CH_MODE_70_322;
			case 125: return CH_MODE_71_322;
			default: break;
		}
		code = (code << 1) | this.readBits(1);
		switch (code) {
			case 252: return CH_MODE_7_0_4;
			case 253: return CH_MODE_7_1_4;
			default: break;
		}
		code = (code << 1) | this.readBits(1);
		switch (code) {
			case 508: return CH_MODE_9_0_4;
			case 509: return CH_MODE_9_1_4;
			case 510: return CH_MODE_22_2;
			default:
				this.readVariableBits(2);
				return CH_MODE_RESERVED;
		}
	}
}
