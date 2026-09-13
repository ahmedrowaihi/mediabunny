/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Logging } from '../logging';
import { getQueryParameter } from '../misc';

/** MIME type for HLS playlists. @group HLS @public */
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

/** HLS `#EXT-X-STREAM-INF:` master-playlist tag prefix. @group HLS @public */
export const TAG_STREAM_INF = '#EXT-X-STREAM-INF:';
/** HLS `#EXT-X-I-FRAME-STREAM-INF:` master-playlist tag prefix. @group HLS @public */
export const TAG_I_FRAME_STREAM_INF = '#EXT-X-I-FRAME-STREAM-INF:';
/** HLS `#EXT-X-MEDIA:` master-playlist tag prefix. @group HLS @public */
export const TAG_MEDIA = '#EXT-X-MEDIA:';
/** HLS `#EXT-X-WMPACEINFO:` ingest tag prefix pointing at the watermarking sidecar file. @group HLS @public */
export const TAG_WMPACEINFO = '#EXT-X-WMPACEINFO:';
/** HLS `#EXT-X-SKIP:` delta-update tag prefix. @group HLS @public */
export const TAG_SKIP = '#EXT-X-SKIP:';
/** HLS `#EXT-X-RENDITION-REPORT:` tag prefix. @group HLS @public */
export const TAG_RENDITION_REPORT = '#EXT-X-RENDITION-REPORT:';
/** HLS `#EXT-X-DATERANGE:` tag prefix. @group HLS @public */
export const TAG_DATERANGE = '#EXT-X-DATERANGE:';
/** HLS `#EXT-X-BITRATE:` tag prefix. @group HLS @public */
export const TAG_BITRATE = '#EXT-X-BITRATE:';
/** HLS `#EXT-X-GAP` tag. @group HLS @public */
export const TAG_GAP = '#EXT-X-GAP';
/** HLS `#EXT-X-SESSION-KEY:` master-playlist tag prefix. @group HLS @public */
export const TAG_SESSION_KEY = '#EXT-X-SESSION-KEY:';
/** HLS `#EXT-X-SESSION-DATA:` master-playlist tag prefix. @group HLS @public */
export const TAG_SESSION_DATA = '#EXT-X-SESSION-DATA:';
/** HLS `#EXT-X-START:` playback-start tag prefix. @group HLS @public */
export const TAG_START = '#EXT-X-START:';
/** HLS `#EXT-X-CONTENT-STEERING:` master-playlist tag prefix. @group HLS @public */
export const TAG_CONTENT_STEERING = '#EXT-X-CONTENT-STEERING:';
/** HLS `#EXT-X-DEFINE:` variable-definition tag prefix. @group HLS @public */
export const TAG_DEFINE = '#EXT-X-DEFINE:';
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
/** HLS `#EXT-X-DISCONTINUITY-SEQUENCE:` tag prefix. @group HLS @public */
export const TAG_DISCONTINUITY_SEQUENCE = '#EXT-X-DISCONTINUITY-SEQUENCE:';
/** HLS `#EXT-X-TARGETDURATION:` tag prefix. @group HLS @public */
export const TAG_TARGETDURATION = '#EXT-X-TARGETDURATION:';
/** HLS `#EXT-X-ENDLIST` tag. @group HLS @public */
export const TAG_ENDLIST = '#EXT-X-ENDLIST';
/** HLS `#EXT-X-PLAYLIST-TYPE:` tag prefix. @group HLS @public */
export const TAG_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE:';
/** HLS `#EXT-X-I-FRAMES-ONLY` tag. @group HLS @public */
export const TAG_I_FRAMES_ONLY = '#EXT-X-I-FRAMES-ONLY';
/** HLS `#EXT-X-PART:` partial-segment tag prefix. @group HLS @public */
export const TAG_PART = '#EXT-X-PART:';
/** HLS `#EXT-X-PART-INF:` tag prefix. @group HLS @public */
export const TAG_PART_INF = '#EXT-X-PART-INF:';
/** HLS `#EXT-X-SERVER-CONTROL:` tag prefix. @group HLS @public */
export const TAG_SERVER_CONTROL = '#EXT-X-SERVER-CONTROL:';
/** HLS `#EXT-X-PRELOAD-HINT:` tag prefix. @group HLS @public */
export const TAG_PRELOAD_HINT = '#EXT-X-PRELOAD-HINT:';

/** True for blank lines and `#`-prefixed comments that are not `#EXT...` tags. @group HLS @public */
export const canIgnoreLine = (line: string) => line.length === 0 || (line.startsWith('#') && !line.startsWith('#EXT'));

/** Parses an HLS attribute list (`KEY=VALUE,KEY2="quoted"`) into a case-insensitive map. @group HLS @public */
export class AttributeList {
	/** Lowercased attribute map. @internal */
	_attributes: Record<string, string> = {};
	/** Names whose AttributeValue was a quoted-string. @internal */
	_quotedAttributes = new Set<string>();

	constructor(str: string, variables?: HlsPlaylistVariables) {
		let key = '';
		let value = '';
		let inValue = false;
		let inQuotes = false;
		let quotedValue = false;

		const flushAttribute = () => {
			if (!key) {
				return;
			}

			const attributeName = key.trim().toLowerCase();
			if (Object.prototype.hasOwnProperty.call(this._attributes, attributeName)) {
				// "AttributeName MUST NOT appear more than once in a given attribute-list.
				// Clients SHOULD refuse to parse such Playlists."
				Logging._warn(`Duplicate AttributeName "${attributeName}"; using last value`);
			}

			// quoted-string and hexadecimal-sequence AttributeValues are subject to variable substitution
			const shouldSubstitute = quotedValue || value.startsWith('0x') || value.startsWith('0X');
			this._attributes[attributeName] = shouldSubstitute && variables
				? variables.substitute(value)
				: value;
			if (quotedValue) {
				this._quotedAttributes.add(attributeName);
			} else {
				this._quotedAttributes.delete(attributeName);
			}

			key = '';
			value = '';
			inValue = false;
			quotedValue = false;
		};

		for (let i = 0; i < str.length; i++) {
			const char = str[i]!;

			if (char === '"') {
				if (inValue && !inQuotes && value.length === 0) {
					quotedValue = true;
				}
				inQuotes = !inQuotes;
			} else if (char === '=' && !inValue && !inQuotes) {
				inValue = true;
			} else if (char === ',' && !inQuotes) {
				flushAttribute();
			} else if (inValue) {
				value += char;
			} else {
				key += char;
			}
		}

		if (inQuotes) {
			throw new Error('Invalid M3U8 file; unterminated quoted-string AttributeValue.');
		}

		flushAttribute();
	}

	/** Get the attribute value (case-insensitive name), or `null` if absent. */
	get(name: string) {
		return this._attributes[name.toLowerCase()] ?? null;
	}

	/**
	 * Whether this attribute was written as a quoted-string. The spec fixes the lexical type of every named
	 * attribute, so this only matters for the open `X-` namespace, where quoting is what distinguishes a string
	 * from a hexadecimal-sequence or a decimal-floating-point.
	 */
	isQuoted(name: string) {
		return this._quotedAttributes.has(name.toLowerCase());
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
		for (const name of Object.keys(other._attributes)) {
			if (other._quotedAttributes.has(name)) {
				this._quotedAttributes.add(name);
			} else {
				this._quotedAttributes.delete(name);
			}
		}
	}
}

// Variable name `token_1` is referenced as `{$token_1}`
const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const VARIABLE_REFERENCE_PATTERN = /\{\$([A-Za-z0-9_-]+)\}/g;
// Variable values may reference earlier variables, so substitution can grow output exponentially ("billion laughs")
const MAX_TOTAL_SUBSTITUTED_LENGTH = 2 ** 26;

/**
 * The `#EXT-X-DEFINE` variables in scope for one playlist, used to substitute `{$name}` references in URIs and
 * attribute values. A media playlist can `IMPORT` variables from the master playlist that referenced it, so pass
 * the master's instance as `importedVariables` when parsing one.
 *
 * @group HLS @public
 */
export class HlsPlaylistVariables {
	/** The variables defined so far, keyed by name. */
	variables = new Map<string, string>();
	/** @internal */
	totalSubstitutedLength = 0;

	constructor(
		/** The playlist's own URL, used to resolve `QUERYPARAM` definitions. */
		readonly playlistPath: string,
		/** The playlist that can be `IMPORT`ed from, or `null` when there is none. */
		readonly importedVariables: HlsPlaylistVariables | null,
	) {}

	/** Applies one `#EXT-X-DEFINE` tag body, which must carry exactly one of NAME, IMPORT or QUERYPARAM. */
	define(str: string) {
		const attributes = new AttributeList(str, this);
		const name = attributes.get('name');
		const importedName = attributes.get('import');
		const queryParameterName = attributes.get('queryparam');
		const declarationCount = [name, importedName, queryParameterName]
			.filter(value => value !== null)
			.length;

		if (declarationCount !== 1) {
			throw new Error(
				'Invalid #EXT-X-DEFINE tag; exactly one of NAME, IMPORT, or QUERYPARAM must be present.',
			);
		}

		if (name !== null) {
			const value = attributes.get('value');
			if (value === null) {
				throw new Error('Invalid #EXT-X-DEFINE tag; NAME requires VALUE.');
			}

			this.set(name, value);
		} else if (importedName !== null) {
			const value = this.importedVariables?.get(importedName);
			if (value === undefined) {
				throw new Error(`Invalid #EXT-X-DEFINE tag; cannot import undefined variable "${importedName}".`);
			}

			this.set(importedName, value);
		} else if (queryParameterName !== null) {
			const value = getQueryParameter(this.playlistPath, queryParameterName);
			if (value === null) {
				throw new Error(`Invalid #EXT-X-DEFINE tag; query parameter "${queryParameterName}" is missing.`);
			}

			this.set(queryParameterName, value);
		}
	}

	/** Replaces every `{$name}` reference in `value`; throws when a referenced variable is not yet defined. */
	substitute(value: string) {
		return value.replaceAll(VARIABLE_REFERENCE_PATTERN, (_reference, name: string) => {
			const replacement = this.variables.get(name);
			if (replacement === undefined) {
				throw new Error(`Invalid M3U8 file; variable "${name}" is referenced before being defined.`);
			}

			this.totalSubstitutedLength += replacement.length;
			if (this.totalSubstitutedLength > MAX_TOTAL_SUBSTITUTED_LENGTH) {
				throw new Error('Invalid M3U8 file; variable substitution produces an excessive amount of data.');
			}

			return replacement;
		});
	}

	/** Reads one variable, or `undefined` when it is not defined. */
	get(name: string) {
		return this.variables.get(name);
	}

	/** Defines one variable directly, without going through a tag. */
	set(name: string, value: string) {
		if (!VARIABLE_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid #EXT-X-DEFINE tag; invalid variable name "${name}".`);
		}
		if (this.variables.has(name)) {
			// "Parsers that encounter duplicate Variable Name declarations MUST fail to parse the Playlist."
			throw new Error(`Invalid #EXT-X-DEFINE tag; variable "${name}" is already defined.`);
		}

		this.variables.set(name, value);
	}
}
