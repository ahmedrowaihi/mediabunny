/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { declaredVideoCodec } from '../isobmff/isobmff-boxes';
import type { ManifestEmitter, MediaPipelineHost } from '../manifest-emitter';
import type { Playlist } from '../segment-pipeline-muxer';
import {
	assert,
	COLOR_PRIMARIES_MAP,
	joinPaths,
	MATRIX_COEFFICIENTS_MAP,
	textEncoder,
	TRANSFER_CHARACTERISTICS_MAP,
} from '../misc';
import type { OutputAudioTrack, OutputTrack, OutputVideoTrack } from '../output';
import type { DashOutputFormatOptions, OutputFormat } from '../output-format';
import { PathedTarget } from '../target';
import { Writer } from '../writer';
import type { MediaInfo, VideoInfo, AudioInfo, TextInfo } from './dash-media-info';
import { MpdBuilder } from './dash-mpd-builder';
import type { Period } from './dash-period';
import type { Representation } from './dash-representation';
import { createDefaultMpdOptions } from './dash-types';

const DASH_MIME_TYPE = 'application/dash+xml';
const DEFAULT_VIDEO_TIMESCALE = 90_000;

// DASH-IF IOP names in-band CEA-608 captions with this Accessibility scheme, whose value lists the channels.
const CEA_608_SCHEME_ID_URI = 'urn:scte:dash:cc:cea-608:2015';

type RegisteredRepresentation = {
	playlist: Playlist;
	representation: Representation;
	timescale: number;
	emittedSegments: number;
	largestPartDuration: number;
};

/** @internal */
export class DashManifestEmitter implements ManifestEmitter {
	private readonly host: MediaPipelineHost;
	private readonly options: DashOutputFormatOptions;
	private mpd: MpdBuilder | null = null;
	private period: Period | null = null;
	private readonly mpdOptions = createDefaultMpdOptions();
	private representations: RegisteredRepresentation[] = [];

	constructor(host: MediaPipelineHost, options: DashOutputFormatOptions) {
		this.host = host;
		this.options = options;
	}

	private get isSingleFile(): boolean {
		return this.options.singleFilePerPlaylist ?? false;
	}

	private resolveSegmentTemplate(playlist: Playlist): string {
		if (this.options.segmentTemplate !== undefined) {
			return this.options.segmentTemplate;
		}
		return `segment-${playlist.id}-$Number$${playlist.segmentFormat.fileExtension}`;
	}

	onStart(): void {
		const mpdOptions = this.mpdOptions;
		mpdOptions.dashProfile = this.options.dashProfile ?? (this.isSingleFile ? 'onDemand' : 'live');
		mpdOptions.mpdType = this.options.mpdType ?? (this.host.isLive ? 'dynamic' : 'static');
		mpdOptions.mpdParams.generateStaticLiveMpd
			= mpdOptions.dashProfile === 'live' && mpdOptions.mpdType === 'static';
		mpdOptions.mpdParams.useSegmentList = this.isSingleFile;
		mpdOptions.mpdParams.targetSegmentDuration = this.host.targetSegmentDuration;
		this.refreshLiveWindow();

		Object.assign(mpdOptions.mpdParams, this.options.mpdParams ?? {});

		this.mpd = new MpdBuilder(mpdOptions);
		this.period = this.mpd.getOrCreatePeriod(0);
	}

	onSegmentAppended(playlist: Playlist): void {
		this.drainSegments(playlist);
	}

	onPlaylistDone(playlist: Playlist): void {
		this.drainSegments(playlist);
	}

	/**
	 * A dynamic MPD without these tells the player never to reload and that the DVR window is
	 * unbounded, while the pipeline drops segments underneath it. Both follow what the pipeline
	 * observed, never a nominal duration.
	 *
	 * @internal
	 */
	private refreshLiveWindow(): void {
		const params = this.mpdOptions.mpdParams;
		if (!this.host.isLive || this.mpdOptions.mpdType !== 'dynamic') {
			return;
		}

		if (this.options.mpdParams?.minimumUpdatePeriod === undefined) {
			params.minimumUpdatePeriod = this.host.globalTargetDuration;
		}
		if (
			this.options.mpdParams?.timeShiftBufferDepth === undefined
			&& Number.isFinite(this.host.maxLiveSegmentCount)
		) {
			// The window is what the playlists still hold, summed. A nominal count times a nominal
			// duration overstates it whenever segments come out ragged, and a player that believes
			// the overstatement seeks to a segment already deleted.
			let longest = 0;
			for (const playlist of this.host.playlists) {
				longest = Math.max(longest, playlist.windowDuration);
			}
			params.timeShiftBufferDepth = longest;
		}
	}

	private drainSegments(playlist: Playlist): void {
		const reg = this.ensureRepresentation(playlist);
		if (!reg) {
			return;
		}
		this.refreshLiveWindow();

		// `writtenSegments` is a sliding window under `live`.
		const totalAppended = playlist.mediaSequence + playlist.writtenSegments.length;

		while (reg.emittedSegments < totalAppended) {
			const segment = playlist.writtenSegments[reg.emittedSegments - playlist.mediaSequence]!;
			const startTime = Math.round(segment.timestamp * reg.timescale);
			const duration = Math.round(segment.duration * reg.timescale);
			reg.representation.addNewSegment(
				startTime,
				duration,
				segment.byteSize,
				reg.emittedSegments + 1,
			);
			reg.emittedSegments++;

			if (segment.parts !== null && this.mpdOptions.mpdParams.lowLatencyDashMode) {
				const longestPart = Math.max(...segment.parts.map(part => part.duration));
				// DASH-IF IOP low-latency: a segment is announced as available once its longest chunk could be complete
				if (longestPart > reg.largestPartDuration) {
					reg.largestPartDuration = longestPart;
					reg.representation.setAvailabilityTimeOffset(longestPart);
				}
			}
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
			largestPartDuration: 0,
		};
		this.representations.push(reg);
		return reg;
	}

	async onFinalize(): Promise<void> {
		assert(this.mpd);
		// A top-level `sidx` describes every subsegment on its own, so the MPD can point at that one
		// range instead of listing them.
		if (
			this.options.mpdParams?.useSegmentList === undefined
			&& this.host.playlists.every(p => p.indexRange !== null)
		) {
			this.mpdOptions.mpdParams.useSegmentList = false;
		}
		const mpdText = this.mpd.toString();
		if (mpdText === null) {
			// Writing nothing and reporting success would leave the caller with segments no manifest
			// describes, which looks like a successful output until a player asks for the MPD.
			throw new Error(
				'The MPD could not be built: a representation is missing information the manifest requires,'
				+ ' such as a video track whose width or height is unknown.',
			);
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
		const writer = new Writer(target, true);
		writer.start();
		writer.write(textEncoder.encode(mpdText));

		await writer.flush();
		await writer.finalize();
	}

	private buildMediaInfo(
		playlist: Playlist,
		segmentTemplate: string,
	): MediaInfo | null {
		const trackDatas = this.host.trackDatas.filter(td => playlist.tracks.includes(td.track));
		if (trackDatas.length === 0) {
			return null;
		}

		const playlistDir = playlist.path.includes('/')
			? playlist.path.split('/').slice(0, -1).join('/')
			: '';

		const subtitleTrackData = trackDatas.find(td => td.info.type === 'subtitle');
		if (subtitleTrackData) {
			const track = subtitleTrackData.track;
			assert(track.isSubtitleTrack());

			if (track.source._codec === 'ttml') {
				// TTML rides in the same fragmented MP4 as the media, so it is described like the media is.
				const base = this.isSingleFile
					? buildSingleFileBase(playlist, playlistDir)
					: buildSegmentTemplateBase(
							playlist,
							playlistDir,
							this.options.initSegmentName,
							segmentTemplate,
						);

				return {
					...base,
					textInfo: buildTextInfo(track, 'ttml'),
					referenceTimeScale: SUBTITLE_TIMESCALE,
				};
			}

			return buildTextMediaInfo(track, playlist, playlistDir, segmentTemplate);
		}

		const base: MediaInfo = this.isSingleFile
			? buildSingleFileBase(playlist, playlistDir)
			: buildSegmentTemplateBase(playlist, playlistDir, this.options.initSegmentName, segmentTemplate);

		// One file may carry both media types; see `isMultiplexed` for the deviation.
		let videoInfo: VideoInfo | undefined;
		let audioInfo: AudioInfo | undefined;
		let dashAccessibilities: string[] | undefined;

		for (const { track, info } of trackDatas) {
			if (info.type === 'video') {
				assert(track.isVideoTrack());
				videoInfo ??= videoInfoFromDecoderConfig(
					track,
					info.decoderConfig,
					playlist.segmentFormat,
					info.inBandParameterSets,
				);

				const closedCaptions = track.metadata.closedCaptions;
				if (closedCaptions?.announceInManifest) {
					dashAccessibilities
						??= [`${CEA_608_SCHEME_ID_URI}=${closedCaptions.channels.join(';')}`];
				}
			} else if (info.type === 'audio') {
				assert(track.isAudioTrack());
				audioInfo ??= audioInfoFromDecoderConfig(track, info.decoderConfig);
			}
		}

		// Timing is stated in one timescale, and video's wins when the file carries both.
		let referenceTimeScale: number;
		if (videoInfo) {
			referenceTimeScale = videoInfo.timeScale ?? DEFAULT_VIDEO_TIMESCALE;
		} else if (audioInfo) {
			referenceTimeScale = audioInfo.timeScale ?? audioInfo.samplingFrequency ?? 48_000;
		} else {
			return null;
		}

		return { ...base, videoInfo, audioInfo, referenceTimeScale, dashAccessibilities };
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
	};
};

const SUBTITLE_TIMESCALE = 1000;

/** `wvtt` and `ttml` are what DASH names WebVTT and TTML. */
const buildTextInfo = (track: OutputTrack, codec: 'wvtt' | 'ttml'): TextInfo => {
	const textInfo: TextInfo = {
		codec,
		type: 'subtitle',
	};
	if (track.metadata.disposition?.forced) {
		textInfo.forced = true;
	}
	const language = track.metadata.languageCode;
	if (language !== undefined) {
		textInfo.language = language;
	}

	return textInfo;
};

const buildTextMediaInfo = (
	track: OutputTrack,
	playlist: Playlist,
	playlistDir: string,
	segmentTemplate: string,
): MediaInfo => {
	const segmentRelativeToMpd = playlistDir === ''
		? segmentTemplate
		: joinPaths(playlistDir, segmentTemplate);

	return {
		containerType: 'text',
		segmentTemplate: segmentRelativeToMpd,
		segmentTemplateUrl: segmentRelativeToMpd,
		textInfo: buildTextInfo(track, 'wvtt'),
		referenceTimeScale: SUBTITLE_TIMESCALE,
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
		indexRange: playlist.indexRange ?? undefined,
		subsegmentRanges: playlist.writtenSegments.map(s => ({
			begin: s.byteOffset!,
			end: s.byteOffset! + s.byteSize - 1,
		})),
	};
};

const videoInfoFromDecoderConfig = (
	track: OutputVideoTrack,
	config: VideoDecoderConfig,
	segmentFormat: OutputFormat,
	inBandParameterSets: boolean,
): VideoInfo => {
	const width = config.codedWidth;
	const height = config.codedHeight;
	const frameRate = track.metadata.frameRate;

	const videoInfo: VideoInfo = {
		codec: declaredVideoCodec(track.source._codec, config.codec, segmentFormat, inBandParameterSets),
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

	const colorSpace = config.colorSpace;
	if (colorSpace?.primaries) {
		videoInfo.colorPrimaries = COLOR_PRIMARIES_MAP[colorSpace.primaries];
	}
	if (colorSpace?.transfer) {
		videoInfo.transferCharacteristics = TRANSFER_CHARACTERISTICS_MAP[colorSpace.transfer];
	}
	if (colorSpace?.matrix) {
		videoInfo.matrixCoefficients = MATRIX_COEFFICIENTS_MAP[colorSpace.matrix];
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
