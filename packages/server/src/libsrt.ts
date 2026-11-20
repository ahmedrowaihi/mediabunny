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

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
	/** Read-only: `SRT_SOCKSTATUS`, which is how a non-blocking connect is watched. */
	STATE: 17,
	/** Read-only: bytes still held in the sender's buffer, which a close would discard. */
	SNDDATA: 19,
	PASSPHRASE: 26,
	PBKEYLEN: 27,
	RCVLATENCY: 43,
	PEERLATENCY: 44,
	STREAMID: 46,
	PAYLOADSIZE: 49,
	TRANSTYPE: 50,
	// Counted from TRANSTYPE, which the header pins at 50, and checked against PACKETFILTER at 60
	GROUPCONNECT: 57,
} as const;
/** @internal */
export type SrtOption = (typeof SrtOption)[keyof typeof SrtOption];

/** @internal */
export const SRT_ERROR = -1;
/** `SRTT_LIVE`, the transmission type every option default below assumes. */
/** @internal */
export const SRTT_LIVE = 0;
/** `SRTT_FILE`, which a caller selects with `?transtype=file` for byte-exact delivery. */
/** @internal */
export const SRTT_FILE = 1;
/** `SRTS_CONNECTED` from `SRT_SOCKSTATUS`, whose enum starts at `SRTS_INIT = 1`. */
/** @internal */
export const SRTS_CONNECTED = 5;
/** `SRTS_BROKEN`, the state a refused or dropped connect lands in. */
/** @internal */
export const SRTS_BROKEN = 6;

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
const SRCADDR_OFFSET = 8;
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
 * @group \@mediabunny/server
 * @public
 */
export type SrtMemberState = 'pending' | 'idle' | 'running' | 'broken';

/** `SRT_MEMBERSTATUS`'s own order, which is what the integer in the struct indexes. */
/** @internal */
export const MEMBER_STATES: readonly SrtMemberState[] = ['pending', 'idle', 'running', 'broken'];

// Only the BSDs put a length byte in front of the family; Linux and Windows state it as a uint16 in
// its place. AF_INET is 2 everywhere, and the port and address are network order everywhere.
const HAS_SOCKADDR_LEN = ['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform);

/** `sockaddr_in`, 16 bytes. */
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
	if (HAS_SOCKADDR_LEN) {
		into[offset] = 16;
		into[offset + 1] = 2;
	} else {
		view.setUint16(offset, 2, true);
	}
	view.setUint16(offset + 2, port);
	for (let i = 0; i < 4; i++) {
		into[offset + 4 + i] = octets[i]!;
	}
};

/** RFC 5952 form, via the URL parser's own serializer rather than a hand-written zero-run compressor. */
const formatIpv6 = (bytes: Uint8Array): string => {
	const groups: string[] = [];
	for (let i = 0; i < 16; i += 2) {
		groups.push((((bytes[i]! << 8) | bytes[i + 1]!) >>> 0).toString(16));
	}
	return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
};

/**
 * Reads back a `sockaddr` libsrt filled in, using the length it reported rather than the address
 * family. `AF_INET6` is 30 on macOS, 10 on Linux, 23 on Windows and different again on the other BSDs,
 * so keying on it would need a table this cannot verify per platform; the length cannot be 16 and 28 at
 * once. `sockaddr_in` is 16 bytes and `sockaddr_in6` is 28 on every platform here, and the port sits at
 * offset 2 in network order in both.
 *
 * @internal
 */
export const readSockaddr = (
	from: Uint8Array,
	offset: number,
	length: number,
): { address: string; port: number; family: 'ipv4' | 'ipv6' } | null => {
	const view = new DataView(from.buffer, from.byteOffset, from.byteLength);
	const port = view.getUint16(offset + 2);

	if (length === 16) {
		return { address: Array.from(from.subarray(offset + 4, offset + 8)).join('.'), port, family: 'ipv4' };
	}
	if (length === 28) {
		// sin6_addr sits past the 4-byte flowinfo that follows the port
		return { address: formatIpv6(from.subarray(offset + 8, offset + 24)), port, family: 'ipv6' };
	}

	return null;
};

// Family only, no length byte: this is what srt_prepare_endpoint writes for an unbound source.
const writeSockaddrFamily = (into: Uint8Array, offset: number): void => {
	if (HAS_SOCKADDR_LEN) {
		into[offset + 1] = 2;
	} else {
		new DataView(into.buffer, into.byteOffset, into.byteLength).setUint16(offset, 2, true);
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
	// libsrt refuses a member whose source family differs from its target's; zeroed states family 0
	writeSockaddrFamily(into, base + SRCADDR_OFFSET);
	view.setUint16(base + WEIGHT_OFFSET, weight, true);
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
	/** Why this build cannot carry a bonded group, or `null` where it can. */
	bondingError: Error | null;
	createGroup: (type: number) => number;
	connectGroup: (group: number, configs: Uint8Array, count: number) => number;
	close: (socket: number) => number;
	send: (socket: number, data: Uint8Array, length: number) => number;
	setFlagInt: (socket: number, option: number, value: number) => number;
	setFlagString: (socket: number, option: number, value: string) => number;
	groupData: (group: number, out: Uint8Array, inoutLen: number[]) => number;
	createSocket: () => number;
	bind: (socket: number, address: Uint8Array, length: number) => number;
	listen: (socket: number, backlog: number) => number;
	connect: (socket: number, address: Uint8Array, length: number) => number;
	/** The accepted socket, and the caller's address. */
	accept: (socket: number) => {
		socket: number;
		peer: { address: string; port: number; family: 'ipv4' | 'ipv6' } | null;
	};
	getFlagInt: (socket: number, option: number) => number | null;
	getFlagString: (socket: number, option: number) => string | null;
	receive: (socket: number, into: Uint8Array, length: number) => number;
	lastError: () => string;
	lastErrorCode: () => number;
};

/** `.dylib`/`.so`/`.dll`, and the directory name the prebuilt for this host is shipped under. */
const PREBUILT_KEY = `${process.platform}-${process.arch}`;
const LIBRARY_SUFFIX = process.platform === 'darwin' ? '.dylib' : process.platform === 'win32' ? '.dll' : '.so';

/**
 * This module's own directory. The ESM bundle has no `__dirname` of its own, so `scripts/bundle.ts`
 * prepends one for the srt bundles only; `import.meta.url` cannot be used instead, because esbuild
 * compiles it to an empty object in the CJS output and tsc refuses it in a CJS-targeted source file.
 */
const moduleDirectory = (): string | null => (typeof __dirname === 'string' ? __dirname : null);

/**
 * The libsrt shipped inside this package for the running host, if one is. Found by walking up from this
 * module rather than by a fixed depth: the bundles sit at `dist/bundles/` and the module build at
 * `dist/modules/src/`, so no single relative path reaches the package root from both.
 */
const bundledLibrary = (): string | null => {
	let at = moduleDirectory();
	for (let up = 0; at !== null && up < 5; up++) {
		const candidate = join(at, 'prebuilt', PREBUILT_KEY, `libsrt${LIBRARY_SUFFIX}`);
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(at);
		at = parent === at ? null : parent;
	}
	return null;
};

/**
 * Where to look for libsrt, in order: the `MEDIABUNNY_LIBSRT` override, the build shipped in this
 * package, then the platform's own loader path and the usual install prefixes.
 *
 * The shipped build comes before the system one on purpose. A system libsrt is usually Homebrew's or a
 * distro's, and Homebrew's carries no bonding — preferring it would make the feature this package exists
 * for depend on which libsrt a host happens to have.
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

	const bundled = bundledLibrary();
	return [
		...(override ? [override] : []),
		...(bundled ? [bundled] : []),
		...(byPlatform[process.platform] ?? ['libsrt.so']),
	];
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
	const lastErrorNo = declare<Fn<[null], number>>('int srt_getlasterror(void *errno_loc)');
	const createSocket = declare<Fn<[], number>>('int srt_create_socket()');
	const bind = declare<Fn<[number, Uint8Array, number], number>>(
		'int srt_bind(int socket, void *name, int namelen)',
	);
	const listen = declare<Fn<[number, number], number>>('int srt_listen(int socket, int backlog)');
	const connect = declare<Fn<[number, Uint8Array, number], number>>(
		'int srt_connect(int socket, void *name, int namelen)',
	);
	const accept = declare<Fn<[number, Uint8Array, number[]], number>>(
		'int srt_accept(int socket, _Inout_ void *addr, _Inout_ int *addrlen)',
	);
	const getsockflag = declare<Fn<[number, number, Uint8Array, number[]], number>>(
		'int srt_getsockflag(int socket, int opt, _Out_ void *optval, _Inout_ int *optlen)',
	);
	const recvmsg2 = declare<Fn<[number, Uint8Array, number, null], number>>(
		'int srt_recvmsg2(int socket, void *buf, int len, void *mctrl)',
	);

	const cleanup = declare<Fn<[], number>>('int srt_cleanup()');

	if (startup() === SRT_ERROR) {
		loadError = new Error(`srt_startup failed: ${lastErrorStr()}`);
		throw loadError;
	}

	// srt_startup spawns libsrt's own GC and epoll threads. Without srt_cleanup they are still running
	// while the process tears down, which segfaults it (exit 139) after the last socket closes - measured
	// on 1.66.0-beta.739, where the crash followed a clean run with the bytes already delivered.
	process.once('exit', () => {
		cleanup();
	});

	// Bonding is probed but not required: a build without the group API still carries plain sockets,
	// which is every target but the bonded one. The refusal is raised by `SrtBondedTarget`, where it is
	// the feature actually missing, rather than failing every SRT caller on the same machine.
	let bondingError: Error | null = null;
	const probe = createGroup(SrtGroupType.BROADCAST);
	if (probe === SRT_ERROR) {
		bondingError = new Error(
			`libsrt at ${path} was built without bonding (ENABLE_BONDING): it exports the socket-group API`
			+ ' but every group it is asked for is refused. Install a build with bonding enabled - Debian and'
			+ ' Ubuntu\'s libsrt1.5-openssl has it, Homebrew\'s does not - or set MEDIABUNNY_LIBSRT to one.',
		);
	} else {
		close(probe);
	}

	cached = {
		path,
		bondingError,
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
		createSocket: () => createSocket(),
		bind: (socket, address, length) => bind(socket, address, length),
		listen: (socket, backlog) => listen(socket, backlog),
		connect: (socket, address, length) => connect(socket, address, length),
		accept: (socket) => {
			// Sized for sockaddr_in6, so an IPv6 caller does not overrun the buffer on its way to being
			// reported as unknown
			const address = new Uint8Array(28);
			const length = [address.byteLength];
			const accepted = accept(socket, address, length);
			return {
				socket: accepted,
				peer: accepted === SRT_ERROR ? null : readSockaddr(address, 0, length[0]!),
			};
		},
		getFlagInt: (socket, option) => {
			const value = new Uint8Array(4);
			const length = [value.byteLength];
			if (getsockflag(socket, option, value, length) === SRT_ERROR) {
				return null;
			}

			return new DataView(value.buffer).getInt32(0, true);
		},
		getFlagString: (socket, option) => {
			const value = new Uint8Array(512);
			const length = [value.byteLength];
			if (getsockflag(socket, option, value, length) === SRT_ERROR) {
				return null;
			}
			return new TextDecoder().decode(value.subarray(0, Math.max(0, length[0]!)));
		},
		receive: (socket, into, length) => recvmsg2(socket, into, length, null),
		lastError: () => lastErrorStr(),
		lastErrorCode: () => lastErrorNo(null),
	};

	return cached;
};
