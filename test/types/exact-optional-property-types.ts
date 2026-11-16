/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Compiled by test/node/exact-optional-property-types.test.ts under `exactOptionalPropertyTypes: true`,
// which none of this repo's own tsconfigs set. A consumer that does set it cannot pass what our own
// API hands back unless every optional field spells out `| undefined`: under that flag `?: T | null`
// accepts an absent property but refuses one explicitly set to undefined.
//
// Nothing here runs. It either compiles or it does not, and that is the assertion.

// From the BUILT declarations, not from src: this is the surface a consumer actually compiles
// against, and re-checking our own internals under a flag this repo does not adopt would fail on
// unrelated places where they assign an explicit undefined to a DOM type.
import type { VideoEncodingConfig, WideVideoColorSpaceInit } from '../../dist/mediabunny';

declare const fromTrack: VideoColorSpaceInit;

// What `await track.getColorSpace()` gives, where a wide one is wanted
export const wide: WideVideoColorSpaceInit = fromTrack;

// And the place a caller actually hits it: a source's colour passed straight into an encode
export const config: VideoEncodingConfig = {
	codec: 'avc',
	bitrate: 1e6,
	colorSpace: fromTrack,
};

// An explicit undefined, which is what the flag is about - distinct from the property being absent
export const explicitlyUndefined: WideVideoColorSpaceInit = {
	primaries: undefined,
	transfer: undefined,
	matrix: undefined,
	fullRange: undefined,
};
