/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `rist_receiver_data_read2` parks on the receiver's own condition variable, and koffi runs it on a
// libuv threadpool thread. Cancelling used to call `rist_destroy` straight away, which frees that
// condition variable under the parked waiter: the thread wakes into freed memory and the process dies
// with SIGSEGV in `_pthread_cond_updateval`. Found in a macOS crash report from a consumer's suite.
//
// librist is stubbed rather than loaded. The ordering is the whole of the fix, a stub states it exactly,
// and an earlier version of this test that opened a real receiver was rejected by CI's librist as an
// unparseable peer address while passing here — the race does not need a real socket to describe.

import { expect, test, vi } from 'vitest';

const events: string[] = [];
let releaseRead: (() => void) | null = null;

vi.mock('../../packages/rist/src/librist.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../packages/rist/src/librist.js')>();

	return {
		...original,
		getLibrist: () => ({
			receiverCreate: (out: unknown[]) => (out[0] = {}, 0),
			parseAddress: (_url: string, out: unknown[]) => (out[0] = {}, 0),
			peerCreate: (_ctx: unknown, out: unknown[]) => (out[0] = {}, 0),
			peerConfigFree: () => 0,
			start: () => 0,
			destroy: () => {
				events.push('destroy');
				return 0;
			},
			receiverReadAsync: () => new Promise<number>((resolve) => {
				events.push('read:start');
				releaseRead = () => {
					events.push('read:end');
					resolve(0);
				};
			}),
			dataBlockFree: () => {},
			payloadOf: () => new Uint8Array(0),
			statsCallbackSet: () => () => {},
		}),
	};
});

test('cancel waits for the parked librist read before destroying the receiver', async () => {
	const { RistSource } = await import('@mediabunny/rist');
	const reader = new RistSource('rist://127.0.0.1:9982', { readTimeout: 10 })._stream.getReader();

	const reading = reader.read();
	await vi.waitFor(() => expect(events).toContain('read:start'));

	let cancelled = false;
	const cancelling = reader.cancel().then(() => void (cancelled = true));

	// The read is still parked, so nothing may have been destroyed yet
	await new Promise(resolve => setTimeout(resolve, 50));
	expect(events).not.toContain('destroy');
	expect(cancelled).toBe(false);

	releaseRead!();
	await cancelling;
	await reading.catch(() => {});

	// Destroy must come after the read returned, never between its start and its end
	expect(events.indexOf('destroy')).toBeGreaterThan(events.indexOf('read:end'));
}, 30_000);
