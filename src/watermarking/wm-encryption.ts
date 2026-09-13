/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { encryptCmafInit, encryptCmafSegment, type EncryptCmafOptions } from '../crypto/cmaf-encryptor';
import { parseBoxes, type MutableBox } from '../crypto/box-tree';

/**
 * Derive one A/B variant's IV from the base IV shared by the presentation.
 *
 * Watermarked variants must share a content key, so that one DRM license decrypts whichever
 * variant a viewer is served. That leaves the IV as the only thing separating them, and it has to
 * do real work: two variants encrypted under the same key *and* IV differ in ciphertext at exactly
 * the bytes where their plaintexts differ, so XORing them locates the watermark without any key.
 *
 * The variant lands in the most significant byte, while {@link EncryptCmafOptions.iv} advances
 * from the least significant end, so one variant's IV sequence would have to run for 2^56 samples
 * (8-byte IV) or 2^120 blocks (16-byte IV) before it could reach another's starting point.
 *
 * @group Watermarking
 * @public
 */
export const variantIv = (baseIv: Uint8Array, variant: number): Uint8Array => {
	if (baseIv.length !== 8 && baseIv.length !== 16) {
		throw new TypeError('A CENC IV is 8 or 16 bytes.');
	}
	if (!Number.isInteger(variant) || variant < 0 || variant > 0xff) {
		throw new TypeError('A watermarking variant index is an integer in [0, 255].');
	}

	const iv = new Uint8Array(baseIv);
	iv[0] = (iv[0]! + variant) & 0xff;
	return iv;
};

// `tenc` layout after the FullBox header: reserved, pattern, default_is_protected,
// default_per_sample_IV_size, default_KID[16], then the constant IV when there is no per-sample one.
const TENC_IS_PROTECTED = 6;
const TENC_PER_SAMPLE_IV_SIZE = 7;
const TENC_CONSTANT_IV_SIZE = 24;

const tencConstantIvs = (init: Uint8Array): Uint8Array[] => {
	const found: Uint8Array[] = [];
	const walk = (boxes: MutableBox[]): void => {
		for (const box of boxes) {
			const data = box.data;
			if (
				box.type === 'tenc' && data !== undefined && data.length > TENC_CONSTANT_IV_SIZE
				&& data[TENC_IS_PROTECTED] !== 0 && data[TENC_PER_SAMPLE_IV_SIZE] === 0
			) {
				const size = data[TENC_CONSTANT_IV_SIZE]!;
				found.push(data.subarray(TENC_CONSTANT_IV_SIZE + 1, TENC_CONSTANT_IV_SIZE + 1 + size));
			}
			if (box.children !== undefined) {
				walk(box.children);
			}
		}
	};
	walk(parseBoxes(init, 0, init.length));
	return found;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Each variant's per-track IV state, carried across that variant's segments. Create one per
 * encrypted presentation and pass it to every call: it is partitioned by variant internally, so
 * two variants can never advance the same track's IV.
 *
 * @group Watermarking
 * @public
 */
export type WmVariantIvState = Map<number, Map<number, Uint8Array>>;

/**
 * Encrypt one segment of one A/B watermarking variant.
 *
 * This is {@link encryptCmafSegment} with the variant separation applied for you: it takes a
 * `baseIv` and a `variant` rather than an `iv`, so a caller cannot hand two variants the same
 * keystream, and it partitions `ivState` per variant so they cannot converge on one later either.
 *
 * `cbcs` is supported, but only against a per-variant init segment. Its IV is a constant in the
 * init rather than per sample, so two variants sharing one init would share that constant IV, and
 * CBC then leaks the position of the first differing block of every protected range. Rather than
 * trust the caller, this reads the init's `tenc` and refuses unless it carries this variant's own
 * IV — build it with `encryptCmafInit` using `variantIv(baseIv, variant)`. A per-variant init is
 * natural under byterange delivery, where each variant is its own file; under discrete-file
 * delivery the init is shared by design, so there use `cenc`, `cens` or `cbc1`.
 *
 * @throws When the scheme is `cbcs` and the init does not state this variant's constant IV.
 *
 * @group Watermarking
 * @public
 */
export const encryptVariantSegment = (
	init: Uint8Array,
	segment: Uint8Array,
	options: Omit<EncryptCmafOptions, 'iv'> & {
		/** The IV shared by the presentation, from which each variant's own IV is derived. */
		baseIv: Uint8Array;
		/** Which variant this segment belongs to, numbered from 0 for variant A. */
		variant: number;
		/** State for every variant, created once and passed to every call. */
		ivState: WmVariantIvState;
	},
): Uint8Array => {
	const scheme = options.scheme ?? 'cbcs';
	const iv = variantIv(options.baseIv, options.variant);

	if (scheme === 'cbcs') {
		// cbcs keeps its IV as a constant in the init rather than per sample, so the init has to be
		// this variant's own. Checking it is what makes cbcs safe here: a shared init cannot pass.
		const constants = tencConstantIvs(init);
		if (constants.length === 0) {
			throw new Error(
				'cbcs A/B watermarking needs an init segment encrypted for this variant, but the one given'
				+ ' states no constant IV. Build it with encryptCmafInit using variantIv(baseIv, variant).',
			);
		}
		const wrong = constants.filter(constant => !sameBytes(constant, iv));
		if (wrong.length > 0) {
			throw new Error(
				`cbcs A/B watermarking needs one init segment per variant: the init given states a constant IV`
				+ ` that is not variant ${options.variant}'s. Sharing an init across variants would encrypt both`
				+ ` under the same key and IV, and their ciphertexts would then reveal exactly where they differ.`,
			);
		}
	}

	let trackIvs = options.ivState.get(options.variant);
	if (trackIvs === undefined) {
		trackIvs = new Map();
		options.ivState.set(options.variant, trackIvs);
	}

	return encryptCmafSegment(init, segment, { ...options, iv, ivState: trackIvs });
};

/**
 * An A/B variant's init segment and a way to encrypt its media segments, both derived from one
 * base IV.
 *
 * @group Watermarking
 * @public
 */
export type VariantEncryptor = {
	/** This variant's encrypted init segment. */
	readonly init: Uint8Array;
	/** Encrypt the next segment of this variant, in presentation order. */
	encryptSegment: (segment: Uint8Array) => Uint8Array;
};

/**
 * Encrypt one A/B watermarking variant as a unit: its init segment and then its media segments,
 * all from one `baseIv` and one `variant`.
 *
 * The two schemes need different things of the init, which is the reason to state the base IV and
 * the variant once rather than at each call. Under `cenc` the init carries only an IV *size*, so
 * every variant's init is byte-identical and one can legitimately be shared. Under `cbcs` the init
 * carries the constant IV itself, so each variant needs its own — and `encryptSegment` verifies
 * that, rather than trusting the caller to have paired them.
 *
 * Carries each track's IV across segments internally, so segments must be passed in presentation
 * order. Create one of these per variant per presentation.
 *
 * @group Watermarking
 * @public
 */
export const variantEncryptor = (
	init: Uint8Array,
	options: Omit<EncryptCmafOptions, 'iv'> & {
		/** The IV shared by the presentation, from which this variant's own IV is derived. */
		baseIv: Uint8Array;
		/** Which variant this is, numbered from 0 for variant A. */
		variant: number;
	},
): VariantEncryptor => {
	const encryptedInit = encryptCmafInit(init, {
		...options,
		iv: variantIv(options.baseIv, options.variant),
	});
	const ivState: WmVariantIvState = new Map();

	return {
		init: encryptedInit,
		encryptSegment: (segment: Uint8Array) =>
			encryptVariantSegment(encryptedInit, segment, { ...options, ivState }),
	};
};
