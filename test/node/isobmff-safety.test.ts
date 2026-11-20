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
import { hasShakaCorpus, readCorpus, shakaData } from './_shaka-corpus.js';

// shaka-packager's test media is a sibling checkout, so these skip where it is not cloned
const corpusTest = test.skipIf(!hasShakaCorpus);
const corpusDescribe = describe.skipIf(!hasShakaCorpus);

const FILE = shakaData('bear-640x360-av_frag.mp4');
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

corpusDescribe('a caller\'s buffer is never written through', () => {
	// Buffer.prototype.slice returns a view; Uint8Array.prototype.slice copies. A cached
	// readFileSync Buffer came back with an encrypted mdat and no senc.
	corpusTest.each([
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

	corpusTest('a segment with several tracks is refused, since one tick delta cannot suit both', () => {
		const original = new Uint8Array(readFileSync(FILE));
		const { segment } = split(original);
		// bear-640x360-av_frag has audio and video trafs
		expect(() => rebaseSegmentDecodeTime(segment, 100)).toThrow(InvalidUsageError);
	});
});

corpusDescribe('an explicit tfhd base_data_offset follows its moof', () => {
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

corpusDescribe('a wrong answer is never given in place of a refusal', () => {
	// A skipped describe still runs its body, so nothing at this scope may touch media that may be absent
	const parts = () => {
		const original = readCorpus('bear-640x360-av_frag.mp4');
		const { init, segment } = split(original);
		return { original, init, segment, truncated: segment.subarray(0, 24) };
	};
	const junk = new Uint8Array(64).fill(0xAB);

	test('getSegmentCompositionOffset refuses junk rather than answering 0', () => {
		const { init, segment, truncated } = parts();

		// 0 is a real composition offset, so it must not double as "these bytes did not parse"
		expect(getSegmentCompositionOffset(segment, init)).toBe(2002);
		expect(() => getSegmentCompositionOffset(junk)).toThrow(MalformedInputError);
		expect(() => getSegmentCompositionOffset(truncated)).toThrow(MalformedInputError);
	});

	test('a well-formed segment stating no composition offsets still answers 0', () => {
		expect(getSegmentCompositionOffset(new Uint8Array(0))).toBe(0);
	});

	test('getSegmentDecodeTime refuses truncated bytes rather than answering null', () => {
		const { init, truncated } = parts();

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
		expect(() => renumberFragments(parts().segment, () => value)).toThrow(InvalidUsageError);
	});

	test('segmentsOf reports chunk offsets on the same basis as the segment holding them', () => {
		const layout = segmentsOf(parts().original);
		for (const segmentInfo of layout.segments) {
			expect(segmentInfo.chunks[0]!.offset).toBe(segmentInfo.offset);
			for (const chunk of segmentInfo.chunks) {
				// file-absolute, like segmentInfo.offset — so the two can be used together
				expect(chunk.offset).toBeGreaterThanOrEqual(layout.init!.size);
			}
		}
	});
});

// `parseBoxes` decoded box headers itself and got three cases wrong: a 64-bit `largesize` was read from
// its LOW half, so a box over 4 GiB truncated; a size smaller than its own header, and a size running
// past the parent, were both walked into anyway. Header decode now goes through `eachBox`, the one walker
// that already handled all three, so these are the cases that used to be silent.
describe('parseBoxes header decoding', () => {
	const box = (type: string, size: number, extra: number[] = []) => {
		const out = new Uint8Array(8 + extra.length);
		new DataView(out.buffer).setUint32(0, size);
		out.set([...type].map(c => c.charCodeAt(0)), 4);
		out.set(extra, 8);
		return out;
	};

	test('a 64-bit largesize is read whole, so one past 4 GiB is refused not truncated', () => {
		// size=1 puts the real length in the 64-bit field after the type. This one states 4 GiB + 24 in a
		// 24-byte buffer, so it has to be refused. Reading only the low word yields 24, which looks like a
		// perfectly good box - that is the truncation, and it needs a value above 2^32 to show at all.
		const bytes = new Uint8Array(24);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, 1);
		bytes.set([...'free'].map(c => c.charCodeAt(0)), 4);
		view.setBigUint64(8, BigInt(2 ** 32 + 24));

		expect(parseBoxes(bytes, 0, bytes.length)).toEqual([]);
	});

	test('a 64-bit largesize that does fit is read from the whole field', () => {
		const bytes = new Uint8Array(24);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, 1);
		bytes.set([...'free'].map(c => c.charCodeAt(0)), 4);
		view.setBigUint64(8, 24n);
		const parsed = parseBoxes(bytes, 0, bytes.length);

		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.type).toBe('free');
		// 24 total minus the 16-byte large header
		expect(parsed[0]!.data!.byteLength).toBe(8);
	});

	test('a size past the end of its parent is refused rather than walked into', () => {
		const bytes = new Uint8Array(16);
		new DataView(bytes.buffer).setUint32(0, 999_999);
		bytes.set([...'free'].map(c => c.charCodeAt(0)), 4);

		// Stops at the bad header instead of reading 999999 bytes out of a 16-byte buffer
		expect(parseBoxes(bytes, 0, bytes.length)).toEqual([]);
	});

	test('a size smaller than its own header does not loop forever', () => {
		const bytes = new Uint8Array([...box('free', 4), ...box('free', 8)]);

		// A size of 4 cannot hold the 8-byte header it sits in; advancing by it would never terminate
		expect(parseBoxes(bytes, 0, bytes.length)).toEqual([]);
	});

	test('a size of 0 still means the rest of the range', () => {
		const bytes = new Uint8Array([...box('free', 0), 1, 2, 3, 4]);
		const parsed = parseBoxes(bytes, 0, bytes.length);

		expect(parsed).toHaveLength(1);
		expect([...parsed[0]!.data!]).toEqual([1, 2, 3, 4]);
	});
});
