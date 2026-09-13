import { describe, expect, test } from 'vitest';

import { doviCodecString, doviCompatibleBrand, parseDoviConfigRecord } from '../../src/dovi.js';

// Build a dvcC/dvvC payload: major(8)=1 minor(8)=0 profile(7) level(6) rpu(1) el(1) bl(1) blCompat(4) + reserved.
const packDovi = (
	profile: number, level: number, rpu: number, el: number, bl: number, blCompat: number,
): Uint8Array => {
	const bits: number[] = [];
	const push = (value: number, n: number) => {
		for (let i = n - 1; i >= 0; i--) {
			bits.push((value >> i) & 1);
		}
	};
	push(1, 8);
	push(0, 8);
	push(profile, 7);
	push(level, 6);
	push(rpu, 1);
	push(el, 1);
	push(bl, 1);
	push(blCompat, 4);
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}
	const bytes = new Uint8Array(bits.length / 8);
	bits.forEach((bit, i) => {
		if (bit) {
			bytes[i >> 3]! |= 0x80 >> (i & 7);
		}
	});
	return bytes;
};

describe('Dolby Vision configuration record (shaka-faithful)', () => {
	test('parses profile/level/flags/compat id', () => {
		expect(parseDoviConfigRecord(packDovi(8, 6, 1, 0, 1, 4))).toEqual({
			profile: 8, level: 6, blSignalCompatibilityId: 4, rpuPresent: true, elPresent: false, blPresent: true,
		});
	});

	test('rejects a non-1.0 record', () => {
		expect(parseDoviConfigRecord(Uint8Array.from([2, 0, 0, 0, 0]))).toBeNull();
		expect(parseDoviConfigRecord(Uint8Array.from([1, 0]))).toBeNull(); // too short
	});

	test('codec string is fourcc.profile.level, zero-padded (shaka GetCodecString)', () => {
		const cfg = parseDoviConfigRecord(packDovi(5, 6, 1, 0, 1, 0))!;
		expect(doviCodecString('dvhe', cfg)).toBe('dvhe.05.06');
		expect(doviCodecString('dvh1', parseDoviConfigRecord(packDovi(8, 10, 1, 1, 1, 1))!)).toBe('dvh1.08.10');
	});

	test('compatible brand from bl_signal_compatibility_id + transfer characteristics (shaka)', () => {
		const cfg = parseDoviConfigRecord(packDovi(8, 6, 1, 0, 1, 4))!;
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 1 }, 16)).toBe('db1p');
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 2 }, 16)).toBe('db2g');
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 4 }, 14)).toBe('db4g'); // HLG
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 4 }, 18)).toBe('db4h');
		expect(doviCompatibleBrand({ ...cfg, blSignalCompatibilityId: 0 }, 16)).toBeNull();
	});
});
