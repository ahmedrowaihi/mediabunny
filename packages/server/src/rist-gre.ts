/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// RIST Main Profile framing (VSF TR-06-2). Main profile carries media, RTCP, keepalives and the tunnel
// over ONE UDP port, GRE-multiplexed, rather than simple profile's even/odd socket pair; the virtual
// ports of the reduced header are what separate the flows inside it.
//
// Field positions here were read off librist's own `_librist_proto_gre_send_data` and its receive path,
// which is the interop target. Two are easy to get backwards: the GRE flag bits are numbered from the
// LSB of each byte (seq is bit 4, key is bit 5), and encryption starts after the sequence number, so it
// covers the VSF and reduced headers as well as the payload.

import { cryptPayload, type RistKey } from './rist-psk';

/** @internal */
export const GRE_PROTOCOL_KEEPALIVE = 0x88b5;
/** @internal */
export const GRE_PROTOCOL_REDUCED = 0x88b6;
/** @internal */
export const GRE_PROTOCOL_FULL = 0x0800;
/** @internal */
export const GRE_PROTOCOL_VSF = 0xcce0;

const VSF_TYPE_RIST = 0x0000;
const VSF_SUBTYPE_REDUCED = 0x0000;
const VSF_SUBTYPE_KEEPALIVE = 0x8000;

/** The version librist speaks today; 1 is the minimum it still accepts. */
const GRE_VERSION = 2;

const FLAG1_SEQ = 1 << 4;
const FLAG1_KEY = 1 << 5;
const FLAG1_CHECKSUM = 1 << 7;
const FLAG2_KEY_256 = 1 << 6;

/** librist's `RIST_DEFAULT_VIRT_SRC_PORT`, which a peer echoes rather than interprets. */
export const VIRT_SRC_PORT = 1971;
/** librist's `RIST_DEFAULT_VIRT_DST_PORT`. Even for media; the odd one above it carries RTCP. */
export const VIRT_DST_PORT = 1968;

/** @internal */
export type GrePacket = {
	/** `null` for a keepalive, which states no virtual ports. */
	ports: { src: number; dst: number } | null;
	protocol: number;
	seq: number;
	payload: Uint8Array;
};

const writeU16 = (bytes: Uint8Array, at: number, value: number) => {
	bytes[at] = (value >> 8) & 0xff;
	bytes[at + 1] = value & 0xff;
};

const writeU32 = (bytes: Uint8Array, at: number, value: number) => {
	bytes[at] = (value >>> 24) & 0xff;
	bytes[at + 1] = (value >>> 16) & 0xff;
	bytes[at + 2] = (value >>> 8) & 0xff;
	bytes[at + 3] = value & 0xff;
};

const readU16 = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;

const readU32 = (bytes: Uint8Array, at: number) =>
	((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/**
 * Wraps a payload in a main-profile GRE datagram. `key` encrypts everything from the VSF header on,
 * which is what librist does and therefore what it expects back.
 *
 * @internal
 */
export const buildGre = (
	protocol: number,
	seq: number,
	ports: { src: number; dst: number } | null,
	payload: Uint8Array,
	key: RistKey | null,
): Uint8Array => {
	// Header first, so the encrypted span is known before anything is copied
	const inner: number[] = [];
	const carriesVsf = protocol === GRE_PROTOCOL_REDUCED || protocol === GRE_PROTOCOL_KEEPALIVE;
	if (carriesVsf) {
		const subtype = protocol === GRE_PROTOCOL_REDUCED ? VSF_SUBTYPE_REDUCED : VSF_SUBTYPE_KEEPALIVE;
		inner.push((VSF_TYPE_RIST >> 8) & 0xff, VSF_TYPE_RIST & 0xff, (subtype >> 8) & 0xff, subtype & 0xff);
	}
	if (ports) {
		inner.push((ports.src >> 8) & 0xff, ports.src & 0xff, (ports.dst >> 8) & 0xff, ports.dst & 0xff);
	}

	const fixed = 4 + (key ? 4 : 0) + 4;
	const clear = new Uint8Array(inner.length + payload.byteLength);
	clear.set(inner, 0);
	clear.set(payload, inner.length);

	const body = key ? cryptPayload(key, seq, clear) : clear;
	const datagram = new Uint8Array(fixed + body.byteLength);

	datagram[0] = FLAG1_SEQ | (key ? FLAG1_KEY : 0);
	datagram[1] = ((GRE_VERSION & 0x7) << 3) | (key && key.bits === 256 ? FLAG2_KEY_256 : 0);
	writeU16(datagram, 2, carriesVsf ? GRE_PROTOCOL_VSF : protocol);
	if (key) {
		datagram.set(key.nonce, 4);
	}
	writeU32(datagram, key ? 8 : 4, seq);
	datagram.set(body, fixed);

	return datagram;
};

/**
 * Reads a main-profile datagram, decrypting with whichever of the two keys its nonce selects.
 * `null` for anything that is not conformant, which is what librist calls a non-conformant packet and
 * what a simple-profile peer's RTP looks like from here.
 *
 * @internal
 */
export const parseGre = (
	bytes: Uint8Array,
	keyFor: ((nonce: Uint8Array, bits: 128 | 256) => RistKey | null) | null,
): GrePacket | null => {
	if (bytes.byteLength < 8 || (bytes[0]! & FLAG1_CHECKSUM) !== 0 || (bytes[0]! & FLAG1_SEQ) === 0) {
		return null;
	}

	const hasKey = (bytes[0]! & FLAG1_KEY) !== 0;
	const version = (bytes[1]! >> 3) & 0x7;
	if (version < 1 || version > GRE_VERSION) {
		return null;
	}

	let protocol = readU16(bytes, 2);
	let at = 4;
	let key: RistKey | null = null;

	if (hasKey) {
		if (bytes.byteLength < 12 || !keyFor) {
			return null;
		}
		key = keyFor(bytes.subarray(4, 8), (bytes[1]! & FLAG2_KEY_256) ? 256 : 128);
		if (!key) {
			return null;
		}
		at = 8;
	}

	const seq = readU32(bytes, at);
	at += 4;

	const body = key ? cryptPayload(key, seq, bytes.subarray(at)) : bytes.subarray(at);
	let offset = 0;

	if (protocol === GRE_PROTOCOL_VSF) {
		if (body.byteLength < 4 || readU16(body, 0) !== VSF_TYPE_RIST) {
			return null;
		}
		const subtype = readU16(body, 2);
		protocol = subtype === VSF_SUBTYPE_KEEPALIVE ? GRE_PROTOCOL_KEEPALIVE : GRE_PROTOCOL_REDUCED;
		offset = 4;
	}

	if (protocol !== GRE_PROTOCOL_REDUCED) {
		return { ports: null, protocol, seq, payload: body.subarray(offset) };
	}

	if (body.byteLength < offset + 4) {
		return null;
	}

	return {
		ports: { src: readU16(body, offset), dst: readU16(body, offset + 2) },
		protocol,
		seq,
		payload: body.subarray(offset + 4),
	};
};

/**
 * The keepalive of TR-06-2: a 6-byte MAC address and two capability bytes. librist reads the
 * capabilities to decide what a peer supports, and a zeroed pair claims nothing, which is the honest
 * answer for an implementation offering no tunnel and no advanced profile.
 *
 * @internal
 */
export const buildKeepalive = (mac: Uint8Array): Uint8Array => {
	const body = new Uint8Array(8);
	body.set(mac.subarray(0, 6), 0);
	return body;
};
