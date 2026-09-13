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
	type MpdServiceDescription,
	type SegmentTemplate,
	emptyRepresentationBaseChildren,
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
	/** `@presentationTimeOffset` in timescale units (defaults to `0`). */
	presentationTimeOffset?: number;
	/** `<SegmentTimeline>` `<S>` entries. */
	timeline?: SegmentList['timeline'];
}): SegmentList => ({
	timescale: options.timescale ?? 1,
	duration: options.duration ?? null,
	startNumber: options.startNumber ?? 1,
	presentationTimeOffset: options.presentationTimeOffset ?? 0,
	initialization: options.initializationUri === undefined
		? null
		: { sourceURL: options.initializationUri, range: null },
	timeline: options.timeline ?? null,
	segments: options.segments.map(media => ({ media, mediaRange: null, index: null, indexRange: null })),
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
	media?: string;
	/** `@initialization` template. */
	initialization?: string;
	/** `@bitstreamSwitching` template. */
	bitstreamSwitching?: string;
	/** `@duration` in timescale units. */
	duration?: number;
	/** `@timescale` (defaults to `1`). */
	timescale?: number;
	/** `@startNumber` (defaults to `1`). */
	startNumber?: number;
	/** `@endNumber`. */
	endNumber?: number;
	/** `@presentationTimeOffset` in timescale units (defaults to `0`). */
	presentationTimeOffset?: number;
	/** `@availabilityTimeOffset` in seconds (defaults to `0`). */
	availabilityTimeOffset?: number;
	/** `@availabilityTimeComplete` (defaults to `true`). */
	availabilityTimeComplete?: boolean;
	/** `<SegmentTimeline>` `<S>` entries. */
	timeline?: SegmentTemplate['timeline'];
	/** `@index` template. */
	index?: string;
	/** `@indexRange`, as written. */
	indexRange?: string;
	/** `@indexRangeExact`. */
	indexRangeExact?: boolean;
	/** `@presentationDuration` in timescale units. */
	presentationDuration?: number;
	/** `@timeShiftBufferDepth` in seconds. */
	timeShiftBufferDepth?: number;
	/** `@eptDelta` in timescale units. */
	eptDelta?: number;
	/** `@pdDelta` in timescale units. */
	pdDelta?: number;
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
	/** `@frameRate` as numerator/denominator pair. */
	frameRate?: MpdRepresentation['frameRate'];
	/** Representation-level `@mimeType`. */
	mimeType?: string;
	/** `@sar` sample aspect ratio. */
	sar?: string;
	/** `@startWithSAP` SAP type. */
	startWithSAP?: number;
	/** `@profiles`. */
	profiles?: string;
	/** `@segmentProfiles`, a whitespace-separated list of 4CCs. */
	segmentProfiles?: string;
	/** `@containerProfiles`, a whitespace-separated list of 4CCs. */
	containerProfiles?: string;
	/** `@scanType` (`progressive`, `interlaced` or `unknown`). */
	scanType?: string;
	/** `@codingDependency`. */
	codingDependency?: boolean;
	/** `@maxPlayoutRate`. */
	maxPlayoutRate?: number;
	/** `@maximumSAPPeriod` in seconds. */
	maximumSAPPeriod?: number;
	/** `@selectionPriority`. */
	selectionPriority?: number;
	/** `@tag`. */
	tag?: string;
	/** `@qualityRanking`; lower is better quality among Representations in the same AdaptationSet. */
	qualityRanking?: number;
	/** `@dependencyId`, a whitespace-separated list of Representation ids this one depends on. */
	dependencyId?: string;
	/** `@associationId`, a whitespace-separated list of associated Representation ids. */
	associationId?: string;
	/** `@associationType`, the 4CCs describing each `associationId` entry. */
	associationType?: string;
	/** `@mediaStreamStructureId`, a whitespace-separated list of structure ids. */
	mediaStreamStructureId?: string;
	/** `<Label>` children. */
	labels?: MpdRepresentation['labels'];
	/** `<AudioChannelConfiguration>` descriptors. */
	audioChannelConfigurations?: MpdRepresentation['audioChannelConfigurations'];
	/** `<SupplementalProperty>` descriptors. */
	supplementalProperties?: MpdRepresentation['supplementalProperties'];
	/** `<EssentialProperty>` descriptors. */
	essentialProperties?: MpdRepresentation['essentialProperties'];
	/** `<BaseURL>` text children. */
	baseURLs?: string[];
	/** `<ContentProtection>` children. */
	contentProtections?: MpdRepresentation['contentProtections'];
	/** Representation-level `<SegmentTemplate>`. */
	segmentTemplate?: MpdRepresentation['segmentTemplate'];
	/** Representation-level `<SegmentBase>`. */
	segmentBase?: MpdRepresentation['segmentBase'];
	/** Children shared by every `RepresentationBaseType` element. */
	baseChildren?: MpdRepresentation['baseChildren'];
	/** `<SubRepresentation>` children. */
	subRepresentations?: MpdRepresentation['subRepresentations'];
	/** `<ExtendedBandwidth>`. */
	extendedBandwidth?: MpdRepresentation['extendedBandwidth'];
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
	labels: options.labels ?? [],
	audioChannelConfigurations: options.audioChannelConfigurations ?? [],
	supplementalProperties: options.supplementalProperties ?? [],
	essentialProperties: options.essentialProperties ?? [],
	baseURLs: options.baseURLs ?? [],
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
	contentType?: MpdAdaptationSet['contentType'];
	/** `@mimeType`. */
	mimeType?: string;
	/** `@lang`. */
	lang?: string;
	/** `@id`. */
	id?: string;
	/** `@group`. */
	group?: number;
	/** `@codecs`. */
	codecs?: string;
	/** `@maxWidth`. */
	maxWidth?: number;
	/** `@maxHeight`. */
	maxHeight?: number;
	/** `@width`. */
	width?: number;
	/** `@height`. */
	height?: number;
	/** `@audioSamplingRate`. */
	audioSamplingRate?: number;
	/** `@par`. */
	par?: string;
	/** `@sar`. */
	sar?: string;
	/** `@startWithSAP`. */
	startWithSAP?: number;
	/** `@subsegmentStartsWithSAP`. */
	subsegmentStartsWithSAP?: number;
	/** `@bitstreamSwitching`. */
	bitstreamSwitching?: boolean;
	/** `@maxBandwidth`. */
	maxBandwidth?: number;
	/** `@minBandwidth`. */
	minBandwidth?: number;
	/** `@maxFrameRate`. */
	maxFrameRate?: string;
	/** `@minFrameRate`. */
	minFrameRate?: string;
	/** `@minWidth`. */
	minWidth?: number;
	/** `@minHeight`. */
	minHeight?: number;
	/** `@initializationSetRef`. */
	initializationSetRef?: string;
	/** `@initializationPrincipal`. */
	initializationPrincipal?: string;
	/** `@profiles`. */
	profiles?: string;
	/** `@segmentProfiles`. */
	segmentProfiles?: string;
	/** `@containerProfiles`. */
	containerProfiles?: string;
	/** `@scanType`. */
	scanType?: string;
	/** `@codingDependency`. */
	codingDependency?: boolean;
	/** `@maxPlayoutRate`. */
	maxPlayoutRate?: number;
	/** `@maximumSAPPeriod`. */
	maximumSAPPeriod?: number;
	/** `@selectionPriority`. */
	selectionPriority?: number;
	/** `@tag`. */
	tag?: string;
	/** `segmentAlignment`, as on the AST. */
	segmentAlignment?: MpdAdaptationSet['segmentAlignment'];
	/** `subsegmentAlignment`, as on the AST. */
	subsegmentAlignment?: MpdAdaptationSet['subsegmentAlignment'];
	/** `frameRate`, as on the AST. */
	frameRate?: MpdAdaptationSet['frameRate'];
	/** `roles`, as a child element list. */
	roles?: MpdAdaptationSet['roles'];
	/** `labels`, as a child element list. */
	labels?: MpdAdaptationSet['labels'];
	/** `audioChannelConfigurations`, as a child element list. */
	audioChannelConfigurations?: MpdAdaptationSet['audioChannelConfigurations'];
	/** `supplementalProperties`, as a child element list. */
	supplementalProperties?: MpdAdaptationSet['supplementalProperties'];
	/** `essentialProperties`, as a child element list. */
	essentialProperties?: MpdAdaptationSet['essentialProperties'];
	/** `contentProtections`, as a child element list. */
	contentProtections?: MpdAdaptationSet['contentProtections'];
	/** `segmentTemplate`, as on the AST. */
	segmentTemplate?: MpdAdaptationSet['segmentTemplate'];
	/** `segmentList`, as on the AST. */
	segmentList?: MpdAdaptationSet['segmentList'];
	/** `<BaseURL>` text children. */
	baseURLs?: string[];
	/** Children shared by every `RepresentationBaseType` element. */
	baseChildren?: MpdAdaptationSet['baseChildren'];
	/** `<Accessibility>` descriptors. */
	accessibility?: MpdAdaptationSet['accessibility'];
	/** `<Rating>` descriptors. */
	ratings?: MpdAdaptationSet['ratings'];
	/** `<Viewpoint>` descriptors. */
	viewpoints?: MpdAdaptationSet['viewpoints'];
	/** `<ContentComponent>` children. */
	contentComponents?: MpdAdaptationSet['contentComponents'];
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
	baseURLs: options.baseURLs ?? [],
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
	baseURLs?: string[];
	/** Period-level `<ServiceDescription>` children. */
	serviceDescriptions?: MpdPeriod['serviceDescriptions'];
	/** `@bitstreamSwitching`. The schema default is `false`, so omitting it is not the same as `false`. */
	bitstreamSwitching?: boolean;
	/** `@id`. */
	id?: string;
	/** `@start` in seconds. */
	start?: number;
	/** `@duration` in seconds. */
	duration?: number;
	/** `<EventStream>` children. */
	eventStreams?: MpdPeriod['eventStreams'];
	/** `<AssetIdentifier>` descriptor. */
	assetIdentifier?: MpdPeriod['assetIdentifier'];
	/** `<Subset>` children. */
	subsets?: MpdPeriod['subsets'];
	/** `<GroupLabel>` children. */
	groupLabels?: MpdPeriod['groupLabels'];
	/** `<Preselection>` children. */
	preselections?: MpdPeriod['preselections'];
	/** `<EmptyAdaptationSet>` children. */
	emptyAdaptationSets?: MpdPeriod['emptyAdaptationSets'];
}): MpdPeriod => ({
	id: options.id ?? null,
	start: options.start ?? null,
	duration: options.duration ?? null,
	adaptationSets: options.adaptationSets,
	baseURLs: options.baseURLs ?? [],
	serviceDescriptions: options.serviceDescriptions ?? [],
	bitstreamSwitching: options.bitstreamSwitching ?? null,
	eventStreams: options.eventStreams ?? [],
	assetIdentifier: options.assetIdentifier ?? null,
	subsets: options.subsets ?? [],
	groupLabels: options.groupLabels ?? [],
	preselections: options.preselections ?? [],
	emptyAdaptationSets: options.emptyAdaptationSets ?? [],
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
	/** `<ProgramInformation>` children. */
	programInformations?: Mpd['programInformations'];
	/** `<Location>` text children. */
	locations?: string[];
	/** `<PatchLocation>` children. */
	patchLocations?: Mpd['patchLocations'];
	/** `<Metrics>` children. */
	metrics?: Mpd['metrics'];
	/** `<LeapSecondInformation>`. */
	leapSecondInformation?: Mpd['leapSecondInformation'];
	/** `<InitializationSet>` children. */
	initializationSets?: Mpd['initializationSets'];
	/** `<InitializationGroup>` children. */
	initializationGroups?: Mpd['initializationGroups'];
	/** `<InitializationPresentation>` children. */
	initializationPresentations?: Mpd['initializationPresentations'];
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
	profiles: options.profiles ?? [
		options.type === 'static'
			? 'urn:mpeg:dash:profile:isoff-on-demand:2011'
			: 'urn:mpeg:dash:profile:isoff-live:2011',
	],
	mediaPresentationDuration: options.mediaPresentationDuration ?? null,
	minimumUpdatePeriod: options.minimumUpdatePeriod ?? null,
	availabilityStartTime: options.availabilityStartTime ?? null,
	publishTime: null,
	timeShiftBufferDepth: options.timeShiftBufferDepth ?? null,
	suggestedPresentationDelay: null,
	maxSegmentDuration: null,
	minBufferTime: options.minBufferTime ?? null,
	baseURLs: [],
	schemaLocation: null,
	serviceDescriptions: [],
	utcTiming: [],
	periods: options.periods,
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
	id?: number;
	/** `<Latency>` fields; `target`, `min` and `max` are milliseconds. */
	latency?: {
		/** `@referenceId`. */
		referenceId?: number;
		/** `@target` in milliseconds. */
		target?: number;
		/** `@min` in milliseconds. */
		min?: number;
		/** `@max` in milliseconds. */
		max?: number;
		/** `<QualityLatency>` children. */
		qualityLatency?: NonNullable<MpdServiceDescription['latency']>['qualityLatency'];
	};
	/** `<PlaybackRate>` bounds. */
	playbackRate?: {
		/** `@min` rate. */
		min?: number;
		/** `@max` rate. */
		max?: number;
	};
	/** `<Scope>` descriptors. */
	scopes?: MpdServiceDescription['scopes'];
	/** `<OperatingQuality>` children. */
	operatingQuality?: MpdServiceDescription['operatingQuality'];
	/** `<OperatingBandwidth>` children. */
	operatingBandwidth?: MpdServiceDescription['operatingBandwidth'];
}): MpdServiceDescription => ({
	id: options.id ?? null,
	latency: options.latency === undefined
		? null
		: {
				referenceId: options.latency.referenceId ?? null,
				target: options.latency.target ?? null,
				min: options.latency.min ?? null,
				max: options.latency.max ?? null,
				qualityLatency: options.latency.qualityLatency ?? [],
			},
	playbackRate: options.playbackRate === undefined
		? null
		: {
				min: options.playbackRate.min ?? null,
				max: options.playbackRate.max ?? null,
			},
	scopes: options.scopes ?? [],
	operatingQuality: options.operatingQuality ?? [],
	operatingBandwidth: options.operatingBandwidth ?? [],
});
