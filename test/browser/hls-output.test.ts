import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import {
	AdaptiveOutputFormat,
	CmafOutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	MpegTsOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CanvasSource } from '../../src/media-source.js';
import { QUALITY_HIGH } from '../../src/encode.js';

test('HLS output, key frames aligning with segment boundaries by default', async () => {
	let playlistText: string | null = null;

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { playlistText = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff0000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 2;
	const frameDuration = 1 / fps;
	const totalFrames = 10 * fps;
	for (let i = 0; i < totalFrames; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	expect(playlistText).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts
#EXTINF:2,
segment-1-5.ts

#EXT-X-ENDLIST
`);
});

test('AdaptiveOutputFormat emits HLS master + DASH MPD pointing at the same CMAF segments', async () => {
	let masterPlaylistText: string | null = null;
	let mediaPlaylistText: string | null = null;
	let mpdText: string | null = null;
	const writtenPaths: string[] = [];

	const segmentFormat = new CmafOutputFormat();
	const output = new Output({
		format: new AdaptiveOutputFormat({
			formats: [
				new HlsOutputFormat({
					segmentFormat,
					targetDuration: 2,
					onMaster: (text) => { masterPlaylistText = text; },
					onPlaylist: (text) => { mediaPlaylistText = text; },
				}),
				new DashOutputFormat({
					segmentFormat,
					targetDuration: 2,
					mpdPath: 'manifest.mpd',
					onMpd: (text) => { mpdText = text; },
				}),
			],
		}),
		target: new PathedTarget('', ({ path }) => {
			writtenPaths.push(path);
			return new BufferTarget();
		}),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#00ff00';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 2;
	const frameDuration = 1 / fps;
	const totalFrames = 6 * fps;
	for (let i = 0; i < totalFrames; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	expect(masterPlaylistText).toContain('#EXTM3U');
	expect(masterPlaylistText).toContain('#EXT-X-STREAM-INF');
	expect(mediaPlaylistText).toContain('#EXT-X-ENDLIST');
	expect(mediaPlaylistText).toMatch(/segment-1-\d+\.m4s/);

	expect(mpdText).not.toBeNull();
	expect(mpdText).toContain('<MPD');
	expect(mpdText).toContain('<Period');
	expect(mpdText).toContain('<AdaptationSet');
	expect(mpdText).toContain('<Representation');

	expect(writtenPaths).toContain('manifest.mpd');
	expect(writtenPaths.some(p => /segment-1-\d+\.m4s$/.test(p))).toBe(true);
	expect(writtenPaths.some(p => /init-1\.m4s$/.test(p))).toBe(true);
});
