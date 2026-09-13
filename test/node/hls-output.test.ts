import { describe, expect, test, vi } from 'vitest';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { declaredVideoCodec } from '../../src/isobmff/isobmff-boxes.js';
import {
	AdaptiveOutputFormat,
	CmafOutputFormat,
	type OutputFormat,
	DashOutputFormat,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	HlsOutputSegmentInfo,
	MovOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
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
import { FilePathSource } from '../../src/source.js';
import { Conversion } from '../../src/conversion.js';
import path from 'node:path';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { readTopLevelBoxes } from './_top-level-boxes.js';

const __dirname = new URL('.', import.meta.url).pathname;

const videoSource = (codec: VideoCodec = 'avc') => new EncodedVideoPacketSource(codec);
const audioSource = (codec: AudioCodec = 'aac') => new EncodedAudioPacketSource(codec);

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

const setUpSegmentationEnvironment = async (options: {
	video?: boolean;
	audio?: boolean;
} = {}) => {
	let result: string | null = null;
	let segmentCount = 0;
	let lastSegmentVideoTimestamps: Promise<number[]> = Promise.resolve([]);
	let lastSegmentAudioTimestamps: Promise<number[]> = Promise.resolve([]);

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(), // No ADTS for simplicity
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

test('Segmentation, audio not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.45);
	await env.addAudioPacket(0.9);
	await env.addAudioPacket(1.35);
	await env.addAudioPacket(1.8);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2.25);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addAudioPacket(2.7);
	await env.addAudioPacket(3.15);
	await env.addAudioPacket(3.6);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.05);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.8, 2.25, 2.7, 3.15]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([3.6, 4.05]);

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

test('Segmentation, non-zero start time', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

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
	const env = await setUpSegmentationEnvironment({ video: true });
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
	const env = await setUpSegmentationEnvironment({ video: true });
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

	expect(timestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
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
	await runSparseTracksInSegments({
		segmentFormat: new MpegTsOutputFormat(),
	});
});

test('Sparse tracks in segments, CMAF', async () => {
	await runSparseTracksInSegments({
		segmentFormat: new CmafOutputFormat(),
	});
});

test('Sparse tracks in segments, standard MP4', async () => {
	await runSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat(),
	});
});

test('Sparse tracks in segments, fragmented MP4', async () => {
	await runSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
	});
});

test('Sparse tracks in segments, fragmented MP4 + single file', async () => {
	await runSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		singleFilePerPlaylist: true,
	});
});

const runSparseTracksInSegments = async (hlsOptions: HlsOutputFormatOptions) => {
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

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { result = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
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
