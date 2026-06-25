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
import { psshContentsOffset, resolveURL, substituteTemplate } from './dash-misc';
import {
	type ContentProtection,
	type MpdAdaptationSet,
	type MpdPeriod,
	type MpdRepresentation,
	type SegmentList,
	type SegmentTemplate,
	type SegmentTimelineEntry,
} from './dash-mpd-parser';

export type DashSegmentLocation = {
	path: string;
	offset: number;
	length: number | null;
};

export type DashSegment = Segment & {
	number: number | null;
	timeTicks: number;
	location: DashSegmentLocation;
	initSegment: DashSegment | null;
	firstSegment: DashSegment | null;
};

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
	timeShiftBufferDepth: number | null;
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
			unixEpochTimestamp: null,
			firstSegment: null,
			number: null,
			timeTicks: 0,
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

	// A static MPD may carry availabilityStartTime for archival reasons but its segments are still
	// presentation-time-relative; only dynamic MPDs anchor to the wall clock.
	isWallClockTimeline(): boolean {
		return this.context.isDynamic && this.context.availabilityStartTime !== null;
	}

	getAvailabilityWindow(): { earliestPresentationTime: number; latestPresentationTime: number } | null {
		if (!this.context.isDynamic || this.context.availabilityStartTime === null) {
			return null;
		}
		const nowSec = (Date.now() - this.context.availabilityStartTime) / 1000;
		const latest = nowSec;
		const earliest = this.context.timeShiftBufferDepth !== null
			? Math.max(0, nowSec - this.context.timeShiftBufferDepth)
			: 0;
		return { earliestPresentationTime: earliest, latestPresentationTime: latest };
	}

	runUpdateSegments(): Promise<void> {
		return this.currentUpdateSegmentsPromise ??= (async () => {
			try {
				const remainingWaitTimeMs = this.getRemainingWaitTimeMs();
				if (remainingWaitTimeMs > 0) {
					await wait(remainingWaitTimeMs);
				}
				this.lastSegmentUpdateTime = performance.now();
				if (this.context.isDynamic) {
					await this.demuxer.refreshMpd();
					if (!this.context.isDynamic) {
						this.streamHasEnded = true;
					}
				}
				this.updateSegments();
			} finally {
				this.currentUpdateSegmentsPromise = null;
			}
		})();
	}

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
		const base = this.context.representation.segmentBase;
		if (base && this.segments.length === 0) {
			this.segments.push({
				timestamp: this.context.periodStart,
				duration: this.context.mediaPresentationDuration ?? 0,
				unixEpochTimestamp: null,
				firstSegment: null,
				number: null,
				timeTicks: 0,
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
		const baseURL = this.getBaseURL();
		const repId = this.context.representation.id;
		const bandwidth = this.context.representation.bandwidth;
		const timescale = template.timescale;
		const wallClock = this.isWallClockTimeline();
		const periodStartTicks = this.context.periodStart * timescale + template.presentationTimeOffset;
		const wallClockShift = wallClock
			? (this.context.availabilityStartTime ?? 0) / 1000 + this.context.periodStart
			: 0;
		const availabilityWindow = this.getAvailabilityWindow();

		const lastKnown = last(this.segments);
		const lastKnownEndTicks = lastKnown !== undefined
			? lastKnown.timeTicks + Math.round(lastKnown.duration * timescale)
			: null;

		const appendSegment = (
			number: number,
			timeTicks: number,
			durationTicks: number,
		): void => {
			if (!template.media) {
				return;
			}
			if (lastKnownEndTicks !== null && timeTicks < lastKnownEndTicks) {
				return;
			}

			if (availabilityWindow !== null) {
				const presentationEnd = (timeTicks - periodStartTicks + durationTicks) / timescale;
				if (presentationEnd < availabilityWindow.earliestPresentationTime) {
					return;
				}
				const presentationStart = (timeTicks - periodStartTicks) / timescale;
				if (presentationStart > availabilityWindow.latestPresentationTime) {
					return;
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
				unixEpochTimestamp: wallClock ? wallClockShift + relTimestamp : null,
				firstSegment: this.segments[0] ?? null,
				number,
				timeTicks,
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
			const timeline = template.timeline;
			let currentTime = timeline[0]!.t ?? 0;
			let segNumber = template.startNumber;
			for (let entryIdx = 0; entryIdx < timeline.length; entryIdx++) {
				const entry = timeline[entryIdx]!;
				if (entry.t !== null) {
					currentTime = entry.t;
				}
				// ISO/IEC 23009-1: @r = -1 repeats until next <S>@t or period end, whichever first.
				const nextEntry: SegmentTimelineEntry | undefined = timeline[entryIdx + 1];
				const repeats = entry.r < 0
					? remainingRepeatsTo(
							entry,
							currentTime,
							nextEntry?.t ?? null,
							this.context,
							timescale,
						)
					: entry.r;
				for (let i = 0; i <= repeats; i++) {
					appendSegment(segNumber, currentTime, entry.d);
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
			: liveSegmentCount(this.context, segDuration, timescale);

		for (let i = 0; i < segmentCount; i++) {
			const segNumber = template.startNumber + i;
			const timeTicks = periodStartTicks + i * segDuration;
			appendSegment(segNumber, timeTicks, segDuration);
		}
	}

	private materialiseFromList(list: SegmentList): void {
		const initSegment = this.getInitSegment();
		const baseURL = this.getBaseURL();
		const timescale = list.timescale;
		const wallClock = this.isWallClockTimeline();
		const wallClockShift = wallClock
			? (this.context.availabilityStartTime ?? 0) / 1000 + this.context.periodStart
			: 0;

		let accTimeTicks = list.presentationTimeOffset;
		const startIndex = this.segments.length;
		for (let i = startIndex; i < list.segments.length; i++) {
			const entry = list.segments[i]!;
			const durationTicks = list.timeline?.[i]?.d ?? list.duration ?? 0;
			const durationSec = durationTicks / timescale;
			const path = resolveURL(entry.media, baseURL);
			const accTimeSec = accTimeTicks / timescale;
			const seg: DashSegment = {
				timestamp: wallClock ? wallClockShift + accTimeSec : this.context.periodStart + accTimeSec,
				duration: durationSec,
				unixEpochTimestamp: wallClock ? wallClockShift + accTimeSec : null,
				firstSegment: this.segments[0] ?? null,
				number: list.startNumber + i,
				timeTicks: accTimeTicks,
				initSegment,
				location: {
					path,
					offset: entry.mediaRange?.start ?? 0,
					length: entry.mediaRange ? entry.mediaRange.end - entry.mediaRange.start + 1 : null,
				},
			};
			this.segments.push(seg);
			accTimeTicks += durationTicks;
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
				const headerOffset = psshContentsOffset(raw);
				if (raw.length <= headerOffset) {
					continue;
				}
				const contents = parsePsshBoxContents(raw.subarray(headerOffset));
				const fullBytes = headerOffset === 8 ? raw : buildPsshBox(raw);
				psshBoxes.push({ ...contents, bytes: fullBytes });
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

// ISO/IEC 23009-1 §5.3.9.6.1: when @r is negative, repeats stop at the next <S>@t (when present)
// or the period end. Returns "additional repeats" (0 → one segment, since the current @t is
// already emitted by the caller).
const remainingRepeatsTo = (
	entry: SegmentTimelineEntry,
	currentTime: number,
	nextEntryTime: number | null,
	context: DashSegmentedInputContext,
	timescale: number,
): number => {
	const periodEndTicks = context.periodEnd !== null
		? context.periodEnd * timescale
		: context.mediaPresentationDuration !== null
			? context.mediaPresentationDuration * timescale
			: null;
	const candidates: number[] = [];
	if (nextEntryTime !== null) {
		candidates.push(nextEntryTime);
	}
	if (periodEndTicks !== null) {
		candidates.push(periodEndTicks);
	}
	if (candidates.length === 0) {
		return 0;
	}
	const boundary = Math.min(...candidates);
	const remaining = Math.max(0, boundary - currentTime);
	return Math.max(0, Math.floor(remaining / entry.d) - 1);
};

const liveSegmentCount = (
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

// ISO/IEC 23001-7 pssh box: 4-byte BE size + 'pssh' 4CC + contents.
const buildPsshBox = (contents: Uint8Array): Uint8Array => {
	const total = 8 + contents.length;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, total, false);
	out[4] = 0x70;
	out[5] = 0x73;
	out[6] = 0x73;
	out[7] = 0x68;
	out.set(contents, 8);
	return out;
};
