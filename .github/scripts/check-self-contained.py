#!/usr/bin/env python3
"""Refuses a prebuilt library that still needs mbedTLS at run time.

@mediabunny/server ships libsrt for four platforms so that a host needs nothing installed. A build
that links mbedTLS dynamically breaks that silently: the library fails to load, getLibsrt falls
through to whatever libsrt the system has, and that one usually has no bonding - so bonding fails
while the package is shipping a working bonding build it could not open. That reached npm twice.

Each format states its dynamic dependencies differently, so each is read on its own terms rather than
by shelling out to a tool that only exists on one of the three runners.
"""
import struct
import sys


def elf_needed(data: bytes) -> list[str]:
    """DT_NEEDED entries from an ELF64 .dynamic section."""
    endian = '<' if data[5] == 1 else '>'
    (section_offset,) = struct.unpack_from(endian + 'Q', data, 0x28)
    entry_size, count, _ = struct.unpack_from(endian + 'HHH', data, 0x3a)

    def section(index: int) -> dict:
        at = section_offset + index * entry_size
        name, kind, _flags, _addr, offset, size, link, _info, _align, _es = struct.unpack_from(
            endian + 'IIQQQQIIQQ', data, at)
        return {'kind': kind, 'offset': offset, 'size': size, 'link': link}

    dynamic = next((section(i) for i in range(count) if section(i)['kind'] == 6), None)
    if dynamic is None:
        return []

    strings = section(dynamic['link'])
    needed = []
    for i in range(dynamic['size'] // 16):
        tag, value = struct.unpack_from(endian + 'Qq', data, dynamic['offset'] + i * 16)
        if tag == 0:
            break
        if tag == 1:  # DT_NEEDED
            start = strings['offset'] + value
            needed.append(data[start:data.index(b'\0', start)].decode('utf-8', 'replace'))
    return needed


def macho_dylibs(data: bytes) -> list[str]:
    """LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB paths from a thin 64-bit Mach-O."""
    magic, = struct.unpack_from('<I', data, 0)
    if magic not in (0xfeedfacf, 0xcffaedfe):
        raise ValueError(f'not a thin 64-bit Mach-O (magic {magic:#x}); a fat binary is not expected here')

    ncmds, = struct.unpack_from('<I', data, 16)
    at = 32
    paths = []
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from('<II', data, at)
        if cmd in (0x0c, 0x18):  # LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB
            offset, = struct.unpack_from('<I', data, at + 8)
            start = at + offset
            end = data.index(b'\0', start)
            paths.append(data[start:end].decode('utf-8', 'replace'))
        at += cmdsize
    return paths


def pe_imports(data: bytes) -> list[str]:
    """Any DLL name the file mentions. Crude on purpose: it only has to catch mbedTLS."""
    names = []
    for match in data.split(b'.dll')[:-1]:
        tail = match[-64:]
        start = max((tail.rfind(bytes([b])) for b in range(0, 32)), default=-1)
        names.append((tail[start + 1:] + b'.dll').decode('utf-8', 'replace'))
    return names


def dependencies(path: str, data: bytes) -> list[str]:
    if data[:4] == b'\x7fELF':
        return elf_needed(data)
    if data[:2] == b'MZ':
        return pe_imports(data)
    return macho_dylibs(data)


def main(paths: list[str]) -> int:
    failed = False
    for path in paths:
        with open(path, 'rb') as handle:
            data = handle.read()

        deps = dependencies(path, data)
        offenders = [dep for dep in deps if 'mbed' in dep.lower()]

        print(f'{path}:')
        for dep in deps:
            print(f'    {dep}')
        if offenders:
            failed = True
            print(f'::error::{path} needs {", ".join(offenders)} at run time; mbedTLS must be linked'
                  ' statically or the library cannot load on a host without it', file=sys.stderr)

    if not failed:
        print('\nevery prebuilt is self-contained')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
