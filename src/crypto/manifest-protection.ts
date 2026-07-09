/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ContentProtectionElement, Element } from '../dash/dash-content-protection';
import { ENCRYPTED_MP4_SCHEME, generateCencPsshElement, hexToUUID, parsePsshBoxData } from '../dash/dash-mpd-utils';
import { EncryptionInfoEntry } from '../hls/hls-entries';
import { bytesToBase64 } from '../misc';
import { PLAYREADY_SYSTEM_ID } from './pssh';

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
 * One DASH `<ContentProtection>` descriptor in format-neutral form: what to signal, before it is
 * rendered into a concrete element type. `defaultKid` is set only on the `mp4protection` base
 * descriptor; `pssh` only on a per-system descriptor that carries one.
 *
 * @internal
 */
export type DrmContentProtectionSpec = {
	schemeIdUri: string;
	value: string | null;
	defaultKid: Uint8Array | null;
	pssh: Uint8Array | null;
};

/**
 * The single source of truth for DASH content-protection signaling: the `mp4protection` base
 * descriptor (protection scheme + default KID) followed by one per DRM system with its `pssh`.
 * FairPlay is skipped (DASH cannot signal it). Both the AST-transform {@link drm} atom and the
 * {@link buildContentProtections} generator render these specs into their own element types.
 *
 * @internal
 */
export const dashContentProtectionSpecs = (
	opts: { scheme: string; defaultKid: Uint8Array; systems: DrmSystem[] },
): DrmContentProtectionSpec[] => {
	const specs: DrmContentProtectionSpec[] = [{
		schemeIdUri: ENCRYPTED_MP4_SCHEME,
		value: opts.scheme,
		defaultKid: opts.defaultKid,
		pssh: null,
	}];
	for (const system of opts.systems) {
		if (system.uuid === FAIRPLAY_UUID) {
			continue;
		}
		specs.push({
			schemeIdUri: `urn:uuid:${system.uuid}`,
			value: system.nameVersion ?? null,
			defaultKid: null,
			pssh: system.pssh ?? null,
		});
	}
	return specs;
};

/**
 * Build the DASH `<ContentProtection>` descriptors for an encrypted stream: the base
 * `urn:mpeg:dash:mp4protection:2011` descriptor carrying the protection scheme (`value`) and
 * `cenc:default_KID`, followed by one per DRM system with a `<cenc:pssh>`. FairPlay is skipped (DASH
 * cannot signal it). Works for fMP4 (cbcs/cenc/cens/cbc1) and WebM (AES-CTR, signalled as `cenc`).
 * Mirrors shaka-packager's `AddContentProtectionElements`.
 *
 * This is the manifest-**generation** DRM path (build descriptors while assembling an MPD). To signal
 * DRM by transforming an already-parsed manifest, use the {@link drm} atom instead.
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
	const specs = dashContentProtectionSpecs({
		scheme: opts.scheme,
		defaultKid: opts.defaultKid,
		systems: opts.drmSystems ?? [],
	});
	return specs.map((spec): ContentProtectionElement => ({
		value: spec.value ?? '',
		schemeIdUri: spec.schemeIdUri,
		additionalAttributes: spec.defaultKid !== null
			? new Map([['cenc:default_KID', kidUuid]])
			: new Map<string, string>(),
		subelements: spec.pssh !== null ? [generateCencPsshElement(spec.pssh)] : [],
	}));
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
 * This is the format-preserving DRM path — it patches the MPD **string** in place, keeping the
 * origin's exact bytes and any elements the parser doesn't model. To parse, inject, and re-serialize
 * instead, use the {@link drm} atom.
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
 * One HLS `#EXT-X-KEY` in format-neutral form: the `URI` and `KEYFORMAT` to emit, before rendering
 * into a concrete `HlsKey` (the {@link drm} atom) or `#EXT-X-KEY` line ({@link buildHlsKeys}).
 *
 * @internal
 */
export type HlsKeySpec = {
	uri: string;
	keyFormat: string;
};

/**
 * The single source of truth for HLS multi-DRM key signaling (`cbcs` / SAMPLE-AES): one key per DRM
 * system — Widevine as a `data:` pssh, PlayReady as a `data:` PlayReady Object, FairPlay as the
 * `skd:` `fairplayKeyUri` (omitted if none given). A player ignores KEYFORMATs it doesn't know, so
 * one set serves every OS. Both the {@link drm} atom and {@link buildHlsKeys} render these specs.
 *
 * @internal
 */
export const hlsKeySpecs = (opts: { systems: DrmSystem[]; fairplayKeyUri?: string }): HlsKeySpec[] => {
	const specs: HlsKeySpec[] = [];
	for (const system of opts.systems) {
		if (system.uuid === FAIRPLAY_UUID) {
			if (opts.fairplayKeyUri !== undefined) {
				specs.push({ uri: opts.fairplayKeyUri, keyFormat: 'com.apple.streamingkeydelivery' });
			}
			continue;
		}
		if (system.pssh === undefined) {
			continue;
		}
		if (system.uuid === PLAYREADY_SYSTEM_ID) {
			// HLS carries the PlayReady Object (the pssh's data payload), not the full pssh box.
			const pro = parsePsshBoxData(system.pssh);
			if (pro !== null) {
				specs.push({
					uri: `data:text/plain;charset=UTF-16;base64,${bytesToBase64(pro)}`,
					keyFormat: 'com.microsoft.playready',
				});
			}
			continue;
		}
		specs.push({
			uri: `data:text/plain;base64,${bytesToBase64(system.pssh)}`,
			keyFormat: `urn:uuid:${system.uuid}`,
		});
	}
	return specs;
};

/**
 * Build the `#EXT-X-KEY` lines for a `cbcs` HLS media playlist carrying multi-DRM (one per DRM
 * system). The generate/patch-path counterpart to the {@link drm} atom's HLS keys; pair with
 * {@link patchMediaPlaylistKeys} to inject them into an existing playlist string.
 *
 * @group Encryption
 * @public
 */
export const buildHlsKeys = (opts: { systems: DrmSystem[]; fairplayKeyUri?: string }): string[] =>
	hlsKeySpecs(opts).map(spec =>
		buildCbcsHlsKey({ uri: spec.uri, keyFormat: spec.keyFormat, keyFormatVersions: '1' }),
	);

/**
 * Insert `#EXT-X-KEY` lines into an existing HLS media playlist, after the `#EXT-X-MAP`
 * (fMP4 init) if present, otherwise before the first segment tag. Preserves other lines verbatim.
 *
 * The HLS format-preserving DRM path — patches the playlist **string** in place. To parse, inject,
 * and re-serialize instead, use the {@link drm} atom.
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
