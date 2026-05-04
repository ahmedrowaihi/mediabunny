/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from './input';
import { InputTrackBacking } from './input-track';
import { PsshBox, SidxBox } from './isobmff/isobmff-misc';
import { MetadataTags } from './metadata';

/**
 * Options for retrieving media duration from metadata.
 * @group Input files & tracks
 * @public
 */
export type DurationMetadataRequestOptions = {
	/**
	 * When the underlying media is live, querying the duration will, by default, wait until the live stream has ended.
	 * Setting this field to `true` skips that wait and returns the current duration of the stream. When the media isn't
	 * live, this field has no effect.
	 *
	 * See also {@link PacketRetrievalOptions.skipLiveWait}.
	 */
	skipLiveWait?: boolean;
};

export abstract class Demuxer {
	input: Input;

	constructor(input: Input) {
		this.input = input;
	}

	abstract getTrackBackings(): Promise<InputTrackBacking[]>;
	abstract getMimeType(): Promise<string>;
	abstract getMetadataTags(): Promise<MetadataTags>;

	async getSegmentIndex(): Promise<SidxBox[]> {
		return [];
	}

	/**
	 * Top-level Protection System Specific Header (`pssh`) boxes — typically present once per
	 * encrypted file under `moov`, one per DRM system. Returns an empty array for non-isobmff
	 * formats and for clear isobmff files.
	 */
	async getPsshBoxes(): Promise<PsshBox[]> {
		return [];
	}

	dispose() {
		// Can be overridden
	}
}
