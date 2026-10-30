/*!
 * The error contract: a caller must be able to tell whose problem a failure is without matching on
 * message text, and must keep working if they only test `instanceof Error` or read `.message`.
 */
import { describe, expect, test } from 'vitest';
import {
	InvalidUsageError,
	MalformedInputError,
	MediabunnyError,
	MpdParseError,
	UnsupportedMediaError,
	UnsupportedInputFormatError,
	InputDisposedError,
	chunksOf,
	getInitSegmentTimescales,
	getSegmentTrackIds,
	iterateIsobmffBoxes,
	parseHlsPlaylist,
	parseMpd,
	segmentsOf,
} from '../../src/index.js';

describe('error contract', () => {
	test('a malformed manifest is a MalformedInputError, not a bare Error', () => {
		const thrown = (() => {
			try {
				parseHlsPlaylist('not a playlist');
			} catch (error) {
				return error;
			}
			return null;
		})();

		expect(thrown).toBeInstanceOf(MalformedInputError);
		expect(thrown).toBeInstanceOf(MediabunnyError);
		// The whole point: a caller can route on this without reading the message.
		expect(thrown).not.toBeInstanceOf(UnsupportedMediaError);
		expect(thrown).not.toBeInstanceOf(InvalidUsageError);
	});

	test('existing catch blocks keep working', () => {
		// Consumers catch with `error instanceof Error ? error.message : String(error)`. Both halves
		// of that must still hold, or typing the errors would be a breaking change.
		try {
			parseHlsPlaylist('not a playlist');
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(typeof (error as Error).message).toBe('string');
			expect((error as Error).message.length).toBeGreaterThan(0);
		}
	});

	test('MpdParseError is catchable as the category it belongs to', () => {
		try {
			parseMpd('<MPD></MPD>');
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(MpdParseError);
			expect(error).toBeInstanceOf(MalformedInputError);
			// Message is preserved, so the old string-matching path is not broken either.
			expect((error as Error).message).toContain('MPD parse error');
		}
	});

	test('each class carries its own name for logs and serialization', () => {
		expect(new MalformedInputError('x').name).toBe('MalformedInputError');
		expect(new UnsupportedMediaError('x').name).toBe('UnsupportedMediaError');
		expect(new InvalidUsageError('x').name).toBe('InvalidUsageError');
	});
});

describe('ISO BMFF helpers route on the same contract', () => {
	// A truncated segment pushed to an origin must be the publisher's fault, not a 500.
	const truncatedMoof = (() => {
		const bytes = new Uint8Array(12);
		new DataView(bytes.buffer).setUint32(0, 0x7FFFFFFF);
		bytes.set([0x6d, 0x6f, 0x6f, 0x66], 4);
		return bytes;
	})();

	test.each([
		['iterateIsobmffBoxes', () => [...iterateIsobmffBoxes(truncatedMoof)]],
		['segmentsOf', () => segmentsOf(truncatedMoof)],
		['chunksOf', () => chunksOf(truncatedMoof)],
		['getSegmentTrackIds', () => getSegmentTrackIds(truncatedMoof)],
		['getInitSegmentTimescales', () => getInitSegmentTimescales(truncatedMoof)],
	])('%s rejects a truncated box as malformed input', (_name, call) => {
		let thrown: unknown = null;
		try {
			call();
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MalformedInputError);
		expect(thrown).not.toBeInstanceOf(InvalidUsageError);
	});

	test('a range outside the bytes given is the caller\'s fault, not the input\'s', () => {
		expect(() => [...iterateIsobmffBoxes(new Uint8Array(8), 0, 99)]).toThrow(InvalidUsageError);
	});

	test('the input errors are part of the hierarchy', () => {
		expect(new UnsupportedInputFormatError()).toBeInstanceOf(UnsupportedMediaError);
		expect(new UnsupportedInputFormatError()).toBeInstanceOf(MediabunnyError);
		expect(new InputDisposedError()).toBeInstanceOf(InvalidUsageError);
		expect(new InputDisposedError()).toBeInstanceOf(MediabunnyError);
		// Still an Error, so existing catch blocks are unaffected
		expect(new UnsupportedInputFormatError()).toBeInstanceOf(Error);
		expect(new InputDisposedError()).toBeInstanceOf(Error);
	});
});
