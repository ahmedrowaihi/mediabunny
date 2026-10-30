import { appendFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import path from 'node:path';

// The HLS input tests read a captured corpus over HTTP rather than from disk, because `UrlSource` is
// half of what they test: range requests, redirects, relative URI resolution against a playlist's own
// URL. The corpus lives in test/fixtures/hls/<host>/<path>, so an original URL maps to a local one by
// moving its host into the first path segment.

const FIXTURE_ROOT = path.join(new URL('.', import.meta.url).pathname, '../fixtures/hls');

const CONTENT_TYPES: Record<string, string> = {
	'.m3u8': 'application/vnd.apple.mpegurl',
	'.mpd': 'application/dash+xml',
	'.ts': 'video/mp2t',
	'.mp4': 'video/mp4',
	'.m4s': 'video/iso.segment',
	'.aac': 'audio/aac',
	'.vtt': 'text/vtt',
};

/** A captured file's path on disk; the query string is part of a CDN URL's identity, so it is part of the name. */
const fixturePathFor = (requestUrl: string): string => {
	const url = new URL(requestUrl, 'http://127.0.0.1');
	const suffix = url.search ? `__${encodeURIComponent(url.search.slice(1))}` : '';
	return path.join(FIXTURE_ROOT, decodeURIComponent(url.pathname).replace(/^\//, '') + suffix);
};

/**
 * A playlist states some of its URIs absolutely, against the host it was captured from. Those have to
 * point back here, or the test reaches the real CDN and stops being local.
 */
const rewriteAbsoluteUrls = (body: string, origin: string): string =>
	body.replace(/https?:\/\/([a-z0-9.-]+)\//gi, (_match, host: string) => `${origin}/${host}/`);

const isTextual = (filePath: string) => filePath.endsWith('.m3u8') || filePath.endsWith('.mpd');

// A live stream is a fixture too: these are real captured segments, listed by a playlist that gains one
// more of them on every fetch and never writes #EXT-X-ENDLIST. That is what makes the edge advance, so
// waiting for it can be tested without a third-party live stream.
const LIVE_PATH = '/__live__/media.m3u8';
const LIVE_SEGMENT_DIR = 'playertest.longtailvideo.com/adaptive/artbeats';
const LIVE_SEGMENTS = [
	'fms_sampleFrag1Num0.ts', 'fms_sampleFrag1Num1.ts', 'fms_sampleFrag2Num2.ts', 'fms_sampleFrag3Num3.ts',
	'fms_sampleFrag4Num4.ts', 'fms_sampleFrag5Num5.ts', 'fms_sampleFrag6Num6.ts', 'fms_sampleFrag7Num7.ts',
	'fms_sampleFrag8Num8.ts', 'fms_sampleFrag9Num9.ts', 'fms_sampleFrag10Num10.ts', 'fms_sampleFrag11Num11.ts',
	'fms_sampleFrag12Num12.ts', 'fms_sampleFrag13Num13.ts', 'fms_sampleFrag14Num14.ts',
];
/** Segments the first fetch exposes; every later fetch exposes one more. */
const LIVE_INITIAL_SEGMENTS = 3;
/** Seconds per segment, and the playlist's target duration — the refresh interval is derived from it. */
export const LIVE_SEGMENT_DURATION = 8;

const liveMediaPlaylist = (segmentCount: number, programDateTime: Date) => [
	'#EXTM3U',
	'#EXT-X-VERSION:3',
	`#EXT-X-TARGETDURATION:${LIVE_SEGMENT_DURATION}`,
	'#EXT-X-MEDIA-SEQUENCE:0',
	`#EXT-X-PROGRAM-DATE-TIME:${programDateTime.toISOString()}`,
	...LIVE_SEGMENTS.slice(0, segmentCount).flatMap(name => [
		`#EXTINF:${LIVE_SEGMENT_DURATION},`,
		`/${LIVE_SEGMENT_DIR}/${name}`,
	]),
	'',
].join('\n');

export type HlsFixtureServer = {
	origin: string;
	/** Maps an original CDN URL onto this server. */
	url: (originalUrl: string) => string;
	close: () => Promise<void>;
	/** Requests served so far, as local paths — used to assert that nothing escaped to the network. */
	requested: string[];
	/** A live playlist whose edge advances: one more real segment on every fetch, and no `#EXT-X-ENDLIST`. */
	liveUrl: string;
	/** How many segments the live playlist has handed out so far. */
	liveSegmentCount: () => number;
};

export const startHlsFixtureServer = async (): Promise<HlsFixtureServer> => {
	if (!existsSync(FIXTURE_ROOT)) {
		throw new Error(
			`No HLS fixtures at ${FIXTURE_ROOT}. They are third-party media and are not committed;`
			+ ' fetch them with `npm run capture-hls-fixtures`.',
		);
	}

	const requested: string[] = [];

	// Set HLS_FIXTURE_LOG to record what a run actually reads; that is how the corpus is pruned and
	// re-captured, so it holds what the tests ask for and nothing else.
	const log = process.env['HLS_FIXTURE_LOG'];

	let liveFetches = 0;

	const server: Server = createServer((request, response) => {
		requested.push(request.url!);

		if (request.url === LIVE_PATH) {
			const segmentCount = Math.min(LIVE_INITIAL_SEGMENTS + liveFetches, LIVE_SEGMENTS.length);
			liveFetches++;
			// Dated at request time, so the mapping to wall-clock time is current however long the corpus
			// has been sitting on disk.
			const body = Buffer.from(liveMediaPlaylist(segmentCount, new Date()));
			response.writeHead(200, {
				'content-type': CONTENT_TYPES['.m3u8']!,
				'content-length': body.byteLength,
				'cache-control': 'no-store',
			});
			response.end(body);
			return;
		}
		if (log) {
			appendFileSync(log, `${request.url!}\n`);
		}

		const filePath = fixturePathFor(request.url!);
		if (!filePath.startsWith(FIXTURE_ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
			response.writeHead(404).end(`no fixture for ${request.url}`);
			return;
		}

		const size = statSync(filePath).size;
		const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';

		const serve = (body: Buffer | null) => {
			const length = body ? body.byteLength : size;
			const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');

			if (!range) {
				response.writeHead(200, { 'content-type': contentType, 'content-length': length });
				if (body) {
					response.end(body);
				} else {
					createReadStream(filePath).pipe(response);
				}
				return;
			}

			const start = Number(range[1]);
			const end = range[2] ? Math.min(Number(range[2]), length - 1) : length - 1;
			if (start >= length) {
				response.writeHead(416, { 'content-range': `bytes */${length}` }).end();
				return;
			}

			response.writeHead(206, {
				'content-type': contentType,
				'content-length': end - start + 1,
				'content-range': `bytes ${start}-${end}/${length}`,
			});
			if (body) {
				response.end(body.subarray(start, end + 1));
			} else {
				createReadStream(filePath, { start, end }).pipe(response);
			}
		};

		if (!isTextual(filePath)) {
			serve(null);
			return;
		}

		const address = server.address() as AddressInfo;
		readFile(filePath, 'utf8')
			.then(text => serve(Buffer.from(rewriteAbsoluteUrls(text, `http://127.0.0.1:${address.port}`))))
			.catch(() => response.writeHead(500).end());
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${port}`;

	return {
		origin,
		url: (originalUrl: string) => {
			const parsed = new URL(originalUrl);
			return `${origin}/${parsed.host}${parsed.pathname}${parsed.search}`;
		},
		liveUrl: `${origin}${LIVE_PATH}`,
		liveSegmentCount: () => Math.min(LIVE_INITIAL_SEGMENTS + Math.max(liveFetches - 1, 0), LIVE_SEGMENTS.length),
		close: () => new Promise<void>((resolve, reject) => {
			server.close(error => error ? reject(error) : resolve());
		}),
		requested,
	};
};
