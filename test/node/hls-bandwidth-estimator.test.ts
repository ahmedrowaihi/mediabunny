/*!
 * Test cases ported from Shaka Packager (BSD-3-Clause).
 * https://github.com/shaka-project/shaka-packager/blob/main/packager/mpd/base/bandwidth_estimator_unittest.cc
 */
import { describe, expect, test } from 'vitest';
import { BandwidthEstimator } from '../../src/hls/hls-bandwidth-estimator.js';

const BITS_IN_BYTE = 8;

describe('BandwidthEstimator', () => {
	// shaka: TEST(BandwidthEstimatorTest, AllBlocks)
	test('AllBlocks', () => {
		const duration = 1.0;
		const be = new BandwidthEstimator();
		const numBlocksToAdd = 100;
		let totalBytes = 0;
		for (let i = 1; i <= numBlocksToAdd; i++) {
			be.addBlock(i, duration);
			totalBytes += i;
		}

		const expectedEstimate = (totalBytes * BITS_IN_BYTE) / numBlocksToAdd;
		expect(be.estimate()).toBe(expectedEstimate);
		const max = numBlocksToAdd * BITS_IN_BYTE;
		expect(be.max()).toBe(max);
	});

	// shaka: TEST(BandwidthEstimatorTest, ExcludeShortBlocks)
	test('ExcludeShortBlocks', () => {
		const duration = 1.0;
		const be = new BandwidthEstimator();

		// 4 blocks with duration 0.1, 0.8, 1.8 and 0.2 respectively. First and last
		// are excluded as they're too short.
		be.addBlock(1, 0.1 * duration);
		be.addBlock(1, 0.8 * duration);
		be.addBlock(1, 1.8 * duration);
		be.addBlock(1, 0.2 * duration);

		const expectedMax = Math.ceil((1 / 0.8) * BITS_IN_BYTE);
		expect(be.max()).toBe(expectedMax);
	});

	// shaka: TEST(BandwidthEstimatorTest, ExcludeShortBlocksMore)
	test('ExcludeShortBlocksMore', () => {
		const duration = 1.0;
		const be = new BandwidthEstimator();

		for (let k = 0; k < 100; k++) {
			be.addBlock(1, 0.1 * duration);
			be.addBlock(1, 0.8 * duration);
			be.addBlock(1, 1.8 * duration);
			be.addBlock(1, 0.2 * duration);
		}

		const expectedMax = Math.ceil((1 / 0.8) * BITS_IN_BYTE);
		expect(be.max()).toBe(expectedMax);
	});

	// Edge cases (not in shaka, but we want explicit coverage of these contracts):
	test('empty estimator returns 0', () => {
		const be = new BandwidthEstimator();
		expect(be.estimate()).toBe(0);
		expect(be.max()).toBe(0);
	});

	test('zero-size or zero-duration blocks are ignored', () => {
		const be = new BandwidthEstimator();
		be.addBlock(0, 1);
		be.addBlock(1000, 0);
		expect(be.estimate()).toBe(0);
		expect(be.max()).toBe(0);
	});
});
