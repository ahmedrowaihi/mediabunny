/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A receiver that joins a running transport stream can only find the program once it has seen a PAT and
// a PMT, so they are repeated rather than written once at the start. ETSI TR 101 290 1.3 and 1.5 treat a
// gap over 0.5 s in either as an error; broadcast practice is every 100 ms, which is the default here.
//
// Gaps are measured on the stream's **PCR**, not on packet positions, because that is the clock a
// receiver has. A table's position is dated by the last PCR before it, which is the worst case a joining
// receiver sees.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MpegTsOutputFormat, type MpegTsOutputFormatOptions } from '../../src/output-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const PACKET = 188;
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const SCTE35_PID = 0x1f00;

type Section = { pid: number; cc: number; pcr: number | null; payload: Uint8Array };

/** Walks the stream, returning every PAT and PMT section with the PCR in force when it appeared. */
const sectionsOf = (bytes: Uint8Array, pmtPid = PMT_PID): Section[] => {
	const out: Section[] = [];
	let pcr: number | null = null;

	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		expect(bytes[at]).toBe(0x47);
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		const control = (bytes[at + 3]! >> 4) & 0x3;
		let payloadAt = at + 4;

		if (control === 2 || control === 3) {
			const fieldLength = bytes[at + 4]!;
			if (fieldLength >= 7 && (bytes[at + 5]! & 0x10)) {
				pcr = bytes[at + 6]! * 2 ** 25
					+ bytes[at + 7]! * 2 ** 17
					+ bytes[at + 8]! * 2 ** 9
					+ bytes[at + 9]! * 2
					+ ((bytes[at + 10]! >> 7) & 0x1);
			}
			payloadAt = at + 5 + fieldLength;
		}

		if ((pid === PAT_PID || pid === pmtPid) && (control === 1 || control === 3)) {
			// payload_unit_start_indicator means a pointer_field leads the section
			const start = (bytes[at + 1]! & 0x40) ? payloadAt + 1 + bytes[payloadAt]! : payloadAt;
			out.push({
				pid,
				cc: bytes[at + 3]! & 0x0f,
				pcr,
				payload: bytes.subarray(start, at + PACKET),
			});
		}
	}

	return out;
};

/** Ten seconds of 25 fps video, which is long enough for the period to matter. */
const buildStream = async (interval?: number) => {
	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 25) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({
			scte35Pid: SCTE35_PID,
			timestampOffset: 0,
			...(interval === undefined ? {} : { tableRepeatInterval: interval }),
		}),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	// The sample's packets reused on a 25 fps grid: the tables care about timestamps, not pictures
	for (let i = 0; i < 250; i++) {
		const source = sample[i % sample.length]!;
		await videoSource.add(
			new EncodedPacket(source.data, i % 25 === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

/** Worst gap between consecutive sections on a PID, in seconds of PCR. */
const worstGap = (sections: Section[], pid: number) => {
	const dated = sections.filter(s => s.pid === pid && s.pcr !== null).map(s => s.pcr!);
	expect(dated.length).toBeGreaterThan(1);

	let worst = 0;
	for (let i = 1; i < dated.length; i++) {
		worst = Math.max(worst, (dated[i]! - dated[i - 1]!) / 90_000);
	}
	return worst;
};

test('PAT and PMT repeat with no gap past the default period', async () => {
	const sections = sectionsOf(await buildStream());

	// 0.1 s default; one packet of slack, since a table lands between media packets rather than exactly
	expect(worstGap(sections, PAT_PID)).toBeLessThanOrEqual(0.14);
	expect(worstGap(sections, PMT_PID)).toBeLessThanOrEqual(0.14);

	// Over ten seconds of stream, so this is repetition rather than a couple of extra copies
	expect(sections.filter(s => s.pid === PAT_PID).length).toBeGreaterThan(60);
});

test('the period is the caller\'s, and Infinity writes the tables once', async () => {
	const slow = sectionsOf(await buildStream(1));
	expect(worstGap(slow, PAT_PID)).toBeGreaterThan(0.5);
	expect(worstGap(slow, PAT_PID)).toBeLessThanOrEqual(1.04);

	const once = sectionsOf(await buildStream(Infinity));
	expect(once.filter(s => s.pid === PAT_PID)).toHaveLength(1);
	expect(once.filter(s => s.pid === PMT_PID)).toHaveLength(1);
});

test('continuity counters stay continuous on both table PIDs', async () => {
	const sections = sectionsOf(await buildStream());

	for (const pid of [PAT_PID, PMT_PID]) {
		const counters = sections.filter(s => s.pid === pid).map(s => s.cc);
		expect(counters.length).toBeGreaterThan(60);
		for (let i = 1; i < counters.length; i++) {
			// A receiver reads any other step as a lost packet
			expect(counters[i]).toBe((counters[i - 1]! + 1) & 0x0f);
		}
	}
});

test('every PMT names the SCTE-35 PID with its CUEI descriptor', async () => {
	const pmts = sectionsOf(await buildStream()).filter(s => s.pid === PMT_PID);
	expect(pmts.length).toBeGreaterThan(60);

	for (const pmt of pmts) {
		const hex = [...pmt.payload].map(b => b.toString(16).padStart(2, '0')).join('');
		// stream_type 0x86 then the PID, which 13818-1 writes as 3 reserved bits set plus the 13-bit
		// value, so 0x1f00 goes on the wire as 0xff00
		expect(hex).toContain('86' + 'ff00');
		// The CUEI registration descriptor (tag 0x05, length 4, 'CUEI'), which tells a cue stream from
		// the Blu-ray use of the same stream type
		expect(hex).toContain('0504' + '43554549');
	}
});

// The point of repeating them: a receiver that joins late has to be able to read the stream. A slice cut
// from the middle is that receiver, and libavformat is a reader that is not this library's own.
test('a one-second slice from the middle still names every stream', async () => {
	const bytes = await buildStream();
	const packets = Math.floor(bytes.byteLength / PACKET);
	const from = Math.floor(packets * 0.45) * PACKET;
	const to = Math.floor(packets * 0.55) * PACKET;
	const slice = bytes.subarray(from, to);

	using input = new Input({ source: new BufferSource(slice), formats: ALL_FORMATS });
	const tracks = await input.getTracks();

	expect(tracks.length).toBeGreaterThanOrEqual(1);
	expect(await tracks[0]!.getCodec()).toBe('avc');
});

/** Each elementary stream a PMT section declares, as `streamType:pid`, in the order it lists them. */
const esEntriesOf = (payload: Uint8Array): string[] => {
	const programInfoLength = ((payload[10]! & 0x0f) << 8) | payload[11]!;
	const sectionLength = ((payload[1]! & 0x0f) << 8) | payload[2]!;
	const end = 3 + sectionLength - 4; // past the CRC
	const entries: string[] = [];

	let at = 12 + programInfoLength;
	while (at + 5 <= end) {
		const streamType = payload[at]!;
		const pid = ((payload[at + 1]! & 0x1f) << 8) | payload[at + 2]!;
		const esInfoLength = ((payload[at + 3]! & 0x0f) << 8) | payload[at + 4]!;
		entries.push(`${streamType}:${pid}`);
		at += 5 + esInfoLength;
	}

	return entries;
};

/** One video and one audio packet with their configs, taken from the checked-in demo file. */
const onePacketEach = async () => {
	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await source.getPrimaryVideoTrack())!;
	const audioTrack = (await source.getPrimaryAudioTrack())!;
	const first = async (track: typeof videoTrack | typeof audioTrack) => {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			return packet;
		}
		throw new Error('no packets');
	};

	return {
		video: { packet: await first(videoTrack), config: (await videoTrack.getDecoderConfig())! },
		audio: { packet: await first(audioTrack), config: (await audioTrack.getDecoderConfig())! },
	};
};

// A PMT states a track's language in an ISO_639_language_descriptor (tag 0x0a); the demuxer ignored it,
// so every MPEG-TS track read back as `und` and a consumer selecting audio by language had nothing to
// select on. The fixture is ffmpeg's, written by
// `ffmpeg -f lavfi -i sine=440:d=1 -f lavfi -i sine=880:d=1 -map 0 -map 1 -c:a aac
//  -metadata:s:a:0 language=eng -metadata:s:a:1 language=spa`, so this reads a descriptor we did not write.
test('a language stated in the PMT is read back', async () => {
	using input = new Input({
		source: new FilePathSource(new URL('../public/mpeg-ts-two-languages.ts', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getAudioTracks();
	expect(tracks).toHaveLength(2);
	expect(await Promise.all(tracks.map(track => track.getLanguageCode()))).toEqual(['eng', 'spa']);
});

test('a track whose PMT states no language stays undetermined', async () => {
	using input = new Input({
		source: new FilePathSource(new URL('../public/ac3.ts', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	for (const track of await input.getTracks()) {
		expect(await track.getLanguageCode()).toBe('und');
	}
});

test('a language set on an output track round-trips through the muxer', async () => {
	const { video, audio } = await onePacketEach();

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('avc');
	const audioSource = new EncodedAudioPacketSource('aac');
	output.addVideoTrack(videoSource, { languageCode: 'deu' });
	output.addAudioTrack(audioSource, { languageCode: 'fra' });
	await output.start();
	await videoSource.add(video.packet, { decoderConfig: video.config });
	await audioSource.add(audio.packet, { decoderConfig: audio.config });
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect(await (await input.getVideoTracks())[0]!.getLanguageCode()).toBe('deu');
	expect(await (await input.getAudioTracks())[0]!.getLanguageCode()).toBe('fra');
});

// PIDs and stream ids used to come from the order each track's first packet arrived, so two runs of the
// same job that interleaved differently renumbered the streams.
test('PIDs follow the order tracks were added, not the order packets arrive', async () => {
	const { video, audio } = await onePacketEach();

	const pidsOf = async (audioFirst: boolean) => {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('avc');
		const audioSource = new EncodedAudioPacketSource('aac');
		// Added in the same order both times; only the order their packets arrive differs
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		const addVideo = () => videoSource.add(video.packet, { decoderConfig: video.config });
		const addAudio = () => audioSource.add(audio.packet, { decoderConfig: audio.config });
		if (audioFirst) {
			await addAudio();
			await addVideo();
		} else {
			await addVideo();
			await addAudio();
		}
		await output.finalize();

		// Which PID each stream type landed on, not the set of PIDs in use: both orders use the same two
		// PIDs whatever happens, so a set compares equal even when the tracks have swapped places.
		const pmt = sectionsOf(new Uint8Array(output.target.buffer!)).find(x => x.pid === PMT_PID);
		expect(pmt).toBeDefined();

		return esEntriesOf(pmt!.payload);
	};

	const videoFirst = await pidsOf(false);
	const audioFirst = await pidsOf(true);
	expect(videoFirst).toHaveLength(2);
	expect(audioFirst).toEqual(videoFirst);
});

// Broadcast delivery states the stream's identity rather than taking the muxer's defaults, and a cable,
// satellite or ASI path takes a constant bit rate. Everything below is read back with ffprobe or out of
// the 188-byte packets, never from this library's own demuxer: the point of stating a PID or a rate is
// that something else reads it.
//
// AC-3 is deliberately absent from the codec matrix. The transport settings are codec-independent -
// nothing here reads an elementary stream - and this fork does not chase AC-3.

const BROADCAST = {
	muxRate: 5_000_000,
	programNumber: 7,
	transportStreamId: 42,
	pmtPid: 480,
	trackPids: [481, 482],
	service: { name: 'beeframe', provider: 'bf' },
	timestampOffset: 0,
} as const;

/** Every PCR in the stream as (packet index, 27 MHz ticks), plus how many null packets carried the rest. */
const clockOf = (bytes: Uint8Array) => {
	const pcrs: { packet: number; ticks: number }[] = [];
	let nullPackets = 0;

	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		expect(bytes[at]).toBe(0x47);
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		if (pid === 0x1fff) {
			nullPackets++;
		}

		const control = (bytes[at + 3]! >> 4) & 0x3;
		if ((control === 2 || control === 3) && bytes[at + 4]! >= 7 && (bytes[at + 5]! & 0x10)) {
			const base = bytes[at + 6]! * 2 ** 25
				+ bytes[at + 7]! * 2 ** 17
				+ bytes[at + 8]! * 2 ** 9
				+ bytes[at + 9]! * 2
				+ ((bytes[at + 10]! >> 7) & 0x1);
			const extension = ((bytes[at + 10]! & 0x1) << 8) | bytes[at + 11]!;
			pcrs.push({ packet: at / PACKET, ticks: base * 300 + extension });
		}
	}

	return { pcrs, nullPackets, packets: Math.floor(bytes.byteLength / PACKET) };
};

/**
 * Replays a real file's packets onto a 25 fps grid for `seconds`, which is how a 1 s and a 10 s stream
 * come from one 5 s fixture without an encoder. The transport settings care about timestamps and PIDs.
 */
const replay = async (
	file: string,
	videoCodec: 'avc' | 'hevc',
	seconds: number,
	options: MpegTsOutputFormatOptions,
) => {
	using source = new Input({
		source: new FilePathSource(new URL(`../public/${file}`, import.meta.url).pathname),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await source.getPrimaryVideoTrack())!;
	const videoConfig = (await videoTrack.getDecoderConfig())!;
	const videoPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		videoPackets.push(packet);
		if (videoPackets.length === 25) {
			break;
		}
	}

	const audioTrack = await source.getPrimaryAudioTrack();
	const audioConfig = audioTrack ? (await audioTrack.getDecoderConfig())! : null;
	const audioPackets: EncodedPacket[] = [];
	if (audioTrack) {
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			audioPackets.push(packet);
			if (audioPackets.length === 40) {
				break;
			}
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat(options),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource(videoCodec);
	output.addVideoTrack(videoSource);
	const audioSource = audioTrack ? new EncodedAudioPacketSource('aac') : null;
	if (audioSource) {
		output.addAudioTrack(audioSource);
	}
	await output.start();

	const videoFrames = Math.round(seconds * 25);
	for (let i = 0; i < videoFrames; i++) {
		const packet = videoPackets[i % videoPackets.length]!;
		await videoSource.add(
			new EncodedPacket(packet.data, i % 25 === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: videoConfig },
		);
	}

	if (audioSource && audioConfig) {
		// 1024 samples at 48 kHz, which is what an AAC frame covers
		const frameDuration = 1024 / 48_000;
		const audioFrames = Math.ceil(seconds / frameDuration);
		for (let i = 0; i < audioFrames; i++) {
			const packet = audioPackets[i % audioPackets.length]!;
			await audioSource.add(
				new EncodedPacket(packet.data, 'key', i * frameDuration, frameDuration),
				{ decoderConfig: audioConfig },
			);
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const probe = (bytes: Uint8Array, entries: string) => {
	const file = path.join(mkdtempSync(path.join(tmpdir(), 'mediabunny-ts-')), 'broadcast.ts');
	writeFileSync(file, bytes);
	try {
		return execFileSync(
			'ffprobe',
			['-v', 'error', '-show_entries', entries, '-of', 'compact=nokey=0', file],
			{ encoding: 'utf8' },
		);
	} finally {
		rmSync(path.dirname(file), { recursive: true, force: true });
	}
};

const CASES = [
	{ codec: 'avc' as const, file: 'demo.mp4', seconds: 1 },
	{ codec: 'avc' as const, file: 'demo.mp4', seconds: 10 },
	{ codec: 'hevc' as const, file: 'video-h265.mp4', seconds: 1 },
	{ codec: 'hevc' as const, file: 'video-h265.mp4', seconds: 10 },
];

test.each(CASES)('$codec, $seconds s: the stated identity is what ffprobe reads', async (testCase) => {
	const bytes = await replay(testCase.file, testCase.codec, testCase.seconds, BROADCAST);
	const programs = probe(bytes, 'program=program_num,pmt_pid,pcr_pid:program_tags');

	expect(programs).toContain('program_num=7');
	expect(programs).toContain('pmt_pid=480');
	// The first video track's PID, which is what the muxer picks for the clock when none is stated
	expect(programs).toContain('pcr_pid=481');
	expect(programs).toContain('service_name=beeframe');
	expect(programs).toContain('service_provider=bf');

	const streams = probe(bytes, 'stream=id,ts_id');
	expect(streams).toContain('id=0x1e1'); // 481
	expect(streams).toContain('ts_id=42');
	if (testCase.file === 'demo.mp4') {
		expect(streams).toContain('id=0x1e2'); // 482
	}

	// The PAT and PMT keep their period whatever else is in the stream. A repeat is placed in front of
	// a media packet rather than at an arbitrary byte, so it cannot land closer to the period than the
	// packets are spaced - 21 ms for AAC at 48 kHz - and the bound says so rather than hiding it. ETSI
	// TR 101 290 1.3 and 1.5 allow 0.5 s, so this is five times stricter than the standard.
	const sections = sectionsOf(bytes, 480);
	expect(worstGap(sections, PAT_PID)).toBeLessThanOrEqual(0.1 + 0.025);
	expect(worstGap(sections, 480)).toBeLessThanOrEqual(0.1 + 0.025);
}, 300_000);

test.each(CASES)('$codec, $seconds s: the rate is constant and the PCR is its byte position', async (testCase) => {
	const bytes = await replay(testCase.file, testCase.codec, testCase.seconds, BROADCAST);
	const { pcrs, nullPackets, packets } = clockOf(bytes);

	expect(nullPackets, 'a constant rate pads with null packets').toBeGreaterThan(0);
	expect(pcrs.length).toBeGreaterThan(testCase.seconds * 10);

	// Every PCR sits exactly where its byte position puts it at this rate - that is the whole point of
	// stamping it from the position rather than from a decode time, and it is exact to the tick
	for (let i = 1; i < pcrs.length; i++) {
		const bytesBetween = (pcrs[i]!.packet - pcrs[i - 1]!.packet) * PACKET;
		const expected = bytesBetween * 8 * 27_000_000 / BROADCAST.muxRate;
		expect(Math.abs((pcrs[i]!.ticks - pcrs[i - 1]!.ticks) - expected), `PCR ${i}`)
			.toBeLessThanOrEqual(1);
	}

	// And the file as a whole is that rate over the span of media it carries. ffprobe's own
	// `format=duration` is not that span - it drops the AAC priming the stream starts below zero with
	// and the tail past the last video frame - so the span is taken from the streams it reports.
	const streams = probe(bytes, 'stream=start_time,duration');
	const starts: number[] = [];
	const ends: number[] = [];
	// ffprobe lists each stream twice, once under its program and once on its own, with a blank line
	// between the two groups
	for (const line of streams.split('\n')) {
		const start = /start_time=(-?[0-9.]+)/.exec(line);
		const duration = /duration=(-?[0-9.]+)/.exec(line);
		if (!start || !duration) {
			continue;
		}

		starts.push(Number(start[1]));
		ends.push(Number(start[1]) + Number(duration[1]));
	}
	expect(starts.length).toBeGreaterThan(0);

	const span = Math.max(...ends) - Math.min(...starts);
	const rate = packets * PACKET * 8 / span;
	expect(rate / BROADCAST.muxRate).toBeCloseTo(1, 2);
	expect(Math.abs(rate / BROADCAST.muxRate - 1), 'within 0.5% of muxRate').toBeLessThan(0.005);
}, 300_000);

test('media that needs more than muxRate is refused, naming the rate it needed', async () => {
	await expect(replay('demo.mp4', 'avc', 2, { ...BROADCAST, muxRate: 100_000 }))
		.rejects.toThrow(/muxRate is 100000 bits per second/);
});

test('without muxRate nothing is padded and the PCR stays on the decode timeline', async () => {
	const bytes = await replay('demo.mp4', 'avc', 2, { ...BROADCAST, muxRate: undefined });
	const { pcrs, nullPackets } = clockOf(bytes);

	expect(nullPackets).toBe(0);
	// The first PCR is the first decode time rather than byte position zero
	expect(pcrs[0]!.ticks / 27_000_000).toBeCloseTo(0, 3);
}, 300_000);

test('a pcrPid of no track gets PCR-only packets at the stated interval', async () => {
	const bytes = await replay('demo.mp4', 'avc', 2, {
		...BROADCAST,
		muxRate: undefined,
		pcrPid: 500,
		pcrInterval: 0.05,
	});

	const onPcrPid: number[] = [];
	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		const control = (bytes[at + 3]! >> 4) & 0x3;
		if (pid !== 500) {
			continue;
		}

		// Adaptation field only: a PCR-only packet carries no payload at all
		expect(control).toBe(2);
		expect(bytes[at + 4]).toBe(183);
		expect(bytes[at + 5]! & 0x10).toBe(0x10);
		onPcrPid.push(bytes[at + 6]! * 2 ** 25
			+ bytes[at + 7]! * 2 ** 17
			+ bytes[at + 8]! * 2 ** 9
			+ bytes[at + 9]! * 2
			+ ((bytes[at + 10]! >> 7) & 0x1));
	}

	expect(onPcrPid.length).toBeGreaterThan(30); // 2 s at 50 ms
	expect(probe(bytes, 'program=pcr_pid')).toContain('pcr_pid=500');

	for (let i = 1; i < onPcrPid.length; i++) {
		const gap = (onPcrPid[i]! - onPcrPid[i - 1]!) / 90_000;
		expect(gap).toBeCloseTo(0.05, 3);
	}
}, 300_000);

test('a PID stated twice is refused, naming what already holds it', async () => {
	await expect(replay('demo.mp4', 'avc', 1, { ...BROADCAST, trackPids: [480, 482] }))
		.rejects.toThrow(/already uses for the PMT/);
	await expect(replay('demo.mp4', 'avc', 1, { ...BROADCAST, scte35Pid: 481 }))
		.rejects.toThrow(/already uses for Track 1/);
});

test('an out-of-range transport setting is refused at construction', () => {
	expect(() => new MpegTsOutputFormat({ programNumber: 0 })).toThrow(/between 1 and 65535/);
	expect(() => new MpegTsOutputFormat({ pmtPid: 0x1fff })).toThrow(/0x0010 and 0x1ffe/);
	expect(() => new MpegTsOutputFormat({ trackPids: [481, 481] })).toThrow(/must not repeat/);
	expect(() => new MpegTsOutputFormat({ pcrInterval: 0.2 })).toThrow(/at most 0.1 seconds/);
	expect(() => new MpegTsOutputFormat({ muxRate: 0 })).toThrow(/positive/);
	expect(() => new MpegTsOutputFormat({ service: { name: '', provider: 'x' } })).toThrow(/non-empty/);
});

// 13818-1 2.4.3.3: the continuity counter increments only on a packet carrying a payload. A packet
// without one - a PCR-only packet, which is how the clock is kept where the PCR track goes quiet -
// repeats the previous packet's value. Getting that wrong shows up at a receiver as two errors rather
// than one: an increment on a packet with no payload, then a repeat on the payload packet after it,
// and TR 101 290 reports a continuity error on an otherwise clean programme.
const continuityErrors = (bytes: Uint8Array) => {
	const last = new Map<number, number>();
	const errors: string[] = [];

	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
		const cc = bytes[at + 3]! & 0xf;
		const hasPayload = (bytes[at + 3]! >> 4) & 0x1;
		const before = last.get(pid);

		if (before !== undefined && cc !== ((before + hasPayload) & 0xf)) {
			errors.push(`PID ${pid} at ${at}: ${before} -> ${cc}, payload ${hasPayload}`);
		}

		last.set(pid, cc);
	}

	return errors;
};

/** Every (index, PID, cc, hasPayload) in the stream, so a run around one packet can be examined. */
const packetsOf = (bytes: Uint8Array) => {
	const out: { at: number; pid: number; cc: number; hasPayload: boolean }[] = [];
	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		out.push({
			at,
			pid: ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!,
			cc: bytes[at + 3]! & 0xf,
			hasPayload: (((bytes[at + 3]! >> 4) & 0x1) === 1),
		});
	}
	return out;
};

// pcrInterval below the frame interval, so the clock is due between one video packet and the next and
// PCR-only packets land on the video PID itself - which is where a payload packet follows one and the
// repeat-then-increment rule can be checked at all.
const DENSE_PCR = { ...BROADCAST, muxRate: undefined, pcrInterval: 0.02 } as MpegTsOutputFormatOptions;

test('a PCR-only packet repeats the counter, and the packet after it increments once', async () => {
	const bytes = await replay('demo.mp4', 'avc', 4, DENSE_PCR);
	const packets = packetsOf(bytes);

	// Non-vacuity: without adaptation-only packets on a PID that also carries payload, this proves
	// nothing at all
	const videoPid = 481;
	const withoutPayload = packets.filter(p => p.pid === videoPid && !p.hasPayload);
	expect(withoutPayload.length, 'no PCR-only packets were written').toBeGreaterThan(10);

	expect(continuityErrors(bytes)).toEqual([]);

	// And the rule stated directly: the same cc as the packet before it, one more on the next packet
	// that carries a payload. The clock can be due twice over, so PCR-only packets run in groups and
	// the one after is not always a payload packet.
	const onVideo = packets.filter(p => p.pid === videoPid);
	let repeats = 0;
	let increments = 0;
	for (let i = 1; i < onVideo.length - 1; i++) {
		if (onVideo[i]!.hasPayload) {
			continue;
		}

		expect(onVideo[i]!.cc, `at ${onVideo[i]!.at}`).toBe(onVideo[i - 1]!.cc);
		repeats++;

		if (onVideo[i + 1]!.hasPayload) {
			expect(onVideo[i + 1]!.cc, `after ${onVideo[i]!.at}`).toBe((onVideo[i]!.cc + 1) & 0xf);
			increments++;
		}
	}

	expect(repeats).toBeGreaterThan(10);
	expect(increments, 'no payload packet ever followed a PCR-only one').toBeGreaterThan(10);
}, 300_000);

test('a stream carrying cue sections and null packets is continuous too', async () => {
	const bytes = await replay('demo.mp4', 'avc', 4, {
		...BROADCAST,
		pcrInterval: 0.02,
		scte35Pid: 0x1f00,
	});

	// The CBR padding puts null packets in as well, which carry payload and so do increment
	expect(packetsOf(bytes).some(p => p.pid === 0x1fff)).toBe(true);
	expect(continuityErrors(bytes)).toEqual([]);
}, 300_000);
