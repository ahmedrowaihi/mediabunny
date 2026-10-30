import { describe, expect, test } from 'vitest';
import { encryptCmaf } from '../../src/crypto/cmaf-encryptor.js';
import { encryptWebm } from '../../src/crypto/webm-encryptor.js';
import { variantEncryptor } from '../../src/watermarking/wm-encryption.js';
import { segmentsOf } from '../../src/isobmff/isobmff-misc.js';
import type { ProtectionScheme } from '../../src/crypto/subsample-generator.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';

// End-to-end proof that the encryptors produce genuine, player-decodable encrypted media: a real
// browser CDM (ClearKey EME) decrypts and plays it with the correct key, and — the part that matters
// — decodes ZERO frames with a wrong key. So the content is only openable with the key.

const KEY = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);
const KID = Uint8Array.from({ length: 16 }, (_, i) => (i * 11 + 7) & 0xff);

const b64url = (u8: Uint8Array): string =>
	btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const codecOf = async (bytes: Uint8Array, kind: 'video' | 'audio'): Promise<string | undefined> => {
	const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
	return track ? (await track.getDecoderConfig())!.codec : undefined;
};

// Resolve when `event` fires, or after `deadlineMs` — so negative-control paths (where the event
// never comes) can't hang the test.
const awaitEvent = (target: EventTarget, event: string, deadlineMs: number): Promise<void> =>
	new Promise((resolve) => {
		const done = () => resolve();
		target.addEventListener(event, done, { once: true });
		setTimeout(done, deadlineMs);
	});

// Poll the real playback signal (currentTime) rather than blind-sleeping, with a deadline so a
// stalled (undecryptable) stream returns fast instead of hanging.
const framesAfterPlay = async (video: HTMLVideoElement, deadlineMs: number): Promise<number> => {
	const start = performance.now();
	while (video.currentTime < 0.15 && performance.now() - start < deadlineMs) {
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	return video.getVideoPlaybackQuality().totalVideoFrames;
};

type KeyMode = 'correct' | 'wrong' | 'none';

type PlaybackOptions = {
	mime: 'video/mp4' | 'video/webm';
	videoCodec: string;
	audioCodec?: string;
	scheme: ProtectionScheme;
	keyMode: KeyMode;
};

// Play the encrypted file under one key condition; returns how many frames the decoder actually
// produced. The decoder only emits frames from a validly-decrypted bitstream.
const decodedFrames = async (encrypted: Uint8Array, opts: PlaybackOptions): Promise<number> => {
	const audioMime = opts.mime.replace('video', 'audio');
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	document.body.appendChild(video);
	try {
		if (opts.keyMode !== 'none') {
			const videoContentType = `${opts.mime}; codecs="${opts.videoCodec}"`;
			const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
				initDataTypes: ['keyids'],
				videoCapabilities: [{ contentType: videoContentType, encryptionScheme: opts.scheme }],
				...(opts.audioCodec !== undefined
					? { audioCapabilities: [{
							contentType: `${audioMime}; codecs="${opts.audioCodec}"`,
							encryptionScheme: opts.scheme,
						}] }
					: {}),
			}]);
			const mediaKeys = await access.createMediaKeys();
			await video.setMediaKeys(mediaKeys);
			const session = mediaKeys.createSession();
			const key = new Uint8Array(KEY);
			if (opts.keyMode === 'wrong') {
				key[0]! ^= 0xff;
			}
			session.addEventListener('message', () => {
				const license = { keys: [{ kty: 'oct', kid: b64url(KID), k: b64url(key) }], type: 'temporary' };
				void session.update(new TextEncoder().encode(JSON.stringify(license)));
			});
			await session.generateRequest('keyids', new TextEncoder().encode(JSON.stringify({ kids: [b64url(KID)] })));
		}

		const mediaSource = new MediaSource();
		video.src = URL.createObjectURL(mediaSource);
		await awaitEvent(mediaSource, 'sourceopen', 3000);
		const codecList = opts.audioCodec !== undefined ? `${opts.videoCodec},${opts.audioCodec}` : opts.videoCodec;
		const sourceBuffer = mediaSource.addSourceBuffer(`${opts.mime}; codecs="${codecList}"`);
		// TS models a Uint8Array as possibly SharedArrayBuffer-backed; MSE requires a plain one.
		sourceBuffer.appendBuffer(encrypted as Uint8Array<ArrayBuffer>);
		await awaitEvent(sourceBuffer, 'updateend', 3000);
		try {
			mediaSource.endOfStream();
		} catch {
			// endOfStream can throw if the buffer never accepted the (undecryptable) data — fine.
		}

		void video.play().catch(() => {
			// A wrong/absent key makes play() reject — that is the expected blocked path.
		});
		return await framesAfterPlay(video, 2500);
	} catch {
		return 0;
	} finally {
		video.remove();
	}
};

describe('encrypted output is decryptable only with the key (ClearKey EME)', () => {
	for (const scheme of ['cenc', 'cbcs'] as ProtectionScheme[]) {
		test(`CMAF H.264/AAC ${scheme}: correct key plays; wrong key and no CDM decode nothing`, async () => {
			const clear = new Uint8Array(await (await fetch('/bear-640x360-av_frag.mp4')).arrayBuffer());
			const opts = {
				mime: 'video/mp4' as const,
				videoCodec: (await codecOf(clear, 'video'))!,
				audioCodec: await codecOf(clear, 'audio'),
				scheme,
			};
			const iv = scheme === 'cbcs' ? new Uint8Array(16).fill(0x9a) : new Uint8Array(8).fill(0x9a);
			const encrypted = encryptCmaf(clear, { key: KEY, kid: KID, iv, scheme });

			expect(await decodedFrames(encrypted, { ...opts, keyMode: 'correct' })).toBeGreaterThan(0);
			expect(await decodedFrames(encrypted, { ...opts, keyMode: 'wrong' })).toBe(0);
			expect(await decodedFrames(encrypted, { ...opts, keyMode: 'none' })).toBe(0);
		}, 20000);
	}

	// AV1/VP9 decoders decode garbage tiles into frames instead of hard-rejecting (unlike H.264), so a
	// wrong-key frame count is decoder-dependent. The decoder-independent control is no-CDM: the browser
	// refuses to feed encrypted-flagged samples to the decoder at all, proving the stream is genuinely
	// encrypted. (Byte-level key-dependence is proven by the Node round-trip tests.)
	test('CMAF AV1 cenc: a real CDM decodes the encrypted tile-subsample stream; no CDM decodes nothing', async () => {
		const clear = new Uint8Array(await (await fetch('/bear-av1.mp4')).arrayBuffer());
		const videoCodec = (await codecOf(clear, 'video'))!;
		const opts = { mime: 'video/mp4' as const, videoCodec, scheme: 'cenc' as const };
		const encrypted = encryptCmaf(clear, { key: KEY, kid: KID, iv: new Uint8Array(8).fill(0x9a), scheme: 'cenc' });

		expect(await decodedFrames(encrypted, { ...opts, keyMode: 'correct' })).toBeGreaterThan(0);
		expect(await decodedFrames(encrypted, { ...opts, keyMode: 'none' })).toBe(0);
	}, 20000);

	test('WebM VP9 + Vorbis (AES-CTR): a real CDM decodes the encrypted WebM; no CDM decodes nothing', async () => {
		const clear = new Uint8Array(await (await fetch('/bear-320x240-vp9.webm')).arrayBuffer());
		const opts = {
			mime: 'video/webm' as const,
			videoCodec: (await codecOf(clear, 'video'))!,
			audioCodec: await codecOf(clear, 'audio'),
			scheme: 'cenc' as const, // WebM Encryption is AES-CTR, signalled to EME as cenc
		};
		const encrypted = encryptWebm(clear, { key: KEY, kid: KID, iv: new Uint8Array(8).fill(0x9a) });

		expect(await decodedFrames(encrypted, { ...opts, keyMode: 'correct' })).toBeGreaterThan(0);
		expect(await decodedFrames(encrypted, { ...opts, keyMode: 'none' })).toBe(0);
	}, 20000);
});

describe('A/B watermarking variants play under one key (ClearKey EME)', () => {
	const BASE_IV = new Uint8Array(8).fill(0x5c);

	/** Encrypt one variant through `variantEncryptor` and rejoin it into a playable file. */
	const encryptVariant = (clear: Uint8Array, variant: number, scheme: ProtectionScheme) => {
		const layout = segmentsOf(clear);
		if (layout.init === null) {
			throw new Error('expected a fragmented rendition with an init segment');
		}
		const encryptor = variantEncryptor(
			clear.subarray(layout.init.offset, layout.init.offset + layout.init.size),
			{ key: KEY, kid: KID, baseIv: BASE_IV, variant, scheme },
		);
		const parts = [
			encryptor.init,
			...layout.segments.map(s => encryptor.encryptSegment(clear.subarray(s.offset, s.offset + s.size))),
		];
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	};

	for (const scheme of ['cenc', 'cbcs'] as ProtectionScheme[]) {
		test(`${scheme}: both variants decode under the same key, and neither without it`, async () => {
			const clear = new Uint8Array(await (await fetch('/bear-640x360-av_frag.mp4')).arrayBuffer());
			const opts = {
				mime: 'video/mp4' as const,
				videoCodec: (await codecOf(clear, 'video'))!,
				audioCodec: await codecOf(clear, 'audio'),
				scheme,
			};

			const variantA = encryptVariant(clear, 0, scheme);
			const variantB = encryptVariant(clear, 1, scheme);

			// The spec requires one licence to open whichever variant a viewer is served, so this is
			// the property that matters: the same key plays both. Every other check of the variant
			// encryptor compares our output against our own hand-paired calls; a CDM is the first
			// oracle that is not us.
			//
			// What this does NOT cover: keystream detail within a sample. A desynced counter still
			// plays here, because the IV a CDM uses is the one written into `senc` and this fixture's
			// samples do not exercise the multi-run case. That is caught by the byte-level agreement
			// tests in test/node/aes-ctr-encryptor.test.ts instead. The two layers are complementary,
			// not redundant — this one proves decodability by something that is not our own code.
			expect(await decodedFrames(variantA, { ...opts, keyMode: 'correct' })).toBeGreaterThan(0);
			expect(await decodedFrames(variantB, { ...opts, keyMode: 'correct' })).toBeGreaterThan(0);

			expect(await decodedFrames(variantA, { ...opts, keyMode: 'wrong' })).toBe(0);
			expect(await decodedFrames(variantB, { ...opts, keyMode: 'none' })).toBe(0);

			// Separated IVs are what stop the two ciphertexts revealing where they differ, so the
			// variants must not be byte-identical even though their plaintext here is.
			expect([...variantA]).not.toEqual([...variantB]);
		}, 30000);
	}
});
