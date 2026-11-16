/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: shaka-packager packager/mpd/base/content_protection_element.h
 * https://github.com/shaka-project/shaka-packager
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/**
 * Generic descriptor for an XML element used when building DASH MPD output.
 * Mirrors shaka-packager's `Element` struct from `content_protection_element.h`.
 *
 * Used as input to {@link XmlNode.addElements} and as nested content inside
 * {@link ContentProtectionElement.subelements}.
 *
 * @group DASH
 * @public
 */
export type Element = {
	/** Element tag name. */
	name: string;
	/** Element attributes as key/value pairs. Insertion order is preserved on emit. */
	attributes: Map<string, string>;
	/** Text content of this element. Mutually exclusive with `subelements` per typical usage. */
	content: string;
	/** Nested child elements. Recursive. */
	subelements: Element[];
};

/**
 * `<ContentProtection>` element in the DASH MPD spec (ISO 23009-1:2012 MPD and
 * Segment Formats). One per DRM system (Widevine / PlayReady / FairPlay /
 * ClearKey, etc.). Mirrors shaka-packager's `ContentProtectionElement`.
 *
 * @group DASH
 * @public
 */
export type ContentProtectionElement = {
	/** `value` attribute. Optional — DRM-specific (e.g. Widevine version string). */
	value: string;
	/** `schemeIdUri` attribute. Required — typically `urn:uuid:<system-id>`. */
	schemeIdUri: string;
	/** Other attributes for this element (beyond `value` and `schemeIdUri`). */
	additionalAttributes: Map<string, string>;
	/** Nested child elements (e.g. `<cenc:pssh>`, `<mspr:pro>`). */
	subelements: Element[];
};
