/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The DVB time and network tables: TDT and TOT on PID 0x0014, NIT on 0x0010.
//
// **ffmpeg cannot check these.** Its transport stream demuxer does not parse TDT, TOT or the MJD time
// encoding at all - measured, `mjd` and the table ids appear nowhere in `libavformat/mpegts.c` - so
// there is no foreign decoder to read them back. TSDuck would be the tool and is not installed here.
//
// So the constants came from TSDuck's source instead of from recollection (`MJD_EPOCH = 40587`,
// `TDT_TID = 0x70`, `TOT_TID = 0x73`, `DID_DVB_LOCAL_TIME_OFFSET = 0x58`, and the detail that a TOT is
// "a short section with a CRC32" where a TDT carries none), and the expectations below are derived from
// the date arithmetic rather than from a run of the writer: the MJD of a date is computed here from the
// Unix epoch independently of the code under test.

import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat, type MpegTsOutputFormatOptions } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { computeMpegTsCrc32, readDvbUtcTime } from '../../src/mpeg-ts/mpeg-ts-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

/** A fixed instant, so the encoded time can be checked against arithmetic rather than against a clock. */
const WHEN = new Date('2026-11-19T14:35:07Z');

/** 17 November 1858 to 1 January 1970, which is what makes a Modified Julian Date. */
const MJD_UNIX_EPOCH = 40587;

/** The MJD of an instant, worked out here so the writer's own constant is not the thing under test. */
const expectedMjd = (when: Date) => Math.floor(when.getTime() / 86_400_000) + MJD_UNIX_EPOCH;

const write = async (options: MpegTsOutputFormatOptions) => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const codec = await track.getCodec();
	assert(codec);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({
		format: new MpegTsOutputFormat(options),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source, { frameRate: 30 });

	await output.start();
	const sink = new EncodedPacketSink(track);
	let written = 0;
	for (
		let packet = await sink.getFirstPacket();
		packet && written < 40;
		packet = await sink.getNextPacket(packet)
	) {
		await source.add(packet, { decoderConfig });
		written++;
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

/** Every PSI section carried on `pid`, reassembled from its packets by the pointer field. */
const sectionsOn = (ts: Uint8Array, pid: number) => {
	const sections: Uint8Array[] = [];

	for (let off = 0; off + 188 <= ts.length; off += 188) {
		if (ts[off] !== 0x47 || (((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!) !== pid) {
			continue;
		}
		if ((ts[off + 1]! & 0x40) === 0) {
			continue; // Only the packet that starts a section; these all fit in one
		}

		const adaptationControl = (ts[off + 3]! >> 4) & 0b11;
		let start = off + 4;
		if (adaptationControl === 0b11) {
			start += 1 + ts[off + 4]!;
		}

		start += 1 + ts[start]!; // pointer_field
		const length = ((ts[start + 1]! & 0x0f) << 8) | ts[start + 2]!;
		sections.push(ts.subarray(start, start + 3 + length));
	}

	return sections;
};

const uniqueSections = (ts: Uint8Array, pid: number, tableId: number) => {
	const seen = new Map<string, Uint8Array>();
	for (const section of sectionsOn(ts, pid)) {
		if (section[0] === tableId) {
			seen.set([...section].join(','), section);
		}
	}

	return [...seen.values()];
};

describe('the Time and Date Table', () => {
	test('is a short section with no CRC, carrying the time as MJD plus BCD', async () => {
		const ts = await write({ dvbTime: { now: () => WHEN } });
		const sections = uniqueSections(ts, 0x0014, 0x70);

		expect(sections.length, 'at least one TDT').toBeGreaterThan(0);
		const tdt = sections[0]!;

		// section_syntax_indicator is 0: this table carries no CRC at all, which is unique to the TDT
		expect((tdt[1]! & 0x80) >> 7, 'section_syntax_indicator').toBe(0);
		// section_length 5 is exactly the UTC_time and nothing else - no room for a CRC
		expect(((tdt[1]! & 0x0f) << 8) | tdt[2]!, 'section_length').toBe(5);
		expect(tdt.length, 'three octets of header and five of time').toBe(8);

		// The time, against arithmetic done here rather than by the writer
		expect((tdt[3]! << 8) | tdt[4]!, 'MJD').toBe(expectedMjd(WHEN));
		expect(tdt[5], 'hours in BCD').toBe(0x14);
		expect(tdt[6], 'minutes in BCD').toBe(0x35);
		expect(tdt[7], 'seconds in BCD').toBe(0x07);

		// And it reads back as the instant it was given
		expect(readDvbUtcTime(tdt, 3).toISOString()).toBe(WHEN.toISOString());
	});

	test('the epoch is pinned to a published Modified Julian Date, not to our own formula', async () => {
		// 1 January 2000 00:00 UTC is MJD 51544 - a value published independently of any of this, and
		// the thing that makes the 40587 constant checkable rather than merely restated. The arithmetic
		// elsewhere in this file uses the same formula as the writer, so it would agree with a wrong
		// epoch; this does not.
		const millennium = new Date('2000-01-01T00:00:00Z');
		const ts = await write({ dvbTime: { now: () => millennium } });
		const tdt = uniqueSections(ts, 0x0014, 0x70)[0]!;

		expect((tdt[3]! << 8) | tdt[4]!).toBe(51_544);
		expect(expectedMjd(millennium), 'and this file\'s own arithmetic agrees').toBe(51_544);
	});

	test('is not written at all unless asked for', async () => {
		const ts = await write({});
		expect(sectionsOn(ts, 0x0014)).toEqual([]);
	});
});

describe('the Time Offset Table', () => {
	const REGIONS = [{
		country: 'GBR',
		offsetMinutes: 60,
		nextChange: new Date('2026-10-25T02:00:00Z'),
		nextOffsetMinutes: 0,
	}];

	test('is a short section that nonetheless ends in a CRC', async () => {
		// The quirk worth pinning: section_syntax_indicator is 0, so nothing in the header says a CRC
		// follows, and a parser has to know from the table id. TSDuck models exactly this.
		const ts = await write({ dvbTime: { now: () => WHEN, regions: REGIONS } });
		const sections = uniqueSections(ts, 0x0014, 0x73);
		expect(sections.length).toBeGreaterThan(0);

		const tot = sections[0]!;
		expect((tot[1]! & 0x80) >> 7, 'section_syntax_indicator').toBe(0);

		// The CRC is over everything before it, and must come out zero when run over the whole section
		const stated = (tot[tot.length - 4]! << 24 | tot[tot.length - 3]! << 16
			| tot[tot.length - 2]! << 8 | tot[tot.length - 1]!) >>> 0;
		expect(stated, 'the CRC is over the section ahead of it')
			.toBe(computeMpegTsCrc32(tot.subarray(0, tot.length - 4)));
	});

	test('states each region with its offset, next change and next offset', async () => {
		const ts = await write({ dvbTime: { now: () => WHEN, regions: REGIONS } });
		const tot = uniqueSections(ts, 0x0014, 0x73)[0]!;

		expect(readDvbUtcTime(tot, 3).toISOString()).toBe(WHEN.toISOString());

		// reserved(4) + descriptors_loop_length(12), then the descriptor
		const loopLength = ((tot[8]! & 0x0f) << 8) | tot[9]!;
		expect(loopLength, 'one 13-octet region plus the two descriptor octets').toBe(15);
		expect(tot[10], 'local_time_offset_descriptor').toBe(0x58);
		expect(tot[11], 'descriptor_length').toBe(13);

		expect(String.fromCharCode(tot[12]!, tot[13]!, tot[14]!)).toBe('GBR');
		expect(tot[15]! >> 2, 'country_region_id').toBe(0);
		expect((tot[15]! >> 1) & 1, 'the reserved bit is set, as TSDuck writes it').toBe(1);
		expect(tot[15]! & 1, 'polarity: 0 for ahead of UTC').toBe(0);
		expect(tot[16], 'one hour, in BCD').toBe(0x01);
		expect(tot[17]).toBe(0x00);
		expect(readDvbUtcTime(tot, 18).toISOString()).toBe(REGIONS[0]!.nextChange.toISOString());
		expect(tot[23], 'the next offset is zero').toBe(0x00);
		expect(tot[24]).toBe(0x00);
	});

	test('a region behind UTC sets the polarity bit', async () => {
		const ts = await write({
			dvbTime: {
				now: () => WHEN,
				regions: [{
					country: 'USA',
					regionId: 2,
					offsetMinutes: -300,
					nextChange: new Date('2026-11-01T06:00:00Z'),
					nextOffsetMinutes: -360,
				}],
			},
		});
		const tot = uniqueSections(ts, 0x0014, 0x73)[0]!;

		expect(tot[15]! >> 2, 'country_region_id 2').toBe(2);
		expect(tot[15]! & 1, 'polarity: 1 for behind UTC').toBe(1);
		expect(tot[16], 'five hours, as a magnitude').toBe(0x05);
		expect(tot[23], 'and six for the next').toBe(0x06);
	});

	test('no regions means no TOT, since it would say nothing the TDT has not', async () => {
		const ts = await write({ dvbTime: { now: () => WHEN } });
		expect(uniqueSections(ts, 0x0014, 0x70).length, 'the TDT is there').toBeGreaterThan(0);
		expect(uniqueSections(ts, 0x0014, 0x73), 'the TOT is not').toEqual([]);
	});

	test('the TDT and the TOT beside it state the same instant', async () => {
		// One reading of the clock for both, so they cannot disagree
		const ts = await write({ dvbTime: { regions: REGIONS } });
		const tdt = uniqueSections(ts, 0x0014, 0x70)[0]!;
		const tot = uniqueSections(ts, 0x0014, 0x73)[0]!;

		expect(readDvbUtcTime(tot, 3).getTime()).toBe(readDvbUtcTime(tdt, 3).getTime());
	});
});

describe('the Network Information Table', () => {
	test('names the network and lists this transport stream', async () => {
		const ts = await write({ network: { id: 0x2024, name: 'Test Network' } });
		const sections = uniqueSections(ts, 0x0010, 0x40);

		expect(sections.length).toBeGreaterThan(0);
		const nit = sections[0]!;

		expect((nit[1]! & 0x80) >> 7, 'a long section, so it has a CRC').toBe(1);
		expect((nit[3]! << 8) | nit[4]!, 'network_id').toBe(0x2024);

		const networkDescriptorsLength = ((nit[8]! & 0x0f) << 8) | nit[9]!;
		expect(nit[10], 'network_name_descriptor').toBe(0x40);
		expect(nit[11], 'its length').toBe('Test Network'.length);
		expect(String.fromCharCode(...nit.subarray(12, 12 + 12))).toBe('Test Network');
		expect(networkDescriptorsLength).toBe(2 + 12);

		// The transport stream loop follows the network descriptors
		const loopAt = 10 + networkDescriptorsLength;
		const loopLength = ((nit[loopAt]! & 0x0f) << 8) | nit[loopAt + 1]!;
		expect(loopLength, 'one entry of six octets and no descriptors').toBe(6);
		expect((nit[loopAt + 2]! << 8) | nit[loopAt + 3]!, 'transport_stream_id').toBeGreaterThan(0);

		const stated = (nit[nit.length - 4]! << 24 | nit[nit.length - 3]! << 16
			| nit[nit.length - 2]! << 8 | nit[nit.length - 1]!) >>> 0;
		expect(stated).toBe(computeMpegTsCrc32(nit.subarray(0, nit.length - 4)));
	});

	test('carries the caller\'s delivery descriptors against the transport stream', async () => {
		// Only the caller knows the modulation and frequency, so these are theirs to supply
		const terrestrial = new Uint8Array([0x5a, 0x0b, ...new Array<number>(11).fill(0)]);
		const ts = await write({
			network: { id: 1, name: 'N', transportDescriptors: [terrestrial] },
		});
		const nit = uniqueSections(ts, 0x0010, 0x40)[0]!;

		const networkDescriptorsLength = ((nit[8]! & 0x0f) << 8) | nit[9]!;
		const loopAt = 10 + networkDescriptorsLength;
		expect(((nit[loopAt]! & 0x0f) << 8) | nit[loopAt + 1]!, 'six plus the descriptor').toBe(6 + 13);
		expect(((nit[loopAt + 6]! & 0x0f) << 8) | nit[loopAt + 7]!, 'descriptor loop length').toBe(13);
		expect(nit[loopAt + 8], 'terrestrial_delivery_system_descriptor').toBe(0x5a);
	});

	test('is not written unless asked for', async () => {
		expect(sectionsOn(await write({}), 0x0010)).toEqual([]);
	});
});

describe('refusals', () => {
	test('a country code that is not three letters is refused', () => {
		expect(() => new MpegTsOutputFormat({
			dvbTime: {
				regions: [{
					country: 'UK',
					offsetMinutes: 0,
					nextChange: WHEN,
					nextOffsetMinutes: 0,
				}],
			},
		})).toThrow(/three-letter ISO 3166/);
	});

	test('an offset that BCD cannot hold is refused', () => {
		expect(() => new MpegTsOutputFormat({
			dvbTime: {
				regions: [{
					country: 'GBR',
					offsetMinutes: 90.5,
					nextChange: WHEN,
					nextOffsetMinutes: 0,
				}],
			},
		})).toThrow(/whole number of minutes/);
	});

	test('a region id beyond its six bits is refused', () => {
		expect(() => new MpegTsOutputFormat({
			dvbTime: {
				regions: [{
					country: 'GBR',
					regionId: 64,
					offsetMinutes: 0,
					nextChange: WHEN,
					nextOffsetMinutes: 0,
				}],
			},
		})).toThrow(/from 0 to 63/);
	});

	test('a network id beyond sixteen bits is refused', () => {
		expect(() => new MpegTsOutputFormat({ network: { id: 0x10000, name: 'N' } }))
			.toThrow(/from 0 to 65535/);
	});
});
