/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { clamp, escapeXmlAttribute, escapeXmlText } from './misc';

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
	identifier?: string | null | undefined;
	/** WebVTT cue settings, written verbatim after the cue's timings. */
	settings?: string | null | undefined;
	/** Comment text preceding the cue, retained by formats that can carry comments. */
	notes?: string;
	/**
	 * The cue's content as styled runs, for formats that can carry styling.
	 *
	 * {@link SubtitleCue.text} stays the source format's own body - a WebVTT cue keeps its `<b>` markup
	 * there, so a WebVTT round trip is unchanged - and a format that carries no styling writes that.
	 * TTML writes these instead when they are present, which is what keeps markup from being escaped
	 * into the document as literal text.
	 */
	runs?: SubtitleTextRun[] | null | undefined;
	/** Where the cue is drawn, for formats that can place it. */
	placement?: SubtitlePlacement | null | undefined;
};

/**
 * One stretch of a cue's text with uniform styling.
 *
 * @group Media sources
 * @public
 */
export type SubtitleTextRun = {
	/** The run's text. Line breaks are preserved. */
	text: string;
	/** Bold. */
	bold?: boolean | null | undefined;
	/** Italic. */
	italic?: boolean | null | undefined;
	/** Underlined. */
	underline?: boolean | null | undefined;
	/** Text colour as a TTML colour expression, such as `#ffff00` or `yellow`. */
	color?: string | null | undefined;
	/** Background colour, in the same form. */
	backgroundColor?: string | null | undefined;
};

/**
 * Where a cue is drawn, as percentages of the whole picture.
 *
 * @group Media sources
 * @public
 */
export type SubtitlePlacement = {
	/** The box's distance from the left and top edges, in percent. */
	origin?: {
		/** Percent from the left edge. */
		x: number;
		/** Percent from the top edge. */
		y: number;
	} | null | undefined;
	/** The box's size, in percent. */
	extent?: {
		/** Percent of the picture's width. */
		width: number;
		/** Percent of the picture's height. */
		height: number;
	} | null | undefined;
	/** Where the lines sit in the box along the block axis. */
	displayAlign?: 'before' | 'center' | 'after' | null | undefined;
	/** Where the lines sit in the box along the inline axis. */
	textAlign?: 'start' | 'center' | 'end' | 'left' | 'right' | null | undefined;
	/** Block and inline direction; `tbrl` and `tblr` are vertical text. */
	writingMode?: 'lrtb' | 'rltb' | 'tbrl' | 'tblr' | null | undefined;
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

/** @internal */
export const cueOverlapsSegment = (cue: SubtitleCue, start: number, end: number) =>
	cue.timestamp < end && (cue.timestamp + cue.duration > start || cue.timestamp >= start);

type SubtitleParserOptions = {
	codec: 'webvtt';
	output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};

const cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2,}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d{2,}):)?(\d{2}):(\d{2}).(\d{3})>/g;

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
			if (text.charCodeAt(0) === 0xFEFF) {
				// Skip the byte order mark the file may start with
				text = text.slice(1);
			}

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
			const lineEnd = text.indexOf('\n', matchEnd);
			const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
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

			const runs = parseWebvttCueBody(body);
			if (runs) {
				cue.runs = runs;
			}
			const placement = parseWebvttSettings(cueSettings);
			if (placement) {
				cue.placement = placement;
			}

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

// WebVTT names eight colours for `<c.yellow>` and eight backgrounds for `<c.bg_yellow>` (WebVTT
// section 6.2). The values are the spec's own, so a converted document shows the colour the cue asked
// for rather than one chosen here.
const WEBVTT_CLASS_COLORS: Record<string, string> = {
	white: '#ffffff',
	lime: '#00ff00',
	cyan: '#00ffff',
	red: '#ff0000',
	yellow: '#ffff00',
	magenta: '#ff00ff',
	blue: '#0000ff',
	black: '#000000',
};

const webvttTagRegex = /<(\/)?([^\s>.]*)((?:\.[^\s>]+)*)(?:[ \t][^>]*)?>/g;

/**
 * Reads a WebVTT cue body into styled runs, or `null` when it carries no markup at all and the body
 * is its own content.
 *
 * Tags that style (`b`, `i`, `u`, `c` with a colour class) open a run; tags that do not (`v`, `lang`,
 * `ruby`, `rt`, and the inline karaoke timestamps) are dropped and their content kept, which is what a
 * receiver that cannot act on them would show.
 *
 * @internal
 */
export const parseWebvttCueBody = (body: string): SubtitleTextRun[] | null => {
	if (!body.includes('<')) {
		return null;
	}

	type Style = Omit<SubtitleTextRun, 'text'>;
	const stack: Style[] = [];
	const runs: SubtitleTextRun[] = [];
	const current = (): Style => stack[stack.length - 1] ?? {};

	const push = (text: string) => {
		if (text === '') {
			return;
		}

		const style = current();
		const last = runs[runs.length - 1];
		// Merge with the run before it when nothing about the styling changed, so dropping a `<v>` does
		// not split one sentence into three runs
		if (last && sameRunStyle(last, style)) {
			last.text += text;
			return;
		}

		runs.push({ ...style, text });
	};

	let position = 0;
	webvttTagRegex.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = webvttTagRegex.exec(body))) {
		push(decodeXmlEntities(body.slice(position, match.index)));
		position = webvttTagRegex.lastIndex;

		const closing = match[1] !== undefined;
		const name = match[2]!;
		const classes = match[3] ? match[3].slice(1).split('.') : [];

		if (name === '') {
			continue; // An inline timestamp, which marks karaoke timing rather than styling
		}

		if (closing) {
			stack.pop();
			continue;
		}

		const style: Style = { ...current() };
		if (name === 'b') {
			style.bold = true;
		} else if (name === 'i') {
			style.italic = true;
		} else if (name === 'u') {
			style.underline = true;
		}

		for (const className of classes) {
			const background = className.startsWith('bg_');
			const color = WEBVTT_CLASS_COLORS[background ? className.slice(3) : className];
			if (color === undefined) {
				continue; // A class the spec does not name is a styling hook, not a colour
			}

			if (background) {
				style.backgroundColor = color;
			} else {
				style.color = color;
			}
		}

		stack.push(style);
	}

	push(decodeXmlEntities(body.slice(position)));

	return runs.length > 0 ? runs : null;
};

const sameRunStyle = (a: Omit<SubtitleTextRun, 'text'>, b: Omit<SubtitleTextRun, 'text'>) =>
	!!a.bold === !!b.bold
	&& !!a.italic === !!b.italic
	&& !!a.underline === !!b.underline
	&& a.color === b.color
	&& a.backgroundColor === b.backgroundColor;

const webvttPercentRegex = /^(\d+(?:\.\d+)?)%$/;
const WEBVTT_ALIGNMENTS = ['start', 'center', 'end', 'left', 'right'] as const;

/**
 * Reads WebVTT cue settings into a placement box, or `null` when they place nothing.
 *
 * WebVTT states an **anchor** rather than a box corner: `position` is where the given fraction of the
 * line sits, and that fraction follows the alignment unless `position` names its own. So the box's
 * left edge is `position - fraction * size`, which is the mapping a receiver performs too.
 *
 * A line stated as a line *number* rather than a percentage is not placed: how far down it falls
 * depends on the line height and the region, neither of which a cue states.
 *
 * @internal
 */
export const parseWebvttSettings = (settings: string): SubtitlePlacement | null => {
	if (!settings) {
		return null;
	}

	const values = new Map<string, string>();
	for (const setting of settings.trim().split(/\s+/)) {
		const colon = setting.indexOf(':');
		if (colon > 0) {
			values.set(setting.slice(0, colon), setting.slice(colon + 1));
		}
	}

	const placement: SubtitlePlacement = {};

	const align = values.get('align');
	if (align !== undefined && (WEBVTT_ALIGNMENTS as readonly string[]).includes(align)) {
		placement.textAlign = align as SubtitlePlacement['textAlign'];
	}

	const vertical = values.get('vertical');
	if (vertical === 'rl') {
		placement.writingMode = 'tbrl';
	} else if (vertical === 'lr') {
		placement.writingMode = 'tblr';
	}

	const percent = (value: string | undefined) => {
		const match = value === undefined ? null : webvttPercentRegex.exec(value.split(',')[0]!);
		return match ? Number(match[1]) : null;
	};

	const size = percent(values.get('size')) ?? 100;
	const position = percent(values.get('position'));
	const line = percent(values.get('line'));

	if (position !== null || line !== null || values.has('size')) {
		const anchor = values.get('position')?.split(',')[1];
		const fraction = anchor === 'line-left'
			? 0
			: anchor === 'line-right'
				? 1
				: anchor === 'center'
					? 0.5
					// Stated by the alignment when `position` does not name one of its own
					: placement.textAlign === 'center'
						? 0.5
						: placement.textAlign === 'end' || placement.textAlign === 'right'
							? 1
							: 0;

		const x = position === null ? 0 : clamp(position - fraction * size, 0, 100);
		const y = line ?? 0;

		placement.origin = { x, y };
		// The box runs from the line to the bottom of the picture, which is what lets a cue of any
		// number of lines start where the line names
		placement.extent = { width: Math.min(size, 100 - x), height: 100 - y };
		placement.displayAlign = 'before';
	}

	return Object.keys(placement).length > 0 ? placement : null;
};

const timestampRegex = /(?:(\d{2,}):)?(\d{2}):(\d{2}).(\d{3})/;
export const parseSubtitleTimestamp = (string: string) => {
	const match = timestampRegex.exec(string);
	if (!match) throw new Error('Expected match.');

	return 60 * 60 * 1000 * Number(match[1] || '0')
		+ 60 * 1000 * Number(match[2])
		+ 1000 * Number(match[3])
		+ Number(match[4]);
};

export const formatSubtitleTimestamp = (timeInSeconds: number) => {
	const totalMilliseconds = Math.round(1000 * timeInSeconds);
	const hours = Math.floor(totalMilliseconds / (60 * 60 * 1000));
	const minutes = Math.floor((totalMilliseconds % (60 * 60 * 1000)) / (60 * 1000));
	const seconds = Math.floor((totalMilliseconds % (60 * 1000)) / 1000);
	const milliseconds = totalMilliseconds % 1000;

	return hours.toString().padStart(2, '0') + ':'
		+ minutes.toString().padStart(2, '0') + ':'
		+ seconds.toString().padStart(2, '0') + '.'
		+ milliseconds.toString().padStart(3, '0');
};

/** @internal */
export const TTML_NAMESPACE = 'http://www.w3.org/ns/ttml';
/** EBU-TT Styling, Tech 3380 §2.6. @internal */
export const EBUTTS_NAMESPACE = 'urn:ebu:tt:style';
/** EBU-TT Metadata, Tech 3380 §2.6. @internal */
export const EBUTTM_NAMESPACE = 'urn:ebu:tt:metadata';
/** The value Tech 3380 §2.9 requires when signalling conformance to EBU-TT-D. @internal */
export const EBU_TT_D_CONFORMS_TO = 'urn:ebu:tt:distribution:2018-04';

/**
 * The default region every unplaced cue sits in, and the box a partial placement fills itself from.
 *
 * @internal
 */
const DEFAULT_REGION = {
	origin: { x: 10, y: 10 },
	extent: { width: 80, height: 80 },
	displayAlign: 'after' as const,
};

/** The IMSC1 text profile, which `ttp:contentProfiles` names so a document states what it conforms to. */
export const IMSC1_TEXT_PROFILE = 'http://www.w3.org/ns/ttml/profile/imsc1/text';

/** The SMPTE-TT extension namespace, SMPTE ST 2052-1. @internal */
export const SMPTE_TT_NAMESPACE = 'http://www.smpte-ra.org/schemas/2052-1/2010/smpte-tt';
/**
 * The designator SMPTE-TT's full profile is named by, which `ttp:profile` carries on the root.
 *
 * ST 2052-1 is not public, so this is quoted from W3C IMSC 1.1 Annex I.4, whose Example 17 writes a
 * document conforming to both the IMSC text profile and SMPTE-ST-2052-1.
 *
 * @internal
 */
export const SMPTE_TT_FULL_PROFILE = 'http://www.smpte-ra.org/schemas/2052-1/2010/profiles/smpte-tt-full';

/**
 * Which TTML profile a document is written to.
 *
 * @group Media sources
 * @public
 */
export type TtmlProfile = 'imsc1' | 'ebu-tt-d' | 'smpte-tt';

/** @internal */
export const TTML_PROFILES: TtmlProfile[] = ['imsc1', 'ebu-tt-d', 'smpte-tt'];

/**
 * Writes one TTML document from a list of cues.
 *
 * The same document a `stpp` track carries, as a string. Caption delivery is often a **sidecar file**
 * rather than a muxed track - MediaConvert's TTML, IMSC1 and EBU-TT-D destinations all are - and
 * writing one through an `Output` to recover the bytes is a long way round for something that is one
 * function call.
 *
 * Timed on the media timeline (`ttp:timeBase="media"`), so the cue timestamps are the ones given here.
 *
 * @public
 * @group Media sources
 */
export const ttmlDocumentOf = (options: {
	/** The cues, in any order; they are written as given. */
	cues: SubtitleCue[];
	/** The document's `xml:lang`. */
	language: string;
	/** Which profile to write. Defaults to `imsc1`. */
	profile?: TtmlProfile | null | undefined;
}): string => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (!Array.isArray(options.cues)) {
		throw new TypeError('options.cues must be an array.');
	}
	if (typeof options.language !== 'string' || options.language === '') {
		throw new TypeError('options.language must be a non-empty string.');
	}
	if (options.profile != null && !TTML_PROFILES.includes(options.profile)) {
		throw new TypeError(`options.profile, when provided, must be one of ${TTML_PROFILES.join(', ')}.`);
	}

	return buildTtmlDocument(options);
};

/**
 * Serializes cues into one IMSC1 text-profile document, timed on the media timeline (`ttp:timeBase="media"`),
 * the way a `stpp` sample carries them.
 *
 * @internal
 */
export const buildTtmlDocument = (options: {
	cues: SubtitleCue[];
	language: string;
	profile?: TtmlProfile | null | undefined;
}) => {
	// No tts:extent on tt:tt: Tech 3380's Annex B does not list it, and tts: being a TT namespace puts it
	// outside the "any attribute not in a TT namespace" allowance
	const ebu = options.profile === 'ebu-tt-d';
	const smpte = options.profile === 'smpte-tt';

	// 1. A region per distinct placement, since a region is the only thing that can carry one. r0 is
	//    the default every unplaced cue sits in.
	const regions = new Map<string, { id: string; placement: SubtitlePlacement }>();
	const regionIdOf = (placement: SubtitlePlacement | null | undefined) => {
		const boxed = placement
			&& (placement.origin || placement.extent || placement.displayAlign || placement.writingMode);
		if (!boxed) {
			return null;
		}

		const key = JSON.stringify([
			placement.origin, placement.extent, placement.displayAlign, placement.writingMode,
		]);
		let region = regions.get(key);
		if (!region) {
			region = { id: `r${regions.size + 1}`, placement };
			regions.set(key, region);
		}

		return region.id;
	};

	// 2. The paragraphs, which decide which regions exist
	const paragraphs = options.cues.map((cue) => {
		const begin = formatSubtitleTimestamp(cue.timestamp);
		const end = formatSubtitleTimestamp(cue.timestamp + cue.duration);
		const identifier = cue.identifier ? ` xml:id="${escapeXmlAttribute(cue.identifier)}"` : '';
		const regionId = regionIdOf(cue.placement);
		const region = regionId ? ` region="${regionId}"` : '';
		const textAlign = cue.placement?.textAlign
			? ` tts:textAlign="${cue.placement.textAlign}"`
			: '';
		const content = cue.runs
			? cue.runs.map(writeTtmlRun).join('')
			: cue.text.split('\n').map(escapeXmlText).join('<br/>');

		return `      <p${identifier}${region} begin="${begin}" end="${end}"${textAlign}>${content}</p>\n`;
	}).join('');

	// 3. The layout, now that every placement has been seen. What a placement does not state it takes
	//    from the default region rather than leaving out: a region with no extent covers the whole
	//    frame, so a cue that only asked for vertical text would also have moved and grown.
	const placedRegions = [...regions.values()].map(({ id, placement }) => {
		const origin = placement.origin ?? DEFAULT_REGION.origin;
		const extent = placement.extent ?? DEFAULT_REGION.extent;
		const displayAlign = placement.displayAlign ?? DEFAULT_REGION.displayAlign;
		const writingMode = placement.writingMode ? ` tts:writingMode="${placement.writingMode}"` : '';

		return `      <region xml:id="${id}"`
			+ ` tts:origin="${formatPercent(origin.x)} ${formatPercent(origin.y)}"`
			+ ` tts:extent="${formatPercent(extent.width)} ${formatPercent(extent.height)}"`
			+ ` tts:displayAlign="${displayAlign}"${writingMode}`
			+ ' tts:overflow="visible"/>\n';
	}).join('');

	return '<?xml version="1.0" encoding="UTF-8"?>\n'
		+ `<tt xmlns="${TTML_NAMESPACE}" xmlns:tts="${TTML_NAMESPACE}#styling"`
		+ ` xmlns:ttp="${TTML_NAMESPACE}#parameter" xmlns:ttm="${TTML_NAMESPACE}#metadata"`
		+ (ebu ? ` xmlns:ebutts="${EBUTTS_NAMESPACE}" xmlns:ebuttm="${EBUTTM_NAMESPACE}"` : '')
		+ (smpte ? ` xmlns:smpte="${SMPTE_TT_NAMESPACE}"` : '')
		+ ` xml:lang="${escapeXmlAttribute(options.language)}" xml:space="default"`
		+ ' ttp:timeBase="media" ttp:cellResolution="32 15"'
		// An IMSC1 document that does not name its profile leaves a receiver to infer one from the
		// markup. EBU-TT-D says what it is through ebuttm:conformsToStandard instead, below, and
		// SMPTE-TT through ttp:profile, which is how IMSC 1.1 Annex I.4 writes one.
		// IMSC 1.1 section 6.3 allows both: a 1.0.1 processor reads `ttp:profile` and finds nothing in
		// `ttp:contentProfiles`, which 1.1 introduced, so a document stating only the latter has no
		// profile as far as it is concerned
		+ (ebu || smpte ? '' : ` ttp:profile="${IMSC1_TEXT_PROFILE}"`)
		+ (ebu || smpte ? '' : ` ttp:contentProfiles="${IMSC1_TEXT_PROFILE}"`)
		+ (smpte ? ` ttp:profile="${SMPTE_TT_FULL_PROFILE}"` : '')
		+ '>\n'
		+ '  <head>\n'
		+ (ebu
			? '    <metadata>\n'
			+ `      <ebuttm:conformsToStandard>${EBU_TT_D_CONFORMS_TO}</ebuttm:conformsToStandard>\n`
			+ '    </metadata>\n'
			: '')
		+ '    <styling>\n'
		+ '      <style xml:id="s0" tts:fontFamily="sansSerif" tts:fontSize="100%" tts:color="white"'
		+ (ebu ? ' tts:backgroundColor="black" tts:lineHeight="125%" ebutts:linePadding="0.5c"' : '')
		+ ' tts:textAlign="center"/>\n'
		+ '    </styling>\n'
		+ '    <layout>\n'
		+ `      <region xml:id="r0" tts:origin="${formatPercent(DEFAULT_REGION.origin.x)}`
		+ ` ${formatPercent(DEFAULT_REGION.origin.y)}"`
		+ ` tts:extent="${formatPercent(DEFAULT_REGION.extent.width)}`
		+ ` ${formatPercent(DEFAULT_REGION.extent.height)}"`
		+ ` tts:displayAlign="${DEFAULT_REGION.displayAlign}" tts:overflow="visible"/>\n`
		+ placedRegions
		+ '    </layout>\n'
		+ '  </head>\n'
		+ '  <body style="s0">\n'
		+ '    <div region="r0">\n'
		+ paragraphs
		+ '    </div>\n'
		+ '  </body>\n'
		+ '</tt>\n';
};

/** Trims the trailing zeros a percentage picks up from the arithmetic that produced it. */
const formatPercent = (value: number) => `${+value.toFixed(4)}%`;

const writeTtmlRun = (run: SubtitleTextRun) => {
	const text = run.text.split('\n').map(escapeXmlText).join('<br/>');

	const attributes = (run.bold ? ' tts:fontWeight="bold"' : '')
		+ (run.italic ? ' tts:fontStyle="italic"' : '')
		+ (run.underline ? ' tts:textDecoration="underline"' : '')
		+ (run.color ? ` tts:color="${escapeXmlAttribute(run.color)}"` : '')
		+ (run.backgroundColor ? ` tts:backgroundColor="${escapeXmlAttribute(run.backgroundColor)}"` : '');

	// A run that styles nothing is the paragraph's own text; wrapping it would say something the cue
	// did not
	return attributes ? `<span${attributes}>${text}</span>` : text;
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
const ttmlRegionRegex = /<region(?=[\s/>])([^>]*)>/g;
const ttmlSpanTagRegex = /<(\/)?span(?=[\s/>])([^>]*)>/g;
const ttmlPercentPairRegex = /^(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/;
// A clock time ends either in a fraction of a second or in a frame count, and the two mean different
// things: `00:04:12.06` is 60 ms, `00:04:12:06` is six frames, which at 24000/1001 is 250 ms
const ttmlClockTimeRegex = /^(\d+):(\d{2}):(\d{2})(?:(\.\d+)|:(\d{2,}))?$/;
const ttmlOffsetTimeRegex = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/;
const ttmlRatioRegex = /^(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?$/;

const decodeXmlEntities = (text: string) => text.replace(xmlEntityRegex, (match, entity: string) => {
	if (entity.startsWith('#x')) {
		return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
	}
	if (entity.startsWith('#')) {
		return String.fromCodePoint(Number(entity.slice(1)));
	}

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

/**
 * The rates a document's time expressions are stated against, which only the root element says.
 *
 * Defaults are TTML1 section 7.2: a frame rate of 30 with a 1:1 multiplier, and a tick rate that
 * follows the frame rate where one is given and is otherwise 1.
 */
type TtmlRates = {
	effectiveFrameRate: number;
	tickRate: number;
};

const readTtmlRates = (root: Map<string, string>): TtmlRates => {
	const frameRate = Number(root.get('ttp:frameRate') ?? 30);
	const multiplier = ttmlRatioRegex.exec(root.get('ttp:frameRateMultiplier') ?? '1 1');
	const subFrameRate = Number(root.get('ttp:subFrameRate') ?? 1);

	const numerator = multiplier ? Number(multiplier[1]) : 1;
	const denominator = multiplier && multiplier[2] !== undefined ? Number(multiplier[2]) : 1;

	const effectiveFrameRate = Number.isFinite(frameRate) && frameRate > 0 && denominator > 0
		? frameRate * numerator / denominator
		: 30;

	const statedTickRate = root.get('ttp:tickRate');
	const tickRate = statedTickRate !== undefined
		? Number(statedTickRate)
		// Not stated: ticks follow the frame rate where the document gives one, and are seconds otherwise
		: root.has('ttp:frameRate') ? effectiveFrameRate * subFrameRate : 1;

	return {
		effectiveFrameRate,
		tickRate: Number.isFinite(tickRate) && tickRate > 0 ? tickRate : 1,
	};
};

const parseTtmlTime = (value: string, attributeName: string, rates: TtmlRates) => {
	const clockTime = ttmlClockTimeRegex.exec(value);
	if (clockTime) {
		const seconds = 60 * 60 * Number(clockTime[1])
			+ 60 * Number(clockTime[2])
			+ Number(clockTime[3]);

		// The last field is a fraction of a second or a frame count, never both
		if (clockTime[4] !== undefined) {
			return seconds + Number(`0${clockTime[4]}`);
		}
		if (clockTime[5] !== undefined) {
			return seconds + Number(clockTime[5]) / rates.effectiveFrameRate;
		}

		return seconds;
	}

	const offsetTime = ttmlOffsetTimeRegex.exec(value);
	if (offsetTime) {
		const amount = Number(offsetTime[1]);

		switch (offsetTime[2]) {
			case 'h': return 60 * 60 * amount;
			case 'm': return 60 * amount;
			case 's': return amount;
			case 'ms': return amount / 1000;
			case 'f': return amount / rates.effectiveFrameRate;
			case 't': return amount / rates.tickRate;
		}
	}

	throw new Error(
		`Unsupported TTML '${attributeName}' time expression '${value}'.`
		+ ' Only a media time base is supported.',
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
const readTtmlRegions = (document: string) => {
	const regions = new Map<string, SubtitlePlacement>();

	ttmlRegionRegex.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = ttmlRegionRegex.exec(document))) {
		const attributes = readXmlAttributes(match[1]!);
		const id = attributes.get('xml:id');
		if (id === undefined) {
			continue;
		}

		const placement: SubtitlePlacement = {};

		const origin = ttmlPercentPairRegex.exec(attributes.get('tts:origin') ?? '');
		if (origin) {
			placement.origin = { x: Number(origin[1]), y: Number(origin[2]) };
		}

		const extent = ttmlPercentPairRegex.exec(attributes.get('tts:extent') ?? '');
		if (extent) {
			placement.extent = { width: Number(extent[1]), height: Number(extent[2]) };
		}

		const displayAlign = attributes.get('tts:displayAlign');
		if (displayAlign === 'before' || displayAlign === 'center' || displayAlign === 'after') {
			placement.displayAlign = displayAlign;
		}

		const writingMode = attributes.get('tts:writingMode');
		if (writingMode === 'lrtb' || writingMode === 'rltb' || writingMode === 'tbrl' || writingMode === 'tblr') {
			placement.writingMode = writingMode;
		}

		regions.set(id, placement);
	}

	return regions;
};

/**
 * Reads a `<p>` body into styled runs, or `null` when nothing in it is styled - in which case the
 * paragraph's plain text is its own content and runs would say nothing the text does not.
 */
const readTtmlRuns = (body: string): SubtitleTextRun[] | null => {
	if (!body.includes('<span')) {
		return null;
	}

	const runs: SubtitleTextRun[] = [];
	const stack: Omit<SubtitleTextRun, 'text'>[] = [];

	const push = (fragment: string) => {
		const text = decodeXmlEntities(fragment.replace(ttmlLineBreakRegex, '\n').replace(ttmlTagRegex, ''));
		if (text === '') {
			return;
		}

		const style = stack[stack.length - 1] ?? {};
		const last = runs[runs.length - 1];
		if (last && sameRunStyle(last, style)) {
			last.text += text;
			return;
		}

		runs.push({ ...style, text });
	};

	let position = 0;
	ttmlSpanTagRegex.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = ttmlSpanTagRegex.exec(body))) {
		push(body.slice(position, match.index));
		position = ttmlSpanTagRegex.lastIndex;

		if (match[1] !== undefined) {
			stack.pop();
			continue;
		}

		const attributes = readXmlAttributes(match[2]!);
		const style: Omit<SubtitleTextRun, 'text'> = { ...stack[stack.length - 1] };

		if (attributes.get('tts:fontWeight') === 'bold') {
			style.bold = true;
		}
		if (attributes.get('tts:fontStyle') === 'italic') {
			style.italic = true;
		}
		if (attributes.get('tts:textDecoration')?.split(/\s+/).includes('underline')) {
			style.underline = true;
		}
		const color = attributes.get('tts:color');
		if (color !== undefined) {
			style.color = color;
		}
		const backgroundColor = attributes.get('tts:backgroundColor');
		if (backgroundColor !== undefined) {
			style.backgroundColor = backgroundColor;
		}

		stack.push(style);

		if (match[2]!.trimEnd().endsWith('/')) {
			stack.pop(); // A self-closing span holds nothing
		}
	}

	push(body.slice(position));

	// Only when something is actually styled. ffmpeg wraps every cue body in a bare `<span>`, so a
	// document full of them would hand back a run per cue saying exactly what the cue's text says.
	const styled = runs.some(run => run.bold || run.italic || run.underline || run.color || run.backgroundColor);
	return styled ? runs : null;
};

export const parseTtmlDocument = (xml: string): SubtitleCue[] => {
	const document = xml.replace(xmlCommentRegex, '');

	const root = ttmlRootRegex.exec(document);
	if (!root) {
		throw new Error('Not a TTML document: no <tt> root element.');
	}

	const rootAttributes = readXmlAttributes(root[1]!);
	const timeBase = rootAttributes.get('ttp:timeBase');
	if (timeBase !== undefined && timeBase !== 'media') {
		throw new Error(`TTML time base '${timeBase}' is not supported; only 'media' is.`);
	}

	// Only the root states these, and a frame or tick expression means nothing without them
	const rates = readTtmlRates(rootAttributes);

	ttmlTimedContainerRegex.lastIndex = 0;
	let container: RegExpExecArray | null;

	while ((container = ttmlTimedContainerRegex.exec(document))) {
		const attributes = readXmlAttributes(container[1]!);

		if (attributes.has('begin') || attributes.has('end') || attributes.has('dur')) {
			throw new Error('TTML timing on a <body> or <div> element is not supported.');
		}
	}

	const regions = readTtmlRegions(document);
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

		const timestamp = parseTtmlTime(begin, 'begin', rates);
		const end = attributes.get('end');
		const dur = attributes.get('dur');

		let duration: number;
		if (end !== undefined) {
			duration = parseTtmlTime(end, 'end', rates) - timestamp;
		} else if (dur !== undefined) {
			duration = parseTtmlTime(dur, 'dur', rates);
		} else {
			throw new Error('TTML <p> element has neither an end nor a dur attribute.');
		}

		const cue: SubtitleCue = {
			timestamp,
			duration,
			text: decodeXmlEntities(body.replace(ttmlLineBreakRegex, '\n').replace(ttmlTagRegex, '')).trim(),
			identifier: attributes.get('xml:id'),
		};

		const runs = readTtmlRuns(body);
		if (runs) {
			cue.runs = runs;
		}

		// The default region every unplaced paragraph sits in says nothing about the cue, so a cue that
		// names no region of its own comes back unplaced rather than carrying the document's furniture
		const region = attributes.get('region');
		const placement: SubtitlePlacement = region !== undefined ? { ...regions.get(region) } : {};
		const textAlign = attributes.get('tts:textAlign');
		if (
			textAlign === 'start' || textAlign === 'center' || textAlign === 'end'
			|| textAlign === 'left' || textAlign === 'right'
		) {
			placement.textAlign = textAlign;
		}
		if (Object.keys(placement).length > 0) {
			cue.placement = placement;
		}

		cues.push(cue);
	}

	return cues;
};
