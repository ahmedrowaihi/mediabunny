/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { buildAdtsHeaderTemplate, parseAacAudioSpecificConfig, writeAdtsFrameLength } from '../../shared/aac-misc';
import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import { InvalidUsageError, UnsupportedMediaError } from '../errors';
import { sampleAesEncryptAdtsFrame, sampleAesEncryptAnnexBAccessUnit } from '../crypto/sample-aes';
import {
	AC3_REGISTRATION_DESCRIPTOR,
	CUEI_REGISTRATION_DESCRIPTOR,
	AvcDecoderConfigurationRecord,
	AvcNalUnitType,
	concatNalUnitsInAnnexB,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	EAC3_REGISTRATION_DESCRIPTOR,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
} from '../codec-data';
import { type LhvcConfig, parseLhvcConfigRecord } from '../mvhevc';
import { type VideoDecoderConfigWithHdr } from '../hdr-metadata';
import { Bitstream } from '../../shared/bitstream';
import {
	assert,
	DEFAULT_MAX_INTERLEAVE_DELTA,
	UNDETERMINED_LANGUAGE,
	promiseWithResolvers,
	setUint24,
	toDataView,
	toUint8Array,
	textEncoder,
} from '../misc';
import { Muxer } from '../muxer';
import type { AvcSpsInfo } from '../codec-data';
import { parseAvcSps } from '../codec-data';
import type { StartTimecode } from '../input-track';
import { parseTimecode, writeTimecodeIntoAccessUnit } from '../timecode';
import { audioSpecificConfigBitLength, buildLoasFrame } from '../aac-latm';
import { buildNit, buildTdt, buildTot } from './mpeg-ts-misc';

/** Framing marker for the NAL helpers: no description means Annex B. */
const ANNEX_B_CONFIG: VideoDecoderConfig = { codec: '' };
import { Output, OutputAudioTrack, OutputTrack, OutputVideoTrack } from '../output';
import { MpegTsOutputFormat, MpegTsPrivateStreamDeclaration } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildMpegTsMimeType,
	LANGUAGE_DESCRIPTOR_TAG,
	MpegTsStreamType,
	buildAudioSetupDescriptor,
	buildPrivateDataIndicatorDescriptor,
	secondsToMpegTsTimestamp,
	TS_PACKET_SIZE,
	METADATA_IN_PES_STREAM_TYPE,
	buildId3MetadataDescriptor,
	computeMpegTsCrc32,
	NULL_PACKET_PID,
} from './mpeg-ts-misc';

// Resources:
// ISO/IEC 13818-1

const EMPTY_PAYLOAD = new Uint8Array(0);
const PAT_PID = 0x0000;
const SDT_PID = 0x0011;
const NIT_PID = 0x0010;
/** Both the TDT and the TOT ride here, EN 300 468 5.2.5 and 5.2.6. */
const TDT_PID = 0x0014;
/**
 * Slack on "is another PCR due before this instant", in seconds. Far below any spacing requirement
 * and far above the rounding in a timestamp computed as a fraction.
 */
const PCR_FILL_EPSILON = 1e-9;

/** Seconds of stream a burst may run ahead of `muxRate` before the rate is declared too low. */
const CBR_LEAD_ALLOWANCE = 0.5;
const DEFAULT_PMT_PID = 0x1000;
/** SCTE 35, which shares type 0x86 with Blu-ray DTS-HD and is told apart by its registration. */
const SCTE35_STREAM_TYPE = 0x86;
const FIRST_TRACK_PID = 0x0100;

/** `private_stream_1`, which is what carries teletext and DVB subtitle PES packets. */
const PRIVATE_STREAM_ID = 0xBD;
/** PES_packet_length is 16 bits and counts the three bytes after it, the PTS, then the payload. */
const MAX_PRIVATE_PES_PAYLOAD = 0xFFFF - 8;

const VIDEO_STREAM_ID_BASE = 0xE0;
const AUDIO_STREAM_ID_BASE = 0xC0;

type MpegTsTrackData = {
	track: OutputVideoTrack | OutputAudioTrack;
	pid: number;
	streamType: MpegTsStreamType;
	streamId: number;
	codecString: string;
	timestampProcessingQueue: QueuedPacket[];
	reorderDelay: number;
	lastDecodeTimestamp: number;
	packetQueue: QueuedPacket[];
	inputIsAnnexB: boolean | null;
	inputIsAdts: boolean | null;
	avcDecoderConfig: AvcDecoderConfigurationRecord | null;
	hevcDecoderConfig: HevcDecoderConfigurationRecord | null;
	/** Layer 1's parameter sets, from `lhvC`, for a layered (MV-HEVC) track. */
	lhvcConfig: LhvcConfig | null;
	adtsHeader: Uint8Array | null;
	adtsHeaderBitstream: Bitstream | null;
	/** AudioSpecificConfig, for the SAMPLE-AES audio setup descriptor; null when not encrypting. */
	audioSetupData: Uint8Array | null;
	firstPacketWritten: boolean;
	/**
	 * The timecode this track states, and what is needed to write one onto each access unit.
	 * Undefined until the first packet settles it; null for a track that states none.
	 */
	/** Settled by the first packet when this track is written as LATM; undefined otherwise. */
	latm?: {
		description: Uint8Array;
		configBitLength: number;
		frameIndex: number;
	};
	timecode: {
		start: StartTimecode;
		/** The timestamp the start timecode labels, so a track that does not begin at zero still lines up. */
		firstTimestamp: number;
		/** Read for AVC, whose `pic_timing` is parsed against the SPS; null for HEVC. */
		sps: AvcSpsInfo | null;
	} | null | undefined;
};

type QueuedPacket = {
	data: Uint8Array;
	presentationTimestamp: number;
	/** What the source said; equals the presentation timestamp when it stated no separate one. */
	sourceDecodeTimestamp: number;
	decodeTimestamp: number | null;
	duration: number;
	isKeyframe: boolean;
};

type QueuedPrivatePes = {
	pid: number;
	time: number;
	data: Uint8Array;
};

export class MpegTsMuxer extends Muxer {
	private format: MpegTsOutputFormat;
	private timestampOffset: number;
	// Per muxer, not per format: a format instance is the caller's and may be reused, and one run's
	// offset leaking into the next shifts a programme that needed no shift at all.
	private defaultTimestampOffset: number | null = null;
	/** Whether the caller fixed the offset, in which case a negative decode time is theirs to own. */
	private offsetIsStated: boolean;
	private writer!: Writer;

	private trackDatas: MpegTsTrackData[] = [];
	private closedTracks = new Set<OutputTrack>();
	/** The declared SCTE-35 PID, read once so a section can be written before any table is built. */
	readonly scte35Pid: number | null;
	readonly tableRepeatInterval: number;
	private readonly patInterval: number;
	private readonly pmtInterval: number;
	private readonly pcrInterval: number;
	private readonly sdtInterval: number;
	private readonly dvbTimeInterval: number;
	private readonly nitInterval: number;
	private lastDvbTimeTimestamp: number | null = null;
	private lastNitTimestamp: number | null = null;
	private readonly muxRate: number | null;
	/** Every 188-byte packet written so far, null packets included: the byte clock of a CBR stream. */
	private packetsWritten = 0;
	/** The media's own span, so a constant-rate stream's byte clock starts and ends where it does. */
	private firstWrittenTimestamp: number | null = null;
	private lastWrittenEndTimestamp = 0;
	private readonly service: NonNullable<MpegTsOutputFormat['_options']['service']> | null;
	/**
	 * Sections handed over before the tables went out. A track's data exists only once its first packet
	 * is added, so writing the tables early would publish a PMT that names the cue stream and no media.
	 */
	private pendingScte35Sections: Uint8Array[] = [];
	readonly privateStreams: MpegTsPrivateStreamDeclaration[];
	/** The PID ID3 tags go on, or null where the format declares none. */
	readonly timedMetadataPid: number | null;
	/** Private PES payloads waiting for the interleave to reach their PTS, in time order. */
	private privatePesQueue: QueuedPrivatePes[] = [];
	private privateStreamsStarted = new Set<number>();
	private tablesWritten = false;
	private continuityCounters = new Map<number, number>();
	/** Stream time each table was last written at, or null until its first write. */
	private lastPatTimestamp: number | null = null;
	private lastPmtTimestamp: number | null = null;
	private lastSdtTimestamp: number | null = null;
	/** Stream time of the last PCR, however it was carried. */
	private lastPcrTimestamp: number | null = null;
	/**
	 * The byte clock, in 27 MHz ticks, at the last PCR actually written. Under a constant rate this is
	 * what governs the spacing, because the byte clock IS the time base there.
	 */
	private lastPcrByteClock: number | null = null;
	/** Guards the byte-clock check against re-entering while it writes its own packet. */
	private writingByteClockPcr = false;
	private packetBuffer = new Uint8Array(TS_PACKET_SIZE);
	private packetView = toDataView(this.packetBuffer);
	private allTracksKnown = promiseWithResolvers();

	/**
	 * PIDs and stream ids follow the order tracks were added to the output, not the order their first
	 * packets arrive - two runs of the same job interleave differently, and that used to renumber the
	 * streams. The index is of this track among the output's tracks of its own kind.
	 */
	private trackIndexOf(track: OutputTrack) {
		return this.output.tracks.filter(x => x.type === track.type).indexOf(track);
	}

	private pidOf(track: OutputTrack) {
		const index = this.output.tracks.indexOf(track);
		return this.trackPids?.[index] ?? FIRST_TRACK_PID + index;
	}

	/**
	 * Keeps `trackDatas` in the output's own track order. The PMT lists streams in this order and the
	 * tables are written from it, so appending on arrival left the same job writing different bytes.
	 */
	private addTrackData(trackData: MpegTsTrackData) {
		const index = this.trackDatas.findIndex(
			existing => this.output.tracks.indexOf(existing.track) > this.output.tracks.indexOf(trackData.track),
		);

		if (index === -1) {
			this.trackDatas.push(trackData);
		} else {
			this.trackDatas.splice(index, 0, trackData);
		}
	}

	private adaptationFieldBuffer = new Uint8Array(184);
	private pcrPid: number | null = null;
	private readonly programNumber: number;
	private readonly transportStreamId: number;
	private readonly pmtPid: number;
	/** The caller's `pcrPid`, before it is resolved against the tracks that actually arrived. */
	private readonly statedPcrPid: number | null;
	private readonly trackPids: readonly number[] | null;
	private payloadBuffer = new Uint8Array(184);

	constructor(output: Output, format: MpegTsOutputFormat) {
		super(output);

		this.format = format;
		this.timestampOffset = format._options.timestampOffset ?? 0;
		this.offsetIsStated = format._options.timestampOffset !== undefined;
		this.scte35Pid = format._options.scte35Pid ?? null;
		this.tableRepeatInterval = format._options.tableRepeatInterval ?? 0.1;
		this.patInterval = format._options.patInterval ?? this.tableRepeatInterval;
		this.pmtInterval = format._options.pmtInterval ?? this.tableRepeatInterval;
		this.pcrInterval = format._options.pcrInterval ?? 0.04;
		this.sdtInterval = format._options.sdtInterval ?? 0.5;
		this.dvbTimeInterval = format._options.dvbTime?.interval ?? 25;
		this.nitInterval = format._options.network?.interval ?? 10;
		this.muxRate = format._options.muxRate ?? null;
		this.service = format._options.service ?? null;
		const timedMetadataPid = format._options.timedMetadataPid;
		this.timedMetadataPid = timedMetadataPid ?? null;
		this.privateStreams = [
			...(format._options.privateStreams ?? []),
			...(timedMetadataPid == null
				? []
				: [{
						pid: timedMetadataPid,
						streamType: METADATA_IN_PES_STREAM_TYPE,
						descriptors: [buildId3MetadataDescriptor()],
					}]),
		];
		this.programNumber = format._options.programNumber ?? 1;
		this.transportStreamId = format._options.transportStreamId ?? 1;
		this.pmtPid = format._options.pmtPid ?? DEFAULT_PMT_PID;
		this.statedPcrPid = format._options.pcrPid ?? null;
		this.trackPids = format._options.trackPids ?? null;
	}

	protected override get maxInterleaveDelta(): number {
		return this.format._options.maxInterleaveDelta ?? DEFAULT_MAX_INTERLEAVE_DELTA;
	}

	async start() {
		const release = await this.mutex.acquire();

		try {
			this.writer = await this.output._getRootWriter(true);
		} finally {
			release();
		}
	}

	async getMimeType() {
		await this.allTracksKnown.promise;
		return buildMpegTsMimeType(this.trackDatas.map(x => x.codecString));
	}

	private getVideoTrackData(track: OutputVideoTrack, meta?: EncodedVideoChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		validateVideoChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'avc' || codec === 'hevc' || codec === 'mpeg2');

		const encryption = this.format._options.sampleAesEncryption;
		if (encryption && codec !== 'avc') {
			throw new UnsupportedMediaError(
				`SAMPLE-AES is specified for H.264 only; this output's video track is '${codec}'.`,
			);
		}

		const streamType = codec === 'avc'
			? (encryption ? MpegTsStreamType.SAMPLE_AES_AVC : MpegTsStreamType.AVC)
			: codec === 'mpeg2'
				? MpegTsStreamType.MPEG2_VIDEO
				: MpegTsStreamType.HEVC;
		const pid = this.pidOf(track);
		const streamId = VIDEO_STREAM_ID_BASE + this.trackIndexOf(track);

		const newTrackData: MpegTsTrackData = {
			track,
			pid,
			streamType,
			streamId,
			codecString: meta.decoderConfig.codec,
			timestampProcessingQueue: [],
			reorderDelay: 0,
			lastDecodeTimestamp: -Infinity,
			packetQueue: [],
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcDecoderConfig: null,
			lhvcConfig: null,
			adtsHeader: null,
			adtsHeaderBitstream: null,
			audioSetupData: null,
			firstPacketWritten: false,
			timecode: undefined,
		};

		this.addTrackData(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private getAudioTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		validateAudioChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(
			codec === 'aac' || codec === 'mp3' || codec === 'mp2'
			|| codec === 'ac3' || codec === 'eac3' || codec === 'dts',
		);

		const audioEncryption = this.format._options.sampleAesEncryption;
		if (audioEncryption && codec !== 'aac') {
			throw new UnsupportedMediaError(
				`SAMPLE-AES here encrypts AAC audio only; this output's audio track is '${codec}'.`,
			);
		}

		let streamType: MpegTsStreamType;
		let streamId: number;

		switch (codec) {
			case 'aac': {
				// LATM and SAMPLE-AES do not meet: the encryption scheme is defined over ADTS frames
				streamType = audioEncryption
					? MpegTsStreamType.SAMPLE_AES_AAC
					: this.format._options.aacFraming === 'latm'
						? MpegTsStreamType.AAC_LATM
						: MpegTsStreamType.AAC;
				streamId = AUDIO_STREAM_ID_BASE + this.trackIndexOf(track);
			}; break;

			// Both go out as 0x03: the stream type names the MPEG version, not the layer, which is in the
			// frame header. ffmpeg writes 0x03 for Layer II as well, and reads the layer back off the frames.
			case 'mp3':
			case 'mp2': {
				streamType = MpegTsStreamType.MP3_MPEG1;
				streamId = AUDIO_STREAM_ID_BASE + this.trackIndexOf(track);
			}; break;

			case 'ac3': {
				streamType = MpegTsStreamType.AC3_SYSTEM_A;
				streamId = 0xbd;
			}; break;

			case 'eac3': {
				streamType = MpegTsStreamType.EAC3_SYSTEM_A;
				streamId = 0xbd;
			}; break;

			case 'dts': {
				streamType = MpegTsStreamType.DTS;
				streamId = 0xbd;
			}; break;
		}

		const pid = this.pidOf(track);

		const newTrackData: MpegTsTrackData = {
			track,
			pid,
			streamType,
			streamId,
			codecString: meta.decoderConfig.codec,
			timestampProcessingQueue: [],
			reorderDelay: 0,
			lastDecodeTimestamp: -Infinity,
			packetQueue: [],
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcDecoderConfig: null,
			lhvcConfig: null,
			adtsHeader: null,
			adtsHeaderBitstream: null,
			audioSetupData: audioEncryption
				? toUint8Array(meta.decoderConfig.description ?? new Uint8Array(0))
				: null,
			firstPacketWritten: false,
			timecode: undefined,
		};
		if (newTrackData.audioSetupData?.byteLength === 0) {
			throw new UnsupportedMediaError(
				'SAMPLE-AES needs this AAC track\'s AudioSpecificConfig for the PMT audio setup descriptor,'
				+ ' but its decoder config states none.',
			);
		}

		this.addTrackData(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getVideoTrackData(track, meta);

			this.validateTimestamp(
				trackData.track,
				packet.timestamp,
				packet.type === 'key',
			);

			const preparedData = this.prepareVideoPacket(trackData, packet, meta);

			if (packet.type === 'key') {
				await this.flushTimestampQueue(trackData);
			}

			trackData.timestampProcessingQueue.push({
				data: preparedData,
				presentationTimestamp: packet.timestamp,
				sourceDecodeTimestamp: packet.decodeTimestamp,
				decodeTimestamp: null,
				duration: packet.duration,
				isKeyframe: packet.type === 'key',
			});
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getAudioTrackData(track, meta);

			this.validateTimestamp(
				trackData.track,
				packet.timestamp,
				packet.type === 'key',
			);

			const preparedData = this.prepareAudioPacket(trackData, packet, meta);

			if (packet.type === 'key') {
				await this.flushTimestampQueue(trackData);
			}

			trackData.timestampProcessingQueue.push({
				data: preparedData,
				presentationTimestamp: packet.timestamp,
				sourceDecodeTimestamp: packet.decodeTimestamp,
				decodeTimestamp: null,
				duration: packet.duration,
				isKeyframe: packet.type === 'key',
			});
		} finally {
			release();
		}
	}

	async addSubtitleCue(): Promise<void> {
		throw new Error('MPEG-TS does not support subtitles.');
	}

	private prepareVideoPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): Uint8Array {
		const codec = (trackData.track as OutputVideoTrack).source._codec;

		if (codec === 'mpeg2') {
			if ((trackData.track as OutputVideoTrack).metadata.timecode != null) {
				// MPEG-2 states a timecode in its GOP header rather than in an SEI message, and this muxer
				// copies the caller's bitstream verbatim. Saying so beats writing a file whose timecode
				// silently went missing.
				throw new Error(
					'metadata.timecode was stated for an MPEG-2 track, which carries a timecode in its GOP'
					+ ' headers rather than in an SEI message; this muxer writes the bitstream as given and'
					+ ' cannot add one. Encode the timecode into the elementary stream, or use AVC or HEVC.',
				);
			}

			return packet.data;
		}

		if (trackData.inputIsAnnexB === null) {
			// This is the first packet
			const description = meta?.decoderConfig?.description;

			if (description) {
				const bytes = toUint8Array(description);
				if (codec === 'avc') {
					trackData.avcDecoderConfig = deserializeAvcDecoderConfigurationRecord(bytes);
				} else {
					trackData.hevcDecoderConfig = deserializeHevcDecoderConfigurationRecord(bytes);

					// `hvcC` describes the base layer alone, so a layered track's second view has its
					// parameter sets in `lhvC` and nowhere else. Without them in the elementary stream
					// a decoder sees layer 1's slices with no SPS to read them against and drops them:
					// the stream plays, with one eye.
					const layerConfiguration = (meta?.decoderConfig as VideoDecoderConfigWithHdr | undefined)
						?.multiview?.layerConfiguration;
					trackData.lhvcConfig = layerConfiguration
						? parseLhvcConfigRecord(layerConfiguration)
						: null;
				}
			}

			trackData.inputIsAnnexB = !description;
		}

		let annexB = trackData.inputIsAnnexB
			? this.prepareAnnexBVideoPacket(packet.data, codec as 'avc' | 'hevc')
			: this.prepareLengthPrefixedVideoPacket(trackData, packet, codec as 'avc' | 'hevc');

		annexB = this.writeTimecode(trackData, annexB, packet, codec as 'avc' | 'hevc');

		const encryption = this.format._options.sampleAesEncryption;
		return encryption ? sampleAesEncryptAnnexBAccessUnit(annexB, encryption) : annexB;
	}

	/**
	 * The SEI NAL unit stating this packet's timecode, or null when the track states none.
	 *
	 * A transport stream has no timecode track to put one in, so the bitstream is the only carriage, and
	 * the message rides **every** access unit rather than the key frames alone: it states the timecode of
	 * the picture it travels with, which is a different value on each.
	 */
	private writeTimecode(
		trackData: MpegTsTrackData,
		annexB: Uint8Array,
		packet: EncodedPacket,
		codec: 'avc' | 'hevc',
	) {
		if (trackData.timecode === undefined) {
			trackData.timecode = this.resolveTimecode(trackData, packet, codec);
		}
		if (trackData.timecode === null) {
			return annexB;
		}

		const { start, firstTimestamp, sps } = trackData.timecode;
		// The timecode labels the track's first frame, so the index is counted from there - a track that
		// starts at 2 s still gets the stated timecode on its first picture
		const frameIndex = Math.max(0, Math.round((packet.timestamp - firstTimestamp) * start.frameRate));

		// A description-less config is how the NAL helpers are told the data is Annex B rather than
		// length-prefixed, which is the framing a transport stream carries
		return writeTimecodeIntoAccessUnit(annexB, ANNEX_B_CONFIG, codec, sps, start, frameIndex);
	}

	/** Reads the track's stated timecode once, and settles whether its bitstream can carry one. */
	private resolveTimecode(trackData: MpegTsTrackData, packet: EncodedPacket, codec: 'avc' | 'hevc') {
		const metadata = (trackData.track as OutputVideoTrack).metadata;
		if (metadata.timecode == null) {
			return null;
		}

		assert(metadata.frameRate !== undefined); // Validated together on the track
		const start = parseTimecode(metadata.timecode, metadata.frameRate);

		let sps: AvcSpsInfo | null = null;
		if (codec === 'avc') {
			const record = trackData.avcDecoderConfig;
			const first = record?.sequenceParameterSets[0];
			sps = first ? parseAvcSps(first) : null;

			// An AVC `pic_timing` message is read against the SPS rather than being self-describing, so
			// one written for a stream whose VUI declares no `pic_struct` is read as whatever those bits
			// happen to mean there. Refusing is the only safe answer, and there is no second carriage in
			// a transport stream to fall back to.
			if (!sps?.picStructPresentFlag) {
				throw new Error(
					'metadata.timecode was stated for an AVC track, but this stream\'s SPS does not declare'
					+ ' pic_struct_present_flag, so a pic_timing SEI message written into it could not be'
					+ ' read back. MPEG-TS carries a timecode in the bitstream and has no timecode track to'
					+ ' put one in, so either encode with picture timing enabled, use HEVC, or write to MP4'
					+ ' or MOV, which carry the timecode in a tmcd track for any codec.',
				);
			}
		}

		return { start, firstTimestamp: packet.timestamp, sps };
	}

	private prepareAnnexBVideoPacket(data: Uint8Array, codec: 'avc' | 'hevc'): Uint8Array {
		const nalUnits: Uint8Array[] = [];

		for (const loc of iterateNalUnitsInAnnexB(data)) {
			const nalUnit = data.subarray(loc.offset, loc.offset + loc.length);
			const isAud = codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.AUD
				: extractNalUnitTypeForHevc(nalUnit[0]!) === HevcNalUnitType.AUD_NUT;

			if (!isAud) {
				nalUnits.push(nalUnit);
			}
		}

		// Prepend the AUD
		nalUnits.unshift(this.createAud(nalUnits, codec));

		return concatNalUnitsInAnnexB(nalUnits);
	}

	private prepareLengthPrefixedVideoPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		codec: 'avc' | 'hevc',
	): Uint8Array {
		const data = packet.data;
		const lengthSize = codec === 'avc'
			? (trackData.avcDecoderConfig!.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4
			: (trackData.hevcDecoderConfig!.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;

		const nalUnits: Uint8Array[] = [];

		for (const loc of iterateNalUnitsInLengthPrefixed(data, lengthSize)) {
			const nalUnit = data.subarray(loc.offset, loc.offset + loc.length);
			const isAud = codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.AUD
				: extractNalUnitTypeForHevc(nalUnit[0]!) === HevcNalUnitType.AUD_NUT;

			if (!isAud) {
				nalUnits.push(nalUnit);
			}
		}

		if (packet.type === 'key') {
			// Add whichever NALUs are missing
			if (codec === 'avc') {
				const config = trackData.avcDecoderConfig!;
				for (const pps of config.pictureParameterSets) {
					nalUnits.unshift(pps);
				}
				for (const sps of config.sequenceParameterSets) {
					nalUnits.unshift(sps);
				}
			} else {
				const config = trackData.hevcDecoderConfig!;

				// A transport stream carries no decoder configuration, so a declarative SEI that an
				// `hvcC` keeps out of band - 3D reference displays info for a multiview stream, for
				// one - has nowhere else to go: a receiver that only ever sees the elementary stream
				// never learns it. Unshifted before the parameter sets so it ends up after them,
				// which is where an access unit carries a prefix SEI.
				const layered = trackData.lhvcConfig;
				for (const source of [layered, trackData.hevcDecoderConfig!]) {
					if (!source) {
						continue;
					}

					for (const arr of source.arrays) {
						if (arr.nalUnitType !== HevcNalUnitType.PREFIX_SEI_NUT) {
							continue;
						}

						for (const nal of arr.nalUnits) {
							nalUnits.unshift(nal);
						}
					}
				}

				// Unshifted first so they end up last: the base layer's sets have to precede the ones
				// that depend on them, and `unshift` reverses the order things are added in
				if (layered) {
					for (const type of [HevcNalUnitType.PPS_NUT, HevcNalUnitType.SPS_NUT]) {
						for (const arr of layered.arrays) {
							if (arr.nalUnitType === type) {
								for (const nal of arr.nalUnits) {
									nalUnits.unshift(nal);
								}
							}
						}
					}
				}

				for (const arr of config.arrays) {
					if (arr.nalUnitType === HevcNalUnitType.PPS_NUT) {
						for (const nal of arr.nalUnits) {
							nalUnits.unshift(nal);
						}
					}
				}
				for (const arr of config.arrays) {
					if (arr.nalUnitType === HevcNalUnitType.SPS_NUT) {
						for (const nal of arr.nalUnits) {
							nalUnits.unshift(nal);
						}
					}
				}
				for (const arr of config.arrays) {
					if (arr.nalUnitType === HevcNalUnitType.VPS_NUT) {
						for (const nal of arr.nalUnits) {
							nalUnits.unshift(nal);
						}
					}
				}
			}
		}

		// Prepend the AUD
		nalUnits.unshift(this.createAud(nalUnits, codec));

		return concatNalUnitsInAnnexB(nalUnits);
	}

	private createAud(nalUnits: Uint8Array[], codec: 'avc' | 'hevc') {
		if (codec === 'avc') {
			return new Uint8Array([0x09, 0xF0]); // AUD, primary_pic_type 7 plus stop bit
		}

		// The AUD's TemporalId must match the access unit's, which is that of its pictures' (VCL) NAL units
		const vclNalUnit = nalUnits.find(x => extractNalUnitTypeForHevc(x[0]!) < 32);
		const temporalIdPlusOne = vclNalUnit ? vclNalUnit[1]! & 0b111 : 1;

		return new Uint8Array([0x46, temporalIdPlusOne, 0x50]); // AUD_NUT, layer 0, pic_type 2 plus stop bit
	}

	private prepareAudioPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Uint8Array {
		const codec = (trackData.track as OutputAudioTrack).source._codec;

		if (codec === 'mp3' || codec === 'mp2' || codec === 'ac3' || codec === 'eac3' || codec === 'dts') {
			// We're good
			return packet.data;
		}

		if (trackData.inputIsAdts === null) {
			// It's the first packet
			const description = meta?.decoderConfig?.description;

			if (description) {
				const config = parseAacAudioSpecificConfig(toUint8Array(description));
				const template = buildAdtsHeaderTemplate(config);
				trackData.adtsHeader = template.header;
				trackData.adtsHeaderBitstream = template.bitstream;
			}

			trackData.inputIsAdts = !description;
		}

		if (trackData.streamType === MpegTsStreamType.AAC_LATM) {
			return this.toLoasFrame(trackData, packet, meta);
		}

		if (trackData.inputIsAdts) {
			return this.encryptAdtsIfNeeded(packet.data);
		}

		assert(trackData.adtsHeader);
		assert(trackData.adtsHeaderBitstream);

		const header = trackData.adtsHeader;
		const frameLength = packet.data.byteLength + header.byteLength;
		writeAdtsFrameLength(trackData.adtsHeaderBitstream, frameLength);

		const result = new Uint8Array(frameLength);
		result.set(header, 0);
		result.set(packet.data, header.byteLength);

		return this.encryptAdtsIfNeeded(result);
	}

	/**
	 * Wraps an AAC access unit in a LOAS `AudioSyncStream` frame.
	 *
	 * An ADTS input is refused rather than unwrapped: the ADTS header would end up inside the payload,
	 * where a decoder reading the `StreamMuxConfig`'s configuration would find seven octets of header
	 * before the audio.
	 */
	private toLoasFrame(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Uint8Array {
		if (trackData.latm === undefined) {
			const description = meta?.decoderConfig?.description;
			if (!description) {
				throw new Error(
					'LATM framing needs the AAC AudioSpecificConfig, which the StreamMuxConfig carries'
					+ ' inside the stream, but no decoder config description was provided. ADTS-wrapped'
					+ ' input cannot be written as LATM either, since its header would land in the'
					+ ' payload; provide a description, or use aacFraming \'adts\'.',
				);
			}

			const bytes = toUint8Array(description);
			trackData.latm = {
				description: bytes,
				configBitLength: audioSpecificConfigBitLength(bytes),
				frameIndex: 0,
			};
		}

		const latm = trackData.latm;
		const interval = this.format._options.latmConfigInterval ?? 1;
		const statesConfig = latm.frameIndex % interval === 0;
		latm.frameIndex++;

		return buildLoasFrame(packet.data, latm.description, latm.configBitLength, statesConfig);
	}

	private encryptAdtsIfNeeded(frame: Uint8Array) {
		const encryption = this.format._options.sampleAesEncryption;
		return encryption ? sampleAesEncryptAdtsFrame(frame, encryption) : frame;
	}

	private allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!this.closedTracks.has(track) && !this.trackDatas.some(x => x.track === track)) {
				return false;
			}
		}

		return true;
	}

	private async flushTimestampQueue(trackData: MpegTsTrackData, alsoInterleave = true) {
		if (trackData.timestampProcessingQueue.length === 0) {
			return;
		}

		// 13818-1 2.4.2 wants DTS <= PTS; sorting presentation timestamps only achieves that when the
		// reorder depth is uniform, so prefer what the source stated
		const reordered = trackData.timestampProcessingQueue.some(
			packet => packet.sourceDecodeTimestamp !== packet.presentationTimestamp,
		);
		const sortedTimestamps = trackData.timestampProcessingQueue
			.map(packet => packet.presentationTimestamp)
			.sort((a, b) => a - b);

		let reorderDelay = 0;
		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const queuedPacket = trackData.timestampProcessingQueue[i]!;
			reorderDelay = Math.max(reorderDelay, sortedTimestamps[i]! - queuedPacket.presentationTimestamp);
		}

		// 13818-1 2.4.2 wants DTS <= PTS for all frames, which many players expect too.
		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const queuedPacket = trackData.timestampProcessingQueue[i]!;
			queuedPacket.decodeTimestamp = reordered
				? queuedPacket.sourceDecodeTimestamp
				: sortedTimestamps[i]! - reorderDelay;
			trackData.packetQueue.push(queuedPacket);
		}

		trackData.timestampProcessingQueue.length = 0;

		if (alsoInterleave) {
			await this.interleavePackets();
		}
	}

	/**
	 * PES timestamps are unsigned 33-bit, and H.222.0 requires DTS <= PTS. A negative decode time
	 * wraps to a value near 2^33, which breaks that relation when the packet's own presentation time
	 * did not wrap with it — readers then see it decoding a day after it presents. The programme is
	 * shifted once, by the same amount for every track so they stay aligned.
	 *
	 * A programme negative in both fields is left alone: both wrap by the same amount, DTS <= PTS
	 * still holds, and shifting it would move a timeline the caller asked for.
	 */
	private decideTimestampOffset() {
		if (this.offsetIsStated) {
			return;
		}

		if (this.defaultTimestampOffset === null) {
			let shift = 0;
			for (const trackData of this.trackDatas) {
				const head = trackData.packetQueue[0];
				if (head) {
					const decode = Math.min(
						head.decodeTimestamp ?? head.presentationTimestamp,
						head.sourceDecodeTimestamp,
					);
					if (decode < 0 && head.presentationTimestamp >= 0) {
						shift = Math.max(shift, -decode);
					}
				}
			}

			this.defaultTimestampOffset = shift;
		}

		this.timestampOffset = this.defaultTimestampOffset;
	}

	private async interleavePackets(isFinalCall = false) {
		if (!this.tablesWritten) {
			if (!this.allTracksAreKnown() && !isFinalCall) {
				return;
			}

			this.writeTables();
		}

		while (true) {
			let trackWithMinTimestamp: MpegTsTrackData | null = null;
			let minTimestamp = Infinity;

			let waitingForTrack = false;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length === 0
					&& !this.closedTracks.has(trackData.track)
				) {
					waitingForTrack = true;
					continue;
				}

				if (trackData.packetQueue.length > 0) {
					if (trackData.packetQueue[0]!.presentationTimestamp < minTimestamp) {
						trackWithMinTimestamp = trackData;
						minTimestamp = trackData.packetQueue[0]!.presentationTimestamp;
					}
				}
			}

			if (
				waitingForTrack
				&& !this.quietTrackMayBeSkipped(this.trackDatas, x => x.packetQueue, x => x.presentationTimestamp)
			) {
				break;
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			this.decideTimestampOffset();

			const queuedPacket = trackWithMinTimestamp.packetQueue.shift()!;
			// PCRs before the tables, and the order matters under a constant rate: repeating the tables
			// pads the byte clock all the way to this packet's time, and a PCR that then wants to sit
			// earlier can no longer be placed - the padding is already past it.
			this.writePcrIfDue(
				queuedPacket.decodeTimestamp ?? queuedPacket.presentationTimestamp,
				trackWithMinTimestamp.pid,
			);
			this.repeatTablesIfDue(queuedPacket);
			this.drainPrivatePes(queuedPacket.presentationTimestamp);
			this.writePesPacket(trackWithMinTimestamp, queuedPacket);
		}

		if (isFinalCall) {
			this.drainPrivatePes(Infinity);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	/** PAT then PMT, on their own PIDs, each continuing its own continuity counter. */
	private writeTableSections(
		pat = true,
		pmt = true,
		sdt = this.service !== null,
		dvbTime = this.format._options.dvbTime != null,
		nit = this.format._options.network != null,
	) {
		if (pat) {
			this.writePsiSection(PAT_PID, buildPat(this.transportStreamId, this.programNumber, this.pmtPid));
		}
		if (pmt) {
			this.writePsiSection(this.pmtPid, buildPmt(
				this.trackDatas, this.scte35Pid, this.privateStreams, this.programNumber, this.pcrPid,
			));
		}
		if (sdt && this.service !== null) {
			this.writePsiSection(SDT_PID, buildSdt(this.transportStreamId, this.programNumber, this.service));
		}

		const network = this.format._options.network;
		if (nit && network != null) {
			this.writePsiSection(NIT_PID, buildNit(
				network.id,
				dvbText(network.name),
				this.transportStreamId,
				this.service?.originalNetworkId ?? 1,
				network.transportDescriptors ?? [],
			));
		}

		const options = this.format._options.dvbTime;
		if (dvbTime && options != null) {
			// One reading of the clock for both tables, so a TDT and the TOT beside it cannot disagree
			const time = options.now?.() ?? new Date();
			this.writePsiSection(TDT_PID, buildTdt(time));

			// A TOT with no offsets in it says nothing the TDT has not, so it is only written where
			// there are some
			if (options.regions && options.regions.length > 0) {
				this.writePsiSection(TDT_PID, buildTot(time, options.regions));
			}
		}
	}

	/**
	 * Whether a table whose period is `interval` is due at `now`, having last gone out at `last`. A key
	 * frame pulls it forward by up to half the period: that is where a receiver joining mid-stream
	 * begins, so the table is worth most immediately before it.
	 */
	private tableIsDue(interval: number, last: number | null, now: number, isKeyframe: boolean) {
		if (!Number.isFinite(interval)) {
			return false;
		}
		if (last === null) {
			return false;
		}

		const elapsed = now - last;
		return elapsed >= interval || (isKeyframe && elapsed >= interval / 2);
	}

	/**
	 * Repeats the tables once the period has elapsed on the stream's own timeline, or a little early to
	 * get in front of a key frame, which is where a receiver joining mid-stream begins.
	 */
	private repeatTablesIfDue(packet: QueuedPacket) {
		const now = packet.presentationTimestamp;

		this.lastPatTimestamp ??= now;
		this.lastPmtTimestamp ??= now;
		this.lastSdtTimestamp ??= now;
		this.lastDvbTimeTimestamp ??= now;
		this.lastNitTimestamp ??= now;

		const pat = this.tableIsDue(this.patInterval, this.lastPatTimestamp, now, packet.isKeyframe);
		const pmt = this.tableIsDue(this.pmtInterval, this.lastPmtTimestamp, now, packet.isKeyframe);
		const sdt = this.service !== null
			&& this.tableIsDue(this.sdtInterval, this.lastSdtTimestamp, now, packet.isKeyframe);
		const dvbTime = this.format._options.dvbTime != null
			&& this.tableIsDue(this.dvbTimeInterval, this.lastDvbTimeTimestamp, now, packet.isKeyframe);
		const nit = this.format._options.network != null
			&& this.tableIsDue(this.nitInterval, this.lastNitTimestamp, now, packet.isKeyframe);
		if (!pat && !pmt && !sdt && !dvbTime && !nit) {
			return;
		}

		this.padTo(now);
		this.writeTableSections(pat, pmt, sdt, dvbTime, nit);
		if (pat) {
			this.lastPatTimestamp = now;
		}
		if (pmt) {
			this.lastPmtTimestamp = now;
		}
		if (sdt) {
			this.lastSdtTimestamp = now;
		}
		if (dvbTime) {
			this.lastDvbTimeTimestamp = now;
		}
		if (nit) {
			this.lastNitTimestamp = now;
		}
	}

	/** The clock the next packet of the PCR track states, or null while it has none queued. */
	private nextPcrTrackTimestamp() {
		const trackData = this.trackDatas.find(x => x.pid === this.pcrPid);
		const head = trackData?.packetQueue[0];
		if (!head) {
			return null;
		}

		return head.decodeTimestamp ?? head.presentationTimestamp;
	}

	/**
	 * Fills the gap up to `until` with PCR-only packets, which is what keeps the spacing where the PCR
	 * track has gone quiet, where the PCR PID names no track at all, or where a constant rate is
	 * filling the gap with null packets - a null carries no PCR, so a quiet stretch of a CBR multiplex
	 * is exactly where the clock goes missing.
	 *
	 * Stamped at one interval past the last PCR rather than from the caller's own clock, and strictly
	 * below `until`, so a packet that is itself about to carry a PCR at `until` is not preceded by a
	 * duplicate at the same instant.
	 */
	private fillPcrUpTo(until: number) {
		assert(this.pcrPid !== null);

		if (this.lastPcrTimestamp === null) {
			// Nothing has stated a clock yet and no track is going to, so start it here. Deriving a
			// notional previous PCR one interval back instead made this depend on a rounding error:
			// `until - interval + interval < until` is false in decimal and true in binary, which is
			// the only reason the first PCR ever got written.
			this.writePcrOnlyPacket(until);
			return;
		}

		let last = this.lastPcrTimestamp;

		// The epsilon matters the other way: a PCR track whose packets are spaced exactly `pcrInterval`
		// apart - 25 fps against the 0.04s default - compares two values that are equal in decimal and
		// differ in the last bit. Without it every frame gets a redundant PCR a hair before it, which
		// also moves the clock a table inherits and so reads as a table-spacing regression elsewhere.
		while (last + this.pcrInterval < until - PCR_FILL_EPSILON) {
			last += this.pcrInterval;
			this.writePcrOnlyPacket(last);
		}
	}

	/** One packet on the PCR PID carrying an adaptation field and no payload at all. */
	private writePcrOnlyPacket(timestamp: number) {
		assert(this.pcrPid !== null);
		this.padTo(timestamp);

		const field = this.adaptationFieldBuffer;
		field.fill(0xFF);
		field[0] = 183; // adaptation_field_length: every byte of the packet after this one
		field[1] = 0x10; // PCR_flag, everything else 0
		if (this.muxRate !== null) {
			writePcr27Into(field, 2, this.byteClock27MHz());
		} else {
			writePcrInto(field, 2, secondsToMpegTsTimestamp(timestamp + this.timestampOffset));
		}

		this.noteWrittenPcr();
		this.writeTsPacket(this.pcrPid, false, field, EMPTY_PAYLOAD);
		this.lastPcrTimestamp = timestamp;
	}

	/**
	 * Keeps the PCR spacing ahead of the packet about to be written.
	 *
	 * This used to return early whenever that packet was itself on the PCR PID, on the reasoning that
	 * it would carry a PCR anyway. It does - but only at its *own* timestamp, so the spacing between
	 * PCRs became the spacing between that track's packets. A single video track is its own PCR PID, so
	 * for the commonest broadcast case there was no filling at all: at 6.67 fps the PCRs came 0.15s
	 * apart against ISO/IEC 13818-1's 0.1s maximum, and at 1 fps a full second apart, whatever
	 * `pcrInterval` asked for. Under a constant rate the gap is wall-to-wall null packets, none of
	 * which carries a clock.
	 *
	 * `until` is the PCR track's own clock in both branches: when the next packet is on the PCR PID
	 * that is `now`, and otherwise it is that track's next queued packet. Taking `now` in the second
	 * case would read the clock of whichever track the interleave reached - audio states no decode
	 * timeline, so its presentation time would put a PCR ahead of a video decode time still to be
	 * written, and a PCR that goes backwards is worse than one that is late.
	 */
	private writePcrIfDue(now: number, pidAboutToCarryPcr: number | null) {
		if (this.pcrPid === null) {
			return;
		}

		if (this.lastPcrTimestamp === null && this.trackDatas.some(x => x.pid === this.pcrPid)) {
			return;
		}

		// Once a constant-rate stream has stated its first PCR, the byte clock takes over the spacing
		if (this.muxRate !== null && this.lastPcrByteClock !== null) {
			return;
		}

		this.fillPcrUpTo(
			pidAboutToCarryPcr === this.pcrPid ? now : this.nextPcrTrackTimestamp() ?? now,
		);
	}

	private writeTables() {
		assert(!this.tablesWritten);

		const used = new Map<number, string>([[PAT_PID, 'the PAT'], [this.pmtPid, 'the PMT']]);
		if (this.service !== null) {
			used.set(SDT_PID, 'the SDT');
		}
		if (this.format._options.dvbTime != null) {
			used.set(TDT_PID, 'the DVB time tables');
		}
		if (this.format._options.network != null) {
			used.set(NIT_PID, 'the NIT');
		}
		const claim = (pid: number, what: string) => {
			const owner = used.get(pid);
			if (owner !== undefined) {
				throw new InvalidUsageError(
					`${what} uses PID ${pid}, which this output already uses for ${owner}.`,
				);
			}
			used.set(pid, what);
		};

		for (const trackData of this.trackDatas) {
			claim(trackData.pid, `Track ${this.output.tracks.indexOf(trackData.track) + 1}`);
		}
		for (const stream of this.privateStreams) {
			claim(stream.pid, 'A private stream');
		}
		if (this.scte35Pid !== null) {
			claim(this.scte35Pid, 'The SCTE-35 cue stream');
		}

		this.pcrPid = this.statedPcrPid ?? pcrTrackOf(this.trackDatas)?.pid ?? null;
		this.writeTableSections();
		this.tablesWritten = true;

		this.flushScte35Sections();
	}

	/**
	 * Writes a `splice_info_section` into the declared SCTE-35 PID, at the current point in the stream.
	 *
	 * The tables go first when they have not been written yet: a section on a PID the PMT has not named
	 * is one a receiver has no reason to look at.
	 *
	 * @internal
	 */
	writeScte35Section(section: Uint8Array) {
		if (this.scte35Pid === null) {
			throw new InvalidUsageError(
				'MpegTsOutputFormat was not given an scte35Pid, so there is no cue stream to write into.',
			);
		}

		this.pendingScte35Sections.push(section);
		this.flushScte35Sections();
	}

	/** Writes whatever is queued, once the tables exist for it to belong to. */
	private flushScte35Sections() {
		if (!this.tablesWritten || this.scte35Pid === null) {
			return;
		}

		for (const section of this.pendingScte35Sections) {
			this.writePsiSection(this.scte35Pid, section);
		}
		this.pendingScte35Sections.length = 0;
	}

	/**
	 * Queues a private PES payload for the declared PID. It is written once the interleave reaches its
	 * PTS, so it lands among the media packets in time order rather than wherever the call happened.
	 *
	 * @internal
	 */
	writePrivatePesPayload(pid: number, time: number, data: Uint8Array) {
		if (!this.privateStreams.some(stream => stream.pid === pid)) {
			throw new InvalidUsageError(
				`MpegTsOutputFormat declares no private stream on PID ${pid}.`,
			);
		}
		if (data.byteLength > MAX_PRIVATE_PES_PAYLOAD) {
			throw new InvalidUsageError(
				`A private PES payload is at most ${MAX_PRIVATE_PES_PAYLOAD} bytes; this one is `
				+ `${data.byteLength}.`,
			);
		}

		const entry: QueuedPrivatePes = { pid, time, data };
		let at = this.privatePesQueue.length;
		while (at > 0 && this.privatePesQueue[at - 1]!.time > time) {
			at--;
		}
		this.privatePesQueue.splice(at, 0, entry);
	}

	/** Writes the queued private PES packets whose PTS is at or before `upTo`. */
	private drainPrivatePes(upTo: number) {
		while (this.privatePesQueue.length > 0 && this.privatePesQueue[0]!.time <= upTo) {
			this.writePrivatePes(this.privatePesQueue.shift()!);
		}
	}

	/** EN 300 472 4.1 requires the length stated and the data aligned, so neither is left defaulted. */
	private writePrivatePes(entry: QueuedPrivatePes) {
		const header = new Uint8Array(14);
		const view = toDataView(header);

		setUint24(view, 0, 0x000001, false); // packet_start_code_prefix
		header[3] = PRIVATE_STREAM_ID;
		view.setUint16(4, 8 + entry.data.byteLength, false); // PES_packet_length
		header[6] = 0x84; // '10' marker, data_alignment_indicator=1
		header[7] = 0x80; // PTS_DTS_flags=10
		header[8] = 5; // PES_header_data_length

		writePesTimestamp(
			new Bitstream(header.subarray(9)),
			0b0010,
			secondsToMpegTsTimestamp(entry.time + this.timestampOffset),
		);

		this.writePesTsPackets(entry.pid, header, entry.data, {
			isKeyframe: false,
			discontinuity: !this.privateStreamsStarted.has(entry.pid),
			pcr: null,
		});
		this.privateStreamsStarted.add(entry.pid);
	}

	private writePsiSection(pid: number, section: Uint8Array) {
		let offset = 0;
		let isFirst = true;

		// Long PSI sections might span more than one TS packet
		while (offset < section.length) {
			const pointerFieldSize = isFirst ? 1 : 0;
			const availablePayload = 184 - pointerFieldSize;
			const remainingData = section.length - offset;
			const chunkSize = Math.min(availablePayload, remainingData);

			let payload: Uint8Array;
			if (isFirst) {
				payload = this.payloadBuffer.subarray(0, 1 + chunkSize);
				payload[0] = 0x00; // pointer_field
				payload.set(section.subarray(offset, offset + chunkSize), 1);
			} else {
				payload = section.subarray(offset, offset + chunkSize);
			}

			this.writeTsPacket(pid, isFirst, null, payload);

			offset += chunkSize;
			isFirst = false;
		}
	}

	private writePesPacket(trackData: MpegTsTrackData, queuedPacket: QueuedPacket) {
		const includeDts = trackData.track.type === 'video';
		const headerDataLength = includeDts ? 10 : 5;
		const pesHeaderBuffer = new Uint8Array(9 + headerDataLength);
		const pesView = toDataView(pesHeaderBuffer);
		const ptsDtsBitstream = new Bitstream(pesHeaderBuffer.subarray(9));

		setUint24(pesView, 0, 0x000001, false); // packet_start_code_prefix
		pesHeaderBuffer[3] = trackData.streamId; // stream_id

		// Some players require the length for audio for whatever reason
		const pesPacketLength = trackData.track.type === 'video' || 8 + queuedPacket.data.length > 0xFFFF
			? 0 // Unbounded
			: 8 + queuedPacket.data.length;
		pesView.setUint16(4, pesPacketLength, false);

		// '10' marker, PES_scrambling_control=0, PES_priority=0,
		// data_alignment_indicator=1, copyright=0, original_or_copy=0
		pesView.setUint8(6, 0x84);
		pesView.setUint8(7, includeDts ? 0xC0 : 0x80); // PTS_DTS_flags, other flags=0
		pesView.setUint8(8, headerDataLength); // PES_header_data_length

		ptsDtsBitstream.pos = 0;
		writePesTimestamp(
			ptsDtsBitstream,
			includeDts ? 0b0011 : 0b0010,
			secondsToMpegTsTimestamp(queuedPacket.presentationTimestamp + this.timestampOffset),
		);

		if (includeDts) {
			assert(queuedPacket.decodeTimestamp !== null);

			writePesTimestamp(
				ptsDtsBitstream,
				0b0001,
				secondsToMpegTsTimestamp(queuedPacket.decodeTimestamp + this.timestampOffset),
			);
		}

		const carriesPcr = trackData.pid === this.pcrPid;
		const pcrTimestamp = queuedPacket.decodeTimestamp ?? queuedPacket.presentationTimestamp;

		this.firstWrittenTimestamp ??= queuedPacket.presentationTimestamp;
		this.lastWrittenEndTimestamp = Math.max(
			this.lastWrittenEndTimestamp,
			queuedPacket.presentationTimestamp + queuedPacket.duration,
		);
		this.padTo(pcrTimestamp);

		this.writePesTsPackets(trackData.pid, pesHeaderBuffer, queuedPacket.data, {
			isKeyframe: queuedPacket.isKeyframe,
			discontinuity: !trackData.firstPacketWritten,
			pcr: carriesPcr ? secondsToMpegTsTimestamp(pcrTimestamp + this.timestampOffset) : null,
		});

		if (carriesPcr) {
			this.lastPcrTimestamp = pcrTimestamp;
		}

		trackData.firstPacketWritten = true;
	}

	/** Splits one PES packet across 188-byte TS packets, with the adaptation field the first needs. */
	private writePesTsPackets(
		pid: number,
		pesHeader: Uint8Array,
		data: Uint8Array,
		flags: { isKeyframe: boolean; discontinuity: boolean; pcr: number | null },
	) {
		const totalLength = pesHeader.length + data.length;
		let offset = 0;
		let isFirstTsPacket = true;

		while (offset < totalLength) {
			const pusi = isFirstTsPacket;
			const remainingData = totalLength - offset;

			const randomAccessIndicator = isFirstTsPacket && flags.isKeyframe;
			const discontinuityIndicator = isFirstTsPacket && flags.discontinuity;
			const basePaddingNeeded = Math.max(0, 184 - remainingData);
			const writePcr = isFirstTsPacket && flags.pcr !== null;

			let adaptationFieldSize: number;
			if (writePcr) {
				// length + flags + 6 PCR bytes
				adaptationFieldSize = Math.max(8, basePaddingNeeded);
			} else if (randomAccessIndicator || discontinuityIndicator) {
				// We need at least two bytes
				adaptationFieldSize = Math.max(2, basePaddingNeeded);
			} else {
				adaptationFieldSize = basePaddingNeeded;
			}

			let adaptationField: Uint8Array | null = null;
			if (adaptationFieldSize > 0) {
				const buf = this.adaptationFieldBuffer;

				if (adaptationFieldSize === 1) {
					buf[0] = 0; // adaptation_field_length
				} else {
					buf[0] = adaptationFieldSize - 1; // adaptation_field_length
					buf[1]
						= (Number(discontinuityIndicator) << 7) // discontinuity_indicator
							| (Number(randomAccessIndicator) << 6) // random_access_indicator
							| (Number(writePcr) << 4); // PCR_flag
					let stuffingStart = 2;
					if (writePcr) {
						// A constant-rate stream's clock is its byte position, which is what makes the PCR and
						// the rate agree; otherwise the decode timeline is the only clock there is
						if (this.muxRate !== null) {
							writePcr27Into(buf, 2, this.byteClock27MHz());
							// Here rather than after the PES: the PCR rides the FIRST packet of it, so
							// noting the clock at the end would place it however many packets the PES
							// is long past where the PCR actually sits, and delay the next one by that
							// much. A keyframe is hundreds of packets.
							this.noteWrittenPcr();
						} else {
							writePcrInto(buf, 2, flags.pcr!);
						}
						stuffingStart = 8;
					}
					buf.fill(0xFF, stuffingStart, adaptationFieldSize); // stuffing_bytes
				}

				adaptationField = buf.subarray(0, adaptationFieldSize);
			}

			const payloadSize = Math.min(184 - adaptationFieldSize, remainingData);
			const payload = this.payloadBuffer.subarray(0, payloadSize);

			let payloadOffset = 0;
			if (offset < pesHeader.length) {
				const headerBytes = Math.min(pesHeader.length - offset, payloadSize);
				payload.set(pesHeader.subarray(offset, offset + headerBytes), 0);
				payloadOffset = headerBytes;
			}

			const dataStart = Math.max(0, offset - pesHeader.length);
			const dataEnd = dataStart + (payloadSize - payloadOffset);
			if (payloadOffset < payloadSize) {
				payload.set(data.subarray(dataStart, dataEnd), payloadOffset);
			}

			this.writeTsPacket(pid, pusi, adaptationField, payload);

			offset += payloadSize;
			isFirstTsPacket = false;
		}
	}

	/** The 27 MHz clock the stream's own bit rate puts the next packet at. */
	private byteClock27MHz() {
		assert(this.muxRate !== null);
		return Math.round(this.packetsWritten * TS_PACKET_SIZE * 8 * 27_000_000 / this.muxRate);
	}

	/**
	 * Fills with null packets until the byte clock reaches `streamTime`, which is what makes the stream
	 * constant bit rate. Nothing to do when no rate was asked for.
	 */
	private padTo(streamTime: number) {
		if (this.muxRate === null) {
			return;
		}

		// Measured from the stream's own first media time rather than from zero: a track that starts
		// below zero - AAC priming does - would otherwise leave the byte clock behind the media for the
		// whole file, and the rate would come out under what was asked for.
		const elapsed = streamTime - (this.firstWrittenTimestamp ?? streamTime);
		const target = Math.floor(elapsed * this.muxRate / (TS_PACKET_SIZE * 8));

		const allowance = CBR_LEAD_ALLOWANCE * this.muxRate / (TS_PACKET_SIZE * 8);
		if (this.packetsWritten > target + allowance) {
			const needed = this.packetsWritten * TS_PACKET_SIZE * 8 / elapsed;
			throw new InvalidUsageError(
				`muxRate is ${this.muxRate} bits per second, but by ${streamTime.toFixed(3)}s this output has`
				+ ` written ${this.packetsWritten} packets, which needs ${Math.round(needed)}. Raise muxRate`
				+ ' or lower the media bitrate.',
			);
		}

		while (this.packetsWritten < target) {
			this.writeNullPacket();
		}
	}

	/** A null packet: PID 0x1fff with a payload of no meaning, which is what a CBR stream pads with. */
	private writeNullPacket() {
		this.payloadBuffer.fill(0xFF);
		this.writeTsPacket(NULL_PACKET_PID, false, null, this.payloadBuffer);
	}

	/** Remembers where the byte clock stood when a PCR went out. */
	private noteWrittenPcr() {
		if (this.muxRate !== null) {
			this.lastPcrByteClock = this.byteClock27MHz();
		}
	}

	/**
	 * Keeps the PCR spacing against the **byte clock** rather than against the PCR track's packets.
	 *
	 * Spacing them by stream time only works when the PCR track is the only thing advancing the clock.
	 * Add audio, tables and the null packets a constant rate pads with, and by the time the next video
	 * frame is reached the byte clock is already past every instant the fill wanted to place a PCR at -
	 * `padTo` has nothing left to pad, so the whole interval's worth comes out in a burst at the frame,
	 * one packet apart, and the stretch between frames carries no clock at all. Measured on a 3 Mb/s
	 * multiplex of one video and two audio tracks: seven PCRs inside 1880 octets, then nothing for
	 * 0.15 s.
	 *
	 * Under a constant rate the byte clock is the time base, so checking it after every packet - media,
	 * table or null - is both sufficient and the only thing that cannot be outrun.
	 */
	private maybeWritePcrForByteClock() {
		if (
			this.muxRate === null
			|| this.pcrPid === null
			|| this.writingByteClockPcr
			|| this.lastPcrByteClock === null
		) {
			return;
		}

		const elapsed = this.byteClock27MHz() - this.lastPcrByteClock;
		if (elapsed < this.pcrInterval * 27_000_000) {
			return;
		}

		this.writingByteClockPcr = true;
		try {
			const field = this.adaptationFieldBuffer;
			field.fill(0xFF);
			field[0] = 183; // adaptation_field_length: every byte of the packet after this one
			field[1] = 0x10; // PCR_flag, everything else 0
			writePcr27Into(field, 2, this.byteClock27MHz());

			this.noteWrittenPcr();
			this.writeTsPacket(this.pcrPid, false, field, EMPTY_PAYLOAD);
		} finally {
			this.writingByteClockPcr = false;
		}
	}

	private writeTsPacket(
		pid: number,
		pusi: boolean,
		adaptationField: Uint8Array | null,
		payload: Uint8Array,
	) {
		const hasPayload = payload.length > 0;

		// 13818-1 2.4.3.3: the continuity counter increments only on a packet that carries a payload, and
		// a packet without one repeats the value of the packet before it. The map therefore holds what
		// was last *written* rather than what to write next - holding the next value gave an
		// adaptation-only packet the increment and then repeated it on the payload packet after it,
		// which an analyser reads as two continuity errors on a clean programme.
		const previous = this.continuityCounters.get(pid);
		const cc = previous === undefined
			? 0
			: hasPayload ? (previous + 1) & 0x0F : previous;
		const adaptCtrl = adaptationField
			? (hasPayload ? 0b11 : 0b10)
			: (hasPayload ? 0b01 : 0b00);

		this.packetBuffer[0] = 0x47; // sync_byte
		this.packetView.setUint16(1, (pusi ? 0x4000 : 0) | (pid & 0x1FFF), false); // TEI=0, PUSI, priority=0, PID
		// scrambling=0, adaptation_field_control, continuity_counter
		this.packetBuffer[3] = (adaptCtrl << 4) | (cc & 0x0F);

		this.continuityCounters.set(pid, cc);

		let offset = 4;

		if (adaptationField) {
			this.packetBuffer.set(adaptationField, offset);
			offset += adaptationField.length;
		}

		this.packetBuffer.set(payload, offset);
		offset += payload.length;

		if (offset < TS_PACKET_SIZE) {
			this.packetBuffer.fill(0xFF, offset); // stuffing_bytes
		}

		const startPos = this.writer.getPos();
		this.writer.write(this.packetBuffer);
		this.packetsWritten++;

		if (this.format._options.onPacket) {
			this.format._options.onPacket(this.packetBuffer.slice(), startPos);
		}

		// After the packet, so the clock this reads already includes it
		this.maybeWritePcrForByteClock();
	}

	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		try {
			this.closedTracks.add(track);

			const trackData = this.trackDatas.find(x => x.track === track);
			if (trackData) {
				await this.flushTimestampQueue(trackData, false);
			}

			if (this.allTracksAreKnown()) {
				this.allTracksKnown.resolve();
			}

			await this.interleavePackets();
		} finally {
			release();
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			this.closedTracks.add(trackData.track);
			await this.flushTimestampQueue(trackData, false);
		}

		await this.interleavePackets(true);

		// Only under a constant rate, and that qualification is the whole point. There, the last
		// packet's duration is filled with null packets, so without this the stream ends with a
		// stretch of padding carrying no clock. Under a variable rate nothing is written after the
		// last PES at all, so a PCR here would sit past the last frame with nothing to pace - and it
		// breaks the one invariant a segmented writer has: the bytes for frames A must be a prefix of
		// the bytes for A then B, or a segment fetched part by part differs from the same segment
		// fetched whole.
		if (this.muxRate !== null && this.pcrPid !== null && this.lastPcrTimestamp !== null) {
			this.fillPcrUpTo(this.lastWrittenEndTimestamp);
		}
		this.padTo(this.lastWrittenEndTimestamp);
		await this.writer.flush();

		release();
	}
}

/**
 * DVB text (EN 300 468 Annex A): ASCII is the default character table and goes out as-is, anything else
 * is UTF-8 behind the 0x15 selector.
 */
const dvbText = (text: string) => {
	const utf8 = textEncoder.encode(text);
	if (utf8.every(byte => byte >= 0x20 && byte < 0x80)) {
		return utf8;
	}

	const result = new Uint8Array(utf8.length + 1);
	result[0] = 0x15; // Character code table: UTF-8
	result.set(utf8, 1);
	return result;
};

/**
 * Service Description Table for this transport stream's one program, carrying the `service_descriptor`
 * a receiver shows as the channel name (EN 300 468 5.2.3, 6.2.33).
 */
const buildSdt = (
	transportStreamId: number,
	programNumber: number,
	service: { name: string; provider: string; type?: number | null; originalNetworkId?: number | null },
) => {
	const provider = dvbText(service.provider);
	const name = dvbText(service.name);
	if (provider.length > 0xff || name.length > 0xff) {
		throw new InvalidUsageError(
			'A DVB service_descriptor holds at most 255 bytes of provider name and 255 of service name.',
		);
	}

	const descriptorLength = 1 + 1 + provider.length + 1 + name.length;
	// transport_stream_id(2) + version/current_next(1) + section_number(1) + last_section_number(1)
	// + original_network_id(2) + reserved(1) + the one service's 5 bytes + its descriptors + CRC(4)
	const sectionLength = 8 + 5 + 2 + descriptorLength + 4;
	const section = new Uint8Array(3 + sectionLength - 4);
	const view = toDataView(section);

	section[0] = 0x42; // table_id: SDT for the actual transport stream
	view.setUint16(1, 0xF000 | (sectionLength & 0x0FFF), false);
	view.setUint16(3, transportStreamId, false);
	section[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number
	view.setUint16(8, service.originalNetworkId ?? 1, false);
	section[10] = 0xFF; // reserved_future_use

	view.setUint16(11, programNumber, false); // service_id, which is the program_number
	section[13] = 0xFC;
	view.setUint16(14, 0x8000 | (2 + descriptorLength), false);

	section[16] = 0x48; // descriptor_tag: service_descriptor
	section[17] = descriptorLength;
	section[18] = service.type ?? 0x01; // service_type: digital television
	section[19] = provider.length;
	section.set(provider, 20);
	let offset = 20 + provider.length;
	section[offset++] = name.length;
	section.set(name, offset);

	const crc = computeMpegTsCrc32(section);
	const result = new Uint8Array(section.length + 4);
	result.set(section, 0);
	toDataView(result).setUint32(section.length, crc, false); // CRC_32

	return result;
};

const buildPat = (transportStreamId: number, programNumber: number, pmtPid: number) => {
	const section = new Uint8Array(16);
	const view = toDataView(section);
	section[0] = 0x00; // table_id
	view.setUint16(1, 0xB00D, false); // section_syntax_indicator=1, '0', reserved=11, section_length=13
	view.setUint16(3, transportStreamId, false); // transport_stream_id
	section[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number
	view.setUint16(8, programNumber, false); // program_number
	view.setUint16(10, 0xE000 | (pmtPid & 0x1FFF), false); // reserved=111, program_map_PID
	view.setUint32(12, computeMpegTsCrc32(section.subarray(0, 12)), false); // CRC_32
	return section;
};

// SAMPLE-AES marks each encrypted elementary stream with a private data indicator, and an encrypted
// audio stream additionally carries its setup information in a registration descriptor.
const sampleAesDescriptorsFor = (trackData: MpegTsTrackData): Uint8Array[] => {
	if (trackData.streamType === MpegTsStreamType.SAMPLE_AES_AVC) {
		return [buildPrivateDataIndicatorDescriptor('zavc')];
	}
	if (trackData.streamType === MpegTsStreamType.SAMPLE_AES_AAC) {
		assert(trackData.audioSetupData);
		return [
			buildPrivateDataIndicatorDescriptor('aacd'),
			buildAudioSetupDescriptor('zaac', trackData.audioSetupData),
		];
	}
	return [];
};

// 2.4.4.9 allows PCR_PID=0x1FFF only for a program with no PCR at all
const pcrTrackOf = (trackDatas: MpegTsTrackData[]) =>
	trackDatas.find(trackData => trackData.track.type === 'video') ?? trackDatas[0] ?? null;

/** PCR: 33-bit base at 90 kHz, 6 reserved bits, 9-bit extension at 27 MHz/300. */
/** A 33-bit PES timestamp in the five bytes 13818-1 2.4.3.7 states it in, marker bits included. */
const writePesTimestamp = (bitstream: Bitstream, marker: number, timestamp: number) => {
	bitstream.writeBits(4, marker);
	bitstream.writeBits(3, Math.floor(timestamp / 2 ** 30));
	bitstream.writeBits(1, 1);
	bitstream.writeBits(15, Math.floor(timestamp / 2 ** 15) % 2 ** 15);
	bitstream.writeBits(1, 1);
	bitstream.writeBits(15, timestamp % 2 ** 15);
	bitstream.writeBits(1, 1);
};

const writePcr27Into = (buf: Uint8Array, offset: number, ticks27MHz: number) => {
	const base = Math.floor(ticks27MHz / 300); // 90 kHz
	const extension = ticks27MHz - base * 300;

	buf[offset] = Math.floor(base / 2 ** 25) & 0xFF;
	buf[offset + 1] = Math.floor(base / 2 ** 17) & 0xFF;
	buf[offset + 2] = Math.floor(base / 2 ** 9) & 0xFF;
	buf[offset + 3] = Math.floor(base / 2) & 0xFF;
	// low base bit, 6 reserved bits, the extension's high bit
	buf[offset + 4] = ((base % 2) << 7) | 0x7E | ((extension >> 8) & 1);
	buf[offset + 5] = extension & 0xFF;
};

const writePcrInto = (buf: Uint8Array, offset: number, base90kHz: number) =>
	writePcr27Into(buf, offset, base90kHz * 300);

/**
 * `audio_type` for an audio track, from ISO/IEC 13818-1 Table 2-61. This is the only place a track's
 * accessibility disposition reaches a transport stream: there is no other field for it, and a receiver
 * choosing between an ordinary mix and an accessible one reads this.
 *
 * The field holds **one** value, and the standard's codes are mutually exclusive, so a track flagged
 * both ways has to collapse to one. Visual-impaired wins because it names a distinct programme element
 * — an audio description is its own mix — where hearing-impaired describes how an ordinary mix is
 * balanced.
 */
const audioTypeOf = (trackData: MpegTsTrackData): number => {
	if (trackData.track.type !== 'audio') {
		return 0x00;
	}

	const disposition = trackData.track.metadata.disposition;
	if (disposition?.visuallyImpaired) {
		return 0x03; // visual_impaired_commentary
	}
	if (disposition?.hearingImpaired) {
		return 0x02; // hearing_impaired
	}
	return 0x00; // undefined
};

/** ISO/IEC 13818-1 2.6.18: tag, length, three ISO 639-2 characters, and `audio_type`. */
const languageDescriptor = (languageCode: string, audioType: number) => new Uint8Array([
	LANGUAGE_DESCRIPTOR_TAG,
	4,
	languageCode.charCodeAt(0),
	languageCode.charCodeAt(1),
	languageCode.charCodeAt(2),
	audioType,
]);

/**
 * Every ES descriptor a track carries. A language descriptor sits alongside whatever else the stream
 * type calls for, so these are one list rather than the exclusive branches this used to write.
 */
const esDescriptorsOf = (trackData: MpegTsTrackData) => {
	const descriptors = sampleAesDescriptorsFor(trackData);

	// Only where SAMPLE-AES wrote none: its descriptors already state the format
	if (descriptors.length === 0) {
		if (trackData.streamType === MpegTsStreamType.AC3_SYSTEM_A) {
			descriptors.push(AC3_REGISTRATION_DESCRIPTOR);
		} else if (trackData.streamType === MpegTsStreamType.EAC3_SYSTEM_A) {
			descriptors.push(EAC3_REGISTRATION_DESCRIPTOR);
		}
	}

	const languageCode = trackData.track.metadata.languageCode;
	const audioType = audioTypeOf(trackData);
	// An accessible track with no stated language still needs the descriptor: `und` is a language and
	// the audio_type beside it is the part a receiver selects on
	if ((languageCode !== undefined && languageCode !== UNDETERMINED_LANGUAGE) || audioType !== 0x00) {
		descriptors.push(languageDescriptor(languageCode ?? UNDETERMINED_LANGUAGE, audioType));
	}

	return descriptors;
};

const descriptorBytesOf = (stream: MpegTsPrivateStreamDeclaration) =>
	stream.descriptors.reduce((sum, descriptor) => sum + descriptor.byteLength, 0);

const buildPmt = (
	trackDatas: MpegTsTrackData[],
	scte35Pid: number | null,
	privateStreams: MpegTsPrivateStreamDeclaration[],
	programNumber: number,
	pcrPid: number | null,
) => {
	const esDescriptors = new Map<MpegTsTrackData, Uint8Array[]>();

	let totalEsBytes = 0;
	for (const trackData of trackDatas) {
		totalEsBytes += 5;

		const descriptors = esDescriptorsOf(trackData);
		esDescriptors.set(trackData, descriptors);
		totalEsBytes += descriptors.reduce((sum, descriptor) => sum + descriptor.length, 0);
	}

	for (const stream of privateStreams) {
		totalEsBytes += 5 + descriptorBytesOf(stream);
	}

	if (scte35Pid !== null) {
		totalEsBytes += 5 + CUEI_REGISTRATION_DESCRIPTOR.length;
	}

	// SCTE 35 §8.1 puts the CUEI registration in the program's own descriptor loop, not only on the cue
	// elementary stream, and a receiver reads it from there. libavformat keys on exactly that: its
	// `prog_reg_desc` is filled from the program_info loop, and stream type 0x86 maps to SCTE-35 only
	// when it equals "CUEI" (mpegts.c, `if (stream_type == STREAM_TYPE_SCTE_DATA_SCTE_35 &&
	// prog_reg_desc == AV_RL32("CUEI"))`). With the registration on the ES alone, ffprobe shows the
	// stream with codec_tag CUEI and no codec at all — the type is read and then not placed.
	const programInfoLength = scte35Pid !== null ? CUEI_REGISTRATION_DESCRIPTOR.length : 0;

	const sectionLength = 9 + programInfoLength + totalEsBytes + 4;
	const section = new Uint8Array(3 + sectionLength - 4);
	const view = toDataView(section);

	section[0] = 0x02; // table_id
	// section_syntax_indicator=1, '0', reserved=11, section_length
	view.setUint16(1, 0xB000 | (sectionLength & 0x0FFF), false);
	view.setUint16(3, programNumber, false); // program_number
	section[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number
	view.setUint16(8, 0xE000 | ((pcrPid ?? 0x1FFF) & 0x1FFF), false); // reserved=111, PCR_PID
	view.setUint16(10, 0xF000 | programInfoLength, false); // reserved=1111, program_info_length

	let offset = 12;
	if (scte35Pid !== null) {
		section.set(CUEI_REGISTRATION_DESCRIPTOR, offset);
		offset += CUEI_REGISTRATION_DESCRIPTOR.length;
	}
	for (const trackData of [...trackDatas].sort((a, b) => a.pid - b.pid)) { // In PID order
		section[offset++] = trackData.streamType; // stream_type
		view.setUint16(offset, 0xE000 | (trackData.pid & 0x1FFF), false); // reserved=111, elementary_PID
		offset += 2;

		const descriptors = esDescriptors.get(trackData)!;
		const length = descriptors.reduce((sum, descriptor) => sum + descriptor.length, 0);
		view.setUint16(offset, 0xF000 | length, false); // reserved=1111, ES_info_length
		offset += 2;
		for (const descriptor of descriptors) {
			section.set(descriptor, offset);
			offset += descriptor.length;
		}
	}

	for (const stream of privateStreams) {
		section[offset++] = stream.streamType ?? MpegTsStreamType.PRIVATE_DATA;
		view.setUint16(offset, 0xE000 | (stream.pid & 0x1FFF), false);
		offset += 2;
		view.setUint16(offset, 0xF000 | descriptorBytesOf(stream), false);
		offset += 2;
		for (const descriptor of stream.descriptors) {
			section.set(descriptor, offset);
			offset += descriptor.byteLength;
		}
	}

	if (scte35Pid !== null) {
		// SCTE 35 signalling: stream type 0x86 with the CUEI registration, which is what tells a cue
		// stream apart from the Blu-ray meaning of the same type
		section[offset++] = SCTE35_STREAM_TYPE;
		view.setUint16(offset, 0xE000 | (scte35Pid & 0x1FFF), false);
		offset += 2;
		view.setUint16(offset, 0xF000 | CUEI_REGISTRATION_DESCRIPTOR.length, false);
		offset += 2;
		section.set(CUEI_REGISTRATION_DESCRIPTOR, offset);
		offset += CUEI_REGISTRATION_DESCRIPTOR.length;
	}

	const crc = computeMpegTsCrc32(section);
	const result = new Uint8Array(section.length + 4);
	result.set(section, 0);
	toDataView(result).setUint32(section.length, crc, false); // CRC_32

	return result;
};
