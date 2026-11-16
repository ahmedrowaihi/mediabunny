/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Joins the layers below into tracks a caller can read: the partitions say where things are, the
// header metadata says what the tracks are, the index says where each edit unit lives, and the
// essence keys say which track an element belongs to.
//
// The whole sample table is built once, up front, from the index rather than by walking the essence.
// That is the difference between opening a two-hour file in one read and in forty thousand: the index
// states every edit unit's offset, so the only thing the essence itself has to supply is where the
// container starts.

import { AudioCodec, extractVideoCodecString, VideoCodec } from '../codec';
import {
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	type AvcDecoderConfigurationRecord,
	type HevcDecoderConfigurationRecord,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { MalformedInputError } from '../errors';
import { Input } from '../input';
import type { InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking } from '../input-track';
import type { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { assert, binarySearchLessOrEqual, isThenable, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader } from '../reader';
import { startTimecodeOf } from '../timecode';
import { readPictureInfo, readSoundInfo, type MxfPictureInfo, type MxfSoundInfo } from './mxf-codec';
import { walkEssenceElements, wrappingOf, type MxfWrapping } from './mxf-essence';
import {
	locateEditUnit,
	presentationOrder,
	readIndexTableSegment,
	type MxfIndexSegment,
} from './mxf-index';
import { asKey, essenceTrackNumber, partitionKind, readKlvHeader } from './mxf-klv';
import {
	type MxfStartTimecode,
	type MxfTrack,
	readHeaderMetadata,
	resolveTracks,
} from './mxf-metadata';
import { readHeaderMetadataSets, readIndexSegmentsIn, readPartitions } from './mxf-partition';

/**
 * How much of the file is read to find the header metadata and the index.
 *
 * The header partition is at the front and the footer - which usually carries the index - is at the
 * back, so a file is opened by reading both ends. This bounds the front read; a header partition
 * larger than this is one with an unusual amount of metadata, and its tracks are still read, only its
 * index may not be.
 */
const HEADER_READ_SIZE = 4 * 1024 * 1024;

type MxfSample = {
	/** Presentation time in seconds. */
	timestamp: number;
	/** Decode time in seconds, which differs from `timestamp` only where the coding reorders. */
	decodeTimestamp: number;
	duration: number;
	/** Byte offset of the essence element's key, not its value: the header is read to find the value. */
	keyPosition: number;
	isKeyFrame: boolean;
	/**
	 * Where the element's value starts and how long it is, filled the first time the element's KLV
	 * header is read. The index states the size of the whole triplet rather than of the essence, and
	 * the header is a few bytes of unknown width, so the exact length only comes from reading it.
	 */
	resolved: { valueStart: number; length: number } | null;
};

type MxfTrackData = {
	track: MxfTrack;
	trackNumber: number;
	/** In decode order, which is the order a sequence number means and the order the essence is in. */
	samples: MxfSample[];
	/**
	 * Indices into `samples`, ordered by presentation time. Seeking is stated in presentation time but
	 * the samples are in decode order, and the two differ exactly where the coding reorders - so a
	 * binary search over `samples` by timestamp is searching an unsorted array, and lands late.
	 */
	byPresentation: number[];
	/**
	 * The programme's start timecode, which MXF states on a track of its own rather than on the
	 * picture track. It describes the package's timeline, so every track of that package carries it.
	 */
	startTimecode: MxfStartTimecode | null;
	picture: MxfPictureInfo | null;
	sound: MxfSoundInfo | null;
	wrapping: MxfWrapping;
};

/** A run of one essence container's bytes inside a single body partition. */
type MxfEssenceRun = {
	/** Stream offset, within the container, of this run's first byte. */
	bodyOffset: number;
	/** File offset of that same byte. */
	fileStart: number;
};

// A stream offset counts from the container's start, not the file's: the partitions carrying its
// BodySID laid end to end.
const fileOffsetOf = (runs: MxfEssenceRun[], streamOffset: number): number | null => {
	let chosen: MxfEssenceRun | null = null;
	for (const run of runs) {
		if (run.bodyOffset > streamOffset) {
			break;
		}

		chosen = run;
	}

	return chosen === null ? null : chosen.fileStart + (streamOffset - chosen.bodyOffset);
};

export class MxfDemuxer extends Demuxer {
	reader: Reader;
	metadataPromise: Promise<void> | null = null;
	trackDatas: MxfTrackData[] = [];
	backings: InputTrackBacking[] = [];

	constructor(input: Input) {
		super(input);
		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const fileSize = this.reader.fileSize ?? 0;
			const front = await this.sliceOf(0, Math.min(HEADER_READ_SIZE, fileSize));
			if (!front) {
				throw new MalformedInputError('This MXF file is too short to hold a header partition.');
			}

			const partitions = readPartitions(FileSlice.tempFromBytes(front.bytes));
			const header = partitions.find(partition => partition.kind === 'header');
			if (!header) {
				throw new MalformedInputError('This MXF file opens with no header partition.');
			}

			const metadataSlice = FileSlice.tempFromBytes(front.bytes);
			metadataSlice.skip(header.contentsStart);
			const { sets, setTypes } = readHeaderMetadataSets(metadataSlice);
			const metadata = readHeaderMetadata(sets, setTypes);

			// A partition states no length, so the next one's start is the only bound there is.
			const endOf = (index: number) => partitions[index + 1]?.start ?? fileSize;

			const segments: MxfIndexSegment[] = [];
			for (const [index, partition] of partitions.entries()) {
				if (partition.indexSid === 0) {
					continue;
				}

				// OP1b spreads index segments through the file, past the window read at the front.
				const end = endOf(index);
				if (end <= front.bytes.length) {
					const slice = FileSlice.tempFromBytes(front.bytes);
					slice.skip(partition.contentsStart);
					segments.push(...readIndexSegmentsIn(slice).map(readIndexTableSegment));
					continue;
				}

				const slice = await this.sliceOf(partition.contentsStart, end - partition.contentsStart);
				if (slice) {
					segments.push(...readIndexSegmentsIn(slice).map(readIndexTableSegment));
				}
			}

			// The footer, wherever it is. Not found by the walk above: that only covers the window read at
			// the front, and the footer of any file bigger than it lies past the end of those bytes -
			// which is most files, and exactly the ones whose index matters. The header partition pack
			// states where it is, which is the one stated offset a reader has to rely on.
			const footerOffset = header.footerOffset;
			if (segments.length === 0 && footerOffset > 0 && footerOffset < fileSize) {
				const back = await this.sliceOf(footerOffset, fileSize - footerOffset);
				const pack = back && readKlvHeader(back);
				if (back && pack && partitionKind(pack.key) !== null) {
					back.skip(pack.length);
					segments.push(...readIndexSegmentsIn(back).map(readIndexTableSegment));
				}
			}

			const runsBySid = new Map<number, MxfEssenceRun[]>();
			const elementCounts = new Map<string, number>();
			for (const [index, partition] of partitions.entries()) {
				if (partition.bodySid === 0) {
					continue;
				}

				// Bounded by the partition: a 4 MB read each would cost the file over many times.
				const length = Math.min(endOf(index) - partition.contentsStart, HEADER_READ_SIZE);
				const slice = await this.sliceOf(partition.contentsStart, length);
				if (!slice) {
					continue;
				}

				let runStarted = false;
				walkEssenceElements(slice, (element) => {
					if (!runStarted) {
						// The key, not the value: an index offset counts the whole KLV triplet
						const runs = runsBySid.get(partition.bodySid) ?? [];
						runs.push({ bodyOffset: partition.bodyOffset, fileStart: element.keyStart });
						runsBySid.set(partition.bodySid, runs);
						runStarted = true;
					}

					const key = `${partition.bodySid}:${element.trackNumber}`;
					elementCounts.set(key, (elementCounts.get(key) ?? 0) + 1);
				});
			}
			for (const runs of runsBySid.values()) {
				runs.sort((a, b) => a.bodyOffset - b.bodyOffset);
			}

			const startTimecode = metadata.materialPackage?.tracks
				.map(track => track.startTimecode)
				.find(entry => entry !== null) ?? null;

			for (const resolved of resolveTracks(metadata)) {
				// Matching on kind alone hands every sound track the first one's essence.
				const sourceTrackId = resolved.track.sourceTrackId ?? resolved.track.id;
				const fileTrack = resolved.pkg.tracks.find(candidate => candidate.id === sourceTrackId)
					?? resolved.pkg.tracks.find(candidate => (
						candidate.kind === resolved.track.kind && candidate.trackNumber !== 0
					));
				if (!fileTrack || !resolved.descriptor) {
					continue;
				}

				const bodySid = metadata.essenceContainers.get(resolved.pkg.uid)?.bodySid ?? 0;
				const runs = runsBySid.get(bodySid)
					?? (metadata.essenceContainers.size === 0 ? [...runsBySid.values()][0] : undefined);
				const editRate = resolved.track.editRate ?? fileTrack.editRate;
				if (!runs || runs.length === 0 || !editRate || editRate.den === 0 || editRate.num === 0) {
					continue;
				}

				// Another container's index would answer for positions it knows nothing about.
				const named = segments.filter(segment => segment.bodySid === bodySid);
				const unnamed = segments.filter(segment => segment.bodySid === 0);
				const trackSegments = named.length > 0 ? named : unnamed.length > 0 ? unnamed : segments;

				const data: MxfTrackData = {
					track: resolved.track,
					trackNumber: fileTrack.trackNumber,
					samples: [],
					byPresentation: [],
					startTimecode,
					picture: resolved.track.kind === 'picture' ? readPictureInfo(resolved.descriptor) : null,
					sound: resolved.track.kind === 'sound' ? readSoundInfo(resolved.descriptor) : null,
					wrapping: wrappingOf(
						elementCounts.get(`${bodySid}:${fileTrack.trackNumber}`) ?? 0,
						resolved.track.duration,
					),
				};

				this.buildSamples(data, trackSegments, runs, editRate, fileSize);
				if (data.samples.length > 0) {
					this.trackDatas.push(data);
				}
			}

			this.backings = this.trackDatas.map(data => (
				data.picture
					? new MxfVideoTrackBacking(this, data)
					: new MxfAudioTrackBacking(this, data)
			));
		})();
	}

	private buildSamples(
		data: MxfTrackData,
		segments: MxfIndexSegment[],
		runs: MxfEssenceRun[],
		editRate: { num: number; den: number },
		fileSize: number,
	) {
		const perUnit = editRate.den / editRate.num;
		const ordering = presentationOrder(segments);
		const origin = data.track.origin;

		// A constant-bit-rate index states no entries and no duration - it is one byte count covering
		// whatever the container holds - so `locateEditUnit` answers for every position ever asked and
		// the walk has to be bounded from outside it. The track's own duration is that bound; failing
		// that, the file ends somewhere, and an edit unit starting past it does not exist.
		const stated = data.track.duration;
		const limit = stated !== null && stated > 0 ? stated : Number.MAX_SAFE_INTEGER;

		for (let position = 0; position < limit; position++) {
			const located = locateEditUnit(segments, position);
			if (!located) {
				break;
			}

			const keyPosition = fileOffsetOf(runs, located.streamOffset);
			if (keyPosition === null || keyPosition >= fileSize) {
				break;
			}

			const display = ordering.get(position) ?? position;
			data.samples.push({
				timestamp: (display - origin) * perUnit,
				decodeTimestamp: (position - origin) * perUnit,
				duration: perUnit,
				keyPosition,
				isKeyFrame: located.isKeyFrame,
				resolved: null,
			});
		}

		data.samples.sort((a, b) => a.decodeTimestamp - b.decodeTimestamp);
		data.byPresentation = data.samples
			.map((_, index) => index)
			.sort((a, b) => data.samples[a]!.timestamp - data.samples[b]!.timestamp);
	}

	private async sliceOf(start: number, length: number) {
		if (length <= 0) {
			return null;
		}

		let slice = this.reader.requestSlice(start, length);
		if (isThenable(slice)) slice = await slice;
		return slice;
	}

	/**
	 * Resolves one sample's KLV header, which gives the exact extent of the essence.
	 *
	 * The index states the size of the whole triplet, and the header between is a key plus a BER length
	 * of unknown width, so the essence's own length is only knowable by reading it. Reading the header
	 * also checks the position: an offset that landed anywhere but on this track's element key is an
	 * index this reader has misunderstood, which is worth failing on rather than returning the bytes
	 * that happen to be there.
	 */
	async resolveSample(sample: MxfSample, trackNumber: number) {
		if (sample.resolved) {
			return sample.resolved;
		}

		// 16-byte key plus at most a 9-byte BER length
		const headerSlice = await this.sliceOf(sample.keyPosition, 25);
		if (!headerSlice) {
			return null;
		}

		const header = readKlvHeader(headerSlice);
		if (!header) {
			return null;
		}

		if (essenceTrackNumber(header.key) !== trackNumber) {
			throw new MalformedInputError(
				`An MXF index points at offset ${sample.keyPosition} for track ${trackNumber}, but the`
				+ ` element there is ${asKey(header.key)}.`,
			);
		}

		return sample.resolved = { valueStart: header.valueStart, length: header.length };
	}

	/** Reads one essence element's value. */
	async readSample(sample: MxfSample, trackNumber: number): Promise<Uint8Array | null> {
		const resolved = await this.resolveSample(sample, trackNumber);
		if (!resolved) {
			return null;
		}

		const slice = await this.sliceOf(resolved.valueStart, resolved.length);
		if (!slice) {
			return null;
		}

		return readBytes(slice, resolved.length);
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.backings;
	}

	async getMimeType() {
		return 'application/mxf';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		await this.readMetadata();
		return {};
	}
}

abstract class MxfTrackBacking {
	constructor(public demuxer: MxfDemuxer, public data: MxfTrackData) {}

	getId() {
		return this.data.track.id;
	}

	getNumber() {
		return this.data.trackNumber;
	}

	getContainerId() {
		return this.data.trackNumber;
	}

	getName() {
		return this.data.track.name;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution() {
		const rate = this.data.track.editRate;
		return rate && rate.den > 0 ? rate.num / rate.den : 1;
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
		const rate = this.data.track.editRate;
		const duration = this.data.track.duration;
		if (duration === null || !rate || rate.num === 0) {
			return null;
		}

		return duration * rate.den / rate.num;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getDisposition() {
		return { ...DEFAULT_TRACK_DISPOSITION };
	}

	getEncryptionInfo() {
		return null;
	}

	getStartTimecode() {
		const timecode = this.data.startTimecode;
		if (!timecode || timecode.base === 0) {
			return null;
		}

		return startTimecodeOf(timecode.startFrame, timecode.base, timecode.dropFrame);
	}

	async getPacketAtIndex(index: number, options: PacketRetrievalOptions) {
		const sample = this.data.samples[index];
		if (!sample) {
			return null;
		}

		let data: Uint8Array;
		let byteLength: number;

		if (options.metadataOnly) {
			const resolved = await this.demuxer.resolveSample(sample, this.data.trackNumber);
			if (!resolved) {
				return null;
			}

			data = PLACEHOLDER_DATA;
			byteLength = resolved.length;
		} else {
			const read = await this.demuxer.readSample(sample, this.data.trackNumber);
			if (!read) {
				return null;
			}

			data = read;
			byteLength = read.byteLength;
		}

		return new EncodedPacket(
			data,
			sample.isKeyFrame ? 'key' : 'delta',
			sample.timestamp,
			sample.duration,
			index,
			byteLength,
			undefined,
			sample.decodeTimestamp,
		);
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	/** Position within `byPresentation` of the last sample presented at or before `timestamp`. */
	private presentationSlotAt(timestamp: number) {
		return binarySearchLessOrEqual(
			this.data.byPresentation,
			timestamp,
			index => this.data.samples[index]!.timestamp,
		);
	}

	/** The decode-order index of the last sample presented at or before `timestamp`. */
	private indexAt(timestamp: number) {
		const slot = this.presentationSlotAt(timestamp);
		return slot === -1 ? -1 : this.data.byPresentation[slot]!;
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(this.indexAt(timestamp), options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		assert(packet.sequenceNumber >= 0);
		return this.getPacketAtIndex(packet.sequenceNumber + 1, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		let slot = this.presentationSlotAt(timestamp);
		while (slot >= 0 && !this.data.samples[this.data.byPresentation[slot]!]!.isKeyFrame) {
			slot--;
		}

		return this.getPacketAtIndex(slot === -1 ? -1 : this.data.byPresentation[slot]!, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		assert(packet.sequenceNumber >= 0);
		for (let index = packet.sequenceNumber + 1; index < this.data.samples.length; index++) {
			if (this.data.samples[index]!.isKeyFrame) {
				return this.getPacketAtIndex(index, options);
			}
		}

		return Promise.resolve(null);
	}
}

class MxfVideoTrackBacking extends MxfTrackBacking implements InputVideoTrackBacking {
	getType() {
		return 'video' as const;
	}

	private get info() {
		assert(this.data.picture);
		return this.data.picture;
	}

	getCodec(): VideoCodec | null {
		return this.info.codec;
	}

	getInternalCodecId() {
		return this.info.internalId;
	}

	getCodedWidth() {
		return this.info.codedWidth;
	}

	getCodedHeight() {
		return this.info.codedHeight;
	}

	getSquarePixelWidth() {
		return this.info.displayWidth;
	}

	getSquarePixelHeight() {
		return this.info.displayHeight;
	}

	getMetadataDisplayWidth() {
		return this.info.displayWidth;
	}

	getMetadataDisplayHeight() {
		return this.info.displayHeight;
	}

	getTransformationMatrix() {
		return [1, 0, 0, 0, 1, 0, 0, 0, 1] as const as [
			number, number, number, number, number, number, number, number, number,
		];
	}

	async getColorSpace() {
		return {};
	}

	async canBeTransparent() {
		return false;
	}

	getHasOnlyKeyPackets() {
		return this.data.samples.every(sample => sample.isKeyFrame);
	}

	async getDecoderConfig() {
		const codec = this.info.codec;
		if (!codec) {
			return null;
		}

		let avcCodecInfo: AvcDecoderConfigurationRecord | null = null;
		let hevcCodecInfo: HevcDecoderConfigurationRecord | null = null;
		if (codec === 'avc' || codec === 'hevc') {
			const first = this.data.samples[0];
			const bytes = first ? await this.demuxer.readSample(first, this.data.trackNumber) : null;
			if (bytes) {
				avcCodecInfo = codec === 'avc' ? extractAvcDecoderConfigurationRecord(bytes) : null;
				hevcCodecInfo = codec === 'hevc' ? extractHevcDecoderConfigurationRecord(bytes) : null;
			}
		}

		return {
			codec: extractVideoCodecString({
				width: this.info.codedWidth,
				height: this.info.codedHeight,
				codec,
				codecDescription: null,
				colorSpace: null,
				avcType: 1,
				hevcType: 'hev1',
				avcCodecInfo,
				hevcCodecInfo,
				vp9CodecInfo: null,
				av1CodecInfo: null,
				mpeg2CodecInfo: null,
				proresFormat: null,
			}),
			codedWidth: this.info.codedWidth,
			codedHeight: this.info.codedHeight,
			displayAspectWidth: this.info.displayWidth,
			displayAspectHeight: this.info.displayHeight,
		};
	}
}

class MxfAudioTrackBacking extends MxfTrackBacking implements InputAudioTrackBacking {
	getType() {
		return 'audio' as const;
	}

	private get info() {
		assert(this.data.sound);
		return this.data.sound;
	}

	getCodec(): AudioCodec | null {
		return this.info.codec;
	}

	getInternalCodecId() {
		return this.info.internalId;
	}

	getNumberOfChannels() {
		return this.info.channelCount;
	}

	getSampleRate() {
		return this.info.sampleRate;
	}

	async getDecoderConfig() {
		const codec = this.info.codec;
		if (!codec) {
			return null;
		}

		return {
			codec,
			numberOfChannels: this.info.channelCount,
			sampleRate: this.info.sampleRate,
		};
	}
}
