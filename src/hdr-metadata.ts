/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { removeEmulationPreventionBytes } from './codec-data';

// HEVC SEI payload types (ITU-T H.265 Table D.1) carrying HDR10 static metadata.
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

/**
 * Extract HDR10 static metadata from one HEVC SEI NAL unit (including its 2-byte NAL header). Removes
 * emulation-prevention bytes, then walks the SEI messages for the mastering-display (137) and
 * content-light (144) payload types.
 *
 * @group Codecs
 * @public
 */
export const parseHevcSeiHdrMetadata = (seiNalUnit: Uint8Array): HdrStaticMetadata => {
	const rbsp = removeEmulationPreventionBytes(seiNalUnit.subarray(2)); // drop the 2-byte NAL header
	const result: HdrStaticMetadata = {};
	let pos = 0;
	while (pos < rbsp.length && rbsp[pos] !== 0x80) { // 0x80 = rbsp_trailing_bits
		let payloadType = 0;
		while (rbsp[pos] === 0xff) {
			payloadType += 255;
			pos++;
		}
		payloadType += rbsp[pos++]!;
		let payloadSize = 0;
		while (rbsp[pos] === 0xff) {
			payloadSize += 255;
			pos++;
		}
		payloadSize += rbsp[pos++]!;
		const payload = rbsp.subarray(pos, pos + payloadSize);
		pos += payloadSize;
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
