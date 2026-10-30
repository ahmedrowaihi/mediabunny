/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The librist binding. Verified against librist v0.2.20's own headers, whose `rist_peer_config` is at
// RIST_PEER_CONFIG_VERSION 6 — so configuration goes through `rist_parse_address2`, which hands librist
// a `rist://` URL and lets it allocate and fill that struct itself. Nothing here lays out a peer config
// field by field: the struct has grown four times across librist versions, and a layout written against
// one header silently corrupts the next.
//
// Two structs are unavoidable. `rist_data_block` is the data plane, and its layout is stable and checked
// at load (72 bytes on LP64). `rist_logging_settings` is passed only as an opaque pointer librist fills.

import koffi from 'koffi';

/** 13818-1 would call these the wire formats; RIST calls them profiles. Both ends must agree. */
/** @internal */
export const enum RistProfile {
	SIMPLE = 0,
	MAIN = 1,
	ADVANCED = 2,
}

/**
 * A koffi function handle. koffi declares symbols from a C signature string, so what it hands back is
 * untyped by construction; each symbol is given the shape it is actually called by, including the
 * `async` form that runs the call on a worker thread.
 */
type Fn<A extends unknown[], R> = ((...args: A) => R) & {
	async: (...args: [...A, (error: Error | null, result: R) => void]) => void;
};

/**
 * Where to look for librist, in order: the `MEDIABUNNY_LIBRIST` override, then the platform's own
 * loader path (a system install, or one an `LD_LIBRARY_PATH` names), then the usual install prefixes.
 * The bare name comes first so a correctly installed library is found without this list being right.
 */
const candidatePaths = (): string[] => {
	const override = process.env['MEDIABUNNY_LIBRIST'];
	const byPlatform: Record<string, string[]> = {
		darwin: [
			'librist.dylib',
			'/opt/homebrew/lib/librist.dylib',
			'/usr/local/lib/librist.dylib',
		],
		linux: [
			'librist.so.4',
			'librist.so',
			'/usr/lib/x86_64-linux-gnu/librist.so.4',
			'/usr/lib/aarch64-linux-gnu/librist.so.4',
			'/usr/local/lib/librist.so.4',
		],
		win32: ['rist.dll', 'librist.dll'],
	};

	return [...(override ? [override] : []), ...(byPlatform[process.platform] ?? ['librist.so'])];
};

/** @internal */
export type Librist = {
	/** The path the library was loaded from, which is what a failure to interoperate starts at. */
	readonly path: string;
	senderCreate: (out: unknown[], profile: RistProfile, flowId: number, logging: unknown) => number;
	receiverCreate: (out: unknown[], profile: RistProfile, logging: unknown) => number;
	parseAddress: (url: string, out: unknown[]) => number;
	peerConfigFree: (out: unknown[]) => number;
	peerCreate: (ctx: unknown, out: unknown[], config: unknown) => number;
	start: (ctx: unknown) => number;
	destroy: (ctx: unknown) => number;
	senderWrite: (ctx: unknown, payload: Uint8Array) => number;
	receiverReadAsync: (ctx: unknown, out: unknown[], timeoutMs: number) => Promise<number>;
	dataBlockFree: (out: unknown[]) => void;
	/** Copies one received payload out of librist's buffer, by the block pointer `receiverReadAsync` filled. */
	payloadOf: (pointer: unknown) => Uint8Array;
	/**
	 * Registers a stats callback, returning the function that unregisters it. The callback is the only
	 * way to read librist's own counters, retransmissions among them.
	 *
	 * Keep `intervalMs` coarse. koffi services a value-returning callback on the main loop and blocks
	 * the calling thread until it does, and librist raises stats while holding its `stats_lock`, so a
	 * busy loop stalls librist's stats thread with that lock held.
	 */
	statsCallbackSet: (ctx: unknown, intervalMs: number, onStats: (json: string) => void) => () => void;
	/** Enables the main-profile GRE tunnel. Refused on simple profile, which has no GRE layer. */
	oobEnable: (ctx: unknown) => number;
	/** True when the packet was queued. The peer is required; without one librist drops it. */
	oobWrite: (ctx: unknown, peer: unknown, payload: Uint8Array) => boolean;
	/** The next tunnel packet, or null when the queue is empty. */
	oobRead: (ctx: unknown) => Uint8Array | null;
};

let loaded: Librist | null = null;
let loadError: Error | null = null;

/**
 * Loads librist once per process and declares the surface this package uses.
 *
 * @internal
 *
 * @throws when no librist can be loaded, naming every path tried — a missing library and a library too
 * old to carry a symbol are different failures and the message says which.
 */
export const getLibrist = (): Librist => {
	if (loaded) {
		return loaded;
	}
	if (loadError) {
		throw loadError;
	}

	const tried: string[] = [];
	let lib: ReturnType<typeof koffi.load> | null = null;
	let path = '';

	for (const candidate of candidatePaths()) {
		try {
			lib = koffi.load(candidate);
			path = candidate;
			break;
		} catch (error) {
			tried.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (!lib) {
		loadError = new Error(
			'librist could not be loaded. Install it (apt install librist4 / brew install librist) or set '
			+ `MEDIABUNNY_LIBRIST to its path. Tried:\n  ${tried.join('\n  ')}`,
		);
		throw loadError;
	}

	const declare = <T>(signature: string): T => lib.func(signature) as T;

	const dataBlock = koffi.struct('rist_data_block', {
		payload: koffi.pointer(koffi.types.void),
		payload_len: koffi.types.size_t,
		ts_ntp: koffi.types.uint64_t,
		virt_src_port: koffi.types.uint16_t,
		virt_dst_port: koffi.types.uint16_t,
		peer: koffi.pointer(koffi.types.void),
		flow_id: koffi.types.uint32_t,
		seq: koffi.types.uint64_t,
		flags: koffi.types.uint32_t,
		ref: koffi.pointer(koffi.types.void),
	});

	// A mismatch here means the header this was written against is not the one the library was built
	// from, and every field read after it would be silently wrong
	const expectedSize = 72;
	const actualSize = koffi.sizeof(dataBlock);
	if (actualSize !== expectedSize && koffi.sizeof(koffi.pointer(koffi.types.void)) === 8) {
		loadError = new Error(
			`librist at ${path} has a rist_data_block of ${actualSize} bytes; this binding expects `
			+ `${expectedSize}. The library is a version this package does not know.`,
		);
		throw loadError;
	}

	// Only the two fields the read path uses. Decoding the whole block costs four times as much and
	// allocates two BigInts per packet for fields nothing reads; the same trick is used for `rist_stats`.
	const dataBlockHead = koffi.struct('rist_data_block_head', {
		payload: koffi.pointer(koffi.types.void),
		payload_len: koffi.types.size_t,
	});

	const senderCreate = declare<Fn<[unknown[], number, number, unknown], number>>(
		'int rist_sender_create(_Out_ void **ctx, int profile, uint32_t flow_id, void *logging)',
	);
	const receiverCreate = declare<Fn<[unknown[], number, unknown], number>>(
		'int rist_receiver_create(_Out_ void **ctx, int profile, void *logging)',
	);
	const parseAddress = declare<Fn<[string, unknown[]], number>>(
		'int rist_parse_address2(const char *url, _Inout_ void **peer_config)',
	);
	const peerConfigFree = declare<Fn<[unknown[]], number>>(
		'int rist_peer_config_free2(_Inout_ void **peer_config)',
	);
	const peerCreate = declare<Fn<[unknown, unknown[], unknown], number>>(
		'int rist_peer_create(void *ctx, _Out_ void **peer, const void *config)',
	);
	const start = declare<Fn<[unknown], number>>('int rist_start(void *ctx)');
	const destroy = declare<Fn<[unknown], number>>('int rist_destroy(void *ctx)');
	const senderWrite = declare<Fn<[unknown, Record<string, unknown>], number>>(
		'int rist_sender_data_write(void *ctx, const rist_data_block *block)',
	);
	const receiverRead = declare<Fn<[unknown, unknown[], number], number>>(
		'int rist_receiver_data_read2(void *ctx, _Out_ rist_data_block **block, int timeout)',
	);
	const dataBlockFree = declare<Fn<[unknown[]], void>>(
		'void rist_receiver_data_block_free2(_Inout_ rist_data_block **block)',
	);

	// Only the prefix of `rist_stats` is declared, which is all that is read through a pointer: a
	// uint32 then a pointer, so the JSON lands at offset 8 either way. Declaring the field as `str`
	// is what converts it - `koffi.decode(pointer, 'str')` on the raw `char *` segfaults.
	const stats = koffi.struct('rist_stats', {
		json_size: koffi.types.uint32_t,
		stats_json: koffi.types.str,
	});
	const statsCallbackProto = koffi.proto('int rist_stats_cb(void *arg, void *stats)');
	const statsCallbackSet = declare<Fn<[unknown, number, unknown, unknown], number>>(
		'int rist_stats_callback_set(void *ctx, int interval, rist_stats_cb *cb, void *arg)',
	);
	const statsFree = declare<Fn<[unknown], number>>('int rist_stats_free(const void *stats)');

	// Main-profile GRE tunnel. Both return codes are documented wrongly in oob.h and are taken from
	// librist's own source instead: `rist_oob_write` returns 0 on SUCCESS (it forwards
	// `rist_oob_enqueue`, which does), and 0 ALSO means "no oob peer, dropped" when no peer is given,
	// which is why the peer is required here. `rist_oob_read` forwards `rist_oob_dequeue_rx`, which
	// returns >=1 when it hands over a packet and 0 when the queue is empty.
	const oobBlock = koffi.struct('rist_oob_block', {
		peer: koffi.pointer(koffi.types.void),
		payload: koffi.pointer(koffi.types.void),
		payload_len: koffi.types.size_t,
		ts_ntp: koffi.types.uint64_t,
	});
	const oobCallbackSet = declare<Fn<[unknown, unknown, unknown], number>>(
		'int rist_oob_callback_set(void *ctx, void *callback_func, void *arg)',
	);
	const oobWrite = declare<Fn<[unknown, unknown], number>>(
		'int rist_oob_write(void *ctx, const rist_oob_block *oob_block)',
	);
	const oobRead = declare<Fn<[unknown, unknown[]], number>>(
		'int rist_oob_read(void *ctx, _Out_ rist_oob_block **oob_block)',
	);

	loaded = {
		path,
		senderCreate: (out, profile, flowId, logging) => senderCreate(out, profile, flowId, logging),
		receiverCreate: (out, profile, logging) => receiverCreate(out, profile, logging),
		parseAddress: (url, out) => parseAddress(url, out),
		peerConfigFree: out => peerConfigFree(out),
		peerCreate: (ctx, out, config) => peerCreate(ctx, out, config),
		start: ctx => start(ctx),
		destroy: ctx => destroy(ctx),
		senderWrite: (ctx, payload) => senderWrite(ctx, {
			payload,
			payload_len: payload.byteLength,
			ts_ntp: 0n,
			virt_src_port: 0,
			virt_dst_port: 0,
			peer: null,
			flow_id: 0,
			seq: 0n,
			flags: 0,
			ref: null,
		}),
		// Async, because the read blocks for its whole timeout and a sync call would hold the event loop
		receiverReadAsync: (ctx, out, timeoutMs) => new Promise<number>((resolve, reject) => {
			receiverRead.async(ctx, out, timeoutMs, (error: Error | null, result: number) => {
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			});
		}),
		dataBlockFree: out => dataBlockFree(out),
		oobEnable: ctx => oobCallbackSet(ctx, null, null),
		oobWrite: (ctx, peer, payload) => oobWrite(ctx, {
			peer,
			payload,
			payload_len: payload.byteLength,
			ts_ntp: 0n,
		}) === 0,
		oobRead: (ctx) => {
			const out: unknown[] = [null];
			if (oobRead(ctx, out) < 1 || !out[0]) {
				return null;
			}
			const block = koffi.decode(out[0], oobBlock) as { payload: unknown; payload_len: number };
			// librist owns the buffer until the next read, and `koffi.decode` copies
			return koffi.decode(block.payload, koffi.types.uint8_t, block.payload_len) as Uint8Array;
		},
		payloadOf: (pointer) => {
			const head = koffi.decode(pointer, dataBlockHead) as { payload: unknown; payload_len: number };
			// Copies: a `koffi.decode` of a buffer returns JS-owned memory, verified by mutating and
			// freeing the C buffer underneath it, so the result outlives `dataBlockFree`
			return koffi.decode(head.payload, koffi.types.uint8_t, head.payload_len) as Uint8Array;
		},
		statsCallbackSet: (ctx, intervalMs, onStats) => {
			const callback = koffi.register((_arg: unknown, pointer: unknown) => {
				try {
					onStats((koffi.decode(pointer, stats) as { stats_json: string }).stats_json);
				} finally {
					// Mandatory: librist's `src/stats.c` frees the container itself only when no callback
					// is registered, so not freeing here leaks the JSON, the peers array and the
					// container once per interval
					statsFree(pointer);
				}
				return 0;
			}, koffi.pointer(statsCallbackProto));

			if (statsCallbackSet(ctx, intervalMs, callback, null) !== 0) {
				koffi.unregister(callback);
				throw new Error('librist refused the stats callback.');
			}

			return () => {
				// Cleared before the slot is released, so librist cannot call into a freed callback
				statsCallbackSet(ctx, intervalMs, null, null);
				koffi.unregister(callback);
			};
		},
	};

	return loaded;
};
