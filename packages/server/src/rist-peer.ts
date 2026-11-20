/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** The peer settings `RistTarget` and `RistSource` share, resolved from their options. @internal */
export type ResolvedPeer = {
	mode: 'listener' | 'caller';
	profile: 'simple' | 'main';
	secret: string | undefined;
	aesType: 128 | 256 | undefined;
};

/** @internal */
export const positive = (value: number | undefined, name: string, fallback: number): number => {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`options.${name}, when provided, must be a finite positive number.`);
	}
	return value;
};

type PeerOptions = {
	mode?: unknown;
	profile?: unknown;
	secret?: unknown;
	aesType?: unknown;
};

/**
 * Validates the URL list and the options both classes share, and resolves the peer settings.
 *
 * A list of URLs is a bonded link group, not a list of unrelated peers, so every one of them is
 * checked — a bad second URL that only failed once the first had opened would leave a half-started
 * stream behind.
 *
 * @internal
 */
export const parseUrls = (
	url: string | string[],
	options: PeerOptions,
	className: string,
): { urls: { host: string; port: number }[]; peer: ResolvedPeer } => {
	if (typeof options !== 'object' || !options) {
		throw new TypeError('options must be an object.');
	}
	if (options.mode !== undefined && !['listener', 'caller'].includes(options.mode as string)) {
		throw new TypeError('options.mode, when provided, must be \'listener\' or \'caller\'.');
	}
	if (options.profile !== undefined && !['simple', 'main'].includes(options.profile as string)) {
		throw new TypeError('options.profile, when provided, must be \'simple\' or \'main\'.');
	}
	if (options.secret !== undefined && typeof options.secret !== 'string') {
		throw new TypeError('options.secret, when provided, must be a string.');
	}
	if (options.aesType !== undefined && ![128, 256].includes(options.aesType as number)) {
		throw new TypeError('options.aesType, when provided, must be 128 or 256.');
	}

	// Defaults to simple, which is what `@mediabunny/server` has always spoken and what MediaConnect
	// uses. librist's own tools default to main, so a peer built against those needs `profile: 'main'`
	// stated - a profile disagreement delivers nothing rather than failing loudly.
	const profile: 'simple' | 'main' = (options.profile as 'simple' | 'main' | undefined) ?? 'simple';
	if (profile === 'simple' && (options.secret !== undefined || options.aesType !== undefined)) {
		throw new TypeError(
			'options.secret and options.aesType require options.profile to be \'main\'. Simple profile'
			+ ' has no encryption, so a secret there would not protect the stream.',
		);
	}

	const list = Array.isArray(url) ? url : [url];
	if (list.length === 0) {
		throw new TypeError(`${className}: the link list must name at least one rist:// URL.`);
	}

	const urls = list.map((one) => {
		if (typeof one !== 'string') {
			throw new TypeError(`${className}: every URL must be a string.`);
		}

		let parsed: URL;
		try {
			parsed = new URL(one);
		} catch {
			throw new TypeError(`${className}: ${JSON.stringify(one)} is not a URL.`);
		}
		if (parsed.protocol !== 'rist:') {
			throw new TypeError(`${className}: ${JSON.stringify(one)} is not a rist:// URL.`);
		}

		const port = Number(parsed.port);
		if (!Number.isInteger(port) || port <= 0 || port >= 65535) {
			throw new TypeError(`${className}: ${JSON.stringify(one)} must state a port below 65535.`);
		}
		// Simple profile puts RTCP on the port above the media one, so the media port must be even.
		// Main profile needs only the one port, but the even/odd convention is kept so a URL means the
		// same thing under either profile.
		if (port % 2 !== 0) {
			throw new TypeError(
				`${className}: ${JSON.stringify(one)} must state an even port; RTCP uses the next one.`,
			);
		}

		return { host: parsed.hostname || '0.0.0.0', port };
	});

	return {
		urls,
		peer: {
			mode: (options.mode ?? 'caller') as 'listener' | 'caller',
			profile,
			secret: options.secret,
			aesType: options.aesType as 128 | 256 | undefined,
		},
	};
};
