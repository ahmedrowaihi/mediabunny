/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ContentProtectionElement, Element } from '../dash/dash-content-protection';
import { ENCRYPTED_MP4_SCHEME, generateCencPsshElement, hexToUUID } from '../dash/dash-mpd-utils';
import { EncryptionInfoEntry } from '../hls/hls-entries';

/**
 * Widevine system ID, absent from the fork's `DRM_UUIDS` (which omits it).
 *
 * @group Encryption
 * @public
 */
export const WIDEVINE_UUID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
/**
 * FairPlay system ID; DASH cannot signal it, HLS uses the streamingkeydelivery key format.
 *
 * @group Encryption
 * @public
 */
export const FAIRPLAY_UUID = '94ce86fb-07ff-4f43-adb8-93d2fa968ca2';

/**
 * One DRM system to signal in the encrypted copy's manifests.
 *
 * @group Encryption
 * @public
 */
export type DrmSystem = {
	/** System UUID (8-4-4-4-12, lowercase), e.g. {@link WIDEVINE_UUID}. */
	uuid: string;
	/** Serialized `pssh` box for the `<cenc:pssh>` DASH sub-element. */
	pssh?: Uint8Array;
	/** DASH `<ContentProtection value="...">` (e.g. a Widevine version string). */
	nameVersion?: string;
};

/**
 * Build the DASH `<ContentProtection>` descriptors for an encrypted stream: the base
 * `urn:mpeg:dash:mp4protection:2011` descriptor carrying the protection scheme (`value`) and
 * `cenc:default_KID`, followed by one per DRM system with a `<cenc:pssh>`. FairPlay is skipped (DASH
 * cannot signal it). Works for fMP4 (cbcs/cenc/cens/cbc1) and WebM (AES-CTR, signalled as `cenc`).
 * Mirrors shaka-packager's `AddContentProtectionElements`.
 *
 * @group Encryption
 * @public
 */
export const buildContentProtections = (opts: {
	scheme: string;
	defaultKid: Uint8Array;
	drmSystems?: DrmSystem[];
}): ContentProtectionElement[] => {
	const kidUuid = hexToUUID(opts.defaultKid);
	if (kidUuid === null) {
		throw new Error('default KID must be 16 bytes.');
	}

	const elements: ContentProtectionElement[] = [{
		value: opts.scheme,
		schemeIdUri: ENCRYPTED_MP4_SCHEME,
		additionalAttributes: new Map([['cenc:default_KID', kidUuid]]),
		subelements: [],
	}];

	for (const drm of opts.drmSystems ?? []) {
		if (drm.uuid === FAIRPLAY_UUID) {
			continue;
		}
		elements.push({
			value: drm.nameVersion ?? '',
			schemeIdUri: `urn:uuid:${drm.uuid}`,
			additionalAttributes: new Map(),
			subelements: drm.pssh !== undefined ? [generateCencPsshElement(drm.pssh)] : [],
		});
	}
	return elements;
};

/**
 * Build the DASH `<ContentProtection>` descriptors for a `cbcs` stream. Convenience wrapper over
 * {@link buildContentProtections}; WebM CTR streams should use `buildContentProtections({ scheme: 'cenc' })`.
 *
 * @group Encryption
 * @public
 */
export const buildCbcsContentProtections = (opts: {
	defaultKid: Uint8Array;
	drmSystems?: DrmSystem[];
}): ContentProtectionElement[] => buildContentProtections({ scheme: 'cbcs', ...opts });

const escapeXml = (text: string): string => text
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const serializeElement = (element: Element): string => {
	const attrs = [...element.attributes].map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
	if (element.content === '' && element.subelements.length === 0) {
		return `<${element.name}${attrs}/>`;
	}
	const children = element.subelements.map(serializeElement).join('');
	return `<${element.name}${attrs}>${escapeXml(element.content)}${children}</${element.name}>`;
};

/**
 * Serialize a `<ContentProtection>` descriptor to MPD XML (attribute order: schemeIdUri, value, rest).
 *
 * @group Encryption
 * @public
 */
export const serializeContentProtection = (cp: ContentProtectionElement): string => {
	let attrs = ` schemeIdUri="${escapeXml(cp.schemeIdUri)}"`;
	if (cp.value !== '') {
		attrs += ` value="${escapeXml(cp.value)}"`;
	}
	for (const [k, v] of cp.additionalAttributes) {
		attrs += ` ${k}="${escapeXml(v)}"`;
	}
	if (cp.subelements.length === 0) {
		return `<ContentProtection${attrs}/>`;
	}
	return `<ContentProtection${attrs}>${cp.subelements.map(serializeElement).join('')}</ContentProtection>`;
};

/**
 * Inject `<ContentProtection>` descriptors as the first children of every `<AdaptationSet>` in an
 * existing MPD. Idempotent-unsafe: call once per manifest. Preserves the surrounding text verbatim.
 *
 * @group Encryption
 * @public
 */
export const patchMpdContentProtection = (mpd: string, elements: ContentProtectionElement[]): string => {
	const xml = elements.map(serializeContentProtection).join('');
	return mpd.replace(/(<AdaptationSet\b[^>]*>)/g, `$1${xml}`);
};

/**
 * HLS encryption method for a `cbcs` fMP4 stream: SAMPLE-AES.
 *
 * @group Encryption
 * @public
 */
export const CBCS_HLS_METHOD = 'SAMPLE-AES' as const;

/**
 * Build an `#EXT-X-KEY` line for a `cbcs` (SAMPLE-AES) HLS media playlist.
 *
 * @group Encryption
 * @public
 */
export const buildCbcsHlsKey = (opts: {
	uri: string;
	keyFormat: string;
	keyFormatVersions?: string;
	keyId?: string;
	iv?: string;
}): string => new EncryptionInfoEntry(
	CBCS_HLS_METHOD,
	opts.uri,
	opts.keyId ?? '',
	opts.iv ?? '',
	opts.keyFormat,
	opts.keyFormatVersions ?? '',
).toString();

/**
 * Insert `#EXT-X-KEY` lines into an existing HLS media playlist, after the `#EXT-X-MAP`
 * (fMP4 init) if present, otherwise before the first segment tag. Preserves other lines verbatim.
 *
 * @group Encryption
 * @public
 */
export const patchMediaPlaylistKeys = (playlist: string, keyLines: string[]): string => {
	if (keyLines.length === 0) {
		return playlist;
	}
	const lines = playlist.split('\n');
	let insertAt = lines.findIndex(line => line.startsWith('#EXT-X-MAP'));
	if (insertAt >= 0) {
		insertAt += 1;
	} else {
		insertAt = lines.findIndex(line => line.startsWith('#EXTINF') || line.startsWith('#EXT-X-BYTERANGE'));
		if (insertAt < 0) {
			insertAt = lines.length;
		}
	}
	lines.splice(insertAt, 0, ...keyLines);
	return lines.join('\n');
};
