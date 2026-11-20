/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Every other MXF the suite reads is one ffmpeg wrote, which is one writer's shape of a format whose
// whole difficulty is that writers disagree. These are files from Avid, Sony, Omneon, Apple and
// Quantel, fetched by `npm run capture-mxf-fixtures`, and each expectation is taken from ffmpeg
// reading the same file rather than stated here - so agreeing with ourselves is not enough to pass.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { FilePathSource } from '../../src/source.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS = path.join(__dirname, '../fixtures/mxf');

const hasCorpus = existsSync(path.join(CORPUS, 'Sony-00001.mxf'));
const hasFfmpeg = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

const open = async (name: string) => {
	const input = new Input({ source: new FilePathSource(path.join(CORPUS, name)), formats: ALL_FORMATS });
	return { input, tracks: await input.getTracks() };
};

/** What ffprobe says each stream of a file is. */
const probeStreams = (name: string) => execFileSync('ffprobe', [
	'-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate',
	'-of', 'json', path.join(CORPUS, name),
], { encoding: 'utf8' });

describe.skipIf(!hasCorpus)('MXF files other vendors wrote', () => {
	// Each of these was unreadable, and each for its own reason. The comment on each says which.
	test.each([
		// Avid writes private metadata sets under keys beginning 0x80, and an index entry array of no
		// entries that states no entry size either
		['Avid-00005.mxf', 3, 1.0],
		// Eight octets of run-in before the header partition pack, which SMPTE 377-1 allows, and an
		// index at 1/2 Hz against a 25 fps track - its positions are in its own units, not the
		// track's, which made this read as 0.080 s
		['C0023S01.mxf', 5, 3.8],
		// Clip wrapping: the index counts bytes inside one element rather than whole KLV triplets
		['track_01_v02.mxf', 1, 0.417],
		['track_02_a01.mxf', 1, 0.459],
		['multiple_components.mxf', 1, 0.25],
		// The index is in the footer and the header partition pack does not say where that is, so the
		// Random Index Pack at the end of the file is the only thing that does
		['omneon_8.3.0.0_xdcam_startc_footer.mxf', 9, 0.72],
		// Clip-wrapped with no index at all: one element, one sample
		['opatom_missing_index.mxf', 1, 0.083],
		// One Avid-registry essence element, reached through an EssenceGroup
		['opatom_essencegroup_alpha_raw.mxf', 1, 0.042],
		['Sony-00001.mxf', 2, 0.16],
		['Meridian-Apple_ProResProxy-HDR10.mxf', 3, 0.083],
	])('%s opens with its tracks', async (name, trackCount, duration) => {
		const { input, tracks } = await open(name);

		expect(tracks).toHaveLength(trackCount);
		if (duration !== null) {
			expect(await input.computeDuration()).toBeCloseTo(duration, 2);
		}
	});

	test.skipIf(!hasFfmpeg)('every track is the one ffmpeg finds, with the codec ffmpeg names', async () => {
		// Codecs this library has no name for stay null rather than being guessed at: DV, MPEG-4
		// part 2 and JPEG 2000 are not in its union, and uncompressed RGBA states no coding label at
		// all, so those tracks are counted but not named.
		const UNNAMED = new Set(['dvvideo', 'mpeg4', 'jpeg2000', 'rawvideo']);
		const naming: Record<string, string> = {
			mpeg2video: 'mpeg2', prores: 'prores', dnxhd: 'dnxhd',
			pcm_s16le: 'pcm-s16', pcm_s24le: 'pcm-s24', pcm_alaw: 'alaw',
		};

		for (const name of ['Avid-00005.mxf', 'C0023S01.mxf', 'Sony-00001.mxf', 'track_01_v02.mxf',
			'multiple_components.mxf', 'Meridian-Apple_ProResProxy-HDR10.mxf',
			'omneon_8.3.0.0_xdcam_startc_footer.mxf', 'opatom_missing_index.mxf', 'track_02_a01.mxf']) {
			const theirs = (JSON.parse(probeStreams(name)) as {
				streams: { codec_type: string; codec_name: string }[];
			}).streams.filter(stream => stream.codec_type === 'video' || stream.codec_type === 'audio');

			const { tracks } = await open(name);
			expect(tracks.length, name).toBe(theirs.length);

			for (const [index, track] of tracks.entries()) {
				const stream = theirs[index]!;
				expect(track.type, `${name} #${index} type`).toBe(stream.codec_type);
				const expected = UNNAMED.has(stream.codec_name) ? null : naming[stream.codec_name] ?? null;
				expect(await track.getCodec(), `${name} #${index} codec (${stream.codec_name})`)
					.toBe(expected);
			}
		}
	});

	test.skipIf(!hasFfmpeg)('and the essence we hand back is the essence ffmpeg hands back', async () => {
		// The assertion that cannot be satisfied by agreeing with ourselves: every byte of the
		// elementary stream, against ffmpeg's own copy of it. Packet boundaries are a reader's
		// choice - a clip-wrapped PCM track's edit unit is one sample, and ffmpeg groups them - so
		// this compares the streams rather than the packets.
		for (const [name, kind] of [
			['track_01_v02.mxf', 'v'], ['multiple_components.mxf', 'v'], ['Sony-00001.mxf', 'v'],
			['omneon_8.3.0.0_xdcam_startc_footer.mxf', 'v'], ['Meridian-Apple_ProResProxy-HDR10.mxf', 'v'],
			['omneon_8.3.0.0_xdcam_startc_footer.mxf', 'a'], ['track_02_a01.mxf', 'a'],
			['opatom_missing_index.mxf', 'a'], ['Meridian-Apple_ProResProxy-HDR10.mxf', 'a'],
			// D-10 audio, which is AES3 rather than the PCM its descriptor describes
			['Sony-00001.mxf', 'a'],
		] as const) {
			const theirs = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(CORPUS, name),
				'-map', `0:${kind}:0`, '-c', 'copy', '-f', 'data', '-'], { maxBuffer: 1 << 28 });

			const { tracks } = await open(name);
			const track = tracks.find(t => t.type === (kind === 'v' ? 'video' : 'audio'))!;
			const chunks: Uint8Array[] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				chunks.push(packet.data);
			}

			expect(Buffer.concat(chunks).equals(theirs), `${name} ${kind}`).toBe(true);
		}
	}, 60_000);

	test('a material track reaches its essence through an EssenceGroup', async () => {
		// An EssenceGroup offers the same essence in several representations, one SourceClip each,
		// and in an OP-Atom set most of them live in sibling files. Following the choices is what
		// makes the track point at anything at all: before this, both of this file's picture tracks
		// named no source package and were dropped.
		const { readPartitions, readHeaderMetadataSets } = await import('../../src/mxf/mxf-partition.js');
		const { readHeaderMetadata, resolveTracks } = await import('../../src/mxf/mxf-metadata.js');
		const { FileSlice } = await import('../../src/reader.js');

		const bytes = new Uint8Array(readFileSync(path.join(CORPUS, 'opatom_essencegroup_alpha_raw.mxf')));
		const header = readPartitions(FileSlice.tempFromBytes(bytes))
			.find(partition => partition.kind === 'header')!;
		const { sets, setTypes } = readHeaderMetadataSets(
			FileSlice.tempFromBytes(bytes.subarray(header.contentsStart)),
		);
		const metadata = readHeaderMetadata(sets, setTypes);

		expect(metadata.materialPackage!.tracks).toHaveLength(2);

		// One of the two reaches a package this file carries; the other's only choice is in a sibling
		// file, and a track pointing outside its own file is honestly unresolvable
		const resolved = resolveTracks(metadata);
		expect(resolved).toHaveLength(1);
		expect(metadata.sourcePackages.has(resolved[0]!.track.sourcePackageId!)).toBe(true);
	});

	test.skipIf(!hasFfmpeg)('clip-wrapped PCM is grouped rather than handed back a sample at a time', async () => {
		// A clip-wrapped PCM edit unit is one audio sample, so this track indexes 22,022 units of
		// three octets. Correct and useless: the bytes are right and nothing can decode them a sample
		// at a time. The grouping is a reader's choice, so the count is checked against the reader
		// that makes the same choice rather than against a number written here.
		const theirs = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=pos',
			'-of', 'csv=p=0', path.join(CORPUS, 'track_02_a01.mxf'),
		], { encoding: 'utf8' }).trim().split('\n').length;

		const { tracks } = await open('track_02_a01.mxf');
		let packets = 0;
		let bytes = 0;
		for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
			packets++;
			bytes += packet.byteLength;
		}

		expect(packets).toBe(theirs);
		// And no essence is lost to the grouping: 22,022 samples of three octets, all of them
		expect(bytes).toBe(22022 * 3);
	}, 30_000);

	test('an essence element under a vendor registry is still an essence element', async () => {
		// Octet 8 of an element key names the registry: `0d` is the Generic Container's and anything
		// else is somebody's own. This file's one element is Avid's `0e 04 03 01`, so a reader that
		// knows only the standard key finds no essence and reports a file with no tracks.
		const { tracks } = await open('opatom_essencegroup_alpha_raw.mxf');
		expect(tracks).toHaveLength(1);

		let bytes = 0;
		for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
			bytes += packet.byteLength;
		}

		// 1920x1080 8-bit, one frame. The stored element is 2,080,768 octets - 508 x 4096, padded up to
		// the container's alignment grid - and a frame is its leading width x height, which is what is
		// handed back and what `ffmpeg -f rawvideo` decodes to.
		expect(bytes).toBe(1920 * 1080);
	}, 30_000);

	test.skipIf(!hasFfmpeg)('an uncompressed track states its layout and yields whole frames', async () => {
		// `rawvideo` carries its pixel layout in the decoder config's description, as a Y4M tag, since
		// an uncompressed frame says nothing about itself. This file's PixelLayout is a single `A`
		// component of eight bits, which ffmpeg reads as `gray` and which `Cmono` is the Y4M spelling
		// of. The descriptor states no PictureEssenceCoding at all, so the codec comes from the layout.
		const { tracks } = await open('opatom_essencegroup_alpha_raw.mxf');
		const track = tracks[0]!;
		expect(track.type).toBe('video');
		expect(await track.getCodec()).toBe('rawvideo');

		expect(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
			'-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0',
			path.join(CORPUS, 'opatom_essencegroup_alpha_raw.mxf')], { encoding: 'utf8' }).trim())
			.toBe('gray');

		assert(track.isVideoTrack());
		const config = await track.getDecoderConfig();
		expect(config?.codec).toBe('rawvideo');
		expect(new TextDecoder().decode(config!.description as Uint8Array)).toBe('Cmono');

		// The acceptance that is not ours to state: the frames decode to ffmpeg's frames, octet for
		// octet. `-c copy` cannot be the oracle here - it hands back the padded element.
		const chunks: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			chunks.push(packet.data);
		}

		const theirs = execFileSync('ffmpeg', ['-v', 'error', '-i',
			path.join(CORPUS, 'opatom_essencegroup_alpha_raw.mxf'),
			'-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
		expect(Buffer.concat(chunks).equals(theirs)).toBe(true);
	}, 30_000);

	test('every track yields the packets its index points at', async () => {
		// Opening a file proves its metadata reads; this proves the offsets it derived are real
		// positions in the essence. `C0023S01.mxf` is the case that needs it: its index is constant
		// bit rate, which answers for every position ever asked, so a walk bounded by the file rather
		// than by the essence reads the footer as a content package.
		for (const name of ['C0023S01.mxf', 'Avid-00005.mxf', 'multiple_components.mxf']) {
			const { tracks } = await open(name);
			for (const track of tracks) {
				let count = 0;
				let bytes = 0;
				for await (const packet of new EncodedPacketSink(track).packets()) {
					count++;
					bytes += packet.byteLength;
				}

				expect(count, `${name} ${track.type}`).toBeGreaterThan(0);
				expect(bytes, `${name} ${track.type}`).toBeGreaterThan(0);
			}
		}
	}, 30_000);

	test.skipIf(!hasFfmpeg)('an index at its own edit rate is counted in its own units', async () => {
		// `C0023S01.mxf` indexes one entry per 524288-octet content package at 1/2 Hz, each holding
		// about fifty frames of a 25 fps track. Counting those positions in the track's units made it
		// 0.080 s long. The duration comes from ffprobe rather than from this file's own arithmetic.
		const probed = Number(execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
			path.join(CORPUS, 'C0023S01.mxf'),
		], { encoding: 'utf8' }).trim());

		const { input } = await open('C0023S01.mxf');
		expect(await input.computeDuration()).toBeCloseTo(probed, 2);

		// Two entries, and the last is short: 2 s then 1.8 s, not 2 s then 2 s
		const { tracks } = await open('C0023S01.mxf');
		const video = tracks.find(track => track.type === 'video')!;
		const durations: number[] = [];
		for await (const packet of new EncodedPacketSink(video).packets()) {
			durations.push(packet.duration);
		}

		expect(durations).toHaveLength(2);
		expect(durations[0]).toBeCloseTo(2, 3);
		expect(durations[1]).toBeCloseTo(1.8, 3);
	}, 30_000);

	test('the AES3 group stride is 32 octets however many channels are used', async () => {
		// The one rule in SMPTE 331M that a reader gets wrong by reasoning rather than reading: the
		// group holds eight 32-bit subframes whatever the channel count, so a four-channel element
		// still steps 32 octets a sample and the four unused slots are skipped. Sony's file is
		// 8-channel, where a `channels * 4` stride is accidentally the same 32 - so this is built
		// rather than found.
		const { unwrapD10Aes3 } = await import('../../src/mxf/mxf-demuxer.js');

		const SAMPLES = 3;
		const element = new Uint8Array(4 + SAMPLES * 32);
		const view = new DataView(element.buffer);
		for (let sample = 0; sample < SAMPLES; sample++) {
			for (let slot = 0; slot < 8; slot++) {
				// Slots 0..3 carry 0x1111, 0x2222 … per sample; 4..7 are padding a reader must skip
				const value = slot < 4 ? ((sample + 1) * 0x1000 + slot) : 0x7fff;
				view.setUint32(4 + sample * 32 + slot * 4, value << 12, true);
			}
		}

		const pcm = unwrapD10Aes3(element, 4, 16);
		expect(pcm.byteLength).toBe(SAMPLES * 4 * 2);

		const read = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		for (let sample = 0; sample < SAMPLES; sample++) {
			for (let channel = 0; channel < 4; channel++) {
				expect(read.getUint16((sample * 4 + channel) * 2, true), `s${sample}c${channel}`)
					.toBe((sample + 1) * 0x1000 + channel);
			}
		}
	});

	test('D-10 audio is unwrapped from AES3, not handed back as subframes', async () => {
		// SMPTE 386M carries D-10 audio as SMPTE 331M AES3: four octets of header, then a 32-octet
		// group per sample holding eight 32-bit subframes whatever the channel count. The descriptor
		// says 8-channel 16-bit PCM, so handing the element back unchanged hands back noise at twice
		// the length - which is exactly what it did.
		const { tracks } = await open('Sony-00001.mxf');
		const track = tracks.find(candidate => candidate.type === 'audio')!;
		expect(await track.getCodec()).toBe('pcm-s16');
		expect(track.isAudioTrack() && await track.getNumberOfChannels()).toBe(8);

		let bytes = 0;
		let packets = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			bytes += packet.byteLength;
			packets++;
		}

		// Each element is 61444 octets: the 4-octet header plus 1920 groups of 32. Unwrapped that is
		// 1920 samples x 8 channels x 2 octets = 30720 a frame, which is 8 of every 32 octets read.
		expect(packets).toBe(4);
		expect(bytes).toBe(4 * 1920 * 8 * 2);
	}, 30_000);

	test.skipIf(!hasFfmpeg)('a corrupted file is refused, so passing means something', async () => {
		// Every assertion above is that a file reads. This is the control: a file whose header
		// partition key has been broken must not read as MXF at all.
		const bytes = new Uint8Array(readFileSync(path.join(CORPUS, 'Sony-00001.mxf')));
		bytes[2] = 0xff;

		const { BufferSource } = await import('../../src/source.js');
		const input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
		await expect(input.getTracks()).rejects.toThrow();
	});
});

describe.skipIf(!hasCorpus || !hasFfmpeg)('what the file says about itself', () => {
	/** The format-level tags ffprobe reports, which is what these are compared against. */
	const probeTags = (name: string): Record<string, string> => {
		const out = execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path.join(CORPUS, name),
		], { encoding: 'utf8' });
		return (JSON.parse(out) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
	};

	const READ_HERE = [
		'company_name', 'product_name', 'product_version', 'product_version_num', 'product_uid',
		'toolkit_version_num', 'application_platform', 'generation_uid', 'uid', 'modification_date',
		'operational_pattern_ul', 'material_package_name', 'project_name',
	];

	// The three Avid files below are listed again underneath, because ffmpeg loses fields on them and
	// agreeing with it there would mean losing the same ones.
	test.each([
		'Avid-00005.mxf',
		'C0023S01.mxf',
		'Meridian-Apple_ProResProxy-HDR10.mxf',
		'Sony-00001.mxf',
		'multiple_components.mxf',
		'omneon_8.3.0.0_xdcam_startc_footer.mxf',
		'track_01_v02.mxf',
	])('%s states the same company, product and dates ffmpeg reads', async (name) => {
		const { input } = await open(name);
		const ours = (await input.getMetadataTags()).raw ?? {};
		const theirs = probeTags(name);

		const compared = Object.keys(theirs).filter(key => READ_HERE.includes(key));
		expect(compared.length).toBeGreaterThan(5);

		for (const key of compared) {
			const mine = ours[key];
			expect(typeof mine, `${key} is absent`).toBe('string');

			if (key === 'modification_date') {
				expect(new Date(mine as string).getTime()).toBe(new Date(theirs[key]!).getTime());
			} else {
				expect((mine as string).trim(), key).toBe(theirs[key]!.trim());
			}
		}
	});

	// Avid writes the version fields nine octets long instead of ten. ffmpeg reads the fifth component
	// anyway, taking the first octet of the NEXT local tag as its high byte - 0x3c, which is why it
	// reports a toolkit version of 1.1.0.0.60 - and then reads the rest of that set one octet out of
	// step, losing every field written after it.
	test.each([
		'track_02_a01.mxf',
		'opatom_missing_index.mxf',
		'opatom_essencegroup_alpha_raw.mxf',
	])('%s keeps the fields ffmpeg drops after a nine-octet version', async (name) => {
		const { input } = await open(name);
		const ours = (await input.getMetadataTags()).raw ?? {};
		const theirs = probeTags(name);

		expect(theirs['toolkit_version_num']).toBe('1.1.0.0.60');
		expect(ours['toolkit_version_num']).toBe('1.1.0.0');

		for (const key of ['company_name', 'product_name', 'product_uid', 'modification_date']) {
			expect(theirs[key], `ffmpeg unexpectedly read ${key}`).toBeUndefined();
			expect(typeof ours[key], `${key} is absent here too`).toBe('string');
		}

		expect(ours['company_name']).toBe('Avid Technology, Inc.');
	});

	test('the Preface states when the file was last written', async () => {
		const { input } = await open('Sony-00001.mxf');
		const tags = await input.getMetadataTags();
		expect(tags.creationTime).toBeInstanceOf(Date);
		expect(tags.creationTime!.getUTCFullYear()).toBe(2004);
	});
});
