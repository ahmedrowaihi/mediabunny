/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SMPTE ST 2067-5 puts an IMSC document in an MXF track file of its own, described by a set 377M does
// not define. The standard is not public; everything here is read out of a real IMSC track file - the
// plugfest sample in Netflix photon's test resources - rather than taken from a table.
//
// The set's interesting properties carry DYNAMIC local tags: 0xfffc to 0xffff in that file, assigned
// by its own primer pack. Another writer will number them differently, so they are matched by the UL
// the primer maps them to and never by the number.

import { textDecoder } from '../misc';
import type { LocalSet } from './mxf-klv';

/** Item ULs of the properties this reads, as that file's primer states them. */
const UL_RESOURCE_ID = '060e2b340101010c0101151200000000';
const UL_UCS_ENCODING = '060e2b340101010c0409050000000000';
const UL_NAMESPACE_URI = '060e2b34010101080102010501000000';
const UL_LANGUAGE_TAGS = '060e2b340101010e0301010202160000';

/**
 * What a timed text track file says about the document it carries.
 *
 * @internal
 */
export type MxfTimedTextInfo = {
	/** `ResourceID`, which a CPL's resource refers to. */
	resourceId: string | null;
	/** `UCSEncoding`, the character encoding of the document - `UTF-8` in everything seen. */
	encoding: string | null;
	/**
	 * `NamespaceURI`. Named for a namespace, but a real file states the **profile** there:
	 * `http://www.w3.org/ns/ttml/profile/imsc1/text`. Read as what the file says rather than matched
	 * against a namespace.
	 */
	namespaceUri: string | null;
	/** `RFC5646LanguageTagList`, as stated - a comma-separated list where there is more than one. */
	languages: string | null;
};

const hexOf = (bytes: Uint8Array) => {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}

	return out;
};

/** MXF writes these as UTF-16 big-endian, which `TextDecoder` names `utf-16be`. */
const readUtf16 = (value: Uint8Array) => {
	let out = '';
	for (let i = 0; i + 1 < value.length; i += 2) {
		const code = (value[i]! << 8) | value[i + 1]!;
		if (code === 0) {
			break; // A terminator, where the writer included one
		}

		out += String.fromCharCode(code);
	}

	return out;
};

/**
 * Reads an ST 2067-5 timed text descriptor, or returns `null` for a set that is not one.
 *
 * A set counts as one when its primer maps at least one of its tags to a property this knows: a
 * descriptor stating none of them describes something else, whatever set number it carries.
 *
 * @internal
 */
export const readTimedTextInfo = (
	descriptor: LocalSet | null,
	primer: Map<number, Uint8Array> | null,
): MxfTimedTextInfo | null => {
	if (!descriptor || !primer) {
		return null;
	}

	const byUl = new Map<string, Uint8Array>();
	for (const [tag, value] of descriptor) {
		const ul = primer.get(tag);
		if (ul) {
			byUl.set(hexOf(ul), value);
		}
	}

	const resourceId = byUl.get(UL_RESOURCE_ID);
	const encoding = byUl.get(UL_UCS_ENCODING);
	const namespaceUri = byUl.get(UL_NAMESPACE_URI);
	const languages = byUl.get(UL_LANGUAGE_TAGS);

	if (!resourceId && !encoding && !namespaceUri && !languages) {
		return null;
	}

	return {
		resourceId: resourceId ? hexOf(resourceId) : null,
		encoding: encoding ? readUtf16(encoding) : null,
		namespaceUri: namespaceUri ? readUtf16(namespaceUri) : null,
		languages: languages ? readUtf16(languages) : null,
	};
};

/**
 * Decodes a timed text essence run as the document it is.
 *
 * The descriptor states the encoding; anything other than UTF-8 is decoded as what it says. A leading
 * byte order mark needs no handling here - `TextDecoder` consumes one unless asked not to, and an XML
 * parser handed one would treat it as content.
 *
 * @internal
 */
export const decodeTimedTextDocument = (bytes: Uint8Array, encoding: string | null) => {
	const label = (encoding ?? 'utf-8').toLowerCase();
	const decoder = label === 'utf-8' || label === 'utf8'
		? textDecoder
		: new TextDecoder(label);

	return decoder.decode(bytes);
};
