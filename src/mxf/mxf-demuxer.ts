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
import { AudioCodec, extractVideoCodecString, RAWVIDEO_CODEC_STRING, VideoCodec } from '../codec';
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
/**
 * How many index units one sample should cover.
 *
 * One, except for clip-wrapped sound, where an edit unit is a single audio *sample*: a half-second
 * `pcm-s24` track indexes 22,022 units of three octets each, and handing those back one at a time is
 * correct and useless. The grouping is a reader's choice rather than anything the file states -
 * FFmpeg makes the same one and says so in its own comment, "arbitrarily default to 48 kHz PAL audio
 * frame size" (`mxf_compute_edit_units_per_packet`), with a TODO to derive it instead - so a sample
 * covers about a twenty-fifth of a second, or one index unit, whichever is larger.
 */
const unitsPerSample = (data: MxfTrackData, indexRate: { num: number; den: number }): number => {
	// Clip-wrapped sound only. Frame wrapping's unit is already a frame, and the two conditions are
	// not redundant even though no file here distinguishes them: a 50 fps frame-wrapped video indexes
	// at 50 Hz, and the arithmetic below would group two of its frames into one sample. No fixture
	// has that shape, so these guards are deliberate and unexercised rather than tested.
	if (data.wrapping !== 'clip' || data.track.kind !== 'sound' || indexRate.den <= 0) {
		return 1;
	}

	return Math.max(1, Math.round(indexRate.num / indexRate.den / 25));
};

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
	tags: MetadataTags = {};

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
			const metadata = readHeaderMetadata(sets, setTypes, primer);
			this.tags = {
				raw: metadata.tags,
				creationTime: metadata.modifiedAt,
			};

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

	/**
	 * Where one index entry's essence is, which is the only thing the two wrappings answer
	 * differently.
	 *
	 * Frame wrapping makes an edit unit a whole KLV triplet, so a stream offset counts triplets from
	 * the container's start and the bytes are found by reading the key there. Clip wrapping puts every
	 * unit inside one element's value, so the offset counts bytes from there and there is no key to
	 * read - the index's own entry size is all there is to go on.
	 */
	private essenceRangeOf(
		located: { streamOffset: number; size: number | null },
		wrapping: MxfWrapping,
		runs: MxfEssenceRun[],
		clipElement: { start: number; length: number } | null,
		essenceEnd: number,
		units = 1,
	): { keyPosition: number; resolved: { valueStart: number; length: number } | null } | null {
		if (wrapping === 'clip' && clipElement) {
			const at = clipElement.start + located.streamOffset;
			const remaining = clipElement.start + clipElement.length - at;
			if (at >= essenceEnd || remaining <= 0) {
				return null;
			}

			const wanted = located.size === null ? remaining : located.size * units;
			return {
				keyPosition: at,
				resolved: { valueStart: at, length: Math.min(wanted, remaining) },
			};
		}

		const keyPosition = fileOffsetOf(runs, located.streamOffset);
		if (keyPosition === null || keyPosition >= essenceEnd) {
			return null;
		}

		return { keyPosition, resolved: null };
	}

	/**
	 * The samples of one track, from its index.
	 *
	 * Three rates meet here and only one of them addresses the essence:
	 *
	 * - the **track's** edit rate, which its stated duration is counted in. `duration / rate` is how
	 *   long the programme is, in seconds, and that is the only thing either rate agrees on.
	 * - the **index's** edit rate, which its *positions* advance at. One position is one addressable
	 *   unit of essence, so this is what a sample's timestamp and duration come from. It need not be
	 *   the track's: `C0023S01.mxf` indexes at 1/2 Hz, one entry per 524288-octet content package,
	 *   over a 25 fps track.
	 * - the essence's own frame rate, which nothing here needs.
	 *
	 * So a position is in index units and **everything else is in seconds**. Counting one in the
	 * other is what made that file read as 0.080 s against a stated 3.8.
	 */
	private buildSamples(
		data: MxfTrackData,
		segments: MxfIndexSegment[],
		runs: MxfEssenceRun[],
		editRate: { num: number; den: number },
		essenceEnd: number,
		clipElement: { start: number; length: number } | null,
	) {
		const indexRate = segments[0]?.editRate ?? editRate;
		const trackSeconds = editRate.num > 0 ? editRate.den / editRate.num : 0;
		const unitSeconds = indexRate.num > 0 ? indexRate.den / indexRate.num : trackSeconds;
		const stated = data.track.duration;
		const programmeSeconds = stated !== null && stated > 0 ? stated * trackSeconds : null;
		// `origin` is a count of the TRACK's edit units, so it converts at the track's rate
		const origin = data.track.origin * trackSeconds;
		const ordering = presentationOrder(segments);
		const step = unitsPerSample(data, indexRate);

		// An index that divides nothing addresses nothing: a clip-wrapped track whose index states no
		// constant unit size and carries no entries is one sample - the whole element, lasting the
		// whole programme. An ST 2067-5 timed text file is this, its essence being one IMSC document,
		// and calling it one edit unit long made a four-minute subtitle track 42 ms long.
		if (data.wrapping === 'clip' && clipElement && !hasPerEditUnitOffsets(segments)) {
			data.samples.push({
				timestamp: -origin,
				decodeTimestamp: -origin,
				duration: programmeSeconds ?? unitSeconds,
				keyPosition: clipElement.start,
				isKeyFrame: true,
				resolved: { valueStart: clipElement.start, length: clipElement.length },
			});

			data.byPresentation = [0];
			return;
		}

		// A unit is at least one octet, so the essence cannot hold more units than it has octets.
		// A constant-bit-rate segment states no duration and answers for every position ever asked,
		// so the walk is bounded from out here or not at all.
		for (let position = 0; position < essenceEnd; position += step) {
			const decodeSeconds = position * unitSeconds;
			if (programmeSeconds !== null && decodeSeconds >= programmeSeconds) {
				break;
			}

			const located = locateEditUnit(segments, position);
			if (!located) {
				break;
			}

			const range = this.essenceRangeOf(located, data.wrapping, runs, clipElement, essenceEnd, step);
			if (!range) {
				break;
			}

			data.samples.push({
				timestamp: (ordering.get(position) ?? position) * unitSeconds - origin,
				decodeTimestamp: decodeSeconds - origin,
				// The last unit may be short - 2 s then 1.8 s over a 3.8 s programme - so the samples
				// together last exactly as long as the track says it does
				duration: programmeSeconds === null
					? unitSeconds * step
					: Math.min(unitSeconds * step, programmeSeconds - decodeSeconds),
				keyPosition: range.keyPosition,
				isKeyFrame: located.isKeyFrame,
				resolved: range.resolved,
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
		const rawFrameBytes = data?.picture?.rawFrameBytes ?? null;
		if (rawFrameBytes !== null && bytes.byteLength > rawFrameBytes) {
			// The element is padded up to the container's alignment grid; a frame is its leading octets
			return bytes.subarray(0, rawFrameBytes);
		}

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
		return this.tags;
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

		if (codec === 'rawvideo') {
			assert(this.info.internalId !== null);

			// Uncompressed frames carry nothing that says what they are, so the Y4M-style colour space
			// tag rides in the description, exactly as the Y4M reader states it
			return {
				codec: RAWVIDEO_CODEC_STRING,
				codedWidth: this.info.codedWidth,
				codedHeight: this.info.codedHeight,
				description: new TextEncoder().encode(this.info.internalId),
			};
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
