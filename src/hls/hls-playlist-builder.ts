/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	type HlsMasterPlaylist,
	type HlsMediaPlaylistAst,
	type HlsMediaRendition,
	type HlsSegment,
	type HlsVariant,
} from './hls-playlist-parser';

/**
 * Build an {@link HlsVariant} (`#EXT-X-STREAM-INF`) from the fields that matter, filling every optional
 * attribute with its absent value. The construction counterpart of parsing: compose variants + media
 * into an {@link hlsMasterPlaylist}, then serialize.
 *
 * @group HLS
 * @public
 */
export const hlsVariant = (options: {
	/** Rendition playlist URI. */
	uri: string;
	/** `BANDWIDTH` peak bitrate in bits/second. */
	bandwidth: number;
	/** `AVERAGE-BANDWIDTH`. */
	averageBandwidth?: number;
	/** `CODECS` string. */
	codecs?: string;
	/** `RESOLUTION`. */
	resolution?: { width: number; height: number };
	/** `FRAME-RATE`. */
	frameRate?: number;
	/** `VIDEO-RANGE` (`SDR` / `PQ` / `HLG`). */
	videoRange?: string;
	/** `AUDIO` group ID. */
	audioGroup?: string;
	/** `SUBTITLES` group ID. */
	subtitlesGroup?: string;
	/** `NAME`. */
	name?: string;
	/** `CHANNELS`. */
	channels?: string;
}): HlsVariant => ({
	uri: options.uri,
	bandwidth: options.bandwidth,
	averageBandwidth: options.averageBandwidth ?? null,
	codecs: options.codecs ?? null,
	resolution: options.resolution ?? null,
	frameRate: options.frameRate ?? null,
	videoRange: options.videoRange ?? null,
	hdcpLevel: null,
	audioGroup: options.audioGroup ?? null,
	videoGroup: null,
	subtitlesGroup: options.subtitlesGroup ?? null,
	closedCaptionsGroup: null,
	name: options.name ?? null,
	channels: options.channels ?? null,
	lineNumber: 0,
});

/**
 * Build an {@link HlsMediaRendition} (`#EXT-X-MEDIA`).
 *
 * @group HLS
 * @public
 */
export const hlsMediaRendition = (options: {
	/** `TYPE`. */
	type: HlsMediaRendition['type'];
	/** `GROUP-ID`. */
	groupId: string;
	/** `NAME`. */
	name: string;
	/** `URI` to the rendition playlist (absent for closed captions). */
	uri?: string;
	/** `LANGUAGE`. */
	language?: string;
	/** `DEFAULT`. */
	default?: boolean;
	/** `AUTOSELECT`. */
	autoselect?: boolean;
	/** `FORCED`. */
	forced?: boolean;
	/** `CHANNELS`. */
	channels?: string;
	/** `CHARACTERISTICS`. */
	characteristics?: string;
}): HlsMediaRendition => ({
	type: options.type,
	groupId: options.groupId,
	name: options.name,
	language: options.language ?? null,
	assocLanguage: null,
	uri: options.uri ?? null,
	default: options.default ?? false,
	autoselect: options.autoselect ?? false,
	forced: options.forced ?? false,
	channels: options.channels ?? null,
	characteristics: options.characteristics ?? null,
	resolution: null,
	lineNumber: 0,
});

/**
 * Build an {@link HlsSegment} (`#EXTINF` + URI, with optional `#EXT-X-MAP` / `#EXT-X-KEY`).
 *
 * @group HLS
 * @public
 */
export const hlsSegment = (options: {
	/** Segment URI. */
	uri: string;
	/** `#EXTINF` duration in seconds. */
	duration: number;
	/** `#EXT-X-MAP` init-segment URI (the box builds the {@link HlsMap} for you). */
	mapUri?: string;
	/** Active `#EXT-X-KEY` descriptors. */
	keys?: HlsSegment['keys'];
	/** `#EXT-X-PROGRAM-DATE-TIME` as Unix milliseconds. */
	programDateTime?: number;
	/** Whether a `#EXT-X-DISCONTINUITY` precedes this segment. */
	discontinuityBefore?: boolean;
}): HlsSegment => ({
	uri: options.uri,
	duration: options.duration,
	title: null,
	byteRange: null,
	programDateTime: options.programDateTime ?? null,
	map: options.mapUri === undefined ? null : { uri: options.mapUri, byteRange: null },
	keys: options.keys ?? [],
	discontinuityBefore: options.discontinuityBefore ?? false,
});

/**
 * Build an {@link HlsMasterPlaylist} (multivariant) from variants + media renditions.
 *
 * @group HLS
 * @public
 */
export const hlsMasterPlaylist = (options: {
	/** `#EXT-X-STREAM-INF` variants. */
	variants: HlsVariant[];
	/** `#EXT-X-MEDIA` renditions. */
	media?: HlsMediaRendition[];
	/** `#EXT-X-VERSION`. */
	version?: number;
	/** `#EXT-X-INDEPENDENT-SEGMENTS`. */
	independentSegments?: boolean;
}): HlsMasterPlaylist => ({
	kind: 'master',
	version: options.version ?? null,
	independentSegments: options.independentSegments ?? false,
	variants: options.variants,
	iFrameStreams: [],
	media: options.media ?? [],
});

/**
 * Build an {@link HlsMediaPlaylistAst}. Omit `endlist` (the default `false`) for a live playlist.
 *
 * @group HLS
 * @public
 */
export const hlsMediaPlaylist = (options: {
	/** Segments in order. */
	segments: HlsSegment[];
	/** `#EXT-X-TARGETDURATION`. */
	targetDuration: number;
	/** `#EXT-X-MEDIA-SEQUENCE`. */
	mediaSequence?: number;
	/** `#EXT-X-VERSION`. */
	version?: number;
	/** `#EXT-X-PLAYLIST-TYPE`. */
	playlistType?: HlsMediaPlaylistAst['playlistType'];
	/** `#EXT-X-ENDLIST` (VOD-complete). */
	endlist?: boolean;
	/** `#EXT-X-INDEPENDENT-SEGMENTS`. */
	independentSegments?: boolean;
}): HlsMediaPlaylistAst => ({
	kind: 'media',
	version: options.version ?? null,
	targetDuration: options.targetDuration,
	mediaSequence: options.mediaSequence ?? 0,
	playlistType: options.playlistType ?? null,
	iFramesOnly: false,
	endlist: options.endlist ?? false,
	independentSegments: options.independentSegments ?? false,
	segments: options.segments,
});
