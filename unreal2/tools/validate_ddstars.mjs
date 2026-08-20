// Deterministic checks on the hidden part (DDSTARS), asserted against
// DDSTARS/STARS.ASM rather than against a screenshot.
//
//   node tools/validate_ddstars.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ASSETS = path.resolve(HERE, '..', 'assets');

let fails = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (!good) fails++;
  console.log(`${good ? 'ok  ' : 'FAIL'}  ${label}${good ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const textBin = await readFile(path.join(ASSETS, 'ddstars_text.bin'));
globalThis.fetch = async () => ({
  arrayBuffer: async () => textBin.buffer.slice(textBin.byteOffset, textBin.byteOffset + textBin.byteLength),
});

const m = await import('../ddstars.js');
await m.loadDdstars();

const W = m.DDSTARS_W, H = m.DDSTARS_H;

// --- the asset ------------------------------------------------------------
// TEXTS.16 is what DOOBJ was fed; _TEXTPIC.OBK must still agree with it, and
// the shipped bitmap is 200 rows of 80 after a 64-byte header.
const texts16 = new Uint8Array(await readFile(path.join(ROOT, 'DDSTARS', 'TEXTS.16')));
ok('text picture is 200 rows of 80 bytes', textBin.length, 200 * 80);
ok('text picture matches TEXTS.16 past its 64-byte header',
   Buffer.compare(Buffer.from(textBin), Buffer.from(texts16.subarray(0x40))), 0);

// --- the shipped executable is the dev tree -------------------------------
// Recorded as a check so a future edit to the port cannot quietly drift from a
// source that was verified against the binary once.
const shipped = await readFile(path.join(ROOT, 'MAIN', 'DATA', 'DDSTARS.EXE'));
ok('MAIN/DATA/DDSTARS.EXE is the size the release shipped', shipped.length, 10573);

// --- the LCG --------------------------------------------------------------
// seed starts at 0 and random() returns DX — the low word of the product's high
// dword — so the first call returns 0 and the sequence is fixed from there.
m.ddstarsReset();
const rnd = m.__test.randomSeq(6, 0);
ok('random() from seed 0 begins 0', rnd[0], 0);
ok('random() is the LCG in STARS.ASM', rnd, m.__test.expectedRandom(6));

// --- the projection tables ------------------------------------------------
// muldiv[i] = (n*65536 / (150+4i)) >> 1, built with a 32/16 DIV.
const mx = m.__test.muldivX, my = m.__test.muldivY;
ok('muldivY[0]', my[0], (Math.floor(108 * 65536 / 150) >> 1));
ok('muldivX[0]', mx[0], (Math.floor(144 * 65536 / 150) >> 1));
ok('muldivY[255]', my[255], (Math.floor(108 * 65536 / 1170) >> 1));
ok('muldivX[255]', mx[255], (Math.floor(144 * 65536 / 1170) >> 1));
ok('every muldiv entry stays inside a signed word',
   mx.every(v => v > 0 && v < 32768) && my.every(v => v > 0 && v < 32768), true);

// --- geometry: stars on even rows, text on odd ----------------------------
// The blits step di by 80 at a 40-byte pitch, so stars occupy the 200 even rows
// and risetext (di = 80k - 40) the odd ones. If that ever stops being true the
// two would be fighting over the same rows.
m.ddstarsReset();
for (let f = 1; f <= 700; f++) m.ddstarsStepTo(f / 70, true);
let oddLit = 0, evenLit = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) if (m.ddstarsVram[y * W + x]) (y & 1 ? oddLit++ : evenLit++);
}
ok('before the text, only even rows are ever lit', { oddLit: oddLit > 0, evenLit: evenLit > 0 },
   { oddLit: false, evenLit: true });

// --- the mirror -----------------------------------------------------------
// The bottom half is the buffer 32 frames away in the ring, drawn from row 99
// upward. 32 ≡ -32 (mod 64), and a buffer is only written every 64th frame, so
// that buffer still holds exactly what it held 32 frames ago: the bottom half at
// frame N must equal the top half at frame N-32, flipped.
m.ddstarsReset();
const N = 800;
let topThen = null;
for (let f = 1; f <= N; f++) {
  m.ddstarsStepTo(f / 70, true);
  if (f === N - 32) topThen = m.ddstarsVram.slice(0, 200 * W);
}
let mismatch = 0, mirroredInk = 0;
for (let k = 0; k < 100; k++) {
  const bottom = m.ddstarsVram.subarray((200 + 2 * k) * W, (200 + 2 * k + 1) * W);
  const top = topThen.subarray((2 * (99 - k)) * W, (2 * (99 - k) + 1) * W);
  for (let x = 0; x < W; x++) {
    if (bottom[x] !== top[x]) mismatch++;
    if (bottom[x]) mirroredInk++;
  }
}
ok('bottom half is the top half from 32 frames earlier, mirrored', mismatch, 0);
ok('  and it is not simply blank', mirroredInk > 200, true);

// --- the timeline ---------------------------------------------------------
// Events are frame-counted (no music sync anywhere in this part): text at 1200
// and 3200, the 1024-star field armed at 1500, and stars stop being added
// between 900 and 1200 so the ring drains.
m.ddstarsReset();
const litAt = {};
const marks = [900, 1100, 1200, 1456, 1560, 3456, 3600];
for (let f = 1; f <= 3600; f++) {
  m.ddstarsStepTo(f / 70, true);
  if (marks.includes(f)) {
    let stars = 0, text = 0;
    for (let i = 0; i < m.ddstarsVram.length; i++) {
      const c = m.ddstarsVram[i];
      if (c >= 1 && c <= 3) stars++;
      else if (c >= 4) text++;
    }
    litAt[f] = { stars, text };
  }
}
ok('no text before frame 1456 (trigger 1200 + 256 of startxtopen)',
   [litAt[900].text, litAt[1100].text, litAt[1200].text], [0, 0, 0]);
ok('text block 1 is on screen by 1560', litAt[1560].text > 20000, true);
ok('text block 2 is on screen by 3600', litAt[3600].text > 20000, true);
ok('the field thins out over 900..1200 while nothing is added',
   litAt[1100].stars < litAt[900].stars, true);
ok('and refills once staradd2 takes over', litAt[3600].stars > litAt[1200].stars, true);
ok('nothing ever reaches colours 8..15 (plane 3 is only ever written zero)',
   m.__test.maxColourSeen(), 7);

// --- the palette ----------------------------------------------------------
// 33 frames of fade; shl bl,3 saturates from 32 up, so the ramp is 8,16..248
// then 255, and colours 4..7 never move.
m.ddstarsReset();
const pals = [];
for (let f = 1; f <= 40; f++) { m.ddstarsStepTo(f / 70, true); pals.push(m.ddstarsPal.slice(0, 24)); }
ok('colour 3 at full is 67*64/100,84*64/100,99*64/100 scaled by 255',
   [pals[39][9], pals[39][10], pals[39][11]],
   [(42 * 255) >> 8, (53 * 255) >> 8, (63 * 255) >> 8]);
ok('the fade has stopped moving by frame 33',
   Buffer.compare(Buffer.from(pals[32]), Buffer.from(pals[39])), 0);
ok('text colours 5,6,7 are fixed from the first frame',
   [...pals[0].slice(15, 24)], [10, 20, 35, 20, 30, 45, 30, 40, 60]);
ok('colour 4 (the text bar) is black', [...pals[39].slice(12, 15)], [0, 0, 0]);

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
