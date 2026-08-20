#!/usr/bin/env node
// Copies the COMAN wave tables into the browser bundle.
//
// assets/coman_w1.bin and assets/coman_w2.bin are byte-exact copies of
// COMAN/W1DTA.BIN and COMAN/W2DTA.BIN (32768 little-endian int16 words each).
// Those repo files were proven identical to the tables linked into the
// shipped MAIN/DATA/3DSINFLD.EXE (segments 0x944/0x1944 of the load image
// after unpacking its PKLITE 1.14 + LINK /E EXEPACK layers), and both equal
// MAIN.C's CALCW12 generator run over WAVE.H with MS C rand().
//
// No background asset is extracted on purpose: the shipped ASM.OBJ was
// assembled without PXLSUX, so docopy never blits combguse and COMBG.UH is
// dead data — the 3DSINFLD backdrop is black.

import { copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ASSETS = join(HERE, '..', 'assets');

for (const [source, bundled] of [
  ['COMAN/W1DTA.BIN', 'coman_w1.bin'],
  ['COMAN/W2DTA.BIN', 'coman_w2.bin'],
]) {
  const from = join(ROOT, source);
  const to = join(ASSETS, bundled);
  const size = statSync(from).size;
  if (size !== 65536) throw new Error(`${source}: expected 65536 bytes, got ${size}`);
  copyFileSync(from, to);
  console.log(`${source} -> assets/${bundled} (${size} bytes)`);
}
