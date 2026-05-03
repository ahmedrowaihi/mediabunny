/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2017 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/period.{h,cc}
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import {
	AdaptationSet,
	type AdaptationSetRole,
	type RepresentationCounter,
} from './dash-adaptation-set';
import type { MediaInfo } from './dash-media-info';
import {
	addContentProtectionElements,
	getAdaptationSetKey,
	getBaseCodec,
	getLanguage,
	secondsToXmlDuration,
	TRANSFER_FUNCTION_PQ,
} from './dash-mpd-utils';
import type { MpdOptions } from './dash-types';
import { XmlNode } from './dash-xml-node';

/**
 * Returns the default audio language, falling back to `default_language`.
 * Mirrors shaka's `GetDefaultAudioLanguage` free helper.
 *
 * @internal
 */
const getDefaultAudioLanguage = (mpdOptions: MpdOptions): string => {
	return mpdOptions.mpdParams.defaultLanguage;
};

/**
 * Returns the default text language — `default_text_language` if set, else
 * `default_language`. Mirrors shaka's `GetDefaultTextLanguage` free helper.
 *
 * @internal
 */
const getDefaultTextLanguage = (mpdOptions: MpdOptions): string => {
	return mpdOptions.mpdParams.defaultTextLanguage.length > 0
		? mpdOptions.mpdParams.defaultTextLanguage
		: mpdOptions.mpdParams.defaultLanguage;
};

/**
 * Convert a DASH role string (as it appears in `dashRoles`) to its enum
 * value. Mirrors shaka's `RoleFromString` free helper. Returns `'unknown'`
 * for unrecognized strings.
 *
 * @internal
 */
const roleFromString = (roleStr: string): AdaptationSetRole => {
	switch (roleStr) {
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
		case 'forced-subtitle':
			return 'forcedSubtitle';
		case 'karaoke':
			return 'karaoke';
		case 'sign':
			return 'sign';
		case 'metadata':
			return 'metadata';
		case 'enhanced-audio-intelligibility':
			return 'enhancedAudioIntelligibility';
		case 'emergency':
			return 'emergency';
		case 'easyreader':
			return 'easyreader';
		case 'description':
			return 'description';
		default:
			return 'unknown';
	}
};

/**
 * `<Period>` orchestrator. Buckets {@link AdaptationSet}s by content
 * grouping key and emits the `<Period>` element with all child
 * AdaptationSets.
 *
 * Mirrors shaka-packager's `Period` class. Construct via
 * `MpdBuilder.addPeriod()` (Phase 4) — direct instantiation requires
 * supplying the shared {@link RepresentationCounter}.
 *
 * @group DASH
 * @public
 */
export class Period {
	/** @internal */
	private readonly idValue: number;
	/** @internal */
	private readonly startTimeInSeconds: number;
	/** @internal */
	private durationSecondsValue = 0;
	/** @internal */
	private readonly mpdOptions: MpdOptions;
	/** @internal */
	private readonly representationCounter: RepresentationCounter;
	/** @internal */
	private readonly adaptationSets: AdaptationSet[] = [];
	/**
	 * AdaptationSets grouped by AdaptationSet key (see
	 * {@link getAdaptationSetKey}). Sets in the same bucket share parameters
	 * except for ContentProtection — useful only when the
	 * `content_protection_in_adaptation_set` mode is enabled.
	 * @internal
	 */
	private readonly adaptationSetListMap = new Map<string, AdaptationSet[]>();
	/**
	 * Trick-play AdaptationSets that haven't yet been matched to their
	 * reference (main) AdaptationSet, grouped by key.
	 * @internal
	 */
	private readonly trickplayCacheMap = new Map<string, AdaptationSet[]>();

	constructor(
		periodId: number,
		startTimeInSeconds: number,
		mpdOptions: MpdOptions,
		representationCounter: RepresentationCounter,
	) {
		this.idValue = periodId;
		this.startTimeInSeconds = startTimeInSeconds;
		this.mpdOptions = mpdOptions;
		this.representationCounter = representationCounter;
	}

	/**
	 * Find or create an AdaptationSet matching the supplied media info.
	 * Mirrors shaka's `GetOrCreateAdaptationSet`.
	 *
	 * @param mediaInfo - track-level media info
	 * @param contentProtectionInAdaptationSet - when `true`, ContentProtection
	 *   descriptors are placed at AdaptationSet level (and therefore must
	 *   match for two MediaInfos to share an AdaptationSet)
	 * @returns the matching AdaptationSet, or `null` if attribute setup failed
	 */
	getOrCreateAdaptationSet(
		mediaInfo: MediaInfo,
		contentProtectionInAdaptationSet: boolean,
	): AdaptationSet | null {
		// Set duration if it is not set. It may be updated later from duration
		// calculated from segments.
		if (this.durationSecondsValue === 0 && mediaInfo.mediaDurationSeconds !== undefined) {
			this.durationSecondsValue = mediaInfo.mediaDurationSeconds;
		}

		const key = getAdaptationSetKey(mediaInfo, this.mpdOptions.mpdParams.allowCodecSwitching);
		const adaptationSetsInBucket = this.adaptationSetListMap.get(key) ?? [];

		for (const set of adaptationSetsInBucket) {
			if (set.matchAdaptationSet(mediaInfo, contentProtectionInAdaptationSet)) {
				return set;
			}
		}

		// None of the adaptation sets match — create a new one.
		const language = getLanguage(mediaInfo);
		const newSet = this.newAdaptationSet(language);
		if (!this.setNewAdaptationSetAttributes(
			language,
			mediaInfo,
			adaptationSetsInBucket,
			contentProtectionInAdaptationSet,
			newSet,
		)) {
			return null;
		}

		// Cross-link with switchable peers.
		for (const existing of adaptationSetsInBucket) {
			if (existing.switchableAdaptationSet(newSet)) {
				existing.addAdaptationSetSwitching(newSet);
				newSet.addAdaptationSetSwitching(existing);
			}
		}

		adaptationSetsInBucket.push(newSet);
		this.adaptationSetListMap.set(key, adaptationSetsInBucket);
		this.adaptationSets.push(newSet);
		return newSet;
	}

	/**
	 * Render the `<Period>` element with all child AdaptationSets. Mirrors
	 * shaka's `GetXml`.
	 *
	 * @param outputPeriodDuration - emit `@duration` (true for VOD-style
	 *   single-period output) instead of `@start` (which is used for
	 *   dynamic-MPD multi-period)
	 */
	getXml(outputPeriodDuration: boolean): XmlNode | null {
		// Sort by AdaptationSet.sortIndex(), placing entries without an index
		// at the end (mirrors shaka's lambda).
		this.adaptationSets.sort((a, b) => {
			const ia = a.sortIndex();
			const ib = b.sortIndex();
			if (ia === undefined) {
				return 1;
			}
			if (ib === undefined) {
				return -1;
			}
			return ia - ib;
		});

		const period = new XmlNode('Period');

		// Required for 'dynamic' MPDs.
		if (!period.setId(this.idValue)) {
			return null;
		}

		// Required for LL-DASH MPDs.
		if (this.mpdOptions.mpdParams.lowLatencyDashMode) {
			const serviceDescription = new XmlNode('ServiceDescription');
			if (!serviceDescription.setIntegerAttribute('id', this.idValue)) {
				return null;
			}
			const latency = new XmlNode('Latency');
			const targetLatencyMs = Math.floor(this.mpdOptions.mpdParams.targetLatencySeconds * 1000);
			if (!latency.setIntegerAttribute('target', targetLatencyMs)) {
				return null;
			}
			if (!serviceDescription.addChild(latency)) {
				return null;
			}
			if (!period.addChild(serviceDescription)) {
				return null;
			}
		}

		// Assign IDs to AdaptationSets that don't have one yet. Important for
		// multi-period MPDs where AdaptationSets should have consistent IDs
		// across periods.
		let idx = 0;
		for (const set of this.adaptationSets) {
			if (!set.hasId()) {
				set.setId(idx++);
			}
		}

		for (const set of this.adaptationSets) {
			const child = set.getXml();
			if (!child || !period.addChild(child)) {
				return null;
			}
		}

		if (outputPeriodDuration) {
			if (!period.setStringAttribute('duration', secondsToXmlDuration(this.durationSecondsValue))) {
				return null;
			}
		} else if (this.mpdOptions.mpdType === 'dynamic') {
			if (!period.setStringAttribute('start', secondsToXmlDuration(this.startTimeInSeconds))) {
				return null;
			}
		}
		return period;
	}

	/** Returns the list of AdaptationSets in this Period (insertion order). */
	getAdaptationSets(): readonly AdaptationSet[] {
		return this.adaptationSets;
	}

	/** Returns the `Period@start` value in seconds. */
	startTimeSeconds(): number {
		return this.startTimeInSeconds;
	}

	/** Returns the `Period@duration` value in seconds. */
	durationSeconds(): number {
		return this.durationSecondsValue;
	}

	/** Set `Period@duration` in seconds. Mirrors shaka's `set_duration_seconds`. */
	setDurationSeconds(durationSeconds: number): void {
		this.durationSecondsValue = durationSeconds;
	}

	/** Returns the `Period@id`. */
	id(): number {
		return this.idValue;
	}

	/**
	 * Returns the trick-play cache (key → orphan trick-play AdaptationSets).
	 * Mirrors shaka's `trickplay_cache()` accessor — exposed for diagnostic
	 * and test purposes.
	 */
	trickplayCache(): ReadonlyMap<string, readonly AdaptationSet[]> {
		return this.trickplayCacheMap;
	}

	/**
	 * Factory for AdaptationSet construction. Mirrors shaka's
	 * `NewAdaptationSet` virtual method (used for mock injection in tests).
	 *
	 * @internal
	 */
	private newAdaptationSet(language: string): AdaptationSet {
		return new AdaptationSet(language, this.mpdOptions, this.representationCounter);
	}

	/**
	 * Apply per-MediaInfo attributes to a freshly created AdaptationSet.
	 * Mirrors shaka's `SetNewAdaptationSetAttributes` exactly: roles,
	 * accessibility, codec, video color metadata, trick-play matching,
	 * audio SAP forcing, text-track segment alignment forcing, and
	 * AdaptationSet-level ContentProtection emission.
	 *
	 * @internal
	 */
	private setNewAdaptationSetAttributes(
		language: string,
		mediaInfo: MediaInfo,
		adaptationSets: readonly AdaptationSet[],
		contentProtectionInAdaptationSet: boolean,
		newAdaptationSet: AdaptationSet,
	): boolean {
		// Roles from explicit `dashRoles`, or default-language → main.
		if (mediaInfo.dashRoles && mediaInfo.dashRoles.length > 0) {
			for (const roleStr of mediaInfo.dashRoles) {
				const role = roleFromString(roleStr);
				if (role === 'unknown') {
					return false;
				}
				newAdaptationSet.addRole(role);
			}
		} else if (language.length > 0) {
			const isMainRole = language === (mediaInfo.audioInfo
				? getDefaultAudioLanguage(this.mpdOptions)
				: getDefaultTextLanguage(this.mpdOptions));
			if (isMainRole) {
				newAdaptationSet.addRole('main');
			}
		}

		// Accessibility entries (`scheme=value` strings).
		for (const accessibility of mediaInfo.dashAccessibilities ?? []) {
			const eq = accessibility.indexOf('=');
			if (eq === -1) {
				return false;
			}
			newAdaptationSet.addAccessibility(accessibility.slice(0, eq), accessibility.slice(eq + 1));
		}

		const codec = getBaseCodec(mediaInfo);
		newAdaptationSet.setCodec(codec);

		if (mediaInfo.videoInfo) {
			// Because language is ignored for videos, this bucket holds all video
			// AdaptationSets — promote each to "main" once there's more than one.
			if (adaptationSets.length > 1) {
				newAdaptationSet.addRole('main');
			} else if (adaptationSets.length === 1) {
				adaptationSets[0]!.addRole('main');
				newAdaptationSet.addRole('main');
			}

			// Trick-play matching.
			if (mediaInfo.videoInfo.playbackRate !== undefined) {
				const trickPlayMatch = this.findMatchingAdaptationSetForTrickPlay(
					mediaInfo,
					contentProtectionInAdaptationSet,
				);
				if (trickPlayMatch.set) {
					newAdaptationSet.addTrickPlayReference(trickPlayMatch.set);
				} else {
					const cache = this.trickplayCacheMap.get(trickPlayMatch.key) ?? [];
					cache.push(newAdaptationSet);
					this.trickplayCacheMap.set(trickPlayMatch.key, cache);
				}
			} else {
				const trickPlayMatch = this.findMatchingAdaptationSetForTrickPlay(
					mediaInfo,
					contentProtectionInAdaptationSet,
				);
				if (trickPlayMatch.set) {
					trickPlayMatch.set.addTrickPlayReference(newAdaptationSet);
					this.trickplayCacheMap.delete(trickPlayMatch.key);
				}
			}

			// Color metadata. Dolby Vision (dvh*) is always PQ; otherwise read from videoInfo.
			if (codec.startsWith('dvh')) {
				newAdaptationSet.setTransferCharacteristics(TRANSFER_FUNCTION_PQ);
			} else if (mediaInfo.videoInfo.transferCharacteristics !== undefined) {
				newAdaptationSet.setTransferCharacteristics(mediaInfo.videoInfo.transferCharacteristics);
			}
			if (mediaInfo.videoInfo.matrixCoefficients !== undefined) {
				newAdaptationSet.setMatrixCoefficients(mediaInfo.videoInfo.matrixCoefficients);
			}
			if (mediaInfo.videoInfo.colorPrimaries !== undefined) {
				newAdaptationSet.setColorPrimaries(mediaInfo.videoInfo.colorPrimaries);
			}
		} else if (mediaInfo.audioInfo) {
			if (codec === 'mp4a' || codec === 'ac-3' || codec === 'ec-3' || codec === 'ac-4') {
				if (this.mpdOptions.dashProfile === 'live') {
					newAdaptationSet.forceStartWithSAP(1);
				} else if (this.mpdOptions.dashProfile === 'onDemand') {
					newAdaptationSet.forceSubsegmentStartsWithSAP(1);
				}
			}
		} else if (mediaInfo.textInfo) {
			// IOP requires (sub)segmentAlignment=true for all AdaptationSets.
			// shaka sets it carelessly here since adapting between text tracks
			// rarely makes sense.
			newAdaptationSet.forceSetSegmentAlignment(true);
		}

		if (contentProtectionInAdaptationSet && mediaInfo.protectedContent) {
			newAdaptationSet.setProtectedContent(mediaInfo);
			addContentProtectionElements(mediaInfo, newAdaptationSet);
		}

		// CEA-608 / CEA-708 captions on regular (non-trickplay) video reps.
		if (mediaInfo.videoInfo && mediaInfo.videoInfo.playbackRate === undefined) {
			for (const caption of this.mpdOptions.mpdParams.closedCaptions) {
				if (caption.channel.startsWith('CC')) {
					newAdaptationSet.addAccessibility(
						'urn:scte:dash:cc:cea-608:2015',
						`${caption.channel}=${caption.language}`,
					);
				} else if (caption.channel.startsWith('SERVICE')) {
					const serviceNumber = caption.channel.slice('SERVICE'.length);
					newAdaptationSet.addAccessibility(
						'urn:scte:dash:cc:cea-708:2015',
						`${serviceNumber}=lang:${caption.language}`,
					);
				}
			}
		}

		return true;
	}

	/**
	 * Resolve a trick-play AdaptationSet to its reference (main) set, or
	 * vice versa. Mirrors shaka's `FindMatchingAdaptationSetForTrickPlay`.
	 *
	 * @internal
	 */
	private findMatchingAdaptationSetForTrickPlay(
		mediaInfo: MediaInfo,
		contentProtectionInAdaptationSet: boolean,
	): { set: AdaptationSet | null; key: string } {
		const isTrickplay = mediaInfo.videoInfo?.playbackRate !== undefined;
		let key: string;
		let candidates: AdaptationSet[] | undefined;
		if (isTrickplay) {
			key = this.getAdaptationSetKeyForTrickPlay(mediaInfo);
			candidates = this.adaptationSetListMap.get(key);
		} else {
			key = getAdaptationSetKey(mediaInfo, this.mpdOptions.mpdParams.allowCodecSwitching);
			candidates = this.trickplayCacheMap.get(key);
		}
		if (!candidates) {
			return { set: null, key };
		}
		for (const set of candidates) {
			if (set.matchAdaptationSet(mediaInfo, contentProtectionInAdaptationSet)) {
				return { set, key };
			}
		}
		return { set: null, key };
	}

	/**
	 * Compute the AdaptationSet key for a trick-play stream by clearing
	 * the playbackRate first. Mirrors shaka's
	 * `GetAdaptationSetKeyForTrickPlay`.
	 *
	 * @internal
	 */
	private getAdaptationSetKeyForTrickPlay(mediaInfo: MediaInfo): string {
		const noTrickplay: MediaInfo = {
			...mediaInfo,
			videoInfo: mediaInfo.videoInfo
				? { ...mediaInfo.videoInfo, playbackRate: undefined }
				: undefined,
		};
		return getAdaptationSetKey(noTrickplay, this.mpdOptions.mpdParams.allowCodecSwitching);
	}
}
