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

`separateRenditions: true` forces a lone video track paired with a lone audio track apart instead of collapsing them into one muxed variant: the audio becomes an `#EXT-X-MEDIA` rendition group in HLS and its own `<AdaptationSet>` in the MPD. A muxed variant exercises nothing of a player's audio-track selection, and a 1:1 pairing cannot express the split through `OutputTrackGroup` alone.

With `singleFilePerPlaylist: true`, one CMAF file backs both manifests at once: the HLS media playlist addresses it through `#EXT-X-MAP` and `#EXT-X-BYTERANGE`, and the MPD is emitted as an `isoff-on-demand` profile whose `<SegmentList>` carries an `<Initialization range>` plus one `<SegmentURL mediaRange>` per subsegment, over the same byte ranges. This is shaka's `use_segment_list` form of on-demand DASH, which needs no `sidx`.

Setting `sidxFragmentCapacity` on a `fastStart: 'fragmented'` segment format instead reserves room after `moov` for a Segment Index covering every fragment, written once the file is finalized and padded with a `free` box. The MPD then carries `<SegmentBase indexRange>` — one range rather than a `<SegmentURL>` per subsegment, which matters once an asset runs to thousands of them. Overflowing the declared capacity, or leaving it unset, falls back to the `<SegmentList>` form.

### Parameter set placement

`VideoEncodingAdditionalOptions.parameterSets` selects where an AVC or HEVC bitstream carries its parameter sets: `'outOfBand'` (the default) keeps them in the sample entry, `'inBand'` also repeats them throughout the bitstream so a player can join mid-stream without the sample entry. The ISOBMFF sample entry and the manifest `CODECS` string both follow the bitstream that was produced — `avc1`/`hvc1` when the parameter sets are out of band, `avc3`/`hev1` when they are in band — so a manifest never advertises a codec the file is not. The same rule applies on the read side: a demuxed `hvc1` track reports `hvc1`, not `hev1`.

`VideoTrackMetadata.parameterSets` carries the same choice across a remux, where there is nothing to encode. Packets given in Annex B format keep their parameter sets, so the muxer infers `'inBand'` for them; packets that repeat their parameter sets *and* come with a decoder config are byte-for-byte indistinguishable from packets that do not, so there the field is the only signal. Without it, such a track can only be written as `avc1`/`hvc1`, which understates what the samples carry. Declaring `'outOfBand'` for Annex B packets is rejected rather than written, since the muxer does not strip them.

### Key frames from the server encoders

With `@mediabunny/server`, a video track's key frames are exactly the ones `keyFrameInterval` forces. libx264, libx265, libvpx (VP8/VP9) and SVT-AV1 no longer add key frames of their own, whether from scene-cut detection or from a fixed 60-frame GOP that put one 1.2 s after every forced key frame at 50 fps. A forced libx265 key frame is a closed-GOP IDR rather than a CRA followed by RASL pictures, so a segment starting at any key frame decodes on its own. The frame rate handed to the encoder is an exact rational (24000/1001 rather than a rounded 24), so x265 signals it exactly.

### Capped quality from the server encoders

`Quality` takes `maxBitrate` (and optionally `bufferSize`, default twice `maxBitrate`) alongside `quality` or `quantizer`: quality-driven encoding that holds the quantizer until holding it would exceed a peak bitrate, the rate control known as capped CRF, and as QVBR in AWS Elemental encoders. `@mediabunny/server` maps it to `crf` + `maxrate` + `bufsize` on x264 and x265, `crf` + `maxrate` on SVT-AV1, constrained quality (`crf` with the cap as the target bitrate) on libvpx-vp9 and libaom-av1, and `rc=vbr` + `cq` + `maxrate` on NVENC; rav1e has no such mode. WebCodecs has none either, so there a `bitrate` fallback applies, or, for a qualitative `quality`, bitrate-based encoding at no more than `maxBitrate`. Without `maxBitrate`, `Quality` behaves as before.

Encoders are given a frame rate even when the output track declares none: the first sample's duration stands in for it. x265, SVT-AV1 and libvpx budget bits per frame from that rate rather than from timestamps, so a `Conversion` that left it unset (which upstream mediabunny also does) told them 30 fps and missed bitrate caps and targets: about 1.4 to 2 times over at 50 fps, and short of them at 24 or 25 fps.

### Segmented subtitles — WebVTT and TTML

`addSubtitleTrack` with a `webvtt` source produces a subtitle rendition in both manifests: an `#EXT-X-MEDIA:TYPE=SUBTITLES` group referenced by a `SUBTITLES=` attribute on every HLS variant, and a `contentType="text"` AdaptationSet in DASH. Segments are `.vtt` text carrying an `X-TIMESTAMP-MAP` header that anchors cue times to the media timeline.

Subtitle segments are cut on exactly the media segment boundaries rather than on a clock of their own, so a player can switch renditions at any segment. A cue spanning a boundary is emitted in every segment it overlaps, as a player joining mid-stream parses only the segments it fetched.

TTML rides in the segment format configured for the media rather than in text segments, since `stpp` is an ISOBMFF sample entry: its renditions are ordinary fragmented MP4, signalled `stpp` in the HLS `CODECS` attribute and as `application/mp4` + `codecs="stpp"` in DASH. That difference is load-bearing rather than cosmetic — a TTML rendition can be addressed by byte ranges and so is accepted under `singleFilePerPlaylist`, where a WebVTT one is refused because raw text cannot. The refusal names the codec and points at the alternative.

A track whose disposition marks it forced is signalled as forced in both manifests — `FORCED=YES` on the HLS rendition, and a `forced-subtitle` role on a DASH AdaptationSet of its own, since a forced track sharing an AdaptationSet with an ordinary subtitle of the same language would leave a player unable to tell which representation is which.

WebVTT is a segment format like any other: it declares `webvtt` as its only codec and no video or audio capacity, so the muxer's existing format deduction selects it for a subtitle track and never for a media track. Single-file (byte-range addressed) playlists therefore declare a subtitle capacity of zero, and a subtitle track is refused when it is added rather than when the output starts.

### Indexing a single file without predicting it

`segmentIndex` asks a fragmented ISOBMFF output for a top-level `sidx` without the caller stating how many fragments the file will contain — a number only the muxer can know, since it depends on where fragments actually land. The muxer reserves a ceiling, trims the reservation to the exact index at finalize and leaves the remainder as `free`, so an over-reservation costs nothing in the output. `sidxFragmentCapacity` still sets that ceiling for a caller who wants to shrink it for a short file or raise it past the default, and asking for one implies the index.

A file that outgrows its reservation throws as the fragment that will not fit is written, rather than dropping the index and letting the layout silently become a segment list. The throw happens there rather than at finalize because that is the path a caller awaits.

### Chunked segments for low latency

`partDuration` on a segmented output writes each fragmented ISOBMFF segment (such as CMAF) as a run of `moof`/`mdat` fragments of about that duration: the Low-Latency HLS partial segments and Low-Latency DASH chunks of that segment. A part is cut before the video sample (or, without video, the audio sample) that would take it past the duration, so no part exceeds it, as Low-Latency HLS requires of the Part Target Duration; the last part of a segment may be shorter. Only a segment's first part is sure to start on a key frame; a later one is marked independent when it happens to.

Each written segment reports its parts through `HlsOutputSegmentInfo.parts` as `SegmentPart { offset, size, duration, independent }`, in order, with offsets from the start of the segment so the parts' bytes concatenate to the segment's. It applies to VOD output as well as live, so a player-facing live window can be assembled over already-written segments.

## Encryption side — write-side media encryption (ported from shaka-packager)

Pure-TypeScript media encryptors with no native dependencies, ported from shaka-packager's encryption stack. Covers CENC for fragmented CMAF, WebM Encryption, and HLS AES-128 / SAMPLE-AES.

**CMAF / fMP4 (CENC).** `encryptCmaf` (self-contained file, fragmented `moof`/`mdat` or progressive `moov` sample table) and `encryptCmafInit` + `encryptCmafSegment` (split init + media segments). Handles sample encryption, the `senc`/`saiz`/`saio`/`tenc`/`sinf` boxes, and the `encv`/`enca` sample-entry transform. Because inserting those boxes moves the media, every index over it is restated: `trun` data offsets, `tfhd` base data offsets, `sidx` distances (front or chained, including references spanning several fragments), `tfra` fragment offsets, and `stco`/`co64` chunk offsets for every track. A track fragment holding several `trun` boxes has all of its runs encrypted. The split segment API takes an `ivState` map carrying each track's IV sequence forward, so per-segment output matches whole-file output byte for byte. Schemes `cbcs`, `cenc`, `cens`, `cbc1`. Video H.264/H.265 (real NAL/slice-header parsing, incl. multi-slice pictures), AV1 (tile subsamples), VP9 (uncompressed-header); audio AAC/AC-3/E-AC-3 (whole-sample) and AC-4 (TOC + pattern). Exports: `encryptCmaf`, `encryptCmafInit`, `encryptCmafSegment`, `EncryptCmafOptions`, `ProtectionScheme`.

**Per-track keys.** `EncryptCmafOptions.trackKeys` maps a track ID to its own `key`/`kid`/`iv`, so video and audio — or separate quality tiers — need not share one key. When given it must name every encryptable track and no others, and a per-track IV must match the file's IV length, since one size is declared file-wide; anything else throws rather than guessing. Each track's `tenc` and sample encryptor are driven from its own material, so no keystream is shared between tracks. Key rotation is covered below.

**Per-track keys, WebM.** `EncryptWebmOptions.trackKeys` maps an EBML `TrackNumber` to its own key material, mirroring the CMAF option. WebM declares key material per `TrackEntry` already, so only the API was single-key; each track's `ContentEncKeyID` and cipher come from its own entry. A stated per-track IV must be the 8 bytes the encrypted-frame header carries, since WebM declares no IV size.

**WebM (AES-CTR).** `encryptWebm` (whole file) and `encryptWebmInit` + `encryptWebmSegment` (split). Adds the `ContentEncryption` element per track and reframes each frame with the WebM signal byte + IV (subsample partition offsets for VP9/AV1 video, whole-frame for audio); Xiph/EBML/fixed lacing handled. The split segment API takes the same per-track `ivState` map as the CMAF one. Exports: `encryptWebm`, `encryptWebmInit`, `encryptWebmSegment`, `EncryptWebmOptions`.

**HLS.** `encryptHlsAes128` — whole-segment AES-128-CBC + PKCS#7 (container-agnostic) with `buildHlsAes128KeyTag` for the `#EXT-X-KEY:METHOD=AES-128` line. `sampleAesEncryptAudioFrame` / `sampleAesEncryptVideoNal` — the Apple SAMPLE-AES per-sample encryptors (AAC clear-leader; AVC 1-in-10 protected-block pattern). Exports: `encryptHlsAes128`, `buildHlsAes128KeyTag`, `HlsAes128Options`, `sampleAesEncryptAudioFrame`, `sampleAesEncryptVideoNal`, `SampleAesOptions`.

**Refusing what cannot be signalled.** A DRM system the HLS builders cannot express is refused by name rather than omitted: FairPlay listed without a key URI, any other system listed without a PSSH, or a PlayReady PSSH that will not parse. One unsignalable system fails the whole call — a playlist declaring two of three key systems plays for most viewers, which is worse than one that refuses to build. FairPlay is still absent from the DASH descriptors, since none exists for it, and that is stated on the builder rather than left implicit.

**Key rotation.** `EncryptCmafOptions.keyPeriods` maps a track ID to a list of `{ key, kid, start, duration }` periods in the track's media timescale, after CPIX's `ContentKeyPeriod`. Periods are stated by decode time rather than sample index, so a segment can be encrypted knowing only itself. Each `traf` carries `sgpd`(`seig`) and `sbgp` naming only the periods its samples draw on, with `tenc` remaining the default; a fragment whose samples all belong to the default period is byte-identical to an unrotated one. The IV sequence runs on across a key change rather than restarting — restarting would replay a keystream wherever a later period reuses an earlier key.

**Signaling + PSSH.** DASH `<ContentProtection>`: `buildContentProtections` (any scheme), `buildCbcsContentProtections`, `serializeContentProtection`, `patchMpdContentProtection`. HLS `#EXT-X-KEY`: `buildCbcsHlsKey`, `patchMediaPlaylistKeys`. PSSH builders: `buildWidevinePssh`, `buildCommonPssh`, `buildPlayReadyPssh` / `buildPlayReadyObject` (plus `WIDEVINE_SYSTEM_ID`, `COMMON_SYSTEM_ID`, `PLAYREADY_SYSTEM_ID`, `WIDEVINE_UUID`, `FAIRPLAY_UUID`, `CBCS_HLS_METHOD`, `DrmSystem`).

| Feature | Supported |
| --- | :---: |
| CMAF schemes — `cbcs`, `cenc`, `cens`, `cbc1` | ✅ |
| CMAF video — H.264, H.265, AV1, VP9 | ✅ |
| CMAF audio — AAC, AC-3, E-AC-3, AC-4 | ✅ |
| CMAF delivery — self-contained file + split init/segment | ✅ |
| CMAF layouts — fragmented (`moof`/`mdat`) and progressive (`moov` sample table) | ✅ |
| Index restatement — `trun`, `tfhd` base offset, `sidx`, `tfra`, `stco`/`co64` | ✅ |
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

**Both carriages on write.** AVC and HEVC output state HDR10 static metadata in the container `mdcv`/`clli` boxes and as a prefix SEI on each key packet, because real HDR10 usually carries both and a player that reads one and ignores the other would otherwise see no HDR. The SEI is spliced after the parameter sets, emulation-prevented, and written only for fields the access unit does not already state — a packet carrying its own SEI passes through byte for byte, and a stream with no HDR metadata is not touched at all. Both carriages die with the HDR transfer, from the same condition.

**ISOBMFF round-trip.** The MP4 demuxer reads `mdcv` / `clli` sample-entry boxes into `getDecoderConfig().hdrStaticMetadata`, and the MP4 muxer re-emits them from the same field (gated on presence, like `colr` — no boxes and byte-identical output when absent). So HDR10 static metadata survives a transmux. When an HEVC track states a PQ or HLG transfer but carries neither box - the shape ffmpeg's mp4 muxer produces, which leaves the values only in the bitstream - the demuxer reads the missing half out of the first access unit's SEI instead. The probe costs one packet read and is skipped entirely for any track not already claiming an HDR transfer; the boxes, when present, win. Dolby Vision `dvcC` / `dvvC` parsing is exposed standalone; native `dvh1` / `dvhe` sample-entry demux is not yet wired.

**Encode-side colour and bit depth.** `VideoEncodingAdditionalOptions.bitDepth` and `.colorSpace` (mirrored on `ConversionVideoOptions`) state what the encoder should produce. The codec string derives its profile from the bit depth — AVC High 10, HEVC Main 10, VP9 profile 2, AV1 Main at 10 bits — instead of pinning 8-bit, and a codec/bit-depth pairing with no profile is refused rather than silently downconverted. `Conversion` inherits both from the input track, so a transcode no longer drops the colour it just read. An inherited bit depth follows the decoded samples, not the source profile, so an 8-bit stream in a 10-bit-capable profile (High 10, High 4:2:2/4:4:4, Main 10) is re-encoded at 8 bits unless a depth is requested.

Only an encoder knows what it produced, so an encoder either produces the depth it was asked for or refuses, naming itself and the depth; with no depth requested it preserves the incoming frames' depth rather than forcing 8-bit. Whether a value was demanded by the caller or inherited from the input is carried alongside it, because a codec string names a profile and every profile implies a depth, so a config alone cannot say which. An inherited value is kept only where the samples reaching the encoder still back it — a canvas re-render hands over 8-bit sRGB and loses both, a scaler that stays in YUV keeps them. A demanded value is never quietly dropped: PQ and HLG are defined from 10 bits up, so demanding one alongside a shallower depth is refused rather than written, while an inherited transfer a demanded depth cannot carry is left unstated. Encoder support reflects that, so a codec is not reported as encodable at a depth its encoder cannot deliver. The encoder also states the colour it encoded, which makes a caller's declaration a consistency check rather than an assertion: a contradiction is an error, and a declaration is only filled in where the encoder stated nothing. Paths that genuinely change the samples — a 2D canvas re-render yields 8-bit sRGB — drop inherited colour and depth along with the bytes they described. Together these mean a stream cannot come out carrying a label its samples do not support.

Colorimetry survives a geometric transform. In libavfilter the matrix coefficients and the color range are link properties rather than frame properties, so a filter graph whose buffer source does not state them hands back frames with those two unstated while primaries and transfer ride through untouched — every rescaled rendition then loses its matrix. The buffer source now states what the source frame stated, so a resize keeps the colour it started with and an unspecified source stays unspecified.

Verified end to end against a real x265 Main 10 / BT.2020 / PQ file: a transcode preserves 10-bit and its colour, a copy is unchanged, and a depth the encoder cannot reach fails loudly instead of downconverting.

**Manifest colour signalling.** `VIDEO-RANGE` (`SDR` / `HLG` / `PQ`) on `EXT-X-STREAM-INF`, and the CICP `SupplementalProperty` descriptors (colour primaries, transfer characteristics, matrix coefficients) on the DASH video AdaptationSet — both derived from the decoder config. Rendition selection happens before any media is fetched, so colour stated only in the media is colour no player can select on. A transfer function that cannot be named is left unstated rather than asserted as SDR, since an absent `VIDEO-RANGE` already implies SDR.

Verified against ffmpeg-generated HDR10 SEI NAL units (x265 master-display + max-cll) and against shaka's DoVi profile/level/brand logic; the `mdcv`/`clli` round-trip is verified end-to-end through the MP4 muxer + demuxer on real HEVC packets.

## Closed captions

CEA-608/708 caption byte pairs are carried in the video bitstream as `user_data_registered_itu_t_t35` SEI (ATSC A/53), spliced into each access unit that states them, for both AVC and HEVC. Captions are per-access-unit rather than track-static, so they are supplied per packet through `EncodedVideoPacketSource`, and the splice happens there rather than in a muxer — so ISOBMFF, HLS, DASH and MPEG-TS all carry them from one place.

Whether the manifest announces them is a required decision, not a default: `VideoTrackMetadata.closedCaptions` states which `INSTREAM-ID`s exist and whether to announce, producing `#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` plus `CLOSED-CAPTIONS` on the HLS variant and an `Accessibility` descriptor in DASH. A stream may carry captions no manifest mentions, which is a real shape worth being able to produce deliberately.

Captions on a track that did not declare them are refused, as is a track that declares them and delivers none — checked against the written bitstream rather than a flag, and raised before any manifest is written.

## Input side — read MPEG-DASH manifests

### DASH input pipeline

A full `application/dash+xml` reader mirroring the existing HLS input architecture, registered alongside HLS / ISOBMFF / Matroska / etc.

Format singletons + arrays: `DashInputFormat`, `DASH`, `DASH_FORMATS` (composes DASH with ISOBMFF, QuickTime, Matroska, WebM for segment-side demuxing).

Public AST: `parseMpd(xml) → Mpd` returns a typed AST — `Mpd`, `MpdPeriod`, `MpdAdaptationSet`, `MpdRepresentation`, `SegmentTemplate`, `SegmentList`, `SegmentBase`, `SegmentTimelineEntry`, `DashByteRange`, `ContentProtection`. Throws `MpdParseError` on malformed XML or missing required attributes. Reads XML with the global `DOMParser`, or, where the runtime has none (Node, Bun, Deno), with a built-in XML parser; `domParser` swaps in another implementation.

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

Low-Latency HLS: `#EXT-X-PART` partial segments are parsed onto the segment they belong to (`HlsSegment.parts`, with `DURATION`, `URI`, `BYTERANGE`, `INDEPENDENT` and `GAP`), and parts listed after the last segment, belonging to the segment still being written, onto `trailingParts`. `#EXT-X-PART-INF` becomes `partTarget`, `#EXT-X-SERVER-CONTROL` becomes `serverControl` (`CAN-BLOCK-RELOAD`, `PART-HOLD-BACK`, `HOLD-BACK`, `CAN-SKIP-UNTIL`), and `#EXT-X-PRELOAD-HINT` entries become `preloadHints`. `serializeHls` writes them back in spec order, and `hlsMediaPlaylist` / `hlsSegment` / `hlsPart` build them, declaring at least `#EXT-X-VERSION:9` once parts are present.

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

### Subtitle tracks on the read side

`Input.getSubtitleTracks()` returns `InputSubtitleTrack`s alongside the video and audio ones, and `SubtitleCueSink.cues(start, end)` yields `SubtitleCue` objects the way the sample sinks yield samples; `EncodedPacketSink` serves the raw bytes for a remux. ISOBMFF reads `wvtt` and `stpp`, Matroska reads `S_TEXT/WEBVTT` — and a track is created only when the sample entry is one the demuxer can actually decode, so a subtitle track is never reported whose cues cannot be read. A cue split across packets is rejoined by its `vsid` where the format states one, else by its own timing and text.

`Conversion` carries subtitle tracks through, converting between the codecs it supports since both are driven from the same cue representation. A subtitle track an output format cannot hold is reported in `discardedTracks` with a reason rather than dropped, as is a subtitle track under `tracks: 'primary'`, which selects primary video and audio only.

## Cross-cutting input additions

- **sidx box parsing** + `Input.getSegmentIndex` exposure — for CMAF and DASH segment-side index access.
- **`sidx`-seeded fragment lookup tables** — a fragmented file whose index is a `sidx` rather than an `mfra`/`tfra` (the DASH on-demand and CMAF single-file layouts) is now seekable through that index: the demuxer maps each subsegment reference onto a fragment lookup entry, so seeks and `computeDuration()` jump to the right fragment instead of walking the file `moof` by `moof` from byte 0. `tfra` still takes precedence where both are present.
- **MPEG-TS `computeDuration()` probes from the end of the file** — about 3 ranged reads regardless of file size, instead of one per binary-search step. When a track ends before the file does, the bytes past its last packet are read once rather than once per scan. Durations are unchanged.
- **Network prefetching grows when reading backwards** — reads that walk a file back to front (such as a demuxer rewinding to a track's previous packet) fetch exponentially larger blocks, the same way forward reads already do, instead of one fixed 64 KiB request per step.
- **`SidxBox` read-side derivation helpers** + `ByteRange` type export — for callers computing segment offsets from sidx.
- **ISO BMFF segment helpers** — `iterateIsobmffBoxes` walks boxes (64-bit and size-0 sizes, `uuid`, children by content range) and throws on truncation; `getInitSegmentTimescales` reads each track's media timescale from an init segment synchronously; `setSegmentDecodeTime` re-times a CMAF segment to an absolute start in seconds, per track in its own timescale, keeping the spacing of later `moof` chunks and throwing when a version 0 `tfdt` can't hold the value.
- **`Input` / `InputTrack`: pssh / tenc exposure** for re-emission — keep the original DRM box bytes available so downstream re-muxing or re-packaging can preserve them.
- **HLS port: `EXT-X-MEDIA` in input order** — fix ported from shaka b1580dd.
- **Packed audio timestamps** — the ADTS demuxer starts a file's timestamps at the 33-bit MPEG-TS timestamp in its leading ID3 `PRIV` frame (`com.apple.streaming.transportStreamTimestamp`, RFC 8216 §3.4), so HLS packed-audio segments sit on their media timeline instead of at rounded `EXTINF` time. Files without the frame still start at 0.
- **Start offset between renditions** — HLS and DASH inputs keep the offset between paired renditions: a rendition whose first sample comes after a paired rendition's (for example video 120 ms after audio) keeps that lag in its timestamps, instead of every rendition starting at its own playlist time. Renditions more than 0.5 s apart are treated as separate timelines.
- **HLS VOD and EVENT start time** — a `VOD` or `EVENT` media playlist with `#EXT-X-MEDIA-SEQUENCE` above 0 starts at its first segment's media time, since those playlist types never remove segments (RFC 8216 §4.3.3.5). Only a playlist without `#EXT-X-PLAYLIST-TYPE`, which may be a sliding live window, is still placed `MEDIA-SEQUENCE × TARGETDURATION` in when it has no `#EXT-X-PROGRAM-DATE-TIME`.
- **HLS I-frame playlists without `#EXT-X-MAP`** — an `#EXT-X-I-FRAMES-ONLY` playlist with no `#EXT-X-MAP` whose first I-frame has a byte range starting past offset 0 reads the bytes before that I-frame in the same resource as its init section, as RFC 8216 §4.3.2.5 allows, instead of failing with no `moov`. The same applies to the first I-frame after each `#EXT-X-DISCONTINUITY`. A first byte range at offset 0 and an explicit `#EXT-X-MAP` behave as before.
- **Video range only where signalled** — for H.264 and HEVC, `getColorSpace()` and the decoder config leave `fullRange` unset when the SPS carries no video signal type (as `VideoColorSpaceInit` allows), instead of reporting the spec's inferred limited range, so "not stated" is distinguishable from "limited". A remux of such a stream no longer gains a `colr` box claiming limited range. Streams that signal a range, and VP9, AV1, ProRes and Matroska, are unchanged.
- **CMAF/fMP4 segment primitives** — `isInitializationSegment(bytes)` (top-level moov-before-moof scan), `getSegmentDecodeTime(bytes)` (first `tfdt` baseMediaDecodeTime, v0/v1), and `rebaseSegmentDecodeTime(bytes, deltaTicks)` (shift every `traf`'s `tfdt` onto a continuous timeline, returning a new buffer, input untouched) — read and rewrite a fragment's decode timeline without a demux/remux.

## Manifest transform substrate — parse → transform → serialize

A unified, format-agnostic pipeline over the DASH (`Mpd`) and HLS (`HlsPlaylist`) ASTs: parse a manifest, run composable pure transforms, serialize it back. Two lossless format-specific ASTs behind one `Manifest` facade.

- **Facade:** `parseManifest(text, options?) → Manifest` (sniffs HLS vs DASH), `serializeManifest(manifest) → string`, `pipeManifest(manifest, transforms) → Manifest`. `Manifest` is a discriminated union (`{ format: 'dash', mpd }` | `{ format: 'hls', playlist }`); `ManifestTransform = (Manifest) => Manifest`.
- **Serializers:** `serializeMpd(Mpd) → string`, `serializeHls(HlsPlaylist) → string` — the round-trip complement to the parsers (reuse `XmlNode` / `Tag` and the shared duration + float formatting; `<BaseURL>` path-aware). Transforms are **pure**: a new manifest is returned, every untouched subtree shared by reference, so one parsed base spawns many variants cheaply.
- **Cross-format rendition filtering:** `Rendition` is a read-only view of a selectable rendition (DASH Representation, HLS variant, or `#EXT-X-MEDIA` group) so one predicate works against both formats. `filterRenditions(predicate)` is the core; atoms compose over it — `dropCodecs` / `keepCodecs`, `capResolution`, `filterBitrate`, `filterFramerate`, `filterChannels`, `dropByColorRange` (SDR / HLG / PQ), `dropSubtitles`. Dropping an HLS media group prunes now-dangling variant group references.
- **URL + structure rewrites:** `mapSegmentUrls((url, kind, index) => url)` rewrites every media-referencing URL by `SegmentUrlKind`; `rebaseManifest(base)` resolves relative URLs against a new base (DASH BaseURL chain preserved); `toSegmentTemplate(build)` repackages single-file (`SegmentBase`) DASH representations as `SegmentTemplate` + `SegmentTimeline`.
- **DRM signaling:** `drm(options)` injects content protection into a parsed manifest (DASH `<ContentProtection>` per system, HLS `#EXT-X-KEY` per system; multi-DRM in one manifest). Each format's rules live in one core shared with the generate/patch-path helpers — `buildContentProtections` / `buildHlsKeys` (from-scratch) and `patchMpdContentProtection` / `patchMediaPlaylistKeys` (format-preserving in-place string patch).
- Backing parser additions: DASH `AudioChannelConfiguration` / `SupplementalProperty` / `EssentialProperty` descriptors and HLS `VIDEO-RANGE`, plus the shared `parseChannelCount` helper.

**Round-trip fidelity for DASH.** `parseMpd` → `serializeMpd` keeps what the fork's own MPD writer emits: AdaptationSet `@width`, `@height`, `@par`, `@startWithSAP`, `@subsegmentStartsWithSAP`, `@segmentAlignment` and `@subsegmentAlignment`, the MPD's `xsi:schemaLocation`, and `<ServiceDescription>` (at MPD and Period level, with `<Latency>` and `<PlaybackRate>`) as `MpdServiceDescription`. Spec defaults such as `SegmentTemplate@startNumber="1"` are still written only when they differ from the default. Without a global `DOMParser`, `parseMpd` uses its built-in XML parser; `parseMpd(xml, { domParser })` still accepts another implementation.

## Faithfulness to shaka-packager

The HLS/DASH output ports are kept synced to shaka-packager and audited for 1:1 fidelity — logic mirrors shaka bit-for-bit, and shaka's unit tests are ported alongside each feature so behaviour is proven, not assumed. Last synced to **shaka-packager v3.8.0** (2026-07-03).

That sync pass corrected drift where our ports had fallen behind or over-simplified shaka: multi-period on-demand text `presentationTimeOffset` (shaka #1493/#1433), HLS master `DEFAULT`/`AUTOSELECT` computed per `(group, language)` with DVS + forced-subtitle handling, `SegmentTemplate` duration integer truncation, `#EXT-X-START:TIME-OFFSET` `%f` formatting, HLS language shortest-form reduction, DASH `ContentProtection` attribute precedence (later-set-wins, dedup via `RemoveDuplicateAttributes` upstream), full-proto `ProtectedContent` equality, and `GetStaticMpdDuration` float32 accumulation. It also added previously-unported subsystems: the HLS **live sliding window**, **CEA closed captions**, and **rendition index/group-id ordering**.

Intentional, documented deviations (everything else is a faithful mirror):

- **Path-aware `<BaseURL>`** — unencoded `/` in DASH `<BaseURL>` (see above); shaka URL-encodes them.
- **No-filesystem `RemoveOldSegment`** — the live window returns dropped segment names via `MediaPlaylist.getSegmentsToBeRemoved()` for the caller to delete, rather than performing `File::Delete`; the preserved-window buffer is trimmed unconditionally.
- **`HlsParams.discontinuitySequenceNumber`** — an initial-seed input the fork adds (shaka derives it purely internally); it seeds the member counter the sliding window then advances, kept additive so no upstream API changes.
- **`#EXT-X-TARGETDURATION` rounds to the nearest integer** — when no target is set, `MediaPlaylist` and the HLS output use the longest segment rounded to the nearest integer, which RFC 8216 §4.3.3.1 allows; shaka takes the ceiling, so a 4.004 s NTSC segment advertised 5.

## Versioning

`package.json` carries the upstream base version (currently `1.50.7`, tracking upstream `release`). The publish workflow strips any trailing `-beta.N`, then appends `-beta.<github.run_number>` to produce a monotonically increasing beta tag. Consumers should pin exact versions (`"@ahmedrowaihi/mediabunny": "1.50.7-beta.43"`) rather than tracking the floating `beta` dist-tag.

Two packages ship per release, stamped with the same `-beta.N`: `@ahmedrowaihi/mediabunny` and `@ahmedrowaihi/mediabunny-server`, the server-side decoder/encoder extension. The extension peer-depends on a package named `mediabunny`, so a consumer aliases the core to that name (`"mediabunny": "npm:@ahmedrowaihi/mediabunny@<exact version>"`). Install both from the same release — the extension's encoders and the core's expectations move together.

Resolve the core through one specifier only. The package exposes both a modules entry and a bundle entry, so an app resolving one while an extension resolves the other loads the library twice; each copy keeps its own codec registry, and codecs registered by the extension are then invisible to the app, which surfaces as `undecodable_source_codec` rather than as anything naming the real cause. The library logs `Mediabunny was loaded twice` when this happens.

The fork repo retains only the most recent **3 beta releases** (older ones are auto-pruned by the publish workflow). If you need an older beta that's been pruned, the npm tarball still resolves — only the GitHub Release page is cleaned.

Each publish creates a GitHub Release at `v<version>` containing the commit delta against upstream `release` at that point in time. See the [Releases page](https://github.com/ahmedrowaihi/mediabunny/releases) for per-publish breakdowns.

## License + attribution

The fork is MPL-2.0, matching upstream. The HLS and DASH output ports include `NOTICE` and `LICENSE.shaka-packager` attributions covering the Apache-2.0 code lifted from [shaka-project/shaka-packager](https://github.com/shaka-project/shaka-packager). All non-fork-specific work is upstream-contributable; the fork exists to ship features ahead of upstream PR cycles, not to diverge.
