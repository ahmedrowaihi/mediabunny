/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2017 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/representation.{h,cc}
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import type { ContentProtectionElement } from './dash-content-protection';
import { BandwidthEstimator } from '../hls/hls-bandwidth-estimator';
import type {
	ContainerType,
	MediaInfo,
	VideoInfo,
} from './dash-media-info';
import {
	atLeastOneTrue,
	getCodecs,
	getSupplementalCodecs,
	getSupplementalProfiles,
	hasLiveOnlyFields,
	hasVodOnlyFields,
	moreThanOneTrue,
	removeDuplicateAttributes,
	updateContentProtectionPsshHelper,
} from './dash-mpd-utils';
import { RepresentationXmlNode } from './dash-representation-xml-node';
import { getSegmentName } from './dash-segment-name';
import type { MpdOptions, SegmentInfo } from './dash-types';

/**
 * Bit flags for {@link Representation.suppressOnce}. ORed together to suppress
 * multiple attributes at once.
 *
 * @group DASH
 * @public
 */
export const SuppressFlag = {
	WIDTH: 1,
	HEIGHT: 2,
	FRAME_RATE: 4,
} as const;

/**
 * Observer interface notified when a {@link Representation}'s state changes.
 * Mirrors shaka's `RepresentationStateChangeListener`.
 *
 * @group DASH
 * @public
 */
export type RepresentationStateChangeListener = {
	/**
	 * Called when a new (sub)segment is added to the Representation.
	 * @param startTime - segment start time in stream timescale
	 * @param duration - segment duration in stream timescale
	 */
	onNewSegmentForRepresentation: (startTime: number, duration: number) => void;
	/**
	 * Called when the frame rate is set on the Representation.
	 * @param frameDuration - frame duration in stream timescale
	 * @param timeScale - stream timescale
	 */
	onSetFrameRateForRepresentation: (frameDuration: number, timeScale: number) => void;
};

/**
 * Returns the timescale to use for `mediaInfo`: prefers `referenceTimeScale`,
 * falls back to video, then audio. Returns `1` and warns if none are set
 * (mirroring shaka).
 *
 * @internal
 */
const getTimeScale = (mediaInfo: MediaInfo): number => {
	if (mediaInfo.referenceTimeScale !== undefined) {
		return mediaInfo.referenceTimeScale;
	}
	if (mediaInfo.videoInfo?.timeScale !== undefined) {
		return mediaInfo.videoInfo.timeScale;
	}
	if (mediaInfo.audioInfo?.timeScale !== undefined) {
		return mediaInfo.audioInfo.timeScale;
	}
	return 1;
};

/**
 * Returns `true` when video metadata has the required fields for a valid MPD.
 * Mirrors shaka's `HasRequiredVideoFields`.
 *
 * @internal
 */
const hasRequiredVideoFields = (videoInfo: VideoInfo): boolean => {
	return videoInfo.width !== undefined && videoInfo.height !== undefined;
};

/**
 * Returns the `mimeType` string for the supplied container type, prefixed
 * with the media kind (`video`, `audio`, `application`). Mirrors shaka's
 * `GetMimeType`. Returns `''` for unrecognized containers.
 *
 * @internal
 */
const getMimeType = (prefix: string, containerType: ContainerType | undefined): string => {
	switch (containerType) {
		case 'mp4':
			return `${prefix}/mp4`;
		case 'mpeg2ts':
			// NOTE: DASH MPD spec uses lowercase but RFC3555 says uppercase.
			return `${prefix}/MP2T`;
		case 'webm':
			return `${prefix}/webm`;
		default:
			return '';
	}
};

/**
 * One media stream in a DASH MPD — paired with optional ContentProtection
 * descriptors. Generates one `<Representation>` element via {@link Representation.getXml}.
 *
 * Mirrors shaka-packager's `Representation` class. Construct via
 * `AdaptationSet.addRepresentation()` (Phase 3.2) — direct instantiation is
 * supported but not the typical entry point.
 *
 * @group DASH
 * @public
 */
export class Representation {
	/** @internal */
	private mediaInfo: MediaInfo;
	/** @internal */
	private readonly contentProtectionElements: ContentProtectionElement[] = [];
	/** @internal */
	private currentBufferDepth = 0;
	/** @internal */
	private readonly segmentInfos: SegmentInfo[] = [];
	/** @internal */
	private readonly segmentsToBeRemoved: string[] = [];

	/** @internal */
	private readonly idValue: number;
	/** @internal */
	private mimeType = '';
	/** @internal */
	private codecs = '';
	/** @internal */
	private supplementalCodecs = '';
	/** @internal */
	private supplementalProfiles = '';
	/** @internal */
	private readonly bandwidthEstimator = new BandwidthEstimator();
	/** @internal */
	private readonly mpdOptions: MpdOptions;
	/** @internal */
	private readonly stateChangeListener: RepresentationStateChangeListener | null;
	/** @internal */
	private outputSuppressionFlags = 0;
	/** @internal */
	private readonly allowApproximateSegmentTimeline: boolean;
	/** @internal */
	private frameDuration = 0;

	constructor(
		mediaInfo: MediaInfo,
		mpdOptions: MpdOptions,
		representationId: number,
		stateChangeListener: RepresentationStateChangeListener | null = null,
	) {
		this.mediaInfo = mediaInfo;
		this.idValue = representationId;
		this.mpdOptions = mpdOptions;
		this.stateChangeListener = stateChangeListener;
		// Mirrors shaka: $Time is legitimate but not a template, so disable
		// approximate timeline when $Time$ is in use.
		const segmentTemplate = mediaInfo.segmentTemplate ?? '';
		this.allowApproximateSegmentTimeline = !segmentTemplate.includes('$Time')
			&& mpdOptions.mpdParams.allowApproximateSegmentTimeline;
	}

	/**
	 * Create a fresh Representation that shares `other`'s media info,
	 * options, and id but starts with empty segment / content-protection
	 * state. Mirrors shaka's
	 * `Representation::Representation(const Representation&, ...)` copy
	 * constructor — used by {@link AdaptationSet.copyRepresentation} to
	 * clone Representations across Periods.
	 *
	 * Pre-computed `mimeType` and `codecs` are propagated so the clone
	 * doesn't require a fresh `init()` call.
	 */
	static cloneFrom(
		other: Representation,
		stateChangeListener: RepresentationStateChangeListener | null = null,
	): Representation {
		const clone = new Representation(
			other.mediaInfo,
			other.mpdOptions,
			other.idValue,
			stateChangeListener,
		);
		clone.mimeType = other.mimeType;
		clone.codecs = other.codecs;
		return clone;
	}

	/**
	 * Validate the MediaInfo and pre-compute mimeType / codecs / supplemental
	 * codec strings. Returns `false` (with no side effects on success state)
	 * when validation fails. Mirrors shaka's `Init`.
	 */
	init(): boolean {
		if (!atLeastOneTrue(
			this.mediaInfo.videoInfo !== undefined,
			this.mediaInfo.audioInfo !== undefined,
			this.mediaInfo.textInfo !== undefined,
		)) {
			return false;
		}

		if (moreThanOneTrue(
			this.mediaInfo.videoInfo !== undefined,
			this.mediaInfo.audioInfo !== undefined,
			this.mediaInfo.textInfo !== undefined,
		)) {
			return false;
		}

		if (this.mediaInfo.containerType === undefined || this.mediaInfo.containerType === 'unknown') {
			return false;
		}

		if (this.mediaInfo.videoInfo) {
			this.mimeType = this.getVideoMimeType();
			if (!hasRequiredVideoFields(this.mediaInfo.videoInfo)) {
				return false;
			}
		} else if (this.mediaInfo.audioInfo) {
			this.mimeType = this.getAudioMimeType();
		} else if (this.mediaInfo.textInfo) {
			this.mimeType = this.getTextMimeType();
		}

		if (this.mimeType.length === 0) {
			return false;
		}

		this.codecs = getCodecs(this.mediaInfo);
		this.supplementalCodecs = getSupplementalCodecs(this.mediaInfo);
		this.supplementalProfiles = getSupplementalProfiles(this.mediaInfo);
		return true;
	}

	/**
	 * Append one `<ContentProtection>` descriptor to this Representation.
	 * Note: `<ContentProtection>` elements are NOT added automatically from
	 * `mediaInfo.protectedContent` — see shaka's note. Some MPDs want the
	 * descriptors at AdaptationSet level instead.
	 *
	 * Mirrors shaka's `AddContentProtectionElement`. The supplied descriptor
	 * is mutated to remove duplicate keys per
	 * {@link removeDuplicateAttributes}.
	 */
	addContentProtectionElement(element: ContentProtectionElement): void {
		this.contentProtectionElements.push(element);
		removeDuplicateAttributes(this.contentProtectionElements[this.contentProtectionElements.length - 1]!);
	}

	/**
	 * Update the `<cenc:pssh>` for `drmUuid`'s `<ContentProtection>`. If the
	 * descriptor doesn't exist, an empty one is added. Mirrors shaka's
	 * `UpdateContentProtectionPssh`. Note: as in shaka, this currently
	 * REMOVES the existing PSSH (not updates it) for shaka-player compat.
	 */
	updateContentProtectionPssh(drmUuid: string, pssh: Uint8Array): void {
		updateContentProtectionPsshHelper(drmUuid, pssh, this.contentProtectionElements);
	}

	/**
	 * Append a media (sub)segment. `AdaptationSet@subsegmentAlignment` /
	 * `@segmentAlignment` cannot be set unless this is called for every
	 * Representation in the AdaptationSet. Mirrors shaka's `AddNewSegment`.
	 *
	 * @param startTime - segment start time in stream timescale
	 * @param duration - segment duration in stream timescale (LL-DASH: first chunk's duration)
	 * @param size - segment size in bytes (LL-DASH: first chunk's size)
	 * @param segmentNumber - 1-based segment number
	 */
	addNewSegment(startTime: number, duration: number, size: number, segmentNumber: number): void {
		if (startTime === 0 && duration === 0) {
			// Shaka logs a warning and ignores; we silently ignore.
			return;
		}

		// In order for the oldest segment to be accessible for at least
		// time_shift_buffer_depth seconds, the latest segment should not be in
		// the sliding window since the player could be playing any part of the
		// latest segment. So the current segment duration is added to the sum of
		// segment durations after sliding the window.
		this.slideWindow();

		if (this.stateChangeListener) {
			this.stateChangeListener.onNewSegmentForRepresentation(startTime, duration);
		}

		this.addSegmentInfo(startTime, duration, segmentNumber);

		if (!this.mpdOptions.mpdParams.lowLatencyDashMode) {
			this.currentBufferDepth += this.segmentInfos[this.segmentInfos.length - 1]!.duration;
			const refTimeScale = this.mediaInfo.referenceTimeScale ?? 1;
			this.bandwidthEstimator.addBlock(size, duration / refTimeScale);
		}
	}

	/**
	 * Update the most recent segment's duration + size. Used in LL-DASH where
	 * the full segment duration isn't known until streaming completes. No-op
	 * for non-LL-DASH (matches shaka's warning behaviour silently).
	 *
	 * Mirrors shaka's `UpdateCompletedSegment`.
	 */
	updateCompletedSegment(duration: number, size: number): void {
		if (!this.mpdOptions.mpdParams.lowLatencyDashMode) {
			return;
		}
		this.updateSegmentInfo(duration);
		this.currentBufferDepth += this.segmentInfos[this.segmentInfos.length - 1]!.duration;
		const refTimeScale = this.mediaInfo.referenceTimeScale ?? 1;
		this.bandwidthEstimator.addBlock(size, duration / refTimeScale);
	}

	/**
	 * Set the per-sample frame duration. Used by `setAvailabilityTimeOffset`
	 * and to populate `videoInfo.frameDuration` for video Representations.
	 * Mirrors shaka's `SetSampleDuration`.
	 */
	setSampleDuration(frameDuration: number): void {
		// Sample duration is used to generate approximate SegmentTimeline.
		// Text is required to have exactly the same segment duration.
		if (this.mediaInfo.audioInfo !== undefined || this.mediaInfo.videoInfo !== undefined) {
			this.frameDuration = frameDuration;
		}

		if (this.mediaInfo.videoInfo !== undefined) {
			// Mutate the underlying mediaInfo so subsequent getXml() reflects.
			this.mediaInfo = {
				...this.mediaInfo,
				videoInfo: { ...this.mediaInfo.videoInfo, frameDuration },
			};
			if (this.stateChangeListener) {
				const timeScale = this.mediaInfo.videoInfo!.timeScale ?? 0;
				this.stateChangeListener.onSetFrameRateForRepresentation(frameDuration, timeScale);
			}
		}
	}

	/**
	 * Set `presentationTimeOffset` (`SegmentBase` / `SegmentTemplate`) from a
	 * value in seconds. Mirrors shaka's `SetPresentationTimeOffset`. No-op
	 * when the resulting integer would be ≤ 0.
	 */
	setPresentationTimeOffset(presentationTimeOffset: number): void {
		const refTimeScale = this.mediaInfo.referenceTimeScale ?? 0;
		const pto = Math.floor(presentationTimeOffset * refTimeScale);
		if (pto <= 0) {
			return;
		}
		this.mediaInfo = { ...this.mediaInfo, presentationTimeOffset: pto };
	}

	/**
	 * Set `availabilityTimeOffset` for LL-DASH from `frameDuration` and
	 * `target_segment_duration`. Mirrors shaka's `SetAvailabilityTimeOffset`.
	 * No-op when the result is ≤ 0.
	 */
	setAvailabilityTimeOffset(): void {
		const refTimeScale = this.mediaInfo.referenceTimeScale ?? 1;
		const frameDurationSec = this.frameDuration / refTimeScale;
		const ato = this.mpdOptions.mpdParams.targetSegmentDuration - frameDurationSec;
		if (ato <= 0) {
			return;
		}
		this.mediaInfo = { ...this.mediaInfo, availabilityTimeOffset: ato };
	}

	/**
	 * Set `segment_duration` from `target_segment_duration` (LL-DASH).
	 * Mirrors shaka's `SetSegmentDuration`.
	 */
	setSegmentDuration(): void {
		const refTimeScale = this.mediaInfo.referenceTimeScale ?? 0;
		const sd = Math.floor(this.mpdOptions.mpdParams.targetSegmentDuration * refTimeScale);
		if (sd <= 0) {
			return;
		}
		this.mediaInfo = { ...this.mediaInfo, segmentDuration: sd };
	}

	/** Returns the `MediaInfo` this Representation was constructed with. */
	getMediaInfo(): MediaInfo {
		return this.mediaInfo;
	}

	/** Replace this Representation's media info. Mirrors shaka's `set_media_info`. */
	setMediaInfo(mediaInfo: MediaInfo): void {
		this.mediaInfo = mediaInfo;
	}

	/**
	 * Render the `<Representation>` element. Returns `null` when the media
	 * info is invalid or any sub-step fails. Mirrors shaka's `GetXml` —
	 * including the strict ordering of children: VideoInfo / AudioInfo →
	 * ContentProtection → VOD- or Live-only info.
	 */
	getXml(): RepresentationXmlNode | null {
		if (!this.hasRequiredMediaInfoFields()) {
			return null;
		}

		const bandwidth = this.mediaInfo.bandwidth ?? this.bandwidthEstimator.max();

		const node = new RepresentationXmlNode();
		if (
			!node.setId(this.idValue)
			|| !node.setIntegerAttribute('bandwidth', bandwidth)
			|| !(this.codecs.length === 0 || node.setStringAttribute('codecs', this.codecs))
			|| !node.setStringAttribute('mimeType', this.mimeType)
		) {
			return null;
		}

		if (this.supplementalCodecs.length > 0 && this.supplementalProfiles.length > 0) {
			node.setStringAttribute('scte214:supplementalCodecs', this.supplementalCodecs);
			node.setStringAttribute('scte214:supplementalProfiles', this.supplementalProfiles);
		}

		const hasVideoInfo = this.mediaInfo.videoInfo !== undefined;
		const hasAudioInfo = this.mediaInfo.audioInfo !== undefined;

		if (hasVideoInfo && !node.addVideoInfo(
			this.mediaInfo.videoInfo!,
			(this.outputSuppressionFlags & SuppressFlag.WIDTH) === 0,
			(this.outputSuppressionFlags & SuppressFlag.HEIGHT) === 0,
			(this.outputSuppressionFlags & SuppressFlag.FRAME_RATE) === 0,
		)) {
			return null;
		}

		if (hasAudioInfo && !node.addAudioInfo(this.mediaInfo.audioInfo!)) {
			return null;
		}

		if (!node.addContentProtectionElements(this.contentProtectionElements)) {
			return null;
		}

		if (hasVodOnlyFields(this.mediaInfo) && !node.addVODOnlyInfo(
			this.mediaInfo,
			this.mpdOptions.mpdParams.useSegmentList,
			this.mpdOptions.mpdParams.targetSegmentDuration,
		)) {
			return null;
		}

		if (hasLiveOnlyFields(this.mediaInfo) && !node.addLiveOnlyInfo(
			this.mediaInfo,
			this.segmentInfos,
			this.mpdOptions.mpdParams.lowLatencyDashMode,
		)) {
			return null;
		}

		this.outputSuppressionFlags = 0;
		return node;
	}

	/**
	 * Set bit flags whose corresponding attributes will not be emitted on the
	 * NEXT call to {@link Representation.getXml}. Calling getXml again without setting flags
	 * resumes default behaviour. Mirrors shaka's `SuppressOnce`.
	 */
	suppressOnce(flag: number): void {
		this.outputSuppressionFlags |= flag;
	}

	/**
	 * Returns `[startTimestampSeconds, endTimestampSeconds]` derived from the
	 * accumulated segment list. Returns `null` when no segments have been
	 * added. Mirrors shaka's `GetStartAndEndTimestamps`.
	 */
	getStartAndEndTimestamps(): {
		/** Start timestamp in seconds. */
		start: number;
		/** End timestamp in seconds. */
		end: number;
	} | null {
		if (this.segmentInfos.length === 0) {
			return null;
		}
		const timeScale = getTimeScale(this.mediaInfo);
		const first = this.segmentInfos[0]!;
		const last = this.segmentInfos[this.segmentInfos.length - 1]!;
		return {
			start: first.startTime / timeScale,
			end: (last.startTime + last.duration * (last.repeat + 1)) / timeScale,
		};
	}

	/** Returns the numeric ID for `<Representation @id>`. */
	id(): number {
		return this.idValue;
	}

	/**
	 * Returns the (read-only) list of segment-template-rendered file names
	 * that were sliding-window-evicted but haven't been deleted by the host
	 * yet. The TS port doesn't perform file I/O — callers responsible for
	 * actually removing these from disk if desired.
	 *
	 * Mirrors the `segments_to_be_removed_` list shaka exposes only for the
	 * `File::Delete` retry loop in `RemoveOldSegment`.
	 */
	getSegmentsToBeRemoved(): readonly string[] {
		return this.segmentsToBeRemoved;
	}

	/**
	 * Returns `true` when the underlying MediaInfo is valid for rendering.
	 * Mirrors shaka's `HasRequiredMediaInfoFields`.
	 *
	 * @internal
	 */
	private hasRequiredMediaInfoFields(): boolean {
		if (hasVodOnlyFields(this.mediaInfo) && hasLiveOnlyFields(this.mediaInfo)) {
			return false;
		}
		if (this.mediaInfo.containerType === undefined) {
			return false;
		}
		return true;
	}

	/** @internal */
	private addSegmentInfo(startTime: number, duration: number, segmentNumber: number): void {
		const NO_REPEAT = 0;
		const adjustedDuration = this.adjustDuration(duration);

		if (this.segmentInfos.length > 0) {
			const previous = this.segmentInfos[this.segmentInfos.length - 1]!;
			const previousSegmentEndTime = previous.startTime + previous.duration * (previous.repeat + 1);

			if (this.approximatelyEqual(previousSegmentEndTime, startTime)) {
				const segmentEndTimeForSameDuration = previousSegmentEndTime + previous.duration;
				const actualSegmentEndTime = startTime + duration;
				if (this.approximatelyEqual(segmentEndTimeForSameDuration, actualSegmentEndTime)) {
					previous.repeat += 1;
				} else {
					this.segmentInfos.push({
						startTime: previousSegmentEndTime,
						duration: actualSegmentEndTime - previousSegmentEndTime,
						repeat: NO_REPEAT,
						startSegmentNumber: segmentNumber,
					});
				}
				return;
			}

			// Gaps and overlaps are tolerated — shaka logs a warning then
			// proceeds. We do the same silently.
		}
		this.segmentInfos.push({
			startTime,
			duration: adjustedDuration,
			repeat: NO_REPEAT,
			startSegmentNumber: segmentNumber,
		});
	}

	/** @internal */
	private updateSegmentInfo(duration: number): void {
		if (this.segmentInfos.length > 0) {
			this.segmentInfos[this.segmentInfos.length - 1]!.duration = duration;
		}
	}

	/** @internal */
	private approximatelyEqual(time1: number, time2: number): boolean {
		if (!this.allowApproximateSegmentTimeline) {
			return time1 === time2;
		}
		// Mirrors shaka's threshold: min(frameDuration, 0.05 * timescale).
		const ERROR_THRESHOLD_SECONDS = 0.05;
		const refTimeScale = this.mediaInfo.referenceTimeScale ?? 1;
		const errorThreshold = Math.min(
			this.frameDuration,
			Math.floor(ERROR_THRESHOLD_SECONDS * refTimeScale),
		);
		return Math.abs(time1 - time2) <= errorThreshold;
	}

	/** @internal */
	private adjustDuration(duration: number): number {
		if (!this.allowApproximateSegmentTimeline) {
			return duration;
		}
		const refTimeScale = this.mediaInfo.referenceTimeScale ?? 1;
		const scaledTargetDuration = this.mpdOptions.mpdParams.targetSegmentDuration * refTimeScale;
		return this.approximatelyEqual(scaledTargetDuration, duration)
			? scaledTargetDuration
			: duration;
	}

	/** @internal */
	private slideWindow(): void {
		if (this.mpdOptions.mpdParams.timeShiftBufferDepth <= 0
			|| this.mpdOptions.mpdType === 'static') {
			return;
		}

		const timeScale = getTimeScale(this.mediaInfo);
		if (timeScale <= 0) {
			return;
		}

		const timeShiftBufferDepth = Math.floor(
			this.mpdOptions.mpdParams.timeShiftBufferDepth * timeScale,
		);

		if (this.currentBufferDepth <= timeShiftBufferDepth) {
			return;
		}

		// Iterate forward, popping repeats off each segment until either the
		// segment is fully consumed (repeat goes negative) or removing more
		// would dip us below the buffer depth. Drop wholly consumed segments.
		while (this.segmentInfos.length > 0) {
			const seg = this.segmentInfos[0]!;
			let consumed = false;
			while (seg.repeat >= 0
				&& this.currentBufferDepth - seg.duration >= timeShiftBufferDepth) {
				this.currentBufferDepth -= seg.duration;
				this.removeOldSegment(seg);
				if (seg.repeat < 0) {
					consumed = true;
					break;
				}
			}
			if (consumed) {
				this.segmentInfos.shift();
				continue;
			}
			break;
		}
	}

	/** @internal */
	private removeOldSegment(segmentInfo: SegmentInfo): void {
		const segmentStartTime = segmentInfo.startTime;
		segmentInfo.startTime += segmentInfo.duration;
		segmentInfo.repeat -= 1;
		const startNumber = segmentInfo.startSegmentNumber;
		segmentInfo.startSegmentNumber += 1;

		if (this.mpdOptions.mpdParams.preservedSegmentsOutsideLiveWindow === 0) {
			return;
		}

		this.segmentsToBeRemoved.push(getSegmentName(
			this.mediaInfo.segmentTemplate ?? '',
			segmentStartTime,
			startNumber,
			this.mediaInfo.bandwidth ?? 0,
		));
		// shaka pops from the front while the queue exceeds the preserve
		// budget, attempting File::Delete on each. We don't perform file I/O
		// here — callers drain via getSegmentsToBeRemoved().
		while (this.segmentsToBeRemoved.length
			> this.mpdOptions.mpdParams.preservedSegmentsOutsideLiveWindow) {
			this.segmentsToBeRemoved.shift();
		}
	}

	/** @internal */
	private getVideoMimeType(): string {
		return getMimeType('video', this.mediaInfo.containerType);
	}

	/** @internal */
	private getAudioMimeType(): string {
		return getMimeType('audio', this.mediaInfo.containerType);
	}

	/** @internal */
	private getTextMimeType(): string {
		const codec = this.mediaInfo.textInfo?.codec ?? '';
		const containerType = this.mediaInfo.containerType;
		if (codec === 'ttml') {
			if (containerType === 'text') {
				return 'application/ttml+xml';
			}
			if (containerType === 'mp4') {
				return 'application/mp4';
			}
			return '';
		}
		if (codec === 'wvtt') {
			if (containerType === 'text') {
				return 'text/vtt';
			}
			if (containerType === 'mp4') {
				return 'application/mp4';
			}
			return '';
		}
		return '';
	}
}
