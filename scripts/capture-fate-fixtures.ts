/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fetches a corpus of third-party media the tests read, named by the argument: `mvhevc` reads
// `test/fixtures/mvhevc-fixtures.txt` into `test/fixtures/mvhevc/`. These files are what tell a
// reading of a format from a plausible misreading of it - nothing in this toolchain writes
// MV-HEVC, and what it writes for MXF is one vendor's shape - so they are fetched rather than
// committed, being third-party media.

const corpus = process.argv[2];
if (!corpus || !/^[a-z0-9-]+$/.test(corpus)) {
	console.error('Usage: tsx scripts/capture-fate-fixtures.ts <corpus>');
	process.exit(2);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = join(REPO_ROOT, `test/fixtures/${corpus}`);
const URL_LIST = join(REPO_ROOT, `test/fixtures/${corpus}-fixtures.txt`);

const urls = readFileSync(URL_LIST, 'utf8')
	.split('\n')
	.map(line => line.trim())
	.filter(line => line.length > 0 && !line.startsWith('#'));

let fetched = 0;
let present = 0;
const failures: { url: string; reason: string }[] = [];

for (const url of urls) {
	const destination = join(FIXTURE_ROOT, basename(new URL(url).pathname));
	if (existsSync(destination)) {
		present++;
		continue;
	}

	try {
		const response = await fetch(url);
		if (!response.ok) {
			failures.push({ url, reason: `${response.status} ${response.statusText}` });
			continue;
		}

		mkdirSync(FIXTURE_ROOT, { recursive: true });
		writeFileSync(destination, new Uint8Array(await response.arrayBuffer()));
		fetched++;
	} catch (error) {
		failures.push({ url, reason: error instanceof Error ? error.message : String(error) });
	}
}

console.log(`${fetched} fetched, ${present} already present, ${failures.length} failed.`);
for (const failure of failures) {
	console.error(`  ${failure.url}: ${failure.reason}`);
}

if (failures.length > 0) {
	process.exit(1);
}
