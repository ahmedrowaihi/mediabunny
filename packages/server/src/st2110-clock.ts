/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// ST 2110's RTP timestamps are not a counter. They are samples of one reference clock shared by every
// sender on the network, which is what lets a receiver line up video, audio and ancillary that arrived
// from three different machines. A sender whose timestamps start at zero and count up produces a
// stream that plays on its own and cannot be combined with anything.
//
// A JavaScript process cannot talk to a PTP daemon or read a hardware clock. What it can do is use the
// system clock - which `ptp4l` plus `phc2sys` discipline to the PTP grandmaster, and which is how most
// software senders get their time - and be honest about whether that has been done.

/** The media clock's epoch: 1970-01-01T00:00:00 TAI, which is where PTP counts from. */
const PTP_EPOCH_UTC_SECONDS = 0;

/**
 * TAI − UTC as of 2017-01-01, the last leap second at the time of writing.
 *
 * Stated as a default rather than read, because nothing in Node exposes it: the kernel knows it
 * (`ntp_adjtime` reports it on Linux) and a JavaScript process does not. It changes only when a leap
 * second is declared, and a sender whose streams must interoperate after that happens has to state the
 * new value.
 *
 * @group \@mediabunny/server
 * @public
 */
export const DEFAULT_TAI_OFFSET_SECONDS = 37;

/**
 * Where a stream's RTP timestamps come from.
 *
 * @group \@mediabunny/server
 * @public
 */
export type St2110ClockOptions = {
	/**
	 * The PTP grandmaster this host's clock is disciplined to, as `<clock-identity>:<domain>` — for
	 * example `39-A7-94-FF-FE-07-CB-D0:0`.
	 *
	 * **Stating it means the clock is locked**, not merely that it should be. The SDP declares
	 * `ts-refclk:ptp=` and the RTP timestamps are taken from the system clock against the PTP epoch,
	 * so two senders stating the same grandmaster agree on what time a frame was sampled at. Leaving
	 * it out declares `ts-refclk:localmac=` and timestamps the stream from its own start, which is a
	 * stream that plays alone and lines up with nothing.
	 */
	ptpGrandmaster?: string;
	/**
	 * TAI − UTC in seconds. Defaults to {@link DEFAULT_TAI_OFFSET_SECONDS}.
	 *
	 * Only matters when a grandmaster is stated. A wrong value shifts every timestamp by the
	 * difference, which lines a stream up with nothing else on the network — and does so without
	 * looking wrong anywhere, since the stream is internally consistent.
	 */
	taiOffsetSeconds?: number;
};

/** @internal */
export const validateClockOptions = (options: St2110ClockOptions) => {
	if (options.ptpGrandmaster !== undefined && typeof options.ptpGrandmaster !== 'string') {
		throw new TypeError('options.ptpGrandmaster, when provided, must be a string.');
	}
	if (
		options.taiOffsetSeconds !== undefined
		&& (!Number.isFinite(options.taiOffsetSeconds) || !Number.isInteger(options.taiOffsetSeconds))
	) {
		throw new TypeError('options.taiOffsetSeconds, when provided, must be an integer.');
	}
};

/**
 * The RTP timestamp a media clock of `rate` ticks per second shows at a given UTC instant.
 *
 * The media clock counts from the PTP epoch in **TAI**, so the UTC seconds are shifted by the
 * TAI − UTC offset first. The result wraps at 2^32, as an RTP timestamp field does.
 *
 * @group \@mediabunny/server
 * @public
 */
export const rtpTimestampAt = (
	utcSeconds: number,
	rate: number,
	taiOffsetSeconds = DEFAULT_TAI_OFFSET_SECONDS,
): number => {
	if (!Number.isFinite(utcSeconds)) {
		throw new TypeError('utcSeconds must be a finite number.');
	}
	if (!Number.isFinite(rate) || rate <= 0) {
		throw new TypeError('rate must be a positive number.');
	}

	const taiSeconds = utcSeconds - PTP_EPOCH_UTC_SECONDS + taiOffsetSeconds;
	// A 90 kHz counter passes 2^32 every thirteen hours, so wrapping is the ordinary case rather than
	// an edge one. `>>> 0` would do the same thing - ToUint32 is this modulo - but says it by way of a
	// bitwise operator on a value far outside 32 bits, which reads like a bug.
	const ticks = Math.floor(taiSeconds * rate);
	const wrapped = ticks % 0x1_0000_0000;
	return wrapped < 0 ? wrapped + 0x1_0000_0000 : wrapped;
};

/**
 * Reads the system clock as UTC seconds, with sub-millisecond resolution where the host offers it.
 *
 * `Date.now()` is whole milliseconds; `performance.timeOrigin` plus `performance.now()` is the same
 * clock sampled finely, which matters because a 90 kHz tick is 11 µs.
 *
 * @internal
 */
export const utcSecondsNow = () => (performance.timeOrigin + performance.now()) / 1000;

/**
 * A stream's clock: what its SDP declares, and where its timestamps come from.
 *
 * @internal
 */
export class St2110Clock {
	readonly lockedToPtp: boolean;
	private readonly taiOffsetSeconds: number;

	constructor(options: St2110ClockOptions = {}) {
		validateClockOptions(options);
		this.lockedToPtp = options.ptpGrandmaster !== undefined && options.ptpGrandmaster !== '';
		this.taiOffsetSeconds = options.taiOffsetSeconds ?? DEFAULT_TAI_OFFSET_SECONDS;
	}

	/**
	 * The timestamp to send now, or `null` when this stream has no shared clock to read - in which
	 * case the caller counts from its own start, which is all an unlocked sender can honestly do.
	 */
	now(rate: number): number | null {
		return this.lockedToPtp ? rtpTimestampAt(utcSecondsNow(), rate, this.taiOffsetSeconds) : null;
	}
}
