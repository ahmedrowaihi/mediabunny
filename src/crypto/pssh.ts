/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2017 Google LLC. All rights reserved.
 * Original source: shaka-packager/packager/media/base/playready_pssh_generator.cc
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { Aes128CbcContext } from '../aes';
import type { ProtectionScheme } from './subsample-generator';

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
/**
 * PlayReady DRM system ID.
 *
 * @group Encryption
 * @public
 */
export const PLAYREADY_SYSTEM_ID = '9a04f079-9840-4286-ab92-e65be0885f95';

const u32 = (value: number): number[] => [
	(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
];
const u16le = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32le = (value: number): number[] => [
	value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
const chars = (text: string): number[] => [...text].map(c => c.charCodeAt(0));
const utf16le = (text: string): number[] => {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		out.push(code & 0xff, (code >>> 8) & 0xff);
	}
	return out;
};
const base64 = (bytes: Uint8Array): string => {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
};
const escapeXml = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

const PLAYREADY_NS = 'http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader';

// shaka's ConvertGuidEndianness: the KID's first three GUID groups are little-endian, 8-15 as-is.
const playReadyGuid = (kid: Uint8Array): Uint8Array => Uint8Array.from([
	kid[3]!, kid[2]!, kid[1]!, kid[0]!,
	kid[5]!, kid[4]!,
	kid[7]!, kid[6]!,
	...kid.subarray(8, 16),
]);

// AES-128-ECB of a single block (used for the v4.0 header checksum), via the fork's CBC context with a zero IV.
const aesEcb = (key: Uint8Array, block: Uint8Array): Uint8Array => {
	const context = new Aes128CbcContext();
	context.init({ key, iv: new Uint8Array(16) });
	context.setIv(new Uint8Array(16));
	context.in.set(block);
	context.encrypt();
	return new Uint8Array(context.out);
};

/**
 * Build a PlayReady Object (PRO): a single Rights Management Header record wrapping a `WRMHEADER`.
 * Mirrors shaka-packager's `PlayReadyPsshGenerator` — cenc/cens use a v4.0.0.0 `AESCTR` header with
 * a checksum (base64 of the first 8 bytes of `AES-ECB(key, byte-swapped KID)`, so `key` is required);
 * cbcs/cbc1 use a v4.3.0.0 `AESCBC` header (no checksum). `laUrl` adds a `<LA_URL>`.
 *
 * @group Encryption
 * @public
 */
export const buildPlayReadyObject = (
	kid: Uint8Array, opts: { scheme?: ProtectionScheme; key?: Uint8Array; laUrl?: string } = {},
): Uint8Array => {
	const scheme = opts.scheme ?? 'cbcs';
	const kidBase64 = base64(playReadyGuid(kid));
	const extra = opts.laUrl !== undefined ? `<LA_URL>${escapeXml(opts.laUrl)}</LA_URL>` : '';

	let wrmHeader: string;
	if (scheme === 'cenc' || scheme === 'cens') {
		if (opts.key === undefined) {
			throw new Error('PlayReady PSSH for cenc/cens needs the content key (for the header checksum).');
		}
		const checksum = base64(aesEcb(opts.key, playReadyGuid(kid)).subarray(0, 8));
		wrmHeader = `<WRMHEADER xmlns="${PLAYREADY_NS}" version="4.0.0.0"><DATA>`
			+ `<PROTECTINFO><KEYLEN>16</KEYLEN><ALGID>AESCTR</ALGID></PROTECTINFO>`
			+ `<KID>${kidBase64}</KID><CHECKSUM>${checksum}</CHECKSUM>${extra}</DATA></WRMHEADER>`;
	} else {
		wrmHeader = `<WRMHEADER xmlns="${PLAYREADY_NS}" version="4.3.0.0"><DATA>`
			+ `<PROTECTINFO><KIDS><KID ALGID="AESCBC" VALUE="${kidBase64}"></KID></KIDS></PROTECTINFO>${extra}`
			+ `</DATA></WRMHEADER>`;
	}

	// PlayReady Header Object: [total size u32 LE][record count u16 LE] + record[type u16 LE][length u16 LE][utf16].
	const record = utf16le(wrmHeader);
	const totalSize = 6 + 4 + record.length;
	return Uint8Array.from([
		...u32le(totalSize),
		...u16le(1),
		...u16le(1),
		...u16le(record.length),
		...record,
	]);
};

/**
 * Build a PlayReady `pssh` box (version 0) for a single key ID. Mirrors shaka-packager's
 * `PlayReadyPsshGenerator`; see {@link buildPlayReadyObject} for the scheme/key requirements.
 *
 * @group Encryption
 * @public
 */
export const buildPlayReadyPssh = (
	kid: Uint8Array, opts?: { scheme?: ProtectionScheme; key?: Uint8Array; laUrl?: string },
): Uint8Array =>
	psshBox(PLAYREADY_SYSTEM_ID, buildPlayReadyObject(kid, opts), []);
