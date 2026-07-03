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

import { languageToShortestForm } from '../dash/dash-language-utils';
import { getSegmentName } from '../dash/dash-segment-name';
import { BandwidthEstimator } from './hls-bandwidth-estimator';
import {
	DiscontinuityEntry,
	EncryptionInfoEntry,
	type HlsEntry,
	type HlsEntryType,
	PlacementOpportunityEntry,
	ProgramDateTimeEntry,
	SegmentInfoEntry,
} from './hls-entries';
import { Tag } from './hls-tag';
import {
	adjustHlsVideoCodec,
	getMediaInfoLanguage,
	getTimeScale,
	type HlsEncryptionMethod,
	type HlsMediaInfo,
	type HlsMediaPlaylistStreamType,
	type HlsParams,
	type HlsPlaylistType,
} from './hls-types';

const appendExtXMap = (info: HlsMediaInfo, lines: string[]) => {
	if (info.initSegmentUrl) {
		const tag = new Tag('#EXT-X-MAP').addQuotedString('URI', info.initSegmentUrl);
		lines.push(tag.toString());
		return;
	}
	if (info.mediaFileUrl && info.initRange) {
		const tag = new Tag('#EXT-X-MAP').addQuotedString('URI', info.mediaFileUrl);
		const length = info.initRange.end - info.initRange.begin + 1;
		tag.addQuotedNumberPair('BYTERANGE', length, '@', info.initRange.begin);
		lines.push(tag.toString());
	}
};

const buildPlaylistHeader = (
	info: HlsMediaInfo,
	targetDuration: number,
	type: HlsPlaylistType,
	streamType: HlsMediaPlaylistStreamType,
	mediaSequenceNumber: number,
	discontinuitySequenceNumber: number,
	startTimeOffset: number | undefined,
	generatorBanner: string | undefined,
): string[] => {
	const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:6'];
	if (generatorBanner) {
		// Shaka places the generator banner between EXT-X-VERSION and EXT-X-TARGETDURATION.
		lines.push(generatorBanner);
	}
	lines.push(`#EXT-X-TARGETDURATION:${targetDuration}`);

	switch (type) {
		case 'vod':
			lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
			break;
		case 'event':
			lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
			break;
		case 'live':
			if (mediaSequenceNumber > 0) {
				lines.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequenceNumber}`);
			}
			if (discontinuitySequenceNumber > 0) {
				lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequenceNumber}`);
			}
			break;
	}

	if (streamType === 'videoIFramesOnly') {
		lines.push('#EXT-X-I-FRAMES-ONLY');
	}

	if (startTimeOffset !== undefined) {
		// Mirror shaka's `absl::StrFormat("...=%f...")`: printf %f is fixed 6 decimals.
		lines.push(`#EXT-X-START:TIME-OFFSET=${startTimeOffset.toFixed(6)}`);
	}

	// EXT-X-MAP comes last in the header — segments and key info follow.
	appendExtXMap(info, lines);

	return lines;
};

/**
 * Per-rendition HLS playlist (`.m3u8`).
 *
 * Mirrors shaka-packager's
 * [`MediaPlaylist`](https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist.cc):
 * accumulate segment / encryption / discontinuity entries via methods, then call
 * {@link MediaPlaylist.build} to render the final playlist string.
 *
 * @group HLS
 * @public
 */
export class MediaPlaylist {
	/** @internal */
	private mediaInfo?: HlsMediaInfo;
	/** @internal */
	private streamType: HlsMediaPlaylistStreamType = 'video';
	/** @internal */
	private codec = '';
	/** @internal */
	private supplementalCodec?: string;
	/** @internal */
	private compatibleBrand?: string;
	/** @internal */
	private timeScale = 0;
	/** @internal */
	private language = '';
	/** @internal */
	private useByteRange = false;
	/** @internal */
	private characteristics: string[] = [];
	/** @internal */
	private forcedSubtitle = false;

	/** @internal */
	private readonly entries: HlsEntry[] = [];
	/** @internal */
	private targetDurationSeconds = 0;
	/** @internal */
	private targetDurationSet = false;
	/** @internal */
	private longestSegmentDurationSeconds = 0;
	/** @internal */
	private previousSegmentEndOffset = 0;
	/** @internal */
	private insertedDiscontinuityTag = false;
	/** @internal */
	private referenceTimeMs: number | null = null;
	/**
	 * Sum of segment durations currently in the playlist (live sliding window).
	 * @internal
	 */
	private currentBufferDepth = 0;
	/**
	 * Current `#EXT-X-MEDIA-SEQUENCE`. Seeded from `HlsParams.mediaSequenceNumber`
	 * and advanced by {@link MediaPlaylist.slideWindow}. Mirrors shaka's
	 * `media_sequence_number_`.
	 * @internal
	 */
	private mediaSequenceNumber = 0;
	/**
	 * Current `#EXT-X-DISCONTINUITY-SEQUENCE`, advanced by
	 * {@link MediaPlaylist.slideWindow} as discontinuities slide out. Mirrors
	 * shaka's `discontinuity_sequence_number_`.
	 * @internal
	 */
	private discontinuitySequenceNumber = 0;
	/**
	 * File names of segments that have left the live window and are ready for the
	 * caller to delete. Bounded to `preservedSegmentsOutsideLiveWindow`. Mirrors
	 * shaka's `segments_to_be_removed_`.
	 * @internal
	 */
	private readonly segmentsToBeRemoved: string[] = [];
	/** @internal */
	private readonly bandwidthEstimator = new BandwidthEstimator();
	/**
	 * I-frame mode buffer: shaka collects keyframes until the enclosing segment
	 * is added, then flushes them all at once with adjusted durations.
	 * @internal
	 */
	private readonly keyFrames: { timestamp: number; startByteOffset: number; size: number }[] = [];

	constructor(
		/** Top-level HLS options (playlist type, sequence numbers, generator banner, etc.). */
		private readonly hlsParams: HlsParams,
		/** Output filename for this `.m3u8` playlist. */
		private readonly fileName: string,
		/** Human-readable rendition name (used as `NAME` in `#EXT-X-MEDIA`). */
		private readonly displayName: string,
		/** Group identifier (used as `GROUP-ID` in `#EXT-X-MEDIA`). */
		private readonly groupId: string,
	) {
		this.mediaSequenceNumber = hlsParams.mediaSequenceNumber ?? 0;
		this.discontinuitySequenceNumber = hlsParams.discontinuitySequenceNumber ?? 0;

		// Mirror shaka: when a forced media sequence number is set, the playlist
		// starts with a discontinuity tag.
		if (this.mediaSequenceNumber > 0) {
			this.entries.push(new DiscontinuityEntry());
		}
	}

	/** Returns false if `mediaInfo` doesn't have a usable timescale. */
	setMediaInfo(info: HlsMediaInfo): boolean {
		const timeScale = getTimeScale(info);
		if (timeScale === 0) {
			return false;
		}

		if (info.videoInfo) {
			this.streamType = 'video';
			this.codec = adjustHlsVideoCodec(info.videoInfo.codec);
			if (info.videoInfo.supplementalCodec && info.videoInfo.compatibleBrand) {
				this.supplementalCodec = adjustHlsVideoCodec(info.videoInfo.supplementalCodec);
				this.compatibleBrand = info.videoInfo.compatibleBrand;
			}
		} else if (info.audioInfo) {
			this.streamType = 'audio';
			this.codec = info.audioInfo.codec;
		} else if (info.textInfo) {
			this.streamType = 'subtitle';
			this.codec = info.textInfo.codec;
		}

		this.timeScale = timeScale;
		this.mediaInfo = info;
		this.language = getMediaInfoLanguage(info);
		this.useByteRange = !info.segmentTemplateUrl && info.containerType !== 'text';
		this.characteristics = [...(info.hlsCharacteristics ?? [])];
		this.forcedSubtitle = info.forcedSubtitle ?? false;

		return true;
	}

	/**
	 * Append one media segment line. `startTime` and `duration` are in track timescale
	 * units. For single-file byterange playlists, supply non-zero `size` and use the
	 * cumulative `startByteOffset` of the segment in the file.
	 *
	 * For I-frame-only playlists (after at least one {@link MediaPlaylist.addKeyFrame} call),
	 * this flushes the buffered keyframes as `#EXTINF` entries spanning each
	 * keyframe's interval, mirroring shaka.
	 */
	addSegment(
		fileName: string,
		startTime: number,
		duration: number,
		startByteOffset: number,
		size: number,
	): void {
		if (this.streamType === 'videoIFramesOnly') {
			if (this.keyFrames.length === 0) {
				return;
			}
			this.adjustLastSegmentInfoEntryDuration(this.keyFrames[0]!.timestamp);
			for (let i = 0; i < this.keyFrames.length; i++) {
				const kf = this.keyFrames[i]!;
				const nextTimestamp = i + 1 < this.keyFrames.length
					? this.keyFrames[i + 1]!.timestamp
					: startTime + duration;
				this.addSegmentInfoEntry(
					fileName,
					kf.timestamp,
					nextTimestamp - kf.timestamp,
					kf.startByteOffset,
					kf.size,
				);
			}
			this.keyFrames.length = 0;
			return;
		}
		this.addSegmentInfoEntry(fileName, startTime, duration, startByteOffset, size);
	}

	/** @internal */
	private addSegmentInfoEntry(
		fileName: string,
		startTime: number,
		duration: number,
		startByteOffset: number,
		size: number,
	): void {
		// In order for the oldest segment to be accessible for at least
		// timeShiftBufferDepth seconds, the latest segment should not be in the
		// sliding window, so the window is slid BEFORE this segment's duration is
		// added to currentBufferDepth. Mirrors shaka's AddSegmentInfoEntry.
		this.slideWindow();

		const durationSeconds = this.timeScale > 0 ? duration / this.timeScale : 0;
		this.longestSegmentDurationSeconds = Math.max(
			this.longestSegmentDurationSeconds,
			durationSeconds,
		);
		this.bandwidthEstimator.addBlock(size, durationSeconds);
		this.currentBufferDepth += durationSeconds;

		// Out-of-order detection (matches shaka): if the most recent EXTINF has a
		// later start_time than this segment, insert an EXT-X-DISCONTINUITY.
		const last = this.entries[this.entries.length - 1];
		if (last instanceof SegmentInfoEntry && last.getStartTime() > startTime) {
			this.entries.push(new DiscontinuityEntry());
		}

		this.maybeEmitProgramDateTime(startTime);

		const entry = new SegmentInfoEntry({
			fileName,
			startTime,
			durationSeconds,
			useByteRange: this.useByteRange,
			startByteOffset,
			segmentFileSize: size,
			previousSegmentEndOffset: this.previousSegmentEndOffset,
		});
		this.entries.push(entry);
		this.previousSegmentEndOffset = startByteOffset + size - 1;
	}

	/**
	 * Slide the live window: drop leading segments that fall completely outside
	 * `timeShiftBufferDepth`, advancing the media- and discontinuity-sequence
	 * numbers. Leading `#EXT-X-KEY` entries are preserved and re-added at the
	 * front so the remaining segments keep their encryption context. Mirrors
	 * shaka's `SlideWindow`; no-op unless the playlist is `live` with a positive
	 * `timeShiftBufferDepth`.
	 * @internal
	 */
	private slideWindow(): void {
		const timeShiftBufferDepth = this.hlsParams.timeShiftBufferDepth ?? 0;
		if (timeShiftBufferDepth <= 0 || this.hlsParams.playlistType !== 'live') {
			return;
		}
		if (this.currentBufferDepth <= timeShiftBufferDepth) {
			return;
		}

		// Temporary list to hold the EXT-X-KEYs. This lets us remove an EXTINF
		// without dropping the EXT-X-KEYs that precede it — they are moved here and
		// re-added afterwards. Consecutive key entries are either all removed or all
		// kept, so prevEntryType tracks whether we are in a key run.
		let extXKeys: HlsEntry[] = [];
		let prevEntryType: HlsEntryType = 'extInf';

		let last = 0;
		for (; last < this.entries.length; last++) {
			const entry = this.entries[last]!;
			const entryType = entry.type;
			if (entryType === 'extKey') {
				if (prevEntryType !== 'extKey') {
					extXKeys = [];
				}
				extXKeys.push(entry);
			} else if (entryType === 'extDiscontinuity') {
				this.discontinuitySequenceNumber++;
			} else if (entryType === 'extInf') {
				const segmentInfo = entry as SegmentInfoEntry;
				// Remove the current segment only if it falls completely out of the
				// time shift buffer range.
				const segmentWithinTimeShiftBuffer
					= this.currentBufferDepth - segmentInfo.getDurationSeconds() < timeShiftBufferDepth;
				if (segmentWithinTimeShiftBuffer) {
					break;
				}
				this.currentBufferDepth -= segmentInfo.getDurationSeconds();
				this.removeOldSegment(segmentInfo.getStartTime());
				this.mediaSequenceNumber++;
			}
			prevEntryType = entryType;
		}
		this.entries.splice(0, last);
		// Add key entries back at the front.
		this.entries.unshift(...extXKeys);
	}

	/**
	 * Queue the segment that just left the live window for deletion. Shaka deletes
	 * the file here; this port has no filesystem, so it retains the name in
	 * {@link MediaPlaylist.getSegmentsToBeRemoved} (bounded to
	 * `preservedSegmentsOutsideLiveWindow`) for the caller to delete. Mirrors
	 * shaka's `RemoveOldSegment`.
	 * @internal
	 */
	private removeOldSegment(startTime: number): void {
		const preserved = this.hlsParams.preservedSegmentsOutsideLiveWindow ?? 0;
		if (preserved === 0) {
			return;
		}
		if (this.streamType === 'videoIFramesOnly') {
			return;
		}

		this.segmentsToBeRemoved.push(getSegmentName(
			this.mediaInfo?.segmentTemplateUrl ?? '',
			startTime,
			this.mediaSequenceNumber + 1,
			this.mediaInfo?.bandwidth ?? 0,
		));
		// Shaka retries deletion on failure; without filesystem access we drop the
		// front name once the preserved count is exceeded.
		while (this.segmentsToBeRemoved.length > preserved) {
			this.segmentsToBeRemoved.shift();
		}
	}

	/**
	 * File names of segments that have slid out of the live window and are ready
	 * to be deleted by the caller (this port performs no filesystem I/O). The list
	 * is bounded to `HlsParams.preservedSegmentsOutsideLiveWindow`.
	 */
	getSegmentsToBeRemoved(): readonly string[] {
		return this.segmentsToBeRemoved;
	}

	/**
	 * Buffer a keyframe for an I-frame-only playlist. The first call promotes
	 * the playlist's stream type from `video` to `videoIFramesOnly` and turns on
	 * byte-range emission. Buffered keyframes are flushed by the next
	 * {@link MediaPlaylist.addSegment} call, which determines the final keyframe's duration.
	 */
	addKeyFrame(timestamp: number, startByteOffset: number, size: number): void {
		if (this.streamType !== 'videoIFramesOnly') {
			if (this.streamType !== 'video') {
				// I-frames-only applies to video renditions only — silently drop
				// to mirror shaka's "warn and skip" behavior.
				return;
			}
			this.streamType = 'videoIFramesOnly';
			this.useByteRange = true;
		}
		this.keyFrames.push({ timestamp, startByteOffset, size });
	}

	/** @internal */
	private adjustLastSegmentInfoEntryDuration(nextTimestamp: number): void {
		if (this.timeScale === 0) {
			return;
		}
		const nextTimestampSeconds = nextTimestamp / this.timeScale;
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i]!;
			if (entry instanceof SegmentInfoEntry) {
				const segmentDurationSeconds = nextTimestampSeconds - entry.getStartTime() / this.timeScale;
				if (segmentDurationSeconds > 0) {
					entry.setDurationSeconds(segmentDurationSeconds);
				}
				this.longestSegmentDurationSeconds = Math.max(
					this.longestSegmentDurationSeconds,
					segmentDurationSeconds,
				);
				return;
			}
		}
	}

	/**
	 * Set the reference (absolute) wall-clock time the first sample maps to. Combined
	 * with `HlsParams.addProgramDateTime`, drives auto-injected `#EXT-X-PROGRAM-DATE-TIME`
	 * entries before the first segment and after every discontinuity.
	 *
	 * @param unixEpochMs - absolute time in milliseconds since the Unix epoch
	 */
	setReferenceTime(unixEpochMs: number): void {
		this.referenceTimeMs = unixEpochMs;
	}

	/** Append `#EXT-X-PLACEMENT-OPPORTUNITY` (Shaka's SCTE ad-marker convention). */
	addPlacementOpportunity(): void {
		this.entries.push(new PlacementOpportunityEntry());
	}

	/** @internal */
	private maybeEmitProgramDateTime(startTime: number): void {
		if (!this.hlsParams.addProgramDateTime || this.referenceTimeMs === null) {
			return;
		}

		// PDT goes before the first segment AND after every discontinuity.
		// shaka detects discontinuity by checking last entry, OR last-key-after-discontinuity.
		let isFirstSegment = true;
		let isDiscontinuity = false;
		if (this.entries.length > 0) {
			for (let i = this.entries.length - 1; i >= 0; i--) {
				if (this.entries[i] instanceof SegmentInfoEntry) {
					isFirstSegment = false;
					break;
				}
			}

			const last = this.entries[this.entries.length - 1]!;
			if (last instanceof DiscontinuityEntry) {
				isDiscontinuity = true;
			} else if (this.entries.length >= 2) {
				const secondLast = this.entries[this.entries.length - 2]!;
				if (last instanceof EncryptionInfoEntry && secondLast instanceof DiscontinuityEntry) {
					isDiscontinuity = true;
				}
			}
		}

		if (isFirstSegment || isDiscontinuity) {
			const programTimeMs = this.referenceTimeMs
				+ (this.timeScale > 0 ? (startTime / this.timeScale) * 1000 : 0);
			this.entries.push(new ProgramDateTimeEntry(programTimeMs));
		}
	}

	/**
	 * Append a raw entry (e.g. {@link DiscontinuityEntry}, {@link ProgramDateTimeEntry},
	 * {@link PlacementOpportunityEntry}).
	 */
	addEntry(entry: HlsEntry): void {
		this.entries.push(entry);
	}

	/**
	 * Add an `#EXT-X-KEY` entry. Shaka behavior: when the FIRST key is added and
	 * there are pre-existing non-encrypted media segments, an `#EXT-X-DISCONTINUITY`
	 * is inserted immediately before the key. This signals to the player that the
	 * stream changes from clear to encrypted.
	 */
	addEncryptionInfo(opts: {
		/** Encryption method (`SAMPLE-AES`, `AES-128`, `SAMPLE-AES-CTR`, or `NONE`). */
		method: HlsEncryptionMethod;
		/** URI to fetch the key. */
		url: string;
		/** Optional `KEYID` attribute (16-byte hex string). */
		keyId?: string;
		/** Optional `IV` attribute (16-byte hex string). */
		iv?: string;
		/** Optional `KEYFORMAT` attribute (e.g. `com.apple.streamingkeydelivery`). */
		keyFormat?: string;
		/** Optional `KEYFORMATVERSIONS` attribute (slash-separated list). */
		keyFormatVersions?: string;
	}): void {
		if (!this.insertedDiscontinuityTag) {
			if (this.entries.length > 0) {
				this.entries.push(new DiscontinuityEntry());
			}
			this.insertedDiscontinuityTag = true;
		}
		this.entries.push(new EncryptionInfoEntry(
			opts.method,
			opts.url,
			opts.keyId ?? '',
			opts.iv ?? '',
			opts.keyFormat ?? '',
			opts.keyFormatVersions ?? '',
		));
	}

	/** Returns the entries list (read-only). Used by MasterPlaylist for session-key collection. */
	getEntries(): readonly HlsEntry[] {
		return this.entries;
	}

	/** Override the auto-computed `#EXT-X-TARGETDURATION` (in seconds). */
	setTargetDuration(seconds: number): void {
		this.targetDurationSeconds = seconds;
		this.targetDurationSet = true;
	}

	/** Returns the longest segment duration recorded so far (in seconds). */
	getLongestSegmentDuration(): number {
		return this.longestSegmentDurationSeconds;
	}

	/** Returns the playlist's stream type (`video`, `audio`, `subtitle`, `videoIFramesOnly`). */
	getStreamType(): HlsMediaPlaylistStreamType {
		return this.streamType;
	}

	/** Returns the (HLS-adjusted) RFC-6381 codec parameter string. */
	getCodec(): string {
		return this.codec;
	}

	/** Returns the supplemental codec for Dolby Vision dual-track signaling, if any. */
	getSupplementalCodec(): string | undefined {
		return this.supplementalCodec;
	}

	/** Returns the compatible brand FourCC for Dolby Vision dual-track signaling, if any. */
	getCompatibleBrand(): string | undefined {
		return this.compatibleBrand;
	}

	/**
	 * Returns the playlist's language tag reduced to its BCP-47 shortest form.
	 * Mirrors shaka's `MediaPlaylist::GetLanguage`, which applies
	 * `LanguageToShortestForm` (e.g. `eng` → `en`, `eng-US` → `en-US`).
	 */
	getLanguage(): string {
		return languageToShortestForm(this.language);
	}

	/** Returns the configured `CHARACTERISTICS` attribute values. */
	getCharacteristics(): readonly string[] {
		return this.characteristics;
	}

	/** Returns `true` when this is a forced subtitle rendition. */
	isForcedSubtitle(): boolean {
		return this.forcedSubtitle;
	}

	/**
	 * Returns `true` when this rendition is Descriptive Video Service (DVS) audio,
	 * i.e. its sole characteristic is `public.accessibility.describes-video`.
	 * Mirrors shaka's `MediaPlaylist::is_dvs`. Per the HLS Authoring Specification
	 * for Apple Devices §2.12, a DVS rendition must be `AUTOSELECT=YES`.
	 */
	isDvs(): boolean {
		const dvsCharacteristic = 'public.accessibility.describes-video';
		return this.characteristics.length === 1
			&& this.characteristics[0] === dvsCharacteristic;
	}

	/** Returns the output filename for this `.m3u8` playlist. */
	getFileName(): string {
		return this.fileName;
	}

	/** Returns the rendition's human-readable name (used as `NAME` in `#EXT-X-MEDIA`). */
	getName(): string {
		return this.displayName;
	}

	/** Returns the rendition's group identifier (used as `GROUP-ID` in `#EXT-X-MEDIA`). */
	getGroupId(): string {
		return this.groupId;
	}

	/** Returns the media-info supplied to {@link MediaPlaylist.setMediaInfo}, if any. */
	getMediaInfo(): HlsMediaInfo | undefined {
		return this.mediaInfo;
	}

	/**
	 * Returns `true` when a stream index has been supplied via
	 * `HlsMediaInfo.index`. Mirrors shaka's `MediaInfo::has_index`.
	 */
	hasIndex(): boolean {
		return this.mediaInfo?.index !== undefined;
	}

	/**
	 * Returns the stream index used to order renditions in the master playlist,
	 * or `0` when unset. Mirrors shaka's `MediaInfo::index`.
	 */
	getIndex(): number {
		return this.mediaInfo?.index ?? 0;
	}

	/**
	 * Returns peak bitrate. Matches shaka: prefers caller-supplied
	 * `MediaInfo.bandwidth` when set, falls back to the estimator's max.
	 */
	getMaxBitrate(): number {
		if (this.mediaInfo?.bandwidth !== undefined) {
			return this.mediaInfo.bandwidth;
		}
		return this.bandwidthEstimator.max();
	}

	/** Returns the estimator's running average bandwidth. Matches shaka. */
	getAvgBitrate(): number {
		return this.bandwidthEstimator.estimate();
	}

	/**
	 * Returns the HLS `VIDEO-RANGE` value (`"PQ"`, `"HLG"`, `"SDR"`) derived from
	 * `transferCharacteristics`. Returns `""` when no signal is present, matching
	 * shaka. See https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-02#section-4.4.4.2
	 */
	getVideoRange(): string {
		// Dolby Vision (dvh1/dvhe) is always HDR/PQ.
		if (this.codec.startsWith('dvh')) {
			return 'PQ';
		}
		const tc = this.mediaInfo?.videoInfo?.transferCharacteristics;
		switch (tc) {
			case 1:
			case 6:
			case 13:
			case 14:
				// Dolby Vision profile 8.4 may report 14, with the actual value in
				// the SEI's preferred_transfer_characteristic. shaka uses the
				// compatible brand `db4g` as a workaround.
				if (this.supplementalCodec && this.compatibleBrand === 'db4g') {
					return 'HLG';
				}
				return 'SDR';
			case 15:
				return 'SDR';
			case 16:
				return 'PQ';
			case 18:
				return 'HLG';
			default:
				return '';
		}
	}

	/** Returns the video frame rate computed from `videoInfo.timeScale / videoInfo.frameDuration`, or `0`. */
	getFrameRate(): number {
		const v = this.mediaInfo?.videoInfo;
		if (!v || !v.frameDuration || v.frameDuration <= 0) {
			return 0;
		}
		return v.timeScale / v.frameDuration;
	}

	/** Returns the audio channel count, or `0` when this is not an audio rendition. */
	getNumChannels(): number {
		return this.mediaInfo?.audioInfo?.numChannels ?? 0;
	}

	/** Returns the EC-3 JOC complexity (Dolby Atmos), or `0` when not applicable. */
	getEC3JocComplexity(): number {
		return this.mediaInfo?.audioInfo?.codecSpecificData?.ec3JocComplexity ?? 0;
	}

	/** Returns `true` when the AC-4 IMS (Immersive Stereo) flag is set. */
	getAC4ImsFlag(): boolean {
		return this.mediaInfo?.audioInfo?.codecSpecificData?.ac4ImsFlag ?? false;
	}

	/** Returns `true` when the AC-4 CBI (Channel-Based Immersive) flag is set. */
	getAC4CbiFlag(): boolean {
		return this.mediaInfo?.audioInfo?.codecSpecificData?.ac4CbiFlag ?? false;
	}

	/**
	 * Returns the display resolution accounting for the sample aspect ratio,
	 * if a video track is present.
	 */
	getDisplayResolution(): {
		/** Display width (coded width × pixel aspect ratio, floored). */
		width: number;
		/** Display height (coded height). */
		height: number;
	} | null {
		const v = this.mediaInfo?.videoInfo;
		if (!v) {
			return null;
		}
		const par = v.pixelHeight && v.pixelHeight > 0
			? (v.pixelWidth ?? 1) / v.pixelHeight
			: 1.0;
		return { width: Math.floor(v.width * par), height: v.height };
	}

	/**
	 * Renders the final playlist text. Mirrors shaka's `WriteToFile` minus the I/O.
	 *
	 * If `eventToVodOnEnd` is `true` and `endStream` is `true`, an `EVENT` playlist
	 * is rendered as `VOD`.
	 */
	build(opts: {
		/** When `true` and `endStream` is `true`, an `EVENT` playlist is rendered as `VOD`. */
		eventToVodOnEnd?: boolean;
		/** Marks the end of stream — appends `#EXT-X-ENDLIST` for VOD playlists. */
		endStream?: boolean;
	} = {}): string {
		if (!this.mediaInfo) {
			throw new Error('MediaPlaylist.build: setMediaInfo must be called first.');
		}

		if (!this.targetDurationSet) {
			this.setTargetDuration(Math.ceil(this.longestSegmentDurationSeconds));
		}

		let playlistType = this.hlsParams.playlistType;
		if (opts.eventToVodOnEnd && opts.endStream && playlistType === 'event') {
			playlistType = 'vod';
		}

		const generatorBanner = this.hlsParams.generatorUrl && this.hlsParams.generatorVersion
			? `## Generated with ${this.hlsParams.generatorUrl} version ${this.hlsParams.generatorVersion}`
			: undefined;

		const lines = buildPlaylistHeader(
			this.mediaInfo,
			this.targetDurationSeconds,
			playlistType,
			this.streamType,
			this.mediaSequenceNumber,
			this.discontinuitySequenceNumber,
			this.hlsParams.startTimeOffset,
			generatorBanner,
		);

		for (const entry of this.entries) {
			lines.push(entry.toString());
		}

		if (playlistType === 'vod') {
			lines.push('#EXT-X-ENDLIST');
		}

		return lines.join('\n') + '\n';
	}
}
