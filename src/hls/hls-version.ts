/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { HlsKey, HlsPlaylist } from './hls-playlist-parser';
import { EXTINF_IS_DECIMAL } from './hls-entries';

/**
 * The lowest `#EXT-X-VERSION` a playlist's own content requires, per
 * draft-pantos-hls-rfc8216bis-22 section 8. Returns 1 when nothing in it needs more.
 *
 * Worth computing rather than hardcoding: section 8 says a client MUST NOT attempt playback of a
 * version it does not support, so a playlist that declares more than it uses locks out devices that
 * could have played it. A clear MPEG-TS media playlist usually needs only 3.
 *
 * Three of the spec's rules cannot be answered from a parsed playlist and are **not** reflected in
 * the result, so treat it as a floor rather than a verdict:
 *
 * - **8** (variable substitution) and **11** (`EXT-X-DEFINE` with `QUERYPARAM`) — `EXT-X-DEFINE` is
 *   applied while parsing and its values are substituted into the fields, so the tag itself is not
 *   on the AST to be counted.
 * - **12** (any attribute whose name starts with `REQ-`) — an attribute this library does not model
 *   is dropped from the tag it sat on, so it cannot be seen here.
 *
 * If the playlist you are writing uses any of those, take the maximum of this and the version that
 * feature requires.
 *
 * @group HLS
 * @public
 */
export const hlsVersionOf = (playlist: HlsPlaylist): number => {
	let version = 1;
	const require = (n: number) => {
		if (n > version) {
			version = n;
		}
	};

	if (playlist.kind === 'master') {
		for (const rendition of playlist.media) {
			if (rendition.instreamId === null) {
				continue;
			}
			if (rendition.instreamId.startsWith('SERVICE')) {
				require(7);
			}
			if (rendition.type !== 'CLOSED-CAPTIONS') {
				require(13);
			}
		}
		for (const key of playlist.sessionKeys) {
			require(keyVersion(key));
		}
		return version;
	}

	if (playlist.iFramesOnly) {
		require(4);
	}

	for (const segment of playlist.segments) {
		// Asks the serializer's own decision rather than guessing what it will write
		if (EXTINF_IS_DECIMAL) {
			require(3);
		}
		if (segment.byteRange !== null) {
			require(4);
		}
		if (segment.map !== null) {
			// MAP alone is 5; MAP in a playlist without I-FRAMES-ONLY is 6
			require(playlist.iFramesOnly ? 5 : 6);
		}
		for (const key of segment.keys) {
			require(keyVersion(key));
		}
	}

	if (playlist.skip !== null) {
		require(playlist.skip.recentlyRemovedDateRanges !== null ? 10 : 9);
	}

	return version;
};

const keyVersion = (key: HlsKey) => {
	if (key.method === 'SAMPLE-AES') {
		return 5;
	}
	// KEYFORMAT defaults to 'identity' when absent and KEYFORMATVERSIONS to empty, so anything else
	// means the attribute was actually written.
	const statesKeyFormat = key.keyFormat !== 'identity' || key.keyFormatVersions.length > 0;
	if (statesKeyFormat) {
		return 5;
	}
	if (key.iv !== null) {
		return 2;
	}
	return 1;
};
