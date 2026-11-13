/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// MXF header metadata is a flat bag of sets referencing each other by InstanceUID, so a demuxer that
// reads the right bytes can still hand back nothing: the chain Preface -> ContentStorage -> Package ->
// Track -> Sequence -> SourceClip has to resolve, and the descriptor has to find its way back to the
// track by LinkedTrackID. These read files ffmpeg wrote, so the graph is checked against a writer that
// did not come from this codebase, and against what ffprobe says is in them.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FileSlice } from '../../src/reader.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import type { EncodedPacket } from '../../src/packet.js';
import { asRational, asUint, type LocalSet } from '../../src/mxf/mxf-klv.js';
import { readPictureInfo, readSoundInfo } from '../../src/mxf/mxf-codec.js';
import { walkEssenceElements, wrappingOf } from '../../src/mxf/mxf-essence.js';
import { readHeaderMetadata, resolveTracks } from '../../src/mxf/mxf-metadata.js';
import {
	keyEditUnitBefore,
	locateEditUnit,
	presentationOrder,
	readIndexTableSegment,
} from '../../src/mxf/mxf-index.js';
import {
	readHeaderMetadataSets,
	readIndexSegmentsIn,
	readPartitions,
} from '../../src/mxf/mxf-partition.js';

const SOURCE = new URL('../public/demo.mp4', import.meta.url).pathname;

let dir: string;

const makeMxf = (name: string, args: string[]) => {
	const file = path.join(dir, name);
	execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', SOURCE, ...args, file]);
	return new Uint8Array(readFileSync(file));
};

/** The header partition's metadata, read the way the demuxer reads it. */
const headerMetadataOf = (bytes: Uint8Array) => {
	const partitions = readPartitions(FileSlice.tempFromBytes(bytes));
	const header = partitions.find(partition => partition.kind === 'header');
	expect(header, 'the file opens with no header partition').toBeDefined();

	const slice = FileSlice.tempFromBytes(bytes);
	slice.skip(header!.contentsStart);
	return readHeaderMetadataSets(slice);
};

const streamsOf = (name: string) => JSON.parse(execFileSync('ffprobe', [
	'-v', 'error', '-show_streams', '-of', 'json', path.join(dir, name),
], { encoding: 'utf8' })) as {
	streams: { codec_type: string; codec_name: string; width?: number; height?: number;
		sample_rate?: string; channels?: number; avg_frame_rate: string; }[];
};

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-mxf-'));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('MXF header metadata', () => {
	const CASES = [
		{
			name: 'mpeg2-pcm.mxf',
			label: 'MPEG-2 video with PCM audio',
			args: ['-c:v', 'mpeg2video', '-b:v', '5M', '-c:a', 'pcm_s16le', '-t', '2'],
		},
		{
			name: 'avc-pcm.mxf',
			label: 'AVC video with PCM audio',
			args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-t', '2'],
		},
		{
			name: 'video-only.mxf',
			label: 'a single picture track',
			args: ['-c:v', 'mpeg2video', '-b:v', '5M', '-an', '-t', '2'],
		},
	];

	test.each(CASES)('$label resolves to the tracks ffprobe reports', ({ name, args }) => {
		const bytes = makeMxf(name, args);
		const { sets, setTypes } = headerMetadataOf(bytes);
		expect(sets.size, 'no header metadata sets were read').toBeGreaterThan(5);

		const metadata = readHeaderMetadata(sets, setTypes);
		expect(metadata.materialPackage, 'no material package').not.toBeNull();
		expect(metadata.sourcePackages.size, 'no file package').toBeGreaterThan(0);

		const resolved = resolveTracks(metadata);
		const expected = streamsOf(name).streams
			.filter(stream => stream.codec_type === 'video' || stream.codec_type === 'audio');

		// Each essence track the file holds is reachable from the material package, through a SourceClip,
		// to a file package that has a descriptor for it. A broken link anywhere drops the track here.
		expect(resolved.map(entry => entry.track.kind).sort()).toEqual(
			expected.map(stream => stream.codec_type === 'video' ? 'picture' : 'sound').sort(),
		);

		for (const entry of resolved) {
			expect(entry.descriptor, `track ${entry.track.id} (${entry.track.kind}) has no descriptor`)
				.not.toBeNull();
			expect(entry.track.editRate, `track ${entry.track.id} states no edit rate`).not.toBeNull();
			expect(entry.track.editRate!.den).toBeGreaterThan(0);
			expect(entry.track.sourcePackageId).not.toBeNull();
		}

		// A picture track's edit rate is its frame rate, which is a number ffprobe states independently
		const picture = resolved.find(entry => entry.track.kind === 'picture');
		const videoStream = expected.find(stream => stream.codec_type === 'video');
		if (picture && videoStream) {
			const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
			expect(picture.track.editRate!.num / picture.track.editRate!.den)
				.toBeCloseTo(num! / den!, 3);
		}
	}, 120_000);

	test('a sound descriptor states the sampling rate and channel count ffprobe reads', () => {
		const name = 'mpeg2-pcm.mxf';
		makeMxf(name, CASES[0]!.args);
		const { sets, setTypes } = headerMetadataOf(
			new Uint8Array(readFileSync(path.join(dir, name))),
		);
		const resolved = resolveTracks(readHeaderMetadata(sets, setTypes));
		const sound = resolved.find(entry => entry.track.kind === 'sound')!;
		expect(sound).toBeDefined();

		const descriptor: LocalSet = sound.descriptor!;
		// AudioSamplingRate and ChannelCount, which is the minimum a caller needs to decode PCM
		const samplingRate = asRational(descriptor.get(0x3d03)!)!;
		const channels = asUint(descriptor.get(0x3d07)!);

		const stream = streamsOf(name).streams.find(entry => entry.codec_type === 'audio')!;
		expect(samplingRate.num / samplingRate.den).toBe(Number(stream.sample_rate));
		expect(channels).toBe(stream.channels);
	}, 120_000);

	test('a picture descriptor states the stored dimensions ffprobe reads', () => {
		const name = 'video-only.mxf';
		makeMxf(name, CASES[2]!.args);
		const { sets, setTypes } = headerMetadataOf(
			new Uint8Array(readFileSync(path.join(dir, name))),
		);
		const resolved = resolveTracks(readHeaderMetadata(sets, setTypes));
		const picture = resolved.find(entry => entry.track.kind === 'picture')!;
		expect(picture).toBeDefined();

		const stored = {
			width: asUint(picture.descriptor!.get(0x3203)!),
			height: asUint(picture.descriptor!.get(0x3202)!),
		};
		const display = {
			width: asUint(picture.descriptor!.get(0x3209)!),
			height: asUint(picture.descriptor!.get(0x3208)!),
		};

		// The presented size is the display one. Stored is the coded size, which MPEG-2 pads up to a
		// multiple of 16 - 360 lines are stored as 368 - so a decoder config built from Stored would
		// describe eight rows of padding as picture.
		const stream = streamsOf(name).streams.find(entry => entry.codec_type === 'video')!;
		expect(display).toEqual({ width: stream.width, height: stream.height });
		expect(stored.height).toBeGreaterThanOrEqual(display.height);
		expect(stored.width).toBeGreaterThanOrEqual(display.width);
	}, 120_000);
});

// The partition pack states where the body and index of each partition belong, and a reader that
// mis-walks them lands in essence and reads it as metadata. ffmpeg writes a header, one body and a
// footer for a file this size, so the shape is known without trusting the walk to describe itself.
describe('MXF partitions', () => {
	test('a file is a header partition, bodies, then a footer', () => {
		const bytes = makeMxf('partitions.mxf', ['-c:v', 'mpeg2video', '-b:v', '5M', '-an', '-t', '2']);
		const partitions = readPartitions(FileSlice.tempFromBytes(bytes));

		expect(partitions.length).toBeGreaterThanOrEqual(2);
		expect(partitions[0]!.kind).toBe('header');
		expect(partitions[0]!.start).toBe(0);
		expect(partitions.at(-1)!.kind).toBe('footer');

		// They run forward and do not overlap
		for (let i = 1; i < partitions.length; i++) {
			expect(partitions[i]!.start).toBeGreaterThan(partitions[i - 1]!.start);
		}

		// The essence lives in a body partition, which states the container it belongs to. A header that
		// also carries essence states one too, so this asks that *some* partition does.
		expect(partitions.some(partition => partition.bodySid !== 0)).toBe(true);
		// And the index is announced by whichever partition carries it
		expect(partitions.some(partition => partition.indexSid !== 0)).toBe(true);
	}, 120_000);

	test('the metadata walk stops at the essence rather than reading into it', () => {
		const bytes = makeMxf('stops.mxf', ['-c:v', 'mpeg2video', '-b:v', '5M', '-an', '-t', '2']);
		const partitions = readPartitions(FileSlice.tempFromBytes(bytes));
		const slice = FileSlice.tempFromBytes(bytes);
		slice.skip(partitions[0]!.contentsStart);

		const { sets, primer } = readHeaderMetadataSets(slice);
		expect(primer, 'no primer pack was read').not.toBeNull();
		expect(sets.size).toBeGreaterThan(5);

		// It stopped before the next partition, not after it: everything it read belongs to the header
		const next = partitions[1];
		if (next) {
			expect(slice.filePos).toBeLessThanOrEqual(next.start);
		}
	}, 120_000);
});

// The codec a track reports has to match what the file actually holds, and the labels this maps are
// read out of files rather than copied from a table. The cases ffmpeg can write into MXF cover more
// codecs than this library has names for: DV, JPEG 2000 and VC-3 are deliberately null, because
// reading the file and widening the public codec union are separate decisions. They still have to
// produce a track with its label as the internal id - a reader that drops them is not reading the file.
describe('MXF essence coding', () => {
	const CASES = [
		{ codec: 'mpeg2', name: 'c-mpeg2.mxf', args: ['-c:v', 'mpeg2video', '-b:v', '5M', '-an'] },
		{
			codec: 'avc',
			name: 'c-avc.mxf',
			args: ['-c:v', 'libx264', '-pix_fmt', 'yuv422p', '-an'],
		},
		{
			codec: 'prores',
			name: 'c-prores.mxf',
			args: ['-c:v', 'prores_ks', '-profile:v', '3', '-an'],
		},
		{ codec: null, name: 'c-dv.mxf', args: ['-c:v', 'dvvideo', '-s', '720x576', '-r', '25', '-an'] },
		{ codec: null, name: 'c-j2k.mxf', args: ['-c:v', 'jpeg2000', '-an'] },
		{
			codec: null,
			name: 'c-dnxhd.mxf',
			args: ['-c:v', 'dnxhd', '-s', '1920x1080', '-pix_fmt', 'yuv422p', '-b:v', '36M', '-r', '25', '-an'],
		},
	] as const;

	test.each(CASES)('$name reads as codec $codec', ({ codec, name, args }) => {
		const bytes = makeMxf(name, [...args, '-t', '1']);
		const { sets, setTypes } = headerMetadataOf(bytes);
		const resolved = resolveTracks(readHeaderMetadata(sets, setTypes));
		const picture = resolved.find(entry => entry.track.kind === 'picture');
		expect(picture, 'no picture track was resolved').toBeDefined();

		const info = readPictureInfo(picture!.descriptor!);
		expect(info.codec).toBe(codec);
		// Every one of them names its coding, including those with no codec name here
		expect(info.internalId, 'no PictureEssenceCoding label').not.toBeNull();

		const stream = streamsOf(name).streams.find(entry => entry.codec_type === 'video')!;
		expect(info.displayWidth).toBe(stream.width);
		expect(info.displayHeight).toBe(stream.height);
	}, 180_000);

	test('PCM sound reads as the width and rate ffprobe reports', () => {
		for (const [bits, expected] of [[16, 'pcm-s16'], [24, 'pcm-s24']] as const) {
			const name = `c-pcm${bits}.mxf`;
			makeMxf(name, [
				'-c:v', 'mpeg2video', '-b:v', '5M',
				'-c:a', `pcm_s${bits}le`, '-ar', '48000', '-t', '1',
			]);
			const { sets, setTypes } = headerMetadataOf(
				new Uint8Array(readFileSync(path.join(dir, name))),
			);
			const resolved = resolveTracks(readHeaderMetadata(sets, setTypes));
			const sound = resolved.find(entry => entry.track.kind === 'sound');
			expect(sound, `${name}: no sound track`).toBeDefined();

			const info = readSoundInfo(sound!.descriptor!);
			const stream = streamsOf(name).streams.find(entry => entry.codec_type === 'audio')!;
			expect(info.codec, `${name} codec`).toBe(expected);
			expect(info.sampleRate).toBe(Number(stream.sample_rate));
			expect(info.channelCount).toBe(stream.channels);
			expect(info.quantizationBits).toBe(bits);
		}
	}, 180_000);
});

// Without an index an MXF file can only be played forward: the essence is a run of KLV items with no
// back pointers. So the index is the seek, and it is wrong in a way nothing else catches - the offsets
// still look plausible. These compare what it says against the same file read by ffprobe: which edit
// units are key frames, and how many there are.
describe('MXF index tables', () => {
	/** Every index table segment in the file, from whichever partitions carry one. */
	const indexOf = (bytes: Uint8Array) => {
		const partitions = readPartitions(FileSlice.tempFromBytes(bytes));
		const sets: ReturnType<typeof readIndexSegmentsIn> = [];

		for (const partition of partitions) {
			if (partition.indexSid === 0) {
				continue;
			}

			const slice = FileSlice.tempFromBytes(bytes);
			slice.skip(partition.contentsStart);
			sets.push(...readIndexSegmentsIn(slice));
		}

		return sets.map(readIndexTableSegment);
	};

	const framesOf = (name: string) => execFileSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags',
		'-of', 'csv=p=0', path.join(dir, name),
	], { encoding: 'utf8' }).trim().split('\n');

	test('a long-GOP file indexes exactly the key frames ffprobe reports', () => {
		const name = 'idx-gop.mxf';
		const bytes = makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-g', '12', '-bf', '2', '-an', '-t', '3',
		]);
		const segments = indexOf(bytes);
		expect(segments.length, 'no index table segment was found').toBeGreaterThan(0);

		const flags = framesOf(name);
		const total = segments.reduce((sum, segment) => sum + segment.entries.length, 0);
		expect(total, 'the index covers a different number of edit units than the file has frames')
			.toBe(flags.length);

		// Each entry's random-access flag has to agree with ffprobe's own reading of the same frame.
		// Decode order on both sides: the index is in stored order, and so are ffprobe's packets.
		const indexed = segments.flatMap(segment => segment.entries.map(entry => entry.isKeyFrame));
		const expected = flags.map(flag => flag.startsWith('K'));
		expect(indexed).toEqual(expected);

		// A long-GOP file reorders, so some entry has to state a temporal offset - an index that read
		// them all as zero would still pass every check above while presenting frames in decode order
		expect(
			segments.some(segment => segment.entries.some(entry => entry.temporalOffset !== 0)),
			'no entry states a temporal offset, but the file has B-frames',
		).toBe(true);
	}, 180_000);

	test('an all-intra file is seekable at every edit unit', () => {
		const name = 'idx-intra.mxf';
		const bytes = makeMxf(name, [
			'-c:v', 'dnxhd', '-s', '1920x1080', '-pix_fmt', 'yuv422p', '-b:v', '36M', '-r', '25',
			'-an', '-t', '2',
		]);
		const segments = indexOf(bytes);
		expect(segments.length).toBeGreaterThan(0);

		const frames = framesOf(name).length;
		// Constant bit rate states one byte count and no entries at all, which is the shape an intra
		// file usually takes; either way every unit has to be reachable and decodable alone.
		for (let position = 0; position < frames; position++) {
			const located = locateEditUnit(segments, position);
			expect(located, `edit unit ${position} is not covered by any index segment`).not.toBeNull();
			expect(located!.isKeyFrame, `edit unit ${position} is not a key frame`).toBe(true);
			expect(keyEditUnitBefore(segments, position)).toBe(position);
		}

		// And the offsets run forward, which is what makes them byte positions rather than noise
		let previous = -1;
		for (let position = 0; position < frames; position++) {
			const offset = locateEditUnit(segments, position)!.streamOffset;
			expect(offset).toBeGreaterThan(previous);
			previous = offset;
		}
	}, 180_000);

	test('seeking lands on the key frame a decoder must start from', () => {
		const name = 'idx-seek.mxf';
		const bytes = makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-g', '12', '-bf', '2', '-an', '-t', '3',
		]);
		const segments = indexOf(bytes);
		const flags = framesOf(name);
		const keyFrames = flags
			.map((flag, index) => ({ flag, index }))
			.filter(entry => entry.flag.startsWith('K'))
			.map(entry => entry.index);
		expect(keyFrames.length, 'the fixture has no GOP structure to seek within').toBeGreaterThan(1);

		for (let position = 0; position < flags.length; position++) {
			const expected = keyFrames.filter(at => at <= position).at(-1)!;
			expect(keyEditUnitBefore(segments, position), `seeking to edit unit ${position}`)
				.toBe(expected);
		}
	}, 180_000);
});

// The only link between a run of essence and the metadata is the last four bytes of the element key.
// Get that wrong and a reader still produces plausible-looking frames - of the wrong track, or of the
// wrong thing entirely - so these check the attribution against what the file says it holds, and check
// that the index's offsets land where the essence actually is.
describe('MXF essence', () => {
	/** The TrackNumber the *file* package gives a track, which is what the essence keys carry. */
	const fileTrackNumber = (metadata: ReturnType<typeof readHeaderMetadata>, kind: string) => {
		for (const pkg of metadata.sourcePackages.values()) {
			for (const track of pkg.tracks) {
				if (track.kind === kind && track.trackNumber !== 0) {
					return track.trackNumber;
				}
			}
		}

		return null;
	};

	const essenceOf = (bytes: Uint8Array) => {
		const partitions = readPartitions(FileSlice.tempFromBytes(bytes));
		const elements: { trackNumber: number; start: number; length: number }[] = [];

		for (const partition of partitions) {
			if (partition.bodySid === 0) {
				continue;
			}

			const slice = FileSlice.tempFromBytes(bytes);
			slice.skip(partition.contentsStart);
			walkEssenceElements(slice, element => void elements.push(element));
		}

		return elements;
	};

	test('every element belongs to a track the metadata declares', () => {
		const name = 'ess-av.mxf';
		const bytes = makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-c:a', 'pcm_s16le', '-t', '2',
		]);
		const { sets, setTypes } = headerMetadataOf(bytes);
		const metadata = readHeaderMetadata(sets, setTypes);

		// The file package's tracks are the ones the essence is numbered for; the material package's
		// numbers are its own and need not match
		const numbers = new Map<number, string>();
		for (const pkg of metadata.sourcePackages.values()) {
			for (const track of pkg.tracks) {
				if (track.trackNumber !== 0) {
					numbers.set(track.trackNumber, track.kind);
				}
			}
		}
		expect(numbers.size, 'no file package track states a TrackNumber').toBeGreaterThan(0);

		const elements = essenceOf(bytes);
		expect(elements.length, 'no essence elements were found').toBeGreaterThan(0);

		const seen = new Set<string>();
		for (const element of elements) {
			const kind = numbers.get(element.trackNumber);
			expect(
				kind,
				`an element is numbered ${element.trackNumber}, which no track declares`
				+ ` (declared: ${[...numbers.keys()].join(', ')})`,
			).toBeDefined();
			seen.add(kind!);
		}

		// Both tracks of an A+V file carry essence, so neither is being silently dropped
		expect([...seen].sort()).toEqual(['picture', 'sound']);

		// Exactly the declared numbers, not merely a subset: a walk that attributed everything to one
		// track would still satisfy the loop above.
		const found = new Set(elements.map(element => element.trackNumber));
		expect([...found].sort()).toEqual([...numbers.keys()].sort());

		// Stated coverage limit: the last byte of a TrackNumber is the element number, and every file
		// ffmpeg writes here leaves it 0 (measured: 0x15010500 and 0x16010300). Reading only the first
		// three bytes therefore passes every assertion in this file. A fixture with two elements of the
		// same type in one container would distinguish them; nothing available here produces one.
	}, 180_000);

	test('the index offsets land on the essence elements the walk finds', () => {
		const name = 'ess-offsets.mxf';
		const bytes = makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-g', '12', '-bf', '2', '-an', '-t', '2',
		]);
		const { sets, setTypes } = headerMetadataOf(bytes);
		const metadata = readHeaderMetadata(sets, setTypes);
		const pictureNumber = fileTrackNumber(metadata, 'picture');
		expect(pictureNumber, 'no file package picture track states a TrackNumber').not.toBeNull();

		const elements = essenceOf(bytes).filter(element => element.trackNumber === pictureNumber);
		expect(elements.length).toBeGreaterThan(10);

		const partitions = readPartitions(FileSlice.tempFromBytes(bytes));
		const segments = partitions.flatMap((partition) => {
			if (partition.indexSid === 0) {
				return [];
			}
			const slice = FileSlice.tempFromBytes(bytes);
			slice.skip(partition.contentsStart);
			return readIndexSegmentsIn(slice).map(readIndexTableSegment);
		});
		expect(segments.length).toBeGreaterThan(0);

		// A stream offset is relative to the start of the essence container, so the first element fixes
		// the base. Every later offset then has to name an element the walk found - not a byte inside
		// one, which is what an off-by-a-header index produces.
		const base = elements[0]!.start;
		const starts = new Set(elements.map(element => element.start));

		for (let position = 0; position < elements.length; position++) {
			const located = locateEditUnit(segments, position);
			expect(located, `edit unit ${position} is not indexed`).not.toBeNull();
			expect(
				starts.has(base + located!.streamOffset),
				`edit unit ${position} is indexed at ${located!.streamOffset}, which is not an element`,
			).toBe(true);
		}
	}, 180_000);

	test('wrapping is read from the shape of the essence, not from a label', () => {
		const name = 'ess-wrap.mxf';
		const bytes = makeMxf(name, ['-c:v', 'mpeg2video', '-b:v', '5M', '-an', '-t', '2']);
		const { sets, setTypes } = headerMetadataOf(bytes);
		const resolved = resolveTracks(readHeaderMetadata(sets, setTypes));
		const picture = resolved.find(entry => entry.track.kind === 'picture')!;
		const number = fileTrackNumber(readHeaderMetadata(sets, setTypes), 'picture');

		const elements = essenceOf(bytes).filter(element => element.trackNumber === number);
		expect(elements.length, 'the fixture is not frame wrapped after all').toBeGreaterThan(1);
		expect(wrappingOf(elements.length, picture.track.duration)).toBe('frame');

		// And one element covering a multi-unit track is the other case, which no fixture here produces
		expect(wrappingOf(1, elements.length)).toBe('clip');
	}, 180_000);
});

// One index entry array is indexed two ways at once: the offsets by stored order, the temporal offsets
// by display order. Conflating them gives timestamps that are monotonic and plausible and wrong, and
// only where the coding reorders - so this checks against ffprobe's own pts and dts for a file with
// B-frames, which is the only place the difference shows.
describe('MXF presentation order', () => {
	test('stored units map to the positions ffprobe presents them at', () => {
		const name = 'order-gop.mxf';
		const bytes = makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-g', '12', '-bf', '2', '-an', '-t', '3',
		]);

		const partitions = readPartitions(FileSlice.tempFromBytes(bytes));
		const segments = partitions.flatMap((partition) => {
			if (partition.indexSid === 0) {
				return [];
			}
			const slice = FileSlice.tempFromBytes(bytes);
			slice.skip(partition.contentsStart);
			return readIndexSegmentsIn(slice).map(readIndexTableSegment);
		});

		// ffprobe lists packets in stored order with both times, so the n-th row is stored unit n
		const rows = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,dts',
			'-of', 'csv=p=0', path.join(dir, name),
		], { encoding: 'utf8' }).trim().split('\n').map((row) => {
			const [pts, dts] = row.split(',').map(Number);
			return { pts: pts!, dts: dts! };
		});

		// The display position is the presentation time itself: the MXF timebase is one edit unit, so
		// pts counts frames. Deriving it from pts - dts instead inherits ffmpeg's dts offset - it starts
		// the leading frame's dts at -1 to make room for the reorder - and reads one position late.
		const firstPts = Math.min(...rows.map(row => row.pts));
		const expected = new Map<number, number>();
		for (const [stored, row] of rows.entries()) {
			expected.set(stored, row.pts - firstPts);
		}

		const actual = presentationOrder(segments);
		expect(actual.size).toBe(expected.size);
		expect([...actual.entries()].sort((a, b) => a[0] - b[0]))
			.toEqual([...expected.entries()].sort((a, b) => a[0] - b[0]));

		// And it is a permutation: every position is used exactly once, which a conflated reading breaks
		expect(new Set(actual.values()).size).toBe(actual.size);
		// The fixture has to actually reorder, or this proves nothing
		expect([...actual.entries()].some(([stored, display]) => stored !== display)).toBe(true);
	}, 180_000);
});

// The layers above are only worth anything if an MXF opens through the same API as every other format
// and yields packets whose bytes are the essence. These go through `Input`, so a break anywhere in the
// chain - detection, metadata, index, essence - shows up here.
describe('MXF through the public API', () => {
	test('a file opens and reports the tracks ffprobe reports', async () => {
		const name = 'api-av.mxf';
		makeMxf(name, ['-c:v', 'mpeg2video', '-b:v', '5M', '-c:a', 'pcm_s16le', '-t', '2']);

		using input = new Input({
			source: new FilePathSource(path.join(dir, name)),
			formats: ALL_FORMATS,
		});

		expect((await input.getFormat()).name).toBe('MXF');
		expect(await input.getMimeType()).toBe('application/mxf');

		const tracks = await input.getTracks();
		const streams = streamsOf(name).streams
			.filter(stream => stream.codec_type === 'video' || stream.codec_type === 'audio');
		expect(tracks.map(track => track.type).sort()).toEqual(
			streams.map(stream => stream.codec_type).sort(),
		);

		const video = (await input.getPrimaryVideoTrack())!;
		expect(video).not.toBeNull();
		expect(await video.getCodec()).toBe('mpeg2');

		const videoStream = streams.find(stream => stream.codec_type === 'video')!;
		expect(await video.getDisplayWidth()).toBe(videoStream.width);
		expect(await video.getDisplayHeight()).toBe(videoStream.height);

		const audio = (await input.getPrimaryAudioTrack())!;
		const audioStream = streams.find(stream => stream.codec_type === 'audio')!;
		expect(await audio.getSampleRate()).toBe(Number(audioStream.sample_rate));
		expect(await audio.getNumberOfChannels()).toBe(audioStream.channels);
	}, 180_000);

	test('packets carry the essence bytes, in decode order, with the right key flags', async () => {
		const name = 'api-gop.mxf';
		makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-g', '12', '-bf', '2', '-an', '-t', '2',
		]);

		using input = new Input({
			source: new FilePathSource(path.join(dir, name)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		const rows = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size,flags',
			'-of', 'csv=p=0', path.join(dir, name),
		], { encoding: 'utf8' }).trim().split('\n').map((row) => {
			const [size, flags] = row.split(',');
			return { size: Number(size), key: flags!.startsWith('K') };
		});

		expect(packets.length).toBe(rows.length);

		// The bytes themselves: ffprobe's packet size is the essence, so a reader that handed back the
		// KLV header too, or the next element, disagrees here immediately
		expect(packets.map(packet => packet.byteLength)).toEqual(rows.map(row => row.size));
		expect(packets.map(packet => packet.type === 'key')).toEqual(rows.map(row => row.key));

		// An MPEG-2 elementary stream frame starts with a picture or sequence start code, which is what
		// says the offsets landed on essence rather than near it
		for (const packet of packets.slice(0, 5)) {
			expect([...packet.data.subarray(0, 3)]).toEqual([0x00, 0x00, 0x01]);
		}

		// Decode order is what the sink yields; presentation runs ahead of it where the file reorders
		for (let i = 1; i < packets.length; i++) {
			expect(packets[i]!.decodeTimestamp).toBeGreaterThan(packets[i - 1]!.decodeTimestamp);
		}
		expect(
			packets.some(packet => packet.timestamp !== packet.decodeTimestamp),
			'no packet is reordered, but the fixture has B-frames',
		).toBe(true);
	}, 180_000);

	test('seeking returns the key packet a decoder must start from', async () => {
		const name = 'api-seek.mxf';
		makeMxf(name, [
			'-c:v', 'mpeg2video', '-b:v', '5M', '-g', '12', '-bf', '2', '-an', '-t', '3',
		]);

		using input = new Input({
			source: new FilePathSource(path.join(dir, name)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);

		const all: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			all.push(packet);
		}
		const keyTimes = all.filter(packet => packet.type === 'key').map(packet => packet.timestamp);
		expect(keyTimes.length).toBeGreaterThan(1);

		for (const packet of all) {
			const key = await sink.getKeyPacket(packet.timestamp);
			expect(key, `no key packet for ${packet.timestamp}`).not.toBeNull();
			expect(key!.type).toBe('key');
			expect(key!.timestamp).toBeLessThanOrEqual(packet.timestamp + 1e-9);
		}
	}, 180_000);
});

// MXF states a start timecode in its own metadata rather than in the bitstream, as a frame count since
// midnight on a TimecodeComponent. The documentation now says this track type is read, so it has to be.
describe('MXF start timecode', () => {
	test.each([
		{ label: 'non-drop at 25', args: ['-r', '25'], timecode: '10:00:00:00', dropFrame: false },
		{ label: 'an hour in', args: ['-r', '25'], timecode: '01:02:03:04', dropFrame: false },
	])('$label reads back as it was written', ({ args, timecode, dropFrame }) => {
		const name = `tc-${timecode.replace(/:/g, '')}.mxf`;
		const file = path.join(dir, name);
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-i', SOURCE, '-c:v', 'mpeg2video', '-b:v', '5M', '-an',
			...args, '-timecode', timecode, '-t', '1', file,
		]);

		const { sets, setTypes } = headerMetadataOf(new Uint8Array(readFileSync(file)));
		const metadata = readHeaderMetadata(sets, setTypes);

		// The timecode lives on its own track of the material package, beside the picture track
		const found = metadata.materialPackage!.tracks
			.map(track => track.startTimecode)
			.find(entry => entry !== null);
		expect(found, 'no track carries a start timecode').toBeDefined();

		const [hours, minutes, seconds, frames] = timecode.split(':').map(Number);
		const expected = ((hours! * 60 + minutes!) * 60 + seconds!) * found!.base + frames!;
		expect(found!.startFrame).toBe(expected);
		expect(found!.dropFrame).toBe(dropFrame);
		expect(found!.base).toBe(25);
	}, 180_000);

	test('a track reports it through the public API', async () => {
		const name = 'tc-api.mxf';
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-i', SOURCE, '-c:v', 'mpeg2video', '-b:v', '5M', '-an',
			'-r', '25', '-timecode', '10:11:12:13', '-t', '1', path.join(dir, name),
		]);

		using input = new Input({
			source: new FilePathSource(path.join(dir, name)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const started = await track.getStartTimecode();

		expect(started, 'the picture track reports no start timecode').not.toBeNull();
		expect(started).toEqual({
			hours: 10,
			minutes: 11,
			seconds: 12,
			frames: 13,
			dropFrame: false,
			frameRate: 25,
		});
	}, 180_000);
});

// Two shapes the fixtures above never produce, and both read as nothing rather than as wrong - which
// is why neither showed up until the code was read rather than run. A constant-bit-rate index states
// no entries and an unbounded duration, so the walk that builds the sample table has no natural end;
// and the footer that carries the index sits past the window a reader opens at the front of any file
// bigger than it.
describe('MXF shapes the small fixtures miss', () => {
	test('an all-intra file with a constant-bit-rate index yields its frames', async () => {
		const name = 'cbr.mxf';
		makeMxf(name, [
			'-c:v', 'dnxhd', '-s', '1920x1080', '-pix_fmt', 'yuv422p', '-b:v', '36M', '-r', '25',
			'-an', '-t', '2',
		]);

		using input = new Input({
			source: new FilePathSource(path.join(dir, name)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;

		// VC-3 has no codec name in this library, which must not stop the track being read
		expect(await track.getCodec()).toBeNull();

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		const rows = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size',
			'-of', 'csv=p=0', path.join(dir, name),
		], { encoding: 'utf8' }).trim().split('\n').map(Number);

		expect(packets.length, 'the constant-bit-rate walk produced the wrong number of frames')
			.toBe(rows.length);
		expect(packets.map(packet => packet.byteLength)).toEqual(rows);
		// Every unit of an intra file stands alone
		expect(packets.every(packet => packet.type === 'key')).toBe(true);
	}, 300_000);

	test('a file whose footer lies past the front window is still indexed', async () => {
		const name = 'big.mxf';
		// Scaled up rather than lengthened: the source is short, so resolution and quality are what push
		// the file past the window. A stated bitrate does not - MPEG-2's buffer model caps it well below
		// 45M - so the quantiser is what makes the file big. And it must be long-GOP MPEG-2 rather than
		// an intra codec: ffmpeg puts a constant-bit-rate index in the *header* partition, which the
		// front window finds anyway, so only this shape reaches the footer at all.
		makeMxf(name, [
			'-c:v', 'mpeg2video', '-s', '1920x1080', '-qscale:v', '1', '-g', '12', '-bf', '2', '-an',
		]);

		const size = statSync(path.join(dir, name)).size;
		// The point of the fixture: if it fits in the window, this proves nothing
		expect(size, 'the fixture is not larger than the window a reader opens at the front')
			.toBeGreaterThan(4 * 1024 * 1024);

		using input = new Input({
			source: new FilePathSource(path.join(dir, name)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		const rows = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size',
			'-of', 'csv=p=0', path.join(dir, name),
		], { encoding: 'utf8' }).trim().split('\n').map(Number);

		expect(packets.length, 'no packets: the index in the footer was never found').toBe(rows.length);
		expect(packets.map(packet => packet.byteLength)).toEqual(rows);
	}, 300_000);
});
