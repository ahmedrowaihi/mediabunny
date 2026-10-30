/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { WmPaceInfo } from './wm-pace-info';

const VARIANT_SCHEME_PREFIX = 'http://dashif.org/guidelines/watermarking_variant#';

/**
 * `@schemeIdUri` of the `EssentialProperty` that points at the watermarking sidecar file in a DASH
 * ingest manifest.
 *
 * @group Watermarking
 * @public
 */
export const WM_PACE_INFO_SCHEME_ID_URI = 'http://dashif.org/guidelines/watermarking_wmpaceinfo';

/**
 * `@schemeIdUri` of the `EssentialProperty` that marks a DASH ingest Adaptation Set or
 * Representation as carrying one A/B variant, for example `…/watermarking_variant#a`.
 *
 * @group Watermarking
 * @public
 */
export const variantSchemeIdUri = (variant: string): string => {
	if (!/^[a-z]$|^\d+$/.test(variant)) {
		throw new TypeError('A watermarking variant is a lower-case letter from "a" or a number from 0.');
	}
	return `${VARIANT_SCHEME_PREFIX}${variant}`;
};

/**
 * The variant a `watermarking_variant` `@schemeIdUri` identifies, or `null` for any other scheme.
 *
 * @group Watermarking
 * @public
 */
export const variantFromSchemeIdUri = (schemeIdUri: string): string | null => {
	if (!schemeIdUri.startsWith(VARIANT_SCHEME_PREFIX)) {
		return null;
	}
	const variant = schemeIdUri.slice(VARIANT_SCHEME_PREFIX.length);
	return variant.length > 0 ? variant : null;
};

/**
 * Where one variant's segments live on the origin, relative to the entry point shared by all
 * variants.
 *
 * @group Watermarking
 * @public
 */
export type WmVariantSubPath = {
	/** The variant's identity, numbered from 0 for variant A. */
	variant: number;
	/** The sub-path prefix the origin serves this variant under, such as `a`. */
	subPath: string;
};

/**
 * A watermarking sidecar describing segments addressed as discrete files.
 *
 * @group Watermarking
 * @public
 */
export type WmDiscreteSidecar = {
	/** Segments are individual files. */
	segmentType: 'discrete';
	/** The sub-path of every variant the sidecar covers. */
	variantSubPaths: WmVariantSubPath[];
	/** One entry per group of segments matching a filename pattern. */
	segments: {
		/** POSIX extended regular expression matching the filenames this entry applies to. */
		segmentRegex: string;
		/** The metadata those segments carry. */
		wmPaceInfo: WmPaceInfo;
	}[];
};

/**
 * A watermarking sidecar describing segments addressed as byte ranges of one file.
 *
 * @group Watermarking
 * @public
 */
export type WmByteRangeSidecar = {
	/** Segments are byte ranges within a track file. */
	segmentType: 'byterange';
	/** The sub-path of every variant the sidecar covers. */
	variantSubPaths: WmVariantSubPath[];
	/** One entry per byte range, which must cover the initialisation segment too. */
	segments: {
		/** First byte of the range, counted from the start of the track. */
		startRange: number;
		/** Last byte of the range, inclusive. */
		endRange: number;
		/** The metadata that range carries. */
		wmPaceInfo: WmPaceInfo;
	}[];
};

/** A watermarking sidecar in either addressing mode. @group Watermarking @public */
export type WmSidecar = WmDiscreteSidecar | WmByteRangeSidecar;

const wmPaceInfoJson = (info: WmPaceInfo) => ({
	version: 1,
	iswm: info.watermarked,
	variant: info.variant,
	pos: info.position,
	firstpart: info.firstPart,
	nbpart: info.partCount,
});

/**
 * Serialize a sidecar to the JSON the origin serves to the CDN edge. Field names follow the
 * specification rather than this library, so the output is interchange rather than our own shape.
 *
 * @group Watermarking
 * @public
 */
export const serializeWmSidecar = (sidecar: WmSidecar): string => {
	const variantSubPaths = sidecar.variantSubPaths.map(entry => ({
		variant: entry.variant,
		subPath: entry.subPath,
	}));
	if (sidecar.segmentType === 'discrete') {
		return JSON.stringify({
			segmentType: 'discrete',
			variantSubPaths,
			segments: sidecar.segments.map(entry => ({
				segmentRegex: entry.segmentRegex,
				WMPaceInfoObject: wmPaceInfoJson(entry.wmPaceInfo),
			})),
		});
	}
	return JSON.stringify({
		segmentType: 'byterange',
		variantSubPaths,
		segments: sidecar.segments.map(entry => ({
			startRange: entry.startRange,
			endRange: entry.endRange,
			WMPaceInfoObject: wmPaceInfoJson(entry.wmPaceInfo),
		})),
	});
};
