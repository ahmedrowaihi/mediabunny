/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MalformedInputError } from './errors';
import type { ProtectionScheme } from './crypto/subsample-generator';
import type { ContentProtectionElement, Element } from './dash/dash-content-protection';
import { DASH_NS } from './dash/dash-misc';
import { ENCRYPTED_MP4_SCHEME, generateCencPsshElement, hexToUUID, parsePsshBoxData } from './dash/dash-mpd-utils';
import { collectNamespaceFromName } from './dash/dash-xml-node';
import { EncryptionInfoEntry } from './hls/hls-entries';
import type { HlsKey } from './hls/hls-playlist-parser';
import { assert, bytesToBase64, escapeXmlAttribute } from './misc';
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
	pssh?: Uint8Array | null | undefined;
	/** DASH `<ContentProtection value="...">` (e.g. a Widevine version string). */
	nameVersion?: string | null | undefined;
};

/** @internal */
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
	options: { scheme: string; defaultKid: Uint8Array; systems: readonly DrmSystem[] },
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
	/** CENC protection scheme, e.g. `'cbcs'` or `'cenc'`. */
	scheme: string;
	/** The 16-byte default key ID, emitted as `cenc:default_KID`. */
	defaultKid: Uint8Array;
	/** DRM systems to emit a descriptor for. Without any, only the Common Encryption descriptor is written. */
	drmSystems?: DrmSystem[] | null | undefined;
}): ContentProtectionElement[] => {
	const kidUuid = hexToUUID(options.defaultKid);
	if (kidUuid === null) {
		throw new MalformedInputError('default KID must be 16 bytes.');
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
	/** The 16-byte default key ID, emitted as `cenc:default_KID`. */
	defaultKid: Uint8Array;
	/** DRM systems to emit a descriptor for. Without any, only the Common Encryption descriptor is written. */
	drmSystems?: DrmSystem[] | null | undefined;
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
 * HLS encryption method for a `cenc` fMP4 stream: SAMPLE-AES-CTR.
 *
 * draft-pantos-hls-rfc8216bis 4.4.4.4 defines the two separately - SAMPLE-AES is the `cbcs` scheme,
 * SAMPLE-AES-CTR is `cenc` - and states that a client MAY support the latter. It is not Apple's: a
 * FairPlay stream is always `cbcs`. What needs it is Widevine or PlayReady over Common Encryption's
 * CTR scheme, which shaka and ExoPlayer both read.
 *
 * @group Encryption
 * @public
 */
export const CENC_HLS_METHOD = 'SAMPLE-AES-CTR' as const;

/**
 * The `#EXT-X-KEY` METHOD a protection scheme is signalled by.
 *
 * Throws for `cbc1` and `cens`: HLS defines a method for the CTR scheme and one for the CBC-with-
 * pattern scheme and nothing for the other two, so there is no honest value to write. Signalling
 * them as `cbcs` would tell a player to decrypt in a mode the media is not in.
 *
 * @group Encryption
 * @public
 */
export const hlsMethodForScheme = (scheme: ProtectionScheme): typeof CBCS_HLS_METHOD | typeof CENC_HLS_METHOD => {
	switch (scheme) {
		case 'cenc':
			return CENC_HLS_METHOD;
		case 'cbcs':
		case 'cbcs-apple-sample-aes':
			return CBCS_HLS_METHOD;
		default:
			throw new MalformedInputError(
				`HLS has no #EXT-X-KEY METHOD for the '${scheme}' protection scheme; it defines`
				+ ` ${CBCS_HLS_METHOD} for 'cbcs' and ${CENC_HLS_METHOD} for 'cenc' only.`,
			);
	}
};

/** One `#EXT-X-KEY` line under a stated METHOD. */
const buildHlsKeyLine = (
	method: typeof CBCS_HLS_METHOD | typeof CENC_HLS_METHOD,
	options: {
		uri: string;
		keyFormat: string;
		keyFormatVersions?: string | null | undefined;
		keyId?: string | null | undefined;
		iv?: string | null | undefined;
	},
): string => new EncryptionInfoEntry(
	method,
	options.uri,
	options.keyId ?? '',
	options.iv ?? '',
	options.keyFormat,
	options.keyFormatVersions ?? '',
).toString();

/**
 * Build an `#EXT-X-KEY` line for a `cbcs` (SAMPLE-AES) HLS media playlist.
 *
 * @group Encryption
 * @public
 */
export const buildCbcsHlsKey = (options: {
	/** `URI` the key is fetched from, e.g. an `skd://` or `data:` URI. */
	uri: string;
	/** `KEYFORMAT` naming the DRM system, e.g. `'com.apple.streamingkeydelivery'`. */
	keyFormat: string;
	/** `KEYFORMATVERSIONS`. Omitted when the system states none. */
	keyFormatVersions?: string | null | undefined;
	/** `KEYID` as a hex string. */
	keyId?: string | null | undefined;
	/** `IV` as a hex string. Omitted when each segment derives its own. */
	iv?: string | null | undefined;
}): string => buildHlsKeyLine(CBCS_HLS_METHOD, options);

/** @internal */
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
export const hlsKeySpecs = (options: {
	systems: readonly DrmSystem[];
	fairplayKeyUri?: string | null | undefined;
}): HlsKeySpec[] => {
	const specs: HlsKeySpec[] = [];
	for (const system of options.systems) {
		if (system.uuid === FAIRPLAY_SYSTEM_ID) {
			if (options.fairplayKeyUri == null) {
				throw new MalformedInputError(
					'FairPlay was requested but fairplayKeyUri is missing; HLS signals FairPlay as an skd: URI'
					+ ' and FairPlay has no pssh box to derive one from.',
				);
			}
			specs.push({ uri: options.fairplayKeyUri, keyFormat: 'com.apple.streamingkeydelivery' });
			continue;
		}
		if (system.pssh == null) {
			throw new MalformedInputError(
				`DRM system urn:uuid:${system.uuid} was requested but its pssh is missing; an HLS`
				+ ' #EXT-X-KEY URI is built from the pssh.',
			);
		}
		if (system.uuid === PLAYREADY_SYSTEM_ID) {
			const pro = parsePsshBoxData(system.pssh);
			if (pro === null) {
				throw new MalformedInputError(
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
export const buildHlsKeys = (options: {
	/** The DRM systems to signal, one `#EXT-X-KEY` line each. */
	systems: DrmSystem[];
	/** The `skd://` URI FairPlay's key is fetched from. Required when FairPlay is among the systems. */
	fairplayKeyUri?: string | null | undefined;
	/** The scheme the media is encrypted with, which decides the METHOD. Defaults to `'cbcs'`. */
	scheme?: ProtectionScheme | null | undefined;
}): string[] => {
	// Taken from the scheme rather than read back off the key: `HlsKey.method` is a plain string
	// because a parsed key may carry any method, including NONE.
	const method = hlsMethodForScheme(options.scheme ?? 'cbcs');

	return hlsKeysOf(options).map((key) => {
		// hlsKeySpecs gives every key a URI or throws, so this never fires; HlsKey.uri is nullable
		// because a parsed `METHOD=NONE` key carries none.
		assert(key.uri !== null);
		return buildHlsKeyLine(method, {
			uri: key.uri,
			keyFormat: key.keyFormat,
			keyFormatVersions: '1',
		});
	});
};

/**
 * The same keys {@link buildHlsKeys} writes, as {@link HlsKey} objects rather than `#EXT-X-KEY` lines.
 *
 * For a caller that assembles a playlist from the model and serializes it once at the end: taking the
 * lines from {@link buildHlsKeys} and parsing them back into keys is a round trip that this avoids.
 * Serializing what this returns gives exactly what {@link buildHlsKeys} returns, since that function
 * is now this one plus the serializer.
 *
 * `iv` and `keyId` are null: neither HLS method carries them here, taking the IV from each sample's
 * `senc` instead - and 4.4.4.4 says IV MUST NOT be present for SAMPLE-AES-CTR at all.
 *
 * @throws the same way {@link buildHlsKeys} does — a listed system that cannot be signalled is an
 * error, never a silently dropped key — and for a scheme HLS states no method for.
 *
 * @group Encryption
 * @public
 */
export const hlsKeysOf = (options: {
	/** The DRM systems to signal, one key each. */
	systems: readonly DrmSystem[];
	/** The `skd://` URI FairPlay's key is fetched from. Required when FairPlay is among the systems. */
	fairplayKeyUri?: string | null | undefined;
	/**
	 * The scheme the media is encrypted with, which decides the METHOD: `'cenc'` is signalled as
	 * SAMPLE-AES-CTR and `'cbcs'` as SAMPLE-AES. Defaults to `'cbcs'`, which is what this wrote
	 * unconditionally before - and what made a `cenc` stream's playlist contradict its own MPD.
	 */
	scheme?: ProtectionScheme | null | undefined;
}): HlsKey[] => {
	const method = hlsMethodForScheme(options.scheme ?? 'cbcs');

	// FairPlay Streaming is cbcs only, so a com.apple.streamingkeydelivery key under SAMPLE-AES-CTR
	// describes a stream no device can play. Refusing beats emitting it.
	if (method === CENC_HLS_METHOD && options.systems.some(system => system.uuid === FAIRPLAY_SYSTEM_ID)) {
		throw new MalformedInputError(
			'FairPlay cannot be signalled under the \'cenc\' scheme: FairPlay Streaming decrypts'
			+ ` ${CBCS_HLS_METHOD} (cbcs) only.`,
		);
	}

	return hlsKeySpecs(options).map((spec): HlsKey => ({
		method,
		uri: spec.uri,
		iv: null,
		keyId: null,
		keyFormat: spec.keyFormat,
		keyFormatVersions: [1],
	}));
};

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
