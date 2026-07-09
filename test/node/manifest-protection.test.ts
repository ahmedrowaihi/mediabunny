import { describe, expect, test } from 'vitest';
import {
	FAIRPLAY_UUID,
	WIDEVINE_UUID,
	buildCbcsContentProtections,
	buildCbcsHlsKey,
	buildContentProtections,
	buildHlsKeys,
	patchMediaPlaylistKeys,
	patchMpdContentProtection,
	serializeContentProtection,
} from '../../src/crypto/manifest-protection.js';
import {
	COMMON_SYSTEM_ID,
	PLAYREADY_SYSTEM_ID,
	WIDEVINE_SYSTEM_ID,
	buildCommonPssh,
	buildPlayReadyPssh,
	buildWidevinePssh,
} from '../../src/crypto/pssh.js';

const KID = new Uint8Array(16).fill(0xa0);
const KID_UUID = 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0';

describe('DASH cbcs ContentProtection', () => {
	test('base mp4protection descriptor carries value=cbcs + cenc:default_KID', () => {
		const [base] = buildCbcsContentProtections({ defaultKid: KID });
		expect(serializeContentProtection(base!)).toBe(
			'<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" '
			+ `cenc:default_KID="${KID_UUID}"/>`,
		);
	});

	test('WebM (AES-CTR) signals value=cenc with the same default_KID + per-DRM pssh', () => {
		const elements = buildContentProtections({
			scheme: 'cenc',
			defaultKid: KID,
			drmSystems: [{ uuid: WIDEVINE_UUID, pssh: new Uint8Array([9, 9]), nameVersion: 'Widevine' }],
		});
		expect(serializeContentProtection(elements[0]!)).toBe(
			'<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" '
			+ `cenc:default_KID="${KID_UUID}"/>`,
		);
		expect(serializeContentProtection(elements[1]!)).toContain(`urn:uuid:${WIDEVINE_UUID}`);
	});

	test('per-DRM descriptor renders urn:uuid + base64 <cenc:pssh>', () => {
		const pssh = new Uint8Array([1, 2, 3, 4]);
		const elements = buildCbcsContentProtections({
			defaultKid: KID,
			drmSystems: [{ uuid: WIDEVINE_UUID, pssh, nameVersion: 'Widevine' }],
		});
		expect(elements.length).toBe(2);
		expect(serializeContentProtection(elements[1]!)).toBe(
			`<ContentProtection schemeIdUri="urn:uuid:${WIDEVINE_UUID}" value="Widevine">`
			+ `<cenc:pssh>${Buffer.from(pssh).toString('base64')}</cenc:pssh></ContentProtection>`,
		);
	});

	test('FairPlay is skipped for DASH', () => {
		const elements = buildCbcsContentProtections({
			defaultKid: KID,
			drmSystems: [{ uuid: FAIRPLAY_UUID }, { uuid: WIDEVINE_UUID }],
		});
		expect(elements.map(e => e.schemeIdUri)).toEqual([
			'urn:mpeg:dash:mp4protection:2011',
			`urn:uuid:${WIDEVINE_UUID}`,
		]);
	});

	test('patch injects ContentProtection as the first child of every AdaptationSet', () => {
		const mpd = '<Period>\n<AdaptationSet id="0" mimeType="video/mp4">\n<Representation/>\n'
			+ '</AdaptationSet>\n</Period>';
		const patched = patchMpdContentProtection(mpd, buildCbcsContentProtections({ defaultKid: KID }));
		expect(patched).toContain(
			'<AdaptationSet id="0" mimeType="video/mp4">'
			+ '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" '
			+ `cenc:default_KID="${KID_UUID}"/>`,
		);
	});
});

describe('HLS cbcs EXT-X-KEY', () => {
	test('builds a SAMPLE-AES key line (shaka field order)', () => {
		expect(buildCbcsHlsKey({
			uri: 'skd://key',
			keyFormat: 'com.apple.streamingkeydelivery',
			keyFormatVersions: '1',
		})).toBe(
			'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMATVERSIONS="1",'
			+ 'KEYFORMAT="com.apple.streamingkeydelivery"',
		);
	});

	test('patch inserts the key after #EXT-X-MAP', () => {
		const playlist = [
			'#EXTM3U',
			'#EXT-X-MAP:URI="init.mp4"',
			'#EXTINF:4.0,',
			'seg0.m4s',
		].join('\n');
		const key = buildCbcsHlsKey({ uri: 'skd://key', keyFormat: 'com.apple.streamingkeydelivery' });
		expect(patchMediaPlaylistKeys(playlist, [key]).split('\n')).toEqual([
			'#EXTM3U',
			'#EXT-X-MAP:URI="init.mp4"',
			key,
			'#EXTINF:4.0,',
			'seg0.m4s',
		]);
	});

	test('buildHlsKeys emits one EXT-X-KEY per system — the string-path multi-DRM counterpart to drm()', () => {
		const keys = buildHlsKeys({
			systems: [
				{ uuid: WIDEVINE_UUID, pssh: buildWidevinePssh(KID) },
				{ uuid: PLAYREADY_SYSTEM_ID, pssh: buildPlayReadyPssh(KID) },
				{ uuid: FAIRPLAY_UUID },
			],
			fairplayKeyUri: `skd://${KID_UUID}`,
		});
		expect(keys).toHaveLength(3);
		expect(keys[0]).toContain(`KEYFORMAT="urn:uuid:${WIDEVINE_UUID}"`); // Widevine as data: pssh
		expect(keys[0]).toContain('URI="data:text/plain;base64,');
		expect(keys[1]).toContain('KEYFORMAT="com.microsoft.playready"'); // PlayReady as data: PRO (UTF-16)
		expect(keys[1]).toContain('charset=UTF-16');
		expect(keys[2]).toContain('KEYFORMAT="com.apple.streamingkeydelivery"'); // FairPlay skd:
		expect(keys[2]).toContain(`URI="skd://${KID_UUID}"`);
	});
});

const hex = (u8: Uint8Array): string => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const uuidHex = (uuid: string): string => uuid.replace(/-/g, '');

describe('PSSH builders', () => {
	test('buildWidevinePssh: box header + system ID + minimal key_id protobuf', () => {
		const pssh = buildWidevinePssh(KID);
		const dv = new DataView(pssh.buffer);
		expect(dv.getUint32(0)).toBe(pssh.length); // box size
		expect(String.fromCharCode(...pssh.subarray(4, 8))).toBe('pssh');
		expect(pssh[8]).toBe(0); // version 0 (no KID list)
		expect(hex(pssh.subarray(12, 28))).toBe(uuidHex(WIDEVINE_SYSTEM_ID));
		expect(dv.getUint32(28)).toBe(18); // data size
		// data = protobuf field 2 (key_id): 0x12 0x10 <16-byte KID>
		expect([pssh[32], pssh[33]]).toEqual([0x12, 0x10]);
		expect(hex(pssh.subarray(34, 50))).toBe(hex(KID));
	});

	test('buildCommonPssh: version 1 with a KID list and empty data', () => {
		const pssh = buildCommonPssh([KID]);
		const dv = new DataView(pssh.buffer);
		expect(String.fromCharCode(...pssh.subarray(4, 8))).toBe('pssh');
		expect(pssh[8]).toBe(1); // version 1 (KID list present)
		expect(hex(pssh.subarray(12, 28))).toBe(uuidHex(COMMON_SYSTEM_ID));
		expect(dv.getUint32(28)).toBe(1); // KID count
		expect(hex(pssh.subarray(32, 48))).toBe(hex(KID));
		expect(dv.getUint32(48)).toBe(0); // empty data
	});

	// shaka ConvertGuidEndianness: groups 1-3 little-endian, bytes 8-15 unchanged.
	const swappedKid = Uint8Array.from([3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
	const playReadyPro = (pssh: Uint8Array): string => {
		const dv = new DataView(pssh.buffer);
		expect(String.fromCharCode(...pssh.subarray(4, 8))).toBe('pssh');
		expect(pssh[8]).toBe(0); // version 0
		expect(hex(pssh.subarray(12, 28))).toBe(uuidHex(PLAYREADY_SYSTEM_ID));
		const dataSize = dv.getUint32(28);
		const pro = pssh.subarray(32, 32 + dataSize);
		const proDv = new DataView(pro.buffer, pro.byteOffset, pro.byteLength);
		expect(proDv.getUint32(0, true)).toBe(dataSize); // PRO total size (LE)
		expect(proDv.getUint16(4, true)).toBe(1); // record count
		expect(proDv.getUint16(6, true)).toBe(1); // record type = RM header
		return new TextDecoder('utf-16le').decode(pro.subarray(10));
	};

	test('buildPlayReadyPssh cbcs: v4.3.0.0 AESCBC header (shaka-faithful)', () => {
		const kid = Uint8Array.from({ length: 16 }, (_, i) => i);
		const wrm = playReadyPro(buildPlayReadyPssh(kid, { scheme: 'cbcs', laUrl: 'https://la.example/rl' }));
		expect(wrm).toContain('version="4.3.0.0"');
		expect(wrm).toContain(`<KID ALGID="AESCBC" VALUE="${Buffer.from(swappedKid).toString('base64')}">`);
		expect(wrm).toContain('<LA_URL>https://la.example/rl</LA_URL>');
	});

	test('buildPlayReadyPssh cenc: v4.0.0.0 AESCTR header with a key-derived checksum (shaka-faithful)', () => {
		const kid = Uint8Array.from({ length: 16 }, (_, i) => i);
		const wrm = playReadyPro(buildPlayReadyPssh(kid, { scheme: 'cenc', key: new Uint8Array(16).fill(0x2b) }));
		expect(wrm).toContain('version="4.0.0.0"');
		expect(wrm).toContain('<ALGID>AESCTR</ALGID>');
		expect(wrm).toContain(`<KID>${Buffer.from(swappedKid).toString('base64')}</KID>`);
		expect(wrm).toMatch(/<CHECKSUM>[A-Za-z0-9+/=]{12}<\/CHECKSUM>/); // base64 of 8 bytes
	});

	test('buildPlayReadyPssh cenc without a key throws (checksum needs it)', () => {
		expect(() => buildPlayReadyPssh(Uint8Array.from({ length: 16 }, (_, i) => i), { scheme: 'cenc' }))
			.toThrow(/checksum/);
	});

	test('a built Widevine PSSH feeds buildCbcsContentProtections → base64 <cenc:pssh>', () => {
		const pssh = buildWidevinePssh(KID);
		const [, widevine] = buildCbcsContentProtections({
			defaultKid: KID,
			drmSystems: [{ uuid: WIDEVINE_UUID, pssh, nameVersion: 'Widevine' }],
		});
		expect(serializeContentProtection(widevine!)).toContain(
			`<cenc:pssh>${Buffer.from(pssh).toString('base64')}</cenc:pssh>`,
		);
	});
});
