import { describe, expect, test } from 'vitest';
import type { Box } from '../../src/isobmff/isobmff-boxes.js';
import { saiz, senc, sinf, tenc } from '../../src/crypto/encryption-boxes.js';

const chars = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
const toHex = (b: Uint8Array): string => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// Minimal ISOBMFF box serializer (size + type + contents + children), for asserting the bytes.
const serialize = (b: Box): Uint8Array => {
	const children = (b.children ?? []).filter((c): c is Box => c !== null).map(serialize);
	const contentLen = (b.contents?.byteLength ?? 0) + children.reduce((s, c) => s + c.length, 0);
	const size = 8 + contentLen;
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, size);
	out.set(chars(b.type), 4);
	let offset = 8;
	if (b.contents) {
		out.set(b.contents, offset);
		offset += b.contents.byteLength;
	}
	for (const child of children) {
		out.set(child, offset);
		offset += child.length;
	}
	return out;
};

const findBoxType = (bytes: Uint8Array, type: string): boolean =>
	toHex(bytes).includes(toHex(new Uint8Array(chars(type))));

describe('encryption boxes', () => {
	test('tenc (cbcs, constant IV) has version 1, the 1:9 pattern, KID and constant IV', () => {
		const kid = new Uint8Array(16).fill(0xaa);
		const constantIv = new Uint8Array(16).fill(0xbb);
		const bytes = serialize(tenc({ kid, cryptByteBlock: 1, skipByteBlock: 9, constantIv }));

		// size(4) type='tenc'(4) version(1) flags(3) | reserved pattern is_protected iv_size | kid... iv_size iv...
		expect(bytes[8]).toBe(1); // version 1 (pattern present)
		expect([bytes[12], bytes[13], bytes[14], bytes[15]]).toEqual([0x00, 0x19, 0x01, 0x00]);
		// reserved=0, pattern=1<<4|9=0x19, is_protected=1, per_sample_iv_size=0
		expect(toHex(bytes.subarray(16, 32))).toBe('aa'.repeat(16)); // KID
		expect(bytes[32]).toBe(16); // constant_iv_size
		expect(toHex(bytes.subarray(33, 49))).toBe('bb'.repeat(16)); // constant IV
	});

	test('senc encodes sample_count + subsamples with the subsample-encryption flag', () => {
		const bytes = serialize(senc([
			[{ clearBytes: 4, cipherBytes: 198 }],
			[{ clearBytes: 4, cipherBytes: 198 }],
		]));
		expect(toHex(bytes.subarray(4, 8))).toBe(toHex(new Uint8Array(chars('senc'))));
		expect([bytes[9], bytes[10], bytes[11]]).toEqual([0x00, 0x00, 0x02]); // flags = kUseSubsampleEncryption
		expect(toHex(bytes.subarray(12, 16))).toBe('00000002'); // sample_count = 2
		// entry: subsample_count(0x0001) clear(0x0004) cipher(0x000000c6=198)
		expect(toHex(bytes.subarray(16, 24))).toBe('0001' + '0004' + '000000c6');
	});

	test('sinf nests frma + schm + schi(tenc)', () => {
		const t = tenc({
			kid: new Uint8Array(16), cryptByteBlock: 1, skipByteBlock: 9, constantIv: new Uint8Array(16),
		});
		const bytes = serialize(sinf('avc1', 'cbcs', t));
		expect(findBoxType(bytes, 'frma')).toBe(true);
		expect(findBoxType(bytes, 'avc1')).toBe(true); // original format inside frma
		expect(findBoxType(bytes, 'schm')).toBe(true);
		expect(findBoxType(bytes, 'cbcs')).toBe(true);
		expect(findBoxType(bytes, 'schi')).toBe(true);
		expect(findBoxType(bytes, 'tenc')).toBe(true);
	});

	test('saiz uses default_sample_info_size when all entries are equal', () => {
		const bytes = serialize(saiz([9, 9, 9]));
		expect(bytes[12]).toBe(9); // default_sample_info_size
		expect(toHex(bytes.subarray(13, 17))).toBe('00000003'); // sample_count
	});
});
