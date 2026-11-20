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

**Use the aliased form whenever you install any extension.** Every extension's published code imports the
core as `mediabunny`, so that is the name the core has to be installed under. A scoped-only install is
refused at install time (`ETARGET: No matching version found for mediabunny@<version>`), which is
deliberate — see "The exact peer range" below for what it used to do instead.

## Output side — write HLS, DASH, and HLS+DASH together

### HLS playlist generators (ported from shaka-packager)

shaka-packager's HLS playlist construction stack, as public API: `Tag`, `MediaPlaylist`,
`MasterPlaylist`, `BandwidthEstimator`, `SegmentInfoEntry`, `EncryptionInfoEntry`,
`DiscontinuityEntry`, `PlacementOpportunityEntry`, `ProgramDateTimeEntry`, `HlsPlaylistType`,
`HlsMediaPlaylistStreamType`, `HlsEncryptionMethod`, `HlsContainerType`, `HlsVideoInfo`,
`HlsAudioInfo`, `HlsAudioCodecSpecificData`, `HlsTextInfo`, `HlsMediaInfo`, `HlsCeaCaption`,
`HlsParams`, `adjustHlsVideoCodec`.

Covers variants and `EXT-X-MEDIA`, audio-only masters, peak-vs-average `BandwidthEstimator`,
`#EXT-X-SESSION-KEY` and per-segment `#EXT-X-KEY`, PROGRAM-DATE-TIME auto-injection through
out-of-order discontinuities, `#EXT-X-PLACEMENT-OPPORTUNITY`, I-frame-only streams, `VIDEO-RANGE`,
and the banner position shaka uses (after `#EXT-X-VERSION`), byte for byte.

Live: `timeShiftBufferDepth` trims a sliding window, advancing `#EXT-X-MEDIA-SEQUENCE` and
`#EXT-X-DISCONTINUITY-SEQUENCE` while preserving leading `#EXT-X-KEY`s;
`MediaPlaylist.getSegmentsToBeRemoved()` names what was dropped
(`preservedSegmentsOutsideLiveWindow`). Master: CEA caption renditions via `HlsCeaCaption`, and
rendition ordering by `HlsMediaInfo.index` (group-id fallback) matching shaka's
`is_default`/`is_autoselect` per `(group, language)`, with DVS and forced-subtitle handling.

shaka-packager is credited in `NOTICE` and `LICENSE.shaka-packager`.

### DASH MPD generator (ported from shaka-packager)

Public: `MpdBuilder`, `Period`, `AdaptationSet`, `Representation`, `XmlNode`,
`AdaptationSetXmlNode`, `RepresentationBaseXmlNode`, `RepresentationXmlNode`,
`addContentProtectionElements`, `getSegmentName`, `MpdParams`, `MpdOptions`, `SegmentInfo`,
`Clock as DashClock`, `Element`, `ContentProtectionElement`, and the whole `dash-mpd-utils` toolkit.
DRM: `cenc:pssh`, `mspr:pro`, `urn:mpeg:dash:mp4protection:2011`, PlayReady, Widevine, Marlin
content-ids, Microsoft PRO.

**One deviation from shaka:** `<BaseURL>` keeps `/` unencoded (everything else still per RFC 3986).
Shaka encodes path separators, which breaks segments served under nested directories.

**scte214 supplemental codecs** sit on `RepresentationBaseType`, so `mpdRepresentation` and
`mpdAdaptationSet` both take them and the parser reads them back. The `xmlns:scte214` declaration
follows from the prefix being used, so an MPD stating neither carries no trace of it.

### Content steering, on both sides

HLS: `#EXT-X-CONTENT-STEERING` via `HlsContentSteering` / `hlsContentSteering`, with `PATHWAY-ID` on
variants and `#EXT-X-MEDIA` renditions.

DASH: `MpdContentSteering` (`@defaultServiceLocation`, `@queryBeforeStart`, `@proxyServerURL`,
`@clientRequirement`), emitted where ISO/IEC 23009-1 puts it — after `InitializationPresentation`,
before the first `Period`. **`@serviceLocation` on `<BaseURL>` is the half that makes steering work**,
since a pathway is matched against it; without it the element is decorative. It is carried at every
level that can hold a `BaseURL`.

`baseURLs` is `MpdBaseURL[]`, not `string[]` — URL and attributes in one value. Two parallel lists
drift the moment anything rewrites one (`rebaseManifest` rewrote the strings and the attributes kept
the originals). DASH is fork-only, so no upstream API was reshaped; factories still accept plain
strings and `resolveBaseURL` takes either form.

Mediabunny emits and preserves steering; it does not fetch a steering manifest or switch pathways.

### Trick-play thumbnails, on both sides

**DASH.** A tile sheet is an `image` AdaptationSet whose Representation carries
`<EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="COLUMNSxROWS">`.
`mpdThumbnailTile` writes it, `readMpdThumbnailTile` reads a grid back and returns `null` rather than
throwing on a malformed one. Packagers also emit the scheme without the `guidelines` path segment, so
both are accepted on read and only the canonical one written — `THUMBNAIL_TILE_SCHEME_ID_URI` and
`THUMBNAIL_TILE_SCHEME_ID_URI_LEGACY`.

**HLS.** Three tags from the Image Media Playlist specification, which is not part of RFC 8216:
`#EXT-X-IMAGE-STREAM-INF` (`HlsImageStream`, kept apart from `iFrameStreams` so an image rendition is
never read as an I-frame one), `#EXT-X-IMAGES-ONLY`, and `#EXT-X-TILES` per segment (`HlsTiles`),
emitted between a segment's `#EXTINF` and its URI so it describes the image that follows.

`RESOLUTION` on `#EXT-X-IMAGE-STREAM-INF` is one tile's size, not the sheet's: multiply by `LAYOUT`.

### `AdaptiveOutputFormat` — HLS + DASH from one CMAF pass

Drives `HlsOutputFormat` and `DashOutputFormat` from a single CMAF encoder pass, sharing segments and
init segments, so storage stays near one-format output.

`separateRenditions: true` forces a lone video track and a lone audio track apart instead of muxing
them: an `#EXT-X-MEDIA` rendition group in HLS, its own `<AdaptationSet>` in DASH. A muxed variant
exercises none of a player's audio-track selection, and a 1:1 pairing cannot express the split through
`OutputTrackGroup` alone.

`singleFilePerPlaylist: true` backs both manifests with one CMAF file: HLS addresses it through
`#EXT-X-MAP` and `#EXT-X-BYTERANGE`, and the MPD is `isoff-on-demand` with a `<SegmentList>` carrying
`<Initialization range>` plus one `<SegmentURL mediaRange>` per subsegment, over the same ranges.
This is shaka's `use_segment_list` form, which needs no `sidx`.

`sidxFragmentCapacity` on a `fastStart: 'fragmented'` segment format instead reserves room after
`moov` for a Segment Index over every fragment, written at finalize and padded with `free`. The MPD
then carries `<SegmentBase indexRange>` — one range rather than thousands of `<SegmentURL>`s.
Overflowing the capacity, or leaving it unset, falls back to `<SegmentList>`.

### Parameter set placement

`VideoEncodingAdditionalOptions.parameterSets` selects where an AVC or HEVC bitstream carries its
parameter sets: `'outOfBand'` (default) keeps them in the sample entry, `'inBand'` repeats them
through the bitstream so a player can join mid-stream. The sample entry and the manifest `CODECS`
string follow the bitstream produced — `avc1`/`hvc1` out of band, `avc3`/`hev1` in band — so a
manifest never advertises a codec the file is not. Same rule on read: a demuxed `hvc1` track reports
`hvc1`.

`VideoTrackMetadata.parameterSets` carries the choice across a remux. Annex B packets keep their
parameter sets, so the muxer infers `'inBand'`; packets that repeat their sets *and* come with a
decoder config are byte-for-byte indistinguishable from packets that do not, so there the field is
the only signal. **Declaring `'outOfBand'` for Annex B moves them**: the sample entry already holds
them, and the Annex B transformation drops the sets and the access unit delimiter per sample. So an
MPEG-TS segment ingested from HLS remuxes to `avc1`/`hvc1` rather than `avc3`, which Safari's native
HLS may need. A caption SEI survives.

A **copy** can do this: `Conversion`'s `video.parameterSets` does not force a re-encode for an
Annex B source, since those samples are rewritten anyway. A length-prefixed source still re-encodes.
An access unit holding nothing but parameter sets is refused rather than written as a zero-byte
sample.

Left unstated, Annex B keeps its sets in band — the only answer that preserves a mid-stream
parameter-set change, which `avc1` cannot express.

### The selected encoder is named

The server encoder emits one `Logging` info line per track when it picks its codec — `Encoding 'avc'
with h264_videotoolbox.` — because which encoder ran decides byte-reproducibility (hardware encoders
are not deterministic, and a `Quality` routes to software while a numeric `bitrate` leaves hardware
eligible). The payload is `unknown[]`, the console-style args rather than a joined string, so join at
the boundary: `args.map(String).join(' ')`.

### Key frames from the server encoders

With `@mediabunny/server`, a video track's key frames are exactly the ones `keyFrameInterval` forces.
libx264, libx265, libvpx and SVT-AV1 add none of their own, from scene-cut detection or a fixed GOP.
A forced libx265 key frame is a closed-GOP IDR rather than a CRA followed by RASL pictures, so a
segment starting at any key frame decodes on its own. The frame rate given to the encoder is an exact
rational (24000/1001, not 24), so x265 signals it exactly.

### A ProRes profile's chroma format is not a preference

`ap4h` and `ap4x` are 4:4:4 by definition and are encoded that way with or without alpha. Discarding
alpha used to drop them to 4:2:2 under a 4:4:4 four-character code, because the pixel format came
from the encoder's first advertised format and `prores_ks` advertises 4:2:2 first.

`choosePixelFormat` takes the chroma format the profile fixes, and ProRes is the one codec here that
fixes one. The 4:2:2 profiles (`apco`, `apcs`, `apcn`, `apch`) are unchanged and are the control.
Through ffprobe: `ap4h`/`ap4x` give `yuv444p12le`, or `yuva444p12le` with alpha; the other four give
`yuv422p10le`.

Only the fallback path consults the chroma format. A codec that states a bit depth is served by the
ordered format tables, and ProRes states none — its four-character code fixes the depth too, which is
why `VIDEO_BIT_DEPTHS` lists nothing for it.

**`Conversion` cannot select a ProRes profile**: `fullCodecString` is a `VideoEncodingConfig` field,
not a `ConversionVideoOptions` one, so a conversion to ProRes always encodes `apch`. Another profile
means driving `VideoSampleSource` directly.

### Capped quality from the server encoders

`Quality` takes `maxBitrate` (and optionally `bufferSize`, default twice `maxBitrate`) alongside
`quality` or `quantizer`: capped CRF, known as QVBR in AWS Elemental encoders. Mapped to
`crf` + `maxrate` + `bufsize` on x264 and x265, `crf` + `maxrate` on SVT-AV1, constrained quality on
libvpx-vp9 and libaom-av1, `rc=vbr` + `cq` + `maxrate` on NVENC; rav1e has no such mode, and neither
does WebCodecs, where a `bitrate` fallback applies. Without `maxBitrate`, `Quality` is unchanged.

A quantizer without a cap is constant quality, as the option documents. x264, x265 and SVT-AV1 were
given `qp` and every crf-based encoder had its quantizer range pinned, making the uncapped path
fixed-QP: 2.33 MB against 0.99 MB for `test/public/video.mp4` at the same number on x264. They are now
put in constant-quality mode with the range left open, readable from x264's and x265's settings SEI
(`rc=crf`, `qpmin=0`). rav1e and NVENC keep fixed QP, having no verifiable constant-quality mode here.

A stated `bufferSize` **warns** rather than being dropped silently, for every encoder whose capped
mode has no buffer model — libvpx-vp9, libaom-av1 and NVENC. For libvpx-vp9 that is measured:
`rc_buffer_size`, `overshoot-pct`, `maxsection-pct` and `minsection-pct` each leave the output
byte-identical. SVT-AV1's `mbr`/`buf-sz` through `svtav1-params` is rejected: it replaces FFmpeg's own
rate control, and the worst 2 s window went from 1.17 of the cap to 5.06.

Encoders are given a frame rate even when the output track declares none — the first sample's
duration stands in. x265, SVT-AV1 and libvpx budget bits per frame from that rate rather than from
timestamps, so leaving it unset (as upstream does) told them 30 fps: about 1.4 to 2 times over the cap
at 50 fps, and short of it at 24 or 25.

### `preProcess`, and draining both hooks

`VideoTransformationOptions.preProcess` and `ConversionVideoOptions.preProcess` run on each decoded
sample **before** the size check, resize, rotation, crop and frame rate correction, where `process`
runs after all of them. Deinterlacing needs that position: run after a resize, it interpolates across
the two interleaved fields and the comb is baked in. It takes and returns what `process` does — a
sample, a resource, a `CanvasImageSource`, an array for a frame that becomes several, or `null` to
drop one. Setting it forces a transcode and bakes rotation into the samples.

`preProcessFlush` and `processFlush` take a function of no arguments returning `VideoSample[]`, called
once after the last frame has passed through their hook. A stateful hook needs it: a deinterlacer
emits frame N only once handed N+1, and a filter graph buffers. A caller cannot stand in by counting
frames — the count differs under frame rate conversion, a trim and field-coded input. Each drains
where its own output enters the pipeline, so `preProcessFlush` output is transformed, rate-corrected
and padded as per-frame output is, while `processFlush` output goes straight to the encoder after the
last padding frame. The samples must carry their own timestamps and are closed once encoded.

Conversion probes the encoder with one decoded sample to learn whether it accepts the format, and
that probe is built before the hooks are attached — so a caller demanding a colour space the source
lacks, which is exactly what a tone-mapping hook supplies, got `DeclaredColorSpaceMismatchError` out
of `Conversion.init` with the hook never called. The probe is **skipped** where `preProcess` is set:
the hook owns the frames' format, so a genuine refusal comes from the encoder.

### Decoders and encoders use every core, and filter graphs are reused

libavcodec defaults `thread_count` to 1; the ffmpeg CLI defaults it to 0, and that difference is most
of the decode time on large frames. Both decoder and encoder now set 0. On Big Buck Bunny 2160p30
(H.264 High L5.1, 9.3 Mbps, 20 s) decoding goes from 71 to 403 fps.

`transformVideoSample` built and freed a complete libavfilter graph per frame per rendition — 1809
graphs for a 20 s three-rung ladder. Graphs are cached, keyed by source format, dimensions, colour and
filter chain, which is what stays constant across a transcode. With the thread count, an x264 ladder
of 1080p/720p/480p from that 4K source goes from 37.6 s to 10.7 s.

The cache never makes a caller wait: a graph holds one frame at a time, so a second concurrent
transcode of the same shape builds its own rather than queueing. Reuse is sound only because every
filter this path builds (scale, crop, pad, transpose, hflip, setsar) is 1:1 and non-delaying; a
buffering filter would strand frames. A hardware encoder is unaffected by either change.

### ABR ladders decode once

`encodeVideoLadder({ track, rungs, keyFrameInterval, signal })` encodes one input video track into N
renditions, decoding once and fanning each frame out to every rung concurrently. On a 4-rung ladder
off a 1080p source (h264_videotoolbox) it is 2.4–2.9x faster than a `Conversion` per rung in a loop
and 1.2–1.7x faster than N parallel `Conversion`s, within 150 bytes of the same output.

The rungs are switchable by construction: every rendition gets the same `keyFrameInterval` (a rung
setting its own is refused with `InvalidUsageError`) and sees the same frames, so key frames land on
the same timestamps. `latencyMode` is forced to `'quality'` — a rung that drops a frame to hold its
bitrate falls out of step and the ladder stops being switchable. Audio belongs in its own `Output`.

Fanning one decoded frame out to several scaling encoders was broken before this: libavfilter's
`buffersrc_add_frame` unrefs the frame it is handed, and the transform path handed it the sample's own
`AVFrame`, so the first rendition's resize emptied it for every other (`Failed to create filter:
Invalid argument`, from a buffer source configured `video_size=0x0`). It pushes an `av_frame_ref` now.

### Segmented subtitles — WebVTT and TTML

`addSubtitleTrack` with a `webvtt` source produces a subtitle rendition in both manifests: an
`#EXT-X-MEDIA:TYPE=SUBTITLES` group referenced by `SUBTITLES=` on every HLS variant, and a
`contentType="text"` AdaptationSet in DASH. Segments are `.vtt` text with an `X-TIMESTAMP-MAP` header
anchoring cue times to the media timeline.

Subtitle segments are cut on the media segment boundaries, not a clock of their own, so a player can
switch renditions at any segment. A cue spanning a boundary is emitted in every segment it overlaps,
since a player joining mid-stream parses only what it fetched.

TTML rides in the media's segment format, since `stpp` is an ISOBMFF sample entry: ordinary
fragmented MP4, signalled `stpp` in HLS `CODECS` and `application/mp4` + `codecs="stpp"` in DASH. That
makes a TTML rendition addressable by byte ranges and so acceptable under `singleFilePerPlaylist`,
where a WebVTT one is refused because raw text cannot be. The refusal names the codec and the
alternative.

A forced track is signalled forced in both — `FORCED=YES` in HLS, and a `forced-subtitle` role on a
DASH AdaptationSet of its own, since sharing one with an ordinary subtitle of the same language leaves
a player unable to tell the representations apart.

WebVTT declares `webvtt` as its only codec and no video or audio capacity, so format deduction selects
it for a subtitle track and never for a media track. Single-file playlists declare a subtitle capacity
of zero, so a subtitle track is refused when added rather than when the output starts.

### Indexing a single file without predicting it

`segmentIndex` asks a fragmented ISOBMFF output for a top-level `sidx` without the caller stating the
fragment count — a number only the muxer can know. It reserves a ceiling, trims to the exact index at
finalize and leaves the remainder as `free`, so over-reserving costs nothing in the output.
`sidxFragmentCapacity` sets that ceiling, and asking for one implies the index.

A file that outgrows its reservation throws as the fragment that will not fit is written, not at
finalize, because that is the path a caller awaits.

### Chunked segments for low latency

`partDuration` writes each fragmented ISOBMFF segment as a run of `moof`/`mdat` fragments of about
that duration: Low-Latency HLS partial segments and Low-Latency DASH chunks. A part is cut before the
video sample (or, without video, the audio sample) that would take it past the duration, so no part
exceeds it, as LL-HLS requires of the Part Target Duration; the last part may be shorter. Only a
segment's first part is sure to start on a key frame; a later one is marked independent when it
happens to.

Each segment reports its parts through `HlsOutputSegmentInfo.parts` as
`SegmentPart { offset, size, duration, independent }`, in order, with offsets from the segment start,
so the parts' bytes concatenate to the segment's. It applies to VOD as well as live.

## Encryption side — write-side media encryption (ported from shaka-packager)

Pure-TypeScript media encryptors with no native dependencies: CENC for fragmented CMAF, WebM
Encryption, and HLS AES-128 / SAMPLE-AES.

**CMAF / fMP4 (CENC).** `encryptCmaf` (self-contained file, fragmented `moof`/`mdat` or progressive
`moov` sample table) and `encryptCmafInit` + `encryptCmafSegment` (split init and media segments).
Handles sample encryption, the `senc`/`saiz`/`saio`/`tenc`/`sinf` boxes and the `encv`/`enca`
sample-entry transform. Inserting those boxes moves the media, so **every index over it is restated**:
`trun` data offsets, `tfhd` base data offsets, `sidx` distances (front or chained, including
references spanning several fragments), `tfra` fragment offsets, and `stco`/`co64` for every track. A
track fragment holding several `trun` boxes has all of its runs encrypted. The split API takes an
`ivState` map carrying each track's IV sequence forward, so per-segment output matches whole-file
output byte for byte.

Schemes `cbcs`, `cenc`, `cens`, `cbc1`. Video H.264/H.265 (real NAL and slice-header parsing, including
multi-slice pictures), AV1 (tile subsamples), VP9 (uncompressed header); audio AAC/AC-3/E-AC-3
(whole-sample) and AC-4 (TOC and pattern). Exports: `encryptCmaf`, `encryptCmafInit`,
`encryptCmafSegment`, `EncryptCmafOptions`, `ProtectionScheme`.

On Node the CTR schemes run whole-block runs through `node:crypto` rather than the JS keystream, ~4x
on a 10 MB fragmented file (320 ms → 24 ms; the JS path, and so the browser, is ~92 ms). It is selected
per run: mid-block starts, partial trailing blocks and runs carrying past the low 64 bits of the
counter stay on JS, **since CENC wraps there where `node:crypto` carries**. Output is byte-identical
either way, and `node:crypto` reaches the browser bundle no more than `node:fs` does. Pattern mode is
unchanged: encrypting one block in ten makes a native cipher per block slower than the JS one.

**Refusing rather than appearing to work.** `encryptCmafSegment` refuses bytes holding no fragment — an
init segment passed by mistake, an `mdat` alone, 16 bytes of garbage — with `MalformedInputError`,
rather than returning its input unchanged and letting the caller publish clear bytes believing they
were protected. A `trun` naming sample bytes outside its own `mdat` is refused the same way. A video
sample entry carrying neither an `avcC` nor an `hvcC` raises `UnsupportedMediaError`; the codec is
decided by which configuration record is present rather than by a FourCC list, which is also what makes
`dvh1`/`dvhe`/`dvav`/`dva1` encrypt as the HEVC and AVC they are. An `ac-4` entry maps to AC-4 rather
than falling through to AAC, which would skip its TOC parse and pattern encryption.

**`checkSliceHeaders(segment, init)`** parses every H.264/H.265 slice header in a fragmented media
segment and throws `MalformedInputError` when a NAL unit, a slice header or the init's `avcC`/`hvcC`
does not read — no cipher, no output. Encryption must find the boundary between a slice header and its
slice data, so it already rejects media it cannot parse; a pipeline protecting a segment another way
wanted that check without running the encryptor and discarding the result. Tracks without slice headers
are skipped, so an init describing none is a no-op rather than an error.

**Length prefixes are not trusted.** A length-prefixed NAL unit may claim more bytes than the packet
holds — all-`0xFF` data claims 4 GiB — and the subsample generator sized its output from that, so a few
kilobytes of publisher-supplied segment produced megabytes of output. `iterateNalUnitsInLengthPrefixed`
never reports a NAL running past the end of its packet.

**MPEG-TS SAMPLE-AES.** `MpegTsOutputFormat` takes `sampleAesEncryption` (`key`, `iv`) and encrypts as
it muxes, which is what an `#EXT-X-KEY:METHOD=SAMPLE-AES` rendition needs. H.264 coded-slice NAL units
of type 1 and 5 longer than 48 bytes are encrypted from byte 32 in the 1-in-10 block pattern; AAC
frames after the ADTS header and a 16-byte clear leader. PES headers, ADTS headers, parameter sets and
the access unit delimiter stay clear, so the stream is still cut and indexed without the key. The PMT
signals it as Apple specifies: `stream_type` 0xDB for H.264 and 0xCF for AAC, a
`private_data_indicator_descriptor` carrying `'zavc'`/`'aacd'`, and for audio a
`registration_descriptor` carrying `'apad'` with an `audio_setup_information()` of `'zaac'`, priming,
version and the AudioSpecificConfig.

It encrypts **during** the mux because it cannot be a pass over finished bytes: encryption strips
emulation prevention, which changes NAL lengths, PES payload sizes and the packet count, so a
TS-in/TS-out function would have to repacketize the segment. Apple specifies no combination other than
H.264 and AAC, so anything else is refused with `UnsupportedMediaError` rather than written in the
clear.

`sampleAesEncryptAnnexBAccessUnit` and `sampleAesEncryptAdtsFrame` are exported for callers doing their
own framing. The Annex B one **re-applies start code emulation prevention** over the whole encrypted
NAL, as the spec requires: ciphertext containing `00 00 01` would otherwise read as a start code.
`sampleAesEncryptVideoNal` leaves its result stripped, which is right for length-prefixed CMAF and
wrong for anything scanning for start codes.

Reading it back is out of scope: 0xDB and 0xCF are not the clear stream types, so this library's
demuxer finds no decodable track in an encrypted stream rather than handing back ciphertext as media.

**`pssh` in the init.** `EncryptCmafOptions.pssh` takes complete boxes — from `buildWidevinePssh`,
`buildPlayReadyPssh` or `buildCommonPssh` — written into the init's `moov` after the traks, where
shaka-packager puts them. Opt-in, and output is byte-for-byte unchanged without it. They are added
before the index fix-ups, so a progressive file's chunk offsets are restated for the larger `moov`.

**Per-track keys.** `EncryptCmafOptions.trackKeys` maps a track ID to its own `key`/`kid`/`iv`. Given
one, it must name every encryptable track and no others, and a per-track IV must match the file's IV
length, since one size is declared file-wide; anything else throws rather than guessing. Each track's
`tenc` and sample encryptor are driven from its own material, so no keystream is shared.
`EncryptWebmOptions.trackKeys` mirrors it per EBML `TrackNumber`; a stated per-track IV must be the 8
bytes the encrypted-frame header carries, since WebM declares no IV size.

**WebM (AES-CTR).** `encryptWebm`, `encryptWebmInit`, `encryptWebmSegment`, `EncryptWebmOptions`. Adds
`ContentEncryption` per track and reframes each frame with the WebM signal byte and IV (subsample
partition offsets for VP9/AV1, whole-frame for audio); Xiph, EBML and fixed lacing handled. Same
`ivState` map as CMAF.

**HLS.** `encryptHlsAes128` — whole-segment AES-128-CBC with PKCS#7, container-agnostic — plus
`buildHlsAes128KeyTag`, `HlsAes128Options`, and the per-sample encryptors
`sampleAesEncryptAudioFrame` / `sampleAesEncryptVideoNal` with `SampleAesOptions`.

**Refusing what cannot be signalled.** A DRM system the HLS builders cannot express is refused by name
rather than omitted: FairPlay without a key URI, any other system without a PSSH, or a PlayReady PSSH
that will not parse. One unsignalable system fails the whole call — a playlist declaring two of three
key systems plays for most viewers, which is worse than one that refuses to build. FairPlay is absent
from the DASH descriptors, since none exists for it, and that is stated on the builder.

**Key rotation.** `EncryptCmafOptions.keyPeriods` maps a track ID to `{ key, kid, start, duration }`
periods in the track's media timescale, after CPIX's `ContentKeyPeriod`. Periods are stated by **decode
time rather than sample index**, so a segment can be encrypted knowing only itself. Each `traf` carries
`sgpd`(`seig`) and `sbgp` naming only the periods its samples draw on, with `tenc` the default, so a
fragment whose samples all belong to the default period is byte-identical to an unrotated one. The IV
sequence runs on across a key change rather than restarting — restarting would replay a keystream
wherever a later period reuses an earlier key.

**`pssh` in the fragments, for in-band rotation.** `CmafKeyPeriod.pssh` writes the same complete boxes
into every `moof` carrying a sample that period covers, which 23001-7 §8.1.1 allows. Without it a
player joining mid-stream has the init's header for the first period and no route to any later one. A
fragment rotating mid-way carries both periods' boxes in period order; tracks rotating under the same
header contribute one copy. The boxes go in **after the `traf`s and before the fragment's size delta is
taken**, so each `trun`'s `data_offset` and the `saio` chain are restated over the larger `moof` —
writing them any later silently shifts every sample. Stating none leaves the output unchanged.

**Clear lead.** `EncryptCmafOptions.clear` writes a segment with every sample unencrypted under an
otherwise unchanged encrypted init, which is how a presentation plays its first seconds before a
licence arrives. Each `traf` carries a `seig` group stating `is_protected = 0`, `Per_Sample_IV_Size = 0`
and a zero KID, and no `senc`/`saiz`/`saio` — **serving the plain fragment instead states nothing, so a
CDM tries to decrypt it**. The `mdat` is byte-identical to the input's, the IV sequence does not
advance, and `cmafEncryptedLayout` takes the same option. It applies to a whole segment, so there is no
per-track or per-period form, and a progressive file is refused by name, having no `traf`.

The reader side had to follow: the ISO BMFF demuxer read no sample groups, so a clear fragment under an
encrypted init was decrypted anyway wherever the scheme has a constant IV. It parses `sgpd`/`sbgp` of
grouping type `seig` in a `traf` and leaves a sample the group says is unprotected alone — applied once
the `traf` is read rather than at the `sbgp`, since a `trun` may follow the group boxes, and an index of
zero or one naming the sample table's own `sgpd` keeps the `tenc` default.

**Signalling and PSSH.** DASH: `buildContentProtections`, `buildCbcsContentProtections`,
`serializeContentProtection`, `patchMpdContentProtection`. HLS: `buildCbcsHlsKey`,
`patchMediaPlaylistKeys`. PSSH: `buildWidevinePssh`, `buildCommonPssh`, `buildPlayReadyPssh` /
`buildPlayReadyObject`, with `WIDEVINE_SYSTEM_ID`, `COMMON_SYSTEM_ID`, `PLAYREADY_SYSTEM_ID`,
`WIDEVINE_UUID`, `FAIRPLAY_UUID`, `CBCS_HLS_METHOD`, `DrmSystem`.

| Feature | Supported |
| --- | :---: |
| CMAF schemes — `cbcs`, `cenc`, `cens`, `cbc1` | ✅ |
| CMAF video — H.264, H.265, AV1, VP9 | ✅ |
| CMAF audio — AAC, AC-3, E-AC-3, AC-4 | ✅ |
| CMAF delivery — self-contained file + split init/segment | ✅ |
| CMAF layouts — fragmented and progressive | ✅ |
| Index restatement — `trun`, `tfhd`, `sidx`, `tfra`, `stco`/`co64` | ✅ |
| WebM Encryption (AES-CTR) | ✅ |
| WebM pattern schemes | n/a — WebM is CTR-only by spec |
| HLS AES-128, HLS SAMPLE-AES encryptors | ✅ |
| MPEG-TS SAMPLE-AES — full-file container remux | ❌ (mux-time only) |
| CENC on MPEG-TS | n/a — CENC is ISOBMFF-only by spec |
| DASH and HLS signalling | ✅ |
| PSSH — Widevine, W3C Common, PlayReady | ✅ |
| Subtitles / captions | ❌ (shaka excludes text) |

Verified against shaka-packager — AC-4 TOC against its compiled C++ output, VP9 against its parser unit
tests, AV1 across a full clip — plus AES against NIST SP 800-38a vectors, SAMPLE-AES against the hls.js
reference decrypt, and end-to-end in a browser CDM (ClearKey EME) for H.264, AV1 and VP9/WebM.

### Stating a protected segment's chunk ranges without encrypting it

`cmafEncryptedLayout(init, segment, options)` returns the `IsobmffChunkInfo` list the segment would
have *after* encryption, without running the cipher, so it equals
`chunksOf(encryptCmafSegment(init, segment, options), init)`.

A protected low-latency playlist must publish `EXT-X-PART` byte ranges as served, and encryption grows
each `moof` by its aux-info boxes: `senc` (16 + Σ(iv + 2 + 6·subsamples)), `saiz` (17, or 17 + S when
entries differ), `saio` (20), and `sgpd`/`sbgp` where a fragment's kid differs from the default. For
cenc video the subsample count per sample comes from the slice headers, so the growth is **not
closed-form** and an origin would otherwise encrypt every segment per playlist request to learn it.

It is not a second size formula: `SampleEncryptor.describeSample` is the one place subsamples and the
IV are decided for both paths, and the layout builds exactly the boxes the encryptor builds with the
cipher switched off, then measures those. The suite asserts the layout path never calls `crypt` on any
of the three cipher implementations, and that those spies do fire on a real encryption so the check is
not vacuous. The caller's `ivState` is read and never written.

## HDR / colour signaling (ported from shaka-packager)

Byte-domain readers and box builders for HDR metadata — no pixel processing.

**Dolby Vision.** `parseDoviConfigRecord` / `serializeDoviConfigRecord` read and write a
`dvcC`/`dvvC`/`dvwC` record (profile, level, RPU/EL/BL flags, base-layer compatibility id).
`doviConfigBoxName` picks the box the profile calls for (`dvcC` up to 7, `dvvC` for 8–10, `dvwC`
above). `doviSampleEntryFourCc` picks the sample entry — plain `hvc1`/`hev1`/`avc1`/`avc3` for a
cross-compatible base layer, `dvh1`/`dvhe`/`dva1`/`dvav` otherwise — while `doviSupplementalFourCc`
always gives the Dolby one, which is what a codec string names:
`doviCodecString(doviSupplementalFourCc('hevc', inBand), config)` is the `dvh1.08.02` for
`SUPPLEMENTAL-CODECS` and `scte214:supplementalCodecs`. `doviCompatibleBrand` derives the compatible
brand from the compatibility id and transfer characteristics. Also exported: `DoviConfig`.

**The RPU rides on the frame.** `VideoSample.dolbyVisionRpu` carries one frame's RPU as a complete
HEVC NAL unit — header and emulation-prevention bytes included, no start code or length prefix —
settable in the constructor or `setDolbyVisionRpu`, propagated by `clone()` and `transform()` like
`closedCaptions`. The server decoder wraps libavcodec's RPU side data, which arrives without the NAL
header; WebCodecs surfaces nothing of the kind. An encoder writes it back ahead of the frame's VCL NAL
units, after any in-band parameter sets, and `VideoTrackMetadata.dolbyVision` puts the configuration
record in the sample entry — the encoder itself knows nothing of Dolby Vision. A codec that cannot
carry one warns once and drops it rather than failing the encode, since an ABR ladder hands the same
sample to every rung.

Unlike captions, an RPU is **dropped unless the track declares the record**: RPUs with no record
describe nothing a player can act on, and a rung that was tone mapped would otherwise state the
source's RPUs over a different image. `ConversionVideoOptions.dolbyVision` declares it for a transcode
and is never inherited from the input — a rung is a different picture at a different resolution, so
its level is the caller's to state. A non-cross-compatible declaration is refused there, since profile
5's IPT-PQ-c2 base is not something an encoder produces.

**A non-compatible base layer states the Dolby codec.** `blSignalCompatibilityId` 0 (profile 5) means
the base layer is IPT-PQ-c2 and not decodable as plain HEVC or AVC, so `getCodecParameterString()` and
`getMimeType()` give `dvh1.05.NN` rather than the `hvc1.…` the sample entry suggests — a manifest
repeating the latter tells a non-DV player to decode IPT as HEVC. `getDecoderConfig().codec` keeps the
HEVC/AVC string, since that is what a decoder is handed.

**Dolby Vision survives a remux.** The MP4 demuxer reads the configuration box under any HEVC or AVC
sample entry — including `dvh1`, `dvhe`, `dva1`, `dvav`, resolved to plain HEVC/AVC with the
parameter-set placement their suffix states — into `getDecoderConfig().dolbyVision`. The MP4 muxer and
the CMAF writer re-emit it, in the box the profile calls for, choosing the sample entry from the
compatibility id: profile 8 keeps `hvc1`, profile 5 stays `dvh1`. With no `dolbyVision` field nothing
is written. The RPU NAL units ride in the bitstream untouched, so a track whose box was dropped kept
its RPUs and read as plain HDR10.

**HDR10 static metadata.** `parseSeiHdrMetadata(seiNalUnit, codec)` extracts mastering display (SEI
137, SMPTE ST 2086) and content light (SEI 144, CTA-861.3) from one AVC or HEVC SEI NAL,
emulation-prevention stripped; the two differ only in NAL header length, which `SeiCodec` selects.
`parseMasteringDisplayMetadata` / `parseContentLightLevel` parse the raw payloads; `buildMdcvBox` /
`buildClliBox` emit the ISOBMFF boxes. Also exported: `HdrStaticMetadata`,
`MasteringDisplayMetadata`, `ContentLightLevel`.

**Both carriages on write.** AVC and HEVC output states HDR10 in the container `mdcv`/`clli` boxes
**and** as a prefix SEI on each key packet, because real HDR10 usually carries both and a player
reading one and ignoring the other would see no HDR. The SEI is spliced after the parameter sets,
emulation-prevented, and written only for fields the access unit does not already state — a packet
carrying its own SEI passes through byte for byte. Both carriages die with the HDR transfer.

**Round-trip.** The MP4 demuxer reads `mdcv`/`clli` into `getDecoderConfig().hdrStaticMetadata` and
the muxer re-emits them, gated on presence like `colr`. Where an HEVC track states a PQ or HLG
transfer but carries neither box — the shape ffmpeg's mp4 muxer produces — the demuxer reads the
missing half out of the first access unit's SEI. The probe costs one packet read, is skipped for any
track not already claiming an HDR transfer, and the boxes win where present.

**MPEG-TS has no sample entry**, so an HDR10 grade arrives only as SEI 137 and 144; the demuxer reads
them off the first access unit. Unlike the ISOBMFF path, that read is **ungated** — there are no boxes
to fall back to, a gate would drop a grade whose SPS understates the transfer, and it runs once per
stream. Both paths read AVC as well as HEVC.

### Encode-side colour and bit depth

`VideoEncodingAdditionalOptions.bitDepth` and `.colorSpace` (mirrored on `ConversionVideoOptions`)
state what the encoder should produce. The codec string derives its profile from the bit depth — AVC
High 10, HEVC Main 10, VP9 profile 2, AV1 Main at 10 bits — and a codec/bit-depth pairing with no
profile is refused rather than silently downconverted. `Conversion` inherits both from the input. An
inherited depth follows the **decoded samples**, not the source profile, so an 8-bit stream in a
10-bit-capable profile is re-encoded at 8 bits unless a depth is requested.

An encoder either produces the depth it was asked for or refuses, naming itself and the depth; with
none requested it preserves the incoming frames' depth. Whether a value was demanded or inherited is
carried alongside it, because a codec string names a profile and every profile implies a depth, so a
config alone cannot say which. An inherited value is kept only where the samples still back it — a 2D
canvas re-render yields 8-bit sRGB and loses both, a scaler that stays in YUV keeps them. A demanded
value is never quietly dropped: PQ and HLG are defined from 10 bits up, so demanding one alongside a
shallower depth is refused, while an inherited transfer a demanded depth cannot carry is left
unstated. The encoder states the colour it encoded, making a caller's declaration a consistency check:
a contradiction is an error, and a declaration is only filled in where the encoder stated nothing.

`transferForOutputBitDepth` clamps `pq` or `hlg` away below 10 bits, warning as it does. This is an
addition upstream does not have, so the fork states no transfer where upstream passes `pq` through,
and that expectation is a declared divergence.

**Colour tagging in the server encoder**, reverted here once by a rebase and restored: RGB input is
retagged into limited-range BT.709 (BT.2020 NCL, or the SD matrices, when the primaries say so), the
scale contexts are left unconfigured so `sws_scale_frame` honours the frames' colour instead of
`getContext`/`initContext` defaulting to BT.601, and primaries and transfer are mirrored onto the
source frame so swscale does the matrix rather than a transfer conversion. Without it the encoder
wrote **no colour description at all** for RGB input and every decoded YUV frame came back shifted.

**Colorimetry survives a geometric transform.** In libavfilter the matrix coefficients and colour
range are *link* properties rather than frame properties, so a graph whose buffer source does not
state them hands back frames with those two unstated while primaries and transfer ride through — every
rescaled rendition then loses its matrix. The buffer source states what the source frame stated.

**AV1's cap carries a stated allowance.** SVT-AV1's capped CRF approximates the buffer model instead
of enforcing it, where x264 and x265 are a true VBV and libvpx caps over the stream, so only AV1 needs
tolerance: 1.25 in the capped-quality test against 1 for the others. With capping disabled the same
measurement reads 4.91, so the allowance still catches a real failure. The 50 fps case asks the
question that does not move across machines — capping must cut the worst window by more than 5x and
land no more than 2x outside the allowance — because a fixed ceiling read 0.64 on one machine and up
to 1.233 in CI on the same commits.

### DCI-P3 and cinema gamma, widened only where the fork owns the code

`COLOR_PRIMARIES_MAP` gains `smpte431` (CICP 11, DCI-P3) and `TRANSFER_CHARACTERISTICS_MAP` gains
`smpte428` (CICP 17, digital cinema's 2.6 gamma over X'Y'Z'). Neither is in WebCodecs' enums, so the
caller-facing `colorSpace` option takes `WideVideoColorSpaceInit`, derived from those maps so the type
and `validateVideoColorSpaceInit` cannot disagree.

**Only caller-input surfaces are widened** — `VideoEncodingConfig.colorSpace`, the conversion option,
and the three helpers that ask a question about the CICP set (`validateVideoColorSpaceInit`,
`transferNeedsTenBits`, `outputCarriesHdrSignal`). Everything else keeps `VideoColorSpaceInit`: the
writers read the maps rather than the enum, and the demuxers cast through `*_MAP_INVERSE`, so the read
direction resolves 11 and 17 with no signature change. Anything handed to a real `VideoDecoder` or
`VideoFrame` keeps WebCodecs' type, because those reject a value they do not know.

Renaming the types across every file that mentions them is the wrong way to do this: it declares 78
upstream lines as fork deletions, and a textual rename also rewrites `EBMLId.MatrixCoefficients` and
the DASH scheme ids `urn:mpeg:mpegB:cicp:TransferCharacteristics` and `…:MatrixCoefficients` — HDR
detection from an MPD breaks with the tests still green.

### Manifest colour signalling

`VIDEO-RANGE` (`SDR`/`HLG`/`PQ`) on `EXT-X-STREAM-INF`, and the CICP `SupplementalProperty`
descriptors on the DASH video AdaptationSet, both derived from the decoder config. Rendition selection
happens before any media is fetched, so colour stated only in the media is colour no player can select
on. A transfer that cannot be named is left unstated rather than asserted as SDR, since an absent
`VIDEO-RANGE` already implies SDR.

### The MPD model keeps DRM references, DVB extensions and Period properties

`parseMpd` and `src/dash/` are the fork's own, so these are five things the model never carried:

- `ContentProtection` `@refId` / `@ref` — the referenced form of DRM signalling in 23009-1.
- `BaseURL` `@dvb:priority` / `@dvb:weight` (`urn:dvb:dash:dash-extensions:2014`).
- `Period`-level `<SupplementalProperty>` and `<EssentialProperty>`.
- **Prefixed attributes on any descriptor**, kept verbatim in `DashDescriptor.foreignAttributes` — one
  mechanism rather than a field per extension, covering DVB `<Reporting>` and the font-download
  `<EssentialProperty>` together.

`foreignAttributes` is optional: absent means none. Enumerating a node's attributes needs both the
DOM's `Element` and this package's `XmlElement`, whose `attributes` is a `Map`.

The test asserts a **fixed point** — parse, serialize, parse, serialize, byte-identical. A "contains
the attribute" check passes on a serializer that writes it and a parser that cannot read it back.

### EBU-TT-D as a TTML profile

`new SubtitleCueSource('ttml', { ttmlProfile: 'ebu-tt-d' })` writes EBU-TT-D (EBU Tech 3380 v1.0.1);
`'imsc1'` is the default and the previous behaviour.

It is the same document, not a different one: the IMSC1 output already satisfies everything Annex B
marks `#REQUIRED`. The profile adds the §2.9 conformance signal
`urn:ebu:tt:distribution:2018-04` and the `ebutts`/`ebuttm` namespaces of §2.6, plus
`tts:backgroundColor`, `ebutts:linePadding` and `tts:lineHeight`, because EBU-TT-D subtitles are
presented in a box rather than over the video and the box's inset and height should not be the
renderer's choice. `ebutts:multiRowAlign` and `ebutts:linePadding` are `0..1` in the spec, so neither
is forced.

**`tts:extent` is not permitted on `tt:tt`** — Annex B does not list it there, and the "any attribute
in any TT or EBU TT namespace" allowance excludes `tts:`. Worth stating because the opposite is the
natural assumption.

`ttmlProfile` on a non-TTML codec throws rather than being ignored.

### Accessibility dispositions reach the manifest and the transport stream

`hearingImpaired` and `visuallyImpaired` were carried on a track and dropped by every writer. Both now
reach the two places a receiver can act on:

- **HLS**: `CHARACTERISTICS` on `#EXT-X-MEDIA` (RFC 8216 §4.3.4.1), as Apple's Universal Type
  Identifiers — `public.accessibility.describes-video` for a visually-impaired **audio** rendition, and
  `public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound` for a
  hearing-impaired **subtitle** rendition, which is what SDH means.
- **MPEG-TS**: `audio_type` in the ISO 639 language descriptor (13818-1 Table 2-61) — `0x03`
  visual-impaired commentary, `0x02` hearing-impaired. The field holds **one** value, so a track
  flagged both ways collapses to visual-impaired: an audio description is its own mix, where
  hearing-impaired describes how an ordinary mix is balanced.

**Only combinations the specifications name are written.** There is no identifier for a
hearing-impaired *audio* rendition in HLS and none for a visually-impaired subtitle, so those flags
state nothing there rather than getting an invented tag. An accessible track with no stated language
still gets the descriptor, since `und` is a language and the `audio_type` beside it is what is being
selected on.

### SCTE-35 signalling is registered at the program, not only on the stream

The PMT's `program_info` loop carries the CUEI `registration_descriptor` whenever `scte35Pid` is set,
as well as the one on the cue elementary stream. SCTE 35 §8.1 puts it there and libavformat reads it
from there alone: `prog_reg_desc` is filled from that loop, and stream type 0x86 maps to SCTE-35 only
where it equals `CUEI`. The same value decides `is_pes_stream`, so without it ffmpeg treats the cue
PID as PES rather than sections. With the registration on the elementary stream only, ffprobe reported
`codec_tag_string=CUEI` and **no** `codec_name` or `codec_type`; with it, `codec_type=data` and
`codec_name=scte_35`.

### Redundant paths: RIST multi-peer, SRT bonding

`RistSource` and `RistTarget` take several `rist://` URLs. The sender numbers payloads once across
every path and splits them between paths; the receiver feeds every path into **one** reorder buffer
keyed by RTP sequence number, which is what merging is — a packet replicated down two links is
delivered once, and a stream split across two is put back in order. Every path shares the options
given, so they differ only in address.

`SrtBondedTarget` is the SRT equivalent, over libsrt's socket groups. It binds libsrt directly because
FFmpeg cannot reach this at all — none of the 38 options its `srt` protocol documents touches socket
groups. Broadcast puts every payload down every link; backup keeps one carrying and the rest idle,
ordered by weight.

**`SrtBondedSource` can refuse a caller before it delivers a byte.** `accept(peer) => boolean` is asked
once per accepted connection with the caller's IPv4 address, source port and `SRTO_STREAMID`; false
closes that socket and the listener goes back to waiting. `refusedCallers` counts them. This is how a
host enforces an allowlist that MediaConnect states as a CIDR.

**The caller's address is read from the length `srt_accept` reports, not from the address family.**
`AF_INET6` is 30 on macOS, 10 on Linux, 23 on Windows and different again on the BSDs, so keying on it
needs a per-platform table this repo cannot verify. A `sockaddr_in` is 16 bytes and a `sockaddr_in6`
28 on all of them, and the port sits at offset 2 in network order in both. `family` says which one;
`address` is null only for a sockaddr of neither length, and an allowlist should refuse on null.

It needs no C callback: `srt_accept` already takes a `sockaddr` out-param that this binding was passing
as null, and the stream id is read with `srt_getsockflag`. The refusal therefore lands just *after*
SRT's handshake rather than during it, so the caller sees a connection that closes immediately.

**The same hook is not reachable on `NetworkSource` or `SrtTarget`**, because both open their `srt://`
through node-av's FFmpeg `IOContext`, which exposes neither the accept callback nor the caller's
address.

**libsrt ships inside the package**, built per platform with `ENABLE_BONDING=ON` and mbedTLS into
`packages/server/prebuilt/<platform>-<arch>/`, which `candidatePaths()` tries straight after the
`MEDIABUNNY_LIBSRT` override and **before** any system library — a system libsrt is usually Homebrew's,
which carries no bonding. **darwin-x64 is not built**: `macos-13` is the last Intel image and no runner
is ever assigned on this account, which held five releases. An Intel Mac falls back to a system libsrt
or `MEDIABUNNY_LIBSRT` and names the reason when it finds neither.

The publish step asserts the **exact** set of prebuilds rather than a count: a `>= 1` check passes with
one platform present and three missing.

Finding the directory needs this module's own location, and neither form works in both bundles:
esbuild compiles `import.meta.url` to an empty object in CJS, and tsc refuses `import.meta` in a
CJS-targeted source file, while `__dirname` does not exist in ESM. The source uses `__dirname` and
`scripts/bundle.ts` prepends a shim to the **srt** ESM bundles only. The lookup walks up from that
directory rather than using a fixed depth, since the bundles sit at `dist/bundles/` and the module
build at `dist/modules/src/`.

**`srt_cleanup` is called on process exit, and without it the process segfaults.** `srt_startup`
spawns libsrt's GC and epoll threads; left running while Node tears down they crash the process with
exit 139 *after* a clean run that already delivered its bytes. Shipped broken up to and including
1.66.0-beta.739, reproducing on nothing more than constructing an `SrtBondedSource` and letting the
process end. Only a child process can observe it, so the regression test spawns one.

**A build without `ENABLE_BONDING` is detected by asking, not by looking.** Such a build still exports
every group symbol — they are stubs returning `SRT_INVALID_SOCK` — so the symbol says nothing. The
binding creates one group at load and closes it again. Homebrew's libsrt 1.5.6 is such a build;
Debian and Ubuntu's `libsrt1.5-openssl` enables it.

### RIST input

`RistSource` reads a RIST Simple Profile stream (VSF TR-06-1) — the shape MediaConnect speaks — as an
MPEG-TS byte stream, in TypeScript over `node:dgram`, since the FFmpeg build here has no librist. RTP
on the URL's even port carries the transport stream; RTCP on the next port carries the NACKs, as both
TR-06-1's range NACK (an RTCP APP packet named `RIST`) and RFC 4585's generic NACK, sent together so a
sender may answer either. The receiver answers a sender's SR with an RR and an SDES CNAME, which is
what tells the sender where to send.

`bufferMs` is the latency: how long a packet waits for the ones before it, how long a lost one has to
be retransmitted, and the delay before the first packet is released — until the buffer has filled once,
the lowest sequence seen is not known to be the lowest there is. Past that deadline the gap is given up
and the demuxer resyncs on the next sync byte. Sequence comparisons are signed 16-bit, so loss and
reordering across the 65535→0 wrap behave as anywhere else. Packets lost before the first to arrive are
never asked for, there being no sequence number to count back from.

`mode: 'caller'` binds an adjacent port pair rather than two ephemeral ports: a caller is found by the
address its RTCP comes from, so a sender derives the media port as the control port minus one.

The independent control for all of this is libavformat's own `rtp_mpegts` muxer and librist 0.2.20,
not the fork's own sender. One bug that reading the spec alone did catch: RTCP states a packet's length
in 32-bit words *minus one*, and the range NACK is a word long, so a sender decoded a trailing zero as
a request for sequence 0.

## Closed captions

CEA-608/708 caption byte pairs are carried in the video bitstream as `user_data_registered_itu_t_t35`
SEI (ATSC A/53), spliced into each access unit that states them, for both AVC and HEVC. Captions are
per-access-unit rather than track-static, so they are supplied per packet through
`EncodedVideoPacketSource`, and the splice happens there rather than in a muxer — so ISOBMFF, HLS, DASH
and MPEG-TS all carry them from one place.

Whether the manifest announces them is a required decision, not a default:
`VideoTrackMetadata.closedCaptions` states which `INSTREAM-ID`s exist and whether to announce,
producing `#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` plus `CLOSED-CAPTIONS` on the HLS variant and an
`Accessibility` descriptor in DASH. **Declaring is what makes a manifest announce captions, not what
permits them**: a frame may carry captions the metadata does not declare, and no manifest then mentions
them — a real shape worth being able to produce deliberately. The reverse is refused: a track that
declares them and delivers none fails before any manifest is written, checked against the written
bitstream rather than a flag, as does a packet that would end up with two disagreeing caption SEIs.

**Captions are carried by the frame.** `VideoSample` states them in `closedCaptions`, settable in the
constructor or through `setClosedCaptions`, propagated by `clone()` and `transform()` — a resized frame
still carries what was in the picture, so every rendition of an ABR ladder keeps the captions.
`CanvasSource.add` takes them as a trailing argument.

That makes one path for every producer and one writer. `@mediabunny/server`'s decoder states the A/53
captions it found on the sample it hands back; its encoder **strips the side data off the frame before
the native encoder sees it**, because the encoders disagree — libx264 writes it, libx265 drops it
silently, and the VideoToolbox encoders error out of `sendFrame` ("Unexpected end of SEI NAL Unit
parsing type") and take the encode down. The core then writes the caption SEI onto the encoded packet,
matched to the frame on the microsecond timestamp the two share, since an encoder emits packets in
decode order.

### AV1 carries them in a T.35 OBU, not an SEI

AV1 has no SEI, so A/53 captions ride an ITU-T T.35 **metadata OBU** (`metadata_type` 4) — the same
envelope HDR10+ uses, carrying the same payload octets an AVC or HEVC SEI carries.
`buildClosedCaptionT35Payload` builds that payload once and the carriage decides the wrapper. The AV1
envelope helpers are named for the envelope rather than for one payload — `iterateAv1T35Payloads` and
`withT35MetadataObu` — and HDR10+ and captions are told apart by the payload's own country and
provider codes.

`parsePacketClosedCaptions` takes `'av1'` with a **null** decoder config: an OBU states its own size,
where a NAL unit's length prefix is sized by the `avcC`/`hvcC`, so nothing outside the packet is
needed. `ClosedCaptionCodec` is the widened codec type.

**Both entry points carry them**, and they are separate paths: `VideoSample.closedCaptions` through
`VideoSampleSource`, and `meta.closedCaptions` through `EncodedVideoPacketSource.add`. A test of one
says nothing about the other.

**The oracle is ffmpeg's decoder, not a round trip.** Both halves of this library would round-trip a
payload they misread the same way, so the assertion is that `ffprobe -show_frames` reports
`ATSC A53 Part 4 Closed Captions` on every frame. The byte pairs are distinct per frame, so a reader
that returns the first frame's for all of them fails.

**The read side is public.** `parsePacketClosedCaptions(packetData, decoderConfig, codec)` returns the
caption byte pairs an encoded AVC or HEVC packet carries, or `null` — the NAL walk, the
emulation-prevention stripping, the SEI payload walk and the `cc_data` parse. `decoderConfig` states
the NAL length prefix size; Annex B is walked by start code. Also exported:
`ClosedCaptionBytePair`, `ClosedCaptionChannel`, `ClosedCaptionsMetadata`.

A codec that cannot carry them drops them: an AV1 or VP9 rung sharing the sample warns once and
encodes rather than failing. Captions whose frame the encoder discarded are discarded with it, and a
**repeated frame** — frame rate padding filling a gap — carries none, since replaying the same caption
commands is what a caption decoder would act on twice.

A custom encoder's `flush` is awaited and its errors routed like its `encode` errors. It was neither: a
buffering encoder emits every packet from `flush`, so `finalize()` returned without waiting for the
encoder's own queue, and an error raised there was reported only because the `close` behind it happened
to drain the same chain.

## Input side — read MPEG-DASH manifests

### DASH input pipeline

A full `application/dash+xml` reader mirroring the HLS input architecture. Format singletons and
arrays: `DashInputFormat`, `DASH`, `DASH_FORMATS` (composes DASH with ISOBMFF, QuickTime, Matroska and
WebM for segment-side demuxing).

`parseMpd(xml) → Mpd` returns a typed AST — `Mpd`, `MpdPeriod`, `MpdAdaptationSet`,
`MpdRepresentation`, `SegmentTemplate`, `SegmentList`, `SegmentBase`, `SegmentTimelineEntry`,
`DashByteRange`, `ContentProtection` — and throws `MpdParseError` on malformed XML or a missing
required attribute. It reads with the global `DOMParser`, or a built-in XML parser where the runtime
has none (Node, Bun, Deno); `domParser` swaps in another implementation.

`DashDemuxer` / `DashSegmentedInput`:

- Two-pass track resolution, so audio and video Representations across paired AdaptationSets share a
  pairing mask by `(Period, AdaptationSet@group)`.
- Codec fallback: probes the first segment via `getDecoderConfig` where neither Representation nor
  AdaptationSet declares `@codecs`.
- `<Label>` preference: Representation > AdaptationSet > Representation `@id`.
- Media type from either level — an AdaptationSet stating neither `@contentType` nor `@mimeType` takes
  it from its Representations' `@mimeType`, which §5.3.7 allows and GPAC writes.
- `SegmentTimeline`: `@r=-1` repeats until the next `<S>@t` or period end, per §5.3.9.6.1.
- Live refresh on `minimumUpdatePeriod`, with in-place context mutation preserving `SegmentedInput`
  identity.
- **DVR window**: `timeShiftBufferDepth` bounds availability, and a `$Number$` template's segments are
  numbered from the **live edge back**, not from `availabilityStartTime` — a stream running for years
  dropped the numbers near `@startNumber` long ago. The window is stated against
  `availabilityStartTime`, so a later period's segments are placed at `@start` plus their
  period-relative time before being compared against it.
- `<BaseURL>` chain MPD → Period → AdaptationSet → Representation, each resolved against the one above
  and the first against the manifest's own URL, re-read on every refresh.
- A Representation stating no SegmentTemplate, SegmentList or SegmentBase is the self-contained file
  its own `<BaseURL>` names, which is how the ISO on-demand conformance vectors state it.
- `availabilityTimeOffset` and `presentationTimeOffset` honoured.
- Common Encryption: `<ContentProtection>` and `<cenc:pssh>` in both wire forms (full pssh box bytes
  and content-only), forwarded into `isobmff.resolveKeyId`. `Input.getPsshBoxes()` answers from the
  manifest too, deduplicated and without fetching a segment, which is what a licence request needs
  before any media is read — DASH and ISO BMFF only, since HLS states its systems in a key URI.
- A protected track's own `tenc` reaches `getEncryptionInfo()` and its sample entry reaches
  `getInternalCodecId()`, through the segment the track was built from. Both answered a constant
  before, so every DASH track read as clear and codec-less while the init stated otherwise.
- Stable track IDs across refreshes via `(periodId|asId|repId)`.

### HLS playlist parser — public, and the demuxer's single source of truth

`parseHlsPlaylist(text, variables?) → HlsMasterPlaylist | HlsMediaPlaylistAst`, plus `HlsVariant`,
`HlsIFrameStream`, `HlsMediaRendition`, `HlsSegment`, `HlsMap`, `HlsKey`, `HlsSessionData`, `HlsStart`,
`HlsContentSteering`, `HlsDateRange`, `HlsSkip`, `HlsRenditionReport`, `HlsPlaylistVariables`.

**Full spec coverage**, so parse → mutate → `serializeHls` is lossless and idempotent: session keys
(multi-DRM, one per `KEYFORMAT`), session data, `#EXT-X-START`, content steering, `#EXT-X-DATERANGE`
with the open `X-` client-attribute namespace kept as a map, `#EXT-X-BITRATE`, `#EXT-X-GAP`, and the
full variant / I-frame / rendition attribute sets. A tag outside the spec is dropped on serialize
unless it lands in `unknownTags` (below), and parsing warns once per unknown tag naming it and its
line.

**Lexical types.** The spec fixes the token form of every attribute, and the right value in the wrong
form produces output a strict parser may reject — `INSTREAM-ID` shipped unquoted this way. Every
emitted attribute is pinned to its spec type by a test that reads the serializer. `#EXT-X-DATERANGE`
client attributes are the one case where the form carries meaning rather than following from the name,
so `HlsClientAttribute` is a tagged union of quoted-string, hexadecimal-sequence and
signed-decimal-floating-point, each written back as read.

**Three-valued attributes.** `DEFAULT`, `AUTOSELECT`, `FORCED` and `PRECISE` are `boolean | null`,
since the spec admits YES, NO and absent and collapsing absent into NO loses the distinction on the way
out. `INDEPENDENT`, `GAP`, `END-ON-NEXT`, `CAN-BLOCK-RELOAD` and `CAN-SKIP-DATERANGES` are specified as
"value MUST be YES", so a boolean is the whole domain.

**`#EXT-X-DEFINE`**: `{$name}` references are resolved in URIs and attribute values while parsing. Pass
an `HlsPlaylistVariables` to own the scope — a media playlist can `IMPORT` from the master that
referenced it, and `QUERYPARAM` definitions resolve against the playlist's own URL.

Master AST entries carry `lineNumber`, so cross-array document order can be reconstructed. Media AST
is ordered `segments[]` with `#EXT-X-MAP` / `#EXT-X-KEY` carry-over, `programDateTime`, `byteRange` and
`discontinuityBefore`.

**Low-Latency HLS**: `#EXT-X-PART` onto `HlsSegment.parts`, parts belonging to the segment still being
written onto `trailingParts`, `#EXT-X-PART-INF` as `partTarget`, `#EXT-X-SERVER-CONTROL` as
`serverControl`, `#EXT-X-PRELOAD-HINT` as `preloadHints`. Delta updates too: `#EXT-X-SKIP` as `skip`
(with `RECENTLY-REMOVED-DATERANGES` split into IDs) and `#EXT-X-RENDITION-REPORT` as
`renditionReports`. `serializeHls` writes them in spec order and declares `#EXT-X-VERSION:9` once parts
are present.

**Reload decisions (RFC 8216bis §6.2.2 / §6.2.5.2)**, as pure functions over the AST so a caller need
not own a state machine: `hlsReloadState(playlist)` derives target duration, last media sequence
number, part count and whether parts are retained; `hlsRetainsParts(state)` answers whether parts are
still listed for a segment (three target durations); `hlsReloadDirective(state, msn, part)` chooses
between blocking reload, plain reload and `'too-far'`, including the Advance Part Limit.

Live media-playlist state — sequence numbers, byte-range continuation, PDT extrapolation, key
carry-over — stays inside `HlsSegmentedInput`: that is a state machine, not a static parser.

### The minimum `#EXT-X-VERSION` a playlist actually needs

`hlsVersionOf(playlist)` returns the lowest version the content requires, per
draft-pantos-hls-rfc8216bis-22 §8: 2 for an `IV`, 3 for a floating-point `EXTINF`, 4 for
`EXT-X-BYTERANGE` or `EXT-X-I-FRAMES-ONLY`, 5 for `SAMPLE-AES`, `KEYFORMAT`/`KEYFORMATVERSIONS` or
`EXT-X-MAP` alongside I-frames-only, 6 for `EXT-X-MAP` without it, 7 for a `SERVICE` `INSTREAM-ID`, 9
for `EXT-X-SKIP`, 10 when that skip replaces dateranges, 13 for an `INSTREAM-ID` on a non-caption
rendition.

§8 says a client MUST NOT attempt playback of a version it does not support, so declaring more than
you use locks out devices that could have played the stream — a hardcoded 7 shuts out exactly the old
hardware a clear MPEG-TS rendition exists for, which needs only 3.

`serializeHls` formats `#EXTINF` to match the version stated: an integer duration below version 3,
where §4.4.4.1 says durations MUST be integers, three decimals at 3 and above. Stating a version below
3 with a non-integer duration throws `InvalidUsageError` rather than writing a line the version cannot
hold. **That class of bug is caught by asserting against the serialized text**, not a re-parse:
parsing turns `4.000` back into `4`, so an AST round trip sees nothing wrong.

It is a floor, not a verdict. Three rules cannot be answered from a parsed playlist: versions 8 and 11
turn on `EXT-X-DEFINE`, which is substituted away during parsing, and 12 turns on any `REQ-` attribute,
which is dropped with every other unmodelled attribute.

### Unmodelled HLS tags survive a round trip

`HlsSegment.unknownTags` and `HlsMediaPlaylistAst.unknownTags` hold, verbatim and in order, every line
the AST does not model. A tag preceding a segment is kept on that segment and written back there; one
before the first segment is kept on the playlist. `#EXT-X-CUE-OUT`, `#EXT-X-CUE-IN` and
`#EXT-OATCLS-SCTE35` arrive this way, which is what lets an SCTE-35 ad relay rewrite someone else's
playlist through the AST rather than a line-based lexer.

Two losses were behind this: unmodelled `#EXT` tags warned and were discarded, and a line starting `#`
but not `#EXT` went silently, since RFC 8216 calls that a comment to be ignored — correct for a player,
wrong for a relay.

This is **not** a promise that `serializeHls(parseHlsPlaylist(x))` is byte-identical to `x`. Two known
differences: `#EXT-X-DATERANGE` is modelled at playlist level, so it is emitted with the other playlist
tags rather than where it was written, and attribute numbers are reformatted (`PLANNED-DURATION=30`
returns as `30.000`). Content is preserved; spelling and the position of *modelled* tags are not.

`unknownTags` is required on both types; `hlsSegment()` and `hlsMediaPlaylist()` default it to empty.

### Spec-primitive exports

- **HLS:** `HLS_MIME_TYPE`, `TAG_STREAM_INF`, `TAG_I_FRAME_STREAM_INF`, `TAG_MEDIA`, `TAG_EXTINF`,
  `TAG_MAP`, `TAG_KEY`, `TAG_MEDIA_SEQUENCE`, `TAG_BYTERANGE`, `TAG_PROGRAM_DATE_TIME`,
  `TAG_DISCONTINUITY`, `TAG_TARGETDURATION`, `TAG_ENDLIST`, `TAG_PLAYLIST_TYPE`, `TAG_I_FRAMES_ONLY`,
  `TAG_DISCONTINUITY_SEQUENCE`, `TAG_DEFINE`, `TAG_SESSION_KEY`, `TAG_SESSION_DATA`, `TAG_START`,
  `TAG_CONTENT_STEERING`, `TAG_DATERANGE`, `TAG_BITRATE`, `TAG_GAP`, `TAG_SKIP`,
  `TAG_RENDITION_REPORT`, `AttributeList`, `HlsPlaylistVariables`, `canIgnoreLine`.
- **DASH:** `DASH_MIME_TYPE`, `parseISODuration`, `parseISODateTime`, `parseByteRange`,
  `parseFrameRate`, `resolveURL`, `resolveBaseURL`, `substituteTemplate`, `normaliseKeyId`,
  `psshContentsOffset`, `DashRational`.

### Concat / stitch building blocks

- `concatMpdPeriods(inputs) → { xml, totalDurationSeconds }` sequences the first `<Period>` of each
  input MPD into one multi-period output. The first input is the output base, preserving its `<MPD>`
  attributes, namespace declarations and non-`<Period>` root children, as well as markup the AST does
  not model. Only Period `@id`/`@start`/`@duration` and the optional injected `<BaseURL>` are mutated.
  It uses the built-in XML implementation, so it runs without a `DOMParser` polyfill; comments and
  processing instructions are not carried through, and an element's text is emitted after its children.
- `concatHlsMediaPlaylists(inputs) → { content }` preserves the first input's header lines verbatim,
  overwrites only `#EXT-X-TARGETDURATION` to the maximum across inputs, appends each body with optional
  `pathPrefix` rewriting on segment URIs and `#EXT-X-MAP@URI`, and ends with one `#EXT-X-ENDLIST`.
- `rewriteHlsMasterUrisToBasename(master) → string` strips directory components from STREAM-INF and
  MEDIA URIs.

These are **building blocks**: no filtering, normalization or AdaptationSet validation. Compose them
with your own passes.

### `tsc -p tsconfig.json` checks nothing

The root `tsconfig.json` has `"include": []` and exists only to hold project references, so
`tsc --noEmit -p tsconfig.json` type-checks zero files and exits 0 whatever the source says — an
undefined identifier in `src/` passes it. **The gate is `npm run check`**, which runs `tsc -p src`, one
`tsc -p` per package, then the vitest, scripts and vite projects. `check.sh` runs under `set -e`, so a
failing project hides every project after it: a clean run means clean, a dirty one means "at least
this".

### Test suite: HLS input reads a local corpus

`hls-input.test.ts` serves its media from an in-process HTTP server on `127.0.0.1:0`
(`test/node/_hls-fixture-server.ts`) out of `test/fixtures/hls/<host>/<path>`, so an original CDN URL
maps to a local one by moving its host into the first path segment. It is a server rather than a file
source because `UrlSource` is half of what these tests cover — range requests, relative URI resolution
— and playlists stating a URI absolutely are rewritten as served, so nothing reaches the real host.
There is no network guard, no retry budget and no per-request deadline: a red is the library's.

The corpus is 84 MB of third-party CDN streams and is **not committed**. `test/fixtures/hls-fixtures.txt`
lists the 120 URLs; `npm run capture-hls-fixtures` fetches them, retrying serially once because at
least one host rate-limits a parallel sweep. The server refuses to start when the corpus is absent and
names that command. To regenerate the list, run with `HLS_FIXTURE_LOG` set to a path.

A missing fixture must be loud: the server answers 404 with a text body and `fetchBytes` asserts
`response.ok`, or a gap gets read as media and surfaces as a confusing assertion elsewhere.

Live HLS is local too. `/__live__/media.m3u8` is synthesized: it lists real segments from the corpus,
hands out one more on every fetch, writes no `#EXT-X-ENDLIST` and dates itself at request time, so the
live edge genuinely advances and the test asserts the playlist grew while it waited. What this does not
cover is interop with a real CDN's live playlist, which is a fact about them.

`UV_THREADPOOL_SIZE=32` is set by the `test` and `test-node` scripts. DNS runs on libuv's threadpool,
4 threads per process shared with file I/O. It must be an environment variable on the command line —
libuv reads it at process start, so `test.env` in `vitest.config.ts` has no effect.

### A read that cannot fail is a defect, not a policy

`UrlSource`'s default `getRetryDelay` returned a delay for every failure and never `null`, so against a
closed port or a blackholed host a read retried forever and never settled — a socket and a timer per
abandoned request, held after the client has gone.

`UrlSourceOptions.requestTimeout` bounds a single request (default 30 s) and
`UrlSourceOptions.retryTimeout` bounds the retrying: seconds of *continuous failure* after which the
read rejects with `RetryTimeoutError`, carrying the failure that ended it on `cause`, default 60, `null`
for the old unbounded behaviour. The two are separate because they catch different things: a server
that accepts a connection and then never answers is not failing, so a retry budget never fires. The
budget is enforced in `retriedFetch` rather than in the retry policy, so overriding `getRetryDelay`
cannot make a read unbounded again, and it is checked after the backoff so an unreachable host rejects
on the budget rather than the budget plus one delay.

### One pipeline, two manifests, one timeline

HLS and DASH disagree about who owns the media timeline. HLS rebases media onto
`mediaTimestampBase`, because its playlist carries the timeline separately; DASH addresses media by the
media's own timestamps through `@presentationTimeOffset`, so rebasing moves the presentation against
its manifest. `ManifestEmitter.addressesMediaByItsOwnTimestamps` decides it per emitter, and the
stricter of the two wins when one pass feeds both. Low-latency parts go through the same helper as
whole segments, so a part cannot land on a different timeline from its segment.

`SegmentedInput` requires four things of a format for cross-variant sync and timestamp wrapping. For
DASH they are constants, and not for HLS's reasons: one instance is one (period, adaptation set,
representation), so a period boundary is a separate instance rather than a discontinuity; 23009-1 puts
every representation of a period on that period's timeline; media is fMP4 or WebM, which timestamp
their own samples; and 64-bit timestamps in a declared timescale do not wrap the way MPEG-TS does.

### What is public, and what only looks it

Every fork addition is a permanent compatibility promise, so the public surface is what we mean to
support rather than everything a port left exported. Twelve shaka-derived helpers that had leaked out
are `@internal` and no longer exported: `atLeastOneTrue`, `moreThanOneTrue`, `onlyOneTrue`,
`containerTypeName`, `textTypeName`, `isMultiplexed`, `hasLiveOnlyFields`, `hasVodOnlyFields`,
`removeDuplicateAttributes`, `createDefaultMpdParams`, `updateContentProtectionPsshHelper`,
`fourCCToString`. They are unchanged inside the fork; only the promise is withdrawn.

The audit compares the fork's exported **values** against upstream's and against this file. The unit
matters: comparing every export names 107 misses, most of them types reachable from a documented
signature, which is noise.

### `sidx` readers — byte ranges and timing from a segment index

`Input.getSegmentIndex()` returns the `SidxBox`; these read it.

- **`getSidxSegmentOffsets(sidx)`** — each subsegment's absolute byte offset, in order. With
  `references[i].subsegmentDuration` and `earliestPresentationTime` that is a complete byte-range plan
  without touching the media.
- **`getSidxInitRange(sidx)`** / **`getSidxIndexRange(sidx)`** — the init segment's and the index's own
  `ByteRange`.
- **`getSidxDurationSeconds(sidx)`**, **`getSidxMaxSegmentDuration(sidx)`** (for `@maxSegmentDuration`)
  and **`getSidxPeakBitrate(sidx)`** (for a `@bandwidth` that will not under-declare).

**A fork-only addition that is not written here is effectively private**: these were found by a
consumer reading source, and another asked for a feature that already existed, because fork additions
do not appear in upstream's documentation.

### ISO BMFF box editing

`iterateIsobmffBoxes` reads a box tree; these finish the other half, so a consumer indexing or
re-timing CMAF does not hand-roll `DataView` arithmetic.

- **`getSegmentTrackIds(segment)`** — each `tfhd` `track_ID` in `traf` order, for identifying a track
  from the segment rather than its path, which is what DASH-IF ingest prescribes.
- **`renumberFragments(segment, fn)`** — rewrites each `moof`'s `mfhd` `sequence_number` in place.
- **`removeIsobmffBoxes(bytes, types)`** — drops **top-level** boxes by type, for stripping
  `styp`/`sidx`; removing a nested box would leave its parent's size wrong.
- **`readSegmentHead(head)`** — track and decode time from the first bytes of a media segment,
  tolerating a buffer that stops anywhere, where `getSegmentDecodeTime` needs a whole segment. There
  are **three** outcomes: `null` means no recognisable `moof`; `{ trackId: null, ticks: null }` means a
  `moof` was found but the head stops before its fields; either field set means it was read. The
  partial case is kept rather than collapsed because a `trackId` alone is enough to pick a timescale
  without a `tfdt`. A caller wanting both-or-nothing guards on `ticks == null`.
- **`getInitSegmentTracks(init)`** — per track `{ trackId, timescale, handler, channels }`. Timescale
  alone does not separate video from audio or stereo from 5.1. `getInitSegmentTimescales` stays for the
  narrow question.
- **`IsobmffBoxInfo.runsToEnd`** — true when the box declared size 0. `size` resolves that to the bytes
  present, which is what a file wants; over a stream a declared 0 means "still arriving".
- **`segmentsOf(bytes)`** — splits a fragmented file into `{ init, segments }`. A media segment opens at
  each `styp`, or the first `moof` where nothing marks them; everything before is the init segment,
  reported as its own range. Segment-level prelude (`styp`, `sidx`, `prft`, `emsg`) belongs to the
  segment ahead, so a segment's `offset` includes it. `init` is `null` when the bytes carry none. Bytes
  after the last `mdat` — `mfra`, `mfro`, a trailing `free` — are reported as `trailing` rather than
  folded into the final segment: they index the file, not a fragment. `chunksOf` does fold them,
  deliberately, so that chunks tile a segment.

### AST builders

Factory functions that build the HLS and DASH ASTs from the fields that matter, defaulting the
boilerplate — the write-side complement to the parsers (hand the result to `serializeManifest`). For
describing already-produced segments rather than driving the muxer pipeline, so distinct from the
`MediaInfo`-driven `MpdBuilder`.

- **HLS:** `hlsVariant`, `hlsIFrameStream`, `hlsMediaRendition`, `hlsSegment`, `hlsPart`, `hlsKey`,
  `hlsMap`, `hlsStart`, `hlsSessionData`, `hlsContentSteering`, `hlsDateRange`, `hlsSkip`,
  `hlsRenditionReport`, `hlsPreloadHint`, `hlsMasterPlaylist`, `hlsMediaPlaylist`.
- **DASH:** `mpd` (ISO live/on-demand profile selected from `@type`), `mpdPeriod`, `mpdAdaptationSet`,
  `mpdRepresentation`, `mpdSegmentBase`, `mpdSegmentList`, `mpdSegmentTemplate`, `mpdSegmentUrl`,
  `mpdServiceDescription`, `mpdBaseURL`, `mpdContentSteering`.

Every field of the AST these produce is settable through the options, and every AST type a factory asks
the caller to supply has a factory of its own; both are enforced by tests. The second matters: a type
with no factory must be written out field by field, and `tsc` reports a nested type's missing fields
only once the outer ones are filled, so each level of nesting costs a whole typecheck cycle.

For every factory, `Exclude<keyof Ast, keyof Options>` is `never`. `SegmentBase.initialization` and
`SegmentList.initialization` are the only fields not named by an option of their own: they are built
from `initializationUri` and `initializationRange`.

`mpdSegmentBase`, `mpdSegmentUrl` and `mpdSegmentList` take a byte range as `{ start, end }` or as
`'start-end'`, and refuse a string that is not two integers so separated with `InvalidUsageError`.
`mpdSegmentList` takes each segment as a `@media` URI string or as an `mpdSegmentUrl` entry.

`<Initialization>` is written by `mpdSegmentBase` and `mpdSegmentList` whenever either
`initializationUri` or `initializationRange` is stated, since a single-resource presentation states a
range and no `@sourceURL`.

**`xs:dateTime` precision.** `parseISODateTime` keeps sub-millisecond digits as the fractional part of
the Unix-millisecond value, which `Date.parse` discards, so a `publishTime` stating microseconds
round-trips exactly. Doubles hold about 0.00024 ms at present-day epochs, so microseconds survive and
nanoseconds would not.

### Subtitle tracks on the read side

`Input.getSubtitleTracks()` returns `InputSubtitleTrack`s alongside video and audio, and
`SubtitleCueSink.cues(start, end)` yields `SubtitleCue` objects as the sample sinks yield samples;
`EncodedPacketSink` serves the raw bytes for a remux. ISOBMFF reads `wvtt` and `stpp`, Matroska reads
`S_TEXT/WEBVTT`, and a track is created only when the sample entry is one the demuxer can decode, so a
subtitle track whose cues cannot be read is never reported. A cue split across packets is rejoined by
its `vsid` where the format states one, else by its own timing and text.

`Conversion` carries subtitle tracks through, converting between the codecs it supports since both are
driven from the same cue representation. A subtitle track an output format cannot hold is reported in
`discardedTracks` with a reason, as is one under `tracks: 'primary'`.

## Typed errors

Every throw out of the fork's own areas — encryption, DASH, HLS, watermarking, manifest transforms —
states whose problem it is, so a caller never has to match on message text:

- **`MalformedInputError`** — the bytes or manifest are wrong for their format. The publisher is at
  fault; at an origin this is the one to turn into a rejection.
- **`UnsupportedMediaError`** — valid input stating something this library does not implement.
  Re-encoding or routing elsewhere can succeed, so rejecting it would be wrong.
- **`InvalidUsageError`** — the calling code is wrong. A bug to fix, not a runtime condition to handle.

All three extend `MediabunnyError`, which extends `Error`, and every message is unchanged. `MpdParseError`
extends `MalformedInputError` and is exported. `UnsupportedInputFormatError` extends
`UnsupportedMediaError` and `InputDisposedError` extends `InvalidUsageError`, so both reach a
`catch (e) { if (e instanceof MediabunnyError) }` like everything else.

**Partial typing would have been worse than none** — an untyped malformed-input throw escaping an
`instanceof MalformedInputError` check gives false confidence — so the conversion is total for those
areas, verified by there being no bare `throw new Error` left in them.

Every throw from the ISO BMFF box helpers is typed on the same split. Bytes wrong for the format — a
truncated box header, a `pssh` smaller than its own fields, a `sidx` whose reference table runs past
the box, a `trak` without its `tkhd`/`mdhd`, a segment naming a track the init does not describe —
raise `MalformedInputError`. A caller's own mistake — a box range outside the bytes handed in, a
negative `seconds`, a decode time not exactly representable at the track's timescale — raises
`InvalidUsageError`. An origin can therefore turn a bad segment into a 4xx and keep 5xx for its own
faults, which is the distinction the hierarchy exists for.

`DashProtectedContent` and `DashContentProtectionEntry` compare absent and default-valued as
different, mirroring proto2 presence, and a field stated as `null` compares equal to one omitted
rather than counting as a third presence. `setProtectedContent` refuses a `null` `protectedContent`
with `MalformedInputError`, as it does an omitted one.

## The target type `onInit` and `onSegment` hand back

`HlsOutputFormat<T extends Target = Target>` states what the caller's own `PathedTarget` factory
returns, and `onInit` / `onSegment` receive `T` rather than `Target`. Defaulted, so an unparameterised
`new HlsOutputFormat({ ... })` is unchanged. `T` is an assertion, not a check: the format and the
target are constructed separately, so nothing verifies it against the factory, and a wrong `T` is a
wrong type rather than an error. `BufferTarget.buffer` stays `ArrayBuffer | null`, because it is null
until the output is finalized.

## Optional fields under `exactOptionalPropertyTypes`

Optional fields on the types a caller builds — `VideoTransformOptions`, `VideoTrackMetadata`,
`AudioTrackMetadata`, `VideoEncodingConfig`, the source configs' `onEncodedPacket`,
`EncryptCmafOptions`, `EncryptWebmOptions`, `CmafTrackKey`, `CmafKeyPeriod`, `WebmTrackKey`,
`DrmOptions`, `DrmSystem`, `DashContentProtectionEntry`, `DashProtectedContent`,
`EncodedVideoPacketSource.add`'s `meta.closedCaptions`,
`CanvasSource.add`'s `closedCaptions`,
`MpegTsOutputFormatOptions` and `SegmentedOutputFormatOptions` — are declared `?: T | undefined`, so a
consumer compiling with `exactOptionalPropertyTypes` can assign a value that may be absent without a
conditional spread. `StatMuxOptions.programs`, the `WmSidecar` arrays and
`MpegTsOutputFormatOptions.privateStreams` are `readonly`, so a caller holding its own copy readonly
needs none.

`BaseTrackMetadata.languageCode`, `AudioTrackMetadata.disposition`, `SubtitleCue`'s `identifier` and
`settings`, `SubtitleTextRun.color`, `VideoEncoderControls.pass` and every optional field declared as an
inline object (`resolution`, `origin`, `extent`, `latency`, `playbackRate` and the rest, which a
single-line sweep does not reach), the manifest builders' option objects (`hlsVariant`,
`hlsIFrameStream`, `hlsMediaRendition`, `hlsMasterPlaylist`, `mpdRepresentation`, `mpdSegmentTemplate`,
`mpdSegmentList`), `HlsOutputFormatOptions.imageStream` and `SubtitlePlacement` are declared the same
way.

The packet sources' `add(packet, meta)` takes the WebCodecs metadata mapped the same way. Its own
fields state no `| undefined`, so intersecting them with this fork's additions refused one whatever
this side declared.

## `@types/dom-webcodecs` and a TypeScript whose `lib.dom` has WebCodecs

Upstream depends on `@types/dom-webcodecs` and `@types/dom-mediacapture-transform`, and this fork keeps
both at upstream's versions. Where `lib.dom` already declares WebCodecs — TypeScript 7.0 does — the
`@types` package redeclares it: a duplicate `ImageBufferSource`, a conflicting `data` property and a
duplicate index signature, and `@types/dom-mediacapture-transform` does not compile without that lib
either. A consumer checking library declarations fails whichever lib it picks; `skipLibCheck` is the
answer, and it is on by default.

The fork does not drop the dependency. It is upstream's, dropping it breaks every consumer whose
`lib.dom` has no WebCodecs, and the day TS 7's lib is the baseline the decision belongs upstream for
everyone rather than here for us.

## Conformance: what this fork guarantees

Checked against draft-pantos-hls-rfc8216bis-22, ISO/IEC 23009-1 and ISO/IEC 13818-1. Each item is an
invariant the test suite holds.

**Timing.** `EncodedPacket.decodeTimestamp` carries the decode time end to end. What this fork *writes*
satisfies DTS <= PTS with DTS rising within a track (13818-1 2.4.2); what it *reads* is what the source
states, relayed rather than repaired — Apple's own bipbop gear1 TS segment states a DTS after the PTS
on 138 of its 300 PES packets, and a clamp would silently restate a stream's decode order.

Signed composition offsets (14496-12 8.6.1.3, 8.8.8) are absorbed by
`InternalTrack.decodeTimestampShift`, derived **once from the init** — a `cslg` (8.6.1.4), a complete
`ctts`, or the codec's reorder depth (AVC `max_num_reorder_frames` or the level's DPB size, HEVC
`sps_max_num_reorder_pics`). It is never derived from the fragments a reader happened to open, so a
segmented reader and a whole-file reader agree. The presentation timeline is never shifted.

**On write, the stated decode times are carried.** The ISO BMFF muxer anchors the first sample's decode
time at media time zero and derives each composition offset from `EncodedPacket.decodeTimestamp`, so a
progressive file's offsets never go negative and no sample is given a DTS past its own PTS. The delay
until the first presented sample is stated as the `elst` media time, which is what puts presentation
back at zero, and `cslg` bounds it. A source stating no decode timeline of its own
(`statesDecodeTimestamp` false) has one derived per GOP by sorting that GOP's presentation times and
assigning them positionally.

**A fragmented file states the same thing.** Its `moov` goes out at the first fragment's flush, by
which point that fragment's decode times are known, so the reorder delay of a track whose decode
timeline starts below zero is stated in the `elst` exactly as a progressive file states it, and an
otherwise empty `stbl` carries a `cslg` whose composition-to-DTS shift is zero.

This is what keeps the A/V offset of such a track. Nothing but the init can state that delay, so a
fragmented file leaving it unstated is read — by `ffmpeg` included, whose own fragmented output has the
same gap — with the video that far from the audio beside it: measured on `demo.mp4` over RTMP, audio
leads video by 21 ms at the source and by 101 ms on the far end without this, 21 ms with it.

What makes that work is that **`tfdt` states the fragment's lowest decode time**, not its lowest
presentation time, which `trun`'s composition offsets are measured against. The two are the same number
for a track whose decode order is its presentation order, which is why stating the wrong one went
unnoticed while every decode time was reconstructed by sorting; for a track stating its own decode
timeline they differ by the reorder delay, and stating the presentation time put every fragment that
delay late. It is read off the fragment's samples when the box is built, not accumulated as they are
added, because a sample joins its chunk before the batch it belongs to has been settled.

**MPEG-TS** writes a PCR on the video PID, or the audio PID where there is no video, within the 0.1 s
of 2.7.2. Decode times a caller did not state are derived as one ladder — the i'th packet to decode
presents no earlier than the i'th smallest presentation time — lowered by the batch's reorder delay.
Clamping each packet to its own presentation time instead keeps `DTS <= PTS` while handing two packets
the same decode time, and no two access units decode at the same instant.

PES timestamps are unsigned 33-bit, so a programme that would decode before zero is offset forward by
one amount for every track, chosen from the first packet in output order (as ffmpeg's
`avoid_negative_ts` does). It fires only on the **sign split** — a head packet whose decode time is
negative while its own presentation time is not — because a wholly negative programme wraps together,
`DTS <= PTS` still holds, and shifting it would move a timeline the caller asked for. The decision is
per muxer rather than per format, so one `Output`'s offset never leaks into another sharing the format
instance; two `Output`s whose first packets differ in reorder depth can therefore choose different
offsets, so a ladder needing one timeline across rungs states
`MpegTsOutputFormatOptions.timestampOffset` on every rung. Stating it overrides the decision entirely.

**Bytes.** Helpers that edit a caller's buffer copy it first, including a Node `Buffer`, whose `slice`
returns a view. `base_data_offset` is a file offset (8.8.7.1), so moving a `moof` restates it.
`rebaseSegmentDecodeTime` refuses rather than wrapping a `tfdt`, and refuses a multi-track segment,
since one tick delta cannot suit two timescales.

**Dates.** MPD `availabilityStartTime` and `EXT-X-PROGRAM-DATE-TIME` are read as UTC, as dash.js and
shaka do; `Date.parse` reads a zoneless ISO date-time as local.

**What is kept, and what is refused.** XML prefixes used by verbatim children are declared;
`<ContentProtection>` children survive; `MpdEvent.scte35Binary` reads an SCTE-214-1 payload while the
original `<Signal>` is written back unchanged. Thirteen inputs the HLS spec says a client MUST fail to
parse are refused, among them two `EXT-X-VERSION` tags, `EXT-X-MEDIA-SEQUENCE` after a segment, a
non-hex IV and a fractional `BANDWIDTH`. A segment past the target duration and a missing target
duration are reported as `notes` instead, both being interpretable. Serialization refuses a URI with a
line break, a quoted value with a quote, `NaN`, and a stated version below what the content needs.

**Answers, not guesses.** `getSegmentCompositionOffset` and `getSegmentDecodeTime` validate structure
before answering, so 0 and `null` mean what they say rather than doubling as parse failures.
`renumberFragments` refuses a sequence number that is negative, fractional or past 32 bits.
`UrlSource` bounds both a single unanswered request and a run of failing ones, so a read always settles.

## A chunk's key-frame byte range

`IsobmffChunkInfo.keyFrame` is `{ offset, size }` or `null`: the range holding a chunk's `moof` and its
first sample, which is what an `EXT-X-I-FRAME-STREAM-INF` playlist publishes as a byte range. The
offset is the `moof`'s rather than the chunk's, since a `styp`, `sidx` or `emsg` ahead of it belongs to
the segment and not to the frame. `chunksOf`, `segmentsOf` and `cmafEncryptedLayout` all carry it, so a
protected segment's range is measured on the encrypted bytes as served; `readSegmentHead` carries it
too, and a head that stops at the end of the `moof` states a range reaching well past what was read.

Null means unstated, not zero-length: the first sample is not a sync sample, the chunk states no sample
flags, no sample size is stated anywhere (`trun`, then `tfhd`, then `trex`), or the base is unknown.
**`base_data_offset` makes it unknown.** 14496-12 8.8.7 defines `default-base-is-moof` only "if
base-data-offset-present is zero", so an explicit `base_data_offset` wins over it — and that is a
*file* offset, which the bytes handed in need not begin at. Guessing it would silently misplace the
range for a standalone segment. No fragmented fixture in the suite sets the flag, so that branch is
reached by a segment built in the test with one spliced in.

The ranges are checked against `ffprobe -show_packets`, not against another reading of the same boxes:
every stated range ends exactly at `pos + size` of the first packet in its chunk, over a file where
every chunk is a key frame and one where most are not. The encrypted case is held to the `moof`'s own
measured growth rather than to a formula.

## A red commit publishes nothing

`publish-fork.yml` waits for `fork-ci.yml` to conclude on the **same commit** and fails if it is not
green, before anything is published and before any tag moves.

Three red versions reached `latest` before this (680, 684, 685), and two separate things let them. The
publish job ran only the type, lint and build gates — never the test suite, because its install is
`--ignore-scripts` and node-av has no native binary there, so the tests genuinely cannot run in that
job. And the catch-up promotion was the job's **first** step, so it moved `beta` and `latest` before
any gate had run at all. The gate is first now and the catch-up follows it, which also means `pending`
can never name a version whose tests failed for a later run to promote.

A `workflow_run` trigger would be tidier, but GitHub fires those only for workflow files on the
**default branch**, and this one lives on the release branch. Splitting the registry write into its own
workflow is not an option either: npm's trusted publisher is configured per workflow *file*.

The cost is that the publish job idles while the test suite runs, up to an hour before it gives up. A
`workflow_dispatch` with `promote_version` skips the gate deliberately: promoting an already-published
version is an explicit human decision about a version that already exists.

## Finding things: the ISO BMFF segment group

The fork's segment tooling — box walking, segment and fragment layout, `sidx` reading, decode-time and
fragment-number rewriting, `emsg` — is its own `ISO BMFF segments` group of 35 exports rather than
sitting under `Miscellaneous`, where a capability goes to be unfindable. Nothing moved that upstream
exports, and no symbol was split from the function that returns it.

Worth stating because it is easy to go looking for a problem that is not there: every one of the 646
public exports already carries a `@group`, and `docs:generate` fails on a group that
`docs/api-config.json` does not declare, so the surface cannot silently drift ungrouped. The split is
about where things live, not whether they are labelled.

## Cross-cutting input additions

- **`sidx` box parsing** and `Input.getSegmentIndex`, for CMAF and DASH segment-side index access.
- **`sidx`-seeded fragment lookup tables** — a fragmented file whose index is a `sidx` rather than an
  `mfra`/`tfra` (the DASH on-demand and CMAF single-file layouts) is seekable through that index, so
  seeks and `computeDuration()` jump to the right fragment instead of walking `moof` by `moof` from
  byte 0. `tfra` still takes precedence where both are present.
- **MPEG-TS `computeDuration()` probes from the end of the file** — about 3 ranged reads regardless of
  file size, instead of one per binary-search step. Durations are unchanged.
- **Network prefetching grows when reading backwards**, the same way forward reads already do, instead
  of one fixed 64 KiB request per step.
- **`UrlSource` takes a `prefetchProfile`** — `'network'` (default, unchanged), `'fileSystem'` or
  `'none'`. The mechanism and all three strategies are upstream's; the option on `UrlSource` is the
  fork's, which previously hardcoded `'network'`. That profile grows a read region exponentially while
  reads keep landing in it, which is right for playback and wrong for a sparse random-access pass:
  reading a key frame and three packets after it at every key frame of a 17-minute 4 GB H.264 file read
  the **whole file** (4,041 MB over 18 requests) for the ~1.3 MB actually wanted. On a 26.5 MB fixture
  with 10 points: `'none'` reads 1.12x the packets' own size at one request per read, `'fileSystem'`
  1.68x, the default 2.94x — and the gap widens with file size.

  Deliberately not done: making `'network'` adapt from how much of a read region gets consumed. A
  sequential reader can consume very little of what it fetches and the measurement cannot tell it from
  a sparse one — reading only the audio track of an interleaved fixture consumes ~1% of the bytes
  around it, where the default reads 66x the track's size in **2 requests** and `'none'` 4.8x in **39**.
  Bytes and round trips are what the profiles trade, and only the caller knows which it is paying for.

  Both tests count bytes read out of response bodies rather than what the server was asked to send: the
  reader asks for open-ended ranges and cancels them once satisfied, so `Content-Length` overstates —
  by nearly 9x in the first measurement taken that way.

- **`SidxBox` read-side derivation helpers** and the `ByteRange` type export.
- **ISO BMFF segment helpers** — `iterateIsobmffBoxes` walks boxes (64-bit and size-0 sizes, `uuid`,
  children by content range) and throws on truncation; `getInitSegmentTimescales` reads each track's
  media timescale synchronously; `setSegmentDecodeTime` re-times a CMAF segment to an absolute start in
  seconds, per track in its own timescale, keeping the spacing of later `moof` chunks and throwing when
  a version 0 `tfdt` cannot hold the value.
- **Truncated whole-file reads fail loudly** — `requestEntireFile` throws `Short read: …` when a source
  reports a size and then serves fewer bytes. Yielding a slice that still claims the full range lets a
  manifest parse truncated, and even parse *successfully* with fewer renditions. Fork-only: proposed
  upstream as #569 and declined as unreachable, which held up — no built-in source reaches it — and
  kept as a cheap invariant for anything subclassing `Source` directly.
- **`Input` / `InputTrack` pssh and tenc exposure**, so re-muxing can preserve the original DRM boxes.
- **HLS port: `EXT-X-MEDIA` in input order**, from shaka b1580dd.
- **Packed audio timestamps** — the ADTS demuxer starts a file's timestamps at the 33-bit MPEG-TS
  timestamp in its leading ID3 `PRIV` frame (`com.apple.streaming.transportStreamTimestamp`, RFC 8216
  §3.4), so HLS packed-audio segments sit on their media timeline rather than at rounded `EXTINF` time.
  Files without the frame still start at 0, so a frame stating 0 is not the same as no frame.
- **Start offset between renditions** — HLS and DASH inputs keep the offset between paired renditions,
  so video 120 ms after audio keeps that lag rather than every rendition starting at its own playlist
  time. Renditions more than 0.5 s apart are treated as separate timelines.
- **HLS VOD and EVENT start time** — a `VOD` or `EVENT` playlist with `#EXT-X-MEDIA-SEQUENCE` above 0
  starts at its first segment's media time, since those types never remove segments (§4.3.3.5). Only a
  playlist without `#EXT-X-PLAYLIST-TYPE`, which may be a sliding window, is still placed
  `MEDIA-SEQUENCE × TARGETDURATION` in when it has no `#EXT-X-PROGRAM-DATE-TIME`.
- **HLS I-frame playlists without `#EXT-X-MAP`** — an `#EXT-X-I-FRAMES-ONLY` playlist whose first
  I-frame has a byte range starting past offset 0 reads the bytes before it in the same resource as its
  init section, as §4.3.2.5 allows, instead of failing with no `moov`. Same after each
  `#EXT-X-DISCONTINUITY`.
- **Video range only where signalled** — for H.264 and HEVC, `getColorSpace()` and the decoder config
  leave `fullRange` unset when the SPS carries no video signal type, so "not stated" is distinguishable
  from "limited" and a remux no longer gains a `colr` box claiming limited range. VP9, AV1, ProRes and
  Matroska are unchanged.
- **Public range read on `Source`** — `source.readRange(start, end)` resolves with those bytes as a copy
  the caller owns, or null when the range lies outside the source. A source providing fewer bytes than
  asked throws rather than returning a short result.
- **Lifetime diagnostics** — `InputDisposedError` names the operation and byte range that failed, and a
  `SourceRef` garbage-collected without being freed logs a warning. Both target the same bug: a dropped
  ref lets the source dispose itself later, so the failure surfaces on an unrelated read. HLS hands out
  per-segment refs it lets the registry reclaim by design, so the warning is suppressed there.
- **`chunksOf(segment, init?)`** returns each chunk as
  `{ offset, size, decodeTime, trackId, duration, independent }`. A chunk runs from the first box after
  the previous chunk through its own `mdat`, so `styp`, `sidx`, `prft` and `emsg` belong to the chunk
  they *precede*. The chunks therefore tile the segment — their ranges concatenate back into exactly the
  bytes given, which is what lets them be published as `EXT-X-PART` byte ranges, and it keeps an `emsg`
  ad signal in the part it describes. Offsets are into the bytes given, so running it over
  `encryptCmafSegment` output states where the chunks landed *as served*. `duration` and `independent`
  come from the `traf`'s `trun`, falling back to the `tfhd` defaults and then the init's `trex`. **A
  `trex` field of `0` is read as stating nothing rather than as a value**: the format has no absent
  value for these, `0` is what a writer emits when it specifies no default, and a zeroed
  `default_sample_flags` would otherwise decode as "sync sample, depends on nothing" and publish a chunk
  as independent when it may open mid-GOP. An explicit `tfhd` default is honoured.
- **`buildEmsgBox(options)`** writes an `emsg` (23009-1 §5.10.3.3, version 0 for a delta or 1 for an
  absolute presentation time) and **`insertBoxesBeforeMoof(segment, boxes)`** inserts complete top-level
  boxes immediately before a segment's first `moof`, restating any preceding `sidx`'s `first_offset`.
- **CMAF/fMP4 segment primitives** — `isInitializationSegment(bytes)`, `getSegmentDecodeTime(bytes)`
  (first `tfdt` baseMediaDecodeTime, v0/v1) and `rebaseSegmentDecodeTime(bytes, deltaTicks)` (shifts
  every `traf`'s `tfdt`, returning a new buffer).
- **`getSegmentCompositionOffset(bytes, init?)`** — ticks past a fragment's `tfdt` at which its
  earliest-presented sample is shown. A `sidx` states an `earliestPresentationTime` while a `tfdt`
  states a decode time, and the two differ wherever an encoder emits B-frames, so a source indexed by
  `sidx` and one scanned for `moof`s otherwise describe timelines that do not line up.
  `getSegmentDecodeTime + getSegmentCompositionOffset` is what the `sidx` reports. Three things make it
  more than a `ctts` lookup: it is the smallest *sum* of a sample's decode offset and its composition
  offset (the smallest offset alone is 0 in any normal GOP); per-sample durations are routinely absent,
  so they come from the `tfhd`'s `default_sample_duration` and failing that the `trex`; and a version 1
  `trun` states the offset signed. The optional init matters because a DASH-IF Interface-1 receiver
  holds init and media under separate keys — without it a fragment whose durations live only in the
  `trex` collapses to the smallest composition offset, answering 1001 where the index says 2002.

## Manifest transform substrate — parse → transform → serialize

A format-agnostic pipeline over the DASH (`Mpd`) and HLS (`HlsPlaylist`) ASTs: parse a manifest, run
composable pure transforms, serialize it back. HLS round-trips losslessly; DASH keeps every attribute
the MPD schema defines on the elements it models.

- **Facade:** `parseManifest(text, options?) → Manifest` (sniffs HLS vs DASH),
  `serializeManifest(manifest) → string`, `pipeManifest(manifest, transforms) → Manifest`. `Manifest`
  is a discriminated union; `ManifestTransform = (Manifest) => Manifest`. Transforms are **pure**: a
  new manifest is returned with every untouched subtree shared by reference, so one parsed base spawns
  many variants cheaply.
- **Serializers:** `serializeMpd(Mpd)` and `serializeHls(HlsPlaylist)`, reusing `XmlNode` / `Tag` and
  the shared duration and float formatting.
- **Cross-format rendition filtering:** `Rendition` is a read-only view of a selectable rendition
  (DASH Representation, HLS variant, or `#EXT-X-MEDIA` group) so one predicate works against both. A
  DASH rendition inherits `@width`, `@height` and `@audioSamplingRate` from its AdaptationSet when the
  Representation states none, alongside the `@codecs`, `@frameRate` and channel configuration it
  already inherited — so a resolution filter still sees dimensions declared once on the set (the
  USP-style layout) instead of reading them as absent and keeping every rendition.
  `filterRenditions(predicate)` is the core; `dropCodecs`/`keepCodecs`, `capResolution`,
  `filterBitrate`, `filterFramerate`, `filterChannels`, `dropByColorRange` and `dropSubtitles` compose
  over it. Dropping an HLS media group prunes now-dangling variant group references.
- **URL and structure rewrites:** `mapSegmentUrls((url, kind, index) => url)` rewrites every
  media-referencing URL by `SegmentUrlKind`; `rebaseManifest(base)` resolves relative URLs against a
  new base, preserving the DASH BaseURL chain; `toSegmentTemplate(build)` repackages single-file
  (`SegmentBase`) representations as `SegmentTemplate` + `SegmentTimeline`.
- **DRM signalling:** `drm(options)` injects content protection into a parsed manifest, and
  `drmAdaptationSet(set, options)` returns one DASH `AdaptationSet` signalled the way `drm` signals
  every set of every Period. Each format's rules live in one core shared with
  `buildContentProtections` / `buildHlsKeys` (from scratch) and `patchMpdContentProtection` /
  `patchMediaPlaylistKeys` (format-preserving in-place patch).

**Round-trip fidelity for DASH** is checked by an **attribute-set comparison per element** rather than
by value assertions — a parsed-but-never-written attribute is invisible to those. It matters most where
the schema supplies a default: `Period@bitstreamSwitching` and `AdaptationSet@bitstreamSwitching`
default to `false`, so dropping a written `true` inverted it, and both are modelled as `boolean | null`
for that reason.

**Elements, not just attributes.** An attribute audit cannot see a whole element go missing, and for a
long time 44 of the schema's 66 elements were parsed by nothing and emitted by nothing —
`<EventStream>` and `<Event>` among them, so an SCTE-35 signal in a real Unified Streaming manifest was
dropped silently. All 66 are modelled, guarded by a fixture carrying every one and an element-set
comparison. `<Event>` is declared `mixed` with `xs:any namespace="##other"`, so its foreign-namespace
children — an SCTE-35 `<Signal>` subtree and its `xmlns` — are kept verbatim rather than re-encoded
from a typed model.

**What DASH does not preserve.** Equivalent reformatting is not loss and is not preserved:
`PT1M0.288S` → `PT60.288S`, `frameRate="25/1"` → `25`, `1970-01-01T00:00:00Z` → `…00.000Z`, and spec
defaults such as `SegmentTemplate@startNumber="1"` are written only when they differ. Attribute order
is not preserved, comments and whitespace are dropped, and foreign content at the schema's extension
points is not kept except inside `<Event>`. `xmlns:cenc` is emitted with the `cenc:` content that needs
it, so a declaration with no such content is dropped.

**Reading and generating, not editing.** If you are changing a document you did not create, you need
everything you did not touch to survive byte for byte, and an AST that re-emits from a typed model
structurally cannot promise that however complete the model becomes. Use a DOM that mutates and
re-serializes the original document for that. Parsing to read, and building to generate, are what these
ASTs are for.

Without a global `DOMParser`, `parseMpd` uses its built-in XML parser; `parseMpd(xml, { domParser })`
accepts another implementation.

## Player and tool limitations worth knowing

Findings about third-party players and tools, recorded so they are not re-investigated. None is a fork
defect.

- **shaka-player 5.2.10 cannot parse a ClearKey-only HLS playlist** (error 4026,
  `HLS_KEYFORMATS_NOT_SUPPORTED`). Its HLS parser recognises only `identity`, FairPlay, Widevine and
  PlayReady. A ClearKey proof over HLS therefore has to signal Widevine and hand shaka the key through
  `drm.clearKeys`.
- **Bento4's `mp4decrypt` ignores `seig`**, so a segment encrypted under a rotated key cannot be
  verified with it even when both `kid:key` pairs are supplied. Key rotation is better proven at box
  level, plus showing that the previous key no longer reproduces the clear bytes.
- **hls.js 1.7.3 never fetches a part by byte range unless parts outlive their segment.** Its
  `shouldLoadParts` requires `bufferEnd >= partList[0].end + fragmentHint.duration`; when an origin
  lists parts only for the segment in progress, `partList[0]` and `fragmentHint` are the same segment
  and the threshold cannot be met. Parts must stay listed for three target durations past their segment
  (RFC 8216bis 6.2.2). This fork emits no part tags itself, so this is a trap for whoever writes those
  playlists.

## Forensic A/B watermarking signalling

Signalling only, per **DASH-IF Forensic A/B Watermarking (ETSI TS 104 002 V1.1.1)**. The fork sits at
the spec's *packager*: it consumes A/B variants and emits the ingest manifests and per-segment
metadata the origin and CDN edge read. Embedding the watermark is the transcoder's job and is
deliberately not here. Selecting A or B per request is the CDN edge's job, driven by a signed WM token,
and manifests served to devices are *neutral* — one cacheable manifest for everyone, with no variant
names in it. Nothing here is per-session.

**Per-segment metadata.** `WmPaceInfo` models the spec's structure
(`watermarked`/`variant`/`position`/`firstPart`/`partCount`, each spec field named in its docblock);
`encodeWmPaceInfo` / `decodeWmPaceInfo` are the 48-bit wire form, including the two emulation bits
fixed at 1 so the structure can never form a start code; `wmPaceInfoBox` returns a complete `wmpi` box
ready to prepend to a segment, and `readWmPaceInfo` finds one or returns `null`. The byte layout is
pinned against the spec's worked example rather than only round-tripped, because a round trip agrees
with itself even when the bit packing is wrong in both directions.

**DASH ingest signalling.** `variantSchemeIdUri('a')` and `variantFromSchemeIdUri` build and read the
`watermarking_variant#<letter>` scheme; `WM_PACE_INFO_SCHEME_ID_URI` is the sidecar pointer's scheme.
These are URIs for `EssentialProperty` descriptors the MPD model already carries generically, so no new
MPD surface was added.

**HLS ingest signalling.** `WATERMARKING-VARIANT` on `#EXT-X-STREAM-INF`
(`HlsVariant.watermarkingVariant`) and `#EXT-X-MEDIA` (`HlsMediaRendition.watermarkingVariant`), and
`#EXT-X-WMPACEINFO` as `HlsMediaPlaylistAst.wmPaceInfoUri`. It is *not* on
`#EXT-X-I-FRAME-STREAM-INF`: the spec signals variants on the two tags above only. Both parse and
serialize.

**Sidecar files.** `serializeWmSidecar` emits both addressing modes — `discrete` (a `segmentRegex` per
group of filenames) and `byterange` (`startRange`/`endRange`, which must also cover the initialisation
segment). Output uses the specification's field names (`iswm`, `pos`, `firstpart`, `nbpart`,
`WMPaceInfoObject`), not this library's, because it is interchange.

**Ingest → egress.** `neutralizeWatermarking()` turns an ingest manifest into the one devices receive:
it strips both DASH `EssentialProperty` schemes, the HLS `WATERMARKING-VARIANT` attributes and
`#EXT-X-WMPACEINFO`, and collapses the per-variant duplicates — one Adaptation Set per variant on the
DASH side, the paired `#EXT-X-STREAM-INF` / `#EXT-X-MEDIA` entries on the HLS side. Collapsing keeps
the first of each group and so its URI, which an origin will usually rewrite with `rebaseManifest`. A
manifest with no watermarking signalling comes back unchanged by reference.

It also strips signalling arriving as an *unmodelled* tag: HLS keeps every line the AST does not model
so a relay can write it back, which means a watermarking tag from a newer revision survives
neutralization in `unknownTags` and names the variants the modelled attributes no longer do. So any
unmodelled tag beginning `#EXT-X-WMPACEINFO` is dropped too, over the master's tags, each media
playlist's and each segment's. `WATERMARKING-VARIANT` needs no equivalent, being an attribute on two
modelled tags.

**The other carriers.** `wmPaceInfoSeiNalUnit` / `readWmPaceInfoSei` carry it as a
`user_data_unregistered` SEI under the spec's UUID `bec4f824-170d-47cf-a826-ce008083e355`, for AVC and
HEVC. `wmPaceInfoTsDescriptor` / `readWmPaceInfoTsDescriptor` build and read the
`temi_WMPaceInfo_descriptor` for an MPEG-TS adaptation field — with one caveat that is the
specification's: **`af_descr_tag` is unassigned**, printed as "[tbd]" in clause 5.3.3.5, so the tag is
a required argument, both ends must agree out of band, and nothing can interoperate until a value is
allocated. AV1 is not covered: the spec defers its SEI syntax to the UHD Forum document, which uses a
metadata OBU rather than NAL framing.

**Entry points**, since the surface grew carrier by carrier: `variantEncryptor`,
`readSegmentWmPaceInfo` and `readAllWmPaceInfo` (reading, whatever carrier), `wmPaceInfoBox` /
`wmPaceInfoSeiNalUnit` / `wmPaceInfoTsDescriptor` (writing — the carrier is a publisher's choice),
`zeroPadWmPaceInfo`, `neutralizeWatermarking`, `serializeWmSidecar`, `variantsAligned`, and the three
DASH scheme-URI helpers. The rest are primitives: `encodeWmPaceInfo`/`decodeWmPaceInfo` are the raw
48-bit codec, the per-carrier readers are what `readSegmentWmPaceInfo` tries in turn, and `variantIv`
and `encryptVariantSegment` are what `variantEncryptor` pairs for you.

**Zero-padding for egress.** Clause 5.5.4.2 requires an origin to strip the `WMPaceInfo` HTTP headers
and **zero-pad** in-band `WMPaceInfo` before a segment reaches a device. `zeroPadWmPaceInfo` zeroes the
payload and leaves the box header in place, **so not one byte moves** — removing it would shift
everything after it and invalidate byte ranges, the `sidx` indexing them, and the byte-range alignment
required between variants. `readWmPaceInfo` reports a padded box as absent rather than malformed. SEI
and MPEG-TS carriage is deliberately not padded: zeroing six bytes inside an SEI NAL can create a
start-code emulation needing re-escaping, which changes the NAL's length and defeats padding in place.

**Not implemented, and not ours:** WM token generation, which is JWT issuance and subscriber identity.
The spec also requires A and B to be byte-range aligned when segments are delivered as byte ranges, so
one `sidx` serves both; the fork does not enforce that and an encoder has to produce it.

### Encrypting the variants

The spec requires A and B to share a content key, so one DRM licence decrypts whichever variant a
viewer is served. That leaves the IV as the only separator, and it is load-bearing: two variants under
the same key *and* IV differ in ciphertext at exactly the bytes where their plaintexts differ — on a
real file, variants differing in 6 bytes differ in exactly those 6 of ~2 M ciphertext bytes, so XORing
the two locates the watermark with no key at all. With separated IVs ~99% of bytes differ.

`encryptVariantSegment` makes that unsayable rather than merely forbidden: it takes a `baseIv` and a
`variant` instead of an `iv`, and partitions `ivState` by variant internally, so two variants cannot
converge on a track's IV later either. `variantIv` is the derivation: the variant lands in the most
significant byte while the IV advances from the least significant end, so one variant's sequence would
have to run 2^56 samples (8-byte IV) or 2^120 blocks (16-byte IV) to reach another's start.

**`cbcs` is supported only against a per-variant init segment.** It is the one scheme without
per-sample IVs — its IV is a constant in `tenc`, in the init — so two variants sharing an init share
that constant. `encryptVariantSegment` reads the init's `tenc` and refuses unless it states this
variant's own IV; build it with `encryptCmafInit` using `variantIv(baseIv, variant)`. A per-variant
init is natural under byterange delivery; under discrete-file delivery the init is shared by design
(clause 5.3.4.2 requires its name not to match the watermarked-object pattern), so there cbcs cannot be
used at all.

**Even with per-variant IVs, cbcs hides a watermark far less well than cenc**, and this is what decides
the scheme. cbcs is pattern encryption — one block in ten for video — so most of a protected range
travels in the clear and is byte-identical between variants. On a real file with 200 marked bytes:
under cenc **0** are visible as isolated differences between two separately-encrypted variants; under
cbcs, **107**. IV separation fixes the pinpointing but cannot fix what pattern encryption leaves
unencrypted.

Share of `mdat` payload travelling **in the clear** across an ABR ladder — the share a watermark can be
read from without a key:

| bytes/frame | cenc | cbcs |
| --- | --- | --- |
| 9449 | 0.8% | 89.9% |
| 2090 | 1.2% | 89.8% |
| 1502 | 1.5% | 89.7% |
| 754 | 2.6% | 89.3% |
| 378 | 4.8% | 88.0% |

cbcs sits at ~89% on every rung, which is what a 1:9 pattern predicts and is independent of bitrate.
cenc's clear share *rises* as bytes per frame falls — six-fold from top rung to bottom — because each
NAL's clear header and the 16-byte alignment of its encrypted range are a larger fraction of a short
slice. So the bottom rung is both the most expensive to encrypt and the worst at hiding a mark, though
4.8% against 88% is still eighteen-fold. On much smaller pictures it narrows further (a 160x90 fixture
measured ~46% clear under cenc), so for very low renditions measure rather than assume.

**Prefer `cenc` or `cens` for watermarked content.** `cbcs` is permitted where a deployment needs
FairPlay from the same copy and accepts that a keyless observer can locate much of the mark — a
defence-in-depth loss rather than a break, since colluding subscribers can diff decrypted content
regardless, but it should be a decision rather than an accident.

## Encryption performance, and one idea that did not work

`NATIVE_CRYPT_THRESHOLD` in `src/crypto/aes-ctr-encryptor.ts` is the run size below which the JS
keystream beats constructing a native cipher. It is **256**, measured as the knee: timing cenc at
1024/512/256/128 across renditions put 256 ahead of 1024 by ~20% on low-bytes-per-frame content and
level on high-bitrate, with 128 regressing on both.

Which runs clear it is governed by **bytes per frame** (bitrate ÷ fps), because the threshold is in
absolute bytes — not by frame rate and not by scene cuts, which matter only through that ratio. Across
an ABR ladder: 9449 B/frame → 99.9% of encrypted bytes on the native path, 2090 → 91.4%, 1502 → 98.7%,
754 → 85.4%, 378 → 9.3%. Two traps in reading those numbers: median run size does not predict byte
share, because byte mass concentrates in a few large runs (one fixture has a 195 B median run and still
puts 92% of its bytes native); and byte share is a mechanism indicator, not a payoff predictor — moving
the threshold 1024 → 256 shifted byte share 46 points but time only 20%. The practical consequence is
that the **bottom rung of a ladder is the most expensive to encrypt per byte**.

**Rejected: one native cipher per IV epoch instead of per run.** Node's CTR cipher keeps its own block
offset, so a cipher created per sample and reused across that sample's runs produces the same keystream
while paying construction once — which should have dissolved the threshold. Measured, it is ~18–20%
faster on high-bytes-per-frame content and ~5–9% *slower* at the low end, which is the case it was
meant to fix. The premise was wrong: construction is not the only per-call cost, and `cipher.update()`
itself carries enough overhead that routing small runs through it loses to JS. A per-run size test is
therefore load-bearing. It also cannot be combined with a per-epoch cipher: once an epoch is native it
must stay native, because Node consumes the partial keystream block internally and the JS path cannot
resume mid-block. Committing an epoch to native based on its *first* run's size was not tried — it
trades a byte-identical-by-construction design for a heuristic whose failure mode is a desynced
keystream, which is a worse severity class than the slowness it buys back.

### Verifying a variant is byte-range aligned

Three shapes, because the useful one is not the obvious one:

- **`variantLayoutOf(source)`** derives a rendition's addressable structure — init range, segment
  ranges, and each top-level `sidx`'s references — by **seeking box headers rather than reading the
  media**, so a feature-length rendition is described without being materialised. About one small read
  per fragment; meant to be derived once and cached beside the source.
- **`layoutsAligned(a, b)`** compares two such layouts and is pure, so a transport can hold one per
  rendition and check a pair per request. `sourcesAligned(a, b)` does both.
- **`variantsAligned(a, b)`** is the whole-bytes form — convenient offline and unusable on an answer
  path, since it needs both renditions in memory. That signature is what decides whether the check is a
  safety net or an offline curiosity.

`variantLayoutOf` holds a `SourceRef` for the duration of its walk, because freeing a source's *last*
ref disposes it: a caller releasing one while the walk is in flight would dispose the source underneath
it. This matters more than it looks, because a layout walk is many reads spread over time, and the
asymmetry is easy to mis-generalise — a live `Input` survives a caller's free (it holds its own ref)
while a bare `readRange` does not.

All three segment a file exactly as `segmentsOf` does, which is load-bearing: a `styp` opens a segment
that may hold several fragments, and a file with no `styp` gets one segment per fragment. Starting a
segment at every `moof` instead agrees with `segmentsOf` on files without `styp` and disagrees on files
with it — visible only because a test compared the two walks on the same bytes rather than checking
each against its own expectation.

The comparison answers whether one set of byte ranges, and one `sidx`, addresses two renditions, naming
the first thing that differs with the segment index where there is one. A/B delivery needs it: a
variant that is *not* aligned gets served at the neutral content's offsets, which yields the right
number of bytes from the wrong places — a 200 response that decodes to garbage with nothing to
attribute it to. A rendition that does not parse is answered as not-aligned rather than thrown, since
this runs on publisher-supplied bytes on a verification path.

**Reading a segment whatever carrier it used.** `readSegmentWmPaceInfo(segment)` returns the
`WmPaceInfo` from the `wmpi` box or from an SEI under the spec's UUID, located by that UUID rather than
by walking sample tables. `readAllWmPaceInfo(bytes)` walks a fragmented file and returns one
`{ offset, size, wmPaceInfo }` per segment plus the init, which is exactly the list a byterange sidecar
is built from. The structure can never need emulation-prevention escaping — its two fixed emulation
bits exist precisely so it contains no adjacent zero bytes — so the un-escaping there is a safeguard
against malformed input rather than a normal case.

## Upstream behaviour this fork changes

Fixes to upstream code rather than additions. Each is a candidate to report upstream; until upstream
takes it, the fork diverges here.

- **The MPEG-TS access-unit scan waits for one transport packet, then scans what arrived.** The
  AVC/HEVC scan asked `ensureBuffered` for a fixed 1024 bytes of elementary stream before looking for
  the next boundary, so it bought bytes past the boundary it was looking for. On a live feed those
  bytes have not been sent yet, so a complete access unit sits unemitted until they are; over a paced
  feed that is a stall a live encoder reads as a lost input. The scan now asks for one byte more than
  it holds, which pulls exactly one more transport packet, and then scans everything buffered up to
  the chunk size. End of stream is the request coming back short, which the chunk constant was doing
  as its second job; what is already in hand is still scanned, or the last access unit merges into
  the one before it. Packet timestamps, durations, sizes, types and sequence numbers are unchanged.

- **A missing decoder now says so.** `Conversion`'s invalidity explanation had a branch for
  `no_encodable_target_codec` but none for `undecodable_source_codec`, so a conversion failing for want
  of a *decoder* fell through to a generic message opening with "its output configuration is invalid" —
  pointing the caller at the output when the cause is the input, usually that
  `registerMediabunnyServer()` was never called. There is now a symmetric decodability branch naming
  the source codec, the `@mediabunny/ac3` / `@mediabunny/dts` packages where they apply, and that call.
  The source codec is captured where the track is discarded, since the explanation is built
  synchronously and `InputTrack.getCodec()` is async.

  Unchanged, and worth knowing: when only *some* tracks are undecodable the conversion stays valid and
  silently drops them — an audio+video input transcoded without decoders yields an audio-only file.
  `showWarnings` (default `true`) is the only thing that surfaces it.

- **Liveness is the container's answer first, then the source's.** Every non-segmented demuxer returns
  a hardcoded `null` from `getLiveRefreshInterval()`, so `InputTrack.isLive()` was always `false`
  however the bytes arrived. But the same bytes are a file on disk and a live feed off a socket, and
  only the source knows which. The precedence is one line:
  `(await this._backing.getLiveRefreshInterval()) ?? this.input._reader.source._getLiveRefreshInterval()`
  — a playlist wins when it has an answer, otherwise the source answers. That covers every format at
  once, including fragmented MP4 arriving over a socket (DASH-IF ingest), and leaves the eight demuxers
  untouched, which is eight fewer files carrying a fork edit across a rebase.

  `Source._getLiveRefreshInterval()` is virtual and defaults to `null`; `ReadableStreamSource`
  overrides it to return its declared `liveRefreshInterval` only while `_endIndex === null`. Liveness
  therefore *ends* when the stream ends, as a playlist already behaves with `EXT-X-ENDLIST`. The
  practical consequence is that `Conversion` treats a live feed's duration as unbounded instead of
  waiting for an end that never arrives.

- **An audio transform no longer hides the encoder's backpressure.** `AudioSampleSource.add()` resolves
  once the encoder has taken the sample, which is how a caller awaiting each `add` stays within a packet
  or two of its encoder. With a `transform` stating a sample rate or channel count the sample goes
  through `AudioResampler` first — and the resampler accumulated **5 seconds** of output before calling
  `onSample`, so `add` resolved without the encoder having seen anything: 568 samples added against 81
  encoded, with the whole backlog paid at `finalize()`.

  The resampler sizes its buffer from the first input sample
  (`ceil(numberOfFrames * targetRate / sourceRate)`, floored at the interpolation overflow), so one
  `add` drives one `onSample`. The 5-second figure was arbitrary: the flush is lazy — it happens only
  once a write lands past the current buffer — so no buffer size can lose a write, and the padding that
  makes back-to-back resampled samples artifact-free is the `overflowFrames` region, not the buffer
  length. The video `transform` path has no such gap: `add` awaits straight through to `encodeSamples`,
  holding only the single frame a `frameRate` transform needs.

- **AVC field pictures no longer stop encryption.** `H264VideoSliceHeaderParser` threw
  `UnsupportedMediaError` on `field_pic_flag`, so every slice of a field-coded (PAFF) stream measured a
  clear header size of `-1`. The fix is the one bit the spec puts there: `bottom_field_flag` after
  `field_pic_flag` (H.264 7.3.3). Worth knowing for whoever tests this next: with that fixture's
  parameter set the header is always an odd number of bits, so the extra flag **never changes the byte
  count** — a size-only check cannot see it. What does see it is the quantizer, which shifts by a bit if
  the flag is skipped. x264 emits only MBAFF, so the fixture is hand-built by
  `scripts/build-avc-field-pictures.py` and carries headers only.

- **HEVC scaling lists no longer stop encryption.** `H265VideoSliceHeaderParser` threw the moment it met
  `scaling_list_data()` in either the SPS or the PPS. Both throws sat inside `parseSps`/`parsePps`, so
  they came back as `initialize()` returning `false` and every slice measured `-1`. The PPS case was the
  worse: `pps_scaling_list_data_present_flag` sits ahead of `lists_modification_present_flag` and
  `slice_segment_header_extension_present_flag`, which the slice header parse reads against. A
  `skipScalingListData` helper walks the structure (H.265 7.3.4) and discards the values. Reachable from
  a real encoder: `x265 --scaling-list <file>`.

- **Slice-header sizes are checked against ffmpeg, not against a round trip.** The clear slice-header
  size is where encryption begins, and encryption is symmetric — a stream encrypted from the wrong
  offset decrypts back to itself byte for byte, so no encrypt/decrypt test can see the mistake.
  `test/node/slice-header-sizes.test.ts` compares every video-slice NAL of five fixtures against
  `ffmpeg -bsf:v trace_headers`, committed as `_slice-header-sizes.json` (569 values) so CI reproduces
  it without ffmpeg. The derivation differs per codec: H.264 pads with `cabac_alignment_one_bit`, which
  is *zero* or more bits, so slice data starts in the byte the fields end in; H.265's `byte_alignment()`
  always writes an `alignment_bit_equal_to_one` first, so a header ending byte-aligned spends one
  further byte. 29 of 300 slices in one fixture sit exactly on that boundary.

- **`parseBoxes` decodes box headers through `eachBox`** rather than its own loop. That loop read a
  64-bit `largesize` from the **low** half of the field, so a box past 4 GiB truncated to a plausible
  small one, and it checked neither that a size covered its own header nor that it stayed inside its
  parent — a size of 4 walked misaligned and produced boxes with three-space types, and a size of
  999999 in a 16-byte buffer was followed. `eachBox` already handled all three. The >4 GiB case needs a
  value above 2^32 to show at all, since anything smaller survives the truncation intact.

## Fragmented reads resolve the base against the `mdat`

The demuxer applied §8.8.7's implicit rule literally: a `traf` stating neither `base_data_offset` nor
`default-base-is-moof` was based on the end of the previous `traf`'s data. On a file that omits the
flag but still measures from the `moof`, that reads the audio out of the *next* fragment's `mdat` —
and once past the last one, the reads simply stop. On `bear-640x360-av_frag.mp4` it returned **88 audio
packets instead of 119**, every one of them the wrong bytes, with no error anywhere: the offsets are in
range, the samples decode, and only a comparison against what the `traf`s name sees it.

`realignImplicitBases` resolves it where the answer exists. It runs in `readFragment`, after the `moof`
is parsed and the `mdat` header is readable, and shifts a `traf`'s samples to the `moof` base when the
implicit one names bytes outside the `mdat` and the `moof` names bytes inside. A fragment is realigned
once, including on the cached path, and when neither base fits nothing is touched. The same resolver
decides the encryptor's cipher positions and the Smooth Streaming shift, so a file reads, encrypts and
gets spliced against one answer.

Every fragmented file in `test/public` is held to it: each track's packets are partitioned by the
sample counts its `traf`s name, and each one has to be found inside the `mdat` of the fragment that
named it — searched in that `mdat` alone, so a hit elsewhere cannot stand in for it. An encrypted
fixture is exempt, since the demuxer hands back plaintext its `mdat` does not hold, and the exemption
is checked rather than asserted: the file has to actually carry CENC boxes.

## Smooth Streaming fragment surgery

MS-SSTR's `tfxd` and `tfrf` are `uuid` boxes that live **inside the `traf`**, so `insertBoxesBeforeMoof`
is the wrong tool — it writes top-level boxes, where no Smooth client looks.
`insertBoxesIntoTraf(segment, trackId, boxes)` puts them in the right place and restates every offset
the growth moves; `buildTfxdBox({ time, duration })` and `buildTfrfBox([...])` write the boxes, version
1, so every time field is 64-bit.

They go in **after the last `trun`**, not at the end of the `traf`: the encryption path's
`writeAuxInfoOffsets` derives each `saio` from the end of its `traf` minus the size of the `senc`,
which only holds while `senc` is the last child.

What decides whether an offset moves is **whether a `traf`'s offsets are measured from the `moof` at
all** (14496-12 §8.8.7), which `baseDataOffsetsOf` answers for the whole fragment at once. A stated
`base_data_offset` is a file offset that absorbs the same shift, so offsets against it must not move;
`default-base-is-moof` names the `moof`, so they must; with neither flag the base is the `moof` for the
fragment's **first** `traf` only, later ones measuring from the previous `traf`'s data end. Getting
this wrong leaves every box size consistent and every offset self-consistent while handing back the
wrong samples, so sample identity is the only check that sees it.

**The `mdat` settles the third case.** Writers commonly omit `default-base-is-moof` and still measure
every `traf` from the `moof`; `bear-640x360-av_frag.mp4` is one, and read implicitly its audio lands
26020 bytes past the end of its own fragment. Measured from the `moof` the two `traf`s fill that `mdat`
exactly — 25648 video plus 5037 audio is the 30685-byte payload — so the fragment's own geometry says
which reading was meant. Nothing else can tell the two apart from the flags alone.

Also restated: `traf` and `moof` sizes, a `tfhd` `base_data_offset` from the grown `moof` onward, and
the `referenced_size` a preceding `sidx` states for this fragment.

**Only the target `moof` is parsed into a box tree**; the rest of the segment is copied through as
bytes. `parseBoxes` copies every leaf's payload, and `mdat` is a leaf, so parsing a whole segment to
splice fifty bytes into a `traf` copied the media twice. Walking the top level with
`iterateIsobmffBoxes` finds the `moof`'s byte range without touching a payload: on a 202 kB segment,
**0.117 ms → 0.047 ms per call, and 311 kB of allocation per call → 188 kB**, which is now just the
output buffer.

One spec ambiguity is exposed rather than guessed at: MS-SSTR §2.2.4.5's ABNF says
`FragmentCount = UINT8` while its prose field table says 4 bytes. The default follows the ABNF, since
the prose on those pages carries other outright errors; `fragmentCountBytes: 4` switches it.

The `tfxd` bytes are checked against ffmpeg's own `-movflags isml` output rather than against this
library.

## Live network input — `NetworkSource`

`@mediabunny/server` exports `NetworkSource`, so an `Input` can read a live SRT or MPEG-TS-over-UDP/RTP
feed the way it reads a file:

```ts
const input = new Input({
	source: new NetworkSource('srt://0.0.0.0:9000?mode=listener'),
	formats: ALL_FORMATS,
});
```

It supplies bytes only; demuxing is unchanged. The socket opens on the `Input`'s first read.

**Bounds travel in the URL query**, because `avio_open2()` takes no AVOptions dictionary and node-av
exposes no other way to pass one. Each protocol names and scales its bounds differently, and FFmpeg
**ignores an option name it does not know without a word of complaint** — so a wrong name reads as
"this protocol cannot be bounded" while the infinite default stands:

| protocol | bounds the accept | unit | bounds a silent read | unit |
|---|---|---|---|---|
| `srt` | `listen_timeout` | microseconds | `timeout` | microseconds |
| `tcp` | `listen_timeout` | **milliseconds** | `timeout` | microseconds |
| `udp` | n/a | | `timeout` | microseconds |
| `rtp` | n/a | | *own socket* | — |
| `http(s)` | n/a | | `rw_timeout` | microseconds |

Every one defaults to **infinite**. `NetworkSource` takes `connectTimeout` and `readTimeout` in
seconds, defaults both to 30, and **overwrites** the mapped option names rather than defaulting them —
a caller-supplied value for one would reinstate the hang the class exists to prevent. Every other
query parameter stays the caller's. The table is also the protocol allowlist, so `rtsp://` is refused
although the bundled FFmpeg has it.

### `rtp://` reads MPEG-TS over RTP, over its own socket

`new NetworkSource('rtp://0.0.0.0:45127')` reads MPEG-TS over RTP (RFC 2250, payload type 33) — what
SMPTE 2022 feeds and MediaLive's RTP input carry — and yields only the transport stream. The RTP
header, CSRC list, extension and padding come off, RTCP is dropped, packets are reordered within a
16-packet window, and **a gap stays a gap**: a TS reader resynchronises on the next sync byte, and a
fabricated packet would not let it. There is no FEC.

It binds its own UDP socket rather than going through FFmpeg because depacketizing needs datagram
boundaries and AVIO does not keep them: `read(n)` loops until it has filled `n`, so a 2048-byte read
returns one and a half packets and `AVIO_FLAG_DIRECT` does not change it. RTP carries no length field,
so the boundary cannot be recovered afterwards. `parseRtp` and `seqDistance` live in
`packages/server/src/rtp.ts`, shared with `RistSource`; the reorder buffers are not shared, since
RIST's is time-based and holds packets so a NACK can still be answered.

Consequences of owning the socket: only the URL's port is bound, so RTCP sent to the port above never
arrives (RFC 5761 multiplexing onto one port is handled by the depacketizer); `connectTimeout` bounds
the wait for the first datagram and `readTimeout` the silence that ends the stream; and a UDP socket
has no EOF, so silence is the only end there is.

**RTMP is not supported here.** It parses its path as `app/playpath` and ignores query options, so
`rtmp://host:port/live/x?listen=1` returns `ECONNREFUSED` in under 5 ms rather than listening — it can
be neither bounded nor made to listen. `rtmps` cannot listen at all (`rtmp_listen not available for
rtmps`). A publisher needs a relay in front, or `RtmpSource`.

**An SRT connect error followed by success is not a defect.** A host resolving to more than one
address makes FFmpeg try each and log the failures: `Connection to srt://… failed (Input/output
error), trying next address`. Other builds word it `Connection setup failure: unable to
create/configure SRT socket`. Neither is suppressed — the line names a real failed attempt, and hiding
it would hide the case where every candidate fails. Treat it as a failed attempt and look for what
broke the previous one; a socket left bad by an earlier abort produces the same wording.

### Disposal, cancellation and what ends a stream

**There is no way to cancel a wait once it starts.** node-av exposes no
`AVFormatContext.interrupt_callback`, and its `AbortSignal` is a cooperative JS check, so nothing runs
while a native call is blocked in accept or connect. The timeouts above are the only defence, which is
why neither defaults to infinite. A test for a bound must assert failure both **slower than half** the
timeout and inside a ceiling — an upper bound alone passes on any instant failure, which is how RTMP
once looked bounded when it was only refusing to connect.

**Disposing a listener still waiting for a sender wakes the accept.** A pending accept outlives a
close and parks in native code until its own timeout (20 s measured), so `cancel()` satisfies it by
opening a write to the listener's own address: 10 ms against 20 s, and a stream's cancel at 0.8 s
rather than 29.4 s. This is not tidiness — a parked accept holds a libuv thread, so the process stays
alive for the rest of `connectTimeout`, and shortening that timeout only makes the listener close and
reopen while an encoder may be returning. `RtmpSource` does the same for the same reason.

**Disposing a connected source waits for the read in flight.** Freeing the I/O context under a blocked
native read aborts the process with `Invalid epoll ID`. `cancel()` marks the stream canceled, waits
for the pending read to settle and closes once; a pull resuming after cancel touches neither the
context nor the controller. Dispose is therefore bounded by `readTimeout`.

**A clean end is not a delivery receipt.** Packet iteration ending normally means the sender went
away, not that everything it wrote arrived: closing an SRT socket right after the last write discards
what is in flight (125 sent, 121 received, the missing four being the last four; a 300 ms drain
recovered all 125). Anything that must know the stream ended completely has to establish it from the
content.

**A sender must close its socket itself, and `Muxer.close()` does not.** It frees the format context
without closing the AVIOContext underneath, so the socket stays open until the sending process exits.
The order is the whole trick:

```ts
await muxer.getFormatContext().pb!.closep();
await muxer.close();
```

`pb` must close **before** `close()`, which frees the context and leaves the handle dangling; after is
a no-op. The receiver's end then lands within 10 ms rather than at process exit. The cost is that the
trailer write goes to a closed socket — free for MPEG-TS, which has no trailer, but this would
truncate a format that has one. This fork ships no network sink; it is a constraint on any sender
feeding a `NetworkSource`.

### Changes that came with live input

**MPEG-TS reports the PES decode time.** `readPesPacketHeader` parsed only the PTS even for
`ptsDtsFlags == 0b11`, so `decodeTimestamp` equalled `timestamp` for every packet — wrong for every
B-frame, and wrong where it is load-bearing: remuxing TS to CMAF needs a decode time to place a
sample. A PTS is a **40-bit** field holding a 33-bit value — a 4-bit prefix, three value runs and a
**trailing marker bit** — so a reader that skips the marker starts the following DTS one bit early and
produces timestamps near 2^32. `readTimestamp()` consumes all 40 and is shared by both fields. Only a
PES packet's first access unit carries timestamps; later ones report `null`.

**A segmented output's callbacks are awaited.** `onInit`, `onSegment` and `onSegmentPopped` return
`unknown`, so a promise was always expressible but nothing awaited it, leaving an uploading consumer
no way to apply backpressure. `onInit` fires from a `'finalized'` listener, which cannot await, so its
result is held on the playlist and drained before that playlist's first segment is announced — a
segment is unplayable without its init. No signature changed.

**Transforms absorb a source that changes, which is what they are for.** `AudioSampleSource` and
`VideoSampleSource` checked constancy on the sample they were *handed*, before any transform ran, so
`transform: { sampleRate: 48000 }` still failed with `Audio parameters must remain constant` the
moment the source rate changed — exactly what a failover between two inputs looks like, and exactly
what pinning the rate was meant to make irrelevant. The invariant belongs to what reaches the encoder,
so the check compares post-transform values. A transform stating only one video dimension leaves the
other derived from the input, so a change there is still denied.

**Interleaving no longer waits forever on a track that has gone quiet.** Every muxer paused all output
while any *open* track had an empty queue — right for a track that is behind, wrong for one that has
stopped. A live publisher whose audio goes quiet stopped sending video too. `maxInterleaveDelta`
bounds the wait in seconds of media, default **10**, as FFmpeg's option of the same name does; once
the other tracks are that far past the quiet one, it gets a gap. It sits on `MpegTsOutputFormatOptions`,
`IsobmffOutputFormatOptions`, `MkvOutputFormatOptions`, `OggOutputFormatOptions` and
`SegmentedOutputFormatOptions`, and `Infinity` restores the old behaviour. A subtitle playlist waits on
the same bound, using the media segment boundaries as its clock.

ISOBMFF and Matroska need it in **two** places: besides interleaving, both cut a fragment or cluster
only when every *other* track has a queued key frame or is closed, and a quiet open track is neither.
One `quietTrackMayBeSkipped(queues, timestampOf)` on the shared `Muxer` base covers both, with a
`maxInterleaveDelta` getter per format.

**Audio segments sit on the target grid instead of drifting off it.** An audio frame rarely divides
the target — 1024 samples at 48 kHz is 21.333 ms, so a 2 s target is 93.75 frames — and cutting at the
last frame that fits took 93, 16 ms short, with that error anchoring the next boundary: 0.992 s of
accumulated offset across 65 segments. The grid is now anchored to where the first segment began, so a
rounding error cannot become the next origin, and the cut goes to the frame **nearest** the boundary
rather than the last that fits, which is unbiased.

**`nextSegmentBoundary` puts the cut in the caller's hands.** Anchoring to a playlist's own first
packet fixes drift within one output but leaves two outputs disagreeing — every audio packet is a key
packet, so nothing else pins an audio cut. That rules out pipeline locking and splice-accurate cuts.
The option takes where the current segment starts and returns where the next should end, or `null` to
leave it to `targetDuration`; `start => Math.floor(start / 2) * 2 + 2` is a 2-second grid from zero.
It replaces the video deadline as well as the audio grid.

**A stated boundary cuts at the first packet at or after it, not the nearest** — the opposite of the
repeating grid, deliberately: a grid rounds either way because always rounding one way accumulates,
while a stated boundary is an instruction, and a segment opening before a splice carries media
belonging to the previous one. Two outputs 5.3 s apart agree on every boundary after the late one's
first partial segment.

This diverges from upstream, which is why `Segmentation, audio not lining up with segment boundaries`
carries different expectations here: upstream never exceeds the target, while nearest-frame can run up
to half a frame long. It stays spec-legal — RFC 8216 bounds each `EXTINF` rounded to the nearest
integer by `EXT-X-TARGETDURATION`, and `globalTargetDuration` tracks the longest segment.

**`HlsOutputSegmentInfo.isLast`.** A playlist can cut no further segment once every track it holds is
closed and drained, so a segment written in that state is its last — decided when written, no
lookahead, exact per playlist, so audio resolves independently of video. Subtitles are driven by
boundaries, so theirs asks whether the boundary list emptied. It reads `false` in `getSegmentPath`,
since a path is chosen before the segment's media is written.

**`Conversion.finish()`** stops reading the input and lets the output finalize, so the in-flight
`execute()` resolves normally and the last segment is written. `cancel()` throws
`ConversionCanceledError` and discards the segment in progress, which cost a segment of latency to
anything that had to mark its last one.

**`ReadableStreamSource.end()`** is the input side of the same problem. A feed that stops sending
without closing leaves packets in the demuxer and frames in the decoder, and disposing the `Input`
rejects the parked read with `InputDisposedError` and abandons both. `end()` declares the byte stream
over where it has reached: the parked read and every later one resolve as reads past end of file, the
reader is cancelled, the demuxer emits what it holds including a last partial PES, the decoder
flushes, and the tracks stop reporting `isLive`. `NetworkSource`, `RtmpSource` and `RistSource` all
extend `ReadableStreamSource`.

**A feed cut mid-frame ends cleanly.** The MPEG-TS demuxer supplied whatever bytes had arrived for the
final audio frame, so a frame shorter than its own ADTS/MP3/AC-3/E-AC-3/DTS header declares reached
the decoder, which refuses it. `ensureBuffered` caps at the length asked for, so a short return is
precisely "the feed stopped inside this frame" and the frame is dropped. Underneath it,
`CallSerializer.call` stored the uncaught promise as the chain head, so one failed call rejected every
later one *without running it* — the `close()` queued behind a failed decode never closed the decoder.
The chain holds a caught promise now while each caller still receives its own rejection. That applies
to every custom decoder and encoder.

### Encoder controls

**`VideoEncoderControls`** on `VideoEncodingConfig.encoderControls` and
`ConversionVideoOptions.encoderControls`: `profile`, `level`, `preset`, `tune`, `maxBFrames`,
`closedGop`, `pass`, and an `options` escape hatch. A control the selected encoder has no option for
is **refused**, not dropped — a rung encoded without the profile it asked for is not that rung.
`options` goes to the codec context by FFmpeg's own option names, merging into `x264-params` /
`x265-params`; a key that would overwrite one this library needs for key frame alignment is refused,
since losing `scenecut=0` breaks alignment across a ladder.

Two-pass is `pass: { index, statsPath }`, the caller running two encodes over the same samples. It is
a field rather than something `options` can express: `pass=1` inside `x264-params` is ignored and so
is `flags=+pass1` through `setOption`, because FFmpeg drives it from the codec context's own flags.
Two-pass needs a bitrate target — x264 refuses it alongside constant quality.

**A `fullCodecString` the caller states is a request**, not only a label: `extractVideoProfileAndLevel`
reads the profile and level out of it (`avc1.42001e` is Baseline at level 3.0), and an explicit
`profile`/`level` is the more specific statement of the same thing, so it wins.

**The string this library derives for itself is not such a request**, and that distinction is
load-bearing. A derived level comes from size and bit depth — `hev1.2.4.L60.B0`, level 2, for a 144p
10-bit rung — and a level is not a label to an encoder: x265 holds the stream to its VBV limits,
capping an uncapped quality encode to 1.69 Mb/s, and refuses to open where the picture exceeds it. The
config carries `_codecStringIsDerived`, only a stated string reaches the encoder, and x265 is told
`level-idc=0` so it states the level the stream needs. x265 counts a level in tenths where the codec
string counts in thirtieths: `L153` is 5.1 is `level-idc=51`.

**`encoderControls.sceneCut`** — an intra frame at a cut without moving a sync sample. `false` by
default; 1 to 100 turns on x264's, x265's or SVT-AV1's detection. **Pinning `min-keyint` beyond any
real forced interval is the whole feature**: with detection on and nothing else, a cut past the
encoder's own minimum interval is promoted to a full IDR (x264 gave `IDR [0, 30, 48]` for a cut at
frame 30 against forced key frames at 0 and 48), which is a sync sample off the grid. Pinned, the cut
can only become an intra frame that is not a sync sample: `IDR [0, 48]`, `I [30]`.

The grid is a guarantee; **which cuts are detected is not** — it depends on content, and a cut into
high-entropy material may not trip the metric. SVT-AV1 takes `scd=1`. Every other encoder, hardware
included, refuses a stated `sceneCut` rather than ignoring it.

**`Quality` is readable**: `level`, `bitrate`, `quantizer`, `maxBitrate`, `bufferSize`, `bitrateMode`
and `preferBitrate` are public getters. There is deliberately **no `kind` discriminator** — a
`Quality` is not one of three things (`{ quantizer: 30, bitrate: 2e6 }` states the quantizer demanded
and the bitrate fallback for a codec that cannot encode by quantizer, and a cap is orthogonal to
either). Test each field on its own.

### Reading what the container does not carry

**`extractVideoBitDepth(codecString | VideoDecoderConfig)`** — the bit depth, or `null`. Given a
config it reads `bit_depth_luma_minus8` from the SPS in the `avcC`, or the field `hvcC` states
directly; **pass the config wherever there is one**. A profile only *bounds* the depths a stream may
use, and taking the bound for the value was wrong, not merely imprecise: `avc1.f4000c` is High 4:4:4
Predictive, which permits 8 to 14 bits and read as 10, so every x264 lossless 8-bit source read as
10-bit and a consumer inheriting the depth made every rung of its ladder 10-bit. HEVC's Range
Extensions profiles have the same ambiguity, where a 12-bit stream read as 8. `@mediabunny/server`'s
encoder keeps passing the string, and should: there it is an encode request with no SPS to read.
Without a config the profile is still all there is, so that reading remains the fallback.

**`readVideoSliceType(packetData, decoderConfig, codec)`** returns `'i'`, `'p'` or `'b'` for an AVC or
HEVC packet's first coded slice, or `null`. It is orthogonal to `EncodedPacket.type`, which says
whether a packet is a random access point but not how it is coded — the pair is what makes a
**non-IDR I-frame visible**, which is what `encoderControls.sceneCut` produces and what no container
field distinguishes from a sync sample. `decoderConfig` states the NAL length prefix size; Annex B is
walked by start code.

**`createAv1FilmGrainStateReader(description)`** reads the sequence header's
`film_grain_params_present` and each frame header's `apply_grain`. Stateful by necessity:
`apply_grain` sits at the end of the uncompressed frame header, past fields an inter frame reads out
of its reference frames' state, so a unit can only be read once those before it have been. Pass the
`av1C` description so the reader starts with the sequence header a stream's packets may not repeat.

**`createVideoQuantizerReader(codec, decoderConfig)`** reads the quantizer each coded picture states,
for AVC, HEVC, AV1 and VP9 — the number an encoder holding a bitrate actually varies, which is why
frame size alone ranks difficulty poorly. Slice and frame headers only. Every value it needs was
already parsed and discarded by the CENC slice-header and AV1/VP9 tile parsers, so it captures four
discarded values rather than adding a parser. It is a reader rather than a free function because every
codec needs state a single packet does not carry: AV1 and VP9 state the quantizer past fields taken
from reference frames, and an AVC or HEVC stream may replace its parameter sets in band. `scale` names
the scale — `'h26x'` for a 0-51 luma QP, `'qindex'` for AV1 and VP9's 0-255 index, which are not
comparable without conversion. `values` carries one per slice (or per coded frame where a packet holds
a hidden frame), `value` their mean.

Held against `ffmpeg -c copy -bsf:v trace_headers`, element for element, over four fixtures with zero
mismatches; the traced values live in `test/node/_video-quantizers.json` so the expectation comes from
a second implementation. Two things that caught: AV1 temporal units holding **two** frame headers,
where reporting the unit's last value dropped 8 of 90; and that **no HEVC encoder available here sets
`init_qp_minus26`** — x265 writes 0 and states the whole quantizer per slice, so a reader ignoring the
PPS term passed everything until the term was patched into a real PPS.

**`InputTrack.getPresentationOffset()`** — the span decoded but never presented, in seconds: media at
`t` is presented at `t - offset`, `0` where the container states none. It is an ISO BMFF edit list's
media time and Matroska's `CodecDelay`; both demuxers already subtracted it and neither said what it
was. Its usual cause is encoder delay — an AAC encoder emits 1024 priming samples a decoder needs and
a player discards. **The packets are deliberately still yielded, below zero**, because a decoder needs
them and a muxer copying the track must carry them; a reader wanting only the presentation drops
packets with `timestamp + duration <= 0`.

**No in-process VMAF.** There is no native build in this fork: every package is TypeScript and
`@mediabunny/server` gets FFmpeg from node-av's prebuilt binaries, whose build has `psnr` and `ssim`
but no `libvmaf` (`Filter.getByName('libvmaf')` returns nothing). Adding it would mean forking
node-av's FFmpeg build and shipping binaries per platform triple. No npm package ships libvmaf
bindings and no WebAssembly build exists.

## Timed ID3 — `addId3Metadata`

`addId3Metadata(output, { time, data })` writes one complete ID3v2 tag at a point on the media
timeline, and what carries it is the segment's business rather than the caller's:

- **MPEG-TS** — a PES packet on the PID `MpegTsOutputFormatOptions.timedMetadataPid` declares. The PMT
  lists it with `stream_type` 0x15 and a `metadata_descriptor` naming `ID3 ` as both the application
  and the metadata format, byte for byte what FFmpeg's `mpegtsenc` writes
  (`26 0d ff ff 'ID3 ' ff 'ID3 ' 00 0f`), and the PES uses `private_stream_1` — also FFmpeg's choice,
  read out of `mpegtsenc.c` rather than assumed. `timedMetadataPid` is sugar: the same stream can be
  declared through `privateStreams` with those descriptors by hand.
- **CMAF / fragmented MP4** — an `emsg` with scheme `https://aomedia.org/emsg/ID3`, exported as
  `ID3_EMSG_SCHEME`, written **ahead of the `moof`** of the fragment covering the time, with a version
  0 `presentation_time_delta` so the segment reads without knowing where it sits.

**The `emsg` is written by the fragment's own muxer, not spliced in afterwards.**
`IsobmffMuxer._addEmsg` queues a box that `finalizeFragment` writes immediately before it takes the
`moof`'s position — every sample offset in the fragment is measured from there, so a box written later
would shift the data the `trun`s already name. Splicing it in after the fact would also mean buffering
a segment that is otherwise written straight to its target.

**`addPrivatePesPayload` accepts a segmented output too**, the same way `addScte35Section` does: the
payload waits in the pipeline until the segment its time falls in is written, and like a cue, a tag is
placed in every variant rather than consumed by the first playlist to reach it.

The tests read each one back out of the bytes, check the tag survives byte for byte, check the `emsg`
precedes the `moof`, and assert the PMT's descriptor and `stream_type` as hex. Placing every tag in the
first segment instead fails two of them.

## Which timeline a metadata time is on

A segmented output shifts its own timeline: every packet and every segment window goes through
`mediaTimestampBase`, which defaults to **10**. The times queued by `addId3Metadata`,
`addPrivatePesPayload` and `addScte35Section` did not make that trip, so they were compared against
windows on a different clock. A tag written at 1.5 s — beside packets added at 1.5 s — fell before the
stream and was clamped into the first segment with a delta of 0. Not late: wrong, and silently.

**A time the caller states is on the same timeline as the media they add beside it.** Whatever goes to
`source.add` goes to `addId3Metadata`, and it is shifted the same way on the way out. This is a
behaviour change for anyone who had compensated by adding `mediaTimestampBase` themselves.

**A time a payload carries is not.** An SCTE-35 section's `splice_time` is on the transport stream's
own PTS clock, because that is the clock a receiver reads the section against, and the section is
written verbatim — shifting its placement would put it in a segment its own bytes disagree with. The
asymmetry is the point rather than an oversight.

**A time before the output's first packet is dropped**, with a warning naming it. There is no segment
it belongs in, and a tag placed at a time the caller did not ask for is worse than one that is missing:
a receiver acts on it. The old "more than one segment behind" warning is gone — it fired on correctly
placed sections, because it was comparing the two clocks above.

**`#EXT-X-DATERANGE` is dated by the splice, not by the segment carrying it.** A segment is a second
long and a break does not begin at its edge. The cue carries the time it was placed at, stated on the
timeline a segment's own `timestamp` is on, since that is what the playlist dates everything from.

## A sparse PID must not be read like a dense one

A cue stream carries two splices in fourteen seconds. `readSection` ends a section at the next
payload-unit start on the **same PID**, skipping everything between, so on such a PID it waits for a
packet seconds away — or, for the last section, for the end of the feed. Reading a cue PID that way
stalled both the per-track readers and metadata discovery itself: over a file nothing looked wrong,
because the bytes were already there, but over a paced `ReadableStreamSource` the first media packet
could not be yielded until the whole feed had arrived — video arriving 13.94 s late for a packet at
t=0.08, against 2.30 s without the cue PID.

`readSectionWithinItsOwnPackets` reads contiguously instead, stopping at the first foreign packet, and
compares what it got against the length the section states — `section_length` for a PSI section,
`PES_packet_length` for a PES. Only a section whose packets are **not** contiguous falls back to the
unbounded read, and nothing this library writes produces that layout, which is why the fallback needed
a hand-spliced stream to test: without it, a split section comes back truncated, which is worse than
slow.

**A file cannot test this.** The regression test serves 60% of the stream and then never resolves
another read, so a read that waits for more never returns rather than returning late; and it races the
whole open, not just the packet pull, because the stall hit discovery first. The control — the same
bytes with no cue PID — opens and yields its first packet.

## Reading in-band events back — `inbandEvent`

The write side has `addScte35Section` and `addId3Metadata`; the read side is one input event, since a
consumer reacting to a splice and one reacting to a tag want the same thing.
`input.on('inbandEvent', ...)` delivers `{ timestamp, scheme, data }`, with
`urn:scte:scte35:2013:bin` for a splice section and `https://aomedia.org/emsg/ID3` for a tag, matching
the `emsg` scheme the muxer already writes.

**A time, not a position.** A timed ID3 tag rides a PES packet with a PTS, so that is its time. A cue
section's time is the splice point it states itself — `pts_adjustment` plus the command's `splice_time`
— read out here so a consumer gets a time on the same timeline as the packets instead of parsing the
section and undoing whatever shift the stream applies. Where the section sits among the packets is
never what it means. A section naming no time at all still has none.

**Both PID sets survive the metadata filter and the per-track reader.** A section at the head of the
stream is only ever seen by metadata discovery, which stops once it has the tracks it needs; one past
that point is only ever seen by the reader walking packets for a track. So both paths announce, and a
`pid:time:payload` key keeps a re-read from announcing twice.

**What is read is the declared stream, not any payload that looks right.** An ID3 PID is one the PMT
declares with `stream_type` 0x15 *and* a `metadata_descriptor` naming `ID3 ` as both application and
metadata format; a stream declaring some other format is not read as ID3 even when its payload opens
with the magic, and a payload on a declared ID3 PID that does not open with the magic is ignored. The
tag starts after the PES header's optional part, whose length that header states — not at a position
derived from a section offset, which is a file position and reads past the end.

**Fragmented MP4 carries these as `emsg` boxes, and reading one needs the fragment behind it.** A
version 1 box states an absolute presentation time and is announced as soon as it is read. A version 0
box — which is what this library writes, so a segment reads without knowing where it sits — states a
delta from the earliest presentation time of the segment it precedes, so it is held until that fragment
has been read. The boxes are picked up by the scan that walks forward looking for packets, because that
is the only walk that passes all of them: reading metadata stops at the first `moof`.

**A version 0 `emsg` with no fragment after it is dropped, not dated by an earlier one.** Such a box
waits in a pending list until a fragment arrives to state its delta against. A trailing one never gets
that fragment — and the demuxer re-scans *backwards* when a forward scan satisfies nothing, so the next
`moof` it reads sits **before** the box. Dating it there announces an event at the start of the file
for a box at the end of it. The flush therefore skips a pending box whose position is past the
fragment's `moof`.

Reaching it takes a seek **past the end** followed by one backwards: the forward scan runs to EOF and
reads the box into the pending list, and the backward re-scan flushes against the first fragment. A
plain forward walk never reaches the box at all, and a full walk leaves every fragment cached so no
flush follows. `test/node/inband-events.test.ts` builds that shape over
`bear-640x360-av_frag.mp4`, with the same box one position earlier as the control — there it *is*
announced, against its own fragment. Removing the position test turns it red.

**A segmented input passes its segments' events up.** HLS and DASH read each segment through an `Input`
of its own, so `forwardInbandEvents` re-dates the event with the same `getMediaOffset` the segment's
packets get. Only a handful of those `Input`s are cached, so a segment read again after its `Input` was
evicted announces a second time — the dedupe therefore lives on the `SegmentedInput`, keyed by what the
event is rather than where it was found, and bounded, since a live stream never ends.

**A playlist date range is a splice too.** A CMAF segment has no cue stream, so for a fragmented-MP4
HLS output `#EXT-X-DATERANGE` is the *whole* signal. `SCTE35-CMD`, `SCTE35-OUT` and `SCTE35-IN` each
carry a `splice_info_section` as a hexadecimal-sequence (§4.4.5.1), and all three are read. A range is
placed by its `START-DATE` against the playlist's wall clock, not by where its tag sits: writers
commonly list every range at the head of the playlist. Where the playlist states no wall clock, the
tag's position is all there is. Dating these needs the first segment's offset, so they are held until
the playlist has a segment — asking for that offset while it has none re-enters the playlist update and
waits on itself.

**A DASH manifest's `<EventStream>` is the same gap.** A period's events are announced from the
manifest: an `<Event>` is placed at
`PeriodStart + (@presentationTime - @presentationTimeOffset) / @timescale` (23009-1 5.10.2.2), and its
payload is the SCTE-214 `<scte35:Binary>` inside its `<Signal>` where it has one — which names the
event `urn:scte:scte35:2013:bin` whatever the stream's own `@schemeIdUri` says — otherwise
`@messageData` or the element's text, base64-decoded when `@contentEncoding` says so. An event with no
payload is not announced: it signals through its scheme and attributes, and this hands over bytes.

**The dedupe is the `Input`'s, not each reader's.** A presentation with separate video and audio has a
`SegmentedInput` per variant or Representation, all reading the same playlist, so a per-instance set
would let each announce the same event again. It hangs off the `Input` in a `WeakMap`.

**The same splice signalled twice is one event.** A transport-stream output writes the section down the
cue stream *and* into the playlist, and a cue stream repeats it besides. SCTE 35 makes a section unique
by its `splice_event_id`, so `SCTE35_BINARY_SCHEME` events are deduplicated on the section alone, where
every other scheme is deduplicated on the section and its time — the same ID3 tag at two times is two
tags. The playlist is read before any segment, so the copy that states a time is the one that stands.

## SCTE-35 into a segmented output

`addScte35Section(output, section)` accepts a **segmented** output whose `segmentFormat` is
`MpegTsOutputFormat`, not only a plain transport stream. Such an output has no one stream to write
into — it opens a muxer per segment — so the section waits in `SegmentPipelineMuxer` until the segment
its splice point falls in is written, which is the segment a receiver reaches it by. The splice point
comes from `parseSpliceInfoSection`.

**Splice times are on the output's own media timeline**, the one the segments carry.
`mediaTimestampBase` shifts that timeline — by 10 seconds for HLS by default — so a time taken from the
input's timeline lands that much early. It is written anyway, because a cue arriving after the media
around it is an ordinary live occurrence, but a cue more than one segment behind is **named in a
warning** saying which timeline it should have been on.

**A splice is placed by the segment's cut, not by how far its tracks reach.** The window used to end at
`maxEndTimestamp` — the furthest any track's last packet reaches — and an audio frame routinely
overhangs the video cut by a few milliseconds (cuts at 11.0000 and 13.0000 against ends of 11.0027 and
13.0080). A splice stated *exactly* on a boundary, which is the normal case, therefore landed in the
segment **before** the one that starts there, and its `START-DATE` disagreed with the section's own
`pts_time`. The window now ends at the first packet that is not in the segment; the last segment keeps
everything still queued.

**A cue reaches every variant.** Each writes its own segments, so the pipeline records which playlists a
section has already gone into rather than consuming it on the first — a player switching bitrate
mid-break would otherwise miss its end.

A cue whose splice never falls inside a segment is named at finalize rather than dropped in silence. A
CMAF segment has no cue PID to carry a section at all; that is not an error, since the playlist marker
is the part a player reads, so such a cue counts as taken rather than lost.

### `Scte35Section.outOfNetwork` and `.breakDuration`

A playlist marker needs more than the splice time: `#EXT-X-CUE-OUT` states how long the break runs and
`#EXT-X-CUE-IN` closes it.

- `splice_insert` states them itself — `out_of_network_indicator` in its flag byte, and
  `break_duration()` behind the splice time when `duration_flag` is set. The indicator stands even for
  an immediate splice: "now" is still out of network.
- A `time_signal` states them in a `segmentation_descriptor`'s `segmentation_type_id` (SCTE 35 table
  23). The start and end of each break run on consecutive values, but the parity shortcut is written
  down nowhere and the ranges around them do not follow it, so the eleven start ids are listed and the
  ends derived from them. `segmentation_duration` is 40 bits at 90 kHz, unlike `break_duration()`'s 33.

`null` means the section says neither, which a `splice_null`, a cancelled event, an encrypted section,
a `time_signal` carrying some other descriptor, and an open-ended break all legitimately do. Walking to
the descriptor needs the command's length, and `0xfff` means "unknown" — there is then no way to find
the loop behind it, so the fields stay `null` rather than being read out of the wrong bytes.

### Ad markers in the media playlist — `adMarkers`

The section in the transport stream tells an origin where the break is; the playlist tells the player.
`HlsOutputFormatOptions.adMarkers` defaults to `'none'`:

- **`'daterange'`** — `#EXT-X-DATERANGE` with the section's bytes as hex on `SCTE35-OUT` or
  `SCTE35-IN`, plus `PLANNED-DURATION` where the cue states one (§4.4.5.1). `START-DATE` is on the
  playlist's wall clock, so this needs `programDateTime` or epoch-relative tracks; without one the tag
  is **skipped with a warning naming the option** rather than written without a `START-DATE`.
- **`'elemental-scte35'`** — `#EXT-OATCLS-SCTE35` with the section as base64, then `#EXT-X-CUE-OUT`,
  `#EXT-X-CUE-OUT-CONT` on every segment inside the break, and `#EXT-X-CUE-IN` at its end.
- **`'elemental'`** — the same without `#EXT-OATCLS-SCTE35`.
- **`'none'`** — no marker; the in-band section is unaffected either way.

A break's state carries across segments, so the `CUE-OUT-CONT` line is derived by walking the written
segments rather than by looking at one in isolation.

**A cue that opens no avail gets no cue tags at all**, `#EXT-OATCLS-SCTE35` included: that line only
ever accompanies a `CUE-OUT` or a `CUE-IN`. **And `#EXT-X-CUE-OUT-CONT` is keyed on what a segment's
cues *do*, not on it having none** — a segment inside a break that carries an unrelated heartbeat is
still inside the break. **A cue that opens no avail is `SCTE35-CMD`, never `SCTE35-OUT`**: §4.4.5.1
names three attributes and `CMD` is the one for a section that neither opens nor closes a break.

### Which types open an avail is the caller's to decide

`addScte35Section(output, section, { outOfNetwork, breakDuration })` states the answer directly and
beats whatever the section is read as. A MediaTailor deployment and a broadcast playout disagree about
Ad Block and overlay types, and a packager that has already made that decision must not have it
re-derived differently here.

The derived default is the avail set **MediaLive and MediaTailor document**: `0x22`, `0x30`, `0x32`,
`0x34`, `0x36` and their ends. It is deliberately narrower than "every type whose name ends in Start" —
a Program, a Chapter, an Ad Block (`0x44`/`0x46`) and an overlay placement opportunity (`0x38`/`0x3a`)
all have start and end ids and none opens a linear break. `Scte35Section.segmentationTypeId` reports
the raw id either way.

Only the marker is affected. The section itself is written into the transport stream verbatim, since
it is the caller's bytes.

## SCTE-35 on the write side

`new MpegTsOutputFormat({ scte35Pid })` declares a cue stream, which puts it in the PMT with stream
type **0x86** and the `CUEI` registration descriptor — the registration is what tells a cue stream from
the Blu-ray use of that same type. `addScte35Section(output, section)` writes a `splice_info_section`
into it, verbatim and CRC included, since composing a splice is a decision this library has no part in.
`readScte35Sections` reads them back.

The section layout was taken from tsduck's own serializer: `table_id` 0xFC, then `protocol_version` u8,
`encrypted_packet` 1 bit, `encryption_algorithm` 6, **`pts_adjustment` 33**, `cw_index` u8, **`tier`
12**, `splice_command_length` 12, `splice_command_type` u8, trailing CRC_32. It is a **private section,
not a PES packet**, so the muxer's existing `writePsiSection` carries it.

**No time argument, deliberately.** SCTE 35 carries the splice point in `pts_adjustment` plus the
command's `splice_time`, so a caller controls placement by when it calls and a receiver reads the time
out of the section rather than from its position.

A section handed over before the tables exist is **queued**, not written: a track has no data until its
first packet is added, so writing the PMT at that moment would publish one naming the cue stream and
none of the media. The queue goes out right behind the first PMT. Five of seven mutations are red, and
the two that are not are stated in the test file — a stream of 20 packets never flushes its tables
before `finalize`, so the branch that writes a section once the tables already exist is the live-stream
path and is not reached there.

**A cue PID does not warn.** The demuxer surfaces no track for a stream type it cannot packetize and
says so once per type, which on every segment carrying a cue PID was a warning about the thing the fork
reads itself. A `0x86` entry carrying the `CUEI` registration is passed over silently; the same type
without it still warns, that being the Blu-ray use and genuinely unsupported.

## MPEG audio Layer II — `mp2`

`mp2` is an audio codec of its own here, encodable through `@mediabunny/server` and carried in
MPEG-TS, Matroska, MP4 and MOV. Layer II frames are self-contained — no bit reservoir — so unlike
Layer III it needs no pre-roll, and its frames are 1152 samples in every MPEG version.

**No container states the layer, so the frame header is what decides.** MPEG-TS stream types 0x03 and
0x04 name the MPEG *version*, and an MP4 `esds` object type indication of 0x6B or 0x69 says the same —
all of them cover Layers I, II and III alike. `readMpegAudioCodec` reads the `layer` field out of the
first frame header, which is how ffprobe does it too. On the write side both go out identically:
stream type 0x03 for TS, `mp4a` with object type 0x6B for MP4.

| container | sample entry | `esds` | ffprobe `codec_name` | we report |
|---|---|---|---|---|
| MOV | `.mp2` | none | `mp2` | `mp2` |
| MKV | `A_MPEG/L2` | — | `mp2` | `mp2` |
| MPEG-TS | stream type 0x03 | — | `mp2` | `mp2` |
| MP4 | `mp4a` | 0x6B | **`mp3`** | **`mp3`** |

**MP4 cannot label it, and that is not ours to fix.** QuickTime has its own `.mp2` sample entry which
names Layer II outright; MP4 has no equivalent, so the object type is all a reader has there, and
ffmpeg's mp4 muxer refuses the QuickTime entry (`Tag .mp2 incompatible with output codec id`). Writing
MP2 to MP4 therefore produces a file ffprobe calls `mp3`, byte for byte what ffmpeg writes.

Reading it back from an MP4 could be made to say `mp2` by sniffing the first frame, and deliberately is
not: the codec is settled from the `moov` alone, before any sample is read, and `InputTrack` still
exposes a **synchronous** deprecated `codec` getter beside the async `getCodec()`. A lazy sniff would
make the two disagree, and an eager one would read a sample during metadata parse for every `mp4a.6B`
track. Use MOV, MKV or TS where the label matters.

**A behaviour change on the read side.** Stream types 0x03/0x04 and `mp4a.69`/`.6B` were reported as
`mp3` unconditionally before. A Layer II stream now reports `mp2`. Layer III is unaffected, and Layer I
still reports `mp3` — there is no codec of its own here for it.

A Layer III stream through the same stream type 0x03 is the control, so the layer is demonstrably what
decides.

## HDR10+ passthrough — `VideoSample.hdr10Plus`

HDR10+ (SMPTE ST 2094-40) dynamic metadata survives a decode and re-encode: a decoded `VideoSample`
carries the T.35 payload on `hdr10Plus`, and an HEVC encode writes it back as a prefix SEI ahead of the
frame's VCL NAL units. `clone` keeps it, as it does the Dolby Vision RPU.

**It is read from the bitstream, not from frame side data, and that is forced rather than chosen.** The
obvious route is `AV_FRAME_DATA_DYNAMIC_HDR_PLUS` plus `av_dynamic_hdr_plus_to_t35`. node-av binds the
constant but no T.35 conversion, and what `getSideData` returns is **11304 bytes, byte-identical on
every frame** — `sizeof(AVDynamicHDRPlus)`, the in-memory struct, where a real T.35 payload is tens of
bytes and changes per frame. Serialising that struct by hand would mean reimplementing libavutil's
conversion against an ABI layout that is not a wire format.

Consequences worth stating:

- **HEVC and AV1.** AVC carries no HDR10+ in practice; a sample stating it on any other codec is
  dropped with one warning rather than failing the encode, because an ABR ladder hands the same sample
  to every rung.
- **Container-only carriage reads as `null`.** The payload is taken from the bitstream, so metadata
  carried only by a container with no SEI is not seen. The field's documentation says so, so a `null`
  is not mistaken for "no HDR10+".
- **The decoder reorders, so the payload is keyed by packet timestamp** and claimed when its frame
  emerges, rather than attached to whatever frame comes out next.
- **`user_data_registered_itu_t_t35` has one owner.** Payload type 4 carries ATSC A/53 captions as
  well, so the constant lives in `sei.ts` and both read it. The discriminator is the payload's own
  header — provider 0x003C and application identifier 4 for HDR10+, provider 0x0031 and `GA94` for
  captions.

**AV1 carries the same payload in a `METADATA_TYPE_ITUT_T35` metadata OBU**, so `hdr10Plus` holds the
same bytes whichever codec carried them. Two details of AV1's framing: the payload is preceded by a
leb128 `metadata_type`, and §5.8.1 follows it with `trailing_one_bit` — the byte `0x80`, since the
payload is byte-aligned. That byte is framing, not payload, so it is stripped on read and written back
on build; leaving it out produces OBUs FFmpeg rejects with `trailing_one_bit out of range`. The OBU is
inserted **after** a leading temporal delimiter, so it sits inside the temporal unit it describes.

The AV1 fixture is not something this library wrote. An HDR10+ source re-encoded to AV1 by ffmpeg
carries nothing, so the fixture was built by injecting **real payloads lifted from the HEVC source**
into an SVT-AV1 stream. That ordering matters: injecting invented bytes made ffprobe report zero
frames, which reads identically to "ffprobe cannot see AV1 T.35" and would have sent the feature down a
fallback path. With real payloads it reports all of them, so **ffprobe is a sufficient oracle for AV1
as well**.

**The intermediate AV1 is encoded all-intra, and that is load-bearing.** SVT-AV1 otherwise emits hidden
alt-ref frames that a bare `OBU_FRAME_HEADER` re-displays via `show_existing_frame`. Metadata does not
follow a re-display, so the frame count carrying ST 2094-40 depends on how a given version counts those
— the first fixture measured **8 locally and 11 on CI**, which failed a release. `-g 1` removes hidden
frames and the count is 8 everywhere. `scripts/build-av1-hdr10plus-fixture.py` rebuilds it, parsing the
HEVC fixture's SEI with its own parser so the fixture does not depend on this library being right.

The tests count with **ffprobe**, not by reading our own output back. Removing the HEVC read fails
three; removing its splice fails only its re-encode; removing either the AV1 read or the AV1 OBU
insertion fails exactly one each.

## The decode anchor is a track constant across segments

A segmented output opens one `Output`, and so one ISO BMFF muxer, **per segment**. The anchor a
below-zero decode timeline is shifted by is settled from the first packet that muxer sees — so segment
1 settled on the shift and wrote it into the init's `elst`, while every later segment, whose own first
decode time is positive, settled on zero. Read under that same `elst`, segments 2 and on presented one
reorder delay early: on `demo.mp4` with a 2 s target, `tfdt` 0, 110592, 225792 and presentation 0,
**1.92, 3.92** where the key frames were fed at 0, 2, 4. A live encoder sees a 40 ms step back at every
segment boundary and two locked pipelines disagreeing by the delay.

The anchor is settled once and reused: `IsobmffMuxer._decodeAnchors()` reports what each track settled
on and `_seedDecodeAnchors()` takes it, with `SegmentPipelineMuxer` carrying the map between segments.
Two details the first attempt got wrong:

- **Only a fragmented muxer's anchor is a track constant.** It is `min(anchor, 0)`, so it is the
  sub-zero shift and nothing else. A progressive per-segment file rebases to its own first sample,
  which is its own business — seeding that shifted every later segment back onto the first one's start.
- **A track settles when its own queue flushes**, so the map is filled per track after each segment
  finalizes rather than taken whole from the first. Taken whole, a segment carrying audio and video
  stored the audio anchor alone and the video kept recomputing zero.

`test/node/segment-decode-anchor.test.ts` runs the matrix — {VOD, live} × {`mediaTimestampBase` 0 with
a negative first decode time, base 5} × {video only, video + audio} — and for every segment reads the
first presentation time back out of init + segment with **both** this library's demuxer and `ffprobe`,
asserting it is a **key frame's** own fed timestamp. That last part matters: asserting merely that it
was *some* fed timestamp passes with the bug in place, since 1.92 is a delta frame's time on a 25 fps
grid.

### `getSegmentPresentationTime(segment, init)` and `IsobmffTrackInfo.editMediaTime`

Once every fragment carries the shift,
`getSegmentDecodeTime(segment) + getSegmentCompositionOffset(segment, init)` is a **media** time, not a
presentation time: it sits the edit list's `media_time` past the presentation.
`getSegmentPresentationTime` is that subtraction, in the referenced track's own timescale, and
`IsobmffTrackInfo.editMediaTime` is the span on its own — the `media_time` of the first non-empty
`elst` entry, less any leading empty edit converted from the movie timescale, and `0` for a track with
no `edts`. Anything naming segments by time, indexing fragmented sources, or lining two renditions up
wants it.

Asserted three ways: against every row of the matrix above, against `ffprobe`'s own first presentation
time of an ffmpeg CMAF written with `-use_editlist 1` and B-frames, and — for a file with no edit list
— as exactly the sum it is built from.

**`rebaseSegmentDecodeTime` and `setSegmentDecodeTime` move the `sidx` too.** A `sidx`'s
`earliest_presentation_time` is on the same media timeline as the `tfdt` it indexes, and both moved
only the `tfdt`: a segment with `tfdt` 110592 and `earliest_presentation_time` 119808, rebased by
+4608, came out with `tfdt` 115200 and the index still on 119808. A progressive packager rebasing
segments onto a shared init's edit list then serves an index pointing at a presentation time the
fragment no longer has. Both versions of the field are handled, and a delta that would take it below
zero is refused.

## Why `PES packets preceding the PMT` expects different frames than upstream

Upstream's fix for #663 stops a reader dropping media that appears before the tables, and its test
asserts the frames read back as `[0, 3, 1, 2, 4]`. This fork asserts the same list **plus one**, and
the difference is this fork's **muxer**, not the fix: it carries the programme forward a frame to keep
a negative decode time off the wire, so the file the test muxes is a frame later throughout. The two
properties the fix is actually about — five frames in and five frames out, the first one a key frame —
are asserted directly rather than implied by the list.

The test also pulls out **every** table packet rather than the pair at the head: this muxer repeats its
tables, so leaving the later ones in place puts a PMT back in front of the media and the test stops
exercising anything.

## A stated decode timeline that runs backwards

A packet may state its own decode timestamp, and the ISOBMFF muxer then writes that timeline instead of
deriving one from presentation order. Nothing checked the stated times were in decode order, so
`processTimestamps` reached `assert(delta >= 0)` and `finalize()` threw a bare **`Assertion failed.`**
naming nothing — reported by a consumer whose rebuilt packets restated each presentation timestamp as
the decode timestamp, which on a reordered stream runs backwards.

It throws an error naming the packet's presentation time, the decode time it stated, and the previous
packet's — the three numbers needed to find the offending packet. **It throws rather than repairing the
order**, because the stated timeline is the caller's claim about how the media decodes and silently
resorting it would write a file whose timing is not the one asked for. Only reachable from packets that
state a decode timestamp.

## Start timecode — `InputVideoTrack.getStartTimecode()`

A broadcast source states where its media sits on a timeline, which is not a duration: `01:00:00;00`
is a label, and a consumer burning in MediaConvert's EMBEDDED timecode needs the label.
`getStartTimecode()` returns `{ hours, minutes, seconds, frames, dropFrame, frameRate }`, or `null`
for a file that states none.

**MP4 and MOV: the QuickTime `tmcd` track.** Its sample description carries the drop-frame flag, the
timescale and frame duration, and the frame count a second rounds to; its single sample is a frame
number counted from 00:00:00:00. Such a track has no `info`, so it never joins `tracks` and a caller
never sees it — its data is collected separately and read by the video tracks.

**Drop-frame drops numbers, not pictures.** Two a minute at 29.97 and four at 59.94, except every tenth
minute, so the count stays near wall clock on a rate that is not an integer. A frame number has to be
renumbered before it is split into hours and minutes: read naively, an hour of drop-frame comes out as
**00:59:56;12**. The first minute is the exception that catches a wrong implementation — it keeps all
1800 of its numbers, because the drop happens as the minute increments, so frame 1799 is `00:00:59;29`
and frame 1800 is `00:01:00;02`.

**The bitstream's own SEI**, when there is no timecode track. HEVC states one in `time_code` (D.2.27)
and H.264 in `pic_timing` (D.2.2). Only the first of the up-to-three clock timestamps is read, since
they are the fields of one picture and the same instant, and the rate comes from the first packet's
duration because neither SEI states one.

**H.264's message is not self-describing, which is why it needs the SPS.** How many bits precede the
clock timestamp, and whether one is present at all, are stated only by the VUI:
`pic_struct_present_flag`, and the CPB delay widths inside the HRD parameters. This fork's SPS parser
read all four and threw them away, so they are returned now (`picStructPresentFlag` and `hrd` on
`AvcSpsInfo`). With an `avcC`, the parameter sets live in the description rather than in band, so
`avcCodecInfo` is null there and the SPS has to be deserialized from `codecDescription`.

ffmpeg writes a `tmcd` track for `-timecode` and never the SEI, and x264 emits `pic_timing` with
`clock_timestamp_flag` 0 — a one-byte payload carrying no timecode. So there is no natural fixture for
either bitstream path: `scripts/build-timecode-sei-fixture.py` lays both messages out by hand,
emulation prevention included, and injects one before the first slice of a stream that has no timecode
track. The H.264 fixture is encoded with `pic-struct=1`, because the message is unparsable unless the
VUI declares it. **What the reader is held to is not what this library writes.**

## `#EXT-X-PROGRAM-DATE-TIME` from a stated clock — `programDateTime`

`HlsOutputFormatOptions.programDateTime` anchors the playlist to a wall clock: each segment's tag is
that date plus the segment's own timestamp. A player needs it to seek by time of day, to align two
renditions, and to place an `#EXT-X-DATERANGE`, whose `START-DATE` is on the same clock.

The tag existed before this, but only where every track stated
`BaseTrackMetadata.isRelativeToUnixEpoch` — which requires the *media's own* timestamps to be
epoch-relative. A live stream would then carry timestamps around 1.7e9, where a 32-bit float resolves
to about 128 seconds, so the media timeline cannot be left where the encoder put it. This option states
the clock separately and leaves the timeline at zero; a track that is genuinely epoch-relative still
gets the tag without it.

A segment that starts below zero — AAC priming does, by 21 ms — states a date before the anchor, which
is correct: the anchor is media time zero, not the first byte.

The test asserts each date is the previous one plus that segment's `#EXTINF` duration, starting at the
anchor, so the clock is the media's own timeline laid on the anchor rather than wall time while writing.

## An absent HLS attribute is absent, not `undefined`

The playlist serializer guarded every optional attribute with `!== null`, which an **absent** field
passes: a caller handing it a plain object got
`#EXT-X-RENDITION-REPORT:URI="b.m3u8",LAST-MSN=undefined,LAST-PART=undefined`, and a consumer skipped
reporting a rendition that had no part yet. RFC 8216bis 4.4.5.4 lets both be absent, and `undefined` is
never a legal attribute value.

The `hls*` builder helpers normalise with `?? null`, so this only bites a caller that constructs the
AST itself — which `hlsMediaPlaylist` invites, since `renditionReports` takes the strict
`HlsRenditionReport[]` while its siblings take loose option shapes. Fixed in the serializer rather than
the builders, because that is where every caller converges: all 40 `!== null` presence guards became
`!= null`, which `eqeqeq` is configured to allow (`{ null: 'ignore' }`).

**The `=== null` side was the same bug and worse.** `byteRangeValue` returned early on `b === null`, so
an absent byte range fell through and **threw** on `b.offset` — a crash rather than bad output, and
reached by `#EXT-X-PART`. All five `=== null` guards became `== null`.

The tests cover one tag per emitter, asserting both that the output contains no `undefined` and that
the omitted attribute's name is absent.

## MPEG-TS track language

A PMT states a track's language in an `ISO_639_language_descriptor` (tag 0x0a, 13818-1 2.6.18), and the
demuxer ignored it: `getLanguageCode()` returned a hardcoded `und` for every MPEG-TS track. It is read
now, and the muxer writes it for a track whose metadata states a `languageCode`.

Three details worth keeping:

- **Not to be confused with the language inside a teletext or subtitling descriptor.** Those are tags
  0x56 and 0x59 and carry their own per-entry ISO-639 fields; 0x0a is a separate descriptor and the two
  are read by different code. A stream can carry both.
- **A descriptor may repeat, one per `audio_type`.** The first names the track, which is what a
  selector wants; the rest describe alternate audio services on the same stream.
- **Only three lowercase letters are taken.** Writers pad the field with spaces or nulls, and a code a
  consumer cannot match says less than `und`.

The read test uses an **ffmpeg-written** fixture (two AAC tracks tagged `eng` and `spa`), so it reads a
descriptor this library did not write; a separate test asserts a programme stating no language reads as
`und`, and a third round-trips a language through our own muxer.

**PIDs and stream ids follow the order tracks were added, not the order their packets arrive.** Track
data was created lazily on a track's first packet and appended, so the PID, the stream id *and the
order the PMT lists its streams* all followed whichever encoder produced a packet first — two runs of
the same job that interleaved differently wrote different bytes. Both halves had to change: the PID
comes from the track's index in the output, and the track data is inserted in that order. Worth knowing
when reading the test: comparing the **set** of PIDs in use cannot see this, because both orders use
the same two PIDs; it passed against the unfixed code until it compared each stream type to its PID,
parsed out of the PMT.

## MPEG-TS teletext and DVB subtitles on the read side

`readMpegTsPrivateStreams(bytes)` reports the teletext and DVB subtitle streams a programme declares,
and `readPrivatePesPayloads(bytes, pid)` hands back each PES payload with the time its header states.
Standalone byte-level functions in the shape `readScte35Sections` set: no new track kind, nothing
threaded through `Input`.

Both ride stream type 0x06, so the **descriptor is the only thing that tells them apart** — a
`teletext_descriptor` (tag 0x56) or a `subtitling_descriptor` (tag 0x59). A private stream carrying
neither is not reported. Field widths are from ETSI EN 300 468 V1.20.1: teletext entries are five bytes
(ISO-639, then `teletext_type` 5 bits, `teletext_magazine_number` 3, `teletext_page_number` 8, §6.2.43),
subtitling entries eight (ISO-639, `subtitling_type` 8, `composition_page_id` 16, `ancillary_page_id`
16, §6.2.41).

**The page number is two hex digits, and magazine 0 means magazine 8.** So page 888 arrives as magazine
`0` with page byte `0x88`; reading that byte as decimal gives 136 and a page nobody can ask for. There
is a test whose only job is that arithmetic.

Payloads are handed over as they arrived — the `data_identifier`/`data_unit` framing of EN 300 472, or
the segments of EN 300 743 — so a caller parses what it needs. A packet whose header states no PTS
yields `time: null` rather than being dropped, because teletext often omits it.

The fixture is synthesised, since no broadcast sample here carries either, and it is **not** validated
by the writer that made it: `ffprobe` reads the same file as `dvb_teletext` on one PID and
`dvb_subtitle` on the other, each reporting `language=eng,deu`. Two entries per descriptor and a PES
spanning several TS packets are deliberate — with one entry a wrong stride still reads the first
correctly, and with a single-packet PES a dropped continuation is invisible. Three mutations were green
until the fixture carried both.

## MPEG-TS teletext and DVB subtitles on the write side

The pass-through, opposite the read side above.
`new MpegTsOutputFormat({ privateStreams: [{ pid, descriptors }] })` declares a private elementary
stream, and `addPrivatePesPayload(output, { pid, time, data })` writes a whole PES payload into it.
Nothing here composes a teletext page or a DVB subtitle segment: a payload read off one stream can be
written to another and comes back byte-identical with the same PTS, which is the test.

**The descriptors are the declaration.** They are written into the PMT byte for byte, because stream
type 0x06 says nothing on its own — a `teletext_descriptor`, a `subtitling_descriptor`, or anything
else a receiver is meant to act on. For the same reason the format refuses a descriptor whose own
length byte disagrees with its size: it is copied verbatim, so a wrong length shifts every descriptor
after it and the PMT still parses, into something else. They are in every PAT/PMT repeat, not only the
first.

**A payload is placed by its PTS, not by when it was handed over.** The payloads are queued and the
interleave writes each one when the media reaches its time, so a caller may hand over a whole caption
file before adding a single frame. That is why a payload without a PTS is refused rather than guessed
at: it has nowhere to go. `PES_packet_length` is stated rather than left unbounded — EN 300 472 4.1
requires it, and it is also what lets the reader tell a whole payload from one a buffer cut short.

Confirmed by `ffprobe` reading the written stream as `dvb_teletext` and `dvb_subtitle` on their PIDs.
With the descriptor tag changed by one it reads `bin_data` instead, which is how that check was shown
to be able to fail.

The TS-packet split is shared: `writePesTsPackets(pid, header, data, flags)` carries both the media
path and this one, with the adaptation field the first packet needs and a PCR only where the flags
state one, and PTS/DTS writing is one `writePesTimestamp`. Behaviour of the media path is unchanged.

## Live RIST output — `RistTarget`

`@mediabunny/server` exports `RistTarget`, speaking **RIST Simple Profile (VSF TR-06-1)** directly. It
has to: node-av's FFmpeg has libsrt but **no librist** — `IOContext.open2('rist://…')` returns
`AVERROR_PROTOCOL_NOT_FOUND` in a millisecond — so this is protocol code rather than a wrapper, sized
against `rist-source.ts` rather than `srt-target.ts`.

RTP goes to the URL's **even** port with payload type 33 (MP2T, RFC 3551), a per-stream SSRC and
sequence numbers advancing by one; RTCP is read on the odd port above. A receiver's NACKs are answered
from a buffer of recently sent packets — both RFC 4585's generic NACK including its 16-bit bitmask, and
TR-06-1's range NACK in an RTCP APP packet named `RIST`. Packets age out of that buffer rather than
being counted out, because a receiver never asks beyond its own. `'caller'` sends to the URL;
`'listener'` binds those ports and learns the peer from whichever address its first RTCP arrives from,
which is how a receiver behind NAT is reached. `sentPackets` and `retransmittedPackets` are separate,
since a rising retransmit count means a lossy path rather than a fault here.

**It sends at the rate the stream states, and blocks rather than drops.** An unpaced sender hands a
whole segment to the kernel at once, and a RIST receiver then either absorbs that burst out of its
de-jitter buffer or loses it. `pacing` (on by default) reads the **MPEG-TS PCR** out of the payload and
holds each datagram until the stream's own 90 kHz clock says it is due, which is what RFC 2250 means by
pacing MP2T. It is inert on a payload stating no PCR — there is then no rate to pace to. The same clock
drives the RTP timestamp, which was wall clock before. On a synthetic stream of 40 PCRs 25 ms apart,
975 ms of media delivers in 975 ms paced and 608 ms unpaced.

With a rate the queue fills for a real reason, so `enqueue` returns a pending promise while it is over
`maxQueueBytes` — which is how a `WritableStream` applies backpressure, so the writer waits for the
socket instead of having its bytes discarded behind it. `onOverflow` picks: `'block'` by default,
because for a relay arriving late beats not arriving, and `'drop'` for a live encode that must not be
stalled. `droppedBytes` and `droppedDatagrams` count only the second, so they stay 0 under the default.
This is a deliberate divergence from `SrtTarget`, which still drops; the counters match it
(`sentBytes`, `queuedBytes`, `maxQueueBytes`, `droppedBytes`, `droppedDatagrams`) so a relay reads every
target the same way.

Two defects under that: the datagram send was `socket.send` with no callback, so **a send error was
silently swallowed** where `SrtTarget` surfaces it; and `queued` was decremented when a chunk was
dequeued rather than as datagrams went out, so one `_flush` of a whole segment read 0 the entire time
it drained. `handOff` awaits the send — which raises `ENOBUFS` and gets the tail datagram to the OS
before `finish` closes the sockets — and the count is per datagram.

Two header fields are checked **on the wire** rather than through a round trip: `RistSource` validates
neither the payload type nor the SSRC, so mutating either passed. A plain UDP socket asserts version,
payload type, a non-zero SSRC constant across the stream, and sequence numbers advancing by one — the
fields a conformant receiver uses to tell this stream from another on the same port.

**A short tail can be flushed on demand.** A datagram is packed to 1316 bytes so each carries whole
MPEG-TS packets, so a tail shorter than that waits for the bytes that would fill it — at a low bitrate
that wait is latency rather than efficiency. `flushPartialDatagram()` sends it now, on `SrtTarget` and
`RistTarget` both. `TargetWriter.flush()` deliberately does not: it is the ordinary per-fragment flush,
and a short datagram at every one would spend exactly the payload efficiency the packing exists for.

### The SRT file-mode tail loss, and why the test is skipped

`linger` is set for every transtype, not only live, so a file-mode close drains. That is a real libsrt
AVOption (`libavformat/libsrt.c` applies it when `>= 0`), checked rather than assumed, because a
misnamed AVOption fails silently and leaves the default standing.

**A file-mode close can still lose a tail, under load.** Reported as 1 run in 3, reproduced here at 1 in
6 with two other suites alongside. The measurements narrow it: `sentBytes` always reaches the full
payload, so the sender wrote every datagram; `flush()` and `closep()` both succeed; the receiver's
stream ends on EIO with the tail missing, and EIO is how *every* one of these streams ends, passing runs
included. The tail is not a fixed size, and the payload is an exact multiple of 1316, so the
short-final-datagram path is not involved.

What `linger` buys, over 40 attempts per value: `linger=0` is short on 7, `linger=5` on 3, `linger=30`
on 2, and the target's default on 3 — the same count as the explicit 5, which is what establishes that
the default reaches libsrt. So it halves the loss and raising it sixfold does not close the gap, ruling
out "the send buffer needs longer". The wait that would close it is on the peer's acknowledgement
(`SRTO_SNDDATA`), and node-av's `IOContext` offers no way to read a socket option back. The reported
1-in-3 rate matches `linger=0` far better than this target's default, so a caller seeing that rate is
likely not getting the linger default at all.

**The reported conditions do not raise it**: matched in full — a same-process `NetworkSource` listener,
`_read` of one 188-byte TS packet at a time, 90–220 KB padded to whole datagrams, close straight after
the last flush, and a CPU loaded to 1.8× its idle spin time — 12 of 12 came back byte-exact.

**An independent receiver now exists**: `srt-live-transmit 'srt://:PORT?mode=listener&transtype=file'
file://con` relays to a pipe, so nothing can be lost between receiver and byte count, and it is killed
only after it reports the sender's disconnect. Against it `SrtTarget` delivered 8 of 8 and `SrtSource`
8 of 8. Two warnings from building that control: relaying through **UDP** instead of a pipe reported 1
run in 6 short by exactly five datagrams, which reads precisely like the reported bug and was the
*relay* dropping — UDP on loopback has no flow control, and a receiver that can itself lose bytes
attributes nothing. And `srt-live-transmit` has no file target other than `file://con`; a `file:///path`
target fails with `Unsupported target type` after the listener has bound, which looks like a connection
problem.

So the two cheap explanations are ruled out — the drain in `finish()` and a swallowed error — leaving
SRT tearing the connection down before the receiver has read what libsrt still holds. The reproduction
is a **skipped** test with those measurements written beside it rather than a red or deleted one,
because **a 50-run green does not show the race is fixed** while the race cannot be made to fail on
demand: unskipping would only record that the machine was quiet.

## Resize and chroma match FFmpeg's lanczos

Every `scale=` in `packages/server/src/video-sample.ts` carries
`flags=lanczos+accurate_rnd+full_chroma_int`, and the result is bit-identical to
`ffmpeg -vf scale=W:H:flags=lanczos+accurate_rnd+full_chroma_int`. Unflagged means **bicubic** —
`vf_scale`'s own `flags` default is `""`, so swscale's library default applies.

`video-encoder.ts`'s fallback `SoftwareScaleContext` takes the same flags **unconditionally**. It fires
whenever the frame mismatches the codec context in format *or* size, and a format-only conversion still
resamples **chroma** whenever the subsampling differs — measured at ~34 dB on a same-size 4:4:4 → 4:2:0
with `fast_bilinear`, luma identical. **Never gate these flags on a size change.**

The test requires bit-identity, not a PSNR bound: the old bicubic code clears ≥50 dB luma / ≥48 dB
chroma at every size, so a bound does not discriminate. An upscale case needs a genuinely smaller
source — 1080p→1080p is a pass-through and scores `Infinity` on every kernel.

## `frameRate` decimation selects by float slot

`transform.frameRate` gives each sample an output slot with `floorToDivisor(timestamp, frameRate)` and
encodes the first sample of each new slot. That slot assignment **is** the frame selection.

Slots are computed on float seconds — a sample carries no ticks by then, and may come from a canvas —
so `floorToDivisor` snaps through `roundIfAlmostInteger`. Without it, a time mathematically on a
boundary lands ulps below it and the slot's opener becomes source frame 2k + 1: 37 of 750 outputs on a
50 → 25 minute at 1/12800.

**Which parity opens the slots is a property of the source, not a constant.** It is 2k only when the
first timestamp sits on the output grid; a start of 95443.7 s, or 60000/1001 → 30000/1001 from 10.0 s,
is mid-slot and the odd frames correctly open. What must hold for any source is a **constant** phase
with each slot opened **once**. At a gap the slot goes to the first frame at or after the boundary, and
slots no frame reaches are filled by `padFrameRate` repeating the last one.

Covered end to end against `ffmpeg -vf "select=not(mod(n\,2))" -fps_mode passthrough`. Without
`-fps_mode passthrough` the rawvideo muxer duplicates the selected frames back up to the source rate.

## RIST in pure TypeScript — in `@mediabunny/server`

RIST **Simple Profile (VSF TR-06-1)** and **Main Profile (TR-06-2)**, over `node:dgram` and
`node:crypto`. No librist, no koffi, no native build, nothing to install.

It lived in a `@mediabunny/rist` package for one release and was folded in: RIST is a server-side
transport, and a package boundary bought nothing but the "two copies of the core" hazard — a class
defined on one side of it extended a different `Source` than `Input` checked against.
`@ahmedrowaihi/mediabunny-rist` stops being published; the versions already on npm stay served.

**It defaults to simple profile**, which is what MediaConnect uses and what `@mediabunny/server` has
always spoken, so defaulting to main would change the wire format under existing callers without an
error. librist's `ristsender`/`ristreceiver` default to **main**, so a peer built against those needs
`profile: 'main'` stated. **Both ends must agree, and disagreeing is silent**: a simple-profile sender
against a main-profile receiver logs `Non conformant main profile packet received` and delivers
nothing — the same shape as SRT's `transtype` trap.

**Layout.** `rtp.ts` carries the RFC 3550 reader the RTMP and network sources also use, plus the
MPEG-TS `pcrOf` a sender paces to; `rist-rtcp.ts` the RTCP both profiles share; `rist-gre.ts` and
`rist-psk.ts` what Main Profile adds; `rist-transport.ts` holds the profile difference so the source
and target are written once. `parseRtp` stays generic — RIST's "low bit of the SSRC marks a
retransmission" convention is applied in `rist-source.ts`.

**The profile difference is two sockets versus one.** Simple profile is bare RTP on the URL's even port
and bare RTCP on the port above. Main profile multiplexes both over the even port inside GRE, and the
*virtual* ports of the reduced header — librist's defaults 1968 and 1969 — do the separating. A URL
means the same thing under either profile, and the even-port rule is enforced under both.

**Main Profile encryption, read off librist's source rather than guessed.** The key is
PBKDF2-HMAC-SHA256 at **1024 iterations**, salted with the **4-byte GRE nonce** that rides the header,
for `aesType / 8` bytes. The payload is AES-CTR with the GRE **sequence number as the IV's high word**
and the counter running in the low bytes, so each datagram starts a fresh keystream. Encryption begins
*after* the sequence number, so it covers the VSF and reduced headers as well as the payload — getting
that boundary wrong produces a packet librist parses and then discards. Bit 7 of the nonce's first byte
selects between a peer's even and odd keys. Derived keys are cached by nonce, bounded at 8: deriving
one costs more than the decryption it enables, and an unbounded cache is a peer with randomised nonces
away from a leak.

**A receiver delivers nothing until a compound RTCP carrying SDES has identified the flow.** This is
not in TR-06-2: correctly framed, correctly encrypted media arrives and librist logs `handshake is
still pending (waiting for an RTCP packet with SDES on it), ignoring`. So `RistTarget` sends its first
compound report and waits `HANDSHAKE_SETTLE_MS` before the first payload. Without that wait the opening
datagrams are dropped and the stream starts short, which looks like loss and is not.

**The close grace is 250 ms and that bound is load-bearing.** A receiver can still ask for the tail
after the last payload. Raising the wait to 1000 ms to answer more of those NACKs **made delivery
worse**: against `ristreceiver`, 30 payloads arrived as 270 and 20 as 120 — the far end kept asking for
a tail that was never coming and every answer was delivered as new. Answering fewer late NACKs is the
correct trade.

**A `secret` is refused on simple profile**, which has no key exchange at all, so it throws rather than
reading as protection it does not provide.

**Multi-path: one reorder buffer, not one per path.** The sender numbers payloads once across every
path, so a receiver merges by RTP sequence number: a stream split across two links is put back in
order, and a payload replicated down two is delivered once (TR-06-1 §5.4, SMPTE 2022-7), counted by
`RistSource.duplicates`. NACKs go out on every live path, because a packet lost on one may be resent
down another. **Retransmissions set the SSRC's low bit** (§5.3.2) and carry the original's sequence
number and timestamp; the media SSRC is forced even so the two never collide.

**Two losses no NACK protocol can recover**, and the tests say so rather than asserting otherwise. A
gap is seen when a *later* sequence number arrives, so a packet lost at the very **end** is never asked
for. A packet lost at the very **start**, before any has been received, is not a gap either: the
receiver anchors on the first packet it sees. Live streams do not end, so the recovery tests send
trailing payloads past the span they compare.

**The merge test was green for the wrong reason first.** With retransmission on, a receiver ignoring
one path entirely still passed, because the NACKs recovered everything over the other — proven by
mutation. It now runs with `retransmitBufferMs: 1`, so nothing is held for resend and a packet arrives
on the path it was sent down or not at all. The mutation now fails, which is the only reason to trust
it.

## Live RTMP output — `RtmpTarget`

RTMP carries FLV, which this library does not mux, so `RtmpTarget` takes the **fragmented MP4** an
`Output` writes and remuxes it through node-av: `Demuxer.open(readable, { format: 'mp4' })` into
`Muxer.open(url, { format: 'flv' })`, which is `RtmpSource`'s pipeline inverted.
`new Mp4OutputFormat({ fastStart: 'fragmented' })` is required — its empty `moov` is what lets the
stream be read before it ends. The connection opens on the first write, and a server dropping the
publish ends the stream rather than erroring, since libavformat reports a closed socket as `EIO`.

**Two things a publish over FLV cannot preserve**, which a test asserting otherwise would be lying
about. A live publish loses both ends: the listener is not accepting for the very first fragment, and a
`Conversion` closes its own output while the receiver is still reading — 113 of 125 packets arrived in
the measured case. And **FLV timestamps are integer milliseconds on a timeline ffmpeg restarts at
zero**, so the absolute values shift; the measured offset was 21 ms, with only the first sorted sample
off the resulting grid because the publish begins mid-fragment. What survives, and what the test
asserts, is the shape: no duplicates, the source's own frame interval from the second sample on, and a
span matching the frame count.

**There is no write-timeout option.** `rw_timeout` is not an option the flv muxer takes — it fails
loudly rather than silently — and rtmp ignores URL query options, so the connect and the writes are
bounded by the protocol. Better no knob than one that does nothing.

### `readPrivatePesPayloads` returns only complete payloads

It never read `PES_packet_length`, so a PES the buffer cut short came back looking whole, with its PTS
set and nothing to say it was partial — a 354-byte DVB subtitle PES cut after its first TS packet
returned 170 bytes. That is not an edge case for a live reader: one scanning a sliding window cuts the
last PES every time. DVB subtitles end with a 0xFF marker a caller could check; teletext has no marker
at all, which is what makes a short payload indistinguishable from a whole one.

A PES is emitted once its stated `PES_packet_length` has arrived, trimmed to that length, or — where
the field is 0 and the packet is unbounded — once the next `payload_unit_start_indicator` on the PID
ends it. A packet still open when the buffer runs out is **left out** rather than returned with a flag:
a flag would have to be checked to be worth anything, and not checking it is exactly the bug. The
consequence, documented on the function: in a stream whose private PES state length 0, the final packet
is never returned, because nothing says it ended.

`test/node/mpeg-ts-private-streams.test.ts` cuts the fixture at every TS packet boundary on the PID and
requires what survives to be a byte-for-byte **prefix** of the whole read — so the packets before the
cut are untouched and the cut one is absent, not short — and asserts the cuts actually dropped
something, or the test would prove nothing.

## `prefer-software` picks a software encoder

`getSoftwareEncoderCodec` resolved through `NodeAv.Codec.findEncoder(codecId)`, which returns FFmpeg's
**default** encoder for a codec id — not a software one. On node-av's linux-arm64 prebuild the default
for AVC is `h264_rkmpp`, a Rockchip wrapper, so `hardwareAcceleration: 'prefer-software'` chose a
hardware encoder on any arm64 Linux box, Graviton included, with no Rockchip silicon in it. It
surfaced as `Encoder 'h264_rkmpp' cannot be used for quantizer-based encoding`; a bitrate request would
have run on a device that was not there.

The default is still tried first, so every build whose default is already software keeps the encoder it
had. Only when that default classifies as hardware does selection fall through to named software
encoders — libx264, libx265, libvpx, libsvtav1 and their alternates — and if none is built in it
returns null rather than the hardware default, because `prefer-software` asked for the CPU.

**Classification is by capability, with a stated exception.** Checked against FFmpeg's own sources:
rkmpp, v4l2m2m, nvenc and vaapi set `AV_CODEC_CAP_HARDWARE`, and qsv sets `AV_CODEC_CAP_HYBRID` — so a
capability test covers five of the six and anything new that flags itself. **videotoolbox sets
neither**: it is identifiable only by `wrapper_name`, which node-av does not expose, so it and a handful
of others (mediacodec, amf, mf, omx) are matched by name suffix. That list is the exception, not the
rule.

**A hardware encoder that will not open falls back to software.** `prefer-hardware` is a preference,
and a build can carry a device encoder for a device that is not there. Whether the device exists is only
known from opening it, so an open failure on a hardware codec re-opens with a software one instead of
throwing. A codec the caller named outright is not second-guessed, and a software encoder's own open
failure is reported as its own.

That turned up a second defect: the `Encoding 'avc' with …` line was logged at **selection**, before
anything was opened, so after a fallback it named an encoder that never ran — and that line is what a
caller reads to find out what encoded its video. It is stated again with the encoder actually used.

`test/node/encoder-selection.test.ts` asserts the invariant for every video codec — the software
selection never yields a codec the classifier calls hardware — and checks the classifier against the
real hardware encoders in this build, failing if there were none to check so the hardware half cannot
go untested. **It cannot fail on macOS or x86**, where the default is already libx264, so on its own it
would not have caught this. Fork CI runs it on a native arm64 runner (`ubuntu-24.04-arm`), where the
default is `h264_rkmpp` and the invariant has something to catch: the job installs, prints which
encoder FFmpeg defaults to on that build, and runs the encoder-selection tests alone, in seconds. The
print is unconditional, because a future failure is unreadable without it.

That cheapness is why encoder choice lives in `packages/server/src/encoder-choice.ts` rather than in
`misc.ts` beside its siblings. `misc.ts` imports the package entry for its options, and the entry
imports `@mediabunny/prores`, which the test config aliases to a **built** bundle — so a test touching
either needs `npm run build` first. The classification and the selection need nothing but node-av and a
type, so they sit at a leaf and the job stays an `npm ci` and a few seconds.

## Broadcast transport settings — `MpegTsOutputFormat`

A delivery to a cable, satellite or ASI path states the stream's identity rather than taking the
muxer's defaults, and takes a constant bit rate. `MpegTsOutputFormatOptions` carries the settings
MediaConvert's and MediaLive's `M2tsSettings` do:

| option | default | what it states |
| --- | --- | --- |
| `programNumber` | 1 | the PAT's and PMT's `program_number` |
| `transportStreamId` | 1 | the PAT's `transport_stream_id` |
| `pmtPid` | 0x1000 | the PID the PMT is carried on |
| `pcrPid` | the first video track's PID | the PMT's `PCR_PID`, and where the PCR is carried |
| `trackPids` | 0x0100 upwards | each track's PID, in the order tracks were added |
| `patInterval` / `pmtInterval` | `tableRepeatInterval` | seconds between repeats of each table alone |
| `pcrInterval` | 0.04 | seconds between PCRs, at most the 0.1 of 13818-1 2.7.2 |
| `service` | none | a DVB `service_descriptor` in an SDT, shown as the channel |
| `sdtInterval` | 0.5 | seconds between SDT repeats |
| `muxRate` | none | bits per second, making the stream constant bit rate |

Because `pmtPid` is a caller's choice here, upstream's `PMT_PID` constant is exported as
`DEFAULT_PMT_PID`, naming only the default. `PAT_PID` keeps its name and its export.

**Every interval is in seconds**, including the new ones, where MediaConvert states its `patInterval`
and `pcrPeriod` in milliseconds. Mixing units in one options object is a foot-gun.

**PID collisions are refused by name.** The tracks' PIDs are only known once the tracks arrive, so the
check runs where the tables are first written and names which of the PAT, PMT, SDT, a track, a private
stream or the cue stream already holds the PID.

**A PCR-only packet repeats the continuity counter** (13818-1 2.4.3.3: the counter increments only on a
packet carrying a payload). The muxer's counter map used to hold the value to write *next*, so an
adaptation-only packet consumed the increment and the payload packet after it repeated — which a
receiver reads as **two** errors on a clean programme: `PID 256 … 12 -> 13` on the PCR-only packet, then
`13 -> 13` on the next payload packet. TR 101 290 reports it as a continuity error, and a relay
following the counters across a failover reports them as running on. The map holds what was last
written, so the increment still happens, one packet later and only for a payload.

**A `pcrPid` naming no track gets PCR-only packets**, which is the only way such a stream has a clock at
all — an adaptation field of 183 bytes with the PCR flag and no payload, at `pcrInterval`. The same path
fills a gap where the PCR *track* goes quiet. They are stamped one interval past the last PCR rather
than from the interleave's current position: only video states a decode timeline, so taking an audio
packet's presentation time would put a PCR ahead of a video decode time still to be written, and a PCR
that goes backwards is worse than one that is late. Stamping from the interleave position widened the
worst PCR gap on `demo.mp4` from under 0.1 s to 0.156 s.

**`muxRate` makes the stream constant bit rate.** Null packets on PID 0x1fff fill whatever the media
does not, and every PCR is stamped from the byte position it sits at —
`round(packetIndex × 188 × 8 × 27e6 / muxRate)` in 27 MHz ticks, extension included, where the
variable-rate path writes a 90 kHz base and a zero extension. Over a 5 Mb/s `demo.mp4`, every
consecutive PCR pair differs from the bytes between them by at most 0.8 of a 27 MHz tick, and the file's
size over the span of media it carries is 4,999,993 bits per second.

The byte clock is measured from the stream's **own first media time**, not from zero: AAC priming
starts a track 21 ms below zero, and anchoring at zero leaves the clock that far behind the media for
the whole file — 0.83% under the stated rate. The tail is padded to the end of the media for the same
reason. Note `ffprobe`'s `format=duration` is **not** that span, since it drops both the priming and
the tail past the last video frame; take it from the per-stream `start_time` and `duration`.

Media that needs more than the rate is **refused**, naming the time it ran out and the rate it would
have needed. A burst may run half a second ahead, which is what lets a key frame through. A full T-STD
buffer model (13818-1 Annex D) is **not** simulated, so a stream that passes here can still fail a
conformance checker's buffer analysis — stated on the option rather than implied by its presence.

`test/node/mpeg-ts-tables.test.ts` scans every packet for a counter that moves without a payload, and
states the rule directly as well. Both halves are asserted against a count, since a stream with no
adaptation-only packets would pass either while proving nothing — and the clock can be due twice over,
so they run in groups and the packet after one is not always a payload packet. Everything is read back
with `ffprobe` or out of the 188-byte packets, never with this library's own demuxer. AC-3 is
deliberately absent: the transport settings read no elementary stream, so the codec is not a variable.

## PAT and PMT repeat — `tableRepeatInterval`

The tables were written once, at the head of the stream. A receiver that joins a stream already running
— a multicast listener, a restarted SRT receiver, a relay switching inputs — never sees them and so can
never find the program. They repeat every **0.1 s** of stream time by default, which is broadcast
practice; ETSI TR 101 290 1.3 and 1.5 treat a gap over 0.5 s in either table as an error.
`tableRepeatInterval` sets the period, and `Infinity` restores the write-once behaviour.

The period is measured on the stream's own timeline rather than wall clock, and a repeat is placed in
front of a key frame when one falls at least halfway into the period — a joining receiver starts
decoding at a key frame. Each repeat continues its PID's continuity counter, since a receiver reads any
other step as a lost packet.

`test/node/mpeg-ts-tables.test.ts` measures the gaps **on the PCR**, not on packet positions, because
that is the clock a receiver has: each table is dated by the last PCR before it, which is the worst case
a joining receiver sees. Over ten seconds the worst PAT and PMT gap is inside 0.14 s against a 0.1 s
period, the counters step by exactly one on both PIDs, and every PMT carries the SCTE-35 PID with its
`CUEI` descriptor rather than only the first. The test that matters most cuts a one-second slice out of
the middle and reads it with libavformat — a reader that is not this library's own — and finds the
stream; all five fail with the repeat removed.

## Several programs in one stream — `MptsMultiplexer`

`MpegTsOutputFormat` writes one program. A cable or satellite lineup, an ASI feed and an MPTS
contribution path all carry several, and that is a **remultiplex** rather than a mux: each program
arrives already packetized, and what has to change is what sits *around* its media. `MptsMultiplexer`
takes a `Source` per program and writes one constant-bit-rate transport stream.

```ts
const multiplexer = new MptsMultiplexer({
    programs: [{ source: hd }, { source: sd, programNumber: 9 }, { source: radio }],
    target: new FilePathTarget('lineup.ts'),
    muxRate: 20_000_000,
});
await multiplexer.execute();
console.log(multiplexer.programs); // the PIDs each program ended up on
```

| option | default | what it states |
| --- | --- | --- |
| `programs[].source` | — | a transport stream carrying exactly one program |
| `programs[].programNumber` | its position plus one | the `program_number` the PAT gives it |
| `muxRate` | — | bits per second; null packets fill what the programs do not use |
| `transportStreamId` | 1 | the PAT's `transport_stream_id` |
| `patInterval` / `pmtInterval` | 0.1 | seconds between repeats of each table |

**Three things change, and nothing else.** The elementary streams pass through byte for byte.

1. **PIDs.** Two independently produced programs both number their video 0x0100, so each program's
   streams move onto a range of their own — elementary PIDs from 0x0100 upwards in program order, a PMT
   per program from 0x1000. The layout is a function of the list, so a caller can predict it.
2. **The tables.** One PAT names every program. Each program's PMT is **patched rather than rebuilt**:
   `program_number`, `PCR_PID` and every `elementary_PID` are rewritten in place and the CRC
   recomputed, which leaves descriptors this library has no opinion about — AC-3, DVB subtitling, the
   SCTE-35 `CUEI` registration, a language descriptor — exactly as they came. Rebuilding would silently
   drop whatever it did not understand.
3. **The clocks.** A PCR states the byte position its packet occupies in *its* stream, which means
   nothing in this one, so it is restated from this multiplex's byte position. PTS and DTS shift by one
   constant per program, chosen so `PTS - PCR` is unchanged — that difference is the decoder buffer
   delay the encoder stated, and a remux that does not preserve it hands a receiver a buffer model that
   no longer describes the stream. The output clock starts one second in, so a PTS preceding its
   program's first PCR stays positive instead of wrapping.

**Packets go out when their own PCRs date them.** A packet's time is interpolated between the two PCRs
that bound it, by its position between them, and the output writes whichever program is due next,
padding with null packets to hold the rate. Dating each packet from the PCR *before* it — the obvious
cheaper reading — makes a program's whole PCR period eligible at once, and each program then goes out
in one burst per period: runs of 150 packets against a typical 3, with a twenty-fifth of the
alternations.

**A program whose clock starts late is not the multiplex running behind.** Where the PCR rides a stream
that stays quiet while another sends, the leading packets have nothing to date them: they all share one
time, and the output time spent draining them is a constant that program is behind by from then on.
Each program carries its own `scheduleOffset`, fixed when its first dated packet goes out, and lateness
is measured against that — without it, a program with 800 packets ahead of its first PCR trips a
spurious *"muxRate is too low"*. Programs that genuinely do not fit are refused by name, with the rate
the media needed.

**Statistical multiplexing is deliberately not here.** Sharing a rate pool by how much each program
needs can only be acted on by the *encoders* producing them; a multiplexer downstream can accept rates
or refuse them, which is what this does.

`computeMpegTsCrc32` and the null-packet PID live in `src/mpeg-ts/mpeg-ts-misc.ts` rather than inside
the single-program muxer, since a second CRC table would be a second thing to get wrong.

The tests read everything back off the 188-byte packets and with ffprobe, never through this library's
own demuxer — the point of restating a PID or a clock is that something else reads it, and our demuxer
would unwrap the very timestamps the tests are about. Each of nine mutations turns at least one red;
the strongest is the byte-for-byte one, that every continuation packet of every elementary stream comes
out exactly as it went in.

## Sharing one bitrate between programs — `StatMux`

`MptsMultiplexer` carries whatever rates it is given and refuses what does not fit. Deciding those
rates is statistical multiplexing, and the surprising part is that it is **not** done by handing each
program a bitrate.

An encoder told to hit a bitrate hits it, whatever it is encoding. Every program then reports exactly
the rate it was given, which says nothing about how much it needed, and the loop has no signal left to
act on. So the control variable is *quality* — one quantizer, shared — and the split falls out on its
own: at equal quality, harder content simply produces more bits. The pool decides the common quality,
raised until the programs together fit it. Per-program floors and ceilings are corrections on top of
that shared quantizer, which is also how a broadcast statmux is configured.

```ts
const statMux = new StatMux({
    programs: [{ minBitrate: 2e6, maxBitrate: 9e6 }, { minBitrate: 1e6, maxBitrate: 5e6, priority: 2 }],
    totalBitrate: 12_000_000,
    codec: 'avc',
    interval: 2,
});

await source.add(sample, statMux.encodeOptions(0));
statMux.report(0, packet.byteLength, packet.timestamp);
```

**Why it is quantizer-driven, concretely.** FFmpeg's libx264 wrapper does honour a changed `bit_rate`
through `x264_encoder_reconfig`, but only in ABR mode, and the libx265 wrapper does not reconfigure at
all — so a design built on moving each encoder's target rate would work on one encoder and silently do
nothing on the rest. Changing the quantizer drains the encoder and opens a fresh one, because almost no
FFmpeg encoder accepts one past init. That reopen starts a key frame, which is why **`interval` should
be the key frame interval** — reallocating anywhere else costs an extra key frame.

**A floor is a claim on the pool, not a promise to fill it.** A program whose content has little in it
produces few bits at any quantizer: the real-encoder trace shows a near-static field at 5 kb/s against
a 50 kb/s floor while its quantizer was held well below the shared one. What the floor buys is that the
capacity is not handed to someone else.

**The step size is the codec's, not H.264's.** Six quantizer steps to a doubling is the figure H.264's
rate control is built on and it holds for HEVC, but AV1 runs a 0–255 scale where AVC runs 0–51 — a loop
moving by six on both would barely move AV1 at all, so the step is scaled by the codec's own range.
`VIDEO_CODEC_QUANTIZER_SUPPORT` is exported from `src/encode.ts` so `src/statmux.ts` reads the scale
rather than carrying a second copy; it stays out of `src/index.ts`, being a cross-module internal.

The tests drive the loop with a *model* of an encoder for the control law — convergence from either
side of the pool, proportionality to difficulty, the floor, the ceiling, priority and the codec scale —
and then once with real `libx264` encoders, which is the only thing that shows model and code agree.
Each of six mutations turns at least one red.

One thing the real run taught the test: **the first measurement window is not a rate.** An encoder
holds frames before its first packets come out, so the opening window reports a fraction of what was
encoded in it — 204 kb/s where the next window read 9.5 Mb/s. The convergence assertion takes the
second window as its baseline and compares as a ratio against it rather than against a constant.

## Uncompressed video over IP — ST 2110-20

SMPTE ST 2110 carries uncompressed essence over IP, each kind on its own stream, and `-20` is the
video one. `@mediabunny/server` exports a packetizer, an SDP builder and a paced UDP sender.

```ts
const sender = await St2110VideoSender.open({
    format: {
        width: 1920, height: 1080,
        sampling: 'YCbCr-4:2:2', depth: 10,
        exactFrameRate: { numerator: 30000, denominator: 1001 },
    },
    address: '239.0.0.1', port: 20000, ssrc: 0x2110,
});
console.log(sender.sdp);      // what a receiver has to be given
await sender.send(packedFrame);
```

**The packetization is RFC 4175's.** After the RTP header comes a 16-bit extended sequence number,
then one or more 6-octet Sample Row Data headers — length, a field bit with a 15-bit line number, and
a continuation bit with a 15-bit pixel offset. The last SRD clears the continuation bit, and parsing
the headers is the only way to learn how many runs a packet carries. Up to three to a packet, which is
what senders write in practice and all there is room for.

**Everything is counted in pixel groups.** A pgroup is the smallest run of pixels landing on an octet
boundary, and every length in the format must be a whole number of them (RFC 4175 4.3). The table is
stated rather than derived because the packings are irregular: 4:2:2 at 10 bits is 5 octets for 2
pixels, while 4:4:4 at 10 bits is 15 octets for 4. A line whose width is not a whole number of pgroups
is filled to one, and the receiver drops the fill.

**The SDP is not optional.** Nothing in the packets states the picture's size, sampling or depth — a
receiver is told that out of band or it cannot read a single octet. `buildSdp` writes the `fmtp` line
ST 2110-20 asks for, including `exactframerate` as a ratio, which is why the format states 30000/1001
rather than 29.97.

**The pacing is wide, and says so.** ST 2110-21 narrow wants packets on a grid to within microseconds;
nothing scheduled by a JavaScript timer will hold that. The sender spreads a frame's packets across its
own frame interval as evenly as a sub-millisecond timer allows, reports what it managed in
`worstPacingError`, and the SDP defaults to `TP=2110TPW`. Defaulting to narrow would be worse than
useless: a receiver sizes its buffer on that claim and believes it.

The tests read the packets back with a parser written from RFC 4175 section 4 rather than from the
packetizer. The one that carries the most weight sends through the real sender to **FFmpeg** and
compares the pixels that come out: it is the only thing that would catch an error both of mine shared,
and a wrong `depth` or a swapped width and height in the SDP is invisible to every other test here.

One thing it taught the test itself: a paced sender makes a partial first frame the normal case. FFmpeg
binds the port after the test starts it, so the frame in flight at that moment arrives half-missing and
decodes as zeros — which matched the first sample by coincidence and looked like a pass. The test takes
four frames and compares the last.

Not here: PTP. The RTP timestamps are the frame's place in the stream rather than a real clock's, so
this is a sender for a network that does not police the sender's timing.

## Reading an IMF package — the CPL, the ASSETMAP and the PKL

An IMF package — an IMP — is not a file. It is a directory of MXF track files and three XML documents,
and nothing in the MXF files themselves states the composition:

| document | what it is for |
| --- | --- |
| `ASSETMAP` | the only thing that says where an asset's bytes are; everything else names assets by UUID |
| `PKL` | what each asset is — type, size, hash — which is what checking a package whole comes down to |
| `CPL` | the timeline: segments in series, each holding sequences that run in parallel |

`src/imf/imf-package.ts` parses all three and resolves them against each other.

**A resource is a cut, not a file.** `EntryPoint` and `SourceDuration` take a span out of a track file
whose own length is `IntrinsicDuration`, and `RepeatCount` lays that span down more than once.

**A segment lasts as long as its longest sequence.** Sequences inside a segment run in parallel, so a
short audio track leaves a hole rather than pulling the next segment earlier. Packing each track
end-to-end instead desynchronises picture and sound at every cut — and it looks perfectly correct in a
one-segment test, which is why the fixture has two segments with tracks of different lengths.

**`SourceDuration` defaults to `IntrinsicDuration − EntryPoint`,** not to the whole file. The difference
is exactly the entry point and it is silent: the extra runs off the end. A test whose entry point is
zero cannot tell the two apart, which is why a second fixture has audio entering at 30.

**The edit rate is two integers.** `<EditRate>24000 1001</EditRate>`, not 23.976, and a decimal is
refused by name. 1080 edit units is 45.045 s at 24000/1001 and 45 flat at 24 — that drift is what an
IMF delivery exists to avoid.

**UUIDs are normalised**: one document writes `urn:uuid:8979E4CB-…` and another `urn:uuid:8979e4cb-…`
for the same asset, and a map keyed by the raw string does not find it.

The tests use XML namespaced and prefixed the way a real IMP's is — one fixture with a default
namespace, one with everything `cpl:`-prefixed — because that is the part a parser gets wrong. Two
mutations survived the first round and found gaps in the tests rather than the code: the omitted
`SourceDuration` default and "the composition is as long as its longest track" were both true by
coincidence in the first fixture.

This ffmpeg build has no IMF demuxer, so unlike ST 2110 there is no independent implementation to check
against; the MXF track files can still be read by `ffmpeg -f mxf`, and the arithmetic is what the tests
hold.

### Opening an IMP as an `Input` — the `IMF` format

`ALL_FORMATS` includes `IMF`, so pointing an `Input` at a CPL plays the composition. The ASSETMAP is
read from beside it and the track files are opened as siblings, which is why the source must be a
`PathedSource`.

This does **not** sit on `SegmentedInput`. HLS and DASH hand a player a file per segment and the file
holds exactly that segment; an IMF resource instead cuts a span out of the middle of a track file that
may be hours long, and the same file may be cut several times at different points. So the demuxer maps
composition time to (resource, time in file) itself and clamps every read to the cut. Two translations
run in opposite directions and must stay exact inverses:

```
composition -> file:  entryPoint + ((t - timelineStart) mod sourceDuration)
file -> composition:  timelineStart + cycle*sourceDuration + (packetTime - entryPoint)
```

`mod`, because `RepeatCount` lays the same span down more than once.

**Two boundary cases carried most of the bugs.** A seek past the end has to land *just inside* the last
cut rather than at its exclusive end — the end is where the next packet begins, and asking for that one
gets a packet the composition does not contain, which made the fallback return the cut's *first* packet
and report a two-second track as one frame long. And a seek into a **hole** — a track that ran out
before its segment did — answers with the last packet *before* the hole, because `getPacket` is asked
for the packet at or before a time.

The end-to-end tests build a real IMP on disk: an MXF written by **FFmpeg**, an ASSETMAP and a CPL. The
MXF is FFmpeg's deliberately — if our writer and our reader shared a misunderstanding, a round trip
through both would not show it. What is asserted is not the packet count but the packet *bytes*: a cut
that read the right number of packets from the wrong place passes on count alone.

Still absent: the packing list is not verified on open (it is what a package is *checked* with, and a
composition plays without it), and `MarkerSequence` and `SubtitlesSequence` are parsed but not presented
as tracks.

## An access unit ends at the base layer's next picture, not at the next non-VCL unit

The single-layer rule — a non-VCL NAL unit after a slice begins the next access unit — is wrong for a
layered stream, and wrong in a way that loses data. Apple's spatial content puts a declarative prefix
SEI **between** a picture's two views, so cutting there splits one access unit in half and leaves the
second view in a run with no base-layer slice in it. The old code then reached the next AUD, found no
base-layer slice since the cut, concluded the run held no picture, and **discarded it**: one eye of
every access unit that had one, lost silently, with the stream still decoding in 2D.

H.265 F.7.4.2.4.4 starts an access unit only before the **base layer's** first slice of a new picture,
so the cut is deferred rather than taken: a non-VCL run records where it began, a base-layer slice
confirms it, and a higher-layer slice cancels it. No lookahead and no PES-boundary knowledge, so a
stream packing several access units into one PES still splits where it should.

**`layerIds` cannot test this.** A packet that lost the second view entirely still reports layers
`[0, 1]`, because the layer-1 SPS and PPS are in it — they are written at every IRAP, ahead of the base
picture. The consumer's acceptance was phrased that way too, and it passes on the broken build. What
has to be asserted is a layer-1 **VCL** unit: the picture, not its parameter sets.

## A transport stream has no decoder configuration

An `hvcC` can keep a **declarative SEI** out of band — Apple's spatial configuration carries 3D
reference displays info, payload type 176 — and an MP4 reader finds it there. A transport stream has no
decoder configuration at all, so for a receiver that only ever sees the elementary stream the in-band
copy is the only one there is. Every prefix SEI in the `hvcC` and the `lhvC` is written at each IRAP,
after the parameter sets and before the slices.

It is written for plain HEVC too, not only for a layered track: the loop acts on whatever SEI arrays
the configuration holds, and most configurations hold none.

**A hex search of the transport stream cannot test this.** A NAL unit of that length straddles the
188-octet packets, so the bytes are not contiguous anywhere in the file — the test reads the access
units back through our own demuxer instead, and checks each parameter set appears exactly *once* per
IRAP, because duplicating the sets ahead of the real ones passes any check that only looks at the first
occurrence of each.

## Writing `lhvC` and `vexu` for a track that arrived without them

Reading and passing these through shipped first; a track demuxed from a **transport stream**, or read
as an Annex B elementary stream, has neither. It has no decoder configuration at all — its parameter
sets are in band and nothing declares them — so writing it into an MP4 produced an `hvcC` and nothing
else, and `hvcC` describes the base layer alone: the file plays, with one eye.

**`lhvcConfigFromBitstream` collects only what `hvcC` does not carry.** Parameter sets above layer 0,
deduplicated because they repeat at every IRAP, in VPS/SPS/PPS/prefix-SEI order. It returns `null` for
a single-layer stream rather than an empty record, since an `lhvC` saying nothing would make every
plain HEVC file claim to be layered. `lengthSizeMinusOne` is taken from the base layer's record, both
describing the same track's samples. The one gate is in the collection loop — the array ordering does
*not* filter a second time, because a second gate made the first untestable: removing it changed
nothing, so a mutation of the real check read as caught.

**`buildLhvcConfigRecord` is not a byte-exact rewriter.** A real record carries octets this library
does not model — Apple's holds `hvcC`'s byte-21 layout at octet 4, a frame rate and a temporal layer
count — and the published drafts disagree about them. What it does not model it writes as **zero**
rather than as reserved ones, which would claim values instead of leaving them unstated. That is sound
because nothing re-serialises someone else's record: a track that arrived with an `lhvC` has its bytes
written through verbatim.

**A `vexu` can only say what the bitstream says.** `vexuInfoFromVpsExtension` returns both eyes present
for a two-view multiview VPS and nothing else, because that is all the encoder knows. Which view is
which eye, how far apart the cameras were, and what projection was used come from the **camera**:
`hero`, `blin`, `dadj` and `prji` are left unset rather than guessed. A one-view or many-view stream
gets no `vexu` at all, since a `stri` claiming both eyes would be an assertion about the stream rather
than a description of it.

**Both eyes set hides a swapped flag.** `stri`'s bit 0 is the left eye and bit 1 the right, and every
stereo track sets both — so a test on stereo content cannot tell a correct writer from one with the
flags reversed. The one-eye cases are what pin it.

## Telling MV-HEVC from ordinary HEVC — `inspectHevcLayers`

MV-HEVC carries more than one view — a stereo pair, usually — in one HEVC bitstream by putting each
view on its own layer. Nothing about the samples announces this: a decoder that ignores layers decodes
the base view and never knows the others were there, which is the design, and why a library that wants
to *say* a file is stereoscopic has to read the bitstream.

What marks a layer is `nuh_layer_id` in the two-byte NAL unit header (H.265 7.3.1.2):

```
byte 0:  forbidden_zero_bit(1)  nal_unit_type(6)  nuh_layer_id high bit(1)
byte 1:  nuh_layer_id low 5 bits(5)  nuh_temporal_id_plus1(3)
```

The field straddles the byte boundary, which is the whole reason reading it deserves a function:
`((firstByte & 1) << 5) | (secondByte >> 3)`. Taking only the second byte's five bits reads layer 32 as
0 and 63 as 31 — a stereo file then looks like plain video, silently.

`inspectHevcLayers(packetData, decoderConfig)` returns every distinct layer in a packet, whether
anything above the base is present, and the temporal sub-layer depth. It must be asked of a **packet**,
not of the decoder configuration: `hvcC` describes the base layer only.

**`isLayered` does not mean stereo.** SHVC's scalability layers use the same mechanism, and the
bitstream alone does not distinguish them — what the layers *are* is in the VPS extension. "More than
the base layer is present" is what can be said honestly from the NAL headers.

**No encoder in this toolchain produces MV-HEVC** — FFmpeg here decodes it (`-view_ids`) but cannot
write it, and libx265 has no view option. The bit-level fixtures are built from the syntax, covering
the values where a wrong shift still looks plausible: 31 fits in the second byte alone, 32 needs the
carried bit, and the temporal id shares the second byte. The control is a **real** HEVC packet, which
must come out as single-layer base video.

Two files nothing here wrote back the container side: `multiview.mov`, an Apple spatial video with
`lhvC`, a full `vexu` and an `hfov`; and `pico-mv-hevc.mp4`, a second writer's MV-HEVC with an `lhvC`
and no `vexu` at all. Both from FFmpeg's FATE suite, fetched by `npm run capture-mvhevc-fixtures`.

### The `lhvC` box

A layered track's extra views are configured in an `lhvC` box, and `parseLhvcConfigRecord` reads it:
six octets of header, then NAL unit arrays laid out exactly as `hvcC`'s are — typically the VPS
extension plus an SPS and PPS per additional view.

**Pinning that layout took an implementation, not the spec.** The published drafts disagree, and the
field set evidently changed between them. FFmpeg settles the array format — it reads `numOfArrays` at
**octet 5**, describes "6 lhvC bytes before the arrays", and then appends those arrays onto `hvcC`'s own
list while raising its `numOfArrays` (`mov_read_lhvc`). That last detail is the proof the array format
is identical: you cannot concatenate two lists laid out differently.

**The header between them is GPAC's.** `gf_odf_hevc_cfg_read_bs` reads it under `is_lhvc` as four
reserved bits, `min_spatial_segmentation_idc`, six reserved, `parallelismType`, two reserved,
`numTemporalLayers`, `temporalIdNested`, `lengthSizeMinusOne`, `numOfArrays` — and writes every reserved
run as ones.

That cost this fork a field. `LhvcConfig` used to carry a `completeRepresentation` read off the top bit
of octet 1. That bit is **reserved and always set**: `complete_representation` is AVC's, living in
`svcC` and `mvcC`, and nothing in the layered HEVC record corresponds to it. It could only ever return
`true` for a conformant record, and the test that said otherwise was asserting against a record the
test itself had built with the bit cleared. The two real fields in octet 4, `numTemporalLayers` and
`temporalIdNested`, are read and written in its place; zero temporal layers means *unstated*.

The builder writes the reserved runs as ones, and the test that pins it takes no expected byte from
anyone: both real records go through the parser and back out through the builder and must come back
**byte for byte identical**. Every field position and every reserved bit has to be right for that to
hold, which no self-built fixture could have shown.

### The VPS extension — what the layers actually *are*

Only the VPS says whether those layers are **views** or **scales**, which is the difference between
MV-HEVC and SHVC. `parseHevcVpsExtension` reads it: `isMultiview` is `scalability_mask_flag[1]`,
`ViewOrderIdx` is H.265 Table F.1, and it returns the layer ids, each layer's view order index,
`numViews`, `view_id_val`, and which layers each predicts from.

Getting there means walking the whole VPS — `profile_tier_level`, the sub-layer ordering loop, the
layer-set inclusion flags — before the extension starts. One structure is deliberately not walked: if
the VPS carries **HRD parameters**, the parser returns null rather than guessing their length, because
`hrd_parameters()` is not a fixed size and mis-skipping it lands every later field on the wrong bit and
reports confident nonsense.

**A real bitstream caught exactly that class of error.** `vps_extension()` opens with a
`profile_tier_level` whose `profilePresentFlag` is **0** — it begins at the level, omitting the profile
space, tier, idc, the 32 compatibility flags and the 48 constraint bits, 88 bits in all.
`parseProfileTierLevel` had always assumed the flag was 1, so it now takes it as a parameter. Before
that, the scalability masks read `1111000001000000` instead of `0100000000000000`: noise that still
looked like a parse.

The fixture is 57 octets — the real VPS out of MVHEVCS-A, a JCT-3V draft conformance bitstream —
embedded in the test. Every assertion comes from the stream's own description file rather than from the
parser: *"NumViews is equal to 2"*, *"NumDirectRefLayers of the non-base view is equal to 1"*,
inter-view prediction enabled. That last one pinned the bit alignment —
`direct_dependency_flag[1][0]` reads 0 the moment anything above it is off by a bit.

Over the whole 214 KB stream, `inspectHevcLayers` reports layers `[0, 1]` with 51 NAL units on layer 0
and 50 on layer 1, and layer 1 carries its own SPS and PPS but no VPS — which is what a two-view stream
with a shared VPS should look like.

## Live SRT output — `SrtTarget`

`@mediabunny/server` exports `SrtTarget`, the output counterpart to `NetworkSource`: an `Output` writes
to an SRT receiver the way it writes to a file. A byte sink carrying whatever the format writes — for a
live feed, `MpegTsOutputFormat`. It extends `AppendOnlyStreamTarget`, so all it supplies is a
`WritableStream` over a libav IO context. It calls out by default, listens with `?mode=listener`, opens
the socket on the first flush so constructing one never blocks, and bounds every wait with
`connectTimeout`. `passphrase` with `keyLength` 128/192/256 maps to SRT's `passphrase`/`pbkeylen`;
`latency` is taken in milliseconds and written as the microseconds libsrt expects. Any query parameter
the caller sets is kept.

**It drops rather than blocking.** Pushing back on a slow receiver would stall the muxer for as long as
the receiver was behind, which on a live feed is unbounded. A write queues and returns; a pump drains
it. Once `maxQueueBytes` (2 MiB default) is held, *arriving* bytes are dropped — not queued ones, so a
receiver sees a gap rather than reordered data — and counted in `droppedBytes`/`droppedDatagrams`.
`droppedBytes` is what this target discarded, **not** a count of what failed to arrive. A dead peer
surfaces as an error on close, which is where a caller reconnects by building a new `Output`.

What SRT itself does not promise: `transtype=live` is latency-bounded and discards rather than
retransmitting past its window, so delivery is lossy by design — use `transtype=file` where every byte
must arrive. **Both ends must agree on `transtype`**, or the handshake fails with a bare `EIO`. And a
receiver can lose what is still buffered when the sender closes, since ffmpeg's SRT read reports EOF on
a broken connection rather than draining first.

One trap for anyone writing a libsrt sender: **live mode defaults `SRTO_LINGER` to 0**, so closing
discards the send buffer — the handshake succeeds, every write succeeds, and the receiver gets `EIO`
with zero bytes. The target sets `linger` explicitly.

**`TargetWriter(target)`** carries bytes that are already muxed — a transport stream being relayed, a
file copied through — where an `Output` is how a container is *produced*. `write(bytes)` appends,
`flush()` is where backpressure lands, and `close()` flushes then finalizes. Writes are append-only and
the container's correctness is the caller's: nothing parses what passes, so a target needing seeks
cannot be written this way. It stakes the same claim on the target an `Output`'s `Writer` does, so a
target driven by both throws whichever comes second. Headroom is visible before anything is dropped
through `SrtTarget.queuedBytes` against `maxQueueBytes`.

A relay needing the bytes a source received uses `Source.readRange(start, end)`. Reading forward a
datagram at a time is the pattern `ReadableStreamSource`'s cache is sized for, and `maxCacheSize` bounds
how far back a re-read may reach.

**Disposing a listener with no receiver wakes the accept**, as `NetworkSource` and `RtmpSource` do: a
parked accept outlives a close and cannot be interrupted, so `finish()` dials the listener's own URL to
satisfy it. Without it, closing waits out the whole `connectTimeout`.

### A sending listener can vet the receiver that called in — `accept`

`SrtTargetOptions.accept` decides whether a receiver that dialled in may have the stream. It is called
once per accepted connection, before a single byte is sent, with the caller's `address`, `port`,
`family` and `SRTO_STREAMID` — the same `SrtCallerInfo` `SrtBondedSource` passes, so a host writes one
predicate for both directions. `false` closes that socket and the listener goes back to waiting;
`SrtTarget.refusedCallers` counts them.

**It implies `mode: 'listener'`**, and passing `mode: 'caller'` alongside it is an error rather than
silently ignored — a caller dials a known address and has nobody to vet.

**Providing it switches transports.** FFmpeg's `srt://` protocol offers no hook between SRT's handshake
and the first byte of data, so `accept` opens the socket with the libsrt build this package already
ships, calling `srt_listen`/`srt_accept` directly and reading the stream id off the *accepted* socket.
What that costs: the bind names the address directly instead of resolving it, so the URL's host must be
an IPv4 literal. Without `accept`, nothing about the existing path changes.

Every libsrt call stays non-blocking (`SRTO_RCVSYN`/`SRTO_SNDSYN` both 0): koffi calls libsrt on one
thread, and a blocking accept or send would hold it while nothing else in the process ran. A full send
buffer is retried rather than dropped there — the sink's own `maxQueueBytes` decides when bytes are
given up on, and a second hidden bound would make `droppedBytes` wrong. The queue, the drop accounting
and the 1316-byte datagram packing are above both transports and shared, so the two sockets cannot
disagree about what was dropped.

### Secrets never reach a message

A URL is the only way to give FFmpeg a protocol secret: `IOContext.open2(url, flags)` takes no options
dictionary, verified against the type rather than assumed, and a protocol's private options do not
exist until it has resolved the URL. So `SrtTarget` and `NetworkSource` build a URL holding the
passphrase and must keep it out of everything thrown or printed. `redactUrl` does that for their own
messages, and the FFmpeg log callback does it for `Connection to %s failed`, which prints the whole URL
at `AV_LOG_ERROR` from C. libsrt's own lines go straight to stderr rather than through `av_log`, and
carry the rejection reason but never the passphrase.

`NetworkSource` takes `passphrase`/`keyLength` as options rather than needing them in the URL. A
passphrase on a non-`srt://` URL is refused at construction.

**The redaction is installed by every class that can carry a secret**, not only by
`registerMediabunnyServer`: it lived only in the registration at first, so a host constructing an
`SrtTarget` without registering the server still got the unredacted line.
`installSecretRedactingLog()` is idempotent and called from both constructors. The two redactors differ
in form: a thrown message goes through `redactUrl`, which percent-encodes via `URLSearchParams`
(`passphrase=%5Bredacted%5D`), while FFmpeg's log line is redacted as text (`passphrase=[redacted]`).

**Only the main thread installs the callback, because FFmpeg's is one process-wide slot.**
`logRedactionInstalled` is module state, so each worker thread has its own copy and a worker that
registered the server installed its own callback into that single slot. When the worker exited the slot
was left owned by an environment that no longer existed, and the next thread to touch it died on
**SIGABRT with no JS error** — the whole process, not the thread. Measured with node-av alone: the crash
needs a callback installed on a worker that has exited *and* the main thread touching the slot
afterwards; neither alone does it, and no log line is involved, so this is the slot being replaced
rather than a dangling callback being called. A worker's lines still reach the main thread's callback,
so restricting the install costs no redaction.

**A failed `open2` closes its `IOContext`.** Both classes built a context and on a refusal threw without
closing it, so the native handle was left for the GC. SRT refusals arrive in bursts because a caller
retries, so a passphrase mismatch dropped a context per attempt. `throwFailedOpen` in `misc.ts` closes
it and raises the error. **This was not shown to fix any crash** — 150 leaked contexts against a dead
port and 40 against a wrong-passphrase listener, both with forced GC, did not reproduce one here.

**A bad passphrase is not distinguishable, and is not claimed to be.** A secret mismatch, a caller with
a secret against a listener without one, the reverse, and nothing listening at all all return the same
`-5` to the caller and `-60` to the listener. libsrt knows — it logs `Incorrect passphrase` and
`ERROR:BADSECRET` — but writes that to stderr itself rather than through `av_log`. The error names the
passphrase as something to check when one is configured, and does not diagnose it.

## AVC-Intra and XAVC in MOV, on the read side

An AVC-Intra or XAVC MOV — what cameras, Avid and MediaConvert hand around — opens as an `avc` track.
The sample entries are `ai5p`, `ai5q`, `ai52`, `ai53`, `ai55`, `ai56` for AVC-Intra 50, `ai1p`, `ai1q`,
`ai12`, `ai13`, `ai15`, `ai16` for 100, plus `aivx` for XAVC 10-bit 4:2:2 and `AVin` for the variant
with implicit parameter sets. The names encode the class together with the raster and the scan type,
which is why the two families differ by more than a number: AVC-Intra 50 is 4:2:0 on a subsampled
raster (1440x1080, 960x720) and 100 is 4:2:2 at full raster.

**These are not a retag of `avc1`.** They carry no `avcC` at all and their samples are Annex B with the
parameter sets in band — a file retagged from an `avc1` source without converting the samples is
unreadable (`No start code is found`). Recognising them therefore needs nothing else: the demuxer's
existing "`avc` with no description" path already reads the configuration record off the first packet.
The codec string comes out `avc3.…`, because in band is where the parameter sets are.

**They are written as well, for QuickTime output only.** A `MovOutputFormat` track whose bitstream is
AVC-Intra gets the matching entry, no `avcC`, and Annex B samples with the parameter sets in band — all
three together, since any one alone produces a file nothing can read. **MP4, CMAF, HLS and DASH output
is untouched**, and that scoping is measured: ffmpeg writes `ai12` for `-f mov` and `avc1` with an
`avcC` for `-f mp4` from the same essence, so these entries are a QuickTime convention.

**ffmpeg chooses the four-character code itself and overrides a caller-supplied `-tag:v`** — asking for
`avc1` on a 1080p25 High 4:2:2 Intra stream still writes `ai12`, and so does asking for `ai53` or
`AVin`. `avcIntraSampleEntry` keys on the same things: the intra profile (`profile_idc` 110 or 122 with
`constraint_set3_flag`), the chroma format, the **display** raster and the frame rate. Display, not
coded: H.264 codes 1080 as 1088 — seventeen macroblock rows — and crops it, so keying on `codedHeight`
matches nothing at 1080.

**The mapping and the carriage are tested separately, and that split is forced.** Which code *within a
family* ffmpeg picks depends on the frame rate its muxer had at the time, and a raw elementary stream
carries none. CI's ffmpeg picks `ai12` for a 24 fps fixture this machine's picks `ai13` for, and labels
a long-GOP stream AVC-Intra where this machine's does not — facts about an x264 build, not about either
library, and four releases went red before that was clear. So `test/node/avc-intra-entry.test.ts` tests
the table on synthetic SPS info — all twelve codes including the four interlaced ones no fixture here
can produce, the NTSC rates, and every rejection — while the fixture test checks the family, which the
bitstream does carry, and the carriage, which is the substance. The fixtures ask for no tag at all: what
ffmpeg picks *is* the expectation, and eight of the twelve codes are reached that way. The interlaced
codes and `AVin`/`aivx`, which ffmpeg will not write, have the four bytes patched into the `stsd`
instead — the same length, so nothing else moves.

Two details that decide whether the output is byte-exact:

- **An Annex B source passes through untouched.** Splitting and re-joining the NAL units would re-frame
  every start code to four bytes, and x264 emits three-byte codes for the units after the first, so a
  round trip would stop matching the essence ffmpeg wrote. The suite holds our MOV to ffmpeg's
  **per-packet CRC32** for five classes, which is what caught this.
- **A length-prefixed source is converted the other way**, with the parameter sets spliced from the
  `avcC` into each key frame, since the entry has nowhere else to keep them.

HDR static metadata is not spliced into these samples: `spliceNalUnitBeforeVcl` walks length-prefixed
NAL units and would corrupt Annex B. The `mdcv`/`clli` boxes still state the grade.

The shape alone is not enough, and the suite has the control: an ordinary long-GOP High 4:2:2 stream at
1080p25 must **not** be labelled AVC-Intra, and ffmpeg reaches the same judgement on the same file
independently. A mutation that ignores `constraint_set3_flag` is what showed that control was missing.

One trap in building such a fixture: `h264_mp4toannexb` only does its job on a length-prefixed source,
so encoding straight to the tag yields misaligned samples that ffmpeg's own decoder rejects with
`deblocking_filter_idc 27 out of range`. It takes two passes — encode to `avc1`, then copy through the
filter.

## MPEG-2 video — `mpeg2`

`'mpeg2'` is a video codec of this fork: encodable through `@mediabunny/server`, writable to MPEG-TS,
MP4, MOV and Matroska, readable back out of all four. It is what broadcast contribution and legacy
playout still take, and what an MPEG-TS programme of stream type `0x02` carries.

**The codec string is the object type indication, and it is the chroma knob.** 14496-1 gives MPEG-2
video one `mp4v` object type per profile of 13818-2, so `mp4v.61` is Main Profile at 4:2:0 and
`mp4v.65` is 4:2:2 Profile — the same relationship a ProRes four-character code has to its chroma
format, asked for the same way through `fullCodecString`. A `Conversion` derives the string and
therefore gets Main; `VideoSampleSource` takes it and can ask for either. `buildVideoCodecString` states
no profile or level beyond that, because both live in the bitstream's own sequence extension.

**A fixed chroma format outranks the 4:2:0 default, not just the encoder's ordering.**
`choosePixelFormat` consulted the chroma format only where 4:2:0 was unsupported, which is why it
worked for ProRes — whose formats are 10- and 12-bit only — and did nothing for MPEG-2, where
`yuv420p` is advertised first and matches the incoming depth. Before the change, `mp4v.65` produced
**byte-identical** output to `mp4v.61`. ProRes output is unchanged, the two paths agreeing for it.

**The level is a bound the encoder derives, not something the profile fixes.** Against the ffmpeg CLI
on 4:2:2 Profile: level code 5 (Main) for 640x360p25 and 2 (High) for 1920x1080p50. High Level arrives
on its own for high-rate content, and pinning it would state a bound the stream does not need.

Four things the encoder needs that no other codec here does:

- **A frame-duration time base.** MPEG-2 derives its `frame_rate_code` from the codec context's time
  base and validates it against 13818-2 table 6-4, so the microsecond base every other codec runs on is
  refused outright (`MPEG-1/2 does not support 1000000/1 fps`, `open2` returns `EINVAL`). For `mpeg2`
  alone the context takes `1/framerate`, and timestamps convert at the boundary.
- **Scene change detection off for a closed GOP.** `AV_CODEC_FLAG_CLOSED_GOP` alone makes `open2`
  return `AVERROR_PATCHWELCOME`; ffmpeg's CLI says why where the library does not — `closed gop with
  scene change detection are not supported yet, set threshold to 1000000000`. The flag is bit 31, so it
  is or-ed as unsigned: a plain `|` hands FFmpeg a negative int.
- **A GOP length MPEG-2 allows.** 600 is the maximum; the `2 ** 30` the other codecs use is reduced to
  it by FFmpeg with a warning on every encode.
- **One picture per access unit on the read side.** 13818-2 6.2.2: an access unit begins at a sequence
  header, a GOP header or a picture header, whichever comes first. Nothing else delimits it — there are
  no NAL units and no access unit delimiter.

**MPEG-2 must not take the Annex B path through the MPEG-TS muxer.** That path prepends an access unit
delimiter, and for anything that is not AVC it prepended HEVC's — `00 00 01 46 01`, whose code byte
reads as slice 70 of a 23-row picture (`slice below image (69 >= 23)`, on every frame but the first).
**Our own demuxer read the file back without complaint**, split the access units correctly and reported
125 packets; only ffmpeg's decoder called it corrupt. That is why the suite decodes every file with
ffmpeg and captures stderr.

**The programme is shifted by one frame, and that is correct.** MPEG-2 states a one-frame reorder delay
whether or not it uses B-frames, so the first packet's decode time is `-1/framerate` and the MPEG-TS
muxer shifts the whole programme to keep it from going below zero. The key frames still land on the
key-frame grid, measured from the first packet rather than from zero.

On the read side, `m2v1` is QuickTime's own MPEG-2 sample entry and carries no `esds`, which is what
ffmpeg writes for `-f mov`; MP4 uses the generic `mp4v` visual entry, and the object type indication in
its `esds` is the only thing that tells MPEG-2 video from MPEG-4 Part 2 — so `mp4v` alone sets no codec
and the `esds` decides. Nothing is kept out of band either way: the sequence header and its extension
ride ahead of every closed GOP, which is also where the dimensions, profile and chroma format are read
from.

**The profile in the codec string comes from the first packet, not from the container.**
`getCodecParameterString()` on a 4:2:2 track returns `mp4v.65` in all four containers, because
`extractVideoCodecString` takes an `Mpeg2CodecInfo` read off the stream. The container cannot answer
it: `m2v1` and `V_MPEG2` carry no box for the profile, MPEG-TS carries no sample entry, and an `esds`
only repeats what a writer claimed. 13818-2 8.2 signals 4:2:2 Profile with the escape bit and a profile
field of 0 (`0x85` at Main Level, `0x82` at High), and Main with profile field 4 (`0x48`). libavcodec
writes Main for `mp4v.60` and `mp4v.64` as well, so Main and 4:2:2 are the only two reachable.

## Overlay codecs with alpha — `qtrle` and `png`

A motion-graphics overlay is delivered as a `.mov`, and MediaConvert's motion image inserter takes
nothing else. The two codecs it comes in are **QuickTime Animation** (`rle ` sample entry) and **PNG in
MOV** (`png `), and neither was recognised: `getCodec()` returned `null`, `canDecode()` false, and a
`VideoSampleSink` threw. Both are in `VideoCodec` now, read by the ISO BMFF demuxer and decoded through
FFmpeg in `@mediabunny/server`, with the alpha channel kept.

**The sample entry's depth field is the configuration.** Neither entry carries a codec-specific box,
and the FFmpeg decoders for both take their pixel format from `bits_per_coded_sample` rather than from
the bitstream — without it `open2` returns `Invalid data found when processing input` for QuickTime
RLE. That number is the sample entry's `depth`, which the demuxer had been skipping over; it is read
and carried on the decoder config as `VideoDecoderConfigWithHdr.bitsPerCodedSample`, which is also how
the muxer knows to write `depth = 32` when such a track is copied. `CustomVideoDecoder.config` is typed
`VideoDecoderConfigWithHdr` so a custom decoder sees what the container stated.

Neither can be **encoded**: `CODEC_BIT_DEPTHS` lists none for either, and asking for a codec string by
target bitrate throws by name rather than falling through to a generic error. A track in one of them
can still be copied, and `videoCodecToBoxName` writes the matching entry back.

`test/node/alpha-video.test.ts` reads each fixture to the end and compares frame 0 to ffmpeg's own
decode of the same file, byte for byte, after asserting the synthesised colour `(255, 0, 0, 128±1)`
directly — a control that made the same mistake would otherwise agree. Half of 255 is not an integer,
which is where the ±1 comes from. VP9 alpha is asserted the same way but against no ffmpeg control:
measured, `ffmpeg -i transparency.webm -pix_fmt rgba` yields alpha 255 for every pixel, because its
Matroska demuxer drops the block-addition stream VP9 carries alpha in. Every case also asserts that the
alpha channel is not uniformly opaque, which is the failure the file exists for.

## MXF OP1a delivery — `MxfTarget`

`@mediabunny/server` exports `MxfTarget`, which writes **MXF OP1a** — the operational pattern broadcast
delivery specifications are written against, AS-11 (UK DPP) among them. MXF is not muxed by this
library: the target takes the **fragmented MP4** an `Output` writes and remuxes it through FFmpeg's
`mxf` muxer, so the file is OP1a by construction rather than by a hand-written KLV layer.
`new Mp4OutputFormat({ fastStart: 'fragmented' })` is required. Node only, and it writes to a path
rather than a stream, because the footer partition and index tables need a seekable file.

Options are `startTimecode` (`hh:mm:ss:ff`, or `;` for drop frame), `signalStandard` and
`storeUserComments`. Audio is **one stream per channel** — add an audio track per channel and each
becomes its own MXF track.

Three things measured rather than assumed:

- **No bitstream filters are needed.** FFmpeg's CLI reports inserting `h264_mp4toannexb` and
  `pcm_rechunk` for an `mp4` → `mxf` remux, but the video essence is Annex B either way (the first video
  packet begins `00 00 00 01 06 05`) and the audio packets are the same size, because libavformat's
  `mxf` muxer inserts what it needs itself. The CLI's message describes a CLI-level mechanism, not a gap
  in the library API.
- **The edit rate comes from `rFrameRate`, not `avgFrameRate`.** `addStream` copies the input's
  average, and over a short or trimmed fragmented MP4 that is a ratio like 300/13, which the muxer
  refuses outright: `Unsupported frame rate 300/13`. **ffmpeg's own CLI fails identically on the same
  file**, so taking the base rate is the truth rather than a workaround.
- **MXF carries frame-wrapped PCM, never AAC.** The muxer's own refusal is a bare `Invalid argument` —
  again, ffmpeg's CLI fails the same way — so non-PCM audio is refused by name, pointing at
  `audio: { codec: 'pcm-s24' }`.

**B-frames do not belong in it.** A reordered stream remuxes into MXF with non-monotonic DTS, and
ffmpeg's CLI reproduces that on the same input. OP1a delivery is all-intra — AVC-Intra is the point.

**Determinism needs `bitexact`, and the dates are a separate knob.** `mxfenc` draws the UMIDs at
random, so two runs differ in those bytes while the essence repeats exactly. `bitexact: true` sets
`fflags=+bitexact`, which fixes them and drops the version strings, and the file stays a conformant
OP1a with its timecode. Pinning the dates alone does **not** make two writes identical — the files
still differ at their UMIDs. `creationTime` pins the Preface's `LastModifiedDate` and each
Identification's `ModificationDate` independently — epoch by default, a `Date` for a real delivery
date, `null` for the wall clock — which matters when `bitexact` is off.

The other half is not the muxer at all: **two runs have to mux the same essence.** Encoding twice and
comparing measures the encoder, which varies run to run; muxing one encode twice across a second
boundary is byte-identical with `bitexact` and differs at the UMIDs without it. Both are tests, and the
second is the one that separates the writer from everything upstream of it. The suite asserts both
directions — identical with the flag, **different without it** — so the flag is demonstrably what does
the work.

`bmx` conformance (`mxf2raw --info`) is not run here: the tools are not installed. ffprobe's
`format_name=mxf`, the OP1a operational pattern UL, the timecode tag and a clean decode of every stream
— with **stderr** captured, since `execFileSync` returns stdout and ffmpeg complains on stderr, which
made an earlier version of these assertions vacuous — are what the test holds it to.

### The video descriptor's `BitRate`

`MxfTargetOptions.videoBitRate` states the MPEG-2 video descriptor's `BitRate` in bits per second,
which RDD 9 wants set to the rung's nominal rate — 50000000 for XDCAM HD422. Left unset, the descriptor
carries the rate the input stated, which for a trimmed programme is the average measured over what was
written.

**It was already being written, and `ffprobe` cannot see it.** `mxfenc` writes local tag `0x8000` of
the MPEG-2 video descriptor unconditionally from the output stream's `bit_rate`, and FFmpeg's `mxf`
**demuxer** never reads that tag — `bit_rate` in `mxfdec.c` appears only as the container-level rate
used for seeking. A file this target wrote before the option existed already carried
`0x8000 = 3221380` while ffprobe reported `N/A`; `ffmpeg -i in.mp4 -c copy out.mxf` reports `N/A` too,
with and without `-b:v`. The test therefore reads the descriptor out of the KLV, asserts the stated
rate against the carried one, and asserts that ffprobe still says `N/A` so the next reader does not
chase the same thing.

## Live RTMP input — `RtmpSource`

`@mediabunny/server` exports `RtmpSource`, so an `Input` can read a live RTMP publisher:

```ts
const input = new Input({
	source: new RtmpSource('rtmp://0.0.0.0:1935/live/key', { mode: 'listener' }),
	formats: ALL_FORMATS,
});
```

The FLV is remuxed to fragmented MP4 **in process** — no relay, no temporary files, and no FLV demuxer
in Mediabunny. AVC and HEVC (enhanced RTMP) pass through without re-encoding, as does AAC. `mode`
defaults to `'caller'`, matching `NetworkSource` where listening is likewise explicit.

**A publisher going away ends the stream; since node-av 6.2 that arrives as an error.** libavformat has
no EOF for a socket and reports a peer close as `EIO`. node-av 6.2 changed its IO adapters so a read
failure is an error rather than a clean end of stream, and its demuxer propagates read errors — so the
close that used to end the packet iteration cleanly began throwing `FFmpegError: Input/output error`.
The packet loop reads `EIO`, `EPIPE` and `EOF` as the end. The catch is deliberately only around the
packet loop, after the demuxer has opened: a *connect* that times out or cannot reach its address still
fails loudly. Upstream has no RTMP source and so no test that would have caught this.

**The remux muxer is closed when the publish ends, or the tail is lost.** A fragmented muxer holds the
fragment it is building until a flush point, so every packet after the last one sits inside the muxer
when the publisher goes away — not in the socket and not in the reader. Leaving it unclosed silently
truncated **every** stream by up to a fragment: 575 of 600 packets at the default half-second fragment,
which is exactly 25 frames at 50 fps. `RtmpTarget` closes its muxer in a `finally` and was unaffected,
which is why the loss looked direction-specific. The close happens inside the pump, before the stream
is ended, so the sink still enqueues what the trailer writes.

The tests read **to the end of the stream** rather than to a fixed count — a test that stops at *n*
packets cannot see a lost tail, which is why the existing ones did not — and compare packets to the
source's by SHA-1, in order. Timestamps are checked against the source's frame grid rather than its
values, because FLV carries them as integer milliseconds on a timeline restarting at zero.

One boundary is left as it is: when the **silence clock** ends a stalled stream it closes the
controller before the pump unwinds, so that pending fragment is dropped rather than flushed. Flushing
there would mean reaching the muxer from a timer that races the pump's own `writePacket`.

**Options are real AVOptions, not URL query.** rtmp parses its path as `app/playpath` and ignores the
query entirely, which is why `NetworkSource`'s approach cannot work here and why this is a separate
class. node-av's `Demuxer` accepts an options dictionary:

| bound | option | unit | note |
|---|---|---|---|
| accept a publisher | `timeout` | **seconds** | listener only — it *implies* `listen`, so a caller given it tries to bind |
| silent read | `rw_timeout` | **microseconds** | the read outlasts it by a multiple, measured 2–3x |

Both were measured rather than read off the names: `timeout=2` fails at 2.13 s and `timeout=6` at
6.16 s, which is what fixes the unit — one value cannot. For the read bound, a publisher frozen with
`SIGSTOP` so the socket stays open ends at 6.26 s for `rw_timeout=3000000` and 12.32 s for `6000000`,
and never without it.

**`readTimeout` reaches `rw_timeout` unscaled, and silence is also timed in JS.** `rw_timeout` bounds a
single read rather than the session, and FFmpeg resumes mid-packet after it fires instead of ending the
stream — the FLV demuxer reports that as a packet mismatch and packets are lost silently. **Scaling the
value down therefore destroys data.** Scaling it up only makes an ended stream slower to notice. So
`readTimeout` also drives a JS clock that ends the stream between fragments, where the demuxer is
whole. That clock starts at the first byte, not at open: waiting for a publisher is the connect bound's
business.

`connectTimeout` governs listening only, which is a protocol constraint: passing rtmp's `timeout` to a
caller rewrites the connection as `tcp://host:port?listen&listen_timeout=…`, so the caller tries to
bind and fails instantly with `Can't assign requested address`. A caller's connect is bounded by the
protocol — an unreachable, non-routable address fails in about five seconds whatever `connectTimeout`
says.

**The remux's `movflags` carry `delay_moov`.** Without it the mov muxer writes its header before it has
seen a packet, so every track's first fragment gets a `baseMediaDecodeTime` of zero and the A/V offset
across that fragment is lost — audio arrives level with the video where the source has it 21 ms ahead,
and only that one fragment is wrong. The cost is that the init goes out once the first packet of each
stream has arrived rather than immediately.

**The sink is `Muxer` into a `Writable`, not `FMP4Stream`.** `FMP4Stream` emits **nothing at all** for a
video-only input — not an error, no output. A/B on one file with one variable changed: `video.mp4`
gives 203,795 bytes, the same file with its audio stripped gives 0. Not RTMP (it fails the same way on
a plain file), not codec-string matching, not the AAC declaration. A video-only publisher is ordinary,
so that disqualifies it.

Fragment flushing needs the duration, not the flag. Over 300 packets:
`frag_keyframe+empty_moov+default_base_moof` alone writes 800 bytes with everything else buffered;
adding `flush_packets=1` changes nothing; `frag_every_frame` writes 153,808; and `frag_keyframe` with
`frag_duration` writes 111,151, the same incremental behaviour for 28% fewer bytes. `fragmentDuration`
defaults to 0.5 s.

**Disposal waits for the read in flight**, as `NetworkSource` does: closing the demuxer under a parked
native read aborts the process. `cancel()` marks the stream canceled, waits for the pump to settle,
then closes. The muxer side needs no such care — a callback-backed I/O context is freed rather than
closed, so there is no socket to race.

**Timestamps survive the remux, and the invariant is the decode time.** `EncodedPacketSink` yields in
decode order, so presentation times arrive reordered wherever B-frames say they should — 45 of 120
packets step backwards on a normal AVC source, which is correct. What must hold is that decode times
never decrease, that `pts >= dts`, and that the presentation sequence matches the same file read
directly with the same demuxer, rebased on each sequence's own first packet since the remux may shift
the timeline.

**node-av cannot serve an RTMP output.** Its `options` reach the muxer rather than the protocol, so
`rtmp_listen` comes back `Option not found` and nothing binds, confirmed with `lsof`. The test publisher
is node-av everywhere except the caller-mode test, which needs a server and uses `ffmpeg -listen 1` for
that one reason.

One wart when publishing FLV with node-av: `addStream` carries the source's `avc1`/`hvc1`/`mp4a` codec
tag across and FLV rejects it (`Tag avc1 incompatible with output codec id '27'`). node-av clears an
incompatible tag only when the output format offers a replacement, and FLV's table offers none, so
`test/node/_live-sender.ts` clears it explicitly.

## Timed events on the read side — `emsg` and SCTE-35

The fork could already *write* an `emsg`; it could not read one back, and it dropped SCTE-35 entirely.
Both are readable as standalone byte-level functions: no new track kind, no demuxer plumbing.

**`readEmsgs(segment)`** returns the Event Messages a packaged segment carries, in order, each as an
`Emsg`: `schemeIdUri`, `value`, `timescale`, the duration, the id, the payload, and exactly one of
`presentationTime` (version 1) or `presentationTimeDelta` (version 0), matching the box version.
`parseEmsgBody` reads one box body on its own and is the exact inverse of `buildEmsgBox`, which is how
it is tested — round-tripped both versions, plus a box cut inside a string, inside a 32-bit field, and
carrying an undefined version, each of which throws rather than returning a half-read event.

**`readScte35Sections(bytes)`** pulls `splice_info_section`s out of MPEG-TS with the splice point each
one states. Two details matter more than the parsing:

- **The PID comes from the program map, never from the stream type alone.** Stream type `0x86` is
  SCTE-35 only when the elementary stream carries a `CUEI` registration descriptor; without it the same
  value means DTS-HD Master Audio. A stream with `0x86` and no `CUEI` yields nothing, and that is a
  test, not an assumption.
- **Each section also carries where it arrived.** `arrivalTime` is the program clock at the packet the
  section starts in, in seconds, taken from the most recent PCR at or before it and not interpolated;
  it is `null` before the first PCR and where the PMT names no `PCR_PID`. `byteOffset` is that packet's
  offset in the bytes passed in. A `splice_insert` with `splice_immediate_flag` states no `time`, so
  this is the only time it can be carried at.
- **The time is `pts_adjustment` plus the command's `splice_time`**, wrapped into the 33-bit range,
  because SCTE-35 rides in private sections rather than PES and so has no packet PTS of its own. `time`
  is `null` where the command states no point — a `splice_null`, a cancelled event, a
  `splice_immediate_flag` insert, a per-component splice, or an encrypted section — each a stated
  absence rather than a zero.

Sections are reassembled across packets, and one still incomplete at the end of the buffer is dropped
rather than returned partially.

## `<ServiceDescription>` reaches the writer

The MPD model, parser and serializer already carried `<ServiceDescription>` with `Scope`, `Latency`
(`@target`, `@min`, `@max`, `@referenceId`), `PlaybackRate`, `OperatingQuality` and
`OperatingBandwidth`, at both MPD and Period level. What no caller could do was *set* one on the writer
path: `MpdParams` had no field for it and the `mpd()` factory hardcoded an empty list, so a DASH output
had no way to state a latency target and a low-latency player kept its own default delay.

`MpdParams.serviceDescriptions` renders under the root `<MPD>`, and the `mpd()` factory carries them
for AST callers. Times stay in milliseconds, as 23009-1 states them — a seconds conversion would turn a
3000 ms target into 3.

## `@availabilityTimeOffset` where the spec allows it

23009-1 5.3.9.2 allows `@availabilityTimeOffset` and `@availabilityTimeComplete` on `SegmentList` as
well as `SegmentTemplate`, and 5.6.4 allows them on `BaseURL`. All three carry them here, parsing and
serializing, so a low-latency Period written as an explicit `SegmentList` can state its availability.

Both are optional on `MpdBaseURL` and `SegmentList`, and the parser sets them only when the element
carries them, so an MPD without them parses to the same shape it always did. The serializer omits the
spec defaults rather than writing `availabilityTimeOffset="0"`.

## Faithfulness to shaka-packager

The HLS/DASH output ports are kept synced to shaka-packager and audited for 1:1 fidelity, and shaka's
unit tests are ported alongside each feature. Last synced to **shaka-packager v3.8.0** (2026-07-03).

That sync corrected drift where our ports had fallen behind or over-simplified: multi-period on-demand
text `presentationTimeOffset` (shaka #1493/#1433), HLS master `DEFAULT`/`AUTOSELECT` computed per
`(group, language)` with DVS and forced-subtitle handling, `SegmentTemplate` duration integer
truncation, `#EXT-X-START:TIME-OFFSET` `%f` formatting, HLS language shortest-form reduction, DASH
`ContentProtection` attribute precedence, full-proto `ProtectedContent` equality, and
`GetStaticMpdDuration` float32 accumulation. It also added previously-unported subsystems: the HLS
**live sliding window**, **CEA closed captions**, and **rendition index/group-id ordering**.

Intentional, documented deviations (everything else is a faithful mirror):

- **Path-aware `<BaseURL>`** — unencoded `/`; shaka URL-encodes them.
- **No-filesystem `RemoveOldSegment`** — the live window returns dropped segment names via
  `MediaPlaylist.getSegmentsToBeRemoved()` for the caller to delete, rather than performing
  `File::Delete`.
- **`HlsParams.discontinuitySequenceNumber`** — an initial-seed input the fork adds, kept additive.
- **`scaling_list_data()` is walked, not refused** — shaka's `H265Parser` gives up on it; this fork
  walks it so such streams can be encrypted.
- **`#EXT-X-TARGETDURATION` rounds to the nearest integer**, which RFC 8216 §4.3.3.1 allows; shaka
  takes the ceiling, so a 4.004 s NTSC segment advertised 5.

## The fork adds to upstream; it does not delete from it

Every change to a file upstream also owns is **additive**. A deletion of upstream's code is an
exception, and almost always one of two things: a file the fork rewrote outright (`hls/hls-muxer.ts`
became `segment-pipeline-muxer.ts`, `hls/hls-demuxer.ts` was re-pointed at the extracted playlist
parser), or an integration edit of a few lines.

The exception has been abused by accident. Twice, a rebase conflict resolved in favour of the fork's
older copy **deleted an upstream bug fix** — `#567` (decoder queue pressure, `media-sink.ts`) and
`#555` (out-of-spec `VideoFrame` colour, `sample.ts`). Both shipped. A third pair, `#553` and `#572`
(server colour handling), shipped the same way, and is why this check now covers `packages` as well:
watching only `src` and `test` left the whole server extension outside the guard. Nothing caught them,
because the deleted code was upstream's and the fork's own tests never covered it.

`scripts/check-upstream-deletions.ts` runs in `npm run check`. `scripts/upstream-deletions.json` is an
**inventory of the upstream lines this fork does not have** — the lines themselves, across 50 files in
`src`, `test` and `packages`, plus two files the fork replaced outright whose whole contents are the
declared divergence. Any upstream line that goes missing without being listed fails the check, by name.

It is deliberately **not a count**. A number cannot say whether a deletion is legitimate, it nets out
when one file drops a fix while another grows an unrelated deletion, and when it trips it names only a
file. The inventory answers the question a reviewer actually has: *should this line be gone?*

It compares **file contents, not diff markers**. A `-` in a diff means "not at this position", not
"absent from the file", so reading those lines reports a heavily rewritten file as missing lines it
plainly still contains — one test file was flagged for three lines the fork has *more* copies of than
upstream. A check that cries wolf gets `--update`d reflexively, which is exactly how a real deletion
would get through. It counts occurrences of each trimmed line in upstream's copy and in the fork's and
reports the shortfall, so re-indenting a block upstream does not read as a deletion while dropping a
second copy of an already-declared line still does.

**`--update` refuses to record a line upstream's own history calls part of a fix.** Recording whatever
is currently missing leaves the hole the check exists to close: a rebase that drops a fix plus an
`--update` in the same session converts the loss into "declared". It blames each newly missing line
against upstream's current file and refuses, by name and with the commit subject, any line whose
subject is fix-shaped. Verified by deleting upstream's `closeOnce` (`#618`): both the check and
`--update` fail, naming the fix, and the inventory is untouched. `--force` records anyway, for a line
the fork means to replace — say why in this file when you use it.

It matches on the commit subject, so a **feature** commit whose subject mentions a fix trips it too:
replacing the MPEG-TS PID assignment was refused because the commit introducing the muxer is titled
"Add MPEG-TS muxer, fix a demuxer bug, …". That is the intended cost — it asks rather than guesses.

It covers `test` as well as `src`, because an upstream test is upstream's contract and a fork edit that
re-points one reads as green. Three of upstream's MPEG-TS muxing tests fail here after a rebase drops
them, and being browser tests they stay out of node-only runs. Every report of "the suite" is `npm
test` — node and browser both.

### The declared test-bound divergences

- **`bad-inputs.test.ts`'s `Matroska: Clusters with decreasing timestamps`** carries 30 s where
  upstream carries 10 s. Its two MP4 siblings keep upstream's 20 s, not having been seen to overrun.
  This one is ~1 s of work here and **14,680 ms** on a loaded CI runner, where it failed a release;
  across six CI runs of the same tree it measured 887 / 1326 / 2568 / 2869 / 7755 / 15647 ms, a 17x
  spread, while an unloaded A/B of the same change gave 506 ms against 517 ms. What these tests catch
  is **quadratic** behaviour, which shows up as orders of magnitude, so a raised bound still fails on
  the regression they exist for.
- **`test/browser/quality.test.ts`'s `Medium quality with codec 'vp8'`** carries 60 s where upstream
  gives every codec 10 s. That test does ~0.6 s of work alone and overruns only under the full suite,
  where the browser project runs alongside the node one — headroom, which is what a raised bound is
  for. It is the only diverging line in that file: an earlier attempt replaced every per-test bound in
  three files with one file-level `vi.setConfig`, deleting 20 upstream lines to solve one test's
  problem.
- **`server-extension.test.ts`'s `VP8 conversion roundtrip`** takes the same `duration` argument
  upstream already gives `hevc` in that file, and for the same reason. See below.

### VP8 costs what libvpx costs

VP8 is the one roundtrip in that file that costs real CPU. The first cause was an encoder divergence,
and it is the only VP8 one now: `packages/server/src/video-encoder.ts` sets `deadline=realtime`
unconditionally for `libvpx-vp9`, and for `libvpx` set it only inside `isRealtime` while leaving
`cpu-used=8` outside — the intent to go fast was stated and only the mode knob was missing. With
`deadline` set for both, that branch's two arms collapse into one, which is why `if (isRealtime) {` and
the duplicate `cpu-used` are declared deletions. That took 42 s to 13 s.

The remaining cost is libvpx's. Timing the halves of the roundtrip in one process, so both codecs share
whatever load the machine is under:

| | frames | encode | decode |
| --- | --- | --- | --- |
| VP8, as upstream writes the test | 125 | 8.7 – 11.8 s | 62 ms |
| VP9, same run | 125 | 0.9 s | 92 ms |
| VP8, one second of it | 25 | 1.8 s | 17 ms |

The decode is free and the encode is 9 to 13 times its successor's *after* the `deadline` fix.
`cpu-used` is not the lever — raising it from 8 to the 16 libvpx's VP8 range allows took 8.69 s to
7.82 s, under 10% — and this FFmpeg's `libvpx` encoder exposes no token-partition option, so there is
nothing to thread the frame over.

A 20 s bound around a 9 to 12 s encode passes alone and fails in a loaded full-suite run. The trim
carries every assertion in the roundtrip — per-sample dimensions, per-sample timestamps against the
source, and the sample count — for 1.8 s instead of 11.8 s. **Trimming the work is not the same as
raising the bound: the bound still means something.**

### MPEG-TS: when the programme is shifted

PES timestamps are unsigned 33-bit and H.222.0 requires `DTS <= PTS`. A packet that presents at 0 but
decodes earlier — any B-frame source — has no legal encoding: the negative decode time wraps to a value
near 2^33 and reads as decoding a day after it presents. `video-h265.mp4` does exactly this, and muxed
upstream's way 2 of its 149 PES packets carry `pts=0, dts=8589928592`.

So the muxer shifts the programme forward by the smallest amount that restores the relation, as
ffmpeg's `avoid_negative_ts` does. It shifts **only** for that case: a programme negative in both
fields wraps both by the same amount, `DTS <= PTS` still holds, and a reader that unwraps gets the
timeline the caller asked for. Shifting those too is what broke upstream's two round-trip tests.

Shifting is visible in a duration — both tracks then begin at the shift rather than 0, and MPEG-TS has
no edit list to hide the gap — so upstream's `HEVC and MP3` durations read 0.0667 s longer here. That
is the one upstream test expectation this fork restates.

## An ESM-only dependency breaks the CommonJS bundle

`@mediabunny/server`'s declared `require` entry could not be loaded at all: the bundle is built with
`packages: 'external'`, which externalises every dependency, and `turbores` — reached through the
ProRes decoder the server registers — states no `require` condition in its `exports`. The CJS bundle
therefore emitted `__require("turbores")`, and every CommonJS consumer got
`ERR_PACKAGE_PATH_NOT_EXPORTED` before any of its own code ran. The ESM entry was unaffected, which is
why nothing caught it.

`turbores` carries no native addon, so it is inlined instead of externalised; `node-av` stays external
because it does carry one, and inlining it would break the platform-specific binary resolution it does
for itself. The server bundle's externals are stated as a list rather than `packages: 'external'`.
`server-extension.test.ts` requires the built CJS bundle in a child process, because every other test
reaches this package through the ESM entry and so cannot see a broken `require`.

## Adding a package upstream introduces

Publishing here is OIDC-only, and **npm has no pending publisher**: a trusted publisher can only be
configured for a package that already exists, so the first publish of a name npm has never seen must be
token-authenticated.

Wire the package into `vitest.config.ts`, `node_modules/@mediabunny/<name>`, `docs:generate` and
`PACKAGES`, then list it in `NEEDS_FIRST_PUBLISH_BY_HAND` so a normal run skips it rather than failing
every release. Publish it once from a shell logged into npm:

```sh
npm run build
npx tsx scripts/publish-fork.ts --version <version> --only packages/<name> --dry-run
npx tsx scripts/publish-fork.ts --version <version> --only packages/<name>
```

Then add its trusted publisher on npmjs.com (repository `ahmedrowaihi/mediabunny`, workflow
`publish-fork.yml`) and empty `NEEDS_FIRST_PUBLISH_BY_HAND` again. Note npm points a brand-new
package's `latest` at whatever is published first, so one that starts life on a prerelease has `latest`
on that prerelease.

**A test that cannot run everywhere skips, naming what it needs.** Running the suite on a runner for
the first time found four kinds of test that only passed on this laptop: 94 that read shaka-packager's
test media from a sibling checkout (`test/node/_shaka-corpus.ts` resolves it and `hasShakaCorpus` gates
them), three that need the `ffmpeg` binary rather than node-av, three that need an HEVC encoder the
platform may not have (asked through `canEncodeVideo` while the tests are collected), one caption row
that names VideoToolbox, and the 34 HLS input tests that serve third-party media no one commits —
which also crashed `afterAll` on an undefined server, so a missing fixture directory failed the file
twice over. Each was a test asserting nothing about the code and everything about this laptop.

**`package-lock.json` must be written with default peer resolution.** This machine's npm has
`legacy-peer-deps = true` in its user config, which makes npm ignore peer dependencies while resolving
— so a lock regenerated here omits the `node_modules/mediabunny` self-link the workspaces' peer needs,
and the optional peers of the docs tree. The lock then reads as in-sync to the npm that wrote it and is
rejected by `npm ci` anywhere else (`Missing: mediabunny@1.65.0 from lock file`). Regenerate with
`npm install --package-lock-only --legacy-peer-deps=false`, **in a tree with no `node_modules`** — with
one present, npm resolves against it and reports nothing wrong.

**The branch has its own CI.** Upstream's workflows trigger on `main` and pull requests, so nothing
checked the branch this fork publishes from. `fork-ci.yml` runs the release gates on it — `npm run
check`, `lint`, `build`, `docs:generate --dry` and `xvfb-run npm test` with `npm ci`, so node-av's
native binary is present for the server tests. The publish job runs the four that need no binary before
it spends a version number, since a version is gone the moment npm accepts it.

## A release does not build libsrt

`@mediabunny/server` ships libsrt built for four platforms, so a published package needs nothing
installed on the host. The publish job refuses to publish unless all four are present — **by name, not
by count**, because a package with one platform's library and three missing silently falls back to a
system libsrt that usually has no bonding.

**The publish does not build them.** `build-libsrt.yml` is `workflow_dispatch` only: run it by hand
when `srt-version` changes, and it uploads each platform to a `libsrt-prebuilds-<version>` release that
the publish downloads from. libsrt changes about once a year; building it on every release put a
**macOS runner on the critical path of every release**, and GitHub withheld one four times in a single
day — four failed releases with nothing wrong in the code.

Bumping the version means bumping it in **both** files — `srt-version` in `build-libsrt.yml` and
`SRT_VERSION` in `publish-fork.yml` — and running the build. Until it has run the tag does not exist
and the publish fails by name (`run build-libsrt.yml for <version>`) rather than quietly publishing
against the previous library.

The darwin asset in the current prebuilds release was **built by hand**, by replaying the workflow's
own cmake invocations on an arm64 Mac (same libsrt tag, same mbedTLS tag, same options, same deployment
target), because GitHub withheld a macOS runner for every attempt. It was verified exactly as CI
verifies one: `check-self-contained.py` reports only `/usr/lib/libc++.1.dylib` and
`/usr/lib/libSystem.B.dylib`, and `srt-bonding.test.ts` passes against it rather than skipping.
Re-running the workflow overwrites it with an identical build.

**The prebuilds must not depend on mbedTLS at runtime, and for two releases they did.** The macOS build
linked Homebrew's mbedTLS *shared*, so the published dylib carried
`/opt/homebrew/opt/mbedtls@3/lib/libmbedtls.21.dylib` as an absolute path from the build machine. On
any Mac without that formula `dlopen` failed — and because `getLibsrt` falls through to the next
candidate, what loaded was the *system* libsrt, which has no bonding. `SrtBondedSource` then failed
with "built without bonding" while the package shipped a perfectly good bonding build it could not
open. Linux had the milder form (`NEEDED libmbedcrypto.so.7` by soname); only Windows was safe, vcpkg's
static triplet linking it in.

The reported symptom pointed elsewhere — a system library shadowing the bundled one, i.e. a search-order
bug. The order was already right. Setting `MEDIABUNNY_LIBSRT` to the bundled dylib reproduced the
*same* error naming the Homebrew path, which is what ruled search order out: **an override that is
honoured cannot report another file.** `otool -L` on the published artifact named the cause in one line.

mbedTLS is now **built from source as static**, and libsrt is pointed at it with **libsrt's own
options** — `-DSTATIC_MBEDTLS=ON -DMBEDTLS_PREFIX=…`, which come from `scripts/FindMbedTLS.cmake` in
libsrt itself. Two cmake-level guesses failed first, because that find module consults neither
`CMAKE_PREFIX_PATH` nor `CMAKE_FIND_LIBRARY_SUFFIXES`: reading the find module settled in a minute what
guessing had not. mbedTLS 3.6.x also keeps its cmake framework in a submodule, so a `git clone --depth
1` without `--recurse-submodules` cannot configure at all.

mbedTLS compiles its own sources with `-Werror`, so a clang newer than the release fails on a warning
in code we are not touching — the macOS runner rejected 3.6.2's TLS 1.3 label table while both Linux
runners built the same tag fine. `-DMBEDTLS_FATAL_WARNINGS=OFF` settles that: their `-Werror` is a
policy for their CI, not for a consumer pinning a tag. **The mbedTLS version belongs in the cache key**,
since a build of a different one is a different artifact and a key that cannot say so serves the old
build back.

Because "I changed a cmake flag" is not evidence, the artifact is checked **twice**: `build-libsrt.yml`
fails the build if the library it just produced references mbedTLS dynamically, and `publish-fork.yml`
checks all four again with `.github/scripts/check-self-contained.py`, which reads ELF `DT_NEEDED`,
Mach-O `LC_LOAD_DYLIB` and PE imports directly rather than shelling out to a tool that exists on one
runner.

The second check is not redundant: **the prebuilds release is a cache.** It held one statically-linked
platform beside three that still wanted mbedTLS, because each platform uploads into it from its own
run. Checking only at build time means an old asset ships unexamined.

**Two things not to do.** Do not make a missing platform `continue-on-error`: a published
`@mediabunny/server` without a macOS libsrt is broken for every macOS consumer, silently. And do not
mark the prebuilds release `--prerelease` — `publish-fork.yml`'s prune step deleted it with
`--cleanup-tag`, which removed the git tag, turned the release into a draft and took the darwin dylib
with it; the next publish failed inside the download with `no assets match the file pattern`, which
reads like a download bug and was a garbage-collection bug. The release is created with
`--latest=false` and no `--prerelease`, *and* the prune filters `startswith("v")` as well as
`isPrerelease`.

**A broken prebuilt used to be invisible to the test suite**, which is why it shipped twice.
`srt-bonding.test.ts` probes `getLibsrt` and *skips* every bonding test when it fails — and it fails
exactly when the bundled library cannot load, because the fallback then reaches a system libsrt without
bonding. Green suite, broken package.

`test/node/libsrt-prebuilt.test.ts` draws the missing distinction: no prebuilt for this platform is
fine to skip, a prebuilt that is *shipped and does not work* is a failure. It forces
`MEDIABUNNY_LIBSRT` to the bundled path so a system library cannot stand in, which is also why it is a
file of its own — `srt-bonding.test.ts` deliberately probes the *default* resolution order, and an
override set there would mask a resolution bug. Both were verified against the actual broken dylib from
npm, not a fixture.

**On why a native library is here at all.** node-av's FFmpeg already bundles libsrt, and the ordinary
`srt://` path goes through it. The four prebuilds exist for the two things FFmpeg's wrapper does not
expose: **socket groups** (bonding) and the **`accept` allowlist**, which needs a hook between the
handshake and the first byte. WASM would not remove them — it has no raw UDP, Emscripten's socket layer
is WebSocket-based, and libsrt wants BSD sockets and threads. What *would* is speaking SRT in TypeScript
over `node:dgram`, as `RistTarget` speaks RIST. That is a real option and a real project: SRT's ARQ,
ACK/NAK timing and key-material exchange are where its correctness lives.

**Nothing in `check`, `lint`, `build` or the test suite covers a workflow file.** The first real test
of any of this is the next publish run — which is how the prune bug was found, one release too late.

## A publish that npm takes and drops

Everything publishes to `pending` first; `beta` and `latest` move only once **every** package answers
on the registry. That gate is what protects consumers, and it is tested: `--promote-only` against a
version that does not exist polls, refuses, and leaves the tags where they were.

**A set npm has not finished serving is "not yet", and a poller finishes the job.** Failing the run on
an incomplete set was the wrong trade: lateness is the normal case — `dts` took 720, 1110, 1200 and
1590 seconds on four consecutive releases — so every push run was red and every release was promoted by
hand, and red that always means "wait" stops being read at all. The push run waits 8 minutes, promotes
if it can, and otherwise exits green with a `notice` naming what is missing (`--if-complete`). **A red
publish run therefore means a publish was rejected**, which is worth looking at.

Catching up a release npm served late is **not** on a timer. Two things cover it:

- **Every publish run first promotes whatever `pending` has become complete since** (the catch-up step,
  `continue-on-error`), so the next release fixes the previous stranded one with no intervention.
- **A `workflow_dispatch` with `promote_version`** moves the tags onto an already-published version
  without publishing a new one — the deliberate path for a release that must not wait.

There is no `schedule` trigger: it spent a runner every tick to discover there was nothing to do.
**Anything that moves a dist-tag has to live in `publish-fork.yml`**, though — npm's trusted publisher
is configured per workflow *file*, so a separate file has no credential and `npm dist-tag add` fails
with a bare exit 1, and nothing in this repo can grant it, since that is a setting on npmjs.com. It was
tried as `promote-pending.yml` first and that is exactly how it failed.

**A set that is still incomplete hours later is not the same as a drop**, and the difference costs a
version number if you get it wrong. Re-check after ~30 minutes, then apply the one test that separates
them: if the version document is still absent while a *later* version of that same package exists, the
publish was dropped and only a new version gets out of it, because npm refuses a retry of the same
version with a 409. Otherwise it is merely late. Both states look identical for the first few minutes
and both log the same `+ @ahmedrowaihi/…@version` acceptance line, so acceptance says nothing either
way — only the version document appearing does.

## Dist-tags

Every release moves **both** `beta` and `latest` onto the same version, once npm serves all nine
packages. `latest` is what a bare `npm i` resolves to; left alone it stays on whatever each package
first published, which is a different stale version per package — the core and an extension can then
disagree. `pending` is the holding tag each package is published to before the set is verified.

## Versioning

`package.json` carries upstream's base version verbatim. The publish workflow strips any trailing
`-beta.N` and appends `-beta.<github.run_number>`, giving a monotonically increasing beta tag.
Consumers should pin exact versions rather than tracking the floating `beta` dist-tag.

Every package in the repo ships per release under the `@ahmedrowaihi` scope with the same `-beta.N`:
the core as `@ahmedrowaihi/mediabunny`, each extension as `@ahmedrowaihi/mediabunny-<name>` —
`server`, `prores`, `mp3-encoder`, `aac-encoder`, `flac-encoder`, `ac3`, `dts`. The extensions
peer-depend on a package named `mediabunny`, so a consumer aliases the core to that name
(`"mediabunny": "npm:@ahmedrowaihi/mediabunny@<exact version>"`). Install them from the same release.

**The base comes from `upstream/main` at run time, not from our own copy**, which only changes when
someone remembers to bump it — we published `1.61.4-beta.N` against upstream 1.61.6 code for a while,
which reads as "based on 1.61.4" and sorts below upstream's actual base.

### How a release is cut

- **CI (normal).** Push to `publish-ahmedrowaihi`. The workflow stamps `${BASE}-beta.${run_number}`,
  builds, then runs `npx tsx scripts/publish-fork.ts --version <version> --tag beta`. The version is
  knowable before npm is — it is the run number — and the workflow writes it to the job summary and
  cuts a GitHub release tagged `v<version>`. Read it from there, **never from `npm view`**: a dist-tag
  read mid-publish returns the previous release.
- **Finishing a stranded release.** A run can go green without moving `beta`, since the tag advances
  only once npm *serves* every package, which can take hours. Do **not** re-run the run: the base is
  read from `upstream/main` at run time, so a re-run after upstream has released publishes a
  *different* version instead of promoting the stranded one (`1.62.0-beta.154` became
  `1.62.1-beta.154` four days later and left `beta` where it was). Dispatch the workflow with
  `promote_version` set to the stranded version instead; it skips publishing and only moves the tag.
  The next ordinary release also picks it up.
- **Locally.** `npm run build` first — the script refuses to publish a package whose `dist` is
  missing, but cannot tell stale output from fresh. Then `npx tsx scripts/publish-fork.ts --version
  <version>`, optionally `--only <dir>` and `--dry-run`. A local publish prompts for 2FA per package.

The script rewrites each manifest, publishes and restores it, so the tree keeps upstream's package
names whether the run succeeds or fails. It publishes in dependency order (core, extensions, server
last, since the server depends on ProRes) and skips any package already on the registry at that
version. CI calls the same script, so there is one definition of what a release is.

**Publishing is OIDC, configured per package.** No npm token exists in the workflow: it mints a GitHub
OIDC token (`id-token: write`, `npm@^11.5.1`) which npm trades for a short-lived credential. Trusted
publishing is configured **per package** on npmjs.com, naming organization, repository and workflow
filename, so every new package needs its own entry first — without one, publishing fails with
`404 Not Found - PUT`, which reads like "missing" and means "not permitted".

Two requirements that are easy to miss: `repository.url` must match the publishing repository exactly,
which is why `scripts/publish-fork.ts` rewrites it along with the name; and `npm dist-tag` is a
separately allowed action in the trusted-publisher settings, used when the script skips an
already-published package to repair a stale tag.

**Re-running a release is normal, so every step is idempotent.** Publishing skips packages already on
the registry and treats npm's `409 Cannot publish over previously staged version` as "already has these
bytes"; the GitHub release step updates an existing release rather than failing with `422
Release.tag_name already exists`; pruning tolerates a tag that is already gone. A re-run that finds
everything done ends green, because a red run that was actually fine teaches people to ignore red runs.

**Metadata lands before the artifact.** After any publish the version document, `npm view` and the
dist-tag go live before the `.tgz` does, and the gap has run to ten minutes. A 404 on the tarball while
`npm view` resolves is the normal window, not a failed publish; the publish line in the run log
(`+ pkg@version`) settles it. Gate an upgrade on the `.tgz` returning 200, not on `npm view`.

**One published version will never be served:** `@ahmedrowaihi/mediabunny-dts@1.61.4-beta.128`. npm
accepted it, held it in "Validating" and never completed; it is absent from the packument, 404s to
consumers, and cannot be republished (409). Every other gap in the sequence is a package that did not
exist yet.

### Why every extension is republished rather than taken from upstream

A caret range cannot be satisfied by a prerelease: semver excludes prereleases from a range unless the
range carries one on the same `major.minor.patch`. Upstream's extensions peer-depend on
`mediabunny: ^1.0.0`, so none could be satisfied by a `-beta.N` core, and any install mixing a fork
core with an upstream extension reported an invalid peer — `npm ls` exiting 1 with `ELSPROBLEMS`,
reddening a CI step over a dependency the consumer could not fix. The fork's own build of each
extension stamps the peer to the exact version being released. The server's dependency on ProRes is
rewritten to an npm alias at publish, so source imports never change.

**The exact peer range closes a silent substitution**: upstream has no `-beta.N`, so a consumer who
forgets the alias cannot have upstream's core quietly resolved in place of the fork's and then fail at
the first undefined function.

**That range is a plain version, deliberately not an `npm:` alias.** Stating the alias makes npm
*satisfy* the peer by installing the fork's core a second time under `@ahmedrowaihi/mediabunny`,
beside the `node_modules/mediabunny` the consumer aliased: `Mediabunny was loaded twice`,
`scoped.Source !== bare.Source`, and `new Input({ source })` refusing a source an extension constructed
because `instanceof Source` is false across the boundary. The obvious repair — declaring the peer under
the scoped name and rewriting the published specifiers — moves the two copies onto the aliased install
instead. **There is one supported name for the core, `mediabunny`**, and the peer range is what makes
any other shape fail at install rather than at runtime.

**The peer is also `optional`, and without that the exact range broke a correct install.** npm cannot
read a version off an aliased node — its own warning says `Found: mediabunny@undefined` — so the peer
never matches, and a *required* peer that does not match is fetched from the public registry, where
upstream has no `-beta.N`. The ETARGET meant to catch a consumer who forgot the alias fired on one who
used it. It only reproduces when the alias sits in a **dependency's** manifest; on the install command
line it resolves before the peer check, which is why the original measurements missed it.

`optional` stops the fetch without giving up the check: npm still compares the peer when a bare
`mediabunny` is resolvable and warns on a mismatch.

| peer declaration | alias in a dependency | alias on the command line | upstream core installed | scoped core, no alias |
| --- | --- | --- | --- | --- |
| exact, required (before) | **ETARGET** | ok | ERESOLVE error | ETARGET |
| exact, **optional** (now) | ok, one copy | ok, one copy | warns, core unresolvable | `MODULE_NOT_FOUND` on first import |
| `npm:` alias | ok | ok | ERESOLVE error | **two copies, silent** |
| no peer at all | ok | ok | **upstream silently accepted** | `MODULE_NOT_FOUND` on first import |

The two rejected rows are rejected for the reasons in bold. What `optional` costs is the last column —
a consumer installing the scoped core without the alias fails at the first `import 'mediabunny'`
instead of at install, which is still a hard, named failure.

This applies to **every** package carrying the peer, not just the server: `@mediabunny/prores`
declares the same one and the server depends on it, so marking the server alone leaves the install
failing identically. `test/node/fork-packaging.test.ts` asserts all eight.

**Resolve the core through one specifier only.** The package exposes both a modules entry and a bundle
entry, so an app resolving one while an extension resolves the other loads the library twice; each copy
keeps its own codec registry, and codecs registered by the extension are invisible to the app, which
surfaces as `undecodable_source_codec` rather than naming the real cause. The library logs
`Mediabunny was loaded twice`.

The repo retains the most recent **3 beta releases**; older GitHub Releases are auto-pruned, and the
npm tarballs still resolve. Each publish creates a GitHub Release at `v<version>` with the commit delta
against upstream `release` at that time.

## One upstream test's timeout, raised

`test/node/target.test.ts`'s *Chunked StreamTarget with a single write spanning many chunks* runs at
**30 s** here against upstream's 10 s. Nothing about the test changed.

It writes 51.2 MB through 1 KiB chunks, so it is 50,000 `write` callbacks and CPU-bound by design —
that is what the test is *for*. On its own it takes about 1.9 s. Under the full suite it timed out at
10 s three times on one day and passed every time it was run alone. The headroom was wrong, not the
test, and this fork's suite is larger than upstream's — the MPTS, statmux, ST 2110 and IMF files all
came with it, and the statmux one drives two software encoders flat out.

Raising it rather than shrinking the write keeps what the test proves: a single write really does span
many chunks. A genuine break here fails fast or hangs; it does not quietly take 25 seconds.

## `WideVideoColorSpaceInit` accepts an explicit `undefined`

Every optional field spells out `| undefined` even though it is already optional. Under
`exactOptionalPropertyTypes` those are not the same thing: `?: T | null` accepts an **absent** property
but refuses one explicitly set to `undefined`. So a consumer compiling with that flag could not pass
what this library's own API hands back —

```ts
colorSpace: await track.getColorSpace()   // VideoColorSpaceInit -> WideVideoColorSpaceInit
```

— and it failed on every field. Without the flag the `| undefined` changes nothing, which is why none
of this repo's own tsconfigs ever saw it.

`test/types/exact-optional-property-types.ts` is compiled with the flag on by a test of its own, and
imports from **`dist/`** rather than `src/`: the built declarations are the surface a consumer actually
compiles against, and re-checking our internals under a flag this repo does not adopt fails on
unrelated places where they assign an explicit `undefined` to a DOM type.

## A packing list is a claim about octets, so check it

`verifyImfPackage` reads every asset the PKL covers and compares what it holds against what the list
said. `resolveImfPackage` already checked that the three documents agree about which assets *exist*;
this is the other half. It is deliberately separate because it reads every track file end to end, which
a package being opened for playback has no reason to do.

**SHA-1 is implemented by hand** (`src/imf/imf-sha1.ts`), not taken from Web Crypto.
`crypto.subtle.digest` accepts one buffer and has no incremental form, and an IMF track file is
routinely tens of gigabytes. This keeps a 64-octet block and five words, and the test checks it against
node's own `crypto` at every length across two block boundaries, plus the three published vectors —
including the 56-octet one, which is the case that needs a second padding block and the one an
implementation gets wrong.

SHA-1 is broken for signatures and perfectly adequate here: a packing list answers "did these octets
arrive intact", not "did an adversary substitute them". The format names the algorithm.

**The algorithm is matched on the URI fragment, not the whole URI.** `<HashAlgorithm>` carries an
XML-DSig identifier, and the reference implementation — Netflix's photon — ships
`http://www.w3.org/2000/09/xmldig#sha1` as its default. That is a typo for `xmldsig`, and it is in the
wild, so comparing whole URIs would reject packages that are fine. An algorithm that is *not* SHA-1 is
reported as a problem rather than compared, because checking a SHA-1 digest against a SHA-256 claim
would read as corruption.

Size and hash are reported **together**: stopping at the first disagreement leaves a report that cannot
tell a truncated file from a substituted one.

## A marker is placed in the composition's units, not its resource's

`imfMarkersOnTimeline` resolves a marker sequence onto the timeline, and three things make that more
than adding an offset to a start.

ST 2067-3 §6.13 bounds a marker's `Offset` by **`IntrinsicDuration`**, which is how we know it shares
its datum with `EntryPoint` rather than with the start of the cut. That is not a reading of the prose —
it is what photon's CPL validator checks, and it settles the question the prose leaves open. So a
resource that enters late subtracts its entry point, a marker outside the span the resource uses is
**trimmed away** and placed nowhere, and `RepeatCount` makes one marker occur once per repetition.

A marker sequence is **not** a media track and does not become one: it carries no essence, so an
`Input` must not offer it as something to decode.

## Every duration in a CPL is in its own resource's edit units

ST 2067-3 lets each `<Resource>` state an `<EditRate>`, defaulting to the composition's, and
`IntrinsicDuration`, `EntryPoint` and `SourceDuration` are **in that rate**. An audio resource counts
in samples, so a 48 kHz sound track in a 25 fps composition states `48000 1` — and reading its figures
as composition edit units makes the sound 1920 times too long. We shipped that bug; the consumer found
it.

`ImfResource` carries its own `editRate`, its three durations stay in those units, and only
`timelineStart` and `timelineDuration` are in composition units. The conversion happens once, at parse
time. The demuxer's `fileStart` and `fileDuration` are derived with the **resource's** rate and its
`start`/`duration` with the composition's; using one rate for all four is exactly the shipped bug.

**And an audio cut does not land on a packet boundary.** A video entry point falls on a frame, so a
cut's first packet begins where the cut does. Sound has no such alignment: a cut at 1 s of 48 kHz audio
falls inside whatever packet was being written then, and that packet carries the first samples the
composition needs. Asking whether a packet *begins* inside the cut discards them, and since `getPacket`
is at-or-before, the fallback then had nothing left to find and the track read as **empty** — zero
packets, while the duration and the sample rate both answered correctly. The straddling packet is kept
and yielded at a negative timestamp, the same convention as audio priming. A packet that merely *ends*
where the cut starts carries none of it and is not kept.

## An IMF track backing has to be a video and audio backing too

`ImfTrackBacking` implemented only `InputTrackBacking`, so an `InputVideoTrack` built on a composition
threw on the first thing anyone asked it: `getDisplayWidth` reaches `getRotation`, which reaches
`getTransformationMatrix`, which did not exist. A composition could not be measured at all. The video
and audio members delegate to the first resource's track, since they describe the *essence* rather than
the composition.

It cannot `implements` both interfaces: `getType` must return `'video'` for one and `'audio'` for the
other. Which set is live is decided by the composition's sequence kind.

## The RTP timestamp is a clock reading, not a counter

ST 2110's timestamps are samples of **one reference clock shared by every sender on the network**.
That is what lets a receiver line up video, audio and ancillary that arrived from three different
machines. Our senders counted from zero instead, and `ptpGrandmaster` only ever wrote a `ts-refclk`
line into a standalone SDP — the senders never even passed it — so a stream declared a lock it did not
have and produced timestamps that combined with nothing. Nothing about such a stream looks wrong in
isolation: it is internally consistent, paced correctly, and plays.

**Stating `ptpGrandmaster` now means the host's clock is disciplined to it**: the RTP timestamps are
read from the system clock against the PTP epoch. That is how a software sender gets PTP time —
`ptp4l` and `phc2sys` discipline the system clock, and nothing in Node can talk to a PTP daemon or read
a hardware clock directly. Leaving it out declares `ts-refclk:localmac=` and times the stream from its
own start, which is the honest statement for a sender with no shared clock.

**The origin is the shared clock's; the spacing is the media clock's.** The clock is read once, at the
first frame, and later frames advance by exact media-clock units. Reading it per frame would put the
pacer's wakeup jitter into the timestamps themselves, which is the one thing a receiver cannot correct
for.

**TAI, not UTC.** The media clock counts from 1970-01-01 **TAI**, so the UTC seconds are shifted by
TAI − UTC — 37 seconds since 2017-01-01 — and `taiOffsetSeconds` states it because nothing in Node
exposes it. A wrong offset shifts every timestamp by the difference and lines the stream up with
nothing, while still looking perfect from the inside.

**Ancillary deliberately gets none of this.** ST 2110-40 data must carry the timestamp of the video
frame it belongs to, so `St2110AncSender` takes the timestamp per packet and must not read a clock of
its own; one it sampled independently would be close to the video's and never equal to it.

## ST 2110-30 and -40

**-30, uncompressed PCM.** The payload is interleaved big-endian samples with no header at all, so
everything a receiver needs is in the SDP. The packet time — not the MTU — fixes the payload size, and
the RTP timestamp advances by **frames**, because §6.1 runs the media clock at the audio sampling rate
rather than at video's 90 kHz. Audio that does not fill a packet is held back rather than sent short,
since a short packet misstates the `ptime` a receiver sized its buffer from. A sample rate that does
not divide into whole frames is refused: 44.1 kHz at 125 µs is 5.5125 frames.

**The conformance levels of Table 2 describe what a RECEIVER accepts.** Secondary summaries invite
reading them as a sender's claim, which would put a parameter in the SDP the standard does not define —
and those summaries also disagree about Level B. The standard's own text settles it: B is 1 to 8
channels at *both* 1 ms and 125 µs, and only C raises 125 µs to 64. So `receiverLevelsFor` answers in
the direction that is useful: a sender choosing a packet time and a channel count learns how widely the
result will be accepted. Sixteen channels at 1 ms is in no level at all — valid AES67 that no conforming
receiver must take, and §7's own note says to send several eight-channel streams instead.

`channel-order` follows §6.2.2's RFC 3190 syntax with Table 1's grouping symbols. An order that does
not account for every channel is refused rather than written: §6.2.2 makes the undeclared channels
Undefined, so a short order silently discards the mix of everything past it.

**-40, ancillary data** (RFC 8331), for captions, SCTE-104, AFD and timecode. The thing to get right is
that the ANC data words are **10 bits and not byte aligned**: after a 32-bit header word come DID, SDID,
Data_Count, the user data words and the checksum, ten bits each, and then `word_align` zeroes up to the
next 32-bit boundary — required even on the last ANC packet in a datagram. A packet carrying one user
data word has its checksum straddling three octets. `Length` counts octets from the **C bit of the
first ANC packet**, not from the start of the payload, and includes every `word_align`.

Each word carries its own parity per ST 291-1 — b8 is even parity over b0..b7, b9 its inverse — so the
caller hands over 8-bit values and this fills the parity in. The checksum is not one of them: its b8 is
the ninth bit of a nine-bit sum, and only b9 is derived. The test asserts the **exact octets** of a
one-word packet worked out from the RFC by hand, because an unpacker written against the same
misreading as the packer would agree with it happily.

Two details that are easy to conflate. The `S` bit states whether `StreamNum` carries information, so
`streamNumber: 0` and omitting it are different claims and are written differently. And a frame with no
ancillary data still sends a packet, with `ANC_Count` and `Length` both zero and the marker bit set —
the RFC provides for it so a receiver rebuilding a raster learns the frame carried nothing instead of
waiting.

**Receiving.** `St2110Depacketizer` is the inverse, and `St2110Source` drives it from a datagram stream
plus the sender's SDP. `parseSt2110Sdp` is what makes that possible at all: the payload states nothing
about size, sampling or depth, so a parameter the SDP omits is refused rather than defaulted — a default
there is a silently wrong picture, which is worse than no picture.

Two decisions in the reassembly. A frame ends when a packet arrives bearing a **different timestamp**,
not when the marker bit is seen: a marker rides on exactly the packet whose loss a receiver most needs
to survive, and a timestamp change still works when that packet never came. And `complete` is
**counted**, not inferred from the marker — a frame can carry its marker and still be missing a band
from the middle. Incomplete frames are yielded with the count rather than dropped, because a receiver
that discards anything short shows nothing on a network that loses one packet.

`packPgroups` and `unpackPgroups` convert between packed pgroups and samples. A pgroup is the smallest
run of pixels landing on an octet boundary, so at every depth but 8 and 16 the samples inside it
straddle octets: 4:2:2 at ten bits puts four samples into five, the second starting at bit 10 and the
third at bit 20. Reading those at byte offsets gives a picture that looks almost right.

Two of eleven mutations survived the first round, both the same shape — a property the fixtures could
not vary. Every test was progressive, so the field bit was never set; and every complete frame carried
its marker, so reading completeness off the marker agreed with counting. An interlaced round trip and a
frame missing a *middle* packet are what separate them.

Still absent: -31 AES3, and locking to PTP rather than merely declaring it in `ts-refclk`.

## A quiet CBR stream is where the clock goes missing

13818-1 puts 0.1 s between PCRs as a maximum. The muxer honoured `pcrInterval` only where the PCR track
had gone quiet *and* some other track was being written: `writePcrIfDue` returned early whenever the
packet about to be written was itself on the PCR PID, on the reasoning that it would carry a PCR
anyway. It does — but only at its own timestamp, so the PCR spacing silently became the PCR track's
packet spacing.

A single video track is its own PCR PID, which is the commonest broadcast case, so for it there was no
filling at all: on a still picture at 3 Mb/s, **0.15 s between PCRs at 6.67 fps and a full second at
1 fps**, whatever `pcrInterval` asked for. Under a constant rate the space between media packets is
wall-to-wall null packets, and a null carries no clock.

Three things had to change together, and the second two only showed up once the first was fixed.

**Order.** The fill runs *before* `repeatTablesIfDue`, not after. Repeating the tables pads the byte
clock all the way to the current packet's time, and a PCR that then wants to sit earlier can no longer
be placed — `padTo` only moves forward.

**An epsilon, in one direction.** A PCR track whose packets are spaced exactly `pcrInterval` apart —
25 fps against the 0.04 s default — compares two values equal in decimal and differing in the last bit
of a double. Without slack every frame got a redundant PCR a hair before it, which looked harmless and
was not: a PAT inherits whichever PCR came last, so the extra PCRs moved the clock the tables are dated
by, and the damage surfaced as an unrelated table-spacing test failing at 0.16 s. Measured against the
byte clock the tables were still 0.1203 s apart — the test was reading an aliasing artifact, and that
diagnosis is the only reason the real bound was not loosened to accommodate it.

**And no epsilon, in the other.** The first PCR on a PID carrying no essence used to be written only
because `until - interval + interval < until` is false in decimal and true in binary. Adding slack
removed the rounding error and with it the entire mechanism — the PID went silent. That first PCR is
written explicitly now, and a test pins it structurally: the PCR-only packet must *precede* the first
media packet, since a stream that opens with an interval of untimeable packets is no better than one
with no clock at all.

The tail is padding too, so `finalize` fills to the last packet's end rather than leaving a final
stretch carrying no clock.

## A DVB extension that names nothing

`SupplementalProperty` and `EssentialProperty` below the Period were written through a helper that
keeps only `schemeIdUri` and `value`, while the Period's own went through one that keeps `id` and the
foreign attributes too. DVB font download states the whole thing in foreign attributes — ETSI TS
103 285 7.2.1 puts `dvb:url`, `dvb:fontFamily` and `dvb:mimeType` on a `<SupplementalProperty>` of a
text AdaptationSet — so what came out signalled a font and named none. Both use the plural helper now.

**The DVB namespace URI was wrong as well**, which the round-trip test found: `DASH_NS.dvb` read
`urn:dvb:dash:dash-extensions:2014`, with a `dash:` segment that does not belong and without the part
number. Every real manifest declaring these extensions writes `urn:dvb:dash-extensions:2014-1`.
Attributes in the wrong namespace are attributes a DVB receiver cannot resolve, so the first half of
the fix would have been worth little without the second.

## A second view is only as good as the boxes beside it

`hvcC` describes the **base layer alone**. Everything saying a track has another view sits next to it:
`lhvC` carries the parameter sets of the layers above the base, and `vexu` says what the two views
*are* — which eyes, which leads, how far apart the cameras were, what projection. A writer that drops
them produces a file that plays perfectly with one eye, which is the worst way for this to fail.

Both survive a read and a write, carried on the decoder config as the **raw box payloads** rather than
as a parsed model, because the only thing a packager must get right is that they come back unchanged.
`stbl` is shared by the plain and fragmented writers, so the segmented and CMAF paths get this without
a second implementation.

For reading, `parseVexuBox` gives the parsed view a packager needs to state `REQ-VIDEO-LAYOUT`:

```
must         full box + 4CC[] : peers a reader MUST understand, zero entries are padding
eyes -> stri full box + 1 byte: reserved(4) reversed additional has-right HAS-LEFT
     -> hero full box + 1 byte: 0 none, 1 left, 2 right
     -> cams -> blin  full box + u32 : camera baseline in MICROmetres
     -> cmfy -> dadj  full box + i32 : disparity, -10000..10000 over a view's width
pack -> pkin full box + 4CC : side, over
proj -> prji full box + 4CC : rect, equi, hequ, fish, prim
```

That layout comes from Apple's *Stereo Video ISOBMFF Extensions*, and the values are checked against
`multiview.mov`: both eyes, no hero, 19240 µm between the cameras, disparity 200, rectilinear, 63.400°
of horizontal field of view. A `vexu` carrying boxes this does not know still reads, with every field
at its default: Apple keeps adding to it, and a reader that refused the unknown would start rejecting
spatial video on the next release.

**`stri` has four flags, not two.** The spec's order is reserved(4), `eye_views_reversed`,
`has_additional_views`, `has_right_eye_view`, `has_left_eye_view` — so the left eye is the **low** bit,
which a file with both eyes set cannot tell you. `eye_views_reversed` is the one that matters: a reader
that ignores it hands each eye the other's picture, and a parse-then-build round trip silently cleared
it. Each is tested on its own, because set together they could be swapped unnoticed.

**`hfov` is not inside `vexu`.** It is a sibling in the visual sample entry, a plain box of one `u32`
in thousandths of a degree, and Apple's note is explicit that a file is not *spatial media* on
visionOS 2 without it — alongside `blin` and `dadj`. Nothing here read it, so a remux produced a file
that was still stereo and no longer spatial. It is read, carried on `MultiviewConfiguration`, and
written back beside `vexu`.

**`pack` and `must` were the other two gaps.** `pkin` says two views share one frame, side by side or
over and under; without it a frame-packed track and an MV-HEVC track parse to exactly the same thing.
`must` names the peers a reader has to understand, and the spec says a track whose required box type is
unrecognised is to be ignored rather than presented — so it is surfaced as `requiredBoxTypes` instead
of being skipped silently.

**The oracle is FFmpeg, on the same file.** The round-trip test does not state what the numbers should
be: it reads `multiview.mov`, writes the configuration back out through this library, and asserts that
`ffprobe`'s `Stereo 3D` side data — baseline, disparity, field of view, primary eye, view, inverted —
is **identical** between the two files. A plain HEVC track written the same way has no such side data
at all, which is what makes that an assertion about what we wrote. Dropping just the `hfov` turns
`horizontal_field_of_view` from `63400/1000` into `0/1` and leaves the baseline intact.

Of nine mutations, eight turn at least one test red. The ninth — skipping the four version-and-flags
octets of a `must` — cannot be caught, because those octets are zero in every conformant box and a zero
entry is defined as padding, so the box header skips itself.

## Trick play is a rendition, not a playlist

`HlsImageStreamSource` writes an HLS trick-play rendition: sheets of thumbnails a player scrubs through
instead of seeking the video. The caller captures the sheets and pushes each one; the stream writes the
file, keeps a media playlist with `#EXT-X-TILES` and `#EXT-X-IMAGES-ONLY`, and the output announces it
with `#EXT-X-IMAGE-STREAM-INF` beside the variants.

**It is deliberately not a `Playlist`.** A Playlist in the segment pipeline carries tracks, a segment
format, an init segment, a muxer and a bitrate model. An image stream has none of them: its segments
are whole files the caller already holds, there is nothing to mux, no init, and no codec beyond `jpeg`.
Routing it through that machinery would mean a degenerate playlist with a guard at every step for the
case with no tracks — special cases layered on shared infrastructure. What it genuinely shares is
small: the live window, the media sequence, the eviction.

Two details worth stating because they are easy to get backwards. A sheet's `#EXTINF` is
`columns * rows * tileDuration` — every tile in the grid, not one — which is what lets a player map a
scrub position onto a tile without decoding the image. And a declared image stream that never received
a sheet writes **no** tag and no playlist, rather than a tag pointing at a file that does not exist.

The window comes from the output's own `maxLiveSegmentCount * targetDuration`, so sheets roll off with
the segments instead of growing without bound. The name is `HlsImageStreamSource` because
`HlsImageStream` was already taken by the parser's AST node for the tag.

## A floor the content cannot spend

`StatMux` reads a program under its `minBitrate` as "needs a finer quantizer". For a programme whose
content has little in it — a slate, a black channel, a caption card — that is never satisfied: it makes
a few kilobits per second **at any quality**, so the loop refines it every interval until the quantizer
reaches the codec's minimum. For x264 that is lossless, several times slower than real time, and still
nowhere near the floor.

`minQuantizer` is the bound that makes the documented behaviour true — the finest quantizer a program
may be held at, defaulting to the codec's minimum so nothing changes for anyone who does not state one.
And `minBitrate` may be **zero**, which is how a filler channel says it claims nothing; it used to be
refused outright.

**A detour worth recording, because the method matters more than the result.** Testing this, a program
that had sat on a slate for two minutes appeared to stay pinned at maximum quality for the rest of the
run — fifteen quantizer steps from a reference that had never seen the slate. That reads exactly like
integrator windup, and three mechanisms went in to fix it. Then the mutation run came back **1 of 5
caught**, which meant none of it was load-bearing.

The cause was the test harness: each run started its timestamps at zero, so the second call made time
appear to go backwards and the loop never reached another interval boundary. **A loop that never
reallocates looks identical to one pinned by windup.** With the timeline continued across calls the
real residual is **three steps** — the offset is an integrator with no restoring term, so a correction
earned under the slate does persist until the ceiling pushes back, by an amount not worth changing the
loop's dynamics for. All three mechanisms were reverted and the test states the three steps.

Two things to take from it: a measurement that makes the code look broken is a claim about the
measurement first, and a fix that no mutation can kill is not a fix.

## `ContentProtection` above the AdaptationSet

The 5th edition allows `<ContentProtection>` on the MPD and on a Period as well as on the sets below
them, and the fork only had the lower two. That is what makes `@refId` useful: state the protection
data once high up and have every AdaptationSet point at it with `@ref`, instead of repeating a PSSH per
set per period. The fork already parsed `@ref` and `@refId`; there was nowhere for the thing being
referenced to live.

Both levels parse and serialize **in schema order**, which is not decoration — a descriptor in the
wrong position is a document that does not validate. `MPDtype` puts it after
`InitializationPresentation` and before the first `Period`; `PeriodType` puts it after
`ServiceDescription` and before `AdaptationSet`. Those positions were read off `DASH5th.xsd` from the
DASH-IF conformance repository rather than inferred, and the tests assert the ordering as well as the
round trip.

## Five small ones, and one that was already right

**`REQ-` attributes require version 12** (draft-pantos-hls-rfc8216bis section 7), because an older
client must not be allowed to ignore a requirement it does not understand and play the stream anyway.
`hlsVersionOf` documented that rule as unreachable — "an attribute this library does not model is
dropped from the tag it sat on" — and that had stopped being true: `REQ-VIDEO-LAYOUT` is modelled, so
it can be seen and is counted. The note stays for the ones that still are not modelled.

**`parseHvccConfigRecord`** exposes the base layer's parameter sets. The arrays were reachable only
through an internal function, so a consumer wanting them was reduced to calling `parseLhvcConfigRecord`
at a hand-computed offset into the `hvcC`. That works by coincidence and only by coincidence: the two
records carry their arrays in the same format behind headers of twenty-two and six octets, so reading
one at the other's offset lands inside a parameter set and produces arrays that parse without
complaint. The fixture is Apple's real `hvcC`, because a hand-made one that got the header length wrong
would make the parser look broken while it was right.

**`ts-refclk:localmac=`** for a sender whose clock is its own. ST 2110-10 section 8.2 requires a
reference clock either way, and a stream stating neither says nothing about what its timestamps are
against. PTP wins where both are given.

**Dolby Vision profile 20 needed no change at all.** Apple's stereo `dvh1.20` already produced `dvwC`,
`dvh1.20.09`, and a record that round-tripped — the box rule is "7 or below `dvcC`, 10 or below
`dvvC`, otherwise `dvwC`" and the profile field is seven bits wide, so 20 was never a special case.
Probing it before writing anything is the only reason a change was not made to code that was already
correct. It has a test now so it stays that way.

One mutation survived this batch and was *removed* rather than tested: a length guard in
`parseHvccConfigRecord` that the surrounding `try`/`catch` already covered. **A guard nothing can kill
is a claim nothing can check.**

## A leak warning about a leak the format allows

HLS and DASH deliberately hand out source refs the reader does not free — a segment source lives until
the cache evicts it — so the "SourceRef was garbage-collected without being freed" warning is
suppressed for sources flagged as theirs. Reading a live stream logged it anyway.

The flag was not reaching the sources that needed it. `slice()` returns a **new** `Source`, with the
flags clear, so a byte-range segment warned on every fetch; so did the `ReadableStreamSource` that
AES-128 decryption produces. Neither is a leak.

The fix is to propagate the flag, **not** to widen the suppression or move where it is emitted. Those
are load-bearing: a downstream consumer asserts on this warning, and changing the rule would quietly
gut their test while looking like a fix here. A slice of an HLS source simply *is* an HLS source.

## "No video" and "not yet" are different answers

A live playlist that has gone on air but not yet published a segment lists none. `getFirstSegment`
reloaded once and then answered null, which a consumer cannot tell apart from a playlist that has no
video at all — and the two call for opposite things: one is a reason to give up, the other to wait.

It waits the way reading past the live edge already waits, honouring `skipLiveWait` like every other
retrieval. The stopping condition is `#EXT-X-ENDLIST`: a finished playlist listing nothing really does
have nothing, and waiting for an edge that will never move again is a hang, which is a worse answer
than null. Both halves are tested, the second because the mutation that removed it survived the first
round — the suite had no finished-and-empty playlist in it.

## The PCR interval is a property of the byte clock, not of the video track

The first fix to PCR spacing was right about the cause and wrong about the mechanism, and only a
consumer's multi-track file showed it. Filling the gap with PCR-only packets **spaced by stream time**
works when the PCR track is the only thing advancing the clock. Add audio, tables and the null packets
a constant rate pads with, and by the time the next video frame is reached the byte clock is already
past every instant the fill wanted a PCR at — `padTo` has nothing left to pad, so the whole interval's
worth comes out in a burst at the frame, one packet apart, and the stretch between frames carries no
clock at all. On a 3 Mb/s multiplex of one video and two audio tracks: seven PCRs inside 1880 octets,
then nothing for 0.15 s, against a stated 0.03.

Under a constant rate the **byte clock is the time base**, so the check belongs after every packet
written — media, table or null — and not at the PCR track's own packets. That is one test in
`writeTsPacket`, guarded against re-entering while it writes its own packet. The timestamp-driven fill
stays for variable-rate output, where there is no byte clock to read, and for stating the first PCR on
a PID that carries no essence.

**Where the clock is noted matters as much as when it is checked.** A PCR rides the *first* packet of a
PES, so recording the byte clock after the PES is written places it however many packets that PES is
long past where the PCR actually sits — and a keyframe is hundreds of packets. That alone pushed the
worst gap from 0.030 to 0.041.

**A multiplex with one track in it is not a multiplex.** The regression test uses video, two audio
tracks and an SDT, and asserts both the interval and that the PCRs are *spread* — counting gaps of one
packet time, because a burst passes an interval check while carrying no clock between frames.

## Styled, placed cues — `SubtitleCue.runs` and `SubtitleCue.placement`

A cue was plain text with its source format's markup left inside it, so every TTML document this
library wrote escaped a WebVTT `<b>` into text a viewer reads, and put every paragraph into one bottom
region. A cue carries two more things, both optional:

- **`runs`** — the content as styled stretches: bold, italic, underline, colour, background colour.
- **`placement`** — `origin` and `extent` as percentages, `displayAlign`, `textAlign`, `writingMode`.

**`text` is unchanged and still the source format's own body.** A WebVTT cue keeps its markup there,
which is what every format that carries no styling writes and what makes a WebVTT round trip
byte-exact. TTML writes `runs` *instead* when they are present. A run that styles nothing is written as
the paragraph's own text rather than an empty `<span>`, so an unstyled cue's document is unchanged.

**WebVTT markup and cue settings are read into them.** `b`, `i`, `u` and `c` with one of WebVTT's eight
named colour classes (`bg_` for the background) open a run; `v`, `lang`, `ruby`, `rt` and the inline
karaoke timestamps are dropped and their text kept, merged into the run beside it so one sentence does
not become three spans that style nothing. A class the spec does not name is a stylesheet hook, not a
colour, and is ignored rather than written as one.

**WebVTT states an anchor, not a box.** `position` is where a given fraction of the line sits, and that
fraction follows `align` unless `position` names its own, so the box's left edge is
`position - fraction * size` — the arithmetic a receiver performs. The box runs from the stated line to
the bottom of the picture with `displayAlign="before"`, which is what lets a cue of any number of lines
begin where the line names. **A line stated as a line *number* places nothing**: how far down it falls
depends on the line height and the region, neither of which a cue states, so a guess would put the cue
where the author did not ask for it.

**One region per distinct box, not one per cue.** Cues placed alike share a region; `r0` stays the
document's default and an unplaced cue names no region at all. `tts:textAlign` goes on the `<p>`, since
two cues in the same box can align differently. What a placement does not state it takes from `r0`
rather than leaving out — a region with no `tts:extent` covers the whole frame, so a cue that asked
only for vertical text would also have moved and grown. `r0` is written from the same numbers, so the
two cannot drift apart.

**The reader reads all of it back**, so a remux through this library does not drop what the muxer
wrote: `<region>` elements resolve into placements, `<span>`s into runs, and a `<p>` naming no region
comes back unplaced rather than carrying the document's furniture.

**An IMSC1 document names its profile twice.** `ttp:contentProfiles` is IMSC 1.1's; a 1.0.1 processor
reads `ttp:profile` and finds nothing in a tag it does not know, so a document stating only the former
has no profile as far as it is concerned. IMSC 1.1 section 6.3 allows both, with the same designator.

**A third profile, `smpte-tt`**, states itself through `ttp:profile` with the full-profile designator
and declares the SMPTE extension namespace, which the `stpp` sample entry then lists beside the TTML
one; it is not branded `im1t`, since that says IMSC1 text profile. ST 2052-1 is not public, so both
URIs are quoted from W3C IMSC 1.1 Annex I.4.

## What a TTML init says about its own profile

`imsc1` and `ebu-tt-d` wrote byte-identical inits: `stppSampleEntryFields()` took no arguments, so
nothing in the sample entry said which profile the documents were. Three things distinguish them now.

The `stpp` namespace field is a **space-separated list of every namespace the documents use**
(14496-30 section 7.2), not just the document element's, so an EBU-TT-D track states the TTML,
`ebutts` and `ebuttm` namespaces together. That is what DASH-IF maps onto `stpp.ttml.etd1` against
`stpp.ttml.im1t`. An IMSC1 document names its profile in `ttp:contentProfiles`; an EBU-TT-D one already
said what it was through `ebuttm:conformsToStandard`. And a fragmented output holding an IMSC1 text
track brands `im1t` on both `ftyp` and `styp` — on the segments as well as the init, because a receiver
handed one segment has only that to read.

`ttmlDocumentOf` writes the same document as a string, for the common case where captions are a sidecar
file rather than a muxed track.

## Smaller things in the same batch

`UrlSource` takes `quietRetries`, off by default: a read quietly retrying for a minute is usually worth
telling the developer about, but against an origin expected to flap it is a minute of noise per outage.

`VexuProjection` gained `prim`, parametric immersive, which HLS states as `PROJ-PRIM`. Without it a
packager cannot tell one from an ordinary rectilinear stereo pair and writes plain `CH-STEREO` for
content that is not.

The image stream states `#EXT-X-MEDIA-SEQUENCE` from its first write, through a narrow
`alwaysStateMediaSequence` on the media-playlist AST. Zero is what an absent tag already **means**
(RFC 8216bis 4.4.3.2), so nothing here was reading the wrong number and shaka-packager is not wrong to
omit it. What the explicit tag buys is that a playlist which exists in order to evict never appears to
grow a sequence number from nowhere when its first entry rolls off. Media playlists still omit it.

That is also the general rule for this fork's parity with shaka-packager: **it decides ties, not
correctness.** Where shaka is wrong or incomplete against a spec, the fork diverges and says so — the
DVB extensions namespace a few sections up is exactly that case, changed on the evidence of real
manifests rather than kept for parity.

## A splice is an event, not a track

A channel reading a transport stream has to carry the source's splices, and the demuxer recognised a
cue stream only well enough to stop warning about it — the sections reached nobody.

They are surfaced as an `inbandEvent` on the `Input` rather than as a track, because they are not
media: no samples, no codec, no duration, and a reader that had to pull a track to see a splice would
have to keep pulling it in step with the media to see one in time. **Listen before reading** — they are
emitted as the bytes carrying them are parsed.

The payload goes out **unparsed**, under `urn:scte:scte35:2013:bin`, which is the identifier the same
bytes carry in DASH and HLS. The timestamp is null on purpose: a section states its own splice time
*inside* itself, on the program's 90 kHz clock rather than the input's, so a time invented outside it
would be a different number from the one the consumer needs — and the consumer has to read the section
anyway to learn what kind of splice it is.

Three things had to be right, and each is its own mutation because each was wrong first:

- **The pointer field.** `readSection` leaves the PSI `pointer_field` in the payload — every other
  caller reads it off itself — so taking `payload[0]` as the `table_id` finds the pointer, which is
  almost always zero and so looks like a table to ignore. Nothing was ever announced.
- **Two places walk the packets.** Metadata discovery walks from the start and stops once every
  elementary stream is initialised; the per-track reader walks the rest. A cue PID is neither a track
  nor PSI, so it was dropped by both. A splice near the head sits before any track's first packet; one
  past metadata's reach is only ever seen by the reader. Both hooks are needed.
- **The same splice must not be announced twice.** Sections repeat and a seek re-reads.

Getting the test to *prove* those took three attempts. A mid-stream copy of the head section proved
nothing, because the two are identical bytes and the dedupe collapses them — the test passed whether
the reader hook ran or not. It only became a real test once the second splice was **distinct** and
placed past where metadata stops.

## MPEG-TS carries the second view's parameter sets

`hvcC` describes the base layer, so a layered track's second view has its parameter sets in `lhvC` and
nowhere else. The TS muxer prepended only the base layer's at each key frame, so a decoder saw layer
1's slices with no SPS to read them against and dropped them: the stream plays, with one eye, and
nothing fails loudly. Layer 1's sets ride the same elementary stream now, **after** the base layer's
they depend on — which means unshifting them first, since that is the order `unshift` reverses.

## An index entry locates the package, not the element

Reading an interleaved MXF — one with picture and sound in the same file — failed outright:
`An MXF index points at offset 7168 for track 369165056, but the element there is 060e2b34…15010500`.
That is a sound track's index entry landing on a **picture** element key, and it is not a broken file.

An index entry locates the **content package**: the edit unit holding every track's element for that
instant. In a single-essence file the package and the element are the same offset, which is why reading
the entry directly worked for as long as there was only ever one track. In an interleaved file the
picture comes first and the sound follows it, so a sound entry has to be walked forward from.

Two things the walk has to know. **Filler is inside a package, not after it** — the KLV Fill item is
alignment padding between elements, so stopping at it ends the search one element early and reports a
package that holds no sound. And the walk advances by the **whole triplet**, key plus length plus
value, because stepping to the value start reads the essence as if it were a key.

The test could not tell the difference at first. Asserting that the sound track produced packets, and
that its sample rate was right, passes just as well when the *picture* element is returned for it — the
rate comes from the metadata, and picture bytes are still bytes. What settles it is the size: 24-bit
mono PCM over a 1/25 s edit unit is 1920 samples of three octets, the same 5760 every time, while coded
picture varies frame to frame.

## Padding the tail is a constant-rate idea

The first PCR fix filled to the end of the last packet's duration at `finalize`, reasoning that a
constant rate pads the tail with nulls and that stretch would otherwise carry no clock. That is true,
and it is only true under a constant rate. Under a variable rate nothing is written after the last PES
at all, so the fill put PCRs past the last frame with nothing to pace — and broke the one invariant a
segmented writer has: **the bytes for frames A must be a prefix of the bytes for A then B.** An LL-HLS
transport-stream segment is served as its parts joined, so a trailing fill per part makes a segment
fetched part by part differ from the same segment fetched whole. The invariant is a test now.

That test needed a `pcrInterval` smaller than a frame to mean anything. At 25 fps against the default
0.04 one frame is exactly one interval, the fill writes nothing either way, and the test agrees with a
muxer that still has the bug.

## License + attribution

The fork is MPL-2.0, matching upstream. The HLS and DASH output ports include `NOTICE` and
`LICENSE.shaka-packager` attributions covering the Apache-2.0 code lifted from
[shaka-project/shaka-packager](https://github.com/shaka-project/shaka-packager). All non-fork-specific
work is upstream-contributable; the fork exists to ship features ahead of upstream PR cycles, not to
diverge.

### Resampler back-pressure is asserted against the run, not a queue depth

`test/browser/media-sources.test.ts` does not bound what finalizing drains by a fixed number of
samples. How deep an encoder queues is not portable — it differs by codec and by machine — so the
contract it states instead is that finalizing drains something, and that the samples arriving once the
queue was full were dropped rather than delivered.

### A track's own container id

`InputTrack.getContainerId()` answers the identifier the file itself states for a track: the PID for
MPEG-TS, `tkhd`'s `track_ID` for ISO BMFF, `TrackNumber` for Matroska, the logical bitstream's serial
number for Ogg, and null for a container whose tracks carry none. A segmented input reports what its
underlying media states.

Neither `InputTrack.id` nor `InputTrack.number` can stand in for it: both are positions within
`Input.getTracks()` that Mediabunny assigns, and upstream 1.66 made `id` the 1-based index outright. An
MPEG-TS with PIDs 0x100/0x101/0x102 reads `id` 1, 2, 3 — which is what an external tool selecting an
audio track by PID has to address, and a position cannot serve, since a demuxer may hand tracks back in
an order the file does not state.

## Where this fork's behaviour differs from upstream

Everything else is additive. These are places upstream and the fork do the same job differently, each a
consequence of a feature stated above rather than a preference.

**Sample entry, `avcType` and `hevcType` follow the bitstream, not the codec string.** Upstream derives
`hvc1`/`hev1` and `avc1`/`avc3` by searching the encoder config's codec string, and always writes
`hvc1` because some Apple players refuse `hev1`. That string is frequently one the library invented —
`buildVideoCodecString` names a fixed fourcc whenever the caller stated none, which
`_codecStringIsDerived` marks — so the fork reads `avc.format`/`hevc.format` instead, which state where
the parameter sets actually went; the string is consulted only for a config the caller supplied whole.

**A stated parameter-set placement decides the AVC sample entry.** `avc3` in a codec string is the one
hint AVC gives about where its parameter sets are (HEVC generates `hev1.` unconditionally, so its
string says nothing), and the muxer used to take that hint even when the caller had stated a placement
outright — a track added as `parameterSets: 'outOfBand'` could get an `avc3` entry while HEVC in the
same position correctly got `hvc1`. The placement is carried as `'inBand'`, `'outOfBand'` or
`'unstated'`, and the string only decides in the `'unstated'` case. Annex B carriage settles it whatever
was stated, since the sets are then demonstrably in band.

**A fragment's reported start is on the timeline the file states.** `tfdt`'s `baseMediaDecodeTime` is
unsigned, so a fragmented track beginning before zero is shifted onto a timeline starting there, and
`onMoof` reports that shifted time rather than the one the caller handed in. A fragment stating no
`tfdt` continues from the preceding fragment's decode end, not its presentation end.

**MPEG-TS repeats its PAT and PMT.** Upstream writes them once at the head. The fork re-emits them on
`patInterval`/`pmtInterval`, which is what lets a receiver joining mid-stream acquire the programme.

**A frame shorter than its own header declares is not supplied.** `supplyPacket` takes the length the
frame header states, not the bytes that happen to be buffered, for AAC, MP3/MP2, AC-3, E-AC-3 and DTS
alike. A live feed that stops inside a frame has no later byte coming to complete it.

**A transformed sample keeps its colour unless it landed in RGB.** A transformer that filters the frame
and stays in YUV carries the source's colour through. Landing in RGB means the colour describes whatever
conversion the rasteriser chose, and half a colour space — a filter graph keeps transfer and matrix
while losing primaries — mislabels an encode as PQ. Both the transformer and canvas paths apply that one
rule through a single `isRgbFormat` predicate.

**The server bundle inlines `@mediabunny/prores`.** It ships no CommonJS build and its `require`
condition names the `.mjs`, so requiring it from the CJS bundle loads a second copy of Mediabunny.
`turbores` is inlined with it, being ESM-only.

**A custom encoder's `flush()` is awaited.** Upstream calls it with `void`. A buffering encoder emits
every remaining packet from `flush`, so a throw out of it is the only report the caller would get.

**`readFragment` takes the fragment the walker just read**, where upstream's takes only a position. The
extra argument lets a measured neighbour's end timestamp win over a lookup table's claim, which is what
makes a file with a wrong index still read correctly.

**A quiet track does not hold a fragment or cluster open**: `closedTracks.has(track)` is one side of
`|| quietTrackMayBeSkipped(...)`.

**Subtitle flushing dispatches on the codec**, through `flushSubtitleCues`, which also covers TTML.

**`packages/server` pixel formats go through `choosePixelFormat`**, which takes bit depth, alpha and
chroma format together, because the encoders the fork adds (ProRes, MPEG-2) constrain all three.
Upstream's ProRes 4444 case is `requestedBitDepth: 10` with `chromaFormat: '444'`, since a ProRes fourcc
carries no depth for `extractVideoBitDepth` to read.

**A transform copies its frame when it allocates it.** Upstream defers the copy into the filter-graph
`try`; the fork's graph comes from a cache, so the copy happens before the lookup.

**ProRes tests fetch their sample once**, as a `BufferSource` shared by every test, so a parallel run
makes one request rather than five.

**`MPEG_TS_TIMESCALE` is unused in the MPEG-TS muxer**: upstream uses it for the monotonic clamp in its
reconstructed decode timeline, and the fork carries the stated decode times instead.

**A variant's `CODECS` may list several strings of one kind.** Where they all infer to one codec the
strings differ only in profile or level, so the track reports the codec and no full string; where they
infer to different codecs, the segment is read to settle it.

**Upstream's HLS tests are not carried.** `src/hls/hls-muxer.ts` (rewritten here as
`src/segment-pipeline-muxer.ts`) and `src/hls/hls-demuxer.ts` are rewritten outright, so upstream's
tests for them encode decisions this fork made differently — its target duration rounds to the nearest
integer where upstream's expects a ceiling. The fork's own `hls-output.test.ts` and `hls-input.test.ts`
cover this surface. What upstream's newer ones cover and the fork's do not: undefined media groups, live
playlist reloads, and object-based audio channel counts.

## Packing pgroups a bit at a time cost twelve times what it needed to

`packPgroups` and `unpackPgroups` walked one **bit** per iteration: `depth` iterations per sample, and
for a single 1080p 4:2:2 10-bit frame that is 41 million of them — 66.5 ms per frame against a 40 ms
frame interval at 25 fps, so a 1080p ST 2110 sender fell behind before packetizing or pacing had done
anything.

**One group size per depth covers the whole table.** The bit layout is a single contiguous stream of
`depth`-bit samples; the sampling decides how many samples a pgroup holds, not how they are laid out.
So four samples into five octets handles 10-bit for 4:2:2, 4:4:4, 4:2:0 and RGB alike. 66.5 ms →
**5.5 ms** packing, 5.0 ms unpacking.

**More than half of what was left was the loop condition.** Writing `index + 4 <= out.length` in the
`for` cost more than the entire loop body: hoisting it to a bound computed once took unpacking from
9.7 ms to 4.3 ms. Worth knowing before reaching for anything cleverer.

**Validation moved out of the inner loop.** A `Number.isInteger` and two comparisons per sample is four
million branches a frame. A typed array has already made every value an integer in range for its own
width, so the values are OR-ed together and tested once; the walk that names the offending sample runs
only when that fails.

**The oracle is the old implementation, not the round trip.** A round trip passes just as happily if
both directions are wrong in the same way, so the test keeps a bit-at-a-time packer and compares byte
for byte against it, for **every** entry of the table. The timing assertion is a **ratio** against that
same reference measured in the same process, since an absolute millisecond figure that holds on a quiet
machine fails on a loaded one.

**The tail is unreachable and says so.** A pgroup is by definition the smallest run of samples ending on
an octet boundary, so a 10-bit pgroup holds a multiple of four samples and the callers reject a partial
pgroup. Shortening the group bounds therefore passes every test; the comment says that, so the next
reader does not take the silence for coverage.

## `bitexact` is not reproducibility, and the encoder is the reason

`MxfTarget`'s `bitexact` promised "the same bytes on every run". It does not deliver that, and the gap
is not in the muxer.

On a job written twice in one process — one AVC track and four mono `pcm-s24` tracks, fed concurrently
so they finish at different times, `bitexact: true` on the target — the two files differ by **exactly
one octet** in 140,857, at the same offset every attempt. Mapping it with the KLV walker from the
vendor-MXF work puts it inside a Generic Container **picture element**, in a `user_data_unregistered`
SEI whose payload carries `0x05f5e100` — the 100 Mbit/s rate. Not header metadata, not an index
segment: the essence.

**The cause is the encoder, and it is a hardware one.** This machine picks `h264_videotoolbox` for AVC
by default, and its SEI contents vary between runs. The obvious fix is wrong: FFmpeg's codec-level
`AV_CODEC_FLAG_BITEXACT`, set on the codec context before it opens — verified applied, with the control
reaching `applyEncoderControls` — leaves the SEI in place and the octet still varying. A hardware
encoder's bitstream is not FFmpeg's to normalise.

The same job through `libx264` (`hardwareAcceleration: 'prefer-software'`) is **byte-identical across
runs, with or without any bitexact flag on the codec**. So reproducible output is the muxer flag plus a
deterministic encoder, and the codec flag is not part of it at all.

**There is no `encoderControls.bitexact`, deliberately.** It was asked for and built, and the
acceptance test showed it changes nothing: on a hardware encoder the codec flag cannot help, and on a
software one there is nothing left to fix. It is reverted and no public surface was added.
`test/node/mxf-target.test.ts` pins both halves of what is true instead, and two mutations fail it.

### Software is not deterministic either, at 10 bits on arm64

That holds for 8-bit, and **not for 10 bits on arm64**, for a reason outside this library: x264's
10-bit assembly reads memory the process has already freed, so its output depends on what that process
happened to free earlier.

Against `x264 0.165.3222` directly, `--threads 1`, one frozen `testsrc2` raw input, using macOS's
`MallocScribble=1` to fill freed blocks with `0x55`:

| | plain, run to run | scribbled vs plain |
| --- | --- | --- |
| 10-bit 4:2:2, CRF, all-intra | repeats | **differs** |
| 10-bit 4:2:2, AVC-Intra 100 | repeats | **differs** |
| 10-bit 4:2:2, `--no-asm` | repeats | same |
| 8-bit 4:2:2, CRF, all-intra | repeats | same |

`--no-asm` removing it names the assembly; 8-bit being clean names the bit depth. A consumer reached
the same place from the other end, bisecting a repeat failure down to a `slice_qp_delta` jump on slice
0 inside x264 after proving the pixels handed to the encoder were identical at four stages.

**Nothing changes here, deliberately.** This fork builds nothing native — x264 arrives inside node-av's
FFmpeg prebuild — so patching or pinning it would mean owning a build this fork does not own, and the
defect is x264's rather than any version's. Forcing `asm=0` would silently change every user's output
and encode speed to route around someone else's bug. So the statement is the deliverable: **10-bit AVC
output is not byte-reproducible on arm64**, whatever this library does, and a job that needs
reproducible bytes should encode 8-bit, or use a different codec, and verify it rather than assume it.

One trap, because it makes the test look like a pass: `MallocScribble` fills with a *constant*, so two
scribbled runs see identical freed memory and agree — the comparison has to be scribbled against plain.
Setting `--input-depth` without `--output-depth` and `--output-csp` is the other: x264 then converts
down and the 10-bit case silently becomes the 8-bit case that repeats.

## MXF files other vendors wrote

Every MXF this suite read was one ffmpeg had written — one writer's shape of a format whose whole
difficulty is that writers disagree. Of ten vendor files from FFmpeg's FATE corpus (Avid, Sony,
Omneon, Apple, Quantel) **seven threw and two read as files with no tracks**. `npm run
capture-mxf-fixtures` fetches them; `test/node/mxf-vendor.test.ts` takes its expectations from ffprobe
on the same file rather than stating them.

**Avid's private metadata sets.** Avid writes sets under keys of its own, beginning `0x80` rather than
`060e2b34`, and the KLV reader refused any key that was not a universal label. A KLV triplet is
skippable whatever its key, so `readKlvHeader` takes a flag for callers walking a region where
anything may appear, and the metadata loop steps over a set it has no name for instead of treating it
as the end of the metadata. Three files turned on this alone.

**Avid's data definitions are not universal labels either.** `807D0060 08143E6F 6F3C8CE1 6CEF11D2` is
LegacyPicture and `…78E1EBE1…` is LegacySound; byte 12, which says picture or sound in a SMPTE label,
says nothing about these, so every track in an Avid file read as kind `unknown` and was dropped. Both
come from FFmpeg's `ff_mxf_data_definition_uls`.

**Three rates meet when a track's samples are built, and only one addresses the essence:**

- the **track's** edit rate, which its stated duration is counted in. `duration / rate` is the
  programme length in seconds, the only quantity the rates agree on.
- the **index's** edit rate, which its *positions* advance at. One position is one addressable unit of
  essence, so a sample's timestamp and duration come from this. It need not be the track's:
  `C0023S01.mxf` indexes at **1/2 Hz** — one entry per 524288-octet content package, about fifty
  frames — over a 25 fps track, and counting its positions in the track's units made the file read as
  **0.080 s** against a stated 3.8.
- the essence's own frame rate, which nothing in the index needs.

`buildSamples` counts positions in index units and keeps **everything else in seconds**. A
constant-bit-rate segment states no duration and answers for every position ever asked, so the walk is
bounded from outside it — by the programme's length in seconds, by the essence ending, or by the index
running out, each stated once.

**Clip wrapping reads from a different origin.** Frame wrapping makes an edit unit a whole KLV triplet,
so an index offset counts triplets from the container's start; clip wrapping puts every unit inside one
element's value, so it counts bytes from there. Reading the key for both was 25 octets off. The one
clip-wrapped file the suite had holds a single edit unit, where offset zero is the same place either
way, which is why nothing caught it.

**An index in the footer, and nothing pointing at it.** A file written without seeking back leaves
`FooterPartition` at zero in the header pack, and the footer lies past the window read at the front.
The Random Index Pack that closes such a file states every partition's offset and is found from the
last four octets, which state its own length. Without it
`omneon_8.3.0.0_xdcam_startc_footer.mxf` had no index, so no samples, so no tracks.

**An index entry array of no entries states no entry size**, which Avid writes and the reader refused
as malformed. FFmpeg checks the size only where there are entries to describe.

**Run-in.** SMPTE 377-1 allows up to 64 KB before the header partition pack, and every offset the file
states is measured from the pack. `C0023S01.mxf` has eight zero octets there and was not recognised as
MXF at all.

**A format probe runs on every input of every format**, so the first version of that fix turned a
sixteen-octet read into a sixty-four-kilobyte one for every file opened — and `Reader.requestSlice`
returns null early only when the size is **known**: on a source whose size is unknown it *waits*, and a
live stream may not deliver 64 KB for minutes or ever. CI hung for over an hour and the publish gate
timed out. The probe now checks offset zero in sixteen octets, and searches for a run-in only within
4 KB and only when the size is known; a longer run-in is not detected, which is stated rather than
hidden. `test/node/live-network-input.test.ts` pins it against a stream that delivers 2 KB and then
nothing. The general rule: **a probe may ask for what it needs to recognise its own magic and no
more.** The MXF reader's own `findRunIn` still searches the full 64 KB once the file is known to be
MXF.

**Two codec labels were wrong rather than missing.** VC-3's PictureEssenceCoding is `…04010202 71 ..`,
a family of its own; the reader looked for `03 02`, which no file carries, so both DNxHD files read as
codec-less and two tests here asserted that as correct. And a SoundEssenceCompression of
`…04020201 7F` states *uncompressed* explicitly — reading any non-zero label as compressed made Apple's
ProRes file's audio codec-less. `7E` is the same big-endian, and `…04020202 030101` is A-law, which
XDCAM proxy writes.

**D-10 audio is AES3, not the PCM its descriptor describes.** SMPTE 386M carries it as SMPTE 331M: four
octets of header, then a 32-octet group per audio sample holding eight little-endian 32-bit subframes,
each with its sample in the bits above the status ones. It is unwrapped keyed on the element key's
octets 12-14 (`06 01 10`), as FFmpeg keys on it.

The rule worth writing down is the **stride: the group is 32 octets whatever the channel count**, so a
four-channel element still steps 32 and skips four unused slots. Sony's file is 8-channel, where
`channels * 4` is accidentally the same 32, so a mutation changing the stride passes on the whole
corpus; the tests build a four-channel element for exactly that. Read raw as PCM the length is wrong by
`32 / (channels × octets per sample)` — a factor that depends on the channel count, not a constant: the
8-channel file reads 2x long, a 4-channel one 4x, which a consumer confirmed sample-exact against their
own source tone.

**All ten files now read** with the same track count, types and codecs as ffprobe, and for **all eleven**
essence streams across seven files **the same bytes**, against `ffmpeg -c copy -f data`. Packet
boundaries are deliberately not compared: a clip-wrapped PCM track's edit unit is one audio sample, so
this reader can hand back 22,022 three-byte packets where ffmpeg groups them into twelve.

**An essence element under a vendor's own registry is still an essence element.** Octet 8 of an element
key names the registry: `0d` is the Generic Container's, anything else is somebody's own. Avid writes
`0e 04 03 01` and Canopus `0e 0f 03 01`, and in both the last four octets are still the TrackNumber. A
reader that knows only the standard key finds **no essence at all** — which is why
`opatom_essencegroup_alpha_raw.mxf` reported no tracks even after its EssenceGroup was followed and its
package, descriptor and BodySID all resolved. (The `EssenceContainerData` is **not** the cause, though
it reads like one: that lookup succeeds and returns BodySID 1.)

**An EssenceGroup is a track pointing at several versions of itself.** A material track may hold one
where a SourceClip would be, each choice naming a different representation of the same essence. The
choice to take is not "the first": in an OP-Atom set most live in *sibling files*, so it is the first
whose package is actually present, which is what FFmpeg's `mxf_resolve_sourceclip` means by the first
with a valid descriptor.

**A clip-wrapped sound track's edit unit is one audio sample**, so `track_02_a01.mxf` indexes 22,022
units of three octets. The grouping is a **reader's choice**, not anything the file states — FFmpeg
makes the same one and says so ("arbitrarily default to 48 kHz PAL audio frame size") — so a sample
covers about a twenty-fifth of a second, or one index unit, whichever is larger. The test asserts
against ffmpeg's count rather than a number written here.

Two guards on that are deliberate and **unexercised**: clip wrapping and sound. The arithmetic alone
behaves correctly on every fixture, because a frame-wrapped video indexes at its frame rate and 25/25
is 1 — but a 50 fps video would index at 50 Hz and fold two frames into one sample. No fixture has that
shape, so mutating them away passes. Two other guards FFmpeg carries were written and removed: they
excluded nothing this condition does not already exclude.

**Uncompressed essence is named from its PixelLayout.** A descriptor with no PictureEssenceCoding is
uncompressed, and what it is then comes from the layout rather than any label. The codec is
`rawvideo`, which the union already carries for Y4M, and the pixel layout rides in the decoder config's
`description` as a Y4M colour-space tag, as the Y4M reader states it — an uncompressed frame says
nothing about itself, so there is nowhere else to put it.

Only layouts a Y4M tag can state are named: a single 8-bit component is `Cmono`, a single 16-bit one
`Cmono16`. Multi-component layouts — RGB, RGBA, and the subsampled YUV layouts, which state their
subsampling in other fields again — have no tag and read as codec-less rather than as a guess. No file
in any corpus here carries one, so those cases are tested by building the descriptor directly; without
that the single-component check survives every mutation.

**An uncompressed sample is trimmed to the frame size its descriptor states.** The stored element is
padded up to the container's alignment grid — 2,080,768 octets against a 2,073,600-octet frame, 508 ×
4096 — and a packet handed to a decoder has to be a frame. `ffmpeg -c copy` is therefore the wrong
oracle for this one stream, since it returns the padded element; the test compares against
`ffmpeg -f rawvideo -pix_fmt gray` and the frames are octet for octet identical. ffprobe reads the file
as `pix_fmt=gray`, which `Cmono` is the Y4M spelling of.

### What an MXF says about itself

`getMetadataTags()` returns the Preface and Identification fields, keyed exactly as FFmpeg keys them so
the two can be compared field by field: `company_name`, `product_name`, `product_version`,
`product_version_num`, `product_uid`, `toolkit_version_num`, `application_platform`, `generation_uid`,
`uid`, `modification_date`, `operational_pattern_ul`, `material_package_name`, `project_name`.
`creationTime` comes from the Preface's LastModifiedDate. The Avid project name is matched by its UL
through the primer, since it lives under a dynamic tag no number identifies. Across the ten vendor
files, 87 fields match ffprobe and none differ.

**Avid writes a nine-octet version field where the type is ten**, five 16-bit numbers:
`00 01 00 01 00 00 00 00 00`. Reading the fifth component anyway takes the first octet of the *next*
local tag as its high byte — `0x3c`, which is where ffprobe's `1.1.0.0.60` comes from — and then parses
the rest of that set one octet out of step, losing `company_name`, `product_name`, `product_version`,
`product_uid` and `modification_date` entirely on three Avid files. Only the components the field holds
are read, so this reports `1.1.0.0` and keeps the five fields. The test asserts both halves, because a
comparison that simply agreed with ffprobe would have had to lose them too.

## IMF timed text — an MXF data track that is a subtitle track

`imf-demuxer.ts` admitted only image and audio sequences, but the block was underneath it: the MXF
reader yielded no timed text at all. It does now, and **every constant came out of a real file** rather
than a table, because SMPTE ST 2067-5 is not public.

**The descriptor is set `0x0164`**, identified by elimination: scanning a real IMSC track file for
header-metadata keys gives ten sets 377M already names and exactly one it does not. Its interesting
properties carry **dynamic** local tags — `0xfffc` to `0xffff` in that file, assigned by its own primer
pack — so they are matched by the UL the primer maps them to and never by the number. A reader keyed on
the numbers reads a differently-numbered file as having no timed text in it.

**`NamespaceURI` holds a profile.** The real file states
`http://www.w3.org/ns/ttml/profile/imsc1/text` there, not a namespace, so it is reported as what the
file says rather than matched against anything. A set stating none of the four properties is not timed
text, whatever set number it carries.

**`data` is admitted and the descriptor decides.** MXF's `data` kind covers everything that is neither
picture nor sound, so the track loop lets it through; a data track whose descriptor says nothing
recognisable yields no samples and falls away.

**Cues from one packet are not deduplicated against each other.** `SubtitleCueSink` keys cues on time,
id and text so that a self-timed document written into every segment it overlaps is not announced once
per segment. Within a single packet that is wrong: two cues decoded from one document are distinct
because the document says so. This file has **four** paragraphs at 65.065 s carrying the same string,
differing only in ruby positioning — which a cue does not carry — so the read reported 33 cues where
the document has 36. The key counts occurrences **within the packet**, which keeps them apart while a
repeated document still matches itself.

**The document forced the TTML reader to grow.** A plugfest conformance document uses every time
expression there is — `216f`, `255255t`, `00:04:12:06`, `246.246s` and `00:00:52.052` — and the reader
refused three of the five outright. It reads frames and ticks against `ttp:frameRate`,
`ttp:frameRateMultiplier` and `ttp:tickRate` now, with TTML's defaults where a document states none.
The separator is the whole difference between two of them: `00:00:01.06` is 60 ms and `00:00:01:06` is
six frames, a quarter of a second at 24000/1001, and nothing else in the document says which was meant.

## IMF subtitle sequences — a resource is a cut, and so are its cues

`imf-demuxer.ts` admits `SubtitlesSequence`, so a CPL pointing at a timed text track file plays as a
subtitle track. The filter was the smallest part of it.

**A subtitle resource is a cut, exactly as an image one is.** The document covers the whole track file
and the composition takes a span out of it, laid down `RepeatCount` times. The cues inside carry
**file** times, so each is shifted by the same amount the packet was and **clipped** to the cut: a cue
the composition never reaches is not in the composition, and one straddling an edge is shown for as
long as the cut has room for.

**`decodeCues` is synchronous and the cut is not.** Resolving a resource's track needs an await, and
the packet's own timestamp cannot answer it either — a repeated resource shifts the same file time more
than once. So `shift()` records `(placed, cycle, the original packet)` in a `WeakMap` as it produces
each packet, and `trackOf()` caches the resolved track per resource; nothing yields a packet without
resolving its cut first.

**A packet cannot begin before the cut that carries it.** Clip-wrapped essence starts at file time 0
whatever the entry point is, so the shift arithmetic alone put the packet before the composition — and
for a *second repeat*, before the first repeat's end, which made the packets run backwards. A reader
asking "which cut is this packet in?" then got the wrong answer for ever. The shifted time is clamped
to the cut's start, which is the leading edge of the rule that already capped the trailing one.

**A clamped packet states where its cut opens, in `sideData.sourceTimestamp`.** The clamp is right for
ordering and costs something real: a clip-wrapped payload states its own times against the **file**, and
a packet placed at the cut's start no longer relates the two, so anything parsing the payload has
nothing to place a cue by. Add a payload time to `timestamp - sourceTimestamp`. It is stated for
frame-wrapped essence too, where it is simply the packet's own place in the file.

**Styled cues are the other answer, and they already work.** `SubtitleCueSink` carries `placement` for
every cue of a cut IMSC document, shifted and clipped. What it does **not** carry is a named `<style>`
reference: the TTML reader resolves `tts:` attributes on the paragraph and its region, not a
`style="…"` pointing into `<styling>`. That is why a consumer may still parse the document, and why
the offset earns its place.

**A repeat is bounded by its own end, not by the placement's.** A packet capped at `start + duration`
claimed every repeat at once, so a consumer saw one subtitle packet covering twice the span it should.

**Neither showed up in an image or audio sequence**, because frame-wrapped essence always begins inside
its own cut — the entry point lands on a frame boundary. Only clip wrapping separates the two.

**A clip-wrapped sample lasts as long as its track.** This was the real blocker, and it was in the MXF
reader rather than in IMF: clip wrapping writes **one** element for the whole track, and that sample
was being given one edit unit's duration. A four-minute subtitle track reported itself as 42 ms long,
and any cut of it yielded nothing at all, because the sample appeared to end before the cut began.
`wrappingOf` already told us which wrapping it was; nothing had asked. The fix applies to every
clip-wrapped MXF, not only timed text.

## Vendored test material

`test/public/imf-timed-text.mxf` is `Plugfest_IMSC_text_IMP1_01_en_tt.mxf`, an IMF plugfest timed text
track file, taken from the test resources of [Netflix photon](https://github.com/Netflix/photon), whose
repository licence is Apache-2.0. Pinned to the commit that last touched it, so the bytes here can be
checked against their source:

- `https://raw.githubusercontent.com/Netflix/photon/96c566f768028bcbe8da711b2f92419e108a8abf/src/test/resources/TestIMP/TimedTextImageAndTextProfile/Plugfest_IMSC_text_IMP1_01_en_tt.mxf`
- SHA-256 `ee6276e143554a753b5e926efae10a1b4a7a603f831d88fc5057ce4bb12d7eb4`, 37,246 bytes.

It is here because SMPTE ST 2067-5 is not public: every constant the MXF timed text reader uses was
derived from this file rather than from a table, so the test that proves the reader has to run against
it.

The file is a plugfest contribution rather than photon's own work, and whether the repository's licence
was meant to cover redistributing it is not something this fork has established. A consumer who would
rather not redistribute it can fetch it from the pinned URL above at build time and check the hash.

## Writing a timecode — a `tmcd` track, or the bitstream

A video track states the broadcast timecode of its first frame with `metadata.timecode: 'hh:mm:ss:ff'`
— or `hh:mm:ss;ff`, the separator before the frames being the only thing in the string that says
drop-frame. It needs `metadata.frameRate` beside it and is refused without one: a timecode counts
frames, so without the rate those frames are stated against it names no instant. `formatTimecode` and
`parseTimecode` are the public pair, so a timecode read off an input can be stated straight back on an
output track.

**Each format gets the carriage it actually has.** A non-fragmented MP4 or MOV gets a `tmcd` timecode
track whose single four-octet sample is the frame number counted from `00:00:00:00`, with a `tmcd`
track reference on the video track pointing at it — that works for any codec and is what editors read.
MPEG-TS has no such track, so the timecode rides the pictures as an SEI message, and so does a
**fragmented** ISOBMFF file, whose sample table is empty by construction: the sample would have to ride
a fragment, and a reader joining at any segment but the first would never see it. One carriage per
file.

**The SEI is on every access unit, not on the key frames**, because a timecode states the picture it
travels with. The frame it names is counted from the first packet's timestamp rather than from zero, so
a track beginning part way into a source still gets the stated timecode on its own first frame.

**AVC can usually not carry one, and says so.** HEVC's `time_code` is self-describing; H.264's
`pic_timing` is not — how many bits precede the clock timestamp, and whether one is there at all, are
stated only by the SPS's VUI, so a message written into a stream declaring no `pic_struct` reads as
whatever those bits happen to mean. Where that is the only carriage, the muxer refuses and names the
alternative rather than writing something unreadable. ffmpeg carries a timecode in HEVC and AV1 and
never in AVC, for the same reason. MPEG-2 is refused too: it states a timecode in its GOP header, and
this muxer copies the caller's bitstream verbatim.

`units_field_based_flag`/`nuit_field_based_flag` is 1, which is what `ff_alloc_timecode_sei` writes and
so what x265 and nvenc emit.

**`counting_type` is `dropFrame ? 4 : 0`.** H.264 Table D-3 and H.265 Table D.2 give **4** for
"dropping of the two lowest n_frames counts when seconds_value is 0 and minutes_value is not a multiple
of 10", which is exactly NTSC drop-frame, and **ffmpeg honours `cnt_dropped_flag` only for counting
types 2 to 6**. Writing 0 always — to match ffmpeg bit for bit — made every drop-frame AVC timecode
read back as non-drop in every external tool: ffprobe showed `01:00:00:00` where it should have shown
`01:00:00;00`. **Our own reader could not have caught it**: it takes `cnt_dropped_flag` at face value,
so the timecode round-tripped through this library perfectly while being wrong for everyone else. The
test asserts what **ffprobe** makes of the stream, not what we make of it.

The one place this fork follows ffmpeg over the spec is the trailing `payload_bit_equal_to_one`:
ffmpeg's `flush_put_bits` pads with zeros instead, and no decoder checks, so only a byte-level
assertion holds it.

**The `tmcd` layout is QuickTime's, not 14496-12's**, and was read out of ffmpeg's own files: a
36-octet sample entry whose flags bit 0 states a drop-frame count, whose rate is a rational (30000/1001,
so the frame duration divides the timescale exactly), and whose trailing three octets ffmpeg writes as
zero. The media header is `nmhd`, which is what ffmpeg writes for both `mov` and `mp4` though QuickTime
documents `gmhd`; the track is in the movie but **not enabled**, and in no alternate group. ffmpeg's
drop-frame file holds the frame number 107,892 for `01:00:00;00`, which confirms the drop-frame
arithmetic — and with the track reference removed ffprobe reports no timecode at all, so the `tref` is
load-bearing rather than decoration.

The timecode track is not an `OutputTrack`: the caller never adds one, it carries no media, and the
public `TrackType` union is untouched. It is a fourth variant of the muxer's internal
`IsobmffTrackData`. It is created at finalization, after the media samples are interleaved, because its
sample's duration is the span it labels.

### An AVC timecode goes INTO the existing `pic_timing`, and its `time_offset` is 24 bits

**An interlaced stream already carries a `pic_timing` message** — that is how it states its field
order: x264 emits one on every picture with `pic_struct` 3. And an interlaced stream is exactly the AVC
case whose SPS declares `pic_struct_present_flag`, so it is the case the writer's gate admits.
Appending a *second* message is not something a decoder can read, and its `pic_struct` 0 contradicted
the first's 3: a decoder is told a field pair is a progressive frame. The clock timestamps go **into**
the existing message, rebuilt with its `pic_struct` and delay fields carried over verbatim. A field
pair gets two clock timestamps, one per field, both stating the frame's timecode, because SMPTE 12M
counts frames and the two fields of one are the same instant. An access unit whose `pic_timing` already
carries a clock timestamp keeps it.

`cpb_removal_delay` and `dpb_output_delay` are copied, not rewritten: they hold the picture's place in
the HRD schedule, which a timecode says nothing about, and zeroing them would misstate the buffer model
of a stream whose whole purpose is conforming to one.

**Absent HRD parameters do not mean a zero-width `time_offset`.** D.2.2 infers `time_offset_length` as
**24** where no HRD states one, so the field is still there and a message written without it is 24 bits
short (`cbs_h264_syntax_template.c`: `else time_offset_length = 24`). Our reader never looked at the
field, so only the writer was wrong.

**What each oracle can and cannot see**, measured:

- ffprobe's **decoder** read the timecode back happily from a stream carrying two malformed messages.
  It is the oracle that proved the feature works and it could not see either fault.
- `trace_headers` catches a message running past the end of its NAL unit — the appended second message
  — but **not** one that merely disagrees with its own declared payload size, which is what the short
  `time_offset` produces inside a rewritten NAL. It also exits 0 while printing the error, so its
  stderr is the signal and its status is not.
- So the message's width is asserted outright from the arithmetic the SPS fixes: `pic_struct` 4 bits,
  two clock timestamps of 37 bits each plus a 24-bit inferred offset, plus the alignment bit — 127
  bits, 16 octets. A zero-width offset gives 10, and nothing else in the suite would notice.

The SPS parser lets the **NAL** HRD parameters win where a VUI states both sets, which is the order
E.2.2 derives the `pic_timing` field widths in; it previously took whichever came second.

## Interlaced encoding — the field order has to be stated before the encoder opens

`encoderControls.interlaced` takes `'tff'` or `'bff'` and encodes fields rather than frames. The order
is the caller's to state and cannot be derived: a frame holds two interleaved fields with nothing in
the pixels to say which was captured first, and stating it wrong makes motion stutter back and forth
every frame. That is why the ORDER, not merely the presence of interlacing, is what the tests assert.

**x264 does not take the order from the frames, whatever ffmpeg's wrapper suggests.** The wrapper
reconfigures `b_tff` from each frame's `AV_FRAME_FLAG_TOP_FIELD_FIRST`, but x264 cannot change it after
opening, so that route silently yields top-field-first either way: ffmpeg's own CLI with
`-vf setfield=bff -flags +ilme+ildct` produces `pic_struct` 3 on every picture. What works is the
parameter set before the encoder opens — `tff=1` gives 3 and `bff=1` gives 4.
`AV_CODEC_FLAG_INTERLACED_DCT`/`_ME` add nothing for either encoder and are not set. The per-frame
flags are still set, because **x265** needs the frames marked or it encodes progressive whatever its
`interlace` parameter says.

The first implementation got both orders wrong in the same direction — every frame said 3 — and a test
of `'tff'` alone would have passed it. The test reads `pic_struct` off the wire rather than taking
ffprobe's `field_order` summary, and asserts both orders.

**HEVC is refused, and the refusal says why.** x265 accepts an `interlace` parameter and warns that its
own interlaced support is experimental. Driven from the ffmpeg CLI it produces a stream ffprobe reads
as `tb`/`bt`; driven through this pipeline the field order read back as `unknown`, so there is no
demonstration that `'tff'` and `'bff'` differ in the output. A control that silently does not take is
worse than one that refuses. `encoderControls.options` still passes `interlace` through.

**A refused control is a distinct error type**, so the hardware-encoder fallback stops reporting it as
a missing device: `hevc_videotoolbox` refusing `interlaced` previously logged "which means the device
it drives is not available", sending the reader after a driver problem that was not there.

**Signalling.** DASH gets `@scanType="interlaced"`, read off the SPS's `frame_mbs_only_flag` rather
than off the encoder control, because a manifest describes the stream it points at — so a remux of
someone else's interlaced stream is labelled too. It is written only when interlaced, since
`progressive` is what a reader assumes of a manifest that says nothing.

**HLS has no scan-type signal at all.** RFC 8216's `EXT-X-STREAM-INF` conveys nothing equivalent to
DASH's `@scanType`, and Apple's HLS Authoring Specification rules the content out instead: *"1.14. All
interlaced source content MUST be deinterlaced."* So there is nothing to write, and what is left is to
say so — an interlaced HLS ladder logs a warning naming that clause, once per track.

## What Apple's own tools say about the playlists we write

`mediastreamvalidator` and `hlsreport` ship with Apple's HLS Tools, they take a local path, and a
package this library writes goes through both in `test/node/hls-authoring.test.ts`, skipped where the
tools are absent.

The specification itself: **clean**. No errors on a muxed VOD package, a split audio/video one, or one
with `EXT-X-PROGRAM-DATE-TIME`. That is worth something only because the same test feeds the validator
a playlist with an `EXTINF` longer than twice its target duration and asserts it objects — a tool that
passes everything proves nothing, which `MP4Box -info` taught this fork once already.

The **HLS Authoring Specification for Apple Devices**, which `hlsreport` checks, found two things that
were ours rather than the caller's:

**`FRAME-RATE` was almost never written.** *"Each EXT-X-STREAM-INF tag MUST have a FRAME-RATE
attribute."* The emitter wrote it only when the caller had set `VideoTrackMetadata.frameRate` — and
that field **snaps every timestamp and duration to itself**. It is a request to re-time the media, not
a way to state what the rate is, so a caller who merely wanted the attribute would silently get
resampled output, and `Conversion` leaves it unset. Nothing declared a rate, so nothing was written,
while the validator read 25.000 fps off the very segments we had just produced.

The fix states what the packets say: the segment pipeline counts the video packets a playlist is given
and the span they cover, and the emitter divides. An average is the honest answer for a variable-rate
stream and is what `FRAME-RATE` means — it describes the variant, not a constant the media promises to
hold. A caller's own `frameRate` still wins. The test does not compare our number against itself: it
takes `avg_frame_rate` from ffprobe, on the input.

**`EXT-X-INDEPENDENT-SEGMENTS` was only in the media playlists.** Every one of them carried it, which
has the same effect, but the authoring specification asks for it in the multivariant playlist and the
validator reads a package's `independentSegments` state from there — it reported `false` for a package
in which every media playlist said otherwise. It is written in both now.

Everything else the report lists is the caller's: a bitrate ladder, I-frame playlists, captions, gzip,
TLS, 6-second targets.

## NAL HRD — a capped encode that says nothing about its own cap

`encoderControls.nalHrd` takes `'cbr'` or `'vbr'` and writes the HRD parameters into the bitstream.
A capped encode already bounds its own rate and the stream **said nothing about it**: with no
`hrd_parameters` in the SPS's VUI, nothing downstream can verify conformance or know what buffer to
allocate, which is the whole of what a broadcast chain asking for "T-STD conformant" needs from the
elementary stream.

**The SPS parser already walked these values and threw them away.** `bit_rate_value_minus1`,
`cpb_size_value_minus1` and `cbr_flag` were read only to reach the three field widths after them. They
are returned now, so `AvcHrdParameters` carries `bitRate`, `cpbSize`, `constantBitRate` and
`initialCpbRemovalDelayLength`. The rate is decoded against its exponent — E.2.2 states
`BitRate = (value + 1) * 2^(6 + bit_rate_scale)` — and that exponent is **not** always zero: x264
writes 0 at 1.5 Mbit/s, 1 at 50 Mbit/s and 4 at 400 Mbit/s, so a parser assuming 64 bit/s granularity
is out by a factor of 2 and 16 there while passing every test that sits at 1.5 Mbit/s. There is a case
at each scale. The rate is also quantised by that coding: 1,500,000 comes back as 1,499,968, which is
the stream being honest.

**`'cbr'` needs a rate that is actually constant, and refuses otherwise.** x264 writes `cbr_flag` only
where the target equals its own cap, and a capped quantizer is not that however tightly it is capped —
it produces `cbr_flag` 0 — so accepting `'cbr'` there would hand back a stream whose own signalling
contradicts what was asked. It requires `bitrateMode: 'constant'` and says so.

**Which exposed a real gap underneath:** `bitrateMode: 'constant'` pinned the rate top and bottom and
set **no buffer size at all**, so there was no window for the encoder to even out over — and x264
refuses `nal-hrd` outright without `vbv-bufsize`. `bufferSize` was also unexpressible there, requiring
`maxBitrate`, which in turn requires `quality` or `quantizer`. It accepts a plain `bitrate` now, and a
constant-bitrate encode passes it to the encoder **only when the caller states one**.

`'cbr'` also makes x264 emit filler NAL units (type 12) to take up the slack, which is the difference
between stating a constant rate and producing one; `'vbr'` states the model without the padding. Both
survive a round trip into MP4 — ffmpeg's option help warns "cbr not allowed in .mp4", but that is
advisory and measured not to apply here.

**HEVC signals but does not take the mode.** x265 has only `--hrd`, an on/off switch, and derives its
`cbr_flag` from the rate control, so both modes turn its signalling on. Nothing here parses an HEVC
VUI, so that half is verified through `trace_headers`.

## Active Format Description — two octets, settled by writing one

`metadata.activeFormatDescription` states an AFD (SMPTE ST 2016-1) on a video track: which part of the
coded frame carries the picture, so a receiver whose display has a different shape knows what it may
crop and what it must letterbox. Written as an ATSC A/53 `user_data_registered_itu_t_t35` SEI message
under the `DTG1` identifier — the same envelope the closed-caption path uses, with a different
`user_identifier` — so it goes in through `media-source.ts` and reaches **every** output format at
once. No container has a box for this; the bitstream is the only carriage.

**The two payload octets were settled by writing one and having ffmpeg read it back**, not by reading
the standard. The `active_format_flag` is in the FIRST octet (0x41: the flag plus the six reserved bits
ST 2016-1 states as `000001`) and the code is the low nibble of the SECOND (0xF0 | afd). ffmpeg's
`libavcodec/itut35.c` confirms the split. Written the other way round the message is one ffmpeg ignores
entirely, and a round trip through our own reader would not notice, which is why every code is checked
against `ffprobe`'s `active_format` field as well.

**On every frame, not on key frames alone.** A receiver joining mid-GOP has to learn the shape too, and
ST 2016-1 signalling is per frame.

**A packet that already states one keeps it.** Note what makes that assertable: a second message
spliced in lands **after** the existing one, so a reader that stops at the first still returns the
original and the duplicate goes unnoticed — removing the guard passed a test that only read the value.
The test counts the messages per packet instead.

Only AVC and HEVC can carry it, and any other codec is refused when the track is added rather than at
the first packet. The ten codes ST 2016-1 Table 1 defines are accepted; 0, 1, 5, 6, 7 and 12 are
reserved there and are refused, since the code sits in a nibble beside four reserved bits and a writer
that masked wrongly would come back right for some values and wrong for others.

`parsePacketAfd` is the read side, exported beside `parsePacketClosedCaptions`.

## LOAS/LATM framing for AAC in MPEG-TS

`MpegTsOutputFormatOptions.aacFraming: 'latm'` writes AAC as stream type **0x11** in LOAS
`AudioSyncStream` frames, which is what DVB feeds carry where North American practice and HLS use ADTS.
`latmConfigInterval` says how often the configuration is repeated, defaulting to every frame.

**The configuration travels inside the stream.** A `StreamMuxConfig` embeds the AudioSpecificConfig
itself, so a receiver joining mid-stream learns the sample rate and channel layout without a PMT
descriptor — which is why the interval matters: a decoder can only start at a frame that carries one.
It is embedded as an exact run of **bits**, so the number of bits the config occupies has to be known
rather than guessed. That length is ffmpeg's `off + 3`: the config's own header plus the three
`GASpecificConfig` bits that follow when the stream is neither scalable nor dependent on a core coder.
A length wrong by **one bit** does not corrupt the config — it shifts `frameLengthType` and
`latmBufferFullness`, and the frame decodes as something else. A config this library cannot measure is
therefore refused rather than attempted: `channelConfiguration` 0, whose program config element's
length depends on the element lists inside it, and object types above AOT 5, which ffmpeg also refuses.

**The payload is written unaligned**, continuing from wherever the config and the length info left off,
so the whole frame is one bit stream rather than a header followed by octets. The layout follows
`libavformat/latmenc.c` field for field.

**The test that makes this real is the PCM comparison.** The same source written both ways has to
decode to **byte-identical** samples through ffmpeg's own `aac_latm` decoder. Framing is exactly the
kind of thing where a file looks right — correct stream type, correct sample rate read back out of the
embedded config, plausible frame boundaries — and still decodes to noise. Proven by mutation:
byte-aligning the payload, and dropping the 255-octet chunks from `PayloadLengthInfo`, are both caught
**only** by that assertion.

An ADTS-wrapped input is refused rather than unwrapped, since its header would land inside the payload.
SAMPLE-AES stays on 0x0F: that encryption scheme is defined over ADTS frames.

**No HLS restriction is imposed, having checked.** RFC 8216 is silent on AAC framing inside transport
stream segments — it mentions ADTS only for Packed Audio segments, which are not transport streams, and
mentions LATM nowhere. Refusing LATM for HLS would have been inventing a rule the specification does
not state.

## `hlsKeysOf` — the HLS DRM keys as objects, not lines

`buildHlsKeys` returns `#EXT-X-KEY` lines. A consumer that assembles a media playlist from the parsed
model and serializes it once at the end cannot use those: it holds `HlsKey[]`, so it had to take the
lines and parse them straight back. The workaround in the field was worse — build a throwaway
one-segment playlist, run the `drm()` transform over it, and read the key tags out of the result.

`hlsKeysOf({ systems, fairplayKeyUri })` is that object form, and `buildHlsKeys` is **this function
plus the serializer**, so the two cannot drift. `drm()`'s own private helper is a call to it;
`hlsKeySpecs` remains the single source of truth under all three. `HlsKey` was already public, so this
adds a function and no new type.

What it does NOT take, and why, since all three were asked for: `scheme` and `kid` are not inputs — an
HLS key tag's METHOD is always `SAMPLE-AES` and the KID appears nowhere in the tag. `keyUri` is
`fairplayKeyUri` and only FairPlay uses it; every other system's URI is derived from its `pssh`, and a
missing one throws rather than yielding a playlist that declares DRM with no key. `iv` and `keyId` are
null: a cbcs key takes its IV from each sample's `senc`.

**`drm()` writes no `EXT-X-SESSION-KEY`** and never did — an HLS master is left unchanged by design.
That tag is emitted while *generating* a master (`createSessionKeys`), by collecting the unique
`EXT-X-KEY` entries and re-serializing each under the session tag name.

The test pins the acceptance that was asked for: serializing what `hlsKeysOf` returns equals
`buildHlsKeys` for the same inputs. Three mutations fail it.

## DVB time and network tables — TDT, TOT and NIT

`MpegTsOutputFormatOptions.dvbTime` writes a Time and Date Table on PID 0x0014, and a Time Offset
Table beside it where `regions` names any; `network` writes a Network Information Table on 0x0010.
Neither is written unless asked for. A DVB receiver takes the wall-clock time it displays from the TDT
— the PCR says nothing about what time it is.

**ffmpeg cannot check any of this.** Its transport stream demuxer does not parse TDT, TOT or the MJD
time encoding at all — `mjd` and those table ids appear nowhere in `libavformat/mpegts.c`. The
constants therefore came from **TSDuck's source**: `MJD_EPOCH = 40587`, `TDT_TID = 0x70`,
`TOT_TID = 0x73`, `DID_DVB_LOCAL_TIME_OFFSET = 0x58`, and the 13-octet region entry with its reserved
bit **set**.

**A TDT carries no CRC and a TOT does, and neither says so in its header.** Both are short sections —
`section_syntax_indicator` 0 — which normally means no CRC follows. The TOT has one anyway; TSDuck
models precisely this. A parser can only know from the table id. The TDT's `section_length` is 5, which
is the `UTC_time` and nothing else.

**The epoch is pinned to a published value rather than to our own arithmetic.** The test's expectations
are derived from date arithmetic, which is the same formula the writer uses and would agree with a
wrong epoch just as readily. One case therefore asserts that 1 January 2000 encodes as **MJD 51544**,
which is published independently. Mutating the constant to 40588 is caught by that case and by nothing
else that is not circular.

**The NIT's delivery system descriptors are the caller's**, because only they know them: the
modulation, frequency and FEC of a path are properties of the transmission, not of the file. Without
any, the table still names the network and lists this transport stream, which is what associates the
two; a caller with a terrestrial delivery system descriptor (tag 0x5A) passes it through
`transportDescriptors`.

The time is read once per table write and shared between the TDT and the TOT, so the two cannot state
different instants; `now` is a function so a stream can carry a time that is not this machine's.

### TSDuck reads them back, which a hand parse cannot

Asserting these with this library's own parser and arithmetic derived from EN 300 468 by hand means
both halves share any misreading of the spec with the writer — the exact shape that produced three
shipped bugs in beta.806/807.

`test/node/mpeg-ts-foreign-decoder.test.ts` puts **TSDuck** behind them: the TDT and TOT decode to the
stated instant through the MJD + BCD encoding, the local-time-offset descriptor reads back with its
country, offset and next change, the TOT's CRC verifies, and the NIT states the same
`original_network_id` the SDT does — which is the pair a receiver associates a service with its network
by, and which neither table alone shows. Two mutations fail it: `MJD_EPOCH` off by one day, and the NIT
hardcoding `original_network_id` to 1.

The file skips where `tstables` is absent, which includes CI. Install with `brew install tsduck`. Note
TSDuck's `tsp` is shadowed by an unrelated npm `tsp` on this machine — use `/opt/homebrew/bin/tsp`.

**SCTE-35 was checked the same way and is correct**: all three section shapes parse, the CRC verifies,
and the PMT's stream type `0x86` with the CUEI registration descriptor is what TSDuck expects. One
inaccuracy surfaced and is a test fixture's, not the library's — the fixture's comment claims
`tier 0xFFF` where its bytes encode `0x0FF`. The library neither reads nor writes `tier`.

## Two malformed SEI fixtures, and the guard that would have caught them

`scripts/build-timecode-sei-fixture.py` omitted `rbsp_trailing_bits`, so in both
`timecode-sei-avc.mp4` and `timecode-sei-hevc.mp4` the `payload_size` consumed the whole NAL unit and
left nothing for the trailer. ffmpeg reports `SEI type 1 size 9 truncated at 8`; its conformance parser
refuses the unit outright.

**Neither reader noticed, for the same reason.** ffmpeg's decoder reads such a message anyway, and this
library's unescapes first and then clamps a payload that runs past the end — so a round trip through
either one succeeded. The fixtures were testing the reader against files nothing else accepts.

The generator writes the trailer now, both fixtures were regenerated, and `start-timecode.test.ts`
asserts that a conformance parser accepts them. This library's own SEI **writer** was never affected —
`buildSeiNalUnit` appends `0x80` and declares `payload.length` over the unescaped RBSP, which is the
right order.

## D-10 (IMX) delivery

`MxfTarget({ mapping: 'd10' })` writes the SMPTE 356M mapping through ffmpeg's `mxf_d10` muxer, and
`encoderControls.d10` takes 30, 40 or 50 (Mbit/s).

**D-10 is a frame size, not a bitrate.** Every coded frame must be exactly `rate / fps / 8` octets —
250,000 at 50 Mbit/s and 25 fps — because the mapping indexes the essence by that fixed unit. A frame
of any other length is refused by the container with `frame size does not match index unit size` and
nothing more, which is why the encoder side is a preset. Measured one by one, `rc_init_occupancy` is
the option that makes the size exact; `rc_max_vbv_use` and `rc_min_vbv_use` have no effect on a short
clip of static content and are kept anyway, because they bound how much of the buffer one frame may
take and only varying material exercises that.

**The folklore recipe's `-ps 1` is wrong here, and was dropped.** Measured, it gives one slice per
**macroblock** — 1,620 slice start codes a picture at 720x576, against the 36 a slice-per-row
structure gives — because `ff_mpeg1_encode_slice_header` codes the row in the start code and ffmpeg
will emit several slices inside one row. That is legal MPEG-2, it is not D-10's slice structure, and it
spends about 7 KB of every frame on slice headers. The test asserts 36 slices per picture.

**4:2:2 is forced by the control**, not taken from the codec string: SMPTE 356M defines no 4:2:0
variant, and without this the output was MPEG-2 Main 4:2:0 with D-10's frame sizes — every frame the
right length, the container perfectly happy, and not an IMX deliverable. The bitstream constraints the
frame-size test cannot see (intra VLC, non-linear quantisation, 10-bit DC precision, intra-only) are
asserted through `trace_headers`.

The streams D-10 does not allow are refused before the muxer sees them, with the limits read out of
`mxfenc.c` rather than from the standard, so they are the ones that will actually be enforced: MPEG-2
only, 30/40/50 Mbit/s, one audio track, 16- or 24-bit little-endian PCM, at most 8 channels.

## SCTE-20 closed captions in MPEG-2

`metadata.closedCaptions` accepts an `mpeg2` track, writing the captions into each picture's
`user_data` as SCTE-20. MPEG-2 has no SEI, so this is where captions go in an MPEG-2 programme — and it
is not the A/53 syntax with a different wrapper. Two fields are encoded differently and **both fail
silently**:

- The caption octets are stored **bit-reversed** relative to every other carriage, which is what
  ffmpeg's `ff_reverse[cc1]` undoes when it reads one. Nothing in the syntax hints at it, and captions
  written without it decode to arbitrary characters rather than to nothing.
- The field number is the **frame's** field, 1 or 2, where A/53's `cc_type` numbers line 21's two
  fields. They agree only on a top-field-first picture, and ffmpeg flips on exactly that
  (`if (!top_field_first) field = !field`). So `top_field_first` is read out of the picture coding
  extension, and without it CC1 text lands on CC3's field — decoding cleanly to the wrong channel.

**The oracle is a four-step chain**, because nothing writes SCTE-20 but us and nothing here reads it
but ffmpeg: our writer → ffmpeg's MPEG-2 decoder, which converts SCTE-20 into A/53 triplets →
ffmpeg's `-a53cc` SEI writer → this library's A/53 reader, which is independently checked against
ffmpeg elsewhere. Both faults were caught by that chain and by nothing else.

CEA-708 packet data is refused: SCTE-20 numbers one of two line 21 fields and has no room for DTVCC.

## An MXF ancillary track read as audio, and threw

A SMPTE 436M ancillary data track — how a broadcast master carries VANC: captions, AFD, timecode —
fell through the MXF demuxer's track mapping to the **audio** backing. Every accessor on that backing
asserts on sound information the track does not have, so `numberOfChannels` threw the moment anything
looked at it. Opening an ordinary captioned master was enough.

The mapping asks the descriptor rather than the track kind, because `data` covers everything that is
neither picture nor sound, and it recognised only the ST 2067-5 timed text descriptor.

A data track that is neither timed text nor sound is left out. That is the honest answer while there
is no track type for ancillary essence — this library has video, audio and subtitle, and ANC is none of
them — and it is deliberately narrow: dropping every `data` track instead would take the timed text
tracks with it.

The fixture is built rather than vendored, through a chain this fork owns both ends of: the SCTE-20
writer puts captions into an MPEG-2 picture, and ffmpeg turns those into a 436M ancillary track when it
writes MXF. The test checks the fixture really has that track before asserting anything about it, since
a fixture with no ancillary track would pass for the wrong reason.

## Reading captions out of a SMPTE 436M ancillary track

`ancillaryPacketsOf(frame)` and `ancillaryCaptionsOf(frame)` turn one edit unit of an ancillary data
track into its ANC packets, and into CEA-608 byte pairs. The ancillary essence is **not** a track,
which is right, since neither captions nor ancillary data is a track in this library.

Three layers nest, and the captions sit under all three: a 436M frame holds ANC packets, a caption
packet (DID 0x61, SDID 0x01 — ST 334-1) holds a ST 334-2 caption distribution packet, and the CDP's
`ccdata` section holds the same `cc_valid`/`cc_type`/two-octet triplets every other carriage uses.

**None of those standards is public, so the field widths were read out of a file whose caption content
was already known.** ffmpeg writes a 436M track when it muxes MXF, so feeding it the SCTE-20 captions
produced a frame whose every field could be identified by what it had to mean:
`0001 0009 01 04 0013 00000014 00000001 61 01 10 9669 10 3f 43 0000 72 e1 fc 41 42 74 0000 29` — one
packet, line 9, 20 octets of payload, DID 0x61, SDID 0x01, 16 user words, and `fc 41 42` being exactly
the triplet that went in.

That makes the test the whole chain with this fork at both ends and ffmpeg in the middle: the SCTE-20
writer puts `0x41 0x42` on field 1 of an MPEG-2 picture, ffmpeg's decoder converts it to A/53 triplets,
ffmpeg's MXF muxer wraps those in a CDP inside a 436M packet, and `ancillaryCaptionsOf` reads them
back. A padding triplet whose `cc_valid` is clear is skipped — ffmpeg's own file never contains one, so
that case is a frame built by hand from the layout the real file established.

Malformed input yields an empty array rather than throwing, because a caller hands this whatever a data
track gave them.

## DNxHD and DNxHR, and the frame the encoder was still holding

`encoderControls.dnxProfile` encodes VC-3 (`'145'`, `'220'`, `'220x'`) and DNxHR (`'lb'`, `'sq'`,
`'hq'`, `'hqx'`, `'444'`), into MOV and MP4 under the `AVdn` sample entry and into MXF OP1a.

**A VC-3 class is a frame size, not a bitrate.** 606,208 octets a frame for 145 and 917,504 for both
220s at 1920x1080, whatever the rate — 145 Mbit/s at 29.97 and 120 at 25 are the same class and the
same number of octets. ffmpeg matches a class by comparing the stated bitrate against the CID table in
its own `dnxhddata.c`, so only the exact value will do, and the tests assert the octets a frame rather
than an average.

Every class has a progressive identifier and an interlaced one of the same size — 1237/1242 for 145,
1238/1243 for 220, 1235/1241 for 220x — so **the frame size cannot tell them apart**, and neither can
ffprobe, which reports `field_order=unknown` because no container states it. The tests read the
compression id out of the VC-3 frame header instead. 220x progressive at 29.97 has no identifier at all
and is refused by name. The interlaced identifier is chosen at open time from
`AV_CODEC_FLAG_INTERLACED_DCT`, not from a parameter string, so `encoderControls.interlaced` takes a
path of its own for this codec.

**The crash was ours, and was not about DNxHD.** The encode aborted the process after a few frames, at
a point that moved between runs. DNxHD delays — it holds a reference to the frame past `sendFrame` —
and the scaler then wrote its next output into that same buffer, because swscale writes where it is
told without checking whether anyone else owns the pixels. `av_frame_make_writable` before each scale
fixes it, and is a no-op while we are the only owner. **This was a latent corruption for any delaying
encoder**, not a DNxHD one.

## `preciseTimings` was keyed by a number that does not survive the round trip

The encoder keeps the original timestamp and duration of each frame so a packet can be given back
better than microsecond accuracy. Upstream keys that table by `videoSample.microsecondTimestamp` and
looks it up by the packet's microseconds, which is exact **only while the codec time base is
microseconds**. This fork gives MPEG-2 and AVC a frame-rate time base so the stream can state its own
frame rate, and under any time base coarser than a microsecond, microseconds → ticks → microseconds is
lossy: a frame remembered at 66666 was looked up at 66667 and never found. One frame in six silently
lost the captions it had stated.

It is keyed by the tick the frame was sent with, which is the pts the encoder was given and so is exact
by construction.

## The SPS was declaring a million frames a second

x264 takes `num_units_in_tick` and `time_scale` straight from the encoder's time base — the numerator
and twice the denominator — so a microsecond time base wrote a VUI claiming 1,000,000 fps while the
track said 25. In MPEG-TS the SPS is the only place a receiver can read the rate from, so the stream
was stating something plainly untrue. AVC takes a frame-rate time base when a frame rate is stated, as
MPEG-2 already did; there is no second knob, because in x264 the VUI rate and the PTS resolution are
the same field. x265 takes its timing from the frame rate and was already right.

## AIFF, which is RIFF the other way round

`AIFF` reads and `AiffOutputFormat` writes. Big-endian signed PCM is plain AIFF; little-endian PCM,
floats, µ-law and A-law are AIFF-C, which is the same file with a compression type in `COMM`.

Two things here are not WAVE with the bytes swapped. **AIFF's 8-bit samples are signed** where WAVE's
are unsigned, and one read as the other is full-scale noise. And the sample rate is an **80-bit IEEE
754 extended float**, whose mantissa carries an explicit integer bit rather than an implied one — the
usual "or in the leading 1" puts every rate out by a factor of two.

`sowt` is the little-endian compression type ("twos" backwards, for two's complement) and is what Mac
tools write today; `twos` is its big-endian opposite and means the same as `NONE`.

## Y4M, and a raw video codec to carry it

`Y4M` reads and `Y4mOutputFormat` writes YUV4MPEG2: a text header, then `FRAME\n` and a whole
uncompressed picture, over and over. It is what ffmpeg, x264 and the quality metrics read when they
want frames rather than a stream.

This needed a `'rawvideo'` codec in `VIDEO_CODECS`, which `tsc` found six sites for. Uncompressed
frames carry nothing that says what they are, so the **colour space rides in the decoder config's
`description`** as the Y4M tag it was read from — it is the pixel format, and it is the only thing a
decoder needs or a writer can state. `@mediabunny/server` maps the tag to an `AVPixelFormat` on the way
in and back on the way out.

Everything about a Y4M is arithmetic: there is no index, so a frame's position is the one before it
plus its size. **The colour space fixes that size**, which is why reading it wrong does not fail — the
second frame is read from the middle of the first, and every one after at the wrong offset, which looks
like corrupt video. The chroma planes round UP: a 4:2:0 picture of odd width still has a chroma sample
for its last column. A frame header is `FRAME`, optional parameters of its own, and a newline, so it is
not a fixed width either and the walk cannot be replaced by multiplication.

Uncompressed video in ISOBMFF is a family of layouts (`2vuy`, `v210`, `raw `) with their own packing,
and this library writes none of them; the codec is refused there rather than given a sample entry.

## Timed AMF over RTMP — `onCuePoint` and `onTextData`

`RtmpTarget.sendCuePoint()`, `.sendTextData()` and `.sendAmfData()` put timed data on a live stream,
which RTMP carries as FLV script data tags.

There is no data track to add to an `Output`, so the message is handed to the target directly and
**queued until the next media packet**: an FLV's header is written with the first packet, and a script
tag ahead of it would be refused. Draining inside the packet loop also keeps the messages in step with
the media rather than racing the muxer's own queues.

The stream they ride is added through the format context rather than through node-av's `Muxer`, which
only takes streams copied from a demuxer or driven by an encoder, and there is neither here. Its codec
id is `NONE` on purpose: that is what makes ffmpeg's FLV muxer write the packet verbatim as the tag
body. With `TEXT` it builds an `onTextData` message of its own around the bytes instead.

**What an ffmpeg hop does to these messages** is worth knowing before reading the tests. ffmpeg's FLV
demuxer understands `onMetaData` and `onTextData` and skips every other script tag, so `onCuePoint`
cannot be observed through one at all. For `onTextData` it keeps only the `text` property and rebuilds
the message around it. The tests therefore record the publisher's own TCP stream and assert the AMF0
there, octet for octet, with ffmpeg still terminating the connection — so a proxy that broke the stream
fails the other assertions rather than letting this one quietly pass. The FLV timeline is restarted at
zero by ffmpeg, so the tags' absolute timestamps are not ours to state; the intervals between them are.

## Generating a Dolby Vision RPU — profile 8.1

`buildDolbyVisionProfile81Rpu()` writes one RPU as a complete HEVC NAL unit, for
`VideoSampleInit.dolbyVisionRpu` or `EncodedVideoPacketSource`. The carriage was already here; this is
the metadata itself.

Profile 8.1 is Dolby Vision on top of an HDR10 base layer: BT.2020 PQ, 10-bit, no enhancement layer,
and an **identity mapping** — the pictures are the HDR10 pictures and the RPU only says how to present
them. So an existing HDR10 encode can be given Dolby Vision without re-encoding a pixel. (In
MediaConvert's terms that is `HDR10_NOMAP`; `HDR10_1000` is a real tone map and is not this.)

Three blocks are written: **L1** (the frame's own min, max and average PQ, the only per-frame part),
**L5** (the active area, so letterbox bars are not read as content) and **L6** (the HDR10 static
metadata, for a player that falls back). L5 is written even when the caller states none, because an
all-zero active area is what "the whole frame" means and an RPU without one is not what a player
expects. The mastering luminances in L6 also *pick* `source_min_pq` and `source_max_pq` through a table
with no formula behind it — 1000 nits is 3079, 2000 is 3388, 4000 is 3696, 10000 is 4095, and anything
else falls back to the 1000 entry.

**The syntax is not public.** Every field order and width was read out of `dovi_tool`
(quietvoid/dovi_tool at `41dae646`, `dolby_vision/src/rpu/`), which is also the oracle: for the same
inputs this writes the **same octets** `dovi_tool generate` does. That bar is not satisfiable by
accident — an RPU is one bit-packed run with no byte boundaries to resynchronise on, so a field of the
wrong width shifts everything after it, and the CRC fails it a second time. Every one of five mutations
failed the comparison; a nine-bit `source_diagonal` and a reflected CRC each took 18 of the 24 tests.

Two things that are easy to get wrong and fail silently:

- **The CRC is CRC-32/MPEG-2** — the ordinary polynomial, but with no reflection of input or output and
  no final xor. The reflected variant produces an RPU that parses and then fails its own checksum.
- **Emulation prevention is walked over the growing output**, so an inserted octet becomes the `i - 1`
  of the next test and ends the run of zeroes. Counting the zeroes of the *input* instead escapes every
  third octet of a long run rather than every third of the output — and an RPU is mostly zeroes.

Still to do: CM v4.0 (which adds L3, L9, L11 and L254 in a second container), and L2 trims.

## The flaky browser quality test was never about 'very-low'

`browser/quality.test.ts > AVC, qualitative quality 'very-low'` failed roughly one run in three, at a
10-second per-test timeout, and had been written off as load. It was the **first conversion in the
file** paying for the source fetch and for Chrome bringing up its video encoder — 11.9 s, against
~0.8 s for each of the sixteen that follow. Against a per-test timeout that cost lands on whichever
test happens to run first, so the reputation attached to 'very-low' rather than to the position. A
`beforeAll` pays it once and 'very-low' runs in 772 ms. Raising its timeout would have hidden the same
cost in whichever test ran first next.

## Y4M reported a duration of zero

`computeDuration()` asks the backing for the packet at `Infinity`, and every other backing here clamps
that to its last packet. Y4M has no index to clamp against — the frames are found by walking, since a
frame header is not a fixed width — so the request fell off the end and answered "no such packet", and
the track reported **zero** while reading all of its frames perfectly. Any consumer that clips by
duration refuses such a file. A seek past the end falls back to the last frame, which the walk already
found.

Caught by the consumer, not here: this fork's own Y4M tests read every packet and compared the pixels,
which is a path that never asks for a packet past the end.

## The RPU went in ahead of the slices, and a test of ours held it there

An RPU spliced **before** the first VCL NAL unit belongs to the **previous** picture: a parser ends an
access unit at the next picture's first slice, so everything before that falls to the one before. We
wrote `62/1`; Dolby writes `1/62`, and `test/public/dv-p81.mp4` — a genuine profile 8.1 stream already
in this repo — reads `39/20/62` on its key frame and `1/62` after.

What it cost: `dovi_tool extract-rpu` warned "Unexpected RPU NALU found for frame N. Discarding." and
recovered 49 of 50; ffprobe reported Dolby Vision metadata on 2 frames of 50; and every player paired
each RPU with the frame before it, so per-frame L1 and scene cuts landed a frame early.
`spliceNalUnitAfterVcl` places it after the last VCL NAL unit. SEI messages still go **before** the
slices — the two are not interchangeable, which is why they are separate functions rather than a flag.

**A test of ours asserted the bug.** It read `expect(rpuAt).toBeLessThan(firstSliceAt)` — written from
the same wrong assumption as the code, and so guaranteed to pass. Two things make that unrepeatable:
the fixture check, which reads a real Dolby Vision file rather than our own output, and an acceptance
test that asks **ffprobe** how many frames carry RPU metadata and **dovi_tool** how many it can extract
without discarding one. That acceptance test also needs REAL RPUs — the synthetic seven-octet stubs the
older tests use are not parseable, so ffprobe reports nothing for them and the check would pass empty.

## Filling a gap with frames that decode — `buildSkipFrames`

`buildSkipFrames(decoderConfig, options)` returns one packet per frame, each a P picture in which
every macroblock or coding unit is skipped, so a decoder holds a picture it already has. Built from an
`avcC` or `hvcC` alone, with no encoder. Framing matches the configuration — length-prefixed, with the
prefix size that record declares.

AVC (`avc1`, `avc3`) and HEVC (`hev1`, `hvc1`), both AVC entropy coders. Refused: a configuration with
no `description`, and an HEVC PPS enabling **tiles**.

**The caller states where the gap is.** `frameNum` continues from the frame before it.
`picOrderCntStep` defaults to **2 for AVC and 1 for HEVC**, because AVC counts picture order in fields
and HEVC in frames. Each frame is a reference picture — `nal_ref_idc` 2, HEVC `TRAIL_R` — so the next
one copies it.

**`copyFromDistance`** states how far back the copied picture is, in `frame_num` for AVC and picture
order count for HEVC. Default is the picture immediately before. State it where the last picture
displayed is not the first reference in the list, which a B pyramid produces whenever a segment ends
on a complete mini-GOP. Only the first frame carries the reordering; the rest copy the frame before
them.

**`precedingSamples`** — the coded samples before the gap, in decode order, starting at a key frame —
makes `frameNum` and `picOrderCntLsb` derived instead of stated, and lets **`copyPictureOrderCount`**
name the copied picture. Raises `ReferencePictureNotHeldError` where that picture is not a reference at
the end of those samples, or is not behind the fill.

**Only a picture still held as a reference can be copied.** Where the last picture displayed is a
non-reference B, nothing reaches it and holding the last key frame is the only correct fill.

The reference list is overridden to one entry. In AVC this matters: the PPS default is routinely
larger than the number of pictures behind a fresh key frame, and the decoder fills what is missing
with a default picture, reporting `Missing reference picture` at error level while still exiting 0 and
producing identical frames — so only the message detects it. In HEVC it is defensive; that list
construction wraps rather than leaving holes.

### `buildKeyFrameFill`

`buildKeyFrameFill(sample, decoderConfig, options)` returns `count` access units that each decode to
the same picture as `sample`, for a gap no skip frame can fill. AVC only: it works by rewriting
`idr_pic_id`, which HEVC has no equivalent of, so an HEVC key frame may be repeated as it is.

Consecutive IDR pictures must state different `idr_pic_id` values (7.4.3). The values returned differ
from each other and from the one `sample` states, so the real key frame can follow the last of them
directly. The caller never states a value.

### What both refuse, by name

Every refusal either function makes about the stream or the sample is a subclass of `FrameFillError`:
`UnsupportedFillCodecError` (not AVC or HEVC; not AVC for `buildKeyFrameFill`),
`MissingParameterSetsError` (no `description`, no SPS and PPS, or a first PPS naming a different SPS),
`UnsupportedTilesError` (the PPS enables tiles) and `MissingKeyFrameError` (the sample handed to
`buildKeyFrameFill` carries no IDR slice). `UnsupportedReferenceMarkingError` and
`ReferencePictureNotHeldError` stay outside that hierarchy, since `referencePicturesAfter` raises them
too.

An option out of range is a `TypeError` and not a `FrameFillError`. `frameNum` is required for AVC
unless `precedingSamples` is given; HEVC codes none and numbers its pictures by `picOrderCntLsb`.

### `referencePicturesAfter`

`referencePicturesAfter(decoderConfig, samples)` returns the pictures a decoder still holds after
`samples`: each one's `pictureOrderCount`, `frameNum` (`null` on HEVC) and short/long term, plus
`lastDisplayedPictureOrderCount` and `nextFrameNum`. `samples` are in decode order and must start at a
key frame.

Modelled: sliding window, `mmco` 0 and 1, AVC picture order count types 0 and 2, and HEVC's reference
picture set as stated in a slice header. Everything else raises `UnsupportedReferenceMarkingError` —
`mmco` 2 to 6, long term references, picture order count type 1, an HEVC set selected out of the SPS
or predicted from another, and samples not starting at a key frame.

### Five HEVC SPS fields became reads

`parseHevcSps` walked `log2_min_luma_coding_block_size_minus3`,
`log2_diff_max_min_luma_coding_block_size`, `sample_adaptive_offset_enabled_flag`,
`long_term_ref_pics_present_flag` and `sps_temporal_mvp_enabled_flag` and discarded them; they are now
returned on `HevcSpsInfo`. The walk reads the same bits in the same order, so the lines the deletion
guard names are those fields kept rather than dropped.

### A segment source is marked as part of its read

The HLS and DASH readers cache four segment `Input`s and **abandon** the evicted one to garbage
collection rather than disposing it, because it may still be in use. Its root ref is therefore never
freed, so both readers mark that source as part of their read — otherwise every eviction reports
`A SourceRef was garbage-collected without being freed`, which is a caller's mistake everywhere else
and not fixable by one here. The mark propagates to every segment source resolved through it.
