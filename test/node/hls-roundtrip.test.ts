import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CmafOutputFormat, HlsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';

const AVC_PACKET = new Uint8Array([
	0, 0, 0, 1, 9, 240,
	0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64,
	0, 0, 0, 1, 40, 222, 9, 200,
	0, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251,
]);
const AVC_METADATA: EncodedVideoChunkMetadata = {
	decoderConfig: { codec: 'avc1.4d401e', codedWidth: 1280, codedHeight: 720 },
};

/** Writes an HLS presentation into memory and serves it back by file name. */
const writePresentation = async (segmentCount: number) => {
	const files = new Map<string, Uint8Array>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 1 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < segmentCount * 2; i++) {
		await source.add(
			new EncodedPacket(AVC_PACKET, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			i === 0 ? AVC_METADATA : undefined,
		);
	}
	await output.finalize();

	return new CustomPathedSource('master.m3u8', ({ path }) => {
		const name = path.split('/').pop() ?? path;
		const body = files.get(name);
		if (!body) {
			throw new Error(`No such file in the written presentation: ${path}`);
		}
		return new BufferSource(body);
	});
};

test('a written HLS presentation reads back through the demuxer', async () => {
	using input = new Input({ source: await writePresentation(4), formats: ALL_FORMATS });

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	expect(await track!.getCodec()).toBe('avc');
	expect(await track!.getDisplayWidth()).toBe(1280);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		timestamps.push(Number(packet.timestamp.toFixed(3)));
	}

	expect(timestamps.length).toBe(8);
	expect(timestamps[0]).toBe(0);
	expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
});

test('the HLS demuxer seeks by time through the playlist', async () => {
	using input = new Input({ source: await writePresentation(4), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	const packet = await new EncodedPacketSink(track).getPacket(2);
	expect(packet).not.toBeNull();
	expect(packet!.timestamp).toBeCloseTo(2, 3);
});

test('the delegating accessors report the track, not the base class', async () => {
	using input = new Input({ source: await writePresentation(4), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	// Each of these is answered either from the manifest entry or by delegating to the segment's
	// own backing; a base class that stopped doing either would still walk and seek correctly.
	expect(track.id).toBeGreaterThan(0);
	expect(await track.computeDuration()).toBeGreaterThan(0);
	expect(await track.getTimeResolution()).toBeGreaterThan(1);
	expect(await track.getLanguageCode()).toBe('und');
	// HLS swaps the meanings: EXT-X-MEDIA's DEFAULT marks the primary track, AUTOSELECT the default.
	const disposition = await track.getDisposition();
	expect(disposition.default).toBe(true);
	expect(disposition.primary).toBe(true);
});
