/*!
 * The shapes that broke MPEG-TS timing, each through both paths a caller can take. 13818-1 2.4.2:
 * an access unit is decoded at its DTS and presented at its PTS, so DTS <= PTS; 2.4.2.6: nothing
 * waits in the buffer longer than a second; 2.7.2: a PCR at most 0.1 s apart.
 *
 * A single-fragment fixture with no edit list satisfies all of this while the decode time is still
 * wrong at every later fragment, which is how the first version of this shipped.
 */
import { Demuxer } from 'node-av';
import { beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Conversion } from '../../src/conversion.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { segmentsOf } from '../../src/isobmff/isobmff-misc.js';

const asset = (name: string) => new Uint8Array(readFileSync(
	path.join(new URL('.', import.meta.url).pathname, '../public', name)));

/** Each fixture is a shape that broke something: reorder, fragments, edit list, priming. */
const FIXTURES: [string, string][] = [
	['edit list + reordered frames', 'demo.mp4'],
	['fragmented audio + video', 'bear-640x360-av_frag.mp4'],
	['AAC priming', 'he-aac-v2.mp4'],
	['50 fps with scene cuts', 'scene-cut-50fps.mp4'],
	['HEVC, open GOP', 'video-h265.mp4'],
	['edit list + B-frames + audio', 'edts.mp4'],
	['fragments whose samples are not key-flagged', 'fragments-without-keyframes.mp4'],
	['signed composition offsets', 'rotate-buck-bunny.mp4'],
	// A real low-latency encoder push, init + segments concatenated. The negative-offset one states no
	// cslg, so the shift has to come from the offsets themselves, across two truns in one segment.
	['encoder push, trun v1 negative offsets, no cslg', 'encoder-push-negative-ctts.mp4'],
	['encoder push, trun v0', 'encoder-push-trun-v0.mp4'],
	['encoder push, AAC only', 'encoder-push-aac.mp4'],
];

beforeAll(() => {
	registerMediabunnyServer();
});

const viaPackets = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const video = await input.getPrimaryVideoTrack();
	const audio = await input.getPrimaryAudioTrack();
	const videoSource = video && new EncodedVideoPacketSource((await video.getCodec())!);
	const audioSource = audio && new EncodedAudioPacketSource((await audio.getCodec())!);
	if (videoSource) {
		output.addVideoTrack(videoSource);
	}
	if (audioSource) {
		output.addAudioTrack(audioSource);
	}
	await output.start();

	for (const [track, source] of [[video, videoSource], [audio, audioSource]] as const) {
		if (!track || !source) {
			continue;
		}
		const sink = new EncodedPacketSink(track);
		const meta = { decoderConfig: await track.getDecoderConfig() } as never;
		let packet = await sink.getFirstPacket();
		while (packet) {
			await (source as never as { add(a: unknown, b: unknown): Promise<void> }).add(packet, meta);
			packet = await sink.getNextPacket(packet);
		}
	}
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const viaConversion = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });
	await conversion.execute();
	return new Uint8Array(output.target.buffer!);
};

/** The widest gap between consecutive PCRs, or null when the stream carries none. */
const widestPcrGap = (bytes: Uint8Array) => {
	let last: number | null = null;
	let widest: number | null = null;
	for (let i = 0; i + 188 <= bytes.length; i += 188) {
		const packet = bytes.subarray(i, i + 188);
		if (packet[0] !== 0x47 || !((packet[3]! >> 4) & 0x2) || packet[4] === 0 || !(packet[5]! & 0x10)) {
			continue;
		}
		const base = ((packet[6]! * 2 ** 25) + (packet[7]! << 17) + (packet[8]! << 9)
			+ (packet[9]! << 1) + (packet[10]! >> 7)) / 90000;
		if (last !== null) {
			widest = Math.max(widest ?? 0, base - last);
		}
		last = base;
	}
	return widest;
};

/** Every packet's (pts, dts) per stream, as libavformat reads them back out of the TS. */
const timestampsPerStream = async (bytes: Uint8Array) => {
	const streams = new Map<number, { pts: bigint; dts: bigint }[]>();
	const demuxer = await Demuxer.open(Buffer.from(bytes));
	try {
		for await (const packet of demuxer.packets()) {
			if (packet === null) {
				continue;
			}
			if (!streams.has(packet.streamIndex)) {
				streams.set(packet.streamIndex, []);
			}
			streams.get(packet.streamIndex)!.push({ pts: packet.pts, dts: packet.dts });
		}
	} finally {
		await demuxer.close();
	}
	return streams;
};

const NO_TIMESTAMP = -9223372036854775808n; // AV_NOPTS_VALUE

const assertSound = async (bytes: Uint8Array, label: string) => {
	const rows: string[] = [];
	const gap = widestPcrGap(bytes);
	expect(gap, `${label}: no PCR written`).not.toBeNull();
	expect(gap, `${label}: PCR gap past 0.1 s`).toBeLessThanOrEqual(0.1);

	const streams = await timestampsPerStream(bytes);
	expect(streams.size, `${label}: nothing demuxed back`).toBeGreaterThan(0);

	for (const [index, packets] of streams) {
		expect(packets.length, `${label} stream ${index}: empty`).toBeGreaterThan(0);

		let previous: bigint | null = null;
		for (const { pts, dts } of packets) {
			expect(dts, `${label} stream ${index}: a packet states no DTS`).not.toBe(NO_TIMESTAMP);
			expect(pts, `${label} stream ${index}: a packet states no PTS`).not.toBe(NO_TIMESTAMP);
			expect(dts <= pts, `${label} stream ${index}: dts ${dts} past pts ${pts}`).toBe(true);
			expect(Number(pts - dts) / 90000, `${label} stream ${index}: held over 1 s`).toBeLessThan(1);
			if (previous !== null) {
				expect(dts > previous, `${label} stream ${index}: DTS ${dts} did not advance`).toBe(true);
			}
			previous = dts;
		}

		const held = packets.reduce((most, { pts, dts }) => Math.max(most, Number(pts - dts)), 0);
		rows.push(`s${index} n=${packets.length} max(pts-dts)=${(held / 90000).toFixed(3)}s`);
	}

	// The acceptance bar is per fixture, so the numbers behind a pass are printed rather than implied
	console.log(`${label}: pcr<=${gap!.toFixed(3)}s ${rows.join(' ')} dts>pts=0 nopts=0 non-monotonic=0`);
};

/** Reads the demuxer's own (dts, pts) pairs, before anything is muxed. */
const packetsOf = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack()) ?? (await input.getPrimaryAudioTrack())!;
	const timeResolution = await track.getTimeResolution();
	const sink = new EncodedPacketSink(track);
	const out: { pts: number; dts: number; key: boolean }[] = [];
	let packet = await sink.getFirstPacket();
	while (packet) {
		out.push({
			pts: Math.round(packet.timestamp * timeResolution),
			dts: Math.round(packet.decodeTimestamp * timeResolution),
			key: packet.type === 'key',
		});
		packet = await sink.getNextPacket(packet);
	}
	return out;
};

/**
 * The least composition offset the file's `trun` and `ctts` boxes state, and whether a `cslg` states
 * the shift. Read from the bytes rather than from a demuxed packet, since the shift is what the
 * demuxer applies — asking it would only confirm its own answer.
 */
const compositionShape = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let least = 0;
	let statesCslg = false;

	const walk = (start: number, end: number) => {
		for (let offset = start; offset + 8 <= end;) {
			const size = view.getUint32(offset);
			if (size < 8) {
				return;
			}
			const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

			if (type === 'cslg') {
				statesCslg = true;
			} else if (type === 'trun') {
				const version = bytes[offset + 8]!;
				const flags = (bytes[offset + 9]! << 16) | (bytes[offset + 10]! << 8) | bytes[offset + 11]!;
				const sampleCount = view.getUint32(offset + 12);
				let cursor = offset + 16;
				if (flags & 0x1) {
					cursor += 4;
				}
				if (flags & 0x4) {
					cursor += 4;
				}
				if (flags & 0x800) {
					let within = 0;
					for (const present of [0x100, 0x200, 0x400]) {
						if (flags & present) {
							within += 4;
						}
					}
					const stride = within + 4; // the composition offset itself, which this branch requires
					for (let i = 0; i < sampleCount; i++) {
						const at = cursor + i * stride + within;
						least = Math.min(least, version === 1 ? view.getInt32(at) : view.getUint32(at));
					}
				}
			} else if (type === 'ctts') {
				const version = bytes[offset + 8]!;
				const entryCount = view.getUint32(offset + 12);
				for (let i = 0; i < entryCount; i++) {
					const at = offset + 16 + i * 8 + 4;
					least = Math.min(least, version === 1 ? view.getInt32(at) : view.getUint32(at));
				}
			} else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf'].includes(type)) {
				walk(offset + 8, offset + size);
			}

			offset += size;
		}
	};
	walk(0, bytes.length);

	return { least, statesCslg };
};

describe('the shapes this matrix claims to cover are actually in the fixtures', () => {
	// Without these, a fixture could be swapped for one that no longer carries the shape and every
	// row below would still pass while covering nothing.
	test('video-h265.mp4 really has an open GOP', { timeout: 600_000 }, async () => {
		const packets = await packetsOf(asset('video-h265.mp4'));
		const keyIndices = packets.map((p, i) => p.key ? i : -1).filter(i => i > 0);
		expect(keyIndices.length, 'no key frame past the first, so no GOP transition to open').toBeGreaterThan(0);

		// An open GOP's leading pictures are decoded after the key frame but presented before it
		const leading = keyIndices.some(k => packets.slice(k + 1).some(p => p.pts < packets[k]!.pts));
		expect(leading, 'every GOP here is closed').toBe(true);
	});

	// 14496-12 8.6.1.3: a version 1 trun or ctts centres composition on decode, so the raw pair has
	// DTS past PTS until the track's shift is applied. Reading it back must not.
	test.each([
		['the encoder push, which states no cslg', 'encoder-push-negative-ctts.mp4', false],
		['rotate-buck-bunny.mp4', 'rotate-buck-bunny.mp4', false],
	])('%s really states negative composition offsets', { timeout: 600_000 }, async (_name, file, cslg) => {
		const bytes = asset(file);
		const shape = compositionShape(bytes);
		expect(shape.least, 'no negative composition offset, so no shift is needed').toBeLessThan(0);
		expect(shape.statesCslg, 'a cslg states the shift, so the fallback path is not covered').toBe(cslg);

		for (const { pts, dts } of await packetsOf(bytes)) {
			expect(dts <= pts, `dts ${dts} past pts ${pts}`).toBe(true);
		}
	});

	test('our own fragmented MP4 states the shift in a cslg, covering the other path', async () => {
		const shape = compositionShape(await viaOurMp4(asset('demo.mp4'), false));
		expect(shape.least).toBeLessThanOrEqual(0);
		expect(shape.statesCslg).toBe(true);
	});
});

/** Repackages the source as MP4 with this library's own muxer, progressive or fragmented. */
const viaOurMp4 = async (bytes: Uint8Array, fastStart: false | 'fragmented') => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });
	await conversion.execute();
	return new Uint8Array(output.target.buffer!);
};

describe('what this library writes, it can read back', () => {
	// The muxer derives composition offsets from the decode timestamps the demuxer hands it and states
	// the implied shift in a cslg. If the demuxer then ignores that box, the library disagrees with
	// itself about its own output, and every other row in this file is measuring the wrong thing.
	for (const [name, file] of FIXTURES) {
		for (const fastStart of [false, 'fragmented'] as const) {
			const kind = fastStart === false ? 'progressive' : 'fragmented';

			test(`${name}, our MP4 (${kind}) read back`, { timeout: 600_000 }, async () => {
				const remuxed = await viaOurMp4(asset(file), fastStart);
				const packets = await packetsOf(remuxed);
				expect(packets.length).toBeGreaterThan(0);

				let previous: number | null = null;
				for (const { pts, dts } of packets) {
					expect(dts <= pts, `dts ${dts} past pts ${pts}`).toBe(true);
					if (previous !== null) {
						expect(dts > previous, `dts ${dts} did not advance past ${previous}`).toBe(true);
					}
					previous = dts;
				}
			});

			test(`${name}, our MP4 (${kind}) then TS`, { timeout: 600_000 }, async () => {
				const remuxed = await viaOurMp4(asset(file), fastStart);
				await assertSound(await viaPackets(remuxed), `${name}-${kind}-ts`);
			});
		}
	}
});

describe('MPEG-TS timing holds across every shape', () => {
	for (const [name, file] of FIXTURES) {
		test(`${name}, demux then mux`, { timeout: 600_000 }, async () => {
			await assertSound(await viaPackets(asset(file)), `${name}-packets`);
		});

		test(`${name}, through Conversion`, { timeout: 600_000 }, async () => {
			await assertSound(await viaConversion(asset(file)), `${name}-conversion`);
		});
	}

	test('each CMAF segment remuxed on its own stays on one timeline', { timeout: 600_000 }, async () => {
		// What a CMAF origin does: init + one moof per request. Every segment after the first used to
		// restart its decode time at zero.
		const bytes = asset('bear-640x360-av_frag.mp4');
		const layout = segmentsOf(bytes);
		expect(layout.segments.length).toBeGreaterThan(1);

		const init = bytes.subarray(0, layout.init!.size);
		for (let i = 0; i < layout.segments.length; i++) {
			const segment = layout.segments[i]!;
			const one = new Uint8Array(init.length + segment.size);
			one.set(init, 0);
			one.set(bytes.subarray(segment.offset, segment.offset + segment.size), init.length);
			await assertSound(await viaPackets(one), `segment-${i}`);
		}
	});
});

/**
 * Every PES packet's own 33-bit PTS and DTS, read from the header bytes. libavformat unwraps a value
 * near 2^33 back into a negative one, so asking it whether DTS <= PTS answers about its own
 * interpretation rather than about what was written; this reads the field.
 */
const rawPesTimestamps = (bytes: Uint8Array) => {
	const out: { pid: number; pts: number; dts: number | null }[] = [];
	const readTimestamp = (at: number) => {
		const b = bytes;
		return (b[at]! >> 1 & 0x07) * 2 ** 30
			+ (b[at + 1]! << 22)
			+ ((b[at + 2]! >> 1) << 15)
			+ (b[at + 3]! << 7)
			+ (b[at + 4]! >> 1);
	};

	for (let i = 0; i + 188 <= bytes.length; i += 188) {
		const packet = bytes.subarray(i, i + 188);
		if (packet[0] !== 0x47 || !(packet[1]! & 0x40)) {
			continue; // not a payload-unit start, so no PES header here
		}
		const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
		let offset = 4;
		if ((packet[3]! >> 4) & 0x2) {
			offset += 1 + packet[4]!; // adaptation field
		}
		if (packet[offset] !== 0 || packet[offset + 1] !== 0 || packet[offset + 2] !== 1) {
			continue;
		}

		const flags = packet[offset + 7]!;
		const base = i + offset + 9;
		if ((flags & 0xc0) === 0) {
			continue;
		}
		const pts = readTimestamp(base);
		const dts = (flags & 0x40) ? readTimestamp(base + 5) : null;
		out.push({ pid, pts, dts });
	}

	return out;
};

describe('a decode time is a property of the track, not of what was read', () => {
	// A segmented reader opens one fragment at a time. If the shift that keeps DTS <= PTS is derived
	// from the offsets a given Input happened to see, two readers of the same track disagree, and a
	// fragment stating no offsets sits at a different shift from its neighbours — so its decode times
	// collide with the previous fragment's instead of following them.
	const fragmentedOf = async (file: string) => {
		using input = new Input({ source: new BufferSource(asset(file)), formats: ALL_FORMATS });
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
			target: new BufferTarget(),
		});
		await (await Conversion.init({ input, output })).execute();
		return new Uint8Array(output.target.buffer!);
	};

	// Which output states the shift, read from the boxes rather than assumed. A progressive file knows
	// every offset by the time it writes its sample table, so it writes a cslg; a fragmented init is
	// written before any sample exists, so it states none and the reader derives the bound instead.
	// The row below proves that derivation holds a fragment at a time.
	test('a progressive init states the shift, a fragmented one cannot', { timeout: 600_000 }, async () => {
		const progressive = compositionShape(await viaOurMp4(asset('demo.mp4'), false));
		expect(progressive.least, 'no negative offsets, so this proves nothing').toBeLessThan(0);
		expect(progressive.statesCslg).toBe(true);

		const fragmented = compositionShape(await fragmentedOf('demo.mp4'));
		expect(fragmented.least).toBeLessThan(0);
		expect(fragmented.statesCslg).toBe(false);
	});

	test('each fragment read alone continues the one before it', { timeout: 600_000 }, async () => {
		const bytes = await fragmentedOf('demo.mp4');
		const layout = segmentsOf(bytes);
		expect(layout.segments.length).toBeGreaterThan(2);
		const init = bytes.subarray(0, layout.init!.size);

		let previousEnd: number | null = null;
		for (let i = 0; i < layout.segments.length; i++) {
			const segment = layout.segments[i]!;
			const one = new Uint8Array(init.length + segment.size);
			one.set(init, 0);
			one.set(bytes.subarray(segment.offset, segment.offset + segment.size), init.length);

			const packets = await packetsOf(one);
			expect(packets.length, `segment ${i} read back empty`).toBeGreaterThan(0);

			const first = packets[0]!.dts;
			if (previousEnd !== null) {
				expect(first > previousEnd, `segment ${i} decodes at ${first}, not past ${previousEnd}`).toBe(true);
			}
			previousEnd = packets.at(-1)!.dts;
		}
	});

	test('a default MPEG-TS mux never writes a decode time that wrapped', { timeout: 600_000 }, async () => {
		// PES timestamps are unsigned 33-bit. A negative decode time Euclid-mods to a value near 2^33,
		// which every reader sees as a DTS long after its PTS rather than as a negative one.
		const ts = await viaPackets(await fragmentedOf('demo.mp4'));
		const pes = rawPesTimestamps(ts);
		expect(pes.length).toBeGreaterThan(0);

		for (const { pid, pts, dts } of pes) {
			if (dts === null) {
				continue;
			}
			expect(dts, `pid ${pid}: dts ${dts} written past pts ${pts}`).toBeLessThanOrEqual(pts);
		}
	});

	test('nor through Conversion of a reordered source with audio', { timeout: 600_000 }, async () => {
		// The path that actually failed: Conversion hands the muxer packets whose decode time the
		// source states, and the offset decision has to read that rather than the one derived from
		// presentation order, which is not settled yet when the offset is fixed.
		// A long first GOP matters: the offset is fixed when the tables go out, and until the track's
		// first GOP is flushed its packets carry no decode time yet, so the only value to read is the
		// presentation one — zero, needing no offset. Three seconds of a real encoder's output.
		const ts = await viaConversion(asset('reordered-av-long-gop.mp4'));
		const pes = rawPesTimestamps(ts);
		expect(new Set(pes.map(x => x.pid)).size, 'needs both PIDs').toBeGreaterThan(1);

		for (const { pid, pts, dts } of pes) {
			if (dts !== null) {
				expect(dts, `pid ${pid}: dts ${dts} written past pts ${pts}`).toBeLessThanOrEqual(pts);
			}
		}
	});

	test('nor through a progressive remux of a B-frame source', { timeout: 600_000 }, async () => {
		// The shape the peer hit: first frame presents at 0, so with the shift applied it decodes
		// before 0, and an unsigned 33-bit field cannot hold that.
		const ts = await viaPackets(await viaOurMp4(asset('demo.mp4'), false));
		const pes = rawPesTimestamps(ts);
		expect(pes.length).toBeGreaterThan(0);

		for (const { pid, pts, dts } of pes) {
			if (dts === null) {
				continue;
			}
			expect(dts, `pid ${pid}: dts ${dts} written past pts ${pts}`).toBeLessThanOrEqual(pts);
		}
	});
});

// A minimal in-band AVCC: SPS/PPS for 320x240 baseline, enough for the muxer to declare the stream.
const AVC_DECODER_CONFIG = {
	codec: 'avc1.42001f',
	codedWidth: 320,
	codedHeight: 240,
	description: new Uint8Array([1, 66, 0, 31, 255, 225, 0, 4, 103, 66, 0, 31, 1, 0, 4, 104, 206, 60, 128]),
};

// Regression: the default timestamp offset used to live on the MpegTsOutputFormat instance, so it was
// shared with every later Output built from that same format. A programme that began at -0.5s fixed the
// offset at 0.5s, and the next conversion — which needed no shift at all — had its whole timeline moved.
const firstVideoPts = async (format: MpegTsOutputFormat, startAt: number) => {
	const output = new Output({ format, target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 10 });
	await output.start();

	for (let i = 0; i < 6; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(192).fill(i), i === 0 ? 'key' : 'delta', startAt + i * 0.1, 0.1),
			i === 0 ? { decoderConfig: AVC_DECODER_CONFIG } : undefined,
		);
	}

	await output.finalize();
	return rawPesTimestamps(new Uint8Array(output.target.buffer!))[0]!.pts;
};

test('a reused MpegTsOutputFormat does not carry one output\'s timestamp offset into the next', async () => {
	const reused = new MpegTsOutputFormat({});

	// Starts negative, so an offset is chosen and applied: the programme is shifted to begin at 0.
	expect(await firstVideoPts(reused, -0.5)).toBe(0);

	// Starts at 0 and needs no shift. With the offset parked on the format it inherited 0.5s = 45000 ticks.
	expect(await firstVideoPts(reused, 0)).toBe(0);

	// The control: a format instance that has never been used must agree with the reused one.
	expect(await firstVideoPts(new MpegTsOutputFormat({}), 0)).toBe(0);
});
