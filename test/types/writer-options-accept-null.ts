/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Every optional field of every public writer factory takes `null` as "absent", so a caller whose own
// code states absence as null can spread it straight in. Enumerating the fields would go stale the
// day one is added, so this asks the type system instead: `OptionalFieldsRejectingNull` collects the
// optional keys whose type does not admit null, and the assertion below only holds when that is
// `never`. When it is not, the compile error names the offending field.
//
// Compiled against the BUILT declarations by test/node/writer-options-accept-null.test.ts.

import type {
	hlsContentSteering, hlsDateRange, hlsIFrameStream, hlsImageStream, hlsKey, hlsMap,
	hlsMasterPlaylist, hlsMediaPlaylist, hlsMediaRendition, hlsPart, hlsPreloadHint,
	hlsRenditionReport, hlsSegment, hlsSessionData, hlsSkip, hlsStart, hlsTiles, hlsVariant,
	mpd, mpdAdaptationSet, mpdBaseURL, mpdContentSteering, mpdPeriod, mpdRepresentation,
	mpdSegmentBase, mpdSegmentList, mpdSegmentTemplate, mpdSegmentUrl, mpdServiceDescription,
} from '../../dist/mediabunny';

import type {
	CmafKeyPeriod, CmafTrackKey, DrmOptions, DrmSystem, EncryptCmafOptions, EncryptWebmOptions,
	WebmTrackKey,
} from '../../dist/mediabunny';

import type {
	Mpd, MpdAdaptationSet, MpdPeriod, MpdRepresentation, SegmentBase, SegmentList, SegmentTemplate,
} from '../../dist/mediabunny';

import type { DashContentProtectionEntry, DashProtectedContent } from '../../dist/mediabunny';

import type {
	ConversionOptions, ConversionSubtitleOptions, ConversionVideoOptions, VideoEncoderControls,
	VideoEncodingAdditionalOptions, VideoTrackMetadata, VideoTransformOptions,
} from '../../dist/mediabunny';
import type {
	DashOutputFormatOptions, FlacOutputFormatOptions, HlsOutputFormatOptions, IsobmffOutputFormatOptions,
	MkvOutputFormatOptions, MpegTsOutputFormatOptions, OggOutputFormatOptions, SegmentedOutputFormatOptions,
} from '../../dist/mediabunny';

type OptionalKeys<T> = {
	[K in keyof T]-?: Record<string, never> extends Pick<T, K> ? K : never;
}[keyof T];

type OptionalFieldsRejectingNull<T> = {
	[K in OptionalKeys<T>]-?: null extends T[K] ? never : K;
}[OptionalKeys<T>];

/** `true` when every optional field of `T` admits null; otherwise the names that do not. */
type EveryOptionalFieldAcceptsNull<T> = OptionalFieldsRejectingNull<T> extends never
	? true
	: OptionalFieldsRejectingNull<T>;

type OptionsOf<F> = F extends (options: infer O, ...rest: never[]) => unknown ? O : never;

/** Fails to compile when any optional field rejects null, naming it. */
type Assert<T extends true> = T;

export type HlsVariantAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsVariant>>>;
export type HlsMediaRenditionAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsMediaRendition>>>;
export type HlsSegmentAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsSegment>>>;
export type HlsPartAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsPart>>>;
export type HlsMasterPlaylistAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsMasterPlaylist>>>;
export type HlsMediaPlaylistAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsMediaPlaylist>>>;
export type HlsKeyAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsKey>>>;
export type HlsMapAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsMap>>>;
export type HlsStartAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsStart>>>;
export type HlsSessionDataAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsSessionData>>>;
export type HlsContentSteeringAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsContentSteering>>>;
export type HlsSkipAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsSkip>>>;
export type HlsRenditionReportAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsRenditionReport>>>;
export type HlsPreloadHintAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsPreloadHint>>>;
export type HlsDateRangeAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsDateRange>>>;
export type HlsIFrameStreamAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsIFrameStream>>>;
export type HlsImageStreamAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsImageStream>>>;
export type HlsTilesAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof hlsTiles>>>;
export type MpdSegmentListAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdSegmentList>>>;
export type MpdSegmentTemplateAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdSegmentTemplate>>>;
export type MpdRepresentationAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdRepresentation>>>;
export type MpdAdaptationSetAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdAdaptationSet>>>;
export type MpdPeriodAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdPeriod>>>;
export type MpdAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpd>>>;
export type MpdServiceDescriptionAcceptsNull =
	Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdServiceDescription>>>;
export type MpdBaseURLAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdBaseURL>>>;
export type MpdContentSteeringAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdContentSteering>>>;

// The output format option bags, minus the fields that are upstream's own. Those deliberately keep
// `?: T | undefined`: widening one makes it a fork line recorded in the deletion guard and carried
// across every rebase, and the consumer decided their own conversion is cheaper than that. Naming
// them here is what keeps the exception deliberate - a NEW fork-added field gets checked
// automatically, because only these names are excluded.
type UpstreamOwned<T, K extends keyof T> = Omit<T, K>;

export type IsobmffOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	IsobmffOutputFormatOptions,
	'fastStart' | 'minimumFragmentDuration' | 'metadataFormat' | 'onFtyp' | 'onMoov' | 'onMdat' | 'onMoof'
>>>;
export type MkvOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	MkvOutputFormatOptions,
	'appendOnly' | 'minimumClusterDuration' | 'onEbmlHeader' | 'onSegmentHeader' | 'onCluster'
>>>;
export type OggOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	OggOutputFormatOptions, 'maximumPageDuration' | 'onPage'
>>>;
export type FlacOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	FlacOutputFormatOptions, 'appendOnly' | 'onFrame'
>>>;
export type MpegTsOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	MpegTsOutputFormatOptions, 'timestampOffset' | 'onPacket'
>>>;
/** The segmented options upstream owns; the HLS and DASH bags extend that type and inherit them. */
type SegmentedUpstreamFields =
	'targetDuration' | 'singleFilePerPlaylist' | 'live' | 'maxLiveSegmentCount' | 'mediaTimestampBase'
	| 'getPlaylistPath' | 'getSegmentPath' | 'getInitPath' | 'onSegmentPopped' | 'onSegment' | 'onInit';

export type SegmentedOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	SegmentedOutputFormatOptions, SegmentedUpstreamFields
>>>;
export type HlsOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	HlsOutputFormatOptions, SegmentedUpstreamFields | 'onMaster' | 'onPlaylist'
>>>;
export type DashOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	DashOutputFormatOptions, SegmentedUpstreamFields
>>>;

// The transform and conversion option bags. The consumer found `VideoTransformOptions.frameRate`
// refusing null by probing with tsc, which is work this fixture is supposed to do instead - it was
// only covering the writer factories and the format options. Upstream's own fields stay narrow here
// for the same reason as the format bags.
export type VideoTransformOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	VideoTransformOptions,
	'width' | 'height' | 'fit' | 'rotate' | 'flip' | 'alpha' | 'force' | 'crop' | 'frameRate' | 'process'
>>>;
export type ConversionVideoOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	ConversionVideoOptions,
	'discard' | 'width' | 'height' | 'fit' | 'rotate' | 'flip' | 'allowTransformationMetadata'
	| 'allowRotationMetadata' | 'crop' | 'frameRate' | 'codec' | 'quality' | 'bitrate' | 'alpha'
	| 'keyFrameInterval' | 'hardwareAcceleration' | 'forceTranscode' | 'processedWidth'
	| 'processedHeight' | 'group' | 'maximumPacketCount' | 'process'
>>>;
export type ConversionSubtitleOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	ConversionSubtitleOptions, 'discard' | 'group'
>>>;
export type ConversionOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	ConversionOptions,
	'tracks' | 'video' | 'audio' | 'trim' | 'copy' | 'tags' | 'showWarnings' | 'composable'
>>>;

// The encoder-control and track-metadata bags. The consumer probed these with tsc on 874 and found
// them narrow, which is again work this fixture should have done - it covered the writer factories,
// the format bags and the transform bags, but nothing a caller passes to `addVideoTrack` or to an
// encoding config. `VideoEncoderControls` is fork-added in full, so none of it is omitted here.
export type VideoEncoderControlsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<VideoEncoderControls>>;
// The second line is upstream's `BaseTrackMetadata`, which `VideoTrackMetadata` intersects and which
// is upstream's in full. Spelling the names out rather than writing `keyof BaseTrackMetadata`: the
// gates lint this file before anything builds `dist`, so the import resolves to `any` there, `keyof
// any` is `string | number | symbol`, and every name beside it reads as a redundant constituent.
export type VideoTrackMetadataAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	VideoTrackMetadata,
	'rotation' | 'flip' | 'transformationMatrix' | 'frameRate' | 'hasOnlyKeyPackets'
	| 'canBeTransparent' | 'decoderConfig' | 'primingPacket'
	| 'languageCode' | 'name' | 'disposition' | 'maximumPacketCount' | 'bitrate' | 'averageBitrate'
	| 'isRelativeToUnixEpoch' | 'group'
>>>;
export type VideoEncodingAdditionalOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<UpstreamOwned<
	VideoEncodingAdditionalOptions,
	'alpha' | 'bitrateMode' | 'latencyMode' | 'fullCodecString' | 'hardwareAcceleration'
	| 'scalabilityMode' | 'contentHint'
>>>;

export type MpdSegmentBaseAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdSegmentBase>>>;
export type MpdSegmentUrlAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<OptionsOf<typeof mpdSegmentUrl>>>;

// The encryption and DRM bags: a caller assembling them from optional config states absence as null.
export type EncryptCmafOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<EncryptCmafOptions>>;
export type EncryptWebmOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<EncryptWebmOptions>>;
export type DrmOptionsAcceptNull = Assert<EveryOptionalFieldAcceptsNull<DrmOptions>>;
export type DrmSystemAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<DrmSystem>>;
// The nested per-track and per-period entries too: these are the ones a caller builds in a loop.
export type CmafTrackKeyAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<CmafTrackKey>>;
export type CmafKeyPeriodAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<CmafKeyPeriod>>;
export type WebmTrackKeyAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<WebmTrackKey>>;

// FORK.md claims every field of the manifest ASTs is settable through its factory's options. That was
// stated and not checked, and `mpd()` had five fields hardcoded past its own options as a result. This
// is the check: for each factory, no AST field may be missing an option that names it.
type Unsettable<Ast, Factory> = Exclude<keyof Ast, keyof OptionsOf<Factory>>;
type NoUnsettableField<Ast, Factory> = Unsettable<Ast, Factory> extends never
	? true
	: Unsettable<Ast, Factory>;

export type MpdCoversItsAst = Assert<NoUnsettableField<Mpd, typeof mpd>>;
export type MpdPeriodCoversItsAst = Assert<NoUnsettableField<MpdPeriod, typeof mpdPeriod>>;
export type MpdAdaptationSetCoversItsAst =
	Assert<NoUnsettableField<MpdAdaptationSet, typeof mpdAdaptationSet>>;
export type MpdRepresentationCoversItsAst =
	Assert<NoUnsettableField<MpdRepresentation, typeof mpdRepresentation>>;
export type MpdSegmentTemplateCoversItsAst =
	Assert<NoUnsettableField<SegmentTemplate, typeof mpdSegmentTemplate>>;

// `initialization` is the one field built rather than taken: from `initializationUri`, and for
// SegmentBase from `initializationRange` too, since an on-demand init states a range and no sourceURL.
export type MpdSegmentListCoversItsAst =
	Assert<Exclude<Unsettable<SegmentList, typeof mpdSegmentList>, 'initialization'> extends never
		? true
		: Exclude<Unsettable<SegmentList, typeof mpdSegmentList>, 'initialization'>>;
export type MpdSegmentBaseCoversItsAst =
	Assert<Exclude<Unsettable<SegmentBase, typeof mpdSegmentBase>, 'initialization'> extends never
		? true
		: Exclude<Unsettable<SegmentBase, typeof mpdSegmentBase>, 'initialization'>>;

// The shaka `MediaInfo` mirror: `MpdBuilder`'s caller assembles these the same way, and leaving them
// narrow while `DrmSystem`'s same-named fields accept null is the asymmetry that produced this batch.
export type ContentProtectionEntryAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<DashContentProtectionEntry>>;
export type ProtectedContentAcceptsNull = Assert<EveryOptionalFieldAcceptsNull<DashProtectedContent>>;
