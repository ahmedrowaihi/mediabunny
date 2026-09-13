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
	type HlsPart,
	type HlsPreloadHint,
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
	/** `#EXT-X-PART` partial segments that make up this segment. */
	parts?: HlsPart[];
}): HlsSegment => ({
	uri: options.uri,
	duration: options.duration,
	title: null,
	byteRange: null,
	programDateTime: options.programDateTime ?? null,
	map: options.mapUri === undefined ? null : { uri: options.mapUri, byteRange: null },
	keys: options.keys ?? [],
	discontinuityBefore: options.discontinuityBefore ?? false,
	parts: options.parts ?? [],
});

/**
 * Build an {@link HlsPart} (`#EXT-X-PART`).
 *
 * @group HLS
 * @public
 */
export const hlsPart = (options: {
	/** Partial segment URI. */
	uri: string;
	/** `DURATION` in seconds. */
	duration: number;
	/** `BYTERANGE` within the resource at `uri`. */
	byteRange?: { length: number; offset: number };
	/** `INDEPENDENT=YES`: the part starts with an independent frame. */
	independent?: boolean;
	/** `GAP=YES`: the part is unavailable. */
	gap?: boolean;
}): HlsPart => ({
	uri: options.uri,
	duration: options.duration,
	byteRange: options.byteRange ?? null,
	independent: options.independent ?? false,
	gap: options.gap ?? false,
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
	/** `#EXT-X-VERSION`; raised to at least 9 when any segment or trailing part list has parts. */
	version?: number;
	/** `#EXT-X-PLAYLIST-TYPE`. */
	playlistType?: HlsMediaPlaylistAst['playlistType'];
	/** `#EXT-X-ENDLIST` (VOD-complete). */
	endlist?: boolean;
	/** `#EXT-X-INDEPENDENT-SEGMENTS`. */
	independentSegments?: boolean;
	/** `#EXT-X-PART-INF` `PART-TARGET` in seconds. */
	partTarget?: number;
	/** `#EXT-X-SERVER-CONTROL` attributes. */
	serverControl?: {
		/** `CAN-BLOCK-RELOAD=YES`. */
		canBlockReload?: boolean;
		/** `PART-HOLD-BACK` in seconds. */
		partHoldBack?: number;
		/** `HOLD-BACK` in seconds. */
		holdBack?: number;
		/** `CAN-SKIP-UNTIL` in seconds. */
		canSkipUntil?: number;
	};
	/** Parts of the segment still being written, listed after the last segment. */
	trailingParts?: HlsPart[];
	/** `#EXT-X-PRELOAD-HINT` entries. */
	preloadHints?: {
		/** `TYPE` of the hinted resource. */
		type: HlsPreloadHint['type'];
		/** Hinted resource URI. */
		uri: string;
		/** `BYTERANGE-START`. */
		byteRangeStart?: number;
		/** `BYTERANGE-LENGTH`. */
		byteRangeLength?: number;
	}[];
}): HlsMediaPlaylistAst => ({
	kind: 'media',
	// Low-Latency HLS consumers expect version 9 or later once parts are present
	version: options.segments.some(segment => segment.parts.length > 0) || (options.trailingParts?.length ?? 0) > 0
		? Math.max(options.version ?? 0, 9)
		: options.version ?? null,
	targetDuration: options.targetDuration,
	mediaSequence: options.mediaSequence ?? 0,
	playlistType: options.playlistType ?? null,
	iFramesOnly: false,
	endlist: options.endlist ?? false,
	independentSegments: options.independentSegments ?? false,
	segments: options.segments,
	partTarget: options.partTarget ?? null,
	serverControl: options.serverControl
		? {
				canBlockReload: options.serverControl.canBlockReload ?? false,
				partHoldBack: options.serverControl.partHoldBack ?? null,
				holdBack: options.serverControl.holdBack ?? null,
				canSkipUntil: options.serverControl.canSkipUntil ?? null,
			}
		: null,
	trailingParts: options.trailingParts ?? [],
	preloadHints: (options.preloadHints ?? []).map(hint => ({
		type: hint.type,
		uri: hint.uri,
		byteRangeStart: hint.byteRangeStart ?? null,
		byteRangeLength: hint.byteRangeLength ?? null,
	})),
});
