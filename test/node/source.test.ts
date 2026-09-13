import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FilePathSource, Source } from '../../src/source.js';
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
