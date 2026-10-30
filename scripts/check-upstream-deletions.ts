/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This fork builds on upstream, so a change to a file upstream also owns should add to it. A deletion is
// an exception — and twice a rebase conflict resolved the wrong way deleted an upstream bug fix (#567 in
// media-sink.ts, #555 in sample.ts) and shipped, because the suite stayed green: the lost code was
// upstream's, and the fork's own tests never covered it.
//
// So upstream-deletions.json is an inventory of the upstream lines this fork does not have, by content.
// Not a count: a number says nothing about whether a deletion is legitimate, and nets out when one file
// drops a fix while another grows a deletion. Any line that goes missing without being declared fails
// this check by name, so the question a reviewer answers is "should this line be gone?".

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const INVENTORY_PATH = join(REPO_ROOT, 'scripts/upstream-deletions.json');

type Inventory = {
	/**
	 * Files the fork replaced outright, with the reason. Their contents are not tracked line by line:
	 * the whole file is the declared divergence.
	 */
	rewritten: Record<string, string>;
	/** Per file, the upstream lines the fork does not have. */
	missingLines: Record<string, string[]>;
};

const git = (...args: string[]) =>
	execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

let base: string;
try {
	base = git('merge-base', 'upstream/main', 'HEAD').trim();
} catch {
	console.log('No `upstream` remote — skipping the upstream-deletion check.');
	process.exit(0);
}

/** Upstream lines absent from the fork, per file. A rename resolves to the path as it is today. */
const missingLinesByFile = (): Record<string, string[]> => {
	const result: Record<string, string[]> = {};
	let path: string | null = null;

	// Against the working tree, not HEAD: a restored line must count as restored before it is committed,
	// or this reports code that is already fixed. In CI the tree is clean, so the two agree.
	for (const line of git('diff', '-M', '--no-color', base, '--', 'src').split('\n')) {
		const header = /^\+\+\+ b\/(.+)$/.exec(line);
		if (header) {
			path = header[1]!;
			continue;
		}
		if (path && line.startsWith('-') && !line.startsWith('---')) {
			// Trimmed, so re-indenting a block upstream does not read as a deletion.
			const text = line.slice(1).trim();
			if (text.length > 0) {
				(result[path] ??= []).push(text);
			}
		}
	}

	for (const lines of Object.values(result)) {
		lines.sort();
	}

	return result;
};

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as Inventory;
const current = missingLinesByFile();

if (process.argv.includes('--update')) {
	const missingLines: Record<string, string[]> = {};
	for (const [path, lines] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
		if (!(path in inventory.rewritten)) {
			missingLines[path] = lines;
		}
	}

	writeFileSync(
		INVENTORY_PATH,
		`${JSON.stringify({ rewritten: inventory.rewritten, missingLines }, null, '\t')}\n`,
	);
	const total = Object.values(missingLines).reduce((sum, lines) => sum + lines.length, 0);
	console.log(`Recorded ${total} line(s) across ${Object.keys(missingLines).length} file(s).`);
	process.exit(0);
}

const undeclared: Record<string, string[]> = {};
for (const [path, lines] of Object.entries(current)) {
	if (path in inventory.rewritten) {
		continue;
	}

	// Counted, not just present: deleting a second copy of an already-declared line still shows up.
	const allowed = new Map<string, number>();
	for (const line of inventory.missingLines[path] ?? []) {
		allowed.set(line, (allowed.get(line) ?? 0) + 1);
	}

	for (const line of lines) {
		const remaining = allowed.get(line) ?? 0;
		if (remaining === 0) {
			(undeclared[path] ??= []).push(line);
		} else {
			allowed.set(line, remaining - 1);
		}
	}
}

if (Object.keys(undeclared).length === 0) {
	console.log(
		`Every upstream line this fork does not have is declared (${Object.keys(current).length} file(s)`
		+ ` diverge, ${Object.keys(inventory.rewritten).length} of them rewritten outright).`,
	);
	process.exit(0);
}

console.error('These upstream lines have gone missing from the fork and are not declared:\n');
for (const [path, lines] of Object.entries(undeclared)) {
	console.error(`--- ${path}`);
	for (const line of lines.slice(0, 25)) {
		console.error(`  - ${line}`);
	}
	if (lines.length > 25) {
		console.error(`  ... and ${lines.length - 25} more`);
	}
}
console.error(
	'\nIf a rebase dropped them by accident, restore them — that is what this check is for. If they are'
	+ ' meant to be gone, say why in FORK.md and record them with:'
	+ '\n    npx tsx scripts/check-upstream-deletions.ts --update\n',
);

process.exit(1);
