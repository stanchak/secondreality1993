#!/usr/bin/env node

// Deterministic source/port regression checks for unreal2/plzpart.js.
//
// Independent evidence for the timing/visual model lives in the derivation
// comments in plzpart.js (reference-capture measurements + source reading);
// this validator (a) re-derives every table asset from the original
// PLZPART/ source text and byte-compares, and (b) pins the module's
// observable behavior — stage boundaries under the nominal music anchor,
// gate pass-through, replay/live equality, determinism — so regressions
// are caught mechanically.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..');
const srcDir = path.join(repoRoot, 'PLZPART');
const readSrc = f => fs.readFileSync(path.join(srcDir, f), 'latin1');
const readAsset = f => fs.readFileSync(path.join(webRoot, 'assets', f));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ---- 1. table assets re-derived from PLZPART/ source text ----------------

function parseNums(text, directive) {
  // db/dw lines with numeric equates, A*B expressions and REPT n..ENDM.
  const equates = new Map();
  const vals = [];
  const lines = text.split(/\r?\n/);
  const evalTok = (tok) => {
    tok = tok.trim();
    const m = tok.match(/^(-?\w+)\s*\*\s*(-?\w+)$/);
    if (m) return evalTok(m[1]) * evalTok(m[2]);
    if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
    if (equates.has(tok)) return equates.get(tok);
    throw new Error(`token ${JSON.stringify(tok)}`);
  };
  const doLine = (line) => {
    line = line.split(';')[0];
    const eq = line.match(/^\s*(\w+)\s*=\s*(-?\d+)\s*$/);
    if (eq) { equates.set(eq[1], parseInt(eq[2], 10)); return; }
    const m = line.match(new RegExp(`^\\s*${directive}\\s+(.*)$`, 'i'));
    if (m) for (const tok of m[1].split(',')) if (tok.trim()) vals.push(evalTok(tok));
  };
  for (let i = 0; i < lines.length; i++) {
    const rept = lines[i].split(';')[0].match(/^\s*REPT\s+(\d+)\s*$/i);
    if (rept) {
      const body = [];
      for (i++; i < lines.length && !/^\s*ENDM\s*$/i.test(lines[i].split(';')[0]); i++) body.push(lines[i]);
      for (let r = 0; r < parseInt(rept[1], 10); r++) for (const b of body) doLine(b);
      continue;
    }
    doLine(lines[i]);
  }
  return vals;
}
const wordsLE = a => {
  const b = Buffer.alloc(a.length * 2);
  a.forEach((v, i) => b.writeInt16LE(((v << 16) >> 16), i * 2));
  return b;
};

// plasma tables (ASMYT.ASM includes)
{
  const psini = parseNums(readSrc('PSINI.INC'), 'db');
  assert.equal(psini.length, 16384);
  assert.deepEqual(Buffer.from(psini), readAsset('plz_psini.bin'), 'plz_psini.bin != PSINI.INC');
  const l4 = parseNums(readSrc('LSINI4.INC'), 'dw');
  assert.equal(l4.length, 8192);
  assert.deepEqual(wordsLE(l4), readAsset('plz_lsini4.bin'), 'plz_lsini4.bin != LSINI4.INC');
  const l16 = parseNums(readSrc('LSINI16.INC'), 'dw');
  assert.equal(l16.length, 8192);
  assert.deepEqual(wordsLE(l16), readAsset('plz_lsini16.bin'), 'plz_lsini16.bin != LSINI16.INC');
  // PTAU.PRE is a C initializer {0,...};
  const pt = readSrc('PTAU.PRE').match(/-?\d+/g).map(Number);
  assert.equal(pt.length, 129);
  assert.deepEqual(Buffer.from(pt), readAsset('plz_ptau.bin'), 'plz_ptau.bin != PTAU.PRE');
}
// vect tables (SPLINE.ASM / INCLUDE.ASM includes)
{
  const sinBytes = parseNums(readSrc('SINIT.INC'), 'db');
  assert.equal(sinBytes.length, 2575);
  const sinWords = [];
  for (let i = 0; i + 1 < sinBytes.length; i += 2)
    sinWords.push(((sinBytes[i] | (sinBytes[i + 1] << 8)) << 16) >> 16);
  assert.deepEqual(wordsLE(sinWords), readAsset('plz_sinit.bin'), 'plz_sinit.bin != SINIT.INC');
  assert.equal(sinWords[0], 0);
  assert.equal(sinWords[256], 32766);   // kosinit[0] (=sinit+512 bytes)
  const spl = parseNums(readSrc('SPLINE.INC'), 'dw');
  assert.equal(spl.length, 1024);
  for (const f of [0, 97, 255])          // basis banks sum to unity in 1.15
    assert.ok(Math.abs(spl[f] + spl[f + 256] + spl[f + 512] + spl[f + 768] - 32768) <= 64);
  assert.deepEqual(wordsLE(spl), readAsset('plz_splinecoef.bin'), 'plz_splinecoef.bin != SPLINE.INC');
  const rata = parseNums(readSrc('RATA.INC'), 'dw');
  assert.equal(rata.length, 136 * 8);   // 36 authored + REPT 100 hold
  assert.deepEqual(wordsLE(rata), readAsset('plz_rata.bin'), 'plz_rata.bin != RATA.INC');
}

// ---- 2. module behavior ---------------------------------------------------

globalThis.fetch = async (url) => {
  const b = fs.readFileSync(path.join(webRoot, url));
  return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};
const plz = await import(`${pathToFileURL(path.join(webRoot, 'plzpart.js')).href}?validation=1`);
const { descramble, buildTimeline, musplusAtTime } = await import(pathToFileURL(path.join(webRoot, 's3msim.js')).href);

const mb = fs.readFileSync(path.join(webRoot, 'assets', 'music1.s3m'));
const tl = buildTimeline(descramble(mb.buffer.slice(mb.byteOffset, mb.byteOffset + mb.byteLength)));
// Nominal anchor: plzT0 = demo 305.21, MUSIC1 t0 = demo 108.5 (main.js).
const M1_0 = 305.21 - 108.5;
const musplusFn = (localS) => musplusAtTime(tl, M1_0 + localS);

await plz.loadPlzpart();

// White entry seam.
plz.plzpartReset();
assert.ok(plz.plzpartPal.every(v => v === 63), 'reset() must present the white seam');
plz.plzpartStepTo(0, true, musplusFn);
assert.ok(plz.plzpartPal.every(v => v === 63), 'frame 0 (prewait) stays white');

// Frame walk: observable screen states pin the stage boundaries.
plz.plzpartReset();
// the plasma renders at its native 320x400 (plzpartVram400); vect stays 320x200
const screen = () => (plz.plzpartMode400() ? plz.plzpartVram400 : plz.plzpartVram);
const lum = () => {
  const fb = screen();
  let s = 0, n = 0;
  for (let i = 0; i < fb.length; i += 97) {
    const c = fb[i];
    s += plz.plzpartPal[c * 3] + plz.plzpartPal[c * 3 + 1] + plz.plzpartPal[c * 3 + 2];
    n++;
  }
  return s / n;
};
const classify = () => {
  let white = true;
  for (let i = 0; i < 768; i += 47) if (plz.plzpartPal[i] !== 63) { white = false; break; }
  if (white) return 'white';
  return lum() < 1 ? 'black' : 'content';
};
const transitions = [];
let lastState = null, alive = true;
for (let f = 0; f <= 70 * 100 && alive; f++) {
  alive = plz.plzpartStepTo(f / 70, true, musplusFn);
  const st = alive ? classify() : 'ENDED';
  if (st !== lastState) { transitions.push([f, st]); lastState = st; }
}
// Expected chain under the nominal anchor (see plzpart.js header: prewait
// gate at local 1.059s; falls at MFRAME_HZ-converted TIMETABLE ticks;
// vect at musplus>=13; exit at musplus in [-4,0) → local 67.30s = demo
// 372.51). Values were cross-checked frame-by-frame against the reference
// capture (video ≈ demo+0.6s throughout this span) before being pinned.
assert.deepEqual(transitions, [
  [0, 'white'],
  [78, 'content'],     // plasma fade-in visible (prewait ended frame 75)
  [1126, 'black'],     // fall 1 fully off (event 723 ticks + 64-tick drop)
  [1131, 'content'],   // stage 2 fade-in
  [2153, 'black'],     // fall 2
  [2158, 'content'],   // stage 3
  [2662, 'black'],     // fall 3 + PLZ.C:94 break (screen blanks for good)
  [2717, 'content'],   // vect cube entry (musplus>=13 gate)
  [4689, 'black'],     // light source rotates behind the cube (capture-real; the
                       // masked span edge bytes keep it lit one frame longer
                       // than bare spans would)
  [4711, 'ENDED'],     // musplus in [-4,0)
], 'stage-boundary chain changed');
assert.equal(plz.plzpartDurationS().toFixed(2), '67.30');

// Span edge bytes (PLZA.ASM @@twobyte fall-through): the cube silhouette
// must have no interior black runs (965 black pixels appear inside the
// silhouette at 45s if the edge bytes are dropped).
{
  plz.plzpartReset();
  plz.plzpartStepTo(45.0, true, musplusFn);
  let holes = 0;
  for (let y = 0; y < 200; y++) {
    const row = plz.plzpartVram.subarray(y * 320, (y + 1) * 320);
    let first = -1, last = -1;
    for (let x = 0; x < 320; x++) if (row[x]) { if (first < 0) first = x; last = x; }
    for (let x = first; x >= 0 && x <= last; x++) if (!row[x]) holes++;
  }
  assert.ok(holes === 0, `interior black pixels inside cube silhouette: ${holes}`);
}

// Replay (single big seek) must equal the frame-by-frame walk.
const snapAt = async (t, mode) => {
  plz.plzpartReset();
  if (mode === 'replay') plz.plzpartStepTo(t, true, musplusFn);
  else for (let f = 0; f <= Math.floor(t * 70); f++) plz.plzpartStepTo(f / 70, true, musplusFn);
  return sha(Buffer.concat([Buffer.from(plz.plzpartVram), Buffer.from(plz.plzpartVram400), Buffer.from(plz.plzpartPal)]));
};
for (const t of [8.0, 22.0, 34.0, 45.0, 60.0]) {
  assert.equal(await snapAt(t, 'replay'), await snapAt(t, 'walk'), `replay != walk at ${t}s`);
}

// Determinism: two full replays identical.
assert.equal(await snapAt(66.0, 'replay'), await snapAt(66.0, 'replay'));

// Gate pass-throughs (no hidden constants): a scripted musplusFn moves
// every boundary; the exit fires during replay too (VECT.C:119-120).
{
  plz.plzpartReset();
  const script = (localS) => (localS < 2.0 ? -32 : localS < 41.0 ? 0 : localS < 42.0 ? 13 : -2);
  // prewait holds while m<0 (until 2.0s), plasma runs its fixed span, the
  // musplus>=13 gate opens at 41.0s, exit window [-4,0) at 42.0s.
  let alive2 = true;
  for (let f = 0; f <= 70 * 60 && alive2; f++) alive2 = plz.plzpartStepTo(f / 70, true, script);
  assert.ok(!alive2, 'scripted run must end via the musplus exit window');
  const endS = plz.plzpartDurationS();
  assert.ok(Math.abs(endS - 42.0) < 0.05, `exit must fire at the [-4,0) window (got ${endS})`);
  // and a pure replay seek reproduces the same duration
  plz.plzpartReset();
  plz.plzpartStepTo(60, true, script);
  assert.ok(!plz.plzpartStepTo(60, true, script));
  assert.equal(plz.plzpartDurationS(), endS, 'replay must hit the same exit');
}

console.log('validate_plzpart: all checks passed');
