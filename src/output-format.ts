/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AdtsMuxer } from './adts/adts-muxer';
import {
	AUDIO_CODECS,
	AUDIO_CODECS_WITH_DELTA_PACKETS,
	AudioCodec,
	MediaCodec,
	NON_PCM_AUDIO_CODECS,
	PCM_AUDIO_CODECS,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { FlacMuxer } from './flac/flac-muxer';
import { IsobmffMuxer } from './isobmff/isobmff-muxer';
import { MatroskaMuxer } from './matroska/matroska-muxer';
import { MediaSource } from './media-source';
import { Mp3Muxer } from './mp3/mp3-muxer';
import { Muxer, NullMuxer } from './muxer';
import { OggMuxer } from './ogg/ogg-muxer';
import { Output, OutputTrack, TrackType } from './output';
import { MpegTsMuxer } from './mpeg-ts/mpeg-ts-muxer';
import { WaveMuxer } from './wave/wave-muxer';
import { DashManifestEmitter } from './dash/dash-manifest-emitter';
import type { DashProfile, MpdParams, MpdType } from './dash/dash-types';
import { HlsManifestEmitter } from './hls/hls-manifest-emitter';
import { SegmentPipelineMuxer } from './segment-pipeline-muxer';
import { HLS_MIME_TYPE } from './hls/hls-misc';
import { WEBVTT_FILE_EXTENSION, WEBVTT_MIME_TYPE, WebvttMuxer } from './hls/hls-webvtt';
import { MaybePromise, FilePath, isNumber, toArray } from './misc';
import { Target } from './target';

/**
 * Specifies an inclusive range of integers.
 * @group Miscellaneous
 * @public
 */
export type InclusiveIntegerRange = {
	/** The integer cannot be less than this. */
	min: number;
	/** The integer cannot be greater than this. */
	max: number;
};

/**
 * Specifies the number of tracks (for each track type and in total) that an output format supports.
 * @group Output formats
 * @public
 */
export type TrackCountLimits = {
	[K in TrackType]: InclusiveIntegerRange;
} & {
	/** Specifies the overall allowed range of track counts for the output format. */
	total: InclusiveIntegerRange;
};

/**
 * Base class representing an output media file format.
 * @group Output formats
 * @public
 */
export abstract class OutputFormat {
	/** @internal */
	abstract _createMuxer(output: Output): Muxer;
	/** @internal */
	abstract get _name(): string;

	/** The file extension used by this output format, beginning with a dot. */
	abstract get fileExtension(): string;
	/** The base MIME type of the output format. */
	abstract get mimeType(): string;
	/** Returns a list of media codecs that this output format can contain. */
	abstract getSupportedCodecs(): MediaCodec[];
	/** Returns the number of tracks that this output format supports. */
	abstract getSupportedTrackCounts(): TrackCountLimits;
	/** Whether this output format supports video rotation and flip metadata. */
	abstract get supportsVideoTransformationMetadata(): boolean;
	/**
	 * Whether this output format supports video rotation metadata.
	 * @deprecated Use {@link OutputFormat.supportsVideoTransformationMetadata} instead.
	 */
	get supportsVideoRotationMetadata() {
		return this.supportsVideoTransformationMetadata;
	}
	/**
	 * Whether this output format's tracks store timestamped media data. When `true`, the timestamps of added packets
	 * will be respected, allowing things like gaps in media data or non-zero start times. When `false`, the format's
	 * media data implicitly starts at zero and follows an implicit sequential timing from there, using the intrinsic
	 * durations of the media data.
	 */
	abstract get supportsTimestampedMediaData(): boolean;
	/**
	 * The degree to which this output format supports writing media data with negative timestamps.
	 * - `'full'` - Negative timestamps are fully supported.
	 * - `'prefer-non-negative'` - Negative timestamps are technically supported, but their use is discouraged.
	 * - `'none'` - Negative timestamps are not supported.
	 * - `null` - Not applicable since the container doesn't support timestamped media at all.
	 */
	abstract get negativeTimestampSupport(): 'full' | 'prefer-non-negative' | 'none' | null;

	/**
	 * Whether this output format, as configured, requires {@link BaseTrackMetadata.maximumPacketCount} to be set in
	 * the metadata of every track added to it.
	 */
	get requiresMaximumPacketCount() {
		return false;
	}

	/** Returns a list of video codecs that this output format can contain. */
	getSupportedVideoCodecs(): VideoCodec[] {
		return this.getSupportedCodecs()
			.filter(codec => (VIDEO_CODECS as readonly string[]).includes(codec)) as VideoCodec[];
	}

	/** Returns a list of audio codecs that this output format can contain. */
	getSupportedAudioCodecs(): AudioCodec[] {
		return this.getSupportedCodecs()
			.filter(codec => (AUDIO_CODECS as readonly string[]).includes(codec)) as AudioCodec[];
	}

	/** Returns a list of subtitle codecs that this output format can contain. */
	getSupportedSubtitleCodecs(): SubtitleCodec[] {
		return this.getSupportedCodecs()
			.filter(codec => (SUBTITLE_CODECS as readonly string[]).includes(codec)) as SubtitleCodec[];
	}

	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_codecUnsupportedHint(codec: MediaCodec) {
		return '';
	}

	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_trackTypeUnsupportedHint(trackType: TrackType) {
		return '';
	}

	/** @internal */
	_isFragmentedIsobmff() {
		return false;
	}

	/** @internal */
	_withoutXingHeader(): OutputFormat {
		return this;
	}
}

/**
 * ISOBMFF-specific output options.
 * @group Output formats
 * @public
 */
export type IsobmffOutputFormatOptions = {
	/**
	 * Controls the placement of metadata in the file. Placing metadata at the start of the file is known as "Fast
	 * Start", which results in better playback at the cost of more required processing or memory.
	 *
	 * Use `false` to disable Fast Start, placing the metadata at the end of the file. Fastest and uses the least
	 * memory.
	 *
	 * Use `'in-memory'` to produce a file with Fast Start by keeping all media chunks in memory until the file is
	 * finalized. This produces a high-quality and compact output at the cost of a more expensive finalization step and
	 * higher memory requirements. Data will be written monotonically (in order) when this option is set.
	 *
	 * Use `'reserve'` to reserve space at the start of the file into which the metadata will be written later.	This
	 * produces a file with Fast Start but requires knowledge about the expected length of the file beforehand. When
	 * using this option, you must set the {@link BaseTrackMetadata.maximumPacketCount} field in the track metadata
	 * for all tracks. {@link Conversion} estimates this count automatically if no override is provided.
	 *
	 * Use `'fragmented'` to place metadata at the start of the file by creating a fragmented file (fMP4). In a
	 * fragmented file, chunks of media and their metadata are written to the file in "fragments", eliminating the need
	 * to put all metadata in one place. Fragmented files are useful for streaming contexts, as each fragment can be
	 * played individually without requiring knowledge of the other fragments. Furthermore, they remain lightweight to
	 * create even for very large files, as they don't require all media to be kept in memory. However, fragmented files
	 * are not as widely and wholly supported as regular MP4/MOV files. Data will be written monotonically (in order)
	 * when this option is set.
	 *
	 * When this field is not defined, either `false` or `'in-memory'` will be used, automatically determined based on
	 * the type of output target used.
	 */
	fastStart?: false | 'in-memory' | 'reserve' | 'fragmented';

	/**
	 * When using `fastStart: 'fragmented'`, this field controls the minimum duration of each fragment, in seconds.
	 * New fragments will only be created when the current fragment is longer than this value. Defaults to 1 second.
	 */
	minimumFragmentDuration?: number;

	/**
	 * How many seconds of other tracks' media may pile up while a track that is still open supplies
	 * nothing, before its turn is given up and the rest is written with a gap in its place. Defaults to
	 * 10, matching FFmpeg's `max_interleave_delta`.
	 *
	 * Interleaving normally waits for every open track, which is correct when a track is merely behind
	 * and wrong when it has gone quiet: a live publisher whose audio stops would otherwise stop sending
	 * video too, and everything buffered would appear only on {@link Output.finalize}. `Infinity`
	 * restores that unbounded wait.
	 */
	maxInterleaveDelta?: number;

	/**
	 * Writes a Segment Index (`sidx`) covering every fragment in the file. This is what DASH's
	 * `<SegmentBase @indexRange>` points at, letting one on-demand MPD address the whole file without
	 * listing every subsegment.
	 *
	 * The muxer sizes the index itself: it reserves room after the `moov` box for
	 * {@link IsobmffOutputFormatOptions.sidxFragmentCapacity} fragments (8192 by default) and trims the
	 * unused room to a `free` box once the file is finalized. Muxing a file with more fragments than
	 * that throws rather than falling back to an unindexed layout.
	 *
	 * Only applies to `fastStart: 'fragmented'` outputs. A `sidx` records the distance to the
	 * subsegments it indexes as an unsigned value, so it can never be appended after the media — hence
	 * the reservation.
	 */
	segmentIndex?: boolean;

	/**
	 * The maximum number of fragments the index requested by
	 * {@link IsobmffOutputFormatOptions.segmentIndex} can hold, and implies that request when given.
	 * Unused room is filled with a `free` box, so over-estimating costs 12 bytes per unused fragment;
	 * muxing a file with more fragments than this throws.
	 *
	 * Leave it unset unless you want to trade file size against the fragment ceiling: lower it to
	 * shrink the reservation of a short file, raise it for a file with more than 8192 fragments.
	 */
	sidxFragmentCapacity?: number;

	/**
	 * The metadata format to use for writing metadata tags.
	 *
	 * - `'auto'` (default): Behaves like `'mdir'` for MP4 and like `'udta'` for QuickTime, matching FFmpeg's default
	 * behavior.
	 * - `'mdir'`: Write tags into `moov/udta/meta` using the 'mdir' handler format.
	 * - `'mdta'`: Write tags into `moov/udta/meta` using the 'mdta' handler format, equivalent to FFmpeg's
	 * `use_metadata_tags` flag. This allows for custom keys of arbitrary length.
	 * - `'udta'`: Write tags directly into `moov/udta`.
	 */
	metadataFormat?: 'auto' | 'mdir' | 'mdta' | 'udta';

	/**
	 * Will be called once the ftyp (File Type) box of the output file has been written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onFtyp?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called once the moov (Movie) box of the output file has been written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onMoov?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called for each finalized mdat (Media Data) box of the output file. Usage of this callback is not
	 * recommended when not using `fastStart: 'fragmented'`, as there will be one monolithic mdat box which might
	 * require large amounts of memory.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onMdat?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called for each finalized moof (Movie Fragment) box of the output file.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 * @param timestamp - The start timestamp of the fragment in seconds.
	 */
	onMoof?: (data: Uint8Array, position: number, timestamp: number) => unknown;
};

/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @group Output formats
 * @public
 */
export abstract class IsobmffOutputFormat extends OutputFormat {
	/** @internal */
	_options: IsobmffOutputFormatOptions;

	/** Internal constructor. */
	constructor(options: IsobmffOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.fastStart !== undefined
			&& ![false, 'in-memory', 'reserve', 'fragmented'].includes(options.fastStart)
		) {
			throw new TypeError(
				'options.fastStart, when provided, must be false, \'in-memory\', \'reserve\', or \'fragmented\'.',
			);
		}
		if (
			options.minimumFragmentDuration !== undefined
			&& (!isNumber(options.minimumFragmentDuration) || options.minimumFragmentDuration < 0)
		) {
			throw new TypeError('options.minimumFragmentDuration, when provided, must be a non-negative number.');
		}
		if (options.segmentIndex !== undefined && typeof options.segmentIndex !== 'boolean') {
			throw new TypeError('options.segmentIndex, when provided, must be a boolean.');
		}
		if (options.onFtyp !== undefined && typeof options.onFtyp !== 'function') {
			throw new TypeError('options.onFtyp, when provided, must be a function.');
		}
		if (options.onMoov !== undefined && typeof options.onMoov !== 'function') {
			throw new TypeError('options.onMoov, when provided, must be a function.');
		}
		if (options.onMdat !== undefined && typeof options.onMdat !== 'function') {
			throw new TypeError('options.onMdat, when provided, must be a function.');
		}
		if (options.onMoof !== undefined && typeof options.onMoof !== 'function') {
			throw new TypeError('options.onMoof, when provided, must be a function.');
		}
		if (
			options.metadataFormat !== undefined
			&& !['mdir', 'mdta', 'udta', 'auto'].includes(options.metadataFormat)
		) {
			throw new TypeError(
				'options.metadataFormat, when provided, must be either \'auto\', \'mdir\', \'mdta\', or \'udta\'.',
			);
		}

		super();

		this._options = options;
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const max = 2 ** 32 - 1; // Have fun reaching this one

		return {
			video: { min: 0, max },
			audio: { min: 0, max },
			subtitle: { min: 0, max },
			total: { min: 0, max },
		};
	}

	get supportsVideoTransformationMetadata() {
		return true;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	get negativeTimestampSupport() {
		return 'full' as const;
	}

	override get requiresMaximumPacketCount() {
		return this._options.fastStart === 'reserve';
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new IsobmffMuxer(output, this);
	}

	/** @internal */
	override _isFragmentedIsobmff(): boolean {
		return this._options.fastStart === 'fragmented';
	}
}

/**
 * MPEG-4 Part 14 (MP4) file format. Supports most codecs.
 * @group Output formats
 * @public
 */
export class Mp4OutputFormat extends IsobmffOutputFormat {
	/** Creates a new {@link Mp4OutputFormat} configured with the specified `options`. */
	constructor(options?: IsobmffOutputFormatOptions) {
		super(options);
	}

	/** @internal */
	get _name() {
		return 'MP4';
	}

	get fileExtension() {
		return '.mp4';
	}

	get mimeType() {
		return 'video/mp4';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...NON_PCM_AUDIO_CODECS,

			// These are supported via ISO/IEC 23003-5:
			'pcm-s16',
			'pcm-s16be',
			'pcm-s24',
			'pcm-s24be',
			'pcm-s32',
			'pcm-s32be',
			'pcm-f32',
			'pcm-f32be',
			'pcm-f64',
			'pcm-f64be',

			...SUBTITLE_CODECS,
		];
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (new MovOutputFormat().getSupportedCodecs().includes(codec)) {
			return ' Switching to MOV will grant support for this codec.';
		}

		return '';
	}
}

/**
 * CMAF-specific output options.
 * @group Output formats
 * @public
 */
export type CmafOutputFormatOptions = Omit<
	IsobmffOutputFormatOptions,
	'fastStart' | 'segmentIndex' | 'sidxFragmentCapacity'
> & {
	/**
	 * Controls the minimum duration of each fragment, in seconds. New fragments will only be created when the current
	 * fragment is longer than this value. Defaults to `Infinity`, meaning the file will contain only one fragment.
	 */
	minimumFragmentDuration?: number;
};

/**
 * Creates a single Common Media Application Format (CMAF) segment. An init segment will be written to the
 * {@link Target} specified in {@link OutputOptions.initTarget}. Supports most codecs.
 * @group Output formats
 * @public
 */
export class CmafOutputFormat extends IsobmffOutputFormat {
	/** Creates a new {@link CmafOutputFormat} configured with the specified `options`. */
	constructor(options?: CmafOutputFormatOptions) {
		super(options);
	}

	/** @internal */
	get _name() {
		return 'CMAF';
	}

	get fileExtension() {
		return '.m4s';
	}

	get mimeType() {
		return 'video/mp4';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...NON_PCM_AUDIO_CODECS,

			// These are supported via ISO/IEC 23003-5:
			'pcm-s16',
			'pcm-s16be',
			'pcm-s24',
			'pcm-s24be',
			'pcm-s32',
			'pcm-s32be',
			'pcm-f32',
			'pcm-f32be',
			'pcm-f64',
			'pcm-f64be',

			...SUBTITLE_CODECS,
		];
	}
}

/**
 * QuickTime File Format (QTFF), often called MOV. Supports all video and audio codecs, but not subtitle codecs.
 * @group Output formats
 * @public
 */
export class MovOutputFormat extends IsobmffOutputFormat {
	/** Creates a new {@link MovOutputFormat} configured with the specified `options`. */
	constructor(options?: IsobmffOutputFormatOptions) {
		super(options);
	}

	/** @internal */
	get _name() {
		return 'MOV';
	}

	get fileExtension() {
		return '.mov';
	}

	get mimeType() {
		return 'video/quicktime';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...AUDIO_CODECS,
		];
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (new Mp4OutputFormat().getSupportedCodecs().includes(codec)) {
			return ' Switching to MP4 will grant support for this codec.';
		}

		return '';
	}
}

/**
 * Matroska-specific output options.
 * @group Output formats
 * @public
 */
export type MkvOutputFormatOptions = {
	/**
	 * Configures the output to only append new data at the end, useful for live-streaming the file as it's being
	 * created. When enabled, some features such as storing duration and seeking will be disabled or impacted, so don't
	 * use this option when you want to write out a clean file for later use.
	 */
	appendOnly?: boolean;

	/**
	 * How many seconds of other tracks' media may pile up while a track that is still open supplies
	 * nothing, before its turn is given up and the rest is written with a gap in its place. Defaults to
	 * 10, matching FFmpeg's `max_interleave_delta`. `Infinity` restores an unbounded wait.
	 */
	maxInterleaveDelta?: number;

	/**
	 * This field controls the minimum duration of each Matroska cluster, in seconds. New clusters will only be created
	 * when the current cluster is longer than this value. Defaults to 1 second.
	 */
	minimumClusterDuration?: number;

	/**
	 * Will be called once the EBML header of the output file has been written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onEbmlHeader?: (data: Uint8Array, position: number) => void;

	/**
	 * Will be called once the header part of the Matroska Segment element has been written. The header data includes
	 * the Segment element and everything inside it, up to (but excluding) the first Matroska Cluster.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onSegmentHeader?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called for each finalized Matroska Cluster of the output file.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 * @param timestamp - The start timestamp of the cluster in seconds.
	 */
	onCluster?: (data: Uint8Array, position: number, timestamp: number) => unknown;
};

/**
 * Matroska file format.
 *
 * Supports writing transparent video. For a video track to be marked as transparent, the first packet added must
 * contain alpha side data.
 *
 * @group Output formats
 * @public
 */
export class MkvOutputFormat extends OutputFormat {
	/** @internal */
	_options: MkvOutputFormatOptions;

	/** Creates a new {@link MkvOutputFormat} configured with the specified `options`. */
	constructor(options: MkvOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.appendOnly !== undefined && typeof options.appendOnly !== 'boolean') {
			throw new TypeError('options.appendOnly, when provided, must be a boolean.');
		}
		if (
			options.minimumClusterDuration !== undefined
			&& (!isNumber(options.minimumClusterDuration) || options.minimumClusterDuration < 0)
		) {
			throw new TypeError('options.minimumClusterDuration, when provided, must be a non-negative number.');
		}
		if (options.onEbmlHeader !== undefined && typeof options.onEbmlHeader !== 'function') {
			throw new TypeError('options.onEbmlHeader, when provided, must be a function.');
		}
		if (options.onSegmentHeader !== undefined && typeof options.onSegmentHeader !== 'function') {
			throw new TypeError('options.onSegmentHeader, when provided, must be a function.');
		}
		if (options.onCluster !== undefined && typeof options.onCluster !== 'function') {
			throw new TypeError('options.onCluster, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new MatroskaMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'Matroska';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const max = 127;

		return {
			video: { min: 0, max },
			audio: { min: 0, max },
			subtitle: { min: 0, max },
			total: { min: 0, max },
		};
	}

	get fileExtension() {
		return '.mkv';
	}

	get mimeType() {
		return 'video/x-matroska';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...NON_PCM_AUDIO_CODECS,
			...PCM_AUDIO_CODECS.filter(codec => !['pcm-s8', 'pcm-f32be', 'pcm-f64be', 'ulaw', 'alaw'].includes(codec)),

			// Matroska defines no TTML codec ID
			'webvtt',
		];
	}

	get supportsVideoTransformationMetadata() {
		// While it technically does support it with Projection, many players appear to ignore that stuff
		return false;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	get negativeTimestampSupport() {
		return 'prefer-non-negative' as const;
	}
}

/**
 * WebM-specific output options.
 * @group Output formats
 * @public
 */
export type WebMOutputFormatOptions = MkvOutputFormatOptions;

/**
 * WebM file format, based on Matroska.
 *
 * Supports writing transparent video. For a video track to be marked as transparent, the first packet added must
 * contain alpha side data.
 *
 * @group Output formats
 * @public
 */
export class WebMOutputFormat extends MkvOutputFormat {
	/** Creates a new {@link WebMOutputFormat} configured with the specified `options`. */
	constructor(options?: MkvOutputFormatOptions) {
		super(options);
	}

	override getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS.filter(codec => ['vp8', 'vp9', 'av1'].includes(codec)),
			...AUDIO_CODECS.filter(codec => ['opus', 'vorbis'].includes(codec)),

			// Matroska defines no TTML codec ID
			'webvtt',
		];
	}

	/** @internal */
	override get _name() {
		return 'WebM';
	}

	override get fileExtension() {
		return '.webm';
	}

	override get mimeType() {
		return 'video/webm';
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (new MkvOutputFormat().getSupportedCodecs().includes(codec)) {
			return ' Switching to MKV will grant support for this codec.';
		}

		return '';
	}
}

/**
 * MP3-specific output options.
 * @group Output formats
 * @public
 */
export type Mp3OutputFormatOptions = {
	/**
	 * Controls whether the Xing header, which contains additional metadata as well as an index, is written to the start
	 * of the MP3 file. When disabled, the writing process becomes append-only. Defaults to `true`.
	 */
	xingHeader?: boolean;

	/**
	 * Will be called once the Xing metadata frame is finalized.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onXingFrame?: (data: Uint8Array, position: number) => unknown;
};

/**
 * MP3 file format.
 * @group Output formats
 * @public
 */
export class Mp3OutputFormat extends OutputFormat {
	/** @internal */
	_options: Mp3OutputFormatOptions;

	/** Creates a new {@link Mp3OutputFormat} configured with the specified `options`. */
	constructor(options: Mp3OutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.xingHeader !== undefined && typeof options.xingHeader !== 'boolean') {
			throw new TypeError('options.xingHeader, when provided, must be a boolean.');
		}
		if (options.onXingFrame !== undefined && typeof options.onXingFrame !== 'function') {
			throw new TypeError('options.onXingFrame, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new Mp3Muxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'MP3';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.mp3';
	}

	get mimeType() {
		return 'audio/mpeg';
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['mp3'];
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}

	get negativeTimestampSupport() {
		return null;
	}

	/** @internal */
	override _withoutXingHeader() {
		return new Mp3OutputFormat({
			...this._options,
			xingHeader: false,
		});
	}
}

/**
 * WAVE-specific output options.
 * @group Output formats
 * @public
 */
export type WavOutputFormatOptions = {
	/**
	 * Configures the output to only append new data at the end, useful for live-streaming the file as it's being
	 * created. When enabled, the header won't state the file's actual size.
	 */
	appendOnly?: boolean;

	/**
	 * When enabled, an RF64 file will be written, allowing for file sizes to exceed 4 GiB, which is otherwise not
	 * possible for regular WAVE files.
	 */
	large?: boolean;

	/**
	 * The metadata format to use for writing metadata tags.
	 *
	 * - `'info'` (default): Writes metadata into a RIFF INFO LIST chunk, the default way to contain metadata tags
	 * within WAVE. Only allows for a limited subset of tags to be written.
	 * - `'id3'`: Writes metadata into an ID3 chunk. Non-default, but used by many taggers in practice. Allows for a
	 * much larger and richer set of tags to be written.
	 */
	metadataFormat?: 'info' | 'id3';

	/**
	 * Will be called once the file header is written. The header consists of the RIFF header, the format chunk,
	 * metadata chunks, and the start of the data chunk (with placeholder sizes).
	 */
	onHeader?: (data: Uint8Array, position: number) => unknown;
};

/**
 * WAVE file format, based on RIFF.
 * @group Output formats
 * @public
 */
export class WavOutputFormat extends OutputFormat {
	/** @internal */
	_options: WavOutputFormatOptions;

	/** Creates a new {@link WavOutputFormat} configured with the specified `options`. */
	constructor(options: WavOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.appendOnly !== undefined && typeof options.appendOnly !== 'boolean') {
			throw new TypeError('options.appendOnly, when provided, must be a boolean.');
		}
		if (options.large !== undefined && typeof options.large !== 'boolean') {
			throw new TypeError('options.large, when provided, must be a boolean.');
		}
		if (options.metadataFormat !== undefined && !['info', 'id3'].includes(options.metadataFormat)) {
			throw new TypeError('options.metadataFormat, when provided, must be either \'info\' or \'id3\'.');
		}
		if (options.onHeader !== undefined && typeof options.onHeader !== 'function') {
			throw new TypeError('options.onHeader, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new WaveMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'WAVE';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.wav';
	}

	get mimeType() {
		return 'audio/wav';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...PCM_AUDIO_CODECS.filter(codec =>
				['pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32', 'pcm-f64', 'pcm-u8', 'ulaw', 'alaw'].includes(codec),
			),
		];
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}

	get negativeTimestampSupport() {
		return null;
	}
}

/**
 * Ogg-specific output options.
 * @group Output formats
 * @public
 */
export type OggOutputFormatOptions = {
	/**
	 * How many seconds of other tracks' media may pile up while a track that is still open supplies
	 * nothing, before its turn is given up and the rest is written with a gap in its place. Defaults to
	 * 10, matching FFmpeg's `max_interleave_delta`. `Infinity` restores an unbounded wait.
	 */
	maxInterleaveDelta?: number;

	/**
	 * The maximum duration of each Ogg page, in seconds. This is useful for streaming contexts where more frequent page
	 * output is desired. By default, pages are only flushed when they exceed a certain size.
	 */
	maximumPageDuration?: number;

	/**
	 * Will be called for each Ogg page that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 * @param source - The {@link MediaSource} backing the page's logical bitstream (track).
	 */
	onPage?: (data: Uint8Array, position: number, source: MediaSource) => unknown;
};

/**
 * Ogg file format.
 * @group Output formats
 * @public
 */
export class OggOutputFormat extends OutputFormat {
	/** @internal */
	_options: OggOutputFormatOptions;

	/** Creates a new {@link OggOutputFormat} configured with the specified `options`. */
	constructor(options: OggOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.maximumPageDuration !== undefined
			&& (!isNumber(options.maximumPageDuration) || options.maximumPageDuration <= 0)
		) {
			throw new TypeError('options.maximumPageDuration, when provided, must be a positive number.');
		}
		if (
			options.maxInterleaveDelta !== undefined
			&& !(options.maxInterleaveDelta > 0)
		) {
			throw new TypeError('options.maxInterleaveDelta, when provided, must be a positive number.');
		}
		if (options.onPage !== undefined && typeof options.onPage !== 'function') {
			throw new TypeError('options.onPage, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new OggMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'Ogg';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const max = 2 ** 32; // Have fun reaching this one

		return {
			video: { min: 0, max: 0 },
			audio: { min: 0, max },
			subtitle: { min: 0, max: 0 },
			total: { min: 0, max },
		};
	}

	get fileExtension() {
		return '.ogg';
	}

	get mimeType() {
		return 'application/ogg';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...AUDIO_CODECS.filter(codec => ['vorbis', 'opus'].includes(codec)),
		];
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	get negativeTimestampSupport() {
		return 'prefer-non-negative' as const;
	}
}

/**
 * ADTS-specific output options.
 * @group Output formats
 * @public
 */
export type AdtsOutputFormatOptions = {
	/**
	 * Will be called for each ADTS frame that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onFrame?: (data: Uint8Array, position: number) => unknown;
};

/**
 * ADTS file format.
 * @group Output formats
 * @public
 */
export class AdtsOutputFormat extends OutputFormat {
	/** @internal */
	_options: AdtsOutputFormatOptions;

	/** Creates a new {@link AdtsOutputFormat} configured with the specified `options`. */
	constructor(options: AdtsOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.onFrame !== undefined && typeof options.onFrame !== 'function') {
			throw new TypeError('options.onFrame, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new AdtsMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'ADTS';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.aac';
	}

	get mimeType() {
		return 'audio/aac';
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['aac'];
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}

	get negativeTimestampSupport() {
		return null;
	}
}

/**
 * FLAC-specific output options.
 * @group Output formats
 * @public
 */
export type FlacOutputFormatOptions = {
	/**
	 * Configures the output to only append new data at the end, useful for live-streaming the file as it's being
	 * created. When enabled, the STREAMINFO block will not be finalized with accurate min/max block sizes, frame sizes,
	 * or total sample count, so don't use this option when you want to write out a clean file for later use.
	 */
	appendOnly?: boolean;

	/**
	 * Will be called for each FLAC frame that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onFrame?: (data: Uint8Array, position: number) => unknown;
};

/**
 * FLAC file format.
 * @group Output formats
 * @public
 */
export class FlacOutputFormat extends OutputFormat {
	/** @internal */
	_options: FlacOutputFormatOptions;

	/** Creates a new {@link FlacOutputFormat} configured with the specified `options`. */
	constructor(options: FlacOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.appendOnly !== undefined && typeof options.appendOnly !== 'boolean') {
			throw new TypeError('options.appendOnly, when provided, must be a boolean.');
		}
		if (options.onFrame !== undefined && typeof options.onFrame !== 'function') {
			throw new TypeError('options.onFrame, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new FlacMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'FLAC';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.flac';
	}

	get mimeType() {
		return 'audio/flac';
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['flac'];
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}

	get negativeTimestampSupport() {
		return null;
	}
}

/**
 * A private elementary stream an {@link MpegTsOutputFormat} output carries, declared so the PMT lists
 * it and {@link addPrivatePesPayload} can write into it.
 *
 * @group Output formats
 * @public
 */
export type MpegTsPrivateStreamDeclaration = {
	/** The PID its PES packets go on. */
	pid: number;
	/**
	 * The stream's descriptors, written into the PMT byte for byte — a `teletext_descriptor` (tag 0x56)
	 * for EN 300 472 teletext, a `subtitling_descriptor` (tag 0x59) for EN 300 743 DVB subtitles, or any
	 * other. Each is a whole descriptor, tag and length byte included, since what a receiver makes of
	 * the stream is decided here and nowhere else: stream type 0x06 says nothing on its own.
	 */
	descriptors: Uint8Array[];
	/** `stream_type`, defaulting to 0x06. */
	streamType?: number;
};

/**
 * MPEG-TS-specific output options.
 * @group Output formats
 * @public
 */
export type MpegTsOutputFormatOptions = {
	/**
	 * An offset in seconds that is added to all timestamps written to the file. It keeps timestamps that would
	 * otherwise be negative (caused by audio priming samples or B-frames) positive in the final file, since negative
	 * timestamps trip up some players. A recommended value is 10 seconds.
	 *
	 * Defaults to 0. When writing HLS, prefer {@link SegmentedOutputFormatOptions.mediaTimestampBase}
	 * instead — in this fork that option sits on the segmented format shared by HLS, DASH and CMAF.
	 */
	timestampOffset?: number;

	/**
	 * Declares an SCTE-35 cue stream on this PID, so the PMT lists it with stream type 0x86 and the
	 * `CUEI` registration descriptor. Write sections into it with `addScte35Section`.
	 *
	 * Only the signalling: the sections themselves are the caller's, since a splice is a decision this
	 * library has no part in.
	 */
	scte35Pid?: number;

	/**
	 * The `program_number` the PAT and PMT state, defaulting to 1. A multiplex carrying several
	 * programs numbers them, and a receiver tuned to one selects it by this.
	 */
	programNumber?: number;

	/**
	 * The `transport_stream_id` the PAT states, defaulting to 1. It identifies the multiplex itself
	 * rather than anything in it, and a receiver uses it together with the `original_network_id` to
	 * tell two multiplexes apart.
	 */
	transportStreamId?: number;

	/** The PID the PMT is carried on, defaulting to 0x1000 (4096). */
	pmtPid?: number;

	/**
	 * The PID the PCR is carried on, and which the PMT states as `PCR_PID`. Defaults to the first video
	 * track's PID, or the first track's where there is no video.
	 *
	 * A PID of no track gets its own PCR-only packets, which needs {@link
	 * MpegTsOutputFormatOptions.pcrInterval} to pace them; naming a track's PID puts the PCR in that
	 * track's adaptation fields, as broadcast practice does.
	 */
	pcrPid?: number;

	/**
	 * The PID of each track, in the order the tracks were added to the `Output` — so
	 * `[481, 482]` puts the first added track on 481 and the second on 482. Defaults to 0x0100 (256)
	 * upwards in the same order.
	 *
	 * It may be shorter than the track count, in which case the tracks it does not name keep their
	 * default PIDs. Every PID must be between 0x0010 and 0x1ffe and distinct from every other PID this
	 * output uses.
	 */
	trackPids?: readonly number[];

	/**
	 * Declares private elementary streams on their own PIDs, listed in every PAT/PMT repeat with the
	 * descriptors given here. Write whole PES payloads into them with `addPrivatePesPayload`; they
	 * interleave with the media by PTS.
	 *
	 * This is the pass-through for DVB teletext and DVB subtitles, whose payloads this library does not
	 * compose: the descriptors identify the stream and the payload bytes are the caller's.
	 */
	privateStreams?: MpegTsPrivateStreamDeclaration[];

	/**
	 * Declares a timed-metadata stream on this PID, carrying ID3 tags: the PMT lists it with
	 * `stream_type` 0x15 and the `metadata_descriptor` that names `ID3 ` as both the application and the
	 * metadata format, which is what Apple's timed metadata for HLS asks for and byte for byte what
	 * FFmpeg writes for a timed ID3 stream. Write tags into it with `addId3Metadata`.
	 *
	 * Sugar over {@link MpegTsOutputFormatOptions.privateStreams}: the same stream can be declared there
	 * with those descriptors by hand, and this states the common case once.
	 */
	timedMetadataPid?: number;

	/**
	 * Seconds between repeats of the PAT and PMT, defaulting to 0.1. A receiver that joins mid-stream -
	 * a multicast listener, a restarted SRT receiver, a relay switching inputs - can only find the
	 * program once it has seen both, so broadcast practice repeats them continuously and ETSI TR 101 290
	 * flags a gap over 0.5 s. Set it higher to spend fewer bytes on tables, or `Infinity` to write them
	 * only once at the start.
	 *
	 * Measured on the stream's own timeline, not wall clock, and a repeat is placed in front of a key
	 * frame when one falls near the period - a joining receiver starts at a key frame, so the tables are
	 * worth most immediately before it.
	 */
	tableRepeatInterval?: number;

	/**
	 * Seconds between repeats of the PAT alone, overriding
	 * {@link MpegTsOutputFormatOptions.tableRepeatInterval} for that table. `Infinity` writes it only
	 * once at the start.
	 *
	 * Seconds, like every other interval here, where MediaConvert's `patInterval` is milliseconds.
	 */
	patInterval?: number;

	/**
	 * Seconds between repeats of the PMT alone, overriding
	 * {@link MpegTsOutputFormatOptions.tableRepeatInterval} for that table. `Infinity` writes it only
	 * once at the start.
	 */
	pmtInterval?: number;

	/**
	 * Seconds between program clock references, defaulting to 0.04. 13818-1 2.7.2 allows at most 0.1,
	 * and a receiver's clock recovery is only as good as this spacing.
	 *
	 * The PCR normally rides in the adaptation field of a packet of the track on
	 * {@link MpegTsOutputFormatOptions.pcrPid}, so a track with frequent packets needs nothing extra.
	 * Where that track goes quiet, or where `pcrPid` names no track at all, PCR-only packets are
	 * written on that PID to keep this spacing.
	 */
	pcrInterval?: number;

	/**
	 * Describes the program in a DVB Service Description Table, which a receiver shows as the channel
	 * name. Written on PID 0x0011 as a `service_description_section` (table id 0x42) carrying a
	 * `service_descriptor`, and repeated at {@link MpegTsOutputFormatOptions.sdtInterval}. Omitted, no
	 * SDT is written and the output is unchanged.
	 *
	 * Names are encoded as DVB text: ASCII goes out as-is, and anything else is UTF-8 behind the 0x15
	 * selector byte (ETSI EN 300 468 Annex A).
	 */
	service?: {
		/** The service name, which is the channel name a receiver displays. */
		name: string;
		/** The provider name, which is the broadcaster. */
		provider: string;
		/** `service_type`, defaulting to 0x01 (digital television). 0x02 is radio, 0x19 is HD TV. */
		type?: number;
		/**
		 * `original_network_id`, defaulting to 1. ETSI allocates these, so a real delivery states the
		 * one it was given rather than the default.
		 */
		originalNetworkId?: number;
	};

	/** Seconds between repeats of the SDT, defaulting to 0.5, which is the maximum EN 300 468 allows. */
	sdtInterval?: number;

	/**
	 * Bits per second to write the transport stream at, making it constant bit rate. Null packets on PID
	 * 0x1fff fill whatever the media does not, and every PCR is then stamped from the byte position it
	 * sits at rather than from a packet's decode time — which is what makes the stream's own clock and
	 * its bit rate agree, as a cable, satellite or ASI path requires.
	 *
	 * Left unset, the stream is variable bit rate: packets are written as the media supplies them and
	 * the PCR comes from the decode timeline.
	 *
	 * Media that needs more than this is refused rather than written over rate, naming the time it ran
	 * out and the rate it would have needed. A burst is allowed to run up to half a second ahead, which
	 * is what lets a key frame through; a full T-STD buffer model (13818-1 Annex D) is **not** simulated,
	 * so a stream that passes here can still fail a conformance checker's buffer analysis.
	 */
	muxRate?: number;

	/**
	 * How many seconds of other tracks' media may pile up while a track that is still open supplies
	 * nothing, before its turn is given up and the rest is written with a gap in its place. Defaults to
	 * 10, matching FFmpeg's `max_interleave_delta`.
	 *
	 * Interleaving normally waits for every open track, which is correct when a track is merely behind
	 * and wrong when it has gone quiet: a live publisher whose audio stops — a muted microphone, an
	 * encoder that stops sending audio — would otherwise stop sending video too, and everything buffered
	 * would appear only on {@link Output.finalize}. `Infinity` restores that unbounded wait.
	 *
	 * It bounds one more wait of the same kind: a subtitle playlist holds a segment until a cue arrives
	 * at or after its end, which a captioner with nothing to say never supplies, so once the media
	 * segments have run this far past it the segment is written with the cues that did arrive.
	 */
	maxInterleaveDelta?: number;

	/**
	 * Will be called for each 188-byte Transport Stream packet that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onPacket?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Encrypt the output with Apple HLS SAMPLE-AES, as a `#EXT-X-KEY:METHOD=SAMPLE-AES` rendition
	 * requires. Elementary stream payloads are encrypted as they are muxed, and the PMT signals it;
	 * PES and ADTS headers stay clear, so the stream remains parseable without the key.
	 *
	 * Only H.264 video and AAC audio can be encrypted this way — Apple specifies no other
	 * combination — and anything else in the output is refused rather than written in the clear.
	 */
	sampleAesEncryption?: {
		/** The 16-byte AES-128 key. */
		key: Uint8Array;
		/** The 16-byte IV, constant across the segment. */
		iv: Uint8Array;
	};
};

/**
 * MPEG Transport Stream file format.
 * @group Output formats
 * @public
 */
export class MpegTsOutputFormat extends OutputFormat {
	/** @internal */
	_options: MpegTsOutputFormatOptions;

	/** Creates a new {@link MpegTsOutputFormat} configured with the specified `options`. */
	constructor(options: MpegTsOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.timestampOffset !== undefined
			&& (!Number.isFinite(options.timestampOffset) || options.timestampOffset < 0)
		) {
			throw new TypeError('options.timestampOffset, when provided, must be a non-negative number.');
		}
		if (
			options.scte35Pid !== undefined
			&& (!Number.isInteger(options.scte35Pid) || options.scte35Pid < 0x0010 || options.scte35Pid > 0x1ffe)
		) {
			// 0x0000-0x000f and 0x1fff are reserved by 13818-1
			throw new TypeError('options.scte35Pid, when provided, must be an integer between 0x0010 and 0x1ffe.');
		}
		for (const name of ['pmtPid', 'pcrPid', 'timedMetadataPid'] as const) {
			const value = options[name];
			if (value !== undefined && (!Number.isInteger(value) || value < 0x0010 || value > 0x1ffe)) {
				throw new TypeError(`options.${name}, when provided, must be an integer between 0x0010 and 0x1ffe.`);
			}
		}
		if (options.trackPids !== undefined) {
			if (!Array.isArray(options.trackPids)) {
				throw new TypeError('options.trackPids, when provided, must be an array of PIDs.');
			}
			for (const pid of options.trackPids as readonly unknown[]) {
				if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0x0010 || pid > 0x1ffe) {
					throw new TypeError('options.trackPids must hold integers between 0x0010 and 0x1ffe.');
				}
			}
			if (new Set(options.trackPids).size !== options.trackPids.length) {
				throw new TypeError('options.trackPids must not repeat a PID.');
			}
		}
		for (const name of ['programNumber', 'transportStreamId'] as const) {
			const value = options[name];
			// 0 is reserved for the network information table's program in the PAT
			if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 0xffff)) {
				throw new TypeError(`options.${name}, when provided, must be an integer between 1 and 65535.`);
			}
		}
		if (options.service !== undefined) {
			const service = options.service;
			if (!service || typeof service !== 'object') {
				throw new TypeError('options.service, when provided, must be an object.');
			}
			if (typeof service.name !== 'string' || service.name.length === 0) {
				throw new TypeError('options.service.name must be a non-empty string.');
			}
			if (typeof service.provider !== 'string' || service.provider.length === 0) {
				throw new TypeError('options.service.provider must be a non-empty string.');
			}
			if (
				service.type !== undefined
				&& (!Number.isInteger(service.type) || service.type < 0 || service.type > 0xff)
			) {
				throw new TypeError('options.service.type, when provided, must be an integer between 0 and 255.');
			}
			if (
				service.originalNetworkId !== undefined
				&& (!Number.isInteger(service.originalNetworkId)
					|| service.originalNetworkId < 0
					|| service.originalNetworkId > 0xffff)
			) {
				throw new TypeError(
					'options.service.originalNetworkId, when provided, must be an integer between 0 and 65535.',
				);
			}
		}
		if (
			options.muxRate !== undefined
			&& (!Number.isFinite(options.muxRate) || options.muxRate <= 0)
		) {
			throw new TypeError('options.muxRate, when provided, must be a positive, finite number.');
		}
		if (options.sdtInterval !== undefined && !(options.sdtInterval > 0)) {
			throw new TypeError('options.sdtInterval, when provided, must be a positive number.');
		}
		for (const name of ['patInterval', 'pmtInterval', 'pcrInterval'] as const) {
			const value = options[name];
			if (value !== undefined && !(value > 0)) {
				throw new TypeError(`options.${name}, when provided, must be a positive number.`);
			}
		}
		if (options.pcrInterval !== undefined && options.pcrInterval > 0.1) {
			throw new TypeError(
				'options.pcrInterval must be at most 0.1 seconds, which is the maximum 13818-1 2.7.2 allows.',
			);
		}
		if (
			options.tableRepeatInterval !== undefined
			&& !(options.tableRepeatInterval > 0)
		) {
			throw new TypeError('options.tableRepeatInterval, when provided, must be a positive number.');
		}
		if (options.privateStreams !== undefined) {
			if (!Array.isArray(options.privateStreams)) {
				throw new TypeError('options.privateStreams, when provided, must be an array.');
			}

			const seen = new Set<number>();
			for (const stream of options.privateStreams) {
				if (!stream || typeof stream !== 'object') {
					throw new TypeError('Each entry of options.privateStreams must be an object.');
				}
				if (!Number.isInteger(stream.pid) || stream.pid < 0x0010 || stream.pid > 0x1ffe) {
					throw new TypeError(
						'A private stream\'s pid must be an integer between 0x0010 and 0x1ffe.',
					);
				}
				if (stream.pid === options.scte35Pid || seen.has(stream.pid)) {
					throw new TypeError(`Private stream PID ${stream.pid} is declared more than once.`);
				}
				seen.add(stream.pid);
				if (
					stream.streamType !== undefined
					&& (!Number.isInteger(stream.streamType) || stream.streamType < 0 || stream.streamType > 0xff)
				) {
					throw new TypeError('A private stream\'s streamType, when provided, must be a byte.');
				}
				if (!Array.isArray(stream.descriptors)) {
					throw new TypeError('A private stream\'s descriptors must be an array of Uint8Array.');
				}

				let total = 0;
				for (const descriptor of stream.descriptors) {
					if (!(descriptor instanceof Uint8Array) || descriptor.byteLength < 2) {
						throw new TypeError(
							'Each private stream descriptor must be a Uint8Array of at least two bytes.',
						);
					}
					if (descriptor[1] !== descriptor.byteLength - 2) {
						throw new TypeError(
							'A private stream descriptor\'s length byte must equal its size minus two.',
						);
					}
					total += descriptor.byteLength;
				}
				if (total > 0x0fff) {
					throw new TypeError('A private stream\'s descriptors must fit in a 12-bit ES_info_length.');
				}
			}
		}
		if (
			options.maxInterleaveDelta !== undefined
			&& !(options.maxInterleaveDelta > 0)
		) {
			throw new TypeError('options.maxInterleaveDelta, when provided, must be a positive number.');
		}
		if (options.onPacket !== undefined && typeof options.onPacket !== 'function') {
			throw new TypeError('options.onPacket, when provided, must be a function.');
		}
		if (options.sampleAesEncryption !== undefined) {
			const { key, iv } = options.sampleAesEncryption;
			if (!(key instanceof Uint8Array) || key.byteLength !== 16) {
				throw new TypeError('options.sampleAesEncryption.key must be a 16-byte Uint8Array.');
			}
			if (!(iv instanceof Uint8Array) || iv.byteLength !== 16) {
				throw new TypeError('options.sampleAesEncryption.iv must be a 16-byte Uint8Array.');
			}
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new MpegTsMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'MPEG-TS';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const maxVideo = 16; // Stream IDs 0xE0-0xEF
		const maxAudio = 32;
		const maxTotal = maxVideo + maxAudio;

		return {
			video: { min: 0, max: maxVideo },
			audio: { min: 0, max: maxAudio },
			subtitle: { min: 0, max: 0 },
			total: { min: 0, max: maxTotal },
		};
	}

	get fileExtension() {
		return '.ts';
	}

	get mimeType() {
		return 'video/MP2T';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS.filter(codec => ['avc', 'hevc', 'mpeg2'].includes(codec)),
			...AUDIO_CODECS.filter(codec => ['aac', 'mp3', 'mp2', 'ac3', 'eac3', 'dts'].includes(codec)),
		];
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	get negativeTimestampSupport() {
		return 'prefer-non-negative' as const;
	}
}

/** @internal */
export class WebvttSegmentFormat extends OutputFormat {
	/** @internal */
	_createMuxer(output: Output): Muxer {
		return new WebvttMuxer(output);
	}

	/** @internal */
	get _name() {
		return 'WebVTT';
	}

	get fileExtension() {
		return WEBVTT_FILE_EXTENSION;
	}

	get mimeType() {
		return WEBVTT_MIME_TYPE;
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['webvtt'];
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 0, max: 0 },
			subtitle: { min: 1, max: 1 },
			total: { min: 1, max: 1 },
		};
	}

	get supportsVideoTransformationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	get negativeTimestampSupport() {
		return 'none' as const;
	}
}

/** @internal */
export const WEBVTT_SEGMENT_FORMAT = new WebvttSegmentFormat();

/**
 * Info about an HLS media playlist.
 * @group Output formats
 * @public
 */
export type HlsOutputPlaylistInfo = {
	/** The 1-based index of the media playlist in the master playlist. */
	n: number;
	/** The output tracks contained in this playlist. */
	tracks: OutputTrack[];
	/** The format of the media segments in this playlist. */
	segmentFormat: OutputFormat;
};

/**
 * One part of a media segment: a `moof`/`mdat` fragment, listed as a Low-Latency HLS partial segment or sent as a
 * Low-Latency DASH chunk.
 * @group Output formats
 * @public
 */
export type SegmentPart = {
	/** Offset of the part in bytes from the start of its segment. */
	offset: number;
	/** Size of the part in bytes. */
	size: number;
	/** Duration of the part in seconds. */
	duration: number;
	/** Whether the part begins on a key frame, so playback can start at it. */
	independent: boolean;
};

/**
 * Info about an HLS media segment.
 * @group Output formats
 * @public
 */
export type HlsOutputSegmentInfo = {
	/** The 1-based index of the segment in the containing media playlist. */
	n: number;
	/** If the segment is a single file, meaning it is a single segment file that covers the entire playlist. */
	isSingleFile: boolean;
	/** The format of the media segment. */
	format: OutputFormat;
	/** The media playlist to which this segment belongs. */
	playlist: HlsOutputPlaylistInfo;
	/**
	 * Whether this is the final segment of its playlist, which is exact per playlist: a single finalize can flush
	 * several segments, and each playlist resolves independently of the others.
	 *
	 * Resolved by the time {@link SegmentedOutputFormatOptions.onSegment} is called. It reads `false` in
	 * {@link SegmentedOutputFormatOptions.getSegmentPath}, which runs before the segment's media is written and so
	 * before the last one can be told apart.
	 */
	isLast: boolean;
	/**
	 * The segment's parts in order, whose bytes concatenate to the segment, when
	 * {@link SegmentedOutputFormatOptions.partDuration} applies to it. `null` otherwise, and until the segment has been
	 * written.
	 */
	parts: SegmentPart[] | null;
};

/**
 * Options shaping the media that a segmented output writes, shared by every manifest format that
 * describes it.
 *
 * @group Output formats
 * @public
 */
export type SegmentedOutputFormatOptions = {
	/**
	 * Specifies the file format of each media segment. Not all formats are supported by all players; prefer sticking
	 * to the most commonly used ones: {@link MpegTsOutputFormat}, {@link CmafOutputFormat}, {@link AdtsOutputFormat},
	 * and {@link Mp3OutputFormat}.
	 *
	 * When an array of formats is specified, for each playlist, the first format that can contain all of the playlist's
	 * tracks is chosen. This allows you to, for example, package audio into .aac files and video into .ts files.
	 */
	segmentFormat: OutputFormat | OutputFormat[];
	/**
	 * Specifies the target (max) duration in seconds for each media segment, defaulting to 2 seconds.
	 *
	 * Mediabunny will try not to emit media segments longer than the target duration, but it is forced to if key frames
	 * are provided with a longer period than the target duration. Therefore, make sure to encode a key frame at least
	 * every `targetDuration` seconds to guarantee segment length, controllable via
	 * {@link VideoEncodingConfig.keyFrameInterval}.
	 *
	 * Outside of live mode, this can be set to `Infinity` to give each playlist only a single segment.
	 */
	targetDuration?: number;
	/**
	 * Where the next segment should end, given where the current one starts. Return `null` to leave that
	 * segment to {@link SegmentedOutputFormatOptions.targetDuration}, which is also what omitting this does.
	 *
	 * The default cut is anchored to a playlist's own first packet, so two outputs fed the same media but
	 * started at different times disagree on where an audio segment ends - every audio packet is a key
	 * packet, so nothing else pins it. Stating the boundary puts that in the caller's hands: return
	 * `Math.floor(start / 2) * 2 + 2` for a 2-second grid measured from zero, which two encoders agree on
	 * whenever they started, or the time of a splice to cut there.
	 *
	 * A stated boundary opens the next segment at the first packet **at or after** it, where the default
	 * grid takes the nearest packet on either side. That difference is deliberate: a repeating grid would
	 * accumulate error by always rounding one way, while a stated boundary is an instruction, and a
	 * segment opening before a splice point carries media that belongs to the previous one.
	 */
	nextSegmentBoundary?: (currentSegmentStartTimestamp: number) => number | null;

	/**
	 * How many seconds of other tracks' media may pile up while a track that is still open supplies
	 * nothing, before a segment is cut without it. Defaults to 10, matching FFmpeg's
	 * `max_interleave_delta`. Only applies to a playlist holding more than one track; tracks in separate
	 * playlists never wait for each other. `Infinity` restores an unbounded wait.
	 */
	maxInterleaveDelta?: number;
	/**
	 * Splits each media segment into parts of about this many seconds, each its own `moof`/`mdat` fragment, for
	 * Low-Latency HLS partial segments and Low-Latency DASH chunks.
	 *
	 * A part is cut at the first video sample at or after each multiple of this duration from the segment's start, or
	 * at the first audio sample when the segment has no video, so parts run slightly longer than this duration and only
	 * a segment's first part is sure to begin on a key frame. Each segment's parts are reported in
	 * {@link HlsOutputSegmentInfo.parts}.
	 *
	 * Only applies to fragmented ISOBMFF segment formats, such as {@link CmafOutputFormat}; segments in other
	 * formats are written whole.
	 */
	partDuration?: number;
	/**
	 * Whether to bundle all media segments for a playlist into a single file. Individual segments are then extracted
	 * via range requests.
	 */
	singleFilePerPlaylist?: boolean;

	/**
	 * Whether paired tracks must be written as separate renditions rather than muxed together.
	 *
	 * By default, a lone video track paired with a lone audio track is collapsed into one variant stream carrying
	 * both, since that is the cheapest correct output. Set this to `true` to keep them apart: the video becomes its
	 * own variant and the audio an `#EXT-X-MEDIA` rendition group in HLS, and a separate `<AdaptationSet>` in DASH.
	 *
	 * Useful for exercising a player's audio track selection and switching, which a muxed rendition never exercises.
	 */
	separateRenditions?: boolean;
	/**
	 * If `true`, the muxer will be in "live mode", continuously emitting updated playlists as new segments are created.
	 * The master playlist will be emitted as soon as all playlists have been emitted at least once, and will continue
	 * to be emitted each time a segment is finalized to further refine the accuracy of the `BANDWIDTH` attribute.
	 *
	 * When `false` (the default), all playlists will only be emitted once, upon output finalization.
	 */
	live?: boolean;
	/**
	 * When in live mode, this controls the maximum number of segments contained in each playlist. Defaults to
	 * `Infinity`, meaning playlists continually grow in size.
	 */
	maxLiveSegmentCount?: number;
	/**
	 * The timestamp in seconds at which the media written into the segments starts. All media is shifted such that
	 * the first packet added to the output lands on this timestamp, no matter its original timestamp. A positive base
	 * keeps timestamps positive that would otherwise be negative (caused by audio priming samples, B-frames, or tracks
	 * starting slightly before the first packet). The timestamps in the playlists are not affected.
	 *
	 * Defaults to 10 seconds.
	 */
	mediaTimestampBase?: number;
	/**
	 * Returns the file path for a given media playlist. If the returned path is relative, it is relative to the root
	 * path.
	 *
	 * Defaults to `'playlist-{n}.m3u8'`, where `n` is the 1-based index of the media playlist in the master playlist.
	 */
	getPlaylistPath?: (info: HlsOutputPlaylistInfo) => MaybePromise<FilePath>;
	/**
	 * Returns the file path for a given media segment. If the returned path is relative, it is relative to the path
	 * of the containing playlist.
	 *
	 * Defaults to `'segment-{n}-{k}{ext}'`, where `n` is the 1-based index of the containing media playlist in the
	 * master playlist, `k` is the 1-based index of the segment in its playlist, and `ext` is the file extension of the
	 * segment format (including the leading dot).
	 *
	 * If {@link SegmentedOutputFormatOptions.singleFilePerPlaylist} is true, it defaults to
	 * `'segments-{n}{ext}'` instead.
	 */
	getSegmentPath?: (info: HlsOutputSegmentInfo) => MaybePromise<FilePath>;
	/**
	 * Returns the file path for a given media init segment. If the returned path is relative, it is relative to the
	 * path of the containing playlist.
	 *
	 * Only necessary for segment formats that require an init file, such as {@link CmafOutputFormat}.
	 *
	 * Defaults to `'init-{n}{ext}'`, where `n` is the 1-based index of the containing media playlist in the master
	 * playlist and `ext` is the file extension of the segment format (including the leading dot).
	 */
	getInitPath?: (info: HlsOutputPlaylistInfo) => MaybePromise<FilePath>;

	/**
	 * Called whenever a media segment has been fully written. In single-file mode, this function will only be called
	 * once when the playlist is finalized.
	 */
	onSegment?: (target: Target, info: HlsOutputSegmentInfo) => unknown;
	/**
	 * Called when a media playlist is initialized, before any segments have been written. In single-file mode, this
	 * function is never called.
	 */
	onInit?: (target: Target, info: HlsOutputPlaylistInfo) => unknown;
	/**
	 * Called when a media segment is removed from the start of a media playlist due to
	 * {@link SegmentedOutputFormatOptions.maxLiveSegmentCount}. Will not be called when
	 * {@link SegmentedOutputFormatOptions.singleFilePerPlaylist} is `true`.
	 */
	onSegmentPopped?: (path: string, info: HlsOutputSegmentInfo) => unknown;
};

/**
 * HLS-specific output options.
 * @group Output formats
 * @public
 */
export type HlsOutputFormatOptions = SegmentedOutputFormatOptions & {
	/**
	 * Anchors the playlist's `#EXT-X-PROGRAM-DATE-TIME` to a wall clock: each segment's tag states this
	 * date plus the segment's own timestamp. A player uses it to seek by time of day, to align two
	 * renditions, and to place an `#EXT-X-DATERANGE`, whose `START-DATE` is on the same clock.
	 *
	 * Omitted, the tag is written only where the tracks state {@link BaseTrackMetadata.isRelativeToUnixEpoch}
	 * — which requires the media's own timestamps to be epoch-relative, so a live stream would have to
	 * carry timestamps around 1.7e9 and lose the precision a 32-bit float has there. This option leaves
	 * the media timeline at zero and states the clock separately. `null` is the same as omitting it.
	 */
	programDateTime?: Date | null;

	/**
	 * How an SCTE-35 cue handed over with `addScte35Section` is marked in the media playlist. Defaults
	 * to `'none'`, which writes no marker and leaves the section in the transport stream alone.
	 *
	 * - `'daterange'` — `#EXT-X-DATERANGE` with `SCTE35-OUT` / `SCTE35-IN` carrying the section's own
	 *   bytes as hex (RFC 8216bis §4.4.5.1). Needs a wall clock, so
	 *   {@link HlsOutputFormatOptions.programDateTime} must be set or the tracks must state
	 *   `isRelativeToUnixEpoch`: `START-DATE` is on that clock.
	 * - `'elemental-scte35'` — `#EXT-OATCLS-SCTE35` with the section as base64, then
	 *   `#EXT-X-CUE-OUT`, `#EXT-X-CUE-OUT-CONT` and `#EXT-X-CUE-IN`. What Elemental writes, and what
	 *   most ad-insertion services read.
	 * - `'elemental'` — the same without `#EXT-OATCLS-SCTE35`, for a service that wants the cue tags
	 *   alone.
	 * - `'none'` — no marker.
	 *
	 * A cue that states neither direction nor duration — a `splice_null`, an encrypted section, a
	 * `time_signal` with no segmentation descriptor — gets a `DATERANGE` and no `CUE-OUT`: there is no
	 * break to open.
	 */
	adMarkers?: 'none' | 'daterange' | 'elemental-scte35' | 'elemental';

	/** Called whenever the master playlist is written. */
	onMaster?: (content: string) => unknown;
	/** Called whenever a media playlist is written. */
	onPlaylist?: (content: string, info: HlsOutputPlaylistInfo) => unknown;
	/**
	 * `PART-HOLD-BACK`: how far back from the live edge a player should start, in seconds. Only written by a live
	 * playlist that lists parts. Defaults to three times
	 * {@link SegmentedOutputFormatOptions.partDuration}, the minimum RFC 8216bis §4.4.3.8 allows.
	 */
	partHoldBack?: number;
	/**
	 * Whether to advertise `CAN-BLOCK-RELOAD=YES`. This states that the *server* delivering these playlists holds a
	 * request until the playlist advances (RFC 8216bis §6.2.5.2); writing the files does not provide that, so it
	 * defaults to `false` and should only be turned on by an origin that implements blocking reload.
	 */
	canBlockReload?: boolean;
	/**
	 * Whether to write an `#EXT-X-PRELOAD-HINT` naming the part that comes next. Like
	 * {@link HlsOutputFormatOptions.canBlockReload}, this names bytes that do not exist yet, which only a server
	 * holding the request can answer (RFC 8216bis §6.2.5.2); served as plain files the hint yields a 404, so it
	 * defaults to `false`.
	 */
	preloadHint?: boolean;
};

/**
 * HTTP Live Streaming (HLS) output format. HLS media is represented by a set of .m3u8 playlist files and media segment
 * files, meaning this format writes out multiple files, requiring the use of a _pathed Output_
 * ({@link OutputOptions.target} must be a {@link PathedTarget}).
 *
 * This output format creates the following files:
 * - A master playlist .m3u8 file, containing the list of available playlists. A master playlist is always emitted,
 * written to the root path.
 * - One .m3u8 file for each playlist, each containing a list of media segments.
 * - Many media segments, containing the actual media data.
 *
 * To emit media playlists that use the `#EXT-X-PROGRAM-DATE-TIME` tag to map segment timestamps to real-world time,
 * set {@link BaseTrackMetadata.isRelativeToUnixEpoch} to `true` for all tracks.
 *
 * @group Output formats
 * @public
 */
export class HlsOutputFormat extends OutputFormat {
	/** @internal */
	_options: HlsOutputFormatOptions;

	/** Creates a new {@link HlsOutputFormat} configured with the specified `options`. */
	constructor(options: HlsOutputFormatOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			!(options.segmentFormat instanceof OutputFormat)
			&& (
				!Array.isArray(options.segmentFormat)
				|| options.segmentFormat.length === 0
				|| !options.segmentFormat.every(format => format instanceof OutputFormat)
			)
		) {
			throw new TypeError(
				'options.segmentFormat must be an OutputFormat or a non-empty array of OutputFormat instances.',
			);
		}
		if (
			options.targetDuration !== undefined
			&& (!isNumber(options.targetDuration) || options.targetDuration <= 0)
		) {
			throw new TypeError('options.targetDuration, when provided, must be a positive number.');
		}
		if (options.nextSegmentBoundary !== undefined && typeof options.nextSegmentBoundary !== 'function') {
			throw new TypeError('options.nextSegmentBoundary, when provided, must be a function.');
		}
		if (
			options.partDuration !== undefined
			&& (!Number.isFinite(options.partDuration) || options.partDuration <= 0)
		) {
			throw new TypeError('options.partDuration, when provided, must be a positive finite number.');
		}
		if (options.singleFilePerPlaylist !== undefined && typeof options.singleFilePerPlaylist !== 'boolean') {
			throw new TypeError('options.singleFilePerPlaylist, when provided, must be a boolean.');
		}
		if (options.live !== undefined && typeof options.live !== 'boolean') {
			throw new TypeError('options.live, when provided, must be a boolean.');
		}
		if (options.live && options.targetDuration === Infinity) {
			// Live playlists state the target duration before any segment exists
			throw new TypeError('options.targetDuration must be finite in live mode.');
		}
		if (
			options.maxLiveSegmentCount !== undefined
			&& (!isNumber(options.maxLiveSegmentCount) || options.maxLiveSegmentCount < 1
				|| (Number.isFinite(options.maxLiveSegmentCount) && !Number.isInteger(options.maxLiveSegmentCount)))
		) {
			throw new TypeError('options.maxLiveSegmentCount, when provided, must be a positive integer or Infinity.');
		}
		if (options.mediaTimestampBase !== undefined && !Number.isFinite(options.mediaTimestampBase)) {
			throw new TypeError('options.mediaTimestampBase, when provided, must be a finite number.');
		}
		if (options.getPlaylistPath !== undefined && typeof options.getPlaylistPath !== 'function') {
			throw new TypeError('options.getPlaylistPath, when provided, must be a function.');
		}
		if (options.getSegmentPath !== undefined && typeof options.getSegmentPath !== 'function') {
			throw new TypeError('options.getSegmentPath, when provided, must be a function.');
		}
		if (options.getInitPath !== undefined && typeof options.getInitPath !== 'function') {
			throw new TypeError('options.getInitPath, when provided, must be a function.');
		}
		if (
			options.adMarkers !== undefined
			&& !['none', 'daterange', 'elemental-scte35', 'elemental'].includes(options.adMarkers)
		) {
			throw new TypeError(
				'options.adMarkers, when provided, must be \'none\', \'daterange\', \'elemental-scte35\''
				+ ' or \'elemental\'.',
			);
		}
		if (
			options.programDateTime !== undefined
			&& options.programDateTime !== null
			&& (!(options.programDateTime instanceof Date) || Number.isNaN(options.programDateTime.getTime()))
		) {
			throw new TypeError('options.programDateTime, when provided, must be a valid Date or null.');
		}
		if (options.onMaster !== undefined && typeof options.onMaster !== 'function') {
			throw new TypeError('options.onMaster, when provided, must be a function.');
		}
		if (options.onPlaylist !== undefined && typeof options.onPlaylist !== 'function') {
			throw new TypeError('options.onPlaylist, when provided, must be a function.');
		}
		if (options.onSegment !== undefined && typeof options.onSegment !== 'function') {
			throw new TypeError('options.onSegment, when provided, must be a function.');
		}
		if (options.onInit !== undefined && typeof options.onInit !== 'function') {
			throw new TypeError('options.onInit, when provided, must be a function.');
		}
		if (options.onSegmentPopped !== undefined && typeof options.onSegmentPopped !== 'function') {
			throw new TypeError('options.onSegmentPopped, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output): Muxer {
		return new SegmentPipelineMuxer(output, this._options, muxer => [
			new HlsManifestEmitter(muxer, this._options),
		]);
	}

	/** @internal */
	get _name() {
		return 'HTTP Live Streaming (HLS)';
	}

	get fileExtension() {
		return '.m3u8';
	}

	get mimeType() {
		return HLS_MIME_TYPE;
	}

	getSupportedCodecs(): MediaCodec[] {
		const uniqueCodecs = new Set(toArray(this._options.segmentFormat).flatMap(x => x.getSupportedCodecs()));
		for (const codec of AUDIO_CODECS_WITH_DELTA_PACKETS) {
			uniqueCodecs.delete(codec); // Only key-packet-only audio codecs are allowed
		}
		if (this._options.singleFilePerPlaylist) {
			uniqueCodecs.delete('webvtt');
		} else {
			// WebVTT rides in its own .vtt segments, independent of the configured segment formats.
			uniqueCodecs.add('webvtt');
		}

		return [...uniqueCodecs];
	}

	getSupportedTrackCounts(): TrackCountLimits {
		let supportsVideo = false;
		let supportsAudio = false;

		for (const format of toArray(this._options.segmentFormat)) {
			const trackCounts = format.getSupportedTrackCounts();
			supportsVideo ||= trackCounts.video.max > 0;
			supportsAudio ||= trackCounts.audio.max > 0;
		}

		return {
			video: { min: 0, max: supportsVideo ? Infinity : 0 },
			audio: { min: 0, max: supportsAudio ? Infinity : 0 },
			subtitle: { min: 0, max: Infinity },
			total: { min: 0, max: Infinity },
		};
	}

	get supportsVideoTransformationMetadata(): boolean {
		return toArray(this._options.segmentFormat).some(format => format.supportsVideoTransformationMetadata);
	}

	get supportsTimestampedMediaData(): boolean {
		return true; // It's only half true, really, but "false" is not correct either
	}

	get negativeTimestampSupport() {
		const formats = toArray(this._options.segmentFormat);

		// Return the lowest baseline across all segment formats
		if (formats.some(format => format.negativeTimestampSupport === 'none')) {
			return 'none' as const;
		}
		if (formats.some(format => format.negativeTimestampSupport === 'prefer-non-negative')) {
			return 'prefer-non-negative' as const;
		}
		if (formats.some(format => format.negativeTimestampSupport === 'full')) {
			return 'full' as const;
		}

		return null;
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec): string {
		if ((AUDIO_CODECS_WITH_DELTA_PACKETS as readonly MediaCodec[]).includes(codec)) {
			return '';
		}

		if (codec === 'webvtt' && this._options.singleFilePerPlaylist) {
			return ' WebVTT segments are raw text and cannot be addressed via byte ranges, unlike the'
				+ ' fragmented MP4 that carries \'ttml\' subtitle tracks. Use \'ttml\', or disable'
				+ ' `singleFilePerPlaylist`.';
		}

		return ` Using different segment formats may grant support for this codec.`;
	}
}

export class NullOutputFormat extends OutputFormat {
	_createMuxer(output: Output) {
		return new NullMuxer(output);
	}

	get _name() {
		return 'Null';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: Infinity },
			audio: { min: 0, max: Infinity },
			subtitle: { min: 0, max: Infinity },
			total: { min: 0, max: Infinity },
		};
	}

	get fileExtension() {
		return '';
	}

	get mimeType() {
		return 'application/x-black-hole';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...AUDIO_CODECS,
			...SUBTITLE_CODECS,
		];
	}

	get supportsVideoTransformationMetadata() {
		return true;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	get negativeTimestampSupport() {
		return 'full' as const;
	}
}

/**
 * Options for {@link DashOutputFormat}. Same segment-pipeline surface as
 * {@link HlsOutputFormatOptions} (minus HLS-only `onMaster` / `onPlaylist`)
 * plus DASH-specific manifest fields.
 *
 * @group Output formats
 * @public
 */
export type DashOutputFormatOptions = SegmentedOutputFormatOptions & {
	/** Path of the rendered MPD relative to the {@link PathedTarget}'s root. */
	mpdPath: string;
	/** `<SegmentTemplate@media>` value with `$Number$` placeholder, relative to the playlist directory. */
	segmentTemplate?: string;
	/** `<SegmentTemplate@initialization>` filename, relative to the playlist directory. */
	initSegmentName?: string;
	/** DASH profile. Defaults to `'live'` (segments addressed by `SegmentTemplate`). */
	dashProfile?: DashProfile;
	/** MPD presentation type. `'static'` for VOD (default), `'dynamic'` for live. */
	mpdType?: MpdType;
	/** Override individual {@link MpdParams} fields; merged onto shaka defaults. */
	mpdParams?: Partial<MpdParams>;
	/** Called once with the MPD text after every track has been finalised. */
	onMpd?: (content: string) => unknown;
};

/**
 * Fields that describe the media rather than one manifest of it, so composed formats must state
 * the same value for each. The per-format callbacks are deliberately absent: every format
 * registers its own.
 */
const MUTUALLY_AGREED_FIELDS = [
	'segmentFormat', 'targetDuration', 'partDuration', 'singleFilePerPlaylist', 'live',
	'maxLiveSegmentCount', 'getPlaylistPath', 'getSegmentPath', 'getInitPath',
	'separateRenditions',
] as const satisfies readonly (keyof SegmentedOutputFormatOptions)[];

const lowestNegativeTimestampSupport = (formats: OutputFormat[]) => {
	if (formats.some(format => format.negativeTimestampSupport === 'none')) {
		return 'none' as const;
	}
	if (formats.some(format => format.negativeTimestampSupport === 'prefer-non-negative')) {
		return 'prefer-non-negative' as const;
	}
	if (formats.some(format => format.negativeTimestampSupport === 'full')) {
		return 'full' as const;
	}

	return null;
};

/**
 * MPEG-DASH output format.
 *
 * @group Output formats
 * @public
 */
export class DashOutputFormat extends OutputFormat {
	/** @internal */
	_options: DashOutputFormatOptions;

	/** Creates a new {@link DashOutputFormat} configured with the specified `options`. */
	constructor(options: DashOutputFormatOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (typeof options.mpdPath !== 'string' || options.mpdPath.length === 0) {
			throw new TypeError('options.mpdPath must be a non-empty string.');
		}
		if (options.onMpd !== undefined && typeof options.onMpd !== 'function') {
			throw new TypeError('options.onMpd, when provided, must be a function.');
		}
		// Single-file DASH addresses the init by byte range, so the segment format must write one separately:
		// CMAF or fragmented MP4. `_isFragmentedIsobmff()` is not the test, as CMAF reads false for it.
		if (options.singleFilePerPlaylist) {
			const unsupported = toArray(options.segmentFormat).find(
				format => !(format instanceof CmafOutputFormat) && !format._isFragmentedIsobmff(),
			);
			if (unsupported) {
				throw new TypeError(
					`options.singleFilePerPlaylist is not supported with ${unsupported._name} segments:`
					+ ` single-file DASH addresses each representation's initialization by byte range, which`
					+ ` only CMAF or fragmented-MP4 segments write.`,
				);
			}
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output): Muxer {
		return new SegmentPipelineMuxer(output, this._options, muxer => [
			new DashManifestEmitter(muxer, this._options),
		]);
	}

	/** @internal */
	get _name() {
		return 'MPEG-DASH';
	}

	get fileExtension() {
		return '.mpd';
	}

	get mimeType() {
		return 'application/dash+xml';
	}

	getSupportedCodecs(): MediaCodec[] {
		const uniqueCodecs = new Set(toArray(this._options.segmentFormat).flatMap(x => x.getSupportedCodecs()));

		if (this._options.singleFilePerPlaylist) {
			uniqueCodecs.delete('webvtt');
		} else {
			uniqueCodecs.add('webvtt');
		}

		return [...uniqueCodecs];
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (codec === 'webvtt' && this._options.singleFilePerPlaylist) {
			return ' WebVTT segments are raw text and cannot be addressed via byte ranges, unlike the'
				+ ' fragmented MP4 that carries \'ttml\' subtitle tracks. Use \'ttml\', or disable'
				+ ' `singleFilePerPlaylist`.';
		}

		return '';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		let supportsVideo = false;
		let supportsAudio = false;
		for (const format of toArray(this._options.segmentFormat)) {
			const trackCounts = format.getSupportedTrackCounts();
			supportsVideo ||= trackCounts.video.max > 0;
			supportsAudio ||= trackCounts.audio.max > 0;
		}
		return {
			video: { min: 0, max: supportsVideo ? Infinity : 0 },
			audio: { min: 0, max: supportsAudio ? Infinity : 0 },
			subtitle: { min: 0, max: Infinity },
			total: { min: 1, max: Infinity },
		};
	}

	get supportsVideoTransformationMetadata(): boolean {
		return toArray(this._options.segmentFormat).some(format => format.supportsVideoTransformationMetadata);
	}

	get supportsTimestampedMediaData(): boolean {
		return toArray(this._options.segmentFormat).some(format => format.supportsTimestampedMediaData);
	}

	get negativeTimestampSupport() {
		return lowestNegativeTimestampSupport(toArray(this._options.segmentFormat));
	}
}

/**
 * Options for {@link AdaptiveOutputFormat}.
 *
 * @group Output formats
 * @public
 */
export type AdaptiveOutputFormatOptions = {
	/** One {@link HlsOutputFormat} plus zero or more {@link DashOutputFormat}s, sharing the same segment pipeline. */
	formats: (HlsOutputFormat | DashOutputFormat)[];
};

/**
 * Adaptive output format — one encoder pass, multiple manifests pointing at
 * the same CMAF segments.
 *
 * @group Output formats
 * @public
 */
export class AdaptiveOutputFormat extends OutputFormat {
	/** @internal */
	_options: AdaptiveOutputFormatOptions;
	/** @internal */
	_hlsFormat: HlsOutputFormat;
	/** @internal */
	_dashFormats: DashOutputFormat[];

	/** Creates a new {@link AdaptiveOutputFormat} configured with the specified `options`. */
	constructor(options: AdaptiveOutputFormatOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Array.isArray(options.formats) || options.formats.length === 0) {
			throw new TypeError('options.formats must be a non-empty array.');
		}

		const hlsFormats = options.formats.filter(
			(f): f is HlsOutputFormat => f instanceof HlsOutputFormat,
		);
		const dashFormats = options.formats.filter(
			(f): f is DashOutputFormat => f instanceof DashOutputFormat,
		);
		if (hlsFormats.length !== 1) {
			throw new TypeError(
				'options.formats must contain exactly one HlsOutputFormat instance '
				+ '(the underlying muxer uses the HLS master playlist as its root file).',
			);
		}
		if (hlsFormats.length + dashFormats.length !== options.formats.length) {
			throw new TypeError(
				'options.formats may currently only contain HlsOutputFormat or DashOutputFormat instances.',
			);
		}

		const hlsFormat = hlsFormats[0]!;
		for (const dash of dashFormats) {
			for (const field of MUTUALLY_AGREED_FIELDS) {
				if (hlsFormat._options[field] !== dash._options[field]) {
					throw new TypeError(
						`options.formats: composed formats must agree on '${field}' — `
						+ 'pass the same value (or instance) to every format.',
					);
				}
			}
		}

		super();

		this._options = options;
		this._hlsFormat = hlsFormat;
		this._dashFormats = dashFormats;
	}

	/** @internal */
	_createMuxer(output: Output): Muxer {
		return new SegmentPipelineMuxer(output, this._hlsFormat._options, muxer => [
			new HlsManifestEmitter(muxer, this._hlsFormat._options),
			...this._dashFormats.map(dash => new DashManifestEmitter(
				muxer,
				dash._options,
			)),
		]);
	}

	/** @internal */
	get _name() {
		return 'Adaptive Streaming (HLS + DASH)';
	}

	get fileExtension() {
		return '.m3u8';
	}

	get mimeType() {
		return this._hlsFormat.mimeType;
	}

	getSupportedCodecs(): MediaCodec[] {
		return this._hlsFormat.getSupportedCodecs();
	}

	/** @internal */
	override _trackTypeUnsupportedHint(trackType: TrackType) {
		return this._hlsFormat._trackTypeUnsupportedHint(trackType);
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return this._hlsFormat.getSupportedTrackCounts();
	}

	get supportsVideoTransformationMetadata(): boolean {
		return this._hlsFormat.supportsVideoTransformationMetadata;
	}

	get supportsTimestampedMediaData(): boolean {
		return this._hlsFormat.supportsTimestampedMediaData;
	}

	get negativeTimestampSupport() {
		return this._hlsFormat.negativeTimestampSupport;
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec): string {
		return this._hlsFormat._codecUnsupportedHint(codec);
	}
}
