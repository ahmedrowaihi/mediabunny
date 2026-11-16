"""Builds an AV1 fixture carrying HDR10+ (SMPTE ST 2094-40) in ITU-T T.35 metadata OBUs.

ffmpeg's AV1 encoders do not carry HDR10+ through: the metadata lives in frame side data that the
binding cannot reach. So the payloads are lifted from the HEVC fixture's SEI, parsed here rather than
by mediabunny, and injected as metadata OBUs - what the reader is held to is not what the writer wrote.

    python3 scripts/build-av1-hdr10plus-fixture.py test/public/hdr10-plus.mp4 test/public/hdr10-plus-av1.mp4

Needs ffmpeg on PATH. The intermediate AV1 is encoded **all-intra**: SVT-AV1 otherwise emits hidden
alt-ref frames that are re-displayed by a bare OBU_FRAME_HEADER (show_existing_frame), metadata does not
follow a re-display, and the count of frames carrying it then differs between ffprobe versions.
"""
import subprocess, sys, tempfile
from pathlib import Path

OBU_METADATA, OBU_FRAME = 5, 6
METADATA_TYPE_ITUT_T35 = 4
OBU_TRAILING_BYTE = 0x80
HDR10_PLUS_HEADER = bytes([0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04])
T35_SEI = 4


def leb128(value):
    out = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def read_leb128(data, at):
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7f) << shift
        shift += 7
        if not byte & 0x80:
            return value, at


def hevc_hdr10plus_payloads(source):
    """Every HDR10+ T.35 payload in an HEVC file's prefix SEIs, in decode order."""
    annexb = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', str(source), '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb',
         '-f', 'hevc', '-'],
        check=True, capture_output=True).stdout

    payloads = []
    at = 0
    while True:
        start = annexb.find(b'\x00\x00\x01', at)
        if start < 0:
            return payloads
        at = start + 3
        end = annexb.find(b'\x00\x00\x01', at)
        nal = annexb[at:end if end >= 0 else len(annexb)]
        if len(nal) < 3 or ((nal[0] >> 1) & 0x3f) != 39:  # PREFIX_SEI_NUT
            continue

        body = nal[2:].replace(b'\x00\x00\x03', b'\x00\x00')  # strip emulation prevention
        pos = 0
        while pos < len(body):
            payload_type = 0
            while body[pos] == 0xff:
                payload_type += 255
                pos += 1
            payload_type += body[pos]
            pos += 1
            size = 0
            while body[pos] == 0xff:
                size += 255
                pos += 1
            size += body[pos]
            pos += 1
            if payload_type == T35_SEI and body[pos:pos + 6] == HDR10_PLUS_HEADER:
                payloads.append(body[pos:pos + size])
            pos += size
            if pos >= len(body) or body[pos] == 0x80:
                break


def inject(stream, payloads):
    """A metadata OBU before every OBU_FRAME, cycling through the payloads."""
    out = bytearray()
    at = frames = 0
    while at < len(stream):
        start = at
        header = stream[at]
        at += 1
        if header & 0x04:
            at += 1
        assert header & 0x02, 'expected obu_has_size_field'
        size, at = read_leb128(stream, at)
        end = at + size
        if (header >> 3) & 0x0f == OBU_FRAME:
            body = leb128(METADATA_TYPE_ITUT_T35) + payloads[frames % len(payloads)] + bytes([OBU_TRAILING_BYTE])
            out += bytes([(OBU_METADATA << 3) | 0x02]) + leb128(len(body)) + body
            frames += 1
        out += stream[start:end]
        at = end
    return bytes(out), frames


def main(source, destination):
    payloads = hevc_hdr10plus_payloads(source)
    assert payloads, f'no HDR10+ payloads found in {source}'

    with tempfile.TemporaryDirectory() as directory:
        raw = Path(directory) / 'av1.obu'
        injected = Path(directory) / 'av1-t35.obu'
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-c:v', 'libsvtav1', '-preset', '12',
             '-g', '1', '-frames:v', '8', '-f', 'obu', str(raw)], check=True, capture_output=True)
        stream, frames = inject(raw.read_bytes(), payloads)
        injected.write_bytes(stream)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(injected), '-c', 'copy', str(destination)],
                       check=True, capture_output=True)

    print(f'{destination}: {frames} metadata OBUs from {len(payloads)} distinct payloads')


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
