/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { ReadableStreamSource } from 'mediabunny';
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
export declare class RistSource extends ReadableStreamSource {
    constructor(url: string, options?: RistSourceOptions);
    /**
     * Sends one packet up the GRE tunnel to the sender. Requires {@link RistSourceOptions.tunnel}.
     *
     * @throws when the tunnel is not enabled, or librist has no peer to send it to.
     */
    sendTunnelPacket(data: Uint8Array): void;
    /**
     * Takes the next packet the sender put in the tunnel, or null when none is waiting. librist queues
     * them, so this polls rather than blocks.
     */
    readTunnelPacket(): Uint8Array<ArrayBufferLike> | null;
}
//# sourceMappingURL=rist-source.d.ts.map