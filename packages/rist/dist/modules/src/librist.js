"use strict";
/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLibrist = void 0;
// The librist binding. Verified against librist v0.2.20's own headers, whose `rist_peer_config` is at
// RIST_PEER_CONFIG_VERSION 6 — so configuration goes through `rist_parse_address2`, which hands librist
// a `rist://` URL and lets it allocate and fill that struct itself. Nothing here lays out a peer config
// field by field: the struct has grown four times across librist versions, and a layout written against
// one header silently corrupts the next.
//
// Two structs are unavoidable. `rist_data_block` is the data plane, and its layout is stable and checked
// at load (72 bytes on LP64). `rist_logging_settings` is passed only as an opaque pointer librist fills.
const koffi_1 = __importDefault(require("koffi"));
/**
 * Where to look for librist, in order: the `MEDIABUNNY_LIBRIST` override, then the platform's own
 * loader path (a system install, or one an `LD_LIBRARY_PATH` names), then the usual install prefixes.
 * The bare name comes first so a correctly installed library is found without this list being right.
 */
const candidatePaths = () => {
    const override = process.env['MEDIABUNNY_LIBRIST'];
    const byPlatform = {
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
let loaded = null;
let loadError = null;
/**
 * Loads librist once per process and declares the surface this package uses.
 *
 * @internal
 *
 * @throws when no librist can be loaded, naming every path tried — a missing library and a library too
 * old to carry a symbol are different failures and the message says which.
 */
const getLibrist = () => {
    if (loaded) {
        return loaded;
    }
    if (loadError) {
        throw loadError;
    }
    const tried = [];
    let lib = null;
    let path = '';
    for (const candidate of candidatePaths()) {
        try {
            lib = koffi_1.default.load(candidate);
            path = candidate;
            break;
        }
        catch (error) {
            tried.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!lib) {
        loadError = new Error('librist could not be loaded. Install it (apt install librist4 / brew install librist) or set '
            + `MEDIABUNNY_LIBRIST to its path. Tried:\n  ${tried.join('\n  ')}`);
        throw loadError;
    }
    const declare = (signature) => lib.func(signature);
    const dataBlock = koffi_1.default.struct('rist_data_block', {
        payload: koffi_1.default.pointer(koffi_1.default.types.void),
        payload_len: koffi_1.default.types.size_t,
        ts_ntp: koffi_1.default.types.uint64_t,
        virt_src_port: koffi_1.default.types.uint16_t,
        virt_dst_port: koffi_1.default.types.uint16_t,
        peer: koffi_1.default.pointer(koffi_1.default.types.void),
        flow_id: koffi_1.default.types.uint32_t,
        seq: koffi_1.default.types.uint64_t,
        flags: koffi_1.default.types.uint32_t,
        ref: koffi_1.default.pointer(koffi_1.default.types.void),
    });
    // A mismatch here means the header this was written against is not the one the library was built
    // from, and every field read after it would be silently wrong
    const expectedSize = 72;
    const actualSize = koffi_1.default.sizeof(dataBlock);
    if (actualSize !== expectedSize && koffi_1.default.sizeof(koffi_1.default.pointer(koffi_1.default.types.void)) === 8) {
        loadError = new Error(`librist at ${path} has a rist_data_block of ${actualSize} bytes; this binding expects `
            + `${expectedSize}. The library is a version this package does not know.`);
        throw loadError;
    }
    // Only the two fields the read path uses. Decoding the whole block costs four times as much and
    // allocates two BigInts per packet for fields nothing reads; the same trick is used for `rist_stats`.
    const dataBlockHead = koffi_1.default.struct('rist_data_block_head', {
        payload: koffi_1.default.pointer(koffi_1.default.types.void),
        payload_len: koffi_1.default.types.size_t,
    });
    const senderCreate = declare('int rist_sender_create(_Out_ void **ctx, int profile, uint32_t flow_id, void *logging)');
    const receiverCreate = declare('int rist_receiver_create(_Out_ void **ctx, int profile, void *logging)');
    const parseAddress = declare('int rist_parse_address2(const char *url, _Inout_ void **peer_config)');
    const peerConfigFree = declare('int rist_peer_config_free2(_Inout_ void **peer_config)');
    const peerCreate = declare('int rist_peer_create(void *ctx, _Out_ void **peer, const void *config)');
    const start = declare('int rist_start(void *ctx)');
    const destroy = declare('int rist_destroy(void *ctx)');
    const senderWrite = declare('int rist_sender_data_write(void *ctx, const rist_data_block *block)');
    const receiverRead = declare('int rist_receiver_data_read2(void *ctx, _Out_ rist_data_block **block, int timeout)');
    const dataBlockFree = declare('void rist_receiver_data_block_free2(_Inout_ rist_data_block **block)');
    // Only the prefix of `rist_stats` is declared, which is all that is read through a pointer: a
    // uint32 then a pointer, so the JSON lands at offset 8 either way. Declaring the field as `str`
    // is what converts it - `koffi.decode(pointer, 'str')` on the raw `char *` segfaults.
    const stats = koffi_1.default.struct('rist_stats', {
        json_size: koffi_1.default.types.uint32_t,
        stats_json: koffi_1.default.types.str,
    });
    const statsCallbackProto = koffi_1.default.proto('int rist_stats_cb(void *arg, void *stats)');
    const statsCallbackSet = declare('int rist_stats_callback_set(void *ctx, int interval, rist_stats_cb *cb, void *arg)');
    const statsFree = declare('int rist_stats_free(const void *stats)');
    // Main-profile GRE tunnel. Both return codes are documented wrongly in oob.h and are taken from
    // librist's own source instead: `rist_oob_write` returns 0 on SUCCESS (it forwards
    // `rist_oob_enqueue`, which does), and 0 ALSO means "no oob peer, dropped" when no peer is given,
    // which is why the peer is required here. `rist_oob_read` forwards `rist_oob_dequeue_rx`, which
    // returns >=1 when it hands over a packet and 0 when the queue is empty.
    const oobBlock = koffi_1.default.struct('rist_oob_block', {
        peer: koffi_1.default.pointer(koffi_1.default.types.void),
        payload: koffi_1.default.pointer(koffi_1.default.types.void),
        payload_len: koffi_1.default.types.size_t,
        ts_ntp: koffi_1.default.types.uint64_t,
    });
    const oobCallbackSet = declare('int rist_oob_callback_set(void *ctx, void *callback_func, void *arg)');
    const oobWrite = declare('int rist_oob_write(void *ctx, const rist_oob_block *oob_block)');
    const oobRead = declare('int rist_oob_read(void *ctx, _Out_ rist_oob_block **oob_block)');
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
        receiverReadAsync: (ctx, out, timeoutMs) => new Promise((resolve, reject) => {
            receiverRead.async(ctx, out, timeoutMs, (error, result) => {
                if (error) {
                    reject(error);
                }
                else {
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
            const out = [null];
            if (oobRead(ctx, out) < 1 || !out[0]) {
                return null;
            }
            const block = koffi_1.default.decode(out[0], oobBlock);
            // librist owns the buffer until the next read, and `koffi.decode` copies
            return koffi_1.default.decode(block.payload, koffi_1.default.types.uint8_t, block.payload_len);
        },
        payloadOf: (pointer) => {
            const head = koffi_1.default.decode(pointer, dataBlockHead);
            // Copies: a `koffi.decode` of a buffer returns JS-owned memory, verified by mutating and
            // freeing the C buffer underneath it, so the result outlives `dataBlockFree`
            return koffi_1.default.decode(head.payload, koffi_1.default.types.uint8_t, head.payload_len);
        },
        statsCallbackSet: (ctx, intervalMs, onStats) => {
            const callback = koffi_1.default.register((_arg, pointer) => {
                try {
                    onStats(koffi_1.default.decode(pointer, stats).stats_json);
                }
                finally {
                    // Mandatory: librist's `src/stats.c` frees the container itself only when no callback
                    // is registered, so not freeing here leaks the JSON, the peers array and the
                    // container once per interval
                    statsFree(pointer);
                }
                return 0;
            }, koffi_1.default.pointer(statsCallbackProto));
            if (statsCallbackSet(ctx, intervalMs, callback, null) !== 0) {
                koffi_1.default.unregister(callback);
                throw new Error('librist refused the stats callback.');
            }
            return () => {
                // Cleared before the slot is released, so librist cannot call into a freed callback
                statsCallbackSet(ctx, intervalMs, null, null);
                koffi_1.default.unregister(callback);
            };
        },
    };
    return loaded;
};
exports.getLibrist = getLibrist;
