/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The published manifests decide whether a consumer can install the fork at all, and nothing else in
// the suite reads them. `scripts/publish-fork.ts` rewrites each extension's `mediabunny` peer to the
// exact fork version, which npm cannot satisfy from the public registry - so the peer must also be
// OPTIONAL, or npm tries to fetch it and the install dies with ETARGET. See FORK.md, "Install shapes".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_VERSION = '1.66.1-beta.999';

const dryRunManifests = () => {
	const stdout = execFileSync(
		'npx',
		['tsx', 'scripts/publish-fork.ts', '--version', PROBE_VERSION, '--dry-run'],
		{ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
	);
	const packages: { name: string; peer: string | null }[] = [];
	for (const line of stdout.split('\n')) {
		const header = /^=== (\S+)@/.exec(line);
		if (header) {
			packages.push({ name: header[1]!, peer: null });
			continue;
		}
		const peer = /^\s+peer mediabunny: (.+)$/.exec(line);
		if (peer && packages.length > 0) {
			packages[packages.length - 1]!.peer = peer[1]!.trim();
		}
	}
	return packages;
};

describe('published fork manifests', () => {
	const packages = dryRunManifests();

	test('every package the fork publishes is accounted for', () => {
		expect(packages.length).toBeGreaterThanOrEqual(9);
		expect(packages.map(x => x.name)).toContain('@ahmedrowaihi/mediabunny');
		expect(packages.map(x => x.name)).toContain('@ahmedrowaihi/mediabunny-server');
	});

	test('the core itself declares no mediabunny peer', () => {
		const core = packages.find(x => x.name === '@ahmedrowaihi/mediabunny');
		expect(core?.peer).toBe(null);
	});

	test('every extension pins the peer to the exact fork version AND marks it optional', () => {
		const extensions = packages.filter(x => x.peer !== null);
		// All eight extensions, not just the server: prores carries the same peer, and one unmarked
		// package is enough to fail the whole install even when the rest are right.
		expect(extensions.length).toBe(8);

		for (const extension of extensions) {
			expect(extension.peer, extension.name).toBe(`${PROBE_VERSION} (optional)`);
		}
	});
});

test('the source manifests keep an upstream-satisfiable range, so only the publish rewrite pins it', () => {
	// If the checked-in range were already the exact fork version, `npm install` in this repo would
	// fail the same way the consumer's did.
	const server = JSON.parse(readFileSync(join(repoRoot, 'packages/server/package.json'), 'utf8')) as {
		peerDependencies?: Record<string, string>;
	};
	expect(server.peerDependencies?.['mediabunny']).toMatch(/^\^/);
});
