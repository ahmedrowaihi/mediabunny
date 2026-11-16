/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The read side of timed events: a splice or a tag written into a stream has to come back out of it,
// and out of a *segmented* stream on the composition timeline rather than the segment's own.
//
// A segment is read through an `Input` of its own, one per segment and cached only a few deep, so an
// event announced there reaches nobody unless it is passed up - and a segment re-read after its Input
// was evicted announces a second time unless the dedupe outlives that Input.

import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { CmafOutputFormat, DashOutputFormat, HlsOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { Conversion } from '../../src/conversion.js';
import { addId3Metadata, ID3_EMSG_SCHEME } from '../../src/mpeg-ts/id3-output.js';
import { addScte35Section } from '../../src/mpeg-ts/scte35-output.js';
import { bytesToBase64, bytesToHexString } from '../../src/misc.js';
import { Logging } from '../../src/logging.js';
import { parseMpd } from '../../src/dash/dash-mpd-parser.js';
import { serializeMpd } from '../../src/dash/dash-mpd-serializer.js';
import type { InbandEvent } from '../../src/input.js';

const AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);
const AVC_METADATA: EncodedVideoChunkMetadata = {
	decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 },
};

/**
 * A time handed to `addId3Metadata` or `addScte35Section` is on the same timeline as the media added
 * beside it, so an event written at `t` is read back at `t`. The output shifts both by
 * `mediaTimestampBase` on the way out, and the reader's composition timeline starts at the first
 * segment, so the shift cancels.
 */
const MEDIA_BASE = 0;

/**
 * Where the output's own media timeline begins: `mediaTimestampBase` defaults to 10. A time a payload
 * *carries* - an SCTE-35 section's `splice_time` - is on that clock, because that is the clock a
 * receiver reads the section against; only a time the caller *states* is on the media timeline above.
 */
const STREAM_BASE = 10;
const SCTE35_PID = 0x1f00;
const ID3_PID = 0x1f10;

const id3Tag = (text: string) => {
	const body = [0x03, ...[...text].map(c => c.charCodeAt(0)), 0];
	const frame = [0x54, 0x58, 0x58, 0x58, 0, 0, 0, body.length, 0, 0, ...body];
	return new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, frame.length, ...frame]);
};

/** A minimal well-formed `splice_info_section` carrying a `time_signal` at a 90 kHz tick. */
const spliceSection = (spliceTime: number) => {
	const bits33 = (value: number, leadingFlags: number) => [
		leadingFlags | (Math.floor(value / 2 ** 32) & 1),
		(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
	];
	const command = bits33(spliceTime, 0xfe);
	const body = [
		0,
		...bits33(0, 0x00),
		0xff,
		0, 0,
		command.length,
		0x06, // time_signal
		...command,
		0, 0,
	];
	const length = body.length + 4;
	return Uint8Array.from([0xfc, 0x30 | ((length >> 8) & 0x0f), length & 0xff, ...body, 0, 0, 0, 0]);
};

/** Writes an HLS presentation into memory and serves it back by file name. */
const writeFiles = async (options: {
	segmentFormat: 'cmaf' | 'mpeg-ts';
	write?: (output: Output) => void;
	segmentCount?: number;
}) => {
	const files = new Map<string, Uint8Array>();
	const segmentCount = options.segmentCount ?? 4;

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: options.segmentFormat === 'cmaf'
				? new CmafOutputFormat()
				: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID, timedMetadataPid: ID3_PID }),
			targetDuration: 1,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	options.write?.(output);
	for (let i = 0; i < segmentCount * 2; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	return files;
};

const sourceOf = (files: Map<string, Uint8Array>) =>
	new CustomPathedSource('master.m3u8', ({ path }) => {
		const name = path.split('/').pop() ?? path;
		const body = files.get(name);
		if (!body) {
			throw new Error(`No such file in the written presentation: ${path}`);
		}
		return new BufferSource(body);
	});

/** Reads every packet of every track, which is what makes a reader walk past the event boxes. */
const readThrough = async (input: Input) => {
	const events: InbandEvent[] = [];
	input.on('inbandEvent', event => void events.push(event));

	for (const track of await input.getTracks()) {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
		}
	}

	return events;
};

test('an ID3 tag written into a CMAF presentation comes back on the composition timeline', async () => {
	const tag = id3Tag('cmaf');
	const files = await writeFiles({
		segmentFormat: 'cmaf',
		write: output => addId3Metadata(output, { time: MEDIA_BASE + 1.5, data: tag }),
	});

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);

	expect(events).toHaveLength(1);
	expect(events[0]!.scheme).toBe(ID3_EMSG_SCHEME);
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(tag));
	// The box states a delta from its segment's start; what comes out is the time it was written at
	expect(events[0]!.timestamp).toBeCloseTo(1.5, 2);
}, 300_000);

test('a cue section written into a transport-stream presentation comes back with its splice time', async () => {
	const section = spliceSection((STREAM_BASE + 1.5) * 90_000);
	const files = await writeFiles({
		segmentFormat: 'mpeg-ts',
		write: output => addScte35Section(output, section),
	});

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);

	expect(events).toHaveLength(1);
	expect(events[0]!.scheme).toBe('urn:scte:scte35:2013:bin');
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(section));
	// The splice time the section itself states, mapped onto the timeline the reader hands out - not
	// the position the section happened to be written at
	expect(events[0]!.timestamp).toBeCloseTo(1.5, 2);
}, 300_000);

test('a presentation read twice announces each event once', async () => {
	// More segments than the per-segment Input cache holds, so the Input that carries the tag is evicted
	// between passes and rebuilt - which resets the dedupe the demuxer keeps for its own lifetime
	const files = await writeFiles({
		segmentFormat: 'cmaf',
		segmentCount: 10,
		write: output => addId3Metadata(output, { time: MEDIA_BASE + 1.5, data: id3Tag('once') }),
	});

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events: InbandEvent[] = [];
	input.on('inbandEvent', event => void events.push(event));

	const track = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(track);
	for (let pass = 0; pass < 3; pass++) {
		for await (const packet of sink.packets()) {
			void packet;
		}
	}

	expect(events).toHaveLength(1);
}, 300_000);

test('a presentation carrying no events announces none', async () => {
	const files = await writeFiles({ segmentFormat: 'cmaf' });

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	expect(await readThrough(input)).toHaveLength(0);
}, 300_000);

test('a tag in a later segment is dated by that segment, not the first', async () => {
	// Each segment's emsg states a delta from its own start, so a reader that forgot which segment it
	// came from reports every event in the first second
	const files = await writeFiles({
		segmentFormat: 'cmaf',
		segmentCount: 6,
		write: (output) => {
			addId3Metadata(output, { time: MEDIA_BASE + 0.5, data: id3Tag('early') });
			addId3Metadata(output, { time: MEDIA_BASE + 4.5, data: id3Tag('late') });
		},
	});

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);

	expect(events).toHaveLength(2);
	const times = events.map(event => event.timestamp!).sort((a, b) => a - b);
	expect(times[0]).toBeCloseTo(0.5, 2);
	expect(times[1]).toBeCloseTo(4.5, 2);
}, 300_000);

test('a DASH presentation passes its events up too', async () => {
	// The same mechanism, wired separately: DASH builds its own per-segment Inputs
	const tag = id3Tag('dash');
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			mpdPath: 'manifest.mpd',
		}),
		target: new PathedTarget('manifest.mpd', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	addId3Metadata(output, { time: MEDIA_BASE + 2.5, data: tag });
	for (let i = 0; i < 8; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	using input = new Input({
		source: new CustomPathedSource('manifest.mpd', ({ path }) => {
			const name = path.split('/').pop() ?? path;
			const body = files.get(name);
			if (!body) {
				throw new Error(`No such file in the written presentation: ${path}`);
			}
			return new BufferSource(body);
		}),
		formats: ALL_FORMATS,
	});
	const events = await readThrough(input);

	expect(events).toHaveLength(1);
	expect(events[0]!.scheme).toBe(ID3_EMSG_SCHEME);
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(tag));
	expect(events[0]!.timestamp).toBeCloseTo(2.5, 2);
}, 300_000);

test('a multi-fragment file announces the boxes between its fragments', async () => {
	// An HLS presentation's init and media segments joined back into one file: several fragments, each
	// with an emsg ahead of it. Only the first is reachable while reading metadata - that walk stops at
	// the first moof - so the rest are found by the scan that walks forward looking for packets.
	const files = await writeFiles({
		segmentFormat: 'cmaf',
		segmentCount: 6,
		write: (output) => {
			addId3Metadata(output, { time: MEDIA_BASE + 0.5, data: id3Tag('first') });
			addId3Metadata(output, { time: MEDIA_BASE + 2.5, data: id3Tag('third') });
			addId3Metadata(output, { time: MEDIA_BASE + 4.5, data: id3Tag('fifth') });
		},
	});

	const named = [...files.entries()].filter(([name]) => name.endsWith('.mp4') || name.endsWith('.m4s'));
	// Init first, then the media segments in the order they were written
	const parts = named.map(([, body]) => body);
	const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		joined.set(part, at);
		at += part.length;
	}

	using input = new Input({ source: new BufferSource(joined.buffer), formats: ALL_FORMATS });
	const events = await readThrough(input);

	expect(events).toHaveLength(3);
	const times = events.map(event => event.timestamp!).sort((a, b) => a - b);
	// The file's own timeline, which mediaTimestampBase put at 10 - this is one file rather than a
	// presentation, so nothing maps it back down to the first segment
	expect(times[0]).toBeCloseTo(STREAM_BASE + 0.5, 2);
	expect(times[1]).toBeCloseTo(STREAM_BASE + 2.5, 2);
	expect(times[2]).toBeCloseTo(STREAM_BASE + 4.5, 2);
}, 300_000);

test('a splice a CMAF playlist carries only as a date range is announced with its time', async () => {
	// CMAF segments have no cue stream, so the playlist marker is the whole signal - lose it and a
	// channel reading HLS carries none of its source's splices
	const section = spliceSection((STREAM_BASE + 1.5) * 90_000);
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			adMarkers: 'daterange',
			programDateTime: new Date('2026-01-01T00:00:00Z'),
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	addScte35Section(output, section, { outOfNetwork: true, breakDuration: 2 });
	for (let i = 0; i < 8; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	const playlist = [...files.entries()].find(([name]) => name.endsWith('.m3u8') && name !== 'master.m3u8');
	expect(new TextDecoder().decode(playlist![1])).toContain('SCTE35-OUT=0x');

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);
	const start = await (await input.getPrimaryVideoTrack())!.getFirstTimestamp();

	expect(events).toHaveLength(1);
	expect(events[0]!.scheme).toBe('urn:scte:scte35:2013:bin');
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(section));
	// Dated by the splice itself rather than by the segment carrying it
	expect(events[0]!.timestamp! - start).toBeCloseTo(1.5, 2);
}, 300_000);

test('a splice signalled both in band and as a date range is one event', async () => {
	// A transport-stream output writes the section down the cue stream AND into the playlist. SCTE 35
	// makes a section unique by its splice_event_id, so the same bytes twice is one splice.
	const section = spliceSection((STREAM_BASE + 1.5) * 90_000);
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat({ scte35Pid: SCTE35_PID }),
			targetDuration: 1,
			adMarkers: 'daterange',
			programDateTime: new Date('2026-01-01T00:00:00Z'),
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	addScte35Section(output, section, { outOfNetwork: true, breakDuration: 2 });
	for (let i = 0; i < 8; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);

	const start = await (await input.getPrimaryVideoTrack())!.getFirstTimestamp();

	expect(events).toHaveLength(1);
	// The playlist is read before any segment, so the copy that states a time is the one that stands
	expect(events[0]!.timestamp! - start).toBeCloseTo(1.5, 2);
}, 300_000);

test('a date range listed ahead of the segments is still placed by its START-DATE', async () => {
	// Writers commonly list every range at the head of the playlist rather than beside the segment it
	// covers, so where the tag sits says nothing - only START-DATE does
	const section = spliceSection((STREAM_BASE + 1.5) * 90_000);
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			adMarkers: 'daterange',
			programDateTime: new Date('2026-01-01T00:00:00Z'),
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	addScte35Section(output, section, { outOfNetwork: true, breakDuration: 2 });
	for (let i = 0; i < 8; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	// Move the range up to just after the first wall clock, well ahead of the segment it dates
	const [name, body] = [...files.entries()].find(([n]) => n.endsWith('.m3u8') && n !== 'master.m3u8')!;
	const lines = new TextDecoder().decode(body).split('\n');
	const rangeIndex = lines.findIndex(line => line.startsWith('#EXT-X-DATERANGE:'));
	expect(rangeIndex).toBeGreaterThan(-1);
	const [range] = lines.splice(rangeIndex, 1);
	const clockIndex = lines.findIndex(line => line.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
	expect(clockIndex).toBeGreaterThan(-1);
	expect(clockIndex).toBeLessThan(rangeIndex);
	lines.splice(clockIndex + 1, 0, range!);
	files.set(name, new TextEncoder().encode(lines.join('\n')));

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);
	const start = await (await input.getPrimaryVideoTrack())!.getFirstTimestamp();

	expect(events).toHaveLength(1);
	// Where the tag now sits would say 0; its START-DATE says the second segment
	expect(events[0]!.timestamp! - start).toBeCloseTo(1.5, 2);
}, 300_000);

test('a splice a DASH manifest carries in its EventStream is announced', async () => {
	// A DASH manifest is the only place this splice is: nothing in the segments says it. Written with
	// the AST, which already models <EventStream> and the SCTE-214 <Signal> inside an <Event>.
	const section = spliceSection(90_000);
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			mpdPath: 'manifest.mpd',
		}),
		target: new PathedTarget('manifest.mpd', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < 8; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	const mpd = parseMpd(new TextDecoder().decode(files.get('manifest.mpd')));
	mpd.periods[0]!.eventStreams.push({
		schemeIdUri: 'urn:scte:scte35:2014:xml+bin',
		value: null,
		timescale: 90_000,
		presentationTimeOffset: null,
		events: [{
			presentationTime: 2.5 * 90_000,
			duration: null,
			id: 7,
			contentEncoding: null,
			messageData: null,
			value: null,
			scte35Binary: bytesToBase64(section),
			foreignXml: [],
		}],
	});
	files.set('manifest.mpd', new TextEncoder().encode(serializeMpd(mpd)));

	using input = new Input({
		source: new CustomPathedSource('manifest.mpd', ({ path }) => {
			const name = path.split('/').pop() ?? path;
			return new BufferSource(files.get(name)!);
		}),
		formats: ALL_FORMATS,
	});
	const events = await readThrough(input);

	expect(events).toHaveLength(1);
	// The <Signal> names the event, so the stream's own scheme is not what comes out
	expect(events[0]!.scheme).toBe('urn:scte:scte35:2013:bin');
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(section));
	// @presentationTime in the stream's own timescale, on the period's timeline
	expect(events[0]!.timestamp).toBeCloseTo(2.5, 2);
}, 300_000);

test('a presentation with two tracks announces a manifest event once, not once per track', async () => {
	// Video and audio are separate Representations, so the reader builds a segmented input for each and
	// both walk the same manifest. The dedupe is the Input's for exactly this reason.
	const section = spliceSection(90_000);
	const files = new Map<string, Uint8Array>();

	using media = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			mpdPath: 'manifest.mpd',
			// Otherwise both tracks are muxed into one Representation, and there is only one reader
			separateRenditions: true,
		}),
		target: new PathedTarget('manifest.mpd', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});
	const conversion = await Conversion.init({ input: media, output });
	await conversion.execute();

	const mpd = parseMpd(new TextDecoder().decode(files.get('manifest.mpd')));
	mpd.periods[0]!.eventStreams.push({
		schemeIdUri: 'urn:scte:scte35:2014:xml+bin',
		value: null,
		timescale: 90_000,
		presentationTimeOffset: null,
		events: [{
			presentationTime: 2.5 * 90_000,
			duration: null,
			id: 7,
			contentEncoding: null,
			messageData: null,
			value: null,
			scte35Binary: bytesToBase64(section),
			foreignXml: [],
		}],
	});
	files.set('manifest.mpd', new TextEncoder().encode(serializeMpd(mpd)));

	using input = new Input({
		source: new CustomPathedSource('manifest.mpd', ({ path }) => {
			const name = path.split('/').pop() ?? path;
			return new BufferSource(files.get(name)!);
		}),
		formats: ALL_FORMATS,
	});
	expect(await input.getTracks()).toHaveLength(2);
	expect(await readThrough(input)).toHaveLength(1);
}, 300_000);

test('a time before the output\'s first packet is dropped, not clamped into the first segment', async () => {
	// Clamping writes a tag at a time the caller did not ask for, and a receiver acts on it. There is
	// no segment this belongs in, so it is dropped and said so.
	const warnings: string[] = [];
	const off = Logging.on('warn', args => void warnings.push(args.map(String).join(' ')));

	try {
		const files = await writeFiles({
			segmentFormat: 'cmaf',
			// The packets below start at 0, so this is before the stream begins
			write: output => addId3Metadata(output, { time: -2, data: id3Tag('early') }),
		});

		using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
		expect(await readThrough(input)).toHaveLength(0);
	} finally {
		off();
	}

	expect(warnings.join('\n')).toMatch(/before this output's first packet/);
}, 300_000);

test('a stated time is on the same timeline as the media added beside it', async () => {
	// The output shifts its own timeline by mediaTimestampBase, and a stated time makes the same trip
	// as the packets: a tag written at the time of a packet lands in the segment that packet is in.
	const files = await writeFiles({
		segmentFormat: 'cmaf',
		segmentCount: 6,
		write: output => addId3Metadata(output, { time: 3.25, data: id3Tag('mid') }),
	});

	using input = new Input({ source: sourceOf(files), formats: ALL_FORMATS });
	const events = await readThrough(input);

	expect(events).toHaveLength(1);
	expect(events[0]!.timestamp).toBeCloseTo(3.25, 2);
}, 300_000);
