#!/usr/bin/env node
// Extract PLZPART vect-section data tables from the original TASM include
// files into flat little-endian Int16 binaries for the browser port:
//
//   PLZPART/SINIT.INC   -> assets/plz_sinit.bin       (1287 words)
//   PLZPART/SPLINE.INC  -> assets/plz_splinecoef.bin  (1024 words)
//   PLZPART/RATA.INC    -> assets/plz_rata.bin        (136 control points x 8 words)
//
// SINIT.INC is a `db` byte table of little-endian int16 pairs: sinit[i] ~=
// sin(i*2*pi/1024)*32767.  INCLUDE.ASM declares `kosinit=sinit+512` (bytes),
// i.e. kosinit[i] = sinit[i+256]; indices used go up to 1023+256 = 1279,
// within the 1287 words present (the file ends with one stray odd byte that
// belongs to no complete word and is dropped).
//
// SPLINE.INC is a `dw` table of 1024 spline basis coefficients (4 banks of
// 256, ~0.5 peak in 1.15 fixed point -- the "only first half included"
// comment in the file is stale; all four banks are present).  SPLINE.ASM's
// getspl() computes, for control-point index c = pos>>8 and fraction
// f = pos&255, each of 8 components j as
//   (cp[c+3][j]*coef[f] + cp[c+2][j]*coef[f+256]
//    + cp[c+1][j]*coef[f+512] + cp[c][j]*coef[f+768]) >> 15
// The four banks sum to ~32768 (unity in 1.15) at every fraction, so spline
// outputs are full-scale control-point values (dis=500 means distance 500).
//
// RATA.INC is a `dw` table of 8-word camera control points
// (tx, ty, dis, kx, ky, kz, ls_kx, ls_ky -- order fixed by getspl's pop
// sequence, NOT by the stale "dx,dy,dz" comment in the file), using a
// TASM numeric equate (kkk=100), N*M expressions, and a REPT 100 block.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const srcDir = path.resolve(webRoot, '..', 'PLZPART');
const outDir = path.join(webRoot, 'assets');

const readSrc = f => fs.readFileSync(path.join(srcDir, f), 'latin1');

// Parse `db`/`dw` lines with numeric-equate + A*B expression support and
// REPT n ... ENDM expansion. Comments start with ';'.
function parseTable(text, directive) {
  const equates = new Map();
  const vals = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  const evalTok = (tok) => {
    tok = tok.trim();
    const m = tok.match(/^(-?\w+)\s*\*\s*(-?\w+)$/);
    if (m) return evalTok(m[1]) * evalTok(m[2]);
    if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
    if (equates.has(tok)) return equates.get(tok);
    throw new Error(`cannot evaluate token: ${JSON.stringify(tok)}`);
  };
  const doLine = (line) => {
    line = line.split(';')[0];
    const eq = line.match(/^\s*(\w+)\s*=\s*(-?\d+)\s*$/);
    if (eq) { equates.set(eq[1], parseInt(eq[2], 10)); return; }
    const m = line.match(new RegExp(`^\\s*${directive}\\s+(.*)$`, 'i'));
    if (!m) return;
    for (const tok of m[1].split(',')) if (tok.trim()) vals.push(evalTok(tok));
  };
  while (i < lines.length) {
    const line = lines[i].split(';')[0];
    const rept = line.match(/^\s*REPT\s+(\d+)\s*$/i);
    if (rept) {
      const n = parseInt(rept[1], 10);
      const body = [];
      i++;
      while (i < lines.length && !/^\s*ENDM\s*$/i.test(lines[i].split(';')[0])) {
        body.push(lines[i]); i++;
      }
      i++; // skip ENDM
      for (let r = 0; r < n; r++) for (const b of body) doLine(b);
      continue;
    }
    doLine(lines[i]); i++;
  }
  return vals;
}

function writeWords(name, words) {
  const buf = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => buf.writeInt16LE(((w << 16) >> 16), i * 2));
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`${name}: ${words.length} words`);
  return buf;
}

// SINIT.INC: db byte pairs -> LE words (drop trailing odd byte).
const sinBytes = parseTable(readSrc('SINIT.INC'), 'db');
if (sinBytes.length !== 2575) throw new Error(`SINIT byte count ${sinBytes.length} != 2575`);
const sinWords = [];
for (let i = 0; i + 1 < sinBytes.length; i += 2)
  sinWords.push(((sinBytes[i] | (sinBytes[i + 1] << 8)) << 16) >> 16);
if (sinWords.length !== 1287) throw new Error('SINIT word count');
if (sinWords[0] !== 0 || sinWords[1] !== 201 || sinWords[256] !== 32766)
  throw new Error('SINIT sanity failed');
writeWords('plz_sinit.bin', sinWords);

// SPLINE.INC: 1024 dw coefficients.
const spl = parseTable(readSrc('SPLINE.INC'), 'dw');
if (spl.length !== 1024) throw new Error(`SPLINE count ${spl.length} != 1024`);
// basis banks must sum to ~32768 (unity in 1.15) at every fraction
for (const f of [0, 64, 128, 255]) {
  const s = spl[f] + spl[f + 256] + spl[f + 512] + spl[f + 768];
  if (Math.abs(s - 32768) > 64) throw new Error(`SPLINE basis sum ${s} at f=${f}`);
}
writeWords('plz_splinecoef.bin', spl);

// RATA.INC: 8-word control points (kkk=100 equate + REPT 100 tail).
const rata = parseTable(readSrc('RATA.INC'), 'dw');
if (rata.length !== 136 * 8) throw new Error(`RATA count ${rata.length} != ${136 * 8}`);
if (String(rata.slice(0, 8)) !== String([0, 2000, 500, 0, 400, 600, 0, 0]))
  throw new Error('RATA row0 sanity failed');
if (String(rata.slice(-8)) !== String([0, 0, 500, 0, 0, 0, 256, 512]))
  throw new Error('RATA last-row sanity failed');
writeWords('plz_rata.bin', rata);

console.log('OK');
