/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Widevine DRM system ID.
 *
 * @group Encryption
 * @public
 */
export const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
/**
 * W3C Common Encryption / ClearKey system ID (ISO/IEC 23001-7).
 *
 * @group Encryption
 * @public
 */
export const COMMON_SYSTEM_ID = '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b';

const u32 = (value: number): number[] => [
	(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
];
const chars = (text: string): number[] => [...text].map(c => c.charCodeAt(0));

const uuidToBytes = (uuid: string): Uint8Array => {
	const hex = uuid.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
};

// A `pssh` box (ISO/IEC 23001-7 §8.1): version 1 carries a KID list, version 0 carries none.
const psshBox = (systemId: string, data: Uint8Array, kids: Uint8Array[]): Uint8Array => {
	const version = kids.length > 0 ? 1 : 0;
	const body: number[] = [
		version, 0, 0, 0, // version + flags
		...uuidToBytes(systemId),
	];
	if (version === 1) {
		body.push(...u32(kids.length));
		for (const kid of kids) {
			body.push(...kid);
		}
	}
	body.push(...u32(data.byteLength), ...data);

	const size = 8 + body.length;
	return Uint8Array.from([...u32(size), ...chars('pssh'), ...body]);
};

/**
 * Build a Widevine `pssh` box for a single key ID. The init data is the minimal Widevine protobuf
 * (`key_id` field only). Mirrors shaka-packager / the archived SPEKE `buildWidevinePssh`.
 *
 * @group Encryption
 * @public
 */
export const buildWidevinePssh = (kid: Uint8Array): Uint8Array => {
	// Widevine PSSH data protobuf: field 2 (key_id), length-delimited, 16-byte value.
	const data = Uint8Array.from([0x12, 0x10, ...kid]);
	return psshBox(WIDEVINE_SYSTEM_ID, data, []);
};

/**
 * Build a W3C Common Encryption `pssh` box (version 1) carrying the key IDs, with empty data. Used
 * for ClearKey and as a system-agnostic KID carrier that any CENC-aware player can read.
 *
 * @group Encryption
 * @public
 */
export const buildCommonPssh = (kids: Uint8Array[]): Uint8Array =>
	psshBox(COMMON_SYSTEM_ID, new Uint8Array(0), kids);
