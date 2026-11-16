/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The XML here is namespaced and prefixed the way a real IMP's is, because that is the part a parser
// gets wrong: a CPL written by one vendor prefixes everything `cpl:` and another writes a default
// namespace, and an element lookup that matches the qualified name finds neither.
//
// What the tests are actually about is the arithmetic. A resource is a cut - EntryPoint and
// SourceDuration take a span out of a track file, RepeatCount lays it down more than once - and a
// segment lasts as long as its longest sequence, so a short audio track leaves a hole rather than
// pulling the next segment earlier. Getting that wrong desynchronises picture and sound at every cut,
// which is exactly the kind of error that looks fine in a unit test of one segment.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import type { InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacketSink, SubtitleCueSink } from '../../src/media-sink.js';
import { assert, bytesToHexString } from '../../src/misc.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import {
	editUnitsToSeconds,
	imfMarkersOnTimeline,
	parseAssetMap,
	parseCompositionPlaylist,
	parsePackingList,
	resolveImfPackage,
	verifyImfPackage,
} from '../../src/imf/imf-package.js';
import { Sha1, bytesToBase64 } from '../../src/imf/imf-sha1.js';

const VIDEO_FILE = 'urn:uuid:8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51';
const AUDIO_FILE = 'urn:uuid:1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30';
const IMAGE_TRACK = 'urn:uuid:aa11bb22-cc33-dd44-ee55-ff6677889900';
const AUDIO_TRACK = 'urn:uuid:bb22cc33-dd44-ee55-ff66-778899001122';

const assetMapXml = `<?xml version="1.0" encoding="UTF-8"?>
<am:AssetMap xmlns:am="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <am:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000001</am:Id>
  <am:AssetList>
    <am:Asset>
      <am:Id>${VIDEO_FILE.toUpperCase()}</am:Id>
      <am:ChunkList>
        <am:Chunk>
          <am:Path>video.mxf</am:Path>
          <am:VolumeIndex>1</am:VolumeIndex>
          <am:Offset>0</am:Offset>
          <am:Length>123456</am:Length>
        </am:Chunk>
      </am:ChunkList>
    </am:Asset>
    <am:Asset>
      <am:Id>${AUDIO_FILE}</am:Id>
      <am:ChunkList>
        <am:Chunk><am:Path>audio.mxf</am:Path></am:Chunk>
      </am:ChunkList>
    </am:Asset>
  </am:AssetList>
</am:AssetMap>`;

const packingListXml = `<?xml version="1.0" encoding="UTF-8"?>
<PackingList xmlns="http://www.smpte-ra.org/schemas/2067-2/2016/PKL">
  <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000002</Id>
  <AssetList>
    <Asset>
      <Id>${VIDEO_FILE}</Id>
      <Hash>Zm9vYmFyMTIzNA==</Hash>
      <Size>123456</Size>
      <Type>application/mxf</Type>
      <OriginalFileName>video.mxf</OriginalFileName>
    </Asset>
    <Asset>
      <Id>${AUDIO_FILE}</Id>
      <Size>7890</Size>
      <Type>application/mxf</Type>
    </Asset>
  </AssetList>
</PackingList>`;

/** A CPL of two segments; the second has a shorter audio sequence than its image sequence. */
const cplXml = `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000003</Id>
  <Annotation>A two segment composition</Annotation>
  <ContentTitleText>Test Composition</ContentTitleText>
  <EditRate>24000 1001</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:3f1a0000-0000-4000-8000-00000000000a</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:3f1a0000-0000-4000-8000-00000000000b</Id>
          <TrackId>${IMAGE_TRACK}</TrackId>
          <ResourceList>
            <Resource xsi:type="TrackFileResourceType">
              <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000010</Id>
              <IntrinsicDuration>1440</IntrinsicDuration>
              <EntryPoint>24</EntryPoint>
              <SourceDuration>240</SourceDuration>
              <TrackFileId>${VIDEO_FILE}</TrackFileId>
            </Resource>
            <Resource xsi:type="TrackFileResourceType">
              <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000011</Id>
              <IntrinsicDuration>1440</IntrinsicDuration>
              <SourceDuration>120</SourceDuration>
              <RepeatCount>2</RepeatCount>
              <TrackFileId>${VIDEO_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainImageSequence>
        <MainAudioSequence>
          <Id>urn:uuid:3f1a0000-0000-4000-8000-00000000000c</Id>
          <TrackId>${AUDIO_TRACK}</TrackId>
          <ResourceList>
            <Resource xsi:type="TrackFileResourceType">
              <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000012</Id>
              <IntrinsicDuration>480</IntrinsicDuration>
              <TrackFileId>${AUDIO_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainAudioSequence>
      </SequenceList>
    </Segment>
    <Segment>
      <Id>urn:uuid:3f1a0000-0000-4000-8000-00000000000d</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:3f1a0000-0000-4000-8000-00000000000e</Id>
          <TrackId>${IMAGE_TRACK}</TrackId>
          <ResourceList>
            <Resource xsi:type="TrackFileResourceType">
              <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000013</Id>
              <IntrinsicDuration>1440</IntrinsicDuration>
              <SourceDuration>600</SourceDuration>
              <TrackFileId>${VIDEO_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainImageSequence>
        <MainAudioSequence>
          <Id>urn:uuid:3f1a0000-0000-4000-8000-00000000000f</Id>
          <TrackId>${AUDIO_TRACK}</TrackId>
          <ResourceList>
            <Resource xsi:type="TrackFileResourceType">
              <Id>urn:uuid:3f1a0000-0000-4000-8000-000000000014</Id>
              <IntrinsicDuration>480</IntrinsicDuration>
              <SourceDuration>100</SourceDuration>
              <TrackFileId>${AUDIO_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainAudioSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`;

test('the ASSETMAP locates assets, however the UUID was written', () => {
	const assets = parseAssetMap(assetMapXml);

	// The CPL writes it lowercase and the ASSETMAP upper; they are the same asset, and a map keyed by
	// the raw string would simply not find it
	expect([...assets.keys()]).toEqual([
		'8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51',
		'1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30',
	]);
	expect(assets.get('8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51')).toEqual({
		id: '8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51',
		path: 'video.mxf',
		length: 123456,
	});
	// IMF lets a chunk omit its length
	expect(assets.get('1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30')!.length).toBe(null);
});

test('the packing list says what each asset is', () => {
	const pkl = parsePackingList(packingListXml);

	expect(pkl.get('8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51')).toEqual({
		id: '8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51',
		type: 'application/mxf',
		size: 123456,
		hash: 'Zm9vYmFyMTIzNA==',
		hashAlgorithm: null,
		originalFileName: 'video.mxf',
	});
	expect(pkl.get('1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30')!.hash).toBe(null);
});

test('a resource is a cut, and the defaults are the ones IMF states', () => {
	const composition = parseCompositionPlaylist(cplXml);
	const image = composition.tracks.find(track => track.kind === 'image')!;

	// Stated outright: 240 edit units starting 24 into the file
	expect(image.resources[0]).toMatchObject({
		entryPoint: 24,
		sourceDuration: 240,
		repeatCount: 1,
		timelineStart: 0,
		timelineDuration: 240,
	});

	// EntryPoint defaults to 0, RepeatCount to 1 - and a repeat occupies its duration twice over
	expect(image.resources[1]).toMatchObject({
		entryPoint: 0,
		sourceDuration: 120,
		repeatCount: 2,
		timelineStart: 240,
		timelineDuration: 240,
	});
});

test('SourceDuration defaults to the rest of the track file after the entry point', () => {
	const composition = parseCompositionPlaylist(cplXml);
	const audio = composition.tracks.find(track => track.kind === 'audio')!;

	// The first audio resource states neither EntryPoint nor SourceDuration, so it is the whole file
	expect(audio.resources[0]).toMatchObject({
		intrinsicDuration: 480,
		entryPoint: 0,
		sourceDuration: 480,
		timelineStart: 0,
	});
});

test('a segment lasts as long as its longest sequence, so a short track leaves a hole', () => {
	const composition = parseCompositionPlaylist(cplXml);
	const image = composition.tracks.find(track => track.kind === 'image')!;
	const audio = composition.tracks.find(track => track.kind === 'audio')!;

	// Segment one: image runs 480 (240 + 120x2), audio 480. Segment two therefore starts at 480 for
	// BOTH tracks - the audio in segment two is only 100 long, and that hole is the point. A timeline
	// that packed each track end-to-end would start segment two's audio at 480 and its image at 480
	// here by luck, and drift the moment the two differ.
	expect(image.resources[2]!.timelineStart).toBe(480);
	expect(audio.resources[1]!.timelineStart).toBe(480);

	expect(image.duration).toBe(1080); // 480 + 600
	expect(audio.duration).toBe(580); // 480 + 100, and the composition is as long as the longest
	expect(composition.duration).toBe(1080);
});

test('the edit rate is two integers, and converts', () => {
	const composition = parseCompositionPlaylist(cplXml);

	expect(composition.editRate).toEqual({ numerator: 24000, denominator: 1001 });
	// 1080 edit units at 23.976 is 45.045 s, which 1080/24 would put at 45 flat
	expect(editUnitsToSeconds(composition.duration, composition.editRate)).toBeCloseTo(45.045, 6);
	expect(composition.contentTitle).toBe('Test Composition');
	expect(composition.annotation).toBe('A two segment composition');
});

test('the three documents are tied together by UUID, and a gap is named', () => {
	const resolved = resolveImfPackage({
		compositionPlaylist: cplXml,
		assetMap: assetMapXml,
		packingList: packingListXml,
	});

	expect(resolved.paths.get('8979e4cb-3f22-4f41-9bd3-0d3eb1a85a51')).toBe('video.mxf');
	expect(resolved.paths.get('1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30')).toBe('audio.mxf');
	expect(resolved.composition.duration).toBe(1080);

	// An ASSETMAP that does not locate a track file the CPL uses is an incomplete package, and saying
	// which one beats a file-not-found three layers down
	const withoutAudio = assetMapXml.replace(/<am:Asset>\s*<am:Id>urn:uuid:1b6f2b8b[\s\S]*?<\/am:Asset>/, '');
	expect(() => resolveImfPackage({ compositionPlaylist: cplXml, assetMap: withoutAudio }))
		.toThrow(/1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30/);

	// A PKL that does not cover a track file means two deliveries were mixed
	const shortPkl = packingListXml.replace(/<Asset>\s*<Id>urn:uuid:1b6f2b8b[\s\S]*?<\/Asset>/, '');
	expect(() => resolveImfPackage({
		compositionPlaylist: cplXml,
		assetMap: assetMapXml,
		packingList: shortPkl,
	})).toThrow(/more than one delivery/);
});

test('malformed packages are refused by name rather than half-read', () => {
	expect(() => parseAssetMap('<PackingList/>')).toThrow(/expected a <AssetMap> document/);
	expect(() => parseCompositionPlaylist('<AssetMap/>')).toThrow(/expected a <CompositionPlaylist>/);

	// A decimal edit rate is the classic one: 23.976 is not 24000/1001 and never was
	expect(() => parseCompositionPlaylist(cplXml.replace('24000 1001', '23.976')))
		.toThrow(/two positive integers/);

	// Reading past the end of a track file
	const overrun = cplXml.replace(
		'<IntrinsicDuration>1440</IntrinsicDuration>\n              <EntryPoint>24</EntryPoint>',
		'<IntrinsicDuration>100</IntrinsicDuration>\n              <EntryPoint>24</EntryPoint>',
	);
	expect(() => parseCompositionPlaylist(overrun))
		.toThrow(/reads 240 edit units from 24 of a track file that is only 100 long/);

	expect(() => parseCompositionPlaylist(cplXml.replace(/<IntrinsicDuration>1440<\/IntrinsicDuration>/, '')))
		.toThrow(/<IntrinsicDuration> is missing/);

	expect(() => parseAssetMap(assetMapXml.replace('<am:Path>video.mxf</am:Path>', '')))
		.toThrow(/has no <Path>/);

	expect(() => parseAssetMap(assetMapXml.replace('urn:uuid:1b6f2b8b-3a7d-4e4a-8f4e-9c2b1a7d5e30', 'not-a-uuid')))
		.toThrow(/which is not a UUID/);
});

/** A one-segment CPL whose image track is the SHORTER of the two, and whose audio states an entry
 * point but no source duration. Both of those are cases the two-segment fixture above happens not to
 * distinguish: its audio starts at zero, so "the rest of the file" and "the whole file" agree, and its
 * image is the longest track, so "the longest track" and "the first track" agree too. */
const lopsidedCplXml = `<?xml version="1.0" encoding="UTF-8"?>
<cpl:CompositionPlaylist xmlns:cpl="http://www.smpte-ra.org/schemas/2067-3/2016">
  <cpl:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000020</cpl:Id>
  <cpl:EditRate>25 1</cpl:EditRate>
  <cpl:SegmentList>
    <cpl:Segment>
      <cpl:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000021</cpl:Id>
      <cpl:SequenceList>
        <cpl:MainImageSequence>
          <cpl:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000022</cpl:Id>
          <cpl:TrackId>${IMAGE_TRACK}</cpl:TrackId>
          <cpl:ResourceList>
            <cpl:Resource>
              <cpl:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000023</cpl:Id>
              <cpl:IntrinsicDuration>200</cpl:IntrinsicDuration>
              <cpl:SourceDuration>50</cpl:SourceDuration>
              <cpl:TrackFileId>${VIDEO_FILE}</cpl:TrackFileId>
            </cpl:Resource>
          </cpl:ResourceList>
        </cpl:MainImageSequence>
        <cpl:MainAudioSequence>
          <cpl:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000024</cpl:Id>
          <cpl:TrackId>${AUDIO_TRACK}</cpl:TrackId>
          <cpl:ResourceList>
            <cpl:Resource>
              <cpl:Id>urn:uuid:3f1a0000-0000-4000-8000-000000000025</cpl:Id>
              <cpl:IntrinsicDuration>200</cpl:IntrinsicDuration>
              <cpl:EntryPoint>30</cpl:EntryPoint>
              <cpl:TrackFileId>${AUDIO_FILE}</cpl:TrackFileId>
            </cpl:Resource>
          </cpl:ResourceList>
        </cpl:MainAudioSequence>
      </cpl:SequenceList>
    </cpl:Segment>
  </cpl:SegmentList>
</cpl:CompositionPlaylist>`;

test('an omitted SourceDuration is the rest of the file AFTER the entry point', () => {
	const composition = parseCompositionPlaylist(lopsidedCplXml);
	const audio = composition.tracks.find(track => track.kind === 'audio')!;

	// 200 long, entered at 30, so 170 remain - not the 200 that "the whole file" would give. The
	// difference is exactly the entry point, and it is silent: the extra 30 would simply run off the end
	expect(audio.resources[0]).toMatchObject({
		intrinsicDuration: 200,
		entryPoint: 30,
		sourceDuration: 170,
	});
	expect(audio.duration).toBe(170);
});

test('the composition is as long as its longest track, whichever that is', () => {
	const composition = parseCompositionPlaylist(lopsidedCplXml);

	// Image comes first in the CPL and is the shorter of the two
	expect(composition.tracks[0]!.kind).toBe('image');
	expect(composition.tracks[0]!.duration).toBe(50);
	expect(composition.duration, 'the audio outlasts the picture here').toBe(170);
});

test('a prefixed CPL parses the same as a default-namespaced one', () => {
	// Every element above is `cpl:`-prefixed where the main fixture uses a default namespace; a lookup
	// matching the qualified name would find nothing in one of the two
	const composition = parseCompositionPlaylist(lopsidedCplXml);
	expect(composition.editRate).toEqual({ numerator: 25, denominator: 1 });
	expect(composition.tracks).toHaveLength(2);
	expect(composition.tracks.map(track => track.sequenceElement))
		.toEqual(['MainImageSequence', 'MainAudioSequence']);
});

// Everything above is the XML. This builds an actual IMP on disk - an MXF track file written by
// FFmpeg, an ASSETMAP and a CPL - opens it as an `Input`, and checks that what comes out is the span
// the CPL asked for. The MXF is FFmpeg's rather than ours on purpose: if our writer and our reader
// shared a misunderstanding, a round trip through both would not show it.

const hasFfmpeg = () => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const TRACK_FILE = '0d0dba3e-3d53-4a46-9c1e-7f5f0b74dd10';
const IMAGE_TRACK_ID = '4c6e9b1a-2f30-4a5c-8d7e-1b2c3d4e5f60';
const AUDIO_TRACK_ID = '5d7fac2b-3041-4b6d-9e8f-2c3d4e5f6071';

/** An IMP whose single resource cuts `sourceDuration` frames out of the file, `entryPoint` in. */
const writeImp = (dir: string, entryPoint: number, sourceDuration: number, intrinsic: number) => {
	writeFileSync(path.join(dir, 'ASSETMAP.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:11111111-1111-4111-8111-111111111111</Id>
  <AssetList>
    <Asset>
      <Id>urn:uuid:${TRACK_FILE}</Id>
      <ChunkList><Chunk><Path>video.mxf</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>`);

	const cplPath = path.join(dir, 'CPL_test.xml');
	writeFileSync(cplPath, `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:22222222-2222-4222-8222-222222222222</Id>
  <ContentTitleText>Cut test</ContentTitleText>
  <EditRate>25 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:33333333-3333-4333-8333-333333333333</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:44444444-4444-4444-8444-444444444444</Id>
          <TrackId>urn:uuid:${IMAGE_TRACK_ID}</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:55555555-5555-4555-8555-555555555555</Id>
              <IntrinsicDuration>${intrinsic}</IntrinsicDuration>
              <EntryPoint>${entryPoint}</EntryPoint>
              <SourceDuration>${sourceDuration}</SourceDuration>
              <TrackFileId>urn:uuid:${TRACK_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainImageSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`);

	return cplPath;
};

/** Every packet of a track, as (timestamp, byte length, first bytes) - enough to tell two apart. */
const packetsOf = async (track: InputVideoTrack) => {
	const out: { timestamp: number; length: number; head: string }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		out.push({
			timestamp: Number(packet.timestamp.toFixed(6)),
			length: packet.data.byteLength,
			head: bytesToHexString(packet.data.subarray(0, 8)),
		});
	}
	return out;
};

test.skipIf(!hasFfmpeg())('an IMP opens as an Input and yields exactly the cut the CPL asked for', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imp-'));
	try {
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error',
			'-i', new URL('../public/demo.mp4', import.meta.url).pathname,
			'-t', '4', '-an', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p',
			'-y', path.join(dir, 'video.mxf'),
		], { stdio: 'ignore' });

		// Read the track file on its own first: this is the ground truth the composition cuts from
		using whole = new Input({
			source: new FilePathSource(path.join(dir, 'video.mxf')),
			formats: ALL_FORMATS,
		});
		const wholeTrack = (await whole.getPrimaryVideoTrack())!;
		const allPackets = await packetsOf(wholeTrack);
		expect(allPackets.length, 'the MXF holds the whole four seconds').toBeGreaterThan(80);

		// 50 frames starting 25 in: one second into the file, two seconds long, at 25 fps
		const cplPath = writeImp(dir, 25, 50, allPackets.length);

		using composition = new Input({
			source: new FilePathSource(cplPath),
			formats: ALL_FORMATS,
		});

		expect((await composition.getFormat()).name).toBe('Interoperable Master Format (IMF)');
		expect((await composition.getMetadataTags()).title).toBe('Cut test');

		const track = (await composition.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('avc');

		// Everything an InputVideoTrack is asked about the essence, not just the packets. These all
		// reach the backing directly, and a backing that implements only InputTrackBacking throws on
		// the first of them - getDisplayWidth goes through getRotation to getTransformationMatrix,
		// so a composition could not be measured at all without them.
		expect(await track.getCodedWidth()).toBe(await wholeTrack.getCodedWidth());
		expect(await track.getCodedHeight()).toBe(await wholeTrack.getCodedHeight());
		expect(await track.getDisplayWidth()).toBe(await wholeTrack.getDisplayWidth());
		expect(await track.getDisplayHeight()).toBe(await wholeTrack.getDisplayHeight());
		expect(await track.getRotation()).toBe(await wholeTrack.getRotation());
		expect(await track.getColorSpace()).toEqual(await wholeTrack.getColorSpace());
		expect(await track.canBeTransparent()).toBe(await wholeTrack.canBeTransparent());

		const cutPackets = await packetsOf(track);

		// The composition is two seconds, whatever the track file's length
		expect(await composition.computeDuration()).toBeCloseTo(2, 1);

		// What came out has to BE the file's packets from 1 s to 3 s, shifted to start at zero. Compare
		// the bytes, not the count: a cut that read the right number of packets from the wrong place
		// would pass on count alone.
		const expected = allPackets
			.filter(packet => packet.timestamp >= 1 - 1e-6 && packet.timestamp < 3 - 1e-6)
			.map(packet => ({ ...packet, timestamp: Number((packet.timestamp - 1).toFixed(6)) }));

		expect(cutPackets.map(packet => packet.head)).toEqual(expected.map(packet => packet.head));
		expect(cutPackets.map(packet => packet.length)).toEqual(expected.map(packet => packet.length));
		expect(cutPackets.map(packet => packet.timestamp)).toEqual(expected.map(packet => packet.timestamp));

		// And it is genuinely a cut: the composition's first packet is not the file's first packet
		expect(cutPackets[0]!.head).not.toBe(allPackets[0]!.head);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

/** Two cuts from the same track file, laid end to end - which is what a CPL does at an edit. */
const writeTwoCutImp = (dir: string, intrinsic: number) => {
	writeFileSync(path.join(dir, 'ASSETMAP.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:11111111-1111-4111-8111-111111111111</Id>
  <AssetList>
    <Asset>
      <Id>urn:uuid:${TRACK_FILE}</Id>
      <ChunkList><Chunk><Path>video.mxf</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>`);

	const resource = (id: string, entry: number, duration: number) => `
            <Resource>
              <Id>urn:uuid:${id}</Id>
              <IntrinsicDuration>${intrinsic}</IntrinsicDuration>
              <EntryPoint>${entry}</EntryPoint>
              <SourceDuration>${duration}</SourceDuration>
              <TrackFileId>urn:uuid:${TRACK_FILE}</TrackFileId>
            </Resource>`;

	const cplPath = path.join(dir, 'CPL_two.xml');
	writeFileSync(cplPath, `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:66666666-6666-4666-8666-666666666666</Id>
  <EditRate>25 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:77777777-7777-4777-8777-777777777777</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:88888888-8888-4888-8888-888888888888</Id>
          <TrackId>urn:uuid:${IMAGE_TRACK_ID}</TrackId>
          <ResourceList>${
				resource('99999999-9999-4999-8999-999999999991', 25, 25)
			}${
				resource('99999999-9999-4999-8999-999999999992', 75, 20)
			}
          </ResourceList>
        </MainImageSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`);

	return cplPath;
};

test.skipIf(!hasFfmpeg())('two cuts from one file play as one continuous track', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imp2-'));
	try {
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error',
			'-i', new URL('../public/demo.mp4', import.meta.url).pathname,
			'-t', '4', '-an', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p',
			'-y', path.join(dir, 'video.mxf'),
		], { stdio: 'ignore' });

		using whole = new Input({
			source: new FilePathSource(path.join(dir, 'video.mxf')),
			formats: ALL_FORMATS,
		});
		const allPackets = await packetsOf((await whole.getPrimaryVideoTrack())!);

		// Frames 25-49 then 75-94: one second, then 0.8 s taken from later in the same file
		using composition = new Input({
			source: new FilePathSource(writeTwoCutImp(dir, allPackets.length)),
			formats: ALL_FORMATS,
		});
		const track = (await composition.getPrimaryVideoTrack())!;
		const cutPackets = await packetsOf(track);

		const inRange = (from: number, to: number) => allPackets
			.filter(packet => packet.timestamp >= from - 1e-6 && packet.timestamp < to - 1e-6);

		const expected = [
			...inRange(1, 2).map(packet => ({ ...packet, timestamp: Number((packet.timestamp - 1).toFixed(6)) })),
			...inRange(3, 3.8).map(packet => ({ ...packet, timestamp: Number((packet.timestamp - 2).toFixed(6)) })),
		];

		// The join is the point: the reader has to run off the end of the first cut and pick up at the
		// start of the second, which is a second away in the file and backwards in no sense it can see
		expect(cutPackets.map(packet => packet.head)).toEqual(expected.map(packet => packet.head));
		expect(cutPackets.map(packet => packet.timestamp)).toEqual(expected.map(packet => packet.timestamp));
		expect(await composition.computeDuration()).toBeCloseTo(1.8, 2);

		// Seeking into the second cut lands there, not back at the first
		const atSecond = await track._backing.getPacket(1.2, {});
		expect(atSecond).not.toBe(null);
		expect(atSecond!.timestamp).toBeCloseTo(1.2, 2);
		expect(bytesToHexString(atSecond!.data.subarray(0, 8)))
			.toBe(expected.find(packet => Math.abs(packet.timestamp - 1.2) < 1e-6)!.head);

		// And a seek past the end gives the last packet of the LAST cut, which is what a duration
		// computation asks for
		const last = await track._backing.getPacket(Infinity, { metadataOnly: true });
		expect(last!.timestamp).toBeCloseTo(expected[expected.length - 1]!.timestamp, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

/**
 * Two segments where the image track is SHORTER than the audio in the first one. The segment lasts as
 * long as the audio, so the image track has a hole between where its first cut ends and where the
 * second segment begins - which is the case that decides what `getPacket` means in a gap.
 */
const writeHoleImp = (dir: string, intrinsic: number) => {
	writeFileSync(path.join(dir, 'ASSETMAP.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:11111111-1111-4111-8111-111111111111</Id>
  <AssetList>
    <Asset>
      <Id>urn:uuid:${TRACK_FILE}</Id>
      <ChunkList><Chunk><Path>av.mxf</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>`);

	const sequence = (element: string, trackId: string, id: string, entry: number, duration: number) => `
        <${element}>
          <Id>urn:uuid:${id}</Id>
          <TrackId>urn:uuid:${trackId}</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:${id.slice(0, -1)}f</Id>
              <IntrinsicDuration>${intrinsic}</IntrinsicDuration>
              <EntryPoint>${entry}</EntryPoint>
              <SourceDuration>${duration}</SourceDuration>
              <TrackFileId>urn:uuid:${TRACK_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </${element}>`;

	const cplPath = path.join(dir, 'CPL_hole.xml');
	writeFileSync(cplPath, `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</Id>
  <EditRate>25 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1</Id>
      <SequenceList>${
	sequence('MainImageSequence', IMAGE_TRACK_ID, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 0, 25)}${
	sequence('MainAudioSequence', AUDIO_TRACK_ID, 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 0, 50)}
      </SequenceList>
    </Segment>
    <Segment>
      <Id>urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2</Id>
      <SequenceList>${
	sequence('MainImageSequence', IMAGE_TRACK_ID, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 50, 25)}${
	sequence('MainAudioSequence', AUDIO_TRACK_ID, 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 50, 25)}
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`);

	return cplPath;
};

test.skipIf(!hasFfmpeg())('a track with a hole answers a seek into it with the packet before it', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imp3-'));
	try {
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error',
			'-i', new URL('../public/demo.mp4', import.meta.url).pathname,
			'-t', '4', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p',
			'-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2',
			'-y', path.join(dir, 'av.mxf'),
		], { stdio: 'ignore' });

		using whole = new Input({
			source: new FilePathSource(path.join(dir, 'av.mxf')),
			formats: ALL_FORMATS,
		});
		const allPackets = await packetsOf((await whole.getPrimaryVideoTrack())!);

		using composition = new Input({
			source: new FilePathSource(writeHoleImp(dir, allPackets.length)),
			formats: ALL_FORMATS,
		});

		const tracks = await composition.getTracks();
		expect(tracks.map(track => track.type).sort()).toEqual(['audio', 'video']);

		const video = (await composition.getPrimaryVideoTrack())!;

		// Image: one second in segment one, then a second from 2 s. Audio runs two seconds in segment
		// one, so the image track has nothing between 1 s and 2 s.
		const lastBeforeHole = await video._backing.getPacket(0.99, {});
		expect(lastBeforeHole!.timestamp).toBeCloseTo(0.96, 2);

		// Seeking into the hole gives that same packet - the one at or BEFORE the time asked for, which
		// is what a player shows there. Answering with the next cut's first packet would jump a second
		// of composition forward and report a timestamp later than the one requested.
		const inHole = await video._backing.getPacket(1.5, {});
		expect(inHole, 'a hole is not the end of the track').not.toBe(null);
		expect(inHole!.timestamp, 'the packet before the hole, not the one after it')
			.toBeCloseTo(0.96, 2);
		expect(bytesToHexString(inHole!.data.subarray(0, 8)))
			.toBe(bytesToHexString(lastBeforeHole!.data.subarray(0, 8)));

		// And the second segment's image still begins where the segment does, two seconds in
		const afterHole = await video._backing.getPacket(2.04, {});
		expect(afterHole!.timestamp).toBeCloseTo(2.04, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

// ---------------------------------------------------------------------------------------------
// Checking a package whole: SHA-1 by hand, and the verification pass over it.
//
// A packing list exists to answer "did these octets arrive intact". Comparing against the wrong
// algorithm, or hashing only the first chunk, would answer "no" for a perfectly good delivery - so
// the hash is checked against node's own crypto rather than against a value this repo computed.

const sha1Base64 = (bytes: Uint8Array) => {
	const hasher = new Sha1();
	hasher.update(bytes);
	return bytesToBase64(hasher.digest());
};

const bytesOf = (length: number, seed: number) => {
	const data = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		data[i] = (i * 31 + seed) & 0xff;
	}
	return data;
};

test('SHA-1 matches the published vectors, including the one that needs a second padding block', () => {
	const digestOf = (text: string) => {
		const hasher = new Sha1();
		hasher.update(new TextEncoder().encode(text));
		return bytesToHexString(hasher.digest());
	};

	expect(digestOf('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
	expect(digestOf('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
	// 56 octets: too long to pad inside one block, which is the case an implementation gets wrong
	expect(digestOf('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
		.toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
});

test('SHA-1 agrees with node crypto at every length across two block boundaries', () => {
	for (let length = 0; length <= 200; length++) {
		const data = bytesOf(length, length);
		expect(sha1Base64(data), `length ${length}`)
			.toBe(createHash('sha1').update(data).digest('base64'));
	}
});

test('how the octets are chunked cannot change the hash', () => {
	const data = bytesOf(5000, 7);
	const expected = createHash('sha1').update(data).digest('base64');

	for (const size of [1, 63, 64, 65, 127, 999, 5000]) {
		const hasher = new Sha1();
		for (let offset = 0; offset < data.length; offset += size) {
			hasher.update(data.subarray(offset, Math.min(offset + size, data.length)));
		}
		expect(bytesToBase64(hasher.digest()), `chunks of ${size}`).toBe(expected);
	}
});

test('base64 agrees with node, including both padding lengths', () => {
	for (let length = 0; length <= 40; length++) {
		const data = bytesOf(length, 53);
		expect(bytesToBase64(data), `length ${length}`).toBe(Buffer.from(data).toString('base64'));
	}
});

const VERIFY_VIDEO = 'urn:uuid:9a8b7c6d-5e4f-4031-8213-445566778899';
const VERIFY_AUDIO = 'urn:uuid:0f1e2d3c-4b5a-4698-8776-665544332211';
const VERIFY_TRACK = 'urn:uuid:11112222-3333-4444-5555-666677778888';

const verifyAssetMapXml = `<?xml version="1.0" encoding="UTF-8"?>
<am:AssetMap xmlns:am="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <am:Id>urn:uuid:4f1a0000-0000-4000-8000-000000000001</am:Id>
  <am:AssetList>
    <am:Asset>
      <am:Id>${VERIFY_VIDEO}</am:Id>
      <am:ChunkList><am:Chunk><am:Path>video.mxf</am:Path></am:Chunk></am:ChunkList>
    </am:Asset>
    <am:Asset>
      <am:Id>${VERIFY_AUDIO}</am:Id>
      <am:ChunkList><am:Chunk><am:Path>audio.mxf</am:Path></am:Chunk></am:ChunkList>
    </am:Asset>
  </am:AssetList>
</am:AssetMap>`;

const verifyCplXml = `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:4f1a0000-0000-4000-8000-000000000003</Id>
  <EditRate>24 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:4f1a0000-0000-4000-8000-00000000000a</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:4f1a0000-0000-4000-8000-00000000000b</Id>
          <TrackId>${VERIFY_TRACK}</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:4f1a0000-0000-4000-8000-00000000000c</Id>
              <IntrinsicDuration>48</IntrinsicDuration>
              <TrackFileId>${VERIFY_VIDEO}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainImageSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`;

/** The octets each asset is supposed to hold. */
const verifyBytes = {
	'video.mxf': bytesOf(9000, 11),
	'audio.mxf': bytesOf(3000, 29),
};

const verifyPklXml = (overrides: {
	videoHash?: string | null;
	videoSize?: number | null;
	videoAlgorithm?: string;
	audioHash?: string | null;
} = {}) => {
	const videoHash = overrides.videoHash === undefined
		? sha1Base64(verifyBytes['video.mxf'])
		: overrides.videoHash;
	const videoSize = overrides.videoSize === undefined ? verifyBytes['video.mxf'].length : overrides.videoSize;
	const audioHash = overrides.audioHash === undefined
		? sha1Base64(verifyBytes['audio.mxf'])
		: overrides.audioHash;

	return `<?xml version="1.0" encoding="UTF-8"?>
<PackingList xmlns="http://www.smpte-ra.org/schemas/2067-2/2016/PKL">
  <Id>urn:uuid:4f1a0000-0000-4000-8000-000000000002</Id>
  <AssetList>
    <Asset>
      <Id>${VERIFY_VIDEO}</Id>
      ${videoHash === null ? '' : `<Hash>${videoHash}</Hash>`}
      ${overrides.videoAlgorithm ? `<HashAlgorithm Algorithm="${overrides.videoAlgorithm}"/>` : ''}
      ${videoSize === null ? '' : `<Size>${videoSize}</Size>`}
      <Type>application/mxf</Type>
    </Asset>
    <Asset>
      <Id>${VERIFY_AUDIO}</Id>
      ${audioHash === null ? '' : `<Hash>${audioHash}</Hash>`}
      <Size>${verifyBytes['audio.mxf'].length}</Size>
      <Type>application/mxf</Type>
    </Asset>
  </AssetList>
</PackingList>`;
};

/** A source over bytes held in memory, so verification can be driven without touching a disk. */
const openFrom = (bytes: Record<string, Uint8Array | undefined>) => (path: string) => {
	const data = bytes[path];
	if (!data) {
		throw new Error(`no such asset: ${path}`);
	}
	return new BufferSource(data);
};

const verifyWith = async (
	options: { pkl?: string; bytes?: Record<string, Uint8Array | undefined>; chunkSize?: number } = {},
) => {
	const resolved = resolveImfPackage({
		compositionPlaylist: verifyCplXml,
		assetMap: verifyAssetMapXml,
		packingList: options.pkl ?? verifyPklXml(),
	});
	return verifyImfPackage({
		package: resolved,
		open: openFrom(options.bytes ?? verifyBytes),
		...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
	});
};

test('a package whose octets match its packing list verifies, and says what it hashed', async () => {
	const result = await verifyWith();

	expect(result.ok).toBe(true);
	expect(result.assets).toHaveLength(2);

	const video = result.assets.find(asset => asset.path === 'video.mxf')!;
	expect(video.problem).toBe(null);
	expect(video.actualSize).toBe(9000);
	// The control is node's, not ours
	expect(video.actualHash).toBe(createHash('sha1').update(verifyBytes['video.mxf']).digest('base64'));
	expect(video.statedHash).toBe(video.actualHash);
});

test('a single changed octet fails the hash while the size still agrees', async () => {
	const tampered = Uint8Array.from(verifyBytes['video.mxf']);
	tampered[4500] = tampered[4500]! ^ 0x01;

	const result = await verifyWith({ bytes: { ...verifyBytes, 'video.mxf': tampered } });
	const video = result.assets.find(asset => asset.path === 'video.mxf')!;

	expect(result.ok).toBe(false);
	expect(video.actualSize).toBe(video.statedSize);
	expect(video.problem).toMatch(/hash/);
	expect(video.actualHash).not.toBe(video.statedHash);
});

test('a wrong size is reported ALONGSIDE the hash, not instead of it', async () => {
	// Stopping at the first disagreement would leave a report that cannot distinguish a truncated
	// file from a substituted one
	const result = await verifyWith({ pkl: verifyPklXml({ videoSize: 8999 }) });
	const video = result.assets.find(asset => asset.path === 'video.mxf')!;

	expect(result.ok).toBe(false);
	expect(video.problem).toMatch(/states 8999 octets and holds 9000/);
	expect(video.actualHash).toBe(video.statedHash);
});

test('when the size AND the hash are both wrong, the report says both', async () => {
	// Reporting only the first is the difference between "this file is truncated" and "this file is
	// truncated AND is not the file we were sent"
	const result = await verifyWith({
		pkl: verifyPklXml({ videoSize: 8999, videoHash: sha1Base64(bytesOf(9000, 12)) }),
	});
	const video = result.assets.find(asset => asset.path === 'video.mxf')!;

	expect(result.ok).toBe(false);
	expect(video.problem).toMatch(/states 8999 octets and holds 9000/);
	expect(video.problem).toMatch(/octets hash to/);
	expect(video.problem).toMatch(/, and /);
});

test('a hash the octets cannot be checked against is refused, not compared', async () => {
	const result = await verifyWith({
		pkl: verifyPklXml({ videoAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }),
	});
	const video = result.assets.find(asset => asset.id === VERIFY_VIDEO.replace('urn:uuid:', ''))!;

	expect(result.ok).toBe(false);
	expect(video.problem).toMatch(/only SHA-1/);
	// Nothing was read, so nothing is claimed about the octets
	expect(video.actualHash).toBe(null);
	expect(video.actualSize).toBe(null);
});

test('the algorithm is matched on its fragment, since the reference implementation ships a typo', async () => {
	// Netflix photon's default is `http://www.w3.org/2000/09/xmldig#sha1` - xmldig, not xmldsig. A
	// comparison against the whole URI would reject a package that is perfectly fine.
	for (const uri of [
		'http://www.w3.org/2000/09/xmldsig#sha1',
		'http://www.w3.org/2000/09/xmldig#sha1',
		'HTTP://WWW.W3.ORG/2000/09/XMLDSIG#SHA1',
	]) {
		const result = await verifyWith({ pkl: verifyPklXml({ videoAlgorithm: uri }) });
		expect(result.ok, uri).toBe(true);
	}
});

test('an asset the packing list cannot be checked against at all is a problem, not a pass', async () => {
	const result = await verifyWith({ pkl: verifyPklXml({ videoHash: null, videoSize: null }) });
	const video = result.assets.find(asset => asset.path === 'video.mxf')!;

	expect(result.ok).toBe(false);
	expect(video.problem).toMatch(/neither a size nor a hash/);
});

test('an unreadable asset is reported by name rather than failing the whole pass', async () => {
	const result = await verifyWith({ bytes: { 'audio.mxf': verifyBytes['audio.mxf'] } });

	expect(result.ok).toBe(false);
	expect(result.assets.find(asset => asset.path === 'video.mxf')!.problem)
		.toMatch(/could not be opened.*no such asset/);
	// The other asset was still checked
	expect(result.assets.find(asset => asset.path === 'audio.mxf')!.problem).toBe(null);
});

test('the chunk size is a read size, not part of the answer', async () => {
	for (const chunkSize of [1, 7, 4096, 8999, 9000, 1 << 20]) {
		const result = await verifyWith({ chunkSize });
		expect(result.ok, `chunkSize ${chunkSize}`).toBe(true);
	}

	await expect(verifyWith({ chunkSize: 0 })).rejects.toThrow(TypeError);
});

test('verifying without a packing list is refused rather than reported as a pass', async () => {
	const resolved = resolveImfPackage({
		compositionPlaylist: verifyCplXml,
		assetMap: verifyAssetMapXml,
	});

	await expect(verifyImfPackage({ package: resolved, open: openFrom(verifyBytes) }))
		.rejects.toThrow(/was not given a packing list/);
});

// ---------------------------------------------------------------------------------------------
// Markers. ST 2067-3 bounds a marker's Offset by IntrinsicDuration, so it shares its datum with
// EntryPoint rather than with the start of the cut - which means a resource's own trim can throw a
// marker away, and RepeatCount makes one marker happen more than once.

const markerCplXml = (resource: string) => `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:5f1a0000-0000-4000-8000-000000000003</Id>
  <EditRate>24 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:5f1a0000-0000-4000-8000-00000000000a</Id>
      <SequenceList>
        <MarkerSequence>
          <Id>urn:uuid:5f1a0000-0000-4000-8000-00000000000b</Id>
          <TrackId>urn:uuid:99998888-7777-6666-5555-444433332222</TrackId>
          <ResourceList>${resource}</ResourceList>
        </MarkerSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`;

const markerResource = (options: {
	entryPoint?: number;
	sourceDuration?: number;
	repeatCount?: number;
	offsets: number[];
}) => `
  <Resource>
    <Id>urn:uuid:5f1a0000-0000-4000-8000-00000000000c</Id>
    <IntrinsicDuration>100</IntrinsicDuration>
    ${options.entryPoint === undefined ? '' : `<EntryPoint>${options.entryPoint}</EntryPoint>`}
    ${options.sourceDuration === undefined ? '' : `<SourceDuration>${options.sourceDuration}</SourceDuration>`}
    ${options.repeatCount === undefined ? '' : `<RepeatCount>${options.repeatCount}</RepeatCount>`}
    ${options.offsets.map(offset => `
      <Marker>
        <Annotation>marker at ${offset}</Annotation>
        <Label scope="http://www.smpte-ra.org/schemas/2067-3/2013#standard-markers">FFOA</Label>
        <Offset>${offset}</Offset>
      </Marker>`).join('')}
  </Resource>`;

const markerTrackFrom = (resource: string) => {
	const composition = parseCompositionPlaylist(markerCplXml(resource));
	expect(composition.tracks).toHaveLength(1);
	return composition.tracks[0]!;
};

/** The marker CPL's own edit rate, which is what marker positions come back in. */
const MARKER_EDIT_RATE = { numerator: 24, denominator: 1 };

const markersOf = (resource: string) =>
	imfMarkersOnTimeline(markerTrackFrom(resource), MARKER_EDIT_RATE);

test('a marker carries its label, scope, annotation and offset, in offset order', () => {
	const track = markerTrackFrom(markerResource({ offsets: [40, 10, 25] }));

	expect(track.kind).toBe('marker');
	expect(track.resources[0]!.markers.map(marker => marker.offset)).toEqual([10, 25, 40]);
	expect(track.resources[0]!.markers[0]).toEqual({
		label: 'FFOA',
		scope: 'http://www.smpte-ra.org/schemas/2067-3/2013#standard-markers',
		annotation: 'marker at 10',
		offset: 10,
	});
});

test('a marker outside the span its resource uses is trimmed away, not clamped', () => {
	// The cut is [30, 50) of the track file. 10 is before it, 60 after, and 50 is the first offset
	// the cut no longer covers - its exclusive end. Only 40 survives, and it lands 10 edit units
	// into the resource rather than 40.
	const track = markerTrackFrom(
		markerResource({ entryPoint: 30, sourceDuration: 20, offsets: [10, 40, 50, 60] }),
	);

	expect(track.resources[0]!.markers).toHaveLength(4);
	const placed = imfMarkersOnTimeline(track, MARKER_EDIT_RATE);
	expect(placed.map(entry => entry.marker.offset)).toEqual([40]);
	expect(placed[0]!.timelinePosition).toBe(10);

	// Both ends of the span the cut covers: 30 is the entry point itself and lands at 0, 49 is the
	// last offset covered. A bound that excluded either would drop a marker that is on the timeline.
	const edges = markersOf(markerResource({ entryPoint: 30, sourceDuration: 20, offsets: [30, 49] }));
	expect(edges.map(entry => entry.timelinePosition)).toEqual([0, 19]);
});

test('the offset is measured from the track file, so an entry point shifts every marker', () => {
	const withoutEntry = markersOf(markerResource({ offsets: [40] }));
	const withEntry = markersOf(markerResource({ entryPoint: 15, sourceDuration: 50, offsets: [40] }));

	// Same stated offset, 15 edit units earlier on the timeline. Reading Offset as relative to the
	// cut would put both at 40.
	expect(withoutEntry[0]!.timelinePosition).toBe(40);
	expect(withEntry[0]!.timelinePosition).toBe(25);
});

test('a repeated resource repeats its markers, once per repetition', () => {
	const track = markerTrackFrom(
		markerResource({ entryPoint: 0, sourceDuration: 20, repeatCount: 3, offsets: [5] }),
	);
	const placed = imfMarkersOnTimeline(track, MARKER_EDIT_RATE);

	expect(placed.map(entry => entry.timelinePosition)).toEqual([5, 25, 45]);
	expect(placed.map(entry => entry.repetition)).toEqual([0, 1, 2]);
	// The same marker object, not three parses of it
	expect(placed[0]!.marker).toBe(placed[1]!.marker);
});

test('a marker sequence is not a media track, and does not become one', async () => {
	// It carries no essence, so an Input must not report it as something to decode
	const composition = parseCompositionPlaylist(markerCplXml(markerResource({ offsets: [5] })));
	expect(composition.tracks[0]!.kind).toBe('marker');
	expect(composition.tracks[0]!.resources[0]!.trackFileId).toBe(null);
});

test('a <Marker> with no <Label> is refused rather than read as an unlabelled marker', () => {
	const resource = `
  <Resource>
    <Id>urn:uuid:5f1a0000-0000-4000-8000-00000000000c</Id>
    <IntrinsicDuration>100</IntrinsicDuration>
    <Marker><Offset>5</Offset></Marker>
  </Resource>`;

	expect(() => parseCompositionPlaylist(markerCplXml(resource))).toThrow(/states no <Label>/);
});

test('an image resource has no markers, rather than an absent field', () => {
	const composition = parseCompositionPlaylist(verifyCplXml);
	expect(composition.tracks[0]!.resources[0]!.markers).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Per-resource EditRate. ST 2067-3 lets every resource state its own, and an audio resource counts
// in SAMPLES - so a 48 kHz sound track in a 25 fps composition states `48000 1`. Timing it in the
// composition's edit units instead makes it 1920 times too long, which is the shape of bug that
// looks like a sync problem rather than a parse problem.

const mixedRateCplXml = `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:6f1a0000-0000-4000-8000-000000000003</Id>
  <EditRate>25 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:6f1a0000-0000-4000-8000-00000000000a</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:6f1a0000-0000-4000-8000-00000000000b</Id>
          <TrackId>urn:uuid:6f1a1111-0000-4000-8000-000000000001</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:6f1a0000-0000-4000-8000-00000000000c</Id>
              <IntrinsicDuration>50</IntrinsicDuration>
              <TrackFileId>${VERIFY_VIDEO}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainImageSequence>
        <MainAudioSequence>
          <Id>urn:uuid:6f1a0000-0000-4000-8000-00000000000d</Id>
          <TrackId>urn:uuid:6f1a1111-0000-4000-8000-000000000002</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:6f1a0000-0000-4000-8000-00000000000e</Id>
              <EditRate>48000 1</EditRate>
              <IntrinsicDuration>96000</IntrinsicDuration>
              <EntryPoint>1920</EntryPoint>
              <SourceDuration>94080</SourceDuration>
              <TrackFileId>${VERIFY_AUDIO}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainAudioSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`;

test('a resource states its own EditRate, and the durations stay in those units', () => {
	const composition = parseCompositionPlaylist(mixedRateCplXml);
	const [image, audio] = composition.tracks;

	// The image resource inherits the composition's rate, since it states none
	expect(image!.resources[0]!.editRate).toEqual({ numerator: 25, denominator: 1 });
	// The audio resource counts in samples, and its own figures are left in samples
	expect(audio!.resources[0]!.editRate).toEqual({ numerator: 48000, denominator: 1 });
	expect(audio!.resources[0]!.entryPoint).toBe(1920);
	expect(audio!.resources[0]!.sourceDuration).toBe(94080);
});

test('a resource at a different edit rate is converted onto the composition timeline', () => {
	const composition = parseCompositionPlaylist(mixedRateCplXml);
	const [image, audio] = composition.tracks;

	// 94080 samples at 48 kHz is 1.96 s, which is 49 frames at 25 fps - NOT 94080 frames
	expect(audio!.resources[0]!.timelineDuration).toBe(49);
	expect(audio!.duration).toBe(49);
	expect(image!.resources[0]!.timelineDuration).toBe(50);

	// Both tracks come out the same length in seconds, which is the only thing a player cares about
	expect(editUnitsToSeconds(audio!.duration, composition.editRate)).toBeCloseTo(1.96, 9);
	expect(editUnitsToSeconds(image!.duration, composition.editRate)).toBeCloseTo(2, 9);
	// And the segment is as long as the longer of them
	expect(composition.duration).toBe(50);
});

test('a marker on a resource at another edit rate is placed in composition units', () => {
	// 24 fps composition, a resource counting in 48 kHz samples: a marker 2400 samples in is 0.05 s,
	// which is 1.2 frames. Adding the raw offset would place it 2400 frames in.
	const resource = `
  <Resource>
    <Id>urn:uuid:5f1a0000-0000-4000-8000-00000000000c</Id>
    <EditRate>48000 1</EditRate>
    <IntrinsicDuration>96000</IntrinsicDuration>
    <Marker>
      <Label scope="x">FFOA</Label>
      <Offset>2400</Offset>
    </Marker>
  </Resource>`;

	const placed = markersOf(resource);
	expect(placed).toHaveLength(1);
	expect(placed[0]!.timelinePosition).toBeCloseTo(1.2, 9);
});

/**
 * An IMP whose audio resource counts in samples while its image resource counts in frames, which is
 * what a real package looks like and the only arrangement in which the two edit rates can disagree.
 */
const writeMixedRateImp = (
	dir: string,
	imageFrames: number,
	audioSamples: number,
	audioEntryPoint = 48000,
) => {
	const file = '77777777-7777-4777-8777-777777777777';
	const audioFile = '76767676-7676-4767-8767-676767676767';
	writeFileSync(path.join(dir, 'ASSETMAP.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:88888888-8888-4888-8888-888888888888</Id>
  <AssetList>
    <Asset>
      <Id>urn:uuid:${file}</Id>
      <ChunkList><Chunk><Path>video.mxf</Path></Chunk></ChunkList>
    </Asset>
    <Asset>
      <Id>urn:uuid:${audioFile}</Id>
      <ChunkList><Chunk><Path>audio.wav</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>`);

	const cplPath = path.join(dir, 'CPL_mixed.xml');
	writeFileSync(cplPath, `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:99999999-9999-4999-8999-999999999999</Id>
  <ContentTitleText>Mixed rate</ContentTitleText>
  <EditRate>25 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</Id>
      <SequenceList>
        <MainImageSequence>
          <Id>urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb</Id>
          <TrackId>urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:dddddddd-dddd-4ddd-8ddd-dddddddddddd</Id>
              <IntrinsicDuration>${imageFrames}</IntrinsicDuration>
              <EntryPoint>25</EntryPoint>
              <SourceDuration>25</SourceDuration>
              <TrackFileId>urn:uuid:${file}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainImageSequence>
        <MainAudioSequence>
          <Id>urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee</Id>
          <TrackId>urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:12121212-1212-4121-8121-121212121212</Id>
              <EditRate>48000 1</EditRate>
              <IntrinsicDuration>${audioSamples}</IntrinsicDuration>
              <EntryPoint>${audioEntryPoint}</EntryPoint>
              <SourceDuration>48000</SourceDuration>
              <TrackFileId>urn:uuid:${audioFile}</TrackFileId>
            </Resource>
          </ResourceList>
        </MainAudioSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`);

	return cplPath;
};

test.skipIf(!hasFfmpeg())('an audio resource counting in samples is cut where the CPL says', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imp-mixed-'));
	try {
		// 25 fps picture and 48 kHz sound in separate track files, so the audio resource's edit rate is
		// 1920 times the composition's. Timing its EntryPoint in composition units would place the cut
		// 1920 seconds into a four-second file.
		//
		// The sound is a WAV rather than an MXF only because ffmpeg will not write an audio-only MXF,
		// and an interleaved A/V MXF trips a separate defect in our own MXF index reader. Nothing here
		// depends on the container: what is under test is which edit rate the cut is measured in.
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error',
			'-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4',
			'-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p',
			'-y', path.join(dir, 'video.mxf'),
		], { stdio: 'ignore' });
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error',
			'-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
			'-c:a', 'pcm_s16le', '-y', path.join(dir, 'audio.wav'),
		], { stdio: 'ignore' });

		using whole = new Input({
			source: new FilePathSource(path.join(dir, 'audio.wav')),
			formats: ALL_FORMATS,
		});
		const wholeAudio = (await whole.getPrimaryAudioTrack())!;
		expect(await wholeAudio.getSampleRate()).toBe(48000);

		// Every packet of the file that carries any of [1 s, 2 s) - which includes the one straddling
		// the cut, since an audio cut does not land on a packet boundary
		const wholeSink = new EncodedPacketSink(wholeAudio);
		const expected: string[] = [];
		for await (const packet of wholeSink.packets()) {
			const overlaps = packet.timestamp + packet.duration > 1 + 1e-9 && packet.timestamp < 2 - 1e-9;
			if (overlaps) {
				expected.push(bytesToHexString(packet.data.subarray(0, 8)));
			}
		}
		expect(expected.length, 'the file holds a second of audio from 1 s').toBeGreaterThan(0);

		const cplPath = writeMixedRateImp(dir, 100, 192000);
		using composition = new Input({ source: new FilePathSource(cplPath), formats: ALL_FORMATS });

		const audio = (await composition.getPrimaryAudioTrack())!;
		// The audio backing has to answer these; without them an InputAudioTrack on this throws
		expect(await audio.getSampleRate()).toBe(48000);
		expect(await audio.getNumberOfChannels()).toBe(1);

		const got: string[] = [];
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(audio).packets()) {
			got.push(bytesToHexString(packet.data.subarray(0, 8)));
			timestamps.push(packet.timestamp);
		}

		// The same audio, byte for byte, as the file holds from one second in - not silence, not the
		// start of the file, and not nothing
		expect(got).toEqual(expected);
		// The straddling packet begins before the cut, so it is yielded at a negative timestamp rather
		// than trimmed or dropped - the same convention as audio priming
		expect(timestamps[0]!).toBeLessThanOrEqual(0);
		expect(timestamps[1]!).toBeGreaterThan(0);
		// One second of audio, 48000 samples, which is 25 frames at the composition's rate
		expect(await audio.computeDuration()).toBeCloseTo(1, 1);

		// Now the other boundary: our PCM packets are 2048 samples, so an entry point at a multiple of
		// 2048 lands exactly ON a packet boundary and nothing straddles the cut. The packet that ENDS
		// there carries only audio from before the cut, so including it would prepend a packet of sound
		// the composition does not contain - and the first packet must sit exactly at zero rather than
		// below it.
		const alignedPath = writeMixedRateImp(dir, 100, 192000, 2048 * 24);
		using aligned = new Input({ source: new FilePathSource(alignedPath), formats: ALL_FORMATS });
		const alignedAudio = (await aligned.getPrimaryAudioTrack())!;

		const alignedStamps: number[] = [];
		for await (const packet of new EncodedPacketSink(alignedAudio).packets()) {
			alignedStamps.push(packet.timestamp);
		}
		expect(alignedStamps[0]).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

// A subtitle resource is a CUT, exactly as an image one is: the document covers the whole track file
// and the composition takes a span out of it. The cues inside carry FILE times, so a reader that
// hands them over unshifted puts every subtitle at the wrong place in the composition - and one that
// forgets to clip shows cues the composition never reaches.

const SUBTITLE_TRACK_FILE = '9a7f1c2d-55b6-4e8a-91cd-3f0e6b8a7d41';
const SUBTITLE_TRACK_ID = '7e5d4c3b-2a19-4867-9f0e-1d2c3b4a5968';

/** One `<Resource>` of a subtitle sequence, in the document's own edit units. */
const subtitleResource = (
	id: string,
	entryPoint: number,
	sourceDuration: number,
	repeatCount: number,
) => `
            <Resource>
              <Id>urn:uuid:${id}</Id>
              <EditRate>24000 1001</EditRate>
              <IntrinsicDuration>6240</IntrinsicDuration>
              <EntryPoint>${entryPoint}</EntryPoint>
              <SourceDuration>${sourceDuration}</SourceDuration>
              <RepeatCount>${repeatCount}</RepeatCount>
              <TrackFileId>urn:uuid:${SUBTITLE_TRACK_FILE}</TrackFileId>
            </Resource>`;

/** An IMP whose only sequence is subtitles, with the resources given, in the file's own edit rate. */
const writeSubtitleResources = (
	dir: string,
	resources: { entryPoint: number; sourceDuration: number; repeatCount?: number }[],
) => {
	copyFileSync(
		new URL('../public/imf-timed-text.mxf', import.meta.url).pathname,
		path.join(dir, 'subs.mxf'),
	);

	writeFileSync(path.join(dir, 'ASSETMAP.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:11111111-1111-4111-8111-111111111113</Id>
  <AssetList>
    <Asset>
      <Id>urn:uuid:${SUBTITLE_TRACK_FILE}</Id>
      <ChunkList><Chunk><Path>subs.mxf</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>`);

	const cplPath = path.join(dir, 'CPL_subs_multi.xml');
	writeFileSync(cplPath, `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:22222222-2222-4222-8222-222222222224</Id>
  <ContentTitleText>Subtitle resources</ContentTitleText>
  <EditRate>24000 1001</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:33333333-3333-4333-8333-333333333335</Id>
      <SequenceList>
        <SubtitlesSequence>
          <Id>urn:uuid:44444444-4444-4444-8444-444444444446</Id>
          <TrackId>urn:uuid:${SUBTITLE_TRACK_ID}</TrackId>
          <ResourceList>${resources.map((resource, index) => subtitleResource(
				`5555555${index}-5555-4555-8555-55555555555${index}`,
				resource.entryPoint,
				resource.sourceDuration,
				resource.repeatCount ?? 1,
			)).join('')}
          </ResourceList>
        </SubtitlesSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`);

	return cplPath;
};

/** An IMP whose only sequence is subtitles, cutting `[entry, entry + duration)` out of the document. */
const writeSubtitleImp = (dir: string, entryPoint: number, sourceDuration: number, repeatCount = 1) => {
	copyFileSync(
		new URL('../public/imf-timed-text.mxf', import.meta.url).pathname,
		path.join(dir, 'subs.mxf'),
	);

	writeFileSync(path.join(dir, 'ASSETMAP.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:11111111-1111-4111-8111-111111111112</Id>
  <AssetList>
    <Asset>
      <Id>urn:uuid:${SUBTITLE_TRACK_FILE}</Id>
      <ChunkList><Chunk><Path>subs.mxf</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>`);

	const cplPath = path.join(dir, 'CPL_subs.xml');
	writeFileSync(cplPath, `<?xml version="1.0" encoding="UTF-8"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
  <Id>urn:uuid:22222222-2222-4222-8222-222222222223</Id>
  <ContentTitleText>Subtitle cut test</ContentTitleText>
  <EditRate>1 1</EditRate>
  <SegmentList>
    <Segment>
      <Id>urn:uuid:33333333-3333-4333-8333-333333333334</Id>
      <SequenceList>
        <SubtitlesSequence>
          <Id>urn:uuid:44444444-4444-4444-8444-444444444445</Id>
          <TrackId>urn:uuid:${SUBTITLE_TRACK_ID}</TrackId>
          <ResourceList>
            <Resource>
              <Id>urn:uuid:55555555-5555-4555-8555-555555555556</Id>
              <EditRate>1 1</EditRate>
              <IntrinsicDuration>300</IntrinsicDuration>
              <EntryPoint>${entryPoint}</EntryPoint>
              <SourceDuration>${sourceDuration}</SourceDuration>
              <RepeatCount>${repeatCount}</RepeatCount>
              <TrackFileId>urn:uuid:${SUBTITLE_TRACK_FILE}</TrackFileId>
            </Resource>
          </ResourceList>
        </SubtitlesSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`);

	return cplPath;
};

const cuesOf = async (cplPath: string) => {
	using input = new Input({ source: new FilePathSource(cplPath), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	const track = tracks[0]!;
	expect(track.type).toBe('subtitle');
	expect(track.isSubtitleTrack()).toBe(true);
	assert(track.isSubtitleTrack());

	const out: { timestamp: number; duration: number; text: string }[] = [];
	for await (const cue of new SubtitleCueSink(track).cues()) {
		out.push({
			timestamp: Number(cue.timestamp.toFixed(4)),
			duration: Number(cue.duration.toFixed(4)),
			text: cue.text,
		});
	}
	return out;
};

test('a subtitles sequence is a track, and its cues are the whole document uncut', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imf-subs-'));
	try {
		// The document runs to 255.255 s; a cut of [0, 300) takes all of it
		const cues = await cuesOf(writeSubtitleImp(dir, 0, 300));

		expect(cues).toHaveLength(36);
		expect(cues[0]!.timestamp).toBeCloseTo(216 * 1001 / 24000, 3);
		expect(cues[cues.length - 1]!.timestamp).toBeCloseTo(255.255, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

test('a cut drops the cues outside it and shifts the rest onto the composition', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imf-subs-'));
	try {
		// EntryPoint 60 s, SourceDuration 30 s: the composition is 30 s long and shows what the document
		// has between 60 and 90 s, starting at zero
		const cues = await cuesOf(writeSubtitleImp(dir, 60, 30));
		const whole = await cuesOf(writeSubtitleImp(dir, 0, 300));

		const expected = whole.filter(cue => cue.timestamp + cue.duration > 60 && cue.timestamp < 90);
		expect(expected.length).toBeGreaterThan(2);
		expect(cues).toHaveLength(expected.length);

		// Every cue moved down by exactly the entry point, and none sits outside the composition
		for (const [index, cue] of cues.entries()) {
			expect(cue.timestamp).toBeCloseTo(Math.max(expected[index]!.timestamp, 60) - 60, 3);
			expect(cue.timestamp).toBeGreaterThanOrEqual(-1e-6);
			expect(cue.timestamp).toBeLessThan(30 + 1e-6);
			expect(cue.text).toBe(expected[index]!.text);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

/** Every packet of a subtitle track, as (start, end) on the composition, to three decimals. */
const subtitlePacketsOf = async (cplPath: string) => {
	using input = new Input({ source: new FilePathSource(cplPath), formats: ALL_FORMATS });
	const track = (await input.getTracks())[0]!;
	assert(track.isSubtitleTrack());

	const out: [number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		out.push([
			Number(packet.timestamp.toFixed(3)),
			Number((packet.timestamp + packet.duration).toFixed(3)),
		]);
	}
	return out;
};

test('every resource of a subtitle sequence is read, not only the first', async () => {
	// A clip-wrapped document is ONE element covering the whole track file, so its packet starts at
	// file time 0 whatever the entry point is. Asking whether it STARTS inside the cut answers no for
	// every cut but one beginning at zero, which left each later resource reading as empty.
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imf-subs-'));
	try {
		const unit = 1001 / 24000;
		// Both cuts chosen to contain cues: the document's first is at 9.009 s, so a cut of
		// [0, 168) edit units - the first seven seconds - holds none at all, and asserting on it would
		// be asserting on the document rather than on the reader
		const cpl = writeSubtitleResources(dir, [
			{ entryPoint: 288, sourceDuration: 168 },
			{ entryPoint: 576, sourceDuration: 168 },
		]);

		const packets = await subtitlePacketsOf(cpl);
		expect(packets).toHaveLength(2);
		// Each cut is 168 edit units long and they abut on the composition
		expect(packets[0]![1] - packets[0]![0]).toBeCloseTo(168 * unit, 2);
		expect(packets[1]![0]).toBeCloseTo(168 * unit, 2);
		expect(packets[1]![1]).toBeCloseTo(336 * unit, 2);

		// And the cues of BOTH cuts come out, each shifted onto its own cut
		const cues = await cuesOf(cpl);
		const first = cues.filter(cue => cue.timestamp < 168 * unit);
		const second = cues.filter(cue => cue.timestamp >= 168 * unit);
		expect(first.length).toBeGreaterThan(0);
		expect(second.length).toBeGreaterThan(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

test('a repeated cut yields one packet per repeat, each ending at its own end', async () => {
	// RepeatCount lays the same cut down more than once. A packet bounded by the whole placement
	// instead of by its own repeat claims every repeat at once, and a consumer sees one subtitle
	// packet covering twice the span it should.
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imf-subs-'));
	try {
		const unit = 1001 / 24000;
		const packets = await subtitlePacketsOf(
			writeSubtitleResources(dir, [{ entryPoint: 288, sourceDuration: 168, repeatCount: 2 }]),
		);

		expect(packets).toHaveLength(2);
		for (const [index, [, end]] of packets.entries()) {
			// Each repeat ends 168 edit units after the repeat began, not after the placement did
			expect(end).toBeCloseTo((index + 1) * 168 * unit, 2);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

test('a clamped packet states where its cut opens in the track file', async () => {
	// The clamp places a clip-wrapped packet at the cut's start, which is right for ordering and
	// wrong for anyone parsing the payload: an IMSC document states each cue's time against the FILE,
	// and once the packet no longer carries the shift, nothing relates the two. `sourceTimestamp` is
	// that missing half - a consumer adds a payload time to `timestamp - sourceTimestamp`.
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imf-subs-'));
	try {
		const unit = 1001 / 24000;
		using input = new Input({
			source: new FilePathSource(writeSubtitleResources(dir, [
				{ entryPoint: 288, sourceDuration: 168 },
				{ entryPoint: 1080, sourceDuration: 72, repeatCount: 2 },
			])),
			formats: ALL_FORMATS,
		});
		const track = (await input.getTracks())[0]!;
		assert(track.isSubtitleTrack());

		const seen: { timestamp: number; source: number | undefined }[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			seen.push({ timestamp: packet.timestamp, source: packet.sideData.sourceTimestamp });
		}

		expect(seen).toHaveLength(3);
		// Each cut opens where its own entry point is, whatever the composition placed it at
		expect(seen[0]!.source).toBeCloseTo(288 * unit, 4);
		expect(seen[1]!.source).toBeCloseTo(1080 * unit, 4);
		// The second repeat opens at the SAME file time as the first: a repeat replays one span
		expect(seen[2]!.source).toBeCloseTo(1080 * unit, 4);

		// `timestamp - sourceTimestamp` is the shift a payload time needs, and it differs per cut and
		// per repeat - which is the whole reason a single clamped timestamp cannot stand in for it
		const shifts = seen.map(({ timestamp, source }) => Number((timestamp - source!).toFixed(4)));
		expect(shifts).toEqual([
			Number((0 - 288 * unit).toFixed(4)),
			Number((168 * unit - 1080 * unit).toFixed(4)),
			Number((240 * unit - 1080 * unit).toFixed(4)),
		]);

		// Applied to a real cue: the document's cue at 45.045 s falls in the second cut, and the shift
		// puts it where the sink independently reports it
		const cues = await cuesOf(writeSubtitleResources(dir, [
			{ entryPoint: 288, sourceDuration: 168 },
			{ entryPoint: 1080, sourceDuration: 72, repeatCount: 2 },
		]));
		const viaShift = 45.045 + (seen[1]!.timestamp - seen[1]!.source!);
		expect(cues.some(cue => Math.abs(cue.timestamp - viaShift) < 0.002)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!hasFfmpeg())('a frame-wrapped packet states its own place in the track file', async () => {
	// For a clip-wrapped payload the packet's timestamp is always the cut's start, so
	// `sourceTimestamp` and the cut's entry point coincide and a reader cannot tell a correct
	// implementation from one that just reports the entry point. Frame-wrapped essence separates them:
	// each packet sits further into the file than the one before it.
	const dir = mkdtempSync(path.join(tmpdir(), 'mediabunny-imp-src-'));
	try {
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error',
			'-i', new URL('../public/demo.mp4', import.meta.url).pathname,
			'-t', '4', '-an', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p',
			'-y', path.join(dir, 'video.mxf'),
		], { stdio: 'ignore' });

		// What the track file itself says, which is the ground truth for a source time
		using whole = new Input({
			source: new FilePathSource(path.join(dir, 'video.mxf')),
			formats: ALL_FORMATS,
		});
		const fileTimes: number[] = [];
		for await (const packet of new EncodedPacketSink((await whole.getPrimaryVideoTrack())!).packets()) {
			fileTimes.push(Number(packet.timestamp.toFixed(6)));
		}
		expect(fileTimes.length).toBeGreaterThan(80);

		// A cut starting one second in, so a correct source time is never the cut's own start
		const cplPath = writeImp(dir, 25, 50, fileTimes.length);
		using input = new Input({ source: new FilePathSource(cplPath), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;

		const sources: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			expect(packet.sideData.sourceTimestamp).toBeDefined();
			sources.push(Number(packet.sideData.sourceTimestamp!.toFixed(6)));
		}

		expect(sources.length).toBe(50);
		// Each one is a real packet time from the file, and they are the fifty starting at edit unit 25
		expect(sources).toEqual(fileTimes.slice(25, 75));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 300_000);
