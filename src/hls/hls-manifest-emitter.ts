/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ClosedCaptionChannel } from '../closed-captions';
import type { SubtitleCodec } from '../codec';
import { declaredVideoCodec } from '../isobmff/isobmff-boxes';
import type { ManifestEmitter, MediaPipelineHost } from '../manifest-emitter';
import type { Playlist, PipelineSegment, PipelineTrackData } from '../segment-pipeline-muxer';
import {
	assert,
	joinPaths,
	textEncoder,
	TRANSFER_CHARACTERISTICS_MAP,
	videoRangeFromTransferCharacteristics,
} from '../misc';
import type { OutputTrack, TrackType } from '../output';
import { HlsOutputPlaylistInfo, type HlsOutputFormatOptions, type OutputFormat } from '../output-format';
import { PathedTarget } from '../target';
import { Writer } from '../writer';
import { HLS_MIME_TYPE } from './hls-misc';

/** @internal */
export type HlsManifestEmitterHost = MediaPipelineHost & {
	playlistDeclarations: HlsPlaylistDeclaration[];
	numWrittenMasterPlaylists: number;
	noteMasterPlaylistWritten(): void;
};

/** @internal */
export type HlsPlaylistDeclaration = {
	playlist: Playlist;
	groupId: string | null;
	noUri: boolean;
	references: HlsPlaylistDeclaration[];
};

// What a subtitle rendition contributes to a variant's CODECS: TTML rides in fragmented MP4 as `stpp`,
// while a WebVTT segment is raw text with no RFC-6381 codec a player could act on.
const SUBTITLE_CODEC_TO_RFC6381: Record<SubtitleCodec, string | null> = {
	webvtt: null,
	ttml: 'stpp',
};

/** HLS spells the subtitle media type in the plural, unlike our track type. */
const HLS_MEDIA_TYPES: Record<TrackType, string> = {
	video: 'VIDEO',
	audio: 'AUDIO',
	subtitle: 'SUBTITLES',
};

// RFC 8216 §4.3.4.2 lets CLOSED-CAPTIONS name only a group an EXT-X-MEDIA declares, so a variant whose
// bitstream carries captions gets both, under one group shared by every such variant.
const CLOSED_CAPTIONS_GROUP_ID = 'cc';

const announcedClosedCaptionChannels = (track: OutputTrack): ClosedCaptionChannel[] => {
	if (!track.isVideoTrack()) {
		return [];
	}

	const closedCaptions = track.metadata.closedCaptions;
	return closedCaptions?.announceInManifest ? closedCaptions.channels : [];
};

// An absent VIDEO-RANGE already implies SDR, so a transfer function we cannot name is left unstated
// rather than asserted.
const hlsVideoRange = (colorSpace: VideoColorSpaceInit | undefined) =>
	colorSpace?.transfer
		? videoRangeFromTransferCharacteristics(TRANSFER_CHARACTERISTICS_MAP[colorSpace.transfer])
		: null;

const declaredFor = (track: OutputTrack, trackData: PipelineTrackData | undefined, segmentFormat: OutputFormat) => {
	const info = trackData?.info;
	const codecString = info && info.type !== 'subtitle' ? info.decoderConfig.codec : track.source._codec;
	if (!track.isVideoTrack()) {
		return codecString;
	}

	const inBandParameterSets = info?.type === 'video' && info.inBandParameterSets;
	return declaredVideoCodec(track.source._codec, codecString, segmentFormat, inBandParameterSets);
};

/**
 * Generates HLS manifest text — both per-playlist (`writePlaylist`) and
 * the master playlist (`writeMasterPlaylist`). Receives every piece of
 * state it needs through its {@link HlsManifestEmitterHost}, so the
 * underlying muxer is the single source of truth for segment state.
 *
 * Implements the generic {@link ManifestEmitter} lifecycle so it can be
 * registered alongside other emitters (e.g. DASH) in an
 * {@link AdaptiveOutputFormat}. Behaviour is byte-equivalent to the
 * inline implementation that lived in `SegmentPipelineMuxer` before the extraction.
 *
 * @internal
 */
export class HlsManifestEmitter implements ManifestEmitter {
	private readonly host: HlsManifestEmitterHost;
	private readonly options: HlsOutputFormatOptions;

	constructor(host: HlsManifestEmitterHost, options: HlsOutputFormatOptions) {
		this.host = host;
		this.options = options;
	}

	async onSegmentAppended(playlist: Playlist): Promise<void> {
		await this.writePlaylist(playlist);
		if (this.host.isLive) {
			await this.tryWriteMasterPlaylist();
		}
	}

	async onPlaylistDone(playlist: Playlist): Promise<void> {
		// The muxer already broadcast the final segment append, so the
		// playlist text is up to date. Re-emit so the trailing
		// `#EXT-X-ENDLIST` tag (gated on `playlist.done`) is written.
		await this.writePlaylist(playlist);
		if (this.host.isLive && playlist.writtenSegments.length === 0) {
			await this.tryWriteMasterPlaylist();
		}
	}

	async onFinalize(): Promise<void> {
		if (!this.host.isLive) {
			await this.writeMasterPlaylist();
		}
	}

	private toPlaylistInfo(playlist: Playlist): HlsOutputPlaylistInfo {
		return {
			n: playlist.id,
			tracks: playlist.tracks,
			segmentFormat: playlist.segmentFormat,
		};
	}

	private updatePlaylistBitrates(playlist: Playlist): void {
		const segments = playlist.writtenSegments;
		const gtd = this.host.globalTargetDuration;
		const lower = 0.5 * gtd;
		const upper = 1.5 * gtd;
		const cache = playlist.bitrateCache;

		// Per spec, peak bitrate is the largest bit rate of any contiguous set of
		// segments whose total duration is between 0.5 and 1.5 × target duration.
		// Across n appends the from-scratch scan is O(n² · W); the cache below
		// makes it O(n · W) by extending only the windows ending at each new
		// segment. Live trim and gtd changes invalidate the cache.

		// `writtenSegments` slides under live, so count segments ever appended rather than the length
		// of what is currently held — which eviction pins, freezing the cache forever.
		const totalAppended = playlist.mediaSequence + segments.length;

		const fresh = (cache && cache.cachedGtd === gtd && cache.processedCount <= totalAppended)
			? cache
			: { processedCount: 0, cachedGtd: gtd, totalBytes: 0, totalDuration: 0, peakBitrate: 0 };

		for (let k = Math.max(fresh.processedCount, playlist.mediaSequence); k < totalAppended; k++) {
			const held = k - playlist.mediaSequence;
			const seg = segments[held]!;
			fresh.totalBytes += seg.byteSize;
			fresh.totalDuration += seg.duration;

			let windowBytes = 0;
			let windowDuration = 0;
			for (let i = held; i >= 0; i--) {
				windowBytes += segments[i]!.byteSize;
				windowDuration += segments[i]!.duration;
				if (windowDuration > upper) {
					break;
				}
				if (windowDuration >= lower) {
					fresh.peakBitrate = Math.max(fresh.peakBitrate, 8 * windowBytes / windowDuration);
				}
			}
		}
		fresh.processedCount = totalAppended;
		playlist.bitrateCache = fresh;

		let peakBitrate = fresh.peakBitrate;
		// Fallback: if no contiguous set falls within the range, use per-segment max
		if (peakBitrate === 0) {
			for (const segment of segments) {
				const segmentDuration = segment.duration || 1; // To catch 0-duration segments which can happen
				peakBitrate = Math.max(peakBitrate, 8 * segment.byteSize / segmentDuration);
			}
		}

		playlist.peakBitrate = peakBitrate;
		playlist.averageBitrate = (8 * fresh.totalBytes) / (fresh.totalDuration || 1);
	}

	async writePlaylist(playlist: Playlist): Promise<void> {
		assert(this.host.output._target instanceof PathedTarget);
		const pathedTarget = this.host.output._target;

		this.updatePlaylistBitrates(playlist);

		let hasByteOffsets = false;
		for (const segment of playlist.writtenSegments) {
			hasByteOffsets ||= segment.byteOffset !== null;
		}

		const isKeyPacketsOnly = playlist.tracks[0]!.isVideoTrack()
			&& playlist.tracks[0].metadata.hasOnlyKeyPackets;

		const partTarget = this.host.partDuration;
		const listsParts = this.host.isLive
			&& partTarget !== null
			&& playlist.writtenSegments.some(segment => segment.parts !== null);

		let version = 3;
		if (isKeyPacketsOnly || hasByteOffsets) {
			version = 4;
		}
		if (playlist.initSegment) {
			version = 5;
		}
		if (playlist.initSegment && !isKeyPacketsOnly) {
			// "if it contains the EXT-X-MAP tag in a Media Playlist that does not contain EXT-X-I-FRAMES-ONLY"
			version = 6;
		}
		if (listsParts) {
			version = 9; // RFC 8216bis §8: EXT-X-PART requires version 9
		}

		// In live mode, target duration is not allowed to change, so we use the nominal value
		const targetDuration = this.host.isLive ? this.host.targetSegmentDuration : this.host.globalTargetDuration;
		const targetDurationInt = Math.round(targetDuration);

		// Parts stay listed for three target durations past their segment (RFC 8216bis §6.2.2). A player that
		// only ever sees parts on the segment in progress never fetches one by byte range, since its buffer
		// cannot reach the threshold that would make it try.
		const playlistEnd = playlist.writtenSegments.length > 0
			? playlist.writtenSegments[playlist.writtenSegments.length - 1]!.timestamp
			+ playlist.writtenSegments[playlist.writtenSegments.length - 1]!.duration
			: 0;
		const partsRetained = (segment: PipelineSegment) =>
			listsParts && segment.parts !== null && playlistEnd - segment.timestamp <= 3 * targetDurationInt;

		const partLines = (segment: PipelineSegment) => (segment.parts ?? [])
			.map((part) => {
				// A part's offset is stated from its segment; a single-file playlist addresses the whole file
				const offset = (segment.byteOffset ?? 0) + part.offset;
				return `#EXT-X-PART:DURATION=${+part.duration.toFixed(12)},URI="${segment.path}"`
					+ `,BYTERANGE="${part.size}@${offset}"`
					+ (part.independent ? ',INDEPENDENT=YES' : '')
					+ '\n';
			})
			.join('');

		// The hint names where the next part will land: the same file under singleFilePerPlaylist, else the
		// segment the muxer will write next, whose path comes from the very call it will make itself.
		let preloadHint = '';
		if (listsParts && this.options.preloadHint) {
			if (playlist.singleFile) {
				preloadHint = `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${playlist.singleFile.path}"`
					+ `,BYTERANGE-START=${playlist.singleFile.nextOffset}\n`;
			} else {
				const nextPath = await this.host.getSegmentPath({
					n: playlist.nextSegmentId,
					format: playlist.segmentFormat,
					isSingleFile: false,
					playlist: this.toPlaylistInfo(playlist),
					parts: null,
				});
				preloadHint = `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${nextPath}"\n`;
			}
		}

		const playlistPath = joinPaths(pathedTarget.rootPath, playlist.path);
		const playlistText = '#EXTM3U\n'
			+ `#EXT-X-VERSION:${version}\n`
			+ (!this.host.isLive ? '#EXT-X-PLAYLIST-TYPE:VOD\n' : '')
			+ `#EXT-X-TARGETDURATION:${targetDurationInt}\n` // Must be a "decimal-integer"
			+ (listsParts
				? '#EXT-X-SERVER-CONTROL:'
				+ (this.options.canBlockReload ? 'CAN-BLOCK-RELOAD=YES,' : '')
				+ `PART-HOLD-BACK=${+(this.options.partHoldBack ?? 3 * partTarget).toFixed(12)}\n`
				+ `#EXT-X-PART-INF:PART-TARGET=${+partTarget.toFixed(12)}\n`
				: '')
			+ (Number.isFinite(this.host.maxLiveSegmentCount)
				? `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}\n`
				: '')
			+ '#EXT-X-INDEPENDENT-SEGMENTS\n'
			+ (isKeyPacketsOnly ? '#EXT-X-I-FRAMES-ONLY\n' : '')
			+ (playlist.initSegment
				? (`#EXT-X-MAP:URI="${playlist.initSegment.path}"`
					+ (playlist.initSegment.byteOffset !== null
						? `,BYTERANGE="${playlist.initSegment.byteSize}@${playlist.initSegment.byteOffset}"`
						: '')
					+ '\n')
				: '')
			+ '\n'
			+ (playlist.writtenSegments
				.map(segment => (
					(partsRetained(segment) ? partLines(segment) : '')
					+ `#EXTINF:${+segment.duration.toFixed(12)},\n` // Trailing comma mandated by spec
					+ (this.host.isRelativeToUnixEpoch
						? `#EXT-X-PROGRAM-DATE-TIME:${new Date(1000 * segment.timestamp).toISOString()}\n`
						: '')
					+ (segment.byteOffset !== null
						? `#EXT-X-BYTERANGE:${segment.byteSize}@${segment.byteOffset}\n`
						: '')
					+ `${segment.path}\n`
				))
				.join(''))
			+ preloadHint
			+ (playlist.done
				? (playlist.writtenSegments.length > 0 ? '\n' : '') + '#EXT-X-ENDLIST\n'
				: '');

		this.options.onPlaylist?.(playlistText, this.toPlaylistInfo(playlist));

		const target = await this.host.output._getTarget({
			path: playlistPath,
			isRoot: false,
			mimeType: HLS_MIME_TYPE,
		});
		const writer = new Writer(target, true);
		writer.start();
		writer.write(textEncoder.encode(playlistText));

		await writer.flush();
		await writer.finalize();
	}

	async writeMasterPlaylist(): Promise<void> {
		assert(this.host.output._target instanceof PathedTarget);
		const pathedTarget = this.host.output._target;

		let masterPlaylistText = '#EXTM3U\n';
		let firstVariantWritten = false;

		const closedCaptionChannels: ClosedCaptionChannel[] = [];
		for (const decl of this.host.playlistDeclarations) {
			for (const track of decl.playlist.tracks) {
				for (const channel of announcedClosedCaptionChannels(track)) {
					if (!closedCaptionChannels.includes(channel)) {
						closedCaptionChannels.push(channel);
					}
				}
			}
		}

		if (closedCaptionChannels.length > 0) {
			masterPlaylistText += '\n';
			for (const channel of closedCaptionChannels) {
				masterPlaylistText += `#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="${CLOSED_CAPTIONS_GROUP_ID}"`
					+ `,NAME="${channel}",INSTREAM-ID="${channel}",AUTOSELECT=YES\n`;
			}
		}

		let lastGroupId: string | null = null;
		let groupIdTrackCount = 0;
		let hasHadDefaultTrackInGroup = false;

		for (const decl of this.host.playlistDeclarations) {
			if (decl.groupId === null) {
				const isKeyPacketsOnly = decl.playlist.tracks[0]!.isVideoTrack()
					&& decl.playlist.tracks[0].metadata.hasOnlyKeyPackets;

				const codecs: string[] = [];
				for (const track of decl.playlist.tracks) {
					const trackData = this.host.trackDatas.find(x => x.track === track);
					codecs.push(declaredFor(track, trackData, decl.playlist.segmentFormat));
				}

				let peakDeclBitrate = 0;
				let maxRefAverageBitrate = 0;

				// A subtitle rendition's bytes are not part of the variant's media bitrate, so it contributes
				// only its GROUP-ID below, plus its codec when it has one a player can act on.
				const mediaReferences = decl.references.filter(ref => ref.playlist.tracks[0]!.type !== 'subtitle');

				for (const ref of decl.references) {
					const track = ref.playlist.tracks[0]!;
					if (!track.isSubtitleTrack()) {
						continue;
					}

					const subtitleCodec = SUBTITLE_CODEC_TO_RFC6381[track.source._codec];
					if (subtitleCodec && !codecs.includes(subtitleCodec)) {
						codecs.push(subtitleCodec);
					}
				}

				if (mediaReferences.length > 0) {
					const firstRef = mediaReferences[0]!;
					const firstTrack = firstRef.playlist.tracks[0]!;
					const trackData = this.host.trackDatas.find(x => x.track === firstTrack);
					codecs.push(declaredFor(firstTrack, trackData, firstRef.playlist.segmentFormat));

					for (const ref of mediaReferences) {
						assert(ref.playlist.peakBitrate !== null);
						peakDeclBitrate = Math.max(peakDeclBitrate, ref.playlist.peakBitrate);
						maxRefAverageBitrate = Math.max(maxRefAverageBitrate, ref.playlist.averageBitrate ?? 0);
					}
				}

				assert(decl.playlist.peakBitrate !== null);
				const totalPeakBitrate = decl.playlist.peakBitrate + peakDeclBitrate;
				const totalAverageBitrate = (decl.playlist.averageBitrate ?? 0) + maxRefAverageBitrate;

				if (!firstVariantWritten) {
					masterPlaylistText += '\n';
					firstVariantWritten = true;
				}

				if (isKeyPacketsOnly) {
					masterPlaylistText += `#EXT-X-I-FRAME-STREAM-INF:`;
				} else {
					masterPlaylistText += `#EXT-X-STREAM-INF:`;
				}

				masterPlaylistText += `BANDWIDTH=${Math.ceil(totalPeakBitrate)}`;

				if (totalAverageBitrate > 0) {
					masterPlaylistText += `,AVERAGE-BANDWIDTH=${Math.ceil(totalAverageBitrate)}`;
				}

				masterPlaylistText += `,CODECS="${codecs.join(',')}"`;

				const videoTrack = decl.playlist.tracks.find(x => x.isVideoTrack());
				if (videoTrack?.isVideoTrack()) {
					const trackData = this.host.trackDatas.find(x => x.track === videoTrack);
					const decoderConfig = trackData?.info.type === 'video' ? trackData.info.decoderConfig : undefined;
					if (decoderConfig) {
						let width = decoderConfig.displayAspectWidth ?? decoderConfig.codedWidth;
						let height = decoderConfig.displayAspectHeight ?? decoderConfig.codedHeight;

						if (width !== undefined && height !== undefined) {
							if (
								videoTrack.metadata.rotation !== undefined
								&& videoTrack.metadata.rotation % 180 === 90
							) {
								[width, height] = [height, width];
							}

							masterPlaylistText += `,RESOLUTION=${width}x${height}`;
						}

						const videoRange = hlsVideoRange(decoderConfig.colorSpace);
						if (videoRange !== null) {
							masterPlaylistText += `,VIDEO-RANGE=${videoRange}`;
						}
					}

					// FRAME-RATE is not defined for EXT-X-I-FRAME-STREAM-INF
					if (!isKeyPacketsOnly && videoTrack.metadata.frameRate !== undefined) {
						// Spec requires that frame rate be rounded to 3 decimal places
						masterPlaylistText += `,FRAME-RATE=${+videoTrack.metadata.frameRate.toFixed(3)}`;
					}
				}

				if (!isKeyPacketsOnly) {
					const groupIdForType = new Map<TrackType, string>();
					for (const ref of decl.references) {
						assert(ref.groupId !== null);
						const type = ref.playlist.tracks[0]!.type;
						groupIdForType.set(type, ref.groupId);
					}

					for (const [type, id] of groupIdForType) {
						masterPlaylistText += `,${HLS_MEDIA_TYPES[type]}="${id}"`;
					}

					// CLOSED-CAPTIONS is not defined for EXT-X-I-FRAME-STREAM-INF, hence the shared guard.
					if (videoTrack && announcedClosedCaptionChannels(videoTrack).length > 0) {
						masterPlaylistText += `,CLOSED-CAPTIONS="${CLOSED_CAPTIONS_GROUP_ID}"`;
					}
				}

				if (isKeyPacketsOnly) {
					// EXT-X-I-FRAME-STREAM-INF is standalone with a URI attribute
					masterPlaylistText += `,URI="${decl.playlist.path}"`;
					masterPlaylistText += '\n';
				} else {
					masterPlaylistText += '\n';
					masterPlaylistText += `${decl.playlist.path}\n`;
				}
			} else {
				assert(decl.playlist.tracks.length === 1);

				const track = decl.playlist.tracks[0]!;
				const type = track.type;
				let name = track.metadata.name ?? null;
				const languageCode = track.metadata.languageCode;
				const disposition = track.metadata.disposition;

				if (lastGroupId === null || decl.groupId !== lastGroupId) {
					groupIdTrackCount = 0;
					masterPlaylistText += '\n';
					hasHadDefaultTrackInGroup = false;
				}
				lastGroupId = decl.groupId;
				groupIdTrackCount++;

				masterPlaylistText += `#EXT-X-MEDIA:TYPE=${HLS_MEDIA_TYPES[type]},GROUP-ID="${decl.groupId}"`;

				if (name !== null && /[\n\r"]/.test(name)) {
					console.warn(
						'Dropping track name since it includes a line feed, carriage return, or double quote'
						+ ' character, which are not allowed in HLS playlist attributes.',
					);
					name = null;
				}

				// Name is required, so we have to set it to SOMETHING
				name ??= `${languageCode ?? decl.groupId}-${groupIdTrackCount}`;

				masterPlaylistText += `,NAME="${name}"`;

				if (languageCode !== undefined) {
					masterPlaylistText += `,LANGUAGE="${languageCode}"`;
				}

				const dispositionPrimary = disposition?.primary ?? false;
				const dispositionDefault = disposition?.default ?? true;
				const dispositionForced = disposition?.forced ?? false;

				if (dispositionPrimary && !hasHadDefaultTrackInGroup) {
					// HLS's "DEFAULT" behaves like our "primary"
					masterPlaylistText += ',DEFAULT=YES';
					hasHadDefaultTrackInGroup = true; // Only one DEFAULT label per group allowed
				}

				if (dispositionPrimary || dispositionDefault) {
					masterPlaylistText += ',AUTOSELECT=YES';
				}

				if (dispositionForced) {
					masterPlaylistText += ',FORCED=YES';
				}

				if (type === 'audio') {
					const trackData = this.host.trackDatas.find(x => x.track === track);
					const decoderConfig = trackData?.info.type === 'audio' ? trackData.info.decoderConfig : undefined;

					if (decoderConfig) {
						masterPlaylistText += `,CHANNELS="${decoderConfig.numberOfChannels}"`;
					}
				}

				if (!decl.noUri) {
					masterPlaylistText += `,URI="${decl.playlist.path}"`;
				}

				masterPlaylistText += '\n';
			}
		}

		this.options.onMaster?.(masterPlaylistText);

		const release = await this.host.acquireMutex();

		try {
			let writer: Writer;
			if (this.host.numWrittenMasterPlaylists === 0) {
				// For the first master playlist write, we use the normal root writer getter, so that the target
				// returned by Output.target emits valid write events.
				writer = await this.host.output._getRootWriter(true);
			} else {
				// For subsequent master playlist writes, we *must* obtain a different target in order to overwrite
				// the file.
				const target = await this.host.output._getTarget({
					path: pathedTarget.rootPath,
					isRoot: true,
					mimeType: HLS_MIME_TYPE,
				});
				writer = new Writer(target, true);
				writer.start();
			}

			writer.write(textEncoder.encode(masterPlaylistText));

			await writer.flush();
			await writer.finalize();

			this.host.noteMasterPlaylistWritten();
		} finally {
			release();
		}
	}

	async tryWriteMasterPlaylist(): Promise<void> {
		assert(this.host.isLive);

		// The master playlist is written once all playlists have either produced at least one segment or are done
		for (const playlist of this.host.playlists) {
			if (playlist.writtenSegments.length === 0 && !playlist.done) {
				return;
			}
		}

		await this.writeMasterPlaylist();
	}
}
