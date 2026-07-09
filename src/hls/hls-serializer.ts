/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	DiscontinuityEntry,
	EncryptionInfoEntry,
	formatExtInfDuration,
	ProgramDateTimeEntry,
} from './hls-entries';
import {
	TAG_BYTERANGE,
	TAG_ENDLIST,
	TAG_EXTINF,
	TAG_I_FRAMES_ONLY,
	TAG_KEY,
	TAG_MEDIA_SEQUENCE,
	TAG_PLAYLIST_TYPE,
	TAG_TARGETDURATION,
} from './hls-misc';
import type { HlsEncryptionMethod } from './hls-types';
import { Tag } from './hls-tag';
import type {
	HlsIFrameStream,
	HlsKey,
	HlsMap,
	HlsMasterPlaylist,
	HlsMediaPlaylistAst,
	HlsMediaRendition,
	HlsPlaylist,
	HlsSegment,
	HlsVariant,
} from './hls-playlist-parser';

const byteRangeValue = (b: { length: number; offset: number | null } | null): string | null => {
	if (b === null) {
		return null;
	}
	return b.offset === null ? `${b.length}` : `${b.length}@${b.offset}`;
};

const keysEqual = (a: HlsKey[], b: HlsKey[]): boolean =>
	a.length === b.length && a.every((k, i) => {
		const o = b[i]!;
		return k.method === o.method
			&& k.uri === o.uri
			&& k.iv === o.iv
			&& k.keyFormat === o.keyFormat
			&& k.keyFormatVersions.length === o.keyFormatVersions.length
			&& k.keyFormatVersions.every((v, j) => v === o.keyFormatVersions[j]);
	});

const mapsEqual = (a: HlsMap | null, b: HlsMap | null): boolean => {
	if (a === b) {
		return true;
	}
	if (a === null || b === null) {
		return false;
	}
	return a.uri === b.uri
		&& (a.byteRange?.length ?? null) === (b.byteRange?.length ?? null)
		&& (a.byteRange?.offset ?? null) === (b.byteRange?.offset ?? null);
};

const mediaTag = (m: HlsMediaRendition): Tag => {
	const tag = new Tag('#EXT-X-MEDIA');
	tag.addString('TYPE', m.type);
	tag.addQuotedString('GROUP-ID', m.groupId);
	tag.addQuotedString('NAME', m.name);
	if (m.language) {
		tag.addQuotedString('LANGUAGE', m.language);
	}
	if (m.assocLanguage) {
		tag.addQuotedString('ASSOC-LANGUAGE', m.assocLanguage);
	}
	if (m.uri) {
		tag.addQuotedString('URI', m.uri);
	}
	if (m.default) {
		tag.addString('DEFAULT', 'YES');
	}
	if (m.autoselect) {
		tag.addString('AUTOSELECT', 'YES');
	}
	if (m.forced) {
		tag.addString('FORCED', 'YES');
	}
	if (m.channels) {
		tag.addQuotedString('CHANNELS', m.channels);
	}
	if (m.characteristics) {
		tag.addQuotedString('CHARACTERISTICS', m.characteristics);
	}
	if (m.resolution) {
		tag.addNumberPair('RESOLUTION', m.resolution.width, 'x', m.resolution.height);
	}
	return tag;
};

const streamInf = (v: HlsVariant): Tag => {
	const tag = new Tag('#EXT-X-STREAM-INF');
	tag.addNumber('BANDWIDTH', v.bandwidth);
	if (v.averageBandwidth !== null) {
		tag.addNumber('AVERAGE-BANDWIDTH', v.averageBandwidth);
	}
	if (v.codecs) {
		tag.addQuotedString('CODECS', v.codecs);
	}
	if (v.resolution) {
		tag.addNumberPair('RESOLUTION', v.resolution.width, 'x', v.resolution.height);
	}
	if (v.frameRate !== null) {
		tag.addFloat('FRAME-RATE', v.frameRate);
	}
	if (v.videoRange) {
		tag.addString('VIDEO-RANGE', v.videoRange);
	}
	if (v.hdcpLevel) {
		tag.addString('HDCP-LEVEL', v.hdcpLevel);
	}
	if (v.audioGroup) {
		tag.addQuotedString('AUDIO', v.audioGroup);
	}
	if (v.videoGroup) {
		tag.addQuotedString('VIDEO', v.videoGroup);
	}
	if (v.subtitlesGroup) {
		tag.addQuotedString('SUBTITLES', v.subtitlesGroup);
	}
	// CLOSED-CAPTIONS is either a quoted group id or the bare enum NONE.
	if (v.closedCaptionsGroup === 'NONE') {
		tag.addString('CLOSED-CAPTIONS', 'NONE');
	} else if (v.closedCaptionsGroup) {
		tag.addQuotedString('CLOSED-CAPTIONS', v.closedCaptionsGroup);
	}
	if (v.name) {
		tag.addQuotedString('NAME', v.name);
	}
	if (v.channels) {
		tag.addQuotedString('CHANNELS', v.channels);
	}
	return tag;
};

const iFrameStreamInf = (s: HlsIFrameStream): Tag => {
	const tag = new Tag('#EXT-X-I-FRAME-STREAM-INF');
	tag.addNumber('BANDWIDTH', s.bandwidth);
	if (s.averageBandwidth !== null) {
		tag.addNumber('AVERAGE-BANDWIDTH', s.averageBandwidth);
	}
	if (s.codecs) {
		tag.addQuotedString('CODECS', s.codecs);
	}
	if (s.resolution) {
		tag.addNumberPair('RESOLUTION', s.resolution.width, 'x', s.resolution.height);
	}
	if (s.videoGroup) {
		tag.addQuotedString('VIDEO', s.videoGroup);
	}
	tag.addQuotedString('URI', s.uri);
	return tag;
};

const keyTag = (k: HlsKey): string =>
	new EncryptionInfoEntry(
		k.method as HlsEncryptionMethod,
		k.uri ?? '',
		k.keyId ?? '',
		k.iv ?? '',
		k.keyFormat === 'identity' ? '' : k.keyFormat,
		k.keyFormatVersions.join('/'),
	).toString();

const mapTag = (map: HlsMap): Tag => {
	const tag = new Tag('#EXT-X-MAP');
	tag.addQuotedString('URI', map.uri);
	const range = byteRangeValue(map.byteRange);
	if (range !== null) {
		tag.addQuotedString('BYTERANGE', range);
	}
	return tag;
};

const serializeHlsMaster = (m: HlsMasterPlaylist): string => {
	const lines: string[] = ['#EXTM3U'];
	if (m.version !== null) {
		lines.push(`#EXT-X-VERSION:${m.version}`);
	}
	if (m.independentSegments) {
		lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
	}
	for (const media of m.media) {
		lines.push(mediaTag(media).toString());
	}
	for (const variant of m.variants) {
		lines.push(streamInf(variant).toString(), variant.uri);
	}
	for (const stream of m.iFrameStreams) {
		lines.push(iFrameStreamInf(stream).toString());
	}
	return `${lines.join('\n')}\n`;
};

/**
 * `#EXT-X-KEY` and `#EXT-X-MAP` are sticky (they apply until the next one), so
 * emit them only when they change. A segment can carry several keys at once
 * (one per KEYFORMAT) for multi-DRM.
 */
const segmentLines = (seg: HlsSegment, prev: { keys: HlsKey[]; map: HlsMap | null }): string[] => {
	const out: string[] = [];
	if (seg.discontinuityBefore) {
		out.push(new DiscontinuityEntry().toString());
	}
	if (!keysEqual(seg.keys, prev.keys)) {
		if (seg.keys.length === 0) {
			out.push(`${TAG_KEY}METHOD=NONE`);
		} else {
			for (const key of seg.keys) {
				out.push(keyTag(key));
			}
		}
		prev.keys = seg.keys;
	}
	if (seg.map && !mapsEqual(seg.map, prev.map)) {
		out.push(mapTag(seg.map).toString());
		prev.map = seg.map;
	}
	if (seg.programDateTime !== null) {
		out.push(new ProgramDateTimeEntry(seg.programDateTime).toString());
	}
	const range = byteRangeValue(seg.byteRange);
	if (range !== null) {
		out.push(`${TAG_BYTERANGE}${range}`);
	}
	out.push(`${TAG_EXTINF}${formatExtInfDuration(seg.duration)},${seg.title ?? ''}`, seg.uri);
	return out;
};

const serializeHlsMedia = (m: HlsMediaPlaylistAst): string => {
	const lines: string[] = ['#EXTM3U'];
	if (m.version !== null) {
		lines.push(`#EXT-X-VERSION:${m.version}`);
	}
	if (m.targetDuration !== null) {
		lines.push(`${TAG_TARGETDURATION}${m.targetDuration}`);
	}
	if (m.mediaSequence !== 0) {
		lines.push(`${TAG_MEDIA_SEQUENCE}${m.mediaSequence}`);
	}
	if (m.playlistType) {
		lines.push(`${TAG_PLAYLIST_TYPE}${m.playlistType}`);
	}
	if (m.iFramesOnly) {
		lines.push(TAG_I_FRAMES_ONLY);
	}
	if (m.independentSegments) {
		lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
	}
	const prev: { keys: HlsKey[]; map: HlsMap | null } = { keys: [], map: null };
	for (const seg of m.segments) {
		lines.push(...segmentLines(seg, prev));
	}
	if (m.endlist) {
		lines.push(TAG_ENDLIST);
	}
	return `${lines.join('\n')}\n`;
};

/**
 * Serialize an {@link HlsPlaylist} AST back to HLS text — the write half of the
 * `parseHlsPlaylist` → mutate → `serializeHls` round-trip.
 *
 * `#EXTINF` durations and `FRAME-RATE` are normalized to 3 decimals — lossless
 * for millisecond-precision manifests and idempotent, so the AST is stable
 * across repeated round-trips.
 *
 * @group HLS
 * @public
 */
export const serializeHls = (playlist: HlsPlaylist): string =>
	playlist.kind === 'master' ? serializeHlsMaster(playlist) : serializeHlsMedia(playlist);
