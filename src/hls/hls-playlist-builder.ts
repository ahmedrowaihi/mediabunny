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
	averageBandwidth?: number | null | undefined;
	/** `CODECS` string. */
	codecs?: string | null | undefined;
	/** `RESOLUTION`. */
	resolution?: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	} | null | undefined;
	/** `FRAME-RATE`. */
	frameRate?: number | null | undefined;
	/** `VIDEO-RANGE` (`SDR` / `PQ` / `HLG`). */
	videoRange?: string | null | undefined;
	/** `AUDIO` group ID. */
	audioGroup?: string | null | undefined;
	/** `SUBTITLES` group ID. */
	subtitlesGroup?: string | null | undefined;
	/** `NAME`. */
	name?: string | null | undefined;
	/** `CHANNELS`. */
	channels?: string | null | undefined;
	/** `SUPPLEMENTAL-CODECS`, for example a Dolby Vision profile accompanying the base `CODECS`. */
	supplementalCodecs?: string | null | undefined;
	/** `SCORE`, the author's preference ranking among variants with equivalent codecs. */
	score?: number | null | undefined;
	/** `STABLE-VARIANT-ID`, a variant identity that survives playlist reloads. */
	stableVariantId?: string | null | undefined;
	/** `PATHWAY-ID` naming the content-steering pathway this variant belongs to. */
	pathwayId?: string | null | undefined;
	/** `ALLOWED-CPC`, the content-protection configurations permitted for this variant. */
	allowedCpc?: string | null | undefined;
	/** `REQ-VIDEO-LAYOUT` describing required video channel layout, such as stereoscopic views. */
	reqVideoLayout?: string | null | undefined;
	/** `HDCP-LEVEL` (`NONE` / `TYPE-0` / `TYPE-1`) required to play this variant. */
	hdcpLevel?: string | null | undefined;
	/** `VIDEO` group ID. */
	videoGroup?: string | null | undefined;
	/** `CLOSED-CAPTIONS` group ID. */
	closedCaptionsGroup?: string | null | undefined;
	/** `WATERMARKING-VARIANT`, the A/B variant this stream carries in an ingest playlist. */
	watermarkingVariant?: string | null | undefined;
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
	uri?: string | null | undefined;
	/** `LANGUAGE`. */
	language?: string | null | undefined;
	/** `DEFAULT`. Omit to leave the attribute out; `false` writes an explicit `DEFAULT=NO`. */
	default?: boolean | null | undefined;
	/** `AUTOSELECT`. Omit to leave the attribute out; `false` writes an explicit `AUTOSELECT=NO`. */
	autoselect?: boolean | null | undefined;
	/** `FORCED`. Omit to leave the attribute out; `false` writes an explicit `FORCED=NO`. */
	forced?: boolean | null | undefined;
	/** `ASSOC-LANGUAGE`. */
	assocLanguage?: string | null | undefined;
	/** `RESOLUTION`, carried by image renditions. */
	resolution?: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	} | null | undefined;
	/** `CHANNELS`. */
	channels?: string | null | undefined;
	/** `CHARACTERISTICS`. */
	characteristics?: string | null | undefined;
	/** `STABLE-RENDITION-ID`, a rendition identity that survives playlist reloads. */
	stableRenditionId?: string | null | undefined;
	/** `BIT-DEPTH` of the audio rendition in bits per sample. */
	bitDepth?: number | null | undefined;
	/** `SAMPLE-RATE` of the audio rendition in Hz. */
	sampleRate?: number | null | undefined;
	/** `INSTREAM-ID` for a `CLOSED-CAPTIONS` rendition, such as `CC1` or `SERVICE1`. */
	instreamId?: string | null | undefined;
	/** `WATERMARKING-VARIANT`, the A/B variant this rendition carries in an ingest playlist. */
	watermarkingVariant?: string | null | undefined;
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
	title?: string | null | undefined;
	/** `#EXT-X-BYTERANGE` selecting a sub-range of the resource at `uri`. */
	byteRange?: HlsSegment['byteRange'] | undefined;
	/** `#EXT-X-MAP` init segment; pass a URI for the common case or the full {@link HlsMap} for a byte range. */
	map?: string | HlsMap | null | undefined;
	/** Active `#EXT-X-KEY` descriptors. */
	keys?: readonly HlsSegment['keys'][number][] | null | undefined;
	/** `#EXT-X-PROGRAM-DATE-TIME` as Unix milliseconds. */
	programDateTime?: number | null | undefined;
	/** Whether a `#EXT-X-DISCONTINUITY` precedes this segment. */
	discontinuityBefore?: boolean | null | undefined;
	/** How many `#EXT-X-DISCONTINUITY` tags precede it; defaults to 1 when `discontinuityBefore`. */
	discontinuitiesBefore?: number | null | undefined;
	/** `#EXT-X-PART` partial segments that make up this segment. */
	parts?: HlsPart[] | null | undefined;
	/** `#EXT-X-GAP`: the segment is unavailable and must not be loaded. */
	gap?: boolean | null | undefined;
	/** `#EXT-X-BITRATE` in bits per second that applies to this segment. */
	bitrate?: number | null | undefined;
	/** `#EXT-X-TILES` when this segment is a thumbnail tile sheet. */
	tiles?: HlsTiles | null | undefined;
	/** Lines to write verbatim before this segment — vendor extensions, comments, ad cues. */
	unknownTags?: readonly string[] | null | undefined;
}): HlsSegment => ({
	uri: options.uri,
	unknownTags: options.unknownTags ? [...options.unknownTags] : [],
	duration: options.duration,
	title: options.title ?? null,
	tiles: options.tiles ?? null,
	byteRange: options.byteRange ?? null,
	programDateTime: options.programDateTime ?? null,
	map: typeof options.map === 'string' ? { uri: options.map, byteRange: null } : options.map ?? null,
	keys: options.keys ? [...options.keys] : [],
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
	} | null | undefined;
	/** `INDEPENDENT=YES`: the part starts with an independent frame. */
	independent?: boolean | null | undefined;
	/** `GAP=YES`: the part is unavailable. */
	gap?: boolean | null | undefined;
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
	media?: HlsMediaRendition[] | null | undefined;
	/** `#EXT-X-VERSION`. */
	version?: number | null | undefined;
	/** `#EXT-X-INDEPENDENT-SEGMENTS`. */
	independentSegments?: boolean | null | undefined;
	/** `#EXT-X-SESSION-KEY` entries describing keys for the whole presentation. */
	sessionKeys?: readonly HlsKey[] | null | undefined;
	/** `#EXT-X-SESSION-DATA` entries. */
	sessionData?: HlsSessionData[] | null | undefined;
	/** `#EXT-X-START`, the preferred playback start point. */
	start?: HlsStart | null | undefined;
	/** `#EXT-X-CONTENT-STEERING`. */
	contentSteering?: HlsContentSteering | null | undefined;
	/** `#EXT-X-I-FRAME-STREAM-INF` entries. */
	iFrameStreams?: HlsIFrameStream[] | null | undefined;
	/** `#EXT-X-IMAGE-STREAM-INF` entries — trick-play thumbnail renditions. */
	imageStreams?: HlsImageStream[] | null | undefined;
	/** Lines to write verbatim before the variants. */
	unknownTags?: string[] | null | undefined;
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
	sessionKeys: options.sessionKeys ? [...options.sessionKeys] : [],
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
	mediaSequence?: number | null | undefined;
	/** Write `#EXT-X-MEDIA-SEQUENCE` even at zero; see {@link HlsMediaPlaylistAst.alwaysStateMediaSequence}. */
	alwaysStateMediaSequence?: boolean | null | undefined;
	/** `#EXT-X-DISCONTINUITY-SEQUENCE` value; players need it to align timelines across a splice. */
	discontinuitySequence?: number | null | undefined;
	/** `#EXT-X-VERSION`; raised to at least 9 when any segment or trailing part list has parts. */
	version?: number | null | undefined;
	/** `#EXT-X-PLAYLIST-TYPE`. */
	playlistType?: HlsMediaPlaylistAst['playlistType'] | undefined;
	/** `#EXT-X-ENDLIST` (VOD-complete). */
	endlist?: boolean | null | undefined;
	/** `#EXT-X-I-FRAMES-ONLY`: every segment is an I-frame-only resource. */
	iFramesOnly?: boolean | null | undefined;
	/** `#EXT-X-IMAGES-ONLY`: every URI in this playlist is an image. */
	imagesOnly?: boolean | null | undefined;
	/** `#EXT-X-INDEPENDENT-SEGMENTS`. */
	independentSegments?: boolean | null | undefined;
	/** `#EXT-X-PART-INF` `PART-TARGET` in seconds. */
	partTarget?: number | null | undefined;
	/** `#EXT-X-SERVER-CONTROL` attributes. */
	serverControl?: {
		/** `CAN-BLOCK-RELOAD=YES`. */
		canBlockReload?: boolean | null | undefined;
		/** `PART-HOLD-BACK` in seconds. */
		partHoldBack?: number | null | undefined;
		/** `HOLD-BACK` in seconds. */
		holdBack?: number | null | undefined;
		/** `CAN-SKIP-UNTIL` in seconds. */
		canSkipUntil?: number | null | undefined;
		/** `CAN-SKIP-DATERANGES=YES`: delta updates may omit `#EXT-X-DATERANGE` tags. */
		canSkipDateRanges?: boolean | null | undefined;
	} | null | undefined;
	/** Parts of the segment still being written, listed after the last segment. */
	trailingParts?: HlsPart[] | null | undefined;
	/** `#EXT-X-PRELOAD-HINT` entries. */
	preloadHints?: {
		/** `TYPE` of the hinted resource. */
		type: HlsPreloadHint['type'];
		/** Hinted resource URI. */
		uri: string;
		/** `BYTERANGE-START`. */
		byteRangeStart?: number | null | undefined;
		/** `BYTERANGE-LENGTH`. */
		byteRangeLength?: number | null | undefined;
	}[] | null | undefined;
	/** `#EXT-X-START`, the preferred playback start point. */
	start?: HlsStart | null | undefined;
	/** `#EXT-X-DATERANGE` entries. */
	dateRanges?: HlsDateRange[] | null | undefined;
	/** `#EXT-X-SKIP` when emitting a delta update. */
	skip?: HlsSkip | null | undefined;
	/** `#EXT-X-RENDITION-REPORT` entries. */
	renditionReports?: HlsRenditionReport[] | null | undefined;
	/** `#EXT-X-WMPACEINFO` relative pointer to the watermarking sidecar file. */
	wmPaceInfoUri?: string | null | undefined;
	/** Lines to write verbatim before the first segment. */
	unknownTags?: string[] | null | undefined;
}): HlsMediaPlaylistAst => ({
	kind: 'media',
	unknownTags: options.unknownTags ?? [],
	notes: [],
	wmPaceInfoUri: options.wmPaceInfoUri ?? null,
	version: options.segments.some(segment => segment.parts.length > 0) || (options.trailingParts?.length ?? 0) > 0
		? Math.max(options.version ?? 0, 9)
		: options.version ?? null,
	targetDuration: options.targetDuration,
	mediaSequence: options.mediaSequence ?? 0,
	alwaysStateMediaSequence: options.alwaysStateMediaSequence ?? false,
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
	uri?: string | null | undefined;
	/** `IV` as a hexadecimal-sequence. */
	iv?: string | null | undefined;
	/** `KEYID`. */
	keyId?: string | null | undefined;
	/** `KEYFORMAT` (defaults to `identity`). */
	keyFormat?: string | null | undefined;
	/** `KEYFORMATVERSIONS`. */
	keyFormatVersions?: HlsKey['keyFormatVersions'] | null | undefined;
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
	byteRange?: HlsMap['byteRange'] | undefined;
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
	precise?: boolean | null | undefined;
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
	value?: string | null | undefined;
	/** `URI` of a JSON resource. */
	uri?: string | null | undefined;
	/** `FORMAT` (`JSON` or `RAW`). */
	format?: string | null | undefined;
	/** `LANGUAGE`. */
	language?: string | null | undefined;
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
	pathwayId?: string | null | undefined;
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
	lastMsn?: number | null | undefined;
	/** `LAST-PART`. */
	lastPart?: number | null | undefined;
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
	byteRangeStart?: number | null | undefined;
	/** `BYTERANGE-LENGTH`. */
	byteRangeLength?: number | null | undefined;
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
	className?: string | null | undefined;
	/** `CUE`. */
	cue?: string | null | undefined;
	/** `END-DATE`. */
	endDate?: string | null | undefined;
	/** `DURATION` in seconds. */
	duration?: number | null | undefined;
	/** `PLANNED-DURATION` in seconds. */
	plannedDuration?: number | null | undefined;
	/** `END-ON-NEXT`. */
	endOnNext?: boolean | null | undefined;
	/** `SCTE35-CMD` as a hexadecimal-sequence. */
	scte35Cmd?: string | null | undefined;
	/** `SCTE35-OUT` as a hexadecimal-sequence. */
	scte35Out?: string | null | undefined;
	/** `SCTE35-IN` as a hexadecimal-sequence. */
	scte35In?: string | null | undefined;
	/** `X-` client attributes, keyed by full attribute name. */
	clientAttributes?: HlsDateRange['clientAttributes'] | null | undefined;
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
	averageBandwidth?: number | null | undefined;
	/** `CODECS`. */
	codecs?: string | null | undefined;
	/** `RESOLUTION`. */
	resolution?: HlsIFrameStream['resolution'] | undefined;
	/** `NAME`. */
	name?: string | null | undefined;
	/** `VIDEO` group ID. */
	videoGroup?: string | null | undefined;
	/** `SUPPLEMENTAL-CODECS`. */
	supplementalCodecs?: string | null | undefined;
	/** `SCORE`. */
	score?: number | null | undefined;
	/** `STABLE-VARIANT-ID`. */
	stableVariantId?: string | null | undefined;
	/** `VIDEO-RANGE`. */
	videoRange?: string | null | undefined;
	/** `HDCP-LEVEL`. */
	hdcpLevel?: string | null | undefined;
	/** `ALLOWED-CPC`. */
	allowedCpc?: string | null | undefined;
	/** `REQ-VIDEO-LAYOUT`. */
	reqVideoLayout?: string | null | undefined;
	/** `PATHWAY-ID`. */
	pathwayId?: string | null | undefined;
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
	codecs?: string | null | undefined;
	/** `RESOLUTION` — the size of a single tile. */
	resolution?: HlsImageStream['resolution'] | undefined;
	/** `VIDEO` group ID this rendition belongs to. */
	videoGroup?: string | null | undefined;
	/** Source line number, for diagnostics. */
	lineNumber?: number | null | undefined;
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
