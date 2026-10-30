import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, DashOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';

const AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);
const AVC_METADATA: EncodedVideoChunkMetadata = {
	decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 },
};

/** Writes a DASH presentation into memory, returning every file it produced by name. */
const writeFiles = async (segmentCount: number) => {
	const files = new Map<string, Uint8Array>();

	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			mpdPath: 'manifest.mpd',
		}),
		target: new PathedTarget('manifest.mpd', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < segmentCount * 2; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	return files;
};

/**
 * Serves a written presentation by file name: the demuxer resolves segment URLs against the manifest's
 * location, and the written presentation is flat.
 */
const serve = (
	files: Map<string, Uint8Array>,
	rewrite?: (path: string) => string | undefined,
) => new CustomPathedSource('manifest.mpd', ({ path }) => {
	const body = files.get(rewrite?.(path) ?? path.split('/').pop() ?? path);
	if (!body) {
		throw new Error(`No such file in the written presentation: ${path}`);
	}
	return new BufferSource(body);
});

const writePresentation = async (segmentCount: number) => serve(await writeFiles(segmentCount));

test('a written DASH presentation reads back through the demuxer', async () => {
	using input = new Input({
		source: await writePresentation(4),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect(await track!.getCodec()).toBe('avc');
	expect(await track!.getDisplayWidth()).toBe(1280);
	expect(await track!.getDisplayHeight()).toBe(720);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		timestamps.push(Number(packet.timestamp.toFixed(3)));
	}

	expect(timestamps.length).toBe(8);
	expect(timestamps[0]).toBe(0);
	expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
});

test('the demuxer seeks by time through the manifest', async () => {
	using input = new Input({
		source: await writePresentation(4),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(track);

	const packet = await sink.getPacket(2);
	expect(packet).not.toBeNull();
	expect(packet!.timestamp).toBeCloseTo(2, 3);
});

test('the delegating accessors report the track, not the base class', async () => {
	using input = new Input({ source: await writePresentation(4),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	// Each of these is answered either from the manifest entry or by delegating to the segment's
	// own backing; a base class that stopped doing either would still walk and seek correctly.
	expect(track.id).toBeGreaterThan(0);
	expect(await track.computeDuration()).toBeGreaterThan(0);
	expect(await track.getTimeResolution()).toBeGreaterThan(1);
	expect(await track.getLanguageCode()).toBe('und');
	// DASH keeps them separate: a lone Representation is selectable but not marked primary.
	const disposition = await track.getDisposition();
	expect(disposition.default).toBe(true);
	expect(disposition.primary).toBe(false);
});

test('a SegmentList MPD over one fragmented MP4 reads without a domParser', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 100; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 25 === 0 ? 'key' : 'delta', i * 0.04, 0.04),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	const video = new Uint8Array(output.target.buffer!);
	const boxes = readTopLevelBoxes(video);
	const moov = boxes.find(box => box.name === 'moov')!;
	const mediaRanges = boxes.flatMap((box, i) => {
		const mdat = boxes[i + 1];
		return box.name === 'moof' && mdat ? [`${box.start}-${mdat.start + mdat.size - 1}`] : [];
	});
	expect(mediaRanges).toHaveLength(4);

	const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<!-- one file, addressed by byte range -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT2S"
	profiles="urn:mpeg:dash:profile:full:2011">
	<Period>
		<AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
			<Representation id="video" bandwidth="100000" codecs="avc1.4d401e" width="1280" height="720" frameRate="25">
				<BaseURL>video.mp4</BaseURL>
				<SegmentList timescale="1000" duration="1000">
					<Initialization range="0-${moov.start + moov.size - 1}"/>
					${mediaRanges.map(range => `<SegmentURL mediaRange="${range}"/>`).join('\n\t\t\t\t\t')}
				</SegmentList>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>`;

	const files = new Map([['manifest.mpd', new TextEncoder().encode(mpd)], ['video.mp4', video]]);
	using input = new Input({
		source: new CustomPathedSource(
			'manifest.mpd',
			({ path }) => new BufferSource(files.get(path.split('/').pop()!)!),
		),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect((await track!.computePacketStats()).averagePacketRate).toBeCloseTo(25, 5);

	const keyTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		if (packet.type === 'key') {
			keyTimestamps.push(Number(packet.timestamp.toFixed(3)));
		}
	}
	expect(keyTimestamps).toEqual([0, 1, 2, 3]);
});

test('an AdaptationSet that states its media type only on its Representation still yields a track', async () => {
	const files = await writeFiles(4);
	const mpd = new TextDecoder().decode(files.get('manifest.mpd'));
	// ISO/IEC 23009-1 allows @mimeType on either level, and GPAC-written manifests state neither
	// @contentType nor @mimeType on the AdaptationSet.
	expect(mpd).toContain('contentType="video"');
	files.set('manifest.mpd', new TextEncoder().encode(mpd.replace(' contentType="video"', '')));

	using input = new Input({ source: serve(files), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect(await track!.getCodec()).toBe('avc');
});

test('a live window starts at the live edge, not at the number the first segment ever had', async () => {
	const files = await writeFiles(4);
	// A 24/7 stream: the numbers inside the time-shift buffer are enormous and the ones near startNumber
	// were dropped long ago
	files.set('manifest.mpd', new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
	type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" minBufferTime="PT2S"
	timeShiftBufferDepth="PT4S" minimumUpdatePeriod="PT2S">
	<Period id="0" start="PT0S">
		<AdaptationSet id="0" contentType="video" segmentAlignment="true">
			<Representation id="0" bandwidth="2528" codecs="avc3.4d401e" mimeType="video/mp4">
				<SegmentTemplate timescale="90000" duration="90000" startNumber="0"
					initialization="init-1.m4s" media="segment-1-$Number$.m4s"/>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>`));

	const asked: string[] = [];
	// Each number the window asks for maps onto one of the four written segments, as a CDN's window would
	using input = new Input({
		source: serve(files, (path) => {
			const name = path.split('/').pop() ?? path;
			asked.push(name);
			const match = /^segment-1-(\d+)\.m4s$/.exec(name);
			if (!match) {
				return undefined;
			}
			const number = Number(match[1]);
			expect(number).toBeGreaterThan(1e8);
			return `segment-1-${(number % 4) + 1}.m4s`;
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect(await new EncodedPacketSink(track!).getFirstPacket()).not.toBeNull();
	expect(asked.some(name => /^segment-1-\d{9,}\.m4s$/.test(name))).toBe(true);
});

test('segment URLs resolve against the MPD\'s own BaseURL, not the manifest\'s directory', async () => {
	const files = await writeFiles(4);
	const mpd = new TextDecoder().decode(files.get('manifest.mpd'));
	files.set('manifest.mpd', new TextEncoder().encode(
		mpd.replace('<Period', '<BaseURL>https://cdn.example/v2/</BaseURL>\n  <Period'),
	));

	const asked: string[] = [];
	using input = new Input({
		source: serve(files, (path) => {
			asked.push(path);
			return path.split('/').pop();
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	expect(await new EncodedPacketSink(track!).getFirstPacket()).not.toBeNull();
	expect(asked.every(path => path === 'manifest.mpd' || path.startsWith('https://cdn.example/v2/'))).toBe(true);
});

test('a later period\'s segments are inside the availability window, not before it', async () => {
	const files = await writeFiles(4);
	// livesim2's `periods_60` shape: one period per minute, each stating its own startNumber and
	// presentationTimeOffset. Anchored to now, so the second period is the one still being written.
	const periodStart = Math.floor(Date.now() / 1000) - 90;
	const period = (index: number) => `
		<Period id="P${index}" start="PT${periodStart + index * 60}S">
			<AdaptationSet id="0" contentType="video" segmentAlignment="true">
				<Representation id="0" bandwidth="2528" codecs="avc3.4d401e" mimeType="video/mp4">
					<SegmentTemplate timescale="1" duration="1" startNumber="${900 + index * 60}"
						presentationTimeOffset="${periodStart + index * 60}"
						initialization="init-1.m4s" media="segment-1-$Number$.m4s"/>
				</Representation>
			</AdaptationSet>
		</Period>`;
	files.set('manifest.mpd', new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
	type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" minBufferTime="PT2S"
	timeShiftBufferDepth="PT60S" minimumUpdatePeriod="PT2S">${period(0)}${period(1)}
</MPD>`));

	using input = new Input({
		source: serve(files, (path) => {
			const name = path.split('/').pop() ?? path;
			const match = /^segment-1-(\d+)\.m4s$/.exec(name);
			return match ? `segment-1-${(Number(match[1]) % 4) + 1}.m4s` : name;
		}),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks.length).toBe(2);
	expect(await new EncodedPacketSink(tracks[0]!).getFirstPacket()).not.toBeNull();
});

test('a Representation whose only addressing is its BaseURL is read as one self-contained segment', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 100; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 25 === 0 ? 'key' : 'delta', i * 0.04, 0.04),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	// How the ISO on-demand conformance vectors state it: a BaseURL and nothing else
	const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT2S"
	profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
	<Period duration="PT4S">
		<AdaptationSet contentType="video" mimeType="video/mp4" subsegmentAlignment="true">
			<Representation id="video" bandwidth="100000" codecs="avc1.4d401e" width="1280" height="720">
				<BaseURL>video.mp4</BaseURL>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>`;

	const files = new Map([
		['manifest.mpd', new TextEncoder().encode(mpd)],
		['video.mp4', new Uint8Array(output.target.buffer!)],
	]);
	using input = new Input({ source: serve(files), formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect((await track!.computePacketStats()).averagePacketRate).toBeCloseTo(25, 5);
});
