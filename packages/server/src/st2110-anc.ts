/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// ST 2110-40 carries SDI ancillary data - captions, SCTE-104, AFD, timecode - over RTP using the
// payload format of IETF RFC 8331. The part that has to be got exactly right is that the ANC data
// words are **10 bits** and are not byte aligned:
//
//   ESN (16) | Length (16) | ANC_Count (8) | F (2) | reserved (22)
//   then, per ANC data packet, on a 32-bit boundary:
//     C (1) | Line_Number (11) | Horizontal_Offset (12) | S (1) | StreamNum (7)
//     DID (10) | SDID (10) | Data_Count (10) | User_Data_Words (10 each) | Checksum (10)
//     word_align: zero bits up to the next 32-bit boundary
//
// So a packet carrying one word of user data has its checksum straddling three octets. `Length`
// counts octets from the C bit of the FIRST ANC packet - not from the start of the payload - and
// includes every word_align (RFC 8331 section 3.2). Each of those is a place where an off-by-one
// produces a payload a receiver parses into plausible nonsense rather than rejecting.
//
// Each 10-bit word carries its own parity, per SMPTE ST 291-1: b8 is even parity over b0..b7 and b9
// is its inverse. The caller therefore hands over 8-bit values and this fills in the parity, because
// a caller that had to compute parity itself would get it wrong once and the error would survive
// every round trip through this module.

import { createSocket, type Socket } from 'node:dgram';
import { RTP_HEADER_SIZE, RTP_VERSION } from './rtp';

/** ESN (2) + Length (2) + ANC_Count (1) + F and reserved (3). */
const ANC_PAYLOAD_HEADER_SIZE = 8;

/**
 * Which field of an interlaced raster the RTP timestamp refers to.
 *
 * `progressive` is RFC 8331's 0b00, which also covers "no field specified". There is deliberately no
 * way to write 0b01: the RFC states it is invalid and that receivers should ignore the packet.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AncField = 'progressive' | 'first' | 'second';

const FIELD_BITS: Record<St2110AncField, number> = {
	progressive: 0b00,
	first: 0b10,
	second: 0b11,
};

/**
 * One SDI ancillary data packet, as the caller states it.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AncData = {
	/** The data identifier, 8 bits; the parity bits are filled in. */
	did: number;
	/** The secondary data identifier - or, for a type 1 packet, the data block number. 8 bits. */
	sdid: number;
	/** The user data words, 8 bits each. At most 255, which is what `Data_Count` can state. */
	data: Uint8Array;
	/**
	 * The digital interface line number this sat on. 11 bits; 0x7FF means "no line specified" and
	 * 0x7FE "the last line of the field", per RFC 8331.
	 */
	lineNumber: number;
	/** Where in the line it started. 12 bits; 0xFFF means "no offset specified". */
	horizontalOffset: number;
	/** True for the colour-difference channel, false for luma or an SD source. Defaults to false. */
	colorDifference?: boolean;
	/**
	 * The stream of a multi-stream source, 7 bits. Stating it sets RFC 8331's `S` bit, which is what
	 * says `StreamNum` carries information; leaving it out clears both. Those are different claims,
	 * so `streamNumber: 0` is *not* the same as omitting it.
	 */
	streamNumber?: number;
};

/** Even parity over the low 8 bits, then its inverse, which is what ST 291-1 asks for. */
const withParity = (value: number): number => {
	const byte = value & 0xff;
	let parity = 0;
	for (let bit = 0; bit < 8; bit++) {
		parity ^= (byte >> bit) & 1;
	}
	// b8 = even parity of b0..b7, b9 = !b8
	return byte | (parity << 8) | ((parity ? 0 : 1) << 9);
};

/**
 * The ST 291-1 checksum: the nine low bits of DID, SDID, Data_Count and every user data word summed
 * modulo 512, with b9 the inverse of b8.
 *
 * @internal
 */
export const ancChecksum = (words: number[]): number => {
	let sum = 0;
	for (const word of words) {
		sum = (sum + (word & 0x1ff)) & 0x1ff;
	}
	return sum | ((sum & 0x100) ? 0 : 0x200);
};

/** Writes 10-bit words into a buffer bit by bit, since nothing here lands on an octet boundary. */
class BitWriter {
	private at = 0;

	constructor(private readonly bytes: Uint8Array, private readonly start: number) {}

	write(value: number, bits: number) {
		for (let bit = bits - 1; bit >= 0; bit--) {
			if ((value >> bit) & 1) {
				const index = this.start + (this.at >> 3);
				this.bytes[index] = this.bytes[index]! | (0x80 >> (this.at & 7));
			}
			this.at++;
		}
	}

	/** Zero bits up to the next 32-bit boundary. RFC 8331 requires this even on the last packet. */
	alignTo32() {
		while (this.at % 32 !== 0) {
			this.at++;
		}
	}

	get octets() {
		return this.at >> 3;
	}
}

/**
 * The octets one ANC data packet occupies in the payload, word_align included.
 *
 * @internal
 */
export const ancPacketSize = (data: St2110AncData): number => {
	// 32-bit header word, then (3 + Data_Count + 1) ten-bit words, rounded up to 32 bits
	const bits = 32 + (3 + data.data.length + 1) * 10;
	return Math.ceil(bits / 32) * 4;
};

const assertAncData = (data: St2110AncData, index: number) => {
	const at = `options.packets[${index}]`;
	if (!data || typeof data !== 'object') {
		throw new TypeError(`${at} must be an object.`);
	}
	if (!Number.isInteger(data.did) || data.did < 0 || data.did > 0xff) {
		throw new TypeError(`${at}.did must be an integer in [0, 255].`);
	}
	if (!Number.isInteger(data.sdid) || data.sdid < 0 || data.sdid > 0xff) {
		throw new TypeError(`${at}.sdid must be an integer in [0, 255].`);
	}
	if (!(data.data instanceof Uint8Array)) {
		throw new TypeError(`${at}.data must be a Uint8Array.`);
	}
	if (data.data.length > 255) {
		// Data_Count states the length in 8 bits, so a longer packet cannot be signalled at all
		throw new TypeError(
			`${at}.data holds ${data.data.length} words; Data_Count can state at most 255.`,
		);
	}
	if (!Number.isInteger(data.lineNumber) || data.lineNumber < 0 || data.lineNumber > 0x7ff) {
		throw new TypeError(`${at}.lineNumber must be an integer in [0, 2047].`);
	}
	if (
		!Number.isInteger(data.horizontalOffset)
		|| data.horizontalOffset < 0
		|| data.horizontalOffset > 0xfff
	) {
		throw new TypeError(`${at}.horizontalOffset must be an integer in [0, 4095].`);
	}
	if (
		data.streamNumber !== undefined
		&& (!Number.isInteger(data.streamNumber) || data.streamNumber < 0 || data.streamNumber > 0x7f)
	) {
		throw new TypeError(`${at}.streamNumber must be an integer in [0, 127].`);
	}
};

/** Options for {@link St2110AncPacketizer}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AncPacketizerOptions = {
	/** The stream's synchronization source. */
	ssrc: number;
	/** The dynamic payload type the SDP binds, defaulting to 100. */
	payloadType?: number;
	/** The path MTU in octets, defaulting to 1500. */
	mtu?: number;
	/** Where the sequence numbers start; a random value is what RFC 3550 asks for. */
	initialSequenceNumber?: number;
};

const IP_UDP_OVERHEAD = 28;

/**
 * Packs SDI ancillary data into RFC 8331 RTP packets, which is what ST 2110-40 sends.
 *
 * One call covers one frame or field: the packets come back in order and the last carries the marker
 * bit. A frame with more ancillary data than one datagram holds is split across several RTP packets
 * with the same timestamp, which is what the RFC asks for.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110AncPacketizer {
	/** @internal */
	private readonly ssrc: number;
	/** @internal */
	private readonly payloadType: number;
	/** @internal */
	private readonly mtu: number;
	/** @internal */
	private sequence: number;

	constructor(options: St2110AncPacketizerOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Number.isInteger(options.ssrc) || options.ssrc < 0 || options.ssrc > 0xffffffff) {
			throw new TypeError('options.ssrc must be an integer in [0, 4294967295].');
		}

		const payloadType = options.payloadType ?? 100;
		if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
			throw new TypeError('options.payloadType must be an integer in [0, 127].');
		}

		const mtu = options.mtu ?? 1500;
		if (!Number.isInteger(mtu) || mtu < IP_UDP_OVERHEAD + RTP_HEADER_SIZE + ANC_PAYLOAD_HEADER_SIZE + 4) {
			throw new TypeError(
				'options.mtu must be an integer large enough for IP, UDP, the RTP header, the ANC payload'
				+ ' header and one 32-bit word.',
			);
		}

		const initial = options.initialSequenceNumber ?? 0;
		if (!Number.isInteger(initial) || initial < 0 || initial > 0xffff) {
			throw new TypeError('options.initialSequenceNumber must be an integer in [0, 65535].');
		}

		this.ssrc = options.ssrc;
		this.payloadType = payloadType;
		this.mtu = mtu;
		this.sequence = initial;
	}

	/** The sequence number the next packet will carry. */
	get nextSequenceNumber() {
		return this.sequence & 0xffff;
	}

	/**
	 * Packs one frame or field's ancillary data.
	 *
	 * Passing no ancillary data still produces one packet, with `ANC_Count` and `Length` both zero and
	 * the marker bit set. That is not a quirk: the RFC provides for it so a receiver reconstructing a
	 * raster learns that a frame carried nothing, rather than waiting for data that never comes.
	 */
	pack(options: {
		/** The ancillary data packets to carry, in the order they sat on the raster. */
		packets: St2110AncData[];
		/** The RTP timestamp, on the 90 kHz clock ST 2110-40 uses. */
		timestamp: number;
		/** Which field of an interlaced raster the timestamp refers to. Defaults to progressive. */
		field?: St2110AncField;
	}): Uint8Array[] {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Array.isArray(options.packets)) {
			throw new TypeError('options.packets must be an array.');
		}
		if (!Number.isInteger(options.timestamp) || options.timestamp < 0 || options.timestamp > 0xffffffff) {
			throw new TypeError('options.timestamp must be an integer in [0, 4294967295].');
		}

		const field = options.field ?? 'progressive';
		if (!(field in FIELD_BITS)) {
			throw new TypeError(
				`options.field must be one of ${Object.keys(FIELD_BITS).join(', ')}, got '${String(field)}'.`,
			);
		}

		options.packets.forEach(assertAncData);

		const budget = this.mtu - IP_UDP_OVERHEAD - RTP_HEADER_SIZE - ANC_PAYLOAD_HEADER_SIZE;
		for (const [index, data] of options.packets.entries()) {
			if (ancPacketSize(data) > budget) {
				throw new Error(
					`options.packets[${index}] needs ${ancPacketSize(data)} octets and the MTU leaves`
					+ ` ${budget}. Raise options.mtu or split the ancillary data.`,
				);
			}
		}

		// Group into datagrams first, so the last one can be known and carry the marker bit
		const groups: St2110AncData[][] = [];
		let current: St2110AncData[] = [];
		let used = 0;
		for (const data of options.packets) {
			const size = ancPacketSize(data);
			// 255 is what ANC_Count can state; more than that goes in another RTP packet
			if (current.length > 0 && (used + size > budget || current.length === 255)) {
				groups.push(current);
				current = [];
				used = 0;
			}
			current.push(data);
			used += size;
		}
		groups.push(current);

		return groups.map((group, index) =>
			this.writePacket(group, options.timestamp, FIELD_BITS[field], index === groups.length - 1),
		);
	}

	/** @internal */
	private writePacket(
		group: St2110AncData[],
		timestamp: number,
		fieldBits: number,
		isLast: boolean,
	): Uint8Array {
		const bodySize = group.reduce((total, data) => total + ancPacketSize(data), 0);
		const packet = new Uint8Array(RTP_HEADER_SIZE + ANC_PAYLOAD_HEADER_SIZE + bodySize);
		const view = new DataView(packet.buffer);
		const sequence = this.sequence++;

		packet[0] = RTP_VERSION << 6;
		packet[1] = (isLast ? 0x80 : 0) | this.payloadType;
		view.setUint16(2, sequence & 0xffff, false);
		view.setUint32(4, timestamp, false);
		view.setUint32(8, this.ssrc, false);

		view.setUint16(RTP_HEADER_SIZE, (sequence >>> 16) & 0xffff, false); // extended sequence number
		// Length is written last; it counts from the C bit, not from here
		packet[RTP_HEADER_SIZE + 4] = group.length;
		packet[RTP_HEADER_SIZE + 5] = fieldBits << 6;

		const bodyStart = RTP_HEADER_SIZE + ANC_PAYLOAD_HEADER_SIZE;
		let at = bodyStart;

		for (const data of group) {
			const headerWord = ((data.colorDifference ? 1 : 0) << 31)
				| ((data.lineNumber & 0x7ff) << 20)
				| ((data.horizontalOffset & 0xfff) << 8)
				| ((data.streamNumber === undefined ? 0 : 1) << 7)
				| ((data.streamNumber ?? 0) & 0x7f);
			view.setUint32(at, headerWord >>> 0, false);

			const writer = new BitWriter(packet, at + 4);
			const words = [withParity(data.did), withParity(data.sdid), withParity(data.data.length)];
			for (const byte of data.data) {
				words.push(withParity(byte));
			}
			words.push(ancChecksum(words));

			for (const word of words) {
				writer.write(word, 10);
			}
			writer.alignTo32();

			at += 4 + writer.octets;
		}

		// RFC 8331: Length begins with the C bit of the first ANC packet header, and is zero when
		// ANC_Count is zero
		view.setUint16(RTP_HEADER_SIZE + 2, group.length === 0 ? 0 : at - bodyStart, false);
		return packet;
	}
}

/** Options for {@link buildAncSdp}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AncSdpOptions = {
	/** The destination address, multicast or unicast. */
	address: string;
	/** The destination port. */
	port: number;
	/** The dynamic payload type, matching the packetizer's. Defaults to 100. */
	payloadType?: number;
	/** Multicast hop limit, written on the connection line. Defaults to 64. */
	ttl?: number;
	/** The session name. */
	sessionName?: string;
	/**
	 * The DID/SDID pairs this stream carries, which a receiver uses to decide whether it wants the
	 * stream at all. Written as ST 2110-40's `DID_SDID` parameters.
	 */
	didSdid?: {
		/** The data identifier. */
		did: number;
		/** The secondary data identifier. */
		sdid: number;
	}[];
	/** The VPID code of the raster the ancillary data belongs to, as `VPID_Code`. */
	vpidCode?: number;
	/** The PTP grandmaster this stream's clock is locked to, written as `ts-refclk`. */
	ptpGrandmaster?: string;
	/**
	 * The sender's MAC address, written as `ts-refclk:localmac=`, for a stream whose clock is its own
	 * rather than locked to PTP.
	 *
	 * ST 2110-10 §8.2 requires a reference clock to be stated either way, so a stream with neither of
	 * these says nothing about what its timestamps are against - which leaves a receiver no basis for
	 * aligning it with anything else.
	 */
	localMac?: string;
};

const isMulticastIpv4 = (address: string) => {
	const first = Number(address.split('.')[0]);
	return Number.isInteger(first) && first >= 224 && first <= 239;
};

const hex2 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Writes the SDP for an ST 2110-40 stream.
 *
 * The media type is `video`, not `application` - ancillary data belongs to a raster and ST 2110-40
 * keeps it on the video clock, so a receiver aligns it with a picture.
 *
 * @public
 * @group \@mediabunny/server
 */
export const buildAncSdp = (options: St2110AncSdpOptions): string => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (typeof options.address !== 'string' || options.address === '') {
		throw new TypeError('options.address must be a non-empty string.');
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new TypeError('options.port must be an integer in [0, 65535].');
	}

	const payloadType = options.payloadType ?? 100;
	const multicast = isMulticastIpv4(options.address);
	const fmtp: string[] = [];

	for (const pair of options.didSdid ?? []) {
		if (
			!Number.isInteger(pair.did) || pair.did < 0 || pair.did > 0xff
			|| !Number.isInteger(pair.sdid) || pair.sdid < 0 || pair.sdid > 0xff
		) {
			throw new TypeError('each options.didSdid entry must hold two integers in [0, 255].');
		}
		fmtp.push(`DID_SDID={${hex2(pair.did)},${hex2(pair.sdid)}}`);
	}
	if (options.vpidCode !== undefined) {
		if (!Number.isInteger(options.vpidCode) || options.vpidCode < 0 || options.vpidCode > 0xff) {
			throw new TypeError('options.vpidCode must be an integer in [0, 255].');
		}
		fmtp.push(`VPID_Code=${options.vpidCode}`);
	}

	const lines = [
		'v=0',
		`o=- 0 0 IN IP4 ${options.address}`,
		`s=${options.sessionName ?? 'mediabunny ST 2110-40'}`,
		't=0 0',
		`m=video ${options.port} RTP/AVP ${payloadType}`,
		multicast ? `c=IN IP4 ${options.address}/${options.ttl ?? 64}` : `c=IN IP4 ${options.address}`,
		`a=rtpmap:${payloadType} smpte291/90000`,
	];
	if (fmtp.length > 0) {
		lines.push(`a=fmtp:${payloadType} ${fmtp.join('; ')}`);
	}
	lines.push('a=mediaclk:direct=0');
	if (options.ptpGrandmaster) {
		lines.push(`a=ts-refclk:ptp=IEEE1588-2008:${options.ptpGrandmaster}`);
	} else if (options.localMac) {
		lines.push(`a=ts-refclk:localmac=${options.localMac}`);
	}

	return lines.join('\n') + '\n';
};

/** Options for {@link St2110AncSender}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AncSenderOptions = St2110AncPacketizerOptions & {
	/** The destination address. */
	address: string;
	/** The destination port. */
	port: number;
	/** Multicast hop limit. Defaults to 64. */
	ttl?: number;
};

/**
 * Sends ancillary data as ST 2110-40 over UDP.
 *
 * Unlike video, this does not pace: a frame's ancillary data is a handful of small packets, so there
 * is no burst for a receiver's buffer model to object to. Send it once per frame, on the same
 * timestamp as the picture it belongs to.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110AncSender {
	/** @internal */
	private readonly packetizer: St2110AncPacketizer;
	/** @internal */
	private readonly address: string;
	/** @internal */
	private readonly port: number;
	/** @internal */
	private socket: Socket | null = null;
	/** @internal */
	private readonly ttl: number;
	/** Datagrams written so far. */
	packetsSent = 0;

	constructor(options: St2110AncSenderOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (typeof options.address !== 'string' || options.address === '') {
			throw new TypeError('options.address must be a non-empty string.');
		}
		if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
			throw new TypeError('options.port must be an integer in [0, 65535].');
		}

		this.packetizer = new St2110AncPacketizer(options);
		this.address = options.address;
		this.port = options.port;
		this.ttl = options.ttl ?? 64;
	}

	/** Opens the socket. */
	async open() {
		if (this.socket) {
			throw new Error('The sender is already open.');
		}

		const socket = createSocket({ type: 'udp4', reuseAddr: true });
		await new Promise<void>((resolve, reject) => {
			socket.once('error', reject);
			socket.bind(() => {
				socket.off('error', reject);
				resolve();
			});
		});
		if (isMulticastIpv4(this.address)) {
			socket.setMulticastTTL(this.ttl);
		} else {
			socket.setTTL(this.ttl);
		}
		this.socket = socket;
	}

	/** Sends one frame or field's ancillary data. */
	async send(options: {
		/** The ancillary data packets to carry, in the order they sat on the raster. */
		packets: St2110AncData[];
		/** The RTP timestamp, on the 90 kHz clock ST 2110-40 uses. */
		timestamp: number;
		/** Which field of an interlaced raster the timestamp refers to. Defaults to progressive. */
		field?: St2110AncField;
	}) {
		const socket = this.socket;
		if (!socket) {
			throw new Error('The sender is not open; call open() first.');
		}

		for (const packet of this.packetizer.pack(options)) {
			await new Promise<void>((resolve, reject) => {
				socket.send(packet, this.port, this.address, error => error ? reject(error) : resolve());
			});
			this.packetsSent++;
		}
	}

	/** Closes the socket. */
	async close() {
		const socket = this.socket;
		if (!socket) {
			return;
		}
		this.socket = null;
		await new Promise<void>(resolve => socket.close(resolve));
	}
}
