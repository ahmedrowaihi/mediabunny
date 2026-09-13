/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Output } from './output';
import type { HlsOutputFormatOptions } from './output-format';
import type { Playlist, PipelineTrackData } from './segment-pipeline-muxer';

/** @internal */
export type MediaPipelineHost = {
	output: Output;
	playlists: Playlist[];
	trackDatas: PipelineTrackData[];
	targetSegmentDuration: number;
	globalTargetDuration: number;
	isLive: boolean;
	isRelativeToUnixEpoch: boolean;
	maxLiveSegmentCount: number;
	partDuration: number | null;
	getSegmentPath: NonNullable<HlsOutputFormatOptions['getSegmentPath']>;
	acquireMutex(): Promise<() => void>;
};

/** @internal */
export type ManifestEmitter = {
	onStart?(): void | Promise<void>;
	onSegmentAppended?(playlist: Playlist): void | Promise<void>;
	onPlaylistDone?(playlist: Playlist): void | Promise<void>;
	onFinalize?(): void | Promise<void>;
};
