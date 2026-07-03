/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/master_playlist.cc
 * Last synced with shaka commit: b1580dd (2026-05-06, fix(hls): emit EXT-X-MEDIA tags in command-line order).
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { EncryptionInfoEntry } from './hls-entries';
import type { MediaPlaylist } from './hls-media-playlist';
import { Tag } from './hls-tag';
import type { HlsCeaCaption } from './hls-types';

const DEFAULT_AUDIO_GROUP_ID = 'default-audio-group';
const DEFAULT_SUBTITLE_GROUP_ID = 'default-text-group';

/**
 * Maps to one row of the variant matrix in the HLS spec — pairing a video
 * rendition with at most one audio group and one subtitle group.
 */
interface Variant {
	audioGroupId?: string;
	subtitleGroupId?: string;
	audioCodecs: string[];
	subtitleCodecs: string[];
	maxAudioBitrate: number;
	avgAudioBitrate: number;
	haveInstreamClosedCaption: boolean;
}

const groupId = (p: MediaPlaylist): string => {
	const id = p.getGroupId();
	if (id) {
		return id;
	}
	switch (p.getStreamType()) {
		case 'audio':
			return DEFAULT_AUDIO_GROUP_ID;
		case 'subtitle':
			return DEFAULT_SUBTITLE_GROUP_ID;
		default:
			return '';
	}
};

const groupCodecs = (group: MediaPlaylist[]): string[] => {
	const codecs = new Set<string>();
	for (const p of group) {
		codecs.add(p.getCodec());
	}
	// Apple compatibility: drop `wvtt`; map `ttml` → `stpp.ttml.im1t`.
	codecs.delete('wvtt');
	if (codecs.delete('ttml')) {
		codecs.add('stpp.ttml.im1t');
	}
	// shaka's GetGroupCodecString returns a std::set — alphabetically sorted.
	return [...codecs].sort();
};

const groupMaxBitrate = (group: MediaPlaylist[]): number =>
	group.reduce((max, p) => Math.max(max, p.getMaxBitrate()), 0);

const groupAvgBitrate = (group: MediaPlaylist[]): number =>
	group.reduce((max, p) => Math.max(max, p.getAvgBitrate()), 0);

/**
 * Mirrors shaka's `BuildMediaTag`. Renders one `#EXT-X-MEDIA` tag for an
 * audio or subtitle rendition. Attribute order follows the HLS spec.
 */
const buildMediaTag = (
	p: MediaPlaylist,
	groupIdOverride: string,
	isDefault: boolean,
	isAutoselect: boolean,
	baseUrl: string,
): string => {
	const tag = new Tag('#EXT-X-MEDIA');

	switch (p.getStreamType()) {
		case 'audio':
			tag.addString('TYPE', 'AUDIO');
			break;
		case 'subtitle':
			tag.addString('TYPE', 'SUBTITLES');
			break;
		default:
			throw new Error(`Cannot build media tag for stream type ${p.getStreamType()}`);
	}

	tag.addQuotedString('URI', baseUrl + p.getFileName());
	tag.addQuotedString('GROUP-ID', groupIdOverride);

	const language = p.getLanguage();
	if (language) {
		tag.addQuotedString('LANGUAGE', language);
	}

	tag.addQuotedString('NAME', p.getName());

	tag.addString('DEFAULT', isDefault ? 'YES' : 'NO');
	if (isAutoselect) {
		tag.addString('AUTOSELECT', 'YES');
	}

	if (p.getStreamType() === 'subtitle' && p.isForcedSubtitle()) {
		tag.addString('FORCED', 'YES');
	}

	const characteristics = p.getCharacteristics();
	if (characteristics.length > 0) {
		tag.addQuotedString('CHARACTERISTICS', characteristics.join(','));
	}

	if (p.getStreamType() === 'audio') {
		// Spec: an ordered, slash-separated list of params. First is channel count.
		// Dolby EC3-JOC and AC4-IMSA/CBI use "n/JOC" or "n/IMSA" forms.
		if (p.getEC3JocComplexity() !== 0) {
			tag.addQuotedString('CHANNELS', `${p.getEC3JocComplexity()}/JOC`);
		} else if (p.getAC4ImsFlag() || p.getAC4CbiFlag()) {
			tag.addQuotedString('CHANNELS', `${p.getNumChannels()}/IMSA`);
		} else {
			tag.addQuotedString('CHANNELS', `${p.getNumChannels()}`);
		}
	}

	return tag.toString();
};

/**
 * Mirrors shaka's `BuildCeaMediaTag`. Renders one
 * `#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` tag for a registered CEA caption. All
 * captions share the `CC` group id.
 */
const buildCeaMediaTag = (caption: HlsCeaCaption): string => {
	const tag = new Tag('#EXT-X-MEDIA');
	tag.addString('TYPE', 'CLOSED-CAPTIONS');
	tag.addQuotedString('GROUP-ID', 'CC');
	tag.addQuotedString('NAME', caption.name);
	if (caption.language) {
		tag.addQuotedString('LANGUAGE', caption.language);
	}
	tag.addString('DEFAULT', (caption.isDefault ?? false) ? 'YES' : 'NO');
	tag.addString('AUTOSELECT', (caption.autoselect ?? true) ? 'YES' : 'NO');
	tag.addQuotedString('INSTREAM-ID', caption.channel);
	return tag.toString();
};

/**
 * Mirrors shaka's `BuildStreamInfTag`. Renders one `#EXT-X-STREAM-INF` for a
 * regular video or audio variant; `#EXT-X-I-FRAME-STREAM-INF` for I-frame-only.
 */
const buildStreamInfTag = (
	p: MediaPlaylist,
	variant: Variant,
	baseUrl: string,
): string => {
	const isIFrame = p.getStreamType() === 'videoIFramesOnly';
	const tagName = isIFrame ? '#EXT-X-I-FRAME-STREAM-INF' : '#EXT-X-STREAM-INF';
	const tag = new Tag(tagName);

	tag.addNumber('BANDWIDTH', p.getMaxBitrate() + variant.maxAudioBitrate);
	tag.addNumber('AVERAGE-BANDWIDTH', p.getAvgBitrate() + variant.avgAudioBitrate);

	const allCodecs: string[] = [p.getCodec()];
	for (const c of variant.audioCodecs) {
		allCodecs.push(c);
	}
	for (const c of variant.subtitleCodecs) {
		allCodecs.push(c);
	}
	tag.addQuotedString('CODECS', allCodecs.join(','));

	const supplementalCodec = p.getSupplementalCodec();
	const compatibleBrand = p.getCompatibleBrand();
	if (supplementalCodec && compatibleBrand) {
		tag.addQuotedString('SUPPLEMENTAL-CODECS', `${supplementalCodec}/${compatibleBrand}`);
	}

	const res = p.getDisplayResolution();
	if (res) {
		tag.addNumberPair('RESOLUTION', res.width, 'x', res.height);
		if (!isIFrame) {
			const fps = p.getFrameRate();
			if (fps > 0) {
				tag.addFloat('FRAME-RATE', fps);
			}
		}
		const videoRange = p.getVideoRange();
		if (videoRange) {
			tag.addString('VIDEO-RANGE', videoRange);
		}
	}

	if (!isIFrame) {
		if (variant.audioGroupId) {
			tag.addQuotedString('AUDIO', variant.audioGroupId);
		}
		if (variant.subtitleGroupId) {
			tag.addQuotedString('SUBTITLES', variant.subtitleGroupId);
		}
		if (variant.haveInstreamClosedCaption) {
			tag.addQuotedString('CLOSED-CAPTIONS', 'CC');
		} else {
			tag.addString('CLOSED-CAPTIONS', 'NONE');
		}
	}

	if (isIFrame) {
		tag.addQuotedString('URI', baseUrl + p.getFileName());
		return tag.toString();
	}
	return `${tag.toString()}\n${baseUrl}${p.getFileName()}`;
};

/**
 * Builds the cartesian variant matrix from registered audio/subtitle groups,
 * mirroring shaka's `BuildVariants`.
 */
const buildVariants = (
	audioGroups: Map<string, MediaPlaylist[]>,
	subtitleGroups: Map<string, MediaPlaylist[]>,
	haveInstreamClosedCaption: boolean,
): Variant[] => {
	const audioVariants: Variant[] = [];
	if (audioGroups.size === 0) {
		audioVariants.push({
			audioCodecs: [],
			subtitleCodecs: [],
			maxAudioBitrate: 0,
			avgAudioBitrate: 0,
			haveInstreamClosedCaption: false,
		});
	} else {
		for (const [id, group] of audioGroups) {
			audioVariants.push({
				audioGroupId: id,
				audioCodecs: groupCodecs(group),
				subtitleCodecs: [],
				maxAudioBitrate: groupMaxBitrate(group),
				avgAudioBitrate: groupAvgBitrate(group),
				haveInstreamClosedCaption: false,
			});
		}
	}

	const subtitleVariantParts: Array<{ id?: string; codecs: string[] }> = [];
	if (subtitleGroups.size === 0) {
		subtitleVariantParts.push({ codecs: [] });
	} else {
		for (const [id, group] of subtitleGroups) {
			subtitleVariantParts.push({ id, codecs: groupCodecs(group) });
		}
	}

	const merged: Variant[] = [];
	for (const a of audioVariants) {
		for (const s of subtitleVariantParts) {
			merged.push({
				audioGroupId: a.audioGroupId,
				subtitleGroupId: s.id,
				audioCodecs: a.audioCodecs,
				subtitleCodecs: s.codecs,
				maxAudioBitrate: a.maxAudioBitrate,
				avgAudioBitrate: a.avgAudioBitrate,
				haveInstreamClosedCaption,
			});
		}
	}
	return merged;
};

/**
 * Top-level `.m3u8` master playlist.
 *
 * Mirrors shaka-packager's
 * [`MasterPlaylist`](https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/master_playlist.cc):
 * register {@link MediaPlaylist}s via {@link MasterPlaylist.addPlaylist}, then
 * call {@link MasterPlaylist.build} to render the master playlist string.
 *
 * @group HLS
 * @public
 */
export class MasterPlaylist {
	/** @internal */
	private readonly playlists: MediaPlaylist[] = [];

	constructor(
		/** Master playlist render options. */
		private readonly opts: {
			/** Emit `#EXT-X-INDEPENDENT-SEGMENTS` near the top of the master playlist. */
			independentSegments?: boolean;
			/** Two-letter language code that flips an audio rendition to `DEFAULT=YES`. */
			defaultAudioLanguage?: string;
			/** Two-letter language code that flips a subtitle rendition to `DEFAULT=YES`. */
			defaultSubtitleLanguage?: string;
			/** Generator banner line (rendered immediately after `#EXTM3U`). */
			generatorBanner?: string;
			/** Collect every unique `#EXT-X-KEY` and emit `#EXT-X-SESSION-KEY` at the master level. */
			createSessionKeys?: boolean;
			/** CEA closed captions to register as `#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` renditions. */
			closedCaptions?: HlsCeaCaption[];
		} = {},
	) {}

	/** Register a {@link MediaPlaylist} as a video / audio / subtitle / I-frame rendition. */
	addPlaylist(p: MediaPlaylist): void {
		this.playlists.push(p);
	}

	/**
	 * Render the master playlist as a single string. Pass a `baseUrl` to prefix
	 * every segment / playlist URI with the given absolute or relative URL.
	 */
	build(opts: {
		/** Optional URL prefix prepended to every variant / rendition URI. */
		baseUrl?: string;
	} = {}): string {
		const baseUrl = opts.baseUrl ?? '';
		const lines: string[] = ['#EXTM3U'];
		if (this.opts.generatorBanner) {
			lines.push(this.opts.generatorBanner);
		}

		if (this.opts.independentSegments) {
			lines.push('');
			lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
		}

		if (this.opts.createSessionKeys) {
			// Mirror shaka: collect every EXT-X-KEY across registered playlists,
			// deduplicate by rendered tag, and emit each as #EXT-X-SESSION-KEY.
			const sessionKeys = new Set<string>();
			for (const p of this.playlists) {
				for (const entry of p.getEntries()) {
					if (entry instanceof EncryptionInfoEntry) {
						sessionKeys.add(entry.toString('#EXT-X-SESSION-KEY'));
					}
				}
			}
			for (const sessionKey of sessionKeys) {
				lines.push(sessionKey);
			}
		}

		// Emit #EXT-X-MEDIA in input order (shaka b1580dd); rebuild group map
		// after for buildVariants.
		type MediaTagInfo = {
			playlist: MediaPlaylist;
			groupId: string;
			isDefault: boolean;
			isAutoselect: boolean;
		};
		const audioTags: MediaTagInfo[] = [];
		const subtitleTags: MediaTagInfo[] = [];
		const videoPlaylists: MediaPlaylist[] = [];
		const iframePlaylists: MediaPlaylist[] = [];

		// First pass: classify playlists and capture their group ids. The
		// default/autoselect flags are assigned in the second pass below, after
		// sorting, so "first rendition per (group, language)" refers to the first
		// in the final output order.
		let hasIndex = true;
		for (const p of this.playlists) {
			hasIndex = hasIndex && p.hasIndex();
			switch (p.getStreamType()) {
				case 'audio':
					audioTags.push({ playlist: p, groupId: groupId(p), isDefault: false, isAutoselect: false });
					break;
				case 'subtitle':
					subtitleTags.push({ playlist: p, groupId: groupId(p), isDefault: false, isAutoselect: false });
					break;
				case 'video':
					videoPlaylists.push(p);
					break;
				case 'videoIFramesOnly':
					iframePlaylists.push(p);
					break;
			}
		}

		// Sort renditions before assigning default/autoselect. When every playlist
		// carries an index, order video / I-frame / audio / subtitle by it
		// (PlaylistOrderFn / MediaTagsOrderByIndexFn). Otherwise order audio and
		// subtitle by group id (MediaTagsOrderByGroupIdFn), matching shaka's
		// std::map ordering, and leave video / I-frame in input order.
		const byPlaylistIndex = (a: MediaPlaylist, b: MediaPlaylist): number =>
			a.getIndex() - b.getIndex();
		const byTagIndex = (a: MediaTagInfo, b: MediaTagInfo): number =>
			a.playlist.getIndex() - b.playlist.getIndex();
		const byTagGroupId = (a: MediaTagInfo, b: MediaTagInfo): number => {
			if (a.groupId < b.groupId) {
				return -1;
			}
			if (a.groupId > b.groupId) {
				return 1;
			}
			return 0;
		};
		if (hasIndex) {
			videoPlaylists.sort(byPlaylistIndex);
			iframePlaylists.sort(byPlaylistIndex);
			audioTags.sort(byTagIndex);
			subtitleTags.sort(byTagIndex);
		} else {
			audioTags.sort(byTagGroupId);
			subtitleTags.sort(byTagGroupId);
		}

		// Second pass: assign default/autoselect, iterating in the same order the
		// tags are emitted so "first rendition per (group, language)" refers to the
		// first in output order.
		//
		// Per HLS spec 4.3.4.1.1 Rendition Groups: a group MUST NOT have more than
		// one DEFAULT=YES member. We tag the first rendition in a group with a
		// particular language 'AUTOSELECT'; it is 'DEFAULT' too if the language
		// matches the configured default language.
		const audioGroupLanguages = new Map<string, Set<string>>();
		for (const t of audioTags) {
			// HLS Authoring Specification for Apple Devices §2.13: a DVS rendition
			// MUST be AUTOSELECT=YES, and never contributes to the per-language
			// default bookkeeping.
			if (t.playlist.isDvs()) {
				t.isAutoselect = true;
				continue;
			}
			const language = t.playlist.getLanguage();
			let languages = audioGroupLanguages.get(t.groupId);
			if (!languages) {
				languages = new Set<string>();
				audioGroupLanguages.set(t.groupId, languages);
			}
			if (!languages.has(language)) {
				t.isDefault = !!language && language === this.opts.defaultAudioLanguage;
				t.isAutoselect = true;
				languages.add(language);
			}
		}

		const subtitleGroupLanguages = new Map<string, Set<string>>();
		for (const t of subtitleTags) {
			const language = t.playlist.getLanguage();
			let languages = subtitleGroupLanguages.get(t.groupId);
			if (!languages) {
				languages = new Set<string>();
				subtitleGroupLanguages.set(t.groupId, languages);
			}
			if (!languages.has(language)) {
				t.isDefault = !!language && language === this.opts.defaultSubtitleLanguage;
				t.isAutoselect = true;
				languages.add(language);
			}
			if (t.playlist.isForcedSubtitle()) {
				t.isAutoselect = true;
			}
		}

		if (audioTags.length > 0) {
			lines.push('');
			for (const t of audioTags) {
				lines.push(buildMediaTag(t.playlist, t.groupId, t.isDefault, t.isAutoselect, baseUrl));
			}
		}

		if (subtitleTags.length > 0) {
			lines.push('');
			for (const t of subtitleTags) {
				lines.push(buildMediaTag(t.playlist, t.groupId, t.isDefault, t.isAutoselect, baseUrl));
			}
		}

		const audioGroups = new Map<string, MediaPlaylist[]>();
		for (const t of audioTags) {
			const list = audioGroups.get(t.groupId) ?? [];
			list.push(t.playlist);
			audioGroups.set(t.groupId, list);
		}
		const subtitleGroups = new Map<string, MediaPlaylist[]>();
		for (const t of subtitleTags) {
			const list = subtitleGroups.get(t.groupId) ?? [];
			list.push(t.playlist);
			subtitleGroups.set(t.groupId, list);
		}

		const closedCaptions = this.opts.closedCaptions ?? [];
		if (closedCaptions.length > 0) {
			lines.push('');
			for (const caption of closedCaptions) {
				lines.push(buildCeaMediaTag(caption));
			}
		}

		// Variant streams
		const variants = buildVariants(audioGroups, subtitleGroups, closedCaptions.length > 0);
		for (const variant of variants) {
			if (videoPlaylists.length === 0) {
				break;
			}
			lines.push('');
			for (const v of videoPlaylists) {
				lines.push(buildStreamInfTag(v, variant, baseUrl));
			}
		}

		// I-frame streams
		if (iframePlaylists.length > 0) {
			lines.push('');
			const empty: Variant = {
				audioCodecs: [],
				subtitleCodecs: [],
				maxAudioBitrate: 0,
				avgAudioBitrate: 0,
				haveInstreamClosedCaption: false,
			};
			for (const ip of iframePlaylists) {
				lines.push(buildStreamInfTag(ip, empty, baseUrl));
			}
		}

		// Audio-only master (no video, no subtitle).
		if (audioGroups.size > 0 && videoPlaylists.length === 0 && subtitleGroups.size === 0) {
			lines.push('');
			for (const [id, group] of audioGroups) {
				const variant: Variant = {
					audioGroupId: id,
					audioCodecs: [],
					subtitleCodecs: [],
					maxAudioBitrate: 0,
					avgAudioBitrate: 0,
					haveInstreamClosedCaption: false,
				};
				for (const p of group) {
					lines.push(buildStreamInfTag(p, variant, baseUrl));
				}
			}
		}

		return lines.join('\n') + '\n';
	}
}
