/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Timed ID3 rides differently in each container: a PES on a declared PID in a transport stream, an
// `emsg` ahead of the `moof` in a fragmented MP4. One call writes either, and what comes out is read
// back out of the bytes - the PES with this library's own reader, the `emsg` with `readEmsgs`.

import { describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { FilePathSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { addId3Metadata, ID3_EMSG_SCHEME } from '../../src/mpeg-ts/id3-output.js';
import { addPrivatePesPayload } from '../../src/mpeg-ts/private-streams-output.js';
import { readPrivatePesPayloads } from '../../src/mpeg-ts/private-streams.js';
import { readEmsgs } from '../../src/emsg.js';
import { bytesToHexString } from '../../src/misc.js';

registerMediabunnyServer();

const SOURCE = new URL('../public/demo.mp4', import.meta.url).pathname;
const ID3_PID = 0x1e2;
/** The default mediaTimestampBase for HLS: splice and metadata times are on the output's timeline. */
const HLS_BASE = 10;

/** A minimal but real ID3v2.4 tag carrying one TXXX frame, so the bytes mean something. */
const id3Tag = (text: string) => {
	const body = [0x03, ...[...text].map(c => c.charCodeAt(0)), 0]; // UTF-8 encoding byte, text, null
	const frame = [
		0x54, 0x58, 0x58, 0x58, // 'TXXX'
		0, 0, 0, body.length,
		0, 0, // flags
		...body,
	];
	const size = frame.length;
	return new Uint8Array([
		0x49, 0x44, 0x33, // 'ID3'
		0x04, 0x00, // version 2.4
		0x00, // flags
		// Syncsafe size, 7 bits per byte
		(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
		...frame,
	]);
};

const publish = async (options: {
	segments: 'mpeg-ts' | 'cmaf';
	write: (output: Output) => void;
	/** Stated, even as `undefined`, to write a format that declares no PID at all. */
	timedMetadataPid?: number | undefined;
}) => {
	using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });

	const segments: Uint8Array[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: options.segments === 'cmaf'
				? new CmafOutputFormat()
				: new MpegTsOutputFormat(
					'timedMetadataPid' in options
						? { timedMetadataPid: options.timedMetadataPid }
						: { timedMetadataPid: ID3_PID },
				),
			targetDuration: 1,
			onSegment: target => void segments.push(new Uint8Array((target as BufferTarget).buffer!)),
		}),
		target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
	});

	const conversion = await Conversion.init({ input, output, audio: { discard: true } });
	options.write(output);
	await conversion.execute();

	return segments;
};

describe('ID3 through a segmented output', () => {
	test('a transport stream carries it as a PES on the declared PID', async () => {
		const tag = id3Tag('hello');
		const segments = await publish({
			segments: 'mpeg-ts',
			write: output => addId3Metadata(output, { time: HLS_BASE + 1.5, data: tag }),
		});

		const found = segments.map(segment => readPrivatePesPayloads(segment, ID3_PID));
		// The segment covering 11.5 s on a 1 s grid from 10 is the second one
		expect(found.map(list => list.length)).toEqual([0, 1, ...found.slice(2).map(() => 0)]);

		const payload = found[1]![0]!;
		expect(bytesToHexString(payload.data)).toBe(bytesToHexString(tag));
		expect(payload.time).toBeCloseTo(HLS_BASE + 1.5, 3);
	}, 300_000);

	test('the PMT names it with stream type 0x15 and the ID3 metadata descriptor', async () => {
		const segments = await publish({
			segments: 'mpeg-ts',
			write: output => addId3Metadata(output, { time: HLS_BASE + 0.5, data: id3Tag('x') }),
		});

		// The descriptor FFmpeg writes for a timed ID3 stream, byte for byte: tag 0x26, length 13, the
		// escape application format and 'ID3 ', the escape metadata format and 'ID3 ', service id 0, and
		// the flags byte
		const descriptor = '260dffff49443320ff49443320000f';
		const hex = bytesToHexString(segments[0]!);
		expect(hex).toContain(descriptor);

		// And the PMT's elementary stream entry states type 0x15 on that PID
		expect(hex).toContain(`15e${ID3_PID.toString(16)}`);
	}, 300_000);

	test('a fragmented MP4 carries it as an emsg before the moof', async () => {
		const tag = id3Tag('cmaf');
		const segments = await publish({
			segments: 'cmaf',
			write: output => addId3Metadata(output, { time: HLS_BASE + 1.5, data: tag }),
		});

		const withEmsg = segments.map(segment => readEmsgs(segment));
		expect(withEmsg.map(list => list.length)).toEqual([0, 1, ...withEmsg.slice(2).map(() => 0)]);

		const emsg = withEmsg[1]![0]!;
		expect(emsg.schemeIdUri).toBe(ID3_EMSG_SCHEME);
		expect(bytesToHexString(emsg.messageData)).toBe(bytesToHexString(tag));
		// Stated relative to the segment, so it reads without knowing where the segment sits
		expect(emsg.presentationTimeDelta).toBeDefined();
		expect(emsg.presentationTimeDelta! / emsg.timescale).toBeCloseTo(0.5, 1);

		// The box precedes the moof it belongs to
		const hex = bytesToHexString(segments[1]!);
		expect(hex.indexOf('656d7367')).toBeLessThan(hex.indexOf('6d6f6f66'));
	}, 300_000);

	test('a tag is refused where the transport stream declares no PID for it', async () => {
		await expect(publish({
			segments: 'mpeg-ts',
			// Declared on a PID of its own below, so the format states none
			timedMetadataPid: undefined,
			write: output => addId3Metadata(output, { time: HLS_BASE + 0.5, data: id3Tag('x') }),
		})).rejects.toThrow(/timedMetadataPid/);
	}, 300_000);

	test('an empty tag is refused at the call', async () => {
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 1 }),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		expect(() => addId3Metadata(output, { time: 0, data: new Uint8Array(0) })).toThrow(/cannot be empty/);
		expect(() => addId3Metadata(output, { time: NaN, data: id3Tag('x') })).toThrow(/number of seconds/);
	});

	test('a private PES payload reaches a segmented output as well', async () => {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		using input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });

		const segments: Uint8Array[] = [];
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat({
					privateStreams: [{ pid: 0x1f10, descriptors: [new Uint8Array([0x56, 0x00])] }],
				}),
				targetDuration: 1,
				onSegment: target => void segments.push(new Uint8Array((target as BufferTarget).buffer!)),
			}),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		const conversion = await Conversion.init({ input, output, audio: { discard: true } });
		addPrivatePesPayload(output, { pid: 0x1f10, time: HLS_BASE + 2.5, data });
		await conversion.execute();

		const found = segments.map(segment => readPrivatePesPayloads(segment, 0x1f10));
		expect(found.map(list => list.length)).toEqual([0, 0, 1, ...found.slice(3).map(() => 0)]);
		expect([...found[2]![0]!.data]).toEqual([...data]);
	}, 300_000);
});
