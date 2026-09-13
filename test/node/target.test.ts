import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { isBun, setIsBunForTesting } from '../../src/misc.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

test('BufferTarget onFinalize callback', async () => {
	let received: ArrayBuffer | null = null;
	let asyncCallbackDone = false;

	using input = new Input({
		source: new FilePathSource(samplePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget({
			onFinalize: async (buffer) => {
				received = buffer;
				await new Promise(resolve => setTimeout(resolve, 20));
				asyncCallbackDone = true;
			},
		}),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	expect(received).not.toBeNull();
	expect(received).toBe(output.target.buffer);
	expect(asyncCallbackDone).toBe(true);
	expect(output.target.buffer!.byteLength).toBeGreaterThan(0);
});

/**
 * Bun (JSC) never releases the memory backing a resizable ArrayBuffer, so `BufferTarget` must take
 * its copy-grow path there. The fork's suite runs on Node, where the leak does not reproduce, so
 * these pin the MECHANISM rather than measuring memory: a rebase that decides
 * `!isBun() &&` is redundant fails here instead of silently reintroducing ~940KB per conversion.
 */
describe('BufferTarget resizable-ArrayBuffer gate', () => {
	afterEach(() => setIsBunForTesting(null));

	const supportsResize = () => {
		const target = new BufferTarget();
		// `_supportsResize` is decided in the constructor, before any write.
		return (target as unknown as { _supportsResize: boolean })._supportsResize;
	};

	test('detects the runtime from globalThis.Bun', () => {
		// The gate tests below stub the cache, so without this nothing exercises the detection
		// itself — `isBun()` could be hardcoded either way and they would all still pass.
		const global = globalThis as { Bun?: unknown };
		const had = 'Bun' in global;
		const original = global.Bun;

		try {
			setIsBunForTesting(null);
			delete global.Bun;
			expect(isBun()).toBe(false);

			setIsBunForTesting(null);
			global.Bun = {};
			expect(isBun()).toBe(true);
		} finally {
			if (had) global.Bun = original;
			else delete global.Bun;
		}
	});

	test('uses the resizable fast path off Bun', () => {
		setIsBunForTesting(false);
		expect(supportsResize()).toBe('resize' in new ArrayBuffer(0));
	});

	test('refuses the resizable path on Bun', () => {
		setIsBunForTesting(true);
		expect(supportsResize()).toBe(false);
	});

	test('still produces a correct buffer on the copy-grow path', async () => {
		setIsBunForTesting(true);

		using input = new Input({ source: new FilePathSource(samplePath), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await (await Conversion.init({ input, output })).execute();

		// Growing by copy must not truncate or corrupt what the resizable path would have produced.
		const buffer = output.target.buffer;
		expect(buffer).not.toBeNull();
		expect(buffer!.byteLength).toBeGreaterThan(0);

		using readBack = new Input({ source: new BufferSource(new Uint8Array(buffer!)), formats: ALL_FORMATS });
		expect(await readBack.computeDuration()).toBeGreaterThan(0);
	});
});
