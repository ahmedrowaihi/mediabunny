/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// The ports in src/crypto, src/dash and src/isobmff are checked against shaka-packager's own test media,
// which is a sibling checkout rather than a fixture in this repo — so it is absent in CI and for anyone who
// has not cloned it beside this one. Those tests skip there instead of failing on a missing file.
const CORPUS = path.join(
	new URL('.', import.meta.url).pathname,
	'../../../shaka-packager/packager/media/test/data',
);

export const hasShakaCorpus = existsSync(CORPUS);

/** Reads from shaka-packager's test data, or nothing where it is absent — a skipped describe body still runs. */
export const readCorpus = (name: string) =>
	hasShakaCorpus ? new Uint8Array(readFileSync(shakaData(name))) : new Uint8Array();

/** Resolves a file in shaka-packager's test data. Gate its tests with `skipIf(!hasShakaCorpus)`. */
export const shakaData = (name: string) => path.join(CORPUS, name);
