import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { findBox, parseBoxes } from '../../src/crypto/box-tree.js';
import { buildEmsgBox, insertBoxesBeforeMoof } from '../../src/emsg.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';

const FILE = path.join(
	new URL('.', import.meta.url).pathname,
	'../../../shaka-packager/packager/media/test/data/bear-640x360-av_frag.mp4',
);

const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const box = (type: string, payload: number[]) => [
	...u32(8 + payload.length),
	...[...type].map(char => char.charCodeAt(0)),
	...payload,
];

const FIRST_OFFSET = 0;
const REFERENCE = [...u32(0x00000100), ...u32(90_000), ...u32(0x90000000)];

// styp + sidx + moof + mdat, the shape a packaged DASH segment arrives in.
const segment = () => Uint8Array.from([
	...box('styp', [...[...'msdh'].map(c => c.charCodeAt(0)), ...u32(0)]),
	...box('sidx', [
		0, 0, 0, 0, // version 0 + flags
		...u32(1), // reference_ID
		...u32(90_000), // timescale
		...u32(0), // earliest_presentation_time
		...u32(FIRST_OFFSET),
		0, 0, 0, 1, // reserved + reference_count
		...REFERENCE,
	]),
	...box('moof', box('mfhd', [0, 0, 0, 0, ...u32(1)])),
	...box('mdat', [1, 2, 3, 4]),
]);

const emsg = () => buildEmsgBox({
	schemeIdUri: 'urn:scte:scte35:2013:bin',
	timescale: 90_000,
	presentationTime: 180_000,
	eventDuration: 0xffffffff,
	id: 42,
	messageData: Uint8Array.from([0xfc, 0x30, 0x11]),
});

const typesOf = (bytes: Uint8Array) => parseBoxes(bytes, 0, bytes.length).map(b => b.type);
const firstOffsetOf = (bytes: Uint8Array) => {
	const sidx = findBox(parseBoxes(bytes, 0, bytes.length), 'sidx')!.data!;
	return new DataView(sidx.buffer, sidx.byteOffset, sidx.byteLength).getUint32(16);
};

describe('insertBoxesBeforeMoof', () => {
	test('places the boxes between the sidx and the moof', () => {
		const out = insertBoxesBeforeMoof(segment(), [emsg()]);
		expect(typesOf(out)).toEqual(['styp', 'sidx', 'emsg', 'moof', 'mdat']);
	});

	test('restates the sidx first_offset by the inserted size', () => {
		const added = emsg();
		const out = insertBoxesBeforeMoof(segment(), [added]);

		expect(firstOffsetOf(segment())).toBe(FIRST_OFFSET);
		expect(firstOffsetOf(out)).toBe(FIRST_OFFSET + added.length);
		expect(out.length).toBe(segment().length + added.length);
	});

	test('leaves the referenced fragment sizes alone', () => {
		const out = insertBoxesBeforeMoof(segment(), [emsg()]);
		const sidx = findBox(parseBoxes(out, 0, out.length), 'sidx')!.data!;
		expect([...sidx.subarray(24)]).toEqual(REFERENCE);
	});

	test('inserting nothing returns the segment unchanged', () => {
		const input = segment();
		expect(insertBoxesBeforeMoof(input, [])).toBe(input);
	});

	test('a segment with no moof is refused', () => {
		const initOnly = Uint8Array.from(box('ftyp', [...[...'isom'].map(c => c.charCodeAt(0))]));
		expect(() => insertBoxesBeforeMoof(initOnly, [emsg()])).toThrow(/no moof/);
	});

	test('an entry that is not exactly one box is refused', () => {
		const two = Uint8Array.from([...emsg(), ...emsg()]);
		expect(() => insertBoxesBeforeMoof(segment(), [two])).toThrow(/exactly one complete top-level box/);
	});

	test('a real fragmented file still demuxes with an emsg inserted', async () => {
		const withEvent = insertBoxesBeforeMoof(new Uint8Array(readFileSync(FILE)), [emsg()]);
		expect(typesOf(withEvent)).toContain('emsg');

		using input = new Input({ source: new BufferSource(withEvent), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.computeDuration()).toBeGreaterThan(0);
	});
});

describe('buildEmsgBox', () => {
	test('writes a version 1 box for an absolute presentation time', () => {
		const bytes = emsg();
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('emsg');
		expect(view.getUint32(0)).toBe(bytes.length);
		expect(bytes[8]).toBe(1);
		expect(view.getUint32(12)).toBe(90_000); // timescale
		expect(Number(view.getBigUint64(16))).toBe(180_000); // presentation_time
		expect(view.getUint32(24)).toBe(0xffffffff); // event_duration
		expect(view.getUint32(28)).toBe(42); // id
		expect(new TextDecoder().decode(bytes.subarray(32, 32 + 24))).toBe('urn:scte:scte35:2013:bin');
		expect([...bytes.subarray(-3)]).toEqual([0xfc, 0x30, 0x11]);
	});

	test('writes a version 0 box for a delta, with the strings first', () => {
		const bytes = buildEmsgBox({
			schemeIdUri: 'urn:test',
			value: 'v1',
			timescale: 1000,
			presentationTimeDelta: 250,
			eventDuration: 500,
			id: 7,
		});
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		expect(bytes[8]).toBe(0);
		expect(new TextDecoder().decode(bytes.subarray(12, 20))).toBe('urn:test');
		expect(bytes[20]).toBe(0); // scheme_id_uri terminator
		expect(new TextDecoder().decode(bytes.subarray(21, 23))).toBe('v1');
		expect(view.getUint32(24)).toBe(1000); // timescale
		expect(view.getUint32(28)).toBe(250); // presentation_time_delta
		expect(view.getUint32(32)).toBe(500); // event_duration
		expect(view.getUint32(36)).toBe(7); // id
	});

	test('rejects stating both or neither time', () => {
		const base = { schemeIdUri: 'urn:test', timescale: 1000, eventDuration: 0, id: 1 };
		expect(() => buildEmsgBox(base)).toThrow(TypeError);
		expect(() => buildEmsgBox({ ...base, presentationTime: 1, presentationTimeDelta: 1 })).toThrow(TypeError);
	});
});
