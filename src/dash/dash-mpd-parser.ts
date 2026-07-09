/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

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
	baseURLs: string[];
	/** `<UTCTiming>` descriptors. */
	utcTiming: {
		/** UTCTiming `@schemeIdUri`. */
		schemeIdUri: string;
		/** UTCTiming `@value`. */
		value: string;
	}[];
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
	baseURLs: string[];
	/** `<AdaptationSet>` children in document order. */
	adaptationSets: MpdAdaptationSet[];
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
	/** `@frameRate` as numerator/denominator pair. */
	frameRate: DashRational | null;
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
	baseURLs: string[];
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
	baseURLs: string[];
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
	/** `<SegmentTimeline>` `<S>` entries when present. */
	timeline: SegmentTimelineEntry[] | null;
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
	 * A `DOMParser`-shaped constructor to use instead of the global one — supply linkedom's on
	 * Node/Bun/Deno where there is no global `DOMParser`.
	 */
	domParser?: typeof DOMParser;
};

/**
 * Parse an MPD XML string into a typed AST. Throws on malformed XML or missing
 * required attributes. Needs a `DOMParser` — the global one, or `options.domParser`.
 * @group DASH @public
 */
export const parseMpd = (xml: string, options?: ParseMpdOptions): Mpd => {
	const ParserCtor = options?.domParser ?? (typeof DOMParser === 'undefined' ? null : DOMParser);
	if (ParserCtor === null) {
		throw new MpdParseError('DOMParser is not available in this environment; pass options.domParser');
	}

	const doc = new ParserCtor().parseFromString(xml, 'application/xml');
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
		timeShiftBufferDepth: parseISODuration(root.getAttribute('timeShiftBufferDepth')),
		suggestedPresentationDelay: parseISODuration(root.getAttribute('suggestedPresentationDelay')),
		maxSegmentDuration: parseISODuration(root.getAttribute('maxSegmentDuration')),
		minBufferTime: parseISODuration(root.getAttribute('minBufferTime')),
		baseURLs: collectBaseURLs(root),
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
		adaptationSets: [],
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
		frameRate: parseFrameRate(el.getAttribute('frameRate')),
		roles: collectRoles(el),
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
		timeline: parseSegmentTimeline(el),
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

const parseSegmentBase = (el: Element): SegmentBase => {
	return {
		timescale: numericAttr(el, 'timescale') ?? 1,
		presentationTimeOffset: numericAttr(el, 'presentationTimeOffset') ?? 0,
		indexRange: parseByteRange(el.getAttribute('indexRange')),
		initialization: findFirst(el, 'Initialization', parseInitialization),
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

const collectBaseURLs = (parent: Element): string[] => {
	const result: string[] = [];
	for (const el of childrenByLocalName(parent, 'BaseURL')) {
		const text = el.textContent?.trim();
		if (text) {
			result.push(text);
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

const collectProperties = (parent: Element, localName: string): { schemeIdUri: string; value: string | null }[] => {
	const result: { schemeIdUri: string; value: string | null }[] = [];
	for (const el of childrenByLocalName(parent, localName)) {
		const schemeIdUri = el.getAttribute('schemeIdUri');
		if (schemeIdUri) {
			result.push({ schemeIdUri, value: el.getAttribute('value') });
		}
	}
	return result;
};

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
				const bytes = base64ToBytes(text);
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

const numericAttr = (el: Element, name: string): number | null => {
	const v = el.getAttribute(name);
	if (v === null || v === '') {
		return null;
	}
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

const base64ToBytes = (b64: string): Uint8Array | null => {
	try {
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
};
