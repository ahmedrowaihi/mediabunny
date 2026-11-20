/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPG was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The transport-stream tables, read back by a decoder that is not this library.
//
// ffmpeg cannot check these: its demuxer does not parse TDT, TOT or the MJD time encoding at all, and
// it exposes nothing of a SCTE-35 section beyond the PID. So the DVB and SCTE-35 tests assert with
// this library's own parsers, or by hand against the spec text - both of which share any misreading of
// the spec with the writer. TSDuck is a separate implementation of the same standards, so it fails
// where a hand parse agrees with itself.
//
// Skipped unless `tstables` is on PATH (`brew install tsduck`); CI has no TSDuck, so this runs locally
// and in any environment that installs it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat, type MpegTsOutputFormatOptions } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { FilePathSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(__dirname, '../public/demo.mp4');

/** A fixed instant, so the decoded time is checked against a stated value rather than a clock. */
const WHEN = new Date('2026-11-19T14:35:07Z');

const hasTsduck = (() => {
	try {
		execFileSync('tstables', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let workDir: string | undefined;

afterAll(() => {
	if (workDir) {
		rmSync(workDir, { recursive: true, force: true });
	}
});

const write = async (options: MpegTsOutputFormatOptions) => {
	using input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(SOURCE) });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const codec = await track.getCodec();
	assert(codec);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new MpegTsOutputFormat(options), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source, { frameRate: 30 });
	await output.start();

	const sink = new EncodedPacketSink(track);
	let written = 0;
	for (let p = await sink.getFirstPacket(); p && written < 300; p = await sink.getNextPacket(p)) {
		await source.add(p, { decoderConfig });
		written++;
	}
	await output.finalize();

	workDir ??= mkdtempSync(path.join(tmpdir(), 'mb-tsduck-'));
	const file = path.join(workDir, `${written}-${Date.now()}.ts`);
	writeFileSync(file, new Uint8Array(output.target.buffer!));
	return file;
};

/** What TSDuck makes of the tables on `pids`. */
const decode = (file: string, pids: number[]) => execFileSync(
	'tstables',
	[file, ...pids.flatMap(pid => ['--pid', String(pid)])],
	{ encoding: 'utf8' },
);

describe.skipIf(!hasTsduck)('DVB tables, decoded by TSDuck', () => {
	test('the TDT and TOT carry the stated time, and the TOT its offsets', async () => {
		const file = await write({
			dvbTime: {
				now: () => WHEN,
				interval: 0.2,
				regions: [{
					country: 'GBR',
					regionId: 0,
					offsetMinutes: 60,
					nextChange: new Date('2027-10-31T02:00:00Z'),
					nextOffsetMinutes: 0,
				}],
			},
		});
		const out = decode(file, [0x14]);

		expect(out, 'a TDT is present').toContain('TDT, TID 0x70');
		expect(out, 'a TOT is present').toContain('TOT, TID 0x73');
		// The MJD + BCD encoding, read back by an implementation that is not ours.
		expect(out, 'the time survives the MJD/BCD encoding').toContain('UTC time: 2026/11/19 14:35:07');
		expect(out).toContain('Country code: GBR');
		expect(out).toContain('Local time offset: 01:00');
		expect(out).toContain('Next change: 2027/10/31 02:00:00');
		expect(out).toContain('Next time offset: 00:00');
		// A TOT is a short section WITH a CRC where a TDT carries none - the EN 300 468 quirk this
		// writer gets right only if TSDuck agrees the CRC covers what it thinks it covers.
		expect(out, 'the TOT CRC checks out').toMatch(/CRC32: 0x[0-9A-F]{8} \(OK\)/);
	});

	test('the NIT names the network and agrees with the SDT on original_network_id', async () => {
		const file = await write({
			service: { name: 'Fork One', provider: 'Mediabunny', originalNetworkId: 0x233a },
			network: { id: 0x2024, name: 'Mediabunny Fork Net', interval: 0.2 },
		});
		const nit = decode(file, [0x10]);
		const sdt = decode(file, [0x11]);

		expect(nit).toContain('NIT Actual, TID 0x40');
		expect(nit).toContain('Network Id: 0x2024');
		expect(nit).toContain('Name: "Mediabunny Fork Net"');
		// A receiver associates a service with its network by this pair, so the two tables disagreeing
		// is a real defect that neither table alone shows.
		expect(nit, 'the NIT states the SDT\'s original_network_id').toContain('Original Network Id: 0x233A');
		expect(sdt).toContain('Original Network Id: 0x233A');
		expect(sdt).toContain('Service: "Fork One", Provider: "Mediabunny"');
	});
});
