/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MalformedInputError, UnsupportedMediaError } from '../errors';
import { parseBoxes } from '../crypto/box-tree';
import { removeEmulationPreventionBytes } from '../codec-data';
import { eachBox } from '../isobmff/isobmff-misc';
import { segmentsOf } from '../isobmff/isobmff-misc';
import { buildSeiNalUnit, iterateSeiMessages } from '../sei';

/** The only `WMPaceInfo` version this document defines. */
const WM_PACE_INFO_VERSION = 1;
const WM_PACE_INFO_SIZE = 6;

/**
 * Per-segment watermarking metadata, as defined by DASH-IF Forensic A/B Watermarking
 * (ETSI TS 104 002). A transcoder emits one of these per ingested segment; the packager, origin
 * and CDN edge read it to learn which bit of a viewer's watermark pattern the segment carries.
 *
 * @group Watermarking
 * @public
 */
export type WmPaceInfo = {
	/** `iswm`: whether the segment this describes is watermarked at all. */
	watermarked: boolean;
	/** `variant`: which A/B variant this segment is, numbered from 0 for variant A. */
	variant: number;
	/** `pos`: zero-based index into the watermark pattern that this segment encodes. */
	position: number;
	/** `firstpart`: whether this is the first segment carrying this `position`. */
	firstPart: boolean;
	/** `nbpart`: upper bound on how many consecutive segments share this `position`. */
	partCount: number;
};

/**
 * Encode a {@link WmPaceInfo} as the specification's 48-bit structure.
 *
 * @group Watermarking
 * @public
 */
export const encodeWmPaceInfo = (info: WmPaceInfo): Uint8Array => {
	if (!Number.isInteger(info.variant) || info.variant < 0 || info.variant > 0xff) {
		throw new TypeError('WMPaceInfo variant must be an integer in [0, 255].');
	}
	if (!Number.isInteger(info.position) || info.position < 0 || info.position > 0x7fff) {
		throw new TypeError('WMPaceInfo position must be an integer in [0, 32767].');
	}
	if (!Number.isInteger(info.partCount) || info.partCount < 0 || info.partCount > 0xff) {
		throw new TypeError('WMPaceInfo partCount must be an integer in [0, 255].');
	}

	const bytes = new Uint8Array(WM_PACE_INFO_SIZE);
	bytes[0] = WM_PACE_INFO_VERSION;
	bytes[1] = info.variant;
	// The two emulation bits are fixed at 1 so the structure can never form a start code.
	bytes[2] = 0x80 | ((info.position >> 8) & 0x7f);
	bytes[3] = info.position & 0xff;
	bytes[4] = (info.firstPart ? 0x80 : 0) | 0x40 | (info.watermarked ? 0x20 : 0);
	bytes[5] = info.partCount;
	return bytes;
};

/**
 * Decode the specification's 48-bit structure back into a {@link WmPaceInfo}.
 *
 * @throws When the data is too short or carries an unrecognized version.
 * @group Watermarking
 * @public
 */
export const decodeWmPaceInfo = (bytes: Uint8Array): WmPaceInfo => {
	if (bytes.length < WM_PACE_INFO_SIZE) {
		throw new MalformedInputError(`WMPaceInfo must be ${WM_PACE_INFO_SIZE} bytes, got ${bytes.length}.`);
	}
	if (bytes[0] !== WM_PACE_INFO_VERSION) {
		throw new UnsupportedMediaError(`Unsupported WMPaceInfo version ${bytes[0]}.`);
	}
	return {
		watermarked: (bytes[4]! & 0x20) !== 0,
		variant: bytes[1]!,
		position: ((bytes[2]! & 0x7f) << 8) | bytes[3]!,
		firstPart: (bytes[4]! & 0x80) !== 0,
		partCount: bytes[5]!,
	};
};

/**
 * Build the complete `wmpi` box carrying a {@link WmPaceInfo}, ready to prepend to a segment. It
 * is a top-level box and belongs at the start of the segment it describes, so that zero-padding
 * the segment leaves it reachable.
 *
 * @group Watermarking
 * @public
 */
export const wmPaceInfoBox = (info: WmPaceInfo): Uint8Array => {
	const payload = encodeWmPaceInfo(info);
	const bytes = new Uint8Array(8 + payload.length);
	new DataView(bytes.buffer).setUint32(0, bytes.length);
	for (let i = 0; i < 4; i++) {
		bytes[4 + i] = 'wmpi'.charCodeAt(i);
	}
	bytes.set(payload, 8);
	return bytes;
};

/**
 * Read the `wmpi` box from a segment, returning `null` when the segment carries none — including
 * when it carries one an origin has already zero-padded.
 *
 * @group Watermarking
 * @public
 */
export const readWmPaceInfo = (segment: Uint8Array): WmPaceInfo | null => {
	for (const topLevel of parseBoxes(segment, 0, segment.length)) {
		if (topLevel.type !== 'wmpi' || topLevel.data === undefined) {
			continue;
		}
		// A zero-padded box is one an origin has already neutered, not a malformed one.
		if (topLevel.data.every(byte => byte === 0)) {
			return null;
		}
		return decodeWmPaceInfo(topLevel.data);
	}
	return null;
};

/**
 * The UUID identifying a `WMPaceInfo` SEI message, `bec4f824-170d-47cf-a826-ce008083e355`.
 *
 * @group Watermarking
 * @public
 */
export const WM_PACE_INFO_SEI_UUID = new Uint8Array([
	0xbe, 0xc4, 0xf8, 0x24, 0x17, 0x0d, 0x47, 0xcf,
	0xa8, 0x26, 0xce, 0x00, 0x80, 0x83, 0xe3, 0x55,
]);

/** `user_data_unregistered`, the SEI payload type that carries a UUID-tagged payload. */
const USER_DATA_UNREGISTERED = 5;

/**
 * Build an SEI NAL unit carrying a {@link WmPaceInfo}, as a `user_data_unregistered` message under
 * {@link WM_PACE_INFO_SEI_UUID}. It belongs on the first frame of the segment it describes, so that
 * zero-padding the segment leaves it reachable.
 *
 * @group Watermarking
 * @public
 */
export const wmPaceInfoSeiNalUnit = (info: WmPaceInfo, codec: 'avc' | 'hevc'): Uint8Array => {
	const payload = new Uint8Array(WM_PACE_INFO_SEI_UUID.length + WM_PACE_INFO_SIZE);
	payload.set(WM_PACE_INFO_SEI_UUID, 0);
	payload.set(encodeWmPaceInfo(info), WM_PACE_INFO_SEI_UUID.length);

	const nalUnit = buildSeiNalUnit([{ payloadType: USER_DATA_UNREGISTERED, payload }], codec);
	if (nalUnit === null) {
		throw new MalformedInputError('Failed to build the WMPaceInfo SEI NAL unit.');
	}
	return nalUnit;
};

/**
 * Read a {@link WmPaceInfo} out of an SEI NAL unit, returning `null` when it carries none — either
 * because it holds no `user_data_unregistered` message or because none is under our UUID.
 *
 * @group Watermarking
 * @public
 */
export const readWmPaceInfoSei = (seiNalUnit: Uint8Array, codec: 'avc' | 'hevc'): WmPaceInfo | null => {
	for (const message of iterateSeiMessages(seiNalUnit, codec)) {
		if (message.payloadType !== USER_DATA_UNREGISTERED) {
			continue;
		}
		if (message.payload.length < WM_PACE_INFO_SEI_UUID.length + WM_PACE_INFO_SIZE) {
			continue;
		}
		if (WM_PACE_INFO_SEI_UUID.some((byte, i) => message.payload[i] !== byte)) {
			continue;
		}
		return decodeWmPaceInfo(message.payload.subarray(WM_PACE_INFO_SEI_UUID.length));
	}
	return null;
};

/**
 * Build the `temi_WMPaceInfo_descriptor` for an MPEG-TS adaptation field: the descriptor tag, its
 * length, then the 48-bit structure.
 *
 * `af_descr_tag` is the one field the specification leaves unassigned — it reads "[tbd]" — so the
 * tag is a required argument rather than a constant here. Both ends of a deployment have to agree
 * on it out of band, and nothing can interoperate on it until the value is allocated.
 *
 * @group Watermarking
 * @public
 */
export const wmPaceInfoTsDescriptor = (info: WmPaceInfo, descriptorTag: number): Uint8Array => {
	if (!Number.isInteger(descriptorTag) || descriptorTag < 0 || descriptorTag > 0xff) {
		throw new TypeError('An adaptation field descriptor tag is an integer in [0, 255].');
	}

	const descriptor = new Uint8Array(2 + WM_PACE_INFO_SIZE);
	descriptor[0] = descriptorTag;
	descriptor[1] = WM_PACE_INFO_SIZE;
	descriptor.set(encodeWmPaceInfo(info), 2);
	return descriptor;
};

/**
 * Read a {@link WmPaceInfo} from a `temi_WMPaceInfo_descriptor`, returning `null` when the
 * descriptor carries another tag or is too short to hold the structure.
 *
 * @group Watermarking
 * @public
 */
export const readWmPaceInfoTsDescriptor = (descriptor: Uint8Array, descriptorTag: number): WmPaceInfo | null => {
	if (descriptor.length < 2 + WM_PACE_INFO_SIZE || descriptor[0] !== descriptorTag) {
		return null;
	}
	if (descriptor[1]! < WM_PACE_INFO_SIZE) {
		return null;
	}
	return decodeWmPaceInfo(descriptor.subarray(2));
};

/**
 * Zero the `WMPaceInfo` a segment carries, leaving the `wmpi` box itself in place.
 *
 * An origin must do this before a segment reaches a device: the metadata says which bit of a
 * viewer's watermark pattern the segment encodes, and is not theirs to read. It is *zeroed* rather
 * than removed because removing it would move every byte after it, invalidating byte ranges, the
 * `sidx` that indexes them, and the byte-range alignment the specification requires between
 * variants. That is also why the box belongs at the start of a segment.
 *
 * Returns a copy; the input is left alone. A segment carrying no `wmpi` box comes back unchanged.
 *
 * SEI and MPEG-TS carriage is *not* handled here. Zeroing six bytes inside an SEI NAL unit can
 * create a start-code emulation that would have to be re-escaped, changing the NAL's length and so
 * defeating the point of padding in place.
 *
 * @group Watermarking
 * @public
 */
export const zeroPadWmPaceInfo = (segment: Uint8Array): Uint8Array => {
	const out = segment.slice();
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

	eachBox(view, 0, out.length, (name, contentStart, contentEnd) => {
		if (name === 'wmpi') {
			out.fill(0, contentStart, contentEnd);
		}
	});
	return out;
};

/**
 * Read a segment's {@link WmPaceInfo} from whichever carrier it uses, or `null` when it carries
 * none. Tries the `wmpi` box first, then an SEI message under {@link WM_PACE_INFO_SEI_UUID}.
 *
 * A publisher chooses the carrier; a consumer should not have to know which. The SEI is found by
 * its UUID rather than by walking the sample tables. The payload is un-escaped before decoding as
 * a safeguard only: the structure's two fixed emulation bits exist precisely so a well-formed
 * `WMPaceInfo` never contains adjacent zero bytes and so never needs escaping.
 *
 * @group Watermarking
 * @public
 */
export const readSegmentWmPaceInfo = (segment: Uint8Array): WmPaceInfo | null => {
	const fromBox = readWmPaceInfo(segment);
	if (fromBox !== null) {
		return fromBox;
	}

	const uuid = WM_PACE_INFO_SEI_UUID;
	for (let at = 0; at + uuid.length + WM_PACE_INFO_SIZE <= segment.length; at++) {
		if (segment[at] !== uuid[0]) {
			continue;
		}
		let matched = true;
		for (let i = 1; i < uuid.length; i++) {
			if (segment[at + i] !== uuid[i]) {
				matched = false;
				break;
			}
		}
		if (!matched) {
			continue;
		}

		// Reads two bytes further than the structure in case malformed data did get escaped.
		const payload = removeEmulationPreventionBytes(
			segment.subarray(at + uuid.length, at + uuid.length + WM_PACE_INFO_SIZE + 2),
		);
		if (payload.length < WM_PACE_INFO_SIZE || payload.every(byte => byte === 0)) {
			return null;
		}
		try {
			return decodeWmPaceInfo(payload);
		} catch {
			return null;
		}
	}
	return null;
};

/** One segment's byte range and the metadata it carries. @group Watermarking @public */
export type SegmentWmPaceInfo = {
	/** Offset of the segment's first byte, into the bytes that were given. */
	offset: number;
	/** Size of the whole segment in bytes. */
	size: number;
	/** What that segment carries, or `null` when it carries none. */
	wmPaceInfo: WmPaceInfo | null;
};

/**
 * Read every segment's {@link WmPaceInfo} from a fragmented file, in order — the list a byterange
 * watermarking sidecar is built from. The init segment is reported too, since the byterange form
 * must cover it, and it normally carries nothing.
 *
 * @group Watermarking
 * @public
 */
export const readAllWmPaceInfo = (bytes: Uint8Array): SegmentWmPaceInfo[] => {
	const layout = segmentsOf(bytes);
	const entries: SegmentWmPaceInfo[] = [];

	if (layout.init !== null) {
		const { offset, size } = layout.init;
		entries.push({ offset, size, wmPaceInfo: readSegmentWmPaceInfo(bytes.subarray(offset, offset + size)) });
	}
	for (const segment of layout.segments) {
		entries.push({
			offset: segment.offset,
			size: segment.size,
			wmPaceInfo: readSegmentWmPaceInfo(bytes.subarray(segment.offset, segment.offset + segment.size)),
		});
	}
	return entries;
};
