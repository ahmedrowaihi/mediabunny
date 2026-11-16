import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, Input, FilePathSource } from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicPath = (file: string) => path.join(__dirname, '../public', file);

test('MP4 ISOBMFF duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('video.mp4')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(5.056);
	expect(await input.computeDuration()).toBe(5.056);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getDurationFromMetadata()).toBe(5);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(5.056);
});

test('Matroska MKV duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('ac3.mkv')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFirstTimestamp()).toBe(-0.005);
	expect(await input.getDurationFromMetadata()).toBe(1.995);
	expect(await input.computeDuration()).toBe(1.995);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getFirstTimestamp()).toBe(-0.005);
	expect(await audioTrack.getDurationFromMetadata()).toBe(1.995);
});

test('MPEG-TS duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('0.ts')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(null);
	expect(await input.computeDuration()).not.toBe(null);

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getDurationFromMetadata()).toBe(null);
	}
});

test('FLAC duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('sample.flac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(19.714285714285715);
	expect(await input.computeDuration()).toBe(19.714285714285715);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(19.714285714285715);
});

test('WAV duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(9.63718820861678);
	expect(await input.computeDuration()).toBe(9.63718820861678);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(9.63718820861678);
});

test('OGG Vorbis duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('vorbis-eos.ogg')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(null);

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getDurationFromMetadata()).toBe(null);
	}
});

test('ADTS AAC duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(null);

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getDurationFromMetadata()).toBe(null);
	}
});

test('MP3 duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('Toothsome-Meme.VBRv2.mp3')),
		formats: ALL_FORMATS,
	});

	// The LAME tag declares 1,681 encoder samples plus the 529-sample decoder delay.
	const expectedDuration = (38.568 * 48000 - 2210) / 48000;
	expect(await input.getDurationFromMetadata()).toBe(expectedDuration);
	expect(await input.computeDuration()).toBe(expectedDuration);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(expectedDuration);
});

// Ogg names each logical bitstream by a serial number, which is a random 32-bit value rather than a
// position — so unlike the other containers, a position could never be mistaken for it.
test('an Ogg track states its logical bitstream\'s serial number', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/vorbis-eos.ogg')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const serial = await track.getContainerId();
	expect(typeof serial).toBe('number');
	expect(Number.isInteger(serial)).toBe(true);
	expect(serial).toBeGreaterThan(0);
});
