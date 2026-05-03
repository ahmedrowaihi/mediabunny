/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/mpd_utils.{h,cc}
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import type { ContentProtectionElement, Element } from './dash-content-protection';
import { fourCCToString } from './dash-fourcc';
import { languageToShortestForm } from './dash-language-utils';
import {
	containerTypeName,
	type MediaInfo,
	textTypeName,
} from './dash-media-info';
import type { XmlNode } from './dash-xml-node';

/**
 * `schemeIdUri` value used on `<ContentProtection>` for the default
 * Common-Encryption descriptor on ISO-BMFF assets.
 *
 * @group DASH
 * @public
 */
export const ENCRYPTED_MP4_SCHEME = 'urn:mpeg:dash:mp4protection:2011';

/**
 * Tag name of the Common-Encryption PSSH child element.
 *
 * @group DASH
 * @public
 */
export const PSSH_ELEMENT_NAME = 'cenc:pssh';

/**
 * Tag name of the PlayReady Object child element.
 *
 * @group DASH
 * @public
 */
export const MSPRO_ELEMENT_NAME = 'mspr:pro';

/**
 * ISO/IEC 23001-8 transfer characteristics value for the SMPTE ST 2084 (PQ)
 * curve. Used by Dolby Vision logic in {@link getAdaptationSetKey}.
 *
 * @group DASH
 * @public
 */
export const TRANSFER_FUNCTION_PQ = 16;

/**
 * ISO/IEC 23001-8 transfer characteristics value for the BBC/NHK Hybrid
 * Log-Gamma (HLG) curve.
 *
 * @group DASH
 * @public
 */
export const TRANSFER_FUNCTION_HLG = 18;

/** UUID of Marlin Adaptive Streaming. @internal */
const MARLIN_UUID = '5e629af5-38da-4063-8977-97ffbd9902d4';
/** UUID of FairPlay. @internal */
const FAIRPLAY_UUID = '94ce86fb-07ff-4f43-adb8-93d2fa968ca2';
/** UUID of PlayReady. @internal */
const PLAYREADY_UUID = '9a04f079-9840-4286-ab92-e65be0885f95';
/**
 * Recommended `value` attribute on PlayReady `<ContentProtection>` per
 * Microsoft's MPEG-DASH PlayReady spec.
 * @internal
 */
const CONTENT_PROTECTION_VALUE_MSPR_20 = 'MSPR 2.0';

/**
 * Returns `true` when `mediaInfo` carries any field that's only valid in
 * VOD profiles (init range, index range, or single-file media URL).
 * Mirrors shaka's `HasVODOnlyFields`.
 *
 * @group DASH
 * @public
 */
export const hasVodOnlyFields = (mediaInfo: MediaInfo): boolean => {
	return mediaInfo.initRange !== undefined
		|| mediaInfo.indexRange !== undefined
		|| mediaInfo.mediaFileUrl !== undefined;
};

/**
 * Returns `true` when `mediaInfo` carries any field that's only valid in
 * live profiles (init segment URL or segment template URL). Mirrors shaka's
 * `HasLiveOnlyFields`.
 *
 * @group DASH
 * @public
 */
export const hasLiveOnlyFields = (mediaInfo: MediaInfo): boolean => {
	return mediaInfo.initSegmentUrl !== undefined
		|| mediaInfo.segmentTemplateUrl !== undefined;
};

/**
 * Removes `value` and `schemeIdUri` from `additionalAttributes` when the
 * top-level fields with those names are non-empty. Mirrors shaka's
 * `RemoveDuplicateAttributes`.
 *
 * @group DASH
 * @public
 */
export const removeDuplicateAttributes = (cp: ContentProtectionElement): void => {
	if (cp.value.length > 0) {
		cp.additionalAttributes.delete('value');
	}
	if (cp.schemeIdUri.length > 0) {
		cp.additionalAttributes.delete('schemeIdUri');
	}
};

/**
 * Returns the `MediaInfo` language in BCP-47-compliant shortest form
 * (2-letter when an ISO 639-1 equivalent exists). Audio takes precedence
 * over text. Returns `''` for video tracks. Mirrors shaka's `GetLanguage`.
 *
 * @group DASH
 * @public
 */
export const getLanguage = (mediaInfo: MediaInfo): string => {
	let lang = '';
	if (mediaInfo.audioInfo) {
		lang = mediaInfo.audioInfo.language ?? '';
	} else if (mediaInfo.textInfo) {
		lang = mediaInfo.textInfo.language ?? '';
	}
	return languageToShortestForm(lang);
};

/**
 * Returns the codec string for the track (video, audio, or text). For WebM
 * video, applies the legacy `vp08` → `vp8` rewrite shaka does. For text in
 * MP4, rewrites `ttml` → `stpp`. For text in `text` containers, returns
 * empty since the codec would be redundant with the `text/*` MIME type.
 * Mirrors shaka's `GetCodecs`.
 *
 * @group DASH
 * @public
 */
export const getCodecs = (mediaInfo: MediaInfo): string => {
	checkOnlyOneTrack(mediaInfo);

	if (mediaInfo.videoInfo) {
		const codec = mediaInfo.videoInfo.codec ?? '';
		if (mediaInfo.containerType === 'webm') {
			const fourcc = codec.slice(0, 4);
			// Legacy rewrite for browsers expecting WebM VP8 string `vp8` instead
			// of the new `vp08.xx.xx.xx...` form. Shaka has a flag
			// `use_legacy_vp9_codec_string` that disables `vp09` → `vp9` (now
			// off by default). We follow the default behavior: only rewrite
			// `vp08` → `vp8`, leave `vp09` alone.
			if (fourcc === 'vp08') {
				return 'vp8';
			}
		}
		return codec;
	}

	if (mediaInfo.audioInfo) {
		return mediaInfo.audioInfo.codec ?? '';
	}

	if (mediaInfo.textInfo) {
		return textCodecString(mediaInfo);
	}

	return '';
};

/**
 * Returns `videoInfo.supplementalCodec` when set, otherwise empty. Mirrors
 * shaka's `GetSupplementalCodecs`.
 *
 * @group DASH
 * @public
 */
export const getSupplementalCodecs = (mediaInfo: MediaInfo): string => {
	checkOnlyOneTrack(mediaInfo);
	return mediaInfo.videoInfo?.supplementalCodec ?? '';
};

/**
 * Returns the FourCC string of `videoInfo.compatibleBrand` when set,
 * otherwise empty. Mirrors shaka's `GetSupplementalProfiles`.
 *
 * @group DASH
 * @public
 */
export const getSupplementalProfiles = (mediaInfo: MediaInfo): string => {
	checkOnlyOneTrack(mediaInfo);
	const brand = mediaInfo.videoInfo?.compatibleBrand;
	if (brand !== undefined) {
		return fourCCToString(brand);
	}
	return '';
};

/**
 * Returns the codec string with profile/level variants stripped. For
 * example, `'mp4a.40.2'` becomes `'mp4a'`. Used to allow `mp4a.40.2` and
 * `mp4a.40.5` to coexist within a single AdaptationSet. Mirrors shaka's
 * `GetBaseCodec`.
 *
 * @group DASH
 * @public
 */
export const getBaseCodec = (mediaInfo: MediaInfo): string => {
	let codec = '';
	if (mediaInfo.videoInfo) {
		codec = mediaInfo.videoInfo.codec ?? '';
	} else if (mediaInfo.audioInfo) {
		codec = mediaInfo.audioInfo.codec ?? '';
	} else if (mediaInfo.textInfo) {
		codec = mediaInfo.textInfo.codec ?? '';
	}
	const dot = codec.indexOf('.');
	if (dot !== -1) {
		codec = codec.slice(0, dot);
	}
	return codec;
};

/**
 * Builds the colon-separated key shaka uses to bucket representations into
 * AdaptationSets. Same media-type, container, codec, transfer-characteristics,
 * language, trick-play status, accessibility, and roles produce the same key.
 * Mirrors shaka's `GetAdaptationSetKey`.
 *
 * @param mediaInfo - the representation's media info
 * @param ignoreCodec - when `true`, codec / transfer characteristics are
 *                     omitted from the key (used when caller wants to merge
 *                     by language regardless of codec)
 *
 * @group DASH
 * @public
 */
export const getAdaptationSetKey = (mediaInfo: MediaInfo, ignoreCodec: boolean): string => {
	let key = '';

	if (mediaInfo.videoInfo) {
		key += 'video:';
	} else if (mediaInfo.audioInfo) {
		key += 'audio:';
	} else if (mediaInfo.textInfo) {
		key += `${textTypeName(mediaInfo.textInfo.type ?? 'unknown')}:`;
	} else {
		key += 'unknown:';
	}

	if (mediaInfo.dashLabel !== undefined) {
		key += `${mediaInfo.dashLabel}:`;
	}

	key += containerTypeName(mediaInfo.containerType ?? 'unknown');

	if (!ignoreCodec) {
		key += ':';
		key += getBaseCodec(mediaInfo);

		const baseCodec = getBaseCodec(mediaInfo);
		if (baseCodec.startsWith('dvh')) {
			// Dolby Vision (dvh1 / dvhe) is always PQ regardless of any
			// transfer_characteristics value reported in SPS VUI.
			key += `:${TRANSFER_FUNCTION_PQ}`;
		} else if (mediaInfo.videoInfo?.transferCharacteristics !== undefined) {
			key += `:${mediaInfo.videoInfo.transferCharacteristics}`;
		}
	}

	key += ':';
	key += getLanguage(mediaInfo);

	// Trick-play streams of the same source belong to the same AdaptationSet
	// regardless of their playback rate.
	if (mediaInfo.videoInfo?.playbackRate !== undefined) {
		key += ':trick_play';
	}

	if (mediaInfo.dashAccessibilities && mediaInfo.dashAccessibilities.length > 0) {
		key += ':accessibility_';
		for (const accessibility of mediaInfo.dashAccessibilities) {
			key += accessibility;
		}
	}

	if (mediaInfo.dashRoles && mediaInfo.dashRoles.length > 0) {
		key += ':roles_';
		for (const role of mediaInfo.dashRoles) {
			key += role;
		}
	}

	return key;
};

/**
 * Format a floating-point number for XML output: print with 6 decimals,
 * trim trailing zeros, drop the trailing decimal point if no fractional
 * digits remain. Mirrors shaka's `FloatToXmlString`.
 *
 * Examples: `1` → `'1'`, `1.5` → `'1.5'`, `1.234567` → `'1.234567'`,
 * `0.0000005` → `'0.000001'`.
 *
 * @group DASH
 * @public
 */
export const floatToXmlString = (number: number): string => {
	let formatted = number.toFixed(6);
	const decimalPos = formatted.indexOf('.');
	if (decimalPos !== -1) {
		let lastNonZero = formatted.length - 1;
		while (lastNonZero > decimalPos && formatted[lastNonZero] === '0') {
			lastNonZero--;
		}
		formatted = formatted.slice(0, lastNonZero + 1);
		if (formatted.endsWith('.')) {
			formatted = formatted.slice(0, -1);
		}
	}
	return formatted;
};

/**
 * Format a duration in seconds as an XML schema duration string
 * (e.g. `'PT12.345S'`). Sub-second precision matches {@link floatToXmlString}
 * (up to microsecond). Mirrors shaka's `SecondsToXmlDuration`.
 *
 * @group DASH
 * @public
 */
export const secondsToXmlDuration = (seconds: number): string => {
	return `PT${floatToXmlString(seconds)}S`;
};

/**
 * Reads the `duration` attribute from `node` and parses it as a float.
 * Returns the parsed value, or `null` when the attribute is missing or
 * cannot be parsed. Mirrors shaka's `GetDurationAttribute`.
 *
 * @group DASH
 * @public
 */
export const getDurationAttribute = (node: XmlNode): number | null => {
	const value = node.getAttribute('duration');
	if (value === undefined) {
		return null;
	}
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return parsed;
};

/**
 * Returns `true` when more than one of the three booleans is `true`.
 * Mirrors shaka's `MoreThanOneTrue`.
 *
 * @group DASH
 * @public
 */
export const moreThanOneTrue = (b1: boolean, b2: boolean, b3: boolean): boolean => {
	return (b1 && b2) || (b2 && b3) || (b3 && b1);
};

/**
 * Returns `true` when at least one of the three booleans is `true`.
 * Mirrors shaka's `AtLeastOneTrue`.
 *
 * @group DASH
 * @public
 */
export const atLeastOneTrue = (b1: boolean, b2: boolean, b3: boolean): boolean => {
	return b1 || b2 || b3;
};

/**
 * Returns `true` when exactly one of the three booleans is `true`.
 * Mirrors shaka's `OnlyOneTrue`.
 *
 * @group DASH
 * @public
 */
export const onlyOneTrue = (b1: boolean, b2: boolean, b3: boolean): boolean => {
	return !moreThanOneTrue(b1, b2, b3) && atLeastOneTrue(b1, b2, b3);
};

/**
 * Convert 16 raw bytes into the canonical 8-4-4-4-12 lowercase UUID string.
 * Mirrors shaka's `HexToUUID`. Returns `null` when input length is not 16.
 *
 * @group DASH
 * @public
 */
export const hexToUUID = (data: Uint8Array): string | null => {
	if (data.length !== 16) {
		return null;
	}
	let hex = '';
	for (let i = 0; i < 16; i++) {
		hex += data[i]!.toString(16).padStart(2, '0');
	}
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Update the `<cenc:pssh>` element on the `<ContentProtection>` for
 * `drmUuid`. If the ContentProtection element does not exist, this adds an
 * empty one. If the element already has a `<cenc:pssh>`, the existing PSSH is
 * removed (so that players that don't yet support PSSH updates fall through
 * to a fresh request). Mirrors shaka's `UpdateContentProtectionPsshHelper`
 * including its `TODO(rkuroiwa)` shape — when shaka-player supports PSSH
 * updates, the commented-out branches in shaka should be uncommented; this
 * port follows the current behaviour exactly.
 *
 * @param drmUuid - lowercase UUID of the DRM system
 * @param pssh - new PSSH bytes (currently unused — see TODO above)
 * @param contentProtectionElements - list to mutate
 *
 * @group DASH
 * @public
 */
export const updateContentProtectionPsshHelper = (
	drmUuid: string,
	_pssh: Uint8Array,
	contentProtectionElements: ContentProtectionElement[],
): void => {
	const drmUuidSchemeIdUriForm = `urn:uuid:${drmUuid}`;
	for (const protection of contentProtectionElements) {
		if (protection.schemeIdUri !== drmUuidSchemeIdUriForm) {
			continue;
		}
		for (let i = 0; i < protection.subelements.length; i++) {
			const subelement = protection.subelements[i]!;
			if (subelement.name === PSSH_ELEMENT_NAME) {
				// Per shaka: remove the PSSH element since some players don't
				// support updating it. (TODO upstream: replace with
				// `subelement.content = pssh` when shaka-player supports it.)
				protection.subelements.splice(i, 1);
				return;
			}
		}
		// Reached only if <cenc:pssh> isn't present — shaka leaves the
		// "add it" branch commented out for the same reason; we mirror.
		return;
	}

	// No ContentProtection for this DRM yet — append an empty descriptor.
	const newProtection: ContentProtectionElement = {
		value: '',
		schemeIdUri: drmUuidSchemeIdUriForm,
		additionalAttributes: new Map(),
		subelements: [],
	};
	contentProtectionElements.push(newProtection);
};

/**
 * Returns `true` when `keyId` consists entirely of zero bytes — shaka's
 * marker for a key-rotation-default key id. Mirrors `IsKeyRotationDefaultKeyId`.
 *
 * @internal
 */
export const isKeyRotationDefaultKeyId = (keyId: Uint8Array): boolean => {
	for (let i = 0; i < keyId.length; i++) {
		if (keyId[i] !== 0) {
			return false;
		}
	}
	return true;
};

/**
 * Helper: text codec string with shaka's container-aware rewrites
 * (`text/*` → empty, MP4 + ttml → `stpp`). Mirrors shaka's `TextCodecString`.
 *
 * @internal
 */
const textCodecString = (mediaInfo: MediaInfo): string => {
	const containerType = mediaInfo.containerType;
	if (containerType === 'text') {
		return '';
	}
	const codec = mediaInfo.textInfo?.codec ?? '';
	if (codec === 'ttml' && containerType === 'mp4') {
		return 'stpp';
	}
	return codec;
};

/**
 * Asserts that exactly one of {video, audio, text} info is set on
 * `mediaInfo`. Mirrors shaka's `CHECK(OnlyOneTrue(...))` precondition on
 * `GetCodecs`, `GetSupplementalCodecs`, `GetSupplementalProfiles`.
 *
 * @internal
 */
const checkOnlyOneTrack = (mediaInfo: MediaInfo): void => {
	const hasVideo = mediaInfo.videoInfo !== undefined;
	const hasAudio = mediaInfo.audioInfo !== undefined;
	const hasText = mediaInfo.textInfo !== undefined;
	if (!onlyOneTrue(hasVideo, hasAudio, hasText)) {
		throw new Error(
			'MediaInfo must carry exactly one of videoInfo / audioInfo / textInfo',
		);
	}
};

/**
 * Generate a `<mas:MarlinContentIds>` element wrapping a single
 * `<mas:MarlinContentId>` for the given key ID. See shaka issue #381.
 * Used by `addContentProtectionElements` when emitting a Marlin
 * `<ContentProtection>`.
 *
 * @internal
 */
export const generateMarlinContentIds = (keyId: Uint8Array): Element => {
	let hex = '';
	for (let i = 0; i < keyId.length; i++) {
		hex += keyId[i]!.toString(16).padStart(2, '0');
	}
	const marlinContentId: Element = {
		name: 'mas:MarlinContentId',
		attributes: new Map(),
		content: `urn:marlin:kid:${hex}`,
		subelements: [],
	};
	return {
		name: 'mas:MarlinContentIds',
		attributes: new Map(),
		content: '',
		subelements: [marlinContentId],
	};
};

/**
 * Generate a `<cenc:pssh>` element with base64-encoded PSSH content.
 *
 * @internal
 */
export const generateCencPsshElement = (pssh: Uint8Array): Element => {
	return {
		name: PSSH_ELEMENT_NAME,
		attributes: new Map(),
		content: bytesToBase64(pssh),
		subelements: [],
	};
};

/**
 * Convert raw bytes to a standard base64 string (no URL-safe encoding).
 *
 * @internal
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	if (typeof btoa === 'function') {
		return btoa(binary);
	}
	// Node.js fallback when btoa isn't available globally.
	return Buffer.from(binary, 'binary').toString('base64');
};

/**
 * Re-export the well-known DRM UUIDs as constants so `addContentProtectionElements`
 * (Phase 3+) can reference them by name.
 *
 * @internal
 */
export const DRM_UUIDS = {
	MARLIN: MARLIN_UUID,
	FAIRPLAY: FAIRPLAY_UUID,
	PLAYREADY: PLAYREADY_UUID,
	MSPR_VALUE: CONTENT_PROTECTION_VALUE_MSPR_20,
} as const;

/**
 * Parse the inner `pssh_data` payload from a serialized PSSH box (ISO/IEC
 * 23001-7 §8.1). Mirrors shaka-packager's
 * `PsshBoxBuilder::ParseFromBox` (subset: only what
 * `generateMsprProElement` needs). Returns `null` when the input is not a
 * valid `pssh` box.
 *
 * Box layout consumed:
 *   uint32 size
 *   uint32 type ('pssh')
 *   uint32 version+flags  (only versions 0, 1 supported)
 *   uint8[16] systemId
 *   v1 only: uint32 keyIdCount + uint8[16][] keyIds
 *   uint32 dataSize
 *   uint8[dataSize] data  ← returned
 *
 * @internal
 */
const parsePsshBoxData = (pssh: Uint8Array): Uint8Array | null => {
	if (pssh.length < 4 + 4 + 4 + 16 + 4) {
		return null;
	}
	const view = new DataView(pssh.buffer, pssh.byteOffset, pssh.byteLength);
	let offset = 0;
	// Box header
	const size = view.getUint32(offset, false);
	offset += 4;
	const boxType = view.getUint32(offset, false);
	offset += 4;
	// 'pssh' = 0x70737368
	if (boxType !== 0x70737368) {
		return null;
	}
	if (size > pssh.length) {
		return null;
	}
	const versionAndFlags = view.getUint32(offset, false);
	offset += 4;
	const version = versionAndFlags >>> 24;
	if (version > 1) {
		return null;
	}
	// SystemID (16 bytes) — skip
	offset += 16;
	if (version === 1) {
		if (offset + 4 > pssh.length) {
			return null;
		}
		const keyIdCount = view.getUint32(offset, false);
		offset += 4;
		const keyIdsBytes = keyIdCount * 16;
		if (offset + keyIdsBytes > pssh.length) {
			return null;
		}
		offset += keyIdsBytes;
	}
	if (offset + 4 > pssh.length) {
		return null;
	}
	const dataSize = view.getUint32(offset, false);
	offset += 4;
	if (offset + dataSize > pssh.length) {
		return null;
	}
	return pssh.slice(offset, offset + dataSize);
};

/**
 * Generate an `<mspr:pro>` element containing the base64-encoded PlayReady
 * Object extracted from a PSSH box. Mirrors shaka's `GenerateMsprProElement`.
 * Returns `null` when the PSSH box cannot be parsed.
 *
 * @internal
 */
export const generateMsprProElement = (pssh: Uint8Array): Element | null => {
	const psshData = parsePsshBoxData(pssh);
	if (psshData === null) {
		return null;
	}
	return {
		name: MSPRO_ELEMENT_NAME,
		attributes: new Map(),
		content: bytesToBase64(psshData),
		subelements: [],
	};
};

/**
 * Add `<ContentProtection>` elements derived from `mediaInfo` to the
 * supplied parent (Representation or AdaptationSet — both expose
 * `addContentProtectionElement`). Mirrors shaka's templated
 * `AddContentProtectionElementsHelperTemplated`.
 *
 * Behaviour:
 * - No-op when `mediaInfo.protectedContent` is unset.
 * - For ISO BMFF (`containerType === 'mp4'`), emits the default Common-Encryption
 *   descriptor (`schemeIdUri="urn:mpeg:dash:mp4protection:2011"`) with `value`
 *   set to the protection scheme and optionally `cenc:default_KID`.
 * - For each `ContentProtectionEntry`, emits one DRM-specific descriptor:
 *   - FairPlay: skipped (FairPlay does not support DASH signaling per shaka).
 *   - Marlin: scheme uses uppercase UUID; subelement is `<mas:MarlinContentIds>`.
 *   - PlayReady: includes `<cenc:pssh>` and (when `includeMsprPro`) `<mspr:pro>`,
 *     with `value="MSPR 2.0"`.
 *   - Other systems (Widevine, etc.): `<cenc:pssh>` subelement.
 *
 * @group DASH
 * @public
 */
export const addContentProtectionElements = (
	mediaInfo: MediaInfo,
	parent: { addContentProtectionElement: (element: ContentProtectionElement) => void },
): void => {
	const protectedContent = mediaInfo.protectedContent;
	if (!protectedContent) {
		return;
	}

	const isMp4Container = mediaInfo.containerType === 'mp4';
	const defaultKeyId = protectedContent.defaultKeyId;
	const hasUsableKeyId = defaultKeyId !== undefined
		&& defaultKeyId.length > 0
		&& !isKeyRotationDefaultKeyId(defaultKeyId);
	const keyIdUuidFormat = hasUsableKeyId ? hexToUUID(defaultKeyId) : null;

	if (isMp4Container) {
		const mp4Cp: ContentProtectionElement = {
			value: protectedContent.protectionScheme ?? 'cenc',
			schemeIdUri: ENCRYPTED_MP4_SCHEME,
			additionalAttributes: new Map(),
			subelements: [],
		};
		if (keyIdUuidFormat) {
			mp4Cp.additionalAttributes.set('cenc:default_KID', keyIdUuidFormat);
		}
		parent.addContentProtectionElement(mp4Cp);
	}

	const includeMsprPro = protectedContent.includeMsprPro ?? true;
	for (const entry of protectedContent.contentProtectionEntry ?? []) {
		if (entry.uuid === undefined || entry.uuid.length === 0) {
			continue;
		}

		const cp: ContentProtectionElement = {
			value: '',
			schemeIdUri: '',
			additionalAttributes: new Map(),
			subelements: [],
		};

		if (entry.nameVersion !== undefined && entry.nameVersion.length > 0) {
			cp.value = entry.nameVersion;
		}

		if (entry.uuid === DRM_UUIDS.FAIRPLAY) {
			// shaka skips FairPlay since it does not support DASH signaling.
			continue;
		}

		if (entry.uuid === DRM_UUIDS.MARLIN) {
			cp.schemeIdUri = `urn:uuid:${entry.uuid.toUpperCase()}`;
			if (defaultKeyId) {
				cp.subelements.push(generateMarlinContentIds(defaultKeyId));
			}
		} else {
			cp.schemeIdUri = `urn:uuid:${entry.uuid}`;
			if (entry.pssh && entry.pssh.length > 0) {
				cp.subelements.push(generateCencPsshElement(entry.pssh));
				if (entry.uuid === DRM_UUIDS.PLAYREADY && includeMsprPro) {
					const mspr = generateMsprProElement(entry.pssh);
					if (mspr) {
						cp.subelements.push(mspr);
					}
					cp.value = DRM_UUIDS.MSPR_VALUE;
				}
			}
		}

		if (keyIdUuidFormat && !isMp4Container) {
			cp.additionalAttributes.set('cenc:default_KID', keyIdUuidFormat);
		}

		parent.addContentProtectionElement(cp);
	}
};
