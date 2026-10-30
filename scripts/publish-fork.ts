// Publishes the fork's packages under the @ahmedrowaihi scope.
//
// The repo keeps upstream's package names so the tree stays diff-free against upstream; the scoped names exist
// only in what gets published. Each manifest is rewritten in place, published, then restored, so a successful or
// failed run leaves the working tree as it found it.
//
// Peer ranges are stamped to the exact version being released. A caret cannot be satisfied by a prerelease —
// semver excludes prereleases from a range unless the range carries one on the same major.minor.patch — so
// upstream's `^1.0.0` left every install reporting the fork as an invalid peer and `npm ls` exiting 1.
//
// Order matters, in two ways. A package is published before anything that depends on it, and the core goes LAST:
// npm moves a package's dist-tag as part of its own publish, so if a later package fails, publishing the core first
// leaves `beta` pointing at a new core beside old extensions whose exact peer ranges it cannot satisfy — a broken
// install for anyone following the tag. Publishing it last means a partial failure leaves the tag on a consistent
// older set instead. This has happened twice; both times the registry showed it and the run log did not.

import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Package paths are relative to the repo root, so resolve them from this file rather than from the caller's
// working directory — otherwise running it from inside a package directory fails to find anything.
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
const version = flag('--version');
const only = flag('--only');
const dryRun = args.includes('--dry-run');
// Promotion is separable from publishing because npm's validation is slow and unbounded: measured against the
// core package, @ahmedrowaihi/mediabunny-ac3 has arrived 24, 53, 54 and 201 minutes late, and always arrives.
// Blocking a CI job for hours to wait it out is worse than failing and promoting later, so `--promote-only`
// re-runs just the verify-and-move half against an already-published version.
const promoteOnly = args.includes('--promote-only');
const tag = flag('--tag') ?? 'beta';
// npm can accept a publish and then hold the version in its "Validating" state, where it is never served. That
// reads as success from here, so publishing straight to `beta` has moved the tag onto sets where one package
// was missing — three times. Everything is published to a holding tag first and `beta` is moved only once every
// package answers on the registry, which keeps the tag on the last complete set when npm swallows one.
const HOLDING_TAG = 'pending';
const served = async (name: string, wanted: string): Promise<boolean> => {
	const response = await fetch(
		`https://registry.npmjs.org/${name.replace('/', '%2F')}/${wanted}`,
		{ method: 'HEAD' },
	);
	return response.status === 200;
};

if (!version) {
	console.error('usage: publish-fork.mjs --version <version> [--only <dir>] [--tag <tag>] [--dry-run]');
	process.exit(1);
}

// Publishing here is OIDC-only, and npm has no pending publisher: a trusted publisher can only be
// configured for a package that already exists, so a name npm has never seen cannot be published from
// CI. List such a package here and it is skipped by a normal run — otherwise it fails every release
// and holds the tag on the last complete set — while `--only <dir>` still targets it, from a shell
// holding a token. Remove it once its trusted publisher is configured on npmjs.com.
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
	// extensions still carry upstream's URL in the tree (that is the point — the tree stays diff-free), so it is
	// rewritten here along with the name. Without this, OIDC publishing is rejected for those packages.
	if (typeof pkg.repository === 'object' && pkg.repository !== null) {
		pkg.repository.url = `git+${FORK_REPO}.git`;
	}
	if (typeof pkg.bugs === 'object' && pkg.bugs !== null) {
		pkg.bugs.url = `${FORK_REPO}/issues`;
	}
	// Alias, not a bare range: every package and every consumer imports the core as `mediabunny`, so an
	// unscoped peer resolves to UPSTREAM and npm installs a second copy beside the fork. The server then
	// registers its codecs on that instance while the caller holds the other, and every track is discarded
	// as `undecodable_source_codec` — an install that fails silently rather than loudly.
	if (pkg.peerDependencies?.['mediabunny']) {
		pkg.peerDependencies['mediabunny'] = `npm:${FORK_SCOPE}/mediabunny@${version}`;
	}
	for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
		// Keep the upstream specifier so source imports need no rewrite; point it at the fork's build.
		if (dep.startsWith(UPSTREAM_SCOPE) && !range.startsWith('npm:')) {
			pkg.dependencies![dep] = `npm:${forkNameFor(dep)}@${version}`;
		}
	}

	// A package whose build output is missing would publish as a stub that imports nothing. npm says nothing
	// about it, so check before the manifest is touched.
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

const deadline = Date.now() + 5 * 60 * 1000;
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
	// Not a failure: every package published. npm is still validating some, which it does on its own schedule.
	console.log(
		`\nPublished, but ${missing.length} not served yet at ${version}: ${missing.join(', ')}\n`
		+ `'${tag}' still points at the last complete set, which is correct — it moves only once every package`
		+ ` is installable.\n\n`
		+ `npm validates on its own schedule and acceptance has always led to publication; ac3 has arrived up to`
		+ ` 201 minutes late. Do NOT cut a new version. Move the tag when they appear:\n`
		+ `    npx tsx scripts/publish-fork.ts --version ${version} --tag ${tag} --promote-only\n`
		+ `A new version is only the answer if one never appears at all, since npm refuses a retry of the same`
		+ ` one with a 409. That has happened once: dts 1.61.4-beta.128.`,
	);

	// So the job summary says the tag did not move, rather than claiming it did
	if (process.env['GITHUB_OUTPUT']) {
		appendFileSync(process.env['GITHUB_OUTPUT'], `promoted=false\nmissing=${missing.join(' ')}\n`);
	}

	// A package npm merely has not served yet is a wait; one whose publish was rejected is a failure that
	// has to show red, since nothing will arrive on its own.
	process.exit(failed.length > 0 ? 1 : 0);
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
