import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { Conversion } from '../../src/conversion.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, HlsOutputFormat } from '../../src/output-format.js';
import { ReadableStreamSource } from '../../src/source.js';
import { readFileSync } from 'node:fs';
import { NetworkSource, registerMediabunnyServer } from '@mediabunny/server';
import { RtpDepacketizer } from '../../packages/server/src/rtp.js';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil } from './_network-test.js';
import { assert } from '../../src/misc.js';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SENDER = path.join(__dirname, '_live-sender.ts');
const FIXTURE = path.join(__dirname, '../public/video.mp4');

// A listener URL has to name a port, so they are spread out to avoid a lingering socket from a rerun.
let nextPort = 21_000 + Math.floor(Math.random() * 2_000);
const freePort = () => nextPort++;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Strips `mode=listener`, or both ends would sit waiting to be connected to.
const callerUrlFor = (listenerUrl: string): string => {
	const url = new URL(listenerUrl);
	url.search = '';
	return url.toString();
};

// `node --import tsx`, not the tsx binary: that one forks a child, so killing it orphans the child,
// which keeps its socket open and its CPU busy for every later test run.
const startSenderAt = (url: string, extra: string[] = [], source = FIXTURE) =>
	spawn(process.execPath, ['--import', 'tsx', SENDER, source, url, ...extra], { stdio: 'ignore' });

// The accept only starts when the Input first reads, so reading is kicked off before the sender.
const readWhileSending = async <T>(
	url: string,
	senderArgs: string[],
	consume: (input: Input) => Promise<T>,
	readTimeout = 10,
): Promise<T> => {
	const source = new NetworkSource(url, { connectTimeout: 15, readTimeout });
	using input = new Input({ source, formats: ALL_FORMATS });
	const reading = consume(input);
	await sleep(250);
	const sender = startSenderAt(callerUrlFor(url), senderArgs);
	try {
		return await reading;
	} finally {
		sender.kill('SIGKILL');
	}
};

// Both bounds matter: an upper bound alone passes on any instant failure, which is how RTMP once looked
// bounded when it was only refusing to connect.
test.each([
	['srt', (p: number) => `srt://127.0.0.1:${p}?mode=listener`],
	['tcp', (p: number) => `tcp://127.0.0.1:${p}?listen=1`],
])('%s: a listener nobody connects to waits connectTimeout, then fails', async (_scheme, makeUrl) => {
	const connectTimeout = 2;
	using input = new Input({
		source: new NetworkSource(makeUrl(freePort()), { connectTimeout, readTimeout: connectTimeout }),
		formats: ALL_FORMATS,
	});

	const startedAt = Date.now();
	await expect(input.getFormat()).rejects.toThrow();
	const elapsed = Date.now() - startedAt;

	expect(elapsed, `failed in ${elapsed}ms, too fast to have waited — it never listened`)
		.toBeGreaterThan(connectTimeout * 1000 * 0.5);
	expect(elapsed, `took ${elapsed}ms, so the bound did not apply`).toBeLessThan(12_000);
}, 30_000);

test('rtmp is refused with its reason, rather than silently unbounded', () => {
	expect(() => new NetworkSource('rtmp://0.0.0.0:1935/live/x?listen=1')).toThrow(/ignores URL query options/);
	expect(() => new NetworkSource('rtmps://0.0.0.0:1935/live/x')).toThrow(/ignores URL query options/);
});

test('srt: a live listener reads what an encoder sends, and ends when it stops', async () => {
	const url = `srt://127.0.0.1:${freePort()}?mode=listener`;

	const { codec, width, wasLive, timestamps } = await readWhileSending(url, [], async (input) => {
		const track = await input.getPrimaryVideoTrack();
		expect(track).not.toBeNull();

		// Sampled before draining: liveness ends with the stream, so after the loop it is false by
		// design.
		const codec = await track!.getCodec();
		const width = await track!.getDisplayWidth();
		const wasLive = await track!.isLive();

		const read: number[] = [];
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			read.push(packet.timestamp);
		}
		return { codec, width, wasLive, timestamps: read };
	});

	expect(codec).toBe('avc');
	expect(width).toBe(1920);
	expect(wasLive).toBe(true);
	expect(timestamps.length).toBeGreaterThan(50);

	const sorted = [...timestamps].sort((a, b) => a - b);
	// Arrival is decode order, so presentation timestamps are legitimately jumbled for this B-frame
	// fixture — their SET proves nothing was lost, not their order, and even spacing is what a dropped
	// packet would break.
	expect(timestamps).not.toEqual(sorted);
	const gaps = sorted.slice(1).map((t, i) => Number((t - sorted[i]!).toFixed(4)));
	expect(new Set(gaps).size, `uneven spacing: ${[...new Set(gaps)].join(', ')}`).toBe(1);
}, 90_000);

test('srt: a caller dials out to a listening sender', async () => {
	const port = freePort();
	// Roles swapped: the sender listens, we connect to it. The sender must be up first.
	const sender = startSenderAt(`srt://0.0.0.0:${port}?mode=listener`);
	await sleep(500);

	const timestamps: number[] = [];
	let wasLive: boolean | null = null;
	try {
		using input = new Input({
			source: new NetworkSource(`srt://127.0.0.1:${port}`, { connectTimeout: 15, readTimeout: 10 }),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		wasLive = await track!.isLive();
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			timestamps.push(packet.timestamp);
		}
	} finally {
		sender.kill();
	}

	expect(wasLive).toBe(true);
	expect(timestamps.length).toBeGreaterThan(50);
}, 90_000);

test('a caller that nobody is listening for fails inside its bounds', async () => {
	using input = new Input({
		source: new NetworkSource(`srt://127.0.0.1:${freePort()}`, { connectTimeout: 2, readTimeout: 2 }),
		formats: ALL_FORMATS,
	});

	const startedAt = Date.now();
	await expect(input.getFormat()).rejects.toThrow();
	expect(Date.now() - startedAt).toBeLessThan(12_000);
}, 30_000);

test('srt: a sender that vanishes mid-stream ends the input inside the read bound', async () => {
	const url = `srt://127.0.0.1:${freePort()}?mode=listener`;
	const readTimeout = 2;
	const startedAt = Date.now();

	// --stop-after exits without draining or a trailer: what a crashed encoder looks like on the wire.
	const { received, threw } = await readWhileSending(url, ['--stop-after=40'], async (input) => {
		let count = 0;
		try {
			const track = await input.getPrimaryVideoTrack();
			const packets = new EncodedPacketSink(track!).packets();
			while (!(await packets.next()).done) {
				count++;
			}
			return { received: count, threw: null as unknown };
		} catch (error) {
			return { received: count, threw: error };
		}
	}, readTimeout);

	const elapsed = Date.now() - startedAt;
	expect(received).toBeGreaterThan(0);
	// A clean end or a typed error both pass; hanging does not.
	expect(elapsed, `took ${elapsed}ms: neither a clean end nor an error arrived in time`)
		.toBeLessThan(readTimeout * 1000 + 15_000);
	if (threw !== null) {
		expect(threw).toBeInstanceOf(Error);
	}
}, 60_000);

test('an unsupported scheme and a malformed URL are rejected before any connection', () => {
	expect(() => new NetworkSource('ftp://example.com/x')).toThrow(TypeError);
	expect(() => new NetworkSource('not a url')).toThrow(TypeError);
	expect(() => new NetworkSource('srt://127.0.0.1:9000', { connectTimeout: 0 })).toThrow(TypeError);
});

// NetworkSource is not the only live-shaped source, and MPEG-TS is not the only live-shaped container:
// fragmented MP4 over a socket is DASH-IF ingest. Liveness comes from the source, so it must reach any
// demuxer, and it must stop once the stream ends the way a playlist's does at EXT-X-ENDLIST.
const streamOf = (bytes: Uint8Array, end: boolean) => new ReadableStream<Uint8Array>({
	start(controller) {
		controller.enqueue(bytes);
		if (end) {
			controller.close();
		}
	},
});

test('a declared source is live until its stream ends', async () => {
	const bytes = new Uint8Array(readFileSync(FIXTURE));

	// Before anything reads it, the declaration stands on its own.
	const live = new ReadableStreamSource(streamOf(bytes, false), { liveRefreshInterval: 0 });
	expect(live._getLiveRefreshInterval()).toBe(0);

	// Undeclared is never live, however it is read.
	expect(new ReadableStreamSource(streamOf(bytes, true))._getLiveRefreshInterval()).toBe(null);

	// And once a demuxer has read an ended stream to its end, the source stops claiming liveness —
	// isobmff here, which the eight-demuxer fan-out used to be needed for.
	using input = new Input({
		source: new ReadableStreamSource(streamOf(bytes, true), { liveRefreshInterval: 0 }),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	expect(await track!.isLive()).toBe(false);
}, 30_000);

// A live input has no end, so `cancel()` was the only way to stop — and it discards the open segment,
// which costs a segment of latency for anyone who must mark the last one. `finish()` stops reading and
// finalizes instead, so the last segment is complete.
test('srt: finish() ends a live conversion with a complete output, where cancel() would discard it', async () => {
	const url = `srt://127.0.0.1:${freePort()}?mode=listener`;
	const segments: number[] = [];
	let playlist = '';

	const source = new NetworkSource(url, { connectTimeout: 15, readTimeout: 10 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			onSegment: (_target, info) => {
				segments.push(info.n);
			},
			onPlaylist: (content) => {
				playlist = content;
			},
		}),
		target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
	});

	// Conversion.init probes the input, which is what starts the accept — so the sender has to appear
	// while init is in flight, not after it.
	const initing = Conversion.init({ input, output });
	await sleep(250);
	// demo.mp4, not the usual fixture: that one has a single keyframe, and a segmenter can only cut on
	// one, so nothing would ever be segmented mid-stream.
	const sender = startSenderAt(callerUrlFor(url), [], path.join(__dirname, '../public/demo.mp4'));

	try {
		const conversion = await initing;
		const running = conversion.execute();

		// Polled, not slept: waiting on the thing itself rather than on a wall-clock guess at how long
		// it takes under load.
		const deadline = Date.now() + 30_000;
		while (segments.length === 0 && Date.now() < deadline) {
			await sleep(50);
		}
		expect(segments.length, 'nothing was segmented, so finishing proves nothing').toBeGreaterThan(0);

		const atFinish = segments.length;
		conversion.finish();

		// Resolves rather than throwing: that is the whole difference from cancel().
		await running;

		// The segment that was open when finish() was called is written, not discarded.
		expect(segments.length).toBeGreaterThan(atFinish);

		// A complete playlist: ended, and describing every segment the consumer was handed.
		expect(playlist).toContain('#EXT-X-ENDLIST');
		expect(playlist.match(/#EXTINF:/g)?.length ?? 0).toBeGreaterThanOrEqual(segments.length);
	} finally {
		sender.kill('SIGKILL');
	}
}, 90_000);

// Freeing the I/O context under a blocked native read aborts the process with "Invalid epoll ID", so both
// of these must leave a read genuinely parked; breaking out of a packet loop leaves nothing pulling.
const listeningInput = (readTimeout: number) => {
	const url = `srt://127.0.0.1:${freePort()}?mode=listener`;
	const source = new NetworkSource(url, { connectTimeout: 15, readTimeout });
	return { url, input: new Input({ source, formats: ALL_FORMATS }) };
};

test('srt: disposing a connected input while it is still reading does not abort the process', async () => {
	const { url, input } = listeningInput(3);

	let bytesRead = 0;
	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			bytesRead += packet.data.byteLength;
		}
	})().catch(() => {});

	await sleep(250);
	const sender = startSenderAt(callerUrlFor(url));
	try {
		await waitUntil(() => bytesRead > 0, 20_000, 'the srt input to read a packet');

		input.dispose();
		await sleep(1_500);
		await reading;
	} finally {
		sender.kill('SIGKILL');
	}
}, 60_000);

test('srt: disposing an input parked on a connected but silent sender does not abort the process', async () => {
	const { url, input } = listeningInput(20);
	const reading = input.getPrimaryVideoTrack().catch(() => null);

	await sleep(250);
	const sender = startSenderAt(callerUrlFor(url), ['--silent-after=2']);
	try {
		await sleep(1_500);
		input.dispose();
		await sleep(1_500);
		await reading;
	} finally {
		sender.kill('SIGKILL');
	}
}, 40_000);

// Timed on the stream's own cancel: Input.dispose fires it without awaiting, so dispose returns promptly
// whether or not the accept is still parked.
test('srt: cancelling a listener with no sender returns promptly', async () => {
	const source = new NetworkSource(`srt://127.0.0.1:${freePort()}?mode=listener`, {
		connectTimeout: 30,
		readTimeout: 30,
	});
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = input.getPrimaryVideoTrack().catch(() => null);
	await sleep(750);

	const reader = (source as unknown as { _reader: ReadableStreamDefaultReader<Uint8Array> | null })._reader;
	expect(reader).not.toBeNull();

	const started = Date.now();
	await reader!.cancel();
	const elapsed = (Date.now() - started) / 1000;
	// connectTimeout is 30 s, so anything near it means the accept was waited out rather than woken.
	expect(elapsed).toBeLessThan(5);

	await reading;
}, 60_000);

// A live feed that stops sending without closing leaves packets inside the demuxer and frames inside the
// decoder, and disposing the input abandons both. `end()` declares the stream over where it stopped, so the
// same bytes yield the same frames they would have had the stream closed itself.
const framesAfterStall = async (bytes: Uint8Array, stop: 'end' | 'dispose') => {
	const source = new ReadableStreamSource(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			// Never closed: this is a feed that went quiet, not one that ended
		},
	}), { liveRefreshInterval: 0 });

	const input = new Input({ source, formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	const frames: number[] = [];
	let done = false;
	const read = (async () => {
		for await (const sample of new VideoSampleSink(track).samples()) {
			frames.push(Math.round(sample.timestamp * 1000) / 1000);
			sample.close();
		}
	})().catch(() => {}).finally(() => {
		done = true;
	});

	// Wait for the iteration to be parked on bytes that will never come, rather than for a fixed delay
	let previous = -1;
	await waitUntil(
		() => {
			const stalled = frames.length > 0 && frames.length === previous;
			previous = frames.length;
			return stalled;
		},
		30_000,
		'the stalled feed to stop producing frames',
	);
	expect(done).toBe(false);

	if (stop === 'end') {
		source.end();
	} else {
		input.dispose();
	}

	await read;
	input.dispose();

	return frames;
};

test('end() drains a stalled live source, where disposing the input abandons what it holds', async () => {
	// Fragmented, so a prefix of the bytes is playable the way a live feed's are, and cut mid-GOP
	const whole = new Uint8Array(readFileSync(path.join(__dirname, '../public/bear-640x360-av_frag.mp4')));
	const bytes = whole.subarray(0, Math.floor(whole.length * 0.55));

	const cleanlyEnded = new Input({
		source: new ReadableStreamSource(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}), { liveRefreshInterval: 0 }),
		formats: ALL_FORMATS,
	});
	const expected: number[] = [];
	for await (const sample of new VideoSampleSink((await cleanlyEnded.getPrimaryVideoTrack())!).samples()) {
		expected.push(Math.round(sample.timestamp * 1000) / 1000);
		sample.close();
	}
	cleanlyEnded.dispose();
	expect(expected.length).toBeGreaterThan(0);

	// The whole point: the same bytes, every frame, without the stream having ended itself
	expect(await framesAfterStall(bytes, 'end')).toEqual(expected);

	// And what it costs not to: the frames the demuxer and decoder were still holding
	const disposed = await framesAfterStall(bytes, 'dispose');
	expect(disposed.length).toBeLessThan(expected.length);
}, 120_000);

// Ending a lost feed hands the demuxer whatever bytes arrived, so its last sample may be cut off; a decoder
// refusing one used to poison the serializer, leaving the close behind it rejecting with nothing awaiting it.
test('ending a feed mid-packet decodes both tracks without an unhandled rejection', async () => {
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', record);

	try {
		const whole = new Uint8Array(readFileSync(path.join(__dirname, '../public/193039199_mp4_h264_aac_fhd_7.ts')));
		// Not a multiple of 188, so the feed stops part-way through a transport packet
		const bytes = whole.subarray(0, 700_000 + 77);

		const source = new ReadableStreamSource(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
			},
		}), { liveRefreshInterval: 0 });

		const input = new Input({ source, formats: ALL_FORMATS });
		const videoTrack = await input.getPrimaryVideoTrack();
		const audioTrack = await input.getPrimaryAudioTrack();
		assert(videoTrack);
		assert(audioTrack);

		let videoFrames = 0;
		let audioFrames = 0;
		const reading = Promise.all([
			(async () => {
				for await (const sample of new VideoSampleSink(videoTrack).samples()) {
					videoFrames++;
					sample.close();
				}
			})(),
			(async () => {
				for await (const sample of new AudioSampleSink(audioTrack).samples()) {
					audioFrames++;
					sample.close();
				}
			})(),
		]);

		await waitUntil(() => videoFrames > 0 && audioFrames > 0, 30_000, 'both tracks to start decoding');
		source.end();

		await reading;
		input.dispose();

		expect(videoFrames).toBeGreaterThan(0);
		expect(audioFrames).toBeGreaterThan(0);

		// A rejection is reported on the next turn, so give the microtask queue a chance to deliver one
		await new Promise(resolve => setTimeout(resolve, 250));
		expect(unhandled).toEqual([]);
	} finally {
		process.off('unhandledRejection', record);
	}
}, 120_000);

// MPEG-TS over RTP (RFC 2250, payload type 33) is what SMPTE 2022 feeds and MediaLive's RTP input
// carry. FFmpeg's raw `rtp://` hands over whole packets with their headers on, and interleaves the
// RTCP it reads from the odd port, so the payload has to be taken out before a TS reader sees it.
const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

describe('the RTP depacketizer', () => {
	const rtp = (
		seq: number,
		payload: number[],
		{ csrcs = 0, extensionWords = -1, padding = 0, payloadType = 33 } = {},
	) => {
		const header = [0x80 | (extensionWords >= 0 ? 0x10 : 0) | (padding ? 0x20 : 0) | csrcs, payloadType];
		const body = [
			...header,
			(seq >> 8) & 0xff, seq & 0xff,
			0, 0, 0, 0, // timestamp
			0xde, 0xad, 0xbe, 0xef, // ssrc
			...Array.from({ length: csrcs * 4 }, (_, i) => 0xc0 | i),
		];
		if (extensionWords >= 0) {
			body.push(0xbe, 0xde, (extensionWords >> 8) & 0xff, extensionWords & 0xff);
			body.push(...Array.from({ length: extensionWords * 4 }, () => 0xee));
		}
		body.push(...payload);
		if (padding) {
			body.push(...Array.from({ length: padding - 1 }, () => 0), padding);
		}
		return new Uint8Array(body);
	};

	const payloadsOf = (depacketizer: RtpDepacketizer, datagrams: Uint8Array[]) =>
		datagrams.flatMap(datagram => depacketizer.push(datagram)).map(payload => [...payload]);

	test('strips the header, the CSRC list, the extension and the padding', () => {
		const depacketizer = new RtpDepacketizer();
		expect(payloadsOf(depacketizer, [
			rtp(0, [1, 2, 3]),
			rtp(1, [4, 5, 6], { csrcs: 3 }),
			rtp(2, [7, 8, 9], { extensionWords: 2 }),
			rtp(3, [10, 11, 12], { padding: 4 }),
			rtp(4, [13, 14, 15], { csrcs: 2, extensionWords: 1, padding: 3 }),
		])).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15]]);
	});

	test('drops RTCP, which shares the stream', () => {
		const depacketizer = new RtpDepacketizer();
		const rtcp = (packetType: number, words: number) => new Uint8Array([
			0x80, packetType, 0, words, 0xde, 0xad, 0xbe, 0xef,
			...Array.from<number>({ length: words * 4 }).fill(0),
		]);
		// 0x80 0xc8 is the Sender Report that opens an ffmpeg rtp_mpegts stream; 0xc9 is a Receiver Report
		const senderReport = rtcp(0xc8, 6);
		const receiverReport = rtcp(0xc9, 7);

		expect(payloadsOf(depacketizer, [senderReport, rtp(0, [1, 2]), receiverReport, rtp(1, [3, 4])]))
			.toEqual([[1, 2], [3, 4]]);
	});

	test('reorders within the window, and emits nothing while it waits', () => {
		const depacketizer = new RtpDepacketizer();
		// 0 arrives, then 3, 2, 1 - nothing may come out until the run is whole again
		expect(depacketizer.push(rtp(0, [0])).map(p => [...p])).toEqual([[0]]);
		expect(depacketizer.push(rtp(3, [3]))).toEqual([]);
		expect(depacketizer.push(rtp(2, [2]))).toEqual([]);
		expect(depacketizer.push(rtp(1, [1])).map(p => [...p])).toEqual([[1], [2], [3]]);
	});

	test('a gap stays a gap, and nothing is fabricated to fill it', () => {
		const depacketizer = new RtpDepacketizer();
		expect(depacketizer.push(rtp(0, [0])).map(p => [...p])).toEqual([[0]]);

		// 1 never arrives. While 16 or fewer wait behind it, nothing may come out: it could still turn up.
		for (let seq = 2; seq <= 17; seq++) {
			expect({ seq, released: depacketizer.push(rtp(seq, [seq])) }).toEqual({ seq, released: [] });
		}

		// The seventeenth is past the window, so 1 is written off and the run resumes at 2
		const released = depacketizer.push(rtp(18, [18])).map(p => [...p]);
		expect(released).toEqual(Array.from({ length: 17 }, (_, i) => [i + 2]));
		// Absent, not replaced by a zero-filled packet
		expect(released.flat()).not.toContain(1);

		// And a straggler for the written-off packet is dropped rather than emitted out of order
		expect(depacketizer.push(rtp(1, [1]))).toEqual([]);
	});

	test('duplicates are dropped', () => {
		const depacketizer = new RtpDepacketizer();
		expect(depacketizer.push(rtp(5, [5])).map(p => [...p])).toEqual([[5]]);
		expect(depacketizer.push(rtp(5, [5]))).toEqual([]);
		expect(depacketizer.push(rtp(7, [7]))).toEqual([]);
		expect(depacketizer.push(rtp(7, [7]))).toEqual([]);
		expect(depacketizer.push(rtp(6, [6])).map(p => [...p])).toEqual([[6], [7]]);
	});

	test('the sequence number wraps without stalling the stream', () => {
		const depacketizer = new RtpDepacketizer();
		const seen = [65_533, 65_534, 65_535, 0, 1]
			.flatMap(seq => depacketizer.push(rtp(seq, [seq & 0xff])).map(p => [...p]));
		expect(seen).toEqual([[65_533 & 0xff], [65_534 & 0xff], [255], [0], [1]]);
	});

	test('anything that is not RTP at all is dropped', () => {
		const depacketizer = new RtpDepacketizer();
		// Version 1, too short, and a bare TS packet, none of which is RTP version 2
		expect(depacketizer.push(new Uint8Array([0x40, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toEqual([]);
		expect(depacketizer.push(new Uint8Array([0x80]))).toEqual([]);
		expect(depacketizer.push(new Uint8Array(188).fill(0x47))).toEqual([]);
	});
});

test.skipIf(!hasFfmpeg)('an rtp:// source reads MPEG-TS over RTP as a transport stream', async () => {
	const port = freePort();
	const source = new NetworkSource(`rtp://0.0.0.0:${port}`, { connectTimeout: 15, readTimeout: 10 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const format = await input.getFormat();
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		let packets = 0;
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			void packet;
			if (++packets >= 20) {
				break;
			}
		}

		return { format: format.name, codec: await videoTrack.getCodec(), packets };
	})();

	await sleep(300);
	// The peer's own repro, verbatim
	const sender = spawn('ffmpeg', [
		'-v', 'error', '-re', '-i', FIXTURE, '-c', 'copy', '-f', 'rtp_mpegts', `rtp://127.0.0.1:${port}`,
	], { stdio: 'ignore' });

	try {
		const result = await reading;
		// Before this, the RTCP Sender Report and every RTP header reached the demuxer as if they were
		// transport stream bytes, and the format was not recognised at all
		expect(result.format).toBe('MPEG Transport Stream');
		expect(result.codec).toBe('avc');
		expect(result.packets).toBe(20);
	} finally {
		sender.kill('SIGKILL');
	}
}, 120_000);
