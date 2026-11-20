/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `prefer-software` used to resolve through FFmpeg's default encoder for the codec id, which is not the
// same thing as a software encoder: on node-av's linux-arm64 prebuild the default for AVC is
// `h264_rkmpp`, a Rockchip wrapper, so a Graviton or an arm64 container picked a hardware encoder and
// then threw on the next option it was given. The selection is by capability now.

import { expect, test } from 'vitest';
import * as NodeAv from 'node-av';
import { getSoftwareEncoderCodec, isHardwareCodec } from '../../packages/server/src/encoder-choice.js';
import type { VideoCodec } from '../../src/codec.js';

const CODEC_IDS: Partial<Record<VideoCodec, NodeAv.AVCodecID>> = {
	avc: NodeAv.AV_CODEC_ID_H264,
	hevc: NodeAv.AV_CODEC_ID_HEVC,
	vp8: NodeAv.AV_CODEC_ID_VP8,
	vp9: NodeAv.AV_CODEC_ID_VP9,
	av1: NodeAv.AV_CODEC_ID_AV1,
};

test.each(Object.keys(CODEC_IDS) as VideoCodec[])(
	'the software encoder for %s is never a hardware one',
	(codec) => {
		const picked = getSoftwareEncoderCodec(codec, CODEC_IDS[codec]!);

		// A build without the codec at all is allowed to have none; what is not allowed is a device one
		if (picked === null) {
			return;
		}
		expect(isHardwareCodec(picked), `${codec} resolved to ${picked.name}`).toBe(false);
	},
);

test('avc and hevc resolve to libx264 and libx265 where those are built in', () => {
	const rows = [
		['avc', NodeAv.FF_ENCODER_LIBX264],
		['hevc', NodeAv.FF_ENCODER_LIBX265],
	] as const;

	for (const [codec, constant] of rows) {
		if (!NodeAv.Codec.findEncoderByName(constant)) {
			continue;
		}
		expect(getSoftwareEncoderCodec(codec, CODEC_IDS[codec]!)?.name).toBe(constant);
	}
});

// The classifier is what the selection rests on, so it is checked against real codecs in this build
// rather than against a list of names. videotoolbox is the interesting one: FFmpeg flags it neither
// AV_CODEC_CAP_HARDWARE nor AV_CODEC_CAP_HYBRID, so only the name tells.
test('hardware encoders in this build classify as hardware, software ones as software', () => {
	let checkedHardware = 0;

	for (const name of ['h264_videotoolbox', 'hevc_videotoolbox', 'h264_nvenc', 'h264_vaapi', 'h264_qsv',
		'h264_rkmpp', 'h264_v4l2m2m'] as const) {
		const codec = NodeAv.Codec.findEncoderByName(name as never);
		if (!codec) {
			continue;
		}
		expect(isHardwareCodec(codec), `${name} should be hardware`).toBe(true);
		checkedHardware++;
	}

	// This machine has to have had at least one, or the hardware half of the classifier went unchecked
	expect(checkedHardware).toBeGreaterThan(0);

	for (const constant of [NodeAv.FF_ENCODER_LIBX264, NodeAv.FF_ENCODER_LIBX265]) {
		const codec = NodeAv.Codec.findEncoderByName(constant);
		if (codec) {
			expect(isHardwareCodec(codec), `${codec.name} should be software`).toBe(false);
		}
	}
});
