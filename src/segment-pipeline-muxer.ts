/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MediaCodec, validateAudioChunkMetadata, validateVideoChunkMetadata } from './codec';
import { Logging } from './logging';
import type { ByteRange } from './isobmff/isobmff-misc';
import { EncodedAudioPacketSource, EncodedVideoPacketSource, SubtitleCueSource } from './media-source';
import {
	arrayArgmax,
	assert,
	AsyncMutex,
	findLastIndex,
	joinPaths,
	toArray,
	UNDETERMINED_LANGUAGE,
} from './misc';
import { Muxer } from './muxer';
import {
	AudioTrackMetadata,
	Output,
	OutputAudioTrack,
	OutputSubtitleTrack,
	OutputTrack,
	OutputVideoTrack,
	TrackType,
	VideoTrackMetadata,
} from './output';
import {
	HlsOutputFormatOptions,
	HlsOutputPlaylistInfo,
	HlsOutputSegmentInfo,
	OutputFormat,
	SegmentedOutputFormatOptions,
	SegmentPart,
	WEBVTT_SEGMENT_FORMAT,
	WebvttSegmentFormat,
} from './output-format';
import { ManifestEmitter } from './manifest-emitter';
import type { HlsManifestEmitterHost } from './hls/hls-manifest-emitter';
import { EncodedPacket } from './packet';
import { cueOverlapsSegment, SubtitleConfig, SubtitleCue, SubtitleMetadata } from './subtitles';
import { NullTarget, PathedTarget, Target, TargetRequest } from './target';
import { HLS_MIME_TYPE } from './hls/hls-misc';
import { WebvttMuxer } from './hls/hls-webvtt';
import { IsobmffMuxer } from './isobmff/isobmff-muxer';

/** @internal */
export type PipelineTrackData = {
	track: OutputTrack;
	packets: EncodedPacket[];
	playlist: Playlist;
	// We must store it on the TrackData, reading it directly from the track leads to async race conditions!
	closed: boolean;
	info: {
		type: 'video';
		decoderConfig: VideoDecoderConfig;
		inBandParameterSets: boolean;
		primingPacket: EncodedPacket | null;
	} | {
		type: 'audio';
		decoderConfig: AudioDecoderConfig;
		primingPacket: EncodedPacket | null;
	} | {
		type: 'subtitle';
		cues: SubtitleCue[];
		config: SubtitleConfig | null;
	};
};
type PipelineVideoTrackData = PipelineTrackData & { info: { type: 'video' } };
type PipelineAudioTrackData = PipelineTrackData & { info: { type: 'audio' } };
type PipelineSubtitleTrackData = PipelineTrackData & { info: { type: 'subtitle' } };

/** @internal */
export type PipelineSegment = {
	path: string;
	duration: number;
	timestamp: number;
	byteSize: number;
	byteOffset: number | null;
	info: HlsOutputSegmentInfo | null;
	parts: SegmentPart[] | null;
};

/** @internal */
export type Playlist = {
	id: number;
	path: string;
	tracks: OutputTrack[];
	segmentFormat: OutputFormat;

	currentSegmentStartTimestamp: number | null;
	currentSegmentStartTimestampIsFixed: boolean;
	nextSegmentId: number;
	initSegment: PipelineSegment | null;
	indexRange: ByteRange | null;
	writtenSegments: PipelineSegment[];
	/** Summed duration of `writtenSegments`, maintained on append and eviction. */
	windowDuration: number;
	peakBitrate: number | null;
	averageBitrate: number | null;
	mediaSequence: number;
	done: boolean;

	// Subtitle playlists only: their segments are cut on exactly these media boundaries, so a player
	// can switch renditions at any segment.
	subtitleBoundaries: { timestamp: number; duration: number }[] | null;

	singleFile: {
		target: Target;
		path: string;
		nextOffset: number;
		info: HlsOutputSegmentInfo;
		/**
		 * Used for the special-cased logic where single file mode is enabled with fMP4. In this case, we write out a
		 * segments file which is also a perfectly valid standalone fMP4 valid.
		 */
		fragmentedIsobmffOutput: FragmentedIsobmffOutput | null;
	} | null;

	bitrateCache: {
		processedCount: number;
		cachedGtd: number;
		totalBytes: number;
		totalDuration: number;
		peakBitrate: number;
	} | null;

	// For HLS, having a single mutex is too coarse. Every playlist is basically independent and therefore we can have
	// a per-playlist mutex instead of a per-muxer one. This means two packets from different playlists coming in don't
	// block each other.
	mutex: AsyncMutex;
};

type PlaylistDeclaration = {
	playlist: Playlist;
	groupId: string | null;
	noUri: boolean;
	references: PlaylistDeclaration[];
};

const SUBTITLE_GROUP_ID = 'subtitles';

type FragmentedIsobmffOutput = {
	output: Output;
	videoSource: EncodedVideoPacketSource | null;
	audioSource: EncodedAudioPacketSource | null;
	subtitleSource: SubtitleCueSource | null;
	firstMoofPosition: number | null;
	currentFileSize: number;
};

const segmentVideoMetadata = (videoTrack: PipelineVideoTrackData): VideoTrackMetadata => ({
	...videoTrack.track.metadata,
	// A segment output re-muxes packets whose SEI is already spliced in, so it must not inherit the
	// track-wide caption declaration: a segment may legitimately hold none.
	closedCaptions: undefined,
	decoderConfig: videoTrack.info.decoderConfig,
	primingPacket: videoTrack.info.primingPacket ?? undefined,
});

const segmentAudioMetadata = (audioTrack: PipelineAudioTrackData): AudioTrackMetadata => ({
	...audioTrack.track.metadata,
	decoderConfig: audioTrack.info.decoderConfig,
	primingPacket: audioTrack.info.primingPacket ?? undefined,
});

// One output for a playlist's whole single file, rather than one per segment. The caller adds the
// tracks and starts it.
const openFragmentedIsobmffOutput = (segmentFormat: OutputFormat, target: Target): FragmentedIsobmffOutput => {
	const fragmentedIsobmffOutput: FragmentedIsobmffOutput = {
		output: new Output({ format: segmentFormat, target }),
		videoSource: null,
		audioSource: null,
		subtitleSource: null,
		firstMoofPosition: null,
		currentFileSize: 0,
	};

	target.on('write', ({ end }) => {
		fragmentedIsobmffOutput.currentFileSize = Math.max(fragmentedIsobmffOutput.currentFileSize, end);
	});

	// Make sure it never auto-finalizes fragments for us; we take full control of fragment
	// finalization to line it up perfectly with segments
	const muxer = fragmentedIsobmffOutput.output._muxer as IsobmffMuxer;
	muxer.minimumFragmentDuration = Infinity;

	// Intercept the first moof to determine init segment size
	const originalOnMoof = muxer.formatOptions.onMoof;
	muxer.formatOptions.onMoof = (data, position, timestamp) => {
		fragmentedIsobmffOutput.firstMoofPosition = position;
		originalOnMoof?.(data, position, timestamp);
		muxer.formatOptions.onMoof = originalOnMoof;
	};

	return fragmentedIsobmffOutput;
};

// Cuts one fragment and returns its size. Everything before the first `moof` is the init segment, so
// its extent is only known once that fragment exists.
const finalizeFragmentedIsobmffSegment = async (playlist: Playlist): Promise<number> => {
	const singleFile = playlist.singleFile;
	assert(singleFile?.fragmentedIsobmffOutput);

	const muxer = singleFile.fragmentedIsobmffOutput.output._muxer as IsobmffMuxer;
	await muxer.forceFragmentFinalization();

	if (singleFile.fragmentedIsobmffOutput.firstMoofPosition !== null && !playlist.initSegment) {
		playlist.initSegment = {
			path: singleFile.path,
			duration: 0,
			timestamp: 0,
			byteSize: singleFile.fragmentedIsobmffOutput.firstMoofPosition,
			byteOffset: 0,
			info: null,
			parts: null,
		};
		singleFile.nextOffset = singleFile.fragmentedIsobmffOutput.firstMoofPosition;
	}

	return singleFile.fragmentedIsobmffOutput.currentFileSize - singleFile.nextOffset;
};

export class SegmentPipelineMuxer extends Muxer implements HlsManifestEmitterHost {
	options: SegmentedOutputFormatOptions;
	getPlaylistPath: NonNullable<HlsOutputFormatOptions['getPlaylistPath']>;
	getSegmentPath: NonNullable<HlsOutputFormatOptions['getSegmentPath']>;
	getInitPath: NonNullable<HlsOutputFormatOptions['getInitPath']>;

	targetSegmentDuration: number;
	trackDatas: PipelineTrackData[] = [];
	singleFilePerPlaylist: boolean;
	separateRenditions: boolean;
	isLive: boolean;
	maxLiveSegmentCount: number;
	partDuration: number | null;
	isRelativeToUnixEpoch = false;
	globalTargetDuration: number;
	numWrittenMasterPlaylists = 0;

	playlists: Playlist[] = [];
	playlistDeclarations: PlaylistDeclaration[] = [];
	subtitlePlaylists: Playlist[] = [];
	subtitleBoundarySource: Playlist | null = null;

	/**
	 * Manifest emitters fed by the segment-cutting pipeline. The default
	 * configuration always includes one {@link HlsManifestEmitter} so HLS
	 * output stays byte-identical to the pre-extraction implementation.
	 *
	 * `AdaptiveOutputFormat` constructs the muxer with a different list
	 * (HLS + DASH, optionally + I-frame trick-play, etc.) — same segment
	 * pipeline, multiple manifest formats fed off the same lifecycle.
	 */
	private manifestEmitters: ManifestEmitter[];

	constructor(
		output: Output,
		options: SegmentedOutputFormatOptions,
		emitterFactory: (muxer: SegmentPipelineMuxer) => ManifestEmitter[],
	) {
		if (!(output._target instanceof PathedTarget)) {
			throw new TypeError('HLS outputs require `OutputOptions.target` to be a PathedTarget.');
		}

		super(output);

		this.options = options;
		this.targetSegmentDuration = options.targetDuration ?? 2;
		this.singleFilePerPlaylist = options.singleFilePerPlaylist ?? false;
		this.separateRenditions = options.separateRenditions ?? false;
		this.isLive = options.live ?? false;
		this.maxLiveSegmentCount = options.maxLiveSegmentCount ?? Infinity;
		this.partDuration = options.partDuration ?? null;
		this.globalTargetDuration = this.targetSegmentDuration;

		this.getPlaylistPath = options.getPlaylistPath
			?? (({ n }) => `playlist-${n}.m3u8`);
		this.getSegmentPath = options.getSegmentPath
			?? (info => info.isSingleFile
				? `segments-${info.playlist.n}${info.format.fileExtension}`
				: `segment-${info.playlist.n}-${info.n}${info.format.fileExtension}`);
		this.getInitPath = options.getInitPath
			?? (playlist => `init-${playlist.n}${playlist.segmentFormat.fileExtension}`);

		this.manifestEmitters = emitterFactory(this);
	}

	/**
	 * Fan an event out to every registered manifest emitter, awaiting each
	 * in turn so that emitters that read shared state see prior emitters'
	 * mutations (e.g. `peakBitrate` populated by HLS before DASH reads it).
	 */
	private async broadcast<E extends keyof ManifestEmitter>(
		event: E,
		...args: Parameters<NonNullable<ManifestEmitter[E]>>
	): Promise<void> {
		for (const emitter of this.manifestEmitters) {
			const handler = emitter[event] as undefined | ((...a: unknown[]) => unknown);
			if (handler) {
				await handler.apply(emitter, args);
			}
		}
	}

	/** @internal Routed through the muxer so it stays the single owner of the
	 * master-playlist write counter. */
	noteMasterPlaylistWritten() {
		this.numWrittenMasterPlaylists++;
	}

	/** @internal Exposes the muxer's master-playlist mutex to the manifest
	 * emitter without leaking the underlying {@link AsyncMutex}. */
	acquireMutex() {
		return this.mutex.acquire();
	}

	async start(): Promise<void> {
		const release = await this.mutex.acquire();

		const someRelative = this.output.tracks.some(t => t.metadata.isRelativeToUnixEpoch);
		const someNotRelative = this.output.tracks.some(t => !t.metadata.isRelativeToUnixEpoch);
		if (someRelative && someNotRelative) {
			throw new Error(
				'All tracks must agree on `relativeToUnixEpoch`: some tracks are relative to the Unix epoch and some'
				+ ' are not.',
			);
		}
		this.isRelativeToUnixEpoch = someRelative;

		// Upon starting, we now need to assign the tracks to separate playlists. This assignment will make use of the
		// track pairability information provided by the user as well as other metadata specified on the tracks. The
		// resulting master playlist should preserve track pairability; meaning that all tracks that are pairable
		// remain pairable, and no two tracks become pairable that are meant to be mutually exclusive.
		// The algorithm determines "groups" by enumerating all pairable tracks for each track, and then materializes
		// each group either as #EXT-X-MEDIA tags or top-level #EXT-X-STREAM-INF tags. The algorithm is biased towards
		// video being the top-level grouping, since that's the standard practice.

		const groupAssignment = new Map<OutputTrack, string[]>();
		const groups: {
			name: string;
			key: string;
			tracks: OutputTrack[];
			needsEmit: boolean;
			firstNoUri: boolean;
		}[] = [];

		let hasVideo = false;
		let illegalPairingDetected = false;
		let keyPacketsOnlyPairingWarned = false;

		// First, let's build the "sibling" groups induced by track pairability
		for (const track of this.output.tracks) {
			if (track.type === 'video') {
				hasVideo = true;
			}

			// Subtitles are never muxed into a media segment, so they take no part in pairing.
			if (track.isSubtitleTrack()) {
				continue;
			}

			const pairableGroups = new Map<MediaCodec, OutputTrack[]>();

			for (const otherTrack of this.output.tracks) {
				if (track === otherTrack || otherTrack.isSubtitleTrack()) {
					continue;
				}

				if (!track.canBePairedWith(otherTrack)) {
					continue;
				}

				if (track.type === otherTrack.type) {
					if (!illegalPairingDetected) {
						Logging._warn(
							`Illegal pairing of two ${track.type} tracks detected, which is not possible in HLS;`
							+ ` treating them as unpaired.`,
						);
						illegalPairingDetected = true;
					}

					continue;
				}

				// Key-packets-only tracks can neither pair with nor be paired with other tracks
				if (
					(track.isVideoTrack() && track.metadata.hasOnlyKeyPackets)
					|| (otherTrack.isVideoTrack() && otherTrack.metadata.hasOnlyKeyPackets)
				) {
					if (!keyPacketsOnlyPairingWarned) {
						Logging._warn(
							`A key-packets-only video track is pairable with another track, which is not`
							+ ` possible in HLS; treating them as unpaired.`,
						);
						keyPacketsOnlyPairingWarned = true;
					}

					continue;
				}

				let groupTracks = pairableGroups.get(otherTrack.source._codec);
				if (!groupTracks) {
					pairableGroups.set(otherTrack.source._codec, groupTracks = []);
				}

				groupTracks.push(otherTrack);
			}

			for (const [, pairableTracks] of pairableGroups) {
				const key = pairableTracks.map(x => x.id).join('-');
				const group = groups.find(x => x.key === key);
				if (!group) {
					groups.push({
						name: pairableTracks[0]!.type + '-' + (groups.length + 1),
						key,
						tracks: pairableTracks,
						needsEmit: false,
						firstNoUri: false,
					});
				}

				let assignedGroups = groupAssignment.get(track);
				if (!assignedGroups) {
					groupAssignment.set(track, assignedGroups = []);
				}
				assignedGroups.push(key);
			}
		}

		const mainType: TrackType = hasVideo ? 'video' : 'audio';

		const variantStreams: {
			tracks: OutputTrack[];
			linkedGroup: typeof groups[number] | null;
		}[] = [];

		const unpairedVideoTracks: OutputTrack[] = [];
		const unpairedAudioTracks: OutputTrack[] = [];

		// Now, create the top-level variant streams
		for (const track of this.output.tracks) {
			const assignedGroupKeys = groupAssignment.get(track);
			if (assignedGroupKeys) {
				assert(assignedGroupKeys.length > 0);

				if (track.type !== mainType) {
					continue;
				}

				for (const key of assignedGroupKeys) {
					const group = groups.find(x => x.key === key);
					assert(group);

					if (!this.separateRenditions && assignedGroupKeys.length === 1 && group.tracks.length === 1) {
						const otherGroupKeys = groupAssignment.get(group.tracks[0]!);
						assert(otherGroupKeys !== undefined);

						if (otherGroupKeys.length === 1) {
							const otherGroup = groups.find(x => x.key === otherGroupKeys[0]!)!;

							if (otherGroup.tracks.length === 1) {
								assert(otherGroup.tracks[0] === track);

								variantStreams.push({
									tracks: [track, group.tracks[0]!],
									linkedGroup: null,
								});
								continue;
							}
						}
					}

					variantStreams.push({
						tracks: [track],
						linkedGroup: group,
					});
					group.needsEmit = true;
				}
			} else {
				if (track.type === 'video') {
					unpairedVideoTracks.push(track);
				} else if (track.type === 'audio') {
					unpairedAudioTracks.push(track);
				}
			}
		}

		const getMetadataKeyForTrack = ({ metadata }: OutputTrack) => {
			let key = '';
			key += `${metadata.languageCode ?? UNDETERMINED_LANGUAGE}-`;
			key += `${metadata.name ?? ''}-`;
			key += `${metadata.disposition?.default ?? true}-`;
			key += `${metadata.disposition?.primary ?? false}-`;
			key += `${metadata.disposition?.forced ?? false}-`;

			return key;
		};

		// Video tracks that can't be paired with any other track always live on the top-level, the question is just if
		// they need to be separated into #EXT-X-MEDIA tags or not
		if (unpairedVideoTracks.length > 0) {
			const uniqueMetadata = new Set(unpairedVideoTracks.map(getMetadataKeyForTrack));

			if (uniqueMetadata.size > 1) {
				// They differ in metadata, emit as group
				const group: typeof groups[number] = {
					key: unpairedVideoTracks.map(x => x.id).join('-'),
					name: 'video-' + (groups.length + 1),
					tracks: unpairedVideoTracks,
					needsEmit: true,
					firstNoUri: true,
				};
				groups.push(group);

				variantStreams.push({
					tracks: [unpairedVideoTracks[0]!],
					linkedGroup: group,
				});
			} else {
				for (const track of unpairedVideoTracks) {
					variantStreams.push({
						tracks: [track],
						linkedGroup: null,
					});
				}
			}
		}

		// Audio tracks that can't be paired with any other track always live on the top-level, the question is just if
		// they need to be separated into #EXT-X-MEDIA tags or not
		if (unpairedAudioTracks.length > 0) {
			const uniqueMetadata = new Set(unpairedAudioTracks.map(getMetadataKeyForTrack));

			if (uniqueMetadata.size > 1) {
				// They differ in metadata, emit as group
				const group: typeof groups[number] = {
					key: unpairedAudioTracks.map(x => x.id).join('-'),
					name: 'audio-' + (groups.length + 1),
					tracks: unpairedAudioTracks,
					needsEmit: true,
					firstNoUri: true,
				};
				groups.push(group);

				variantStreams.push({
					tracks: [unpairedAudioTracks[0]!],
					linkedGroup: group,
				});
			} else {
				for (const track of unpairedAudioTracks) {
					variantStreams.push({
						tracks: [track],
						linkedGroup: null,
					});
				}
			}
		}

		const deduceSegmentFormat = (tracks: OutputTrack[]) => {
			const codecs: MediaCodec[] = [];
			let videoCount = 0;
			let audioCount = 0;
			let subtitleCount = 0;
			let requiresTransformationMetadata = false;

			let candidate: OutputFormat | null = null;
			let candidateScore = -Infinity;

			for (const track of tracks) {
				if (track.isVideoTrack()) {
					videoCount++;
					requiresTransformationMetadata ||= (track.metadata.rotation ?? 0) !== 0
						|| !!track.metadata.flip
						|| !!track.metadata.transformationMatrix;
				} else if (track.isAudioTrack()) {
					audioCount++;
				} else {
					subtitleCount++;
				}

				codecs.push(track.source._codec);
			}

			// WebVTT comes first so it wins the tie for a subtitle playlist against a configured format
			// that also takes subtitle tracks; its zero media capacity keeps it out of every other playlist.
			for (const format of [WEBVTT_SEGMENT_FORMAT, ...toArray(this.options.segmentFormat)]) {
				const supportedCodecs = format.getSupportedCodecs();
				const trackCounts = format.getSupportedTrackCounts();

				if (codecs.some(codec => !supportedCodecs.includes(codec))) {
					continue;
				}

				if (videoCount < trackCounts.video.min || videoCount > trackCounts.video.max) {
					continue;
				}

				if (audioCount < trackCounts.audio.min || audioCount > trackCounts.audio.max) {
					continue;
				}

				if (subtitleCount < trackCounts.subtitle.min || subtitleCount > trackCounts.subtitle.max) {
					continue;
				}

				let score = 0;
				if (requiresTransformationMetadata && format.supportsVideoTransformationMetadata) {
					score++;
				}

				if (score > candidateScore) {
					candidate = format;
					candidateScore = score;
				}
			}

			// We must find a format. If no format is found, that means we incorrectly gated track creation and
			// assignment at an earlier step.
			assert(candidate);

			return candidate;
		};

		const registerPlaylist = async (tracks: OutputTrack[]) => {
			const isSubtitle = tracks[0]!.isSubtitleTrack();
			if (tracks.some(track => this.playlists.some(playlist => playlist.tracks.includes(track)))) {
				throw new Error('Internal error: track is already registered in a playlist.'); // Should be unreachable
			}

			const format = deduceSegmentFormat(tracks);

			const id = this.playlists.length + 1;
			const path = await this.getPlaylistPath({
				n: id,
				tracks,
				segmentFormat: format,
			});
			validatePlaylistPath(path);

			const playlist: Playlist = {
				id: this.playlists.length + 1,
				path,
				tracks,
				segmentFormat: format,
				currentSegmentStartTimestamp: null,
				currentSegmentStartTimestampIsFixed: false,
				nextSegmentId: 1,
				initSegment: null,
				indexRange: null,
				writtenSegments: [],
				windowDuration: 0,
				peakBitrate: null,
				averageBitrate: null,
				mediaSequence: 0,
				done: false,
				subtitleBoundaries: isSubtitle ? [] : null,
				singleFile: null,
				mutex: new AsyncMutex(),
				bitrateCache: null,
			};
			this.playlists.push(playlist);

			if (isSubtitle) {
				this.subtitlePlaylists.push(playlist);
			}

			return playlist;
		};

		// Now, finally let's create all declarations. Each declaration maps to one #EXT-X-MEDIA or #EXT-X-STREAM-INF
		// tag in the final master playlist.
		for (const group of groups) {
			if (!group.needsEmit) {
				continue;
			}

			for (let i = 0; i < group.tracks.length; i++) {
				const track = group.tracks[i]!;

				let playlist = this.playlists.find(x => x.tracks[0]!.id === track.id);
				playlist ??= await registerPlaylist([track]);

				this.playlistDeclarations.push({
					playlist,
					groupId: group.name,
					noUri: group.firstNoUri && i === 0,
					references: [],
				});
			}
		}

		const subtitleTracks = this.output.tracks.filter(track => track.isSubtitleTrack());
		const subtitleDeclarations: PlaylistDeclaration[] = [];

		for (const track of subtitleTracks) {
			const playlist = await registerPlaylist([track]);
			const declaration: PlaylistDeclaration = {
				playlist,
				groupId: SUBTITLE_GROUP_ID,
				noUri: false,
				references: [],
			};

			subtitleDeclarations.push(declaration);
			this.playlistDeclarations.push(declaration);
		}

		for (const variant of variantStreams) {
			// Since tracks can only be assigned to one playlist, the first track's ID acts as a "playlist key"
			let playlist = this.playlists.find(x => x.tracks[0]!.id === variant.tracks[0]!.id);
			playlist ??= await registerPlaylist(variant.tracks);

			this.playlistDeclarations.push({
				playlist,
				groupId: null,
				noUri: false,
				references: [
					...(variant.linkedGroup
						? this.playlistDeclarations.filter(x => x.groupId === variant.linkedGroup!.name)
						: []),
					...subtitleDeclarations,
				],
			});
		}

		if (subtitleTracks.length > 0) {
			const mediaPlaylists = this.playlists.filter(x => x.subtitleBoundaries === null);
			const source = mediaPlaylists.find(x => x.tracks.some(track => track.isVideoTrack()))
				?? mediaPlaylists[0];

			if (!source) {
				throw new Error(
					'Subtitle tracks require at least one video or audio track, as subtitle segments are cut on the'
					+ ' media segment boundaries. Add a video or audio track.',
				);
			}

			this.subtitleBoundarySource = source;
		}

		for (const track of this.output.tracks) {
			if (track.isVideoTrack() && track.metadata.decoderConfig) {
				this.getVideoTrackData(
					track,
					track.metadata.primingPacket ?? null,
					{ decoderConfig: track.metadata.decoderConfig },
				);
			} else if (track.isAudioTrack() && track.metadata.decoderConfig) {
				this.getAudioTrackData(
					track,
					track.metadata.primingPacket ?? null,
					{ decoderConfig: track.metadata.decoderConfig },
				);
			} else if (track.isSubtitleTrack()) {
				// Registered up front so a track that never produces a cue still yields an (empty) rendition
				// instead of silently vanishing from the manifests.
				this.getSubtitleTrackData(track);
			}
		}

		await this.broadcast('onStart');

		release();
	}

	async getMimeType(): Promise<string> {
		return HLS_MIME_TYPE;
	}

	private allTracksAreKnown(playlist: Playlist) {
		for (const track of playlist.tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	override async onTrackClose(track: OutputTrack) {
		const trackData = this.trackDatas.find(x => x.track === track);
		if (trackData) {
			trackData.closed = true;
		}

		const playlist = this.playlists.find(x => x.tracks.includes(track));
		assert(playlist); // If there isn't one then the assignment algo failed innit

		const release = await playlist.mutex.acquire();

		try {
			if (playlist.subtitleBoundaries) {
				await this.advanceSubtitlePlaylist(playlist);
			} else {
				await this.advancePlaylist(playlist);
			}
		} finally {
			release();
		}
	}

	getVideoTrackData(track: OutputVideoTrack, packet: EncodedPacket | null, meta?: EncodedVideoChunkMetadata) {
		let trackData = this.trackDatas.find(x => x.track === track) as PipelineVideoTrackData;
		if (trackData) {
			return trackData;
		}

		validateVideoChunkMetadata(meta, track.source._codec);

		assert(meta);
		assert(meta?.decoderConfig);

		const playlists = this.playlists.filter(x => x.tracks.includes(track));
		assert(playlists.length === 1);

		trackData = {
			track,
			packets: [],
			playlist: playlists[0]!,
			closed: false,
			info: {
				type: 'video',
				decoderConfig: meta.decoderConfig,
				inBandParameterSets: !meta.decoderConfig.description
					|| track.metadata.parameterSets === 'inBand',
				primingPacket: packet,
			},
		};
		this.trackDatas.push(trackData);

		return trackData;
	}

	getAudioTrackData(track: OutputAudioTrack, packet: EncodedPacket | null, meta?: EncodedAudioChunkMetadata) {
		let trackData = this.trackDatas.find(x => x.track === track) as PipelineAudioTrackData;
		if (trackData) {
			return trackData;
		}

		validateAudioChunkMetadata(meta, track.source._codec);

		assert(meta);
		assert(meta?.decoderConfig);

		const playlists = this.playlists.filter(x => x.tracks.includes(track));
		assert(playlists.length === 1);

		trackData = {
			track,
			packets: [],
			playlist: playlists[0]!,
			closed: false,
			info: {
				type: 'audio',
				decoderConfig: meta.decoderConfig,
				primingPacket: packet,
			},
		};
		this.trackDatas.push(trackData);

		return trackData;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		const trackData = this.getVideoTrackData(track, packet, meta);
		const playlist = trackData.playlist;

		const release = await playlist.mutex.acquire();

		try {
			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');
			trackData.packets.push(packet);

			if (playlist.currentSegmentStartTimestamp === null) {
				playlist.currentSegmentStartTimestamp = packet.timestamp;
			} else if (!playlist.currentSegmentStartTimestampIsFixed) {
				playlist.currentSegmentStartTimestamp = Math.min(
					playlist.currentSegmentStartTimestamp,
					packet.timestamp,
				);
			}

			await this.advancePlaylist(playlist);
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const trackData = this.getAudioTrackData(track, packet, meta);
		const playlist = trackData.playlist;

		const release = await playlist.mutex.acquire();

		try {
			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');
			trackData.packets.push(packet);

			if (playlist.currentSegmentStartTimestamp === null) {
				playlist.currentSegmentStartTimestamp = packet.timestamp;
			} else if (!playlist.currentSegmentStartTimestampIsFixed) {
				playlist.currentSegmentStartTimestamp = Math.min(
					playlist.currentSegmentStartTimestamp,
					packet.timestamp,
				);
			}

			await this.advancePlaylist(playlist);
		} finally {
			release();
		}
	}

	getSubtitleTrackData(track: OutputSubtitleTrack, meta?: SubtitleMetadata) {
		let trackData = this.trackDatas.find(x => x.track === track) as PipelineSubtitleTrackData;
		if (trackData) {
			trackData.info.config ??= meta?.config ?? null;
			return trackData;
		}

		const playlists = this.playlists.filter(x => x.tracks.includes(track));
		assert(playlists.length === 1);

		trackData = {
			track,
			packets: [],
			playlist: playlists[0]!,
			closed: false,
			info: {
				type: 'subtitle',
				cues: [],
				config: meta?.config ?? null,
			},
		};
		this.trackDatas.push(trackData);

		return trackData;
	}

	async addSubtitleCue(
		track: OutputSubtitleTrack,
		cue: SubtitleCue,
		meta?: SubtitleMetadata,
	) {
		const trackData = this.getSubtitleTrackData(track, meta);
		const playlist = trackData.playlist;

		const release = await playlist.mutex.acquire();

		try {
			this.validateTimestamp(track, cue.timestamp, true);
			trackData.info.cues.push(cue);

			await this.advanceSubtitlePlaylist(playlist);
		} finally {
			release();
		}
	}

	async advancePlaylist(playlist: Playlist) {
		assert(!playlist.done);

		if (!this.allTracksAreKnown(playlist)) {
			return;
		}

		const trackDatas = this.trackDatas.filter(x => playlist.tracks.includes(x.track));

		if (playlist.currentSegmentStartTimestamp === null) {
			// All tracks are known but we never received any data. Tracks that declared themselves up front are known
			// before their first packet, so we can only call it a day once they're actually closed.
			if (trackDatas.every(x => x.closed)) {
				await this.onPlaylistDone(playlist);
			}

			return;
		}

		const videoTrack = trackDatas.find(x => x.info.type === 'video') as PipelineVideoTrackData | undefined;
		const audioTrack = trackDatas.find(x => x.info.type === 'audio') as PipelineAudioTrackData | undefined;

		// Loop in case we can finalize multiple segments
		while (true) {
			// This here is the core segmentation logic. The segmentation logic figures out which packets are to be
			// written into the next segment, and if we can write a segment at all. If tracks are still open and have
			// not provided sufficient media data, no segment will be written. The packets will be added to the segment
			// to maximize its duration AND keep it from exceeding the target duration. This condition is extended with
			// a key frame rule for video, meaning the algorithm must guarantee that every segment with video data
			// begins with a video key frame.
			//
			// The logic is quite complex but is solved in a straight-forward way: all possible permutations of the
			// problem are checked in a nested if-else structure, making sure all cases behave correctly. This was the
			// easiest, least error-prone way I found to express this behavior.

			const currentSegmentEndTimestamp = playlist.currentSegmentStartTimestamp + this.targetSegmentDuration;

			// These store the index (exclusive) until when packets can be added to the next segment
			let videoEndIndex = 0;
			let audioEndIndex = 0;

			if (videoTrack && (!videoTrack.closed || videoTrack.packets.length > 0)) {
				// A video track is active (and maybe an audio track too)
				const allBelow = videoTrack.packets.every(x => x.timestamp < currentSegmentEndTimestamp);

				let bestKeyPacket: EncodedPacket | null = null;
				let bestKeyPacketIndex: number | null = null;

				if (allBelow) {
					if (!videoTrack.closed) {
						// Not enough data yet
						return;
					}
				} else {
					// Find the best key packet timestamp
					for (let i = 0; i < videoTrack.packets.length; i++) {
						const packet = videoTrack.packets[i]!;

						if (bestKeyPacket !== null && packet.timestamp > currentSegmentEndTimestamp) {
							break;
						}

						if (i > 0 && packet.type === 'key') {
							bestKeyPacket = packet;
							bestKeyPacketIndex = i;
						}
					}
				}

				if (bestKeyPacketIndex !== null) {
					videoEndIndex = bestKeyPacketIndex;

					if (audioTrack) {
						// The audio track must go at least until the video key frame
						const index = audioTrack.packets.findIndex(x => x.timestamp >= bestKeyPacket!.timestamp);
						if (index !== -1) {
							audioEndIndex = index;
						} else {
							if (audioTrack.closed) {
								audioEndIndex = audioTrack.packets.length;
							} else {
								return;
							}
						}
					}
				} else {
					if (!videoTrack.closed) {
						return;
					}

					// Include the entire rest of the video (since there's no key frame to split it on)
					videoEndIndex = videoTrack.packets.length;
					const maxIndex = arrayArgmax(videoTrack.packets, x => x.timestamp);
					const maxPacket = videoTrack.packets[maxIndex];
					assert(maxPacket);

					if (audioTrack) {
						if (maxPacket.timestamp < currentSegmentEndTimestamp) {
							// The audio must go until at least the start of the next segment
							const index = audioTrack.packets.findIndex(x => x.timestamp >= currentSegmentEndTimestamp);
							if (index !== -1) {
								audioEndIndex = index;
							} else {
								if (audioTrack.closed) {
									audioEndIndex = audioTrack.packets.length;
								} else {
									return;
								}
							}
						} else {
							// The audio must go beyond the last video packet
							const index = audioTrack.packets.findIndex(x => x.timestamp > maxPacket.timestamp);
							if (index !== -1) {
								audioEndIndex = index;
							} else {
								if (audioTrack.closed) {
									audioEndIndex = audioTrack.packets.length;
								} else {
									return;
								}
							}
						}
					}
				}
			} else if (audioTrack && (!audioTrack.closed || audioTrack.packets.length > 0)) {
				// There's only an audio track active

				const allBelow = audioTrack.packets.every(x => x.timestamp < currentSegmentEndTimestamp);

				if (allBelow) {
					if (audioTrack.closed) {
						// We can write all packets since they're all below
						audioEndIndex = audioTrack.packets.length;
					} else {
						// We don't know enough packets yet
						return;
					}
				} else {
					// Aim to make the segment at most as long as desired
					const index = findLastIndex(audioTrack.packets, x => x.timestamp <= currentSegmentEndTimestamp);
					audioEndIndex = Math.max(index, 1); // Always include at least the first packet
				}
			}

			if (videoEndIndex === 0 && audioEndIndex === 0) {
				// No more segments to write - if all tracks are closed, this playlist is done
				const allClosed = trackDatas.every(x => x.closed);
				if (allClosed) {
					await this.onPlaylistDone(playlist);
				}

				return;
			}

			// We can finalize a new segment!

			let segmentInfo: HlsOutputSegmentInfo | null = null;
			let relativeSegmentPath: string;
			let fullSegmentPath: string;

			assert(this.output._target instanceof PathedTarget);
			const pathedTarget = this.output._target;

			if (this.singleFilePerPlaylist) {
				if (playlist.singleFile === null) {
					// INTENTIONALLY shadow the outside `segmentInfo` because we don't want to set it.
					// In single-file mode, onSegment is called once in onPlaylistDone instead of per-segment,
					// so the outer `segmentInfo` intentionally stays null in this case.
					const segmentInfo: HlsOutputSegmentInfo = {
						n: playlist.nextSegmentId,
						format: playlist.segmentFormat,
						isSingleFile: true,
						playlist: toPlaylistInfo(playlist),
						parts: null,
					};

					relativeSegmentPath = await this.getSegmentPath(segmentInfo);
					validateSegmentPath(relativeSegmentPath);

					fullSegmentPath = joinPaths(
						joinPaths(pathedTarget.rootPath, playlist.path),
						relativeSegmentPath,
					);

					const target = await this.output._getTarget({
						path: fullSegmentPath,
						isRoot: false,
						mimeType: playlist.segmentFormat.mimeType,
					});

					let fragmentedIsobmffOutput: FragmentedIsobmffOutput | null = null;
					if (playlist.segmentFormat._isFragmentedIsobmff()) {
						// HARDCODED SPECIAL CASE: Single file mode with fragmented ISOBMFF. Instead of merely creating
						// a single file that's the concatenation of a bunch of smaller files, here we actually produce
						// one single fMP4 file that holds all segment media data. The result is a segments file that is
						// playable standalone!

						fragmentedIsobmffOutput = openFragmentedIsobmffOutput(playlist.segmentFormat, target);

						// Add video track
						if (videoTrack) {
							fragmentedIsobmffOutput.videoSource = new EncodedVideoPacketSource(
								(videoTrack.track as OutputVideoTrack).source._codec,
							);
							fragmentedIsobmffOutput.output.addVideoTrack(
								fragmentedIsobmffOutput.videoSource,
								segmentVideoMetadata(videoTrack),
							);
						}

						// Add audio track
						if (audioTrack) {
							fragmentedIsobmffOutput.audioSource = new EncodedAudioPacketSource(
								(audioTrack.track as OutputAudioTrack).source._codec,
							);
							fragmentedIsobmffOutput.output.addAudioTrack(
								fragmentedIsobmffOutput.audioSource,
								segmentAudioMetadata(audioTrack),
							);
						}

						await fragmentedIsobmffOutput.output.start();
					} else {
						target._start();
					}

					playlist.singleFile = {
						target,
						path: relativeSegmentPath,
						nextOffset: 0,
						info: segmentInfo,
						fragmentedIsobmffOutput,
					};
				} else {
					relativeSegmentPath = playlist.singleFile.path;
					fullSegmentPath = joinPaths(
						joinPaths(pathedTarget.rootPath, playlist.path),
						relativeSegmentPath,
					);
				}
			} else {
				segmentInfo = {
					n: playlist.nextSegmentId,
					format: playlist.segmentFormat,
					isSingleFile: false,
					playlist: toPlaylistInfo(playlist),
					parts: null,
				};

				relativeSegmentPath = await this.getSegmentPath(segmentInfo);
				validateSegmentPath(relativeSegmentPath);

				fullSegmentPath = joinPaths(joinPaths(pathedTarget.rootPath, playlist.path), relativeSegmentPath);
				playlist.nextSegmentId++;
			}

			let segmentSize = 0;
			let outputTarget: Target | null = null;
			let maxEndTimestamp = -Infinity;
			const partStarts: { timestamp: number; independent: boolean }[] = [];
			// Writer positions at the end of every part but the last, which ends with the segment
			const partEnds: number[] = [];

			let output: Output | null = null;
			let videoSource: EncodedVideoPacketSource | null = null;
			let audioSource: EncodedAudioPacketSource | null = null;

			try {
				if (playlist.singleFile?.fragmentedIsobmffOutput) {
					output = playlist.singleFile.fragmentedIsobmffOutput.output;
					videoSource = playlist.singleFile.fragmentedIsobmffOutput.videoSource;
					audioSource = playlist.singleFile.fragmentedIsobmffOutput.audioSource;
				} else {
					// Create the output for this segment
					output = new Output({
						format: playlist.segmentFormat,
						target: new PathedTarget(
							fullSegmentPath,
							async (request: TargetRequest) => {
								const proxiedRequest: TargetRequest = {
									...request,
									isRoot: false,
								};

								if (request.isRoot) {
									if (playlist.singleFile) {
										const slice = playlist.singleFile.target.slice(playlist.singleFile.nextOffset);
										slice.on('write', ({ end }) => segmentSize = Math.max(segmentSize, end));

										return slice;
									} else {
										const target = await this.output._getTarget(proxiedRequest);
										outputTarget = target;
										target.on('write', ({ end }) => segmentSize = Math.max(segmentSize, end));

										return target;
									}
								}

								return this.output._getTarget(proxiedRequest);
							},
						),
						initTarget: this.initTargetFor(playlist),
					});

					if (videoTrack) {
						// Always add the track, no matter if it has packets or not (maintains underlying IDs)
						videoSource = new EncodedVideoPacketSource(
							(videoTrack.track as OutputVideoTrack).source._codec,
						);
						output.addVideoTrack(videoSource, segmentVideoMetadata(videoTrack));
					}

					if (audioTrack) {
						// Always add the track, no matter if it has packets or not (maintains underlying IDs)
						audioSource = new EncodedAudioPacketSource(
							(audioTrack.track as OutputAudioTrack).source._codec,
						);
						output.addAudioTrack(audioSource, segmentAudioMetadata(audioTrack));
					}

					await output.start();
				}

				// Add all of the packets

				const muxer = output._muxer;
				const partDuration = muxer instanceof IsobmffMuxer && muxer.isFragmented
					? this.options.partDuration
					: undefined;

				if (partDuration === undefined) {
					if (videoTrack) {
						assert(videoSource);
						const meta = { decoderConfig: videoTrack.info.decoderConfig };

						for (let i = 0; i < videoEndIndex; i++) {
							const packet = videoTrack.packets[i]!;

							await videoSource.add(packet, meta);
							maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
						}
					}

					if (audioTrack) {
						assert(audioSource);
						const meta = { decoderConfig: audioTrack.info.decoderConfig };

						for (let i = 0; i < audioEndIndex; i++) {
							const packet = audioTrack.packets[i]!;

							await audioSource.add(packet, meta);
							maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
						}
					}
				} else {
					assert(playlist.currentSegmentStartTimestamp !== null);
					assert(muxer instanceof IsobmffMuxer);
					const videoMeta = videoTrack && { decoderConfig: videoTrack.info.decoderConfig };
					const audioMeta = audioTrack && { decoderConfig: audioTrack.info.decoderConfig };
					let videoIndex = 0;
					let audioIndex = 0;

					// Tracks go in by timestamp so that each fragment holds every track's samples for its span
					while (videoIndex < videoEndIndex || audioIndex < audioEndIndex) {
						const videoPacket = videoIndex < videoEndIndex ? videoTrack!.packets[videoIndex]! : null;
						const audioPacket = audioIndex < audioEndIndex ? audioTrack!.packets[audioIndex]! : null;
						const isVideo = videoPacket !== null
							&& (audioPacket === null || videoPacket.timestamp <= audioPacket.timestamp);
						const packet = isVideo ? videoPacket : audioPacket!;

						// Cut before the sample that would carry a part past partDuration (RFC 8216bis §4.4.4.9)
						const currentPart = partStarts.at(-1);
						const cutsPart = currentPart !== undefined
							&& (isVideo || !videoTrack)
							&& packet.timestamp + packet.duration > currentPart.timestamp + partDuration + 1e-6;

						if (currentPart === undefined || cutsPart) {
							if (cutsPart) {
								partEnds.push(await muxer.forceFragmentFinalization());
							}

							// A segment always begins on a key frame
							partStarts.push({
								timestamp: packet.timestamp,
								independent: partStarts.length === 0 || !videoTrack || packet.type === 'key',
							});
						} else {
							const partStart = partStarts[partStarts.length - 1]!;
							// Presentation order differs from decode order with B-frames
							partStart.timestamp = Math.min(partStart.timestamp, packet.timestamp);
						}

						if (isVideo) {
							assert(videoSource && videoMeta);
							await videoSource.add(packet, videoMeta);
							videoIndex++;
						} else {
							assert(audioSource && audioMeta);
							await audioSource.add(packet, audioMeta);
							audioIndex++;
						}
						maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
					}
				}

				if (playlist.singleFile?.fragmentedIsobmffOutput) {
					segmentSize = await finalizeFragmentedIsobmffSegment(playlist);
				} else {
					await output.finalize();
				}
			} catch (e) {
				await output?.cancel();
				throw e;
			}

			if (videoEndIndex > 0) {
				assert(videoTrack);
				videoTrack.packets.splice(0, videoEndIndex);
			}
			if (audioEndIndex > 0) {
				assert(audioTrack);
				audioTrack.packets.splice(0, audioEndIndex);
			}

			let minNextTimestamp = Infinity;
			if (videoTrack && videoTrack.packets.length > 0) {
				minNextTimestamp = videoTrack.packets[0]!.timestamp;
			}
			if (audioTrack && audioTrack.packets.length > 0) {
				minNextTimestamp = Math.min(minNextTimestamp, audioTrack.packets[0]!.timestamp);
			}

			const nextSegmentStartTimestamp = minNextTimestamp < Infinity
				? minNextTimestamp
				: maxEndTimestamp; // Happens for the last segment for example
			assert(Number.isFinite(nextSegmentStartTimestamp));

			const segmentDuration = nextSegmentStartTimestamp - playlist.currentSegmentStartTimestamp;
			assert(segmentDuration >= 0);

			let parts: SegmentPart[] | null = null;
			if (partStarts.length > 0) {
				// Only the shared single-file fMP4 output writes absolute positions; a per-segment output starts at 0
				const segmentStartPos = playlist.singleFile?.fragmentedIsobmffOutput
					? playlist.singleFile.nextOffset
					: 0;
				const partOffsets = [0, ...partEnds.map(end => end - segmentStartPos), segmentSize];
				const segmentStartTimestamp = playlist.currentSegmentStartTimestamp;

				parts = partStarts.map((partStart, i) => ({
					offset: partOffsets[i]!,
					size: partOffsets[i + 1]! - partOffsets[i]!,
					duration: (partStarts[i + 1]?.timestamp ?? nextSegmentStartTimestamp)
						- (i === 0 ? segmentStartTimestamp : partStart.timestamp),
					independent: partStart.independent,
				}));
			}

			if (segmentInfo) {
				assert(outputTarget);
				segmentInfo.parts = parts;
				this.options.onSegment?.(outputTarget, segmentInfo);
			}

			playlist.windowDuration += segmentDuration;
			playlist.writtenSegments.push({
				path: relativeSegmentPath,
				duration: segmentDuration,
				timestamp: playlist.currentSegmentStartTimestamp,
				byteSize: segmentSize,
				byteOffset: playlist.singleFile
					? playlist.singleFile.nextOffset
					: null,
				info: segmentInfo ?? null,
				parts,
			});

			this.globalTargetDuration = Math.max(this.globalTargetDuration, segmentDuration);

			if (playlist === this.subtitleBoundarySource) {
				const boundary = { timestamp: playlist.currentSegmentStartTimestamp, duration: segmentDuration };

				// Lock order: a media playlist's mutex is held here, so subtitle work must never take one back.
				for (const subtitlePlaylist of this.subtitlePlaylists) {
					subtitlePlaylist.subtitleBoundaries!.push(boundary);

					const release = await subtitlePlaylist.mutex.acquire();

					try {
						await this.advanceSubtitlePlaylist(subtitlePlaylist);
					} finally {
						release();
					}
				}
			}

			playlist.currentSegmentStartTimestamp = nextSegmentStartTimestamp;
			playlist.currentSegmentStartTimestampIsFixed = true; // After the first segment, the timestamp is now fixed

			if (playlist.singleFile) {
				playlist.singleFile.nextOffset += segmentSize;
			}

			await this.evictLiveSegments(playlist);
		}
	}

	/** The `initTarget` of a playlist's segment outputs: the first segment writes it, the rest reuse it. */
	private initTargetFor(playlist: Playlist) {
		return async (): Promise<Target> => {
			assert(this.output._target instanceof PathedTarget);
			const pathedTarget = this.output._target;

			if (playlist.initSegment) {
				// We already have an init segment from a previous segment
				return new NullTarget();
			}

			if (playlist.singleFile) {
				playlist.initSegment = {
					path: playlist.singleFile.path,
					duration: 0,
					timestamp: 0,
					byteSize: 0,
					byteOffset: 0,
					info: null,
					parts: null,
				};

				const slice = playlist.singleFile.target.slice(playlist.singleFile.nextOffset);
				slice.on('write', ({ end }) => {
					playlist.initSegment!.byteSize = Math.max(playlist.initSegment!.byteSize, end);
				});
				slice.on('finalized', () => {
					playlist.singleFile!.nextOffset = playlist.initSegment!.byteSize;
				});

				return slice;
			} else {
				const playlistInfo = toPlaylistInfo(playlist);
				const initPath = await this.getInitPath(playlistInfo);
				validateInitPath(initPath);

				playlist.initSegment = {
					path: initPath,
					duration: 0,
					timestamp: 0,
					byteSize: 0,
					byteOffset: null,
					info: null,
					parts: null,
				};

				const fullInitPath = joinPaths(
					joinPaths(pathedTarget.rootPath, playlist.path),
					initPath,
				);
				const target = await this.output._getTarget({
					path: fullInitPath,
					isRoot: false,
					mimeType: playlist.segmentFormat.mimeType,
				});
				target.on('write', ({ end }) => {
					playlist.initSegment!.byteSize = Math.max(playlist.initSegment!.byteSize, end);
				});
				target.on('finalized', () => {
					this.options.onInit?.(target, playlistInfo);
				});

				return target;
			}
		};
	}

	private async evictLiveSegments(playlist: Playlist) {
		if (!this.isLive) {
			return;
		}

		while (playlist.writtenSegments.length > this.maxLiveSegmentCount) {
			const popped = playlist.writtenSegments.shift()!;
			playlist.windowDuration -= popped.duration;
			playlist.mediaSequence++;

			if (!this.singleFilePerPlaylist) {
				assert(popped.info);
				this.options.onSegmentPopped?.(popped.path, popped.info);
			}
		}

		await this.broadcast('onSegmentAppended', playlist);
	}

	private async advanceSubtitlePlaylist(playlist: Playlist) {
		const boundaries = playlist.subtitleBoundaries;
		assert(boundaries);

		if (playlist.done) {
			return;
		}

		const trackData = this.trackDatas.find(x => x.track === playlist.tracks[0]) as PipelineSubtitleTrackData;
		assert(trackData);
		const cues = trackData.info.cues;

		while (boundaries.length > 0) {
			const boundary = boundaries[0]!;
			const segmentEnd = boundary.timestamp + boundary.duration;

			// A cue starting at or after the boundary proves every cue of this segment has arrived. Writing
			// before that point would drop cues that are still in flight.
			if (!trackData.closed && !cues.some(cue => cue.timestamp >= segmentEnd)) {
				return;
			}

			boundaries.shift();
			await this.writeSubtitleSegment(playlist, trackData, boundary.timestamp, boundary.duration);
		}

		const moreBoundariesComing = this.subtitleBoundarySource !== null && !this.subtitleBoundarySource.done;
		if (!trackData.closed || moreBoundariesComing) {
			return;
		}

		if (cues.length > 0) {
			// Cues may outlast the media; they get one trailing segment rather than being dropped.
			const start = playlist.currentSegmentStartTimestamp ?? cues[0]!.timestamp;
			const end = cues.reduce((max, cue) => Math.max(max, cue.timestamp + cue.duration), start);
			await this.writeSubtitleSegment(playlist, trackData, start, end - start);
		}

		await this.onPlaylistDone(playlist);
	}

	// A segment format that writes its init to the output's `initTarget` (CMAF) concatenates into a valid
	// single file segment by segment. One that writes `ftyp`/`moov` inline repeats the whole init per
	// segment, so that playlist gets the same standalone-fMP4 treatment `advancePlaylist` gives media:
	// one output for the whole file, one fragment per segment.
	private async openSubtitleSingleFile(playlist: Playlist, trackData: PipelineSubtitleTrackData) {
		assert(this.output._target instanceof PathedTarget);
		const pathedTarget = this.output._target;

		const segmentInfo: HlsOutputSegmentInfo = {
			n: playlist.nextSegmentId,
			format: playlist.segmentFormat,
			isSingleFile: true,
			playlist: toPlaylistInfo(playlist),
			parts: null,
		};

		const relativeSegmentPath = await this.getSegmentPath(segmentInfo);
		validateSegmentPath(relativeSegmentPath);

		const target = await this.output._getTarget({
			path: joinPaths(joinPaths(pathedTarget.rootPath, playlist.path), relativeSegmentPath),
			isRoot: false,
			mimeType: playlist.segmentFormat.mimeType,
		});
		let fragmentedIsobmffOutput: FragmentedIsobmffOutput | null = null;
		if (playlist.segmentFormat._isFragmentedIsobmff()) {
			fragmentedIsobmffOutput = openFragmentedIsobmffOutput(playlist.segmentFormat, target);
			fragmentedIsobmffOutput.subtitleSource = new SubtitleCueSource(
				(trackData.track as OutputSubtitleTrack).source._codec,
			);
			fragmentedIsobmffOutput.output.addSubtitleTrack(
				fragmentedIsobmffOutput.subtitleSource,
				trackData.track.metadata,
			);
			await fragmentedIsobmffOutput.output.start();
		} else {
			target._start();
		}

		playlist.singleFile = {
			target,
			path: relativeSegmentPath,
			nextOffset: 0,
			info: segmentInfo,
			fragmentedIsobmffOutput,
		};
	}

	private async writeSubtitleSegment(
		playlist: Playlist,
		trackData: PipelineSubtitleTrackData,
		timestamp: number,
		duration: number,
	) {
		assert(this.output._target instanceof PathedTarget);
		const pathedTarget = this.output._target;

		const segmentEnd = timestamp + duration;
		// The first segment swallows anything starting before the media did, so early cues aren't lost.
		const segmentStart = playlist.nextSegmentId === 1 ? -Infinity : timestamp;
		const cues = trackData.info.cues.filter(cue => cueOverlapsSegment(cue, segmentStart, segmentEnd));

		if (this.singleFilePerPlaylist && !playlist.singleFile) {
			await this.openSubtitleSingleFile(playlist, trackData);
		}

		let segmentInfo: HlsOutputSegmentInfo | null = null;
		let relativeSegmentPath: string;

		if (playlist.singleFile) {
			// In single-file mode, onSegment is called once in onPlaylistDone instead of per-segment.
			relativeSegmentPath = playlist.singleFile.path;
		} else {
			segmentInfo = {
				n: playlist.nextSegmentId,
				format: playlist.segmentFormat,
				isSingleFile: false,
				playlist: toPlaylistInfo(playlist),
				parts: null,
			};

			relativeSegmentPath = await this.getSegmentPath(segmentInfo);
			validateSegmentPath(relativeSegmentPath);
		}

		const fullSegmentPath = joinPaths(joinPaths(pathedTarget.rootPath, playlist.path), relativeSegmentPath);
		playlist.nextSegmentId++;

		let segmentSize = 0;
		let outputTarget: Target | null = null;

		const persistent = playlist.singleFile?.fragmentedIsobmffOutput ?? null;
		const output = persistent?.output ?? new Output({
			format: playlist.segmentFormat,
			target: new PathedTarget(
				fullSegmentPath,
				async (request: TargetRequest) => {
					if (request.isRoot && playlist.singleFile) {
						const slice = playlist.singleFile.target.slice(playlist.singleFile.nextOffset);
						slice.on('write', ({ end }) => segmentSize = Math.max(segmentSize, end));

						return slice;
					}

					const target = await this.output._getTarget({ ...request, isRoot: false });

					if (request.isRoot) {
						outputTarget = target;
						target.on('write', ({ end }) => segmentSize = Math.max(segmentSize, end));
					}

					return target;
				},
			),
			initTarget: this.initTargetFor(playlist),
		});

		let source: SubtitleCueSource;
		if (persistent) {
			assert(persistent.subtitleSource);
			source = persistent.subtitleSource;
		} else {
			source = new SubtitleCueSource((trackData.track as OutputSubtitleTrack).source._codec);
			output.addSubtitleTrack(source, trackData.track.metadata);
		}

		// Where in the media timeline this segment sits is known to the playlist, not to any track,
		// so it reaches the muxer directly rather than through a source.
		if (playlist.segmentFormat instanceof WebvttSegmentFormat) {
			const webvttMuxer = output._muxer as WebvttMuxer;
			webvttMuxer.segmentStartTimestamp = timestamp;
			webvttMuxer.preamble = trackData.info.config?.description ?? null;
		} else {
			(output._muxer as IsobmffMuxer).subtitleSegmentWindow = { start: timestamp, duration };
		}

		try {
			if (!persistent) {
				await output.start();
			}

			for (const cue of cues) {
				await source.add(cue);
			}

			if (persistent) {
				segmentSize = await finalizeFragmentedIsobmffSegment(playlist);
			} else {
				await output.finalize();
			}
		} catch (e) {
			await output.cancel();
			throw e;
		}

		if (segmentInfo) {
			assert(outputTarget);
			this.options.onSegment?.(outputTarget, segmentInfo);
		}

		// Retain every cue that can still overlap a later segment; they must be repeated there. Dropping
		// only a prefix would let one long cue pin every cue behind it in the buffer for its whole span.
		trackData.info.cues = trackData.info.cues.filter(cue => cueOverlapsSegment(cue, segmentEnd, Infinity));

		playlist.windowDuration += duration;
		playlist.writtenSegments.push({
			path: relativeSegmentPath,
			duration,
			timestamp,
			byteSize: segmentSize,
			byteOffset: playlist.singleFile ? playlist.singleFile.nextOffset : null,
			info: segmentInfo,
			parts: null,
		});

		if (playlist.singleFile) {
			playlist.singleFile.nextOffset += segmentSize;
		}

		this.globalTargetDuration = Math.max(this.globalTargetDuration, duration);
		playlist.currentSegmentStartTimestamp = segmentEnd;

		await this.evictLiveSegments(playlist);
	}

	private async onPlaylistDone(playlist: Playlist) {
		assert(!playlist.done);
		playlist.done = true;

		if (playlist.singleFile) {
			if (playlist.singleFile.fragmentedIsobmffOutput) {
				await playlist.singleFile.fragmentedIsobmffOutput.output.finalize();

				// The index is only written during finalization, so it can't be read before this point.
				const muxer = playlist.singleFile.fragmentedIsobmffOutput.output._muxer as IsobmffMuxer;
				playlist.indexRange = muxer.sidxByteRange;
			} else {
				await playlist.singleFile.target._flush();
				await playlist.singleFile.target._finalize();
			}

			this.options.onSegment?.(playlist.singleFile.target, playlist.singleFile.info);
		}

		await this.broadcast('onPlaylistDone', playlist);
	}

	async finalize() {
		const releases = await Promise.all(this.playlists.map(p => p.mutex.acquire()));
		releases.forEach(release => release());

		for (const trackData of this.trackDatas) {
			trackData.closed = true;
		}

		// Media playlists first: subtitles finish only once the boundary source is done.
		await Promise.all(this.playlists.map(playlist => (
			playlist.done || playlist.subtitleBoundaries ? Promise.resolve() : this.advancePlaylist(playlist)
		)));

		await Promise.all(this.subtitlePlaylists.map(playlist => (
			playlist.done ? Promise.resolve() : this.advanceSubtitlePlaylist(playlist)
		)));

		await this.broadcast('onFinalize');
	}
}

const validatePlaylistPath = (path: string) => {
	if (typeof path !== 'string') {
		throw new TypeError('options.getPlaylistPath must return or resolve to a string');
	}
	if (/[\n\r"]/.test(path)) {
		throw new TypeError(
			'Playlist paths cannot contain line feed, carriage return, or double quote characters.',
		);
	}
};

const validateSegmentPath = (path: string) => {
	if (typeof path !== 'string') {
		throw new TypeError('options.getSegmentPath must return or resolve to a string');
	}
	if (/[\n\r"]/.test(path)) {
		throw new TypeError(
			'Segment paths cannot contain line feed or carriage return characters.',
		);
	}
};

const validateInitPath = (path: string) => {
	if (typeof path !== 'string') {
		throw new TypeError('options.getInitPath must return or resolve to a string');
	}
	if (/[\n\r"]/.test(path)) {
		throw new TypeError(
			'Init paths cannot contain line feed, carriage return, or double quote characters.',
		);
	}
};

const toPlaylistInfo = (playlist: Playlist): HlsOutputPlaylistInfo => {
	return {
		n: playlist.id,
		tracks: playlist.tracks,
		segmentFormat: playlist.segmentFormat,
	};
};
