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

import { InvalidUsageError } from '../errors';
import { parseByteRange } from './dash-misc';
import {
	type ByteRange,
	type DashUrlElement,
	type Mpd,
	type MpdAdaptationSet,
	type MpdBaseURL,
	type MpdContentSteering,
	type DashDescriptor,
	type MpdPeriod,
	type MpdRepresentation,
	type SegmentBase,
	type SegmentList,
	type MpdServiceDescription,
	type SegmentTemplate,
	emptyRepresentationBaseChildren,
} from './dash-mpd-parser';

/** A range is stored as `{ start, end }`; `'start-end'` is what the manifest and HTTP state it as. */
const toByteRange = (range: ByteRange | string): ByteRange => {
	if (typeof range !== 'string') {
		return range;
	}
	const parsed = parseByteRange(range);
	if (parsed === null) {
		throw new InvalidUsageError(
			`'${range}' is not a byte range; state it as 'start-end' (both bytes inclusive), or pass`
			+ ' { start, end }.',
		);
	}
	return parsed;
};

/**
 * One `<SegmentURL>` of a {@link mpdSegmentList}.
 *
 * @group DASH
 * @public
 */
export type MpdSegmentUrl = SegmentList['segments'][number];

/**
 * Build one `<SegmentURL>`. Needed only for a segment that carries a byte range or its own index —
 * {@link mpdSegmentList} takes a plain URI string for the common case.
 *
 * @group DASH
 * @public
 */
export const mpdSegmentUrl = (options: {
	/** `@media` URI. */
	media: string;
	/** `@mediaRange`, as `{ start, end }` or `'start-end'`. */
	mediaRange?: ByteRange | string | null | undefined;
	/** `@index` URI, when this segment's index is a separate resource. */
	index?: string | null | undefined;
	/** `@indexRange`, as `{ start, end }` or `'start-end'`. */
	indexRange?: ByteRange | string | null | undefined;
}): MpdSegmentUrl => ({
	media: options.media,
	mediaRange: options.mediaRange == null ? null : toByteRange(options.mediaRange),
	index: options.index ?? null,
	indexRange: options.indexRange == null ? null : toByteRange(options.indexRange),
});

/** A plain URI is the common case; an entry is needed only when it carries a range or an index. */
const toMpdSegmentUrl = (entry: string | MpdSegmentUrl): MpdSegmentUrl =>
	typeof entry === 'string' ? mpdSegmentUrl({ media: entry }) : entry;

/**
 * Build a `<SegmentList>` from an init URI + ordered segment media URIs — the explicit-list form.
 *
 * @group DASH
 * @public
 */
export const mpdSegmentList = (options: {
	/**
	 * `<SegmentURL>` children, in order. A plain string is a `@media` URI with no range and no
	 * separate index; {@link mpdSegmentUrl} builds one that carries either.
	 */
	segments: (string | MpdSegmentUrl)[];
	/** `<Initialization @sourceURL>` (the init segment). */
	initializationUri?: string | null | undefined;
	/** `<Initialization @range>`, when the init is a byte range of the media resource. */
	initializationRange?: ByteRange | string | null | undefined;
	/** `@duration` in timescale units. */
	duration?: number | null | undefined;
	/** `@timescale` (defaults to `1`). */
	timescale?: number | null | undefined;
	/** `@startNumber` (defaults to `1`). */
	startNumber?: number | null | undefined;
	/** `@presentationTimeOffset` in timescale units (defaults to `0`). */
	presentationTimeOffset?: number | null | undefined;
	/** `@availabilityTimeOffset` in seconds (defaults to `0`). */
	availabilityTimeOffset?: number | null | undefined;
	/** `@availabilityTimeComplete` (defaults to `true`). */
	availabilityTimeComplete?: boolean | null | undefined;
	/** `<SegmentTimeline>` `<S>` entries. */
	timeline?: SegmentList['timeline'] | undefined;
}): SegmentList => ({
	timescale: options.timescale ?? 1,
	duration: options.duration ?? null,
	startNumber: options.startNumber ?? 1,
	availabilityTimeOffset: options.availabilityTimeOffset ?? undefined,
	availabilityTimeComplete: options.availabilityTimeComplete ?? undefined,
	presentationTimeOffset: options.presentationTimeOffset ?? 0,
	// A single-resource SegmentList states a range and no sourceURL, so neither field alone decides
	// whether the element is written.
	initialization: options.initializationUri == null && options.initializationRange == null
		? null
		: {
				sourceURL: options.initializationUri ?? null,
				range: options.initializationRange == null ? null : toByteRange(options.initializationRange),
			},
	timeline: options.timeline ?? null,
	segments: options.segments.map(toMpdSegmentUrl),
});

/**
 * Build a `<SegmentTemplate>`. Only `media` is usually needed; `@timescale`, `@startNumber` and the
 * presentation offsets default to what the schema states.
 *
 * @group DASH
 * @public
 */
export const mpdSegmentTemplate = (options: {
	/** `@media` template (`$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$`). */
	media?: string | null | undefined;
	/** `@initialization` template. */
	initialization?: string | null | undefined;
	/** `@bitstreamSwitching` template. */
	bitstreamSwitching?: string | null | undefined;
	/** `@duration` in timescale units. */
	duration?: number | null | undefined;
	/** `@timescale` (defaults to `1`). */
	timescale?: number | null | undefined;
	/** `@startNumber` (defaults to `1`). */
	startNumber?: number | null | undefined;
	/** `@endNumber`. */
	endNumber?: number | null | undefined;
	/** `@presentationTimeOffset` in timescale units (defaults to `0`). */
	presentationTimeOffset?: number | null | undefined;
	/** `@availabilityTimeOffset` in seconds (defaults to `0`). */
	availabilityTimeOffset?: number | null | undefined;
	/** `@availabilityTimeComplete` (defaults to `true`). */
	availabilityTimeComplete?: boolean | null | undefined;
	/** `<SegmentTimeline>` `<S>` entries. */
	timeline?: SegmentTemplate['timeline'] | undefined;
	/** `@index` template. */
	index?: string | null | undefined;
	/** `@indexRange`, as written. */
	indexRange?: string | null | undefined;
	/** `@indexRangeExact`. */
	indexRangeExact?: boolean | null | undefined;
	/** `@presentationDuration` in timescale units. */
	presentationDuration?: number | null | undefined;
	/** `@timeShiftBufferDepth` in seconds. */
	timeShiftBufferDepth?: number | null | undefined;
	/** `@eptDelta` in timescale units. */
	eptDelta?: number | null | undefined;
	/** `@pdDelta` in timescale units. */
	pdDelta?: number | null | undefined;
}): SegmentTemplate => ({
	media: options.media ?? null,
	initialization: options.initialization ?? null,
	bitstreamSwitching: options.bitstreamSwitching ?? null,
	duration: options.duration ?? null,
	timescale: options.timescale ?? 1,
	startNumber: options.startNumber ?? 1,
	endNumber: options.endNumber ?? null,
	presentationTimeOffset: options.presentationTimeOffset ?? 0,
	availabilityTimeOffset: options.availabilityTimeOffset ?? 0,
	availabilityTimeComplete: options.availabilityTimeComplete ?? true,
	timeline: options.timeline ?? null,
	index: options.index ?? null,
	indexRange: options.indexRange ?? null,
	indexRangeExact: options.indexRangeExact ?? null,
	presentationDuration: options.presentationDuration ?? null,
	timeShiftBufferDepth: options.timeShiftBufferDepth ?? null,
	eptDelta: options.eptDelta ?? null,
	pdDelta: options.pdDelta ?? null,
});

/**
 * Build a `<SegmentBase>` — the single-resource form, where one file holds the init and every
 * segment and `@indexRange` names the `sidx` that addresses them. This is what the on-demand
 * profile uses; {@link mpdSegmentList} and {@link mpdSegmentTemplate} are the segmented forms.
 *
 * @group DASH
 * @public
 */
export const mpdSegmentBase = (options: {
	/** `@indexRange`, naming where the `sidx` sits, as `{ start, end }` or `'start-end'`. */
	indexRange?: ByteRange | string | null | undefined;
	/** `@indexRangeExact` — set it when `indexRange` is exactly the index, so a client need not probe. */
	indexRangeExact?: boolean | null | undefined;
	/** `<Initialization @sourceURL>`, when the init is a resource of its own. */
	initializationUri?: string | null | undefined;
	/** `<Initialization @range>`, when the init is a byte range of the media resource. */
	initializationRange?: ByteRange | string | null | undefined;
	/** `@timescale` (defaults to `1`). */
	timescale?: number | null | undefined;
	/** `@presentationTimeOffset` in timescale units (defaults to `0`). */
	presentationTimeOffset?: number | null | undefined;
	/** `<RepresentationIndex>`, when the index is a resource of its own rather than an `@indexRange`. */
	representationIndex?: DashUrlElement | null | undefined;
	/** `<BitstreamSwitching>`. */
	bitstreamSwitching?: DashUrlElement | null | undefined;
	/** `<FailoverContent>`, naming the spans this resource is a failover for. */
	failoverContent?: SegmentBase['failoverContent'] | undefined;
}): SegmentBase => ({
	timescale: options.timescale ?? 1,
	presentationTimeOffset: options.presentationTimeOffset ?? 0,
	indexRange: options.indexRange == null ? null : toByteRange(options.indexRange),
	indexRangeExact: options.indexRangeExact ?? null,
	// An on-demand `<Initialization>` commonly states a range and no sourceURL, so neither field
	// alone decides whether the element is written.
	initialization: options.initializationUri == null && options.initializationRange == null
		? null
		: {
				sourceURL: options.initializationUri ?? null,
				range: options.initializationRange == null ? null : toByteRange(options.initializationRange),
			},
	representationIndex: options.representationIndex ?? null,
	bitstreamSwitching: options.bitstreamSwitching ?? null,
	failoverContent: options.failoverContent ?? null,
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
	codecs?: string | null | undefined;
	/** `@width` in pixels. */
	width?: number | null | undefined;
	/** `@height` in pixels. */
	height?: number | null | undefined;
	/** `@audioSamplingRate` in Hz. */
	audioSamplingRate?: number | null | undefined;
	/** `<SegmentList>`. */
	segmentList?: SegmentList | null | undefined;
	/** `@frameRate` as numerator/denominator pair. */
	frameRate?: MpdRepresentation['frameRate'] | undefined;
	/** Representation-level `@mimeType`. */
	mimeType?: string | null | undefined;
	/** `@sar` sample aspect ratio. */
	sar?: string | null | undefined;
	/** `@startWithSAP` SAP type. */
	startWithSAP?: number | null | undefined;
	/** `@profiles`. */
	profiles?: string | null | undefined;
	/** `@segmentProfiles`, a whitespace-separated list of 4CCs. */
	segmentProfiles?: string | null | undefined;
	/** `@containerProfiles`, a whitespace-separated list of 4CCs. */
	containerProfiles?: string | null | undefined;
	/** `@scanType` (`progressive`, `interlaced` or `unknown`). */
	scanType?: string | null | undefined;
	/** `@codingDependency`. */
	codingDependency?: boolean | null | undefined;
	/** `@maxPlayoutRate`. */
	maxPlayoutRate?: number | null | undefined;
	/** `@maximumSAPPeriod` in seconds. */
	maximumSAPPeriod?: number | null | undefined;
	/** `@selectionPriority`. */
	selectionPriority?: number | null | undefined;
	/** `@tag`. */
	tag?: string | null | undefined;
	/** `@qualityRanking`; lower is better quality among Representations in the same AdaptationSet. */
	qualityRanking?: number | null | undefined;
	/** `@dependencyId`, a whitespace-separated list of Representation ids this one depends on. */
	dependencyId?: string | null | undefined;
	/** `@associationId`, a whitespace-separated list of associated Representation ids. */
	associationId?: string | null | undefined;
	/** `@associationType`, the 4CCs describing each `associationId` entry. */
	associationType?: string | null | undefined;
	/** `@mediaStreamStructureId`, a whitespace-separated list of structure ids. */
	mediaStreamStructureId?: string | null | undefined;
	/** SCTE 214 `@scte214:supplementalCodecs`, a whitespace-separated list. */
	supplementalCodecs?: string | null | undefined;
	/** SCTE 214 `@scte214:supplementalProfiles`, a whitespace-separated list of brands. */
	supplementalProfiles?: string | null | undefined;
	/** `<Label>` children. */
	labels?: MpdRepresentation['labels'] | null | undefined;
	/** `<AudioChannelConfiguration>` descriptors. */
	audioChannelConfigurations?: MpdRepresentation['audioChannelConfigurations'] | null | undefined;
	/** `<SupplementalProperty>` descriptors. */
	supplementalProperties?: MpdRepresentation['supplementalProperties'] | null | undefined;
	/** `<EssentialProperty>` descriptors. */
	essentialProperties?: MpdRepresentation['essentialProperties'] | null | undefined;
	/** `<BaseURL>` text children. */
	baseURLs?: (string | MpdBaseURL)[] | null | undefined;
	/** `<ContentProtection>` children. */
	contentProtections?: MpdRepresentation['contentProtections'] | null | undefined;
	/** Representation-level `<SegmentTemplate>`. */
	segmentTemplate?: MpdRepresentation['segmentTemplate'] | undefined;
	/** Representation-level `<SegmentBase>`. */
	segmentBase?: MpdRepresentation['segmentBase'] | undefined;
	/** Children shared by every `RepresentationBaseType` element. */
	baseChildren?: MpdRepresentation['baseChildren'] | null | undefined;
	/** `<SubRepresentation>` children. */
	subRepresentations?: MpdRepresentation['subRepresentations'] | null | undefined;
	/** `<ExtendedBandwidth>`. */
	extendedBandwidth?: MpdRepresentation['extendedBandwidth'] | undefined;
}): MpdRepresentation => ({
	id: options.id,
	bandwidth: options.bandwidth,
	width: options.width ?? null,
	height: options.height ?? null,
	codecs: options.codecs ?? null,
	audioSamplingRate: options.audioSamplingRate ?? null,
	segmentList: options.segmentList ?? null,
	frameRate: options.frameRate ?? null,
	mimeType: options.mimeType ?? null,
	sar: options.sar ?? null,
	startWithSAP: options.startWithSAP ?? null,
	profiles: options.profiles ?? null,
	segmentProfiles: options.segmentProfiles ?? null,
	containerProfiles: options.containerProfiles ?? null,
	scanType: options.scanType ?? null,
	codingDependency: options.codingDependency ?? null,
	maxPlayoutRate: options.maxPlayoutRate ?? null,
	maximumSAPPeriod: options.maximumSAPPeriod ?? null,
	selectionPriority: options.selectionPriority ?? null,
	tag: options.tag ?? null,
	qualityRanking: options.qualityRanking ?? null,
	dependencyId: options.dependencyId ?? null,
	associationId: options.associationId ?? null,
	associationType: options.associationType ?? null,
	mediaStreamStructureId: options.mediaStreamStructureId ?? null,
	supplementalCodecs: options.supplementalCodecs ?? null,
	supplementalProfiles: options.supplementalProfiles ?? null,
	labels: options.labels ?? [],
	audioChannelConfigurations: options.audioChannelConfigurations ?? [],
	supplementalProperties: options.supplementalProperties ?? [],
	essentialProperties: options.essentialProperties ?? [],
	baseURLs: (options.baseURLs ?? []).map(toMpdBaseURL),
	contentProtections: options.contentProtections ?? [],
	segmentTemplate: options.segmentTemplate ?? null,
	segmentBase: options.segmentBase ?? null,
	baseChildren: options.baseChildren ?? emptyRepresentationBaseChildren(),
	subRepresentations: options.subRepresentations ?? [],
	extendedBandwidth: options.extendedBandwidth ?? null,
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
	contentType?: MpdAdaptationSet['contentType'] | undefined;
	/** `@mimeType`. */
	mimeType?: string | null | undefined;
	/** `@lang`. */
	lang?: string | null | undefined;
	/** `@id`. */
	id?: string | null | undefined;
	/** `@group`. */
	group?: number | null | undefined;
	/** `@codecs`. */
	codecs?: string | null | undefined;
	/** `@maxWidth`. */
	maxWidth?: number | null | undefined;
	/** `@maxHeight`. */
	maxHeight?: number | null | undefined;
	/** `@width`. */
	width?: number | null | undefined;
	/** `@height`. */
	height?: number | null | undefined;
	/** `@audioSamplingRate`. */
	audioSamplingRate?: number | null | undefined;
	/** `@par`. */
	par?: string | null | undefined;
	/** `@sar`. */
	sar?: string | null | undefined;
	/** `@startWithSAP`. */
	startWithSAP?: number | null | undefined;
	/** `@subsegmentStartsWithSAP`. */
	subsegmentStartsWithSAP?: number | null | undefined;
	/** `@bitstreamSwitching`. */
	bitstreamSwitching?: boolean | null | undefined;
	/** `@maxBandwidth`. */
	maxBandwidth?: number | null | undefined;
	/** `@minBandwidth`. */
	minBandwidth?: number | null | undefined;
	/** `@maxFrameRate`. */
	maxFrameRate?: string | null | undefined;
	/** `@minFrameRate`. */
	minFrameRate?: string | null | undefined;
	/** `@minWidth`. */
	minWidth?: number | null | undefined;
	/** `@minHeight`. */
	minHeight?: number | null | undefined;
	/** `@initializationSetRef`. */
	initializationSetRef?: string | null | undefined;
	/** `@initializationPrincipal`. */
	initializationPrincipal?: string | null | undefined;
	/** `@profiles`. */
	profiles?: string | null | undefined;
	/** `@segmentProfiles`. */
	segmentProfiles?: string | null | undefined;
	/** `@containerProfiles`. */
	containerProfiles?: string | null | undefined;
	/** `@scanType`. */
	scanType?: string | null | undefined;
	/** `@codingDependency`. */
	codingDependency?: boolean | null | undefined;
	/** `@maxPlayoutRate`. */
	maxPlayoutRate?: number | null | undefined;
	/** `@maximumSAPPeriod`. */
	maximumSAPPeriod?: number | null | undefined;
	/** `@selectionPriority`. */
	selectionPriority?: number | null | undefined;
	/** `@tag`. */
	tag?: string | null | undefined;
	/** SCTE 214 `@scte214:supplementalCodecs`, a whitespace-separated list. */
	supplementalCodecs?: string | null | undefined;
	/** SCTE 214 `@scte214:supplementalProfiles`, a whitespace-separated list of brands. */
	supplementalProfiles?: string | null | undefined;
	/** `segmentAlignment`, as on the AST. */
	segmentAlignment?: MpdAdaptationSet['segmentAlignment'] | undefined;
	/** `subsegmentAlignment`, as on the AST. */
	subsegmentAlignment?: MpdAdaptationSet['subsegmentAlignment'] | undefined;
	/** `frameRate`, as on the AST. */
	frameRate?: MpdAdaptationSet['frameRate'] | undefined;
	/** `roles`, as a child element list. */
	roles?: MpdAdaptationSet['roles'] | null | undefined;
	/** `labels`, as a child element list. */
	labels?: MpdAdaptationSet['labels'] | null | undefined;
	/** `audioChannelConfigurations`, as a child element list. */
	audioChannelConfigurations?: MpdAdaptationSet['audioChannelConfigurations'] | null | undefined;
	/** `supplementalProperties`, as a child element list. */
	supplementalProperties?: MpdAdaptationSet['supplementalProperties'] | null | undefined;
	/** `essentialProperties`, as a child element list. */
	essentialProperties?: MpdAdaptationSet['essentialProperties'] | null | undefined;
	/** `contentProtections`, as a child element list. */
	contentProtections?: MpdAdaptationSet['contentProtections'] | null | undefined;
	/** `segmentTemplate`, as on the AST. */
	segmentTemplate?: MpdAdaptationSet['segmentTemplate'] | undefined;
	/** `segmentList`, as on the AST. */
	segmentList?: MpdAdaptationSet['segmentList'] | undefined;
	/** `<BaseURL>` text children. */
	baseURLs?: (string | MpdBaseURL)[] | null | undefined;
	/** Children shared by every `RepresentationBaseType` element. */
	baseChildren?: MpdAdaptationSet['baseChildren'] | null | undefined;
	/** `<Accessibility>` descriptors. */
	accessibility?: MpdAdaptationSet['accessibility'] | null | undefined;
	/** `<Rating>` descriptors. */
	ratings?: MpdAdaptationSet['ratings'] | null | undefined;
	/** `<Viewpoint>` descriptors. */
	viewpoints?: MpdAdaptationSet['viewpoints'] | null | undefined;
	/** `<ContentComponent>` children. */
	contentComponents?: MpdAdaptationSet['contentComponents'] | null | undefined;
}): MpdAdaptationSet => ({
	id: options.id ?? null,
	contentType: options.contentType ?? null,
	mimeType: options.mimeType ?? null,
	lang: options.lang ?? null,
	baseChildren: options.baseChildren ?? emptyRepresentationBaseChildren(),
	accessibility: options.accessibility ?? [],
	ratings: options.ratings ?? [],
	viewpoints: options.viewpoints ?? [],
	contentComponents: options.contentComponents ?? [],
	representations: options.representations,
	group: options.group ?? null,
	codecs: options.codecs ?? null,
	maxWidth: options.maxWidth ?? null,
	maxHeight: options.maxHeight ?? null,
	width: options.width ?? null,
	height: options.height ?? null,
	audioSamplingRate: options.audioSamplingRate ?? null,
	par: options.par ?? null,
	sar: options.sar ?? null,
	startWithSAP: options.startWithSAP ?? null,
	subsegmentStartsWithSAP: options.subsegmentStartsWithSAP ?? null,
	bitstreamSwitching: options.bitstreamSwitching ?? null,
	maxBandwidth: options.maxBandwidth ?? null,
	minBandwidth: options.minBandwidth ?? null,
	maxFrameRate: options.maxFrameRate ?? null,
	minFrameRate: options.minFrameRate ?? null,
	minWidth: options.minWidth ?? null,
	minHeight: options.minHeight ?? null,
	initializationSetRef: options.initializationSetRef ?? null,
	initializationPrincipal: options.initializationPrincipal ?? null,
	profiles: options.profiles ?? null,
	segmentProfiles: options.segmentProfiles ?? null,
	containerProfiles: options.containerProfiles ?? null,
	scanType: options.scanType ?? null,
	codingDependency: options.codingDependency ?? null,
	maxPlayoutRate: options.maxPlayoutRate ?? null,
	maximumSAPPeriod: options.maximumSAPPeriod ?? null,
	selectionPriority: options.selectionPriority ?? null,
	tag: options.tag ?? null,
	supplementalCodecs: options.supplementalCodecs ?? null,
	supplementalProfiles: options.supplementalProfiles ?? null,
	segmentAlignment: options.segmentAlignment ?? null,
	subsegmentAlignment: options.subsegmentAlignment ?? null,
	frameRate: options.frameRate ?? null,
	roles: options.roles ?? [],
	labels: options.labels ?? [],
	audioChannelConfigurations: options.audioChannelConfigurations ?? [],
	supplementalProperties: options.supplementalProperties ?? [],
	essentialProperties: options.essentialProperties ?? [],
	contentProtections: options.contentProtections ?? [],
	segmentTemplate: options.segmentTemplate ?? null,
	segmentList: options.segmentList ?? null,
	baseURLs: (options.baseURLs ?? []).map(toMpdBaseURL),
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
	/** `<BaseURL>` text children. */
	baseURLs?: (string | MpdBaseURL)[] | null | undefined;
	/** Period-level `<ServiceDescription>` children. */
	serviceDescriptions?: MpdPeriod['serviceDescriptions'] | null | undefined;
	/** `@bitstreamSwitching`. The schema default is `false`, so omitting it is not the same as `false`. */
	bitstreamSwitching?: boolean | null | undefined;
	/** `@id`. */
	id?: string | null | undefined;
	/** `@start` in seconds. */
	start?: number | null | undefined;
	/** `@duration` in seconds. */
	duration?: number | null | undefined;
	/** `<EventStream>` children. */
	eventStreams?: MpdPeriod['eventStreams'] | null | undefined;
	/** `<AssetIdentifier>` descriptor. */
	assetIdentifier?: MpdPeriod['assetIdentifier'] | undefined;
	/** `<Subset>` children. */
	subsets?: MpdPeriod['subsets'] | null | undefined;
	/** `<GroupLabel>` children. */
	groupLabels?: MpdPeriod['groupLabels'] | null | undefined;
	/** Period-level `<SupplementalProperty>` descriptors. */
	supplementalProperties?: MpdPeriod['supplementalProperties'] | null | undefined;
	/** Period-level `<EssentialProperty>` descriptors. */
	essentialProperties?: MpdPeriod['essentialProperties'] | null | undefined;
	/** Period-level `<ContentProtection>` descriptors, which a set's `@ref` can point at. */
	contentProtections?: MpdPeriod['contentProtections'] | null | undefined;
	/** `<Preselection>` children. */
	preselections?: MpdPeriod['preselections'] | null | undefined;
	/** `<EmptyAdaptationSet>` children. */
	emptyAdaptationSets?: MpdPeriod['emptyAdaptationSets'] | null | undefined;
}): MpdPeriod => ({
	id: options.id ?? null,
	supplementalProperties: options.supplementalProperties ?? [],
	essentialProperties: options.essentialProperties ?? [],
	contentProtections: options.contentProtections ?? [],
	start: options.start ?? null,
	duration: options.duration ?? null,
	adaptationSets: options.adaptationSets,
	baseURLs: (options.baseURLs ?? []).map(toMpdBaseURL),
	serviceDescriptions: options.serviceDescriptions ?? [],
	bitstreamSwitching: options.bitstreamSwitching ?? null,
	eventStreams: options.eventStreams ?? [],
	assetIdentifier: options.assetIdentifier ?? null,
	subsets: options.subsets ?? [],
	groupLabels: options.groupLabels ?? [],
	preselections: options.preselections ?? [],
	emptyAdaptationSets: options.emptyAdaptationSets ?? [],
});

/** Whether every representation is addressed by `SegmentBase`, which the on-demand profile requires. */
const usesOnlySegmentBase = (periods: readonly MpdPeriod[]): boolean =>
	periods.every(period => period.adaptationSets.every(set =>
		set.segmentTemplate === null && set.segmentList === null
		&& set.representations.every(rep => rep.segmentTemplate === null && rep.segmentList === null)));

/**
 * Build an {@link Mpd}. Pass `type: 'dynamic'` (+ `minimumUpdatePeriod`) for live, `'static'` for VOD.
 *
 * @group DASH
 * @public
 */
export const mpd = (options: {
	/** `@type`. */
	type: Mpd['type'];
	/** `@id`, an identifier for this MPD. */
	id?: string | null | undefined;
	/** `<ContentSteering>`; pair it with `@serviceLocation` on the base URLs it steers between. */
	contentSteering?: MpdContentSteering | null | undefined;
	/** `<BaseURL>` children. A plain string is one with no `@serviceLocation`; see {@link mpdBaseURL}. */
	baseURLs?: (string | MpdBaseURL)[] | null | undefined;
	/** MPD-level `<ServiceDescription>` children. */
	serviceDescriptions?: Mpd['serviceDescriptions'] | null | undefined;
	/** `<UTCTiming>` descriptors, which tell a live client which clock the timeline is stated against. */
	utcTiming?: Mpd['utcTiming'] | null | undefined;
	/** `<Period>` children. */
	periods: readonly MpdPeriod[];
	/** `<ProgramInformation>` children. */
	programInformations?: Mpd['programInformations'] | null | undefined;
	/** `<Location>` text children. */
	locations?: string[] | null | undefined;
	/** `<PatchLocation>` children. */
	patchLocations?: Mpd['patchLocations'] | null | undefined;
	/** `<Metrics>` children. */
	metrics?: Mpd['metrics'] | null | undefined;
	/** `<LeapSecondInformation>`. */
	leapSecondInformation?: Mpd['leapSecondInformation'] | undefined;
	/** `<InitializationSet>` children. */
	initializationSets?: Mpd['initializationSets'] | null | undefined;
	/** `<InitializationGroup>` children. */
	initializationGroups?: Mpd['initializationGroups'] | null | undefined;
	/** `<InitializationPresentation>` children. */
	initializationPresentations?: Mpd['initializationPresentations'] | null | undefined;
	/** `@profiles` URNs (defaults to the ISO live/on-demand profile matching `type`). */
	profiles?: string[] | null | undefined;
	/** `@minBufferTime` in seconds. */
	minBufferTime?: number | null | undefined;
	/** `@maxSegmentDuration` in seconds. */
	maxSegmentDuration?: number | null | undefined;
	/** `@maxSubsegmentDuration` in seconds, which the on-demand profile states instead. */
	maxSubsegmentDuration?: number | null | undefined;
	/** `xsi:schemaLocation`; writing it also declares `xmlns:xsi`. */
	schemaLocation?: string | null | undefined;
	/** `@minimumUpdatePeriod` in seconds (live). */
	minimumUpdatePeriod?: number | null | undefined;
	/** `@mediaPresentationDuration` in seconds (VOD). */
	mediaPresentationDuration?: number | null | undefined;
	/** `@availabilityStartTime` as Unix milliseconds. */
	availabilityStartTime?: number | null | undefined;
	/** `@publishTime` as Unix milliseconds. */
	publishTime?: number | null | undefined;
	/** `@timeShiftBufferDepth` in seconds (live DVR window). */
	timeShiftBufferDepth?: number | null | undefined;
	/**
	 * `@suggestedPresentationDelay` in seconds (live). DASH defines no default, so a player that is
	 * given none picks its own — typically from `@minBufferTime`, which is usually far smaller than
	 * the three target durations an HLS player gets for free, leaving it close enough to the live
	 * edge to starve. Omitted when absent.
	 */
	suggestedPresentationDelay?: number | null | undefined;
	/** MPD-level `<ContentProtection>` descriptors, which a Period's or set's `@ref` can point at. */
	contentProtections?: Mpd['contentProtections'] | null | undefined;
}): Mpd => ({
	id: options.id ?? null,
	type: options.type,
	contentProtections: options.contentProtections ?? [],
	profiles: options.profiles ?? [
		options.type === 'static' && usesOnlySegmentBase(options.periods)
			? 'urn:mpeg:dash:profile:isoff-on-demand:2011'
			: 'urn:mpeg:dash:profile:isoff-live:2011',
	],
	mediaPresentationDuration: options.mediaPresentationDuration ?? null,
	minimumUpdatePeriod: options.minimumUpdatePeriod ?? null,
	availabilityStartTime: options.availabilityStartTime ?? null,
	publishTime: options.publishTime ?? null,
	timeShiftBufferDepth: options.timeShiftBufferDepth ?? null,
	suggestedPresentationDelay: options.suggestedPresentationDelay ?? null,
	maxSegmentDuration: options.maxSegmentDuration ?? null,
	maxSubsegmentDuration: options.maxSubsegmentDuration ?? null,
	minBufferTime: options.minBufferTime ?? null,
	baseURLs: (options.baseURLs ?? []).map(toMpdBaseURL),
	contentSteering: options.contentSteering ?? null,
	schemaLocation: options.schemaLocation ?? null,
	serviceDescriptions: options.serviceDescriptions ?? [],
	utcTiming: options.utcTiming ?? [],
	periods: [...options.periods],
	programInformations: options.programInformations ?? [],
	locations: options.locations ?? [],
	patchLocations: options.patchLocations ?? [],
	metrics: options.metrics ?? [],
	leapSecondInformation: options.leapSecondInformation ?? null,
	initializationSets: options.initializationSets ?? [],
	initializationGroups: options.initializationGroups ?? [],
	initializationPresentations: options.initializationPresentations ?? [],
});

/**
 * Build an {@link MpdServiceDescription} (`<ServiceDescription>`). The nested `<Latency>` and `<PlaybackRate>`
 * are built from their own fields, so a caller setting only a latency target states only that.
 *
 * @group DASH
 * @public
 */
export const mpdServiceDescription = (options: {
	/** `@id`. */
	id?: number | null | undefined;
	/** `<Latency>` fields; `target`, `min` and `max` are milliseconds. */
	latency?: {
		/** `@referenceId`. */
		referenceId?: number | null | undefined;
		/** `@target` in milliseconds. */
		target?: number | null | undefined;
		/** `@min` in milliseconds. */
		min?: number | null | undefined;
		/** `@max` in milliseconds. */
		max?: number | null | undefined;
		/** `<QualityLatency>` children. */
		qualityLatency?: NonNullable<MpdServiceDescription['latency']>['qualityLatency'] | null | undefined;
	} | null | undefined;
	/** `<PlaybackRate>` bounds. */
	playbackRate?: {
		/** `@min` rate. */
		min?: number | null | undefined;
		/** `@max` rate. */
		max?: number | null | undefined;
	} | null | undefined;
	/** `<Scope>` descriptors. */
	scopes?: MpdServiceDescription['scopes'] | null | undefined;
	/** `<OperatingQuality>` children. */
	operatingQuality?: MpdServiceDescription['operatingQuality'] | null | undefined;
	/** `<OperatingBandwidth>` children. */
	operatingBandwidth?: MpdServiceDescription['operatingBandwidth'] | null | undefined;
}): MpdServiceDescription => ({
	id: options.id ?? null,
	latency: options.latency == null
		? null
		: {
				referenceId: options.latency.referenceId ?? null,
				target: options.latency.target ?? null,
				min: options.latency.min ?? null,
				max: options.latency.max ?? null,
				qualityLatency: options.latency.qualityLatency ?? [],
			},
	playbackRate: options.playbackRate == null
		? null
		: {
				min: options.playbackRate.min ?? null,
				max: options.playbackRate.max ?? null,
			},
	scopes: options.scopes ?? [],
	operatingQuality: options.operatingQuality ?? [],
	operatingBandwidth: options.operatingBandwidth ?? [],
});

/**
 * Build an {@link MpdBaseURL} — a `<BaseURL>` with the `@serviceLocation` content steering matches
 * a pathway against.
 *
 * @group DASH
 * @public
 */
export const mpdBaseURL = (options: {
	/** The URI reference. */
	value: string;
	/** `@serviceLocation` naming the pathway this URL belongs to. */
	serviceLocation?: string | null | undefined;
	/** `@availabilityTimeOffset` in seconds (defaults to `0`). */
	availabilityTimeOffset?: number | null | undefined;
	/** `@availabilityTimeComplete` (defaults to `true`). */
	availabilityTimeComplete?: boolean | null | undefined;
	/** `@dvb:priority` — lower wins when a client chooses between mirrors (DVB A168). */
	dvbPriority?: number | null | undefined;
	/** `@dvb:weight` — the share of load this mirror takes among equal priorities (DVB A168). */
	dvbWeight?: number | null | undefined;
}): MpdBaseURL => ({
	value: options.value,
	serviceLocation: options.serviceLocation ?? null,
	availabilityTimeOffset: options.availabilityTimeOffset ?? undefined,
	availabilityTimeComplete: options.availabilityTimeComplete ?? undefined,
	dvbPriority: options.dvbPriority ?? undefined,
	dvbWeight: options.dvbWeight ?? undefined,
});

/**
 * Build an {@link MpdContentSteering} (`<ContentSteering>`).
 *
 * Pair it with base URLs that carry a `serviceLocation`, built with {@link mpdBaseURL}: the steering
 * server answers with pathway names, and those names are matched against that attribute. Without it
 * there is nothing for a client to switch between.
 *
 * @group DASH
 * @public
 */
export const mpdContentSteering = (options: {
	/** The steering server URL. */
	value: string;
	/** `@defaultServiceLocation` — used until the first steering response arrives. */
	defaultServiceLocation?: string | null | undefined;
	/** `@queryBeforeStart` — whether to query the server before requesting any media. */
	queryBeforeStart?: boolean | null | undefined;
	/** `@proxyServerURL`. */
	proxyServerURL?: string | null | undefined;
	/** `@clientRequirement` — whether a client that cannot steer may still play. */
	clientRequirement?: boolean | null | undefined;
}): MpdContentSteering => ({
	value: options.value,
	defaultServiceLocation: options.defaultServiceLocation ?? null,
	queryBeforeStart: options.queryBeforeStart ?? null,
	proxyServerURL: options.proxyServerURL ?? null,
	clientRequirement: options.clientRequirement ?? null,
});

/** A plain string is the common case; an entry is needed only when it carries `@serviceLocation`. */
const toMpdBaseURL = (entry: string | MpdBaseURL): MpdBaseURL =>
	typeof entry === 'string' ? { value: entry, serviceLocation: null } : entry;

/**
 * The DASH-IF scheme that marks an image Representation as a grid of thumbnails.
 *
 * @group DASH
 * @public
 */
export const THUMBNAIL_TILE_SCHEME_ID_URI = 'http://dashif.org/guidelines/thumbnail_tile';

/**
 * The same scheme without the `guidelines` path segment. Packagers in the wild emit both, so it is
 * accepted when reading and never written.
 *
 * @group DASH
 * @public
 */
export const THUMBNAIL_TILE_SCHEME_ID_URI_LEGACY = 'http://dashif.org/thumbnail_tile';

/**
 * A grid of thumbnails packed into one image, as `<EssentialProperty>` states it.
 *
 * @group DASH
 * @public
 */
export type MpdThumbnailTile = {
	/** Tiles across. */
	columns: number;
	/** Tiles down. */
	rows: number;
};

/**
 * Build the `<EssentialProperty>` that marks an image Representation as a tile grid. Put it on the
 * Representation, inside an AdaptationSet whose `contentType` is `'image'`.
 *
 * @group DASH
 * @public
 */
export const mpdThumbnailTile = (tile: MpdThumbnailTile): DashDescriptor => ({
	schemeIdUri: THUMBNAIL_TILE_SCHEME_ID_URI,
	value: `${tile.columns}x${tile.rows}`,
	id: null,
});

/**
 * Read a thumbnail tile grid out of a Representation's descriptors, or `null` when it carries none.
 * Accepts either spelling of the scheme.
 *
 * The `@value` is `COLUMNSxROWS` — five across and two down is `5x2`, so a tile sheet holds ten
 * thumbnails and each one is the Representation's width and height divided by that grid.
 *
 * @group DASH
 * @public
 */
export const readMpdThumbnailTile = (descriptors: DashDescriptor[]): MpdThumbnailTile | null => {
	for (const descriptor of descriptors) {
		if (
			descriptor.schemeIdUri !== THUMBNAIL_TILE_SCHEME_ID_URI
			&& descriptor.schemeIdUri !== THUMBNAIL_TILE_SCHEME_ID_URI_LEGACY
		) {
			continue;
		}

		const match = /^(\d+)x(\d+)$/i.exec(descriptor.value?.trim() ?? '');
		if (!match) {
			continue;
		}

		const columns = Number(match[1]);
		const rows = Number(match[2]);
		if (columns > 0 && rows > 0) {
			return { columns, rows };
		}
	}

	return null;
};
