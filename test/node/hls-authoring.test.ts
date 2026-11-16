/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// What this library writes, read by Apple's own tools: `mediastreamvalidator` for the HLS
// specification and `hlsreport` for the HLS Authoring Specification for Apple Devices. Both ship
// with the HLS Tools and are absent in CI, so these skip there - but nothing else here can tell a
// playlist that is merely self-consistent from one a device will accept.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { Conversion } from '../../src/conversion.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat } from '../../src/output-format.js';
import { FilePathSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

const hasTool = (name: string) => {
	try {
		execFileSync(name, ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const hasValidator = hasTool('mediastreamvalidator') && hasTool('hlsreport');

let workDir: string;
let packageDir: string;

// One transcode for the whole file: every test below reads the same package, and the one that needs
// a broken playlist copies it. Each `Conversion` here is a real encode, and this suite runs beside
// 200 other files.
beforeAll(async () => {
	workDir = mkdtempSync(path.join(tmpdir(), 'mediabunny-hls-authoring-'));
	packageDir = await writePackage('package');
}, 60_000);

/** Converts the demo file into a complete HLS package on disk and returns its directory. */
const writePackage = async (name: string) => {
	const directory = path.join(workDir, name);
	mkdirSync(directory, { recursive: true });

	const input = new Input({ source: new FilePathSource(SOURCE), formats: ALL_FORMATS });
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 2 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				const file = path.join(directory, request.path);
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, new Uint8Array(target.buffer!));
			});
			return target;
		}),
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	return directory;
};

const masterOf = (directory: string) => readFileSync(path.join(directory, 'master.m3u8'), 'utf8');

type ValidationReport = {
	independentSegments: boolean;
	variants: { messages?: { errorComment?: string }[] }[];
};

/** Runs the validator and returns its JSON report. */
const validate = (master: string, into: string): ValidationReport => {
	// A playlist it objects to is a non-zero exit, which is the case one of these tests wants
	spawnSync('mediastreamvalidator', ['-O', into, master], { stdio: 'ignore' });
	return JSON.parse(readFileSync(into, 'utf8')) as ValidationReport;
};

/** Everything the validator objected to, across every variant. */
const complaintsIn = (report: ValidationReport) =>
	report.variants.flatMap(variant => variant.messages ?? []).map(message => message.errorComment ?? '');

/** The issue texts the authoring report lists, one per rule it found broken. */
const authoringIssues = (json: string, into: string) => {
	execFileSync('hlsreport', ['-o', into, json], { stdio: 'ignore' });
	// Each broken rule is one <h4>, numbered, under a "Must Fix"/"Should Fix" heading
	return [...readFileSync(into, 'utf8').matchAll(/<h4>\d+\.\s*([^<]+)<\/h4>/g)]
		.map(match => match[1]!.trim());
};

describe('what Apple\'s tools say about what we write', () => {
	test('the multivariant playlist states the frame rate and independent segments', () => {
		const master = masterOf(packageDir);

		// Both are authoring requirements, and neither was stated before: FRAME-RATE was written only
		// when the caller set `VideoTrackMetadata.frameRate`, which snaps timestamps to itself and so
		// is a request to re-time rather than a way to state a rate.
		expect(master).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
		expect(master).toMatch(/#EXT-X-STREAM-INF:[^\n]*,FRAME-RATE=25\b/);
	});

	test('the stated rate is the source\'s rate, not a number of our own', () => {
		const master = masterOf(packageDir);
		const stated = Number(/FRAME-RATE=([\d.]+)/.exec(master)![1]);

		// From ffprobe, on the input - so agreeing with ourselves is not enough to pass
		const probed = execFileSync('ffprobe', [
			'-hide_banner', '-v', 'error', '-select_streams', 'v:0',
			'-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', SOURCE,
		], { encoding: 'utf8' }).trim();
		const [numerator, denominator] = probed.split('/').map(Number);

		expect(stated).toBeCloseTo(numerator! / denominator!, 3);
	});

	describe.skipIf(!hasValidator)('mediastreamvalidator and hlsreport', () => {
		test('a package we wrote has no specification errors', () => {
			const report = validate(path.join(packageDir, 'master.m3u8'), path.join(workDir, 'v.json'));

			expect(complaintsIn(report)).toEqual([]);
			expect(report.variants).toHaveLength(1);
			expect(report.independentSegments).toBe(true);
		});

		test('and the validator would have said so - it fails a playlist that is wrong', () => {
			// A clean report means nothing from a tool that passes everything. An EXTINF longer than
			// twice the target duration is a violation the validator names.
			const directory = path.join(workDir, 'broken');
			cpSync(packageDir, directory, { recursive: true });
			const playlist = path.join(directory, 'playlist-1.m3u8');
			writeFileSync(playlist, readFileSync(playlist, 'utf8').replace(/#EXTINF:[\d.]+,/, '#EXTINF:9,'));

			const report = validate(path.join(directory, 'master.m3u8'), path.join(workDir, 'broken.json'));

			expect(complaintsIn(report).join('\n')).toContain('target duration');
		});

		test('neither authoring rule this fixed is still reported', () => {
			validate(path.join(packageDir, 'master.m3u8'), path.join(workDir, 'a.json'));
			const issues = authoringIssues(path.join(workDir, 'a.json'), path.join(workDir, 'a.html'));

			// The report lists what is still wrong, and plenty is - a one-variant package has no
			// ladder and no I-frame playlist. These two were ours to fix.
			expect(issues.length).toBeGreaterThan(0);
			expect(issues.some(issue => issue.includes('FRAME-RATE'))).toBe(false);
			expect(issues.some(issue => issue.includes('EXT-X-INDEPENDENT-SEGMENTS'))).toBe(false);
		});
	});
});
