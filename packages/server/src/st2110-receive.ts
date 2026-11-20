/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The inverse of the ST 2110-20 packetizer: RFC 4175 packets back into frames of packed pixels.
//
// Reassembly is driven by the RTP timestamp rather than by the marker bit. A marker says "this was the
// last packet of a frame", which is useless when that packet is the one that got lost - and on a real
// network it is lost as often as any other. A timestamp that differs from the one in progress says
// "the frame you were building is over" from the *first* packet of the next one, which still works
// when the last packet of the previous frame never arrived.
//
// What comes out is a frame plus how much of it arrived. A receiver that insists on whole frames is
// one that shows nothing on a network that drops anything, so the decision belongs to the caller.

import { assert } from '../../../src/misc';
import { RTP_HEADER_SIZE, RTP_VERSION } from './rtp';
import {
	PGROUPS,
	lineSizeOf,
	frameSizeOf,
	type St2110Depth,
	type St2110Sampling,
	type St2110VideoFormat,
} from './st2110';

const EXTENDED_SEQUENCE_SIZE = 2;
const SRD_HEADER_SIZE = 6;

/**
 * One scan-line run as a packet's Sample Row Data header describes it.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110Srd = {
	/** Octets of pixel data this run carries. */
	length: number;
	/** The scan line it belongs to, counting from zero. */
	line: number;
	/** Where it starts along that line, in pixels. */
	offsetPixels: number;
	/** For an interlaced stream, whether the line is in the second field. */
	secondField: boolean;
};

/**
 * One parsed RFC 4175 packet.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110Packet = {
	/** The RTP sequence number, with the payload header's high bits folded in. */
	sequence: number;
	/** The RTP timestamp, which is what identifies the frame. */
	timestamp: number;
	/** The synchronization source. */
	ssrc: number;
	/** Set on what the sender believed was the frame's last packet. */
	marker: boolean;
	/** The runs this packet carries, in order. */
	runs: {
		/** The header describing where this run belongs. */
		srd: St2110Srd;
		/** The run's pixel data, as it sat in the packet. */
		data: Uint8Array;
	}[];
};

/**
 * Reads one RFC 4175 packet, or null for anything that is not one.
 *
 * @public
 * @group \@mediabunny/server
 */
export const parseSt2110Packet = (bytes: Uint8Array): St2110Packet | null => {
	if (bytes.length < RTP_HEADER_SIZE + EXTENDED_SEQUENCE_SIZE || bytes[0]! >> 6 !== RTP_VERSION) {
		return null;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = RTP_HEADER_SIZE + (bytes[0]! & 0x0f) * 4;
	if (bytes[0]! & 0x10) { // extension header
		if (bytes.length < at + 4) {
			return null;
		}
		at += 4 + view.getUint16(at + 2, false) * 4;
	}
	if (at + EXTENDED_SEQUENCE_SIZE > bytes.length) {
		return null;
	}

	const extendedSequence = view.getUint16(at, false);
	at += EXTENDED_SEQUENCE_SIZE;

	// The SRD headers run until one clears its continuation bit, so the count is only knowable by
	// walking them - there is no field saying how many there are
	const srds: St2110Srd[] = [];
	let continues = true;
	while (continues) {
		if (at + SRD_HEADER_SIZE > bytes.length) {
			return null;
		}

		const length = view.getUint16(at, false);
		const lineWord = view.getUint16(at + 2, false);
		const offsetWord = view.getUint16(at + 4, false);
		continues = (offsetWord & 0x8000) !== 0;

		srds.push({
			length,
			line: lineWord & 0x7fff,
			offsetPixels: offsetWord & 0x7fff,
			secondField: (lineWord & 0x8000) !== 0,
		});
		at += SRD_HEADER_SIZE;

		if (srds.length > 64) {
			return null; // not a packet anyone writes; refuse rather than walk off the end
		}
	}

	const runs: { srd: St2110Srd; data: Uint8Array }[] = [];
	for (const srd of srds) {
		if (at + srd.length > bytes.length) {
			return null; // a header claiming more than arrived
		}
		runs.push({ srd, data: bytes.subarray(at, at + srd.length) });
		at += srd.length;
	}

	return {
		sequence: (extendedSequence << 16 | view.getUint16(2, false)) >>> 0,
		timestamp: view.getUint32(4, false),
		ssrc: view.getUint32(8, false),
		marker: (bytes[1]! & 0x80) !== 0,
		runs,
	};
};

/**
 * A frame as it was reassembled, and how much of it arrived.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110Frame = {
	/** The RTP timestamp every packet of this frame carried. */
	timestamp: number;
	/** Packed pixels, in the layout `frameSizeOf` describes. Octets that never arrived are zero. */
	data: Uint8Array;
	/** Octets written, out of the frame's whole size. */
	octetsReceived: number;
	/** True when every octet of the frame arrived. */
	complete: boolean;
	/** Whether the sender's marker bit was seen, which a frame missing its last packet never has. */
	markerSeen: boolean;
};

/**
 * Reassembles RFC 4175 packets into frames of packed pixels.
 *
 * Feed it packets as they arrive; it returns a frame whenever one ends. A frame ends when a packet
 * arrives bearing a different timestamp, not when the marker bit is seen - a marker is on exactly the
 * packet whose loss a receiver most needs to survive. `flush` ends the one in progress.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110Depacketizer {
	/** The video being received. */
	readonly format: St2110VideoFormat;
	/** @internal */
	private readonly lineSize: number;
	/** @internal */
	private readonly frameSize: number;
	/** @internal */
	private readonly pgroup: { octets: number; pixels: number };
	/** @internal */
	private current: { timestamp: number; data: Uint8Array; received: number; marker: boolean } | null = null;
	/** Datagrams handed over that were not RFC 4175 packets at all. */
	rejectedDatagrams = 0;

	constructor(options: {
		/** The video being received, as the SDP described it. */
		format: St2110VideoFormat;
	}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}

		const format = options.format;
		if (!format || typeof format !== 'object') {
			throw new TypeError('options.format must be an object.');
		}
		if (!(format.sampling in PGROUPS)) {
			throw new TypeError(
				`options.format.sampling must be one of ${Object.keys(PGROUPS).join(', ')},`
				+ ` got '${String(format.sampling)}'.`,
			);
		}
		if (!(format.depth in PGROUPS[format.sampling])) {
			throw new TypeError(`options.format.depth must be 8, 10, 12 or 16, got ${String(format.depth)}.`);
		}
		if (!Number.isInteger(format.width) || format.width <= 0) {
			throw new TypeError('options.format.width must be a positive integer.');
		}
		if (!Number.isInteger(format.height) || format.height <= 0) {
			throw new TypeError('options.format.height must be a positive integer.');
		}

		this.format = format;
		this.lineSize = lineSizeOf(format);
		this.frameSize = frameSizeOf(format);
		this.pgroup = PGROUPS[format.sampling][format.depth];
	}

	/** The frame in progress, or null between frames. */
	get pending(): {
		/** The RTP timestamp the frame in progress carries. */
		timestamp: number;
		/** Octets of it written so far. */
		octetsReceived: number;
	} | null {
		return this.current ? { timestamp: this.current.timestamp, octetsReceived: this.current.received } : null;
	}

	/**
	 * Takes one packet, returning the previous frame if this packet started a new one.
	 *
	 * A packet that is not RFC 4175, or whose runs fall outside the format, is ignored rather than
	 * thrown on: a receiver that dies on a malformed datagram is a receiver anyone can stop.
	 */
	receive(bytes: Uint8Array): St2110Frame | null {
		const packet = parseSt2110Packet(bytes);
		if (!packet) {
			this.rejectedDatagrams++;
			return null;
		}

		let finished: St2110Frame | null = null;
		if (this.current && this.current.timestamp !== packet.timestamp) {
			finished = this.take();
		}

		this.current ??= {
			timestamp: packet.timestamp,
			data: new Uint8Array(this.frameSize),
			received: 0,
			marker: false,
		};
		const current = this.current;
		current.marker ||= packet.marker;

		for (const run of packet.runs) {
			// An interlaced stream carries one field per timestamp, so the second field's lines are
			// indexed within that field rather than within the whole raster
			const offset = run.srd.line * this.lineSize
				+ Math.floor(run.srd.offsetPixels / this.pgroup.pixels) * this.pgroup.octets;

			if (offset < 0 || offset + run.data.length > this.frameSize) {
				continue; // a run that does not fit the format it was told to expect
			}

			current.data.set(run.data, offset);
			current.received += run.data.length;
		}

		return finished;
	}

	/** Ends the frame in progress, returning it. */
	flush(): St2110Frame | null {
		return this.current ? this.take() : null;
	}

	/** @internal */
	private take(): St2110Frame {
		const current = this.current;
		assert(current !== null);
		this.current = null;

		return {
			timestamp: current.timestamp,
			data: current.data,
			octetsReceived: current.received,
			// Counted rather than inferred from the marker: a frame can carry its marker and still be
			// missing packets from the middle, and one can be whole with its marker lost
			complete: current.received >= this.frameSize,
			markerSeen: current.marker,
		};
	}
}

// Packed pgroups are not an array of samples. A pgroup is the smallest run of pixels that lands on an
// octet boundary, and for every depth except 8 and 16 the samples inside it straddle octets: 4:2:2 at
// ten bits puts two pixels - Cb Y Cr Y, four samples - into five octets, so the second sample starts
// at bit 10 and the third at bit 20. Reading those with a byte offset gives a picture that looks
// almost right, which is the worst way for it to be wrong.
//
// These two convert between that packing and plain samples, in the component order the sampling
// states. Interleaved, not planar: that is the order they sit in on the wire, and separating planes is
// a different job that depends on what the caller is feeding.

/** How many samples one pgroup carries, for each sampling. */
const SAMPLES_PER_PGROUP: Record<St2110Sampling, (pixels: number) => number> = {
	// Cb Y Cr Y: four samples for two pixels
	'YCbCr-4:2:2': pixels => pixels * 2,
	// Y Cb Cr per pixel
	'YCbCr-4:4:4': pixels => pixels * 3,
	// R G B per pixel
	'RGB': pixels => pixels * 3,
	// Two lines' worth: four Y, one Cb, one Cr for every four pixels
	'YCbCr-4:2:0': pixels => pixels + pixels / 2,
};

/**
 * How many samples a run of packed pgroups carries.
 *
 * @public
 * @group \@mediabunny/server
 */
export const samplesInPgroups = (
	sampling: St2110Sampling,
	depth: St2110Depth,
	pgroupCount: number,
): number => {
	const pgroup = PGROUPS[sampling][depth];
	return SAMPLES_PER_PGROUP[sampling](pgroup.pixels) * pgroupCount;
};

/**
 * Unpacks packed pgroups into samples, in the order they sit on the wire.
 *
 * Each sample comes back right-aligned in its own element, so a 10-bit sample is a number in
 * `[0, 1023]` rather than a shifted one.
 *
 * @public
 * @group \@mediabunny/server
 */
export const unpackPgroups = (
	data: Uint8Array,
	sampling: St2110Sampling,
	depth: St2110Depth,
): Uint16Array => {
	assertSampling(sampling, depth);
	const pgroup = PGROUPS[sampling][depth];
	const pgroupCount = Math.floor(data.length / pgroup.octets);
	const perGroup = SAMPLES_PER_PGROUP[sampling](pgroup.pixels);
	const out = new Uint16Array(perGroup * pgroupCount);

	// A bit at a time costs depth iterations per sample - 41 million of them for one 1080p 4:2:2
	// 10-bit frame, which measured at 66 ms against a 40 ms frame interval at 25 fps. An accumulator
	// does the same work in a few operations per sample, and it does it for every sampling and depth
	// rather than needing a hand-written case each.
	//
	// `acc` holds the bits read but not yet consumed, right-aligned. At most 7 are left over, so with
	// a depth of at most 16 it never exceeds 23 bits and stays inside a 32-bit integer.
	let index = 0;
	let at = 0;

	// The same group sizes as `packPgroups`, for the same reason
	if (depth === 8) {
		for (; index < out.length; index++) {
			out[index] = data[at++]!;
		}
	} else if (depth === 10) {
		const groups = out.length - 3;
		for (; index < groups; index += 4) {
			const a = data[at]!;
			const b = data[at + 1]!;
			const c = data[at + 2]!;
			const d = data[at + 3]!;
			const e = data[at + 4]!;
			at += 5;
			out[index] = (a << 2) | (b >> 6);
			out[index + 1] = ((b & 0x3f) << 4) | (c >> 4);
			out[index + 2] = ((c & 0xf) << 6) | (d >> 2);
			out[index + 3] = ((d & 0x3) << 8) | e;
		}
	} else if (depth === 12) {
		const groups = out.length - 1;
		for (; index < groups; index += 2) {
			const a = data[at]!;
			const b = data[at + 1]!;
			const c = data[at + 2]!;
			at += 3;
			out[index] = (a << 4) | (b >> 4);
			out[index + 1] = ((b & 0xf) << 8) | c;
		}
	} else if (depth === 16) {
		for (; index < out.length; index++) {
			out[index] = (data[at]! << 8) | data[at + 1]!;
			at += 2;
		}
	}

	// The tail; see the note in `packPgroups` for why it does not run for any entry of today's table
	let acc = 0;
	let accBits = 0;
	const mask = (1 << depth) - 1;

	for (; index < out.length; index++) {
		while (accBits < depth) {
			acc = (acc << 8) | (data[at++] ?? 0);
			accBits += 8;
		}

		accBits -= depth;
		out[index] = (acc >>> accBits) & mask;
	}

	return out;
};

/**
 * Packs samples back into pgroups, the inverse of {@link unpackPgroups}.
 *
 * @public
 * @group \@mediabunny/server
 */
export const packPgroups = (
	samples: Uint16Array | number[],
	sampling: St2110Sampling,
	depth: St2110Depth,
): Uint8Array => {
	assertSampling(sampling, depth);
	const pgroup = PGROUPS[sampling][depth];
	const perGroup = SAMPLES_PER_PGROUP[sampling](pgroup.pixels);

	if (samples.length % perGroup !== 0) {
		// A partial pgroup cannot be written: it would leave the next sample starting mid-octet, and
		// every sample after it shifted
		throw new TypeError(
			`${samples.length} samples is not a whole number of ${sampling} pgroups, which hold`
			+ ` ${perGroup} samples each.`,
		);
	}

	const out = new Uint8Array((samples.length / perGroup) * pgroup.octets);
	const max = (1 << depth) - 1;

	validateSamples(samples, max, depth);

	// Whole groups first, against a bound computed once: writing `index + 4 <= samples.length` in the
	// condition instead cost more than twice the whole loop body on a 1080p frame. The bit layout is
	// one contiguous stream of `depth`-bit samples whatever the sampling is - the sampling decides how
	// many samples a pgroup holds, not how they are laid out - so one group size per depth covers
	// every entry of the table.
	let index = 0;
	let at = 0;

	if (depth === 8) {
		for (; index < samples.length; index++) {
			out[at++] = samples[index]!;
		}
	} else if (depth === 10) {
		// Four samples in five octets
		const groups = samples.length - 3;
		for (; index < groups; index += 4) {
			const a = samples[index]!;
			const b = samples[index + 1]!;
			const c = samples[index + 2]!;
			const d = samples[index + 3]!;
			out[at++] = a >> 2;
			out[at++] = ((a & 0x3) << 6) | (b >> 4);
			out[at++] = ((b & 0xf) << 4) | (c >> 6);
			out[at++] = ((c & 0x3f) << 2) | (d >> 8);
			out[at++] = d & 0xff;
		}
	} else if (depth === 12) {
		// Two samples in three octets
		const groups = samples.length - 1;
		for (; index < groups; index += 2) {
			const a = samples[index]!;
			const b = samples[index + 1]!;
			out[at++] = a >> 4;
			out[at++] = ((a & 0xf) << 4) | (b >> 8);
			out[at++] = b & 0xff;
		}
	} else if (depth === 16) {
		for (; index < samples.length; index++) {
			const a = samples[index]!;
			out[at++] = a >> 8;
			out[at++] = a & 0xff;
		}
	}

	// The tail, and any depth without a group path of its own. With today's table the tail never runs:
	// a pgroup IS the smallest run of samples that ends on an octet boundary, so a 10-bit pgroup holds
	// a multiple of four samples and a 12-bit one a multiple of two, and the callers above reject a
	// partial pgroup. It is here for a depth that gets no group path, not as live code - which is why
	// shortening the bounds above to `samples.length` passes every test.
	let acc = 0;
	let accBits = 0;
	for (; index < samples.length; index++) {
		acc = (acc << depth) | samples[index]!;
		accBits += depth;

		while (accBits >= 8) {
			accBits -= 8;
			out[at++] = (acc >>> accBits) & 0xff;
		}
	}

	return out;
};

/**
 * Checks every sample fits the depth, in one pass that branches once rather than per sample.
 *
 * A typed array has already made each value an integer in range for its own width, so only the depth
 * bound is left there. OR-ing the values tests them all at once; the slow walk to name the offending
 * one happens only when that test fails, which is never on a valid frame.
 */
const validateSamples = (samples: Uint16Array | number[], max: number, depth: number) => {
	if (samples instanceof Uint16Array) {
		let combined = 0;
		for (let index = 0; index < samples.length; index++) {
			combined |= samples[index]!;
		}

		if (combined <= max) {
			return;
		}
	}

	for (let index = 0; index < samples.length; index++) {
		const value = samples[index]!;
		if (!Number.isInteger(value) || value < 0 || value > max) {
			throw new TypeError(`sample ${index} is ${value}, outside [0, ${max}] for ${depth}-bit.`);
		}
	}
};

const assertSampling = (sampling: St2110Sampling, depth: St2110Depth) => {
	if (!(sampling in PGROUPS)) {
		throw new TypeError(
			`sampling must be one of ${Object.keys(PGROUPS).join(', ')}, got '${String(sampling)}'.`,
		);
	}
	if (!(depth in PGROUPS[sampling])) {
		throw new TypeError(`depth must be 8, 10, 12 or 16, got ${String(depth)}.`);
	}
};

/**
 * Reads an ST 2110-20 SDP into the format its stream carries.
 *
 * The SDP is not decoration for a -20 stream: the payload states nothing about size, sampling or
 * depth, so a receiver that does not read it has no way to interpret a single octet. Every parameter
 * required by ST 2110-20 §7.2 must be present; a missing one is refused rather than defaulted,
 * because a default here is a silently wrong picture.
 *
 * @public
 * @group \@mediabunny/server
 */
export const parseSt2110Sdp = (sdp: string): St2110VideoFormat => {
	if (typeof sdp !== 'string' || sdp === '') {
		throw new TypeError('sdp must be a non-empty string.');
	}

	const fmtpLine = sdp.split(/\r?\n/).find(line => line.startsWith('a=fmtp:'));
	if (!fmtpLine) {
		throw new Error('This SDP carries no a=fmtp line, so it describes no raster.');
	}

	const parameters = new Map<string, string>();
	for (const entry of fmtpLine.slice(fmtpLine.indexOf(' ') + 1).split(';')) {
		const trimmed = entry.trim();
		if (trimmed === '') {
			continue;
		}
		const equals = trimmed.indexOf('=');
		// `interlace` is a parameter with no value, which is how an interlaced stream says so
		parameters.set(
			equals === -1 ? trimmed : trimmed.slice(0, equals),
			equals === -1 ? '' : trimmed.slice(equals + 1).replace(/^"|"$/g, ''),
		);
	}

	const required = (name: string) => {
		const value = parameters.get(name);
		if (value === undefined || value === '') {
			throw new Error(`This SDP states no ${name}, which ST 2110-20 requires.`);
		}
		return value;
	};

	const sampling = required('sampling');
	if (!(sampling in PGROUPS)) {
		throw new Error(
			`This SDP states sampling=${sampling}, which is not one of ${Object.keys(PGROUPS).join(', ')}.`,
		);
	}

	const depth = Number(required('depth'));
	if (!(depth in PGROUPS[sampling as St2110Sampling])) {
		throw new Error(`This SDP states depth=${depth}, which is not 8, 10, 12 or 16.`);
	}

	const width = Number(required('width'));
	const height = Number(required('height'));
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new Error(`This SDP states width=${width} height=${height}, which is not a raster.`);
	}

	// Whole rates are written as a plain integer and fractional ones as N/D, so both have to be read
	const rate = required('exactframerate');
	const [numerator, denominator] = rate.includes('/')
		? rate.split('/').map(Number)
		: [Number(rate), 1];
	if (
		!Number.isInteger(numerator) || !Number.isInteger(denominator)
		|| numerator! <= 0 || denominator! <= 0
	) {
		throw new Error(`This SDP states exactframerate=${rate}, which is not a frame rate.`);
	}

	return {
		sampling: sampling as St2110Sampling,
		depth: depth as St2110Depth,
		width,
		height,
		exactFrameRate: { numerator: numerator!, denominator: denominator! },
		interlaced: parameters.has('interlace'),
	};
};

/**
 * Reads an ST 2110-20 stream from datagrams, yielding frames.
 *
 * Give it the SDP the sender published and a stream of datagrams - whatever the host's socket hands
 * over, one element per packet. It yields a frame whenever one ends, including incomplete ones:
 * `complete` says whether every octet arrived, and a receiver that discards anything short is a
 * receiver that shows nothing on a network that drops a single packet.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110Source {
	/** The video being received, as the SDP described it. */
	readonly format: St2110VideoFormat;
	/** @internal */
	private readonly depacketizer: St2110Depacketizer;
	/** @internal */
	private readonly datagrams: ReadableStream<Uint8Array>;

	/** Datagrams that were not RFC 4175 packets at all. */
	get rejectedDatagrams() {
		return this.depacketizer.rejectedDatagrams;
	}

	constructor(options: {
		/** The datagrams, one element per packet. */
		datagrams: ReadableStream<Uint8Array>;
		/** The sender's SDP, or the format if it is already known. */
		sdp?: string;
		/** The format, where the SDP is not to hand. */
		format?: St2110VideoFormat;
	}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!(options.datagrams instanceof ReadableStream)) {
			throw new TypeError('options.datagrams must be a ReadableStream.');
		}
		if ((options.sdp === undefined) === (options.format === undefined)) {
			throw new TypeError('Stating exactly one of options.sdp or options.format is required.');
		}

		this.format = options.sdp !== undefined ? parseSt2110Sdp(options.sdp) : options.format!;
		this.depacketizer = new St2110Depacketizer({ format: this.format });
		this.datagrams = options.datagrams;
	}

	/** Every frame the stream carries, in order, until the datagrams end. */
	async* frames(): AsyncGenerator<St2110Frame, void, unknown> {
		const reader = this.datagrams.getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				const frame = this.depacketizer.receive(value);
				if (frame) {
					yield frame;
				}
			}

			// The last frame has no successor to end it, so the end of the datagrams is what does
			const last = this.depacketizer.flush();
			if (last) {
				yield last;
			}
		} finally {
			reader.releaseLock();
		}
	}
}
