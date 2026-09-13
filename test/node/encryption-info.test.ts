import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { FilePathSource } from '../../src/source.js';

const __dirname = new URL('.', import.meta.url).pathname;

const FIXTURE = path.join(__dirname, '..', 'public/cbcs-cmaf-init.mp4');

const WIDEVINE_SYSTEM_ID = 'edef8ba979d64acea3c827dcd51d21ed';
const PLAYREADY_SYSTEM_ID = '9a04f07998404286ab92e65be0885f95';
const EXPECTED_DEFAULT_KID = '302f80dd411e4886bca5bb1f8018a024';

test('Input.getPsshBoxes returns Widevine + PlayReady boxes from a CBCS init segment', async () => {
	using input = new Input({
		source: new FilePathSource(FIXTURE),
		formats: ALL_FORMATS,
	});

	const psshBoxes = await input.getPsshBoxes();
	expect(psshBoxes).toHaveLength(2);

	const systemIds = psshBoxes.map(b => b.systemId).sort();
	expect(systemIds).toEqual([PLAYREADY_SYSTEM_ID, WIDEVINE_SYSTEM_ID].sort());

	for (const box of psshBoxes) {
		expect(box.data.byteLength).toBeGreaterThan(0);
		expect(box.bytes.byteLength).toBeGreaterThan(box.data.byteLength);
		expect(box.bytes[4]).toBe(0x70); // 'p'
		expect(box.bytes[5]).toBe(0x73); // 's'
		expect(box.bytes[6]).toBe(0x73); // 's'
		expect(box.bytes[7]).toBe(0x68); // 'h'
	}
});

test('Input.getPsshBoxes returns [] for clear isobmff sources', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const psshBoxes = await input.getPsshBoxes();
	expect(psshBoxes).toEqual([]);
});

test('InputTrack.getEncryptionInfo returns scheme + defaultKid from tenc', async () => {
	using input = new Input({
		source: new FilePathSource(FIXTURE),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.length).toBeGreaterThan(0);

	for (const track of tracks) {
		const info = await track.getEncryptionInfo();
		expect(info).not.toBeNull();
		expect(info!.scheme).toBe('cbcs');
		expect(info!.defaultKid).toBe(EXPECTED_DEFAULT_KID);
		expect(info!.defaultIsProtected).toBe(true);
	}
});

test('InputTrack.getEncryptionInfo returns null for clear tracks', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getEncryptionInfo()).toBeNull();
	}
});
