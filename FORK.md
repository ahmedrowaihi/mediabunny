# Fork features — `@ahmedrowaihi/mediabunny`

This fork tracks [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) on `main` and ships features in advance of upstream landing them. Every push to the `publish-ahmedrowaihi` branch republishes the package as `@ahmedrowaihi/mediabunny@<base>-beta.<runNumber>` on npm and creates a corresponding GitHub Release with the per-publish commit delta. Every addition is **additive** — no upstream API is removed or renamed. Consumers can drop the fork in place of upstream `mediabunny` for any code using only upstream APIs.

This document states the fork's **current contract**: what it adds or changes relative to upstream, and the
constraints and units a consumer has to know. It is not a changelog — how something came to be is in git, and a
fact earns a place here only if acting on the code without it would be wrong.

```bash
# Drop-in: upstream imports (`from 'mediabunny'`) and examples keep working unchanged
npm install "mediabunny@npm:@ahmedrowaihi/mediabunny@beta"

# Or under the scoped name, importing from '@ahmedrowaihi/mediabunny'
npm install @ahmedrowaihi/mediabunny@beta
```

Use the aliased form if you also install `@ahmedrowaihi/mediabunny-server`. Its published code imports the
core as `mediabunny`, so a scoped-only install leaves two copies of the library in the tree: the server
registers its codecs on one instance while your `Conversion` holds the other, and every track is then
discarded with `undecodable_source_codec` rather than failing loudly.

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

**scte214 supplemental codecs.** `scte214:supplementalCodecs` and `scte214:supplementalProfiles` are stated on `RepresentationBaseType`, so `mpdRepresentation` and `mpdAdaptationSet` both take them, the serializer writes them from the shared base, and the parser reads them back. The `xmlns:scte214` declaration follows from the prefix being used, so an MPD stating neither carries no trace of it.

### Content steering, on both sides

HLS already carried steering: `#EXT-X-CONTENT-STEERING` parses and serializes via `HlsContentSteering` / `hlsContentSteering`, with `PATHWAY-ID` modelled on both variants and `#EXT-X-MEDIA` renditions.

DASH now matches it. `<ContentSteering>` is modelled as `MpdContentSteering` (`@defaultServiceLocation`, `@queryBeforeStart`, `@proxyServerURL`, `@clientRequirement`) and emitted in the position ISO/IEC 23009-1 gives it — after `InitializationPresentation`, before the first `Period`. The half that actually makes steering work is `@serviceLocation` on `<BaseURL>`, since that is what a pathway returned by the steering server is matched against; without it the element is decorative. That attribute is carried at every level that can hold a `BaseURL` — MPD, Period, AdaptationSet, Representation.

`baseURLs` is `MpdBaseURL[]` — the URL and its attributes in one value, at every level. That is a breaking change for anything reading `baseURLs` as `string[]`, and it was taken deliberately: the first cut kept `baseURLs: string[]` and added a parallel `baseURLEntries`, which broke `rebaseManifest` within the hour. It rewrote the strings, the attributes kept the originals, and the serializer emitted the un-rebased URL. Two lists of the same thing drift the moment anything rewrites one. DASH is fork-only here, so no upstream API was reshaped. Factories still accept plain strings (`mpdBaseURL` builds an entry when you need `serviceLocation`), and `resolveBaseURL` takes either form. Steering survives a parse → serialize round trip, which is what `dash-concat` and any read-modify-write path depend on.

Mediabunny reads and writes manifests rather than playing them, so this is emit-and-preserve: it will not fetch a steering manifest or switch pathways at playback time.

### Trick-play thumbnails, on both sides

Scrub-preview thumbnails, modelled rather than merely passed through.

**DASH.** A tile sheet is an `image` AdaptationSet whose Representation carries `<EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="COLUMNSxROWS">`. `mpdThumbnailTile` builds that descriptor and `readMpdThumbnailTile` reads a grid back out, returning `null` rather than throwing for a missing or malformed one. Packagers in the wild also emit the scheme without the `guidelines` path segment, so both spellings are accepted on read and only the canonical one is written — exported as `THUMBNAIL_TILE_SCHEME_ID_URI` and `THUMBNAIL_TILE_SCHEME_ID_URI_LEGACY`.

**HLS.** Three tags from the Image Media Playlist specification, which is not part of RFC 8216: `#EXT-X-IMAGE-STREAM-INF` on the master playlist (`HlsImageStream`, kept separate from `iFrameStreams` so an image rendition is never mistaken for an I-frame one), `#EXT-X-IMAGES-ONLY` on the image media playlist, and `#EXT-X-TILES` per segment (`HlsTiles`). The tile tag is emitted between a segment's `#EXTINF` and its URI, which is where the spec puts it and what makes it describe the image that follows.

One thing worth knowing when reading these: `RESOLUTION` on `#EXT-X-IMAGE-STREAM-INF` is the size of a single tile, not of the image actually fetched. The sheet is that size multiplied by the `LAYOUT` grid.

### `AdaptiveOutputFormat` — HLS + DASH from one CMAF pass

A new output-format wrapper that drives both `HlsOutputFormat` and `DashOutputFormat` from a single CMAF encoder pass. Segments and init segments are shared between the two manifests, so storage cost stays roughly equal to one-format output while consumers get both.

Public exports: `AdaptiveOutputFormat`, plus the existing `HlsOutputFormat`, `DashOutputFormat`, `HlsOutputPlaylistInfo`, `HlsOutputSegmentInfo`.

`separateRenditions: true` forces a lone video track paired with a lone audio track apart instead of collapsing them into one muxed variant: the audio becomes an `#EXT-X-MEDIA` rendition group in HLS and its own `<AdaptationSet>` in the MPD. A muxed variant exercises nothing of a player's audio-track selection, and a 1:1 pairing cannot express the split through `OutputTrackGroup` alone.

With `singleFilePerPlaylist: true`, one CMAF file backs both manifests at once: the HLS media playlist addresses it through `#EXT-X-MAP` and `#EXT-X-BYTERANGE`, and the MPD is emitted as an `isoff-on-demand` profile whose `<SegmentList>` carries an `<Initialization range>` plus one `<SegmentURL mediaRange>` per subsegment, over the same byte ranges. This is shaka's `use_segment_list` form of on-demand DASH, which needs no `sidx`.

Setting `sidxFragmentCapacity` on a `fastStart: 'fragmented'` segment format instead reserves room after `moov` for a Segment Index covering every fragment, written once the file is finalized and padded with a `free` box. The MPD then carries `<SegmentBase indexRange>` — one range rather than a `<SegmentURL>` per subsegment, which matters once an asset runs to thousands of them. Overflowing the declared capacity, or leaving it unset, falls back to the `<SegmentList>` form.

### Parameter set placement

`VideoEncodingAdditionalOptions.parameterSets` selects where an AVC or HEVC bitstream carries its parameter sets: `'outOfBand'` (the default) keeps them in the sample entry, `'inBand'` also repeats them throughout the bitstream so a player can join mid-stream without the sample entry. The ISOBMFF sample entry and the manifest `CODECS` string both follow the bitstream that was produced — `avc1`/`hvc1` when the parameter sets are out of band, `avc3`/`hev1` when they are in band — so a manifest never advertises a codec the file is not. The same rule applies on the read side: a demuxed `hvc1` track reports `hvc1`, not `hev1`.

`VideoTrackMetadata.parameterSets` carries the same choice across a remux, where there is nothing to encode. Packets given in Annex B format keep their parameter sets, so the muxer infers `'inBand'` for them; packets that repeat their parameter sets *and* come with a decoder config are byte-for-byte indistinguishable from packets that do not, so there the field is the only signal. Without it, such a track can only be written as `avc1`/`hvc1`, which understates what the samples carry. Declaring `'outOfBand'` for Annex B packets is rejected rather than written, since the muxer does not strip them.

### The selected encoder is named

The server encoder emits one `Logging` info line per track when it picks its codec — `Encoding 'avc' with h264_videotoolbox.` — because which encoder ran decides byte-reproducibility (hardware encoders are not deterministic, and a `Quality` routes to software while a numeric `bitrate` leaves hardware eligible), and nothing else reports it. Listen with `Logging.on('info', ...)`; the payload is `unknown[]` — the console-style args, not a pre-joined string — so join at the boundary (`args.map(String).join(' ')`) rather than typing it as a string.

### Key frames from the server encoders

With `@mediabunny/server`, a video track's key frames are exactly the ones `keyFrameInterval` forces. libx264, libx265, libvpx (VP8/VP9) and SVT-AV1 no longer add key frames of their own, whether from scene-cut detection or from a fixed 60-frame GOP that put one 1.2 s after every forced key frame at 50 fps. A forced libx265 key frame is a closed-GOP IDR rather than a CRA followed by RASL pictures, so a segment starting at any key frame decodes on its own. The frame rate handed to the encoder is an exact rational (24000/1001 rather than a rounded 24), so x265 signals it exactly.

### Capped quality from the server encoders

`Quality` takes `maxBitrate` (and optionally `bufferSize`, default twice `maxBitrate`) alongside `quality` or `quantizer`: quality-driven encoding that holds the quantizer until holding it would exceed a peak bitrate, the rate control known as capped CRF, and as QVBR in AWS Elemental encoders. `@mediabunny/server` maps it to `crf` + `maxrate` + `bufsize` on x264 and x265, `crf` + `maxrate` on SVT-AV1, constrained quality (`crf` with the cap as the target bitrate) on libvpx-vp9 and libaom-av1, and `rc=vbr` + `cq` + `maxrate` on NVENC; rav1e has no such mode. WebCodecs has none either, so there a `bitrate` fallback applies, or, for a qualitative `quality`, bitrate-based encoding at no more than `maxBitrate`. Without `maxBitrate`, `Quality` behaves as before.

`VideoTransformationOptions.preProcess` and `ConversionVideoOptions.preProcess` run a caller's function on each decoded sample *before* the size check, the resize, the rotation, the crop and the frame rate correction, where `process` runs after all of them. Deinterlacing needs that position: run after a resize, it interpolates across the two interleaved fields and the comb is baked in. It takes and returns what `process` does — a sample, a resource, a `CanvasImageSource`, an array of them for a frame that becomes several, or `null` to drop one — and whatever it returns is what the size check and the transformation then see. Setting it forces a transcode and bakes rotation into the samples, as `process` does.

**Both hooks can be drained.** `preProcessFlush` and `processFlush` take a function of no arguments returning an array of `VideoSample`s, called once after the track's last frame has passed through the hook they belong to. A stateful hook needs it: a deinterlacer emits frame N only once it has been handed N+1, and a filter graph buffers, so without a flush those held frames are encoded by nobody and the graph is never torn down. A caller cannot stand in for it by counting frames — the count differs under frame rate conversion, a trim and field-coded input. Each hook drains where its own output enters the pipeline, so `preProcessFlush` output is transformed, frame rate corrected and padded past exactly as the hook's per-frame output is, while `processFlush` output goes straight to the encoder after the last padding frame. The returned samples must carry their own timestamps, since there is no input frame to take one from, and they are closed once encoded. Setting either forces a transcode: a hook with frames still held adds samples the copied packets do not have.

It also runs at the output's own size, where nothing needs re-rendering. Conversion probes the encoder there with one decoded sample to learn whether it accepts the format, and that probe is built before the hooks are attached — so it tested a frame the encoder would never see, and a caller demanding a colour space the source lacks, which is precisely what a tone-mapping or LUT hook supplies, got `DeclaredColorSpaceMismatchError` out of `Conversion.init` with the hook never called once. The probe is skipped where a `preProcess` hook is set: the hook owns the frames' format, so a genuine refusal surfaces from the encoder rather than from a guess about an unprocessed frame.

A quantizer without a cap is constant quality too, which is what the option documents ("like FFmpeg's constant-rate factor"). x264, x265 and SVT-AV1 were given `qp`, and every crf-based encoder had its quantizer range pinned to the requested value, so the uncapped path was fixed-QP encoding: the same quantizer spent on detail no viewer sees, 2.33 MB against 0.99 MB for `test/public/video.mp4` at the same number on x264. They are now put in their constant-quality mode with the range left open, which is readable from x264's and x265's own settings SEI (`rc=crf`, `qpmin=0`). rav1e and NVENC keep fixed QP, having no verifiable constant-quality mode here.

A stated `bufferSize` warns rather than being dropped in silence, for every encoder whose capped mode has no buffer model — libvpx-vp9, libaom-av1 and the NVENC encoders, which FFmpeg's wrappers either bound over the stream or discard the buffer size outright. For libvpx-vp9 that was measured — `rc_buffer_size`, `overshoot-pct`, `maxsection-pct` and `minsection-pct` each leave its output byte-identical. Passing SVT-AV1's `mbr`/`buf-sz` through `svtav1-params` was measured too and rejected: it replaces FFmpeg's own rate control, and the worst 2 s window went from 1.17 of the cap to 5.06.

Encoders are given a frame rate even when the output track declares none: the first sample's duration stands in for it. x265, SVT-AV1 and libvpx budget bits per frame from that rate rather than from timestamps, so a `Conversion` that left it unset (which upstream mediabunny also does) told them 30 fps and missed bitrate caps and targets: about 1.4 to 2 times over at 50 fps, and short of them at 24 or 25 fps.

### Decoders and encoders use every core, and filter graphs are reused

libavcodec defaults `thread_count` to 1 — the ffmpeg CLI defaults it to 0 and that difference is most of the decode time on large frames. Both the decoder and the encoder now set it to 0. On a real 4K source (Big Buck Bunny 2160p30, H.264 High L5.1, 9.3 Mbps, 20 s) decoding goes from 71 to 403 frames per second.

`transformVideoSample` built, configured and freed a complete libavfilter graph for every frame of every rendition — 1809 graphs for a 20 s three-rung ladder, and about a third of all filter CPU spent on construction rather than scaling. Graphs are now kept in a bounded cache keyed by source format, dimensions, colour and the filter chain, which is exactly what stays constant across the frames of a transcode. Together with the thread count, an x264 ladder of 1080p/720p/480p from that 4K source goes from 37.6 s to 10.7 s, 3.5x, measured A/B interleaved in one process because this kind of benchmark drifts badly with machine temperature.

The cache never makes a caller wait: a graph holds one frame at a time, so a second concurrent transcode of the same shape builds its own rather than queueing — serialising on a shared graph makes independent jobs contend. Reuse is sound only because every filter this path builds (scale, crop, pad, transpose, hflip, setsar) is 1:1 and non-delaying; a buffering filter would strand frames in the graph.

A hardware encoder is unaffected by either change — a 5-rung VideoToolbox ladder topping out at 2160p measured the same before and after, because the encoder, not the pipeline around it, is the bottleneck there.

### ABR ladders decode once

`encodeVideoLadder({ track, rungs, keyFrameInterval, signal })` encodes one input video track into N renditions, decoding it a single time and fanning each decoded frame out to every rung's encoder concurrently. On a 4-rung ladder (720p/480p/360p/240p off a 1080p source, h264_videotoolbox) it runs 2.4–2.9x faster than a `Conversion` per rung in a loop and 1.2–1.7x faster than N `Conversion`s run in parallel, with one decoder and one read of the input instead of N of each. The outputs are the same renditions, within 150 bytes of the per-`Conversion` ones. Most of the serial win is the decode itself: a warm decode of that source is about 670 ms of the 5.4 s the loop takes.

The rungs are what a player needs in order to switch between them, by construction rather than by the caller's care: every rendition is given the same `keyFrameInterval` (a rung that sets its own is refused with an `InvalidUsageError`) and sees the same frames, so their key frames land on the same timestamps. `latencyMode` is forced to `'quality'`, which forbids the encoder from dropping frames to hold its bitrate — a rung that drops one falls out of step with the rest and the ladder stops being switchable. Audio is not part of the ladder; it belongs in its own `Output`, which is what HLS and DASH want anyway.

Fanning one decoded frame out to several scaling encoders was broken in `@mediabunny/server` before this: libavfilter's `buffersrc_add_frame` unrefs the frame it is handed, and the transform path handed it the sample resource's own `AVFrame`, so the first rendition's resize emptied the frame for every other rendition cloned off that decode (`Failed to create filter: Invalid argument`, from a buffer source configured `video_size=0x0`). It now pushes an `av_frame_ref` into the graph and lets the graph consume that. The encoder path had always reffed correctly; only the filter path did not, which is why one encoder per decode never saw it.

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

**CMAF / fMP4 (CENC).** `encryptCmaf` (self-contained file, fragmented `moof`/`mdat` or progressive `moov` sample table) and `encryptCmafInit` + `encryptCmafSegment` (split init + media segments). Handles sample encryption, the `senc`/`saiz`/`saio`/`tenc`/`sinf` boxes, and the `encv`/`enca` sample-entry transform. Because inserting those boxes moves the media, every index over it is restated: `trun` data offsets, `tfhd` base data offsets, `sidx` distances (front or chained, including references spanning several fragments), `tfra` fragment offsets, and `stco`/`co64` chunk offsets for every track. A track fragment holding several `trun` boxes has all of its runs encrypted. The split segment API takes an `ivState` map carrying each track's IV sequence forward, so per-segment output matches whole-file output byte for byte. Schemes `cbcs`, `cenc`, `cens`, `cbc1`. Video H.264/H.265 (real NAL/slice-header parsing, incl. multi-slice pictures), AV1 (tile subsamples), VP9 (uncompressed-header); audio AAC/AC-3/E-AC-3 (whole-sample) and AC-4 (TOC + pattern). Exports: `encryptCmaf`, `encryptCmafInit`, `encryptCmafSegment`, `EncryptCmafOptions`, `ProtectionScheme`. On Node the AES-CTR schemes (`cenc`/`cens`) run their whole-block runs through `node:crypto` instead of the JS keystream, which is ~4x on a 10 MB fragmented file (320 ms -> 24 ms; the JS path, and therefore the browser, is ~92 ms). It is selected per run: mid-block starts, partial trailing blocks and runs that would carry past the low 64 bits of the counter stay on the JS keystream, since CENC wraps there where `node:crypto` carries. Output is byte-identical either way, and `node:crypto` reaches the browser bundle no more than `node:fs` does — it is exported from `src/node.ts` and mapped to `false` in the `browser` field. Pattern-mode (`cbcs`/`cbc1`) is unchanged: it encrypts one block in ten, so a native cipher per block measured slower than the JS one it would replace.

**Refusing rather than appearing to work.** `encryptCmafSegment` refuses bytes holding no fragment — an init segment passed by mistake, an `mdat` alone, 16 bytes of garbage — with a `MalformedInputError`, rather than returning its input unchanged and letting the caller publish clear bytes believing they were protected. A `trun` naming sample bytes outside its own `mdat` is refused the same way. A video sample entry carrying neither an `avcC` nor an `hvcC` — `mp4v`, an unknown FourCC — raises `UnsupportedMediaError` instead of dereferencing null; the codec is now decided by which configuration record is present rather than by a list of FourCCs, which is also what makes the Dolby Vision entries (`dvh1`, `dvhe`, `dvav`, `dva1`) encrypt as the HEVC and AVC they are. An `ac-4` sample entry maps to AC-4 rather than falling through to AAC, which would have skipped its TOC parse and pattern encryption.

**Validating slice headers without encrypting.** `checkSliceHeaders(segment, init)` parses every H.264/H.265 slice header in a fragmented media segment and throws `MalformedInputError` when a NAL unit, a slice header, or the init's `avcC`/`hvcC` does not read — no cipher, no output, the caller's bytes untouched. Encryption has to find the boundary between a slice header and its slice data, so it already rejects media it cannot parse; a pipeline that protects a segment some other way (AES-128 over whole segment bytes, or the SAMPLE-AES muxer, neither of which reads slice headers) wanted that check without running the encryptor for its parse and discarding the result. A trun naming sample bytes outside its own `mdat` is refused here too. Tracks without slice headers — AV1, VP9, audio — are skipped, so an init describing none of them is a no-op rather than an error.

**Length prefixes are not trusted.** A length-prefixed NAL unit may claim more bytes than the packet holds — all-`0xFF` data claims 4 GiB — and the subsample generator sized its output from that, so a few kilobytes of publisher-supplied segment produced megabytes of encrypted output. `iterateNalUnitsInLengthPrefixed` now never reports a NAL running past the end of its packet.

**MPEG-TS SAMPLE-AES.** `MpegTsOutputFormat` takes a `sampleAesEncryption` option (`key`, `iv`) and encrypts as it muxes, which is what an `#EXT-X-KEY:METHOD=SAMPLE-AES` rendition needs. H.264 coded-slice NAL units of type 1 and 5 longer than 48 bytes are encrypted from byte 32 in the 1-in-10 block pattern, and AAC frames are encrypted after the ADTS header and a 16-byte clear leader. PES headers, ADTS headers, parameter sets and the access unit delimiter stay clear, so the stream is still cut and indexed without the key; only the payload is opaque. The PMT signals it the way Apple specifies: `stream_type` 0xDB for H.264 and 0xCF for AAC, a `private_data_indicator_descriptor` carrying `'zavc'` and `'aacd'`, and for audio a `registration_descriptor` carrying `'apad'` and an `audio_setup_information()` of `'zaac'`, priming, version and the AudioSpecificConfig.

It encrypts during the mux rather than as a pass over finished bytes because it cannot be the latter: encryption strips emulation prevention, which changes NAL lengths, which changes PES payload sizes and the packet count, so a finished-TS-in/finished-TS-out function would have to repacketize the whole segment. Apple specifies no combination other than H.264 and AAC, so anything else in the output is refused with an `UnsupportedMediaError` rather than written in the clear — a muxer that silently emits a clear track from an encrypted output is worse than one that fails.

`sampleAesEncryptAnnexBAccessUnit` and `sampleAesEncryptAdtsFrame` are exported for callers doing their own framing. They differ from the lower-level `sampleAesEncryptVideoNal` in that the Annex B one re-applies start code emulation prevention over the whole encrypted NAL, as the spec requires and as Annex B needs: ciphertext containing `00 00 01` would otherwise read as a start code and split the NAL. `sampleAesEncryptVideoNal` leaves its result stripped, which is right for length-prefixed CMAF and wrong for anything that scans for start codes.

Reading it back is out of scope: 0xDB and 0xCF are not the clear stream types, so this library's own demuxer finds no decodable track in an encrypted stream rather than handing back ciphertext as if it were media.

**`pssh` in the init.** `EncryptCmafOptions.pssh` takes complete `pssh` boxes — from `buildWidevinePssh`, `buildPlayReadyPssh` or `buildCommonPssh` — and writes them into the init's `moov` after the traks, where shaka-packager puts them. For players that take their init data from the manifest (`<ContentProtection>`, `#EXT-X-KEY`) none is needed, so the option is opt-in and the output is byte-for-byte unchanged without it. The boxes are added before the index fix-ups, so a progressive file's `stco`/`co64` chunk offsets are restated for the larger `moov` rather than left pointing short.

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

### Stating a protected segment's chunk ranges without encrypting it

`cmafEncryptedLayout(init, segment, options)` returns the {@link IsobmffChunkInfo} list the segment
would have *after* encryption, without running the cipher — so it equals
`chunksOf(encryptCmafSegment(init, segment, options), init)`.

A protected low-latency playlist has to publish `EXT-X-PART` byte ranges as served, and encryption
grows each `moof` by its aux-info boxes: `senc` (16 + Σ(iv + 2 + 6·subsamples)), `saiz` (17, or 17 + S
when sample entries differ), `saio` (20), and `sgpd`/`sbgp` when a fragment's kid differs from the
default. For cenc video the subsample count per sample comes from the slice headers, so the growth is
not closed-form and an origin otherwise has to encrypt every segment on each playlist request to
learn it — the cipher being the expensive part, and the layout not depending on its output.

The layout is not a second size formula: `SampleEncryptor.describeSample` is the one place subsamples
and the IV are decided for both paths, and the layout builds exactly the boxes the encryptor builds
with the cipher switched off, then measures those. The suite asserts the two agree for audio with
video, H.264 and H.265, cenc and cbcs, with and without a non-default-kid period, and for multi-chunk
as well as single-fragment segments; it also asserts the layout path never calls `crypt` on any of the
three cipher implementations, and that those spies do fire on a real encryption so the check is not
vacuous. The caller's `ivState` is read and never written.

## HDR / colour signaling (ported from shaka-packager)

Byte-domain readers and box builders for HDR metadata — no pixel processing.

**Dolby Vision.** `parseDoviConfigRecord` and `serializeDoviConfigRecord` read and write a `dvcC` / `dvvC` / `dvwC` configuration record (profile, level, RPU/EL/BL flags, base-layer signal-compatibility id); `doviConfigBoxName` picks the box the profile calls for (`dvcC` up to 7, `dvvC` for 8 to 10, `dvwC` above); `doviSampleEntryFourCc` picks the sample entry, which is the plain `hvc1`/`hev1`/`avc1`/`avc3` for a cross-compatible base layer and `dvh1`/`dvhe`/`dva1`/`dvav` for a non-compatible one, while `doviSupplementalFourCc` always gives the Dolby one, which is what a codec string names — `doviCodecString(doviSupplementalFourCc('hevc', inBand), config)` is the `dvh1.08.02` for `SUPPLEMENTAL-CODECS` and `scte214:supplementalCodecs`; `doviCodecString` derives the `dvhe.NN.NN` codec string; `doviCompatibleBrand` derives the compatible brand FourCC from the compatibility id + transfer characteristics. Mirrors shaka's `DOVIDecoderConfigurationRecord`. Exports: `parseDoviConfigRecord`, `serializeDoviConfigRecord`, `doviConfigBoxName`, `doviSampleEntryFourCc`, `doviCodecString`, `doviCompatibleBrand`, `DoviConfig`.

**The RPU rides on the frame.** `VideoSample.dolbyVisionRpu` carries one frame's RPU as a complete HEVC NAL unit — header and emulation-prevention bytes included, no start code or length prefix — settable in the constructor or through `setDolbyVisionRpu`, and propagated by `clone()` and `transform()` like `closedCaptions`. `@mediabunny/server`'s decoder states what it found, taking libavcodec's RPU side data (which arrives without the NAL header) and wrapping it; WebCodecs surfaces nothing of the kind. An encoder writes it back ahead of the frame's VCL NAL units, where it follows any in-band parameter sets, and `VideoTrackMetadata.dolbyVision` is what puts the configuration record in the sample entry — the encoder itself knows nothing of Dolby Vision. A codec that cannot carry one warns once and drops it rather than failing the encode, as an ABR ladder hands the same sample to every rung.

Unlike the captions, which a track may carry without declaring, an RPU is **dropped unless the track declares the record**: RPUs with no record describe nothing a player can act on, and a rung whose picture was tone mapped or run through a LUT would otherwise state the source's RPUs over a different image. `ConversionVideoOptions.dolbyVision` declares it for a transcode and is never inherited from the input — a rung is a different picture at a different resolution, so its level is the caller's to state. A non-cross-compatible declaration is refused there, since profile 5's IPT-PQ-c2 base is not something an encoder produces.

**A non-compatible base layer states the Dolby codec.** `blSignalCompatibilityId` 0 — profile 5 — means the base layer is IPT-PQ-c2 and not decodable as plain HEVC or AVC, so `getCodecParameterString()` and the codecs in `getMimeType()` give `dvh1.05.NN` rather than the `hvc1.…` its sample entry would suggest; a manifest repeating the latter tells a non-DV player to decode IPT as HEVC and show the wrong colours. `getDecoderConfig().codec` keeps the HEVC/AVC string, since that is what a decoder is handed and what the base layer in fact is. `getMimeType()` therefore composes its `codecs` from each backing's metadata codec string where it states one, falling back to the decoder config's, rather than reading the decoder config alone.

**Dolby Vision survives a remux.** The MP4 demuxer reads the configuration box under any HEVC or AVC sample entry — including `dvh1`, `dvhe`, `dva1` and `dvav`, which it resolves to plain HEVC/AVC with the parameter-set placement their suffix states — into `getDecoderConfig().dolbyVision`. The MP4 muxer and the segmented/CMAF writer re-emit it from that field, in the box the profile calls for, and choose the sample entry from the compatibility id: a backward-compatible profile 8 keeps `hvc1` so a non-DV player still decodes the base layer, while a profile 5 track stays `dvh1`. With no `dolbyVision` field nothing is written, as for `mdcv`/`clli`. The RPU NAL units ride in the bitstream and are never touched, so a track whose box was dropped kept its RPUs and read as plain HDR10 — which is what this fixes.

**HDR10 static metadata.** `parseSeiHdrMetadata(seiNalUnit, codec)` extracts mastering-display (SEI 137, SMPTE ST 2086) and content-light (SEI 144, CTA-861.3) from one AVC or HEVC SEI NAL (emulation-prevention stripped); the two differ only in NAL header length, which `SeiCodec` selects. `parseMasteringDisplayMetadata` / `parseContentLightLevel` parse the raw payloads; `buildMdcvBox` / `buildClliBox` emit the ISOBMFF `mdcv` / `clli` signaling boxes. Exports: `parseSeiHdrMetadata`, `parseMasteringDisplayMetadata`, `parseContentLightLevel`, `buildMdcvBox`, `buildClliBox`, `SeiCodec`, `MasteringDisplayMetadata`, `ContentLightLevel`, `HdrStaticMetadata`.

**Both carriages on write.** AVC and HEVC output state HDR10 static metadata in the container `mdcv`/`clli` boxes and as a prefix SEI on each key packet, because real HDR10 usually carries both and a player that reads one and ignores the other would otherwise see no HDR. The SEI is spliced after the parameter sets, emulation-prevented, and written only for fields the access unit does not already state — a packet carrying its own SEI passes through byte for byte, and a stream with no HDR metadata is not touched at all. Both carriages die with the HDR transfer, from the same condition.

**ISOBMFF round-trip.** The MP4 demuxer reads `mdcv` / `clli` sample-entry boxes into `getDecoderConfig().hdrStaticMetadata`, and the MP4 muxer re-emits them from the same field (gated on presence, like `colr` — no boxes and byte-identical output when absent). So HDR10 static metadata survives a transmux. When an HEVC track states a PQ or HLG transfer but carries neither box - the shape ffmpeg's mp4 muxer produces, which leaves the values only in the bitstream - the demuxer reads the missing half out of the first access unit's SEI instead. The probe costs one packet read and is skipped entirely for any track not already claiming an HDR transfer; the boxes, when present, win.

**Encode-side colour and bit depth.** `VideoEncodingAdditionalOptions.bitDepth` and `.colorSpace` (mirrored on `ConversionVideoOptions`) state what the encoder should produce. The codec string derives its profile from the bit depth — AVC High 10, HEVC Main 10, VP9 profile 2, AV1 Main at 10 bits — instead of pinning 8-bit, and a codec/bit-depth pairing with no profile is refused rather than silently downconverted. `Conversion` inherits both from the input track, so a transcode no longer drops the colour it just read. An inherited bit depth follows the decoded samples, not the source profile, so an 8-bit stream in a 10-bit-capable profile (High 10, High 4:2:2/4:4:4, Main 10) is re-encoded at 8 bits unless a depth is requested.

The server encoder tags what it produces, and for a while it did not. Upstream `#553` and `#572` had both been
reverted here by a rebase: the encoder wrote **no colour description at all** for RGB input — `decoderConfig.colorSpace`
entirely null, no SPS VUI, no `colr` box — and `AvFrameVideoSampleResource.toRgbSample` converted every decoded YUV
frame to RGB through swscale's legacy path, which ignores a frame's tags and always uses the BT.601 matrix, so
correctly tagged BT.709 content came back shifted. Both halves are restored: RGB input is retagged into limited-range
BT.709 (BT.2020 NCL, or the SD matrices, when the primaries say so), the scale contexts are left unconfigured so
`sws_scale_frame` honours the frames' colour instead of `getContext`/`initContext` defaulting to BT.601, and primaries
and transfer are mirrored onto the source frame so swscale does the matrix rather than a real transfer conversion.
Upstream's four colour-space tests cover it; three of them are red without the restore.

One assertion in them is deliberately not upstream's. `transferForOutputBitDepth` clamps a `pq` or `hlg` transfer away
when the output has fewer than 10 bits, warning as it does, because an 8-bit stream cannot carry a transfer function
that needs 10 — so the fork states no transfer where upstream passes `pq` through. That clamp is an addition upstream
does not have rather than superseded behaviour, so it stays and the two expectations are declared divergences.

Restoring the scale path moves bytes, for any path where the encoder's dimensions differ from the frame's and not
only for RGB input, because the frame-based path resolves a sharper image than `SWS_FAST_BILINEAR` did. That tipped
`av1 capped quality stays within its bitrate cap` into depending on ambient CPU: it held inside 1 under the full suite
and measured 1.160-1.172 across five runs on its own. A test whose result turns on how busy the machine is cannot tell
a regression from load, so AV1 now carries its own stated allowance of 1.25 in that test while the others keep 1.
SVT-AV1's capped CRF approximates the buffer model instead of enforcing it; x264 and x265 are a true VBV and libvpx
caps over the stream, which is why only AV1 needs the tolerance. The allowance still catches a real failure with room
to spare: with capping disabled the same measurement reads 4.91, so AV1's bound fails by a factor of about four.

Only an encoder knows what it produced, so an encoder either produces the depth it was asked for or refuses, naming itself and the depth; with no depth requested it preserves the incoming frames' depth rather than forcing 8-bit. Whether a value was demanded by the caller or inherited from the input is carried alongside it, because a codec string names a profile and every profile implies a depth, so a config alone cannot say which. An inherited value is kept only where the samples reaching the encoder still back it — a canvas re-render hands over 8-bit sRGB and loses both, a scaler that stays in YUV keeps them. A demanded value is never quietly dropped: PQ and HLG are defined from 10 bits up, so demanding one alongside a shallower depth is refused rather than written, while an inherited transfer a demanded depth cannot carry is left unstated. Encoder support reflects that, so a codec is not reported as encodable at a depth its encoder cannot deliver. The encoder also states the colour it encoded, which makes a caller's declaration a consistency check rather than an assertion: a contradiction is an error, and a declaration is only filled in where the encoder stated nothing. Paths that genuinely change the samples — a 2D canvas re-render yields 8-bit sRGB — drop inherited colour and depth along with the bytes they described. Together these mean a stream cannot come out carrying a label its samples do not support.

Colorimetry survives a geometric transform. In libavfilter the matrix coefficients and the color range are link properties rather than frame properties, so a filter graph whose buffer source does not state them hands back frames with those two unstated while primaries and transfer ride through untouched — every rescaled rendition then loses its matrix. The buffer source now states what the source frame stated, so a resize keeps the colour it started with and an unspecified source stays unspecified.

Verified end to end against a real x265 Main 10 / BT.2020 / PQ file: a transcode preserves 10-bit and its colour, a copy is unchanged, and a depth the encoder cannot reach fails loudly instead of downconverting.

**Manifest colour signalling.** `VIDEO-RANGE` (`SDR` / `HLG` / `PQ`) on `EXT-X-STREAM-INF`, and the CICP `SupplementalProperty` descriptors (colour primaries, transfer characteristics, matrix coefficients) on the DASH video AdaptationSet — both derived from the decoder config. Rendition selection happens before any media is fetched, so colour stated only in the media is colour no player can select on. A transfer function that cannot be named is left unstated rather than asserted as SDR, since an absent `VIDEO-RANGE` already implies SDR.

Verified against ffmpeg-generated HDR10 SEI NAL units (x265 master-display + max-cll) and against shaka's DoVi profile/level/brand logic; the `mdcv`/`clli` round-trip is verified end-to-end through the MP4 muxer + demuxer on real HEVC packets.

**HDR10 static metadata is read from the bitstream, not only from the boxes.** A transport stream has no
sample entry, so the mastering display and content light of an HDR10 grade arrive only as SEI 137 and 144;
the MPEG-TS demuxer reads them off the first access unit and states them as `hdrStaticMetadata`, the shape
the ISOBMFF path already used. Unlike that path — where the SEI is a fallback behind `mdcv`/`clli` and is
gated on the SPS declaring a PQ or HLG transfer, so an SDR track pays nothing — the MPEG-TS read is
ungated: there are no boxes to fall back to, a gate would drop a grade whose SPS understates the transfer,
and it runs once per stream. Both paths now read AVC as well as HEVC, so an AVC HDR10 file whose grade
lives only in its bitstream states it in either container.

### RIST input

`RistSource` reads a RIST Simple Profile stream (VSF TR-06-1) — the shape MediaConnect speaks — as an
MPEG-TS byte stream, in TypeScript over `node:dgram` rather than through FFmpeg, whose build here has no
librist. RTP on the URL's even port carries the transport stream; RTCP on the next port carries the NACKs
that ask for what was lost, as both TR-06-1's range NACK (an RTCP APP packet named `RIST`) and RFC 4585's
generic NACK, sent together so a sender may answer either. The receiver answers a sender's SR with an
RR and an SDES CNAME, which is what tells the sender where to send.

`bufferMs` is the latency: a packet waits that long for the ones before it, which is also how long a lost
one has to be retransmitted, and it is the delay before the first packet is released — until the buffer has
filled once, the lowest sequence seen is not known to be the lowest there is. Past that deadline the gap is
given up, the stream continues, and the demuxer resyncs on the next sync byte rather than stalling.
Sequence comparisons are signed 16-bit, so loss and reordering across the 65535 to 0 wrap behave as
anywhere else. Packets lost before the first one to arrive are the exception: until something arrives there
is no sequence number to count back from, so they are never asked for and the demuxer resyncs past them.
`readTimeout` ends a silent stream and disposing closes both sockets.

`mode: 'caller'` binds an adjacent port pair rather than two ephemeral ports: a caller is found by the
address its RTCP comes from, so a sender derives the media port as the control port minus one.

Loss, reorder, wrap and retransmit are tested against `test/node/_rist-sender.ts`, a sender written here
from the spec, so on their own those tests prove only that the receiver matches that reading of TR-06-1.
The independent control is libavformat's own `rtp_mpegts` muxer, which supplies the framing, the random
sequence start and the SR; librist 0.2.20 answers the NACK compound and retransmits every sequence number
asked of it, including across the wrap, which is checked downstream rather than by a test here. One bug the spec reading did catch: RTCP states a packet's length in
32-bit words *minus one*, and the range NACK was a word long, so a sender decoded a trailing zero as a
request for sequence 0.

## Closed captions

CEA-608/708 caption byte pairs are carried in the video bitstream as `user_data_registered_itu_t_t35` SEI (ATSC A/53), spliced into each access unit that states them, for both AVC and HEVC. Captions are per-access-unit rather than track-static, so they are supplied per packet through `EncodedVideoPacketSource`, and the splice happens there rather than in a muxer — so ISOBMFF, HLS, DASH and MPEG-TS all carry them from one place.

Whether the manifest announces them is a required decision, not a default: `VideoTrackMetadata.closedCaptions` states which `INSTREAM-ID`s exist and whether to announce, producing `#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` plus `CLOSED-CAPTIONS` on the HLS variant and an `Accessibility` descriptor in DASH. A stream may carry captions no manifest mentions, which is a real shape worth being able to produce deliberately.

Captions on a track that did not declare them are refused, as is a track that declares them and delivers none — checked against the written bitstream rather than a flag, and raised before any manifest is written.

**Captions are carried by the frame.** `VideoSample` states them in `closedCaptions`, beside the `encodeOptions` it already carries: settable in the constructor or through `setClosedCaptions`, propagated by `clone()` and by `transform()` — a resized frame still carries what was in the picture, so every rendition of an ABR ladder keeps the captions. `CanvasSource.add` takes them as a trailing argument, since it builds the sample for you.

That makes one path for every producer and one writer. `@mediabunny/server`'s decoder states the A/53 captions it found in the bitstream on the sample it hands back; its encoder strips the side data off the frame before the native encoder sees it, because the encoders disagree — libx264 writes it, libx265 drops it silently, and the VideoToolbox encoders error out of `sendFrame` ("Unexpected end of SEI NAL Unit parsing type") and take the encode down. The core then writes the caption SEI onto the encoded packet, matched to the frame on the microsecond timestamp the two share, since an encoder emits packets in decode order. So captions survive a transcode the same way whichever encoder is selected, and a `process` hook that re-renders or splits a frame decides for itself which output carries them.

**The read side is public.** `parsePacketClosedCaptions(packetData, decoderConfig, codec)` returns the caption byte pairs an encoded AVC or HEVC packet carries in its ATSC A/53 SEI messages, or `null` for one that carries none — the NAL walk, the emulation-prevention stripping, the SEI payload walk and the `cc_data` parse that a reader would otherwise write itself. `decoderConfig` states the NAL length prefix size; Annex B data is walked by start code. Exports: `parsePacketClosedCaptions`, `ClosedCaptionBytePair`, `ClosedCaptionChannel`, `ClosedCaptionsMetadata`.

Declaring is what makes a manifest announce captions, not what permits them: a frame may carry captions `VideoTrackMetadata.closedCaptions` does not declare, and no manifest then mentions them. The reverse is still refused — a track that declares them and delivers none fails before any manifest is written, as does a packet that would end up with two disagreeing caption SEIs.

A custom encoder's `flush` is awaited and its errors are routed like its `encode` errors. It was neither: a buffering encoder — SVT-AV1, or x264 with a lookahead — emits every packet from `flush`, so `finalize()` returned without waiting for the encoder's own queue, and an error raised there was reported only because the `close` call behind it happened to drain the same chain. Covered by `test/node/custom-coder-errors.test.ts`, which holds the contract that an error from either call reaches the caller with no unhandled rejection.

A codec that cannot carry them drops them: captions ride in an AVC or HEVC bitstream, and a sample states them whatever it is encoded as, so an AV1 or VP9 rung of a ladder sharing that sample warns once and encodes rather than failing. Captions whose frame the encoder discarded are discarded with it, and a repeated frame — frame rate padding filling a gap — carries none, since replaying the same caption commands is what a caption decoder would act on twice. A resize keeps them: the samples reaching the encoder are scaled and still state what was in the picture.

## Input side — read MPEG-DASH manifests

### DASH input pipeline

A full `application/dash+xml` reader mirroring the existing HLS input architecture, registered alongside HLS / ISOBMFF / Matroska / etc.

Format singletons + arrays: `DashInputFormat`, `DASH`, `DASH_FORMATS` (composes DASH with ISOBMFF, QuickTime, Matroska, WebM for segment-side demuxing).

Public AST: `parseMpd(xml) → Mpd` returns a typed AST — `Mpd`, `MpdPeriod`, `MpdAdaptationSet`, `MpdRepresentation`, `SegmentTemplate`, `SegmentList`, `SegmentBase`, `SegmentTimelineEntry`, `DashByteRange`, `ContentProtection`. Throws `MpdParseError` on malformed XML or missing required attributes. Reads XML with the global `DOMParser`, or, where the runtime has none (Node, Bun, Deno), with a built-in XML parser; `domParser` swaps in another implementation.

Demuxer (`DashDemuxer` + `DashSegmentedInput`) capabilities:

- Two-pass track resolution: `(Period, AdaptationSet@group)` pairing-bit assignment so audio/video Representations across paired AdaptationSets share a pairing mask.
- Codec fallback: probes the first segment via `getDecoderConfig` when neither Representation nor AdaptationSet declares `@codecs`.
- `<Label>` preference: Representation `<Label>` > AdaptationSet `<Label>` > Representation `@id`.
- Media type from either level: an AdaptationSet stating neither `@contentType` nor `@mimeType` takes it from its Representations' `@mimeType`, which ISO/IEC 23009-1 §5.3.7 allows and GPAC writes.
- `SegmentTimeline` correctness: `@r=-1` repeats until the next `<S>@t` (when present) or period end, matching ISO/IEC 23009-1 §5.3.9.6.1.
- Live MPD refresh: dynamic manifests refresh on `minimumUpdatePeriod`, in-place context mutation preserves SegmentedInput identity.
- DVR window: `timeShiftBufferDepth` bounds the availability window, and a `$Number$` template's segments are numbered from the live edge back, not from `availabilityStartTime` — a stream running for years dropped the numbers near `@startNumber` long ago. The window is stated against `availabilityStartTime`, so a later period's segments are placed at `@start` + their period-relative time before being compared against it.
- `<BaseURL>` chain: MPD → Period → AdaptationSet → Representation, each resolved against the one above and the first against the manifest's own URL, and re-read on every MPD refresh.
- Single-segment Representations: one stating no SegmentTemplate, SegmentList or SegmentBase is the self-contained file its own `<BaseURL>` names, which is how the ISO on-demand conformance vectors state it.
- `availabilityTimeOffset` and `presentationTimeOffset` honored.
- Common Encryption: `<ContentProtection>` + `<cenc:pssh>` parsing handling both wire forms (full pssh box bytes _and_ content-only embedded); forwarded into the existing `isobmff.resolveKeyId` pipeline so DRM consumers receive a unified pssh box list across the input. `Input.getPsshBoxes()` answers from the manifest as well, deduplicated and without fetching a segment, which is what a licence request needs before any media is read — for DASH and ISO BMFF; HLS states its systems in a key URI rather than a `pssh` element and is not surfaced there.
- A protected track's own `tenc` reaches `getEncryptionInfo()`, and its sample entry reaches `getInternalCodecId()`, through the segment the track was built from. Both answered a constant before, so every DASH track read as clear and codec-less while the init stated otherwise.
- Stable track IDs across MPD refreshes via `(periodId|asId|repId)` mapping.

### HLS playlist parser — extracted, exposed, single source of truth

The HLS demuxer uses a standalone, public AST parser as its single source of truth — the same parser external consumers (validators, inspectors) reach for.

Public exports: `parseHlsPlaylist(text, variables?) → HlsMasterPlaylist | HlsMediaPlaylistAst` (discriminated union), `HlsVariant`, `HlsIFrameStream`, `HlsMediaRendition`, `HlsSegment`, `HlsMap`, `HlsKey`, `HlsSessionData`, `HlsStart`, `HlsContentSteering`, `HlsDateRange`, `HlsSkip`, `HlsRenditionReport`, `HlsPlaylistVariables`.

**Full spec coverage.** Every tag and attribute in the HLS specification is modelled, so `parseHlsPlaylist` → mutate → `serializeHls` is lossless and idempotent — including `#EXT-X-SESSION-KEY` (multi-DRM, one key per `KEYFORMAT`), `#EXT-X-SESSION-DATA`, `#EXT-X-START`, `#EXT-X-CONTENT-STEERING`, `#EXT-X-DATERANGE` (with the spec's open `X-` client-attribute namespace kept as a map), `#EXT-X-BITRATE`, `#EXT-X-GAP`, `SUPPLEMENTAL-CODECS` / `SCORE` / `STABLE-VARIANT-ID` / `PATHWAY-ID` / `ALLOWED-CPC` / `REQ-VIDEO-LAYOUT` on variants, the same set plus `VIDEO-RANGE` / `HDCP-LEVEL` on `#EXT-X-I-FRAME-STREAM-INF`, and `STABLE-RENDITION-ID` / `BIT-DEPTH` / `SAMPLE-RATE` / `INSTREAM-ID` on renditions. A tag outside the spec — a vendor extension, or one from a newer revision — is not modelled and is dropped on serialize; parsing emits one warning per unknown tag naming it and its line, so the loss is never silent.

**Lexical types.** The spec fixes the token form of every attribute, and emitting the right value in the wrong form produces output a strict parser may reject — `INSTREAM-ID` shipped unquoted this way. Every emitted attribute is pinned to its spec type (quoted-string, enumerated-string, hexadecimal-sequence, decimal-integer, decimal-floating-point, decimal-resolution) by a test that reads the serializer. `#EXT-X-DATERANGE` client attributes are the one case where the form carries meaning rather than following from the name: `X-` values are a quoted-string, a hexadecimal-sequence or a signed-decimal-floating-point, so `HlsClientAttribute` is a tagged union of the three and each is written back as it was read.

**Three-valued attributes.** `DEFAULT`, `AUTOSELECT`, `FORCED` and `PRECISE` are `boolean | null`: the spec admits YES, NO and absent, and collapsing absent into NO loses the distinction on the way out. The other YES/NO attributes — `INDEPENDENT`, `GAP`, `END-ON-NEXT`, `CAN-BLOCK-RELOAD`, `CAN-SKIP-DATERANGES` — are specified as "value MUST be YES", so a boolean is the whole domain and they stay boolean.

**`#EXT-X-DEFINE` variable substitution.** `{$name}` references are resolved in URIs and attribute values while parsing. Pass an `HlsPlaylistVariables` to own the scope — a media playlist can `IMPORT` from the master that referenced it, and `QUERYPARAM` definitions resolve against the playlist's own URL.

Master AST: `variants`, `iFrameStreams`, `media` — each entry carries `lineNumber` so consumers can reconstruct cross-array document order. `DEFAULT` / `AUTOSELECT` / `FORCED` are `boolean | null`, keeping the spec's three states apart: `null` is an absent attribute, so an explicit `NO` is written back as `NO` rather than collapsing into omission. Any value other than `YES` or `NO` throws, matching the demuxer's prior behavior.

Media AST: ordered `segments[]` with `#EXT-X-MAP` / `#EXT-X-KEY` carry-over, plus `programDateTime`, `byteRange`, and `discontinuityBefore` flags per segment.

Low-Latency HLS: `#EXT-X-PART` partial segments are parsed onto the segment they belong to (`HlsSegment.parts`, with `DURATION`, `URI`, `BYTERANGE`, `INDEPENDENT` and `GAP`), and parts listed after the last segment, belonging to the segment still being written, onto `trailingParts`. `#EXT-X-PART-INF` becomes `partTarget`, `#EXT-X-SERVER-CONTROL` becomes `serverControl` (`CAN-BLOCK-RELOAD`, `PART-HOLD-BACK`, `HOLD-BACK`, `CAN-SKIP-UNTIL`, `CAN-SKIP-DATERANGES`), and `#EXT-X-PRELOAD-HINT` entries become `preloadHints`. Delta updates are modelled too: `#EXT-X-SKIP` becomes `skip` (with the tab-delimited `RECENTLY-REMOVED-DATERANGES` split into IDs) and `#EXT-X-RENDITION-REPORT` entries become `renditionReports`. `serializeHls` writes them back in spec order, and `hlsMediaPlaylist` / `hlsSegment` / `hlsPart` build them, declaring at least `#EXT-X-VERSION:9` once parts are present.

**Reload decisions (RFC 8216bis §6.2.2 / §6.2.5.2).** `hlsReloadState(playlist)` derives what a client needs to reload a live playlist — target duration, last media sequence number, part count and whether parts are still retained; `hlsRetainsParts(state)` answers whether a playlist still lists parts for a given segment (three target durations of retention); and `hlsReloadDirective(state, msn, part)` decides between blocking reload, plain reload and refusing an out-of-range request (`'too-far'`), including the Advance Part Limit. Pure functions over the AST, so a caller can drive reloads without owning a state machine.

The demuxer's behavior is preserved bit-for-bit: variant streams are sorted by `lineNumber` so pairing-mask bit assignment matches the original linear-walk implementation when STREAM-INF and I-FRAME-STREAM-INF tags are interleaved. Live media-playlist state (sequence numbers, byte-range continuation, PDT extrapolation, encryption key carry-over) intentionally stays inside `HlsSegmentedInput` — that's a state machine, not a static parser, and the two concerns are separated cleanly.

### The minimum `#EXT-X-VERSION` a playlist actually needs

`hlsVersionOf(playlist)` returns the lowest `#EXT-X-VERSION` the playlist's own content requires, per draft-pantos-hls-rfc8216bis-22 section 8: 2 for an `IV`, 3 for a floating-point `EXTINF`, 4 for `EXT-X-BYTERANGE` or `EXT-X-I-FRAMES-ONLY`, 5 for `SAMPLE-AES` or `KEYFORMAT`/`KEYFORMATVERSIONS` or `EXT-X-MAP` alongside `EXT-X-I-FRAMES-ONLY`, 6 for `EXT-X-MAP` without it, 7 for a `SERVICE` `INSTREAM-ID`, 9 for `EXT-X-SKIP`, 10 when that skip replaces dateranges, and 13 for an `INSTREAM-ID` on a rendition that is not closed captions.

It matters because section 8 says a client MUST NOT attempt playback of a version it does not support, so declaring more than you use locks out devices that could have played the stream — a hardcoded 7 shuts out exactly the old hardware a clear MPEG-TS rendition exists for, which needs only 3.

`serializeHls` formats `#EXTINF` to match the version the playlist states: an integer duration is written as an integer below version 3, where 4.4.4.1 says durations MUST be integers, and with three decimals at 3 and above, where it says they SHOULD be floating-point. Before that it always wrote three decimals, so a playlist computed at version 1 was emitted with `#EXTINF:4.000,` — floating-point syntax under a version that forbids it, declaring *less* than the text required. Stating a version below 3 with a duration that is not an integer now throws `InvalidUsageError` rather than writing a line the version cannot hold; `hlsVersionOf` never produces that pair.

That class of bug — a rule reading a value while the serializer chooses a syntax — is caught by asserting against the serialized **text**, not a re-parse: parsing turns `4.000` back into the number `4`, so an AST round-trip sees nothing wrong.

It is a floor, not a verdict, and the doc comment says so. Three of the spec's rules cannot be answered from a parsed playlist: versions 8 and 11 turn on `EXT-X-DEFINE`, which is applied and substituted away during parsing rather than kept on the AST, and version 12 turns on any attribute whose name starts with `REQ-`, which is dropped with every other attribute this library does not model. Covering 8 and 11 would mean modelling `EXT-X-DEFINE` on the AST; covering 12 would mean keeping unmodelled attributes on the tags they sat on.

### Unmodelled HLS tags survive a round trip

`HlsSegment.unknownTags` and `HlsMediaPlaylistAst.unknownTags` hold, verbatim and in order, every line the AST does not model: vendor extensions, comments, tags from a newer spec revision. A tag that preceded a segment is kept on that segment and written back in that position; one that appeared before the first segment is kept on the playlist. `#EXT-X-CUE-OUT`, `#EXT-X-CUE-IN` and `#EXT-OATCLS-SCTE35` arrive this way, which is what lets an SCTE-35 ad relay rewrite someone else's playlist through the AST rather than a line-based lexer.

Two separate losses were behind this. Unmodelled `#EXT` tags warned and were then discarded, so the warning was accurate and the data still went. A line starting with `#` but not `#EXT` went silently, because RFC 8216 calls that a comment and says it SHOULD be ignored — correct for a player, wrong for a relay, and silent either way. Both are kept now, and the warning says they are kept rather than dropped.

This does not make `serializeHls(parseHlsPlaylist(x))` byte-identical to `x`, and should not be read as that promise. Two known differences remain: `#EXT-X-DATERANGE` is modelled at playlist level, so it is emitted with the other playlist tags rather than where it was written, and attribute numbers are reformatted (`PLANNED-DURATION=30` comes back as `30.000`). Content is preserved; spelling and the position of *modelled* tags are not.

`unknownTags` is a required field on both types. Code that builds an `HlsSegment` or an `HlsMediaPlaylistAst` as a bare object literal has to add it; `hlsSegment()` and `hlsMediaPlaylist()` default it to empty.

### Spec-primitive exports

The tag constants and helpers used internally by both demuxers are now public so external consumers don't reach for internals.

- **HLS:** `HLS_MIME_TYPE`, `TAG_STREAM_INF`, `TAG_I_FRAME_STREAM_INF`, `TAG_MEDIA`, `TAG_EXTINF`, `TAG_MAP`, `TAG_KEY`, `TAG_MEDIA_SEQUENCE`, `TAG_BYTERANGE`, `TAG_PROGRAM_DATE_TIME`, `TAG_DISCONTINUITY`, `TAG_TARGETDURATION`, `TAG_ENDLIST`, `TAG_PLAYLIST_TYPE`, `TAG_I_FRAMES_ONLY`, `TAG_DISCONTINUITY_SEQUENCE`, `TAG_DEFINE`, `TAG_SESSION_KEY`, `TAG_SESSION_DATA`, `TAG_START`, `TAG_CONTENT_STEERING`, `TAG_DATERANGE`, `TAG_BITRATE`, `TAG_GAP`, `TAG_SKIP`, `TAG_RENDITION_REPORT`, `AttributeList`, `HlsPlaylistVariables`, `canIgnoreLine`.
- **DASH:** `DASH_MIME_TYPE`, `parseISODuration`, `parseISODateTime`, `parseByteRange`, `parseFrameRate`, `resolveURL`, `resolveBaseURL`, `substituteTemplate`, `normaliseKeyId`, `psshContentsOffset`, `DashRational`.

### Concat / stitch building blocks

For consumers merging per-chunk manifests post-encode (e.g. chunked-transcode workflows).

- `concatMpdPeriods(inputs) → { xml, totalDurationSeconds }` — sequences the first `<Period>` of each input MPD into a single multi-period output. The first input is used as the output base, preserving its `<MPD>` root attributes, namespace declarations, and non-`<Period>` root children (e.g. `<UTCTiming>`, `<ProgramInformation>`), as well as markup the AST does not model, such as vendor-namespaced attributes. Only Period `@id` / `@start` / `@duration` and the optional injected `<BaseURL>` are mutated. Parsing and serialization use the built-in XML implementation, so it runs in Node, Bun and Deno without a `DOMParser` polyfill; comments and processing instructions are not carried through, and an element's text is emitted after its child elements. (It previously required the DOM globals, and cleared the output root's Periods before reading input 0's — which is the same element — so it threw `input 0 has no <Period>` for every well-formed input.)
- `concatHlsMediaPlaylists(inputs) → { content }` — preserves the first input's header lines verbatim (`#EXT-X-VERSION`, `#EXT-X-PLAYLIST-TYPE`, `#EXT-X-INDEPENDENT-SEGMENTS`, custom tags), overwrites only `#EXT-X-TARGETDURATION` to the max across inputs, appends each input's body with optional `pathPrefix` rewriting on segment URIs and `#EXT-X-MAP@URI`, ends with a single `#EXT-X-ENDLIST`.
- `rewriteHlsMasterUrisToBasename(master) → string` — strips directory components from STREAM-INF / MEDIA URIs.

These are deliberately scoped as **building blocks** — no filtering, normalization, or AdaptationSet validation. Callers that need filter / override / correct should compose them with their own pre/post passes.

### `tsc -p tsconfig.json` checks nothing

The root `tsconfig.json` has `"include": []` and exists only to hold project references, so `tsc --noEmit -p tsconfig.json` type-checks zero files and exits 0 no matter what the source says. It is a convincing green: an undefined identifier in `src/` passes it. The gate is `npm run check`, which runs `tsc -p src`, one `tsc -p` per package, then the vitest, scripts and vite projects.

`npm run check` is clean, and is kept that way. It had drifted to 20 errors across six test files, all of them fixtures that spelled out every field of a DASH AST node and so broke whenever the AST grew a field; they now spread the public factories (`mpdRepresentation`, `mpdAdaptationSet`, `mpdPeriod`, `mpd`, `mpdSegmentTemplate`) and take their defaults, which is what stops them rotting again. Note that `check.sh` runs under `set -e`, so a failing project hides every project after it: the `scripts` errors only appeared once the test ones were fixed. A clean run means clean, a dirty one means "at least this".

### Test suite: HLS input reads a local corpus

`hls-input.test.ts` serves its media from an in-process HTTP server on `127.0.0.1:0`
(`test/node/_hls-fixture-server.ts`) out of `test/fixtures/hls/<host>/<path>`, so an original CDN URL maps to a
local one by moving its host into the first path segment. It is a server and not a file source because
`UrlSource` is half of what the file tests — range requests, relative URI resolution against a playlist's own
URL — and the playlists that state a URI absolutely are rewritten as they are served, so nothing reaches the
real host. There is no network guard, no retry budget and no per-request deadline: a red is the library's.

The corpus is 84 MB of third-party CDN streams and is **not committed** — it is third-party media, and
committing it would roughly double every clone of this repo permanently. So "these tests touch no
network" is true of every *run*, after one priming `npm run capture-hls-fixtures` per fresh checkout;
it is not true of a cold clone, which must fetch the corpus once. `test/fixtures/hls-fixtures.txt` lists
the 120 URLs that make it up; `npm run capture-hls-fixtures` fetches them, retrying serially once because at
least one host rate-limits a parallel sweep. The server refuses to start when the corpus is absent and names
that command. To regenerate the list, run the file with `HLS_FIXTURE_LOG` set to a path: the server appends
every request it serves, which is also how the corpus is pruned back to what the tests read.

A missing fixture must be loud rather than plausible. The server answers one with a 404 whose body is text, and
`fetchBytes` asserts `response.ok` — without that, a gap gets read as media and surfaces as a confusing
assertion in an unrelated place.

Live HLS is local too. `/__live__/media.m3u8` is synthesized by the server rather than captured: it lists
real segments from the corpus, hands out one more of them on every fetch, writes no `#EXT-X-ENDLIST`, and
dates itself at request time. That makes the live edge genuinely advance, so `isLive`, the refresh
interval from `#EXT-X-TARGETDURATION`, `computeDuration` blocking without `skipLiveWait`, and
`getNextPacket` waiting for new media are all covered without reading anyone's live stream. The test
asserts that the playlist actually grew while it waited, so a fixture that stopped advancing would fail
rather than pass quietly.

What this does not cover is interop with a real CDN's live playlist — a third party's tag set and refresh
latency. That is a fact about them, not about this library, and it is not a release gate.

`UV_THREADPOOL_SIZE=32` is still set by the `test` and `test-node` scripts. It was added because DNS runs on
libuv's threadpool, 4 threads per process shared with file I/O, and this file's concurrent `UrlSource`s queued
behind them until `fetch` missed its 10 s connect timeout against hosts that answered in ~0.1 s from `curl`.
With the corpus local there is no DNS on that path any more, so the variable is no longer load-bearing here;
it stays because it must be an environment variable on the command line (libuv reads it at process start, so
`test.env` in `vitest.config.ts` has no effect) and because `prores.test.ts` still reads over the network.

### A read that cannot fail is a defect, not a policy

`UrlSource`'s default `getRetryDelay` returns `Math.min(2 ** (attempts - 2), 16)` for every failure and never
`null`, so against a closed port or a blackholed host a read retried forever and never settled. A caller had no
rejection to handle, and in a server that is a socket and a timer per abandoned request, held after the client
has gone. Disposing the input did stop it — the abort plumbing was already there — but that only helps when
something is still around to dispose it.

`UrlSourceOptions.requestTimeout` bounds a single request, and `retryTimeout` bounds the retrying.
The two are separate because they catch different things: a server that accepts a connection and then
never answers is not failing, so a retry budget never fires and the read hangs for as long as the
socket stays open. A request is abandoned after 30 s by default and retried; the retry budget then
ends it. Both are covered by a test against a local server that accepts and never responds.

`UrlSourceOptions.retryTimeout` bounds the retrying: seconds of *continuous failure* after which the read rejects with
`RetryTimeoutError`, carrying the failure that ended it on `cause`. It defaults to 60 and takes `null` for the
old unbounded behaviour. It is enforced in `retriedFetch` rather than in the retry policy, so overriding
`getRetryDelay` cannot make a read unbounded again, and the budget is also checked after the backoff so an
unreachable host rejects on the budget rather than on the budget plus one delay.

The lifecycle contract is now covered by tests rather than assumed: a read against a closed port rejects and
carries its cause; an extra `SourceRef` being freed does **not** stop a read the `Input` still holds a ref for;
and when the last holder lets go the loop is over rather than abandoned — no further fetch happens.

### One pipeline, two manifests, one timeline

HLS and DASH are emitted from the same segment pipeline, and they disagree about who owns the media
timeline. HLS rebases media onto `mediaTimestampBase`, because its playlist carries the timeline
separately; DASH addresses media by the media's own timestamps through `@presentationTimeOffset`, so
rebasing it moves the presentation against its manifest. `ManifestEmitter.addressesMediaByItsOwnTimestamps`
decides it per emitter, and the stricter of the two wins when one pass feeds both. Low-latency parts
go through the same helper as whole segments, so a part cannot land on a different timeline from the
segment holding it.

`SegmentedInput` requires four things of a format for cross-variant sync and timestamp wrapping. For
DASH they are constants, and not for HLS's reasons: one instance is one (period, adaptation set,
representation), so a period boundary is a separate instance rather than a discontinuity within one;
23009-1 puts every representation of a period on that period's timeline; media is fMP4 or WebM, which
timestamp their own samples, so there is no packed-audio base to recover; and 64-bit timestamps in a
declared timescale do not wrap the way MPEG-TS does.

### What is public, and what only looks it

Every fork addition is a permanent compatibility promise, so the public surface is the set of things we mean to
support rather than everything a port happened to leave exported. Twelve shaka-derived helpers that had leaked
out — `atLeastOneTrue`, `moreThanOneTrue`, `onlyOneTrue`, `containerTypeName`, `textTypeName`, `isMultiplexed`,
`hasLiveOnlyFields`, `hasVodOnlyFields`, `removeDuplicateAttributes`, `createDefaultMpdParams`,
`updateContentProtectionPsshHelper` and `fourCCToString` — are `@internal` and no longer exported. They are
unchanged inside the fork; only the promise is withdrawn. No consumer referenced any of them, checked across
both before the change rather than assumed.

The audit that found them compares the fork's exported **values** against upstream's and against this file. The
unit matters: comparing every export names 107 misses, most of them types a reader reaches from a documented
function's signature, which is noise. Comparing callables names the ones a consumer could not discover.

### `sidx` readers — byte ranges and timing from a segment index

An on-demand MP4 carries a `sidx` that says where every subsegment starts and how long it lasts, which is what a
packager needs to serve byte ranges without parsing the media. `Input.getSegmentIndex()` returns the `SidxBox`;
these read it, and all six are in use by consumers today.

- **`getSidxSegmentOffsets(sidx)`** — the absolute byte offset of each subsegment, in order. Paired with
  `sidx.references[i].subsegmentDuration` and `sidx.earliestPresentationTime` this gives a complete byte-range
  plan without touching the media.
- **`getSidxInitRange(sidx)`** / **`getSidxIndexRange(sidx)`** — the initialization segment's and the index's own
  `ByteRange`, for serving each as its own resource.
- **`getSidxDurationSeconds(sidx)`** — total duration the index covers.
- **`getSidxMaxSegmentDuration(sidx)`** — longest subsegment, for a manifest's `@maxSegmentDuration`.
- **`getSidxPeakBitrate(sidx)`** — the worst subsegment's bitrate, for a `@bandwidth` that will not under-declare.

These were undocumented until an audit compared the fork's public exports against this file: a consumer had
found them by reading source, and another asked for a feature that already existed because fork-only additions
do not appear in upstream's documentation. FORK.md is the only place they are discoverable, so an addition that
is not written here is effectively private.

### ISO BMFF box editing

`iterateIsobmffBoxes` reads a box tree; these finish the other half of it, so a consumer indexing or re-timing
CMAF does not hand-roll `DataView` arithmetic over the same boxes.

- **`getSegmentTrackIds(segment)`** — each `tfhd` `track_ID`, in `traf` order. The media-segment counterpart to
  `getInitSegmentTimescales`, for identifying a track from the segment rather than from its path, which is what
  DASH-IF ingest prescribes.
- **`renumberFragments(segment, fn)`** — rewrites each `moof`'s `mfhd` `sequence_number`; `fn` receives the index
  and the current value. The field is fixed-width, so this is an in-place rewrite of a copy.
- **`removeIsobmffBoxes(bytes, types)`** — drops top-level boxes by type, for stripping `styp` / `sidx`. Top level
  only: removing a nested box would leave its parent's size wrong.
- **`readSegmentHead(head)`** — reads the track and decode time from the first bytes of a media segment,
  tolerating a buffer that stops anywhere. `getSegmentDecodeTime` needs a whole segment and throws on a short
  one, which is right when you have the file; a proxy classifying an upstream segment from its first kilobyte
  does not, and a 120-byte head throws there while this returns the track. There are **three** outcomes, not
  two: `null` means no recognisable `moof` — not a media segment; `{ trackId: null, ticks: null }` means a
  `moof` was found but the head stops before its fields; and either field set means that field was read. The
  partial case is kept rather than collapsed because a `trackId` alone is enough to pick a timescale without a
  `tfdt`, so folding it into `null` would discard something a caller can act on. A head that stops mid-`moof`
  is also a different fact from bytes that are not a media segment, though no consumer distinguishes them
  today. A caller wanting both-or-nothing should guard on `ticks == null`.
- **`getInitSegmentTracks(init)`** — per track `{ trackId, timescale, handler, channels }`. Timescale alone does
  not separate video from audio or stereo from 5.1, which matching one stream's tracks against another's needs.
  `getInitSegmentTimescales` stays for the narrow question.
- **`IsobmffBoxInfo.runsToEnd`** — true when the box declared size 0. `size` resolves that to the bytes present,
  which is what a file wants; over a stream a declared 0 means "still arriving" rather than "ends here", and
  that distinction was previously unreachable without re-reading the raw header.
- **`segmentsOf(bytes)`** — splits a whole fragmented file into `{ init, segments }`. A media segment opens at
  each `styp`, or at the first `moof` when nothing marks them; everything before that — `ftyp`, `moov` — is the
  initialization segment and is reported as its own range rather than folded into segment one. Segment-level
  prelude (`styp`, `sidx`, `prft`, `emsg`) belongs to the segment ahead, so a segment's `offset` includes it.
  `init` is `null` when the bytes carry none, which keeps that case distinguishable from an init of N bytes.
  Bytes after the last `mdat` — `mfra`, `mfro`, a trailing `free` — are reported as `trailing` rather than folded
  into the final segment: they index the file, not a fragment, so including them would describe a range longer
  than its media. `chunksOf` does fold them, deliberately, so that chunks tile a segment; that invariant is
  correct within a segment and is kept local to it. `chunksOf` does the same walk one level down.

### AST builders — construction counterpart to the parsers

Factory functions that build the HLS and DASH ASTs from the fields that matter, defaulting the boilerplate — the write-side complement to `parseHlsPlaylist` / `parseMpd` (hand the result to `serializeManifest`). For describing already-produced segments (e.g. indexing an external CMAF push) rather than driving the muxer pipeline, so distinct from the `MediaInfo`-driven `MpdBuilder`.

- **HLS:** `hlsVariant`, `hlsIFrameStream`, `hlsMediaRendition`, `hlsSegment`, `hlsPart`, `hlsKey`, `hlsMap`, `hlsStart`, `hlsSessionData`, `hlsContentSteering`, `hlsDateRange`, `hlsSkip`, `hlsRenditionReport`, `hlsPreloadHint`, `hlsMasterPlaylist`, `hlsMediaPlaylist` → `HlsMasterPlaylist` / `HlsMediaPlaylistAst`. Every field of the AST these produce is settable through the options; nothing the parser can read is unreachable from the builder, so a playlist can be rebuilt as well as round-tripped.
- **DASH:** `mpd` (ISO live/on-demand profile selected from `@type`), `mpdPeriod`, `mpdAdaptationSet`, `mpdRepresentation`, `mpdSegmentList`, `mpdSegmentTemplate`, `mpdServiceDescription` → `Mpd`. Every field of the AST these produce is settable through the options, and every AST type a factory asks the caller to supply has a factory of its own — both are enforced by tests. The second matters more than it sounds: a type with no factory must be written out field by field, and `tsc` reports a nested type's missing fields only once the outer ones are filled, so each level of nesting costs a whole typecheck cycle to discover.
- **`xs:dateTime` precision.** `parseISODateTime` keeps sub-millisecond digits as the fractional part of the Unix-millisecond value, which `Date.parse` discards, so a `publishTime` stating microseconds round-trips exactly. Doubles hold about 0.00024 ms at present-day epochs, so microseconds survive and nanoseconds would not.

### Subtitle tracks on the read side

`Input.getSubtitleTracks()` returns `InputSubtitleTrack`s alongside the video and audio ones, and `SubtitleCueSink.cues(start, end)` yields `SubtitleCue` objects the way the sample sinks yield samples; `EncodedPacketSink` serves the raw bytes for a remux. ISOBMFF reads `wvtt` and `stpp`, Matroska reads `S_TEXT/WEBVTT` — and a track is created only when the sample entry is one the demuxer can actually decode, so a subtitle track is never reported whose cues cannot be read. A cue split across packets is rejoined by its `vsid` where the format states one, else by its own timing and text.

`Conversion` carries subtitle tracks through, converting between the codecs it supports since both are driven from the same cue representation. A subtitle track an output format cannot hold is reported in `discardedTracks` with a reason rather than dropped, as is a subtitle track under `tracks: 'primary'`, which selects primary video and audio only.

## Typed errors

Every throw out of the fork's own areas — encryption, DASH, HLS, watermarking, manifest transforms — states whose problem it is, so a caller never has to match on message text to find out:

- **`MalformedInputError`** — the bytes or manifest are wrong for their format. The publisher is at fault; at an origin this is the one to turn into a rejection.
- **`UnsupportedMediaError`** — valid input stating something this library does not implement. Re-encoding or routing elsewhere can succeed, so rejecting it would be wrong.
- **`InvalidUsageError`** — the calling code is wrong (options that contradict each other, a builder read before it was given what it needs). A bug to fix, not a runtime condition to handle.

All three extend `MediabunnyError`, which extends `Error`, and every message is unchanged — so code that only tests `instanceof Error` or reads `.message` keeps working. `MpdParseError` now extends `MalformedInputError` and is exported, so MPD failures are catchable either specifically or by category.

This follows the convention upstream already set with `UnsupportedInputFormatError` and `InputDisposedError`; the fork's 124 additional throws simply had not adopted it. Partial typing would have been worse than none — an untyped malformed-input throw escaping an `instanceof MalformedInputError` check gives false confidence — so the conversion is total for those areas, verified by there being no bare `throw new Error` left in them.

Every throw from the ISO BMFF box helpers is typed. Bytes that are wrong for the format — a truncated box header, a `pssh` smaller than its own fields, a `sidx` whose reference table runs past the box, a `trak` without its `tkhd`/`mdhd`, a `traf` without its `tfhd`/`tfdt`, a segment naming a track the init does not describe — raise `MalformedInputError` from `iterateIsobmffBoxes`, `segmentsOf`, `chunksOf`, `getSegmentTrackIds`, `getInitSegmentTimescales`, `getSegmentDecodeTime` and `setSegmentDecodeTime`. A caller's own mistake — a box range outside the bytes handed in, a negative `seconds`, a decode time that is not exactly representable at the track's timescale or will not fit a version 0 `tfdt` — raises `InvalidUsageError`. An origin can therefore turn a bad segment into a 4xx and keep 5xx for its own faults, which is the distinction the whole hierarchy exists for. `UnsupportedInputFormatError` now extends `UnsupportedMediaError` and `InputDisposedError` extends `InvalidUsageError`, so both reach a `catch (e) { if (e instanceof MediabunnyError) }` like everything else; both remain `Error` subclasses, so existing handlers are unaffected.

## Conformance: what this fork guarantees

Checked against draft-pantos-hls-rfc8216bis-22, ISO/IEC 23009-1 and ISO/IEC 13818-1. Each item is an
invariant the test suite holds, not a note about when it started holding.

**Timing.** `EncodedPacket.decodeTimestamp` carries the decode time end to end. What this fork *writes*
satisfies DTS <= PTS with DTS rising within a track (13818-1 2.4.2); what it *reads* is what the source
states, relayed rather than repaired. Apple's own bipbop gear1 TS segment states a DTS after the PTS on
138 of its 300 PES packets, and that is reported as stated — a clamp would silently restate a stream's
decode order and a remux would then write times its source never gave. Signed composition offsets (14496-12 8.6.1.3, 8.8.8) are
absorbed by `InternalTrack.decodeTimestampShift`, derived once from the init — a `cslg` (8.6.1.4), a
complete `ctts`, or the codec's reorder depth (AVC `max_num_reorder_frames` or the level's DPB size,
HEVC `sps_max_num_reorder_pics`). It is never derived from the fragments a reader happened to open,
so a segmented reader and a whole-file reader agree, and a fragment stating no offsets does not
collide with its neighbours. The presentation timeline is never shifted to achieve this.

**On write, the stated decode times are carried.** The ISO BMFF muxer anchors the first sample's decode
time at media time zero and derives each composition offset from `EncodedPacket.decodeTimestamp`, so a
progressive file's offsets never go negative and no sample is given a DTS past its own PTS. The delay until
the first presented sample — the reorder delay of a stream whose first decoded sample is not its first
presented one — is stated as the `elst` media time, which is what puts presentation back at zero, and
`cslg` bounds it. A source that states no decode timeline of its own, where
`EncodedPacket.statesDecodeTimestamp` is false, still has one derived per GOP by sorting that GOP's
presentation times and assigning them positionally; wherever presentation order is decode order the two
agree, and nothing else can be recovered from presentation times alone.

A fragmented file carries the same presentation times, by a different route. Its `moov` goes out before the
track's first GOP has been flushed, so nothing can state a reorder delay in an edit list afterwards; the
stated decode times are therefore kept only while they stay at or above zero, and below that the muxer falls
back to presentation order, leaving the negative composition offsets for `decodeTimestampShift` to undo on
read. Either way the presentation times are the source's.

What makes that work is that `tfdt` states the fragment's lowest **decode** time rather than its lowest
presentation time, which `trun`'s composition offsets are measured against. The two are the same number for a
track whose decode order is its presentation order, which is why stating the wrong one went unnoticed for as
long as every decode time was reconstructed by sorting; for a track that states its own decode timeline they
differ by the reorder delay, and stating the presentation time put every fragment that delay late. It is read
off the fragment's samples when the box is built, not accumulated as they are added, because a sample joins
its chunk before the batch it belongs to has been settled.

MPEG-TS writes a PCR on the video PID, or the audio PID when there is no video, within the 0.1 s of
2.7.2. PES timestamps are unsigned 33-bit, so a programme that would decode before zero is offset
forward by one amount for every track, chosen from the first packet in output order (as ffmpeg's
`avoid_negative_ts` does). `MpegTsOutputFormatOptions.timestampOffset` overrides it; a caller that
owns its own timeline, like the segment pipeline, sets it to zero and keeps its negatives.

**Bytes.** Helpers that edit a caller's buffer copy it first, including a Node `Buffer`, whose
`slice` returns a view. `base_data_offset` is a file offset (14496-12 8.8.7.1), so moving a `moof`
restates it. `rebaseSegmentDecodeTime` refuses rather than wrapping a `tfdt`, and refuses a
multi-track segment, since one tick delta cannot suit two timescales.

**Dates.** MPD `availabilityStartTime` and `EXT-X-PROGRAM-DATE-TIME` are read as UTC, as dash.js and
shaka do; `Date.parse` reads a zoneless ISO date-time as local.

**What is kept, and what is refused.** XML prefixes used by verbatim children are declared;
`<ContentProtection>` children survive; `MpdEvent.scte35Binary` reads an SCTE-214-1 payload while the
original `<Signal>` is written back unchanged. Thirteen inputs the HLS spec says a client MUST fail
to parse are refused, among them two `EXT-X-VERSION` tags, `EXT-X-MEDIA-SEQUENCE` after a segment, a
non-hex IV, and a fractional `BANDWIDTH`. A segment past the target duration and a missing target
duration are reported as `notes` instead, since both are interpretable. Serialization refuses a URI
with a line break, a quoted value with a quote, `NaN`, and a stated version below what the content
needs.

**Answers, not guesses.** `getSegmentCompositionOffset` and `getSegmentDecodeTime` validate structure
before answering, so 0 and `null` mean what they say rather than doubling as parse failures.
`renumberFragments` refuses a sequence number that is negative, fractional or past 32 bits.
`UrlSource` bounds both a single unanswered request and a run of failing ones, so a read always
settles.
## Finding things: the ISO BMFF segment group

The fork's segment tooling — box walking, segment and fragment layout, `sidx` reading, decode-time and fragment-number rewriting, `emsg` — is its own `ISO BMFF segments` group of 35 exports rather than sitting under `Miscellaneous`, where a capability goes to be unfindable. `Miscellaneous` holds 21, almost all of them upstream's (`Rational`, `MaybePromise`, `SetRequired`, `TrackType`, …). Nothing moved that upstream exports, and no symbol was split from the function that returns it: `PsshBoxContents` stayed put because `PsshBox` and `parsePsshBoxContents` are upstream's and stayed too.

Worth stating because it is easy to go looking for a problem that is not there: every one of the 646 public exports already carries a `@group`, and `docs:generate` fails on a group that `docs/api-config.json` does not declare, so the surface cannot silently drift ungrouped. The split is about where things live, not whether they are labelled.

## Cross-cutting input additions

- **sidx box parsing** + `Input.getSegmentIndex` exposure — for CMAF and DASH segment-side index access.
- **`sidx`-seeded fragment lookup tables** — a fragmented file whose index is a `sidx` rather than an `mfra`/`tfra` (the DASH on-demand and CMAF single-file layouts) is now seekable through that index: the demuxer maps each subsegment reference onto a fragment lookup entry, so seeks and `computeDuration()` jump to the right fragment instead of walking the file `moof` by `moof` from byte 0. `tfra` still takes precedence where both are present.
- **MPEG-TS `computeDuration()` probes from the end of the file** — about 3 ranged reads regardless of file size, instead of one per binary-search step. When a track ends before the file does, the bytes past its last packet are read once rather than once per scan. Durations are unchanged.
- **Network prefetching grows when reading backwards** — reads that walk a file back to front (such as a demuxer rewinding to a track's previous packet) fetch exponentially larger blocks, the same way forward reads already do, instead of one fixed 64 KiB request per step.
- **`UrlSource` takes a `prefetchProfile`** — `'network'` (the default, unchanged), `'fileSystem'` or `'none'`. The profile mechanism and all three strategies are upstream's; what the fork adds is the option on `UrlSource`, which previously hardcoded `'network'`. That profile grows a worker's read region exponentially while reads keep landing in it, which is right for playback and conversion and wrong for a sparse random-access pass: reading a key frame and the three packets after it at every key frame of a 17-minute 4 GB H.264 file read the **whole file** (4,041 MB over 18 requests) for the ~1.3 MB per point actually wanted, because at 33 Mb/s each next point is always far enough along to keep extending the same region. Dropping to `'none'` fetches what was asked for and nothing else, at one request per read; `'fileSystem'` rounds each read out to 64 KiB and sits between the two. Measured on the test's fixture (26.5 MB, 2 s GOPs, 10 points): `'none'` reads 1.12x the packets' own size, `'fileSystem'` 1.68x, the default 2.94x — and the gap widens with file size, since the default's growth is capped per extension rather than per file. The index is not the cost either way: a `metadataOnly` pass over the same file reads 65 KB.

  Deliberately not done: making `'network'` adapt by itself, either from how far apart consecutive reads are or — the sharper proposal, since it would be measured rather than guessed — from how much of a read region actually gets consumed. The reason is that a sequential reader can consume very little of what it fetches, and the measurement cannot tell it apart from a sparse one. Reading *only the audio track* of the test's interleaved fixture is strictly sequential and consumes ~1% of the bytes around it: the default reads 66x the track's own size in **2 requests**, while `'none'` reads 4.8x in **39**. A utilization rule would switch prefetching off for that reader and pay a round trip per packet. Bytes and round trips are what the profiles trade against each other, and only the caller knows which one it is paying for — so the knob is explicit and the default is left alone. The second test in `url-source.test.ts` is the guard on that: it fails if the default stops prefetching for a low-consumption sequential read.

  Both tests count bytes read out of response bodies rather than what the server was asked to send: the reader asks for open-ended ranges and cancels them once satisfied, so `Content-Length` overstates — by a factor of nearly 9 in the first measurement taken this way, which read 35 MB of a 20 MB file.

- **`SidxBox` read-side derivation helpers** + `ByteRange` type export — for callers computing segment offsets from sidx.
- **ISO BMFF segment helpers** — `iterateIsobmffBoxes` walks boxes (64-bit and size-0 sizes, `uuid`, children by content range) and throws on truncation; `getInitSegmentTimescales` reads each track's media timescale from an init segment synchronously; `setSegmentDecodeTime` re-times a CMAF segment to an absolute start in seconds, per track in its own timescale, keeping the spacing of later `moof` chunks and throwing when a version 0 `tfdt` can't hold the value.
- **Truncated whole-file reads fail loudly** — `requestEntireFile` throws `Short read: …` when a source reports a size and then serves fewer bytes, matching the check `Source.readRange` already performs. Yielding a slice that still claims the full range lets a manifest parse truncated, and even parse *successfully* with fewer renditions. Fork-only: proposed upstream as [#569](https://github.com/Vanilagy/mediabunny/pull/569) and declined as unreachable, which held up — no built-in source reaches it (`UrlSource` retries a truncated body, `FilePathSource` serves cached bytes when the file shrinks), and upstream already checks this for `CustomSource`. Kept as a cheap invariant for anything subclassing `Source` directly.
- **`Input` / `InputTrack`: pssh / tenc exposure** for re-emission — keep the original DRM box bytes available so downstream re-muxing or re-packaging can preserve them.
- **HLS port: `EXT-X-MEDIA` in input order** — fix ported from shaka b1580dd.
- **Packed audio timestamps** — the ADTS demuxer starts a file's timestamps at the 33-bit MPEG-TS timestamp in its leading ID3 `PRIV` frame (`com.apple.streaming.transportStreamTimestamp`, RFC 8216 §3.4), so HLS packed-audio segments sit on their media timeline instead of at rounded `EXTINF` time. Files without the frame still start at 0 and are placed by accumulated `EXTINF` durations, which is upstream's behaviour for a format that carries no timestamps; it is the frame's presence that switches a segment onto its own clock, so a frame stating 0 is not the same as no frame.
- **Start offset between renditions** — HLS and DASH inputs keep the offset between paired renditions: a rendition whose first sample comes after a paired rendition's (for example video 120 ms after audio) keeps that lag in its timestamps, instead of every rendition starting at its own playlist time. Renditions more than 0.5 s apart are treated as separate timelines.
- **HLS VOD and EVENT start time** — a `VOD` or `EVENT` media playlist with `#EXT-X-MEDIA-SEQUENCE` above 0 starts at its first segment's media time, since those playlist types never remove segments (RFC 8216 §4.3.3.5). Only a playlist without `#EXT-X-PLAYLIST-TYPE`, which may be a sliding live window, is still placed `MEDIA-SEQUENCE × TARGETDURATION` in when it has no `#EXT-X-PROGRAM-DATE-TIME`.
- **HLS I-frame playlists without `#EXT-X-MAP`** — an `#EXT-X-I-FRAMES-ONLY` playlist with no `#EXT-X-MAP` whose first I-frame has a byte range starting past offset 0 reads the bytes before that I-frame in the same resource as its init section, as RFC 8216 §4.3.2.5 allows, instead of failing with no `moov`. The same applies to the first I-frame after each `#EXT-X-DISCONTINUITY`. A first byte range at offset 0 and an explicit `#EXT-X-MAP` behave as before.
- **Video range only where signalled** — for H.264 and HEVC, `getColorSpace()` and the decoder config leave `fullRange` unset when the SPS carries no video signal type (as `VideoColorSpaceInit` allows), instead of reporting the spec's inferred limited range, so "not stated" is distinguishable from "limited". A remux of such a stream no longer gains a `colr` box claiming limited range. Streams that signal a range, and VP9, AV1, ProRes and Matroska, are unchanged.
- **Public range read on `Source`** — `source.readRange(start, end)` resolves with those bytes as a copy the caller owns, or null when the range lies outside the source's data. Reading a byte range no longer means reaching for `Reader` or the internal `_read`, which is stripped from the published types — the case an origin serving one init or segment out of a larger resource runs into immediately. A source that provides fewer bytes than the range asks for throws rather than returning a short result: an origin serving truncated bytes as if they were whole is a worse outcome than a failed read.
- **Lifetime diagnostics** — `InputDisposedError` names the operation and byte range that failed (`Cannot read bytes [100, 200); the source has been disposed.`) instead of just "Input has been disposed", and a `SourceRef` that is garbage-collected without being freed logs a warning naming the mistake. Both target the same class of bug: a dropped ref lets the source dispose itself at an arbitrary later point, so the failure surfaces on a later, unrelated read. HLS reading hands out per-segment refs it lets the registry reclaim by design, so the warning is suppressed for HLS-derived sources.
- **Splitting a segment into its chunks** — `chunksOf(segment, init?)` returns each chunk as `{ offset, size, decodeTime, trackId, duration, independent }`. A chunk runs from the first box after the previous chunk through its own `mdat`, so `styp`, `sidx`, `prft` and `emsg` belong to the chunk they *precede*: `styp` opens a segment and the others describe the media that follows them. The chunks therefore tile the segment — their ranges concatenate back into exactly the bytes given, which is what lets them be published as `EXT-X-PART` byte ranges, and it keeps an `emsg` ad signal in the part it describes rather than the one before it. Offsets are into the bytes given, so running it over the output of `encryptCmafSegment` states where the chunks landed *as served* rather than where they were before encryption grew them — the byte ranges an origin publishes as `EXT-X-PART`. `duration` and `independent` come from the `traf`'s `trun`, falling back to the `tfhd` defaults and then to the init's `trex`: a segment whose `trun` states no per-sample durations and whose `tfhd` states no default (shaka-packager's usual output) carries no duration at all, so the optional `init` is what makes that field available. A `trex` field of `0` is read as stating nothing rather than as a value — the format has no absent value for these, `0` is what a writer emits when it specifies no default, and a zeroed `default_sample_flags` would otherwise decode as "sync sample, depends on nothing" and publish a chunk as independent when it may open mid-GOP. An explicit `tfhd` default is still honoured, since there the writer did state something. Empty for bytes holding no `moof`.
- **Event messages in a packaged segment** — `buildEmsgBox(options)` writes an `emsg` box (ISO/IEC 23009-1 §5.10.3.3, version 0 for a delta or version 1 for an absolute presentation time) and `insertBoxesBeforeMoof(segment, boxes)` inserts complete top-level boxes immediately before a segment's first `moof`, restating any preceding `sidx`'s `first_offset` so it still names the fragments that follow. For adding SCTE-35 cues to segments this library — or anything else — already wrote.
- **CMAF/fMP4 segment primitives** — `isInitializationSegment(bytes)` (top-level moov-before-moof scan), `getSegmentDecodeTime(bytes)` (first `tfdt` baseMediaDecodeTime, v0/v1), and `rebaseSegmentDecodeTime(bytes, deltaTicks)` (shift every `traf`'s `tfdt` onto a continuous timeline, returning a new buffer, input untouched) — read and rewrite a fragment's decode timeline without a demux/remux.
- **`getSegmentCompositionOffset(bytes)`** — ticks past a fragment's `tfdt` at which its earliest-presented sample is shown, the presentation-side counterpart to `getSegmentDecodeTime`. A `sidx` states an `earliestPresentationTime` while a `tfdt` states a decode time, and the two differ wherever an encoder emits B-frames, so a source indexed by `sidx` and a source scanned for `moof`s otherwise describe timelines that do not line up — and which one a title gets depends on whether its file happens to carry an index. `getSegmentDecodeTime(seg) + getSegmentCompositionOffset(seg)` is what the `sidx` reports. Three things make it more than a `ctts` lookup: it is the smallest *sum* of a sample's decode offset and its composition offset (the smallest offset alone is 0 in any normal GOP, and says nothing); per-sample durations are routinely absent, so they come from the `tfhd`'s `default_sample_duration` and failing that from the `trex` movie-extends defaults; and a version 1 `trun` states the offset signed. Takes an optional second argument, the init segment: a whole file carries its own `moov`, but a DASH-IF Interface-1 receiver holds init and media under separate keys and they are never adjacent in memory, so without it a fragment whose durations live only in the `trex` collapses to the smallest composition offset. Verified against `bear-640x360-av_frag.mp4`, whose `trun` and `tfhd` both omit durations — without the `trex` fallback it answers 1001 where the index says 2002.

## Manifest transform substrate — parse → transform → serialize

A unified, format-agnostic pipeline over the DASH (`Mpd`) and HLS (`HlsPlaylist`) ASTs: parse a manifest, run composable pure transforms, serialize it back. Two format-specific ASTs behind one `Manifest` facade. HLS round-trips losslessly; DASH keeps every attribute the MPD schema defines on the elements it models (see below).

- **Facade:** `parseManifest(text, options?) → Manifest` (sniffs HLS vs DASH), `serializeManifest(manifest) → string`, `pipeManifest(manifest, transforms) → Manifest`. `Manifest` is a discriminated union (`{ format: 'dash', mpd }` | `{ format: 'hls', playlist }`); `ManifestTransform = (Manifest) => Manifest`.
- **Serializers:** `serializeMpd(Mpd) → string`, `serializeHls(HlsPlaylist) → string` — the round-trip complement to the parsers (reuse `XmlNode` / `Tag` and the shared duration + float formatting; `<BaseURL>` path-aware). Transforms are **pure**: a new manifest is returned, every untouched subtree shared by reference, so one parsed base spawns many variants cheaply.
- **Cross-format rendition filtering:** `Rendition` is a read-only view of a selectable rendition (DASH Representation, HLS variant, or `#EXT-X-MEDIA` group) so one predicate works against both formats. A DASH rendition inherits `@width`, `@height` and `@audioSamplingRate` from its AdaptationSet when the Representation states none, alongside the `@codecs`, `@frameRate` and channel configuration it already inherited — so a resolution or sample-rate filter still sees dimensions declared once on the set (the USP-style layout) instead of reading them as absent and keeping every rendition. `filterRenditions(predicate)` is the core; atoms compose over it — `dropCodecs` / `keepCodecs`, `capResolution`, `filterBitrate`, `filterFramerate`, `filterChannels`, `dropByColorRange` (SDR / HLG / PQ), `dropSubtitles`. Dropping an HLS media group prunes now-dangling variant group references.
- **URL + structure rewrites:** `mapSegmentUrls((url, kind, index) => url)` rewrites every media-referencing URL by `SegmentUrlKind`; `rebaseManifest(base)` resolves relative URLs against a new base (DASH BaseURL chain preserved); `toSegmentTemplate(build)` repackages single-file (`SegmentBase`) DASH representations as `SegmentTemplate` + `SegmentTimeline`.
- **DRM signaling:** `drm(options)` injects content protection into a parsed manifest (DASH `<ContentProtection>` per system, HLS `#EXT-X-KEY` per system; multi-DRM in one manifest). Each format's rules live in one core shared with the generate/patch-path helpers — `buildContentProtections` / `buildHlsKeys` (from-scratch) and `patchMpdContentProtection` / `patchMediaPlaylistKeys` (format-preserving in-place string patch).
- Backing parser additions: DASH `AudioChannelConfiguration` / `SupplementalProperty` / `EssentialProperty` descriptors and HLS `VIDEO-RANGE`, plus the shared `parseChannelCount` helper.

**Round-trip fidelity for DASH.** `parseMpd` → `serializeMpd` keeps all 66 elements `DASH-MPD.xsd` defines and every attribute it defines on them, checked by an attribute-set comparison per element rather than by value assertions — a parsed-but-never-written attribute is invisible to those. This matters most where the schema supplies a default: `Period@bitstreamSwitching` and `AdaptationSet@bitstreamSwitching` default to `false`, so dropping a written `true` inverted it, and both are modelled as `boolean | null` for that reason. Equivalent reformatting is not loss and is not preserved: `PT1M0.288S` is rewritten `PT60.288S`, `frameRate="25/1"` as `25`, and spec defaults such as `SegmentTemplate@startNumber="1"` are written only when they differ. `xmlns:cenc` is emitted with the `cenc:` content that needs it, so a declaration with no such content is dropped.

**Elements, not just attributes.** An attribute audit cannot see a whole element go missing, and for a long time 44 of the schema's 66 elements were parsed by nothing and emitted by nothing — `<EventStream>` and `<Event>` among them, so an SCTE-35 signal in a real Unified Streaming manifest was dropped silently. All 66 are modelled now, guarded by a fixture carrying every one of them and an element-set comparison, alongside the attribute check. `<Event>` is declared `mixed` with `xs:any namespace="##other"`, so its foreign-namespace children — an SCTE-35 `<Signal>` subtree and its `xmlns` — are kept verbatim and re-emitted unchanged rather than re-encoded from a typed model. `<Preselection>`, `<InitializationSet>`, `<SubRepresentation>`, `<Metrics>`, `<ProgramInformation>`, `<ProducerReferenceTime>` and the rest of `RepresentationBaseType`'s children are modelled structurally.

**What DASH still does not preserve.** Equivalent reformatting is also not preserved: `PT1M0.288S` → `PT60.288S`, `PT1M` → `PT60S`, `frameRate="25/1"` → `25`, `1970-01-01T00:00:00Z` → `…00.000Z`, and spec defaults such as `SegmentTemplate@startNumber="1"` are written only when they differ. Attribute order within an element is not preserved either. So the round trip is element- and attribute-complete, not byte-exact: code that diffs manifests as strings should compare the AST instead. Comments and whitespace are dropped, and foreign content at the schema's declared extension points — `DASH-MPD.xsd` allows `xs:anyAttribute namespace="##other"` on 33 of its 43 complexTypes and `xs:any` on 18 — is not kept either, except inside `<Event>`, where SCTE-35 requires it.

**Reading and generating, not editing.** The useful test is whether you are changing a document you did not create. If you are, you need everything you did not touch to survive byte-for-byte, and an AST that re-emits from a typed model structurally cannot promise that however complete the model becomes — normalised durations, reordered attributes, reflowed whitespace and dropped comments are differences you did not intend. Use a DOM that mutates and re-serializes the original document for that. Parsing to read, and building to generate, are what these ASTs are for.

It also keeps what the fork's own MPD writer emits: AdaptationSet `@width`, `@height`, `@par`, `@startWithSAP`, `@subsegmentStartsWithSAP`, `@segmentAlignment` and `@subsegmentAlignment`, the MPD's `xsi:schemaLocation`, and `<ServiceDescription>` (at MPD and Period level, with `<Latency>` and `<PlaybackRate>`) as `MpdServiceDescription`. Spec defaults such as `SegmentTemplate@startNumber="1"` are still written only when they differ from the default. Without a global `DOMParser`, `parseMpd` uses its built-in XML parser; `parseMpd(xml, { domParser })` still accepts another implementation.

## Player and tool limitations worth knowing

Findings about third-party players and tools, recorded so they are not re-investigated. None is a fork defect.

- **shaka-player 5.2.10 cannot parse a ClearKey-only HLS playlist** (error 4026, `HLS_KEYFORMATS_NOT_SUPPORTED`). Its HLS parser recognises only `identity`, FairPlay, Widevine and PlayReady — there is no W3C Common system in that path. A ClearKey proof over HLS therefore has to signal Widevine and hand shaka the key through `drm.clearKeys`.
- **Bento4's `mp4decrypt` ignores `seig`**, so a segment encrypted under a rotated key cannot be verified with it even when both `kid:key` pairs are supplied. Key rotation is better proven at box level, plus showing that the previous key no longer reproduces the clear bytes.
- **hls.js 1.7.3 never fetches a part by byte range unless parts outlive their segment.** Its `shouldLoadParts` requires `bufferEnd >= partList[0].end + fragmentHint.duration`; when an origin lists parts only for the segment in progress, `partList[0]` and `fragmentHint` are the same segment and the threshold cannot be met. Parts must stay listed for three target durations past their segment (RFC 8216bis 6.2.2) for a ranged part fetch to ever happen. This fork emits no part tags itself — it reports part byte ranges through `HlsOutputSegmentInfo.parts` and leaves playlist writing to the caller — so this is a trap for whoever writes those playlists.

## Forensic A/B watermarking signalling

Signalling only, per **DASH-IF Forensic A/B Watermarking (ETSI TS 104 002 V1.1.1)**. The fork sits at the spec's *packager*: it consumes A/B variants and emits the ingest manifests and per-segment metadata that the origin and CDN edge read. Embedding the watermark into the essence is the transcoder/watermarker's job and is deliberately not here — it is a licensed, patent-encumbered stage. Selecting A or B per request is the CDN edge's job, driven by a signed WM token, and manifests served to devices are *neutral*: one cacheable manifest for everyone, with no variant names in it. Nothing in this fork is per-session.

**Per-segment metadata.** `WmPaceInfo` models the spec's structure — `watermarked`/`variant`/`position`/`firstPart`/`partCount`, named for readability with each spec field named in its docblock. `encodeWmPaceInfo` / `decodeWmPaceInfo` are the 48-bit wire form, including the two emulation bits that are fixed at 1 so the structure can never form a start code. `wmPaceInfoBox` returns a complete `wmpi` box ready to prepend to a segment, and `readWmPaceInfo` finds one in a segment or returns `null`. The byte layout is pinned against the spec's worked example rather than only round-tripped, because a round trip agrees with itself even when the bit packing is wrong in both directions.

**DASH ingest signalling.** `variantSchemeIdUri('a')` and `variantFromSchemeIdUri` build and read the `watermarking_variant#<letter>` scheme, and `WM_PACE_INFO_SCHEME_ID_URI` is the sidecar pointer's scheme. These are URIs for the `EssentialProperty` descriptors the MPD model already carries generically, so no new MPD surface was added — an ingest manifest is built by putting these schemes on an existing `EssentialProperty` at Adaptation Set or Representation level, with `@value` giving the variant's path.

**HLS ingest signalling.** `WATERMARKING-VARIANT` is modelled on `#EXT-X-STREAM-INF` (`HlsVariant.watermarkingVariant`) and `#EXT-X-MEDIA` (`HlsMediaRendition.watermarkingVariant`), and `#EXT-X-WMPACEINFO` as `HlsMediaPlaylistAst.wmPaceInfoUri`. It is *not* on `#EXT-X-I-FRAME-STREAM-INF`: the spec signals variants on the two tags above only, and the trick-play stream in its own example carries none. Both parse and serialize, so an ingest playlist round-trips.

**Sidecar files.** `serializeWmSidecar` emits both addressing modes — `discrete` (a `segmentRegex` per group of filenames) and `byterange` (`startRange`/`endRange`, which must also cover the initialisation segment). Output uses the specification's field names (`iswm`, `pos`, `firstpart`, `nbpart`, `WMPaceInfoObject`), not this library's, because it is interchange rather than our own shape.

**Ingest → egress.** `neutralizeWatermarking()` is the pass that turns an ingest manifest into the one devices receive. Ingest names both variants; egress must be neutral — the same cacheable document for every viewer, naming neither — because the CDN edge picks A or B per request. It strips both DASH `EssentialProperty` schemes, the HLS `WATERMARKING-VARIANT` attributes and `#EXT-X-WMPACEINFO`, and collapses the per-variant duplicates: one Adaptation Set per variant on the DASH side, and the paired `#EXT-X-STREAM-INF` / `#EXT-X-MEDIA` entries on the HLS side. Collapsing keeps the first of each group and so its URI, which an origin will usually rewrite to the neutral path it serves — `rebaseManifest` is the pass for that. A manifest with no watermarking signalling comes back unchanged by reference, like every other transform here.

It also strips the signalling that arrives as an *unmodelled* tag. HLS keeps every line the AST does not model so a relay can write it back, which means a watermarking tag from a newer spec revision — or a vendor's own — survives neutralization in `unknownTags` and names the variants the modelled attributes no longer do. `neutralizeWatermarking` therefore also drops any unmodelled tag beginning `#EXT-X-WMPACEINFO`, over the master playlist's tags, each media playlist's, and each segment's. `WATERMARKING-VARIANT` needs no equivalent: it is an attribute on `#EXT-X-STREAM-INF` and `#EXT-X-MEDIA`, both of which are modelled, so it cannot arrive as an unmodelled line.

**The other `WMPaceInfo` carriers.** `wmPaceInfoSeiNalUnit` / `readWmPaceInfoSei` carry it as a `user_data_unregistered` SEI message under the specification's UUID `bec4f824-170d-47cf-a826-ce008083e355`, for AVC and HEVC, reusing the fork's existing SEI framing so emulation prevention is handled on both sides. `wmPaceInfoTsDescriptor` / `readWmPaceInfoTsDescriptor` build and read the `temi_WMPaceInfo_descriptor` for an MPEG-TS adaptation field — with one caveat that is the specification's and not ours: **`af_descr_tag` is unassigned**, printed as "[tbd]" in clause 5.3.3.5. The tag is therefore a required argument rather than a constant, both ends of a deployment have to agree on it out of band, and nothing can interoperate on it until a value is allocated. AV1 is not covered: the spec defers its SEI syntax to the UHD Forum encoder-integration document, which uses a metadata OBU rather than the NAL framing this fork has.

**What a consumer calls, and what sits underneath.** The surface grew carrier by carrier rather than being designed, so it is worth saying which names are entry points and which are the primitives they are built from. Entry points: `variantEncryptor` (a variant's init and segments as a unit), `readSegmentWmPaceInfo` and `readAllWmPaceInfo` (reading, whatever carrier was used), `wmPaceInfoBox` / `wmPaceInfoSeiNalUnit` / `wmPaceInfoTsDescriptor` (writing — the carrier is a publisher's choice, so this one is deliberately a fork), `zeroPadWmPaceInfo` and `neutralizeWatermarking` (egress), `serializeWmSidecar`, `variantsAligned`, and the three DASH scheme-URI helpers. Primitives, correct to call but rarely what you want: `encodeWmPaceInfo` / `decodeWmPaceInfo` are the raw 48-bit codec beneath the carriers; `readWmPaceInfo` / `readWmPaceInfoSei` / `readWmPaceInfoTsDescriptor` are the per-carrier readers `readSegmentWmPaceInfo` tries in turn, useful only when you mean to assert a particular carrier; `variantIv` and `encryptVariantSegment` are what `variantEncryptor` pairs for you.

**Zero-padding for egress.** Clause 5.5.4.2 requires an origin to strip the `WMPaceInfo` HTTP headers and to **zero-pad** `WMPaceInfo` carried in band before a segment reaches a device — the metadata names which bit of a viewer's pattern the segment encodes and is not theirs to read. `zeroPadWmPaceInfo` does that for the `wmpi` box: it zeroes the payload and leaves the box header in place, so not one byte moves. That is the whole point of padding rather than deleting, and the reason the spec puts the box at the start of a segment: removing it would shift everything after it and invalidate byte ranges, the `sidx` indexing them, and the byte-range alignment required between variants. `readWmPaceInfo` reports a padded box as absent rather than malformed. SEI and MPEG-TS carriage is not padded, and deliberately so — zeroing six bytes inside an SEI NAL can create a start-code emulation that would need re-escaping, changing the NAL's length and defeating padding in place.

**Not implemented, and not ours:** WM token generation, which belongs to the WMT Generator — it is JWT issuance and subscriber identity, not media. The spec also requires A and B to be byte-range aligned when segments are delivered as byte ranges, so one `sidx` serves both; the fork does not enforce that and an encoder has to produce it. The spec also requires that when segments are delivered as byte ranges, A and B must be byte-range aligned so one `sidx` serves both — the fork does not enforce that, and an encoder has to produce it.

**Encrypting the variants.** The spec requires A and B to share a content key, so that one DRM license decrypts whichever variant a viewer is served. That leaves the IV as the only separator, and it is load-bearing: two variants encrypted under the same key *and* IV differ in ciphertext at exactly the bytes where their plaintexts differ. Measured on a real file, variants differing in 6 bytes differ in exactly those 6 of ~2 M ciphertext bytes, so XORing the two locates the watermark with no key at all — a passive observer or a CDN log is enough. With separated IVs ~99% of bytes differ and the XOR carries nothing.

`encryptVariantSegment` makes that unsayable rather than merely forbidden. It takes a `baseIv` and a `variant` instead of an `iv`, so no caller can hand two variants one keystream, and it partitions `ivState` by variant internally, so two variants cannot converge on a track's IV later either. `variantIv` is the derivation on its own: the variant lands in the most significant byte while the IV advances from the least significant end, so one variant's sequence would have to run 2^56 samples (8-byte IV) or 2^120 blocks (16-byte IV) to reach another's start.

`cbcs` is supported, but only against a **per-variant init segment**, and it is the weaker choice — for a reason worth stating precisely, because the obvious one is not the real one.

cbcs is the one scheme without per-sample IVs: its IV is a constant in `tenc`, in the init. Two variants sharing an init therefore share that constant. So rather than trust the caller, `encryptVariantSegment` reads the init's `tenc` and refuses unless it states this variant's own IV — build it with `encryptCmafInit` using `variantIv(baseIv, variant)`. A per-variant init is natural under byterange delivery, where each variant is its own file containing its own init; under discrete-file delivery the init is shared by design (clause 5.3.4.2 requires its name not to match the watermarked-object pattern, which is what stops an edge rewriting it), so there cbcs cannot be used at all.

**Even with per-variant IVs, cbcs hides a watermark far less well than cenc**, and this is the part that actually decides the scheme. cbcs is pattern encryption — one block in ten for video — so most of a protected range travels in the clear and is byte-identical between variants. Measured on a real file with 200 marked bytes: under cenc, **0** of them are visible as isolated differences between two separately-encrypted variants; under cbcs, **107** are. Roughly half the watermark positions can be read straight off by anyone comparing two variants, with no key and no license. The IV separation fixes the pinpointing — same key and IV localises the mark to the exact bytes under both schemes, 6 of ~2 M — but it cannot fix what pattern encryption leaves unencrypted.

Measured across an ABR ladder, the share of `mdat` payload that travels **in the clear** — which is the share a watermark can be read from without a key:

| bytes/frame | cenc | cbcs |
| --- | --- | --- |
| 9449 | 0.8% | 89.9% |
| 2090 | 1.2% | 89.8% |
| 1502 | 1.5% | 89.7% |
| 754 | 2.6% | 89.3% |
| 378 | 4.8% | 88.0% |

cbcs sits at ~89% on every rung, which is what a 1:9 pattern predicts and is independent of bitrate. cenc's clear share *rises* as bytes per frame falls — six-fold from the top rung to the bottom — because each NAL's clear header and the 16-byte alignment of its encrypted range are a larger fraction of a short slice. It is the same mechanism as the bytes-per-frame curve above, so the bottom rung of a ladder is both the most expensive to encrypt and the worst at hiding a mark. The advantage still survives it: 4.8% against 88% is an eighteen-fold difference at the worst rung measured. On much smaller pictures it narrows further — a 160x90 fixture measured ~46% clear under cenc — so for very low renditions the figure is worth measuring rather than assumed.

So: prefer `cenc` or `cens` for watermarked content. `cbcs` is permitted where a deployment needs FairPlay from the same copy and accepts that a keyless observer can locate much of the mark; that is a defence-in-depth loss rather than a break, since any two colluding subscribers can diff decrypted content regardless, but it should be a decision rather than an accident.

## Encryption performance, and one idea that did not work

`NATIVE_CRYPT_THRESHOLD` in `src/crypto/aes-ctr-encryptor.ts` is the run size below which the JS keystream beats constructing a native cipher. It is **256**, measured as the knee rather than reasoned: timing cenc at 1024/512/256/128 across renditions put 256 ahead of 1024 by ~20% on low-bytes-per-frame content and level on high-bitrate, with 128 regressing on both.

Which runs clear it is governed by **bytes per frame** (bitrate ÷ fps), because the threshold is in absolute bytes — not by frame rate and not by scene cuts, which matter only through that ratio. Measured across an ABR ladder: 9449 B/frame → 99.9% of encrypted bytes on the native path, 2090 → 91.4%, 1502 → 98.7%, 754 → 85.4%, 378 → 9.3%. Two traps in reading those numbers. Median run size does not predict byte share, because byte mass concentrates in a few large runs — one fixture has a 195 B median run and still puts 92% of its bytes on the native path. And byte share is a mechanism indicator, not a payoff predictor: moving the threshold 1024 → 256 shifted byte share 46 points but time only 20%, since the recovered bytes sit in small runs where per-call cost eats most of the win. The practical consequence is that the *bottom* rung of a ladder is the most expensive to encrypt per byte, so an origin encrypting per request pays most for the rendition it serves to the worst-connected viewers.

**Rejected: one native cipher per IV epoch instead of per run.** Node's CTR cipher keeps its own block offset, so a single cipher created per sample and reused across that sample's runs produces the same keystream while paying construction once — which should have dissolved the threshold entirely. Built and measured, it is not a win: ~18-20% faster on high-bytes-per-frame content but ~5-9% *slower* at the low end, which is the case it was meant to fix. The premise was wrong. Construction is not the only per-call cost; `cipher.update()` itself carries enough overhead (output buffer allocation, boundary crossing) that routing small runs through it loses to the JS keystream. A per-run size test is therefore load-bearing and cannot be replaced by amortising construction. It also cannot be combined with a per-epoch cipher: once an epoch is native it must stay native, because Node consumes the partial keystream block internally and the JS path cannot resume mid-block from it. A refinement that was not tried is committing an epoch to native based on the size of its *first* run, since runs within a sample are correlated — but that trades a byte-identical-by-construction design for a heuristic whose failure mode is a desynced keystream, i.e. silently wrong ciphertext, which is a worse severity class than the slowness it would buy back.

**Verifying a variant is byte-range aligned.** Three shapes, because the useful one is not the obvious one. `variantLayoutOf(source)` derives a rendition's addressable structure — init range, segment ranges, and each top-level `sidx`'s references — by **seeking box headers rather than reading the media**, so a feature-length rendition is described without being materialised; it costs about one small read per fragment and is meant to be derived once and cached beside the source. `layoutsAligned(a, b)` compares two such layouts and is pure, so a transport can hold one per rendition and check a pair per request. `sourcesAligned(a, b)` does both. `variantsAligned(a, b)` is the whole-bytes form, which is convenient offline and unusable on an answer path, since it needs both renditions in memory — that signature is what decides whether the check is a safety net or an offline curiosity, and it was shipped before a consumer pointed that out.

`variantLayoutOf` holds a `SourceRef` for the duration of its walk, because freeing a source's *last* ref disposes it: a caller that releases one while the walk is in flight would otherwise dispose the source underneath it, and the next read throws `the source has been disposed`. `Input` takes a ref for the same reason. This matters more here than it looks, because a layout walk is many reads spread over time rather than one — and the asymmetry is easy to mis-generalise, since a live `Input` survives a caller's free (it holds its own ref) while a bare `readRange` does not.

All three segment a file exactly as `segmentsOf` does, and that is load-bearing rather than incidental: a `styp` opens a segment that may hold several fragments, and a file with no `styp` gets one segment per fragment. Starting a segment at every `moof` instead agrees with `segmentsOf` on files without `styp` and disagrees on files with it — a difference visible only because a test compared the two walks on the same bytes rather than checking each against its own expectation.

The comparison itself answers whether one set of byte ranges, and one `sidx`, addresses two renditions — comparing the init range, the segment count, every segment's offset and length, and any top-level `sidx`, and naming the first thing that differs with the segment index where there is one. A/B delivery needs this: a variant that is *not* aligned gets served at the neutral content's offsets, which yields the right number of bytes from the wrong places — a 200 response that decodes to garbage with nothing to attribute it to. Re-encoding a variant instead of patching the original is the usual way to produce one. A rendition that does not parse is answered as not-aligned rather than thrown, since this runs on publisher-supplied bytes on a verification path.

**Reading a segment whatever carrier it used.** `readSegmentWmPaceInfo(segment)` returns the `WmPaceInfo` from the `wmpi` box or from an SEI message under the spec's UUID, so a consumer does not need to know which a publisher chose; the SEI is located by its UUID rather than by walking sample tables. `readAllWmPaceInfo(bytes)` walks a fragmented file and returns one `{ offset, size, wmPaceInfo }` per segment plus the init, which is exactly the list a byterange sidecar is built from and feeds `serializeWmSidecar` directly. Worth knowing: the structure can never need emulation-prevention escaping — its two fixed emulation bits exist precisely so it contains no adjacent zero bytes — so the un-escaping on that path is a safeguard against malformed input rather than a normal case.

## Upstream behaviour this fork changes

Fixes to upstream code rather than additions. Each is a candidate to report upstream; until upstream takes it, the fork diverges here.

- **A missing decoder now says so.** `Conversion`'s invalidity explanation had a branch for `no_encodable_target_codec` but none for `undecodable_source_codec`, so a conversion that failed for want of a *decoder* fell through to the generic "Check the discardedTracks field for more info." The thrown message opens with "its output configuration is invalid", which points the caller at the output when the cause is the input — in Node, usually that `registerMediabunnyServer()` was never called. There is now a symmetric decodability branch naming the source codec, the `@mediabunny/ac3` / `@mediabunny/dts` packages where they apply, and the `registerMediabunnyServer()` call. The source codec is captured where the track is discarded, since the explanation is built synchronously and `InputTrack.getCodec()` is async (`InputTrack.codec` is deprecated upstream). Covered by `test/node/conversion.test.ts`, which also asserts the branch stays *off* for user-discarded tracks.
  Unchanged, and worth knowing: when only *some* tracks are undecodable the conversion stays valid and silently drops them — an audio+video input transcoded without decoders yields an audio-only file. `showWarnings` (default `true`) is the only thing that surfaces it.

- **Liveness is the container's answer first, then the source's.** Every non-segmented demuxer returns a hardcoded `null` from `getLiveRefreshInterval()`, so `InputTrack.isLive()` was always `false` however the bytes arrived — only HLS and DASH, which read a playlist, could ever report `true`. But the same bytes are a file on disk and a live feed off a socket, and only the source knows which.

  `InputTrack.getLiveRefreshInterval()` now states the precedence in one line: `(await this._backing.getLiveRefreshInterval()) ?? this.input._reader.source._getLiveRefreshInterval()`. A playlist wins when it has an answer; otherwise the source answers. That covers every format at once, including isobmff — fragmented MP4 arriving over a socket is DASH-IF ingest, and it was equally stuck at `false` — and it leaves the eight demuxers untouched, which is eight fewer files carrying a fork edit across a rebase.

  `Source._getLiveRefreshInterval()` is virtual and defaults to `null`; `ReadableStreamSource` overrides it to return its declared `liveRefreshInterval` only while `_endIndex === null`. Liveness therefore *ends* when the stream ends, which is how a playlist already behaves (`EXT-X-ENDLIST` makes HLS report `null`) rather than a second kind of answer that stays true forever.

  The practical consequence is that `Conversion` treats a live feed's duration as unbounded instead of waiting for an end that never arrives; without it an encoder cannot tell a live feed from a file. Still `null` unless a source says otherwise, so nothing changes for file input. Covered by `test/node/live-network-input.test.ts`, which was red before the change.

- **An audio transform no longer hides the encoder's backpressure.** `AudioSampleSource.add()` resolves once the encoder has taken the sample, which is how a caller awaiting each `add` stays within a packet or two of its encoder. With a `transform` stating a sample rate or channel count, the sample goes through `AudioResampler` first — and the resampler accumulated **5 seconds** of output before calling `onSample`, so `add` resolved without the encoder having seen anything. A live pipeline awaiting each `add` therefore ran seconds ahead of its own encoder: measured 568 samples added against 81 encoded, with the whole backlog paid at `finalize()` (2-5 s under load, against 9 ms unloaded). Without the transform the same source stays at ~4 samples.

  The resampler now sizes its buffer from the first input sample (`ceil(numberOfFrames * targetRate / sourceRate)`, floored at the interpolation overflow) instead of a fixed 5 seconds, so one `add` drives one `onSample` and the encoder's backpressure reaches the caller. The 5-second figure was arbitrary: the flush is lazy — it happens only once a write lands past the current buffer — so no buffer size can lose a write, and the padding that makes back-to-back resampled samples artifact-free is the `overflowFrames` region, not the buffer length. Output granularity now matches the input's, which is what the no-transform path already did. The cost is one `onSample` per input sample rather than one per 5 seconds; the gain is that a resampling live lane is no longer unbounded in memory.

  The video `transform` path was checked for the same gap and has none: `add` awaits straight through to `encodeSamples`, and the only thing it holds is the single frame a `frameRate` transform needs to see the next timestamp before emitting. Covered by `test/node/sample-source-backpressure.test.ts`, which measures the backlog with no transform, with a transform pinning the same rate and channel count, with a real 44.1 kHz mono -> 48 kHz stereo resample, and for a video resize — each read against the no-transform baseline rather than an absolute number, since a hardware encoder holds a deeper queue of its own.

## Live network input — `NetworkSource`

`@mediabunny/server` exports `NetworkSource`, so an `Input` can read a live SRT or MPEG-TS-over-UDP/RTP feed the way it reads a file:

```ts
const input = new Input({
	source: new NetworkSource('srt://0.0.0.0:9000?mode=listener'),
	formats: ALL_FORMATS,
});
```

It supplies bytes only — Mediabunny still does the demuxing, so everything the fork's MPEG-TS demuxer knows applies unchanged. The socket is not opened until the `Input` first reads.

**The protocol matrix is measured, not assumed.** node-av 6.1.1 bundles FFmpeg 8.1-Jellyfin built `--enable-libsrt --enable-openssl`; `srt`, `rtmp`, `rtmps`, `udp`, `rtp`, `rtsp`, `http`, `https` and `tcp` are all present (nothing returns `AVERROR_PROTOCOL_NOT_FOUND`, `-1330794744`). Homebrew's `ffmpeg` on a dev machine typically has no libsrt, so test senders for SRT must use node-av's own muxer.

**Bounds travel in the URL query**, because `avio_open2()` takes no AVOptions dictionary and node-av exposes no other way to pass one. Each protocol names and scales its bounds differently, and FFmpeg **ignores an option name it does not know without a word of complaint** — so a wrong name reads as "this protocol cannot be bounded" while the infinite default silently stands:

| protocol | bounds the accept | unit | bounds a silent read | unit |
|---|---|---|---|---|
| `srt` | `listen_timeout` | microseconds | `timeout` | microseconds |
| `tcp` | `listen_timeout` | **milliseconds** | `timeout` | microseconds |
| `udp` / `rtp` | n/a | | `timeout` | microseconds |
| `http(s)` | n/a | | `rw_timeout` | microseconds |

Every one of those defaults to **infinite**. `NetworkSource` therefore takes `connectTimeout` and `readTimeout` in plain seconds, defaults both to 30, and owns the mapping: it **overwrites** the mapped option names on the URL rather than defaulting them, because a caller-supplied value for one of them would reinstate the hang the class exists to prevent. Every other query parameter — `mode=listener`, `pkt_size`, `passphrase` — stays the caller's.

The table doubles as the supported-protocol allowlist, so `rtsp://` is refused by `NetworkSource` even though the bundled FFmpeg has it.

**RTMP is not supported, and the reason is measured.** RTMP parses its path as `app/playpath` and ignores query options entirely: an `open2` of `rtmp://host:port/live/x?listen=1` returns `ECONNREFUSED` in under 5 ms rather than listening. So it can be neither bounded nor put into listen mode from here. An encoder that must publish over RTMP needs a relay in front. (`rtmps` additionally cannot listen at all — FFmpeg refuses with `rtmp_listen not available for rtmps`.)

**An SRT connect error that is followed by success is not a defect.** A host that resolves to more than one address — `localhost` to `::1` and `127.0.0.1`, say — makes FFmpeg try each in turn, and it logs the one that fails before moving on: `Connection to srt://localhost:9820?mode=caller failed (Input/output error), trying next address`, after which the stream runs normally. Other builds word a failure in the same loop as `Connection setup failure: unable to create/configure SRT socket`, which reports socket creation or configuration rather than the connect. Neither is suppressed, because the line is a real failed attempt and hiding it would hide the case where every candidate fails. A literal address logs nothing, which is the control; prefer one in a URL that is built rather than typed.

That multi-address mechanism is reproducible, but it was never confirmed as the cause of the one sighting that prompted this: that publisher used a literal `127.0.0.1`, which resolves to a single candidate, and the line stopped appearing once the disposal abort above was fixed. A likelier reading for the create/configure wording is therefore a socket left in a bad state by an earlier abort, since `Invalid epoll ID` and a failure to configure a socket are both SRT socket-state errors. Treat the line as naming a failed attempt and look for what broke the previous one, rather than assuming name resolution.

**Disposing a listener that is still waiting for a sender wakes the accept.** A pending accept outlives a close: calling `closep()` from JS returns at once and leaves the accept parked in native code until its own timeout, measured at 20 s against the bound it was given. Nothing can interrupt it — there is no `interrupt_callback` and the `AbortSignal` is a cooperative JS check that never runs while a native call is blocked — so `cancel()` satisfies the accept instead, opening a write to the listener's own address. Measured at 10 ms for the self-connect against 20 s for waiting it out, and the fork's own test times the stream's cancel at 0.8 s with the wake and 29.4 s without it.

This matters beyond tidiness: a parked accept holds a libuv thread, so a process that disposed a waiting listener stays alive for the rest of `connectTimeout`, and shortening that timeout is not a fix — the listener then closes and reopens repeatedly and a returning encoder can arrive while it is down. The wake only fires for a listener whose open has not yet resolved; a caller has no accept to satisfy, and a listener that already has a sender goes down the read path below.

**Disposing a listener with no publisher wakes the accept**, the same way `NetworkSource` does and for the same reason: a parked accept outlives a close and cannot be interrupted, so `cancel()` dials the listener's own URL to satisfy it. Measured at 0.8 s against 29.6 s without it.

End detection does not depend on a stream having audio. A publisher that stops — abruptly, or finishing a file and closing — ends the read in 1.3-2.0 s against a 25 s `readTimeout`, in all four shapes the fork tests: a node-av publisher and an ffmpeg one, each with and without an audio track.

**Disposing a connected source waits for the read in flight.** Freeing the I/O context under a pull still blocked inside a native read aborts the process with `Invalid epoll ID`. Nothing can interrupt a blocked read (see below), so `cancel()` marks the stream canceled, waits for the pending read to settle, and closes once; a pull that resumes after cancel touches neither the context nor the controller. Dispose is therefore bounded by `readTimeout` rather than immediate — a caller wanting faster teardown sets a shorter one.

A test for this has to leave a read genuinely parked: breaking out of a packet loop first leaves nothing pulling, and passes against unfixed code.

**There is no way to cancel a wait once it starts.** node-av exposes no `AVFormatContext.interrupt_callback`; its `AbortSignal` is a cooperative JS check — `throwIfAborted()` on entry and `.aborted` between loop iterations — so nothing runs while a native call is blocked in accept or connect. Repro: open an `srt://0.0.0.0:PORT?mode=listener` with a signal and no sender, abort after a second; the promise never settles and the process must be killed. The bounds above are therefore the only defence, which is why neither defaults to infinite. `test/node/live-network-input.test.ts` asserts a listener fails **both** slower than half its `connectTimeout` and inside a ceiling — an upper bound alone passes on any instant failure, which is exactly how RTMP once looked bounded when it was only refusing to connect.

**A clean end is not a delivery receipt.** When a sender stops, the packet iteration ends normally rather than throwing, so a live consumer should treat end-of-iteration as the stream's end. But a normal end means "the sender went away", not "everything it wrote arrived": closing an SRT socket immediately after the last write discards what is still in flight — live mode drops packets past their deadline and `linger` does not save them. Measured at 125 packets sent, 121 received, the missing four being the *last* four; a 300 ms drain before close recovered all 125. `test/node/_live-sender.ts` drains for that reason, and anything that must know the stream ended completely has to establish it from the content.

**A sender must close its socket itself, and `Muxer.close()` does not.** node-av's `Muxer.close()` frees the format context without closing the AVIOContext underneath it, so the socket stays open until the sending *process* exits and the OS closes it. The receiver is not at fault and no bound is involved: it ends promptly once the socket actually closes, and a reader that never sees one waits out its `readTimeout` instead. Measured with a sender that holds 10 s past its close — the receiver's end arrived 0.36 s after process exit, 10.4 s after `close()` returned, as `AVERROR -5` (a broken socket) rather than a graceful EOF.

The fix is one call, and the order is the whole trick:

```ts
await muxer.getFormatContext().pb!.closep();
await muxer.close();
```

`pb` has to be closed **before** `close()`, because `close()` frees the format context and leaves the handle dangling — doing it after, or calling `formatContext.closeOutput()` after, measures as a no-op. The receiver's end then lands within 10 ms of the close, byte-for-byte identical to the late case (741 reads, 974968 bytes), so nothing in flight is sacrificed. The cost is that `close()`'s trailer write goes to a closed socket: free for MPEG-TS, which has no trailer, but this would truncate a format that does.

This fork ships no network *sink*, so there is nothing here to fix — it is a constraint on any sender feeding a `NetworkSource`.

- **MPEG-TS now reports the PES decode time.** `readPesPacketHeader` read `ptsDtsFlags` and then, even for `0b11` (both timestamps present), parsed only the PTS. The DTS was discarded, so `EncodedPacket.decodeTimestamp` fell back to equalling `timestamp` for every packet — wrong for every B-frame, and wrong in the one place it is load-bearing: remuxing TS to CMAF needs a decode time to place a sample, and anything consuming a reordered TS gets a decode order it cannot reconstruct. Upstream has the same code, so this is additive rather than a regression.

  One detail is invisible until a second field is read: a PTS is a **40-bit** field holding a 33-bit value — a 4-bit prefix, three value runs, and a **trailing marker bit**. Reading only 39 bits is harmless while the PTS is parsed last, but a DTS follows it immediately, so a reader that skips the trailing marker starts one bit early and produces timestamps near 2^32. `readTimestamp()` consumes the full 40 bits and is shared by both fields.

  Only the first access unit of a PES packet carries timestamps; later ones have a derived PTS and no stated decode time, so they report `null` and `EncodedPacket` falls back to the presentation time for them, which is correct. Covered by `test/node/mpeg-ts-matrix.test.ts`, which asserts the demuxer's decode times are non-decreasing and differ from the presentation times wherever the wire says they do — red before the change, with the reported decode times being the PTS values in decode order.

- **A segmented output's callbacks are awaited.** `onInit`, `onSegment` and `onSegmentPopped` are declared `=> unknown`, so returning a promise was always expressible — but nothing awaited it, leaving a consumer no way to slow the pipeline down. One that uploads each segment had to buffer without bound, or drop to stay inside its memory. All three are now awaited, so the pipeline waits for the consumer. No signature changed; a callback returning `void` behaves exactly as before.

  `onInit` fires from a `'finalized'` listener, which cannot await, so its result is held on the playlist and drained before that playlist's first segment is announced. A consumer therefore sees the init segment complete before any segment of it — which it needs, since a segment is unplayable without the init. Covered by `test/node/hls-output.test.ts`, which is red without the awaits: `onSegment` fires while `onInit` is still outstanding.

- **An audio transform absorbs a source that changes, which is what it is for.** `AudioSampleSource` checked that channel count and sample rate stayed constant on the sample it was *handed*, before any transform ran. So a conversion with `transform: { sampleRate: 48000 }` still failed with `Audio parameters must remain constant. Expected 1 channels at 44100 Hz, got 1 channels at 48000 Hz` the moment the source rate changed — which is exactly what a failover between two inputs at different rates looks like, and exactly what pinning the rate was supposed to make irrelevant.

  The invariant belongs to what reaches the encoder, not to what the source supplies, so the check now compares the post-transform values: `transform.numberOfChannels ?? sample.numberOfChannels` and `transform.sampleRate ?? sample.sampleRate`. A transform pinning one value no longer constrains that value at the input, while anything it does not pin is still required to be constant — covered both ways, since with no transform a change of input rate is still rejected.

- **Nor does a video transform that states the output size.** The same check, the same way round: `VideoSampleSource` compared the size of the sample it was handed, so `transform: { width: 1280, height: 720 }` still failed with `Video sample size must remain constant` the first time the input resolution changed, although every frame reaching the encoder was 1280x720. A transform stating both dimensions, or the crop rectangle they come from, now holds the size itself and a changing input is no longer a size change — while a transform stating only one dimension leaves the other derived from the input, so that is still denied. Covered both ways in `test/browser/media-sources.test.ts`.

- **Interleaving no longer waits forever on a track that has gone quiet.** Every muxer here paused all output while any *open* track had an empty queue. That is right for a track that is merely behind and wrong for one that has stopped: a live publisher whose audio goes quiet — a muted microphone, an encoder that stops sending audio — stopped sending video too, and everything buffered appeared only at `finalize()`. Measured on a 25 s video timeline whose audio stops at 6 s: 9.8 MB of 40 MB written before finalize for MPEG-TS, 8.8 MB for fragmented MP4, and 2 segments of 15 for a shared HLS playlist.

  `maxInterleaveDelta` bounds the wait, in seconds of media, defaulting to **10** as FFmpeg's option of the same name does. Once the other tracks have piled up that far past the quiet one, its turn is given up and it simply gets a gap. It sits on `MpegTsOutputFormatOptions`, `IsobmffOutputFormatOptions`, `MkvOutputFormatOptions`, `OggOutputFormatOptions` and `SegmentedOutputFormatOptions` — every format here that interleaves more than one track — and `Infinity` restores the old unbounded wait.

  A subtitle playlist waits on the same bound. It held its segments until a cue arrived at or after the segment's end, which a captioner with nothing to say never supplies, so a silence left a player's text track falling further behind the media the longer it lasted. The media segment boundaries are the clock: once they have run more than `maxInterleaveDelta` past the segment being held, it is written with the cues that did arrive.

  Segmented outputs are only affected when a playlist holds more than one track; tracks in separate playlists never wait for each other, which is why the fork's test covers both shapes and only the shared one was red. Each case is covered by a test that runs the same stream twice, once bounded and once with `Infinity`, and asserts the bounded run writes materially more before `finalize()` — compared against the unbounded run rather than against a fraction of the total, because how many bytes land early depends on the container while the bound's effect does not.

  **ISOBMFF and Matroska each need the bound in two places.** Besides interleaving, both cut a fragment or cluster only when every *other* track has a queued key frame or is closed, and a track that is open but quiet is neither — so without the bound nothing reaches the target until the fragment or cluster hits its own ceiling. A test for this must use `fastStart: 'fragmented'`: on the progressive path bytes stream into `mdat` regardless of that gate, so the row passes for an unrelated reason. The first attempt left output byte-for-byte unchanged — bounded and unbounded both wrote exactly 8 035 892 bytes before `finalize()` — because a second gate dominates: a cluster is only cut when every *other* track has a queued key frame or is closed, and a track that is open but quiet is neither. So no cluster was cut, and nothing reached the target until the cluster hit its 32 767 ms ceiling. All of it now goes through one `quietTrackMayBeSkipped(queues, timestampOf)` on the shared `Muxer` base, with a `maxInterleaveDelta` getter each format overrides — the wrapper had been written four ways, and an accessor rather than a mapped array keeps the hot interleave loop allocation-free. Starting a cluster or fragment on a delta frame was already accepted for the ceiling case, so nothing new is being tolerated.

- **Audio segments sit on the target grid instead of drifting off it.** An audio frame rarely divides the target duration — 1024 samples at 48 kHz is 21.333 ms, so a 2 s target is 93.75 frames — and cutting at the last frame that fits took 93 of them every time, 1.984 s, 16 ms short. That error then anchored the next boundary, because the boundary was the previous cut plus the target, so it compounded: measured at 0.992 s of accumulated offset across 65 segments, while video stayed on the grid. A consumer syncing an audio playlist against a video one drifts apart for as long as the stream runs.

  Two things were wrong and both had to change. The grid is now anchored to where the first segment began and a boundary is *n* × target from there, so a rounding error cannot become the origin of the next one. And the cut goes to the frame **nearest** the boundary rather than the last that fits, which is unbiased, so the residual stays inside half a frame indefinitely instead of always falling the same way. Covered in `test/node/hls-output.test.ts` over 65 segments of 48 kHz AAC beside 2 s video, asserting the worst offset is under one frame and that the later half is no worse than the earlier half; it reports 0.992 s without the fix.

  This diverges from upstream deliberately, which is why `Segmentation, audio not lining up with segment boundaries` carries different expectations here. Upstream's rule never exceeds the target; nearest-frame can run up to half a frame long, and that test's second segment is 2.25 s against a 2 s target as a result. It stays spec-legal — RFC 8216 requires each `EXTINF`, rounded to the nearest integer, to be at most `EXT-X-TARGETDURATION`, and `globalTargetDuration` tracks the longest segment — but a frame longer than 2 s would break that arithmetic, which no audio codec produces. The same test also now passes real frame durations: with the zero durations it used before, a final segment holding one frame reports `#EXTINF:0`.

- **`HlsOutputSegmentInfo.isLast` — which segment ends a playlist.** A consumer that must mark its last segment could not work it out: neither `n` nor the output's state says so, because a single `finalize()` closes every playlist and `state` reads `'finalizing'` throughout, so the only reliable signal was `execute()` resolving — one segment too late to act on.

  `isLast` is decided at the moment a segment is written, not guessed ahead: a playlist can cut no further segment once every track it holds is closed and drained of packets, so a segment written in that state is its last. That needs no lookahead and is exact per playlist, so audio resolves independently of video rather than inheriting a global "everything is done". Subtitles are driven by boundaries rather than packets, so theirs asks whether the boundary list emptied instead.

  It reads `false` in `getSegmentPath`, and the field says so: a path is chosen before the segment's media is written, which is before the last segment can be told apart from any other. Covered in `test/node/hls-output.test.ts` by asserting exactly one `isLast` per playlist at the highest `n` — red both ways, reporting 3 of 1 when forced true and 0 when forced false.

  The case that motivated it needs a real encoder to reproduce, so a second test lives in `test/node/server-extension.test.ts`. Feeding packets directly never flushes more than one pending segment, because segmentation cuts as soon as a key frame past the target is known. An encoder holds a lookahead — x264's `rc-lookahead` plus the B-frame delay — so its flush releases more than one segment's worth at once and `finalize` cuts several in a single pass. Reproducing it needs the key frame interval *and* the target below that lookahead, since a GOP floors a segment's length: at a 1s interval the flush fits inside one segment and nothing is proven, while at 0.25s it is 48 segments with 2 written during finalization. That test asserts both, and is red the same two ways.

- **`Conversion.finish()` — stopping a live conversion without losing the open segment.** A live input never ends, so the only way to stop was `cancel()`, which throws `ConversionCanceledError` and discards the segment in progress. Anything needing to mark its last segment therefore had to hold one back, paying a segment of latency for it.

  `finish()` stops reading the input and lets the output finalize, so the in-flight `execute()` resolves normally and the last segment is written. It reuses the existing per-iteration guards: each track loop already broke out on `cancel`, and now does the same when finishing, so the encoder flushes and the pump completes rather than parking. `_checkpoint` also stops suspending a finishing pump, or it would never reach the end of its loop. Covered in `test/node/live-network-input.test.ts` against a real SRT sender: swapping `finish()` for `cancel()` turns the test red with `Conversion has been canceled.`

- **`ReadableStreamSource.end()` — ending a stalled live source without losing what is held.** `finish()` is the output side of this; `end()` is the input side, and the two answer different halves of a lost feed. A feed that stops sending bytes without closing leaves packets inside the demuxer and frames inside the decoder, and the only way to stop waiting was to dispose the `Input`, which rejects the parked read with `InputDisposedError` and abandons both. Only the stream closing itself ever drained them, which a lost feed by definition does not do.

  `end()` declares the byte stream over at the point it has reached: the parked read and every later one resolve as reads past the end of the file, exactly as the stream's own close resolves them, and the reader is cancelled so nothing delivered afterwards is read. The demuxer then emits the packets it holds, including a last partial PES, the decoder flushes, and the tracks stop reporting `isLive`. `NetworkSource`, `RtmpSource` and `RistSource` all extend `ReadableStreamSource`, so one method covers every live source. The test in `test/node/live-network-input.test.ts` cuts a fragmented file mid-GOP and feeds the prefix without closing: `end()` yields exactly the frames a stream that closed at the same byte yields, where disposing yields fewer. Without the drain the test hangs rather than merely disagreeing, since the iteration never completes.

- **`encoderControls.sceneCut` — an intra frame at a cut without moving a sync sample.** `false` by default, so the output is unchanged; a threshold of 1 to 100 turns on x264's and x265's scene-cut detection, or SVT-AV1's. The point is the frame at a cut stops being predicted across it, while the sync samples stay only where `keyFrameInterval` forces them — that is what keeps a ladder's rungs aligned and keeps a segment from starting at a cut.

  **The pin is the whole feature.** Measured: turn scene-cut detection on and nothing else, and a cut that falls past the encoder's own minimum interval is promoted to a full IDR — x264 gave `IDR [0, 30, 48]` for a cut at frame 30 against forced key frames at 0 and 48, and x265 the same. That is a sync sample off the grid, which breaks exactly what the control is for. So `min-keyint` is pinned beyond any real forced interval, and the cut can then only become an intra frame that is not a sync sample: `IDR [0, 48]`, `I [30]`.

  **What is guaranteed, and what is the encoder's heuristic.** The grid is a guarantee. Which cuts get detected is not: it depends on the content, and a cut into high-entropy material may not trip the metric at all because coding it is expensive either way. On the fixture in `test/node/scene-cut.test.ts` — four shots of distinct low-entropy structure, cut at 1.3 s, 3.7 s and 5.1 s — x264 finds all three and x265 two of the three. So the tests assert that intra frames appear, that every one of them sits at a cut rather than mid-shot, and that none appear with the control off; they do not assert that every cut is found, because that is not ours to promise.

  SVT-AV1 takes `scd=1`: measured to leave the forced key frames alone, though whether it codes the frame at a cut as intra was not verified, which would need OBU frame-type parsing. Everything else, hardware encoders included, refuses a stated `sceneCut` rather than ignoring it. Note two-pass needs a bitrate target — x264 refuses it alongside constant quality — which is unrelated to this control but is what a two-pass row of a ladder has to use.

- **`Quality` is readable.** `level`, `bitrate`, `quantizer`, `maxBitrate`, `bufferSize`, `bitrateMode` and `preferBitrate` are public getters mirroring what the constructor was given, so a caller deciding whether a rate control applies — refusing two-pass on a quality that states no bitrate, say — no longer has to read the `@internal` fields.

  There is deliberately **no `kind` discriminator**. A `Quality` is not one of three things: `{ quantizer: 30, bitrate: 2e6 }` states both, the quantizer being what is demanded and the bitrate the fallback for a codec that cannot encode by quantizer, and a cap is orthogonal to either. A single `kind` would have to drop one of them, which is how a reader ends up confidently wrong about what it is holding. Test each field on its own.

- **`VideoEncoderControls` — stating what the encoder does, instead of it being decided internally.** `VideoEncodingConfig.encoderControls` and `ConversionVideoOptions.encoderControls` carry `profile`, `level`, `preset`, `tune`, `maxBFrames`, `closedGop`, `pass` and an `options` escape hatch. A VOD ladder needs them per rung; before this a caller got whatever `@mediabunny/server` chose, which was the encoder's default outside realtime.

  A control the selected encoder has no option for is **refused**, not dropped: a rung encoded without the profile it asked for is not that rung. `options` is passed straight to the codec context by FFmpeg's own option names, and for x264 and x265 it merges into `x264-params`/`x265-params` alongside the parameters this library needs for key frame alignment — a key that would overwrite one of those is refused rather than silently replacing it, since losing `scenecut=0` would break segment alignment across the ladder with nothing to show for it.

  Two-pass is `pass: { index, statsPath }`, the caller running two encodes over the same samples. It is a field rather than something `options` can express, which is the one thing here that had to be measured: `pass=1` inside `x264-params` is ignored, and so is `flags=+pass1` through `setOption` — FFmpeg drives it from the codec context's own flags, so the control sets `AV_CODEC_FLAG_PASS1`/`PASS2` there and puts `stats` in the encoder's params.

  A `fullCodecString` **the caller states** naming a profile and level is treated as a request rather than only a label, which is what `extractVideoProfileAndLevel(codecString)` reads out of it — `avc1.42001e` encodes Baseline at level 3.0. An explicit `profile`/`level` is the more specific statement of the same thing, so it wins. Only the bit depth was taken from the string before.

  The string this library builds for itself when the caller states none is **not** such a request, and the distinction is the whole of it. That string's level is derived from the size and bit depth — `hev1.2.4.L60.B0`, level 2, for a 144p 10-bit rung — and a level is not a label to an encoder: x265 holds the stream to its VBV limits, which capped an uncapped quality encode to 1.69 Mb/s, and refused to open at all where the picture exceeded the level. So the config carries `_codecStringIsDerived` and only a stated string reaches the encoder. x265 is then told no level (`level-idc=0`) and states the one the stream actually needs. Note x265 counts a level in tenths where the HEVC codec string counts in thirtieths, so a stated `L153` is level 5.1 is `level-idc=51`.

  Every control is tested by reading its effect out of the bitstream, because **an FFmpeg option FFmpeg does not recognise is ignored by FFmpeg** — a misspelled name leaves the default in place and reports nothing, so "the encode succeeded" proves nothing. Profile and level come back from the SPS through `getCodecParameterString()`; `maxBFrames` from whether the stream is reordered at all; `preset` and merged `options` from x264's own settings SEI (`subme=0` for ultrafast, `aq=3:` for a caller's `aq-mode=3` against x264's default of 1); and the second pass from `rc=2pass`, which only a pass reading those statistics reports. A first pass is still `rc=abr` — what makes it a first pass is the statistics it leaves behind.

- **A feed cut mid-frame ends cleanly.** Two defects surfaced together the first time `end()` was used on a live A/V feed. The MPEG-TS demuxer supplied whatever bytes had arrived for the final audio frame, so a frame shorter than its own ADTS/MP3/AC-3/E-AC-3/DTS header declares reached the decoder, which refuses it ("Send packet: Invalid data") and ended the sample iteration. `ensureBuffered` caps at the length asked for, so a short return is precisely "the feed stopped inside this frame" and the frame is now dropped rather than supplied — it is not a sample, and there is no later byte coming to complete it.

  Underneath it, `CallSerializer.call` stored the uncaught promise as the chain head, so one failed call rejected every later one *without running it*: the `close()` queued behind a failed decode never closed the decoder, and rejected in its place where nothing awaited it — an unhandled rejection in any Node host. The chain now holds a caught promise while each caller still receives its own rejection, so an error still reaches whoever asked for the work and the queue survives it. That applies to every custom decoder and encoder, not only this path.

- **`extractVideoBitDepth(codecString)` is exported** — the bit depth a video codec string declares, or `null` where it states none. `Conversion` uses it to inherit a source's bit depth; a caller driving encoders directly had no way to do the same, and a 10-bit SDR mezzanine silently produced 8-bit output. Demand the result only where `canEncodeVideo` accepts it, since a codec may be decodable at a depth it cannot encode.

- **`extractVideoBitDepth` reads the decoder config, because an AVC or HEVC codec string has no bit depth in it.** It now takes `string | VideoDecoderConfig`, and given a config it reads `bit_depth_luma_minus8` out of the SPS in the `avcC`, or the field `hvcC` states directly. Pass the config wherever there is one.

  **This was wrong, not merely imprecise.** An AVC profile only *bounds* the depths a stream may use, and the old reading took the bound for the value: `avc1.f4000c` is High 4:4:4 Predictive, which permits 8 to 14 bits, and it read as 10. x264 encodes lossless in that profile, so every 8-bit lossless source read as 10-bit — and a consumer inheriting the source's depth made every rung of its ladder 10-bit. The same ambiguity is in HEVC's Range Extensions profiles, where a 12-bit stream read as 8.

  Two call sites inside this library were reading the string where they held the whole config, and both are fixed by the same change: `Conversion` inheriting a source's bit depth, and the check in `media-source.ts` that drops a transfer the output depth cannot carry. `@mediabunny/server`'s encoder keeps passing the string, and should: there it is an encode *request*, with no SPS to read.

  Without a config the profile is still all there is, so the old reading remains the fallback. `test/node/bitstream-info.test.ts` covers x264 lossless 8-bit (reads 8 from the config, 10 from the string alone — the regression, asserted in both directions so the case cannot quietly stop covering anything), High 8-bit, AVC 10-bit, HEVC Main and Main 10, and a 12-bit RExt `hvcC`. Note what the fixtures could *not* produce: x265 ignores a `main444-8` request on 4:2:0 input and encodes Main, so no real encode here reaches a RExt profile, which is why the 12-bit case edits a record instead and says so.

- **`InputTrack.getPresentationOffset()` — the span of media that is decoded but never presented.** The offset between a track's media timeline and its presentation timeline, in seconds: media at `t` is presented at `t - offset`, and `0` where the container states none. It is an ISO BMFF edit list's media time, and Matroska's `CodecDelay`; both demuxers already subtracted exactly this value to produce presentation timestamps, and neither said what it was.

  Its usual cause is encoder delay. An AAC encoder emits 1024 priming samples that a decoder needs and a player discards, and the container states the skip — so `ffprobe` reports such a file as starting at 0 while this library's first packet sits one frame below it. **The packets are deliberately still yielded, below zero**, because a decoder needs them and a muxer copying the track has to carry them; a reader that wants only the presentation drops the packets with `timestamp + duration <= 0`. Measured on an ffmpeg-written AAC file, nothing else was wrong: the edit list is parsed, `computeDuration()` already returns ffprobe's 2.000 exactly, and a `Conversion` copy re-writes the same `elst` and reads back identically in ffprobe. Only the reader had no way to tell that span from a track that simply starts early, which is why this is an accessor and not a change to what the sinks yield.

  `test/node/edit-list-priming.test.ts` works from a committed ffmpeg fixture (`test/public/aac-priming.mp4`) and from a mediabunny-written copy of it, asserting the offset, that the raw first packet survives, and that dropping what the offset covers leaves ffprobe's start time and duration. The control is an AAC file with no edit list, which must read `0`: without it, an accessor hard-coded to the priming would pass everything else. The Matroska side is covered from existing fixtures rather than a contrived one — `demo.webm`'s Opus track states a 7 ms pre-skip and `ac3.mkv` 5 ms, each asserted to equal exactly what its first packet sits below zero by, while the video track beside them reads `0`.

- **Reading what the container does not carry: slice types and AV1 film grain.** Two facts a consumer otherwise traces with `ffprobe`, which is the whole reason they are here: both are in the bitstream, and nothing above it repeats them.

  `readVideoSliceType(packetData, decoderConfig, codec)` returns `'i'`, `'p'` or `'b'` for an AVC or HEVC packet's first coded slice, or `null` where the bitstream states nothing it reads. It is orthogonal to `EncodedPacket.type`, which says whether a packet is a random access point but not how it is coded — the pair is what makes a **non-IDR I-frame visible**, which is exactly what `encoderControls.sceneCut` produces and what no container field distinguishes from a sync sample. `decoderConfig` states the NAL length prefix size; Annex B data is walked by start code. It reuses the per-codec NAL framing the SEI reader already has, so there is one table deciding what a VCL NAL unit is.

  `createAv1FilmGrainStateReader(description)` reads the sequence header's `film_grain_params_present` and each frame header's `apply_grain`. It is **stateful by necessity, not by preference**: `apply_grain` sits at the very end of the uncompressed frame header, past fields an inter frame reads out of its reference frames' state, so a unit can only be read once the units before it have been — the same constraint the CENC tile parser lives under, and it reuses that parser rather than adding a second AV1 frame-header reader. Pass the `av1C` description so the reader starts with the sequence header a stream's packets may not repeat; a reader fed only some packets reads the rest as malformed.

  Tested in `test/node/bitstream-info.test.ts` against real libx264, libx265 and libsvtav1 encodes. The slice-type test does not stop at "all three kinds appear", because a mapping with `'p'` and `'b'` swapped satisfies that and also satisfies every sync sample being `'i'`. It cross-checks against the container's decode and presentation order instead — a packet decoded after a frame it presents before can only be a B frame, and a P frame never is one. Swapping the mapping turns only that assertion red, which is how the gap was found. Film grain is checked both ways: SVT-AV1 with `film-grain=12` reads as present with grain applied, the same encode without it as absent on every packet, so neither direction can pass vacuously. `scene-cut.test.ts` now reads its slice types through this export rather than a test-local parser, which deleted the helper and puts the public reader under the multi-codec encodes that already existed.

  **No in-process VMAF.** Asked for alongside these, and not possible in this fork: there is no native build here to put `libvmaf` into. Every package is TypeScript, and `@mediabunny/server` gets FFmpeg from `node-av`'s prebuilt binaries, whose build has `psnr` and `ssim` but no `libvmaf` filter (`Filter.getByName('libvmaf')` returns nothing). Adding it would mean forking node-av's FFmpeg build and shipping our own binaries for every platform triple, which is node-av's business and not a fork of a TypeScript library's. There is also nothing to depend on instead: no npm package ships libvmaf bindings, and no WebAssembly build of it exists — the one prebuilt-binary crate is Rust and Ubuntu-only.

## Live RTMP input — `RtmpSource`

**A publisher going away ends the stream; since node-av 6.2 that arrives as an error.** A live publish normally ends by the peer closing the socket, and libavformat reports that as `EIO`, having no EOF for a socket. node-av 6.2 changed its IO adapters so a read failure is reported as an error rather than a clean end of stream, and its demuxer now propagates read errors — so the close that used to end the packet iteration cleanly began throwing `FFmpegError: Input/output error` instead, and every reader of a publisher that stopped got a rejection where it had got its packets and a normal end. The packet loop now reads `EIO`, `EPIPE` and `EOF` as the end.

The catch is deliberately only around the packet loop, after the demuxer has opened. A *connect* that times out or cannot reach its address still fails loudly, which is what the `connectTimeout` and unreachable-address tests assert. Upstream has no RTMP source and so no test that would have caught this: it was found by this fork's own `test/node/rtmp-input.test.ts`, where four tests that assert a stopped or finished publisher ends the stream promptly turned red on the dependency bump.

`@mediabunny/server` exports `RtmpSource`, so an `Input` can read a live RTMP publisher:

```ts
const input = new Input({
	source: new RtmpSource('rtmp://0.0.0.0:1935/live/key', { mode: 'listener' }),
	formats: ALL_FORMATS,
});
```

The FLV is remuxed to fragmented MP4 **in process** — no relay, no temporary files, and no FLV demuxer in Mediabunny. AVC and HEVC (enhanced RTMP) pass through without re-encoding, as does AAC. `mode` defaults to `'caller'`, so a URL names something to connect to unless listening is asked for, matching `NetworkSource` where listening is likewise explicit.

**Options are real AVOptions, not URL query.** rtmp parses its path as `app/playpath` and ignores the query entirely, which is why `NetworkSource`'s approach cannot work here and why this is a separate class. node-av's `Demuxer` accepts an options dictionary, so the bounds travel there:

| bound | option | unit | note |
|---|---|---|---|
| accept a publisher | `timeout` | **seconds** | listener only — it *implies* `listen`, so a caller given it tries to bind |
| silent read | `rw_timeout` | **microseconds** | the read outlasts it by a multiple, measured 2-3x |

Both were measured rather than read off the option names. `timeout=2` fails at 2.13 s and `timeout=6` at 6.16 s, which is what fixes the unit — one value cannot. For the read bound, a publisher frozen with `SIGSTOP` so the socket stays open and goes quiet ends at 6.26 s for `rw_timeout=3000000` and 12.32 s for `6000000`, and never without it.

**`readTimeout` reaches `rw_timeout` unscaled, and silence is also timed in JS.** `rw_timeout` bounds a single read rather than the session, and FFmpeg resumes mid-packet after it fires instead of ending the stream — the FLV demuxer reports that as a packet mismatch and packets are lost silently. Scaling the value down therefore destroys data: a stall shorter than `readTimeout` gets cut mid-packet. Scaling it up only makes an ended stream slower to notice, because the pump unwinds on FFmpeg's schedule, so the end arrives a small multiple of the bound after the publisher stops however short the JS clock is.

`readTimeout` also drives a JS clock that ends the stream between fragments, where the demuxer is whole. The clock starts at the first byte, not at open: waiting for a publisher is the connect bound's business, and timing that as silence ends the stream before it starts.

`connectTimeout` governs listening only, and that is a protocol constraint rather than an oversight. Passing rtmp's `timeout` to a caller rewrites the connection as `tcp://host:port?listen&listen_timeout=…`, so the caller tries to bind and fails instantly with `Can't assign requested address`. A caller's connect is bounded by the protocol instead: an unreachable, non-routable address fails in about five seconds whatever `connectTimeout` says.

**The sink is `Muxer` into a `Writable`, not `FMP4Stream`.** `FMP4Stream` is the obvious candidate and it emits **nothing at all** for a video-only input — not an error, no output. A/B on one file with one variable changed: `video.mp4` gives 203 795 bytes of `ftyp,moov,moof,mdat,…`, and the same file with its audio stripped and video copied untouched gives 0. Not RTMP (it fails the same way on a plain file), not codec-string matching (the file's exact `avc1.640015` and an empty list both give 0), not the AAC declaration. A video-only publisher is ordinary, so that disqualifies it.

Fragment flushing needs the duration, not the flag. Over 300 packets: `frag_keyframe+empty_moov+default_base_moof` alone writes 800 bytes — `ftyp` and `moov`, everything else still buffered; adding `flush_packets=1` changes nothing; `frag_every_frame` writes 153 808; and `frag_keyframe` with `frag_duration` writes 111 151, which is the same incremental behaviour for 28 % fewer bytes. `fragmentDuration` defaults to 0.5 s.

**Disposal waits for the read in flight**, for the same reason `NetworkSource` does: closing the demuxer under a parked native read aborts the process, and nothing can interrupt one. `cancel()` marks the stream canceled, waits for the pump to settle, then closes. The muxer side needs no such care — a callback-backed I/O context is freed rather than closed, so there is no socket there to race.

Timestamps survive the remux, and the invariant is the decode time, not the presentation time. `EncodedPacketSink` yields in decode order, so presentation times arrive reordered wherever B-frames say they should — 45 of 120 packets step backwards on a normal AVC source, which is correct and not a defect. What must hold is that decode times never decrease, that `pts >= dts`, and that the presentation sequence matches the same file read directly with the same demuxer, rebased on each sequence's own first packet since the remux may shift the timeline. `test/node/rtmp-input.test.ts` asserts all three.

**node-av cannot serve an RTMP output.** Its `options` reach the muxer rather than the protocol, so `rtmp_listen` comes back `Option not found` and nothing binds — confirmed with `lsof`. The test publisher is node-av everywhere except the caller-mode test, which needs a *server* and uses `ffmpeg -listen 1` for that one reason. Everything else uses node-av's bundled FFmpeg, which carries rtmp and the flv muxer, so the suite does not depend on whichever ffmpeg a machine happens to have.

One wart worth knowing when publishing FLV with node-av: `addStream` carries the source's `avc1`/`hvc1`/`mp4a` codec tag across and FLV rejects it (`Tag avc1 incompatible with output codec id '27'`). node-av clears an incompatible tag only when the output format offers a replacement, and FLV's table offers none, so `test/node/_live-sender.ts` clears it explicitly.

## Timed events on the read side — `emsg` and SCTE-35

The fork could already *write* an `emsg` (`buildEmsgBox`, `insertBoxesBeforeMoof`); it could not read one back, and it dropped SCTE-35 entirely. Both are now readable, as standalone byte-level functions in the shape `readSegmentHead` already set: no new track kind, no demuxer plumbing, and nothing to thread through `Input`.

**`readEmsgs(segment)`** returns the Event Messages a packaged segment carries, in order, each as an `Emsg`: `schemeIdUri`, `value`, `timescale`, the duration, the id, the payload, and exactly one of `presentationTime` (version 1) or `presentationTimeDelta` (version 0), matching the box version. `parseEmsgBody` reads one box body on its own and is the exact inverse of `buildEmsgBox`, which is how it is tested — round-tripped both versions, plus a box cut inside a string, inside a 32-bit field, and carrying an undefined version, each of which throws rather than returning a half-read event.

**`readScte35Sections(bytes)`** pulls `splice_info_section`s out of MPEG-TS with the splice point each one states. Two details matter more than the parsing:

- **The PID comes from the program map, never from the stream type alone.** Stream type `0x86` is SCTE-35 only when the elementary stream carries a `CUEI` registration descriptor; without it the same value means DTS-HD Master Audio, which is what the fork's `MpegTsStreamType` enum already calls it. A stream with `0x86` and no `CUEI` therefore yields nothing, and that is a test, not an assumption.
- **The time is `pts_adjustment` plus the command's `splice_time`**, wrapped into the 33-bit range, because SCTE-35 rides in private sections rather than PES and so has no packet PTS of its own. `time` is `null` where the command states no point: a `splice_null`, a cancelled event, a `splice_immediate_flag` insert, a per-component splice, or an encrypted section — each of which is a stated absence rather than a zero.

Sections are reassembled across packets and one still incomplete at the end of the buffer is dropped rather than returned partially.

## `<ServiceDescription>` reaches the writer

The MPD model, parser and serializer already carried `<ServiceDescription>` with `Scope`, `Latency` (`@target`, `@min`, `@max`, `@referenceId`), `PlaybackRate`, `OperatingQuality` and `OperatingBandwidth`, at both MPD and Period level. What no caller could do was *set* one on the writer path: `MpdParams` had no field for it and the `mpd()` factory hardcoded an empty list, so a DASH output had no way to state a latency target and a low-latency player kept its own default delay.

`MpdParams.serviceDescriptions` now renders under the root `<MPD>`, and the `mpd()` factory carries them for AST callers. Times stay in milliseconds, as ISO/IEC 23009-1 states them — a seconds conversion would turn a 3000 ms target into 3.

## `@availabilityTimeOffset` where the spec allows it

ISO/IEC 23009-1 5.3.9.2 allows `@availabilityTimeOffset` and `@availabilityTimeComplete` on `SegmentList` as well as `SegmentTemplate`, and 5.6.4 allows them on `BaseURL`. All three carry them here, parsing and serializing, so a low-latency Period written as an explicit `SegmentList` can state its availability — a `$Number$` template is no longer the only form that can.

Both are optional on `MpdBaseURL` and `SegmentList`, and the parser sets them only when the element carries them, so an MPD without them parses to the same shape it always did. The serializer omits the spec defaults rather than writing `availabilityTimeOffset="0"`.

## Faithfulness to shaka-packager

The HLS/DASH output ports are kept synced to shaka-packager and audited for 1:1 fidelity — logic mirrors shaka bit-for-bit, and shaka's unit tests are ported alongside each feature so behaviour is proven, not assumed. Last synced to **shaka-packager v3.8.0** (2026-07-03).

That sync pass corrected drift where our ports had fallen behind or over-simplified shaka: multi-period on-demand text `presentationTimeOffset` (shaka #1493/#1433), HLS master `DEFAULT`/`AUTOSELECT` computed per `(group, language)` with DVS + forced-subtitle handling, `SegmentTemplate` duration integer truncation, `#EXT-X-START:TIME-OFFSET` `%f` formatting, HLS language shortest-form reduction, DASH `ContentProtection` attribute precedence (later-set-wins, dedup via `RemoveDuplicateAttributes` upstream), full-proto `ProtectedContent` equality, and `GetStaticMpdDuration` float32 accumulation. It also added previously-unported subsystems: the HLS **live sliding window**, **CEA closed captions**, and **rendition index/group-id ordering**.

Intentional, documented deviations (everything else is a faithful mirror):

- **Path-aware `<BaseURL>`** — unencoded `/` in DASH `<BaseURL>` (see above); shaka URL-encodes them.
- **No-filesystem `RemoveOldSegment`** — the live window returns dropped segment names via `MediaPlaylist.getSegmentsToBeRemoved()` for the caller to delete, rather than performing `File::Delete`; the preserved-window buffer is trimmed unconditionally.
- **`HlsParams.discontinuitySequenceNumber`** — an initial-seed input the fork adds (shaka derives it purely internally); it seeds the member counter the sliding window then advances, kept additive so no upstream API changes.
- **`#EXT-X-TARGETDURATION` rounds to the nearest integer** — when no target is set, `MediaPlaylist` and the HLS output use the longest segment rounded to the nearest integer, which RFC 8216 §4.3.3.1 allows; shaka takes the ceiling, so a 4.004 s NTSC segment advertised 5.

## The fork adds to upstream; it does not delete from it

This fork exists to build features on upstream, so the direction of every change to a file upstream also
owns is **additive**. A deletion of upstream's code is an exception, and it is almost always one of two
things: a file the fork rewrote outright (`hls/hls-muxer.ts` became `segment-pipeline-muxer.ts`,
`hls/hls-demuxer.ts` was re-pointed at the extracted playlist parser), or an integration edit of a few
lines (an import list extended, a `return` wrapped).

What makes that worth stating is that the exception has already been abused by accident. Twice, a rebase
conflict was resolved in favour of the fork's older copy and **deleted an upstream bug fix** — `#567`
(decoder queue pressure, `media-sink.ts`) and `#555` (out-of-spec `VideoFrame` colour, `sample.ts`). Both
shipped. A third pair, `#553` and `#572` (server colour handling), shipped the same way and is described below;
it is why this check now covers `packages` as well. Watching only `src` and `test` left the entire server
extension outside the guard, so the half of that revert living in `packages/server/src` was never compared at
all, while the upstream tests that would have failed on it sat in the inventory as declared deletions. Nothing caught them: the suite stayed green, because the deleted code was upstream's and the
fork's own tests never covered it.

So `scripts/check-upstream-deletions.ts` runs in `npm run check`. `scripts/upstream-deletions.json` is an
**inventory of the upstream lines this fork does not have** — the lines themselves, across 50
files in `src`, `test` and `packages`, plus two files the fork replaced outright (`segment-pipeline-muxer.ts`, `hls/hls-demuxer.ts`) whose
whole contents are the declared divergence. Any upstream line that goes missing without being listed fails
the check, by name.

It deliberately is **not** a count. A number cannot say whether a deletion is legitimate, it nets out when
one file drops a fix while another grows an unrelated deletion, and when a count does trip it tells you
only that a file changed, not which line left. The inventory answers the question a reviewer actually has:
*should this line be gone?* For `media-sink.ts` the entire declared list is one extended import, so "nothing
of substance is missing from this file" is visible at a glance.

Two declared deletions are test bounds rather than code, both of them libvpx VP8: `server-extension.test.ts`'s
`VP8 conversion roundtrip` carries 60 s where upstream carries 20 s, and `quality.test.ts`'s
`Medium quality with codec 'vp8'` carries 60 s where upstream gives every codec in that loop 10 s. VP8 runs in
~2 s and ~0.6 s respectively on their own, and past their upstream bounds under the full suite, where the browser
project runs alongside the node one. Those two bounds are the only lines in those files that
diverge — an earlier attempt replaced every per-test bound in three test files with one file-level
`vi.setConfig`, which deleted 20 upstream lines to solve one test's problem.

On the tree that shipped the reverted fix it names it:

```
--- src/media-sink.ts
  - const MAX_QUEUE_SIZE = 4;
  - decoder.onDequeue = () => onQueueDequeue();
  - onDequeue: (() => unknown) | null = null;
  - this.onDequeue?.();
  ...
```

It compares **file contents**, not diff markers. A `-` in a diff means "not at this position", not "absent
from the file", so reading those lines reports a heavily rewritten file as missing lines it plainly still
contains — `test/node/hls-output.test.ts` was flagged for three lines
the fork has *more* copies of than upstream (5 vs 2, 10 vs 7). False positives are not a cosmetic
problem here: a check that cries wolf gets `--update`d reflexively, which is exactly how a real deletion
would get through. It now counts occurrences of each trimmed line in upstream's copy and in the fork's,
and reports the shortfall.

Lines are compared trimmed, so re-indenting a block upstream does not read as a deletion, and occurrences
are counted, so dropping a second copy of an already-declared line still shows up. Re-record with
`npx tsx scripts/check-upstream-deletions.ts --update` only once the new lines have been looked at.

It covers `test` as well as `src`, because an upstream test is upstream's contract and a fork edit that
re-points one reads as green. That is not hypothetical either: three of upstream's MPEG-TS muxing tests
fail in this fork after a rebase drops them, and because they are browser tests they stay out of
the node-only runs. Every report of "the suite" is now `npm test` — node and browser both.

### MPEG-TS: when the programme is shifted

PES timestamps are unsigned 33-bit and H.222.0 requires `DTS <= PTS`. A packet that presents at 0 but
decodes earlier — any B-frame source — has no legal encoding: the negative decode time wraps to a value
near 2^33 and reads as decoding a day after it presents. `video-h265.mp4` does exactly this, and muxed
upstream's way 2 of its 149 PES packets carry `pts=0, dts=8589928592`.

So the muxer shifts the programme forward by the smallest amount that restores the relation, which is
what ffmpeg's `avoid_negative_ts` does. It shifts **only** for that case: a programme negative in both
fields wraps both by the same amount, `DTS <= PTS` still holds, and a reader that unwraps gets the
timeline the caller asked for — shifting that one would move a timeline nobody asked to move. The fork
shifted those too until it was measured, which is what broke upstream's two round-trip tests.

Shifting is visible in a duration: both tracks then begin at the shift rather than 0, and MPEG-TS has no
edit list to hide the gap, so upstream's `HEVC and MP3` durations read 0.0667 s longer here. That is the
one upstream test expectation this fork restates, and it is declared in the inventory above.

## Adding a package upstream introduces

Publishing here is OIDC-only — the workflow holds no npm token, and `publish-fork.ts` rewrites each
package's `repository.url` because trusted publishing matches it against the repo the workflow runs
in. npm has no pending publisher: a trusted publisher can only be configured for a package that
already exists, so the first publish of a name npm has never seen must be token-authenticated.

Wire the package into `vitest.config.ts`, `node_modules/@mediabunny/<name>`, `docs:generate` and
`PACKAGES`, then list it in `NEEDS_FIRST_PUBLISH_BY_HAND` so a normal run skips it rather than failing
every release. Publish it once from a shell logged into npm:

```sh
npm run build
npx tsx scripts/publish-fork.ts --version <version> --only packages/<name> --dry-run
npx tsx scripts/publish-fork.ts --version <version> --only packages/<name>
```

Then add its trusted publisher on npmjs.com (repository `ahmedrowaihi/mediabunny`, workflow
`publish-fork.yml`) and empty `NEEDS_FIRST_PUBLISH_BY_HAND` again.

Note that npm points a brand-new package's `latest` at whatever is published first, so a package that
starts life on a prerelease has `latest` on that prerelease while the others sit on an older release.

**A test that cannot run everywhere skips, naming what it needs.** The first run on a Linux runner put the
fork's code at 2196 passed, 73 skipped, 1 failed — and that one failure was the 5-second default timeout on a
2-core machine where libx265 needs longer, not a defect. Everything else that went red was a test tied to
this laptop. Running the suite on a runner for the
first time found four kinds of test that only passed on this machine: 94 that read shaka-packager's test
media from a sibling checkout (`test/node/_shaka-corpus.ts` resolves it and `hasShakaCorpus` gates them),
three that need the `ffmpeg` binary rather than node-av (CI installs it, and they skip where it is absent
instead of spending their timeout waiting for a publisher that never starts), three that need an HEVC
encoder the platform may not have (asked through `canEncodeVideo` while the tests are collected), one of the
fork's own caption rows that names VideoToolbox, which is macOS only, and the 34 HLS input tests that serve
third-party media `npm run capture-hls-fixtures` fetches and no one commits — which also crashed `afterAll`
on an undefined server, so a missing fixture directory failed the file twice over. Each of those was a test
asserting nothing about the code and everything about this laptop.

**`package-lock.json` must be written with default peer resolution.** This machine's npm has
`legacy-peer-deps = true` in its user config, which makes npm ignore peer dependencies while resolving — so a
lock regenerated here omits the `node_modules/mediabunny` self-link that the workspaces' `mediabunny` peer
needs, and the optional peers of the docs tree. The lock then reads as in-sync to the npm that wrote it and is
rejected by `npm ci` anywhere else, which is how it reached CI: `Missing: mediabunny@1.65.0 from lock file`.
Regenerate it with `npm install --package-lock-only --legacy-peer-deps=false`, in a tree with no
`node_modules` — with one present, npm resolves against it and reports nothing wrong. The resulting lock
satisfies `npm ci` under both configurations.

**The branch has its own CI.** Upstream's lint, test and build-check workflows trigger on `main` and pull requests, so nothing checked the branch this fork publishes from. `fork-ci.yml` runs the release gates on it — `npm run check`, `npm run lint`, `npm run build`, `npm run docs:generate --dry` and `xvfb-run npm test` with `npm ci`, so node-av's native binary is present for the server tests. The publish job runs the four that need no binary before it spends a version number, since a version is gone the moment npm accepts it.

## A publish that npm takes and drops

Everything publishes to `pending` first; `beta` and `latest` move only once **every** package answers on the registry. That gate is what protects consumers, and it is tested: `--promote-only` against a version that does not exist polls, refuses, and leaves the tags where they were.

**A set npm has not finished serving is "not yet", and a poller finishes the job.** That used to fail the run, on the reasoning that an incomplete set is never a false positive and no amount of prose outweighs a green check. It was the wrong trade in the end: lateness is the normal case, not the exception — `dts` took 720, 1110, 1200 and 1590 seconds on four consecutive releases — so every push run was red and every release was promoted by hand. Red that always means "wait" stops being read at all.

So the push run waits 8 minutes, promotes if it can, and otherwise exits green with a `notice` naming what is missing (`--if-complete`). A `schedule` trigger on the same workflow runs every 15 minutes, compares `pending` against `beta`, and moves the tags once every package answers; its job is gated on the event, because a cron tick must never publish. **It has to be a trigger of `publish-fork.yml` rather than its own workflow:** npm's trusted publisher is configured per workflow *file*, so a separate file has no credential and `npm dist-tag add` fails with a bare exit 1 — and nothing in this repo can grant it, since that is a setting on npmjs.com. Tried it as `promote-pending.yml` first and that is exactly how it failed. Holding the runner for the observed lag was the other option and is worse: it idles a job for half an hour and still loses to the 1590-second case. A red publish run now means a publish was rejected, which is worth looking at.

A set that is still incomplete hours later is **not** the same as a drop, and the difference costs a version number if you get it wrong. Re-check after ~30 minutes, then apply the one test that separates them: if the version document is still absent while a *later* version of that same package exists, the publish was dropped and only a new version gets out of it, because npm refuses a retry of the same version with a 409. Otherwise it is merely late, and waiting is the whole fix.

Both states look identical for the first few minutes and both log the same `+ @ahmedrowaihi/...@version` acceptance line, so acceptance says nothing either way — only the version document appearing does.

## Dist-tags

Every release moves **both** `beta` and `latest` onto the same version, once npm serves all nine
packages. `latest` is what a bare `npm i` resolves to; left alone it stays on whatever each package
first published, which is a different stale version per package — the core and an extension can then
disagree. `pending` is the holding tag each package is published to before the set is verified.

A caret range does not match a prerelease, so `^1.64.0` will not resolve `1.64.0-beta.205`. Consumers
pin the exact version or install by tag.

## Versioning

`package.json` carries the upstream base version (currently `1.57.0`). The fork is rebased onto upstream `main`, at `01f0fa01` — that is upstream's `v1.57.0` tag plus one further fix, since `main` runs one content commit ahead of the `release` branch the tag sits on. The publish workflow strips any trailing `-beta.N`, then appends `-beta.<github.run_number>` to produce a monotonically increasing beta tag. Consumers should pin exact versions (`"@ahmedrowaihi/mediabunny": "1.57.0-beta.<N>"`) rather than tracking the floating `beta` dist-tag.

Every package in the repo ships per release under the `@ahmedrowaihi` scope, stamped with the same `-beta.N`: the core as `@ahmedrowaihi/mediabunny`, and each extension as `@ahmedrowaihi/mediabunny-<name>` — `server`, `prores`, `mp3-encoder`, `aac-encoder`, `flac-encoder`, `ac3`, `dts`. The extensions peer-depend on a package named `mediabunny`, so a consumer aliases the core to that name (`"mediabunny": "npm:@ahmedrowaihi/mediabunny@<exact version>"`). Install them from the same release — the extensions and the core's expectations move together.

**The version's base comes from upstream, not from us.** The workflow reads `upstream/main`'s `package.json`
for the base and appends `-beta.<run_number>`, so a release built on upstream 1.61.6 publishes as
`1.61.6-beta.N`. Reading our own copy instead only changes when someone remembers to bump it and
silently fell two patches behind — we published `1.61.4-beta.N` for a while against upstream 1.61.6 code, which
reads as "based on 1.61.4" to anyone comparing, and sorts below upstream's actual base. Taking it from the
rebase target makes it right by construction. The manifests in the tree now carry upstream's version verbatim
for the same reason: one less line that differs, and nothing depends on it.

**How a release is cut.** Two routes, one script.

- **CI (normal).** Push to `publish-ahmedrowaihi`. The workflow stamps `${BASE}-beta.${github.run_number}`, builds, then runs `npx tsx scripts/publish-fork.ts --version <version> --tag beta`, which publishes every package. The version is knowable before npm is: it is the run number, and the workflow also writes it to the job summary and cuts a GitHub release tagged `v<version>`. Read it from there, never from `npm view` — a dist-tag read mid-publish returns the *previous* release.
- **Finishing a stranded release.** A run can go green without moving `beta`: the tag only advances once npm *serves* every package, and a package can take hours. Do **not** re-run the run to fix this — the base version is read from `upstream/main` at run time, so a re-run after upstream has released publishes a *different* version instead of promoting the stranded one. That happened to `1.62.0-beta.154`: a re-run four days later built `1.62.1-beta.154` and left `beta` where it was. Instead dispatch the workflow with `promote_version` set to the stranded version; it skips publishing and only moves the tag.

- **Locally (first publish of a new package, or when CI cannot).** `npm run build` first — the script refuses to publish a package whose `dist` is missing, but it cannot tell stale output from fresh. Then `npx tsx scripts/publish-fork.ts --version <version>`, optionally `--only <dir>` for one package and `--dry-run` to check without shipping. It runs from any directory. A local publish prompts for 2FA per package; CI's token does not.

The script rewrites each manifest, publishes, and restores it, so the repo keeps upstream's package names and the tree is unchanged whether the run succeeds or fails. It publishes in dependency order (core, then extensions, server last, because the server depends on ProRes), skips any package already on the registry at that version so a re-run is safe, and refuses to publish a package whose `dist` is missing. The CI workflow calls the same script, so there is one definition of what a release is.

**Publishing is OIDC, and it is configured per package.** There is no npm token anywhere in the workflow — it mints a GitHub OIDC token (`id-token: write`, `npm@^11.5.1`) which npm trades for a short-lived publish credential. npm's trusted publishing is configured **per package** on npmjs.com, naming the organization, repository and workflow filename, so every new package needs its own entry before CI can publish it; a package without one fails with `404 Not Found - PUT`, which reads like "missing" but means "not permitted". That is exactly what happened when the six extensions were first published: they were created from a local 2FA login, and CI could not publish them afterwards.

Two requirements that are easy to miss. `repository.url` must match the publishing repository exactly — the extensions carry upstream's URL in the tree, so `scripts/publish-fork.ts` rewrites it along with the name at publish time. And `npm dist-tag` is a separately allowed action in the trusted-publisher settings: the script runs it when it skips an already-published package to repair a stale tag, so leave it enabled.

**Re-running a release is normal, so every step is idempotent.** npm can take hours to serve a package — ac3 has
has run to hours rather than minutes — and the promotion step is re-run once it does. Publishing
skips packages already on the registry and treats npm's `409 Cannot publish over previously staged version` as
"already has these bytes"; the GitHub release step updates an existing release rather than failing with `422
Release.tag_name already exists`; pruning tolerates a tag that is already gone. A re-run that finds everything
done should end green, because a red run that was actually fine teaches people to ignore red runs.

**One published version will never be served: `@ahmedrowaihi/mediabunny-dts@1.61.4-beta.128`.** npm accepted it,
held it in its "Validating" state, and never completed. It is absent from the packument, 404s to consumers, and
cannot be republished — npm answers that with a 409. Nothing points at it and no tag ever did. Every other gap
in the version sequence is a package that did not exist yet: the six extensions were first published at
`1.61.4-beta.126`, so they have no `.114` through `.124`.

**Metadata lands before the artifact.** After any publish — CI or local — the version document, `npm view` and the dist-tag go live before the `.tgz` does, and the gap has run to ten minutes. A 404 on the tarball while `npm view` resolves the version is the normal window, not a failed publish; the publish line in the run log (`+ pkg@version`) is what settles that. Consumers should gate an upgrade on the `.tgz` returning 200, not on `npm view` — a consumer who installs on the announcement can get a partially-resolved tree.

**Why every extension is republished rather than taken from upstream.** A caret range cannot be satisfied by a prerelease: semver excludes prereleases from a range unless the range itself carries one on the same `major.minor.patch`. Upstream's extensions peer-depend on `mediabunny: ^1.0.0` (ProRes on `^1.49.0`), so none of them could ever be satisfied by a `1.61.4-beta.N` core, and any install mixing a fork core with an upstream extension reported an invalid peer — `npm ls` exited 1 with `ELSPROBLEMS`, reddening a common CI step over a dependency the consumer could not fix. Publishing the fork's own build of each extension, with the peer range stamped to the exact version being released, removes the upstream manifests from the tree entirely. The server's dependency on ProRes keeps the upstream specifier and is rewritten to an npm alias at publish (`"@mediabunny/prores": "npm:@ahmedrowaihi/mediabunny-prores@<exact version>"`), so source imports never change.

**The exact peer range also closes a silent substitution.** Upstream has no `1.61.4-beta.N`, so a consumer who forgets the alias now fails at install instead of at the first undefined function with upstream silently resolved in place of the fork.

Resolve the core through one specifier only. The package exposes both a modules entry and a bundle entry, so an app resolving one while an extension resolves the other loads the library twice; each copy keeps its own codec registry, and codecs registered by the extension are then invisible to the app, which surfaces as `undecodable_source_codec` rather than as anything naming the real cause. The library logs `Mediabunny was loaded twice` when this happens.

The fork repo retains only the most recent **3 beta releases** (older ones are auto-pruned by the publish workflow). If you need an older beta that's been pruned, the npm tarball still resolves — only the GitHub Release page is cleaned.

Each publish creates a GitHub Release at `v<version>` containing the commit delta against upstream `release` at that point in time. See the [Releases page](https://github.com/ahmedrowaihi/mediabunny/releases) for per-publish breakdowns.

## License + attribution

The fork is MPL-2.0, matching upstream. The HLS and DASH output ports include `NOTICE` and `LICENSE.shaka-packager` attributions covering the Apache-2.0 code lifted from [shaka-project/shaka-packager](https://github.com/shaka-project/shaka-packager). All non-fork-specific work is upstream-contributable; the fork exists to ship features ahead of upstream PR cycles, not to diverge.
