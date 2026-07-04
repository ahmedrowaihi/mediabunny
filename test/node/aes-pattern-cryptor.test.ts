/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/media/base/aes_pattern_cryptor_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import type { BlockCryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { AesPatternCryptor } from '../../src/crypto/aes-pattern-cryptor.js';

const hex = (s: string): Uint8Array => {
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};
const toHex = (b: Uint8Array): string =>
	[...b].map(x => x.toString(16).padStart(2, '0')).join('');

const kCryptByteBlock = 2;
const kSkipByteBlock = 1;

// Mirrors shaka's MockAesCryptor default: each processed byte is incremented by 0x10.
class MockCryptor implements BlockCryptor {
	initializeWithIv(): void {}
	setIv(): void {}
	crypt(text: Uint8Array): void {
		for (let i = 0; i < text.length; i++) {
			text[i] = (text[i]! + 0x10) & 0xff;
		}
	}
}

const makeCryptor = () => new AesPatternCryptor(
	kCryptByteBlock,
	kSkipByteBlock,
	'encryptIfCryptByteBlockRemaining',
	false,
	new MockCryptor(),
);

// shaka: kPatternTestCases — [text, expected] for crypt:skip = 2:1.
const patternCases: [string, string][] = [
	// Empty.
	['', ''],
	// One partial block (not encrypted).
	['010203', '010203'],
	// One block (encrypted).
	['01020304050607080910111213141516', '11121314151617181920212223242526'],
	// One block (encrypted) + partial block (unencrypted).
	['010203040506070809101112131415161718', '111213141516171819202122232425261718'],
	// Two blocks (encrypted).
	[
		'0102030405060708091011121314151617181920212223242526272829303132',
		'1112131415161718192021222324252627282930313233343536373839404142',
	],
	// Two blocks (encrypted) + partial block (unencrypted).
	[
		'0102030405060708091011121314151617181920212223242526272829303132333435363738',
		'1112131415161718192021222324252627282930313233343536373839404142333435363738',
	],
	// Seven blocks: [enc 2][skip 1][enc 2][skip 1][enc 1].
	[
		'0102030405060708091011121314151617181920212223242526272829303132'
		+ '33343536373839404142434445464748'
		+ '4950515253545556575859606162636465666768697071727374757677787980'
		+ '81828384858687888990919293949596'
		+ '97989900010203040506070809101112',
		'1112131415161718192021222324252627282930313233343536373839404142'
		+ '33343536373839404142434445464748'
		+ '5960616263646566676869707172737475767778798081828384858687888990'
		+ '81828384858687888990919293949596'
		+ 'a7a8a910111213141516171819202122',
	],
];

describe('AesPatternCryptor', () => {
	// shaka: TEST_F(AesPatternCryptorTest, InitializeWithIv)
	test('InitializeWithIv delegates to the underlying cryptor', () => {
		const calls: { key: string; iv: string }[] = [];
		const cryptor: BlockCryptor = {
			initializeWithIv(key, iv) {
				calls.push({ key: toHex(key), iv: toHex(iv) });
			},
			setIv() {},
			crypt() {},
		};
		const key = new Uint8Array(16).fill('k'.charCodeAt(0));
		const iv = new Uint8Array(8).fill('i'.charCodeAt(0));
		new AesPatternCryptor(kCryptByteBlock, kSkipByteBlock, 'encryptIfCryptByteBlockRemaining', false, cryptor)
			.initializeWithIv(key, iv);
		expect(calls).toEqual([{ key: toHex(key), iv: toHex(iv) }]);
	});

	// shaka: TEST_P(AesPatternCryptorVerificationTest, PatternTest)
	test.each(patternCases)('pattern case %#', (textHex, expectedHex) => {
		expect(toHex(makeCryptor().crypt(hex(textHex)))).toBe(expectedHex);
	});
});
