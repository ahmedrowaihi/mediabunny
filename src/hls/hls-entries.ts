/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 *
 * TypeScript port: Copyright (c) 2026-present, contributors.
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
	readonly type: HlsEntryType;
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
	readonly type = 'extInf' as const;

	private readonly fileName: string;
	private readonly startTime: number;
	private durationSeconds: number;
	private readonly useByteRange: boolean;
	private readonly startByteOffset: number;
	private readonly segmentFileSize: number;
	private readonly previousSegmentEndOffset: number;

	constructor(opts: {
		fileName: string;
		startTime: number;
		durationSeconds: number;
		useByteRange: boolean;
		startByteOffset: number;
		segmentFileSize: number;
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

	getStartTime(): number {
		return this.startTime;
	}

	getDurationSeconds(): number {
		return this.durationSeconds;
	}

	setDurationSeconds(durationSeconds: number): void {
		this.durationSeconds = durationSeconds;
	}

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
	readonly type = 'extKey' as const;

	constructor(
		readonly method: HlsEncryptionMethod,
		readonly url: string,
		readonly keyId: string,
		readonly iv: string,
		readonly keyFormat: string,
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
	readonly type = 'extDiscontinuity' as const;
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
	readonly type = 'placementOpportunity' as const;
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
	readonly type = 'programDateTime' as const;

	constructor(private readonly programTimeMs: number) {}

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
