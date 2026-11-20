/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as NodeAv from 'node-av';
import type { VideoCodec } from 'mediabunny';

/**
 * Hardware wrappers FFmpeg flags neither as `AV_CODEC_CAP_HARDWARE` nor `AV_CODEC_CAP_HYBRID`.
 *
 * Checked against FFmpeg's own sources: rkmpp, v4l2m2m, nvenc and vaapi set `AV_CODEC_CAP_HARDWARE`,
 * qsv sets `AV_CODEC_CAP_HYBRID`, and videotoolbox sets neither — it is identified only by its
 * `wrapper_name`, which node-av does not expose. So the capability decides wherever FFmpeg sets one and
 * this list covers the rest.
 */
const HARDWARE_ENCODER_SUFFIXES = [
	'_videotoolbox',
	'_mediacodec',
	'_amf',
	'_mf',
	'_omx',
];

/**
 * Whether a codec drives a hardware device rather than the CPU, which decides what `prefer-software`
 * may pick. By capability first, so an encoder nobody here has heard of still classifies.
 *
 * @internal
 */
export const isHardwareCodec = (codec: NodeAv.Codec): boolean => {
	if (
		codec.hasCapabilities(NodeAv.AV_CODEC_CAP_HARDWARE)
		|| codec.hasCapabilities(NodeAv.AV_CODEC_CAP_HYBRID)
	) {
		return true;
	}

	const name = codec.name ?? '';
	return HARDWARE_ENCODER_SUFFIXES.some(suffix => name.endsWith(suffix));
};

/**
 * Software encoders by name, tried only when FFmpeg's default for the codec turns out to be a hardware
 * wrapper — which it is for AVC and HEVC on a build carrying rkmpp, as node-av's linux-arm64 prebuild
 * does. Ordered by preference.
 */
type EncoderName = Parameters<typeof NodeAv.Codec.findEncoderByName>[0];

const SOFTWARE_ENCODER_NAMES: Partial<Record<VideoCodec, EncoderName[]>> = {
	avc: [NodeAv.FF_ENCODER_LIBX264, NodeAv.FF_ENCODER_LIBOPENH264],
	hevc: [NodeAv.FF_ENCODER_LIBX265, NodeAv.FF_ENCODER_LIBKVAZAAR],
	vp8: [NodeAv.FF_ENCODER_LIBVPX_VP8],
	vp9: [NodeAv.FF_ENCODER_LIBVPX_VP9],
	av1: [NodeAv.FF_ENCODER_LIBSVTAV1, NodeAv.FF_ENCODER_LIBAOM_AV1, NodeAv.FF_ENCODER_LIBRAV1E],
	dnxhd: [NodeAv.FF_ENCODER_DNXHD],
};

/** @internal */
export const getSoftwareEncoderCodec = (codec: VideoCodec, codecId: NodeAv.AVCodecID) => {
	if (codec === 'prores') {
		const proresKs = NodeAv.Codec.findEncoderByName(NodeAv.FF_ENCODER_PRORES_KS);
		if (proresKs) {
			return proresKs;
		}
	}

	const byId = NodeAv.Codec.findEncoder(codecId);
	if (byId && !isHardwareCodec(byId)) {
		return byId;
	}

	for (const name of SOFTWARE_ENCODER_NAMES[codec] ?? []) {
		const named = NodeAv.Codec.findEncoderByName(name);
		if (named && !isHardwareCodec(named)) {
			return named;
		}
	}

	return null;
};
