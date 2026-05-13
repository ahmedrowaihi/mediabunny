/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from '../input';
import { type InputFormatOptions } from '../input-format';
import { parsePsshBoxContents, psshBoxesAreEqual, type PsshBox } from '../isobmff/isobmff-misc';
import { arrayArgmin, assert, binarySearchLessOrEqual, last, wait } from '../misc';
import { Segment, SegmentedInput, SegmentedInputTrackDeclaration, SegmentRetrievalOptions } from '../segmented-input';
import { CustomPathedSource, SourceRequest } from '../source';
import { type DashDemuxer } from './dash-demuxer';
import { resolveURL, substituteTemplate } from './dash-misc';
import {
	type ContentProtection,
	type MpdAdaptationSet,
	type MpdPeriod,
	type MpdRepresentation,
	type SegmentList,
	type SegmentTemplate,
	type SegmentTimelineEntry,
} from './dash-mpd-parser';

/** Per-segment byte location. `length === null` means "open-ended; read until EOF". */
export type DashSegmentLocation = {
	path: string;
	offset: number;
	length: number | null;
};

/** A materialised DASH segment. Mirrors HlsSegment in shape. */
export type DashSegment = Segment & {
	location: DashSegmentLocation;
	initSegment: DashSegment | null;
	firstSegment: DashSegment | null;
};

/** Everything needed to materialise segments for one Representation. The
 *  demuxer assembles these and passes them in at construction time so this
 *  class never needs to touch the MPD AST again. */
export type DashSegmentedInputContext = {
	manifestURL: string;
	period: MpdPeriod;
	adaptationSet: MpdAdaptationSet;
	representation: MpdRepresentation;
	periodStart: number;
	periodEnd: number | null;
	availabilityStartTime: number | null;
	isDynamic: boolean;
	minimumUpdatePeriod: number | null;
	mediaPresentationDuration: number | null;
};

const MAX_INPUT_CACHE_SIZE = 4;

export class DashSegmentedInput extends SegmentedInput {
	demuxer: DashDemuxer;
	context: DashSegmentedInputContext;

	segments: DashSegment[] = [];
	streamHasEnded = false;
	lastSegmentUpdateTime = -Infinity;
	refreshInterval: number;

	currentUpdateSegmentsPromise: Promise<void> | null = null;
	initSegmentCache: DashSegment | null = null;

	constructor(
		demuxer: DashDemuxer,
		context: DashSegmentedInputContext,
		trackDeclarations: SegmentedInputTrackDeclaration[] | null,
	) {
		super(demuxer.input, context.manifestURL, trackDeclarations);
		this.demuxer = demuxer;
		this.context = context;

		this.refreshInterval = context.isDynamic
			? Math.max(1, context.minimumUpdatePeriod ?? 5)
			: Number.POSITIVE_INFINITY;

		this.streamHasEnded = !context.isDynamic;
	}

	getEffectiveSegmentTemplate(): SegmentTemplate | null {
		return this.context.representation.segmentTemplate ?? this.context.adaptationSet.segmentTemplate;
	}

	getEffectiveSegmentList(): SegmentList | null {
		return this.context.representation.segmentList ?? this.context.adaptationSet.segmentList;
	}

	getEffectiveContentProtections(): ContentProtection[] {
		const set = new Map<string, ContentProtection>();
		for (const cp of this.context.adaptationSet.contentProtections) {
			set.set(`${cp.schemeIdUri}|${cp.value ?? ''}`, cp);
		}
		for (const cp of this.context.representation.contentProtections) {
			set.set(`${cp.schemeIdUri}|${cp.value ?? ''}`, cp);
		}
		return Array.from(set.values());
	}

	getBaseURL(): string {
		return resolveURL(
			(this.context.representation.baseURLs[0] ?? ''),
			resolveURL(
				(this.context.adaptationSet.baseURLs[0] ?? ''),
				resolveURL(
					(this.context.period.baseURLs[0] ?? ''),
					this.context.manifestURL,
				),
			),
		);
	}

	getInitLocation(): DashSegmentLocation | null {
		const template = this.getEffectiveSegmentTemplate();
		if (template?.initialization) {
			const url = substituteTemplate(template.initialization, {
				representationId: this.context.representation.id,
				bandwidth: this.context.representation.bandwidth,
			});
			return {
				path: resolveURL(url, this.getBaseURL()),
				offset: 0,
				length: null,
			};
		}

		const list = this.getEffectiveSegmentList();
		if (list?.initialization?.sourceURL) {
			return {
				path: resolveURL(list.initialization.sourceURL, this.getBaseURL()),
				offset: list.initialization.range?.start ?? 0,
				length: list.initialization.range
					? list.initialization.range.end - list.initialization.range.start + 1
					: null,
			};
		}
		if (list?.initialization?.range) {
			return {
				path: this.getBaseURL(),
				offset: list.initialization.range.start,
				length: list.initialization.range.end - list.initialization.range.start + 1,
			};
		}

		const base = this.context.representation.segmentBase;
		if (base?.initialization?.range) {
			return {
				path: this.getBaseURL(),
				offset: base.initialization.range.start,
				length: base.initialization.range.end - base.initialization.range.start + 1,
			};
		}

		return null;
	}

	getInitSegment(): DashSegment | null {
		if (this.initSegmentCache) {
			return this.initSegmentCache;
		}
		const location = this.getInitLocation();
		if (!location) {
			return null;
		}
		this.initSegmentCache = {
			timestamp: 0,
			duration: 0,
			relativeToUnixEpoch: false,
			firstSegment: null,
			location,
			initSegment: null,
		};
		return this.initSegmentCache;
	}

	getRemainingWaitTimeMs(): number {
		if (!this.context.isDynamic) {
			return 0;
		}
		const elapsed = performance.now() - this.lastSegmentUpdateTime;
		const result = Math.max(0, 1000 * this.refreshInterval - elapsed);
		return result <= 50 ? 0 : result;
	}

	runUpdateSegments(): Promise<void> {
		return this.currentUpdateSegmentsPromise ??= (async () => {
			try {
				const remainingWaitTimeMs = this.getRemainingWaitTimeMs();
				if (remainingWaitTimeMs > 0) {
					await wait(remainingWaitTimeMs);
				}
				this.lastSegmentUpdateTime = performance.now();
				this.updateSegments();
			} finally {
				this.currentUpdateSegmentsPromise = null;
			}
		})();
	}

	/** Materialise segments from the effective SegmentTemplate or SegmentList.
	 *  Idempotent w.r.t. already-materialised segments: new segments are
	 *  appended; existing ones are not duplicated. */
	updateSegments(): void {
		const template = this.getEffectiveSegmentTemplate();
		if (template) {
			this.materialiseFromTemplate(template);
			return;
		}
		const list = this.getEffectiveSegmentList();
		if (list) {
			this.materialiseFromList(list);
			return;
		}
		// SegmentBase: single-file representation. The whole file is the segment;
		// the underlying ISOBMFF demuxer handles seeking via sidx.
		const base = this.context.representation.segmentBase;
		if (base && this.segments.length === 0) {
			this.segments.push({
				timestamp: this.context.periodStart,
				duration: this.context.mediaPresentationDuration ?? 0,
				relativeToUnixEpoch: this.context.availabilityStartTime !== null,
				firstSegment: null,
				initSegment: this.getInitSegment(),
				location: {
					path: this.getBaseURL(),
					offset: 0,
					length: null,
				},
			});
		}
	}

	private materialiseFromTemplate(template: SegmentTemplate): void {
		const initSegment = this.getInitSegment();
		const firstSegment = this.segments[0] ?? null;
		const baseURL = this.getBaseURL();
		const repId = this.context.representation.id;
		const bandwidth = this.context.representation.bandwidth;
		const timescale = template.timescale;
		const wallClock = this.context.availabilityStartTime !== null;
		const periodStartTicks = this.context.periodStart * timescale + template.presentationTimeOffset;
		const wallClockShift = wallClock
			? (this.context.availabilityStartTime ?? 0) / 1000 + this.context.periodStart
			: 0;

		const appendSegment = (
			number: number,
			timeTicks: number,
			durationTicks: number,
		): void => {
			if (!template.media) {
				return;
			}
			const lastSeg = last(this.segments);
			if (lastSeg) {
				const lastNumber = lastSeg.location.path; // unique-ish identity
				const candidatePath = resolveURL(
					substituteTemplate(template.media, {
						number,
						time: timeTicks,
						representationId: repId,
						bandwidth,
					}),
					baseURL,
				);
				if (lastNumber === candidatePath) {
					return; // already materialised
				}
			}

			const mediaPath = resolveURL(
				substituteTemplate(template.media, {
					number,
					time: timeTicks,
					representationId: repId,
					bandwidth,
				}),
				baseURL,
			);

			const relTimestamp = (timeTicks - periodStartTicks) / timescale;
			const timestamp = wallClock
				? wallClockShift + relTimestamp
				: this.context.periodStart + relTimestamp;

			const seg: DashSegment = {
				timestamp,
				duration: durationTicks / timescale,
				relativeToUnixEpoch: wallClock,
				firstSegment,
				initSegment,
				location: {
					path: mediaPath,
					offset: 0,
					length: null,
				},
			};
			this.segments.push(seg);
		};

		if (template.timeline && template.timeline.length > 0) {
			let currentTime = template.timeline[0]!.t ?? 0;
			let segNumber = template.startNumber;
			const lastKnown = last(this.segments);
			for (const entry of template.timeline) {
				if (entry.t !== null) {
					currentTime = entry.t;
				}
				const repeats = entry.r < 0
					? estimateRemainingRepeats(entry, currentTime, this.context, timescale)
					: entry.r;
				for (let i = 0; i <= repeats; i++) {
					if (!lastKnown || currentTime > lastKnown.location.offset) {
						appendSegment(segNumber, currentTime, entry.d);
					}
					currentTime += entry.d;
					segNumber++;
				}
			}
			return;
		}

		const segDuration = template.duration;
		if (segDuration === null || segDuration <= 0) {
			return;
		}

		const periodDuration = this.context.periodEnd !== null
			? this.context.periodEnd - this.context.periodStart
			: this.context.mediaPresentationDuration !== null
				? this.context.mediaPresentationDuration - this.context.periodStart
				: null;

		const segmentCount = periodDuration !== null
			? Math.ceil((periodDuration * timescale) / segDuration)
			: estimateLiveSegmentCount(this.context, segDuration, timescale);

		const startIndex = this.segments.length;
		for (let i = startIndex; i < segmentCount; i++) {
			const segNumber = template.startNumber + i;
			const timeTicks = periodStartTicks + i * segDuration;
			appendSegment(segNumber, timeTicks, segDuration);
		}
	}

	private materialiseFromList(list: SegmentList): void {
		const initSegment = this.getInitSegment();
		const firstSegment = this.segments[0] ?? null;
		const baseURL = this.getBaseURL();
		const timescale = list.timescale;
		const wallClock = this.context.availabilityStartTime !== null;
		const wallClockShift = wallClock
			? (this.context.availabilityStartTime ?? 0) / 1000 + this.context.periodStart
			: 0;

		let accTime = list.presentationTimeOffset / timescale;
		const startIndex = this.segments.length;
		for (let i = startIndex; i < list.segments.length; i++) {
			const entry = list.segments[i]!;
			const duration = (list.timeline?.[i]?.d ?? list.duration ?? 0) / timescale;
			const path = resolveURL(entry.media, baseURL);
			const seg: DashSegment = {
				timestamp: wallClock ? wallClockShift + accTime : this.context.periodStart + accTime,
				duration,
				relativeToUnixEpoch: wallClock,
				firstSegment,
				initSegment,
				location: {
					path,
					offset: entry.mediaRange?.start ?? 0,
					length: entry.mediaRange ? entry.mediaRange.end - entry.mediaRange.start + 1 : null,
				},
			};
			this.segments.push(seg);
			accTime += duration;
		}
	}

	async getFirstSegment(): Promise<Segment | null> {
		if (this.segments.length === 0) {
			await this.runUpdateSegments();
		}
		return this.segments[0] ?? null;
	}

	async getSegmentAt(timestamp: number, options: SegmentRetrievalOptions): Promise<Segment | null> {
		if (this.segments.length === 0) {
			await this.runUpdateSegments();
		}
		let isLazy = !!options.skipLiveWait && this.getRemainingWaitTimeMs() > 0;
		while (true) {
			const index = binarySearchLessOrEqual(this.segments, timestamp, x => x.timestamp);
			if (index === -1) {
				return null;
			}
			if (index < this.segments.length - 1 || this.streamHasEnded || isLazy) {
				return this.segments[index]!;
			}
			const segment = this.segments[index]!;
			if (timestamp < segment.timestamp + segment.duration) {
				return segment;
			}
			await this.runUpdateSegments();
			if (options.skipLiveWait) {
				isLazy = true;
			}
		}
	}

	async getNextSegment(segment: Segment, options: SegmentRetrievalOptions): Promise<Segment | null> {
		const index = this.segments.indexOf(segment as DashSegment);
		assert(index !== -1);
		const nextIndex = index + 1;
		let isLazy = !!options.skipLiveWait && this.getRemainingWaitTimeMs() > 0;
		while (true) {
			if (nextIndex < this.segments.length) {
				return this.segments[nextIndex]!;
			}
			if (this.streamHasEnded || isLazy) {
				return null;
			}
			await this.runUpdateSegments();
			if (options.skipLiveWait) {
				isLazy = true;
			}
		}
	}

	async getPreviousSegment(segment: Segment): Promise<Segment | null> {
		const index = this.segments.indexOf(segment as DashSegment);
		assert(index !== -1);
		return this.segments[index - 1] ?? null;
	}

	getInputForSegment(segment: Segment): Input {
		const dashSegment = segment as DashSegment;

		const cacheEntry = this.inputCache.find(x => x.segment === dashSegment);
		if (cacheEntry) {
			cacheEntry.age = this.nextInputCacheAge++;
			return cacheEntry.input;
		}

		let initInput: Input | null = null;
		if (dashSegment.initSegment || dashSegment.firstSegment) {
			initInput = this.getInputForSegment((dashSegment.initSegment ?? dashSegment.firstSegment)!);
		}

		const protections = this.getEffectiveContentProtections();
		const psshBoxes: PsshBox[] = [];
		for (const cp of protections) {
			for (const raw of cp.psshBoxes) {
				if (raw.length < 8) {
					continue;
				}
				const contents = parsePsshBoxContents(raw.subarray(8));
				psshBoxes.push({ ...contents, bytes: raw });
			}
		}

		const formatOptions: InputFormatOptions = {
			...this.input._formatOptions,
			isobmff: {
				...this.input._formatOptions.isobmff,
				resolveKeyId: this.input._formatOptions.isobmff?.resolveKeyId && ((options) => {
					if (psshBoxes.length === 0) {
						return this.input._formatOptions.isobmff!.resolveKeyId!(options);
					}
					let merged = options.psshBoxes;
					for (const pssh of psshBoxes) {
						if (
							(pssh.keyIds === null || pssh.keyIds.includes(options.keyId))
							&& !merged.some(x => psshBoxesAreEqual(x, pssh))
						) {
							merged = [...merged, pssh];
						}
					}
					return this.input._formatOptions.isobmff!.resolveKeyId!({
						...options,
						psshBoxes: merged,
					});
				}),
			},
		};

		const input = new Input({
			source: new CustomPathedSource(
				dashSegment.location.path,
				async (request) => {
					assert(request.isRoot);
					const proxiedRequest: SourceRequest = { ...request, isRoot: false };
					let ref = await this.input._getSourceCached(proxiedRequest);
					const needsSlice = dashSegment.location.offset > 0 || dashSegment.location.length !== null;
					if (needsSlice) {
						const slice = ref.source.slice(
							dashSegment.location.offset,
							dashSegment.location.length ?? undefined,
						);
						const sliceRef = slice.ref();
						ref.free();
						ref = sliceRef;
					}
					return ref;
				},
			),
			formats: this.input._formats,
			initInput: initInput ?? undefined,
			formatOptions,
		});

		this.inputCache.push({
			segment: dashSegment,
			input,
			age: this.nextInputCacheAge++,
		});
		if (this.inputCache.length > MAX_INPUT_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this.inputCache, x => x.age);
			assert(minAgeIndex !== -1);
			this.inputCache.splice(minAgeIndex, 1);
		}

		return input;
	}

	async getLiveRefreshInterval(): Promise<number | null> {
		if (!this.context.isDynamic) {
			return null;
		}
		if (this.getRemainingWaitTimeMs() === 0) {
			await this.runUpdateSegments();
		}
		return this.streamHasEnded ? null : this.refreshInterval;
	}
}

const estimateRemainingRepeats = (
	entry: SegmentTimelineEntry,
	currentTime: number,
	context: DashSegmentedInputContext,
	timescale: number,
): number => {
	const endSec = context.periodEnd ?? context.mediaPresentationDuration;
	if (endSec === null) {
		return 0;
	}
	const endTicks = endSec * timescale;
	const remaining = Math.max(0, endTicks - currentTime);
	return Math.max(0, Math.floor(remaining / entry.d) - 1);
};

const estimateLiveSegmentCount = (
	context: DashSegmentedInputContext,
	segDuration: number,
	timescale: number,
): number => {
	if (context.availabilityStartTime === null) {
		return 0;
	}
	const elapsedSec = Math.max(0, (Date.now() - context.availabilityStartTime) / 1000 - context.periodStart);
	return Math.max(0, Math.floor((elapsedSec * timescale) / segDuration));
};
