#!/usr/bin/env node

// Copy the original on-disk image formats used by WATER/DEMO.PAS and
// GRID/MAIN.C into the web bundle without interpreting or repacking them.
// The ports deliberately consume the same byte offsets as the DOS sources.

import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ASSETS = join(HERE, '..', 'assets');

const files = [
  ['WATER/BKG.CLX', 'ray_bkg.clx', 64778],
  ['WATER/MIEKKA.SCI', 'ray_miekka.sci', 14778],
  ['WATER/WAT1.DAT', 'ray_wat1.dat', 23096],
  ['WATER/WAT2.DAT', 'ray_wat2.dat', 23034],
  ['WATER/WAT3.DAT', 'ray_wat3.dat', 27818],
  // GRID/EYE4.UH is dropped: the shipped 3DSINFLD.EXE is COMAN,
  // not GRID (see sinfield.js header) — the eye asset is unused.
];

for (const [sourceName, targetName, expectedSize] of files) {
  const source = join(ROOT, sourceName);
  const target = join(ASSETS, targetName);
  const bytes = readFileSync(source);
  if (bytes.length !== expectedSize)
    throw new Error(`${sourceName}: expected ${expectedSize} bytes, got ${bytes.length}`);
  copyFileSync(source, target);
  console.log(`${sourceName} -> unreal2/assets/${targetName} (${bytes.length} bytes)`);
}
