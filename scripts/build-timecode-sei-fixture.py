"""Builds an HEVC fixture whose timecode is in a `time_code` SEI rather than a `tmcd` track.

ffmpeg writes a QuickTime timecode track for `-timecode`, never the SEI, so there is no natural fixture
for the bitstream path. This builds the SEI by hand - H.265 D.2.27, bit for bit - and injects it as a
prefix SEI before the first slice, so the reader is held to something this library did not write.

    python3 scripts/build-hevc-timecode-fixture.py test/public/timecode-sei-hevc.mp4 04:05:06:07

Needs ffmpeg on PATH.
"""
import subprocess, sys, tempfile
from pathlib import Path

PREFIX_SEI_NUT = 39
TIME_CODE_SEI = 136


class Bits:
    def __init__(self):
        self.bits = []

    def add(self, value, count):
        for i in range(count - 1, -1, -1):
            self.bits.append((value >> i) & 1)
        return self

    def bytes(self):
        # rbsp_trailing_bits: a 1 then zeros to the byte boundary
        bits = self.bits + [1]
        while len(bits) % 8:
            bits.append(0)
        return bytes(
            sum(bit << (7 - i) for i, bit in enumerate(bits[at:at + 8]))
            for at in range(0, len(bits), 8)
        )


def time_code_payload(hours, minutes, seconds, frames):
    b = Bits()
    b.add(1, 2)        # num_clock_ts
    b.add(1, 1)        # clock_timestamp_flag
    b.add(0, 1)        # units_field_based_flag
    b.add(0, 5)        # counting_type
    b.add(1, 1)        # full_timestamp_flag
    b.add(0, 1)        # discontinuity_flag
    b.add(0, 1)        # cnt_dropped_flag
    b.add(frames, 9)
    b.add(seconds, 6)
    b.add(minutes, 6)
    b.add(hours, 5)
    b.add(0, 5)        # time_offset_length
    return b.bytes()


def emulation_prevented(payload):
    out = bytearray()
    zeros = 0
    for byte in payload:
        if zeros >= 2 and byte <= 3:
            out.append(3)
            zeros = 0
        out.append(byte)
        zeros = zeros + 1 if byte == 0 else 0
    return bytes(out)


def sei_nal(hours, minutes, seconds, frames):
    payload = time_code_payload(hours, minutes, seconds, frames)
    body = bytearray([TIME_CODE_SEI, len(payload)])
    body += payload
    header = bytes([(PREFIX_SEI_NUT << 1), 1])  # nuh_layer_id 0, temporal_id_plus1 1
    return b'\x00\x00\x00\x01' + header + emulation_prevented(bytes(body))


def inject(annexb, nal):
    """The SEI before the first VCL NAL unit, which is where a prefix SEI belongs."""
    at = 0
    while True:
        start = annexb.find(b'\x00\x00\x01', at)
        if start < 0:
            raise SystemExit('no NAL units found')
        payload_at = start + 3
        nal_type = (annexb[payload_at] >> 1) & 0x3f
        if nal_type < 32:  # VCL
            prefix_at = start - 1 if start > 0 and annexb[start - 1] == 0 else start
            return annexb[:prefix_at] + nal + annexb[prefix_at:]
        at = payload_at


def main(destination, timecode):
    hours, minutes, seconds, frames = (int(part) for part in timecode.replace(';', ':').split(':'))

    with tempfile.TemporaryDirectory() as directory:
        raw = Path(directory) / 'in.hevc'
        out = Path(directory) / 'out.hevc'
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
             '-t', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-f', 'hevc', str(raw)],
            check=True, capture_output=True)
        out.write_bytes(inject(raw.read_bytes(), sei_nal(hours, minutes, seconds, frames)))
        # -c copy keeps the SEI; no -timecode, so no tmcd track is written
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(out), '-c', 'copy', str(destination)],
                       check=True, capture_output=True)

    print(f'{destination}: time_code SEI {timecode}')


if __name__ == '__main__':
    main(Path(sys.argv[1]), sys.argv[2])
