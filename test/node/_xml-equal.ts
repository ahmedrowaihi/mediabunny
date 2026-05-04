/*!
 * Test helper. Whitespace/attribute-order-tolerant XML structural comparator,
 * mirroring shaka-packager's `XmlEqual` / `XmlNodeEqual` (which use libxml2 to
 * parse both inputs and walk the resulting trees).
 *
 * Used by DASH port tests to verify that our XmlNode output matches shaka's
 * verbatim expected XML strings without depending on byte-level formatting
 * differences (libxml2 breaks long attribute lines, our pretty-printer does
 * not — but the tree contents are identical when correct).
 *
 * Not a public API.
 */

type ParsedXmlNode = {
	name: string;
	attributes: Map<string, string>;
	children: ParsedXmlNode[];
	text: string;
};

const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

const skipWhitespace = (s: string, i: number): number => {
	while (i < s.length && isWhitespace(s[i]!)) {
		i++;
	}
	return i;
};

const decodeEntities = (s: string): string => {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&amp;/g, '&');
};

const readName = (s: string, i: number): { name: string; index: number } => {
	const start = i;
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '/' || ch === '>' || ch === '=') {
			break;
		}
		i++;
	}
	return { name: s.slice(start, i), index: i };
};

const readAttributes = (s: string, i: number): { attrs: Map<string, string>; index: number; selfClose: boolean } => {
	const attrs = new Map<string, string>();
	while (i < s.length) {
		i = skipWhitespace(s, i);
		if (s[i] === '/') {
			i++;
			i = skipWhitespace(s, i);
			if (s[i] !== '>') {
				throw new Error(`expected > after / at ${i}`);
			}
			return { attrs, index: i + 1, selfClose: true };
		}
		if (s[i] === '>') {
			return { attrs, index: i + 1, selfClose: false };
		}
		const { name, index: nameEnd } = readName(s, i);
		i = skipWhitespace(s, nameEnd);
		if (s[i] !== '=') {
			throw new Error(`expected = after attr name "${name}" at ${i}`);
		}
		i = skipWhitespace(s, i + 1);
		const quote = s[i];
		if (quote !== '"' && quote !== '\'') {
			throw new Error(`expected attribute value quote at ${i}`);
		}
		const valueStart = i + 1;
		const valueEnd = s.indexOf(quote, valueStart);
		if (valueEnd === -1) {
			throw new Error(`unterminated attribute value at ${valueStart}`);
		}
		attrs.set(name, decodeEntities(s.slice(valueStart, valueEnd)));
		i = valueEnd + 1;
	}
	throw new Error('unterminated tag');
};

const skipDeclarationOrComment = (s: string, i: number): number => {
	if (s.startsWith('<?xml', i)) {
		const end = s.indexOf('?>', i);
		if (end === -1) {
			throw new Error('unterminated <?xml ?>');
		}
		return end + 2;
	}
	if (s.startsWith('<!--', i)) {
		const end = s.indexOf('-->', i);
		if (end === -1) {
			throw new Error('unterminated <!-- -->');
		}
		return end + 3;
	}
	return i;
};

const parseElement = (s: string, i: number): { node: ParsedXmlNode; index: number } => {
	if (s[i] !== '<') {
		throw new Error(`expected < at ${i}`);
	}
	i++;
	const { name, index: nameEnd } = readName(s, i);
	const { attrs, index: tagEnd, selfClose } = readAttributes(s, nameEnd);
	const node: ParsedXmlNode = { name, attributes: attrs, children: [], text: '' };
	if (selfClose) {
		return { node, index: tagEnd };
	}
	i = tagEnd;
	while (i < s.length) {
		i = skipWhitespace(s, i);
		if (s[i] === '<') {
			i = skipDeclarationOrComment(s, i);
			if (i < s.length && s[i] === '<' && s[i + 1] === '/') {
				// closing tag
				i += 2;
				const { name: closeName, index: closeNameEnd } = readName(s, i);
				if (closeName !== name) {
					throw new Error(`mismatched close tag: expected </${name}>, got </${closeName}>`);
				}
				i = skipWhitespace(s, closeNameEnd);
				if (s[i] !== '>') {
					throw new Error(`expected > at ${i}`);
				}
				return { node, index: i + 1 };
			}
			const child = parseElement(s, i);
			node.children.push(child.node);
			i = child.index;
		} else {
			// text content — collect until next < and trim
			const textStart = i;
			while (i < s.length && s[i] !== '<') {
				i++;
			}
			const text = decodeEntities(s.slice(textStart, i)).trim();
			if (text.length > 0) {
				node.text += (node.text ? ' ' : '') + text;
			}
		}
	}
	throw new Error(`unterminated element <${name}>`);
};

const parseRootElement = (s: string): ParsedXmlNode => {
	let i = 0;
	while (i < s.length) {
		i = skipWhitespace(s, i);
		if (i >= s.length) {
			break;
		}
		if (s.startsWith('<?xml', i) || s.startsWith('<!--', i)) {
			i = skipDeclarationOrComment(s, i);
			continue;
		}
		if (s[i] === '<') {
			return parseElement(s, i).node;
		}
		throw new Error(`unexpected character at ${i}: "${s[i]}"`);
	}
	throw new Error('no root element found');
};

const isNamespaceDecl = (key: string): boolean => key === 'xmlns' || key.startsWith('xmlns:');

const filterNamespaceAttrs = (attrs: Map<string, string>): Map<string, string> => {
	const out = new Map<string, string>();
	for (const [k, v] of attrs) {
		if (!isNamespaceDecl(k)) {
			out.set(k, v);
		}
	}
	return out;
};

const nodesEqual = (a: ParsedXmlNode, b: ParsedXmlNode): { equal: true } | { equal: false; reason: string } => {
	if (a.name !== b.name) {
		return { equal: false, reason: `element name mismatch: <${a.name}> vs <${b.name}>` };
	}
	// Ignore xmlns / xmlns:* attributes, mirroring shaka's libxml2-based
	// XmlNodeEqual which compares `node->properties` (excludes namespace
	// declarations stored in `node->nsDef`).
	const aAttrs = filterNamespaceAttrs(a.attributes);
	const bAttrs = filterNamespaceAttrs(b.attributes);
	if (aAttrs.size !== bAttrs.size) {
		const actualKeys = [...aAttrs.keys()].join(',');
		const expectedKeys = [...bAttrs.keys()].join(',');
		return {
			equal: false,
			reason: `<${a.name}> attribute count mismatch: ${aAttrs.size} vs ${bAttrs.size} `
				+ `(actual: [${actualKeys}]; expected: [${expectedKeys}])`,
		};
	}
	for (const [key, value] of aAttrs) {
		if (!bAttrs.has(key)) {
			return { equal: false, reason: `<${a.name}> has attribute "${key}" not in expected` };
		}
		if (bAttrs.get(key) !== value) {
			return {
				equal: false,
				reason: `<${a.name}> @${key} mismatch: "${value}" vs "${bAttrs.get(key)}"`,
			};
		}
	}
	if (a.text !== b.text) {
		return {
			equal: false,
			reason: `<${a.name}> text mismatch: "${a.text}" vs "${b.text}"`,
		};
	}
	if (a.children.length !== b.children.length) {
		return {
			equal: false,
			reason: `<${a.name}> child count mismatch: ${a.children.length} vs ${b.children.length}`,
		};
	}
	for (let i = 0; i < a.children.length; i++) {
		const result = nodesEqual(a.children[i]!, b.children[i]!);
		if (!result.equal) {
			return result;
		}
	}
	return { equal: true };
};

/**
 * Returns `{ ok: true }` when `actualXml` and `expectedXml` represent the
 * same XML tree (whitespace-, attribute-order-, and self-closing-form-
 * tolerant). Returns `{ ok: false, reason }` with a human-readable
 * explanation otherwise.
 *
 * Mirrors shaka-packager's `XmlEqual` from `mpd/test/xml_compare.h`.
 */
export const xmlEqual = (actualXml: string, expectedXml: string): { ok: true } | { ok: false; reason: string } => {
	let actualRoot: ParsedXmlNode;
	let expectedRoot: ParsedXmlNode;
	try {
		actualRoot = parseRootElement(actualXml);
	} catch (err) {
		const msg = (err as Error).message;
		return { ok: false, reason: `failed to parse actual XML: ${msg}\n--- actual:\n${actualXml}` };
	}
	try {
		expectedRoot = parseRootElement(expectedXml);
	} catch (err) {
		const msg = (err as Error).message;
		return { ok: false, reason: `failed to parse expected XML: ${msg}\n--- expected:\n${expectedXml}` };
	}
	const result = nodesEqual(actualRoot, expectedRoot);
	if (result.equal) {
		return { ok: true };
	}
	return {
		ok: false,
		reason: `${result.reason}\n--- actual:\n${actualXml}\n--- expected:\n${expectedXml}`,
	};
};

/**
 * Vitest-friendly assertion. Throws when XML trees differ.
 */
export const expectXmlEqual = (actualXml: string, expectedXml: string): void => {
	const result = xmlEqual(actualXml, expectedXml);
	if (!result.ok) {
		throw new Error(`XML trees differ: ${result.reason}`);
	}
};
