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
	ALL_FORMATS,
	BufferSource,
	Input,
} from '../../src/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

// The demuxers' own read path, not just the box helpers. Upstream added these checks (#673, #678) as
// bare `Error`s; the fork types them, because an origin serving a caller's file has to tell "your
// bytes are wrong" (4xx) from "we failed" (5xx) without matching on message text.
describe('a truncated file is the input\'s fault, not ours', () => {
	const read = async (bytes: Uint8Array) => {
		const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		try {
			const tracks = await input.getTracks();
			for (const track of tracks) {
				await track.computeDuration();
			}
			return null;
		} catch (error) {
			return error;
		} finally {
			input.dispose();
		}
	};

	/** The offset and declared size of a top-level box, read from the bytes rather than assumed. */
	const topLevelBox = (bytes: Uint8Array, type: string) => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let offset = 0;
		while (offset + 8 <= bytes.length) {
			const size = view.getUint32(offset);
			const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
			if (name === type) {
				return { offset, size };
			}
			if (size === 0) {
				break;
			}
			offset += size;
		}
		throw new Error(`no ${type} box in the fixture`);
	};

	test('an MP4 cut before its moov is a MalformedInputError', async () => {
		const whole = new Uint8Array(readFileSync(path.join(__dirname, '../public/video.mp4')));
		const { offset } = topLevelBox(whole, 'moov');

		// Cut the file short of the moov entirely, and again partway into it: both are "the bytes do
		// not describe a file", and neither is a caller mistake or an unsupported format.
		for (const cut of [offset, offset + 8]) {
			const thrown = await read(whole.subarray(0, cut));
			expect(thrown, `cut at ${cut}`).toBeInstanceOf(MalformedInputError);
			expect(thrown).not.toBeInstanceOf(InvalidUsageError);
			expect(thrown).not.toBeInstanceOf(UnsupportedMediaError);
		}

		// The control: the untruncated fixture must read, or the assertions above would hold for a
		// reason that has nothing to do with the truncation.
		expect(await read(whole)).toBe(null);
	});

	test('a Matroska file cut before its Segment is a MalformedInputError', async () => {
		const whole = new Uint8Array(readFileSync(path.join(__dirname, '../public/demo.webm')));
		// EBML header first, then the Segment element: 0x18538067. Cutting at it leaves a readable
		// header describing a file whose body is absent.
		const segmentAt = whole.findIndex((_, i) =>
			whole[i] === 0x18 && whole[i + 1] === 0x53 && whole[i + 2] === 0x80 && whole[i + 3] === 0x67);
		expect(segmentAt).toBeGreaterThan(0);

		const thrown = await read(whole.subarray(0, segmentAt));
		expect(thrown).toBeInstanceOf(MalformedInputError);
		expect(await read(whole)).toBe(null);
	});
});
