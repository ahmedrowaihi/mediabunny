/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// ST 2110-30 is AES67 with constraints, and the payload is as plain as it gets: interleaved
// big-endian PCM, no payload header at all. What there is to get right is everything around it.
//
// The packet time decides the payload size, not the MTU. A sender picks 1 ms or 125 us and every
// packet then carries exactly `sampleRate * packetTime` frames of `channels * depth / 8` octets. The
// RTP timestamp advances by the number of frames rather than by octets, because the media clock runs
// at the audio sampling rate (ST 2110-30 section 6.1) - not at 90 kHz as it does for video.
//
// The conformance levels in Table 2 describe what a RECEIVER accepts, not what a sender is. That is
// why there is no level parameter in the SDP and why `receiverLevelsFor` answers in the direction
// that is actually useful: a sender choosing a packet time and a channel count wants to know how
// widely the result will be accepted. Reading those levels as a sender claim - which every secondary
// summary of this standard invites - would put a parameter in the SDP that the standard does not
// define.

import { createSocket, type Socket } from 'node:dgram';
import { RTP_HEADER_SIZE, RTP_VERSION } from './rtp';
import { St2110Clock, type St2110ClockOptions } from './st2110-clock';

/**
 * Bits per sample. ST 2110-30 inherits AES67's L16 and L24; 24-bit is what broadcast uses.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AudioDepth = 16 | 24;

/**
 * The packet times ST 2110-30 defines, in milliseconds.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110PacketTime = 1 | 0.125;

/**
 * The channel grouping symbols of ST 2110-30 Table 1, with the channel count each stands for.
 *
 * `U01` through `U64` are not listed: they are generated, since the number is part of the symbol.
 *
 * @public
 * @group \@mediabunny/server
 */
// Quoted deliberately: `51` unquoted is a numeric key, which would make `keyof typeof` yield the
// number 51 rather than the string '51' and leave callers unable to write the symbol the standard
// defines.
/* eslint-disable @stylistic/quote-props */
export const ST2110_CHANNEL_GROUPS = {
	/** Mono. */
	M: 1,
	/** Dual mono: M1, M2. */
	DM: 2,
	/** Standard stereo: Left, Right. */
	ST: 2,
	/** Matrix stereo: Left Total, Right Total. */
	LtRt: 2,
	/** 5.1 surround: L, R, C, LFE, Ls, Rs. */
	'51': 6,
	/** 7.1 surround: L, R, C, LFE, Lss, Rss, Lrs, Rrs. */
	'71': 8,
	/** 22.2 surround, ordered per SMPTE ST 2036-2 Table 1. */
	'222': 24,
	/** One SDI audio group: 1, 2, 3, 4. */
	SGRP: 4,
} as const;
/* eslint-enable @stylistic/quote-props */

/**
 * One channel grouping symbol: a name from {@link ST2110_CHANNEL_GROUPS}, or `U01`..`U64` for a
 * group whose mix is unknown.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110ChannelGroup = keyof typeof ST2110_CHANNEL_GROUPS | `U${string}`;

/** How many channels a grouping symbol stands for, or null if it is not a symbol at all. */
const channelsInGroup = (group: string): number | null => {
	if (group in ST2110_CHANNEL_GROUPS) {
		return ST2110_CHANNEL_GROUPS[group as keyof typeof ST2110_CHANNEL_GROUPS];
	}

	// Undefined groups carry their size in the symbol, with a leading zero below ten
	const undefinedGroup = /^U(\d{2})$/.exec(group);
	if (!undefinedGroup) {
		return null;
	}

	const count = Number(undefinedGroup[1]);
	return count >= 1 && count <= 64 ? count : null;
};

/**
 * Writes the `channel-order` parameter for a list of channel groups.
 *
 * The RFC 3190 syntax ST 2110-30 section 6.2.2 asks for, e.g. `SMPTE2110.(51,ST)` for a 5.1 group
 * followed by a stereo pair.
 *
 * @public
 * @group \@mediabunny/server
 */
export const buildChannelOrder = (groups: St2110ChannelGroup[]): string => {
	if (!Array.isArray(groups) || groups.length === 0) {
		throw new TypeError('groups must be a non-empty array.');
	}

	for (const group of groups) {
		if (channelsInGroup(group) === null) {
			throw new TypeError(
				`'${String(group)}' is not a channel grouping symbol; it must be one of`
				+ ` ${Object.keys(ST2110_CHANNEL_GROUPS).join(', ')}, or U01 through U64.`,
			);
		}
	}

	return `SMPTE2110.(${groups.join(',')})`;
};

/**
 * How many channels a list of channel groups accounts for.
 *
 * @public
 * @group \@mediabunny/server
 */
export const channelsInOrder = (groups: St2110ChannelGroup[]): number =>
	groups.reduce((total, group) => {
		const count = channelsInGroup(group);
		if (count === null) {
			throw new TypeError(`'${String(group)}' is not a channel grouping symbol.`);
		}
		return total + count;
	}, 0);

/**
 * An uncompressed audio stream, as ST 2110-30 constrains it.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AudioFormat = {
	/**
	 * Samples per second. 48000 is the only rate every conforming implementation must support;
	 * 44100 and 96000 are optional, and ST 2110-30 puts anything else out of scope.
	 */
	sampleRate: number;
	/** Bits per sample. */
	depth: St2110AudioDepth;
	/** Channels in the stream, interleaved in the payload. */
	channels: number;
	/** Milliseconds of audio per packet. */
	packetTime: St2110PacketTime;
};

/**
 * A conformance level from ST 2110-30 Table 2.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110ConformanceLevel = 'A' | 'AX' | 'B' | 'BX' | 'C' | 'CX';

/** Table 2, as (sampleRate, packetTime) -> the greatest channel count the level receives. */
const LEVEL_TABLE: Record<St2110ConformanceLevel, { sampleRate: number; packetTime: number; maxChannels: number }[]> = {
	A: [{ sampleRate: 48000, packetTime: 1, maxChannels: 8 }],
	AX: [
		{ sampleRate: 48000, packetTime: 1, maxChannels: 8 },
		{ sampleRate: 96000, packetTime: 1, maxChannels: 4 },
	],
	B: [
		{ sampleRate: 48000, packetTime: 1, maxChannels: 8 },
		{ sampleRate: 48000, packetTime: 0.125, maxChannels: 8 },
	],
	BX: [
		{ sampleRate: 48000, packetTime: 1, maxChannels: 8 },
		{ sampleRate: 48000, packetTime: 0.125, maxChannels: 8 },
		{ sampleRate: 96000, packetTime: 1, maxChannels: 4 },
		// Table 2 really does say 8 here against 4 at the longer packet time
		{ sampleRate: 96000, packetTime: 0.125, maxChannels: 8 },
	],
	C: [
		{ sampleRate: 48000, packetTime: 1, maxChannels: 8 },
		{ sampleRate: 48000, packetTime: 0.125, maxChannels: 64 },
	],
	CX: [
		{ sampleRate: 48000, packetTime: 1, maxChannels: 8 },
		{ sampleRate: 48000, packetTime: 0.125, maxChannels: 64 },
		{ sampleRate: 96000, packetTime: 1, maxChannels: 4 },
		{ sampleRate: 96000, packetTime: 0.125, maxChannels: 32 },
	],
};

/**
 * Which ST 2110-30 conformance levels can receive a stream of this shape.
 *
 * Empty means no level in Table 2 covers it, which a sender should treat as a warning rather than an
 * error: the stream is still valid AES67, but a conforming receiver is not obliged to take it. A
 * 16-channel 48 kHz stream at 1 ms is the usual way to land here, and section 7's own note says what
 * to do about it - send several streams of eight channels instead.
 *
 * @public
 * @group \@mediabunny/server
 */
export const receiverLevelsFor = (format: St2110AudioFormat): St2110ConformanceLevel[] =>
	(Object.keys(LEVEL_TABLE) as St2110ConformanceLevel[]).filter(level =>
		LEVEL_TABLE[level].some(row =>
			row.sampleRate === format.sampleRate
			&& row.packetTime === format.packetTime
			&& format.channels >= 1
			&& format.channels <= row.maxChannels,
		),
	);

const assertFormat = (format: St2110AudioFormat) => {
	if (!format || typeof format !== 'object') {
		throw new TypeError('options.format must be an object.');
	}
	if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
		throw new TypeError('options.format.sampleRate must be a positive integer.');
	}
	if (format.depth !== 16 && format.depth !== 24) {
		throw new TypeError(`options.format.depth must be 16 or 24, got ${String(format.depth)}.`);
	}
	if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > 64) {
		throw new TypeError('options.format.channels must be an integer in [1, 64].');
	}
	if (format.packetTime !== 1 && format.packetTime !== 0.125) {
		throw new TypeError(
			`options.format.packetTime must be 1 or 0.125, got ${String(format.packetTime)}.`,
		);
	}

	const frames = (format.sampleRate * format.packetTime) / 1000;
	if (!Number.isInteger(frames)) {
		// 44100 at 125 us is 5.5125 frames, which cannot be sent: a packet carries whole frames
		throw new TypeError(
			`${format.sampleRate} Hz at a ${format.packetTime} ms packet time is ${frames} frames per`
			+ ' packet, and a packet carries whole frames.',
		);
	}
};

/**
 * Frames of audio in one packet, which the packet time fixes rather than the MTU.
 *
 * @public
 * @group \@mediabunny/server
 */
export const framesPerPacket = (format: St2110AudioFormat): number => {
	assertFormat(format);
	return (format.sampleRate * format.packetTime) / 1000;
};

/**
 * Octets of payload in one packet.
 *
 * @public
 * @group \@mediabunny/server
 */
export const audioPayloadSize = (format: St2110AudioFormat): number =>
	framesPerPacket(format) * format.channels * (format.depth / 8);

/** Options for {@link St2110AudioPacketizer}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AudioPacketizerOptions = {
	/** The audio being carried. */
	format: St2110AudioFormat;
	/** The stream's synchronization source. */
	ssrc: number;
	/** The dynamic payload type the SDP binds, defaulting to 97. */
	payloadType?: number;
	/** Where the sequence numbers start; a random value is what RFC 3550 asks for. */
	initialSequenceNumber?: number;
	/** Where the RTP timestamp starts, on the audio sampling clock. */
	initialTimestamp?: number;
};

/**
 * Cuts interleaved PCM into ST 2110-30 RTP packets.
 *
 * Feed it any amount of audio; it keeps whatever does not fill a whole packet and uses it at the
 * front of the next call, because a short packet would misstate the packet time every receiver sizes
 * its buffer from. The marker bit is never set: ST 2110-30 carries a continuous stream with no frame
 * boundary to mark.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110AudioPacketizer {
	/** The audio being carried. */
	readonly format: St2110AudioFormat;
	/** Frames of audio each packet carries. */
	readonly framesPerPacket: number;
	/** Octets of payload each packet carries. */
	readonly payloadSize: number;
	/** @internal */
	private readonly ssrc: number;
	/** @internal */
	private readonly payloadType: number;
	/** @internal */
	private sequence: number;
	/** @internal */
	private timestamp: number;
	/** @internal */
	private pending = new Uint8Array(0);

	constructor(options: St2110AudioPacketizerOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		assertFormat(options.format);
		if (!Number.isInteger(options.ssrc) || options.ssrc < 0 || options.ssrc > 0xffffffff) {
			throw new TypeError('options.ssrc must be an integer in [0, 4294967295].');
		}

		const payloadType = options.payloadType ?? 97;
		if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
			throw new TypeError('options.payloadType must be an integer in [0, 127].');
		}

		const sequence = options.initialSequenceNumber ?? 0;
		if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
			throw new TypeError('options.initialSequenceNumber must be an integer in [0, 65535].');
		}

		const timestamp = options.initialTimestamp ?? 0;
		if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
			throw new TypeError('options.initialTimestamp must be an integer in [0, 4294967295].');
		}

		this.format = options.format;
		this.framesPerPacket = framesPerPacket(options.format);
		this.payloadSize = audioPayloadSize(options.format);
		this.ssrc = options.ssrc;
		this.payloadType = payloadType;
		this.sequence = sequence;
		this.timestamp = timestamp;
	}

	/** The sequence number the next packet will carry. */
	get nextSequenceNumber() {
		return this.sequence & 0xffff;
	}

	/** The RTP timestamp the next packet will carry. */
	get nextTimestamp() {
		return this.timestamp >>> 0;
	}

	/** Octets held back because they do not fill a whole packet. */
	get pendingOctets() {
		return this.pending.length;
	}

	/**
	 * Packs as many whole packets as `pcm` allows, interleaved big-endian, holding back the remainder.
	 */
	pack(pcm: Uint8Array): Uint8Array[] {
		if (!(pcm instanceof Uint8Array)) {
			throw new TypeError('pcm must be a Uint8Array.');
		}

		let source: Uint8Array;
		if (this.pending.length === 0) {
			source = pcm;
		} else {
			source = new Uint8Array(this.pending.length + pcm.length);
			source.set(this.pending, 0);
			source.set(pcm, this.pending.length);
		}

		const packets: Uint8Array[] = [];
		let at = 0;
		while (at + this.payloadSize <= source.length) {
			const packet = new Uint8Array(RTP_HEADER_SIZE + this.payloadSize);
			const view = new DataView(packet.buffer);

			packet[0] = RTP_VERSION << 6;
			// No marker bit: a continuous stream has no frame boundary to mark
			packet[1] = this.payloadType;
			view.setUint16(2, this.sequence & 0xffff, false);
			view.setUint32(4, this.timestamp >>> 0, false);
			view.setUint32(8, this.ssrc, false);
			packet.set(source.subarray(at, at + this.payloadSize), RTP_HEADER_SIZE);

			packets.push(packet);
			this.sequence = (this.sequence + 1) & 0xffff;
			// The media clock runs at the sampling rate, so this advances by FRAMES, not octets
			this.timestamp = (this.timestamp + this.framesPerPacket) >>> 0;
			at += this.payloadSize;
		}

		this.pending = at === source.length ? new Uint8Array(0) : source.slice(at);
		return packets;
	}
}

/** Options for {@link buildAudioSdp}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AudioSdpOptions = {
	/** The audio being described. */
	format: St2110AudioFormat;
	/** The destination address, multicast or unicast. */
	address: string;
	/** The destination port. */
	port: number;
	/** The dynamic payload type, matching the packetizer's. Defaults to 97. */
	payloadType?: number;
	/** Multicast hop limit. Defaults to 64. */
	ttl?: number;
	/** The session name. */
	sessionName?: string;
	/** The channel groups, written as `channel-order`. Must account for every channel. */
	channelOrder?: St2110ChannelGroup[];
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

/**
 * Writes the SDP for an ST 2110-30 stream.
 *
 * `ptime` is not decoration: it is how a receiver knows how much audio a packet holds, since the
 * payload carries no header to say so.
 *
 * @public
 * @group \@mediabunny/server
 */
export const buildAudioSdp = (options: St2110AudioSdpOptions): string => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	assertFormat(options.format);
	if (typeof options.address !== 'string' || options.address === '') {
		throw new TypeError('options.address must be a non-empty string.');
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new TypeError('options.port must be an integer in [0, 65535].');
	}

	const format = options.format;
	const payloadType = options.payloadType ?? 97;
	const multicast = isMulticastIpv4(options.address);

	const lines = [
		'v=0',
		`o=- 0 0 IN IP4 ${options.address}`,
		`s=${options.sessionName ?? 'mediabunny ST 2110-30'}`,
		't=0 0',
		`m=audio ${options.port} RTP/AVP ${payloadType}`,
		multicast ? `c=IN IP4 ${options.address}/${options.ttl ?? 64}` : `c=IN IP4 ${options.address}`,
		`a=rtpmap:${payloadType} L${format.depth}/${format.sampleRate}/${format.channels}`,
	];

	if (options.channelOrder) {
		const stated = channelsInOrder(options.channelOrder);
		if (stated !== format.channels) {
			// A mismatch is not harmless: ST 2110-30 section 6.2.2 says the undeclared channels become
			// Undefined, so a wrong order silently discards the mix of everything past it
			throw new TypeError(
				`options.channelOrder accounts for ${stated} channels and the stream carries`
				+ ` ${format.channels}.`,
			);
		}
		lines.push(`a=fmtp:${payloadType} channel-order=${buildChannelOrder(options.channelOrder)}`);
	}

	lines.push(`a=ptime:${format.packetTime}`);
	lines.push('a=mediaclk:direct=0');
	if (options.ptpGrandmaster) {
		lines.push(`a=ts-refclk:ptp=IEEE1588-2008:${options.ptpGrandmaster}`);
	} else if (options.localMac) {
		lines.push(`a=ts-refclk:localmac=${options.localMac}`);
	}

	return lines.join('\n') + '\n';
};

/** Options for {@link St2110AudioSender}.
 *
 * @public
 * @group \@mediabunny/server
 */
export type St2110AudioSenderOptions = St2110AudioPacketizerOptions & {
	/** The destination address. */
	address: string;
	/** The destination port. */
	port: number;
	/** Multicast hop limit. Defaults to 64. */
	ttl?: number;
} & St2110ClockOptions;

/**
 * Sends uncompressed audio as ST 2110-30 over UDP, paced to the packet time.
 *
 * Audio pacing is simpler than video's: every packet is the same size and they are evenly spaced, so
 * the schedule is one packet every `packetTime`. A 125 us packet time is 8000 packets a second, which
 * no JavaScript timer can hit individually - so packets due within the same tick go out together and
 * `worstPacingError` reports how far off the schedule the sender actually ran.
 *
 * @public
 * @group \@mediabunny/server
 */
export class St2110AudioSender {
	/** @internal */
	private readonly packetizer: St2110AudioPacketizer;
	/** @internal */
	private readonly address: string;
	/** @internal */
	private readonly port: number;
	/** @internal */
	private readonly ttl: number;
	/** @internal */
	private socket: Socket | null = null;
	/** @internal */
	private nextDue: number | null = null;
	/** Datagrams written so far. */
	packetsSent = 0;
	/** The furthest, in seconds, any packet has left behind its scheduled time. */
	worstPacingError = 0;

	constructor(options: St2110AudioSenderOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (typeof options.address !== 'string' || options.address === '') {
			throw new TypeError('options.address must be a non-empty string.');
		}
		if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
			throw new TypeError('options.port must be an integer in [0, 65535].');
		}

		// A locked clock states where the stream's timestamps begin; the packetizer counts on from there
		// in media units, so the spacing stays exact
		const clock = new St2110Clock(options);
		this.packetizer = new St2110AudioPacketizer({
			...options,
			initialTimestamp: options.initialTimestamp ?? clock.now(options.format.sampleRate) ?? 0,
		});
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

	/** Sends PCM, pacing each packet to the packet time. */
	async send(pcm: Uint8Array) {
		const socket = this.socket;
		if (!socket) {
			throw new Error('The sender is not open; call open() first.');
		}

		const interval = this.packetizer.format.packetTime / 1000;
		this.nextDue ??= performance.now() / 1000;

		for (const packet of this.packetizer.pack(pcm)) {
			const now = performance.now() / 1000;
			const wait = this.nextDue - now;
			if (wait > 0) {
				await new Promise<void>(resolve => setTimeout(resolve, wait * 1000));
			} else {
				this.worstPacingError = Math.max(this.worstPacingError, -wait);
			}

			await new Promise<void>((resolve, reject) => {
				socket.send(packet, this.port, this.address, error => error ? reject(error) : resolve());
			});
			this.packetsSent++;
			// Against the schedule, not against now: pacing to `now` lets every late packet push the
			// whole stream later, and the drift never comes back
			this.nextDue += interval;
		}
	}

	/** Closes the socket. */
	async close() {
		const socket = this.socket;
		if (!socket) {
			return;
		}
		this.socket = null;
		this.nextDue = null;
		await new Promise<void>(resolve => socket.close(resolve));
	}
}
