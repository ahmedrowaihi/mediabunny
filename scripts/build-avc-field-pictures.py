"""Builds an Annex-B H.264 stream of field pictures (PAFF), which x264 cannot emit.

The SPS and PPS are lifted from avc-fake-interlaced.mp4, which already states frame_mbs_only_flag = 0
and so permits field pictures; only the slice headers are written here, bit by bit, per H.264 7.3.3.
"""
import struct, subprocess, sys

mp4 = sys.argv[1]
out_path = sys.argv[2]

raw = open(mp4, "rb").read()
i = raw.find(b"avcC")
assert i > 0
avcc = raw[i + 4:]
num_sps = avcc[5] & 0x1f
at = 6
sps_list, pps_list = [], []
for _ in range(num_sps):
    n = struct.unpack(">H", avcc[at:at + 2])[0]; at += 2
    sps_list.append(avcc[at:at + n]); at += n
num_pps = avcc[at]; at += 1
for _ in range(num_pps):
    n = struct.unpack(">H", avcc[at:at + 2])[0]; at += 2
    pps_list.append(avcc[at:at + n]); at += n
print("sps", len(sps_list[0]), "pps", len(pps_list[0]))

class BitWriter:
    def __init__(self): self.bits = []
    def u(self, n, v):
        for k in range(n - 1, -1, -1): self.bits.append((v >> k) & 1)
    def ue(self, v):
        v += 1
        n = v.bit_length()
        self.bits.extend([0] * (n - 1))
        self.u(n, v)
    def se(self, v):
        self.ue(2 * v - 1 if v > 0 else -2 * v)
    def rbsp(self):
        self.bits.append(1)                      # rbsp_stop_one_bit
        while len(self.bits) % 8: self.bits.append(0)
        return bytes(int("".join(map(str, self.bits[i:i + 8])), 2) for i in range(0, len(self.bits), 8))

def field_slice(frame_num, bottom, qp_delta):
    """An IDR field picture. log2_max_frame_num_minus4 = 0 and pic_order_cnt_type = 2 in this SPS."""
    w = BitWriter()
    w.ue(0)              # first_mb_in_slice
    w.ue(7)              # slice_type 7 = I, all slices I
    w.ue(0)              # pic_parameter_set_id
    w.u(4, frame_num)    # frame_num, u(log2_max_frame_num_minus4 + 4)
    w.u(1, 1)            # field_pic_flag
    w.u(1, bottom)       # bottom_field_flag
    w.ue(0)              # idr_pic_id
    # pic_order_cnt_type 2: no pic_order_cnt_lsb, and no delta_pic_order_cnt
    w.u(1, 0)            # no_output_of_prior_pics_flag
    w.u(1, 0)            # long_term_reference_flag
    w.se(qp_delta)       # slice_qp_delta
    w.ue(0)              # disable_deblocking_filter_idc
    w.se(0)              # slice_alpha_c0_offset_div2
    w.se(0)              # slice_beta_offset_div2
    body = w.rbsp()
    return bytes([0x65]) + body            # nal_ref_idc 3, nal_unit_type 5 (IDR)

START = bytes([0, 0, 0, 1])
stream = bytearray()
stream += START + sps_list[0] + START + pps_list[0]
slices = [(0, 0, 0), (0, 1, 2), (1, 0, -4), (1, 1, 7)]
for frame_num, bottom, qp in slices:
    stream += START + field_slice(frame_num, bottom, qp)
open(out_path, "wb").write(bytes(stream))
print("wrote", len(stream), "bytes,", len(slices), "field slices")
