/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OutputTrack } from './output';
import type { Target } from './target';
import type { Writer } from './writer';

/** @internal */
export type Segment = {
	path: string;
	duration: number;
	timestamp: number;
	byteSize: number;
	byteOffset: number | null;
};

/** @internal */
export type Playlist = {
	id: number;
	path: string;
	tracks: OutputTrack[];
	segmentFormat: { fileExtension: string; mimeType: string };
	initSegment: Segment | null;
	writtenSegments: Segment[];
	peakBitrate: number | null;
	averageBitrate: number | null;
	mediaSequence: number;
	done: boolean;
	bitrateCache: {
		processedCount: number;
		cachedGtd: number;
		totalBytes: number;
		totalDuration: number;
		peakBitrate: number;
	} | null;
};

/** @internal */
export type TrackData = {
	track: OutputTrack;
	info: {
		type: 'video';
		decoderConfig: VideoDecoderConfig;
	} | {
		type: 'audio';
		decoderConfig: AudioDecoderConfig;
	};
};

/** @internal */
export type PipelineOutput = {
	_target: unknown;
	_getRootWriter(allowReuse: boolean): Promise<Writer>;
	_getTarget(request: {
		path: string;
		isRoot: boolean;
		mimeType: string;
	}): Promise<{ _start?: () => void } & Target>;
};

/** @internal */
export type MediaPipelineHost = {
	output: PipelineOutput;
	playlists: Playlist[];
	trackDatas: TrackData[];
	targetSegmentDuration: number;
	globalTargetDuration: number;
	isLive: boolean;
	isRelativeToUnixEpoch: boolean;
	maxLiveSegmentCount: number;
	acquireMutex(): Promise<() => void>;
};

/** @internal */
export type ManifestEmitter = {
	onStart?(): void | Promise<void>;
	onSegmentAppended?(playlist: Playlist): void | Promise<void>;
	onPlaylistDone?(playlist: Playlist): void | Promise<void>;
	onFinalize?(): void | Promise<void>;
};
