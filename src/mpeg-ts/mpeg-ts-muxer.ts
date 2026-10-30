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
} from './mpeg-ts-misc';

// Resources:
// ISO/IEC 13818-1

const EMPTY_PAYLOAD = new Uint8Array(0);
const PAT_PID = 0x0000;
const SDT_PID = 0x0011;
const NULL_PACKET_PID = 0x1FFF;
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

const AVC_AUD_NAL = new Uint8Array([0x09, 0xF0]);
const HEVC_AUD_NAL = new Uint8Array([0x46, 0x01]);

type MpegTsTrackData = {
	track: OutputVideoTrack | OutputAudioTrack;
	pid: number;
	streamType: MpegTsStreamType;
	streamId: number;
	codecString: string;
	timestampProcessingQueue: QueuedPacket[];
	packetQueue: QueuedPacket[];
	inputIsAnnexB: boolean | null;
	inputIsAdts: boolean | null;
	avcDecoderConfig: AvcDecoderConfigurationRecord | null;
	hevcDecoderConfig: HevcDecoderConfigurationRecord | null;
	adtsHeader: Uint8Array | null;
	adtsHeaderBitstream: Bitstream | null;
	/** AudioSpecificConfig, for the SAMPLE-AES audio setup descriptor; null when not encrypting. */
	audioSetupData: Uint8Array | null;
	firstPacketWritten: boolean;
	closed: boolean;
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
	/** The declared SCTE-35 PID, read once so a section can be written before any table is built. */
	readonly scte35Pid: number | null;
	readonly tableRepeatInterval: number;
	private readonly patInterval: number;
	private readonly pmtInterval: number;
	private readonly pcrInterval: number;
	private readonly sdtInterval: number;
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
		this.muxRate = format._options.muxRate ?? null;
		this.service = format._options.service ?? null;
		// The timed-metadata stream is an ordinary private stream whose descriptors this library knows,
		// so it joins the declared ones rather than being a second mechanism
		const timedMetadataPid = format._options.timedMetadataPid;
		this.timedMetadataPid = timedMetadataPid ?? null;
		this.privateStreams = [
			...(format._options.privateStreams ?? []),
			...(timedMetadataPid === undefined
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

		this.writer = await this.output._getRootWriter(true);

		release();
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
			packetQueue: [],
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcDecoderConfig: null,
			adtsHeader: null,
			adtsHeaderBitstream: null,
			audioSetupData: null,
			firstPacketWritten: false,
			closed: false,
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
				streamType = audioEncryption ? MpegTsStreamType.SAMPLE_AES_AAC : MpegTsStreamType.AAC;
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
			packetQueue: [],
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcDecoderConfig: null,
			adtsHeader: null,
			adtsHeaderBitstream: null,
			audioSetupData: audioEncryption
				? toUint8Array(meta.decoderConfig.description ?? new Uint8Array(0))
				: null,
			firstPacketWritten: false,
			closed: false,
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
			// Not a NAL stream: an AVC or HEVC access unit delimiter prepended here reads as a slice
			return packet.data;
		}

		if (trackData.inputIsAnnexB === null) {
			// This is the first packet
			const description = meta?.decoderConfig?.description;
			trackData.inputIsAnnexB = !description;

			if (!trackData.inputIsAnnexB) {
				const bytes = toUint8Array(description!);
				if (codec === 'avc') {
					trackData.avcDecoderConfig = deserializeAvcDecoderConfigurationRecord(bytes);
				} else {
					trackData.hevcDecoderConfig = deserializeHevcDecoderConfigurationRecord(bytes);
				}
			}
		}

		const annexB = trackData.inputIsAnnexB
			? this.prepareAnnexBVideoPacket(packet.data, codec as 'avc' | 'hevc')
			: this.prepareLengthPrefixedVideoPacket(trackData, packet, codec as 'avc' | 'hevc');

		// After Annex B framing, so the parameter sets and AUD this adds stay clear, as the spec requires
		const encryption = this.format._options.sampleAesEncryption;
		return encryption ? sampleAesEncryptAnnexBAccessUnit(annexB, encryption) : annexB;
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

		// Pretend the AUD
		const aud = codec === 'avc'
			? AVC_AUD_NAL
			: HEVC_AUD_NAL;
		nalUnits.unshift(aud);

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
		const aud = codec === 'avc'
			? AVC_AUD_NAL
			: HEVC_AUD_NAL;
		nalUnits.unshift(aud);

		return concatNalUnitsInAnnexB(nalUnits);
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
			trackData.inputIsAdts = !description;

			if (!trackData.inputIsAdts) {
				const config = parseAacAudioSpecificConfig(toUint8Array(description!));
				const template = buildAdtsHeaderTemplate(config);
				trackData.adtsHeader = template.header;
				trackData.adtsHeaderBitstream = template.bitstream;
			}
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

	private encryptAdtsIfNeeded(frame: Uint8Array) {
		const encryption = this.format._options.sampleAesEncryption;
		return encryption ? sampleAesEncryptAdtsFrame(frame, encryption) : frame;
	}

	private allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
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

		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const queuedPacket = trackData.timestampProcessingQueue[i]!;
			queuedPacket.decodeTimestamp = reordered
				? queuedPacket.sourceDecodeTimestamp
				// Nothing stated: the i'th packet to decode presents no earlier than the i'th smallest
				: Math.min(sortedTimestamps[i]!, queuedPacket.presentationTimestamp);
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
					// sourceDecodeTimestamp too: a reordered track's own decode time is still provisional
					// until enough of it has been seen, and the source may already state the real one
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
					&& !trackData.closed
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
			this.repeatTablesIfDue(queuedPacket);
			this.writePcrIfDue(
				// The decode timestamp, which is the clock the track's own PCRs are stamped from and the
				// only one that rises monotonically in the order packets are written
				queuedPacket.decodeTimestamp ?? queuedPacket.presentationTimestamp,
				trackWithMinTimestamp.pid,
			);
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
	private writeTableSections(pat = true, pmt = true, sdt = this.service !== null) {
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

		// `writeTables` has just written them, so each period starts here rather than at zero
		this.lastPatTimestamp ??= now;
		this.lastPmtTimestamp ??= now;
		this.lastSdtTimestamp ??= now;

		const pat = this.tableIsDue(this.patInterval, this.lastPatTimestamp, now, packet.isKeyframe);
		const pmt = this.tableIsDue(this.pmtInterval, this.lastPmtTimestamp, now, packet.isKeyframe);
		const sdt = this.service !== null
			&& this.tableIsDue(this.sdtInterval, this.lastSdtTimestamp, now, packet.isKeyframe);
		if (!pat && !pmt && !sdt) {
			return;
		}

		this.padTo(now);
		this.writeTableSections(pat, pmt, sdt);
		if (pat) {
			this.lastPatTimestamp = now;
		}
		if (pmt) {
			this.lastPmtTimestamp = now;
		}
		if (sdt) {
			this.lastSdtTimestamp = now;
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
	 * Fills the gap to the PCR track's next packet with PCR-only packets, which is what keeps the
	 * spacing where that track has gone quiet or where the PCR PID names no track at all.
	 *
	 * Stamped at one interval past the last PCR rather than from `now`: `now` is the clock of whichever
	 * track the interleave reached, and only the PCR track's own is the one the PCRs are on. Audio
	 * states no decode timeline, so taking its presentation time would put a PCR ahead of a video
	 * decode time still to be written - and a PCR that goes backwards is worse than one that is late.
	 */
	private writePcrIfDue(now: number, pidAboutToCarryPcr: number | null) {
		if (this.pcrPid === null || pidAboutToCarryPcr === this.pcrPid) {
			return;
		}

		// A PCR track that has not written its first packet stamps the first PCR itself
		if (this.lastPcrTimestamp === null && this.trackDatas.some(x => x.pid === this.pcrPid)) {
			return;
		}

		// No track carries the clock, so the first PCR goes out here
		let last: number = this.lastPcrTimestamp ?? now - this.pcrInterval;

		// Where the clock will be next: the PCR track's own packet, or the interleave's position when
		// that track has nothing left to say
		const until = this.nextPcrTrackTimestamp() ?? now;

		const field = this.adaptationFieldBuffer;
		while (last + this.pcrInterval < until) {
			const timestamp = last + this.pcrInterval;

			this.padTo(timestamp);

			field.fill(0xFF);
			field[0] = 183; // adaptation_field_length: every byte of the packet after this one
			field[1] = 0x10; // PCR_flag, everything else 0
			if (this.muxRate !== null) {
				writePcr27Into(field, 2, this.byteClock27MHz());
			} else {
				writePcrInto(field, 2, secondsToMpegTsTimestamp(timestamp + this.timestampOffset));
			}

			this.writeTsPacket(this.pcrPid, false, field, EMPTY_PAYLOAD);
			last = timestamp;
			this.lastPcrTimestamp = timestamp;
		}
	}

	private writeTables() {
		assert(!this.tablesWritten);

		// Track PIDs are handed out as tracks arrive, so a declared one can only be checked now
		const used = new Map<number, string>([[PAT_PID, 'the PAT'], [this.pmtPid, 'the PMT']]);
		if (this.service !== null) {
			used.set(SDT_PID, 'the SDT');
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

		// Right behind the first PMT, which is where "before the first media packet" puts a cue
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

		// Queued either way, then written if the tables are already out. One path rather than two: the
		// PMT cannot be built before a track has data, or it would name this cue stream and no media.
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

		const pesPacketLength = trackData.track.type === 'video'
			? 0 // Unbounded
			: Math.min(8 + queuedPacket.data.length, 0xFFFF); // Required for audio for some reason
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

		// One per access unit stays well inside the 0.1 s the spec allows. Only video states a decode
		// timestamp, and the PCR track is whatever `pcrPid` names - an audio one would otherwise stamp
		// every PCR NaN.
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

		// A burst runs ahead of the rate and the buffer absorbs it; past the allowance the media simply
		// needs more than the rate, and writing it anyway would produce a stream that is not the rate it
		// claims to be
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
	}

	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.trackDatas.find(x => x.track === track);
			if (trackData) {
				trackData.closed = true;
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
			trackData.closed = true;
			await this.flushTimestampQueue(trackData, false);
		}

		await this.interleavePackets(true);

		// Without this the file's last fraction of a second is missing, so its size over its duration
		// comes out under the rate it claims
		this.padTo(this.lastWrittenEndTimestamp);
		await this.writer.flush();

		release();
	}
}

// CRC-32 for MPEG-TS (polynomial 0x04C11DB7, initial value 0xFFFFFFFF)
const MPEG_TS_CRC_POLYNOMIAL = 0x04c11db7;
const MPEG_TS_CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let crc = n << 24;

	for (let k = 0; k < 8; k++) {
		crc = (crc & 0x80000000)
			? ((crc << 1) ^ MPEG_TS_CRC_POLYNOMIAL)
			: (crc << 1);
	}

	MPEG_TS_CRC_TABLE[n] = (crc >>> 0) & 0xffffffff;
}

const computeMpegTsCrc32 = (data: Uint8Array) => {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		const byte = data[i]!;
		crc = ((crc << 8) ^ MPEG_TS_CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}
	return crc;
};

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
	service: { name: string; provider: string; type?: number; originalNetworkId?: number },
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
	// section_syntax_indicator=1, reserved_future_use=1, reserved=11, section_length
	view.setUint16(1, 0xF000 | (sectionLength & 0x0FFF), false);
	view.setUint16(3, transportStreamId, false);
	section[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number
	view.setUint16(8, service.originalNetworkId ?? 1, false);
	section[10] = 0xFF; // reserved_future_use

	view.setUint16(11, programNumber, false); // service_id, which is the program_number
	// reserved_future_use=111111, EIT_schedule_flag=0, EIT_present_following_flag=0
	section[13] = 0xFC;
	// running_status=4 (running), free_CA_mode=0, descriptors_loop_length
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

/** ISO/IEC 13818-1 2.6.18: tag, length, three ISO 639-2 characters, and `audio_type`. */
const languageDescriptor = (languageCode: string) => new Uint8Array([
	LANGUAGE_DESCRIPTOR_TAG,
	4,
	languageCode.charCodeAt(0),
	languageCode.charCodeAt(1),
	languageCode.charCodeAt(2),
	0x00, // audio_type: undefined, which is what a track that only states a language means
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
	if (languageCode !== undefined && languageCode !== UNDETERMINED_LANGUAGE) {
		descriptors.push(languageDescriptor(languageCode));
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

	const sectionLength = 9 + totalEsBytes + 4;
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
	view.setUint16(10, 0xF000, false); // reserved=1111, program_info_length=0

	let offset = 12;
	for (const trackData of trackDatas) {
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
