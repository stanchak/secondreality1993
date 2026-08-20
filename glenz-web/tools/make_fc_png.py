#!/usr/bin/env python3
"""Parse GLENZ/FC.UH -> assets/fc.bin, extract palette+image, write tools/fc.png, report histogram."""
import struct
import zlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repository root
SRC = str(ROOT / "glenz-web/assets/fc.bin")
OUT_PNG = str(ROOT / "glenz-web/tools/fc.png")

def write_png(path, width, height, rgb_rows):
    """rgb_rows: list of bytes objects, each width*3 bytes (RGB), length height."""
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit depth, color type 2 = RGB
    raw = bytearray()
    for row in rgb_rows:
        raw.append(0)  # filter type 0 (none)
        raw.extend(row)
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    data = open(SRC, "rb").read()
    assert len(data) == 64784, f"unexpected size {len(data)}"
    assert data[0:3] == b"Uh1", f"unexpected magic {data[0:3]!r}"

    palette_6bit = data[16:784]
    assert len(palette_6bit) == 768
    image = data[784:64784]
    assert len(image) == 320 * 200, f"unexpected image length {len(image)}"

    # Build 8-bit RGB palette (multiply 6-bit values by 4)
    palette_rgb = []
    for i in range(256):
        r6, g6, b6 = palette_6bit[i * 3], palette_6bit[i * 3 + 1], palette_6bit[i * 3 + 2]
        palette_rgb.append((r6 * 4, g6 * 4, b6 * 4))

    width, height = 320, 200
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            idx = image[y * width + x]
            r, g, b = palette_rgb[idx]
            row += bytes((r, g, b))
        rows.append(bytes(row))

    write_png(OUT_PNG, width, height, rows)

    # histogram of distinct pixel values
    from collections import Counter
    hist = Counter(image)
    distinct = sorted(hist.keys())

    report = {
        "size": len(data),
        "magic": data[0:3].decode("latin1"),
        "header_bytes_0_16_hex": data[0:16].hex(),
        "palette_len": len(palette_6bit),
        "image_len": len(image),
        "distinct_pixel_values": distinct,
        "histogram": {str(k): v for k, v in sorted(hist.items())},
        "max_palette_component_6bit": max(palette_6bit),
    }
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
