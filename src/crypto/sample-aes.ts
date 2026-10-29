/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	addEmulationPreventionBytes,
	concatNalUnitsInAnnexB,
	extractNalUnitTypeForAvc,
	iterateNalUnitsInAnnexB,
	removeEmulationPreventionBytes,
} from '../codec-data';
import { MalformedInputError } from '../errors';
import { AesCbcEncryptor } from './aes-cbc-encryptor';

/**
 * Options for the SAMPLE-AES sample encryptors.
 *
 * @group Encryption
 * @public
 */
export type SampleAesOptions = {
	/** The 16-byte AES-128 key. */
	key: Uint8Array;
	/** The 16-byte IV, constant across the samples of a segment. */
	iv: Uint8Array;
};

const AAC_CLEAR_LEADER = 16;

/**
 * Encrypt one audio sample (AAC/AC-3 raw frame, i.e. the payload after the ADTS/codec header) with
 * Apple HLS SAMPLE-AES: the first 16 bytes stay clear, then all whole 16-byte blocks up to the last
 * block boundary are AES-128-CBC encrypted; a trailing partial block stays clear. Samples shorter
 * than 32 bytes have no encrypted region. Each sample uses the segment's constant IV.
 *
 * The inverse of hls.js's `SampleAesDecrypter.decryptAacSample`.
 *
 * @group Encryption
 * @public
 */
export const sampleAesEncryptAudioFrame = (frame: Uint8Array, options: SampleAesOptions): Uint8Array => {
	const out = new Uint8Array(frame);
	const end = out.length - (out.length % 16);
	if (end <= AAC_CLEAR_LEADER) {
		return out; // nothing past the clear leader forms a whole block
	}
	const cbc = new AesCbcEncryptor();
	cbc.initializeWithIv(options.key, options.iv);
	cbc.crypt(out.subarray(AAC_CLEAR_LEADER, end));
	return out;
};

/**
 * Encrypt one H.264 video NAL unit with Apple HLS SAMPLE-AES. Only coded-slice NAL units
 * (`nal_unit_type` 1 or 5) longer than 48 bytes are encrypted; the caller must filter by type. The
 * NAL's emulation-prevention bytes are removed first, then, starting at byte 32, every 10th 16-byte
 * block (stride 160) is collected while at least 16 bytes remain, AES-128-CBC encrypted as one
 * chained stream, and written back — a 1-in-10 protected-block pattern. Returns the
 * emulation-prevention-stripped NAL with those blocks encrypted.
 *
 * The inverse of hls.js's `SampleAesDecrypter.getAvcEncryptedData`/`getAvcDecryptedUnit`.
 *
 * @group Encryption
 * @public
 */
export const sampleAesEncryptVideoNal = (nal: Uint8Array, options: SampleAesOptions): Uint8Array => {
	const out = removeEmulationPreventionBytes(nal);
	const offsets = protectedBlockOffsets(out.length);
	if (offsets.length === 0) {
		return out;
	}
	// Collect the scattered protected blocks into one buffer, CBC-encrypt them as a chained stream,
	// then scatter the ciphertext back to the same offsets. (Iterate by value, not index, so the
	// standalone build's noUncheckedIndexedAccess doesn't widen the offset to number | undefined.)
	const gathered = new Uint8Array(offsets.length * 16);
	offsets.forEach((offset, i) => {
		gathered.set(out.subarray(offset, offset + 16), i * 16);
	});
	const cbc = new AesCbcEncryptor();
	cbc.initializeWithIv(options.key, options.iv);
	cbc.crypt(gathered);
	offsets.forEach((offset, i) => {
		out.set(gathered.subarray(i * 16, i * 16 + 16), offset);
	});
	return out;
};

/**
 * The byte offsets of the protected 16-byte blocks: 32, 192, 352, … while a whole block remains.
 * @internal
 */
export const protectedBlockOffsets = (nalLength: number): number[] => {
	const offsets: number[] = [];
	for (let pos = 32; pos < nalLength - 16; pos += 160) {
		offsets.push(pos);
	}
	return offsets;
};

/**
 * Encrypt one H.264 access unit in Annex B form with Apple HLS SAMPLE-AES, returning a new Annex B
 * buffer. Coded-slice NAL units (type 1 and 5) longer than 48 bytes are encrypted; every other NAL
 * is copied through untouched.
 *
 * Unlike {@link sampleAesEncryptVideoNal}, which leaves its result emulation-prevention-stripped,
 * this re-applies start code emulation prevention over the whole encrypted NAL, as Apple's spec
 * requires. In Annex B that is not optional: ciphertext containing `00 00 01` would otherwise read
 * as a start code and split the NAL.
 *
 * @group Encryption
 * @public
 */
export const sampleAesEncryptAnnexBAccessUnit = (data: Uint8Array, options: SampleAesOptions): Uint8Array => {
	const nalUnits: Uint8Array[] = [];

	for (const location of iterateNalUnitsInAnnexB(data)) {
		const nalUnit = data.subarray(location.offset, location.offset + location.length);
		const type = extractNalUnitTypeForAvc(nalUnit[0]!);

		if ((type === 1 || type === 5) && nalUnit.length > 48) {
			nalUnits.push(addEmulationPreventionBytes(sampleAesEncryptVideoNal(nalUnit, options)));
		} else {
			nalUnits.push(nalUnit);
		}
	}

	return concatNalUnitsInAnnexB(nalUnits);
};

/**
 * Encrypt one ADTS-framed AAC frame with Apple HLS SAMPLE-AES, returning a new buffer. The ADTS
 * header (7 bytes, or 9 when it carries a CRC) stays clear, as do the first 16 bytes of the frame
 * after it and any trailing partial block.
 *
 * @group Encryption
 * @public
 */
export const sampleAesEncryptAdtsFrame = (frame: Uint8Array, options: SampleAesOptions): Uint8Array => {
	if (frame.length < 7) {
		throw new MalformedInputError(`An ADTS frame is at least 7 bytes; got ${frame.length}.`);
	}

	// protection_absent is the low bit of byte 1; when it is clear a 2-byte CRC follows the header
	const headerLength = (frame[1]! & 0x01) === 0 ? 9 : 7;
	if (frame.length < headerLength) {
		throw new MalformedInputError(
			`This ADTS frame states a ${headerLength}-byte header but is only ${frame.length} bytes.`,
		);
	}

	const out = new Uint8Array(frame);
	out.set(sampleAesEncryptAudioFrame(out.subarray(headerLength), options), headerLength);
	return out;
};
