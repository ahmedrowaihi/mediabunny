# Fork features — `@ahmedrowaihi/mediabunny`

This fork tracks [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) on `main` and ships features in advance of upstream landing them. Every push to the `publish-ahmedrowaihi` branch republishes the package as `@ahmedrowaihi/mediabunny@<base>-beta.<runNumber>` on npm and creates a corresponding GitHub Release with the per-publish commit delta. Every addition is **additive** — no upstream API is removed or renamed. Consumers can drop the fork in place of upstream `mediabunny` for any code using only upstream APIs.

```bash
npm install @ahmedrowaihi/mediabunny@beta
```

## Output side — write HLS, DASH, and HLS+DASH together

### HLS playlist generators (ported from shaka-packager)

A faithful port of shaka-packager's HLS playlist construction stack, exposed as public API. Lets you generate spec-compliant master and media playlists programmatically from typed inputs rather than via string concatenation.

Public exports: `Tag`, `MediaPlaylist`, `MasterPlaylist`, `BandwidthEstimator`, `SegmentInfoEntry`, `EncryptionInfoEntry`, `DiscontinuityEntry`, `PlacementOpportunityEntry`, `ProgramDateTimeEntry`, `HlsPlaylistType`, `HlsMediaPlaylistStreamType`, `HlsEncryptionMethod`, `HlsContainerType`, `HlsVideoInfo`, `HlsAudioInfo`, `HlsTextInfo`, `HlsMediaInfo`, `HlsParams`, `adjustHlsVideoCodec`.

Coverage includes: variants + EXT-X-MEDIA, audio-only master playlists, BandwidthEstimator (peak vs. average tracking matching shaka), `#EXT-X-SESSION-KEY` for master-level DRM, per-segment `#EXT-X-KEY`, PROGRAM-DATE-TIME auto-injection (handles out-of-order discontinuities), `#EXT-X-PLACEMENT-OPPORTUNITY`, I-frame-only stream support, `VIDEO-RANGE` attribute, fixed banner position (after `#EXT-X-VERSION`) to match shaka byte-for-byte.

Both upstream and shaka-packager are credited in `NOTICE` and `LICENSE.shaka-packager`.

### DASH MPD generator (ported from shaka-packager)

A full MPD builder ported from shaka-packager, with one intentional deviation (see below).

Public exports: `MpdBuilder`, `Period`, `AdaptationSet`, `Representation`, `XmlNode`, `AdaptationSetXmlNode`, `RepresentationBaseXmlNode`, `RepresentationXmlNode`, `addContentProtectionElements`, `getSegmentName`, `MpdParams`, `MpdOptions`, `SegmentInfo`, `Clock as DashClock`, `Element`, `ContentProtectionElement`, plus the entire `dash-mpd-utils` toolkit (`floatToXmlString`, `secondsToXmlDuration`, `getDurationAttribute`, `getCodecs`, `getSupplementalCodecs`, `getSupplementalProfiles`, `getBaseCodec`, `getAdaptationSetKey`, `hexToUUID`, content-protection helpers, language utilities, FourCC helpers).

DRM coverage: `cenc:pssh`, `mspr:pro`, `urn:mpeg:dash:mp4protection:2011`, PlayReady, Widevine, Marlin content-id generation, Microsoft PRO element generation.

**Deviation from shaka:** path-aware `<BaseURL>` encoding. Shaka's MPD builder URL-encodes path separators inside `<BaseURL>`, which breaks segments served under nested directory structures. The fork emits unencoded `/` characters in `<BaseURL>` text content (still encodes everything else per RFC 3986).

### `AdaptiveOutputFormat` — HLS + DASH from one CMAF pass

A new output-format wrapper that drives both `HlsOutputFormat` and `DashOutputFormat` from a single CMAF encoder pass. Segments and init segments are shared between the two manifests, so storage cost stays roughly equal to one-format output while consumers get both.

Public exports: `AdaptiveOutputFormat`, plus the existing `HlsOutputFormat`, `DashOutputFormat`, `HlsOutputPlaylistInfo`, `HlsOutputSegmentInfo`.

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

## Cross-cutting input additions

- **sidx box parsing** + `Input.getSegmentIndex` exposure — for CMAF and DASH segment-side index access.
- **`SidxBox` read-side derivation helpers** + `ByteRange` type export — for callers computing segment offsets from sidx.
- **`Input` / `InputTrack`: pssh / tenc exposure** for re-emission — keep the original DRM box bytes available so downstream re-muxing or re-packaging can preserve them.
- **`InputVideoTrack.getFrameRate` / `getFrameRateMode` / `getFrameDurationFromRate`** — surface frame-rate information that upstream doesn't expose at the InputTrack level.
- **HLS port: `EXT-X-MEDIA` in input order** — fix ported from shaka b1580dd.

## Versioning

`package.json` carries the upstream base version (e.g. `1.44.2`). The publish workflow strips any trailing `-beta.N`, then appends `-beta.<github.run_number>` to produce a monotonically increasing beta tag. Consumers should pin exact versions (`"@ahmedrowaihi/mediabunny": "1.44.2-beta.42"`) rather than tracking the floating `beta` dist-tag.

Each publish creates a GitHub Release at `v<version>` containing the commit delta against upstream `main` at that point in time. See the [Releases page](https://github.com/ahmedrowaihi/mediabunny/releases) for per-publish breakdowns.

## License + attribution

The fork is MPL-2.0, matching upstream. The HLS and DASH output ports include `NOTICE` and `LICENSE.shaka-packager` attributions covering the Apache-2.0 code lifted from [shaka-project/shaka-packager](https://github.com/shaka-project/shaka-packager). All non-fork-specific work is upstream-contributable; the fork exists to ship features ahead of upstream PR cycles, not to diverge.
