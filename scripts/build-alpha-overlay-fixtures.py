#!/usr/bin/env python3
"""Build the alpha overlay fixtures: QuickTime Animation and PNG in a .mov.

Both are what a motion-graphics overlay is delivered in - MediaConvert's motion image inserter
takes a .mov - and both carry their alpha inside the one bitstream rather than in a second stream,
so a decoder that drops it reads the first pixel as opaque.

Half-transparent red on nothing, so the ground truth of every pixel is (255, 0, 0, 128): a dropped
alpha channel reads 255 there and a decoder that invents one does not land on red.
"""

import subprocess
import sys
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "test" / "public"
SOURCE = "color=c=red@0.5:s=64x32:d=0.4,format=rgba"

for codec, name in (("qtrle", "qtrle-alpha.mov"), ("png", "png-alpha.mov")):
    out = PUBLIC / name
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", SOURCE, "-c:v", codec, str(out)],
        check=True,
    )
    print(f"{name}: {out.stat().st_size} bytes", file=sys.stderr)
