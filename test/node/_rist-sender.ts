/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSocket, type Socket } from 'node:dgram';

const RTCP_APP = 204;
const RTCP_RTPFB = 205;
const RIST_APP_NAME = 0x52495354;

export type RistSenderOptions = {
	/** TS packets per RTP packet. 7 is what a RIST sender uses, filling an Ethernet frame. */
	packetsPerDatagram?: number;
	/** Sequence number to start from, so a test can run the wrap. */
	firstSequence?: number;
	/** Returns true for a sequence number the first send should skip. */
	drop?: (seq: number) => boolean;
	/** Swaps each pair of datagrams before sending, so the receiver has to reorder. */
	swapPairs?: boolean;
	/** Whether to answer a NACK with the packet it names. */
	retransmit?: boolean;
	/** Whether to open an RTCP socket at all. */
	control?: boolean;
	/**
	 * Binds control to `port + 1` and waits there for the receiver to announce itself, then sends media to
	 * the port below the one that announce came from, as a sender facing a RIST caller does.
	 */
	discover?: boolean;
	/** Milliseconds between datagrams. */
	intervalMs?: number;
};

export type RistSender = {
	/** Sends the whole stream, resolving once every datagram has left. */
	send: () => Promise<void>;
	/** Sequence numbers this sender was asked to retransmit, in the order asked. */
	nacked: () => number[];
	close: () => void;
};

const buildRtp = (seq: number, timestamp: number, ssrc: number, payload: Uint8Array) => {
	const bytes = new Uint8Array(12 + payload.length);
	bytes[0] = 0x80;
	bytes[1] = 33; // MP2T
	bytes[2] = (seq >> 8) & 0xff;
	bytes[3] = seq & 0xff;
	bytes[4] = (timestamp >>> 24) & 0xff;
	bytes[5] = (timestamp >>> 16) & 0xff;
	bytes[6] = (timestamp >>> 8) & 0xff;
	bytes[7] = timestamp & 0xff;
	bytes[8] = (ssrc >>> 24) & 0xff;
	bytes[9] = (ssrc >>> 16) & 0xff;
	bytes[10] = (ssrc >>> 8) & 0xff;
	bytes[11] = ssrc & 0xff;
	bytes.set(payload, 12);
	return bytes;
};

/** The sequence numbers a compound RTCP packet asks for, from either NACK form. */
export const sequencesNacked = (bytes: Uint8Array): number[] => {
	const out: number[] = [];
	let offset = 0;

	while (offset + 8 <= bytes.length) {
		const packetType = bytes[offset + 1]!;
		const words = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
		const end = offset + (words + 1) * 4;

		if (packetType === RTCP_RTPFB) {
			for (let at = offset + 12; at + 4 <= end; at += 4) {
				const pid = (bytes[at]! << 8) | bytes[at + 1]!;
				const blp = (bytes[at + 2]! << 8) | bytes[at + 3]!;
				out.push(pid);
				for (let bit = 0; bit < 16; bit++) {
					if (blp & (1 << bit)) {
						out.push((pid + bit + 1) & 0xffff);
					}
				}
			}
		} else if (packetType === RTCP_APP) {
			const name = (bytes[offset + 8]! << 24 | bytes[offset + 9]! << 16
				| bytes[offset + 10]! << 8 | bytes[offset + 11]!) >>> 0;
			if (name === RIST_APP_NAME) {
				for (let at = offset + 12; at + 4 <= end; at += 4) {
					const start = (bytes[at]! << 8) | bytes[at + 1]!;
					const extra = (bytes[at + 2]! << 8) | bytes[at + 3]!;
					for (let i = 0; i <= extra; i++) {
						out.push((start + i) & 0xffff);
					}
				}
			}
		}

		offset = end;
	}

	return out;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A RIST Simple Profile sender, in the terms the tests need: it can drop, reorder, wrap and retransmit.
 * Only what the receiver is tested against — no SR timing, no encryption.
 */
export const ristSender = (host: string, port: number, ts: Uint8Array, options: RistSenderOptions = {}): RistSender => {
	const packetsPerDatagram = options.packetsPerDatagram ?? 7;
	const intervalMs = options.intervalMs ?? 1;
	const ssrc = 0x1234abcd;
	const media = createSocket('udp4');
	const control: Socket | undefined = options.control === false ? undefined : createSocket('udp4');

	const datagrams: { seq: number; bytes: Uint8Array }[] = [];
	for (let offset = 0, i = 0; offset < ts.length; offset += 188 * packetsPerDatagram, i++) {
		const seq = ((options.firstSequence ?? 0) + i) & 0xffff;
		datagrams.push({
			seq,
			bytes: buildRtp(seq, i * 3600, ssrc, ts.subarray(offset, offset + 188 * packetsPerDatagram)),
		});
	}

	const bySequence = new Map(datagrams.map(datagram => [datagram.seq, datagram.bytes]));
	const nacked: number[] = [];
	let target = { address: host, port };

	control?.on('message', (message) => {
		for (const seq of sequencesNacked(new Uint8Array(message))) {
			nacked.push(seq);
			const bytes = options.retransmit === false ? undefined : bySequence.get(seq);
			if (bytes) {
				media.send(bytes, target.port, target.address);
			}
		}
	});

	return {
		send: async () => {
			if (control && options.discover) {
				await new Promise<void>(resolve => control.bind(port + 1, () => resolve()));
				const from = await new Promise<{ address: string; port: number }>((resolve) => {
					control.once('message', (_message, rinfo) => resolve(rinfo));
				});
				target = { address: from.address, port: from.port - 1 };
			} else if (control) {
				// Ephemeral: the SR below tells the receiver where to send NACKs, so this pair need not be
				// adjacent, and a guessed port collides with the rest of the suite
				await new Promise<void>(resolve => control.bind(() => resolve()));
				// An SR, as TR-06-1 has a sender send: it is what tells the receiver where to send NACKs
				const sr = new Uint8Array(28);
				sr[0] = 0x80;
				sr[1] = 200;
				sr[3] = 6;
				sr[4] = (ssrc >>> 24) & 0xff;
				sr[5] = (ssrc >>> 16) & 0xff;
				sr[6] = (ssrc >>> 8) & 0xff;
				sr[7] = ssrc & 0xff;
				control.send(sr, target.port + 1, target.address);
			}
			await new Promise<void>(resolve => media.bind(() => resolve()));
			const order = [...datagrams];
			if (options.swapPairs) {
				for (let i = 0; i + 1 < order.length; i += 2) {
					[order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
				}
			}

			for (const datagram of order) {
				if (!options.drop?.(datagram.seq)) {
					media.send(datagram.bytes, target.port, target.address);
				}
				if (intervalMs > 0) {
					await sleep(intervalMs);
				}
			}
		},
		nacked: () => nacked,
		close: () => {
			media.close();
			control?.close();
		},
	};
};
