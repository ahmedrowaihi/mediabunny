import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

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

/** A version 0 `pssh` payload, the contents-only wire form a manifest may carry: version+flags, the
 * system id, then the system's own data. */
const widevinePsshContents = () => {
	const data = new TextEncoder().encode('license-acquisition-data');
	const contents = new Uint8Array(4 + 16 + 4 + data.length);
	contents.set(WIDEVINE_SYSTEM_ID.match(/../g)!.map(byte => parseInt(byte, 16)), 4);
	new DataView(contents.buffer).setUint32(20, data.length, false);
	contents.set(data, 24);
	return contents;
};

test('a protected DASH track states its scheme, key id and the manifest\'s pssh boxes', async () => {
	// A `<ContentProtection>` on the AdaptationSet, which is where real multi-DRM manifests put it, over a
	// Representation whose init states `tenc`. Both halves were unreachable: the track's own protection
	// because the segmented backing returned null instead of delegating, and the manifest's `<cenc:pssh>`
	// because only the ISO BMFF demuxer answered `getPsshBoxes`.
	const init = new Uint8Array(readFileSync(FIXTURE));
	const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static"
	mediaPresentationDuration="PT4S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
	<Period duration="PT4S">
		<AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
			<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs"
				cenc:default_KID="302f80dd-411e-4886-bca5-bb1f8018a024"/>
			<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
				<cenc:pssh>${Buffer.from(widevinePsshContents()).toString('base64')}</cenc:pssh>
			</ContentProtection>
			<Representation id="v0" bandwidth="100000" codecs="avc1.4d401e" width="1280" height="720">
				<SegmentTemplate initialization="init.mp4" media="init.mp4" duration="4" startNumber="1"/>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>`;

	const files = new Map([['manifest.mpd', new TextEncoder().encode(mpd)], ['init.mp4', init]]);
	using input = new Input({
		source: new CustomPathedSource(
			'manifest.mpd',
			({ path: requested }) => new BufferSource(files.get(requested.split('/').pop()!)!),
		),
		formats: ALL_FORMATS,
	});

	const track = (await input.getVideoTracks())[0]!;
	const info = await track.getEncryptionInfo();
	expect(info).not.toBeNull();
	expect(info!.scheme).toBe('cbcs');
	expect(info!.defaultKid).toBe(EXPECTED_DEFAULT_KID);

	// The sample entry comes from the segment too, and a protected one is `encv`
	expect(await track.getInternalCodecId()).toBe('encv');

	const psshBoxes = await input.getPsshBoxes();
	expect(psshBoxes.map(box => box.systemId)).toEqual([WIDEVINE_SYSTEM_ID]);
});
