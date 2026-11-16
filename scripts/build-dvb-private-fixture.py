"""Builds a TS carrying teletext (page 888) and a DVB subtitle stream, per ETSI EN 300 468."""
import struct, sys

def crc32_mpeg(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc

CC = {}
def next_cc(pid):
    c = CC.get(pid, 0)
    CC[pid] = (c + 1) & 0xF
    return c

def psi_packet(pid, sect):
    """A PSI packet: pointer_field, the section, then 0xFF stuffing."""
    payload = bytes([0x00]) + sect
    assert len(payload) <= 184
    payload = payload + bytes([0xFF] * (184 - len(payload)))
    return bytes([0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x10 | next_cc(pid)]) + payload

def pes_packets(pid, payload, pcr=None):
    """A PES packet across as many TS packets as it needs, the first carrying any PCR."""
    out = b""
    first = True
    while payload:
        room = 184
        af = bytearray()
        if first and pcr is not None:
            af = bytearray([0x10, (pcr >> 25) & 0xFF, (pcr >> 17) & 0xFF, (pcr >> 9) & 0xFF,
                            (pcr >> 1) & 0xFF, ((pcr & 1) << 7) | 0x7E])
            room -= len(af) + 1
        chunk, payload = payload[:room], payload[room:]
        pad = room - len(chunk)
        if pad > 0:
            if not af:
                af = bytearray([0x00]) if pad >= 2 else bytearray()
                pad -= 2 if pad >= 2 else 0
            af += bytearray([0xFF] * max(0, pad))
        field = (bytes([len(af)]) + bytes(af)) if af else b""
        flags = (0x30 if field else 0x10) | next_cc(pid)
        head = bytes([0x47, (0x40 if first else 0x00) | (pid >> 8), pid & 0xFF, flags])
        packet = head + field + chunk
        assert len(packet) == 188, (len(packet), len(field), len(chunk))
        out += packet
        first = False
    return out

def pes_packet(pid, payload, pcr=None):
    """A PES packet in one TS packet, padded with an adaptation field when it is short."""
    assert len(payload) <= 184
    af = bytearray()
    if pcr is not None:
        af = bytearray([0x10, (pcr >> 25) & 0xFF, (pcr >> 17) & 0xFF, (pcr >> 9) & 0xFF,
                        (pcr >> 1) & 0xFF, ((pcr & 1) << 7) | 0x7E])
    room = 184 - len(payload)
    if room > 0 or af:
        need = room - (len(af) + 1 if af else 0)
        if not af:
            af = bytearray([0x00])
            need = room - 2
        af += bytearray([0xFF] * max(0, need))
        field = bytes([len(af)]) + bytes(af)
        head = bytes([0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x30 | next_cc(pid)])
        out = head + field + payload
        assert len(out) == 188, len(out)
        return out
    return bytes([0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x10 | next_cc(pid)]) + payload

def section(table_id, ident, body, version=0):
    length = len(body) + 5 + 4
    head = bytes([table_id, 0xB0 | ((length >> 8) & 0x0F), length & 0xFF,
                  (ident >> 8) & 0xFF, ident & 0xFF, 0xC1 | (version << 1), 0x00, 0x00])
    full = head + body
    return full + struct.pack(">I", crc32_mpeg(full))

PMT_PID, TTX_PID, SUB_PID = 0x1000, 0x0200, 0x0201

pat = section(0x00, 1, struct.pack(">HH", 1, 0xE000 | PMT_PID))

# EN 300 468 6.2.43: 'eng', teletext_type 0x02 (subtitle page), magazine 0 (= 8), page 0x88 -> 888
ttx_desc = bytes([0x56, 10]) + b"eng" + bytes([(0x02 << 3) | 0x00, 0x88]) \
    + b"deu" + bytes([(0x01 << 3) | 0x01, 0x50])
# EN 300 468 6.2.41: 'eng', subtitling_type 0x10, composition_page_id 1, ancillary_page_id 1
sub_desc = bytes([0x59, 16]) + b"eng" + bytes([0x10]) + struct.pack(">HH", 1, 1) \
    + b"deu" + bytes([0x20]) + struct.pack(">HH", 3, 4)

pmt_body = struct.pack(">H", 0xE000 | TTX_PID) + struct.pack(">H", 0xF000)
for pid, desc in ((TTX_PID, ttx_desc), (SUB_PID, sub_desc)):
    pmt_body += bytes([0x06]) + struct.pack(">H", 0xE000 | pid)
    pmt_body += struct.pack(">H", 0xF000 | len(desc)) + desc
pmt = section(0x02, 1, pmt_body)

def pes(stream_id, payload, pts):
    pts_bytes = bytes([0x20 | (((pts >> 30) & 0x7) << 1) | 1,
                       (pts >> 22) & 0xFF, (((pts >> 15) & 0x7F) << 1) | 1,
                       (pts >> 7) & 0xFF, ((pts & 0x7F) << 1) | 1])
    body = bytes([0x80, 0x80, 5]) + pts_bytes + payload
    return bytes([0x00, 0x00, 0x01, stream_id]) + struct.pack(">H", len(body)) + body

# EN 300 472: data_identifier 0x10, then 46-byte data units; 0x03 is EBU subtitle data
ttx_payload = bytes([0x10]) + (bytes([0x03, 0x2C, 0xE4]) + bytes([0x00] * 43)) * 4
# EN 300 743: data_identifier 0x20, subtitle_stream_id 0x00, segments, 0xFF end marker
sub_payload = bytes([0x20, 0x00, 0x0F, 0x10]) + struct.pack(">HH", 1, 2) + bytes([0x00, 0x00, 0xFF])

out = bytearray()
for i in range(6):
    out += psi_packet(0x0000, pat)
    out += psi_packet(PMT_PID, pmt)
    pts = 90000 + i * 3600
    out += pes_packets(TTX_PID, pes(0xBD, ttx_payload, pts), pcr=pts * 300)
    out += pes_packet(SUB_PID, pes(0xBD, sub_payload, pts))

open(sys.argv[1], "wb").write(bytes(out))
print("wrote", len(out) // 188, "packets")
