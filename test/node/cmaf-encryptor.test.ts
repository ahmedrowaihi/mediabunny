import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Demuxer } from 'node-av';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { AesCbcDecryptor } from '../../src/crypto/aes-cbc-encryptor.js';
import { AesCtrEncryptor } from '../../src/crypto/aes-ctr-encryptor.js';
import { AesPatternCryptor } from '../../src/crypto/aes-pattern-cryptor.js';
import { type MutableBox, findBox, measureBox, parseBoxes, serializeBoxes } from '../../src/crypto/box-tree.js';
import { encryptCmaf, encryptCmafInit, encryptCmafSegment } from '../../src/crypto/cmaf-encryptor.js';
import { buildCommonPssh, buildWidevinePssh } from '../../src/crypto/pssh.js';
import type { ProtectionScheme, SubsampleEntry } from '../../src/crypto/subsample-generator.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { CmafOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedVideoPacketSource, TextSubtitleSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

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
const decryptSampleWith = (
	data: Uint8Array,
	subsamples: SubsampleEntry[],
	skipByteBlock: number,
	key: Uint8Array,
	iv: Uint8Array,
): Uint8Array => {
	const cryptor = new AesPatternCryptor(
		1, skipByteBlock, 'encryptIfCryptByteBlockRemaining', true, new AesCbcDecryptor(),
	);
	cryptor.initializeWithIv(key, new Uint8Array(16));
	cryptor.setIv(iv);
	const out = new Uint8Array(data.length);
	if (subsamples.length === 0) {
		out.set(data);
		cryptor.crypt(out);
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		out.set(data.subarray(offset, offset + clearBytes), offset);
		offset += clearBytes;
		if (cipherBytes > 0) {
			out.set(data.subarray(offset, offset + cipherBytes), offset);
			cryptor.crypt(out.subarray(offset, offset + cipherBytes));
			offset += cipherBytes;
		}
	}
	return out;
};

const decryptSample = (data: Uint8Array, subsamples: SubsampleEntry[], skipByteBlock: number): Uint8Array =>
	decryptSampleWith(data, subsamples, skipByteBlock, KEY, IV);

const trackIdOf = (moov: MutableBox, entryType: string): number => {
	for (const trak of (moov.children ?? []).filter(b => b.type === 'trak')) {
		if (findBox([trak], entryType) !== null) {
			const tkhd = findBox([trak], 'tkhd')!.data!;
			return u32(tkhd, tkhd[0]! === 1 ? 20 : 12);
		}
	}
	throw new Error(`No track with sample entry ${entryType}`);
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

const flagsOf = (box: Uint8Array) => (box[1]! << 16) | (box[2]! << 8) | box[3]!;

// Read one track's sample bytes straight from the mdat of every fragment (works pre- or
// post-encryption), resolving every trun of the traf against the offset the tfhd says they are
// measured from — an explicit base_data_offset, or the enclosing moof.
const extractRawSamples = (bytes: Uint8Array, trackId: number): Uint8Array[] => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const samples: Uint8Array[] = [];
	let offset = 0;
	for (let i = 0; i < boxes.length; i++) {
		const moofOffset = offset;
		offset += measureBox(boxes[i]!);
		if (boxes[i]!.type !== 'moof' || boxes[i + 1]?.type !== 'mdat') {
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
		const tfhd = findBox([traf], 'tfhd')!.data!;
		const base = flagsOf(tfhd) & 0x1
			? Number(new DataView(tfhd.buffer, tfhd.byteOffset, tfhd.byteLength).getBigUint64(8))
			: moofOffset;
		const mdatDataStart = moofOffset + measureBox(moof) + 8;
		let cursor = 0;
		for (const trun of (traf.children ?? []).filter(b => b.type === 'trun')) {
			if (flagsOf(trun.data!) & 0x1) {
				cursor = base + u32(trun.data!, 8) - mdatDataStart;
			}
			for (const size of trunSizes(trun.data!)) {
				samples.push(mdat.data!.subarray(cursor, cursor + size));
				cursor += size;
			}
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
			// senc: 8 hdr + 4 flags/ver + 4 sample_count. Omitting the flags/ver word here is the same
			// mistake the encryptor made, which is why this assertion used to pass over a broken file.
			expect(offset + auxOffset).toBe(sencOff + 8 + 4 + 4);
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

	test('encrypts AV1 (bear-av1.mp4) → encv/av01 with tile subsamples, samples round-trip', async () => {
		const av1File = path.join(
			new URL('.', import.meta.url).pathname,
			'../../../shaka-packager/packager/media/test/data/bear-av1.mp4',
		);
		const original = new Uint8Array(readFileSync(av1File));
		const videoId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'av01');
		const originalVideo = extractRawSamples(original, videoId);
		expect(originalVideo.length).toBeGreaterThan(0);

		const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });

		// The fork's demuxer opens the encrypted AV1.
		using input = new Input({ source: new BufferSource(encrypted), formats: ALL_FORMATS });
		expect(await input.getPrimaryVideoTrack()).not.toBeNull();

		const boxes = parseBoxes(encrypted, 0, encrypted.length);
		expect(findBox(boxes, 'encv')).not.toBeNull();
		// frma restores the original av01 sample entry format.
		expect(String.fromCharCode(...findBox(boxes, 'frma')!.data!.subarray(0, 4))).toBe('av01');
		// AV1 is subsample-encrypted (only tile data), so senc sets the subsample flag — not full-sample.
		expect(findBox(boxes, 'senc')!.data![3]! & 0x2).toBe(0x2);

		// Decrypting recovers the originals exactly (video pattern, skip 9).
		const encVideo = extractRawSamples(encrypted, videoId);
		const sencVideo = extractSenc(encrypted, videoId);
		expect(encVideo.length).toBe(originalVideo.length);
		for (let i = 0; i < originalVideo.length; i++) {
			expect([...decryptSample(encVideo[i]!, sencVideo[i]!, 9)]).toEqual([...originalVideo[i]!]);
		}
	});

	test('AV1 through the split init/segment (JIT) API round-trips per segment', async () => {
		const av1File = path.join(
			new URL('.', import.meta.url).pathname,
			'../../../shaka-packager/packager/media/test/data/bear-av1.mp4',
		);
		const original = new Uint8Array(readFileSync(av1File));
		const { init, segment } = splitInitAndSegment(original);
		const videoId = trackIdOf(findBox(parseBoxes(init, 0, init.length), 'moov')!, 'av01');
		const originalVideo = extractRawSamples(original, videoId);

		// Encrypt the init once and the media segment separately — the JIT delivery shape.
		const encInit = encryptCmafInit(init, { key: KEY, kid: KID, iv: IV });
		const encSegment = encryptCmafSegment(init, segment, { key: KEY, kid: KID, iv: IV, ivState: new Map() });
		expect(findBox(parseBoxes(encInit, 0, encInit.length), 'encv')).not.toBeNull();

		// Reassemble init + segment; the samples still decrypt back byte-exact.
		const reassembled = new Uint8Array(encInit.length + encSegment.length);
		reassembled.set(encInit, 0);
		reassembled.set(encSegment, encInit.length);

		const encVideo = extractRawSamples(reassembled, videoId);
		const sencVideo = extractSenc(reassembled, videoId);
		expect(encVideo.length).toBe(originalVideo.length);
		expect(encVideo.length).toBeGreaterThan(0);
		for (let i = 0; i < originalVideo.length; i++) {
			expect([...decryptSample(encVideo[i]!, sencVideo[i]!, 9)]).toEqual([...originalVideo[i]!]);
		}
	});
});

// Split a single-fragment CMAF file into its init (ftyp…moov) and first media segment (moof + mdat).
const splitInitAndSegment = (bytes: Uint8Array): { init: Uint8Array; segment: Uint8Array } => {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 0;
	let moofStart = -1;
	let segmentEnd = bytes.length;
	while (pos + 8 <= bytes.length) {
		const size = dv.getUint32(pos);
		const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
		if (type === 'moof' && moofStart < 0) {
			moofStart = pos;
		} else if (moofStart >= 0 && type !== 'moof' && type !== 'mdat') {
			segmentEnd = pos; // stop before trailing boxes (mfra) so the segment is just moof + mdat
			break;
		}
		if (size < 8) {
			break;
		}
		pos += size;
	}
	return { init: bytes.subarray(0, moofStart), segment: bytes.subarray(moofStart, segmentEnd) };
};

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
	let crypt: (region: Uint8Array) => void;
	// A pattern scheme with no pattern is its base cipher: cens over a full-sample track is plain
	// AES-CTR, trailing partial block included. FFmpeg reads it that way (see the framemd5 check).
	if (scheme === 'cenc' || (scheme === 'cens' && skipByteBlock === 0)) {
		const ctr = new AesCtrEncryptor();
		ctr.initializeWithIv(KEY, iv);
		crypt = region => ctr.crypt(region);
	} else {
		const pattern = new AesPatternCryptor(
			1, skipByteBlock, 'encryptIfCryptByteBlockRemaining', false, new AesCtrEncryptor(),
		);
		pattern.initializeWithIv(KEY, iv);
		crypt = region => pattern.crypt(region);
	}
	const out = new Uint8Array(data.length);
	if (subsamples.length === 0) {
		out.set(data);
		crypt(out);
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		out.set(data.subarray(offset, offset + clearBytes), offset);
		offset += clearBytes;
		if (cipherBytes > 0) {
			out.set(data.subarray(offset, offset + cipherBytes), offset);
			crypt(out.subarray(offset, offset + cipherBytes));
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

// Decrypt a cbc1 sample: AES-CBC, per-sample IV, chained across cipher regions within the sample.
const decryptCbc1Sample = (data: Uint8Array, iv: Uint8Array, subsamples: SubsampleEntry[]): Uint8Array => {
	const cbc = new AesCbcDecryptor();
	cbc.initializeWithIv(KEY, iv);
	const out = new Uint8Array(data);
	if (subsamples.length === 0) {
		cbc.crypt(out);
		return out;
	}
	let offset = 0;
	for (const { clearBytes, cipherBytes } of subsamples) {
		offset += clearBytes;
		if (cipherBytes > 0) {
			cbc.crypt(out.subarray(offset, offset + cipherBytes));
			offset += cipherBytes;
		}
	}
	return out;
};

describe('encryptCmaf cbc1 (AES-CBC, per-sample IV)', () => {
	test('cbc1: video + audio round-trip; demuxer opens; tenc has per-sample IV', async () => {
		const original = new Uint8Array(readFileSync(FILE));
		const videoId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'avc1');
		const audioId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'mp4a');
		const originalVideo = extractRawSamples(original, videoId);
		const originalAudio = extractRawSamples(original, audioId);

		const iv = new Uint8Array(16).fill(0x11); // cbc1: 16-byte per-sample IV
		const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv, scheme: 'cbc1' });

		using input = new Input({ source: new BufferSource(encrypted), formats: ALL_FORMATS });
		expect(await input.getPrimaryVideoTrack()).not.toBeNull();
		const boxes = parseBoxes(encrypted, 0, encrypted.length);
		expect(findBox(boxes, 'tenc')!.data![7]).toBe(16); // default_per_sample_iv_size

		const encVideo = extractRawSamples(encrypted, videoId);
		const videoEntries = extractSencEntries(encrypted, videoId, 16);
		expect(encVideo.length).toBe(originalVideo.length);
		for (let i = 0; i < originalVideo.length; i++) {
			expect([...decryptCbc1Sample(encVideo[i]!, videoEntries[i]!.iv, videoEntries[i]!.subsamples)])
				.toEqual([...originalVideo[i]!]);
		}

		const encAudio = extractRawSamples(encrypted, audioId);
		const audioEntries = extractSencEntries(encrypted, audioId, 16);
		for (let i = 0; i < originalAudio.length; i++) {
			expect([...decryptCbc1Sample(encAudio[i]!, audioEntries[i]!.iv, audioEntries[i]!.subsamples)])
				.toEqual([...originalAudio[i]!]);
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
			const encSegment = encryptCmafSegment(init, media, {
				key: KEY, kid: KID, iv: iv(), scheme, ivState: new Map(),
			});
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

		const opts = {
			key: KEY, kid: KID, iv: new Uint8Array(16).fill(0x11), scheme: 'cbcs' as ProtectionScheme,
			ivState: new Map<number, Uint8Array>(),
		};
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

	// `ivState` is a required parameter, so TypeScript refuses this call outright; the runtime check
	// behind it is the backstop for a caller that is not type-checked.
	test.each(['cbcs', 'cenc', 'cens', 'cbc1'] as ProtectionScheme[])(
		'%s: a segment encrypted without ivState is refused rather than repeating the keystream',
		(scheme) => {
			const whole = new Uint8Array(readFileSync(FILE));
			const { init, media } = splitInitAndMedia(whole);
			// @ts-expect-error omitting ivState is a compile error, which is the point
			expect(() => encryptCmafSegment(init, media, { key: KEY, kid: KID, iv: CENC_IV, scheme }))
				.toThrow(/ivState/);
		},
	);

	// Two tracks consume their IVs at different rates (15 video vs 23 audio samples in fragment 1),
	// and a 16-byte IV advances by cipher block count, not sample count. Only per-track state carried
	// out of the encryptor reproduces both — anything derived from a sample index repeats a counter,
	// and a repeated AES-CTR counter under one key leaks plaintext_A XOR plaintext_B.
	test.each([
		{ scheme: 'cenc' as ProtectionScheme, ivLength: 8 },
		{ scheme: 'cenc' as ProtectionScheme, ivLength: 16 },
		{ scheme: 'cens' as ProtectionScheme, ivLength: 8 },
		{ scheme: 'cens' as ProtectionScheme, ivLength: 16 },
		{ scheme: 'cbc1' as ProtectionScheme, ivLength: 16 },
	])('$scheme ($ivLength-byte IV): per-segment IVs continue the whole-file sequence on every track', (
		{ scheme, ivLength },
	) => {
		const whole = new Uint8Array(readFileSync(FILE));
		const iv = new Uint8Array(ivLength).fill(0x11);
		const videoId = trackIdOf(findBox(parseBoxes(whole, 0, whole.length), 'moov')!, 'avc1');
		const audioId = trackIdOf(findBox(parseBoxes(whole, 0, whole.length), 'moov')!, 'mp4a');

		const { init, media } = splitInitAndMedia(whole);
		const mediaBoxes = parseBoxes(media, 0, media.length);
		const secondMoof = mediaBoxes.findIndex((b, i) => b.type === 'moof' && i > 1);
		const seg1 = serializeBoxes(mediaBoxes.slice(0, secondMoof));
		const seg2 = serializeBoxes(mediaBoxes.slice(secondMoof));

		const opts = { key: KEY, kid: KID, iv, scheme, ivState: new Map<number, Uint8Array>() };
		const reassembled = concat(
			encryptCmafInit(init, opts),
			encryptCmafSegment(init, seg1, opts),
			encryptCmafSegment(init, seg2, opts),
		);
		const wholeEncrypted = encryptCmaf(whole, { key: KEY, kid: KID, iv, scheme });

		for (const trackId of [videoId, audioId]) {
			const entries = extractSencEntries(reassembled, trackId, ivLength);
			const single = extractSencEntries(wholeEncrypted, trackId, ivLength);
			expect(single.length).toBeGreaterThan(0);
			expect(entries.map(e => [...e.iv])).toEqual(single.map(e => [...e.iv]));

			// The property the continuation buys: no two samples that consume keystream share an IV.
			// (A sample shorter than one AES block encrypts nothing and consumes none, so it may
			// repeat the IV of its neighbour — the last AAC frames of this file do exactly that.)
			const samples = extractRawSamples(reassembled, trackId);
			const consuming = entries
				.filter((entry, i) => (entry.subsamples.length > 0
					? entry.subsamples.some(s => s.cipherBytes > 0)
					: samples[i]!.length >= 16))
				.map(entry => [...entry.iv].join(','));
			expect(new Set(consuming).size).toBe(consuming.length);
		}
	});
});

/*
 * Every test above reads the encryptor's output with mediabunny's own demuxer, which cannot catch a
 * spec defect: the same codebase wrote and read it. FFmpeg is an independent reader, and it rejected
 * output these tests called good — `saiz` counted a subsample field `senc` had not written, and `saio`
 * pointed 4 bytes before the first `senc` entry.
 *
 * The source is muxed here rather than shipped as a fixture: `bear-640x360-av_frag.mp4` is fragmented
 * MP4, not CMAF, and FFmpeg cannot decrypt that shape whoever encrypts it — its own encryptor's output
 * for that file fails identically, so it cannot tell a real defect from its own limitation.
 */
// Each fragment grows by its senc/saiz/saio, so a `sidx` written for the plaintext would send a
// byte-range reader to the wrong offset for every subsegment after the first.
const expectSidxMatchesFragments = (bytes: Uint8Array): void => {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const stated: number[] = [];
	const actual: number[] = [];
	let moofSize = 0;
	let offset = 0;

	while (offset + 8 <= bytes.length) {
		const stated32 = dv.getUint32(offset);
		// size 1 means the real size follows the type as a 64-bit `largesize`.
		const header = stated32 === 1 ? 16 : 8;
		const size = stated32 === 1 ? Number(dv.getBigUint64(offset + 8)) : stated32;
		const type = fourcc(bytes, offset);
		if (type === 'sidx') {
			const payload = bytes.subarray(offset + header, offset + size);
			// version(1) + flags(3) + reference_ID(4) + timescale(4) + times(8 or 16) + count(4)
			const first = 12 + (payload[0] === 0 ? 8 : 16) + 4;
			stated.push(u32(payload, first) & 0x7fffffff);
		}
		if (type === 'moof') {
			moofSize = size;
		}
		if (type === 'mdat' && moofSize > 0) {
			actual.push(moofSize + size);
			moofSize = 0;
		}
		offset += size;
	}

	expect(stated.length).toBeGreaterThan(0);
	expect(stated).toEqual(actual);
};

test.each(['cenc', 'cbcs'] as ProtectionScheme[])('%s: the sidx still describes the fragments it indexes', (scheme) => {
	const original = new Uint8Array(readFileSync(FILE));
	expectSidxMatchesFragments(original);
	expectSidxMatchesFragments(encryptCmaf(original, { key: KEY, kid: KID, iv: IV, scheme }));
});

// Re-headers the first top-level `sidx` in the 64-bit form ISO/IEC 14496-12 allows: size 1, with the
// real size in a `largesize` field after the type. The box grows 8 bytes, so it arrives at a
// different size than it will be written as — which is what separates the two layouts.
const withLargeSidxHeader = (bytes: Uint8Array): Uint8Array => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	while (fourcc(bytes, offset) !== 'sidx') {
		offset += view.getUint32(offset);
	}

	const size = view.getUint32(offset);
	const out = new Uint8Array(bytes.length + 8);
	out.set(bytes.subarray(0, offset));

	const header = new DataView(out.buffer, offset, 16);
	header.setUint32(0, 1);
	out.set(bytes.subarray(offset + 4, offset + 8), offset + 4);
	header.setBigUint64(8, BigInt(size + 8));
	out.set(bytes.subarray(offset + 8, offset + size), offset + 16);
	out.set(bytes.subarray(offset + size), offset + size + 8);
	return out;
};

test.each(['cenc', 'cbcs'] as ProtectionScheme[])(
	'%s: a sidx that arrived with a 64-bit header is still restated correctly',
	(scheme) => {
		const large = withLargeSidxHeader(new Uint8Array(readFileSync(FILE)));
		expectSidxMatchesFragments(large);
		expectSidxMatchesFragments(encryptCmaf(large, { key: KEY, kid: KID, iv: IV, scheme }));
	},
);

// The absolute start of every top-level box, ending with the total size.
const boxStarts = (boxes: MutableBox[]): number[] => {
	const starts: number[] = [];
	let offset = 0;
	for (const box of boxes) {
		starts.push(offset);
		offset += measureBox(box);
	}
	starts.push(offset);
	return starts;
};

const fragmentIndexes = (boxes: MutableBox[]): number[] =>
	boxes.flatMap((box, i) => (box.type === 'moof' && boxes[i + 1]?.type === 'mdat' ? [i] : []));

const sidxBox = (refs: { size: number; type: number }[], firstOffset: number): MutableBox => {
	const data = new Uint8Array(12 + 8 + 4 + refs.length * 12);
	setU32(data, 4, 1); // reference_ID
	setU32(data, 8, 30000); // timescale
	setU32(data, 16, firstOffset);
	new DataView(data.buffer).setUint16(22, refs.length);
	refs.forEach((ref, i) => {
		setU32(data, 24 + i * 12, (ref.type << 31) | ref.size);
		setU32(data, 28 + i * 12, 15015); // subsegment_duration
		setU32(data, 32 + i * 12, 0x90000000); // starts_with_SAP
	});
	return { type: 'sidx', data };
};

// Replace this fixture's per-fragment sidx boxes with one at the front whose references each span
// `spans[i]` fragments, after a first_offset skipping the first `skipped` of them. The `styp` before
// the last fragment is deliberately kept: a reference spanning it covers those bytes too.
const withSpanningSidx = (bytes: Uint8Array, spans: number[], skipped: number): Uint8Array => {
	const boxes = parseBoxes(bytes, 0, bytes.length).filter(b => b.type !== 'sidx');
	const starts = boxStarts(boxes);
	const fragments = fragmentIndexes(boxes);
	const startOf = (n: number) => (n < fragments.length ? starts[fragments[n]!]! : starts[starts.length - 1]!);

	let at = skipped;
	const refs = spans.map((span) => {
		const size = startOf(at + span) - startOf(at);
		at += span;
		return { size, type: 0 };
	});
	boxes.splice(fragments[0]!, 0, sidxBox(refs, startOf(skipped) - startOf(0)));
	return serializeBoxes(boxes);
};

// A top-level sidx whose type-1 references name this fixture's per-fragment sidx boxes. Each such
// reference measures to the next referenced item, so it covers the sub-index AND everything that
// sub-index describes — fragments included.
const withHierarchicalSidx = (bytes: Uint8Array): Uint8Array => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const subIndexes = boxes.flatMap((box, i) => (box.type === 'sidx' ? [i] : []));
	const starts = boxStarts(boxes);
	const refs = subIndexes.map((index, n) => ({
		size: (n + 1 < subIndexes.length ? starts[subIndexes[n + 1]!]! : starts[starts.length - 1]!) - starts[index]!,
		type: 1,
	}));
	boxes.splice(subIndexes[0]!, 0, sidxBox(refs, 0));
	return serializeBoxes(boxes);
};

// Every distance a sidx states is a gap between two positions in the file, and every one of those
// positions is the start of a box (or the end of the file) — a subsegment or a sub-index never
// begins mid-box. Walking them is how a byte-range reader uses the index, so this is what breaks.
const expectSidxDistancesLandOnBoxes = (bytes: Uint8Array): void => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const starts = boxStarts(boxes);
	let checked = 0;
	for (let i = 0; i < boxes.length; i++) {
		if (boxes[i]!.type !== 'sidx') {
			continue;
		}
		const data = boxes[i]!.data!;
		expect(data[0]).toBe(0); // version 0: 32-bit times and offsets
		let cursor = starts[i]! + measureBox(boxes[i]!) + u32(data, 16);
		expect(starts).toContain(cursor);
		for (let r = 0; r < u16(data, 22); r++) {
			cursor += u32(data, 24 + r * 12) & 0x7fffffff;
			expect(starts).toContain(cursor);
			checked++;
		}
	}
	expect(checked).toBeGreaterThan(0);
};

const expectSpanningSidxMatches = (bytes: Uint8Array, spans: number[], skipped: number): void => {
	expectSidxDistancesLandOnBoxes(bytes);
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const starts = boxStarts(boxes);
	const fragments = fragmentIndexes(boxes);
	const startOf = (n: number) => (n < fragments.length ? starts[fragments[n]!]! : starts[starts.length - 1]!);
	const sidx = boxes.find(b => b.type === 'sidx')!.data!;

	expect(u32(sidx, 16)).toBe(startOf(skipped) - startOf(0));
	let at = skipped;
	spans.forEach((span, i) => {
		expect(u32(sidx, 24 + i * 12) & 0x7fffffff).toBe(startOf(at + span) - startOf(at));
		at += span;
	});
};

// One reference may cover several fragments, and first_offset may skip whole fragments before the
// first one indexed — both are byte counts over fragments that encryption grows.
test.each([
	{ spans: [3, 3], skipped: 0 },
	{ spans: [4], skipped: 2 },
	{ spans: [6], skipped: 0 }, // one reference over every fragment — and over the styp between them
])('cbcs: a sidx spanning $spans fragments after $skipped skipped still describes them', ({ spans, skipped }) => {
	const original = withSpanningSidx(new Uint8Array(readFileSync(FILE)), spans, skipped);
	expectSpanningSidxMatches(original, spans, skipped);
	expectSpanningSidxMatches(encryptCmaf(original, { key: KEY, kid: KID, iv: IV }), spans, skipped);
});

// A fragmented MP4 from mediabunny's own muxer, which writes an `mfra` at the end.
const fragmentedSource = async (): Promise<Uint8Array> => {
	using input = new Input({
		source: new FilePathSource(path.join(new URL('.', import.meta.url).pathname, '../public/demo.mp4')),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});
	await (await Conversion.init({ input, output })).execute();
	return new Uint8Array(output.target.buffer!);
};

describe('pssh boxes in the init', () => {
	const initOf = () => splitInitAndMedia(new Uint8Array(readFileSync(FILE))).init;

	test('stating no boxes leaves the output unchanged', () => {
		const init = initOf();
		const opts = { key: KEY, kid: KID, iv: IV };
		expect([...encryptCmafInit(init, { ...opts, pssh: [] })]).toEqual([...encryptCmafInit(init, opts)]);
	});

	test('the boxes are written into the moov, after the traks', () => {
		const widevine = buildWidevinePssh(KID);
		const encrypted = encryptCmafInit(initOf(), {
			key: KEY, kid: KID, iv: IV, pssh: [widevine, buildCommonPssh([KID])],
		});

		const moov = findBox(parseBoxes(encrypted, 0, encrypted.length), 'moov')!;
		const types = moov.children!.map(child => child.type);
		expect(types.slice(-2)).toEqual(['pssh', 'pssh']);
		expect(types.indexOf('pssh')).toBeGreaterThan(types.lastIndexOf('trak'));
		expect([...serializeBoxes([moov.children!.at(-2)!])]).toEqual([...widevine]);
	});

	test('a reader finds the boxes in the encrypted file', async () => {
		const { init, media } = splitInitAndMedia(new Uint8Array(readFileSync(FILE)));
		const opts = { key: KEY, kid: KID, iv: IV, pssh: [buildWidevinePssh(KID)] };
		const file = concat(
			encryptCmafInit(init, opts),
			encryptCmafSegment(init, media, { ...opts, ivState: new Map() }),
		);

		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const boxes = await input.getPsshBoxes();
		expect(boxes.length).toBe(1);
	});

	test('the whole-file and split paths still agree', () => {
		const whole = new Uint8Array(readFileSync(FILE));
		const { init, media } = splitInitAndMedia(whole);
		const opts = { key: KEY, kid: KID, iv: IV, pssh: [buildWidevinePssh(KID)] };

		const split = concat(
			encryptCmafInit(init, opts),
			encryptCmafSegment(init, media, { ...opts, ivState: new Map() }),
		);
		expect([...split]).toEqual([...encryptCmaf(whole, opts)]);
	});

	const chunkOffsets = (bytes: Uint8Array): number[] => {
		const offsets: number[] = [];
		const walk = (boxes: MutableBox[]) => {
			for (const box of boxes) {
				if (box.type === 'stco' && box.data !== undefined) {
					const view = new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength);
					for (let i = 0; i < view.getUint32(4); i++) {
						offsets.push(view.getUint32(8 + i * 4));
					}
				}
				if (box.children !== undefined) {
					walk(box.children);
				}
			}
		};
		walk(parseBoxes(bytes, 0, bytes.length));
		return offsets;
	};

	// The boxes grow the moov, which moves the mdat every chunk offset points into.
	test('a progressive file has its chunk offsets restated for the added boxes', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(new URL('.', import.meta.url).pathname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await (await Conversion.init({ input, output })).execute();
		const clear = new Uint8Array(output.target.buffer!);
		expect(findBox(parseBoxes(clear, 0, clear.length), 'moof')).toBeNull();

		const widevine = buildWidevinePssh(KID);
		const opts = { key: KEY, kid: KID, iv: IV };
		const without = chunkOffsets(encryptCmaf(clear, opts));
		const withPssh = chunkOffsets(encryptCmaf(clear, { ...opts, pssh: [widevine] }));

		expect(without.length).toBeGreaterThan(0);
		expect(withPssh.length).toBe(without.length);
		for (let i = 0; i < without.length; i++) {
			expect(withPssh[i]).toBe(without[i]! + widevine.length);
		}
	});

	test('an entry that is not exactly one pssh box is refused', () => {
		const init = initOf();
		const opts = { key: KEY, kid: KID, iv: IV };
		const widevine = buildWidevinePssh(KID);

		expect(() => encryptCmafInit(init, { ...opts, pssh: [new Uint8Array(8)] }))
			.toThrow(/one complete pssh box/);
		expect(() => encryptCmafInit(init, { ...opts, pssh: [concat(widevine, widevine)] }))
			.toThrow(/one complete pssh box/);
	});
});

describe('encryptCmaf (progressive, non-fragmented)', () => {
	// A file whose samples the moov sample table locates, with no moof anywhere.
	const progressiveSource = async (fixture: string): Promise<Uint8Array> => {
		using input = new Input({
			source: new FilePathSource(path.join(new URL('.', import.meta.url).pathname, fixture)),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await (await Conversion.init({ input, output })).execute();
		const bytes = new Uint8Array(output.target.buffer!);
		expect(findBox(parseBoxes(bytes, 0, bytes.length), 'moof')).toBeNull();
		return bytes;
	};

	// Chunk offsets move for every track, but only audio and video have samples to encrypt — so a
	// restatement driven by the encryption loop leaves the others pointing before the shift.
	test('a track with nothing to encrypt still has its chunk offsets restated', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(new URL('.', import.meta.url).pathname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const decoderConfig = (await videoTrack.getDecoderConfig())!;

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const video = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(video);
		const subtitles = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(subtitles);
		await output.start();

		let added = 0;
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			await video.add(packet, { decoderConfig });
			if (++added === 12) break;
		}
		await subtitles.add('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n');
		await output.finalize();

		const plain = new Uint8Array(output.target.buffer!);
		const encrypted = encryptCmaf(plain, { key: KEY, kid: KID, iv: IV, scheme: 'cenc' });

		const chunkOffsetsOf = (bytes: Uint8Array, handler: string) => {
			const moov = findBox(parseBoxes(bytes, 0, bytes.length), 'moov')!;
			const trak = (moov.children ?? []).filter(box => box.type === 'trak').find((candidate) => {
				const hdlr = findBox([candidate], 'hdlr')!.data!;
				return String.fromCharCode(...hdlr.subarray(8, 12)) === handler;
			})!;
			const stco = findBox([trak], 'stco')!.data!;
			const view = new DataView(stco.buffer, stco.byteOffset, stco.byteLength);
			return Array.from({ length: view.getUint32(4) }, (_, i) => view.getUint32(8 + i * 4));
		};

		const shift = chunkOffsetsOf(encrypted, 'vide')[0]! - chunkOffsetsOf(plain, 'vide')[0]!;
		expect(shift).toBeGreaterThan(0);
		expect(chunkOffsetsOf(encrypted, 'text'))
			.toEqual(chunkOffsetsOf(plain, 'text').map(offset => offset + shift));
	});

	const trackSampleSizes = (stbl: MutableBox): number[] => {
		const stsz = findBox([stbl], 'stsz');
		if (stsz?.data !== undefined) {
			const uniform = u32(stsz.data, 4);
			return Array.from({ length: u32(stsz.data, 8) }, (_, i) =>
				(uniform !== 0 ? uniform : u32(stsz.data!, 12 + i * 4)));
		}
		const stz2 = findBox([stbl], 'stz2')!.data!;
		expect(stz2[7]).toBe(16);
		return Array.from({ length: u32(stz2, 8) }, (_, i) => u16(stz2, 12 + i * 2));
	};

	// Walk stsz/stz2 + stsc/stco to read one track's samples straight out of the box that holds them.
	const sampleTableSamples = (bytes: Uint8Array, trackId: number): Uint8Array[] => {
		const boxes = parseBoxes(bytes, 0, bytes.length);
		const starts = boxStarts(boxes);
		const trak = (findBox(boxes, 'moov')!.children ?? []).filter(b => b.type === 'trak').find((t) => {
			const tkhd = findBox([t], 'tkhd')!.data!;
			return u32(tkhd, tkhd[0] === 1 ? 20 : 12) === trackId;
		})!;
		const stbl = findBox([trak], 'stbl')!;
		const sizes = trackSampleSizes(stbl);
		const stco = findBox([stbl], 'stco')!.data!;
		const chunks = Array.from({ length: u32(stco, 4) }, (_, i) => u32(stco, 8 + i * 4));
		const stsc = findBox([stbl], 'stsc')!.data!;
		const perChunk: number[] = [];
		for (let e = 0; e < u32(stsc, 4); e++) {
			const next = e + 1 < u32(stsc, 4) ? u32(stsc, 8 + (e + 1) * 12) : chunks.length + 1;
			for (let c = u32(stsc, 8 + e * 12); c < next; c++) {
				perChunk.push(u32(stsc, 12 + e * 12));
			}
		}

		const samples: Uint8Array[] = [];
		let sample = 0;
		for (let c = 0; c < chunks.length; c++) {
			let cursor = chunks[c]!;
			for (let i = 0; i < perChunk[c]! && sample < sizes.length; i++) {
				const at = boxes.findIndex((box, j) => box.data !== undefined
					&& cursor >= starts[j + 1]! - box.data.byteLength && cursor < starts[j + 1]!);
				expect(at).toBeGreaterThanOrEqual(0);
				const offset = cursor - (starts[at + 1]! - boxes[at]!.data!.byteLength);
				samples.push(boxes[at]!.data!.subarray(offset, offset + sizes[sample]!));
				cursor += sizes[sample]!;
				sample++;
			}
		}
		return samples;
	};

	// FFmpeg, in process, decrypting with the content key: the payload of every packet of every
	// stream, hashed. This is what catches a sample encrypted in a way no real reader can undo.
	const packetHashes = async (bytes: Uint8Array, key?: string): Promise<string[]> => {
		const demuxer = await Demuxer.open(Buffer.from(bytes), key === undefined
			? {}
			: { options: { decryption_key: key } });
		const hashes = new Map<number, ReturnType<typeof createHash>>();
		try {
			for await (const packet of demuxer.packets()) {
				if (packet === null) {
					continue;
				}
				if (!hashes.has(packet.streamIndex)) {
					hashes.set(packet.streamIndex, createHash('md5'));
				}
				hashes.get(packet.streamIndex)!.update(packet.data ?? Buffer.alloc(0));
			}
		} finally {
			await demuxer.close();
		}
		return [...hashes.entries()].sort((a, b) => a[0] - b[0]).map(([, hash]) => hash.digest('hex'));
	};

	const trackIds = (bytes: Uint8Array): number[] =>
		(findBox(parseBoxes(bytes, 0, bytes.length), 'moov')!.children ?? [])
			.filter(b => b.type === 'trak')
			.map((trak) => {
				const tkhd = findBox([trak], 'tkhd')!.data!;
				return u32(tkhd, tkhd[0] === 1 ? 20 : 12);
			});

	test.each(['cbcs', 'cenc', 'cens', 'cbc1'] as ProtectionScheme[])(
		'%s: every sample is encrypted, the sample table still finds them, and FFmpeg decrypts it',
		async (scheme) => {
			const original = await progressiveSource('../public/demo.mp4');
			const iv = new Uint8Array(scheme === 'cenc' || scheme === 'cens' ? 8 : 16).fill(0x11);
			const ids = trackIds(original);
			expect(ids.length).toBe(2);

			const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv, scheme });
			const boxes = parseBoxes(encrypted, 0, encrypted.length);
			expect(findBox(boxes, 'encv')).not.toBeNull();
			expect(findBox(boxes, 'enca')).not.toBeNull();

			for (const trackId of ids) {
				const plain = sampleTableSamples(original, trackId);
				const cipher = sampleTableSamples(encrypted, trackId);
				expect(plain.length).toBeGreaterThan(0);
				expect(cipher.length).toBe(plain.length);

				// A sample left cleartext under encv is the failure this whole path exists to avoid.
				// Only a sample shorter than one AES block has nothing to encrypt.
				for (let i = 0; i < plain.length; i++) {
					if (plain[i]!.length >= 16) {
						expect([...cipher[i]!]).not.toEqual([...plain[i]!]);
					}
				}
			}

			// Sample sizes are length-preserving under every scheme, so stsz is not an index to restate.
			const stszOf = (bytes: Uint8Array) => (findBox(parseBoxes(bytes, 0, bytes.length), 'moov')!.children ?? [])
				.filter(b => b.type === 'trak').map(trak => [...findBox([trak], 'stsz')!.data!]);
			expect(stszOf(encrypted)).toEqual(stszOf(original));

			// senc goes in the trak, saiz/saio in the stbl.
			for (const trak of (findBox(boxes, 'moov')!.children ?? []).filter(b => b.type === 'trak')) {
				const senc = (trak.children ?? []).find(b => b.type === 'senc');
				expect(senc).toBeDefined();
				const stbl = findBox([trak], 'stbl')!;
				const saio = (stbl.children ?? []).find(b => b.type === 'saio');
				// senc data is version/flags(4) + sample_count(4) + entries: a constant-IV full-sample
				// track (cbcs audio) has empty entries, so it needs no saiz/saio, as in a traf.
				const hasAuxData = senc!.data!.byteLength > 4 + 4;
				expect((stbl.children ?? []).some(b => b.type === 'saiz')).toBe(hasAuxData);
				expect(saio !== undefined).toBe(hasAuxData);
			}

			// FFmpeg, independently: the decrypted packets are the plaintext's, and a wrong key is not.
			const plainHashes = await packetHashes(original);
			expect(await packetHashes(encrypted, Buffer.from(KEY).toString('hex'))).toEqual(plainHashes);
			expect(await packetHashes(encrypted, 'ff'.repeat(16))).not.toEqual(plainHashes);
		},
	);

	test('cbcs: stco follows the mdat, which the added boxes moved', async () => {
		const original = await progressiveSource('../public/demo.mp4');
		const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });

		const mdatDataStart = (bytes: Uint8Array) => {
			const boxes = parseBoxes(bytes, 0, bytes.length);
			const starts = boxStarts(boxes);
			const at = boxes.findIndex(b => b.type === 'mdat');
			return starts[at]! + 8;
		};
		const shift = mdatDataStart(encrypted) - mdatDataStart(original);
		expect(shift).toBeGreaterThan(0);

		const chunkOffsets = (bytes: Uint8Array) =>
			(findBox(parseBoxes(bytes, 0, bytes.length), 'moov')!.children ?? [])
				.filter(b => b.type === 'trak')
				.flatMap((trak) => {
					const stco = findBox([trak], 'stco')!.data!;
					return Array.from({ length: u32(stco, 4) }, (_, i) => u32(stco, 8 + i * 4));
				});
		expect(chunkOffsets(encrypted)).toEqual(chunkOffsets(original).map(offset => offset + shift));
	});

	test('AV1 in a progressive file keeps its tile subsamples and FFmpeg decrypts it', async () => {
		const original = await progressiveSource(
			'../../../shaka-packager/packager/media/test/data/bear-av1.mp4',
		);
		const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });
		const senc = findBox(parseBoxes(encrypted, 0, encrypted.length), 'senc')!;
		expect(senc.data![3]! & 0x2).toBe(0x2); // subsample flag: only the tile data is encrypted

		const plainHashes = await packetHashes(original);
		expect(await packetHashes(encrypted, Buffer.from(KEY).toString('hex'))).toEqual(plainHashes);
		expect(await packetHashes(encrypted, 'ff'.repeat(16))).not.toEqual(plainHashes);
	});

	// stz2 states the same sizes as stsz in a compact field; nothing else about the file changes.
	test('cbcs: sample sizes read from a compact stz2 locate the same samples as stsz', async () => {
		const original = await progressiveSource('../public/demo.mp4');
		const boxes = parseBoxes(original, 0, original.length);
		for (const trak of (findBox(boxes, 'moov')!.children ?? []).filter(b => b.type === 'trak')) {
			const stbl = findBox([trak], 'stbl')!;
			const stsz = findBox([stbl], 'stsz')!;
			const count = u32(stsz.data!, 8);
			const compact = new Uint8Array(12 + count * 2);
			compact[7] = 16; // field_size, after version/flags(4) + reserved(3)
			setU32(compact, 8, count);
			const view = new DataView(compact.buffer);
			for (let i = 0; i < count; i++) {
				view.setUint16(12 + i * 2, u32(stsz.data!, 12 + i * 4));
			}
			stbl.children = (stbl.children ?? []).map(child =>
				(child === stsz ? { type: 'stz2', data: compact } : child));
		}

		// stz2 is smaller than the stsz it replaced, so the moov shrank and the media moved with it.
		const mdatStart = (list: MutableBox[]) => boxStarts(list)[list.findIndex(b => b.type === 'mdat')]!;
		const shift = mdatStart(boxes) - mdatStart(parseBoxes(original, 0, original.length));
		for (const trak of (findBox(boxes, 'moov')!.children ?? []).filter(b => b.type === 'trak')) {
			const stco = findBox([findBox([trak], 'stbl')!], 'stco')!.data!;
			for (let i = 0; i < u32(stco, 4); i++) {
				setU32(stco, 8 + i * 4, u32(stco, 8 + i * 4) + shift);
			}
		}
		const compacted = serializeBoxes(boxes);

		// Same samples, same bytes — only the box stating their sizes differs.
		const ids = trackIds(compacted);
		for (const trackId of ids) {
			expect(sampleTableSamples(compacted, trackId).map(sample => [...sample]))
				.toEqual(sampleTableSamples(original, trackId).map(sample => [...sample]));
		}

		const encrypted = encryptCmaf(compacted, { key: KEY, kid: KID, iv: IV });
		for (const trackId of ids) {
			const plain = sampleTableSamples(compacted, trackId);
			const cipher = sampleTableSamples(encrypted, trackId);
			expect(cipher.length).toBe(plain.length);
			for (let i = 0; i < plain.length; i++) {
				if (plain[i]!.length >= 16) {
					expect([...cipher[i]!]).not.toEqual([...plain[i]!]);
				}
			}
		}
	});

	test('a file with neither fragments nor samples is refused', async () => {
		const original = await progressiveSource('../public/demo.mp4');
		const boxes = parseBoxes(original, 0, original.length);
		for (const trak of (findBox(boxes, 'moov')!.children ?? []).filter(b => b.type === 'trak')) {
			const stbl = findBox([trak], 'stbl')!;
			setU32(findBox([stbl], 'stsz')!.data!, 8, 0); // sample_count = 0
			setU32(findBox([stbl], 'stco')!.data!, 4, 0); // entry_count = 0
		}
		expect(() => encryptCmaf(serializeBoxes(boxes), { key: KEY, kid: KID, iv: IV }))
			.toThrow(/neither moof\/mdat fragments nor a populated sample table/);
	});
});

// A type-1 reference names another sidx and measures to the next referenced item, so its size covers
// the sub-index plus every fragment that sub-index describes.
test('cbcs: a hierarchical sidx still names its sub-indexes, and they still name their fragments', () => {
	const original = withHierarchicalSidx(new Uint8Array(readFileSync(FILE)));
	expectSidxDistancesLandOnBoxes(original);

	const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });
	expectSidxDistancesLandOnBoxes(encrypted);

	const boxes = parseBoxes(encrypted, 0, encrypted.length);
	const starts = boxStarts(boxes);
	const top = boxes.find(b => b.type === 'sidx')!.data!;
	const subIndexes = boxes.flatMap((box, i) => (box.type === 'sidx' && box.data !== top ? [i] : []));
	expect(subIndexes.length).toBe(6);

	let cursor = starts[boxes.findIndex(b => b.data === top)]! + 8 + top.length
		+ u32(top, 16);
	for (let r = 0; r < u16(top, 22); r++) {
		const raw = u32(top, 24 + r * 12);
		expect(raw >>> 31).toBe(1); // reference_type survived the restatement
		// Each reference starts on a sub-index and reaches the next one (the last, the end of file).
		expect(cursor).toBe(starts[subIndexes[r]!]);
		cursor += raw & 0x7fffffff;
	}
	expect(cursor).toBe(starts[starts.length - 1]);
});

// Encrypting an encrypted file appends a second sinf and a second senc, so the result declares two
// schemes over doubly-encrypted samples and its saio points at the stale first senc.
test('an already-encrypted file is refused rather than encrypted a second time', () => {
	const encrypted = encryptCmaf(new Uint8Array(readFileSync(FILE)), { key: KEY, kid: KID, iv: IV });
	expect(() => encryptCmaf(encrypted, { key: KEY, kid: KID, iv: IV })).toThrow(/already declare protection/);

	// The init transform is refused on its own, and so is a media segment whose traf carries a senc.
	const { init, media } = splitInitAndMedia(encrypted);
	expect(() => encryptCmafInit(init, { key: KEY, kid: KID, iv: IV })).toThrow(/already declare protection/);
	expect(() => encryptCmafSegment(init, media, { key: KEY, kid: KID, iv: IV, ivState: new Map() }))
		.toThrow(/already encrypted/);
});

// `tfra` names each fragment by absolute file offset, so growing the fragments ahead of one moves it.
// Only seeking reads these, which is why a stale index still plays back cleanly.
const expectTfraPointsAtMoofs = (bytes: Uint8Array): void => {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const moofs: number[] = [];
	let mfraAt = -1;
	let offset = 0;

	while (offset + 8 <= bytes.length) {
		const size = dv.getUint32(offset);
		const type = fourcc(bytes, offset);
		if (type === 'moof') {
			moofs.push(offset);
		}
		if (type === 'mfra') {
			mfraAt = offset;
		}
		offset += size;
	}
	expect(mfraAt).toBeGreaterThanOrEqual(0);

	let child = mfraAt + 8;
	const mfraEnd = mfraAt + dv.getUint32(mfraAt);
	let checked = 0;
	while (child + 8 <= mfraEnd) {
		const size = dv.getUint32(child);
		if (fourcc(bytes, child) === 'tfra') {
			const p = bytes.subarray(child + 8, child + size);
			const pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
			const version = p[0];
			const lengths = p[11]!;
			const entrySize = (version === 1 ? 16 : 8)
				+ (((lengths >> 4) & 0x3) + 1) + (((lengths >> 2) & 0x3) + 1) + ((lengths & 0x3) + 1);
			for (let i = 0; i < pv.getUint32(12); i++) {
				const at = 16 + i * entrySize + (version === 1 ? 8 : 4);
				const stated = version === 1 ? Number(pv.getBigUint64(at)) : pv.getUint32(at);
				expect(moofs).toContain(stated);
				checked++;
			}
		}
		child += size;
	}
	expect(checked).toBeGreaterThan(0);
};

const setU32 = (d: Uint8Array, o: number, v: number) =>
	new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(o, v);

// Shift every trun data offset by how much its moof grew, so the samples still resolve.
const shiftTrunOffsets = (moof: MutableBox, delta: number): void => {
	for (const traf of (moof.children ?? []).filter(b => b.type === 'traf')) {
		for (const trun of (traf.children ?? []).filter(b => b.type === 'trun')) {
			setU32(trun.data!, 8, u32(trun.data!, 8) + delta);
		}
	}
};

// Restate each sidx over the fragment it indexes — these fixtures pair one with each — so a
// transform that grows a moof still hands the encryptor a self-consistent file.
const restateSidxRefs = (boxes: MutableBox[]): void => {
	for (let i = 0; i < boxes.length; i++) {
		if (boxes[i]!.type !== 'sidx') {
			continue;
		}
		const moofAt = boxes.findIndex((b, j) => j > i && b.type === 'moof');
		const d = boxes[i]!.data!;
		setU32(d, 12 + (d[0] === 0 ? 8 : 16) + 4, measureBox(boxes[moofAt]!) + measureBox(boxes[moofAt + 1]!));
	}
};

// Split each traf's single trun into two runs over the same samples: a traf may hold several, and
// each names its own contiguous run in the mdat. Verified against FFmpeg on a fragmented MP4 — the
// split file's framemd5 is identical to the original's.
const withSplitTruns = (bytes: Uint8Array): Uint8Array => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	for (const moof of boxes.filter(b => b.type === 'moof')) {
		const sizeBefore = measureBox(moof);
		for (const traf of (moof.children ?? []).filter(b => b.type === 'traf')) {
			const trun = findBox([traf], 'trun')!;
			const d = trun.data!;
			const flags = flagsOf(d);
			const perSample = (flags & 0x100 ? 4 : 0) + 4 + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
			const head = 8 + 4 + (flags & 0x4 ? 4 : 0);
			const count = u32(d, 4);
			const split = Math.floor(count / 2);
			const covered = trunSizes(d).slice(0, split).reduce((n, s) => n + s, 0);

			const first = d.slice(0, head + split * perSample);
			setU32(first, 4, split);
			// The second run's samples were never the first of a run, so they keep taking the tfhd
			// defaults: drop first-sample-flags rather than inventing a value for them.
			const secondFlags = flags & ~0x4;
			const second = new Uint8Array(8 + 4 + (count - split) * perSample);
			second[0] = d[0]!;
			second[1] = (secondFlags >> 16) & 0xff;
			second[2] = (secondFlags >> 8) & 0xff;
			second[3] = secondFlags & 0xff;
			setU32(second, 4, count - split);
			setU32(second, 8, u32(d, 8) + covered);
			second.set(d.subarray(head + split * perSample), 12);

			traf.children = (traf.children ?? []).flatMap(child =>
				child === trun ? [{ type: 'trun', data: first }, { type: 'trun', data: second }] : [child]);
		}
		shiftTrunOffsets(moof, measureBox(moof) - sizeBefore);
	}
	restateSidxRefs(boxes);
	return serializeBoxes(boxes);
};

// Give every traf an explicit tfhd base_data_offset naming its moof, the shape FFmpeg writes without
// `-movflags default_base_moof`. The trun offsets are already moof-relative, so they do not change.
const withExplicitBaseDataOffset = (bytes: Uint8Array): Uint8Array => {
	const boxes = parseBoxes(bytes, 0, bytes.length);
	for (const moof of boxes.filter(b => b.type === 'moof')) {
		const sizeBefore = measureBox(moof);
		for (const traf of (moof.children ?? []).filter(b => b.type === 'traf')) {
			const tfhd = findBox([traf], 'tfhd')!;
			const grown = new Uint8Array(tfhd.data!.length + 8);
			grown.set(tfhd.data!.subarray(0, 8));
			grown.set(tfhd.data!.subarray(8), 16);
			grown[3] = tfhd.data![3]! | 0x1;
			tfhd.data = grown;
		}
		shiftTrunOffsets(moof, measureBox(moof) - sizeBefore);
	}

	let offset = 0;
	for (const box of boxes) {
		if (box.type === 'moof') {
			for (const traf of (box.children ?? []).filter(b => b.type === 'traf')) {
				const tfhd = findBox([traf], 'tfhd')!.data!;
				new DataView(tfhd.buffer, tfhd.byteOffset, tfhd.byteLength).setBigUint64(8, BigInt(offset));
			}
		}
		offset += measureBox(box);
	}
	restateSidxRefs(boxes);
	return serializeBoxes(boxes);
};

// Every traf's senc must describe all of its samples, however many truns they are split across.
const expectSencCoversEverySample = (bytes: Uint8Array): void => {
	let trafs = 0;
	for (const moof of parseBoxes(bytes, 0, bytes.length).filter(b => b.type === 'moof')) {
		for (const traf of (moof.children ?? []).filter(b => b.type === 'traf')) {
			const truns = (traf.children ?? []).filter(b => b.type === 'trun');
			expect(truns.length).toBeGreaterThan(1);
			const samples = truns.reduce((n, trun) => n + u32(trun.data!, 4), 0);
			expect(u32(findBox([traf], 'senc')!.data!, 4)).toBe(samples);
			trafs++;
		}
	}
	expect(trafs).toBeGreaterThan(0);
};

test('cbcs: a traf with more than one trun has all of its samples encrypted, not just the first run', () => {
	const original = withSplitTruns(new Uint8Array(readFileSync(FILE)));
	const videoId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'avc1');
	const audioId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'mp4a');

	const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });
	expectSencCoversEverySample(encrypted);

	for (const [trackId, skip] of [[videoId, 9], [audioId, 0]] as const) {
		const plain = extractRawSamples(original, trackId);
		const cipher = extractRawSamples(encrypted, trackId);
		const senc = extractSenc(encrypted, trackId);
		expect(cipher.length).toBe(plain.length);
		for (let i = 0; i < plain.length; i++) {
			expect([...decryptSample(cipher[i]!, senc[i]!, skip)]).toEqual([...plain[i]!]);
		}
	}
});

// base_data_offset is an absolute file offset, and every fragment ahead of one grows.
const expectBaseDataOffsetsPointAtTheirMoof = (bytes: Uint8Array): void => {
	let offset = 0;
	let checked = 0;
	for (const box of parseBoxes(bytes, 0, bytes.length)) {
		if (box.type === 'moof') {
			for (const traf of (box.children ?? []).filter(b => b.type === 'traf')) {
				const tfhd = findBox([traf], 'tfhd')!.data!;
				expect(flagsOf(tfhd) & 0x1).toBe(0x1);
				const dv = new DataView(tfhd.buffer, tfhd.byteOffset, tfhd.byteLength);
				expect(Number(dv.getBigUint64(8))).toBe(offset);
				checked++;
			}
		}
		offset += measureBox(box);
	}
	expect(checked).toBeGreaterThan(0);
};

test('cbcs: an explicit tfhd base_data_offset still names its fragment after it moves', () => {
	const original = withExplicitBaseDataOffset(new Uint8Array(readFileSync(FILE)));
	expectBaseDataOffsetsPointAtTheirMoof(original);
	const videoId = trackIdOf(findBox(parseBoxes(original, 0, original.length), 'moov')!, 'avc1');
	const plain = extractRawSamples(original, videoId);

	const encrypted = encryptCmaf(original, { key: KEY, kid: KID, iv: IV });
	expectBaseDataOffsetsPointAtTheirMoof(encrypted);

	const cipher = extractRawSamples(encrypted, videoId);
	const senc = extractSenc(encrypted, videoId);
	expect(cipher.length).toBe(plain.length);
	for (let i = 0; i < plain.length; i++) {
		expect([...decryptSample(cipher[i]!, senc[i]!, 9)]).toEqual([...plain[i]!]);
	}
});

test.each(['cenc', 'cbcs'] as ProtectionScheme[])('%s: the mfra still points at the fragments', async (scheme) => {
	const source = await fragmentedSource();
	expectTfraPointsAtMoofs(source);
	expectTfraPointsAtMoofs(encryptCmaf(source, { key: KEY, kid: KID, iv: IV, scheme }));
});

describe('an independent reader', () => {
	const cmafSource = async (): Promise<Uint8Array> => {
		const parts: Uint8Array[] = [];
		const collect = () => {
			const target = new BufferTarget();
			target.on('finalized', () => parts.push(new Uint8Array(target.buffer!)));
			return target;
		};

		using input = new Input({
			source: new FilePathSource(path.join(new URL('.', import.meta.url).pathname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});
		const output = new Output({
			format: new CmafOutputFormat(),
			target: collect(),
			initTarget: collect(),
		});
		await (await Conversion.init({ input, output })).execute();

		const init = parts.find(part => fourcc(part, 0) === 'ftyp')!;
		return concat(init, ...parts.filter(part => part !== init));
	};

	test.each(['cenc', 'cbc1', 'cbcs', 'cens'] as ProtectionScheme[])(
		'%s: FFmpeg decrypts the output with the content key',
		async (scheme) => {
			const encrypted = encryptCmaf(await cmafSource(), { key: KEY, kid: KID, iv: IV, scheme });

			const demuxer = await Demuxer.open(Buffer.from(encrypted), {
				options: { decryption_key: Buffer.from(KEY).toString('hex') },
			});
			try {
				let packets = 0;
				for await (const packet of demuxer.packets()) {
					if (packet) {
						packets++;
					}
				}
				expect(packets).toBeGreaterThan(0);
			} finally {
				await demuxer.close();
			}
		},
	);
});

const VIDEO_KEY = new Uint8Array(16).fill(0x31);
const VIDEO_KID = new Uint8Array(16).fill(0xb1);
const AUDIO_KEY = new Uint8Array(16).fill(0x62);
const AUDIO_KID = new Uint8Array(16).fill(0xc2);

// tenc payload: version/flags(4), reserved(1), pattern(1), default_is_protected(1), iv_size(1), KID(16).
const tencKidOf = (bytes: Uint8Array, trackId: number): Uint8Array => {
	const moov = findBox(parseBoxes(bytes, 0, bytes.length), 'moov')!;
	const trak = (moov.children ?? []).filter(b => b.type === 'trak').find((t) => {
		const tkhd = findBox([t], 'tkhd')!.data!;
		return u32(tkhd, tkhd[0]! === 1 ? 20 : 12) === trackId;
	})!;
	return findBox([trak], 'tenc')!.data!.subarray(8, 24);
};

describe('encryptCmaf with per-track keys', () => {
	const load = () => {
		const original = new Uint8Array(readFileSync(FILE));
		const moov = findBox(parseBoxes(original, 0, original.length), 'moov')!;
		return { original, videoId: trackIdOf(moov, 'avc1'), audioId: trackIdOf(moov, 'mp4a') };
	};

	test('each track carries its own tenc KID and decrypts only under its own key', () => {
		const { original, videoId, audioId } = load();
		const encrypted = encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([
				[videoId, { key: VIDEO_KEY, kid: VIDEO_KID }],
				[audioId, { key: AUDIO_KEY, kid: AUDIO_KID }],
			]),
		});

		expect([...tencKidOf(encrypted, videoId)]).toEqual([...VIDEO_KID]);
		expect([...tencKidOf(encrypted, audioId)]).toEqual([...AUDIO_KID]);

		const originalVideo = extractRawSamples(original, videoId);
		const encVideo = extractRawSamples(encrypted, videoId);
		const sencVideo = extractSenc(encrypted, videoId);
		expect(encVideo.length).toBe(originalVideo.length);
		for (let i = 0; i < originalVideo.length; i++) {
			expect([...decryptSampleWith(encVideo[i]!, sencVideo[i]!, 9, VIDEO_KEY, IV)])
				.toEqual([...originalVideo[i]!]);
		}

		const originalAudio = extractRawSamples(original, audioId);
		const encAudio = extractRawSamples(encrypted, audioId);
		const sencAudio = extractSenc(encrypted, audioId);
		expect(encAudio.length).toBe(originalAudio.length);
		for (let i = 0; i < originalAudio.length; i++) {
			expect([...decryptSampleWith(encAudio[i]!, sencAudio[i]!, 0, AUDIO_KEY, IV)])
				.toEqual([...originalAudio[i]!]);
		}

		// No keystream is shared between the tracks: neither the other track's key nor the top-level
		// key recovers the plaintext.
		expect([...decryptSampleWith(encVideo[0]!, sencVideo[0]!, 9, AUDIO_KEY, IV)])
			.not.toEqual([...originalVideo[0]!]);
		expect([...decryptSampleWith(encVideo[0]!, sencVideo[0]!, 9, KEY, IV)])
			.not.toEqual([...originalVideo[0]!]);
		expect([...decryptSampleWith(encAudio[0]!, sencAudio[0]!, 0, VIDEO_KEY, IV)])
			.not.toEqual([...originalAudio[0]!]);
		expect([...decryptSampleWith(encAudio[0]!, sencAudio[0]!, 0, KEY, IV)])
			.not.toEqual([...originalAudio[0]!]);
	});

	test('the split init/segment API honours the same per-track keys', () => {
		const { original, videoId, audioId } = load();
		const { init, segment } = splitInitAndSegment(original);
		const trackKeys = new Map([
			[videoId, { key: VIDEO_KEY, kid: VIDEO_KID, iv: IV }],
			[audioId, { key: AUDIO_KEY, kid: AUDIO_KID, iv: IV }],
		]);
		const encInit = encryptCmafInit(init, { key: KEY, kid: KID, iv: IV, trackKeys });
		const encSegment = encryptCmafSegment(init, segment, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys,
			ivState: new Map(),
		});

		expect([...tencKidOf(encInit, videoId)]).toEqual([...VIDEO_KID]);
		expect([...tencKidOf(encInit, audioId)]).toEqual([...AUDIO_KID]);

		const reassembled = new Uint8Array(encInit.length + encSegment.length);
		reassembled.set(encInit, 0);
		reassembled.set(encSegment, encInit.length);

		const originalVideo = extractRawSamples(original, videoId);
		const encVideo = extractRawSamples(reassembled, videoId);
		const sencVideo = extractSenc(reassembled, videoId);
		expect(encVideo.length).toBeGreaterThan(0);
		for (let i = 0; i < encVideo.length; i++) {
			expect([...decryptSampleWith(encVideo[i]!, sencVideo[i]!, 9, VIDEO_KEY, IV)])
				.toEqual([...originalVideo[i]!]);
		}

		const originalAudio = extractRawSamples(original, audioId);
		const encAudio = extractRawSamples(reassembled, audioId);
		const sencAudio = extractSenc(reassembled, audioId);
		expect(encAudio.length).toBeGreaterThan(0);
		for (let i = 0; i < encAudio.length; i++) {
			expect([...decryptSampleWith(encAudio[i]!, sencAudio[i]!, 0, AUDIO_KEY, IV)])
				.toEqual([...originalAudio[i]!]);
		}
	});

	test('a trackKeys that does not name every encryptable track is refused', () => {
		const { original, videoId, audioId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([[videoId, { key: VIDEO_KEY, kid: VIDEO_KID }]]),
		})).toThrow(new RegExp(`states no key for track ${audioId}`));
	});

	test('a trackKeys naming a track the file does not have is refused', () => {
		const { original, videoId, audioId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([
				[videoId, { key: VIDEO_KEY, kid: VIDEO_KID }],
				[audioId, { key: AUDIO_KEY, kid: AUDIO_KID }],
				[99, { key: KEY, kid: KID }],
			]),
		})).toThrow(/trackKeys names track 99/);
	});

	test('a per-track IV of a different length than the file\'s is refused', () => {
		const { original, videoId, audioId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			scheme: 'cenc',
			trackKeys: new Map([
				[videoId, { key: VIDEO_KEY, kid: VIDEO_KID, iv: new Uint8Array(8) }],
				[audioId, { key: AUDIO_KEY, kid: AUDIO_KID }],
			]),
		})).toThrow(/8-byte IV for track/);
	});
});

const hexOf = (data: Uint8Array) => [...data].map(b => b.toString(16).padStart(2, '0')).join('');

// The KID each sample of a track is encrypted under: its traf's seig sample group when it carries
// one, and otherwise the track's tenc default.
const perSampleKids = (bytes: Uint8Array, trackId: number): string[] => {
	const asHex = (data: Uint8Array) => [...data].map(b => b.toString(16).padStart(2, '0')).join('');
	const fallback = asHex(tencKidOf(bytes, trackId));
	const boxes = parseBoxes(bytes, 0, bytes.length);
	const kids: string[] = [];
	for (const moof of boxes.filter(b => b.type === 'moof')) {
		const traf = (moof.children ?? []).find((t) => {
			const tfhd = findBox([t], 'tfhd');
			return tfhd?.data !== undefined && u32(tfhd.data, 4) === trackId;
		});
		if (traf === undefined) {
			continue;
		}
		const sampleCount = (traf.children ?? [])
			.filter(b => b.type === 'trun')
			.reduce((n, trun) => n + u32(trun.data!, 4), 0);
		const sbgp = findBox([traf], 'sbgp');
		const sgpd = findBox([traf], 'sgpd');
		if (sbgp === null || sgpd === null) {
			kids.push(...Array.from({ length: sampleCount }, () => fallback));
			continue;
		}
		// sgpd v1: version/flags(4), grouping_type(4), default_length(4), entry_count(4), then entries;
		// a seig entry is reserved(1) + pattern(1) + isProtected(1) + iv_size(1) + KID(16).
		const length = u32(sgpd.data!, 8);
		const entryKids = Array.from(
			{ length: u32(sgpd.data!, 12) },
			(_, i) => asHex(sgpd.data!.subarray(16 + i * length + 4, 16 + i * length + 20)),
		);
		// sbgp v0: version/flags(4), grouping_type(4), entry_count(4), then sample_count + index pairs.
		for (let i = 0; i < u32(sbgp.data!, 8); i++) {
			const runLength = u32(sbgp.data!, 12 + i * 8);
			const entry = entryKids[u32(sbgp.data!, 16 + i * 8) - 0x10001]!;
			kids.push(...Array.from({ length: runLength }, () => entry));
		}
	}
	return kids;
};

const trafsWithSampleGroups = (bytes: Uint8Array, trackId: number): number =>
	parseBoxes(bytes, 0, bytes.length).filter(b => b.type === 'moof').filter((moof) => {
		const traf = (moof.children ?? []).find((t) => {
			const tfhd = findBox([t], 'tfhd');
			return tfhd?.data !== undefined && u32(tfhd.data, 4) === trackId;
		});
		return traf !== undefined && findBox([traf], 'sbgp') !== null;
	}).length;

const PERIOD_KEYS = [new Uint8Array(16).fill(0x31), new Uint8Array(16).fill(0x41), new Uint8Array(16).fill(0x51)];
const PERIOD_KIDS = [new Uint8Array(16).fill(0xb1), new Uint8Array(16).fill(0xb2), new Uint8Array(16).fill(0xb3)];

// bear-640x360-av_frag.mp4's video runs at 30000/1001 with 15 samples per fragment, so periods
// ending at 8008 and 28008 both cut a fragment in half: 8 + 7 samples, then 13 + the rest.
const PERIODS = [
	{ key: PERIOD_KEYS[0]!, kid: PERIOD_KIDS[0]!, start: 0, duration: 8008 },
	{ key: PERIOD_KEYS[1]!, kid: PERIOD_KIDS[1]!, start: 8008, duration: 20000 },
	{ key: PERIOD_KEYS[2]!, kid: PERIOD_KIDS[2]!, start: 28008, duration: 100000 },
];

describe('encryptCmaf with key rotation', () => {
	const load = () => {
		const original = new Uint8Array(readFileSync(FILE));
		const moov = findBox(parseBoxes(original, 0, original.length), 'moov')!;
		return { original, videoId: trackIdOf(moov, 'avc1'), audioId: trackIdOf(moov, 'mp4a') };
	};

	test('every sample decrypts under the key its sample group names, and under no other period\'s', () => {
		const { original, videoId, audioId } = load();
		const encrypted = encryptCmaf(original, {
			key: AUDIO_KEY,
			kid: AUDIO_KID,
			iv: IV,
			keyPeriods: new Map([[videoId, PERIODS]]),
		});

		// tenc stays the default entry: it states the first period, which unmapped samples fall back to.
		expect([...tencKidOf(encrypted, videoId)]).toEqual([...PERIOD_KIDS[0]!]);
		expect([...tencKidOf(encrypted, audioId)]).toEqual([...AUDIO_KID]);

		const originalVideo = extractRawSamples(original, videoId);
		const encVideo = extractRawSamples(encrypted, videoId);
		const senc = extractSenc(encrypted, videoId);
		const kids = perSampleKids(encrypted, videoId);
		expect(kids.length).toBe(originalVideo.length);
		expect(PERIOD_KIDS.map(kid => kids.filter(k => k === hexOf(kid)).length)).toEqual([8, 20, 54]);

		for (let i = 0; i < originalVideo.length; i++) {
			const period = PERIOD_KIDS.findIndex(kid => hexOf(kid) === kids[i]);
			expect([...decryptSampleWith(encVideo[i]!, senc[i]!, 9, PERIOD_KEYS[period]!, IV)])
				.toEqual([...originalVideo[i]!]);
			for (const other of PERIOD_KEYS.filter(key => key !== PERIOD_KEYS[period])) {
				expect([...decryptSampleWith(encVideo[i]!, senc[i]!, 9, other, IV)])
					.not.toEqual([...originalVideo[i]!]);
			}
		}

		// The first fragment holds 15 samples split 8 + 7, so it rotates mid-fragment.
		const firstMoof = parseBoxes(encrypted, 0, encrypted.length).find(b => b.type === 'moof')!;
		const videoTraf = (firstMoof.children ?? []).find((t) => {
			const tfhd = findBox([t], 'tfhd');
			return tfhd?.data !== undefined && u32(tfhd.data, 4) === videoId;
		})!;
		const sbgp = findBox([videoTraf], 'sbgp')!.data!;
		expect(u32(sbgp, 8)).toBe(2);
		expect([u32(sbgp, 12), u32(sbgp, 16)]).toEqual([8, 0x10001]);
		expect([u32(sbgp, 20), u32(sbgp, 24)]).toEqual([7, 0x10002]);
		expect(u32(findBox([videoTraf], 'sgpd')!.data!, 12)).toBe(2);

		// The audio track states one key, so none of its fragments gains a sample group.
		expect(trafsWithSampleGroups(encrypted, audioId)).toBe(0);
		const originalAudio = extractRawSamples(original, audioId);
		const encAudio = extractRawSamples(encrypted, audioId);
		const sencAudio = extractSenc(encrypted, audioId);
		for (let i = 0; i < originalAudio.length; i++) {
			expect([...decryptSampleWith(encAudio[i]!, sencAudio[i]!, 0, AUDIO_KEY, IV)])
				.toEqual([...originalAudio[i]!]);
		}
	});

	test('a single period over the whole track writes the same bytes as stating no rotation at all', () => {
		const { original, videoId } = load();
		const rotated = encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			keyPeriods: new Map([[videoId, [{ key: KEY, kid: KID, start: 0, duration: 1_000_000 }]]]),
		});
		expect([...rotated]).toEqual([...encryptCmaf(original, { key: KEY, kid: KID, iv: IV })]);
	});

	test('the IV sequence runs on across a boundary, so a period reusing an earlier key reuses no keystream', () => {
		const { original, videoId } = load();
		// Period 2 deliberately repeats period 0's key and KID: only a continuing IV keeps the
		// keystream of its samples off the keystream period 0 already spent.
		const repeating = [
			PERIODS[0]!,
			PERIODS[1]!,
			{ key: PERIOD_KEYS[0]!, kid: PERIOD_KIDS[0]!, start: 28008, duration: 100000 },
		];
		const encrypted = encryptCmaf(original, {
			key: AUDIO_KEY,
			kid: AUDIO_KID,
			iv: IV,
			scheme: 'cenc',
			keyPeriods: new Map([[videoId, repeating]]),
		});

		const entries = extractSencEntries(encrypted, videoId, IV.length);
		expect(entries.length).toBe(82);
		expect(new Set(entries.map(entry => hexOf(entry.iv))).size).toBe(entries.length);
		expect(hexOf(entries[8]!.iv)).not.toBe(hexOf(IV));

		// AES-CTR is a keystream cipher, so plaintext XOR ciphertext recovers the keystream directly.
		const originalVideo = extractRawSamples(original, videoId);
		const encVideo = extractRawSamples(encrypted, videoId);
		const keystreams = originalVideo.map((plain, i) => {
			const head: number[] = [];
			let offset = 0;
			for (const { clearBytes, cipherBytes } of entries[i]!.subsamples) {
				offset += clearBytes;
				for (let j = 0; j < Math.min(cipherBytes, 16) && head.length < 16; j++) {
					head.push(plain[offset + j]! ^ encVideo[i]![offset + j]!);
				}
				offset += cipherBytes;
			}
			return head.join(',');
		});
		expect(new Set(keystreams).size).toBe(keystreams.length);
	});

	test('a track rotates across separately encrypted segments, carrying one IV per track', () => {
		const { original, videoId } = load();
		const boxes = parseBoxes(original, 0, original.length);
		const firstMoof = boxes.findIndex(b => b.type === 'moof');
		const init = serializeBoxes(boxes.slice(0, firstMoof));
		const segments: Uint8Array[] = [];
		for (let i = firstMoof; i < boxes.length; i++) {
			if (boxes[i]!.type === 'moof' && boxes[i + 1]?.type === 'mdat') {
				segments.push(serializeBoxes(boxes.slice(i, i + 2)));
			}
		}
		expect(segments.length).toBe(6);

		const opts = { key: AUDIO_KEY, kid: AUDIO_KID, iv: IV, keyPeriods: new Map([[videoId, PERIODS]]) };
		const ivState = new Map<number, Uint8Array>();
		const encrypted = concat(
			encryptCmafInit(init, opts),
			...segments.map(segment => encryptCmafSegment(init, segment, { ...opts, ivState })),
		);

		// Segments 3 onwards sit wholly inside the last period: they do not rotate within themselves,
		// but their key is not the tenc default, so each still states its sample group.
		expect(trafsWithSampleGroups(encrypted, videoId)).toBe(6);

		const originalVideo = extractRawSamples(original, videoId);
		const encVideo = extractRawSamples(encrypted, videoId);
		const senc = extractSenc(encrypted, videoId);
		const kids = perSampleKids(encrypted, videoId);
		expect(PERIOD_KIDS.map(kid => kids.filter(k => k === hexOf(kid)).length)).toEqual([8, 20, 54]);
		for (let i = 0; i < originalVideo.length; i++) {
			const period = PERIOD_KIDS.findIndex(kid => hexOf(kid) === kids[i]);
			expect([...decryptSampleWith(encVideo[i]!, senc[i]!, 9, PERIOD_KEYS[period]!, IV)])
				.toEqual([...originalVideo[i]!]);
		}
	});

	test('key periods that leave a gap are refused', () => {
		const { original, videoId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			keyPeriods: new Map([[videoId, [
				{ key: PERIOD_KEYS[0]!, kid: PERIOD_KIDS[0]!, start: 0, duration: 8008 },
				{ key: PERIOD_KEYS[1]!, kid: PERIOD_KIDS[1]!, start: 9000, duration: 100000 },
			]]]),
		})).toThrow(/starts at 9000 while period 0 ends at 8008/);
	});

	test('key periods that overlap are refused', () => {
		const { original, videoId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			keyPeriods: new Map([[videoId, [
				{ key: PERIOD_KEYS[0]!, kid: PERIOD_KIDS[0]!, start: 0, duration: 8008 },
				{ key: PERIOD_KEYS[1]!, kid: PERIOD_KIDS[1]!, start: 7000, duration: 100000 },
			]]]),
		})).toThrow(/starts at 7000 while period 0 ends at 8008/);
	});

	test('key periods that stop short of the last sample are refused', () => {
		const { original, videoId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			keyPeriods: new Map([[videoId, [
				{ key: PERIOD_KEYS[0]!, kid: PERIOD_KIDS[0]!, start: 0, duration: 8008 },
			]]]),
		})).toThrow(/sample at decode time 8008, which no key period covers/);
	});

	test('an empty or zero-length key period is refused', () => {
		const { original, videoId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY, kid: KID, iv: IV, keyPeriods: new Map([[videoId, []]]),
		})).toThrow(/states an empty list for track/);
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			keyPeriods: new Map([[videoId, [{ key: PERIOD_KEYS[0]!, kid: PERIOD_KIDS[0]!, start: 0, duration: 0 }]]]),
		})).toThrow(/lasts 0; give every period a positive duration/);
	});

	test('key periods naming a track the file does not have are refused', () => {
		const { original } = load();
		expect(() => encryptCmaf(original, {
			key: KEY, kid: KID, iv: IV, keyPeriods: new Map([[99, PERIODS]]),
		})).toThrow(/keyPeriods names track 99/);
	});

	test('a track named by both trackKeys and keyPeriods is refused', () => {
		const { original, videoId, audioId } = load();
		expect(() => encryptCmaf(original, {
			key: KEY,
			kid: KID,
			iv: IV,
			trackKeys: new Map([
				[videoId, { key: VIDEO_KEY, kid: VIDEO_KID }],
				[audioId, { key: AUDIO_KEY, kid: AUDIO_KID }],
			]),
			keyPeriods: new Map([[videoId, PERIODS]]),
		})).toThrow(/named by both trackKeys and keyPeriods/);
	});

	test('rotating a progressive file is refused, since it has no traf to state a sample group in', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(new URL('.', import.meta.url).pathname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await (await Conversion.init({ input, output })).execute();
		const progressive = new Uint8Array(output.target.buffer!);

		const videoId = trackIdOf(findBox(parseBoxes(progressive, 0, progressive.length), 'moov')!, 'avc1');
		expect(() => encryptCmaf(progressive, {
			key: KEY, kid: KID, iv: IV, keyPeriods: new Map([[videoId, PERIODS]]),
		})).toThrow(/but this file is progressive/);
	});
});

describe('a malformed saiz/saio is reported as a bad file, not as an internal error', () => {
	// The aux-info path only runs when `senc` is absent, which is how many packagers write CMAF.
	const withoutSenc = (data: Uint8Array): Uint8Array => {
		const copy = new Uint8Array(data);
		for (let start = 0; start + 8 <= copy.length; start++) {
			if (fourcc(copy, start) === 'senc') {
				copy.set([0x78], start + 4);
			}
		}
		return copy;
	};

	const eachSaiz = (data: Uint8Array, edit: (data: Uint8Array, fieldsAt: number) => void): Uint8Array => {
		const copy = new Uint8Array(data);
		for (let start = 0; start + 16 <= copy.length; start++) {
			if (fourcc(copy, start) !== 'saiz') {
				continue;
			}
			// size(4) type(4) version(1) flags(3), then the aux-info-type pair when flags bit 0 is set.
			const flags = u32(copy, start + 8) & 0x00ffffff;
			edit(copy, start + 12 + (flags & 1 ? 8 : 0));
		}
		return copy;
	};

	const readAll = async (data: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(data),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => KEY } },
		});
		const track = (await input.getPrimaryVideoTrack())!;
		for await (const _packet of new EncodedPacketSink(track).packets()) {
			void _packet;
		}
	};

	const encryptedWithoutSenc = () =>
		withoutSenc(encryptCmaf(new Uint8Array(readFileSync(FILE)), { key: KEY, kid: KID, iv: IV }));

	test('a per-sample size table the box is too small to hold', async () => {
		const broken = eachSaiz(encryptedWithoutSenc(), (data, fieldsAt) => {
			data[fieldsAt] = 0;
			new DataView(data.buffer, data.byteOffset).setUint32(fieldsAt + 1, 0xffff);
		});

		await expect(readAll(broken)).rejects.toThrow(/per-sample size table runs past the end of the box/);
	});

	test('an entry claiming more subsamples than its stated size holds', async () => {
		const broken = eachSaiz(encryptedWithoutSenc(), (data, fieldsAt) => {
			// Stretch every entry past its 8-byte IV, so the bytes after it are read as a subsample map.
			data[fieldsAt] = 20;
		});

		// Then state a count no 20-byte entry could hold, where saio says the first entry's map begins.
		const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength);
		for (let offset = 0; offset + 8 <= broken.length; offset += view.getUint32(offset)) {
			if (fourcc(broken, offset) !== 'moof') {
				continue;
			}
			const saioAt = findBoxOffset(broken, 'saio', offset + 8, offset + view.getUint32(offset));
			// saio: 8 header + 4 version/flags + 4 entry_count, then one moof-relative offset.
			view.setUint16(offset + view.getUint32(saioAt + 16) + 8, 0xffff);
		}

		await expect(readAll(broken)).rejects.toThrow(/claims more subsamples than saiz gives it room for/);
	});

	test('a subsample map larger than the sample it describes', async () => {
		// Promise a per-sample table and do not supply one: the sizes then come from whatever follows.
		const broken = eachSaiz(encryptedWithoutSenc(), (data, fieldsAt) => {
			data[fieldsAt] = 0;
		});

		await expect(readAll(broken)).rejects.toThrow(/subsamples map more bytes than the sample holds/);
	});
});
