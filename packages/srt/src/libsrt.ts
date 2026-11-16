/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The libsrt binding, for the socket-group (bonding) API that FFmpeg's `srt` protocol does not expose:
// its 38 documented options have nothing for groups, so a bonded link cannot be reached through an
// `srt://` URL and has to come from libsrt itself. Verified against libsrt 1.5.6's own srt.h.
//
// The group API is compiled in behind ENABLE_BONDING, so a build without it declares these functions
// in the header and exports no symbol. `getLibsrt` therefore checks for one of them at load rather
// than failing later on the first connect.

import koffi from 'koffi';

/**
 * The group types libsrt 1.5.6 implements; balancing is declared in the header but not built.
 *
 * A plain object rather than a `const enum`: a bundler that transpiles each module on its own cannot
 * inline a `const enum` member across files, so it erases to `undefined` and arrives at the library as
 * 0 - `SRT_GTYPE_UNDEFINED`, which fails with no error set and nothing to read.
 */
/** @internal */
export const SrtGroupType = {
	BROADCAST: 1,
	BACKUP: 2,
} as const;
/** @internal */
export type SrtGroupType = (typeof SrtGroupType)[keyof typeof SrtGroupType];

/** `SRT_SOCKOPT` values, which are public ABI — a release renumbering them would break every binary. */
/** @internal */
export const SrtOption = {
	SNDSYN: 1,
	RCVSYN: 2,
	PASSPHRASE: 26,
	PBKEYLEN: 27,
	RCVLATENCY: 43,
	PEERLATENCY: 44,
	STREAMID: 46,
	PAYLOADSIZE: 49,
	TRANSTYPE: 50,
} as const;
/** @internal */
export type SrtOption = (typeof SrtOption)[keyof typeof SrtOption];

/** @internal */
export const SRT_ERROR = -1;
/** `SRTT_LIVE`, the transmission type every option default below assumes. */
/** @internal */
export const SRTT_LIVE = 0;

/**
 * `SRT_SOCKGROUPCONFIG`, built as bytes rather than declared to koffi. Its first member after `id` is a
 * `sockaddr_storage`, whose 8-byte alignment comes from an `__ss_align` member; declaring that as a
 * byte array would make it 1-aligned and put every field after it at the wrong offset, and declaring it
 * faithfully means restating a platform struct this code never reads. The offsets instead come straight
 * from the header: id(int32) 0, srcaddr 8, peeraddr 136, weight(uint16) 264, config(ptr) 272,
 * errorcode(int) 280, token(int) 284.
 */
/** @internal */
export const GROUP_CONFIG_SIZE = 288;
const PEERADDR_OFFSET = 136;
const WEIGHT_OFFSET = 264;
const ERRORCODE_OFFSET = 280;
const TOKEN_OFFSET = 284;

/** `SRT_SOCKGROUPDATA`: id 0, peeraddr 8, sockstate 136, weight 140, memberstate 144, result 148, token 152. */
/** @internal */
export const GROUP_DATA_SIZE = 160;
const DATA_MEMBERSTATE_OFFSET = 144;
const DATA_RESULT_OFFSET = 148;

/**
 * What a link in the group is doing: `'running'` for the ones carrying data, `'idle'` for a backup
 * group's standby links, `'pending'` while connecting, and `'broken'` once a link has failed.
 *
 * @group \@mediabunny/srt
 * @public
 */
export type SrtMemberState = 'pending' | 'idle' | 'running' | 'broken';

/** `SRT_MEMBERSTATUS`'s own order, which is what the integer in the struct indexes. */
/** @internal */
export const MEMBER_STATES: readonly SrtMemberState[] = ['pending', 'idle', 'running', 'broken'];

/**
 * `sockaddr_in`, 16 bytes. BSD and macOS spend the first byte on `sin_len` and the second on the
 * family; Linux has no length byte and states the family as a 16-bit value in its place. `AF_INET` is
 * 2 on both, and the port and address are network order on both.
 */
/** @internal */
export const writeSockaddrIn = (into: Uint8Array, offset: number, host: string, port: number): void => {
	const octets = host.split('.').map(part => Number(part));
	if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		throw new TypeError(
			`'${host}' is not an IPv4 address. SRT bonding names each link by address, so a host name has to`
			+ ' be resolved before it is handed over.',
		);
	}

	const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
	if (process.platform === 'linux') {
		view.setUint16(offset, 2, true);
	} else {
		into[offset] = 16;
		into[offset + 1] = 2;
	}
	view.setUint16(offset + 2, port);
	for (let i = 0; i < 4; i++) {
		into[offset + 4 + i] = octets[i]!;
	}
};

/** Fills one `SRT_SOCKGROUPCONFIG` in place, as `srt_prepare_endpoint` would. */
/** @internal */
export const writeGroupConfig = (
	into: Uint8Array,
	index: number,
	host: string,
	port: number,
	weight: number,
): void => {
	const base = index * GROUP_CONFIG_SIZE;
	const view = new DataView(into.buffer, into.byteOffset, into.byteLength);

	writeSockaddrIn(into, base + PEERADDR_OFFSET, host, port);
	view.setUint16(base + WEIGHT_OFFSET, weight, true);
	// `srt_prepare_endpoint` leaves the token at -1, which is what tells libsrt to allocate one
	view.setInt32(base + TOKEN_OFFSET, -1, true);
};

/** Reads back what `srt_connect_group` wrote into one entry. */
/** @internal */
export const readGroupConfigResult = (from: Uint8Array, index: number): { id: number; errorcode: number } => {
	const base = index * GROUP_CONFIG_SIZE;
	const view = new DataView(from.buffer, from.byteOffset, from.byteLength);

	return { id: view.getInt32(base, true), errorcode: view.getInt32(base + ERRORCODE_OFFSET, true) };
};

/** Reads one `SRT_SOCKGROUPDATA` entry. */
/** @internal */
export const readGroupData = (
	from: Uint8Array,
	index: number,
): { id: number; state: SrtMemberState; result: number } => {
	const base = index * GROUP_DATA_SIZE;
	const view = new DataView(from.buffer, from.byteOffset, from.byteLength);
	const member = view.getInt32(base + DATA_MEMBERSTATE_OFFSET, true);

	return {
		id: view.getInt32(base, true),
		state: MEMBER_STATES[member] ?? 'broken',
		result: view.getInt32(base + DATA_RESULT_OFFSET, true),
	};
};

type Fn<A extends unknown[], R> = ((...args: A) => R) & {
	async: (...args: [...A, (error: Error | null, result: R) => void]) => void;
};

/** @internal */
export type Libsrt = {
	path: string;
	createGroup: (type: number) => number;
	connectGroup: (group: number, configs: Uint8Array, count: number) => number;
	close: (socket: number) => number;
	send: (socket: number, data: Uint8Array, length: number) => number;
	setFlagInt: (socket: number, option: number, value: number) => number;
	setFlagString: (socket: number, option: number, value: string) => number;
	groupData: (group: number, out: Uint8Array, inoutLen: number[]) => number;
	lastError: () => string;
};

/**
 * Where to look for libsrt, in order: the `MEDIABUNNY_LIBSRT` override, then the platform's own loader
 * path, then the usual install prefixes.
 */
const candidatePaths = (): string[] => {
	const override = process.env['MEDIABUNNY_LIBSRT'];
	const byPlatform: Record<string, string[]> = {
		darwin: ['libsrt.dylib', '/opt/homebrew/lib/libsrt.dylib', '/usr/local/lib/libsrt.dylib'],
		linux: [
			'libsrt.so.1.5',
			'libsrt.so.1',
			'libsrt.so',
			'/usr/lib/x86_64-linux-gnu/libsrt.so.1.5',
			'/usr/lib/aarch64-linux-gnu/libsrt.so.1.5',
			'/usr/local/lib/libsrt.so.1.5',
		],
		win32: ['srt.dll', 'libsrt.dll'],
	};

	return [...(override ? [override] : []), ...(byPlatform[process.platform] ?? ['libsrt.so'])];
};

let cached: Libsrt | null = null;
let loadError: Error | null = null;

/** @internal */
export const getLibsrt = (): Libsrt => {
	if (cached) {
		return cached;
	}
	if (loadError) {
		throw loadError;
	}

	const tried: string[] = [];
	let lib: ReturnType<typeof koffi.load> | null = null;
	let path = '';

	for (const candidate of candidatePaths()) {
		try {
			lib = koffi.load(candidate);
			path = candidate;
			break;
		} catch (error) {
			tried.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (!lib) {
		loadError = new Error(
			'libsrt could not be loaded. Install it (brew install srt / apt install libsrt1.5-openssl) or'
			+ ` set MEDIABUNNY_LIBSRT to its path. Tried:\n  ${tried.join('\n  ')}`,
		);
		throw loadError;
	}

	const declare = <T>(signature: string): T => lib.func(signature) as T;

	let startup: Fn<[], number>;
	let createGroup: Fn<[number], number>;
	try {
		startup = declare<Fn<[], number>>('int srt_startup()');
		createGroup = declare<Fn<[number], number>>('int srt_create_group(int type)');
	} catch (error) {
		loadError = new Error(
			`libsrt at ${path} exports no socket-group API, so it cannot bond links. Install a build with`
			+ ' bonding enabled, or set MEDIABUNNY_LIBSRT to one.'
			+ ` (${error instanceof Error ? error.message : String(error)})`,
		);
		throw loadError;
	}

	const close = declare<Fn<[number], number>>('int srt_close(int socket)');
	const connectGroup = declare<Fn<[number, Uint8Array, number], number>>(
		'int srt_connect_group(int group, void *configs, int count)',
	);

	const sendmsg2 = declare<Fn<[number, Uint8Array, number, null], number>>(
		'int srt_sendmsg2(int socket, void *data, int length, void *mctrl)',
	);
	const setsockflag = declare<Fn<[number, number, Uint8Array | string, number], number>>(
		'int srt_setsockflag(int socket, int option, void *value, int length)',
	);
	const groupData = declare<Fn<[number, Uint8Array, number[]], number>>(
		'int srt_group_data(int group, void *output, _Inout_ size_t *inoutlen)',
	);
	const lastErrorStr = declare<Fn<[], string>>('const char *srt_getlasterror_str()');

	if (startup() === SRT_ERROR) {
		loadError = new Error(`srt_startup failed: ${lastErrorStr()}`);
		throw loadError;
	}

	// Asked rather than assumed. A build without ENABLE_BONDING still *exports* every group symbol - they
	// compile to stubs returning SRT_INVALID_SOCK - so the symbol being there says nothing. Homebrew's
	// libsrt 1.5.6 is such a build: `srt_create_group` returns -1 for every type and sets no error, which
	// without this check surfaces much later as an unexplained failure with `Success` to read.
	const probe = createGroup(SrtGroupType.BROADCAST);
	if (probe === SRT_ERROR) {
		loadError = new Error(
			`libsrt at ${path} was built without bonding (ENABLE_BONDING): it exports the socket-group API`
			+ ' but every group it is asked for is refused. Install a build with bonding enabled - Debian and'
			+ ' Ubuntu\'s libsrt1.5-openssl has it, Homebrew\'s does not - or set MEDIABUNNY_LIBSRT to one.',
		);
		throw loadError;
	}
	close(probe);

	cached = {
		path,
		createGroup: type => createGroup(type),
		connectGroup: (group, configs, count) => connectGroup(group, configs, count),
		close: socket => close(socket),
		send: (socket, data, length) => sendmsg2(socket, data, length, null),
		setFlagInt: (socket, option, value) => {
			const bytes = new Uint8Array(4);
			new DataView(bytes.buffer).setInt32(0, value, true);
			return setsockflag(socket, option, bytes, 4);
		},
		setFlagString: (socket, option, value) => setsockflag(socket, option, value, value.length),
		groupData: (group, out, inoutLen) => groupData(group, out, inoutLen),
		lastError: () => lastErrorStr(),
	};

	return cached;
};
