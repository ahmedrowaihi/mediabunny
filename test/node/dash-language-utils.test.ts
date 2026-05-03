/*!
 * Tests for dash-language-utils. Shaka does not have a dedicated unit test
 * file for language_utils.cc; coverage here is shaped to the function's
 * doc comments.
 */
import { describe, expect, test } from 'vitest';
import {
	languageToISO6392,
	languageToShortestForm,
} from '../../src/dash/dash-language-utils.js';

describe('languageToShortestForm', () => {
	test('passes through an empty string', () => {
		expect(languageToShortestForm('')).toBe('');
	});

	test('passes through a 2-letter code unchanged', () => {
		expect(languageToShortestForm('en')).toBe('en');
		expect(languageToShortestForm('es')).toBe('es');
	});

	test('maps a 3-letter ISO 639-2 code to its 2-letter ISO 639-1 equivalent', () => {
		expect(languageToShortestForm('eng')).toBe('en');
		expect(languageToShortestForm('spa')).toBe('es');
		expect(languageToShortestForm('ara')).toBe('ar');
		expect(languageToShortestForm('fre')).toBe('fr');
		expect(languageToShortestForm('fra')).toBe('fr');
	});

	test('preserves subtags when shortening', () => {
		expect(languageToShortestForm('eng-US')).toBe('en-US');
		expect(languageToShortestForm('en-GB')).toBe('en-GB');
		expect(languageToShortestForm('zho-Hans-CN')).toBe('zh-Hans-CN');
	});

	test('passes through 3-letter codes that have no 2-letter equivalent', () => {
		expect(languageToShortestForm('mis')).toBe('mis');
	});
});

describe('languageToISO6392', () => {
	test('passes through a 3-letter code unchanged', () => {
		expect(languageToISO6392('eng')).toBe('eng');
	});

	test('maps a 2-letter code to its 3-letter equivalent', () => {
		expect(languageToISO6392('en')).toBe('eng');
		expect(languageToISO6392('es')).toBe('spa');
		expect(languageToISO6392('ar')).toBe('ara');
	});

	test('preserves subtags', () => {
		expect(languageToISO6392('en-US')).toBe('eng-US');
	});

	test('returns "und" when no 3-letter equivalent is known', () => {
		// Hypothetical 2-letter code not in the map (xx).
		expect(languageToISO6392('xx')).toBe('und');
	});
});
