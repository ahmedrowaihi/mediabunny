# Fork features — `@ahmedrowaihi/mediabunny`

This fork tracks [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) on `main` and ships features in advance of upstream landing them. Every push to the `publish-ahmedrowaihi` branch republishes the package as `@ahmedrowaihi/mediabunny@<base>-beta.<runNumber>` on npm and creates a corresponding GitHub Release with the per-publish commit delta. Every addition is **additive** — no upstream API is removed or renamed. Consumers can drop the fork in place of upstream `mediabunny` for any code using only upstream APIs.

```bash
npm install @ahmedrowaihi/mediabunny@beta
```

## Output side — write HLS, DASH, and HLS+DASH together

### HLS playlist generators (ported from shaka-packager)

A faithful port of shaka-packager's HLS playlist construction stack, exposed as public API. Lets you generate spec-compliant master and media playlists programmatically from typed inputs rather than via string concatenation.

Public exports: `Tag`, `MediaPlaylist`, `MasterPlaylist`, `BandwidthEstimator`, `SegmentInfoEntry`, `EncryptionInfoEntry`, `DiscontinuityEntry`, `PlacementOpportunityEntry`, `ProgramDateTimeEntry`, `HlsPlaylistType`, `HlsMediaPlaylistStreamType`, `HlsEncryptionMethod`, `HlsContainerType`, `HlsVideoInfo`, `HlsAudioInfo`, `HlsAudioCodecSpecificData`, `HlsTextInfo`, `HlsMediaInfo`, `HlsCeaCaption`, `HlsParams`, `adjustHlsVideoCodec`.

Coverage includes: variants + EXT-X-MEDIA, audio-only master playlists, BandwidthEstimator (peak vs. average tracking matching shaka), `#EXT-X-SESSION-KEY` for master-level DRM, per-segment `#EXT-X-KEY`, PROGRAM-DATE-TIME auto-injection (handles out-of-order discontinuities), `#EXT-X-PLACEMENT-OPPORTUNITY`, I-frame-only stream support, `VIDEO-RANGE` attribute, fixed banner position (after `#EXT-X-VERSION`) to match shaka byte-for-byte. Live output: sliding-window trim (`timeShiftBufferDepth`) that drops aged segments, advances `#EXT-X-MEDIA-SEQUENCE` / `#EXT-X-DISCONTINUITY-SEQUENCE`, preserves leading `#EXT-X-KEY`s, and exposes dropped names via `MediaPlaylist.getSegmentsToBeRemoved()` (`preservedSegmentsOutsideLiveWindow`). Master output: CEA closed-caption renditions (`#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` + `CLOSED-CAPTIONS="CC"` on STREAM-INF, via `HlsCeaCaption`) and rendition ordering by `HlsMediaInfo.index` (group-id fallback), matching shaka's `is_default`/`is_autoselect` per `(group, language)` with DVS + forced-subtitle handling.

Both upstream and shaka-packager are credited in `NOTICE` and `LICENSE.shaka-packager`.

### DASH MPD generator (ported from shaka-packager)

A full MPD builder ported from shaka-packager, with one intentional deviation (see below).

Public exports: `MpdBuilder`, `Period`, `AdaptationSet`, `Representation`, `XmlNode`, `AdaptationSetXmlNode`, `RepresentationBaseXmlNode`, `RepresentationXmlNode`, `addContentProtectionElements`, `getSegmentName`, `MpdParams`, `MpdOptions`, `SegmentInfo`, `Clock as DashClock`, `Element`, `ContentProtectionElement`, plus the entire `dash-mpd-utils` toolkit (`floatToXmlString`, `secondsToXmlDuration`, `getDurationAttribute`, `getCodecs`, `getSupplementalCodecs`, `getSupplementalProfiles`, `getBaseCodec`, `getAdaptationSetKey`, `hexToUUID`, content-protection helpers, language utilities, FourCC helpers).

DRM coverage: `cenc:pssh`, `mspr:pro`, `urn:mpeg:dash:mp4protection:2011`, PlayReady, Widevine, Marlin content-id generation, Microsoft PRO element generation.

**Deviation from shaka:** path-aware `<BaseURL>` encoding. Shaka's MPD builder URL-encodes path separators inside `<BaseURL>`, which breaks segments served under nested directory structures. The fork emits unencoded `/` characters in `<BaseURL>` text content (still encodes everything else per RFC 3986).

### `AdaptiveOutputFormat` — HLS + DASH from one CMAF pass

A new output-format wrapper that drives both `HlsOutputFormat` and `DashOutputFormat` from a single CMAF encoder pass. Segments and init segments are shared between the two manifests, so storage cost stays roughly equal to one-format output while consumers get both.

Public exports: `AdaptiveOutputFormat`, plus the existing `HlsOutputFormat`, `DashOutputFormat`, `HlsOutputPlaylistInfo`, `HlsOutputSegmentInfo`.

## Encryption side — write-side media encryption (ported from shaka-packager)

Pure-TypeScript media encryptors with no native dependencies, ported from shaka-packager's encryption stack. Covers CENC for fragmented CMAF, WebM Encryption, and HLS AES-128 / SAMPLE-AES.

**CMAF / fMP4 (CENC).** `encryptCmaf` (self-contained file) and `encryptCmafInit` + `encryptCmafSegment` (split init + media segments). Handles sample encryption, the `senc`/`saiz`/`saio`/`tenc`/`sinf` boxes, the `encv`/`enca` sample-entry transform, and `trun` offset fixups. Schemes `cbcs`, `cenc`, `cens`, `cbc1`. Video H.264/H.265 (real NAL/slice-header parsing, incl. multi-slice pictures), AV1 (tile subsamples), VP9 (uncompressed-header); audio AAC/AC-3/E-AC-3 (whole-sample) and AC-4 (TOC + pattern). Exports: `encryptCmaf`, `encryptCmafInit`, `encryptCmafSegment`, `EncryptCmafOptions`, `ProtectionScheme`.

**WebM (AES-CTR).** `encryptWebm` (whole file) and `encryptWebmInit` + `encryptWebmSegment` (split). Adds the `ContentEncryption` element per track and reframes each frame with the WebM signal byte + IV (subsample partition offsets for VP9/AV1 video, whole-frame for audio); Xiph/EBML/fixed lacing handled. Exports: `encryptWebm`, `encryptWebmInit`, `encryptWebmSegment`, `EncryptWebmOptions`.

**HLS.** `encryptHlsAes128` — whole-segment AES-128-CBC + PKCS#7 (container-agnostic) with `buildHlsAes128KeyTag` for the `#EXT-X-KEY:METHOD=AES-128` line. `sampleAesEncryptAudioFrame` / `sampleAesEncryptVideoNal` — the Apple SAMPLE-AES per-sample encryptors (AAC clear-leader; AVC 1-in-10 protected-block pattern). Exports: `encryptHlsAes128`, `buildHlsAes128KeyTag`, `HlsAes128Options`, `sampleAesEncryptAudioFrame`, `sampleAesEncryptVideoNal`, `SampleAesOptions`.

**Signaling + PSSH.** DASH `<ContentProtection>`: `buildContentProtections` (any scheme), `buildCbcsContentProtections`, `serializeContentProtection`, `patchMpdContentProtection`. HLS `#EXT-X-KEY`: `buildCbcsHlsKey`, `patchMediaPlaylistKeys`. PSSH builders: `buildWidevinePssh`, `buildCommonPssh`, `buildPlayReadyPssh` / `buildPlayReadyObject` (plus `WIDEVINE_SYSTEM_ID`, `COMMON_SYSTEM_ID`, `PLAYREADY_SYSTEM_ID`, `WIDEVINE_UUID`, `FAIRPLAY_UUID`, `CBCS_HLS_METHOD`, `DrmSystem`).

| Feature | Supported |
| --- | :---: |
| CMAF schemes — `cbcs`, `cenc`, `cens`, `cbc1` | ✅ |
| CMAF video — H.264, H.265, AV1, VP9 | ✅ |
| CMAF audio — AAC, AC-3, E-AC-3, AC-4 | ✅ |
| CMAF delivery — self-contained file + split init/segment | ✅ |
| WebM Encryption (AES-CTR) — VP9/AV1 subsample, audio whole-frame, lacing | ✅ |
| WebM delivery — whole file + split init/segment | ✅ |
| WebM pattern schemes (`cbcs`/`cens`) | n/a — WebM is CTR-only by spec |
| HLS AES-128 — whole-segment (any container) | ✅ |
| HLS SAMPLE-AES — per-sample AAC/AVC encryptors | ✅ |
| MPEG-TS SAMPLE-AES — full-file container remux | ❌ (sample encryptors only) |
| CENC on MPEG-TS | n/a — CENC is ISOBMFF-only by spec |
| DASH signaling — `<ContentProtection>` (`mp4protection` default_KID + `cenc:pssh`) | ✅ |
| HLS signaling — `#EXT-X-KEY` (`SAMPLE-AES` and `AES-128`) | ✅ |
| PSSH — Widevine, W3C Common (ClearKey), PlayReady | ✅ |
| Subtitles / captions | ❌ (not encrypted; shaka excludes text) |

Verified against shaka-packager: AC-4 TOC against its compiled C++ output, VP9 against its parser unit-test vectors, AV1 against its parser across a full clip; plus AES against NIST SP 800-38a vectors and SAMPLE-AES against the hls.js reference decrypt. Output is verified end-to-end in a browser CDM (ClearKey EME) for H.264, AV1, and VP9/WebM — it decodes only with the correct key (and not without a CDM). Logic mirrors shaka-packager with its unit tests ported; `NOTICE` / `LICENSE.shaka-packager` credited.

## HDR / colour signaling (ported from shaka-packager)

Byte-domain readers and box builders for HDR metadata — no pixel processing.

**Dolby Vision.** `parseDoviConfigRecord` parses a `dvcC` / `dvvC` configuration record (profile, level, RPU/EL/BL flags, base-layer signal-compatibility id); `doviCodecString` derives the `dvhe.NN.NN` codec string; `doviCompatibleBrand` derives the compatible brand FourCC from the compatibility id + transfer characteristics. Mirrors shaka's `DOVIDecoderConfigurationRecord`. Exports: `parseDoviConfigRecord`, `doviCodecString`, `doviCompatibleBrand`, `DoviConfig`.

**HDR10 static metadata.** `parseHevcSeiHdrMetadata` extracts mastering-display (SEI 137, SMPTE ST 2086) and content-light (SEI 144, CTA-861.3) from an HEVC SEI NAL (emulation-prevention stripped); `parseMasteringDisplayMetadata` / `parseContentLightLevel` parse the raw payloads; `buildMdcvBox` / `buildClliBox` emit the ISOBMFF `mdcv` / `clli` signaling boxes. Exports: `parseHevcSeiHdrMetadata`, `parseMasteringDisplayMetadata`, `parseContentLightLevel`, `buildMdcvBox`, `buildClliBox`, `MasteringDisplayMetadata`, `ContentLightLevel`, `HdrStaticMetadata`.

**ISOBMFF round-trip.** The MP4 demuxer reads `mdcv` / `clli` sample-entry boxes into `getDecoderConfig().hdrStaticMetadata`, and the MP4 muxer re-emits them from the same field (gated on presence, like `colr` — no boxes and byte-identical output when absent). So HDR10 static metadata survives a transmux. Dolby Vision `dvcC` / `dvvC` parsing is exposed standalone; native `dvh1` / `dvhe` sample-entry demux is not yet wired.

Verified against ffmpeg-generated HDR10 SEI NAL units (x265 master-display + max-cll) and against shaka's DoVi profile/level/brand logic; the `mdcv`/`clli` round-trip is verified end-to-end through the MP4 muxer + demuxer on real HEVC packets.

## Input side — read MPEG-DASH manifests

### DASH input pipeline

A full `application/dash+xml` reader mirroring the existing HLS input architecture, registered alongside HLS / ISOBMFF / Matroska / etc.

Format singletons + arrays: `DashInputFormat`, `DASH`, `DASH_FORMATS` (composes DASH with ISOBMFF, QuickTime, Matroska, WebM for segment-side demuxing).

Public AST: `parseMpd(xml) → Mpd` returns a typed AST — `Mpd`, `MpdPeriod`, `MpdAdaptationSet`, `MpdRepresentation`, `SegmentTemplate`, `SegmentList`, `SegmentBase`, `SegmentTimelineEntry`, `DashByteRange`, `ContentProtection`. Throws `MpdParseError` on malformed XML or missing required attributes.

Demuxer (`DashDemuxer` + `DashSegmentedInput`) capabilities:

- Two-pass track resolution: `(Period, AdaptationSet@group)` pairing-bit assignment so audio/video Representations across paired AdaptationSets share a pairing mask.
- Codec fallback: probes the first segment via `getDecoderConfig` when neither Representation nor AdaptationSet declares `@codecs`.
- `<Label>` preference: Representation `<Label>` > AdaptationSet `<Label>` > Representation `@id`.
- `SegmentTimeline` correctness: `@r=-1` repeats until the next `<S>@t` (when present) or period end, matching ISO/IEC 23009-1 §5.3.9.6.1.
- Live MPD refresh: dynamic manifests refresh on `minimumUpdatePeriod`, in-place context mutation preserves SegmentedInput identity.
- DVR window: `timeShiftBufferDepth` clamping on the availability window.
- `availabilityTimeOffset` and `presentationTimeOffset` honored.
- Common Encryption: `<ContentProtection>` + `<cenc:pssh>` parsing handling both wire forms (full pssh box bytes _and_ content-only embedded); forwarded into the existing `isobmff.resolveKeyId` pipeline so DRM consumers receive a unified pssh box list across the input.
- Stable track IDs across MPD refreshes via `(periodId|asId|repId)` mapping.

### HLS playlist parser — extracted, exposed, single source of truth

The HLS demuxer previously embedded its own line-walking parser. It now uses a standalone, public AST parser as its single source of truth — the same parser external consumers (validators, inspectors) reach for.

Public exports: `parseHlsPlaylist(text) → HlsMasterPlaylist | HlsMediaPlaylistAst` (discriminated union), `HlsVariant`, `HlsIFrameStream`, `HlsMediaRendition`, `HlsSegment`, `HlsMap`, `HlsKey`.

Master AST: `variants`, `iFrameStreams`, `media` — each entry carries `lineNumber` so consumers can reconstruct cross-array document order. Strict YES/NO enum validation on `DEFAULT` / `AUTOSELECT` / `FORCED` (throws on other values, matching the demuxer's prior behavior).

Media AST: ordered `segments[]` with `#EXT-X-MAP` / `#EXT-X-KEY` carry-over, plus `programDateTime`, `byteRange`, and `discontinuityBefore` flags per segment.

The demuxer's behavior is preserved bit-for-bit: variant streams are sorted by `lineNumber` so pairing-mask bit assignment matches the original linear-walk implementation when STREAM-INF and I-FRAME-STREAM-INF tags are interleaved. Live media-playlist state (sequence numbers, byte-range continuation, PDT extrapolation, encryption key carry-over) intentionally stays inside `HlsSegmentedInput` — that's a state machine, not a static parser, and the two concerns are separated cleanly.

### Spec-primitive exports

The tag constants and helpers used internally by both demuxers are now public so external consumers don't reach for internals.

- **HLS:** `HLS_MIME_TYPE`, `TAG_STREAM_INF`, `TAG_I_FRAME_STREAM_INF`, `TAG_MEDIA`, `TAG_EXTINF`, `TAG_MAP`, `TAG_KEY`, `TAG_MEDIA_SEQUENCE`, `TAG_BYTERANGE`, `TAG_PROGRAM_DATE_TIME`, `TAG_DISCONTINUITY`, `TAG_TARGETDURATION`, `TAG_ENDLIST`, `TAG_PLAYLIST_TYPE`, `TAG_I_FRAMES_ONLY`, `AttributeList`, `canIgnoreLine`.
- **DASH:** `DASH_MIME_TYPE`, `parseISODuration`, `parseISODateTime`, `parseByteRange`, `parseFrameRate`, `resolveURL`, `resolveBaseURL`, `substituteTemplate`, `normaliseKeyId`, `psshContentsOffset`, `DashRational`.

### Concat / stitch building blocks

For consumers merging per-chunk manifests post-encode (e.g. chunked-transcode workflows).

- `concatMpdPeriods(inputs) → { xml, totalDurationSeconds }` — sequences the first `<Period>` of each input MPD into a single multi-period output. The first input is used as the output base, preserving its `<MPD>` root attributes, namespace declarations, and non-`<Period>` root children (e.g. `<UTCTiming>`, `<ProgramInformation>`) bit-for-bit via DOM `importNode`. Only Period `@id` / `@start` / `@duration` and the optional injected `<BaseURL>` are mutated.
- `concatHlsMediaPlaylists(inputs) → { content }` — preserves the first input's header lines verbatim (`#EXT-X-VERSION`, `#EXT-X-PLAYLIST-TYPE`, `#EXT-X-INDEPENDENT-SEGMENTS`, custom tags), overwrites only `#EXT-X-TARGETDURATION` to the max across inputs, appends each input's body with optional `pathPrefix` rewriting on segment URIs and `#EXT-X-MAP@URI`, ends with a single `#EXT-X-ENDLIST`.
- `rewriteHlsMasterUrisToBasename(master) → string` — strips directory components from STREAM-INF / MEDIA URIs.

These are deliberately scoped as **building blocks** — no filtering, normalization, or AdaptationSet validation. Callers that need filter / override / correct should compose them with their own pre/post passes.

### AST builders — construction counterpart to the parsers

Factory functions that build the HLS and DASH ASTs from the fields that matter, defaulting the boilerplate — the write-side complement to `parseHlsPlaylist` / `parseMpd` (hand the result to `serializeManifest`). For describing already-produced segments (e.g. indexing an external CMAF push) rather than driving the muxer pipeline, so distinct from the `MediaInfo`-driven `MpdBuilder`.

- **HLS:** `hlsVariant`, `hlsMediaRendition`, `hlsSegment` (optional `#EXT-X-MAP` / `#EXT-X-KEY`), `hlsMasterPlaylist`, `hlsMediaPlaylist` → `HlsMasterPlaylist` / `HlsMediaPlaylistAst`.
- **DASH:** `mpd` (ISO live/on-demand profile selected from `@type`), `mpdPeriod`, `mpdAdaptationSet`, `mpdRepresentation`, `mpdSegmentList` → `Mpd`.

## Cross-cutting input additions

- **sidx box parsing** + `Input.getSegmentIndex` exposure — for CMAF and DASH segment-side index access.
- **`SidxBox` read-side derivation helpers** + `ByteRange` type export — for callers computing segment offsets from sidx.
- **`Input` / `InputTrack`: pssh / tenc exposure** for re-emission — keep the original DRM box bytes available so downstream re-muxing or re-packaging can preserve them.
- **`InputVideoTrack.getFrameRate` / `getFrameRateMode` / `getFrameDurationFromRate`** — surface frame-rate information that upstream doesn't expose at the InputTrack level.
- **HLS port: `EXT-X-MEDIA` in input order** — fix ported from shaka b1580dd.
- **CMAF/fMP4 segment primitives** — `isInitializationSegment(bytes)` (top-level moov-before-moof scan), `getSegmentDecodeTime(bytes)` (first `tfdt` baseMediaDecodeTime, v0/v1), and `rebaseSegmentDecodeTime(bytes, deltaTicks)` (shift every `traf`'s `tfdt` onto a continuous timeline, returning a new buffer, input untouched) — read and rewrite a fragment's decode timeline without a demux/remux.

## Manifest transform substrate — parse → transform → serialize

A unified, format-agnostic pipeline over the DASH (`Mpd`) and HLS (`HlsPlaylist`) ASTs: parse a manifest, run composable pure transforms, serialize it back. Two lossless format-specific ASTs behind one `Manifest` facade.

- **Facade:** `parseManifest(text, options?) → Manifest` (sniffs HLS vs DASH), `serializeManifest(manifest) → string`, `pipeManifest(manifest, transforms) → Manifest`. `Manifest` is a discriminated union (`{ format: 'dash', mpd }` | `{ format: 'hls', playlist }`); `ManifestTransform = (Manifest) => Manifest`.
- **Serializers:** `serializeMpd(Mpd) → string`, `serializeHls(HlsPlaylist) → string` — the round-trip complement to the parsers (reuse `XmlNode` / `Tag` and the shared duration + float formatting; `<BaseURL>` path-aware). Transforms are **pure**: a new manifest is returned, every untouched subtree shared by reference, so one parsed base spawns many variants cheaply.
- **Cross-format rendition filtering:** `Rendition` is a read-only view of a selectable rendition (DASH Representation, HLS variant, or `#EXT-X-MEDIA` group) so one predicate works against both formats. `filterRenditions(predicate)` is the core; atoms compose over it — `dropCodecs` / `keepCodecs`, `capResolution`, `filterBitrate`, `filterFramerate`, `filterChannels`, `dropByColorRange` (SDR / HLG / PQ), `dropSubtitles`. Dropping an HLS media group prunes now-dangling variant group references.
- **URL + structure rewrites:** `mapSegmentUrls((url, kind, index) => url)` rewrites every media-referencing URL by `SegmentUrlKind`; `rebaseManifest(base)` resolves relative URLs against a new base (DASH BaseURL chain preserved); `toSegmentTemplate(build)` repackages single-file (`SegmentBase`) DASH representations as `SegmentTemplate` + `SegmentTimeline`.
- **DRM signaling:** `drm(options)` injects content protection into a parsed manifest (DASH `<ContentProtection>` per system, HLS `#EXT-X-KEY` per system; multi-DRM in one manifest). Each format's rules live in one core shared with the generate/patch-path helpers — `buildContentProtections` / `buildHlsKeys` (from-scratch) and `patchMpdContentProtection` / `patchMediaPlaylistKeys` (format-preserving in-place string patch).
- Backing parser additions: DASH `AudioChannelConfiguration` / `SupplementalProperty` / `EssentialProperty` descriptors and HLS `VIDEO-RANGE`, plus the shared `parseChannelCount` helper.

## Faithfulness to shaka-packager

The HLS/DASH output ports are kept synced to shaka-packager and audited for 1:1 fidelity — logic mirrors shaka bit-for-bit, and shaka's unit tests are ported alongside each feature so behaviour is proven, not assumed. Last synced to **shaka-packager v3.8.0** (2026-07-03).

That sync pass corrected drift where our ports had fallen behind or over-simplified shaka: multi-period on-demand text `presentationTimeOffset` (shaka #1493/#1433), HLS master `DEFAULT`/`AUTOSELECT` computed per `(group, language)` with DVS + forced-subtitle handling, `SegmentTemplate` duration integer truncation, `#EXT-X-START:TIME-OFFSET` `%f` formatting, HLS language shortest-form reduction, DASH `ContentProtection` attribute precedence (later-set-wins, dedup via `RemoveDuplicateAttributes` upstream), full-proto `ProtectedContent` equality, and `GetStaticMpdDuration` float32 accumulation. It also added previously-unported subsystems: the HLS **live sliding window**, **CEA closed captions**, and **rendition index/group-id ordering**.

Intentional, documented deviations (everything else is a faithful mirror):

- **Path-aware `<BaseURL>`** — unencoded `/` in DASH `<BaseURL>` (see above); shaka URL-encodes them.
- **No-filesystem `RemoveOldSegment`** — the live window returns dropped segment names via `MediaPlaylist.getSegmentsToBeRemoved()` for the caller to delete, rather than performing `File::Delete`; the preserved-window buffer is trimmed unconditionally.
- **`HlsParams.discontinuitySequenceNumber`** — an initial-seed input the fork adds (shaka derives it purely internally); it seeds the member counter the sliding window then advances, kept additive so no upstream API changes.

## Versioning

`package.json` carries the upstream base version (currently `1.50.7`, tracking upstream `release`). The publish workflow strips any trailing `-beta.N`, then appends `-beta.<github.run_number>` to produce a monotonically increasing beta tag. Consumers should pin exact versions (`"@ahmedrowaihi/mediabunny": "1.50.7-beta.43"`) rather than tracking the floating `beta` dist-tag.

The fork repo retains only the most recent **3 beta releases** (older ones are auto-pruned by the publish workflow). If you need an older beta that's been pruned, the npm tarball still resolves — only the GitHub Release page is cleaned.

Each publish creates a GitHub Release at `v<version>` containing the commit delta against upstream `release` at that point in time. See the [Releases page](https://github.com/ahmedrowaihi/mediabunny/releases) for per-publish breakdowns.

## License + attribution

The fork is MPL-2.0, matching upstream. The HLS and DASH output ports include `NOTICE` and `LICENSE.shaka-packager` attributions covering the Apache-2.0 code lifted from [shaka-project/shaka-packager](https://github.com/shaka-project/shaka-packager). All non-fork-specific work is upstream-contributable; the fork exists to ship features ahead of upstream PR cycles, not to diverge.
