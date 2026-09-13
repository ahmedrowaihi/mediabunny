/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { MediaCodec } from './codec';
import type { DurationMetadataRequestOptions } from './demuxer';
import type { InputTrackBacking } from './input-track';
import type { PacketRetrievalOptions } from './media-sink';
import { DEFAULT_TRACK_DISPOSITION, type TrackDisposition } from './metadata';
import { assert, type MaybePromise } from './misc';
import type { EncodedPacket } from './packet';
import type { TrackType } from './output';

/**
 * What a segmented format's track entry states before any segment has been read. A manifest
 * describes the track; the segment it points at is what actually holds the media, so anything the
 * manifest cannot answer is delegated to the segment's own backing once one has been resolved.
 *
 * @internal
 */
export type SegmentedInternalTrack = {
	id: number;
	backingTrack: InputTrackBacking | null;
	languageCode: string;
	autoselect: boolean;
	pairingMask: bigint;
	name: string | null;
	peakBitrate: number | null;
	averageBitrate: number | null;
	info: { type: TrackType };
	demuxer: { internalTracks: { info: { type: TrackType } }[] | null };
};

/**
 * The half of a segmented track that every such format answers the same way. A subclass supplies
 * how to find its segment ({@link hydrate}), what the manifest says the track is, and which of its
 * own flags means "primary" — HLS and DASH disagree on that one.
 *
 * @internal
 */
export abstract class SegmentedTrackBacking<T extends SegmentedInternalTrack> implements InputTrackBacking {
	constructor(public internalTrack: T) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	/** Resolve the segment backing this track delegates to, setting `internalTrack.backingTrack`. */
	abstract hydrate(): Promise<void>;
	/** Whether this track is the primary one of its type. */
	protected abstract isPrimary(): boolean;

	delegate<R>(fn: () => MaybePromise<R>): MaybePromise<R> {
		if (this.internalTrack.backingTrack) {
			return fn();
		}
		return this.hydrate().then(fn);
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			default: this.internalTrack.autoselect,
			primary: this.isPrimary(),
		};
	}

	getId(): number {
		return this.internalTrack.id;
	}

	getPairingMask(): bigint {
		return this.internalTrack.pairingMask;
	}

	getInternalCodecId(): string | number | Uint8Array | null {
		return null;
	}

	getEncryptionInfo() {
		return null;
	}

	getLanguageCode(): string {
		return this.internalTrack.languageCode;
	}

	getName(): string | null {
		return this.internalTrack.name;
	}

	getNumber(): number {
		assert(this.internalTrack.demuxer.internalTracks);
		const trackType = this.internalTrack.info.type;
		let number = 0;
		for (const track of this.internalTrack.demuxer.internalTracks) {
			if (track.info.type === trackType) {
				number++;
			}
			if (track === (this.internalTrack as unknown as { info: { type: TrackType } })) {
				break;
			}
		}
		return number;
	}

	getBitrate(): number | null {
		return this.internalTrack.peakBitrate;
	}

	getAverageBitrate(): number | null {
		return this.internalTrack.averageBitrate;
	}

	getTimeResolution(): MaybePromise<number> {
		return this.delegate(() => this.internalTrack.backingTrack!.getTimeResolution());
	}

	isRelativeToUnixEpoch(): MaybePromise<boolean> {
		return this.delegate(() => this.internalTrack.backingTrack!.isRelativeToUnixEpoch());
	}

	getUnixTimeForTimestamp(timestamp: number): MaybePromise<number | null> {
		return this.delegate(() => this.internalTrack.backingTrack!.getUnixTimeForTimestamp(timestamp));
	}

	/** HLS states this in the manifest (`EXT-X-I-FRAMES-ONLY`); DASH has to ask the segment. */
	abstract getHasOnlyKeyPackets(): MaybePromise<boolean | null>;

	async getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getDurationFromMetadata(options);
	}

	async getLiveRefreshInterval(): Promise<number | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getLiveRefreshInterval();
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getFirstPacket(options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getPacket(timestamp, options);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getKeyPacket(timestamp, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getNextPacket(packet, options);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getNextKeyPacket(packet, options);
	}
}
