/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseIsoDateTimeAsUtc } from '../iso-date';
import { MalformedInputError } from '../errors';
import {
	AttributeList,
	HlsPlaylistVariables,
	TAG_CONTENT_STEERING,
	TAG_BITRATE,
	TAG_DATERANGE,
	TAG_DEFINE,
	TAG_GAP,
	TAG_BYTERANGE,
	TAG_DISCONTINUITY,
	TAG_DISCONTINUITY_SEQUENCE,
	TAG_ENDLIST,
	TAG_EXTINF,
	TAG_I_FRAME_STREAM_INF,
	TAG_IMAGE_STREAM_INF,
	TAG_IMAGES_ONLY,
	TAG_TILES,
	TAG_I_FRAMES_ONLY,
	TAG_KEY,
	TAG_MAP,
	TAG_MEDIA,
	TAG_MEDIA_SEQUENCE,
	TAG_PART,
	TAG_PART_INF,
	TAG_PLAYLIST_TYPE,
	TAG_PRELOAD_HINT,
	TAG_WMPACEINFO,
	TAG_RENDITION_REPORT,
	TAG_PROGRAM_DATE_TIME,
	TAG_SERVER_CONTROL,
	TAG_SKIP,
	TAG_SESSION_DATA,
	TAG_SESSION_KEY,
	TAG_START,
	TAG_STREAM_INF,
	TAG_TARGETDURATION,
	canIgnoreLine,
} from './hls-misc';

/** A `#EXT-X-STREAM-INF` entry plus its URI line. @group HLS @public */
export type HlsVariant = {
	/** Rendition playlist URI (next line after the `#EXT-X-STREAM-INF` tag). */
	uri: string;
	/** `BANDWIDTH` peak bitrate in bits/second. */
	bandwidth: number;
	/** `AVERAGE-BANDWIDTH` average bitrate. */
	averageBandwidth: number | null;
	/** `CODECS` attribute string. */
	codecs: string | null;
	/** Parsed `RESOLUTION` (e.g. `1920x1080`). */
	resolution: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	} | null;
	/** `FRAME-RATE` in fps. */
	frameRate: number | null;
	/** `VIDEO-RANGE` (`SDR`, `PQ`, or `HLG`). */
	videoRange: string | null;
	/** `HDCP-LEVEL`. */
	hdcpLevel: string | null;
	/** `AUDIO` group ID reference. */
	audioGroup: string | null;
	/** `VIDEO` group ID reference. */
	videoGroup: string | null;
	/** `SUBTITLES` group ID reference. */
	subtitlesGroup: string | null;
	/** `CLOSED-CAPTIONS` group ID reference. */
	closedCaptionsGroup: string | null;
	/** `NAME` attribute. */
	name: string | null;
	/** `CHANNELS` attribute (e.g. `"2"`, `"6/JOC"`). */
	channels: string | null;
	/** `SUPPLEMENTAL-CODECS`, for example a Dolby Vision profile accompanying the base `CODECS`. */
	supplementalCodecs: string | null;
	/** `SCORE`, the author's preference ranking among variants with equivalent codecs. */
	score: number | null;
	/** `STABLE-VARIANT-ID`, a variant identity that survives playlist reloads. */
	stableVariantId: string | null;
	/** `PATHWAY-ID` naming the content-steering pathway this variant belongs to. */
	pathwayId: string | null;
	/** `ALLOWED-CPC`, the content-protection configurations permitted for this variant. */
	allowedCpc: string | null;
	/** `REQ-VIDEO-LAYOUT` describing required video channel layout, such as stereoscopic views. */
	reqVideoLayout: string | null;
	/** `WATERMARKING-VARIANT`, the A/B variant this stream carries in an ingest playlist. */
	watermarkingVariant: string | null;
	/** 0-based line index in the source playlist where the `#EXT-X-STREAM-INF` tag appears. */
	lineNumber: number;
};

/** A `#EXT-X-I-FRAME-STREAM-INF` entry. @group HLS @public */
/**
 * A `#EXT-X-IMAGE-STREAM-INF` entry — a trick-play thumbnail rendition, pointing at an image media
 * playlist. Defined by the Image Media Playlist specification rather than RFC 8216, so `RESOLUTION`
 * is the size of one tile rather than of the image actually fetched.
 *
 * @group HLS @public
 */
export type HlsImageStream = {
	/** Image media playlist URI (from the `URI` attribute). */
	uri: string;
	/** `BANDWIDTH` peak bitrate. */
	bandwidth: number;
	/** `CODECS`, e.g. `"jpeg"`. */
	codecs: string | null;
	/** Parsed `RESOLUTION` — the size of a single tile, not of the tile sheet. */
	resolution: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	} | null;
	/** `VIDEO` group ID reference. */
	videoGroup: string | null;
	/** Zero-based line number of the tag in the source playlist. */
	lineNumber: number;
};

/**
 * A `#EXT-X-TILES` entry: the grid of thumbnails packed into one image, and how long each is shown.
 *
 * @group HLS @public
 */
export type HlsTiles = {
	/** `RESOLUTION` — pixel size of one tile in the grid. */
	resolution: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	};
	/** `LAYOUT` — columns by rows, minimum `1x1`. */
	layout: {
		/** Tiles across. */
		columns: number;
		/** Tiles down. */
		rows: number;
	};
	/** `DURATION` — seconds each tile represents. */
	duration: number;
};

/** A `#EXT-X-I-FRAME-STREAM-INF` entry — an I-frame-only trick-play rendition. @group HLS @public */
export type HlsIFrameStream = {
	/** I-frame playlist URI (from the `URI` attribute). */
	uri: string;
	/** `BANDWIDTH` peak bitrate. */
	bandwidth: number;
	/** `AVERAGE-BANDWIDTH`. */
	averageBandwidth: number | null;
	/** `CODECS`. */
	codecs: string | null;
	/** Parsed `RESOLUTION`. */
	resolution: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	} | null;
	/** `NAME` attribute. */
	name: string | null;
	/** `VIDEO` group ID reference. */
	videoGroup: string | null;
	/** `SUPPLEMENTAL-CODECS`, for example a Dolby Vision profile accompanying the base `CODECS`. */
	supplementalCodecs: string | null;
	/** `SCORE`, the author's preference ranking among variants with equivalent codecs. */
	score: number | null;
	/** `STABLE-VARIANT-ID`, a variant identity that survives playlist reloads. */
	stableVariantId: string | null;
	/** `VIDEO-RANGE` (`SDR`, `PQ` or `HLG`). */
	videoRange: string | null;
	/** `HDCP-LEVEL` required to play this rendition. */
	hdcpLevel: string | null;
	/** `ALLOWED-CPC`, the content-protection configurations permitted for this variant. */
	allowedCpc: string | null;
	/** `REQ-VIDEO-LAYOUT` describing required video channel layout, such as stereoscopic views. */
	reqVideoLayout: string | null;
	/** `PATHWAY-ID` naming the content-steering pathway this variant belongs to. */
	pathwayId: string | null;
	/** 0-based line index in the source playlist where the tag appears. */
	lineNumber: number;
};

/** A `#EXT-X-MEDIA` entry. @group HLS @public */
export type HlsMediaRendition = {
	/** `TYPE` enumerated value. */
	type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
	/** `GROUP-ID`. */
	groupId: string;
	/** `NAME`. */
	name: string;
	/** `LANGUAGE` BCP 47 code. */
	language: string | null;
	/** `ASSOC-LANGUAGE`. */
	assocLanguage: string | null;
	/** `URI` to the rendition playlist (absent for CLOSED-CAPTIONS). */
	uri: string | null;
	/** `DEFAULT` flag (YES → true). */
	default: boolean | null;
	/** `AUTOSELECT` flag. */
	autoselect: boolean | null;
	/** `FORCED` flag (subtitles only). */
	forced: boolean | null;
	/** `CHANNELS` attribute. */
	channels: string | null;
	/** `CHARACTERISTICS` attribute. */
	characteristics: string | null;
	/** Parsed `RESOLUTION` (rare; spec extension). */
	resolution: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	} | null;
	/** `STABLE-RENDITION-ID`, a rendition identity that survives playlist reloads. */
	stableRenditionId: string | null;
	/** `INSTREAM-ID` naming the in-band channel for a `CLOSED-CAPTIONS` rendition. */
	instreamId: string | null;
	/** `BIT-DEPTH` of the audio rendition in bits per sample. */
	bitDepth: number | null;
	/** `SAMPLE-RATE` of the audio rendition in Hz. */
	sampleRate: number | null;
	/** `WATERMARKING-VARIANT`, the A/B variant this rendition carries in an ingest playlist. */
	watermarkingVariant: string | null;
	/** 0-based line index in the source playlist where the tag appears. */
	lineNumber: number;
};

/** Parsed HLS master playlist (multivariant). @group HLS @public */
export type HlsMasterPlaylist = {
	/** Discriminator literal for the master variant of {@link HlsPlaylist}. */
	kind: 'master';
	/** `#EXT-X-VERSION` value, or `null` when absent. */
	version: number | null;
	/** `#EXT-X-INDEPENDENT-SEGMENTS` presence flag. */
	independentSegments: boolean;
	/** `#EXT-X-STREAM-INF` entries in document order. */
	variants: HlsVariant[];
	/** `#EXT-X-I-FRAME-STREAM-INF` entries in document order. */
	iFrameStreams: HlsIFrameStream[];
	/** `#EXT-X-IMAGE-STREAM-INF` entries in document order. */
	imageStreams: HlsImageStream[];
	/** `#EXT-X-MEDIA` entries in document order. */
	media: HlsMediaRendition[];
	/** `#EXT-X-SESSION-KEY` entries, one per `KEYFORMAT`, describing keys for the whole presentation. */
	sessionKeys: HlsKey[];
	/**
	 * Lines this library does not model, verbatim and in order — vendor extensions, comments, and
	 * tags from a newer spec revision. Written back when the playlist is serialized.
	 */
	unknownTags: string[];
	/** Non-fatal observations made while parsing. Empty for a conformant playlist. */
	notes: HlsParseNote[];
	/** `#EXT-X-SESSION-DATA` entries. */
	sessionData: HlsSessionData[];
	/** `#EXT-X-START`, or `null` when absent. */
	start: HlsStart | null;
	/** `#EXT-X-CONTENT-STEERING`, or `null` when absent. */
	contentSteering: HlsContentSteering | null;
};

/** A `#EXT-X-MAP` entry. @group HLS @public */
export type HlsMap = {
	/** Init-segment URI. */
	uri: string;
	/** Optional `BYTERANGE`. */
	byteRange: {
		/** Range length in bytes. */
		length: number;
		/** Range start offset; `null` continues from previous. */
		offset: number | null;
	} | null;
};

/** A `#EXT-X-KEY` entry. @group HLS @public */
export type HlsKey = {
	/** `METHOD` (e.g. `NONE`, `AES-128`, `SAMPLE-AES`, `SAMPLE-AES-CTR`). */
	method: string;
	/** Key resource `URI`. */
	uri: string | null;
	/** `IV` as a `0x`-prefixed hex string. */
	iv: string | null;
	/** `KEYID` as a `0x`-prefixed hex string (CENC default-KID hint). */
	keyId: string | null;
	/** `KEYFORMAT` (defaults to `identity`). */
	keyFormat: string;
	/** `KEYFORMATVERSIONS` parsed as integers. */
	keyFormatVersions: number[];
};

/** A `#EXT-X-PART` partial segment. @group HLS @public */
export type HlsPart = {
	/** Partial segment URI. */
	uri: string;
	/** `DURATION` in seconds. */
	duration: number;
	/** Optional `BYTERANGE` within the resource at `uri`. */
	byteRange: {
		/** Range length in bytes. */
		length: number;
		/** Range start offset; `null` continues from the previous part of the same segment. */
		offset: number | null;
	} | null;
	/** `INDEPENDENT=YES`: the part starts with an independent frame. */
	independent: boolean;
	/** `GAP=YES`: the part is unavailable. */
	gap: boolean;
};

/** A `#EXT-X-PRELOAD-HINT` entry. @group HLS @public */
export type HlsPreloadHint = {
	/** `TYPE` of the hinted resource. */
	type: 'PART' | 'MAP';
	/** Hinted resource URI. */
	uri: string;
	/** `BYTERANGE-START`, or `null` when absent (which implies 0). */
	byteRangeStart: number | null;
	/** `BYTERANGE-LENGTH`, or `null` when the hinted resource runs to the end of `uri`. */
	byteRangeLength: number | null;
};

/** `#EXT-X-SERVER-CONTROL` attributes. @group HLS @public */
export type HlsServerControl = {
	/** `CAN-BLOCK-RELOAD=YES`. */
	canBlockReload: boolean;
	/** `PART-HOLD-BACK` in seconds. */
	partHoldBack: number | null;
	/** `HOLD-BACK` in seconds. */
	holdBack: number | null;
	/** `CAN-SKIP-UNTIL` in seconds. */
	canSkipUntil: number | null;
	/** `CAN-SKIP-DATERANGES=YES`: delta updates may also omit `#EXT-X-DATERANGE` tags. */
	canSkipDateRanges: boolean;
};

/**
 * Something worth knowing about a playlist that did not stop it parsing. Returned on the playlist
 * rather than logged: an origin parses a relayed playlist on every request, and a library writing
 * to its console once per tag per request is not usable there.
 *
 * @group HLS
 * @public
 */
export type HlsParseNote =
	/** A tag this library does not model. It is kept in `unknownTags` and written back unchanged. */
	| {
		/** Discriminates this note from the others. */
		kind: 'unmodelled-tag';
		/** The tag's name, without its value — `#EXT-X-CUE-OUT` for `#EXT-X-CUE-OUT:30`. */
		tag: string;
		/** The 1-based line it was first seen on. A tag is reported once however often it appears. */
		line: number;
	}
	/** 4.4.3.1 requires `#EXT-X-TARGETDURATION` in a media playlist; this one states none. */
	| {
		/** Discriminates this note from the others. */
		kind: 'missing-target-duration';
	}
	/** 4.4.3.1: a segment's duration must be within the target. Players size their buffer from it. */
	| {
		/** Discriminates this note from the others. */
		kind: 'segment-past-target-duration';
		/** The segment that runs long. */
		uri: string;
		/** Its `#EXTINF` duration in seconds. */
		duration: number;
		/** The `#EXT-X-TARGETDURATION` the playlist states, in seconds. */
		targetDuration: number;
	};

/** A segment in a media playlist. @group HLS @public */
export type HlsSegment = {
	/** Segment URI. */
	uri: string;
	/** `#EXTINF` duration in seconds. */
	duration: number;
	/** Optional `#EXTINF` title. */
	title: string | null;
	/** `#EXT-X-TILES` for this image, or `null` when the segment is not a tile sheet. */
	tiles: HlsTiles | null;
	/** Optional `#EXT-X-BYTERANGE`. */
	byteRange: {
		/** Range length in bytes. */
		length: number;
		/** Range start offset; `null` continues from previous. */
		offset: number | null;
	} | null;
	/** `#EXT-X-PROGRAM-DATE-TIME` as Unix milliseconds when set. */
	programDateTime: number | null;
	/** Currently-active `#EXT-X-MAP` (init segment). */
	map: HlsMap | null;
	/** Active `#EXT-X-KEY` descriptors — one per KEYFORMAT, so multi-DRM is preserved. */
	keys: HlsKey[];
	/** True if a `#EXT-X-DISCONTINUITY` tag precedes this segment. */
	discontinuityBefore: boolean;
	/**
	 * How many `#EXT-X-DISCONTINUITY` tags precede this segment. Usually 0 or 1, but a playlist may
	 * carry several in a row, and every one of them counts towards the discontinuity sequence number
	 * of the segments that follow.
	 */
	discontinuitiesBefore: number;
	/** `#EXT-X-PART` partial segments that make up this segment. */
	parts: HlsPart[];
	/** `#EXT-X-GAP`: the segment is unavailable and must not be loaded. */
	gap: boolean;
	/** `#EXT-X-BITRATE` in bits per second that applies to this segment, or `null`. */
	bitrate: number | null;
	/**
	 * Lines this library does not model that preceded this segment, verbatim and in order — vendor
	 * extensions, comments, and tags from a newer spec revision. Serializing writes them back in this
	 * position, so a playlist can be rewritten without discarding what it carries. `#EXT-X-CUE-OUT`,
	 * `#EXT-X-CUE-IN` and `#EXT-OATCLS-SCTE35` arrive here, which is what makes ad-cue relay possible.
	 */
	unknownTags: string[];
};

/** A `#EXT-X-SESSION-DATA` entry carrying metadata for the whole presentation. @group HLS @public */
export type HlsSessionData = {
	/** `DATA-ID` identifying this datum. */
	dataId: string;
	/** `VALUE` when the datum is inline. */
	value: string | null;
	/** `URI` when the datum is fetched instead of inline. */
	uri: string | null;
	/** `FORMAT` of the fetched resource (`JSON` or `RAW`). */
	format: string | null;
	/** `LANGUAGE` BCP 47 code. */
	language: string | null;
};

/** `#EXT-X-START`, the preferred playback start point. @group HLS @public */
export type HlsStart = {
	/** `TIME-OFFSET` in seconds; negative counts back from the end. */
	timeOffset: number;
	/** `PRECISE=YES`: start exactly here rather than at the preceding segment boundary. */
	precise: boolean | null;
};

/** `#EXT-X-CONTENT-STEERING`, pointing at a steering manifest. @group HLS @public */
export type HlsContentSteering = {
	/** `SERVER-URI` of the steering manifest. */
	serverUri: string;
	/** `PATHWAY-ID` of the pathway to use initially. */
	pathwayId: string | null;
};

/**
 * The value of a `#EXT-X-DATERANGE` `X-<client-attribute>`. The spec allows exactly three lexical types here and
 * gives no other way to tell them apart, so the type is carried with the value and written back in the same form.
 *
 * @group HLS @public
 */
export type HlsClientAttribute =
	| {
		/** Written as a quoted-string. */
		type: 'string';
		/** The unquoted text. */
		value: string;
	}
	| {
		/** Written as a hexadecimal-sequence. */
		type: 'hex';
		/** The sequence, `0x` prefix included. */
		value: string;
	}
	| {
		/** Written as a signed-decimal-floating-point. */
		type: 'number';
		/** The parsed number. */
		value: number;
	};

/**
 * A `#EXT-X-DATERANGE`, which annotates a span of the presentation (ad breaks, SCTE-35 splices, metadata).
 * @group HLS @public
 */
export type HlsDateRange = {
	/** `ID`, unique within the playlist. */
	id: string;
	/** `CLASS` grouping ranges that share semantics. */
	className: string | null;
	/** `START-DATE` as an ISO-8601 string. */
	startDate: string;
	/** `CUE` trigger hints, such as `ONCE` or `PRE`. */
	cue: string | null;
	/** `END-DATE` as an ISO-8601 string. */
	endDate: string | null;
	/** `DURATION` in seconds. */
	duration: number | null;
	/** `PLANNED-DURATION` in seconds, for a range whose end is not yet known. */
	plannedDuration: number | null;
	/** `END-ON-NEXT=YES`: the range ends where the next one of the same `CLASS` begins. */
	endOnNext: boolean;
	/** `SCTE35-CMD` as a `0x`-prefixed hex string. */
	scte35Cmd: string | null;
	/** `SCTE35-OUT` as a `0x`-prefixed hex string. */
	scte35Out: string | null;
	/** `SCTE35-IN` as a `0x`-prefixed hex string. */
	scte35In: string | null;
	/** `X-`-prefixed client attributes, whose namespace the spec leaves open, keyed by full attribute name. */
	clientAttributes: Record<string, HlsClientAttribute>;
};

/**
 * `#EXT-X-SKIP`, the header of a delta playlist update stating what the server omitted.
 * @group HLS @public
 */
export type HlsSkip = {
	/** `SKIPPED-SEGMENTS`: how many leading segments were left out. */
	skippedSegments: number;
	/** `RECENTLY-REMOVED-DATERANGES`: IDs of date ranges removed since the client's last copy. */
	recentlyRemovedDateRanges: string[] | null;
};

/**
 * `#EXT-X-RENDITION-REPORT`, reporting how far another rendition had progressed when this playlist was written.
 * @group HLS @public
 */
export type HlsRenditionReport = {
	/** `URI` of the reported rendition's playlist. */
	uri: string;
	/** `LAST-MSN`, the media sequence number of its last segment. */
	lastMsn: number | null;
	/** `LAST-PART`, the index of its last partial segment. */
	lastPart: number | null;
};

/** Parsed HLS media playlist. @group HLS @public */
export type HlsMediaPlaylistAst = {
	/** Discriminator literal for the media variant of {@link HlsPlaylist}. */
	kind: 'media';
	/** `#EXT-X-VERSION` value, or `null` when absent. */
	version: number | null;
	/** `#EXT-X-TARGETDURATION` in seconds, or `null` when absent. */
	targetDuration: number | null;
	/** `#EXT-X-MEDIA-SEQUENCE` start sequence number (defaults to 0). */
	mediaSequence: number;
	/** `#EXT-X-DISCONTINUITY-SEQUENCE` value (defaults to 0). Aligns player timelines across a splice. */
	discontinuitySequence: number;
	/** `#EXT-X-PLAYLIST-TYPE` enum (VOD / EVENT), or `null`. */
	playlistType: 'VOD' | 'EVENT' | null;
	/** `#EXT-X-I-FRAMES-ONLY` presence flag. */
	iFramesOnly: boolean;
	/** `#EXT-X-IMAGES-ONLY` presence flag — every URI in the playlist is an image. */
	imagesOnly: boolean;
	/** `#EXT-X-ENDLIST` presence flag (VOD-complete signal). */
	endlist: boolean;
	/** `#EXT-X-START`, or `null` when absent. */
	start: HlsStart | null;
	/** `#EXT-X-INDEPENDENT-SEGMENTS` presence flag. */
	independentSegments: boolean;
	/** Segments in document order. */
	segments: HlsSegment[];
	/** `#EXT-X-DATERANGE` entries in document order. */
	dateRanges: HlsDateRange[];
	/** `#EXT-X-SKIP` when this is a delta update, else `null`. */
	skip: HlsSkip | null;
	/** `#EXT-X-RENDITION-REPORT` entries in document order. */
	renditionReports: HlsRenditionReport[];
	/** `#EXT-X-PART-INF` `PART-TARGET` in seconds, or `null` when absent. */
	partTarget: number | null;
	/** `#EXT-X-SERVER-CONTROL`, or `null` when absent. */
	serverControl: HlsServerControl | null;
	/** Parts listed after the last segment, belonging to the segment still being written. */
	trailingParts: HlsPart[];
	/** `#EXT-X-PRELOAD-HINT` entries in document order. */
	preloadHints: HlsPreloadHint[];
	/** `#EXT-X-WMPACEINFO` relative pointer to the watermarking sidecar file, or `null`. */
	wmPaceInfoUri: string | null;
	/**
	 * Lines this library does not model that appeared before the first segment, verbatim and in order.
	 * Per-segment ones live on {@link HlsSegment.unknownTags} instead.
	 */
	unknownTags: string[];
	/** Non-fatal observations made while parsing. Empty for a conformant playlist. */
	notes: HlsParseNote[];
};

/** Discriminated union over master / media playlists. @group HLS @public */
export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylistAst;

/**
 * Parse an HLS playlist (master or media) into a typed AST. Master is identified
 * by the presence of any `#EXT-X-STREAM-INF`, `#EXT-X-I-FRAME-STREAM-INF`, or
 * `#EXT-X-MEDIA` tag; otherwise the playlist is treated as a media playlist.
 * Throws on missing `#EXTM3U` or required attributes.
 *
 * @group HLS @public
 */
export const parseHlsPlaylist = (text: string, variables?: HlsPlaylistVariables): HlsPlaylist => {
	const lines = text.split('\n').map(l => l.trim());
	if (lines.length === 0 || lines[0] !== '#EXTM3U') {
		throw new MalformedInputError('Invalid HLS playlist: must start with #EXTM3U');
	}

	const isMaster = lines.some(l =>
		l.startsWith(TAG_STREAM_INF) || l.startsWith(TAG_I_FRAME_STREAM_INF) || l.startsWith(TAG_MEDIA));

	return isMaster ? parseMaster(lines, variables) : parseMedia(lines, variables);
};

const INDEPENDENT_SEGMENTS = '#EXT-X-INDEPENDENT-SEGMENTS';
const EXT_X_VERSION = '#EXT-X-VERSION:';

// A tag this library does not model is kept verbatim in `unknownTags` and written back, so nothing
// is lost and there is nothing to report. It used to be dropped, which is what the warning was for.
const noteUnmodelledTag = (line: string, lineNumber: number, notes: HlsParseNote[]) => {
	const name = line.slice(0, line.indexOf(':') === -1 ? undefined : line.indexOf(':'));
	if (name === '#EXTM3U' || notes.some(note => note.kind === 'unmodelled-tag' && note.tag === name)) {
		return;
	}

	notes.push({ kind: 'unmodelled-tag', tag: name, line: lineNumber + 1 });
};

const KEY_METHODS = new Set(['NONE', 'AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR', 'SAMPLE-AES-CENC']);

const keyFromAttrs = (attrs: AttributeList, method: string): HlsKey => {
	if (!KEY_METHODS.has(method)) {
		throw new MalformedInputError(`Invalid HLS playlist: unrecognized #EXT-X-KEY METHOD "${method}"`);
	}

	const iv = attrs.get('iv');
	if (iv !== null && !/^0[xX][0-9a-fA-F]+$/.test(iv)) {
		throw new MalformedInputError(`Invalid HLS playlist: #EXT-X-KEY IV must be a hex sequence, got "${iv}"`);
	}

	const uri = stripQuotes(attrs.get('uri'));
	if (method !== 'NONE' && uri === null) {
		throw new MalformedInputError(
			`Invalid HLS playlist: #EXT-X-KEY with METHOD=${method} requires a URI.`,
		);
	}

	return keyFrom(attrs, method, uri);
};

const keyFrom = (attrs: AttributeList, method: string, uri: string | null): HlsKey => ({
	method,
	uri,
	iv: attrs.get('iv'),
	keyId: attrs.get('keyid'),
	keyFormat: stripQuotes(attrs.get('keyformat')) ?? 'identity',
	keyFormatVersions: parseKeyFormatVersions(stripQuotes(attrs.get('keyformatversions'))),
});

const parseMaster = (lines: string[], variables?: HlsPlaylistVariables): HlsMasterPlaylist => {
	const vars = variables ?? new HlsPlaylistVariables('', null);
	const out: HlsMasterPlaylist = {
		kind: 'master',
		unknownTags: [],
		notes: [],
		version: null,
		independentSegments: false,
		variants: [],
		iFrameStreams: [],
		imageStreams: [],
		media: [],
		sessionKeys: [],
		sessionData: [],
		start: null,
		contentSteering: null,
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.length === 0) {
			continue;
		}

		if (line.startsWith(TAG_DEFINE)) {
			vars.define(line.slice(TAG_DEFINE.length));
			continue;
		}

		if (line.startsWith(EXT_X_VERSION)) {
			out.version = parseFiniteNumber(line.slice(EXT_X_VERSION.length));
			continue;
		}
		if (line === INDEPENDENT_SEGMENTS) {
			out.independentSegments = true;
			continue;
		}
		if (line.startsWith(TAG_SESSION_KEY)) {
			const attrs = new AttributeList(line.slice(TAG_SESSION_KEY.length), vars);
			const method = attrs.get('method');
			if (method === null) {
				throw new MalformedInputError('Invalid HLS master playlist: #EXT-X-SESSION-KEY requires METHOD');
			}
			const key = keyFromAttrs(attrs, method);
			// As with #EXT-X-KEY, one key per KEYFORMAT; different formats coexist for multi-DRM.
			out.sessionKeys = [...out.sessionKeys.filter(k => k.keyFormat !== key.keyFormat), key];
			continue;
		}
		if (line.startsWith(TAG_SESSION_DATA)) {
			const attrs = new AttributeList(line.slice(TAG_SESSION_DATA.length), vars);
			const dataId = stripQuotes(attrs.get('data-id'));
			if (dataId === null) {
				throw new MalformedInputError('Invalid HLS master playlist: #EXT-X-SESSION-DATA requires DATA-ID');
			}
			out.sessionData.push({
				dataId,
				value: stripQuotes(attrs.get('value')),
				uri: stripQuotes(attrs.get('uri')),
				format: stripQuotes(attrs.get('format')),
				language: stripQuotes(attrs.get('language')),
			});
			continue;
		}
		if (line.startsWith(TAG_CONTENT_STEERING)) {
			const attrs = new AttributeList(line.slice(TAG_CONTENT_STEERING.length), vars);
			const serverUri = stripQuotes(attrs.get('server-uri'));
			if (serverUri === null) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: #EXT-X-CONTENT-STEERING requires SERVER-URI',
				);
			}
			out.contentSteering = { serverUri, pathwayId: stripQuotes(attrs.get('pathway-id')) };
			continue;
		}
		if (line.startsWith(TAG_START)) {
			const attrs = new AttributeList(line.slice(TAG_START.length), vars);
			const timeOffset = attrs.getAsNumber('time-offset');
			if (timeOffset === null) {
				throw new MalformedInputError('Invalid HLS playlist: #EXT-X-START requires TIME-OFFSET');
			}
			out.start = { timeOffset, precise: parseYesNoOptional(attrs.get('precise'), '#EXT-X-START PRECISE') };
			continue;
		}
		if (line.startsWith(TAG_STREAM_INF)) {
			const attrs = new AttributeList(line.slice(TAG_STREAM_INF.length), vars);
			// 4.1: blank lines are ignored and comments SHOULD be, so the URI need not be the very
			// next line — media playlists already read it this way.
			let uriIndex = i + 1;
			while (uriIndex < lines.length && canIgnoreLine(lines[uriIndex]!)) {
				uriIndex++;
			}

			const rawUri = lines[uriIndex];
			if (rawUri === undefined || rawUri.startsWith('#')) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: #EXT-X-STREAM-INF must be followed by a URI line',
				);
			}
			const uri = vars.substitute(rawUri);
			const bandwidth = attrs.getAsNumber('bandwidth');
			if (bandwidth === null || !Number.isInteger(bandwidth) || bandwidth <= 0) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: #EXT-X-STREAM-INF BANDWIDTH must be a positive'
					+ ` decimal-integer, got ${String(attrs.get('bandwidth'))}`,
				);
			}
			out.variants.push({
				uri,
				bandwidth,
				averageBandwidth: attrs.getAsNumber('average-bandwidth'),
				codecs: stripQuotes(attrs.get('codecs')),
				supplementalCodecs: stripQuotes(attrs.get('supplemental-codecs')),
				score: attrs.getAsNumber('score'),
				stableVariantId: stripQuotes(attrs.get('stable-variant-id')),
				pathwayId: stripQuotes(attrs.get('pathway-id')),
				allowedCpc: stripQuotes(attrs.get('allowed-cpc')),
				reqVideoLayout: stripQuotes(attrs.get('req-video-layout')),
				watermarkingVariant: stripQuotes(attrs.get('watermarking-variant')),
				resolution: parseResolution(attrs.get('resolution')),
				frameRate: attrs.getAsNumber('frame-rate'),
				videoRange: stripQuotes(attrs.get('video-range')),
				hdcpLevel: attrs.get('hdcp-level'),
				audioGroup: stripQuotes(attrs.get('audio')),
				videoGroup: stripQuotes(attrs.get('video')),
				subtitlesGroup: stripQuotes(attrs.get('subtitles')),
				closedCaptionsGroup: stripQuotes(attrs.get('closed-captions')),
				name: stripQuotes(attrs.get('name')),
				channels: stripQuotes(attrs.get('channels')),
				lineNumber: i,
			});
			i = uriIndex;
			continue;
		}
		if (line.startsWith(TAG_IMAGE_STREAM_INF)) {
			const attrs = new AttributeList(line.slice(TAG_IMAGE_STREAM_INF.length), vars);
			const uri = stripQuotes(attrs.get('uri'));
			if (uri === null) {
				throw new MalformedInputError('Invalid HLS master playlist: #EXT-X-IMAGE-STREAM-INF requires URI');
			}
			const bandwidth = attrs.getAsNumber('bandwidth');
			if (bandwidth === null) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: #EXT-X-IMAGE-STREAM-INF requires BANDWIDTH',
				);
			}
			out.imageStreams.push({
				uri,
				bandwidth,
				codecs: stripQuotes(attrs.get('codecs')),
				resolution: parseResolution(attrs.get('resolution')),
				videoGroup: stripQuotes(attrs.get('video')),
				lineNumber: i,
			});
			continue;
		}
		if (line.startsWith(TAG_I_FRAME_STREAM_INF)) {
			const attrs = new AttributeList(line.slice(TAG_I_FRAME_STREAM_INF.length), vars);
			const uri = stripQuotes(attrs.get('uri'));
			if (uri === null) {
				throw new MalformedInputError('Invalid HLS master playlist: #EXT-X-I-FRAME-STREAM-INF requires URI');
			}
			const bandwidth = attrs.getAsNumber('bandwidth');
			if (bandwidth === null) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: #EXT-X-I-FRAME-STREAM-INF requires BANDWIDTH',
				);
			}
			out.iFrameStreams.push({
				uri,
				bandwidth,
				averageBandwidth: attrs.getAsNumber('average-bandwidth'),
				codecs: stripQuotes(attrs.get('codecs')),
				supplementalCodecs: stripQuotes(attrs.get('supplemental-codecs')),
				score: attrs.getAsNumber('score'),
				stableVariantId: stripQuotes(attrs.get('stable-variant-id')),
				pathwayId: stripQuotes(attrs.get('pathway-id')),
				resolution: parseResolution(attrs.get('resolution')),
				name: stripQuotes(attrs.get('name')),
				videoRange: stripQuotes(attrs.get('video-range')),
				hdcpLevel: attrs.get('hdcp-level'),
				allowedCpc: stripQuotes(attrs.get('allowed-cpc')),
				reqVideoLayout: stripQuotes(attrs.get('req-video-layout')),
				videoGroup: stripQuotes(attrs.get('video')),
				lineNumber: i,
			});
			continue;
		}
		if (line.startsWith(TAG_MEDIA)) {
			const attrs = new AttributeList(line.slice(TAG_MEDIA.length), vars);
			const type = attrs.get('type');
			const groupId = stripQuotes(attrs.get('group-id'));
			const name = stripQuotes(attrs.get('name'));
			if (type === null || groupId === null || name === null) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: #EXT-X-MEDIA requires TYPE, GROUP-ID, NAME',
				);
			}
			if (type !== 'AUDIO' && type !== 'VIDEO' && type !== 'SUBTITLES' && type !== 'CLOSED-CAPTIONS') {
				throw new MalformedInputError(`Invalid HLS master playlist: unrecognized #EXT-X-MEDIA TYPE "${type}"`);
			}
			if (type === 'CLOSED-CAPTIONS' && attrs.get('uri') !== null) {
				throw new MalformedInputError(
					'Invalid HLS master playlist: a CLOSED-CAPTIONS #EXT-X-MEDIA must not state a URI',
				);
			}
			out.media.push({
				type,
				groupId,
				name,
				language: stripQuotes(attrs.get('language')),
				assocLanguage: stripQuotes(attrs.get('assoc-language')),
				uri: stripQuotes(attrs.get('uri')),
				default: parseYesNoOptional(attrs.get('default'), '#EXT-X-MEDIA DEFAULT'),
				autoselect: parseYesNoOptional(attrs.get('autoselect'), '#EXT-X-MEDIA AUTOSELECT'),
				forced: parseYesNoOptional(attrs.get('forced'), '#EXT-X-MEDIA FORCED'),
				channels: stripQuotes(attrs.get('channels')),
				characteristics: stripQuotes(attrs.get('characteristics')),
				stableRenditionId: stripQuotes(attrs.get('stable-rendition-id')),
				instreamId: stripQuotes(attrs.get('instream-id')),
				bitDepth: attrs.getAsNumber('bit-depth'),
				sampleRate: attrs.getAsNumber('sample-rate'),
				resolution: parseResolution(attrs.get('resolution')),
				watermarkingVariant: stripQuotes(attrs.get('watermarking-variant')),
				lineNumber: i,
			});
			continue;
		}

		if (line.startsWith('#EXT')) {
			if (line !== '#EXTM3U') {
				noteUnmodelledTag(line, i, out.notes);
				out.unknownTags.push(line);
			}
		} else if (line.startsWith('#')) {
			out.unknownTags.push(line); // a comment per 4.1, but a relay still has to write it back
		}
	}

	return out;
};

const parseMedia = (lines: string[], variables?: HlsPlaylistVariables): HlsMediaPlaylistAst => {
	const vars = variables ?? new HlsPlaylistVariables('', null);
	const out: HlsMediaPlaylistAst = {
		kind: 'media',
		unknownTags: [],
		notes: [],
		version: null,
		targetDuration: null,
		mediaSequence: 0,
		discontinuitySequence: 0,
		playlistType: null,
		iFramesOnly: false,
		imagesOnly: false,
		endlist: false,
		start: null,
		dateRanges: [],
		skip: null,
		renditionReports: [],
		independentSegments: false,
		segments: [],
		partTarget: null,
		serverControl: null,
		trailingParts: [],
		preloadHints: [],
		wmPaceInfoUri: null,
	};

	let pendingDuration: number | null = null;
	let pendingTitle: string | null = null;
	let pendingTiles: HlsTiles | null = null;
	let pendingUnknownTags: string[] = [];
	let pendingByteRange: { length: number; offset: number | null } | null = null;
	let pendingProgramDateTime: number | null = null;
	let pendingDiscontinuities = 0;
	let pendingParts: HlsPart[] = [];
	let currentMap: HlsMap | null = null;
	let currentKeys: HlsKey[] = [];
	let pendingGap = false;
	let currentBitrate: number | null = null;

	for (const [lineIndex, rawLine] of lines.entries()) {
		const line = rawLine;
		if (line.length === 0) {
			continue;
		}

		if (line.startsWith(TAG_DEFINE)) {
			vars.define(line.slice(TAG_DEFINE.length));
			continue;
		}

		if (line.startsWith(EXT_X_VERSION)) {
			if (out.version !== null) {
				throw new MalformedInputError('Invalid HLS playlist: more than one #EXT-X-VERSION tag');
			}
			out.version = parseFiniteNumber(line.slice(EXT_X_VERSION.length));
			continue;
		}
		if (line.startsWith(TAG_START)) {
			const attrs = new AttributeList(line.slice(TAG_START.length), vars);
			const timeOffset = attrs.getAsNumber('time-offset');
			if (timeOffset === null) {
				throw new MalformedInputError('Invalid HLS playlist: #EXT-X-START requires TIME-OFFSET');
			}
			out.start = { timeOffset, precise: parseYesNoOptional(attrs.get('precise'), '#EXT-X-START PRECISE') };
			continue;
		}
		if (line.startsWith(TAG_TARGETDURATION)) {
			const value = parseFiniteNumber(line.slice(TAG_TARGETDURATION.length));
			if (value === null || !Number.isInteger(value) || value < 0) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-TARGETDURATION must be a decimal-integer, got'
					+ ` ${JSON.stringify(line.slice(TAG_TARGETDURATION.length))}`,
				);
			}
			out.targetDuration = value;
			continue;
		}
		if (line.startsWith(TAG_MEDIA_SEQUENCE)) {
			if (out.segments.length > 0) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-MEDIA-SEQUENCE must appear before the first segment',
				);
			}
			const v = parseFiniteNumber(line.slice(TAG_MEDIA_SEQUENCE.length));
			if (v !== null) {
				out.mediaSequence = v;
			}
			continue;
		}
		if (line.startsWith(TAG_DISCONTINUITY_SEQUENCE)) {
			const v = parseFiniteNumber(line.slice(TAG_DISCONTINUITY_SEQUENCE.length));
			if (v !== null) {
				out.discontinuitySequence = v;
			}
			continue;
		}
		if (line.startsWith(TAG_PLAYLIST_TYPE)) {
			const v = line.slice(TAG_PLAYLIST_TYPE.length);
			out.playlistType = v === 'VOD' || v === 'EVENT' ? v : null;
			continue;
		}
		if (line === TAG_I_FRAMES_ONLY) {
			out.iFramesOnly = true;
			continue;
		}
		if (line === TAG_IMAGES_ONLY) {
			out.imagesOnly = true;
			continue;
		}
		if (line.startsWith(TAG_TILES)) {
			const attrs = new AttributeList(line.slice(TAG_TILES.length), vars);
			const resolution = parseResolution(attrs.get('resolution'));
			const layout = parseTileLayout(attrs.get('layout'));
			const duration = attrs.getAsNumber('duration');
			if (resolution === null || layout === null || duration === null) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-TILES requires RESOLUTION, LAYOUT and DURATION',
				);
			}
			pendingTiles = { resolution, layout, duration };
			continue;
		}
		if (line === TAG_ENDLIST) {
			out.endlist = true;
			continue;
		}
		if (line === INDEPENDENT_SEGMENTS) {
			out.independentSegments = true;
			continue;
		}
		if (line.startsWith(TAG_MAP)) {
			const attrs = new AttributeList(line.slice(TAG_MAP.length), vars);
			const uri = stripQuotes(attrs.get('uri'));
			if (uri === null) {
				throw new MalformedInputError('Invalid HLS media playlist: #EXT-X-MAP requires URI');
			}
			currentMap = { uri, byteRange: parseByteRangeAttr(stripQuotes(attrs.get('byterange'))) };
			continue;
		}
		if (line.startsWith(TAG_SKIP)) {
			const attrs = new AttributeList(line.slice(TAG_SKIP.length), vars);
			const skippedSegments = attrs.getAsNumber('skipped-segments');
			if (skippedSegments === null) {
				throw new MalformedInputError('Invalid HLS media playlist: #EXT-X-SKIP requires SKIPPED-SEGMENTS');
			}
			const removed = stripQuotes(attrs.get('recently-removed-dateranges'));
			out.skip = {
				skippedSegments,
				recentlyRemovedDateRanges: removed === null
					? null
					: removed.split('\t').filter(id => id.length > 0),
			};
			continue;
		}
		if (line.startsWith(TAG_RENDITION_REPORT)) {
			const attrs = new AttributeList(line.slice(TAG_RENDITION_REPORT.length), vars);
			const uri = stripQuotes(attrs.get('uri'));
			if (uri === null) {
				throw new MalformedInputError('Invalid HLS media playlist: #EXT-X-RENDITION-REPORT requires URI');
			}
			out.renditionReports.push({
				uri,
				lastMsn: attrs.getAsNumber('last-msn'),
				lastPart: attrs.getAsNumber('last-part'),
			});
			continue;
		}
		if (line === TAG_GAP) {
			pendingGap = true;
			continue;
		}
		if (line.startsWith(TAG_BITRATE)) {
			currentBitrate = parseFiniteNumber(line.slice(TAG_BITRATE.length));
			continue;
		}
		if (line.startsWith(TAG_DATERANGE)) {
			const attrs = new AttributeList(line.slice(TAG_DATERANGE.length), vars);
			const id = stripQuotes(attrs.get('id'));
			const startDate = stripQuotes(attrs.get('start-date'));
			if (id === null || startDate === null) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-DATERANGE requires ID and START-DATE',
				);
			}
			const known = new Set([
				'id', 'class', 'start-date', 'cue', 'end-date', 'duration', 'planned-duration',
				'end-on-next', 'scte35-cmd', 'scte35-out', 'scte35-in',
			]);
			const clientAttributes: Record<string, HlsClientAttribute> = {};
			for (const [key, value] of Object.entries(attrs._attributes)) {
				if (known.has(key)) {
					continue;
				}

				if (attrs.isQuoted(key)) {
					clientAttributes[key.toUpperCase()] = { type: 'string', value };
				} else if (value.startsWith('0x') || value.startsWith('0X')) {
					clientAttributes[key.toUpperCase()] = { type: 'hex', value };
				} else {
					const num = Number(value);
					if (!Number.isFinite(num)) {
						throw new MalformedInputError(
							`Invalid #EXT-X-DATERANGE attribute ${key.toUpperCase()}: a client attribute must be a `
							+ `quoted-string, a hexadecimal-sequence or a decimal-floating-point, got "${value}".`,
						);
					}

					clientAttributes[key.toUpperCase()] = { type: 'number', value: num };
				}
			}
			out.dateRanges.push({
				id,
				className: stripQuotes(attrs.get('class')),
				startDate,
				cue: stripQuotes(attrs.get('cue')),
				endDate: stripQuotes(attrs.get('end-date')),
				duration: attrs.getAsNumber('duration'),
				plannedDuration: attrs.getAsNumber('planned-duration'),
				endOnNext: attrs.get('end-on-next') === 'YES',
				scte35Cmd: attrs.get('scte35-cmd'),
				scte35Out: attrs.get('scte35-out'),
				scte35In: attrs.get('scte35-in'),
				clientAttributes,
			});
			continue;
		}
		if (line.startsWith(TAG_KEY)) {
			const attrs = new AttributeList(line.slice(TAG_KEY.length), vars);
			const method = attrs.get('method');
			if (method === null) {
				throw new MalformedInputError('Invalid HLS media playlist: #EXT-X-KEY requires METHOD');
			}
			if (method === 'NONE') {
				currentKeys = [];
			} else {
				const key: HlsKey = keyFromAttrs(attrs, method);
				// A new key supersedes the prior one of the same KEYFORMAT; different formats coexist (multi-DRM).
				currentKeys = [...currentKeys.filter(k => k.keyFormat !== key.keyFormat), key];
			}
			continue;
		}
		if (line === TAG_DISCONTINUITY) {
			pendingDiscontinuities++;
			continue;
		}
		if (line.startsWith(TAG_PROGRAM_DATE_TIME)) {
			const v = parseIsoDateTimeAsUtc(line.slice(TAG_PROGRAM_DATE_TIME.length));
			pendingProgramDateTime = Number.isFinite(v) ? v : null;
			continue;
		}
		if (line.startsWith(TAG_BYTERANGE)) {
			pendingByteRange = parseByteRangeAttr(line.slice(TAG_BYTERANGE.length));
			if (pendingByteRange !== null && pendingByteRange.offset === null && out.segments.length === 0) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-BYTERANGE without an offset continues the previous'
					+ ' sub-range, and the first segment has none to continue from',
				);
			}
			continue;
		}
		if (line.startsWith(TAG_SERVER_CONTROL)) {
			const attrs = new AttributeList(line.slice(TAG_SERVER_CONTROL.length), vars);
			out.serverControl = {
				canBlockReload: parseYesNo(attrs.get('can-block-reload'), '#EXT-X-SERVER-CONTROL CAN-BLOCK-RELOAD'),
				partHoldBack: attrs.getAsNumber('part-hold-back'),
				holdBack: attrs.getAsNumber('hold-back'),
				canSkipUntil: attrs.getAsNumber('can-skip-until'),
				canSkipDateRanges: attrs.get('can-skip-dateranges') === 'YES',
			};
			continue;
		}
		if (line.startsWith(TAG_PART_INF)) {
			const attrs = new AttributeList(line.slice(TAG_PART_INF.length), vars);
			out.partTarget = attrs.getAsNumber('part-target');
			if (out.partTarget === null) {
				throw new MalformedInputError('Invalid HLS media playlist: #EXT-X-PART-INF requires PART-TARGET');
			}
			continue;
		}
		if (line.startsWith(TAG_PART)) {
			if (out.partTarget === null) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-PART requires a preceding #EXT-X-PART-INF',
				);
			}
			const attrs = new AttributeList(line.slice(TAG_PART.length), vars);
			const uri = stripQuotes(attrs.get('uri'));
			const duration = attrs.getAsNumber('duration');
			if (uri === null || duration === null) {
				throw new MalformedInputError('Invalid HLS media playlist: #EXT-X-PART requires URI and DURATION');
			}
			pendingParts.push({
				uri,
				duration,
				byteRange: parseByteRangeAttr(stripQuotes(attrs.get('byterange'))),
				independent: parseYesNo(attrs.get('independent'), '#EXT-X-PART INDEPENDENT'),
				gap: parseYesNo(attrs.get('gap'), '#EXT-X-PART GAP'),
			});
			continue;
		}
		if (line.startsWith(TAG_WMPACEINFO)) {
			out.wmPaceInfoUri = vars.substitute(stripQuotes(line.slice(TAG_WMPACEINFO.length)) ?? '');
			continue;
		}
		if (line.startsWith(TAG_PRELOAD_HINT)) {
			const attrs = new AttributeList(line.slice(TAG_PRELOAD_HINT.length), vars);
			const type = attrs.get('type');
			const uri = stripQuotes(attrs.get('uri'));
			if ((type !== 'PART' && type !== 'MAP') || uri === null) {
				throw new MalformedInputError(
					'Invalid HLS media playlist: #EXT-X-PRELOAD-HINT requires TYPE (PART or MAP) and URI',
				);
			}
			out.preloadHints.push({
				type,
				uri,
				byteRangeStart: attrs.getAsNumber('byterange-start'),
				byteRangeLength: attrs.getAsNumber('byterange-length'),
			});
			continue;
		}
		if (line.startsWith(TAG_EXTINF)) {
			const rest = line.slice(TAG_EXTINF.length);
			const commaIdx = rest.indexOf(',');
			if (commaIdx === -1) {
				throw new MalformedInputError(`Invalid HLS media playlist: #EXTINF needs a comma, got "${line}"`);
			}
			const durStr = rest.slice(0, commaIdx);
			pendingDuration = parseFiniteNumber(durStr);
			if (pendingDuration === null || pendingDuration < 0) {
				throw new MalformedInputError(
					`Invalid HLS media playlist: #EXTINF duration must be non-negative, got "${durStr}"`,
				);
			}
			pendingTitle = rest.slice(commaIdx + 1) || null;
			continue;
		}
		if (line.startsWith('#EXT')) {
			if (line !== '#EXTM3U') {
				noteUnmodelledTag(line, lineIndex, out.notes);
				pendingUnknownTags.push(line);
			}
			continue;
		}
		if (line.startsWith('#')) {
			// A comment per RFC 8216, but a relay still has to be able to write it back
			pendingUnknownTags.push(line);
			continue;
		}
		if (line.length === 0) {
			continue;
		}

		// A non-tag, non-comment, non-blank line is a segment URI.
		if (pendingDuration === null) {
			throw new MalformedInputError('Invalid HLS media playlist: segment URI without preceding #EXTINF');
		}
		out.segments.push({
			uri: vars.substitute(line),
			unknownTags: pendingUnknownTags,
			duration: pendingDuration,
			title: pendingTitle,
			tiles: pendingTiles,
			byteRange: pendingByteRange,
			programDateTime: pendingProgramDateTime,
			map: currentMap,
			keys: currentKeys,
			discontinuityBefore: pendingDiscontinuities > 0,
			discontinuitiesBefore: pendingDiscontinuities,
			parts: pendingParts,
			gap: pendingGap,
			bitrate: currentBitrate,
		});
		pendingDuration = null;
		pendingTitle = null;
		pendingTiles = null;
		pendingByteRange = null;
		pendingProgramDateTime = null;
		pendingDiscontinuities = 0;
		pendingParts = [];
		pendingGap = false;
		pendingUnknownTags = [];
	}

	// Anything still pending belonged to no segment: it sat before the first one, or after the last.
	out.unknownTags.push(...pendingUnknownTags);

	// 4.4.3.1: REQUIRED in a Media Playlist, and each segment's duration rounded to the nearest
	// integer MUST be within it — a player sizes its buffer from this.
	// 4.4.3.1 makes it REQUIRED, but it carries no sample data and the caller can see the null, so
	// refusing to read someone else's playlist over it would cost more than it gains. Said, not thrown.
	if (out.targetDuration === null) {
		out.notes.push({ kind: 'missing-target-duration' });
	}

	const target = out.targetDuration;
	const overrun = target === null
		? undefined
		: out.segments.find(segment => Math.round(segment.duration) > target);
	if (overrun !== undefined) {
		out.notes.push({
			kind: 'segment-past-target-duration',
			uri: overrun.uri,
			duration: overrun.duration,
			targetDuration: target!,
		});
	}

	out.trailingParts = pendingParts;

	return out;
};

const stripQuotes = (value: string | null): string | null => {
	if (value === null) {
		return null;
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
};

const parseTileLayout = (value: string | null): HlsTiles['layout'] | null => {
	if (value === null) {
		return null;
	}

	const match = /^(\d+)x(\d+)$/i.exec(value.trim());
	if (!match) {
		return null;
	}

	const columns = Number(match[1]);
	const rows = Number(match[2]);
	// The spec's minimum is 1x1; a zero would make the grid describe no tiles at all.
	return columns > 0 && rows > 0 ? { columns, rows } : null;
};

const parseResolution = (value: string | null): { width: number; height: number } | null => {
	if (value === null) {
		return null;
	}
	const match = /^(\d+)x(\d+)$/i.exec(value.trim());
	if (!match) {
		return null;
	}
	return { width: Number(match[1]), height: Number(match[2]) };
};

/**
 * Parse an HLS `CHANNELS` attribute to a channel count — the leading integer before any `/`
 * parameter (e.g. `"6/JOC"` → 6). Returns `null` for absent or non-positive-integer values.
 *
 * @group HLS
 * @public
 */
export const parseChannelCount = (channels: string | null): number | null => {
	if (channels === null) {
		return null;
	}
	const parsed = Number(channels.split('/')[0]!);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseByteRangeAttr = (value: string | null): { length: number; offset: number | null } | null => {
	if (value === null) {
		return null;
	}
	const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
	if (!match) {
		return null;
	}
	return {
		length: Number(match[1]),
		offset: match[2] !== undefined ? Number(match[2]) : null,
	};
};

const parseKeyFormatVersions = (value: string | null): number[] => {
	if (value === null) {
		return []; // absent, not "1": writing it back would invent an attribute the input never had
	}
	return value.split('/').map(v => Number(v)).filter(v => Number.isFinite(v));
};

const parseFiniteNumber = (value: string): number | null => {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

const parseYesNo = (value: string | null, attrName: string): boolean => {
	if (value === null) {
		return false;
	}
	const normalized = value.toUpperCase();
	if (normalized === 'YES') {
		return true;
	}
	if (normalized === 'NO') {
		return false;
	}
	throw new MalformedInputError(`Invalid ${attrName} attribute: must be YES or NO, got "${value}".`);
};

// HLS states these as absent / YES / NO. Absent is not the same as NO on the write side: re-emitting `NO`
// where the source said `NO` is what keeps a round-trip byte-exact, so the absent case stays distinguishable.
const parseYesNoOptional = (value: string | null, attrName: string): boolean | null =>
	value === null ? null : parseYesNo(value, attrName);
