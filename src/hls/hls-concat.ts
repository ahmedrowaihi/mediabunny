/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	TAG_BYTERANGE,
	TAG_DISCONTINUITY,
	TAG_ENDLIST,
	TAG_EXTINF,
	TAG_KEY,
	TAG_MAP,
	TAG_MEDIA,
	TAG_PROGRAM_DATE_TIME,
	TAG_STREAM_INF,
	TAG_TARGETDURATION,
} from './hls-misc';

/** One input media playlist for {@link concatHlsMediaPlaylists}. @group HLS @public */
export type HlsMediaPlaylistConcatInput = {
	/** Source media playlist text. */
	content: string;
	/**
	 * Optional path prefix prepended to relative segment URIs and to relative
	 * `URI=` attributes inside `#EXT-X-MAP`. Absolute URIs and scheme-prefixed
	 * URIs (`https://…`) pass through unchanged.
	 */
	pathPrefix?: string;
};

/** Result of {@link concatHlsMediaPlaylists}. @group HLS @public */
export type HlsMediaPlaylistConcatResult = {
	/** Serialized output media playlist. */
	content: string;
};

/**
 * Concatenate HLS media playlists. This is a low-level building block: no
 * filtering, rendition merging, or discontinuity insertion is performed.
 *
 * The first input is the canonical header source: its leading non-segment
 * lines (everything before the first `#EXTINF`, `#EXT-X-MAP`, `#EXT-X-KEY`,
 * `#EXT-X-DISCONTINUITY`, `#EXT-X-PROGRAM-DATE-TIME`, `#EXT-X-BYTERANGE`, or
 * segment URI line) are preserved verbatim, including `#EXT-X-VERSION`,
 * `#EXT-X-PLAYLIST-TYPE`, `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-INDEPENDENT-SEGMENTS`,
 * `#EXT-X-START`, custom comments, and any unknown tags. The only mutation
 * applied is overwriting `#EXT-X-TARGETDURATION` (or inserting it after
 * `#EXTM3U` if absent) with the maximum value declared across all inputs.
 *
 * Each input's body (everything after its own header) is appended in order
 * with segment URIs and `#EXT-X-MAP@URI` rewritten via the input's
 * `pathPrefix` when supplied. Trailing `#EXT-X-ENDLIST` lines in inputs are
 * dropped; a single `#EXT-X-ENDLIST` is appended at the end.
 *
 * @group HLS @public
 */
export const concatHlsMediaPlaylists = (inputs: HlsMediaPlaylistConcatInput[]): HlsMediaPlaylistConcatResult => {
	if (inputs.length === 0) {
		throw new Error('concatHlsMediaPlaylists: at least one input is required');
	}

	let maxTargetDuration = 0;
	const bodies: string[] = [];
	const allTargetDurations: number[] = [];

	for (const input of inputs) {
		const { body, targetDuration } = splitHeaderAndBody(input.content);
		if (targetDuration !== null) {
			allTargetDurations.push(targetDuration);
			if (targetDuration > maxTargetDuration) {
				maxTargetDuration = targetDuration;
			}
		}
		bodies.push(rewriteBodyUris(body, input.pathPrefix));
	}

	const { header: outHeader } = splitHeaderAndBody(inputs[0]!.content);
	const hadTargetDuration = allTargetDurations.length > 0;
	const headerWithTargetDuration = setOrInsertTargetDuration(outHeader, maxTargetDuration, hadTargetDuration);

	const parts = [headerWithTargetDuration, bodies.join('\n'), TAG_ENDLIST];
	return { content: parts.filter(p => p.length > 0).join('\n') + '\n' };
};

/**
 * Rewrite every stream and rendition URI in an HLS master playlist to its
 * basename (the path component after the final `/`). Unchanged are absolute
 * URIs (those starting with `/` or containing a scheme), unrecognized lines,
 * and all attribute values other than `URI=` on `#EXT-X-MEDIA` and the URI
 * line following `#EXT-X-STREAM-INF`.
 *
 * @group HLS @public
 */
export const rewriteHlsMasterUrisToBasename = (master: string): string => {
	const lines = master.split('\n');
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) {
			continue;
		}
		if (line.startsWith(TAG_MEDIA)) {
			out.push(line.replace(/URI="([^"]+)"/, (_m, uri: string) => `URI="${basename(uri)}"`));
			continue;
		}
		if (line.startsWith(TAG_STREAM_INF)) {
			out.push(line);
			const uri = lines[i + 1];
			if (uri !== undefined && uri.length > 0 && !uri.startsWith('#')) {
				out.push(basename(uri));
				i++;
			}
			continue;
		}
		out.push(line);
	}
	return out.join('\n');
};

type SplitResult = {
	header: string;
	body: string;
	targetDuration: number | null;
};

// The header ends at the first line that signals a segment-bearing payload.
// MEDIA-SEQUENCE is a counter that resets to 0 for a stitched VOD output, so it
// stays in the header (it carries no per-input meaning at this point).
const BODY_STARTERS: readonly string[] = [
	TAG_EXTINF,
	TAG_MAP,
	TAG_KEY,
	TAG_DISCONTINUITY,
	TAG_PROGRAM_DATE_TIME,
	TAG_BYTERANGE,
];

const splitHeaderAndBody = (content: string): SplitResult => {
	const lines = content.split('\n');
	let targetDuration: number | null = null;
	let firstBodyIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith(TAG_TARGETDURATION)) {
			const value = Number(line.slice(TAG_TARGETDURATION.length));
			if (Number.isFinite(value)) {
				targetDuration = value;
			}
			continue;
		}
		if (isBodyLine(line)) {
			firstBodyIdx = i;
			break;
		}
	}

	if (firstBodyIdx === -1) {
		const trimmed = trimTrailingEndlist(stripBlankTrailing(lines));
		return { header: trimmed.join('\n'), body: '', targetDuration };
	}

	const header = lines.slice(0, firstBodyIdx).join('\n');
	const bodyLines = lines.slice(firstBodyIdx);
	const trimmedBody = trimTrailingEndlist(stripBlankTrailing(bodyLines));
	return { header, body: trimmedBody.join('\n'), targetDuration };
};

const isBodyLine = (line: string): boolean => {
	if (line.length === 0) {
		return false;
	}
	if (line.startsWith('#')) {
		return BODY_STARTERS.some(starter => line.startsWith(starter));
	}
	return true;
};

const trimTrailingEndlist = (lines: string[]): string[] => {
	const out: string[] = [];
	for (const line of lines) {
		if (line.startsWith(TAG_ENDLIST)) {
			continue;
		}
		out.push(line);
	}
	return out;
};

const stripBlankTrailing = (lines: string[]): string[] => {
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.length === 0) {
		end--;
	}
	return lines.slice(0, end);
};

const setOrInsertTargetDuration = (header: string, targetDuration: number, hadAny: boolean): string => {
	if (!hadAny) {
		return header;
	}
	const value = Math.ceil(targetDuration);
	const lines = header.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith(TAG_TARGETDURATION)) {
			lines[i] = `${TAG_TARGETDURATION}${value}`;
			return lines.join('\n');
		}
	}
	// Insert after #EXTM3U (or as the first line if absent).
	const insertAt = lines.findIndex(l => l.startsWith('#EXTM3U'));
	if (insertAt === -1) {
		return [`${TAG_TARGETDURATION}${value}`, ...lines].join('\n');
	}
	lines.splice(insertAt + 1, 0, `${TAG_TARGETDURATION}${value}`);
	return lines.join('\n');
};

const rewriteBodyUris = (body: string, pathPrefix: string | undefined): string => {
	if (!pathPrefix) {
		return body;
	}
	const lines = body.split('\n');
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) {
			continue;
		}
		if (line.startsWith(TAG_MAP)) {
			out.push(rewriteUriAttribute(line, pathPrefix));
			continue;
		}
		if (line.length > 0 && !line.startsWith('#') && i > 0 && lines[i - 1]!.startsWith(TAG_EXTINF)) {
			out.push(joinWithPrefix(pathPrefix, line));
			continue;
		}
		out.push(line);
	}
	return out.join('\n');
};

const joinWithPrefix = (prefix: string, uri: string): string => {
	if (uri.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(uri)) {
		return uri;
	}
	return prefix.endsWith('/') ? `${prefix}${uri}` : `${prefix}/${uri}`;
};

const rewriteUriAttribute = (line: string, prefix: string): string => {
	const match = /URI="([^"]+)"/.exec(line);
	if (!match) {
		return line;
	}
	const original = match[1]!;
	if (original.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(original)) {
		return line;
	}
	const rewritten = joinWithPrefix(prefix, original);
	return line.replace(match[0], `URI="${rewritten}"`);
};

const basename = (path: string): string => {
	const lastSlash = path.lastIndexOf('/');
	return lastSlash === -1 ? path : path.slice(lastSlash + 1);
};
