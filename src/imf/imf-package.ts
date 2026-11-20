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
import { Sha1, bytesToBase64 } from './imf-sha1';
import { Source } from '../source';
import { MaybePromise } from '../misc';

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
	/**
	 * The `Algorithm` URI of `<HashAlgorithm>`, where the packing list states one. Absent means
	 * SHA-1, which is the only algorithm the format has ever used.
	 */
	hashAlgorithm: string | null;
	/** The name the asset had when it was delivered, which need not be its path. */
	originalFileName: string | null;
};

/**
 * One marker on a marker sequence's resource.
 *
 * @public
 * @group Input formats
 */
export type ImfMarker = {
	/** The label, e.g. `FFOA` or `LFOC`. */
	label: string;
	/** The `scope` the label is defined in, where the CPL states one. */
	scope: string | null;
	/** Free text, where the CPL carries any. */
	annotation: string | null;
	/**
	 * Where the marker sits, in edit units, measured from the start of the resource's *track file* -
	 * the same datum as `entryPoint`, not the start of the cut. ST 2067-3 bounds it by
	 * `intrinsicDuration`, so a marker can fall outside the span the resource actually uses and be
	 * trimmed away; `imfMarkersOnTimeline` is what resolves that.
	 */
	offset: number;
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
	/**
	 * This resource's own edit rate, which defaults to the composition's. An audio resource counts in
	 * samples, so a 48 kHz sound track in a 25 fps composition states `48000 1` here - and every
	 * duration below is in THESE units, not the composition's.
	 */
	editRate: {
		/** Edit units per second, over `denominator`. */
		numerator: number;
		/** The denominator of the edit rate, 1001 for 24000/1001. */
		denominator: number;
	};
	/** The track file's own length, in this resource's edit units. */
	intrinsicDuration: number;
	/** Where the cut starts inside the track file, in this resource's edit units. Defaults to 0. */
	entryPoint: number;
	/**
	 * How much of it is used, in this resource's edit units. Defaults to everything after the entry
	 * point.
	 */
	sourceDuration: number;
	/** How many times the cut is laid down. Defaults to 1. */
	repeatCount: number;
	/** Where this resource starts on the composition timeline, in COMPOSITION edit units. */
	timelineStart: number;
	/**
	 * What it occupies on the timeline, in COMPOSITION edit units - `sourceDuration * repeatCount`
	 * converted out of this resource's edit rate.
	 */
	timelineDuration: number;
	/** Markers this resource carries. Only a marker sequence's resources have any. */
	markers: ImfMarker[];
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
			hashAlgorithm: asset.children
				.find(child => child.localName === 'HashAlgorithm')
				?.getAttribute('Algorithm') ?? null,
			originalFileName: firstChildText(asset, 'OriginalFileName'),
		});
	}

	return entries;
};

/** `<EditRate>24000 1001</EditRate>` - two integers, space separated, not a decimal. */
const readEditRate = (
	root: XmlElement,
	fallback: { numerator: number; denominator: number } | null,
): { numerator: number; denominator: number } => {
	const raw = firstChildText(root, 'EditRate');
	if (raw === null) {
		if (fallback) {
			return fallback;
		}
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
	const editRate = readEditRate(root, null);

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
				const resourceEditRate = readEditRate(resource, editRate);
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
				// A resource counts in its OWN edit units, so the timeline figure has to be converted.
				// An audio resource at 48000/1 in a 25/1 composition is 1920 of its units per frame;
				// reading its SourceDuration as composition units makes the sound 1920 times too long.
				const toComposition = (units: number) =>
					(units * editRate.numerator * resourceEditRate.denominator)
					/ (editRate.denominator * resourceEditRate.numerator);
				const timelineDuration = toComposition(sourceDuration * repeatCount);

				const markers: ImfMarker[] = [];
				for (const marker of resource.getElementsByTagName('Marker')) {
					const label = marker.children.find(child => child.localName === 'Label');
					if (!label) {
						throw new MalformedInputError(
							`IMF: a <Marker> on resource ${resourceId} states no <Label>.`,
						);
					}

					markers.push({
						label: label.textContent.trim(),
						scope: label.getAttribute('scope'),
						annotation: firstChildText(marker, 'Annotation'),
						offset: readInteger(marker, 'Offset', null),
					});
				}

				// Sorted, because a CPL may list them in any order and a caller reading them as a
				// timeline would otherwise have to sort them itself
				markers.sort((a, b) => a.offset - b.offset);

				track.resources.push({
					id: resourceId,
					trackFileId: trackFileIdRaw === null
						? null
						: readUuid(trackFileIdRaw, `resource ${resourceId}'s <TrackFileId>`),
					editRate: resourceEditRate,
					intrinsicDuration,
					entryPoint,
					sourceDuration,
					repeatCount,
					timelineStart: at,
					timelineDuration,
					markers,
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

const UNREADABLE = 'the reason is not an Error';

/**
 * The result of checking one asset against what the packing list claimed about it.
 *
 * @public
 * @group Input formats
 */
export type ImfAssetCheck = {
	/** The asset's UUID. */
	id: ImfUuid;
	/** Where the ASSETMAP located it, or null when it did not. */
	path: string | null;
	/** Octets the packing list stated, where it stated any. */
	statedSize: number | null;
	/** Octets actually read, or null when the asset could not be read at all. */
	actualSize: number | null;
	/** Base64 hash the packing list stated, where it stated any. */
	statedHash: string | null;
	/** Base64 hash of the octets, or null when nothing was hashed. */
	actualHash: string | null;
	/** What is wrong, in a sentence, or null when the asset checks out. */
	problem: string | null;
};

/**
 * The result of checking a whole package.
 *
 * @public
 * @group Input formats
 */
export type ImfPackageCheck = {
	/** Every asset the packing list covers, in the order it listed them. */
	assets: ImfAssetCheck[];
	/** True only when every asset checked out. */
	ok: boolean;
};

/**
 * The fragment of an XML-DSig algorithm URI. The reference implementation ships
 * `http://www.w3.org/2000/09/xmldig#sha1` - a typo for `xmldsig` - as its default, which is reason
 * enough to compare the fragment rather than the whole URI.
 */
const hashAlgorithmFragment = (uri: string): string => {
	const hash = uri.lastIndexOf('#');
	return (hash === -1 ? uri : uri.slice(hash + 1)).trim().toLowerCase();
};

/**
 * Checks a package's assets against the hashes and sizes its packing list states.
 *
 * This is what a packing list is *for*: `resolveImfPackage` checks that the three documents agree
 * about which assets exist, and this checks that the octets are the ones that were delivered. It is
 * separate because it reads every track file end to end, which a package being opened for playback
 * has no reason to do.
 *
 * An asset whose stated hash uses an algorithm other than SHA-1 is reported as a problem rather than
 * compared, since comparing a SHA-1 digest against another algorithm's claim would read as corruption.
 *
 * @public
 * @group Input formats
 */
export const verifyImfPackage = async (options: {
	/** A package as `resolveImfPackage` returned it; it must have been given a packing list. */
	package: ImfResolvedPackage;
	/** Opens an asset by its ASSETMAP path, relative to the package directory. */
	open: (path: string) => MaybePromise<Source>;
	/** Octets per read. Defaults to 4 MiB, which is a compromise, not a measurement. */
	chunkSize?: number;
}): Promise<ImfPackageCheck> => {
	const chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
	if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
		throw new TypeError('chunkSize must be a positive integer.');
	}
	if (options.package.packingList.size === 0) {
		throw new Error(
			'IMF: there is nothing to verify against - resolveImfPackage was not given a packing list.',
		);
	}

	const assets: ImfAssetCheck[] = [];

	for (const entry of options.package.packingList.values()) {
		const path = options.package.assets.get(entry.id)?.path ?? null;
		const check: ImfAssetCheck = {
			id: entry.id,
			path,
			statedSize: entry.size,
			actualSize: null,
			statedHash: entry.hash,
			actualHash: null,
			problem: null,
		};
		assets.push(check);

		if (path === null) {
			check.problem = 'the packing list lists it, but the ASSETMAP does not locate it';
			continue;
		}
		if (entry.hashAlgorithm !== null && hashAlgorithmFragment(entry.hashAlgorithm) !== 'sha1') {
			check.problem = `its hash uses ${entry.hashAlgorithm}, and only SHA-1 can be checked`;
			continue;
		}

		let source: Source;
		try {
			source = await options.open(path);
		} catch (error) {
			check.problem = `it could not be opened: ${error instanceof Error ? error.message : UNREADABLE}`;
			continue;
		}

		try {
			const size = await source.getSize();
			check.actualSize = size;

			// Hash even when the size is already wrong: a report that says both is worth more than one
			// that stops at the first disagreement
			const hasher = new Sha1();
			for (let offset = 0; offset < size; offset += chunkSize) {
				const end = Math.min(offset + chunkSize, size);
				const chunk = await source.readRange(offset, end);
				if (chunk === null) {
					// readRange throws on a short read, so this is a source that reports a size it
					// cannot then serve. Hashing what came back would read as corruption.
					throw new Error(`it served no octets for [${offset}, ${end})`);
				}
				hasher.update(chunk);
			}
			check.actualHash = bytesToBase64(hasher.digest());

			const problems: string[] = [];
			if (entry.size !== null && entry.size !== size) {
				problems.push(`it states ${entry.size} octets and holds ${size}`);
			}
			if (entry.hash !== null && entry.hash !== check.actualHash) {
				problems.push(`its hash is ${entry.hash} and the octets hash to ${check.actualHash}`);
			}
			if (entry.hash === null && entry.size === null) {
				problems.push('the packing list states neither a size nor a hash for it');
			}
			check.problem = problems.length === 0 ? null : problems.join(', and ');
		} catch (error) {
			check.problem = `it could not be read: ${error instanceof Error ? error.message : UNREADABLE}`;
		}
	}

	return { assets, ok: assets.every(asset => asset.problem === null) };
};

/**
 * A marker resolved onto the composition's timeline.
 *
 * @public
 * @group Input formats
 */
export type ImfPlacedMarker = {
	/** The marker as the CPL stated it. */
	marker: ImfMarker;
	/** The resource that carries it. */
	resource: ImfResource;
	/** Which repetition of the resource this placement belongs to, counting from 0. */
	repetition: number;
	/** Where it falls on the composition timeline, in edit units. */
	timelinePosition: number;
};

/**
 * Resolves a track's markers onto the composition timeline, in composition edit units.
 *
 * Two things make this more than adding an offset to a start. A marker's offset is measured from the
 * start of the *track file*, so a resource that enters late subtracts its `entryPoint` — and a marker
 * outside the span the resource uses is **trimmed away** and placed nowhere, which is why this cannot
 * simply map over the markers. And `repeatCount` lays the cut down more than once, so a marker inside
 * it occurs once per repetition.
 *
 * @public
 * @group Input formats
 */
export const imfMarkersOnTimeline = (
	track: ImfVirtualTrack,
	compositionEditRate: {
		/** Edit units per second, over `denominator`. */
		numerator: number;
		/** The denominator of the edit rate, 1001 for 24000/1001. */
		denominator: number;
	},
): ImfPlacedMarker[] => {
	const placed: ImfPlacedMarker[] = [];

	for (const resource of track.resources) {
		// An offset is in the resource's own edit units and a timeline position is in the
		// composition's, so the distance into the cut has to be converted before it is added
		const scale = (compositionEditRate.numerator * resource.editRate.denominator)
			/ (compositionEditRate.denominator * resource.editRate.numerator);

		for (const marker of resource.markers) {
			const withinCut = marker.offset - resource.entryPoint;
			if (withinCut < 0 || withinCut >= resource.sourceDuration) {
				continue;
			}

			for (let repetition = 0; repetition < resource.repeatCount; repetition++) {
				placed.push({
					marker,
					resource,
					repetition,
					timelinePosition: resource.timelineStart
						+ (repetition * resource.sourceDuration + withinCut) * scale,
				});
			}
		}
	}

	return placed.sort((a, b) => a.timelinePosition - b.timelinePosition);
};
