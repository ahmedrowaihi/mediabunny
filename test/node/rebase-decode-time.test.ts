/*!
 * Tests for `rebaseSegmentDecodeTime` in `src/isobmff/isobmff-misc.ts` — shifting a CMAF segment's
 * `tfdt` baseMediaDecodeTime(s) onto a continuous timeline without a demux/remux.
 */
import { describe, expect, test } from 'vitest';
import { getSegmentDecodeTime, isInitializationSegment, rebaseSegmentDecodeTime } from '../../src/index.js';

const ascii = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) { out.set(p, pos); pos += p.length; }
	return out;
};
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
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
		if (b[p] === 0x74 && b[p + 1] === 0x66 && b[p + 2] === 0x64 && b[p + 3] === 0x74) { t = p; break; }
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
			if (out[p] === 0x74 && out[p + 1] === 0x66 && out[p + 2] === 0x64 && out[p + 3] === 0x74) positions.push(view.getUint32(p + 8));
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
