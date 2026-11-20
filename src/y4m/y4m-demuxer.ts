/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputVideoTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	IDENTITY_MATRIX,
	isThenable,
	textEncoder,
	type TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readAscii, readBytes, Reader } from '../reader';
import { RAWVIDEO_CODEC_STRING } from '../codec';
import { Y4mColorSpace, y4mColorSpaceOf, y4mFrameSize } from './y4m-misc';

export const Y4M_SIGNATURE = 'YUV4MPEG2';

/** `FRAME` plus its own parameter list, then a newline, then the picture. */
const FRAME_MAGIC = 'FRAME';

/** Nothing sane puts a kilobyte of parameters on a frame, and this bounds the search for the newline. */
const MAX_FRAME_HEADER_LENGTH = 1024;

export class Y4mDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	headerSize = 0;
	frameSize = 0;
	info: {
		width: number;
		height: number;
		colorSpace: Y4mColorSpace;
		frameRate: { num: number; den: number };
		pixelAspectRatio: { num: number; den: number };
		interlacing: string;
	} | null = null;

	/**
	 * Where each frame's picture begins. Y4M has no index, and a frame header may carry parameters of
	 * its own, so positions are discovered by walking and remembered as they are.
	 */
	frameOffsets: number[] = [];
	walkedToEnd = false;

	trackBackings: Y4mVideoTrackBacking[] = [];

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const slice = await this.sliceOfAtMost(0, MAX_FRAME_HEADER_LENGTH);
			if (!slice) {
				throw new Error('Invalid Y4M file - too short to hold a header');
			}

			const available = slice.end - slice.start;
			const text = new TextDecoder('latin1').decode(readBytes(slice, available));
			const newline = text.indexOf('\n');
			if (!text.startsWith(Y4M_SIGNATURE) || newline === -1) {
				throw new Error('Invalid Y4M file - no YUV4MPEG2 header');
			}

			this.headerSize = textEncoder.encode(text.slice(0, newline + 1)).byteLength;
			this.parseHeader(text.slice(Y4M_SIGNATURE.length, newline));

			assert(this.info);
			this.frameSize = y4mFrameSize(this.info.colorSpace, this.info.width, this.info.height);

			this.trackBackings.push(new Y4mVideoTrackBacking(this));
		})();
	}

	private parseHeader(parameters: string) {
		let width: number | null = null;
		let height: number | null = null;
		let frameRate = { num: 25, den: 1 };
		let pixelAspectRatio = { num: 1, den: 1 };
		let interlacing = 'p';
		// A header with no C parameter is 4:2:0, which is what every writer that omits it means
		let colorSpace = y4mColorSpaceOf('420jpeg')!;

		const ratio = (text: string, what: string) => {
			const [num, den] = text.split(':').map(Number);
			if (!Number.isFinite(num) || !Number.isFinite(den) || num! < 0 || den! <= 0) {
				throw new Error(`Invalid Y4M file - malformed ${what} '${text}'`);
			}

			return { num: num!, den: den! };
		};

		for (const token of parameters.split(' ')) {
			if (token.length < 2) {
				continue;
			}

			const value = token.slice(1);

			switch (token[0]) {
				case 'W':
					width = Number(value);
					break;
				case 'H':
					height = Number(value);
					break;
				case 'F':
					frameRate = ratio(value, 'frame rate');
					break;
				case 'A':
					pixelAspectRatio = ratio(value, 'pixel aspect ratio');
					break;
				case 'I':
					interlacing = value;
					break;
				case 'C': {
					const found = y4mColorSpaceOf(value);
					if (!found) {
						throw new Error(
							`Unsupported Y4M colour space 'C${value}'. The colour space fixes the size and`
							+ ' layout of every frame, so a file stating one this library does not know'
							+ ' cannot be read at all.',
						);
					}

					colorSpace = found;
					break;
				}
				default:
					break; // X parameters are comments, and anything else is not ours
			}
		}

		if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) {
			throw new Error('Invalid Y4M file - the header must state a positive width and height');
		}

		// A frame rate of 0:den means "unspecified", which is a stream with no timing of its own
		this.info = {
			width,
			height,
			colorSpace,
			frameRate: frameRate.num === 0 ? { num: 25, den: 1 } : frameRate,
			pixelAspectRatio: pixelAspectRatio.num === 0 ? { num: 1, den: 1 } : pixelAspectRatio,
			interlacing,
		};
	}

	/**
	 * Up to `length` octets from `start`, or fewer where the file ends first.
	 *
	 * A Y4M header - the file's or a frame's - is as long as it is, so a read has to ask for a bound
	 * rather than a size. Asking for the bound outright fails on the last frame of a small file, where
	 * there is less of it left than the bound, and the failure reads exactly like "no frame here".
	 */
	private async sliceOfAtMost(start: number, length: number): Promise<FileSlice | null> {
		const fileSize = this.reader.fileSize;
		const want = fileSize === null ? length : Math.min(length, fileSize - start);
		if (want <= 0) {
			return null;
		}

		let slice = this.reader.requestSlice(start, want);
		if (isThenable(slice)) slice = await slice;
		if (slice) {
			return slice;
		}

		// An unsized source only reports its length once a read runs past it
		if (this.reader.fileSize === null || this.reader.fileSize === fileSize) {
			return null;
		}

		return this.sliceOfAtMost(start, length);
	}

	/**
	 * The offset of frame `index`'s picture, walking forward from the last one known.
	 *
	 * Each frame header is `FRAME`, optional parameters, and a newline, so it is not a fixed width and
	 * the walk cannot be replaced by multiplication.
	 */
	async offsetOfFrame(index: number): Promise<number | null> {
		await this.readMetadata();

		while (this.frameOffsets.length <= index) {
			if (this.walkedToEnd) {
				return null;
			}

			const previous = this.frameOffsets.length === 0
				? this.headerSize
				: this.frameOffsets[this.frameOffsets.length - 1]! + this.frameSize;

			const slice = await this.sliceOfAtMost(previous, MAX_FRAME_HEADER_LENGTH);
			if (!slice || slice.end - slice.start < FRAME_MAGIC.length + 1) {
				this.walkedToEnd = true;
				return null;
			}

			const available = slice.end - slice.start;
			if (readAscii(slice, FRAME_MAGIC.length) !== FRAME_MAGIC) {
				this.walkedToEnd = true;
				return null;
			}

			const rest = new TextDecoder('latin1').decode(
				readBytes(slice, available - FRAME_MAGIC.length),
			);
			const newline = rest.indexOf('\n');
			if (newline === -1) {
				this.walkedToEnd = true;
				return null;
			}

			const pictureAt = previous
				+ FRAME_MAGIC.length
				+ textEncoder.encode(rest.slice(0, newline + 1)).byteLength;

			// A truncated final frame is not a frame; a reader that yielded it would hand back a
			// picture with its bottom rows missing
			const fileSize = this.reader.fileSize;
			if (fileSize !== null && pictureAt + this.frameSize > fileSize) {
				this.walkedToEnd = true;
				return null;
			}

			this.frameOffsets.push(pictureAt);
		}

		return this.frameOffsets[index]!;
	}

	async getMimeType() {
		return 'video/x-yuv4mpeg';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}
}

class Y4mVideoTrackBacking implements InputVideoTrackBacking {
	constructor(public demuxer: Y4mDemuxer) {}

	getType() {
		return 'video' as const;
	}

	getNumber() {
		return 1;
	}

	getCodec() {
		return 'rawvideo' as const;
	}

	getInternalCodecId() {
		assert(this.demuxer.info);
		return this.demuxer.info.colorSpace.tag;
	}

	getEncryptionInfo() {
		return null;
	}

	getCodedWidth() {
		assert(this.demuxer.info);
		return this.demuxer.info.width;
	}

	getCodedHeight() {
		assert(this.demuxer.info);
		return this.demuxer.info.height;
	}

	getSquarePixelWidth() {
		assert(this.demuxer.info);
		const { num, den } = this.demuxer.info.pixelAspectRatio;
		return this.demuxer.info.width * num / den;
	}

	getSquarePixelHeight() {
		assert(this.demuxer.info);
		return this.demuxer.info.height;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return {};
	}

	async canBeTransparent() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		assert(this.demuxer.info);

		return {
			codec: RAWVIDEO_CODEC_STRING,
			codedWidth: this.demuxer.info.width,
			codedHeight: this.demuxer.info.height,
			// Uncompressed frames carry nothing that says what they are, so the colour space tag rides
			// here - it is the only thing a decoder needs and the only thing there is to state
			description: textEncoder.encode(this.demuxer.info.colorSpace.tag),
		};
	}

	allPacketsAreKeyPackets() {
		return true;
	}

	getReorderSize() {
		return 0;
	}

	getTimeResolution() {
		assert(this.demuxer.info);
		return this.demuxer.info.frameRate.num / this.demuxer.info.frameRate.den;
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
		assert(this.demuxer.info);
		const { num, den } = this.demuxer.info.frameRate;
		return 8 * this.demuxer.frameSize * num / den;
	}

	async getDurationFromMetadata() {
		return null; // There is no index and nothing states a count, so this costs a walk
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

	private frameDuration() {
		assert(this.demuxer.info);
		const { num, den } = this.demuxer.info.frameRate;
		return den / num;
	}

	private async getPacketAtIndex(
		index: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		if (index < 0) {
			return null;
		}

		const offset = await this.demuxer.offsetOfFrame(index);
		if (offset === null) {
			return null;
		}

		const size = this.demuxer.frameSize;
		let data: Uint8Array;

		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(offset, size);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null;
			}

			data = readBytes(slice, size);
		}

		const duration = this.frameDuration();
		return new EncodedPacket(data, 'key', index * duration, duration, index, size);
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	/**
	 * The index of the last frame, which costs a walk to the end: Y4M has no index and nothing states
	 * how many frames it holds, so the only way to know is to find them all. The walk is cached, so
	 * this is paid once.
	 */
	private async lastFrameIndex() {
		await this.demuxer.offsetOfFrame(Number.MAX_SAFE_INTEGER);
		return this.demuxer.frameOffsets.length - 1;
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const index = Math.floor(timestamp / this.frameDuration());
		if (index < 0) {
			return null;
		}

		// A seek past the end gives back the last frame rather than nothing, as every other backing
		// here does. `computeDuration` asks for the packet at Infinity, so without this a Y4M reported
		// a duration of zero while reading every one of its frames perfectly. The walk the first call
		// makes is what the second one then reads the end off, so this costs one pass, not two.
		return (await this.getPacketAtIndex(index, options))
			?? this.getPacketAtIndex(await this.lastFrameIndex(), options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		assert(packet.sequenceNumber >= 0);
		return this.getPacketAtIndex(packet.sequenceNumber + 1, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}

	async determinePacketType() {
		return 'key' as const;
	}
}
