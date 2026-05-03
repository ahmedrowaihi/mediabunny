/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014, 2017, 2024 Google LLC.
 * Original sources:
 *   shaka-packager packager/mpd/base/mpd_options.h
 *   shaka-packager packager/mpd/base/segment_info.h
 *   shaka-packager include/packager/mpd_params.h
 *   shaka-packager include/packager/cea_caption.h
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * DASH profile selector. `onDemand` produces static MPDs with `SegmentBase` /
 * `SegmentList` addressing; `live` produces dynamic MPDs with
 * `SegmentTemplate`. Mirrors shaka's `DashProfile` enum.
 *
 * @group DASH
 * @public
 */
export type DashProfile = 'unknown' | 'onDemand' | 'live';

/**
 * MPD presentation type. `static` for VOD, `dynamic` for live streams.
 * Mirrors shaka's `MpdType` enum.
 *
 * @group DASH
 * @public
 */
export type MpdType = 'static' | 'dynamic';

/**
 * Single `UTCTiming` element entry. Used for clock synchronization in
 * dynamic (live) MPDs.
 *
 * @group DASH
 * @public
 */
export type UtcTiming = {
	/** `schemeIdUri` attribute (e.g. `urn:mpeg:dash:utc:http-iso:2014`). */
	schemeIdUri: string;
	/** `value` attribute (typically a URL). */
	value: string;
};

/**
 * CEA-608 / CEA-708 closed-caption track descriptor. Mirrors shaka's
 * `CeaCaption` struct.
 *
 * @group DASH
 * @public
 */
export type CeaCaption = {
	/** Display name of the caption track. */
	name: string;
	/** Language code (BCP-47 / RFC-5646). */
	language: string;
	/** Channel identifier (e.g. `CC1`, `SERVICE2`). */
	channel: string;
	/** Marks this caption track as default for its language. Defaults to `false`. */
	isDefault: boolean;
	/** Hint to player UI to autoselect this track. Defaults to `true`. */
	autoselect: boolean;
};

/**
 * MPD generation parameters. Mirrors shaka-packager's `MpdParams` struct.
 * Fields default to shaka's defaults; supply only what differs.
 *
 * @group DASH
 * @public
 */
export type MpdParams = {
	/** MPD output file path. */
	mpdOutput: string;
	/** Convert event stream to VOD once end-of-stream is detected. Default: `false`. */
	eventToVodOnEndOfStream: boolean;
	/** `<BaseURL>` element values rendered under the root `<MPD>`. */
	baseUrls: string[];
	/** `MPD@minBufferTime` in seconds. Default: `2.0`. */
	minBufferTime: number;
	/** `MPD@minimumUpdatePeriod` in seconds. Dynamic MPDs only. Default: `0` (omitted). */
	minimumUpdatePeriod: number;
	/**
	 * `MPD@suggestedPresentationDelay` in seconds. Dynamic MPDs only. The
	 * attribute is not emitted when the value is `0`. Default: `0`.
	 */
	suggestedPresentationDelay: number;
	/** `MPD@timeShiftBufferDepth` in seconds. Dynamic MPDs only. Default: `0`. */
	timeShiftBufferDepth: number;
	/**
	 * Maximum number of segments outside the live window to keep accessible.
	 * `0` disables removal. Default: `0`.
	 */
	preservedSegmentsOutsideLiveWindow: number;
	/** `<UTCTiming>` entries for dynamic MPDs. */
	utcTimings: UtcTiming[];
	/**
	 * Tracks tagged with this language get `<Role value="main"/>` in the
	 * manifest. Applies to audio and text tracks unless overridden by
	 * {@link MpdParams.defaultTextLanguage} for text.
	 */
	defaultLanguage: string;
	/** Overrides {@link MpdParams.defaultLanguage} for text/subtitle tracks. */
	defaultTextLanguage: string;
	/**
	 * Generate a static MPD when in live profile. Has no effect for the
	 * on-demand profile (which is always static). Default: `false`.
	 */
	generateStaticLiveMpd: boolean;
	/** Try to generate DASH-IF IOP-compliant MPDs. Default: `true`. */
	generateDashIfIopCompliantMpd: boolean;
	/**
	 * For live profile only: collapse segments with near-equal duration into
	 * a single `SegmentTimeline` `S@r` repeat. Ignored when `$Time$` is used
	 * in the segment template (which requires accurate timing). Default: `false`.
	 */
	allowApproximateSegmentTimeline: boolean;
	/**
	 * User-requested target segment duration in seconds. Used only for
	 * approximate-timeline calculation; the actual segment durations may
	 * differ. Default: `0`.
	 */
	targetSegmentDuration: number;
	/**
	 * Allow switching between codecs that share language, media type, and
	 * container type. Default: `false`.
	 */
	allowCodecSwitching: boolean;
	/**
	 * Insert a PlayReady Object (`<mspr:pro>`) inside `<ContentProtection>`
	 * elements when PlayReady is present. Default: `true`.
	 */
	includeMsprPro: boolean;
	/**
	 * Use `SegmentList` instead of `SegmentBase`. Recommended for very large
	 * assets where the sidx atom would exceed its 65535 reference cap.
	 * Default: `false`.
	 */
	useSegmentList: boolean;
	/**
	 * Enable LL-DASH streaming (each segment composed of fragments composed
	 * of single-moof+mdat chunks, uploaded as they're produced).
	 * Default: `false`.
	 */
	lowLatencyDashMode: boolean;
	/** Target end-to-end latency in seconds for LL-DASH. Default: `1`. */
	targetLatencySeconds: number;
	/** CEA-608 / CEA-708 caption track descriptors. */
	closedCaptions: CeaCaption[];
};

/**
 * Top-level options for DASH MPD generation. Mirrors shaka-packager's
 * `MpdOptions` struct.
 *
 * @group DASH
 * @public
 */
export type MpdOptions = {
	/** Profile to generate. Default: `'onDemand'`. */
	dashProfile: DashProfile;
	/** Static (VOD) or dynamic (live) MPD. Default: `'static'`. */
	mpdType: MpdType;
	/** Per-MPD parameters. */
	mpdParams: MpdParams;
};

/**
 * Information about one media segment, used when generating dynamic
 * (live-profile) MPDs with `SegmentTimeline`. Mirrors shaka-packager's
 * `SegmentInfo` struct.
 *
 * @group DASH
 * @public
 */
export type SegmentInfo = {
	/** Segment start time in track timescale units. Maps to `S@t`. */
	startTime: number;
	/** Segment duration in track timescale units. Maps to `S@d`. */
	duration: number;
	/**
	 * Number of consecutive segments with the same duration after this one
	 * (exclusive). `0` means this segment occurs once. Maps to `S@r`.
	 */
	repeat: number;
	/** Index of this segment in the overall sequence (1-based). */
	startSegmentNumber: number;
};

/**
 * Returns a fresh {@link MpdParams} populated with shaka's default values.
 * Use as a base, then override only the fields you need.
 *
 * @group DASH
 * @public
 */
export const createDefaultMpdParams = (): MpdParams => ({
	mpdOutput: '',
	eventToVodOnEndOfStream: false,
	baseUrls: [],
	minBufferTime: 2.0,
	minimumUpdatePeriod: 0,
	suggestedPresentationDelay: 0,
	timeShiftBufferDepth: 0,
	preservedSegmentsOutsideLiveWindow: 0,
	utcTimings: [],
	defaultLanguage: '',
	defaultTextLanguage: '',
	generateStaticLiveMpd: false,
	generateDashIfIopCompliantMpd: true,
	allowApproximateSegmentTimeline: false,
	targetSegmentDuration: 0,
	allowCodecSwitching: false,
	includeMsprPro: true,
	useSegmentList: false,
	lowLatencyDashMode: false,
	targetLatencySeconds: 1,
	closedCaptions: [],
});

/**
 * Returns a fresh {@link MpdOptions} populated with shaka's default values.
 *
 * @group DASH
 * @public
 */
export const createDefaultMpdOptions = (): MpdOptions => ({
	dashProfile: 'onDemand',
	mpdType: 'static',
	mpdParams: createDefaultMpdParams(),
});
