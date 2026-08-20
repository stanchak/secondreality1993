#!/usr/bin/env python3
"""Parse BEG/SRTITLE.LBM (IFF ILBM/PBM) -> assets/srtitle.bin + tools/srtitle.png.

IFF chunk format: 4-byte ID, 4-byte big-endian length, data (padded to even length).
BMHD (20 bytes): w:u16, h:u16, x:i16, y:i16, nPlanes:u8, masking:u8, compression:u8,
                 pad1:u8, transparentColor:u16, xAspect:u8, yAspect:u8, pageWidth:i16, pageHeight:i16
CMAP: palette bytes, 3 per color (R,G,B)
BODY: pixel data (possibly ByteRun1 / PackBits compressed)
"""
import struct
import zlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repository root
SRC = str(ROOT / "BEG/SRTITLE.LBM")
OUT_BIN = str(ROOT / "glenz-web/assets/srtitle.bin")
OUT_PNG = str(ROOT / "glenz-web/tools/srtitle.png")


def write_png(path, width, height, rgb_rows):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = bytearray()
    for row in rgb_rows:
        raw.append(0)
        raw.extend(row)
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def parse_chunks(data, start, end):
    """Yield (id, chunk_data) for top-level chunks between start and end."""
    pos = start
    chunks = []
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        clen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        cdata = data[pos + 8:pos + 8 + clen]
        chunks.append((cid, cdata))
        pos += 8 + clen
        if clen % 2 == 1:
            pos += 1  # pad byte
    return chunks


def unpack_byterun1_row(data, pos, expected_len):
    """Decode one row worth (expected_len bytes) of ByteRun1 (PackBits) data starting at pos.
    Returns (decoded_bytes, new_pos)."""
    out = bytearray()
    while len(out) < expected_len:
        n = data[pos]
        pos += 1
        if n <= 127:
            count = n + 1
            out.extend(data[pos:pos + count])
            pos += count
        elif n == 128:
            pass  # no-op
        else:
            # n in 129..255 represents signed -127..-1 -> repeat count = 257-n
            count = 257 - n
            val = data[pos]
            pos += 1
            out.extend([val] * count)
    return bytes(out[:expected_len]), pos


def main():
    data = open(SRC, "rb").read()
    assert data[0:4] == b"FORM", f"not an IFF FORM file: {data[0:4]!r}"
    form_len = struct.unpack(">I", data[4:8])[0]
    form_type = data[8:12].decode("ascii")
    assert form_type in ("ILBM", "PBM "), f"unexpected FORM type {form_type!r}"

    chunks = parse_chunks(data, 12, min(len(data), 8 + form_len))

    bmhd = None
    cmap = None
    body = None
    other_chunks = []
    for cid, cdata in chunks:
        cid_s = cid.decode("ascii", errors="replace")
        if cid == b"BMHD":
            bmhd = cdata
        elif cid == b"CMAP":
            cmap = cdata
        elif cid == b"BODY":
            body = cdata
        else:
            other_chunks.append((cid_s, len(cdata)))

    assert bmhd is not None, "no BMHD chunk found"
    (w, h, x, y, nPlanes, masking, compression, pad1,
     transparentColor, xAspect, yAspect, pageWidth, pageHeight) = struct.unpack(">HHhhBBBBHBBhh", bmhd[:20])

    assert body is not None, "no BODY chunk found"

    cmap_len = len(cmap) if cmap else 0
    cmap_max = max(cmap) if cmap else 0

    # Build 768-byte palette, padded with zeros, values stored EXACTLY as in file
    palette = bytearray(768)
    if cmap:
        n = min(len(cmap), 768)
        palette[:n] = cmap[:n]

    # Decode BODY -> chunky pixel array width*height
    if form_type == "PBM ":
        row_bytes = w + (w % 2)  # padded to even
        pos = 0
        chunky = bytearray(w * h)
        if compression == 1:
            for row in range(h):
                row_data, pos = unpack_byterun1_row(body, pos, row_bytes)
                chunky[row * w:(row + 1) * w] = row_data[:w]
        else:
            for row in range(h):
                row_data = body[pos:pos + row_bytes]
                pos += row_bytes
                chunky[row * w:(row + 1) * w] = row_data[:w]
    else:
        # ILBM planar
        row_bytes_per_plane = ((w + 15) // 16) * 2
        pos = 0
        # planes_rows[p][y] = bytes for that plane/row
        planes_rows = [[None] * h for _ in range(nPlanes)]
        if compression == 1:
            for row in range(h):
                for p in range(nPlanes):
                    row_data, pos = unpack_byterun1_row(body, pos, row_bytes_per_plane)
                    planes_rows[p][row] = row_data
        else:
            for row in range(h):
                for p in range(nPlanes):
                    row_data = body[pos:pos + row_bytes_per_plane]
                    pos += row_bytes_per_plane
                    planes_rows[p][row] = row_data

        chunky = bytearray(w * h)
        for row in range(h):
            for xx in range(w):
                byte_index = xx // 8
                bit_index = 7 - (xx % 8)
                val = 0
                for p in range(nPlanes):
                    bit = (planes_rows[p][row][byte_index] >> bit_index) & 1
                    val |= bit << p
                chunky[row * w + xx] = val

    # Write assets/srtitle.bin: 768 bytes palette + width*height chunky pixels
    with open(OUT_BIN, "wb") as f:
        f.write(bytes(palette))
        f.write(bytes(chunky))

    # Build PNG preview
    use_as_is = cmap_max > 63
    rows = []
    for row in range(h):
        rowbytes = bytearray()
        for xx in range(w):
            idx = chunky[row * w + xx]
            r6, g6, b6 = palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]
            if use_as_is:
                r, g, b = r6, g6, b6
            else:
                r, g, b = r6 * 4, g6 * 4, b6 * 4
            rowbytes += bytes((r, g, b))
        rows.append(bytes(rowbytes))
    write_png(OUT_PNG, w, h, rows)

    distinct_pixels = sorted(set(chunky))

    report = {
        "form_type": form_type.strip(),
        "form_declared_len": form_len,
        "file_size": len(data),
        "bmhd": {
            "width": w, "height": h, "x": x, "y": y,
            "nPlanes": nPlanes, "masking": masking, "compression": compression,
            "pad1": pad1, "transparentColor": transparentColor,
            "xAspect": xAspect, "yAspect": yAspect,
            "pageWidth": pageWidth, "pageHeight": pageHeight,
        },
        "cmap_len": cmap_len,
        "cmap_max_component": cmap_max,
        "cmap_used_as_is_in_png": use_as_is,
        "other_chunks": other_chunks,
        "distinct_pixel_value_count": len(distinct_pixels),
        "distinct_pixel_values_sample": distinct_pixels[:32],
        "srtitle_bin_size": 768 + w * h,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
