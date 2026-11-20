import path from 'node:path';
import { expect, test } from 'vitest';
import { Conversion } from '../../src/conversion.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { SubtitleCueSink } from '../../src/media-sink.js';
import { TextSubtitleSource } from '../../src/media-source.js';
import { MkvOutputFormat, Mp4OutputFormat, OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import type { SubtitleCue } from '../../src/subtitles.js';
import { BufferTarget } from '../../src/target.js';

const __dirname = new URL('.', import.meta.url).pathname;

const WEBVTT_TEXT = `WEBVTT

00:00.000 --> 00:03.000
Long cue

00:01.000 --> 00:02.000
Short cue
`;

const FFMPEG_TTML_CUES: SubtitleCue[] = [
	{ timestamp: 0, duration: 1.5, text: 'First line\nline two', identifier: undefined },
	{ timestamp: 2, duration: 1, text: 'Second &', identifier: undefined },
	{ timestamp: 4.25, duration: 0.75, text: 'Third', identifier: undefined },
];

const ffmpegTtmlInput = () => new Input({
	source: new FilePathSource(path.join(__dirname, '..', 'public/ttml-ffmpeg.mp4')),
	formats: ALL_FORMATS,
});

const webVttMp4Input = async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();
	await source.add(WEBVTT_TEXT);
	await output.finalize();

	return new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
};

const convert = async (input: Input, format: OutputFormat, options: Partial<Parameters<
	typeof Conversion.init
>[0]> = {}) => {
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, showWarnings: false, ...options });

	return { conversion, output };
};

const readCues = async (buffer: ArrayBuffer) => {
	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const tracks = await input.getSubtitleTracks();
	expect(tracks).toHaveLength(1);

	const cues: SubtitleCue[] = [];
	for await (const cue of new SubtitleCueSink(tracks[0]!).cues()) {
		cues.push(cue);
	}

	return { codec: await tracks[0]!.getCodec(), cues };
};

test('Conversion.init does not throw on an input containing a readable subtitle track', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	await expect(Conversion.init({ input: ffmpegTtmlInput(), output, showWarnings: false }))
		.resolves.toBeInstanceOf(Conversion);
});

test('A subtitle-bearing input converts and its cues survive with timings and text intact', async () => {
	const { conversion, output } = await convert(ffmpegTtmlInput(), new Mp4OutputFormat());

	expect(conversion.discardedTracks).toEqual([]);
	expect(conversion.utilizedTracks).toHaveLength(1);
	expect(conversion.isValid).toBe(true);

	await conversion.execute();

	expect(await readCues(output.target.buffer!)).toEqual({ codec: 'ttml', cues: FFMPEG_TTML_CUES });
});

test('Subtitle cues are rewritten between webvtt and ttml in both directions', async () => {
	const webVttCues: SubtitleCue[] = [
		{ timestamp: 0, duration: 3, text: 'Long cue', identifier: undefined, settings: '', notes: undefined },
		{ timestamp: 1, duration: 1, text: 'Short cue', identifier: undefined, settings: '', notes: undefined },
	];

	const toTtml = await convert(await webVttMp4Input(), new Mp4OutputFormat(), { subtitle: { codec: 'ttml' } });
	expect(toTtml.conversion.discardedTracks).toEqual([]);
	await toTtml.conversion.execute();

	const asTtml = await readCues(toTtml.output.target.buffer!);
	expect(asTtml.codec).toBe('ttml');
	expect(asTtml.cues).toEqual(webVttCues.map(cue => ({
		timestamp: cue.timestamp,
		duration: cue.duration,
		text: cue.text,
		identifier: undefined,
	})));

	const backToWebVtt = await convert(
		new Input({ source: new BufferSource(toTtml.output.target.buffer!), formats: ALL_FORMATS }),
		new Mp4OutputFormat(),
		{ subtitle: { codec: 'webvtt' } },
	);
	expect(backToWebVtt.conversion.discardedTracks).toEqual([]);
	await backToWebVtt.conversion.execute();

	// TTML has nowhere to put WebVTT cue settings, so they do not come back; timings and text do.
	expect(await readCues(backToWebVtt.output.target.buffer!)).toEqual({
		codec: 'webvtt',
		cues: webVttCues.map(cue => ({ ...cue, settings: undefined })),
	});
});

test('Trimming shifts cues onto the output timeline and clips the ones straddling the edges', async () => {
	const { conversion, output } = await convert(ffmpegTtmlInput(), new Mp4OutputFormat(), {
		trim: { start: 1, end: 3 },
	});
	await conversion.execute();

	expect((await readCues(output.target.buffer!)).cues).toEqual([
		{ timestamp: 0, duration: 0.5, text: 'First line\nline two', identifier: undefined },
		{ timestamp: 1, duration: 1, text: 'Second &', identifier: undefined },
	]);
});

test('A WebVTT track\'s header and cue settings survive a same-codec conversion', async () => {
	const { conversion, output } = await convert(await webVttMp4Input(), new Mp4OutputFormat());
	await conversion.execute();

	const input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getSubtitleTracks())[0]!;

	expect(await track.getCodec()).toBe('webvtt');
	expect(await track.getConfig()).toEqual({ description: 'WEBVTT' });
});

test('A subtitle codec the output format cannot hold discards the track with a reason', async () => {
	// Matroska defines no TTML codec ID, so the requested codec is out of reach there.
	const { conversion } = await convert(ffmpegTtmlInput(), new MkvOutputFormat(), { subtitle: { codec: 'ttml' } });

	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('unsupported_subtitle_codec');
	expect(conversion.discardedTracks[0]!.track.type).toBe('subtitle');
	expect(conversion.utilizedTracks).toEqual([]);
	expect(conversion.isValid).toBe(false);
});

test('Matroska takes a TTML input by rewriting its cues as WebVTT', async () => {
	const { conversion, output } = await convert(ffmpegTtmlInput(), new MkvOutputFormat());

	expect(conversion.discardedTracks).toEqual([]);
	await conversion.execute();

	const { codec, cues } = await readCues(output.target.buffer!);
	expect(codec).toBe('webvtt');
	expect(cues.map(cue => [cue.timestamp, cue.duration, cue.text]))
		.toEqual(FFMPEG_TTML_CUES.map(cue => [cue.timestamp, cue.duration, cue.text]));
});

test('An output format that holds no subtitle track at all discards the track with a reason', async () => {
	const { conversion } = await convert(ffmpegTtmlInput(), new WavOutputFormat());

	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_of_type_reached');
	expect(conversion.utilizedTracks).toEqual([]);
});

test('A user-discarded subtitle track is reported as such', async () => {
	const { conversion } = await convert(ffmpegTtmlInput(), new Mp4OutputFormat(), { subtitle: { discard: true } });

	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('discarded_by_user');
	expect(conversion.utilizedTracks).toEqual([]);
});

test('tracks: \'primary\' holds no subtitle track and says so instead of dropping it silently', async () => {
	const { conversion } = await convert(ffmpegTtmlInput(), new Mp4OutputFormat(), { tracks: 'primary' });

	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('not_a_primary_track');
	expect(conversion.discardedTracks[0]!.track.type).toBe('subtitle');
	expect(conversion.utilizedTracks).toEqual([]);
});

test('The subtitle options callback is passed each subtitle track and can fan it out', async () => {
	const seen: string[] = [];
	const { conversion, output } = await convert(ffmpegTtmlInput(), new Mp4OutputFormat(), {
		subtitle: (track, n) => {
			seen.push(`${track.type}:${n}`);
			return [{ codec: 'ttml' as const }, { codec: 'webvtt' as const }];
		},
	});

	expect(seen).toEqual(['subtitle:1']);
	expect(conversion.utilizedTracks).toHaveLength(2);

	await conversion.execute();

	const input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await input.getSubtitleTracks();
	expect(await Promise.all(tracks.map(x => x.getCodec()))).toEqual(['ttml', 'webvtt']);
});
