/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist.h
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 *
 * TypeScript port: Copyright (c) 2026-present, contributors.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * Type of HLS media playlist as defined by RFC 8216 §4.3.3.5.
 *
 * @group HLS
 * @public
 */
export type HlsPlaylistType = 'vod' | 'event' | 'live';

/**
 * Stream type carried by an HLS media playlist.
 *
 * @group HLS
 * @public
 */
export type HlsMediaPlaylistStreamType =
	| 'video'
	| 'audio'
	| 'subtitle'
	| 'videoIFramesOnly';

/**
 * Encryption method for `#EXT-X-KEY`. See RFC 8216 §4.3.2.4.
 *
 * @group HLS
 * @public
 */
export type HlsEncryptionMethod = 'NONE' | 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR';

/**
 * Container format for the underlying media. Used to decide whether byte-range
 * addressing is appropriate.
 *
 * @group HLS
 * @public
 */
export type HlsContainerType = 'mp4' | 'webm' | 'mpeg2ts' | 'text';

/**
 * Video track metadata used to render `#EXT-X-STREAM-INF` and related tags.
 *
 * @group HLS
 * @public
 */
export interface HlsVideoInfo {
	/** RFC-6381 codec parameter string (e.g. `avc1.640028`). */
	codec: string;
	/** Coded pixel width. */
	width: number;
	/** Coded pixel height. */
	height: number;
	/** Track timescale (units per second). */
	timeScale: number;
	/** Sample aspect ratio numerator. */
	pixelWidth?: number;
	/** Sample aspect ratio denominator. */
	pixelHeight?: number;
	/** Frame duration in track timescale. */
	frameDuration?: number;
	/** Supplemental codec for Dolby Vision dual-track signaling. */
	supplementalCodec?: string;
	/** Compatible brand FourCC for Dolby Vision dual-track signaling. */
	compatibleBrand?: string;
}

/**
 * Audio-specific codec metadata.
 *
 * @group HLS
 * @public
 */
export interface HlsAudioCodecSpecificData {
	/** EC-3 (Dolby Digital Plus) JOC complexity, when applicable. */
	ec3JocComplexity?: number;
	/** AC-4 IMS (Immersive Stereo) flag. */
	ac4ImsFlag?: boolean;
	/** AC-4 CBI (Channel-Based Immersive) flag. */
	ac4CbiFlag?: boolean;
}

/**
 * Audio track metadata.
 *
 * @group HLS
 * @public
 */
export interface HlsAudioInfo {
	codec: string;
	timeScale: number;
	numChannels: number;
	language?: string;
	codecSpecificData?: HlsAudioCodecSpecificData;
}

/**
 * Subtitle track metadata.
 *
 * @group HLS
 * @public
 */
export interface HlsTextInfo {
	codec: string;
	language?: string;
}

/**
 * Track-level metadata required to render an HLS media playlist.
 *
 * Equivalent to shaka's `MediaInfo` proto, restricted to fields used by HLS output.
 *
 * @group HLS
 * @public
 */
export interface HlsMediaInfo {
	videoInfo?: HlsVideoInfo;
	audioInfo?: HlsAudioInfo;
	textInfo?: HlsTextInfo;
	/** URL of an `#EXT-X-MAP` initialization segment (used when init is in a separate file). */
	initSegmentUrl?: string;
	/** URL of the media file when segments live within a single file. */
	mediaFileUrl?: string;
	/** Inclusive byte range for the init segment when it shares the file with media. */
	initRange?: { begin: number; end: number };
	/** Template URL used by segmented containers (presence disables byte-range mode). */
	segmentTemplateUrl?: string;
	/** Average bandwidth in bits per second; used by `EXT-X-STREAM-INF`. */
	bandwidth?: number;
	containerType?: HlsContainerType;
	forcedSubtitle?: boolean;
	hlsCharacteristics?: string[];
	referenceTimeScale?: number;
}

/**
 * Top-level options used while emitting an HLS playlist set.
 *
 * @group HLS
 * @public
 */
export interface HlsParams {
	playlistType: HlsPlaylistType;
	mediaSequenceNumber?: number;
	discontinuitySequenceNumber?: number;
	startTimeOffset?: number;
	/** Project URL written into the playlist generator banner. */
	generatorUrl?: string;
	/** Generator version string. */
	generatorVersion?: string;
}

/**
 * Apple does not like video formats with the parameter sets stored in the
 * samples. Replace `avc3`/`hev1`/`dvhe` with `avc1`/`hvc1`/`dvh1` so the parameter
 * sets are read from the sample descriptions instead. See:
 * https://github.com/shaka-project/shaka-packager/issues/587#issuecomment-489182182
 *
 * @group HLS
 * @public
 */
export const adjustHlsVideoCodec = (codec: string): string => {
	if (codec.length < 4) {
		return codec;
	}
	const fourcc = codec.slice(0, 4);
	const rest = codec.slice(4);
	if (fourcc === 'avc3') {
		return `avc1${rest}`;
	}
	if (fourcc === 'hev1') {
		return `hvc1${rest}`;
	}
	if (fourcc === 'dvhe') {
		return `dvh1${rest}`;
	}
	return codec;
};

/**
 * Returns the effective track timescale, falling back through
 * reference → video → audio.
 */
export const getTimeScale = (info: HlsMediaInfo): number => {
	if (info.referenceTimeScale !== undefined) {
		return info.referenceTimeScale;
	}
	if (info.videoInfo) {
		return info.videoInfo.timeScale;
	}
	if (info.audioInfo) {
		return info.audioInfo.timeScale;
	}
	return 0;
};

/**
 * Returns the playlist's language tag, falling back to the audio or text track's language.
 */
export const getMediaInfoLanguage = (info: HlsMediaInfo): string => {
	if (info.audioInfo?.language) {
		return info.audioInfo.language;
	}
	if (info.textInfo?.language) {
		return info.textInfo.language;
	}
	return '';
};
