/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SRT connection bonding, which FFmpeg's `srt` protocol cannot reach: none of its options touch socket
// groups, which is why `@mediabunny/server` binds libsrt directly for this rather than going through
// node-av. These cover the validation, which needs nothing installed, and the wire behaviour against
// libsrt's own srt-live-transmit, which needs both the tool and a libsrt built with bonding.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { SrtBondedSource, SrtBondedTarget, type SrtCallerInfo, type SrtLinkState } from '@mediabunny/server';
import { getLibsrt, readSockaddr, writeSockaddrIn } from '../../packages/server/src/libsrt.js';

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
		return getLibsrt().bondingError?.message ?? null;
	} catch (error) {
		return (error as Error).message;
	}
})();
const hasBondedLibsrt = bondingRefusal === null;

const bondedTest = test.skipIf(!hasTool || !hasBondedLibsrt);

// Only meaningful where bonding is actually missing, which is where the message matters. A build without
// ENABLE_BONDING still exports every group symbol - they compile to stubs returning SRT_INVALID_SOCK -
// so this is the difference between a named cause and an unexplained failure reading `Success`.
test.skipIf(hasBondedLibsrt)('an unusable libsrt is refused by name, not left to fail later', () => {
	// Three ways it can be unusable, and each names what to do about it. The middle one is the trap: a
	// build without ENABLE_BONDING still exports every group symbol, so its stubs would otherwise fail
	// much later with `Success` to read.
	expect(bondingRefusal).toMatch(
		/could not be loaded|built without bonding \(ENABLE_BONDING\)|exports no socket-group API/,
	);
	expect(bondingRefusal).toMatch(/MEDIABUNNY_LIBSRT/);
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

// A group is one sender to one receiver over several paths, so both links connect to the same
// SrtBondedSource. Two separate listeners would be two unrelated groups, not a bonded one.
bondedTest('a bonded group carries the bytes unchanged over both links', async () => {
	const payload = filler(1316 * 8);
	const source = new SrtBondedSource('srt://0.0.0.0:9914', { latencyMs: 120, readTimeout: 8 });
	const reader = (source as never as { _stream: ReadableStream<Uint8Array> })._stream.getReader();

	await sleep(1000);
	const target = new SrtBondedTarget(
		['srt://127.0.0.1:9914', 'srt://127.0.0.1:9914'],
		{ latencyMs: 120 },
	);
	target._setMonotonicity(true);
	target._start();
	await sleep(1200);

	expect(target.linkStates.length).toBe(2);

	for (let i = 0; i < 8; i++) {
		target._write(payload.subarray(i * 1316, (i + 1) * 1316), i * 1316);
		await sleep(25);
	}
	await target._flush();

	const chunks: Uint8Array[] = [];
	let total = 0;
	const deadline = Date.now() + 10_000;
	while (total < payload.byteLength && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			chunks.push(value);
			total += value.byteLength;
		}
	}

	// Both carrying the stream is what makes this a group rather than two independent targets
	expect(target.linkStates.filter((state: SrtLinkState) => state.state === 'running').length).toBe(2);

	const joined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
	expect(joined.subarray(0, payload.byteLength).equals(Buffer.from(payload))).toBe(true);

	await target._close();
	await reader.cancel();
	source.close();
}, 60_000);

// What bonding is for: a link dies mid-stream and the stream does not. Closing the member socket is
// the failure the group sees - libsrt drops a dead member rather than reporting it broken, so the
// observable is that the group shrinks and the survivor carries on.
bondedTest('a link dying mid-stream costs no bytes', async () => {
	const payload = filler(1316 * 40);
	const source = new SrtBondedSource('srt://0.0.0.0:9916', { latencyMs: 200, readTimeout: 10 });
	const reader = (source as never as { _stream: ReadableStream<Uint8Array> })._stream.getReader();

	const chunks: Uint8Array[] = [];
	let total = 0;
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				if (value) {
					chunks.push(value);
					total += value.byteLength;
				}
			}
		} catch {
			// cancelled below
		}
	})();

	await sleep(800);
	const target = new SrtBondedTarget(
		['srt://127.0.0.1:9916', 'srt://127.0.0.1:9916'],
		{ latencyMs: 200 },
	);
	target._setMonotonicity(true);
	target._start();
	await sleep(1200);
	expect(target.linkStates.length).toBe(2);

	for (let i = 0; i < 40; i++) {
		if (i === 12) {
			getLibsrt().close(target.linkStates[0]!.id);
		}
		target._write(payload.subarray(i * 1316, (i + 1) * 1316), i * 1316);
		await sleep(30);
	}
	await target._flush();
	await sleep(2500);

	// One link gone, the other still carrying it
	expect(target.linkStates.length).toBe(1);
	expect(target.linkStates[0]!.state).toBe('running');

	expect(total).toBeGreaterThanOrEqual(payload.byteLength);
	const joined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
	expect(joined.subarray(0, payload.byteLength).equals(Buffer.from(payload))).toBe(true);

	await target._close();
	await reader.cancel();
	await pump;
	source.close();
}, 90_000);

// The ABI, as data rather than as a second copy of the branch: only the BSDs carry sa_len, so Linux
// and Windows both state the family as a uint16 where that byte would be.
test('a sockaddr_in is written in the host ABI, not the BSD one everywhere', () => {
	const bytes = new Uint8Array(16);
	writeSockaddrIn(bytes, 0, '192.168.1.9', 9000);

	const carriesLength = ['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform);
	expect([bytes[0], bytes[1]]).toEqual(carriesLength ? [16, 2] : [2, 0]);

	// Port and address are network order on every platform
	expect([bytes[2], bytes[3]]).toEqual([9000 >> 8, 9000 & 0xff]);
	expect([...bytes.subarray(4, 8)]).toEqual([192, 168, 1, 9]);
});

// The allowlist MediaConnect states as a CIDR, enforced here per caller. Both halves matter: a test
// that only checks the refusal passes on a source that accepts nobody.
bondedTest('an allowlist turns away the callers it does not name, and lets the others through', async () => {
	const seen: SrtCallerInfo[] = [];
	const payload = filler(1316 * 6);

	for (const [index, allow] of [false, true].entries()) {
		const port = 9920 + index * 2;
		const source = new SrtBondedSource(`srt://0.0.0.0:${port}`, {
			latencyMs: 120,
			readTimeout: 4,
			accept: (peer: SrtCallerInfo) => {
				seen.push(peer);
				return allow;
			},
		});
		const reader = (source as never as { _stream: ReadableStream<Uint8Array> })._stream.getReader();

		await sleep(800);
		const target = new SrtBondedTarget([`srt://127.0.0.1:${port}`], { latencyMs: 120 });
		target._setMonotonicity(true);
		target._start();
		await sleep(1200);

		for (let i = 0; i < 6; i++) {
			target._write(payload.subarray(i * 1316, (i + 1) * 1316), i * 1316);
			await sleep(25);
		}
		await target._flush();

		let total = 0;
		const deadline = Date.now() + 5_000;
		while (total < payload.byteLength && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			total += value?.byteLength ?? 0;
		}

		if (allow) {
			expect(total, 'an allowed caller delivers').toBeGreaterThan(0);
			expect(source.refusedCallers).toBe(0);
		} else {
			expect(total, 'a refused caller delivers nothing').toBe(0);
			expect(source.refusedCallers).toBeGreaterThan(0);
		}

		await target._close();
		await reader.cancel();
		source.close();
	}

	// The callback is asked about a real caller, not a placeholder
	expect(seen.length).toBeGreaterThanOrEqual(2);
	expect(seen[0]!.address).toBe('127.0.0.1');
	expect(seen[0]!.family).toBe('ipv4');
	expect(seen[0]!.port).toBeGreaterThan(0);
}, 90_000);

test('an accept that is not a function is refused at construction', () => {
	expect(() => new SrtBondedSource('srt://0.0.0.0:9000', {
		accept: 'yes' as unknown as () => boolean,
	})).toThrow('must be a function');
});

// Keyed on the length srt_accept reports, not on AF_INET6 - which is 30 here, 10 on Linux and 23 on
// Windows, so a family table would be a per-platform guess. These are the bytes libsrt hands back.
test('a caller address is read from the length reported, for both families', () => {
	const v4 = new Uint8Array(28);
	writeSockaddrIn(v4, 0, '203.0.113.7', 9000);
	expect(readSockaddr(v4, 0, 16)).toEqual({ address: '203.0.113.7', port: 9000, family: 'ipv4' });

	// 2001:db8::8a2e:370:7334 with the port at offset 2 and sin6_addr past the 4-byte flowinfo
	const v6 = new Uint8Array(28);
	new DataView(v6.buffer).setUint16(2, 9001);
	v6.set([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0x8a, 0x2e, 0x03, 0x70, 0x73, 0x34], 8);
	expect(readSockaddr(v6, 0, 28)).toEqual({
		address: '2001:db8::8a2e:370:7334',
		port: 9001,
		family: 'ipv6',
	});

	// A length that is neither names nothing rather than reading the first four bytes as an address
	expect(readSockaddr(v4, 0, 12)).toBe(null);
});

// srt_startup spawns libsrt's own GC and epoll threads, and without srt_cleanup they are still running
// while the process tears down: it segfaults with 139 after the last socket closes, long after the bytes
// have been delivered. Only a child process can show that - this one does not exit while the test runs.
// It loads the built bundle rather than the source, because a child gets none of Vitest's aliases.
const BUNDLE = new URL('../../packages/server/dist/bundles/mediabunny-server.mjs', import.meta.url).pathname;

test.skipIf(!hasBondedLibsrt || !existsSync(BUNDLE))(
	'a process that opened a bonded source exits cleanly rather than crashing',
	() => {
		const result = spawnSync(
			process.execPath,
			[
				'-e',
				`import(${JSON.stringify(BUNDLE)}).then(m => {`
				+ ' new m.SrtBondedSource(\'srt://0.0.0.0:9934\', { readTimeout: 1 });'
				+ '});',
			],
			{ encoding: 'utf8', timeout: 30_000, env: process.env },
		);

		// 139 is the segfault this asserts against; anything non-zero is a failure to exit cleanly
		expect(result.status, result.stderr?.slice(0, 400)).toBe(0);
	},
	45_000,
);

bondedTest('a source refuses a url that states no port', () => {
	expect(() => new SrtBondedSource('srt://0.0.0.0')).toThrow('port');
});
