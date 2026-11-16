/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InvalidUsageError } from './errors';
import { Target } from './target';

/**
 * Writes bytes straight to a {@link Target}, for data that is already in its final form — a transport
 * stream being relayed, a file being copied through. An {@link Output} is the way to *produce* a
 * container; this is the way to carry one that already exists.
 *
 * Writes are append-only and the container's correctness is the caller's: nothing here parses what goes
 * through, so a target that needs seeking (a non-fragmented MP4) cannot be written this way.
 *
 * @example
 * ```ts
 * const writer = new TargetWriter(new SrtTarget('srt://receiver:9000'));
 * for await (const datagram of source) {
 * 	writer.write(datagram);
 * 	await writer.flush();
 * }
 * await writer.close();
 * ```
 *
 * @group Output targets
 * @public
 */
export class TargetWriter {
	/** @internal */
	private readonly _target: Target;
	/** @internal */
	private _position = 0;
	/** @internal */
	private _started = false;
	/** @internal */
	private _closed = false;

	constructor(target: Target) {
		if (!(target instanceof Target)) {
			throw new TypeError('target must be a Target.');
		}

		// The same claim an Output's Writer stakes, so a target cannot be driven by both: whichever
		// comes second throws rather than interleaving two position counters into one stream.
		if (target._writerAcquired) {
			throw new InvalidUsageError(
				'That Target is already being written to, by an Output or another TargetWriter.',
			);
		}

		this._target = target;
		// Append-only, which is what lets an append-only target accept these writes at all
		this._target._setMonotonicity(true);
		this._target._writerAcquired = true;
	}

	/** Bytes handed to the target so far, which is also the next write's offset. */
	get position(): number {
		return this._position;
	}

	/**
	 * Appends bytes. Returns once the target has taken them, which for a buffering target is immediately
	 * — {@link TargetWriter.flush} is what waits for them to be written out.
	 */
	write(bytes: Uint8Array): void {
		if (this._closed) {
			throw new InvalidUsageError('Cannot write to a closed TargetWriter.');
		}
		if (!(bytes instanceof Uint8Array)) {
			throw new TypeError('bytes must be a Uint8Array.');
		}

		if (!this._started) {
			this._started = true;
			this._target._start();
		}
		if (bytes.byteLength === 0) {
			return;
		}

		this._target._write(bytes, this._position);
		this._position += bytes.byteLength;
	}

	/**
	 * Writes out what has been appended. This is the point backpressure arrives at, the same as on an
	 * `Output`'s own path, so a caller that wants it awaits this rather than {@link TargetWriter.write}.
	 */
	async flush(): Promise<void> {
		if (this._closed) {
			throw new InvalidUsageError('Cannot flush a closed TargetWriter.');
		}
		if (!this._started) {
			return;
		}

		await this._target._flush();
	}

	/** Flushes, then finalizes the target, which is where a draining target drains. */
	async close(): Promise<void> {
		if (this._closed) {
			return;
		}
		if (!this._started) {
			this._closed = true;
			return;
		}

		this._closed = true;
		await this._target._flush();
		await this._target._finalize();
	}
}
