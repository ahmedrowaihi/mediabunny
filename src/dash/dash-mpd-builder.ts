/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/mpd_builder.{h,cc}
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { DASH_NS } from './dash-misc';
import type { MediaInfo } from './dash-media-info';
import { secondsToXmlDuration } from './dash-mpd-utils';
import { Period } from './dash-period';
import type { Representation } from './dash-representation';
import type { MpdOptions } from './dash-types';
import { XmlNode } from './dash-xml-node';

/**
 * Returns the current time. Mirrors shaka's `Clock` (a `chrono`-compatible
 * wrapper). Replace via {@link MpdBuilder.injectClockForTesting} to anchor
 * `publishTime` / `availabilityStartTime` against a fixed instant.
 *
 * @group DASH
 * @public
 */
export type Clock = () => Date;

/**
 * Default URL emitted in the `Generated with` comment. Matches shaka's
 * `kPackagerGithubUrl`.
 *
 * @internal
 */
const DEFAULT_PACKAGER_PROJECT_URL = 'https://github.com/shaka-project/shaka-packager';

const ON_DEMAND_PROFILE = 'urn:mpeg:dash:profile:isoff-on-demand:2011';
const LIVE_PROFILE = 'urn:mpeg:dash:profile:isoff-live:2011';

const SCHEMA_LOCATION = 'urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd';

/** Mirrors shaka's `kPeriodTimeDriftThresholdInSeconds`. @internal */
const PERIOD_TIME_DRIFT_THRESHOLD_SECONDS = 1.0;

/**
 * Format a `Date` as `YYYY-MM-DDTHH:MM:SSZ` (UTC). Mirrors shaka's
 * `XmlDateTimeNowWithOffset` output format.
 *
 * @internal
 */
const formatXmlDateTime = (date: Date): string => {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
		+ `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
};

/**
 * Add `offsetSeconds` to the time returned by `clock` and format it as
 * `YYYY-MM-DDTHH:MM:SSZ` (UTC). Mirrors shaka's `XmlDateTimeNowWithOffset`.
 *
 * @internal
 */
const xmlDateTimeNowWithOffset = (offsetSeconds: number, clock: Clock): string => {
	const ms = clock().getTime() + offsetSeconds * 1000;
	return formatXmlDateTime(new Date(ms));
};

/** Mirrors shaka's `Positive`. @internal */
const positive = (d: number): boolean => d > 0.0;

/** Mirrors shaka's `SetIfPositive`. @internal */
const setIfPositive = (attrName: string, value: number, mpd: XmlNode): void => {
	if (positive(value)) {
		mpd.setStringAttribute(attrName, secondsToXmlDuration(value));
	}
};

/**
 * Add the MPD namespace declarations. Mirrors shaka's
 * `AddMpdNameSpaceInfo`: always emits `xmlns`, `xmlns:xsi`, and
 * `xsi:schemaLocation`; conditionally emits `xmlns:cenc`, `xmlns:mas`,
 * `xmlns:xlink`, `xmlns:mspr`, and `xmlns:scte214` based on whether the
 * matching prefix is referenced anywhere in the tree.
 *
 * @internal
 */
const addMpdNameSpaceInfo = (mpd: XmlNode): boolean => {
	const referenced = mpd.extractReferencedNamespaces();

	mpd.setStringAttribute('xmlns', DASH_NS.mpd);
	mpd.setStringAttribute('xmlns:xsi', DASH_NS.xsi);
	mpd.setStringAttribute('xsi:schemaLocation', SCHEMA_LOCATION);

	const uris: Record<string, string> = {
		cenc: DASH_NS.cenc,
		mas: DASH_NS.mas,
		xlink: DASH_NS.xlink,
		mspr: DASH_NS.mspr,
		scte214: DASH_NS.scte214,
	};

	for (const ns of referenced) {
		const uri = uris[ns];
		if (!uri) {
			throw new Error(`unexpected namespace ${ns}`);
		}
		mpd.setStringAttribute(`xmlns:${ns}`, uri);
	}
	return true;
};

/**
 * Strip a `file://` prefix if present. Mirrors shaka's prefix-strip in
 * `MakePathsRelativeToMpd`.
 *
 * @internal
 */
const stripFileProtocol = (path: string): string => {
	const prefix = 'file://';
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

/**
 * POSIX `dirname` — return the path with the trailing component removed.
 * Returns `''` when there is no `/` in the input.
 *
 * @internal
 */
const parentPath = (p: string): string => {
	const idx = p.lastIndexOf('/');
	if (idx === -1) {
		return '';
	}
	return p.slice(0, idx);
};

/**
 * POSIX-style `relative(from, to)` returning a `/`-separated path.
 * Mirrors `std::filesystem::relative` for the simple cases used by
 * `MakePathsRelativeToMpd`.
 *
 * @internal
 */
const computeRelativePath = (from: string, to: string): string => {
	const fromParts = from.split('/').filter(s => s.length > 0);
	const toParts = to.split('/').filter(s => s.length > 0);
	let common = 0;
	while (
		common < fromParts.length
		&& common < toParts.length
		&& fromParts[common] === toParts[common]
	) {
		common++;
	}
	const upCount = fromParts.length - common;
	const out: string[] = [];
	for (let i = 0; i < upCount; i++) {
		out.push('..');
	}
	for (let i = common; i < toParts.length; i++) {
		out.push(toParts[i]!);
	}
	return out.join('/');
};

/**
 * Make `mediaPath` relative to `parent`. Mirrors shaka's `MakePathRelative`
 * exactly: if the result is empty or starts with `..`, fall back to
 * `mediaPath` unchanged.
 *
 * @internal
 */
const makePathRelative = (mediaPath: string, parent: string): string => {
	const relative = computeRelativePath(parent, mediaPath);
	if (relative.length === 0) {
		return mediaPath;
	}
	const firstSep = relative.indexOf('/');
	const firstComponent = firstSep === -1 ? relative : relative.slice(0, firstSep);
	if (firstComponent === '..') {
		return mediaPath;
	}
	return relative;
};

/**
 * Build the root `<MPD>` document for a DASH presentation. Mirrors
 * shaka-packager's `MpdBuilder` class: holds a list of {@link Period}s,
 * emits both the on-demand (`SegmentBase`/`SegmentList`) and live
 * (`SegmentTemplate`) profiles, and supports static (VOD) and dynamic
 * (live) MPD types.
 *
 * Construct a builder, call {@link MpdBuilder.getOrCreatePeriod} to obtain a
 * {@link Period}, populate it via the `Period` / `AdaptationSet` /
 * `Representation` API, then call {@link MpdBuilder.toString} to render the
 * manifest.
 *
 * @group DASH
 * @public
 */
export class MpdBuilder {
	/** @internal */
	private mpdOptions: MpdOptions;
	/** @internal */
	private readonly periods: Period[] = [];
	/** @internal */
	private readonly baseUrls: string[] = [];
	/** @internal */
	private availabilityStartTime = '';
	/** @internal */
	private periodCounter = 0;
	/**
	 * Shared counter so Representation IDs are unique across periods.
	 * @internal
	 */
	private readonly representationCounter = { value: 0 };
	/**
	 * Time source. Replaceable for deterministic tests via
	 * {@link injectClockForTesting}.
	 * @internal
	 */
	private clock: Clock = () => new Date();
	/** @internal */
	private packagerVersion = '';
	/** @internal */
	private packagerProjectUrl = DEFAULT_PACKAGER_PROJECT_URL;

	constructor(mpdOptions: MpdOptions) {
		this.mpdOptions = mpdOptions;
	}

	/** Append a `<BaseURL>` value rendered as a child of the root `<MPD>`. */
	addBaseUrl(baseUrl: string): void {
		this.baseUrls.push(baseUrl);
	}

	/**
	 * Find an existing {@link Period} whose start time is within
	 * 1.0&nbsp;second of `startTimeInSeconds`, or create a new one.
	 * Mirrors shaka's `GetOrCreatePeriod`.
	 */
	getOrCreatePeriod(startTimeInSeconds: number): Period {
		for (const period of this.periods) {
			if (Math.abs(period.startTimeSeconds() - startTimeInSeconds) < PERIOD_TIME_DRIFT_THRESHOLD_SECONDS) {
				return period;
			}
		}
		const period = new Period(
			this.periodCounter++,
			startTimeInSeconds,
			this.mpdOptions,
			this.representationCounter,
		);
		this.periods.push(period);
		return period;
	}

	/**
	 * Convert a dynamic Live/EVENT stream into a static VOD stream when
	 * `eventToVodOnEndOfStream` is enabled. No-op otherwise. Mirrors
	 * shaka's `FinalizeDynamicMpd`.
	 */
	finalizeDynamicMpd(): void {
		if (this.mpdOptions.mpdParams.eventToVodOnEndOfStream) {
			this.mpdOptions = {
				...this.mpdOptions,
				dashProfile: 'onDemand',
				mpdType: 'static',
			};
		}
	}

	/**
	 * Render the current MPD as a string. Returns `null` when the document
	 * could not be generated (e.g. `minBufferTime` not set). Mirrors
	 * shaka's `ToString`.
	 */
	toString(): string | null {
		const mpd = this.generateMpd();
		if (!mpd) {
			return null;
		}
		const comment = this.packagerVersion.length > 0
			? `Generated with ${this.packagerProjectUrl} version ${this.packagerVersion}`
			: '';
		return mpd.toString(comment);
	}

	/**
	 * Update `mediaInfo`'s URL fields so that they are relative to the
	 * directory containing `mpdPath`. Mirrors shaka's
	 * `MakePathsRelativeToMpd`. Mutates and returns `mediaInfo` for
	 * convenience.
	 */
	static makePathsRelativeToMpd(mpdPath: string, mediaInfo: MediaInfo): MediaInfo {
		const cleanPath = stripFileProtocol(mpdPath);
		if (cleanPath.length === 0) {
			return mediaInfo;
		}
		const mpdDir = parentPath(cleanPath);
		if (mediaInfo.mediaFileName !== undefined) {
			mediaInfo.mediaFileUrl = makePathRelative(mediaInfo.mediaFileName, mpdDir);
		}
		if (mediaInfo.initSegmentName !== undefined) {
			mediaInfo.initSegmentUrl = makePathRelative(mediaInfo.initSegmentName, mpdDir);
		}
		if (mediaInfo.segmentTemplate !== undefined) {
			mediaInfo.segmentTemplateUrl = makePathRelative(mediaInfo.segmentTemplate, mpdDir);
		}
		return mediaInfo;
	}

	/**
	 * Replace the time source used to compute `publishTime` and
	 * `availabilityStartTime`. Mirrors shaka's
	 * `InjectClockForTesting`.
	 */
	injectClockForTesting(clock: Clock): void {
		this.clock = clock;
	}

	/**
	 * Anchor `availabilityStartTime` to a fixed value so dynamic-MPD
	 * tests don't depend on the wall clock. Mirrors the
	 * `friend class LiveMpdBuilderTest` access in shaka's header.
	 *
	 * @internal
	 */
	setAvailabilityStartTimeForTesting(value: string): void {
		this.availabilityStartTime = value;
	}

	/**
	 * Set the packager version printed in the `Generated with ...` XML
	 * comment. Mirrors shaka's `SetPackagerVersionForTesting` global —
	 * exposed per-instance because the TS port has no global mutable
	 * state.
	 */
	setPackagerVersionForTesting(version: string): void {
		this.packagerVersion = version;
	}

	/**
	 * Set the packager URL printed in the `Generated with ...` comment.
	 * Defaults to the shaka GitHub URL for parity with shaka's tests.
	 */
	setPackagerProjectUrl(url: string): void {
		this.packagerProjectUrl = url;
	}

	/** @internal */
	mpdOptionsForTesting(): MpdOptions {
		return this.mpdOptions;
	}

	/**
	 * Build the root `<MPD>` element. Mirrors shaka's `GenerateMpd`.
	 *
	 * @internal
	 */
	private generateMpd(): XmlNode | null {
		const mpd = new XmlNode('MPD');

		for (const baseUrl of this.baseUrls) {
			const node = new XmlNode('BaseURL');
			node.setPathContent(baseUrl);
			mpd.addChild(node);
		}

		let outputPeriodDuration = false;
		if (this.mpdOptions.mpdType === 'static') {
			this.updatePeriodDurationAndPresentationTimestamp();
			// Only output Period@duration when there is more than one period.
			// For single-period output it is redundant (identical to
			// MPD@mediaPresentationDuration).
			outputPeriodDuration = this.periods.length > 1;
		}

		for (const period of this.periods) {
			const node = period.getXml(outputPeriodDuration);
			if (!node) {
				return null;
			}
			mpd.addChild(node);
		}

		if (!addMpdNameSpaceInfo(mpd)) {
			return null;
		}

		switch (this.mpdOptions.dashProfile) {
			case 'onDemand': {
				mpd.setStringAttribute('profiles', ON_DEMAND_PROFILE);
				break;
			}
			case 'live': {
				mpd.setStringAttribute('profiles', LIVE_PROFILE);
				break;
			}
			default: {
				return null;
			}
		}

		this.addCommonMpdInfo(mpd);
		switch (this.mpdOptions.mpdType) {
			case 'static': {
				this.addStaticMpdInfo(mpd);
				break;
			}
			case 'dynamic': {
				this.addDynamicMpdInfo(mpd);
				if (!this.addUtcTiming(mpd)) {
					return null;
				}
				break;
			}
			default: {
				return null;
			}
		}
		return mpd;
	}

	/**
	 * Set MPD attributes common to all profiles. Mirrors shaka's
	 * `AddCommonMpdInfo`.
	 *
	 * @internal
	 */
	private addCommonMpdInfo(mpd: XmlNode): void {
		if (positive(this.mpdOptions.mpdParams.minBufferTime)) {
			mpd.setStringAttribute(
				'minBufferTime',
				secondsToXmlDuration(this.mpdOptions.mpdParams.minBufferTime),
			);
		}
	}

	/**
	 * Add the static-MPD attributes (`type` + `mediaPresentationDuration`).
	 * Mirrors shaka's `AddStaticMpdInfo`.
	 *
	 * @internal
	 */
	private addStaticMpdInfo(mpd: XmlNode): void {
		mpd.setStringAttribute('type', 'static');
		mpd.setStringAttribute(
			'mediaPresentationDuration',
			secondsToXmlDuration(this.getStaticMpdDuration()),
		);
	}

	/**
	 * Add the dynamic-MPD attributes (`type`, `publishTime`,
	 * `availabilityStartTime`, `minimumUpdatePeriod`,
	 * `timeShiftBufferDepth`, `suggestedPresentationDelay`). Mirrors
	 * shaka's `AddDynamicMpdInfo`.
	 *
	 * @internal
	 */
	private addDynamicMpdInfo(mpd: XmlNode): void {
		mpd.setStringAttribute('type', 'dynamic');

		// No offset from NOW.
		mpd.setStringAttribute('publishTime', xmlDateTimeNowWithOffset(0, this.clock));

		if (this.availabilityStartTime.length === 0) {
			const earliest = this.getEarliestTimestamp();
			if (earliest !== null) {
				this.availabilityStartTime = xmlDateTimeNowWithOffset(-Math.ceil(earliest), this.clock);
			}
		}
		if (this.availabilityStartTime.length > 0) {
			mpd.setStringAttribute('availabilityStartTime', this.availabilityStartTime);
		}

		if (positive(this.mpdOptions.mpdParams.minimumUpdatePeriod)) {
			mpd.setStringAttribute(
				'minimumUpdatePeriod',
				secondsToXmlDuration(this.mpdOptions.mpdParams.minimumUpdatePeriod),
			);
		}

		setIfPositive('timeShiftBufferDepth', this.mpdOptions.mpdParams.timeShiftBufferDepth, mpd);
		setIfPositive('suggestedPresentationDelay', this.mpdOptions.mpdParams.suggestedPresentationDelay, mpd);
	}

	/**
	 * Add `<UTCTiming>` children. Mirrors shaka's `AddUtcTiming`.
	 *
	 * @internal
	 */
	private addUtcTiming(mpd: XmlNode): boolean {
		for (const utc of this.mpdOptions.mpdParams.utcTimings) {
			const node = new XmlNode('UTCTiming');
			node.setStringAttribute('schemeIdUri', utc.schemeIdUri);
			node.setStringAttribute('value', utc.value);
			mpd.addChild(node);
		}
		return true;
	}

	/**
	 * Sum the durations of all periods. Mirrors shaka's
	 * `GetStaticMpdDuration`.
	 *
	 * @internal
	 */
	private getStaticMpdDuration(): number {
		// Shaka accumulates in a C++ `float` (float32); each `+=` of a
		// `double` period duration narrows back to float32. `Math.fround`
		// mirrors that per-addition rounding.
		let total = 0;
		for (const period of this.periods) {
			total = Math.fround(total + period.durationSeconds());
		}
		return total;
	}

	/**
	 * Find the earliest segment timestamp across all representations of
	 * the first period. Returns `null` when no representation has any
	 * segments. Mirrors shaka's `GetEarliestTimestamp`.
	 *
	 * @internal
	 */
	private getEarliestTimestamp(): number | null {
		if (this.periods.length === 0) {
			return null;
		}
		let earliest = -1;
		for (const adaptationSet of this.periods[0]!.getAdaptationSets()) {
			for (const representation of adaptationSet.getRepresentations()) {
				const ts = representation.getStartAndEndTimestamps();
				if (ts && (earliest < 0 || ts.start < earliest)) {
					earliest = ts.start;
				}
			}
		}
		if (earliest < 0) {
			return null;
		}
		return earliest;
	}

	/**
	 * Set period durations and presentation-time offsets. Uses video
	 * representations when available, otherwise falls back to non-video.
	 * Mirrors shaka's `UpdatePeriodDurationAndPresentationTimestamp`.
	 *
	 * @internal
	 */
	private updatePeriodDurationAndPresentationTimestamp(): void {
		for (const period of this.periods) {
			const videoReps: Representation[] = [];
			const nonVideoReps: Representation[] = [];
			for (const adaptationSet of period.getAdaptationSets()) {
				const reps = adaptationSet.getRepresentations();
				if (adaptationSet.isVideo()) {
					for (const rep of reps) {
						videoReps.push(rep);
					}
				} else {
					for (const rep of reps) {
						nonVideoReps.push(rep);
					}
				}
			}

			let earliestStart: number | null = null;
			let latestEnd: number | null = null;
			const reps = videoReps.length > 0 ? videoReps : nonVideoReps;
			for (const rep of reps) {
				const ts = rep.getStartAndEndTimestamps();
				if (ts) {
					earliestStart = earliestStart === null ? ts.start : Math.min(earliestStart, ts.start);
					latestEnd = latestEnd === null ? ts.end : Math.max(latestEnd, ts.end);
				}
			}

			if (earliestStart === null || latestEnd === null) {
				// No segment timestamps were found for this period. This happens for
				// periods 1+ in multi-period on-demand DASH when representations are
				// created via copy — the copy does not carry segment infos, so
				// getStartAndEndTimestamps() returns null for all copied representations.
				//
				// Fall back to the period's own start time (set from the cue event
				// timestamp that triggered the period boundary) as the
				// presentationTimeOffset for every representation in this period, so
				// that players know which byte-offset within the shared single-file
				// asset to begin reading from.
				const periodStartTime = period.startTimeSeconds();
				for (const adaptationSet of period.getAdaptationSets()) {
					for (const rep of adaptationSet.getRepresentations()) {
						rep.setPresentationTimeOffset(periodStartTime);
					}
				}
				continue;
			}

			period.setDurationSeconds(latestEnd - earliestStart);

			const presentationTimeOffset = earliestStart;
			for (const adaptationSet of period.getAdaptationSets()) {
				for (const rep of adaptationSet.getRepresentations()) {
					rep.setPresentationTimeOffset(presentationTimeOffset);
				}
			}
		}
	}
}
