/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A consumer compiling with `exactOptionalPropertyTypes: true` cannot pass what our own API hands back
// unless every optional field of a public type spells out `| undefined`. Under that flag
// `?: T | null` accepts an absent property but refuses one explicitly set to undefined, so
// `colorSpace: await track.getColorSpace()` fails on every field - six sites in one downstream
// project, reported 2026-11-17.
//
// None of this repo's own tsconfigs set the flag, so nothing else here would ever notice. This
// compiles a fixture against the BUILT declarations - the surface a consumer sees - with the flag on.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const repoRoot = new URL('../..', import.meta.url).pathname;

test('the public types are assignable under exactOptionalPropertyTypes', () => {
	// The fixture imports from dist/, so it needs a build to have happened. `npm run build` runs
	// before this in CI; locally a stale dist would test a stale surface, which is worth saying
	// rather than skipping silently.
	expect(
		existsSync(path.join(repoRoot, 'dist/mediabunny.d.ts')),
		'dist/mediabunny.d.ts is missing - run `npm run build` first; this test checks the built surface',
	).toBe(true);

	let output = '';
	let failed = false;
	try {
		output = execFileSync(
			'npx',
			['tsc', '-p', 'test/types/tsconfig.json'],
			{ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	} catch (error) {
		failed = true;
		const asExec = error as { stdout?: string; stderr?: string };
		output = `${asExec.stdout ?? ''}${asExec.stderr ?? ''}`;
	}

	expect(failed, `tsc rejected the fixture:\n${output}`).toBe(false);
}, 180_000);
