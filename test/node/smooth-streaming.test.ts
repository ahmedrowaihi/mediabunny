/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Inserting into a traf moves everything after it, and a stale offset does not corrupt the bytes it
// points at - the fragment still parses, it just hands back the wrong samples. So the load-bearing
// check here is that every sample reads back byte-identical after the surgery.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { buildTfrfBox, buildTfxdBox, insertBoxesIntoTraf } from '../../src/smooth-streaming.js';
import { type MutableBox, measureBox, parseBoxes, readU32, writeU32 } from '../../src/crypto/box-tree.js';
import { encryptCmaf } from '../../src/crypto/cmaf-encryptor.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { FilePathSource } from '../../src/source.js';
import { bytesToHexString } from '../../src/misc.js';
import { InvalidUsageError, MalformedInputError } from '../../src/errors.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const TWO_TRACK = 'bear-640x360-av_frag.mp4';
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, '../public', name)));

const typeAt = (bytes: Uint8Array, offset: number): string => String.fromCharCode(
	bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!,
);

/** Walks every box of every nesting level to its end, which a wrong size header makes impossible. */
const walkBoxes = (bytes: Uint8Array, start = 0, end = bytes.length): string[] => {
	const types: string[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		const size = readU32(bytes, offset);
		const type = typeAt(bytes, offset);
		if (size < 8 || offset + size > end) {
			throw new Error(`box ${type} at ${offset} states size ${size}, past the ${end}-byte end`);
		}
		types.push(type);
		if (type === 'moof' || type === 'traf') {
			types.push(...walkBoxes(bytes, offset + 8, offset + size));
		}
		offset += size;
	}
	if (offset !== end) {
		throw new Error(`boxes ended at ${offset}, not at ${end}`);
	}
	return types;
};

/** Every top-level `moof`'s byte offset, in order. */
const moofStarts = (bytes: Uint8Array): number[] =>
	readTopLevelBoxes(bytes).filter(box => box.name === 'moof').map(box => box.start);

/** The first `trun` box's start, found by descending the tree rather than by searching for bytes. */
const findTrunOffset = (bytes: Uint8Array, start = 0, end = bytes.length): number => {
	let offset = start;
	while (offset + 8 <= end) {
		const size = readU32(bytes, offset);
		const type = typeAt(bytes, offset);
		if (type === 'trun') {
			return offset;
		}
		if (type === 'moof' || type === 'traf') {
			const found = findTrunOffset(bytes, offset + 8, offset + size);
			if (found !== -1) {
				return found;
			}
		}
		offset += size;
	}
	return -1;
};

/** Every packet of every track, so a shifted offset shows up as different bytes rather than a throw. */
const readAllPackets = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const out: { track: number; timestamp: number; data: string }[] = [];
	for (const track of await input.getTracks()) {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			out.push({ track: track.id, timestamp: packet.timestamp, data: bytesToHexString(packet.data) });
		}
	}
	return out;
};

const trackIds = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	return (await input.getTracks()).map(track => track.id);
};

const trafsIn = (bytes: Uint8Array): MutableBox[] => parseBoxes(bytes, 0, bytes.length)
	.filter(box => box.type === 'moof')
	.flatMap(moof => (moof.children ?? []).filter(box => box.type === 'traf'));

const childTypes = (box: MutableBox): string[] => (box.children ?? []).map(child => child.type);

describe('MS-SSTR box writers', () => {
	// ffmpeg writes a tfxd of its own under `-movflags isml`, so this is a second implementation's bytes
	// rather than this one's: `ffmpeg -i video.mp4 -frames:v 24 -an -c:v copy -movflags isml+frag_keyframe
	// -f ismv out.ismv` put exactly these 44 bytes in the first traf, for a 10000000-tick fragment at 0.
	test('tfxd matches ffmpeg byte for byte', () => {
		expect(bytesToHexString(buildTfxdBox({ time: 0, duration: 10_000_000 }))).toBe(
			'0000002c757569646d1d9b0542d544e680e2141daff757b2'
			+ '0100000000000000000000000000000000989680',
		);
	});

	test('tfxd states both fields 64-bit, past where a 32-bit one would wrap', () => {
		const box = buildTfxdBox({ time: 2 ** 33, duration: 2 ** 32 + 7 });
		const view = new DataView(box.buffer, box.byteOffset, box.byteLength);

		expect(box.length).toBe(8 + 16 + 4 + 8 + 8);
		expect(box[24]).toBe(1); // version 1 is what selects the 64-bit fields
		expect(Number(view.getBigUint64(28))).toBe(2 ** 33);
		expect(Number(view.getBigUint64(36))).toBe(2 ** 32 + 7);
	});

	test('tfrf states a one-byte count then one 64-bit pair per fragment', () => {
		const box = buildTfrfBox([{ time: 100, duration: 20 }, { time: 120, duration: 30 }]);

		expect(bytesToHexString(box)).toBe(
			'0000003d75756964d4807ef2ca3946958e5426cb9e46a79f'
			+ '01000000'
			+ '02'
			+ '00000000000000640000000000000014'
			+ '0000000000000078000000000000001e',
		);
		expect(box.length).toBe(8 + 16 + 4 + 1 + 2 * 16);
	});

	test('tfrf can state the count as four bytes, which the spec prose asks for', () => {
		const one = buildTfrfBox([{ time: 1, duration: 2 }]);
		const four = buildTfrfBox([{ time: 1, duration: 2 }], { fragmentCountBytes: 4 });

		expect(four.length).toBe(one.length + 3);
		expect([...four.subarray(28, 32)]).toEqual([0, 0, 0, 1]);
	});

	test('a count that cannot be stated is refused rather than truncated', () => {
		const many = Array.from({ length: 256 }, (_, index) => ({ time: index, duration: 1 }));

		expect(() => buildTfrfBox(many)).toThrow(InvalidUsageError);
		expect(() => buildTfrfBox(many, { fragmentCountBytes: 4 })).not.toThrow();
		expect(() => buildTfrfBox([])).toThrow(InvalidUsageError);
		expect(() => buildTfxdBox({ time: -1, duration: 0 })).toThrow(TypeError);
		expect(() => buildTfxdBox({ time: 0, duration: 2 ** 53 })).toThrow(TypeError);
	});
});

describe('insertBoxesIntoTraf', () => {
	const boxes = [
		buildTfxdBox({ time: 123_456, duration: 2_000 }),
		buildTfrfBox([{ time: 125_456, duration: 2_000 }]),
	];
	const addedBytes = boxes.reduce((total, box) => total + box.length, 0);

	test('a two-track fragment keeps every sample of both tracks', async () => {
		const original = fixture(TWO_TRACK);
		const ids = await trackIds(original);
		expect(ids).toHaveLength(2);

		const before = await readAllPackets(original);
		expect(before.length).toBeGreaterThan(50);

		const out = insertBoxesIntoTraf(original, ids[0]!, boxes);

		expect(out.length).toBe(original.length + addedBytes);
		expect(await readAllPackets(out)).toEqual(before);
	}, 300_000);

	test('inserting into the second track also keeps every sample', async () => {
		const original = fixture(TWO_TRACK);
		const ids = await trackIds(original);

		const before = await readAllPackets(original);
		const out = insertBoxesIntoTraf(original, ids[1]!, boxes);

		expect(await readAllPackets(out)).toEqual(before);
	}, 300_000);

	test('inserting twice keeps every sample, so the restated offsets compose', async () => {
		const original = fixture(TWO_TRACK);
		const ids = await trackIds(original);

		const before = await readAllPackets(original);
		const once = insertBoxesIntoTraf(original, ids[0]!, boxes);
		const twice = insertBoxesIntoTraf(once, ids[1]!, boxes);

		expect(twice.length).toBe(original.length + 2 * addedBytes);
		expect(await readAllPackets(twice)).toEqual(before);
	}, 300_000);

	test('every box still walks to the end, at every nesting level', () => {
		const original = fixture(TWO_TRACK);
		const out = insertBoxesIntoTraf(original, 1, boxes);

		const types = walkBoxes(out);
		expect(types.filter(type => type === 'uuid')).toHaveLength(2);
		expect(types).toHaveLength(walkBoxes(original).length + 2);
	});

	test('the boxes land inside the named track\'s traf, after its trun', () => {
		const out = insertBoxesIntoTraf(fixture(TWO_TRACK), 1, boxes);
		const trafs = trafsIn(out);

		// Only the first fragment's first traf gains them; the sibling track and later fragments are left
		expect(childTypes(trafs[0]!)).toEqual(['tfhd', 'tfdt', 'trun', 'uuid', 'uuid']);
		expect(childTypes(trafs[1]!)).toEqual(['tfhd', 'tfdt', 'trun']);
		expect(childTypes(trafs[2]!)).toEqual(['tfhd', 'tfdt', 'trun']);
	});

	test('a trun with no data_offset keeps the bytes that are no longer its own', () => {
		// This library always writes data_offset, so the flag has to be cleared to reach the other branch.
		// The result is not a playable fragment - clearing the flag leaves four bytes the parser now reads
		// as sample fields - so this only asserts that nothing restated them.
		const stripped = fixture(TWO_TRACK);
		const trunStart = findTrunOffset(stripped);
		expect(trunStart).toBeGreaterThan(-1);

		const flagsLowByte = trunStart + 8 + 3;
		expect(stripped[flagsLowByte]! & 0x1).toBe(1);
		stripped[flagsLowByte] = stripped[flagsLowByte]! & ~0x1;
		const fieldBefore = [...stripped.subarray(trunStart + 16, trunStart + 20)];

		const out = insertBoxesIntoTraf(stripped, 1, boxes);
		expect(() => walkBoxes(out)).not.toThrow();

		const trun = (trafsIn(out)[0]!.children ?? []).find(box => box.type === 'trun')!;
		expect(trun.data![3]! & 0x1).toBe(0);
		expect([...trun.data!.subarray(8, 12)]).toEqual(fieldBefore);
	});

	test('a trun data_offset is restated by exactly what was inserted', () => {
		const original = fixture(TWO_TRACK);
		const before = trafsIn(original).map(traf =>
			readU32((traf.children ?? []).find(box => box.type === 'trun')!.data!, 8));

		const out = insertBoxesIntoTraf(original, 1, boxes);
		const after = trafsIn(out).map(traf =>
			readU32((traf.children ?? []).find(box => box.type === 'trun')!.data!, 8));

		// Neither tfhd states a base, which by ISO/IEC 14496-12 section 8.8.7 bases track 2 on the end of
		// track 1's data - but read that way its samples land past the end of this fragment's mdat, while
		// from the moof they fill it exactly (25648 video + 5037 audio = the 30685-byte payload). This
		// fixture measures both tracks from the moof, so both offsets move with it. A later fragment is
		// untouched either way.
		expect(after[0]).toBe(before[0]! + addedBytes);
		expect(after[1]).toBe(before[1]! + addedBytes);
		expect(after[2]).toBe(before[2]);
	});

	test('a missing track, or a box that is not one, is reported rather than guessed at', () => {
		expect(() => insertBoxesIntoTraf(fixture(TWO_TRACK), 99, boxes)).toThrow(MalformedInputError);
		expect(() => insertBoxesIntoTraf(fixture(TWO_TRACK), 1, [new Uint8Array(4)]))
			.toThrow(InvalidUsageError);
		expect(insertBoxesIntoTraf(fixture(TWO_TRACK), 1, [])).toHaveLength(fixture(TWO_TRACK).length);
	});
});

// A CENC fragment carries senc plus saiz/saio, and saio names the senc entries by their distance from
// the moof. Inserting after the trun puts bytes in front of them, so these are the offsets that have to
// be restated - and it is also why the boxes go after the trun rather than at the very end of the traf,
// which would leave senc no longer last and break what the encryption path recomputes from.
const CENC_KEYS = {
	key: new Uint8Array(16).fill(0x2b),
	kid: new Uint8Array(16).fill(0xa0),
	iv: new Uint8Array(16).fill(0x11),
};

/** A fragmented MP4 from this library's own muxer. Memoised: each one is a full remux of demo.mp4. */
const fragmentedMp4 = (() => {
	const cache = new Map<boolean, Promise<Uint8Array>>();
	const build = async (videoOnly: boolean) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({
			input,
			output,
			...(videoOnly ? { audio: { discard: true } } : {}),
		})).execute();
		return new Uint8Array(output.target.buffer!);
	};

	return (videoOnly = false) => {
		let built = cache.get(videoOnly);
		if (built === undefined) {
			built = build(videoOnly);
			cache.set(videoOnly, built);
		}
		return built;
	};
})();

describe('insertBoxesIntoTraf on an encrypted fragment', () => {
	// version/flags(4) + sample_count(4) past the senc box header, which is where its entries begin
	const SENC_ENTRIES_OFFSET = 8 + 4 + 4;

	const encryptedFragmented = async (): Promise<Uint8Array> =>
		encryptCmaf(await fragmentedMp4(), CENC_KEYS);

	/** Where each traf's `saio` says its `senc` entries are, and where they independently turn out to be. */
	const saioClaims = (bytes: Uint8Array) => {
		const parsed = parseBoxes(bytes, 0, bytes.length);
		const out: { stated: number; actual: number }[] = [];

		for (const box of parsed) {
			if (box.type !== 'moof') {
				continue;
			}

			let offsetInMoof = 8;
			for (const child of box.children ?? []) {
				if (child.type === 'traf') {
					let offsetInTraf = offsetInMoof + 8;
					let sencAt = -1;
					for (const grandchild of child.children ?? []) {
						if (grandchild.type === 'senc') {
							sencAt = offsetInTraf;
						}
						offsetInTraf += measureBox(grandchild);
					}
					const saio = (child.children ?? []).find(candidate => candidate.type === 'saio');
					if (saio?.data !== undefined && sencAt !== -1) {
						out.push({ stated: readU32(saio.data, 8), actual: sencAt + SENC_ENTRIES_OFFSET });
					}
				}
				offsetInMoof += measureBox(child);
			}
		}
		return out;
	};

	test('saio is restated, and still names where the senc entries actually are', async () => {
		const encrypted = await encryptedFragmented();
		const claimsBefore = saioClaims(encrypted);
		expect(claimsBefore.length).toBeGreaterThan(0);
		// Without this the comparison below proves nothing: the fixture has to arrive already consistent
		for (const { stated, actual } of claimsBefore) {
			expect(stated).toBe(actual);
		}

		const box = buildTfxdBox({ time: 1, duration: 2 });
		const out = insertBoxesIntoTraf(encrypted, 1, [box]);

		expect(() => walkBoxes(out)).not.toThrow();
		const claimsAfter = saioClaims(out);
		expect(claimsAfter).toHaveLength(claimsBefore.length);

		// The first fragment's saio moved by exactly the insertion; the later fragments' did not move at all
		expect(claimsAfter[0]!.stated).toBe(claimsBefore[0]!.stated + box.length);
		for (let i = 1; i < claimsAfter.length; i++) {
			expect(claimsAfter[i]!.stated).toBe(claimsBefore[i]!.stated);
		}
		// And every one of them still points at its own senc, which is the claim that matters
		for (const { stated, actual } of claimsAfter) {
			expect(stated).toBe(actual);
		}
	}, 300_000);

	test('senc stays the last child of the traf, which the encryption path relies on', async () => {
		const out = insertBoxesIntoTraf(await encryptedFragmented(), 1, [buildTfxdBox({ time: 1, duration: 2 })]);
		const types = childTypes(trafsIn(out)[0]!);

		expect(types[types.length - 1]).toBe('senc');
		expect(types).toContain('uuid');
		expect(types.indexOf('uuid')).toBe(types.indexOf('trun') + 1);
	}, 300_000);
});

// Nothing in this library writes an explicit tfhd base_data_offset - it only reads one, from fragments
// another packager wrote - so the branch that treats such a traf's offsets as already-absolute has to be
// reached with a synthesised fragment. The guard that makes this worth anything is that the synthesised
// file still reads back the original samples before any insertion happens.
describe('insertBoxesIntoTraf with an explicit base_data_offset', () => {
	const TFHD_TRACK_ID_END = 8 + 4 + 4; // box header + version/flags + track_ID

	/**
	 * Gives the first traf of every moof an explicit `base_data_offset`, stating the position its `trun`
	 * offsets were already implicitly measured from, grown by the 8 bytes this insertion itself adds.
	 */
	const withBaseDataOffset = (input: Uint8Array): Uint8Array => {
		let bytes = input;
		// Each splice shifts every later moof by its own 8 bytes, so the offsets are collected once up
		// front and carried forward rather than rescanned - and the base has to count that shift in.
		for (const [index, original] of moofStarts(input).entries()) {
			const moofStart = original + 8 * index;
			const trafStart = moofStart + 8 + readU32(bytes, moofStart + 8); // past mfhd
			const tfhdStart = trafStart + 8;
			const out = new Uint8Array(bytes.length + 8);
			const at = tfhdStart + TFHD_TRACK_ID_END;
			out.set(bytes.subarray(0, at));
			new DataView(out.buffer).setBigUint64(at, BigInt(moofStart + 8));
			out.set(bytes.subarray(at), at + 8);

			// version/flags sits at the box content, so the flags' low byte is 3 past the 8-byte header
			out[tfhdStart + 11] = out[tfhdStart + 11]! | 0x1;
			for (const boxStart of [tfhdStart, trafStart, moofStart]) {
				writeU32(out, boxStart, readU32(out, boxStart) + 8);
			}
			bytes = out;
		}
		return bytes;
	};

	const baseDataOffsets = (bytes: Uint8Array): number[] => trafsIn(bytes)
		.map(traf => (traf.children ?? []).find(box => box.type === 'tfhd'))
		.filter(tfhd => tfhd?.data !== undefined && ((tfhd.data[3]! & 0x1) === 1))
		.map(tfhd => Number(new DataView(
			tfhd!.data!.buffer, tfhd!.data!.byteOffset, tfhd!.data!.byteLength,
		).getBigUint64(8)));

	// One track per fragment on purpose: a second traf resolves its base from the first track's data end,
	// and the demuxer does not re-derive that chain from an explicit base, so a synthesised one on track 1
	// would move track 1 and leave track 2 behind. That is the fixture's limit, not the surgery's.
	const singleTrackFragmented = () => fragmentedMp4(true);

	test('a synthesised base_data_offset describes the same samples', async () => {
		const original = await singleTrackFragmented();
		const rebased = withBaseDataOffset(original);

		const fragments = parseBoxes(original, 0, original.length).filter(box => box.type === 'moof').length;
		expect(fragments).toBeGreaterThanOrEqual(2);
		expect(baseDataOffsets(original)).toHaveLength(0);
		expect(baseDataOffsets(rebased)).toHaveLength(fragments);
		expect(rebased.length).toBe(original.length + 8 * fragments);
		expect(await readAllPackets(rebased)).toEqual(await readAllPackets(original));
	}, 300_000);

	test('its trun offsets are left alone, since the base absorbs the shift', async () => {
		const rebased = withBaseDataOffset(await singleTrackFragmented());
		const before = await readAllPackets(rebased);
		expect(before.length).toBeGreaterThan(20);

		const out = insertBoxesIntoTraf(rebased, 1, [buildTfxdBox({ time: 7, duration: 8 })]);

		expect(await readAllPackets(out)).toEqual(before);
	}, 300_000);

	test('only the fragments at or past the insertion have their base restated', async () => {
		const rebased = withBaseDataOffset(await singleTrackFragmented());
		const before = baseDataOffsets(rebased);
		expect(before.length).toBeGreaterThanOrEqual(3);

		// Insert into the *second* fragment, so the first one's base must not move
		const box = buildTfxdBox({ time: 7, duration: 8 });
		const out = insertBoxesIntoTrafOfFragment(rebased, box);

		const after = baseDataOffsets(out);
		expect(after[0]).toBe(before[0]);
		for (let i = 1; i < after.length; i++) {
			expect(after[i]).toBe(before[i]! + box.length);
		}
	}, 300_000);

	/** Inserts into the second fragment, by hiding the first fragment's track from the search. */
	const insertBoxesIntoTrafOfFragment = (bytes: Uint8Array, box: Uint8Array): Uint8Array => {
		const masked = new Uint8Array(bytes);
		for (const moofStart of moofStarts(masked)) {
			const trafStart = moofStart + 8 + readU32(masked, moofStart + 8);
			writeU32(masked, trafStart + 8 + 12, 0xfe); // this fragment's track_ID, so the search skips it
			break;
		}
		return insertBoxesIntoTraf(masked, 1, [box]);
	};
});

describe('insertBoxesIntoTraf and the boxes that measure a fragment', () => {
	/** Every `referenced_size` a `sidx` states, in order, across all of a segment's `sidx` boxes. */
	const referencedSizes = (bytes: Uint8Array): number[] => {
		const sizes: number[] = [];
		for (const box of parseBoxes(bytes, 0, bytes.length)) {
			if (box.type !== 'sidx' || box.data === undefined) {
				continue;
			}

			// version/flags(4) + reference_ID(4) + timescale(4) + earliest/first(8 or 16) + reserved(2)
			const at = 4 + 4 + 4 + (box.data[0] === 0 ? 8 : 16) + 2;
			const count = (box.data[at]! << 8) | box.data[at + 1]!;
			for (let i = 0; i < count; i++) {
				sizes.push(readU32(box.data, at + 2 + i * 12) & 0x7fff_ffff);
			}
		}
		return sizes;
	};

	test('the sidx entry for the grown fragment is lengthened, and no other', () => {
		const original = fixture(TWO_TRACK);
		const before = referencedSizes(original);
		expect(before.length).toBeGreaterThanOrEqual(2);

		const box = buildTfxdBox({ time: 1, duration: 2 });
		const after = referencedSizes(insertBoxesIntoTraf(original, 1, [box]));

		// This fixture carries one sidx per fragment, each naming only its own, so the first entry is the
		// one that grows - a single sidx spanning every fragment would have its first entry grow instead
		expect(after[0]).toBe(before[0]! + box.length);
		expect(after.slice(1)).toEqual(before.slice(1));
	});

	test('a second traf with aux info of its own keeps its saio when the first grows', async () => {
		// cenc gives both tracks an advancing per-sample IV, so audio gets saiz/saio too - under cbcs its
		// constant IV leaves it with none, and then there is no earlier traf whose offsets could be wronged.
		const encrypted = encryptCmaf(await fragmentedMp4(), { ...CENC_KEYS, scheme: 'cenc' });

		const saiosOf = (bytes: Uint8Array) => trafsIn(bytes)
			.map(traf => (traf.children ?? []).find(box => box.type === 'saio'))
			.map(saio => saio?.data === undefined ? null : readU32(saio.data, 8));

		const before = saiosOf(encrypted);
		const trackIdOfTraf = (bytes: Uint8Array, index: number) => readU32(
			(trafsIn(bytes)[index]!.children ?? []).find(box => box.type === 'tfhd')!.data!, 4,
		);
		// Both tracks of the first fragment have to state one, or this proves nothing
		expect(before[0]).not.toBeNull();
		expect(before[1]).not.toBeNull();

		const box = buildTfxdBox({ time: 1, duration: 2 });
		const out = insertBoxesIntoTraf(encrypted, trackIdOfTraf(encrypted, 1), [box]);
		const after = saiosOf(out);

		// Inserted into the second traf, so the first one's aux info never moved
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]! + box.length);
	}, 300_000);
});
