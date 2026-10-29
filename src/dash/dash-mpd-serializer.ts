/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MalformedInputError } from '../errors';
import { hexStringToBytes } from '../misc';
import { DASH_NS } from './dash-misc';
import type { DashRational } from './dash-misc';
import type { MpdBaseURL } from './dash-mpd-parser';
import { generateCencPsshElement, hexToUUID, secondsToXmlDuration } from './dash-mpd-utils';
import { formatISODateTime } from './dash-misc';
import type {
	ByteRange,
	ContentProtection,
	DashDescriptor,
	Mpd,
	MpdEventStream,
	MpdLabel,
	MpdRepresentationBaseChildren,
	MpdAdaptationSet,
	MpdPeriod,
	MpdRepresentation,
	SegmentBase,
	SegmentList,
	SegmentTemplate,
	SegmentTimelineEntry,
	MpdServiceDescription,
} from './dash-mpd-parser';
import { descriptorNode, XmlNode } from './dash-xml-node';

/** XML namespace URI for each prefix the serializer may emit (drives `xmlns:*` injection). */
const NAMESPACE_URI_BY_PREFIX: Record<string, string> = {
	cenc: DASH_NS.cenc,
	mspr: DASH_NS.mspr,
	xsi: DASH_NS.xsi,
	scte35: DASH_NS.scte35,
	scte214: DASH_NS.scte214,
	dashif: DASH_NS.dashif,
	mas: DASH_NS.mas,
	xlink: DASH_NS.xlink,
};

type Initialization = { sourceURL: string | null; range: ByteRange | null };

const byteRangeToString = (range: ByteRange): string => `${range.start}-${range.end}`;

const formatRational = (rational: DashRational): string =>
	rational.denominator === 1 ? String(rational.numerator) : `${rational.numerator}/${rational.denominator}`;

/** CENC key id is stored as 32 lowercase hex chars; `cenc:default_KID` wants the dashed UUID form. */
const keyIdToUuid = (keyIdHex: string): string => hexToUUID(hexStringToBytes(keyIdHex)) ?? keyIdHex;

const setDuration = (node: XmlNode, name: string, seconds: number | null | undefined): void => {
	if (seconds != null) {
		node.setStringAttribute(name, secondsToXmlDuration(seconds));
	}
};

const setDateTime = (node: XmlNode, name: string, unixMs: number | null): void => {
	if (unixMs !== null) {
		node.setStringAttribute(name, formatISODateTime(unixMs));
	}
};

const setInteger = (node: XmlNode, name: string, value: number | null | undefined): void => {
	if (value != null) {
		node.setIntegerAttribute(name, value);
	}
};

const setString = (node: XmlNode, name: string, value: string | null | undefined): void => {
	if (value != null) {
		node.setStringAttribute(name, value);
	}
};

const setBool = (node: XmlNode, name: string, value: boolean | null | undefined): void => {
	if (value != null) {
		node.setStringAttribute(name, value ? 'true' : 'false');
	}
};

// Shared by AdaptationSet and Representation, which both extend RepresentationBaseType.
const setRepresentationBase = (node: XmlNode, base: {
	profiles: string | null;
	segmentProfiles: string | null;
	containerProfiles: string | null;
	scanType: string | null;
	codingDependency: boolean | null;
	maxPlayoutRate: number | null;
	maximumSAPPeriod: number | null;
	selectionPriority: number | null;
	tag: string | null;
}): void => {
	setString(node, 'profiles', base.profiles);
	setString(node, 'segmentProfiles', base.segmentProfiles);
	setString(node, 'containerProfiles', base.containerProfiles);
	setString(node, 'scanType', base.scanType);
	setBool(node, 'codingDependency', base.codingDependency);
	setFloat(node, 'maxPlayoutRate', base.maxPlayoutRate);
	setFloat(node, 'maximumSAPPeriod', base.maximumSAPPeriod);
	setInteger(node, 'selectionPriority', base.selectionPriority);
	setString(node, 'tag', base.tag);
};

const setFloat = (node: XmlNode, name: string, value: number | null | undefined): void => {
	if (value != null) {
		node.setStringAttribute(name, String(value));
	}
};

const descriptorNodes = (parent: XmlNode, name: string, items: readonly DashDescriptor[] | undefined): void => {
	for (const item of items ?? []) {
		const node = new XmlNode(name);
		node.setStringAttribute('schemeIdUri', item.schemeIdUri);
		setString(node, 'value', item.value);
		setString(node, 'id', item.id);
		parent.addChild(node);
	}
};

const eventStreamNodes = (parent: XmlNode, name: string, streams: readonly MpdEventStream[] | undefined): void => {
	for (const stream of streams ?? []) {
		const node = new XmlNode(name);
		node.setStringAttribute('schemeIdUri', stream.schemeIdUri);
		setString(node, 'value', stream.value);
		setInteger(node, 'timescale', stream.timescale);
		setInteger(node, 'presentationTimeOffset', stream.presentationTimeOffset);
		for (const event of stream.events ?? []) {
			const eventNode = new XmlNode('Event');
			setInteger(eventNode, 'presentationTime', event.presentationTime);
			setInteger(eventNode, 'duration', event.duration);
			setInteger(eventNode, 'id', event.id);
			setString(eventNode, 'contentEncoding', event.contentEncoding);
			setString(eventNode, 'messageData', event.messageData);
			if (event.value !== null) {
				eventNode.setContent(event.value);
			}
			const statesSignal = event.foreignXml.some(xml => /^<\s*(?:\w+:)?Signal[\s>]/.test(xml));
			if (event.scte35Binary !== null && !statesSignal) {
				const signal = new XmlNode('scte35:Signal');
				const binary = new XmlNode('scte35:Binary');
				binary.setContent(event.scte35Binary);
				signal.addChild(binary);
				eventNode.addChild(signal);
			}
			for (const raw of event.foreignXml) {
				eventNode.addRawXml(raw);
			}
			node.addChild(eventNode);
		}
		parent.addChild(node);
	}
};

const labelNodes = (parent: XmlNode, name: string, labels: readonly MpdLabel[] | undefined): void => {
	for (const label of labels ?? []) {
		const node = new XmlNode(name);
		setInteger(node, 'id', label.id);
		setString(node, 'lang', label.lang);
		node.setContent(label.value);
		parent.addChild(node);
	}
};

const representationBaseChildNodes = (parent: XmlNode, base: MpdRepresentationBaseChildren | undefined): void => {
	if (base === undefined) {
		return;
	}

	descriptorNodes(parent, 'FramePacking', base.framePackings);
	descriptorNodes(parent, 'OutputProtection', base.outputProtections);
	eventStreamNodes(parent, 'InbandEventStream', base.inbandEventStreams);
	for (const prt of base.producerReferenceTimes ?? []) {
		const node = new XmlNode('ProducerReferenceTime');
		setInteger(node, 'id', prt.id);
		setBool(node, 'inband', prt.inband);
		setString(node, 'type', prt.type);
		setString(node, 'applicationScheme', prt.applicationScheme);
		setString(node, 'wallClockTime', prt.wallClockTime);
		setInteger(node, 'presentationTime', prt.presentationTime);
		descriptorNodes(node, 'UTCTiming', prt.utcTiming);
		parent.addChild(node);
	}
	for (const ra of base.randomAccess ?? []) {
		const node = new XmlNode('RandomAccess');
		setInteger(node, 'interval', ra.interval);
		setString(node, 'type', ra.type);
		setDuration(node, 'minBufferTime', ra.minBufferTime);
		setInteger(node, 'bandwidth', ra.bandwidth);
		parent.addChild(node);
	}
	for (const r of base.resync ?? []) {
		const node = new XmlNode('Resync');
		setInteger(node, 'type', r.type);
		setInteger(node, 'dT', r.dT);
		setFloat(node, 'dImax', r.dImax);
		setFloat(node, 'dImin', r.dImin);
		setBool(node, 'marker', r.marker);
		parent.addChild(node);
	}
	for (const sw of base.switching ?? []) {
		const node = new XmlNode('Switching');
		setInteger(node, 'interval', sw.interval);
		setString(node, 'type', sw.type);
		parent.addChild(node);
	}
	labelNodes(parent, 'GroupLabel', base.groupLabels);
	for (const cpr of base.contentPopularityRates ?? []) {
		const node = new XmlNode('ContentPopularityRate');
		for (const rate of cpr.rates ?? []) {
			const pr = new XmlNode('PR');
			setInteger(pr, 'popularityRate', rate.popularityRate);
			setInteger(pr, 'start', rate.start);
			setInteger(pr, 'r', rate.r);
			node.addChild(pr);
		}
		parent.addChild(node);
	}
};

const baseUrlNode = (entry: MpdBaseURL): XmlNode => {
	const node = new XmlNode('BaseURL');
	// The parser stores the raw URI reference; emit it verbatim (XML-escaped only).
	// setPathContent would percent-encode it and corrupt query strings / already-encoded paths.
	node.setContent(entry.value);
	setString(node, 'serviceLocation', entry.serviceLocation);
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
	for (const raw of cp.foreignXml) {
		node.addRawXml(raw);
	}
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
	setString(node, 'index', template.index);
	setInteger(node, 'endNumber', template.endNumber);
	setString(node, 'indexRange', template.indexRange);
	setBool(node, 'indexRangeExact', template.indexRangeExact);
	setInteger(node, 'presentationDuration', template.presentationDuration);
	setDuration(node, 'timeShiftBufferDepth', template.timeShiftBufferDepth);
	setInteger(node, 'eptDelta', template.eptDelta);
	setInteger(node, 'pdDelta', template.pdDelta);
	if (template.presentationTimeOffset !== 0) {
		node.setIntegerAttribute('presentationTimeOffset', template.presentationTimeOffset);
	}
	if (template.availabilityTimeOffset !== 0) {
		node.setFloatingPointAttribute('availabilityTimeOffset', template.availabilityTimeOffset);
	}
	if (!template.availabilityTimeComplete) {
		node.setStringAttribute('availabilityTimeComplete', 'false');
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
	for (const [name, url] of [['RepresentationIndex', base.representationIndex],
		['BitstreamSwitching', base.bitstreamSwitching]] as const) {
		if (url != null) {
			const child = new XmlNode(name);
			setString(child, 'sourceURL', url.sourceURL);
			setString(child, 'range', url.range);
			node.addChild(child);
		}
	}
	if (base.failoverContent != null) {
		const failover = new XmlNode('FailoverContent');
		setBool(failover, 'valid', base.failoverContent.valid);
		for (const fcs of base.failoverContent.fcs ?? []) {
			const child = new XmlNode('FCS');
			setInteger(child, 't', fcs.t);
			setInteger(child, 'd', fcs.d);
			failover.addChild(child);
		}
		node.addChild(failover);
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
	for (const entry of source.baseURLs) {
		node.addChild(baseUrlNode(entry));
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
	setRepresentationBase(node, representation);
	setInteger(node, 'qualityRanking', representation.qualityRanking);
	setString(node, 'dependencyId', representation.dependencyId);
	setString(node, 'associationId', representation.associationId);
	setString(node, 'associationType', representation.associationType);
	setString(node, 'mediaStreamStructureId', representation.mediaStreamStructureId);
	representationBaseChildNodes(node, representation.baseChildren);
	if (representation.extendedBandwidth != null) {
		const eb = new XmlNode('ExtendedBandwidth');
		setBool(eb, 'vbr', representation.extendedBandwidth.vbr);
		for (const pair of representation.extendedBandwidth.modelPairs ?? []) {
			const mp = new XmlNode('ModelPair');
			setDuration(mp, 'bufferTime', pair.bufferTime);
			setInteger(mp, 'bandwidth', pair.bandwidth);
			eb.addChild(mp);
		}
		node.addChild(eb);
	}
	for (const sub of representation.subRepresentations ?? []) {
		const sr = new XmlNode('SubRepresentation');
		setInteger(sr, 'level', sub.level);
		setString(sr, 'dependencyLevel', sub.dependencyLevel);
		setInteger(sr, 'bandwidth', sub.bandwidth);
		setString(sr, 'contentComponent', sub.contentComponent);
		representationBaseChildNodes(sr, sub.baseChildren);
		node.addChild(sr);
	}
	appendCommonChildren(node, representation);
	if (representation.segmentBase !== null) {
		node.addChild(segmentBaseNode(representation.segmentBase));
	}
	return node;
};

const adaptationSetNode = (set: MpdAdaptationSet, name = 'AdaptationSet'): XmlNode => {
	const node = new XmlNode(name);
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
	setInteger(node, 'width', set.width);
	setInteger(node, 'height', set.height);
	setInteger(node, 'audioSamplingRate', set.audioSamplingRate);
	setString(node, 'par', set.par);
	setInteger(node, 'startWithSAP', set.startWithSAP);
	setInteger(node, 'subsegmentStartsWithSAP', set.subsegmentStartsWithSAP);
	setString(node, 'segmentAlignment', set.segmentAlignment === null ? null : String(set.segmentAlignment));
	setString(node, 'subsegmentAlignment', set.subsegmentAlignment === null ? null : String(set.subsegmentAlignment));
	if (set.frameRate !== null) {
		node.setStringAttribute('frameRate', formatRational(set.frameRate));
	}
	setRepresentationBase(node, set);
	setString(node, 'sar', set.sar);
	setBool(node, 'bitstreamSwitching', set.bitstreamSwitching);
	setInteger(node, 'maxBandwidth', set.maxBandwidth);
	setInteger(node, 'minBandwidth', set.minBandwidth);
	setString(node, 'maxFrameRate', set.maxFrameRate);
	setString(node, 'minFrameRate', set.minFrameRate);
	setInteger(node, 'minWidth', set.minWidth);
	setInteger(node, 'minHeight', set.minHeight);
	setString(node, 'initializationSetRef', set.initializationSetRef);
	setString(node, 'initializationPrincipal', set.initializationPrincipal);
	for (const role of set.roles) {
		node.addChild(descriptorNode('Role', role.schemeIdUri, role.value));
	}
	representationBaseChildNodes(node, set.baseChildren);
	descriptorNodes(node, 'Accessibility', set.accessibility);
	descriptorNodes(node, 'Rating', set.ratings);
	descriptorNodes(node, 'Viewpoint', set.viewpoints);
	for (const component of set.contentComponents ?? []) {
		const cc = new XmlNode('ContentComponent');
		setInteger(cc, 'id', component.id);
		setString(cc, 'lang', component.lang);
		setString(cc, 'contentType', component.contentType);
		setString(cc, 'par', component.par);
		setString(cc, 'tag', component.tag);
		descriptorNodes(cc, 'Accessibility', component.accessibility);
		descriptorNodes(cc, 'Role', component.roles);
		descriptorNodes(cc, 'Rating', component.ratings);
		descriptorNodes(cc, 'Viewpoint', component.viewpoints);
		node.addChild(cc);
	}
	appendCommonChildren(node, set);
	for (const representation of set.representations) {
		node.addChild(representationNode(representation));
	}
	return node;
};

const serviceDescriptionNode = (description: MpdServiceDescription): XmlNode => {
	const node = new XmlNode('ServiceDescription');
	setInteger(node, 'id', description.id);
	if (description.latency !== null) {
		const latency = new XmlNode('Latency');
		for (const name of ['referenceId', 'target', 'min', 'max'] as const) {
			const value = description.latency[name];
			if (value !== null) {
				latency.setIntegerAttribute(name, value);
			}
		}
		for (const ql of description.latency.qualityLatency ?? []) {
			const qualityLatency = new XmlNode('QualityLatency');
			setString(qualityLatency, 'type', ql.type);
			qualityLatency.setContent(ql.value);
			latency.addChild(qualityLatency);
		}
		node.addChild(latency);
	}
	if (description.playbackRate !== null) {
		const playbackRate = new XmlNode('PlaybackRate');
		for (const name of ['min', 'max'] as const) {
			const value = description.playbackRate[name];
			if (value !== null) {
				playbackRate.setFloatingPointAttribute(name, value);
			}
		}
		node.addChild(playbackRate);
	}
	descriptorNodes(node, 'Scope', description.scopes);
	for (const oq of description.operatingQuality ?? []) {
		const quality = new XmlNode('OperatingQuality');
		setString(quality, 'type', oq.type);
		setInteger(quality, 'min', oq.min);
		setInteger(quality, 'max', oq.max);
		setInteger(quality, 'target', oq.target);
		setInteger(quality, 'maxDifference', oq.maxDifference);
		node.addChild(quality);
	}
	for (const ob of description.operatingBandwidth ?? []) {
		const bandwidth = new XmlNode('OperatingBandwidth');
		setInteger(bandwidth, 'min', ob.min);
		setInteger(bandwidth, 'max', ob.max);
		setInteger(bandwidth, 'target', ob.target);
		node.addChild(bandwidth);
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
	setBool(node, 'bitstreamSwitching', period.bitstreamSwitching);
	if (period.assetIdentifier != null) {
		descriptorNodes(node, 'AssetIdentifier', [period.assetIdentifier]);
	}
	eventStreamNodes(node, 'EventStream', period.eventStreams);
	for (const subset of period.subsets ?? []) {
		const sub = new XmlNode('Subset');
		setString(sub, 'contains', subset.contains);
		setString(sub, 'id', subset.id);
		node.addChild(sub);
	}
	labelNodes(node, 'GroupLabel', period.groupLabels);
	for (const preselection of period.preselections ?? []) {
		const ps = new XmlNode('Preselection');
		setString(ps, 'id', preselection.id);
		setString(ps, 'preselectionComponents', preselection.preselectionComponents);
		setString(ps, 'lang', preselection.lang);
		setString(ps, 'order', preselection.order);
		descriptorNodes(ps, 'Accessibility', preselection.accessibility);
		descriptorNodes(ps, 'Role', preselection.roles);
		descriptorNodes(ps, 'Rating', preselection.ratings);
		descriptorNodes(ps, 'Viewpoint', preselection.viewpoints);
		representationBaseChildNodes(ps, preselection.baseChildren);
		node.addChild(ps);
	}
	for (const set of period.emptyAdaptationSets ?? []) {
		node.addChild(adaptationSetNode(set, 'EmptyAdaptationSet'));
	}
	for (const entry of period.baseURLs) {
		node.addChild(baseUrlNode(entry));
	}
	for (const description of period.serviceDescriptions) {
		node.addChild(serviceDescriptionNode(description));
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
			throw new MalformedInputError(`Unknown XML namespace prefix: ${prefix}`);
		}
		mpd.setStringAttribute(`xmlns:${prefix}`, uri);
	}
};

const buildMpd = (mpd: Mpd): XmlNode => {
	const node = new XmlNode('MPD');
	for (const entry of mpd.baseURLs) {
		node.addChild(baseUrlNode(entry));
	}
	for (const description of mpd.serviceDescriptions) {
		node.addChild(serviceDescriptionNode(description));
	}
	if (mpd.contentSteering) {
		const steering = new XmlNode('ContentSteering');
		steering.setContent(mpd.contentSteering.value);
		setString(steering, 'defaultServiceLocation', mpd.contentSteering.defaultServiceLocation);
		setBool(steering, 'queryBeforeStart', mpd.contentSteering.queryBeforeStart);
		setString(steering, 'proxyServerURL', mpd.contentSteering.proxyServerURL);
		setBool(steering, 'clientRequirement', mpd.contentSteering.clientRequirement);
		node.addChild(steering);
	}
	for (const timing of mpd.utcTiming) {
		node.addChild(descriptorNode('UTCTiming', timing.schemeIdUri, timing.value));
	}

	setDateTime(node, 'availabilityStartTime', mpd.availabilityStartTime);
	setDateTime(node, 'publishTime', mpd.publishTime);
	for (const info of mpd.programInformations ?? []) {
		const pi = new XmlNode('ProgramInformation');
		setString(pi, 'lang', info.lang);
		setString(pi, 'moreInformationURL', info.moreInformationURL);
		for (const [name, value] of [['Title', info.title], ['Source', info.source],
			['Copyright', info.copyright]] as const) {
			if (value !== null) {
				const child = new XmlNode(name);
				child.setContent(value);
				pi.addChild(child);
			}
		}
		node.addChild(pi);
	}
	for (const set of mpd.initializationSets ?? []) {
		const node2 = new XmlNode('InitializationSet');
		setInteger(node2, 'id', set.id);
		setBool(node2, 'inAllPeriods', set.inAllPeriods);
		setString(node2, 'contentType', set.contentType);
		setString(node2, 'par', set.par);
		setInteger(node2, 'maxWidth', set.maxWidth);
		setInteger(node2, 'maxHeight', set.maxHeight);
		setString(node2, 'maxFrameRate', set.maxFrameRate);
		setString(node2, 'initialization', set.initialization);
		representationBaseChildNodes(node2, set.baseChildren);
		node.addChild(node2);
	}
	for (const [name, refs] of [['InitializationGroup', mpd.initializationGroups],
		['InitializationPresentation', mpd.initializationPresentations]] as const) {
		for (const ref of refs ?? []) {
			const child = new XmlNode(name);
			setInteger(child, 'id', ref.id);
			setString(child, 'profiles', ref.profiles);
			setString(child, 'contentType', ref.contentType);
			child.setContent(ref.value);
			node.addChild(child);
		}
	}
	for (const location of mpd.locations ?? []) {
		const loc = new XmlNode('Location');
		loc.setContent(location);
		node.addChild(loc);
	}
	for (const patch of mpd.patchLocations ?? []) {
		const pl = new XmlNode('PatchLocation');
		setFloat(pl, 'ttl', patch.ttl);
		pl.setContent(patch.value);
		node.addChild(pl);
	}
	for (const period of mpd.periods) {
		node.addChild(periodNode(period));
	}
	for (const metric of mpd.metrics ?? []) {
		const m = new XmlNode('Metrics');
		setString(m, 'metrics', metric.metrics);
		for (const range of metric.ranges ?? []) {
			const r = new XmlNode('Range');
			setDuration(r, 'starttime', range.starttime);
			setDuration(r, 'duration', range.duration);
			m.addChild(r);
		}
		descriptorNodes(m, 'Reporting', metric.reporting);
		node.addChild(m);
	}
	if (mpd.leapSecondInformation != null) {
		const lsi = new XmlNode('LeapSecondInformation');
		setInteger(lsi, 'availabilityStartLeapOffset', mpd.leapSecondInformation.availabilityStartLeapOffset);
		setInteger(lsi, 'nextAvailabilityStartLeapOffset',
			mpd.leapSecondInformation.nextAvailabilityStartLeapOffset);
		setString(lsi, 'nextLeapChangeTime', mpd.leapSecondInformation.nextLeapChangeTime);
		node.addChild(lsi);
	}
	setString(node, 'xsi:schemaLocation', mpd.schemaLocation);
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
