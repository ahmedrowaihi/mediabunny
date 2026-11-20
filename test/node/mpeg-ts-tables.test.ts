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
import { BufferSource, FilePathSource, ReadableStreamSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { bytesToHexString } from '../../src/misc.js';
import { addScte35Section } from '../../src/mpeg-ts/scte35-output.js';
import { addId3Metadata } from '../../src/mpeg-ts/id3-output.js';
import { computeMpegTsCrc32 } from '../../src/mpeg-ts/mpeg-ts-misc.js';

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

/** The ISO 639 language descriptor on each ES, as `pid -> "lang/audio_type"`, from a PMT section. */
const languageDescriptorsOf = (payload: Uint8Array): Map<number, string> => {
	const programInfoLength = ((payload[10]! & 0x0f) << 8) | payload[11]!;
	const sectionLength = ((payload[1]! & 0x0f) << 8) | payload[2]!;
	const end = 3 + sectionLength - 4;
	const found = new Map<number, string>();

	let at = 12 + programInfoLength;
	while (at + 5 <= end) {
		const pid = ((payload[at + 1]! & 0x1f) << 8) | payload[at + 2]!;
		const esInfoLength = ((payload[at + 3]! & 0x0f) << 8) | payload[at + 4]!;
		let descriptor = at + 5;
		const esEnd = descriptor + esInfoLength;
		while (descriptor + 2 <= esEnd) {
			const tag = payload[descriptor]!;
			const length = payload[descriptor + 1]!;
			if (tag === 0x0a && length >= 4) {
				const language = String.fromCharCode(
					payload[descriptor + 2]!, payload[descriptor + 3]!, payload[descriptor + 4]!,
				);
				found.set(pid, `${language}/${payload[descriptor + 5]!}`);
			}
			descriptor += 2 + length;
		}
		at = esEnd;
	}

	return found;
};

// audio_type is the only field a transport stream has for an accessibility mix (ISO/IEC 13818-1 Table
// 2-61), so a disposition that never reaches it is a disposition a receiver cannot act on.
test('an accessibility disposition reaches the language descriptor\'s audio_type', async () => {
	const { video, audio } = await onePacketEach();

	const audioTypeFor = async (disposition: { hearingImpaired?: boolean; visuallyImpaired?: boolean }) => {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('avc');
		const audioSource = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(videoSource, { languageCode: 'deu' });
		output.addAudioTrack(audioSource, { languageCode: 'fra', disposition });
		await output.start();
		await videoSource.add(video.packet, { decoderConfig: video.config });
		await audioSource.add(audio.packet, { decoderConfig: audio.config });
		await output.finalize();

		const pmt = sectionsOf(new Uint8Array(output.target.buffer!)).find(s => s.pid !== PAT_PID)!;
		return languageDescriptorsOf(pmt.payload);
	};

	const plain = await audioTypeFor({});
	const hearing = await audioTypeFor({ hearingImpaired: true });
	const visual = await audioTypeFor({ visuallyImpaired: true });
	// The field holds one value, and the standard's codes are mutually exclusive
	const both = await audioTypeFor({ hearingImpaired: true, visuallyImpaired: true });

	const audioPid = [...plain.keys()].find(pid => plain.get(pid)!.startsWith('fra'))!;
	expect(plain.get(audioPid)).toBe('fra/0');
	expect(hearing.get(audioPid)).toBe('fra/2');
	expect(visual.get(audioPid)).toBe('fra/3');
	expect(both.get(audioPid)).toBe('fra/3');

	// Only audio carries an audio_type; the same flags on video state nothing
	const videoPid = [...plain.keys()].find(pid => plain.get(pid)!.startsWith('deu'))!;
	expect(visual.get(videoPid)).toBe('deu/0');
}, 60_000);

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

	// The clock starts before the media does. A PID that carries no essence has nothing to state its
	// first PCR, so the muxer has to write one itself ahead of the first media packet - otherwise the
	// stream opens with an interval's worth of packets no receiver can time.
	const firstPcrOnly = [...Array(Math.floor(bytes.byteLength / PACKET)).keys()]
		.find(index => (((bytes[index * PACKET + 1]! & 0x1f) << 8) | bytes[index * PACKET + 2]!) === 500);
	const firstMedia = [...Array(Math.floor(bytes.byteLength / PACKET)).keys()]
		.find(index => (((bytes[index * PACKET + 1]! & 0x1f) << 8) | bytes[index * PACKET + 2]!) === 481);
	expect(firstPcrOnly).toBeDefined();
	expect(firstMedia).toBeDefined();
	expect(firstPcrOnly!).toBeLessThan(firstMedia!);
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

// The PMT is written here, so the only thing that settles whether a receiver *reads* a cue stream as one
// is a receiver. ffprobe reports a PID it cannot place as `unknown`, which is the symptom this answers.
test('ffprobe reads the SCTE-35 PID as a cue stream, not as unknown', async () => {
	const probe = (() => {
		try {
			execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
			return true;
		} catch (error) {
			return (error as { code?: string }).code !== 'ENOENT';
		}
	})();
	if (!probe) {
		return;
	}

	const bytes = await buildStream();
	const directory = mkdtempSync(path.join(tmpdir(), 'scte35-'));
	const file = path.join(directory, 'cue.ts');

	try {
		writeFileSync(file, bytes);
		const streams = JSON.parse(execFileSync('ffprobe', [
			'-v', 'quiet', '-print_format', 'json', '-show_streams', file,
		], { encoding: 'utf8' })) as { streams: { codec_name?: string; id?: string }[] };

		const names = streams.streams.map(s => s.codec_name ?? 'none');
		// 0x1f00 is the PID buildStream declares; ffprobe prints stream ids in hex
		const cue = streams.streams.find(s => s.id === '0x1f00');

		expect(cue, `no stream at the SCTE-35 PID; ffprobe saw ${JSON.stringify(names)}`).toBeDefined();
		expect(cue!.codec_name, `ffprobe saw ${JSON.stringify(names)}`).toBe('scte_35');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);

// A quiet stream is where the clock goes missing. ISO/IEC 13818-1 2.4.2.1 puts 0.1 s between PCRs as
// a maximum, and under a constant rate the gap between one media packet and the next is filled with
// null packets - none of which carries a PCR. The muxer used to let the PCR track's own packet spacing
// decide the PCR spacing, so a programme whose picture arrives slowly got PCRs as slowly: 0.15 s at
// 6.67 fps, a full second at 1 fps, whatever `pcrInterval` asked for.

/** `count` frames of the same picture at `fps`, so almost all of a 3 Mb/s rate is padding. */
const stillStream = async (fps: number, count: number, options: MpegTsOutputFormatOptions) => {
	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 2) {
			break;
		}
	}

	const output = new Output({ format: new MpegTsOutputFormat(options), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < count; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / fps, 1 / fps),
			{ decoderConfig: config },
		);
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

/** Every PCR in the stream, in seconds, read off the 33-bit base. */
const pcrSeconds = (bytes: Uint8Array) => {
	const out: number[] = [];
	for (let at = 0; at + PACKET <= bytes.byteLength; at += PACKET) {
		const control = (bytes[at + 3]! >> 4) & 0x3;
		if ((control === 2 || control === 3) && bytes[at + 4]! >= 7 && (bytes[at + 5]! & 0x10)) {
			out.push((bytes[at + 6]! * 2 ** 25
				+ bytes[at + 7]! * 2 ** 17
				+ bytes[at + 8]! * 2 ** 9
				+ bytes[at + 9]! * 2
				+ ((bytes[at + 10]! >> 7) & 0x1)) / 90_000);
		}
	}
	return out;
};

test('a CBR stream keeps the PCR interval through the null padding, however slowly it is fed', async () => {
	const muxRate = 3_000_000;
	const packetTime = PACKET * 8 / muxRate;

	for (const [fps, count, pcrInterval] of [[25, 75, 0.03], [20 / 3, 20, 0.03], [2, 6, 0.03], [1, 4, 0.04]] as const) {
		const bytes = await stillStream(fps, count, { muxRate, pcrInterval, trackPids: [481] });
		const pcrs = pcrSeconds(bytes);
		const gaps = pcrs.slice(1).map((value, index) => value - pcrs[index]!);
		const worst = Math.max(...gaps);
		const label = `${fps} fps, pcrInterval ${pcrInterval}`;

		// The standard's own ceiling, which the PCR track's spacing used to blow straight through
		expect(worst, `${label}: 13818-1 allows 0.1 s`).toBeLessThanOrEqual(0.1);

		// And the interval the caller actually asked for. The slack is the table burst: a PAT, PMT and
		// SDT repeat is written in front of a media packet, after the last filled PCR, so it rides
		// between the two and pushes them apart by its own length.
		expect(worst, `${label}: within the stated interval`).toBeLessThanOrEqual(pcrInterval + 8 * packetTime);

		// Filling is not the same as flooding: one per interval over the stream's length, give or take
		// the media packets that carry their own
		const duration = count / fps;
		expect(pcrs.length, `${label}: count`).toBeGreaterThan(duration / pcrInterval - 2);
		expect(pcrs.length, `${label}: count`).toBeLessThan(2 * duration / pcrInterval + count + 4);
	}
}, 120_000);

test('a PCR track spaced exactly at pcrInterval gets no redundant PCRs', async () => {
	// 25 fps against the 0.04 s default is the case where `last + interval` and the next packet's time
	// are equal in decimal and differ in the last bit of a double. Filling on that comparison adds a
	// PCR a hair before every frame - harmless-looking, except it also moves the clock a table inherits.
	//
	// Stated without a mux rate on purpose: that comparison is the *timestamp* path, which is what a
	// variable-rate stream uses. A constant rate spaces by the byte clock instead and legitimately
	// emits more than one per frame, so running this at a rate would be measuring the other mechanism.
	const bytes = await stillStream(25, 50, { pcrInterval: 0.04, trackPids: [481] });
	const pcrs = pcrSeconds(bytes);

	// One per frame, from the frames themselves - not two
	expect(pcrs.length).toBeLessThanOrEqual(52);
	expect(pcrs.length).toBeGreaterThanOrEqual(50);
});

test('the PCR interval holds when other PIDs and null padding fill the byte clock', async () => {
	// The single-track test above cannot catch this. With audio, tables and nulls also advancing the
	// byte clock, a fill spaced by *stream time* finds the clock already past every instant it wanted
	// a PCR at, so the whole interval's worth comes out in a burst at the next video frame - seven
	// PCRs one packet apart - and the stretch between frames carries none. Measured on a consumer's
	// 3 Mb/s multiplex before this: gaps of 0.16 s against a stated 0.03.
	const muxRate = 3_000_000;
	const pcrInterval = 0.03;
	const bytes = await replay('demo.mp4', 'avc', 2, {
		...BROADCAST,
		muxRate,
		pcrInterval,
		patInterval: 0.1,
		pmtInterval: 0.2,
	});

	const pcrs = pcrSeconds(bytes);
	const gaps = pcrs.slice(1).map((value, index) => value - pcrs[index]!);
	const worst = Math.max(...gaps);

	expect(pcrs.length).toBeGreaterThan(40);
	expect(worst, 'within the stated interval, whatever else is in the multiplex')
		.toBeLessThanOrEqual(pcrInterval + 8 * (PACKET * 8 / muxRate));
	expect(worst, '13818-1 allows 0.1 s').toBeLessThanOrEqual(0.1);

	// And they are spread rather than bunched: a burst would leave most gaps at one packet time
	const onePacket = PACKET * 8 / muxRate;
	const bunched = gaps.filter(gap => gap <= onePacket * 1.5).length;
	expect(bunched, 'PCRs one packet apart are a burst, not spacing').toBeLessThan(gaps.length / 4);
});

// SCTE-35 out of an input. A channel reading a transport stream has to carry the source's splices,
// and the demuxer recognised a cue stream only well enough to stop warning about it - the sections
// themselves reached nobody. They are events rather than a track because they are not media: no
// samples, no codec, no duration, and a reader that had to pull a track to see a splice would have to
// keep pulling it in step with the media to see one in time.

/** A minimal well-formed `splice_info_section` carrying a `time_signal`. */
const spliceSection = (spliceTime: number) => {
	const bits33 = (value: number, leadingFlags: number) => [
		leadingFlags | (Math.floor(value / 2 ** 32) & 1),
		(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
	];
	const command = bits33(spliceTime, 0xfe);
	const body = [
		0, // protocol_version
		...bits33(0, 0x00), // not encrypted, pts_adjustment 0
		0xff, // cw_index
		0, 0, // tier + splice_command_length high
		command.length, // splice_command_length low
		0x06, // time_signal
		...command,
		0, 0, // descriptor_loop_length
	];

	// section_syntax_indicator=0, private=1, reserved, then the 12-bit length (body + 4 CRC octets)
	const length = body.length + 4;
	const header = [0xfc, 0x30 | ((length >> 8) & 0x0f), length & 0xff];
	const section = Uint8Array.from([...header, ...body, 0, 0, 0, 0]);
	return section;
};

test('an SCTE-35 cue section written into a stream is announced when it is read back', async () => {
	const cuePid = 0x1f00;
	const section = spliceSection(900_000);

	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 2) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({ scte35Pid: cuePid, trackPids: [481] }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	for (let i = 0; i < 20; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	addScte35Section(output, section);
	for (let i = 20; i < 40; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);

	// Listening before the read, because they are emitted as the bytes carrying them are parsed
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const events: { scheme: string; data: Uint8Array; timestamp: number | null }[] = [];
	input.on('inbandEvent', event => void events.push(event));

	const readTrack = (await input.getPrimaryVideoTrack())!;
	for await (const packet of new EncodedPacketSink(readTrack).packets()) {
		void packet;
	}

	expect(events.length).toBeGreaterThan(0);
	expect(events[0]!.scheme).toBe('urn:scte:scte35:2013:bin');
	// The section exactly as it was carried, so a consumer can parse it with whatever it already has
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(section));
	// The splice time the section itself states - pts_adjustment plus the command's splice_time - so a
	// consumer gets a time on the same clock as the packets rather than having to parse the payload
	expect(events[0]!.timestamp).toBeCloseTo(10, 6); // 900_000 ticks of 90 kHz

	// Sections repeat and a read re-reads; the same splice must not be announced twice
	const unique = new Set(events.map(event => bytesToHexString(event.data)));
	expect(unique.size).toBe(1);
	expect(events.length).toBe(1);

	// Reading it again from the same input does not announce it again - a consumer that seeks back
	// must not be told to insert the same break a second time
	const second = new EncodedPacketSink(readTrack);
	for await (const packet of second.packets()) {
		void packet;
	}
	expect(events.length).toBe(1);

	// A cue PID carrying something that is not a splice_info_section is not a splice. Flipping the
	// table_id in the written stream is the cheapest way to produce one.
	const tampered = Uint8Array.from(bytes);
	for (let at = 0; at + 188 <= tampered.length; at += 188) {
		const pid = ((tampered[at + 1]! & 0x1f) << 8) | tampered[at + 2]!;
		if (pid !== cuePid) {
			continue;
		}
		// payload starts after the 4-byte header, then a pointer_field
		const payloadAt = at + 4;
		const tableAt = payloadAt + 1 + tampered[payloadAt]!;
		expect(tampered[tableAt]).toBe(0xfc);
		tampered[tableAt] = 0x00;
	}

	// Our muxer writes cue sections at the head of the stream, so only the metadata walk sees them.
	// A broadcast stream carries one at the splice point instead, where the per-track reader is what
	// walks past it - and where a seek back over it would announce it a second time. Splicing a copy
	// of the cue packet into the middle is how that stream is produced here.
	const cueAt = (() => {
		for (let at = 0; at + 188 <= bytes.length; at += 188) {
			const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
			if (pid === cuePid) {
				return at;
			}
		}
		return -1;
	})();
	expect(cueAt).toBeGreaterThanOrEqual(0);

	// Near the end, and carrying a DIFFERENT splice, so it cannot be mistaken for the one at the head
	// and so it sits past where metadata discovery stops walking
	const late = Math.floor(Math.floor(bytes.length / 188) * 0.9) * 188;
	const lateCuePacket = Uint8Array.from(bytes.subarray(cueAt, cueAt + 188));
	const lateTableAt = 4 + 1 + lateCuePacket[4]!;
	// splice_command_length sits after protocol_version and pts_adjustment; the splice time follows
	lateCuePacket[lateTableAt + 12] = 0x55;

	const withMidStreamCue = new Uint8Array(bytes.length + 188);
	withMidStreamCue.set(bytes.subarray(0, late), 0);
	withMidStreamCue.set(lateCuePacket, late);
	withMidStreamCue.set(bytes.subarray(late), late + 188);

	using midStream = new Input({
		source: new BufferSource(withMidStreamCue.buffer),
		formats: ALL_FORMATS,
	});
	const midEvents: unknown[] = [];
	midStream.on('inbandEvent', event => void midEvents.push(event));
	const midTrack = (await midStream.getPrimaryVideoTrack())!;
	const midSink = new EncodedPacketSink(midTrack);
	for await (const packet of midSink.packets()) {
		void packet;
	}
	// Both: the one at the head and the distinct one near the end. The second sits past where
	// metadata discovery stops, so only the reader walking packets finds it.
	expect(midEvents.length, 'a splice past the head is announced too').toBe(2);

	// Read it again from the start: the reader walks both cue packets a second time, and neither
	// splice must be announced again
	for await (const packet of midSink.packets()) {
		void packet;
	}
	expect(midEvents.length, 'a re-read must not announce the same splices twice').toBe(2);

	expect(await eventsOf(tampered)).toHaveLength(0);
}, 120_000);

const eventsOf = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const events: unknown[] = [];
	input.on('inbandEvent', event => void events.push(event));
	const track = (await input.getPrimaryVideoTrack())!;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		void packet;
	}
	return events;
};

const tracksOf = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	return (await input.getTracks()).length;
};

// A segmented writer's one invariant: the bytes written for frames A have to be a prefix of the bytes
// written for A then B. An LL-HLS transport-stream segment is served as its parts joined, so if each
// part's remux ends in something of its own, a segment fetched part by part differs from the same
// segment fetched whole.
test('under a variable rate, nothing is written after the last PES', async () => {
	const mux = async (frames: number) => {
		using source = new Input({
			source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
			formats: ALL_FORMATS,
		});
		const track = (await source.getPrimaryVideoTrack())!;
		const config = (await track.getDecoderConfig())!;
		const sample: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			sample.push(packet);
			if (sample.length === 2) {
				break;
			}
		}

		const output = new Output({
			// No mux rate: nothing pads, so nothing should follow the last PES
			format: new MpegTsOutputFormat({
				tableRepeatInterval: Infinity,
				trackPids: [0x100],
				// Smaller than a frame, so a fill at the end has somewhere to put several PCRs. At the
				// default 0.04 one frame is exactly one interval and the fill writes nothing, which
				// would make this test agree with a muxer that still had the bug.
				pcrInterval: 0.01,
			}),
			target: new BufferTarget(),
		});
		const videoSource = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(videoSource);
		await output.start();
		for (let i = 0; i < frames; i++) {
			await videoSource.add(
				new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
				{ decoderConfig: config },
			);
		}
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const part = await mux(10);
	const whole = await mux(20);

	// Nothing adaptation-field-only on the track's PID at the end: a PCR there sits past the last
	// frame with nothing after it to pace
	const lastPacket = part.subarray(part.length - PACKET);
	const lastPid = ((lastPacket[1]! & 0x1f) << 8) | lastPacket[2]!;
	const lastControl = (lastPacket[3]! >> 4) & 0x3;
	expect(lastPid).toBe(0x100);
	expect(lastControl, 'the stream ends on a packet carrying payload').not.toBe(2);

	// And the prefix invariant itself, which is what that costs when it is broken. Continuity
	// counters are restamped by a segmenter, so they are masked rather than compared.
	const withoutCc = (bytes: Uint8Array) => {
		const copy = Uint8Array.from(bytes);
		for (let at = 0; at + PACKET <= copy.length; at += PACKET) {
			copy[at + 3] = copy[at + 3]! & 0xf0;
		}
		return copy;
	};

	expect(part.length).toBeLessThan(whole.length);
	expect(bytesToHexString(withoutCc(part)))
		.toBe(bytesToHexString(withoutCc(whole.subarray(0, part.length))));
}, 120_000);

test('a timed ID3 tag is announced with the time it states', async () => {
	// ID3 rides PES packets rather than sections, so unlike a cue section it carries a presentation
	// time of its own - and that time is this input's, which is why this event has one and a splice
	// does not.
	const id3Pid = 0x1f10;
	const tag = (() => {
		// A minimal ID3v2.4 tag with one TXXX frame
		const frameBody = [0x03, ...new TextEncoder().encode('k\0v')];
		const frame = [
			...new TextEncoder().encode('TXXX'),
			0, 0, 0, frameBody.length, // synchsafe size, small enough to be the same either way
			0, 0,
			...frameBody,
		];
		return Uint8Array.from([
			...new TextEncoder().encode('ID3'),
			4, 0, // version 2.4
			0, // flags
			0, 0, 0, frame.length, // synchsafe size
			...frame,
		]);
	})();

	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 2) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({ timedMetadataPid: id3Pid, trackPids: [481] }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	for (let i = 0; i < 30; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	addId3Metadata(output, { time: 0.4, data: tag });
	for (let i = 30; i < 60; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	using input = new Input({ source: new BufferSource(bytes.buffer), formats: ALL_FORMATS });
	const events: { scheme: string; data: Uint8Array; timestamp: number | null }[] = [];
	input.on('inbandEvent', event => void events.push(event));

	const readTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(readTrack);
	for await (const packet of sink.packets()) {
		void packet;
	}

	expect(events).toHaveLength(1);
	expect(events[0]!.scheme).toBe('https://aomedia.org/emsg/ID3');
	// The complete tag, header included, exactly as it was handed over
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(tag));
	// And the time it was written at, which a splice cannot state from outside its payload
	expect(events[0]!.timestamp).toBeCloseTo(0.4, 2);

	// A re-read must not announce it again
	for await (const packet of sink.packets()) {
		void packet;
	}
	expect(events).toHaveLength(1);

	// A payload on this PID that is not an ID3 tag is not one, whatever the descriptor claimed.
	// Flipping the magic in the written stream is the cheapest way to produce that.
	const tampered = Uint8Array.from(bytes);
	for (let at = 0; at + PACKET <= tampered.length; at += PACKET) {
		const pid = ((tampered[at + 1]! & 0x1f) << 8) | tampered[at + 2]!;
		if (pid !== id3Pid || (tampered[at + 1]! & 0x40) === 0) {
			continue;
		}
		// payload after the 4-octet header and any adaptation field, then the fixed PES header and the
		// optional part whose length it states
		const hasAdaptation = (tampered[at + 3]! & 0x20) !== 0;
		const payloadAt = at + 4 + (hasAdaptation ? 1 + tampered[at + 4]! : 0);
		const magicAt = payloadAt + 9 + tampered[payloadAt + 8]!;
		expect(tampered[magicAt]).toBe(0x49);
		tampered[magicAt] = 0x58;
	}

	expect(await eventsOf(tampered)).toHaveLength(0);

	// A metadata stream that declares some other format is not an ID3 stream, even when what rides it
	// happens to start with the magic. Rewriting the descriptor's two format identifiers in every PMT
	// is what produces one.
	const relabelled = Uint8Array.from(bytes);
	let pmtsSeen = 0;
	for (let at = 0; at + PACKET <= relabelled.length; at += PACKET) {
		if ((relabelled[at + 1]! & 0x40) === 0 || (relabelled[at + 3]! & 0x20) !== 0) {
			continue;
		}
		const sectionAt = at + 4 + 1 + relabelled[at + 4]!; // after pointer_field
		if (relabelled[sectionAt] !== 0x02) {
			continue; // not a PMT
		}
		// section_length counts from the octet after itself, and the last four of those are the CRC
		const sectionLength = ((relabelled[sectionAt + 1]! & 0x0f) << 8) | relabelled[sectionAt + 2]!;
		const crcAt = sectionAt + 3 + sectionLength - 4;
		let found = 0;
		for (let i = sectionAt; i < crcAt - 3; i++) {
			if (
				relabelled[i] === 0x49 && relabelled[i + 1] === 0x44
				&& relabelled[i + 2] === 0x33 && relabelled[i + 3] === 0x20
			) {
				relabelled.set([0x4b, 0x4c, 0x56, 0x41], i); // 'KLVA'
				found++;
			}
		}
		expect(found).toBe(2); // metadata_descriptor states the format twice

		const crc = computeMpegTsCrc32(relabelled.subarray(sectionAt, crcAt));
		relabelled[crcAt] = (crc >>> 24) & 0xff;
		relabelled[crcAt + 1] = (crc >>> 16) & 0xff;
		relabelled[crcAt + 2] = (crc >>> 8) & 0xff;
		relabelled[crcAt + 3] = crc & 0xff;
		pmtsSeen++;
	}
	expect(pmtsSeen).toBeGreaterThan(0);

	expect(await eventsOf(relabelled)).toHaveLength(0);
	// and the rewrite itself did not simply break the stream
	expect(await tracksOf(relabelled)).toBe(1);
}, 120_000);

test('a tag written at the head of the stream is announced too', async () => {
	// Written at time zero it sits before the track's first packet, where the per-track reader never
	// walks - the same split as a cue section, and the reason metadata discovery has to see these PIDs
	const id3Pid = 0x1f10;
	const tag = Uint8Array.from([
		...new TextEncoder().encode('ID3'), 4, 0, 0, 0, 0, 0, 10,
		...new TextEncoder().encode('TXXX'), 0, 0, 0, 2, 0, 0, 0x03, 0,
	]);

	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 2) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({ timedMetadataPid: id3Pid, trackPids: [481] }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	addId3Metadata(output, { time: 0, data: tag });
	for (let i = 0; i < 20; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!).buffer),
		formats: ALL_FORMATS,
	});
	const events: { data: Uint8Array }[] = [];
	input.on('inbandEvent', event => void events.push(event));
	const readTrack = (await input.getPrimaryVideoTrack())!;
	for await (const packet of new EncodedPacketSink(readTrack).packets()) {
		void packet;
	}

	expect(events).toHaveLength(1);
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(tag));
}, 120_000);

test('a cue PID does not make a reader wait for the rest of the feed', async () => {
	// A cue stream is sparse - two splices in fourteen seconds - and `readSection` ends a section at
	// the next payload-unit start on the SAME PID, skipping everything between. On such a PID that is
	// seconds of packets away, or never, so a reader walking past a cue packet waited for the end of
	// the feed before it could yield its own first packet. Over a file that is invisible: the bytes
	// are already there. Over a live source every packet arrives at once, at the end.
	const cuePid = 0x1f00;
	const section = spliceSection(900_000);

	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 2) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({ scte35Pid: cuePid, trackPids: [481] }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	addScte35Section(output, section);
	for (let i = 0; i < 200; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	// The cue sits in the first few packets, so a feed that stops just after it still holds every byte
	// the first media packet needs - and nothing after. A read that waits for more never returns,
	// which is the stall itself rather than a slow version of it.
	const servedBytes = PACKET * Math.floor(0.6 * bytes.length / PACKET);
	expect(servedBytes).toBeLessThan(bytes.length);

	let served = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (served) {
				return new Promise<void>(() => {}); // The rest of the feed has not arrived yet
			}
			served = true;
			controller.enqueue(bytes.subarray(0, servedBytes));
		},
	});

	using input = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });

	// The whole read, not just the packet: a read that waits for the rest of the feed stalls while
	// opening the input just as readily as while pulling packets
	const stall = Symbol('waited for the rest of the feed');
	const first = await Promise.race([
		(async () => {
			const readTrack = (await input.getPrimaryVideoTrack())!;
			return new EncodedPacketSink(readTrack).getFirstPacket();
		})(),
		new Promise(resolve => setTimeout(() => resolve(stall), 10_000)),
	]);

	expect(first).not.toBe(stall);
	expect((first as EncodedPacket).timestamp).toBe(0);
}, 120_000);

test('a cue section whose packets are not contiguous is still read whole', async () => {
	// The bounded read stops at the first foreign packet, which is all of a section that fits in one
	// packet - every section this library writes. A section long enough to span two, with something
	// else muxed between them, is the layout that needs the unbounded read, and truncating it there
	// would hand a receiver half a splice.
	const cuePid = 0x1f00;
	const section = (() => {
		// A time_signal followed by a descriptor loop long enough to push the section over one packet
		const bits33 = (value: number, leadingFlags: number) => [
			leadingFlags | (Math.floor(value / 2 ** 32) & 1),
			(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
		];
		const command = bits33(900_000, 0xfe);
		// tag 0x00, length 250: 'CUEI' plus padding, which a receiver that does not know it skips
		const padding = Array.from({ length: 246 }, () => 0x5a);
		const descriptor = [0x00, 250, ...new TextEncoder().encode('CUEI'), ...padding];
		const body = [
			0,
			...bits33(0, 0x00),
			0xff,
			0, 0,
			command.length,
			0x06,
			...command,
			(descriptor.length >> 8) & 0xff, descriptor.length & 0xff,
			...descriptor,
		];
		const length = body.length + 4;
		return Uint8Array.from([0xfc, 0x30 | ((length >> 8) & 0x0f), length & 0xff, ...body, 0, 0, 0, 0]);
	})();
	expect(section.length).toBeGreaterThan(184); // More than one packet's payload

	using source = new Input({
		source: new FilePathSource(new URL('../public/demo.mp4', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = (await source.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const sample: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sample.push(packet);
		if (sample.length === 2) {
			break;
		}
	}

	const output = new Output({
		format: new MpegTsOutputFormat({ scte35Pid: cuePid, trackPids: [481] }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	addScte35Section(output, section);
	for (let i = 0; i < 40; i++) {
		await videoSource.add(
			new EncodedPacket(sample[i % 2]!.data, i === 0 ? 'key' : 'delta', i / 25, 1 / 25),
			{ decoderConfig: config },
		);
	}
	await output.finalize();
	const written = new Uint8Array(output.target.buffer!);

	// The two cue packets, which the muxer wrote back to back
	const cueAt: number[] = [];
	for (let at = 0; at + PACKET <= written.length; at += PACKET) {
		if ((((written[at + 1]! & 0x1f) << 8) | written[at + 2]!) === cuePid) {
			cueAt.push(at);
		}
	}
	expect(cueAt).toHaveLength(2);
	const [firstCue, secondCue] = cueAt as [number, number];
	expect(secondCue).toBe(firstCue + PACKET);

	// Move a media packet between them, which is what the bounded read stops at
	const foreign = written.subarray(firstCue - PACKET, firstCue);
	const spliced = new Uint8Array(written.length);
	spliced.set(written.subarray(0, secondCue), 0);
	spliced.set(foreign, secondCue);
	spliced.set(written.subarray(secondCue, written.length - PACKET), secondCue + PACKET);

	using input = new Input({ source: new BufferSource(spliced.buffer), formats: ALL_FORMATS });
	const events: { data: Uint8Array }[] = [];
	input.on('inbandEvent', event => void events.push(event));
	const readTrack = (await input.getPrimaryVideoTrack())!;
	for await (const packet of new EncodedPacketSink(readTrack).packets()) {
		void packet;
	}

	expect(events).toHaveLength(1);
	expect(bytesToHexString(events[0]!.data)).toBe(bytesToHexString(section));
}, 120_000);
