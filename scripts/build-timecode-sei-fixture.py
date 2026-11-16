"""Builds a fixture whose timecode is in an SEI rather than a `tmcd` track.

ffmpeg writes a QuickTime timecode track for `-timecode`, never the SEI, so there is no natural fixture
for the bitstream path. x264 does emit `pic_timing`, but with `clock_timestamp_flag` 0 - the payload is
one byte and carries no timecode. So both SEIs are laid out here by hand, bit for bit, and injected
before the first slice, which is where a prefix SEI belongs. The reader is then held to something this
library did not write.

    python3 scripts/build-timecode-sei-fixture.py hevc test/public/timecode-sei-hevc.mp4 04:05:06:07
    python3 scripts/build-timecode-sei-fixture.py avc  test/public/timecode-sei-avc.mp4  04:05:06:07

Needs ffmpeg on PATH.
"""
import subprocess, sys, tempfile
from pathlib import Path

PREFIX_SEI_NUT = 39      # HEVC
SEI_NAL_TYPE = 6         # AVC
TIME_CODE_SEI = 136      # HEVC D.2.27
PIC_TIMING_SEI = 1       # AVC D.2.2


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


def hevc_payload(hours, minutes, seconds, frames):
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


def avc_payload(hours, minutes, seconds, frames):
    """H.264 D.2.2 with no HRD in the VUI, where time_offset_length is inferred as 24."""
    b = Bits()
    b.add(0, 4)        # pic_struct: one clock timestamp
    b.add(1, 1)        # clock_timestamp_flag
    b.add(0, 2)        # ct_type
    b.add(0, 1)        # nuit_field_based_flag
    b.add(0, 5)        # counting_type
    b.add(1, 1)        # full_timestamp_flag
    b.add(0, 1)        # discontinuity_flag
    b.add(0, 1)        # cnt_dropped_flag
    b.add(frames, 8)
    b.add(seconds, 6)
    b.add(minutes, 6)
    b.add(hours, 5)
    b.add(0, 24)       # time_offset
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


def sei_nal(codec, hours, minutes, seconds, frames):
    if codec == 'hevc':
        payload = hevc_payload(hours, minutes, seconds, frames)
        body = bytearray([TIME_CODE_SEI, len(payload)])
        header = bytes([(PREFIX_SEI_NUT << 1), 1])  # nuh_layer_id 0, temporal_id_plus1 1
    else:
        payload = avc_payload(hours, minutes, seconds, frames)
        body = bytearray([PIC_TIMING_SEI, len(payload)])
        header = bytes([SEI_NAL_TYPE])  # nal_ref_idc 0
    body += payload
    return b'\x00\x00\x00\x01' + header + emulation_prevented(bytes(body))


def inject(codec, annexb, nal):
    """The SEI before the first VCL NAL unit, which is where a prefix SEI belongs."""
    at = 0
    while True:
        start = annexb.find(b'\x00\x00\x01', at)
        if start < 0:
            raise SystemExit('no NAL units found')
        payload_at = start + 3
        byte = annexb[payload_at]
        is_vcl = (byte & 0x1f) in (1, 5) if codec == 'avc' else ((byte >> 1) & 0x3f) < 32
        if is_vcl:
            prefix_at = start - 1 if start > 0 and annexb[start - 1] == 0 else start
            return annexb[:prefix_at] + nal + annexb[prefix_at:]
        at = payload_at


def main(codec, destination, timecode):
    hours, minutes, seconds, frames = (int(part) for part in timecode.replace(';', ':').split(':'))

    # x264 needs pic-struct, because `pic_timing` is only parsable when the VUI says it is present
    encode = {
        'hevc': ['-c:v', 'libx265', '-x265-params', 'log-level=none', '-f', 'hevc'],
        'avc': ['-c:v', 'libx264', '-x264-params', 'pic-struct=1', '-f', 'h264'],
    }[codec]

    with tempfile.TemporaryDirectory() as directory:
        raw = Path(directory) / f'in.{codec}'
        out = Path(directory) / f'out.{codec}'
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
             '-t', '1', *encode, str(raw)],
            check=True, capture_output=True)
        out.write_bytes(inject(codec, raw.read_bytes(), sei_nal(codec, hours, minutes, seconds, frames)))
        # -c copy keeps the SEI; no -timecode, so no tmcd track is written
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(out), '-c', 'copy', str(destination)],
                       check=True, capture_output=True)

    print(f'{destination}: {codec} timecode SEI {timecode}')


if __name__ == '__main__':
    main(sys.argv[1], Path(sys.argv[2]), sys.argv[3])
