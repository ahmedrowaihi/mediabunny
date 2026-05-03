/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import type { HlsEncryptionMethod } from './hls-types';
import { Tag } from './hls-tag';

/**
 * Discriminator for the kinds of lines that appear in an HLS media playlist.
 *
 * @group HLS
 * @public
 */
export type HlsEntryType =
	| 'extInf'
	| 'extDiscontinuity'
	| 'extKey'
	| 'programDateTime'
	| 'placementOpportunity';

/**
 * Base interface for any line emitted into an HLS media playlist body.
 *
 * @group HLS
 * @public
 */
export interface HlsEntry {
	/** Discriminator for the kind of entry. */
	readonly type: HlsEntryType;
	/** Renders the entry as one or more lines of HLS playlist text. */
	toString(): string;
}

const formatExtInfDuration = (seconds: number) => seconds.toFixed(3);

/**
 * Renders one `#EXTINF` line with optional `#EXT-X-BYTERANGE` and the segment URI.
 * For single-file byterange playlists the byterange offset is emitted only when it
 * differs from `previousSegmentEndOffset + 1`, matching shaka's compact output.
 *
 * @group HLS
 * @public
 */
export class SegmentInfoEntry implements HlsEntry {
	/** Discriminator for HlsEntry: always `'extInf'`. */
	readonly type = 'extInf' as const;

	/** @internal */
	private readonly fileName: string;
	/** @internal */
	private readonly startTime: number;
	/** @internal */
	private durationSeconds: number;
	/** @internal */
	private readonly useByteRange: boolean;
	/** @internal */
	private readonly startByteOffset: number;
	/** @internal */
	private readonly segmentFileSize: number;
	/** @internal */
	private readonly previousSegmentEndOffset: number;

	constructor(opts: {
		/** Segment URI to emit on the line following `#EXTINF`. */
		fileName: string;
		/** Segment start time in track timescale units. */
		startTime: number;
		/** Segment duration in seconds (ends up in `#EXTINF:<duration>`). */
		durationSeconds: number;
		/** When `true`, emit `#EXT-X-BYTERANGE` after `#EXTINF`. */
		useByteRange: boolean;
		/** Cumulative byte offset of this segment in the single media file. */
		startByteOffset: number;
		/** Segment size in bytes. */
		segmentFileSize: number;
		/** End-of-previous-segment offset (used to compact contiguous byteranges). */
		previousSegmentEndOffset: number;
	}) {
		this.fileName = opts.fileName;
		this.startTime = opts.startTime;
		this.durationSeconds = opts.durationSeconds;
		this.useByteRange = opts.useByteRange;
		this.startByteOffset = opts.startByteOffset;
		this.segmentFileSize = opts.segmentFileSize;
		this.previousSegmentEndOffset = opts.previousSegmentEndOffset;
	}

	/** Returns the segment's start time in track timescale units. */
	getStartTime(): number {
		return this.startTime;
	}

	/** Returns the segment's duration in seconds. */
	getDurationSeconds(): number {
		return this.durationSeconds;
	}

	/** Mutates the segment's duration (used by I-frame flushing). */
	setDurationSeconds(durationSeconds: number): void {
		this.durationSeconds = durationSeconds;
	}

	/** Renders the `#EXTINF` line, optional `#EXT-X-BYTERANGE`, and the URI. */
	toString(): string {
		let result = `#EXTINF:${formatExtInfDuration(this.durationSeconds)},`;
		if (this.useByteRange) {
			result += `\n#EXT-X-BYTERANGE:${this.segmentFileSize}`;
			if (this.previousSegmentEndOffset + 1 !== this.startByteOffset) {
				result += `@${this.startByteOffset}`;
			}
		}
		result += `\n${this.fileName}`;
		return result;
	}
}

/**
 * One Common Encryption / SAMPLE-AES key declaration. Renders as `#EXT-X-KEY`
 * inside a media playlist or `#EXT-X-SESSION-KEY` when consumed at the master
 * playlist level. Mirrors shaka-packager's `EncryptionInfoEntry`.
 *
 * Field order in the rendered tag matches shaka exactly (METHOD, URI, KEYID,
 * IV, KEYFORMATVERSIONS, KEYFORMAT) — RFC 8216 §4.3.2.4.
 *
 * @group HLS
 * @public
 */
export class EncryptionInfoEntry implements HlsEntry {
	/** Discriminator for HlsEntry: always `'extKey'`. */
	readonly type = 'extKey' as const;

	constructor(
		/** Encryption method (`SAMPLE-AES`, `AES-128`, `SAMPLE-AES-CTR`, or `NONE`). */
		readonly method: HlsEncryptionMethod,
		/** URI to fetch the key. */
		readonly url: string,
		/** Optional `KEYID` attribute (16-byte hex string). */
		readonly keyId: string,
		/** Optional `IV` attribute (16-byte hex string). */
		readonly iv: string,
		/** Optional `KEYFORMAT` attribute (e.g. `com.apple.streamingkeydelivery`). */
		readonly keyFormat: string,
		/** Optional `KEYFORMATVERSIONS` attribute (slash-separated list). */
		readonly keyFormatVersions: string,
	) {}

	/**
	 * Renders this entry. Defaults to `#EXT-X-KEY`; pass `'#EXT-X-SESSION-KEY'`
	 * (or any other tag name) to render the same fields under a different tag.
	 */
	toString(tagName = '#EXT-X-KEY'): string {
		const tag = new Tag(tagName);
		tag.addString('METHOD', this.method);
		tag.addQuotedString('URI', this.url);
		if (this.keyId) {
			tag.addString('KEYID', this.keyId);
		}
		if (this.iv) {
			tag.addString('IV', this.iv);
		}
		if (this.keyFormatVersions) {
			tag.addQuotedString('KEYFORMATVERSIONS', this.keyFormatVersions);
		}
		if (this.keyFormat) {
			tag.addQuotedString('KEYFORMAT', this.keyFormat);
		}
		return tag.toString();
	}
}

/**
 * Renders `#EXT-X-DISCONTINUITY`.
 *
 * @group HLS
 * @public
 */
export class DiscontinuityEntry implements HlsEntry {
	/** Discriminator for HlsEntry: always `'extDiscontinuity'`. */
	readonly type = 'extDiscontinuity' as const;
	/** Renders the literal `#EXT-X-DISCONTINUITY` line. */
	toString(): string {
		return '#EXT-X-DISCONTINUITY';
	}
}

/**
 * Renders `#EXT-X-PLACEMENT-OPPORTUNITY` (Shaka extension used for SCTE ad signaling).
 *
 * @group HLS
 * @public
 */
export class PlacementOpportunityEntry implements HlsEntry {
	/** Discriminator for HlsEntry: always `'placementOpportunity'`. */
	readonly type = 'placementOpportunity' as const;
	/** Renders the literal `#EXT-X-PLACEMENT-OPPORTUNITY` line. */
	toString(): string {
		return '#EXT-X-PLACEMENT-OPPORTUNITY';
	}
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const pad3 = (n: number) => n.toString().padStart(3, '0');
const pad4 = (n: number) => n.toString().padStart(4, '0');

/**
 * Renders `#EXT-X-PROGRAM-DATE-TIME` formatted as ISO 8601 UTC with millisecond
 * precision (e.g. `2026-04-22T10:36:00.000Z`), matching shaka's output exactly.
 *
 * @group HLS
 * @public
 */
export class ProgramDateTimeEntry implements HlsEntry {
	/** Discriminator for HlsEntry: always `'programDateTime'`. */
	readonly type = 'programDateTime' as const;

	constructor(
		/**
		 * Wall-clock time in milliseconds since the Unix epoch.
		 * @internal
		 */
		private readonly programTimeMs: number,
	) {}

	/** Renders the `#EXT-X-PROGRAM-DATE-TIME:<ISO-8601>` line. */
	toString(): string {
		const date = new Date(this.programTimeMs);
		const yyyy = pad4(date.getUTCFullYear());
		const mm = pad2(date.getUTCMonth() + 1);
		const dd = pad2(date.getUTCDate());
		const hh = pad2(date.getUTCHours());
		const mi = pad2(date.getUTCMinutes());
		const ss = pad2(date.getUTCSeconds());
		let ms = date.getUTCMilliseconds() % 1000;
		if (ms < 0) {
			ms += 1000;
		}
		return `#EXT-X-PROGRAM-DATE-TIME:${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${pad3(ms)}Z`;
	}
}
