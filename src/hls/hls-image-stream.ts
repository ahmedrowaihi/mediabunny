/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// An image stream is HLS trick play: a rendition of thumbnail sheets, each packing a grid of frames,
// that a player scrubs through instead of seeking the video. It is deliberately NOT a `Playlist` from
// the segment pipeline, and that is a design decision rather than a shortcut.
//
// A Playlist carries tracks, a segment format, an init segment, a muxer and a bitrate model. An image
// stream has none of those: its "segments" are whole files the caller already has, there is nothing to
// mux, no codec to declare beyond `jpeg`, and no init. Routing it through that machinery would mean a
// degenerate playlist with guards at every step for the case that has no tracks. What it does share -
// the live window, the media sequence, the eviction - is small enough to state here directly.
//
// The caller pushes a sheet whenever it has captured one. Everything else, including when the playlist
// is rewritten, follows from that.

import { assert } from '../misc';
import { Output } from '../output';
import { Writer } from '../writer';
import { serializeHls } from './hls-serializer';
import { hlsMediaPlaylist, hlsSegment, hlsTiles } from './hls-playlist-builder';

/**
 * The grid packed into one thumbnail sheet.
 *
 * @public
 * @group HLS
 */
export type HlsTileLayout = {
	/** Tiles across. */
	columns: number;
	/** Tiles down. */
	rows: number;
};

/**
 * What one pushed sheet states about itself.
 *
 * @public
 * @group HLS
 */
export type HlsImageSheetInfo = {
	/** The grid packed into this sheet. */
	layout: HlsTileLayout;
	/** The pixel size of one tile, which is what `RESOLUTION` reports. */
	tileResolution: {
		/** Tile width in pixels. */
		width: number;
		/** Tile height in pixels. */
		height: number;
	};
	/** Seconds one tile covers. */
	tileDuration: number;
};

/** Options for {@link HlsImageStreamSource}.
 *
 * @public
 * @group HLS
 */
export type HlsImageStreamSourceOptions = {
	/** Where the image media playlist is written, relative to the multivariant playlist. */
	path?: string;
	/**
	 * How a sheet's file is named, from its index. Defaults to `image0.jpg`, `image1.jpg` and so on.
	 */
	sheetPath?: (index: number) => string;
	/** The media type of a sheet. Defaults to `image/jpeg`. */
	mimeType?: string;
	/** `CODECS` on the master tag. Defaults to `jpeg`. */
	codecs?: string;
	/** The `VIDEO` rendition group this belongs to, where the output uses one. */
	videoGroup?: string;
};

/**
 * A trick-play rendition of thumbnail sheets, written alongside an HLS output.
 *
 * Hand it to {@link HlsOutputFormatOptions.imageStream} and push a sheet whenever one is captured. It
 * writes the sheet, keeps its own media playlist with `#EXT-X-TILES`, and the output writes an
 * `#EXT-X-IMAGE-STREAM-INF` into the multivariant playlist. The live window and expiry are the
 * output's, so the sheets roll off with the segments rather than growing without bound.
 *
 * @public
 * @group HLS
 */
export class HlsImageStreamSource {
	/** Where its media playlist is written. */
	readonly path: string;
	/** @internal */
	readonly _codecs: string;
	/** @internal */
	readonly _videoGroup: string | null;
	/** @internal */
	private readonly sheetPath: (index: number) => string;
	/** @internal */
	private readonly mimeType: string;
	/** @internal */
	private output: Output | null = null;
	/** @internal */
	private sheets: { path: string; duration: number; info: HlsImageSheetInfo; bytes: number }[] = [];
	/** @internal */
	private nextIndex = 0;
	/** @internal */
	private mediaSequence = 0;
	/** @internal */
	private windowSeconds: number | null = null;
	/** @internal */
	private ended = false;

	constructor(options: HlsImageStreamSourceOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.path !== undefined && (typeof options.path !== 'string' || options.path === '')) {
			throw new TypeError('options.path, when provided, must be a non-empty string.');
		}
		if (options.sheetPath !== undefined && typeof options.sheetPath !== 'function') {
			throw new TypeError('options.sheetPath, when provided, must be a function.');
		}
		if (options.mimeType !== undefined && typeof options.mimeType !== 'string') {
			throw new TypeError('options.mimeType, when provided, must be a string.');
		}
		if (options.codecs !== undefined && typeof options.codecs !== 'string') {
			throw new TypeError('options.codecs, when provided, must be a string.');
		}
		if (options.videoGroup !== undefined && typeof options.videoGroup !== 'string') {
			throw new TypeError('options.videoGroup, when provided, must be a string.');
		}

		this.path = options.path ?? 'thumbnails.m3u8';
		this.sheetPath = options.sheetPath ?? (index => `image${index}.jpg`);
		this.mimeType = options.mimeType ?? 'image/jpeg';
		this._codecs = options.codecs ?? 'jpeg';
		this._videoGroup = options.videoGroup ?? null;
	}

	/** @internal */
	_attach(output: Output, windowSeconds: number | null) {
		if (this.output) {
			throw new Error('This HlsImageStreamSource is already attached to an output.');
		}
		this.output = output;
		this.windowSeconds = windowSeconds;
	}

	/** Seconds of thumbnails currently listed. */
	get duration() {
		return this.sheets.reduce((total, sheet) => total + sheet.duration, 0);
	}

	/** Sheets currently listed, after any that have rolled out of the window. */
	get sheetCount() {
		return this.sheets.length;
	}

	/**
	 * `BANDWIDTH` for the master tag: the peak a sheet has demanded, which is what a player budgets
	 * for. Zero until a sheet has been pushed.
	 *
	 * @internal
	 */
	get _bandwidth() {
		let peak = 0;
		for (const sheet of this.sheets) {
			if (sheet.duration > 0) {
				peak = Math.max(peak, Math.round(sheet.bytes * 8 / sheet.duration));
			}
		}
		return peak;
	}

	/** The tile size of the most recent sheet, for `RESOLUTION` on the master tag. @internal */
	get _tileResolution() {
		return this.sheets[this.sheets.length - 1]?.info.tileResolution ?? null;
	}

	/**
	 * Writes one thumbnail sheet and adds it to the playlist.
	 *
	 * The sheet's own duration is `layout.columns * layout.rows * tileDuration` - every tile in the
	 * grid counts, which is what lets a player map a scrub position onto a tile without reading the
	 * image.
	 */
	async add(data: Uint8Array, info: HlsImageSheetInfo) {
		const output = this.output;
		if (!output) {
			throw new Error(
				'This HlsImageStreamSource is not attached to an output; pass it as the HLS output\'s'
				+ ' imageStream option.',
			);
		}
		if (this.ended) {
			throw new Error('The output has been finalized.');
		}
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		assertSheetInfo(info);

		const path = this.sheetPath(this.nextIndex++);
		const target = await output._getTarget({
			path,
			isRoot: false,
			mimeType: this.mimeType,
		});

		const writer = new Writer(target, true);
		writer.start();
		writer.write(data);
		await writer.flush();
		await writer.finalize();

		this.sheets.push({
			path,
			// Every tile in the grid, not the sheet as one picture
			duration: info.layout.columns * info.layout.rows * info.tileDuration,
			info,
			bytes: data.length,
		});

		this.evict();
		await this.writePlaylist(false);
	}

	/** @internal */
	async _finalize() {
		if (this.ended || !this.output) {
			return;
		}
		this.ended = true;
		if (this.sheets.length > 0) {
			await this.writePlaylist(true);
		}
	}

	/** Drops sheets that have fallen out of the live window, carrying the media sequence forward. */
	private evict() {
		if (this.windowSeconds === null) {
			return;
		}

		// One sheet of slack, the same as a segment window: a player partway through the oldest sheet
		// must still be able to fetch it
		while (this.sheets.length > 1 && this.duration - this.sheets[0]!.duration >= this.windowSeconds) {
			this.sheets.shift();
			this.mediaSequence++;
		}
	}

	/** @internal */
	private async writePlaylist(endlist: boolean) {
		const output = this.output;
		assert(output !== null);

		const text = serializeHls(hlsMediaPlaylist({
			segments: this.sheets.map(sheet => hlsSegment({
				uri: sheet.path,
				duration: sheet.duration,
				tiles: hlsTiles({
					resolution: sheet.info.tileResolution,
					layout: sheet.info.layout,
					duration: sheet.info.tileDuration,
				}),
			})),
			// A whole sheet is one resource, so the target duration is the longest of them
			targetDuration: Math.max(1, Math.ceil(Math.max(...this.sheets.map(sheet => sheet.duration), 0))),
			mediaSequence: this.mediaSequence,
			// Stated from the first write. Zero is what an absent tag already means, so this is not a
			// correctness fix - but this playlist exists in order to evict, and a number that is
			// written from the start never appears to arrive from nowhere when the first sheet rolls
			// off. A media playlist still omits it, which is what shaka-packager writes.
			alwaysStateMediaSequence: true,
			imagesOnly: true,
			endlist,
		}));

		const target = await output._getTarget({
			path: this.path,
			isRoot: false,
			mimeType: 'application/vnd.apple.mpegurl',
		});
		const writer = new Writer(target, true);
		writer.start();
		writer.write(new TextEncoder().encode(text));
		await writer.flush();
		await writer.finalize();
	}
}

const assertSheetInfo = (info: HlsImageSheetInfo) => {
	if (!info || typeof info !== 'object') {
		throw new TypeError('info must be an object.');
	}
	if (
		!info.layout || typeof info.layout !== 'object'
		|| !Number.isInteger(info.layout.columns) || info.layout.columns < 1
		|| !Number.isInteger(info.layout.rows) || info.layout.rows < 1
	) {
		// The spec's minimum grid is 1x1; a zero in either direction describes a sheet with no tiles
		throw new TypeError('info.layout must hold positive integer columns and rows.');
	}
	if (
		!info.tileResolution || typeof info.tileResolution !== 'object'
		|| !Number.isInteger(info.tileResolution.width) || info.tileResolution.width < 1
		|| !Number.isInteger(info.tileResolution.height) || info.tileResolution.height < 1
	) {
		throw new TypeError('info.tileResolution must hold positive integer width and height.');
	}
	if (!Number.isFinite(info.tileDuration) || info.tileDuration <= 0) {
		throw new TypeError('info.tileDuration must be a positive number.');
	}
};
