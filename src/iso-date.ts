/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const HAS_TIME_ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * `Date.parse` reads an ISO date-time with no zone designator as *local* time (ECMA-262 21.4.3.2),
 * so the same manifest parses differently on every server. Manifest timelines are absolute, and
 * dash.js and shaka both read a zoneless time as UTC, so this appends the designator first.
 *
 * @internal
 */
export const parseIsoDateTimeAsUtc = (value: string): number => {
	return Date.parse(HAS_TIME_ZONE.test(value.trim()) ? value : `${value.trim()}Z`);
};
