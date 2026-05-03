/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/media_playlist.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 *
 * TypeScript port: Copyright (c) 2026-present, contributors.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { DiscontinuityEntry, type HlsEntry, SegmentInfoEntry } from './hls-entries';
import { Tag } from './hls-tag';
import {
	adjustHlsVideoCodec,
	getMediaInfoLanguage,
	getTimeScale,
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
		lines.splice(1, 0, generatorBanner);
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
		lines.push(`#EXT-X-START:TIME-OFFSET=${startTimeOffset}`);
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
	private mediaInfo?: HlsMediaInfo;
	private streamType: HlsMediaPlaylistStreamType = 'video';
	private codec = '';
	private supplementalCodec?: string;
	private compatibleBrand?: string;
	private timeScale = 0;
	private language = '';
	private useByteRange = false;
	private characteristics: string[] = [];
	private forcedSubtitle = false;

	private readonly entries: HlsEntry[] = [];
	private targetDurationSeconds = 0;
	private targetDurationSet = false;
	private longestSegmentDurationSeconds = 0;
	private previousSegmentEndOffset = 0;

	constructor(
		private readonly hlsParams: HlsParams,
		private readonly fileName: string,
		private readonly displayName: string,
		private readonly groupId: string,
	) {
		// Mirror shaka: when a forced media sequence number is set, the playlist
		// starts with a discontinuity tag.
		if ((hlsParams.mediaSequenceNumber ?? 0) > 0) {
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
	 */
	addSegment(
		fileName: string,
		startTime: number,
		duration: number,
		startByteOffset: number,
		size: number,
	): void {
		const durationSeconds = this.timeScale > 0 ? duration / this.timeScale : 0;
		this.longestSegmentDurationSeconds = Math.max(
			this.longestSegmentDurationSeconds,
			durationSeconds,
		);

		const entry = new SegmentInfoEntry({
			fileName,
			startTime,
			durationSeconds,
			useByteRange: this.useByteRange && size > 0,
			startByteOffset,
			segmentFileSize: size,
			previousSegmentEndOffset: this.previousSegmentEndOffset,
		});
		this.entries.push(entry);
		this.previousSegmentEndOffset = startByteOffset + size - 1;
	}

	/**
	 * Append a raw entry (e.g. {@link DiscontinuityEntry}, {@link ProgramDateTimeEntry},
	 * {@link PlacementOpportunityEntry}).
	 */
	addEntry(entry: HlsEntry): void {
		this.entries.push(entry);
	}

	setTargetDuration(seconds: number): void {
		this.targetDurationSeconds = seconds;
		this.targetDurationSet = true;
	}

	getLongestSegmentDuration(): number {
		return this.longestSegmentDurationSeconds;
	}

	getStreamType(): HlsMediaPlaylistStreamType {
		return this.streamType;
	}

	getCodec(): string {
		return this.codec;
	}

	getSupplementalCodec(): string | undefined {
		return this.supplementalCodec;
	}

	getCompatibleBrand(): string | undefined {
		return this.compatibleBrand;
	}

	getLanguage(): string {
		return this.language;
	}

	getCharacteristics(): readonly string[] {
		return this.characteristics;
	}

	isForcedSubtitle(): boolean {
		return this.forcedSubtitle;
	}

	getFileName(): string {
		return this.fileName;
	}

	getName(): string {
		return this.displayName;
	}

	getGroupId(): string {
		return this.groupId;
	}

	getMediaInfo(): HlsMediaInfo | undefined {
		return this.mediaInfo;
	}

	getNumChannels(): number {
		return this.mediaInfo?.audioInfo?.numChannels ?? 0;
	}

	getEC3JocComplexity(): number {
		return this.mediaInfo?.audioInfo?.codecSpecificData?.ec3JocComplexity ?? 0;
	}

	getAC4ImsFlag(): boolean {
		return this.mediaInfo?.audioInfo?.codecSpecificData?.ac4ImsFlag ?? false;
	}

	getAC4CbiFlag(): boolean {
		return this.mediaInfo?.audioInfo?.codecSpecificData?.ac4CbiFlag ?? false;
	}

	/**
	 * Returns the display resolution accounting for the sample aspect ratio,
	 * if a video track is present.
	 */
	getDisplayResolution(): { width: number; height: number } | null {
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
	build(opts: { eventToVodOnEnd?: boolean; endStream?: boolean } = {}): string {
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
			this.hlsParams.mediaSequenceNumber ?? 0,
			this.hlsParams.discontinuitySequenceNumber ?? 0,
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
