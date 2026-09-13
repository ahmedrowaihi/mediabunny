/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	buildSeiNalUnit,
	iterateSeiMessages,
	iterateSeiNalUnits,
	type SeiCodec,
	type SeiMessage,
} from './sei';

// SEI payload types carrying HDR10 static metadata, identically numbered and laid out in
// ITU-T H.265 Table D.1 and ITU-T H.264 Table D-1.
const MASTERING_DISPLAY_SEI = 137;
const CONTENT_LIGHT_SEI = 144;

/**
 * HDR10 mastering display metadata (SMPTE ST 2086). Chromaticities are in units of 0.00002; the
 * three display primaries are in G, B, R order; luminances are in units of 0.0001 cd/m². Carried
 * identically in the HEVC mastering-display SEI and the ISOBMFF `mdcv` box.
 *
 * @group Codecs
 * @public
 */
export type MasteringDisplayMetadata = {
	/** Display primaries [G, B, R], each `[x, y]` in units of 0.00002. */
	displayPrimaries: [[number, number], [number, number], [number, number]];
	/** White point `[x, y]` in units of 0.00002. */
	whitePoint: [number, number];
	/** Maximum display mastering luminance, in units of 0.0001 cd/m². */
	maxDisplayMasteringLuminance: number;
	/** Minimum display mastering luminance, in units of 0.0001 cd/m². */
	minDisplayMasteringLuminance: number;
};

/**
 * HDR10 content light level (CTA-861.3). Carried in the HEVC content-light SEI and the `clli` box.
 *
 * @group Codecs
 * @public
 */
export type ContentLightLevel = {
	/** Maximum content light level (MaxCLL), in cd/m². */
	maxContentLightLevel: number;
	/** Maximum picture-average light level (MaxFALL), in cd/m². */
	maxPicAverageLightLevel: number;
};

/**
 * HDR10 static metadata carried in a temporal unit's SEI / an init segment's boxes.
 *
 * @group Codecs
 * @public
 */
export type HdrStaticMetadata = {
	/** Mastering-display colour volume (SMPTE ST 2086), from the `mdcv` box / SEI 137. */
	masteringDisplay?: MasteringDisplayMetadata;
	/** Content light level (CTA-861.3), from the `clli` box / SEI 144. */
	contentLight?: ContentLightLevel;
};

/**
 * A [video decoder config](https://www.w3.org/TR/webcodecs/#video-decoder-config) that may additionally carry the
 * HDR10 static metadata stored next to it in the container. WebCodecs has no field for it, so it travels alongside the
 * config: the ISOBMFF demuxer fills it in from the `mdcv` / `clli` boxes, and the ISOBMFF muxer writes those boxes
 * back out from it.
 *
 * @group Codecs
 * @public
 */
export type VideoDecoderConfigWithHdr = VideoDecoderConfig & {
	/** The track's HDR10 static metadata, absent when the track carries none. */
	hdrStaticMetadata?: HdrStaticMetadata;
};

const readU16 = (data: Uint8Array, offset: number): number => (data[offset]! << 8) | data[offset + 1]!;
const readU32 = (data: Uint8Array, offset: number): number =>
	data[offset]! * 2 ** 24 + data[offset + 1]! * 2 ** 16 + data[offset + 2]! * 2 ** 8 + data[offset + 3]!;

/**
 * Parse the 24-byte mastering-display payload (the SEI payload body, identical to the `mdcv` box
 * payload), or `null` if too short.
 *
 * @group Codecs
 * @public
 */
export const parseMasteringDisplayMetadata = (payload: Uint8Array): MasteringDisplayMetadata | null => {
	if (payload.length < 24) {
		return null;
	}
	return {
		displayPrimaries: [
			[readU16(payload, 0), readU16(payload, 2)],
			[readU16(payload, 4), readU16(payload, 6)],
			[readU16(payload, 8), readU16(payload, 10)],
		],
		whitePoint: [readU16(payload, 12), readU16(payload, 14)],
		maxDisplayMasteringLuminance: readU32(payload, 16),
		minDisplayMasteringLuminance: readU32(payload, 20),
	};
};

/** Serialize mastering-display metadata to its 24-byte payload (SEI body / `mdcv` box body). @internal */
export const buildMasteringDisplayPayload = (metadata: MasteringDisplayMetadata): Uint8Array => {
	const out = new Uint8Array(24);
	const view = new DataView(out.buffer);
	for (let i = 0; i < 3; i++) {
		view.setUint16(i * 4, metadata.displayPrimaries[i]![0]);
		view.setUint16(i * 4 + 2, metadata.displayPrimaries[i]![1]);
	}
	view.setUint16(12, metadata.whitePoint[0]);
	view.setUint16(14, metadata.whitePoint[1]);
	view.setUint32(16, metadata.maxDisplayMasteringLuminance);
	view.setUint32(20, metadata.minDisplayMasteringLuminance);
	return out;
};

/**
 * Parse the 4-byte content-light payload (SEI body / `clli` box body), or `null` if too short.
 *
 * @group Codecs
 * @public
 */
export const parseContentLightLevel = (payload: Uint8Array): ContentLightLevel | null => {
	if (payload.length < 4) {
		return null;
	}
	return { maxContentLightLevel: readU16(payload, 0), maxPicAverageLightLevel: readU16(payload, 2) };
};

/** Serialize content-light metadata to its 4-byte payload (SEI body / `clli` box body). @internal */
export const buildContentLightPayload = (contentLight: ContentLightLevel): Uint8Array => {
	const out = new Uint8Array(4);
	const view = new DataView(out.buffer);
	view.setUint16(0, contentLight.maxContentLightLevel);
	view.setUint16(2, contentLight.maxPicAverageLightLevel);
	return out;
};

const collectHdrSeiMessages = (messages: Iterable<SeiMessage>): HdrStaticMetadata => {
	const result: HdrStaticMetadata = {};

	for (const { payloadType, payload } of messages) {
		if (payloadType === MASTERING_DISPLAY_SEI) {
			const md = parseMasteringDisplayMetadata(payload);
			if (md !== null) {
				result.masteringDisplay = md;
			}
		} else if (payloadType === CONTENT_LIGHT_SEI) {
			const cll = parseContentLightLevel(payload);
			if (cll !== null) {
				result.contentLight = cll;
			}
		}
	}

	return result;
};

/**
 * Extract HDR10 static metadata from one HEVC SEI NAL unit (including its 2-byte NAL header). Removes
 * emulation-prevention bytes, then walks the SEI messages for the mastering-display (137) and
 * content-light (144) payload types.
 *
 * @group Codecs
 * @public
 */
export const parseHevcSeiHdrMetadata = (seiNalUnit: Uint8Array): HdrStaticMetadata =>
	collectHdrSeiMessages(iterateSeiMessages(seiNalUnit, 'hevc'));

/**
 * Extract HDR10 static metadata from one AVC SEI NAL unit (including its 1-byte NAL header). Removes
 * emulation-prevention bytes, then walks the SEI messages for the mastering-display (137) and
 * content-light (144) payload types.
 *
 * @group Codecs
 * @public
 */
export const parseAvcSeiHdrMetadata = (seiNalUnit: Uint8Array): HdrStaticMetadata =>
	collectHdrSeiMessages(iterateSeiMessages(seiNalUnit, 'avc'));

const extractSeiHdrMetadata = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): HdrStaticMetadata => {
	const result: HdrStaticMetadata = {};

	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, codec)) {
		const fromNalUnit = collectHdrSeiMessages(iterateSeiMessages(nalUnit, codec));
		if (fromNalUnit.masteringDisplay && !result.masteringDisplay) {
			result.masteringDisplay = fromNalUnit.masteringDisplay;
		}
		if (fromNalUnit.contentLight && !result.contentLight) {
			result.contentLight = fromNalUnit.contentLight;
		}
	}

	return result;
};

/**
 * Walk one HEVC access unit's NAL units and collect the HDR10 static metadata from its SEI NAL units. The decoder
 * config is only read for its `description`, which says whether the NAL units are length-prefixed or Annex B.
 *
 * @internal
 */
export const extractHevcSeiHdrMetadata = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
): HdrStaticMetadata => extractSeiHdrMetadata(packetData, decoderConfig, 'hevc');

/**
 * Walk one AVC access unit's NAL units and collect the HDR10 static metadata from its SEI NAL units. The decoder
 * config is only read for its `description`, which says whether the NAL units are length-prefixed or Annex B.
 *
 * @internal
 */
export const extractAvcSeiHdrMetadata = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
): HdrStaticMetadata => extractSeiHdrMetadata(packetData, decoderConfig, 'avc');

const buildSeiHdrNalUnit = (metadata: HdrStaticMetadata, codec: SeiCodec): Uint8Array | null => {
	const messages: SeiMessage[] = [];

	if (metadata.masteringDisplay) {
		messages.push({
			payloadType: MASTERING_DISPLAY_SEI,
			payload: buildMasteringDisplayPayload(metadata.masteringDisplay),
		});
	}
	if (metadata.contentLight) {
		messages.push({
			payloadType: CONTENT_LIGHT_SEI,
			payload: buildContentLightPayload(metadata.contentLight),
		});
	}

	return buildSeiNalUnit(messages, codec);
};

/**
 * Build the HEVC prefix SEI NAL unit (including its 2-byte NAL header, emulation-prevented) carrying the
 * HDR10 static metadata as SEI 137 / 144, or `null` when there is nothing to carry. Inverse of
 * {@link parseHevcSeiHdrMetadata}.
 *
 * @internal
 */
export const buildHevcSeiHdrNalUnit = (metadata: HdrStaticMetadata): Uint8Array | null =>
	buildSeiHdrNalUnit(metadata, 'hevc');

/**
 * Build the AVC SEI NAL unit (including its 1-byte NAL header, emulation-prevented) carrying the HDR10
 * static metadata as SEI 137 / 144, or `null` when there is nothing to carry. Inverse of
 * {@link parseAvcSeiHdrMetadata}.
 *
 * @internal
 */
export const buildAvcSeiHdrNalUnit = (metadata: HdrStaticMetadata): Uint8Array | null =>
	buildSeiHdrNalUnit(metadata, 'avc');

const isobmffBox = (type: string, payload: Uint8Array): Uint8Array => {
	const out = new Uint8Array(8 + payload.length);
	new DataView(out.buffer).setUint32(0, out.length);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(payload, 8);
	return out;
};

/**
 * Build the ISOBMFF `mdcv` (Mastering Display Colour Volume) box for HDR10 signaling.
 *
 * @group Codecs
 * @public
 */
export const buildMdcvBox = (metadata: MasteringDisplayMetadata): Uint8Array =>
	isobmffBox('mdcv', buildMasteringDisplayPayload(metadata));

/**
 * Build the ISOBMFF `clli` (Content Light Level) box for HDR10 signaling.
 *
 * @group Codecs
 * @public
 */
export const buildClliBox = (contentLight: ContentLightLevel): Uint8Array =>
	isobmffBox('clli', buildContentLightPayload(contentLight));
