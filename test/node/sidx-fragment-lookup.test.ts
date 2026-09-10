/*!
 * A fragmented file that carries a `sidx` but no `mfra` — the DASH on-demand / CMAF layout — must
 * seek through the segment index instead of walking the file `moof` by `moof` from byte 0. These
 * tests pin that by counting the bytes the demuxer actually reads.
 */
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomSource } from '../../src/source.js';
import { assert } from '../../src/misc.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const __dirname = new URL('.', import.meta.url).pathname;
const FIXTURE = path.join(__dirname, '../public/bear-640x360-av_frag.mp4');

const buildSidx = (opts: {
	referenceID: number;
	timescale: number;
	subsegments: { size: number; duration: number }[];
}) => {
	const bytes = new Uint8Array(40 + 12 * opts.subsegments.length);
	const view = new DataView(bytes.buffer);

	view.setUint32(0, bytes.length);
	bytes.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'
	view.setUint8(8, 1); // Version 1: 64-bit times
	view.setUint32(12, opts.referenceID);
	view.setUint32(16, opts.timescale);
	view.setBigUint64(20, 0n); // Earliest presentation time
	view.setBigUint64(28, 0n); // First offset
	view.setUint16(36, 0); // Reserved
	view.setUint16(38, opts.subsegments.length);

	opts.subsegments.forEach((subsegment, i) => {
		const at = 40 + 12 * i;
		view.setUint32(at, subsegment.size & 0x7fffffff); // Reference type 0 + size
		view.setUint32(at + 4, subsegment.duration);
		view.setUint32(at + 8, 0x90000000); // Starts with SAP, type 1
	});

	return bytes;
};

/**
 * Rewrites the fixture into the DASH on-demand layout: everything up to the first fragment, then a
 * single `sidx` indexing every `moof`/`mdat` pair, then the fragments. The fixture's own
 * per-fragment `sidx`/`styp` boxes are dropped.
 */
const buildOnDemandLayout = async (trackTimescale: number, totalDuration: number) => {
	const original = new Uint8Array(await readFile(FIXTURE));
	const boxes = readTopLevelBoxes(original);

	const firstFragmentIndex = boxes.findIndex(box => box.name === 'moof');
	assert(firstFragmentIndex !== -1);

	const header = boxes.slice(0, firstFragmentIndex).filter(box => box.name !== 'sidx');
	const fragments = boxes.slice(firstFragmentIndex).filter(box => box.name === 'moof' || box.name === 'mdat');

	const subsegmentSizes: number[] = [];
	for (let i = 0; i < fragments.length; i += 2) {
		const moof = fragments[i]!;
		const mdat = fragments[i + 1]!;
		expect(moof.name).toBe('moof');
		expect(mdat.name).toBe('mdat');
		subsegmentSizes.push(moof.size + mdat.size);
	}

	// The fixture's fragments are near enough uniform in duration; the index only has to steer the
	// search, and the demuxer verifies against the real fragment data once it lands.
	const durationPerSubsegment = Math.round(totalDuration * trackTimescale / subsegmentSizes.length);
	const sidx = buildSidx({
		referenceID: 1,
		timescale: trackTimescale,
		subsegments: subsegmentSizes.map(size => ({ size, duration: durationPerSubsegment })),
	});

	const headerBytes = header.map(box => original.subarray(box.start, box.start + box.size));
	const fragmentBytes = fragments.map(box => original.subarray(box.start, box.start + box.size));
	const parts = [...headerBytes, sidx, ...fragmentBytes];

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}

	return out;
};

const countingSource = (bytes: Uint8Array) => {
	const counter = { bytesRead: 0 };
	const source = new CustomSource({
		getSize: () => bytes.length,
		read: (start, end) => {
			counter.bytesRead += end - start;
			return bytes.subarray(start, end);
		},
	});

	return { source, counter };
};

const readTrackTimescaleAndDuration = async () => {
	using input = new Input({
		source: new BufferSource(new Uint8Array(await readFile(FIXTURE))),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	return { timescale: await track.getTimeResolution(), duration: await input.computeDuration() };
};

const measureVideoDuration = async (bytes: Uint8Array) => {
	const { source, counter } = countingSource(bytes);
	using input = new Input({ source, formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	return { duration: await track.computeDuration(), bytesRead: counter.bytesRead };
};

test('a sidx lets computeDuration skip to the last fragment instead of walking the file', async () => {
	const { timescale, duration } = await readTrackTimescaleAndDuration();
	const indexed = await buildOnDemandLayout(timescale, duration);

	const withSidx = await measureVideoDuration(indexed);
	const withoutSidx = await measureVideoDuration(stripSidx(indexed));

	// Same answer either way — the index changes how much of the file it costs to get there.
	expect(withSidx.duration).toBeCloseTo(withoutSidx.duration, 6);
	expect(withSidx.bytesRead).toBeLessThan(withoutSidx.bytesRead / 2);
});

test('a sidx indexes every subsegment, not just the first', async () => {
	const { timescale, duration } = await readTrackTimescaleAndDuration();
	const bytes = await buildOnDemandLayout(timescale, duration);

	const { source } = countingSource(bytes);
	using input = new Input({ source, formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	await track.computeDuration();

	const lookupTable = (track as unknown as {
		_backing: { internalTrack: { fragmentLookupTable: { moofOffset: number }[] } };
	})._backing.internalTrack.fragmentLookupTable;
	const moofOffsets = readTopLevelBoxes(bytes).filter(box => box.name === 'moof').map(box => box.start);

	expect(lookupTable.map(entry => entry.moofOffset)).toEqual(moofOffsets);
});

const stripSidx = (bytes: Uint8Array) => {
	const boxes = readTopLevelBoxes(bytes).filter(box => box.name !== 'sidx');
	const out = new Uint8Array(boxes.reduce((sum, box) => sum + box.size, 0));

	let at = 0;
	for (const box of boxes) {
		out.set(bytes.subarray(box.start, box.start + box.size), at);
		at += box.size;
	}

	return out;
};
