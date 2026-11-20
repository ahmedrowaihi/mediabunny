/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `onCuePoint` and `onTextData` over RTMP, which is how an ad break or a caption is marked on a live
// stream. RTMP carries FLV and FLV carries AMF0, so a timed message is a script data tag (type 18)
// holding a message name and one value.
//
// **The receiver is ffmpeg, not this library.** `ffmpeg -listen 1` accepts the publish and writes the
// FLV it received to disk; the assertions are made on THAT file's octets. A test that read the
// messages back through our own RtmpSource would pass on a stream no other receiver could read - and
// the whole point of AMF here is that someone else reads it. See the FLV tag parsing below: it decodes
// the AMF0 rather than searching for the strings, so a message whose structure is wrong fails even
// when the words it contains are right.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RtmpTarget, registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { FilePathSource } from '../../src/source.js';
import { encodeAmf0Value, encodeAmfDataMessage } from '../../packages/server/src/amf.js';

registerMediabunnyServer();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = path.join(__dirname, '../public/demo.mp4');

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

// Clear of the other live bands: rtmp-target 18200+, rtmp-input 19000+, live-network-input 21000+
let nextPort = 18_700 + Math.floor(Math.random() * 200);
const freePort = () => nextPort++;

let workDir: string;
beforeAll(() => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-amf-'));
});
afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

type AmfValue = number | string | boolean | null | AmfValue[] | { [key: string]: AmfValue };

/** An AMF0 reader, written against the format rather than against this library's writer. */
const readAmf0 = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let at = 0;

	const string = (length: number) => {
		const text = decoder.decode(bytes.subarray(at, at + length));
		at += length;
		return text;
	};

	const value = (): AmfValue => {
		const marker = bytes[at++]!;

		switch (marker) {
			case 0x00: {
				const number = view.getFloat64(at, false);
				at += 8;
				return number;
			}
			case 0x01: return bytes[at++] !== 0;
			case 0x02: {
				const length = view.getUint16(at, false);
				at += 2;
				return string(length);
			}
			case 0x03:
			case 0x08: {
				if (marker === 0x08) {
					at += 4; // The stated count, which is advisory - the terminator is what ends it
				}

				const object: Record<string, AmfValue> = {};
				for (;;) {
					const nameLength = view.getUint16(at, false);
					at += 2;
					if (nameLength === 0) {
						at++; // The end marker
						break;
					}

					const name = string(nameLength);
					object[name] = value();
				}

				return object;
			}
			case 0x05: return null;
			case 0x0a: {
				const count = view.getUint32(at, false);
				at += 4;
				return Array.from({ length: count }, () => value());
			}
			case 0x0c: {
				const length = view.getUint32(at, false);
				at += 4;
				return string(length);
			}
			default: throw new Error(`Unknown AMF0 marker 0x${marker.toString(16)} at ${at - 1}`);
		}
	};

	return { name: value() as string, value: value() };
};

/** Every script data tag in an FLV, in order, with the timestamp the tag itself states. */
const scriptTagsOf = (file: string) => {
	const bytes = new Uint8Array(readFileSync(file));
	const view = new DataView(bytes.buffer);

	// FLV header: 'FLV', version, flags, then its own length
	const headerLength = view.getUint32(5, false);
	let at = headerLength + 4; // Plus the first back-pointer

	const tags: { timestamp: number; name: string; value: AmfValue }[] = [];

	while (at + 11 <= bytes.length) {
		const type = bytes[at]!;
		const size = (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
		const timestamp = ((bytes[at + 7]! << 24) >>> 0)
			| (bytes[at + 4]! << 16) | (bytes[at + 5]! << 8) | bytes[at + 6]!;

		const body = at + 11;
		if (body + size > bytes.length) {
			break;
		}

		if (type === 18) {
			tags.push({ timestamp, ...readAmf0(bytes.subarray(body, body + size)) });
		}

		at = body + size + 4; // Plus the back-pointer
	}

	return tags;
};

/**
 * A TCP proxy that copies both directions and keeps what the publisher sent.
 *
 * ffmpeg's FLV demuxer understands `onMetaData` and `onTextData` and skips every other script tag, so
 * a message that never reaches the file it writes may still have gone out perfectly. The recorded
 * octets settle that; ffmpeg still terminates the connection, so if this proxy broke the stream the
 * other assertions would fail rather than this one quietly passing.
 */
const recordingProxy = async (upstreamPort: number) => {
	const chunks: Buffer[] = [];

	const server = createServer((client) => {
		const upstream = connect(upstreamPort, '127.0.0.1');
		client.on('data', chunk => chunks.push(chunk));
		client.pipe(upstream);
		upstream.pipe(client);
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
	});

	const port = await new Promise<number>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});

	return {
		port,
		sent: () => Buffer.concat(chunks),
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
};

/**
 * Publishes the fixture with `send` called against the target, into an ffmpeg that is listening, and
 * gives back the script tags of the FLV ffmpeg wrote plus everything the publisher put on the wire.
 */
const publishThroughFfmpeg = async (name: string, send: (target: RtmpTarget) => void) => {
	const port = freePort();
	const url = `rtmp://127.0.0.1:${port}/live/key`;
	const received = path.join(workDir, `${name}.flv`);

	// `-listen 1` accepts exactly one publish; rtmp's accept bound is `timeout`, in SECONDS
	const listener = spawn('ffmpeg', [
		'-v', 'error', '-y', '-listen', '1', '-timeout', '30',
		// `-map 0`: the default mapping takes one stream per type, which drops the data stream the
		// messages ride on and would make this test fail for the receiver's reasons, not ours
		'-i', url, '-map', '0', '-c', 'copy', '-f', 'flv', received,
	], { stdio: ['ignore', 'ignore', 'pipe'] });

	let listenerError = '';
	listener.stderr.on('data', (chunk: Buffer) => {
		listenerError += chunk.toString();
	});

	const finished = new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.once('close', () => resolve());
	});

	// The listener has to be accepting before the publisher dials
	await new Promise(resolve => setTimeout(resolve, 1500));

	const proxy = await recordingProxy(port);
	const target = new RtmpTarget(`rtmp://127.0.0.1:${proxy.port}/live/key`);
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target });
	using input = new Input({ source: new FilePathSource(FIXTURE), formats: ALL_FORMATS });

	const conversion = await Conversion.init({ input, output, showWarnings: false, trim: { start: 0, end: 1 } });
	send(target);
	await conversion.execute();

	await finished;
	await proxy.close();

	// A publisher that stops publishing closes the connection, which ffmpeg reports as an I/O error
	// during demuxing - that is the stream ending, not a failure. Anything else is one.
	const realErrors = listenerError
		.split('\n')
		.filter(line => line.trim() && !/Error during demuxing: Input\/output error/.test(line));
	expect(realErrors, 'the receiving ffmpeg').toEqual([]);

	return { tags: scriptTagsOf(received), target, onTheWire: proxy.sent() };
};

describe('AMF0, built against the format', () => {
	// Round-tripping through the reader above is not the point - the point is which octets go out, and
	// AMF0 has traps a round trip cannot see. Every number is a float64, including integers.
	test('an integer is still a float64, because AMF0 has no integer type', () => {
		const bytes = encodeAmf0Value(42);
		expect(bytes[0], 'the number marker').toBe(0x00);
		expect(bytes.length).toBe(9);
		expect(new DataView(bytes.buffer).getFloat64(1, false)).toBe(42);
	});

	test('an object ends with an EMPTY NAME before the end marker', () => {
		// A reader reads a property name first and the marker second, so an object terminated by the
		// marker alone leaves it reading the next message's octets as a name
		const bytes = encodeAmf0Value({ a: true });
		expect([...bytes.subarray(-3)]).toEqual([0x00, 0x00, 0x09]);
	});

	test('a string is length-prefixed in 16 bits, and a longer one is a different type', () => {
		expect(encodeAmf0Value('hi')[0]).toBe(0x02);
		expect(encodeAmf0Value('x'.repeat(70_000))[0], 'a long string').toBe(0x0c);
	});

	test('a data message is the name then one value', () => {
		const bytes = encodeAmfDataMessage('onTextData', { text: 'hello' });
		expect(bytes[0], 'the name is a plain AMF string, with its marker').toBe(0x02);
		expect(readAmf0(bytes)).toEqual({ name: 'onTextData', value: { text: 'hello' } });
	});

	test('an ECMA array states its count, which an object does not', () => {
		const object = encodeAmfDataMessage('x', { a: 1, b: 2 });
		const array = encodeAmfDataMessage('x', { a: 1, b: 2 }, true);

		expect(array.length).toBe(object.length + 4);
		expect(readAmf0(array).value).toEqual({ a: 1, b: 2 });
	});

	test('a message with no name is refused, since that is what a receiver dispatches on', () => {
		expect(() => encodeAmfDataMessage('', { a: 1 })).toThrow(/must be named/);
	});

	test('an infinity is refused rather than written as one', () => {
		expect(() => encodeAmf0Value(Infinity)).toThrow(/finite numbers only/);
		expect(() => encodeAmf0Value(NaN)).toThrow(/finite numbers only/);
	});
});

describe.skipIf(!hasFfmpeg)('over the wire', () => {
	// Two different questions, and they need two different oracles.
	//
	//   - **Did the message go out, as the octets we meant?** The recorded TCP stream answers that.
	//     RTMP chunks a payload, but a script tag of this size fits in one chunk, so the AMF appears
	//     contiguously.
	//   - **Can a receiver read it?** ffmpeg answers that, and only for `onTextData`: its FLV demuxer
	//     understands `onMetaData` and `onTextData` and skips every other script tag. It also keeps
	//     only the `text` property and rebuilds the message around it, so what comes out the far side
	//     of an ffmpeg hop is `{ type: 'Text', text }` whatever went in. That is ffmpeg's doing, and
	//     the wire check is what distinguishes it from ours.

	const contains = (haystack: Buffer, needle: Uint8Array) => haystack.includes(Buffer.from(needle));

	test('a cue point goes out as the AMF0 it should be', async () => {
		const cue = {
			name: 'ad-break-1',
			type: 'event' as const,
			time: 0.5,
			parameters: { duration: 30, provider: 'mediabunny' },
		};

		const { onTheWire, target } = await publishThroughFfmpeg('cue', (rtmp) => {
			rtmp.sendCuePoint(cue);
		});

		expect(target.amfMessagesSent).toBe(1);

		const expected = encodeAmfDataMessage('onCuePoint', {
			name: cue.name,
			type: cue.type,
			time: cue.time,
			parameters: cue.parameters,
		});

		expect(contains(onTheWire, expected), 'the whole message, octet for octet').toBe(true);

		// And it really was parsed off the wire rather than matched as text: the AMF around the name
		// is what carries the numbers, and `30` is eight octets of float64 that no string contains
		const at = onTheWire.indexOf(Buffer.from(expected));
		expect(readAmf0(new Uint8Array(onTheWire.subarray(at, at + expected.length)))).toEqual({
			name: 'onCuePoint',
			value: { name: cue.name, type: 'event', time: 0.5, parameters: { duration: 30, provider: 'mediabunny' } },
		});
	}, 120_000);

	test('text data goes out, and a receiver reads it back', async () => {
		const { tags, onTheWire } = await publishThroughFfmpeg('text', (rtmp) => {
			rtmp.sendTextData('a caption', { timestamp: 0.25, language: 'eng' });
		});

		expect(
			contains(onTheWire, encodeAmfDataMessage('onTextData', { text: 'a caption', language: 'eng' })),
			'what we sent',
		).toBe(true);

		// What ffmpeg makes of it: the text survives, the rest is its own
		const texts = tags.filter(tag => tag.name === 'onTextData');
		expect(texts.length, 'ffmpeg read it back out of the stream').toBe(1);
		expect((texts[0]!.value as { text: string }).text).toBe('a caption');
		// Not the absolute 250: ffmpeg restarts the FLV timeline at zero, so every tag is shifted by
		// one constant. The interval between messages is what survives, and the next test checks it.
		expect(texts[0]!.timestamp).toBeGreaterThanOrEqual(0);
	}, 120_000);

	test('several messages keep their order and their own times', async () => {
		const { onTheWire, target, tags } = await publishThroughFfmpeg('several', (rtmp) => {
			for (let i = 0; i < 4; i++) {
				rtmp.sendAmfData('onTextData', { text: `line ${i}` }, { timestamp: i * 0.1 });
			}
		});

		expect(target.amfMessagesSent).toBe(4);

		const positions = [0, 1, 2, 3].map(i =>
			onTheWire.indexOf(Buffer.from(encodeAmfDataMessage('onTextData', { text: `line ${i}` }))),
		);

		expect(positions.every(position => position !== -1), 'all four went out').toBe(true);
		expect(positions, 'in the order they were sent').toEqual([...positions].sort((a, b) => a - b));

		// And each kept its own time. Asserted as INTERVALS: the whole FLV timeline is shifted by a
		// constant, because ffmpeg restarts it at zero, so the absolute values are not ours to state -
		// but a message given the time of whatever packet it rode beside, instead of its own, would
		// not be 100 ms from the one before it.
		const texts = tags.filter(tag => tag.name === 'onTextData');
		expect(texts.length).toBe(4);

		const times = texts.map(tag => tag.timestamp);
		for (let i = 1; i < times.length; i++) {
			expect(times[i]! - times[i - 1]!, `message ${i}`).toBe(100);
		}
	}, 120_000);

	test('a message with no timestamp takes the time of the packet it rides beside', async () => {
		const { tags } = await publishThroughFfmpeg('untimed', (rtmp) => {
			rtmp.sendTextData('no time of its own');
		});

		const texts = tags.filter(tag => tag.name === 'onTextData');
		expect(texts.length).toBe(1);
		// Not asserted as a particular value: it is whichever packet happened to be written first,
		// which the publish timing decides. That it is ON the timeline is the point.
		expect(texts[0]!.timestamp).toBeGreaterThanOrEqual(0);
		expect(texts[0]!.timestamp).toBeLessThan(2000);
	}, 120_000);

	test('ffmpeg still writes its own onMetaData, so the stream is a normal one', async () => {
		// Adding a data stream to the muxer could have broken the FLV outright, and its own metadata
		// would be the first casualty
		const { tags } = await publishThroughFfmpeg('metadata', (rtmp) => {
			rtmp.sendTextData('beside the metadata');
		});

		expect(tags.map(tag => tag.name)).toContain('onMetaData');
	}, 120_000);
});

describe('refusals', () => {
	test('a cue point with no name, or a negative time', () => {
		const target = new RtmpTarget('rtmp://127.0.0.1:1/live/key');
		expect(() => target.sendCuePoint({ name: '', time: 0 })).toThrow(/must be named/);
		expect(() => target.sendCuePoint({ name: 'x', time: -1 })).toThrow(/non-negative/);
	});

	test('a timestamp that is not a non-negative number', () => {
		const target = new RtmpTarget('rtmp://127.0.0.1:1/live/key');
		expect(() => target.sendAmfData('x', null, { timestamp: -1 })).toThrow(/non-negative/);
		expect(() => target.sendAmfData('x', null, { timestamp: NaN })).toThrow(/non-negative/);
	});
});
