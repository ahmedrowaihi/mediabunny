/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AppendOnlyStreamTarget } from 'mediabunny';
import { Demuxer, Muxer } from 'node-av/api';
import {
	AVMEDIA_TYPE_AUDIO,
	AVMEDIA_TYPE_VIDEO,
	AV_CODEC_ID_PCM_ALAW,
	AV_CODEC_ID_PCM_F32BE,
	AV_CODEC_ID_PCM_F32LE,
	AV_CODEC_ID_PCM_F64BE,
	AV_CODEC_ID_PCM_F64LE,
	AV_CODEC_ID_PCM_MULAW,
	AV_CODEC_ID_PCM_S16BE,
	AV_CODEC_ID_PCM_S16LE,
	AV_CODEC_ID_PCM_S24BE,
	AV_CODEC_ID_PCM_S24LE,
	AV_CODEC_ID_PCM_S32BE,
	AV_CODEC_ID_PCM_S32LE,
	AV_CODEC_ID_PCM_S8,
	AV_CODEC_ID_PCM_U8,
} from 'node-av/constants';
import { Dictionary } from 'node-av';
import { Readable } from 'node:stream';

/**
 * Options for {@link MxfTarget}.
 *
 * @group \@mediabunny/server
 * @public
 */
export type MxfTargetOptions = {
	/**
	 * Start timecode as `hh:mm:ss:ff`, or `hh:mm:ss;ff` for drop frame, written as the file's timecode
	 * track. Broadcast delivery specifications generally require one; AS-11 does.
	 */
	startTimecode?: string;
	/**
	 * Signal standard to force, by name as FFmpeg's `mxf` muxer takes it — `smpte274m` for 1125-line
	 * HD, `smpte296m` for 750-line progressive. Left unset, the muxer infers one.
	 */
	signalStandard?: 'bt601' | 'bt1358' | 'smpte347m' | 'smpte274m' | 'smpte296m' | 'smpte349m' | 'smpte428';
	/** Whether to keep the muxer's user-comment metadata. Defaults to true, as FFmpeg's does. */
	storeUserComments?: boolean;
	/**
	 * Writes the same bytes on every run, by setting FFmpeg's `bitexact` flag.
	 *
	 * MXF is the one container here where identical input does not give an identical file: `mxfenc` draws
	 * the UMIDs at random, so two runs differ in those bytes while the essence repeats exactly. The flag
	 * also drops the encoder and library version strings, which is what makes the file comparable.
	 */
	bitexact?: boolean;
	/**
	 * The date written into the file's Preface and Identification sets. Defaults to the epoch, so two
	 * runs of the same job produce the same bytes; `bitexact` alone does not, because it does not reach
	 * these. Pass a `Date` for a real delivery date, or `null` for the wall clock.
	 */
	creationTime?: Date | null;
	/**
	 * Bits per second to state as the video descriptor's `BitRate`, in place of the rate carried over
	 * from the input. RDD 9 wants the rung's nominal rate there — 50000000 for XDCAM HD422 — where what
	 * arrives is the average measured over whatever was written, which only approaches the nominal rate
	 * over a long enough programme.
	 *
	 * Note that `ffprobe` reports `bit_rate=N/A` for an MXF video stream either way: FFmpeg's `mxf`
	 * demuxer does not read that field back, so the only way to see it is to read the descriptor.
	 */
	videoBitRate?: number;
};

const TIMECODE_PATTERN = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;

/**
 * The audio codecs MXF carries here. OP1a is frame-wrapped PCM; anything else fails inside the muxer
 * with a bare `Invalid argument` - measured, FFmpeg's own CLI fails the same way on AAC - so it is
 * refused with its name instead.
 */
const MXF_AUDIO_CODEC_IDS = new Set<number>([
	AV_CODEC_ID_PCM_S16LE, AV_CODEC_ID_PCM_S16BE,
	AV_CODEC_ID_PCM_S24LE, AV_CODEC_ID_PCM_S24BE,
	AV_CODEC_ID_PCM_S32LE, AV_CODEC_ID_PCM_S32BE,
	AV_CODEC_ID_PCM_F32LE, AV_CODEC_ID_PCM_F32BE,
	AV_CODEC_ID_PCM_F64LE, AV_CODEC_ID_PCM_F64BE,
	AV_CODEC_ID_PCM_S8, AV_CODEC_ID_PCM_U8,
	AV_CODEC_ID_PCM_MULAW, AV_CODEC_ID_PCM_ALAW,
]);

/**
 * Remuxes the fragmented MP4 the caller writes into MXF OP1a.
 *
 * **No bitstream filters here, and that is measured rather than assumed.** FFmpeg's CLI reports
 * inserting `h264_mp4toannexb` and `pcm_rechunk` for an `mp4` to `mxf` remux, so a first version of this
 * ran both by hand. Comparing the output byte for byte with and without them: the video essence is
 * Annex B either way (`00 00 00 01 06 05` as the first packet's bytes) and the audio packets are the
 * same size, because libavformat's `mxf` muxer inserts what it needs itself. The CLI's message describes
 * a CLI-level mechanism, not a gap in the library API.
 */
class MxfSink {
	readonly writable: WritableStream<Uint8Array>;

	/** What the caller writes into, and what ffmpeg's demuxer reads out of. */
	private readonly source: Readable;
	private pump: Promise<void> | null = null;
	private failure: Error | null = null;
	private closed = false;
	private drained: (() => void) | null = null;

	writtenPackets = 0;

	constructor(private readonly path: string, private readonly options: MxfTargetOptions) {
		this.source = new Readable({ read: () => this.wake() });

		this.writable = new WritableStream<Uint8Array>({
			write: chunk => this.write(chunk),
			close: () => this.finish(),
			abort: () => this.finish(),
		});
	}

	private wake() {
		const resolve = this.drained;
		this.drained = null;
		resolve?.();
	}

	private async write(chunk: Uint8Array) {
		const pending = this.failure;
		if (pending) {
			throw pending;
		}

		// Started on the first write, so constructing an MxfTarget opens no file
		this.pump ??= this.run().catch((error: unknown) => {
			this.failure ??= error instanceof Error ? error : new Error(String(error));
			this.source.destroy();
			this.wake();
		});

		if (!this.source.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
			await new Promise<void>((resolve) => {
				this.drained = resolve;
			});
		}

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}

	private async run() {
		const demuxer = await Demuxer.open(this.source, { format: 'mp4' });

		const muxerOptions: Record<string, string> = {};
		if (this.options.signalStandard !== undefined) {
			muxerOptions['signal_standard'] = this.options.signalStandard;
		}
		if (this.options.storeUserComments !== undefined) {
			muxerOptions['store_user_comments'] = this.options.storeUserComments ? '1' : '0';
		}
		if (this.options.bitexact) {
			// The format flag, not a codec one: it is the muxer's random UMIDs that make two runs differ
			muxerOptions['fflags'] = '+bitexact';
		}

		const startTimecode = this.options.startTimecode;
		// `bitexact` fixes the UMIDs but not these: mxfenc stamps the Preface's LastModifiedDate and every
		// Identification set's ModificationDate from the wall clock unless `creation_time` states one, so
		// two runs either side of a second differ. Measured, and the default is the epoch for that reason.
		const creationTime = this.options.creationTime === undefined ? new Date(0) : this.options.creationTime;
		const metadata: Record<string, string> = {};
		if (creationTime !== null) {
			metadata['creation_time'] = creationTime.toISOString();
		}
		if (startTimecode !== undefined) {
			metadata['timecode'] = startTimecode;
		}

		const muxer = await Muxer.open(this.path, {
			format: 'mxf',
			options: muxerOptions,
			// The muxer's own `mxf` AVOptions carry neither of these; FFmpeg's CLI writes them as format
			// metadata, which is what becomes the timecode track and the file's dates. `configure` is the
			// one hook that runs after the streams exist and before the header is written.
			configure: (context) => {
				context.metadata = Dictionary.fromObject(metadata);
			},
		});

		for (const stream of demuxer.streams) {
			if (
				stream.codecpar.codecType === AVMEDIA_TYPE_AUDIO
				&& !MXF_AUDIO_CODEC_IDS.has(stream.codecpar.codecId as number)
			) {
				throw new Error(
					'MxfTarget: MXF carries frame-wrapped PCM audio, and this output\'s audio track is'
					+ ` codec id ${String(stream.codecpar.codecId)}. Convert the audio, for example with`
					+ ' `audio: { codec: \'pcm-s24\' }`, and add one track per channel.',
				);
			}
		}

		const outputIndices = new Map<number, number>();
		for (const stream of demuxer.streams) {
			const index = muxer.addStream(stream);

			// MXF reads its edit rate off the video stream, and `addStream` copies the input's *average*
			// rate. Over a short or trimmed fragmented MP4 that average is a ratio like 300/13, which the
			// muxer refuses outright: `Unsupported frame rate 300/13`. ffmpeg's own CLI fails the same way
			// on the same file, so taking the base rate is the truth rather than a workaround.
			if (stream.codecpar.codecType === AVMEDIA_TYPE_VIDEO) {
				const output = muxer.getStream(index);
				if (output && stream.rFrameRate.num > 0) {
					output.avgFrameRate = stream.rFrameRate;
					output.rFrameRate = stream.rFrameRate;
				}

				// The muxer takes the descriptor's BitRate off the output stream, so this has to be the
				// output's rather than the input's
				if (output && this.options.videoBitRate !== undefined) {
					output.codecpar.bitRate = BigInt(Math.round(this.options.videoBitRate));
				}
			}

			outputIndices.set(stream.index, index);
		}

		try {
			for await (const packet of demuxer.packets()) {
				if (!packet) {
					continue;
				}

				const index = outputIndices.get(packet.streamIndex);
				if (index !== undefined) {
					await muxer.writePacket(packet, index);
					this.writtenPackets++;
				}
			}
		} finally {
			await muxer.close().catch(() => {});
			await demuxer.close().catch(() => {});
		}
	}

	private async finish() {
		if (this.closed) {
			return;
		}
		this.closed = true;

		this.source.push(null);
		this.wake();
		await this.pump?.catch(() => {});

		const failed = this.failure;
		if (failed) {
			throw failed;
		}
	}
}

/**
 * An {@link https://mediabunny.dev/guide/writing-media-files#target | output target} that writes **MXF
 * OP1a**, the operational pattern broadcast delivery specifications are written against — AS-11 (UK DPP)
 * among them.
 *
 * MXF is not muxed by this library. The target takes the **fragmented MP4** an `Output` writes and
 * remuxes it through FFmpeg's `mxf` muxer, so the file is OP1a by construction rather than by a
 * hand-written KLV layer. Use `new Mp4OutputFormat({ fastStart: 'fragmented' })`: a non-fragmented
 * format writes its `moov` only at the end and so cannot be read as it is produced.
 *
 * **Audio is one stream per channel.** Delivery specifications generally require discrete mono tracks
 * rather than an interleaved pair, so add an audio track per channel to the `Output`; each becomes its
 * own MXF track, frame-wrapped to the video's frame rate.
 *
 * Node only, and it writes to a path rather than a stream, because MXF's footer partition and index
 * tables need the file to be seekable.
 *
 * @example
 * ```ts
 * const output = new Output({
 * 	format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
 * 	target: new MxfTarget('/deliverables/programme.mxf', { startTimecode: '10:00:00:00' }),
 * });
 * ```
 *
 * @group \@mediabunny/server
 * @public
 */
export class MxfTarget extends AppendOnlyStreamTarget {
	/** @internal */
	private readonly sink: MxfSink;

	constructor(path: string, options: MxfTargetOptions = {}) {
		if (typeof path !== 'string' || path.length === 0) {
			throw new TypeError('path must be a non-empty string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.startTimecode !== undefined
			&& (typeof options.startTimecode !== 'string' || !TIMECODE_PATTERN.test(options.startTimecode))
		) {
			throw new TypeError(
				'options.startTimecode, when provided, must be \'hh:mm:ss:ff\', or \'hh:mm:ss;ff\' for drop frame.',
			);
		}
		if (options.storeUserComments !== undefined && typeof options.storeUserComments !== 'boolean') {
			throw new TypeError('options.storeUserComments, when provided, must be a boolean.');
		}
		if (
			options.creationTime !== undefined
			&& options.creationTime !== null
			&& !(options.creationTime instanceof Date)
		) {
			throw new TypeError('options.creationTime, when provided, must be a Date or null.');
		}
		if (options.bitexact !== undefined && typeof options.bitexact !== 'boolean') {
			throw new TypeError('options.bitexact, when provided, must be a boolean.');
		}
		if (
			options.videoBitRate !== undefined
			&& (!Number.isFinite(options.videoBitRate) || options.videoBitRate <= 0)
		) {
			throw new TypeError('options.videoBitRate, when provided, must be a positive number.');
		}

		const sink = new MxfSink(path, options);
		super(sink.writable);
		this.sink = sink;
	}

	/** Packets written to the MXF file so far, counted after frame-wrapping rather than before. */
	get writtenPackets(): number {
		return this.sink.writtenPackets;
	}
}
