/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
	ManifestEmitter,
	MediaPipelineHost,
	Playlist,
} from '../manifest-emitter';
import { assert, joinPaths, textEncoder } from '../misc';
import type { OutputAudioTrack, OutputVideoTrack } from '../output';
import type { DashOutputFormatOptions } from '../output-format';
import { PathedTarget } from '../target';
import { Writer } from '../writer';
import type { MediaInfo, VideoInfo, AudioInfo } from './dash-media-info';
import { MpdBuilder } from './dash-mpd-builder';
import type { Period } from './dash-period';
import type { Representation } from './dash-representation';
import { createDefaultMpdOptions } from './dash-types';

const DASH_MIME_TYPE = 'application/dash+xml';
const DEFAULT_VIDEO_TIMESCALE = 90_000;

type RegisteredRepresentation = {
	playlist: Playlist;
	representation: Representation;
	timescale: number;
	emittedSegments: number;
};

/** @internal */
export class DashManifestEmitter implements ManifestEmitter {
	private readonly host: MediaPipelineHost;
	private readonly options: DashOutputFormatOptions;
	private mpd: MpdBuilder | null = null;
	private period: Period | null = null;
	private representations: RegisteredRepresentation[] = [];

	constructor(host: MediaPipelineHost, options: DashOutputFormatOptions) {
		this.host = host;
		this.options = options;
	}

	private resolveSegmentTemplate(playlist: Playlist): string {
		if (this.options.segmentTemplate !== undefined) {
			return this.options.segmentTemplate;
		}
		return `segment-${playlist.id}-$Number$${playlist.segmentFormat.fileExtension}`;
	}

	onStart(): void {
		const opts = createDefaultMpdOptions();
		const isSingleFile = this.host.playlists.some(p =>
			p.initSegment !== null && p.initSegment.byteOffset !== null,
		);
		opts.dashProfile = this.options.dashProfile ?? (isSingleFile ? 'onDemand' : 'live');
		opts.mpdType = this.options.mpdType ?? 'static';
		opts.mpdParams.generateStaticLiveMpd = opts.dashProfile === 'live' && opts.mpdType === 'static';
		opts.mpdParams.useSegmentList = isSingleFile;
		opts.mpdParams.targetSegmentDuration = this.host.targetSegmentDuration;
		Object.assign(opts.mpdParams, this.options.mpdParams ?? {});

		this.mpd = new MpdBuilder(opts);
		this.period = this.mpd.getOrCreatePeriod(0);
	}

	onSegmentAppended(playlist: Playlist): void {
		this.drainSegments(playlist);
	}

	onPlaylistDone(playlist: Playlist): void {
		this.drainSegments(playlist);
	}

	private drainSegments(playlist: Playlist): void {
		const reg = this.ensureRepresentation(playlist);
		if (!reg) {
			return;
		}
		while (reg.emittedSegments < playlist.writtenSegments.length) {
			const segment = playlist.writtenSegments[reg.emittedSegments]!;
			const startTime = Math.round(segment.timestamp * reg.timescale);
			const duration = Math.round(segment.duration * reg.timescale);
			reg.representation.addNewSegment(
				startTime,
				duration,
				segment.byteSize,
				reg.emittedSegments + 1,
			);
			reg.emittedSegments++;
		}
	}

	private ensureRepresentation(playlist: Playlist): RegisteredRepresentation | null {
		const existing = this.representations.find(r => r.playlist === playlist);
		if (existing) {
			return existing;
		}
		if (!this.period) {
			return null;
		}
		const mediaInfo = this.buildMediaInfo(playlist, this.resolveSegmentTemplate(playlist));
		if (!mediaInfo) {
			return null;
		}
		const set = this.period.getOrCreateAdaptationSet(mediaInfo, false);
		if (!set) {
			return null;
		}
		const representation = set.addRepresentation(mediaInfo);
		if (!representation) {
			return null;
		}
		const reg: RegisteredRepresentation = {
			playlist,
			representation,
			timescale: mediaInfo.referenceTimeScale ?? 1,
			emittedSegments: 0,
		};
		this.representations.push(reg);
		return reg;
	}

	async onFinalize(): Promise<void> {
		assert(this.mpd);
		const mpdText = this.mpd.toString();
		if (mpdText === null) {
			return;
		}

		this.options.onMpd?.(mpdText);

		assert(this.host.output._target instanceof PathedTarget);
		const pathedTarget = this.host.output._target;
		const mpdFullPath = joinPaths(pathedTarget.rootPath, this.options.mpdPath);

		const target = await this.host.output._getTarget({
			path: mpdFullPath,
			isRoot: false,
			mimeType: DASH_MIME_TYPE,
		});
		const writer = new Writer(target as never, true);
		writer.start();
		writer.write(textEncoder.encode(mpdText));

		await writer.flush();
		await writer.finalize();
	}

	private buildMediaInfo(
		playlist: Playlist,
		segmentTemplate: string,
	): MediaInfo | null {
		const trackData = this.host.trackDatas.find(td => playlist.tracks.includes(td.track));
		if (!trackData) {
			return null;
		}

		const playlistDir = playlist.path.includes('/')
			? playlist.path.split('/').slice(0, -1).join('/')
			: '';
		const isSingleFile = playlist.initSegment !== null
			&& playlist.initSegment.byteOffset !== null;

		const base: MediaInfo = isSingleFile
			? buildSingleFileBase(playlist, playlistDir)
			: buildSegmentTemplateBase(playlist, playlistDir, this.options.initSegmentName, segmentTemplate);

		if (trackData.info.type === 'video') {
			assert(trackData.track.isVideoTrack());
			const videoInfo = videoInfoFromDecoderConfig(
				trackData.track,
				trackData.info.decoderConfig,
			);
			return {
				...base,
				videoInfo,
				referenceTimeScale: videoInfo.timeScale ?? DEFAULT_VIDEO_TIMESCALE,
			};
		}

		assert(trackData.track.isAudioTrack());
		const audioInfo = audioInfoFromDecoderConfig(
			trackData.track,
			trackData.info.decoderConfig,
		);
		return {
			...base,
			audioInfo,
			referenceTimeScale: audioInfo.timeScale ?? audioInfo.samplingFrequency ?? 48_000,
		};
	}
}

const buildSegmentTemplateBase = (
	playlist: Playlist,
	playlistDir: string,
	initSegmentNameOverride: string | undefined,
	segmentTemplate: string,
): MediaInfo => {
	const initSegmentName = initSegmentNameOverride ?? playlist.initSegment?.path ?? '';
	const initRelativeToMpd = playlistDir === ''
		? initSegmentName
		: joinPaths(playlistDir, initSegmentName);
	const segmentRelativeToMpd = playlistDir === ''
		? segmentTemplate
		: joinPaths(playlistDir, segmentTemplate);
	return {
		containerType: 'mp4',
		initSegmentName: initRelativeToMpd,
		initSegmentUrl: initRelativeToMpd,
		segmentTemplate: segmentRelativeToMpd,
		segmentTemplateUrl: segmentRelativeToMpd,
		bandwidth: bestEffortBandwidth(playlist),
	};
};

const buildSingleFileBase = (
	playlist: Playlist,
	playlistDir: string,
): MediaInfo => {
	assert(playlist.initSegment);
	const fileName = playlist.initSegment.path;
	const fileRelativeToMpd = playlistDir === ''
		? fileName
		: joinPaths(playlistDir, fileName);
	const initEnd = playlist.initSegment.byteSize - 1;
	return {
		containerType: 'mp4',
		mediaFileUrl: fileRelativeToMpd,
		mediaFileName: fileRelativeToMpd,
		initRange: { begin: 0, end: initEnd },
		subsegmentRanges: playlist.writtenSegments.map(s => ({
			begin: s.byteOffset!,
			end: s.byteOffset! + s.byteSize - 1,
		})),
		bandwidth: bestEffortBandwidth(playlist),
	};
};

const bestEffortBandwidth = (playlist: Playlist): number | undefined => {
	if (playlist.peakBitrate !== null && playlist.peakBitrate > 0) {
		return Math.ceil(playlist.peakBitrate);
	}
	return undefined;
};

const videoInfoFromDecoderConfig = (
	track: OutputVideoTrack,
	config: VideoDecoderConfig,
): VideoInfo => {
	const width = config.codedWidth;
	const height = config.codedHeight;
	const frameRate = track.metadata.frameRate;

	const videoInfo: VideoInfo = {
		codec: config.codec,
		timeScale: DEFAULT_VIDEO_TIMESCALE,
	};
	if (width !== undefined) {
		videoInfo.width = width;
	}
	if (height !== undefined) {
		videoInfo.height = height;
	}
	if (frameRate !== undefined && frameRate > 0) {
		videoInfo.frameDuration = Math.round(DEFAULT_VIDEO_TIMESCALE / frameRate);
	}
	return videoInfo;
};

const audioInfoFromDecoderConfig = (
	track: OutputAudioTrack,
	config: AudioDecoderConfig,
): AudioInfo => {
	const audioInfo: AudioInfo = {
		codec: config.codec,
		samplingFrequency: config.sampleRate,
		numChannels: config.numberOfChannels,
		timeScale: config.sampleRate,
	};
	const language = track.metadata.languageCode;
	if (language !== undefined) {
		audioInfo.language = language;
	}
	return audioInfo;
};
