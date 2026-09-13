/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseISODuration } from './dash-misc';
import { secondsToXmlDuration } from './dash-mpd-utils';
import { createXmlElement, MinimalDomParser, XmlElement } from './dash-xml-dom-parser';

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
 * `<UTCTiming>`, `<ProgramInformation>`, `<EssentialProperty>`) are preserved.
 * Each imported `<Period>` keeps its subtree intact; only `@id`, `@start`,
 * `@duration`, and the optionally injected `<BaseURL>` are mutated. The root
 * `@mediaPresentationDuration` is set to the sum of the imported Period
 * durations.
 *
 * Parsing and serialization use a built-in XML implementation, so this runs in
 * any runtime and needs no `DOMParser`. Comments and processing instructions
 * are not carried through, and an element's text is emitted after its child
 * elements.
 *
 * @group DASH @public
 */
export const concatMpdPeriods = (inputs: MpdConcatInput[]): MpdConcatResult => {
	if (inputs.length === 0) {
		throw new Error('concatMpdPeriods: at least one input is required');
	}

	const parser = new MinimalDomParser();
	const roots = inputs.map((input, idx) => {
		let root: XmlElement;
		try {
			root = parser.parseFromString(input.xml).documentElement;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`concatMpdPeriods: input ${idx} parse error: ${reason}`);
		}

		if (root.localName !== 'MPD') {
			throw new Error(`concatMpdPeriods: input ${idx} root is <${root.localName}>, expected <MPD>`);
		}
		return root;
	});

	// Taken before the output root is cleared below: input 0's root is that same element.
	const imported = roots.map((root, idx) => {
		const period = root.children.find(child => child.localName === 'Period');
		if (period === undefined) {
			throw new Error(`concatMpdPeriods: input ${idx} has no <Period>`);
		}

		return {
			period,
			duration: parseISODuration(period.getAttribute('duration'))
				?? parseISODuration(root.getAttribute('mediaPresentationDuration'))
				?? 0,
		};
	});

	const outRoot = roots[0]!;
	// Non-Period children (e.g. <UTCTiming>, <ProgramInformation>) stay untouched.
	const kept = outRoot.children.filter(child => child.localName !== 'Period');
	outRoot.children.length = 0;
	outRoot.children.push(...kept);

	let cumulative = 0;
	for (let i = 0; i < inputs.length; i++) {
		const { period, duration } = imported[i]!;

		period.setAttribute('id', String(i));
		period.setAttribute('start', secondsToXmlDuration(cumulative));
		period.setAttribute('duration', secondsToXmlDuration(duration));

		const baseURL = inputs[i]!.baseURL;
		if (baseURL !== undefined && baseURL !== '') {
			period.children.unshift(createXmlElement('BaseURL', baseURL));
		}

		outRoot.children.push(period);
		cumulative += duration;
	}

	outRoot.setAttribute('mediaPresentationDuration', secondsToXmlDuration(cumulative));

	return {
		xml: '<?xml version="1.0" encoding="UTF-8"?>\n' + outRoot.toXml(),
		totalDurationSeconds: cumulative,
	};
};
