#!/usr/bin/env node

// Deterministic source/port regression checks for unreal2/panic.js
// (PANICEND: CRT power-off gag, PANIC/SHUTDOWN.C).
//
// panic.js is dual-mode, mirroring the two builds of SHUTDOWN.C:
//   - inherited mode (`panicReset(inheritVram400, inheritPal)`): the shipped
//     _LOADER_ build (`#define _LOADER_`, SHUTDOWN.C:19) — crushes whatever
//     picture + DAC the previous part left on screen.
//   - monster mode (`panicReset()`): the standalone SD.EXE build — loads and
//     flashes monster.bin first.
//
// Validation layers, run for BOTH modes:
//  1. A verbatim transcription of SHUTDOWN.C in VGA byte-address space
//     (65536 byte addresses x 4 planes, copyline = rep movsw over byte
//     addresses, tw_putpixel plane math) plus a CRTC fetch model derived
//     from TWEAK.ASM + SHUTDOWN.C's register pokes (reg 9 scan-doubling,
//     0x50->0xA0 pitch, latched start address). Every frame 0..130 must
//     match panic.js's panicVram/panicPal EXACTLY.
//  2. Structural visibility assertions: content flash, negative flash,
//     centered squish, a visible crush band confined to the derived
//     scanlines every crush frame (with per-row provenance from the
//     inherited buffer in inherited mode), the mid-shrink line, the dot,
//     the pulse values, and "no all-black frame before the fade".
//
// Also dumps eyeball PNGs (monster mode: panic_fNNN.png, inherited mode:
// panic_inh_fNNN.png) to PANIC_PNG_DIR or tools/panic_frames/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..');
const outDir = process.env.PANIC_PNG_DIR || path.join(here, 'panic_frames');

const monsterBin = fs.readFileSync(path.join(webRoot, 'assets', 'monster.bin'));

// Asset provenance: monster.bin must be MONSTER.PAL + MONSTER.U verbatim.
assert.deepEqual(monsterBin.subarray(0, 768),
  fs.readFileSync(path.join(repoRoot, 'PANIC', 'MONSTER.PAL')));
assert.deepEqual(monsterBin.subarray(768),
  fs.readFileSync(path.join(repoRoot, 'PANIC', 'MONSTER.U')));

// Shipped-build provenance for the _LOADER_ mode: the packed PANICEND.EXE
// must NOT reference monster.u (it crushes the inherited screen instead).
{
  const shipped = fs.readFileSync(path.join(repoRoot, 'MAIN', 'DATA', 'PANICEND.EXE'));
  assert.equal(shipped.indexOf(Buffer.from('monster.u', 'latin1')), -1,
    'shipped PANICEND.EXE is the _LOADER_ build (no monster.u reference)');
  assert.ok(shipped.length < 65536, 'shipped EXE far too small to embed the 64768-byte picture');
}

globalThis.fetch = async url => {
  assert.equal(url, 'assets/monster.bin');
  const ab = monsterBin.buffer.slice(monsterBin.byteOffset, monsterBin.byteOffset + monsterBin.byteLength);
  return { ok: true, status: 200, arrayBuffer: async () => ab };
};

const panic = await import(`${pathToFileURL(path.join(webRoot, 'panic.js')).href}?validation=1`);

// ---------------------------------------------------------------------------
// Shared source-derived tables.
// ---------------------------------------------------------------------------
const trunc = (a, b) => (a / b) | 0;
const kuvapal = Uint8Array.from(monsterBin.subarray(0, 768));
const kuva = Uint8Array.from(monsterBin.subarray(768, 768 + 64000));

// fadepals recomputed independently (SHUTDOWN.C:62 — b starts at 3, so index
// 0's RGB stays 0 in every level). Base palette = getpal() snapshot.
const mkFadepals = basePal => {
  const fps = [];
  for (let a = 0; a < 64; a++) {
    const fp = new Uint8Array(768);
    for (let b = 3; b < 768; b++) fp[b] = trunc(a * 63 + basePal[b] * (64 - a), 64);
    fps.push(fp);
  }
  return fps;
};

const CRUSH_A = []; for (let a = 32; a > 2; a = trunc(a * 5, 6)) CRUSH_A.push(a);
assert.deepEqual(CRUSH_A, [32, 26, 21, 17, 14, 11, 9, 7, 5, 4, 3]);
const HSHRINK_X = []; for (let x = 20; x <= 160; x += 3) HSHRINK_X.push(x);
assert.equal(HSHRINK_X.length, 47);
const CRUSH_START = 4, CRUSH_END = 14, HSHRINK_END = 61, DOTFADE_END = 121;

// The standalone build's screen content: monster.bin row-doubled to 400 rows
// (SHUTDOWN.C:45-49). Both modes stage a 320x400 screen image in the canvas
// right half, so the reference sim takes content as 400 rows.
const monster400 = new Uint8Array(320 * 400);
for (let y = 0; y < 200; y++) {
  const row = kuva.subarray(y * 320, (y + 1) * 320);
  monster400.set(row, (2 * y) * 320);
  monster400.set(row, (2 * y + 1) * 320);
}

// Synthetic troll-like 320x400 endcard + palette for inherited mode: bright
// sky gradient (row-varying), flesh/armor/rock figure — bright everywhere so
// black-frame detection is meaningful, figure spanning the crush rows.
function makeTestScreen() {
  const pix = new Uint8Array(320 * 400);
  const pal = new Uint8Array(768);
  const set = (i, r, g, b) => { pal[i * 3] = r; pal[i * 3 + 1] = g; pal[i * 3 + 2] = b; };
  set(0, 0, 0, 0);
  set(1, 42, 42, 42);
  for (let k = 0; k < 32; k++) set(16 + k, 8 + (k >> 1), 10 + (k >> 1), 28 + k);  // sky blues
  for (let k = 0; k < 8; k++) set(64 + k, 46 - k, 30 - (k >> 1), 14);             // flesh browns
  for (let k = 0; k < 8; k++) set(80 + k, 30 + k, 32 + k, 36 + k);                // rock greys
  for (let k = 0; k < 8; k++) set(88 + k, 26 + k, 34 + k, 44 + k);                // armor blue-greys
  for (let y = 0; y < 400; y++) for (let x = 0; x < 320; x++) {
    let c = 16 + trunc(y * 32, 400);
    if (y >= 370) c = 80 + (y & 7);
    else if (y >= 290) { if ((x >= 118 && x < 152) || (x >= 178 && x < 212)) c = 64 + (y & 7); }
    else if (y >= 110) {
      const half = 90 - ((y - 110) >> 3);
      if (x >= 160 - half && x < 160 + half)
        c = (y < 210 && x >= 128 && x < 192) ? 88 + (y & 7) : 64 + (y & 7);
    } else if (y >= 30) { if (x >= 130 && x < 190) c = 64 + (y & 7); }
    pix[y * 320 + x] = c;
  }
  return { pix, pal };
}

// ---------------------------------------------------------------------------
// Reference: verbatim SHUTDOWN.C in VGA byte-address space, parameterized by
// the staged screen content + base palette (the two things the builds vary).
// ---------------------------------------------------------------------------
function makeRef(content400, basePal) {
  // Unchained VGA: byte address b holds pixels for planes 0..3; flat pixel
  // index = (b & 0xffff)*4 + plane.
  const vram = new Uint8Array(65536 * 4);
  const fps = mkFadepals(basePal);
  const ppix = (x, y, c) => { vram[((y * 160 + (x >> 2)) & 0xffff) * 4 + (x & 3)] = c; };
  const gpix = (x, y) => vram[((y * 160 + (x >> 2)) & 0xffff) * 4 + (x & 3)];
  const copyline = (fromB, toB, countWords) => {  // ASMYT.ASM: rep movsw, latch mode = all 4 planes
    const n = countWords * 2;
    for (let i = 0; i < n; i++) {
      const s = ((fromB + i) & 0xffff) * 4, d = ((toB + i) & 0xffff) * 4;
      vram[d] = vram[s]; vram[d + 1] = vram[s + 1]; vram[d + 2] = vram[s + 2]; vram[d + 3] = vram[s + 3];
    }
  };
  const st = { start: 80, pitch: 160, doubled: false, pal: Uint8Array.from(basePal) };
  const out = new Uint8Array(320 * 400);

  const step = f => {
    if (f === 0) {                                     // screen as inherited / drawn by main()
      for (let y = 0; y < 400; y++) for (let x = 0; x < 320; x++)
        ppix(x + 320, y, content400[y * 320 + x]);
    } else if (f === 1) {                              // C:61-82
      for (let a = 0; a < 320; a++) ppix(a, 0, 0);
      for (let y = 0; y < 100; y++) for (let x = 0; x < 320; x++)
        ppix(x, y + 150, gpix(x + 320, y * 4));
      st.start = 100 * 160;                            // tw_setstart(100*160), latched here
      st.doubled = true;                               // reg 9 = 0x41, immediate
      st.pal = Uint8Array.from(fps[3]);
      st.pal[0] = st.pal[1] = st.pal[2] = 63;          // tw_setrgbpalette(0,63,63,63)
    } else if (f === 2) {                              // C:82-89
      st.start = 0;
      st.pitch = 320;                                  // reg 0x13 = 0xA0
      st.pal = Uint8Array.from(fps[20]);
    } else if (f >= CRUSH_START && f <= CRUSH_END) {   // C:91-105 (f===3 is the loop's leading waitb: no-op)
      const a = CRUSH_A[f - CRUSH_START];
      st.pal = Uint8Array.from(fps[63 - a]);
      for (let b = trunc(a, 2); b <= a; b++) {
        copyline(0, 200 * 160 - b * 320, 80);
        copyline(0, 200 * 160 + b * 320, 80);
      }
      for (let b = 0; b < a; b++)
        copyline(80 + trunc(400 * b, a) * 160, 200 * 160 + (b - trunc(a, 2)) * 320, 80);
      if (f === CRUSH_END) { copyline(0, 202 * 160, 80); copyline(0, 198 * 160, 80); }
    } else if (f > CRUSH_END && f <= HSHRINK_END) {    // C:116-127
      const x = HSHRINK_X[f - CRUSH_END - 1];
      ppix(x, 200, 0); ppix(320 - x, 200, 0);
      ppix(x + 1, 200, 0); ppix(319 - x, 200, 0);
      ppix(x + 2, 200, 0); ppix(318 - x, 200, 0);
      ppix(x + 3, 200, 0); ppix(317 - x, 200, 0);
      if (f === HSHRINK_END) ppix(160, 200, 1);        // C:129, still inside this interval
    } else if (f > HSHRINK_END && f <= DOTFADE_END) {  // C:130-135
      const a = f - HSHRINK_END - 1;
      const b = (Math.cos(a / 120.0 * 3 * 2 * Math.PI) * 31.0 + 32) | 0;  // int cast truncates
      st.pal = Uint8Array.from(st.pal);
      st.pal[3] = st.pal[4] = st.pal[5] = b;
    }                                                  // f >= 122: sleep(1), static
  };

  const render = () => {
    for (let oy = 0; oy < 400; oy++) {
      const charRow = st.doubled ? (oy >> 1) : oy;
      const ba = st.start + charRow * st.pitch;
      for (let ox = 0; ox < 320; ox++)
        out[oy * 320 + ox] = vram[((ba + (ox >> 2)) & 0xffff) * 4 + (ox & 3)];
    }
    return out;
  };

  return { step, render, st };
}

// ---------------------------------------------------------------------------
// Drive panic.js frame by frame against the reference for one mode.
// ---------------------------------------------------------------------------
const lum = (pix, pal) => pal[pix * 3] + pal[pix * 3 + 1] + pal[pix * 3 + 2];  // 0..189, 6-bit
const BRIGHT = 30;
const KEEP_FRAMES = [0, 1, 2, 3, 4, 8, 14, 38, 61, 62, 82, 121, 130];

function runMode(label, content400, basePal, resetArgs) {
  panic.panicReset(...resetArgs);
  const ref = makeRef(content400, basePal);
  const keep = new Map();
  const brightCounts = [];
  for (let f = 0; f <= 130; f++) {
    const alive = panic.panicStepTo((f + 0.5) / 70, true);
    assert.equal(panic.panicLocalFrames(), f);
    assert.equal(alive, true);
    ref.step(f);
    const refOut = ref.render();
    assert.ok(Buffer.from(panic.panicVram).equals(Buffer.from(refOut)),
      `${label} frame ${f}: panicVram must match verbatim-C reference raster`);
    assert.ok(Buffer.from(panic.panicPal).equals(Buffer.from(ref.st.pal)),
      `${label} frame ${f}: panicPal must match reference palette`);
    let bright = 0;
    for (let i = 0; i < 320 * 400; i++) if (lum(panic.panicVram[i], panic.panicPal) >= BRIGHT) bright++;
    brightCounts.push(bright);
    if (KEEP_FRAMES.includes(f))
      keep.set(f, { vram: Uint8Array.from(panic.panicVram), pal: Uint8Array.from(panic.panicPal) });
  }
  // No all-black frame before the fade phase begins.
  for (let f = 0; f <= HSHRINK_END; f++)
    assert.ok(brightCounts[f] >= 2, `${label} frame ${f} must not be black (bright=${brightCounts[f]})`);
  // Crush frames: band confined to derived scanlines, always lit.
  for (let f = CRUSH_START; f <= CRUSH_END; f++) {
    const a = CRUSH_A[f - CRUSH_START];
    const lo = 200 - 2 * (a >> 1);
    const hi = 200 + 2 * (a - 1 - (a >> 1)) + 1;
    panic.panicReset(...resetArgs);
    panic.panicStepTo((f + 0.5) / 70, true);
    let bright = 0;
    for (let oy = 0; oy < 400; oy++) for (let ox = 0; ox < 320; ox++) {
      const pix = panic.panicVram[oy * 320 + ox];
      if (pix !== 0) assert.ok(oy >= lo && oy <= hi, `${label} f${f} (a=${a}): pixel outside band at oy=${oy}`);
      if (lum(pix, panic.panicPal) >= BRIGHT) bright++;
    }
    assert.ok(bright > 200, `${label} f${f} (a=${a}) crush band bright pixels: ${bright}`);
  }
  // f2 == f3 (the crush loop's leading dis_waitb repeats the frame).
  assert.ok(Buffer.from(keep.get(2).vram).equals(Buffer.from(keep.get(3).vram)), `${label} f2 == f3 raster`);
  assert.ok(Buffer.from(keep.get(2).pal).equals(Buffer.from(keep.get(3).pal)), `${label} f2 == f3 palette`);
  // f14: single line — only canvas row 200 (oy 200+201) lit.
  {
    const { vram: v } = keep.get(14);
    for (let oy = 0; oy < 400; oy++) if (oy !== 200 && oy !== 201)
      for (let ox = 0; ox < 320; ox++) assert.equal(v[oy * 320 + ox], 0, `${label} f14 stray pixel at (${ox},${oy})`);
    assert.ok(Buffer.from(v.subarray(200 * 320, 201 * 320)).equals(Buffer.from(v.subarray(201 * 320, 202 * 320))));
  }
  // Hold static after the fade.
  assert.ok(Buffer.from(keep.get(121).vram).equals(Buffer.from(keep.get(130).vram)), `${label} hold raster static`);
  assert.ok(Buffer.from(keep.get(121).pal).equals(Buffer.from(keep.get(130).pal)), `${label} hold palette static`);
  return { keep, brightCounts };
}

await panic.loadPanic();
panic.panicReset();
assert.equal(panic.panicEndFrames(), 192, 'main.js PANIC_END_FRAMES contract');

// =========================== monster (standalone) mode =====================
const M = runMode('monster', monster400, kuvapal, []);

// f0 — monster face: exactly the row-doubled 320x200 picture, and bright.
{
  const { vram: v } = M.keep.get(0);
  for (let oy = 0; oy < 400; oy += 7) for (let ox = 0; ox < 320; ox += 3)
    assert.equal(v[oy * 320 + ox], kuva[(oy >> 1) * 320 + ox], `f0 face pixel (${ox},${oy})`);
  assert.ok(M.brightCounts[0] > 30000, `f0 face bright pixels: ${M.brightCounts[0]}`);
}
// f1 — "photo negative" flash: index 0 white, top 100 rows background, the
// squish copy (doubled back to 200 scanlines) at oy 100-299.
{
  const { vram: v, pal: p } = M.keep.get(1);
  assert.deepEqual([p[0], p[1], p[2]], [63, 63, 63], 'f1 index 0 must be white');
  for (let i = 0; i < 100 * 320; i++) assert.equal(v[i], 0, 'f1 top rows are bg');
  for (let oy = 100; oy < 300; oy += 5) for (let ox = 0; ox < 320; ox += 3)
    assert.equal(v[oy * 320 + ox], kuva[2 * ((oy >> 1) - 50) * 320 + ox], `f1 squish pixel (${ox},${oy})`);
  assert.ok(M.brightCounts[1] > 60000, `f1 bright pixels (white bg + face): ${M.brightCounts[1]}`);
}
// f2 — centered quarter-height squish on black.
{
  const { vram: v, pal: p } = M.keep.get(2);
  assert.deepEqual([p[0], p[1], p[2]], [0, 0, 0], 'f2 bg black again');
  let inside = 0;
  for (let oy = 0; oy < 400; oy++) {
    const rowHas = v.subarray(oy * 320, (oy + 1) * 320).some(x => x !== 0);
    if (rowHas) assert.ok(oy >= 150 && oy <= 249, `f2 content confined to oy 150-249 (oy=${oy})`);
    if (rowHas) inside++;
  }
  assert.ok(inside > 60, `f2 squish rows with content: ${inside}`);
  assert.ok(M.brightCounts[2] > 5000, `f2 bright pixels: ${M.brightCounts[2]}`);
}
// f38 — mid-shrink: erased ranges empty, middle segment lit.
{
  const { vram: v } = M.keep.get(38);
  const x = HSHRINK_X[38 - CRUSH_END - 1];
  const row = v.subarray(200 * 320, 201 * 320);
  for (let c = 20; c <= x + 3; c++) assert.equal(row[c], 0, `f38 col ${c} erased`);
  for (let c = 317 - x; c <= 300; c++) assert.equal(row[c], 0, `f38 col ${c} erased`);
  let mid = 0;
  for (let c = x + 4; c <= 316 - x; c++) if (row[c] !== 0) mid++;
  assert.ok(mid > 50, `f38 middle segment lit: ${mid} px`);
}
// f61 — line fully consumed, dot placed: cols 20-300 empty except col 160 = color 1.
{
  const { vram: v, pal: p } = M.keep.get(61);
  const row = v.subarray(200 * 320, 201 * 320);
  for (let c = 20; c <= 300; c++) assert.equal(row[c], c === 160 ? 1 : 0, `f61 col ${c}`);
  assert.ok(lum(1, p) >= BRIGHT, 'f61 dot visible (fadepals[60] index 1 is near-white)');
  let stubBright = 0;
  for (const c of [...Array(20).keys(), ...Array.from({ length: 19 }, (_, i) => 301 + i)])
    if (lum(row[c], p) >= BRIGHT) stubBright++;
  console.log(`[info] monster f61 edge-stub pixels at row 200 (source quirk): ${stubBright}/39 bright`);
}
// Dot pulse — exact C truncation values at the cosine extremes.
{
  assert.deepEqual([...M.keep.get(62).pal.subarray(3, 6)], [63, 63, 63], 'fade a=0: dot white');
  panic.panicReset(); panic.panicStepTo((82 + 0.5) / 70, true);   // a=20: cos(pi) -> b=1
  assert.deepEqual([...panic.panicPal.subarray(3, 6)], [1, 1, 1], 'fade a=20: dot dark');
  panic.panicReset(); panic.panicStepTo((102 + 0.5) / 70, true);  // a=40: cos(2pi) -> b=63
  assert.deepEqual([...panic.panicPal.subarray(3, 6)], [63, 63, 63], 'fade a=40: dot white');
  const b59 = (Math.cos(59 / 120.0 * 3 * 2 * Math.PI) * 31.0 + 32) | 0;
  assert.deepEqual([...M.keep.get(121).pal.subarray(3, 6)], [b59, b59, b59]);
  assert.ok(b59 <= 2, `fade ends near black (b=${b59})`);
}
// Part ends exactly at frame 192.
{
  panic.panicReset();
  assert.equal(panic.panicStepTo(191.5 / 70, true), true);
  assert.equal(panic.panicEnded(), false);
  assert.equal(panic.panicStepTo(10, true), false);
  assert.equal(panic.panicEnded(), true);
}

// =========================== inherited (_LOADER_) mode =====================
const { pix: testPix, pal: testPal } = makeTestScreen();
const I = runMode('inherited', testPix, testPal, [testPix, testPal]);

// f0 — seamless handoff: raster IS the inherited buffer, palette IS the
// inherited DAC (getpal() snapshot).
{
  const { vram: v, pal: p } = I.keep.get(0);
  assert.ok(Buffer.from(v).equals(Buffer.from(testPix)), 'inherited f0 raster == inherited screen');
  assert.ok(Buffer.from(p).equals(Buffer.from(testPal)), 'inherited f0 palette == inherited DAC');
}
// fadepals interpolate from the INHERITED palette (SHUTDOWN.C:52 + 62).
{
  const fps = mkFadepals(testPal);
  assert.ok(Buffer.from(I.keep.get(2).pal).equals(Buffer.from(fps[20])),
    'inherited f2 palette derives from inherited DAC, not monster.bin');
  const white = fps[3].slice(); white[0] = white[1] = white[2] = 63;
  assert.ok(Buffer.from(I.keep.get(1).pal).equals(Buffer.from(white)),
    'inherited f1 negative-flash palette derives from inherited DAC');
}
// Crush provenance: crush band rows are exact copies of the specified
// INHERITED rows (full 0-399 height sampling — rows trunc(400*b/a), any
// parity — onto even destination rows, each doubled). Authentic feedback
// caveat the reference sim reproduces exactly: erase/draw copylines write
// FULL 640px rows, clobbering the right-half staging of even canvas rows in
// the 200±2a window before later b iterations sample them — so assert
// pristine-inherited provenance only where the staging is provably intact:
// odd source rows (never a copyline destination anywhere in the effect) and
// even rows outside the CUMULATIVE clobber zone — the first iteration
// (a=32) already spans the maximal extent, even rows 136..264 (erases reach
// 200±2a, draws stay inside that). The clobbered remainder is covered by
// the frame-exact ref check.
for (let f = CRUSH_START; f <= CRUSH_END; f++) {
  const a = CRUSH_A[f - CRUSH_START];
  panic.panicReset(testPix, testPal);
  panic.panicStepTo((f + 0.5) / 70, true);
  const srcParities = new Set();
  let asserted = 0;
  for (let b = 0; b < a; b++) {
    const destRow = 200 + 2 * (b - (a >> 1));
    const srcRow = trunc(400 * b, a);
    const pristine = (srcRow & 1) === 1 || srcRow < 136 || srcRow > 264;
    if (!pristine) continue;
    srcParities.add(srcRow & 1);
    // Final iteration: SHUTDOWN.C:104-105 erases rows 202/198 right after
    // drawing them, leaving only row 200 — skip the erased two.
    if (f === CRUSH_END && destRow !== 200) continue;
    asserted++;
    const want = Buffer.from(testPix.subarray(srcRow * 320, (srcRow + 1) * 320));
    assert.ok(Buffer.from(panic.panicVram.subarray(destRow * 320, (destRow + 1) * 320)).equals(want),
      `inherited f${f} b=${b}: band row ${destRow} == inherited row ${srcRow}`);
    assert.ok(Buffer.from(panic.panicVram.subarray((destRow + 1) * 320, (destRow + 2) * 320)).equals(want),
      `inherited f${f} b=${b}: doubled scanline of band row ${destRow}`);
  }
  assert.ok(asserted >= (f === CRUSH_END ? 1 : Math.max(2, (a * 2 / 3) | 0)),
    `inherited f${f}: enough pristine rows asserted (${asserted}/${a})`);
  // a=5 (rows 80b) and a=4 (rows 100b) happen to sample only even rows; every
  // other iteration must hit both parities (proves full-height sampling).
  if (a !== 5 && a !== 4) assert.ok(srcParities.has(0) && srcParities.has(1),
    `inherited f${f}: crush samples both odd and even inherited rows (full height)`);
}
// Inherited-mode line/stub content comes from inherited row 133.
{
  const { vram: v, pal: p } = I.keep.get(61);
  const row = v.subarray(200 * 320, 201 * 320);
  for (let c = 0; c < 20; c++) assert.equal(row[c], testPix[133 * 320 + c], `f61 stub col ${c} from inherited row 133`);
  let stubBright = 0;
  for (const c of [...Array(20).keys(), ...Array.from({ length: 19 }, (_, i) => 301 + i)])
    if (lum(row[c], p) >= BRIGHT) stubBright++;
  console.log(`[info] inherited f61 edge-stub pixels at row 200 (source quirk): ${stubBright}/39 bright`);
}

// ---------------------------------------------------------------------------
// PNG dumps for eyeball confirmation.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function writePng(file, w, h, vramFrame, pal) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const pix = vramFrame[y * w + x];
      for (let ch = 0; ch < 3; ch++) {
        const v6 = pal[pix * 3 + ch];
        raw[o + 1 + x * 3 + ch] = (v6 << 2) | (v6 >> 4);
      }
    }
  }
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

fs.mkdirSync(outDir, { recursive: true });
for (const [prefix, mode] of [['panic_f', M], ['panic_inh_f', I]]) {
  for (const [f, { vram: v, pal: p }] of mode.keep) {
    if (f === 130) continue;
    writePng(path.join(outDir, `${prefix}${String(f).padStart(3, '0')}.png`), 320, 400, v, p);
  }
}
console.log(`PNG frames written to ${outDir}`);
console.log('monster   bright f0..f16:', M.brightCounts.slice(0, 17).join(','));
console.log('inherited bright f0..f16:', I.brightCounts.slice(0, 17).join(','));
console.log('PANICEND validation passed: both modes frame-exact vs verbatim-C reference; '
  + 'inherited crush provenance from inherited buffer + DAC; no black frame before the fade; 192-frame budget');
