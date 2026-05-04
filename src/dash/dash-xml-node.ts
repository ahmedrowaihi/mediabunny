/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/mpd/base/xml/xml_node.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import type { Element } from './dash-content-protection';
import { floatToXmlString } from './dash-mpd-utils';

/**
 * Strict RFC 3986 percent-encoder. Equivalent to `curl_easy_escape`, which shaka
 * uses for `addUrlEncodedContent` / `setUrlEncodedContent`. Encodes every byte
 * except the unreserved set `A-Z a-z 0-9 - _ . ~`.
 *
 * @internal
 */
const urlEncode = (input: string): string => {
	const bytes = new TextEncoder().encode(input);
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		const isUnreserved = (b >= 0x41 && b <= 0x5a) // A-Z
			|| (b >= 0x61 && b <= 0x7a) // a-z
			|| (b >= 0x30 && b <= 0x39) // 0-9
			|| b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e; // - _ . ~
		if (isUnreserved) {
			out += String.fromCharCode(b);
		} else {
			out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
		}
	}
	return out;
};

/**
 * RFC 3986 path-component encoder that preserves the path-segment
 * delimiter `/`. Encodes everything not in the `pchar` set (`unreserved
 * / sub-delims / ":" / "@"`) plus `?` and `#` (which terminate the path
 * in a URI). Unlike {@link urlEncode}, this is suitable for DASH
 * `<BaseURL>` elements that carry RFC 3986 URI references with literal
 * path separators (e.g. `../cmaf/foo.mp4`).
 *
 * Output is byte-identical to {@link urlEncode} for inputs containing
 * only `unreserved` characters — meaning shaka's test corpus emits the
 * same XML through either encoder. The two diverge only when the input
 * carries `/`, sub-delims, `:`, or `@`.
 *
 * @internal
 */
const urlEncodePathPreservingSlashes = (input: string): string => {
	const bytes = new TextEncoder().encode(input);
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		const isUnreserved = (b >= 0x41 && b <= 0x5a) // A-Z
			|| (b >= 0x61 && b <= 0x7a) // a-z
			|| (b >= 0x30 && b <= 0x39) // 0-9
			|| b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e; // - _ . ~
		// pchar = unreserved / pct-encoded / sub-delims / ":" / "@"
		// sub-delims = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
		// Plus "/" as path-segment delimiter (preserved). "?" and "#" are NOT
		// included — they terminate the path in a URI.
		const isSubDelim = b === 0x21 || b === 0x24 || b === 0x26 || b === 0x27
			|| b === 0x28 || b === 0x29 || b === 0x2a || b === 0x2b
			|| b === 0x2c || b === 0x3b || b === 0x3d;
		const isPathSafe = isUnreserved || isSubDelim
			|| b === 0x3a // ":"
			|| b === 0x40 // "@"
			|| b === 0x2f; // "/" — preserved as path-segment delimiter
		if (isPathSafe) {
			out += String.fromCharCode(b);
		} else {
			out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
		}
	}
	return out;
};

/**
 * Escape a string for use in XML attribute values: ` & " < > ` become entities.
 *
 * @internal
 */
const escapeAttribute = (s: string): string => {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		switch (ch) {
			case '&':
				out += '&amp;';
				break;
			case '"':
				out += '&quot;';
				break;
			case '<':
				out += '&lt;';
				break;
			case '>':
				out += '&gt;';
				break;
			default:
				out += ch;
		}
	}
	return out;
};

/**
 * Escape a string for use in XML text content: ` & < > ` become entities.
 * Quotes are not escaped in text per the XML 1.0 spec.
 *
 * @internal
 */
const escapeContent = (s: string): string => {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		switch (ch) {
			case '&':
				out += '&amp;';
				break;
			case '<':
				out += '&lt;';
				break;
			case '>':
				out += '&gt;';
				break;
			default:
				out += ch;
		}
	}
	return out;
};

/**
 * Collect any `prefix` from a name shaped `prefix:local`.
 *
 * @internal
 */
const collectNamespaceFromName = (name: string, namespaces: Set<string>): void => {
	const pos = name.indexOf(':');
	if (pos !== -1) {
		namespaces.add(name.slice(0, pos));
	}
};

/**
 * Wrapper for a single XML element used by the DASH MPD generator. Mirrors
 * shaka-packager's `xml::XmlNode` (libxml2-backed) with a pure-TS implementation.
 *
 * Build a tree by constructing nodes, attaching attributes / content / children,
 * then call {@link XmlNode.toString} to render. The renderer matches shaka's
 * `xmlDocDumpFormatMemoryEnc` "nice format" output: 2-space indentation, attributes
 * inline, self-closing empty elements, and the `<?xml version="1.0" encoding="UTF-8"?>`
 * declaration as the first line.
 *
 * @group DASH
 * @public
 */
export class XmlNode {
	/** @internal */
	private readonly nodeName: string;
	/** @internal */
	private readonly attributes = new Map<string, string>();
	/** @internal */
	private content = '';
	/** @internal */
	private readonly children: XmlNode[] = [];

	constructor(name: string) {
		this.nodeName = name;
	}

	/**
	 * Append a child node. Always returns `true` in this TS port — the original
	 * libxml2-backed implementation could fail on allocation; we cannot.
	 */
	addChild(child: XmlNode): boolean {
		this.children.push(child);
		return true;
	}

	/**
	 * Build child nodes recursively from a list of {@link Element} descriptors.
	 * Mirrors shaka's `AddElements` exactly: each element's content is set first,
	 * then its subelements are added (shaka notes the order matters because
	 * setting content after subelements would clobber them in libxml2).
	 */
	addElements(elements: Element[]): boolean {
		for (const element of elements) {
			const childNode = new XmlNode(element.name);
			for (const [key, value] of element.attributes) {
				if (!childNode.setStringAttribute(key, value)) {
					return false;
				}
			}
			childNode.setContent(element.content);
			if (!childNode.addElements(element.subelements)) {
				return false;
			}
			if (!this.addChild(childNode)) {
				return false;
			}
		}
		return true;
	}

	/** Set a string attribute. Returns `true` (always succeeds in this port). */
	setStringAttribute(name: string, value: string): boolean {
		this.attributes.set(name, value);
		return true;
	}

	/** Set an integer attribute. The number is rendered as its decimal string form. */
	setIntegerAttribute(name: string, number: number): boolean {
		this.attributes.set(name, String(number));
		return true;
	}

	/**
	 * Set a floating-point attribute. The number is formatted with up to 6
	 * decimals (trailing zeros and the trailing `.` are trimmed), matching
	 * shaka's `FloatToXmlString`.
	 */
	setFloatingPointAttribute(name: string, number: number): boolean {
		this.attributes.set(name, floatToXmlString(number));
		return true;
	}

	/** Convenience for `setIntegerAttribute('id', id)`. */
	setId(id: number): boolean {
		return this.setIntegerAttribute('id', id);
	}

	/** Append to this element's text content. */
	addContent(content: string): void {
		this.content += content;
	}

	/** Append a URL-encoded version of `content` to this element's text content. */
	addUrlEncodedContent(content: string): void {
		this.addContent(urlEncode(content));
	}

	/**
	 * Replace this element's text content. Use only for text — angle brackets
	 * become `&lt;` / `&gt;` on emit, so this cannot smuggle child elements.
	 */
	setContent(content: string): void {
		this.content = content;
	}

	/** Replace this element's text content with a URL-encoded version of `content`. */
	setUrlEncodedContent(content: string): void {
		this.setContent(urlEncode(content));
	}

	/**
	 * Replace this element's text content with an RFC 3986 path-component
	 * encoded version of `content`, preserving `/` as a path separator.
	 *
	 * Used for `<BaseURL>` elements where the value is an RFC 3986 URI
	 * reference (DASH §5.6) — literal path separators must survive into
	 * the output so player URI resolution works correctly. Output matches
	 * {@link XmlNode.setUrlEncodedContent} byte-for-byte for inputs with
	 * only `unreserved` characters (the shape shaka's tests cover).
	 *
	 * Deviates from shaka-packager's `xml::XmlNode::SetUrlEncodedContent`
	 * (which uses curl-style whole-string encoding and percent-encodes
	 * `/` to `%2F` — incorrect for path-component values).
	 */
	setPathContent(content: string): void {
		this.setContent(urlEncodePathPreservingSlashes(content));
	}

	/**
	 * Returns the set of namespace prefixes referenced by this node and all of
	 * its descendants. Both element names and attribute names of the form
	 * `prefix:local` contribute to the result.
	 */
	extractReferencedNamespaces(): Set<string> {
		const namespaces = new Set<string>();
		this.collectNamespacesInto(namespaces);
		return namespaces;
	}

	/** @internal */
	private collectNamespacesInto(namespaces: Set<string>): void {
		collectNamespaceFromName(this.nodeName, namespaces);
		for (const attrName of this.attributes.keys()) {
			collectNamespaceFromName(attrName, namespaces);
		}
		for (const child of this.children) {
			child.collectNamespacesInto(namespaces);
		}
	}

	/**
	 * Render the node and its descendants as a UTF-8 XML document string.
	 * Output begins with `<?xml version="1.0" encoding="UTF-8"?>`, optionally
	 * followed by an XML comment, then the element tree pretty-printed with
	 * 2-space indentation. Matches shaka's `xmlDocDumpFormatMemoryEnc` output
	 * with `kNiceFormat = 1`.
	 *
	 * @param comment - optional XML comment placed before the root element
	 */
	toString(comment = ''): string {
		const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
		if (comment) {
			lines.push(`<!--${comment}-->`);
		}
		this.renderInto(lines, 0);
		return lines.join('\n') + '\n';
	}

	/** @internal */
	private renderInto(lines: string[], indentLevel: number): void {
		const indent = '  '.repeat(indentLevel);
		const open = this.renderOpenTag();
		const hasChildren = this.children.length > 0;
		const hasContent = this.content.length > 0;

		if (!hasChildren && !hasContent) {
			lines.push(`${indent}<${open}/>`);
			return;
		}

		if (hasChildren) {
			lines.push(`${indent}<${open}>`);
			if (hasContent) {
				lines.push(`${'  '.repeat(indentLevel + 1)}${escapeContent(this.content)}`);
			}
			for (const child of this.children) {
				child.renderInto(lines, indentLevel + 1);
			}
			lines.push(`${indent}</${this.nodeName}>`);
			return;
		}

		// Content-only element renders inline on a single line.
		lines.push(`${indent}<${open}>${escapeContent(this.content)}</${this.nodeName}>`);
	}

	/** @internal */
	private renderOpenTag(): string {
		let open = this.nodeName;
		for (const [name, value] of this.attributes) {
			open += ` ${name}="${escapeAttribute(value)}"`;
		}
		return open;
	}

	/** Returns the value for `name` if set, otherwise `undefined`. */
	getAttribute(name: string): string | undefined {
		return this.attributes.get(name);
	}
}
