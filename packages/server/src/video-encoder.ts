/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	CustomVideoEncoder,
	Logging,
	type MaybePromise,
	Quality,
	VideoCodec,
	VideoSample,
	EncodedPacket,
	EncodedPacketSideData,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import {
	CODEC_TO_CODEC_ID,
	getHardwareEncoderCodec,
	unmapColorPrimaries,
	unmapMatrixCoefficients,
	unmapTransferCharacteristics,
} from './misc';
import { copyVideoSampleToAvFrame, AvFrameVideoSampleResource, applySampleColorToFrame } from './video-sample';
import {
	AvcNalUnitType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	extractVp9CodecInfoFromPacket,
	HevcNalUnitType,
	iterateNalUnitsInAnnexB,
	NalUnitLocation,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../../../src/codec-data';
import {
	extractVideoBitDepth,
	extractVideoCodecString,
	ProresFourCc,
	VIDEO_BIT_DEPTHS,
	VideoBitDepth,
} from '../../../src/codec';
import { assert, binarySearchLessOrEqual, simplifyRational, toUint8Array } from '../../../src/misc';

const PRORES_FOURCC_TO_PROFILE: Record<ProresFourCc, NodeAv.AVProfile> = {
	apco: NodeAv.AV_PROFILE_PRORES_PROXY,
	apcs: NodeAv.AV_PROFILE_PRORES_LT,
	apcn: NodeAv.AV_PROFILE_PRORES_STANDARD,
	apch: NodeAv.AV_PROFILE_PRORES_HQ,
	ap4h: NodeAv.AV_PROFILE_PRORES_4444,
	ap4x: NodeAv.AV_PROFILE_PRORES_XQ,
};

// In order of preference; an encoder can only reach a bit depth by being opened with a format that stores it
const PIXEL_FORMATS_BY_BIT_DEPTH: Record<VideoBitDepth, NodeAv.AVPixelFormat[]> = {
	8: [
		NodeAv.AV_PIX_FMT_YUV420P,
		NodeAv.AV_PIX_FMT_NV12,
		NodeAv.AV_PIX_FMT_YUV422P,
		NodeAv.AV_PIX_FMT_YUV444P,
	],
	10: [
		NodeAv.AV_PIX_FMT_YUV420P10LE,
		NodeAv.AV_PIX_FMT_P010LE,
		NodeAv.AV_PIX_FMT_YUV422P10LE,
		NodeAv.AV_PIX_FMT_YUV444P10LE,
	],
	12: [
		NodeAv.AV_PIX_FMT_YUV420P12LE,
		NodeAv.AV_PIX_FMT_YUV422P12LE,
		NodeAv.AV_PIX_FMT_YUV444P12LE,
	],
};

const ALPHA_PIXEL_FORMATS_BY_BIT_DEPTH: Record<VideoBitDepth, NodeAv.AVPixelFormat[]> = {
	8: [
		NodeAv.AV_PIX_FMT_YUVA420P,
		NodeAv.AV_PIX_FMT_YUVA422P,
		NodeAv.AV_PIX_FMT_YUVA444P,
	],
	10: [
		NodeAv.AV_PIX_FMT_YUVA420P10LE,
		NodeAv.AV_PIX_FMT_YUVA422P10LE,
		NodeAv.AV_PIX_FMT_YUVA444P10LE,
	],
	12: [
		NodeAv.AV_PIX_FMT_YUVA422P12LE,
		NodeAv.AV_PIX_FMT_YUVA444P12LE,
	],
};

const pixelFormatForBitDepth = (
	supportedPixelFormats: NodeAv.AVPixelFormat[] | null,
	bitDepth: VideoBitDepth,
	wantsAlpha: boolean,
): NodeAv.AVPixelFormat | null => {
	const candidates = wantsAlpha
		? ALPHA_PIXEL_FORMATS_BY_BIT_DEPTH[bitDepth]
		: PIXEL_FORMATS_BY_BIT_DEPTH[bitDepth];

	if (!supportedPixelFormats) {
		// No list advertised, so the ideal format is the best we can say
		return candidates[0]!;
	}

	return candidates.find(format => supportedPixelFormats.includes(format)) ?? null;
};

// Null for formats we don't track, which includes every RGB format
const bitDepthOfPixelFormat = (pixelFormat: NodeAv.AVPixelFormat): VideoBitDepth | null => {
	for (const bitDepth of VIDEO_BIT_DEPTHS) {
		if (
			PIXEL_FORMATS_BY_BIT_DEPTH[bitDepth].includes(pixelFormat)
			|| ALPHA_PIXEL_FORMATS_BY_BIT_DEPTH[bitDepth].includes(pixelFormat)
		) {
			return bitDepth;
		}
	}

	return null;
};

/**
 * The transfer characteristics to signal for output encoded at `outputBitDepth`, given what the incoming frames claim.
 * PQ and HLG are defined from 10 bits up, so encoding shallower leaves the label describing samples that no longer
 * exist; the transfer is then stated as unspecified rather than stamped onto bytes that cannot carry it.
 */
export const transferForOutputBitDepth = (
	frameColorTrc: NodeAv.AVColorTransferCharacteristic,
	outputBitDepth: VideoBitDepth | null,
): NodeAv.AVColorTransferCharacteristic => {
	const isHdrTransfer = frameColorTrc === NodeAv.AVCOL_TRC_SMPTE2084
		|| frameColorTrc === NodeAv.AVCOL_TRC_ARIB_STD_B67;

	if (!isHdrTransfer || outputBitDepth === null || outputBitDepth >= 10) {
		return frameColorTrc;
	}

	Logging._warn(
		`Encoding ${outputBitDepth}-bit output from frames labelled`
		+ ` '${frameColorTrc === NodeAv.AVCOL_TRC_SMPTE2084 ? 'pq' : 'hlg'}'. That transfer function needs at least`
		+ ' 10 bits, so the output states no transfer instead of claiming one its samples cannot carry.',
	);

	return NodeAv.AVCOL_TRC_UNSPECIFIED;
};

/**
 * Picks the pixel format the codec context will be opened with. A bit depth demanded by the codec string is either
 * met or refused; where none is demanded, the incoming frames' depth is preserved when the encoder can.
 */
export const choosePixelFormat = (options: {
	codecName: string | null | undefined;
	/** Null when the encoder advertises no list, in which case any depth is assumed reachable. */
	supportedPixelFormats: NodeAv.AVPixelFormat[] | null;
	/** The depth the codec string states, which the output will be labelled with. */
	requestedBitDepth: VideoBitDepth | null;
	/** The depth of the frames handed to the encoder. */
	incomingBitDepth: VideoBitDepth | null;
	wantsAlpha: boolean;
}): NodeAv.AVPixelFormat => {
	const { codecName, supportedPixelFormats, requestedBitDepth, incomingBitDepth, wantsAlpha } = options;
	const desiredBitDepth = requestedBitDepth ?? incomingBitDepth;

	if (desiredBitDepth !== null) {
		const match = pixelFormatForBitDepth(supportedPixelFormats, desiredBitDepth, wantsAlpha);
		if (match !== null) {
			return match;
		}

		if (requestedBitDepth !== null) {
			throw new Error(
				`Encoder '${codecName ?? 'unknown'}' cannot encode ${requestedBitDepth}-bit video`
				+ `${wantsAlpha ? ' with alpha' : ''}, which the requested codec profile demands.`,
			);
		}

		// Inherited, not demanded, so fall through to the encoder's default rather than failing the encode
	}

	let pixelFormat = NodeAv.AV_PIX_FMT_YUV420P;

	if (supportedPixelFormats) {
		if (!supportedPixelFormats.includes(NodeAv.AV_PIX_FMT_YUV420P)) {
			pixelFormat = supportedPixelFormats[0]!;
		}

		if (wantsAlpha) {
			if (supportedPixelFormats.includes(NodeAv.AV_PIX_FMT_YUVA420P)) {
				pixelFormat = NodeAv.AV_PIX_FMT_YUVA420P;
			} else {
				// Let FFmpeg pick the best alpha-capable format it supports, minimizing data loss versus a
				// high-quality YUVA source
				pixelFormat = NodeAv.avcodecFindBestPixFmtOfList(
					supportedPixelFormats,
					NodeAv.AV_PIX_FMT_YUVA444P12LE,
				);
			}
		}
	}

	return pixelFormat;
};

const getSoftwareEncoderCodec = (codec: VideoCodec, codecId: NodeAv.AVCodecID) => {
	if (codec === 'prores') {
		// Prefer prores_ks for ProRes
		const proresKs = NodeAv.Codec.findEncoderByName(NodeAv.FF_ENCODER_PRORES_KS);
		if (proresKs) {
			return proresKs;
		}
	}

	return NodeAv.Codec.findEncoder(codecId);
};

// NTSC rates are x/1001 exactly; anything else is kept to the millisecond. Rounding to whole frames would state 24
// fps for 24000/1001 video.
const toFramerateRational = (framerate: number) => {
	const ntscNum = Math.round(framerate * 1001);
	if (ntscNum % 1000 === 0 && Math.abs(ntscNum / 1001 - framerate) < 1e-4 && !Number.isInteger(framerate)) {
		return { num: ntscNum, den: 1001 };
	}

	return simplifyRational({ num: Math.round(framerate * 1000), den: 1000 });
};

// A cap arrives in fields WebCodecs configs don't have
const getQualityCap = (config: VideoEncoderConfig) => {
	const { _maxBitrate, _bufferSize } = config as VideoEncoderConfig & { _maxBitrate?: number; _bufferSize?: number };
	return _maxBitrate === undefined ? null : { maxBitrate: _maxBitrate, bufferSize: _bufferSize ?? 2 * _maxBitrate };
};

export class NodeAvVideoEncoder extends CustomVideoEncoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	codecContext: NodeAv.CodecContext | null = null;
	scaler: NodeAv.SoftwareScaleContext | null = null;
	dstFrame: NodeAv.Frame | null = null;
	avCodec!: NodeAv.Codec;
	lastBuffer: Buffer | null = null;
	packetEmitted = false;
	lastScalerKey: string | null = null;
	quantizer: number | null = null;

	// Bookkeeping to restore the original timing information
	preciseTimings: {
		microsecondTimestamp: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	static override supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		const codecSupported = config.bitrateMode === 'quantizer'
			? codec === 'avc' || codec === 'hevc' || codec === 'vp9' || codec === 'av1'
			: codec === 'avc' || codec === 'hevc' || codec === 'vp8' || codec === 'vp9' || codec === 'av1'
				|| codec === 'prores';

		if (!codecSupported) {
			return false;
		}

		if (getQualityCap(config)) {
			if (config.bitrateMode !== 'quantizer') {
				return false;
			}

			const codecId = CODEC_TO_CODEC_ID[codec];
			assert(codecId !== undefined);
			// rav1e has no capped mode, only a constant quantizer or a bitrate
			if (getSoftwareEncoderCodec(codec, codecId)?.name === 'librav1e') {
				return false;
			}
		}

		const requestedBitDepth = extractVideoBitDepth(config.codec);
		if (requestedBitDepth === null) {
			return true;
		}

		// A depth stated by the codec string has to be deliverable, or the output would be labelled with a profile
		// its samples don't have. Hardware encoders that can't reach it are skipped, so software decides.
		const codecId = CODEC_TO_CODEC_ID[codec];
		assert(codecId !== undefined);
		const avCodec = getSoftwareEncoderCodec(codec, codecId);

		return !!avCodec && pixelFormatForBitDepth(
			avCodec.pixelFormats,
			requestedBitDepth,
			config.alpha === 'keep',
		) !== null;
	}

	async init(): Promise<void> {
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.frame.timeBase = new NodeAv.Rational(1, 1e6);

		this.packet = new NodeAv.Packet();
		this.packet.alloc();

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		const wantsAlpha = this.config.alpha === 'keep';
		const requestedBitDepth = extractVideoBitDepth(this.config.codec);

		let codec: NodeAv.Codec | null = null;
		if (this.codec === 'vp9' && wantsAlpha) {
			codec = NodeAv.Codec.findEncoderByName(NodeAv.FF_ENCODER_LIBVPX_VP9) ?? NodeAv.Codec.findEncoder(codecId);
		} else if (this.config.hardwareAcceleration === 'prefer-software') {
			codec = getSoftwareEncoderCodec(this.codec, codecId);
		} else {
			let hardwareCodec = await getHardwareEncoderCodec(codecId);
			if (hardwareCodec && this.config.bitrateMode === 'quantizer' && !hardwareCodec.name?.endsWith('_nvenc')) {
				// NVENC is the only hardware encoder we know how to drive in constant-quantizer mode
				hardwareCodec = null;
			}

			if (
				hardwareCodec
				&& requestedBitDepth !== null
				&& pixelFormatForBitDepth(hardwareCodec.pixelFormats, requestedBitDepth, wantsAlpha) === null
			) {
				// Hardware acceleration is a preference, but the requested bit depth is not
				hardwareCodec = null;
			}

			codec = hardwareCodec ?? getSoftwareEncoderCodec(this.codec, codecId);
		}

		if (!codec) {
			throw new Error(`Unable to obtain libav codec for '${this.codec}'.`);
		}

		this.avCodec = codec;
	}

	async createCodecContext() {
		assert(this.codecContext === null);

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(this.avCodec);

		const incomingBitDepth = bitDepthOfPixelFormat(this.frame.format as NodeAv.AVPixelFormat);
		const pixelFormat = choosePixelFormat({
			codecName: this.avCodec.name,
			supportedPixelFormats: this.avCodec.pixelFormats,
			requestedBitDepth: extractVideoBitDepth(this.config.codec),
			incomingBitDepth,
			wantsAlpha: this.config.alpha === 'keep',
		});

		const pixelAspectRatio = simplifyRational({
			num: (this.config.displayWidth ?? this.config.width) * this.config.height,
			den: (this.config.displayHeight ?? this.config.height) * this.config.width,
		});

		codecContext.width = this.config.width;
		codecContext.height = this.config.height;
		codecContext.pixelFormat = pixelFormat;
		codecContext.timeBase = new NodeAv.Rational(1, 1e6);
		// Key frames come from the caller, which forces one every keyFrameInterval; a GOP length of the encoder's
		// own would add key frames between the forced ones
		codecContext.gopSize = 2 ** 30;
		const framerate = toFramerateRational(this.config.framerate || 30);
		codecContext.framerate = new NodeAv.Rational(framerate.num, framerate.den);
		// In quantizer mode, the quantizer dictates the rate; a target bitrate would put encoders in the wrong rate
		// control mode
		codecContext.bitRate = this.config.bitrateMode === 'quantizer'
			? 0n
			: BigInt(
					this.config.bitrate ?? new Quality('medium')
						._toVideoBitrate(this.codec, this.config.width, this.config.height),
				);
		codecContext.sampleAspectRatio = new NodeAv.Rational(pixelAspectRatio.num, pixelAspectRatio.den);

		// Carry the frames' color into the bitstream, so the stream states the color it holds. Only tracked (i.e.
		// YUV) formats qualify: converting RGB hands swscale a matrix and range choice the frame's labels no longer
		// describe.
		if (incomingBitDepth !== null) {
			codecContext.colorPrimaries = this.frame.colorPrimaries;
			codecContext.colorTrc = transferForOutputBitDepth(this.frame.colorTrc, bitDepthOfPixelFormat(pixelFormat));
			codecContext.colorSpace = this.frame.colorSpace;
			codecContext.colorRange = this.frame.colorRange;
		}

		if (this.config.bitrateMode === 'constant') {
			codecContext.rcMinRate = codecContext.bitRate;
			codecContext.rcMaxRate = codecContext.bitRate;
		}

		const isRealtime = this.config.latencyMode === 'realtime';

		if (this.avCodec.name === 'libx264') {
			// Scene-cut detection would also add key frames between the forced ones
			codecContext.setOption('x264-params', 'scenecut=0');

			if (isRealtime) {
				codecContext.setOption('tune', 'zerolatency');
				codecContext.setOption('preset', 'ultrafast');
			}
		} else if (this.avCodec.name === 'libx265') {
			// Besides no scene-cut key frames, a forced key frame must be a true IDR: with an open GOP, x265 writes it
			// as a CRA whose leading RASL pictures can't be decoded when playback starts there
			codecContext.setOption('x265-params', 'log-level=error:scenecut=0:open-gop=0');
			codecContext.setOption('forced-idr', '1');

			if (isRealtime) {
				codecContext.setOption('tune', 'zerolatency');
				codecContext.setOption('preset', 'ultrafast');
			}
		} else if (this.avCodec.name === 'libvpx') {
			if (isRealtime) {
				codecContext.setOption('deadline', 'realtime');
				codecContext.setOption('cpu-used', '8');
			} else {
				codecContext.setOption('cpu-used', '8');
			}
		} else if (this.avCodec.name === 'libvpx-vp9') {
			codecContext.setOption('deadline', 'realtime');

			if (isRealtime) {
				codecContext.setOption('cpu-used', '8');
			} else {
				codecContext.setOption('cpu-used', '5');
			}
		} else if (this.avCodec.name === 'libsvtav1') {
			// SVTAV1 can be silenced by setting an environment variable:
			// https://superuser.com/questions/1775236/how-to-remove-svt-av1-information-from-ffmpeg-output
			process.env['SVT_LOG'] = '1';

			if (isRealtime) {
				codecContext.setOption('preset', '12');
			}
		} else if (this.avCodec.name === 'h264_nvenc') {
			// When we force a key frame, we want a true IDR frame, not just an I frame
			codecContext.setOption('forced-idr', '1');
		} else if (this.avCodec.name === 'hevc_nvenc') {
			codecContext.setOption('forced-idr', '1');
		}

		if (this.config.bitrateMode === 'quantizer') {
			assert(this.quantizer !== null);

			// Map the quantizer from the scale used by Mediabunny to the scale expected by the specific FFmpeg encoder
			let mapped: number;
			if (this.avCodec.name === 'libaom-av1' || this.avCodec.name === 'libsvtav1') {
				// Mediabunny uses AV1's quantizer index (0-255), while these encoders expect the 0-63 quantizer scale
				mapped = Math.round(this.quantizer / 4);
			} else {
				// Everything else lines up with Mediabunny directly
				mapped = this.quantizer;
			}

			// Capped CRF needs the encoder's quality mode, not a constant quantizer
			const cap = getQualityCap(this.config);
			if (cap) {
				if (this.avCodec.name === 'libx264' || this.avCodec.name === 'libx265') {
					codecContext.setOption('crf', String(mapped));
					codecContext.rcMaxRate = BigInt(cap.maxBitrate);
					codecContext.rcBufferSize = cap.bufferSize;
				} else if (this.avCodec.name === 'libsvtav1') {
					// SVT-AV1 reads crf 0 as unset
					codecContext.setOption('crf', String(Math.max(mapped, 1)));
					codecContext.rcMaxRate = BigInt(cap.maxBitrate);
				} else if (this.avCodec.name === 'libvpx-vp9' || this.avCodec.name === 'libaom-av1') {
					// Constrained quality: the bitrate is a ceiling over the stream, not a buffer model
					codecContext.setOption('crf', String(mapped));
					codecContext.bitRate = BigInt(cap.maxBitrate);
				} else if (this.avCodec.name?.endsWith('_nvenc')) {
					// FFmpeg's NVENC wrapper discards the buffer size in this mode; the max bitrate is the bound
					codecContext.setOption('rc', 'vbr');
					codecContext.setOption('cq', String(mapped));
					codecContext.rcMaxRate = BigInt(cap.maxBitrate);
				} else {
					throw new Error(
						`Encoder '${this.avCodec.name}' cannot be used for capped quantizer-based encoding.`,
					);
				}
			} else if (this.avCodec.name === 'libx264' || this.avCodec.name === 'libx265') {
				codecContext.setOption('qp', String(mapped));
			} else if (this.avCodec.name === 'libvpx-vp9' || this.avCodec.name === 'libaom-av1') {
				codecContext.setOption('crf', String(mapped));
			} else if (this.avCodec.name === 'libsvtav1') {
				// qp (unlike crf) selects true constant-quantizer mode
				codecContext.setOption('qp', String(mapped));
			} else if (this.avCodec.name === 'librav1e') {
				codecContext.setOption('qp', String(mapped));
			} else if (this.avCodec.name?.endsWith('_nvenc')) {
				codecContext.setOption('rc', 'constqp');
				codecContext.setOption('qp', String(mapped));
			} else {
				throw new Error(`Encoder '${this.avCodec.name}' cannot be used for quantizer-based encoding.`);
			}

			if (!cap) {
				// Also pin the quantizer range so crf-based encoders (libvpx, libaom) hold the quantizer truly constant
				codecContext.qMin = mapped;
				codecContext.qMax = mapped;
			}
		}

		if (this.codec === 'prores') {
			// Pick the encoder profile from the requested ProRes four-character code
			const profile = PRORES_FOURCC_TO_PROFILE[this.config.codec as ProresFourCc];
			assert(profile !== undefined);

			codecContext.setOption('profile', String(profile));
		}

		const ret = await codecContext.open2();
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.codecContext = codecContext;
	}

	async encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions): Promise<void> {
		if (this.config.bitrateMode === 'quantizer') {
			let quantizer: number | null | undefined;
			if (this.codec === 'avc') {
				quantizer = options.avc?.quantizer;
			} else if (this.codec === 'hevc') {
				quantizer = options.hevc?.quantizer;
			} else if (this.codec === 'vp9') {
				quantizer = options.vp9?.quantizer;
			} else {
				quantizer = options.av1?.quantizer;
			}
			assert(quantizer !== undefined && quantizer !== null);

			if (this.codecContext !== null && quantizer !== this.quantizer) {
				// Almost no FFmpeg encoder supports changing the quantizer past init, so drain the current encoder
				// and start a fresh one. Dirty but what else are you gonna do
				const ret = await this.codecContext.sendFrame(null);
				NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

				while (true) {
					const receiveRet = await this.codecContext.receivePacket(this.packet);
					if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
						break;
					}

					this.receivePacket(receiveRet);
				}

				this.codecContext.freeContext();
				this.codecContext = null;
			}

			this.quantizer = quantizer;
		}

		if (videoSample._data instanceof AvFrameVideoSampleResource) {
			// Release any buffers still referenced from the previous encode before reffing the new frame, otherwise
			// av_frame_ref leaks them
			// https://github.com/Vanilagy/mediabunny/issues/392
			this.frame.unref();
			this.frame.ref(videoSample._data.frame);
			applySampleColorToFrame(videoSample, this.frame);
		} else {
			if (videoSample.format === null) {
				throw new Error('Cannot encode foreign VideoSample with unknown (null) format.');
			}

			this.lastBuffer = await copyVideoSampleToAvFrame(videoSample, this.frame, this.lastBuffer);
		}

		// Must run after the frame is prepared: the pixel format and color the context is opened with follow from it
		if (this.codecContext === null) {
			await this.createCodecContext();
		}
		assert(this.codecContext);

		let frameToEncode = this.frame;

		const requiresScaler
			= this.codecContext.pixelFormat !== this.frame.format
				|| this.codecContext.width !== this.frame.width
				|| this.codecContext.height !== this.frame.height;

		if (requiresScaler) {
			if (!this.scaler) {
				this.scaler = new NodeAv.SoftwareScaleContext();
			}

			const key = `${this.frame.width}x${this.frame.height}:${this.frame.format}`;
			const needsConfigure = key !== this.lastScalerKey;

			if (needsConfigure) {
				this.scaler.getContext(
					this.frame.width, this.frame.height, this.frame.format as NodeAv.AVPixelFormat,
					this.codecContext.width, this.codecContext.height, this.codecContext.pixelFormat,
					NodeAv.SWS_FAST_BILINEAR,
				);

				this.lastScalerKey = key;

				const ret = this.scaler.initContext();
				NodeAv.FFmpegError.throwIfError(ret, 'initContext');
			}

			if (!this.dstFrame) {
				this.dstFrame = new NodeAv.Frame();
				this.dstFrame.alloc();
				this.dstFrame.width = this.codecContext.width;
				this.dstFrame.height = this.codecContext.height;
				this.dstFrame.format = this.codecContext.pixelFormat;
				this.dstFrame.allocBuffer();
			}

			await this.scaler.scaleFrame(this.dstFrame, this.frame);
			this.dstFrame.copyProps(this.frame);
			frameToEncode = this.dstFrame;
		}

		frameToEncode.pts = BigInt(videoSample.microsecondTimestamp);
		frameToEncode.duration = BigInt(videoSample.microsecondDuration);
		frameToEncode.timeBase = new NodeAv.Rational(1, 1e6);

		// Let's just set both for good measure
		frameToEncode.pictType = options?.keyFrame
			? NodeAv.AV_PICTURE_TYPE_I
			: NodeAv.AV_PICTURE_TYPE_NONE;
		frameToEncode.keyFrame = options?.keyFrame
			? 1
			: 0;

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			videoSample.microsecondTimestamp,
			x => x.microsecondTimestamp,
		);
		const existingEntry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;
		if (existingEntry && existingEntry.microsecondTimestamp === videoSample.microsecondTimestamp) {
			if (existingEntry.timestamp !== videoSample.timestamp) {
				// Mapping isn't unique, can't use the timestamp
				existingEntry.timestampIsValid = false;
			}
			if (existingEntry.duration !== videoSample.duration) {
				// Mapping isn't unique, can't use the duration
				existingEntry.durationIsValid = false;
			}
		} else {
			this.preciseTimings.splice(preciseTimingIndex + 1, 0, {
				microsecondTimestamp: videoSample.microsecondTimestamp,
				timestamp: videoSample.timestamp,
				duration: videoSample.duration,
				timestampIsValid: true,
				durationIsValid: true,
			});

			// Make sure it doesn't grow indefinitely
			if (this.preciseTimings.length > 128) {
				this.preciseTimings.shift();
			}
		}

		const ret = await this.codecContext.sendFrame(frameToEncode);
		NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

		// Keep receiving packets until no more are available for this frame
		while (true) {
			const receiveRet = await this.codecContext.receivePacket(this.packet);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receivePacket(receiveRet);
		}
	}

	receivePacket(ret: number) {
		assert(this.codecContext);
		NodeAv.FFmpegError.throwIfError(ret, 'Receive packet');

		if (!this.packet.data) {
			return;
		}
		let packetData = toUint8Array(this.packet.data);

		let timestamp = Number(this.packet.pts) / 1e6;
		let duration = Number(this.packet.duration) / 1e6;

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			Number(this.packet.pts),
			x => x.microsecondTimestamp,
		);
		const entry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;

		// If there's a relevant timing entry, refine the packet's timing data to get better accuracy than
		// microseconds
		if (entry && entry.microsecondTimestamp === Number(this.packet.pts)) {
			if (entry.timestampIsValid) {
				timestamp = entry.timestamp;
			}
			if (entry.durationIsValid) {
				duration = entry.duration;
			}
		}

		const metadata: EncodedVideoChunkMetadata = {};
		let decoderConfigCodecString: string | null = null;
		let decoderConfigDescription: Uint8Array | null = null;

		if (this.codec === 'avc' || this.codec === 'hevc') {
			let expectsAnnexB = false;
			if (this.codec === 'avc') {
				expectsAnnexB = this.config.avc?.format === 'annexb';
			} else {
				// eslint-disable-next-line @stylistic/max-len
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				expectsAnnexB = (this.config as any).hevc?.format === 'annexb';
			}

			if (!this.packetEmitted) {
				let serializedRecord: Uint8Array;

				if (this.codec === 'avc') {
					const record = extractAvcDecoderConfigurationRecord(this.packet.data);
					if (!record) {
						throw new Error('Invalid AVC data, could not extract decoder configuration record.');
					}

					serializedRecord = serializeAvcDecoderConfigurationRecord(record);
				} else {
					const record = extractHevcDecoderConfigurationRecord(this.packet.data);
					if (!record) {
						throw new Error('Invalid HEVC data, could not extract decoder configuration record.');
					}

					serializedRecord = serializeHevcDecoderConfigurationRecord(record);
				}

				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: this.codec,
					codecDescription: serializedRecord,
					colorSpace: null,
					// Annex B leaves the parameter sets in the samples; otherwise they are stripped into
					// the description, and the fourcc has to say which (ISO/IEC 14496-15).
					avcType: expectsAnnexB ? 3 : 1,
					hevcType: expectsAnnexB ? 'hev1' : 'hvc1',
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo: null,
					proresFormat: null,
				});

				if (!expectsAnnexB) {
					decoderConfigDescription = serializedRecord;
				}
			}

			if (!expectsAnnexB) {
				const NAL_UNIT_LENGTH_SIZE = 4;

				const nalUnits: NalUnitLocation[] = [];
				for (const loc of iterateNalUnitsInAnnexB(packetData)) {
					if (this.codec === 'avc') {
						const naluType = extractNalUnitTypeForAvc(packetData[loc.offset]!);

						// Certain NALUs get stripped
						if (
							naluType !== AvcNalUnitType.SPS
							&& naluType !== AvcNalUnitType.PPS
							&& naluType !== AvcNalUnitType.SPS_EXT
						) {
							nalUnits.push(loc);
						}
					} else {
						const naluType = extractNalUnitTypeForHevc(packetData[loc.offset]!);

						// Certain NALUs get stripped
						if (
							naluType !== HevcNalUnitType.SPS_NUT
							&& naluType !== HevcNalUnitType.PPS_NUT
							&& naluType !== HevcNalUnitType.VPS_NUT
						) {
							nalUnits.push(loc);
						}
					}
				}

				let totalSize = 0;
				for (const nalUnit of nalUnits) {
					totalSize += NAL_UNIT_LENGTH_SIZE + nalUnit.length;
				}

				const lengthPrefixedData = new Uint8Array(totalSize);
				const dataView = new DataView(lengthPrefixedData.buffer);
				let offset = 0;

				// Write each NAL unit with its length prefix
				for (const nalUnit of nalUnits) {
					const length = nalUnit.length;

					dataView.setUint32(offset, length, false);
					offset += 4;

					lengthPrefixedData.set(
						packetData.subarray(nalUnit.offset, nalUnit.offset + nalUnit.length),
						offset,
					);
					offset += nalUnit.length;
				}

				packetData = lengthPrefixedData;
			}
		} else if (this.codec === 'vp8') {
			if (!this.packetEmitted) {
				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'vp8',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					hevcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo: null,
					proresFormat: null,
				});
			}
		} else if (this.codec === 'vp9') {
			if (!this.packetEmitted) {
				const vp9CodecInfo = extractVp9CodecInfoFromPacket(packetData);

				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'vp9',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					hevcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo,
					av1CodecInfo: null,
					proresFormat: null,
				});
			}
		} else if (this.codec === 'av1') {
			if (!this.packetEmitted) {
				const av1CodecInfo = extractAv1CodecInfoFromPacket(packetData);

				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'av1',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					hevcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo,
					proresFormat: null,
				});
			}
		} else if (this.codec === 'prores') {
			if (!this.packetEmitted) {
				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'prores',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					hevcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo: null,
					proresFormat: this.config.codec as ProresFourCc,
				});
			}
		} else {
			throw new Error('Unreachable.');
		}

		const sideData: EncodedPacketSideData = {};
		const matroskaBlockAdditional = this.packet.getSideData(NodeAv.AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL);
		if (matroskaBlockAdditional) {
			sideData.alpha = toUint8Array(matroskaBlockAdditional).subarray(8); // Skip the BlockAddId
		}

		const packet = new EncodedPacket(
			packetData,
			this.packet.isKeyframe ? 'key' : 'delta',
			timestamp,
			duration,
			undefined,
			undefined,
			sideData,
		);

		if (decoderConfigCodecString !== null) {
			// Create the decoder config
			metadata.decoderConfig = {
				codec: decoderConfigCodecString,
				codedWidth: this.codecContext.width,
				codedHeight: this.codecContext.height,
				displayAspectWidth: this.config.displayWidth ?? this.codecContext.width,
				displayAspectHeight: this.config.displayHeight ?? this.codecContext.height,
				description: decoderConfigDescription ?? undefined,
				colorSpace: {
					primaries: unmapColorPrimaries(this.codecContext.colorPrimaries) as VideoColorPrimaries,
					matrix: unmapMatrixCoefficients(this.codecContext.colorSpace) as VideoMatrixCoefficients,
					transfer:
						unmapTransferCharacteristics(this.codecContext.colorTrc) as VideoTransferCharacteristics,
					fullRange: this.codecContext.colorRange === NodeAv.AVCOL_RANGE_JPEG
						? true
						: this.codecContext.colorRange === NodeAv.AVCOL_RANGE_MPEG
							? false
							: undefined,
				},
			};
		}

		this.packetEmitted = true;
		this.onPacket(packet, metadata);
	}

	async flush(): Promise<void> {
		if (this.codecContext) {
			// Send null frame to signal flush
			const ret = await this.codecContext.sendFrame(null);
			NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

			// Keep receiving packets until no more are available
			while (true) {
				const receiveRet = await this.codecContext.receivePacket(this.packet);
				if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
					break;
				}

				this.receivePacket(receiveRet);
			}

			this.codecContext.freeContext();
			this.codecContext = null;
			// The codec is done now and can't be reused. Any subsequent encode call will first need to recreate a
			// codec context.
		}

		this.packetEmitted = false;
	}

	close(): MaybePromise<void> {
		this.codecContext?.freeContext();
		this.frame.free();
		this.packet.free();
		this.scaler?.freeContext();
		this.dstFrame?.free();
	}
}
