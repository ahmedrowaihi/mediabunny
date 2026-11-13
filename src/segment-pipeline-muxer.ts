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
	last,
	joinPaths,
	toArray,
	toDataView,
	UNDETERMINED_LANGUAGE, textEncoder,
	DEFAULT_MAX_INTERLEAVE_DELTA,
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
import type { MetadataTags } from './metadata';
import {
	HlsOutputFormatOptions,
	HlsOutputPlaylistInfo,
	HlsOutputSegmentInfo,
	MpegTsOutputFormat,
	OutputFormat,
	SegmentedOutputFormatOptions,
	SegmentPart,
	WEBVTT_SEGMENT_FORMAT,
	WebvttSegmentFormat,
} from './output-format';
import { ManifestEmitter, ManifestEmitterEvent } from './manifest-emitter';
import type { HlsManifestEmitterHost } from './hls/hls-manifest-emitter';
import { EncodedPacket } from './packet';
import { cueOverlapsSegment, SubtitleConfig, SubtitleCue, SubtitleMetadata } from './subtitles';
import { NullTarget, PathedTarget, Target, TargetRequest } from './target';
import { HLS_MIME_TYPE, TIMESTAMP_PRIV_OWNER } from './hls/hls-misc';
import { secondsToMpegTsTimestamp } from './mpeg-ts/mpeg-ts-misc';
import { WebvttMuxer } from './hls/hls-webvtt';
import { IsobmffMuxer } from './isobmff/isobmff-muxer';
import { MpegTsMuxer } from './mpeg-ts/mpeg-ts-muxer';
import { parseSpliceInfoSection, type Scte35Section } from './mpeg-ts/scte35';
import { ID3_EMSG_SCHEME } from './mpeg-ts/id3-output';
import { buildEmsgBox } from './emsg';
import { InvalidUsageError } from './errors';
import { MPEG_TS_TIMESCALE } from './mpeg-ts/mpeg-ts-misc';
import type { Scte35SectionOptions } from './mpeg-ts/scte35-output';

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

/**
 * An item handed to the pipeline to travel with the media around a given time: an SCTE-35 section, an
 * ID3 tag, a private PES payload.
 *
 * A segmented output has no one stream to write into - it opens a muxer per segment, and one per
 * variant - so an item waits in its queue until each playlist writes the segment covering its time.
 */
type Pending = {
	/** Where it belongs on the media timeline the segments carry, or null for "the next segment". */
	time: number | null;
	/**
	 * The playlists it has already gone into. Each variant writes its own segments, so an item belongs
	 * in every one of them - consuming it on the first would leave the other renditions without it.
	 */
	placedIn: Set<Playlist>;
};

type PendingPrivatePes = Pending & {
	pid: number;
	time: number;
	data: Uint8Array;
};

type PendingId3 = Pending & {
	time: number;
	data: Uint8Array;
};

type PendingScte35 = Pending & {
	section: Uint8Array;
	/** Read once, since the marker needs its direction and duration as well as its time. */
	parsed: Scte35Section;
};

/**
 * The half-open `[start, end)` a written segment covers on the media timeline.
 *
 * `end` is where the **next** segment starts rather than how far this one's packets reach: a track's
 * last frame routinely overhangs the cut by a few milliseconds, and an item stated exactly on a
 * boundary - the usual case, since a splice is placed on one - belongs to the segment that starts
 * there, not the one before it.
 */
type SegmentWindow = {
	start: number;
	end: number;
};

/**
 * Hands each queued item this segment covers to `write`, once per playlist, and records that it went.
 *
 * One rule for every queue: an item is covered when its time is below `end`, which puts an item behind
 * `start` - one stated late, which a live caller cannot avoid, since the media around a splice arrives
 * before the decision does - in this segment rather than nowhere. A null time means "now", so it rides
 * the next segment written after it was handed over.
 */
const placeInSegment = <T extends Pending>(
	queue: T[],
	playlist: Playlist,
	window: SegmentWindow,
	write: (pending: T) => void,
) => {
	for (const pending of queue) {
		if (pending.placedIn.has(playlist) || (pending.time !== null && pending.time >= window.end)) {
			continue;
		}

		write(pending);
		pending.placedIn.add(playlist);
	}
};

/** @internal */
export type PipelineSegment = {
	path: string;
	duration: number;
	timestamp: number;
	byteSize: number;
	byteOffset: number | null;
	info: HlsOutputSegmentInfo | null;
	parts: SegmentPart[] | null;
	/** The SCTE-35 cues whose splice points this segment covers, which the ad markers are rendered from. */
	cues: Scte35Section[];
	/**
	 * How far into an open ad break this segment sits, or null when it is not inside one. Settled when
	 * the segment is appended rather than walked back at emit time: a live playlist evicts its oldest
	 * segments, and a break opened in one that has fallen out of the window is no longer there to find.
	 */
	breakState: { elapsed: number; duration: number } | null;
};

/** @internal */
export type Playlist = {
	id: number;
	path: string;
	tracks: OutputTrack[];
	segmentFormat: OutputFormat;

	currentSegmentStartTimestamp: number | null;
	currentSegmentStartTimestampIsFixed: boolean;
	/** Anchors the segment grid, so a boundary is n * target from here rather than from the last cut. */
	segmentGridOrigin: number | null;
	nextSegmentId: number;
	initSegment: PipelineSegment | null;
	/**
	 * What `onInit` returned, awaited before this playlist's first segment is announced. The callback
	 * fires from a `'finalized'` listener, which cannot await, so the wait happens here instead — which
	 * also means a consumer sees the init segment complete before any segment of it.
	 */
	pendingInit: Promise<unknown> | null;
	indexRange: ByteRange | null;
	writtenSegments: PipelineSegment[];
	/** Summed duration of `writtenSegments`, maintained on append and eviction. */
	windowDuration: number;
	/** The ad break left open by the segments appended so far, which the next one's state is read off. */
	openBreak: { timestamp: number; duration: number } | null;
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
			cues: [],
			breakState: null,
		};
		singleFile.nextOffset = singleFile.fragmentedIsobmffOutput.firstMoofPosition;
	}

	return singleFile.fragmentedIsobmffOutput.currentFileSize - singleFile.nextOffset;
};

/** @internal */
/** The packets, per track, that the next segment takes - as exclusive end indices into each queue. */
type SegmentCut = {
	videoEndIndex: number;
	audioEndIndex: number;
};

/** A written segment, from the cut it came from to what the writer produced for it. */
type PendingSegment = SegmentCut & {
	segmentInfo: HlsOutputSegmentInfo | null;
	relativeSegmentPath: string;
	segmentSize: number;
	maxEndTimestamp: number;
	partStarts: { timestamp: number; independent: boolean }[];
	partEnds: number[];
	outputTarget: Target | null;
	cues: Scte35Section[];
	/** The window the segment covers, decided once while it was written. */
	mediaWindow: SegmentWindow | null;
};

type RenditionGroup = {
	name: string;
	key: string;
	tracks: OutputTrack[];
	needsEmit: boolean;
	firstNoUri: boolean;
};

type VariantStream = {
	tracks: OutputTrack[];
	linkedGroup: RenditionGroup | null;
};

/** What makes two tracks distinguishable to a player, and so in need of separate #EXT-X-MEDIA tags. */
const metadataKeyForTrack = ({ metadata }: OutputTrack) => [
	metadata.languageCode ?? UNDETERMINED_LANGUAGE,
	metadata.name ?? '',
	metadata.disposition?.default ?? true,
	metadata.disposition?.primary ?? false,
	metadata.disposition?.forced ?? false,
].join('-');

export class SegmentPipelineMuxer extends Muxer implements HlsManifestEmitterHost {
	/**
	 * Start one of the inner Outputs the pipeline opens per segment or per single file. Each writes its own
	 * init, so the outer Output's tags have to reach it: without them `creationTime` falls back to `new Date()`
	 * and the same input stops producing the same bytes.
	 */
	private startInnerOutput(output: Output, extraTags?: MetadataTags) {
		const tags = this.output._metadataTags;
		output.setMetadataTags({
			...tags,
			...extraTags,
			...(tags.raw || extraTags?.raw ? { raw: { ...tags.raw, ...extraTags?.raw } } : {}),
		});
		return output.start();
	}

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
	mediaTimestampBase: number;
	firstPacketTimestamp: number | null = null;
	isRelativeToUnixEpoch = false;
	/**
	 * What each track settled on in the segment it first appeared in, so every later segment states the
	 * same decode timeline. Filled per track rather than taken whole from the first segment: the tracks
	 * of one segment settle as their own queues flush, so one of them can be known while another is not.
	 */
	private readonly decodeAnchors: ReturnType<IsobmffMuxer['_decodeAnchors']> = new Map();
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
	// Fixed per emitter class, and read for every packet, so it is settled once the emitters exist.
	private mediaIsAddressedByItsOwnTimestamps: boolean;

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
		this.mediaTimestampBase = options.mediaTimestampBase ?? 10;
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
		this.mediaIsAddressedByItsOwnTimestamps = this.manifestEmitters
			.some(emitter => emitter.addressesMediaByItsOwnTimestamps);
	}

	/**
	 * Fan an event out to every registered manifest emitter, awaiting each
	 * in turn so that emitters that read shared state see prior emitters'
	 * mutations (e.g. `peakBitrate` populated by HLS before DASH reads it).
	 */
	private async broadcast<E extends ManifestEmitterEvent>(
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

	/** @internal */
	noteMasterPlaylistWritten() {
		this.numWrittenMasterPlaylists++;
	}

	/** @internal */
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

		const { groups, groupAssignment, hasVideo } = this.buildRenditionGroups();
		const { variantStreams, unpairedVideoTracks, unpairedAudioTracks } = this.buildVariantStreams(
			groups,
			groupAssignment,
			hasVideo ? 'video' : 'audio',
		);

		this.placeUnpairedTracks('video', unpairedVideoTracks, groups, variantStreams);
		this.placeUnpairedTracks('audio', unpairedAudioTracks, groups, variantStreams);

		// Each declaration maps to one #EXT-X-MEDIA or #EXT-X-STREAM-INF tag in the final master playlist.
		await this.declareGroupRenditions(groups);
		const subtitleDeclarations = await this.declareSubtitleRenditions();
		await this.declareVariants(variantStreams, subtitleDeclarations);

		if (subtitleDeclarations.length > 0) {
			this.subtitleBoundarySource = this.resolveSubtitleBoundarySource();
		}

		this.registerDeclaredTracks();

		await this.broadcast('onStart');

		release();
	}

	/**
	 * The "sibling" groups induced by track pairability. The resulting master playlist should preserve that
	 * pairability: all tracks that are pairable remain pairable, and no two tracks become pairable that are
	 * meant to be mutually exclusive. Each group materializes either as #EXT-X-MEDIA tags or as top-level
	 * #EXT-X-STREAM-INF tags, biased towards video being the top-level grouping as is standard practice.
	 */
	private buildRenditionGroups() {
		const groupAssignment = new Map<OutputTrack, string[]>();
		const groups: RenditionGroup[] = [];

		let hasVideo = false;
		let illegalPairingDetected = false;
		let keyPacketsOnlyPairingWarned = false;

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

		return { groups, groupAssignment, hasVideo };
	}

	/** The top-level variant streams, plus the tracks that pair with nothing and still need placing. */
	private buildVariantStreams(
		groups: RenditionGroup[],
		groupAssignment: Map<OutputTrack, string[]>,
		mainType: TrackType,
	) {
		const variantStreams: VariantStream[] = [];
		const unpairedVideoTracks: OutputTrack[] = [];
		const unpairedAudioTracks: OutputTrack[] = [];

		for (const track of this.output.tracks) {
			const assignedGroupKeys = groupAssignment.get(track);
			if (!assignedGroupKeys) {
				if (track.type === 'video') {
					unpairedVideoTracks.push(track);
				} else if (track.type === 'audio') {
					unpairedAudioTracks.push(track);
				}

				continue;
			}

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
		}

		return { variantStreams, unpairedVideoTracks, unpairedAudioTracks };
	}

	/**
	 * Tracks that can't be paired with any other track always live on the top level; the question is just
	 * whether they need separating into #EXT-X-MEDIA tags, which they do once their metadata differs.
	 */
	private placeUnpairedTracks(
		type: 'video' | 'audio',
		tracks: OutputTrack[],
		groups: RenditionGroup[],
		variantStreams: VariantStream[],
	) {
		if (tracks.length === 0) {
			return;
		}

		if (new Set(tracks.map(metadataKeyForTrack)).size === 1) {
			for (const track of tracks) {
				variantStreams.push({ tracks: [track], linkedGroup: null });
			}

			return;
		}

		const group: RenditionGroup = {
			key: tracks.map(x => x.id).join('-'),
			name: type + '-' + (groups.length + 1),
			tracks,
			needsEmit: true,
			firstNoUri: true,
		};
		groups.push(group);

		variantStreams.push({ tracks: [tracks[0]!], linkedGroup: group });
	}

	private deduceSegmentFormat(tracks: OutputTrack[]) {
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
	}

	private async registerPlaylist(tracks: OutputTrack[]) {
		const isSubtitle = tracks[0]!.isSubtitleTrack();
		if (tracks.some(track => this.playlists.some(playlist => playlist.tracks.includes(track)))) {
			throw new Error('Internal error: track is already registered in a playlist.'); // Should be unreachable
		}

		let format = this.deduceSegmentFormat(tracks);

		// This pipeline places media by mediaTimestampBase, so a segment muxer must not move it again.
		// Stated on a copy: the format belongs to the caller, who may reuse it for another output.
		if (format instanceof MpegTsOutputFormat && format._options.timestampOffset === undefined) {
			format = new MpegTsOutputFormat({ ...format._options, timestampOffset: 0 });
		}

		const id = this.playlists.length + 1;
		const path = await this.getPlaylistPath({
			n: id,
			tracks,
			segmentFormat: format,
		});
		validatePlaylistPath(path);

		const playlist: Playlist = {
			id,
			path,
			tracks,
			segmentFormat: format,
			currentSegmentStartTimestamp: null,
			currentSegmentStartTimestampIsFixed: false,
			segmentGridOrigin: null,
			nextSegmentId: 1,
			initSegment: null,
			pendingInit: null,
			indexRange: null,
			writtenSegments: [],
			windowDuration: 0,
			openBreak: null,
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
	}

	private async declareGroupRenditions(groups: RenditionGroup[]) {
		for (const group of groups) {
			if (!group.needsEmit) {
				continue;
			}

			for (let i = 0; i < group.tracks.length; i++) {
				const track = group.tracks[i]!;

				let playlist = this.playlists.find(x => x.tracks[0]!.id === track.id);
				playlist ??= await this.registerPlaylist([track]);

				this.playlistDeclarations.push({
					playlist,
					groupId: group.name,
					noUri: group.firstNoUri && i === 0,
					references: [],
				});
			}
		}
	}

	private async declareSubtitleRenditions() {
		const declarations: PlaylistDeclaration[] = [];

		for (const track of this.output.tracks.filter(track => track.isSubtitleTrack())) {
			const declaration: PlaylistDeclaration = {
				playlist: await this.registerPlaylist([track]),
				groupId: SUBTITLE_GROUP_ID,
				noUri: false,
				references: [],
			};

			declarations.push(declaration);
			this.playlistDeclarations.push(declaration);
		}

		return declarations;
	}

	private async declareVariants(variantStreams: VariantStream[], subtitleDeclarations: PlaylistDeclaration[]) {
		for (const variant of variantStreams) {
			// Since tracks can only be assigned to one playlist, the first track's ID acts as a "playlist key"
			let playlist = this.playlists.find(x => x.tracks[0]!.id === variant.tracks[0]!.id);
			playlist ??= await this.registerPlaylist(variant.tracks);

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
	}

	/** The playlist whose segment boundaries the subtitle segments are cut on. */
	private resolveSubtitleBoundarySource() {
		const mediaPlaylists = this.playlists.filter(x => x.subtitleBoundaries === null);
		const source = mediaPlaylists.find(x => x.tracks.some(track => track.isVideoTrack()))
			?? mediaPlaylists[0];

		if (!source) {
			throw new Error(
				'Subtitle tracks require at least one video or audio track, as subtitle segments are cut on the'
				+ ' media segment boundaries. Add a video or audio track.',
			);
		}

		return source;
	}

	private registerDeclaredTracks() {
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
	}

	async getMimeType(): Promise<string> {
		return HLS_MIME_TYPE;
	}

	private closedTracks = new Set<OutputTrack>();

	private allTracksAreKnown(playlist: Playlist) {
		for (const track of playlist.tracks) {
			if (!this.closedTracks.has(track) && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	override async onTrackClose(track: OutputTrack) {
		this.closedTracks.add(track);

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
			this.firstPacketTimestamp ??= packet.timestamp;

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
			this.firstPacketTimestamp ??= packet.timestamp;

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

	protected override get maxInterleaveDelta(): number {
		return this.options.maxInterleaveDelta ?? DEFAULT_MAX_INTERLEAVE_DELTA;
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

		// Same rule as the muxers, through the same base method.
		const audioHasGoneQuiet = () => {
			if (!audioTrack || !videoTrack || videoTrack.packets.length === 0) {
				return false;
			}

			return this.quietTrackMayBeSkipped(trackDatas, x => x.packets, x => x.timestamp);
		};

		// Loop in case we can finalize multiple segments
		while (true) {
			const cut = this.chooseSegmentCut(playlist, videoTrack, audioTrack, audioHasGoneQuiet);
			if (cut === null) {
				return;
			}

			if (cut.videoEndIndex === 0 && cut.audioEndIndex === 0) {
				// No more segments to write - if all tracks are closed, this playlist is done
				if (trackDatas.every(x => x.closed)) {
					await this.onPlaylistDone(playlist);
				}

				return;
			}

			// We can finalize a new segment!
			const { segmentInfo, relativeSegmentPath, fullSegmentPath } = await this.openSegmentTarget(
				playlist,
				videoTrack,
				audioTrack,
			);
			const written = await this.writeSegmentMedia(playlist, videoTrack, audioTrack, cut, fullSegmentPath);

			await this.recordSegment(playlist, trackDatas, videoTrack, audioTrack, {
				...cut,
				...written,
				segmentInfo,
				relativeSegmentPath,
			});

			await this.evictLiveSegments(playlist);
		}
	}

	/**
	 * The core segmentation logic: which packets go into the next segment, and whether a segment can be
	 * written at all. `null` means some track is still open and has not provided enough media data yet.
	 *
	 * The packets are chosen to maximize the segment's duration AND keep it from exceeding the target
	 * duration. For video that is extended with a key frame rule: every segment with video data must begin
	 * with a video key frame. The logic is complex but solved in a straight-forward way - all possible
	 * permutations are checked in a nested if-else structure, making sure all cases behave correctly. That
	 * was the easiest, least error-prone way I found to express this behavior.
	 */
	private chooseSegmentCut(
		playlist: Playlist,
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
		audioHasGoneQuiet: () => boolean,
	) {
		assert(playlist.currentSegmentStartTimestamp !== null);

		// A stated boundary replaces both the video deadline and the audio grid, so the two tracks cut at
		// the same instruction rather than one following the caller and the other the default.
		const statedBoundary = this.options.nextSegmentBoundary?.(playlist.currentSegmentStartTimestamp) ?? null;

		const currentSegmentEndTimestamp = statedBoundary
			?? playlist.currentSegmentStartTimestamp + this.targetSegmentDuration;

		// Anchored to the first segment's start; re-anchoring on each cut would compound the error.
		if (playlist.segmentGridOrigin === null || playlist.nextSegmentId === 1) {
			playlist.segmentGridOrigin = playlist.currentSegmentStartTimestamp;
		}
		const gridOrigin = playlist.segmentGridOrigin;
		const elapsedGrids = Math.round(
			(playlist.currentSegmentStartTimestamp - gridOrigin) / this.targetSegmentDuration,
		);
		const gridBoundary = statedBoundary ?? gridOrigin + (elapsedGrids + 1) * this.targetSegmentDuration;

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
					return null;
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
						if (audioTrack.closed || audioHasGoneQuiet()) {
							audioEndIndex = audioTrack.packets.length;
						} else {
							return null;
						}
					}
				}
			} else {
				if (!videoTrack.closed) {
					return null;
				}

				// Include the entire rest of the video (since there's no key frame to split it on)
				videoEndIndex = videoTrack.packets.length;
				const maxIndex = arrayArgmax(videoTrack.packets, x => x.timestamp);
				const maxPacket = videoTrack.packets[maxIndex];
				assert(maxPacket);

				if (audioTrack) {
					// The audio must reach the next segment's start, or past the last video packet when
					// that one lands later still
					const index = maxPacket.timestamp < currentSegmentEndTimestamp
						? audioTrack.packets.findIndex(x => x.timestamp >= currentSegmentEndTimestamp)
						: audioTrack.packets.findIndex(x => x.timestamp > maxPacket.timestamp);

					if (index !== -1) {
						audioEndIndex = index;
					} else if (audioTrack.closed || audioHasGoneQuiet()) {
						audioEndIndex = audioTrack.packets.length;
					} else {
						return null;
					}
				}
			}
		} else if (audioTrack && (!audioTrack.closed || audioTrack.packets.length > 0)) {
			// There's only an audio track active

			const allBelow = audioTrack.packets.every(x => x.timestamp < gridBoundary);

			if (allBelow) {
				if (audioTrack.closed) {
					// We can write all packets since they're all below
					audioEndIndex = audioTrack.packets.length;
				} else {
					// We don't know enough packets yet
					return null;
				}
			} else {
				// Nearest the grid point, not the last that fits: a frame rarely divides the target, and
				// always rounding the same way accumulates. See FORK.md.
				const after = audioTrack.packets.findIndex(x => x.timestamp >= gridBoundary);
				assert(after !== -1);
				const earlier = audioTrack.packets[after - 1];
				// A stated boundary is an instruction, so the segment opens at or after it; the repeating
				// grid takes the nearer packet instead, since always rounding one way accumulates.
				const chosen = statedBoundary === null
					&& earlier !== undefined
					&& gridBoundary - earlier.timestamp <= audioTrack.packets[after]!.timestamp - gridBoundary
					? after - 1
					: after;
				audioEndIndex = Math.max(chosen, 1); // Always include at least the first packet
			}
		}

		return { videoEndIndex, audioEndIndex };
	}

	/** The path and, outside single-file mode, the `onSegment` info for the segment about to be written. */
	private async openSegmentTarget(
		playlist: Playlist,
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
	) {
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
					isLast: true,
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

					await this.startInnerOutput(fragmentedIsobmffOutput.output);
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
				isLast: false,
			};

			relativeSegmentPath = await this.getSegmentPath(segmentInfo);
			validateSegmentPath(relativeSegmentPath);

			fullSegmentPath = joinPaths(joinPaths(pathedTarget.rootPath, playlist.path), relativeSegmentPath);
			playlist.nextSegmentId++;
		}

		return { segmentInfo, relativeSegmentPath, fullSegmentPath };
	}

	/** Writes the cut's packets into one segment and reports what the writer produced. */
	private async writeSegmentMedia(
		playlist: Playlist,
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
		{ videoEndIndex, audioEndIndex }: SegmentCut,
		fullSegmentPath: string,
	) {
		let segmentSize = 0;
		let outputTarget: Target | null = null;
		let maxEndTimestamp = -Infinity;
		let cues: Scte35Section[] = [];
		let mediaWindow: SegmentWindow | null = null;
		const partStarts: { timestamp: number; independent: boolean }[] = [];
		// Writer positions at the end of every part but the last, which ends with the segment
		const partEnds: number[] = [];

		let output: Output | null = null;
		let videoSource: EncodedVideoPacketSource | null = null;
		let audioSource: EncodedAudioPacketSource | null = null;
		let privTags: MetadataTags | undefined;

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

					if (!playlist.segmentFormat.supportsTimestampedMediaData && audioEndIndex > 0) {
						// The media itself carries no timestamps, so let's write an ID3v2 PRIV frame. The formats
						// that the spec permits (MP3, ADTS) understand this just fine.
						const firstTimestamp = this.toMediaTimestamp(audioTrack.packets[0]!.timestamp);
						const pts = secondsToMpegTsTimestamp(firstTimestamp);

						const priv = new Uint8Array(TIMESTAMP_PRIV_OWNER.length + 1 + 8);
						priv.set(textEncoder.encode(TIMESTAMP_PRIV_OWNER), 0);
						const view = toDataView(priv);
						view.setUint32(TIMESTAMP_PRIV_OWNER.length + 1, Math.floor(pts / 2 ** 32));
						view.setUint32(TIMESTAMP_PRIV_OWNER.length + 5, pts % 2 ** 32);

						privTags = { raw: { PRIV: priv } };
					}
				}

				await this.startInnerOutput(output, privTags);
			}

			// Add all of the packets

			const muxer = output._muxer;
			// The decode anchor is a property of the track, not of this segment: one muxer per segment
			// would otherwise settle on zero for every segment after the first, whose `elst` then
			// presents them all early by the first one's reorder delay
			if (muxer instanceof IsobmffMuxer) {
				muxer._seedDecodeAnchors(this.decodeAnchors);
			}

			const partDuration = muxer instanceof IsobmffMuxer && muxer.isFragmented
				? this.options.partDuration
				: undefined;

			maxEndTimestamp = partDuration === undefined
				? await this.addSegmentPackets(
					videoTrack,
					audioTrack,
					{ videoEndIndex, audioEndIndex },
					videoSource,
					audioSource,
				)
				: await this.addSegmentPacketsInParts(
					videoTrack,
					audioTrack,
					{ videoEndIndex, audioEndIndex },
					videoSource,
					audioSource,
					muxer,
					partDuration,
					partStarts,
					partEnds,
				);

			// After the packets, so an item lands behind the tables the segment's own muxer has by then
			// written, and before the finalize that closes it
			mediaWindow = this.segmentWindow(
				playlist,
				videoTrack,
				audioTrack,
				{ videoEndIndex, audioEndIndex },
				maxEndTimestamp,
			);
			if (mediaWindow) {
				this.flushPrivatePesInto(muxer, playlist, mediaWindow);
				this.flushId3Into(muxer, playlist, mediaWindow);
				cues = this.flushScte35Into(muxer, playlist, mediaWindow);
			}

			if (playlist.singleFile?.fragmentedIsobmffOutput) {
				segmentSize = await finalizeFragmentedIsobmffSegment(playlist);
			} else {
				await output.finalize();
			}

			// After finalizing, not before: a track's anchor is only settled once its own queue has been
			// flushed, and one track of a segment can be settled while another is not
			if (muxer instanceof IsobmffMuxer) {
				for (const [trackId, anchor] of muxer._decodeAnchors()) {
					if (!this.decodeAnchors.has(trackId)) {
						this.decodeAnchors.set(trackId, anchor);
					}
				}
			}
		} catch (e) {
			await output?.cancel();
			throw e;
		}

		return { segmentSize, maxEndTimestamp, partStarts, partEnds, outputTarget, cues, mediaWindow };
	}

	/** Consumes the written packets and records the segment on the playlist. */
	private async recordSegment(
		playlist: Playlist,
		trackDatas: PipelineTrackData[],
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
		{
			videoEndIndex,
			audioEndIndex,
			segmentInfo,
			relativeSegmentPath,
			segmentSize,
			maxEndTimestamp,
			partStarts,
			partEnds,
			outputTarget,
			cues,
			mediaWindow,
		}: PendingSegment,
	) {
		assert(playlist.currentSegmentStartTimestamp !== null);

		if (videoEndIndex > 0) {
			assert(videoTrack);
			videoTrack.packets.splice(0, videoEndIndex);
		}
		if (audioEndIndex > 0) {
			assert(audioTrack);
			audioTrack.packets.splice(0, audioEndIndex);
		}

		// The same window the segment's items were placed against, so what the playlist announces and
		// where a cue went are one decision rather than two that agree by coincidence
		const segmentDuration = mediaWindow
			? mediaWindow.end - mediaWindow.start
			: maxEndTimestamp - playlist.currentSegmentStartTimestamp;
		assert(Number.isFinite(segmentDuration) && segmentDuration >= 0);

		// On the input timeline, which is what the cut and the parts are expressed in
		const nextSegmentStartTimestamp = playlist.currentSegmentStartTimestamp + segmentDuration;

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
			segmentInfo.isLast = playlistIsDrained(trackDatas);
			await this.drainPendingInit(playlist);
			await this.options.onSegment?.(outputTarget, segmentInfo);
		}

		this.appendSegment(playlist, {
			path: relativeSegmentPath,
			duration: segmentDuration,
			timestamp: playlist.currentSegmentStartTimestamp,
			byteSize: segmentSize,
			byteOffset: playlist.singleFile
				? playlist.singleFile.nextOffset
				: null,
			info: segmentInfo ?? null,
			parts,
			cues,
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
	}

	/** Adds the cut's packets in presentation order, with no part boundaries to respect. */
	private async addSegmentPackets(
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
		{ videoEndIndex, audioEndIndex }: SegmentCut,
		videoSource: EncodedVideoPacketSource | null,
		audioSource: EncodedAudioPacketSource | null,
	) {
		let maxEndTimestamp = -Infinity;

		if (videoTrack) {
			assert(videoSource);
			const meta = { decoderConfig: videoTrack.info.decoderConfig };

			for (let i = 0; i < videoEndIndex; i++) {
				const packet = videoTrack.packets[i]!;

				await videoSource.add(this.toMediaPacket(packet), meta);
				maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
			}
		}

		if (audioTrack) {
			assert(audioSource);
			const meta = { decoderConfig: audioTrack.info.decoderConfig };

			for (let i = 0; i < audioEndIndex; i++) {
				const packet = audioTrack.packets[i]!;

				await audioSource.add(this.toMediaPacket(packet), meta);
				maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
			}
		}

		return maxEndTimestamp;
	}

	/** The same, cut into low-latency parts, which only a fragmented ISOBMFF segment can carry. */
	private async addSegmentPacketsInParts(
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
		{ videoEndIndex, audioEndIndex }: SegmentCut,
		videoSource: EncodedVideoPacketSource | null,
		audioSource: EncodedAudioPacketSource | null,
		muxer: Muxer,
		partDuration: number,
		partStarts: { timestamp: number; independent: boolean }[],
		partEnds: number[],
	) {
		let maxEndTimestamp = -Infinity;

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
				await videoSource.add(this.toMediaPacket(packet), videoMeta);
				videoIndex++;
			} else {
				assert(audioSource && audioMeta);
				await audioSource.add(this.toMediaPacket(packet), audioMeta);
				audioIndex++;
			}
			maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
		}

		return maxEndTimestamp;
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
					cues: [],
					breakState: null,
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
					cues: [],
					breakState: null,
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
					playlist.pendingInit = Promise.resolve(this.options.onInit?.(target, playlistInfo));
				});

				return target;
			}
		};
	}

	/** Waits for whatever `onInit` returned, once. */
	private async drainPendingInit(playlist: Playlist) {
		const pending = playlist.pendingInit;
		if (pending) {
			playlist.pendingInit = null;
			await pending;
		}
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
				await this.options.onSegmentPopped?.(popped.path, popped.info);
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
				// Unless the media ran on without them, which the muxers' own bound decides
				const newestBoundary = last(boundaries)!;
				const mediaRanAhead = newestBoundary.timestamp + newestBoundary.duration - segmentEnd;
				if (mediaRanAhead <= this.maxInterleaveDelta) {
					return;
				}
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

	// A format writing its init inline repeats it per segment, so that playlist gets the same
	// standalone-fMP4 treatment as media: one output for the file, one fragment per segment
	private async openSubtitleSingleFile(playlist: Playlist, trackData: PipelineSubtitleTrackData) {
		assert(this.output._target instanceof PathedTarget);
		const pathedTarget = this.output._target;

		const segmentInfo: HlsOutputSegmentInfo = {
			n: playlist.nextSegmentId,
			format: playlist.segmentFormat,
			isSingleFile: true,
			playlist: toPlaylistInfo(playlist),
			parts: null,
			isLast: true,
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
			await this.startInnerOutput(fragmentedIsobmffOutput.output);
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
				isLast: false,
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
				await this.startInnerOutput(output);
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
			segmentInfo.isLast = trackData.closed && (playlist.subtitleBoundaries?.length ?? 0) === 0;
			await this.drainPendingInit(playlist);
			await this.options.onSegment?.(outputTarget, segmentInfo);
		}

		// Retain every cue that can still overlap a later segment; they must be repeated there. Dropping
		// only a prefix would let one long cue pin every cue behind it in the buffer for its whole span.
		trackData.info.cues = trackData.info.cues.filter(cue => cueOverlapsSegment(cue, segmentEnd, Infinity));

		this.appendSegment(playlist, {
			path: relativeSegmentPath,
			duration,
			timestamp,
			byteSize: segmentSize,
			byteOffset: playlist.singleFile ? playlist.singleFile.nextOffset : null,
			info: segmentInfo,
			parts: null,
			cues: [],
		});

		if (playlist.singleFile) {
			playlist.singleFile.nextOffset += segmentSize;
		}

		this.globalTargetDuration = Math.max(this.globalTargetDuration, duration);
		playlist.currentSegmentStartTimestamp = segmentEnd;

		await this.evictLiveSegments(playlist);
	}

	/** A packet moved onto the media timeline. Part and segment paths both go through this. */
	private toMediaPacket(packet: EncodedPacket) {
		if (this.mediaIsAddressedByItsOwnTimestamps) {
			return packet;
		}

		return packet.clone({ timestamp: this.toMediaTimestamp(packet.timestamp) });
	}

	/**
	 * Records a written segment on its playlist, settling as it goes the state that spans segments.
	 *
	 * The one place a segment joins a playlist, so that what carries across them - the running total
	 * and an open ad break - is maintained in step with the list rather than recovered from it.
	 */
	private appendSegment(playlist: Playlist, segment: Omit<PipelineSegment, 'breakState'>) {
		const open = playlist.openBreak;
		const elapsed = open === null ? 0 : segment.timestamp - open.timestamp;

		playlist.writtenSegments.push({
			...segment,
			// Read before this segment's own cues are folded in: the segment that opens a break states
			// it with a CUE-OUT of its own and is not yet "inside" one. A break with no stated duration
			// has no position to report, and so gets no CONT.
			breakState: open !== null && open.duration > 0 && elapsed < open.duration
				? { elapsed, duration: open.duration }
				: null,
		});
		playlist.windowDuration += segment.duration;

		for (const cue of segment.cues) {
			if (cue.outOfNetwork === true) {
				playlist.openBreak = { timestamp: segment.timestamp, duration: cue.breakDuration ?? 0 };
			} else if (cue.outOfNetwork === false) {
				playlist.openBreak = null;
			}
		}
	}

	/**
	 * The window this segment covers, or null where the cut carries no packets and so covers nothing.
	 *
	 * This is the one place a segment's bounds are decided: everything that travels with the media -
	 * sections, tags, payloads - is placed against what this returns, so there is a single answer to
	 * which segment a given time belongs to.
	 */
	private segmentWindow(
		playlist: Playlist,
		videoTrack: PipelineVideoTrackData | undefined,
		audioTrack: PipelineAudioTrackData | undefined,
		{ videoEndIndex, audioEndIndex }: Pick<SegmentCut, 'videoEndIndex' | 'audioEndIndex'>,
		maxEndTimestamp: number,
	): SegmentWindow | null {
		const hasPackets = (videoTrack?.packets.length ?? 0) > 0 || (audioTrack?.packets.length ?? 0) > 0;
		if (
			playlist.currentSegmentStartTimestamp === null
			|| !hasPackets
			|| !Number.isFinite(maxEndTimestamp)
		) {
			return null;
		}

		// The first packet left over by the cut, which is where the next segment opens. Not
		// `maxEndTimestamp`: that is the furthest any track's last packet *reaches*, and an audio frame
		// routinely overhangs the cut by a few milliseconds - measured on demo.mp4, cuts at 11.0000 and
		// 13.0000 against ends of 11.0027 and 13.0080.
		const nextStart = Math.min(
			videoTrack && videoTrack.packets.length > videoEndIndex
				? videoTrack.packets[videoEndIndex]!.timestamp
				: Infinity,
			audioTrack && audioTrack.packets.length > audioEndIndex
				? audioTrack.packets[audioEndIndex]!.timestamp
				: Infinity,
		);

		return {
			// The cut's own start, not the first packet's: a track can open the segment ahead of the
			// others - audio priming runs some 20 ms before the first video frame - and the playlist
			// states its duration from here. Taking one track's packet instead puts every later item
			// that much past the boundary the player computes.
			start: this.toMediaTimestamp(playlist.currentSegmentStartTimestamp),
			// The last segment has no next packet, and then everything still queued belongs to it
			end: this.toMediaTimestamp(Number.isFinite(nextStart) ? nextStart : maxEndTimestamp),
		};
	}

	/**
	 * Hands every queued SCTE-35 section whose splice point this segment covers to the segment's own
	 * muxer, so the section travels in the segment a receiver reaches it by.
	 */
	private flushScte35Into(muxer: Muxer, playlist: Playlist, window: SegmentWindow) {
		const placed: Scte35Section[] = [];
		// Only a transport stream has a cue PID to carry a section. A CMAF segment still counts as
		// having taken it - the playlist marker is what a player reads - so it is marked placed rather
		// than reported as a cue that never went anywhere.
		const carriesInBand = muxer instanceof MpegTsMuxer;

		placeInSegment(this.pendingScte35, playlist, window, (pending) => {
			// One segment behind is a cue stated late, which `placeInSegment` puts here on purpose.
			// Further behind is a different thing - a splice time on the caller's own timeline rather
			// than the one the segments carry - and saying so is the difference between a late cue and a
			// silently misplaced one.
			if (
				carriesInBand
				&& pending.time !== null
				&& pending.time < window.start - (window.end - window.start)
				&& pending.placedIn.size === 0
			) {
				Logging._warn(
					`An SCTE-35 section states a splice at ${pending.time}s, which is more than one`
					+ ` segment behind the segment being written (${window.start}s to ${window.end}s). It`
					+ ' is written here anyway. Splice times are on the output\'s own media timeline, which'
					+ ' mediaTimestampBase shifts - a time on the input\'s timeline lands early by exactly'
					+ ' that.',
				);
			}

			if (carriesInBand) {
				muxer.writeScte35Section(pending.section);
			}

			placed.push(pending.parsed);
		});

		return placed;
	}

	/**
	 * Queues a `splice_info_section` for the segment covering its splice point.
	 *
	 * A segmented output has no one transport stream to write into - it opens a muxer per segment, and
	 * one per variant - so the section waits here until each playlist writes the segment its time falls
	 * in.
	 *
	 * @internal
	 */
	writeScte35Section(section: Uint8Array, options: Scte35SectionOptions = {}) {
		const read = parseSpliceInfoSection(section);
		// The caller's own decision wins where it made one: which segmentation types open an avail is
		// an origin's rule rather than this library's
		const parsed: Scte35Section = {
			...read,
			outOfNetwork: options.outOfNetwork === undefined ? read.outOfNetwork : options.outOfNetwork,
			breakDuration: options.breakDuration === undefined ? read.breakDuration : options.breakDuration,
		};

		this.pendingScte35.push({ section, parsed, time: parsed.time, placedIn: new Set() });
	}

	private pendingScte35: PendingScte35[] = [];
	private pendingId3: PendingId3[] = [];

	/**
	 * Queues an ID3 tag for the segment covering `time`.
	 *
	 * Which shape it takes is the segment's business, not the caller's: a transport stream carries it as
	 * a PES on the declared timed-metadata PID, a fragmented MP4 as an `emsg` ahead of the `moof`.
	 *
	 * @internal
	 */
	writeId3Metadata(time: number, data: Uint8Array) {
		this.pendingId3.push({ time, data, placedIn: new Set() });
	}

	/**
	 * Hands every queued ID3 tag this segment covers to the segment's own muxer, in whichever form that
	 * muxer carries one.
	 */
	private flushId3Into(muxer: Muxer, playlist: Playlist, window: SegmentWindow) {
		placeInSegment(this.pendingId3, playlist, window, (pending) => {
			if (muxer instanceof MpegTsMuxer) {
				const pid = muxer.timedMetadataPid;
				if (pid === null) {
					throw new InvalidUsageError(
						'An ID3 tag was written, but the segment format\'s MpegTsOutputFormat declares no'
						+ ' timedMetadataPid for it to go on.',
					);
				}

				muxer.writePrivatePesPayload(pid, pending.time, pending.data);
			} else if (muxer instanceof IsobmffMuxer) {
				// Relative to the segment's own start, which is what a version 0 box states and what lets
				// the segment be read without knowing where it sits in the presentation
				muxer._addEmsg(buildEmsgBox({
					schemeIdUri: ID3_EMSG_SCHEME,
					timescale: MPEG_TS_TIMESCALE,
					presentationTimeDelta: Math.max(
						0,
						Math.round((pending.time - window.start) * MPEG_TS_TIMESCALE),
					),
					eventDuration: 0,
					id: this.nextEmsgId++,
					messageData: pending.data,
				}));
			} else {
				throw new InvalidUsageError(
					'An ID3 tag was written, but this output\'s segments are neither MPEG-TS nor fragmented'
					+ ' MP4, so there is nothing to carry it.',
				);
			}
		});
	}

	private nextEmsgId = 1;

	/**
	 * Queues a whole PES payload for the segment covering its time, on a PID the segment format
	 * declares. The ID3 path above is this one with the descriptors filled in.
	 *
	 * @internal
	 */
	writePrivatePesPayload(pid: number, time: number, data: Uint8Array) {
		this.pendingPrivatePes.push({ pid, time, data, placedIn: new Set() });
	}

	private pendingPrivatePes: PendingPrivatePes[] = [];

	/** Hands every queued private payload this segment covers to the segment's own muxer. */
	private flushPrivatePesInto(muxer: Muxer, playlist: Playlist, window: SegmentWindow) {
		if (!(muxer instanceof MpegTsMuxer)) {
			return;
		}

		placeInSegment(this.pendingPrivatePes, playlist, window, (pending) => {
			muxer.writePrivatePesPayload(pending.pid, pending.time, pending.data);
		});
	}

	private toMediaTimestamp(timestamp: number) {
		// The media's own timestamps are decoupled from the input timestamps (which may well be huge Unix timestamps)
		assert(this.firstPacketTimestamp !== null);
		return timestamp - this.firstPacketTimestamp + this.mediaTimestampBase;
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

			await this.drainPendingInit(playlist);
			await this.options.onSegment?.(playlist.singleFile.target, playlist.singleFile.info);
		}

		await this.broadcast('onPlaylistDone', playlist);
	}

	async finalize() {
		const releases = await Promise.all(this.playlists.map(p => p.mutex.acquire()));
		releases.forEach(release => release());

		// Every track, not just those that produced data: a track that never received a sample has no
		// trackData, and leaving it unclosed keeps its playlist waiting for a packet that cannot arrive.
		for (const track of this.output.tracks) {
			this.closedTracks.add(track);
		}
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

		// A cue whose splice never fell inside a segment: the stream ended before it, or its time was
		// never on the timeline the segments carry. Saying so beats leaving a packager to wonder why its
		// ad break never appeared.
		const unplaced = this.pendingScte35.filter(pending => pending.placedIn.size === 0);
		if (unplaced.length > 0) {
			Logging._warn(
				`${unplaced.length} SCTE-35 section(s) were never written: their splice times`
				+ ` (${unplaced.map(p => p.time).join(', ')}) fall past the end of the media`
				+ ' this output wrote. Splice times are on the output\'s own media timeline, which'
				+ ' mediaTimestampBase shifts.',
			);
		}
		this.pendingScte35 = [];

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

// No further segment can be cut from a playlist whose every track is closed and drained, so a segment
// written in that state is its playlist's last. Checked after the segment's packets are consumed.
const playlistIsDrained = (trackDatas: PipelineTrackData[]) =>
	trackDatas.every(x => x.closed && x.packets.length === 0);

const toPlaylistInfo = (playlist: Playlist): HlsOutputPlaylistInfo => {
	return {
		n: playlist.id,
		tracks: playlist.tracks,
		segmentFormat: playlist.segmentFormat,
	};
};
