/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Sends a file as a live stream, for live-network-input.test.ts. A separate process because the
// receiver's accept blocks a libuv thread and would starve the sender sharing its pool.
//
//   tsx _live-sender.ts <source> <url> [--stop-after=<n>] [--silent-after=<n>] [--pause-after=<n> --pause-ms=<n>]

import { Demuxer, Muxer } from 'node-av/api';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const [source, url] = args as [string, string];
const stopAfterArg = args.find(a => a.startsWith('--stop-after='));
const stopAfter = stopAfterArg ? Number(stopAfterArg.slice('--stop-after='.length)) : Infinity;
const pauseArg = args.find(a => a.startsWith('--pause-after='));
const pauseAfter = pauseArg ? Number(pauseArg.slice('--pause-after='.length)) : Infinity;
const pauseMsArg = args.find(a => a.startsWith('--pause-ms='));
const pauseMs = pauseMsArg ? Number(pauseMsArg.slice('--pause-ms='.length)) : 0;
const silentAfterArg = args.find(a => a.startsWith('--silent-after='));
const silentAfter = silentAfterArg ? Number(silentAfterArg.slice('--silent-after='.length)) : Infinity;
// Closing an SRT socket right after the last write discards what is in flight; see FORK.md.
const DRAIN_MS = 400;

const input = await Demuxer.open(source);
const videoStream = input.video();
if (!videoStream) {
	throw new Error(`${source} has no video track to send.`);
}

// rtmp carries FLV, rtp carries MPEG-TS over RTP, everything else here carries MPEG-TS.
const format = /^rtmps?:/.test(url) ? 'flv' : /^rtp:/.test(url) ? 'rtp_mpegts' : 'mpegts';
const output = await Muxer.open(url, { format });

const audioStream = args.includes('--with-audio') ? input.audio() : null;
const outputIndices = new Map<number, number>();
for (const stream of audioStream ? [videoStream, audioStream] : [videoStream]) {
	const index = output.addStream(stream);
	outputIndices.set(stream.index, index);
	if (format === 'flv') {
		// The mp4 'avc1'/'hvc1'/'mp4a' tag rides along and FLV rejects it. node-av clears an incompatible
		// tag only when the format offers a replacement, and FLV's table offers none, so clear it here.
		output.getStream(index)!.codecpar.codecTag = 0;
	}
}

const timeBase = videoStream.timeBase;
const secondsPerTick = timeBase.num / timeBase.den;
const startedAt = Date.now();

let sent = 0;
let basePts: bigint | null = null;

// All mapped streams when audio is requested, so they interleave as the source has them.
const packetSource = audioStream ? input.packets() : input.packets(videoStream.index);

for await (const packet of packetSource) {
	if (!packet) {
		continue;
	}
	const outputIndex = outputIndices.get(packet.streamIndex);
	if (outputIndex === undefined) {
		continue;
	}

	// Paced off video only: audio rides along at whatever position the source interleaved it.
	if (packet.streamIndex === videoStream.index) {
		if (basePts === null) {
			basePts = packet.pts;
		}
		// Paced like ffmpeg's -re, or the receiver cannot tell the burst from a file.
		const dueAt = Number(packet.pts - basePts) * secondsPerTick * 1000;
		const behind = dueAt - (Date.now() - startedAt);
		if (behind > 1) {
			await sleep(behind);
		}
	}

	await output.writePacket(packet, outputIndex);
	// Counted on video alone, so --stop-after and --silent-after mean the same with or without audio.
	if (packet.streamIndex !== videoStream.index) {
		continue;
	}
	sent++;

	if (sent >= stopAfter) {
		// No drain, no trailer: the "sender vanishes" case.
		process.stdout.write(`${sent}\n`);
		process.exit(0);
	}

	if (sent === pauseAfter && pauseMs > 0) {
		// A stall inside a healthy stream, which a read bound must ride out rather than cut.
		await sleep(pauseMs);
	}

	if (sent >= silentAfter) {
		// Socket stays open and silent, so a reader's pull parks inside its native read.
		process.stdout.write(`${sent}\n`);
		await sleep(600_000);
	}
}

await sleep(DRAIN_MS);
// close() frees the format context without closing the socket, so the receiver would see no end until
// this process exits. Safe before close() only because MPEG-TS has no trailer to lose.
await output.getFormatContext().pb!.closep();
await output.close();
await input.close();

process.stdout.write(`${sent}\n`);
process.exit(0);
