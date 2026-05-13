/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** MIME type for DASH MPD manifests. @group DASH @public */
export const DASH_MIME_TYPE = 'application/dash+xml';

export const DASH_NS = {
	mpd: 'urn:mpeg:dash:schema:mpd:2011',
	cenc: 'urn:mpeg:cenc:2013',
	mspr: 'urn:microsoft:playready',
} as const;

export const looksLikeMpd = (firstBytes: Uint8Array): boolean => {
	const decoder = new TextDecoder('utf-8', { fatal: false });
	const head = decoder.decode(firstBytes.subarray(0, Math.min(firstBytes.length, 2048)));
	return head.includes('<MPD');
};

/** Resolve `relative` against `base` per WHATWG URL, with a string-join fallback. @group DASH @public */
export const resolveURL = (relative: string, base: string): string => {
	try {
		return new URL(relative, base).toString();
	} catch {
		if (!relative) {
			return base;
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) {
			return relative;
		}
		const baseEnd = base.lastIndexOf('/');
		const dir = baseEnd >= 0 ? base.slice(0, baseEnd + 1) : `${base}/`;
		return `${dir}${relative}`;
	}
};

/** Walk a chain of BaseURL element lists and resolve them in order against `manifestURL`. @group DASH @public */
export const resolveBaseURL = (manifestURL: string, ...chains: (string[] | undefined)[]): string => {
	let base = manifestURL;
	for (const chain of chains) {
		const first = chain?.[0];
		if (!first) {
			continue;
		}
		base = resolveURL(first, base);
	}
	return base;
};

/** Parse an ISO 8601 duration (e.g. `PT1H2M3.5S`) to seconds, or `null` if malformed. @group DASH @public */
export const parseISODuration = (value: string | null | undefined): number | null => {
	if (!value) {
		return null;
	}
	const num = '(\\d+(?:\\.\\d+)?)';
	const re = new RegExp(`^(-?)P(?:${num}D)?(?:T(?:${num}H)?(?:${num}M)?(?:${num}S)?)?$`);
	const match = re.exec(value.trim());
	if (!match) {
		return null;
	}
	const [, sign, daysStr, hoursStr, minutesStr, secondsStr] = match;
	const days = daysStr ? Number(daysStr) : 0;
	const hours = hoursStr ? Number(hoursStr) : 0;
	const minutes = minutesStr ? Number(minutesStr) : 0;
	const seconds = secondsStr ? Number(secondsStr) : 0;
	const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
	if (!Number.isFinite(total)) {
		return null;
	}
	return sign === '-' ? -total : total;
};

/** Parse an ISO 8601 instant to Unix milliseconds, or `null` if malformed. @group DASH @public */
export const parseISODateTime = (value: string | null | undefined): number | null => {
	if (!value) {
		return null;
	}
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : null;
};

/** Parse an RFC 7233 single-range string (`"start-end"`). @group DASH @public */
export const parseByteRange = (value: string | null | undefined): { start: number; end: number } | null => {
	if (!value) {
		return null;
	}
	const match = /^(\d+)-(\d+)$/.exec(value.trim());
	if (!match) {
		return null;
	}
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
		return null;
	}
	return { start, end };
};

/** Numerator/denominator pair used for DASH frame rates. @group DASH @public */
export type DashRational = { numerator: number; denominator: number };

/** Parse a DASH frame-rate string (`"30"`, `"30000/1001"`, `"1/2"`). @group DASH @public */
export const parseFrameRate = (value: string | null | undefined): DashRational | null => {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	const slashIdx = trimmed.indexOf('/');
	if (slashIdx >= 0) {
		const numerator = Number(trimmed.slice(0, slashIdx));
		const denominator = Number(trimmed.slice(slashIdx + 1));
		if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
			return null;
		}
		return { numerator, denominator };
	}
	const numerator = Number(trimmed);
	if (!Number.isFinite(numerator) || numerator === 0) {
		return null;
	}
	return { numerator, denominator: 1 };
};

/**
 * Returns `8` when `raw` begins with a `pssh` box header (4-byte size + `'pssh'` 4CC),
 * else `0` — i.e. the byte offset at which the pssh box contents begin. @group DASH @public
 */
export const psshContentsOffset = (raw: Uint8Array): number => {
	if (
		raw.length >= 8
		&& raw[4] === 0x70 && raw[5] === 0x73 && raw[6] === 0x73 && raw[7] === 0x68
	) {
		return 8;
	}
	return 0;
};

/** Normalise a key id to 32 lowercase hex digits, accepting UUID dashes. @group DASH @public */
export const normaliseKeyId = (value: string | null | undefined): string | null => {
	if (!value) {
		return null;
	}
	const stripped = value.replace(/-/g, '').toLowerCase().trim();
	if (!/^[0-9a-f]{32}$/.test(stripped)) {
		return null;
	}
	return stripped;
};

/**
 * Apply SegmentTemplate `$Variable$` substitution. Supports `$Number$`, `$Time$`,
 * `$RepresentationID$`, `$Bandwidth$`, and the printf-like `%0Nd` width modifier.
 * @group DASH @public
 */
export const substituteTemplate = (
	template: string,
	values: { number?: number; time?: number; representationId?: string; bandwidth?: number },
): string => {
	return template.replace(/\$(\$|[A-Za-z]+(?:%0?\d+d)?)\$/g, (match, token: string) => {
		if (token === '$') {
			return '$';
		}
		const pctIdx = token.indexOf('%');
		const name = pctIdx >= 0 ? token.slice(0, pctIdx) : token;
		const fmt = pctIdx >= 0 ? token.slice(pctIdx) : null;
		const raw = pickTemplateValue(name, values);
		if (raw === null) {
			return match;
		}
		if (!fmt) {
			return String(raw);
		}
		return formatPaddedInteger(raw, fmt);
	});
};

const pickTemplateValue = (
	name: string,
	values: { number?: number; time?: number; representationId?: string; bandwidth?: number },
): string | number | null => {
	if (name === 'Number') {
		return values.number ?? null;
	}
	if (name === 'Time') {
		return values.time ?? null;
	}
	if (name === 'RepresentationID') {
		return values.representationId ?? null;
	}
	if (name === 'Bandwidth') {
		return values.bandwidth ?? null;
	}
	return null;
};

const formatPaddedInteger = (raw: string | number, fmt: string): string => {
	const widthMatch = /^%0?(\d+)d$/.exec(fmt);
	if (!widthMatch) {
		return String(raw);
	}
	const width = Number(widthMatch[1]);
	return String(raw).padStart(width, '0');
};
