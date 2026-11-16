/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	type MaybePromise,
	VideoSamplePixelFormat,
	VideoSampleResource,
	VideoSampleColorSpace,
	SetRequired,
	VideoSampleInit,
	VideoSample,
	VideoDataPlane,
	VideoSampleTransformationDescription,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import { assert, toUint8Array } from '../../../src/misc';
import {
	isRgbPixelFormat,
	toPixelFormat,
	unmapColorPrimaries,
	unmapTransferCharacteristics,
	unmapMatrixCoefficients,
	fromPixelFormat,
	mapColorPrimaries,
	mapMatrixCoefficients,
	mapTransferCharacteristics,
} from './misc';

/**
 * Resampling flags for every `scale` in the transform chain. `lanczos` for the kernel, `accurate_rnd`
 * so intermediate results are not truncated, and `full_chroma_int` so chroma is interpolated at full
 * resolution rather than at its subsampled grid.
 */
const SCALE_FLAGS = 'lanczos+accurate_rnd+full_chroma_int';

const JPEG_RANGE_PIX_FORMATS = new Set([
	NodeAv.AV_PIX_FMT_YUVJ411P,
	NodeAv.AV_PIX_FMT_YUVJ420P,
	NodeAv.AV_PIX_FMT_YUVJ422P,
	NodeAv.AV_PIX_FMT_YUVJ440P,
	NodeAv.AV_PIX_FMT_YUVJ444P,
]);

/**
 * A custom `VideoSampleResource` backed by NodeAV's
 * [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html), which in turn is backed by FFmpeg's
 * [`AVFrame`](https://ffmpeg.org/doxygen/2.7/structAVFrame.html). You can use this resource to create `VideoSample`
 * instances that are directly backed by FFmpeg's `AVFrame` without data having to be copied. Since `AVFrame`s can
 * themselves be backed by data on the GPU, this enables zero-copy hardware-accelerated decode and encode paths.
 *
 * When using Electron, you can directly create `Frame` instances without the data having to leave the GPU. For more,
 * see [NodeAV's docs](https://seydx.github.io/node-av/api/lib/classes/Frame.html).
 *
 * When passed, the `Frame` is now owned by resource, meaning it takes care of closing the frame later. If you want to
 * keep a copy for your own use, clone the frame first.
 *
 * @group \@mediabunny/server
 * @public
 */
export class AvFrameVideoSampleResource extends VideoSampleResource {
	/** @internal */
	_frame: NodeAv.Frame | null;

	/**
	 * The NodeAV [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html) instance backing this resource.
	 * Access throws if the resource has already been closed.
	 */
	get frame() {
		if (!this._frame) {
			throw new Error('AvFrameVideoSampleResource has been closed.');
		}

		return this._frame;
	}

	constructor(frame: NodeAv.Frame) {
		super();

		if (!(frame instanceof NodeAv.Frame)) {
			throw new TypeError('frame must be a NodeAv.Frame.');
		}
		if (frame.getMediaType() !== NodeAv.AVMEDIA_TYPE_VIDEO) {
			throw new Error('AvFrameVideoSampleResource must be initialized with a video frame.');
		}

		this._frame = frame;
	}

	/** WebCodecs pixel format mapped from the underlying AvFrame, or `null` if unsupported. */
	getFormat(): VideoSamplePixelFormat | null {
		return toPixelFormat(this.frame.format as NodeAv.AVPixelFormat);
	}

	/** Coded frame width in pixels (may differ from display width when SAR ≠ 1). */
	getCodedWidth(): number {
		return this.frame.width;
	}

	/** Coded frame height in pixels (may differ from display height when SAR ≠ 1). */
	getCodedHeight(): number {
		return this.frame.height;
	}

	/** Display width after applying the sample aspect ratio. */
	getSquarePixelWidth(): number {
		if (this.frame.sampleAspectRatio.num > this.frame.sampleAspectRatio.den) {
			return Math.round(this.frame.width * this.frame.sampleAspectRatio.num / this.frame.sampleAspectRatio.den);
		} else {
			return this.frame.width;
		}
	}

	/** Display height after applying the sample aspect ratio. */
	getSquarePixelHeight(): number {
		if (
			this.frame.sampleAspectRatio.num > this.frame.sampleAspectRatio.den
			|| this.frame.sampleAspectRatio.num === 0 // FFmpeg uses 0:1 for an unknown aspect ratio
		) {
			return this.frame.height;
		} else {
			return Math.round(this.frame.height * this.frame.sampleAspectRatio.den / this.frame.sampleAspectRatio.num);
		}
	}

	/** Color space (primaries / transfer / matrix / full-range) of the underlying frame. */
	getColorSpace(): VideoSampleColorSpace {
		return new VideoSampleColorSpace({
			primaries: unmapColorPrimaries(this.frame.colorPrimaries) as VideoColorPrimaries | null,
			transfer: unmapTransferCharacteristics(this.frame.colorTrc) as VideoTransferCharacteristics | null,
			matrix: unmapMatrixCoefficients(this.frame.colorSpace) as VideoMatrixCoefficients | null,
			fullRange: this.frame.colorRange === NodeAv.AVCOL_RANGE_JPEG
				|| JPEG_RANGE_PIX_FORMATS.has(this.frame.format as NodeAv.AVPixelFormat)
				? true
				: this.frame.colorRange === NodeAv.AVCOL_RANGE_MPEG
					? false
					: null,
		});
	}

	/** Release the underlying AvFrame; after this call the resource is unusable. */
	close(): void {
		this.frame.free();
		this._frame = null;
	}

	/** Return one entry per plane (`data` + per-line `stride` in bytes). */
	getDataPlanes(): MaybePromise<VideoDataPlane[]> {
		assert(this.frame.data);

		return this.frame.data.map((data, i) => ({
			data: toUint8Array(data),
			stride: this.frame.linesize[i]!,
		}));
	}

	/** Convert the frame to a packed RGBA `VideoSample`. The `colorSpace` argument is currently unused. */
	async toRgbSample(
		init: SetRequired<VideoSampleInit, 'timestamp'>,
		// Will respect it when somebody complains
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		colorSpace: PredefinedColorSpace,
	): Promise<VideoSample> {
		const width = this.frame.width;
		const height = this.frame.height;

		// A separate ref so we can fill in unspecified color properties without changing the original frame
		const srcFrame = new NodeAv.Frame();
		srcFrame.alloc();
		srcFrame.ref(this.frame);

		const srcIsRgb = isRgbPixelFormat(srcFrame.format as NodeAv.AVPixelFormat);
		if (srcFrame.colorPrimaries === NodeAv.AVCOL_PRI_UNSPECIFIED) {
			srcFrame.colorPrimaries = NodeAv.AVCOL_PRI_BT709;
		}
		if (srcFrame.colorTrc === NodeAv.AVCOL_TRC_UNSPECIFIED) {
			srcFrame.colorTrc = srcIsRgb ? NodeAv.AVCOL_TRC_IEC61966_2_1 : NodeAv.AVCOL_TRC_BT709;
		}
		if (srcFrame.colorSpace === NodeAv.AVCOL_SPC_UNSPECIFIED) {
			srcFrame.colorSpace = srcIsRgb ? NodeAv.AVCOL_SPC_RGB : NodeAv.AVCOL_SPC_BT709;
		}
		if (srcFrame.colorRange === NodeAv.AVCOL_RANGE_UNSPECIFIED) {
			srcFrame.colorRange = srcIsRgb ? NodeAv.AVCOL_RANGE_JPEG : NodeAv.AVCOL_RANGE_MPEG;
		}

		const dstFrame = new NodeAv.Frame();
		dstFrame.alloc();
		dstFrame.width = width;
		dstFrame.height = height;
		dstFrame.format = fromPixelFormat('RGBA');
		dstFrame.allocBuffer();

		dstFrame.colorPrimaries = srcFrame.colorPrimaries;
		dstFrame.colorTrc = srcFrame.colorTrc;
		dstFrame.colorSpace = NodeAv.AVCOL_SPC_RGB;
		dstFrame.colorRange = NodeAv.AVCOL_RANGE_JPEG;

		// Left unconfigured on purpose: getContext/initContext ignore the frames' color properties and use BT.601
		const scaler = new NodeAv.SoftwareScaleContext();
		scaler.allocContext();
		scaler.setOption('sws_flags', 'bilinear');

		try {
			const ret = await scaler.scaleFrame(dstFrame, srcFrame);
			NodeAv.FFmpegError.throwIfError(ret, 'Scale frame');
		} finally {
			scaler.freeContext();
			srcFrame.free();
		}

		dstFrame.sampleAspectRatio = this.frame.sampleAspectRatio;

		return new VideoSample(new AvFrameVideoSampleResource(dstFrame), init);
	}
}

// Also applied to reffed frames: one taken straight from a filter graph would otherwise keep the color of the
// source it no longer resembles
export const applySampleColorToFrame = (sample: VideoSample, frame: NodeAv.Frame) => {
	frame.colorPrimaries = mapColorPrimaries(sample.colorSpace.primaries ?? 'unknown')
		?? NodeAv.AVCOL_PRI_UNSPECIFIED;
	frame.colorSpace = mapMatrixCoefficients(sample.colorSpace.matrix ?? 'unknown')
		?? NodeAv.AVCOL_SPC_UNSPECIFIED;
	frame.colorTrc = mapTransferCharacteristics(sample.colorSpace.transfer ?? 'unknown')
		?? NodeAv.AVCOL_TRC_UNSPECIFIED;
	frame.colorRange = sample.colorSpace.fullRange === false
		? NodeAv.AVCOL_RANGE_MPEG
		: sample.colorSpace.fullRange === true
			? NodeAv.AVCOL_RANGE_JPEG
			: NodeAv.AVCOL_RANGE_UNSPECIFIED;
};

export const copyVideoSampleToAvFrame = async (sample: VideoSample, frame: NodeAv.Frame, lastBuffer: Buffer | null) => {
	assert(sample.format !== null);

	frame.unref();

	const widenFrom12To16Bit = sample.format === 'I420AP12'; // Need to widen this because of the missing pixel format

	frame.format = widenFrom12To16Bit
		? NodeAv.AV_PIX_FMT_YUVA420P16LE
		: fromPixelFormat(sample.format);
	frame.width = sample.codedWidth;
	frame.height = sample.codedHeight;
	frame.sampleAspectRatio = new NodeAv.Rational(
		sample.pixelAspectRatio.num,
		sample.pixelAspectRatio.den,
	);
	applySampleColorToFrame(sample, frame);

	const size = sample.allocationSize();
	if (!lastBuffer || lastBuffer.byteLength !== size) {
		lastBuffer = Buffer.from({ length: size });
	}

	await sample.copyTo(lastBuffer);

	if (widenFrom12To16Bit) {
		const values = new Uint16Array(lastBuffer.buffer, lastBuffer.byteOffset, lastBuffer.byteLength / 2);
		for (let i = 0; i < values.length; i++) {
			values[i] = (values[i]! << 4) | (values[i]! >> 8);
		}
	}

	frame.fromBuffer(lastBuffer);

	return lastBuffer;
};

type FilterGraphEntry = {
	key: string;
	graph: NodeAv.FilterGraph;
	src: NodeAv.FilterContext;
	sink: NodeAv.FilterContext;
	busy: boolean;
};

// Building a graph costs about a third of what running it does, and every frame reuses the same chain
const FILTER_GRAPH_CACHE_SIZE = 16;
const filterGraphCache: FilterGraphEntry[] = [];

const buildFilterGraph = (srcArgs: string, chainString: string): FilterGraphEntry => {
	const graph = new NodeAv.FilterGraph();
	graph.alloc();

	try {
		const src = graph.createFilter(NodeAv.Filter.getByName('buffer')!, 'src', srcArgs);
		const sink = graph.createFilter(NodeAv.Filter.getByName('buffersink')!, 'sink');
		assert(src && sink);

		// The naming here looks inverted but matches FFmpeg's parse semantics: from the parsed chain's
		// perspective, its inputs are fed by the graph's existing outputs (the buffer src), and its outputs
		// feed the graph's existing inputs (the buffer sink).
		const outputs = NodeAv.FilterInOut.createList([{ name: 'in', filterCtx: src, padIdx: 0 }]);
		const inputs = NodeAv.FilterInOut.createList([{ name: 'out', filterCtx: sink, padIdx: 0 }]);

		const parseRet = graph.parsePtr(`[in]${chainString}[out]`, inputs, outputs);
		NodeAv.FFmpegError.throwIfError(parseRet, 'FilterGraph.parsePtr');

		NodeAv.FFmpegError.throwIfError(graph.configSync(), 'FilterGraph.config');

		return { key: `${srcArgs}|${chainString}`, graph, src, sink, busy: true };
	} catch (error) {
		graph.free();
		throw error;
	}
};

// Never waits: queueing on a busy graph would serialise independent transcodes
const takeIdleFilterGraph = (srcArgs: string, chainString: string): FilterGraphEntry | null => {
	const key = `${srcArgs}|${chainString}`;
	const index = filterGraphCache.findIndex(entry => entry.key === key && !entry.busy);
	if (index === -1) {
		return null;
	}

	const entry = filterGraphCache[index]!;
	entry.busy = true;

	filterGraphCache.splice(index, 1);
	filterGraphCache.push(entry);

	return entry;
};

const returnFilterGraph = (entry: FilterGraphEntry) => {
	if (filterGraphCache.length >= FILTER_GRAPH_CACHE_SIZE) {
		const evictIndex = filterGraphCache.findIndex(candidate => !candidate.busy);
		if (evictIndex === -1) {
			entry.graph.free();
			return;
		}

		filterGraphCache.splice(evictIndex, 1)[0]!.graph.free();
	}

	entry.busy = false;
	filterGraphCache.push(entry);
};

// Reuse without flushing is only sound because every filter built here is 1:1 and non-delaying; a
// buffering one would strand frames in the graph
const pushThroughFilterGraph = async (
	entry: FilterGraphEntry,
	sample: VideoSample,
	srcFrame: NodeAv.Frame,
): Promise<VideoSample> => {
	// Without KEEP_REF, the graph would take the frame's buffers away from the sample
	NodeAv.FFmpegError.throwIfError(
		await entry.src.buffersrcAddFrame(srcFrame, NodeAv.AV_BUFFERSRC_FLAG_KEEP_REF),
		'buffersrcAddFrame',
	);

	const dstFrame = new NodeAv.Frame();
	dstFrame.alloc();

	NodeAv.FFmpegError.throwIfError(await entry.sink.buffersinkGetFrame(dstFrame), 'buffersinkGetFrame');

	// A buffer source states matrix and range but has no option for primaries or transfer, so the graph
	// cannot carry them and the output comes back unspecified. Reading them off the source is only
	// possible because KEEP_REF left it intact.
	if (dstFrame.colorPrimaries === NodeAv.AVCOL_PRI_UNSPECIFIED) {
		dstFrame.colorPrimaries = srcFrame.colorPrimaries;
	}
	if (dstFrame.colorTrc === NodeAv.AVCOL_TRC_UNSPECIFIED) {
		dstFrame.colorTrc = srcFrame.colorTrc;
	}

	return new VideoSample(new AvFrameVideoSampleResource(dstFrame), {
		timestamp: sample.timestamp,
		duration: sample.duration,
		// Baked in by the filter graph:
		rotation: 0,
		flip: false,
		encodeOptions: sample.encodeOptions,
	});
};

export const transformVideoSample = async (
	sample: VideoSample,
	description: VideoSampleTransformationDescription,
): Promise<VideoSample | null> => {
	let srcFrame: NodeAv.Frame;
	let srcFrameOwned = false;

	if (sample._data instanceof AvFrameVideoSampleResource) {
		// buffersrcAddFrame unrefs what it is handed, which would empty the frame for every other
		// VideoSample cloned off this resource, so push a reference and let the graph consume that
		srcFrame = new NodeAv.Frame();
		srcFrame.alloc();
		srcFrameOwned = true;

		NodeAv.FFmpegError.throwIfError(srcFrame.ref(sample._data.frame), 'Frame.ref');
	} else {
		if (sample.format === null) {
			return null;
		}

		srcFrame = new NodeAv.Frame();
		srcFrame.alloc();
		srcFrameOwned = true;
	}

	// swscale's default with no flags is bicubic (bit-identical to `flags=bicubic`); lanczos holds fine
	// detail that bicubic softens, and `accurate_rnd` and `full_chroma_int` stop the chroma planes being
	// rounded and interpolated more coarsely than the luma. Measured against FFmpeg's own lanczos.
	// Build the filter chain. Order: square-pixel normalize -> rotate -> flip -> crop -> resize-with-fit.
	const chain: string[] = [];

	if (sample.squarePixelWidth !== sample.codedWidth || sample.squarePixelHeight !== sample.codedHeight) {
		chain.push(`scale=${sample.squarePixelWidth}:${sample.squarePixelHeight}:flags=${SCALE_FLAGS}`);
		chain.push('setsar=1');
	}

	if (description.rotation === 90) {
		chain.push('transpose=1');
	} else if (description.rotation === 180) {
		chain.push('transpose=1,transpose=1');
	} else if (description.rotation === 270) {
		chain.push('transpose=2');
	}

	if (description.flip) {
		chain.push('hflip');
	}

	chain.push(`crop=${Math.round(description.crop.width)}:${Math.round(description.crop.height)}`
		+ `:${Math.round(description.crop.left)}:${Math.round(description.crop.top)}`);

	if (description.fit === 'fill') {
		chain.push(`scale=${description.width}:${description.height}:flags=${SCALE_FLAGS}`);
	} else if (description.fit === 'contain') {
		chain.push(`scale=${description.width}:${description.height}`
			+ `:force_original_aspect_ratio=decrease:flags=${SCALE_FLAGS}`);
		chain.push(`pad=${description.width}:${description.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
	} else if (description.fit === 'cover') {
		chain.push(`scale=${description.width}:${description.height}`
			+ `:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS}`);
		chain.push(`crop=${description.width}:${description.height}`);
	}

	chain.push('setsar=1');

	try {
		// Inside the try, because a closed sample makes this throw and the frame still has to be
		// freed; everything below reads the copied frame, so it all moves in with it.
		if (srcFrameOwned && !(sample._data instanceof AvFrameVideoSampleResource)) {
			await copyVideoSampleToAvFrame(sample, srcFrame, null);
		}

		if (description.alpha === 'discard') {
			// Premultiplying the color by the alpha paints the frame onto black, after which the alpha plane can go
			const formatName = NodeAv.avGetPixFmtName(srcFrame.format as NodeAv.AVPixelFormat);
			assert(formatName);

			const opaqueFormatName = formatName
				.replace(/^yuva/, 'yuv')
				.replace(/^gbrap/, 'gbrp')
				.replace(/^ya8$/, 'gray')
				.replace(/^ya16/, 'gray16')
				.replace(/^(rgb|bgr)a64/, '$148')
				.replace(/^(rgb|bgr)a/, '$10')
				.replace(/^a(rgb|bgr)/, '0$1');

			if (opaqueFormatName !== formatName) {
				assert(NodeAv.avGetPixFmtFromName(opaqueFormatName) !== NodeAv.AV_PIX_FMT_NONE);
				chain.splice(-1, 0, 'premultiply=inplace=1', `format=${opaqueFormatName}`);
			}
		}

		// Matrix and range are libavfilter link properties, so a buffer source not stating them unstates them;
		// read off srcFrame here because buffersrcAddFrame below unrefs it
		const srcArgs = `video_size=${srcFrame.width}x${srcFrame.height}`
			+ `:pix_fmt=${srcFrame.format}`
			+ `:time_base=1/1000000`
			+ `:pixel_aspect=${sample.pixelAspectRatio.num}/${sample.pixelAspectRatio.den}`
			+ `:colorspace=${srcFrame.colorSpace}`
			+ `:range=${srcFrame.colorRange}`;

		const chainString = chain.join(',');

		const cached = takeIdleFilterGraph(srcArgs, chainString);
		const entry = cached ?? buildFilterGraph(srcArgs, chainString);

		try {
			return await pushThroughFilterGraph(entry, sample, srcFrame);
		} finally {
			if (cached) {
				cached.busy = false;
			} else {
				returnFilterGraph(entry);
			}
		}
	} finally {
		if (srcFrameOwned) {
			srcFrame.free();
		}
	}
};
