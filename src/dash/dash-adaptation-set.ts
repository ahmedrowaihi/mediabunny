/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2017 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/adaptation_set.{h,cc}
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import type { ContentProtectionElement } from './dash-content-protection';
import type { MediaInfo, ProtectedContent, VideoInfo } from './dash-media-info';
import {
	getBaseCodec,
	removeDuplicateAttributes,
	updateContentProtectionPsshHelper,
} from './dash-mpd-utils';
import {
	Representation,
	type RepresentationStateChangeListener,
	SuppressFlag,
} from './dash-representation';
import { AdaptationSetXmlNode } from './dash-representation-xml-node';
import type { MpdOptions } from './dash-types';

/**
 * Mutable counter used by AdaptationSet to assign Representation IDs in
 * insertion order. Equivalent to shaka's `representation_counter_` pointer:
 * shared across AdaptationSets within the same Period so IDs are unique.
 *
 * @group DASH
 * @public
 */
export type RepresentationCounter = {
	/** Next ID to assign — incremented after each Representation creation. */
	value: number;
};

/**
 * Role values for the `<Role>` element with
 * `schemeIdUri="urn:mpeg:dash:role:2011"`. See ISO/IEC 23009-1:2012 §5.8.5.5.
 * Mirrors shaka's `AdaptationSet::Role` enum.
 *
 * @group DASH
 * @public
 */
export type AdaptationSetRole =
	| 'unknown'
	| 'caption'
	| 'subtitle'
	| 'main'
	| 'alternate'
	| 'supplementary'
	| 'commentary'
	| 'dub'
	| 'description'
	| 'sign'
	| 'metadata'
	| 'enhancedAudioIntelligibility'
	| 'emergency'
	| 'forcedSubtitle'
	| 'easyreader'
	| 'karaoke';

/**
 * Returns the standard Role value text for the given role. Mirrors shaka's
 * `RoleToText` helper.
 *
 * @internal
 */
const roleToText = (role: AdaptationSetRole): string => {
	switch (role) {
		case 'caption':
			return 'caption';
		case 'subtitle':
			return 'subtitle';
		case 'main':
			return 'main';
		case 'alternate':
			return 'alternate';
		case 'supplementary':
			return 'supplementary';
		case 'commentary':
			return 'commentary';
		case 'dub':
			return 'dub';
		case 'description':
			return 'description';
		case 'sign':
			return 'sign';
		case 'metadata':
			return 'metadata';
		case 'enhancedAudioIntelligibility':
			return 'enhanced-audio-intelligibility';
		case 'emergency':
			return 'emergency';
		case 'forcedSubtitle':
			return 'forced-subtitle';
		case 'easyreader':
			return 'easyreader';
		case 'karaoke':
			return 'karaoke';
		default:
			return 'unknown';
	}
};

/**
 * Convert a TextInfo type to its corresponding role. Mirrors shaka's
 * `MediaInfoTextTypeToRole`.
 *
 * @internal
 */
const textTypeToRole = (type: 'unknown' | 'caption' | 'subtitle' | undefined): AdaptationSetRole => {
	switch (type) {
		case 'caption':
			return 'caption';
		case 'subtitle':
			return 'subtitle';
		default:
			return 'subtitle';
	}
};

/**
 * Returns the picture aspect ratio string (`"16:9"`, `"4:3"`, etc.) by
 * searching small denominators for the closest fit to
 * `(pixelWidth × width) / (pixelHeight × height)`. Mirrors shaka's
 * `GetPictureAspectRatio`.
 *
 * @internal
 */
const getPictureAspectRatio = (
	width: number,
	height: number,
	pixelWidth: number,
	pixelHeight: number,
): string => {
	const scaledWidth = pixelWidth * width;
	const scaledHeight = pixelHeight * height;
	const par = scaledWidth / scaledHeight;

	const LARGEST_POSSIBLE_PAR_Y = 19;

	let parNum = 0;
	let parDen = 0;
	let minError = 1.0;
	for (let den = 1; den <= LARGEST_POSSIBLE_PAR_Y; den++) {
		const num = Math.floor(par * den + 0.5);
		const error = Math.abs(par - num / den);
		if (error < minError) {
			minError = error;
			parNum = num;
			parDen = den;
			if (error === 0) {
				break;
			}
		}
	}
	return `${parNum}:${parDen}`;
};

/**
 * Mutates the picture-aspect-ratio set with the entry derived from
 * `videoInfo`. Mirrors shaka's `AddPictureAspectRatio`. When the set already
 * has more than one entry, no further work is done. When the videoInfo is
 * missing required fields, the set gets two bogus entries so the @par
 * attribute is excluded.
 *
 * @internal
 */
const addPictureAspectRatio = (videoInfo: VideoInfo, pictureAspectRatio: Set<string>): void => {
	if (pictureAspectRatio.size > 1) {
		return;
	}
	const width = videoInfo.width ?? 0;
	const height = videoInfo.height ?? 0;
	const pixelWidth = videoInfo.pixelWidth ?? 0;
	const pixelHeight = videoInfo.pixelHeight ?? 0;
	if (width === 0 || height === 0 || pixelWidth === 0 || pixelHeight === 0) {
		// Without SAR on every Representation we cannot calculate @par. Two
		// bogus entries ensure further calls bail early.
		pictureAspectRatio.add('bogus');
		pictureAspectRatio.add('entries');
		return;
	}
	pictureAspectRatio.add(getPictureAspectRatio(width, height, pixelWidth, pixelHeight));
};

/**
 * Internal segment-alignment status. Mirrors shaka's
 * `AdaptationSet::SegmentAligmentStatus` enum (note shaka's typo preserved
 * intentionally for reference).
 *
 * @internal
 */
type SegmentAlignmentStatus = 'unknown' | 'true' | 'false';

/**
 * Compare two `ProtectedContent` blocks for equality. Mirrors shaka's
 * `ProtectedContentEq` (which serializes proto messages to compare). Here we
 * compare structural shape: the set of UUIDs and PSSHs is enough for the
 * AdaptationSet matching logic shaka actually uses.
 *
 * @internal
 */
const protectedContentEq = (a: ProtectedContent, b: ProtectedContent): boolean => {
	if (JSON.stringify(a.defaultKeyId ?? null) !== JSON.stringify(b.defaultKeyId ?? null)) {
		return false;
	}
	if ((a.protectionScheme ?? 'cenc') !== (b.protectionScheme ?? 'cenc')) {
		return false;
	}
	if ((a.includeMsprPro ?? true) !== (b.includeMsprPro ?? true)) {
		return false;
	}
	const aEntries = a.contentProtectionEntry ?? [];
	const bEntries = b.contentProtectionEntry ?? [];
	if (aEntries.length !== bEntries.length) {
		return false;
	}
	for (let i = 0; i < aEntries.length; i++) {
		const aE = aEntries[i]!;
		const bE = bEntries[i]!;
		if (aE.uuid !== bE.uuid || aE.nameVersion !== bE.nameVersion) {
			return false;
		}
		const aP = aE.pssh ?? new Uint8Array();
		const bP = bE.pssh ?? new Uint8Array();
		if (aP.length !== bP.length) {
			return false;
		}
		for (let j = 0; j < aP.length; j++) {
			if (aP[j] !== bP[j]) {
				return false;
			}
		}
	}
	return true;
};

/**
 * Returns the set of DRM UUIDs present on `protectedContent`. Used by
 * {@link AdaptationSet.switchableAdaptationSet} to determine if two
 * AdaptationSets are switchable. Mirrors shaka's `GetUUIDs` free function.
 *
 * @internal
 */
const getUUIDs = (protectedContent: ProtectedContent): Set<string> => {
	const uuids = new Set<string>();
	for (const entry of protectedContent.contentProtectionEntry ?? []) {
		if (entry.uuid !== undefined) {
			uuids.add(entry.uuid);
		}
	}
	return uuids;
};

/**
 * `<AdaptationSet>` orchestrator. Owns a list of {@link Representation}s,
 * computes derived attributes (width, height, frame rate, picture aspect
 * ratio, segment alignment), and emits the `<AdaptationSet>` element.
 *
 * Mirrors shaka-packager's `AdaptationSet` class. Construct via
 * `Period.addAdaptationSet()` (Phase 3.3) — direct instantiation requires
 * supplying the shared {@link RepresentationCounter}.
 *
 * @group DASH
 * @public
 */
export class AdaptationSet {
	/** @internal */
	private readonly contentProtectionElements: ContentProtectionElement[] = [];
	/** @internal */
	private readonly representationMap = new Map<number, Representation>();

	/** @internal */
	private readonly representationCounter: RepresentationCounter;
	/** @internal */
	private idValue: number | undefined;
	/** @internal */
	private readonly languageValue: string;
	/** @internal */
	private readonly mpdOptions: MpdOptions;

	/** @internal */
	private readonly switchableAdaptationSets: AdaptationSet[] = [];

	/** @internal */
	private readonly videoWidths = new Set<number>();
	/** @internal */
	private readonly videoHeights = new Set<number>();
	/** @internal */
	private readonly videoFrameRates = new Map<number, string>();

	/** @internal */
	private contentTypeValue = '';
	/** @internal */
	private codecValue = '';
	/** @internal */
	private readonly pictureAspectRatio = new Set<string>();

	/** @internal */
	private readonly accessibilities: { scheme: string; value: string }[] = [];
	/** @internal */
	private readonly rolesValue = new Set<AdaptationSetRole>();

	/** @internal */
	private segmentsAligned: SegmentAlignmentStatus = 'unknown';
	/** @internal */
	private forceSetSegmentAlignmentValue = false;

	/** @internal */
	private subsegmentStartWithSAP = 0;
	/** @internal */
	private startWithSAP = 0;

	/** @internal */
	private readonly representationSegmentStartTimes = new Map<number, number[]>();

	/** @internal */
	private readonly trickPlayReferences: AdaptationSet[] = [];

	/** @internal */
	private matrixCoefficientsValue = 0;
	/** @internal */
	private colorPrimariesValue = 0;
	/** @internal */
	private transferCharacteristicsValue = 0;

	/** @internal */
	private indexValue: number | undefined;
	/** @internal */
	private label = '';

	/** @internal */
	private protectedContentValue: ProtectedContent | null = null;

	constructor(
		language: string,
		mpdOptions: MpdOptions,
		representationCounter: RepresentationCounter,
	) {
		this.languageValue = language;
		this.mpdOptions = mpdOptions;
		this.representationCounter = representationCounter;
	}

	/**
	 * Create a Representation from the supplied MediaInfo. Returns `null`
	 * when `Representation.init()` fails. Mirrors shaka's `AddRepresentation`.
	 */
	addRepresentation(mediaInfo: MediaInfo): Representation | null {
		const representationId = mediaInfo.index !== undefined
			? mediaInfo.index
			: this.representationCounter.value++;

		const listener: RepresentationStateChangeListener = {
			onNewSegmentForRepresentation: (startTime) => {
				this.onNewSegmentForRepresentation(representationId, startTime);
			},
			onSetFrameRateForRepresentation: (frameDuration, timeScale) => {
				this.onSetFrameRateForRepresentation(representationId, frameDuration, timeScale);
			},
		};
		const representation = new Representation(mediaInfo, this.mpdOptions, representationId, listener);
		if (!representation.init()) {
			return null;
		}
		this.updateFromMediaInfo(mediaInfo);
		this.representationMap.set(representation.id(), representation);
		return representation;
	}

	/**
	 * Append a ContentProtection descriptor at AdaptationSet level. Mirrors
	 * shaka's `AddContentProtectionElement`. Duplicates between the
	 * top-level and `additionalAttributes` are stripped on insertion.
	 */
	addContentProtectionElement(element: ContentProtectionElement): void {
		this.contentProtectionElements.push(element);
		removeDuplicateAttributes(this.contentProtectionElements[this.contentProtectionElements.length - 1]!);
	}

	/**
	 * Update the `<cenc:pssh>` for `drmUuid`'s `<ContentProtection>` at
	 * AdaptationSet level. Mirrors shaka's `UpdateContentProtectionPssh`.
	 * Note: as in shaka, this REMOVES the existing PSSH (not updates it).
	 */
	updateContentProtectionPssh(drmUuid: string, pssh: Uint8Array): void {
		updateContentProtectionPsshHelper(drmUuid, pssh, this.contentProtectionElements);
	}

	/**
	 * Add an Accessibility element. Mirrors shaka's `AddAccessibility`.
	 */
	addAccessibility(scheme: string, value: string): void {
		this.accessibilities.push({ scheme, value });
	}

	/**
	 * Add a Role element. Mirrors shaka's `AddRole`.
	 */
	addRole(role: AdaptationSetRole): void {
		this.rolesValue.add(role);
	}

	/**
	 * Render the `<AdaptationSet>` element with its child `<Representation>`s.
	 * Returns `null` when any sub-step fails. Mirrors shaka's `GetXml`.
	 */
	getXml(): AdaptationSetXmlNode | null {
		const node = new AdaptationSetXmlNode();

		let suppressRepresentationWidth = false;
		let suppressRepresentationHeight = false;
		let suppressRepresentationFrameRate = false;

		if (this.idValue !== undefined && !node.setId(this.idValue)) {
			return null;
		}
		if (!node.setStringAttribute('contentType', this.contentTypeValue)) {
			return null;
		}
		if (this.languageValue.length > 0 && this.languageValue !== 'und'
			&& !node.setStringAttribute('lang', this.languageValue)) {
			return null;
		}

		// std::set is ordered ascending; mirror with sorted arrays so we pick
		// the same min/max as shaka.
		const widths = [...this.videoWidths].sort((a, b) => a - b);
		const heights = [...this.videoHeights].sort((a, b) => a - b);

		if (widths.length === 1) {
			suppressRepresentationWidth = true;
			if (!node.setIntegerAttribute('width', widths[0]!)) {
				return null;
			}
		} else if (widths.length > 1) {
			if (!node.setIntegerAttribute('maxWidth', widths[widths.length - 1]!)) {
				return null;
			}
		}

		if (heights.length === 1) {
			suppressRepresentationHeight = true;
			if (!node.setIntegerAttribute('height', heights[0]!)) {
				return null;
			}
		} else if (heights.length > 1) {
			if (!node.setIntegerAttribute('maxHeight', heights[heights.length - 1]!)) {
				return null;
			}
		}

		if (this.subsegmentStartWithSAP) {
			if (!node.setIntegerAttribute('subsegmentStartsWithSAP', this.subsegmentStartWithSAP)) {
				return null;
			}
		} else if (this.startWithSAP) {
			if (!node.setIntegerAttribute('startWithSAP', this.startWithSAP)) {
				return null;
			}
		}

		// std::map<double, ...> is ordered by key. We replicate by sorting.
		const frameRateKeys = [...this.videoFrameRates.keys()].sort((a, b) => a - b);
		if (frameRateKeys.length === 1) {
			suppressRepresentationFrameRate = true;
			if (!node.setStringAttribute('frameRate', this.videoFrameRates.get(frameRateKeys[0]!)!)) {
				return null;
			}
		} else if (frameRateKeys.length > 1) {
			if (!node.setStringAttribute(
				'maxFrameRate',
				this.videoFrameRates.get(frameRateKeys[frameRateKeys.length - 1]!)!,
			)) {
				return null;
			}
		}

		if (this.isVideo() && this.matrixCoefficientsValue > 0
			&& !node.addSupplementalProperty(
				'urn:mpeg:mpegB:cicp:MatrixCoefficients',
				String(this.matrixCoefficientsValue),
			)) {
			return null;
		}
		if (this.isVideo() && this.colorPrimariesValue > 0
			&& !node.addSupplementalProperty(
				'urn:mpeg:mpegB:cicp:ColourPrimaries',
				String(this.colorPrimariesValue),
			)) {
			return null;
		}
		if (this.isVideo() && this.transferCharacteristicsValue > 0
			&& !node.addSupplementalProperty(
				'urn:mpeg:mpegB:cicp:TransferCharacteristics',
				String(this.transferCharacteristicsValue),
			)) {
			return null;
		}

		// Note: must be checked before checking segments_aligned_ (below). So
		// that segments_aligned_ is set before checking below.
		if (this.mpdOptions.mpdType === 'static') {
			this.checkStaticSegmentAlignment();
		}

		if (this.segmentsAligned === 'true') {
			const attrName = this.mpdOptions.dashProfile === 'onDemand'
				? 'subsegmentAlignment'
				: 'segmentAlignment';
			if (!node.setStringAttribute(attrName, 'true')) {
				return null;
			}
		}

		if (this.pictureAspectRatio.size === 1
			&& !node.setStringAttribute('par', [...this.pictureAspectRatio][0]!)) {
			return null;
		}

		if (!node.addContentProtectionElements(this.contentProtectionElements)) {
			return null;
		}

		const trickPlayReferenceIds: string[] = [];
		for (const tp of this.trickPlayReferences) {
			if (tp.idValue === undefined) {
				throw new Error('Trick play reference AdaptationSet has no id');
			}
			trickPlayReferenceIds.push(String(tp.idValue));
		}
		if (trickPlayReferenceIds.length > 0
			&& !node.addEssentialProperty(
				'http://dashif.org/guidelines/trickmode',
				trickPlayReferenceIds.join(' '),
			)) {
			return null;
		}

		const switchingIds: string[] = [];
		for (const s of this.switchableAdaptationSets) {
			if (s.idValue === undefined) {
				throw new Error('Switchable AdaptationSet has no id');
			}
			switchingIds.push(String(s.idValue));
		}
		if (switchingIds.length > 0
			&& !node.addSupplementalProperty(
				'urn:mpeg:dash:adaptation-set-switching:2016',
				switchingIds.join(','),
			)) {
			return null;
		}

		for (const accessibility of this.accessibilities) {
			if (!node.addAccessibilityElement(accessibility.scheme, accessibility.value)) {
				return null;
			}
		}

		// std::set<Role> is ordered by enum integer value; mirror by iterating
		// in the original enum-declaration order.
		const orderedRoles: AdaptationSetRole[] = [
			'unknown', 'caption', 'subtitle', 'main', 'alternate', 'supplementary',
			'commentary', 'dub', 'description', 'sign', 'metadata',
			'enhancedAudioIntelligibility', 'emergency', 'forcedSubtitle',
			'easyreader', 'karaoke',
		];
		for (const role of orderedRoles) {
			if (this.rolesValue.has(role)) {
				if (!node.addRoleElement('urn:mpeg:dash:role:2011', roleToText(role))) {
					return null;
				}
			}
		}

		if (this.label.length > 0 && !node.addLabelElement(this.label)) {
			return null;
		}

		// std::map iterates by key (the Representation id). Mirror.
		const sortedRepIds = [...this.representationMap.keys()].sort((a, b) => a - b);
		for (const repId of sortedRepIds) {
			const representation = this.representationMap.get(repId)!;
			if (suppressRepresentationWidth) {
				representation.suppressOnce(SuppressFlag.WIDTH);
			}
			if (suppressRepresentationHeight) {
				representation.suppressOnce(SuppressFlag.HEIGHT);
			}
			if (suppressRepresentationFrameRate) {
				representation.suppressOnce(SuppressFlag.FRAME_RATE);
			}
			const child = representation.getXml();
			if (!child || !node.addChild(child)) {
				return null;
			}
		}

		return node;
	}

	/**
	 * Force the (sub)segmentAlignment field. Mirrors shaka's
	 * `ForceSetSegmentAlignment`.
	 */
	forceSetSegmentAlignment(segmentAlignment: boolean): void {
		this.segmentsAligned = segmentAlignment ? 'true' : 'false';
		this.forceSetSegmentAlignmentValue = true;
	}

	/**
	 * Add the AdaptationSet that this AdaptationSet can switch to. Mirrors
	 * shaka's `AddAdaptationSetSwitching`.
	 */
	addAdaptationSetSwitching(adaptationSet: AdaptationSet): void {
		this.switchableAdaptationSets.push(adaptationSet);
	}

	/**
	 * Force the `subsegmentStartsWithSAP` value. Mirrors shaka's
	 * `ForceSubsegmentStartswithSAP`.
	 */
	forceSubsegmentStartsWithSAP(sapValue: number): void {
		this.subsegmentStartWithSAP = sapValue;
	}

	/**
	 * Force the `startWithSAP` value. Mirrors shaka's `ForceStartwithSAP`.
	 */
	forceStartWithSAP(sapValue: number): void {
		this.startWithSAP = sapValue;
	}

	/** Returns `true` when `id` is set. */
	hasId(): boolean {
		return this.idValue !== undefined;
	}

	/**
	 * Returns the index for sorting AdaptationSets — `index_` if set,
	 * otherwise the AdaptationSet's `id`. Mirrors shaka's `SortIndex`.
	 */
	sortIndex(): number | undefined {
		return this.indexValue !== undefined ? this.indexValue : this.idValue;
	}

	/** Returns the AdaptationSet `@id`. Throws when unset (mirroring shaka's `value()`). */
	id(): number {
		if (this.idValue === undefined) {
			throw new Error('AdaptationSet id has not been set');
		}
		return this.idValue;
	}

	/** Set AdaptationSet `@id`. */
	setId(id: number): void {
		this.idValue = id;
	}

	/**
	 * Notifies that a new (sub)segment was added to the Representation with
	 * `representationId`. Called automatically by Representations created via
	 * {@link addRepresentation}. Mirrors shaka's
	 * `OnNewSegmentForRepresentation`.
	 */
	/**
	 * Notifies that a new (sub)segment was added to the Representation with
	 * `representationId`. Mirrors shaka's `OnNewSegmentForRepresentation` —
	 * shaka's signature also takes a `duration` argument that is unused
	 * inside both the public method and `CheckDynamicSegmentAlignment`
	 * (marked with shaka's anonymous-parameter idiom); we drop it from the
	 * TS port to keep the API honest. The
	 * {@link RepresentationStateChangeListener} interface still carries
	 * `duration` since Representations supply it.
	 */
	onNewSegmentForRepresentation(representationId: number, startTime: number): void {
		if (this.mpdOptions.mpdType === 'dynamic') {
			this.checkDynamicSegmentAlignment(representationId, startTime);
		} else {
			const list = this.representationSegmentStartTimes.get(representationId) ?? [];
			list.push(startTime);
			this.representationSegmentStartTimes.set(representationId, list);
		}
	}

	/**
	 * Notifies that the sample duration was set on the Representation with
	 * `representationId`. Mirrors shaka's `OnSetFrameRateForRepresentation`.
	 */
	onSetFrameRateForRepresentation(_representationId: number, frameDuration: number, timeScale: number): void {
		this.recordFrameRate(frameDuration, timeScale);
	}

	/**
	 * Add the AdaptationSet that this trick-play AdaptationSet belongs to.
	 * Mirrors shaka's `AddTrickPlayReference`.
	 */
	addTrickPlayReference(adaptationSet: AdaptationSet): void {
		this.trickPlayReferences.push(adaptationSet);
	}

	/** Returns the list of {@link Representation}s in this AdaptationSet (insertion order). */
	getRepresentations(): readonly Representation[] {
		const sortedRepIds = [...this.representationMap.keys()].sort((a, b) => a - b);
		return sortedRepIds.map(id => this.representationMap.get(id)!);
	}

	/** Returns `true` when this AdaptationSet contains video Representations. */
	isVideo(): boolean {
		return this.contentTypeValue === 'video';
	}

	/** Returns the AdaptationSet `@codec`. */
	codec(): string {
		return this.codecValue;
	}

	/** Set the AdaptationSet `@codec`. Mirrors shaka's `set_codec`. */
	setCodec(codec: string): void {
		this.codecValue = codec;
	}

	/** Returns the matrix-coefficients value (0 when unset). */
	matrixCoefficients(): number {
		return this.matrixCoefficientsValue;
	}

	/** Set matrix-coefficients (`urn:mpeg:mpegB:cicp:MatrixCoefficients`). */
	setMatrixCoefficients(value: number): void {
		this.matrixCoefficientsValue = value;
	}

	/** Returns the colour-primaries value (0 when unset). */
	colorPrimaries(): number {
		return this.colorPrimariesValue;
	}

	/** Set colour-primaries (`urn:mpeg:mpegB:cicp:ColourPrimaries`). */
	setColorPrimaries(value: number): void {
		this.colorPrimariesValue = value;
	}

	/** Returns the transfer-characteristics value (0 when unset). */
	transferCharacteristics(): number {
		return this.transferCharacteristicsValue;
	}

	/** Set transfer-characteristics (`urn:mpeg:mpegB:cicp:TransferCharacteristics`). */
	setTransferCharacteristics(value: number): void {
		this.transferCharacteristicsValue = value;
	}

	/** Returns the protected-content descriptor (or `null` when unset). */
	protectedContent(): ProtectedContent | null {
		return this.protectedContentValue;
	}

	/**
	 * Set the protected content from the supplied media info. Throws if a
	 * protected-content descriptor is already set on this AdaptationSet
	 * (matching shaka's `DCHECK(!protected_content_)` precondition).
	 *
	 * Mirrors shaka's `set_protected_content`.
	 */
	setProtectedContent(mediaInfo: MediaInfo): void {
		if (this.protectedContentValue !== null) {
			throw new Error('AdaptationSet protectedContent is already set');
		}
		if (mediaInfo.protectedContent === undefined) {
			throw new Error('MediaInfo has no protectedContent to set on AdaptationSet');
		}
		// Deep-ish copy: structuredClone preserves Uint8Array contents.
		this.protectedContentValue = structuredClone(mediaInfo.protectedContent);
	}

	/**
	 * Returns `true` when this AdaptationSet's codec + protected-content
	 * matches `mediaInfo`. Mirrors shaka's `MatchAdaptationSet`.
	 */
	matchAdaptationSet(mediaInfo: MediaInfo, contentProtectionInAdaptationSet: boolean): boolean {
		if (this.codecValue !== getBaseCodec(mediaInfo)) {
			return false;
		}
		if (!contentProtectionInAdaptationSet) {
			return true;
		}
		if (this.protectedContentValue === null) {
			return mediaInfo.protectedContent === undefined;
		}
		if (mediaInfo.protectedContent === undefined) {
			return false;
		}
		return protectedContentEq(this.protectedContentValue, mediaInfo.protectedContent);
	}

	/**
	 * Returns `true` when both AdaptationSets are switchable: either both
	 * unprotected, or both protected with the same set of DRM UUIDs. Mirrors
	 * shaka's `SwitchableAdaptationSet`.
	 */
	switchableAdaptationSet(other: AdaptationSet): boolean {
		if (this.protectedContentValue === null && other.protectedContentValue === null) {
			return true;
		}
		if (this.protectedContentValue !== null && other.protectedContentValue !== null) {
			const a = getUUIDs(this.protectedContentValue);
			const b = getUUIDs(other.protectedContentValue);
			if (a.size !== b.size) {
				return false;
			}
			for (const uuid of a) {
				if (!b.has(uuid)) {
					return false;
				}
			}
			return true;
		}
		return false;
	}

	/** @internal */
	private updateFromMediaInfo(mediaInfo: MediaInfo): void {
		if (mediaInfo.videoInfo) {
			const videoInfo = mediaInfo.videoInfo;
			if (videoInfo.width !== undefined) {
				this.videoWidths.add(videoInfo.width);
			}
			if (videoInfo.height !== undefined) {
				this.videoHeights.add(videoInfo.height);
			}
			if (videoInfo.timeScale !== undefined && videoInfo.frameDuration !== undefined) {
				this.recordFrameRate(videoInfo.frameDuration, videoInfo.timeScale);
			}
			addPictureAspectRatio(videoInfo, this.pictureAspectRatio);
		}

		if (mediaInfo.index !== undefined) {
			if (this.indexValue !== undefined) {
				this.indexValue = Math.min(this.indexValue, mediaInfo.index);
			} else {
				this.indexValue = mediaInfo.index;
			}
		}

		if (mediaInfo.dashLabel !== undefined) {
			this.label = mediaInfo.dashLabel;
		}

		if (mediaInfo.videoInfo) {
			this.contentTypeValue = 'video';
		} else if (mediaInfo.audioInfo) {
			this.contentTypeValue = 'audio';
		} else if (mediaInfo.textInfo) {
			this.contentTypeValue = 'text';
			if (mediaInfo.textInfo.type !== undefined && mediaInfo.textInfo.type !== 'unknown') {
				this.rolesValue.add(textTypeToRole(mediaInfo.textInfo.type));
			}
		}
	}

	/** @internal */
	private checkDynamicSegmentAlignment(representationId: number, startTime: number): void {
		if (this.segmentsAligned === 'false' || this.forceSetSegmentAlignmentValue) {
			return;
		}

		const list = this.representationSegmentStartTimes.get(representationId) ?? [];
		list.push(startTime);
		this.representationSegmentStartTimes.set(representationId, list);

		if (this.representationSegmentStartTimes.size !== this.representationMap.size) {
			return;
		}

		const expectedStartTime = list[0]!;
		for (const startTimes of this.representationSegmentStartTimes.values()) {
			if (startTimes.length === 0) {
				return;
			}
			if (expectedStartTime !== startTimes[0]!) {
				this.segmentsAligned = 'false';
				this.representationSegmentStartTimes.clear();
				return;
			}
		}
		this.segmentsAligned = 'true';

		for (const startTimes of this.representationSegmentStartTimes.values()) {
			startTimes.shift();
		}
	}

	/** @internal */
	private checkStaticSegmentAlignment(): void {
		if (this.segmentsAligned === 'false' || this.forceSetSegmentAlignmentValue) {
			return;
		}
		if (this.representationSegmentStartTimes.size === 0) {
			return;
		}
		if (this.representationSegmentStartTimes.size === 1) {
			this.segmentsAligned = 'true';
			return;
		}

		const sortedRepIds = [...this.representationSegmentStartTimes.keys()].sort((a, b) => a - b);
		const expectedTimeline = this.representationSegmentStartTimes.get(sortedRepIds[0]!)!;

		let allSegmentTimelinesSameLength = true;
		for (let i = 1; i < sortedRepIds.length; i++) {
			const otherTimeline = this.representationSegmentStartTimes.get(sortedRepIds[i]!)!;
			if (expectedTimeline.length !== otherTimeline.length) {
				allSegmentTimelinesSameLength = false;
			}
			const shorter = expectedTimeline.length <= otherTimeline.length ? expectedTimeline : otherTimeline;
			const longer = shorter === expectedTimeline ? otherTimeline : expectedTimeline;
			for (let j = 0; j < shorter.length; j++) {
				if (shorter[j] !== longer[j]) {
					this.segmentsAligned = 'false';
					this.representationSegmentStartTimes.clear();
					return;
				}
			}
		}

		// TODO upstream (rkuroiwa): also check durations to disambiguate
		// e.g. (a) 3 4 5 vs (b) 3 4 5 6 — same prefix but third segment
		// duration may differ.
		if (!allSegmentTimelinesSameLength) {
			this.segmentsAligned = 'unknown';
			return;
		}
		this.segmentsAligned = 'true';
	}

	/** @internal */
	private recordFrameRate(frameDuration: number, timeScale: number): void {
		if (frameDuration === 0) {
			return;
		}
		this.videoFrameRates.set(timeScale / frameDuration, `${timeScale}/${frameDuration}`);
	}
}
