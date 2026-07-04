import { describe, expect, test } from 'vitest';
import { encryptCmaf } from '../../src/crypto/cmaf-encryptor.js';
import type { ProtectionScheme } from '../../src/crypto/subsample-generator.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';

// End-to-end proof that `encryptCmaf` produces genuine CENC output: a real browser CDM (ClearKey
// EME) decrypts and plays it with the correct key, and — the part that matters — it decodes ZERO
// frames with a wrong key or with no CDM at all. So the content is only openable with the key.

const KEY = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);
const KID = Uint8Array.from({ length: 16 }, (_, i) => (i * 11 + 7) & 0xff);

const b64url = (u8: Uint8Array): string =>
	btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const getCodecs = async (bytes: Uint8Array): Promise<{ video: string; audio: string }> => {
	const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const video = (await input.getPrimaryVideoTrack())!;
	const audio = (await input.getPrimaryAudioTrack())!;
	return { video: (await video.getDecoderConfig())!.codec, audio: (await audio.getDecoderConfig())!.codec };
};

// Resolve when `event` fires, or after `deadlineMs` — so negative-control paths (where the event
// never comes) can't hang the test.
const awaitEvent = (target: EventTarget, event: string, deadlineMs: number): Promise<void> =>
	new Promise((resolve) => {
		const done = () => resolve();
		target.addEventListener(event, done, { once: true });
		setTimeout(done, deadlineMs);
	});

// Poll the real playback signal (currentTime) rather than blind-sleeping — the transparency.test.ts
// idiom — with a deadline so a stalled (undecryptable) stream returns fast instead of hanging.
const framesAfterPlay = async (video: HTMLVideoElement, deadlineMs: number): Promise<number> => {
	const start = performance.now();
	while (video.currentTime < 0.15 && performance.now() - start < deadlineMs) {
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	return video.getVideoPlaybackQuality().totalVideoFrames;
};

type KeyMode = 'correct' | 'wrong' | 'none';

// Play the encrypted file under one key condition; returns how many frames the decoder actually
// produced. The decoder only emits frames from a validly-decrypted bitstream.
const decodedFrames = async (
	encrypted: Uint8Array, scheme: ProtectionScheme, codecs: { video: string; audio: string }, keyMode: KeyMode,
): Promise<number> => {
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	document.body.appendChild(video);
	try {
		if (keyMode !== 'none') {
			const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
				initDataTypes: ['keyids'],
				videoCapabilities: [{ contentType: `video/mp4; codecs="${codecs.video}"`, encryptionScheme: scheme }],
				audioCapabilities: [{ contentType: `audio/mp4; codecs="${codecs.audio}"`, encryptionScheme: scheme }],
			}]);
			const mediaKeys = await access.createMediaKeys();
			await video.setMediaKeys(mediaKeys);
			const session = mediaKeys.createSession();
			const key = new Uint8Array(KEY);
			if (keyMode === 'wrong') {
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
		const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${codecs.video},${codecs.audio}"`);
		sourceBuffer.appendBuffer(encrypted);
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

describe('encryptCmaf output is decryptable only with the key (ClearKey EME)', () => {
	for (const scheme of ['cenc', 'cbcs'] as ProtectionScheme[]) {
		test(`${scheme}: correct key plays; wrong key and no CDM decode nothing`, async () => {
			const clear = new Uint8Array(await (await fetch('/bear-640x360-av_frag.mp4')).arrayBuffer());
			const codecs = await getCodecs(clear);
			const iv = scheme === 'cbcs' ? new Uint8Array(16).fill(0x9a) : new Uint8Array(8).fill(0x9a);
			const encrypted = encryptCmaf(clear, { key: KEY, kid: KID, iv, scheme });

			expect(await decodedFrames(encrypted, scheme, codecs, 'correct')).toBeGreaterThan(0);
			// The decoder rejects the mis-/un-decrypted bitstream outright: zero frames, not garbage frames.
			expect(await decodedFrames(encrypted, scheme, codecs, 'wrong')).toBe(0);
			expect(await decodedFrames(encrypted, scheme, codecs, 'none')).toBe(0);
		}, 20000);
	}
});
