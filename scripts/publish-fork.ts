// Publishes the fork's packages under the @ahmedrowaihi scope. The contract is in FORK.md; two invariants
// are only visible here: PACKAGES must list a package before anything depending on it and the core LAST,
// because npm moves a dist-tag inside each publish, and every manifest is restored in the `finally` below.

import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Manifest = {
	name: string;
	version: string;
	repository?: { url?: string } | string;
	bugs?: { url?: string } | string;
	files?: string[];
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const FORK_SCOPE = '@ahmedrowaihi';
const FORK_REPO = 'https://github.com/ahmedrowaihi/mediabunny';
const UPSTREAM_SCOPE = '@mediabunny/';

// Dependency order: core, then leaf extensions, then the server which depends on prores.
const PACKAGES = [
	'packages/prores',
	'packages/mp3-encoder',
	'packages/aac-encoder',
	'packages/flac-encoder',
	'packages/ac3',
	'packages/dts',
	'packages/truehd',
	'packages/server',
	'packages/rist',
	'.',
];

const alreadyPublished = (name: string, wanted: string): boolean => {
	try {
		const out = execFileSync('npm', ['view', `${name}@${wanted}`, 'version'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return out.trim() === wanted;
	} catch {
		// `npm view` exits non-zero for a package or version that does not exist yet.
		return false;
	}
};

const forkNameFor = (name: string): string =>
	name.startsWith(UPSTREAM_SCOPE)
		? `${FORK_SCOPE}/mediabunny-${name.slice(UPSTREAM_SCOPE.length)}`
		: name;

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
	const index = args.indexOf(name);
	return index === -1 ? null : args[index + 1] ?? null;
};
const only = flag('--only');
const dryRun = args.includes('--dry-run');
// Separable from publishing: npm's validation is unbounded (ac3 once took 201 minutes), so the tag can be
// moved by a later run instead.
const promoteOnlyFlag = args.includes('--promote-only');
// For the poller: an incomplete set means "not yet", not "failed", so it leaves the tag and exits 0
const ifCompleteFlag = args.includes('--if-complete');
// Moves the tags onto whatever `pending` has become complete since, so a release that npm finished serving
// after its own run ended is picked up by the next one rather than waiting for a cron tick.
const catchUp = args.includes('--catch-up');
const tag = flag('--tag') ?? 'beta';
const promoteOnly = promoteOnlyFlag || catchUp;
const ifComplete = ifCompleteFlag || catchUp;
// Published here first, so an accepted-but-unserved version cannot move `beta` onto an incomplete set
const HOLDING_TAG = 'pending';

const distTag = (name: string, which: string): string | null => {
	try {
		return execFileSync('npm', ['view', name, `dist-tags.${which}`], { encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
};

let version = flag('--version');
if (catchUp) {
	const pending = distTag(`${FORK_SCOPE}/mediabunny`, HOLDING_TAG);
	const current = distTag(`${FORK_SCOPE}/mediabunny`, tag);
	console.log(`catch-up: ${HOLDING_TAG} ${pending ?? 'none'}, ${tag} ${current ?? 'none'}`);
	if (!pending || pending === current) {
		process.exit(0);
	}
	version = pending;
}
const served = async (name: string, wanted: string): Promise<boolean> => {
	const response = await fetch(
		`https://registry.npmjs.org/${name.replace('/', '%2F')}/${wanted}`,
		{ method: 'HEAD' },
	);
	return response.status === 200;
};

if (!version) {
	console.error(
		'usage: publish-fork.mjs --version <version> [--only <dir>] [--tag <tag>] [--dry-run]'
		+ ' | --catch-up [--tag <tag>]',
	);
	process.exit(1);
}

// A name npm has never seen cannot be published by OIDC; list it here to skip it until its first publish
// by hand, with `--only <dir>` from a shell holding a token
const NEEDS_FIRST_PUBLISH_BY_HAND: string[] = [];

const targets = only
	? PACKAGES.filter(dir => dir === only || dir.endsWith(`/${only}`))
	: PACKAGES.filter(dir => !NEEDS_FIRST_PUBLISH_BY_HAND.includes(dir));
if (targets.length === 0) {
	console.error(`no package matches --only ${only}`);
	process.exit(1);
}

const PUBLISH_ATTEMPTS = 3;

/**
 * Run one `npm publish`, retrying the transparency-log conflict that npm reports as fatal.
 *
 * With provenance, npm writes the sigstore entry before uploading the tarball; if that write is slow it
 * re-sends the same entry, Rekor rejects the duplicate with a 409, and npm gives up even though the entry
 * was created (npm/cli#10078). A fresh attempt signs anew, so it gets its own entry — but the first one may
 * also have reached the registry, so the registry is checked before each retry.
 */
const publishWithRetries = async (
	packageDir: string,
	publishArgs: string[],
	name: string,
): Promise<'published' | 'staged' | 'failed'> => {
	for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
		try {
			// stderr is piped, not inherited: the 409s below have to be read out of npm's own text, and an
			// inherited stream leaves `error.message` as nothing but the command line.
			execFileSync('npm', publishArgs, { cwd: packageDir, stdio: ['inherit', 'inherit', 'pipe'] });
			return 'published';
		} catch (error) {
			const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? '';
			process.stderr.write(stderr);

			// npm answers a republish of a version it is still validating with 409 "previously staged". That
			// means it already has these bytes, so the publish is done; it is the serving that is outstanding.
			if (stderr.includes('409') && !stderr.includes('TLOG_CREATE_ENTRY_ERROR')) {
				return 'staged';
			}
			if (!stderr.includes('TLOG_CREATE_ENTRY_ERROR') || attempt === PUBLISH_ATTEMPTS) {
				return 'failed';
			}
			if (alreadyPublished(name, version)) {
				console.log('    the conflicting attempt reached the registry — treating as published');
				return 'published';
			}

			console.log(`    transparency-log conflict; retrying (${attempt}/${PUBLISH_ATTEMPTS - 1})`);
			await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
		}
	}

	return 'failed';
};

const failed: string[] = [];

for (const dir of promoteOnly ? [] : targets) {
	const packageDir = join(REPO_ROOT, dir);
	const manifestPath = join(packageDir, 'package.json');
	const original = readFileSync(manifestPath, 'utf8');
	const pkg = JSON.parse(original) as Manifest;
	const published = forkNameFor(pkg.name);

	pkg.name = published;
	pkg.version = version;
	// npm's trusted publishing requires repository.url to match the repo the workflow runs in, exactly. The
	// OIDC is rejected unless the manifest's repository matches the publishing one
	if (typeof pkg.repository === 'object' && pkg.repository !== null) {
		pkg.repository.url = `git+${FORK_REPO}.git`;
	}
	if (typeof pkg.bugs === 'object' && pkg.bugs !== null) {
		pkg.bugs.url = `${FORK_REPO}/issues`;
	}
	// An alias, not a range: a bare `mediabunny` peer resolves to upstream and installs a second copy
	if (pkg.peerDependencies?.['mediabunny']) {
		pkg.peerDependencies['mediabunny'] = `npm:${FORK_SCOPE}/mediabunny@${version}`;
	}
	for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
		// Keep the upstream specifier so source imports need no rewrite; point it at the fork's build.
		if (dep.startsWith(UPSTREAM_SCOPE) && !range.startsWith('npm:')) {
			pkg.dependencies![dep] = `npm:${forkNameFor(dep)}@${version}`;
		}
	}

	// npm publishes a stub without complaint when the build output is missing
	for (const entry of pkg.files ?? []) {
		if (entry === 'dist' && !existsSync(join(packageDir, 'dist'))) {
			console.error(`${pkg.name}: dist/ is missing — run \`npm run build\` first`);
			process.exit(1);
		}
	}

	writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n');
	try {
		console.log(`\n=== ${published}@${version}  (${dir})`);
		if (pkg.peerDependencies?.['mediabunny']) {
			console.log(`    peer mediabunny: ${pkg.peerDependencies['mediabunny']}`);
		}
		for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
			if (range.startsWith('npm:')) {
				console.log(`    dep ${dep}: ${range}`);
			}
		}
		// Publishing one package at a time means re-running the command, and npm answers a repeat with a 403
		// that reads like a permissions problem. Skip what is already on the registry instead.
		if (!dryRun && alreadyPublished(published, version)) {
			// A skip publishes nothing, and npm only moves a dist-tag as part of a publish — so after a partial
			// release the tag can sit on an older version than the one being released. Point it at this version
			// explicitly, or the set ends up split across tags even though every package is present.
			// Deliberately does NOT move the tag here. An earlier version did, to repair a stale tag, and on a
			// re-run that moved each package's tag as it went — splitting `beta` across versions, which is the
			// exact failure atomic promotion exists to prevent. The promotion at the end covers this case.
			console.log('    already on the registry at this version — skipped');
			continue;
		}

		const publishArgs = ['publish', '--access', 'public', '--tag', dryRun ? tag : HOLDING_TAG];
		if (dryRun) {
			publishArgs.push('--dry-run');
		}
		const outcome = await publishWithRetries(packageDir, publishArgs, published);
		if (outcome === 'failed') {
			// One package failing must not cost the ones that would publish after it; the wait below reports
			// what is missing and the tag stays put.
			console.error(`    FAILED to publish ${published}@${version}`);
			failed.push(published);
			continue;
		}
		if (outcome === 'staged') {
			console.log('    npm already holds this version (staged) — treating as published');
		}
	} finally {
		writeFileSync(manifestPath, original);
	}
}

if (!promoteOnly) {
	if (failed.length > 0) {
		console.error(
			`\n${failed.length} of ${targets.length} package(s) FAILED to publish at ${version}:`
			+ ` ${failed.join(', ')}\nThe rest were published. Re-run this workflow to retry them at this same`
			+ ` version; the ones already on the registry are skipped.`,
		);
	} else {
		console.log(`\nAll ${targets.length} package(s) ${dryRun ? 'validated' : 'published'} at ${version}.`);
	}
}

if (dryRun) {
	process.exit(0);
}

// npm serves a version some minutes after accepting it, and acceptance has always led to publication — ac3 has
// arrived 24, 53, 54 and 201 minutes late and never failed to arrive. So this waits briefly for the common case
// and then hands off rather than blocking CI for hours: publishing succeeded either way, and the tag simply has
// not moved yet. Only one version has ever failed to appear at all (dts 1.61.4-beta.128).
const names = targets.map(dir => forkNameFor(
	(JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as Manifest).name,
));
console.log(`\nWaiting for all ${names.length} to be served before moving '${tag}'...`);

// Short, because promote-pending.yml polls every 15 minutes and moves the tag when the set is complete.
// Holding a runner for the observed lag does not work: dts has taken 720, 1110, 1200 and 1590 s.
const deadline = Date.now() + 8 * 60 * 1000;
let missing: string[] = [];
for (;;) {
	const results = await Promise.all(names.map(async name => [name, await served(name, version)] as const));
	missing = results.filter(([, ok]) => !ok).map(([name]) => name);
	if (missing.length === 0 || Date.now() > deadline) {
		break;
	}

	console.log(`    ${names.length - missing.length}/${names.length} served; waiting on ${missing.join(', ')}`);
	await new Promise(resolve => setTimeout(resolve, 20_000));
}

if (missing.length > 0) {
	// An incomplete set is never a false positive, and a green check outweighs any prose. See FORK.md.
	if (process.env['GITHUB_ACTIONS']) {
		console.log(
			`::${ifComplete ? 'notice' : 'error'} title=Release incomplete::${missing.length} of ${names.length}`
			+ ` not on the registry at ${version}: ${missing.join(', ')}. '${tag}' did NOT move.`,
		);
	}

	console.log(
		`\nPublished, but ${missing.length} not served yet at ${version}: ${missing.join(', ')}\n`
		+ `'${tag}' still points at the last complete set, which is correct — it moves only once every package`
		+ ` is installable.\n\n`
		+ `This is NOT finished. One of two things is true, and they are indistinguishable from here:\n`
		+ `  1. npm is still validating. It does that on its own schedule; ac3 has arrived 201 minutes late.\n`
		+ `     Move the tag once they appear:\n`
		+ `         npx tsx scripts/publish-fork.ts --version ${version} --tag ${tag} --promote-only\n`
		+ `  2. npm accepted the publish and dropped it. Then the version never appears and no amount of\n`
		+ `     waiting helps, because npm refuses a retry of the same version with a 409 — a NEW version is\n`
		+ `     the only way out.\n\n`
		+ `Tell them apart by re-checking after ~30 minutes. If the version document is still absent while a\n`
		+ `LATER version of that same package exists, it was dropped. Confirmed drops: dts at\n`
		+ `1.61.4-beta.128 and 1.65.0-beta.233. Late is commoner and looks identical early on: truehd missed\n`
		+ `this wait at .238 and appeared ~15 minutes later, and ac3 once took 201 minutes. The '+' acceptance\n`
		+ `line appears in both cases, so only the version document appearing settles it.`,
	);

	// So the job summary says the tag did not move, rather than claiming it did
	if (process.env['GITHUB_OUTPUT']) {
		appendFileSync(process.env['GITHUB_OUTPUT'], `promoted=false\nmissing=${missing.join(' ')}\n`);
	}

	process.exit(ifComplete ? 0 : 1);
}

// `latest` moves with the release tag: it is what a bare `npm i` resolves to, and left alone it stays
// on whatever each package happened to publish first — a different stale version per package, so the
// core and an extension can disagree. npm is content with a prerelease version on `latest`; note that
// a caret range still will not match one, so consumers pin exactly or install by tag.
const tagsToMove = tag === 'latest' ? [tag] : [tag, 'latest'];

for (const name of names) {
	for (const moved of tagsToMove) {
		execFileSync('npm', ['dist-tag', 'add', `${name}@${version}`, moved], { stdio: 'inherit' });
	}
}
console.log(`\n${tagsToMove.map(x => `'${x}'`).join(' and ')} now point at ${version}`
	+ ` for all ${names.length} packages.`);
