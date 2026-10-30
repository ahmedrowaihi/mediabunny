import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { RtmpSource, registerMediabunnyServer } from '@mediabunny/server';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil } from './_network-test.js';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SENDER = path.join(__dirname, '_live-sender.ts');
const FIXTURE = path.join(__dirname, '../public/scene-cut-50fps.mp4');
const HEVC_FIXTURE = path.join(__dirname, '../public/video-h265.mp4');

let nextPort = 19_000 + Math.floor(Math.random() * 500);
const freePort = () => nextPort++;

// Three tests need the ffmpeg binary rather than node-av: one because only ffmpeg can serve an rtmp
// listener here, two because the shape under test is ffmpeg's own clean end-of-file. They skip where it is
// absent — without this they spend their whole timeout waiting for a publisher that never starts.
const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();
const ffmpegTest = test.skipIf(!hasFfmpeg);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retried rather than probed: `ffmpeg -listen 1` accepts exactly one connection, so a TCP probe takes
// the slot the dial needs. A refused attempt consumes nothing, so attempting the dial is the safe wait.
const dialUntilReady = async (url: string, attempts = 40) => {
	for (let attempt = 0; ; attempt++) {
		const source = new RtmpSource(url, { mode: 'caller', connectTimeout: 20, readTimeout: 10 });
		const input = new Input({ source, formats: ALL_FORMATS });
		try {
			return { input, ...await packetsOf(input, 20) };
		} catch (err) {
			input.dispose();
			if (attempt >= attempts) {
				throw err;
			}
			await sleep(150);
		}
	}
};

// rtmp needs an app and a playpath, so the URL carries both.
const listenerUrl = () => `rtmp://127.0.0.1:${freePort()}/live/key`;

// node-av, not an ffmpeg binary: its bundled FFmpeg has rtmp and the flv muxer, so these tests do not
// depend on whatever ffmpeg the machine happens to have. `node --import tsx` rather than the tsx binary,
// which forks a child that a kill would orphan with the socket still open.
const publish = (url: string, source = FIXTURE, extra: string[] = []): ChildProcess =>
	spawn(process.execPath, ['--import', 'tsx', SENDER, source, url, ...extra], { stdio: 'ignore' });

const packetsOf = async (input: Input, count: number) => {
	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	const out: { pts: number; dts: number }[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		out.push({ pts: packet.timestamp, dts: packet.decodeTimestamp });
		if (out.length >= count) {
			break;
		}
	}
	return { track: track!, packets: out };
};

test.each([
	['avc', FIXTURE],
	['hevc', HEVC_FIXTURE],
])('rtmp listener reads %s from a publisher', async (expected, fixture) => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 10 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = packetsOf(input, 40);
	await sleep(300);
	const publisher = publish(url, fixture);
	try {
		const { track, packets } = await reading;
		expect(await track.getCodec()).toBe(expected);
		expect(packets).toHaveLength(40);
		expect(await track.isLive()).toBe(true);
	} finally {
		publisher.kill('SIGKILL');
	}
}, 120_000);

test('rtmp listener carries video and audio together', async () => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 10 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const tracks = await input.getTracks();
		const video = tracks.find(t => t.isVideoTrack());
		const audio = tracks.find(t => t.isAudioTrack());
		expect(video).toBeDefined();
		expect(audio).toBeDefined();

		// Both sinks drained together: a track that never yields would otherwise pass unnoticed.
		const count = async (track: typeof tracks[number]) => {
			let packets = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				void packet.data.byteLength;
				if (++packets >= 20) {
					break;
				}
			}
			return packets;
		};
		const [videoPackets, audioPackets] = await Promise.all([count(video!), count(audio!)]);
		return { video: video!, audio: audio!, videoPackets, audioPackets };
	})();

	await sleep(300);
	const publisher = publish(url, HEVC_FIXTURE, ['--with-audio']);
	try {
		const result = await reading;
		expect(await result.video.getCodec()).toBe('hevc');
		expect(await result.audio.getCodec()).toBe('aac');
		expect(result.videoPackets).toBe(20);
		expect(result.audioPackets).toBe(20);
	} finally {
		publisher.kill('SIGKILL');
	}
}, 120_000);

ffmpegTest('rtmp caller dials out to a listening publisher', async () => {
	const port = freePort();
	const url = `rtmp://127.0.0.1:${port}/live/key`;
	// ffmpeg serves this one, and only this one: node-av applies its `options` to the muxer rather than
	// the protocol, so `rtmp_listen` comes back "Option not found" and nothing binds. The publisher in
	// every other test is node-av.
	const publisher = spawn('ffmpeg', [
		'-hide_banner', '-loglevel', 'error', '-re', '-i', FIXTURE,
		'-c', 'copy', '-f', 'flv', '-listen', '1', url,
	], { stdio: 'ignore' });
	try {
		const { input, track, packets } = await dialUntilReady(url);
		try {
			expect(await track.getCodec()).toBe('avc');
			expect(packets).toHaveLength(20);
		} finally {
			input.dispose();
		}
	} finally {
		publisher.kill('SIGKILL');
	}
}, 120_000);

// Both bounds matter: an upper bound alone passes on an instant failure, which is how a connect that
// merely refuses looks indistinguishable from one that is actually bounded.
test('a listener nobody publishes to waits connectTimeout, then fails', async () => {
	const source = new RtmpSource(listenerUrl(), { mode: 'listener', connectTimeout: 3, readTimeout: 10 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const started = Date.now();
	await expect(input.getPrimaryVideoTrack()).rejects.toThrow();
	const elapsed = (Date.now() - started) / 1000;
	expect(elapsed).toBeGreaterThan(1.5);
	expect(elapsed).toBeLessThan(15);
}, 60_000);

test('a publisher that goes silent ends the input inside the read bound', async () => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 6 });
	using input = new Input({ source, formats: ALL_FORMATS });

	// Read outside the closure, so the freeze waits for real data rather than assuming a start-up time
	let seen = 0;
	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		let bytes = 0;
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			bytes += packet.data.byteLength;
			seen = bytes;
		}
		return bytes;
	})();

	await sleep(300);
	const publisher = publish(url);
	try {
		await waitUntil(() => seen > 0, 20_000, 'the publisher to deliver its first video packet');

		// Frozen rather than killed: the socket stays open and simply stops carrying data.
		publisher.kill('SIGSTOP');
		const started = Date.now();
		await expect(reading).resolves.toBeGreaterThan(0);
		const elapsed = (Date.now() - started) / 1000;
		expect(elapsed).toBeGreaterThan(1);
		expect(elapsed).toBeLessThan(30);
	} finally {
		publisher.kill('SIGCONT');
		publisher.kill('SIGKILL');
	}
}, 120_000);

// A caller's connect is NOT bounded by connectTimeout: rtmp reads `timeout` as implying listen mode, so
// it is left unset for callers and the protocol bounds the connect instead.
test('a caller to an unreachable address fails inside the protocol bound', async () => {
	// Reserved, non-routable: the connect neither succeeds nor is refused outright.
	const source = new RtmpSource('rtmp://10.255.255.1:1935/live/key', {
		mode: 'caller',
		connectTimeout: 30,
		readTimeout: 10,
	});
	using input = new Input({ source, formats: ALL_FORMATS });

	const started = Date.now();
	await expect(input.getPrimaryVideoTrack()).rejects.toThrow();
	const elapsed = (Date.now() - started) / 1000;
	// Well inside connectTimeout, which proves the protocol and not that option is doing the bounding.
	expect(elapsed).toBeLessThan(20);
}, 60_000);

// Compares two bounds in one run rather than asserting an absolute figure: readTimeout maps to rtmp's
// rw_timeout, which the read outlasts by a multiple, and an absolute window also measures whatever JS
// scheduling the machine is doing. A ratio does not.
test('readTimeout governs when a silent publisher ends the input', async () => {
	const endAfterSilence = async (readTimeout: number) => {
		const url = listenerUrl();
		const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout });
		using input = new Input({ source, formats: ALL_FORMATS });

		let bytes = 0;
		const reading = (async () => {
			const track = await input.getPrimaryVideoTrack();
			for await (const packet of new EncodedPacketSink(track!).packets()) {
				bytes += packet.data.byteLength;
			}
			return bytes;
		})();

		await sleep(300);
		const publisher = publish(url);
		try {
			// Stopping it before it has published anything leaves the input's open call to time out instead.
			await waitUntil(() => bytes > 0, 30_000, 'the rtmp publisher to deliver a packet');
			publisher.kill('SIGSTOP');
			const started = Date.now();
			await expect(reading).resolves.toBeGreaterThan(0);
			return (Date.now() - started) / 1000;
		} finally {
			publisher.kill('SIGCONT');
			publisher.kill('SIGKILL');
		}
	};

	const short = await endAfterSilence(2);
	const long = await endAfterSilence(8);

	expect(short).toBeGreaterThan(0.5);
	// A ratio, so the gap survives any load that affects both measurements equally.
	expect(short).toBeLessThan(long);
}, 180_000);

// The same trap as the NetworkSource cancel and the muxer pb crash: closing a context under a parked
// native read aborts the process, so a read has to be genuinely in flight when dispose lands.
test('disposing an rtmp input while it is still reading does not abort the process', async () => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 6 });
	const input = new Input({ source, formats: ALL_FORMATS });

	let bytesRead = 0;
	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			bytesRead += packet.data.byteLength;
		}
	})().catch(() => {});

	await sleep(300);
	const publisher = publish(url);
	try {
		// Polled, not a fixed wait: the publisher's handshake plus probing can take several seconds, and
		// disposing before a read is in flight would not exercise the trap at all.
		const deadline = Date.now() + 20_000;
		while (bytesRead === 0 && Date.now() < deadline) {
			await sleep(250);
		}
		expect(bytesRead).toBeGreaterThan(0);

		input.dispose();
		await sleep(2_000);
		await reading;
	} finally {
		publisher.kill('SIGKILL');
	}
}, 120_000);

test('remuxed timestamps match the source: decode times rise and the presentation order is unchanged', async () => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 10 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = packetsOf(input, 60);
	await sleep(300);
	const publisher = publish(url);
	let live: { pts: number; dts: number }[];
	try {
		live = (await reading).packets;
	} finally {
		publisher.kill('SIGKILL');
	}

	using fileInput = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });
	const { packets: fromFile } = await packetsOf(fileInput, live.length);

	for (const [i, packet] of live.entries()) {
		if (i > 0) {
			expect(packet.dts).toBeGreaterThanOrEqual(live[i - 1]!.dts);
		}
		expect(packet.pts).toBeGreaterThanOrEqual(packet.dts - 1e-9);
	}

	// Rebased on each sequence's own first packet, since the remux is free to shift the timeline.
	const shape = (packets: { pts: number }[]) =>
		packets.map(p => Math.round((p.pts - packets[0]!.pts) * 1000)).join(',');
	expect(shape(live)).toBe(shape(fromFile));
}, 120_000);

// A read bound must ride out a stall in a healthy stream. Letting rw_timeout fire mid-read instead made
// FFmpeg resume off a packet boundary, which the FLV demuxer reported as a packet mismatch and which
// silently lost packets — so this compares the sequence against the source rather than counting it.
test('a publisher pausing just under readTimeout loses no packets', async () => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 2 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = packetsOf(input, 120);
	await sleep(300);
	// Pauses 1.6 s, inside the 2 s bound and well past the 0.5 s the earlier halving produced.
	const publisher = publish(url, FIXTURE, ['--pause-after=30', '--pause-ms=1600']);
	let live: { pts: number; dts: number }[];
	try {
		live = (await reading).packets;
	} finally {
		publisher.kill('SIGKILL');
	}

	using fileInput = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });
	const { packets: fromFile } = await packetsOf(fileInput, live.length);

	const shape = (packets: { pts: number }[]) =>
		packets.map(p => Math.round((p.pts - packets[0]!.pts) * 1000)).join(',');
	// A dropped packet shifts every later entry, so an identical sequence is the whole assertion.
	expect(shape(live)).toBe(shape(fromFile));
}, 120_000);

// Timed on the stream's own cancel: Input.dispose fires it without awaiting, so dispose returns promptly
// whether or not the accept is still parked.
test('cancelling a listener with no publisher returns promptly', async () => {
	const source = new RtmpSource(listenerUrl(), { mode: 'listener', connectTimeout: 30, readTimeout: 30 });
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

// A video-only publish must end as promptly as one with audio: the end came only at readTimeout when the
// publisher stopped, where with audio it was immediate.
test.each([
	['video and audio', ['--with-audio']],
	['video only', [] as string[]],
])('a publisher that stops ends a %s stream promptly', async (_name, extra) => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 25 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		let bytes = 0;
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			bytes += packet.data.byteLength;
		}
		return bytes;
	})();

	await sleep(300);
	// Stops after 40 packets without a trailer, which is what an encoder going away looks like.
	const publisher = publish(url, FIXTURE, ['--stop-after=40', ...extra]);
	try {
		const started = Date.now();
		await expect(reading).resolves.toBeGreaterThan(0);
		const elapsed = (Date.now() - started) / 1000;
		// readTimeout is 25 s, so an end that waits for it has not noticed the publisher leaving.
		expect(elapsed).toBeLessThan(20);
	} finally {
		publisher.kill('SIGKILL');
	}
}, 120_000);

// Their exact publisher shape: ffmpeg with -an, which ends the file cleanly and closes.
ffmpegTest.each([
	['with audio', ['-c', 'copy']],
	['video only (-an)', ['-c:v', 'copy', '-an']],
])('an ffmpeg publisher %s that finishes ends the stream promptly', async (_name, codecArgs) => {
	const url = listenerUrl();
	const source = new RtmpSource(url, { mode: 'listener', connectTimeout: 20, readTimeout: 25 });
	using input = new Input({ source, formats: ALL_FORMATS });

	const reading = (async () => {
		const track = await input.getPrimaryVideoTrack();
		let bytes = 0;
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			bytes += packet.data.byteLength;
		}
		return bytes;
	})();

	await sleep(300);
	const publisher = spawn('ffmpeg', [
		'-hide_banner', '-loglevel', 'error', '-re', '-t', '2', '-i', FIXTURE,
		...codecArgs, '-f', 'flv', url,
	], { stdio: 'ignore' });
	try {
		await new Promise<void>(resolve => publisher.on('exit', () => resolve()));
		const started = Date.now();
		await expect(reading).resolves.toBeGreaterThan(0);
		const elapsed = (Date.now() - started) / 1000;
		// readTimeout is 25 s; an end that waits for it has not noticed the publisher finishing.
		expect(elapsed).toBeLessThan(15);
	} finally {
		publisher.kill('SIGKILL');
	}
}, 120_000);
