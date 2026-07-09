/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Construction counterpart to `parseMpd`: factories that build the `Mpd` AST from the fields that
// matter, defaulting the boilerplate — for describing already-produced segments (hand the result to
// `serializeManifest`). This is distinct from the shaka-style `MpdBuilder`, which drives the muxer
// pipeline from `MediaInfo`.

import {
	type Mpd,
	type MpdAdaptationSet,
	type MpdPeriod,
	type MpdRepresentation,
	type SegmentList,
} from './dash-mpd-parser';

/**
 * Build a `<SegmentList>` from an init URI + ordered segment media URIs — the explicit-list form.
 *
 * @group DASH
 * @public
 */
export const mpdSegmentList = (options: {
	/** Segment `<SegmentURL @media>` URIs, in order. */
	segments: string[];
	/** `<Initialization @sourceURL>` (the init segment). */
	initializationUri?: string;
	/** `@duration` in timescale units. */
	duration?: number;
	/** `@timescale` (defaults to `1`). */
	timescale?: number;
	/** `@startNumber` (defaults to `1`). */
	startNumber?: number;
}): SegmentList => ({
	timescale: options.timescale ?? 1,
	duration: options.duration ?? null,
	startNumber: options.startNumber ?? 1,
	presentationTimeOffset: 0,
	initialization: options.initializationUri === undefined ? null : { sourceURL: options.initializationUri, range: null },
	timeline: null,
	segments: options.segments.map((media) => ({ media, mediaRange: null, index: null, indexRange: null })),
});

/**
 * Build an {@link MpdRepresentation} from the fields that matter, defaulting the rest.
 *
 * @group DASH
 * @public
 */
export const mpdRepresentation = (options: {
	/** `@id`. */
	id: string;
	/** `@bandwidth` in bits/second. */
	bandwidth: number;
	/** `@codecs`. */
	codecs?: string;
	/** `@width` in pixels. */
	width?: number;
	/** `@height` in pixels. */
	height?: number;
	/** `@audioSamplingRate` in Hz. */
	audioSamplingRate?: number;
	/** `<SegmentList>`. */
	segmentList?: SegmentList;
}): MpdRepresentation => ({
	id: options.id,
	bandwidth: options.bandwidth,
	width: options.width ?? null,
	height: options.height ?? null,
	frameRate: null,
	codecs: options.codecs ?? null,
	mimeType: null,
	sar: null,
	audioSamplingRate: options.audioSamplingRate ?? null,
	startWithSAP: null,
	labels: [],
	audioChannelConfigurations: [],
	supplementalProperties: [],
	essentialProperties: [],
	baseURLs: [],
	contentProtections: [],
	segmentTemplate: null,
	segmentList: options.segmentList ?? null,
	segmentBase: null,
});

/**
 * Build an {@link MpdAdaptationSet} around its representations.
 *
 * @group DASH
 * @public
 */
export const mpdAdaptationSet = (options: {
	/** `<Representation>` children. */
	representations: MpdRepresentation[];
	/** Resolved content type. */
	contentType?: MpdAdaptationSet['contentType'];
	/** `@mimeType`. */
	mimeType?: string;
	/** `@lang`. */
	lang?: string;
	/** `@id`. */
	id?: string;
}): MpdAdaptationSet => ({
	id: options.id ?? null,
	group: null,
	contentType: options.contentType ?? null,
	mimeType: options.mimeType ?? null,
	codecs: null,
	lang: options.lang ?? null,
	maxWidth: null,
	maxHeight: null,
	frameRate: null,
	roles: [],
	labels: [],
	audioChannelConfigurations: [],
	supplementalProperties: [],
	essentialProperties: [],
	baseURLs: [],
	contentProtections: [],
	segmentTemplate: null,
	segmentList: null,
	representations: options.representations,
});

/**
 * Build an {@link MpdPeriod}.
 *
 * @group DASH
 * @public
 */
export const mpdPeriod = (options: {
	/** `<AdaptationSet>` children. */
	adaptationSets: MpdAdaptationSet[];
	/** `@id`. */
	id?: string;
	/** `@start` in seconds. */
	start?: number;
	/** `@duration` in seconds. */
	duration?: number;
}): MpdPeriod => ({
	id: options.id ?? null,
	start: options.start ?? null,
	duration: options.duration ?? null,
	baseURLs: [],
	adaptationSets: options.adaptationSets,
});

/**
 * Build an {@link Mpd}. Pass `type: 'dynamic'` (+ `minimumUpdatePeriod`) for live, `'static'` for VOD.
 *
 * @group DASH
 * @public
 */
export const mpd = (options: {
	/** `@type`. */
	type: Mpd['type'];
	/** `<Period>` children. */
	periods: MpdPeriod[];
	/** `@profiles` URNs (defaults to the ISO live/on-demand profile matching `type`). */
	profiles?: string[];
	/** `@minBufferTime` in seconds. */
	minBufferTime?: number;
	/** `@minimumUpdatePeriod` in seconds (live). */
	minimumUpdatePeriod?: number;
	/** `@mediaPresentationDuration` in seconds (VOD). */
	mediaPresentationDuration?: number;
	/** `@availabilityStartTime` as Unix milliseconds. */
	availabilityStartTime?: number;
	/** `@timeShiftBufferDepth` in seconds (live DVR window). */
	timeShiftBufferDepth?: number;
}): Mpd => ({
	type: options.type,
	profiles: options.profiles ?? [options.type === 'static' ? 'urn:mpeg:dash:profile:isoff-on-demand:2011' : 'urn:mpeg:dash:profile:isoff-live:2011'],
	mediaPresentationDuration: options.mediaPresentationDuration ?? null,
	minimumUpdatePeriod: options.minimumUpdatePeriod ?? null,
	availabilityStartTime: options.availabilityStartTime ?? null,
	publishTime: null,
	timeShiftBufferDepth: options.timeShiftBufferDepth ?? null,
	suggestedPresentationDelay: null,
	maxSegmentDuration: null,
	minBufferTime: options.minBufferTime ?? null,
	baseURLs: [],
	utcTiming: [],
	periods: options.periods,
});
