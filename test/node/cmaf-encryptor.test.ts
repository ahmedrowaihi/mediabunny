import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { AesCtrEncryptor } from '../../src/crypto/aes-ctr-encryptor.js';
import { AesPatternCryptor } from '../../src/crypto/aes-pattern-cryptor.js';
import { type MutableBox, findBox, parseBoxes, serializeBoxes } from '../../src/crypto/box-tree.js';
import { encryptCmaf, encryptCmafInit, encryptCmafSegment } from '../../src/crypto/cmaf-encryptor.js';
import type { ProtectionScheme, SubsampleEntry } from '../../src/crypto/subsample-generator.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';

const FILE = path.join(
	new URL('.', import.meta.url).pathname,
	'../../../shaka-packager/packager/media/test/data/bear-640x360-av_frag.mp4',
);
const KEY = new Uint8Array(16).fill(0x2b);
const KID = new Uint8Array(16).fill(0xa0);
const IV = new Uint8Array(16).fill(0x11);

const u32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o);
const u16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o);
const fourcc = (d: Uint8Array, o: number) => String.fromCharCode(d[o + 4]!, d[o + 5]!, d[o + 6]!, d[o + 7]!);

// Pattern decrypt (video subsamples) or full-sample decrypt (audio, empty subsamples).
const decryptSample = (data: Uint8Array, subsamples: SubsampleEntry[], skipByteBlock: number): Uint8Array => {
	const cryptor = new AesPatternCryptor(
		1, skipByteBlock, 'encryptIfCryptByteBlockRemaining', true, new AesCbcDecryptor(),
	);
	cryptor.initializeWithIv(KEY, new Uint8Array(16));
	cryptor.setIv(IV);
	const out = new Uint8Array(data.length);
	if (subsamples.length === 0) {
		out.set(cryptor.crypt(data));
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		out.set(data.subarray(offset, offset + clearBytes), offset);
		offset += clearBytes;
		if (cipherBytes > 0) {
			out.set(cryptor.crypt(data.subarray(offset, offset + cipherBytes)), offset);
			offset += cipherBytes;
		}
	}
	return out;
};

const trackIdOf = (moov: MutableBox, entryType: string): number => {
	for (const trak of (moov.children ?? []).filter(b => b.type === 'trak')) {
		if (findBox([trak], entryType) !== null) {
			const tkhd = findBox([trak], 'tkhd')!.data!;
			return u32(tkhd, tkhd[0]! === 1 ? 20 : 12);
		}
	}
	throw new Error(`No track with sample entry ${entryType}`);
};

const measureMoof = (moof: MutableBox): number => {
	let size = 8 + (moof.data?.byteLength ?? 0);
	for (const c of moof.children ?? []) {
		size += measureMoof(c);
	}
	return size;
};

const trunSizes = (trun: Uint8Array): number[] => {
	const flags = (trun[1]! << 16) | (trun[2]! << 8) | trun[3]!;
	const sampleCount = u32(trun, 4);
	const sizes: number[] = [];
	let p = 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
	for (let s = 0; s < sampleCount; s++) {
		if (flags & 0x100) p += 4;
		sizes.push(u32(trun, p));
		p += 4;
		if (flags & 0x400) p += 4;
		if (flags & 0x800) p += 4;
	}
	return sizes;
};

// Read one track's sample bytes straight from the mdat of every fragment (works pre- or
// post-encryption). data_offset (flags 0x1) is present in this file.
const extractRawSamples = (bytes: Uint8Array, trackId: number): Uint8Array[] => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const samples: Uint8Array[] = [];
	for (let i = 0; i < boxes.length - 1; i++) {
		if (boxes[i]!.type !== 'moof' || boxes[i + 1]!.type !== 'mdat') {
			continue;
		}
		const moof = boxes[i]!;
		const mdat = boxes[i + 1]!;
		const traf = (moof.children ?? []).find((t) => {
			const tfhd = findBox([t], 'tfhd');
			return tfhd?.data !== undefined && u32(tfhd.data, 4) === trackId;
		});
		if (traf === undefined) {
			continue;
		}
		const trun = findBox([traf], 'trun')!.data!;
		let cursor = u32(trun, 8) - measureMoof(moof) - 8;
		for (const size of trunSizes(trun)) {
			samples.push(mdat.data!.subarray(cursor, cursor + size));
			cursor += size;
		}
	}
	return samples;
};

// Read one track's per-sample senc subsamples (empty for full-sample audio) across all fragments.
const extractSenc = (bytes: Uint8Array, trackId: number): SubsampleEntry[][] => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const perSample: SubsampleEntry[][] = [];
	for (const moof of boxes.filter(b => b.type === 'moof')) {
		const traf = (moof.children ?? []).find((t) => {
			const tfhd = findBox([t], 'tfhd');
			return tfhd?.data !== undefined && u32(tfhd.data, 4) === trackId;
		});
		if (traf === undefined || findBox([traf], 'senc') === null) {
			continue;
		}
		const senc = findBox([traf], 'senc')!.data!;
		const useSubsample = (senc[3]! & 0x2) !== 0;
		const sampleCount = u32(senc, 4);
		let sp = 8;
		for (let s = 0; s < sampleCount; s++) {
			const subs: SubsampleEntry[] = [];
			if (useSubsample) {
				const n = u16(senc, sp);
				sp += 2;
				for (let k = 0; k < n; k++) {
					subs.push({ clearBytes: u16(senc, sp), cipherBytes: u32(senc, sp + 2) });
					sp += 6;
				}
			}
			perSample.push(subs);
		}
	}
	return perSample;
};

// Walk raw bytes for the absolute offset of the first box of `type` within [start, end).
const findBoxOffset = (bytes: Uint8Array, type: string, start: number, end: number): number => {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const containers = new Set(['moov', 'trak', 'moof', 'traf', 'mdia', 'minf', 'stbl']);
	let offset = start;
	while (offset + 8 <= end) {
		const size = dv.getUint32(offset);
		const boxType = fourcc(bytes, offset);
		if (boxType === type) {
			return offset;
		}
		if (containers.has(boxType)) {
			const nested = findBoxOffset(bytes, type, offset + 8, offset + size);
			if (nested >= 0) {
				return nested;
			}
		}
		offset += size;
	}
	return -1;
};

// In each moof, saio's moof-relative offset must land exactly on the senc first-entry data.
const expectSaioPointsAtSencData = (bytes: Uint8Array): void => {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	while (offset + 8 <= bytes.length) {
		const size = dv.getUint32(offset);
		const type = fourcc(bytes, offset);
		if (type === 'moof') {
			const saioOff = findBoxOffset(bytes, 'saio', offset + 8, offset + size);
			const sencOff = findBoxOffset(bytes, 'senc', offset + 8, offset + size);
			expect(saioOff).toBeGreaterThanOrEqual(0);
			expect(sencOff).toBeGreaterThanOrEqual(0);
			const auxOffset = dv.getUint32(saioOff + 16); // saio: 8 hdr + 4 flags/ver + 4 entry_count
			expect(offset + auxOffset).toBe(sencOff + 8 + 4); // senc header (8) + sample_count (4)
		}
		offset += size;
	}
};

describe('encryptCmaf (real fragmented CMAF)', () => {
	test('encrypts video + audio of bear-640x360-av_frag.mp4 → fork demuxer opens it, samples round-trip', async () => {
		const original = new Uint8Array(readFileSync(FILE));
		const videoId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'avc1');
		const audioId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'mp4a');
		const originalVideo = extractRawSamples(original, videoId);
		const originalAudio = extractRawSamples(original, audioId);
		expect(originalVideo.length).toBeGreaterThan(0);
		expect(originalAudio.length).toBeGreaterThan(0);

		const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });

		// The fork's own demuxer can still open the encrypted file and see both tracks.
		using input = new Input({ source: new BufferSource(encrypted), formats: ALL_FORMATS });
		expect(await input.getPrimaryVideoTrack()).not.toBeNull();
		expect(await input.getPrimaryAudioTrack()).not.toBeNull();

		// Video → encv (+ saiz/saio); audio → enca (full-sample, no saiz/saio). Both carry sinf/tenc/senc.
		const boxes = parseBoxes(encrypted, 0, encrypted.length);
		expect(findBox(boxes, 'encv')).not.toBeNull();
		expect(findBox(boxes, 'enca')).not.toBeNull();
		expect(findBox(boxes, 'tenc')).not.toBeNull();
		expect(findBox(boxes, 'saio')).not.toBeNull();
		expectSaioPointsAtSencData(encrypted);

		// The audio traf is full-sample: senc present, but no saiz/saio (ISO 23001-7 cbcs audio).
		for (const moof of boxes.filter(b => b.type === 'moof')) {
			const audioTraf = (moof.children ?? []).find((t) => {
				const tfhd = findBox([t], 'tfhd');
				return tfhd?.data !== undefined && u32(tfhd.data, 4) === audioId;
			});
			if (audioTraf !== undefined) {
				expect(findBox([audioTraf], 'senc')).not.toBeNull();
				expect(findBox([audioTraf], 'saiz')).toBeNull();
				expect(findBox([audioTraf], 'saio')).toBeNull();
			}
		}

		// Decrypting the encrypted samples recovers the originals exactly (video pattern, audio full-sample).
		const encVideo = extractRawSamples(encrypted, videoId);
		const sencVideo = extractSenc(encrypted, videoId);
		expect(encVideo.length).toBe(originalVideo.length);
		for (let i = 0; i < originalVideo.length; i++) {
			expect([...decryptSample(encVideo[i]!, sencVideo[i]!, 9)]).toEqual([...originalVideo[i]!]);
		}

		const encAudio = extractRawSamples(encrypted, audioId);
		const sencAudio = extractSenc(encrypted, audioId);
		expect(encAudio.length).toBe(originalAudio.length);
		for (let i = 0; i < originalAudio.length; i++) {
			expect([...decryptSample(encAudio[i]!, sencAudio[i]!, 0)]).toEqual([...originalAudio[i]!]);
		}
	});
});

const CENC_IV = new Uint8Array(8).fill(0x11);

// Read one track's per-sample senc entries (IV of `ivSize` bytes, then subsamples if flagged).
const extractSencEntries = (
	bytes: Uint8Array, trackId: number, ivSize: number,
): { iv: Uint8Array; subsamples: SubsampleEntry[] }[] => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const entries: { iv: Uint8Array; subsamples: SubsampleEntry[] }[] = [];
	for (const moof of boxes.filter(b => b.type === 'moof')) {
		const traf = (moof.children ?? []).find((t) => {
			const tfhd = findBox([t], 'tfhd');
			return tfhd?.data !== undefined && u32(tfhd.data, 4) === trackId;
		});
		if (traf === undefined || findBox([traf], 'senc') === null) {
			continue;
		}
		const senc = findBox([traf], 'senc')!.data!;
		const useSubsample = (senc[3]! & 0x2) !== 0;
		const sampleCount = u32(senc, 4);
		let sp = 8;
		for (let s = 0; s < sampleCount; s++) {
			const iv = senc.subarray(sp, sp + ivSize);
			sp += ivSize;
			const subs: SubsampleEntry[] = [];
			if (useSubsample) {
				const n = u16(senc, sp);
				sp += 2;
				for (let k = 0; k < n; k++) {
					subs.push({ clearBytes: u16(senc, sp), cipherBytes: u32(senc, sp + 2) });
					sp += 6;
				}
			}
			entries.push({ iv, subsamples: subs });
		}
	}
	return entries;
};

// Decrypt a per-sample-IV (cenc/cens) sample: cenc is raw AES-CTR, cens is pattern over AES-CTR.
const decryptCtrSample = (
	data: Uint8Array, iv: Uint8Array, subsamples: SubsampleEntry[], scheme: ProtectionScheme, skipByteBlock: number,
): Uint8Array => {
	let crypt: (region: Uint8Array) => Uint8Array;
	if (scheme === 'cenc') {
		const ctr = new AesCtrEncryptor();
		ctr.initializeWithIv(KEY, iv);
		crypt = (region) => {
			const copy = new Uint8Array(region);
			ctr.crypt(copy);
			return copy;
		};
	} else {
		const pattern = new AesPatternCryptor(
			1, skipByteBlock, 'encryptIfCryptByteBlockRemaining', false, new AesCtrEncryptor(),
		);
		pattern.initializeWithIv(KEY, iv);
		crypt = region => pattern.crypt(region);
	}
	const out = new Uint8Array(data.length);
	if (subsamples.length === 0) {
		out.set(crypt(data));
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		out.set(data.subarray(offset, offset + clearBytes), offset);
		offset += clearBytes;
		if (cipherBytes > 0) {
			out.set(crypt(data.subarray(offset, offset + cipherBytes)), offset);
			offset += cipherBytes;
		}
	}
	return out;
};

describe.each<{ scheme: ProtectionScheme; skip: number }>([
	{ scheme: 'cenc', skip: 0 },
	{ scheme: 'cens', skip: 9 },
])('encryptCmaf per-sample-IV scheme $scheme', ({ scheme, skip }) => {
	test('encrypts video + audio with an 8-byte per-sample IV → demuxer opens it, samples round-trip', async () => {
		const original = new Uint8Array(readFileSync(FILE));
		const videoId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'avc1');
		const audioId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'mp4a');
		const originalVideo = extractRawSamples(original, videoId);
		const originalAudio = extractRawSamples(original, audioId);

		const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: CENC_IV, scheme });

		using input = new Input({ source: new BufferSource(encrypted), formats: ALL_FORMATS });
		expect(await input.getPrimaryVideoTrack()).not.toBeNull();
		expect(await input.getPrimaryAudioTrack()).not.toBeNull();

		const boxes = parseBoxes(encrypted, 0, encrypted.length);
		// tenc declares an 8-byte per-sample IV and carries no constant IV.
		const tenc = findBox(boxes, 'tenc')!.data!;
		expect(tenc[7]).toBe(8); // default_per_sample_iv_size
		expectSaioPointsAtSencData(encrypted);

		// Per-sample-IV audio carries senc IV entries, so saiz/saio ARE present (unlike cbcs audio).
		for (const moof of boxes.filter(b => b.type === 'moof')) {
			const audioTraf = (moof.children ?? []).find((t) => {
				const tfhd = findBox([t], 'tfhd');
				return tfhd?.data !== undefined && u32(tfhd.data, 4) === audioId;
			});
			if (audioTraf !== undefined) {
				expect(findBox([audioTraf], 'saiz')).not.toBeNull();
				expect(findBox([audioTraf], 'saio')).not.toBeNull();
			}
		}

		const encVideo = extractRawSamples(encrypted, videoId);
		const videoEntries = extractSencEntries(encrypted, videoId, 8);
		expect(encVideo.length).toBe(originalVideo.length);
		for (let i = 0; i < originalVideo.length; i++) {
			const dec = decryptCtrSample(encVideo[i]!, videoEntries[i]!.iv, videoEntries[i]!.subsamples, scheme, skip);
			expect([...dec]).toEqual([...originalVideo[i]!]);
		}

		const encAudio = extractRawSamples(encrypted, audioId);
		const audioEntries = extractSencEntries(encrypted, audioId, 8);
		expect(encAudio.length).toBe(originalAudio.length);
		for (let i = 0; i < originalAudio.length; i++) {
			const dec = decryptCtrSample(encAudio[i]!, audioEntries[i]!.iv, audioEntries[i]!.subsamples, scheme, 0);
			expect([...dec]).toEqual([...originalAudio[i]!]);
		}
	});
});

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
};

// Split a self-contained fragmented file into its init (ftyp…moov) and media (styp/sidx/moof/mdat…).
const splitInitAndMedia = (whole: Uint8Array): { init: Uint8Array; media: Uint8Array } => {
	const boxes = parseBoxes(whole, 0, whole.length);
	const mediaStart = boxes.findIndex(b => b.type === 'sidx' || b.type === 'styp' || b.type === 'moof');
	return { init: serializeBoxes(boxes.slice(0, mediaStart)), media: serializeBoxes(boxes.slice(mediaStart)) };
};

describe('encryptCmafInit + encryptCmafSegment (split init.mp4 / *.m4s)', () => {
	for (const scheme of ['cbcs', 'cenc'] as ProtectionScheme[]) {
		const iv = () => (scheme === 'cbcs' ? new Uint8Array(16).fill(0x11) : new Uint8Array(8).fill(0x11));

		test(`${scheme}: encrypting init + media separately reproduces the whole-file output byte-for-byte`, () => {
			const whole = new Uint8Array(readFileSync(FILE));
			const { init, media } = splitInitAndMedia(whole);
			const encInit = encryptCmafInit(init, { key: KEY, kid: KID, iv: iv(), scheme });
			const encSegment = encryptCmafSegment(init, media, { key: KEY, kid: KID, iv: iv(), scheme });
			const wholeEncrypted = encryptCmaf(whole, { key: KEY, kid: KID, iv: iv(), scheme });
			expect([...concat(encInit, encSegment)]).toEqual([...wholeEncrypted]);
		});
	}

	test('cbcs: each media segment encrypts independently and the reassembly decrypts', () => {
		const whole = new Uint8Array(readFileSync(FILE));
		const videoId = trackIdOf(findBox(parseBoxes(whole, 0, whole.length), 'moov')!, 'avc1');
		const originalVideo = extractRawSamples(whole, videoId);

		const { init, media } = splitInitAndMedia(whole);
		// Split the media into two segments at a moof boundary and encrypt each on its own (cbcs: no
		// cross-segment IV state, so segments are independent — the real per-segment delivery case).
		const mediaBoxes = parseBoxes(media, 0, media.length);
		const secondMoof = mediaBoxes.findIndex((b, i) => b.type === 'moof' && i > 1);
		const seg1 = serializeBoxes(mediaBoxes.slice(0, secondMoof));
		const seg2 = serializeBoxes(mediaBoxes.slice(secondMoof));

		const opts = { key: KEY, kid: KID, iv: new Uint8Array(16).fill(0x11), scheme: 'cbcs' as ProtectionScheme };
		const reassembled = concat(
			encryptCmafInit(init, opts),
			encryptCmafSegment(init, seg1, opts),
			encryptCmafSegment(init, seg2, opts),
		);

		const encVideo = extractRawSamples(reassembled, videoId);
		const sencVideo = extractSenc(reassembled, videoId);
		expect(encVideo.length).toBe(originalVideo.length);
		for (let i = 0; i < originalVideo.length; i++) {
			expect([...decryptSample(encVideo[i]!, sencVideo[i]!, 9)]).toEqual([...originalVideo[i]!]);
		}
	});
});
