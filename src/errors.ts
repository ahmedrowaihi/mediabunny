/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Base class for the errors this library throws against media and manifests it was handed.
 *
 * It exists so a caller can tell *whose problem* a failure is without matching on message text. At
 * an origin the three subclasses map onto three different responses: {@link MalformedInputError} is
 * the publisher's bytes being wrong (reject the upload, 4xx the request), {@link UnsupportedMediaError}
 * is a shape this library does not handle (degrade, or route elsewhere), and {@link InvalidUsageError}
 * is the calling code being wrong (a bug to fix, never a runtime condition to handle).
 *
 * Every one of these extends `Error` and keeps its message, so existing `catch` blocks that test
 * `instanceof Error` or read `.message` keep working unchanged.
 *
 * Named for the package rather than the domain because `MediaError` is a built-in DOM interface
 * (`HTMLMediaElement.error`); a media library shadowing that global would be a footgun in exactly
 * the browsers it targets.
 *
 * @group Errors
 * @public
 */
export class MediabunnyError extends Error {
	/** Creates a new {@link MediabunnyError}. */
	constructor(message: string) {
		super(message);
		this.name = 'MediabunnyError';
	}
}

/**
 * Thrown when the bytes or manifest handed to this library are not valid for their format — a
 * required attribute missing, a box whose size does not fit the buffer, a playlist with no header.
 *
 * The input is at fault, not the caller and not this library. At an origin this is the one to turn
 * into a rejection rather than an alert.
 *
 * @group Errors
 * @public
 */
export class MalformedInputError extends MediabunnyError {
	/** Creates a new {@link MalformedInputError}. */
	constructor(message: string) {
		super(message);
		this.name = 'MalformedInputError';
	}
}

/**
 * Thrown when the input is valid but states something this library does not implement — an Annex B
 * stream where length-prefixed NAL units are required, field pictures, a codec without a parser.
 *
 * Distinct from {@link MalformedInputError} because the remedy is different: the file is not broken,
 * so re-encoding or routing to another tool can succeed where rejecting it would be wrong.
 *
 * @group Errors
 * @public
 */
export class UnsupportedMediaError extends MediabunnyError {
	/** Creates a new {@link UnsupportedMediaError}. */
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedMediaError';
	}
}

/**
 * Thrown when the calling code used this library incorrectly — a builder read before it was given
 * the field it needs, a value set twice, a required collaborator not supplied.
 *
 * This is a programming error on the caller's side. It should surface in development and never be
 * caught as a runtime condition.
 *
 * @group Errors
 * @public
 */
export class InvalidUsageError extends MediabunnyError {
	/** Creates a new {@link InvalidUsageError}. */
	constructor(message: string) {
		super(message);
		this.name = 'InvalidUsageError';
	}
}

/**
 * Thrown when a request kept failing for longer than {@link UrlSourceOptions.retryTimeout} allows.
 *
 * The retry policy's job is to ride out a blip; past the budget the host is treated as unreachable
 * and the read is given up on, so a caller gets a rejection to handle instead of waiting forever.
 * The failure that ended it is on `cause`.
 *
 * @group Errors
 * @public
 */
export class RetryTimeoutError extends MediabunnyError {
	/** Creates a new {@link RetryTimeoutError}. */
	constructor(message: string, options?: {
		/** The failure that ended the retries, kept on the error's `cause`. */
		cause?: unknown;
	}) {
		super(message);
		this.name = 'RetryTimeoutError';
		if (options && 'cause' in options) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}
