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

import type { AncillaryFrame } from '../ancillary';
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
import type {
	DecodedSubtitleCue,
	InputAudioTrackBacking,
	InputSubtitleTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { parseTtmlDocument } from '../subtitles';
import type { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	binarySearchLessOrEqual,
	isThenable,
	toDataView,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, readU32Be, Reader } from '../reader';
import { startTimecodeOf } from '../timecode';
import { readPictureInfo, readSoundInfo, type MxfPictureInfo, type MxfSoundInfo } from './mxf-codec';
import { walkEssenceElements, wrappingOf, type MxfWrapping } from './mxf-essence';
import {
	locateEditUnit,
	presentationOrder,
	readIndexTableSegment,
	type MxfIndexSegment,
} from './mxf-index';
import {
	asKey,
	essenceTrackNumber,
	findRunIn,
	isD10Aes3Element,
	keyMatches,
	KLV_FILL,
	partitionKind,
	readKlvHeader,
} from './mxf-klv';
import {
	type MxfStartTimecode,
	type MxfTrack,
	readHeaderMetadata,
	resolveTracks,
} from './mxf-metadata';
import {
	readHeaderMetadataSets,
	readIndexSegmentsIn,
	readPartitions,
	readRandomIndexPack,
} from './mxf-partition';
import { decodeTimedTextDocument, readTimedTextInfo, type MxfTimedTextInfo } from './mxf-timed-text';

/**
 * How much of the file is read to find the header metadata and the index.
 *
 * The header partition is at the front and the footer - which usually carries the index - is at the
 * back, so a file is opened by reading both ends. This bounds the front read; a header partition
 * larger than this is one with an unusual amount of metadata, and its tracks are still read, only its
 * index may not be.
 */
const HEADER_READ_SIZE = 4 * 1024 * 1024;

/**
 * How many elements one content package may hold before the search gives up. An edit unit carries one
 * element per track, and a file with this many tracks in one package is not one this reader is
 * failing to understand - it is one that is wrong.
 */
const MAX_ELEMENTS_PER_CONTENT_PACKAGE = 64;

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
	/**
	 * Whether this track's essence is SMPTE 331M AES3 rather than the PCM its descriptor describes,
	 * which is how D-10 carries audio. The samples are unwrapped on the way out.
	 */
	aes3: boolean;
	/** What an ST 2067-5 timed text track file says about the document it carries. */
	timedText: MxfTimedTextInfo | null;
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
/**
 * Whether an index addresses an edit unit at a time. A clip-wrapped track whose index does not is one
 * sample: nothing states where a unit inside the element begins.
 */
const hasPerEditUnitOffsets = (segments: MxfIndexSegment[]): boolean =>
	segments.some(segment => segment.editUnitByteCount > 0 || segment.entries.length > 1);

/**
 * The PCM inside a SMPTE 331M AES3 element, as the D-10 mapping carries it.
 *
 * Four octets of header, then one 32-octet group per audio sample: eight little-endian 32-bit
 * subframes **whatever the channel count**, each holding its sample in the bits above the status
 * ones. Only the first `channels` of the eight are used, and the group's stride is 32 regardless -
 * which is the part that reading channel-by-channel gets wrong.
 */
/** @internal */
export const unwrapD10Aes3 = (bytes: Uint8Array, channels: number, bitDepth: number): Uint8Array => {
	const GROUP = 32;
	const HEADER = 4;
	if (channels < 1 || channels > 8 || bytes.byteLength <= HEADER) {
		return bytes;
	}

	const width = bitDepth === 24 ? 3 : 2;
	const shift = bitDepth === 24 ? 4 : 12;
	const groups = Math.floor((bytes.byteLength - HEADER) / GROUP);
	const out = new Uint8Array(groups * channels * width);
	const view = toDataView(bytes);

	let at = 0;
	for (let group = 0; group < groups; group++) {
		const base = HEADER + group * GROUP;
		for (let channel = 0; channel < channels; channel++) {
			const subframe = view.getUint32(base + channel * 4, true);
			const sample = (subframe >>> shift) & (width === 3 ? 0xffffff : 0xffff);
			out[at++] = sample & 0xff;
			out[at++] = (sample >>> 8) & 0xff;
			if (width === 3) {
				out[at++] = (sample >>> 16) & 0xff;
			}
		}
	}

	return out;
};

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
	/** Data essence with no track type here - SMPTE ST 436M ancillary, in a broadcast master. */
	ancillaryTrackDatas: MxfTrackData[] = [];
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

			// Up to 64 KB of run-in may precede the header partition pack, and every offset the file
			// states is measured from that pack rather than from the file's first byte
			const runIn = findRunIn(front.bytes) ?? 0;
			const partitions = readPartitions(FileSlice.tempFromBytes(front.bytes.subarray(runIn)))
				.map(partition => ({
					...partition,
					start: partition.start + runIn,
					contentsStart: partition.contentsStart + runIn,
				}));
			const header = partitions.find(partition => partition.kind === 'header');
			if (!header) {
				throw new MalformedInputError('This MXF file opens with no header partition.');
			}

			const metadataSlice = FileSlice.tempFromBytes(front.bytes);
			metadataSlice.skip(header.contentsStart);
			const { sets, setTypes, primer } = readHeaderMetadataSets(metadataSlice);
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
			// A file written without seeking back leaves the header's FooterPartition at zero, and then
			// the Random Index Pack that closes the file is the only thing that says where the footer
			// went. `omneon_8.3.0.0_xdcam_startc_footer.mxf` is exactly that: its index is in the
			// footer, its header does not point there, and without this it reads as a file with no
			// index, which is to say no samples and no tracks at all.
			let footerOffset = header.footerOffset > 0 ? header.footerOffset + runIn : 0;
			if (segments.length === 0 && footerOffset === 0) {
				footerOffset = await this.footerOffsetFromRandomIndexPack(fileSize, runIn);
			}

			if (segments.length === 0 && footerOffset > 0 && footerOffset < fileSize) {
				const back = await this.sliceOf(footerOffset, fileSize - footerOffset);
				const pack = back && readKlvHeader(back);
				if (back && pack && partitionKind(pack.key) !== null) {
					back.skip(pack.length);
					segments.push(...readIndexSegmentsIn(back).map(readIndexTableSegment));
				}
			}

			let essenceEnd = 0;
			const runsBySid = new Map<number, MxfEssenceRun[]>();
			const elementCounts = new Map<string, number>();
			// A clip-wrapped track's essence is one element, and the index's offsets count from inside
			// it rather than from its key, so that element has to be found rather than inferred.
			const firstElements = new Map<string, { start: number; length: number; aes3: boolean }>();
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
				essenceEnd = Math.max(essenceEnd, endOf(index));
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
					if (!firstElements.has(key)) {
						firstElements.set(key, {
							start: element.start,
							length: element.length,
							aes3: isD10Aes3Element(element.key),
						});
					}
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
					aes3: resolved.track.kind === 'sound'
						&& (firstElements.get(`${bodySid}:${fileTrack.trackNumber}`)?.aes3 ?? false),
					// Asked of the descriptor rather than of the kind: `data` covers everything that is
					// neither picture nor sound, and only the descriptor says which of those it is
					timedText: resolved.track.kind === 'data'
						? readTimedTextInfo(resolved.descriptor, primer)
						: null,
					wrapping: wrappingOf(
						elementCounts.get(`${bodySid}:${fileTrack.trackNumber}`) ?? 0,
						resolved.track.duration,
					),
				};

				this.buildSamples(
					data,
					trackSegments,
					runs,
					editRate,
					essenceEnd > 0 ? essenceEnd : fileSize,
					firstElements.get(`${bodySid}:${fileTrack.trackNumber}`) ?? null,
				);

				// A data track that is neither timed text nor sound is essence this library has no track
				// type for - SMPTE 436M ancillary (VANC captions, AFD, timecode) is the common one in a
				// broadcast master. It used to fall through to the audio backing, which then asserted on
				// `sound` the moment anything asked the track for its channel count, so opening an
				// ordinary captioned master threw. Leaving it out is the honest answer until there is a
				// surface for it: the picture and sound tracks read exactly as before.
				if (data.samples.length === 0) {
					continue;
				}

				// A data track that is neither timed text nor sound has no track type here, so it is kept
				// aside and read through `getAncillaryFrames` instead of becoming a track of the wrong kind
				if (resolved.track.kind === 'data' && !data.timedText) {
					this.ancillaryTrackDatas.push(data);
				} else {
					this.trackDatas.push(data);
				}
			}

			this.backings = this.trackDatas.map((data) => {
				if (data.picture) {
					return new MxfVideoTrackBacking(this, data);
				}
				if (data.timedText) {
					return new MxfSubtitleTrackBacking(this, data);
				}

				return new MxfAudioTrackBacking(this, data);
			});
		})();
	}

	/**
	 * Where the footer partition is, according to the Random Index Pack at the end of the file, or 0
	 * where there is none to read. The pack's last four octets state its own length, which is how it
	 * is found without a scan.
	 */
	private async footerOffsetFromRandomIndexPack(fileSize: number, runIn: number): Promise<number> {
		const tail = await this.sliceOf(Math.max(0, fileSize - 4), 4);
		if (!tail || tail.remainingLength < 4) {
			return 0;
		}

		// A pack holds a key, a length and at least one entry, so anything shorter is not one
		const packLength = readU32Be(tail);
		if (packLength < 25 || packLength > fileSize) {
			return 0;
		}

		const slice = await this.sliceOf(fileSize - packLength, packLength);
		if (!slice) {
			return 0;
		}

		let footer = 0;
		for (const entry of readRandomIndexPack(slice)) {
			// The footer is the last partition the pack names, and it carries no essence of its own
			const offset = entry.offset + runIn;
			if (offset < fileSize && offset > footer) {
				footer = offset;
			}
		}

		return footer;
	}

	private buildSamples(
		data: MxfTrackData,
		segments: MxfIndexSegment[],
		runs: MxfEssenceRun[],
		editRate: { num: number; den: number },
		essenceEnd: number,
		clipElement: { start: number; length: number } | null,
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

		// Clip wrapping with no per-unit offsets to walk: one element, one sample. An ST 2067-5 timed
		// text file is this - its essence is a whole IMSC document, which no index divides - and
		// reporting it as one edit unit long made a four-minute subtitle track 42 ms long.
		if (data.wrapping === 'clip' && clipElement && !hasPerEditUnitOffsets(segments)) {
			data.samples.push({
				timestamp: -origin * perUnit,
				decodeTimestamp: -origin * perUnit,
				duration: stated !== null && stated > 0 ? stated * perUnit : perUnit,
				keyPosition: clipElement.start,
				isKeyFrame: true,
				resolved: { valueStart: clipElement.start, length: clipElement.length },
			});

			data.byPresentation = [0];
			return;
		}

		for (let position = 0; position < limit; position++) {
			const located = locateEditUnit(segments, position);
			if (!located) {
				break;
			}

			// Frame wrapping makes each edit unit a whole KLV triplet, so its offsets count from the
			// key; clip wrapping puts every unit inside one element's value, so they count from there.
			// ffmpeg reads the first DNxHD unit of `track_01_v02.mxf` at the element's value start,
			// which is 25 octets past the key this used for both.
			const keyPosition = data.wrapping === 'clip' && clipElement
				? clipElement.start + located.streamOffset
				: fileOffsetOf(runs, located.streamOffset);
			if (keyPosition === null || keyPosition >= essenceEnd) {
				break;
			}

			if (data.wrapping === 'clip' && clipElement) {
				const remaining = clipElement.start + clipElement.length - keyPosition;
				if (remaining <= 0) {
					break;
				}
			}

			const display = ordering.get(position) ?? position;
			// Clip wrapping writes ONE element for the whole track, so its single sample lasts as long
			// as the track does rather than one edit unit. An ST 2067-5 timed text file is the case
			// that makes this matter: its sample is the whole IMSC document, and reporting it as 42 ms
			// made a four-minute subtitle track 42 ms long - and made any cut of it yield nothing,
			// since the sample appeared to end before the cut began.
			data.samples.push({
				timestamp: (display - origin) * perUnit,
				decodeTimestamp: (position - origin) * perUnit,
				duration: perUnit,
				keyPosition,
				isKeyFrame: located.isKeyFrame,
				// A clip-wrapped unit sits inside an element rather than being one, so there is no key
				// at `keyPosition` to walk - the index's own size is all there is to go on
				resolved: data.wrapping === 'clip' && clipElement
					? {
							valueStart: keyPosition,
							length: Math.min(
								located.size ?? clipElement.length,
								clipElement.start + clipElement.length - keyPosition,
							),
						}
					: null,
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

		// An index entry locates the **content package** - the edit unit holding every track's element
		// for that instant - not the element of one track inside it. In a single-essence file those are
		// the same offset, which is why reading it directly worked until an interleaved file turned up:
		// there the first element is the picture and the sound sits after it, so a sound index entry
		// landed on a picture key and the read was refused.
		let position = sample.keyPosition;

		// Bounded by the package itself: every element of one edit unit is a Generic Container element,
		// so the first key that is not one ends the search rather than walking into the next partition.
		for (let element = 0; element < MAX_ELEMENTS_PER_CONTENT_PACKAGE; element++) {
			// 16-byte key plus at most a 9-byte BER length
			const headerSlice = await this.sliceOf(position, 25);
			if (!headerSlice) {
				return null;
			}

			const header = readKlvHeader(headerSlice);
			if (!header) {
				return null;
			}

			const elementTrack = essenceTrackNumber(header.key);
			if (elementTrack === trackNumber) {
				return sample.resolved = { valueStart: header.valueStart, length: header.length };
			}

			if (elementTrack === null) {
				// Filler is padding between elements - alignment for a block-aligned container - so it
				// sits *inside* a content package and must be stepped over rather than read as its end
				if (keyMatches(header.key, KLV_FILL)) {
					position = header.valueStart + header.length;
					continue;
				}

				// Anything else is not an essence element, so the content package is over and this
				// track's element was not in it - an index this reader has misunderstood, which is
				// worth failing on rather than returning whatever bytes are there.
				throw new MalformedInputError(
					`An MXF index points at offset ${sample.keyPosition} for track ${trackNumber}, but the`
					+ ` element there is ${asKey(header.key)} and the content package holds no element for`
					+ ' that track.',
				);
			}

			position = header.valueStart + header.length;
		}

		throw new MalformedInputError(
			`An MXF content package at offset ${sample.keyPosition} holds more than`
			+ ` ${MAX_ELEMENTS_PER_CONTENT_PACKAGE} elements without one for track ${trackNumber}.`,
		);
	}

	/** Reads one essence element's value. */
	override async getAncillaryFrames(): Promise<AncillaryFrame[]> {
		await this.readMetadata();

		const frames: AncillaryFrame[] = [];
		for (const data of this.ancillaryTrackDatas) {
			for (const sample of data.samples) {
				const bytes = await this.readSample(sample, data.trackNumber);
				if (bytes) {
					frames.push({
						trackId: data.track.id,
						timestamp: sample.timestamp,
						duration: sample.duration,
						data: bytes,
					});
				}
			}
		}

		return frames;
	}

	async readSample(sample: MxfSample, trackNumber: number): Promise<Uint8Array | null> {
		const resolved = await this.resolveSample(sample, trackNumber);
		if (!resolved) {
			return null;
		}

		const slice = await this.sliceOf(resolved.valueStart, resolved.length);
		if (!slice) {
			return null;
		}

		const bytes = readBytes(slice, resolved.length);
		const data = this.trackDatas.find(entry => entry.trackNumber === trackNumber);
		if (data?.aes3 && data.sound) {
			return unwrapD10Aes3(bytes, data.sound.channelCount, data.sound.quantizationBits);
		}

		return bytes;
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

/**
 * A timed text track file's one document, read as subtitles.
 *
 * ST 2067-5 wraps a whole IMSC document as the essence, so the track has a single sample covering the
 * composition rather than one per cue: the cues' own times are inside the document, which is what
 * `parseTtmlDocument` reads.
 */
class MxfSubtitleTrackBacking extends MxfTrackBacking implements InputSubtitleTrackBacking {
	getType() {
		return 'subtitle' as const;
	}

	private get info(): MxfTimedTextInfo {
		assert(this.data.timedText);
		return this.data.timedText;
	}

	getCodec() {
		// IMSC is TTML; nothing else has been seen in a track file, and the descriptor names a profile
		// rather than a different syntax
		return 'ttml' as const;
	}

	getInternalCodecId() {
		// What the file itself calls the document, which is the profile rather than a codec fourcc
		return this.info.namespaceUri;
	}

	getConfig() {
		return null;
	}

	getDecoderConfig() {
		return Promise.resolve(null);
	}

	override getLanguageCode() {
		// A comma-separated list where the file states more than one; the first is the document's own
		const stated = this.info.languages?.split(',')[0]?.trim();
		return stated && stated.length > 0 ? stated : UNDETERMINED_LANGUAGE;
	}

	decodeCues(packet: EncodedPacket): DecodedSubtitleCue[] {
		return parseTtmlDocument(decodeTimedTextDocument(packet.data, this.info.encoding))
			.map(cue => ({ cue, continuationId: null }));
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
