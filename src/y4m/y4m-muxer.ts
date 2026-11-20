/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Muxer } from '../muxer';
import { Output, OutputVideoTrack } from '../output';
import { Writer } from '../writer';
import { EncodedPacket } from '../packet';
import { Y4mOutputFormat } from '../output-format';
import { assert, textEncoder, toUint8Array } from '../misc';
import { y4mColorSpaceOf, y4mFrameSize } from './y4m-misc';
import { Y4M_SIGNATURE } from './y4m-demuxer';

export class Y4mMuxer extends Muxer {
	private format: Y4mOutputFormat;
	private writer!: Writer;
	private headerWritten = false;
	private expectedFrameSize = 0;

	constructor(output: Output, format: Y4mOutputFormat) {
		super(output);

		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		try {
			this.writer = await this.output._getRootWriter(true);
		} finally {
			release();
		}
	}

	async getMimeType() {
		return 'video/x-yuv4mpeg';
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			if (!this.headerWritten) {
				this.writeHeader(track, meta);
				this.headerWritten = true;
			}

			this.validateTimestamp(track, packet.timestamp, true);

			// A frame of the wrong size shifts every frame after it, and the file still opens - it is
			// read at the wrong offset from there on, which looks like corrupt video rather than a
			// writer's mistake
			if (packet.data.byteLength !== this.expectedFrameSize) {
				throw new Error(
					`A Y4M frame of this size and colour space is ${this.expectedFrameSize} octets, and this`
					+ ` packet is ${packet.data.byteLength}. Y4M has no frame sizes of its own: the header`
					+ ' fixes them, so a frame that disagrees would silently shift every frame after it.',
				);
			}

			this.writer.write(textEncoder.encode('FRAME\n'));
			this.writer.write(packet.data);

			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket() {
		throw new Error('Y4M carries video and nothing else.');
	}

	async addSubtitleCue() {
		throw new Error('Y4M carries video and nothing else.');
	}

	private writeHeader(track: OutputVideoTrack, meta: EncodedVideoChunkMetadata | undefined) {
		const config = meta?.decoderConfig ?? track.metadata.decoderConfig;
		if (!config) {
			throw new Error(
				'A Y4M header states the picture size and colour space of every frame in the file, so the'
				+ ' first packet must come with a decoder config, or the track must declare one.',
			);
		}

		// Uncompressed frames say nothing about themselves; the colour space rides in the description
		const tag = config.description
			? new TextDecoder('latin1').decode(toUint8Array(config.description))
			: '420jpeg';
		const colorSpace = y4mColorSpaceOf(tag);
		if (!colorSpace) {
			throw new Error(
				`The decoder config states a colour space of '${tag}', which is not one Y4M defines.`,
			);
		}

		const width = config.codedWidth;
		const height = config.codedHeight;
		if (!width || !height) {
			throw new Error('A Y4M header states the picture size, so the decoder config must carry one.');
		}

		this.expectedFrameSize = y4mFrameSize(colorSpace, width, height);

		const frameRate = track.metadata.frameRate ?? 25;
		// Written as a ratio, exactly: 30000:1001 is a rate and 29.97 is a rounding of one
		const den = Number.isInteger(frameRate) ? 1 : 1001;
		const num = Math.round(frameRate * den);

		// Y4M states interlacing per file; nothing in a track's metadata does, so this writes what the
		// pictures actually are when the caller encoded them as fields
		const interlacing = 'p';

		const parameters = [
			`W${width}`,
			`H${height}`,
			`F${num}:${den}`,
			`I${interlacing}`,
			'A1:1',
			`C${colorSpace.tag}`,
		];

		const header = `${Y4M_SIGNATURE} ${parameters.join(' ')}\n`;

		if (this.format._options.onHeader) {
			this.writer.startTrackingWrites();
		}

		this.writer.write(textEncoder.encode(header));

		if (this.format._options.onHeader) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onHeader(data, start);
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		try {
			assert(this.writer);
			await this.writer.flush();
		} finally {
			release();
		}
	}
}
