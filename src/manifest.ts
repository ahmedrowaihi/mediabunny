/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseMpd } from './dash/dash-mpd-parser';
import type { Mpd, ParseMpdOptions } from './dash/dash-mpd-parser';
import { serializeMpd } from './dash/dash-mpd-serializer';
import { parseHlsPlaylist } from './hls/hls-playlist-parser';
import type { HlsPlaylist } from './hls/hls-playlist-parser';
import { serializeHls } from './hls/hls-serializer';

/**
 * A parsed adaptive-streaming manifest, discriminated by container format. Wraps
 * the format-specific ASTs ({@link Mpd} for DASH, {@link HlsPlaylist} for HLS) so
 * callers can parse, transform, and serialize either through one surface.
 *
 * @group Manifest
 * @public
 */
export type Manifest =
	| {
		/** Container format discriminator. */
		format: 'dash';
		/** The parsed DASH MPD AST. */
		mpd: Mpd;
	}
	| {
		/** Container format discriminator. */
		format: 'hls';
		/** The parsed HLS master or media playlist AST. */
		playlist: HlsPlaylist;
	};

/**
 * A pure manifest-to-manifest transform, composed with {@link pipeManifest}. Each pass returns a
 * new manifest, sharing every untouched subtree by reference — the input is never modified. So one
 * parsed base can spawn many variants cheaply and safely (no cloning, no aliasing surprises).
 *
 * @group Manifest
 * @public
 */
export type ManifestTransform = (manifest: Manifest) => Manifest;

/** Matches a DASH `<MPD>` root element, allowing an optional namespace prefix, at a tag boundary. */
const MPD_ROOT = /<(?:[\w.-]+:)?MPD[\s>/]/;

/**
 * Parse an HLS playlist or DASH MPD into a {@link Manifest}, sniffing the format
 * from the text: a leading `#EXTM3U` is HLS, an `<MPD>` root element is DASH. A
 * leading BOM and surrounding whitespace are stripped first so the sniff and the
 * underlying parser agree on where the document starts.
 *
 * DASH parsing needs a `DOMParser` — the global one, or `options.domParser` on
 * Node/Bun/Deno (e.g. linkedom's), matching {@link parseMpd}.
 *
 * @throws when the text matches neither format.
 * @group Manifest
 * @public
 */
export const parseManifest = (text: string, options?: ParseMpdOptions): Manifest => {
	const normalized = text.replace(/^\uFEFF/, '').trimStart();
	if (normalized.startsWith('#EXTM3U')) {
		return { format: 'hls', playlist: parseHlsPlaylist(normalized) };
	}
	if (MPD_ROOT.test(normalized)) {
		return { format: 'dash', mpd: parseMpd(normalized, options) };
	}
	throw new Error('Unrecognized manifest: expected an HLS playlist (#EXTM3U) or a DASH MPD (<MPD>).');
};

/**
 * Serialize a {@link Manifest} back to text, dispatching on format to
 * {@link serializeMpd} or {@link serializeHls}.
 *
 * @group Manifest
 * @public
 */
export const serializeManifest = (manifest: Manifest): string =>
	manifest.format === 'dash' ? serializeMpd(manifest.mpd) : serializeHls(manifest.playlist);

/**
 * Run a {@link Manifest} through an ordered list of {@link ManifestTransform}s,
 * threading each transform's output into the next.
 *
 * @group Manifest
 * @public
 */
export const pipeManifest = (manifest: Manifest, transforms: ManifestTransform[]): Manifest =>
	transforms.reduce((current, transform) => transform(current), manifest);
