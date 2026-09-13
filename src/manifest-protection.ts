/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ContentProtectionElement, Element } from './dash/dash-content-protection';
import { DASH_NS } from './dash/dash-misc';
import { ENCRYPTED_MP4_SCHEME, generateCencPsshElement, hexToUUID, parsePsshBoxData } from './dash/dash-mpd-utils';
import { collectNamespaceFromName } from './dash/dash-xml-node';
import { EncryptionInfoEntry } from './hls/hls-entries';
import { bytesToBase64, escapeXmlAttribute } from './misc';
import { FAIRPLAY_SYSTEM_ID, PLAYREADY_SYSTEM_ID } from './crypto/pssh';

/**
 * One DRM system to signal in the encrypted copy's manifests.
 *
 * @group Encryption
 * @public
 */
export type DrmSystem = {
	/** System UUID (8-4-4-4-12, lowercase), e.g. {@link WIDEVINE_SYSTEM_ID}. */
	uuid: string;
	/**
	 * Serialized `pssh` box for the `<cenc:pssh>` DASH sub-element. Optional for DASH (the system
	 * still gets its `urn:uuid:` descriptor without one) and for FairPlay (which has no `pssh` box);
	 * required by every other system for HLS, whose `#EXT-X-KEY` URI is built from it.
	 */
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
	options: { scheme: string; defaultKid: Uint8Array; systems: DrmSystem[] },
): DrmContentProtectionSpec[] => {
	const specs: DrmContentProtectionSpec[] = [{
		schemeIdUri: ENCRYPTED_MP4_SCHEME,
		value: options.scheme,
		defaultKid: options.defaultKid,
		pssh: null,
	}];
	for (const system of options.systems) {
		if (system.uuid === FAIRPLAY_SYSTEM_ID) {
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
 * `cenc:default_KID`, followed by one per DRM system with a `<cenc:pssh>`. Works for fMP4
 * (cbcs/cenc/cens/cbc1) and WebM (AES-CTR, signalled as `cenc`). Mirrors shaka-packager's
 * `AddContentProtectionElements`.
 *
 * Defined behaviour, by system:
 * - FairPlay ({@link FAIRPLAY_SYSTEM_ID}) is **dropped**: FairPlay is delivered over HLS and has no DASH
 *   descriptor to emit. Passing it alongside other systems is normal (one {@link DrmSystem} list
 *   feeds both manifests); the returned array is simply one element shorter. Use
 *   {@link buildHlsKeys} to signal it.
 * - Any other system is always emitted, with or without a `pssh`; without one it gets its
 *   `urn:uuid:` descriptor and no `<cenc:pssh>` sub-element.
 *
 * This is the manifest-**generation** DRM path (build descriptors while assembling an MPD). To signal
 * DRM by transforming an already-parsed manifest, use the {@link drm} atom instead.
 *
 * @group Encryption
 * @public
 */
export const buildContentProtections = (options: {
	scheme: string;
	defaultKid: Uint8Array;
	drmSystems?: DrmSystem[];
}): ContentProtectionElement[] => {
	const kidUuid = hexToUUID(options.defaultKid);
	if (kidUuid === null) {
		throw new Error('default KID must be 16 bytes.');
	}
	const specs = dashContentProtectionSpecs({
		scheme: options.scheme,
		defaultKid: options.defaultKid,
		systems: options.drmSystems ?? [],
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
export const buildCbcsContentProtections = (options: {
	defaultKid: Uint8Array;
	drmSystems?: DrmSystem[];
}): ContentProtectionElement[] => buildContentProtections({ scheme: 'cbcs', ...options });

const serializeElement = (element: Element): string => {
	const attrs = [...element.attributes].map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`).join('');
	if (element.content === '' && element.subelements.length === 0) {
		return `<${element.name}${attrs}/>`;
	}
	const children = element.subelements.map(serializeElement).join('');
	return `<${element.name}${attrs}>${escapeXmlAttribute(element.content)}${children}</${element.name}>`;
};

/**
 * Serialize a `<ContentProtection>` descriptor to MPD XML (attribute order: schemeIdUri, value, rest).
 *
 * @group Encryption
 * @public
 */
export const serializeContentProtection = (cp: ContentProtectionElement): string => {
	let attrs = ` schemeIdUri="${escapeXmlAttribute(cp.schemeIdUri)}"`;
	if (cp.value !== '') {
		attrs += ` value="${escapeXmlAttribute(cp.value)}"`;
	}
	for (const [k, v] of cp.additionalAttributes) {
		attrs += ` ${k}="${escapeXmlAttribute(v)}"`;
	}
	if (cp.subelements.length === 0) {
		return `<ContentProtection${attrs}/>`;
	}
	return `<ContentProtection${attrs}>${cp.subelements.map(serializeElement).join('')}</ContentProtection>`;
};

const collectElementPrefixes = (element: Element, prefixes: Set<string>): void => {
	collectNamespaceFromName(element.name, prefixes);
	for (const name of element.attributes.keys()) {
		collectNamespaceFromName(name, prefixes);
	}
	element.subelements.forEach(child => collectElementPrefixes(child, prefixes));
};

/**
 * Inject `<ContentProtection>` descriptors as the first children of every `<AdaptationSet>` in an
 * existing MPD, and declare the namespaces they use (such as `xmlns:cenc`) on the `<MPD>` root when it
 * doesn't already. Idempotent-unsafe: call once per manifest. Preserves the surrounding text verbatim.
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

	const prefixes = new Set<string>();
	for (const element of elements) {
		for (const name of element.additionalAttributes.keys()) {
			collectNamespaceFromName(name, prefixes);
		}
		element.subelements.forEach(child => collectElementPrefixes(child, prefixes));
	}

	// A `cenc:default_KID` under a root that never declares `cenc` is not namespace-well-formed XML, and
	// strict parsers such as @xmldom/xmldom reject the whole document
	const withNamespaces = mpd.replace(/<MPD\b[^>]*>/, (root) => {
		const declarations = [...prefixes]
			.filter(prefix => prefix in DASH_NS && !new RegExp(`\\sxmlns:${prefix}\\s*=`).test(root))
			.map(prefix => ` xmlns:${prefix}="${DASH_NS[prefix as keyof typeof DASH_NS]}"`)
			.join('');
		return `${root.slice(0, -1)}${declarations}>`;
	});

	return withNamespaces.replace(/(<AdaptationSet\b[^>]*>)/g, `$1${xml}`);
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
export const buildCbcsHlsKey = (options: {
	uri: string;
	keyFormat: string;
	keyFormatVersions?: string;
	keyId?: string;
	iv?: string;
}): string => new EncryptionInfoEntry(
	CBCS_HLS_METHOD,
	options.uri,
	options.keyId ?? '',
	options.iv ?? '',
	options.keyFormat,
	options.keyFormatVersions ?? '',
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
 * `skd:` `fairplayKeyUri`. A player ignores KEYFORMATs it doesn't know, so one set serves every OS.
 * Both the {@link drm} atom and {@link buildHlsKeys} render these specs. Every listed system yields
 * a key or throws; a system is never dropped.
 *
 * @internal
 */
export const hlsKeySpecs = (options: { systems: DrmSystem[]; fairplayKeyUri?: string }): HlsKeySpec[] => {
	const specs: HlsKeySpec[] = [];
	for (const system of options.systems) {
		if (system.uuid === FAIRPLAY_SYSTEM_ID) {
			if (options.fairplayKeyUri === undefined) {
				throw new Error(
					'FairPlay was requested but fairplayKeyUri is missing; HLS signals FairPlay as an skd: URI'
					+ ' and FairPlay has no pssh box to derive one from.',
				);
			}
			specs.push({ uri: options.fairplayKeyUri, keyFormat: 'com.apple.streamingkeydelivery' });
			continue;
		}
		if (system.pssh === undefined) {
			throw new Error(
				`DRM system urn:uuid:${system.uuid} was requested but its pssh is missing; an HLS`
				+ ' #EXT-X-KEY URI is built from the pssh.',
			);
		}
		if (system.uuid === PLAYREADY_SYSTEM_ID) {
			// HLS carries the PlayReady Object (the pssh's data payload), not the full pssh box.
			const pro = parsePsshBoxData(system.pssh);
			if (pro === null) {
				throw new Error(
					'PlayReady pssh is not a parseable pssh box; HLS needs the PlayReady Object it carries.',
				);
			}
			specs.push({
				uri: `data:text/plain;charset=UTF-16;base64,${bytesToBase64(pro)}`,
				keyFormat: 'com.microsoft.playready',
			});
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
 * Every listed system yields exactly one key, or the whole call throws — signalling a system and
 * silently getting no key back would ship a playlist that declares no DRM.
 *
 * @throws when a listed system cannot be signalled: FairPlay without `fairplayKeyUri`, any
 * other system without a `pssh`, or a PlayReady `pssh` that is not a parseable `pssh` box.
 *
 * @group Encryption
 * @public
 */
export const buildHlsKeys = (options: { systems: DrmSystem[]; fairplayKeyUri?: string }): string[] =>
	hlsKeySpecs(options).map(spec =>
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
