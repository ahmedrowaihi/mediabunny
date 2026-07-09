/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CBCS_HLS_METHOD, dashContentProtectionSpecs, hlsKeySpecs } from './crypto/manifest-protection';
import type { DrmSystem } from './crypto/manifest-protection';
import type { ProtectionScheme } from './crypto/subsample-generator';
import { resolveURL } from './dash/dash-misc';
import type { DashRational } from './dash/dash-misc';
import type {
	ContentProtection,
	DashDescriptor,
	Mpd,
	MpdAdaptationSet,
	MpdRepresentation,
	SegmentBase,
	SegmentList,
	SegmentTemplate,
} from './dash/dash-mpd-parser';
import { TRANSFER_FUNCTION_HLG, TRANSFER_FUNCTION_PQ } from './dash/dash-mpd-utils';
import { parseChannelCount } from './hls/hls-playlist-parser';
import type {
	HlsIFrameStream,
	HlsKey,
	HlsMap,
	HlsMasterPlaylist,
	HlsMediaPlaylistAst,
	HlsMediaRendition,
	HlsVariant,
} from './hls/hls-playlist-parser';
import { bytesToHexString } from './misc';
import type { Manifest, ManifestTransform } from './manifest';

// Transforms are pure — they return a new manifest and never mutate the input. Selective transforms
// (filters, targeted rewrites) keep every untouched node by reference via these helpers, so a derived
// variant differs from its base only along the edited spine. Transforms that touch every node they
// visit (drm, rebase, mapSegmentUrls) allocate unconditionally — there is nothing to share.

/** Map that returns the original array reference when no element changed. */
const mapShared = <T>(items: T[], fn: (item: T) => T): T[] => {
	let changed = false;
	const out = items.map((item) => {
		const next = fn(item);
		if (next !== item) {
			changed = true;
		}
		return next;
	});
	return changed ? out : items;
};

/** Filter that returns the original array reference when nothing was removed. */
const filterShared = <T>(items: T[], keep: (item: T) => boolean): T[] => {
	const out = items.filter(keep);
	return out.length === items.length ? items : out;
};

/**
 * Video dynamic range: standard, or one of the two HDR transfer functions.
 *
 * @group Manifest
 * @public
 */
export type VideoRange = 'SDR' | 'HLG' | 'PQ';

/**
 * A read-only, cross-format view of one selectable rendition (a DASH Representation or an HLS
 * variant), so a filter predicate can be written once against both formats.
 *
 * @group Manifest
 * @public
 */
export type Rendition = {
	/** Track kind. */
	kind: 'video' | 'audio' | 'text' | 'other';
	/** Full `codecs` string (e.g. `avc1.640028,mp4a.40.2`), or `null`. */
	codecs: string | null;
	/** Width in pixels (video), or `null`. */
	width: number | null;
	/** Height in pixels (video), or `null`. */
	height: number | null;
	/** Peak bitrate in bits/second, or `null`. */
	bandwidth: number | null;
	/** Frames per second, or `null`. */
	frameRate: number | null;
	/** Audio channel count, or `null`. */
	channels: number | null;
	/** Audio sample rate in Hz, or `null`. */
	sampleRate: number | null;
	/** BCP-47 language, or `null`. */
	language: string | null;
	/** Video dynamic range, or `null` when unsignaled. */
	videoRange: VideoRange | null;
};

/**
 * Keep-predicate for {@link filterRenditions}: returns `true` to keep a {@link Rendition}.
 *
 * @group Manifest
 * @public
 */
export type RenditionPredicate = (rendition: Rendition) => boolean;

const contentKind = (contentType: MpdAdaptationSet['contentType']): Rendition['kind'] => {
	if (contentType === 'video') {
		return 'video';
	}
	if (contentType === 'audio') {
		return 'audio';
	}
	if (contentType === 'text') {
		return 'text';
	}
	return 'other';
};

const rationalToFps = (rational: DashRational | null): number | null =>
	rational === null ? null : rational.numerator / rational.denominator;

/** CICP ChannelConfiguration index → channel count (ISO/IEC 23001-8 Table 8). */
const CICP_CHANNEL_COUNT: Record<number, number> = {
	1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8,
	9: 3, 10: 4, 11: 7, 12: 8, 13: 24, 14: 8, 15: 12, 16: 10, 17: 12, 18: 14, 19: 12, 20: 14,
};

/** Schemes whose `@value` is a hex channel mask (Dolby / DTS-UHD) rather than a count or index. */
const HEX_MASK_CHANNEL_SCHEME = /dolby\.com.*channel_configuration|dts\.com,2018/i;

const popcount = (n: number): number => {
	let count = 0;
	for (let v = n; v > 0; v >>>= 1) {
		count += v & 1;
	}
	return count;
};

/** Resolve one `<AudioChannelConfiguration>` descriptor to a channel count, per its scheme. */
const channelCountFromConfig = (config: { schemeIdUri: string; value: string }): number | null => {
	if (config.schemeIdUri.includes('cicp:ChannelConfiguration')) {
		return CICP_CHANNEL_COUNT[Number.parseInt(config.value, 10)] ?? null;
	}
	if (HEX_MASK_CHANNEL_SCHEME.test(config.schemeIdUri)) {
		const mask = Number.parseInt(config.value, 16);
		return Number.isNaN(mask) ? null : popcount(mask);
	}
	// urn:mpeg:dash:23003:3:audio_channel_configuration:2011, DTS-2014, and peers: plain decimal count.
	const count = Number.parseInt(config.value, 10);
	return Number.isNaN(count) ? null : count;
};

const resolveChannelCount = (configs: { schemeIdUri: string; value: string }[]): number | null => {
	for (const config of configs) {
		const count = channelCountFromConfig(config);
		if (count !== null) {
			return count;
		}
	}
	return null;
};

/** The CICP `TransferCharacteristics` value from the first such descriptor that carries one. */
const transferCharacteristics = (descriptors: DashDescriptor[]): number | null => {
	for (const descriptor of descriptors) {
		if (descriptor.value !== null && descriptor.schemeIdUri.includes('cicp:TransferCharacteristics')) {
			return Number.parseInt(descriptor.value, 10);
		}
	}
	return null;
};

/** Derive dynamic range from a DASH representation's (else its set's) CICP transfer characteristics. */
const dashVideoRange = (rep: MpdRepresentation, set: MpdAdaptationSet): VideoRange | null => {
	const value = transferCharacteristics(rep.essentialProperties)
		?? transferCharacteristics(rep.supplementalProperties)
		?? transferCharacteristics(set.essentialProperties)
		?? transferCharacteristics(set.supplementalProperties);
	if (value === TRANSFER_FUNCTION_PQ) {
		return 'PQ';
	}
	if (value === TRANSFER_FUNCTION_HLG) {
		return 'HLG';
	}
	return value === null ? null : 'SDR';
};

/** Normalize an HLS `VIDEO-RANGE` token to the {@link VideoRange} vocabulary. */
const normalizeVideoRange = (raw: string | null): VideoRange | null => {
	const upper = raw?.toUpperCase();
	if (upper === 'PQ' || upper === 'HLG' || upper === 'SDR') {
		return upper;
	}
	return null;
};

const dashRendition = (rep: MpdRepresentation, set: MpdAdaptationSet): Rendition => ({
	kind: contentKind(set.contentType),
	codecs: rep.codecs ?? set.codecs,
	width: rep.width,
	height: rep.height,
	bandwidth: rep.bandwidth,
	frameRate: rationalToFps(rep.frameRate ?? set.frameRate),
	channels: resolveChannelCount(rep.audioChannelConfigurations)
		?? resolveChannelCount(set.audioChannelConfigurations),
	sampleRate: rep.audioSamplingRate,
	language: set.lang,
	videoRange: dashVideoRange(rep, set),
});

const variantRendition = (variant: HlsVariant): Rendition => ({
	kind: 'video', // a STREAM-INF variant is the (usually muxed) main rendition
	codecs: variant.codecs,
	width: variant.resolution?.width ?? null,
	height: variant.resolution?.height ?? null,
	bandwidth: variant.bandwidth,
	frameRate: variant.frameRate,
	channels: parseChannelCount(variant.channels), // CHANNELS="6/JOC" → 6
	sampleRate: null,
	language: null, // language is on the audio media group, not the variant
	videoRange: normalizeVideoRange(variant.videoRange),
});

const iFrameRendition = (stream: HlsIFrameStream): Rendition => ({
	kind: 'video',
	codecs: stream.codecs,
	width: stream.resolution?.width ?? null,
	height: stream.resolution?.height ?? null,
	bandwidth: stream.bandwidth,
	frameRate: null,
	channels: null,
	sampleRate: null,
	language: null,
	videoRange: null,
});

const MEDIA_KIND: Record<HlsMediaRendition['type'], Rendition['kind']> = {
	'AUDIO': 'audio',
	'VIDEO': 'video',
	'SUBTITLES': 'text',
	'CLOSED-CAPTIONS': 'other',
};

const mediaRendition = (media: HlsMediaRendition): Rendition => ({
	kind: MEDIA_KIND[media.type],
	codecs: null,
	width: media.resolution?.width ?? null,
	height: media.resolution?.height ?? null,
	bandwidth: null,
	frameRate: null,
	channels: parseChannelCount(media.channels), // CHANNELS="6" → 6
	sampleRate: null,
	language: media.language,
	videoRange: null,
});

const filterMpd = (mpd: Mpd, keep: RenditionPredicate): Mpd => {
	const periods = mapShared(mpd.periods, (period) => {
		const adaptationSets = filterShared(
			mapShared(period.adaptationSets, (set) => {
				const representations = filterShared(set.representations, rep => keep(dashRendition(rep, set)));
				return representations === set.representations ? set : { ...set, representations };
			}),
			set => set.representations.length > 0,
		);
		return adaptationSets === period.adaptationSets ? period : { ...period, adaptationSets };
	});
	return periods === mpd.periods ? mpd : { ...mpd, periods };
};

/** Clear a variant's audio/video/subtitle group refs that no longer name a surviving `#EXT-X-MEDIA` group. */
const pruneGroupRefs = (variant: HlsVariant, groups: Set<string>): HlsVariant => {
	const dangling = (group: string | null): string | null => group !== null && !groups.has(group) ? null : group;
	const audioGroup = dangling(variant.audioGroup);
	const videoGroup = dangling(variant.videoGroup);
	const subtitlesGroup = dangling(variant.subtitlesGroup);
	if (
		audioGroup === variant.audioGroup
		&& videoGroup === variant.videoGroup
		&& subtitlesGroup === variant.subtitlesGroup
	) {
		return variant;
	}
	return { ...variant, audioGroup, videoGroup, subtitlesGroup };
};

const filterMaster = (playlist: HlsMasterPlaylist, keep: RenditionPredicate): HlsMasterPlaylist => {
	const media = filterShared(playlist.media, rendition => keep(mediaRendition(rendition)));
	const iFrameStreams = filterShared(playlist.iFrameStreams, stream => keep(iFrameRendition(stream)));
	let variants = filterShared(playlist.variants, variant => keep(variantRendition(variant)));
	if (media !== playlist.media) {
		// A dropped media group must not leave dangling variant references behind.
		const groups = new Set(media.map(rendition => rendition.groupId));
		variants = mapShared(variants, variant => pruneGroupRefs(variant, groups));
	}
	if (variants === playlist.variants && iFrameStreams === playlist.iFrameStreams && media === playlist.media) {
		return playlist;
	}
	return { ...playlist, variants, iFrameStreams, media };
};

/**
 * Keep only the renditions satisfying `keep`, across either format. DASH Representations are
 * filtered by their effective properties (own value, else the AdaptationSet's) and sets left
 * empty are pruned; an HLS master's variants and I-frame streams are filtered; an HLS media
 * playlist has no renditions and is returned unchanged. This is the core the quality atoms
 * ({@link dropCodecs}, {@link capResolution}, {@link filterBitrate}, …) compose.
 *
 * @group Manifest
 * @public
 */
export const filterRenditions = (keep: RenditionPredicate): ManifestTransform => (manifest) => {
	if (manifest.format === 'dash') {
		const mpd = filterMpd(manifest.mpd, keep);
		return mpd === manifest.mpd ? manifest : { format: 'dash', mpd };
	}
	if (manifest.playlist.kind === 'master') {
		const playlist = filterMaster(manifest.playlist, keep);
		return playlist === manifest.playlist ? manifest : { format: 'hls', playlist };
	}
	return manifest;
};

/** Does `codecs` name any fourcc in `wanted` (already lowercased)? Matches each entry's leading fourcc. */
const codecsInclude = (codecs: string | null, wanted: Set<string>): boolean => {
	if (codecs === null) {
		return false;
	}
	return codecs.split(',').some(entry => wanted.has(entry.trim().split('.')[0]!.toLowerCase()));
};

/**
 * Drop every rendition whose codec matches one of `fourccs` (e.g. `['hev1', 'hvc1']` to keep an
 * AVC-only ladder). Matching is per-fourcc, so a muxed HLS variant `CODECS="avc1,mp4a"` is dropped
 * if *either* fourcc is listed — pass the video fourccs you want gone, not audio ones.
 *
 * @group Manifest
 * @public
 */
export const dropCodecs = (fourccs: string[]): ManifestTransform => {
	const wanted = new Set(fourccs.map(c => c.toLowerCase()));
	return filterRenditions(rendition => !codecsInclude(rendition.codecs, wanted));
};

/**
 * Keep only renditions whose codec matches one of `fourccs` (e.g. `['avc1', 'mp4a']` for an
 * H.264/AAC-only ladder). Renditions with no codec info (subtitles) are kept.
 *
 * @group Manifest
 * @public
 */
export const keepCodecs = (fourccs: string[]): ManifestTransform => {
	const wanted = new Set(fourccs.map(c => c.toLowerCase()));
	return filterRenditions(rendition => rendition.codecs === null || codecsInclude(rendition.codecs, wanted));
};

/** An inclusive `[min, max]` numeric bound; omit a side to leave it open. @group Manifest @public */
export type RangeFilter = {
	/** Lower bound (inclusive), or open below when omitted. */
	min?: number;
	/** Upper bound (inclusive), or open above when omitted. */
	max?: number;
};

/** A resolution ceiling in pixels; omit a side to leave it open. @group Manifest @public */
export type ResolutionCap = {
	/** Maximum width in pixels, or unbounded when omitted. */
	maxWidth?: number;
	/** Maximum height in pixels, or unbounded when omitted. */
	maxHeight?: number;
};

/**
 * Drop video renditions above a resolution cap (audio/subtitle renditions are kept). Provide a
 * width and/or height ceiling — a rendition is kept when it has no height (non-video) or fits both.
 *
 * @group Manifest
 * @public
 */
export const capResolution = (limits: ResolutionCap): ManifestTransform => {
	const maxWidth = limits.maxWidth ?? Infinity;
	const maxHeight = limits.maxHeight ?? Infinity;
	return filterRenditions(r => r.height === null || ((r.width ?? 0) <= maxWidth && r.height <= maxHeight));
};

/**
 * Keep only renditions whose peak bitrate is within `[min, max]` bits/second (renditions with no
 * bitrate are kept). Omit a bound to leave it open.
 *
 * @group Manifest
 * @public
 */
export const filterBitrate = (range: RangeFilter): ManifestTransform => {
	const min = range.min ?? 0;
	const max = range.max ?? Infinity;
	return filterRenditions(r => r.bandwidth === null || (r.bandwidth >= min && r.bandwidth <= max));
};

/**
 * Keep only renditions whose frame rate is within `[min, max]` fps (renditions with no frame rate
 * are kept). Omit a bound to leave it open.
 *
 * @group Manifest
 * @public
 */
export const filterFramerate = (range: RangeFilter): ManifestTransform => {
	const min = range.min ?? 0;
	const max = range.max ?? Infinity;
	return filterRenditions(r => r.frameRate === null || (r.frameRate >= min && r.frameRate <= max));
};

/**
 * Keep only renditions whose audio channel count is within `[min, max]` (renditions with no channel
 * count — video, subtitles — are kept). Use it to drop surround audio for stereo-only targets, e.g.
 * `filterChannels({ max: 2 })`. Omit a bound to leave it open.
 *
 * @group Manifest
 * @public
 */
export const filterChannels = (range: RangeFilter): ManifestTransform => {
	const min = range.min ?? 0;
	const max = range.max ?? Infinity;
	return filterRenditions(r => r.channels === null || (r.channels >= min && r.channels <= max));
};

/**
 * Drop renditions whose video dynamic range is one of `ranges` — e.g. `dropByColorRange(['PQ',
 * 'HLG'])` to serve an SDR-only device an HDR-free ladder. Renditions with no signaled range (audio,
 * subtitles, unmarked SDR) are kept. The range comes from HLS `VIDEO-RANGE` or a DASH CICP
 * `TransferCharacteristics` property.
 *
 * @group Manifest
 * @public
 */
export const dropByColorRange = (ranges: VideoRange[]): ManifestTransform =>
	filterRenditions(r => r.videoRange === null || !ranges.includes(r.videoRange));

/**
 * Remove subtitle/text renditions. For DASH, drops AdaptationSets with `contentType="text"` or a
 * `<Role value="subtitle">`; for an HLS master, drops `#EXT-X-MEDIA:TYPE=SUBTITLES` renditions and
 * clears each variant's `SUBTITLES` group reference. Closed captions are left intact.
 *
 * @group Manifest
 * @public
 */
export const dropSubtitles = (): ManifestTransform => (manifest) => {
	if (manifest.format === 'dash') {
		const periods = mapShared(manifest.mpd.periods, (period) => {
			const adaptationSets = filterShared(
				period.adaptationSets,
				set => set.contentType !== 'text' && !set.roles.some(role => role.value === 'subtitle'),
			);
			return adaptationSets === period.adaptationSets ? period : { ...period, adaptationSets };
		});
		return periods === manifest.mpd.periods ? manifest : { format: 'dash', mpd: { ...manifest.mpd, periods } };
	}
	if (manifest.playlist.kind === 'master') {
		const master = manifest.playlist;
		const media = filterShared(master.media, rendition => rendition.type !== 'SUBTITLES');
		const variants = mapShared(master.variants, v =>
			v.subtitlesGroup === null ? v : { ...v, subtitlesGroup: null });
		if (media === master.media && variants === master.variants) {
			return manifest;
		}
		return { format: 'hls', playlist: { ...master, media, variants } };
	}
	return manifest;
};

const rebaseLevel = (urls: string[], parent: string): string[] =>
	urls.length === 0 ? urls : urls.map(url => resolveURL(url, parent));
const anchorOf = (resolved: string[], parent: string): string => resolved[0] ?? parent;

const rebaseMpd = (mpd: Mpd, base: string): Mpd => {
	// DASH resolves a level's BaseURL against its parent's resolved BaseURL (mpd → period → set → rep),
	// so resolve each level against the parent anchor — never `base` directly — to preserve the chain
	// (and keep an absolute ancestor's CDN). Sibling BaseURLs are failover alternatives; the first anchors.
	let sawBaseUrl = mpd.baseURLs.length > 0;
	const mpdBaseURLs = rebaseLevel(mpd.baseURLs, base);
	const mpdAnchor = anchorOf(mpdBaseURLs, base);
	const periods = mpd.periods.map((period) => {
		sawBaseUrl = sawBaseUrl || period.baseURLs.length > 0;
		const periodBaseURLs = rebaseLevel(period.baseURLs, mpdAnchor);
		const periodAnchor = anchorOf(periodBaseURLs, mpdAnchor);
		const adaptationSets = period.adaptationSets.map((set) => {
			sawBaseUrl = sawBaseUrl || set.baseURLs.length > 0;
			const setBaseURLs = rebaseLevel(set.baseURLs, periodAnchor);
			const setAnchor = anchorOf(setBaseURLs, periodAnchor);
			const representations = mapShared(set.representations, (rep) => {
				sawBaseUrl = sawBaseUrl || rep.baseURLs.length > 0;
				const baseURLs = rebaseLevel(rep.baseURLs, setAnchor);
				return baseURLs === rep.baseURLs ? rep : { ...rep, baseURLs };
			});
			return { ...set, baseURLs: setBaseURLs, representations };
		});
		return { ...period, baseURLs: periodBaseURLs, adaptationSets };
	});

	// With no BaseURL anywhere, segment templates resolve against the document URL; inject one so the
	// manifest still points at the original assets once served from elsewhere.
	return { ...mpd, baseURLs: sawBaseUrl ? mpdBaseURLs : [base], periods };
};

const rebaseHls = (manifest: Extract<Manifest, { format: 'hls' }>, base: string): Manifest => {
	const playlist = manifest.playlist;
	if (playlist.kind === 'master') {
		return {
			format: 'hls',
			playlist: {
				...playlist,
				variants: playlist.variants.map(v => ({ ...v, uri: resolveURL(v.uri, base) })),
				iFrameStreams: playlist.iFrameStreams.map(s => ({ ...s, uri: resolveURL(s.uri, base) })),
				media: mapShared(playlist.media, m =>
					m.uri === null ? m : { ...m, uri: resolveURL(m.uri, base) }),
			},
		};
	}
	return {
		format: 'hls',
		playlist: {
			...playlist,
			segments: playlist.segments.map(segment => ({
				...segment,
				uri: resolveURL(segment.uri, base),
				map: segment.map === null ? null : { ...segment.map, uri: resolveURL(segment.map.uri, base) },
				keys: mapShared(segment.keys, key =>
					key.uri === null ? key : { ...key, uri: resolveURL(key.uri, base) }),
			})),
		},
	};
};

/**
 * Resolve the manifest's relative URLs against `base` so it stays valid when served from a new
 * location. DASH `<BaseURL>` values are resolved level-by-level against their parent's resolved base
 * (preserving the mpd → period → set → rep chain and any absolute ancestor), and one is injected if
 * the manifest has none since segment templates resolve against it; HLS variant / rendition / segment
 * / init-map / key URIs are resolved directly. Absolute and opaque URIs (`https:`, `data:`, `skd:`)
 * are left unchanged, so the transform is idempotent.
 *
 * @group Manifest
 * @public
 */
export const rebaseManifest = (base: string): ManifestTransform => (manifest) => {
	if (manifest.format === 'dash') {
		return { format: 'dash', mpd: rebaseMpd(manifest.mpd, base) };
	}
	return rebaseHls(manifest, base);
};

/**
 * DRM signaling to inject with {@link drm}. Follows the CPIX tri-state model: a system absent from
 * `systems` gets no signaling; a listed system emits its scheme descriptor (and `<cenc:pssh>` /
 * `#EXT-X-KEY` when it carries a `pssh`).
 *
 * @group Manifest
 * @public
 */
export type DrmOptions = {
	/** Protection scheme for the DASH `mp4protection` descriptor. */
	scheme: ProtectionScheme;
	/** Default key id (16 bytes) → DASH `cenc:default_KID`. */
	defaultKid: Uint8Array;
	/** DRM systems to signal (by UUID, with their `pssh`). */
	systems: DrmSystem[];
	/** HLS FairPlay key URI (e.g. `skd://<kid>`); required to emit a FairPlay `#EXT-X-KEY`. */
	fairplayKeyUri?: string;
};

const dashContentProtections = (options: DrmOptions): ContentProtection[] =>
	dashContentProtectionSpecs({ scheme: options.scheme, defaultKid: options.defaultKid, systems: options.systems })
		.map((spec): ContentProtection => ({
			schemeIdUri: spec.schemeIdUri,
			value: spec.value,
			keyId: spec.defaultKid === null ? null : bytesToHexString(spec.defaultKid),
			psshBoxes: spec.pssh === null ? [] : [spec.pssh],
		}));

const hlsKeys = (options: DrmOptions): HlsKey[] =>
	hlsKeySpecs({ systems: options.systems, fairplayKeyUri: options.fairplayKeyUri })
		.map((spec): HlsKey => ({
			method: CBCS_HLS_METHOD,
			uri: spec.uri,
			iv: null,
			keyId: null,
			keyFormat: spec.keyFormat,
			keyFormatVersions: [1],
		}));

/**
 * Signal DRM on the manifest. For a DASH MPD, prepends `<ContentProtection>` descriptors (the
 * `mp4protection` scheme + `cenc:default_KID`, then one per system with a `<cenc:pssh>`) to every
 * AdaptationSet. For an HLS **media** playlist, sets one `#EXT-X-KEY` per system on every segment
 * (Widevine `data:` pssh, PlayReady `data:` PRO, FairPlay `skd:`) — a player ignores KEYFORMATs it
 * doesn't know, so one playlist serves every OS. An HLS master carries no keys and is unchanged.
 *
 * This is the parse → transform → serialize DRM path (it re-serializes the manifest). To inject DRM
 * into a manifest **string** without reparsing or reformatting it, use {@link patchMpdContentProtection}
 * / {@link patchMediaPlaylistKeys}; to signal DRM while **generating** a manifest from scratch, use
 * {@link buildContentProtections}.
 *
 * @group Manifest
 * @public
 */
export const drm = (options: DrmOptions): ManifestTransform => (manifest) => {
	if (manifest.format === 'dash') {
		const contentProtections = dashContentProtections(options);
		const periods = manifest.mpd.periods.map(period => ({
			...period,
			adaptationSets: period.adaptationSets.map(set => ({
				...set,
				contentProtections: [...contentProtections, ...set.contentProtections],
			})),
		}));
		return { format: 'dash', mpd: { ...manifest.mpd, periods } };
	}
	if (manifest.playlist.kind === 'media') {
		const keys = hlsKeys(options);
		if (keys.length === 0) {
			return manifest;
		}
		const segments = manifest.playlist.segments.map(segment => ({ ...segment, keys }));
		return { format: 'hls', playlist: { ...manifest.playlist, segments } };
	}
	return manifest;
};

/**
 * The role of a URL handed to a {@link mapSegmentUrls} mapper, so the mapping can depend on what the
 * URL points at.
 *
 * @group Manifest
 * @public
 */
export type SegmentUrlKind =
	/** A media segment (HLS segment line, DASH `SegmentTemplate@media` / `SegmentURL@media`). */
	| 'segment'
	/** An init segment (HLS `#EXT-X-MAP`, DASH `@initialization` / `Initialization@sourceURL`). */
	| 'init'
	/** An HLS `#EXT-X-STREAM-INF` variant playlist. */
	| 'variant'
	/** An HLS `#EXT-X-I-FRAME-STREAM-INF` playlist. */
	| 'iframe'
	/** An HLS `#EXT-X-MEDIA` rendition playlist (audio/subtitle group). */
	| 'rendition'
	/** A DASH `<BaseURL>`. */
	| 'baseUrl';

/**
 * URL rewriter for {@link mapSegmentUrls}: receives a URL, its {@link SegmentUrlKind}, and a per-kind
 * 0-based `index` (its position among URLs of that kind), and returns the replacement URL.
 *
 * @group Manifest
 * @public
 */
export type SegmentUrlMapper = (url: string, kind: SegmentUrlKind, index: number) => string;

const mapList = (urls: string[], kind: SegmentUrlKind, map: (url: string, kind: SegmentUrlKind) => string): string[] =>
	urls.length === 0 ? urls : urls.map(url => map(url, kind));

const mapHlsUrls = (
	playlist: HlsMasterPlaylist | HlsMediaPlaylistAst,
	map: (url: string, kind: SegmentUrlKind) => string,
): HlsMasterPlaylist | HlsMediaPlaylistAst => {
	if (playlist.kind === 'master') {
		return {
			...playlist,
			variants: playlist.variants.map(v => ({ ...v, uri: map(v.uri, 'variant') })),
			iFrameStreams: playlist.iFrameStreams.map(s => ({ ...s, uri: map(s.uri, 'iframe') })),
			media: mapShared(playlist.media, m => (m.uri === null ? m : { ...m, uri: map(m.uri, 'rendition') })),
		};
	}
	// A media playlist's `#EXT-X-MAP` is sticky (shared across segments), so rewrite each distinct map
	// object once and reuse it — one `'init'` call per init, `'segment'` calls in playback order.
	const rewrittenMaps = new Map<HlsMap, HlsMap>();
	const segments = playlist.segments.map((segment) => {
		let nextMap = segment.map;
		if (segment.map !== null) {
			let rewritten = rewrittenMaps.get(segment.map);
			if (rewritten === undefined) {
				rewritten = { ...segment.map, uri: map(segment.map.uri, 'init') };
				rewrittenMaps.set(segment.map, rewritten);
			}
			nextMap = rewritten;
		}
		return { ...segment, uri: map(segment.uri, 'segment'), map: nextMap };
	});
	return { ...playlist, segments };
};

const mapDashUrls = (mpd: Mpd, map: (url: string, kind: SegmentUrlKind) => string): Mpd => {
	const mapInit = (init: SegmentBase['initialization']): SegmentBase['initialization'] =>
		init === null || init.sourceURL === null ? init : { ...init, sourceURL: map(init.sourceURL, 'init') };
	const mapTemplate = (template: SegmentTemplate | null): SegmentTemplate | null => template === null
		? null
		: {
				...template,
				media: template.media === null ? null : map(template.media, 'segment'),
				initialization: template.initialization === null ? null : map(template.initialization, 'init'),
			};
	const mapSegmentList = (list: SegmentList | null): SegmentList | null => list === null
		? null
		: {
				...list,
				initialization: mapInit(list.initialization),
				segments: list.segments.map(segment => ({ ...segment, media: map(segment.media, 'segment') })),
			};
	const mapSegmentBase = (base: SegmentBase | null): SegmentBase | null =>
		base === null ? base : { ...base, initialization: mapInit(base.initialization) };

	return {
		...mpd,
		baseURLs: mapList(mpd.baseURLs, 'baseUrl', map),
		periods: mpd.periods.map(period => ({
			...period,
			baseURLs: mapList(period.baseURLs, 'baseUrl', map),
			adaptationSets: period.adaptationSets.map(set => ({
				...set,
				baseURLs: mapList(set.baseURLs, 'baseUrl', map),
				segmentTemplate: mapTemplate(set.segmentTemplate),
				segmentList: mapSegmentList(set.segmentList),
				representations: set.representations.map(rep => ({
					...rep,
					baseURLs: mapList(rep.baseURLs, 'baseUrl', map),
					segmentTemplate: mapTemplate(rep.segmentTemplate),
					segmentList: mapSegmentList(rep.segmentList),
					segmentBase: mapSegmentBase(rep.segmentBase),
				})),
			})),
		})),
	};
};

/**
 * Rewrite every media-referencing URL in the manifest through `map`, which receives the URL, its
 * {@link SegmentUrlKind}, and a per-kind 0-based `index` (its position in playback/document order
 * among URLs of that kind — so segments number 0, 1, 2, …). Covers HLS variant / rendition / segment
 * / init-map URIs and DASH `<BaseURL>` / SegmentTemplate / SegmentList / SegmentBase URLs. Key URIs
 * are left to {@link drm} / {@link rebaseManifest}. The transform is pure; `map` may carry side
 * effects (e.g. recording a segment→origin table keyed by `index`) — that is the caller's concern.
 *
 * @group Manifest
 * @public
 */
export const mapSegmentUrls = (map: SegmentUrlMapper): ManifestTransform => (manifest) => {
	const counters = new Map<SegmentUrlKind, number>();
	const indexed = (url: string, kind: SegmentUrlKind): string => {
		const index = counters.get(kind) ?? 0;
		counters.set(kind, index + 1);
		return map(url, kind, index);
	};
	if (manifest.format === 'dash') {
		return { format: 'dash', mpd: mapDashUrls(manifest.mpd, indexed) };
	}
	return { format: 'hls', playlist: mapHlsUrls(manifest.playlist, indexed) };
};

/**
 * Builder for {@link toSegmentTemplate}: given a single-file DASH representation, returns its
 * replacement `SegmentTemplate`, or `null` to leave it untouched.
 *
 * @group Manifest
 * @public
 */
export type SegmentTemplateBuilder = (representation: MpdRepresentation) => SegmentTemplate | null;

/**
 * Repackage single-file (`SegmentBase`) DASH Representations as `SegmentTemplate` + `SegmentTimeline`.
 * The timeline comes from the media file's `sidx`, which requires I/O — so the caller reads it and
 * returns the replacement `SegmentTemplate` from `build`; this transform does the pure AST swap
 * (`segmentBase → null`, install the template, drop the single-file `<BaseURL>`). `build` returns
 * `null` to leave a Representation untouched. HLS and non-`SegmentBase` Representations are unchanged.
 *
 * @group Manifest
 * @public
 */
export const toSegmentTemplate = (build: SegmentTemplateBuilder): ManifestTransform => (manifest) => {
	if (manifest.format !== 'dash') {
		return manifest;
	}
	const periods = mapShared(manifest.mpd.periods, (period) => {
		const adaptationSets = mapShared(period.adaptationSets, (set) => {
			const representations = mapShared(set.representations, (rep) => {
				if (rep.segmentBase === null) {
					return rep;
				}
				const template = build(rep);
				return template === null
					? rep
					: { ...rep, segmentBase: null, segmentTemplate: template, baseURLs: [] };
			});
			return representations === set.representations ? set : { ...set, representations };
		});
		return adaptationSets === period.adaptationSets ? period : { ...period, adaptationSets };
	});
	return periods === manifest.mpd.periods ? manifest : { format: 'dash', mpd: { ...manifest.mpd, periods } };
};
