/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Interlaced encoding, via `encoderControls.interlaced`.
//
// The field order cannot be guessed from the samples - a frame holds two interleaved fields with
// nothing in the pixels to say which was captured first - so it is the caller's to state, and stating
// it wrong makes motion stutter back and forth every frame. That makes the ORDER the thing worth
// testing, not merely that something interlaced came out.
//
// The two encoders are wired differently, which is measured rather than assumed. x264 reads the mode
// from the codec context flag (`x4->params.b_interlaced = avctx->flags & AV_CODEC_FLAG_INTERLACED_DCT`)
// and the ORDER from each frame's own flag, reconfiguring itself when it changes. ffmpeg's x265 wrapper
// reads neither, so there the mode goes in as an `x265-params` entry.
//
// ffprobe's `field_order` is the oracle: it derives it from the SPS and the `pic_timing` SEI, which is
// where an AVC stream actually states this, and not from any container box - ffmpeg writes no `fiel`
// box for an interlaced MP4 at all.

import { beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import {
	CmafOutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	Mp4OutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import { Logging } from '../../src/logging.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { firstSpsFromAvcRecord, parseAvcSps } from '../../src/codec-data.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { iterateSeiMessages, iterateSeiNalUnits } from '../../src/sei.js';
import type { VideoCodec } from '../../src/codec.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

beforeAll(() => {
	registerMediabunnyServer();
});

const hasFfprobe = (() => {
	try {
		execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string;
beforeAll(() => {
	workDir = process.env['MB_ILACE_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'mediabunny-ilace-'));
});

const cleanup = () => rmSync(workDir, { recursive: true, force: true });

type EncodeOptions = {
	interlaced?: 'tff' | 'bff';
	codec?: VideoCodec;
};

/** Re-encodes the demo file, stating the interlaced mode on the encoder. */
const encode = async ({ interlaced, codec = 'avc' }: EncodeOptions) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			codec,
			bitrate: 2e6,
			// A quarter of a second is plenty: the field order is stated per frame, so a handful of
			// frames exercises it as well as a thousand would
			encoderControls: interlaced === undefined ? {} : { interlaced },
		},
		trim: { start: 0, end: 0.3 },
	});
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

/** The SPS fields that say whether a stream is field-coded. */
const spsOf = async (bytes: Uint8Array) => {
	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config?.description);

	const sps = firstSpsFromAvcRecord(toUint8Array(config.description));
	assert(sps);
	return parseAvcSps(sps);
};

/** Every `pic_struct` an AVC stream's `pic_timing` SEIs state, as a set. */
const picStructsOf = async (bytes: Uint8Array) => {
	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config);

	const sink = new EncodedPacketSink(track);
	const seen = new Set<number>();
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		for (const nalUnit of iterateSeiNalUnits(packet.data, config, 'avc')) {
			for (const message of iterateSeiMessages(nalUnit, 'avc')) {
				// This SPS declares no HRD, so no delay fields precede `pic_struct`
				if (message.payloadType === 1) {
					seen.add(message.payload[0]! >> 4);
				}
			}
		}
	}

	return seen;
};

const fieldOrderOf = (bytes: Uint8Array, name: string) => {
	const file = path.join(workDir, name);
	writeFileSync(file, bytes);

	return execFileSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=field_order',
		'-of', 'default=nw=1:nk=1', file,
	], { encoding: 'utf8' }).trim().split('\n')[0];
};

describe('AVC interlaced encoding', () => {
	test('the SPS stops saying frame_mbs_only, and says pic_struct is present', async () => {
		// These two are what an interlaced AVC stream is: macroblocks may be field-coded, and a
		// `pic_timing` SEI states the field order of each picture. A progressive encode has neither.
		const interlaced = await spsOf(await encode({ interlaced: 'tff' }));
		assert(interlaced);
		expect(interlaced.frameMbsOnlyFlag, 'field coding is permitted').toBe(0);
		expect(interlaced.picStructPresentFlag, 'and pic_struct states the order').toBe(true);

		const progressive = await spsOf(await encode({}));
		assert(progressive);
		expect(progressive.frameMbsOnlyFlag, 'unchanged without the control').toBe(1);
		expect(progressive.picStructPresentFlag).toBe(false);
	});

	test('the stated field order reaches the bitstream', async () => {
		// `pic_struct` 3 is a top field then a bottom one, 4 the other way round: H.264 Table D-1. This
		// reads the wire rather than ffprobe's summary, because it is the field that decides playback and
		// because the first implementation of this control got BOTH orders wrong in the same direction -
		// every frame said 3 - which a test of `tff` alone would have passed.
		expect(await picStructsOf(await encode({ interlaced: 'tff' }))).toEqual(new Set([3]));
		expect(await picStructsOf(await encode({ interlaced: 'bff' }))).toEqual(new Set([4]));
		expect(await picStructsOf(await encode({})), 'no pic_timing at all').toEqual(new Set());
	});

	test.skipIf(!hasFfprobe)('and ffprobe reads the same order back', async () => {
		expect(fieldOrderOf(await encode({ interlaced: 'tff' }), 'tff.mp4')).toBe('tt');
		expect(fieldOrderOf(await encode({ interlaced: 'bff' }), 'bff.mp4')).toBe('bb');
	});

	test.skipIf(!hasFfprobe)('without the control the output stays progressive', async () => {
		expect(fieldOrderOf(await encode({}), 'prog.mp4')).toBe('progressive');
	});
});

describe('HEVC interlaced encoding is refused', () => {
	test('because the stated order could not be shown to reach the bitstream', async () => {
		// x265 accepts an `interlace` parameter and warns that its own interlaced support is
		// experimental. Driven from the ffmpeg CLI with the source frames marked it produces a stream
		// ffprobe reads as `tb`/`bt`; driven through this pipeline the field order read back as
		// `unknown`, so there is no demonstration that 'tff' and 'bff' differ in the output. A control
		// that silently does not take is worse than one that refuses, so it refuses - and says why.
		await expect(encode({ interlaced: 'tff', codec: 'hevc' }))
			.rejects.toThrow(/experimental and the stated field order did not reach the bitstream/);
	});
});

describe('refusals', () => {
	test('an encoder with no interlaced mode refuses rather than dropping it', async () => {
		// Silently encoding progressive would hand back a file that looks right and plays wrong on
		// every interlaced display it reaches
		await expect(encode({ interlaced: 'tff', codec: 'vp9' }))
			.rejects.toThrow(/interlaced is not supported by the selected encoder/);
	});

	test('a field order that is not one of the two is refused', async () => {
		await expect(encode({ interlaced: 'middle' as 'tff' }))
			.rejects.toThrow(/must be 'tff' or 'bff'/);
	});
});

test('cleanup', () => {
	if (!process.env['MB_ILACE_DIR']) {
		cleanup();
	}
	expect(true).toBe(true);
});

// Signalling. DASH has an attribute for this and HLS has none - verified against both specs rather
// than assumed: RFC 8216's EXT-X-STREAM-INF defines BANDWIDTH, AVERAGE-BANDWIDTH, CODECS, RESOLUTION,
// FRAME-RATE, HDCP-LEVEL and the rendition-group references, and none of them states a scan type.
// Apple's HLS Authoring Specification instead requires the content not to be interlaced: "1.14. All
// interlaced source content MUST be deinterlaced." So DASH states it and HLS warns.
describe('signalling an interlaced ladder', () => {
	/** Writes a segmented ladder from an interlaced encode and returns the written files. */
	const segment = async (format: 'dash' | 'hls', interlaced?: 'tff' | 'bff') => {
		const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
		const files = new Map<string, Uint8Array>();
		const manifest = format === 'dash' ? 'manifest.mpd' : 'master.m3u8';

		const output = new Output({
			format: format === 'dash'
				? new DashOutputFormat({
					segmentFormat: new CmafOutputFormat(),
					targetDuration: 1,
					mpdPath: manifest,
				})
				: new HlsOutputFormat({
					segmentFormat: new CmafOutputFormat(),
					targetDuration: 1,
				}),
			target: new PathedTarget(manifest, (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec: 'avc',
				bitrate: 2e6,
				encoderControls: interlaced === undefined ? {} : { interlaced },
			},
			trim: { start: 0, end: 0.3 },
		});
		await conversion.execute();

		const written = files.get(manifest);
		// Without this the "no scan attribute" assertion below would be checking an empty string
		expect(written, `${manifest} must have been written`).toBeDefined();
		return new TextDecoder().decode(written);
	};

	test('DASH states scanType="interlaced", read off the SPS rather than the control', async () => {
		const mpd = await segment('dash', 'tff');
		expect(mpd).toMatch(/scanType="interlaced"/);
	}, 30_000);

	test('and says nothing for a progressive ladder, since that is the default', async () => {
		const mpd = await segment('dash');
		expect(mpd).not.toMatch(/scanType/);
	}, 30_000);

	test('HLS has no such attribute, so it warns instead of writing one', async () => {
		const warnings: string[] = [];
		const off = Logging.on('warn', args => void warnings.push(args.map(String).join(' ')));

		try {
			const master = await segment('hls', 'tff');
			// Nothing to write: there is no attribute for it
			expect(master).not.toMatch(/scan|interlac/i);
			expect(warnings.join('\n'), 'but the caller is told').toMatch(/interlaced video/);
			expect(warnings.join('\n')).toMatch(/deinterlaced first/);
		} finally {
			off();
		}
	}, 30_000);

	test('a progressive HLS ladder warns about nothing', async () => {
		const warnings: string[] = [];
		const off = Logging.on('warn', args => void warnings.push(args.map(String).join(' ')));

		try {
			await segment('hls');
			expect(warnings.filter(x => /interlaced/.test(x))).toEqual([]);
		} finally {
			off();
		}
	}, 30_000);
});
