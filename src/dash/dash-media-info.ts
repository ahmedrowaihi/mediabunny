/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/media_info.proto
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { type ByteRange as Range } from '../isobmff/isobmff-misc';
export { type ByteRange as Range } from '../isobmff/isobmff-misc';

/**
 * Container format. Mirrors shaka's `MediaInfo.ContainerType` enum.
 *
 * @group DASH
 * @public
 */
export type ContainerType =
	| 'unknown'
	| 'mp4'
	| 'mpeg2ts'
	| 'webm'
	| 'text'
	| 'packedAudio';

/**
 * Returns the proto-style name shaka's generated `MediaInfo_ContainerType_Name`
 * helper emits (e.g. `'CONTAINER_MP4'`). Used by {@link getAdaptationSetKey}
 * to produce keys byte-identical to shaka's.
 *
 * @group DASH
 * @public
 */
export const containerTypeName = (type: ContainerType): string => {
	switch (type) {
		case 'mp4':
			return 'CONTAINER_MP4';
		case 'mpeg2ts':
			return 'CONTAINER_MPEG2_TS';
		case 'webm':
			return 'CONTAINER_WEBM';
		case 'text':
			return 'CONTAINER_TEXT';
		case 'packedAudio':
			return 'CONTAINER_PACKED_AUDIO';
		default:
			return 'CONTAINER_UNKNOWN';
	}
};

/**
 * Subtitle/caption track type. Mirrors shaka's `MediaInfo.TextInfo.TextType` enum.
 *
 * @group DASH
 * @public
 */
export type TextType = 'unknown' | 'caption' | 'subtitle';

/**
 * Returns the proto-style name shaka's generated
 * `MediaInfo_TextInfo_TextType_Name` helper emits (e.g. `'CAPTION'`).
 *
 * @group DASH
 * @public
 */
export const textTypeName = (type: TextType): string => {
	switch (type) {
		case 'caption':
			return 'CAPTION';
		case 'subtitle':
			return 'SUBTITLE';
		default:
			return 'UNKNOWN';
	}
};

/**
 * Audio codec-specific data. Mirrors shaka's
 * `MediaInfo.AudioCodecSpecificData` proto message.
 *
 * @group DASH
 * @public
 */
export type AudioCodecSpecificData = {
	/**
	 * EC-3 Channel-mask bit fields (ETSI TS 102 366 V1.3.1 E.1.3.1.8) or AC-4
	 * Channel-mask bit fields (ETSI TS 103 190-2 V1.2.1 E.10.14).
	 */
	channelMask?: number;
	/**
	 * EC-3 / AC-4 Channel configuration descriptor with MPEG scheme
	 * (ETSI TS 102 366 V1.4.1 I.1.2.1 / ETSI TS 103 190-2 V1.2.1 G.3.2).
	 */
	channelMpegValue?: number;
	/**
	 * Dolby Digital Plus JOC decoding complexity (ETSI TS 103 420 v1.2.1
	 * Backwards-compatible object audio carriage using Enhanced AC-3 Standard
	 * C.3.2.3).
	 */
	ec3JocComplexity?: number;
	/**
	 * AC-4 Immersive Stereo flag (Dolby AC-4 in MPEG-DASH for Online Delivery
	 * Specification 2.5.3).
	 */
	ac4ImsFlag?: boolean;
	/**
	 * AC-4 Channel-Based Immersive flag (ETSI TS 103 190-2 4.3).
	 */
	ac4CbiFlag?: boolean;
};

/**
 * Video track metadata. Mirrors shaka's `MediaInfo.VideoInfo` proto message.
 *
 * @group DASH
 * @public
 */
export type VideoInfo = {
	/** RFC-6381 codec parameter string (e.g. `avc1.640028`). */
	codec?: string;
	/** Coded pixel width (may differ from display width when SAR is not 1:1). */
	width?: number;
	/** Coded pixel height. */
	height?: number;
	/** Track timescale (units per second). */
	timeScale?: number;
	/** Frame duration in track timescale units. `timeScale / frameDuration` = fps. */
	frameDuration?: number;
	/** Decoder configuration record bytes (e.g. `avcC` payload). */
	decoderConfig?: Uint8Array;
	/** Sample-aspect-ratio numerator. */
	pixelWidth?: number;
	/** Sample-aspect-ratio denominator. */
	pixelHeight?: number;
	/**
	 * Trick-play playback rate (e.g. 4, 8, 16 for fast-forward). Presence
	 * marks this representation as a trick-play stream.
	 */
	playbackRate?: number;
	/**
	 * ISO/IEC 23001-8 transfer characteristics. Used for HLS `VIDEO-RANGE`
	 * and DASH AdaptationSet keying.
	 */
	transferCharacteristics?: number;
	/** ISO/IEC 23001-8 colour primaries. */
	colorPrimaries?: number;
	/** ISO/IEC 23001-8 matrix coefficients. */
	matrixCoefficients?: number;
	/** Supplemental codec for Dolby Vision dual-track signaling. */
	supplementalCodec?: string;
	/** Compatible-brand FourCC (uint32) for Dolby Vision dual-track signaling. */
	compatibleBrand?: number;
};

/**
 * Audio track metadata. Mirrors shaka's `MediaInfo.AudioInfo` proto message.
 *
 * @group DASH
 * @public
 */
export type AudioInfo = {
	/** RFC-6381 codec parameter string (e.g. `mp4a.40.2`). */
	codec?: string;
	/** Sampling frequency in Hz. */
	samplingFrequency?: number;
	/** Track timescale (units per second). */
	timeScale?: number;
	/** Channel count. */
	numChannels?: number;
	/** BCP-47 / RFC-5646 language code. */
	language?: string;
	/** Decoder configuration record bytes. */
	decoderConfig?: Uint8Array;
	/** Codec-specific data (Dolby EC-3 / AC-4 metadata). */
	codecSpecificData?: AudioCodecSpecificData;
};

/**
 * Subtitle/caption track metadata. Mirrors shaka's `MediaInfo.TextInfo` proto
 * message.
 *
 * @group DASH
 * @public
 */
export type TextInfo = {
	/** Codec identifier (e.g. `wvtt`, `ttml`). */
	codec?: string;
	/** BCP-47 / RFC-5646 language code. */
	language?: string;
	/** Track type — caption or subtitle. */
	type?: TextType;
};

/**
 * One DRM system descriptor inside `ProtectedContent`. Mirrors shaka's
 * `MediaInfo.ProtectedContent.ContentProtectionEntry` proto message.
 *
 * @group DASH
 * @public
 */
export type ContentProtectionEntry = {
	/** Lowercase UUID string of the DRM system (e.g. Widevine, PlayReady). */
	uuid?: string;
	/** Human-readable DRM name and version (e.g. `"My DRM v1.0"`). */
	nameVersion?: string;
	/** Raw `pssh` box bytes for this DRM system. */
	pssh?: Uint8Array;
};

/**
 * Encryption-status descriptor for the media. Mirrors shaka's
 * `MediaInfo.ProtectedContent` proto message.
 *
 * @group DASH
 * @public
 */
export type ProtectedContent = {
	/** Default content key id bytes. */
	defaultKeyId?: Uint8Array;
	/** One entry per DRM system (Widevine, PlayReady, etc.). */
	contentProtectionEntry?: ContentProtectionEntry[];
	/**
	 * Common-Encryption protection scheme. One of `'cenc'`, `'cens'`, `'cbc1'`,
	 * `'cbcs'`, or `'cbca'` (placeholder for SAMPLE-AES). Default: `'cenc'`.
	 */
	protectionScheme?: string;
	/**
	 * Insert PlayReady Object (`<mspr:pro>`) inside ContentProtection
	 * elements when PlayReady is present. Default: `true`.
	 */
	includeMsprPro?: boolean;
};

/**
 * Pre-built `<ContentProtection>` element override. Mirrors shaka's
 * `MediaInfo.ContentProtectionXml` proto message. Marked TODO upstream
 * (`rkuroiwa: remove this`) — kept for parity but new code should use the
 * MpdBuilder interface directly.
 *
 * @group DASH
 * @public
 */
export type ContentProtectionXml = {
	/** `schemeIdUri` attribute. */
	schemeIdUri?: string;
	/** `value` attribute. */
	value?: string;
	/** Other attributes for the `<ContentProtection>` element. */
	attributes?: {
		/** Attribute name. */
		name: string;
		/** Attribute value. */
		value: string;
	}[];
	/** Nested child elements (recursive). */
	subelements?: ContentProtectionXmlElement[];
};

/**
 * Recursive child element inside a `ContentProtectionXml` entry.
 * Mirrors shaka's `MediaInfo.ContentProtectionXml.Element` proto message.
 *
 * @group DASH
 * @public
 */
export type ContentProtectionXmlElement = {
	/** Element tag name. */
	name?: string;
	/** Attribute name/value pairs. */
	attributes?: {
		/** Attribute name. */
		name: string;
		/** Attribute value. */
		value: string;
	}[];
	/** Nested child elements (recursive). */
	subelements?: ContentProtectionXmlElement[];
};

/**
 * Track-level metadata input to the DASH MPD generator (and the HLS
 * generator). Mirrors shaka's `MediaInfo` proto message in full — every
 * field is preserved, with proto2 `optional` semantics expressed as TS
 * `?:` properties.
 *
 * @group DASH
 * @public
 */
export type MediaInfo = {
	/** Peak bandwidth in bits per second. */
	bandwidth?: number;
	/** Video track metadata. Mutually exclusive with audioInfo / textInfo. */
	videoInfo?: VideoInfo;
	/** Audio track metadata. */
	audioInfo?: AudioInfo;
	/** Subtitle/caption track metadata. */
	textInfo?: TextInfo;
	/** Pre-built `<ContentProtection>` overrides (legacy; prefer ProtectedContent). */
	contentProtections?: ContentProtectionXml[];
	/** Encryption-status descriptor. Presence implies the media is encrypted. */
	protectedContent?: ProtectedContent;
	/** Reference timescale when multiple VideoInfo / AudioInfo are present. */
	referenceTimeScale?: number;
	/** Presentation time offset in track timescale units. */
	presentationTimeOffset?: number;
	/** Container format. Default: `'unknown'`. */
	containerType?: ContainerType;
	/** Inclusive byte range of the init segment within `mediaFileUrl`. */
	initRange?: Range;
	/** Inclusive byte range of the index (sidx) within `mediaFileUrl`. */
	indexRange?: Range;
	/** Filename of the single-file media (relative). */
	mediaFileName?: string;
	/** Inclusive byte ranges of subsegments within `mediaFileUrl`. */
	subsegmentRanges?: Range[];
	/** Total media duration in seconds. Used for VOD and static-LIVE. */
	mediaDurationSeconds?: number;
	/** Init-segment filename (live profile). */
	initSegmentName?: string;
	/** Segment template (live profile, e.g. `seg-$Number$.m4s`). */
	segmentTemplate?: string;
	/**
	 * User-input segment duration. May differ from the actual segment
	 * duration passed to `MpdNotifier::NotifyNewSegment`.
	 *
	 * @deprecated Mirrors shaka's deprecated proto field for parity; ignored
	 * by the generator. Will be removed when shaka removes it upstream.
	 */
	segmentDurationSeconds?: number;
	/** URL of the media file (single-file VOD). */
	mediaFileUrl?: string;
	/** URL of the init segment (live). */
	initSegmentUrl?: string;
	/** URL of the segment template (live). */
	segmentTemplateUrl?: string;
	/** HLS-only: `CHARACTERISTICS` attribute values for the stream. */
	hlsCharacteristics?: string[];
	/** DASH-only: `<Accessibility>` elements as `schemeIdUri=value` strings. */
	dashAccessibilities?: string[];
	/** DASH-only: `<Role>` elements (raw value or `schemeIdUri=value`). */
	dashRoles?: string[];
	/**
	 * LL-DASH only: `availabilityTimeOffset` in seconds. Equal to segment
	 * time minus chunk duration.
	 */
	availabilityTimeOffset?: number;
	/**
	 * LL-DASH only: segment duration in reference-timescale units. Equal to
	 * target segment duration × reference timescale.
	 */
	segmentDuration?: number;
	/**
	 * Forced-narrative subtitle stream (DASH `forced-subtitle` role / HLS
	 * `FORCED=YES`). Default: `false`.
	 */
	forcedSubtitle?: boolean;
	/** Stream index for consistent ordering of streams. */
	index?: number;
	/** DASH-only: `<Label>` element value. */
	dashLabel?: string;
};
