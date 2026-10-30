/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `keyFrame` is the byte range an EXT-X-I-FRAME-STREAM-INF playlist publishes: a chunk's moof plus its
// first sample, when that sample is a sync sample. Every claim here is checked against something that
// did not compute it the same way - ffprobe's packet offsets for the range itself, and the moof's own
// measured growth for the encrypted case.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { chunksOf, readSegmentHead, segmentsOf } from '../../src/isobmff/isobmff-misc.js';
import { cmafEncryptedLayout, encryptCmafSegment } from '../../src/crypto/cmaf-encryptor.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { muxSegment, segmentIndexOf } from '../../src/segment-index.js';

const __dirname = new URL('.', import.meta.url).pathname;
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, '../public', name)));

const KEY = new Uint8Array(16).fill(0x2b);
const KID = new Uint8Array(16).fill(0xa0);
const IV = new Uint8Array(16).fill(0x11);

const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** Every packet ffprobe reports, with the file offset and size of its data. */
const ffprobePackets = (file: string) => {
	const out = execFileSync('ffprobe', [
		'-v', 'error', '-show_packets', '-show_entries', 'packet=pos,size,flags', '-of', 'json', file,
	], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

	const parsed = JSON.parse(out) as { packets: { pos: string; size: string; flags: string }[] };
	return parsed.packets.map(p => ({ pos: Number(p.pos), size: Number(p.size), key: p.flags.includes('K') }));
};

/** The size of the `moof` opening these bytes, so encryption's growth can be measured rather than assumed. */
const moofSize = (segment: Uint8Array, at: number) =>
	new DataView(segment.buffer, segment.byteOffset, segment.byteLength).getUint32(at);

const splitInitAndSegment = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 0;
	let moofStart = -1;
	let segmentEnd = bytes.length;

	while (pos + 8 <= bytes.length) {
		const size = view.getUint32(pos);
		const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
		if (type === 'moof' && moofStart < 0) {
			moofStart = pos;
		} else if (moofStart >= 0 && type !== 'moof' && type !== 'mdat') {
			segmentEnd = pos;
			break;
		}
		if (size < 8) {
			break;
		}
		pos += size;
	}

	return { init: bytes.subarray(0, moofStart), segment: bytes.subarray(moofStart, segmentEnd) };
};

describe.skipIf(!hasFfprobe)('the range agrees with ffprobe', () => {
	for (const name of ['bear-640x360-av_frag.mp4', 'fragments-without-keyframes.mp4']) {
		test(`${name}: every stated range ends on a packet boundary`, () => {
			const file = path.join(__dirname, '../public', name);
			const bytes = fixture(name);
			const chunks = chunksOf(bytes, bytes);
			const packets = ffprobePackets(file);
			expect(chunks.length).toBeGreaterThan(0);

			let stated = 0;
			for (const chunk of chunks) {
				const first = packets
					.filter(p => p.pos >= chunk.offset && p.pos < chunk.offset + chunk.size)
					.sort((a, b) => a.pos - b.pos)[0];

				if (chunk.keyFrame === null) {
					// Either the sample is not a sync sample, or the chunk states nothing to tell from
					expect(chunk.independent === false || chunk.independent === null).toBe(true);
					continue;
				}

				stated++;
				expect(first).toBeDefined();
				expect(first!.key).toBe(true);
				// The claim: the range ends exactly at the first sample's last byte
				expect(chunk.keyFrame.offset + chunk.keyFrame.size).toBe(first!.pos + first!.size);
				// And it starts at the moof, so the frame decodes from the range alone
				expect(chunk.keyFrame.offset).toBeLessThanOrEqual(first!.pos);
				expect(chunk.keyFrame.offset).toBeGreaterThanOrEqual(chunk.offset);
			}

			expect(stated).toBeGreaterThan(0);
		}, 120_000);
	}

	test('fragments-without-keyframes.mp4 states both answers, so neither is the default', () => {
		const bytes = fixture('fragments-without-keyframes.mp4');
		const chunks = chunksOf(bytes, bytes);

		expect(chunks.some(chunk => chunk.keyFrame !== null)).toBe(true);
		expect(chunks.some(chunk => chunk.keyFrame === null)).toBe(true);
		// Null tracks the sync flag rather than anything else
		for (const chunk of chunks) {
			expect(chunk.keyFrame !== null).toBe(chunk.independent === true);
		}
	});
});

test('segmentsOf states its ranges file-absolute, like its chunk offsets', () => {
	const bytes = fixture('bear-640x360-av_frag.mp4');
	const layout = segmentsOf(bytes);
	const chunks = layout.segments.flatMap(segment => segment.chunks);
	expect(chunks.some(chunk => chunk.keyFrame !== null)).toBe(true);

	for (const segment of layout.segments) {
		// Each segment read on its own is the resource a client fetches, so the two must agree once the
		// segment's own offset is taken off
		const alone = chunksOf(bytes.subarray(segment.offset, segment.offset + segment.size), bytes);
		expect(alone.length).toBe(segment.chunks.length);

		for (const [i, chunk] of segment.chunks.entries()) {
			const own = alone[i]!.keyFrame;
			expect(chunk.keyFrame === null).toBe(own === null);
			if (chunk.keyFrame !== null && own !== null) {
				expect(chunk.keyFrame.offset - segment.offset).toBe(own.offset);
				expect(chunk.keyFrame.size).toBe(own.size);
				// Inside the segment, which is what makes it servable as a byte range of it
				expect(chunk.keyFrame.offset).toBeGreaterThanOrEqual(segment.offset);
			}
		}
	}
});

describe('readSegmentHead', () => {
	const bytes = fixture('bear-640x360-av_frag.mp4');
	const { segment } = splitInitAndSegment(bytes);
	const expected = chunksOf(segment)[0]!.keyFrame;

	test('a head reaching exactly the end of the moof states the range', () => {
		expect(expected).not.toBeNull();

		// The moof alone states the range, so a head that stops at its last byte carries it even though
		// not one byte of the sample has arrived
		const head = segment.subarray(0, moofSize(segment, 0));
		expect(readSegmentHead(head)!.keyFrame).toEqual(expected);
		// And the range reaches past what was read, which is the whole point
		expect(expected!.size).toBeGreaterThan(head.byteLength);
	});

	test('a head is never wrong, only absent', () => {
		// The fields are near the front of the moof, so a head states the range well before the moof
		// ends. What has to hold at every length is that it is either absent or right.
		let nulls = 0;
		let stated = 0;
		for (let length = 8; length <= moofSize(segment, 0); length++) {
			const read = readSegmentHead(segment.subarray(0, length));
			if (read === null || read.keyFrame === null) {
				nulls++;
				continue;
			}
			stated++;
			expect(read.keyFrame).toEqual(expected);
		}

		// Both outcomes occur, so neither assertion is vacuous
		expect(nulls).toBeGreaterThan(0);
		expect(stated).toBeGreaterThan(0);
	});

	test('a head holding only the moof header states null', () => {
		expect(readSegmentHead(segment.subarray(0, 16))!.keyFrame).toBeNull();
	});

	test('the whole segment agrees with the head', () => {
		expect(readSegmentHead(segment)!.keyFrame).toEqual(expected);
	});
});

describe('the encrypted layout measures the bytes as served', () => {
	const bytes = fixture('bear-640x360-av_frag.mp4');
	const { init, segment } = splitInitAndSegment(bytes);

	for (const scheme of ['cenc', 'cbcs'] as const) {
		test(`${scheme}: the range grows by exactly the moof's growth`, () => {
			const clear = chunksOf(segment, init)[0]!;
			const encrypted = cmafEncryptedLayout(
				init, segment, { key: KEY, kid: KID, iv: IV, scheme, ivState: new Map() },
			)[0]!;

			expect(clear.keyFrame).not.toBeNull();
			expect(encrypted.keyFrame).not.toBeNull();

			// The aux-info boxes go into the moof, so the sample's bytes move by the moof's growth and
			// nothing else. Measured from the boxes rather than from a formula.
			// Measured on the real encrypted bytes rather than inferred from the layout's own numbers
			const encryptedBytes = encryptCmafSegment(
				init, segment, { key: KEY, kid: KID, iv: IV, scheme, ivState: new Map() },
			);
			const moofGrowth = moofSize(encryptedBytes, 0) - moofSize(segment, 0);
			expect(moofGrowth).toBeGreaterThan(0);

			expect(encrypted.keyFrame!.size - clear.keyFrame!.size).toBe(moofGrowth);
			// The sample itself is encrypted in place, so the chunk grows by the same boxes and no more
			expect(encrypted.size - clear.size).toBe(moofGrowth);
			// And the layout equals what encrypting actually produced, which is its stated contract
			expect(chunksOf(encryptedBytes, init)[0]!.keyFrame).toEqual(encrypted.keyFrame);
		});
	}
});

test('a segment written from a progressive source states its range', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
		formats: ALL_FORMATS,
	});
	const boundaries = await segmentIndexOf(input, { targetDuration: 1 });
	expect(boundaries.length).toBeGreaterThan(0);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});
	await muxSegment(input, boundaries[0]!, output);
	const written = new Uint8Array(output.target.buffer!);

	// A segment cuts on a sync sample, so its first chunk has a range by construction
	const chunks = chunksOf(written);
	expect(chunks.length).toBeGreaterThan(0);
	expect(chunks[0]!.keyFrame).not.toBeNull();
	// The first chunk of a written file opens at byte 0, since the ftyp and moov ahead of the moof
	// belong to it - so the range starts at the moof rather than at the chunk
	expect(chunks[0]!.keyFrame!.offset).toBeGreaterThan(chunks[0]!.offset);
	expect(written.subarray(chunks[0]!.keyFrame!.offset + 4, chunks[0]!.keyFrame!.offset + 8))
		.toEqual(new Uint8Array([0x6d, 0x6f, 0x6f, 0x66]));
	expect(chunks[0]!.keyFrame!.offset + chunks[0]!.keyFrame!.size)
		.toBeLessThanOrEqual(chunks[0]!.offset + chunks[0]!.size);
}, 120_000);

// No checked-in fixture sets base-data-offset-present - all nine fragmented ones use
// default-base-is-moof or neither flag - so the branch that gives up on an explicit base is reached
// only by building a segment that states one.
describe('an explicit base_data_offset', () => {
	const { init, segment } = splitInitAndSegment(fixture('bear-640x360-av_frag.mp4'));

	/**
	 * Rewrites the first `tfhd` to carry an 8-byte `base_data_offset`, growing the `tfhd`, `traf` and
	 * `moof` by 8 and pushing the `trun`'s `data_offset` out by the same, so the sample bytes still
	 * resolve to where they actually are.
	 */
	const withBaseDataOffset = (extraFlags: number) => {
		const out = new Uint8Array(segment.byteLength + 8);
		const source = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);

		const find = (fourcc: string) => {
			for (let at = 0; at + 8 <= segment.byteLength; at++) {
				const type = String.fromCharCode(
					segment[at + 4]!, segment[at + 5]!, segment[at + 6]!, segment[at + 7]!,
				);
				if (type === fourcc) {
					return at;
				}
			}
			throw new Error(`no ${fourcc} in the segment`);
		};

		const moofAt = find('moof');
		const trafAt = find('traf');
		const tfhdAt = find('tfhd');
		const trunAt = find('trun');
		// track_ID is the last fixed field, so the new one goes right after it
		const insertAt = tfhdAt + 8 + 8;

		out.set(segment.subarray(0, insertAt));
		out.set(segment.subarray(insertAt), insertAt + 8);

		const view = new DataView(out.buffer);
		for (const at of [moofAt, trafAt, tfhdAt]) {
			view.setUint32(at, source.getUint32(at) + 8);
		}
		view.setUint32(tfhdAt + 8, (source.getUint32(tfhdAt + 8) | 0x1 | extraFlags) >>> 0);
		// A plausible value: where the sample data actually starts in the original file
		view.setBigUint64(insertAt, BigInt(moofAt + source.getUint32(moofAt) + 8 + 8));

		if (source.getUint32(trunAt + 8) & 0x1) {
			view.setInt32(trunAt + 8 + 8 + 8, source.getInt32(trunAt + 8 + 8) + 8);
		}

		return out;
	};

	test('leaves the range unstated rather than guessing a file offset', () => {
		// Both with and without default-base-is-moof: the spec defines that flag only when
		// base-data-offset-present is zero, so the explicit offset wins and these bytes need not be
		// the file it counts from
		for (const extraFlags of [0, 0x020000]) {
			const patched = withBaseDataOffset(extraFlags);
			expect(chunksOf(patched, init)[0]!.keyFrame).toBeNull();
			expect(readSegmentHead(patched)!.keyFrame).toBeNull();
			// Everything else is still read, so the segment is well formed and only the base is missing
			expect(chunksOf(patched, init)[0]!.independent).toBe(true);
			expect(readSegmentHead(patched)!.trackId).toBe(readSegmentHead(segment)!.trackId);
		}
	});

	test('the unpatched segment still states one, so the patch is what removed it', () => {
		expect(chunksOf(segment, init)[0]!.keyFrame).not.toBeNull();
	});
});
