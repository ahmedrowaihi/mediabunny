/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseISODuration } from './dash-misc';
import { secondsToXmlDuration } from './dash-mpd-utils';

const MPD_NS = 'urn:mpeg:dash:schema:mpd:2011';

/** One input MPD for {@link concatMpdPeriods}. @group DASH @public */
export type MpdConcatInput = {
	/** Source MPD XML. The first `<Period>` is taken. */
	xml: string;
	/**
	 * Optional URL inserted as a `<BaseURL>` at the top of the imported
	 * `<Period>` so its relative segment references resolve against it.
	 */
	baseURL?: string;
};

/** Result of {@link concatMpdPeriods}. @group DASH @public */
export type MpdConcatResult = {
	/** Serialized output MPD. */
	xml: string;
	/** Sum of input `<Period>` durations, in seconds. */
	totalDurationSeconds: number;
};

/**
 * Concatenate the first `<Period>` of every input MPD into a single
 * multi-period output MPD. This is a low-level building block: no filtering,
 * normalization, or AdaptationSet validation is performed. Callers that need
 * those should compose this with their own pre/post passes.
 *
 * The first input is used as the output base — its `<MPD>` root attributes,
 * namespace declarations, and non-`<Period>` root-level children (e.g.
 * `<UTCTiming>`, `<ProgramInformation>`, `<EssentialProperty>`) are preserved
 * unmodified. Each imported `<Period>` keeps its full subtree intact via
 * `Node.importNode`; only `@id`, `@start`, `@duration`, and the optionally
 * injected `<BaseURL>` are mutated. The root `@mediaPresentationDuration` is
 * set to the sum of the imported Period durations.
 *
 * @group DASH @public
 */
export const concatMpdPeriods = (inputs: MpdConcatInput[]): MpdConcatResult => {
	if (inputs.length === 0) {
		throw new Error('concatMpdPeriods: at least one input is required');
	}
	if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
		throw new Error('concatMpdPeriods requires DOMParser and XMLSerializer (browser environment)');
	}

	const parser = new DOMParser();
	const parsed = inputs.map((input, idx) => {
		const doc = parser.parseFromString(input.xml, 'application/xml');
		const parseError = doc.getElementsByTagName('parsererror')[0];
		if (parseError) {
			throw new Error(`concatMpdPeriods: input ${idx} parse error: ${parseError.textContent ?? 'unknown'}`);
		}
		const rootName = doc.documentElement.localName;
		if (rootName !== 'MPD') {
			throw new Error(`concatMpdPeriods: input ${idx} root is <${rootName}>, expected <MPD>`);
		}
		return doc;
	});

	const outDoc = parsed[0]!;
	const outRoot = outDoc.documentElement;

	// Remove existing Period children so they can be replaced with the stitched ones.
	// Non-Period children (e.g. <UTCTiming>, <ProgramInformation>) stay untouched.
	const existingPeriods: Element[] = [];
	for (let i = 0; i < outRoot.children.length; i++) {
		const child = outRoot.children[i]!;
		if (child.localName === 'Period') {
			existingPeriods.push(child);
		}
	}
	for (const p of existingPeriods) {
		outRoot.removeChild(p);
	}

	let cumulative = 0;
	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i]!;
		const doc = parsed[i]!;
		const period = firstChildByLocalName(doc.documentElement, 'Period');
		if (!period) {
			throw new Error(`concatMpdPeriods: input ${i} has no <Period>`);
		}

		const duration
			= parseISODuration(period.getAttribute('duration'))
				?? parseISODuration(doc.documentElement.getAttribute('mediaPresentationDuration'))
				?? 0;

		const imported = i === 0 ? period : outDoc.importNode(period, true);
		imported.setAttribute('id', String(i));
		imported.setAttribute('start', secondsToXmlDuration(cumulative));
		imported.setAttribute('duration', secondsToXmlDuration(duration));

		if (input.baseURL) {
			const baseUrl = outDoc.createElementNS(MPD_NS, 'BaseURL');
			baseUrl.textContent = input.baseURL;
			imported.insertBefore(baseUrl, imported.firstChild);
		}

		outRoot.appendChild(imported);
		cumulative += duration;
	}

	outRoot.setAttribute('mediaPresentationDuration', secondsToXmlDuration(cumulative));

	const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(outRoot);

	return { xml, totalDurationSeconds: cumulative };
};

const firstChildByLocalName = (parent: Element, name: string): Element | null => {
	for (let i = 0; i < parent.children.length; i++) {
		const child = parent.children[i]!;
		if (child.localName === name) {
			return child;
		}
	}
	return null;
};
