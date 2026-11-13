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

// A rebase conflict resolved the wrong way deletes an upstream fix and nothing notices: the suite stays
// green because the deleted code was upstream's, and the fork's own tests never covered it. That happened
// twice (upstream #567 in media-sink.ts, #555 in sample.ts) and shipped.
//
// So the count of upstream lines the fork deletes, per file, is recorded in upstream-deletions.json and
// checked here. A rebase that silently drops more of upstream's code than the fork declares fails the
// gate and prints the lines. The reason for each entry lives in FORK.md.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SNAPSHOT_PATH = join(REPO_ROOT, 'scripts/upstream-deletions.json');

type Snapshot = {
	/** Per-file count of upstream `src/` lines this fork deletes. */
	budgets: Record<string, number>;
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

/** Deleted-line counts per path, as `git diff --numstat` reports them (renames resolved to the new path). */
const deletionsByFile = (): Record<string, number> => {
	const result: Record<string, number> = {};
	for (const line of git('diff', '--numstat', '-M', base, 'HEAD', '--', 'src').trim().split('\n')) {
		if (!line) {
			continue;
		}

		const [, deleted, path] = line.split('\t') as [string, string, string];
		const count = Number(deleted);
		if (count > 0) {
			// A rename prints as `src/{old.ts => new.ts}`; the budget is keyed on the path as it is today.
			result[path.replace(/\{.*? => (.*?)\}/, '$1')] = count;
		}
	}
	return result;
};

const current = deletionsByFile();

if (process.argv.includes('--update')) {
	const budgets = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(SNAPSHOT_PATH, `${JSON.stringify({ budgets }, null, '\t')}\n`);
	console.log(`Recorded ${Object.keys(budgets).length} file(s) into scripts/upstream-deletions.json.`);
	process.exit(0);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;

const linesDeletedFrom = (path: string) =>
	git('diff', '-M', base, 'HEAD', '--', path)
		.split('\n')
		.filter(line => line.startsWith('-') && !line.startsWith('---'));

const offenders: string[] = [];
for (const [path, count] of Object.entries(current)) {
	const budget = snapshot.budgets[path];
	if (budget === undefined) {
		offenders.push(`${path}: deletes ${count} upstream line(s), and is not declared`);
	} else if (count > budget) {
		offenders.push(
			`${path}: deletes ${count} upstream line(s), ${count - budget} more than the declared ${budget}`,
		);
	}
}

// A file that no longer deletes anything is not a failure, but the snapshot has drifted and should be
// re-recorded, or the next real regression hides inside the slack.
const stale = Object.keys(snapshot.budgets).filter(path => (current[path] ?? 0) < snapshot.budgets[path]!);

if (offenders.length === 0) {
	console.log(
		`Upstream deletions within budget for all ${Object.keys(current).length} file(s).`
		+ (stale.length > 0
			? ` ${stale.length} entry/entries now delete less than declared: ${stale.join(', ')}.`
			: ''),
	);
	process.exit(0);
}

console.error('The fork deletes more of upstream\'s src/ than it declares:\n');
for (const offender of offenders) {
	console.error(`  ${offender}`);
}
console.error(
	'\nIf a rebase dropped upstream code by accident, restore it. If the deletion is intended, say why in'
	+ ' FORK.md under "Upstream code the fork deletes" and re-record the budget with:'
	+ '\n    npx tsx scripts/check-upstream-deletions.ts --update\n',
);
for (const offender of offenders) {
	const path = offender.split(':')[0]!;
	console.error(`--- ${path}`);
	for (const line of linesDeletedFrom(path).slice(0, 40)) {
		console.error(`  ${line}`);
	}
}

process.exit(1);
