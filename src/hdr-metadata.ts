/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { iterateAv1PacketObus } from './codec-data';
import type { DoviConfig } from './dovi';
import {
	buildSeiNalUnit,
	iterateSeiMessages,
	iterateSeiNalUnits,
	type SeiCodec,
	type SeiMessage,
	USER_DATA_REGISTERED_ITU_T_T35,
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
	/** The track's Dolby Vision configuration record, absent when the track carries none. */
	dolbyVision?: DoviConfig;
	/**
	 * Bits per coded sample, as an ISO BMFF video sample entry's depth field states it. It is the only
	 * thing distinguishing QuickTime RLE or PNG with an alpha channel (32) from the same codec without
	 * one (24), and those decoders take the pixel format from it rather than from the bitstream.
	 */
	bitsPerCodedSample?: number;
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

/** @internal */
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

/** @internal */
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
 * Extract HDR10 static metadata from one SEI NAL unit, including its NAL header - 2 bytes for HEVC,
 * 1 for AVC. Removes emulation-prevention bytes, then walks the SEI messages for the
 * mastering-display (137) and content-light (144) payload types.
 *
 * @group Codecs
 * @public
 */
export const parseSeiHdrMetadata = (seiNalUnit: Uint8Array, codec: SeiCodec): HdrStaticMetadata =>
	collectHdrSeiMessages(iterateSeiMessages(seiNalUnit, codec));

/** @internal */
export const extractSeiHdrMetadata = (
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

/** @internal */
export const buildSeiHdrNalUnit = (metadata: HdrStaticMetadata, codec: SeiCodec): Uint8Array | null => {
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

// SMPTE ST 2094-40 §5.2: country 0xB5, provider 0x003C, oriented code 0x0001, application identifier 4.
// Captions ride the same SEI with the same country code, so the provider is what separates them.
const HDR10_PLUS_PAYLOAD_HEADER = [0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04];

const isHdr10PlusPayload = (payload: Uint8Array) =>
	payload.length >= HDR10_PLUS_PAYLOAD_HEADER.length
	&& HDR10_PLUS_PAYLOAD_HEADER.every((byte, i) => payload[i] === byte);

/**
 * The HDR10+ T.35 payload a packet's SEI carries, or null for none. Returned whole, header included,
 * which is what an encoder writes back.
 *
 * @internal
 */
export const extractHdr10PlusPayload = (
	packetData: Uint8Array,
	decoderConfig: VideoDecoderConfig,
	codec: SeiCodec,
): Uint8Array | null => {
	for (const nalUnit of iterateSeiNalUnits(packetData, decoderConfig, codec)) {
		for (const { payloadType, payload } of iterateSeiMessages(nalUnit, codec)) {
			if (payloadType === USER_DATA_REGISTERED_ITU_T_T35 && isHdr10PlusPayload(payload)) {
				return payload;
			}
		}
	}

	return null;
};

/** @internal */
export const buildHdr10PlusSeiNalUnit = (payload: Uint8Array, codec: SeiCodec): Uint8Array | null =>
	buildSeiNalUnit([{ payloadType: USER_DATA_REGISTERED_ITU_T_T35, payload }], codec);

// AV1 carries the same T.35 payload in a metadata OBU instead of an SEI. 5.8.1: the payload is preceded
// by a leb128 `metadata_type` and followed by `trailing_one_bit`, which is the byte 0x80 because the
// payload is byte-aligned. That byte is framing, so it is stripped on read and written back on build -
// what `hdr10Plus` holds is the same payload either codec carries.
const OBU_TEMPORAL_DELIMITER = 2;
const OBU_METADATA = 5;
const METADATA_TYPE_ITUT_T35 = 4;
const OBU_TRAILING_BYTE = 0x80;

const readLeb128 = (bytes: Uint8Array, at: number): { value: number; at: number } | null => {
	let value = 0;

	for (let i = 0; i < 8; i++) {
		const byte = bytes[at + i];
		if (byte === undefined) {
			return null;
		}

		value |= (byte & 0x7f) << (i * 7);
		if (!(byte & 0x80)) {
			return { value, at: at + i + 1 };
		}
	}

	return null;
};

const writeLeb128 = (value: number): number[] => {
	const out: number[] = [];

	do {
		const byte = value & 0x7f;
		value >>>= 7;
		out.push(value ? byte | 0x80 : byte);
	} while (value);

	return out;
};

/**
 * The HDR10+ T.35 payload an AV1 packet's metadata OBUs carry, or null for none.
 *
 * @internal
 */
export const extractHdr10PlusFromAv1Packet = (packetData: Uint8Array): Uint8Array | null => {
	for (const obu of iterateAv1PacketObus(packetData)) {
		if (obu.type !== OBU_METADATA) {
			continue;
		}

		const metadataType = readLeb128(obu.data, 0);
		if (metadataType === null || metadataType.value !== METADATA_TYPE_ITUT_T35) {
			continue;
		}

		let payload = obu.data.subarray(metadataType.at);
		if (payload[payload.length - 1] === OBU_TRAILING_BYTE) {
			payload = payload.subarray(0, -1);
		}

		if (isHdr10PlusPayload(payload)) {
			return payload;
		}
	}

	return null;
};

/**
 * The AV1 packet with an HDR10+ metadata OBU added, placed after a leading temporal delimiter so it sits
 * inside the temporal unit it describes rather than ahead of it.
 *
 * @internal
 */
export const withHdr10PlusObu = (packetData: Uint8Array, payload: Uint8Array): Uint8Array => {
	const obuPayload = [...writeLeb128(METADATA_TYPE_ITUT_T35), ...payload, OBU_TRAILING_BYTE];
	const obu = Uint8Array.from([
		(OBU_METADATA << 3) | 0x02, // obu_has_size_field
		...writeLeb128(obuPayload.length),
		...obuPayload,
	]);

	let insertAt = 0;
	for (const first of iterateAv1PacketObus(packetData)) {
		if (first.type === OBU_TEMPORAL_DELIMITER) {
			insertAt = first.data.byteOffset - packetData.byteOffset + first.data.byteLength;
		}
		break;
	}

	const out = new Uint8Array(packetData.byteLength + obu.byteLength);
	out.set(packetData.subarray(0, insertAt), 0);
	out.set(obu, insertAt);
	out.set(packetData.subarray(insertAt), insertAt + obu.byteLength);

	return out;
};
