/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { VideoEncodingConfig } from './encode';
import { InvalidUsageError } from './errors';
import { InputVideoTrack } from './input-track';
import { VideoSampleSource } from './media-source';
import { VideoSampleSink } from './media-sink';
import { Output, VideoTrackMetadata } from './output';

/**
 * One rendition of an ABR ladder: where it is written, and how it is encoded.
 *
 * @group Conversion
 * @public
 */
export type LadderRung = {
	/** Written to by {@link encodeVideoLadder}; must be unstarted and have no video track yet. */
	output: Output;
	/** Resolution goes in `transform`; the ladder owns `keyFrameInterval`. */
	video: Omit<VideoEncodingConfig, 'keyFrameInterval'>;
	/** Metadata for this rendition's video track. */
	metadata?: VideoTrackMetadata;
};

/**
 * Options for {@link encodeVideoLadder}.
 *
 * @group Conversion
 * @public
 */
export type VideoLadderOptions = {
	/** The track every rendition is encoded from. It is decoded exactly once. */
	track: InputVideoTrack;
	/** The renditions to produce. */
	rungs: LadderRung[];
	/** The key frame interval, in seconds, shared by every rendition. Defaults to 2. */
	keyFrameInterval?: number;
	/** Aborting this signal cancels every rendition's {@link Output}. */
	signal?: AbortSignal;
};

/**
 * Encodes one input video track into an ABR ladder, decoding it once and fanning each decoded frame
 * out to every rendition's encoder.
 *
 * Every rendition shares one `keyFrameInterval` and sees the same frames, so their key frames land on
 * the same timestamps and a player can switch between them. Audio belongs in its own {@link Output}.
 *
 * @example
 * ```ts
 * await encodeVideoLadder({
 * 	track: await input.getPrimaryVideoTrack(),
 * 	rungs: [
 * 		{ output: out1080, video: { codec: 'avc', bitrate: 5e6, transform: { width: 1920, height: 1080 } } },
 * 		{ output: out720, video: { codec: 'avc', bitrate: 3e6, transform: { width: 1280, height: 720 } } },
 * 		{ output: out480, video: { codec: 'avc', bitrate: 1e6, transform: { width: 854, height: 480 } } },
 * 	],
 * });
 * ```
 *
 * @group Conversion
 * @public
 */
export const encodeVideoLadder = async (options: VideoLadderOptions): Promise<void> => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (!(options.track instanceof InputVideoTrack)) {
		throw new TypeError('options.track must be an InputVideoTrack.');
	}
	if (!Array.isArray(options.rungs) || options.rungs.length === 0) {
		throw new TypeError('options.rungs must be a non-empty array.');
	}
	if (
		options.keyFrameInterval !== undefined
		&& (!Number.isFinite(options.keyFrameInterval) || options.keyFrameInterval < 0)
	) {
		throw new TypeError('options.keyFrameInterval, when provided, must be a non-negative number.');
	}
	if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
		throw new TypeError('options.signal, when provided, must be an AbortSignal.');
	}

	const keyFrameInterval = options.keyFrameInterval ?? 2;

	const rigs = options.rungs.map((rung, i) => {
		if (!rung || typeof rung !== 'object') {
			throw new TypeError(`options.rungs[${i}] must be an object.`);
		}
		if (!(rung.output instanceof Output)) {
			throw new TypeError(`options.rungs[${i}].output must be an Output.`);
		}
		if (!rung.video || typeof rung.video !== 'object') {
			throw new TypeError(`options.rungs[${i}].video must be an object.`);
		}
		if ((rung.video as VideoEncodingConfig).keyFrameInterval !== undefined) {
			throw new InvalidUsageError(
				`options.rungs[${i}].video.keyFrameInterval must not be set; the ladder owns the key frame interval`
				+ ' so that every rendition shares it. Set options.keyFrameInterval instead.',
			);
		}

		const source = new VideoSampleSource({
			...rung.video,
			keyFrameInterval,
			latencyMode: 'quality', // A rung that drops a frame to hold its bitrate leaves the ladder unswitchable
		});
		rung.output.addVideoTrack(source, rung.metadata);

		return { output: rung.output, source };
	});

	const cancelAll = () => Promise.allSettled(rigs.map(rig => rig.output.cancel()));

	if (options.signal?.aborted) {
		throw options.signal.reason as Error;
	}

	try {
		await Promise.all(rigs.map(rig => rig.output.start()));

		const sink = new VideoSampleSink(options.track);

		for await (const sample of sink.samples()) {
			if (options.signal?.aborted) {
				sample.close();
				await cancelAll();
				throw options.signal.reason as Error;
			}

			// Clone for every rung up front: they share one backing resource, and the first add closes it
			const clones = rigs.map(() => sample.clone());
			sample.close();

			await Promise.all(rigs.map(async (rig, i) => {
				const clone = clones[i]!;

				try {
					await rig.source.add(clone);
				} finally {
					clone.close();
				}
			}));
		}

		await Promise.all(rigs.map(rig => rig.output.finalize()));
	} catch (error) {
		await cancelAll();
		throw error;
	}
};
