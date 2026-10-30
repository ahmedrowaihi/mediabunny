/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseHlsPlaylist } from './hls-playlist-parser';

/**
 * A client's blocking-reload request: the `_HLS_msn` and `_HLS_part` query parameters of RFC 8216bis
 * §6.2.5.2, by which a player asks for a playlist that does not exist yet.
 *
 * @group HLS
 * @public
 */
export type HlsReloadDirective = {
	/** `_HLS_msn`: the media sequence number the client is waiting for. */
	msn: number;
	/** `_HLS_part`: the part index within that segment, or null when the client named a segment only. */
	part: number | null;
};

/**
 * What a server should do with a blocking reload: answer from the playlist it holds, hold the request
 * until the playlist advances, or refuse a directive naming something too far ahead.
 *
 * @group HLS
 * @public
 */
export type HlsReloadState = 'ready' | 'wait' | 'too-far';

const nonNegativeInteger = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);

/**
 * Read a blocking-reload directive from the `_HLS_msn` and `_HLS_part` query parameters of a playlist
 * request, per RFC 8216bis §6.2.5.2. Takes the two values already extracted from the request, since how a
 * query arrives differs between a Node server, a Lambda event and a service worker, and none of that is HLS.
 *
 * The three outcomes are distinct and must not be collapsed: `null` means the request named no directive
 * and the playlist should be served normally, `'invalid'` means the client asked something malformed and
 * should be refused rather than answered, and a directive is a well-formed request to hold.
 *
 * `_HLS_part` without `_HLS_msn` is invalid rather than part 0 of an unnamed segment, and a value that is
 * not a non-negative integer is invalid rather than absent — answering a malformed request as if nothing
 * had been asked hides the client's bug.
 *
 * @group HLS
 * @public
 */
export const hlsReloadDirective = (
	msn: string | undefined,
	part: string | undefined,
): HlsReloadDirective | 'invalid' | null => {
	if (msn === undefined) {
		return part === undefined ? null : 'invalid';
	}

	const msnValue = nonNegativeInteger(msn);
	if (msnValue === null) {
		return 'invalid';
	}
	if (part === undefined) {
		return { msn: msnValue, part: null };
	}

	const partValue = nonNegativeInteger(part);
	return partValue === null ? 'invalid' : { msn: msnValue, part: partValue };
};

/**
 * Decide how a server should answer a blocking reload, per RFC 8216bis §6.2.5.2. Pure: the server's
 * state arrives as the playlist text it was about to serve, so media sequence, part target and the
 * parts of the segment in progress are all read from there.
 *
 * A directive more than two segments ahead is refused, as is one whose part is past the Advance Part
 * Limit — three *target durations* expressed in parts, so six of them at a 0.5 second part target.
 * A part index past the named segment's last rolls forward to part 0 of the segment after it. A
 * directive naming something the window has already evicted is answerable at once rather than
 * refused, so a player that fell behind is served rather than stranded.
 *
 * @param partCount - How many parts the segment the directive names actually has, which the playlist
 * no longer states once that segment is complete.
 * @throws When the text parses as a master playlist.
 * @group HLS
 * @public
 */
export const hlsReloadState = (
	playlist: string,
	directive: HlsReloadDirective,
	partCount: number,
): HlsReloadState => {
	const parsed = parseHlsPlaylist(playlist);
	if (parsed.kind === 'master') {
		throw new TypeError('hlsReloadState needs a media playlist, but the text parses as a master playlist.');
	}

	const { msn, part } = directive;
	const last = parsed.mediaSequence + parsed.segments.length - 1;
	const parts = parsed.trailingParts.length;
	// A playlist without EXT-X-PART-INF should never reach here; a flat three is the safe fallback
	const target = parsed.partTarget ?? 1;
	const limit = target < 1 ? 3 / target : 3;

	if (msn > last + 2 || (msn === last + 1 && part !== null && part - (parts - 1) > limit)) {
		return 'too-far';
	}

	const rollsForward = part !== null && part >= partCount;
	const segment = rollsForward ? msn + 1 : msn;
	const index = rollsForward ? 0 : part;

	if (segment <= last || (segment === last + 1 && index !== null && index < parts)) {
		return 'ready';
	}

	return 'wait';
};

/**
 * Build the predicate deciding whether a segment's parts must still be listed, per RFC 8216bis
 * §6.2.2: parts are held for three target durations past their segment, then dropped while the
 * segment itself stays in the playlist.
 *
 * The bound is taken from the segment durations rather than a stated target, rounded up and floored
 * at one second, so it matches the integer a playlist advertises as its `EXT-X-TARGETDURATION`.
 *
 * @param durations - Every segment duration in the window, in seconds.
 * @returns A predicate over a segment's start time and the playlist's end, both in seconds.
 * @group HLS
 * @public
 */
export const hlsRetainsParts = (
	durations: readonly number[],
): (startsAt: number, end: number) => boolean => {
	const keep = 3 * Math.max(1, Math.ceil(Math.max(...durations)));
	return (startsAt, end) => end - startsAt <= keep;
};
