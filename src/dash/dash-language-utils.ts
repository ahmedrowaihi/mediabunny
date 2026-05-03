/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2015 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/media/base/language_utils.{h,cc}
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * ISO 639-2 (3-letter) → ISO 639-1 (2-letter) language code map. Verbatim
 * port of shaka's `kLanguageMap` from `language_utils.cc`. Some 3-letter codes
 * map to the same 2-letter code (e.g. `alb` and `sqi` both → `sq`).
 *
 * @internal
 */
const ISO_639_2_TO_ISO_639_1: ReadonlyArray<[string, string]> = [
	['aar', 'aa'], ['abk', 'ab'], ['afr', 'af'], ['aka', 'ak'], ['alb', 'sq'],
	['amh', 'am'], ['ara', 'ar'], ['arg', 'an'], ['arm', 'hy'], ['asm', 'as'],
	['ava', 'av'], ['ave', 'ae'], ['aym', 'ay'], ['aze', 'az'], ['bak', 'ba'],
	['bam', 'bm'], ['baq', 'eu'], ['bel', 'be'], ['ben', 'bn'], ['bih', 'bh'],
	['bis', 'bi'], ['bod', 'bo'], ['bos', 'bs'], ['bre', 'br'], ['bul', 'bg'],
	['bur', 'my'], ['cat', 'ca'], ['ces', 'cs'], ['cha', 'ch'], ['che', 'ce'],
	['chi', 'zh'], ['chu', 'cu'], ['chv', 'cv'], ['cor', 'kw'], ['cos', 'co'],
	['cre', 'cr'], ['cym', 'cy'], ['cze', 'cs'], ['dan', 'da'], ['deu', 'de'],
	['div', 'dv'], ['dut', 'nl'], ['dzo', 'dz'], ['ell', 'el'], ['eng', 'en'],
	['epo', 'eo'], ['est', 'et'], ['eus', 'eu'], ['ewe', 'ee'], ['fao', 'fo'],
	['fas', 'fa'], ['fij', 'fj'], ['fin', 'fi'], ['fra', 'fr'], ['fre', 'fr'],
	['fry', 'fy'], ['ful', 'ff'], ['geo', 'ka'], ['ger', 'de'], ['gla', 'gd'],
	['gle', 'ga'], ['glg', 'gl'], ['glv', 'gv'], ['gre', 'el'], ['grn', 'gn'],
	['guj', 'gu'], ['hat', 'ht'], ['hau', 'ha'], ['heb', 'he'], ['heb', 'iw'],
	['her', 'hz'], ['hin', 'hi'], ['hmo', 'ho'], ['hrv', 'hr'], ['hun', 'hu'],
	['hye', 'hy'], ['ibo', 'ig'], ['ice', 'is'], ['ido', 'io'], ['iii', 'ii'],
	['iku', 'iu'], ['ile', 'ie'], ['ina', 'ia'], ['ind', 'id'], ['ipk', 'ik'],
	['isl', 'is'], ['ita', 'it'], ['jav', 'jv'], ['jpn', 'ja'], ['kal', 'kl'],
	['kan', 'kn'], ['kas', 'ks'], ['kat', 'ka'], ['kau', 'kr'], ['kaz', 'kk'],
	['khm', 'km'], ['kik', 'ki'], ['kin', 'rw'], ['kir', 'ky'], ['kom', 'kv'],
	['kon', 'kg'], ['kor', 'ko'], ['kua', 'kj'], ['kur', 'ku'], ['lao', 'lo'],
	['lat', 'la'], ['lav', 'lv'], ['lim', 'li'], ['lin', 'ln'], ['lit', 'lt'],
	['ltz', 'lb'], ['lub', 'lu'], ['lug', 'lg'], ['mac', 'mk'], ['mah', 'mh'],
	['mal', 'ml'], ['mao', 'mi'], ['mar', 'mr'], ['may', 'ms'], ['mkd', 'mk'],
	['mlg', 'mg'], ['mlt', 'mt'], ['mon', 'mn'], ['mri', 'mi'], ['msa', 'ms'],
	['mya', 'my'], ['nau', 'na'], ['nav', 'nv'], ['nbl', 'nr'], ['nde', 'nd'],
	['ndo', 'ng'], ['nep', 'ne'], ['nld', 'nl'], ['nno', 'nn'], ['nob', 'nb'],
	['nor', 'no'], ['nya', 'ny'], ['oci', 'oc'], ['oji', 'oj'], ['ori', 'or'],
	['orm', 'om'], ['oss', 'os'], ['pan', 'pa'], ['per', 'fa'], ['pli', 'pi'],
	['pol', 'pl'], ['por', 'pt'], ['pus', 'ps'], ['que', 'qu'], ['roh', 'rm'],
	['ron', 'ro'], ['rum', 'ro'], ['run', 'rn'], ['rus', 'ru'], ['sag', 'sg'],
	['san', 'sa'], ['sin', 'si'], ['slk', 'sk'], ['slo', 'sk'], ['slv', 'sl'],
	['sme', 'se'], ['smo', 'sm'], ['sna', 'sn'], ['snd', 'sd'], ['som', 'so'],
	['sot', 'st'], ['spa', 'es'], ['sqi', 'sq'], ['srd', 'sc'], ['srp', 'sr'],
	['ssw', 'ss'], ['sun', 'su'], ['swa', 'sw'], ['swe', 'sv'], ['tah', 'ty'],
	['tam', 'ta'], ['tat', 'tt'], ['tel', 'te'], ['tgk', 'tg'], ['tgl', 'tl'],
	['tha', 'th'], ['tib', 'bo'], ['tir', 'ti'], ['ton', 'to'], ['tsn', 'tn'],
	['tso', 'ts'], ['tuk', 'tk'], ['tur', 'tr'], ['twi', 'tw'], ['uig', 'ug'],
	['ukr', 'uk'], ['urd', 'ur'], ['uzb', 'uz'], ['ven', 've'], ['vie', 'vi'],
	['vol', 'vo'], ['wel', 'cy'], ['wln', 'wa'], ['wol', 'wo'], ['xho', 'xh'],
	['yid', 'yi'], ['yor', 'yo'], ['zha', 'za'], ['zho', 'zh'], ['zul', 'zu'],
];

/**
 * Splits a BCP-47 / RFC-5646 language tag at the first hyphen into the main
 * language code and an optional subtag (preserving the leading `-`).
 *
 * @internal
 */
const splitLanguageTag = (tag: string): { mainLanguage: string; subtag: string } => {
	const dash = tag.indexOf('-');
	if (dash === -1) {
		return { mainLanguage: tag, subtag: '' };
	}
	return { mainLanguage: tag.slice(0, dash), subtag: tag.slice(dash) };
};

/**
 * Returns the BCP-47-compliant shortest form of a language code: prefers the
 * 2-letter ISO 639-1 code when one exists. Mirrors shaka's
 * `LanguageToShortestForm`. Subtags (e.g. `-US`) are preserved unchanged.
 *
 * Examples:
 * - `'en'` → `'en'`
 * - `'eng'` → `'en'`
 * - `'eng-US'` → `'en-US'`
 * - `'mis'` → `'mis'` (no 2-letter code; passed through)
 * - `''` → `''`
 *
 * @group DASH
 * @public
 */
export const languageToShortestForm = (language: string): string => {
	if (language.length === 0) {
		return language;
	}

	const { mainLanguage, subtag } = splitLanguageTag(language);

	if (mainLanguage.length === 2) {
		// Already a 2-letter code; assumed valid ISO 639-1.
		return mainLanguage + subtag;
	}

	for (const [iso6392, iso6391] of ISO_639_2_TO_ISO_639_1) {
		if (mainLanguage === iso6392) {
			return iso6391 + subtag;
		}
	}

	// No 2-letter code exists — pass through the (presumably 3-letter) input.
	return mainLanguage + subtag;
};

/**
 * Returns the ISO 639-2 (3-letter) form of a language code. Mirrors shaka's
 * `LanguageToISO_639_2`. Returns `'und'` when no equivalent 3-letter code is
 * known for a 2-letter input.
 *
 * @group DASH
 * @public
 */
export const languageToISO6392 = (language: string): string => {
	const { mainLanguage, subtag } = splitLanguageTag(language);

	if (mainLanguage.length === 3) {
		return mainLanguage + subtag;
	}

	for (const [iso6392, iso6391] of ISO_639_2_TO_ISO_639_1) {
		if (mainLanguage === iso6391) {
			return iso6392 + subtag;
		}
	}

	return 'und';
};
