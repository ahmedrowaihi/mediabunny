/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Playing an IMF composition is an edit-list problem, not a segment one. HLS and DASH hand a player a
// file per segment and the file holds exactly that segment; an IMF resource instead cuts a span out of
// the middle of a track file that may be hours long, and the same file may be cut several times over
// at different points. So this does not sit on `SegmentedInput` - it maps composition time to (resource,
// time in file) itself and clamps every read to the cut.
//
// Two translations run in opposite directions and have to stay exact inverses of each other:
//
//   composition time -> file time:  entryPoint + ((t - timelineStart) mod sourceDuration)
//   file time -> composition time:  timelineStart + cycle*sourceDuration + (packetTime - entryPoint)
//
// `mod` because `RepeatCount` lays the same span down more than once, so one stretch of composition
// time maps back into the same stretch of file over and over.

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrack,
	InputTrackBacking,
	InputVideoTrack,
} from '../input-track';
import { TransformationMatrix } from '../misc';
import { MediaCodec } from '../codec';
import { EncodedPacket } from '../packet';
import { PacketRetrievalOptions } from '../media-sink';
import { MetadataTags } from '../metadata';
import { TrackDisposition } from '../metadata';
import { TrackType } from '../output';
import { assert, joinPaths } from '../misc';
import { MalformedInputError } from '../errors';
import { Reader } from '../reader';
import { CustomPathedSource, PathedSource } from '../source';
import {
	editUnitsToSeconds,
	ImfComposition,
	ImfResource,
	ImfVirtualTrack,
	resolveImfPackage,
} from './imf-package';

/** One resource with its track file opened and its times in seconds. */
type PlacedResource = {
	resource: ImfResource;
	/** Composition seconds this cut begins at. */
	start: number;
	/** Composition seconds it occupies, repeats included. */
	duration: number;
	/** Seconds into the track file the cut begins at. */
	fileStart: number;
	/** Seconds of the track file each repeat uses. */
	fileDuration: number;
};

const EPSILON = 1e-9;

/** The names ST 429-9 gives the map file; IMF writes the first and DCP-derived tooling the second. */
const ASSET_MAP_NAMES = ['ASSETMAP.xml', 'ASSETMAP'];

export class ImfDemuxer extends Demuxer {
	/** @internal */
	private loadPromise: Promise<{ composition: ImfComposition; paths: Map<string, string> }> | null = null;
	/** @internal */
	private backings: ImfTrackBacking[] | null = null;
	/** @internal */
	private readonly inputs = new Map<string, Promise<Input>>();

	/**
	 * Reads the CPL this input points at, then the ASSETMAP beside it. The packing list is not read
	 * here: it is what a package is *verified* with, and a composition plays without it.
	 *
	 * @internal
	 */
	private load() {
		return this.loadPromise ??= (async () => {
			assert(this.input._rootSource instanceof PathedSource);

			const slice = await this.input._reader.requestEntireFile();
			assert(slice);
			const decoder = new TextDecoder('utf-8');
			const cplXml = decoder.decode(slice.bytes.subarray(slice.start, slice.end));

			let assetMapXml: string | null = null;
			const tried: string[] = [];
			for (const name of ASSET_MAP_NAMES) {
				const text = await this.readSibling(name);
				if (text !== null) {
					assetMapXml = text;
					break;
				}
				tried.push(name);
			}

			if (assetMapXml === null) {
				throw new MalformedInputError(
					`IMF: no ASSETMAP beside this composition playlist (tried ${tried.join(', ')}). The CPL`
					+ ' names its track files by UUID alone, so without it there is nothing to open.',
				);
			}

			const resolved = resolveImfPackage({ compositionPlaylist: cplXml, assetMap: assetMapXml });
			return { composition: resolved.composition, paths: resolved.paths };
		})();
	}

	/** @internal */
	private async readSibling(name: string): Promise<string | null> {
		assert(this.input._rootSource instanceof PathedSource);
		// Against the CPL's own location: a PathedSource passes the path through verbatim, so a bare
		// name would be resolved against the working directory instead of the package
		const path = joinPaths(this.input._rootSource.rootPath, name);

		let ref;
		try {
			ref = await this.input._getSourceCached({ path, isRoot: false });
		} catch {
			return null;
		}

		try {
			const reader = new Reader(ref.source);
			const slice = await reader.requestEntireFile();
			if (!slice) {
				return null;
			}
			return new TextDecoder('utf-8').decode(slice.bytes.subarray(slice.start, slice.end));
		} catch {
			return null;
		} finally {
			ref.free();
		}
	}

	/** @internal */
	private openTrackFile = async (trackFileId: string): Promise<Input> => {
		const { paths } = await this.load();
		const path = paths.get(trackFileId);
		assert(path !== undefined);
		assert(this.input._rootSource instanceof PathedSource);
		const { rootPath } = this.input._rootSource;

		return new Input({
			source: new CustomPathedSource(joinPaths(rootPath, path), async (request) => {
				assert(request.isRoot);
				return this.input._getSourceCached({ ...request, isRoot: false });
			}),
			formats: this.input._formats,
		});
	};

	/** One Input per track file, however many resources cut from it. */
	private inputFor(trackFileId: string): Promise<Input> {
		let existing = this.inputs.get(trackFileId);
		if (!existing) {
			existing = Promise.resolve(this.openTrackFile(trackFileId));
			this.inputs.set(trackFileId, existing);
		}
		return existing;
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		if (this.backings) {
			return this.backings;
		}

		const { composition } = await this.load();
		const backings: ImfTrackBacking[] = [];
		let number = 1;

		for (const track of composition.tracks) {
			if (track.kind !== 'image' && track.kind !== 'audio') {
				continue; // markers and subtitles are not media tracks here
			}

			const placed: PlacedResource[] = [];
			for (const resource of track.resources) {
				if (resource.trackFileId === null) {
					continue;
				}

				// entryPoint and sourceDuration are in the RESOURCE's edit units; timelineStart and
				// timelineDuration are already in the composition's. Converting all four with the
				// composition's rate makes a 48 kHz audio resource read as 1920 times its length.
				const fileDuration = editUnitsToSeconds(resource.sourceDuration, resource.editRate);
				placed.push({
					resource,
					start: editUnitsToSeconds(resource.timelineStart, composition.editRate),
					duration: editUnitsToSeconds(resource.timelineDuration, composition.editRate),
					fileStart: editUnitsToSeconds(resource.entryPoint, resource.editRate),
					fileDuration,
				});
			}

			if (placed.length === 0) {
				continue;
			}

			backings.push(new ImfTrackBacking(
				track,
				placed,
				number++,
				id => this.inputFor(id),
			));
		}

		this.backings = backings;
		return backings;
	}

	async getMimeType(): Promise<string> {
		return 'application/mxf';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		const { composition } = await this.load();
		const tags: MetadataTags = {};
		if (composition.contentTitle !== null) {
			tags.title = composition.contentTitle;
		}
		if (composition.annotation !== null) {
			tags.description = composition.annotation;
		}
		return tags;
	}
}

/**
 * One virtual track of the composition, reading through however many track files its resources cut
 * from. Everything that describes the track - its codec, its configuration - comes from the first
 * resource: a composition whose resources disagree about that is not playable as one track, and IMF
 * requires them to match.
 */
// Declared against InputTrackBacking alone, and carrying the video and audio members besides. It
// cannot `implements` both: getType must be 'video' for one and 'audio' for the other. Which set is
// live is decided by the composition's sequence kind, and getTrackBackings is what pairs them up.
export class ImfTrackBacking implements InputTrackBacking {
	/** @internal */
	private readonly track: ImfVirtualTrack;
	/** @internal */
	private readonly placed: PlacedResource[];
	/** @internal */
	private readonly number: number;
	/** @internal */
	private readonly inputFor: (trackFileId: string) => Promise<Input>;

	constructor(
		track: ImfVirtualTrack,
		placed: PlacedResource[],
		number: number,
		inputFor: (trackFileId: string) => Promise<Input>,
	) {
		this.track = track;
		this.placed = placed;
		this.number = number;
		this.inputFor = inputFor;
	}

	/** The underlying track of one resource's file, matched by type. */
	async trackOf(placed: PlacedResource) {
		assert(placed.resource.trackFileId !== null);
		const input = await this.inputFor(placed.resource.trackFileId);
		const tracks = await input.getTracks();
		const wanted = this.getType();
		const match = tracks.find(track => track.type === wanted);
		if (!match) {
			throw new Error(
				`IMF: track file ${placed.resource.trackFileId} carries no ${wanted} track, which the`
				+ ' composition says it does.',
			);
		}
		return match;
	}

	/** The first resource, which is where everything describing the track comes from. */
	private async firstTrack() {
		return this.trackOf(this.placed[0]!);
	}

	/**
	 * Which cut a composition time falls in, and where in its file that is.
	 *
	 * A time past the end lands on the last cut rather than nowhere: `getPacket` is asked for the packet
	 * at or before a time, and callers seek to `Infinity` to find the end of a track - which is how the
	 * duration is computed. Returning null there reports a track of no length.
	 */
	private locate(timestamp: number) {
		const last = this.placed[this.placed.length - 1]!;
		if (timestamp >= last.start + last.duration - EPSILON) {
			return {
				placed: last,
				cycle: last.resource.repeatCount - 1,
				// Just inside the cut, not at its end: the end is where the NEXT packet begins, and
				// asking for that one gets a packet this composition does not contain
				fileTime: last.fileStart + last.fileDuration - EPSILON,
			};
		}

		for (const [index, placed] of this.placed.entries()) {
			if (timestamp < placed.start - EPSILON) {
				// A hole: this track ran out before the segment did, and the next cut has not begun.
				// `getPacket` is asked for the packet at or BEFORE a time, so that is the last packet of
				// the cut before the hole - not the first of the one after it, which is still to come.
				const previous = this.placed[index - 1];
				if (!previous) {
					return { placed, cycle: 0, fileTime: placed.fileStart };
				}
				return {
					placed: previous,
					cycle: previous.resource.repeatCount - 1,
					fileTime: previous.fileStart + previous.fileDuration - EPSILON,
				};
			}
			if (timestamp < placed.start + placed.duration - EPSILON) {
				const into = Math.max(0, timestamp - placed.start);
				const cycle = placed.fileDuration > 0
					? Math.min(
							placed.resource.repeatCount - 1,
							Math.floor(into / placed.fileDuration),
						)
					: 0;
				const withinCycle = into - cycle * placed.fileDuration;
				return { placed, cycle, fileTime: placed.fileStart + withinCycle };
			}
		}

		return null;
	}

	/** Moves a packet from a resource's file timeline onto the composition's. */
	private shift(packet: EncodedPacket, placed: PlacedResource, cycle: number) {
		const timestamp = placed.start
			+ cycle * placed.fileDuration
			+ (packet.timestamp - placed.fileStart);

		// A packet may run past the cut; the composition only has room for what is left of it
		const remaining = placed.start + placed.duration - timestamp;
		return packet.clone({ timestamp, duration: Math.max(0, Math.min(packet.duration, remaining)) });
	}

	/** Whether a packet from the file falls inside this cut at all. */
	private insideCut(packet: EncodedPacket, placed: PlacedResource) {
		return packet.timestamp < placed.fileStart + placed.fileDuration - EPSILON
			&& packet.timestamp >= placed.fileStart - EPSILON;
	}

	/**
	 * Whether a packet carries any of the cut at all, which is not the same as starting inside it.
	 *
	 * An entry point lands on a frame boundary for picture, so a video cut's first packet begins
	 * exactly where the cut does. Sound has no such alignment: a cut at 1 s of 48 kHz audio falls in
	 * the middle of whatever packet was being written then, and that packet carries the first samples
	 * the composition needs. Requiring the packet to *begin* inside the cut discards them - and since
	 * `getPacket` is at-or-before, the lookup then has nothing to fall back to and the track reads as
	 * empty.
	 *
	 * @internal
	 */
	private overlapsCut(packet: EncodedPacket, placed: PlacedResource) {
		return packet.timestamp + packet.duration > placed.fileStart + EPSILON
			&& packet.timestamp < placed.fileStart + placed.fileDuration - EPSILON;
	}

	/** The next (resource, cycle) after this one, or null at the end of the track. */
	private advance(placed: PlacedResource, cycle: number) {
		if (cycle + 1 < placed.resource.repeatCount) {
			return { placed, cycle: cycle + 1 };
		}
		const index = this.placed.indexOf(placed);
		const next = this.placed[index + 1];
		return next ? { placed: next, cycle: 0 } : null;
	}

	getType(): TrackType {
		return this.track.kind === 'image' ? 'video' : 'audio';
	}

	getNumber() {
		return this.number;
	}

	getPairingMask() {
		return 0n;
	}

	async getCodec(): Promise<MediaCodec | null> {
		return (await this.firstTrack()).getCodec();
	}

	// A composition's tracks are read as video and audio tracks, so this backing has to satisfy those
	// interfaces too - without them an `InputVideoTrack` built on it throws on the first thing anyone
	// asks it, `getDisplayWidth`, because that reaches `getTransformationMatrix`. Everything here
	// describes the ESSENCE rather than the composition, so it comes from the first resource's track;
	// a composition whose resources disagree about raster or channel count is not conformant.

	async getCodedWidth(): Promise<number> {
		return (await this.videoTrack()).getCodedWidth();
	}

	async getCodedHeight(): Promise<number> {
		return (await this.videoTrack()).getCodedHeight();
	}

	async getSquarePixelWidth(): Promise<number> {
		return (await this.videoTrack())._backing.getSquarePixelWidth();
	}

	async getSquarePixelHeight(): Promise<number> {
		return (await this.videoTrack())._backing.getSquarePixelHeight();
	}

	async getMetadataDisplayWidth(): Promise<number | null> {
		const backing = (await this.videoTrack())._backing;
		return backing.getMetadataDisplayWidth ? backing.getMetadataDisplayWidth() : null;
	}

	async getMetadataDisplayHeight(): Promise<number | null> {
		const backing = (await this.videoTrack())._backing;
		return backing.getMetadataDisplayHeight ? backing.getMetadataDisplayHeight() : null;
	}

	async getTransformationMatrix(): Promise<TransformationMatrix> {
		return (await this.videoTrack())._backing.getTransformationMatrix();
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return (await this.videoTrack())._backing.getColorSpace();
	}

	async canBeTransparent(): Promise<boolean> {
		return (await this.videoTrack())._backing.canBeTransparent();
	}

	async getNumberOfChannels(): Promise<number> {
		return (await this.audioTrack()).getNumberOfChannels();
	}

	async getSampleRate(): Promise<number> {
		return (await this.audioTrack()).getSampleRate();
	}

	/** @internal */
	private async videoTrack(): Promise<InputVideoTrack> {
		const track = await this.firstTrack();
		if (!track.isVideoTrack()) {
			throw new Error(`IMF: ${this.track.kind} track ${this.number} is not a video track.`);
		}
		return track;
	}

	/** @internal */
	private async audioTrack(): Promise<InputAudioTrack> {
		const track = await this.firstTrack();
		if (!track.isAudioTrack()) {
			throw new Error(`IMF: ${this.track.kind} track ${this.number} is not an audio track.`);
		}
		return track;
	}

	async getInternalCodecId() {
		return (await this.firstTrack())._backing.getInternalCodecId();
	}

	async getName() {
		return (await this.firstTrack())._backing.getName();
	}

	async getLanguageCode() {
		return (await this.firstTrack())._backing.getLanguageCode();
	}

	async getTimeResolution() {
		return (await this.firstTrack())._backing.getTimeResolution();
	}

	async isRelativeToUnixEpoch() {
		return false;
	}

	async getUnixTimeForTimestamp() {
		return null;
	}

	async getDisposition(): Promise<TrackDisposition> {
		return (await this.firstTrack())._backing.getDisposition();
	}

	async getBitrate() {
		return (await this.firstTrack())._backing.getBitrate();
	}

	async getAverageBitrate() {
		return (await this.firstTrack())._backing.getAverageBitrate();
	}

	/** The composition states the duration; the track files are longer than what is used. */
	async getDurationFromMetadata() {
		const last = this.placed[this.placed.length - 1]!;
		return last.start + last.duration;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	async getDecoderConfig() {
		return (await this.firstTrack())._backing.getDecoderConfig();
	}

	async getEncryptionInfo() {
		return (await this.firstTrack())._backing.getEncryptionInfo();
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.getPacket(0, options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const found = this.locate(timestamp);
		if (!found) {
			return null;
		}

		const track = await this.trackOf(found.placed);
		const packet = await track._backing.getPacket(found.fileTime, options);
		const inside = packet && this.insideCut(packet, found.placed);
		if (!inside) {
			const fallback = await this.startOfCut(track, found.placed, options, false);
			return fallback && this.shift(fallback, found.placed, found.cycle);
		}

		return this.shift(packet, found.placed, found.cycle);
	}

	/**
	 * The cut's own first packet, for a lookup that landed before the cut begins - which happens when
	 * the cut starts partway through a packet, since the file's packet at that time began earlier.
	 *
	 * There is no matching case at the other end: `locate` never points at a cut's exclusive end, so a
	 * lookup cannot land past it.
	 *
	 * @internal
	 */
	private async startOfCut(
		track: Awaited<ReturnType<ImfTrackBacking['trackOf']>>,
		placed: PlacedResource,
		options: PacketRetrievalOptions,
		keyOnly: boolean,
	): Promise<EncodedPacket | null> {
		const edge = keyOnly
			? await track._backing.getKeyPacket(placed.fileStart, options)
			: await track._backing.getPacket(placed.fileStart, options);

		// Overlap, not containment: this is the straddling packet, and asking whether it starts inside
		// the cut would reject the very packet this fallback exists to find
		return edge && this.overlapsCut(edge, placed) ? edge : null;
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const found = this.locate(timestamp);
		if (!found) {
			return null;
		}

		const track = await this.trackOf(found.placed);
		const packet = await track._backing.getKeyPacket(found.fileTime, options);

		// A key frame before the cut cannot be used: it is not in the composition. The cut's own first
		// packet is where a decoder has to start, which is why IMF asks for resources to begin on one.
		if (!packet || !this.insideCut(packet, found.placed)) {
			const edge = await this.startOfCut(track, found.placed, options, true);
			return edge && this.shift(edge, found.placed, found.cycle);
		}

		return this.shift(packet, found.placed, found.cycle);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.step(packet, options, false);
	}

	async getNextKeyPacket(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		return this.step(packet, options, true);
	}

	/**
	 * Walks one packet forward, crossing into the next repeat or the next resource when the cut ends.
	 * The packet handed in carries composition time, so where it came from is found by locating it
	 * again rather than remembered - a caller may hand back any packet it still holds.
	 */
	private async step(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
		keyOnly: boolean,
	): Promise<EncodedPacket | null> {
		const found = this.locate(packet.timestamp);
		if (!found) {
			return null;
		}

		const track = await this.trackOf(found.placed);
		const inFile = packet.clone({
			timestamp: found.placed.fileStart
				+ (packet.timestamp - found.placed.start - found.cycle * found.placed.fileDuration),
		});

		const next = keyOnly
			? await track._backing.getNextKeyPacket(inFile, options)
			: await track._backing.getNextPacket(inFile, options);

		if (next && this.insideCut(next, found.placed)) {
			return this.shift(next, found.placed, found.cycle);
		}

		// The cut ended. Carry on at the start of whatever comes after it.
		const after = this.advance(found.placed, found.cycle);
		if (!after) {
			return null;
		}

		const nextTrack = await this.trackOf(after.placed);
		const first = keyOnly
			? await nextTrack._backing.getKeyPacket(after.placed.fileStart, options)
			: await nextTrack._backing.getPacket(after.placed.fileStart, options);
		if (!first || !this.insideCut(first, after.placed)) {
			return null;
		}

		return this.shift(first, after.placed, after.cycle);
	}
}
