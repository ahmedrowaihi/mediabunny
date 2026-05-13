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

/** Per-segment byte location. `length === null` means "open-ended; read until EOF". */
export type DashSegmentLocation = {
	path: string;
	offset: number;
	length: number | null;
};

/** A materialised DASH segment. Mirrors HlsSegment in shape. */
export type DashSegment = Segment & {
	/** SegmentTemplate `$Number$` for this segment, or null when the
	 *  representation is SegmentList-based (no number). Used for stable
	 *  cross-refresh dedup on live MPDs. */
	number: number | null;
	/** Presentation time in `timescale` units at the moment of materialisation.
	 *  Used for dedup and identity across refreshes. */
	timeTicks: number;
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
			relativeToUnixEpoch: false,
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

	/** Whether we should shift segment timestamps to Unix-epoch seconds.
	 *  Only dynamic MPDs are wall-clock anchored. A static MPD may carry
	 *  `availabilityStartTime` for archival/scheduling reasons but its
	 *  segments are still presentation-time-relative; shifting them to
	 *  the wall clock would lie to consumers who expect VOD timelines. */
	isWallClockTimeline(): boolean {
		return this.context.isDynamic && this.context.availabilityStartTime !== null;
	}

	/** Live segment availability window. Returns `null` for static MPDs and
	 *  when the timeShiftBufferDepth is unbounded. Segments whose end-of-presentation
	 *  wall-clock time is older than `now - timeShiftBufferDepth` should not
	 *  be materialised. */
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
				relativeToUnixEpoch: this.isWallClockTimeline(),
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
			// Dedup against the in-memory list by (number, timeTicks). We compare on
			// unit-consistent fields rather than on URLs / byte offsets to avoid the
			// confusion class of bugs caused by mixing ticks and bytes.
			if (lastKnownEndTicks !== null && timeTicks < lastKnownEndTicks) {
				return;
			}

			// Live availability: clamp out segments that have aged out of the DVR
			// window. We use the segment's end-of-presentation time against the
			// window's earliest edge so a segment partially still in-window is kept.
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
				relativeToUnixEpoch: wallClock,
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
				// Per ISO/IEC 23009-1: @r = -1 means "repeat until the next <S>@t (if
				// any) or the period end, whichever comes first". A positive @r is the
				// number of additional repeats. Zero means "no repeat" → 1 segment.
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
				relativeToUnixEpoch: wallClock,
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
				// When the MPD supplied only the contents (no header), reconstruct a
				// minimal full-box `bytes` so `psshBoxesAreEqual` and any downstream
				// consumer that re-emits the box has the canonical wire form.
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

/** Compute the number of additional <S> repeats when @r is negative.
 *  Per ISO/IEC 23009-1 §5.3.9.6.1: repeats stop at the next <S>@t (when
 *  present) or the period end, whichever comes first. The returned value
 *  is "additional repeats" (so a result of 0 means "just one segment").
 *
 *  Mathematically: count = floor((boundary - currentTime) / entry.d) − 1
 *    because we already emit one segment for the current @t.
 *  The `entry.d` divisor is guarded against zero by parser invariants. */
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

/** Estimate the count of live segments materialised so far when no
 *  SegmentTimeline is in use. Uses `availabilityStartTime` + period start
 *  as the anchor; falls back to 0 when the anchor is missing (consumer
 *  hasn't supplied wall-clock info). */
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

/** Reconstruct a full ISO/IEC 23001-7 `pssh` box around content-only bytes.
 *  Layout: 4-byte BE size (8 + contents.length) + 'pssh' 4CC + contents. */
const buildPsshBox = (contents: Uint8Array): Uint8Array => {
	const total = 8 + contents.length;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, total, false);
	out[4] = 0x70; // 'p'
	out[5] = 0x73; // 's'
	out[6] = 0x73; // 's'
	out[7] = 0x68; // 'h'
	out.set(contents, 8);
	return out;
};
