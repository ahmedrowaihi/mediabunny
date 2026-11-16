/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SRT connection bonding, which FFmpeg's `srt` protocol cannot reach: none of its options touch socket
// groups. These cover the validation, which needs nothing installed, and the wire behaviour against
// libsrt's own srt-live-transmit, which needs both the tool and a libsrt built with bonding.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { SrtBondedTarget, type SrtLinkState } from '@mediabunny/srt';
import { getLibsrt } from '../../packages/srt/src/libsrt.js';

const canRun = (command: string) => {
	try {
		execFileSync(command, ['-help'], { stdio: 'ignore' });
		return true;
	} catch (error) {
		// A tool that exists but exits non-zero on -help still counts as present
		return (error as { code?: string }).code !== 'ENOENT';
	}
};

const hasTool = canRun('srt-live-transmit');

/**
 * A libsrt that loads and exports the group API, which is what `ENABLE_BONDING` decides. Asked of the
 * binding directly: constructing a target would open a connection nothing is listening to.
 */
const bondingRefusal = (() => {
	try {
		getLibsrt();
		return null;
	} catch (error) {
		return (error as Error).message;
	}
})();
const hasBondedLibsrt = bondingRefusal === null;

const bondedTest = test.skipIf(!hasTool || !hasBondedLibsrt);

// Only meaningful where bonding is actually missing, which is where the message matters. A build without
// ENABLE_BONDING still exports every group symbol - they compile to stubs returning SRT_INVALID_SOCK -
// so this is the difference between a named cause and an unexplained failure reading `Success`.
test.skipIf(hasBondedLibsrt)('a libsrt without bonding is refused by name, not left to fail later', () => {
	expect(bondingRefusal).toMatch(/built without bonding \(ENABLE_BONDING\)|exports no socket-group API/);
});

const filler = (bytes: number): Uint8Array => {
	const data = new Uint8Array(bytes);
	for (let i = 0; i < bytes; i++) {
		data[i] = (i * 7 + (i >> 8)) & 0xff;
	}
	return data;
};

test('a bonded target states its links before it opens them', () => {
	const target = new SrtBondedTarget(['srt://127.0.0.1:9000', 'srt://127.0.0.1:9001']);
	// Nothing is open yet, so there is nothing to report - and a gauge that invented a state here would
	// be reporting on links that do not exist
	expect(target.linkStates).toEqual([]);
	expect(target.sentPackets).toBe(0);
	expect(target.sentBytes).toBe(0);
});

test('a link list must name at least one link', () => {
	expect(() => new SrtBondedTarget([])).toThrow('at least one srt:// URL');
});

test('every link is checked, not just the first', () => {
	expect(() => new SrtBondedTarget(['srt://127.0.0.1:9000', 'http://127.0.0.1:9001']))
		.toThrow('Expected an srt:// URL');
	expect(() => new SrtBondedTarget(['srt://127.0.0.1:9000', 'srt://127.0.0.1']))
		.toThrow('states no usable port');
});

test('a passphrase outside SRT\'s own bounds is refused', () => {
	expect(() => new SrtBondedTarget('srt://127.0.0.1:9000', { passphrase: 'tooshort' }))
		.toThrow('10 to 79 characters');
	expect(() => new SrtBondedTarget('srt://127.0.0.1:9000', { passphrase: 'x'.repeat(80) }))
		.toThrow('10 to 79 characters');
});

test('weights must state one per link, since they are read positionally', () => {
	expect(() => new SrtBondedTarget(['srt://127.0.0.1:9000', 'srt://127.0.0.1:9001'], { weights: [1] }))
		.toThrow('one weight per link (2 given)');
	expect(() => new SrtBondedTarget('srt://127.0.0.1:9000', { weights: [-1] }))
		.toThrow('0 to 65535');
});

test('an unknown group type is refused at construction', () => {
	expect(() => new SrtBondedTarget('srt://127.0.0.1:9000', {
		groupType: 'balancing' as unknown as 'broadcast',
	})).toThrow('\'broadcast\' or \'backup\'');
});

// The defining property of a broadcast group: every payload goes down every link. Two listeners, each
// writing what it receives to its own file, so the duplication is observable rather than inferred.
bondedTest('a broadcast group puts every payload down every link', async () => {
	const ports = [9890, 9892];
	const directory = mkdtempSync(path.join(tmpdir(), 'mb-srt-'));
	const payload = filler(1316 * 4);
	const receivers = ports.map((port, i) => {
		const file = path.join(directory, `link${i}.ts`);
		const process = spawn('srt-live-transmit', [
			`srt://:${port}?mode=listener&groupconnect=1&latency=120`,
			`file://${file}`,
		], { stdio: 'ignore' });
		return { file, process };
	});

	try {
		await sleep(1500);

		const target = new SrtBondedTarget(ports.map(port => `srt://127.0.0.1:${port}`), {
			latencyMs: 120,
		});
		target._setMonotonicity(true);
		target._start();

		// The handshake happens after the group starts; writing straight away loses the early payloads,
		// which presents as a partial stream rather than as a failure
		await sleep(1000);
		target._write(payload, 0);
		await target._flush();

		// Both links carrying it is what makes this a group rather than two independent targets
		const states = target.linkStates;
		expect(states.length).toBe(2);
		expect(states.filter((state: SrtLinkState) => state.state === 'running').length).toBe(2);

		await target._close();
		await sleep(2000);

		for (const receiver of receivers) {
			const received = readFileSync(receiver.file);
			expect(received.length).toBeGreaterThanOrEqual(payload.byteLength);
			expect(received.subarray(0, payload.byteLength).equals(Buffer.from(payload))).toBe(true);
		}
	} finally {
		receivers.forEach(receiver => receiver.process.kill('SIGKILL'));
		rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);
