/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AES_128_BLOCK_SIZE, Aes128CbcContext } from '../aes';

/**
 * Options for {@link encryptHlsAes128}.
 *
 * @group Encryption
 * @public
 */
export type HlsAes128Options = {
	/** The 16-byte AES-128 key. */
	key: Uint8Array;
	/** The 16-byte initialization vector (HLS `EXT-X-KEY` `IV`, or the media sequence number). */
	iv: Uint8Array;
};

/**
 * Encrypt a whole media segment with HLS AES-128 (`EXT-X-KEY:METHOD=AES-128`): AES-128-CBC over the
 * entire segment with PKCS#7 padding. Container-agnostic — works on an MPEG-TS or fMP4 segment alike,
 * since the whole file is treated as an opaque byte stream. Pair with {@link buildHlsAes128KeyTag}.
 *
 * @group Encryption
 * @public
 */
export const encryptHlsAes128 = (segment: Uint8Array, opts: HlsAes128Options): Uint8Array => {
	const context = new Aes128CbcContext();
	context.init({ key: opts.key, iv: opts.iv });

	// PKCS#7: always append 1..16 padding bytes so the length is a whole number of blocks.
	const padLength = AES_128_BLOCK_SIZE - (segment.length % AES_128_BLOCK_SIZE);
	const padded = new Uint8Array(segment.length + padLength);
	padded.set(segment);
	padded.fill(padLength, segment.length);

	const out = new Uint8Array(padded.length);
	for (let offset = 0; offset < padded.length; offset += AES_128_BLOCK_SIZE) {
		context.in.set(padded.subarray(offset, offset + AES_128_BLOCK_SIZE));
		context.encrypt();
		out.set(context.out, offset);
	}
	return out;
};

const toHex = (bytes: Uint8Array): string =>
	[...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Build the HLS `#EXT-X-KEY` tag for an AES-128 encrypted segment run. Place it in the media playlist
 * before the segments it applies to.
 *
 * @group Encryption
 * @public
 */
export const buildHlsAes128KeyTag = (opts: { uri: string; iv?: Uint8Array; keyFormat?: string }): string => {
	const attributes = ['METHOD=AES-128', `URI="${opts.uri}"`];
	if (opts.iv !== undefined) {
		attributes.push(`IV=0x${toHex(opts.iv)}`);
	}
	if (opts.keyFormat !== undefined) {
		attributes.push(`KEYFORMAT="${opts.keyFormat}"`);
	}
	return `#EXT-X-KEY:${attributes.join(',')}`;
};
