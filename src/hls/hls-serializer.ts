/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InvalidUsageError } from '../errors';
import { hlsVersionOf } from './hls-version';
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
	TAG_IMAGES_ONLY,
	TAG_KEY,
	TAG_MEDIA_SEQUENCE,
	TAG_BITRATE,
	TAG_DISCONTINUITY_SEQUENCE,
	TAG_GAP,
	TAG_PLAYLIST_TYPE,
	TAG_TARGETDURATION,
	TAG_WMPACEINFO,
} from './hls-misc';
import type { HlsEncryptionMethod } from './hls-types';
import { Tag } from './hls-tag';
import type {
	HlsContentSteering,
	HlsImageStream,
	HlsTiles,
	HlsDateRange,
	HlsIFrameStream,
	HlsKey,
	HlsMap,
	HlsMasterPlaylist,
	HlsMediaPlaylistAst,
	HlsMediaRendition,
	HlsPart,
	HlsPlaylist,
	HlsPreloadHint,
	HlsRenditionReport,
	HlsSegment,
	HlsServerControl,
	HlsSkip,
	HlsSessionData,
	HlsStart,
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
	if (m.default !== null) {
		tag.addString('DEFAULT', m.default ? 'YES' : 'NO');
	}
	if (m.autoselect !== null) {
		tag.addString('AUTOSELECT', m.autoselect ? 'YES' : 'NO');
	}
	if (m.forced !== null) {
		tag.addString('FORCED', m.forced ? 'YES' : 'NO');
	}
	if (m.channels) {
		tag.addQuotedString('CHANNELS', m.channels);
	}
	if (m.characteristics) {
		tag.addQuotedString('CHARACTERISTICS', m.characteristics);
	}
	if (m.stableRenditionId) {
		tag.addQuotedString('STABLE-RENDITION-ID', m.stableRenditionId);
	}
	if (m.instreamId) {
		tag.addQuotedString('INSTREAM-ID', m.instreamId);
	}
	if (m.bitDepth !== null) {
		tag.addNumber('BIT-DEPTH', m.bitDepth);
	}
	if (m.sampleRate !== null) {
		tag.addNumber('SAMPLE-RATE', m.sampleRate);
	}
	if (m.resolution) {
		tag.addNumberPair('RESOLUTION', m.resolution.width, 'x', m.resolution.height);
	}
	if (m.watermarkingVariant) {
		tag.addQuotedString('WATERMARKING-VARIANT', m.watermarkingVariant);
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
	if (v.supplementalCodecs) {
		tag.addQuotedString('SUPPLEMENTAL-CODECS', v.supplementalCodecs);
	}
	if (v.score !== null) {
		tag.addFloat('SCORE', v.score);
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
	if (v.stableVariantId) {
		tag.addQuotedString('STABLE-VARIANT-ID', v.stableVariantId);
	}
	if (v.pathwayId) {
		tag.addQuotedString('PATHWAY-ID', v.pathwayId);
	}
	if (v.allowedCpc) {
		tag.addQuotedString('ALLOWED-CPC', v.allowedCpc);
	}
	if (v.reqVideoLayout) {
		tag.addQuotedString('REQ-VIDEO-LAYOUT', v.reqVideoLayout);
	}
	if (v.watermarkingVariant) {
		tag.addQuotedString('WATERMARKING-VARIANT', v.watermarkingVariant);
	}
	return tag;
};

const imageStreamInf = (s: HlsImageStream): Tag => {
	const tag = new Tag('#EXT-X-IMAGE-STREAM-INF');
	tag.addNumber('BANDWIDTH', s.bandwidth);
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

const tilesTag = (t: HlsTiles): Tag => {
	const tag = new Tag('#EXT-X-TILES');
	tag.addNumberPair('RESOLUTION', t.resolution.width, 'x', t.resolution.height);
	tag.addNumberPair('LAYOUT', t.layout.columns, 'x', t.layout.rows);
	tag.addFloat('DURATION', t.duration);
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
	if (s.supplementalCodecs) {
		tag.addQuotedString('SUPPLEMENTAL-CODECS', s.supplementalCodecs);
	}
	if (s.score !== null) {
		tag.addFloat('SCORE', s.score);
	}
	if (s.resolution) {
		tag.addNumberPair('RESOLUTION', s.resolution.width, 'x', s.resolution.height);
	}
	if (s.videoRange) {
		tag.addString('VIDEO-RANGE', s.videoRange);
	}
	if (s.hdcpLevel) {
		tag.addString('HDCP-LEVEL', s.hdcpLevel);
	}
	if (s.allowedCpc) {
		tag.addQuotedString('ALLOWED-CPC', s.allowedCpc);
	}
	if (s.reqVideoLayout) {
		tag.addQuotedString('REQ-VIDEO-LAYOUT', s.reqVideoLayout);
	}
	if (s.videoGroup) {
		tag.addQuotedString('VIDEO', s.videoGroup);
	}
	if (s.stableVariantId) {
		tag.addQuotedString('STABLE-VARIANT-ID', s.stableVariantId);
	}
	if (s.pathwayId) {
		tag.addQuotedString('PATHWAY-ID', s.pathwayId);
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

const partTag = (part: HlsPart): string => {
	const tag = new Tag('#EXT-X-PART');
	tag.addFloat('DURATION', part.duration);
	tag.addQuotedString('URI', part.uri);
	const range = byteRangeValue(part.byteRange);
	if (range !== null) {
		tag.addQuotedString('BYTERANGE', range);
	}
	if (part.independent) {
		tag.addString('INDEPENDENT', 'YES');
	}
	if (part.gap) {
		tag.addString('GAP', 'YES');
	}
	return tag.toString();
};

const serverControlTag = (control: HlsServerControl): string => {
	const tag = new Tag('#EXT-X-SERVER-CONTROL');
	if (control.canBlockReload) {
		tag.addString('CAN-BLOCK-RELOAD', 'YES');
	}
	if (control.canSkipUntil !== null) {
		tag.addFloat('CAN-SKIP-UNTIL', control.canSkipUntil);
	}
	if (control.canSkipDateRanges) {
		tag.addString('CAN-SKIP-DATERANGES', 'YES');
	}
	if (control.holdBack !== null) {
		tag.addFloat('HOLD-BACK', control.holdBack);
	}
	if (control.partHoldBack !== null) {
		tag.addFloat('PART-HOLD-BACK', control.partHoldBack);
	}
	return tag.toString();
};

const preloadHintTag = (hint: HlsPreloadHint): string => {
	const tag = new Tag('#EXT-X-PRELOAD-HINT');
	tag.addString('TYPE', hint.type);
	tag.addQuotedString('URI', hint.uri);
	if (hint.byteRangeStart !== null) {
		tag.addNumber('BYTERANGE-START', hint.byteRangeStart);
	}
	if (hint.byteRangeLength !== null) {
		tag.addNumber('BYTERANGE-LENGTH', hint.byteRangeLength);
	}
	return tag.toString();
};

const startTag = (start: HlsStart): Tag => {
	const tag = new Tag('#EXT-X-START');
	tag.addFloat('TIME-OFFSET', start.timeOffset);
	if (start.precise !== null) {
		tag.addString('PRECISE', start.precise ? 'YES' : 'NO');
	}

	return tag;
};

const sessionKeyTag = (k: HlsKey): Tag => {
	const tag = new Tag('#EXT-X-SESSION-KEY');
	tag.addString('METHOD', k.method);
	if (k.uri) {
		tag.addQuotedString('URI', k.uri);
	}
	if (k.iv) {
		tag.addString('IV', k.iv);
	}
	if (k.keyId) {
		tag.addString('KEYID', k.keyId);
	}
	if (k.keyFormat !== 'identity') {
		tag.addQuotedString('KEYFORMAT', k.keyFormat);
	}
	if (k.keyFormatVersions.length > 0) {
		tag.addQuotedString('KEYFORMATVERSIONS', k.keyFormatVersions.join('/'));
	}

	return tag;
};

const sessionDataTag = (d: HlsSessionData): Tag => {
	const tag = new Tag('#EXT-X-SESSION-DATA');
	tag.addQuotedString('DATA-ID', d.dataId);
	if (d.value !== null) {
		tag.addQuotedString('VALUE', d.value);
	}
	if (d.uri !== null) {
		tag.addQuotedString('URI', d.uri);
	}
	if (d.format !== null) {
		tag.addString('FORMAT', d.format);
	}
	if (d.language !== null) {
		tag.addQuotedString('LANGUAGE', d.language);
	}

	return tag;
};

const contentSteeringTag = (c: HlsContentSteering): Tag => {
	const tag = new Tag('#EXT-X-CONTENT-STEERING');
	tag.addQuotedString('SERVER-URI', c.serverUri);
	if (c.pathwayId !== null) {
		tag.addQuotedString('PATHWAY-ID', c.pathwayId);
	}

	return tag;
};

const dateRangeTag = (d: HlsDateRange): Tag => {
	const tag = new Tag('#EXT-X-DATERANGE');
	tag.addQuotedString('ID', d.id);
	if (d.className !== null) {
		tag.addQuotedString('CLASS', d.className);
	}
	tag.addQuotedString('START-DATE', d.startDate);
	if (d.cue !== null) {
		tag.addString('CUE', d.cue);
	}
	if (d.endDate !== null) {
		tag.addQuotedString('END-DATE', d.endDate);
	}
	if (d.duration !== null) {
		tag.addFloat('DURATION', d.duration);
	}
	if (d.plannedDuration !== null) {
		tag.addFloat('PLANNED-DURATION', d.plannedDuration);
	}
	if (d.endOnNext) {
		tag.addString('END-ON-NEXT', 'YES');
	}
	const scte35 = [
		['SCTE35-CMD', d.scte35Cmd],
		['SCTE35-OUT', d.scte35Out],
		['SCTE35-IN', d.scte35In],
	] as const;
	for (const [key, value] of scte35) {
		if (value !== null) {
			tag.addString(key, value);
		}
	}
	for (const [key, attribute] of Object.entries(d.clientAttributes)) {
		if (attribute.type === 'string') {
			tag.addQuotedString(key, attribute.value);
		} else if (attribute.type === 'hex') {
			tag.addString(key, attribute.value);
		} else {
			tag.addFloat(key, attribute.value);
		}
	}

	return tag;
};

const skipTag = (skip: HlsSkip): string => {
	const tag = new Tag('#EXT-X-SKIP');
	tag.addNumber('SKIPPED-SEGMENTS', skip.skippedSegments);
	if (skip.recentlyRemovedDateRanges !== null) {
		// Present but empty is meaningful: the spec allows it and REQUIRES the attribute once any
		// daterange was skipped. The IDs are tab-delimited inside one quoted string.
		tag.addQuotedString('RECENTLY-REMOVED-DATERANGES', skip.recentlyRemovedDateRanges.join('\t'));
	}

	return tag.toString();
};

const renditionReportTag = (report: HlsRenditionReport): string => {
	const tag = new Tag('#EXT-X-RENDITION-REPORT');
	tag.addQuotedString('URI', report.uri);
	if (report.lastMsn !== null) {
		tag.addNumber('LAST-MSN', report.lastMsn);
	}
	if (report.lastPart !== null) {
		tag.addNumber('LAST-PART', report.lastPart);
	}

	return tag.toString();
};

/**
 * The `#EXT-X-VERSION` to write. Section 8 says a playlist using anything past version 1 MUST carry
 * the tag, and a client MUST NOT play a version it does not support — so a stated version too low
 * for the content is a playlist that lies about itself, and is refused rather than written.
 */
const requiredVersion = (playlist: HlsPlaylist): number | null => {
	const needed = hlsVersionOf(playlist);
	if (playlist.version === null) {
		return needed > 1 ? needed : null;
	}

	if (playlist.version < needed) {
		throw new InvalidUsageError(
			`This playlist states EXT-X-VERSION ${playlist.version} but its content requires ${needed}.`
			+ ' Raise the version, or drop the feature that needs it.',
		);
	}

	return playlist.version;
};

const serializeHlsMaster = (m: HlsMasterPlaylist): string => {
	const lines: string[] = ['#EXTM3U'];
	const version = requiredVersion(m);
	if (version !== null) {
		lines.push(`#EXT-X-VERSION:${version}`);
	}
	lines.push(...m.unknownTags);
	if (m.independentSegments) {
		lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
	}
	if (m.start) {
		lines.push(startTag(m.start).toString());
	}
	for (const key of m.sessionKeys) {
		lines.push(sessionKeyTag(key).toString());
	}
	for (const data of m.sessionData) {
		lines.push(sessionDataTag(data).toString());
	}
	if (m.contentSteering) {
		lines.push(contentSteeringTag(m.contentSteering).toString());
	}
	for (const media of m.media) {
		lines.push(mediaTag(media).toString());
	}
	for (const variant of m.variants) {
		lines.push(streamInf(variant).toString(), variant.uri);
	}
	for (const stream of m.imageStreams) {
		lines.push(imageStreamInf(stream).toString());
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
const segmentLines = (
	seg: HlsSegment,
	prev: { keys: HlsKey[]; map: HlsMap | null; bitrate: number | null },
): string[] => {
	const out: string[] = [];
	// Each tag counts towards the discontinuity sequence number of every segment after it, so a run
	// of them cannot be collapsed into one
	for (let i = 0; i < Math.max(seg.discontinuitiesBefore, Number(seg.discontinuityBefore)); i++) {
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
	if (seg.bitrate !== null && seg.bitrate !== prev.bitrate) {
		out.push(`${TAG_BITRATE}${seg.bitrate}`);
		prev.bitrate = seg.bitrate;
	}
	if (seg.gap) {
		out.push(TAG_GAP);
	}
	// Before the segment's own tags, which is where they were read from
	out.push(...seg.unknownTags);
	out.push(...seg.parts.map(partTag));
	const range = byteRangeValue(seg.byteRange);
	if (range !== null) {
		out.push(`${TAG_BYTERANGE}${range}`);
	}
	if (!Number.isFinite(seg.duration) || seg.duration < 0) {
		throw new InvalidUsageError(
			`A segment duration must be a non-negative number; ${seg.uri} states ${seg.duration}.`,
		);
	}

	out.push(`${TAG_EXTINF}${formatExtInfDuration(seg.duration)},${seg.title ?? ''}`);
	if (seg.tiles) {
		out.push(tilesTag(seg.tiles).toString());
	}
	// A URI line is the line; a break in it turns the remainder into tags nobody wrote
	if (/[\r\n]/.test(seg.uri)) {
		throw new InvalidUsageError(`A segment URI cannot hold a line break; got ${JSON.stringify(seg.uri)}.`);
	}

	out.push(seg.uri);
	return out;
};

const serializeHlsMedia = (m: HlsMediaPlaylistAst): string => {
	const lines: string[] = ['#EXTM3U'];
	const version = requiredVersion(m);
	if (version !== null) {
		lines.push(`#EXT-X-VERSION:${version}`);
	}
	if (m.start) {
		lines.push(startTag(m.start).toString());
	}
	if (m.targetDuration !== null) {
		lines.push(`${TAG_TARGETDURATION}${m.targetDuration}`);
	}
	if (m.serverControl) {
		lines.push(serverControlTag(m.serverControl));
	}
	if (m.partTarget !== null) {
		lines.push(new Tag('#EXT-X-PART-INF').addFloat('PART-TARGET', m.partTarget).toString());
	}
	if (m.mediaSequence !== 0) {
		lines.push(`${TAG_MEDIA_SEQUENCE}${m.mediaSequence}`);
	}
	if (m.discontinuitySequence !== 0) {
		lines.push(`${TAG_DISCONTINUITY_SEQUENCE}${m.discontinuitySequence}`);
	}
	if (m.playlistType) {
		lines.push(`${TAG_PLAYLIST_TYPE}${m.playlistType}`);
	}
	if (m.iFramesOnly) {
		lines.push(TAG_I_FRAMES_ONLY);
	}
	if (m.imagesOnly) {
		lines.push(TAG_IMAGES_ONLY);
	}
	if (m.independentSegments) {
		lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
	}
	if (m.wmPaceInfoUri !== null) {
		lines.push(`${TAG_WMPACEINFO}"${m.wmPaceInfoUri}"`);
	}
	const prev: { keys: HlsKey[]; map: HlsMap | null; bitrate: number | null }
		= { keys: [], map: null, bitrate: null };
	if (m.skip) {
		lines.push(skipTag(m.skip));
	}
	lines.push(...m.dateRanges.map(d => dateRangeTag(d).toString()));
	lines.push(...m.unknownTags);
	for (const seg of m.segments) {
		lines.push(...segmentLines(seg, prev));
	}
	lines.push(...m.trailingParts.map(partTag), ...m.preloadHints.map(preloadHintTag));
	lines.push(...m.renditionReports.map(renditionReportTag));
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
 * Every tag and attribute defined by the HLS specification survives the round-trip. A tag outside it —
 * a vendor extension, or one from a newer revision — is not modelled and so is dropped here;
 * `parseHlsPlaylist` warns when it sees one, rather than losing it silently.
 *
 * @group HLS
 * @public
 */
export const serializeHls = (playlist: HlsPlaylist): string =>
	playlist.kind === 'master' ? serializeHlsMaster(playlist) : serializeHlsMedia(playlist);
