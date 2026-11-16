import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CustomSource, FilePathSource, Source, UrlSource } from '../../src/source.js';
import { Logging } from '../../src/logging.js';
import { Reader } from '../../src/reader.js';
import { InputDisposedError } from '../../src/input.js';

const __dirname = new URL('.', import.meta.url).pathname;
const filePath = path.join(__dirname, '../public/video.mp4');

test('readRange returns the requested bytes', async () => {
	const source = new FilePathSource(filePath);
	const ref = source.ref();
	const file = await readFile(filePath);

	expect(await source.readRange(0, 16)).toEqual(new Uint8Array(file.subarray(0, 16)));
	expect(await source.readRange(1000, 1512)).toEqual(new Uint8Array(file.subarray(1000, 1512)));

	ref.free();
});

test('readRange returns an empty array for an empty range', async () => {
	const source = new FilePathSource(filePath);
	const ref = source.ref();

	expect(await source.readRange(64, 64)).toEqual(new Uint8Array(0));

	ref.free();
});

test('readRange returns null past the end of the source', async () => {
	const source = new FilePathSource(filePath);
	const ref = source.ref();
	const size = await source.getSize();

	expect(await source.readRange(size - 4, size)).not.toBe(null);
	expect(await source.readRange(size - 4, size + 1)).toBe(null);
	expect(await source.readRange(size + 100, size + 200)).toBe(null);

	ref.free();
});

/** A source that hands back the same backing buffer on every read, so a view would alias it. */
class SharedBufferSource extends Source {
	readonly buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

	_getFileSize() {
		return this.buffer.length;
	}

	_read() {
		return { bytes: this.buffer, view: new DataView(this.buffer.buffer), offset: 0 };
	}

	_dispose() {}
}

test('readRange hands out a copy the caller owns', async () => {
	const source = new SharedBufferSource();
	const ref = source.ref();

	const first = await source.readRange(0, 4);
	first!.fill(0);

	expect(await source.readRange(0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));

	ref.free();
});

/** An unsized source that provides fewer bytes than asked for, the way a partial HTTP response would. */
class ShortSource extends Source {
	readonly buffer = new Uint8Array([1, 2, 3, 4]);

	_getFileSize() {
		return null;
	}

	_read() {
		return { bytes: this.buffer, view: new DataView(this.buffer.buffer), offset: 0 };
	}

	_dispose() {}
}

/** A sized source that yields fewer bytes than the size it reports, the way a truncated response would. */
class ShortSizedSource extends Source {
	readonly buffer = new Uint8Array([1, 2, 3, 4]);

	_getFileSize() {
		return 16;
	}

	_read() {
		return { bytes: this.buffer, view: new DataView(this.buffer.buffer), offset: 0 };
	}

	_dispose() {}
}

test('requestEntireFile refuses a truncated whole-file read', async () => {
	const source = new ShortSizedSource();
	const ref = source.ref();

	await expect((async () => {
		await new Reader(source).requestEntireFile();
	})()).rejects.toThrow(/Short read/);

	ref.free();
});

test('readRange refuses a short read instead of truncating', async () => {
	const source = new ShortSource();
	const ref = source.ref();

	await expect(source.readRange(0, 16)).rejects.toThrow(/Short read/);
	expect(await source.readRange(0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));

	ref.free();
});

test('readRange rejects invalid ranges', async () => {
	const source = new FilePathSource(filePath);
	const ref = source.ref();

	await expect(source.readRange(-1, 8)).rejects.toThrow(TypeError);
	await expect(source.readRange(8, 4)).rejects.toThrow(TypeError);
	await expect(source.readRange(0.5, 8)).rejects.toThrow(TypeError);

	ref.free();
});

test('reading a disposed source names the range in the error', async () => {
	const source = new FilePathSource(filePath);
	source.ref().free();

	await expect(source.readRange(100, 200)).rejects.toThrow(InputDisposedError);
	await expect(source.readRange(100, 200)).rejects.toThrow(/\[100, 200\)/);
});

test('a source smaller than the first read chunk reads whole, and out-of-range reads return null', async () => {
	const bytes = new Uint8Array(300).fill(7);
	const source = new CustomSource({
		getSize: () => bytes.length,
		read: (start, end) => bytes.subarray(start, Math.min(end, bytes.length)),
	});
	const ref = source.ref();

	// requestEntireFile probes 1024 bytes before any size is known
	const slice = await new Reader(source).requestEntireFile();
	expect(slice!.bytes).toEqual(bytes);

	expect(await source.readRange(200, 400)).toBe(null);

	ref.free();
});

// A read that quietly retries for a minute is usually worth telling the developer about, so the
// logging is on by default. Against an origin expected to flap it is a minute of noise per outage,
// which is what `quietRetries` is for.
test('quietRetries silences the per-failure log without changing the retrying', async () => {
	const run = async (quietRetries: boolean) => {
		const logged: string[] = [];
		const stopListening = Logging.on('error', args => void logged.push(args.map(String).join(' ')));

		let attempts = 0;
		const fetchFn = (async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error('origin is down');
			}
			return new Response(new Uint8Array([1, 2, 3, 4]), {
				status: 200,
				headers: { 'content-length': '4', 'accept-ranges': 'bytes' },
			});
		}) as unknown as typeof fetch;

		try {
			const source = new UrlSource('https://example.invalid/a.bin', {
				fetchFn,
				getRetryDelay: () => 0,
				quietRetries,
			});
			const bytes = await source.readRange(0, 4);
			return { logged, attempts, bytes };
		} finally {
			stopListening();
		}
	};

	const loud = await run(false);
	const quiet = await run(true);

	// Same work either way: it retried the same number of times and got the same bytes
	expect(quiet.attempts).toBe(loud.attempts);
	expect(loud.attempts).toBeGreaterThan(1);
	expect(Array.from(quiet.bytes!)).toEqual(Array.from(loud.bytes!));

	// Only the logging differs
	expect(loud.logged.some(line => line.includes('Retrying failed fetch'))).toBe(true);
	expect(quiet.logged.some(line => line.includes('Retrying failed fetch'))).toBe(false);

	expect(() => new UrlSource('https://example.invalid/a.bin', {
		quietRetries: 'yes' as unknown as boolean,
	})).toThrow(TypeError);
});
