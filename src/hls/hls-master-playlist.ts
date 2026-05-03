/*!
 * Ported from Shaka Packager, Copyright 2016 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/hls/base/master_playlist.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 *
 * TypeScript port: Copyright (c) 2026-present, contributors.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

import { EncryptionInfoEntry } from './hls-entries';
import type { MediaPlaylist } from './hls-media-playlist';
import { Tag } from './hls-tag';

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
	return [...codecs];
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
	}

	if (!isIFrame) {
		if (variant.audioGroupId) {
			tag.addQuotedString('AUDIO', variant.audioGroupId);
		}
		if (variant.subtitleGroupId) {
			tag.addQuotedString('SUBTITLES', variant.subtitleGroupId);
		}
		// CLOSED-CAPTIONS=NONE is shaka's default when no captions registered.
		tag.addString('CLOSED-CAPTIONS', 'NONE');
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
): Variant[] => {
	const audioVariants: Variant[] = [];
	if (audioGroups.size === 0) {
		audioVariants.push({
			audioCodecs: [],
			subtitleCodecs: [],
			maxAudioBitrate: 0,
			avgAudioBitrate: 0,
		});
	} else {
		for (const [id, group] of audioGroups) {
			audioVariants.push({
				audioGroupId: id,
				audioCodecs: groupCodecs(group),
				subtitleCodecs: [],
				maxAudioBitrate: groupMaxBitrate(group),
				avgAudioBitrate: groupAvgBitrate(group),
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
	private readonly playlists: MediaPlaylist[] = [];

	constructor(
		private readonly opts: {
			independentSegments?: boolean;
			defaultAudioLanguage?: string;
			defaultSubtitleLanguage?: string;
			generatorBanner?: string;
			createSessionKeys?: boolean;
		} = {},
	) {}

	addPlaylist(p: MediaPlaylist): void {
		this.playlists.push(p);
	}

	build(opts: { baseUrl?: string } = {}): string {
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

		const audioGroups = new Map<string, MediaPlaylist[]>();
		const subtitleGroups = new Map<string, MediaPlaylist[]>();
		const videoPlaylists: MediaPlaylist[] = [];
		const iframePlaylists: MediaPlaylist[] = [];

		for (const p of this.playlists) {
			switch (p.getStreamType()) {
				case 'audio': {
					const id = groupId(p);
					const list = audioGroups.get(id) ?? [];
					list.push(p);
					audioGroups.set(id, list);
					break;
				}
				case 'subtitle': {
					const id = groupId(p);
					const list = subtitleGroups.get(id) ?? [];
					list.push(p);
					subtitleGroups.set(id, list);
					break;
				}
				case 'video':
					videoPlaylists.push(p);
					break;
				case 'videoIFramesOnly':
					iframePlaylists.push(p);
					break;
			}
		}

		// Audio media tags
		if (audioGroups.size > 0) {
			lines.push('');
			for (const [id, group] of audioGroups) {
				for (let i = 0; i < group.length; i++) {
					const p = group[i]!;
					const isLanguageDefault = !!this.opts.defaultAudioLanguage
						&& p.getLanguage() === this.opts.defaultAudioLanguage;
					const isFirst = i === 0;
					const isDefault = this.opts.defaultAudioLanguage
						? isLanguageDefault
						: isFirst;
					lines.push(buildMediaTag(p, id, isDefault, true, baseUrl));
				}
			}
		}

		// Subtitle media tags
		if (subtitleGroups.size > 0) {
			lines.push('');
			for (const [id, group] of subtitleGroups) {
				for (let i = 0; i < group.length; i++) {
					const p = group[i]!;
					const isLanguageDefault = !!this.opts.defaultSubtitleLanguage
						&& p.getLanguage() === this.opts.defaultSubtitleLanguage;
					const isFirst = i === 0;
					const isDefault = this.opts.defaultSubtitleLanguage
						? isLanguageDefault
						: isFirst;
					lines.push(buildMediaTag(p, id, isDefault, true, baseUrl));
				}
			}
		}

		// Variant streams
		const variants = buildVariants(audioGroups, subtitleGroups);
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
				};
				for (const p of group) {
					lines.push(buildStreamInfTag(p, variant, baseUrl));
				}
			}
		}

		return lines.join('\n') + '\n';
	}
}
