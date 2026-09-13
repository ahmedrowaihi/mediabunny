import path from 'node:path';
import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { InputSubtitleTrack } from '../../src/input-track.js';
import { SubtitleCueSink } from '../../src/media-sink.js';
import { SubtitleCueSource, TextSubtitleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { parseTtmlDocument, type SubtitleCue } from '../../src/subtitles.js';
import { BufferTarget } from '../../src/target.js';

const __dirname = new URL('.', import.meta.url).pathname;

// The long cue outlives the short one, so the ISOBMFF WebVTT muxer must split it across three samples and
// mark every part with the same vsid. Recovering it whole is the boundary-spanning case.
const WEBVTT_TEXT = `WEBVTT

00:00.000 --> 00:03.000
Long cue

00:01.000 --> 00:02.000
Short cue
`;

const TTML_CUES: SubtitleCue[] = [
	{ timestamp: 0, duration: 1.5, text: 'First\nline two', identifier: 'c1' },
	{ timestamp: 2, duration: 1, text: 'Second & <escaped>', identifier: 'c2' },
	{ timestamp: 4.25, duration: 0.75, text: 'Third', identifier: 'c3' },
];

const writeWebVttMp4 = async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();
	await source.add(WEBVTT_TEXT);
	await output.finalize();

	return output.target.buffer!;
};

const writeTtmlMp4 = async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
		target: new BufferTarget(),
	});
	const source = new SubtitleCueSource('ttml');
	output.addSubtitleTrack(source);

	await output.start();
	for (const cue of TTML_CUES) {
		await source.add(cue, { config: { description: '' } });
	}
	await output.finalize();

	return output.target.buffer!;
};

const writeWebVttMkv = async () => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();
	await source.add(WEBVTT_TEXT);
	await output.finalize();

	return output.target.buffer!;
};

const readSubtitleTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const tracks = await input.getSubtitleTracks();
	expect(tracks).toHaveLength(1);

	const track = tracks[0]!;
	expect(track).toBeInstanceOf(InputSubtitleTrack);
	expect(track.type).toBe('subtitle');
	expect(track.isSubtitleTrack()).toBe(true);
	expect(track.isVideoTrack()).toBe(false);

	const cues: SubtitleCue[] = [];
	for await (const cue of new SubtitleCueSink(track).cues()) {
		cues.push(cue);
	}

	return { input, track, cues };
};

test('ISOBMFF WebVTT tracks are read back with their cues rejoined', async () => {
	const { track, cues } = await readSubtitleTrack(await writeWebVttMp4());

	expect(await track.getCodec()).toBe('webvtt');
	expect(await track.getInternalCodecId()).toBe('wvtt');
	expect(await track.getConfig()).toEqual({ description: 'WEBVTT' });
	expect(await track.canDecode()).toBe(true);
	expect(await track.hasOnlyKeyPackets()).toBe(true);

	expect(cues).toEqual([
		{ timestamp: 0, duration: 3, text: 'Long cue', identifier: undefined, settings: '', notes: undefined },
		{ timestamp: 1, duration: 1, text: 'Short cue', identifier: undefined, settings: '', notes: undefined },
	]);
});

test('ISOBMFF TTML tracks are read back with the timings their documents state', async () => {
	const { track, cues } = await readSubtitleTrack(await writeTtmlMp4());

	expect(await track.getCodec()).toBe('ttml');
	expect(await track.getInternalCodecId()).toBe('stpp');
	expect(await track.getConfig()).toBe(null);

	expect(cues).toEqual(TTML_CUES);
});

test('Matroska WebVTT tracks are read back with their cues', async () => {
	const { track, cues } = await readSubtitleTrack(await writeWebVttMkv());

	expect(await track.getCodec()).toBe('webvtt');
	expect(await track.getInternalCodecId()).toBe('S_TEXT/WEBVTT');
	expect(await track.getConfig()).toEqual({ description: 'WEBVTT' });

	expect(cues).toEqual([
		{ timestamp: 0, duration: 3, text: 'Long cue', identifier: undefined, settings: undefined, notes: undefined },
		{ timestamp: 1, duration: 1, text: 'Short cue', identifier: undefined, settings: undefined, notes: undefined },
	]);
});

test('A track whose sample entry we cannot decode is not reported as a subtitle track', async () => {
	const buffer = await writeWebVttMp4();
	const bytes = new Uint8Array(buffer);

	// Rename the wvtt sample entry to a timed-text format we cannot serve. The handler still says 'text',
	// so only the sample entry can keep the track from being promised to the caller.
	const index = bytes.findIndex((_, i) =>
		bytes[i] === 0x77 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x74 && bytes[i + 3] === 0x74);
	expect(index).toBeGreaterThan(-1);
	bytes.set([0x74, 0x78, 0x33, 0x67], index); // 'tx3g'

	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	expect(await input.getSubtitleTracks()).toEqual([]);
	expect(await input.getTracks()).toEqual([]);
});

test('An ffmpeg-written TTML track is read with the cues ffmpeg put in it', async () => {
	const input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ttml-ffmpeg.mp4')),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getSubtitleTracks();
	expect(tracks).toHaveLength(1);

	const track = tracks[0]!;
	expect(await track.getCodec()).toBe('ttml');
	expect(await track.getInternalCodecId()).toBe('stpp');

	const cues: SubtitleCue[] = [];
	for await (const cue of new SubtitleCueSink(track).cues()) {
		cues.push(cue);
	}

	// ffmpeg wraps each cue body in a <span> and drops the angle brackets of the third source line.
	expect(cues).toEqual([
		{ timestamp: 0, duration: 1.5, text: 'First line\nline two', identifier: undefined },
		{ timestamp: 2, duration: 1, text: 'Second &', identifier: undefined },
		{ timestamp: 4.25, duration: 0.75, text: 'Third', identifier: undefined },
	]);
});

test('The TTML reader refuses documents whose timing it cannot reproduce', () => {
	const document = (paragraph: string, attributes = '') =>
		`<tt xmlns="http://www.w3.org/ns/ttml" ttp:timeBase="media"${attributes}>`
		+ `<body><div>${paragraph}</div></body></tt>`;

	expect(parseTtmlDocument(document('<p begin="00:00:01.000" end="00:00:02.000">Hi</p>')))
		.toEqual([{ timestamp: 1, duration: 1, text: 'Hi', identifier: undefined }]);

	expect(() => parseTtmlDocument(document('<p begin="00:00:01:12" end="00:00:02.000">Hi</p>')))
		.toThrow(/time expression/);
	expect(() => parseTtmlDocument(document('<p begin="10t" end="20t">Hi</p>')))
		.toThrow(/time expression/);
	expect(() => parseTtmlDocument(document('<p end="00:00:02.000">Hi</p>')))
		.toThrow(/no begin attribute/);
	expect(() => parseTtmlDocument(document('<p begin="00:00:01.000">Hi</p>')))
		.toThrow(/neither an end nor a dur/);
	expect(() => parseTtmlDocument(
		'<tt xmlns="http://www.w3.org/ns/ttml" ttp:timeBase="smpte"><body/></tt>',
	)).toThrow(/time base/);
	expect(() => parseTtmlDocument(
		'<tt xmlns="http://www.w3.org/ns/ttml"><body begin="1s"><div/></body></tt>',
	)).toThrow(/timing on a <body> or <div>/);
	expect(() => parseTtmlDocument('<nope/>')).toThrow(/no <tt> root/);
});
