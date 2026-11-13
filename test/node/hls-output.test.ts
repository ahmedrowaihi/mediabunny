import { describe, expect, test, vi } from 'vitest';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { declaredVideoCodec } from '../../src/isobmff/isobmff-boxes.js';
import {
	AdtsOutputFormat,
	AdaptiveOutputFormat,
	CmafOutputFormat,
	type OutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	HlsOutputSegmentInfo,
	type SegmentPart,
	Mp3OutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import {
	AppendOnlyStreamTarget,
	BufferTarget,
	NullTarget,
	PathedTarget,
	StreamTarget,
	StreamTargetChunk,
} from '../../src/target.js';
import {
	EncodedAudioPacketSource,
	EncodedVideoPacketSource,
	SubtitleCueSource,
	TextSubtitleSource,
} from '../../src/media-source.js';
import { TTML_NAMESPACE } from '../../src/subtitles.js';
import { SegmentPipelineMuxer } from '../../src/segment-pipeline-muxer.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import path from 'node:path';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const __dirname = new URL('.', import.meta.url).pathname;

const videoSource = (codec: VideoCodec = 'avc') => new EncodedVideoPacketSource(codec);
const audioSource = (codec: AudioCodec = 'aac') => new EncodedAudioPacketSource(codec);

// Two downstream consumers were writing one CMAF segment through this format into memory and then
// picking the init and the segment back out by their *file names*, which made them depend on paths this
// fork chooses. They do not have to: `onInit` and `onSegment` hand over the `Target` itself and the
// segment's info, so the bytes and the parts are reachable without a path ever being read, and
// `creationTime` as a metadata tag is what makes two runs byte-identical - it is needed, because the
// default is `new Date()`, which only looks deterministic while two runs fall inside the same second.
// This pins that contract.
//
// `setMetadataTags` has to come after `Conversion.init`, which requires a fresh output.
test('one segment\'s init, bytes and parts are reachable without reading a path', async () => {
	const writeOne = async (creationTime: Date) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
			formats: ALL_FORMATS,
		});

		let init: Uint8Array | null = null;
		let segment: Uint8Array | null = null;
		let parts: SegmentPart[] | null = null;

		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				targetDuration: 2,
				partDuration: 0.5,
				onInit: (target) => {
					init = new Uint8Array((target as BufferTarget).buffer!);
				},
				onSegment: (target, info) => {
					segment ??= new Uint8Array((target as BufferTarget).buffer!);
					parts ??= info.parts;
				},
			}),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		const conversion = await Conversion.init({ input, output, audio: { discard: true } });
		output.setMetadataTags({ creationTime });
		await conversion.execute();

		assert(init !== null && segment !== null && parts !== null);
		return { init: init as Uint8Array, segment: segment as Uint8Array, parts: parts as SegmentPart[] };
	};

	const first = await writeOne(new Date(0));
	const second = await writeOne(new Date(0));
	// A different stated time, so "identical" above is the knob working rather than two runs landing in
	// the same second - which is what `creationTime` defaults to, `new Date()` at a one-second resolution
	const later = await writeOne(new Date(5_000_000));

	expect(readTopLevelBoxes(first.init).map(box => box.name)).toEqual(['ftyp', 'moov']);
	expect(readTopLevelBoxes(first.segment)[0]!.name).toBe('styp');

	// A stated creation time is the whole of the non-determinism, so two runs match byte for byte
	expect(Buffer.from(first.init).equals(Buffer.from(second.init))).toBe(true);
	expect(Buffer.from(first.segment).equals(Buffer.from(second.segment))).toBe(true);
	expect(Buffer.from(first.init).equals(Buffer.from(later.init))).toBe(false);

	// The parts have to tile the segment exactly, or they are not byte ranges of it
	expect(first.parts.length).toBeGreaterThan(1);
	let expectedOffset = 0;
	for (const part of first.parts) {
		expect(part.offset).toBe(expectedOffset);
		expect(part.size).toBeGreaterThan(0);
		expect(part.duration).toBeGreaterThan(0);
		expectedOffset += part.size;
	}
	expect(expectedOffset).toBe(first.segment.byteLength);
	// Playback can start at the segment, so its first part is independent and the rest need not be
	expect(first.parts[0]!.independent).toBe(true);

	// And the two halves are a playable file together, which is what the consumers do with them
	using whole = new Input({
		source: new BufferSource(new Uint8Array([...first.init, ...first.segment])),
		formats: ALL_FORMATS,
	});
	const tracks = await whole.getTracks();
	expect(tracks).toHaveLength(1);
	expect(await tracks[0]!.getCodec()).toBe('avc');
}, 60_000);

test('Playlist assignment, single video', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, single audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video with different metadata #1', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { languageCode: 'eng' });
	output.addVideoTrack(videoSource(), { languageCode: 'esp' });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('video-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('video-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, multiple video with different metadata #2', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { disposition: { primary: true } });
	output.addVideoTrack(videoSource(), { disposition: { primary: false } });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('video-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('video-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, multiple audio with different metadata', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource(), { languageCode: 'eng' });
	output.addAudioTrack(audioSource(), { languageCode: 'esp' });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, video and audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(2);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, one video and multiple audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 3));
});

test('Playlist assignment, multiple video and one audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toEqual([decl[0]!]);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[0]!]);
});

test('Playlist assignment, multiple video and audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(6);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBe('audio-1');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 3));

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual(decl.slice(0, 3));

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toEqual(decl.slice(0, 3));
});

test('Playlist assignment, video and audio in different groups', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, 1:1 pairing is muxed into one variant', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const video = new OutputTrackGroup();
	const audio = new OutputTrackGroup();
	video.pairWith(audio);

	output.addVideoTrack(videoSource(), { group: video });
	output.addAudioTrack(audioSource(), { group: audio });

	await output.start();

	const decl = (output._muxer as SegmentPipelineMuxer).playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks.map(x => x.type)).toEqual(['video', 'audio']);
});

test('Playlist assignment, separateRenditions splits a 1:1 pairing', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			separateRenditions: true,
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const video = new OutputTrackGroup();
	const audio = new OutputTrackGroup();
	video.pairWith(audio);

	output.addVideoTrack(videoSource(), { group: video });
	output.addAudioTrack(audioSource(), { group: audio });

	await output.start();

	const decl = (output._muxer as SegmentPipelineMuxer).playlistDeclarations;

	expect(decl).toHaveLength(2);

	const audioDecl = decl.find(x => x.playlist.tracks[0]!.type === 'audio');
	const videoDecl = decl.find(x => x.playlist.tracks[0]!.type === 'video');

	expect(audioDecl!.groupId).not.toBeNull();
	expect(videoDecl!.groupId).toBeNull();
	// The reference is what makes it an #EXT-X-MEDIA rendition rather than a second variant.
	expect(videoDecl!.references).toEqual([audioDecl]);
});

test('AdaptiveOutputFormat requires composed formats to agree on separateRenditions', () => {
	const segmentFormat = new MpegTsOutputFormat();
	const build = (dash: { separateRenditions?: boolean }) =>
		new AdaptiveOutputFormat({
			formats: [
				new HlsOutputFormat({ segmentFormat, separateRenditions: true }),
				new DashOutputFormat({ segmentFormat, mpdPath: 'm.mpd', ...dash }),
			],
		});

	// Omitted is not the same as agreeing; this is what pins the field's registration.
	expect(() => build({})).toThrow(/separateRenditions/);
	expect(() => build({ separateRenditions: true })).not.toThrow();
});

test('Playlist assignment, multiple video and audio in pairs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	const c = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addVideoTrack(videoSource(), { group: c });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: c });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(2);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[0]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(2);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(decl[2]!.playlist.tracks).toHaveLength(2);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio with some unpaired', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	const c = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: c });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(6);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 2));

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toHaveLength(0);

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio with multiple groups', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(8);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBe('audio-2');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[3]!.groupId).toBe('audio-2');
	expect(decl[3]!.noUri).toBe(false);

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual(decl.slice(0, 2));

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toEqual(decl.slice(0, 2));

	expect(decl[6]!.playlist.tracks).toHaveLength(1);
	expect(decl[6]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[6]!.groupId).toBeNull();
	expect(decl[6]!.references).toEqual(decl.slice(2, 4));

	expect(decl[7]!.playlist.tracks).toHaveLength(1);
	expect(decl[7]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[7]!.groupId).toBeNull();
	expect(decl[7]!.references).toEqual(decl.slice(2, 4));
});

test('Playlist assignment, video with multiple audio codecs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource('aac'));
	output.addAudioTrack(audioSource('ac3'));

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.playlist.tracks[0]!.source._codec).toBe('aac');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.playlist.tracks[0]!.source._codec).toBe('ac3');
	expect(decl[1]!.groupId).toBe('audio-2');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[1]!]);

	expect(decl[2]!.playlist).toBe(decl[3]!.playlist);
});

test('Playlist assignment, audio with multiple video codecs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource('avc'));
	output.addVideoTrack(videoSource('hevc'));
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.playlist.tracks[0]!.source._codec).toBe('avc');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toEqual([decl[0]!]);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.playlist.tracks[0]!.source._codec).toBe('hevc');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);
});

test('Playlist assignment, multiple video with conflicting audio interests', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: [a, b] });
	output.addAudioTrack(audioSource(), { group: a });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(5);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
	expect(decl[2]!.groupId).toBe('audio-2');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[0]!, decl[1]!]);

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual([decl[2]!]);
});

test('Playlist assignment, video paired with video', async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	a.pairWith(b);

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(consoleSpy.mock.calls).toHaveLength(1);
	expect(consoleSpy.mock.calls[0]![0]).toContain('Illegal pairing');
});

test('Playlist assignment, audio paired with audio', async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	a.pairWith(b);

	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(consoleSpy.mock.calls).toHaveLength(1);
	expect(consoleSpy.mock.calls[0]![0]).toContain('Illegal pairing');
});

// eslint-disable-next-line @stylistic/max-len
const avcPacketData = new Uint8Array([0, 0, 0, 1, 9, 240, 0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64, 0, 0, 0, 1, 40, 222, 9, 200, 0, 0, 1, 6, 0, 7, 128, 175, 200, 0, 0, 3, 0, 64, 128, 0, 0, 1, 6, 5, 17, 3, 135, 244, 78, 205, 10, 75, 220, 161, 148, 58, 195, 212, 155, 23, 31, 0, 128, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 175, 0, 0, 1, 37, 0, 127, 174, 8, 8, 8, 81, 49, 64, 0, 85, 230, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 147, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 250, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 188, 0, 0, 1, 37, 0, 63, 203, 130, 2, 2, 20, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 240, 0, 0, 1, 37, 0, 23, 234, 224, 128, 128, 133, 19, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 249, 49, 64, 0, 85, 230, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 192, 0, 0, 1, 37, 0, 31, 226, 224, 128, 128, 133, 19, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 250, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 188, 0, 0, 1, 37, 0, 9, 246, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 240, 0, 0, 1, 37, 0, 11, 244, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 175, 0, 0, 1, 37, 0, 13, 242, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 255, 248, 255, 4, 17, 64, 0, 69, 19, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 248]); ;
const avcMetadata: EncodedVideoChunkMetadata = {
	decoderConfig: {
		codec: 'avc1.4d401e',
		codedWidth: 1280,
		codedHeight: 720,
	},
};

// eslint-disable-next-line @stylistic/max-len
const aacPacketData = new Uint8Array([255, 241, 77, 128, 3, 159, 252, 0, 208, 0, 1, 3, 64, 0, 13, 0, 0, 17, 52, 0, 0, 208, 0, 3, 6, 128, 0, 56]);
const aacMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

// A single 20 ms CELT fullband frame (TOC byte 0xfc) followed by some payload
const opusPacketData = new Uint8Array([252, 255, 254]);
const opusMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

const setUpSegmentationEnvironment = async (options: {
	video?: boolean;
	audio?: boolean;
	mediaTimestampBase?: number;
} = {}) => {
	let result: string | null = null;
	let segmentCount = 0;
	let lastSegmentVideoTimestamps: Promise<number[]> = Promise.resolve([]);
	let lastSegmentAudioTimestamps: Promise<number[]> = Promise.resolve([]);

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(), // No ADTS for simplicity
			// So that segment timestamps can be compared directly
			mediaTimestampBase: options.mediaTimestampBase ?? 0,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					result = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentCount++;

				const videoBundle = promiseWithResolvers<number[]>();
				lastSegmentVideoTimestamps = videoBundle.promise;
				const audioBundle = promiseWithResolvers<number[]>();
				lastSegmentAudioTimestamps = audioBundle.promise;

				target.on('finalized', async () => {
					try {
						using input = new Input({
							source: new BufferSource(target.buffer!),
							formats: ALL_FORMATS,
						});

						const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
						if (videoTrack) {
							const sink = new EncodedPacketSink(videoTrack);
							const timestamps: number[] = [];
							for await (const packet of sink.packets()) {
								timestamps.push(packet.timestamp);
							}
							videoBundle.resolve(timestamps);
						} else {
							videoBundle.resolve([]);
						}

						const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
						if (audioTrack) {
							const sink = new EncodedPacketSink(audioTrack);
							const timestamps: number[] = [];
							for await (const packet of sink.packets()) {
								timestamps.push(packet.timestamp);
							}
							audioBundle.resolve(timestamps);
						} else {
							audioBundle.resolve([]);
						}
					} catch {
						videoBundle.resolve([]);
						audioBundle.resolve([]);
					}
				});
			}

			return target;
		}),
	});

	const _videoSource = options.video ? new EncodedVideoPacketSource('avc') : null;
	const _audioSource = options.audio ? new EncodedAudioPacketSource('aac') : null;

	if (_videoSource) {
		output.addVideoTrack(_videoSource);
	}
	if (_audioSource) {
		output.addAudioTrack(_audioSource);
	}

	await output.start();

	const addVideoPacket = (timestamp: number, type: PacketType, duration = 0) => {
		assert(_videoSource);

		return _videoSource.add(
			new EncodedPacket(avcPacketData, type, timestamp, duration),
			avcMetadata,
		);
	};

	const addAudioPacket = (timestamp: number, duration = 0) => {
		assert(_audioSource);

		return _audioSource.add(
			new EncodedPacket(aacPacketData, 'key', timestamp, duration),
			aacMetadata,
		);
	};

	return {
		output,
		videoSource: _videoSource,
		audioSource: _audioSource,
		addVideoPacket,
		addAudioPacket,
		get segmentCount() { return segmentCount; },
		get result() { return result; },
		get lastSegmentVideoTimestamps() { return lastSegmentVideoTimestamps; },
		get lastSegmentAudioTimestamps() { return lastSegmentAudioTimestamps; },
	};
};

test('Segmentation, empty', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.output.finalize();

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, simple', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5, 4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with a final key packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with a final key packet (audio)', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with packet durations', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	await env.addVideoPacket(3.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with packet durations (audio)', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 0.5);
	await env.addAudioPacket(0.5, 0.5);
	await env.addAudioPacket(1, 0.5);
	await env.addAudioPacket(1.5, 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2, 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5, 0.5);
	await env.addAudioPacket(3, 0.5);
	await env.addAudioPacket(3.5, 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4, 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, only one key packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.5);
	await env.addVideoPacket(2, 'delta', 0.5);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:4
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, key packets before the end of a segment (maximized segment duration test)', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'key', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(3.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5]);
	await env.addVideoPacket(4, 'delta', 0.5);
	await env.addVideoPacket(4.5, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	await env.addVideoPacket(5, 'key', 0.5);
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3, 3.5, 4, 4.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(4);
	expect(await env.lastSegmentVideoTimestamps).toEqual([5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:0.5,
segment-1-4.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, full segment duration recovery after shorter segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'key', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(3.5, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3]);
	await env.addVideoPacket(4, 'delta', 0.5);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3.5, 4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:1,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, packet start timestamp intersecting with end timestamp of previous packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.75); // This!
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, last video packet is included', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, video not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.45, 'key');
	await env.addVideoPacket(0.9, 'key');
	await env.addVideoPacket(1.35, 'key');
	await env.addVideoPacket(1.8, 'key');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2.25, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addVideoPacket(2.7, 'key');
	await env.addVideoPacket(3.15, 'key');
	await env.addVideoPacket(3.6, 'key');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4.05, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.8, 2.25, 2.7, 3.15]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3.6, 4.05]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts
#EXTINF:1.8,
segment-1-2.ts
#EXTINF:0.45,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

// Cuts land on the nearest frame to an absolute grid, so a segment may run up to half a frame long.
test('Segmentation, audio not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 0.45);
	await env.addAudioPacket(0.45, 0.45);
	await env.addAudioPacket(0.9, 0.45);
	await env.addAudioPacket(1.35, 0.45);
	await env.addAudioPacket(1.8, 0.45);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2.25, 0.45);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addAudioPacket(2.7, 0.45);
	await env.addAudioPacket(3.15, 0.45);
	await env.addAudioPacket(3.6, 0.45);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.05, 0.45);
	expect(env.segmentCount).toBe(2);
	// 4.05 is nearer the 4 s grid point than 3.6 is, so it starts the next segment instead of joining this one.
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.8, 2.25, 2.7, 3.15, 3.6]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.05]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts
#EXTINF:2.25,
segment-1-2.ts
#EXTINF:0.45,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, non-zero start time', async () => {
	const env = await setUpSegmentationEnvironment({
		video: true,
		audio: true,
		mediaTimestampBase: 1,
	});

	// The minimum packet timestamp becomes the first packet's start time
	await env.addVideoPacket(1, 'key');
	await env.addAudioPacket(0.5);
	env.audioSource!.close();
	await env.addVideoPacket(1.5, 'key');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1, 1.5, 2]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0.5]);

	await env.output.finalize();
	expect(await env.lastSegmentVideoTimestamps).toEqual([2.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, negative start time', async () => {
	const env = await setUpSegmentationEnvironment({
		video: true,
		mediaTimestampBase: -1,
	});
	const timestamps = Array.from({ length: 50 }, (_, index) => (index - 10) / 10);

	for (const timestamp of timestamps) {
		await env.addVideoPacket(timestamp, 'key', 0.1);

		if (timestamp === 1) {
			expect(env.segmentCount).toBe(1);
			expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps.slice(0, 20));
		} else if (timestamp === 3) {
			expect(env.segmentCount).toBe(2);
			expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps.slice(20, 40));
		}
	}

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps.slice(40));

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:1,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, wholly negative timestamps', async () => {
	const env = await setUpSegmentationEnvironment({
		video: true,
		mediaTimestampBase: -1,
	});
	const timestamps = [-1, -0.9, -0.8, -0.7, -0.6];

	for (const timestamp of timestamps) {
		await env.addVideoPacket(timestamp, 'key', 0.1);
	}

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:0.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, B-frames before key frame', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(1.75, 'delta');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'key');
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 1.75, 2.5, 3, 3.5]);
	await env.addVideoPacket(4.5, 'delta');

	await env.output.finalize();
	expect(await env.lastSegmentVideoTimestamps).toEqual([4, 4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, one video packet per segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 3);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(3, 'key', 3);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, one audio packet per segment', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 3);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(3, 3);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, single segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, video dictates the segmentation', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'key');
	await env.addVideoPacket(2, 'delta');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	await env.addVideoPacket(4.5, 'key');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
	await env.addAudioPacket(2);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, video dictates the segmentation, inverted', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	await env.addAudioPacket(2);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	await env.addAudioPacket(4.5);

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'key');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4.5, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, audio ending after video', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'delta');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3.0, 3.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, audio ending after video in separate segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	await env.addVideoPacket(4.5, 'delta');
	env.videoSource!.close();

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	await env.addAudioPacket(4.5);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
	await env.addAudioPacket(5.5);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([5, 5.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, end timestamp with duration', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta', 0.25);

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5, 0.3);
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, closing writes segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);

	expect(env.segmentCount).toBe(0);

	env.videoSource!.close();
	await new Promise(resolve => setTimeout(resolve, 4));

	expect(env.segmentCount).toBe(0);

	env.audioSource!.close();
	await new Promise(resolve => setTimeout(resolve, 4));

	expect(env.segmentCount).toBe(1);

	await env.output.finalize();

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('write, onSegment, onPlaylist, onMaster events', async () => {
	const onSegment = vi.fn();
	const onPlaylist = vi.fn();
	const onMaster = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onSegment,
			onPlaylist,
			onMaster,
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	let targetWrites = 0;
	output.target.on('write', () => targetWrites++);

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	// First segment
	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	expect(onSegment).toHaveBeenCalledTimes(0);

	// Second segment starts, first one is finalized
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	expect(onSegment).toHaveBeenCalledTimes(1);
	expect(onSegment.mock.calls[0]![1]).toEqual(expect.objectContaining({ n: 1 }));

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onPlaylist).not.toHaveBeenCalled();
	expect(onMaster).not.toHaveBeenCalled();

	await output.finalize();

	expect(targetWrites).toBeGreaterThan(0);

	// Second segment finalized on close
	expect(onSegment).toHaveBeenCalledTimes(2);
	expect(onSegment.mock.calls[1]![1]).toEqual(expect.objectContaining({ n: 2 }));

	// Both segment calls should have a Target as the first argument
	expect(onSegment.mock.calls[0]![0]).toBeDefined();
	expect(onSegment.mock.calls[1]![0]).toBeDefined();

	// Playlist and master should have been called once each
	expect(onPlaylist).toHaveBeenCalledTimes(1);
	expect(typeof onPlaylist.mock.calls[0]![0]).toBe('string');
	expect(onPlaylist.mock.calls[0]![0]).toContain('#EXTM3U');
	expect(onPlaylist.mock.calls[0]![1]).toEqual(expect.objectContaining({ n: 1 }));

	expect(onMaster).toHaveBeenCalledTimes(1);
	expect(typeof onMaster.mock.calls[0]![0]).toBe('string');
	expect(onMaster.mock.calls[0]![0]).toContain('#EXTM3U');
});

test('Single-file mode', async () => {
	let playlistText: string | null = null;
	const segmentPaths = new Set<string>();

	const onSegment = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			singleFilePerPlaylist: true,
			onSegment,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentPaths.add(request.path);
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onSegment).toHaveBeenCalledTimes(0);

	await output.finalize();

	// Only one segment file should have been created
	expect(segmentPaths.size).toBe(1);

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:4');

	expect(onSegment).toHaveBeenCalledTimes(1);
});

test('Single-file mode with fragmented MP4 produces proper standalone segment file', async () => {
	let playlistText: string | null = null;
	let segmentBuffer: ArrayBuffer | null = null;
	const segmentPaths = new Set<string>();

	const onSegment = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new Mp4OutputFormat({
				fastStart: 'fragmented',
				minimumFragmentDuration: 0, // This is to be ignored
			}),
			singleFilePerPlaylist: true,
			onSegment,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentPaths.add(request.path);

				target.on('finalized', () => {
					segmentBuffer = target.buffer!;
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onSegment).toHaveBeenCalledTimes(0);

	await output.finalize();

	// Only one segment file should have been created
	expect(segmentPaths.size).toBe(1);

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:6');

	expect(onSegment).toHaveBeenCalledTimes(1);

	assert(segmentBuffer);

	const str = new TextDecoder('ascii').decode(segmentBuffer);
	expect(str.includes('mfra')).toBe(true); // It's a proper standalone fMP4 file
	expect(str.split('moov')).toHaveLength(2); // Only one moov box

	using input = new Input({
		source: new BufferSource(segmentBuffer),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const timestamps: number[] = [];
	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	// Offset by the default media timestamp offset
	expect(timestamps).toEqual([10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5]);
});

test('StreamTarget, write is called for each target', async () => {
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', (request) => {
			writeCounts.set(request.path, 0);

			const writable = new WritableStream<StreamTargetChunk>({
				write() {
					writeCounts.set(request.path, writeCounts.get(request.path)! + 1);
				},
			});

			return new StreamTarget(writable);
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Every StreamTarget should have been written to at least once
	for (const [path, count] of writeCounts) {
		expect(count, `Expected writes for ${path}`).toBeGreaterThanOrEqual(1);
	}
});

test('I-frame stream', async () => {
	let masterText = '';
	let playlistText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
			onPlaylist: (text) => { playlistText = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source, { hasOnlyKeyPackets: true });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	expect(muxer.playlistDeclarations).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.groupId).toBeNull();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 1), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 1, 1), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 1), avcMetadata);

	await output.finalize();

	expect(playlistText).toContain('#EXT-X-I-FRAMES-ONLY');
	expect(playlistText).toContain('#EXT-X-VERSION:4');

	expect(masterText).toContain('#EXT-X-I-FRAME-STREAM-INF:');
	expect(masterText).toMatch(/#EXT-X-I-FRAME-STREAM-INF:[^\n]*URI="/);
	expect(masterText).not.toContain('#EXT-X-STREAM-INF:');
});

test('I-frame stream, pairing warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const group = new OutputTrackGroup();
	output.addVideoTrack(videoSource(), { hasOnlyKeyPackets: true, group });
	output.addAudioTrack(audioSource(), { group });

	await output.start();

	const muxer = output._muxer as SegmentPipelineMuxer;
	// Despite being pairable, they must end up as separate unpaired declarations
	expect(muxer.playlistDeclarations).toHaveLength(2);
	expect(muxer.playlistDeclarations[0]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[1]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.groupId).toBeNull();
	expect(muxer.playlistDeclarations[1]!.groupId).toBeNull();

	expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('key-packets-only'));

	warnSpy.mockRestore();
});

test('CMAF segmentation', async () => {
	let playlistText: string | null = null;
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	expect(targets.has('init-1.m4s')).toBe(true);
	expect(targets.has('segment-1-1.m4s')).toBe(true);
	expect(targets.has('segment-1-2.m4s')).toBe(true);

	expect(playlistText).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:1.5,
segment-1-2.m4s

#EXT-X-ENDLIST
`,
	);

	// Verify that each segment contains exactly 4 video packets
	const initTarget = targets.get('init-1.m4s')!;
	using initInput = new Input({
		source: new BufferSource(initTarget.buffer!),
		formats: ALL_FORMATS,
	});

	for (const segmentPath of ['segment-1-1.m4s', 'segment-1-2.m4s']) {
		const segmentTarget = targets.get(segmentPath)!;

		using segmentInput = new Input({
			source: new BufferSource(segmentTarget.buffer!),
			formats: ALL_FORMATS,
			initInput,
		});

		const videoTrack = await segmentInput.getPrimaryVideoTrack() as InputVideoTrack;
		expect(videoTrack).toBeTruthy();

		const sink = new EncodedPacketSink(videoTrack);
		let packetCount = 0;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const packet of sink.packets()) {
			packetCount++;
		}
		expect(packetCount).toBe(4);
	}
});

// 4 s of 25 fps video with a key frame every second, interleaved with AAC; resolves to where the audio ends
const feedVideoAndAudio = async (video: EncodedVideoPacketSource, audio: EncodedAudioPacketSource) => {
	const frameDuration = 0.04;
	const audioFrameDuration = 1024 / 48000;
	let audioTimestamp = 0;
	for (let i = 0; i < 100; i++) {
		const timestamp = i * frameDuration;
		const type = i % 25 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, timestamp, frameDuration), avcMetadata);

		while (audioTimestamp < timestamp + frameDuration) {
			await audio.add(new EncodedPacket(aacPacketData, 'key', audioTimestamp, audioFrameDuration), aacMetadata);
			audioTimestamp += audioFrameDuration;
		}
	}

	return audioTimestamp;
};

test('CMAF segmentation with parts', async () => {
	const targets = new Map<string, BufferTarget>();
	const segmentInfos: HlsOutputSegmentInfo[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			// Asserts on the media's own timestamps, so it states the base rather than taking the default
			mediaTimestampBase: 0,
			partDuration: 0.5,
			onSegment: (_, info) => segmentInfos.push(info),
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});

	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video);
	output.addAudioTrack(audio);
	await output.start();

	const audioEnd = await feedVideoAndAudio(video, audio);
	await output.finalize();

	expect(segmentInfos).toHaveLength(2);
	using initInput = new Input({
		source: new BufferSource(targets.get('init-1.m4s')!.buffer!),
		formats: ALL_FORMATS,
	});

	for (const [index, info] of segmentInfos.entries()) {
		const segmentStart = index * 2;
		const bytes = new Uint8Array(targets.get(`segment-1-${info.n}.m4s`)!.buffer!);
		const parts = info.parts;
		assert(parts);

		const segmentEnd = index === segmentInfos.length - 1 ? audioEnd : segmentStart + 2;
		expect(parts.reduce((sum, part) => sum + part.duration, 0)).toBeCloseTo(segmentEnd - segmentStart);

		// The parts tile the segment, and every part after the first begins on its own fragment
		expect(parts[0]!.offset).toBe(0);
		for (let i = 1; i < parts.length; i++) {
			expect(parts[i]!.offset).toBe(parts[i - 1]!.offset + parts[i - 1]!.size);
		}
		expect(parts.at(-1)!.offset + parts.at(-1)!.size).toBe(bytes.length);
		const moofStarts = readTopLevelBoxes(bytes).filter(box => box.name === 'moof').map(box => box.start);
		expect(moofStarts.slice(1)).toEqual(parts.slice(1).map(part => part.offset));

		// Each part demuxes on its own, starting at the time its fragment declares
		let partStart = segmentStart;
		for (const part of parts) {
			using partInput = new Input({
				source: new BufferSource(bytes.subarray(part.offset, part.offset + part.size)),
				formats: ALL_FORMATS,
				initInput,
			});
			const videoTrack = await partInput.getPrimaryVideoTrack();
			assert(videoTrack);
			const firstPacket = await new EncodedPacketSink(videoTrack).getFirstPacket();
			assert(firstPacket);
			expect(firstPacket.timestamp).toBeCloseTo(partStart);
			expect(part.independent).toBe(firstPacket.type === 'key');

			expect(part.duration).toBeLessThanOrEqual(0.5 + 1e-6);
			if (part !== parts.at(-1) && !part.independent) {
				expect(part.duration).toBeGreaterThanOrEqual(0.85 * 0.5);
			}

			partStart += part.duration;
		}
	}
});

// 23.976 fps with a key frame every 96 frames makes 4.004 s segments
const writeNtscPlaylist = async (options: Partial<HlsOutputFormatOptions>) => {
	const targets = new Map<string, BufferTarget>();
	const segmentInfos: HlsOutputSegmentInfo[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 4,
			onSegment: (_, info) => segmentInfos.push(info),
			...options,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});
	const video = videoSource();
	output.addVideoTrack(video);
	await output.start();

	const frameDuration = 1001 / 24000;
	for (let i = 0; i < 96 * 3; i++) {
		const type = i % 96 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, i * frameDuration, frameDuration), avcMetadata);
	}
	await output.finalize();

	const playlistPath = [...targets.keys()].find(path => path.endsWith('.m3u8') && !path.startsWith('master'));
	assert(playlistPath);
	const playlist = new TextDecoder().decode(targets.get(playlistPath)!.buffer!);
	return { playlist, segmentInfos };
};

test('HLS target duration is the longest segment rounded to the nearest integer', async () => {
	const { playlist } = await writeNtscPlaylist({});

	const extinfs = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
	expect(extinfs.length).toBeGreaterThan(0);
	expect(Math.max(...extinfs)).toBeGreaterThan(4);
	expect(playlist).toContain('#EXT-X-TARGETDURATION:4\n');
	for (const extinf of extinfs) {
		expect(Math.round(extinf)).toBeLessThanOrEqual(4);
	}
});

test('HLS parts never exceed the part duration at a frame rate it does not divide', async () => {
	const partDuration = 1;
	const { segmentInfos } = await writeNtscPlaylist({ partDuration });

	expect(segmentInfos.length).toBeGreaterThan(0);
	for (const info of segmentInfos) {
		const parts = info.parts;
		assert(parts);
		for (const [i, part] of parts.entries()) {
			expect(part.duration).toBeLessThanOrEqual(partDuration + 1e-6);
			if (i < parts.length - 1 && !part.independent) {
				expect(part.duration).toBeGreaterThanOrEqual(0.85 * partDuration);
			}
		}
	}
});

test('HLS parts never exceed the part duration with B-frames', async () => {
	const partDuration = 0.5;
	const segmentInfos: HlsOutputSegmentInfo[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			partDuration,
			onSegment: (_, info) => segmentInfos.push(info),
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const timestamps: number[] = [];
	const sink = new EncodedPacketSink(videoTrack);
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).not.toEqual([...timestamps].sort((a, b) => a - b));

	await (await Conversion.init({ input, output })).execute();

	expect(segmentInfos.length).toBeGreaterThan(0);
	for (const info of segmentInfos) {
		const parts = info.parts;
		assert(parts);
		for (const [i, part] of parts.entries()) {
			expect(part.duration).toBeLessThanOrEqual(partDuration + 1e-6);
			if (i < parts.length - 1 && !part.independent) {
				expect(part.duration).toBeGreaterThanOrEqual(0.85 * partDuration);
			}
		}
	}
});

test('CMAF segmentation with parts, single file per playlist', async () => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			partDuration: 0.5,
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});

	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video);
	output.addAudioTrack(audio);
	await output.start();
	await feedVideoAndAudio(video, audio);
	await output.finalize();

	const playlist = (output._muxer as SegmentPipelineMuxer).playlists[0];
	assert(playlist?.singleFile);
	const bytes = new Uint8Array(targets.get(playlist.singleFile.path)!.buffer!);
	const moofStarts = readTopLevelBoxes(bytes).filter(box => box.name === 'moof').map(box => box.start);

	expect(playlist.writtenSegments).toHaveLength(2);
	for (const segment of playlist.writtenSegments) {
		const parts = segment.parts;
		assert(parts && segment.byteOffset !== null);

		// Offsets stay relative to the segment, whose byte range in the file the parts tile
		expect(parts[0]!.offset).toBe(0);
		for (let i = 1; i < parts.length; i++) {
			expect(parts[i]!.offset).toBe(parts[i - 1]!.offset + parts[i - 1]!.size);
		}
		expect(parts.at(-1)!.offset + parts.at(-1)!.size).toBe(segment.byteSize);

		const segmentEnd = segment.byteOffset + segment.byteSize;
		const segmentMoofStarts = moofStarts.filter(start => start >= segment.byteOffset! && start < segmentEnd);
		expect(segmentMoofStarts.slice(1)).toEqual(parts.slice(1).map(part => segment.byteOffset! + part.offset));
	}
});

test('CMAF segmentation, single file per playlist', async () => {
	let playlistText: string | null = null;
	const writtenPaths = new Set<string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('', (request) => {
			writtenPaths.add(request.path);
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Init and segment files should have been written
	expect(writtenPaths).toContain('segments-1.m4s');
	expect(writtenPaths).not.toContain('init-1.m4s');

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:6');
	expect(playlistText).toContain('#EXT-X-MAP:URI=');
});

test('Sparse tracks in segments, MPEG-TS', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new MpegTsOutputFormat(),
	});
});

test('Sparse tracks in segments, CMAF', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new CmafOutputFormat(),
	});
});

test('Sparse tracks in segments, standard MP4', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat(),
	});
});

test('Sparse tracks in segments, fragmented MP4', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
	});
});

test('Sparse tracks in segments, fragmented MP4 + single file', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		singleFilePerPlaylist: true,
	});
});

test('Opus codec string in master playlist', async () => {
	let masterText = '';
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const video = videoSource();
	const audio = audioSource('opus');
	output.addVideoTrack(video);
	output.addAudioTrack(audio);

	await output.start();

	await video.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);

	await audio.add(new EncodedPacket(opusPacketData, 'key', 0, 0.02), opusMetadata);
	await audio.add(new EncodedPacket(opusPacketData, 'key', 0.5, 0.02), opusMetadata);
	await audio.add(new EncodedPacket(opusPacketData, 'key', 1, 0.02), opusMetadata);
	await audio.add(new EncodedPacket(opusPacketData, 'key', 1.5, 0.02), opusMetadata);

	await output.finalize();

	// WebCodecs calls it "opus", but HLS clients expect "Opus", the ISOBMFF sample entry name. Safari refuses to play
	// the variant stream when given "opus".
	// This fork declares avc3 when parameter sets are in-band (no decoderConfig.description, as here),
	// where upstream always writes avc1. The Opus mapping is what this test is about.
	expect(masterText).toMatch(/CODECS="avc3\.[0-9A-Fa-f]+,Opus"/);

	// The HLS input must understand the string the HLS output writes
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
	expect(audioTrack).toBeTruthy();
	expect(await audioTrack.getCodec()).toBe('opus');
});

test('Empty playlist bandwidth, from track metadata', async () => {
	let masterText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', () => new BufferTarget()),
	});

	output.addVideoTrack(videoSource(), {
		bitrate: 2_000_000,
		averageBitrate: 1_500_000,
	});
	output.addAudioTrack(audioSource(), {
		bitrate: 128_000,
		averageBitrate: 100_000,
	});

	await output.start();
	await output.finalize();

	expect(masterText).toContain('BANDWIDTH=2128000,AVERAGE-BANDWIDTH=1600000,');
});

test('Empty playlist bandwidth, medium quality default fallback', async () => {
	let masterText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', () => new BufferTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();
	await output.finalize();

	const bandwidth = Number(masterText.match(/BANDWIDTH=(\d+)/)![1]);
	expect(bandwidth).toBeGreaterThan(0);
});

const testSparseTracksInSegments = async (hlsOptions: HlsOutputFormatOptions) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat(hlsOptions),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video);
	output.addAudioTrack(audio);

	await output.start();

	// We expect three segments: First one with just video, second with video and audio, last one with just audio.

	await video.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await audio.add(new EncodedPacket(aacPacketData, 'key', 2, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 2.5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 3, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 3.5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 4, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 4.5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 5.5, 0), aacMetadata);

	await output.finalize();

	// Read the entire output back using the HLS input
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
	expect(videoTrack).toBeTruthy();
	const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
	expect(audioTrack).toBeTruthy();

	const videoSink = new EncodedPacketSink(videoTrack);
	const videoTimestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		videoTimestamps.push(packet.timestamp);
	}
	expect(videoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);

	const audioSink = new EncodedPacketSink(audioTrack);
	const audioTimestamps: number[] = [];
	for await (const packet of audioSink.packets()) {
		audioTimestamps.push(packet.timestamp);
	}
	expect(audioTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
};

test('Live mode', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	expect(writtenTexts.size).toBe(0);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.has('playlist-1.m3u8')).toBe(true);
	expect(writtenTexts.has('master.m3u8')).toBe(true);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writeCounts.get('master.m3u8')).toBe(3);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts

#EXT-X-ENDLIST
`);
});

// A live CMAF output that cuts parts, so the playlists can be asserted whole.
const writeLivePartsPlaylist = async (options: {
	partDuration?: number;
	partHoldBack?: number;
	canBlockReload?: boolean;
	preloadHint?: boolean;
	singleFilePerPlaylist?: boolean;
	live?: boolean;
} = {}) => {
	const writtenTexts = new Map<string, string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			live: options.live ?? true,
			partDuration: options.partDuration ?? 0.5,
			partHoldBack: options.partHoldBack,
			canBlockReload: options.canBlockReload,
			preloadHint: options.preloadHint,
			singleFilePerPlaylist: options.singleFilePerPlaylist,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);
	await output.start();

	// Eight seconds at two-second segments, so the earliest segments age past the retention bound
	for (let i = 0; i < 16; i++) {
		const type = i % 4 === 0 ? 'key' : 'delta';
		await source.add(new EncodedPacket(avcPacketData, type, i * 0.5, 0.5), avcMetadata);
	}
	await output.finalize();

	return writtenTexts.get('playlist-1.m3u8')!;
};

test('live parts are listed with PART-INF and SERVER-CONTROL', async () => {
	const playlist = await writeLivePartsPlaylist();

	expect(playlist).toContain('#EXT-X-VERSION:9'); // EXT-X-PART requires version 9
	expect(playlist).toContain('#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=1.5'); // 3 × PART-TARGET
	expect(playlist).toContain('#EXT-X-PART-INF:PART-TARGET=0.5');
	expect(playlist).toContain('#EXT-X-PART:DURATION=');

	// The tags sit between TARGETDURATION and MEDIA-SEQUENCE, as the serializer orders them
	const order = ['#EXT-X-TARGETDURATION:', '#EXT-X-SERVER-CONTROL:', '#EXT-X-PART-INF:'];
	const positions = order.map(tag => playlist.indexOf(tag));
	expect(positions).toEqual([...positions].sort((a, b) => a - b));

	// Every part line addresses its own segment by byte range, and the first part of a segment is independent
	const parts = playlist.split('\n').filter(line => line.startsWith('#EXT-X-PART:'));
	expect(parts.length).toBeGreaterThan(0);
	for (const part of parts) {
		expect(part).toMatch(/URI="segment-1-\d+\.m4s",BYTERANGE="\d+@\d+"/);
	}
	expect(parts.some(part => part.endsWith(',INDEPENDENT=YES'))).toBe(true);
});

test('parts age out of the playlist while their segment stays listed', async () => {
	const playlist = await writeLivePartsPlaylist();

	const listed = new Set(
		playlist.split('\n')
			.filter(line => line.startsWith('#EXT-X-PART:'))
			.map(line => /URI="([^"]+)"/.exec(line)![1]!),
	);
	const segments = playlist.split('\n').filter(line => line.endsWith('.m4s') && !line.startsWith('#'));

	// Retention is three target durations, so the oldest segments keep their EXTINF but lose their parts
	expect(segments.length).toBeGreaterThan(listed.size);
	expect(listed.size).toBeGreaterThan(0);
	for (const uri of listed) {
		expect(segments).toContain(uri);
	}
});

test('a VOD playlist lists no parts even when they are cut', async () => {
	const playlist = await writeLivePartsPlaylist({ live: false });

	expect(playlist).not.toContain('#EXT-X-PART');
	expect(playlist).not.toContain('#EXT-X-SERVER-CONTROL');
	expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
});

test('part byte ranges are stated against the single file that holds them', async () => {
	const playlist = await writeLivePartsPlaylist({ singleFilePerPlaylist: true });

	const offsets = playlist.split('\n')
		.filter(line => line.startsWith('#EXT-X-PART:'))
		.map(line => Number(/BYTERANGE="\d+@(\d+)"/.exec(line)![1]!));

	// Offsets address the whole file, so the parts of a later segment start past the first segment's bytes
	expect(offsets.length).toBeGreaterThan(1);
	expect(offsets.some(offset => offset > 0)).toBe(true);
	expect([...offsets]).toEqual([...offsets].sort((a, b) => a - b));
});

test('no preload hint is written unless it is asked for', async () => {
	// The hint names bytes that do not exist yet, which only a server holding the request can answer
	expect(await writeLivePartsPlaylist()).not.toContain('#EXT-X-PRELOAD-HINT');
	expect(await writeLivePartsPlaylist({ singleFilePerPlaylist: true })).not.toContain('#EXT-X-PRELOAD-HINT');
});

test('the preload hint names the segment the muxer writes next', async () => {
	const playlist = await writeLivePartsPlaylist({ preloadHint: true });

	const hint = playlist.split('\n').find(line => line.startsWith('#EXT-X-PRELOAD-HINT:'))!;
	expect(hint).toMatch(/^#EXT-X-PRELOAD-HINT:TYPE=PART,URI="segment-1-\d+\.m4s"$/);
	// A hint at the start of a resource states no BYTERANGE-START
	expect(hint).not.toContain('BYTERANGE-START');

	// The hinted segment is the one after every segment already listed, not one of them
	const listed = playlist.split('\n').filter(line => line.endsWith('.m4s') && !line.startsWith('#'));
	const hinted = /URI="([^"]+)"/.exec(hint)![1]!;
	expect(listed).not.toContain(hinted);
	expect(Number(/segment-1-(\d+)\.m4s/.exec(hinted)![1]!))
		.toBe(Math.max(...listed.map(uri => Number(/segment-1-(\d+)\.m4s/.exec(uri)![1]!))) + 1);
});

test('the preload hint addresses the shared file when there is one', async () => {
	const playlist = await writeLivePartsPlaylist({ preloadHint: true, singleFilePerPlaylist: true });

	const hint = playlist.split('\n').find(line => line.startsWith('#EXT-X-PRELOAD-HINT:'))!;
	expect(hint).toMatch(/^#EXT-X-PRELOAD-HINT:TYPE=PART,URI="[^"]+",BYTERANGE-START=\d+$/);

	// The hint starts where the file currently ends: past the last part already published
	const start = Number(/BYTERANGE-START=(\d+)/.exec(hint)![1]!);
	const lastPart = playlist.split('\n').filter(line => line.startsWith('#EXT-X-PART:')).at(-1)!;
	const [size, offset] = /BYTERANGE="(\d+)@(\d+)"/.exec(lastPart)!.slice(1).map(Number) as [number, number];
	expect(start).toBeGreaterThanOrEqual(size + offset);
});

test('PART-HOLD-BACK and CAN-BLOCK-RELOAD follow the stated options', async () => {
	const playlist = await writeLivePartsPlaylist({ partHoldBack: 2.5, canBlockReload: true });
	expect(playlist).toContain('#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=2.5');
});

test('Live mode, CMAF', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	expect(writtenTexts.size).toBe(0);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.has('playlist-1.m3u8')).toBe(true);
	expect(writtenTexts.has('master.m3u8')).toBe(true);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:2,
segment-1-2.m4s
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writeCounts.get('master.m3u8')).toBe(3);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:2,
segment-1-2.m4s
#EXTINF:2,
segment-1-3.m4s

#EXT-X-ENDLIST
`);
});

test('Live mode, fixed target duration', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);

	await output.finalize();

	// The TARGETDURATION remains 2 even tho there are segments longer than that; this is because the spec disallows the
	// target duration to change, and it must be the same across all playlists
	expect(writeCounts.get('master.m3u8')).toBe(1);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts

#EXT-X-ENDLIST
`);
});

test('Live mode, empty', async () => {
	const writtenTexts = new Map<string, string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();
	await output.finalize();

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-ENDLIST
`);
});

test('EXT-X-PROGRAM-DATE-TIME writing', async () => {
	let result: string | null = null;
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { result = text; },
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source, { isRelativeToUnixEpoch: true });

	await output.start();

	const base = Date.parse('2026-01-01T00:00:00.250Z') / 1000;

	await source.add(new EncodedPacket(avcPacketData, 'key', base + 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', base + 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 3.5, 0), avcMetadata);

	await output.finalize();

	expect(result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.250Z
segment-1-1.ts
#EXTINF:1.5,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:02.250Z
segment-1-2.ts

#EXT-X-ENDLIST
`);

	// Only the playlist carries the Unix time, while the media starts at the default base of 10 seconds
	const segmentTarget = targets.get('segment-1-1.ts');
	assert(segmentTarget);

	using segmentInput = new Input({
		source: new BufferSource(segmentTarget.buffer!),
		formats: ALL_FORMATS,
	});
	const videoTrack = await segmentInput.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([10, 10.5, 11, 11.5]);
});

test('Throws if some tracks are relativeToUnixEpoch and some are not', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { isRelativeToUnixEpoch: true });
	output.addAudioTrack(audioSource(), { isRelativeToUnixEpoch: false });

	await expect(output.start()).rejects.toThrow('relativeToUnixEpoch');
});

test('Live mode, maxLiveSegmentCount', async () => {
	const writtenTexts = new Map<string, string>();
	const poppedSegments: { path: string; info: HlsOutputSegmentInfo }[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			onSegmentPopped: (path, info) => {
				poppedSegments.push({ path, info });
			},
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 6, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
`);

	expect(poppedSegments).toHaveLength(1);
	expect(poppedSegments[0]!.path).toBe('segment-1-1.ts');
	expect(poppedSegments[0]!.info.n).toBe(1);
	expect(poppedSegments[0]!.info.isSingleFile).toBe(false);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 6.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts

#EXT-X-ENDLIST
`);

	expect(poppedSegments).toHaveLength(2);
	expect(poppedSegments[1]!.path).toBe('segment-1-2.ts');
	expect(poppedSegments[1]!.info.n).toBe(2);
});

test('Live mode, maxLiveSegmentCount with singleFilePerPlaylist', async () => {
	const onSegmentPopped = vi.fn();
	let lastPlaylistText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			singleFilePerPlaylist: true,
			onSegmentPopped,
			onPlaylist: (content) => {
				lastPlaylistText = content;
			},
		}),
		target: new PathedTarget('master.m3u8', () => {
			return new BufferTarget();
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 6, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 6.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7.5, 0.5), avcMetadata);

	await output.finalize();

	expect(onSegmentPopped).not.toHaveBeenCalled();

	// Popping still happened
	const extinfCount = (lastPlaylistText.match(/#EXTINF:/g) ?? []).length;
	expect(extinfCount).toBe(2);
});

test('Append-only stream', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Each segment file should have been written to at least once
	for (const [, count] of writes) {
		expect(count).toBeGreaterThanOrEqual(1);
	}

	expect(writes.size).toBe(1 + 1 + 2); // Master playlist + media playlist + 2 segments
});

test('Append-only stream, single file', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Each segment file should have been written to at least once
	for (const [, count] of writes) {
		expect(count).toBeGreaterThanOrEqual(1);
	}

	expect(writes.size).toBe(1 + 1 + 1); // Master playlist + media playlist + 1 segments file
});

test('Append-only stream, single file with CMAF', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Each segment file should have been written to at least once
	for (const [, count] of writes) {
		expect(count).toBeGreaterThanOrEqual(1);
	}

	expect(writes.size).toBe(1 + 1 + 1); // Master playlist + media playlist + 1 segments file
});

test('Append-only stream with monotonicity violation', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new Mp4OutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);

	await expect(source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata))
		.rejects.toThrow('AppendOnlyStreamTarget');
});

test('Relative paths & isRoot', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			getPlaylistPath: () => `a/folder/playlist.m3u8`,
		}),
		target: new PathedTarget('path/to/master.m3u8', (request) => {
			if (request.isRoot) {
				expect(request.path).toBe('path/to/master.m3u8');
			} else {
				expect(request.path.startsWith('path/to/a/folder/')).toBe(true);
			}

			return new BufferTarget();
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();
});

/**
 * mediabunny generates `hev1.` codec strings but writes an `hvc1` sample entry. A manifest that
 * repeats the decoder config therefore advertises a codec the file is not, and players use
 * `CODECS` for capability checks — one supporting `hvc1` but not `hev1` refuses a stream it could
 * have played.
 */
test('HEVC manifests declare the fourcc the container actually wrote', async () => {
	const files = new Map<string, Uint8Array>();
	const shared = { segmentFormat: new CmafOutputFormat(), targetDuration: 2 } as const;

	const output = new Output({
		format: new AdaptiveOutputFormat({
			formats: [
				new HlsOutputFormat({ ...shared }),
				new DashOutputFormat({ ...shared, mpdPath: 'master.mpd' }),
			],
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
		formats: ALL_FORMATS,
	});
	await (await Conversion.init({ input, output })).execute();

	const read = (name: string) => {
		const bytes = files.get(name);
		assert(bytes);
		return bytes;
	};
	const decode = (name: string) => new TextDecoder().decode(read(name));
	const master = decode('master.m3u8');
	const mpd = decode('master.mpd');

	expect(master).toContain('hvc1.');
	expect(master).not.toContain('hev1.');
	expect(mpd).toContain('hvc1.');
	expect(mpd).not.toContain('hev1.');

	// And the claim is true: the media really does carry an hvc1 sample entry.
	const media = read([...files.keys()].find(p => /\.(m4s|mp4)$/.test(p))!);
	const head = new TextDecoder('latin1').decode(media.subarray(0, 4096));
	expect(head).toContain('hvc1');
	expect(head).not.toContain('hev1');
});

describe('declaredVideoCodec', () => {
	test('rewrites the fourcc to the sample entry an ISOBMFF container writes', () => {
		for (const format of [new CmafOutputFormat(), new Mp4OutputFormat(), new MovOutputFormat()]) {
			expect(declaredVideoCodec('hevc', 'hev1.1.6.L63.90', format, false)).toBe('hvc1.1.6.L63.90');
		}
		expect(declaredVideoCodec('hevc', 'hvc1.1.6.L63.90', new CmafOutputFormat(), false)).toBe('hvc1.1.6.L63.90');
	});

	test('leaves MPEG-TS alone, where parameter sets really are in band', () => {
		// hvc1 asserts parameter sets live only in the sample entry. MPEG-TS has none and carries
		// them in the stream, so rewriting to hvc1 there would be the opposite lie.
		expect(declaredVideoCodec('hevc', 'hev1.1.6.L63.90', new MpegTsOutputFormat(), true))
			.toBe('hev1.1.6.L63.90');
	});

	test('passes through codecs whose fourcc is not ambiguous', () => {
		expect(declaredVideoCodec('av1', 'av01.0.04M.08', new CmafOutputFormat(), false)).toBe('av01.0.04M.08');
		expect(declaredVideoCodec('vp9', 'vp09.00.10.08', new CmafOutputFormat(), false)).toBe('vp09.00.10.08');
	});
});

const setUpSubtitleEnvironment = async (
	options: { dash?: boolean; segmentFormat?: OutputFormat; forced?: boolean } = {},
) => {
	const files = new Map<string, string>();
	const shared: HlsOutputFormatOptions = {
		segmentFormat: options.segmentFormat ?? new MpegTsOutputFormat(),
		targetDuration: 2,
	};

	const output = new Output({
		format: options.dash
			? new AdaptiveOutputFormat({
				formats: [
					new HlsOutputFormat({ ...shared }),
					new DashOutputFormat({ ...shared, mpdPath: 'master.mpd' }),
				],
			})
			: new HlsOutputFormat(shared),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new TextDecoder().decode(target.buffer!)));
			return target;
		}),
	});

	const video = videoSource();
	output.addVideoTrack(video);

	const subtitles = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(subtitles, { languageCode: 'eng', name: 'English' });
	const forcedSubtitles = options.forced ? new TextSubtitleSource('webvtt') : null;
	if (forcedSubtitles) {
		output.addSubtitleTrack(forcedSubtitles, {
			languageCode: 'eng',
			name: 'Forced',
			disposition: { forced: true },
		});
	}

	await output.start();

	for (const timestamp of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
		await video.add(
			new EncodedPacket(avcPacketData, timestamp % 2 === 0 ? 'key' : 'delta', timestamp, 0.5),
			avcMetadata,
		);
	}

	await subtitles.add(`WEBVTT

00:00.100 --> 00:00.900
Hildy!

00:01.500 --> 00:02.500
Spanning the boundary

00:03.000 --> 00:03.500
Last one
`);

	if (forcedSubtitles) {
		await forcedSubtitles.add('WEBVTT\n\n00:00.100 --> 00:00.900\nForced cue\n');
	}

	await output.finalize();

	return files;
};

test('Subtitles stay in .vtt segments when the media segments are fragmented MP4', async () => {
	// CMAF segments also declare `webvtt` support (as ISOBMFF `wvtt`), so format deduction has a real
	// tie to break here, unlike the MPEG-TS case where WebVTT is the only candidate.
	const files = await setUpSubtitleEnvironment({ segmentFormat: new CmafOutputFormat() });

	const vttPaths = [...files.keys()].filter(p => p.endsWith('.vtt'));
	expect(vttPaths.length).toBeGreaterThanOrEqual(2);
	expect(files.get(vttPaths[0]!)!).toContain('WEBVTT');
});

test('Subtitle segmentation', async () => {
	const files = await setUpSubtitleEnvironment();

	const vttPaths = [...files.keys()].filter(p => p.endsWith('.vtt')).sort();
	expect(vttPaths.length).toBeGreaterThanOrEqual(2);

	const first = files.get(vttPaths[0]!)!;
	const second = files.get(vttPaths[1]!)!;

	// The cue crosses the 2s segment boundary, so both segments must carry it
	expect(first).toContain('Spanning the boundary');
	expect(second).toContain('Spanning the boundary');
	expect(first).toContain('00:00:01.500 --> 00:00:02.500');
	expect(second).toContain('00:00:01.500 --> 00:00:02.500');

	// Cues that don't overlap a segment stay out of it, in both directions
	expect(first).toContain('Hildy!');
	expect(second).not.toContain('Hildy!');
	expect(first).not.toContain('Last one');
	expect(second).toContain('Last one');

	// The timestamp map anchors each segment's cues to the media timeline
	expect(first).toContain('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n');
	expect(second).toContain('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:02.000,MPEGTS:180000\n');

	const subtitlePlaylist = [...files.entries()]
		.find(([, text]) => text.includes('.vtt'))![1];
	expect(subtitlePlaylist).toContain('#EXTM3U');
	for (const vttPath of vttPaths) {
		expect(subtitlePlaylist).toContain(vttPath);
	}
	expect(subtitlePlaylist).toContain('#EXT-X-ENDLIST');
});

test('Subtitle signalling in the master playlist', async () => {
	const files = await setUpSubtitleEnvironment();
	const master = files.get('master.m3u8')!;

	expect(master).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles"');
	expect(master).toContain('LANGUAGE="eng"');
	expect(master).toContain('NAME="English"');
	expect(master).toMatch(/#EXT-X-STREAM-INF:[^\n]*,SUBTITLES="subtitles"/);
	// wvtt is not an RFC-6381 codec a player can act on; it must not leak into CODECS
	expect(master).not.toContain('webvtt');
});

test('Subtitle signalling in the DASH manifest', async () => {
	const files = await setUpSubtitleEnvironment({ dash: true });
	const mpd = files.get('master.mpd')!;

	expect(mpd).toContain('contentType="text"');
	expect(mpd).toContain('mimeType="text/vtt"');
	expect(mpd).toContain('lang="en"');
	expect(mpd).toMatch(/media="[^"]*\.vtt"/);
});

test('A forced subtitle rendition is marked forced in both manifests, and an ordinary one is not', async () => {
	// Asserted as a distinction rather than a presence: a writer that marked every subtitle forced would
	// pass a one-sided check and leave the flag meaningless.
	const files = await setUpSubtitleEnvironment({ dash: true, forced: true });
	const master = files.get('') ?? files.get('master.m3u8');
	const mpd = files.get('master.mpd')!;
	assert(master);

	const mediaLines = master.split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
	expect(mediaLines).toHaveLength(2);
	expect(mediaLines.filter(line => line.includes('FORCED=YES'))).toHaveLength(1);

	// Two separate text AdaptationSets: merged into one, the roles would describe the same set and a
	// player could not tell which representation is the forced one.
	const textSets = mpd.match(/<AdaptationSet[^>]*contentType="text"/g) ?? [];
	expect(textSets).toHaveLength(2);
	expect(mpd.match(/value="forced-subtitle"/g) ?? []).toHaveLength(1);
	expect(mpd.match(/value="subtitle"/g) ?? []).toHaveLength(2);
});

test('Subtitle tracks that cannot be segmented are refused', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());

	// Refused when the track is added, not once the output starts: the format declares it takes no
	// subtitle tracks in single-file mode, since WebVTT cannot be addressed via byte ranges.
	// The error must name `singleFilePerPlaylist`, not just the format: the same segment format accepts
	// subtitle tracks when segmented, so "does not support subtitle tracks" alone sends readers elsewhere.
	expect(() => output.addSubtitleTrack(new TextSubtitleSource('webvtt')))
		.toThrow(/subtitle tracks\..*singleFilePerPlaylist/);

	const subtitleOnly = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
		target: new PathedTarget('', () => new NullTarget()),
	});

	subtitleOnly.addSubtitleTrack(new TextSubtitleSource('webvtt'));

	await expect(subtitleOnly.start()).rejects.toThrow(/at least one video or audio track/);
});

const setUpTtmlEnvironment = async (
	options: {
		dash?: boolean;
		forced?: boolean;
		singleFilePerPlaylist?: boolean;
		segmentFormat?: OutputFormat;
	} = {},
) => {
	const files = new Map<string, Uint8Array>();
	const shared: HlsOutputFormatOptions = {
		segmentFormat: options.segmentFormat ?? new CmafOutputFormat(),
		targetDuration: 2,
		singleFilePerPlaylist: options.singleFilePerPlaylist,
	};

	const output = new Output({
		format: options.dash
			? new AdaptiveOutputFormat({
				formats: [
					new HlsOutputFormat({ ...shared }),
					new DashOutputFormat({ ...shared, mpdPath: 'master.mpd' }),
				],
			})
			: new HlsOutputFormat(shared),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	const video = videoSource();
	output.addVideoTrack(video);

	const subtitles = new SubtitleCueSource('ttml');
	output.addSubtitleTrack(subtitles, { languageCode: 'eng', name: 'English' });
	const forcedSubtitles = options.forced ? new SubtitleCueSource('ttml') : null;
	if (forcedSubtitles) {
		output.addSubtitleTrack(forcedSubtitles, {
			languageCode: 'eng',
			name: 'Forced',
			disposition: { forced: true },
		});
	}

	await output.start();

	for (const timestamp of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
		await video.add(
			new EncodedPacket(avcPacketData, timestamp % 2 === 0 ? 'key' : 'delta', timestamp, 0.5),
			avcMetadata,
		);
	}

	await subtitles.add({ timestamp: 0.1, duration: 0.8, text: 'Hildy!' });
	await subtitles.add({ timestamp: 1.5, duration: 1, text: 'Spanning the boundary' });
	await subtitles.add({ timestamp: 3, duration: 0.5, text: 'Last one' });

	if (forcedSubtitles) {
		await forcedSubtitles.add({ timestamp: 0.1, duration: 0.8, text: 'Forced cue' });
	}

	await output.finalize();

	return files;
};

const decoded = (files: Map<string, Uint8Array>, path: string) => new TextDecoder().decode(files.get(path));

// XMLSubtitleSampleEntry: six reserved bytes, a data reference index of 1, then the namespace followed by
// an empty schema location and an empty auxiliary MIME type list. Byte-for-byte what livesim2 writes.
// The leading 44-byte box size is part of the pin: without it, a dropped string terminator still matches,
// because the box that follows begins with a zero byte of its own.
const NUL = '\u0000';
const STPP_SAMPLE_ENTRY = `${NUL.repeat(3)},stpp${NUL.repeat(6)}${NUL}\u0001${TTML_NAMESPACE}${NUL.repeat(3)}`;

// A subtitle segment is the one holding a TTML document; the init segment states the namespace in its
// sample entry but holds no document.
const ttmlFiles = (files: Map<string, Uint8Array>) => {
	const entries = [...files.entries()]
		.map(([path, bytes]) => [path, new TextDecoder().decode(bytes)] as const)
		.filter(([, text]) => text.includes(TTML_NAMESPACE));

	return {
		segments: entries.filter(([, text]) => text.includes('<tt ')).sort(([a], [b]) => a.localeCompare(b)),
		inits: entries.filter(([, text]) => !text.includes('<tt ')),
	};
};

test('A TTML rendition is written as fragmented MP4 with an stpp sample entry', async () => {
	const files = await setUpTtmlEnvironment();
	const { segments, inits } = ttmlFiles(files);

	expect(inits).toHaveLength(1);
	const [initPath, initText] = inits[0]!;

	// The sample entry, not just the codec name: `stpp` is what the CODECS attribute below promises.
	expect(initText).toContain('stpp');
	expect(initText).not.toContain('wvtt');
	// XMLSubtitleSampleEntry states the namespace, then two empty strings.
	expect(initText).toContain(STPP_SAMPLE_ENTRY);

	expect(segments.length).toBeGreaterThanOrEqual(2);
	for (const [, text] of segments) {
		expect(text).toContain('moof');
		expect(text).toContain('<tt ');
	}

	// The rendition is fMP4, so the playlist points at an init segment rather than at raw text segments.
	const subtitlePlaylist = [...files.keys()].find(p => decoded(files, p).includes(initPath.split('/').pop()!)
		&& decoded(files, p).includes('#EXTM3U'))!;
	expect(decoded(files, subtitlePlaylist)).toContain('#EXT-X-MAP:URI=');
	expect([...files.keys()].some(p => p.endsWith('.vtt'))).toBe(false);
});

const boxPayload = (bytes: Uint8Array, type: string) => {
	const needle = [...type].map(character => character.charCodeAt(0));
	const start = bytes.findIndex((_, i) => needle.every((byte, j) => bytes[i + j] === byte));
	assert(start !== -1);

	return new DataView(bytes.buffer, bytes.byteOffset + start + 4);
};

// Where the segment claims to sit on the media timeline, in the track's timescale of 1000.
const baseMediaDecodeTime = (bytes: Uint8Array) => {
	const view = boxPayload(bytes, 'tfdt');
	return view.getUint8(0) === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4);
};

// How long the segment's samples claim to last, in the same timescale.
const defaultSampleDuration = (bytes: Uint8Array) => {
	const view = boxPayload(bytes, 'tfhd');
	const flags = view.getUint32(0) & 0xffffff;
	assert((flags & 0x8) !== 0); // A default sample duration is present

	let offset = 8; // Version, flags and track ID
	offset += (flags & 0x1) ? 8 : 0; // Base data offset
	offset += (flags & 0x2) ? 4 : 0; // Sample description index

	return view.getUint32(offset);
};

test('TTML segmentation repeats a cue spanning a boundary', async () => {
	const files = await setUpTtmlEnvironment();
	const { segments } = ttmlFiles(files);

	const first = segments[0]![1];
	const second = segments[1]![1];

	// Each segment's samples sit where the segment does; a document is worthless if the fragment claims
	// the wrong time for it.
	expect(baseMediaDecodeTime(files.get(segments[0]![0])!)).toBe(0);
	expect(baseMediaDecodeTime(files.get(segments[1]![0])!)).toBe(2000);

	// One document per segment, lasting exactly as long as the segment it was cut for.
	expect(defaultSampleDuration(files.get(segments[0]![0])!)).toBe(2000);

	// The cue crosses the 2s segment boundary, so both segments must carry it
	expect(first).toContain('Spanning the boundary');
	expect(second).toContain('Spanning the boundary');
	expect(first).toContain('begin="00:00:01.500" end="00:00:02.500"');
	expect(second).toContain('begin="00:00:01.500" end="00:00:02.500"');

	// Cues that don't overlap a segment stay out of it, in both directions
	expect(first).toContain('Hildy!');
	expect(second).not.toContain('Hildy!');
	expect(first).not.toContain('Last one');
	expect(segments.some(([, text]) => text.includes('Last one'))).toBe(true);

	// Timing is stated on the media timeline, which is what `ttp:timeBase="media"` declares.
	expect(first).toContain('ttp:timeBase="media"');
	expect(first).toContain('xml:lang="en"');
});

test('TTML signalling in the master playlist and the DASH manifest', async () => {
	const files = await setUpTtmlEnvironment({ dash: true });
	const master = decoded(files, 'master.m3u8');
	const mpd = decoded(files, 'master.mpd');

	expect(master).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles"');
	// The bytes are `stpp`, so the manifests must say `stpp` and nothing else.
	expect(master).toMatch(/#EXT-X-STREAM-INF:[^\n]*CODECS="[^"]*,stpp"/);
	expect(master).not.toContain('ttml');

	expect(mpd).toContain('contentType="text"');
	expect(mpd).toContain('mimeType="application/mp4"');
	expect(mpd).toContain('codecs="stpp"');
	expect(mpd).not.toContain('text/vtt');
	expect(mpd).toContain('lang="en"');
});

test('A forced TTML rendition is marked forced in both manifests, and an ordinary one is not', async () => {
	const files = await setUpTtmlEnvironment({ dash: true, forced: true });
	const master = decoded(files, 'master.m3u8');
	const mpd = decoded(files, 'master.mpd');

	const mediaLines = master.split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
	expect(mediaLines).toHaveLength(2);
	expect(mediaLines.filter(line => line.includes('FORCED=YES'))).toHaveLength(1);

	expect(mpd.match(/value="forced-subtitle"/g) ?? []).toHaveLength(1);
	expect(mpd.match(/value="subtitle"/g) ?? []).toHaveLength(2);
});

test('A TTML rendition is byte-range addressed in single-file mode, where a WebVTT one is refused', async () => {
	const singleFile = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	singleFile.addVideoTrack(videoSource());

	// Refused on the codec, not on the track type: fragmented MP4 can be byte-range addressed, raw
	// WebVTT text cannot, and the error has to name that constraint.
	expect(() => singleFile.addSubtitleTrack(new TextSubtitleSource('webvtt')))
		.toThrow(/subtitle tracks\..*singleFilePerPlaylist/);
	expect(() => singleFile.addSubtitleTrack(new SubtitleCueSource('ttml'))).not.toThrow();

	const files = await setUpTtmlEnvironment({ singleFilePerPlaylist: true });
	const { segments } = ttmlFiles(files);

	// One file carries the init segment and every media segment, addressed by byte ranges.
	expect(segments).toHaveLength(1);
	const [segmentsPath, segmentsText] = segments[0]!;
	expect(segmentsText).toContain(STPP_SAMPLE_ENTRY);
	expect(segmentsText).toContain('Spanning the boundary');
	expect(segmentsText).toContain('Last one');

	const subtitlePlaylist = [...files.values()]
		.map(bytes => new TextDecoder().decode(bytes))
		.find(text => text.includes('#EXT-X-MAP:URI=') && text.includes(segmentsPath.split('/').pop()!))!;

	expect(subtitlePlaylist).toMatch(/#EXT-X-MAP:URI="[^"]*",BYTERANGE="\d+@0"/);
	expect(subtitlePlaylist.match(/#EXT-X-BYTERANGE:\d+@\d+/g) ?? []).toHaveLength(2);
});

// The `<Representation>` of the subtitle rendition, which is the one adaptation set of type `text`.
const textRepresentation = (mpd: string) => {
	const set = /<AdaptationSet[^>]*contentType="text"[\s\S]*?<\/AdaptationSet>/.exec(mpd)?.[0];
	assert(set);
	return set;
};

const fileNamed = (files: Map<string, Uint8Array>, fileName: string) => {
	const key = [...files.keys()].find(candidate => candidate.endsWith(fileName));
	assert(key);
	return files.get(key)!;
};

// A segment format whose init goes into the file rather than into a separate init target, plus room for
// an index: the only way to ask for `<SegmentBase indexRange>`, since CMAF rejects `sidxFragmentCapacity`.
const indexedSegmentFormat = () => new Mp4OutputFormat({ fastStart: 'fragmented', sidxFragmentCapacity: 64 });

test('An indexed single-file TTML representation states an init and an index the bytes back up', async () => {
	const files = await setUpTtmlEnvironment({
		dash: true,
		singleFilePerPlaylist: true,
		segmentFormat: indexedSegmentFormat(),
	});

	const representation = textRepresentation(decoded(files, 'master.mpd'));
	expect(representation).toContain('codecs="stpp"');

	const fileName = /<BaseURL>([^<]+)<\/BaseURL>/.exec(representation)?.[1];
	const initEnd = /<Initialization range="0-(\d+)"\/>/.exec(representation)?.[1];
	const indexRange = /indexRange="(\d+)-(\d+)"/.exec(representation);
	assert(fileName && initEnd && indexRange);

	const boxes = readTopLevelBoxes(fileNamed(files, fileName));

	// One file, one init: a concatenation that repeated `moov` per segment would not be a playable fMP4,
	// and no single init range could describe it.
	expect(boxes.filter(box => box.name === 'moov')).toHaveLength(1);
	expect(boxes.filter(box => box.name === 'moof').length).toBeGreaterThan(1);

	// The init range is exactly everything up to the first fragment.
	const firstMoof = boxes.find(box => box.name === 'moof');
	assert(firstMoof);
	expect(Number(initEnd) + 1).toBe(firstMoof.start);

	// The index range is exactly the `sidx` box, not merely a range that overlaps it.
	const sidx = boxes.find(box => box.name === 'sidx');
	assert(sidx);
	expect([Number(indexRange[1]), Number(indexRange[2])]).toEqual([sidx.start, sidx.start + sidx.size - 1]);
});

test('An indexed single-file TTML rendition puts every HLS byte range on a fragment', async () => {
	const files = await setUpTtmlEnvironment({
		singleFilePerPlaylist: true,
		segmentFormat: indexedSegmentFormat(),
	});

	const { segments } = ttmlFiles(files);
	expect(segments).toHaveLength(1);
	const [segmentsPath] = segments[0]!;
	const bytes = fileNamed(files, segmentsPath);
	const boxes = readTopLevelBoxes(bytes);

	const playlist = [...files.values()]
		.map(file => new TextDecoder().decode(file))
		.find(text => text.includes('#EXT-X-MAP:URI=') && text.includes(segmentsPath.split('/').pop()!));
	assert(playlist);

	// The map range ends where the first fragment begins, and every segment range starts on a `moof`.
	const map = /#EXT-X-MAP:URI="[^"]*",BYTERANGE="(\d+)@0"/.exec(playlist);
	assert(map);
	const moofStarts = boxes.filter(box => box.name === 'moof').map(box => box.start);
	expect(Number(map[1])).toBe(moofStarts[0]);

	const ranges = [...playlist.matchAll(/#EXT-X-BYTERANGE:(\d+)@(\d+)/g)]
		.map(([, length, offset]) => ({ length: Number(length), offset: Number(offset) }));
	expect(ranges.map(range => range.offset)).toEqual(moofStarts);
	for (const range of ranges) {
		expect(range.length).toBeGreaterThan(0);
		expect(range.offset + range.length).toBeLessThanOrEqual(bytes.length);
	}
});

test('A listed single-file TTML representation states an init range the bytes back up', async () => {
	const files = await setUpTtmlEnvironment({ dash: true, singleFilePerPlaylist: true });

	const representation = textRepresentation(decoded(files, 'master.mpd'));
	// No index was asked for, so the subsegments are listed rather than pointed at.
	expect(representation).toContain('<SegmentList');
	expect(representation).not.toContain('indexRange');

	const fileName = /<BaseURL>([^<]+)<\/BaseURL>/.exec(representation)?.[1];
	const initEnd = /<Initialization range="0-(\d+)"\/>/.exec(representation)?.[1];
	assert(fileName && initEnd);

	const boxes = readTopLevelBoxes(fileNamed(files, fileName));
	expect(boxes.filter(box => box.name === 'moov')).toHaveLength(1);

	// CMAF writes the init once and then a `styp` per segment, so the init ends where the first one does.
	const firstStyp = boxes.find(box => box.name === 'styp');
	assert(firstStyp);
	expect(Number(initEnd) + 1).toBe(firstStyp.start);
});

test('A WebVTT track is refused under singleFilePerPlaylist whatever the segment format', async () => {
	for (const format of [
		new HlsOutputFormat({ segmentFormat: indexedSegmentFormat(), singleFilePerPlaylist: true }),
		new DashOutputFormat({
			segmentFormat: indexedSegmentFormat(),
			singleFilePerPlaylist: true,
			mpdPath: 'master.mpd',
		}),
	]) {
		const output = new Output({ format, target: new PathedTarget('', () => new NullTarget()) });
		output.addVideoTrack(videoSource());

		expect(() => output.addSubtitleTrack(new TextSubtitleSource('webvtt')))
			.toThrow(/subtitle tracks\..*singleFilePerPlaylist/);
		expect(() => output.addSubtitleTrack(new SubtitleCueSource('ttml'))).not.toThrow();
	}
});

test('Text subtitle sources refuse a codec they cannot parse', async () => {
	expect(() => new TextSubtitleSource('ttml')).toThrow(/cannot be parsed from text/);
});

// The DOM's color space enums predate BT.2100, so PQ and HLG have to be cast in.
const colorSpaceWith = (transfer: string, primaries: string, matrix: string) => ({
	primaries,
	transfer,
	matrix,
	fullRange: false,
} as unknown as VideoColorSpaceInit);

const setUpColorEnvironment = async (colorSpace: VideoColorSpaceInit | undefined) => {
	const files = new Map<string, string>();
	const shared = { segmentFormat: new CmafOutputFormat(), targetDuration: 2 } as const;

	const output = new Output({
		format: new AdaptiveOutputFormat({
			formats: [
				new HlsOutputFormat({ ...shared }),
				new DashOutputFormat({ ...shared, mpdPath: 'master.mpd' }),
			],
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new TextDecoder().decode(target.buffer!)));
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 1), {
		decoderConfig: { ...avcMetadata.decoderConfig!, colorSpace },
	});
	await output.finalize();

	return files;
};

describe('Colour signalling in the manifests', () => {
	test('PQ video is labelled VIDEO-RANGE=PQ and carries the BT.2100 CICP codes', async () => {
		const files = await setUpColorEnvironment(colorSpaceWith('pq', 'bt2020', 'bt2020-ncl'));

		expect(files.get('master.m3u8')).toMatch(/#EXT-X-STREAM-INF:[^\n]*,VIDEO-RANGE=PQ/);

		const mpd = files.get('master.mpd')!;
		expect(mpd).toContain('schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="16"');
		expect(mpd).toContain('schemeIdUri="urn:mpeg:mpegB:cicp:ColourPrimaries" value="9"');
		expect(mpd).toContain('schemeIdUri="urn:mpeg:mpegB:cicp:MatrixCoefficients" value="9"');
	});

	test('HLG video is labelled VIDEO-RANGE=HLG', async () => {
		const files = await setUpColorEnvironment(colorSpaceWith('hlg', 'bt2020', 'bt2020-ncl'));

		expect(files.get('master.m3u8')).toMatch(/#EXT-X-STREAM-INF:[^\n]*,VIDEO-RANGE=HLG/);
		expect(files.get('master.mpd')).toContain(
			'schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="18"',
		);
	});

	test('BT.709 video is labelled VIDEO-RANGE=SDR', async () => {
		const files = await setUpColorEnvironment(colorSpaceWith('bt709', 'bt709', 'bt709'));

		expect(files.get('master.m3u8')).toMatch(/#EXT-X-STREAM-INF:[^\n]*,VIDEO-RANGE=SDR/);
		expect(files.get('master.mpd')).toContain(
			'schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="1"',
		);
	});

	// An absent VIDEO-RANGE already implies SDR, so unknown colour is left unstated rather than
	// asserted as SDR — a wrong label and a missing one are not the same thing.
	test('Video with no colour information is left unlabelled', async () => {
		const files = await setUpColorEnvironment(undefined);

		expect(files.get('master.m3u8')).toContain('#EXT-X-STREAM-INF:');
		expect(files.get('master.m3u8')).not.toContain('VIDEO-RANGE');
		expect(files.get('master.mpd')).not.toContain('urn:mpeg:mpegB:cicp:');
	});
});

test('An error thrown while closing a track reaches finalize() instead of going unhandled', async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', onUnhandled);

	try {
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented', sidxFragmentCapacity: 1 }),
				singleFilePerPlaylist: true,
			}),
			target: new PathedTarget('', () => new NullTarget()),
		});

		const source = videoSource();
		output.addVideoTrack(source);

		await output.start();

		await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
		await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
		await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
		await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);

		source.close();

		// Give an escaping rejection the turns it needs to be reported before anything awaits the close.
		await new Promise(resolve => setTimeout(resolve, 50));

		await expect(output.finalize()).rejects.toThrow(/sidxFragmentCapacity/);

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(unhandled).toEqual([]);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('Live mode, the MPD is dynamic and follows the sliding window', async () => {
	let mpd = '';

	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			live: true,
			maxLiveSegmentCount: 5,
			mpdPath: 'm.mpd',
			onMpd: content => void (mpd = content),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	for (let i = 0; i < 40; i++) {
		await source.add(
			new EncodedPacket(avcPacketData, i % 2 === 0 ? 'key' : 'delta', i * 0.5, 0.5),
			avcMetadata,
		);
	}

	await output.finalize();

	expect(mpd).toContain('type="dynamic"');
	expect(mpd).toContain('availabilityStartTime="');
	expect(mpd).toContain('minimumUpdatePeriod="PT1S"');
	expect(mpd).toContain('timeShiftBufferDepth="PT5S"');

	// The window slid: the MPD names the live edge, not the segments already dropped.
	expect(Number(/startNumber="(\d+)"/.exec(mpd)?.[1])).toBeGreaterThan(1);
	expect(Number(/<S t="(\d+)"/.exec(mpd)?.[1])).toBeGreaterThan(0);
});

test('Live mode, the DVR window is what the playlist holds, not a nominal product', async () => {
	let mpd = '';

	const output = new Output({
		format: new DashOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 2,
			live: true,
			maxLiveSegmentCount: 5,
			mpdPath: 'm.mpd',
			onMpd: content => void (mpd = content),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	// A ragged encode tail: mostly full GOPs, every seventh packet a runt.
	let timestamp = 0;
	for (let i = 0; i < 60; i++) {
		const duration = i % 7 === 6 ? 0.008 : 0.5;
		await source.add(
			new EncodedPacket(avcPacketData, i % 4 === 0 ? 'key' : 'delta', timestamp, duration),
			avcMetadata,
		);
		timestamp += duration;
	}

	await output.finalize();

	const windowSeconds = Number(/timeShiftBufferDepth="PT([\d.]+)S"/.exec(mpd)?.[1]);
	const longest = Math.max(...[...mpd.matchAll(/<S [^>]*d="(\d+)"/g)].map(m => Number(m[1]) / 90_000));

	expect(windowSeconds).toBeGreaterThan(0);
	expect(windowSeconds).toBeLessThan(5 * longest);
});

test('Live mode, BANDWIDTH keeps tracking the window after it fills', async () => {
	const masters: string[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			onMaster: content => void masters.push(content),
		}),
		target: new PathedTarget('master.m3u8', () => new NullTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	// Every segment is one key packet; the later ones carry far more data, so a window that is
	// still being measured must report a rising bitrate.
	for (let i = 0; i < 8; i++) {
		const payload = new Uint8Array(avcPacketData.length + i * 4096);
		payload.set(avcPacketData);
		await source.add(new EncodedPacket(payload, 'key', i * 2, 2), avcMetadata);
	}

	await output.finalize();

	const bandwidths = masters
		.map(master => Number(/BANDWIDTH=(\d+)/.exec(master)?.[1]))
		.filter(value => Number.isFinite(value));

	// The window fills at the second segment; every master written after that must still move.
	expect(bandwidths.length).toBeGreaterThan(4);
	expect(bandwidths.at(-1)!).toBeGreaterThan(bandwidths[1]!);
});

test('Low-latency DASH makes a segment available once its longest part could be complete', async () => {
	const encode = async (lowLatencyDashMode: boolean) => {
		const longestPartByPlaylist = new Map<number, number>();
		let mpd = '';

		const output = new Output({
			format: new DashOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				targetDuration: 2,
				partDuration: 0.5,
				mpdPath: 'manifest.mpd',
				mpdParams: { lowLatencyDashMode },
				onMpd: (content) => {
					mpd = content;
				},
				onSegment: (_, info) => {
					for (const part of info.parts ?? []) {
						const n = info.playlist.n;
						longestPartByPlaylist.set(n, Math.max(longestPartByPlaylist.get(n) ?? 0, part.duration));
					}
				},
			}),
			target: new PathedTarget('', () => new BufferTarget()),
		});

		const video = videoSource();
		const audio = audioSource();
		output.addVideoTrack(video);
		output.addAudioTrack(audio);
		await output.start();

		await feedVideoAndAudio(video, audio);
		await output.finalize();

		return { mpd, longestPartByPlaylist };
	};

	const lowLatency = await encode(true);
	expect(lowLatency.longestPartByPlaylist.size).toBeGreaterThan(0);

	const offsets = [...lowLatency.mpd.matchAll(/availabilityTimeOffset="([\d.]+)"/g)].map(m => Number(m[1]));
	const expected = [...lowLatency.longestPartByPlaylist.values()].map(longest => 2 - longest);
	expect(offsets.sort()).toEqual(expected.map(x => Number(x.toFixed(6))).sort());
	expect(lowLatency.mpd).toContain('availabilityTimeComplete="false"');

	const regular = await encode(false);
	expect(regular.mpd).not.toContain('availabilityTimeOffset');
	expect(regular.mpd).not.toContain('availabilityTimeComplete');
});

test('Cross-variant timestamps, MPEG-TS', async () => {
	await testCrossVariantTimestamps({
		segmentFormat: new MpegTsOutputFormat(),
	});
});

test('Cross-variant timestamps, CMAF', async () => {
	await testCrossVariantTimestamps({
		segmentFormat: new CmafOutputFormat(),
	});
});

const testCrossVariantTimestamps = async (hlsOptions: HlsOutputFormatOptions) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat(hlsOptions),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	// The groups aren't paired, so the tracks land in different variant streams
	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video, { group: new OutputTrackGroup() });
	output.addAudioTrack(audio, { group: new OutputTrackGroup() });

	await output.start();

	// Video starts at 1 second, audio half a second earlier
	for (let i = 0; i < 8; i++) {
		const type = i % 4 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, 1 + 0.5 * i, 0), avcMetadata);
		await audio.add(new EncodedPacket(aacPacketData, 'key', 0.5 + 0.5 * i, 0), aacMetadata);
	}

	await output.finalize();

	// Read the entire output back using the HLS input
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
	expect(videoTrack).toBeTruthy();
	const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
	expect(audioTrack).toBeTruthy();
	expect(await audioTrack.getPairableVideoTracks()).toHaveLength(0);

	const videoTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		videoTimestamps.push(packet.timestamp);
	}

	const audioTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		audioTimestamps.push(packet.timestamp);
	}

	// The video is the reference, so its first packet lands at 0
	expect(videoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
	expect(audioTimestamps).toEqual([-0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3]);
};

test('PRIV timestamps in packed audio segments, ADTS', async () => {
	await testPackedAudioPrivTimestamps('sample3.aac', new AdtsOutputFormat());
});

test('PRIV timestamps in packed audio segments, MP3', async () => {
	await testPackedAudioPrivTimestamps('Toothsome-Meme.VBRv2.mp3', new Mp3OutputFormat());
});

test('PRIV timestamps in packed audio segments, WAV', async () => {
	await testPackedAudioPrivTimestamps('glitch-hop-is-dead.wav', new WavOutputFormat({ metadataFormat: 'id3' }));
});

const testPackedAudioPrivTimestamps = async (
	fileName: string,
	segmentFormat: HlsOutputFormatOptions['segmentFormat'],
) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	using sourceInput = new Input({
		source: new FilePathSource(`./test/public/${fileName}`),
		formats: ALL_FORMATS,
	});
	const sourceTrack = await sourceInput.getPrimaryAudioTrack();
	assert(sourceTrack);
	const sourceCodec = await sourceTrack.getCodec();
	assert(sourceCodec);
	const decoderConfig = await sourceTrack.getDecoderConfig();
	assert(decoderConfig);

	const source = new EncodedAudioPacketSource(sourceCodec);
	output.addAudioTrack(source);

	await output.start();

	const sourceTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		sourceTimestamps.push(packet.timestamp);
		await source.add(packet, { decoderConfig });
	}

	await output.finalize();

	// Every segment must start with a PRIV frame holding the timestamp of its first sample, on the 90 kHz MPEG-TS
	// clock and offset by the default media timestamp offset of 10 seconds
	const owner = 'com.apple.streaming.transportStreamTimestamp';
	const playlistLines = new TextDecoder().decode(targets.get('playlist-1.m3u8')!.buffer!).split('\n');
	let segmentStart = 0;
	let segmentCount = 0;

	for (let i = 0; i < playlistLines.length; i++) {
		const line = playlistLines[i]!;
		if (!line.startsWith('#EXTINF:')) {
			continue;
		}

		const segmentTarget = targets.get(playlistLines[i + 1]!);
		assert(segmentTarget);

		using segmentInput = new Input({
			source: new BufferSource(segmentTarget.buffer!),
			formats: ALL_FORMATS,
		});
		const priv = (await segmentInput.getMetadataTags()).raw?.['PRIV'];
		assert(priv instanceof Uint8Array);

		expect(priv.length).toBe(owner.length + 1 + 8);
		expect(new TextDecoder().decode(priv.subarray(0, owner.length))).toBe(owner);
		expect(priv[owner.length]).toBe(0);

		const view = new DataView(priv.buffer, priv.byteOffset, priv.byteLength);
		const timestampHigh = view.getUint32(owner.length + 1);
		const timestampLow = view.getUint32(owner.length + 5);
		expect((2 ** 32 * timestampHigh + timestampLow) / 90_000 - 10).toBeCloseTo(segmentStart, 4);

		segmentStart += Number(line.slice('#EXTINF:'.length, line.indexOf(',')));
		segmentCount++;
	}

	expect(segmentCount).toBeGreaterThan(1);

	// Read the entire output back using the HLS input
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		timestamps.push(packet.timestamp);
	}

	// HLS normalizes the first packet to zero, including MP3's negative priming timestamp.
	expect(timestamps).toHaveLength(sourceTimestamps.length);
	for (let i = 0; i < timestamps.length; i++) {
		expect(timestamps[i]).toBeCloseTo(sourceTimestamps[i]! - sourceTimestamps[0]!, 10);
	}
};

test('Timestamp wraparound, MPEG-TS', async () => {
	await testTimestampWraparound(new MpegTsOutputFormat(), false);
});

test('Timestamp wraparound, MPEG-TS with PDT', async () => {
	await testTimestampWraparound(new MpegTsOutputFormat(), true);
});

test('Timestamp wraparound, CMAF', async () => {
	await testTimestampWraparound(new CmafOutputFormat(), false);
});

const testTimestampWraparound = async (
	segmentFormat: HlsOutputFormatOptions['segmentFormat'],
	isRelativeToUnixEpoch: boolean,
) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat,
			// Start the media 80 seconds before the 33-bit wraparound of the 90 kHz clock, far enough out so the
			// demuxer won't interpret the first timestamp as negative
			mediaTimestampBase: 2 ** 33 / 90_000 - 80,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source, { isRelativeToUnixEpoch });

	await output.start();

	const start = isRelativeToUnixEpoch ? Date.parse('2026-01-01T00:00:00Z') / 1000 : 0;
	const packetCount = 240;
	for (let i = 0; i < packetCount; i++) {
		const type = i % 4 === 0 ? 'key' : 'delta';
		await source.add(new EncodedPacket(avcPacketData, type, start + 0.5 * i, 0.5), avcMetadata);
	}

	await output.finalize();

	const playlist = new TextDecoder().decode(targets.get('playlist-1.m3u8')!.buffer!);
	expect(playlist.includes('#EXT-X-PROGRAM-DATE-TIME')).toBe(isRelativeToUnixEpoch);

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}

	// The reference's first packet lands at 0, or at its Unix time with PDT
	expect(timestamps).toHaveLength(packetCount);
	for (let i = 0; i < packetCount; i++) {
		expect(timestamps[i]).toBeCloseTo(start + 0.5 * i, 4);
	}
};

// A consumer that uploads a segment has to be able to slow the pipeline down, or it must buffer without
// bound and drop to stay within memory. The callbacks are declared `=> unknown`, so returning a promise
// was always expressible; it just wasn't awaited.
test('a slow onSegment holds the pipeline, and onInit is awaited before the first segment', async () => {
	const order: string[] = [];
	let releaseInit: (() => void) | undefined;
	let releaseSegment: (() => void) | undefined;

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			onInit: () => {
				order.push('onInit:start');
				return new Promise<void>((resolve) => {
					releaseInit = () => {
						order.push('onInit:end');
						resolve();
					};
				});
			},
			onSegment: () => {
				order.push('onSegment:start');
				return new Promise<void>((resolve) => {
					releaseSegment = () => {
						order.push('onSegment:end');
						resolve();
					};
				});
			},
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 4; i++) {
		await source.add(new EncodedPacket(avcPacketData, i === 0 ? 'key' : 'delta', i * 0.5, 0.5), avcMetadata);
	}

	// Starting the second segment finalizes the first, which is what fires onSegment.
	const adding = source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);
	await new Promise(resolve => setTimeout(resolve, 100));

	// Init came first and is still outstanding, so nothing has announced a segment yet.
	expect(order).toEqual(['onInit:start']);

	releaseInit!();
	await new Promise(resolve => setTimeout(resolve, 100));
	expect(order).toEqual(['onInit:start', 'onInit:end', 'onSegment:start']);

	// And the write is still waiting on the consumer.
	let settled = false;
	void adding.then(() => (settled = true));
	await new Promise(resolve => setTimeout(resolve, 100));
	expect(settled, 'the pipeline ran ahead of a consumer that had not finished').toBe(false);

	releaseSegment!();
	await adding;
	expect(order).toEqual(['onInit:start', 'onInit:end', 'onSegment:start', 'onSegment:end']);

	await output.cancel();
}, 30_000);

test('isLast marks exactly one segment per playlist, including a multi-segment finalize', async () => {
	const segmentInfos: HlsOutputSegmentInfo[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 2,
			onSegment: (_, info) => segmentInfos.push({ ...info }),
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const video = videoSource();
	const audio = audioSource();
	// Separate groups, so video and audio get a playlist each: the point is that they resolve independently.
	output.addVideoTrack(video, { group: new OutputTrackGroup() });
	output.addAudioTrack(audio, { group: new OutputTrackGroup() });
	await output.start();

	const frameDuration = 1 / 25;
	const audioFrameDuration = 1024 / 44100;
	let audioTimestamp = 0;
	for (let i = 0; i < 125; i++) {
		const timestamp = i * frameDuration;
		const type = i % 25 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, timestamp, frameDuration), avcMetadata);

		while (audioTimestamp < timestamp + frameDuration) {
			await audio.add(new EncodedPacket(aacPacketData, 'key', audioTimestamp, audioFrameDuration), aacMetadata);
			audioTimestamp += audioFrameDuration;
		}
	}

	const beforeFinalize = segmentInfos.length;
	await output.finalize();

	const byPlaylist = new Map<number, HlsOutputSegmentInfo[]>();
	for (const info of segmentInfos) {
		const list = byPlaylist.get(info.playlist.n) ?? [];
		list.push(info);
		byPlaylist.set(info.playlist.n, list);
	}
	expect(byPlaylist.size).toBe(2);

	// Segmentation cuts eagerly, so exactly one segment per playlist is ever pending at finalize.
	expect(segmentInfos.length - beforeFinalize).toBe(2);

	for (const [, infos] of byPlaylist) {
		const last = infos.filter(x => x.isLast);
		expect(last).toHaveLength(1);
		expect(last[0]!.n).toBe(Math.max(...infos.map(x => x.n)));
	}
});

test('audio segment starts stay on the target grid over many segments', async () => {
	const targetDuration = 2;
	const playlists = new Map<number, string>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration,
			onPlaylist: (text, info) => playlists.set(info.n, text),
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video, { group: new OutputTrackGroup() });
	output.addAudioTrack(audio, { group: new OutputTrackGroup() });
	await output.start();

	// 48 kHz AAC: 1024 samples is 21.333 ms, which divides 2 s only as 93.75 frames. Cutting at the last
	// frame that fits gives 93 every time, so each segment falls 16 ms short of the grid.
	const audioFrameDuration = 1024 / 48000;
	const frameDuration = 1 / 25;
	const seconds = 130;
	let audioTimestamp = 0;
	for (let i = 0; i < seconds * 25; i++) {
		const timestamp = i * frameDuration;
		const type = i % 50 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, timestamp, frameDuration), avcMetadata);

		while (audioTimestamp < timestamp + frameDuration) {
			await audio.add(new EncodedPacket(aacPacketData, 'key', audioTimestamp, audioFrameDuration), aacMetadata);
			audioTimestamp += audioFrameDuration;
		}
	}
	await output.finalize();

	const durationsOf = (text: string) =>
		[...text.matchAll(/#EXTINF:([0-9.]+)/g)].map(m => Number(m[1]));

	const audioText = [...playlists.values()].find(text => text.includes('.m4a') || !text.includes('.m4v'));
	expect(audioText).toBeDefined();
	const audioDurations = durationsOf(audioText!);
	expect(audioDurations.length).toBeGreaterThanOrEqual(60);

	// Each segment's start is the sum of the durations before it; compare against n * targetDuration.
	const errors: number[] = [];
	let start = 0;
	for (const duration of audioDurations) {
		errors.push(start - Math.round(start / targetDuration) * targetDuration);
		start += duration;
	}

	const worst = Math.max(...errors.map(Math.abs));
	expect(worst).toBeLessThan(audioFrameDuration);

	// And it must not grow: the drift bug shows up as a late half that is far worse than the early half.
	const half = Math.floor(errors.length / 2);
	const firstHalf = Math.max(...errors.slice(0, half).map(Math.abs));
	const lastHalf = Math.max(...errors.slice(half).map(Math.abs));
	expect(lastHalf).toBeLessThan(firstHalf + audioFrameDuration);
}, 180_000);

test('subtitle segments keep being written when the cues stop while the media runs on', async () => {
	const subtitleSegments: number[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 2,
			onSegment: (_, info) => {
				if (info.playlist.tracks[0]!.type === 'subtitle') {
					subtitleSegments.push(info.n);
				}
			},
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const video = videoSource();
	output.addVideoTrack(video);
	const subtitles = new SubtitleCueSource('webvtt');
	output.addSubtitleTrack(subtitles, { languageCode: 'eng', name: 'English' });
	await output.start();

	const frameDuration = 1 / 25;
	const CUES_STOP_AT = 6;

	for (let i = 0; i < 30 * 25; i++) {
		const timestamp = i * frameDuration;
		await video.add(
			new EncodedPacket(avcPacketData, i % 50 === 0 ? 'key' : 'delta', timestamp, frameDuration),
			avcMetadata,
		);

		// The cues simply stop, as a captioner with nothing to say would leave them; never closed.
		if (i % 25 === 0 && timestamp < CUES_STOP_AT) {
			await subtitles.add({ timestamp, duration: 0.8, text: `Cue at ${timestamp}` });
		}
	}

	const beforeFinalize = subtitleSegments.length;
	await output.finalize();

	// A subtitle playlist that stalls at the last cue leaves a player with a text track that falls
	// further behind the media the longer the silence lasts.
	expect(subtitleSegments.length).toBeGreaterThan(10);
	expect(beforeFinalize).toBeGreaterThan(subtitleSegments.length / 2);
}, 180_000);

test.each([
	['separate playlists', true],
	['one shared playlist', false],
])('segments keep being written in %s when an open audio track stops supplying', async (_name, separate) => {
	const segments: number[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 2,
			onSegment: (_, info) => segments.push(info.n),
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const video = videoSource();
	const audio = audioSource();
	if (separate) {
		output.addVideoTrack(video, { group: new OutputTrackGroup() });
		output.addAudioTrack(audio, { group: new OutputTrackGroup() });
	} else {
		// One playlist, so each segment must interleave both tracks and the quiet one is unavoidable.
		output.addVideoTrack(video);
		output.addAudioTrack(audio);
	}
	await output.start();

	const frameDuration = 1 / 25;
	const audioFrameDuration = 1024 / 48000;
	const AUDIO_STOPS_AT = 6;
	let audioTimestamp = 0;

	for (let i = 0; i < 30 * 25; i++) {
		const timestamp = i * frameDuration;
		const type = i % 50 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, timestamp, frameDuration), avcMetadata);

		// Audio simply stops; its source is never closed, as a muted microphone would leave it.
		while (audioTimestamp < timestamp + frameDuration && audioTimestamp < AUDIO_STOPS_AT) {
			await audio.add(new EncodedPacket(aacPacketData, 'key', audioTimestamp, audioFrameDuration), aacMetadata);
			audioTimestamp += audioFrameDuration;
		}
	}

	const beforeFinalize = segments.length;
	await output.finalize();

	// 30 s of video at a 2 s target is about 15 segments per playlist. Nearly all of them must be out
	// before finalize, rather than the video playlist waiting on a track that has gone quiet.
	expect(segments.length).toBeGreaterThan(10);
	expect(beforeFinalize).toBeGreaterThan(segments.length / 2);
}, 180_000);

// Two encoders fed the same media but started at different times disagreed on where an audio segment
// ends: every audio packet is a key packet, so the only thing pinning the cut was a grid anchored to
// each playlist's own first packet. `nextSegmentBoundary` moves that decision to the caller, which is
// what pipeline locking (two encoders cutting at the same timestamps) and splice-accurate cuts need.
describe('nextSegmentBoundary', () => {
	const AUDIO_FRAME_DURATION = 1024 / 48000;

	/** Audio-only HLS, fed AAC frames from `startTimestamp` to `endTimestamp` on one shared timeline. */
	const audioBoundaries = async (
		startTimestamp: number,
		endTimestamp: number,
		nextSegmentBoundary?: (start: number) => number | null,
	) => {
		const playlists = new Map<string, string>();
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				mediaTimestampBase: 0,
				...(nextSegmentBoundary ? { nextSegmentBoundary } : {}),
				onPlaylist: content => void playlists.set(String(playlists.size), content),
			}),
			target: new PathedTarget('', () => new BufferTarget()),
		});

		const audio = audioSource();
		output.addAudioTrack(audio);
		await output.start();

		// The timeline is shared, so a later start means starting at a frame of the same grid, not at a
		// shifted one - which is what two encoders fed the same input actually see.
		let index = Math.ceil(startTimestamp / AUDIO_FRAME_DURATION);
		for (; index * AUDIO_FRAME_DURATION < endTimestamp; index++) {
			const timestamp = index * AUDIO_FRAME_DURATION;
			await audio.add(
				new EncodedPacket(aacPacketData, 'key', timestamp, AUDIO_FRAME_DURATION),
				aacMetadata,
			);
		}
		await output.finalize();

		const text = [...playlists.values()][0]!;
		const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map(match => Number(match[1]));

		// Segment starts, from the first packet actually written
		const firstTimestamp = Math.ceil(startTimestamp / AUDIO_FRAME_DURATION) * AUDIO_FRAME_DURATION;
		const starts: number[] = [];
		let at = firstTimestamp;
		for (const duration of durations) {
			starts.push(at);
			at += duration;
		}

		return starts;
	};

	/** A 2-second grid measured from zero, rather than from whenever this encoder happened to start. */
	const twoSecondGrid = (start: number) => Math.floor(start / 2) * 2 + 2;

	test('two outputs started seconds apart agree on the audio boundaries', async () => {
		const early = await audioBoundaries(0, 20, twoSecondGrid);
		const late = await audioBoundaries(5.3, 20, twoSecondGrid);

		// The late encoder's first segment is a partial one, from where it started to the next grid point;
		// every boundary after that has to match the early encoder's. Compared within half a frame rather
		// than exactly: both land on the same packet, and the two sums that reach it differ in the last bit.
		const tolerance = AUDIO_FRAME_DURATION / 2;
		const shared = late.slice(1);
		expect(shared.length).toBeGreaterThan(4);

		const from = early.findIndex(start => start > shared[0]! - tolerance);
		expect(from).toBeGreaterThan(-1);
		expect(early.length - from).toBe(shared.length);
		for (const [index, start] of shared.entries()) {
			expect(Math.abs(start - early[from + index]!)).toBeLessThan(tolerance);
		}

		// And they really are on the grid from zero, not merely equal to each other
		for (const start of shared) {
			expect(Math.abs(start - Math.round(start / 2) * 2)).toBeLessThan(AUDIO_FRAME_DURATION);
		}
	}, 60_000);

	test('a boundary stated at 5.2 s opens a segment at the first packet at or after it', async () => {
		const starts = await audioBoundaries(0, 20, start => (start < 5.2 ? 5.2 : null));

		const expected = Math.ceil(5.2 / AUDIO_FRAME_DURATION) * AUDIO_FRAME_DURATION;
		const match = starts.find(start => Math.abs(start - expected) < AUDIO_FRAME_DURATION / 2);
		expect(match, `no segment opened at ${expected}; got ${starts.join(', ')}`).toBeDefined();
		// At or after, never before: a segment opening early would carry media belonging to the splice
		expect(match!).toBeGreaterThanOrEqual(5.2 - AUDIO_FRAME_DURATION / 2);
	}, 60_000);

	test('omitting it, and returning null from it, both leave the default cut alone', async () => {
		const byDefault = await audioBoundaries(0, 20);
		const returningNull = await audioBoundaries(0, 20, () => null);

		expect(returningNull).toEqual(byDefault);
	}, 60_000);
});

// A live playlist states a wall clock so a player can seek by time of day and align two renditions, and
// so an EXT-X-DATERANGE has a START-DATE on the same clock. Doing it by making the media's own
// timestamps epoch-relative - the only way before this - costs the precision a float has at 1.7e9.
describe('programDateTime anchors the playlist to a wall clock', () => {
	const ANCHOR = new Date('2026-11-13T08:00:00.000Z');

	const playlistWith = async (programDateTime: Date | null | undefined) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
			formats: ALL_FORMATS,
		});

		const playlists: string[] = [];
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				targetDuration: 2,
				...(programDateTime === undefined ? {} : { programDateTime }),
				onPlaylist: content => void playlists.push(content),
			}),
			target: new PathedTarget('stream.m3u8', () => new BufferTarget()),
		});

		await (await Conversion.init({ input, output, audio: { discard: true } })).execute();
		expect(playlists.length).toBeGreaterThan(0);
		return playlists[playlists.length - 1]!;
	};

	/** Each segment's `#EXTINF` duration beside the `#EXT-X-PROGRAM-DATE-TIME` that precedes its URI. */
	const segmentsOf = (playlist: string) => {
		const out: { duration: number; date: string | null }[] = [];
		let date: string | null = null;
		let duration: number | null = null;

		for (const line of playlist.split('\n')) {
			const extinf = /^#EXTINF:([0-9.]+)/.exec(line);
			const pdt = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(line);
			if (extinf) {
				duration = Number(extinf[1]);
			} else if (pdt) {
				date = pdt[1]!;
			} else if (line && !line.startsWith('#') && duration !== null) {
				out.push({ duration, date });
				date = null;
				duration = null;
			}
		}

		return out;
	};

	test('every segment carries the anchor plus its own start', async () => {
		const segments = segmentsOf(await playlistWith(ANCHOR));
		expect(segments.length).toBeGreaterThan(1);

		// Each date is the one before it plus that segment's duration, and the first is the anchor - so
		// the clock is the media's own timeline laid on the anchor rather than wall time while writing
		let expected = ANCHOR.getTime();
		for (const [index, segment] of segments.entries()) {
			expect(segment.date, `segment ${index}`).not.toBeNull();
			expect(Math.abs(Date.parse(segment.date!) - expected), `segment ${index}`).toBeLessThan(2);
			expected += 1000 * segment.duration;
		}
	}, 60_000);

	test('without it a playlist whose media is not epoch-relative states no date', async () => {
		for (const anchor of [undefined, null]) {
			const segments = segmentsOf(await playlistWith(anchor));
			expect(segments.length).toBeGreaterThan(1);
			expect(segments.every(segment => segment.date === null), String(anchor)).toBe(true);
		}
	}, 60_000);

	test('an invalid anchor is refused at construction', () => {
		expect(() => new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			programDateTime: new Date('not a date'),
		})).toThrow(/valid Date or null/);
		expect(() => new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			programDateTime: 0 as unknown as Date,
		})).toThrow(/valid Date or null/);
	});
});

// A live master playlist states every rendition's bandwidth, and a rendition that produced nothing has
// none to state: closing one before any media arrives marks it done with no segments, which satisfies
// the gate that holds the master back while leaving its bitrate unset. It used to assert there,
// because the bitrate is filled as a side effect of writing that rendition's own media playlist and
// nothing orders the two.
test('a live rendition closed before any media still writes a master playlist', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/demo.mp4')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const config = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	const texts = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			live: true,
		}),
		target: new PathedTarget('index.m3u8', (request) => {
			const target = new BufferTarget();
			texts.set(request.path, target);
			return target;
		}),
	});

	const videoGroup = new OutputTrackGroup();
	const subtitleGroup = new OutputTrackGroup();
	videoGroup.pairWith(subtitleGroup);
	const video = new EncodedVideoPacketSource('avc');
	const subtitles = new SubtitleCueSource('webvtt');
	output.addVideoTrack(video, { group: videoGroup });
	output.addSubtitleTrack(subtitles, { group: subtitleGroup, languageCode: 'eng' });
	await output.start();

	// Before any packet, so the rendition is done while the variant has not written a segment yet
	subtitles.close();
	for (const packet of packets) {
		await video.add(packet, { decoderConfig: config });
	}
	await output.finalize();

	const master = new TextDecoder().decode(texts.get('index.m3u8')!.buffer!);
	expect(master).toContain('#EXT-X-STREAM-INF:');
	// The variant still states a bandwidth, which is what the assertion was guarding
	expect(master).toMatch(/BANDWIDTH=\d+/);
}, 120_000);
