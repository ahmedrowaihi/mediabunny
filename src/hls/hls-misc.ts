/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** MIME type for HLS playlists. @group HLS @public */
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

/** HLS `#EXT-X-STREAM-INF:` master-playlist tag prefix. @group HLS @public */
export const TAG_STREAM_INF = '#EXT-X-STREAM-INF:';
/** HLS `#EXT-X-I-FRAME-STREAM-INF:` master-playlist tag prefix. @group HLS @public */
export const TAG_I_FRAME_STREAM_INF = '#EXT-X-I-FRAME-STREAM-INF:';
/** HLS `#EXT-X-MEDIA:` master-playlist tag prefix. @group HLS @public */
export const TAG_MEDIA = '#EXT-X-MEDIA:';
/** HLS `#EXTINF:` segment-duration tag prefix. @group HLS @public */
export const TAG_EXTINF = '#EXTINF:';
/** HLS `#EXT-X-MAP:` init-segment tag prefix. @group HLS @public */
export const TAG_MAP = '#EXT-X-MAP:';
/** HLS `#EXT-X-KEY:` segment-encryption tag prefix. @group HLS @public */
export const TAG_KEY = '#EXT-X-KEY:';
/** HLS `#EXT-X-MEDIA-SEQUENCE:` tag prefix. @group HLS @public */
export const TAG_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE:';
/** HLS `#EXT-X-BYTERANGE:` tag prefix. @group HLS @public */
export const TAG_BYTERANGE = '#EXT-X-BYTERANGE:';
/** HLS `#EXT-X-PROGRAM-DATE-TIME:` tag prefix. @group HLS @public */
export const TAG_PROGRAM_DATE_TIME = '#EXT-X-PROGRAM-DATE-TIME:';
/** HLS `#EXT-X-DISCONTINUITY` tag. @group HLS @public */
export const TAG_DISCONTINUITY = '#EXT-X-DISCONTINUITY';
/** HLS `#EXT-X-TARGETDURATION:` tag prefix. @group HLS @public */
export const TAG_TARGETDURATION = '#EXT-X-TARGETDURATION:';
/** HLS `#EXT-X-ENDLIST` tag. @group HLS @public */
export const TAG_ENDLIST = '#EXT-X-ENDLIST';
/** HLS `#EXT-X-PLAYLIST-TYPE:` tag prefix. @group HLS @public */
export const TAG_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE:';
/** HLS `#EXT-X-I-FRAMES-ONLY` tag. @group HLS @public */
export const TAG_I_FRAMES_ONLY = '#EXT-X-I-FRAMES-ONLY';

/** True for blank lines and `#`-prefixed comments that are not `#EXT...` tags. @group HLS @public */
export const canIgnoreLine = (line: string) => line.length === 0 || (line.startsWith('#') && !line.startsWith('#EXT'));

/** Parses an HLS attribute list (`KEY=VALUE,KEY2="quoted"`) into a case-insensitive map. @group HLS @public */
export class AttributeList {
	/** Lowercased attribute map. @internal */
	_attributes: Record<string, string> = {};

	constructor(str: string) {
		let key = '';
		let value = '';
		let inValue = false;
		let inQuotes = false;

		for (let i = 0; i < str.length; i++) {
			const char = str[i]!;

			if (char === '"') {
				inQuotes = !inQuotes;
			} else if (char === '=' && !inValue && !inQuotes) {
				inValue = true;
			} else if (char === ',' && !inQuotes) {
				if (key) {
					this._attributes[key.trim().toLowerCase()] = value;
				}

				key = '';
				value = '';
				inValue = false;
			} else if (inValue) {
				value += char;
			} else {
				key += char;
			}
		}

		if (key) {
			this._attributes[key.trim().toLowerCase()] = value;
		}
	}

	/** Get the attribute value (case-insensitive name), or `null` if absent. */
	get(name: string) {
		return this._attributes[name.toLowerCase()] ?? null;
	}

	/** Get the attribute value as a finite number, or `null` if absent or non-numeric. */
	getAsNumber(name: string) {
		const value = this.get(name);
		if (value === null) {
			return null;
		}

		const num = Number(value);
		return Number.isFinite(num) ? num : null;
	}

	/** Merge another attribute list into this one, overwriting on key collision. */
	merge(other: AttributeList) {
		Object.assign(this._attributes, other._attributes);
	}
}
