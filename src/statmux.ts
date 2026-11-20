/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Statistical multiplexing shares one transport's bitrate between several programs, giving more of it
// to whichever program's content is currently harder. The part that makes it work is counter-intuitive:
// it is **not** done by handing each program a bitrate.
//
// An encoder told to hit a bitrate hits it, whatever it is encoding. Every program then reports exactly
// the rate it was given, which says nothing about how much it actually needed, and the loop has no
// signal to act on. So the control variable here is *quality* - one quantizer, shared - and the split
// falls out on its own: at equal quality, harder content simply produces more bits. What the pool then
// decides is the common quality, raised until the programs together fit.
//
// Per-program floors and ceilings sit on top as corrections to that shared quantizer, which is also how
// a broadcast statmux is configured: a pool, and min/max per service.

import { VideoCodec } from './codec';
import { buildQuantizerEncodeOptions, VIDEO_CODEC_QUANTIZER_SUPPORT } from './encode';
import { assert, clamp, isArray } from './misc';

/**
 * How many quantizer steps halve or double the bitrate on a 0-51 scale. Six is the figure H.264 rate
 * control is built on - its quantizer step is 2^(1/6) - and it holds closely enough for HEVC. A codec
 * with a wider scale is scaled by its range rather than given a figure of its own.
 */
const STEPS_PER_DOUBLING_AT_51 = 6;

/** Most the shared quantizer may move in one interval, in doublings, so the loop settles rather than rings. */
const MAX_STEP_IN_DOUBLINGS = 0.5;

/**
 * One program of the multiplex.
 *
 * @public
 * @group Encoding
 */
export type StatMuxProgram = {
	/**
	 * Fewest bits per second this program may be squeezed to. The multiplex will not starve it below
	 * this even when every other program is struggling; the sum of these must fit in the pool.
	 *
	 * It is a claim on the pool rather than a promise the encoder will fill it: a programme whose
	 * content has little in it produces few bits at any quantizer, and no amount of quality will make
	 * it spend its floor. What the floor buys is that the capacity is not given away to someone else.
	 */
	minBitrate: number;
	/** Most bits per second it may be given, however easy the rest of the multiplex has it. */
	maxBitrate: number;
	/**
	 * What this program's quality is worth relative to the others, defaulting to 1. Above 1 it is held
	 * at a finer quantizer than the shared one and so takes a larger share; below 1, a coarser one.
	 * A doubling of priority is worth one doubling of bitrate.
	 */
	priority?: number;
	/**
	 * The finest quantizer this program may be held at, defaulting to the codec's own minimum.
	 *
	 * This is the bound that stops a floor chasing content that cannot spend it. `minBitrate` is a
	 * claim on the pool, not a promise the encoder will fill it, and a programme carrying a static
	 * picture makes a few kilobits per second *at any quality*. Without a bound the loop reads that as
	 * "still under its floor" every interval and keeps refining, and the quantizer walks all the way
	 * to the codec's minimum - which for x264 is lossless, several times slower than real time, and
	 * still nowhere near the floor.
	 */
	minQuantizer?: number;
};

/**
 * Options for {@link StatMux}.
 *
 * @public
 * @group Encoding
 */
export type StatMuxOptions = {
	/** The programs sharing the pool, in the order they will be reported and asked about. */
	programs: readonly StatMuxProgram[];
	/**
	 * The bitrate shared between every program, in bits per second. This is the video pool: audio,
	 * tables and null padding are not part of it, so it is set below the transport's own rate.
	 */
	totalBitrate: number;
	/** The codec every program is encoded with, which is what fixes the quantizer scale. */
	codec: VideoCodec;
	/**
	 * Seconds between reallocations, defaulting to 2. **Set this to the key frame interval.** Changing
	 * the quantizer reopens the encoder, which starts a key frame, so a reallocation that does not land
	 * on one costs an extra.
	 */
	interval?: number;
	/**
	 * Where the shared quantizer starts, defaulting to the middle of the codec's range. The loop finds
	 * its level within a few intervals either way; a closer guess just gets there sooner.
	 */
	initialQuantizer?: number;
};

type ProgramState = {
	options: StatMuxProgram;
	/** Added to the shared quantizer: priority, plus whatever the floor and ceiling have corrected by. */
	offset: number;
	bitsThisWindow: number;
	measuredBitrate: number;
};

/**
 * Shares one bitrate pool between several programs by holding them at a common quality, which is what
 * a statistical multiplex does: at equal quality, harder content takes more bits, so the split follows
 * the content without anyone having to measure it.
 *
 * The programs must be encoded with quantizer-based rate control - {@link StatMux.encodeOptions} is
 * what carries the quantizer to each frame - and every encoded packet is reported back, which is the
 * loop's only input.
 *
 * ```ts
 * const statMux = new StatMux({
 *     programs: [{ minBitrate: 2e6, maxBitrate: 9e6 }, { minBitrate: 1e6, maxBitrate: 5e6 }],
 *     totalBitrate: 12e6,
 *     codec: 'avc',
 *     interval: 2,
 * });
 *
 * // per frame, for program 0
 * await source.add(sample, statMux.encodeOptions(0));
 * // and once its packet comes back
 * statMux.report(0, packet.byteLength, packet.timestamp);
 * ```
 *
 * It allocates; it does not transport. {@link MptsMultiplexer} carries the result, and refuses a set of
 * programs that does not fit - which is the check that this is working.
 *
 * @public
 * @group Encoding
 */
export class StatMux {
	/** @internal */
	private readonly states: ProgramState[];
	/** @internal */
	private readonly range: { min: number; max: number };
	/** @internal */
	private readonly stepsPerDoubling: number;
	/** @internal */
	private readonly interval: number;
	/** @internal */
	private readonly totalBitrate: number;
	/** @internal */
	private readonly codec: VideoCodec;
	/** @internal */
	private shared: number;
	/** @internal */
	private windowStart: number | null = null;

	constructor(options: StatMuxOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!isArray(options.programs) || options.programs.length === 0) {
			throw new TypeError('options.programs must be a non-empty array.');
		}
		if (!Number.isFinite(options.totalBitrate) || options.totalBitrate <= 0) {
			throw new TypeError('options.totalBitrate must be a positive number of bits per second.');
		}
		if (options.interval !== undefined && !(options.interval > 0 && Number.isFinite(options.interval))) {
			throw new TypeError('options.interval, when provided, must be a positive number of seconds.');
		}

		const range = VIDEO_CODEC_QUANTIZER_SUPPORT[options.codec];
		if (!range) {
			throw new TypeError(
				`Codec '${options.codec}' has no quantizer-based rate control, which is what a statistical`
				+ ' multiplex holds the programs at a common quality with.',
			);
		}

		let floor = 0;
		options.programs.forEach((program, index) => {
			if (!program || typeof program !== 'object') {
				throw new TypeError(`options.programs[${index}] must be an object.`);
			}
			// minBitrate may be zero: a programme with no floor claims nothing and takes whatever the
			// shared quantizer gives it, which is the right description of a filler or slate channel
			if (!Number.isFinite(program.minBitrate) || program.minBitrate < 0) {
				throw new TypeError(
					`options.programs[${index}].minBitrate must be a non-negative number of bits per second.`,
				);
			}
			if (!Number.isFinite(program.maxBitrate) || program.maxBitrate <= 0) {
				throw new TypeError(
					`options.programs[${index}].maxBitrate must be a positive number of bits per second.`,
				);
			}
			if (program.minBitrate > program.maxBitrate) {
				throw new TypeError(
					`options.programs[${index}] has minBitrate ${program.minBitrate} above its maxBitrate`
					+ ` ${program.maxBitrate}.`,
				);
			}
			if (program.priority !== undefined && !(program.priority > 0 && Number.isFinite(program.priority))) {
				throw new TypeError(`options.programs[${index}].priority, when provided, must be positive.`);
			}
			if (
				program.minQuantizer !== undefined
				&& (!Number.isInteger(program.minQuantizer)
					|| program.minQuantizer < range.min
					|| program.minQuantizer > range.max)
			) {
				throw new TypeError(
					`options.programs[${index}].minQuantizer, when provided, must be an integer between`
					+ ` ${range.min} and ${range.max} for codec '${options.codec}'.`,
				);
			}

			floor += program.minBitrate;
		});

		if (floor > options.totalBitrate) {
			throw new TypeError(
				`The programs' minBitrate values come to ${floor} bits per second, which is more than the`
				+ ` ${options.totalBitrate} shared between them. The floors have to fit in the pool, or there`
				+ ' is no allocation that honours them.',
			);
		}

		if (
			options.initialQuantizer !== undefined
			&& (!Number.isInteger(options.initialQuantizer)
				|| options.initialQuantizer < range.min
				|| options.initialQuantizer > range.max)
		) {
			throw new TypeError(
				`options.initialQuantizer must be an integer between ${range.min} and ${range.max} for codec`
				+ ` '${options.codec}'.`,
			);
		}

		this.codec = options.codec;
		this.range = range;
		this.totalBitrate = options.totalBitrate;
		this.interval = options.interval ?? 2;
		this.stepsPerDoubling = STEPS_PER_DOUBLING_AT_51 * (range.max + 1) / 52;
		this.shared = options.initialQuantizer ?? Math.round((range.min + range.max) / 2);

		this.states = options.programs.map(program => ({
			options: program,
			// A doubling of priority is worth a doubling of bitrate, which is this many steps finer
			offset: -this.stepsPerDoubling * Math.log2(program.priority ?? 1),
			bitsThisWindow: 0,
			measuredBitrate: 0,
		}));
	}

	/** The quantizer each program is currently held at, in the order they were given. */
	get quantizers(): number[] {
		return this.states.map((_, index) => this.quantizerFor(index));
	}

	/** What each program produced over the last completed interval, in bits per second. */
	get measuredBitrates(): number[] {
		return this.states.map(state => state.measuredBitrate);
	}

	/** What the programs came to together over the last completed interval, against `totalBitrate`. */
	get measuredTotal(): number {
		return this.states.reduce((sum, state) => sum + state.measuredBitrate, 0);
	}

	/** The per-frame encode options for a program, which carry its quantizer. */
	encodeOptions(program: number): VideoEncoderEncodeOptions {
		this.checkProgram(program);
		return buildQuantizerEncodeOptions(this.codec, this.quantizerFor(program));
	}

	/**
	 * Reports an encoded packet. `timestamp` is in seconds on the program's own timeline and is what
	 * closes an interval, so the loop runs on media time rather than on how fast the encoders happen to
	 * be going.
	 */
	report(program: number, byteLength: number, timestamp: number): void {
		this.checkProgram(program);
		if (!Number.isFinite(byteLength) || byteLength < 0) {
			throw new TypeError('byteLength must be a non-negative number.');
		}
		if (!Number.isFinite(timestamp)) {
			throw new TypeError('timestamp must be a finite number of seconds.');
		}

		this.states[program]!.bitsThisWindow += byteLength * 8;

		this.windowStart ??= timestamp;
		const elapsed = timestamp - this.windowStart;
		if (elapsed >= this.interval) {
			this.reallocate(elapsed);
			this.windowStart = timestamp;
		}
	}

	/** @internal */
	private checkProgram(program: number) {
		if (!Number.isInteger(program) || program < 0 || program >= this.states.length) {
			throw new TypeError(
				`program must be an index between 0 and ${this.states.length - 1}, got ${program}.`,
			);
		}
	}

	/** @internal */
	private quantizerFor(program: number) {
		const state = this.states[program]!;
		assert(state);
		return Math.round(clamp(
			this.shared + state.offset,
			state.options.minQuantizer ?? this.range.min,
			this.range.max,
		));
	}

	/**
	 * One turn of the loop: move the shared quantizer until the programs together fit the pool, then
	 * correct the programs that have run past their own floor or ceiling.
	 *
	 * @internal
	 */
	private reallocate(elapsed: number) {
		for (const state of this.states) {
			state.measuredBitrate = state.bitsThisWindow / elapsed;
			state.bitsThisWindow = 0;
		}

		const total = this.measuredTotal;
		if (total > 0) {
			// Positive when the programs overran the pool, which is when quality has to give
			const doublings = Math.log2(total / this.totalBitrate);
			this.shared += this.stepsPerDoubling
				* clamp(doublings, -MAX_STEP_IN_DOUBLINGS, MAX_STEP_IN_DOUBLINGS);
			this.shared = clamp(this.shared, this.range.min, this.range.max);
		}

		for (const state of this.states) {
			const measured = state.measuredBitrate;
			if (measured <= 0) {
				continue; // said nothing this interval, so there is nothing to correct by
			}

			// A ceiling is a hard bound and a floor is an entitlement, so both are corrected the same
			// way - by moving this one program off the shared quantizer until it sits inside them.
			let doublings = 0;
			if (measured > state.options.maxBitrate) {
				doublings = Math.log2(measured / state.options.maxBitrate);
			} else if (measured < state.options.minBitrate) {
				doublings = -Math.log2(state.options.minBitrate / measured);
			}

			if (doublings !== 0) {
				state.offset += this.stepsPerDoubling
					* clamp(doublings, -MAX_STEP_IN_DOUBLINGS, MAX_STEP_IN_DOUBLINGS);
				state.offset = clamp(state.offset, -this.range.max, this.range.max);
			}
		}
	}
}
