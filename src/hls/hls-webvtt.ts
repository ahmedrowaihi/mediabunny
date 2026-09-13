/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { textEncoder } from '../misc';
import { TIMESCALE as MPEG_TS_TIMESCALE } from '../mpeg-ts/mpeg-ts-misc';
import { Muxer } from '../muxer';
import type { OutputSubtitleTrack } from '../output';
import { formatSubtitleTimestamp, type SubtitleCue, type SubtitleMetadata } from '../subtitles';
import type { Writer } from '../writer';

/** @internal */
export const WEBVTT_MIME_TYPE = 'text/vtt';

/** @internal */
export const WEBVTT_FILE_EXTENSION = '.vtt';

const DEFAULT_PREAMBLE = 'WEBVTT';

// Cue timestamps stay on the media timeline; X-TIMESTAMP-MAP is what anchors it for the player.
/** @internal */
export const buildWebvttSegment = (options: {
	preamble: string | null;
	startTimestamp: number;
	cues: SubtitleCue[];
}) => {
	const preamble = options.preamble ?? DEFAULT_PREAMBLE;
	const newlineIndex = preamble.indexOf('\n');
	const firstLine = newlineIndex === -1 ? preamble : preamble.slice(0, newlineIndex);
	const restOfPreamble = newlineIndex === -1 ? '' : preamble.slice(newlineIndex);

	// X-TIMESTAMP-MAP must live in the header block, i.e. before the first blank line, so it is
	// spliced in right after the WEBVTT line rather than appended to the preamble.
	const timestampMap = `X-TIMESTAMP-MAP=LOCAL:${formatSubtitleTimestamp(Math.round(1000 * options.startTimestamp))}`
		+ `,MPEGTS:${Math.round(options.startTimestamp * MPEG_TS_TIMESCALE)}`;

	let text = `${firstLine}\n${timestampMap}${restOfPreamble}\n`;

	for (const cue of options.cues) {
		text += '\n';

		if (cue.identifier) {
			text += `${cue.identifier}\n`;
		}

		text += formatSubtitleTimestamp(Math.round(1000 * cue.timestamp))
			+ ' --> '
			+ formatSubtitleTimestamp(Math.round(1000 * (cue.timestamp + cue.duration)));

		if (cue.settings) {
			text += ` ${cue.settings}`;
		}

		text += `\n${cue.text}\n`;
	}

	return text;
};

/** @internal */
export class WebvttMuxer extends Muxer {
	private writer!: Writer;
	private cues: SubtitleCue[] = [];

	/** The media timeline position this document starts at; what X-TIMESTAMP-MAP anchors to. */
	segmentStartTimestamp = 0;
	/** The `WEBVTT` header block, verbatim. */
	preamble: string | null = null;

	async start() {
		this.writer = await this.output._getRootWriter(true);
	}

	async getMimeType() {
		return WEBVTT_MIME_TYPE;
	}

	async addEncodedVideoPacket(): Promise<void> {
		throw new Error('WebVTT does not support video.');
	}

	async addEncodedAudioPacket(): Promise<void> {
		throw new Error('WebVTT does not support audio.');
	}

	async addSubtitleCue(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata) {
		const release = await this.mutex.acquire();

		try {
			this.preamble ??= meta?.config?.description ?? null;
			this.cues.push(cue);
		} finally {
			release();
		}
	}

	// A .vtt segment has no container framing, so the whole document is written in one go here,
	// once every cue of the segment is in.
	async finalize() {
		const release = await this.mutex.acquire();

		try {
			this.writer.write(textEncoder.encode(buildWebvttSegment({
				preamble: this.preamble,
				startTimestamp: this.segmentStartTimestamp,
				cues: this.cues,
			})));

			await this.writer.flush();
		} finally {
			release();
		}
	}
}
