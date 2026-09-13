/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { escapeXmlAttribute, escapeXmlText } from './misc';

/**
 * A single subtitle cue: one piece of text shown over a span of the presentation.
 * @group Media sources
 * @public
 */
export type SubtitleCue = {
	/** Start of the cue on the media timeline, in seconds. */
	timestamp: number;
	/** How long the cue is shown, in seconds. */
	duration: number;
	/** The cue's text. Line breaks are preserved. */
	text: string;
	/** The cue's identifier, written as the cue's ID by formats that have one. */
	identifier?: string;
	/** WebVTT cue settings, written verbatim after the cue's timings. */
	settings?: string;
	/** Comment text preceding the cue, retained by formats that can carry comments. */
	notes?: string;
};

/**
 * Codec-specific setup data for a subtitle track.
 * @group Media sources
 * @public
 */
export type SubtitleConfig = {
	/** The format's header block, verbatim; for WebVTT, everything before the first cue. */
	description: string;
};

/**
 * Metadata accompanying a subtitle cue.
 * @group Media sources
 * @public
 */
export type SubtitleMetadata = {
	/** The track's configuration. Only the first cue of a track needs to carry it. */
	config?: SubtitleConfig;
};

// A cue spanning a segment boundary belongs to every segment it overlaps; a player joining
// mid-stream only parses the segments it fetched.
/** @internal */
export const cueOverlapsSegment = (cue: SubtitleCue, start: number, end: number) =>
	cue.timestamp < end && (cue.timestamp + cue.duration > start || cue.timestamp >= start);

type SubtitleParserOptions = {
	codec: 'webvtt';
	output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};

const cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;

export class SubtitleParser {
	private options: SubtitleParserOptions;
	private preambleText: string | null = null;
	private preambleEmitted = false;

	constructor(options: SubtitleParserOptions) {
		this.options = options;
	}

	parse(text: string) {
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

		cueBlockHeaderRegex.lastIndex = 0;
		let match: RegExpMatchArray | null;

		if (!this.preambleText) {
			if (!preambleStartRegex.test(text)) {
				throw new Error('WebVTT preamble incorrect.');
			}

			match = cueBlockHeaderRegex.exec(text);
			const preamble = text.slice(0, match?.index ?? text.length).trimEnd();

			if (!preamble) {
				throw new Error('No WebVTT preamble provided.');
			}

			this.preambleText = preamble;

			if (match) {
				text = text.slice(match.index);
				cueBlockHeaderRegex.lastIndex = 0;
			}
		}

		while ((match = cueBlockHeaderRegex.exec(text))) {
			const notes = text.slice(0, match.index);
			const cueIdentifier = match[1];
			const matchEnd = match.index! + match[0].length;
			const bodyStart = text.indexOf('\n', matchEnd) + 1;
			const cueSettings = text.slice(matchEnd, bodyStart).trim();
			let bodyEnd = text.indexOf('\n\n', matchEnd);
			if (bodyEnd === -1) bodyEnd = text.length;

			const startTime = parseSubtitleTimestamp(match[2]!);
			const endTime = parseSubtitleTimestamp(match[3]!);
			const duration = endTime - startTime;

			const body = text.slice(bodyStart, bodyEnd).trim();

			text = text.slice(bodyEnd).trimStart();
			cueBlockHeaderRegex.lastIndex = 0;

			const cue: SubtitleCue = {
				timestamp: startTime / 1000,
				duration: duration / 1000,
				text: body,
				identifier: cueIdentifier,
				settings: cueSettings,
				notes,
			};

			const meta: SubtitleMetadata = {};
			if (!this.preambleEmitted) {
				meta.config = {
					description: this.preambleText,
				};
				this.preambleEmitted = true;
			}

			this.options.output(cue, meta);
		}
	}
}

const timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;
export const parseSubtitleTimestamp = (string: string) => {
	const match = timestampRegex.exec(string);
	if (!match) throw new Error('Expected match.');

	return 60 * 60 * 1000 * Number(match[1] || '0')
		+ 60 * 1000 * Number(match[2])
		+ 1000 * Number(match[3])
		+ Number(match[4]);
};

export const formatSubtitleTimestamp = (timestamp: number) => {
	const hours = Math.floor(timestamp / (60 * 60 * 1000));
	const minutes = Math.floor((timestamp % (60 * 60 * 1000)) / (60 * 1000));
	const seconds = Math.floor((timestamp % (60 * 1000)) / 1000);
	const milliseconds = timestamp % 1000;

	return hours.toString().padStart(2, '0') + ':'
		+ minutes.toString().padStart(2, '0') + ':'
		+ seconds.toString().padStart(2, '0') + '.'
		+ milliseconds.toString().padStart(3, '0');
};

/** @internal */
export const TTML_NAMESPACE = 'http://www.w3.org/ns/ttml';

/**
 * Serializes cues into one IMSC1 text-profile document, timed on the media timeline (`ttp:timeBase="media"`),
 * the way a `stpp` sample carries them.
 *
 * @internal
 */
export const buildTtmlDocument = (options: {
	cues: SubtitleCue[];
	language: string;
}) => {
	const paragraphs = options.cues.map((cue) => {
		const begin = formatSubtitleTimestamp(Math.round(1000 * cue.timestamp));
		const end = formatSubtitleTimestamp(Math.round(1000 * (cue.timestamp + cue.duration)));
		const identifier = cue.identifier ? ` xml:id="${escapeXmlAttribute(cue.identifier)}"` : '';
		const text = cue.text.split('\n').map(escapeXmlText).join('<br/>');

		return `      <p${identifier} begin="${begin}" end="${end}">${text}</p>\n`;
	}).join('');

	return '<?xml version="1.0" encoding="UTF-8"?>\n'
		+ `<tt xmlns="${TTML_NAMESPACE}" xmlns:tts="${TTML_NAMESPACE}#styling"`
		+ ` xmlns:ttp="${TTML_NAMESPACE}#parameter" xmlns:ttm="${TTML_NAMESPACE}#metadata"`
		+ ` xml:lang="${escapeXmlAttribute(options.language)}" xml:space="default"`
		+ ' ttp:timeBase="media" ttp:cellResolution="32 15">\n'
		+ '  <head>\n'
		+ '    <styling>\n'
		+ '      <style xml:id="s0" tts:fontFamily="sansSerif" tts:fontSize="100%" tts:color="white"'
		+ ' tts:textAlign="center"/>\n'
		+ '    </styling>\n'
		+ '    <layout>\n'
		+ '      <region xml:id="r0" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after"'
		+ ' tts:overflow="visible"/>\n'
		+ '    </layout>\n'
		+ '  </head>\n'
		+ '  <body style="s0">\n'
		+ '    <div region="r0">\n'
		+ paragraphs
		+ '    </div>\n'
		+ '  </body>\n'
		+ '</tt>\n';
};

const XML_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: '\'',
};

const xmlEntityRegex = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
const xmlAttributeRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const xmlCommentRegex = /<!--[\s\S]*?-->/g;

const ttmlRootRegex = /<tt(?=[\s/>])([^>]*)>/;
const ttmlTimedContainerRegex = /<(?:body|div)(?=[\s/>])([^>]*)>/g;
const ttmlParagraphRegex = /<p(?=[\s/>])([^>]*)>/g;
const ttmlLineBreakRegex = /<br\s*\/?>/g;
const ttmlTagRegex = /<[^>]*>/g;
const ttmlClockTimeRegex = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const ttmlOffsetTimeRegex = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/;

const decodeXmlEntities = (text: string) => text.replace(xmlEntityRegex, (match, entity: string) => {
	if (entity.startsWith('#x')) {
		return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
	}
	if (entity.startsWith('#')) {
		return String.fromCodePoint(Number(entity.slice(1)));
	}

	// An entity we don't know has no XML-defined expansion; leaving it verbatim keeps the text lossless.
	return XML_ENTITIES[entity] ?? match;
});

const readXmlAttributes = (source: string) => {
	const attributes = new Map<string, string>();

	xmlAttributeRegex.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = xmlAttributeRegex.exec(source))) {
		attributes.set(match[1]!, decodeXmlEntities(match[2] ?? match[3]!));
	}

	return attributes;
};

const parseTtmlTime = (value: string, attributeName: string) => {
	const clockTime = ttmlClockTimeRegex.exec(value);
	if (clockTime) {
		return 60 * 60 * Number(clockTime[1])
			+ 60 * Number(clockTime[2])
			+ Number(clockTime[3])
			+ (clockTime[4] ? Number(`0.${clockTime[4]}`) : 0);
	}

	const offsetTime = ttmlOffsetTimeRegex.exec(value);
	if (offsetTime) {
		const amount = Number(offsetTime[1]);

		switch (offsetTime[2]) {
			case 'h': return 60 * 60 * amount;
			case 'm': return 60 * amount;
			case 's': return amount;
			case 'ms': return amount / 1000;
		}
	}

	throw new Error(
		`Unsupported TTML '${attributeName}' time expression '${value}'.`
		+ ' Only clock times and h/m/s/ms offsets on a media time base can be read exactly.',
	);
};

/**
 * Reads the cues out of a TTML (IMSC1 text profile) document, the inverse of {@link buildTtmlDocument}.
 *
 * Throws on any document whose timing this reader cannot reproduce exactly - a frame- or tick-based time
 * expression, a non-media time base, or timing inherited from a `<body>` or `<div>` ancestor - rather than
 * returning cues that are silently placed wrong.
 *
 * @internal
 */
export const parseTtmlDocument = (xml: string): SubtitleCue[] => {
	const document = xml.replace(xmlCommentRegex, '');

	const root = ttmlRootRegex.exec(document);
	if (!root) {
		throw new Error('Not a TTML document: no <tt> root element.');
	}

	const timeBase = readXmlAttributes(root[1]!).get('ttp:timeBase');
	if (timeBase !== undefined && timeBase !== 'media') {
		throw new Error(`TTML time base '${timeBase}' is not supported; only 'media' is.`);
	}

	// Timing on a <body> or <div> shifts every cue below it; reading the cues as absolute would move them.
	ttmlTimedContainerRegex.lastIndex = 0;
	let container: RegExpExecArray | null;

	while ((container = ttmlTimedContainerRegex.exec(document))) {
		const attributes = readXmlAttributes(container[1]!);

		if (attributes.has('begin') || attributes.has('end') || attributes.has('dur')) {
			throw new Error('TTML timing on a <body> or <div> element is not supported.');
		}
	}

	const cues: SubtitleCue[] = [];

	ttmlParagraphRegex.lastIndex = 0;
	let paragraph: RegExpExecArray | null;

	while ((paragraph = ttmlParagraphRegex.exec(document))) {
		const attributes = readXmlAttributes(paragraph[1]!);

		let body = '';
		if (!paragraph[1]!.trimEnd().endsWith('/')) {
			const bodyEnd = document.indexOf('</p>', ttmlParagraphRegex.lastIndex);
			if (bodyEnd === -1) {
				throw new Error('TTML <p> element is never closed.');
			}

			body = document.slice(ttmlParagraphRegex.lastIndex, bodyEnd);
			ttmlParagraphRegex.lastIndex = bodyEnd + '</p>'.length;
		}

		const begin = attributes.get('begin');
		if (begin === undefined) {
			throw new Error('TTML <p> element has no begin attribute.');
		}

		const timestamp = parseTtmlTime(begin, 'begin');
		const end = attributes.get('end');
		const dur = attributes.get('dur');

		let duration: number;
		if (end !== undefined) {
			duration = parseTtmlTime(end, 'end') - timestamp;
		} else if (dur !== undefined) {
			duration = parseTtmlTime(dur, 'dur');
		} else {
			throw new Error('TTML <p> element has neither an end nor a dur attribute.');
		}

		cues.push({
			timestamp,
			duration,
			text: decodeXmlEntities(body.replace(ttmlLineBreakRegex, '\n').replace(ttmlTagRegex, '')).trim(),
			identifier: attributes.get('xml:id'),
		});
	}

	return cues;
};
