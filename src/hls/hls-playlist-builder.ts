/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	type HlsContentSteering,
	type HlsDateRange,
	type HlsRenditionReport,
	type HlsSkip,
	type HlsIFrameStream,
	type HlsImageStream,
	type HlsTiles,
	type HlsKey,
	type HlsMap,
	type HlsMasterPlaylist,
	type HlsMediaPlaylistAst,
	type HlsMediaRendition,
	type HlsPart,
	type HlsPreloadHint,
	type HlsSegment,
	type HlsSessionData,
	type HlsStart,
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
	resolution?: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	};
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
	/** `SUPPLEMENTAL-CODECS`, for example a Dolby Vision profile accompanying the base `CODECS`. */
	supplementalCodecs?: string;
	/** `SCORE`, the author's preference ranking among variants with equivalent codecs. */
	score?: number;
	/** `STABLE-VARIANT-ID`, a variant identity that survives playlist reloads. */
	stableVariantId?: string;
	/** `PATHWAY-ID` naming the content-steering pathway this variant belongs to. */
	pathwayId?: string;
	/** `ALLOWED-CPC`, the content-protection configurations permitted for this variant. */
	allowedCpc?: string;
	/** `REQ-VIDEO-LAYOUT` describing required video channel layout, such as stereoscopic views. */
	reqVideoLayout?: string;
	/** `HDCP-LEVEL` (`NONE` / `TYPE-0` / `TYPE-1`) required to play this variant. */
	hdcpLevel?: string;
	/** `VIDEO` group ID. */
	videoGroup?: string;
	/** `CLOSED-CAPTIONS` group ID. */
	closedCaptionsGroup?: string;
	/** `WATERMARKING-VARIANT`, the A/B variant this stream carries in an ingest playlist. */
	watermarkingVariant?: string;
}): HlsVariant => ({
	watermarkingVariant: options.watermarkingVariant ?? null,
	uri: options.uri,
	bandwidth: options.bandwidth,
	averageBandwidth: options.averageBandwidth ?? null,
	codecs: options.codecs ?? null,
	supplementalCodecs: options.supplementalCodecs ?? null,
	score: options.score ?? null,
	stableVariantId: options.stableVariantId ?? null,
	pathwayId: options.pathwayId ?? null,
	allowedCpc: options.allowedCpc ?? null,
	reqVideoLayout: options.reqVideoLayout ?? null,
	resolution: options.resolution ?? null,
	frameRate: options.frameRate ?? null,
	videoRange: options.videoRange ?? null,
	hdcpLevel: options.hdcpLevel ?? null,
	audioGroup: options.audioGroup ?? null,
	videoGroup: options.videoGroup ?? null,
	subtitlesGroup: options.subtitlesGroup ?? null,
	closedCaptionsGroup: options.closedCaptionsGroup ?? null,
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
	/** `DEFAULT`. Omit to leave the attribute out; `false` writes an explicit `DEFAULT=NO`. */
	default?: boolean;
	/** `AUTOSELECT`. Omit to leave the attribute out; `false` writes an explicit `AUTOSELECT=NO`. */
	autoselect?: boolean;
	/** `FORCED`. Omit to leave the attribute out; `false` writes an explicit `FORCED=NO`. */
	forced?: boolean;
	/** `ASSOC-LANGUAGE`. */
	assocLanguage?: string;
	/** `RESOLUTION`, carried by image renditions. */
	resolution?: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	};
	/** `CHANNELS`. */
	channels?: string;
	/** `CHARACTERISTICS`. */
	characteristics?: string;
	/** `STABLE-RENDITION-ID`, a rendition identity that survives playlist reloads. */
	stableRenditionId?: string;
	/** `BIT-DEPTH` of the audio rendition in bits per sample. */
	bitDepth?: number;
	/** `SAMPLE-RATE` of the audio rendition in Hz. */
	sampleRate?: number;
	/** `INSTREAM-ID` for a `CLOSED-CAPTIONS` rendition, such as `CC1` or `SERVICE1`. */
	instreamId?: string;
	/** `WATERMARKING-VARIANT`, the A/B variant this rendition carries in an ingest playlist. */
	watermarkingVariant?: string;
}): HlsMediaRendition => ({
	watermarkingVariant: options.watermarkingVariant ?? null,
	type: options.type,
	groupId: options.groupId,
	name: options.name,
	language: options.language ?? null,
	assocLanguage: options.assocLanguage ?? null,
	uri: options.uri ?? null,
	default: options.default ?? null,
	autoselect: options.autoselect ?? null,
	forced: options.forced ?? null,
	channels: options.channels ?? null,
	characteristics: options.characteristics ?? null,
	stableRenditionId: options.stableRenditionId ?? null,
	bitDepth: options.bitDepth ?? null,
	sampleRate: options.sampleRate ?? null,
	resolution: options.resolution ?? null,
	lineNumber: 0,
	instreamId: options.instreamId ?? null,
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
	/** `#EXTINF` title, the free-form text after the duration. */
	title?: string;
	/** `#EXT-X-BYTERANGE` selecting a sub-range of the resource at `uri`. */
	byteRange?: HlsSegment['byteRange'];
	/** `#EXT-X-MAP` init segment; pass a URI for the common case or the full {@link HlsMap} for a byte range. */
	map?: string | HlsMap;
	/** Active `#EXT-X-KEY` descriptors. */
	keys?: HlsSegment['keys'];
	/** `#EXT-X-PROGRAM-DATE-TIME` as Unix milliseconds. */
	programDateTime?: number;
	/** Whether a `#EXT-X-DISCONTINUITY` precedes this segment. */
	discontinuityBefore?: boolean;
	/** How many `#EXT-X-DISCONTINUITY` tags precede it; defaults to 1 when `discontinuityBefore`. */
	discontinuitiesBefore?: number;
	/** `#EXT-X-PART` partial segments that make up this segment. */
	parts?: HlsPart[];
	/** `#EXT-X-GAP`: the segment is unavailable and must not be loaded. */
	gap?: boolean;
	/** `#EXT-X-BITRATE` in bits per second that applies to this segment. */
	bitrate?: number;
	/** `#EXT-X-TILES` when this segment is a thumbnail tile sheet. */
	tiles?: HlsTiles;
	/** Lines to write verbatim before this segment — vendor extensions, comments, ad cues. */
	unknownTags?: string[];
}): HlsSegment => ({
	uri: options.uri,
	unknownTags: options.unknownTags ?? [],
	duration: options.duration,
	title: options.title ?? null,
	tiles: options.tiles ?? null,
	byteRange: options.byteRange ?? null,
	programDateTime: options.programDateTime ?? null,
	map: typeof options.map === 'string' ? { uri: options.map, byteRange: null } : options.map ?? null,
	keys: options.keys ?? [],
	discontinuityBefore: options.discontinuityBefore ?? false,
	discontinuitiesBefore: options.discontinuitiesBefore ?? (options.discontinuityBefore ? 1 : 0),
	parts: options.parts ?? [],
	gap: options.gap ?? false,
	bitrate: options.bitrate ?? null,
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
	byteRange?: {
		/** Length of the part in bytes. */
		length: number;
		/** Offset of the part's first byte from the start of the resource. */
		offset: number;
	};
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
	/** `#EXT-X-SESSION-KEY` entries describing keys for the whole presentation. */
	sessionKeys?: HlsKey[];
	/** `#EXT-X-SESSION-DATA` entries. */
	sessionData?: HlsSessionData[];
	/** `#EXT-X-START`, the preferred playback start point. */
	start?: HlsStart;
	/** `#EXT-X-CONTENT-STEERING`. */
	contentSteering?: HlsContentSteering;
	/** `#EXT-X-I-FRAME-STREAM-INF` entries. */
	iFrameStreams?: HlsIFrameStream[];
	/** `#EXT-X-IMAGE-STREAM-INF` entries — trick-play thumbnail renditions. */
	imageStreams?: HlsImageStream[];
	/** Lines to write verbatim before the variants. */
	unknownTags?: string[];
}): HlsMasterPlaylist => ({
	kind: 'master',
	unknownTags: options.unknownTags ?? [],
	notes: [],
	version: options.version ?? null,
	independentSegments: options.independentSegments ?? false,
	variants: options.variants,
	iFrameStreams: options.iFrameStreams ?? [],
	imageStreams: options.imageStreams ?? [],
	media: options.media ?? [],
	sessionKeys: options.sessionKeys ?? [],
	sessionData: options.sessionData ?? [],
	start: options.start ?? null,
	contentSteering: options.contentSteering ?? null,
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
	/** `#EXT-X-DISCONTINUITY-SEQUENCE` value; players need it to align timelines across a splice. */
	discontinuitySequence?: number;
	/** `#EXT-X-VERSION`; raised to at least 9 when any segment or trailing part list has parts. */
	version?: number;
	/** `#EXT-X-PLAYLIST-TYPE`. */
	playlistType?: HlsMediaPlaylistAst['playlistType'];
	/** `#EXT-X-ENDLIST` (VOD-complete). */
	endlist?: boolean;
	/** `#EXT-X-I-FRAMES-ONLY`: every segment is an I-frame-only resource. */
	iFramesOnly?: boolean;
	/** `#EXT-X-IMAGES-ONLY`: every URI in this playlist is an image. */
	imagesOnly?: boolean;
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
		/** `CAN-SKIP-DATERANGES=YES`: delta updates may omit `#EXT-X-DATERANGE` tags. */
		canSkipDateRanges?: boolean;
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
	/** `#EXT-X-START`, the preferred playback start point. */
	start?: HlsStart;
	/** `#EXT-X-DATERANGE` entries. */
	dateRanges?: HlsDateRange[];
	/** `#EXT-X-SKIP` when emitting a delta update. */
	skip?: HlsSkip;
	/** `#EXT-X-RENDITION-REPORT` entries. */
	renditionReports?: HlsRenditionReport[];
	/** `#EXT-X-WMPACEINFO` relative pointer to the watermarking sidecar file. */
	wmPaceInfoUri?: string;
	/** Lines to write verbatim before the first segment. */
	unknownTags?: string[];
}): HlsMediaPlaylistAst => ({
	kind: 'media',
	unknownTags: options.unknownTags ?? [],
	notes: [],
	wmPaceInfoUri: options.wmPaceInfoUri ?? null,
	// Low-Latency HLS consumers expect version 9 or later once parts are present
	version: options.segments.some(segment => segment.parts.length > 0) || (options.trailingParts?.length ?? 0) > 0
		? Math.max(options.version ?? 0, 9)
		: options.version ?? null,
	targetDuration: options.targetDuration,
	mediaSequence: options.mediaSequence ?? 0,
	discontinuitySequence: options.discontinuitySequence ?? 0,
	playlistType: options.playlistType ?? null,
	iFramesOnly: options.iFramesOnly ?? false,
	imagesOnly: options.imagesOnly ?? false,
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
				canSkipDateRanges: options.serverControl.canSkipDateRanges ?? false,
			}
		: null,
	trailingParts: options.trailingParts ?? [],
	preloadHints: (options.preloadHints ?? []).map(hint => ({
		type: hint.type,
		uri: hint.uri,
		byteRangeStart: hint.byteRangeStart ?? null,
		byteRangeLength: hint.byteRangeLength ?? null,
	})),
	start: options.start ?? null,
	dateRanges: options.dateRanges ?? [],
	skip: options.skip ?? null,
	renditionReports: options.renditionReports ?? [],
});

/**
 * Build an {@link HlsKey} (`#EXT-X-KEY` or `#EXT-X-SESSION-KEY`). `keyFormat` defaults to `identity`, as the spec
 * states.
 *
 * @group HLS
 * @public
 */
export const hlsKey = (options: {
	/** `METHOD`. */
	method: string;
	/** `URI` of the key. */
	uri?: string;
	/** `IV` as a hexadecimal-sequence. */
	iv?: string;
	/** `KEYID`. */
	keyId?: string;
	/** `KEYFORMAT` (defaults to `identity`). */
	keyFormat?: string;
	/** `KEYFORMATVERSIONS`. */
	keyFormatVersions?: HlsKey['keyFormatVersions'];
}): HlsKey => ({
	method: options.method,
	uri: options.uri ?? null,
	iv: options.iv ?? null,
	keyId: options.keyId ?? null,
	keyFormat: options.keyFormat ?? 'identity',
	keyFormatVersions: options.keyFormatVersions ?? [],
});

/**
 * Build an {@link HlsMap} (`#EXT-X-MAP`).
 *
 * @group HLS
 * @public
 */
export const hlsMap = (options: {
	/** Init-segment `URI`. */
	uri: string;
	/** `BYTERANGE` of the init segment within the resource. */
	byteRange?: HlsMap['byteRange'];
}): HlsMap => ({
	uri: options.uri,
	byteRange: options.byteRange ?? null,
});

/**
 * Build an {@link HlsStart} (`#EXT-X-START`).
 *
 * @group HLS
 * @public
 */
export const hlsStart = (options: {
	/** `TIME-OFFSET` in seconds; negative counts back from the end. */
	timeOffset: number;
	/** `PRECISE`. Omit to leave it out; `false` writes `PRECISE=NO`. */
	precise?: boolean;
}): HlsStart => ({
	timeOffset: options.timeOffset,
	precise: options.precise ?? null,
});

/**
 * Build an {@link HlsSessionData} (`#EXT-X-SESSION-DATA`). Carries either `VALUE` or `URI`, not both.
 *
 * @group HLS
 * @public
 */
export const hlsSessionData = (options: {
	/** `DATA-ID`, conventionally reverse-DNS. */
	dataId: string;
	/** `VALUE`. */
	value?: string;
	/** `URI` of a JSON resource. */
	uri?: string;
	/** `FORMAT` (`JSON` or `RAW`). */
	format?: string;
	/** `LANGUAGE`. */
	language?: string;
}): HlsSessionData => ({
	dataId: options.dataId,
	value: options.value ?? null,
	uri: options.uri ?? null,
	format: options.format ?? null,
	language: options.language ?? null,
});

/**
 * Build an {@link HlsContentSteering} (`#EXT-X-CONTENT-STEERING`).
 *
 * @group HLS
 * @public
 */
export const hlsContentSteering = (options: {
	/** `SERVER-URI` of the steering manifest. */
	serverUri: string;
	/** `PATHWAY-ID` to use initially. */
	pathwayId?: string;
}): HlsContentSteering => ({
	serverUri: options.serverUri,
	pathwayId: options.pathwayId ?? null,
});

/**
 * Build an {@link HlsSkip} (`#EXT-X-SKIP`), the delta-update header.
 *
 * @group HLS
 * @public
 */
export const hlsSkip = (options: {
	/** `SKIPPED-SEGMENTS`. */
	skippedSegments: number;
	/** `RECENTLY-REMOVED-DATERANGES`, as a list of Date Range IDs. */
	recentlyRemovedDateRanges?: string[] | null;
}): HlsSkip => ({
	skippedSegments: options.skippedSegments,
	recentlyRemovedDateRanges: options.recentlyRemovedDateRanges ?? null,
});

/**
 * Build an {@link HlsRenditionReport} (`#EXT-X-RENDITION-REPORT`).
 *
 * @group HLS
 * @public
 */
export const hlsRenditionReport = (options: {
	/** `URI` of the reported rendition playlist. */
	uri: string;
	/** `LAST-MSN`. */
	lastMsn?: number;
	/** `LAST-PART`. */
	lastPart?: number;
}): HlsRenditionReport => ({
	uri: options.uri,
	lastMsn: options.lastMsn ?? null,
	lastPart: options.lastPart ?? null,
});

/**
 * Build an {@link HlsPreloadHint} (`#EXT-X-PRELOAD-HINT`).
 *
 * @group HLS
 * @public
 */
export const hlsPreloadHint = (options: {
	/** `TYPE` (`PART` or `MAP`). */
	type: HlsPreloadHint['type'];
	/** `URI` of the hinted resource. */
	uri: string;
	/** `BYTERANGE-START`. */
	byteRangeStart?: number;
	/** `BYTERANGE-LENGTH`. */
	byteRangeLength?: number;
}): HlsPreloadHint => ({
	type: options.type,
	uri: options.uri,
	byteRangeStart: options.byteRangeStart ?? null,
	byteRangeLength: options.byteRangeLength ?? null,
});

/**
 * Build an {@link HlsDateRange} (`#EXT-X-DATERANGE`). `clientAttributes` carries the spec's open `X-` namespace,
 * where each value states its own lexical type.
 *
 * @group HLS
 * @public
 */
export const hlsDateRange = (options: {
	/** `ID`, unique within the playlist. */
	id: string;
	/** `START-DATE` as an ISO-8601 string. */
	startDate: string;
	/** `CLASS`. */
	className?: string;
	/** `CUE`. */
	cue?: string;
	/** `END-DATE`. */
	endDate?: string;
	/** `DURATION` in seconds. */
	duration?: number;
	/** `PLANNED-DURATION` in seconds. */
	plannedDuration?: number;
	/** `END-ON-NEXT`. */
	endOnNext?: boolean;
	/** `SCTE35-CMD` as a hexadecimal-sequence. */
	scte35Cmd?: string;
	/** `SCTE35-OUT` as a hexadecimal-sequence. */
	scte35Out?: string;
	/** `SCTE35-IN` as a hexadecimal-sequence. */
	scte35In?: string;
	/** `X-` client attributes, keyed by full attribute name. */
	clientAttributes?: HlsDateRange['clientAttributes'];
}): HlsDateRange => ({
	id: options.id,
	startDate: options.startDate,
	className: options.className ?? null,
	cue: options.cue ?? null,
	endDate: options.endDate ?? null,
	duration: options.duration ?? null,
	plannedDuration: options.plannedDuration ?? null,
	endOnNext: options.endOnNext ?? false,
	scte35Cmd: options.scte35Cmd ?? null,
	scte35Out: options.scte35Out ?? null,
	scte35In: options.scte35In ?? null,
	clientAttributes: options.clientAttributes ?? {},
});

/**
 * Build an {@link HlsIFrameStream} (`#EXT-X-I-FRAME-STREAM-INF`).
 *
 * @group HLS
 * @public
 */
export const hlsIFrameStream = (options: {
	/** `URI` of the I-frame playlist. */
	uri: string;
	/** `BANDWIDTH` in bits per second. */
	bandwidth: number;
	/** `AVERAGE-BANDWIDTH`. */
	averageBandwidth?: number;
	/** `CODECS`. */
	codecs?: string;
	/** `RESOLUTION`. */
	resolution?: HlsIFrameStream['resolution'];
	/** `NAME`. */
	name?: string;
	/** `VIDEO` group ID. */
	videoGroup?: string;
	/** `SUPPLEMENTAL-CODECS`. */
	supplementalCodecs?: string;
	/** `SCORE`. */
	score?: number;
	/** `STABLE-VARIANT-ID`. */
	stableVariantId?: string;
	/** `VIDEO-RANGE`. */
	videoRange?: string;
	/** `HDCP-LEVEL`. */
	hdcpLevel?: string;
	/** `ALLOWED-CPC`. */
	allowedCpc?: string;
	/** `REQ-VIDEO-LAYOUT`. */
	reqVideoLayout?: string;
	/** `PATHWAY-ID`. */
	pathwayId?: string;
}): HlsIFrameStream => ({
	uri: options.uri,
	bandwidth: options.bandwidth,
	averageBandwidth: options.averageBandwidth ?? null,
	codecs: options.codecs ?? null,
	resolution: options.resolution ?? null,
	name: options.name ?? null,
	videoGroup: options.videoGroup ?? null,
	supplementalCodecs: options.supplementalCodecs ?? null,
	score: options.score ?? null,
	stableVariantId: options.stableVariantId ?? null,
	videoRange: options.videoRange ?? null,
	hdcpLevel: options.hdcpLevel ?? null,
	allowedCpc: options.allowedCpc ?? null,
	reqVideoLayout: options.reqVideoLayout ?? null,
	pathwayId: options.pathwayId ?? null,
	lineNumber: 0,
});

/**
 * Build an {@link HlsImageStream} (`#EXT-X-IMAGE-STREAM-INF`), a trick-play thumbnail rendition.
 *
 * `resolution` is the size of one tile in the grid, not of the image that gets fetched — the sheet
 * is that size multiplied by the {@link HlsTiles} layout.
 *
 * @group HLS
 * @public
 */
export const hlsImageStream = (options: {
	/** Image media playlist URI. */
	uri: string;
	/** `BANDWIDTH` peak bitrate. */
	bandwidth: number;
	/** `CODECS`, e.g. `'jpeg'`. */
	codecs?: string;
	/** `RESOLUTION` — the size of a single tile. */
	resolution?: HlsImageStream['resolution'];
	/** `VIDEO` group ID this rendition belongs to. */
	videoGroup?: string;
	/** Source line number, for diagnostics. */
	lineNumber?: number;
}): HlsImageStream => ({
	uri: options.uri,
	bandwidth: options.bandwidth,
	codecs: options.codecs ?? null,
	resolution: options.resolution ?? null,
	videoGroup: options.videoGroup ?? null,
	lineNumber: options.lineNumber ?? -1,
});

/**
 * Build an {@link HlsTiles} (`#EXT-X-TILES`) — the grid packed into one thumbnail image.
 *
 * @group HLS
 * @public
 */
export const hlsTiles = (options: {
	/** Pixel size of one tile. */
	resolution: HlsTiles['resolution'];
	/** Columns by rows; the spec's minimum is 1x1. */
	layout: HlsTiles['layout'];
	/** Seconds each tile represents. */
	duration: number;
}): HlsTiles => ({
	resolution: options.resolution,
	layout: options.layout,
	duration: options.duration,
});
