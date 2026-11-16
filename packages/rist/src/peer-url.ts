/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { RistProfile } from './librist';

/** @internal */
export type ResolvedPeer = {
	/** Bind the URL's ports and wait, rather than sending to them. librist spells this with a leading `@`. */
	listener: boolean;
	bufferMs: number;
	profile: 'simple' | 'main';
	secret?: string;
	aesType?: 128 | 256;
	bandwidthKbps?: number;
};

/** @internal */
export function positive(value: number | undefined, name: string, fallback: number): number;
/** @internal */
export function positive(value: number | undefined, name: string): number | undefined;
/** @internal */
export function positive(value: number | undefined, name: string, fallback?: number) {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`options.${name}, when provided, must be a finite positive number.`);
	}
	return value;
}

/**
 * The checks `RistTarget` and `RistSource` share. Their own options are validated by each, but these
 * four are the same question with the same answer on both sides.
 *
 * @internal
 */
export const checkPeerOptions = (url: unknown, options: {
	mode?: unknown;
	profile?: unknown;
	aesType?: unknown;
	secret?: unknown;
	tunnel?: unknown;
}) => {
	if (typeof url !== 'string') {
		throw new TypeError('url must be a string.');
	}
	if (typeof options !== 'object' || !options) {
		throw new TypeError('options must be an object.');
	}
	if (options.mode !== undefined && !['listener', 'caller'].includes(options.mode as string)) {
		throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
	}
	if (options.profile !== undefined && !['simple', 'main'].includes(options.profile as string)) {
		throw new TypeError('options.profile, when provided, must be \'simple\' or \'main\'.');
	}
	if (options.aesType !== undefined && ![128, 256].includes(options.aesType as number)) {
		throw new TypeError('options.aesType, when provided, must be 128 or 256.');
	}
	if (options.secret !== undefined && typeof options.secret !== 'string') {
		throw new TypeError('options.secret, when provided, must be a string.');
	}

	// Measured: simple profile logs `Using 256 bits secret key` and still delivers to a peer holding a
	// different secret
	if (options.profile === 'simple' && (options.secret !== undefined || options.aesType !== undefined)) {
		throw new TypeError(
			'options.secret and options.aesType require options.profile to be \'main\'. Simple profile'
			+ ' does not enforce a secret - a peer with the wrong one still receives the stream.',
		);
	}
	if (options.profile === 'simple' && options.tunnel) {
		throw new TypeError(
			'options.tunnel requires options.profile to be \'main\'; simple profile has no GRE layer to'
			+ ' carry it, and librist refuses to enable it.',
		);
	}
};

/** @internal */
export const profileOf = (profile: 'simple' | 'main') =>
	profile === 'simple' ? RistProfile.SIMPLE : RistProfile.MAIN;

/**
 * Builds the `rist://` URL librist parses its whole peer configuration out of, so nothing here lays out
 * a `rist_peer_config`: the struct has grown across librist versions and a layout written against one
 * header silently corrupts the next. Parameter names are librist's own, from
 * `include/librist/urlparam.h`, where `buffer` sets the recovery length, both its min and its max.
 *
 * @internal
 */
export const peerUrl = (url: string, peer: ResolvedPeer) => {
	const parsed = new URL(url);
	if (parsed.protocol !== 'rist:') {
		throw new TypeError(`Expected a rist:// URL, got ${parsed.protocol}//.`);
	}

	const host = peer.listener ? `@${parsed.hostname}` : parsed.hostname;
	const query = new URLSearchParams(parsed.search);
	query.set('buffer', String(peer.bufferMs));
	query.set('profile', peer.profile === 'simple' ? '0' : '1');

	if (peer.secret !== undefined) {
		query.set('secret', peer.secret);
		query.set('aes-type', String(peer.aesType ?? 256));
	}
	if (peer.bandwidthKbps !== undefined) {
		query.set('bandwidth', String(peer.bandwidthKbps));
	}

	return `rist://${host}:${parsed.port}?${query.toString()}`;
};
