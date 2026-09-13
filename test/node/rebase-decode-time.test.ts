/*!
 * Tests for the ISO BMFF segment helpers in `src/isobmff/isobmff-misc.ts` — walking boxes, reading track
 * timescales from an init segment, and re-timing a CMAF segment's `tfdt`s without a demux/remux.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	getInitSegmentTimescales,
	getSegmentDecodeTime,
	isInitializationSegment,
	iterateIsobmffBoxes,
	rebaseSegmentDecodeTime,
	setSegmentDecodeTime,
} from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

const ascii = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
};
const u32 = (n: number) => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n);
	return b;
};
const u64 = (n: number) => {
	const b = new Uint8Array(8);
	new DataView(b.buffer).setBigUint64(0, BigInt(n));
	return b;
};
const box = (name: string, body: Uint8Array) => concat(u32(8 + body.length), ascii(name), body);

const tfdtV0 = (t: number) => box('tfdt', concat(new Uint8Array([0, 0, 0, 0]), u32(t)));
const tfdtV1 = (t: number) => box('tfdt', concat(new Uint8Array([1, 0, 0, 0]), u64(t)));
// A fragmented segment: moof(mfhd + traf...) + mdat. mfhd is a non-tfdt box, mdat is the payload.
const segment = (trafs: Uint8Array[], mdat: Uint8Array) => concat(
	box('moof', concat(box('mfhd', u32(1)), ...trafs.map(t => box('traf', t)))),
	box('mdat', mdat),
);

const readTfdt = (b: Uint8Array): number => {
	let t = -1;
	for (let p = 0; p + 12 <= b.length; p++) {
		if (b[p] === 0x74 && b[p + 1] === 0x66 && b[p + 2] === 0x64 && b[p + 3] === 0x74) {
			t = p;
			break;
		}
	}
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return b[t + 4] === 1 ? Number(view.getBigUint64(t + 8)) : view.getUint32(t + 8);
};

describe('rebaseSegmentDecodeTime', () => {
	const mdat = ascii('the media payload bytes');

	test('shifts a v0 tfdt and preserves every other byte', () => {
		const seg = segment([tfdtV0(1000)], mdat);
		const out = rebaseSegmentDecodeTime(seg, 500);
		expect(readTfdt(out)).toBe(1500);
		expect(out.subarray(out.length - mdat.length)).toEqual(mdat); // mdat untouched
		expect(out.length).toBe(seg.length); // size unchanged
	});

	test('shifts a v1 (64-bit) tfdt', () => {
		const base = 8_000_000_000; // > 2^32, requires the 64-bit path
		const out = rebaseSegmentDecodeTime(segment([tfdtV1(base)], mdat), 51_200);
		expect(readTfdt(out)).toBe(base + 51_200);
	});

	test('shifts every traf independently (multi-track fragment)', () => {
		const seg = segment([tfdtV0(1000), tfdtV0(2000)], mdat);
		const out = rebaseSegmentDecodeTime(seg, 100);
		// both tfdts moved by the same delta
		const view = new DataView(out.buffer);
		const positions: number[] = [];
		for (let p = 0; p + 12 <= out.length; p++) {
			if (out[p] === 0x74 && out[p + 1] === 0x66 && out[p + 2] === 0x64 && out[p + 3] === 0x74) {
				positions.push(view.getUint32(p + 8));
			}
		}
		expect(positions).toEqual([1100, 2100]);
	});

	test('delta 0 returns a distinct, byte-identical copy (caller owns the result)', () => {
		const seg = segment([tfdtV0(1000)], mdat);
		const out = rebaseSegmentDecodeTime(seg, 0);
		expect(out).not.toBe(seg); // distinct buffer
		expect(out).toEqual(seg); // same bytes
	});

	test('does not mutate the input', () => {
		const seg = segment([tfdtV0(1000)], mdat);
		rebaseSegmentDecodeTime(seg, 500);
		expect(readTfdt(seg)).toBe(1000);
	});

	test('input with no moof (init / non-fragmented) is unchanged', () => {
		const init = box('moov', ascii('not a fragment'));
		const out = rebaseSegmentDecodeTime(init, 500);
		expect(out).toEqual(init);
	});
});

describe('getSegmentDecodeTime', () => {
	const mdat = ascii('payload');

	test('reads the first tfdt (v0)', () => {
		expect(getSegmentDecodeTime(segment([tfdtV0(972_800)], mdat))).toBe(972_800);
	});

	test('reads a 64-bit tfdt (v1)', () => {
		expect(getSegmentDecodeTime(segment([tfdtV1(8_000_000_000)], mdat))).toBe(8_000_000_000);
	});

	test('returns null when there is no tfdt', () => {
		expect(getSegmentDecodeTime(box('moov', ascii('init')))).toBeNull();
	});

	test('round-trips with rebaseSegmentDecodeTime', () => {
		const seg = segment([tfdtV0(1000)], mdat);
		const shifted = rebaseSegmentDecodeTime(seg, 5000 - getSegmentDecodeTime(seg)!);
		expect(getSegmentDecodeTime(shifted)).toBe(5000);
	});
});

describe('isInitializationSegment', () => {
	test('true for an init (moov before moof)', () => {
		const init = concat(box('ftyp', ascii('isom')), box('moov', ascii('track config')));
		expect(isInitializationSegment(init)).toBe(true);
	});

	test('false for a media segment (moof first)', () => {
		expect(isInitializationSegment(segment([tfdtV0(0)], ascii('payload')))).toBe(false);
	});

	test('false when neither moov nor moof is present', () => {
		expect(isInitializationSegment(box('ftyp', ascii('isom')))).toBe(false);
	});
});

const tfhd = (trackId: number) => box('tfhd', concat(new Uint8Array([0, 0, 0, 0]), u32(trackId)));
const fullBox = (name: string, version: number, body: Uint8Array) =>
	box(name, concat(new Uint8Array([version, 0, 0, 0]), body));
// tkhd/mdhd carry creation + modification times before the field we read: 32-bit each in v0, 64-bit in v1
const times = (version: number) => (version === 1 ? concat(u64(0), u64(0)) : concat(u32(0), u32(0)));
const trak = (trackId: number, timescale: number, version = 0) => box('trak', concat(
	fullBox('tkhd', version, concat(times(version), u32(trackId), u32(0))),
	box('mdia', fullBox('mdhd', version, concat(times(version), u32(timescale), u32(0)))),
));

// Every tfdt value in file order, grouped by the track ID of its traf
const tfdtsByTrack = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const result = new Map<number, number[]>();
	const children = (b: { start: number; size: number; headerSize: number }) =>
		iterateIsobmffBoxes(bytes, b.start + b.headerSize, b.start + b.size);
	for (const moof of iterateIsobmffBoxes(bytes)) {
		if (moof.type !== 'moof') {
			continue;
		}
		for (const traf of children(moof)) {
			if (traf.type !== 'traf') {
				continue;
			}
			let id = -1;
			let time = -1;
			for (const b of children(traf)) {
				const content = b.start + b.headerSize;
				if (b.type === 'tfhd') {
					id = view.getUint32(content + 4);
				} else if (b.type === 'tfdt') {
					time = bytes[content] === 1 ? Number(view.getBigUint64(content + 4)) : view.getUint32(content + 4);
				}
			}
			result.set(id, [...(result.get(id) ?? []), time]);
		}
	}
	return result;
};

describe('iterateIsobmffBoxes', () => {
	test('yields top-level boxes with offsets, and children through the content range', () => {
		const bytes = concat(box('ftyp', ascii('isom')), box('moov', concat(box('mvhd', u32(0)), trak(1, 90000))));
		const top = [...iterateIsobmffBoxes(bytes)];
		expect(top).toEqual([
			{ type: 'ftyp', start: 0, size: 12, headerSize: 8 },
			{ type: 'moov', start: 12, size: bytes.length - 12, headerSize: 8 },
		]);
		const moov = top[1]!;
		expect([...iterateIsobmffBoxes(bytes, moov.start + moov.headerSize, moov.start + moov.size)].map(b => b.type))
			.toEqual(['mvhd', 'trak']);
	});

	test('reads a 64-bit size, a size-0 box running to the end, and a uuid user type', () => {
		const large = concat(u32(1), ascii('mdat'), u64(20), ascii('abcd'));
		const uuid = concat(u32(8 + 16 + 2), ascii('uuid'), new Uint8Array(16), ascii('xy'));
		const toEnd = concat(u32(0), ascii('mdat'), ascii('rest of file'));
		expect([...iterateIsobmffBoxes(concat(large, uuid, toEnd))]).toEqual([
			{ type: 'mdat', start: 0, size: 20, headerSize: 16 },
			{ type: 'uuid', start: 20, size: 26, headerSize: 24 },
			{ type: 'mdat', start: 46, size: 20, headerSize: 8 },
		]);
	});

	test('throws on a box that runs past the end instead of stopping silently', () => {
		const truncated = box('moof', ascii('fragment')).subarray(0, 10);
		expect(() => [...iterateIsobmffBoxes(truncated)]).toThrow(/doesn't fit|Truncated/);
		expect(() => [...iterateIsobmffBoxes(concat(box('ftyp', ascii('isom')), new Uint8Array(3)))])
			.toThrow(/Truncated ISO BMFF box header at offset 12/);
	});
});

describe('getInitSegmentTimescales', () => {
	test('maps each tkhd track ID to its mdhd timescale, for version 0 and 1 boxes', () => {
		const init = concat(box('ftyp', ascii('isom')), box('moov', concat(trak(1, 57600), trak(2, 48000, 1))));
		expect(getInitSegmentTimescales(init)).toEqual(new Map([[1, 57600], [2, 48000]]));
	});

	test('reads a real fragmented MP4', async () => {
		const file = await fs.promises.readFile(path.join(__dirname, '../public/bear-640x360-av_frag.mp4'));
		// ffprobe: stream time_base 1/30000 (video, track 1) and 1/44100 (audio, track 2)
		expect(getInitSegmentTimescales(file)).toEqual(new Map([[1, 30000], [2, 44100]]));
	});

	test('is empty for a media segment', () => {
		expect(getInitSegmentTimescales(segment([concat(tfhd(1), tfdtV0(0))], ascii('p'))).size).toBe(0);
	});

	test('throws on a trak without an mdhd', () => {
		const init = box('moov', box('trak', fullBox('tkhd', 0, concat(times(0), u32(1), u32(0)))));
		expect(() => getInitSegmentTimescales(init)).toThrow(/missing its 'tkhd' or 'mdhd'/);
	});
});

describe('setSegmentDecodeTime', () => {
	const mdat = ascii('the media payload bytes');
	const timescales = new Map([[1, 57600], [2, 48000]]);
	const timescaleOf = (id: number) => timescales.get(id);

	test('writes each track of one muxed moof in its own timescale', () => {
		const seg = segment([concat(tfhd(1), tfdtV0(123)), concat(tfhd(2), tfdtV1(456))], mdat);
		const out = setSegmentDecodeTime(seg, 10.5, timescaleOf);
		expect(tfdtsByTrack(out)).toEqual(new Map([[1, [604_800]], [2, [504_000]]]));
		expect(out.subarray(out.length - mdat.length)).toEqual(mdat);
		expect(tfdtsByTrack(seg)).toEqual(new Map([[1, [123]], [2, [456]]])); // input untouched
	});

	test('keeps the spacing of a track\'s later moof chunks', () => {
		const seg = concat(
			segment([concat(tfhd(1), tfdtV0(1000)), concat(tfhd(2), tfdtV0(2000))], mdat),
			segment([concat(tfhd(1), tfdtV0(1000 + 28_800)), concat(tfhd(2), tfdtV0(2000 + 24_000))], mdat),
		);
		const out = setSegmentDecodeTime(seg, 2, timescaleOf);
		expect(tfdtsByTrack(out)).toEqual(new Map([[1, [115_200, 144_000]], [2, [96_000, 120_000]]]));
	});

	test('re-times a real fragmented MP4 per track', async () => {
		const file = await fs.promises.readFile(path.join(__dirname, '../public/bear-640x360-av_frag.mp4'));
		const timescalesOfFile = getInitSegmentTimescales(file);
		const before = tfdtsByTrack(file);
		const after = tfdtsByTrack(setSegmentDecodeTime(file, 3600, id => timescalesOfFile.get(id)));

		for (const [id, times] of before) {
			const target = 3600 * timescalesOfFile.get(id)!;
			expect(after.get(id)).toEqual(times.map(t => t - times[0]! + target));
		}
	});

	test('throws rather than wraps when a version 0 tfdt cannot hold the value', () => {
		const seg = segment([concat(tfhd(1), tfdtV0(0))], mdat);
		// 2^32 / 57600 ≈ 74565 s
		expect(() => setSegmentDecodeTime(seg, 80_000, timescaleOf)).toThrow(/version 0 'tfdt'.*can't hold/);
		expect(tfdtsByTrack(setSegmentDecodeTime(segment([concat(tfhd(1), tfdtV1(0))], mdat), 80_000, timescaleOf)))
			.toEqual(new Map([[1, [4_608_000_000]]]));
	});

	test('throws for a track without a timescale or a traf without tfhd/tfdt', () => {
		expect(() => setSegmentDecodeTime(segment([concat(tfhd(9), tfdtV0(0))], mdat), 1, timescaleOf))
			.toThrow(/No timescale for track 9/);
		expect(() => setSegmentDecodeTime(segment([tfdtV0(0)], mdat), 1, timescaleOf))
			.toThrow(/missing its 'tfhd' or 'tfdt'/);
		expect(() => setSegmentDecodeTime(segment([concat(tfhd(1), tfdtV0(0))], mdat), -1, timescaleOf))
			.toThrow(RangeError);
	});
});
