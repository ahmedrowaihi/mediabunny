/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AppendOnlyStreamTarget } from 'mediabunny';
/**
 * Options for {@link RistTarget}.
 *
 * @group \@mediabunny/rist
 * @public
 */
export type RistTargetOptions = {
    /**
     * Whether to send to a receiver that is listening (`'caller'`, the default) or to bind the URL's
     * ports and wait for one to announce itself (`'listener'`).
     */
    mode?: 'listener' | 'caller';
    /**
     * Which RIST profile to speak. Defaults to `'main'`, which is also what librist's own `ristsender`
     * and `ristreceiver` default to.
     *
     * **Both ends must agree.** A simple-profile sender against a main-profile receiver does not fail
     * loudly — the receiver logs `Non conformant main profile packet received` and delivers nothing.
     *
     * Encryption needs main profile: `'simple'` accepts a secret and does not enforce it, so passing
     * one with `'simple'` throws rather than appearing to protect the stream.
     */
    profile?: 'simple' | 'main';
    /**
     * **Milliseconds** of sent packets librist keeps for retransmission. Defaults to 1000.
     */
    retransmitBufferMs?: number;
    /**
     * Pre-shared passphrase for main-profile encryption. Without it the stream is sent in the clear,
     * which a receiver reports as `Encryption is disabled for this peer`.
     */
    secret?: string;
    /** AES key length to use with {@link RistTargetOptions.secret}. Defaults to 256. */
    aesType?: 128 | 256;
    /**
     * **Kilobits per second** librist may use, retransmissions included. Left unset, librist paces
     * itself from its own congestion control.
     *
     * This is librist's rate control, not pacing from the stream's own PCR — that is what
     * `@mediabunny/server`'s `RistTarget` does, and the two produce different inter-packet timing for
     * the same input. Bytes librist declines to send under this cap are counted by
     * {@link RistTarget.skippedPackets}.
     */
    bandwidthKbps?: number;
    /** How often librist's counters are read, in **milliseconds**. Defaults to 1000. */
    statsIntervalMs?: number;
    /**
     * Enables the main-profile GRE tunnel, which carries arbitrary packets alongside the media. Off by
     * default, and refused on simple profile, which has no GRE layer for them.
     *
     * The channel is bidirectional: both ends send with `sendTunnelPacket` and read with
     * `readTunnelPacket`.
     */
    tunnel?: boolean;
};
/**
 * A target that sends the output over RIST using librist.
 *
 * librist owns the wire — sequencing, the retransmit buffer, the handshake, encryption and rate
 * control — so this target has no send queue of its own and no queue-bound options. What librist
 * declines to send is reported by {@link RistTarget.skippedPackets} rather than dropped here.
 *
 * Requires librist on the system (`brew install librist`, `apt install librist4`), or
 * `MEDIABUNNY_LIBRIST` pointing at it.
 *
 * {@link RistTarget.sentPackets} and {@link RistTarget.sentBytes} are counted here, at hand-over to
 * librist. The rest come from librist's own stats, so they lag by up to
 * {@link RistTargetOptions.statsIntervalMs}, and the interval still in progress when the target closes
 * is never reported — a retransmission count read right after close is an undercount.
 *
 * @group \@mediabunny/rist
 * @public
 */
export declare class RistTarget extends AppendOnlyStreamTarget {
    constructor(url: string, options?: RistTargetOptions);
    /** Payloads handed to librist. Not what left the wire — librist may retransmit or skip. */
    get sentPackets(): number;
    /** Payload bytes handed to librist, not counting retransmissions. */
    get sentBytes(): number;
    /** Packets librist sent again because a receiver asked for them. */
    get retransmittedPackets(): number;
    /** Bytes librist sent again because a receiver asked for them. */
    get retransmittedBytes(): number;
    /**
     * Packets librist declined to send — over the bandwidth cap, over its own buffer bloat limit, or a
     * retransmission it would not make. This is the closest thing to a drop count, and it is librist's
     * decision rather than this target's.
     */
    get skippedPackets(): number;
    /**
     * Sends one packet down the GRE tunnel, alongside the media. Requires
     * {@link RistTargetOptions.tunnel}.
     *
     * @throws when the tunnel is not enabled, or librist has no peer to send it to.
     */
    sendTunnelPacket(data: Uint8Array): void;
    /**
     * Takes the next packet the peer sent down the tunnel, or null when none is waiting. librist queues
     * them, so this polls rather than blocks.
     */
    readTunnelPacket(): Uint8Array<ArrayBufferLike> | null;
    /** The path librist was loaded from, which is where a failure to interoperate starts. */
    get libristPath(): string;
}
//# sourceMappingURL=rist-target.d.ts.map