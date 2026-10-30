import { expect, test } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	Conversion,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const sink = new EncodedPacketSink(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('H.264 video range is reported only where the stream signals it', async () => {
	const open = (name: string) => new Input({
		source: new FilePathSource(path.join(__dirname, `../public/${name}`)),
		formats: ALL_FORMATS,
	});
	const colorSpaceOf = async (name: string) => {
		using input = open(name);
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		return track.getColorSpace();
	};
	const remuxedHasColr = async (name: string) => {
		using input = open(name);
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();
		return String.fromCharCode(...new Uint8Array(output.target.buffer!)).includes('colr');
	};

	expect((await colorSpaceOf('avc-range-unsignalled.mp4')).fullRange).toBeUndefined();
	expect(await colorSpaceOf('avc-range-limited.mp4')).toEqual({
		primaries: 'bt709',
		transfer: 'bt709',
		matrix: 'bt709',
		fullRange: false,
	});
	expect((await colorSpaceOf('avc-range-full.mp4')).fullRange).toBe(true);

	expect(await remuxedHasColr('avc-range-unsignalled.mp4')).toBe(false);
	expect(await remuxedHasColr('avc-range-limited.mp4')).toBe(true);
});

// Annex B isn't supposed to exist in MP4, but some files have it anyway, with an empty avcC box
test('Annex B', async () => {
	const filePath = path.join(__dirname, '..', 'public/annex-b.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('avc1.424028');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const firstPacket = (await sink.getFirstPacket())!;
	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
});

test('HE-AAC v2 audio config is parsed correctly', async () => {
	const filePath = path.join(__dirname, '..', 'public/he-aac-v2.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.getNumberOfChannels()).toBe(2);

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('mp4a.40.29');
	expect(decoderConfig.sampleRate).toBe(44100);
	expect(decoderConfig.numberOfChannels).toBe(2);
	expect([...toUint8Array(decoderConfig.description!)]).toEqual([0xeb, 0x8a, 0x08, 0x00]);
});

test('PCM track with stsc not starting at the first chunk', async () => {
	// The stsc box's first entry starts at the second chunk, leaving three chunks of PCM audio
	const filePath = path.join(__dirname, '..', 'public/pcm-stsc-not-first-chunk.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);

	let packetCount = 0;
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		packetCount++;
	}

	expect(packetCount).toBe(3);
});

test('Missing tfdt and tfra entries referencing non-first samples', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/578
	const filePath = path.join(__dirname, '..', 'public/missing-tfdt.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(Number(packet.timestamp.toFixed(6)));
	}

	// Taken from ffprobe
	expect(timestamps).toEqual([
		0, 0.016667, 0.033333, 0.05, 0.066667, 0.083333, 0.1, 0.116667, 0.133333, 0.15,
		0.166667, 0.183333, 0.2, 0.216667, 0.233333, 0.25, 0.266667, 0.283333, 0.3, 0.316667,
		0.333333, 0.35, 0.366667, 0.383333, 0.4, 0.416667, 0.433333, 0.45, 0.466667, 0.483333,
		0.5, 0.516667, 0.533333, 0.55, 0.566667, 0.583333, 0.6, 0.616667, 0.633333, 0.65,
		0.666667, 0.683333, 0.7, 0.716667, 0.733333, 0.75, 0.766667, 0.783333, 0.8, 0.816667,
		0.833333, 0.85, 0.866667, 0.883333, 0.9, 0.916667, 0.933333, 0.95, 0.966667, 0.983333,
		1, 1.016667, 1.033333, 1.05, 1.066667, 1.083333, 1.1, 1.116667, 1.133333, 1.15,
		1.166667, 1.183333, 1.2, 1.216667, 1.233333, 1.25, 1.266667, 1.283333, 1.3, 1.316667,
		1.333333, 1.35, 1.366667, 1.383333, 1.4, 1.416667, 1.433333, 1.45, 1.466667, 1.483333,
		1.5, 1.516667, 1.533333, 1.55, 1.566667, 1.583333, 1.6, 1.616667, 1.633333, 1.65,
		1.666667, 1.683333, 1.7, 1.716667, 1.733333, 1.75, 1.766667, 1.783333, 1.8, 1.816667,
		1.833333, 1.85, 1.866667, 1.883333, 1.9, 1.916667, 1.933333, 1.95, 1.966667, 1.983333,
		2, 2.016667, 2.033333, 2.05, 2.066667, 2.083333, 2.1, 2.116667, 2.133333, 2.15,
		2.166667, 2.183333, 2.2, 2.216667, 2.233333, 2.25, 2.266667, 2.283333, 2.3, 2.316667,
		2.333333, 2.35, 2.366667, 2.383333, 2.4, 2.416667, 2.433333, 2.45, 2.466667, 2.483333,
		2.5, 2.516667, 2.533333, 2.55, 2.566667, 2.583333, 2.6, 2.616667, 2.633333, 2.65,
		2.666667, 2.683333, 2.7, 2.716667, 2.733333, 2.75, 2.766667, 2.783333, 2.8, 2.816667,
		2.833333, 2.85, 2.866667, 2.883333, 2.9, 2.916667, 2.933333, 2.95, 2.966667, 2.983333,
		3, 3.016667, 3.033333, 3.05, 3.066667, 3.083333, 3.1, 3.116667, 3.133333, 3.15,
		3.166667, 3.183333, 3.2, 3.216667, 3.233333, 3.25, 3.266667, 3.283333, 3.3, 3.316667,
		3.333333, 3.35, 3.366667, 3.383333, 3.4, 3.416667, 3.433333, 3.45, 3.466667, 3.483333,
		3.5, 3.516667, 3.533333, 3.55, 3.566667, 3.583333, 3.6, 3.616667, 3.633333, 3.65,
		3.666667, 3.683333, 3.7, 3.716667, 3.733333, 3.75, 3.766667, 3.783333, 3.8, 3.816667,
		3.833333, 3.85, 3.866667, 3.883333, 3.9, 3.916667, 3.933333, 3.95, 3.966667, 3.983333,
	]);
});

test('Key packet lookup after reading fragments without key frames', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/584
	const filePath = path.join(__dirname, '..', 'public/fragments-without-keyframes.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	expect((await sink.getKeyPacket(1.2))?.timestamp).toBe(1);

	for await (const packet of sink.packets()) {
		void packet;
	}

	expect((await sink.getKeyPacket(1.2))?.timestamp).toBe(1);
});

// bear-640x360-av_frag.mp4 states neither `base_data_offset` nor `default-base-is-moof` on either traf,
// which by ISO/IEC 14496-12 section 8.8.7 bases the audio traf on the end of the video traf's data. Read
// that way its samples land past the end of the fragment's own mdat, in the fragment after it; measured
// from the moof they fill it exactly, and the test asserts that fill before trusting it. So the boxes
// themselves say which reading the file meant, and the demuxer has to return those bytes.
test('a fragment\'s samples are read from its own mdat, whatever base its tfhd left unstated', async () => {
	const filePath = path.join(__dirname, '..', 'public/bear-640x360-av_frag.mp4');
	const bytes = new Uint8Array(readFileSync(filePath));
	const buffer = Buffer.from(bytes);
	const u32 = (offset: number) => buffer.readUInt32BE(offset);
	const typeAt = (offset: number) => buffer.toString('latin1', offset + 4, offset + 8);

	/** Every sample of one traf, as byte ranges measured from `base`. */
	const samplesOfTraf = (trafStart: number, trafEnd: number, base: number) => {
		let defaultSampleSize = 0;
		const ranges: { start: number; size: number }[] = [];
		let trackId = 0;
		let cursor = base;

		for (let offset = trafStart; offset + 8 <= trafEnd;) {
			const size = u32(offset);
			const type = typeAt(offset);
			if (type === 'tfhd') {
				const flags = u32(offset + 8) & 0xffffff;
				trackId = u32(offset + 12);
				let field = offset + 16;
				if (flags & 0x1) {
					field += 8;
				}
				if (flags & 0x2) {
					field += 4;
				}
				if (flags & 0x8) {
					field += 4;
				}
				defaultSampleSize = (flags & 0x10) ? u32(field) : 0;
			} else if (type === 'trun') {
				const flags = u32(offset + 8) & 0xffffff;
				const count = u32(offset + 12);
				let field = offset + 16;
				if (flags & 0x1) {
					cursor = base + (u32(field) | 0);
					field += 4;
				}
				if (flags & 0x4) {
					field += 4;
				}
				for (let i = 0; i < count; i++) {
					if (flags & 0x100) {
						field += 4;
					}
					const sampleSize = (flags & 0x200) ? u32(field) : defaultSampleSize;
					if (flags & 0x200) {
						field += 4;
					}
					if (flags & 0x400) {
						field += 4;
					}
					if (flags & 0x800) {
						field += 4;
					}
					ranges.push({ start: cursor, size: sampleSize });
					cursor += sampleSize;
				}
			}
			offset += size;
		}

		return { trackId, ranges };
	};

	// Expected bytes per track, in file order, with every traf measured from its moof
	const expected = new Map<number, string[]>();
	for (let offset = 0; offset + 8 <= bytes.length;) {
		const size = u32(offset);
		assert(size >= 8);
		if (typeAt(offset) === 'moof') {
			const mdatStart = offset + size;
			assert(typeAt(mdatStart) === 'mdat');
			const payloadStart = mdatStart + 8;
			const payloadEnd = mdatStart + u32(mdatStart);
			let accounted = 0;

			for (let child = offset + 8; child + 8 <= offset + size;) {
				const childSize = u32(child);
				if (typeAt(child) === 'traf') {
					const { trackId, ranges } = samplesOfTraf(child + 8, child + childSize, offset);
					const list = expected.get(trackId) ?? [];
					for (const range of ranges) {
						expect(range.start).toBeGreaterThanOrEqual(payloadStart);
						expect(range.start + range.size).toBeLessThanOrEqual(payloadEnd);
						list.push(buffer.toString('hex', range.start, range.start + range.size));
						accounted += range.size;
					}
					expected.set(trackId, list);
				}
				child += childSize;
			}

			// Measured from the moof the trafs fill the mdat exactly, which is what makes them the truth
			expect(accounted, 'the trafs do not account for every mdat byte').toBe(payloadEnd - payloadStart);
		}
		offset += size;
	}
	expect(expected.size).toBe(2);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	for (const track of await input.getTracks()) {
		const got: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			got.push(Buffer.from(packet.data).toString('hex'));
		}
		expect(got, `track ${track.id} read different bytes than its trafs name`).toEqual(expected.get(track.id));
	}
}, 60_000);

/** Every fragment of a file, as the boxes themselves name it: which track, how many samples, what sizes. */
const fragmentsOf = (buffer: Buffer) => {
	const u32 = (offset: number) => buffer.readUInt32BE(offset);
	const typeAt = (offset: number) => buffer.toString('latin1', offset + 4, offset + 8);

	const fragments: {
		mdat: { start: number; end: number };
		trafs: { trackId: number; sizes: number[] }[];
	}[] = [];

	for (let offset = 0; offset + 8 <= buffer.length;) {
		const size = u32(offset);
		if (size < 8) {
			break;
		}
		if (typeAt(offset) !== 'moof') {
			offset += size;
			continue;
		}

		const mdatOffset = offset + size;
		if (mdatOffset + 8 > buffer.length || typeAt(mdatOffset) !== 'mdat') {
			offset += size;
			continue; // Not the moof/mdat pairing this check is about
		}

		const trafs: { trackId: number; sizes: number[] }[] = [];
		for (let child = offset + 8; child + 8 <= offset + size;) {
			const childSize = u32(child);
			if (childSize < 8) {
				break;
			}
			if (typeAt(child) === 'traf') {
				let trackId = 0;
				let defaultSampleSize = 0;
				const sizes: number[] = [];

				for (let box = child + 8; box + 8 <= child + childSize;) {
					const boxSize = u32(box);
					if (boxSize < 8) {
						break;
					}
					const type = typeAt(box);
					if (type === 'tfhd') {
						const flags = u32(box + 8) & 0xffffff;
						trackId = u32(box + 12);
						let field = box + 16;
						if (flags & 0x1) {
							field += 8;
						}
						if (flags & 0x2) {
							field += 4;
						}
						if (flags & 0x8) {
							field += 4;
						}
						defaultSampleSize = (flags & 0x10) ? u32(field) : 0;
					} else if (type === 'trun') {
						const flags = u32(box + 8) & 0xffffff;
						const count = u32(box + 12);
						let field = box + 16;
						if (flags & 0x1) {
							field += 4;
						}
						if (flags & 0x4) {
							field += 4;
						}
						for (let i = 0; i < count; i++) {
							if (flags & 0x100) {
								field += 4;
							}
							sizes.push((flags & 0x200) ? u32(field) : defaultSampleSize);
							if (flags & 0x200) {
								field += 4;
							}
							if (flags & 0x400) {
								field += 4;
							}
							if (flags & 0x800) {
								field += 4;
							}
						}
					}
					box += boxSize;
				}

				trafs.push({ trackId, sizes });
			}
			child += childSize;
		}

		fragments.push({ mdat: { start: mdatOffset + 8, end: mdatOffset + u32(mdatOffset) }, trafs });
		offset += size;
	}

	return fragments;
};

// The demuxer resolving a traf's base differently from the rest of the library is silent: the offsets
// stay in range, the samples decode, and only a comparison against the boxes sees it. It read one
// fixture's audio out of the *following* fragment's mdat, and the only thing that catches that is which
// mdat a sample came from - so this asks it of every fragmented file in the corpus. The traf sample
// counts partition each track's packets by fragment, which is what says where a packet is allowed to be.
test.each([
	'bear-640x360-av_frag.mp4',
	'bear-av1.mp4',
	'encoder-push-aac.mp4',
	'encoder-push-negative-ctts.mp4',
	'encoder-push-trun-v0.mp4',
	'fragments-without-keyframes.mp4',
	'missing-tfdt.mp4',
	'rotate-buck-bunny.mp4',
	'639955605-b752f7ad-7ce8-43c2-8ae9-88e74c6ae696.mp4',
])('%s reads every sample out of the fragment that names it', async (name) => {
	const bytes = new Uint8Array(readFileSync(path.join(__dirname, '..', 'public', name)));
	const buffer = Buffer.from(bytes);
	const fragments = fragmentsOf(buffer);
	expect(fragments.length).toBeGreaterThan(0);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const packets = new Map<number, Uint8Array[]>();
	for (const track of await input.getTracks()) {
		const got: Uint8Array[] = [];
		try {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				got.push(packet.data);
			}
		} catch (error) {
			// An encrypted track hands back plaintext, which is not what its mdat holds, so placement
			// cannot be asked of it. Checked rather than assumed: the file has to actually carry CENC.
			if (!(error instanceof Error) || !/Encrypted media samples/.test(error.message)) {
				throw error;
			}
			expect(
				buffer.includes('senc') || buffer.includes('pssh') || buffer.includes('encv'),
				`${name}: refused to decrypt but carries no CENC boxes`,
			).toBe(true);
			return;
		}
		packets.set(track.id, got);
	}

	const consumed = new Map<number, number>();
	let checked = 0;

	for (const fragment of fragments) {
		for (const traf of fragment.trafs) {
			const got = packets.get(traf.trackId);
			if (got === undefined) {
				continue; // A track the demuxer does not expose has no packets to place
			}

			const from = consumed.get(traf.trackId) ?? 0;
			consumed.set(traf.trackId, from + traf.sizes.length);

			// Hoisted, and the search resumes where the last sample was found: a traf's samples are laid
			// out in order, so this is one pass over the mdat rather than one pass per sample
			const within = buffer.subarray(fragment.mdat.start, fragment.mdat.end);
			let searchFrom = 0;

			for (let i = 0; i < traf.sizes.length; i++) {
				const packet = got[from + i];
				if (packet === undefined) {
					continue; // Reported by the count assertion below rather than as a missing byte range
				}

				// Searched inside this fragment's mdat only, so a hit elsewhere cannot stand in for it
				const at = within.indexOf(packet, searchFrom);
				expect(
					at,
					`${name}: track ${traf.trackId} sample ${from + i} is not in the mdat that names it`,
				).not.toBe(-1);
				searchFrom = at + packet.byteLength;
				checked++;
			}
		}
	}

	expect(checked).toBeGreaterThan(0);
	for (const [trackId, count] of consumed) {
		expect(packets.get(trackId)!.length, `${name}: track ${trackId} packet count`).toBe(count);
	}
}, 120_000);
