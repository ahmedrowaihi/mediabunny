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

// A playlist marker needs more than the splice time: an #EXT-X-CUE-OUT states how long the break runs
// and an #EXT-X-CUE-IN closes it, so the section has to say which it is. `splice_insert` states it in
// its own flags; a `time_signal` states it in a segmentation_descriptor's type id (SCTE 35 table 23).

/** A `segmentation_descriptor`, as a time_signal carries it (SCTE 35 10.3.3). */
const segmentationDescriptor = (typeId: number, duration: number | null) => {
	const body = [
		0x43, 0x55, 0x45, 0x49, // identifier 'CUEI'
		0, 0, 0, 1, // segmentation_event_id
		0x7f, // segmentation_event_cancel_indicator=0 + reserved
		// program_segmentation=1, segmentation_duration_flag, delivery_not_restricted=1 + reserved
		0x80 | (duration === null ? 0 : 0x40) | 0x3f,
		...(duration === null
			? []
			// segmentation_duration is 40 bits at 90 kHz
			: [
					Math.floor(duration / 2 ** 32) & 0xff,
					(duration >>> 24) & 0xff, (duration >>> 16) & 0xff, (duration >>> 8) & 0xff, duration & 0xff,
				]),
		0x01, // segmentation_upid_type
		0x00, // segmentation_upid_length
		typeId,
		0x01, // segment_num
		0x01, // segments_expected
	];

	return [0x02, body.length, ...body];
};

const timeSignalWith = (spliceTime: number, descriptors: number[]) => {
	const command = [...bits33(spliceTime, 0xfe)];
	return section(0xfc, [
		0, // protocol_version
		...bits33(0, 0x00),
		0xff, // cw_index
		0, 0,
		command.length,
		0x06, // time_signal
		...command,
		(descriptors.length >> 8) & 0xff, descriptors.length & 0xff,
		...descriptors,
	]);
};

const parseOne = (sectionBytes: number[]) => {
	const sections = readScte35Sections(Uint8Array.from([
		...packetize(0x0000, pat(0x1000)),
		...packetize(0x1000, pmt(0x86, 0x0100, cueiRegistration)),
		...packetize(0x0100, sectionBytes),
	]));
	expect(sections).toHaveLength(1);
	return sections[0]!;
};

test('splice_insert states whether it leaves the network, and for how long', () => {
	// out_of_network | program_splice | duration, with a 29.994 s break
	const out = parseOne(spliceInsert(77, 0xe0 | 0x0f, 475_200, 2_699_488));
	expect(out.outOfNetwork).toBe(true);
	expect(out.breakDuration).toBeCloseTo(2_699_488 / 90_000, 6);
	expect(out.time).toBeCloseTo(475_200 / 90_000, 6);

	// The same without out_of_network, which is how the break is closed
	const back = parseOne(spliceInsert(77, 0x40 | 0x0f, 475_200));
	expect(back.outOfNetwork).toBe(false);
	expect(back.breakDuration).toBeNull();

	// An immediate splice states no time, but still says which way it goes
	const immediate = parseOne(spliceInsert(77, 0xd0 | 0x0f, 475_200));
	expect(immediate.time).toBeNull();
	expect(immediate.outOfNetwork).toBe(true);
});

// The avail set is the one MediaLive and MediaTailor document, not "every type whose name ends in
// Start": a Program, a Chapter, an Ad Block and an overlay placement opportunity all have start and end
// ids and none of them opens a linear break. An origin that disagrees reads `segmentationTypeId` and
// applies its own rule, or states the answer on `addScte35Section`.
const segmentationCases: [string, number, boolean | null][] = [
	['Provider Placement Opportunity Start', 0x34, true],
	['Provider Placement Opportunity End', 0x35, false],
	['Distributor Placement Opportunity Start', 0x36, true],
	['Break Start', 0x22, true],
	['Break End', 0x23, false],
	['Provider Advertisement Start', 0x30, true],
	['Distributor Advertisement End', 0x33, false],
	['Distributor Ad Block Start, which is not an avail', 0x46, null],
	['Provider Overlay Placement Opportunity Start, which is not an avail', 0x38, null],
	['Program Start, which opens no break', 0x10, null],
];

for (const [name, typeId, expected] of segmentationCases) {
	test(`time_signal + segmentation_descriptor: ${name}`, () => {
		const parsed = parseOne(timeSignalWith(475_200, segmentationDescriptor(typeId, 2_700_000)));

		expect(parsed.outOfNetwork).toBe(expected);
		expect(parsed.time).toBeCloseTo(475_200 / 90_000, 6);
		expect(parsed.breakDuration).toBeCloseTo(30, 6);

		// Reported whatever this library makes of it, so a caller can apply its own rule
		expect(parsed.segmentationTypeId).toBe(typeId);
	});
}

test('a time_signal with no descriptors states neither direction nor duration', () => {
	const parsed = parseOne(timeSignalWith(475_200, []));

	expect(parsed.outOfNetwork).toBeNull();
	expect(parsed.breakDuration).toBeNull();
	expect(parsed.time).toBeCloseTo(475_200 / 90_000, 6);
});

test('a segmentation_descriptor stating no duration leaves the break open-ended', () => {
	const parsed = parseOne(timeSignalWith(475_200, segmentationDescriptor(0x34, null)));

	expect(parsed.outOfNetwork).toBe(true);
	expect(parsed.breakDuration).toBeNull();
});
