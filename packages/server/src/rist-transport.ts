/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// One path to one peer, with the profile difference contained here so the sender and receiver above are
// written once. Simple profile is two sockets carrying bare RTP and RTCP (TR-06-1 §5.1.1); main profile
// is one socket carrying both inside GRE, separated by the virtual ports of the reduced header.

import { createSocket, type Socket } from 'node:dgram';
import {
	buildGre,
	GRE_PROTOCOL_KEEPALIVE,
	GRE_PROTOCOL_REDUCED,
	parseGre,
	VIRT_DST_PORT,
	VIRT_SRC_PORT,
} from './rist-gre';
import { deriveKey, newNonce, type RistKey } from './rist-psk';

/** @internal */
export type PathAddress = { address: string; port: number };

/** @internal */
export type RistPathOptions = {
	profile: 'simple' | 'main';
	mode: 'listener' | 'caller';
	host: string;
	port: number;
	secret?: string;
	aesType: 128 | 256;
	onMedia: (payload: Uint8Array, from: PathAddress) => void;
	onControl: (payload: Uint8Array, from: PathAddress) => void;
	onError: (error: Error) => void;
};

const newSocket = () => createSocket({ type: 'udp4', reuseAddr: true });

const bind = (socket: Socket, port: number, address?: string) =>
	new Promise<void>((resolve, reject) => {
		socket.once('error', reject);
		socket.bind(address === undefined ? { port } : { address, port }, () => resolve());
	});

/** Attempts before an ephemeral even/odd pair is given up on; a collision is rare and retried. */
const PAIR_BIND_ATTEMPTS = 20;

const closeQuietly = (socket: Socket | undefined) => {
	try {
		socket?.close();
	} catch {
		// Not bound
	}
};

/**
 * A main-profile peer rotates its nonce, and each nonce means a different derived key. Keys are cached
 * by nonce because deriving one is 1024 rounds of PBKDF2 — doing that per datagram would cost more than
 * the decryption it enables.
 */
class KeyCache {
	private readonly cache = new Map<string, RistKey>();

	constructor(private readonly secret: string) {}

	for(nonce: Uint8Array, bits: 128 | 256): RistKey {
		const id = `${bits}:${Array.from(nonce).join(',')}`;
		let key = this.cache.get(id);
		if (!key) {
			// Bounded so a peer flooding randomised nonces cannot grow this without limit
			if (this.cache.size >= 8) {
				this.cache.delete(this.cache.keys().next().value!);
			}
			key = deriveKey(this.secret, nonce, bits);
			this.cache.set(id, key);
		}
		return key;
	}
}

/**
 * One peer over one path. Media and control go out through {@link RistPath.sendMedia} and
 * {@link RistPath.sendControl} whatever the profile; what reaches the wire differs.
 *
 * @internal
 */
export class RistPath {
	private media: Socket | undefined;
	/** Simple profile only: main profile multiplexes control onto {@link RistPath.media}. */
	private control: Socket | undefined;
	private keys: KeyCache | null = null;
	private txKey: RistKey | null = null;
	private greSeq = 1;
	private closed = false;

	/** Where this path sends media. A listener does not know until the far end announces itself. */
	peer: PathAddress | null = null;
	/**
	 * Where this path sends RTCP. Simple profile puts it on the port above the media one (TR-06-1
	 * §5.1.1), but the far end may answer from a different one behind NAT, so a control packet that
	 * actually arrives overrides the derived address. Main profile never uses this: there is one real
	 * port and the virtual ports inside GRE do the separating.
	 */
	private controlPeer: PathAddress | null = null;

	constructor(private readonly options: RistPathOptions) {
		if (options.secret !== undefined) {
			this.keys = new KeyCache(options.secret);
			this.txKey = deriveKey(options.secret, newNonce(false), options.aesType);
		}
	}

	private get main() {
		return this.options.profile === 'main';
	}

	async open(): Promise<void> {
		const { mode, host, port } = this.options;

		if (this.main) {
			const media = newSocket();
			this.media = media;
			media.on('message', (bytes, from) => this.onMainDatagram(new Uint8Array(bytes), from));
			media.on('error', this.options.onError);

			if (mode === 'listener') {
				await bind(media, port, host);
			} else {
				this.peer = { address: host, port };
				await bind(media, 0);
			}
			return;
		}

		const [media, control] = await this.bindPair();
		this.media = media;
		this.control = control;
		media.on('message', (bytes, from) => this.options.onMedia(new Uint8Array(bytes), from));
		control.on('message', (bytes, from) => {
			this.controlPeer = from;
			this.options.onControl(new Uint8Array(bytes), from);
		});
		media.on('error', this.options.onError);
		control.on('error', this.options.onError);

		if (mode === 'caller') {
			this.peer = { address: host, port };
		}
	}

	/** The media socket and the control socket above it; a caller takes any adjacent ephemeral pair. */
	private async bindPair(): Promise<[Socket, Socket]> {
		const { mode, host, port } = this.options;

		if (mode === 'listener') {
			const pair: [Socket, Socket] = [newSocket(), newSocket()];
			try {
				await bind(pair[0], port, host);
				await bind(pair[1], port + 1, host);
			} catch (error) {
				pair.forEach(closeQuietly);
				throw error;
			}
			return pair;
		}

		let lastError: unknown;
		for (let attempt = 0; attempt < PAIR_BIND_ATTEMPTS; attempt++) {
			const pair: [Socket, Socket] = [newSocket(), newSocket()];
			const base = 1024 + Math.floor(Math.random() * 32_000) * 2;
			try {
				await bind(pair[0], base);
				await bind(pair[1], base + 1);
				return pair;
			} catch (error) {
				lastError = error;
				pair.forEach(closeQuietly);
			}
		}
		throw lastError;
	}

	private onMainDatagram(bytes: Uint8Array, from: PathAddress) {
		const packet = parseGre(bytes, this.keys ? (nonce, bits) => this.keys!.for(nonce, bits) : null);
		if (!packet) {
			return;
		}

		// A keepalive states liveness and nothing else, but it is the first thing a caller sends, so it
		// is also how a listener learns where to answer
		this.peer ??= from;
		if (packet.protocol === GRE_PROTOCOL_KEEPALIVE) {
			return;
		}
		if (packet.protocol !== GRE_PROTOCOL_REDUCED || !packet.ports) {
			return;
		}

		// The odd virtual port carries control, the even one media, exactly as the real ports do in
		// simple profile
		if (packet.ports.dst % 2 === 1) {
			this.options.onControl(packet.payload, from);
		} else {
			this.options.onMedia(packet.payload, from);
		}
	}

	private sendTo(payload: Uint8Array, virtualDst: number, socket: Socket | undefined, to: PathAddress) {
		if (this.closed || !socket) {
			return;
		}

		const datagram = this.main
			? buildGre(
					GRE_PROTOCOL_REDUCED,
					this.greSeq++,
					{ src: VIRT_SRC_PORT, dst: virtualDst },
					payload,
					this.txKey,
				)
			: payload;

		socket.send(datagram, to.port, to.address, () => {
			// A send error is reported through the socket's own error event; dropping one datagram is
			// not worth failing a live stream over
		});
	}

	sendMedia(payload: Uint8Array, to: PathAddress = this.peer!) {
		if (to) {
			this.sendTo(payload, VIRT_DST_PORT, this.media, to);
		}
	}

	sendControl(payload: Uint8Array, to: PathAddress = this.peer!) {
		if (!to) {
			return;
		}
		if (this.main) {
			this.sendTo(payload, VIRT_DST_PORT + 1, this.media, to);
			return;
		}
		this.sendTo(payload, 0, this.control, this.controlPeer ?? { address: to.address, port: to.port + 1 });
	}

	/** Main profile only: states liveness on a path carrying nothing, so a listener keeps its peer. */
	sendKeepalive() {
		if (!this.main || this.closed || !this.media || !this.peer) {
			return;
		}
		const body = new Uint8Array(8);
		this.media.send(
			buildGre(GRE_PROTOCOL_KEEPALIVE, this.greSeq++, null, body, this.txKey),
			this.peer.port,
			this.peer.address,
			() => {},
		);
	}

	close() {
		this.closed = true;
		closeQuietly(this.media);
		closeQuietly(this.control);
		this.media = undefined;
		this.control = undefined;
	}
}
