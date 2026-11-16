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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import type { InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { bytesToHexString } from '../../src/misc.js';
import { FilePathSource } from '../../src/source.js';
import {
	editUnitsToSeconds,
	parseAssetMap,
	parseCompositionPlaylist,
	parsePackingList,
	resolveImfPackage,
} from '../../src/imf/imf-package.js';

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
