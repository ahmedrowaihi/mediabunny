/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MalformedInputError, UnsupportedMediaError } from '../errors';
import {
	AUDIO_CODECS,
	AudioCodec,
	inferCodecFromCodecString,
	MediaCodec,
	VIDEO_CODECS,
	VideoCodec,
} from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { MetadataTags } from '../metadata';
import { arrayArgmin, assert, joinPaths, MaybePromise, TransformationMatrix, UNDETERMINED_LANGUAGE } from '../misc';
import { readAllLines } from '../reader';
import { SegmentedTrackBacking } from '../segmented-track-backing';
import {
	canIgnoreLine,
	HlsPlaylistVariables,
	HLS_MIME_TYPE,
} from './hls-misc';
import {
	type HlsIFrameStream,
	type HlsMasterPlaylist,
	type HlsMediaRendition,
	type HlsVariant,
	parseChannelCount,
	parseHlsPlaylist,
} from './hls-playlist-parser';
import { HlsSegmentedInput } from './hls-segmented-input';
import { SegmentedInputTrackDeclaration } from '../segmented-input';
import { PathedSource } from '../source';

type VariantStream = {
	fullPath: string;
	variant: HlsVariant;
	lineNumber: number;
	hasOnlyKeyPackets: boolean;
};

type MediaTagEntry = {
	media: HlsMediaRendition;
	fullPath: string | null;
	lineNumber: number;
};

const iFrameStreamAsVariant = (v: HlsIFrameStream): HlsVariant => ({
	watermarkingVariant: null,
	uri: v.uri,
	bandwidth: v.bandwidth,
	averageBandwidth: v.averageBandwidth,
	codecs: v.codecs,
	supplementalCodecs: v.supplementalCodecs,
	score: v.score,
	stableVariantId: v.stableVariantId,
	pathwayId: v.pathwayId,
	allowedCpc: v.allowedCpc,
	reqVideoLayout: v.reqVideoLayout,
	resolution: v.resolution,
	frameRate: null,
	videoRange: v.videoRange,
	hdcpLevel: v.hdcpLevel,
	audioGroup: null,
	videoGroup: v.videoGroup,
	subtitlesGroup: null,
	closedCaptionsGroup: null,
	name: v.name,
	channels: null,
	lineNumber: v.lineNumber,
});

type InternalTrack = {
	id: number;
	demuxer: HlsDemuxer;
	backingTrack: InputTrackBacking | null;
	default: boolean;
	autoselect: boolean;
	languageCode: string;
	lineNumber: number;

	fullPath: string;
	codec: MediaCodec;
	fullCodecString: string | null;
	pairingMask: bigint;
	peakBitrate: number | null;
	averageBitrate: number | null;
	name: string | null;
	hasOnlyKeyPackets: boolean;

	info: {
		type: 'video';
		width: number | null;
		height: number | null;
	} | {
		type: 'audio';
		numberOfChannels: number | null;
	};
};
type InternalVideoTrack = InternalTrack & { info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & { info: { type: 'audio' } };

const MAX_VARIANT_STREAMS = 256;
const MAX_MEDIA_TAGS = 256;

export class HlsDemuxer extends Demuxer {
	metadataPromise: Promise<void> | null = null;
	trackBackings: InputTrackBacking[] | null = null;
	internalTracks: InternalTrack[] | null = null;
	segmentedInputs: HlsSegmentedInput[] = [];
	hasMasterPlaylist = true;
	masterPlaylistVariables: HlsPlaylistVariables | null = null;
	mediaOffsets = new Map<number, Promise<number>>();

	constructor(input: Input) {
		super(input);
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			assert(this.input._rootSource instanceof PathedSource);

			const slice = await this.input._reader.requestEntireFile();
			assert(slice);
			const lines = readAllLines(slice, slice.length, { ignore: canIgnoreLine });

			// Important: get the root path AFTER reading data to get the final root path, possibly affected by
			// redirects. Any follow requests should be related to the redirected path, not the original one.
			const { rootPath } = this.input._rootSource;
			let playlist: HlsMasterPlaylist;
			try {
				const variables = new HlsPlaylistVariables(rootPath, null);
				const parsed = parseHlsPlaylist(lines.join('\n'), variables);
				this.masterPlaylistVariables = variables;
				if (parsed.kind === 'media') {
					// This is a media playlist, not a master playlist
					const segmentedInput = new HlsSegmentedInput(this, rootPath, null, lines);

					this.segmentedInputs = [segmentedInput];
					this.hasMasterPlaylist = false;
					this.trackBackings = await segmentedInput.getTrackBackings();

					return;
				}
				playlist = parsed;
			} catch (e) {
				if (e instanceof Error && e.message.startsWith('Invalid HLS')) {
					throw new MalformedInputError(
						`Incorrect M3U8 file; ${e.message.replace(/^Invalid HLS [a-z]+ playlist: /, '')}.`,
					);
				}
				throw e;
			}

			// Sort by document line number so pairing-mask bit assignment matches the original
			// linear-walk implementation when STREAM-INF and I-FRAME-STREAM-INF are interleaved.
			const variantStreams: VariantStream[] = [
				...playlist.variants.map((v): VariantStream => ({
					fullPath: joinPaths(rootPath, v.uri),
					variant: v,
					lineNumber: v.lineNumber,
					hasOnlyKeyPackets: false,
				})),
				...playlist.iFrameStreams.map((v): VariantStream => ({
					fullPath: joinPaths(rootPath, v.uri),
					variant: iFrameStreamAsVariant(v),
					lineNumber: v.lineNumber,
					hasOnlyKeyPackets: true,
				})),
			].sort((a, b) => a.lineNumber - b.lineNumber);

			const mediaTags: MediaTagEntry[] = playlist.media.map(m => ({
				media: m,
				fullPath: m.uri !== null ? joinPaths(rootPath, m.uri) : null,
				lineNumber: m.lineNumber,
			}));

			if (variantStreams.length > MAX_VARIANT_STREAMS || mediaTags.length > MAX_MEDIA_TAGS) {
				throw new UnsupportedMediaError('Unsupported M3U8 file; too many variant streams or media tags.');
			}

			// Now, let's process & resolve all variant streams in parallel, mapping each of them to tracks.

			const internalTracksByVariant = await Promise.all(variantStreams.map(async (variantStream, i) => {
				const result: InternalTrack[] = [];
				const variant = variantStream.variant;

				let codecStrings: string[];
				if (variant.codecs) {
					codecStrings = variant.codecs.split(',').map(x => x.trim());
				} else {
					// No codecs were specified, we need to read the underlying media data
					const segmentedInput = this.getSegmentedInputForPath(variantStream.fullPath);
					const trackBackings = await segmentedInput.getTrackBackings();

					const tracksWithCodec = await Promise.all(
						trackBackings.map(async t => ({ track: t, codec: await t.getCodec() })),
					);
					codecStrings = await Promise.all(
						tracksWithCodec
							.filter(x => x.codec !== null)
							.map(x => x.track.getDecoderConfig().then(x => x!.codec)),
					);
				}

				const videoGroupId = variant.videoGroup;
				const audioGroupId = variant.audioGroup;
				const containsVideoCodecs = codecStrings.some(x =>
					VIDEO_CODECS.includes(inferCodecFromCodecString(x) as VideoCodec),
				);
				const containsAudioCodecs = codecStrings.some(x =>
					AUDIO_CODECS.includes(inferCodecFromCodecString(x) as AudioCodec),
				);

				if (videoGroupId !== null && !containsVideoCodecs) {
					// A video group is linked but no video codec is listed, sigh. Let's resolve the video codec.

					// We only need to look at the first matching tag, since all tags are required to have the same
					// codec anyway
					const matchingVideoMediaTag = mediaTags.find(
						tag => tag.media.groupId === videoGroupId && tag.media.type === 'VIDEO',
					);

					outer:
					if (matchingVideoMediaTag) {
						if (matchingVideoMediaTag.fullPath === null) {
							break outer;
						}

						const segmentedInput = this.getSegmentedInputForPath(matchingVideoMediaTag.fullPath);
						const trackBackings = await segmentedInput.getTrackBackings();
						const videoTrack = trackBackings.find(x => x.getType() === 'video');

						if (!videoTrack || (await videoTrack.getCodec()) === null) {
							break outer;
						}

						const additionalCodecString = await videoTrack.getDecoderConfig().then(x => x?.codec ?? null);
						assert(additionalCodecString !== null);

						codecStrings.push(additionalCodecString);
					}
				}

				if (audioGroupId !== null && !containsAudioCodecs) {
					// An audio group is linked but no audio codec is listed, sigh. Let's resolve the audio codec.

					// We only need to look at the first matching tag, since all tags are required to have the same
					// codec anyway
					const matchingAudioMediaTag = mediaTags.find(
						tag => tag.media.groupId === audioGroupId && tag.media.type === 'AUDIO',
					);

					outer:
					if (matchingAudioMediaTag) {
						if (matchingAudioMediaTag.fullPath === null) {
							break outer;
						}

						const segmentedInput = this.getSegmentedInputForPath(matchingAudioMediaTag.fullPath);
						const trackBackings = await segmentedInput.getTrackBackings();
						const audioTrack = trackBackings.find(x => x.getType() === 'audio');

						if (!audioTrack || (await audioTrack.getCodec()) === null) {
							break outer;
						}

						const additionalCodecString = await audioTrack.getDecoderConfig().then(x => x?.codec ?? null);
						assert(additionalCodecString !== null);

						codecStrings.push(additionalCodecString);
					}
				}

				// Unique that shit
				codecStrings = [...new Set(codecStrings)];

				const bandwidth = variant.bandwidth;
				const averageBandwidth = variant.averageBandwidth;
				const name = variant.name;

				// Several strings for one codec differ only in profile or level, so none describes this track
				const resolveCodec = async (typeStrings: string[], type: 'video' | 'audio') => {
					if (typeStrings.length === 0) {
						return null;
					}

					const codecs = new Set(typeStrings.map(x => inferCodecFromCodecString(x)));
					if (codecs.size === 1) {
						const [codec] = codecs;
						assert(codec);
						return { codec, fullCodecString: typeStrings.length === 1 ? typeStrings[0]! : null };
					}

					const segmentedInput = this.getSegmentedInputForPath(variantStream.fullPath);
					const backings = (await segmentedInput.getTrackBackings())
						.filter(x => x.getType() === type);
					if (backings.length !== 1) {
						throw new UnsupportedMediaError(
							`Unsupported M3U8 file; a variant stream lists several ${type} codecs, but its media`
							+ ` does not contain exactly one ${type} track.`,
						);
					}

					const codec = await backings[0]!.getCodec();
					if (codec === null) {
						return null;
					}

					return { codec, fullCodecString: await backings[0]!.getMetadataCodecParameterString?.() ?? null };
				};

				const inferredPerString = codecStrings.map(x => ({
					codecString: x,
					inferred: inferCodecFromCodecString(x),
				}));
				const videoStrings = inferredPerString
					.filter(x => x.inferred !== null && VIDEO_CODECS.includes(x.inferred as VideoCodec))
					.map(x => x.codecString);
				const audioStrings = inferredPerString
					.filter(x => x.inferred !== null && AUDIO_CODECS.includes(x.inferred as AudioCodec))
					.map(x => x.codecString);

				const resolvedVideo = await resolveCodec(videoStrings, 'video');
				const resolvedAudio = await resolveCodec(audioStrings, 'audio');

				const videoDecls: InternalTrack[] = [];
				const audioDecls: InternalTrack[] = [];

				if (resolvedVideo) {
					const videoCodecString = resolvedVideo.fullCodecString;
					const videoCodec = resolvedVideo.codec;

					if (videoGroupId === null) {
						videoDecls.push({
							id: -1,
							demuxer: this,
							backingTrack: null,
							default: true,
							autoselect: true,
							languageCode: UNDETERMINED_LANGUAGE,
							lineNumber: variantStream.lineNumber,
							fullPath: variantStream.fullPath,
							codec: videoCodec,
							fullCodecString: videoCodecString,
							pairingMask: 1n << BigInt(i),
							peakBitrate: bandwidth,
							averageBitrate: averageBandwidth,
							name,
							hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
							info: {
								type: 'video',
								width: variant.resolution?.width ?? null,
								height: variant.resolution?.height ?? null,
							},
						});
					} else {
						for (const mediaTag of mediaTags) {
							if (mediaTag.media.groupId !== videoGroupId || mediaTag.media.type !== 'VIDEO') {
								continue;
							}

							const resolution = mediaTag.media.resolution ?? variant.resolution;

							videoDecls.push({
								id: -1,
								demuxer: this,
								backingTrack: null,
								default: mediaTag.media.default === true,
								// Autoselect is inferred to be true if the default is true
								autoselect: mediaTag.media.default === true || mediaTag.media.autoselect === true,
								languageCode: preprocessLanguageCode(mediaTag.media.language),
								lineNumber: mediaTag.lineNumber,
								fullPath: mediaTag.fullPath ?? variantStream.fullPath,
								codec: videoCodec,
								fullCodecString: videoCodecString,
								pairingMask: 1n << BigInt(i),
								peakBitrate: mediaTag.fullPath === null ? bandwidth : null,
								averageBitrate: mediaTag.fullPath === null ? averageBandwidth : null,
								name: mediaTag.media.name,
								hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
								info: {
									type: 'video',
									width: resolution?.width ?? null,
									height: resolution?.height ?? null,
								},
							});
						}
					}
				}

				if (resolvedAudio) {
					const audioCodecString = resolvedAudio.fullCodecString;
					const audioCodec = resolvedAudio.codec;

					if (audioGroupId === null) {
						const parsedChannels = parseChannelCount(variant.channels);

						audioDecls.push({
							id: -1,
							demuxer: this,
							backingTrack: null,
							default: true,
							autoselect: true,
							languageCode: UNDETERMINED_LANGUAGE,
							lineNumber: variantStream.lineNumber,
							fullPath: variantStream.fullPath,
							codec: audioCodec,
							fullCodecString: audioCodecString,
							pairingMask: 1n << BigInt(i),
							peakBitrate: bandwidth,
							averageBitrate: averageBandwidth,
							name,
							hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
							info: {
								type: 'audio',
								numberOfChannels: parsedChannels,
							},
						});
					} else {
						for (const mediaTag of mediaTags) {
							if (mediaTag.media.groupId !== audioGroupId || mediaTag.media.type !== 'AUDIO') {
								continue;
							}

							const parsedChannels = parseChannelCount(mediaTag.media.channels ?? variant.channels);

							audioDecls.push({
								id: -1,
								demuxer: this,
								backingTrack: null,
								default: mediaTag.media.default === true,
								// Autoselect is inferred to be true if the default is true
								autoselect: mediaTag.media.default === true || mediaTag.media.autoselect === true,
								languageCode: preprocessLanguageCode(mediaTag.media.language),
								lineNumber: mediaTag.lineNumber,
								fullPath: mediaTag.fullPath ?? variantStream.fullPath,
								codec: audioCodec,
								fullCodecString: audioCodecString,
								pairingMask: 1n << BigInt(i),
								peakBitrate: mediaTag.fullPath === null ? bandwidth : null,
								averageBitrate: mediaTag.fullPath === null ? averageBandwidth : null,
								name: mediaTag.media.name,
								hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
								info: {
									type: 'audio',
									numberOfChannels: parsedChannels,
								},
							});
						}
					}
				}

				// In the order CODECS lists them: track ids follow the order declarations are added, and a
				// playlist that names its audio first used to get the lower id.
				const firstVideo = inferredPerString.findIndex(x =>
					x.inferred !== null && VIDEO_CODECS.includes(x.inferred as VideoCodec));
				const firstAudio = inferredPerString.findIndex(x =>
					x.inferred !== null && AUDIO_CODECS.includes(x.inferred as AudioCodec));
				const videoComesFirst = firstVideo !== -1 && (firstAudio === -1 || firstVideo < firstAudio);

				result.push(...(videoComesFirst
					? [...videoDecls, ...audioDecls]
					: [...audioDecls, ...videoDecls]));
				return result;
			}));

			const internalTracks: InternalTrack[] = [];
			const addInternalTrack = (track: InternalTrack) => {
				const existingTrack = internalTracks.find(x =>
					x.fullPath === track.fullPath && x.info.type === track.info.type,
				);

				if (existingTrack) {
					existingTrack.pairingMask |= track.pairingMask;
					existingTrack.default ||= track.default;
					existingTrack.autoselect ||= track.autoselect;
					existingTrack.lineNumber = Math.min(existingTrack.lineNumber, track.lineNumber);

					if (track.peakBitrate !== null) {
						existingTrack.peakBitrate = Math.max(
							existingTrack.peakBitrate ?? -Infinity,
							track.peakBitrate,
						);
					}
					if (track.averageBitrate !== null) {
						existingTrack.averageBitrate = Math.max(
							existingTrack.averageBitrate ?? -Infinity,
							track.averageBitrate,
						);
					}

					if (existingTrack.languageCode === UNDETERMINED_LANGUAGE) {
						existingTrack.languageCode = track.languageCode;
					}
				} else {
					track.id = internalTracks.length + 1;
					internalTracks.push(track);
				}
			};

			for (const variantInternalTracks of internalTracksByVariant) {
				for (const trackEntry of variantInternalTracks) {
					addInternalTrack(trackEntry);
				}
			}

			// Order tracks by how they appear in the file
			internalTracks.sort((a, b) => a.lineNumber - b.lineNumber);

			this.trackBackings = [];
			for (const internalTrack of internalTracks) {
				if (internalTrack.info.type === 'video') {
					this.trackBackings.push(
						new HlsInputVideoTrackBacking(internalTrack as InternalVideoTrack),
					);
				} else {
					this.trackBackings.push(
						new HlsInputAudioTrackBacking(internalTrack as InternalAudioTrack),
					);
				}
			}

			this.internalTracks = internalTracks;
		})();
	}

	async getTrackBackings() {
		await this.readMetadata();
		assert(this.trackBackings);

		return this.trackBackings;
	}

	getMediaOffsetForDiscontinuity(discontinuityNumber: number) {
		let promise = this.mediaOffsets.get(discontinuityNumber);
		if (promise) {
			return promise;
		}

		promise = (async () => {
			// All playlists share their media's timestamps within a discontinuity, so the reference playlist alone
			// defines global timestamps. For the reference track, the first packet of any discontinuity lands exactly
			// on the timestamp of the discontinuity's first segment. This ensures that time starts at 0 (unless
			// PDT is used) and that discontinuities don't mess with overall timestamp continuity.
			const referenceSegmentedInput = this.getReferenceSegmentedInput();

			let segment = await referenceSegmentedInput.getFirstSegment();
			while (segment && segment.discontinuityNumber < discontinuityNumber) {
				segment = await referenceSegmentedInput.getNextSegment(segment, {});
			}

			if (!segment || segment.discontinuityNumber !== discontinuityNumber) {
				throw new Error(
					`The reference playlist contains no segment in discontinuity ${discontinuityNumber}, so the`
					+ ' discontinuity can\'t be synchronized across tracks. If you think this is a bug, please raise an'
					+ ' issue and include the playlist.',
				);
			}

			const input = referenceSegmentedInput.getInputForSegment(segment);
			const rawTimestampOffset = await referenceSegmentedInput.getRawTimestampOffset(input) ?? 0;

			const tracks = await input.getTracks();
			const track = tracks.find(x => x.type === 'video') ?? tracks[0];
			if (!track) {
				throw new Error('The reference playlist\'s segment contains no tracks.');
			}

			return segment.timestamp - (rawTimestampOffset + await track.getFirstTimestamp());
		})();
		this.mediaOffsets.set(discontinuityNumber, promise);

		return promise;
	}

	getReferenceSegmentedInput() {
		if (!this.hasMasterPlaylist) {
			return this.segmentedInputs[0]!;
		}

		assert(this.internalTracks);

		// Key-only renditions are a poor reference but may be all there is: this fork reads
		// #EXT-X-I-FRAMES-ONLY playlists, and a master listing only those left nothing to choose
		const fullTracks = this.internalTracks.filter(x => !x.hasOnlyKeyPackets);
		const candidates = fullTracks.length > 0 ? fullTracks : this.internalTracks;
		const videoCandidates = candidates.filter(x => x.info.type === 'video');
		const pool = videoCandidates.length > 0 ? videoCandidates : candidates;
		const index = arrayArgmin(pool, x => x.peakBitrate ?? Infinity);
		assert(index !== -1);

		return this.getSegmentedInputForPath(pool[index]!.fullPath);
	}

	getSegmentedInputForPath(path: string) {
		let segmentedInput = this.segmentedInputs.find(x => x.path === path);
		if (segmentedInput) {
			return segmentedInput;
		}

		let decls: SegmentedInputTrackDeclaration[] | null = null;
		if (this.internalTracks) {
			const tracks = this.internalTracks.filter(x => x.fullPath === path);
			decls = tracks.map(x => ({
				id: x.id,
				type: x.info.type,
			}));
		}

		segmentedInput = new HlsSegmentedInput(this, path, decls, null);
		this.segmentedInputs.push(segmentedInput);

		return segmentedInput;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	async getMimeType(): Promise<string> {
		return HLS_MIME_TYPE;
	}

	override dispose(): void {
		if (this.segmentedInputs) {
			for (const segInput of this.segmentedInputs) {
				segInput.dispose();
			}
			this.segmentedInputs.length = 0;
		}
	}
}

abstract class HlsInputTrackBacking extends SegmentedTrackBacking<InternalTrack> {
	hydrationPromise: Promise<void> | null = null;
	hydrate() {
		return this.hydrationPromise ??= (async () => {
			const segmentedInput = this.internalTrack.demuxer.getSegmentedInputForPath(this.internalTrack.fullPath);

			let trackBacking: InputTrackBacking | null = null;

			const trackBackings = await segmentedInput.getTrackBackings();
			const matchingType = trackBackings.filter(x => x.getType() === this.getType());

			if (matchingType.length === 1) {
				// Avoids reading fields on the track
				trackBacking = matchingType[0]!;
			} else {
				if (this instanceof HlsInputVideoTrackBacking) {
					for (const backing of matchingType) {
						if ((await backing.getCodec()) === this.getCodec()) {
							trackBacking = backing;
							break;
						}
					}
				} else {
					assert(this instanceof HlsInputAudioTrackBacking);

					for (const backing of matchingType) {
						if ((await backing.getCodec()) === this.getCodec()) {
							trackBacking = backing;
							break;
						}
					}
				}
			}

			if (!trackBacking) {
				throw new MalformedInputError('Could not find matching track in underlying media data.');
			}

			this.internalTrack.backingTrack = trackBacking;
		})();
	}

	getHasOnlyKeyPackets() {
		return this.internalTrack.hasOnlyKeyPackets || null;
	}

	protected isPrimary(): boolean {
		// Meanings are swapped in HLS: "default" means the track is the primary one.
		return this.internalTrack.default;
	}
}

class HlsInputVideoTrackBacking
	extends HlsInputTrackBacking
	implements InputVideoTrackBacking {
	declare internalTrack: InternalVideoTrack;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
	}

	get backingVideoTrack() {
		return this.internalTrack.backingTrack as InputVideoTrackBacking | null;
	}

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec | null {
		return this.internalTrack.codec as VideoCodec;
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

	getTransformationMatrix(): MaybePromise<TransformationMatrix> {
		return this.delegate(() => this.backingVideoTrack!.getTransformationMatrix());
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
		return this.internalTrack.fullCodecString;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		await this.hydrate();

		if ((await this.backingVideoTrack!.getCodec()) !== this.getCodec()) {
			// We check as late as possible, and we gotta check here
			throw new MalformedInputError('The codec in the playlist doesn\'t match the codec of the media data.');
		}

		return this.backingVideoTrack!.getDecoderConfig();
	}
}

class HlsInputAudioTrackBacking
	extends HlsInputTrackBacking
	implements InputAudioTrackBacking {
	declare internalTrack: InternalAudioTrack;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
	}

	get backingAudioTrack() {
		return this.internalTrack.backingTrack as InputAudioTrackBacking | null;
	}

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec | null {
		return this.internalTrack.codec as AudioCodec;
	}

	getNumberOfChannels(): MaybePromise<number> {
		if (this.internalTrack.info.numberOfChannels !== null) {
			return this.internalTrack.info.numberOfChannels;
		}

		return this.delegate(() => this.backingAudioTrack!.getNumberOfChannels());
	}

	getSampleRate(): MaybePromise<number> {
		return this.delegate(() => this.backingAudioTrack!.getSampleRate());
	}

	getMetadataCodecParameterString(): string | null {
		if (this.backingAudioTrack) {
			return null;
		}
		return this.internalTrack.fullCodecString;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		await this.hydrate();

		if ((await this.backingAudioTrack!.getCodec()) !== this.getCodec()) {
			// We check as late as possible, and we gotta check here
			throw new MalformedInputError('The codec in the playlist doesn\'t match the codec of the media data.');
		}

		return this.backingAudioTrack!.getDecoderConfig();
	}
}

const preprocessLanguageCode = (code: string | null) => {
	if (code === null) {
		return UNDETERMINED_LANGUAGE;
	}

	const languageSubtag = code.split('-')[0];
	if (!languageSubtag) {
		return UNDETERMINED_LANGUAGE;
	}

	// Technically invalid, for now: The language subtag might be a language code from ISO 639-1,
	// ISO 639-2, ISO 639-3, ISO 639-5 or some other thing (source: Wikipedia). But, `languageCode` is
	// documented as ISO 639-2. Changing the definition would be a breaking change. This will get
	// cleaned up in the future by defining languageCode to be BCP 47 instead.
	return languageSubtag;
};
