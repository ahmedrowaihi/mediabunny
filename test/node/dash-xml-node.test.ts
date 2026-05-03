/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/mpd/base/xml/xml_node_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { XmlNode } from '../../src/dash/dash-xml-node.js';
import type { Element } from '../../src/dash/dash-content-protection.js';

describe('XmlNode — namespace extraction', () => {
	// shaka: TEST(XmlNodeTest, ExtractReferencedNamespaces)
	test('namespaces from element names propagate up the tree', () => {
		const grandChild = new XmlNode('grand_ns:grand_child');
		grandChild.setContent('grand child content');

		const child1 = new XmlNode('child1');
		child1.setContent('child1 content');
		expect(child1.addChild(grandChild)).toBe(true);

		const child2 = new XmlNode('child_ns:child2');
		child2.setContent('child2 content');

		const root = new XmlNode('root');
		expect(root.addChild(child1)).toBe(true);
		expect(root.addChild(child2)).toBe(true);

		expect([...root.extractReferencedNamespaces()].sort()).toEqual(['child_ns', 'grand_ns']);
	});

	// shaka: TEST(XmlNodeTest, ExtractReferencedNamespacesFromAttributes)
	test('namespaces from attribute names propagate up the tree', () => {
		const child = new XmlNode('child');
		expect(child.setStringAttribute('child_attribute_ns:attribute', 'child attribute value')).toBe(true);

		const root = new XmlNode('root');
		expect(root.addChild(child)).toBe(true);
		expect(root.setStringAttribute('root_attribute_ns:attribute', 'root attribute value')).toBe(true);

		expect([...root.extractReferencedNamespaces()].sort()).toEqual([
			'child_attribute_ns',
			'root_attribute_ns',
		]);
	});

	test('returns an empty set when no prefixes are present', () => {
		const root = new XmlNode('root');
		root.setStringAttribute('plain', 'value');
		expect([...root.extractReferencedNamespaces()]).toEqual([]);
	});
});

describe('XmlNode — basic API', () => {
	test('empty element renders as a self-closing tag', () => {
		const root = new XmlNode('Empty');
		expect(root.toString()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<Empty/>\n',
		);
	});

	test('attributes render in insertion order with quoted values', () => {
		const root = new XmlNode('Element');
		root.setStringAttribute('a', '1');
		root.setStringAttribute('b', '2');
		root.setIntegerAttribute('c', 3);
		expect(root.toString()).toContain('<Element a="1" b="2" c="3"/>');
	});

	test('floating-point attribute trims trailing zeros and decimal point', () => {
		const root = new XmlNode('Element');
		root.setFloatingPointAttribute('whole', 1);
		root.setFloatingPointAttribute('half', 0.5);
		root.setFloatingPointAttribute('precise', 1.234567);
		expect(root.getAttribute('whole')).toBe('1');
		expect(root.getAttribute('half')).toBe('0.5');
		expect(root.getAttribute('precise')).toBe('1.234567');
	});

	test('setId emits the id attribute as a decimal string', () => {
		const root = new XmlNode('Element');
		expect(root.setId(42)).toBe(true);
		expect(root.getAttribute('id')).toBe('42');
	});

	test('setContent then renders inline', () => {
		const root = new XmlNode('Title');
		root.setContent('Hello, world!');
		expect(root.toString()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<Title>Hello, world!</Title>\n',
		);
	});

	test('addContent appends to existing text content', () => {
		const root = new XmlNode('Joined');
		root.addContent('one');
		root.addContent('two');
		expect(root.toString()).toContain('<Joined>onetwo</Joined>');
	});

	test('special characters in content are XML-escaped', () => {
		const root = new XmlNode('Note');
		root.setContent('a < b & c > d');
		expect(root.toString()).toContain('<Note>a &lt; b &amp; c &gt; d</Note>');
	});

	test('special characters in attribute values are XML-escaped', () => {
		const root = new XmlNode('Element');
		root.setStringAttribute('quoted', 'he said "hi" & left');
		expect(root.toString()).toContain('quoted="he said &quot;hi&quot; &amp; left"');
	});

	test('URL-encoded content uses RFC 3986 unreserved set', () => {
		const root = new XmlNode('BaseURL');
		root.setUrlEncodedContent('hello world!?');
		expect(root.toString()).toContain('<BaseURL>hello%20world%21%3F</BaseURL>');
	});

	test('addUrlEncodedContent appends URL-encoded data', () => {
		const root = new XmlNode('BaseURL');
		root.addContent('https://example.com/');
		root.addUrlEncodedContent('a b');
		expect(root.toString()).toContain('<BaseURL>https://example.com/a%20b</BaseURL>');
	});

	test('children render with 2-space indentation, attributes on the open tag', () => {
		const root = new XmlNode('MPD');
		root.setStringAttribute('xmlns', 'urn:mpeg:dash:schema:mpd:2011');
		const period = new XmlNode('Period');
		period.setStringAttribute('id', '1');
		root.addChild(period);
		expect(root.toString()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">\n'
			+ '  <Period id="1"/>\n'
			+ '</MPD>\n',
		);
	});

	test('toString includes XML comment before the root when supplied', () => {
		const root = new XmlNode('MPD');
		root.addChild(new XmlNode('Period'));
		expect(root.toString('Generated by mediabunny')).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<!--Generated by mediabunny-->\n'
			+ '<MPD>\n'
			+ '  <Period/>\n'
			+ '</MPD>\n',
		);
	});

	test('getAttribute returns undefined for missing attributes', () => {
		const root = new XmlNode('Element');
		expect(root.getAttribute('missing')).toBeUndefined();
		root.setStringAttribute('present', 'yes');
		expect(root.getAttribute('present')).toBe('yes');
	});
});

describe('XmlNode — addElements', () => {
	test('adds a flat list of children with attributes and content', () => {
		const root = new XmlNode('Container');
		const elements: Element[] = [
			{
				name: 'Child',
				attributes: new Map([['attr', 'value']]),
				content: 'child content',
				subelements: [],
			},
		];
		expect(root.addElements(elements)).toBe(true);
		expect(root.toString()).toContain('<Child attr="value">child content</Child>');
	});

	test('recursively adds nested children', () => {
		const root = new XmlNode('Container');
		const elements: Element[] = [
			{
				name: 'Outer',
				attributes: new Map(),
				content: '',
				subelements: [
					{
						name: 'Inner',
						attributes: new Map([['k', 'v']]),
						content: 'leaf',
						subelements: [],
					},
				],
			},
		];
		expect(root.addElements(elements)).toBe(true);
		expect(root.toString()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<Container>\n'
			+ '  <Outer>\n'
			+ '    <Inner k="v">leaf</Inner>\n'
			+ '  </Outer>\n'
			+ '</Container>\n',
		);
	});
});
