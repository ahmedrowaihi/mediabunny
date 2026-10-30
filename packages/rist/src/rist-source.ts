/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The read side of RIST over librist, the counterpart to RistTarget. librist owns the de-jitter buffer,
// the NACKs and the reordering, so this pulls whole payloads out of its queue and hands them on in order.

import { ReadableStreamSource } from 'mediabunny';
import { getLibrist, type Librist } from './librist';
import { checkPeerOptions, peerUrl, positive, profileOf, type ResolvedPeer } from './peer-url';

/** Matches librist's own default, and what `RistTarget` sends. */
const DEFAULT_BUFFER_MS = 1_000;

/** Seconds of silence before the stream ends. */
const DEFAULT_READ_TIMEOUT = 30;

/**
 * How long one librist read waits. The read blocks for its whole timeout, so this is the granularity at
 * which cancellation and the silence deadline are noticed, not a latency bound.
 */
const READ_SLICE_MS = 250;

/**
 * Options for {@link RistSource}.
 *
 * @group \@mediabunny/rist
 * @public
 */
export type RistSourceOptions = {
	/**
	 * Whether to bind the URL's ports and wait for a sender (`'listener'`, the default) or to announce
	 * this receiver to one (`'caller'`).
	 */
	mode?: 'listener' | 'caller';
	/**
	 * Which RIST profile to speak. Defaults to `'main'`, matching librist's own tools.
	 *
	 * **Both ends must agree.** A profile disagreement does not fail loudly: librist logs
	 * `Non conformant main profile packet received` and delivers nothing.
	 *
	 * Encryption needs main profile: `'simple'` accepts a secret and does not enforce it, so passing
	 * one with `'simple'` throws rather than appearing to protect the stream.
	 */
	profile?: 'simple' | 'main';
	/**
	 * **Milliseconds** a packet may wait for the ones before it, which is also how long a lost packet
	 * has to be retransmitted. Defaults to 1000. This is the latency knob MediaConnect calls
	 * "max latency".
	 *
	 * Note that this is librist's own recovery buffer, so the NACK timing within it is librist's to
	 * decide — unlike `@mediabunny/server`'s `RistSource`, there is no `nackIntervalMs`.
	 */
	bufferMs?: number;
	/** **Seconds** without media before the stream ends. Defaults to 30. */
	readTimeout?: number;
	/** Pre-shared passphrase for main-profile encryption. Must match the sender's. */
	secret?: string;
	/** AES key length to use with {@link RistSourceOptions.secret}. Defaults to 256. */
	aesType?: 128 | 256;
	/**
	 * Enables the main-profile GRE tunnel, which carries arbitrary packets alongside the media. Off by
	 * default, and refused on simple profile, which has no GRE layer for them.
	 *
	 * The channel is bidirectional: read with {@link RistSource.readTunnelPacket} and send with
	 * {@link RistSource.sendTunnelPacket}.
	 */
	tunnel?: boolean;
	/** Maximum bytes to keep for re-reads. Passed through to Mediabunny's `ReadableStreamSource`. */
	maxCacheSize?: number;
};

type Resolved = ResolvedPeer & { readTimeout: number; tunnel: boolean };

/** Holds the receiver context and turns librist's reads into a byte stream. */
class RistReader {
	private librist: Librist;
	private ctx: unknown = null;
	private peerHandle: unknown = null;
	private cancelled = false;
	private pendingSlice: Promise<Uint8Array | null> | null = null;

	constructor(private url: string, private options: Resolved) {
		this.librist = getLibrist();
	}

	start() {
		const ctxOut: unknown[] = [null];
		if (this.librist.receiverCreate(ctxOut, profileOf(this.options.profile), null) !== 0) {
			throw new Error('librist could not create a receiver context.');
		}
		this.ctx = ctxOut[0];

		const configOut: unknown[] = [null];
		if (this.librist.parseAddress(peerUrl(this.url, this.options), configOut) !== 0) {
			this.destroy();
			throw new Error(`librist could not parse ${this.url} as a peer address.`);
		}

		const peerOut: unknown[] = [null];
		const created = this.librist.peerCreate(this.ctx, peerOut, configOut[0]);
		this.librist.peerConfigFree(configOut);
		this.peerHandle = peerOut[0];
		if (created !== 0) {
			this.destroy();
			throw new Error(`librist could not create a peer for ${this.url}.`);
		}

		// Before `rist_start`, as oob.h requires
		if (this.options.tunnel && this.librist.oobEnable(this.ctx) !== 0) {
			this.destroy();
			throw new Error('librist refused to enable the tunnel channel.');
		}

		if (this.librist.start(this.ctx) !== 0) {
			this.destroy();
			throw new Error(`librist could not start receiving on ${this.url}.`);
		}
	}

	/**
	 * Reads until a payload arrives, the silence deadline passes, or the stream is cancelled. Returns
	 * null when the stream should end.
	 */
	async read(): Promise<Uint8Array | null> {
		const deadline = Date.now() + this.options.readTimeout * 1000;

		while (!this.cancelled && Date.now() < deadline) {
			const slice = this.readSlice();
			this.pendingSlice = slice;

			let payload: Uint8Array | null;
			try {
				payload = await slice;
			} finally {
				this.pendingSlice = null;
			}

			if (this.cancelled) {
				return null;
			}
			if (payload) {
				return payload;
			}
		}

		return null;
	}

	/** One librist read and everything it does with the block, so a canceller can await the whole of it. */
	private async readSlice(): Promise<Uint8Array | null> {
		const blockOut: unknown[] = [null];
		const remaining = await this.librist.receiverReadAsync(this.ctx, blockOut, READ_SLICE_MS);

		if (this.cancelled) {
			if (blockOut[0]) {
				this.librist.dataBlockFree(blockOut);
			}
			return null;
		}

		if (remaining > 0 && blockOut[0]) {
			const payload = this.librist.payloadOf(blockOut[0]);
			this.librist.dataBlockFree(blockOut);
			return payload;
		}

		return null;
	}

	sendTunnelPacket(data: Uint8Array) {
		if (!this.options.tunnel) {
			throw new Error('The tunnel is not enabled; pass `tunnel: true`.');
		}
		if (!this.librist.oobWrite(this.ctx, this.peerHandle, data)) {
			throw new Error('librist dropped the tunnel packet.');
		}
	}

	readTunnelPacket() {
		if (!this.options.tunnel) {
			throw new Error('The tunnel is not enabled; pass `tunnel: true`.');
		}
		return this.librist.oobRead(this.ctx);
	}

	async cancel() {
		this.cancelled = true;

		// `rist_receiver_data_read2` parks on the receiver's own condition variable, on a koffi threadpool
		// thread. Destroying while one is parked frees that cond under the waiter, and the thread wakes into
		// freed memory - a SIGSEGV in `_pthread_cond_updateval`, found in a crash report, not by a test.
		// The wait is bounded by READ_SLICE_MS, which is why reads are sliced in the first place.
		await this.pendingSlice?.catch(() => {});
		this.destroy();
	}

	private destroy() {
		if (this.ctx) {
			this.librist.destroy(this.ctx);
			this.ctx = null;
		}
	}
}

const openStream = (url: string, options: Resolved) => {
	const reader = new RistReader(url, options);

	return { reader, stream: new ReadableStream<Uint8Array>({
		start: () => reader.start(),
		pull: async (controller) => {
			const payload = await reader.read();
			if (payload === null) {
				await reader.cancel();
				controller.close();
				return;
			}
			controller.enqueue(payload);
		},
		cancel: () => reader.cancel(),
	}) };
};

/**
 * A source that reads a RIST stream using librist.
 *
 * librist owns the de-jitter buffer, the NACKs and the reordering, so {@link RistSourceOptions.bufferMs}
 * is the only recovery knob: the retransmission timing inside that window is librist's.
 *
 * Requires librist on the system (`brew install librist`, `apt install librist4`), or
 * `MEDIABUNNY_LIBRIST` pointing at it.
 *
 * @group \@mediabunny/rist
 * @public
 */
export class RistSource extends ReadableStreamSource {
	/** @internal */
	private reader: RistReader;

	constructor(url: string, options: RistSourceOptions = {}) {
		checkPeerOptions(url, options);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.mode !== undefined && !['listener', 'caller'].includes(options.mode)) {
			throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
		}
		if (options.profile !== undefined && !['simple', 'main'].includes(options.profile)) {
			throw new TypeError('options.profile, when provided, must be \'simple\' or \'main\'.');
		}
		if (options.aesType !== undefined && ![128, 256].includes(options.aesType)) {
			throw new TypeError('options.aesType, when provided, must be 128 or 256.');
		}
		if (options.secret !== undefined && typeof options.secret !== 'string') {
			throw new TypeError('options.secret, when provided, must be a string.');
		}

		const resolved: Resolved = {
			listener: (options.mode ?? 'listener') === 'listener',
			profile: options.profile ?? 'main',
			bufferMs: positive(options.bufferMs, 'bufferMs', DEFAULT_BUFFER_MS),
			readTimeout: positive(options.readTimeout, 'readTimeout', DEFAULT_READ_TIMEOUT),
			secret: options.secret,
			aesType: options.aesType,
			tunnel: options.tunnel ?? false,
		};

		const { reader, stream } = openStream(url, resolved);
		super(stream, { maxCacheSize: options.maxCacheSize });
		this.reader = reader;
	}

	/**
	 * Sends one packet up the GRE tunnel to the sender. Requires {@link RistSourceOptions.tunnel}.
	 *
	 * @throws when the tunnel is not enabled, or librist has no peer to send it to.
	 */
	sendTunnelPacket(data: Uint8Array) {
		this.reader.sendTunnelPacket(data);
	}

	/**
	 * Takes the next packet the sender put in the tunnel, or null when none is waiting. librist queues
	 * them, so this polls rather than blocks.
	 */
	readTunnelPacket() {
		return this.reader.readTunnelPacket();
	}
}
