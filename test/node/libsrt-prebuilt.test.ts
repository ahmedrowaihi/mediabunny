/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// `@mediabunny/server` ships libsrt for four platforms so that a host needs nothing installed. Nothing
// here was checking that the shipped library actually *works*, and a broken one is invisible: when it
// fails to load, `getLibsrt` falls through to whatever libsrt the system has, which is usually
// Homebrew's and has no bonding. Every bonding test then **skips** and the suite goes green.
//
// That is how a darwin dylib linking mbedTLS by an absolute Homebrew path from the build machine
// reached npm twice. The distinction this file draws is between "no prebuilt for this platform, fine
// to skip" and "we ship one for this platform and it does not work", which must fail.
//
// MEDIABUNNY_LIBSRT is set here so the bundled library is what gets loaded. That is also why this is a
// file of its own: srt-bonding.test.ts deliberately probes the *default* resolution order, and an
// override set in that file would mask a resolution bug.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const repoRoot = new URL('../..', import.meta.url).pathname;

const LIBRARY_NAME = process.platform === 'darwin'
	? 'libsrt.dylib'
	: process.platform === 'win32' ? 'srt.dll' : 'libsrt.so';

const prebuiltDir = path.join(repoRoot, 'packages/server/prebuilt', `${process.platform}-${process.arch}`);
const bundled = path.join(prebuiltDir, LIBRARY_NAME);
const hasBundled = existsSync(bundled);

// Before the first getLibsrt call anywhere in this file's module graph
if (hasBundled) {
	process.env['MEDIABUNNY_LIBSRT'] = bundled;
}

test.skipIf(!hasBundled)('the bundled libsrt loads, and has bonding', async () => {
	const { getLibsrt } = await import('../../packages/server/src/libsrt.js');

	// A failure here is one of two things, and both matter: the library does not load at all (a missing
	// runtime dependency, the wrong architecture), or it loads and refuses every socket group, which is
	// a build without ENABLE_BONDING. Either way the package is shipping something it cannot use.
	let library: ReturnType<typeof getLibsrt> | null = null;
	let refusal: string | null = null;
	try {
		library = getLibsrt();
	} catch (error) {
		refusal = (error as Error).message;
	}

	expect(refusal, `the prebuilt at ${bundled} is shipped but unusable`).toBe(null);
	expect(library).not.toBe(null);
});

test('every prebuilt present is self-contained', () => {
	// The same check the build and the publish run, against whatever is in the tree. It reads ELF
	// DT_NEEDED, Mach-O LC_LOAD_DYLIB and PE imports directly - a dynamic mbedTLS reference is what
	// makes a prebuilt unloadable off the build machine.
	const platforms = ['darwin-arm64/libsrt.dylib', 'linux-x64/libsrt.so', 'linux-arm64/libsrt.so',
		'win32-x64/srt.dll'];
	const present = platforms
		.map(relative => path.join(repoRoot, 'packages/server/prebuilt', relative))
		.filter(file => existsSync(file));

	if (present.length === 0) {
		// Nothing to check is not the same as nothing wrong; say so rather than passing quietly
		expect(present, 'no prebuilt libsrt in the tree - `npm run pre-test` fetches them').toHaveLength(0);
		return;
	}

	let failure = '';
	try {
		execFileSync('python3', [path.join(repoRoot, '.github/scripts/check-self-contained.py'), ...present],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		const asExec = error as { stdout?: string; stderr?: string };
		failure = `${asExec.stdout ?? ''}${asExec.stderr ?? ''}`;
	}

	expect(failure, failure).toBe('');
}, 60_000);
