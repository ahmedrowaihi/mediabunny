/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MXF header metadata is a flat bag of local sets that reference each other by InstanceUID, so nothing
// about a track can be read without resolving a chain: Preface -> ContentStorage -> Package -> Track ->
// Sequence -> SourceClip, and separately a file package's Descriptor back to the track it describes by
// LinkedTrackID. This file does that resolution once and hands back a structure; nothing above it
// should hold an InstanceUID.
//
// The material package is what a player presents and the file (source) package is what the essence
// actually is, so a usable track is the join of the two: timing from the material side, coding from the
// file side.

import { MalformedInputError } from '../errors';
import {
	asKey,
	asRational,
	asUint,
	type LocalSet,
	MxfSetType,
	setTypeOf,
} from './mxf-klv';

/** InstanceUID, which every header metadata set carries and every reference points at. */
const TAG_INSTANCE_UID = 0x3c0a;

const TAG_CONTENT_STORAGE = 0x3b03;
const TAG_PACKAGES = 0x1901;
const TAG_PACKAGE_UID = 0x4401;
const TAG_PACKAGE_NAME = 0x4402;
const TAG_PACKAGE_TRACKS = 0x4403;
const TAG_DESCRIPTOR = 0x4701;

const TAG_TRACK_ID = 0x4801;
const TAG_TRACK_NAME = 0x4802;
const TAG_TRACK_NUMBER = 0x4804;
const TAG_TRACK_SEQUENCE = 0x4803;
const TAG_EDIT_RATE = 0x4b01;
const TAG_ORIGIN = 0x4b02;

const TAG_DURATION = 0x0202;
const TAG_STRUCTURAL_COMPONENTS = 0x1001;
const TAG_DATA_DEFINITION = 0x0201;

const TAG_SOURCE_PACKAGE_ID = 0x1101;
const TAG_SOURCE_TRACK_ID = 0x1102;
const TAG_START_POSITION = 0x1201;

const TAG_START_TIMECODE = 0x1501;
const TAG_ROUNDED_TIMECODE_BASE = 0x1502;
const TAG_DROP_FRAME = 0x1503;

const TAG_LINKED_TRACK_ID = 0x3006;
const TAG_SUB_DESCRIPTORS = 0x3f01;

/**
 * What a track carries, from the DataDefinition UL of its sequence. Byte 12 of the UL names the kind
 * and byte 13 distinguishes picture from sound within it, which is the only part that varies between
 * the SMPTE 12M and 377M registry versions of these keys.
 */
export type MxfTrackKind = 'picture' | 'sound' | 'timecode' | 'data' | 'unknown';

const dataDefinitionKind = (ul: Uint8Array | undefined): MxfTrackKind => {
	if (!ul || ul.byteLength < 14) {
		return 'unknown';
	}

	// 06.0e.2b.34.04.01.01.xx.01.03.02.02.yy.zz: yy picks the kind
	switch (ul[12]) {
		case 0x01: return 'picture';
		case 0x02: return 'sound';
		case 0x03: return 'data';
		case 0x0f: return 'timecode';
		default: return 'unknown';
	}
};

/** A timecode track's start, which is what {@link InputTrack.getStartTimecode} is built from. */
export type MxfStartTimecode = {
	/** Frames since midnight at `base`. */
	startFrame: number;
	/** The nominal frame rate the count is in, rounded to an integer, as MXF states it. */
	base: number;
	dropFrame: boolean;
};

export type MxfTrack = {
	/** TrackID, which is what a descriptor's LinkedTrackID points back at. */
	id: number;
	/**
	 * TrackNumber, which is what the last four bytes of an essence element key hold. This, not
	 * {@link MxfTrack.id}, is how a run of essence is attributed to a track.
	 */
	trackNumber: number;
	name: string | null;
	kind: MxfTrackKind;
	/** Edit units per second; a timeline track states one and a static track does not. */
	editRate: { num: number; den: number } | null;
	/** Edit units of lead-in trimmed from the front of the essence. */
	origin: number;
	/** Duration in edit units, or null where the track states none. */
	duration: number | null;
	/** Where a material track points: the file package holding the essence, and the track in it. */
	sourcePackageId: string | null;
	sourceTrackId: number | null;
	/** Edit units into the source the clip starts at. */
	startPosition: number;
	startTimecode: MxfStartTimecode | null;
};

export type MxfPackage = {
	/** PackageUID, as hex, which a SourceClip names to point at this package. */
	uid: string;
	name: string | null;
	tracks: MxfTrack[];
	/**
	 * The file descriptor of this package, where it has one. A MultipleDescriptor is kept as-is and its
	 * children listed in `subDescriptors`, since only they carry LinkedTrackID.
	 */
	descriptor: LocalSet | null;
	subDescriptors: LocalSet[];
};

export type MxfHeaderMetadata = {
	/** Every set read, by InstanceUID, for anything this structure does not resolve. */
	sets: Map<string, LocalSet>;
	/** What the file presents: the timeline a player reads. */
	materialPackage: MxfPackage | null;
	/** What the file holds, by PackageUID. A SourceClip in the material package names one of these. */
	sourcePackages: Map<string, MxfPackage>;
};

/** MXF writes strings as UTF-16BE, with a trailing null that is not part of the text. */
const asString = (bytes: Uint8Array | undefined): string | null => {
	if (!bytes || bytes.byteLength < 2) {
		return null;
	}

	let out = '';
	for (let at = 0; at + 1 < bytes.byteLength; at += 2) {
		const code = (bytes[at]! << 8) | bytes[at + 1]!;
		if (code === 0) {
			break;
		}
		out += String.fromCharCode(code);
	}

	return out.length > 0 ? out : null;
};

/**
 * A batch or array of fixed-width items: a 32-bit count and a 32-bit item size, then the items. Both
 * are written the same way, and the only ones read here hold 16-byte references.
 */
const asKeyBatch = (bytes: Uint8Array | undefined): string[] => {
	if (!bytes || bytes.byteLength < 8) {
		return [];
	}

	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = data.getUint32(0);
	const size = data.getUint32(4);
	if (size === 0) {
		return [];
	}

	const out: string[] = [];
	for (let i = 0; i < count && 8 + (i + 1) * size <= bytes.byteLength; i++) {
		out.push(asKey(bytes.subarray(8 + i * size, 8 + i * size + 16)));
	}

	return out;
};

/** A signed 64-bit position, which MXF uses for durations and offsets that may be -1 for "unknown". */
const asPosition = (bytes: Uint8Array | undefined): number | null => {
	if (!bytes || bytes.byteLength < 8) {
		return bytes ? asUint(bytes) : null;
	}

	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const value = data.getBigInt64(0);
	// -1 is MXF's "not known yet", written by anything that could not seek back to fill it in
	return value < 0n ? null : Number(value);
};

/**
 * Reads every header metadata set in `slice`, which must span the header partition's metadata, and
 * resolves the package graph out of them.
 *
 * @internal
 */
export const readHeaderMetadata = (
	sets: Map<string, LocalSet>,
	setTypes: Map<string, number>,
): MxfHeaderMetadata => {
	const bySetType = (type: MxfSetType) => {
		const out: { uid: string; set: LocalSet }[] = [];
		for (const [uid, set] of sets) {
			if (setTypes.get(uid) === type) {
				out.push({ uid, set });
			}
		}

		return out;
	};

	const readTimecode = (set: LocalSet): MxfStartTimecode | null => {
		const base = set.get(TAG_ROUNDED_TIMECODE_BASE);
		const start = set.get(TAG_START_TIMECODE);
		if (!base || !start) {
			return null;
		}

		return {
			startFrame: asPosition(start) ?? 0,
			base: asUint(base),
			dropFrame: asUint(set.get(TAG_DROP_FRAME) ?? new Uint8Array([0])) !== 0,
		};
	};

	const readTrack = (uid: string): MxfTrack | null => {
		const set = sets.get(uid);
		if (!set) {
			return null;
		}

		const id = set.get(TAG_TRACK_ID);
		if (id === undefined) {
			return null;
		}

		const track: MxfTrack = {
			id: asUint(id),
			trackNumber: asUint(set.get(TAG_TRACK_NUMBER) ?? new Uint8Array()),
			name: asString(set.get(TAG_TRACK_NAME)),
			kind: 'unknown',
			editRate: set.has(TAG_EDIT_RATE) ? asRational(set.get(TAG_EDIT_RATE)!) : null,
			origin: asPosition(set.get(TAG_ORIGIN)) ?? 0,
			duration: null,
			sourcePackageId: null,
			sourceTrackId: null,
			startPosition: 0,
			startTimecode: null,
		};

		const sequenceUid = set.get(TAG_TRACK_SEQUENCE);
		const sequence = sequenceUid && sets.get(asKey(sequenceUid));
		if (!sequence) {
			return track;
		}

		track.kind = dataDefinitionKind(sequence.get(TAG_DATA_DEFINITION));
		track.duration = asPosition(sequence.get(TAG_DURATION));

		// A sequence holds the components in order. Only the first is read: a track built from several
		// clips is an edit list this demuxer does not present, and reading the first still gives the
		// package the essence lives in, which is the same for every component of a well-formed file.
		for (const componentUid of asKeyBatch(sequence.get(TAG_STRUCTURAL_COMPONENTS))) {
			const component = sets.get(componentUid);
			if (!component) {
				continue;
			}

			const type = setTypes.get(componentUid);
			if (type === MxfSetType.TimecodeComponent) {
				track.startTimecode ??= readTimecode(component);
				track.duration ??= asPosition(component.get(TAG_DURATION));
			} else if (type === MxfSetType.SourceClip && track.sourcePackageId === null) {
				const packageId = component.get(TAG_SOURCE_PACKAGE_ID);
				const trackId = component.get(TAG_SOURCE_TRACK_ID);
				track.sourcePackageId = packageId ? asKey(packageId) : null;
				track.sourceTrackId = trackId ? asUint(trackId) : null;
				track.startPosition = asPosition(component.get(TAG_START_POSITION)) ?? 0;
				track.duration ??= asPosition(component.get(TAG_DURATION));
			}
		}

		return track;
	};

	const readPackage = (uid: string): MxfPackage | null => {
		const set = sets.get(uid);
		const packageUid = set?.get(TAG_PACKAGE_UID);
		if (!set || !packageUid) {
			return null;
		}

		const tracks: MxfTrack[] = [];
		for (const trackUid of asKeyBatch(set.get(TAG_PACKAGE_TRACKS))) {
			const track = readTrack(trackUid);
			if (track) {
				tracks.push(track);
			}
		}

		const descriptorUid = set.get(TAG_DESCRIPTOR);
		const descriptor = (descriptorUid && sets.get(asKey(descriptorUid))) || null;
		const subDescriptors: LocalSet[] = [];
		if (descriptor) {
			for (const childUid of asKeyBatch(descriptor.get(TAG_SUB_DESCRIPTORS))) {
				const child = sets.get(childUid);
				if (child) {
					subDescriptors.push(child);
				}
			}
		}

		return {
			uid: asKey(packageUid),
			name: asString(set.get(TAG_PACKAGE_NAME)),
			tracks,
			descriptor,
			subDescriptors,
		};
	};

	// The Preface names the ContentStorage, which lists the packages. A file whose Preface is missing is
	// not readable as MXF, but one whose storage merely lists nothing is - it just has no tracks.
	const preface = bySetType(MxfSetType.Preface)[0];
	if (!preface) {
		throw new MalformedInputError('MXF header metadata states no Preface.');
	}

	const storageUid = preface.set.get(TAG_CONTENT_STORAGE);
	const storage = storageUid && sets.get(asKey(storageUid));
	const packageUids = storage ? asKeyBatch(storage.get(TAG_PACKAGES)) : [];

	let materialPackage: MxfPackage | null = null;
	const sourcePackages = new Map<string, MxfPackage>();
	for (const uid of packageUids) {
		const parsed = readPackage(uid);
		if (!parsed) {
			continue;
		}

		if (setTypes.get(uid) === MxfSetType.MaterialPackage) {
			materialPackage ??= parsed;
		} else {
			sourcePackages.set(parsed.uid, parsed);
		}
	}

	return { sets, materialPackage, sourcePackages };
};

/**
 * The descriptor describing one track of a package: a MultipleDescriptor's child whose LinkedTrackID
 * matches, or the package's single descriptor where it has only one.
 *
 * @internal
 */
export const descriptorForTrack = (pkg: MxfPackage, trackId: number): LocalSet | null => {
	for (const child of pkg.subDescriptors) {
		const linked = child.get(TAG_LINKED_TRACK_ID);
		if (linked && asUint(linked) === trackId) {
			return child;
		}
	}

	// A file with one essence track states its descriptor directly, and may well omit LinkedTrackID
	if (pkg.subDescriptors.length === 0) {
		return pkg.descriptor;
	}

	return null;
};

/**
 * Pairs each material track with the file package and descriptor its essence lives in.
 *
 * A material track carries the timing and a file package carries the coding, so neither alone
 * describes a track a caller can read.
 *
 * @internal
 */
export const resolveTracks = (metadata: MxfHeaderMetadata) => {
	const out: { track: MxfTrack; pkg: MxfPackage; descriptor: LocalSet | null }[] = [];
	const material = metadata.materialPackage;
	if (!material) {
		return out;
	}

	for (const track of material.tracks) {
		if (track.kind !== 'picture' && track.kind !== 'sound') {
			continue;
		}

		const pkg = track.sourcePackageId === null
			? null
			: metadata.sourcePackages.get(track.sourcePackageId) ?? null;
		if (!pkg) {
			continue;
		}

		out.push({
			track,
			pkg,
			descriptor: descriptorForTrack(pkg, track.sourceTrackId ?? track.id),
		});
	}

	return out;
};

/** @internal */
export const isHeaderMetadataSet = (key: Uint8Array) => setTypeOf(key) !== null;

/** @internal */
export { TAG_INSTANCE_UID };

/** @internal */
export const instanceUidOf = (set: LocalSet): string | null => {
	const uid = set.get(TAG_INSTANCE_UID);
	return uid ? asKey(uid) : null;
};
