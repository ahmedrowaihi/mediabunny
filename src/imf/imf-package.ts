/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// An IMF package - an IMP - is not a file. It is a directory of MXF track files plus three XML
// documents that say what they are and how to play them, and nothing in the MXF files themselves
// states the composition:
//
//   ASSETMAP  maps an asset's UUID to the file on disk that holds it.
//   PKL       says what each asset is - its type, size and hash - so a package can be checked whole.
//   CPL       is the timeline: segments in series, each holding sequences that run in parallel, each
//             sequence a series of resources that cut pieces out of the track files.
//
// A resource is a *cut*, not a file: `EntryPoint` and `SourceDuration` take a span out of a track
// file whose own length is `IntrinsicDuration`, and `RepeatCount` lays that span down more than once.
// Resolving a CPL means turning those into placements on one timeline, which is what this does. Every
// duration here is in the composition's own edit units; `editRate` converts to seconds, and it is
// stated as two integers because 24000/1001 is not 23.976.

import { MalformedInputError } from '../errors';
import { MinimalDomParser, XmlElement } from '../dash/dash-xml-dom-parser';

/**
 * An `urn:uuid:` identifier with the scheme taken off, lowercased - how IMF names everything.
 *
 * @public
 * @group Input formats
 */
export type ImfUuid = string;

/**
 * One asset as the ASSETMAP locates it.
 *
 * @public
 * @group Input formats
 */
export type ImfAssetMapEntry = {
	/** The asset's UUID, with `urn:uuid:` taken off and lowercased. */
	id: ImfUuid;
	/** Path relative to the package directory, from the asset's first chunk. */
	path: string;
	/** Octets, where the ASSETMAP states a length; IMF allows it to be absent. */
	length: number | null;
};

/**
 * One asset as the packing list describes it.
 *
 * @public
 * @group Input formats
 */
export type ImfPackingListEntry = {
	/** The asset's UUID, with `urn:uuid:` taken off and lowercased. */
	id: ImfUuid;
	/** MIME type, `application/mxf` for a track file. */
	type: string;
	/** Octets, where the packing list states a size. */
	size: number | null;
	/** Base64 of the asset's hash, which is what checking a package whole comes down to. */
	hash: string | null;
	/** The name the asset had when it was delivered, which need not be its path. */
	originalFileName: string | null;
};

/**
 * One cut from one track file, placed on the composition's timeline.
 *
 * @public
 * @group Input formats
 */
export type ImfResource = {
	/** The resource's own UUID. */
	id: ImfUuid;
	/** The track file this cuts from, or null for a resource that is not a track file. */
	trackFileId: ImfUuid | null;
	/** The track file's own length in edit units. */
	intrinsicDuration: number;
	/** Where the cut starts inside the track file. Defaults to 0. */
	entryPoint: number;
	/** How much of it is used. Defaults to everything after the entry point. */
	sourceDuration: number;
	/** How many times the cut is laid down. Defaults to 1. */
	repeatCount: number;
	/** Where this resource starts on the composition timeline, in edit units. */
	timelineStart: number;
	/** `sourceDuration * repeatCount`, which is what it occupies on the timeline. */
	timelineDuration: number;
};

/**
 * The kinds of sequence this understands; anything else is carried through under its own element name.
 *
 * @public
 * @group Input formats
 */
export type ImfSequenceKind = 'image' | 'audio' | 'subtitles' | 'marker' | 'other';

/**
 * One virtual track of the composition: the same `trackId` across every segment, in order.
 *
 * @public
 * @group Input formats
 */
export type ImfVirtualTrack = {
	/** The `TrackId` every segment's sequence for this track repeats. */
	trackId: ImfUuid;
	/** What kind of essence it carries. */
	kind: ImfSequenceKind;
	/** The element name the CPL used, kept because IMF keeps adding sequence kinds. */
	sequenceElement: string;
	/** Every cut on this track, in timeline order across all segments. */
	resources: ImfResource[];
	/** The track's whole length in edit units. */
	duration: number;
};

/**
 * A parsed composition playlist.
 *
 * @public
 * @group Input formats
 */
export type ImfComposition = {
	/** The composition's UUID. */
	id: ImfUuid;
	/** The title the CPL states, or null. */
	annotation: string | null;
	/** `ContentTitleText`, the title of the work, or null. */
	contentTitle: string | null;
	/** Edit units per second, as two integers - 24000/1001 rather than 23.976. */
	editRate: {
		/** Edit units. */
		numerator: number;
		/** Seconds they span. */
		denominator: number;
	};
	/** The composition's virtual tracks, in the order the CPL first names them. */
	tracks: ImfVirtualTrack[];
	/** The composition's length in edit units, which is the longest of its tracks. */
	duration: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Takes the `urn:uuid:` off and lowercases, which is how two IMF documents refer to one thing. */
const readUuid = (raw: string | null, what: string): ImfUuid => {
	if (raw === null) {
		throw new MalformedInputError(`IMF: ${what} is missing.`);
	}

	const value = raw.trim().toLowerCase().replace(/^urn:uuid:/, '');
	if (!UUID_PATTERN.test(value)) {
		throw new MalformedInputError(`IMF: ${what} is '${raw.trim()}', which is not a UUID.`);
	}

	return value;
};

const firstChildText = (element: XmlElement, name: string): string | null => {
	const match = element.children.find(child => child.localName === name);
	return match ? match.textContent.trim() : null;
};

const readInteger = (element: XmlElement, name: string, fallback: number | null): number => {
	const raw = firstChildText(element, name);
	if (raw === null || raw === '') {
		if (fallback === null) {
			throw new MalformedInputError(`IMF: <${name}> is missing and has no default.`);
		}
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new MalformedInputError(`IMF: <${name}> is '${raw}', which is not a non-negative integer.`);
	}

	return value;
};

const parseDocument = (xml: string, expectedRoot: string): XmlElement => {
	const root = new MinimalDomParser().parseFromString(xml).documentElement;
	if (root.localName !== expectedRoot) {
		throw new MalformedInputError(
			`IMF: expected a <${expectedRoot}> document, got <${root.localName}>.`,
		);
	}
	return root;
};

/**
 * Reads an ASSETMAP, which is the only thing that says where an asset's bytes are: every other
 * document refers to assets by UUID alone.
 *
 * @public
 * @group Input formats
 */
export const parseAssetMap = (xml: string): Map<ImfUuid, ImfAssetMapEntry> => {
	const root = parseDocument(xml, 'AssetMap');
	const entries = new Map<ImfUuid, ImfAssetMapEntry>();

	for (const asset of root.getElementsByTagName('Asset')) {
		const id = readUuid(firstChildText(asset, 'Id'), 'an ASSETMAP <Asset><Id>');

		// Chunked assets are legal and almost never used; the first chunk is the file either way, and a
		// package that splits one across volumes is refused rather than half-read
		const chunks = asset.getElementsByTagName('Chunk');
		if (chunks.length === 0) {
			throw new MalformedInputError(`IMF: asset ${id} has no <Chunk> in the ASSETMAP.`);
		}
		if (chunks.length > 1) {
			throw new MalformedInputError(
				`IMF: asset ${id} is split into ${chunks.length} chunks, which this does not join.`,
			);
		}

		const path = firstChildText(chunks[0]!, 'Path');
		if (path === null || path === '') {
			throw new MalformedInputError(`IMF: asset ${id} has no <Path> in the ASSETMAP.`);
		}

		const lengthText = firstChildText(chunks[0]!, 'Length');
		entries.set(id, { id, path, length: lengthText === null ? null : Number(lengthText) });
	}

	if (entries.size === 0) {
		throw new MalformedInputError('IMF: the ASSETMAP lists no assets.');
	}

	return entries;
};

/**
 * Reads a packing list, which says what each asset is and what it should hash to.
 *
 * @public
 * @group Input formats
 */
export const parsePackingList = (xml: string): Map<ImfUuid, ImfPackingListEntry> => {
	const root = parseDocument(xml, 'PackingList');
	const entries = new Map<ImfUuid, ImfPackingListEntry>();

	for (const asset of root.getElementsByTagName('Asset')) {
		const id = readUuid(firstChildText(asset, 'Id'), 'a PKL <Asset><Id>');
		const size = firstChildText(asset, 'Size');
		entries.set(id, {
			id,
			type: firstChildText(asset, 'Type') ?? 'application/octet-stream',
			size: size === null ? null : Number(size),
			hash: firstChildText(asset, 'Hash'),
			originalFileName: firstChildText(asset, 'OriginalFileName'),
		});
	}

	return entries;
};

/** `<EditRate>24000 1001</EditRate>` - two integers, space separated, not a decimal. */
const readEditRate = (root: XmlElement): { numerator: number; denominator: number } => {
	const raw = firstChildText(root, 'EditRate');
	if (raw === null) {
		throw new MalformedInputError('IMF: the CPL states no <EditRate>.');
	}

	const parts = raw.split(/\s+/).filter(part => part !== '');
	const numerator = Number(parts[0]);
	const denominator = parts.length > 1 ? Number(parts[1]) : 1;

	if (
		parts.length > 2
		|| !Number.isInteger(numerator) || numerator <= 0
		|| !Number.isInteger(denominator) || denominator <= 0
	) {
		throw new MalformedInputError(
			`IMF: <EditRate> is '${raw}'; it has to be two positive integers, so 24000 1001 rather`
			+ ' than 23.976.',
		);
	}

	return { numerator, denominator };
};

const SEQUENCE_KINDS: { suffix: string; kind: ImfSequenceKind }[] = [
	{ suffix: 'MainImageSequence', kind: 'image' },
	{ suffix: 'MainAudioSequence', kind: 'audio' },
	{ suffix: 'SubtitlesSequence', kind: 'subtitles' },
	{ suffix: 'MarkerSequence', kind: 'marker' },
];

const kindOfSequence = (localName: string): ImfSequenceKind =>
	SEQUENCE_KINDS.find(entry => entry.suffix === localName)?.kind ?? 'other';

/**
 * Reads a composition playlist and lays its resources out on one timeline.
 *
 * Segments run in series and the sequences inside one run in parallel, so a virtual track's resources
 * are its resources from every segment, in segment order. A track that is short in some segment leaves
 * a hole rather than pulling the next segment earlier: the segment's length is its longest sequence,
 * which is what keeps image and audio aligned across a cut.
 *
 * @public
 * @group Input formats
 */
export const parseCompositionPlaylist = (xml: string): ImfComposition => {
	const root = parseDocument(xml, 'CompositionPlaylist');
	const id = readUuid(firstChildText(root, 'Id'), 'the CPL <Id>');
	const editRate = readEditRate(root);

	const tracks = new Map<ImfUuid, ImfVirtualTrack>();
	let segmentStart = 0;

	const segments = root.getElementsByTagName('Segment');
	if (segments.length === 0) {
		throw new MalformedInputError('IMF: the CPL has no <Segment>.');
	}

	for (const segment of segments) {
		let segmentDuration = 0;

		const sequenceList = segment.children.find(child => child.localName === 'SequenceList');
		for (const sequence of sequenceList ? sequenceList.children : []) {
			const trackId = readUuid(firstChildText(sequence, 'TrackId'), 'a <TrackId>');
			const kind = kindOfSequence(sequence.localName);

			let track = tracks.get(trackId);
			if (!track) {
				track = {
					trackId,
					kind,
					sequenceElement: sequence.localName,
					resources: [],
					duration: 0,
				};
				tracks.set(trackId, track);
			}

			// Resources run in series inside a sequence, each starting where the last ended
			let at = segmentStart;
			const resourceList = sequence.children.find(child => child.localName === 'ResourceList');
			for (const resource of resourceList ? resourceList.getElementsByTagName('Resource') : []) {
				const resourceId = readUuid(firstChildText(resource, 'Id'), 'a <Resource><Id>');
				const intrinsicDuration = readInteger(resource, 'IntrinsicDuration', null);
				const entryPoint = readInteger(resource, 'EntryPoint', 0);
				const sourceDuration = readInteger(
					resource,
					'SourceDuration',
					intrinsicDuration - entryPoint,
				);
				const repeatCount = readInteger(resource, 'RepeatCount', 1);

				if (entryPoint + sourceDuration > intrinsicDuration) {
					throw new MalformedInputError(
						`IMF: resource ${resourceId} reads ${sourceDuration} edit units from ${entryPoint}`
						+ ` of a track file that is only ${intrinsicDuration} long.`,
					);
				}

				const trackFileIdRaw = firstChildText(resource, 'TrackFileId');
				const timelineDuration = sourceDuration * repeatCount;

				track.resources.push({
					id: resourceId,
					trackFileId: trackFileIdRaw === null
						? null
						: readUuid(trackFileIdRaw, `resource ${resourceId}'s <TrackFileId>`),
					intrinsicDuration,
					entryPoint,
					sourceDuration,
					repeatCount,
					timelineStart: at,
					timelineDuration,
				});

				at += timelineDuration;
			}

			track.duration = at;
			segmentDuration = Math.max(segmentDuration, at - segmentStart);
		}

		segmentStart += segmentDuration;
	}

	const trackList = [...tracks.values()];
	return {
		id,
		annotation: firstChildText(root, 'Annotation'),
		contentTitle: firstChildText(root, 'ContentTitleText'),
		editRate,
		tracks: trackList,
		duration: trackList.reduce((longest, track) => Math.max(longest, track.duration), 0),
	};
};

/**
 * A composition with every resource's track file resolved to a path in the package.
 *
 * @public
 * @group Input formats
 */
export type ImfResolvedPackage = {
	/** The parsed composition. */
	composition: ImfComposition;
	/** The file each track file UUID lives in, relative to the package directory. */
	paths: Map<ImfUuid, string>;
	/** Every asset the ASSETMAP locates, by UUID. */
	assets: Map<ImfUuid, ImfAssetMapEntry>;
	/** Every asset the packing list describes, by UUID; empty when none was given. */
	packingList: Map<ImfUuid, ImfPackingListEntry>;
};

/**
 * Ties the three documents together: every track file the CPL names has to be in the ASSETMAP, or the
 * package is incomplete and says which asset is missing rather than failing later on a file open.
 *
 * The packing list is optional here. It is what a package is *verified* with - sizes and hashes - and
 * a composition plays without it; where it is given, a track file it does not list is reported, since
 * that is a package assembled from two different deliveries.
 *
 * @public
 * @group Input formats
 */
export const resolveImfPackage = (options: {
	/** The CPL's XML. */
	compositionPlaylist: string;
	/** The ASSETMAP's XML. */
	assetMap: string;
	/** The PKL's XML, where the package is being checked whole. */
	packingList?: string;
}): ImfResolvedPackage => {
	const composition = parseCompositionPlaylist(options.compositionPlaylist);
	const assets = parseAssetMap(options.assetMap);
	const packingList: Map<ImfUuid, ImfPackingListEntry> = options.packingList
		? parsePackingList(options.packingList)
		: new Map<ImfUuid, ImfPackingListEntry>();

	const paths = new Map<ImfUuid, string>();
	const missing: ImfUuid[] = [];
	const unlisted: ImfUuid[] = [];

	for (const track of composition.tracks) {
		for (const resource of track.resources) {
			if (resource.trackFileId === null || paths.has(resource.trackFileId)) {
				continue;
			}

			const asset = assets.get(resource.trackFileId);
			if (!asset) {
				missing.push(resource.trackFileId);
				continue;
			}
			if (options.packingList && !packingList.has(resource.trackFileId)) {
				unlisted.push(resource.trackFileId);
			}

			paths.set(resource.trackFileId, asset.path);
		}
	}

	if (missing.length > 0) {
		throw new MalformedInputError(
			`IMF: the composition names ${missing.length} track file(s) the ASSETMAP does not locate:`
			+ ` ${missing.join(', ')}.`,
		);
	}
	if (unlisted.length > 0) {
		throw new MalformedInputError(
			`IMF: the packing list does not cover ${unlisted.length} track file(s) the composition uses:`
			+ ` ${unlisted.join(', ')}. The package was assembled from more than one delivery.`,
		);
	}

	return { composition, paths, assets, packingList };
};

/**
 * Seconds a count of edit units comes to, which is what the edit rate is for.
 *
 * @public
 * @group Input formats
 */
export const editUnitsToSeconds = (
	editUnits: number,
	editRate: {
		/** Edit units. */
		numerator: number;
		/** Seconds they span. */
		denominator: number;
	},
) => editUnits * editRate.denominator / editRate.numerator;
