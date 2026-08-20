// CRED pictures, taken from the SHIPPED executable rather than the dev tree.
//
//   node tools/extract_cred_shipped.mjs <unpacked-CRED.EXE> [--check]
//
// WHY. CREDITS/MAIN.C links its 21 pictures in as FAR_DATA segments built from
// picNN.inc (CREDITS/INCLUDE.ASM), and tools/extract_post_minv_assets.mjs pulls
// them out of the assembled CREDITS/INCLUDE.OBJ + INCLUD2.OBJ. Those OBJs are a
// STALE build: against the payloads actually linked into MAIN/DATA/CRED.EXE, 14
// of the 21 are byte-identical and 7 are DIFFERENT ARTWORK — the dev tree still
// held placeholders and unfinished renders, including screen 2's "PART PIC
// MISSING (PXL SUX)" scrawl. The shipped picture there is the finished blue
// satellites over the moonscape.
//
// The 7 divergent slots: 2, 6 (pic05b), 10 (pic09), 17 (pic14b), 19 (pic16),
// 20 (pic17), 21 (pic18).
//
// CRED.EXE ships PKLITE-compressed. Unpack it first (no PKLITE implementation
// lives in this repo; deark's is fine and was used to derive the offsets below):
//
//   deark -m pklite -o /tmp/cred MAIN/DATA/CRED.EXE
//   node tools/extract_cred_shipped.mjs /tmp/cred.000.exe
//
// Layout in the unpacked image, all derived by locating the 14 matching payloads
// and solving for the arithmetic (not guessed): each picture occupies one
// paragraph-aligned FAR_DATA segment of stride 0x4190 (16784 = 16772 rounded up
// to a 16-byte paragraph), laid out in INCLUDE.ASM's declaration order, with the
// 768-byte palette immediately preceding the 16000-byte 160x100 pixel block.
// Slot 1's pixel block starts at 0x11D60. The final picture's trailing zeros are
// trimmed from the file image, so a short read is zero-padded.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const CRED = path.join(WEB, 'assets', 'cred');

const NAMES = ['pic01', 'pic02', 'pic03', 'pic04', 'pic05', 'pic05b', 'pic06', 'pic07',
  'pic08', 'pic09', 'pic10', 'pic10b', 'pic11', 'pic12', 'pic13', 'pic14', 'pic14b',
  'pic15', 'pic16', 'pic17', 'pic18'];
// slots whose shipped payload differs from the dev OBJs (0-based)
const DIVERGENT = new Set([1, 5, 9, 16, 18, 19, 20]);

const PIX_BASE = 0x11d60;   // slot 1's pixel block
const STRIDE = 0x4190;
const PAL_LEN = 768, PIX_LEN = 160 * 100, PIC_LEN = 4 + PAL_LEN + PIX_LEN;

const exePath = process.argv[2];
const check = process.argv.includes('--check');
if (!exePath || exePath.startsWith('--')) {
  console.error('usage: node tools/extract_cred_shipped.mjs <unpacked-CRED.EXE> [--check]');
  console.error('  unpack first:  deark -m pklite -o /tmp/cred MAIN/DATA/CRED.EXE');
  process.exit(2);
}
const exe = new Uint8Array(await readFile(exePath));

const slice = (off, len) => {
  const out = new Uint8Array(len);
  out.set(exe.subarray(off, Math.min(off + len, exe.length)));
  return out;                                   // zero-pads a trimmed tail
};

// Rebuild each picture in the port's on-disk form: u16 width, u16 height,
// 768-byte palette, then the pixels (see cred.js's loader).
function shippedPicture(slot) {
  const pixOff = PIX_BASE + slot * STRIDE;
  const buf = new Uint8Array(PIC_LEN);
  buf[0] = 160; buf[1] = 0; buf[2] = 100; buf[3] = 0;
  buf.set(slice(pixOff - PAL_LEN, PAL_LEN), 4);
  buf.set(slice(pixOff, PIX_LEN), 4 + PAL_LEN);
  return buf;
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let bad = 0, agree = 0;
for (let i = 0; i < NAMES.length; i++) {
  const name = NAMES[i];
  const onDisk = new Uint8Array(await readFile(path.join(CRED, `${name}.bin`)));
  const ship = shippedPicture(i);
  if (!DIVERGENT.has(i)) {
    // Integrity assertion: these 14 must match the dev OBJs byte-for-byte. If
    // they ever stop matching, the layout constants above are wrong and the
    // divergent set cannot be trusted either.
    if (eq(onDisk, ship)) agree++;
    else { console.log(`MISMATCH ${name}: shipped != committed, but this slot should agree`); bad++; }
    continue;
  }
  if (check) {
    const same = eq(onDisk, ship);
    if (!same) bad++;
    console.log(`${same ? 'ok  ' : 'DIFF'} ${name} (divergent slot ${i + 1})`);
  } else {
    await writeFile(path.join(CRED, `${name}.bin`), Buffer.from(ship));
    console.log(`wrote ${name}.bin from shipped CRED.EXE (slot ${i + 1})`);
  }
}
console.log(`\nlayout cross-check: ${agree}/${NAMES.length - DIVERGENT.size} non-divergent slots ` +
  `byte-identical between CREDITS/*.OBJ and the shipped CRED.EXE`);
if (bad) { console.log(`${bad} problem(s)`); process.exitCode = 1; }
