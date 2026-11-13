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

`VideoTrackMetadata.parameterSets` carries the same choice across a remux, where there is nothing to encode. Packets given in Annex B format keep their parameter sets, so the muxer infers `'inBand'` for them; packets that repeat their parameter sets *and* come with a decoder config are byte-for-byte indistinguishable from packets that do not, so there the field is the only signal. Without it, such a track can only be written as `avc1`/`hvc1`, which understates what the samples carry. Declaring `'outOfBand'` for Annex B packets **moves them**: the sample entry already holds them, since the description was extracted from the first packet to begin with, and the Annex B transformation drops the parameter sets and the access unit delimiter from each sample as it converts to length-prefixed. So an MPEG-TS segment ingested from HLS remuxes to `avc1`/`hvc1` rather than `avc3`, which Safari's native HLS may need. Nothing else is dropped — a caption SEI survives, and the suite counts NAL units by type rather than comparing pixels, because a picture looks the same without its captions.

A **copy** can do this, which is the point: `Conversion`'s `video.parameterSets` no longer forces a re-encode when the source is Annex B, since the muxer has to rewrite those samples anyway. For a length-prefixed source it still does, because moving the sets there means a sample rewrite nothing performs. An access unit holding nothing but parameter sets is refused rather than written as a zero-byte sample.

Left unstated, Annex B still keeps its sets in band. That is the only answer that preserves a mid-stream parameter-set change, which `avc1` cannot express at all — declaring `'outOfBand'` is the caller saying the sample entry's copy is the whole story.

Held to `ffprobe`'s `codec_tag_string` and `ffmpeg`'s per-frame md5 over five MPEG-TS fixtures, three AVC and two HEVC, against both the source and the in-band remux of the same file. One of them, `no-aud.ts`, carries the sample-entry claim only: ffmpeg's decode of its final frame is not stable across runs on byte-identical output — measured, the written file hashes the same three times and the demux is stable, and the mismatch appears between two in-band remuxes too, so it is the decode of a trailing partial access unit.

### The selected encoder is named

The server encoder emits one `Logging` info line per track when it picks its codec — `Encoding 'avc' with h264_videotoolbox.` — because which encoder ran decides byte-reproducibility (hardware encoders are not deterministic, and a `Quality` routes to software while a numeric `bitrate` leaves hardware eligible), and nothing else reports it. Listen with `Logging.on('info', ...)`; the payload is `unknown[]` — the console-style args, not a pre-joined string — so join at the boundary (`args.map(String).join(' ')`) rather than typing it as a string.

### Key frames from the server encoders

With `@mediabunny/server`, a video track's key frames are exactly the ones `keyFrameInterval` forces. libx264, libx265, libvpx (VP8/VP9) and SVT-AV1 no longer add key frames of their own, whether from scene-cut detection or from a fixed 60-frame GOP that put one 1.2 s after every forced key frame at 50 fps. A forced libx265 key frame is a closed-GOP IDR rather than a CRA followed by RASL pictures, so a segment starting at any key frame decodes on its own. The frame rate handed to the encoder is an exact rational (24000/1001 rather than a rounded 24), so x265 signals it exactly.

### A ProRes profile's chroma format is not a preference

`ap4h` and `ap4x` — ProRes 4444 and 4444 XQ — are 4:4:4 by definition, so they are encoded that way whether or not alpha is kept. Discarding alpha used to drop them to **4:2:2 under a 4:4:4 four-character code**: the pixel format was taken from the encoder's first advertised format, and `prores_ks` advertises 4:2:2 ahead of 4:4:4. With alpha the same path happened to land on 4:4:4, because prores advertises no 4:2:2 alpha format — right answer, wrong reason.

`choosePixelFormat` now takes the chroma format the profile fixes, and ProRes is the one codec here that fixes one. The 4:2:2 profiles (`apco`, `apcs`, `apcn`, `apch`) are unchanged and are the suite's control, so the fix is not "always 4:4:4". Measured through `ffprobe`: `ap4h`/`ap4x` give `yuv444p12le`, or `yuva444p12le` with alpha; the other four give `yuv422p10le`.

It is deliberately only the fallback path that consults the chroma format. A codec that states a bit depth is served by the ordered format tables, and ProRes states none — its four-character code fixes the depth as well, which is why `VIDEO_BIT_DEPTHS` lists nothing for it. Filtering the tables as well looked symmetrical and was unreachable: a mutation that deleted it kept every test green, which is how it was caught.

**`Conversion` cannot select a ProRes profile at all**, and this did not change that. `fullCodecString` is a `VideoEncodingConfig` field, not a `ConversionVideoOptions` one, so a conversion to ProRes always encodes `apch`. Reaching another profile means driving `VideoSampleSource` directly.

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

**Clear lead.** `EncryptCmafOptions.clear` writes a segment with every sample left unencrypted under an
otherwise unchanged encrypted init, which is how a presentation plays its first seconds before a licence
arrives. Each `traf` then carries a `seig` sample group stating `is_protected = 0`, `Per_Sample_IV_Size = 0`
and a zero KID for all of its samples, and no `senc`/`saiz`/`saio` — serving the plain fragment instead
states nothing, so a CDM tries to decrypt it. The `mdat` is byte-identical to the input's, the IV sequence
does not advance, and `cmafEncryptedLayout` takes the same option so a low-latency playlist can publish the
clear segment's byte ranges. It applies to a whole segment: a clear lead is counted in segments, so there is
no per-track or per-period form, and a progressive file is refused by name since it has no `traf` to state
the group in.

The reader side had to follow: the ISO BMFF demuxer read no sample groups at all, so a clear fragment under
an encrypted init was decrypted anyway wherever the scheme has a constant IV — `cbcs` threw
`Encrypted media samples encountered`, while `cenc` happened to read as clear only because no `senc` meant
no IV. It now parses `sgpd`/`sbgp` of grouping type `seig` in a `traf` and leaves a sample the group says is
unprotected alone. Applied once the `traf` is read rather than at the `sbgp`, since a `trun` may follow the
group boxes; an index of zero or one naming the sample table's own `sgpd` keeps the `tenc` default. The
upstream line the deletion guard records here, `if (this.internalTrack.encryptionInfo) {`, is narrowed by
that flag rather than removed: every sample upstream decrypts is still decrypted unless its own `seig` says
it is not protected.

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

The 50 fps test needed more than an allowance. Its AV1 case read **0.6403-0.6404 across six runs** on one machine,
stable to four decimals, while CI saw 0.9 to 1.233 on the same commits — so the spread is not run-to-run noise but
the parallelism SVT-AV1 is given, and any fixed ceiling is either false on one machine or vacuous on the other. That
case now asks the question that does not move: capping has to cut the worst window by more than 5x, and may not land
more than 2x outside the allowance. Uncapped is 12.7x the allowance and about 20x the capped figure, so there is room,
and with the SVT cap made a no-op the ratio reads exactly 1. `avc` and `hevc` are a true VBV and keep the exact 1.

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

**A fragmented file states the same thing.** Its `moov` goes out at the first fragment's flush, by which
point that fragment's decode times are known, so the reorder delay of a track whose decode timeline starts
below zero is stated in the `elst` exactly as a progressive file states it, and an otherwise empty `stbl`
carries a `cslg` whose composition-to-DTS shift is zero — there is nothing left for a reader to derive.
Composition offsets therefore never go negative in either layout.

This is what keeps the A/V offset of such a track. Nothing but the init can state that delay, so a
fragmented file that leaves it unstated is read by anything that bounds the shift by the codec's reorder
depth — `ffmpeg` included, and its own fragmented output has the same gap — with the video track that far
from the audio beside it. Measured on `demo.mp4` published over RTMP: audio leads video by 21 ms at the
source and by 101 ms on the far end without this, and by 21 ms with it. `test/node/rtmp-target.test.ts`
asserts the two tracks' shifts across the round trip are one constant, and `test/node/mpeg-ts-matrix.test.ts`
reads the `cslg` and the edit list out of both layouts' boxes.

What makes that work is that `tfdt` states the fragment's lowest **decode** time rather than its lowest
presentation time, which `trun`'s composition offsets are measured against. The two are the same number for a
track whose decode order is its presentation order, which is why stating the wrong one went unnoticed for as
long as every decode time was reconstructed by sorting; for a track that states its own decode timeline they
differ by the reorder delay, and stating the presentation time put every fragment that delay late. It is read
off the fragment's samples when the box is built, not accumulated as they are added, because a sample joins
its chunk before the batch it belongs to has been settled.

MPEG-TS writes a PCR on the video PID, or the audio PID when there is no video, within the 0.1 s of
2.7.2. Decode times a caller did not state are derived as one ladder — the i'th packet to decode
presents no earlier than the i'th smallest presentation time — lowered by the batch's reorder delay.
Clamping each packet to its own presentation time instead keeps `DTS <= PTS` while handing two packets
the same decode time, and no two access units decode at the same instant. A reordered programme whose
first frame presents at zero therefore derives a negative head decode time, which is the sign split
below, so such a stream is carried forward one frame. PES timestamps are unsigned 33-bit, so a
programme that would decode before zero is offset
forward by one amount for every track, chosen from the first packet in output order (as ffmpeg's
`avoid_negative_ts` does). It fires only on the **sign split** — a head packet whose decode time is
negative while its own presentation time is not — because a wholly negative programme wraps together,
`DTS <= PTS` still holds, and shifting it would move a timeline the caller asked for. With B-frames and
a first packet at zero, that split is exactly what a reordered first frame produces. The decision is
per muxer rather than per format, so one `Output`'s offset never leaks into another that shares the
format instance; what it does mean is that two `Output`s whose first packets differ in reorder depth can
choose different offsets, so a ladder that needs one timeline across rungs states
`MpegTsOutputFormatOptions.timestampOffset` on every rung. Stating it overrides the decision entirely,
and a negative decode time is then the caller's to own; the segment pipeline sets it to zero and keeps
its negatives.

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
## A chunk's key-frame byte range

`IsobmffChunkInfo.keyFrame` is `{ offset, size }` or `null`: the range holding a chunk's `moof` and its
first sample, which is what an `EXT-X-I-FRAME-STREAM-INF` playlist publishes as a byte range — enough to
decode that one frame and nothing more. The offset is the `moof`'s rather than the chunk's, since a
`styp`, `sidx` or `emsg` ahead of it belongs to the segment and not to the frame. `chunksOf`, `segmentsOf`
and `cmafEncryptedLayout` all carry it, so a protected segment's range is measured on the encrypted bytes
as served; `readSegmentHead` carries it too, and a head that stops at the end of the `moof` states a range
reaching well past what was read, because the `moof` alone states it.

Null means unstated, not zero-length: the first sample is not a sync sample, the chunk states no sample
flags, no sample size is stated anywhere (`trun`, then `tfhd`, then `trex`), or the base is unknown.
**`base_data_offset` makes it unknown.** ISO/IEC 14496-12 8.8.7 defines `default-base-is-moof` only "if
base-data-offset-present is zero", so an explicit `base_data_offset` wins over it — and that is a *file*
offset, which the bytes handed in need not begin at. Guessing it would silently misplace the range for a
standalone segment, so it is not guessed. No fragmented fixture in the suite sets the flag, so that branch
is reached by a segment built in the test with one spliced in.

The ranges are checked against `ffprobe -show_packets`, not against another reading of the same boxes:
every stated range ends exactly at `pos + size` of the first packet in its chunk, over a file where every
chunk is a key frame and one where most are not. The encrypted case is held to the `moof`'s own measured
growth rather than to a formula.

## A red commit publishes nothing

`publish-fork.yml` waits for `fork-ci.yml` to conclude on the **same commit** and fails if it is not green, before anything is published and before any tag moves.

Three red versions reached `latest` before this (680, 684, 685), and two separate things let them. The publish job ran only the type, lint and build gates — never the test suite, because its install is `--ignore-scripts` and node-av has no native binary there, so the tests genuinely cannot run in that job. And the catch-up promotion was the job's **first** step, so it moved `beta` and `latest` before any gate had run at all. The gate is now first and the catch-up follows it, which also means `pending` can never name a version whose tests failed for a later run to promote.

A `workflow_run` trigger would be tidier, but GitHub fires those only for workflow files on the **default branch**, and this one lives on the release branch. Splitting the registry write into its own workflow is not an option either: npm's trusted publisher is configured per workflow *file* ([[trusted-publisher-is-per-workflow-file]] in spirit — see the section below), so anything that publishes has to stay in this one.

The cost is that the publish job idles while the test suite runs, up to an hour before it gives up. A `workflow_dispatch` with `promote_version` skips the gate deliberately: promoting an already-published version is an explicit human decision about a version that already exists.

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

- **AVC field pictures no longer stop encryption.** `H264VideoSliceHeaderParser` threw `UnsupportedMediaError` on `field_pic_flag`, so every slice of a field-coded (PAFF) stream measured a clear header size of `-1` and could not be encrypted — the same shape as the HEVC scaling-list case below. The fix is the one bit the spec puts there: `bottom_field_flag` after `field_pic_flag` (H.264 7.3.3), confirmed against ffmpeg's `cbs_h264_syntax_template.c`, which transcribes the syntax directly. Every field downstream already carried the `!field_pic_flag` condition.

  Worth knowing for whoever tests this next: with that fixture's parameter set the header is always an odd number of bits, so the extra flag **never changes the byte count** — a size-only check cannot see it. What does see it is the quantizer, which shifts by a bit if the flag is skipped. x264 emits only MBAFF, so the fixture is written by `scripts/build-avc-field-pictures.py`, taking the SPS and PPS from `avc-fake-interlaced.mp4` (already `frame_mbs_only_flag = 0`) and hand-building the slice headers; ffmpeg reads back `bottom_field_flag` at bit 22 and the four `slice_qp_delta`s as 0, 2, -4 and 7, which is where the expectations come from. It warns that it cannot read the slice *data*, which is true and deliberate — the fixture carries headers only.

- **HEVC scaling lists no longer stop encryption.** `H265VideoSliceHeaderParser` threw `UnsupportedMediaError` the moment it met `scaling_list_data()`, in either the SPS or the PPS. Both throws sat inside `parseSps`/`parsePps`, so they came back as `initialize()` returning `false`, and every slice of such a stream then measured a clear header size of `-1` — the stream could not be encrypted at all. The PPS case was the worse of the two: `pps_scaling_list_data_present_flag` sits ahead of `lists_modification_present_flag` and `slice_segment_header_extension_present_flag`, which the slice header parse reads against. A `skipScalingListData` helper now walks the structure (H.265 7.3.4) and discards the values, as the H.264 parser's `skipScalingList` already did for its own matrices. Reachable from a real encoder: `x265 --scaling-list <file>` writes a custom matrix into the SPS, which is the `test/public/hevc-scaling-list.mp4` fixture.

- **Slice-header sizes are checked against ffmpeg, not against a round trip.** The clear slice-header size is where cbcs/cenc encryption begins, and encryption is symmetric — a stream encrypted from the wrong offset decrypts back to itself byte for byte, so no encrypt/decrypt test can see the mistake. `test/node/slice-header-sizes.test.ts` compares the measured size for every video-slice NAL of five fixtures against `ffmpeg -bsf:v trace_headers`, committed as `test/node/_slice-header-sizes.json` (569 values) so CI reproduces the comparison without ffmpeg. The derivation differs per codec, and the difference is a real one: H.264 pads with `cabac_alignment_one_bit`, which is *zero* or more bits, so slice data starts in the byte the fields end in; H.265's `byte_alignment()` always writes an `alignment_bit_equal_to_one` first, so a header whose fields end byte-aligned spends one further byte on the alignment. 29 of 300 slices in one fixture sit exactly on that boundary.

`parseBoxes` decodes box headers through `eachBox` rather than its own loop. Its own loop read a 64-bit `largesize` from the **low** half of the field, so a box past 4 GiB truncated to a plausible small one, and it checked neither that a size covered its own header nor that it stayed inside its parent — a size of 4 walked misaligned and produced boxes with three-space types, and a size of 999999 in a 16-byte buffer was followed. `eachBox` already handled all three and its own doc says new box code should go through it. `test/node/isobmff-safety.test.ts` covers the three cases; the >4 GiB one needs a value above 2^32 to show at all, since anything smaller survives the truncation intact.

## Fragmented reads resolve the base against the `mdat`

The demuxer applied §8.8.7's implicit rule literally: a `traf` stating neither `base_data_offset` nor `default-base-is-moof` was based on the end of the previous `traf`'s data. On a file that omits the flag but still measures from the `moof`, that reads the audio out of the *next* fragment's `mdat` — and once past the last one, the reads simply stop. On `bear-640x360-av_frag.mp4` it returned **88 audio packets instead of 119**, every one of them the wrong bytes, with no error anywhere: the offsets are in range, the samples decode, and only a comparison against what the `traf`s name sees it.

`realignImplicitBases` resolves it where the answer exists. It runs in `readFragment`, after the `moof` is parsed and the `mdat` header is readable, and shifts a `traf`'s samples to the `moof` base when the implicit one names bytes outside the `mdat` and the `moof` names bytes inside. A fragment is realigned once, including on the cached path, and when neither base fits nothing is touched — there is then nothing to prefer. The same resolver decides the encryptor's cipher positions and the Smooth Streaming shift, so a file reads, encrypts and gets spliced against one answer.

Every fragmented file in `test/public` is held to it: each track's packets are partitioned by the sample counts its `traf`s name, and each one has to be found inside the `mdat` of the fragment that named it — searched in that `mdat` alone, so a hit elsewhere cannot stand in for it. An encrypted fixture is exempt, since the demuxer hands back plaintext its `mdat` does not hold, and the exemption is checked rather than asserted: the file has to actually carry CENC boxes. Only `bear-640x360-av_frag.mp4` has the ambiguous shape today, so the other eight are there to keep the next fixture from arriving unchecked.

## Smooth Streaming fragment surgery

MS-SSTR's `tfxd` and `tfrf` are `uuid` boxes that live **inside the `traf`**, so `insertBoxesBeforeMoof` is the wrong tool for them — it writes top-level boxes, where no Smooth client looks. `insertBoxesIntoTraf(segment, trackId, boxes)` puts them in the right place and restates every offset the growth moves; `buildTfxdBox({ time, duration })` and `buildTfrfBox([...])` write the boxes, version 1, so every time field is 64-bit.

They go in **after the last `trun`**, not at the end of the `traf`: the encryption path's `writeAuxInfoOffsets` derives each `saio` from the end of its `traf` minus the size of the `senc`, which only holds while `senc` is the last child.

What decides whether an offset moves is **whether a `traf`'s offsets are measured from the `moof` at all** (ISO/IEC 14496-12 §8.8.7), which `baseDataOffsetsOf` answers for the whole fragment at once. A stated `base_data_offset` is a file offset that absorbs the same shift, so offsets against it must not move; `default-base-is-moof` names the `moof`, so they must; with neither flag the base is the `moof` for the fragment's **first** `traf` only, later ones measuring from the previous `traf`'s data end. Getting this wrong leaves every box size consistent and every offset self-consistent while handing back the wrong samples, so sample identity is the only check that sees it.

**The `mdat` settles the third case.** Writers commonly omit `default-base-is-moof` and still measure every `traf` from the `moof`; `bear-640x360-av_frag.mp4` is one, and read implicitly its audio lands 26020 bytes past the end of its own fragment. Measured from the `moof` the two `traf`s fill that `mdat` exactly — 25648 video plus 5037 audio is the 30685-byte payload — so the fragment's own geometry says which reading was meant, and `baseDataOffsetsOf` takes the `moof` when the implicit base names bytes outside the `mdat` and the `moof` names bytes inside it. Nothing else can tell the two apart from the flags alone.

Also restated: `traf` and `moof` sizes, a `tfhd` `base_data_offset` from the grown `moof` onward, and the `referenced_size` a preceding `sidx` states for this fragment — the mirror of `insertBoxesBeforeMoof`, which lengthens `first_offset` and leaves the fragments alone.

Only the target `moof` is parsed into a box tree; the rest of the segment is copied through as bytes. `parseBoxes` copies every leaf's payload, and `mdat` is a leaf, so parsing a whole segment to splice fifty bytes into a `traf` copied the media twice — once into the tree and once back out. Walking the top level with `iterateIsobmffBoxes` finds the `moof`'s byte range without touching a payload, and the output is assembled with three `set` calls. Measured on a 202 kB segment: **0.117 ms to 0.047 ms per call, and 311 kB of allocation per call down to 188 kB** — which is now just the output buffer, since a new one has to be returned. For a packager calling this per fragment per rendition, that is the difference worth having.

One spec ambiguity is exposed rather than guessed at: MS-SSTR §2.2.4.5's ABNF says `FragmentCount = UINT8` while its prose field table says 4 bytes. The default follows the ABNF, since the prose on those pages carries other outright errors; `fragmentCountBytes: 4` switches it for a client that disagrees.

Covered by `test/node/smooth-streaming.test.ts`. The `tfxd` bytes are checked against ffmpeg's own `-movflags isml` output rather than against this library.

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
| `udp` | n/a | | `timeout` | microseconds |
| `rtp` | n/a | | *own socket* | — |
| `http(s)` | n/a | | `rw_timeout` | microseconds |

Every one of those defaults to **infinite**. `NetworkSource` therefore takes `connectTimeout` and `readTimeout` in plain seconds, defaults both to 30, and owns the mapping: it **overwrites** the mapped option names on the URL rather than defaulting them, because a caller-supplied value for one of them would reinstate the hang the class exists to prevent. Every other query parameter — `mode=listener`, `pkt_size`, `passphrase` — stays the caller's.

The table doubles as the supported-protocol allowlist, so `rtsp://` is refused by `NetworkSource` even though the bundled FFmpeg has it.

### `rtp://` reads MPEG-TS over RTP, over its own socket

`new NetworkSource('rtp://0.0.0.0:45127')` reads MPEG-TS over RTP (RFC 2250, payload type 33) — what SMPTE 2022 feeds and MediaLive's RTP input carry — and yields only the transport stream. The RTP header, its CSRC list, its extension and its padding come off, RTCP is dropped, packets are put back in sequence order within a 16-packet window, and a gap stays a gap: nothing is fabricated to fill it, since a TS reader resynchronises on the next sync byte and a made-up packet would not let it. There is no FEC; SMPTE 2022-1 belongs to the sender and the host.

**It binds its own UDP socket instead of going through FFmpeg, and the reason is measured.** Depacketizing RTP needs the datagram boundaries, and AVIO does not keep them: `read(n)` loops the protocol's own read until it has filled `n`, so a 2048-byte read returns one and a half packets — visible as the sequence numbers advancing by **two** — and `AVIO_FLAG_DIRECT` does not change it. RTP carries no length field, so the boundary cannot be recovered afterwards. `node:dgram` hands over whole datagrams, which is how `RistSource` has always read its RTP; `parseRtp` and `seqDistance` now live in `packages/server/src/rtp.ts` and are shared by both. The reorder buffers are not shared: RIST's is time-based and holds packets so a NACK can still be answered, and RTP has nothing to recover with.

Consequences of owning the socket: only the URL's port is bound, so the RTCP FFmpeg sends to the port above never arrives (a sender that multiplexes it onto the one port, RFC 5761, is handled by the depacketizer instead); `connectTimeout` and `readTimeout` are enforced here rather than by a URL option, the first bounding the wait for the first datagram and the second the silence that ends the stream; and a UDP socket has no EOF, so silence is the only thing that can end it.

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

- **`nextSegmentBoundary` puts the cut in the caller's hands.** Anchoring the grid to a playlist's own first packet fixes drift within one output but leaves two outputs disagreeing: every audio packet is a key packet, so nothing else pins an audio cut, and two encoders fed the same media but started seconds apart cut at different timestamps. That rules out pipeline locking — two encoders whose segments must be interchangeable — and splice-accurate cuts, where audio has to end at the splice time a `SCTE-35` marker names and the default deadline knows nothing about it.

  The option takes where the current segment starts and returns where the next one should end, or `null` to leave that segment to `targetDuration`. `start => Math.floor(start / 2) * 2 + 2` is a 2-second grid measured from zero, which two encoders agree on whenever each started. It replaces the video deadline as well as the audio grid, so both tracks follow the same instruction rather than one following the caller and the other the default.

  **A stated boundary cuts at the first packet at or after it, not the nearest.** That is the opposite of the repeating grid directly above, deliberately: the grid rounds either way because always rounding one way accumulates, while a stated boundary is an instruction, and a segment opening before a splice point carries media that belongs to the previous segment. Measured on 48 kHz AAC: two outputs 5.3 s apart agree on every boundary after the late one's first partial segment — `6.016, 8.000, 10.005, 12.011, 14.016, 16.000, 18.005` from both — and each lands within a frame of the grid rather than drifting from it, because the boundary is recomputed from zero each time rather than from the last cut.

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

  `createVideoQuantizerReader(codec, decoderConfig)` reads the quantizer each coded picture states, for AVC, HEVC, AV1 and VP9. This is the number an encoder holding a bitrate actually varies: a capped-rate encode shows a difficult stretch of source as a rising quantizer rather than as bigger frames, which is why frame size alone ranks difficulty poorly (the consumer measured Spearman 0.45 for frame size against 0.79 for bits weighted by quantizer step). Slice and frame headers only — nothing is decoded and nothing is encoded.

  Every value it needs was **already being parsed and thrown away** by the CENC slice-header parsers and the AV1/VP9 tile parsers, which walk the whole header to find where encryption may begin: `pic_init_qp_minus26` and `slice_qp_delta` for AVC, `init_qp_minus26` and `slice_qp_delta` for HEVC, `base_q_idx` for AV1 and VP9. So this captures four discarded values and exposes one reader, rather than adding a second parser for any of the four codecs — the same move as `apply_grain` above.

  It is a reader, not a free function like `readVideoSliceType`, because every codec here needs state that a single packet does not carry: AV1 and VP9 state the quantizer past fields an inter frame takes from its reference frames, and an AVC or HEVC stream may replace its parameter sets in band, so the PPS a slice's delta is relative to may have arrived in an earlier packet. `scale` names which scale the value is on — `'h26x'` for a 0-51 luma QP, `'qindex'` for AV1 and VP9's 0-255 quantizer index, which are not comparable without conversion. `values` carries every quantizer the packet states (one per slice, or one per coded frame where a packet holds a hidden frame alongside the shown one) and `value` their mean, which for the single-slice pictures encoders emit by default is the picture's own quantizer.

  Tested against `ffmpeg -c copy -bsf:v trace_headers`, element for element, over four committed fixtures: 125 values for `video.mp4`, 300 for `video-h265.mp4`, 90 (across 82 packets) for `bear-av1.mp4`, 82 for `bear-320x240-vp9.webm` — zero mismatches. The traced values live in `test/node/_video-quantizers.json` so CI reproduces the comparison without ffmpeg, and so the expectation comes from a second implementation rather than from this one. Two things that comparison caught: AV1 temporal units that hold **two** frame headers, where reporting the unit's last value silently dropped 8 of 90; and that **no HEVC encoder available here ever sets `init_qp_minus26`** — x265 writes 0 and states the whole quantizer per slice, as do all four HEVC fixtures, so a reader that ignored the PPS term passed everything. That term is now covered by patching it into a real PPS with the library's own bitstream writer and asserting all 300 slices shift with it; the mutation that ignores the PPS was green before that test and is red after.

  **No in-process VMAF.** Asked for alongside these, and not possible in this fork: there is no native build here to put `libvmaf` into. Every package is TypeScript, and `@mediabunny/server` gets FFmpeg from `node-av`'s prebuilt binaries, whose build has `psnr` and `ssim` but no `libvmaf` filter (`Filter.getByName('libvmaf')` returns nothing). Adding it would mean forking node-av's FFmpeg build and shipping our own binaries for every platform triple, which is node-av's business and not a fork of a TypeScript library's. There is also nothing to depend on instead: no npm package ships libvmaf bindings, and no WebAssembly build of it exists — the one prebuilt-binary crate is Rust and Ubuntu-only.

## Timed ID3 — `addId3Metadata`

`addId3Metadata(output, { time, data })` writes one complete ID3v2 tag at a point on the media
timeline, and what carries it is the segment's business rather than the caller's:

- **MPEG-TS** — a PES packet on the PID `MpegTsOutputFormatOptions.timedMetadataPid` declares. The PMT
  lists it with `stream_type` 0x15 and a `metadata_descriptor` naming `ID3 ` as both the application
  and the metadata format, byte for byte what FFmpeg's `mpegtsenc` writes for a timed ID3 stream
  (`26 0d ff ff 'ID3 ' ff 'ID3 ' 00 0f`), and the PES uses `private_stream_1` — also FFmpeg's choice,
  read out of `libavcodec/libx264.c`'s sibling in `mpegtsenc.c` rather than assumed. `timedMetadataPid`
  is sugar: the same stream can be declared through `privateStreams` with those descriptors by hand.
- **CMAF / fragmented MP4** — an `emsg` with scheme `https://aomedia.org/emsg/ID3`, exported as
  `ID3_EMSG_SCHEME`, written **ahead of the `moof`** of the fragment covering the time, with a version 0
  `presentation_time_delta` so the segment reads without knowing where it sits in the presentation.

**The `emsg` is written by the fragment's own muxer, not spliced in afterwards.** `IsobmffMuxer._addEmsg`
queues a box that `finalizeFragment` writes immediately before it takes the `moof`'s position — every
sample offset in the fragment is measured from there, so a box written later would shift the data the
`trun`s already name. Splicing it in after the fact would also mean buffering a segment that is
otherwise written straight to its target.

**`addPrivatePesPayload` now accepts a segmented output too**, the same way `addScte35Section` does: the
payload waits in the pipeline until the segment its time falls in is written. Like a cue, a tag is
placed in every variant rather than consumed by the first playlist to reach it.

`test/node/id3-timed-metadata.test.ts` reads each one back out of the bytes — the PES with
`readPrivatePesPayloads`, the `emsg` with `readEmsgs` — checks the tag survives byte for byte, checks
the `emsg` precedes the `moof` in the segment, and asserts the PMT's descriptor and `stream_type` as
hex. Placing every tag in the first segment instead fails two of them.

## SCTE-35 into a segmented output

`addScte35Section(output, section)` now accepts a **segmented** output whose `segmentFormat` is
`MpegTsOutputFormat`, not only a plain transport stream. Such an output has no one stream to write
into — it opens a muxer per segment — so the section waits in `SegmentPipelineMuxer` until the segment
its splice point falls in is written, which is the segment a receiver reaches it by. The splice point
comes from `parseSpliceInfoSection`, so nothing about the section is assumed.

**Splice times are on the output's own media timeline**, the one the segments carry, exactly as they
already had to be for a plain transport stream. `mediaTimestampBase` shifts that timeline — by 10
seconds for HLS, by default — so a time taken from the input's timeline lands that much early. It is
written anyway, because a cue that arrives after the media around it is an ordinary live occurrence
rather than an error, but a cue more than one segment behind is **named in a warning** that says which
timeline it should have been on. Measured: a splice stated at 2.5 against segments running 10 to 15
went into segment 1 silently before that warning existed, which is exactly how this would be
mis-integrated.

**A splice is placed by the segment's cut, not by how far its tracks reach.** The window a cue is
matched against used to end at `maxEndTimestamp` — the furthest any track's last packet reaches — and an
audio frame routinely overhangs the video cut by a few milliseconds. Measured on `demo.mp4`: cuts at
11.0000 and 13.0000 against ends of 11.0027 and 13.0080. A splice stated *exactly* on a boundary, which
is the normal case since that is where a splice is placed, therefore landed in the segment **before**
the one that starts there, and its `START-DATE` then disagreed with the section's own `pts_time`. The
window now ends at the first packet that is not in the segment, which is where the next one starts; the
last segment keeps everything still queued.

**A cue reaches every variant.** Each one writes its own segments, so the pipeline records which
playlists a section has already gone into rather than consuming it on the first — consuming it left the
other renditions without the break, and a player switching bitrate mid-break would have missed its end.

A cue whose splice never falls inside a segment — the stream ended first — is named at finalize rather
than dropped in silence. A CMAF segment has no cue PID to carry a section at all; that is not an error,
since the playlist marker is the part a player reads, so such a cue counts as taken rather than lost.

`test/node/scte35-output.test.ts` publishes through an `HlsOutputFormat` and reads each segment back
with `readScte35Sections`: the cue lands in the segment covering it, one in the first segment stays
there, one on the input's timeline is placed and named, one past the end is named, and CMAF is quiet.
Placing every cue in the current segment instead fails two of them.

### `Scte35Section.outOfNetwork` and `.breakDuration`

A playlist marker needs more than the splice time: an `#EXT-X-CUE-OUT` states how long the break runs
and an `#EXT-X-CUE-IN` closes it, so the section has to say which it is. Both fields are now read:

- `splice_insert` states them itself — `out_of_network_indicator` in its flag byte, and `break_duration()`
  behind the splice time when `duration_flag` is set. The indicator stands even for an immediate splice,
  which states no time: "now" is still out of network.
- A `time_signal` states them in a `segmentation_descriptor`'s `segmentation_type_id` (SCTE 35 table 23).
  The start and end of each break run on consecutive values, but the parity shortcut is written down
  nowhere and the ranges around them do not follow it, so the eleven start ids are listed and the ends
  derived from them. `segmentation_duration` is 40 bits at 90 kHz, unlike `break_duration()`'s 33.

`null` means the section says neither, which a `splice_null`, a cancelled event, an encrypted section, a
`time_signal` carrying some other descriptor, and an open-ended break all legitimately do. Walking to the
descriptor needs the command's length, and `0xfff` means "unknown" — there is then no way to find the
loop behind it, so the fields stay `null` rather than being read out of the wrong bytes.

### Ad markers in the media playlist — `adMarkers`

The section in the transport stream tells an origin where the break is; the playlist tells the player.
`HlsOutputFormatOptions.adMarkers` writes them, defaulting to `'none'`:

- **`'daterange'`** — `#EXT-X-DATERANGE` with the section's own bytes as hex on `SCTE35-OUT` or
  `SCTE35-IN`, plus `PLANNED-DURATION` where the cue states one (RFC 8216bis §4.4.5.1). `START-DATE` is
  on the playlist's wall clock, so this needs `programDateTime` or epoch-relative tracks; without one
  the tag is **skipped with a warning naming the option** rather than written without a `START-DATE`,
  which would be invalid.
- **`'elemental-scte35'`** — `#EXT-OATCLS-SCTE35` with the section as base64, then `#EXT-X-CUE-OUT`,
  `#EXT-X-CUE-OUT-CONT` on every segment inside the break, and `#EXT-X-CUE-IN` at its end.
- **`'elemental'`** — the same without `#EXT-OATCLS-SCTE35`.
- **`'none'`** — no marker; the in-band section is unaffected either way.

A break's state carries across segments, so the `CUE-OUT-CONT` line is derived by walking the written
segments rather than by looking at one in isolation — a player joining mid-break needs to know how far
in it is.

**A cue that opens no avail gets no cue tags at all**, `#EXT-OATCLS-SCTE35` included: that line only ever
accompanies a `CUE-OUT` or a `CUE-IN`, and writing it alone announced a break the playlist never opened.
**And `#EXT-X-CUE-OUT-CONT` is keyed on what a segment's cues *do*, not on it having none** — a segment
inside a break that happens to carry an unrelated section, a heartbeat or a Program Start, is still
inside the break, and a player joining there needs its position.

**A cue that opens no avail is `SCTE35-CMD`, never `SCTE35-OUT`**, and writes no `#EXT-X-CUE-OUT` and no
`PLANNED-DURATION`. RFC 8216bis §4.4.5.1 names three attributes and `CMD` is the one for a section that
neither opens nor closes a break; announcing it as an OUT would promise a break nothing closes.

### Which types open an avail is the caller's to decide

**Not this library's.** `addScte35Section(output, section, { outOfNetwork, breakDuration })` states the
answer directly and beats whatever the section is read as. A MediaTailor deployment and a broadcast
playout disagree about Ad Block and overlay types, and a packager that has already made that decision
must not have it re-derived differently here — the markers would then describe breaks its own origin and
ad decisions do not see.

The derived default is the avail set **MediaLive and MediaTailor document**: `0x22`, `0x30`, `0x32`,
`0x34`, `0x36` and their ends. It is deliberately narrower than "every type whose name ends in Start" —
a Program, a Chapter, an Ad Block (`0x44`/`0x46`) and an overlay placement opportunity (`0x38`/`0x3a`)
all have start and end ids and none of them opens a linear break. `Scte35Section.segmentationTypeId`
reports the raw id either way, so a caller can apply its own rule without reparsing.

Only the marker is affected. The section itself is written into the transport stream verbatim, since it
is the caller's bytes.

`test/node/scte35-output.test.ts` asserts on the playlist text, which is what a player and
`mediastreamvalidator` are given: the `START-DATE` matches the `#EXT-X-PROGRAM-DATE-TIME` of the segment
the cue landed in, every `CUE-OUT-CONT` sits between the out and the in, and `'elemental'` carries no
`OATCLS` line. Forcing the mode to `'none'` fails four of them.

## SCTE-35 on the write side

`new MpegTsOutputFormat({ scte35Pid })` declares a cue stream, which puts it in the PMT with stream type **0x86** and the `CUEI` registration descriptor — the registration is what tells a cue stream from the Blu-ray use of that same type. `addScte35Section(output, section)` writes a `splice_info_section` into it, verbatim and CRC included, since composing a splice is a decision this library has no part in. `readScte35Sections` reads them back.

The section layout was taken from tsduck's own serializer rather than from memory: `table_id` 0xFC, then `protocol_version` u8, `encrypted_packet` 1 bit, `encryption_algorithm` 6, **`pts_adjustment` 33**, `cw_index` u8, **`tier` 12**, `splice_command_length` 12, `splice_command_type` u8, trailing CRC_32. It is a **private section, not a PES packet**, so the muxer's existing `writePsiSection` carries it — pointer field, packet spanning and continuity counters all already handled.

**No time argument, deliberately.** SCTE 35 carries the splice point in `pts_adjustment` plus the command's `splice_time`, so a caller controls placement by when it calls and a receiver reads the time out of the section rather than from its position.

A section handed over before the tables exist is **queued**, not written: a track has no data until its first packet is added, so writing the PMT at that moment would publish one naming the cue stream and none of the media. The queue goes out right behind the first PMT, which is where "before the first media packet" puts a cue. Covered by `test/node/scte35-output.test.ts`, which checks the PMT entry and reads sections back byte for byte both before media and mid-stream; five of seven mutations are red, and the two that are not are stated in that file — a stream of 20 packets never flushes its tables before `finalize`, so the branch that writes a section once the tables already exist is the live-stream path and is not reached there.

**A cue PID does not warn.** The demuxer surfaces no track for a stream type it cannot packetize and says so once per type, which on every segment carrying a cue PID was a warning about the thing the fork reads itself. A `0x86` entry carrying the `CUEI` registration is now passed over silently; the same type without it still warns, since that is the Blu-ray use and genuinely unsupported. The upstream line `if (!ignoredStreamTypes.has(streamType)) {` is gone for this.

## MPEG audio Layer II — `mp2`

`mp2` is an audio codec of its own here, encodable through `@mediabunny/server` (FFmpeg's `mp2`) and carried in MPEG-TS, Matroska, MP4 and MOV. Layer II frames are self-contained — no bit reservoir — so unlike Layer III it needs no pre-roll, and its frames are 1152 samples in every MPEG version.

**No container states the layer, so the frame header is what decides.** MPEG-TS stream types 0x03 and 0x04 name the MPEG *version*, and an MP4 `esds` object type indication of 0x6B or 0x69 says the same — all of them cover Layers I, II and III alike. `readMpegAudioCodec` reads the `layer` field out of the first frame header, which is how ffprobe does it too. On the write side both go out identically: stream type 0x03 for TS, `mp4a` with object type 0x6B for MP4.

Consequences, each measured against ffmpeg's own `-c:a mp2` output rather than assumed:

| container | sample entry | `esds` | ffprobe `codec_name` | we report |
|---|---|---|---|---|
| MOV | `.mp2` | none | `mp2` | `mp2` |
| MKV | `A_MPEG/L2` | — | `mp2` | `mp2` |
| MPEG-TS | stream type 0x03 | — | `mp2` | `mp2` |
| MP4 | `mp4a` | 0x6B | **`mp3`** | **`mp3`** |

**MP4 cannot label it, and that is not ours to fix.** QuickTime has its own `.mp2` sample entry which names Layer II outright and carries no `esds`; MP4 has no equivalent, so the object type is all a reader has there. ffmpeg's mp4 muxer refuses the QuickTime entry outright (`Tag .mp2 incompatible with output codec id`), so there is no standard way to say "Layer II" in an MP4 at all. Writing MP2 to MP4 therefore produces a file ffprobe calls `mp3`, byte for byte what ffmpeg writes, and this fork reads it back the same way.

Reading it back from an MP4 could be made to say `mp2` by sniffing the first frame, but it is deliberately not: the codec is settled from the `moov` alone, before any sample is read, and `InputTrack` still exposes a **synchronous** deprecated `codec` getter beside the async `getCodec()`. A lazy sniff would make the two disagree, and an eager one would read a sample during metadata parse for every `mp4a.6B` track. Use MOV, MKV or TS where the label matters.

**A behaviour change on the read side.** Stream types 0x03/0x04 and `mp4a.69`/`.6B` were reported as `mp3` unconditionally before. A Layer II stream in a transport stream or Matroska file now reports `mp2`. Layer III is unaffected, and Layer I still reports `mp3` — there is no codec of its own here for it, which is what it reported before this distinction existed.

Covered by `test/node/mp2.test.ts`: every container is written, read by `ffprobe` for its `codec_name`, decoded by `ffmpeg` so "it plays" is measured, and read back through this fork's own demuxers. A Layer III stream through the same stream type 0x03 is the control, so the layer is demonstrably what decides.

## HDR10+ passthrough — `VideoSample.hdr10Plus`

HDR10+ (SMPTE ST 2094-40) dynamic metadata survives a decode and re-encode: a decoded `VideoSample` carries the T.35 payload on `hdr10Plus`, and an HEVC encode writes it back as a prefix SEI ahead of the frame's VCL NAL units. `clone` keeps it, as it does the Dolby Vision RPU.

**It is read from the bitstream, not from frame side data, and that is forced rather than chosen.** The obvious route is `AV_FRAME_DATA_DYNAMIC_HDR_PLUS` plus `av_dynamic_hdr_plus_to_t35`, which is what FFmpeg does internally. node-av binds the constant but no T.35 conversion of any kind, and what `getSideData` returns is **11304 bytes, byte-identical on every frame** — `sizeof(AVDynamicHDRPlus)`, the in-memory struct. A real T.35 payload is tens of bytes and changes per frame. Serialising that struct by hand would mean reimplementing libavutil's conversion against an ABI layout that is not a wire format, so the payload is parsed out of the SEI instead, with machinery `extractSeiHdrMetadata` already had.

Consequences worth stating:

- **HEVC and AV1.** AVC carries no HDR10+ in practice; a sample stating it on any other codec is dropped with one warning rather than failing the encode, because an ABR ladder hands the same sample to every rung.
- **Container-only carriage reads as `null`.** The payload is taken from the bitstream, so metadata carried only by a container with no SEI is not seen. The field's documentation says so, in as many words, so a `null` is not mistaken for "no HDR10+".
- **The decoder reorders, so the payload is keyed by packet timestamp** and claimed when its frame emerges, rather than being attached to whatever frame happens to come out next.
- **`user_data_registered_itu_t_t35` has one owner.** Payload type 4 carries ATSC A/53 captions as well, and `closed-captions.ts` had its own copy of the constant; it now lives in `sei.ts` and both read it. The discriminator is the payload's own header — provider 0x003C and application identifier 4 for HDR10+, provider 0x0031 and `GA94` for captions.

**AV1 carries the same payload in a `METADATA_TYPE_ITUT_T35` metadata OBU**, so `hdr10Plus` holds the same bytes whichever codec carried them. Two details of AV1's framing, both of which cost a failed attempt: the payload is preceded by a leb128 `metadata_type`, and §5.8.1 follows it with `trailing_one_bit` — the byte `0x80`, since the payload is byte-aligned. That byte is framing, not payload, so it is stripped on read and written back on build; a first injector that left it out produced OBUs FFmpeg rejected outright with `trailing_one_bit out of range`. The OBU is inserted **after** a leading temporal delimiter, so it sits inside the temporal unit it describes rather than ahead of it.

The AV1 fixture is not something this library wrote. An HDR10+ source re-encoded to AV1 by ffmpeg carries nothing — the metadata lives in the frame side data that cannot be reached — so the fixture was built by injecting **real payloads, lifted from the HEVC source**, into an SVT-AV1 stream with a standalone script. That ordering matters: a first attempt injected invented bytes and ffprobe reported zero frames, which reads identically to "ffprobe cannot see AV1 T.35" and would have sent the whole feature down a fallback path. With real payloads it reports all of them, so **ffprobe is a sufficient oracle for AV1 as well** and no `dav1d`/`aomdec` fallback is needed.

**The intermediate AV1 is encoded all-intra, and that is load-bearing.** SVT-AV1 otherwise emits hidden alt-ref frames that a bare `OBU_FRAME_HEADER` re-displays via `show_existing_frame`. Metadata does not follow a re-display, so the number of frames ffprobe reports as carrying ST 2094-40 depends on how a given version counts those: the first fixture measured **8 locally and 11 on CI**, which failed a release. `-g 1` removes hidden frames, every frame carries its own metadata OBU, and the count is 8 everywhere. `scripts/build-av1-hdr10plus-fixture.py` rebuilds it, parsing the HEVC fixture's SEI with its own parser so the fixture does not depend on this library being right.

The tests count with **ffprobe**, not by reading our own output back: the checked-in fixture reports ST 2094-40 on all 24 frames, and so does a 360p HEVC re-encode of it. Removing the HEVC read fails three; removing its splice fails only its re-encode. The AV1 pair is held the same way: its fixture reports 8 of 8 frames, an HEVC source re-encoded to an AV1 rung reports 24, and removing either the AV1 read or the AV1 OBU insertion fails exactly one test each.

## The decode anchor is a track constant across segments

**A regression introduced with the fragmented edit list above, and fixed here.** A segmented output opens one `Output`, and so one
ISO BMFF muxer, **per segment**. The anchor a below-zero decode timeline is shifted by is settled from
the first packet that muxer sees — so segment 1 settled on the shift and wrote it into the init's `elst`,
while every later segment, whose own first decode time is positive, settled on zero. Read under that
same `elst`, segments 2 and on presented one reorder delay early: measured on `demo.mp4` with a 2 s
target duration, `tfdt` 0, 110592, 225792 and presentation 0, **1.92, 3.92** where the key frames were
fed at 0, 2, 4. A live encoder sees it as a 40 ms step back at every segment boundary and two locked
pipelines disagreeing by the delay.

The anchor is now settled once and reused: `IsobmffMuxer._decodeAnchors()` reports what each track
settled on and `_seedDecodeAnchors()` takes it, with `SegmentPipelineMuxer` carrying the map between
segments. Two details the first attempt got wrong, both caught by a test:

- **Only a fragmented muxer's anchor is a track constant.** It is `min(anchor, 0)`, so it is the
  sub-zero shift and nothing else. A progressive per-segment file rebases to its own first sample,
  which is its own business — seeding that shifted every later segment back onto the first one's start,
  which `test/node/hls-output.test.ts`'s sparse-track row caught.
- **A track settles when its own queue flushes**, so the map is filled per track after each segment
  finalizes rather than taken whole from the first. Taken whole, a segment carrying audio and video
  stored the audio anchor alone, and the video kept recomputing zero.

`test/node/segment-decode-anchor.test.ts` runs the matrix — {VOD, live} × {`mediaTimestampBase` 0 with
a negative first decode time, base 5} × {video only, video + audio} — and for every segment reads the
first presentation time back out of init + segment with **both** this library's demuxer and `ffprobe`,
asserting it is a **key frame's** own fed timestamp. That last part matters: asserting merely that it
was *some* fed timestamp passes with the bug in place, since 1.92 is a delta frame's time on a 25 fps
grid. With the seeding disabled, the four base-0 rows fail and the base-5 rows do not, which is the
shape of the defect.

### `getSegmentPresentationTime(segment, init)` and `IsobmffTrackInfo.editMediaTime`

Once every fragment carries the shift, `getSegmentDecodeTime(segment) + getSegmentCompositionOffset(segment, init)`
is a **media** time, not a presentation time: it sits the edit list's `media_time` past the presentation.
`getSegmentPresentationTime` is that subtraction, in the referenced track's own timescale, and
`IsobmffTrackInfo.editMediaTime` is the span on its own — the `media_time` of the first non-empty `elst`
entry, less any leading empty edit converted from the movie timescale, and `0` for a track with no
`edts`. Anything naming segments by time, indexing fragmented sources, or lining two renditions up wants
it, and parsing `moov`>`trak`>`edts`>`elst` by hand is what it replaces.

Asserted three ways: against every row of the matrix above, against `ffprobe`'s own first presentation
time of an ffmpeg CMAF written with `-use_editlist 1` and B-frames, and — for a file with no edit list —
as exactly the sum it is built from.

**`rebaseSegmentDecodeTime` and `setSegmentDecodeTime` now move the `sidx` too.** A `sidx`'s
`earliest_presentation_time` is on the same media timeline as the `tfdt` it indexes, and both moved only
the `tfdt`: a segment with `tfdt` 110592 and `earliest_presentation_time` 119808, rebased by +4608, came
out with `tfdt` 115200 and the index still on 119808. A progressive packager rebasing segments onto a
shared init's edit list then serves an index pointing at a presentation time the fragment no longer has.
Both versions of the field are handled, and a delta that would take it below zero is refused.

## A stated decode timeline that runs backwards

A packet may state its own decode timestamp, and the ISOBMFF muxer then writes that timeline instead of deriving one from presentation order. Nothing checked the stated times were in decode order, so `processTimestamps` reached `assert(delta >= 0)` and `finalize()` threw a bare **`Assertion failed.`** naming nothing — reported by a consumer whose rebuilt packets restated each presentation timestamp as the decode timestamp, which on a reordered stream runs backwards.

It now throws an error naming the packet's presentation time, the decode time it stated, and the previous packet's — the three numbers needed to find the offending packet. **It throws rather than repairing the order**, because the stated timeline is the caller's claim about how the media decodes and silently resorting it would write a file whose timing is not the one asked for. Only reachable from packets that state a decode timestamp: without one these are the sorted presentation timestamps and cannot go backwards.

## Start timecode — `InputVideoTrack.getStartTimecode()`

A broadcast source states where its media sits on a timeline, which is not a duration: `01:00:00;00` is a label, and a consumer burning in MediaConvert's EMBEDDED timecode needs the label. `getStartTimecode()` returns `{ hours, minutes, seconds, frames, dropFrame, frameRate }`, or `null` for a file that states none — which is every container here except the two below, MXF included, since **this fork does not read MXF at all**.

**MP4 and MOV: the QuickTime `tmcd` track.** Its sample description carries the drop-frame flag, the timescale and frame duration, and the frame count a second rounds to; its single sample is a frame number counted from 00:00:00:00. Such a track has no `info`, so it never joins `tracks` and a caller never sees it — its data is collected separately and read by the video tracks.

**Drop-frame drops numbers, not pictures.** Two a minute at 29.97 and four at 59.94, except every tenth minute, so the count stays near wall clock on a rate that is not an integer. A frame number therefore has to be renumbered before it is split into hours and minutes: read naively, an hour of drop-frame comes out as **00:59:56;12**, which the test asserts as the thing being guarded against. The first minute is the exception that catches a wrong implementation — it keeps all 1800 of its numbers, because the drop happens as the minute increments, so frame 1799 is `00:00:59;29` and frame 1800 is `00:01:00;02`.

**The bitstream's own SEI**, when there is no timecode track. HEVC states one in `time_code` (D.2.27) and H.264 in `pic_timing` (D.2.2). Only the first of the up-to-three clock timestamps is read, since they are the fields of one picture and the same instant, and the rate comes from the first packet's duration because neither SEI states one.

**H.264's message is not self-describing, which is why it needs the SPS.** How many bits precede the clock timestamp, and whether one is present at all, are stated only by the VUI: `pic_struct_present_flag`, and the CPB delay widths inside the HRD parameters. This fork's SPS parser read all four and threw them away — `skipBits` with a comment naming each — so they are returned now (`picStructPresentFlag` and `hrd` on `AvcSpsInfo`) and `readAvcHrdParameters` replaces the old skipper. With no HRD in the VUI there are no delay bits to step over, which is the common case.

A detail that cost a debugging round: with an `avcC`, the parameter sets live in the description rather than in band, so `avcCodecInfo` is null there and the SPS has to be deserialized from `codecDescription`.

ffmpeg writes a `tmcd` track for `-timecode` and never the SEI, and x264 emits `pic_timing` with `clock_timestamp_flag` 0 — a one-byte payload carrying no timecode. So there is no natural fixture for either bitstream path: `scripts/build-timecode-sei-fixture.py` lays both messages out by hand, emulation prevention included, and injects one before the first slice of a stream that has no timecode track. The H.264 fixture is encoded with `pic-struct=1`, because the message is unparsable unless the VUI declares it. What the reader is held to is not what this library writes.

## `#EXT-X-PROGRAM-DATE-TIME` from a stated clock — `programDateTime`

`HlsOutputFormatOptions.programDateTime` anchors the playlist to a wall clock: each segment's tag is
that date plus the segment's own timestamp. A player needs it to seek by time of day, to align two
renditions, and to place an `#EXT-X-DATERANGE`, whose `START-DATE` is on the same clock.

The tag existed before this, but only where every track stated
`BaseTrackMetadata.isRelativeToUnixEpoch` — which requires the *media's own* timestamps to be
epoch-relative. A live stream would then carry timestamps around 1.7e9, where a 32-bit float resolves
to about 128 seconds, so the media timeline cannot be left where the encoder put it. This option states
the clock separately and leaves the timeline at zero; `null` is the same as omitting it, and a track
that is genuinely epoch-relative still gets the tag without it.

A segment that starts below zero — AAC priming does, by 21 ms — states a date before the anchor, which
is correct: the anchor is media time zero, not the first byte.

`test/node/hls-output.test.ts` asserts each date is the previous one plus that segment's `#EXTINF`
duration, starting at the anchor, so the clock is the media's own timeline laid on the anchor rather
than wall time while writing.

## An absent HLS attribute is absent, not `undefined`

The playlist serializer guarded every optional attribute with `!== null`, which an **absent** field passes: a caller handing it a plain object got `#EXT-X-RENDITION-REPORT:URI="b.m3u8",LAST-MSN=undefined,LAST-PART=undefined`, and a consumer skipped reporting a rendition that had no part yet. RFC 8216bis 4.4.5.4 lets both be absent, and `undefined` is never a legal attribute value for any of them.

The `hls*` builder helpers normalise with `?? null`, so this only bites a caller that constructs the AST itself — which `hlsMediaPlaylist` invites, since `renditionReports` takes the strict `HlsRenditionReport[]` while its siblings take loose option shapes. Fixed in the serializer rather than the builders, because that is where every caller converges: all 40 `!== null` presence guards became `!= null`, which `eqeqeq` is configured to allow (`{ null: 'ignore' }`) and which 41 other places in `src` already use.

**The `=== null` side was the same bug and worse.** `byteRangeValue` returned early on `b === null`, so an absent byte range fell through and **threw** on `b.offset` — a crash rather than bad output, and reached by `#EXT-X-PART`. `b.offset === null` would likewise have rendered `length@undefined`. All five `=== null` guards in the file became `== null`.

`test/node/hls-serializer.test.ts` covers one tag per emitter — rendition report, preload hint, skip, part and server control — asserting both that the output contains no `undefined` and that the omitted attribute's name is absent. Reverting the `!==` guards fails two of them; reverting only the byte-range guard fails one.

## MPEG-TS track language

A PMT states a track's language in an `ISO_639_language_descriptor` (tag 0x0a, ISO/IEC 13818-1 2.6.18), and the demuxer ignored it: `getLanguageCode()` returned a hardcoded `und` for every MPEG-TS track, so a consumer selecting audio by language had nothing to select on. It is read now, and the muxer writes it for a track whose metadata states a `languageCode`.

Three details worth keeping:

- **Not to be confused with the language inside a teletext or subtitling descriptor.** Those are tags 0x56 and 0x59 and carry their own per-entry ISO-639 fields, described above; 0x0a is a separate descriptor and the two are read by different code. A stream can carry both.
- **A descriptor may repeat, one per `audio_type`.** The first names the track, which is what a selector wants; the rest describe alternate audio services on the same stream.
- **Only three lowercase letters are taken.** Writers pad the field with spaces or nulls, and a code a consumer cannot match says less than `und`, so anything outside `a`–`z` falls back to undetermined.

The read test uses an **ffmpeg-written** fixture (`test/public/mpeg-ts-two-languages.ts`, two AAC tracks tagged `eng` and `spa`), so it reads a descriptor this library did not write; a separate test asserts a programme stating no language still reads as `und`, and a third round-trips a language through our own muxer.

**PIDs and stream ids now follow the order tracks were added, not the order their packets arrive.** Track data was created lazily on a track's first packet and appended, so the PID, the stream id *and the order the PMT lists its streams* all followed whichever encoder produced a packet first — two runs of the same job that interleaved differently wrote different bytes. Both halves had to change: the PID comes from the track's index in the output, and the track data is inserted in that order rather than appended. Worth knowing when reading the test: comparing the **set** of PIDs in use cannot see this, because both orders use the same two PIDs; it passed against the unfixed code until it compared each stream type to its PID, parsed out of the PMT.

## MPEG-TS teletext and DVB subtitles on the read side

`readMpegTsPrivateStreams(bytes)` reports the teletext and DVB subtitle streams a programme declares, and `readPrivatePesPayloads(bytes, pid)` hands back each PES payload with the time its header states. Standalone byte-level functions in the shape `readScte35Sections` set: no new track kind, nothing threaded through `Input`.

Both ride stream type 0x06, so the **descriptor is the only thing that tells them apart** — a `teletext_descriptor` (tag 0x56) or a `subtitling_descriptor` (tag 0x59). A private stream carrying neither is not reported, since nothing distinguishes it from any other private data. Field widths are from ETSI EN 300 468 V1.20.1: teletext entries are five bytes (ISO-639, then `teletext_type` 5 bits, `teletext_magazine_number` 3 bits, `teletext_page_number` 8 bits, §6.2.43), subtitling entries eight (ISO-639, `subtitling_type` 8, `composition_page_id` 16, `ancillary_page_id` 16, §6.2.41).

**The page number is two hex digits, and magazine 0 means magazine 8.** So page 888 arrives as magazine `0` with page byte `0x88`; reading that byte as decimal gives 136 and a page nobody can ask for. There is a test whose only job is that arithmetic. Payloads are handed over as they arrived — the `data_identifier`/`data_unit` framing of EN 300 472, or the segments of EN 300 743 — so a caller parses what it needs without this having to understand either. A packet whose header states no PTS yields `time: null` rather than being dropped, because teletext often omits it and discarding those would lose cues.

The fixture is synthesised, by `scripts/build-dvb-private-fixture.py`, since no broadcast sample here carries either. It is **not** validated by the writer that made it: `ffprobe` reads the same file as `dvb_teletext` on one PID and `dvb_subtitle` on the other, each reporting `language=eng,deu`, which confirms the descriptors and both of their entries through an implementation that is not this one. Two entries per descriptor and a PES spanning several TS packets are deliberate — with one entry a wrong stride still reads the first correctly, and with a single-packet PES a dropped continuation is invisible. Three mutations were green until the fixture carried both.

## MPEG-TS teletext and DVB subtitles on the write side

The pass-through, opposite the read side above. `new MpegTsOutputFormat({ privateStreams: [{ pid, descriptors }] })` declares a private elementary stream, and `addPrivatePesPayload(output, { pid, time, data })` writes a whole PES payload into it. Nothing here composes a teletext page or a DVB subtitle segment: a payload read off one stream can be written to another and comes back byte-identical with the same PTS, which is the test.

**The descriptors are the declaration.** They are written into the PMT byte for byte, because stream type 0x06 says nothing on its own — a `teletext_descriptor`, a `subtitling_descriptor`, or anything else a receiver is meant to act on. For the same reason the format refuses a descriptor whose own length byte disagrees with its size: it is copied verbatim, so a wrong length shifts every descriptor after it and the PMT still parses, into something else. They are in every PAT/PMT repeat, not only the first, so a receiver joining mid-stream finds them with the media.

**A payload is placed by its PTS, not by when it was handed over.** The payloads are queued and the interleave writes each one when the media reaches its time, so a caller may hand over a whole caption file before adding a single frame. That is why a payload without a PTS is refused rather than guessed at: it has nowhere to go. `PES_packet_length` is stated rather than left unbounded — EN 300 472 4.1 requires it, and it is also what lets the reader tell a whole payload from one a buffer cut short, which is the only reason the round-trip can assert byte identity at all.

Confirmed by `ffprobe` 9.0.2 reading the written stream as `dvb_teletext` and `dvb_subtitle` on their PIDs — an implementation that is not this one. With the descriptor tag changed by one it reads `bin_data` instead, which is how that check was shown to be able to fail.

The TS-packet split is now shared: `writePesTsPackets(pid, header, data, flags)` carries both the media path and this one, with the adaptation field the first packet needs and a PCR only where the flags state one, and PTS/DTS writing is one `writePesTimestamp` instead of the two copies that were in `writePesPacket`. The deletion guard reads that extraction as upstream lines leaving `mpeg-ts-muxer.ts`, since it works per file; the 26 declared lines are all from it — the loop body moved method, `pesHeaderBuffer` became the `pesHeader` parameter, and the `ptsDtsBitstream.writeBits` runs folded into the one helper. Behaviour of the media path is unchanged, which the existing MPEG-TS muxing tests hold.

## Live RIST output — `RistTarget`

`@mediabunny/server` exports `RistTarget`, the counterpart to `RistSource`, speaking **RIST Simple Profile (VSF TR-06-1)** directly. It has to: node-av's FFmpeg has libsrt but **no librist** — `IOContext.open2('rist://...')` returns `AVERROR_PROTOCOL_NOT_FOUND`, one millisecond, which is why the reader was hand-written too. So this is protocol code rather than a wrapper, sized against `rist-source.ts` rather than against `srt-target.ts`.

RTP goes to the URL's **even** port with payload type 33 (MP2T, RFC 3551), a per-stream SSRC and sequence numbers advancing by one; RTCP is read on the odd port above it. A receiver's NACKs are answered from a buffer of recently sent packets — both the RFC 4585 generic NACK, including its 16-bit bitmask, and TR-06-1's range NACK in an RTCP APP packet named `RIST`, which is what `RistSource` sends. Packets age out of that buffer rather than being counted out, because a receiver never asks beyond its own. `'caller'` sends to the URL; `'listener'` binds those ports and learns the peer from whichever address its first RTCP arrives from, which is how a receiver behind NAT is reached.

`sentPackets` and `retransmittedPackets` are separate, since a rising retransmit count is the signal that a path is lossy rather than that anything is wrong here.

**It sends at the rate the stream states, and blocks rather than drops.** Both of those were missing, and without them the queue counters measured nothing. An unpaced sender hands a whole segment to the kernel at once; a RIST receiver then either absorbs that burst out of its de-jitter buffer or loses it. `pacing` (on by default) reads the **MPEG-TS PCR** out of the payload being sent and holds each datagram until the stream's own 90 kHz clock says it is due, which is what RFC 2250 means by pacing MP2T. It is inert on a payload stating no PCR — there is then no rate to pace to. The same clock now drives the RTP timestamp, which was wall clock before. Measured on a synthetic stream of 40 PCRs 25 ms apart: 975 ms of media delivers in 975 ms paced and 608 ms unpaced, and turning the pacer off takes the paced figure to 608 as well.

With a rate, the queue fills for a real reason, so `enqueue` returns a pending promise while it is over `maxQueueBytes` — which is how a `WritableStream` applies backpressure, so the writer waits for the socket instead of having its bytes discarded behind it. `onOverflow` picks between the two: `'block'` by default, because for a relay arriving late beats not arriving, and `'drop'` for a live encode that must not be stalled by a slow receiver. `droppedBytes` and `droppedDatagrams` count only the second, so they stay 0 under the default. A one-datagram bound against sixty datagrams of payload loses nothing and still round-trips byte for byte; the same shape with `'drop'` delivers none of it.

This is a deliberate divergence from `SrtTarget`, which still drops. The queue counters themselves match it so a relay can read every target the same way: `sentBytes`, `queuedBytes`, `maxQueueBytes`, `droppedBytes`, `droppedDatagrams`. Two fixes under them were defects in their own right: the datagram send was `socket.send` with no callback, so **a send error was silently swallowed** where `SrtTarget` surfaces it, and `queued` was decremented when a chunk was dequeued rather than as datagrams went out, so one `_flush` of a whole segment read 0 the entire time it drained. `handOff` awaits the send — which raises `ENOBUFS` and friends, and is what gets the tail datagram to the OS before `finish` closes the sockets — and the count is per datagram.

Covered by `test/node/rist-target.test.ts`, which round-trips through `RistSource` in process. Two header fields had to be checked **on the wire** instead: `RistSource` validates neither the payload type nor the SSRC, so mutating either passed a round trip — a plain UDP socket reads the datagrams and asserts version, payload type, a non-zero SSRC constant across the stream, and sequence numbers advancing by one. Those are the fields a conformant receiver uses to tell this stream from another on the same port, so a round trip through a lenient reader proves nothing about them.

**A short tail can be flushed on demand.** A datagram is packed to 1316 bytes so each carries whole MPEG-TS packets, so a tail shorter than that waits for the bytes that would fill it — at a low bitrate that wait is latency rather than efficiency. `flushPartialDatagram()` sends it now, on `SrtTarget` and `RistTarget` both. `TargetWriter.flush()` deliberately does not: it is the ordinary per-fragment flush, and emitting a short datagram at every one would spend exactly the payload efficiency the packing exists for. The buffer is copied and its length cleared before the write, since the next pump shares it.

`linger` is set for every transtype, not only live, so a file-mode close drains. That is a real libsrt AVOption — `libavformat/libsrt.c` applies it when `>= 0`, setting `SO_LINGER` with `l_onoff = linger > 0` — checked rather than assumed, because a misnamed AVOption fails silently and leaves the default standing. **A file-mode close can still lose a tail, under load.** Reported as 1 run in 3, and reproduced here at 1 in 6 with two other suites running alongside — green on its own, which is why it reads as flaky. The measurements narrow it: `sentBytes` always reaches the full payload, so the sender wrote every datagram; `flush()` and `closep()` both succeed, so the close path swallows no error; the receiver's stream ends on EIO with the tail missing, and EIO is how *every* one of these streams ends, passing runs included. The tail is not a fixed size either — one datagram in one failure, three in another — and the payload is an exact multiple of 1316, so the short-final-datagram path is not involved.

**What `linger` buys, and why it is not the fix.** 40 attempts of that scenario per value: `linger=0` is short on 7, `linger=5` on 3, `linger=30` on 2, and the target's own default on 3 — the same count as the explicit 5, which is what establishes that the default reaches libsrt. So it halves the loss and earns its place, and raising it sixfold does not close the remaining gap, which rules out "the send buffer needs longer" as the explanation. The wait that would close it is on the peer's acknowledgement — `SRTO_SNDDATA` — and node-av's `IOContext` offers no way to read a socket option back, so there is nothing to wait on from here. The reported 1-in-3 rate matches `linger=0` (7 of 40) far better than this target's default (3 of 40), so a caller seeing that rate is likely not getting the linger default at all.

**The reported conditions do not raise it.** Matched in full — a same-process `NetworkSource` listener, `_read` of one 188-byte TS packet at a time, 90–220 KB padded to whole datagrams, close straight after the last flush, and a CPU loaded to 1.8× its idle spin time (gauged in-run, because a load that did not start would read as a quiet machine) — 12 attempts of 12 came back byte-exact. Against a stated 1 in 3 that is under 1%. The failure is real, but it is the ~7% tail loss above, not a 1-in-3 one, and the 188-byte read granularity has nothing to do with it.

**Which side loses it is still open, and a control now exists to settle it.** `srt-live-transmit` from libsrt (Homebrew) is an independent receiver: `srt-live-transmit 'srt://:PORT?mode=listener&transtype=file' file://con` relays to stdout, a pipe, so nothing can be lost between the receiver and the byte count — and it is killed only after it reports the sender's disconnect, so a short count is bytes libsrt never handed over rather than a receiver cut off mid-drain. Against it the fork's `SrtTarget` delivered 8 of 8 whole, and the fork's own `SrtSource` 8 of 8 in the same run with `srt-target` and `rist-target` alongside. So the failure does not reproduce at all on this machine today, and nothing yet attributes it to the sender rather than to the reader.

Two warnings from building that control. Relaying through UDP instead of a pipe reported 1 run in 6 short by exactly 6580 bytes — five whole datagrams — which reads precisely like the reported bug and was the **relay** dropping: UDP on loopback has no flow control, and an independent receiver that can itself lose bytes attributes nothing. And `srt-live-transmit` has no file target other than `file://con`; a `file:///path` target fails with `Unsupported target type` after the listener has already bound, which looks like a connection problem. The consequence for the fix: **a 50-run green does not show the race is fixed** while the race cannot be made to fail on demand, so the condition that reproduces it has to be found before the test is unskipped — otherwise unskipping only records that the machine was quiet.

That rules out the two cheap explanations, the drain in `finish()` and a swallowed error, and leaves SRT tearing the connection down before the receiver has read what libsrt still holds. Fixing it needs the sender to wait for the peer to acknowledge, which libavformat does not expose. `test/node/srt-target.test.ts` carries the reproduction as a **skipped** test with those measurements written down, rather than a red one or a deleted one.

## Resize and chroma match FFmpeg's lanczos

Every `scale=` in `packages/server/src/video-sample.ts` carries `flags=lanczos+accurate_rnd+full_chroma_int`, and the result is bit-identical to `ffmpeg -vf scale=W:H:flags=lanczos+accurate_rnd+full_chroma_int`. Unflagged means **bicubic** — `vf_scale`'s own `flags` default is `""`, so swscale's library default applies.

`video-encoder.ts`'s fallback `SoftwareScaleContext` takes the same flags **unconditionally**. It fires whenever the frame mismatches the codec context in format *or* size, and a format-only conversion still resamples **chroma** whenever the subsampling differs — measured at ~34 dB on a same-size 4:4:4 → 4:2:0 with `fast_bilinear`, luma identical. Never gate these flags on a size change.

`test/node/video-resize-quality.test.ts` requires bit-identity, not a PSNR bound: the old bicubic code clears ≥50 dB luma / ≥48 dB chroma at every size, so a bound does not discriminate. An upscale case needs a genuinely smaller source — 1080p→1080p is a pass-through and scores `Infinity` on every kernel.

The deletion guard reads the five changed lines as upstream lines leaving `video-sample.ts` and `video-encoder.ts`; they are declared on that basis, and nothing was removed.

## `frameRate` decimation selects by float slot

`transform.frameRate` gives each sample an output slot with `floorToDivisor(timestamp, frameRate)` and encodes the first sample of each new slot. That slot assignment **is** the frame selection.

Slots are computed on float seconds — a sample carries no ticks by then, and may come from a canvas — so `floorToDivisor` snaps through `roundIfAlmostInteger`. Without it, a time mathematically on a boundary lands ulps below it and the slot's opener becomes source frame 2k + 1: 37 of 750 outputs on a 50 → 25 minute at 1/12800.

**Which parity opens the slots is a property of the source, not a constant.** It is 2k only when the first timestamp sits on the output grid; a start of 95443.7 s, or 60000/1001 → 30000/1001 from 10.0 s, is mid-slot and the odd frames correctly open. What must hold for any source is a **constant** phase with each slot opened **once**. At a gap the slot goes to the first frame at or after the boundary, and slots no frame reaches are filled by `padFrameRate` repeating the last one.

Covered over the rate and time-base matrix in `test/node/frame-rate.test.ts`, and end to end against `ffmpeg -vf "select=not(mod(n\,2)),scale=..." -fps_mode passthrough` in `video-resize-quality.test.ts`. Without `-fps_mode passthrough` the rawvideo muxer duplicates the selected frames back up to the source rate.

## RIST over librist — `packages/rist`

RIST simple and main profile by binding [librist](https://code.videolan.org/rist/librist) rather than implementing RIST. The wire format is then librist's, so the only interoperability test that means anything is against librist's own `ristsender` and `ristreceiver` — which is what `test/node/rist-librist.test.ts` does, both directions, byte for byte.

**Bound through a C FFI (`koffi`), not a compiled addon.** librist's API is 72 flat C symbols and its data plane is pollable — `rist_sender_data_write` in, `rist_receiver_data_read2` out — so nothing on the hot path needs a C→JS callback. That means no node-gyp, no compiler at install, and no per-Node-version ABI matrix: koffi ships its own prebuilds for every platform node-av covers. The fork's own source stays TypeScript, which is the property that made a native build unattractive in the first place.

**Configuration goes through `rist_parse_address2`, so no struct is laid out here.** It takes a `rist://` URL with query parameters and fills `rist_peer_config` itself — `?secret=…&aes-type=256` is how main-profile PSK is set, with no field written from JavaScript. That matters because `rist_peer_config` is at `RIST_PEER_CONFIG_VERSION 6` and has grown across librist releases; a layout written against one header silently corrupts the next. Only `rist_data_block` is declared, and its size is asserted at load (72 bytes on LP64) so a library built from a different header fails loudly instead of reading shifted fields.

**The blocking read is called asynchronously.** `rist_receiver_data_read2` blocks for its whole timeout, so a synchronous FFI call would hold the event loop for it; koffi's `.async` form runs it on a worker thread.

Three things that cost time and are not in any document:

- **Both ends must agree on the profile.** `ristsender` and `ristreceiver` default to **main**. A simple-profile sender against them logs `Non conformant main profile packet received` and delivers nothing — the same shape as SRT's `transtype` trap, and it reads as a plain delivery failure. The interop test asserts on that log line, not just on the byte count.
- **RIST occupies two UDP ports**, `port` for RTP and `port + 1` for RTCP. A test helper bound on `port + 1` steals the RTCP channel and the handshake never completes; the first version of the harness did exactly that and the symptom was RTCP sender reports arriving where media was expected.
- **`ristsender --help` exits 1.** Both tools print usage and return non-zero, so an exit-code presence probe reports them absent and skips the whole file silently. Presence is tested by `ENOENT`, not by exit code.

**Stats, and the counters that depend on them.** `retransmittedPackets` is librist's to report, through `rist_stats_callback_set`. Three things about that path, all measured rather than read:

- It **works from librist's own thread**. koffi's docs say a callback from a secondary thread is queued to the main loop but do not cover a foreign library's thread; it fired 18 times over two seconds at a 200 ms interval with no crash.
- The callback **must** call `rist_stats_free(container)`. librist frees the container only when no callback is set (`src/stats.c`: `if (cb) cb(...); else rist_stats_free(...)`), so with one registered, ownership passes to the callback and skipping it leaks the JSON string, the peers array and the container every interval. The header's "the json char pointer must be free()'d" understates it — `free()` on that pointer alone leaves the rest.
- Read `stats_json` by declaring the field as koffi's `str`, which converts it. `koffi.decode(pointer, 'str')` on a `void *` field **segfaults** (exit 139), and that was a usage error of mine, not a librist fault. The counters are also in the struct's union, but the JSON is version-tagged (`schema_version`) while the union's layout is not, so the JSON is the safer read — the same reason nothing here lays out `rist_peer_config`.

One hazard to size the interval against: a koffi callback that returns a value blocks the calling thread until the JS event loop services it, and librist raises stats while holding `stats_lock`. So a blocked or saturated event loop stalls librist's stats thread with that lock held. Keep the interval coarse and never make a synchronous librist call that could want that lock from the main thread.

**librist comes from the system**: `brew install librist` or `apt install librist4`, with `MEDIABUNNY_LIBRIST` to point at a specific build. It is not bundled, and that is a deliberate open question rather than a finished decision — bundling would mean shipping gnutls, nettle, gmp, cjson and lz4 per platform, and gnutls is LGPL, so it is a redistribution question and not only a build one. librist itself is BSD-2-Clause.

### `RistTarget` over librist

Ships as `@ahmedrowaihi/mediabunny-rist`. Cuts the output into 1316-byte payloads, hands them to librist, and accumulates librist's counters. librist owns the wire: sequencing, the retransmit buffer, the sockets, the handshake, encryption and rate control.

**Not interchangeable with `@mediabunny/server`'s `RistTarget`.** There is no `maxQueueBytes`, `onOverflow` or `queuedBytes`, because librist owns the send queue and exposes no depth for it; what it declines to send is `skippedPackets`. Pacing is `bandwidthKbps` plus librist's congestion control, not the stream's PCR. `retransmitBufferMs` becomes librist's `buffer` URL parameter. Everything librist is told travels in the `rist://` URL it parses itself — nothing here lays out a `rist_peer_config`.

Three things that bite:

- librist's stats are per-interval **deltas**, not running totals, so the counters accumulate. The latest report alone reads as a keepalive interval.
- librist has **no drain call**, so a close waits `DRAIN_GRACE_MS` before destroying the context or the trailing partial payload is lost at any size. Bounded, not a guarantee.
- The entry exports only `RistTarget` and `RistTargetOptions`. api-extractor cannot roll up an export whose type is `@internal` — `Internal Error: Unable to analyze the export "getLibrist"` — so the binding and `peerUrl` are reached by source path, tests included.

`koffi` is `packages: 'external'` in the bundle: it resolves a platform-specific native addon at runtime. The first publish had to be by hand with `npm login`, since OIDC cannot publish a name npm has never seen; `NEEDS_FIRST_PUBLISH_BY_HAND` exists for that and is empty again.

**EAP-SRP does not work, so there is no `auth` option** — one that silently fails to authenticate is worse than none. `test/node/rist-librist.test.ts` carries it skipped: credentials belong in the URL, not a `rist_enable_eap_srp` call, and with them the receiver authenticates one peer and then waits forever on the data peer. `RistSource` is the read side, a `ReadableStreamSource` over librist's own de-jitter buffer, NACKs and reordering — so `bufferMs` is its only recovery knob and there is no `nackIntervalMs`. A payload is copied before its block is freed, because `payloadOf` reads librist's buffer, and reads run in 250 ms slices because a librist read blocks for its whole timeout: that is the granularity at which cancellation and the silence deadline are noticed, not a latency bound. Both halves resolve their options into one `ResolvedPeer` and share `peer-url.ts`.

**A `secret` is refused on simple profile.** Simple profile accepts one and logs `Using 256 bits secret key` on both ends, but does not enforce it — measured, a receiver holding a *different* secret still received the stream, where the same mismatch under main profile delivers nothing. It therefore throws rather than reading as protection it does not provide.

**The main-profile GRE tunnel is exposed** as `tunnel: true` plus `sendTunnelPacket`/`readTunnelPacket` on both classes, refused on simple profile because librist refuses to enable it there. **Both return codes in `oob.h` are wrong about their own implementation:** `rist_oob_write` returns **0 on success** (it forwards `rist_oob_enqueue`, which does) and 0 *also* means "no oob peer, dropped" when no peer is passed — so the peer handle is required and a short-write check on bytes is meaningless. `rist_oob_read` forwards `rist_oob_dequeue_rx`, which returns **>=1 when it hands over a packet** and 0 when the queue is empty. Reading either as the header documents makes a working tunnel look dead.

**Constructing either class opens the librist context eagerly** — a `WritableStream`/`ReadableStream` `start` callback runs on construction — so option validation happens before any librist call, and a test must not construct one to assert that an option is *accepted*. Ubuntu's packaged `librist4` rejects URL parameters that 0.2.20 accepts, which surfaces as `librist could not parse <url> as a peer address`; the accepting cases are therefore asserted on `checkPeerOptions`, not on a constructor.

**EAP-SRP is not exposed**, because it does not complete and an option that silently fails to authenticate is worse than none; `test/node/rist-librist.test.ts` carries it skipped with the measurement. Read against librist 0.2.20's source, the reason is librist's and not this binding's: the authentication gate is per peer (`rist-common.c:4006`), `eap_clone_ctx` gives a peer discovered later a context with no authentication state (`eap.c:1164`), and the clone site starts EAP only for a multicast receiver (`rist-common.c:3718`). The authenticatee's own start has already run on the peer that existed when the credentials were set, so the data peer never initiates and the gate drops its traffic for the session. No option passed from here reaches that.

`RistSource` is the read side, a `ReadableStreamSource` over librist's own de-jitter buffer, NACKs and reordering — so `bufferMs` is its only recovery knob and there is no `nackIntervalMs`. A payload is copied before its block is freed, because `payloadOf` reads librist's buffer, and reads run in 250 ms slices because a librist read blocks for its whole timeout: that is the granularity at which cancellation and the silence deadline are noticed, not a latency bound. Both halves resolve their options into one `ResolvedPeer` and share `peer-url.ts`.

**A `secret` is refused on simple profile.** Simple profile accepts one and logs `Using 256 bits secret key` on both ends, but does not enforce it — measured, a receiver holding a *different* secret still received the stream, where the same mismatch under main profile delivers nothing. It therefore throws rather than reading as protection it does not provide.

**Neither class exposes the main-profile GRE tunnel or EAP-SRP**, because neither works through this binding, and an option that silently carries nothing is worse than none. Both are carried as skipped tests with their measurements.

The tunnel's binding is in place and its `rist_oob_block` is confirmed at 32 bytes, but `rist_oob_write` returns **0 bytes written** — not the `-1` the header documents for an error — in both directions, with and without the peer handle, on contexts whose media path works. librist's own tools reach the tunnel only through a TUN device, which needs root, so there is no CLI control for it either.

## Live RTMP output — `RtmpTarget`

`@mediabunny/server` exports `RtmpTarget`, the counterpart to `RtmpSource`. RTMP carries FLV, which this library does not mux, so the target takes the **fragmented MP4** an `Output` writes and remuxes it through node-av: `Demuxer.open(readable, { format: 'mp4' })` into `Muxer.open(url, { format: 'flv' })`, which is `RtmpSource`'s pipeline inverted. `new Mp4OutputFormat({ fastStart: 'fragmented' })` is required — its empty `moov` is what lets the stream be read before it ends, where a non-fragmented file writes its `moov` only on finalize. The connection opens on the first write, and a server dropping the publish ends the stream rather than erroring, since libavformat reports a closed socket as `EIO`.

Two things a publish over FLV **cannot** preserve, which a test asserting otherwise would be lying about. A live publish loses both ends: the listener is not accepting for the very first fragment, and a `Conversion` closes its own output while the receiver is still reading — 113 of 125 packets arrived in the measured case. And **FLV timestamps are integer milliseconds on a timeline ffmpeg restarts at zero**, so the absolute values shift; the measured offset was 21 ms, with only the first sorted sample off the resulting grid because the publish begins mid-fragment. What does survive, and what `test/node/rtmp-target.test.ts` asserts, is the shape: no duplicates, the source's own frame interval from the second sample on, and a span matching the frame count.

There is no write-timeout option. `rw_timeout` is not an option the flv muxer takes — it fails loudly rather than silently — and rtmp ignores URL query options, so the connect and the writes are bounded by the protocol. Better no knob than one that does nothing.

**`readPrivatePesPayloads` returns only complete payloads.** It never read `PES_packet_length`, so a PES the buffer cut short came back looking whole, with its PTS set and nothing to say it was partial — a 354-byte DVB subtitle PES cut after its first TS packet returned 170 bytes. That is not an edge case for a live reader: one scanning a sliding window cuts the last PES every time, so it decoded half a subtitle on most passes. DVB subtitles end with a 0xFF marker a caller could check; teletext has no marker at all, which is what makes a short payload indistinguishable from a whole one.

A PES is now emitted once its stated `PES_packet_length` has arrived, trimmed to that length, or — where the field is 0 and the packet is unbounded — once the next `payload_unit_start_indicator` on the PID ends it. A packet still open when the buffer runs out is **left out** rather than returned with a flag: a flag would have to be checked to be worth anything, and not checking it is exactly the bug. The consequence, documented on the function: in a stream whose private PES state length 0, the final packet is never returned, because nothing says it ended.

`test/node/mpeg-ts-private-streams.test.ts` cuts the fixture at every TS packet boundary on the PID and requires what survives to be a byte-for-byte prefix of the whole read — so the packets before the cut are untouched and the cut one is absent, not short — and asserts the cuts actually dropped something, or the test would prove nothing. The unbounded case zeroes every `PES_packet_length` on the PID and gets one payload fewer, since the last has no next unit start. Both fail against the old reader.

## `prefer-software` picks a software encoder

`getSoftwareEncoderCodec` resolved through `NodeAv.Codec.findEncoder(codecId)`, which returns FFmpeg's **default** encoder for a codec id — not a software one. On node-av's linux-arm64 prebuild the default for AVC is `h264_rkmpp`, a Rockchip wrapper, so `hardwareAcceleration: 'prefer-software'` chose a hardware encoder on any arm64 Linux box, Graviton included, and on a machine with no Rockchip silicon at all. It then threw `Encoder 'h264_rkmpp' cannot be used for quantizer-based encoding` on the next option it was given, which is how it surfaced; a bitrate request would have run on a device that was not there. The upstream line is deliberately gone, replaced rather than deleted.

The default is still tried first, so every build whose default is already software keeps the encoder it had and nothing changes on macOS or x86. Only when that default classifies as hardware does the selection fall through to named software encoders — libx264, libx265, libvpx, libsvtav1 and their alternates — and if none is built in it returns null rather than the hardware default, because `prefer-software` asked for the CPU and a caller is better told there is none than handed a device encoder.

**Classification is by capability, with a stated exception.** Checked against FFmpeg's own sources rather than assumed: rkmpp, v4l2m2m, nvenc and vaapi set `AV_CODEC_CAP_HARDWARE`, and qsv sets `AV_CODEC_CAP_HYBRID` — so a capability test covers five of the six and anything new that flags itself. **videotoolbox sets neither**: it is identifiable only by `wrapper_name`, which node-av does not expose, so it and a handful of others (mediacodec, amf, mf, omx) are matched by name suffix. That list is the exception to the rule, not the rule.

**A hardware encoder that will not open falls back to software.** `prefer-hardware` is a preference, and a build can carry a device encoder for a device that is not there — node-av's linux-arm64 prebuild carries `h264_rkmpp` on every arm64 machine. Whether the device exists is only known from opening it, so an open failure on a hardware codec now re-opens with a software one instead of throwing. A codec the caller named outright is not second-guessed, and a software encoder's own open failure is reported as its own.

That turned up a second defect: the `Encoding 'avc' with ...` line was logged at **selection**, before anything was opened, so after a fallback it named an encoder that never ran — and that line is what a caller reads to find out what encoded its video. It is stated again with the encoder actually used.

Proven by A/B rather than by reading: with every hardware open forced to fail, a `prefer-hardware` conversion completes, and with the fallback bypassed the same forced failure rejects with the open error.

`test/node/encoder-selection.test.ts` asserts the invariant for every video codec — the software selection never yields a codec the classifier calls hardware — and checks the classifier against the real hardware encoders in this build, failing if there were none to check so the hardware half cannot go untested. It cannot fail on macOS or x86, though, because the default there is already libx264 — so on its own it would not have caught this. **Fork CI runs it on a native arm64 runner** (`ubuntu-24.04-arm`, GA since August 2025 and free and unlimited on a public repository), which is where the default is `h264_rkmpp` and the invariant has something to catch. No QEMU and no second full suite: the job installs, prints which encoder FFmpeg defaults to on that build, and runs the encoder-selection tests alone, in seconds.

That cheapness is why encoder choice lives in `packages/server/src/encoder-choice.ts` rather than in `misc.ts` beside its siblings. `misc.ts` imports the package entry for its options, and the entry imports `@mediabunny/prores`, which the test config aliases to a **built** bundle — so a test touching either needed `npm run build` first, which is how the first version of this job failed. The classification and the selection need nothing but node-av and a type, so they sit at a leaf and the job stays a `npm ci` and a few seconds. Verified by hiding that bundle and running the file against it. The deletion guard reads that move as upstream lines leaving `video-encoder.ts`, since it works per file; they are declared on that basis — the ProRes `prores_ks` preference is intact, in `encoder-choice.ts`. The print is unconditional, because which encoder the build defaults to is the fact the whole job exists for and a future failure is unreadable without it.

## Broadcast transport settings — `MpegTsOutputFormat`

A delivery to a cable, satellite or ASI path states the stream's identity rather than taking the muxer's
defaults, and takes a constant bit rate. `MpegTsOutputFormatOptions` now carries the settings
MediaConvert's and MediaLive's `M2tsSettings` do:

| option | default | what it states |
| --- | --- | --- |
| `programNumber` | 1 | the PAT's and PMT's `program_number` |
| `transportStreamId` | 1 | the PAT's `transport_stream_id` |
| `pmtPid` | 0x1000 | the PID the PMT is carried on |
| `pcrPid` | the first video track's PID | the PMT's `PCR_PID`, and where the PCR is carried |
| `trackPids` | 0x0100 upwards | each track's PID, in the order tracks were added |
| `patInterval` / `pmtInterval` | `tableRepeatInterval` | seconds between repeats of each table alone |
| `pcrInterval` | 0.04 | seconds between PCRs, at most the 0.1 13818-1 2.7.2 allows |
| `service` | none | a DVB `service_descriptor` in an SDT, which a receiver shows as the channel |
| `sdtInterval` | 0.5 | seconds between SDT repeats |
| `muxRate` | none | bits per second, making the stream constant bit rate |

The PAT is now built rather than kept as one constant section, since its `transport_stream_id`,
`program_number` and `program_map_PID` are all the caller's — which is why the deletion guard records
upstream's `PAT_SECTION` lines here. The bytes it writes for the defaults are the same ones.

**Every interval is in seconds**, including the three new ones, where MediaConvert states its
`patInterval` and `pcrPeriod` in milliseconds. Mixing the two units in one options object is a
foot-gun, and `tableRepeatInterval` was already seconds.

**PID collisions are refused by name.** The tracks' PIDs are only known once the tracks arrive, so the
check runs where the tables are first written and names which of the PAT, PMT, SDT, a track, a private
stream or the cue stream already holds the PID.

**A PCR-only packet repeats the continuity counter.** 13818-1 2.4.3.3: the counter increments only on a
packet carrying a payload, and one without repeats the previous packet's value. The muxer's counter map
used to hold the value to write *next*, so an adaptation-only packet consumed the increment and the
payload packet after it repeated — which a receiver reads as **two** errors on a clean programme, an
increment on a packet with no payload and then a repeat on one with. Measured on a 50-frame AVC + AAC
programme with no SCTE-35 at all: `PID 256 ... 12 -> 13` on the PCR-only packet, then `13 -> 13` on the
next payload packet. TR 101 290 reports it as a continuity error, and a relay following the counters
across a failover reports them as running on. The map now holds what was last written, which is why the
deletion guard records upstream's `this.continuityCounters.set(pid, (cc + 1) & 0x0F)` and the
`if (hasPayload)` around it: the increment still happens, one packet later and only for a payload.

**A `pcrPid` naming no track gets PCR-only packets**, which is the only way such a stream has a clock at
all — an adaptation field of 183 bytes with the PCR flag and no payload, written at `pcrInterval`. The
same path fills a gap where the PCR *track* goes quiet. They are stamped one interval past the last PCR
rather than from the interleave's current position: only video states a decode timeline, so taking an
audio packet's presentation time would put a PCR ahead of a video decode time still to be written, and a
PCR that goes backwards is worse than one that is late. Measured — stamping from the interleave position
widened the worst PCR gap on `demo.mp4` from under 0.1 s to 0.156 s, which
`test/node/mpeg-ts-matrix.test.ts` catches.

**`muxRate` makes the stream constant bit rate.** Null packets on PID 0x1fff fill whatever the media does
not, and every PCR is then stamped from the byte position it sits at — `round(packetIndex × 188 × 8 ×
27e6 / muxRate)` in 27 MHz ticks, extension included, where the variable-rate path writes a 90 kHz base
and a zero extension. That is what makes the stream's clock and its rate agree: measured over a 5 Mb/s
`demo.mp4`, every consecutive PCR pair differs from the bytes between them by at most 0.8 of a 27 MHz
tick, and the file's size over the span of media it carries is 4 999 993 bits per second.

The byte clock is measured from the stream's **own first media time**, not from zero: AAC priming starts
a track 21 ms below zero, and anchoring at zero leaves the clock that far behind the media for the whole
file — 0.83% under the stated rate on the same measurement. The tail is padded to the end of the media
for the same reason. Note that `ffprobe`'s `format=duration` is **not** that span, since it drops both the
priming and the tail past the last video frame; the test takes the span from the per-stream
`start_time` and `duration` instead.

Media that needs more than the rate is **refused**, naming the time it ran out and the rate it would have
needed. A burst may run half a second ahead, which is what lets a key frame through. A full T-STD buffer
model (13818-1 Annex D) is **not** simulated, so a stream that passes here can still fail a conformance
checker's buffer analysis — that is stated on the option rather than implied by its presence.

`test/node/mpeg-ts-tables.test.ts` scans every packet of the stream for a counter that moves without a
payload, and states the rule directly as well: a PCR-only packet carries the packet before it, and the
next packet that carries a payload carries one more. Both halves are asserted against a count, since a
stream with no adaptation-only packets would pass either of them while proving nothing — and the clock
can be due twice over, so they run in groups and the packet after one is not always a payload packet. It
also runs the whole matrix — H.264 and HEVC, 1 s and 10 s — and reads
everything back with `ffprobe` or out of the 188-byte packets, never with this library's own demuxer. AC-3
is deliberately absent: the transport settings read no elementary stream, so the codec is not a variable
they depend on.

## PAT and PMT repeat — `tableRepeatInterval`

The tables were written once, at the head of the stream. A receiver that joins a stream already running — a multicast listener, a restarted SRT receiver, a relay switching inputs — never sees them and so can never find the program. They now repeat every **0.1 s** of stream time by default, which is broadcast practice; ETSI TR 101 290 1.3 and 1.5 treat a gap over 0.5 s in either table as an error. `tableRepeatInterval` sets the period, and `Infinity` restores the write-once behaviour.

The period is measured on the stream's own timeline rather than wall clock, and a repeat is placed in front of a key frame when one falls at least halfway into the period — a joining receiver starts decoding at a key frame, so the tables are worth most immediately before it. Each repeat continues its PID's continuity counter, since a receiver reads any other step as a lost packet.

`test/node/mpeg-ts-tables.test.ts` measures the gaps **on the PCR**, not on packet positions, because that is the clock a receiver has: each table is dated by the last PCR before it, which is the worst case a joining receiver sees. Over ten seconds the worst PAT and PMT gap is inside 0.14 s against a 0.1 s period, the counters step by exactly one on both PIDs, and every PMT carries the SCTE-35 PID with its `CUEI` descriptor rather than only the first. The test that matters most cuts a one-second slice out of the middle and reads it with libavformat — a reader that is not this library's own — and finds the stream; all five fail with the repeat removed.

## Live SRT output — `SrtTarget`

`@mediabunny/server` exports `SrtTarget`, the output counterpart to `NetworkSource`: an `Output` writes to an SRT receiver the way it writes to a file. A byte sink, carrying whatever the format writes — for a live feed, `MpegTsOutputFormat`. It extends `AppendOnlyStreamTarget`, so all it supplies is a `WritableStream` over a libav IO context. Calls out by default, listens with `?mode=listener`, opens the socket on the first flush so constructing one never blocks, and bounds every wait with `connectTimeout`. `passphrase` with `keyLength` 128/192/256 maps to SRT's `passphrase`/`pbkeylen`; `latency` is taken in milliseconds and written as the microseconds libsrt expects. Any query parameter the caller sets is kept.

**It drops rather than blocking.** Pushing back on a slow receiver would stall the muxer for as long as the receiver was behind, which on a live feed is unbounded. A write queues and returns; a pump drains it. Once `maxQueueBytes` (2 MiB default) is held, *arriving* bytes are dropped — not queued ones, so a receiver sees a gap rather than reordered data — and counted in `droppedBytes`/`droppedDatagrams`. `droppedBytes` is what this target discarded; it is not a count of what failed to arrive. A dead peer stops the bytes and surfaces as an error on close, which is where a caller reconnects by building a new `Output`.

What SRT itself does not promise, and a caller has to plan around: `transtype=live` is latency-bounded and discards rather than retransmitting past its window, so delivery is lossy by design — use `transtype=file` where every byte must arrive. **Both ends must agree on `transtype`**, or the handshake fails with a bare `EIO`. And a receiver can lose what is still buffered when the sender closes, since ffmpeg's SRT read reports EOF on a broken connection rather than draining first.

One trap for anyone else writing a libsrt sender here: **live mode defaults `SRTO_LINGER` to 0**, so closing discards the send buffer — the handshake succeeds, every write succeeds, and the receiver gets `EIO` with zero bytes. The target sets `linger` explicitly.

**Writing already-muxed bytes: `TargetWriter`.** An `Output` is how a container is *produced*; `TargetWriter(target)` is how one that already exists is carried — a transport stream being relayed, a file copied through. `write(bytes)` appends, `flush()` is where backpressure lands (as on an `Output`'s own path), and `close()` flushes then finalizes, which is where a draining target drains. Writes are append-only and the container's correctness is the caller's: nothing here parses what passes, so a target needing seeks cannot be written this way. It stakes the same claim on the target an `Output`'s `Writer` does, so a target driven by both throws whichever comes second — an `Output` takes its writer when it starts, so that is where it finds the target already claimed. Headroom is visible before anything is dropped through `SrtTarget.queuedBytes` against `maxQueueBytes`, rather than only afterwards through `droppedBytes`.

A relay that needs the bytes a source received, rather than demuxed tracks, uses `Source.readRange(start, end)` — public, a copy per call, and refusing a short read rather than returning one. Reading forward a datagram at a time is the pattern `ReadableStreamSource`'s cache is sized for, and `maxCacheSize` bounds how far back a re-read may reach. No byte-stream API of its own is needed, and `test/node/srt-target.test.ts` checks the bytes come back identical to what `SrtTarget` sent.

**Disposing a listener with no receiver wakes the accept**, the same way `NetworkSource` and `RtmpSource` do and for the same reason: a parked accept outlives a close and cannot be interrupted, so `finish()` dials the listener's own URL to satisfy it. Without it, closing waits out the whole `connectTimeout`.

Covered by `test/node/srt-target.test.ts`, which reads while the sender is still connected and closes afterwards, so no assertion rests on a post-close drain. No long-running soak: that measurement is the owner's to drive, not something to put on a schedule.

### Secrets never reach a message

A URL is the only way to give FFmpeg a protocol secret: `avio_open2` takes no options dictionary, and a protocol's private options do not exist until it has resolved the URL. So `SrtTarget` and `NetworkSource` build a URL holding the passphrase and must keep it out of everything that is thrown or printed. `redactUrl` does that for their own messages, and `registerMediabunnyServer` takes FFmpeg's log callback to do it for `Connection to %s failed`, which prints the whole URL at `AV_LOG_ERROR` from C where a host cannot reach it. The callback replaces FFmpeg's own printing, so the line is written on unchanged apart from the secrets. libsrt's own lines go straight to stderr rather than through `av_log`, and carry the rejection reason but never the passphrase.

`NetworkSource` takes `passphrase`/`keyLength` as options rather than needing them written into the URL, validated as `SrtTarget`'s are. A passphrase on a non-`srt://` URL is refused at construction.

**The redaction is installed by every class that can carry a secret, not only by `registerMediabunnyServer`.** It lived only in the registration at first, so a host that constructed an `SrtTarget` or a `NetworkSource` without registering the server still got FFmpeg's unredacted line — found by a consumer, not by the suite. `installSecretRedactingLog()` is idempotent and called from both constructors as well. Covered by two tests that reset the installation first, so whatever redacts afterwards can only have been installed by the constructor. Note the two redactors differ in form: a thrown message goes through `redactUrl`, which percent-encodes via `URLSearchParams` (`passphrase=%5Bredacted%5D`), while FFmpeg's log line is redacted as text (`passphrase=[redacted]`).

**Cancelling a RIST read waits for the parked librist call before destroying.** `rist_receiver_data_read2` parks on the receiver's own condition variable, and koffi runs it on a libuv threadpool thread. `cancel()` called `rist_destroy` straight away, which frees that condition variable under the parked waiter; the thread then wakes into freed memory and the process dies — `EXC_BAD_ACCESS` in `_pthread_cond_updateval`, with `rist_receiver_data_read2` and `K::AsyncCall::HandleExecute` below it. It needs the destroy to land inside the timed wait, so it only bites under load, and it was found in a **macOS crash report** from a consumer's suite rather than by any test here.

`cancel()` now awaits the slice in flight and then destroys. The wait is bounded by `READ_SLICE_MS`, which is why reads are sliced at all. `RistTarget` does not have this: `rist_sender_data_write` is called synchronously, never on a threadpool thread, so a destroy cannot race it from JS.

`test/node/rist-cancel-ordering.test.ts` **stubs librist** rather than loading it, and asserts the order of `read:start`, `read:end` and `destroy` directly — without the fix it records `['read:start', 'destroy']`, a destroy between a read's start and its end, which is the use-after-free in one line. A first version opened a real receiver and asserted the elapsed time instead; it passed here and failed on CI, whose librist rejected the same URL as an unparseable peer address. The race needs no socket to describe, and a stub says it on every machine.

**A failed `open2` now closes its `IOContext`.** Both `NetworkSource` and `SrtTarget` built a context, and on a refusal threw without closing it — the assignment to `this.io` is the line after the throw — so the native handle was left for the GC to finalize whenever it liked. SRT refusals arrive in bursts, because a caller retries, so a run with a passphrase mismatch dropped a context per attempt. `throwFailedOpen` in `misc.ts` closes it and raises the error, and it is one owner for the message both classes used to carry a copy of. Measured before changing anything: `closep()` on a context whose `open2` failed is safe, over 40 refusals against a real listener returning `KMREQ BADSECRET`.

**This was not shown to fix any crash.** It was found while hunting an intermittent SIGSEGV a consumer sees under full-suite load, and it is a real defect on exactly the path their log is full of — but 150 leaked contexts against a dead port and 40 against a live wrong-passphrase listener, both with forced GC, did not reproduce a crash here. Treat it as one candidate removed, not as the cause.

**Only the main thread installs the callback, because FFmpeg's is one process-wide slot.** `logRedactionInstalled` is module state, so each worker thread has its own copy and a worker that registered the server package installed its own callback into the single slot. When that worker exited the slot was left owned by an environment that no longer existed, and the next thread to touch it died on **SIGABRT with no JS error** — the whole process, not the thread. Found by a consumer whose media workers each import the module that registers, including workers that never encode.

Measured, with node-av alone and no mediabunny in the way: the crash needs a callback installed on a worker that has exited *and* the main thread touching the slot afterwards. Neither alone does it, and no log line is involved — the survivors saw zero log lines, so this is not a dangling callback being *called*, it is the slot being replaced. A worker's lines still reach the main thread's callback, verified with a worker-emitted line carrying a passphrase, so restricting the install to the main thread costs no redaction. `test/node/server-extension.test.ts` holds the three cases a consumer asked for: one worker, two in turn, and one exiting mid-encode.

**Passing the secret as an AVOption instead of in the URL is not available.** It would be the better fix — no URL FFmpeg logs would hold it, callback or not — but `IOContext.open2(url, flags)` takes no options dictionary, verified against the type rather than assumed, and a protocol's private options do not exist until it has resolved the URL. So the URL stays the only channel and redaction stays the mechanism.

**A bad passphrase is not distinguishable, and is not claimed to be.** Measured across both ends: a secret mismatch, a caller with a secret against a listener without one, the reverse, and nothing listening at all all return the same `-5` to the caller and `-60` to the listener. libsrt knows — it logs `Incorrect passphrase` and `ERROR:BADSECRET` — but writes that to stderr itself rather than through `av_log`, so it cannot be read in process. The error therefore names the passphrase as something to check when one is configured, and does not diagnose it.

## AVC-Intra and XAVC in MOV, on the read side

An AVC-Intra or XAVC MOV — what cameras, Avid and MediaConvert hand around — opens as an `avc` track. The sample entries are `ai5p`, `ai5q`, `ai52`, `ai53`, `ai55`, `ai56` for AVC-Intra 50, `ai1p`, `ai1q`, `ai12`, `ai13`, `ai15`, `ai16` for 100, plus `aivx` for XAVC 10-bit 4:2:2 and `AVin` for the variant with implicit parameter sets. The names encode the class together with the raster and the scan type, which is why the 50 and 100 families differ by more than a number: AVC-Intra 50 is 4:2:0 on a subsampled raster (1440x1080, 960x720) and 100 is 4:2:2 at full raster.

**These are not a retag of `avc1`.** They carry no `avcC` at all and their samples are Annex B with the parameter sets in band — a file retagged from an `avc1` source without converting the samples is unreadable, and ffmpeg says `No start code is found`. Recognising them therefore needs nothing else: the demuxer's existing "`avc` with no description" path already reads the configuration record off the first packet, as the Matroska demuxer does for the same reason. The codec string comes out `avc3.…`, because in band is where the parameter sets are.

**They are written as well, for QuickTime output only.** A `MovOutputFormat` track whose bitstream is AVC-Intra gets the matching entry, no `avcC`, and Annex B samples with the parameter sets in band — all three together, since any one alone produces a file nothing can read. **MP4, CMAF, HLS and DASH output is untouched**, and that scoping is measured rather than chosen: ffmpeg writes `ai12` for `-f mov` and `avc1` with an `avcC` for `-f mp4` from the same essence, so these entries are a QuickTime convention and not an ISOBMFF one.

Selection follows ffmpeg, because ffmpeg's own mov muxer picks these itself and **overrides a caller-supplied `-tag:v`** — asking it for `avc1` on a 1080p25 High 4:2:2 Intra stream still writes `ai12`. `avcIntraSampleEntry` keys on the same things: the intra profile (`profile_idc` 110 or 122 with `constraint_set3_flag`), the chroma format, the **display** raster and the frame rate. Display, not coded: H.264 codes 1080 as 1088 — seventeen macroblock rows — and crops it, so keying on `codedHeight` matches nothing at 1080.

**The mapping and the carriage are tested separately, and that split is forced.** Which code *within a family* ffmpeg picks depends on the frame rate its muxer had at the time, and a raw elementary stream carries none — `-r` does not pin it down identically across builds. Measured: CI's ffmpeg picks `ai12` for a 24 fps fixture this machine's picks `ai13` for, and labels a long-GOP stream AVC-Intra where this machine's does not. Those are facts about an x264 build, not about either library, and four releases went red before that was clear. So `test/node/avc-intra-entry.test.ts` tests the table on synthetic SPS info — all twelve codes including the four interlaced ones no fixture here can produce, the NTSC rates, and every rejection — while the fixture test checks the family, which the bitstream does carry, and the carriage, which is the substance.

Two details that decide whether the output is byte-exact:

- **An Annex B source passes through untouched.** Splitting and re-joining the NAL units would re-frame every start code to four bytes, and x264 emits three-byte codes for the units after the first, so a round trip would stop matching the essence ffmpeg wrote. The suite holds our MOV to ffmpeg's **per-packet CRC32** for five classes, which is what caught this.
- **A length-prefixed source is converted the other way**, with the parameter sets spliced from the `avcC` into each key frame, since the entry has nowhere else to keep them.

HDR static metadata is not spliced into these samples: `spliceNalUnitBeforeVcl` walks length-prefixed NAL units and would corrupt Annex B. The `mdcv`/`clli` boxes still state the grade; only the in-bitstream copy is left out.

The shape alone is not enough, and the suite has the control: an ordinary long-GOP High 4:2:2 stream at 1080p25 must **not** be labelled AVC-Intra, and is not — ffmpeg reaches the same judgement on the same file independently. A mutation that ignores `constraint_set3_flag` is what showed that control was missing.

**ffmpeg chooses the four-character code itself, and overrides an explicit `-tag:v`.** Measured: asking for `avc1` on a 1080p25 High 4:2:2 Intra stream still writes `ai12`; so does asking for `ai53` or `AVin`. The selection keys on the intra profile together with the chroma format, raster and frame rate, and it matches FFmpeg's own tag table. So the suite's fixtures ask for no tag at all — what ffmpeg picks *is* the expectation — and eight of the twelve codes are reached that way (`ai12`, `ai13`, `ai1q`, `ai1p` at 4:2:2; `ai52`, `ai53`, `ai5q`, `ai5p` at 4:2:0). The interlaced codes and `AVin`/`aivx`, which ffmpeg will not write, have the four bytes patched into the `stsd` instead — the same length, so nothing else moves.

One trap in building such a fixture: `h264_mp4toannexb` only does its job on a length-prefixed source, so encoding straight to the tag yields misaligned samples that ffmpeg's own decoder rejects with `deblocking_filter_idc 27 out of range`. It takes two passes — encode to `avc1`, then copy through the filter. Beyond the dimensions and codec, the suite holds the packets to ffprobe's **per-packet CRC32**, so "the same essence bytes" is decoder-independent.

## MPEG-2 video — `mpeg2`

`'mpeg2'` is a video codec of this fork: encodable through `@mediabunny/server`, writable to MPEG-TS, MP4, MOV and Matroska, readable back out of all four. It is what broadcast contribution and legacy playout still take, and what an MPEG-TS programme of stream type `0x02` carries.

**The codec string is the object type indication, and it is the chroma knob.** 14496-1 gives MPEG-2 video one `mp4v` object type per profile of 13818-2, so `mp4v.61` is Main Profile at 4:2:0 and `mp4v.65` is 4:2:2 Profile — the same relationship a ProRes four-character code has to its chroma format, and asked for the same way, through `fullCodecString`. A `Conversion` derives the string and therefore gets Main; `VideoSampleSource` takes it and can ask for either. `buildVideoCodecString` states no profile or level beyond that, because both live in the bitstream's own sequence extension and neither follows from a target bitrate.

**A fixed chroma format now outranks the 4:2:0 default, not just the encoder's ordering.** `choosePixelFormat` consulted the chroma format only where 4:2:0 was unsupported, which is why it worked for ProRes — whose formats are 10- and 12-bit only — and did nothing for MPEG-2, where `yuv420p` is advertised first and matches the incoming depth. Measured: before the change, `mp4v.65` produced **byte-identical** output to `mp4v.61`. ProRes output is unchanged, because for it the two paths agree.

**The level is a bound the encoder derives, not something the profile fixes.** Measured against the ffmpeg CLI on 4:2:2 Profile: level code 5 (Main) for 640x360p25 and 2 (High) for 1920x1080p50. High Level therefore arrives on its own for high-rate content, and pinning it would state a bound the stream does not need. Nothing in the suite asserts a constant for it; it asserts the ordering between two rasters.

Four things the encoder needs that no other codec here does:

- **A frame-duration time base.** MPEG-2 derives its `frame_rate_code` from the codec context's time base and validates it against 13818-2 table 6-4, so the microsecond base every other codec runs on is refused outright: `MPEG-1/2 does not support 1000000/1 fps`, and `open2` returns `EINVAL`. For `mpeg2` alone the context takes `1/framerate`, and timestamps convert at the boundary — frames in, packets, duration and the decode time out. Every other codec keeps microseconds, where the conversion is the identity.
- **Scene change detection off for a closed GOP.** `AV_CODEC_FLAG_CLOSED_GOP` alone makes `open2` return `AVERROR_PATCHWELCOME`; ffmpeg's CLI says why where the library does not — `closed gop with scene change detection are not supported yet, set threshold to 1000000000`. Detection has nothing to decide here anyway, since every key frame is one the caller forced. The flag is bit 31, so it is or-ed as unsigned: a plain `|` hands FFmpeg a negative int.
- **A GOP length MPEG-2 allows.** 600 is the maximum; the `2 ** 30` the other codecs use is reduced to it by FFmpeg with a warning on every encode.
- **One picture per access unit on the read side.** 13818-2 6.2.2: an access unit begins at a sequence header, a GOP header or a picture header, whichever comes first, and the picture's extensions, user data and slices follow it. Nothing else delimits it — there are no NAL units and no access unit delimiter.

**MPEG-2 must not take the Annex B path through the MPEG-TS muxer.** That path prepends an access unit delimiter, and for anything that is not AVC it prepended HEVC's — `00 00 01 46 01`, whose code byte reads as slice 70 of a 23-row picture. ffmpeg: `slice below image (69 >= 23)`, on every frame but the first. **Our own demuxer read the file back without complaint**, split the access units correctly and reported 125 packets; only ffmpeg's decoder called it corrupt. That is why the suite decodes every file with ffmpeg and captures stderr, rather than trusting a round trip through this library.

**The programme is shifted by one frame, and that is correct.** MPEG-2 states a one-frame reorder delay whether or not it uses B-frames, so the first packet's decode time is `-1/framerate` and the MPEG-TS muxer shifts the whole programme to keep it from going below zero (see *MPEG-TS: when the programme is shifted*). The key frames still land on the key-frame grid — one second apart for `keyFrameInterval: 1` — measured from the first packet, not from zero.

On the read side, `m2v1` is QuickTime's own MPEG-2 sample entry and carries no `esds`, which is what ffmpeg writes for `-f mov`; MP4 uses the generic `mp4v` visual entry, and the object type indication in its `esds` is the only thing that tells MPEG-2 video from MPEG-4 Part 2 — so `mp4v` alone sets no codec and the `esds` decides. Nothing is kept out of band either way: the sequence header and its extension ride in the stream ahead of every closed GOP, which is also where the dimensions, profile and chroma format are read from.

**The profile in the codec string comes from the first packet, not from the container.** `getCodecParameterString()` on a 4:2:2 track returns `mp4v.65` in all four containers, because `extractVideoCodecString` takes an `Mpeg2CodecInfo` read off the stream — the same first-packet probe ProRes and AV1 already use. The container cannot answer it: `m2v1` and `V_MPEG2` carry no box for the profile, MPEG-TS carries no sample entry at all, and an `esds` only repeats what a writer claimed. 13818-2 8.2 signals 4:2:2 Profile with the escape bit and a profile field of 0 (`0x85` at Main Level, `0x82` at High), and Main with profile field 4 (`0x48`). Measured: libavcodec writes Main for `mp4v.60` and `mp4v.64` as well, so Main and 4:2:2 are the only two profiles reachable and the only two this derives.

## Overlay codecs with alpha — `qtrle` and `png`

A motion-graphics overlay is delivered as a `.mov`, and MediaConvert's motion image inserter takes
nothing else. The two codecs it comes in are **QuickTime Animation** (`rle ` sample entry) and
**PNG in MOV** (`png `), and neither was recognised: `getCodec()` returned `null`, `canDecode()`
false, and a `VideoSampleSink` threw `VideoDecoder is not available in this environment`. Both are now
in `VideoCodec`, read by the ISO BMFF demuxer and decoded through FFmpeg in `@mediabunny/server`, with
the alpha channel kept.

**The sample entry's depth field is the configuration.** Neither entry carries a codec-specific box,
and the FFmpeg decoders for both take their pixel format from `bits_per_coded_sample` rather than from
the bitstream — without it `open2` returns `Invalid data found when processing input` for QuickTime RLE.
That number is the sample entry's `depth`, which the demuxer had been skipping over; it now reads it and
carries it on the decoder config as `VideoDecoderConfigWithHdr.bitsPerCodedSample`, which is also how
the muxer knows to write `depth = 32` when such a track is copied. The ProRes 4444 alpha path is
unchanged, since its four-character code states alpha on its own, and `CustomVideoDecoder.config` is now
typed `VideoDecoderConfigWithHdr` so a custom decoder sees what the container stated.

Neither can be **encoded**: `CODEC_BIT_DEPTHS` lists none for either, and asking for a codec string by
target bitrate throws by name rather than falling through to a generic unhandled-codec error. A track in
one of them can still be copied, and `videoCodecToBoxName` writes the matching entry back.

`test/node/alpha-video.test.ts` reads each fixture to the end and compares frame 0 to ffmpeg's own
decode of the same file, byte for byte, after asserting the synthesised colour `(255, 0, 0, 128±1)`
directly — a control that made the same mistake would otherwise agree. Half of 255 is not an integer,
which is where the ±1 comes from. VP9 alpha is asserted the same way but against no ffmpeg control:
measured, `ffmpeg -i transparency.webm -pix_fmt rgba` yields alpha 255 for every pixel, because its
Matroska demuxer drops the block-addition stream VP9 carries alpha in. Every case also asserts that the
alpha channel is not uniformly opaque, which is the failure the file exists for. Fixtures are built by
`scripts/build-alpha-overlay-fixtures.py`.

## MXF OP1a delivery — `MxfTarget`

`@mediabunny/server` exports `MxfTarget`, which writes **MXF OP1a** — the operational pattern broadcast delivery specifications are written against, AS-11 (UK DPP) among them. MXF is not muxed by this library: the target takes the **fragmented MP4** an `Output` writes and remuxes it through FFmpeg's `mxf` muxer, so the file is OP1a by construction rather than by a hand-written KLV layer. `new Mp4OutputFormat({ fastStart: 'fragmented' })` is required, as for `RtmpTarget` and for the same reason. Node only, and it writes to a path rather than a stream, because the footer partition and index tables need a seekable file.

Options are `startTimecode` (`hh:mm:ss:ff`, or `;` for drop frame), `signalStandard` and `storeUserComments`. Audio is **one stream per channel** — add an audio track per channel to the `Output` and each becomes its own MXF track.

Three things measured rather than assumed, each of which cost a wrong first attempt:

- **No bitstream filters are needed.** FFmpeg's CLI reports inserting `h264_mp4toannexb` and `pcm_rechunk` for an `mp4` to `mxf` remux, so the first version ran both by hand. Comparing output byte for byte with and without them: the video essence is Annex B either way (the first video packet begins `00 00 00 01 06 05`) and the audio packets are the same size, because libavformat's `mxf` muxer inserts what it needs itself. The CLI's message describes a CLI-level mechanism, not a gap in the library API. Roughly 60 lines of filter plumbing were deleted once a mutation showed removing them changed nothing.
- **The edit rate comes from `rFrameRate`, not `avgFrameRate`.** `addStream` copies the input's average, and over a short or trimmed fragmented MP4 that is a ratio like 300/13, which the muxer refuses outright: `Unsupported frame rate 300/13`. **ffmpeg's own CLI fails identically on the same file**, so taking the base rate is the truth rather than a workaround.
- **MXF carries frame-wrapped PCM, never AAC.** The muxer's own refusal is a bare `Invalid argument` — again, ffmpeg's CLI fails the same way — so non-PCM audio is refused by name at the point it is noticed, pointing at `audio: { codec: 'pcm-s24' }`.

**B-frames do not belong in it.** A reordered stream remuxes into MXF with non-monotonic DTS, and ffmpeg's CLI reproduces that on the same input. OP1a delivery is all-intra — AVC-Intra is the point — so the suite's fixture is all-intra and that is the shape to use.

**Determinism needs `bitexact`, and the dates are a separate knob.** A consumer saw two MXF writes differ once under load and read it as FFmpeg stamping the wall clock into the Preface's `LastModifiedDate` and each Identification set's `ModificationDate`. Measured, that is not what differs: pinning those dates leaves the files differing at their **UMIDs**, and `bitexact` is what suppresses those. `creationTime` pins the dates independently — epoch by default, a `Date` for a real delivery date, `null` for the wall clock — which matters when `bitexact` is off, since it leaves the dates stable while the UMIDs still vary.

The other half is not the muxer at all: **two runs have to mux the same essence.** Encoding twice and comparing measures the encoder, which varies run to run; muxing one encode twice across a second boundary is byte-identical with `bitexact` and differs at the UMIDs without it. Both are tests now, and the second is the one that separates the writer from everything upstream of it.

**`bitexact` makes two writes identical.** MXF is the one container here where the same input does not give the same file: `mxfenc` draws the UMIDs at random, so two runs differ in those bytes while the essence repeats exactly. `bitexact: true` sets FFmpeg's `fflags=+bitexact`, which fixes them and drops the version strings, and the file stays a conformant OP1a with its timecode. The suite asserts both directions — identical with the flag, **different without it** — so the flag is demonstrably what does the work.

`bmx` conformance (`mxf2raw --info`) is not run here: the tools are not installed and installing them is the owner's call. ffprobe's `format_name=mxf`, the OP1a operational pattern UL, the timecode tag and a clean decode of every stream — with **stderr** captured, since `execFileSync` returns stdout and ffmpeg complains on stderr, which made an earlier version of these assertions vacuous — are what `test/node/mxf-target.test.ts` holds it to.

### The video descriptor's `BitRate`

`MxfTargetOptions.videoBitRate` states the MPEG-2 video descriptor's `BitRate` in bits per second,
which RDD 9 wants set to the rung's nominal rate — 50000000 for XDCAM HD422. Left unset, the
descriptor carries the rate the input stated, which for a trimmed or short programme is the average
measured over what was written rather than any nominal one.

**It was already being written, and `ffprobe` cannot see it.** Reported as missing on the strength of
`ffprobe -show_streams` giving `bit_rate=N/A`, but `mxfenc` writes local tag `0x8000` of the MPEG-2
video descriptor unconditionally from the output stream's `bit_rate`, and FFmpeg's `mxf` **demuxer**
never reads that tag — `bit_rate` in `mxfdec.c` appears only as the container-level rate used for
seeking. Measured: a file this target wrote before the option existed already carried `0x8000 =
3221380`, the rate its input's `btrt` stated, while ffprobe reported `N/A`; `ffmpeg -i in.mp4 -c copy
out.mxf` reports `N/A` too, with and without `-b:v 50000000`. `test/node/mxf-target.test.ts` therefore
reads the descriptor out of the KLV, asserts the stated rate against the carried one as its control,
and asserts that ffprobe still says `N/A` so the next reader does not chase the same thing.

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

**The remux muxer is closed when the publish ends, or the tail is lost.** A fragmented muxer holds the fragment it is building until a flush point, so every packet after the last one sits inside the muxer when the publisher goes away — it is not in the socket and not in the reader. Leaving it unclosed silently truncated **every** stream by up to a fragment: measured on `scene-cut-50fps.mp4`, 575 of 600 packets at the default half-second fragment, which is exactly 25 frames at 50 fps. `RtmpTarget` closes its muxer in a `finally` and was unaffected, which is why the loss looked direction-specific. The close happens inside the pump, before the stream is ended, so the sink still enqueues what the trailer writes.

Covered three ways in `test/node/rtmp-input.test.ts`, all of which read **to the end of the stream** rather than to a fixed count — a test that stops at *n* packets cannot see a lost tail, which is why the existing ones did not: a complete publish delivers the file's own packet count; a publisher that vanishes mid-stream with no trailer delivers exactly what it wrote (300 of 300); and the packets are compared to the source's by SHA-1, in order, so they are the publisher's bytes rather than merely the right number of them. Timestamps are checked against the source's frame grid instead of its values, because FLV carries them as integer milliseconds on a timeline restarting at zero.

One boundary is left as it is: when the **silence clock** ends a stalled stream, it closes the controller before the pump unwinds, so that pending fragment is dropped rather than flushed. Flushing there would mean reaching the muxer from a timer that races the pump's own `writePacket`, and a stalled publisher's half fragment is worth less than that risk.

**Options are real AVOptions, not URL query.** rtmp parses its path as `app/playpath` and ignores the query entirely, which is why `NetworkSource`'s approach cannot work here and why this is a separate class. node-av's `Demuxer` accepts an options dictionary, so the bounds travel there:

| bound | option | unit | note |
|---|---|---|---|
| accept a publisher | `timeout` | **seconds** | listener only — it *implies* `listen`, so a caller given it tries to bind |
| silent read | `rw_timeout` | **microseconds** | the read outlasts it by a multiple, measured 2-3x |

Both were measured rather than read off the option names. `timeout=2` fails at 2.13 s and `timeout=6` at 6.16 s, which is what fixes the unit — one value cannot. For the read bound, a publisher frozen with `SIGSTOP` so the socket stays open and goes quiet ends at 6.26 s for `rw_timeout=3000000` and 12.32 s for `6000000`, and never without it.

**`readTimeout` reaches `rw_timeout` unscaled, and silence is also timed in JS.** `rw_timeout` bounds a single read rather than the session, and FFmpeg resumes mid-packet after it fires instead of ending the stream — the FLV demuxer reports that as a packet mismatch and packets are lost silently. Scaling the value down therefore destroys data: a stall shorter than `readTimeout` gets cut mid-packet. Scaling it up only makes an ended stream slower to notice, because the pump unwinds on FFmpeg's schedule, so the end arrives a small multiple of the bound after the publisher stops however short the JS clock is.

`readTimeout` also drives a JS clock that ends the stream between fragments, where the demuxer is whole. The clock starts at the first byte, not at open: waiting for a publisher is the connect bound's business, and timing that as silence ends the stream before it starts.

`connectTimeout` governs listening only, and that is a protocol constraint rather than an oversight. Passing rtmp's `timeout` to a caller rewrites the connection as `tcp://host:port?listen&listen_timeout=…`, so the caller tries to bind and fails instantly with `Can't assign requested address`. A caller's connect is bounded by the protocol instead: an unreachable, non-routable address fails in about five seconds whatever `connectTimeout` says.

**The remux's `movflags` carry `delay_moov`.** Without it the mov muxer writes its header before it has
seen a packet, so every track's first fragment is given a `baseMediaDecodeTime` of zero and the A/V offset
across that fragment is lost — measured on `demo.mp4` published over RTMP, audio arrives level with the
video where the source has it 21 ms ahead, and only that one fragment is wrong. The cost is that the init
goes out once the first packet of each stream has arrived rather than immediately.

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
- **`scaling_list_data()` is walked, not refused** — shaka's `H265Parser` gives up on SPS/PPS scaling list data; this fork walks it so such streams can be encrypted (see above).
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

Two more declared deletions are test bounds too: `bad-inputs.test.ts`'s `MP4: Single chunk with many samples` and `MP4: Fragments with decreasing timestamps` carry 60 s where upstream takes vitest's 5 s default. Measured across six CI runs of the same tree: 887 ms, 1326 ms, 2568 ms, 2869 ms, 7755 ms and 15647 ms — a 17x spread on a loaded arm64 runner, where an A/B of the same two tests on an unloaded machine gave 506 ms against 517 ms either side of the change being blamed. The last two of those reds blocked a release whose diff provably did not touch them. What the tests catch is **quadratic** behaviour, which shows up as orders of magnitude rather than as a doubling, so a 60 s bound still fails on the regression they exist for while surviving a slow runner.

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
are counted, so dropping a second copy of an already-declared line still shows up.

**`--update` refuses to record a line upstream's own history calls part of a fix.** It used to record
whatever was currently missing with no per-line justification, which left the hole the whole check exists
to close: a rebase that drops a fix plus an `--update` in the same session converts the loss into
"declared", and the next reviewer sees a green gate. It now blames each newly missing line against
upstream's current file and refuses, by name and with the commit subject, any line whose commit subject is
fix-shaped. Verified by deleting upstream's `closeOnce` (`#618`) and running it: both the check and
`--update` fail, naming the fix, and the inventory is left untouched. `--force` records anyway, for a line
the fork means to replace — say why in this file when you use it.

It matches on the commit subject, so a **feature** commit whose subject happens to mention a fix trips it
too: replacing the MPEG-TS PID assignment was refused because the commit that introduced the muxer is
titled "Add MPEG-TS muxer, fix a demuxer bug, …". That is the intended cost — the check cannot tell which
part of a multi-purpose commit a line came from, so it asks rather than guesses, and the answer goes in
this file before `--force`.

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

## An ESM-only dependency breaks the CommonJS bundle

`@mediabunny/server`'s declared `require` entry could not be loaded at all: the bundle is built with
`packages: 'external'`, which externalises every dependency, and `turbores` — reached through the ProRes
decoder the server registers — states no `require` condition in its `exports`. The CJS bundle therefore
emitted `__require("turbores")`, and every CommonJS consumer got
`ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined` before any of its own code ran. The ESM entry
was unaffected, which is why nothing caught it.

`turbores` carries no native addon, so it is inlined instead of externalised; `node-av` stays external
because it does carry one, and inlining it would break the platform-specific binary resolution it does
for itself. The server bundle's externals are now stated as a list rather than `packages: 'external'`.
`server-extension.test.ts` requires the built CJS bundle in a child process, because every other test
reaches this package through the ESM entry and so cannot see a broken `require`.

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

So the push run waits 8 minutes, promotes if it can, and otherwise exits green with a `notice` naming what is missing (`--if-complete`). A red publish run therefore means a publish was rejected, which is worth looking at.

Catching up a release npm served late is **not** on a timer. Two things cover it:

- **Every publish run first promotes whatever `pending` has become complete since** (the `Catch up the tags on the last complete release` step, `continue-on-error`). So the next release fixes the previous stranded one with no intervention.
- **A `workflow_dispatch` with `promote_version` set** moves the tags onto an already-published version without publishing a new one. This is the deliberate path for a release that must not wait for the next push.

There is no `schedule` trigger: it spent a runner every tick to discover there was nothing to do, and the catch-up step plus a dispatch covers the same ground. **Anything that moves a dist-tag has to live in `publish-fork.yml`,** though — npm's trusted publisher is configured per workflow *file*, so a separate file has no credential and `npm dist-tag add` fails with a bare exit 1, and nothing in this repo can grant it, since that is a setting on npmjs.com. It was tried as `promote-pending.yml` first and that is exactly how it failed. Holding the runner for the observed lag is worse still: it idles a job for half an hour and loses to the 1590-second case anyway.

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
- **Finishing a stranded release.** A run can go green without moving `beta`: the tag only advances once npm *serves* every package, and a package can take hours. Do **not** re-run the run to fix this — the base version is read from `upstream/main` at run time, so a re-run after upstream has released publishes a *different* version instead of promoting the stranded one. That happened to `1.62.0-beta.154`: a re-run four days later built `1.62.1-beta.154` and left `beta` where it was. Instead dispatch the workflow with `promote_version` set to the stranded version; it skips publishing and only moves the tag. The next ordinary release also picks it up by itself.

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

## Where this fork's behaviour differs from upstream

Everything else is additive. These are the places upstream and the fork do the same job differently,
and each is a consequence of a feature stated above rather than a preference.

**Sample entry, `avcType` and `hevcType` follow the bitstream, not the codec string.** Upstream derives
`hvc1` / `hev1` and `avc1` / `avc3` by searching the encoder config's codec string, and in
`isobmff-boxes.ts` always writes `hvc1` because some Apple players refuse `hev1`. That string is
frequently one the library invented — `buildVideoCodecString` names a fixed fourcc whenever the caller
stated none, which `_codecStringIsDerived` marks — so the fork reads `avc.format` / `hevc.format`
instead, which state where the parameter sets actually went; the string is consulted only for a config
the caller supplied whole. A manifest then never advertises a codec the file is not.

**A fragment's reported start is on the timeline the file states.** `tfdt`'s `baseMediaDecodeTime` is
unsigned, so a fragmented track that begins before zero is shifted onto a timeline starting there, and
`onMoof` reports that shifted time rather than the one the caller handed in. A manifest built from it
would otherwise name times the file does not contain. A fragment that states no `tfdt` continues from
the preceding fragment's decode end, not its presentation end, since composition offsets part the two.

**MPEG-TS repeats its PAT and PMT.** Upstream writes them once at the head of the stream. The fork
re-emits them on `patInterval` / `pmtInterval`, which is what lets a receiver that joins mid-stream
acquire the programme at all, so a leading pair is never the only one in the file.

**A frame shorter than its own header declares is not supplied.** `supplyPacket` takes the length the
frame header states, not the number of bytes that happen to be buffered, for AAC, MP3/MP2, AC-3, E-AC-3
and DTS alike. A live feed that stops inside a frame has no later byte coming to complete it, and the
decoders reject the fragment that did arrive, so the MPEG-TS demuxer withholds it instead of ending
every truncated stream with a throw.

**A transformed sample keeps its colour unless it landed in RGB.** A transformer that filters the frame
and stays in YUV carries the source's colour through, so reporting it unknown would understate what it
produced. Landing in RGB means the colour describes whatever conversion the rasteriser chose rather than
the content, and half a colour space — a filter graph keeps transfer and matrix while losing primaries —
mislabels an encode as PQ. Both the transformer path and the canvas path apply that one rule, through a
single `isRgbFormat` predicate rather than the format list written out at each site.

**The server bundle inlines `@mediabunny/prores`.** The package ships no CommonJS build; its `require`
condition names the `.mjs`, so requiring it from the CJS bundle loads a second copy of Mediabunny.
`turbores` is inlined with it, being ESM-only and otherwise left as an unresolvable `__require`.

**A custom encoder's `flush()` is awaited.** Upstream calls it with `void`. A buffering encoder emits
every remaining packet from `flush`, so a throw out of it is the only report the caller would get.

**`readFragment` takes the fragment the walker just read.** Upstream's takes only a position. The extra
argument lets a measured neighbour's end timestamp win over a lookup table's claim, which is what makes
a file with a wrong index still read correctly. Upstream's promise caching and its fix for trun reading
across skipped tracks are both kept.

**A quiet track does not hold a fragment or cluster open.** `closedTracks.has(track)` is kept as one
side of `|| quietTrackMayBeSkipped(...)`, so a track that has stopped supplying packets stops pinning
the interleaver.

**Subtitle flushing dispatches on the codec.** Upstream flushes WebVTT cues directly; the fork goes
through `flushSubtitleCues`, which also covers the TTML tracks it adds.

**`packages/server` pixel formats go through `choosePixelFormat`.** Upstream decides inline. The fork's
chooser takes bit depth, alpha and chroma format together, because the encoders it adds (ProRes, MPEG-2)
constrain all three. Upstream's ProRes 4444 case is expressed as `requestedBitDepth: 10` with
`chromaFormat: '444'`, since a ProRes fourcc carries no depth for `extractVideoBitDepth` to read.

**A transform copies its frame when it allocates it.** Upstream defers the copy into the filter-graph
`try`; the fork's graph comes from a cache, so the copy happens before the lookup. Upstream's
`AV_BUFFERSRC_FLAG_KEEP_REF` and its `encodeOptions` passthrough are both carried.

**ProRes tests fetch their sample once.** Upstream gives each ProRes test its own `UrlSource`; the fork
downloads the sample once and hands every test a `BufferSource` over the same bytes, so a full parallel
run makes one request rather than five. `UrlSource` is therefore unimported there.

**`MPEG_TS_TIMESCALE` is unused in the MPEG-TS muxer.** Upstream uses it for the monotonic clamp in its
reconstructed decode timeline; the fork carries the stated decode times instead, as described above.

**A variant's `CODECS` may list several strings of one kind.** Where they all infer to one codec the
strings differ only in profile or level, so the track reports the codec and no full string; where they
infer to different codecs, the segment is read to settle it. Carried from upstream 1.66.0, which needed
the track declaration to hold a resolved `codec` beside a nullable `fullCodecString` rather than
re-inferring the codec from a string the track may not have.

**Upstream's HLS tests are not carried.** `src/hls/hls-muxer.ts` and `src/hls/hls-demuxer.ts` are
rewritten outright, so upstream's tests for them encode decisions this fork made differently — its
target duration rounds to the nearest integer where upstream's expects a ceiling, for one. The fork's
own `hls-output.test.ts` and `hls-input.test.ts` cover this surface instead. What upstream's newer ones
cover and the fork's do not: undefined media groups, live playlist reloads, and object-based audio
channel counts.
