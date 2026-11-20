/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { modEuclid, toDataView } from '../misc';

export const MPEG_TS_TIMESCALE = 90_000; // MPEG-TS timestamps run on a 90 kHz clock
export const TIMESTAMP_MODULUS = 2 ** 33;
export const TS_PACKET_SIZE = 188;
/** @internal */
export const PAT_PID = 0x0000;
/** PID 0x1fff, which carries packets of no meaning; a constant bit rate stream pads with these. */
export const NULL_PACKET_PID = 0x1FFF;
/** @internal */
export const REGISTRATION_DESCRIPTOR_TAG = 0x05;
/** ISO/IEC 13818-1 2.6.18, `ISO_639_language_descriptor`. */
export const LANGUAGE_DESCRIPTOR_TAG = 0x0a;

export type TimestampWrapInfo = {
	reference: number;
};

export const enum MpegTsStreamType {
	MP3_MPEG1 = 0x03,
	MP3_MPEG2 = 0x04,
	AAC = 0x0f,
	/** AAC in LOAS/LATM framing rather than ADTS, ISO/IEC 13818-1 Table 2-34. */
	AAC_LATM = 0x11,
	AC3_SYSTEM_A = 0x81,
	EAC3_SYSTEM_A = 0x87,
	DTS = 0x82,
	DTS_ATSC = 0x8a,
	BLU_RAY_DTS_HD = 0x85,
	BLU_RAY_DTS_HD_MASTER = 0x86,
	BLU_RAY_DTS_EXPRESS_SECONDARY = 0xa2,
	PRIVATE_DATA = 0x06,
	MPEG2_VIDEO = 0x02,
	AVC = 0x1b,
	HEVC = 0x24,

	// HLS SAMPLE-AES replaces the clear stream types with these
	SAMPLE_AES_AVC = 0xdb,
	SAMPLE_AES_AAC = 0xcf,
	SAMPLE_AES_AC3 = 0xc1,
	SAMPLE_AES_EAC3 = 0xc2,
}

const fourCc = (code: string) => [...code].map(character => character.charCodeAt(0));

/**
 * `private_data_indicator_descriptor` (tag 0x0F), which is how HLS SAMPLE-AES marks an elementary
 * stream as encrypted: 'zavc' for H.264, 'aacd' for AAC, 'ac3d' and 'ec3d' for AC-3 and E-AC-3.
 * @internal
 */
export const buildPrivateDataIndicatorDescriptor = (code: string) =>
	new Uint8Array([0x0f, 0x04, ...fourCc(code)]);

/**
 * `registration_descriptor` (tag 0x05) carrying 'apad' and an `audio_setup_information()`:
 * audio_type (4), priming (2), version (1), setup_data_length (1), then setup_data. Apple requires
 * it alongside the private data indicator for an encrypted audio stream.
 * @internal
 */
export const buildAudioSetupDescriptor = (audioType: string, setupData: Uint8Array) => {
	const descriptor = new Uint8Array(2 + 4 + 8 + setupData.length);
	descriptor[0] = 0x05;
	descriptor[1] = descriptor.length - 2;
	descriptor.set(fourCc('apad'), 2);
	descriptor.set(fourCc(audioType), 6);
	descriptor[10] = 0x00;
	descriptor[11] = 0x00;
	descriptor[12] = 0x01; // version
	descriptor[13] = setupData.length;
	descriptor.set(setupData, 14);
	return descriptor;
};

export const buildMpegTsMimeType = (codecStrings: (string | null)[]) => {
	let string = 'video/MP2T';

	const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
	if (uniqueCodecStrings.length > 0) {
		string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
	}

	return string;
};

export const secondsToMpegTsTimestamp = (seconds: number) => {
	// This supports writing negative timestamps by simply Euclid-modding them. It is then up to the demuxer to
	// interpret them as negative, if it wants to.
	return modEuclid(Math.round(MPEG_TS_TIMESCALE * seconds), TIMESTAMP_MODULUS);
};

export const createTimestampWrapInfo = (firstTimestamp: number): TimestampWrapInfo => {
	const tolerance = 60 * MPEG_TS_TIMESCALE;
	return {
		reference: firstTimestamp >= TIMESTAMP_MODULUS - tolerance
			? firstTimestamp - tolerance - TIMESTAMP_MODULUS // Timestamps close to the modulus are treated as negative
			: firstTimestamp - tolerance,
	};
};

export const normalizeWrappedTimestamp = (timestamp: number, wrapInfo: TimestampWrapInfo) => {
	// Every timestamp is mapped into the modulus-wide window starting a bit below the first timestamp
	return wrapInfo.reference + modEuclid(timestamp - wrapInfo.reference, TIMESTAMP_MODULUS);
};

/** `stream_type` 0x15: metadata carried in PES packets (13818-1 table 2-34), which is what ID3 rides. */
export const METADATA_IN_PES_STREAM_TYPE = 0x15;

/**
 * The `metadata_descriptor` (tag 0x26) that marks a metadata stream as carrying ID3, byte for byte as
 * FFmpeg's `mpegtsenc` writes it for `AV_CODEC_ID_TIMED_ID3`. Both the application format and the
 * metadata format are the escape value followed by the `ID3 ` identifier.
 */
export const buildId3MetadataDescriptor = (): Uint8Array => {
	const id3 = [0x49, 0x44, 0x33, 0x20]; // 'ID3 '
	return new Uint8Array([
		0x26, // descriptor_tag: metadata_descriptor
		13, // descriptor_length
		0xff, 0xff, // metadata_application_format: escape, identifier follows
		...id3,
		0xff, // metadata_format: escape, identifier follows
		...id3,
		0x00, // metadata_service_id
		0x0f, // decoder_config_flags=0, DSM-CC_flag=0, reserved
	]);
};

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

/** @internal */
export const computeMpegTsCrc32 = (data: Uint8Array) => {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		const byte = data[i]!;
		crc = ((crc << 8) ^ MPEG_TS_CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}
	return crc;
};

/**
 * EN 300 468 Annex C's `UTC_time`: a 16-bit Modified Julian Date, then hours, minutes and seconds in
 * BCD. The epoch is 17 November 1858, which is 40,587 days before the Unix one - the value TSDuck's
 * `MJD_EPOCH` states and the only part of this that cannot be read off a byte layout.
 *
 * @internal
 */
export const MJD_UNIX_EPOCH = 40587;

/** @internal */
export const encodeBcd = (value: number) => (Math.floor(value / 10) << 4) | (value % 10);

/** @internal */
export const decodeBcd = (byte: number) => ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);

/**
 * Writes the five octets of a DVB `UTC_time` at `offset`.
 *
 * @internal
 */
export const writeDvbUtcTime = (bytes: Uint8Array, offset: number, time: Date) => {
	const unixDays = Math.floor(time.getTime() / 86_400_000);
	const mjd = unixDays + MJD_UNIX_EPOCH;

	bytes[offset] = (mjd >> 8) & 0xff;
	bytes[offset + 1] = mjd & 0xff;
	bytes[offset + 2] = encodeBcd(time.getUTCHours());
	bytes[offset + 3] = encodeBcd(time.getUTCMinutes());
	bytes[offset + 4] = encodeBcd(time.getUTCSeconds());
};

/**
 * Reads five octets of DVB `UTC_time` back.
 *
 * @internal
 */
export const readDvbUtcTime = (bytes: Uint8Array, offset: number): Date => {
	const mjd = (bytes[offset]! << 8) | bytes[offset + 1]!;
	const unixDays = mjd - MJD_UNIX_EPOCH;

	return new Date(
		unixDays * 86_400_000
		+ decodeBcd(bytes[offset + 2]!) * 3_600_000
		+ decodeBcd(bytes[offset + 3]!) * 60_000
		+ decodeBcd(bytes[offset + 4]!) * 1000,
	);
};

/** `hhmm` in BCD, as a local time offset is stated. Two octets. */
const writeOffsetBcd = (bytes: Uint8Array, offset: number, minutes: number) => {
	const absolute = Math.abs(minutes);
	bytes[offset] = encodeBcd(Math.floor(absolute / 60));
	bytes[offset + 1] = encodeBcd(absolute % 60);
};

/**
 * Time and Date Table: EN 300 468 5.2.5, the wall-clock time a receiver displays.
 *
 * A **short** section - `section_syntax_indicator` 0 - and the one DVB table that carries no CRC at
 * all, which TSDuck models by having a TDT not use a trailing CRC32 where a TOT does.
 *
 * @internal
 */
export const buildTdt = (time: Date) => {
	const section = new Uint8Array(8);
	section[0] = 0x70; // table_id
	// section_syntax_indicator=0, reserved_future_use=1, reserved=11, section_length=5
	section[1] = 0x70;
	section[2] = 0x05;
	writeDvbUtcTime(section, 3, time);

	return section;
};

/**
 * Time Offset Table: EN 300 468 5.2.6, the same time plus the local offsets that apply to it.
 *
 * A short section **with** a CRC32, which is the quirk: `section_syntax_indicator` is 0, so nothing in
 * the header says the CRC is there, and a parser has to know from the table id.
 *
 * @internal
 */
export const buildTot = (
	time: Date,
	regions: readonly {
		country: string;
		regionId?: number | null;
		offsetMinutes: number;
		nextChange: Date;
		nextOffsetMinutes: number;
	}[],
) => {
	// Each region is 13 octets: country(3) + region/polarity(1) + offset(2) + next change(5) + next(2)
	const descriptorLength = regions.length * 13;
	// UTC_time(5) + reserved/loop length(2) + the descriptor + CRC(4)
	const sectionLength = 5 + 2 + (descriptorLength > 0 ? 2 + descriptorLength : 0) + 4;
	const section = new Uint8Array(3 + sectionLength - 4);
	const view = toDataView(section);

	section[0] = 0x73; // table_id
	section[1] = 0x70 | ((sectionLength >> 8) & 0x0f);
	section[2] = sectionLength & 0xff;
	writeDvbUtcTime(section, 3, time);

	// reserved(4 bits) then descriptors_loop_length(12)
	view.setUint16(8, 0xf000 | (descriptorLength > 0 ? 2 + descriptorLength : 0), false);

	if (descriptorLength > 0) {
		section[10] = 0x58; // descriptor_tag: local_time_offset_descriptor
		section[11] = descriptorLength;

		let offset = 12;
		for (const region of regions) {
			const code = region.country.toUpperCase();
			section[offset] = code.charCodeAt(0);
			section[offset + 1] = code.charCodeAt(1);
			section[offset + 2] = code.charCodeAt(2);
			// country_region_id(6), reserved(1)=1, local_time_offset_polarity(1)
			section[offset + 3] = ((region.regionId ?? 0) << 2) | 0b10 | (region.offsetMinutes < 0 ? 1 : 0);
			writeOffsetBcd(section, offset + 4, region.offsetMinutes);
			writeDvbUtcTime(section, offset + 6, region.nextChange);
			writeOffsetBcd(section, offset + 11, region.nextOffsetMinutes);
			offset += 13;
		}
	}

	const crc = computeMpegTsCrc32(section);
	const result = new Uint8Array(section.length + 4);
	result.set(section, 0);
	toDataView(result).setUint32(section.length, crc, false);

	return result;
};

/**
 * Network Information Table for the actual network: EN 300 468 5.2.1.
 *
 * The delivery system descriptors are the caller's, because only they know the modulation and frequency
 * of the path this will travel. Without any, the table still names the network and lists this transport
 * stream, which is what associates the two.
 *
 * @internal
 */
export const buildNit = (
	networkId: number,
	networkName: Uint8Array,
	transportStreamId: number,
	originalNetworkId: number,
	transportDescriptors: readonly Uint8Array[],
) => {
	const nameDescriptorLength = 2 + networkName.length;
	const transportDescriptorLength = transportDescriptors.reduce((total, x) => total + x.length, 0);
	// transport_stream_id(2) + original_network_id(2) + reserved/descriptor length(2) + descriptors
	const transportLoopLength = 6 + transportDescriptorLength;

	// network_id(2) + version/current_next(1) + section(1) + last_section(1) + reserved/network
	// descriptor length(2) + descriptors + reserved/transport loop length(2) + the loop + CRC(4)
	const sectionLength = 5 + 2 + nameDescriptorLength + 2 + transportLoopLength + 4;
	const section = new Uint8Array(3 + sectionLength - 4);
	const view = toDataView(section);

	section[0] = 0x40; // table_id: NIT for the actual network
	view.setUint16(1, 0xf000 | (sectionLength & 0x0fff), false);
	view.setUint16(3, networkId, false);
	section[5] = 0xc1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number

	view.setUint16(8, 0xf000 | nameDescriptorLength, false); // reserved(4) + network_descriptors_length
	section[10] = 0x40; // descriptor_tag: network_name_descriptor
	section[11] = networkName.length;
	section.set(networkName, 12);

	let offset = 12 + networkName.length;
	view.setUint16(offset, 0xf000 | transportLoopLength, false); // reserved(4) + loop length
	offset += 2;

	view.setUint16(offset, transportStreamId, false);
	view.setUint16(offset + 2, originalNetworkId, false);
	view.setUint16(offset + 4, 0xf000 | transportDescriptorLength, false);
	offset += 6;
	for (const descriptor of transportDescriptors) {
		section.set(descriptor, offset);
		offset += descriptor.length;
	}

	const crc = computeMpegTsCrc32(section);
	const result = new Uint8Array(section.length + 4);
	result.set(section, 0);
	toDataView(result).setUint32(section.length, crc, false);

	return result;
};
