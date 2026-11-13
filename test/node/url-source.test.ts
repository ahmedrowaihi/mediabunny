import { expect, test, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { assert, promiseWithResolvers, rejectAfter } from '../../src/misc.js';
import { FileSlice, Reader, readBytes } from '../../src/reader.js';
import {
	ALL_FORMATS,
	EncodedPacket,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	FilePathSource,
	Input,
	Logging,
	LogLevel,
	MP4,
	RetryTimeoutError,
	UrlSource,
	type UrlSourceOptions,
	BufferTarget,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const videoFilePath = path.join(__dirname, '..', 'public/video.mp4');

test('UrlSource works against a server without range request support', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			source: new UrlSource(server.url),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		// The default cache size exceeds the file size, so random access back to the start of the file still works
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource throws when reading from an evicted region in sequential mode', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// Much smaller than the file, so the start of the file will get evicted during full iteration
			source: new UrlSource(server.url, { maxCacheSize: 2 ** 20 /* 1 MiB */ }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		await expect(sink.getFirstPacket()).rejects.toThrow(/already-evicted part of the cache/);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource resumes with correct data when the connection dies in sequential mode', async () => {
	// The server kills the connection partway through the first two responses. Since it doesn't support range
	// requests, each resume response starts back at byte 0 and the already-delivered prefix must be skipped over
	// exactly; any off-by-one would corrupt the packet data.
	const server = await startRangelessServer({ responseByteLimits: [700_000, 1_500_000] });
	const logs = captureLogs();

	try {
		using referenceInput = new Input({
			source: new FilePathSource(videoFilePath),
			formats: ALL_FORMATS,
		});

		const referenceTrack = await referenceInput.getPrimaryVideoTrack();
		if (!referenceTrack) throw new Error('No video track found');

		const referencePackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(referenceTrack).packets()) {
			referencePackets.push(packet);
		}

		using input = new Input({
			source: new UrlSource(server.url, { getRetryDelay: () => 0 }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		let packetIndex = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			const referencePacket = referencePackets[packetIndex]!;

			expect(packet.timestamp).toBe(referencePacket.timestamp);
			expect(Buffer.from(packet.data).equals(Buffer.from(referencePacket.data))).toBe(true);

			packetIndex++;
		}

		expect(packetIndex).toBe(referencePackets.length);

		// Initial request plus one resume per killed response
		expect(server.requestCount()).toBe(3);
		expect(logs.errors.filter(x => x.includes('Attempting to resume'))).toHaveLength(2);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource with maxCacheSize: Infinity allows random access against a rangeless server', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// This is the escape hatch recommended by the eviction error message: with an infinite cache, nothing
			// is ever evicted and random access keeps working
			source: new UrlSource(server.url, { maxCacheSize: Infinity }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource in sequential mode downloads lazily and aborts the response on dispose', async () => {
	// The resource is padded to a size far beyond what kernel socket buffers can swallow. This matters: the server
	// can only observe the client's laziness through backpressure, and on some systems (like Linux with its TCP
	// buffer autotuning), the kernel happily buffers multiple megabytes of sent data that the client never read.
	const paddingSize = 2 ** 26; // 64 MiB
	const totalSize = fs.statSync(videoFilePath).size + paddingSize;

	const server = await startRangelessServer({ trailingPaddingSize: paddingSize });
	const logs = captureLogs();

	const input = new Input({
		source: new UrlSource(server.url),
		formats: ALL_FORMATS,
	});

	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		// If the client were downloading eagerly, the entire resource would easily arrive during this window.
		// Instead, the server is expected to stall, since data is only pulled down when reads demand it.
		await new Promise(resolve => setTimeout(resolve, 3000));

		expect(server.bytesSent()).toBeLessThan(totalSize / 2);

		// The response is merely suspended, not dead: reading still works
		const sink = new EncodedPacketSink(track);
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		input.dispose();

		// Give the abort a moment to propagate to the server
		await new Promise(resolve => setTimeout(resolve, 250));

		// Disposal terminated the response early, long before the entire resource was sent
		expect(server.abortedResponses()).toBe(1);
		expect(server.bytesSent()).toBeLessThan(totalSize / 2);
	} finally {
		input.dispose();
		logs.stop();
		server.close();
	}
}, 10_000);

test('UrlSource reads the full decoded body of a compressed response', async () => {
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Length': compressed.byteLength,
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource reads the full decoded body of a compressed 206 response', async () => {
	// A 206 carrying Content-Encoding states its Content-Range in compressed bytes, so trusting that
	// total truncates the decoded document.
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(206, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
			'Content-Length': compressed.byteLength,
			'Accept-Ranges': 'bytes',
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource relative URL outside a window against a rangeless server', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		// No window means no base URL to resolve against, just like in a worker
		const fetchFn: typeof fetch = (url, init) => fetch(new URL(url as string, server.url), init);
		using input = new Input({
			source: new UrlSource('/video.mp4', { fetchFn }),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(MP4);
		expect(logs.warnings.some(x => x.includes('did not respond to a range request'))).toBe(true);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource prefetches growing blocks when a file is read back to front', async () => {
	const fileSize = 16 * 2 ** 20;
	let requestCount = 0;

	const server = http.createServer((req, res) => {
		requestCount++;

		const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
		assert(match);
		const start = Number(match[1]);
		const end = match[2] ? Math.min(Number(match[2]) + 1, fileSize) : fileSize;

		res.on('error', () => {}); // The client may abort the connection at any time
		res.writeHead(206, {
			'Content-Length': end - start,
			'Content-Range': `bytes ${start}-${end - 1}/${fileSize}`,
		});
		res.end(Buffer.alloc(end - start));
	});
	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/file`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		// Like a demuxer rewinding packet by packet, 8 MiB back from the end
		for (let pos = fileSize - 188; pos >= fileSize - 8 * 2 ** 20; pos -= 188) {
			await reader.requestSlice(pos, 4);
		}

		expect(requestCount).toBeLessThanOrEqual(20);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

const startRangelessServer = async (
	options: { responseByteLimits?: number[]; trailingPaddingSize?: number } = {},
) => {
	const fileSize = fs.statSync(videoFilePath).size;
	const paddingSize = options.trailingPaddingSize ?? 0;
	let requestCount = 0;
	let bytesSent = 0;
	let abortedResponses = 0;

	const server = http.createServer((req, res) => {
		const byteLimit = options.responseByteLimits?.[requestCount] ?? Infinity;
		requestCount++;

		res.on('error', () => {}); // The client may abort the connection at any time
		res.on('close', () => {
			if (!res.writableFinished) {
				abortedResponses++;
			}
		});
		res.writeHead(200, {
			'Content-Type': 'video/mp4',
			'Content-Length': fileSize + paddingSize,
		});

		// Stream the file with backpressure and a small chunk size, so that the amount of sent bytes closely
		// tracks how much the client actually consumes
		const stream = fs.createReadStream(videoFilePath, { highWaterMark: 2 ** 14 });
		let bytesSentThisResponse = 0;

		stream.on('data', (chunk) => {
			const canContinue = res.write(chunk);
			bytesSent += chunk.length;
			bytesSentThisResponse += chunk.length;

			if (bytesSentThisResponse >= byteLimit) {
				stream.destroy();
				res.destroy(); // Kill the connection mid-response

				return;
			}

			if (!canContinue) {
				stream.pause();
				res.once('drain', () => stream.resume());
			}
		});
		stream.on('end', () => {
			if (paddingSize === 0) {
				res.end();
				return;
			}

			// Append a giant 'free' box: valid ISOBMFF, but never read by the demuxer
			const header = Buffer.alloc(8);
			header.writeUInt32BE(paddingSize, 0);
			header.write('free', 4, 'latin1');

			const zeroes = Buffer.alloc(2 ** 14);
			let paddingSent = 0;

			const writeMore = () => {
				while (paddingSent < paddingSize) {
					const chunk = paddingSent === 0
						? header
						: zeroes.subarray(0, Math.min(paddingSize - paddingSent, zeroes.length));

					paddingSent += chunk.length;
					bytesSent += chunk.length;

					if (!res.write(chunk)) {
						res.once('drain', writeMore);
						return;
					}
				}

				res.end();
			};
			writeMore();
		});
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unexpected server address');

	return {
		url: `http://localhost:${address.port}/video.mp4`,
		requestCount: () => requestCount,
		bytesSent: () => bytesSent,
		abortedResponses: () => abortedResponses,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

test('UrlSource read events with a Range header', async () => {
	const bytes = makeRamp(256);
	const logs = captureLogs();

	try {
		for (const supportsRanges of [true, false]) {
			const server = await startServer((req, res) => {
				if (!supportsRanges) {
					res.writeHead(200, { 'Content-Length': bytes.length });
					res.end(bytes);
					return;
				}

				const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range!)![1]);
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
					'Content-Length': bytes.length - start,
				});
				res.end(bytes.subarray(start));
			});

			try {
				const source = new UrlSource(server.url, { requestInit: { headers: { Range: 'bytes=100-199' } } });
				const reads: { start: number; end: number }[] = [];
				source.on('read', read => reads.push(read));
				using ref = source.ref();

				const slice = await new Reader(ref.source).requestSlice(0, 4);
				expect([...readBytes(slice!, 4)]).toEqual([100, 101, 102, 103]);
				expect(reads).toEqual([{ start: 0, end: 100 }]);
			} finally {
				server.close();
			}
		}
	} finally {
		logs.stop();
	}
});

test('UrlSource releases the connection of a failed response', async () => {
	const responseClosed = promiseWithResolvers();
	const server = await startServer((req, res) => {
		res.on('close', responseClosed.resolve);
		res.writeHead(404);
		res.write('Not found'); // And the body never ends
	});

	try {
		using ref = new UrlSource(server.url).ref();

		await expect(new Reader(ref.source).requestSlice(0, 4)).rejects.toThrow('404');
		await Promise.race([responseClosed.promise, rejectAfter(1000)]);
	} finally {
		server.close();
	}
});

test('UrlSource on an empty resource', async () => {
	const server = await startServer((req, res) => {
		res.writeHead(416, { 'Content-Range': 'bytes */0' });
		res.end();
	});

	try {
		using input = new Input({
			source: new UrlSource(server.url),
			formats: ALL_FORMATS,
		});
		expect(await input.source.getSize()).toBe(0);
		expect(await input.canRead()).toBe(false);
	} finally {
		server.close();
	}
});

/** Collects logged warnings and errors, keeping the console clean while doing so. */
const captureLogs = () => {
	const warnings: string[] = [];
	const errors: string[] = [];
	const unsubscribeWarn = Logging.on('warn', args => warnings.push(args.map(String).join(' ')));
	const unsubscribeError = Logging.on('error', args => errors.push(args.map(String).join(' ')));

	const previousLogLevel = Logging.level;
	Logging.level = LogLevel.Silent;

	return {
		warnings,
		errors,
		stop: () => {
			unsubscribeWarn();
			unsubscribeError();
			Logging.level = previousLogLevel;
		},
	};
};

test('UrlSource error message with a Request', async () => {
	const server = await startServer((req, res) => {
		res.writeHead(404);
		res.end();
	});

	try {
		const source = new UrlSource(new Request(server.url));
		using ref = source.ref();

		await expect(new Reader(ref.source).requestSlice(0, 4)).rejects.toThrow(`Error fetching ${server.url}: 404`);
	} finally {
		server.close();
	}
});

test('UrlSource Request with custom headers', async () => {
	const bytes = makeRamp(256);
	const server = await startServer((req, res) => {
		if (req.headers['x-token'] !== 'secret') {
			res.writeHead(403);
			res.end();
			return;
		}

		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range!)![1]);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
			'Content-Length': bytes.length - start,
		});
		res.end(bytes.subarray(start));
	});

	try {
		const source = new UrlSource(new Request(server.url, { headers: { 'X-Token': 'secret' } }));
		using ref = source.ref();

		const slice = await new Reader(ref.source).requestSlice(10, 4);
		expect([...readBytes(slice!, 4)]).toEqual([10, 11, 12, 13]);
	} finally {
		server.close();
	}
});

test('UrlSource child requests made like the root one', async () => {
	const bytes = makeRamp(256);
	const server = await startServer((req, res) => {
		if (req.headers['x-token'] !== 'secret') {
			res.writeHead(403);
			res.end();
			return;
		}

		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range!)![1]);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
			'Content-Length': bytes.length - start,
		});
		res.end(bytes.subarray(start));
	});

	try {
		const source = new UrlSource(
			new Request(server.url, { headers: { 'X-Token': 'secret' } }),
			{ requestInit: { headers: { Range: 'bytes=100-' } } },
		);

		// The child gets the request's headers, but the Range header only applies to the root
		using childRef = await source._resolveRequest({
			path: server.url.replace('video.mp4', 'segment.ts'),
			isRoot: false,
		});
		const slice = await new Reader(childRef.source).requestSlice(10, 4);
		expect([...readBytes(slice!, 4)]).toEqual([10, 11, 12, 13]);
	} finally {
		server.close();
	}
});

const startServer = async (handler: http.RequestListener) => {
	const server = http.createServer(handler);
	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Unexpected server address');
	}

	return {
		url: `http://localhost:${address.port}/video.mp4`,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

const makeRamp = (length: number) => {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		bytes[i] = i;
	}

	return bytes;
};

test('UrlSource queued read straddling the end', async () => {
	const data = createTestData(4 * 2 ** 20);
	const source = new UrlSource('https://example.com/file.bin', {
		parallelism: 1,
		fetchFn: createRangeFetchFn(data, { exposeSize: () => true }),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// The read at the end gets queued behind the first one, whose response then reveals the size
	const first = reader.requestSlice(0, 8);
	const last = reader.requestSlice(data.length - 4, 8);

	expect(await first).not.toBeNull();
	expect(await last).toBeNull();
});

test('UrlSource queued prefetch beyond the end', async () => {
	const data = createTestData(22 * 2 ** 16);
	const gate = promiseWithResolvers();
	const source = new UrlSource('https://example.com/file.bin', {
		parallelism: 1,
		fetchFn: createRangeFetchFn(data, {
			exposeSize: start => start === 2 ** 19,
			beforeResponse: start => start === 2 ** 19 ? gate.promise : null,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// Caches [0, 512 KiB) and [896 KiB, end) without learning the size
	expect(await reader.requestSlice(0, 524_288)).not.toBeNull();
	expect(await reader.requestSlice(1_000_000, 441_792)).not.toBeNull();

	// The hole at 512 KiB takes the only worker, so the prefetch past the end gets queued. Then, the gated
	// response reveals the size.
	const slice = reader.requestSlice(600_000, 600_000);
	gate.resolve();

	expectBytes(await slice, data.subarray(600_000, 1_200_000));
});

test('UrlSource queued read with capped responses', async () => {
	const data = createTestData(4 * 2 ** 20);
	const source = new UrlSource('https://example.com/file.bin', {
		parallelism: 1,
		fetchFn: createRangeFetchFn(data, {
			exposeSize: () => true,
			maxResponseLength: 2 ** 15,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// The second read gets queued before the size is known
	const first = reader.requestSlice(0, 8);
	const second = reader.requestSlice(2 ** 21 + 2 ** 17, 8);

	expectBytes(await first, data.subarray(0, 8));
	expectBytes(await second, data.subarray(2 ** 21 + 2 ** 17, 2 ** 21 + 2 ** 17 + 8));
});

test('UrlSource read spanning a worker that hits the end', async () => {
	const data = createTestData(1_600_000);
	const gate = promiseWithResolvers();
	const source = new UrlSource('https://example.com/file.bin', {
		fetchFn: createRangeFetchFn(data, {
			exposeSize: () => false,
			beforeResponse: start => start === 2 ** 19 ? gate.promise : null,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// Caches [0, 512 KiB) and [896 KiB, 1408 KiB) without learning the size
	expect(await reader.requestSlice(0, 524_288)).not.toBeNull();
	expect(await reader.requestSlice(1_000_000, 441_792)).not.toBeNull();

	// Both holes of this read get a worker; the one for the second hole hits the end first
	const slice = reader.requestSlice(600_000, 900_000);
	await vi.waitFor(() => expect(source._orchestrator.fileSize).toBe(data.length));
	gate.resolve();

	expectBytes(await slice, data.subarray(600_000, 1_500_000));
});

test('UrlSource read with capped responses and unknown size', async () => {
	const data = createTestData(4 * 2 ** 20);
	const source = new UrlSource('https://example.com/file.bin', {
		fetchFn: createRangeFetchFn(data, {
			exposeSize: () => false,
			maxResponseLength: 2 ** 15,
			bare416PastEnd: true,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// The worker's target is a speculative prefetch end, but the read itself is well within the file, so a capped
	// response cut off inside it should not be taken for the end of the file
	expectBytes(await reader.requestSlice(0, 100_000), data.subarray(0, 100_000));
	expect(source._orchestrator.fileSize).toBe(null);

	// Reading on past the end gets a 416 without a size, which still pins the end down
	expectBytes(await reader.requestSlice(data.length - 100_000, 100_000), data.subarray(data.length - 100_000));
	await vi.waitFor(() => expect(source._orchestrator.fileSize).toBe(data.length));
});

const createTestData = (length: number) => {
	const data = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		data[i] = (7 * i + (i >> 8)) & 0xff;
	}

	return data;
};

const createRangeFetchFn = (data: Uint8Array, options: {
	exposeSize: (start: number) => boolean;
	beforeResponse?: (start: number) => Promise<void> | null;
	maxResponseLength?: number;
	bare416PastEnd?: boolean;
}) => {
	return async (url: string | URL | Request, init?: RequestInit) => {
		const range = new Headers(init?.headers).get('Range');
		const start = Number(/^bytes=(\d+)-$/.exec(range!)![1]);
		const end = Math.min(data.length, start + (options.maxResponseLength ?? Infinity));

		await options.beforeResponse?.(start);

		if (options.bare416PastEnd && start >= data.length) {
			return new Response(null, { status: 416 });
		}

		let pos = start;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pos === end) {
					controller.close();
					return;
				}

				const chunkEnd = Math.min(end, pos + 2 ** 16);
				controller.enqueue(data.slice(pos, chunkEnd));
				pos = chunkEnd;
			},
		});

		return new Response(body, {
			status: 206,
			headers: {
				'Content-Range': `bytes ${start}-${end - 1}/${options.exposeSize(start) ? data.length : '*'}`,
			},
		});
	};
};

const expectBytes = (slice: FileSlice | null, expected: Uint8Array) => {
	expect(slice).not.toBeNull();
	expect(Buffer.from(readBytes(slice!, slice!.length)).equals(Buffer.from(expected))).toBe(true);
};
/** A port nothing listens on, so a connect is refused at once rather than hanging. */
const closedPort = async () => {
	const server = http.createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>(resolve => server.close(() => resolve()));
	return port;
};

test('a read against a closed port rejects instead of retrying forever', async () => {
	// The default getRetryDelay returns a delay for every failure and never null, so without a budget
	// this read never settles and a caller has no rejection to handle.
	using input = new Input({
		source: new UrlSource(`http://127.0.0.1:${await closedPort()}/video.mp4`, { retryTimeout: 1 }),
		formats: ALL_FORMATS,
	});

	const startedAt = Date.now();
	await expect(input.getFormat()).rejects.toThrow(RetryTimeoutError);
	expect(Date.now() - startedAt).toBeLessThan(20_000);
});

test('the rejection carries the failure that ended it', async () => {
	using input = new Input({
		source: new UrlSource(`http://127.0.0.1:${await closedPort()}/video.mp4`, { retryTimeout: 0 }),
		formats: ALL_FORMATS,
	});

	const error = await input.getFormat().then(() => null, (thrown: unknown) => thrown);
	assert(error instanceof RetryTimeoutError);
	expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
});

test('retryTimeout: null still retries, and disposing stops it', async () => {
	let calls = 0;
	const fetchFn = () => {
		calls++;
		return Promise.reject(new TypeError('fetch failed'));
	};

	const input = new Input({
		source: new UrlSource('http://127.0.0.1:1/video.mp4', { fetchFn, retryTimeout: null }),
		formats: ALL_FORMATS,
	});

	const settled = input.getFormat().then(() => 'resolved', () => 'rejected');
	while (calls < 2) {
		await new Promise(resolve => setTimeout(resolve, 50));
	}

	const callsAtDispose = calls;
	input.dispose();
	expect(await settled).toBe('rejected');

	// The loop is over, not merely abandoned: nothing fetches after the dispose
	await new Promise(resolve => setTimeout(resolve, 2500));
	expect(calls).toBe(callsAtDispose);
});

test('a retry loop ends when the last holder lets go, and not before', async () => {
	// free() is the documented lifecycle handle, so it has to end an in-flight retry — a read that
	// outlives its source is a socket and a timer per abandoned request on a server. But Input takes a
	// ref of its own, so an extra ref going away must *not* stop a read the Input is still waiting on.
	let calls = 0;
	const fetchFn = () => {
		calls++;
		return Promise.reject(new TypeError('fetch failed'));
	};

	const source = new UrlSource('http://127.0.0.1:1/video.mp4', { fetchFn, retryTimeout: null });
	const extraRef = source.ref();
	const input = new Input({ source, formats: ALL_FORMATS });

	const settled = input.getFormat().then(() => 'resolved', () => 'rejected');
	while (calls < 2) {
		await new Promise(resolve => setTimeout(resolve, 50));
	}

	// Input still holds its own ref, so this one going away changes nothing
	const callsAtFree = calls;
	extraRef.free();
	expect(source._disposed).toBe(false);
	await new Promise(resolve => setTimeout(resolve, 1500));
	expect(calls).toBeGreaterThan(callsAtFree);

	// The last ref goes with the Input, and now the loop is over rather than abandoned
	input.dispose();
	expect(await settled).toBe('rejected');
	expect(source._disposed).toBe(true);

	const callsAtDispose = calls;
	await new Promise(resolve => setTimeout(resolve, 2500));
	expect(calls).toBe(callsAtDispose);
});

test('a request that is accepted and never answered is abandoned, not waited on', async () => {
	// retryTimeout bounds failing requests; this one never fails, so without a per-request deadline
	// the read hangs for as long as the socket stays open.
	const hanging = http.createServer(() => { /* accept, never respond */ });
	await new Promise<void>(resolve => hanging.listen(0, '127.0.0.1', resolve));
	const { port } = hanging.address() as { port: number };

	try {
		using input = new Input({
			source: new UrlSource(`http://127.0.0.1:${port}/video.mp4`, {
				requestTimeout: 1,
				retryTimeout: 3,
			}),
			formats: ALL_FORMATS,
		});

		const startedAt = Date.now();
		await expect(input.getFormat()).rejects.toThrow(RetryTimeoutError);
		expect(Date.now() - startedAt).toBeLessThan(30_000);
	} finally {
		hanging.closeAllConnections();
		await new Promise<void>(resolve => hanging.close(() => resolve()));
	}
});

// A sparse random-access pass - a few packets around each key frame of a long file - is the opposite of the
// access pattern the default prefetch profile is tuned for. Its read region grows exponentially while reads
// keep landing in it, and reads a second apart in a high-bitrate file always do, so the pass ends up fetching
// most of the file for a fraction of it. `prefetchProfile` is the way out; these measure that it is.

const GOP_LENGTH = 50;
const PACKET_COUNT = 500;

/**
 * Builds an MP4 whose key frames sit far enough apart for prefetch growth to dominate the bytes read, with a
 * tiny interleaved audio track: reading that track alone is strictly sequential and still consumes about 1% of
 * the bytes around it, which is the other side of the trade the profiles make.
 */
const buildSparseKeyFrameFile = async () => {
	const keyFramePayload = new Uint8Array(200_000);
	const deltaPayload = new Uint8Array(50_000);
	const audioPayload = new Uint8Array(400);
	const videoMeta = { decoderConfig: { codec: 'vp8' as const, codedWidth: 1920, codedHeight: 1080 } };
	const audioMeta = {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48_000,
			description: new Uint8Array([0x11, 0x90]),
		},
	};

	const target = new BufferTarget();
	const output = new Output({ target, format: new Mp4OutputFormat() });
	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('aac');
	output.addVideoTrack(videoSource, { frameRate: 25 });
	output.addAudioTrack(audioSource);
	await output.start();

	for (let i = 0; i < PACKET_COUNT; i++) {
		const isKeyFrame = i % GOP_LENGTH === 0;
		await videoSource.add(
			new EncodedPacket(
				isKeyFrame ? keyFramePayload : deltaPayload,
				isKeyFrame ? 'key' : 'delta',
				i / 25,
				1 / 25,
			),
			videoMeta,
		);

		for (let j = 0; j < 2; j++) {
			const index = 2 * i + j;
			await audioSource.add(new EncodedPacket(audioPayload, 'key', index * 0.02, 0.02), audioMeta);
		}
	}

	await output.finalize();
	return new Uint8Array(target.buffer!);
};

/** Counts the bytes read out of response bodies, and the requests they arrived in, for one read. */
const measuredSource = (url: string, prefetchProfile: UrlSourceOptions['prefetchProfile']) => {
	const counts = { bytesRead: 0, requests: 0 };

	// Counted out of the response bodies rather than at the server: the reader asks for open-ended ranges and
	// cancels them once satisfied, so what the server was asked to send overstates by the cancelled remainder
	const fetchFn: typeof fetch = async (input, init) => {
		counts.requests++;

		const response = await fetch(input as RequestInfo, init);
		if (!response.body) {
			return response;
		}

		const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				counts.bytesRead += chunk.byteLength;
				controller.enqueue(chunk);
			},
		}));

		return new Response(counted, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};

	return { source: new UrlSource(url, { prefetchProfile, fetchFn }), counts };
};

/** Reads each key frame plus the three packets after it, the shape of a per-title complexity pass. */
const sparseRead = async (url: string, prefetchProfile: UrlSourceOptions['prefetchProfile']) => {
	const { source, counts } = measuredSource(url, prefetchProfile);

	using input = new Input({ source, formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	let packetBytes = 0;
	let points = 0;

	let keyPacket = await sink.getFirstKeyPacket();
	while (keyPacket) {
		points++;
		packetBytes += keyPacket.byteLength;

		let packet: EncodedPacket | null = keyPacket;
		for (let i = 0; i < 3 && packet; i++) {
			packet = await sink.getNextPacket(packet);
			if (packet) {
				packetBytes += packet.byteLength;
			}
		}

		keyPacket = await sink.getNextKeyPacket(keyPacket);
	}

	return { ...counts, packetBytes, points };
};

test('UrlSource fetches only what a sparse random-access read asks for when told to', async () => {
	const bytes = await buildSparseKeyFrameFile();

	const server = http.createServer((req, res) => {
		const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
		const start = match ? Number(match[1]) : 0;
		const end = match && match[2] ? Math.min(Number(match[2]) + 1, bytes.length) : bytes.length;

		res.writeHead(match ? 206 : 200, {
			'Content-Type': 'video/mp4',
			'Content-Length': String(end - start),
			'Accept-Ranges': 'bytes',
			...(match ? { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` } : {}),
		});
		// The reader cancels responses it no longer needs, which surfaces here as a write to a dead socket
		res.on('error', () => {});
		res.end(bytes.subarray(start, end));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address === 'object');
		const url = `http://localhost:${address.port}/video.mp4`;

		const none = await sparseRead(url, 'none');
		const fileSystem = await sparseRead(url, 'fileSystem');
		const dflt = await sparseRead(url, undefined);

		expect(none.points).toBe(PACKET_COUNT / GOP_LENGTH);
		expect(none.packetBytes).toBe(dflt.packetBytes);

		// The packets asked for, plus 30%, plus 1% of the file for the index - which measures well under that
		expect(none.bytesRead).toBeLessThanOrEqual(1.3 * none.packetBytes + bytes.length / 100);

		// `fileSystem` rounds each read out to 64 KiB rather than growing, so it lands between the two: it
		// does not meet the bound above, but it pays one request per point instead of one per read
		expect(fileSystem.bytesRead).toBeGreaterThan(none.bytesRead);
		expect(fileSystem.bytesRead).toBeLessThan(dflt.bytesRead);

		// And the default is what the request was about: it reads multiples of what it was asked for
		expect(dflt.bytesRead).toBeGreaterThan(2 * none.bytesRead);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}, 20_000);

test('UrlSource keeps its request count down for a sequential read that consumes little of it', async () => {
	// The control on the profile above: this read is sequential, so the default is right to prefetch, and it
	// consumes about 1% of the bytes around it, so a rule that keyed off how much of a region gets consumed
	// would switch prefetching off here and pay a round trip per packet instead. Bytes and round trips are
	// what the profiles trade against each other, and only the caller knows which it is paying for.
	const bytes = await buildSparseKeyFrameFile();

	const server = http.createServer((req, res) => {
		const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
		const start = match ? Number(match[1]) : 0;
		const end = match && match[2] ? Math.min(Number(match[2]) + 1, bytes.length) : bytes.length;

		res.writeHead(match ? 206 : 200, {
			'Content-Type': 'video/mp4',
			'Content-Length': String(end - start),
			'Accept-Ranges': 'bytes',
			...(match ? { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` } : {}),
		});
		res.on('error', () => {});
		res.end(bytes.subarray(start, end));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address === 'object');
		const url = `http://localhost:${address.port}/video.mp4`;

		const readAudio = async (prefetchProfile: UrlSourceOptions['prefetchProfile']) => {
			const { source, counts } = measuredSource(url, prefetchProfile);

			using input = new Input({ source, formats: ALL_FORMATS });
			const track = await input.getPrimaryAudioTrack();
			assert(track);

			let packetBytes = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				packetBytes += packet.byteLength;
			}

			return { ...counts, packetBytes };
		};

		const dflt = await readAudio(undefined);
		const none = await readAudio('none');

		// The track is a fraction of the file, which is what makes this the awkward case
		expect(dflt.packetBytes).toBeLessThan(bytes.length / 20);
		expect(none.packetBytes).toBe(dflt.packetBytes);

		// `none` reads far fewer bytes and pays for it in requests, which is the whole trade
		expect(none.bytesRead).toBeLessThan(dflt.bytesRead);
		expect(none.requests).toBeGreaterThan(5 * dflt.requests);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}, 20_000);
