/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { type InputTrackBacking } from '../input-track';
import { type MetadataTags } from '../metadata';

/**
 * Reads DASH MPD manifests and exposes the represented media as mediabunny
 * tracks. Created by `DashInputFormat` when a manifest is detected.
 *
 * NOTE: This is a Phase B placeholder. The real implementation lives in a
 * follow-up commit; for now it exists so `DashSegmentedInput` has a concrete
 * demuxer type to reference. All metadata methods throw.
 */
export class DashDemuxer extends Demuxer {
	constructor(input: Input) {
		super(input);
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		throw new Error('DashDemuxer not yet implemented (Phase C).');
	}

	async getMimeType(): Promise<string> {
		return 'application/dash+xml';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		throw new Error('DashDemuxer not yet implemented (Phase C).');
	}
}
