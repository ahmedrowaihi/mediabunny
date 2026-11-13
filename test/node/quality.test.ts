import { expect, test } from 'vitest';
import { Quality } from '../../src/encode.js';

test('a qualitative quality reports its level and no bitrate or quantizer', () => {
	const quality = new Quality('high');

	expect(quality.level).toBeGreaterThan(0);
	expect(quality.bitrate).toBeUndefined();
	expect(quality.quantizer).toBeUndefined();
	expect(quality.maxBitrate).toBeUndefined();
	expect(quality.preferBitrate).toBe(false);
});

test('a quality states both a quantizer and its fallback bitrate, so neither implies the other', () => {
	// The quantizer is what is demanded; the bitrate is the fallback for a codec that cannot encode by
	// quantizer. A single "kind" discriminator would have to drop one of them.
	const quality = new Quality({ quantizer: 30, bitrate: 2_000_000 });

	expect(quality.quantizer).toBe(30);
	expect(quality.bitrate).toBe(2_000_000);
	expect(quality.level).toBeUndefined();
});

test('a capped quality reports its cap and the buffer it is measured over', () => {
	const quality = new Quality({ quantizer: 25, maxBitrate: 5_000_000, bufferSize: 10_000_000 });

	expect(quality.maxBitrate).toBe(5_000_000);
	expect(quality.bufferSize).toBe(10_000_000);
	expect(quality.bitrateMode).toBeUndefined();
});

test('a demanded bitrate mode is readable, where otherwise the encoder default stands', () => {
	expect(new Quality({ bitrate: 1_000_000, bitrateMode: 'constant' }).bitrateMode).toBe('constant');
	expect(new Quality({ bitrate: 1_000_000 }).bitrateMode).toBeUndefined();
});

test('preferBitrate is readable on a qualitative quality', () => {
	expect(new Quality({ quality: 'medium', preferBitrate: true }).preferBitrate).toBe(true);
});
