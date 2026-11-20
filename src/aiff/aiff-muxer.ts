/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { parsePcmCodec, PcmAudioCodec, validateAudioChunkMetadata } from '../codec';
import { Writer } from '../writer';
import { EncodedPacket } from '../packet';
import { AiffOutputFormat } from '../output-format';
import { assert } from '../misc';
import { AiffWriter, writeExtendedFloat80 } from './aiff-misc';

/**
 * What a codec is called in an AIFF-C `COMM` chunk, and the human-readable name beside it. Plain AIFF
 * carries neither and is always big-endian two's complement.
 */
const COMPRESSION_NAMES: Partial<Record<PcmAudioCodec, [string, string]>> = {
	'pcm-s16': ['sowt', 'little endian'],
	'pcm-s24': ['sowt', 'little endian'],
	'pcm-s32': ['sowt', 'little endian'],
	'pcm-f32be': ['fl32', 'IEEE 32-bit float'],
	'pcm-f64be': ['fl64', 'IEEE 64-bit float'],
	'ulaw': ['ulaw', 'CCITT G.711 u-law'],
	'alaw': ['alaw', 'CCITT G.711 A-law'],
	'pcm-u8': ['raw ', 'unsigned 8-bit'],
};

export class AiffMuxer extends Muxer {
	private format: AiffOutputFormat;
	private writer!: Writer;
	private aiffWriter!: AiffWriter;
	private headerWritten = false;
	private dataSize = 0;
	private sampleRate: number | null = null;
	private blockSize = 1;

	private formSizePos: number | null = null;
	private frameCountPos: number | null = null;
	private ssndSizePos: number | null = null;

	constructor(output: Output, format: AiffOutputFormat) {
		super(output);

		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		try {
			this.writer = await this.output._getRootWriter(false);
			this.aiffWriter = new AiffWriter(this.writer);

			const track = this.output.tracks[0];
			assert(track?.isAudioTrack());

			if (track.metadata.decoderConfig) {
				validateAudioChunkMetadata({ decoderConfig: track.metadata.decoderConfig }, track.source._codec);

				this.writeHeader(track, track.metadata.decoderConfig);
				this.headerWritten = true;
			}
		} finally {
			release();
		}
	}

	async getMimeType() {
		return 'audio/aiff';
	}

	async addEncodedVideoPacket() {
		throw new Error('AIFF does not support video.');
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			if (!this.headerWritten) {
				validateAudioChunkMetadata(meta, track.source._codec);
				assert(meta);
				assert(meta.decoderConfig);

				this.writeHeader(track, meta.decoderConfig);
				this.headerWritten = true;
			}

			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');

			if (this.writer.getPos() + packet.data.byteLength >= 2 ** 32) {
				throw new Error(
					'Adding more audio data would exceed the maximum AIFF size of 4 GiB; its chunk sizes are'
					+ ' 32-bit and it has no 64-bit form.',
				);
			}

			this.writer.write(packet.data);
			this.dataSize += packet.data.byteLength;

			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addSubtitleCue() {
		throw new Error('AIFF does not support subtitles.');
	}

	private writeHeader(track: OutputAudioTrack, config: AudioDecoderConfig) {
		if (this.format._options.onHeader) {
			this.writer.startTrackingWrites();
		}

		const codec = track.source._codec as PcmAudioCodec;
		const pcmInfo = parsePcmCodec(codec);
		const compression = COMPRESSION_NAMES[codec];

		const channels = config.numberOfChannels;
		this.sampleRate = config.sampleRate;
		this.blockSize = pcmInfo.sampleSize * channels;

		// `NONE` is the only thing plain AIFF can mean, so anything else has to go in an AIFF-C
		const isAifc = compression !== undefined;

		this.aiffWriter.writeAscii('FORM');
		this.formSizePos = this.writer.getPos();
		this.aiffWriter.writeU32(0); // Placeholder
		this.aiffWriter.writeAscii(isAifc ? 'AIFC' : 'AIFF');

		if (isAifc) {
			// A reader is entitled to refuse an AIFF-C with no FVER, and ffmpeg's writes one
			this.aiffWriter.writeAscii('FVER');
			this.aiffWriter.writeU32(4);
			this.aiffWriter.writeU32(0xa2805140); // The 1991 version stamp, which is the only one
		}

		const commSize = isAifc ? 18 + 4 + 1 + compression[1].length + ((compression[1].length + 1) % 2) : 18;
		this.aiffWriter.writeAscii('COMM');
		this.aiffWriter.writeU32(commSize);
		this.aiffWriter.writeU16(channels);
		this.frameCountPos = this.writer.getPos();
		this.aiffWriter.writeU32(0); // numSampleFrames placeholder
		this.aiffWriter.writeU16(8 * pcmInfo.sampleSize);
		writeExtendedFloat80(this.writer, config.sampleRate);

		if (isAifc) {
			this.aiffWriter.writeAscii(compression[0]);
			this.aiffWriter.writePascalString(compression[1]);
		}

		this.aiffWriter.writeAscii('SSND');
		this.ssndSizePos = this.writer.getPos();
		this.aiffWriter.writeU32(0); // Placeholder
		this.aiffWriter.writeU32(0); // offset: the frames start right here
		this.aiffWriter.writeU32(0); // blockSize: nothing is aligned to anything

		if (this.format._options.onHeader) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onHeader(data, start);
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		try {
			if (!this.headerWritten) {
				throw new Error(
					'Cannot finalize an empty AIFF file: no packets were added and the track specified no'
					+ ' decoderConfig in its metadata, so there\'s no telling what the file should look like.',
				);
			}

			assert(this.formSizePos !== null);
			assert(this.frameCountPos !== null);
			assert(this.ssndSizePos !== null);

			const endPos = this.writer.getPos();
			// An odd-sized SSND is padded, and the pad octet counts towards FORM but not towards SSND
			const padded = this.dataSize % 2 === 1;
			if (padded) {
				this.writer.write(new Uint8Array(1));
			}

			this.writer.seek(this.formSizePos);
			this.aiffWriter.writeU32(endPos + (padded ? 1 : 0) - 8);

			this.writer.seek(this.frameCountPos);
			this.aiffWriter.writeU32(Math.floor(this.dataSize / this.blockSize));

			this.writer.seek(this.ssndSizePos);
			this.aiffWriter.writeU32(this.dataSize + 8);

			this.writer.seek(endPos + (padded ? 1 : 0));
			await this.writer.flush();
		} finally {
			release();
		}
	}
}
