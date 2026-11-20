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
import type {
	AudioTrackMetadata,
	MpegTsOutputFormatOptions,
	SegmentedOutputFormatOptions,
	StatMuxOptions,
	StatMuxProgram,
	VideoEncodingConfig,
	VideoTrackMetadata,
	VideoTransformOptions,
	WideVideoColorSpaceInit,
} from '../../dist/mediabunny';
import type {
	BaseTrackMetadata,
	HlsOutputFormatOptions,
	SubtitlePlacement,
	hlsIFrameStream,
	hlsMasterPlaylist,
	hlsMediaPlaylist,
	hlsMediaRendition,
	hlsSegment,
	hlsVariant,
	mpd,
	mpdAdaptationSet,
	mpdBaseURL,
	SubtitleCue,
	SubtitleTextRun,
	VideoEncoderControls,
	mpdRepresentation,
	mpdSegmentList,
	mpdSegmentTemplate,
	buildPlayReadyPssh,
	chunksOf,
	pipeManifest,
	DrmOptions,
	MpdEventStream,
} from '../../dist/mediabunny';
import type { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../dist/mediabunny';

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

// The fields a caller builds from values that may legitimately be absent. An explicit `undefined` is
// the strictest form of that: under this flag it is refused unless the declaration spells out
// `| undefined`, and anything a consumer could pass instead is weaker. Values stay plain `undefined`
// rather than `T | undefined` locals, because this file is linted before `dist` exists, where a union
// over an unresolved import reads as `any` and fails the lint instead of this check.
declare const absent: undefined;

export const transform: VideoTransformOptions = {
	crop: absent,
	frameRate: absent,
};

export const videoMetadata: VideoTrackMetadata = {
	frameRate: absent,
	activeFormatDescription: absent,
	timecode: absent,
	decoderConfig: absent,
	closedCaptions: absent,
	dolbyVision: absent,
};

export const audioMetadata: AudioTrackMetadata = {
	decoderConfig: absent,
};

export const encoding: VideoEncodingConfig = {
	codec: 'avc',
	bitrate: 1e6,
	bitDepth: absent,
	colorSpace: absent,
	hdrStaticMetadata: absent,
	fullCodecString: absent,
	onEncodedPacket: absent,
};

export const mpegTs: MpegTsOutputFormatOptions = {
	privateStreams: absent,
	sampleAesEncryption: absent,
};

// Picked, so the format's own required fields are not what this is about
export const segmented: Pick<SegmentedOutputFormatOptions, 'partDuration'> = {
	partDuration: absent,
};

// Held readonly by the caller, so it needs no copy to be passed
export const statMux: Pick<StatMuxOptions, 'programs'> = {
	programs: [] as readonly StatMuxProgram[],
};

// The packet sources' metadata: its WebCodecs half states no `| undefined` of its own, so the
// intersection refused one however this library declared its side.
type VideoAddMeta = NonNullable<Parameters<EncodedVideoPacketSource['add']>[1]>;
type AudioAddMeta = NonNullable<Parameters<EncodedAudioPacketSource['add']>[1]>;

export const videoAddMeta: VideoAddMeta = {
	decoderConfig: absent,
	closedCaptions: absent,
};

export const audioAddMeta: AudioAddMeta = { decoderConfig: absent };

export const mpegTsBuilt: MpegTsOutputFormatOptions = {
	muxRate: absent,
	service: absent,
	dvbTime: absent,
	network: absent,
	scte35Pid: absent,
	timedMetadataPid: absent,
	privateStreams: absent,
};

// The manifest builders' option objects and the remaining metadata a caller assembles field by field.
// `Parameters<...>[0]` rather than a call, so nothing here is an unsafe call before `dist` exists.
export const iFrameStream: Parameters<typeof hlsIFrameStream>[0] = {
	uri: 'i.m3u8',
	bandwidth: 1,
	resolution: absent,
	videoRange: absent,
	supplementalCodecs: absent,
	reqVideoLayout: absent,
	pathwayId: absent,
	stableVariantId: absent,
};

export const mediaRendition: Parameters<typeof hlsMediaRendition>[0] = {
	type: 'AUDIO',
	groupId: 'a',
	name: 'English',
	uri: absent,
	language: absent,
	default: absent,
	autoselect: absent,
	instreamId: absent,
	characteristics: absent,
	channels: absent,
};

export const masterPlaylist: Parameters<typeof hlsMasterPlaylist>[0] = {
	variants: [],
	media: absent,
	independentSegments: absent,
	iFrameStreams: absent,
	sessionKeys: absent,
	start: absent,
	contentSteering: absent,
	imageStreams: absent,
};

export const segmentTemplate: Parameters<typeof mpdSegmentTemplate>[0] = { startNumber: absent };
export const segmentList: Parameters<typeof mpdSegmentList>[0] = {
	segments: [],
	initializationUri: absent,
};

export const trackMetadata: BaseTrackMetadata = { languageCode: absent };
export const hlsImage: Pick<HlsOutputFormatOptions, 'imageStream'> = { imageStream: absent };
export const placement: SubtitlePlacement = { textAlign: absent, writingMode: absent };

// The second inventory, including the inline-object fields a single-line sweep does not reach.
export const variantResolution: Parameters<typeof hlsVariant>[0] = {
	uri: 'v.m3u8',
	bandwidth: 1,
	resolution: absent,
};

export const segment: Parameters<typeof hlsSegment>[0] = {
	uri: 's.m4s',
	duration: 2,
	map: absent,
	programDateTime: absent,
	keys: absent,
	parts: absent,
	unknownTags: absent,
};

export const mediaPlaylist: Parameters<typeof hlsMediaPlaylist>[0] = {
	targetDuration: 2,
	segments: [],
	mediaSequence: absent,
	discontinuitySequence: absent,
	start: absent,
};

export const adaptationSet: Parameters<typeof mpdAdaptationSet>[0] = {
	representations: [],
	lang: absent,
};
export const presentation: Parameters<typeof mpd>[0] = {
	type: 'static',
	periods: [],
	profiles: absent,
	suggestedPresentationDelay: absent,
};
export const baseUrl: Parameters<typeof mpdBaseURL>[0] = {
	value: 'https://a/',
	serviceLocation: absent,
	dvbPriority: absent,
	dvbWeight: absent,
};

export const textRun: SubtitleTextRun = { text: 'a', color: absent };
export const cue: Pick<SubtitleCue, 'identifier' | 'settings'> = { identifier: absent, settings: absent };
export const controls: Pick<VideoEncoderControls, 'pass'> = { pass: absent };
export const audioMeta: Pick<AudioTrackMetadata, 'disposition'> = { disposition: absent };

// A consumer whose own code states absence as `null` rather than `undefined`, and which holds its
// arrays readonly. Each of these refused to compile before the fields below took `| null` and
// `readonly`, so every line is a call site the consumer had to write `?? undefined` or `[...x]` for.
declare const nothing: null;

export const nullableVariant: Parameters<typeof hlsVariant>[0] = {
	uri: 'v.m3u8',
	bandwidth: 1e6,
	averageBandwidth: nothing,
	resolution: nothing,
	frameRate: nothing,
	videoRange: nothing,
	codecs: nothing,
	audioGroup: nothing,
	subtitlesGroup: nothing,
	closedCaptionsGroup: nothing,
	supplementalCodecs: nothing,
	reqVideoLayout: nothing,
	pathwayId: nothing,
	stableVariantId: nothing,
};
export const nullableRendition: Parameters<typeof hlsMediaRendition>[0] = {
	type: 'AUDIO',
	groupId: 'a',
	name: 'en',
	language: nothing,
	channels: nothing,
	characteristics: nothing,
};
export const nullableIFrameStream: Parameters<typeof hlsIFrameStream>[0] = {
	uri: 'i.m3u8',
	bandwidth: 1e6,
	codecs: nothing,
};
export const nullableMasterPlaylist: Parameters<typeof hlsMasterPlaylist>[0] = {
	variants: [],
	start: nothing,
	sessionKeys: nothing,
	contentSteering: nothing,
};
export const nullableMediaPlaylist: Parameters<typeof hlsMediaPlaylist>[0] = {
	targetDuration: 2,
	segments: [],
	discontinuitySequence: nothing,
	start: nothing,
};
export const nullableRepresentation: Parameters<typeof mpdRepresentation>[0] = {
	id: 'r',
	bandwidth: 1e6,
	width: nothing,
	height: nothing,
	audioSamplingRate: nothing,
};
export const nullableAdaptationSet: Parameters<typeof mpdAdaptationSet>[0] = {
	representations: [],
	lang: nothing,
};
export const nullablePresentation: Parameters<typeof mpd>[0] = {
	type: 'static',
	periods: [],
	profiles: nothing,
	suggestedPresentationDelay: nothing,
};
export const nullableBaseUrl: Parameters<typeof mpdBaseURL>[0] = {
	value: 'https://a/',
	serviceLocation: nothing,
	dvbPriority: nothing,
	dvbWeight: nothing,
};
export const nullableMpegTs: MpegTsOutputFormatOptions = {
	sampleAesEncryption: nothing,
	scte35Pid: nothing,
	timedMetadataPid: nothing,
};
export const nullablePartDuration: Pick<SegmentedOutputFormatOptions, 'partDuration'> = {
	partDuration: nothing,
};
export const nullableCue: Pick<SubtitleCue, 'identifier'> = { identifier: nothing };
export const nullableCaptions: Pick<VideoTrackMetadata, 'closedCaptions'> = { closedCaptions: nothing };
export const nullableImageStream: Pick<HlsOutputFormatOptions, 'imageStream'> = { imageStream: nothing };
export const nullableTextRun: Pick<SubtitleTextRun, 'color'> = { color: nothing };
export const nullableSettings: Pick<SubtitleCue, 'settings'> = { settings: nothing };
export const nullableLaUrl: NonNullable<Parameters<typeof buildPlayReadyPssh>[1]> = { laUrl: nothing };
export const nullableChunkInit: Parameters<typeof chunksOf>[1] = nothing;

// Arrays a caller holds readonly, passed without copying.
declare const systems: readonly DrmOptions['systems'][number][];
declare const sessionKeys: readonly NonNullable<Parameters<typeof hlsMasterPlaylist>[0]['sessionKeys']>[number][];
declare const periods: readonly Parameters<typeof mpd>[0]['periods'][number][];
declare const events: readonly MpdEventStream['events'][number][];
declare const transforms: readonly Parameters<typeof pipeManifest>[1][number][];

export const drm: Pick<DrmOptions, 'systems'> = { systems };
export const readonlySessionKeys: Parameters<typeof hlsMasterPlaylist>[0] = { variants: [], sessionKeys };
export const readonlyPeriods: Parameters<typeof mpd>[0] = { type: 'static', periods };
export const readonlyEvents: Pick<MpdEventStream, 'events'> = { events };
export const readonlyTransforms: Parameters<typeof pipeManifest>[1] = transforms;
