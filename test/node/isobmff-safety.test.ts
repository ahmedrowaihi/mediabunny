/*!
 * Helpers that are handed a caller's buffer and return an edited copy. Two ways that went wrong:
 * the "copy" aliased a Node Buffer, and arithmetic on a tfdt wrapped instead of refusing.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { buildEmsgBox, insertBoxesBeforeMoof } from '../../src/emsg.js';
import { InvalidUsageError, MalformedInputError } from '../../src/errors.js';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import {
	getSegmentCompositionOffset,
	getSegmentDecodeTime,
	rebaseSegmentDecodeTime,
	renumberFragments,
	segmentsOf,
} from '../../src/isobmff/isobmff-misc.js';
import { encryptCmafSegment } from '../../src/crypto/cmaf-encryptor.js';

const FILE = path.join(
	new URL('.', import.meta.url).pathname,
	'../../../shaka-packager/packager/media/test/data/bear-640x360-av_frag.mp4',
);
const KEY = new Uint8Array(16).fill(0x2b);
const KID = new Uint8Array(16).fill(0xa0);
const IV = new Uint8Array(16).fill(0x11);

const split = (bytes: Uint8Array) => {
	const layout = segmentsOf(bytes);
	const start = layout.segments[0]!.offset;
	return { init: bytes.subarray(0, start), segment: bytes.subarray(start) };
};

/** One traf with a version 0 tfdt holding `base`. */
const singleTrackSegment = (base: number) => {
	const box = (type: string, payload: Uint8Array) => {
		const bytes = new Uint8Array(8 + payload.length);
		new DataView(bytes.buffer).setUint32(0, bytes.length);
		bytes.set([...type].map(c => c.charCodeAt(0)), 4);
		bytes.set(payload, 8);
		return bytes;
	};
	const tfhd = box('tfhd', (() => {
		const d = new Uint8Array(8);
		new DataView(d.buffer).setUint32(4, 1); // track_ID
		return d;
	})());
	const tfdt = box('tfdt', (() => {
		const d = new Uint8Array(8); // version 0 + flags, then 32-bit base
		new DataView(d.buffer).setUint32(4, base);
		return d;
	})());
	const traf = box('traf', new Uint8Array([...tfhd, ...tfdt]));
	const moof = box('moof', traf);
	return new Uint8Array([...moof, ...box('mdat', new Uint8Array(4))]);
};

describe('a caller\'s buffer is never written through', () => {
	// Buffer.prototype.slice returns a view; Uint8Array.prototype.slice copies. A cached
	// readFileSync Buffer came back with an encrypted mdat and no senc.
	test.each([
		['a Node Buffer', (b: Uint8Array) => Buffer.from(b)],
		['a Uint8Array', (b: Uint8Array) => new Uint8Array(b)],
	])('encryptCmafSegment leaves %s untouched', (_name, wrap) => {
		const original = new Uint8Array(readFileSync(FILE));
		const { init, segment } = split(original);
		const input = wrap(segment);
		const before = new Uint8Array(input);

		encryptCmafSegment(init, input, { key: KEY, kid: KID, iv: IV, ivState: new Map() });

		expect([...input]).toEqual([...before]);
	});

	test.each([
		['a Node Buffer', (b: Uint8Array) => Buffer.from(b)],
		['a Uint8Array', (b: Uint8Array) => new Uint8Array(b)],
	])('rebaseSegmentDecodeTime leaves %s untouched', (_name, wrap) => {
		const input = wrap(singleTrackSegment(10));
		const before = new Uint8Array(input);

		rebaseSegmentDecodeTime(input, 1000);

		expect([...input]).toEqual([...before]);
	});
});

describe('rebaseSegmentDecodeTime refuses rather than wraps', () => {
	test('a version 0 tfdt that would exceed 32 bits throws', () => {
		expect(() => rebaseSegmentDecodeTime(singleTrackSegment(1000), 2 ** 32))
			.toThrow(InvalidUsageError);
	});

	test('a delta that would take it below zero throws', () => {
		expect(() => rebaseSegmentDecodeTime(singleTrackSegment(10), -100))
			.toThrow(InvalidUsageError);
	});

	test('a non-integer delta throws', () => {
		expect(() => rebaseSegmentDecodeTime(singleTrackSegment(10), 1.5)).toThrow(InvalidUsageError);
	});

	test('a legal rebase still works', () => {
		const out = rebaseSegmentDecodeTime(singleTrackSegment(10), 90);
		const tfdt = findBox(parseBoxes(out, 0, out.length), 'tfdt');
		expect(new DataView(tfdt!.data!.buffer, tfdt!.data!.byteOffset).getUint32(4)).toBe(100);
	});

	test('a segment with several tracks is refused, since one tick delta cannot suit both', () => {
		const original = new Uint8Array(readFileSync(FILE));
		const { segment } = split(original);
		// bear-640x360-av_frag has audio and video trafs
		expect(() => rebaseSegmentDecodeTime(segment, 100)).toThrow(InvalidUsageError);
	});
});

describe('an explicit tfhd base_data_offset follows its moof', () => {
	// 14496-12 8.8.7.1: base_data_offset is a FILE offset, so a segment whose moof moves without it
	// being restated demuxes from shifted bytes.
	const fragment = new Uint8Array(readFileSync(path.join(
		new URL('.', import.meta.url).pathname, '../public/fragments-without-keyframes.mp4')));

	const samples = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		const out: string[] = [];
		let packet = await sink.getFirstPacket();
		while (packet) {
			const data = packet.data;
			out.push(`${packet.timestamp.toFixed(4)}:${data.byteLength}:${data[0]},${data[data.byteLength - 1]}`);
			packet = await sink.getNextPacket(packet);
		}
		return out;
	};

	test('inserting an emsg leaves every sample byte-identical', { timeout: 300_000 }, async () => {
		const before = await samples(fragment);
		expect(before.length).toBeGreaterThan(5);

		const emsg = buildEmsgBox({
			schemeIdUri: 'urn:test', value: '1', timescale: 1000,
			presentationTime: 0, eventDuration: 100, id: 1, messageData: new Uint8Array([1, 2, 3]),
		});
		const withEmsg = insertBoxesBeforeMoof(fragment, [emsg]);
		expect(withEmsg.byteLength).toBeGreaterThan(fragment.byteLength);

		expect(await samples(withEmsg)).toEqual(before);
	});
});

describe('a wrong answer is never given in place of a refusal', () => {
	const original = new Uint8Array(readFileSync(FILE));
	const { init, segment } = split(original);
	const junk = new Uint8Array(64).fill(0xAB);
	const truncated = segment.subarray(0, 24);

	test('getSegmentCompositionOffset refuses junk rather than answering 0', () => {
		// 0 is a real composition offset, so it must not double as "these bytes did not parse"
		expect(getSegmentCompositionOffset(segment, init)).toBe(2002);
		expect(() => getSegmentCompositionOffset(junk)).toThrow(MalformedInputError);
		expect(() => getSegmentCompositionOffset(truncated)).toThrow(MalformedInputError);
	});

	test('a well-formed segment stating no composition offsets still answers 0', () => {
		expect(getSegmentCompositionOffset(new Uint8Array(0))).toBe(0);
	});

	test('getSegmentDecodeTime refuses truncated bytes rather than answering null', () => {
		// null legitimately means "no tfdt", which an init segment has, so it cannot also mean this
		expect(() => getSegmentDecodeTime(truncated)).toThrow(MalformedInputError);
		expect(getSegmentDecodeTime(init)).toBeNull();
	});

	test('insertBoxesBeforeMoof refuses with a typed error', () => {
		const emsg = buildEmsgBox({
			schemeIdUri: 'urn:test', value: '1', timescale: 1000,
			presentationTime: 0, eventDuration: 100, id: 1, messageData: new Uint8Array([1]),
		});
		expect(() => insertBoxesBeforeMoof(junk, [emsg])).toThrow(MalformedInputError);
	});

	test.each([
		['a negative number', -1],
		['a fraction', 1.5],
		['one past 32 bits', 2 ** 32],
	])('renumberFragments refuses %s', (_name, value) => {
		expect(() => renumberFragments(segment, () => value)).toThrow(InvalidUsageError);
	});

	test('segmentsOf reports chunk offsets on the same basis as the segment holding them', () => {
		const layout = segmentsOf(original);
		for (const segmentInfo of layout.segments) {
			expect(segmentInfo.chunks[0]!.offset).toBe(segmentInfo.offset);
			for (const chunk of segmentInfo.chunks) {
				// file-absolute, like segmentInfo.offset — so the two can be used together
				expect(chunk.offset).toBeGreaterThanOrEqual(layout.init!.size);
			}
		}
	});
});
