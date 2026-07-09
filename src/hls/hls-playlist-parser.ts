/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AttributeList,
	TAG_BYTERANGE,
	TAG_DISCONTINUITY,
	TAG_ENDLIST,
	TAG_EXTINF,
	TAG_I_FRAME_STREAM_INF,
	TAG_I_FRAMES_ONLY,
	TAG_KEY,
	TAG_MAP,
	TAG_MEDIA,
	TAG_MEDIA_SEQUENCE,
	TAG_PLAYLIST_TYPE,
	TAG_PROGRAM_DATE_TIME,
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
	/** 0-based line index in the source playlist where the `#EXT-X-STREAM-INF` tag appears. */
	lineNumber: number;
};

/** A `#EXT-X-I-FRAME-STREAM-INF` entry. @group HLS @public */
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
	/** `VIDEO` group ID reference. */
	videoGroup: string | null;
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
	default: boolean;
	/** `AUTOSELECT` flag. */
	autoselect: boolean;
	/** `FORCED` flag (subtitles only). */
	forced: boolean;
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
	/** `#EXT-X-MEDIA` entries in document order. */
	media: HlsMediaRendition[];
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

/** A segment in a media playlist. @group HLS @public */
export type HlsSegment = {
	/** Segment URI. */
	uri: string;
	/** `#EXTINF` duration in seconds. */
	duration: number;
	/** Optional `#EXTINF` title. */
	title: string | null;
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
	/** `#EXT-X-PLAYLIST-TYPE` enum (VOD / EVENT), or `null`. */
	playlistType: 'VOD' | 'EVENT' | null;
	/** `#EXT-X-I-FRAMES-ONLY` presence flag. */
	iFramesOnly: boolean;
	/** `#EXT-X-ENDLIST` presence flag (VOD-complete signal). */
	endlist: boolean;
	/** `#EXT-X-INDEPENDENT-SEGMENTS` presence flag. */
	independentSegments: boolean;
	/** Segments in document order. */
	segments: HlsSegment[];
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
export const parseHlsPlaylist = (text: string): HlsPlaylist => {
	const lines = text.split('\n').map(l => l.trim());
	if (lines.length === 0 || lines[0] !== '#EXTM3U') {
		throw new Error('Invalid HLS playlist: must start with #EXTM3U');
	}

	const isMaster = lines.some(l =>
		l.startsWith(TAG_STREAM_INF) || l.startsWith(TAG_I_FRAME_STREAM_INF) || l.startsWith(TAG_MEDIA));

	return isMaster ? parseMaster(lines) : parseMedia(lines);
};

const INDEPENDENT_SEGMENTS = '#EXT-X-INDEPENDENT-SEGMENTS';
const EXT_X_VERSION = '#EXT-X-VERSION:';
const EXT_X_DISCONTINUITY_SEQUENCE = '#EXT-X-DISCONTINUITY-SEQUENCE:';

const parseMaster = (lines: string[]): HlsMasterPlaylist => {
	const out: HlsMasterPlaylist = {
		kind: 'master',
		version: null,
		independentSegments: false,
		variants: [],
		iFrameStreams: [],
		media: [],
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (canIgnoreLine(line)) {
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
		if (line.startsWith(TAG_STREAM_INF)) {
			const attrs = new AttributeList(line.slice(TAG_STREAM_INF.length));
			const uri = lines[i + 1];
			if (uri === undefined || uri.length === 0 || uri.startsWith('#')) {
				throw new Error('Invalid HLS master playlist: #EXT-X-STREAM-INF must be followed by a URI line');
			}
			const bandwidth = attrs.getAsNumber('bandwidth');
			if (bandwidth === null) {
				throw new Error('Invalid HLS master playlist: #EXT-X-STREAM-INF requires BANDWIDTH');
			}
			out.variants.push({
				uri,
				bandwidth,
				averageBandwidth: attrs.getAsNumber('average-bandwidth'),
				codecs: stripQuotes(attrs.get('codecs')),
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
			i++;
			continue;
		}
		if (line.startsWith(TAG_I_FRAME_STREAM_INF)) {
			const attrs = new AttributeList(line.slice(TAG_I_FRAME_STREAM_INF.length));
			const uri = stripQuotes(attrs.get('uri'));
			if (uri === null) {
				throw new Error('Invalid HLS master playlist: #EXT-X-I-FRAME-STREAM-INF requires URI');
			}
			const bandwidth = attrs.getAsNumber('bandwidth');
			if (bandwidth === null) {
				throw new Error('Invalid HLS master playlist: #EXT-X-I-FRAME-STREAM-INF requires BANDWIDTH');
			}
			out.iFrameStreams.push({
				uri,
				bandwidth,
				averageBandwidth: attrs.getAsNumber('average-bandwidth'),
				codecs: stripQuotes(attrs.get('codecs')),
				resolution: parseResolution(attrs.get('resolution')),
				videoGroup: stripQuotes(attrs.get('video')),
				lineNumber: i,
			});
			continue;
		}
		if (line.startsWith(TAG_MEDIA)) {
			const attrs = new AttributeList(line.slice(TAG_MEDIA.length));
			const type = attrs.get('type');
			const groupId = stripQuotes(attrs.get('group-id'));
			const name = stripQuotes(attrs.get('name'));
			if (type === null || groupId === null || name === null) {
				throw new Error('Invalid HLS master playlist: #EXT-X-MEDIA requires TYPE, GROUP-ID, NAME');
			}
			if (type !== 'AUDIO' && type !== 'VIDEO' && type !== 'SUBTITLES' && type !== 'CLOSED-CAPTIONS') {
				throw new Error(`Invalid HLS master playlist: unrecognized #EXT-X-MEDIA TYPE "${type}"`);
			}
			out.media.push({
				type,
				groupId,
				name,
				language: stripQuotes(attrs.get('language')),
				assocLanguage: stripQuotes(attrs.get('assoc-language')),
				uri: stripQuotes(attrs.get('uri')),
				default: parseYesNo(attrs.get('default'), 'DEFAULT'),
				autoselect: parseYesNo(attrs.get('autoselect'), 'AUTOSELECT'),
				forced: parseYesNo(attrs.get('forced'), 'FORCED'),
				channels: stripQuotes(attrs.get('channels')),
				characteristics: stripQuotes(attrs.get('characteristics')),
				resolution: parseResolution(attrs.get('resolution')),
				lineNumber: i,
			});
			continue;
		}
	}

	return out;
};

const parseMedia = (lines: string[]): HlsMediaPlaylistAst => {
	const out: HlsMediaPlaylistAst = {
		kind: 'media',
		version: null,
		targetDuration: null,
		mediaSequence: 0,
		playlistType: null,
		iFramesOnly: false,
		endlist: false,
		independentSegments: false,
		segments: [],
	};

	let pendingDuration: number | null = null;
	let pendingTitle: string | null = null;
	let pendingByteRange: { length: number; offset: number | null } | null = null;
	let pendingProgramDateTime: number | null = null;
	let pendingDiscontinuity = false;
	let currentMap: HlsMap | null = null;
	let currentKeys: HlsKey[] = [];

	for (const rawLine of lines) {
		const line = rawLine;
		if (canIgnoreLine(line)) {
			continue;
		}

		if (line.startsWith(EXT_X_VERSION)) {
			out.version = parseFiniteNumber(line.slice(EXT_X_VERSION.length));
			continue;
		}
		if (line.startsWith(TAG_TARGETDURATION)) {
			out.targetDuration = parseFiniteNumber(line.slice(TAG_TARGETDURATION.length));
			continue;
		}
		if (line.startsWith(TAG_MEDIA_SEQUENCE)) {
			const v = parseFiniteNumber(line.slice(TAG_MEDIA_SEQUENCE.length));
			if (v !== null) {
				out.mediaSequence = v;
			}
			continue;
		}
		if (line.startsWith(EXT_X_DISCONTINUITY_SEQUENCE)) {
			// Skipped — not part of the AST surface.
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
		if (line === TAG_ENDLIST) {
			out.endlist = true;
			continue;
		}
		if (line === INDEPENDENT_SEGMENTS) {
			out.independentSegments = true;
			continue;
		}
		if (line.startsWith(TAG_MAP)) {
			const attrs = new AttributeList(line.slice(TAG_MAP.length));
			const uri = stripQuotes(attrs.get('uri'));
			if (uri === null) {
				throw new Error('Invalid HLS media playlist: #EXT-X-MAP requires URI');
			}
			currentMap = { uri, byteRange: parseByteRangeAttr(stripQuotes(attrs.get('byterange'))) };
			continue;
		}
		if (line.startsWith(TAG_KEY)) {
			const attrs = new AttributeList(line.slice(TAG_KEY.length));
			const method = attrs.get('method');
			if (method === null) {
				throw new Error('Invalid HLS media playlist: #EXT-X-KEY requires METHOD');
			}
			if (method === 'NONE') {
				currentKeys = [];
			} else {
				const key: HlsKey = {
					method,
					uri: stripQuotes(attrs.get('uri')),
					iv: attrs.get('iv'),
					keyId: attrs.get('keyid'),
					keyFormat: stripQuotes(attrs.get('keyformat')) ?? 'identity',
					keyFormatVersions: parseKeyFormatVersions(stripQuotes(attrs.get('keyformatversions'))),
				};
				// A new key supersedes the prior one of the same KEYFORMAT; different formats coexist (multi-DRM).
				currentKeys = [...currentKeys.filter(k => k.keyFormat !== key.keyFormat), key];
			}
			continue;
		}
		if (line === TAG_DISCONTINUITY) {
			pendingDiscontinuity = true;
			continue;
		}
		if (line.startsWith(TAG_PROGRAM_DATE_TIME)) {
			const v = Date.parse(line.slice(TAG_PROGRAM_DATE_TIME.length));
			pendingProgramDateTime = Number.isFinite(v) ? v : null;
			continue;
		}
		if (line.startsWith(TAG_BYTERANGE)) {
			pendingByteRange = parseByteRangeAttr(line.slice(TAG_BYTERANGE.length));
			continue;
		}
		if (line.startsWith(TAG_EXTINF)) {
			const rest = line.slice(TAG_EXTINF.length);
			const commaIdx = rest.indexOf(',');
			const durStr = commaIdx === -1 ? rest : rest.slice(0, commaIdx);
			pendingDuration = parseFiniteNumber(durStr);
			pendingTitle = commaIdx === -1 ? null : rest.slice(commaIdx + 1) || null;
			continue;
		}
		if (line.startsWith('#EXT')) {
			// Unknown tag — ignored. Callers wanting full fidelity should walk the
			// raw text themselves.
			continue;
		}
		if (line.length === 0 || line.startsWith('#')) {
			continue;
		}

		// A non-tag, non-comment, non-blank line is a segment URI.
		if (pendingDuration === null) {
			throw new Error('Invalid HLS media playlist: segment URI without preceding #EXTINF');
		}
		out.segments.push({
			uri: line,
			duration: pendingDuration,
			title: pendingTitle,
			byteRange: pendingByteRange,
			programDateTime: pendingProgramDateTime,
			map: currentMap,
			keys: currentKeys,
			discontinuityBefore: pendingDiscontinuity,
		});
		pendingDuration = null;
		pendingTitle = null;
		pendingByteRange = null;
		pendingProgramDateTime = null;
		pendingDiscontinuity = false;
	}

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
		return [1];
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
	throw new Error(`Invalid #EXT-X-MEDIA ${attrName} attribute: must be YES or NO, got "${value}".`);
};
