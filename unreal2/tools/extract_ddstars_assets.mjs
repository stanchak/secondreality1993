// Extract the hidden part's text picture from DDSTARS/_TEXTPIC.OBK.
//
//   node tools/extract_ddstars_assets.mjs
//
// DDSTARS is the part the loader never runs (MAIN/U2.ASM's `exehid`, reachable
// only with the undocumented `SECOND U`). Its only linked asset is _textpic,
// built by DOTEXTS.BAT as:
//
//   lbm16 texts.lbm texts.16 2      ; 2 bitplanes out of the 16-colour LBM
//   doobj texts.16 _textpic _textpic.obk
//
// TEXTS.16 is 16,064 bytes = a 64-byte header plus 200 rows of 80. Each row is
// two 40-byte planes back to back, which is exactly how risetext consumes it:
// 40 bytes written under map mask 0Dh, then the next 40 under 0Eh, then one row
// down. So the payload is a 320x200 two-plane image, and the two text blocks
// the part shows live at row 1 (startxtp0 = 80) and row 101 (startxtp0 = 101*80).
//
// The header is dropped here rather than in the browser so the asset is exactly
// the bitmap the renderer indexes.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOmfSegments } from './extract_post_minv_assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.resolve(HERE, '..', 'assets');

const HEADER = 0x40;          // risetext starts at si = 040h
const PITCH = 80;             // two 40-byte planes per image row
const ROWS = 200;

const segments = await readOmfSegments(path.join(ROOT, 'DDSTARS', '_TEXTPIC.OBK'));
// DOOBJ emits one data segment; take the only one rather than assuming its index.
const nonEmpty = [...segments.entries()].filter(([, b]) => b.length > 1000);
if (nonEmpty.length !== 1) {
  throw new Error(`expected one data segment in _TEXTPIC.OBK, got ${nonEmpty.length}`);
}
const raw = nonEmpty[0][1];

// Cross-check against TEXTS.16, the file DOOBJ was given. They must agree.
const ref = new Uint8Array(await readFile(path.join(ROOT, 'DDSTARS', 'TEXTS.16')));
if (raw.length !== ref.length) {
  throw new Error(`_TEXTPIC.OBK is ${raw.length} bytes, TEXTS.16 is ${ref.length}`);
}
for (let i = 0; i < ref.length; i++) {
  if (raw[i] !== ref[i]) throw new Error(`_TEXTPIC.OBK differs from TEXTS.16 at ${i}`);
}
if (raw.length !== HEADER + PITCH * ROWS) {
  throw new Error(`unexpected size ${raw.length}, expected ${HEADER + PITCH * ROWS}`);
}

const bitmap = raw.slice(HEADER);
await writeFile(path.join(OUT, 'ddstars_text.bin'), bitmap);
console.log(`ddstars_text.bin: ${bitmap.length} bytes ` +
            `(${PITCH * 8 / 2}x${ROWS}, 2 planes) — matches TEXTS.16 byte for byte`);

// Report what is actually inked in each block, so a silent extraction failure
// cannot pass for a picture.
for (const [label, p0] of [['block 1 (startxtp0=80)', 80], ['block 2 (startxtp0=101*80)', 101 * 80]]) {
  let ink = 0, rows = 0;
  for (let r = 0; r < 100; r++) {
    const off = p0 + r * PITCH;
    if (off + PITCH > bitmap.length) break;
    let rowInk = 0;
    for (let i = 0; i < PITCH; i++) {
      for (let b = 0; b < 8; b++) if (bitmap[off + i] & (1 << b)) rowInk++;
    }
    if (rowInk) rows++;
    ink += rowInk;
  }
  console.log(`  ${label}: ${ink} set bits across ${rows} non-blank rows`);
}
