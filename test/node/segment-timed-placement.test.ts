/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Everything that travels with the media rather than as media - an ID3 tag, an SCTE-35 section, a
// private PES payload - has to answer one question: which segment does this time belong to? A
// segmented output opens a muxer per segment and one per variant, so that question is asked once per
// segment per playlist, and a wrong answer is invisible in the bytes of any single segment.
//
// So this does not test a feature. It places items at every cut the pipeline chooses, a millisecond
// past each, and halfway between, then reads back which segment each one landed in and checks it
// against the window the *playlist* announces for that segment. The cuts are learned from a first run
// rather than predicted, which is what makes a boundary case a boundary case: an item stated exactly
// on a cut belongs to the segment that opens there.

import { describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import type { EncodedPacket } from '../../src/packet.js';
import { addId3Metadata } from '../../src/mpeg-ts/id3-output.js';
import { addScte35Section } from '../../src/mpeg-ts/scte35-output.js';
import { readPrivatePesPayloads } from '../../src/mpeg-ts/private-streams.js';
import { readEmsgs } from '../../src/emsg.js';

registerMediabunnyServer();

const SOURCE = new URL('../public/demo.mp4', import.meta.url).pathname;
const ID3_PID = 0x1e2;
const TARGET_DURATION = 1;

/** An ID3v2.4 tag whose one TXXX frame carries `label`, so a tag read back names the probe it is. */
const id3Tag = (label: string) => {
	const body = [0x03, ...[...label].map(c => c.charCodeAt(0)), 0];
	const frame = [0x54, 0x58, 0x58, 0x58, 0, 0, 0, body.length, 0, 0, ...body];
	const size = frame.length;
	return new Uint8Array([
		0x49, 0x44, 0x33, 0x04, 0x00, 0x00,
		(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
		...frame,
	]);
};

/** The label back out of such a tag: the TXXX body runs from the encoding byte to the terminator. */
const labelOf = (tag: Uint8Array) => {
	const text = new TextDecoder().decode(tag);
	const at = text.indexOf('TXXX');
	return at === -1 ? '' : text.slice(at + 11, text.length - 1);
};

/** MPEG-2 CRC-32, so the section this test hands over is one a reader will accept. */
const crc32Mpeg = (data: Uint8Array) => {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte << 24;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
			crc >>>= 0;
		}
	}
	return crc >>> 0;
};

/**
 * A `splice_null` section: it states no time, so it rides the next segment written, and no direction,
 * which the caller's own `outOfNetwork` and `breakDuration` then supply.
 */
const spliceNull = () => {
	const body = [0x00, 0x00, 0, 0, 0, 0, 0x00, 0x0f, 0xf0, 0x00, 0x00, 0x00, 0x00];
	const length = body.length + 4;
	const head = new Uint8Array([0xfc, 0x30 | ((length >> 8) & 0x0f), length & 0xff, ...body]);
	const out = new Uint8Array(head.length + 4);
	out.set(head);
	const crc = crc32Mpeg(head);
	new DataView(out.buffer).setUint32(out.length - 4, crc);
	return out;
};

type WrittenSegment = {
	/** What the playlist announces for it, which is what a player sums to place the segment. */
	duration: number;
	/**
	 * Where its media actually begins: the earliest presentation time of any track in its own bytes.
	 * Read back rather than computed, so it is a reference the pipeline's own arithmetic cannot move.
	 */
	mediaStart: number;
	labels: string[];
};

type Written = {
	/** Per playlist, the segments it announced, in order. */
	playlists: Map<string, WrittenSegment[]>;
};

/** The earliest presentation time across the tracks of one segment, read out of the segment itself. */
const mediaStartOf = async (bytes: Uint8Array, init: Uint8Array | null) => {
	using input = new Input({
		source: new BufferSource(init ? new Uint8Array([...init, ...bytes]) : bytes),
		formats: ALL_FORMATS,
	});

	let earliest = Infinity;
	for (const track of await input.getTracks()) {
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		if (packet) {
			earliest = Math.min(earliest, packet.timestamp);
		}
	}

	return earliest;
};

const write = async (options: {
	segments: 'mpeg-ts' | 'cmaf';
	variants: number;
	live: boolean;
	probes: { time: number; label: string }[];
}): Promise<Written> => {
	using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	// Audio is not decoration here. A cut falls on a video key frame, so a video-only segment ends
	// exactly where the next one starts and every way of computing the window agrees. An audio frame
	// crosses the cut, which is what makes "the furthest this segment's packets reach" and "where the
	// next segment starts" different numbers - and an item stated exactly on a boundary land in the
	// wrong one.
	const audio = (await input.getPrimaryAudioTrack())!;
	const audioConfig = (await audio.getDecoderConfig())!;
	const audioPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(audio).packets()) {
		audioPackets.push(packet);
	}

	const texts = new Map<string, BufferTarget>();
	// Keyed by the playlist each segment belongs to, since a variant writes its own copy of every item
	const bodies = new Map<number, Uint8Array[]>();
	// A CMAF segment is only readable with the init that declares its tracks; a TS segment carries its own
	const inits = new Map<number, Uint8Array>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: options.segments === 'cmaf'
				? new CmafOutputFormat()
				: new MpegTsOutputFormat({ timedMetadataPid: ID3_PID }),
			targetDuration: TARGET_DURATION,
			live: options.live,
			onInit: (target, info) => void inits.set(info.n, new Uint8Array((target as BufferTarget).buffer!)),
			onSegment: (target, info) => {
				const list = bodies.get(info.playlist.n) ?? [];
				list.push(new Uint8Array((target as BufferTarget).buffer!));
				bodies.set(info.playlist.n, list);
			},
		}),
		target: new PathedTarget('index.m3u8', (request) => {
			const target = new BufferTarget();
			if (request.path.endsWith('.m3u8')) {
				texts.set(request.path, target);
			}
			return target;
		}),
	});

	const sources: { video: EncodedVideoPacketSource; audio: EncodedAudioPacketSource }[] = [];
	for (let i = 0; i < options.variants; i++) {
		// Paired, so each variant is one playlist carrying both tracks rather than a video playlist and
		// an audio rendition that cut independently
		const videoGroup = new OutputTrackGroup();
		const audioGroup = new OutputTrackGroup();
		videoGroup.pairWith(audioGroup);

		const video = new EncodedVideoPacketSource('avc');
		const audioTrack = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(video, { group: videoGroup });
		output.addAudioTrack(audioTrack, { group: audioGroup });
		sources.push({ video, audio: audioTrack });
	}
	await output.start();

	for (const probe of options.probes) {
		addId3Metadata(output, { time: probe.time, data: id3Tag(probe.label) });
	}

	for (const { video, audio: audioSource } of sources) {
		for (const packet of packets) {
			await video.add(packet, { decoderConfig: config });
		}
		for (const packet of audioPackets) {
			await audioSource.add(packet, { decoderConfig: audioConfig });
		}
	}
	await output.finalize();

	const playlists: Written['playlists'] = new Map();
	// The master playlist lists variants, not segments, so it carries no EXTINF at all. What remains is
	// the media playlists in the master's own order, which is the 1-based `n` each segment reports.
	const media = [...texts].filter(([, target]) => (
		new TextDecoder().decode(target.buffer!).includes('#EXTINF:')
	)).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));

	for (const [index, [path, target]] of media.entries()) {
		const text = new TextDecoder().decode(target.buffer!);
		const durations = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].map(match => Number(match[1]));
		const segments = bodies.get(index + 1) ?? [];
		expect(segments.length, `${path} announced ${durations.length} segments`)
			.toBe(durations.length);

		const init = inits.get(index + 1) ?? null;
		playlists.set(path, await Promise.all(durations.map(async (duration, index) => ({
			duration,
			mediaStart: await mediaStartOf(segments[index]!, init),
			labels: (options.segments === 'cmaf'
				? readEmsgs(segments[index]!).map(emsg => emsg.messageData)
				: readPrivatePesPayloads(segments[index]!, ID3_PID).map(payload => payload.data)
			).map(labelOf),
		}))));
	}

	return { playlists };
};

/**
 * The `[start, end)` each segment covers, taken from where its media actually begins rather than from
 * the durations the playlist states. A segment runs until the next one's media starts, and the last
 * one runs to infinity - everything still queued belongs to it.
 *
 * Deriving these from the announced durations instead would make the check circular: the playlist's
 * arithmetic and the placement's are the same decision, so both move together under a wrong one.
 */
const windowsOf = (segments: WrittenSegment[]) => segments.map((segment, index) => ({
	start: segment.mediaStart,
	end: index === segments.length - 1 ? Infinity : segments[index + 1]!.mediaStart,
}));

const CASES = [
	{ segments: 'mpeg-ts', variants: 1, live: false },
	{ segments: 'mpeg-ts', variants: 2, live: false },
	{ segments: 'mpeg-ts', variants: 1, live: true },
	{ segments: 'cmaf', variants: 1, live: false },
	{ segments: 'cmaf', variants: 2, live: false },
	{ segments: 'cmaf', variants: 1, live: true },
] as const;

describe('a timed item lands in the segment whose window contains it', () => {
	test.each(CASES)(
		'$segments, $variants variant(s), live=$live',
		async (options) => {
			// First run places nothing: its cuts are where the probes go, so a probe can sit exactly on a
			// boundary rather than near one. Predicting the cuts instead would test the prediction.
			const dry = await write({ ...options, probes: [] });
			const reference = [...dry.playlists.values()][0]!;
			expect(reference.length).toBeGreaterThan(2);

			const cuts = windowsOf(reference);
			const probes: { time: number; label: string }[] = [];
			for (const [index, window] of cuts.entries()) {
				// On the cut, a millisecond past it, and halfway through the segment it opens
				probes.push({ time: window.start, label: `cut-${index}` });
				probes.push({ time: window.start + 0.001, label: `past-${index}` });
				probes.push({
					time: window.start + (Number.isFinite(window.end) ? window.end - window.start : 0.5) / 2,
					label: `mid-${index}`,
				});
			}

			const run = await write({ ...options, probes });
			expect(run.playlists.size).toBe(options.variants);

			for (const [path, segments] of run.playlists) {
				const windows = windowsOf(segments);

				// The playlist has to describe the same timeline the media is on: a player sums EXTINF
				// to decide where a segment begins, and an item placed against a different reckoning of
				// that start lands in a segment the player will not look in. Checked per segment rather
				// than only in total, since a drift that cancels out still misplaces everything between.
				let announced = segments[0]!.mediaStart;
				for (const [index, segment] of segments.entries()) {
					expect(
						announced,
						`${path}: segment ${index} is announced at ${announced}s but its media starts at`
						+ ` ${segment.mediaStart}s`,
					).toBeCloseTo(segment.mediaStart, 3);
					announced += segment.duration;
				}

				// Every probe is carried, exactly once, by this variant - a cue consumed by the first
				// playlist would leave the others without it
				const placed = new Map<string, number>();
				for (const [index, segment] of segments.entries()) {
					for (const label of segment.labels) {
						expect(placed.has(label), `${path}: ${label} appears twice`).toBe(false);
						placed.set(label, index);
					}
				}

				for (const probe of probes) {
					const index = placed.get(probe.label);
					expect(index, `${path}: ${probe.label} at ${probe.time}s was never written`)
						.toBeDefined();

					const window = windows[index!]!;
					expect(
						probe.time >= window.start && probe.time < window.end,
						`${path}: ${probe.label} at ${probe.time}s landed in segment ${index}`
						+ ` [${window.start}, ${window.end}), which does not contain it`,
					).toBe(true);
				}
			}
		},
		300_000,
	);
});

// A live playlist drops its oldest segments, and the break a `#EXT-X-CUE-OUT-CONT` reports is open in
// an earlier one. Walking back over what the playlist still holds loses that break the moment the
// segment that opened it falls out of the window, so the state is settled when a segment is appended
// and travels with it. The window here is deliberately shorter than the break.
describe('an ad break outlives the segment that opened it', () => {
	test.each(['mpeg-ts', 'cmaf'] as const)('%s, live, with eviction', async (segmentFormat) => {
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		const texts = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: segmentFormat === 'cmaf'
					? new CmafOutputFormat()
					: new MpegTsOutputFormat({ scte35Pid: 0x1f00 }),
				targetDuration: TARGET_DURATION,
				live: true,
				maxLiveSegmentCount: 2,
				adMarkers: 'elemental',
			}),
			target: new PathedTarget('index.m3u8', (request) => {
				const target = new BufferTarget();
				if (request.path.endsWith('.m3u8')) {
					texts.set(request.path, target);
				}
				return target;
			}),
		});

		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();

		// Opens a break long enough that it is still running once the opening segment has been evicted
		addScte35Section(output, spliceNull(), { outOfNetwork: true, breakDuration: 10 });

		for (const packet of packets) {
			await source.add(packet, { decoderConfig: config });
		}
		await output.finalize();

		const text = [...texts.values()]
			.map(target => new TextDecoder().decode(target.buffer!))
			.find(body => body.includes('#EXTINF:'))!;
		expect(text).toBeDefined();

		// The opening CUE-OUT is gone with its segment, which is exactly the case that used to lose the
		// break: what remains has to say how far into it the viewer is
		expect(text).not.toContain('#EXT-X-CUE-OUT:');
		expect(text).toContain('#EXT-X-CUE-OUT-CONT:');
	}, 300_000);
});
