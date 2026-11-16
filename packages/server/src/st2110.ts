/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SMPTE ST 2110-20 carries uncompressed video over RTP, and its packetization is RFC 4175's: after the
// RTP header comes a payload header of a 16-bit extended sequence number followed by one or more
// 6-octet Sample Row Data headers, each naming a run of one scan line - its length, its line number
// with a field bit, and its pixel offset with a continuation bit. The last SRD header clears that
// continuation bit, and parsing the headers is the only way to learn how many runs a packet carries.
//
// Everything is counted in pixel groups rather than pixels. A pgroup is the smallest run of pixels
// that lands on an octet boundary - for the 4:2:2 10-bit that ST 2110 is usually run at, two pixels in
// five octets - and every length in the format must be a whole number of them (RFC 4175 4.3). A line
// whose width is not a whole number of pgroups is filled to one, and the receiver drops the fill.

import { createSocket, type Socket } from 'node:dgram';
import { assert } from '../../../src/misc';
import { RTP_HEADER_SIZE, RTP_VERSION } from './rtp';

/**
 * The samplings ST 2110-20 defines, named as the SDP `sampling` parameter writes them.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110Sampling = 'YCbCr-4:2:2' | 'YCbCr-4:4:4' | 'YCbCr-4:2:0' | 'RGB';

/**
 * Bits per sample, as the SDP `depth` parameter writes it.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110Depth = 8 | 10 | 12 | 16;

/**
 * The video this stream carries, which is what the SDP states and what the packetization is sized by.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110VideoFormat = {
	/**
 * Picture width in pixels. */
	width: number;
	/** Picture height in pixels, whole frame even where the stream is interlaced. */
	height: number;
	/** Chroma sampling, which with the depth fixes the pixel group. */
	sampling: St2110Sampling;
	/** Bits per sample. */
	depth: St2110Depth;
	/** Frame rate as an exact ratio, since 30000/1001 is not 29.97 and the SDP states the ratio. */
	exactFrameRate: {
		/** Frames, so 30000 for 29.97. */
		numerator: number;
		/** Seconds, so 1001 for 29.97. */
		denominator: number;
	};
	/** Interlaced streams carry one field per timestamp and set the SRD field bit on the second. */
	interlaced?: boolean;
};

/**
 * The pixel group for a sampling and depth: how many octets carry how many pixels. RFC 4175 4.3 states
 * these per format rather than deriving them, and so does this - the packings are irregular enough that
 * a formula would be a guess (4:2:2 at 10 bits is 5 octets for 2 pixels, while 4:4:4 at 10 bits is 15
 * for 4).
 *
 * @public
 * @group \@mediabunny/server
 */
export const PGROUPS: Record<St2110Sampling, Record<St2110Depth, {
	/** Octets the group occupies. */
	octets: number;
	/** Pixels it carries. */
	pixels: number;
}>> = {
	'YCbCr-4:2:2': {
		8: { octets: 4, pixels: 2 },
		10: { octets: 5, pixels: 2 },
		12: { octets: 6, pixels: 2 },
		16: { octets: 8, pixels: 2 },
	},
	'YCbCr-4:4:4': {
		8: { octets: 3, pixels: 1 },
		10: { octets: 15, pixels: 4 },
		12: { octets: 9, pixels: 2 },
		16: { octets: 6, pixels: 1 },
	},
	'YCbCr-4:2:0': {
		8: { octets: 6, pixels: 4 },
		10: { octets: 15, pixels: 8 },
		12: { octets: 9, pixels: 4 },
		16: { octets: 12, pixels: 4 },
	},
	'RGB': {
		8: { octets: 3, pixels: 1 },
		10: { octets: 15, pixels: 4 },
		12: { octets: 9, pixels: 2 },
		16: { octets: 6, pixels: 1 },
	},
};

const EXTENDED_SEQUENCE_SIZE = 2;
const SRD_HEADER_SIZE = 6;

/**
 * How many SRD headers one packet may carry. Three is what ST 2110-20 senders write in practice, and
 * each one costs six octets of payload, so there is nothing to gain from more.
 */
const MAX_SRDS_PER_PACKET = 3;

/** IPv4 and UDP, which come off the MTU before anything here gets to use it. */
const IP_UDP_OVERHEAD = 28;

const DEFAULT_MTU = 1500;
const DEFAULT_PAYLOAD_TYPE = 96;

/** Octets one scan line occupies, which is the line filled up to a whole number of pgroups.
 *
 * @public
 * @group \@mediabunny/server
 */
export const lineSizeOf = (format: St2110VideoFormat) => {
	const pgroup = PGROUPS[format.sampling][format.depth];
	return Math.ceil(format.width / pgroup.pixels) * pgroup.octets;
};

/**
 * Octets one whole frame of packed pixels occupies.
 *
 * @public
 * @group \@mediabunny/server
 */
export const frameSizeOf = (format: St2110VideoFormat) =>
	lineSizeOf(format) * (format.interlaced ? format.height / 2 : format.height);

/**
 * Options for {@link St2110Packetizer}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110PacketizerOptions = {
	/**
 * The video being carried. */
	format: St2110VideoFormat;
	/** The stream's synchronization source, which a receiver uses to tell senders apart. */
	ssrc: number;
	/** The dynamic payload type the SDP binds, defaulting to 96. */
	payloadType?: number;
	/**
	 * The path MTU in octets, defaulting to 1500. IP and UDP come off it before the RTP header and the
	 * payload headers do, and what is left is filled with whole pgroups.
	 */
	mtu?: number;
	/** Where the sequence numbers start; a random value is what RFC 3550 asks for. */
	initialSequenceNumber?: number;
};

/**
 * Cuts a frame of packed pixels into RFC 4175 RTP packets, which is what ST 2110-20 sends.
 *
 * The packets come back in order, the last of a frame carrying the marker bit. What this does not do
 * is decide *when* they leave: ST 2110-21 governs that, and a sender that writes them as fast as it
 * can produces a burst no receiver's buffer model allows.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110Packetizer {
	/** The video being carried. */
	readonly format: St2110VideoFormat;
	/** Octets one scan line occupies, filled to a whole number of pgroups. */
	readonly lineSize: number;
	/** Octets one frame - or one field - of packed pixels occupies. */
	readonly frameSize: number;
	/** @internal */
	private readonly pgroup: { octets: number; pixels: number };
	/** @internal */
	private readonly ssrc: number;
	/** @internal */
	private readonly payloadType: number;
	/** @internal */
	private readonly mtu: number;
	/** @internal */
	private sequence: number;

	constructor(options: St2110PacketizerOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}

		const format = options.format;
		if (!format || typeof format !== 'object') {
			throw new TypeError('options.format must be an object.');
		}
		if (!Number.isInteger(format.width) || format.width <= 0) {
			throw new TypeError('options.format.width must be a positive integer.');
		}
		if (!Number.isInteger(format.height) || format.height <= 0) {
			throw new TypeError('options.format.height must be a positive integer.');
		}
		if (!(format.sampling in PGROUPS)) {
			throw new TypeError(
				`options.format.sampling must be one of ${Object.keys(PGROUPS).join(', ')},`
				+ ` got '${String(format.sampling)}'.`,
			);
		}
		if (!(format.depth in PGROUPS[format.sampling])) {
			throw new TypeError(
				`options.format.depth must be 8, 10, 12 or 16, got ${String(format.depth)}.`,
			);
		}
		if (format.interlaced && format.height % 2 !== 0) {
			throw new TypeError(
				`An interlaced stream carries one field per timestamp, so its height must be even;`
				+ ` got ${format.height}.`,
			);
		}
		if (
			!format.exactFrameRate
			|| !Number.isInteger(format.exactFrameRate.numerator)
			|| !Number.isInteger(format.exactFrameRate.denominator)
			|| format.exactFrameRate.numerator <= 0
			|| format.exactFrameRate.denominator <= 0
		) {
			throw new TypeError(
				'options.format.exactFrameRate must be a ratio of positive integers - 30000/1001 rather'
				+ ' than 29.97, which the SDP states exactly.',
			);
		}
		if (!Number.isInteger(options.ssrc) || options.ssrc < 0 || options.ssrc > 0xffffffff) {
			throw new TypeError('options.ssrc must be an integer between 0 and 4294967295.');
		}

		const payloadType = options.payloadType ?? DEFAULT_PAYLOAD_TYPE;
		if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
			throw new TypeError('options.payloadType must be an integer between 0 and 127.');
		}

		const mtu = options.mtu ?? DEFAULT_MTU;
		if (!Number.isInteger(mtu) || mtu < IP_UDP_OVERHEAD + RTP_HEADER_SIZE + EXTENDED_SEQUENCE_SIZE
			+ SRD_HEADER_SIZE + PGROUPS[format.sampling][format.depth].octets) {
			throw new TypeError(
				`options.mtu of ${mtu} leaves no room for a pgroup once IP, UDP, the RTP header and one SRD`
				+ ' header are taken off it.',
			);
		}

		this.format = format;
		this.pgroup = PGROUPS[format.sampling][format.depth];
		this.lineSize = lineSizeOf(format);
		this.frameSize = frameSizeOf(format);
		this.ssrc = options.ssrc;
		this.payloadType = payloadType;
		this.mtu = mtu;
		this.sequence = (options.initialSequenceNumber ?? Math.floor(Math.random() * 0x10000)) & 0xffffffff;
	}

	/** The 32-bit sequence number the next packet will carry, low 16 bits in the RTP header. */
	get nextSequenceNumber() {
		return this.sequence >>> 0;
	}

	/**
	 * Cuts one frame - or one field of an interlaced frame - into packets.
	 *
	 * `packed` is the pixel data already in the stream's own packing, line by line, each line filled to
	 * a whole number of pgroups. `rtpTimestamp` is the 90 kHz sampling instant of the frame, and every
	 * packet of it carries that same value (RFC 4175 4.1).
	 */
	packetize(packed: Uint8Array, rtpTimestamp: number, fieldIsSecond = false): Uint8Array[] {
		if (packed.byteLength !== this.frameSize) {
			throw new TypeError(
				`packed is ${packed.byteLength} octets where this format's frame is ${this.frameSize}`
				+ ` (${this.lineSize} per line). A line is filled to a whole number of ${this.pgroup.octets}`
				+ '-octet pgroups.',
			);
		}

		const lines = this.format.interlaced ? this.format.height / 2 : this.format.height;
		const packets: Uint8Array[] = [];

		// Where the next octet to send sits, as a line and an offset into it
		let line = 0;
		let offsetInLine = 0;

		while (line < lines) {
			const runs: { line: number; offsetPixels: number; length: number; from: number }[] = [];
			let budget = this.mtu - IP_UDP_OVERHEAD - RTP_HEADER_SIZE - EXTENDED_SEQUENCE_SIZE;

			while (runs.length < MAX_SRDS_PER_PACKET && line < lines) {
				// Every run costs its own header, so the budget has to cover that before any pixels
				const available = budget - SRD_HEADER_SIZE * (runs.length + 1);
				const whole = Math.floor(available / this.pgroup.octets) * this.pgroup.octets;
				if (whole <= 0) {
					break;
				}

				const remaining = this.lineSize - offsetInLine;
				const length = Math.min(whole, remaining);

				runs.push({
					line,
					offsetPixels: (offsetInLine / this.pgroup.octets) * this.pgroup.pixels,
					length,
					from: line * this.lineSize + offsetInLine,
				});

				budget -= length;
				offsetInLine += length;
				if (offsetInLine === this.lineSize) {
					line++;
					offsetInLine = 0;
				} else {
					break; // the line did not fit, so this packet is full
				}
			}

			assert(runs.length > 0);
			packets.push(this.buildPacket(packed, runs, rtpTimestamp, line >= lines, fieldIsSecond));
		}

		return packets;
	}

	/** @internal */
	private buildPacket(
		packed: Uint8Array,
		runs: { line: number; offsetPixels: number; length: number; from: number }[],
		rtpTimestamp: number,
		isLast: boolean,
		fieldIsSecond: boolean,
	) {
		const headerSize = RTP_HEADER_SIZE + EXTENDED_SEQUENCE_SIZE + SRD_HEADER_SIZE * runs.length;
		const payloadSize = runs.reduce((sum, run) => sum + run.length, 0);
		const packet = new Uint8Array(headerSize + payloadSize);
		const view = new DataView(packet.buffer);

		const sequence = this.sequence >>> 0;
		this.sequence = (sequence + 1) >>> 0;

		packet[0] = RTP_VERSION << 6;
		packet[1] = (isLast ? 0x80 : 0) | this.payloadType; // the marker bit ends the frame or field
		view.setUint16(2, sequence & 0xffff, false);
		view.setUint32(4, rtpTimestamp >>> 0, false);
		view.setUint32(8, this.ssrc, false);

		view.setUint16(RTP_HEADER_SIZE, (sequence >>> 16) & 0xffff, false); // extended sequence number

		let at = RTP_HEADER_SIZE + EXTENDED_SEQUENCE_SIZE;
		for (const [index, run] of runs.entries()) {
			const continues = index < runs.length - 1;
			view.setUint16(at, run.length, false);
			view.setUint16(at + 2, (fieldIsSecond ? 0x8000 : 0) | (run.line & 0x7fff), false);
			view.setUint16(at + 4, (continues ? 0x8000 : 0) | (run.offsetPixels & 0x7fff), false);
			at += SRD_HEADER_SIZE;
		}

		for (const run of runs) {
			packet.set(packed.subarray(run.from, run.from + run.length), at);
			at += run.length;
		}

		return packet;
	}
}

/** What the SDP says about the stream beyond its geometry; the defaults are ST 2110-20's own.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110SdpOptions = {
	/**
 * The video being described. */
	format: St2110VideoFormat;
	/** Where the stream is sent. A multicast group is the usual case on a 2110 network. */
	address: string;
	/** The UDP port it is sent to. */
	port: number;
	/** The dynamic payload type, which must match the packetizer's. Defaults to 96. */
	payloadType?: number;
	/** The session name the SDP carries. */
	sessionName?: string;
	/** Transfer characteristic, defaulting to `SDR`. */
	transferCharacteristic?: string;
	/** Colorimetry, defaulting to `BT709`. */
	colorimetry?: string;
	/**
	 * Sender type: `2110TPN` narrow, `2110TPNL` narrow linear, `2110TPW` wide. **Defaults to
	 * `2110TPW`.**
	 *
	 * This is a promise about how evenly the sender paces its packets, and a receiver sizes its buffer
	 * on it - claiming narrow and sending in bursts is worse than claiming wide, because the receiver
	 * believes the claim. Nothing scheduled by a JavaScript timer can keep to narrow, so the default
	 * is the one that is true. Set it to narrow only where the pacing is actually done elsewhere.
	 */
	senderType?: '2110TPN' | '2110TPNL' | '2110TPW';
	/** Multicast TTL, defaulting to 64. Omitted for a unicast address. */
	ttl?: number;
	/** The PTP grandmaster this stream's clock is locked to, written as `ts-refclk`. */
	ptpGrandmaster?: string;
};

const isMulticastIpv4 = (address: string) => {
	const first = Number(address.split('.')[0]);
	return Number.isInteger(first) && first >= 224 && first <= 239;
};

/**
 * The SDP that describes an ST 2110-20 stream, which is how a receiver is told what is arriving - there
 * is nothing in the RTP packets that states the picture's size or sampling.
 *
 * The `fmtp` line carries the format: an ST 2110 receiver needs `sampling`, `width`, `height`, `depth`
 * and `exactframerate` to make sense of a single octet.
 *
 * @public
 * @group \@mediabunny/server
 */
export const buildSdp = (options: St2110SdpOptions): string => {
	const format = options.format;
	const payloadType = options.payloadType ?? 96;
	const multicast = isMulticastIpv4(options.address);
	const connection = multicast
		? `c=IN IP4 ${options.address}/${options.ttl ?? 64}`
		: `c=IN IP4 ${options.address}`;

	const fmtp = [
		`sampling=${format.sampling}`,
		`width=${format.width}`,
		`height=${format.height}`,
		`exactframerate=${format.exactFrameRate.numerator}/${format.exactFrameRate.denominator}`,
		`depth=${format.depth}`,
		`TCS=${options.transferCharacteristic ?? 'SDR'}`,
		`colorimetry=${options.colorimetry ?? 'BT709'}`,
		// General packing mode: lines are packed as RFC 4175 describes rather than block-packed
		'PM=2110GPM',
		'SSN="ST 2110-20:2017"',
		`TP=${options.senderType ?? '2110TPW'}`,
	];
	if (format.interlaced) {
		fmtp.splice(5, 0, 'interlace');
	}

	const lines = [
		'v=0',
		`o=- 0 0 IN IP4 ${options.address}`,
		`s=${options.sessionName ?? 'mediabunny ST 2110-20'}`,
		't=0 0',
		`m=video ${options.port} RTP/AVP ${payloadType}`,
		connection,
		`a=rtpmap:${payloadType} raw/90000`,
		`a=fmtp:${payloadType} ${fmtp.join('; ')}`,
		// The media clock starts at zero against the reference clock, which is what `direct=0` states
		'a=mediaclk:direct=0',
	];

	if (options.ptpGrandmaster) {
		lines.push(`a=ts-refclk:ptp=IEEE1588-2008:${options.ptpGrandmaster}`);
	}

	return lines.join('\n') + '\n';
};

/** Options for {@link St2110VideoSender}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110VideoSenderOptions = St2110PacketizerOptions & {
	/** Where to send. A multicast group is the usual case on an ST 2110 network. */
	address: string;
	/** The UDP port to send to. */
	port: number;
	/** Multicast TTL, defaulting to 64. Ignored for a unicast address. */
	ttl?: number;
	/** Which interface to send multicast from, by address, where the host has more than one. */
	multicastInterface?: string;
	/** Passed through to the SDP; see {@link St2110SdpOptions.senderType}. */
	senderType?: St2110SdpOptions['senderType'];
	/** Passed through to the SDP. */
	sessionName?: string;
};

const sleep = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

/** How often the pacer wakes to catch up, which is about as fine as a JavaScript timer gets. */
const PACER_TICK = 0.0005;

/**
 * Sends ST 2110-20 video as RTP over UDP, paced across the frame interval.
 *
 * **The pacing is wide, not narrow.** ST 2110-21 narrow asks for packets spread to within microseconds
 * of a fixed grid, which nothing scheduled by a JavaScript timer can keep to; this spreads them as
 * evenly as a sub-millisecond timer allows and reports what it actually achieved in
 * {@link St2110VideoSender.worstPacingError}. The SDP says `TP=2110TPW` to match, because a receiver
 * sizes its buffer on that claim.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110VideoSender {
	/** The packetizer this sender cuts its frames with. */
	readonly packetizer: St2110Packetizer;
	/** The SDP a receiver needs; there is nothing in the packets that states the picture's shape. */
	readonly sdp: string;

	/** How many RTP packets have gone out. */
	packetsSent = 0;
	/** How many octets of them, headers included. */
	bytesSent = 0;
	/** How many frames, or fields, have been sent whole. */
	framesSent = 0;
	/**
	 * The furthest any packet has gone out from where even pacing would have put it, in seconds. ST
	 * 2110-21 narrow would want this inside a few microseconds; a timer-paced sender will not be.
	 */
	worstPacingError = 0;

	/** @internal */
	private readonly socket: Socket;
	/** @internal */
	private readonly options: St2110VideoSenderOptions;
	/** @internal */
	private closed = false;

	/** @internal */
	private constructor(socket: Socket, options: St2110VideoSenderOptions) {
		this.socket = socket;
		this.options = options;
		this.packetizer = new St2110Packetizer(options);
		this.sdp = buildSdp({
			format: options.format,
			address: options.address,
			port: options.port,
			payloadType: options.payloadType,
			sessionName: options.sessionName,
			senderType: options.senderType,
			ttl: options.ttl,
		});
	}

	/** Opens the socket. Resolves once it is bound and any multicast options are set. */
	static async open(options: St2110VideoSenderOptions): Promise<St2110VideoSender> {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (typeof options.address !== 'string' || options.address.length === 0) {
			throw new TypeError('options.address must be a non-empty string.');
		}
		if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
			throw new TypeError('options.port must be an integer between 1 and 65535.');
		}

		const socket = createSocket({ type: 'udp4', reuseAddr: true });
		await new Promise<void>((resolve, reject) => {
			socket.once('error', reject);
			socket.bind(() => {
				socket.off('error', reject);
				resolve();
			});
		});

		if (isMulticastIpv4(options.address)) {
			socket.setMulticastTTL(options.ttl ?? 64);
			if (options.multicastInterface) {
				socket.setMulticastInterface(options.multicastInterface);
			}
		}

		return new St2110VideoSender(socket, options);
	}

	/**
	 * Sends one frame, or one field of an interlaced stream, spread across its own frame interval.
	 * Resolves once the last packet has gone out, so awaiting it paces the caller too.
	 *
	 * The RTP timestamp defaults to the frame's place in the stream at 90 kHz, derived from the exact
	 * frame rate - which is why that is stated as a ratio.
	 */
	async send(
		packed: Uint8Array,
		options: {
			/** The frame's 90 kHz sampling instant; derived from the frame rate when left out. */
			rtpTimestamp?: number;
			/** Set for the second field of an interlaced frame, which the SRD field bit states. */
			fieldIsSecond?: boolean;
		} = {},
	): Promise<void> {
		if (this.closed) {
			throw new Error('This sender has been closed.');
		}

		const rate = this.options.format.exactFrameRate;
		const rtpTimestamp = options.rtpTimestamp
			?? Math.round(this.framesSent * 90_000 * rate.denominator / rate.numerator);

		const packets = this.packetizer.packetize(packed, rtpTimestamp, options.fieldIsSecond);
		const frameSeconds = rate.denominator / rate.numerator;
		const perPacket = frameSeconds / packets.length;
		const start = performance.now() / 1000;

		let sent = 0;
		while (sent < packets.length) {
			const elapsed = performance.now() / 1000 - start;
			// How many should already have gone out if they were evenly spread
			const due = Math.min(packets.length, Math.floor(elapsed / perPacket) + 1);

			while (sent < due) {
				const packet = packets[sent]!;
				this.socket.send(packet, this.options.port, this.options.address);
				this.packetsSent++;
				this.bytesSent += packet.byteLength;

				const error = Math.abs(elapsed - sent * perPacket);
				if (error > this.worstPacingError) {
					this.worstPacingError = error;
				}
				sent++;
			}

			if (sent < packets.length) {
				await sleep(PACER_TICK);
			}
		}

		this.framesSent++;
	}

	/** Closes the socket. */
	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		await new Promise<void>(resolve => this.socket.close(resolve));
	}
}
