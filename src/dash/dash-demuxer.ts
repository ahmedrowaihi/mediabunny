/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AUDIO_CODECS,
	AudioCodec,
	inferCodecFromCodecString,
	MediaCodec,
	VIDEO_CODECS,
	VideoCodec,
} from '../codec';
import { Demuxer, DurationMetadataRequestOptions } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import { assert, MaybePromise, Rotation, UNDETERMINED_LANGUAGE } from '../misc';
import { TrackType } from '../output';
import { EncodedPacket } from '../packet';
import { PathedSource } from '../source';
import { DASH_MIME_TYPE } from './dash-misc';
import {
	type MpdAdaptationSet,
	type MpdPeriod,
	type MpdRepresentation,
	parseMpd,
} from './dash-mpd-parser';
import { DashSegmentedInput, type DashSegmentedInputContext } from './dash-segmented-input';

type InternalTrack = {
	id: number;
	demuxer: DashDemuxer;
	backingTrack: InputTrackBacking | null;
	languageCode: string;
	primary: boolean;
	autoselect: boolean;
	pairingMask: bigint;
	stableKey: string;
	name: string | null;

	codecString: string;
	peakBitrate: number | null;
	averageBitrate: number | null;

	period: MpdPeriod;
	adaptationSet: MpdAdaptationSet;
	representation: MpdRepresentation;
	segmentedInput: DashSegmentedInput;

	info: {
		type: 'video';
		width: number | null;
		height: number | null;
	} | {
		type: 'audio';
		numberOfChannels: number | null;
		sampleRate: number | null;
	};
};
type InternalVideoTrack = InternalTrack & { info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & { info: { type: 'audio' } };

export class DashDemuxer extends Demuxer {
	metadataPromise: Promise<void> | null = null;
	trackBackings: InputTrackBacking[] | null = null;
	internalTracks: InternalTrack[] | null = null;
	segmentedInputs: DashSegmentedInput[] = [];
	stableIdMap = new Map<string, number>();
	nextSequentialId = 1;

	constructor(input: Input) {
		super(input);
	}

	readMetadata(): Promise<void> {
		return this.metadataPromise ??= (async () => {
			assert(this.input._rootSource instanceof PathedSource);
			const { rootPath } = this.input._rootSource;

			const slice = await this.input._reader.requestEntireFile();
			assert(slice);
			const decoder = new TextDecoder('utf-8');
			const xml = decoder.decode(slice.bytes.subarray(slice.start, slice.end));
			const mpd = parseMpd(xml);

			const periodsWithBoundaries = computePeriodBoundaries(
				mpd.periods,
				mpd.mediaPresentationDuration,
			);

			const internalTracks: InternalTrack[] = [];
			let pairingBit = 0;

			for (const { period, periodStart, periodEnd } of periodsWithBoundaries) {
				const videoAdaptationSets = period.adaptationSets.filter(as => as.contentType === 'video');
				const audioAdaptationSets = period.adaptationSets.filter(as => as.contentType === 'audio');

				const pairingMask = 1n << BigInt(pairingBit);
				pairingBit++;

				for (const as of [...videoAdaptationSets, ...audioAdaptationSets]) {
					const adaptationSetIsVideo = as.contentType === 'video';
					for (const rep of as.representations) {
						const codecString = pickCodec(rep, as);
						if (!codecString) {
							continue;
						}

						const inferredCodec = inferCodecFromCodecString(codecString);
						if (inferredCodec === null) {
							continue;
						}

						const isVideoCodec = VIDEO_CODECS.includes(inferredCodec as VideoCodec);
						const isAudioCodec = AUDIO_CODECS.includes(inferredCodec as AudioCodec);
						if (adaptationSetIsVideo && !isVideoCodec) {
							continue;
						}
						if (!adaptationSetIsVideo && !isAudioCodec) {
							continue;
						}

						const context: DashSegmentedInputContext = {
							manifestURL: rootPath,
							period,
							adaptationSet: as,
							representation: rep,
							periodStart,
							periodEnd,
							availabilityStartTime: mpd.availabilityStartTime,
							isDynamic: mpd.type === 'dynamic',
							minimumUpdatePeriod: mpd.minimumUpdatePeriod,
							mediaPresentationDuration: mpd.mediaPresentationDuration,
							timeShiftBufferDepth: mpd.timeShiftBufferDepth,
						};

						const stableKey = `${period.id ?? ''}|${as.id ?? ''}|${rep.id}`;
						const id = this.stableIdFor(stableKey);
						const segmentedInput = new DashSegmentedInput(this, context, [
							{ id, type: adaptationSetIsVideo ? 'video' : 'audio' },
						]);
						this.segmentedInputs.push(segmentedInput);

						const primaryRole = as.roles.some(r => r.value === 'main');

						const internal: InternalTrack = adaptationSetIsVideo
							? {
									id,
									demuxer: this,
									backingTrack: null,
									languageCode: preprocessLanguageCode(as.lang),
									primary: primaryRole,
									autoselect: true,
									pairingMask,
									stableKey,
									name: rep.id,
									codecString,
									peakBitrate: rep.bandwidth,
									averageBitrate: null,
									period,
									adaptationSet: as,
									representation: rep,
									segmentedInput,
									info: {
										type: 'video',
										width: rep.width ?? as.maxWidth,
										height: rep.height ?? as.maxHeight,
									},
								}
							: {
									id,
									demuxer: this,
									backingTrack: null,
									languageCode: preprocessLanguageCode(as.lang),
									primary: primaryRole,
									autoselect: true,
									pairingMask,
									stableKey,
									name: rep.id,
									codecString,
									peakBitrate: rep.bandwidth,
									averageBitrate: null,
									period,
									adaptationSet: as,
									representation: rep,
									segmentedInput,
									info: {
										type: 'audio',
										numberOfChannels: null,
										sampleRate: rep.audioSamplingRate ?? null,
									},
								};

						internalTracks.push(internal);
					}
				}
			}

			this.internalTracks = internalTracks;
		})();
	}

	stableIdFor(key: string): number {
		const existing = this.stableIdMap.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.nextSequentialId++;
		this.stableIdMap.set(key, id);
		return id;
	}

	refreshMpdPromise: Promise<void> | null = null;

	/**
	 * Re-fetch the MPD (dynamic only), re-parse, and mutate each existing
	 * DashSegmentedInput context in-place so subsequent `updateSegments()`
	 * calls see the latest period/timeline state. If the refreshed MPD
	 * transitions to `type='static'`, each segmented input's context flips
	 * to `isDynamic=false`; the SegmentedInput then marks itself
	 * `streamHasEnded`.
	 */
	refreshMpd(): Promise<void> {
		if (this.refreshMpdPromise) {
			return this.refreshMpdPromise;
		}
		this.refreshMpdPromise = (async () => {
			try {
				const slice = await this.input._reader.requestEntireFile();
				assert(slice);
				const decoder = new TextDecoder('utf-8');
				const xml = decoder.decode(slice.bytes.subarray(slice.start, slice.end));
				const mpd = parseMpd(xml);
				const boundaries = computePeriodBoundaries(mpd.periods, mpd.mediaPresentationDuration);

				for (const segInput of this.segmentedInputs) {
					const periodId = segInput.context.period.id;
					const asId = segInput.context.adaptationSet.id;
					const repId = segInput.context.representation.id;

					const matchBoundary = boundaries.find(b => b.period.id === periodId);
					if (!matchBoundary) {
						continue;
					}
					const matchAs = matchBoundary.period.adaptationSets.find(a => a.id === asId);
					if (!matchAs) {
						continue;
					}
					const matchRep = matchAs.representations.find(r => r.id === repId);
					if (!matchRep) {
						continue;
					}

					segInput.context.period = matchBoundary.period;
					segInput.context.adaptationSet = matchAs;
					segInput.context.representation = matchRep;
					segInput.context.periodStart = matchBoundary.periodStart;
					segInput.context.periodEnd = matchBoundary.periodEnd;
					segInput.context.availabilityStartTime = mpd.availabilityStartTime;
					segInput.context.isDynamic = mpd.type === 'dynamic';
					segInput.context.minimumUpdatePeriod = mpd.minimumUpdatePeriod;
					segInput.context.mediaPresentationDuration = mpd.mediaPresentationDuration;
					segInput.context.timeShiftBufferDepth = mpd.timeShiftBufferDepth;
					segInput.refreshInterval = segInput.context.isDynamic
						? Math.max(1, mpd.minimumUpdatePeriod ?? 5)
						: Number.POSITIVE_INFINITY;
				}
			} finally {
				this.refreshMpdPromise = null;
			}
		})();
		return this.refreshMpdPromise;
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		await this.readMetadata();
		assert(this.internalTracks);

		if (this.trackBackings) {
			return this.trackBackings;
		}

		const backings: InputTrackBacking[] = [];
		for (const internal of this.internalTracks) {
			if (internal.info.type === 'video') {
				backings.push(new DashInputVideoTrackBacking(internal as InternalVideoTrack));
			} else {
				backings.push(new DashInputAudioTrackBacking(internal as InternalAudioTrack));
			}
		}
		this.trackBackings = backings;
		return backings;
	}

	async getMimeType(): Promise<string> {
		return DASH_MIME_TYPE;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	override dispose(): void {
		for (const segInput of this.segmentedInputs) {
			segInput.dispose();
		}
		this.segmentedInputs.length = 0;
	}
}

const pickCodec = (rep: MpdRepresentation, as: MpdAdaptationSet): string | null => {
	if (rep.codecs) {
		return rep.codecs;
	}
	if (as.codecs) {
		return as.codecs;
	}
	return null;
};

const computePeriodBoundaries = (
	periods: MpdPeriod[],
	totalDuration: number | null,
): { period: MpdPeriod; periodStart: number; periodEnd: number | null }[] => {
	const out: { period: MpdPeriod; periodStart: number; periodEnd: number | null }[] = [];
	for (let i = 0; i < periods.length; i++) {
		const p = periods[i]!;
		const periodStart = p.start ?? (i === 0 ? 0 : out[i - 1]!.periodEnd ?? 0);
		let periodEnd: number | null = null;
		if (p.duration !== null) {
			periodEnd = periodStart + p.duration;
		} else if (i < periods.length - 1) {
			const next = periods[i + 1]!;
			if (next.start !== null) {
				periodEnd = next.start;
			}
		} else if (totalDuration !== null) {
			periodEnd = totalDuration;
		}
		out.push({ period: p, periodStart, periodEnd });
	}
	return out;
};

const preprocessLanguageCode = (code: string | null): string => {
	if (code === null) {
		return UNDETERMINED_LANGUAGE;
	}
	const subtag = code.split('-')[0];
	return subtag ? subtag : UNDETERMINED_LANGUAGE;
};

abstract class DashInputTrackBacking implements InputTrackBacking {
	hydrationPromise: Promise<void> | null = null;

	constructor(public internalTrack: InternalTrack) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	hydrate(): Promise<void> {
		return this.hydrationPromise ??= (async () => {
			const trackBackings = await this.internalTrack.segmentedInput.getTrackBackings();
			const match = trackBackings.find(t => t.getType() === this.getType());
			if (!match) {
				throw new Error('Could not find matching track in underlying DASH segment.');
			}
			this.internalTrack.backingTrack = match;
		})();
	}

	delegate<T>(fn: () => MaybePromise<T>): MaybePromise<T> {
		if (this.internalTrack.backingTrack) {
			return fn();
		}
		return this.hydrate().then(fn);
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			default: this.internalTrack.autoselect,
			primary: this.internalTrack.primary,
		};
	}

	getId(): number {
		return this.internalTrack.id;
	}

	getPairingMask(): bigint {
		return this.internalTrack.pairingMask;
	}

	getInternalCodecId(): string | number | Uint8Array | null {
		return null;
	}

	getEncryptionInfo() {
		return null;
	}

	getLanguageCode(): string {
		return this.internalTrack.languageCode;
	}

	getName(): string | null {
		return this.internalTrack.name;
	}

	getNumber(): number {
		assert(this.internalTrack.demuxer.internalTracks);
		const trackType = this.internalTrack.info.type;
		let n = 0;
		for (const t of this.internalTrack.demuxer.internalTracks) {
			if (t.info.type === trackType) {
				n++;
			}
			if (t === this.internalTrack) {
				break;
			}
		}
		return n;
	}

	getTimeResolution(): MaybePromise<number> {
		return this.delegate(() => this.internalTrack.backingTrack!.getTimeResolution());
	}

	isRelativeToUnixEpoch(): MaybePromise<boolean> {
		return this.delegate(() => this.internalTrack.backingTrack!.isRelativeToUnixEpoch());
	}

	getBitrate(): number | null {
		return this.internalTrack.peakBitrate;
	}

	getAverageBitrate(): number | null {
		return this.internalTrack.averageBitrate;
	}

	async getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getDurationFromMetadata(options);
	}

	async getLiveRefreshInterval(): Promise<number | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getLiveRefreshInterval();
	}

	getHasOnlyKeyPackets() {
		return this.delegate(() => this.internalTrack.backingTrack!.getHasOnlyKeyPackets?.() ?? null);
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getFirstPacket(options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getPacket(timestamp, options);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getKeyPacket(timestamp, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getNextPacket(packet, options);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getNextKeyPacket(packet, options);
	}
}

class DashInputVideoTrackBacking
	extends DashInputTrackBacking
	implements InputVideoTrackBacking {
	override internalTrack!: InternalVideoTrack;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
	}

	get backingVideoTrack(): InputVideoTrackBacking | null {
		return this.internalTrack.backingTrack as InputVideoTrackBacking | null;
	}

	getType(): 'video' {
		return 'video';
	}

	override getCodec(): VideoCodec | null {
		return inferCodecFromCodecString(this.internalTrack.codecString) as VideoCodec | null;
	}

	getCodedWidth(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getCodedWidth());
	}

	getCodedHeight(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getCodedHeight());
	}

	getSquarePixelWidth(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getSquarePixelWidth());
	}

	getSquarePixelHeight(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getSquarePixelHeight());
	}

	getMetadataDisplayWidth(): number | null {
		if (this.backingVideoTrack) {
			return null;
		}
		return this.internalTrack.info.width;
	}

	getMetadataDisplayHeight(): number | null {
		if (this.backingVideoTrack) {
			return null;
		}
		return this.internalTrack.info.height;
	}

	getRotation(): MaybePromise<Rotation> {
		return this.delegate(() => this.backingVideoTrack!.getRotation());
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		await this.hydrate();
		return this.backingVideoTrack!.getColorSpace();
	}

	async canBeTransparent(): Promise<boolean> {
		await this.hydrate();
		return this.backingVideoTrack!.canBeTransparent();
	}

	getMetadataCodecParameterString(): string | null {
		if (this.backingVideoTrack) {
			return null;
		}
		return this.internalTrack.codecString;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		await this.hydrate();
		return this.backingVideoTrack!.getDecoderConfig();
	}
}

class DashInputAudioTrackBacking
	extends DashInputTrackBacking
	implements InputAudioTrackBacking {
	override internalTrack!: InternalAudioTrack;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
	}

	get backingAudioTrack(): InputAudioTrackBacking | null {
		return this.internalTrack.backingTrack as InputAudioTrackBacking | null;
	}

	getType(): 'audio' {
		return 'audio';
	}

	override getCodec(): AudioCodec | null {
		return inferCodecFromCodecString(this.internalTrack.codecString) as AudioCodec | null;
	}

	getNumberOfChannels(): MaybePromise<number> {
		if (this.internalTrack.info.numberOfChannels !== null) {
			return this.internalTrack.info.numberOfChannels;
		}
		return this.delegate(() => this.backingAudioTrack!.getNumberOfChannels());
	}

	getSampleRate(): MaybePromise<number> {
		if (this.internalTrack.info.sampleRate !== null) {
			return this.internalTrack.info.sampleRate;
		}
		return this.delegate(() => this.backingAudioTrack!.getSampleRate());
	}

	getMetadataCodecParameterString(): string | null {
		if (this.backingAudioTrack) {
			return null;
		}
		return this.internalTrack.codecString;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		await this.hydrate();
		return this.backingAudioTrack!.getDecoderConfig();
	}
}
