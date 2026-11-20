/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// An MXF carrying a SMPTE 436M ancillary data track, which is how a broadcast master carries VANC -
// captions, AFD, timecode - beside its picture and sound.
//
// This library has no track type for ancillary essence, and until this was fixed the track fell through
// to the AUDIO backing: opening an ordinary captioned master gave back a bogus audio track that threw an
// assertion the moment anything asked it for a channel count. Leaving the track out is the honest answer
// until there is a surface for it; the picture and sound tracks must read exactly as before.
//
// The fixture is built here rather than vendored, through the chain this fork already owns both ends of:
// our SCTE-20 writer puts captions into an MPEG-2 picture, and ffmpeg turns those into a 436M ancillary
// track when it writes MXF.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { ancillaryCaptionsOf, ancillaryPacketsOf } from '../../src/ancillary.js';

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
let ancillaryMxf: string;

beforeAll(async () => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-anc-'));
	if (!hasFfmpeg) {
		return;
	}

	// An MPEG-2 transport stream to splice captions into
	const plain = path.join(workDir, 'plain.ts');
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=352x288:rate=25:duration=0.5',
		'-c:v', 'mpeg2video', '-b:v', '2M', '-f', 'mpegts', plain,
	]);

	// Our own SCTE-20 writer puts the captions in
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(plain) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('mpeg2');
	output.addVideoTrack(source, {
		frameRate: 25,
		closedCaptions: { announceInManifest: false, channels: ['CC1'] },
	});
	await output.start();

	const sink = new EncodedPacketSink(track);
	let written = 0;
	for (
		let packet = await sink.getFirstPacket();
		packet && written < 8;
		packet = await sink.getNextPacket(packet)
	) {
		await source.add(packet, {
			decoderConfig,
			closedCaptions: [{ type: 0, byte0: 0x41, byte1: 0x42 }],
		});
		written++;
	}
	await output.finalize();

	const captioned = path.join(workDir, 'captioned.ts');
	writeFileSync(captioned, new Uint8Array(output.target.buffer!));

	// ffmpeg lifts them out as a caption stream and writes them as a 436M ancillary track. `movie=` is
	// resolved against the process's working directory, so the input is named relative to it.
	ancillaryMxf = path.join(workDir, 'anc.mxf');
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-f', 'lavfi', '-i', `movie=${captioned}[out0+subcc]`,
		'-map', '0:0', '-map', '0:1',
		'-c:v', 'mpeg2video', '-b:v', '5M', '-pix_fmt', 'yuv422p', '-c:s', 'copy',
		'-f', 'mxf', ancillaryMxf,
	], { cwd: workDir });
}, 120_000);

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg)('an MXF with a 436M ancillary track', () => {
	test('ffmpeg really did write one, so this is testing what it claims to', () => {
		// A test built on a fixture that turned out to have no ancillary track would pass for the wrong
		// reason, so the fixture is checked first
		const probed = execFileSync('ffprobe', [
			'-v', 'error', '-show_entries', 'stream=index,codec_name,codec_type',
			'-of', 'default=nw=1', ancillaryMxf,
		], { encoding: 'utf8' });

		expect(probed).toMatch(/codec_name=smpte_436m_anc/);
		expect(probed).toMatch(/codec_type=data/);
	});

	test('opens, and gives back the picture track alone', async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(ancillaryMxf) });
		const tracks = await input.getTracks();

		expect(tracks, 'the ancillary track is not one of them').toHaveLength(1);
		expect(tracks[0]!.type).toBe('video');
		expect(await tracks[0]!.getCodec()).toBe('mpeg2');
	});

	test('nothing throws when the tracks are asked what they are', async () => {
		// The regression: the ancillary track became an audio track whose every accessor asserted on
		// sound information it did not have
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(ancillaryMxf) });

		for (const track of await input.getTracks()) {
			expect(track.type).toBeTruthy();
			if (track.isAudioTrack()) {
				await expect(track.getNumberOfChannels()).resolves.toBeGreaterThan(0);
				await expect(track.getSampleRate()).resolves.toBeGreaterThan(0);
			}
		}
	});

	/** Each ancillary frame, split by the packet sizes ffprobe reports. */
	const ancillaryFramesViaFfmpeg = () => {
		const joined = path.join(workDir, 'anc.bin');
		execFileSync('ffmpeg', [
			'-v', 'error', '-y', '-i', ancillaryMxf, '-map', '0:1', '-c', 'copy', '-f', 'data', joined,
		]);

		const sizes = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', '1', '-show_entries', 'packet=size',
			'-of', 'csv=p=0', ancillaryMxf,
		], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);

		const bytes = new Uint8Array(readFileSync(joined));
		const frames: Uint8Array[] = [];
		let at = 0;
		for (const size of sizes) {
			frames.push(bytes.subarray(at, at + size));
			at += size;
		}

		return frames;
	};

	/** The same frames, through this library's own reader. */
	const ancillaryFrames = async () => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(ancillaryMxf) });
		return (await input.getAncillaryFrames()).map(frame => frame.data);
	};

	test('Input hands them out, since no track kind carries them', async () => {
		// The essence used to be unreachable: it is left out of `getTracks` (there is no track type for
		// it), and nothing else exposed it - so `ancillaryPacketsOf` had no way to be given a frame
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(ancillaryMxf) });
		const frames = await input.getAncillaryFrames();

		expect(frames.length, 'one per edit unit, eight pictures in').toBe(8);
		expect(frames.every(frame => frame.duration > 0)).toBe(true);
		// One per picture, at the picture rate, in order
		expect(frames.map(frame => frame.timestamp)).toEqual(frames.map((_, i) => i / 25));

		// And byte for byte what ffmpeg demuxes out of the same file
		expect(frames.map(frame => [...frame.data]))
			.toEqual(ancillaryFramesViaFfmpeg().map(frame => [...frame]));
	});

	test('its packets read back as the ancillary data they are', async () => {
		// DID 0x61 with SDID 0x01 is ST 334-1's caption distribution packet, carried in VANC
		const frames = await ancillaryFrames();
		expect(frames.length).toBeGreaterThan(0);

		const packets = ancillaryPacketsOf(frames[0]!);
		expect(packets).toHaveLength(1);
		expect(packets[0]!.did).toBe(0x61);
		expect(packets[0]!.sdid).toBe(0x01);
		expect(packets[0]!.lineNumber, 'VANC line 9').toBe(9);
		expect(packets[0]!.payload.length, 'the CDP, without the DID, SDID, count and checksum').toBe(16);
	});

	test('and the captions inside them are the ones that went in', async () => {
		// The whole chain, with ours at both ends and ffmpeg in the middle: the SCTE-20 writer put
		// 0x41 0x42 on field 1 of an MPEG-2 picture, ffmpeg's decoder turned that into A/53 triplets,
		// its MXF muxer wrapped them in a CDP inside a 436M ancillary packet, and this reads them out
		for (const frame of await ancillaryFrames()) {
			expect(ancillaryCaptionsOf(frame)).toEqual([{ type: 0, byte0: 0x41, byte1: 0x42 }]);
		}
	});

	test('a triplet whose cc_valid is clear is skipped', () => {
		// The file ffmpeg writes has one triplet and it is always valid, so this branch needs a frame
		// built by hand. The layout is the one the real file established, field for field.
		const cdp = [
			0x96, 0x69, // cdp_identifier
			0x10, // cdp_length
			0x3f, // cdp_frame_rate 3, reserved
			0x43, // flags: ccdata_present, caption_service_active
			0x00, 0x00, // cdp_hdr_sequence_cntr
			0x72, // ccdata_section
			0xe2, // three marker bits, cc_count 2
			0xfc, 0x41, 0x42, // cc_valid 1, type 0
			0xf8, 0x61, 0x62, // cc_valid 0, type 0 - a padding triplet, which carries no captions
		];

		const payload = [0x61, 0x01, cdp.length, ...cdp, 0x00];
		const frame = new Uint8Array([
			0x00, 0x01, // one packet
			0x00, 0x09, // line 9
			0x01, // wrapping type
			0x04, // payload sample coding
			0x00, cdp.length + 3, // payload sample count
			0x00, 0x00, 0x00, payload.length, // payload array length
			0x00, 0x00, 0x00, 0x01, // payload array element size
			...payload,
		]);

		expect(ancillaryCaptionsOf(frame), 'only the valid triplet')
			.toEqual([{ type: 0, byte0: 0x41, byte1: 0x42 }]);
	});

	test('data that is not an ancillary frame yields nothing rather than throwing', () => {
		// A caller hands this whatever a data track gave them, which may be anything at all
		expect(ancillaryPacketsOf(new Uint8Array())).toEqual([]);
		expect(ancillaryPacketsOf(new Uint8Array([0xff, 0xff, 0x00]))).toEqual([]);
		expect(ancillaryCaptionsOf(new Uint8Array([0, 1, 2, 3]))).toEqual([]);
	});

	test('the picture still reads frame for frame', async () => {
		// Dropping a track must not disturb the ones that remain
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(ancillaryMxf) });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const sink = new EncodedPacketSink(track);
		let count = 0;
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			count++;
		}

		expect(count, 'eight pictures in, eight out').toBe(8);
	});
});
