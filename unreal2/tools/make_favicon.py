#!/usr/bin/env python3
"""Generate the site's favicon: favicon.ico + favicon.svg at the repo root.

The painting makes a fine 180px home-screen icon and unreadable mush at 16, so
the tab gets a drawn mark instead: SR in the board's own bright cyan on black,
letters built out of blocks the way the ASCII banners are. Two sizes of the same
idea rather than one image scaled past its legibility.

Both files come out of the GLYPHS table below, so the vector and the bitmap
cannot drift apart.

    python3 unreal2/tools/make_favicon.py
"""

import pathlib
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[2]

FG = '#55ffff'          # --bcyn, the board's bright cyan
BG = '#000000'
TEXT = 'SR'

# 3x5, and the R's bowl deliberately stops one column short with the leg splayed
# — a full-width bowl at this size reads as an A.
GLYPHS = {
    'S': ["###", "#..", "###", "..#", "###"],
    'R': ["##.", "#.#", "##.", "#.#", "#.#"],
}

GRID = 16               # the mark is designed on a 16x16 grid
SCALE = 2               # 2 grid units per font pixel


def blocks():
    """Every lit font pixel as (x, y, w, h) on the 16x16 grid."""
    w = len(TEXT) * 3 * SCALE + (len(TEXT) - 1) * SCALE
    x0 = (GRID - w) // 2
    y0 = (GRID - 5 * SCALE) // 2
    out = []
    for gi, ch in enumerate(TEXT):
        for ry, row in enumerate(GLYPHS[ch]):
            for rx, cell in enumerate(row):
                if cell == '#':
                    out.append((x0 + gi * 4 * SCALE + rx * SCALE,
                                y0 + ry * SCALE, SCALE, SCALE))
    return out


def png(size):
    im = Image.new('RGB', (GRID, GRID), BG)
    d = ImageDraw.Draw(im)
    for x, y, w, h in blocks():
        d.rectangle([x, y, x + w - 1, y + h - 1], fill=FG)
    # NEAREST at integer multiples: the blocks stay blocks
    return im.resize((size, size), Image.NEAREST)


def svg():
    rects = '\n'.join(
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{FG}"/>'
        for x, y, w, h in blocks())
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GRID} {GRID}" '
            f'shape-rendering="crispEdges">\n'
            f'  <rect width="{GRID}" height="{GRID}" fill="{BG}"/>\n'
            f'{rects}\n</svg>\n')


ico = ROOT / 'favicon.ico'
png(64).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
(ROOT / 'favicon.svg').write_text(svg())
print(f'wrote {ico.relative_to(ROOT)} (16/32/48) and favicon.svg')
