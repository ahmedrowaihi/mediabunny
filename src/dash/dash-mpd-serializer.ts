/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { hexStringToBytes } from '../misc';
import { DASH_NS } from './dash-misc';
import type { DashRational } from './dash-misc';
import { generateCencPsshElement, hexToUUID, secondsToXmlDuration } from './dash-mpd-utils';
import type {
	ByteRange,
	ContentProtection,
	Mpd,
	MpdAdaptationSet,
	MpdPeriod,
	MpdRepresentation,
	SegmentBase,
	SegmentList,
	SegmentTemplate,
	SegmentTimelineEntry,
} from './dash-mpd-parser';
import { descriptorNode, XmlNode } from './dash-xml-node';

/** XML namespace URI for each prefix the serializer may emit (drives `xmlns:*` injection). */
const NAMESPACE_URI_BY_PREFIX: Record<string, string> = {
	cenc: DASH_NS.cenc,
	mspr: DASH_NS.mspr,
};

type Initialization = { sourceURL: string | null; range: ByteRange | null };

const byteRangeToString = (range: ByteRange): string => `${range.start}-${range.end}`;

const formatRational = (rational: DashRational): string =>
	rational.denominator === 1 ? String(rational.numerator) : `${rational.numerator}/${rational.denominator}`;

/** CENC key id is stored as 32 lowercase hex chars; `cenc:default_KID` wants the dashed UUID form. */
const keyIdToUuid = (keyIdHex: string): string => hexToUUID(hexStringToBytes(keyIdHex)) ?? keyIdHex;

const setDuration = (node: XmlNode, name: string, seconds: number | null): void => {
	if (seconds !== null) {
		node.setStringAttribute(name, secondsToXmlDuration(seconds));
	}
};

const setDateTime = (node: XmlNode, name: string, unixMs: number | null): void => {
	if (unixMs !== null) {
		node.setStringAttribute(name, new Date(unixMs).toISOString());
	}
};

const baseUrlNode = (url: string): XmlNode => {
	const node = new XmlNode('BaseURL');
	// The parser stores the raw URI reference; emit it verbatim (XML-escaped only).
	// setPathContent would percent-encode it and corrupt query strings / already-encoded paths.
	node.setContent(url);
	return node;
};

const labelNode = (label: { lang: string | null; value: string }): XmlNode => {
	const node = new XmlNode('Label');
	if (label.lang !== null) {
		node.setStringAttribute('lang', label.lang);
	}
	node.setContent(label.value);
	return node;
};

const initializationNode = (init: Initialization): XmlNode => {
	const node = new XmlNode('Initialization');
	if (init.sourceURL !== null) {
		node.setStringAttribute('sourceURL', init.sourceURL);
	}
	if (init.range !== null) {
		node.setStringAttribute('range', byteRangeToString(init.range));
	}
	return node;
};

const segmentTimelineNode = (entries: SegmentTimelineEntry[]): XmlNode => {
	const timeline = new XmlNode('SegmentTimeline');
	for (const entry of entries) {
		const s = new XmlNode('S');
		if (entry.t !== null) {
			s.setIntegerAttribute('t', entry.t);
		}
		s.setIntegerAttribute('d', entry.d);
		if (entry.r !== 0) {
			s.setIntegerAttribute('r', entry.r);
		}
		timeline.addChild(s);
	}
	return timeline;
};

const contentProtectionNode = (cp: ContentProtection): XmlNode => {
	const node = new XmlNode('ContentProtection');
	node.setStringAttribute('schemeIdUri', cp.schemeIdUri);
	if (cp.value !== null) {
		node.setStringAttribute('value', cp.value);
	}
	if (cp.keyId !== null) {
		node.setStringAttribute('cenc:default_KID', keyIdToUuid(cp.keyId));
	}
	node.addElements(cp.psshBoxes.map(generateCencPsshElement));
	return node;
};

const segmentTemplateNode = (template: SegmentTemplate): XmlNode => {
	const node = new XmlNode('SegmentTemplate');
	if (template.media !== null) {
		node.setStringAttribute('media', template.media);
	}
	if (template.initialization !== null) {
		node.setStringAttribute('initialization', template.initialization);
	}
	if (template.bitstreamSwitching !== null) {
		node.setStringAttribute('bitstreamSwitching', template.bitstreamSwitching);
	}
	if (template.timescale !== 1) {
		node.setIntegerAttribute('timescale', template.timescale);
	}
	if (template.duration !== null) {
		node.setIntegerAttribute('duration', template.duration);
	}
	if (template.startNumber !== 1) {
		node.setIntegerAttribute('startNumber', template.startNumber);
	}
	if (template.presentationTimeOffset !== 0) {
		node.setIntegerAttribute('presentationTimeOffset', template.presentationTimeOffset);
	}
	if (template.availabilityTimeOffset !== 0) {
		node.setFloatingPointAttribute('availabilityTimeOffset', template.availabilityTimeOffset);
	}
	if (template.timeline !== null) {
		node.addChild(segmentTimelineNode(template.timeline));
	}
	return node;
};

const segmentListNode = (list: SegmentList): XmlNode => {
	const node = new XmlNode('SegmentList');
	if (list.timescale !== 1) {
		node.setIntegerAttribute('timescale', list.timescale);
	}
	if (list.duration !== null) {
		node.setIntegerAttribute('duration', list.duration);
	}
	if (list.startNumber !== 1) {
		node.setIntegerAttribute('startNumber', list.startNumber);
	}
	if (list.presentationTimeOffset !== 0) {
		node.setIntegerAttribute('presentationTimeOffset', list.presentationTimeOffset);
	}
	if (list.initialization !== null) {
		node.addChild(initializationNode(list.initialization));
	}
	if (list.timeline !== null) {
		node.addChild(segmentTimelineNode(list.timeline));
	}
	for (const segment of list.segments) {
		const segmentUrl = new XmlNode('SegmentURL');
		segmentUrl.setStringAttribute('media', segment.media);
		if (segment.mediaRange !== null) {
			segmentUrl.setStringAttribute('mediaRange', byteRangeToString(segment.mediaRange));
		}
		if (segment.index !== null) {
			segmentUrl.setStringAttribute('index', segment.index);
		}
		if (segment.indexRange !== null) {
			segmentUrl.setStringAttribute('indexRange', byteRangeToString(segment.indexRange));
		}
		node.addChild(segmentUrl);
	}
	return node;
};

const segmentBaseNode = (base: SegmentBase): XmlNode => {
	const node = new XmlNode('SegmentBase');
	if (base.timescale !== 1) {
		node.setIntegerAttribute('timescale', base.timescale);
	}
	if (base.presentationTimeOffset !== 0) {
		node.setIntegerAttribute('presentationTimeOffset', base.presentationTimeOffset);
	}
	if (base.indexRange !== null) {
		node.setStringAttribute('indexRange', byteRangeToString(base.indexRange));
	}
	if (base.initialization !== null) {
		node.addChild(initializationNode(base.initialization));
	}
	return node;
};

/** Emit the child elements shared by `<Representation>` and `<AdaptationSet>`, in schema order. */
const appendCommonChildren = (
	node: XmlNode,
	source: Pick<
		MpdAdaptationSet,
		'labels' | 'audioChannelConfigurations' | 'supplementalProperties' | 'essentialProperties'
		| 'baseURLs' | 'contentProtections' | 'segmentTemplate' | 'segmentList'
	>,
): void => {
	for (const label of source.labels) {
		node.addChild(labelNode(label));
	}
	for (const config of source.audioChannelConfigurations) {
		node.addChild(descriptorNode('AudioChannelConfiguration', config.schemeIdUri, config.value));
	}
	for (const property of source.supplementalProperties) {
		node.addChild(descriptorNode('SupplementalProperty', property.schemeIdUri, property.value));
	}
	for (const property of source.essentialProperties) {
		node.addChild(descriptorNode('EssentialProperty', property.schemeIdUri, property.value));
	}
	for (const url of source.baseURLs) {
		node.addChild(baseUrlNode(url));
	}
	for (const cp of source.contentProtections) {
		node.addChild(contentProtectionNode(cp));
	}
	if (source.segmentTemplate !== null) {
		node.addChild(segmentTemplateNode(source.segmentTemplate));
	}
	if (source.segmentList !== null) {
		node.addChild(segmentListNode(source.segmentList));
	}
};

const representationNode = (representation: MpdRepresentation): XmlNode => {
	const node = new XmlNode('Representation');
	node.setStringAttribute('id', representation.id);
	node.setIntegerAttribute('bandwidth', representation.bandwidth);
	if (representation.width !== null) {
		node.setIntegerAttribute('width', representation.width);
	}
	if (representation.height !== null) {
		node.setIntegerAttribute('height', representation.height);
	}
	if (representation.frameRate !== null) {
		node.setStringAttribute('frameRate', formatRational(representation.frameRate));
	}
	if (representation.codecs !== null) {
		node.setStringAttribute('codecs', representation.codecs);
	}
	if (representation.mimeType !== null) {
		node.setStringAttribute('mimeType', representation.mimeType);
	}
	if (representation.sar !== null) {
		node.setStringAttribute('sar', representation.sar);
	}
	if (representation.audioSamplingRate !== null) {
		node.setIntegerAttribute('audioSamplingRate', representation.audioSamplingRate);
	}
	if (representation.startWithSAP !== null) {
		node.setIntegerAttribute('startWithSAP', representation.startWithSAP);
	}
	appendCommonChildren(node, representation);
	if (representation.segmentBase !== null) {
		node.addChild(segmentBaseNode(representation.segmentBase));
	}
	return node;
};

const adaptationSetNode = (set: MpdAdaptationSet): XmlNode => {
	const node = new XmlNode('AdaptationSet');
	if (set.id !== null) {
		node.setStringAttribute('id', set.id);
	}
	if (set.group !== null) {
		node.setIntegerAttribute('group', set.group);
	}
	if (set.contentType !== null) {
		node.setStringAttribute('contentType', set.contentType);
	}
	if (set.mimeType !== null) {
		node.setStringAttribute('mimeType', set.mimeType);
	}
	if (set.codecs !== null) {
		node.setStringAttribute('codecs', set.codecs);
	}
	if (set.lang !== null) {
		node.setStringAttribute('lang', set.lang);
	}
	if (set.maxWidth !== null) {
		node.setIntegerAttribute('maxWidth', set.maxWidth);
	}
	if (set.maxHeight !== null) {
		node.setIntegerAttribute('maxHeight', set.maxHeight);
	}
	if (set.frameRate !== null) {
		node.setStringAttribute('frameRate', formatRational(set.frameRate));
	}
	for (const role of set.roles) {
		node.addChild(descriptorNode('Role', role.schemeIdUri, role.value));
	}
	appendCommonChildren(node, set);
	for (const representation of set.representations) {
		node.addChild(representationNode(representation));
	}
	return node;
};

const periodNode = (period: MpdPeriod): XmlNode => {
	const node = new XmlNode('Period');
	if (period.id !== null) {
		node.setStringAttribute('id', period.id);
	}
	setDuration(node, 'start', period.start);
	setDuration(node, 'duration', period.duration);
	for (const url of period.baseURLs) {
		node.addChild(baseUrlNode(url));
	}
	for (const set of period.adaptationSets) {
		node.addChild(adaptationSetNode(set));
	}
	return node;
};

/** Set `xmlns` plus an `xmlns:<prefix>` for every prefix the built tree references (e.g. `cenc`). */
const injectNamespaces = (mpd: XmlNode): void => {
	const prefixes = mpd.extractReferencedNamespaces();
	mpd.setStringAttribute('xmlns', DASH_NS.mpd);
	for (const prefix of prefixes) {
		const uri = NAMESPACE_URI_BY_PREFIX[prefix];
		if (uri === undefined) {
			throw new Error(`Unknown XML namespace prefix: ${prefix}`);
		}
		mpd.setStringAttribute(`xmlns:${prefix}`, uri);
	}
};

const buildMpd = (mpd: Mpd): XmlNode => {
	const node = new XmlNode('MPD');
	for (const url of mpd.baseURLs) {
		node.addChild(baseUrlNode(url));
	}
	for (const period of mpd.periods) {
		node.addChild(periodNode(period));
	}
	for (const timing of mpd.utcTiming) {
		node.addChild(descriptorNode('UTCTiming', timing.schemeIdUri, timing.value));
	}

	// Namespaces are injected after the subtree exists so prefixed children (cenc:*) are discovered.
	injectNamespaces(node);
	node.setStringAttribute('type', mpd.type);
	if (mpd.profiles.length > 0) {
		node.setStringAttribute('profiles', mpd.profiles.join(','));
	}
	setDuration(node, 'minBufferTime', mpd.minBufferTime);
	setDuration(node, 'mediaPresentationDuration', mpd.mediaPresentationDuration);
	setDuration(node, 'minimumUpdatePeriod', mpd.minimumUpdatePeriod);
	setDuration(node, 'timeShiftBufferDepth', mpd.timeShiftBufferDepth);
	setDuration(node, 'suggestedPresentationDelay', mpd.suggestedPresentationDelay);
	setDuration(node, 'maxSegmentDuration', mpd.maxSegmentDuration);
	setDateTime(node, 'availabilityStartTime', mpd.availabilityStartTime);
	setDateTime(node, 'publishTime', mpd.publishTime);
	return node;
};

/**
 * Serialize a parsed {@link Mpd} AST back to MPD XML — the write half of the
 * `parseMpd` → mutate → `serializeMpd` round-trip.
 *
 * Coalesced defaults (`@timescale=1`, `@startNumber=1`, `@presentationTimeOffset=0`,
 * `@availabilityTimeOffset=0`, `<S>@r=0`) are omitted rather than emitted — the
 * parser re-applies them on read, so the round-trip stays stable. Durations render
 * as ISO-8601 `PT#S` (≤6 decimals — lossless at microsecond precision and
 * idempotent), `cenc:default_KID` as a dashed UUID, and
 * `xmlns:cenc` is injected only when a `<cenc:*>` node is present.
 *
 * @group DASH
 * @public
 */
export const serializeMpd = (mpd: Mpd): string => buildMpd(mpd).toString();
