/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/xml/xml_node.cc
 *   (RepresentationBaseXmlNode + AdaptationSetXmlNode + RepresentationXmlNode)
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import type { ByteRange } from '../isobmff/isobmff-misc';
import type { ContentProtectionElement } from './dash-content-protection';
import type {
	AudioInfo,
	MediaInfo,
	VideoInfo,
} from './dash-media-info';
import type { SegmentInfo } from './dash-types';
import { descriptorNode, XmlNode } from './dash-xml-node';

/** @internal */
const EC3_CODEC = 'ec-3';
/** @internal */
const AC4_CODEC = 'ac-4';
/** @internal */
const DTSC_CODEC = 'dtsc';
/** @internal */
const DTSE_CODEC = 'dtse';
/** @internal */
const DTSX_CODEC = 'dtsx';

/** @internal */
const rangeToString = (range: ByteRange): string => `${range.begin}-${range.end}`;

/**
 * Returns `true` when `segmentInfos` describes a continuous timeline whose
 * segments — except possibly the last — all share a common duration. Used by
 * `RepresentationXmlNode.addLiveOnlyInfo` to optimize SegmentTimeline into
 * a SegmentTemplate@duration. Mirrors shaka's `IsTimelineConstantDuration`.
 *
 * Note: shaka's gate flag `--segment_template_constant_duration` defaults to
 * `false`, so this helper returns `false` unless the caller passes
 * `flagSegmentTemplateConstantDuration: true`.
 *
 * @internal
 */
const isTimelineConstantDuration = (
	segmentInfos: readonly SegmentInfo[],
	startNumber: number,
	flagSegmentTemplateConstantDuration: boolean,
): boolean => {
	if (!flagSegmentTemplateConstantDuration) {
		return false;
	}
	if (segmentInfos.length === 0 || segmentInfos.length > 2) {
		return false;
	}
	const first = segmentInfos[0]!;
	if (first.startTime !== first.duration * (startNumber - 1)) {
		return false;
	}
	if (segmentInfos.length === 1) {
		return true;
	}
	const last = segmentInfos[segmentInfos.length - 1]!;
	if (last.repeat !== 0) {
		return false;
	}
	const expectedLastSegmentStartTime = first.startTime + first.duration * (first.repeat + 1);
	return expectedLastSegmentStartTime === last.startTime;
};

/**
 * Render `segmentInfos` as `<S t="..." d="..." r="..."/>` children of
 * `segmentTimeline`. Mirrors shaka's `PopulateSegmentTimeline`.
 *
 * @internal
 */
const populateSegmentTimeline = (
	segmentInfos: readonly SegmentInfo[],
	segmentTimeline: XmlNode,
): boolean => {
	for (const segmentInfo of segmentInfos) {
		const sElement = new XmlNode('S');
		sElement.setIntegerAttribute('t', segmentInfo.startTime);
		sElement.setIntegerAttribute('d', segmentInfo.duration);
		if (segmentInfo.repeat > 0) {
			sElement.setIntegerAttribute('r', segmentInfo.repeat);
		}
		segmentTimeline.addChild(sElement);
	}
	return true;
};

/**
 * `<RepresentationBaseType>` per the DASH MPD schema (ISO 23009-1). Common
 * base for `<AdaptationSet>` and `<Representation>`. Mirrors shaka's
 * `RepresentationBaseXmlNode`.
 *
 * Not instantiated directly — see {@link RepresentationXmlNode} and
 * `AdaptationSetXmlNode`.
 *
 * @group DASH
 * @public
 */
export class RepresentationBaseXmlNode extends XmlNode {
	constructor(name: string) {
		super(name);
	}

	/**
	 * Append one `<ContentProtection>` child built from the supplied descriptor.
	 * Mirrors shaka's `RepresentationBaseXmlNode::AddContentProtectionElement`.
	 *
	 * Sets `value` (when non-empty) and `schemeIdUri` first, then blindly sets
	 * every entry in `additionalAttributes` — so a duplicate `value` /
	 * `schemeIdUri` key in the map overwrites the top-level one (later-set-wins).
	 * Shaka keeps output clean by running `removeDuplicateAttributes` upstream,
	 * not by skipping duplicates here.
	 */
	addContentProtectionElement(element: ContentProtectionElement): void {
		const node = new XmlNode('ContentProtection');

		if (element.value.length > 0) {
			node.setStringAttribute('value', element.value);
		}
		node.setStringAttribute('schemeIdUri', element.schemeIdUri);

		for (const [key, value] of element.additionalAttributes) {
			node.setStringAttribute(key, value);
		}

		node.addElements(element.subelements);
		this.addChild(node);
	}

	/**
	 * Append one `<ContentProtection>` per descriptor. Mirrors shaka's
	 * `AddContentProtectionElements`.
	 */
	addContentProtectionElements(elements: readonly ContentProtectionElement[]): void {
		for (const element of elements) {
			this.addContentProtectionElement(element);
		}
	}

	/**
	 * Append a `<SupplementalProperty schemeIdUri="..." value="..."/>` child.
	 * Mirrors shaka's `AddSupplementalProperty`.
	 */
	addSupplementalProperty(schemeIdUri: string, value: string): void {
		this.addDescriptor('SupplementalProperty', schemeIdUri, value);
	}

	/**
	 * Append an `<EssentialProperty schemeIdUri="..." value="..."/>` child.
	 * Mirrors shaka's `AddEssentialProperty`.
	 */
	addEssentialProperty(schemeIdUri: string, value: string): void {
		this.addDescriptor('EssentialProperty', schemeIdUri, value);
	}

	/**
	 * Append a generic descriptor child (`<Name schemeIdUri="..." value="..."/>`).
	 * Mirrors shaka's `RepresentationBaseXmlNode::AddDescriptor`.
	 */
	protected addDescriptor(descriptorName: string, schemeIdUri: string, value: string): void {
		this.addChild(descriptorNode(descriptorName, schemeIdUri, value.length > 0 ? value : null));
	}
}

/**
 * `<AdaptationSet>` element in the DASH MPD schema. Mirrors shaka's
 * `AdaptationSetXmlNode`. Adds Accessibility / Role / Label child-element
 * helpers on top of {@link RepresentationBaseXmlNode}.
 *
 * @group DASH
 * @public
 */
export class AdaptationSetXmlNode extends RepresentationBaseXmlNode {
	constructor() {
		super('AdaptationSet');
	}

	/**
	 * Append an `<Accessibility schemeIdUri="..." value="..."/>` child.
	 * Mirrors shaka's `AdaptationSetXmlNode::AddAccessibilityElement`.
	 */
	addAccessibilityElement(schemeIdUri: string, value: string): void {
		this.addDescriptor('Accessibility', schemeIdUri, value);
	}

	/**
	 * Append a `<Role schemeIdUri="..." value="..."/>` child.
	 * Mirrors shaka's `AdaptationSetXmlNode::AddRoleElement`.
	 */
	addRoleElement(schemeIdUri: string, value: string): void {
		this.addDescriptor('Role', schemeIdUri, value);
	}

	/**
	 * Append a `<Label>` child whose text content is `value`. Mirrors
	 * shaka's `AdaptationSetXmlNode::AddLabelElement`.
	 */
	addLabelElement(value: string): void {
		const descriptor = new XmlNode('Label');
		descriptor.setContent(value);
		this.addChild(descriptor);
	}
}

/**
 * `<Representation>` element in the DASH MPD schema. Builds the per-media
 * stream node — codecs, dimensions, frame rate, audio channel config, and
 * SegmentBase / SegmentList / SegmentTemplate addressing. Mirrors shaka's
 * `RepresentationXmlNode`.
 *
 * @group DASH
 * @public
 */
export class RepresentationXmlNode extends RepresentationBaseXmlNode {
	constructor() {
		super('Representation');
	}

	/**
	 * Add video metadata. Sets `width` / `height` / `frameRate` / `sar` from
	 * `videoInfo`, plus trick-play attributes when `videoInfo.playbackRate` is
	 * set. Mirrors shaka's `AddVideoInfo`.
	 *
	 * @param videoInfo - source video info
	 * @param setWidth - emit `width` attribute (suppress for I-frame trick play)
	 * @param setHeight - emit `height` attribute
	 * @param setFrameRate - emit `frameRate` attribute (skipped when shared up to AdaptationSet)
	 */
	addVideoInfo(
		videoInfo: VideoInfo,
		setWidth: boolean,
		setHeight: boolean,
		setFrameRate: boolean,
	): boolean {
		if (videoInfo.width === undefined || videoInfo.height === undefined) {
			return false;
		}

		if (videoInfo.pixelWidth !== undefined && videoInfo.pixelHeight !== undefined) {
			this.setStringAttribute('sar', `${videoInfo.pixelWidth}:${videoInfo.pixelHeight}`);
		}

		if (setWidth) {
			this.setIntegerAttribute('width', videoInfo.width);
		}
		if (setHeight) {
			this.setIntegerAttribute('height', videoInfo.height);
		}
		if (setFrameRate && videoInfo.timeScale !== undefined && videoInfo.frameDuration !== undefined) {
			this.setStringAttribute('frameRate', `${videoInfo.timeScale}/${videoInfo.frameDuration}`);
		}

		if (videoInfo.playbackRate !== undefined) {
			this.setStringAttribute('maxPlayoutRate', String(videoInfo.playbackRate));
			// Trick-play streams contain only key frames so coding dependency
			// on the main stream is broken. Per shaka, simply set false.
			this.setStringAttribute('codingDependency', 'false');
		}
		return true;
	}

	/**
	 * Add audio metadata: `<AudioChannelConfiguration>` per shaka's logic
	 * (Dolby EC-3 / AC-4 / DTS / generic) and `audioSamplingRate` attribute.
	 * Mirrors shaka's `AddAudioInfo`.
	 */
	addAudioInfo(audioInfo: AudioInfo): void {
		this.addAudioChannelInfo(audioInfo);
		this.addAudioSamplingRateInfo(audioInfo);
	}

	/**
	 * Add fields specific to VOD presentations. Emits `<BaseURL>`,
	 * `<SegmentBase>` / `<SegmentList>`, `<Initialization>`, and
	 * subsegment `<SegmentURL>` entries depending on the supplied
	 * `mediaInfo`. Mirrors shaka's `AddVODOnlyInfo`.
	 *
	 * @param mediaInfo - media info containing VOD fields
	 * @param useSegmentList - emit `<SegmentList>` instead of `<SegmentBase>`
	 * @param targetSegmentDuration - target segment duration in seconds
	 *                                (used to compute `duration` attribute on
	 *                                `<SegmentList>` when `useSegmentList`)
	 */
	addVODOnlyInfo(
		mediaInfo: MediaInfo,
		useSegmentList: boolean,
		targetSegmentDuration: number,
	): void {
		if (mediaInfo.mediaFileUrl !== undefined) {
			const baseUrl = new XmlNode('BaseURL');
			baseUrl.setPathContent(mediaInfo.mediaFileUrl);
			this.addChild(baseUrl);
		}

		// For single-file text tracks with a presentationTimeOffset we still need a
		// SegmentBase element to carry the offset — SegmentBase is correct here
		// because the track is a single segment, not a segmented stream.
		const needSegmentBaseOrList = useSegmentList
			|| mediaInfo.indexRange !== undefined
			|| mediaInfo.initRange !== undefined
			|| (mediaInfo.referenceTimeScale !== undefined && mediaInfo.textInfo === undefined)
			|| (mediaInfo.textInfo !== undefined && mediaInfo.presentationTimeOffset !== undefined);

		if (!needSegmentBaseOrList) {
			return;
		}

		const child = new XmlNode(useSegmentList ? 'SegmentList' : 'SegmentBase');

		// Forcing SegmentList for longer audio causes sidx atom to not be
		// generated, therefore indexRange is not added to MPD if flag is set.
		if (mediaInfo.indexRange !== undefined && !useSegmentList) {
			child.setStringAttribute('indexRange', rangeToString(mediaInfo.indexRange));
		}

		if (mediaInfo.referenceTimeScale !== undefined) {
			child.setIntegerAttribute('timescale', mediaInfo.referenceTimeScale);
			if (useSegmentList) {
				const durationSeconds = Math.floor(targetSegmentDuration * mediaInfo.referenceTimeScale);
				child.setIntegerAttribute('duration', durationSeconds);
			}
		}

		if (mediaInfo.presentationTimeOffset !== undefined) {
			child.setIntegerAttribute('presentationTimeOffset', mediaInfo.presentationTimeOffset);
		}

		if (mediaInfo.initRange !== undefined) {
			const initialization = new XmlNode('Initialization');
			initialization.setStringAttribute('range', rangeToString(mediaInfo.initRange));
			child.addChild(initialization);
		}

		// Since the SegmentURLs here do not have a @media element, BaseURL
		// element is mapped to the @media attribute.
		if (useSegmentList && mediaInfo.subsegmentRanges !== undefined) {
			for (const subsegmentRange of mediaInfo.subsegmentRanges) {
				const subsegment = new XmlNode('SegmentURL');
				subsegment.setStringAttribute('mediaRange', rangeToString(subsegmentRange));
				child.addChild(subsegment);
			}
		}

		this.addChild(child);
	}

	/**
	 * Add fields specific to live (dynamic-MPD) presentations. Emits a
	 * `<SegmentTemplate>` with optional `<SegmentTimeline>` children.
	 * Mirrors shaka's `AddLiveOnlyInfo`.
	 *
	 * @param mediaInfo - media info containing live fields
	 * @param segmentInfos - already-published segments. Assumed sorted by start time.
	 * @param lowLatencyDashMode - LL-DASH mode flag
	 * @param flagDashAddLastSegmentNumberWhenNeeded - shaka's
	 *        `--dash_add_last_segment_number_when_needed` CLI flag (defaults to false)
	 * @param flagSegmentTemplateConstantDuration - shaka's
	 *        `--segment_template_constant_duration` CLI flag (defaults to false)
	 */
	addLiveOnlyInfo(
		mediaInfo: MediaInfo,
		segmentInfos: readonly SegmentInfo[],
		lowLatencyDashMode: boolean,
		flagDashAddLastSegmentNumberWhenNeeded = false,
		flagSegmentTemplateConstantDuration = false,
	): void {
		const segmentTemplate = new XmlNode('SegmentTemplate');

		const startNumber = segmentInfos.length === 0 ? 1 : segmentInfos[0]!.startSegmentNumber;

		if (mediaInfo.referenceTimeScale !== undefined) {
			segmentTemplate.setIntegerAttribute('timescale', mediaInfo.referenceTimeScale);
		}

		if (mediaInfo.segmentDuration !== undefined) {
			segmentTemplate.setIntegerAttribute('duration', mediaInfo.segmentDuration);
		}

		if (mediaInfo.presentationTimeOffset !== undefined) {
			segmentTemplate.setIntegerAttribute('presentationTimeOffset', mediaInfo.presentationTimeOffset);
		}

		if (mediaInfo.availabilityTimeOffset !== undefined) {
			const ato = mediaInfo.availabilityTimeOffset;
			segmentTemplate.setFloatingPointAttribute('availabilityTimeOffset', ato);
		}

		if (lowLatencyDashMode) {
			segmentTemplate.setStringAttribute('availabilityTimeComplete', 'false');
		}

		if (mediaInfo.initSegmentUrl !== undefined) {
			segmentTemplate.setStringAttribute('initialization', mediaInfo.initSegmentUrl);
		}

		if (mediaInfo.segmentTemplateUrl !== undefined) {
			segmentTemplate.setStringAttribute('media', mediaInfo.segmentTemplateUrl);
			segmentTemplate.setIntegerAttribute('startNumber', startNumber);
		}

		if (segmentInfos.length > 0) {
			// Don't use SegmentTimeline if all segments except the last one
			// are of the same duration.
			if (isTimelineConstantDuration(segmentInfos, startNumber, flagSegmentTemplateConstantDuration)) {
				segmentTemplate.setIntegerAttribute('duration', segmentInfos[0]!.duration);
				if (flagDashAddLastSegmentNumberWhenNeeded) {
					let lastSegmentNumber = startNumber - 1;
					for (const segmentInfo of segmentInfos) {
						lastSegmentNumber += segmentInfo.repeat + 1;
					}
					this.addSupplementalProperty(
						'http://dashif.org/guidelines/last-segment-number',
						String(lastSegmentNumber),
					);
				}
			} else if (!lowLatencyDashMode) {
				const segmentTimeline = new XmlNode('SegmentTimeline');
				if (!populateSegmentTimeline(segmentInfos, segmentTimeline)) {
					return;
				}
				segmentTemplate.addChild(segmentTimeline);
			}
		}
		this.addChild(segmentTemplate);
	}

	/** @internal */
	private addAudioChannelInfo(audioInfo: AudioInfo): void {
		let audioChannelConfigScheme = '';
		let audioChannelConfigValue = '';

		const codec = audioInfo.codec ?? '';
		const codecData = audioInfo.codecSpecificData;

		if (codec === EC3_CODEC) {
			// Use MPEG scheme if the mpeg value is available and valid; otherwise
			// fall back to EC-3 channel mapping. See
			// https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/268
			const ec3ChannelMpegValue = codecData?.channelMpegValue;
			const NO_MAPPING = 0xFFFFFFFF;
			if (ec3ChannelMpegValue === undefined || ec3ChannelMpegValue === NO_MAPPING) {
				// EC-3 channel map as 4 hex digits, padded.
				// Spec: DASH-IF Interoperability Points v3.0 9.2.1.2.
				const mask = codecData?.channelMask ?? 0;
				audioChannelConfigValue = mask.toString(16).toUpperCase().padStart(4, '0');
				audioChannelConfigScheme = 'tag:dolby.com,2014:dash:audio_channel_configuration:2011';
			} else {
				// Spec: ETSI TS 102 366 V1.4.1 Digital Audio Compression
				// (AC-3, Enhanced AC-3) I.1.2.
				audioChannelConfigValue = String(ec3ChannelMpegValue);
				audioChannelConfigScheme = 'urn:mpeg:mpegB:cicp:ChannelConfiguration';
			}
			this.addDescriptor(
				'AudioChannelConfiguration',
				audioChannelConfigScheme,
				audioChannelConfigValue,
			);
			// Dolby Digital Plus JOC descriptor. Spec: ETSI TS 103 420 v1.2.1
			// D.2.2.
			if (codecData?.ec3JocComplexity !== undefined && codecData.ec3JocComplexity !== 0) {
				const ec3JocComplexity = String(codecData.ec3JocComplexity);
				this.addDescriptor(
					'SupplementalProperty',
					'tag:dolby.com,2018:dash:EC3_ExtensionType:2018',
					'JOC',
				);
				this.addDescriptor(
					'SupplementalProperty',
					'tag:dolby.com,2018:dash:EC3_ExtensionComplexityIndex:2018',
					ec3JocComplexity,
				);
			}
			return;
		}

		if (codec.slice(0, 4) === AC4_CODEC) {
			const ac4ImsFlag = codecData?.ac4ImsFlag ?? false;
			const ac4ChannelMpegValue = codecData?.channelMpegValue;
			const NO_MAPPING = 0xFFFFFFFF;
			if (ac4ChannelMpegValue === undefined || ac4ChannelMpegValue === NO_MAPPING) {
				// AC-4 channel mask as 6 hex digits, padded — only the low 24
				// bits are meaningful per ETSI TS 103 190-2 V1.2.1 G.3.1.
				const mask = codecData?.channelMask ?? 0;
				audioChannelConfigValue = mask.toString(16).toUpperCase().padStart(6, '0');
				// Note: the channel-config scheme for EC-3 and AC-4 differ.
				// See https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/268
				audioChannelConfigScheme = 'tag:dolby.com,2015:dash:audio_channel_configuration:2015';
			} else {
				// Spec: ETSI TS 103 190-2 V1.2.1 G.3.2.
				audioChannelConfigValue = String(ac4ChannelMpegValue);
				audioChannelConfigScheme = 'urn:mpeg:mpegB:cicp:ChannelConfiguration';
			}
			this.addDescriptor(
				'AudioChannelConfiguration',
				audioChannelConfigScheme,
				audioChannelConfigValue,
			);
			if (ac4ImsFlag) {
				this.addDescriptor(
					'SupplementalProperty',
					'tag:dolby.com,2016:dash:virtualized_content:2016',
					'1',
				);
			}
			return;
		}

		if (codec === DTSC_CODEC || codec === DTSE_CODEC) {
			audioChannelConfigValue = String(audioInfo.numChannels ?? 0);
			audioChannelConfigScheme = 'tag:dts.com,2014:dash:audio_channel_configuration:2012';
		} else if (codec === DTSX_CODEC) {
			const mask = codecData?.channelMask ?? 0;
			// 8-digit hex padded.
			audioChannelConfigValue = mask.toString(16).toUpperCase().padStart(8, '0');
			audioChannelConfigScheme = 'tag:dts.com,2018:uhd:audio_channel_configuration';
		} else {
			audioChannelConfigValue = String(audioInfo.numChannels ?? 0);
			audioChannelConfigScheme = 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011';
		}

		this.addDescriptor(
			'AudioChannelConfiguration',
			audioChannelConfigScheme,
			audioChannelConfigValue,
		);
	}

	/** @internal */
	private addAudioSamplingRateInfo(audioInfo: AudioInfo): void {
		if (audioInfo.samplingFrequency === undefined) {
			return;
		}
		this.setIntegerAttribute('audioSamplingRate', audioInfo.samplingFrequency);
	}
}
