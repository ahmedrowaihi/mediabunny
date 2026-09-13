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
	mas: 'urn:marlin:mas:1-0:services:schemas:mpd',
	xlink: 'http://www.w3.org/1999/xlink',
	scte214: 'urn:scte:dash:scte214-extensions',
	xsi: 'http://www.w3.org/2001/XMLSchema-instance',
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
export type DashRational = {
	/** Frame-rate numerator. */
	numerator: number;
	/** Frame-rate denominator. */
	denominator: number;
};

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
 * The values a `SegmentTemplate` identifier can resolve to.
 * @group DASH
 * @public
 */
export type SegmentTemplateValues = {
	/** `$Number$`: the 1-based index of the segment. */
	number?: number;
	/** `$Time$`: the segment's start time in the representation's timescale. */
	time?: number;
	/** `$Bandwidth$`: the representation's bandwidth in bits per second. */
	bandwidth?: number;
	/** `$RepresentationID$`: the representation's id. */
	representationId?: string;
};

const formatIdentifier = (value: string | number, formatTag: string): string => {
	// Shaped like '%01d', '%05d', '%d' or '%u'; DASH treats the two conversions alike.
	const match = /^%0?(\d*)[du]$/.exec(formatTag);
	if (!match) {
		throw new Error(`Unsupported format tag in segment template: "${formatTag}"`);
	}
	const text = String(value);
	const width = match[1] ? parseInt(match[1], 10) : 0;
	return width <= text.length ? text : '0'.repeat(width - text.length) + text;
};

/**
 * Apply `SegmentTemplate` `$Variable$` substitution, the one engine both the writer and the reader
 * use — a template that writes one name and reads back another is a broken URL.
 *
 * `$$` escapes a literal `$`. Each identifier accepts an optional printf-style format spec, e.g.
 * `$Number%05d$`. An identifier with no value is left verbatim unless `onMissing` is `'throw'`.
 *
 * @group DASH
 * @public
 */
export const substituteTemplate = (
	template: string,
	values: SegmentTemplateValues,
	onMissing: 'keep' | 'throw' = 'keep',
): string => {
	const splits = template.split('$');
	if (splits.length % 2 !== 1) {
		throw new Error(`Invalid segment template "${template}": unbalanced "$"`);
	}

	let result = '';
	for (let i = 0; i < splits.length; i++) {
		const part = splits[i]!;
		if (i % 2 === 0) {
			result += part;
			continue;
		}
		if (part.length === 0) {
			result += '$';
			continue;
		}

		const formatPos = part.indexOf('%');
		const identifier = formatPos === -1 ? part : part.slice(0, formatPos);
		const formatTag = formatPos === -1 ? null : part.slice(formatPos);
		const value = identifier === 'Number'
			? values.number
			: identifier === 'Time'
				? values.time
				: identifier === 'Bandwidth'
					? values.bandwidth
					: identifier === 'RepresentationID' ? values.representationId : undefined;

		if (value === undefined) {
			if (onMissing === 'throw') {
				throw new Error(`Unknown segment-template identifier: "${identifier}"`);
			}
			result += `$${part}$`;
			continue;
		}

		result += formatTag === null ? String(value) : formatIdentifier(value, formatTag);
	}
	return result;
};

/**
 * Build a segment name from a `SegmentTemplate` string, for the writer. Identifiers the caller has
 * no value for throw, since a name that cannot be built must not be written.
 *
 * @group DASH
 * @public
 */
export const getSegmentName = (
	segmentTemplate: string,
	segmentStartTime: number,
	segmentNumber: number,
	bandwidth: number,
): string => substituteTemplate(
	segmentTemplate,
	{ number: segmentNumber, time: segmentStartTime, bandwidth },
	'throw',
);
