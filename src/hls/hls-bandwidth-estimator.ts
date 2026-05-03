/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/*!
 * Ported from Shaka Packager, Copyright 2014 Google LLC. All rights reserved.
 * Original source: https://github.com/shaka-project/shaka-packager/blob/main/packager/mpd/base/bandwidth_estimator.cc
 * Licensed under the BSD-3-Clause License. See LICENSE.shaka-packager in the repo root.
 * This file is dual-licensed under BSD-3-Clause (original) and MPL-2.0 (mediabunny).
 */

/** @internal */
interface Block {
	sizeInBits: number;
	duration: number;
}

const TARGET_DURATION_THRESHOLD = 10;

/**
 * Computes peak and average bandwidth across a series of media-segment blocks.
 * Mirrors shaka-packager's `BandwidthEstimator` (used for both DASH and HLS).
 *
 * - The first 10 blocks (`TARGET_DURATION_THRESHOLD`) seed an adaptive target
 *   duration; subsequent blocks are evaluated against it.
 * - Per RFC 8216 §4.1, segments shorter than 50% of target duration are
 *   excluded from peak-bandwidth computation (they're not representative of
 *   sustained throughput).
 *
 * @group HLS
 * @public
 */
export class BandwidthEstimator {
	/** @internal */
	private initialBlocks: Block[] = [];
	/** @internal */
	private targetBlockDuration = 0;
	/** @internal */
	private totalSizeInBits = 0;
	/** @internal */
	private totalDuration = 0;
	/** @internal */
	private maxBitrate = 0;

	/**
	 * Record one media block.
	 *
	 * @param sizeInBytes - block size in bytes (must be greater than 0)
	 * @param duration - block duration in seconds (must be greater than 0)
	 */
	addBlock(sizeInBytes: number, duration: number): void {
		if (sizeInBytes === 0 || duration === 0) {
			return;
		}

		const sizeInBits = sizeInBytes * 8;
		this.totalSizeInBits += sizeInBits;
		this.totalDuration += duration;

		if (this.initialBlocks.length < TARGET_DURATION_THRESHOLD) {
			this.initialBlocks.push({ sizeInBits, duration });
			return;
		}

		if (this.targetBlockDuration === 0) {
			// Use the average duration of the initial blocks as target.
			this.targetBlockDuration = this.getAverageBlockDuration();
			for (const block of this.initialBlocks) {
				this.maxBitrate = Math.max(
					this.maxBitrate,
					this.getBitrate(block, this.targetBlockDuration),
				);
			}
			return;
		}
		this.maxBitrate = Math.max(
			this.maxBitrate,
			this.getBitrate({ sizeInBits, duration }, this.targetBlockDuration),
		);
	}

	/** Returns the average bandwidth in bits per second, rounded up. */
	estimate(): number {
		if (this.totalDuration === 0) {
			return 0;
		}
		return Math.ceil(this.totalSizeInBits / this.totalDuration);
	}

	/** Returns the peak bandwidth in bits per second, rounded up. */
	max(): number {
		if (this.maxBitrate !== 0) {
			return this.maxBitrate;
		}
		// Fewer than TARGET_DURATION_THRESHOLD blocks: derive target on the fly.
		const targetBlockDuration = this.getAverageBlockDuration();
		let maxBitrate = 0;
		for (const block of this.initialBlocks) {
			maxBitrate = Math.max(maxBitrate, this.getBitrate(block, targetBlockDuration));
		}
		return maxBitrate;
	}

	/** @internal */
	private getAverageBlockDuration(): number {
		if (this.initialBlocks.length === 0) {
			return 0;
		}
		const sum = this.initialBlocks.reduce((acc, b) => acc + b.duration, 0);
		return sum / this.initialBlocks.length;
	}

	/** @internal */
	private getBitrate(block: Block, targetBlockDuration: number): number {
		// Per shaka: exclude short segments (< 50% of target) from peak computation
		// to match the RFC 8216 §4.1 definition of "peak segment bit rate".
		if (block.duration < 0.5 * targetBlockDuration) {
			return 0;
		}
		return Math.ceil(block.sizeInBits / block.duration);
	}
}
