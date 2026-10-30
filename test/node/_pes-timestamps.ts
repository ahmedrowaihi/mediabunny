/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Reads PTS and DTS off each PES header in 90 kHz ticks; the demuxer unwraps and re-derives those. */
export const rawPesTimestamps = (bytes: Uint8Array) => {
	const out: { pid: number; pts: number; dts: number | null }[] = [];
	const readTimestamp = (at: number) => {
		const b = bytes;
		return (b[at]! >> 1 & 0x07) * 2 ** 30
			+ (b[at + 1]! << 22)
			+ ((b[at + 2]! >> 1) << 15)
			+ (b[at + 3]! << 7)
			+ (b[at + 4]! >> 1);
	};

	for (let i = 0; i + 188 <= bytes.length; i += 188) {
		const packet = bytes.subarray(i, i + 188);
		if (packet[0] !== 0x47 || !(packet[1]! & 0x40)) {
			continue; // not a payload-unit start, so no PES header here
		}
		const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
		let offset = 4;
		if ((packet[3]! >> 4) & 0x2) {
			offset += 1 + packet[4]!; // adaptation field
		}
		if (packet[offset] !== 0 || packet[offset + 1] !== 0 || packet[offset + 2] !== 1) {
			continue;
		}

		const flags = packet[offset + 7]!;
		const base = i + offset + 9;
		if ((flags & 0xc0) === 0) {
			continue;
		}
		const pts = readTimestamp(base);
		const dts = (flags & 0x40) ? readTimestamp(base + 5) : null;
		out.push({ pid, pts, dts });
	}

	return out;
};
