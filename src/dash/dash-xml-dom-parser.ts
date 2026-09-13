/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A minimal XML DOM for runtimes without `DOMParser`; it builds only what `parseMpd` reads

const escapeXml = (text: string) => text
	.replaceAll('&', '&amp;')
	.replaceAll('<', '&lt;')
	.replaceAll('>', '&gt;');

export class XmlElement {
	readonly children: XmlElement[] = [];
	textContent = '';

	constructor(
		readonly nodeName: string,
		readonly attributes: Map<string, string>,
		readonly namespaces: Map<string, string>,
	) {}

	get localName() {
		return this.nodeName.slice(this.nodeName.indexOf(':') + 1);
	}

	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}

	getAttributeNS(namespaceUri: string, localName: string) {
		for (const [prefix, uri] of this.namespaces) {
			const value = uri === namespaceUri ? this.attributes.get(`${prefix}:${localName}`) : undefined;
			if (value !== undefined) {
				return value;
			}
		}
		return this.attributes.get(localName) ?? null;
	}

	getElementsByTagName(name: string): XmlElement[] {
		return this.children.flatMap(child => [
			...(child.nodeName === name || child.localName === name ? [child] : []),
			...child.getElementsByTagName(name),
		]);
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	/** Serialize back to XML. Comments and processing instructions are not kept, and text follows child elements. */
	toXml(): string {
		const attributes = [...this.attributes]
			.map(([name, value]) => ` ${name}="${escapeXml(value).replaceAll('"', '&quot;')}"`)
			.join('');
		const inner = this.children.map(child => child.toXml()).join('') + escapeXml(this.textContent);

		return inner === ''
			? `<${this.nodeName}${attributes}/>`
			: `<${this.nodeName}${attributes}>${inner}</${this.nodeName}>`;
	}
}

/** Create a standalone element, for callers building nodes to insert into a parsed tree. */
export const createXmlElement = (nodeName: string, textContent = ''): XmlElement => {
	const element = new XmlElement(nodeName, new Map(), new Map());
	element.textContent = textContent;
	return element;
};

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const REFERENCE = /&(?:#x([\dA-Fa-f]+)|#(\d+)|(lt|gt|quot|apos|amp));/g;
const PREDEFINED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' };

const decodeReferences = (text: string) => {
	const decoded = text.replace(REFERENCE, (_, hex?: string, decimal?: string, name?: string) => hex
		? String.fromCodePoint(parseInt(hex, 16))
		: decimal
			? String.fromCodePoint(Number(decimal))
			: PREDEFINED_ENTITIES[name!]!,
	);
	if (text.replace(REFERENCE, '').includes('&')) {
		throw new Error(`unsupported entity reference in "${text.slice(0, 40)}"`);
	}
	return decoded;
};

export class MinimalDomParser {
	parseFromString(source: string) {
		const text = source
			// CDATA first: its content may contain what would otherwise look like markup or comments
			.replace(
				/<!\[CDATA\[([\s\S]*?)\]\]>/g,
				(_, data: string) => data.replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
			)
			.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*>/g, '');

		const stack: XmlElement[] = [];
		let root: XmlElement | null = null;

		const addText = (between: string) => {
			if (between.includes('<')) {
				throw new Error(`malformed markup near "${between.trim().slice(0, 40)}"`);
			}
			if (between.trim() === '') {
				return;
			}
			if (stack.length === 0) {
				throw new Error('text outside the root element');
			}
			stack.at(-1)!.textContent += decodeReferences(between.trim());
		};

		let lastIndex = 0;
		for (const match of text.matchAll(TAG)) {
			const [whole, closing, name, attributeText, selfClosing] = match;
			addText(text.slice(lastIndex, match.index));
			lastIndex = match.index + whole.length;

			if (closing) {
				if (stack.pop()?.nodeName !== name) {
					throw new Error(`unexpected </${name}>`);
				}
				continue;
			}
			if (root && stack.length === 0) {
				throw new Error('more than one root element');
			}

			const parent = stack.at(-1);
			const attributes = new Map<string, string>();
			const namespaces = new Map(parent?.namespaces);
			for (const [, attributeName, doubleQuoted, singleQuoted] of attributeText!.matchAll(ATTRIBUTE)) {
				const value = decodeReferences(doubleQuoted ?? singleQuoted ?? '');
				attributes.set(attributeName!, value);
				if (attributeName!.startsWith('xmlns:')) {
					namespaces.set(attributeName!.slice('xmlns:'.length), value);
				}
			}

			const element = new XmlElement(name!, attributes, namespaces);
			if (parent) {
				parent.children.push(element);
			} else {
				root = element;
			}
			if (!selfClosing) {
				stack.push(element);
			}
		}

		addText(text.slice(lastIndex));
		if (stack.length > 0) {
			throw new Error(`<${stack.at(-1)!.nodeName}> is not closed`);
		}
		if (!root) {
			throw new Error('no root element');
		}

		const documentElement: XmlElement = root;
		return {
			documentElement,
			getElementsByTagName: (name: string) => [
				...(documentElement.nodeName === name || documentElement.localName === name ? [documentElement] : []),
				...documentElement.getElementsByTagName(name),
			],
		};
	}
}
