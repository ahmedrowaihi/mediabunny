import { beforeAll, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { decodeTimeIsOnThisTimeline } from '../../packages/server/src/video-encoder.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

beforeAll(() => {
	registerMediabunnyServer();
});

const FRAMES = Number(process.env['SPIKE_FRAMES'] ?? 2);
const RUNS = Number(process.env['SPIKE_RUNS'] ?? 20);
const PARAMS = process.env['SPIKE_PARAMS'] ?? 'pools=4:frame-threads=1:chromaloc=2';
const CODEC = (process.env['SPIKE_CODEC'] ?? 'hevc') as 'hevc' | 'avc';

const encodeOnce = async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	// What the ENCODER states, before the muxer or demuxer can normalise anything
	const fromEncoder: { timestamp: number; decodeTimestamp: number }[] = [];
	const source = new VideoSampleSource({
		codec: CODEC,
		quality: new Quality({ quantizer: 4 }),
		keyFrameInterval: 1,
		hardwareAcceleration: 'prefer-software',
		encoderControls: { options: { [CODEC === 'hevc' ? 'x265-params' : 'x264-params']: PARAMS } },
		onEncodedPacket: (packet) => {
			fromEncoder.push({ timestamp: packet.timestamp, decodeTimestamp: packet.decodeTimestamp });
		},
	});
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();

	const pixels = new Uint8Array(320 * 180 * 4).fill(0x80);
	for (let i = 0; i < FRAMES; i++) {
		using sample = new VideoSample(pixels, {
			format: 'RGBA',
			codedWidth: 320,
			codedHeight: 180,
			timestamp: i * 0.04,
			duration: 0.04,
		});
		await source.add(sample);
	}
	source.close();
	await output.finalize();

	const bytes = output.target.buffer;
	assert(bytes);
	using input = new Input({ formats: ALL_FORMATS, source: new BufferSource(new Uint8Array(bytes)) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const offenders: { where: string; timestamp: number; decodeTimestamp: number }[] = [];
	for (const stated of fromEncoder) {
		if (stated.decodeTimestamp > stated.timestamp) {
			offenders.push({ where: 'encoder', ...stated });
		}
	}
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (packet.decodeTimestamp > packet.timestamp) {
			offenders.push({ where: 'muxed', timestamp: packet.timestamp, decodeTimestamp: packet.decodeTimestamp });
		}
	}
	return offenders;
};

test(`${CODEC} ${FRAMES}-frame encode states a decode timestamp no later than its presentation time`, async () => {
	const bad: string[] = [];
	for (let run = 0; run < RUNS; run++) {
		const offenders = await encodeOnce();
		if (offenders.length > 0) {
			bad.push(`run ${run + 1}: ${JSON.stringify(offenders)}`);
		}
	}
	expect(bad.join('\n')).toBe('');
}, 600_000);

// A 1- or 2-frame HEVC encode is where x265 reports a decode timestamp built from an uninitialised
// `m_bframeDelayTime`: the field is assigned at `m_pocLast == m_bframeDelay`, so a shorter encode never
// reaches it, and the offset has been seen at ~7.5e12 seconds in either direction. Whether the garbage
// appears depends on the allocator, so this cannot be reproduced everywhere - what is pinned here is
// that such a value never leaves the encoder, whatever produced it.
const submitted = [
	{ timestamp: 0, duration: 0.04 },
	{ timestamp: 0.04, duration: 0.04 },
];

test('a decode timestamp after its own presentation time is not on the timeline', () => {
	expect(decodeTimeIsOnThisTimeline(0.04, 0, submitted)).toBe(false);
	// The sign x265 produces when the uninitialised delay reads negative
	expect(decodeTimeIsOnThisTimeline(0 - -7.6e12, 0, submitted)).toBe(false);
});

test('a decode timestamp earlier than the submitted content could justify is not on the timeline', () => {
	// The other sign: dts = pts - 7.5e12
	expect(decodeTimeIsOnThisTimeline(0.04 - 7.5e12, 0.04, submitted)).toBe(false);
	// A reorder delay cannot exceed the span handed in, which is 0.08s here
	expect(decodeTimeIsOnThisTimeline(-0.09, 0.04, submitted)).toBe(false);
	expect(decodeTimeIsOnThisTimeline(-0.08, 0.04, submitted)).toBe(true);
});

test('an ordinary reordered decode timestamp is on the timeline', () => {
	expect(decodeTimeIsOnThisTimeline(0, 0, submitted)).toBe(true);
	expect(decodeTimeIsOnThisTimeline(0, 0.04, submitted)).toBe(true);
	expect(decodeTimeIsOnThisTimeline(-0.04, 0.04, submitted)).toBe(true);
});

test('with nothing submitted to bound it, only the presentation time constrains it', () => {
	expect(decodeTimeIsOnThisTimeline(-7.5e12, 0, [])).toBe(true);
	expect(decodeTimeIsOnThisTimeline(0.04, 0, [])).toBe(false);
	expect(decodeTimeIsOnThisTimeline(Number.NaN, 0, [])).toBe(false);
	expect(decodeTimeIsOnThisTimeline(-Infinity, 0, submitted)).toBe(false);
});

// The exact values a 24 fps x264 rung produced: its `dts` correctly equals its `pts`, but arrives on a
// 1/1,000,000 base while the presentation time is refined to the frame's own, so a strict comparison
// called a correct timestamp garbage and dropped it on every third frame.
test('a decode time rounded to the encoder\'s time base is still on the timeline', () => {
	const pts = 0.041666666666666664;
	const roundedDts = 0.041667;
	expect(roundedDts).toBeGreaterThan(pts); // the comparison a strict guard makes
	expect(decodeTimeIsOnThisTimeline(roundedDts, pts, submitted)).toBe(true);

	// And the same rounding at the other end of the window
	expect(decodeTimeIsOnThisTimeline(-0.080001, 0.04, submitted)).toBe(true);
});

test('a tick of tolerance does not admit the values the guard exists for', () => {
	expect(decodeTimeIsOnThisTimeline(0.041666666666666664 + 1e-5, 0.041666666666666664, submitted)).toBe(false);
	expect(decodeTimeIsOnThisTimeline(0.04 - -7.6e12, 0.04, submitted)).toBe(false);
	expect(decodeTimeIsOnThisTimeline(0.04 - 7.5e12, 0.04, submitted)).toBe(false);
});
