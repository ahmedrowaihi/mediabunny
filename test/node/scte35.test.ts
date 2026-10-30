import { expect, test } from 'vitest';
import { parseSpliceInfoSection, readScte35Sections } from '../../src/mpeg-ts/scte35.js';
import { TS_PACKET_SIZE } from '../../src/mpeg-ts/mpeg-ts-misc.js';

const crcPlaceholder = [0, 0, 0, 0];

const section = (tableId: number, body: number[]) => {
	const length = body.length + crcPlaceholder.length;
	return [tableId, 0xb0 | (length >> 8), length & 0xff, ...body, ...crcPlaceholder];
};

/** PAT naming one program whose map lives on `pmtPid`. */
const pat = (pmtPid: number) => section(0x00, [
	0, 1, 0xc1, 0, 0,
	0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff,
]);

/** PMT listing one elementary stream, with the descriptors given verbatim. */
const pmt = (streamType: number, pid: number, descriptors: number[]) => section(0x02, [
	0, 1, 0xc1, 0, 0,
	0xff, 0xff, // PCR PID
	0xf0, 0x00, // program_info_length 0
	streamType, 0xe0 | (pid >> 8), pid & 0xff,
	0xf0 | (descriptors.length >> 8), descriptors.length & 0xff,
	...descriptors,
]);

const cueiRegistration = [0x05, 0x04, 0x43, 0x55, 0x45, 0x49];

/** 33 bits across a flag byte and four more, as SCTE 35 writes pts_adjustment and splice_time. */
const bits33 = (value: number, leadingFlags: number) => [
	leadingFlags | Number(Math.floor(value / 2 ** 32) & 1),
	(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
];

const timeSignal = (ptsAdjustment: number, spliceTime: number) => {
	const command = [...bits33(spliceTime, 0xfe)];
	return section(0xfc, [
		0, // protocol_version
		...bits33(ptsAdjustment, 0x00), // encrypted_packet=0 and pts_adjustment
		0xff, // cw_index
		0, 0, // tier (12 bits) + splice_command_length high
		0x00 | command.length, // splice_command_length low
		0x06, // time_signal
		...command,
		0, 0, // descriptor_loop_length
	]);
};

/**
 * A `splice_insert` whose flag byte is given verbatim, so a test can state the real wire combinations:
 * out_of_network 0x80, program_splice 0x40, duration 0x20, splice_immediate 0x10 (SCTE 35 section 9.7.3).
 */
const spliceInsert = (eventId: number, flags: number, spliceTime: number, breakDuration?: number) => {
	const command = [
		(eventId >>> 24) & 0xff, (eventId >>> 16) & 0xff, (eventId >>> 8) & 0xff, eventId & 0xff,
		0x7f, // splice_event_cancel_indicator=0 + reserved
		flags,
		...((flags & 0x10) === 0 && (flags & 0x40) !== 0 ? bits33(spliceTime, 0xfe) : []),
		...(breakDuration !== undefined ? bits33(breakDuration, 0xfe) : []),
		0, 0, // unique_program_id
		0, 0, // avail_num, avails_expected
	];

	return section(0xfc, [
		0, // protocol_version
		...bits33(0, 0x00), // encrypted_packet=0 and pts_adjustment
		0xff, // cw_index
		0, 0, // tier (12 bits) + splice_command_length high
		0x00 | command.length, // splice_command_length low
		0x05, // splice_insert
		...command,
		0, 0, // descriptor_loop_length
	]);
};

const packetize = (pid: number, payload: number[]) => {
	const body = [0, ...payload]; // pointer_field
	const packet = [0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, ...body];
	while (packet.length < TS_PACKET_SIZE) {
		packet.push(0xff);
	}
	return packet.slice(0, TS_PACKET_SIZE);
};

const stream = (descriptors: number[], streamType = 0x86) => Uint8Array.from([
	...packetize(0x0000, pat(0x1000)),
	...packetize(0x1000, pmt(streamType, 0x0100, descriptors)),
	...packetize(0x0100, timeSignal(0, 90_000)),
]);

test('reads a time_signal from a CUEI-registered stream, with its splice time', () => {
	const sections = readScte35Sections(stream(cueiRegistration));

	expect(sections).toHaveLength(1);
	expect(sections[0]!.commandType).toBe(0x06);
	expect(sections[0]!.time).toBeCloseTo(1, 6);
	expect(sections[0]!.section[0]).toBe(0xfc);
});

test('pts_adjustment is added to the splice time', () => {
	const bytes = Uint8Array.from([
		...packetize(0x0000, pat(0x1000)),
		...packetize(0x1000, pmt(0x86, 0x0100, cueiRegistration)),
		...packetize(0x0100, timeSignal(90_000, 90_000)),
	]);

	const sections = readScte35Sections(bytes);
	expect(sections).toHaveLength(1);
	expect(sections[0]!.ptsAdjustment).toBe(90_000);
	expect(sections[0]!.time).toBeCloseTo(2, 6);
});

// Stream type 0x86 is DTS-HD Master Audio under Blu-ray, so the registration is what disambiguates it.
test('stream type 0x86 without a CUEI registration yields nothing', () => {
	expect(readScte35Sections(stream([]))).toEqual([]);
});

test('a stream carrying no SCTE-35 at all yields nothing', () => {
	expect(readScte35Sections(stream(cueiRegistration, 0x1b))).toEqual([]);
});

test('refuses a section that is not a splice_info_section', () => {
	expect(() => parseSpliceInfoSection(Uint8Array.from(section(0x02, Array.from({ length: 20 }, () => 0)))))
		.toThrow(/table_id 0x2/);
	expect(() => parseSpliceInfoSection(Uint8Array.from([0xfc, 0, 0])))
		.toThrow(/too short/);
});

// SCTE 35 section 9.7.3 orders the flags out_of_network, program_splice, duration, splice_immediate, so a
// mask of 0x20 reads the duration flag and loses the time of every cue-out that states a break duration —
// which is what a normal ad break looks like.
const spliceInsertCases: [string, number, number | null][] = [
	['a cue-out with a break duration states its time', 0xef, 475_200],
	['a cue-in without a duration states its time', 0x4f, 475_200],
	['an immediate splice states no time', 0xdf, null],
];

for (const [name, flags, expected] of spliceInsertCases) {
	test(`splice_insert: ${name}`, () => {
		const bytes = Uint8Array.from([
			...packetize(0x0000, pat(0x1000)),
			...packetize(0x1000, pmt(0x86, 0x0100, cueiRegistration)),
			...packetize(0x0100, spliceInsert(77, flags, 475_200, (flags & 0x20) ? 2_699_488 : undefined)),
		]);

		const sections = readScte35Sections(bytes);
		expect(sections).toHaveLength(1);
		expect(sections[0]!.commandType).toBe(0x05);

		if (expected === null) {
			expect(sections[0]!.time).toBeNull();
		} else {
			expect(sections[0]!.time).toBeCloseTo(expected / 90_000, 6);
		}
	});
}
