/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fetches the media the HLS input tests read. The corpus is 84 MB of third-party CDN streams, so it is
// not committed; this rebuilds it from the URL list beside it. Already-present files are left alone, so
// a re-run only fills gaps.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'test/fixtures/hls');
const URL_LIST = join(REPO_ROOT, 'test/fixtures/hls-fixtures.txt');

// Some of these hosts answer a scripted request with a 403; they serve the same bytes to a browser.
const HEADERS = {
	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
		+ ' Chrome/140.0.0.0 Safari/537.36',
	'accept': '*/*',
	'origin': 'https://bitmovin.com',
	'referer': 'https://bitmovin.com/',
};

/** Where one captured URL lives on disk. The query is part of a CDN URL's identity, so it is part of the name. */
const fixturePathFor = (originalUrl: string): string => {
	const url = new URL(originalUrl);
	const suffix = url.search ? `__${encodeURIComponent(url.search.slice(1))}` : '';
	return join(FIXTURE_ROOT, url.host, decodeURIComponent(url.pathname).replace(/^\//, '') + suffix);
};

const urls = readFileSync(URL_LIST, 'utf8')
	.split('\n')
	.map(line => line.trim())
	.filter(line => line.length > 0 && !line.startsWith('#'));

const CONCURRENCY = 8;

let fetched = 0;
let present = 0;
const failures: { url: string; reason: string }[] = [];

const capture = async (url: string) => {
	const destination = fixturePathFor(url);
	if (existsSync(destination)) {
		present++;
		return;
	}

	try {
		const response = await fetch(url, { headers: HEADERS });
		if (!response.ok) {
			failures.push({ url, reason: `${response.status} ${response.statusText}` });
			return;
		}

		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, new Uint8Array(await response.arrayBuffer()));
		fetched++;
	} catch (error) {
		failures.push({ url, reason: error instanceof Error ? error.message : String(error) });
	}
};

console.log(`Capturing ${urls.length} HLS fixture(s) into test/fixtures/hls ...`);

const run = async (list: string[], concurrency: number) => {
	const queue = [...list];
	await Promise.all(Array.from({ length: concurrency }, async () => {
		for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
			await capture(url);
		}
	}));
};

await run(urls, CONCURRENCY);

// At least one of these hosts rate-limits a parallel sweep. Anything it refused gets one more pass,
// serially and after a pause, so a fresh checkout does not need the command run twice.
if (failures.length > 0) {
	const retryable = failures.map(failure => failure.url);
	console.log(`\n${failures.length} failed; retrying serially in 10s ...`);
	failures.length = 0;
	await new Promise(resolve => setTimeout(resolve, 10_000));
	await run(retryable, 1);
}

console.log(`\n${fetched} fetched, ${present} already present, ${failures.length} failed.`);

if (failures.length > 0) {
	console.error(
		`\nThese could not be captured:\n${failures.map(f => `  ${f.reason}  ${f.url}`).join('\n')}`,
	);
	console.error(
		'\nA host that has moved or withdrawn a stream cannot be worked around here: capture an equivalent'
		+ ' stream, update test/fixtures/hls-fixtures.txt, and adjust the test that reads it.',
	);
	process.exit(1);
}
