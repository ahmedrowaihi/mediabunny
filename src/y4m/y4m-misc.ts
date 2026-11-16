/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// YUV4MPEG2 (Y4M), which is a text header, then `FRAME\n` and a whole uncompressed picture, over and
// over. There is no index, no codec and no compression - a frame is exactly as many octets as its
// colour space says, so the file is walked by arithmetic rather than by parsing.
//
// The colour space is the only field that carries information: it fixes the chroma subsampling, the
// bit depth and therefore the size of every frame. A reader that guesses it reads the picture at the
// wrong stride and produces a sheared, colour-shifted image rather than an error.

/**
 * A Y4M colour space: its chroma subsampling and its bit depth.
 *
 * @group Codecs
 * @public
 */
export type Y4mColorSpace = {
	/** The Y4M tag itself, as it is written after `C` in the header. */
	tag: string;
	/** How many octets one sample takes: 1 up to 8 bits, 2 beyond. */
	bytesPerSample: number;
	/** How many bits of each sample carry picture. */
	bitDepth: number;
	/** How much narrower the chroma planes are than the luma one. */
	horizontalSubsampling: 1 | 2 | 4;
	/** How much shorter the chroma planes are than the luma one. */
	verticalSubsampling: 1 | 2;
	/** Two chroma planes, or none at all for monochrome. */
	planes: 1 | 3;
};

const colorSpace = (
	tag: string,
	bitDepth: number,
	horizontalSubsampling: 1 | 2 | 4,
	verticalSubsampling: 1 | 2,
	planes: 1 | 3 = 3,
): Y4mColorSpace => ({
	tag,
	bytesPerSample: bitDepth > 8 ? 2 : 1,
	bitDepth,
	horizontalSubsampling,
	verticalSubsampling,
	planes,
});

/**
 * Every colour space this library reads. The three 4:2:0 tags differ only in where the chroma samples
 * are sited, which changes nothing about the layout - `420jpeg` is centred, `420mpeg2` is left-sited
 * and `420paldv` alternates - so they share one entry each rather than one between them.
 */
export const Y4M_COLOR_SPACES: Y4mColorSpace[] = [
	colorSpace('420jpeg', 8, 2, 2),
	colorSpace('420mpeg2', 8, 2, 2),
	colorSpace('420paldv', 8, 2, 2),
	colorSpace('420', 8, 2, 2),
	colorSpace('411', 8, 4, 1),
	colorSpace('422', 8, 2, 1),
	colorSpace('444', 8, 1, 1),
	colorSpace('mono', 8, 1, 1, 1),
	colorSpace('420p10', 10, 2, 2),
	colorSpace('422p10', 10, 2, 1),
	colorSpace('444p10', 10, 1, 1),
	colorSpace('mono10', 10, 1, 1, 1),
	colorSpace('420p12', 12, 2, 2),
	colorSpace('422p12', 12, 2, 1),
	colorSpace('444p12', 12, 1, 1),
	colorSpace('mono12', 12, 1, 1, 1),
	colorSpace('420p16', 16, 2, 2),
	colorSpace('422p16', 16, 2, 1),
	colorSpace('444p16', 16, 1, 1),
	colorSpace('mono16', 16, 1, 1, 1),
];

/** @internal */
export const y4mColorSpaceOf = (tag: string): Y4mColorSpace | null =>
	Y4M_COLOR_SPACES.find(space => space.tag === tag) ?? null;

/**
 * How many octets one frame of this colour space takes at this size.
 *
 * The chroma planes are rounded UP: a 4:2:0 picture of odd width still has a chroma sample for the
 * last column, and sizing them down by truncation puts every frame after the first out of step.
 *
 * @internal
 */
export const y4mFrameSize = (space: Y4mColorSpace, width: number, height: number) => {
	const luma = width * height;
	if (space.planes === 1) {
		return luma * space.bytesPerSample;
	}

	const chromaWidth = Math.ceil(width / space.horizontalSubsampling);
	const chromaHeight = Math.ceil(height / space.verticalSubsampling);

	return (luma + 2 * chromaWidth * chromaHeight) * space.bytesPerSample;
};
