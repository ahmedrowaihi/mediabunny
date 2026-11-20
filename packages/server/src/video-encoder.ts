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
import { getSoftwareEncoderCodec, isHardwareCodec } from './encoder-choice';
import {
	CODEC_TO_CODEC_ID,
	getHardwareEncoderCodec,
	pixelFormatToY4mTag,
	isRgbPixelFormat,
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
	extractMpeg2CodecInfoFromPacket,
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
	extractVideoProfileAndLevel,
	extractVideoCodecString,
	MPEG2_OBJECT_TYPE_422,
	mpeg2ObjectTypeOf,
	ProresFourCc,
	VIDEO_BIT_DEPTHS,
	VideoBitDepth,
} from '../../../src/codec';
import { assert, binarySearchLessOrEqual, simplifyRational, toUint8Array } from '../../../src/misc';
import { type QualityCappedVideoEncoderConfig, type VideoEncoderControls } from '../../../src/encode';

/** Encoders whose `profile` option takes the names an AVC or HEVC codec string states, rather than a number. */
const NAMES_H26X_PROFILES = new Set(['libx264', 'libx265']);

const PARAMS_OPTION: Record<string, string | undefined> = {
	libx264: 'x264-params',
	libx265: 'x265-params',
	libsvtav1: 'svtav1-params',
};

/**
 * What `min-keyint` is pinned to when scene-cut detection is on. Measured: left at its default, x264 and x265
 * promote a cut that falls past their own minimum interval to an IDR - a sync sample off the forced grid.
 */
const SCENE_CUT_MIN_KEYINT = 2 ** 20;

/**
 * The ProRes profiles that are 4:4:4. The four-character code fixes the chroma format - it is not a
 * preference - so these must not be encoded at 4:2:2 however the encoder orders its formats.
 */
const PRORES_444_FOURCCS = new Set<ProresFourCc>(['ap4h', 'ap4x']);

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

/**
 * Chroma format of each format in the tables above, for the codecs whose profile fixes it. The tables
 * prefer 4:2:0 at every depth, so a profile that fixes the chroma - ProRes through its four-character
 * code, MPEG-2 4:2:2 Profile through its object type - has to filter them before they are consulted.
 */
const CHROMA_FORMAT_OF: Partial<Record<NodeAv.AVPixelFormat, '420' | '422' | '444'>> = {
	[NodeAv.AV_PIX_FMT_YUV420P]: '420',
	[NodeAv.AV_PIX_FMT_NV12]: '420',
	[NodeAv.AV_PIX_FMT_YUV420P10LE]: '420',
	[NodeAv.AV_PIX_FMT_P010LE]: '420',
	[NodeAv.AV_PIX_FMT_YUV420P12LE]: '420',
	[NodeAv.AV_PIX_FMT_YUVA420P]: '420',
	[NodeAv.AV_PIX_FMT_YUVA420P10LE]: '420',
	[NodeAv.AV_PIX_FMT_YUV422P]: '422',
	[NodeAv.AV_PIX_FMT_YUV422P10LE]: '422',
	[NodeAv.AV_PIX_FMT_YUV422P12LE]: '422',
	[NodeAv.AV_PIX_FMT_YUVA422P]: '422',
	[NodeAv.AV_PIX_FMT_YUVA422P10LE]: '422',
	[NodeAv.AV_PIX_FMT_YUVA422P12LE]: '422',
	[NodeAv.AV_PIX_FMT_YUV444P]: '444',
	[NodeAv.AV_PIX_FMT_YUV444P10LE]: '444',
	[NodeAv.AV_PIX_FMT_YUV444P12LE]: '444',
	[NodeAv.AV_PIX_FMT_YUVA444P]: '444',
	[NodeAv.AV_PIX_FMT_YUVA444P10LE]: '444',
	[NodeAv.AV_PIX_FMT_YUVA444P12LE]: '444',
};

const pixelFormatForBitDepth = (
	supportedPixelFormats: NodeAv.AVPixelFormat[] | null,
	bitDepth: VideoBitDepth,
	wantsAlpha: boolean,
	chromaFormat: '420' | '422' | '444' | null = null,
): NodeAv.AVPixelFormat | null => {
	const allCandidates = wantsAlpha
		? ALPHA_PIXEL_FORMATS_BY_BIT_DEPTH[bitDepth]
		: PIXEL_FORMATS_BY_BIT_DEPTH[bitDepth];
	const candidates = chromaFormat === null
		? allCandidates
		: allCandidates.filter(format => CHROMA_FORMAT_OF[format] === chromaFormat);

	if (!supportedPixelFormats) {
		return candidates[0] ?? null;
	}

	return candidates.find(format => supportedPixelFormats.includes(format)) ?? null;
};

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
	/**
	 * The chroma format the codec profile fixes, where it fixes one, so it is not left to the encoder's
	 * own ordering. ProRes states it in the four-character code; most codecs state nothing and pass null.
	 */
	chromaFormat?: '420' | '422' | '444' | null;
	/** Null when the encoder advertises no list, in which case any depth is assumed reachable. */
	supportedPixelFormats: NodeAv.AVPixelFormat[] | null;
	/** The depth the codec string states, which the output will be labelled with. */
	requestedBitDepth: VideoBitDepth | null;
	/** The depth of the frames handed to the encoder. */
	incomingBitDepth: VideoBitDepth | null;
	wantsAlpha: boolean;
}): NodeAv.AVPixelFormat => {
	const { codecName, supportedPixelFormats, requestedBitDepth, incomingBitDepth, wantsAlpha } = options;
	const chromaFormat = options.chromaFormat ?? null;
	const desiredBitDepth = requestedBitDepth ?? incomingBitDepth;

	if (desiredBitDepth !== null) {
		const match = pixelFormatForBitDepth(supportedPixelFormats, desiredBitDepth, wantsAlpha, chromaFormat);
		if (match !== null) {
			return match;
		}

		if (requestedBitDepth !== null) {
			throw new Error(
				`Encoder '${codecName ?? 'unknown'}' cannot encode ${requestedBitDepth}-bit video`
				+ `${wantsAlpha ? ' with alpha' : ''}, which the requested codec profile demands.`,
			);
		}
	}

	let pixelFormat = NodeAv.AV_PIX_FMT_YUV420P;

	if (supportedPixelFormats) {
		const fixed = chromaFormat !== null
			? supportedPixelFormats.find(format => CHROMA_FORMAT_OF[format] === chromaFormat)
			: undefined;

		if (fixed !== undefined) {
			pixelFormat = fixed;
		} else if (!supportedPixelFormats.includes(NodeAv.AV_PIX_FMT_YUV420P)) {
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

const toFramerateRational = (framerate: number) => {
	const ntscNum = Math.round(framerate * 1001);
	if (ntscNum % 1000 === 0 && Math.abs(ntscNum / 1001 - framerate) < 1e-4 && !Number.isInteger(framerate)) {
		return { num: ntscNum, den: 1001 };
	}

	return simplifyRational({ num: Math.round(framerate * 1000), den: 1000 });
};

const getQualityCap = (config: VideoEncoderConfig) => {
	const { _maxBitrate, _bufferSize } = config as VideoEncoderConfig & { _maxBitrate?: number; _bufferSize?: number };
	return _maxBitrate === undefined ? null : { maxBitrate: _maxBitrate, bufferSize: _bufferSize };
};

/**
 * Thrown where a selected encoder has no option for a control the caller stated. Distinguished from an
 * open failure so the hardware fallback does not report a refused control as a missing device.
 */
class UnsupportedEncoderControlError extends Error {}

/**
 * VC-3's sample entry fourcc, which is also its codec string.
 *
 * Stated here rather than imported from the core: this package resolves `mediabunny` to whatever the
 * consumer installed, which is an upstream release that knows nothing of DNxHD. A fourcc is fixed by the
 * registry, so there is nothing here to drift from `DNXHD_FOURCC`.
 */
const DNXHD_FOURCC = 'AVdn';

/** As with {@link DNXHD_FOURCC}: stated here, because the installed core predates it. */
const RAWVIDEO_CODEC_STRING = 'rawvideo';

const textEncoder = new TextEncoder();

/** The VBV D-10 states, in bits; it is filled at the start so the first frame is already exact. */
const D10_VBV_BITS = 2_000_000;

/**
 * The VC-3 classes, by the frame size each one IS.
 *
 * A class is a fixed number of octets per frame at 1920x1080, so the bitrate follows from it and the
 * frame rate rather than being chosen: 145 Mbit/s at 29.97 and 120 at 25 are the same 606,208 octets.
 * ffmpeg's encoder matches a class by comparing the stated bitrate against its own table, so the exact
 * value matters and the rates below are the ones that table holds - measured, not rounded.
 */
const VC3_CLASSES = {
	'145': { frameSize: 606_208, bitDepth: 8 as const, megabits: { 25: 120, 29.97: 145 } },
	'220': { frameSize: 917_504, bitDepth: 8 as const, megabits: { 25: 185, 29.97: 220 } },
	'220x': { frameSize: 917_504, bitDepth: 10 as const, megabits: { 25: 185, 29.97: 220 } },
} as const;

/** DNxHR profiles, which take any resolution and are picked by name rather than by bitrate. */
const DNXHR_PROFILES = {
	lb: { name: 'dnxhr_lb', bitDepth: 8 as const, chroma: '422' as const },
	sq: { name: 'dnxhr_sq', bitDepth: 8 as const, chroma: '422' as const },
	hq: { name: 'dnxhr_hq', bitDepth: 8 as const, chroma: '422' as const },
	hqx: { name: 'dnxhr_hqx', bitDepth: 10 as const, chroma: '422' as const },
	444: { name: 'dnxhr_444', bitDepth: 10 as const, chroma: '444' as const },
} as const;

/**
 * How far past a timeline point a decode timestamp may sit and still be one. A packet's times arrive on
 * the encoder's own time base and are converted through microseconds, while a presentation time may be
 * refined to the exact frame time, so an x264 packet whose `dts` correctly equals its `pts` comes back
 * as 0.041667s against a presentation time of 0.0416666666666666664s. One microsecond covers that
 * rounding; the values this guard exists to catch are out by around 1e12 seconds, so it gives up
 * nothing.
 */
const TICK_TOLERANCE = 1e-6;

/**
 * Whether a decode timestamp an encoder stated can be one at all. Two things must hold: it is never
 * after the frame's own presentation time, and it is never earlier than the content submitted so far
 * could justify, because a reorder delay cannot exceed the span of what has been handed in.
 *
 * Both halves are needed. x265 leaves `m_bframeDelayTime` uninitialised until its third input frame
 * (assigned at `m_pocLast == m_bframeDelay`), so a one- or two-frame encode can report a delay of
 * either sign and any magnitude - offsets around 7.5e12 seconds have been seen. Carried through, the
 * ISO BMFF muxer writes it into `ctts` and `elst` and the result decodes no frame at all, which is a
 * silent corruption rather than an error.
 *
 * `submitted` is the frames handed to the encoder, oldest first; an empty one leaves only the first
 * half to check.
 *
 * @internal
 */
export const decodeTimeIsOnThisTimeline = (
	decodeTimestamp: number,
	timestamp: number,
	submitted: readonly { timestamp: number; duration: number }[],
): boolean => {
	if (!Number.isFinite(decodeTimestamp) || decodeTimestamp > timestamp + TICK_TOLERANCE) {
		return false;
	}

	const first = submitted[0];
	const last = submitted[submitted.length - 1];
	if (!first || !last) {
		return true;
	}

	const submittedSpan = last.timestamp + last.duration - first.timestamp;
	return decodeTimestamp >= first.timestamp - submittedSpan - TICK_TOLERANCE;
};

/** @internal */
export const dnxProfileOf = (controls: VideoEncoderControls | undefined) => {
	const profile = controls?.dnxProfile;
	if (profile == null) {
		return null;
	}

	if (profile === '145' || profile === '220' || profile === '220x') {
		return { kind: 'vc3' as const, class: profile, ...VC3_CLASSES[profile] };
	}

	return { kind: 'dnxhr' as const, ...DNXHR_PROFILES[profile] };
};

export class NodeAvVideoEncoder extends CustomVideoEncoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	codecContext: NodeAv.CodecContext | null = null;
	scaler: NodeAv.SoftwareScaleContext | null = null;
	dstFrame: NodeAv.Frame | null = null;
	avCodec!: NodeAv.Codec;
	lastBuffer: Buffer | null = null;
	/**
	 * The codec context's time base: microseconds, except for MPEG-2, which derives its `frame_rate_code`
	 * from it and rejects a microsecond base as 1000000 fps.
	 */
	ptsTimeBase = { num: 1, den: 1e6 };
	packetEmitted = false;
	quantizer: number | null = null;

	// Bookkeeping to restore the original timing information. Keyed by the TICK the frame was sent with
	// rather than by its microseconds: a time base coarser than a microsecond - which MPEG-2 and AVC use,
	// so the stream can state its frame rate - makes microseconds -> ticks -> microseconds lossy, and an
	// entry looked up by a microsecond that came back a unit off is an entry that is never found.
	preciseTimings: {
		tick: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	static override supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		const codecSupported = config.bitrateMode === 'quantizer'
			? codec === 'avc' || codec === 'hevc' || codec === 'vp9' || codec === 'av1'
			: codec === 'avc' || codec === 'hevc' || codec === 'vp8' || codec === 'vp9' || codec === 'av1'
				|| codec === 'prores' || codec === 'mpeg2' || codec === 'dnxhd' || codec === 'rawvideo';

		if (!codecSupported) {
			return false;
		}

		if (getQualityCap(config)) {
			if (config.bitrateMode !== 'quantizer') {
				return false;
			}

			const codecId = CODEC_TO_CODEC_ID[codec];
			assert(codecId !== undefined);
			if (getSoftwareEncoderCodec(codec, codecId)?.name === 'librav1e') {
				return false;
			}
		}

		const requestedBitDepth = extractVideoBitDepth(config.codec);
		if (requestedBitDepth === null) {
			return true;
		}

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

		// Which encoder ran decides byte-reproducibility (hardware encoders are not deterministic), and
		// nothing else reports it — diagnosing that from output bytes once took a day.
		Logging._info(`Encoding '${this.codec}' with ${codec.name ?? 'unknown codec'}.`);

		this.avCodec = codec;
	}

	/**
	 * Opens the context, and where a hardware encoder will not open, opens a software one instead.
	 *
	 * `prefer-hardware` is a preference: a build can carry a device encoder for a device that is not
	 * there — node-av's linux-arm64 prebuild carries `h264_rkmpp` on every arm64 machine — and whether
	 * it is really there is only known from trying to open it. A codec asked for outright is not
	 * second-guessed, so `prefer-software` never lands here.
	 */
	private async createCodecContextWithSoftwareFallback() {
		if (!isHardwareCodec(this.avCodec)) {
			await this.createCodecContext();
			return;
		}

		try {
			await this.createCodecContext();
			return;
		} catch (error) {
			const codecId = CODEC_TO_CODEC_ID[this.codec];
			assert(codecId !== undefined);
			const software = getSoftwareEncoderCodec(this.codec, codecId);
			if (!software) {
				throw error;
			}

			// A refused control is not a missing device, and saying so sends the reader looking for a
			// driver problem that is not there
			Logging._warn(
				error instanceof UnsupportedEncoderControlError
					? `'${this.avCodec.name ?? 'unknown codec'}' cannot honour a stated encoder control`
					+ ` (${error.message}). Falling back to ${software.name ?? 'software'}.`
					: `'${this.avCodec.name ?? 'unknown codec'}' would not open (${String(error)}), which means`
						+ ` the device it drives is not available. Falling back to`
						+ ` ${software.name ?? 'software'}.`,
			);
			this.avCodec = software;

			Logging._info(`Encoding '${this.codec}' with ${software.name ?? 'unknown codec'}.`);
		}

		await this.createCodecContext();
	}

	toTicks(microseconds: number) {
		const { num, den } = this.ptsTimeBase;
		return Math.round(microseconds * den / (num * 1e6));
	}

	toMicroseconds(ticks: number) {
		const { num, den } = this.ptsTimeBase;
		return Math.round(ticks * num * 1e6 / den);
	}

	async createCodecContext() {
		assert(this.codecContext === null);

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(this.avCodec);
		codecContext.threadCount = 0; // Auto

		const incomingBitDepth = bitDepthOfPixelFormat(this.frame.format as NodeAv.AVPixelFormat);
		// ProRes 4444 has full-resolution chroma at 10 bits, and `extractVideoBitDepth` reads no depth out
		// of a ProRes fourcc, so without this the chooser falls back to whatever 4:4:4 format comes first
		// in the encoder's list - which the encoder would then subsample given 4:2:2 input.
		const prores444 = this.codec === 'prores'
			&& PRORES_444_FOURCCS.has(this.config.codec as ProresFourCc);
		const pixelFormat = choosePixelFormat({
			codecName: this.avCodec.name,
			supportedPixelFormats: this.avCodec.pixelFormats,
			// `AVdn` carries no depth, so the profile is what states it for a VC-3 or DNxHR encode
			requestedBitDepth: dnxProfileOf((this.config as QualityCappedVideoEncoderConfig)._encoderControls)
				?.bitDepth
				?? (prores444 ? 10 : extractVideoBitDepth(this.config.codec)),
			incomingBitDepth,
			wantsAlpha: this.config.alpha === 'keep',
			// D-10 IS 4:2:2 profile at main level - SMPTE 356M defines no 4:2:0 variant - so the control
			// settles the chroma format whatever the codec string says. Measured: without this the
			// output is MPEG-2 Main 4:2:0 with D-10's frame sizes, which is not an IMX deliverable even
			// though every frame is the right length and the container accepts it.
			chromaFormat: (() => {
				const profile = dnxProfileOf((this.config as QualityCappedVideoEncoderConfig)._encoderControls);
				return profile === null ? undefined : (profile.kind === 'dnxhr' ? profile.chroma : '422');
			})() ?? ((this.config as QualityCappedVideoEncoderConfig)._encoderControls?.d10 != null
				? '422'
				: this.codec === 'prores'
					? (prores444 ? '444' : '422')
					: this.codec === 'mpeg2'
						? (mpeg2ObjectTypeOf(this.config.codec) === MPEG2_OBJECT_TYPE_422 ? '422' : '420')
						: null),
		});

		const pixelAspectRatio = simplifyRational({
			num: (this.config.displayWidth ?? this.config.width) * this.config.height,
			den: (this.config.displayHeight ?? this.config.height) * this.config.width,
		});

		codecContext.width = this.config.width;
		codecContext.height = this.config.height;
		codecContext.pixelFormat = pixelFormat;
		codecContext.threadCount = 0;
		const framerate = toFramerateRational(this.config.framerate || 30);

		// x264 takes the SPS VUI timing straight from the encoder's time base - num_units_in_tick is its
		// numerator and time_scale twice its denominator - so a microsecond time base makes the stream
		// declare a million frames a second. The rate and the PTS resolution are one knob there, and the
		// stated rate is the one worth having: a broadcast receiver reads the SPS and nothing else.
		// (x265 takes its timing from the frame rate instead, and already states it correctly.)
		const statesFramerate = !!this.config.framerate;
		if (this.codec === 'mpeg2' || (this.codec === 'avc' && statesFramerate)) {
			this.ptsTimeBase = { num: framerate.den, den: framerate.num };
		}

		if (this.codec === 'mpeg2') {
			// MPEG-2 defaults to open GOPs, and `>>> 0` because bit 31 through a plain `|` is negative
			codecContext.flags = (
				(codecContext.flags | NodeAv.AV_CODEC_FLAG_CLOSED_GOP) >>> 0
			) as NodeAv.AVCodecFlag;
			codecContext.setOption('sc_threshold', '1000000000');
		}

		codecContext.timeBase = new NodeAv.Rational(this.ptsTimeBase.num, this.ptsTimeBase.den);
		codecContext.gopSize = this.codec === 'mpeg2' ? 600 : 2 ** 30;
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

		let primaries = this.frame.colorPrimaries;
		let transfer = this.frame.colorTrc;
		let matrix = this.frame.colorSpace;
		let range = this.frame.colorRange;

		const inputIsRgb = isRgbPixelFormat(this.frame.format as NodeAv.AVPixelFormat);
		const outputIsRgb = isRgbPixelFormat(pixelFormat);

		// If the pixel format "types" differ, modify the destination color space accordingly
		if (inputIsRgb && !outputIsRgb) {
			// Very common case: RGB->YUV conversion during encoding
			// Retag sRGB as BT.709 since players handle that way better, and pick the matrix matching the primaries
			if (primaries === NodeAv.AVCOL_PRI_UNSPECIFIED) {
				primaries = NodeAv.AVCOL_PRI_BT709;
			}
			if (transfer === NodeAv.AVCOL_TRC_UNSPECIFIED || transfer === NodeAv.AVCOL_TRC_IEC61966_2_1) {
				transfer = NodeAv.AVCOL_TRC_BT709;
			}

			if (primaries === NodeAv.AVCOL_PRI_BT2020) {
				matrix = NodeAv.AVCOL_SPC_BT2020_NCL;
			} else if (primaries === NodeAv.AVCOL_PRI_BT470BG) {
				matrix = NodeAv.AVCOL_SPC_BT470BG;
			} else if (primaries === NodeAv.AVCOL_PRI_SMPTE170M) {
				matrix = NodeAv.AVCOL_SPC_SMPTE170M;
			} else {
				matrix = NodeAv.AVCOL_SPC_BT709;
			}

			range = NodeAv.AVCOL_RANGE_MPEG;
		} else if (!inputIsRgb && outputIsRgb) {
			matrix = NodeAv.AVCOL_SPC_RGB;
			range = NodeAv.AVCOL_RANGE_JPEG;
		}

		codecContext.colorPrimaries = primaries;
		codecContext.colorTrc = transferForOutputBitDepth(transfer, bitDepthOfPixelFormat(pixelFormat));
		codecContext.colorSpace = matrix;
		codecContext.colorRange = range;

		if (this.config.bitrateMode === 'constant') {
			codecContext.rcMinRate = codecContext.bitRate;
			codecContext.rcMaxRate = codecContext.bitRate;

			// A rate pinned top and bottom is only really constant against a buffer; without one the
			// encoder has no window to even out over. Set only when the caller stated a buffer size, so
			// an encode that did not ask comes out exactly as it did before.
			const { _bufferSize } = this.config as QualityCappedVideoEncoderConfig;
			if (_bufferSize !== undefined) {
				codecContext.rcBufferSize = _bufferSize;
			}
		}

		const isRealtime = this.config.latencyMode === 'realtime';

		const ownParams = new Map<string, string>();

		if (this.avCodec.name === 'libx264') {
			ownParams.set('scenecut', '0');

			if (isRealtime) {
				codecContext.setOption('tune', 'zerolatency');
				codecContext.setOption('preset', 'ultrafast');
			}
		} else if (this.avCodec.name === 'libx265') {
			ownParams.set('log-level', 'error');
			ownParams.set('scenecut', '0');
			ownParams.set('open-gop', '0');
			codecContext.setOption('forced-idr', '1');

			if (isRealtime) {
				codecContext.setOption('tune', 'zerolatency');
				codecContext.setOption('preset', 'ultrafast');
			}
		} else if (this.avCodec.name === 'libvpx') {
			// `deadline` outside realtime too, which is what the libvpx-vp9 branch below does
			// unconditionally. Without it VP8 encodes at libvpx's `good` deadline and costs 42 s
			// against VP9's 6.9 s for the same 125 frames of 1080p - six times its own successor,
			// which is not a trade anyone asked for. `cpu-used=8` was already here, so the intent to
			// go fast was stated; only the mode knob was missing.
			codecContext.setOption('deadline', 'realtime');
			codecContext.setOption('cpu-used', '8');

			if (this.config.alpha === 'keep') {
				// libvpx refuses to encode VP8 transparency when alternate reference frames are enabled
				codecContext.setOption('auto-alt-ref', '0');
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
			if (
				this.avCodec.name === 'libaom-av1'
				|| this.avCodec.name === 'libsvtav1'
				// Mediabunny uses the quantizer index (0-255), while this encoder expects the 0-63 quantizer scale
				|| this.avCodec.name === 'libvpx-vp9'
			) {
				mapped = Math.round(this.quantizer / 4);
			} else if (this.avCodec.name === 'libx264') {
				// x264 makes qp 0 lossless, which switches to the High 4:4:4 Predictive profile. That's not what a
				// quantizer of 0 means elsewhere, and a mid-stream quantizer change would swap profiles under the
				// decoder.
				mapped = Math.max(this.quantizer, 1);
			} else {
				// Everything else lines up with Mediabunny directly
				mapped = this.quantizer;
			}

			const cap = getQualityCap(this.config);
			if (cap) {
				const bufferSize = cap.bufferSize ?? 2 * cap.maxBitrate;
				let honoursBufferSize = false;

				if (this.avCodec.name === 'libx264' || this.avCodec.name === 'libx265') {
					codecContext.setOption('crf', String(mapped));
					codecContext.rcMaxRate = BigInt(cap.maxBitrate);
					codecContext.rcBufferSize = bufferSize;
					honoursBufferSize = true;
				} else if (this.avCodec.name === 'libsvtav1') {
					codecContext.setOption('crf', String(Math.max(mapped, 1)));
					codecContext.rcMaxRate = BigInt(cap.maxBitrate);
					codecContext.rcBufferSize = bufferSize;
					honoursBufferSize = true;
				} else if (this.avCodec.name === 'libvpx-vp9' || this.avCodec.name === 'libaom-av1') {
					codecContext.setOption('crf', String(mapped));
					codecContext.bitRate = BigInt(cap.maxBitrate);
				} else if (this.avCodec.name?.endsWith('_nvenc')) {
					codecContext.setOption('rc', 'vbr');
					codecContext.setOption('cq', String(mapped));
					codecContext.rcMaxRate = BigInt(cap.maxBitrate);
				} else {
					throw new Error(
						`Encoder '${this.avCodec.name}' cannot be used for capped quantizer-based encoding.`,
					);
				}

				if (cap.bufferSize !== undefined && !honoursBufferSize) {
					Logging._warn(
						`bufferSize has no effect with '${this.avCodec.name}', whose capped mode bounds the bitrate`
						+ ' rather than a buffer, so maxBitrate alone is the cap. Encode avc, hevc or av1 with'
						+ ' their software encoders for a buffer model.',
					);
				}
			} else if (this.avCodec.name === 'libx264' || this.avCodec.name === 'libx265') {
				codecContext.setOption('crf', String(mapped));
			} else if (this.avCodec.name === 'libvpx-vp9' || this.avCodec.name === 'libaom-av1') {
				codecContext.setOption('crf', String(mapped));
			} else if (this.avCodec.name === 'libsvtav1') {
				codecContext.setOption('crf', String(Math.max(mapped, 1)));
			} else if (this.avCodec.name === 'librav1e') {
				codecContext.setOption('qp', String(mapped));
			} else if (this.avCodec.name?.endsWith('_nvenc')) {
				codecContext.setOption('rc', 'constqp');
				codecContext.setOption('qp', String(mapped));
			} else {
				throw new Error(`Encoder '${this.avCodec.name}' cannot be used for quantizer-based encoding.`);
			}

			if (!cap && (this.avCodec.name === 'librav1e' || this.avCodec.name?.endsWith('_nvenc'))) {
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

		this.applyEncoderControls(codecContext, ownParams);

		const ret = await codecContext.open2();
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.codecContext = codecContext;
	}

	// A rung encoded without the profile or GOP structure it asked for is not that rung, so a control the
	// encoder has no option for is refused rather than dropped
	private applyEncoderControls(codecContext: NodeAv.CodecContext, ownParams: Map<string, string>) {
		const name = this.avCodec.name ?? '';
		const controls = (this.config as QualityCappedVideoEncoderConfig)._encoderControls;
		const paramsOption = PARAMS_OPTION[name] ?? null;

		const refuse = (control: string, because?: string): never => {
			throw new UnsupportedEncoderControlError(
				`encoderControls.${control} is not supported by the selected encoder (${name})`
				+ `${because ? `: ${because}` : '.'}`
				+ ` Use encoderControls.options to pass an option this encoder has.`,
			);
		};

		const setOrRefuse = (option: string, value: string, control: string) => {
			if (codecContext.setOption(option, value) < 0) {
				refuse(control);
			}
		};

		// Only a codec string the caller stated is a request; the one this library derives from the size and
		// bit depth is a label, and imposing its level on the encoder caps the bitrate or refuses to open
		const config = this.config as QualityCappedVideoEncoderConfig;
		const fromCodecString = config._codecStringIsDerived
			? { profile: null, level: null }
			: extractVideoProfileAndLevel(this.config.codec);
		const profile = controls?.profile ?? fromCodecString.profile ?? undefined;
		const level = controls?.level ?? fromCodecString.level ?? undefined;

		if (profile !== undefined && (controls?.profile != null || NAMES_H26X_PROFILES.has(name))) {
			setOrRefuse('profile', profile, 'profile');
		}

		if (level !== undefined && (controls?.level != null || NAMES_H26X_PROFILES.has(name))) {
			if (name === 'libx265') {
				ownParams.set('level-idc', String(Math.round(level * 10)));
			} else {
				setOrRefuse('level', level.toFixed(1), 'level');
			}
		}

		if (controls) {
			if (controls.preset != null) {
				setOrRefuse('preset', controls.preset, 'preset');
			}

			if (controls.tune != null) {
				setOrRefuse('tune', controls.tune, 'tune');
			}

			if (controls.maxBFrames != null) {
				setOrRefuse('bf', String(controls.maxBFrames), 'maxBFrames');
			}

			if (controls.closedGop != null) {
				if (paramsOption === null) {
					refuse('closedGop');
				}
				ownParams.set('open-gop', controls.closedGop ? '0' : '1');
			}

			if (controls.sceneCut != null && controls.sceneCut !== false) {
				if (name === 'libx264' || name === 'libx265') {
					ownParams.set('scenecut', String(controls.sceneCut));
					ownParams.set('min-keyint', String(SCENE_CUT_MIN_KEYINT));
				} else if (name === 'libsvtav1') {
					ownParams.set('scd', '1');
				} else {
					refuse('sceneCut');
				}
			}

			const dnx = dnxProfileOf(controls);
			if (dnx !== null) {
				if (name !== 'dnxhd') {
					refuse('dnxProfile', 'VC-3 and DNxHR are what the dnxhd encoder writes, and no other');
				}

				if (dnx.kind === 'dnxhr') {
					setOrRefuse('profile', dnx.name, 'dnxProfile');
				} else {
					// A VC-3 class is a frame size, and ffmpeg picks the class by matching the stated
					// bitrate against its own table, so only the exact value it holds will do. The rate
					// follows from the class and the frame rate: 145 at 29.97 and 120 at 25 are both
					// 606,208 octets a frame.
					const fps = this.config.framerate ?? 0;
					const rounded = Math.abs(fps - 30000 / 1001) < 0.01 ? 29.97 : Math.round(fps);
					const megabits = (dnx.megabits as Record<number, number | undefined>)[rounded];

					if (megabits === undefined) {
						throw new UnsupportedEncoderControlError(
							`VC-3 class '${dnx.class}' is defined at 25 and 29.97 frames per second, and this`
							+ ` encode states ${fps || 'none'}. State one of those as the track's frameRate.`,
						);
					}

					// DNxHD defines no progressive 10-bit identifier at 29.97; the interlaced one exists
					if (dnx.class === '220x' && rounded === 29.97 && controls.interlaced == null) {
						throw new UnsupportedEncoderControlError(
							'VC-3 220x at 29.97 frames per second exists only interlaced - DNxHD defines no'
							+ ' progressive 10-bit identifier at that rate. Set encoderControls.interlaced,'
							+ ' or encode at 25, or use the 8-bit 220 class.',
						);
					}

					codecContext.bitRate = BigInt(megabits * 1_000_000);
				}
			}

			if (controls.d10 != null) {
				if (name !== 'mpeg2video') {
					refuse('d10', 'D-10 is an MPEG-2 mapping (SMPTE 356M) and no other codec defines it');
				}

				// Two different jobs here, and only measurement separates them. The RATE and
				// `rc_init_occupancy` are what make every frame come out at exactly rate/fps octets,
				// which an MXF D-10 mapping requires because it indexes the essence by that fixed unit;
				// removing `rc_init_occupancy` alone brings back the `frame size does not match index
				// unit size` the container refuses. The rest - intra VLC, non-linear quantisation,
				// 10-bit DC precision, the quantiser range - are SMPTE 356M bitstream constraints that
				// have no effect on the frame size at all, measured one by one, and are asserted
				// through `trace_headers` instead.
				const bitsPerSecond = controls.d10 * 1_000_000;
				codecContext.bitRate = BigInt(bitsPerSecond);
				codecContext.rcMinRate = BigInt(bitsPerSecond);
				codecContext.rcMaxRate = BigInt(bitsPerSecond);
				codecContext.rcBufferSize = D10_VBV_BITS;
				codecContext.flags = (
					codecContext.flags
					| NodeAv.AV_CODEC_FLAG_INTERLACED_DCT
					| NodeAv.AV_CODEC_FLAG_LOW_DELAY
				) as NodeAv.AVCodecFlag;

				for (const [option, value] of [
					['rc_init_occupancy', String(D10_VBV_BITS)],
					// These two have no measured effect on a short clip of static content - the rate
					// and `rc_init_occupancy` settle the frame size on their own - and they are kept
					// because they bound how much of the buffer one frame may take, which only varying
					// material exercises. Not deleted on the strength of a ten-frame test.
					['rc_max_vbv_use', '1'],
					['rc_min_vbv_use', '1'],
					['dc', '10'],
					['non_linear_quant', '1'],
					['intra_vlc', '1'],
					['qmin', '1'],
					['qmax', '3'],
					// No `ps`: the widely-copied IMX recipe sets `-ps 1`, and measured that gives one
					// slice per MACROBLOCK - 1,620 slice start codes a picture at 720x576 against the 36
					// a slice-per-row structure gives, since `ff_mpeg1_encode_slice_header` codes the row
					// in the start code and ffmpeg will emit several slices inside one row. That is legal
					// MPEG-2, it is not D-10's slice structure, and it spends about 7 KB of every frame
					// on slice headers for no effect this can demonstrate.
					['g', '1'], // Intra only: D-10 has no inter-coded pictures
				] as const) {
					setOrRefuse(option, value, 'd10');
				}
			}

			if (controls.picStruct) {
				if (name !== 'libx264') {
					// x265 writes `pic_struct` into its own `pic_timing` message without an SPS flag to
					// declare, and every other encoder has no such parameter
					refuse('picStruct');
				}

				ownParams.set('pic-struct', '1');
			}

			if (controls.nalHrd != null) {
				// The model being signalled is the buffer the encoder was given, so without one there is
				// nothing to state. A VBV needs BOTH a rate ceiling and a buffer: x264 ignores
				// `vbv-bufsize` on its own and writes nal_hrd_parameters_present_flag 0, so a buffer
				// size with no ceiling produced a stream that silently declared nothing. The ceiling is
				// either the cap's maxBitrate or, for a constant rate, the target itself.
				const cap = getQualityCap(this.config);
				const { _bufferSize } = this.config as QualityCappedVideoEncoderConfig;
				const hasCeiling = cap !== null || this.config.bitrateMode === 'constant';
				const hasBuffer = cap?.bufferSize !== undefined || cap !== null || _bufferSize !== undefined;
				if (!hasCeiling || !hasBuffer) {
					throw new UnsupportedEncoderControlError(
						'encoderControls.nalHrd needs a buffer model to state, and this encode has none.'
						+ ' A buffer model is a rate ceiling and a buffer size together: state maxBitrate'
						+ ' and bufferSize on the Quality, or bitrateMode \'constant\' with a bufferSize.'
						+ ' A bufferSize on its own is dropped by the encoder, which would then declare'
						+ ' no buffer model at all.',
					);
				}

				// x264 writes cbr_flag only where the rate really is constant - a target equal to its own
				// cap. A capped quantizer is not that, however tightly it is capped, so asking for 'cbr'
				// there would quietly produce a stream whose flag says 'vbr'.
				if (controls.nalHrd === 'cbr' && this.config.bitrateMode !== 'constant') {
					throw new UnsupportedEncoderControlError(
						'encoderControls.nalHrd \'cbr\' needs bitrateMode \'constant\': the cbr_flag it'
						+ ' writes says the arrival rate IS constant, and an encoder whose rate merely has'
						+ ' a ceiling - a capped quantizer - states \'vbr\' whatever is asked for here.'
						+ ' Use an explicit bitrate with bitrateMode \'constant\' and a bufferSize, or'
						+ ' nalHrd \'vbr\'.',
					);
				}

				if (name === 'libx264') {
					setOrRefuse('nal-hrd', controls.nalHrd, 'nalHrd');
				} else if (name === 'libx265') {
					// x265 has only `--hrd`, an on/off switch, and takes the cbr_flag from the rate
					// control rather than from a stated mode
					if (paramsOption === null) {
						refuse('nalHrd');
					}
					ownParams.set('hrd', '1');
				} else {
					refuse('nalHrd');
				}
			}

			if (controls.interlaced != null && this.codec === 'dnxhd') {
				// DNxHD picks its CID at open time from AV_CODEC_FLAG_INTERLACED_DCT - 1241 and 1242 are
				// the interlaced identifiers of the same classes 1235 and 1237 name progressively - and
				// reads the field order per frame from AV_FRAME_FLAG_TOP_FIELD_FIRST, which the encode
				// path sets. There is no parameter string to go through.
				codecContext.flags = (
					codecContext.flags | NodeAv.AV_CODEC_FLAG_INTERLACED_DCT
				) as NodeAv.AVCodecFlag;
			} else if (controls.interlaced != null) {
				// The field ORDER has to be stated before the encoder opens. ffmpeg's x264 wrapper does
				// reconfigure `b_tff` from each frame's AV_FRAME_FLAG_TOP_FIELD_FIRST, but x264 cannot
				// change it after opening, so that route silently yields top-field-first either way:
				// measured, ffmpeg's own CLI produces pic_struct 3 for bottom-field content given
				// `-flags +ilme` and nothing else. The parameter is what works - pic_struct 3 for
				// `tff=1` and 4 for `bff=1` - and AV_CODEC_FLAG_INTERLACED_DCT/_ME turn out to add
				// nothing on top of it for either encoder.
				if (paramsOption === null) {
					refuse('interlaced');
				}

				if (name !== 'libx264') {
					// x265 accepts an `interlace` parameter and calls its own interlaced support
					// experimental. Through this pipeline it produced a stream whose field order reads
					// back as `unknown` rather than the stated one, so the order cannot be shown to
					// reach the bitstream - and a control that silently does not take is worse than
					// one that is refused. `options` still passes it through for anyone who wants it.
					refuse(
						'interlaced',
						name === 'libx265'
							? 'x265 calls its interlaced support experimental and the stated field order'
							+ ' did not reach the bitstream when measured'
							: undefined,
					);
				}

				// x264 names the two orders as separate boolean parameters, each implying interlaced
				ownParams.set(controls.interlaced, '1');
			}

			if (controls.pass) {
				if (paramsOption === null) {
					refuse('pass');
				}
				codecContext.flags = (codecContext.flags | (controls.pass.index === 1
					? NodeAv.AV_CODEC_FLAG_PASS1
					: NodeAv.AV_CODEC_FLAG_PASS2)) as NodeAv.AVCodecFlag;
				ownParams.set('stats', controls.pass.statsPath);
			}
		}

		const callerOptions = { ...controls?.options };

		if (paramsOption !== null) {
			const callerParams = callerOptions[paramsOption];
			delete callerOptions[paramsOption];

			for (const entry of callerParams?.split(':') ?? []) {
				if (entry.length === 0) {
					continue;
				}

				const separator = entry.indexOf('=');
				const key = separator === -1 ? entry : entry.slice(0, separator);
				const value = separator === -1 ? '' : entry.slice(separator + 1);

				if (ownParams.has(key) && ownParams.get(key) !== value) {
					throw new Error(
						`encoderControls.options['${paramsOption}'] sets '${key}' to '${value}', which conflicts`
						+ ` with the '${ownParams.get(key)!}' this library needs for key frame alignment. Remove it,`
						+ ` or state it through the matching field where one exists.`,
					);
				}

				ownParams.set(key, value);
			}
		}

		if (ownParams.size > 0) {
			assert(paramsOption !== null);
			codecContext.setOption(
				paramsOption,
				[...ownParams].map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(':'),
			);
		}

		for (const [key, value] of Object.entries<string>(callerOptions)) {
			codecContext.setOption(key, value);
		}
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

		if (this.codecContext === null) {
			await this.createCodecContextWithSoftwareFallback();
		}
		assert(this.codecContext);

		let frameToEncode = this.frame;

		const requiresScaler
			= this.codecContext.pixelFormat !== this.frame.format
				|| this.codecContext.width !== this.frame.width
				|| this.codecContext.height !== this.frame.height;

		if (requiresScaler) {
			if (!this.scaler) {
				// Left unconfigured on purpose: getContext/initContext ignore color properties and use BT.601
				this.scaler = new NodeAv.SoftwareScaleContext();
				this.scaler.allocContext();
				this.scaler.setOption('sws_flags', 'lanczos+accurate_rnd+full_chroma_int');
			}

			if (!this.dstFrame) {
				this.dstFrame = new NodeAv.Frame();
				this.dstFrame.alloc();
				this.dstFrame.width = this.codecContext.width;
				this.dstFrame.height = this.codecContext.height;
				this.dstFrame.format = this.codecContext.pixelFormat;
				this.dstFrame.allocBuffer();
			}

			// An encoder that delays (DNxHD, and any other that holds the frame past sendFrame) keeps a
			// reference to this buffer, and swscale writes into it without checking - which corrupts the
			// frame being encoded and aborts the process. No-op while we are the only owner.
			const writableRet = this.dstFrame.makeWritable();
			NodeAv.FFmpegError.throwIfError(writableRet, 'Make frame writable');

			this.dstFrame.copyProps(this.frame);
			this.dstFrame.colorPrimaries = this.codecContext.colorPrimaries;
			this.dstFrame.colorTrc = this.codecContext.colorTrc;
			this.dstFrame.colorSpace = this.codecContext.colorSpace;
			this.dstFrame.colorRange = this.codecContext.colorRange;

			// Primaries and transfer only ever differ due to retagging (e.g. sRGB as BT.709), so mirror them onto the
			// source. Otherwise, swscale would do a real (and slow) transfer conversion instead of just the matrix.
			// See https://github.com/Vanilagy/mediabunny/issues/572
			this.frame.colorPrimaries = this.codecContext.colorPrimaries;
			this.frame.colorTrc = this.codecContext.colorTrc;

			const ret = await this.scaler.scaleFrame(this.dstFrame, this.frame);
			NodeAv.FFmpegError.throwIfError(ret, 'Scale frame');

			frameToEncode = this.dstFrame;
		}

		frameToEncode.pts = BigInt(this.toTicks(videoSample.microsecondTimestamp));
		frameToEncode.duration = BigInt(this.toTicks(videoSample.microsecondDuration));
		frameToEncode.timeBase = new NodeAv.Rational(this.ptsTimeBase.num, this.ptsTimeBase.den);

		const interlaced = (this.config as QualityCappedVideoEncoderConfig)._encoderControls?.interlaced;
		if (interlaced !== undefined) {
			// x265 needs the frames themselves marked or it encodes progressive whatever its `interlace`
			// parameter says - measured: without this, field order reads back as `progressive`. x264 does
			// not need it, and it costs nothing there.
			frameToEncode.setFlags(NodeAv.AV_FRAME_FLAG_INTERLACED);
			if (interlaced === 'tff') {
				frameToEncode.setFlags(NodeAv.AV_FRAME_FLAG_TOP_FIELD_FIRST);
			} else {
				frameToEncode.clearFlags(NodeAv.AV_FRAME_FLAG_TOP_FIELD_FIRST);
			}
		}

		// Let's just set both for good measure
		frameToEncode.pictType = options?.keyFrame
			? NodeAv.AV_PICTURE_TYPE_I
			: NodeAv.AV_PICTURE_TYPE_NONE;
		frameToEncode.keyFrame = options?.keyFrame
			? 1
			: 0;

		const tick = Number(frameToEncode.pts);
		const preciseTimingIndex = binarySearchLessOrEqual(this.preciseTimings, tick, x => x.tick);
		const existingEntry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;
		if (existingEntry && existingEntry.tick === tick) {
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
				tick,
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

		frameToEncode.removeSideData(NodeAv.AV_FRAME_DATA_A53_CC);

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

		const ptsTick = Number(this.packet.pts);
		const pts = this.toMicroseconds(ptsTick);
		let timestamp = pts / 1e6;
		let duration = this.toMicroseconds(Number(this.packet.duration)) / 1e6;

		const preciseTimingIndex = binarySearchLessOrEqual(this.preciseTimings, ptsTick, x => x.tick);
		const entry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;

		// If there's a relevant timing entry, refine the packet's timing data to get better accuracy than
		// microseconds
		if (entry && entry.tick === ptsTick) {
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
					mpeg2CodecInfo: null,
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
					mpeg2CodecInfo: null,
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
					mpeg2CodecInfo: null,
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
					mpeg2CodecInfo: null,
					proresFormat: null,
				});
			}
		} else if (this.codec === 'mpeg2') {
			if (!this.packetEmitted) {
				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'mpeg2',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					hevcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo: null,
					mpeg2CodecInfo: extractMpeg2CodecInfoFromPacket(packetData),
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
					mpeg2CodecInfo: null,
					proresFormat: this.config.codec as ProresFourCc,
				});
			}
		} else if (this.codec === 'dnxhd') {
			// VC-3 has no RFC 6381 registration, so the four-character code is the whole string, the
			// way it is for ProRes. Reaching the `throw` below instead aborts the process rather than
			// failing the encode: this runs inside a node-av thread-safe callback, which cannot carry
			// a JavaScript exception back out.
			decoderConfigCodecString = DNXHD_FOURCC;
		} else if (this.codec === 'rawvideo') {
			decoderConfigCodecString = RAWVIDEO_CODEC_STRING;

			// Uncompressed frames say nothing about themselves, so the pixel format has to be stated
			// beside them or nothing downstream can read the planes
			assert(this.codecContext);
			const tag = pixelFormatToY4mTag(this.codecContext.pixelFormat);
			if (tag === null) {
				throw new Error(
					`Uncompressed video cannot be written in pixel format ${String(this.codecContext.pixelFormat)}:`
					+ ' Y4M names no colour space for it.',
				);
			}

			decoderConfigDescription = textEncoder.encode(tag);
		} else {
			throw new Error('Unreachable.');
		}

		const sideData: EncodedPacketSideData = {};
		const matroskaBlockAdditional = this.packet.getSideData(NodeAv.AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL);
		if (matroskaBlockAdditional) {
			sideData.alpha = toUint8Array(matroskaBlockAdditional).subarray(8); // Skip the BlockAddId
		}

		const rawDts = this.packet.dts;
		let decodeTimestamp = rawDts === null || rawDts === NodeAv.AV_NOPTS_VALUE
			? undefined
			: this.toMicroseconds(Number(rawDts)) / 1e6;

		if (
			decodeTimestamp !== undefined
			&& !decodeTimeIsOnThisTimeline(decodeTimestamp, timestamp, this.preciseTimings)
		) {
			Logging._warn(
				`The encoder stated a decode timestamp of ${decodeTimestamp}s for a frame presenting at`
				+ ` ${timestamp}s, which is not a time on this encode's own timeline. Dropping it, so the`
				+ ' decode order alone is carried and the muxer states the decode times itself.',
			);
			decodeTimestamp = undefined;
		}

		const packet = new EncodedPacket(
			packetData,
			this.packet.isKeyframe ? 'key' : 'delta',
			timestamp,
			duration,
			undefined,
			undefined,
			sideData,
			decodeTimestamp,
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
		this.preciseTimings.length = 0;
	}

	close(): MaybePromise<void> {
		this.codecContext?.freeContext();
		this.frame.free();
		this.packet.free();
		this.scaler?.freeContext();
		this.dstFrame?.free();
	}
}
