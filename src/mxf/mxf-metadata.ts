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
const TAG_ESSENCE_CONTAINERS = 0x1902;
const TAG_LINKED_PACKAGE_UID = 0x2701;
const TAG_INDEX_SID = 0x3f06;
const TAG_BODY_SID = 0x3f07;
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
/** An EssenceGroup's choices sit under a tag of their own rather than under 0x1001. */
const TAG_ESSENCE_GROUP_CHOICES = 0x0501;
const TAG_DATA_DEFINITION = 0x0201;

const TAG_SOURCE_PACKAGE_ID = 0x1101;
const TAG_SOURCE_TRACK_ID = 0x1102;
const TAG_START_POSITION = 0x1201;

const TAG_START_TIMECODE = 0x1501;
const TAG_ROUNDED_TIMECODE_BASE = 0x1502;
const TAG_DROP_FRAME = 0x1503;

const TAG_LINKED_TRACK_ID = 0x3006;
const TAG_SUB_DESCRIPTORS = 0x3f01;

/** Identification, which states what wrote the file. One set per application that touched it. */
const TAG_COMPANY_NAME = 0x3c01;
const TAG_PRODUCT_NAME = 0x3c02;
const TAG_PRODUCT_VERSION_NUM = 0x3c03;
const TAG_PRODUCT_VERSION = 0x3c04;
const TAG_PRODUCT_UID = 0x3c05;
const TAG_MODIFICATION_DATE = 0x3c06;
const TAG_TOOLKIT_VERSION_NUM = 0x3c07;
const TAG_APPLICATION_PLATFORM = 0x3c08;
const TAG_GENERATION_UID = 0x3c09;

const TAG_LAST_MODIFIED_DATE = 0x3b02;
const TAG_IDENTIFICATIONS = 0x3b06;
const TAG_OPERATIONAL_PATTERN = 0x3b09;

/**
 * Avid writes the project name under a tag of its own, which only the primer pack can resolve, so it
 * is matched by the UL rather than by any number. FFmpeg carries the same key as
 * `mxf_avid_project_name`.
 */
const AVID_PROJECT_NAME_UL = [
	0xa5, 0xfb, 0x7b, 0x25, 0xf6, 0x15, 0x94, 0xb9, 0x62, 0xfc, 0x37, 0x17, 0x49, 0x2d, 0x42, 0xbf,
] as const;

/**
 * What a track carries, from the DataDefinition UL of its sequence. Byte 12 of the UL names the kind
 * and byte 13 distinguishes picture from sound within it, which is the only part that varies between
 * the SMPTE 12M and 377M registry versions of these keys.
 */
export type MxfTrackKind = 'picture' | 'sound' | 'timecode' | 'data' | 'unknown';

/**
 * Avid Media Composer writes data definitions under keys of its own that are not universal labels at
 * all - they begin 0x80 - so byte 12 says nothing about them. FFmpeg carries the same two
 * (`ff_mxf_data_definition_uls`, "LegacyPicture"/"LegacySound"), which is where these come from.
 */
const AVID_LEGACY_DATA_DEFINITIONS: readonly { ul: readonly number[]; kind: MxfTrackKind }[] = [
	{
		ul: [0x80, 0x7d, 0x00, 0x60, 0x08, 0x14, 0x3e, 0x6f, 0x6f, 0x3c, 0x8c, 0xe1, 0x6c, 0xef, 0x11, 0xd2],
		kind: 'picture',
	},
	{
		ul: [0x80, 0x7d, 0x00, 0x60, 0x08, 0x14, 0x3e, 0x6f, 0x78, 0xe1, 0xeb, 0xe1, 0x6c, 0xef, 0x11, 0xd2],
		kind: 'sound',
	},
];

const dataDefinitionKind = (ul: Uint8Array | undefined): MxfTrackKind => {
	if (!ul || ul.byteLength < 14) {
		return 'unknown';
	}

	if (ul[0] !== 0x06) {
		for (const legacy of AVID_LEGACY_DATA_DEFINITIONS) {
			if (legacy.ul.every((byte, index) => ul[index] === byte)) {
				return legacy.kind;
			}
		}

		return 'unknown';
	}

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
	/**
	 * Which essence container each file package's essence lives in, by PackageUID. An essence element
	 * key is only unique within a container, so this is what tells two containers' tracks apart.
	 */
	essenceContainers: Map<string, { bodySid: number; indexSid: number }>;
	/**
	 * What the file says about itself and what wrote it, keyed the way FFmpeg keys the same fields so
	 * the two can be compared directly. `null` where the file states nothing.
	 */
	tags: Record<string, string>;
	/** When the file was last written, from the Preface. */
	modifiedAt: Date | null;
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

/**
 * An MXF timestamp: a 16-bit year, then month, day, hour, minute and second as octets, then a
 * quarter-millisecond count. It states no zone, and SMPTE 377M says UTC.
 */
const asTimestamp = (bytes: Uint8Array | undefined): Date | null => {
	if (!bytes || bytes.byteLength < 8) {
		return null;
	}

	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (data.getBigUint64(0) === 0n) {
		return null;
	}

	return new Date(Date.UTC(
		data.getUint16(0),
		Math.max(bytes[2]! - 1, 0),
		Math.max(bytes[3]!, 1),
		bytes[4],
		bytes[5],
		bytes[6],
		bytes[7]! * 4,
	));
};

/**
 * A product or toolkit version: five 16-bit numbers, dot-joined the way every tool prints them.
 *
 * Only the components the field actually holds are read. Avid writes this field **nine** octets long
 * in some files, and reading the fifth component anyway takes the first octet of the next local tag
 * as its high byte - which is where FFmpeg's `1.1.0.0.60` for `track_02_a01.mxf` comes from, and it
 * then parses the rest of that set one octet out of step and loses five further fields.
 */
const asVersion = (bytes: Uint8Array | undefined): string | null => {
	if (!bytes || bytes.byteLength < 2) {
		return null;
	}

	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const components: number[] = [];
	for (let at = 0; at + 2 <= Math.min(bytes.byteLength, 10); at += 2) {
		components.push(data.getUint16(at));
	}

	return components.join('.');
};

/** A 16-octet identifier, in the 8-4-4-4-12 form every tool prints. */
const asUuid = (bytes: Uint8Array | undefined): string | null => {
	if (!bytes || bytes.byteLength < 16) {
		return null;
	}

	const hex = [...bytes.subarray(0, 16)].map(octet => octet.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** A signed 64-bit position, which MXF uses for durations and offsets that may be -1 for "unknown". */
const asPosition = (bytes: Uint8Array | undefined): number | null => {
	if (!bytes || bytes.byteLength < 8) {
		return bytes ? asUint(bytes) : null;
	}

	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const value = data.getBigInt64(0);
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
	primer?: Map<number, Uint8Array> | null,
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
				applySourceClip(track, component);
			} else if (type === MxfSetType.EssenceGroup && track.sourcePackageId === null) {
				// The group's choices are the same essence in different representations, and in an
				// OP-Atom file most of them live in sibling files: the first choice of
				// `opatom_essencegroup_alpha_raw.mxf` names a package this file does not contain. So
				// the choice to take is the first whose package is actually here, which is what
				// FFmpeg's `mxf_resolve_sourceclip` means by the first one with a valid descriptor.
				for (const choiceUid of asKeyBatch(component.get(TAG_ESSENCE_GROUP_CHOICES))) {
					const choice = sets.get(choiceUid);
					if (!choice || setTypes.get(choiceUid) !== MxfSetType.SourceClip) {
						continue;
					}

					const packageId = choice.get(TAG_SOURCE_PACKAGE_ID);
					if (packageId && packagesPresent.has(asKey(packageId))) {
						applySourceClip(track, choice);
						break;
					}
				}

				track.duration ??= asPosition(component.get(TAG_DURATION));
			}
		}

		return track;
	};

	// Every package this file actually carries, by PackageUID, so an EssenceGroup's choices can be
	// told apart from the ones that live in another file of the same set
	const packagesPresent = new Set<string>();
	for (const [uid, set] of sets) {
		const type = setTypes.get(uid);
		if (type === MxfSetType.SourcePackage || type === MxfSetType.MaterialPackage) {
			const packageUid = set.get(TAG_PACKAGE_UID);
			if (packageUid) {
				packagesPresent.add(asKey(packageUid));
			}
		}
	}

	const applySourceClip = (track: MxfTrack, component: LocalSet) => {
		const packageId = component.get(TAG_SOURCE_PACKAGE_ID);
		const trackId = component.get(TAG_SOURCE_TRACK_ID);
		track.sourcePackageId = packageId ? asKey(packageId) : null;
		track.sourceTrackId = trackId ? asUint(trackId) : null;
		track.startPosition = asPosition(component.get(TAG_START_POSITION)) ?? 0;
		track.duration ??= asPosition(component.get(TAG_DURATION));
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

	const essenceContainers = new Map<string, { bodySid: number; indexSid: number }>();
	for (const uid of storage ? asKeyBatch(storage.get(TAG_ESSENCE_CONTAINERS)) : []) {
		const set = sets.get(uid);
		const linked = set?.get(TAG_LINKED_PACKAGE_UID);
		if (!set || !linked) {
			continue;
		}

		essenceContainers.set(asKey(linked), {
			bodySid: asUint(set.get(TAG_BODY_SID) ?? new Uint8Array()),
			indexSid: asUint(set.get(TAG_INDEX_SID) ?? new Uint8Array()),
		});
	}

	const tags: Record<string, string> = {};
	const state = (key: string, value: string | null | undefined) => {
		if (value !== null && value !== undefined && value !== '') {
			tags[key] = value;
		}
	};

	// The last Identification is the application that wrote the file as it stands; the earlier ones
	// are whatever touched it before, which is history rather than provenance.
	const identifications = asKeyBatch(preface.set.get(TAG_IDENTIFICATIONS));
	const identification = identifications.length > 0
		? sets.get(identifications[identifications.length - 1]!)
		: bySetType(MxfSetType.Identification).at(-1)?.set;

	if (identification) {
		state('company_name', asString(identification.get(TAG_COMPANY_NAME)));
		state('product_name', asString(identification.get(TAG_PRODUCT_NAME)));
		state('product_version_num', asVersion(identification.get(TAG_PRODUCT_VERSION_NUM)));
		state('product_version', asString(identification.get(TAG_PRODUCT_VERSION)));
		state('product_uid', asUuid(identification.get(TAG_PRODUCT_UID)));
		state('toolkit_version_num', asVersion(identification.get(TAG_TOOLKIT_VERSION_NUM)));
		state('application_platform', asString(identification.get(TAG_APPLICATION_PLATFORM)));
		state('generation_uid', asUuid(identification.get(TAG_GENERATION_UID)));
		state('uid', asUuid(identification.get(TAG_INSTANCE_UID)));
		state('modification_date', asTimestamp(identification.get(TAG_MODIFICATION_DATE))?.toISOString());
	}

	const operationalPattern = preface.set.get(TAG_OPERATIONAL_PATTERN);
	if (operationalPattern && operationalPattern.byteLength >= 16) {
		const hex = [...operationalPattern.subarray(0, 16)]
			.map(octet => octet.toString(16).padStart(2, '0'))
			.join('');
		state('operational_pattern_ul', [0, 8, 16, 24].map(at => hex.slice(at, at + 8)).join('.'));
	}

	state('material_package_name', materialPackage?.name);

	if (primer) {
		for (const [tag, ul] of primer) {
			if (tag < 0x8000 || !ul.subarray(0, 16).every((octet, at) => octet === AVID_PROJECT_NAME_UL[at])) {
				continue;
			}

			state('project_name', asString(preface.set.get(tag)));
			break;
		}
	}

	const modifiedAt = asTimestamp(preface.set.get(TAG_LAST_MODIFIED_DATE));

	return { sets, materialPackage, sourcePackages, essenceContainers, tags, modifiedAt };
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
		// `data` covers everything that is neither picture nor sound, so it is admitted here and the
		// descriptor decides what it actually is - a timed text track file is a data track whose
		// descriptor is ST 2067-5's, and a data track whose descriptor says nothing recognisable
		// yields no samples and is dropped further along
		if (track.kind !== 'picture' && track.kind !== 'sound' && track.kind !== 'data') {
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
