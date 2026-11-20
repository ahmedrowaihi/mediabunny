/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	floorToMultiple,
	isThenable,
	roundIfAlmostInteger,
	strictTextDecoder,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readAscii, readBytes, Reader, readU16Be, readU32Be } from '../reader';
import { readExtendedFloat80 } from './aiff-misc';

/**
 * AIFF-C compression types. Plain AIFF has no such field and is always `NONE`.
 *
 * `sowt` ("twos" backwards, as in two's complement) is the little-endian one, and is what every Mac
 * tool writes today; `twos` is its big-endian opposite and means the same as `NONE`.
 */
const COMPRESSION_CODECS: Record<string, AudioCodec | 'pcm-be' | 'pcm-le'> = {
	'NONE': 'pcm-be',
	'twos': 'pcm-be',
	'sowt': 'pcm-le',
	'fl32': 'pcm-f32be',
	'FL32': 'pcm-f32be',
	'fl64': 'pcm-f64be',
	'FL64': 'pcm-f64be',
	'ulaw': 'ulaw',
	'ULAW': 'ulaw',
	'alaw': 'alaw',
	'ALAW': 'alaw',
	'raw ': 'pcm-u8',
};

export class AiffDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	dataStart = -1;
	dataSize = -1;
	dataSizeCapped = false;
	audioInfo: {
		codec: AudioCodec;
		numberOfChannels: number;
		sampleRate: number;
		blockSizeInBytes: number;
	} | null = null;

	trackBackings: AiffAudioTrackBacking[] = [];
	metadataTags: MetadataTags = {};

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let slice = this.reader.requestSlice(0, 12);
			if (isThenable(slice)) slice = await slice;
			assert(slice);

			if (readAscii(slice, 4) !== 'FORM') {
				throw new Error('Invalid AIFF file - wrong format');
			}

			const outerChunkSize = readU32Be(slice);
			const formType = readAscii(slice, 4);
			if (formType !== 'AIFF' && formType !== 'AIFC') {
				throw new Error('Invalid AIFF file - wrong format');
			}

			// A size of zero means the file was never finalized, which is what a stream looks like
			const totalFileSize = outerChunkSize === 0
				? this.reader.fileSize
				: Math.min(outerChunkSize + 8, this.reader.fileSize ?? Infinity);

			let currentPos = slice.filePos;

			while (totalFileSize === null || currentPos < totalFileSize) {
				let slice = this.reader.requestSlice(currentPos, 8);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const chunkId = readAscii(slice, 4);
				const chunkSize = readU32Be(slice);
				const startPos = slice.filePos;

				if (chunkId === 'COMM') {
					await this.parseCommChunk(startPos, chunkSize, formType === 'AIFC');
				} else if (chunkId === 'SSND') {
					await this.parseSsndChunk(startPos, chunkSize, totalFileSize);

					if (this.reader.fileSize === null) {
						break; // Stop once we hit the sound data
					}
				} else if (chunkId === 'NAME' || chunkId === 'AUTH' || chunkId === 'ANNO') {
					await this.parseTextChunk(chunkId, startPos, chunkSize);
				}

				currentPos = startPos + chunkSize + (chunkSize & 1); // Handle padding
			}

			if (!this.audioInfo) {
				throw new Error('Invalid AIFF file - missing "COMM" chunk');
			}
			if (this.dataStart === -1) {
				throw new Error('Invalid AIFF file - missing "SSND" chunk');
			}

			const blockSize = this.audioInfo.blockSizeInBytes;
			this.dataSize = Math.floor(this.dataSize / blockSize) * blockSize;
			this.maybeCapDataSize();

			this.trackBackings.push(new AiffAudioTrackBacking(this));
		})();
	}

	private async parseCommChunk(startPos: number, size: number, isAifc: boolean) {
		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		if (size < 18) {
			throw new Error('Invalid AIFF file - "COMM" chunk is too small');
		}

		const numChannels = readU16Be(slice);
		slice.skip(4); // numSampleFrames, which SSND's own size says too
		const bitsPerSample = readU16Be(slice);
		const sampleRate = roundIfAlmostInteger(readExtendedFloat80(slice));

		if (numChannels === 0 || sampleRate <= 0) {
			throw new Error('Invalid AIFF file - channel count and sample rate must be positive');
		}

		const compression = isAifc && size >= 22 ? readAscii(slice, 4) : 'NONE';
		const mapped = COMPRESSION_CODECS[compression];
		if (mapped === undefined) {
			throw new Error(
				`Unsupported AIFF-C compression type '${compression}'. This library reads uncompressed AIFF`
				+ ' and the PCM, float, µ-law and A-law AIFF-C types.',
			);
		}

		let codec: AudioCodec;
		let sampleSizeInBytes: number;

		if (mapped === 'pcm-be' || mapped === 'pcm-le') {
			// A sample size is stated in BITS and may be any width from 1 to 32; the samples themselves
			// are left-aligned in whole octets, so what matters is how many octets one takes
			sampleSizeInBytes = Math.ceil(bitsPerSample / 8);
			const suffix = mapped === 'pcm-be' ? 'be' : '';

			if (sampleSizeInBytes === 1) {
				// AIFF's 8-bit samples are SIGNED, where WAVE's are unsigned, and one read as the other
				// is a full-scale square wave of noise
				codec = 'pcm-s8';
			} else if (sampleSizeInBytes === 2) {
				codec = `pcm-s16${suffix}` as AudioCodec;
			} else if (sampleSizeInBytes === 3) {
				codec = `pcm-s24${suffix}` as AudioCodec;
			} else if (sampleSizeInBytes === 4) {
				codec = `pcm-s32${suffix}` as AudioCodec;
			} else {
				throw new Error(`Invalid AIFF file - unsupported sample size of ${bitsPerSample} bits`);
			}
		} else {
			codec = mapped;
			sampleSizeInBytes = mapped === 'pcm-f64be' ? 8 : mapped === 'pcm-f32be' ? 4 : 1;
		}

		this.audioInfo = {
			codec,
			numberOfChannels: numChannels,
			sampleRate,
			blockSizeInBytes: sampleSizeInBytes * numChannels,
		};
	}

	private async parseSsndChunk(startPos: number, size: number, totalFileSize: number | null) {
		let slice = this.reader.requestSlice(startPos, 8);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return;

		// The offset is dead space between the chunk's header and the first frame, so a writer can align
		// the samples to a block boundary; blockSize is what it aligned them to, and says nothing here
		const offset = readU32Be(slice);
		slice.skip(4);

		this.dataStart = startPos + 8 + offset;

		// A size of zero is an unfinalized file, where the data runs to the end
		const stated = size === 0 ? Number.MAX_SAFE_INTEGER : Math.max(size - 8 - offset, 0);
		this.dataSize = Math.max(Math.min(stated, (totalFileSize ?? Infinity) - this.dataStart), 0);
	}

	private async parseTextChunk(chunkId: string, startPos: number, size: number) {
		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return;

		const text = strictTextDecoder.decode(readBytes(slice, size)).replace(/\0+$/, '').trim();
		if (!text) {
			return;
		}

		if (chunkId === 'NAME') {
			this.metadataTags.title ??= text;
		} else if (chunkId === 'AUTH') {
			this.metadataTags.artist ??= text;
		} else {
			this.metadataTags.comment ??= text;
		}
	}

	maybeCapDataSize() {
		assert(this.audioInfo);

		if (this.dataSizeCapped) {
			return;
		}

		const fileSize = this.reader.fileSize;
		if (fileSize !== null) {
			this.dataSize = Math.min(
				this.dataSize,
				floorToMultiple(fileSize - this.dataStart, this.audioInfo.blockSizeInBytes),
			);
			this.dataSizeCapped = true;
		}
	}

	async getMimeType() {
		return 'audio/aiff';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}
}

const PACKET_SIZE_IN_FRAMES = 2048;

class AiffAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: AiffDemuxer) {}

	getType() {
		return 'audio' as const;
	}

	getNumber() {
		return 1;
	}

	getCodec() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.codec;
	}

	getInternalCodecId() {
		return null;
	}

	getEncryptionInfo() {
		return null;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		assert(this.demuxer.audioInfo);
		return {
			codec: this.demuxer.audioInfo.codec,
			numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
			sampleRate: this.demuxer.audioInfo.sampleRate,
		};
	}

	getNumberOfChannels() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.numberOfChannels;
	}

	getSampleRate() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	getTimeResolution() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		assert(this.demuxer.audioInfo);
		this.demuxer.maybeCapDataSize();

		return this.demuxer.dataSize
			/ this.demuxer.audioInfo.blockSizeInBytes
			/ this.demuxer.audioInfo.sampleRate;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	private async getPacketAtIndex(
		packetIndex: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		assert(packetIndex >= 0);
		assert(this.demuxer.audioInfo);

		const blockSize = this.demuxer.audioInfo.blockSizeInBytes;
		this.demuxer.maybeCapDataSize();

		const startOffset = packetIndex * PACKET_SIZE_IN_FRAMES * blockSize;
		if (startOffset >= this.demuxer.dataSize) {
			return null;
		}

		const sizeInBytes = Math.min(PACKET_SIZE_IN_FRAMES * blockSize, this.demuxer.dataSize - startOffset);

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null;
			}

			data = readBytes(slice, sizeInBytes);
		}

		const timestamp = packetIndex * PACKET_SIZE_IN_FRAMES / this.demuxer.audioInfo.sampleRate;
		const duration = sizeInBytes / blockSize / this.demuxer.audioInfo.sampleRate;

		return new EncodedPacket(data, 'key', timestamp, duration, packetIndex, sizeInBytes);
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions) {
		assert(this.demuxer.audioInfo);

		this.demuxer.maybeCapDataSize();

		// Clamped to the last packet that exists: a seek past the end - `computeDuration` asks for the
		// packet at Infinity - must give back the final packet rather than nothing
		const packetIndex = Math.floor(Math.min(
			roundIfAlmostInteger(timestamp * this.demuxer.audioInfo.sampleRate) / PACKET_SIZE_IN_FRAMES,
			(this.demuxer.dataSize - 1) / (PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes),
		));
		if (packetIndex < 0) {
			return Promise.resolve(null);
		}

		return this.getPacketAtIndex(packetIndex, options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		assert(this.demuxer.audioInfo);
		const packetIndex = Math.round(
			packet.timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES,
		);

		return this.getPacketAtIndex(packetIndex + 1, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}
