/*!
 * Tests for the test helper itself. Mirrors shaka's `MetaTestXmlElementsEqual`
 * and `MetaTestXmlEqualDifferentContent` tests of its own XmlEqual matcher.
 */
import { describe, expect, test } from 'vitest';
import { xmlEqual } from './_xml-equal.js';

describe('xmlEqual — meta tests', () => {
	// shaka: TEST(XmlNodeTest, MetaTestXmlElementsEqual)
	test('equal trees with reordered attributes are equal', () => {
		const xml1 = '<A>'
			+ '<B c="1" e="foobar" somelongnameattribute="somevalue">'
			+ '<Bchild childvalue="3" f="4"/>'
			+ '</B>'
			+ '<C/>'
			+ '</A>';
		const xml1AttributeReorder = '<A>'
			+ '<B c="1" somelongnameattribute="somevalue" e="foobar">'
			+ '<Bchild childvalue="3" f="4"/>'
			+ '</B>'
			+ '<C/>'
			+ '</A>';
		expect(xmlEqual(xml1, xml1AttributeReorder).ok).toBe(true);
	});

	test('children reordered → not equal', () => {
		const xml1 = '<A><B c="1"/><C/></A>';
		const xml2 = '<A><C/><B c="1"/></A>';
		expect(xmlEqual(xml1, xml2).ok).toBe(false);
	});

	test('attribute removed → not equal', () => {
		const xml1 = '<A c="1" d="2"/>';
		const xml2 = '<A c="1"/>';
		expect(xmlEqual(xml1, xml2).ok).toBe(false);
	});

	// shaka: TEST(XmlNodeTest, MetaTestXmlEqualDifferentContent)
	test('different text content → not equal even when concatenations match', () => {
		const xml1 = '<A><B>content1</B><B>content2</B></A>';
		const xml2 = '<A><B>c</B><B>ontent1content2</B></A>';
		expect(xmlEqual(xml1, xml2).ok).toBe(false);
	});

	test('whitespace-only differences are tolerated', () => {
		const xml1 = '<A>\n  <B c="1"/>\n</A>';
		const xml2 = '<A><B c="1"/></A>';
		expect(xmlEqual(xml1, xml2).ok).toBe(true);
	});

	test('self-closing vs open/close-pair on empty element are equal', () => {
		expect(xmlEqual('<A/>', '<A></A>').ok).toBe(true);
	});

	test('XML declaration on either side is ignored', () => {
		const xml1 = '<?xml version="1.0" encoding="UTF-8"?>\n<A/>';
		const xml2 = '<A/>';
		expect(xmlEqual(xml1, xml2).ok).toBe(true);
	});

	test('comment before root is ignored', () => {
		const xml1 = '<!--note-->\n<A/>';
		expect(xmlEqual(xml1, '<A/>').ok).toBe(true);
	});

	test('XML entities decoded in attribute values', () => {
		expect(xmlEqual('<A v="a &amp; b"/>', '<A v="a & b"/>').ok).toBe(true);
	});

	test('XML entities decoded in text content', () => {
		// Both sides are valid XML — `<` raw in text is illegal so we use the
		// entity on both. The matcher decodes them when comparing.
		expect(xmlEqual('<A>a &amp; b</A>', '<A>a &amp; b</A>').ok).toBe(true);
	});
});
