/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { base64ToBytes } from '../misc';
import { MinimalDomParser } from './dash-xml-dom-parser';
import {
	DASH_NS,
	type DashRational,
	normaliseKeyId,
	parseByteRange,
	parseFrameRate,
	parseISODateTime,
	parseISODuration,
} from './dash-misc';

/** Typed AST for a parsed DASH MPD document (ISO/IEC 23009-1). @group DASH @public */
/**
 * A `<BaseURL>` and its attributes. `@serviceLocation` is what a content steering pathway is matched
 * against, so it has to travel with the URL rather than beside it — a parallel list of plain strings
 * went stale the moment anything rewrote the URLs.
 *
 * @group DASH
 * @public
 */
export type MpdBaseURL = {
	/** The URI reference (the element's text content). */
	value: string;
	/** `@serviceLocation`, or `null` when absent. */
	serviceLocation: string | null;
};

/**
 * `<ContentSteering>` (ISO/IEC 23009-1 content steering). The element's value is the steering
 * server's URL; a client maps the pathways that server returns onto `<BaseURL>` elements by their
 * `@serviceLocation`, so steering only works when those carry one.
 *
 * @group DASH
 * @public
 */
export type MpdContentSteering = {
	/** The steering server URL (the element's text content). */
	value: string;
	/** `@defaultServiceLocation` — used until the first steering response arrives. */
	defaultServiceLocation: string | null;
	/** `@queryBeforeStart` — whether to query the server before requesting any media. */
	queryBeforeStart: boolean | null;
	/** `@proxyServerURL`. */
	proxyServerURL: string | null;
	/** `@clientRequirement` — whether a client that cannot steer may still play. */
	clientRequirement: boolean | null;
};

/** A parsed `<MPD>` document root. @group DASH @public */
export type Mpd = {
	/** `@type` — `'static'` for VOD, `'dynamic'` for live. */
	type: 'static' | 'dynamic';
	/** Parsed `@profiles` URN list. */
	profiles: string[];
	/** `@mediaPresentationDuration` in seconds, or `null` when absent (e.g. live). */
	mediaPresentationDuration: number | null;
	/** `@minimumUpdatePeriod` in seconds (live only). */
	minimumUpdatePeriod: number | null;
	/** `@availabilityStartTime` as Unix milliseconds. */
	availabilityStartTime: number | null;
	/** `@publishTime` as Unix milliseconds. */
	publishTime: number | null;
	/** `@timeShiftBufferDepth` in seconds (live DVR window). */
	timeShiftBufferDepth: number | null;
	/** `@suggestedPresentationDelay` in seconds. */
	suggestedPresentationDelay: number | null;
	/** `@maxSegmentDuration` in seconds. */
	maxSegmentDuration: number | null;
	/** `@minBufferTime` in seconds. */
	minBufferTime: number | null;
	/** `<BaseURL>` text children. */
	baseURLs: MpdBaseURL[];
	/** `xsi:schemaLocation`; serializing it also declares `xmlns:xsi`. */
	schemaLocation: string | null;
	/** MPD-level `<ServiceDescription>` children. */
	serviceDescriptions: MpdServiceDescription[];
	/** `<UTCTiming>` descriptors. */
	utcTiming: {
		/** UTCTiming `@schemeIdUri`. */
		schemeIdUri: string;
		/** UTCTiming `@value`. */
		value: string;
	}[];
	/** `<ProgramInformation>` children. */
	programInformations: {
		/** `@lang`. */
		lang: string | null;
		/** `@moreInformationURL`. */
		moreInformationURL: string | null;
		/** `<Title>` text. */
		title: string | null;
		/** `<Source>` text. */
		source: string | null;
		/** `<Copyright>` text. */
		copyright: string | null;
	}[];
	/** `<ContentSteering>`, or `null` when absent. */
	contentSteering: MpdContentSteering | null;
	/** `<Location>` text children. */
	locations: string[];
	/** `<PatchLocation>` children. */
	patchLocations: {
		/** `@ttl` in seconds. */
		ttl: number | null;
		/** The patch URL. */
		value: string;
	}[];
	/** `<Metrics>` children. */
	metrics: {
		/** `@metrics`. */
		metrics: string | null;
		/** `<Reporting>` descriptors. */
		reporting: DashDescriptor[];
		/** `<Range>` children. */
		ranges: {
			/** `@starttime` in seconds. */
			starttime: number | null;
			/** `@duration` in seconds. */
			duration: number | null;
		}[];
	}[];
	/** `<LeapSecondInformation>`. */
	leapSecondInformation: {
		/** `@availabilityStartLeapOffset`. */
		availabilityStartLeapOffset: number | null;
		/** `@nextAvailabilityStartLeapOffset`. */
		nextAvailabilityStartLeapOffset: number | null;
		/** `@nextLeapChangeTime`, as written. */
		nextLeapChangeTime: string | null;
	} | null;
	/** `<InitializationSet>` children. */
	initializationSets: {
		/** `@id`. */
		id: number | null;
		/** `@inAllPeriods`. */
		inAllPeriods: boolean | null;
		/** `@contentType`. */
		contentType: string | null;
		/** `@par`. */
		par: string | null;
		/** `@maxWidth`. */
		maxWidth: number | null;
		/** `@maxHeight`. */
		maxHeight: number | null;
		/** `@maxFrameRate`, as written. */
		maxFrameRate: string | null;
		/** `@initialization` URL. */
		initialization: string | null;
		/** Children shared by every `RepresentationBaseType` element. */
		baseChildren: MpdRepresentationBaseChildren;
	}[];
	/** `<InitializationGroup>` children. */
	initializationGroups: MpdInitializationReference[];
	/** `<InitializationPresentation>` children. */
	initializationPresentations: MpdInitializationReference[];
	/** `<Period>` children in document order. */
	periods: MpdPeriod[];
};

/** A `<Period>` from a parsed MPD. @group DASH @public */
export type MpdPeriod = {
	/** Period `@id`. */
	id: string | null;
	/** Period `@start` in seconds. */
	start: number | null;
	/** Period `@duration` in seconds. */
	duration: number | null;
	/** `<BaseURL>` text children. */
	baseURLs: MpdBaseURL[];
	/** Period-level `<ServiceDescription>` children, where low-latency output writes them. */
	serviceDescriptions: MpdServiceDescription[];
	/** `<AdaptationSet>` children in document order. */
	adaptationSets: MpdAdaptationSet[];
	/** `@bitstreamSwitching`. The schema default is `false`, so an omitted attribute is not the same as `null` here. */
	bitstreamSwitching: boolean | null;
	/** `<EventStream>` children, which carry SCTE-35 and other timed signals. */
	eventStreams: MpdEventStream[];
	/** `<AssetIdentifier>` descriptor. */
	assetIdentifier: DashDescriptor | null;
	/** `<Subset>` children. */
	subsets: {
		/** `@contains`, the AdaptationSet indices in the subset. */
		contains: string | null;
		/** `@id`. */
		id: string | null;
	}[];
	/** `<GroupLabel>` children. */
	groupLabels: MpdLabel[];
	/** `<Preselection>` children. */
	preselections: {
		/** `@id`. */
		id: string | null;
		/** `@preselectionComponents`, a whitespace-separated list of component ids. */
		preselectionComponents: string | null;
		/** `@lang`. */
		lang: string | null;
		/** `@order` (`undefined`, `time-ordered` or `fully-ordered`). */
		order: string | null;
		/** `<Accessibility>` descriptors. */
		accessibility: DashDescriptor[];
		/** `<Role>` descriptors. */
		roles: DashDescriptor[];
		/** `<Rating>` descriptors. */
		ratings: DashDescriptor[];
		/** `<Viewpoint>` descriptors. */
		viewpoints: DashDescriptor[];
		/** Children shared by every `RepresentationBaseType` element. */
		baseChildren: MpdRepresentationBaseChildren;
	}[];
	/** `<EmptyAdaptationSet>` children, which have the `AdaptationSet` shape but carry no Representations. */
	emptyAdaptationSets: MpdAdaptationSet[];
};

/**
 * A `<ServiceDescription>`: the latency and playback rate a low-latency service is meant to be played at.
 * @group DASH @public
 */
export type MpdServiceDescription = {
	/** `@id`. */
	id: number | null;
	/** `<Latency>`; `target`, `min` and `max` are in milliseconds. `null` when absent. */
	latency: {
		/** `@referenceId`, naming the `<ProducerReferenceTime>` the latency is measured against. */
		referenceId: number | null;
		/** `@target` latency in milliseconds. */
		target: number | null;
		/** `@min` latency in milliseconds. */
		min: number | null;
		/** `@max` latency in milliseconds. */
		max: number | null;
		/** `<QualityLatency>` children. */
		qualityLatency: {
			/** `@type`. */
			type: string | null;
			/** Text content: whitespace-separated unsigned-int pairs. */
			value: string;
		}[];
	} | null;
	/** `<PlaybackRate>` bounds, as multiples of normal speed. `null` when absent. */
	playbackRate: {
		/** `@min` rate. */
		min: number | null;
		/** `@max` rate. */
		max: number | null;
	} | null;
	/** `<Scope>` descriptors. */
	scopes: DashDescriptor[];
	/** `<OperatingQuality>` children. */
	operatingQuality: {
		/** `@type`. */
		type: string | null;
		/** `@min`. */
		min: number | null;
		/** `@max`. */
		max: number | null;
		/** `@target`. */
		target: number | null;
		/** `@maxDifference`. */
		maxDifference: number | null;
	}[];
	/** `<OperatingBandwidth>` children. */
	operatingBandwidth: {
		/** `@min` in bits per second. */
		min: number | null;
		/** `@max` in bits per second. */
		max: number | null;
		/** `@target` in bits per second. */
		target: number | null;
	}[];
};

/**
 * A generic MPD descriptor (`<SupplementalProperty>`, `<EssentialProperty>`, …): a `@schemeIdUri`
 * with an optional `@value`.
 *
 * @group DASH @public
 */
export type DashDescriptor = {
	/** `@schemeIdUri`. */
	schemeIdUri: string;
	/** `@value`, or `null` when the descriptor carries no value. */
	value: string | null;
	/** `@id`. */
	id: string | null;
};

/** A `<URL>`-shaped element (`<RepresentationIndex>`, `<BitstreamSwitching>`). @group DASH @public */
export type DashUrlElement = {
	/** `@sourceURL`. */
	sourceURL: string | null;
	/** `@range`, as written. */
	range: string | null;
};

/** One `<Event>` inside an `<EventStream>` or `<InbandEventStream>`. @group DASH @public */
export type MpdEvent = {
	/** `@presentationTime` in the stream's timescale. */
	presentationTime: number | null;
	/** `@duration` in the stream's timescale. */
	duration: number | null;
	/** `@id`. */
	id: number | null;
	/** `@contentEncoding`, e.g. `base64`. */
	contentEncoding: string | null;
	/** `@messageData`. */
	messageData: string | null;
	/** Element text content, which carries the payload when `@messageData` is absent. */
	value: string | null;
	/**
	 * Foreign-namespace child elements, kept as written. `EventType` is `mixed` with
	 * `xs:any namespace="##other"`, so an SCTE-35 `<Signal>` lives here and is re-emitted verbatim.
	 */
	foreignXml: string[];
};

/** An `<EventStream>` or `<InbandEventStream>`. @group DASH @public */
export type MpdEventStream = {
	/** `@schemeIdUri`. */
	schemeIdUri: string;
	/** `@value`. */
	value: string | null;
	/** `@timescale`. */
	timescale: number | null;
	/** `@presentationTimeOffset` in timescale units. */
	presentationTimeOffset: number | null;
	/** `<Event>` children. */
	events: MpdEvent[];
};

/** A `<ProducerReferenceTime>`. @group DASH @public */
export type MpdProducerReferenceTime = {
	/** `@id`. */
	id: number | null;
	/** `@inband`. */
	inband: boolean | null;
	/** `@type` (`encoder`, `captured` or `application`). */
	type: string | null;
	/** `@applicationScheme`, required when `@type` is `application`. */
	applicationScheme: string | null;
	/** `@wallClockTime`. */
	wallClockTime: string | null;
	/** `@presentationTime` in the Representation's timescale. */
	presentationTime: number | null;
	/** `<UTCTiming>` children. */
	utcTiming: DashDescriptor[];
};

/** A `<RandomAccess>`. @group DASH @public */
export type MpdRandomAccess = {
	/** `@interval`. */
	interval: number | null;
	/** `@type`. */
	type: string | null;
	/** `@minBufferTime` in seconds. */
	minBufferTime: number | null;
	/** `@bandwidth`. */
	bandwidth: number | null;
};

/** A `<Resync>`. @group DASH @public */
export type MpdResync = {
	/** `@type` SAP type. */
	type: number | null;
	/** `@dT`. */
	dT: number | null;
	/** `@dImax`. */
	dImax: number | null;
	/** `@dImin`. */
	dImin: number | null;
	/** `@marker`. */
	marker: boolean | null;
};

/** A `<Switching>`. @group DASH @public */
export type MpdSwitching = {
	/** `@interval`. */
	interval: number | null;
	/** `@type` (`media` or `bitstream`). */
	type: string | null;
};

/** A `<Label>` or `<GroupLabel>`. @group DASH @public */
export type MpdLabel = {
	/** `@id`. */
	id: number | null;
	/** `@lang`. */
	lang: string | null;
	/** Element text content. */
	value: string;
};

/** One `<PR>` inside a `<ContentPopularityRate>`. @group DASH @public */
export type MpdPopularityRate = {
	/** `@popularityRate`, 1 to 100. */
	popularityRate: number | null;
	/** `@start` in the Representation's timescale. */
	start: number | null;
	/** `@r` repeat count. */
	r: number | null;
};

/**
 * The children every `RepresentationBaseType` element carries — `<AdaptationSet>`, `<Representation>`,
 * `<SubRepresentation>`, `<Preselection>` and `<InitializationSet>` all extend it in the MPD schema.
 *
 * @group DASH @public
 */
export type MpdRepresentationBaseChildren = {
	/** `<FramePacking>` descriptors. */
	framePackings: DashDescriptor[];
	/** `<OutputProtection>` descriptors. */
	outputProtections: DashDescriptor[];
	/** `<InbandEventStream>` children. */
	inbandEventStreams: MpdEventStream[];
	/** `<ProducerReferenceTime>` children. */
	producerReferenceTimes: MpdProducerReferenceTime[];
	/** `<RandomAccess>` children. */
	randomAccess: MpdRandomAccess[];
	/** `<Resync>` children. */
	resync: MpdResync[];
	/** `<Switching>` children. */
	switching: MpdSwitching[];
	/** `<GroupLabel>` children. */
	groupLabels: MpdLabel[];
	/** `<ContentPopularityRate>` children. */
	contentPopularityRates: MpdContentPopularityRate[];
};

/** An `<InitializationGroup>` or `<InitializationPresentation>`. @group DASH @public */
export type MpdInitializationReference = {
	/** `@id`. */
	id: number | null;
	/** `@profiles`. */
	profiles: string | null;
	/** `@contentType`. */
	contentType: string | null;
	/** Text content: a whitespace-separated list of Initialization Set ids. */
	value: string;
};

/** A `<ContentPopularityRate>`. @group DASH @public */
export type MpdContentPopularityRate = {
	/** `<PR>` children. */
	rates: MpdPopularityRate[];
};

/** A `<AdaptationSet>` from a parsed MPD. @group DASH @public */
export type MpdAdaptationSet = {
	/** AdaptationSet `@id`. */
	id: string | null;
	/** AdaptationSet `@group` (used for cross-set pairing). */
	group: number | null;
	/** Resolved content type (from `@contentType` or `@mimeType` prefix). */
	contentType: 'video' | 'audio' | 'text' | 'image' | null;
	/** AdaptationSet-level `@mimeType`. */
	mimeType: string | null;
	/** AdaptationSet-level `@codecs`. */
	codecs: string | null;
	/** `@lang` ISO 639 code. */
	lang: string | null;
	/** `@maxWidth` in pixels. */
	maxWidth: number | null;
	/** `@maxHeight` in pixels. */
	maxHeight: number | null;
	/** `@width` in pixels, when every Representation shares it. */
	width: number | null;
	/** `@height` in pixels, when every Representation shares it. */
	height: number | null;
	/** `@audioSamplingRate` in Hz, when every Representation shares it. */
	audioSamplingRate: number | null;
	/** `@profiles`. */
	profiles: string | null;
	/** `@segmentProfiles`, a whitespace-separated list of 4CCs. */
	segmentProfiles: string | null;
	/** `@containerProfiles`, a whitespace-separated list of 4CCs. */
	containerProfiles: string | null;
	/** `@scanType` (`progressive`, `interlaced` or `unknown`). */
	scanType: string | null;
	/** `@codingDependency`. */
	codingDependency: boolean | null;
	/** `@maxPlayoutRate`. */
	maxPlayoutRate: number | null;
	/** `@maximumSAPPeriod` in seconds. */
	maximumSAPPeriod: number | null;
	/** `@selectionPriority`. */
	selectionPriority: number | null;
	/** `@tag`. */
	tag: string | null;
	/** `@bitstreamSwitching`. The schema default is `false`, so an omitted attribute is not the same as `null`. */
	bitstreamSwitching: boolean | null;
	/** `@maxBandwidth` in bits per second. */
	maxBandwidth: number | null;
	/** `@minBandwidth` in bits per second. */
	minBandwidth: number | null;
	/** `@maxFrameRate`, kept in its written form (`'30000/1001'` as well as `'25'`). */
	maxFrameRate: string | null;
	/** `@minFrameRate`, kept in its written form. */
	minFrameRate: string | null;
	/** `@minWidth` in pixels. */
	minWidth: number | null;
	/** `@minHeight` in pixels. */
	minHeight: number | null;
	/** `@sar` sample aspect ratio, e.g. `'1:1'`. */
	sar: string | null;
	/** `@initializationSetRef`, a comma-separated list of Initialization Set ids. */
	initializationSetRef: string | null;
	/** `@initializationPrincipal` URL. */
	initializationPrincipal: string | null;
	/** `@par` picture aspect ratio, e.g. `'16:9'`. */
	par: string | null;
	/** `@startWithSAP`. */
	startWithSAP: number | null;
	/** `@subsegmentStartsWithSAP`. */
	subsegmentStartsWithSAP: number | null;
	/** `@segmentAlignment`: `true`/`false`, or a number when alignment holds only within a group. */
	segmentAlignment: boolean | number | null;
	/** `@subsegmentAlignment`, in the same form as `segmentAlignment`. */
	subsegmentAlignment: boolean | number | null;
	/** `@frameRate` as numerator/denominator pair. */
	frameRate: DashRational | null;
	/** Children shared by every `RepresentationBaseType` element. */
	baseChildren: MpdRepresentationBaseChildren;
	/** `<Accessibility>` descriptors. */
	accessibility: DashDescriptor[];
	/** `<Rating>` descriptors. */
	ratings: DashDescriptor[];
	/** `<Viewpoint>` descriptors. */
	viewpoints: DashDescriptor[];
	/** `<ContentComponent>` children. */
	contentComponents: {
		/** `@id`. */
		id: number | null;
		/** `@lang`. */
		lang: string | null;
		/** `@contentType`. */
		contentType: string | null;
		/** `@par`. */
		par: string | null;
		/** `@tag`. */
		tag: string | null;
		/** `<Accessibility>` descriptors. */
		accessibility: DashDescriptor[];
		/** `<Role>` descriptors. */
		roles: DashDescriptor[];
		/** `<Rating>` descriptors. */
		ratings: DashDescriptor[];
		/** `<Viewpoint>` descriptors. */
		viewpoints: DashDescriptor[];
	}[];
	/** `<Role>` descriptors. */
	roles: {
		/** Role `@schemeIdUri`. */
		schemeIdUri: string;
		/** Role `@value`. */
		value: string;
	}[];
	/** `<Label>` children with optional `@lang`. */
	labels: {
		/** Label `@lang`. */
		lang: string | null;
		/** Label text content. */
		value: string;
	}[];
	/** `<AudioChannelConfiguration>` descriptors (channel count/layout signaling). */
	audioChannelConfigurations: {
		/** `@schemeIdUri` naming the channel-configuration scheme. */
		schemeIdUri: string;
		/** `@value` (decimal count, CICP index, or hex channel mask, per scheme). */
		value: string;
	}[];
	/** `<SupplementalProperty>` descriptors (advisory signaling, e.g. CICP color info). */
	supplementalProperties: DashDescriptor[];
	/** `<EssentialProperty>` descriptors (must-understand signaling, e.g. CICP transfer function). */
	essentialProperties: DashDescriptor[];
	/** `<BaseURL>` text children. */
	baseURLs: MpdBaseURL[];
	/** `<ContentProtection>` children. */
	contentProtections: ContentProtection[];
	/** AdaptationSet-level `<SegmentTemplate>` (inherited by Representations). */
	segmentTemplate: SegmentTemplate | null;
	/** AdaptationSet-level `<SegmentList>`. */
	segmentList: SegmentList | null;
	/** `<Representation>` children in document order. */
	representations: MpdRepresentation[];
};

/** A `<Representation>` from a parsed MPD. @group DASH @public */
export type MpdRepresentation = {
	/** Representation `@id` (required by spec). */
	id: string;
	/** `@bandwidth` in bits/second (required). */
	bandwidth: number;
	/** `@width` in pixels. */
	width: number | null;
	/** `@height` in pixels. */
	height: number | null;
	/** `@frameRate` as numerator/denominator pair. */
	frameRate: DashRational | null;
	/** Representation-level `@codecs` (overrides AdaptationSet). */
	codecs: string | null;
	/** Representation-level `@mimeType`. */
	mimeType: string | null;
	/** `@profiles`. */
	profiles: string | null;
	/** `@segmentProfiles`, a whitespace-separated list of 4CCs. */
	segmentProfiles: string | null;
	/** `@containerProfiles`, a whitespace-separated list of 4CCs. */
	containerProfiles: string | null;
	/** `@scanType` (`progressive`, `interlaced` or `unknown`). */
	scanType: string | null;
	/** `@codingDependency`. */
	codingDependency: boolean | null;
	/** `@maxPlayoutRate`. */
	maxPlayoutRate: number | null;
	/** `@maximumSAPPeriod` in seconds. */
	maximumSAPPeriod: number | null;
	/** `@selectionPriority`. */
	selectionPriority: number | null;
	/** `@tag`. */
	tag: string | null;
	/** `@qualityRanking`; lower is better quality among Representations in the same AdaptationSet. */
	qualityRanking: number | null;
	/** `@dependencyId`, a whitespace-separated list of Representation ids this one depends on. */
	dependencyId: string | null;
	/** `@associationId`, a whitespace-separated list of associated Representation ids. */
	associationId: string | null;
	/** `@associationType`, the 4CCs describing each `associationId` entry. */
	associationType: string | null;
	/** `@mediaStreamStructureId`, a whitespace-separated list of structure ids. */
	mediaStreamStructureId: string | null;
	/** Children shared by every `RepresentationBaseType` element. */
	baseChildren: MpdRepresentationBaseChildren;
	/** `<SubRepresentation>` children. */
	subRepresentations: {
		/** `@level`. */
		level: number | null;
		/** `@dependencyLevel`, a whitespace-separated list of levels. */
		dependencyLevel: string | null;
		/** `@bandwidth` in bits per second. */
		bandwidth: number | null;
		/** `@contentComponent`, a whitespace-separated list of component ids. */
		contentComponent: string | null;
		/** Children shared by every `RepresentationBaseType` element. */
		baseChildren: MpdRepresentationBaseChildren;
	}[];
	/** `<ExtendedBandwidth>`. */
	extendedBandwidth: {
		/** `@vbr`. */
		vbr: boolean | null;
		/** `<ModelPair>` children. */
		modelPairs: {
			/** `@bufferTime` in seconds. */
			bufferTime: number | null;
			/** `@bandwidth` in bits per second. */
			bandwidth: number | null;
		}[];
	} | null;
	/** `@sar` sample aspect ratio. */
	sar: string | null;
	/** `@audioSamplingRate` in Hz. */
	audioSamplingRate: number | null;
	/** `@startWithSAP` SAP type. */
	startWithSAP: number | null;
	/** `<Label>` children. */
	labels: {
		/** Label `@lang`. */
		lang: string | null;
		/** Label text content. */
		value: string;
	}[];
	/** `<AudioChannelConfiguration>` descriptors (channel count/layout signaling). */
	audioChannelConfigurations: {
		/** `@schemeIdUri` naming the channel-configuration scheme. */
		schemeIdUri: string;
		/** `@value` (decimal count, CICP index, or hex channel mask, per scheme). */
		value: string;
	}[];
	/** `<SupplementalProperty>` descriptors (advisory signaling, e.g. CICP color info). */
	supplementalProperties: DashDescriptor[];
	/** `<EssentialProperty>` descriptors (must-understand signaling, e.g. CICP transfer function). */
	essentialProperties: DashDescriptor[];
	/** `<BaseURL>` text children. */
	baseURLs: MpdBaseURL[];
	/** `<ContentProtection>` children. */
	contentProtections: ContentProtection[];
	/** Representation-level `<SegmentTemplate>`. */
	segmentTemplate: SegmentTemplate | null;
	/** Representation-level `<SegmentList>`. */
	segmentList: SegmentList | null;
	/** Representation-level `<SegmentBase>` (single-file mode). */
	segmentBase: SegmentBase | null;
};

/** A `<SegmentTemplate>` form of SegmentInformation. @group DASH @public */
export type SegmentTemplate = {
	/** `@media` template (supports `$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$`). */
	media: string | null;
	/** `@initialization` template. */
	initialization: string | null;
	/** `@bitstreamSwitching` template. */
	bitstreamSwitching: string | null;
	/** `@startNumber` (defaults to 1). */
	startNumber: number;
	/** `@timescale` (defaults to 1). */
	timescale: number;
	/** `@duration` in timescale units. */
	duration: number | null;
	/** `@presentationTimeOffset` in timescale units (defaults to 0). */
	presentationTimeOffset: number;
	/** `@availabilityTimeOffset` in seconds (defaults to 0). */
	availabilityTimeOffset: number;
	/**
	 * `@availabilityTimeComplete` (defaults to `true`). `false` in low-latency live output: a segment becomes
	 * available chunk by chunk, before it is complete.
	 */
	availabilityTimeComplete: boolean;
	/** `<SegmentTimeline>` `<S>` entries when present. */
	timeline: SegmentTimelineEntry[] | null;
	/** `@index` template. */
	index: string | null;
	/** `@endNumber`, the last segment number the template addresses. */
	endNumber: number | null;
	/** `@indexRange` byte range, as written (`'0-999'`). */
	indexRange: string | null;
	/** `@indexRangeExact`. */
	indexRangeExact: boolean | null;
	/** `@presentationDuration` in timescale units. */
	presentationDuration: number | null;
	/** `@timeShiftBufferDepth` in seconds. */
	timeShiftBufferDepth: number | null;
	/** `@eptDelta` in timescale units. */
	eptDelta: number | null;
	/** `@pdDelta` in timescale units. */
	pdDelta: number | null;
};

/**
 * A `<S>` entry from a `<SegmentTimeline>`. `t`/`d` are in timescale units;
 * `r` is the repeat count (0 = no repeat, negative = repeat-until-boundary).
 * @group DASH @public
 */
export type SegmentTimelineEntry = {
	/** `@t` start time in timescale units (inherits from previous when null). */
	t: number | null;
	/** `@d` duration in timescale units. */
	d: number;
	/** `@r` repeat count. */
	r: number;
};

/** A `<SegmentList>` form of SegmentInformation. @group DASH @public */
export type SegmentList = {
	/** `@timescale` (defaults to 1). */
	timescale: number;
	/** `@duration` in timescale units. */
	duration: number | null;
	/** `@startNumber` (defaults to 1). */
	startNumber: number;
	/** `@presentationTimeOffset` in timescale units (defaults to 0). */
	presentationTimeOffset: number;
	/** `<Initialization>` child. */
	initialization: {
		/** Initialization `@sourceURL`. */
		sourceURL: string | null;
		/** Initialization `@range`. */
		range: ByteRange | null;
	} | null;
	/** `<SegmentTimeline>` `<S>` entries when present. */
	timeline: SegmentTimelineEntry[] | null;
	/** `<SegmentURL>` children. */
	segments: {
		/** `@media` URI. */
		media: string;
		/** `@mediaRange`. */
		mediaRange: ByteRange | null;
		/** `@index` URI (if separate). */
		index: string | null;
		/** `@indexRange`. */
		indexRange: ByteRange | null;
	}[];
};

/** A `<SegmentBase>` form of SegmentInformation. @group DASH @public */
export type SegmentBase = {
	/** `@timescale` (defaults to 1). */
	timescale: number;
	/** `@presentationTimeOffset` in timescale units (defaults to 0). */
	presentationTimeOffset: number;
	/** `@indexRange` (sidx box location). */
	indexRange: ByteRange | null;
	/** `<Initialization>` child. */
	initialization: {
		/** Initialization `@sourceURL`. */
		sourceURL: string | null;
		/** Initialization `@range`. */
		range: ByteRange | null;
	} | null;
	/** `<RepresentationIndex>` child. */
	representationIndex: DashUrlElement | null;
	/** `<BitstreamSwitching>` child. */
	bitstreamSwitching: DashUrlElement | null;
	/** `<FailoverContent>` child. */
	failoverContent: {
		/** `@valid`. */
		valid: boolean | null;
		/** `<FCS>` children. */
		fcs: {
			/** `@t`, the start time in timescale units. */
			t: number | null;
			/** `@d`, the duration in timescale units. */
			d: number | null;
		}[];
	} | null;
};

/** Inclusive byte range parsed from a DASH `@range` attribute. @group DASH @public */
export type ByteRange = {
	/** Inclusive start byte offset. */
	start: number;
	/** Inclusive end byte offset. */
	end: number;
};

/** A `<ContentProtection>` element with normalised CENC key id and pssh boxes. @group DASH @public */
export type ContentProtection = {
	/** `@schemeIdUri` identifying the protection system. */
	schemeIdUri: string;
	/** `@value`. */
	value: string | null;
	/** Normalised CENC default key id (32 lowercase hex chars), or `null`. */
	keyId: string | null;
	/** `<cenc:pssh>` boxes (may be content-only or full wire form). */
	psshBoxes: Uint8Array[];
};

class MpdParseError extends Error {
	constructor(message: string) {
		super(`MPD parse error: ${message}`);
		this.name = 'MpdParseError';
	}
}

/**
 * Options for {@link parseMpd} / `parseManifest`.
 * @group DASH @public
 */
export type ParseMpdOptions = {
	/**
	 * A `DOMParser`-shaped constructor to use instead of the global one. Without either (Node, Bun, Deno), a built-in
	 * XML parser reads the MPD.
	 */
	domParser?: typeof DOMParser;
};

/**
 * Parse an MPD XML string into a typed AST. Throws on malformed XML or missing
 * required attributes. Uses `options.domParser`, else the global `DOMParser`, else a built-in XML parser.
 * @group DASH @public
 */
export const parseMpd = (xml: string, options?: ParseMpdOptions): Mpd => {
	const ParserCtor = options?.domParser ?? (typeof DOMParser === 'undefined' ? null : DOMParser);
	let doc: Document;
	if (ParserCtor) {
		doc = new ParserCtor().parseFromString(xml, 'application/xml');
	} else {
		try {
			doc = new MinimalDomParser().parseFromString(xml) as unknown as Document;
		} catch (error) {
			throw new MpdParseError((error as Error).message);
		}
	}

	const parseError = doc.getElementsByTagName('parsererror')[0];
	if (parseError) {
		throw new MpdParseError(parseError.textContent ?? 'invalid XML');
	}

	const root = doc.documentElement;
	if (!root || root.localName !== 'MPD') {
		throw new MpdParseError(`expected <MPD> root, found <${root?.localName ?? 'nothing'}>`);
	}

	const type = root.getAttribute('type') === 'dynamic' ? 'dynamic' : 'static';
	const profiles = (root.getAttribute('profiles') ?? '')
		.split(',')
		.map(p => p.trim())
		.filter(p => p.length > 0);

	const mpd: Mpd = {
		type,
		profiles,
		mediaPresentationDuration: parseISODuration(root.getAttribute('mediaPresentationDuration')),
		minimumUpdatePeriod: parseISODuration(root.getAttribute('minimumUpdatePeriod')),
		availabilityStartTime: parseISODateTime(root.getAttribute('availabilityStartTime')),
		publishTime: parseISODateTime(root.getAttribute('publishTime')),
		programInformations: childrenByLocalName(root, 'ProgramInformation').map(pi => ({
			lang: pi.getAttribute('lang'),
			moreInformationURL: pi.getAttribute('moreInformationURL'),
			title: childrenByLocalName(pi, 'Title')[0] ? textOf(childrenByLocalName(pi, 'Title')[0]!) : null,
			source: childrenByLocalName(pi, 'Source')[0] ? textOf(childrenByLocalName(pi, 'Source')[0]!) : null,
			copyright: childrenByLocalName(pi, 'Copyright')[0]
				? textOf(childrenByLocalName(pi, 'Copyright')[0]!)
				: null,
		})),
		contentSteering: parseContentSteering(root),
		locations: childrenByLocalName(root, 'Location').map(textOf),
		initializationSets: childrenByLocalName(root, 'InitializationSet').map(is => ({
			id: numericAttr(is, 'id'),
			inAllPeriods: boolAttr(is, 'inAllPeriods'),
			contentType: is.getAttribute('contentType'),
			par: is.getAttribute('par'),
			maxWidth: numericAttr(is, 'maxWidth'),
			maxHeight: numericAttr(is, 'maxHeight'),
			maxFrameRate: is.getAttribute('maxFrameRate'),
			initialization: is.getAttribute('initialization'),
			baseChildren: collectRepresentationBaseChildren(is),
		})),
		initializationGroups: childrenByLocalName(root, 'InitializationGroup').map(parseInitializationReference),
		initializationPresentations: childrenByLocalName(root, 'InitializationPresentation')
			.map(parseInitializationReference),
		patchLocations: childrenByLocalName(root, 'PatchLocation').map(pl => ({
			ttl: numericAttr(pl, 'ttl'),
			value: textOf(pl),
		})),
		metrics: childrenByLocalName(root, 'Metrics').map(m => ({
			metrics: m.getAttribute('metrics'),
			reporting: collectDescriptors(m, 'Reporting'),
			ranges: childrenByLocalName(m, 'Range').map(r => ({
				starttime: parseISODuration(r.getAttribute('starttime')),
				duration: parseISODuration(r.getAttribute('duration')),
			})),
		})),
		leapSecondInformation: findFirst(root, 'LeapSecondInformation', lsi => ({
			availabilityStartLeapOffset: numericAttr(lsi, 'availabilityStartLeapOffset'),
			nextAvailabilityStartLeapOffset: numericAttr(lsi, 'nextAvailabilityStartLeapOffset'),
			nextLeapChangeTime: lsi.getAttribute('nextLeapChangeTime'),
		})),
		timeShiftBufferDepth: parseISODuration(root.getAttribute('timeShiftBufferDepth')),
		suggestedPresentationDelay: parseISODuration(root.getAttribute('suggestedPresentationDelay')),
		maxSegmentDuration: parseISODuration(root.getAttribute('maxSegmentDuration')),
		minBufferTime: parseISODuration(root.getAttribute('minBufferTime')),
		baseURLs: collectBaseURLs(root),
		schemaLocation: root.getAttribute('xsi:schemaLocation'),
		serviceDescriptions: childrenByLocalName(root, 'ServiceDescription').map(parseServiceDescription),
		utcTiming: collectUTCTiming(root),
		periods: [],
	};

	for (const periodEl of childrenByLocalName(root, 'Period')) {
		mpd.periods.push(parsePeriod(periodEl));
	}

	if (mpd.periods.length === 0) {
		throw new MpdParseError('MPD has no <Period> children');
	}

	return mpd;
};

const parsePeriod = (el: Element): MpdPeriod => {
	const period: MpdPeriod = {
		id: el.getAttribute('id'),
		start: parseISODuration(el.getAttribute('start')),
		duration: parseISODuration(el.getAttribute('duration')),
		baseURLs: collectBaseURLs(el),
		serviceDescriptions: childrenByLocalName(el, 'ServiceDescription').map(parseServiceDescription),
		adaptationSets: [],
		bitstreamSwitching: boolAttr(el, 'bitstreamSwitching'),
		eventStreams: collectEventStreams(el, 'EventStream'),
		assetIdentifier: collectDescriptors(el, 'AssetIdentifier')[0] ?? null,
		subsets: childrenByLocalName(el, 'Subset').map(sub => ({
			contains: sub.getAttribute('contains'),
			id: sub.getAttribute('id'),
		})),
		groupLabels: collectLabelElements(el, 'GroupLabel'),
		preselections: childrenByLocalName(el, 'Preselection').map(ps => ({
			id: ps.getAttribute('id'),
			preselectionComponents: ps.getAttribute('preselectionComponents'),
			lang: ps.getAttribute('lang'),
			order: ps.getAttribute('order'),
			accessibility: collectDescriptors(ps, 'Accessibility'),
			roles: collectDescriptors(ps, 'Role'),
			ratings: collectDescriptors(ps, 'Rating'),
			viewpoints: collectDescriptors(ps, 'Viewpoint'),
			baseChildren: collectRepresentationBaseChildren(ps),
		})),
		emptyAdaptationSets: childrenByLocalName(el, 'EmptyAdaptationSet').map(parseAdaptationSet),
	};

	for (const asEl of childrenByLocalName(el, 'AdaptationSet')) {
		period.adaptationSets.push(parseAdaptationSet(asEl));
	}

	return period;
};

const parseAdaptationSet = (el: Element): MpdAdaptationSet => {
	const mimeType = el.getAttribute('mimeType');
	const contentTypeAttr = el.getAttribute('contentType');
	const contentType = resolveContentType(contentTypeAttr, mimeType);

	const as: MpdAdaptationSet = {
		id: el.getAttribute('id'),
		group: numericAttr(el, 'group'),
		contentType,
		mimeType,
		codecs: el.getAttribute('codecs'),
		lang: el.getAttribute('lang'),
		maxWidth: numericAttr(el, 'maxWidth'),
		maxHeight: numericAttr(el, 'maxHeight'),
		width: numericAttr(el, 'width'),
		height: numericAttr(el, 'height'),
		audioSamplingRate: numericAttr(el, 'audioSamplingRate'),
		par: el.getAttribute('par'),
		sar: el.getAttribute('sar'),
		bitstreamSwitching: boolAttr(el, 'bitstreamSwitching'),
		maxBandwidth: numericAttr(el, 'maxBandwidth'),
		minBandwidth: numericAttr(el, 'minBandwidth'),
		maxFrameRate: el.getAttribute('maxFrameRate'),
		minFrameRate: el.getAttribute('minFrameRate'),
		minWidth: numericAttr(el, 'minWidth'),
		minHeight: numericAttr(el, 'minHeight'),
		initializationSetRef: el.getAttribute('initializationSetRef'),
		initializationPrincipal: el.getAttribute('initializationPrincipal'),
		profiles: el.getAttribute('profiles'),
		segmentProfiles: el.getAttribute('segmentProfiles'),
		containerProfiles: el.getAttribute('containerProfiles'),
		scanType: el.getAttribute('scanType'),
		codingDependency: boolAttr(el, 'codingDependency'),
		maxPlayoutRate: numericAttr(el, 'maxPlayoutRate'),
		maximumSAPPeriod: numericAttr(el, 'maximumSAPPeriod'),
		selectionPriority: numericAttr(el, 'selectionPriority'),
		tag: el.getAttribute('tag'),
		startWithSAP: numericAttr(el, 'startWithSAP'),
		subsegmentStartsWithSAP: numericAttr(el, 'subsegmentStartsWithSAP'),
		segmentAlignment: conditionalUintAttr(el, 'segmentAlignment'),
		subsegmentAlignment: conditionalUintAttr(el, 'subsegmentAlignment'),
		frameRate: parseFrameRate(el.getAttribute('frameRate')),
		roles: collectRoles(el),
		baseChildren: collectRepresentationBaseChildren(el),
		accessibility: collectDescriptors(el, 'Accessibility'),
		ratings: collectDescriptors(el, 'Rating'),
		viewpoints: collectDescriptors(el, 'Viewpoint'),
		contentComponents: childrenByLocalName(el, 'ContentComponent').map(cc => ({
			id: numericAttr(cc, 'id'),
			lang: cc.getAttribute('lang'),
			contentType: cc.getAttribute('contentType'),
			par: cc.getAttribute('par'),
			tag: cc.getAttribute('tag'),
			accessibility: collectDescriptors(cc, 'Accessibility'),
			roles: collectDescriptors(cc, 'Role'),
			ratings: collectDescriptors(cc, 'Rating'),
			viewpoints: collectDescriptors(cc, 'Viewpoint'),
		})),
		labels: collectLabels(el),
		audioChannelConfigurations: collectAudioChannelConfigurations(el),
		supplementalProperties: collectProperties(el, 'SupplementalProperty'),
		essentialProperties: collectProperties(el, 'EssentialProperty'),
		baseURLs: collectBaseURLs(el),
		contentProtections: collectContentProtections(el),
		segmentTemplate: findFirst(el, 'SegmentTemplate', parseSegmentTemplate),
		segmentList: findFirst(el, 'SegmentList', parseSegmentList),
		representations: [],
	};

	for (const repEl of childrenByLocalName(el, 'Representation')) {
		as.representations.push(parseRepresentation(repEl));
	}

	return as;
};

const parseRepresentation = (el: Element): MpdRepresentation => {
	const id = el.getAttribute('id');
	if (!id) {
		throw new MpdParseError('<Representation> missing required @id');
	}
	const bandwidth = numericAttr(el, 'bandwidth');
	if (bandwidth === null) {
		throw new MpdParseError(`<Representation id="${id}"> missing required @bandwidth`);
	}

	return {
		id,
		bandwidth,
		width: numericAttr(el, 'width'),
		height: numericAttr(el, 'height'),
		frameRate: parseFrameRate(el.getAttribute('frameRate')),
		codecs: el.getAttribute('codecs'),
		mimeType: el.getAttribute('mimeType'),
		sar: el.getAttribute('sar'),
		qualityRanking: numericAttr(el, 'qualityRanking'),
		dependencyId: el.getAttribute('dependencyId'),
		associationId: el.getAttribute('associationId'),
		associationType: el.getAttribute('associationType'),
		mediaStreamStructureId: el.getAttribute('mediaStreamStructureId'),
		baseChildren: collectRepresentationBaseChildren(el),
		subRepresentations: childrenByLocalName(el, 'SubRepresentation').map(sr => ({
			level: numericAttr(sr, 'level'),
			dependencyLevel: sr.getAttribute('dependencyLevel'),
			bandwidth: numericAttr(sr, 'bandwidth'),
			contentComponent: sr.getAttribute('contentComponent'),
			baseChildren: collectRepresentationBaseChildren(sr),
		})),
		extendedBandwidth: findFirst(el, 'ExtendedBandwidth', eb => ({
			vbr: boolAttr(eb, 'vbr'),
			modelPairs: childrenByLocalName(eb, 'ModelPair').map(mp => ({
				bufferTime: parseISODuration(mp.getAttribute('bufferTime')),
				bandwidth: numericAttr(mp, 'bandwidth'),
			})),
		})),
		profiles: el.getAttribute('profiles'),
		segmentProfiles: el.getAttribute('segmentProfiles'),
		containerProfiles: el.getAttribute('containerProfiles'),
		scanType: el.getAttribute('scanType'),
		codingDependency: boolAttr(el, 'codingDependency'),
		maxPlayoutRate: numericAttr(el, 'maxPlayoutRate'),
		maximumSAPPeriod: numericAttr(el, 'maximumSAPPeriod'),
		selectionPriority: numericAttr(el, 'selectionPriority'),
		tag: el.getAttribute('tag'),
		audioSamplingRate: numericAttr(el, 'audioSamplingRate'),
		startWithSAP: numericAttr(el, 'startWithSAP'),
		labels: collectLabels(el),
		audioChannelConfigurations: collectAudioChannelConfigurations(el),
		supplementalProperties: collectProperties(el, 'SupplementalProperty'),
		essentialProperties: collectProperties(el, 'EssentialProperty'),
		baseURLs: collectBaseURLs(el),
		contentProtections: collectContentProtections(el),
		segmentTemplate: findFirst(el, 'SegmentTemplate', parseSegmentTemplate),
		segmentList: findFirst(el, 'SegmentList', parseSegmentList),
		segmentBase: findFirst(el, 'SegmentBase', parseSegmentBase),
	};
};

const parseSegmentTemplate = (el: Element): SegmentTemplate => {
	return {
		media: el.getAttribute('media'),
		initialization: el.getAttribute('initialization'),
		bitstreamSwitching: el.getAttribute('bitstreamSwitching'),
		startNumber: numericAttr(el, 'startNumber') ?? 1,
		timescale: numericAttr(el, 'timescale') ?? 1,
		duration: numericAttr(el, 'duration'),
		presentationTimeOffset: numericAttr(el, 'presentationTimeOffset') ?? 0,
		availabilityTimeOffset: numericAttr(el, 'availabilityTimeOffset') ?? 0,
		availabilityTimeComplete: el.getAttribute('availabilityTimeComplete') !== 'false',
		timeline: parseSegmentTimeline(el),
		index: el.getAttribute('index'),
		endNumber: numericAttr(el, 'endNumber'),
		indexRange: el.getAttribute('indexRange'),
		indexRangeExact: boolAttr(el, 'indexRangeExact'),
		presentationDuration: numericAttr(el, 'presentationDuration'),
		timeShiftBufferDepth: parseISODuration(el.getAttribute('timeShiftBufferDepth')),
		eptDelta: numericAttr(el, 'eptDelta'),
		pdDelta: numericAttr(el, 'pdDelta'),
	};
};

const parseSegmentList = (el: Element): SegmentList => {
	const list: SegmentList = {
		timescale: numericAttr(el, 'timescale') ?? 1,
		duration: numericAttr(el, 'duration'),
		startNumber: numericAttr(el, 'startNumber') ?? 1,
		presentationTimeOffset: numericAttr(el, 'presentationTimeOffset') ?? 0,
		initialization: findFirst(el, 'Initialization', parseInitialization),
		timeline: parseSegmentTimeline(el),
		segments: [],
	};

	for (const segEl of childrenByLocalName(el, 'SegmentURL')) {
		list.segments.push({
			media: segEl.getAttribute('media') ?? '',
			mediaRange: parseByteRange(segEl.getAttribute('mediaRange')),
			index: segEl.getAttribute('index'),
			indexRange: parseByteRange(segEl.getAttribute('indexRange')),
		});
	}

	return list;
};

const parseInitializationReference = (el: Element): MpdInitializationReference => ({
	id: numericAttr(el, 'id'),
	profiles: el.getAttribute('profiles'),
	contentType: el.getAttribute('contentType'),
	value: textOf(el),
});

const parseUrlElement = (el: Element): DashUrlElement => ({
	sourceURL: el.getAttribute('sourceURL'),
	range: el.getAttribute('range'),
});

const parseSegmentBase = (el: Element): SegmentBase => {
	return {
		timescale: numericAttr(el, 'timescale') ?? 1,
		presentationTimeOffset: numericAttr(el, 'presentationTimeOffset') ?? 0,
		indexRange: parseByteRange(el.getAttribute('indexRange')),
		initialization: findFirst(el, 'Initialization', parseInitialization),
		representationIndex: findFirst(el, 'RepresentationIndex', parseUrlElement),
		bitstreamSwitching: findFirst(el, 'BitstreamSwitching', parseUrlElement),
		failoverContent: findFirst(el, 'FailoverContent', fc => ({
			valid: boolAttr(fc, 'valid'),
			fcs: childrenByLocalName(fc, 'FCS').map(f => ({
				t: numericAttr(f, 't'),
				d: numericAttr(f, 'd'),
			})),
		})),
	};
};

const parseInitialization = (el: Element): { sourceURL: string | null; range: ByteRange | null } => {
	return {
		sourceURL: el.getAttribute('sourceURL'),
		range: parseByteRange(el.getAttribute('range')),
	};
};

const parseSegmentTimeline = (parent: Element): SegmentTimelineEntry[] | null => {
	const timelineEl = childrenByLocalName(parent, 'SegmentTimeline')[0];
	if (!timelineEl) {
		return null;
	}
	const entries: SegmentTimelineEntry[] = [];
	for (const s of childrenByLocalName(timelineEl, 'S')) {
		const d = numericAttr(s, 'd');
		if (d === null) {
			throw new MpdParseError('<S> in <SegmentTimeline> missing required @d');
		}
		entries.push({
			t: numericAttr(s, 't'),
			d,
			r: numericAttr(s, 'r') ?? 0,
		});
	}
	return entries;
};

const parseContentSteering = (root: Element): MpdContentSteering | null => {
	const el = childrenByLocalName(root, 'ContentSteering')[0];
	if (el === undefined) {
		return null;
	}

	return {
		value: textOf(el),
		defaultServiceLocation: el.getAttribute('defaultServiceLocation'),
		queryBeforeStart: boolAttr(el, 'queryBeforeStart'),
		proxyServerURL: el.getAttribute('proxyServerURL'),
		clientRequirement: boolAttr(el, 'clientRequirement'),
	};
};

const collectBaseURLs = (parent: Element): MpdBaseURL[] => {
	const result: MpdBaseURL[] = [];
	for (const el of childrenByLocalName(parent, 'BaseURL')) {
		const text = el.textContent?.trim();
		if (text) {
			result.push({ value: text, serviceLocation: el.getAttribute('serviceLocation') });
		}
	}
	return result;
};

const collectUTCTiming = (parent: Element): { schemeIdUri: string; value: string }[] => {
	const result: { schemeIdUri: string; value: string }[] = [];
	for (const el of childrenByLocalName(parent, 'UTCTiming')) {
		const schemeIdUri = el.getAttribute('schemeIdUri');
		const value = el.getAttribute('value');
		if (schemeIdUri && value !== null) {
			result.push({ schemeIdUri, value });
		}
	}
	return result;
};

const collectRoles = (parent: Element): { schemeIdUri: string; value: string }[] => {
	const result: { schemeIdUri: string; value: string }[] = [];
	for (const el of childrenByLocalName(parent, 'Role')) {
		const schemeIdUri = el.getAttribute('schemeIdUri');
		const value = el.getAttribute('value');
		if (schemeIdUri && value !== null) {
			result.push({ schemeIdUri, value });
		}
	}
	return result;
};

const collectAudioChannelConfigurations = (parent: Element): { schemeIdUri: string; value: string }[] => {
	const result: { schemeIdUri: string; value: string }[] = [];
	for (const el of childrenByLocalName(parent, 'AudioChannelConfiguration')) {
		const schemeIdUri = el.getAttribute('schemeIdUri');
		const value = el.getAttribute('value');
		if (schemeIdUri && value !== null) {
			result.push({ schemeIdUri, value });
		}
	}
	return result;
};

const collectProperties = (parent: Element, localName: string): DashDescriptor[] => {
	const result: DashDescriptor[] = [];
	for (const el of childrenByLocalName(parent, localName)) {
		const schemeIdUri = el.getAttribute('schemeIdUri');
		if (schemeIdUri) {
			result.push({ schemeIdUri, value: el.getAttribute('value'), id: el.getAttribute('id') });
		}
	}
	return result;
};

const textOf = (el: Element) => (el.textContent ?? '').trim();

const escapeXmlText = (text: string) => text
	.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeXmlAttribute = (text: string) => escapeXmlText(text).replaceAll('"', '&quot;');

// Renders a foreign-namespace subtree back to text. The built-in parser already serializes itself; a real DOM
// (global or xmldom) does not, and exposes no outerHTML here, so that case walks childNodes.
const serializeForeignElement = (el: Element): string => {
	const builtIn = el as unknown as { toXml?: () => string };
	if (typeof builtIn.toXml === 'function') {
		return builtIn.toXml();
	}

	let out = `<${el.nodeName}`;
	for (let i = 0; i < el.attributes.length; i++) {
		const attr = el.attributes[i]!;
		out += ` ${attr.name}="${escapeXmlAttribute(attr.value)}"`;
	}

	const parts: string[] = [];
	for (let i = 0; i < el.childNodes.length; i++) {
		const node = el.childNodes[i]!;
		if (node.nodeType === 1) {
			parts.push(serializeForeignElement(node as Element));
		} else if (node.nodeType === 3 || node.nodeType === 4) {
			const text = (node.nodeValue ?? '').trim();
			if (text) {
				parts.push(escapeXmlText(text));
			}
		}
	}

	if (parts.length === 0) {
		return `${out}/>`;
	}

	return `${out}>${parts.join('')}</${el.nodeName}>`;
};

// `<Event>` content is `xs:any namespace="##other"`, so anything inside it is kept verbatim.
const foreignChildrenOf = (el: Element): string[] => {
	const out: string[] = [];
	for (let i = 0; i < el.children.length; i++) {
		out.push(serializeForeignElement(el.children[i]!));
	}
	return out;
};

const collectDescriptors = (parent: Element, localName: string) => collectProperties(parent, localName);

const collectEventStreams = (parent: Element, localName: string): MpdEventStream[] =>
	childrenByLocalName(parent, localName).map(el => ({
		schemeIdUri: el.getAttribute('schemeIdUri') ?? '',
		value: el.getAttribute('value'),
		timescale: numericAttr(el, 'timescale'),
		presentationTimeOffset: numericAttr(el, 'presentationTimeOffset'),
		events: childrenByLocalName(el, 'Event').map(ev => ({
			presentationTime: numericAttr(ev, 'presentationTime'),
			duration: numericAttr(ev, 'duration'),
			id: numericAttr(ev, 'id'),
			contentEncoding: ev.getAttribute('contentEncoding'),
			messageData: ev.getAttribute('messageData'),
			value: foreignChildrenOf(ev).length > 0 ? null : textOf(ev) || null,
			foreignXml: foreignChildrenOf(ev),
		})),
	}));

const collectLabelElements = (parent: Element, localName: string): MpdLabel[] =>
	childrenByLocalName(parent, localName).map(el => ({
		id: numericAttr(el, 'id'),
		lang: el.getAttribute('lang'),
		value: textOf(el),
	}));

/**
 * The empty set of `RepresentationBaseType` children, for building an element that carries none.
 * @group DASH @public
 */
export const emptyRepresentationBaseChildren = (): MpdRepresentationBaseChildren => ({
	framePackings: [],
	outputProtections: [],
	inbandEventStreams: [],
	producerReferenceTimes: [],
	randomAccess: [],
	resync: [],
	switching: [],
	groupLabels: [],
	contentPopularityRates: [],
});

const collectRepresentationBaseChildren = (el: Element): MpdRepresentationBaseChildren => ({
	framePackings: collectDescriptors(el, 'FramePacking'),
	outputProtections: collectDescriptors(el, 'OutputProtection'),
	inbandEventStreams: collectEventStreams(el, 'InbandEventStream'),
	producerReferenceTimes: childrenByLocalName(el, 'ProducerReferenceTime').map(prt => ({
		id: numericAttr(prt, 'id'),
		inband: boolAttr(prt, 'inband'),
		type: prt.getAttribute('type'),
		applicationScheme: prt.getAttribute('applicationScheme'),
		wallClockTime: prt.getAttribute('wallClockTime'),
		presentationTime: numericAttr(prt, 'presentationTime'),
		utcTiming: collectDescriptors(prt, 'UTCTiming'),
	})),
	randomAccess: childrenByLocalName(el, 'RandomAccess').map(ra => ({
		interval: numericAttr(ra, 'interval'),
		type: ra.getAttribute('type'),
		minBufferTime: parseISODuration(ra.getAttribute('minBufferTime')),
		bandwidth: numericAttr(ra, 'bandwidth'),
	})),
	resync: childrenByLocalName(el, 'Resync').map(r => ({
		type: numericAttr(r, 'type'),
		dT: numericAttr(r, 'dT'),
		dImax: numericAttr(r, 'dImax'),
		dImin: numericAttr(r, 'dImin'),
		marker: boolAttr(r, 'marker'),
	})),
	switching: childrenByLocalName(el, 'Switching').map(sw => ({
		interval: numericAttr(sw, 'interval'),
		type: sw.getAttribute('type'),
	})),
	groupLabels: collectLabelElements(el, 'GroupLabel'),
	contentPopularityRates: childrenByLocalName(el, 'ContentPopularityRate').map(cpr => ({
		rates: childrenByLocalName(cpr, 'PR').map(pr => ({
			popularityRate: numericAttr(pr, 'popularityRate'),
			start: numericAttr(pr, 'start'),
			r: numericAttr(pr, 'r'),
		})),
	})),
});

const collectLabels = (parent: Element): { lang: string | null; value: string }[] => {
	const result: { lang: string | null; value: string }[] = [];
	for (const el of childrenByLocalName(parent, 'Label')) {
		const text = el.textContent?.trim();
		if (!text) {
			continue;
		}
		result.push({ lang: el.getAttribute('lang'), value: text });
	}
	return result;
};

const collectContentProtections = (parent: Element): ContentProtection[] => {
	const result: ContentProtection[] = [];
	for (const el of childrenByLocalName(parent, 'ContentProtection')) {
		const schemeIdUri = el.getAttribute('schemeIdUri');
		if (!schemeIdUri) {
			continue;
		}
		const psshBoxes: Uint8Array[] = [];
		for (const psshEl of childrenByLocalName(el, 'pssh')) {
			const text = psshEl.textContent?.trim();
			if (text) {
				const bytes = decodeBase64(text);
				if (bytes) {
					psshBoxes.push(bytes);
				}
			}
		}
		result.push({
			schemeIdUri,
			value: el.getAttribute('value'),
			keyId: normaliseKeyId(el.getAttributeNS(DASH_NS.cenc, 'default_KID') || el.getAttribute('default_KID')),
			psshBoxes,
		});
	}
	return result;
};

const resolveContentType = (
	explicit: string | null,
	mimeType: string | null,
): MpdAdaptationSet['contentType'] => {
	if (explicit === 'video' || explicit === 'audio' || explicit === 'text' || explicit === 'image') {
		return explicit;
	}
	if (!mimeType) {
		return null;
	}
	if (mimeType.startsWith('video/')) {
		return 'video';
	}
	if (mimeType.startsWith('audio/')) {
		return 'audio';
	}
	if (mimeType.startsWith('application/mp4') || mimeType.startsWith('text/')) {
		return 'text';
	}
	if (mimeType.startsWith('image/')) {
		return 'image';
	}
	return null;
};

const childrenByLocalName = (parent: Element, localName: string): Element[] => {
	const out: Element[] = [];
	for (let i = 0; i < parent.children.length; i++) {
		const child = parent.children[i]!;
		if (child.localName === localName) {
			out.push(child);
		}
	}
	return out;
};

const findFirst = <T>(parent: Element, localName: string, fn: (el: Element) => T): T | null => {
	const first = childrenByLocalName(parent, localName)[0];
	return first ? fn(first) : null;
};

const parseServiceDescription = (el: Element): MpdServiceDescription => ({
	id: numericAttr(el, 'id'),
	latency: findFirst(el, 'Latency', latency => ({
		referenceId: numericAttr(latency, 'referenceId'),
		target: numericAttr(latency, 'target'),
		min: numericAttr(latency, 'min'),
		max: numericAttr(latency, 'max'),
		qualityLatency: childrenByLocalName(latency, 'QualityLatency').map(ql => ({
			type: ql.getAttribute('type'),
			value: textOf(ql),
		})),
	})),
	playbackRate: findFirst(el, 'PlaybackRate', rate => ({
		min: numericAttr(rate, 'min'),
		max: numericAttr(rate, 'max'),
	})),
	scopes: collectDescriptors(el, 'Scope'),
	operatingQuality: childrenByLocalName(el, 'OperatingQuality').map(oq => ({
		type: oq.getAttribute('type'),
		min: numericAttr(oq, 'min'),
		max: numericAttr(oq, 'max'),
		target: numericAttr(oq, 'target'),
		maxDifference: numericAttr(oq, 'maxDifference'),
	})),
	operatingBandwidth: childrenByLocalName(el, 'OperatingBandwidth').map(ob => ({
		min: numericAttr(ob, 'min'),
		max: numericAttr(ob, 'max'),
		target: numericAttr(ob, 'target'),
	})),
});

// ConditionalUintType: a boolean, or an unsigned integer naming the group within which the property holds
const conditionalUintAttr = (el: Element, name: string): boolean | number | null => {
	const value = el.getAttribute(name);
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	return numericAttr(el, name);
};

// The schema gives most of these a default, so an absent attribute and an explicit value are not interchangeable:
// a dropped `bitstreamSwitching="true"` reads back as the default `false`, inverting it.
const boolAttr = (el: Element, name: string): boolean | null => {
	const raw = el.getAttribute(name);
	if (raw === null) {
		return null;
	}

	return raw === 'true' || raw === '1';
};

const numericAttr = (el: Element, name: string): number | null => {
	const v = el.getAttribute(name);
	if (v === null || v === '') {
		return null;
	}
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

const decodeBase64 = (text: string): Uint8Array | null => {
	try {
		return base64ToBytes(text);
	} catch {
		return null;
	}
};
