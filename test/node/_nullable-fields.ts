/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Reads the optional fields that accept null out of the BUILT declarations, so the runtime checks on
// null-as-absent cover whatever the surface currently has rather than a list that goes stale.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const declarations = (() => {
	try {
		return readFileSync(
			path.join(new URL('../..', import.meta.url).pathname, 'dist/mediabunny.d.ts'),
			'utf8',
		);
	} catch {
		return null;
	}
})();

/** Fields of `body` whose declared type admits null, including inline objects spanning lines. */
const nullableIn = (body: string): string[] => {
	const fields: string[] = [];
	const lines = body.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const single = /^ {4}(\w+)\?:([^;]*);$/.exec(line);
		if (single) {
			if (single[2]!.includes('| null')) {
				fields.push(single[1]!);
			}
			continue;
		}

		// `name?: { ... } | null | undefined;` - every field reported as refusing null was one of
		// these, and reading only single-line declarations hid them.
		const opening = /^ {4}(\w+)\?: [{[]/.exec(line);
		if (!opening) {
			continue;
		}

		for (let j = i + 1; j < lines.length; j++) {
			if (/^ {4}[}\]]/.test(lines[j]!)) {
				if (lines[j]!.includes('| null')) {
					fields.push(opening[1]!);
				}
				i = j;
				break;
			}
		}
	}

	return fields;
};

/** The nullable optional fields of a named option type, following one level of `A & { ... }`. */
export const nullableFieldsOfType = (typeName: string): string[] => {
	if (!declarations) {
		return [];
	}

	const declaration = new RegExp(`type ${typeName}(?:<[^>]*>)? = ([\\s\\S]*?)\\n\\};`)
		.exec(declarations)?.[1];
	if (declaration === undefined) {
		return [];
	}

	const extended = /^(\w+)(?:<[^>]*>)? &/.exec(declaration.trim())?.[1];
	const inherited = extended === undefined ? [] : nullableFieldsOfType(extended);

	return [...new Set([...inherited, ...nullableIn(declaration.slice(declaration.indexOf('{') + 1))])];
};

/**
 * EVERY optional field of a factory's inline options argument, nullable or not. Nullability can be
 * hidden inside an aliased type - `byteRange?: HlsMap["byteRange"] | undefined` - which reading the
 * declaration cannot see, so classifying here would under-report. The fork owns every field of these
 * factories, so the runtime comparison can simply cover all of them and the type fixture enforces
 * the types separately.
 */
export const optionalFieldsOfFactory = (factoryName: string): string[] => {
	if (!declarations) {
		return [];
	}

	const body = new RegExp(`declare const ${factoryName}: \\(options: \\{([\\s\\S]*?)\\n\\}\\)`)
		.exec(declarations)?.[1];
	return body === undefined
		? []
		: [...new Set(body.split('\n')
				.map(l => /^ {4}(\w+)\?:/.exec(l)?.[1])
				.filter((n): n is string => n !== undefined))];
};
