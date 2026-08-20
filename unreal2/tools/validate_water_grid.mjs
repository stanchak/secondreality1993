#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WEB = join(HERE, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function sameFile(source, bundled) {
  const a = readFileSync(join(ROOT, source));
  const b = readFileSync(join(WEB, 'assets', bundled));
  assert.deepEqual(b, a, `${bundled} must be a byte-exact ${source} copy`);
}

// The Pascal/C units actually link OMF objects.  Reconstruct each LEDATA
// record by its segment offset and prove the linked payload is the same file
// copied into the browser bundle (important because concatenating OMF record
// bodies would leave record metadata inside the pixels).
function omfLeData(path) {
  const object = readFileSync(join(ROOT, path));
  let p = 0;
  let output = Buffer.alloc(0);
  while (p + 3 <= object.length) {
    const type = object[p];
    const length = object[p + 1] | (object[p + 2] << 8); // includes checksum
    const body = object.subarray(p + 3, p + 3 + length - 1);
    if (type === 0xa0) {
      let q = 0;
      const segmentIndex = body[q++];
      if (segmentIndex & 0x80) q++; // OMF variable-length index
      const offset = body[q] | (body[q + 1] << 8); q += 2;
      const data = body.subarray(q);
      if (output.length < offset + data.length) {
        const grown = Buffer.alloc(offset + data.length);
        output.copy(grown);
        output = grown;
      }
      data.copy(output, offset);
    }
    p += 3 + length;
  }
  assert.equal(p, object.length, `${path}: exact OMF record length`);
  return output;
}

for (const [object, source] of [
  ['WATER/BKG.OBJ', 'WATER/BKG.CLX'],
  ['WATER/MIEKKA.OBJ', 'WATER/MIEKKA.SCI'],
  ['WATER/WAT1.OBJ', 'WATER/WAT1.DAT'],
  ['WATER/WAT2.OBJ', 'WATER/WAT2.DAT'],
  ['WATER/WAT3.OBJ', 'WATER/WAT3.DAT'],
]) {
  assert.deepEqual(omfLeData(object), readFileSync(join(ROOT, source)),
    `${object} LEDATA must reconstruct ${source}`);
}

sameFile('WATER/BKG.CLX', 'ray_bkg.clx');
sameFile('WATER/MIEKKA.SCI', 'ray_miekka.sci');
for (let i = 1; i <= 3; i++) sameFile(`WATER/WAT${i}.DAT`, `ray_wat${i}.dat`);

const expectedWat = [
  { bytes: 23096, offsets: 6176, nonempty: 2324, max: 20 },
  { bytes: 23034, offsets: 6145, nonempty: 2316, max: 18 },
  { bytes: 27818, offsets: 8537, nonempty: 2883, max: 24 },
];
for (let stream = 1; stream <= 3; stream++) {
  const bytes = readFileSync(join(ROOT, `WATER/WAT${stream}.DAT`));
  let p = 0, offsets = 0, nonempty = 0, max = 0;
  for (let cell = 0; cell < 158 * 34; cell++) {
    const count = bytes[p] | (bytes[p + 1] << 8); p += 2;
    offsets += count;
    if (count) nonempty++;
    max = Math.max(max, count);
    for (let i = 0; i < count; i++, p += 2)
      assert.ok((bytes[p] | (bytes[p + 1] << 8)) < 64000, `WAT${stream} VGA offset`);
  }
  assert.deepEqual({ bytes: p, offsets, nonempty, max }, expectedWat[stream - 1]);
  assert.equal(p, bytes.length, `WAT${stream} exact parse length`);
}

// Browser-compatible local fetch for importing the production modules in Node.
globalThis.fetch = input => new Promise(resolveResponse => {
  const path = resolve(WEB, String(input));
  readFile(path, (error, bytes) => {
    if (error) resolveResponse(new Response('', { status: 404 }));
    else resolveResponse(new Response(bytes, { status: 200 }));
  });
});

const rays = await import('../rayscrl.js');
await rays.loadRayscrl();
rays.rayscrlReset();
const waterPosition = seconds => {
  const frame = Math.floor(seconds * 70 + 1e-7);
  const absoluteRow = Math.floor(frame / 4);
  const order = 10 + Math.floor(absoluteRow / 64);
  const row = absoluteRow & 63;
  return { musplus: frame >= 400 ? -11 : (order === 10 && row < 32 ? row : -32),
           order, row };
};

rays.rayscrlStepTo(126 / 70, true, waterPosition);
assert.equal(hash(rays.rayscrlVram),
  'afda560cbf29fce267ec3e29e949bb4deeb47ea4a81e57992354d916ff03e660',
  'WATER zero-fbuf sparse screens restore BKG exactly');
assert.equal(hash(rays.rayscrlPal),
  '3360879e5f721a464e207a11532a3918b235b20f12dc6c80b0ede39df3e14aba',
  'WATER inclusive 127-frame fade and pf=0..3 overlap');
rays.rayscrlStepTo(399 / 70, true, waterPosition);
assert.equal(hash(rays.rayscrlVram),
  '1edace94fd3e9cd62bf5709561e12557328652fedd70058c58a39d12ec8ef081',
  'WATER WAT compositor + one-column-per-three-vblanks fbuf scroll');
rays.rayscrlStepTo(464 / 70, true, waterPosition);
assert.equal(rays.rayscrlEnded(), true);
assert.equal(rays.rayscrlDurationS(), 464 / 70, 'WATER fp=64 requires 65 fadeout iterations');
assert.equal(hash(rays.rayscrlPal),
  'ef115a0e0c15cdc41958ca46b5b14b456115f4baec5e3ca68599d2a8f435e3b8',
  'WATER fadeout reaches black');

// ============================ COMAN (3DSINFLD) ============================
// The shipped 3DSINFLD.EXE is COMAN, not GRID (proven by unpacking its
// PKLITE 1.14 + LINK /E EXEPACK layers: THELOOP.OBJ and ASM.OBJ match the
// load image byte-for-byte apart from link fixups, the wave tables sit at
// image 0x9440/0x19440, and MAIN.C matches the disassembly).  These checks
// validate the browser port against the COMAN sources, not against itself.

// 1. Bundled wave tables are byte-exact copies of the originals, and the
//    originals are reproduced by MAIN.C's CALCW12 generator over WAVE.H with
//    MS C rand() — the same provenance as the tables linked into the EXE.
sameFile('COMAN/W1DTA.BIN', 'coman_w1.bin');
sameFile('COMAN/W2DTA.BIN', 'coman_w2.bin');
{
  const waveText = readFileSync(join(ROOT, 'COMAN/WAVE.H'), 'latin1');
  const wavesin = Int16Array.from(waveText.match(/-?\d+/g).map(Number));
  assert.equal(wavesin.length, 1024, 'WAVE.H holds 1024 wavesin entries');
  let seed = 1;
  const rand = () => {
    seed = (Math.imul(seed, 214013) + 2531011) | 0;
    return (seed >>> 16) & 0x7fff;
  };
  const t = Math.trunc;
  const w1 = new Int16Array(32768);
  const w2 = new Int16Array(32768);
  let u = 0;
  for (let block = 0; block < 128; block++) {
    for (let a = 0; a < 256; a++) {
      let k = (u * 1024 * 7) >> 15;
      let j = t(wavesin[k & 1023] / 8);
      k = (u * 1024 * 3) >> 15;
      j += t(wavesin[k & 1023] / 7) + t((rand() & 7) * a / 256);
      w1[u] = t(j * 5 / 9);
      k = (u * 1024 * 5) >> 15;
      let j2 = t(wavesin[k & 1023] / 5);
      k = (u * 1024 * 2) >> 15;
      j2 += t(wavesin[k & 1023] / 6);
      w2[u] = t(j2 * 7 / 9);
      u++;
    }
  }
  const toBytes = words => {
    const bytes = Buffer.alloc(words.length * 2);
    words.forEach((v, i) => bytes.writeInt16LE(v, 2 * i));
    return bytes;
  };
  assert.deepEqual(toBytes(w1), readFileSync(join(ROOT, 'COMAN/W1DTA.BIN')),
    'CALCW12 generator + MS C rand() reproduces W1DTA.BIN');
  assert.deepEqual(toBytes(w2), readFileSync(join(ROOT, 'COMAN/W2DTA.BIN')),
    'CALCW12 generator reproduces W2DTA.BIN');
}

// 2. sin1024 formula against COMAN/SIN1024.INC (the port generates the same
//    table instead of shipping the include).
{
  const incText = readFileSync(join(ROOT, 'COMAN/SIN1024.INC'), 'latin1');
  const values = [];
  for (const line of incText.split(/\r?\n/)) {
    const m = line.match(/^dw\s+(.*)/i);
    if (m) for (const v of m[1].split(',')) values.push(parseInt(v.trim(), 10));
  }
  assert.equal(values.length, 1024, 'SIN1024.INC holds 1024 words');
  for (let i = 0; i < 1024; i++)
    assert.equal(Math.trunc(Math.sin(i * Math.PI * 2 / 1024) * 256), values[i],
      `sin1024[${i}] must equal trunc(sin*256)`);
}

// 3. THELOOP.INC block structure against the port's derived tables: parse the
//    generated assembly and check every terrain offset (zwave[j]-240), colour
//    base (140-j/8), ray step flip(j*2560), block order (0..63 then even
//    64..190 with double-add), and the ecx init.
{
  const inc = readFileSync(join(ROOT, 'COMAN/THELOOP.INC'), 'latin1');
  assert.ok(inc.includes('mov ecx,0EC00FFFAh'), 'ray direction init flip(-(200-70)*2560)');
  const wflip = value => {
    const v = value >>> 0;
    return (((v & 0xffff) << 16) | (v >>> 16)) >>> 0;
  };
  const expectJ = [];
  for (let j = 0; j < 64; j++) expectJ.push(j);
  for (let j = 64; j < 192; j += 2) expectJ.push(j);
  const blocks = [...inc.matchAll(
    /_@seek(\d+):\r?\nadd si,ds:theloop_xsina(\d)[\s\S]*?add bx,(-?\d+)\r?\n[\s\S]*?(?:lea dx,\[bx\+(\d+)\]\r?\nshr dl,1\r?\n_@hit\d+:\r?\nadd eax,0([0-9A-F]+)h[\s\S]*?)?_@seeko\1:\r?\nadd eax,ecx\r?\n(adc eax,ecx\r?\n)?adc ax,-1/g,
  )];
  assert.equal(blocks.length, 128, 'THELOOP.INC has 128 seek blocks');
  blocks.forEach((m, bi) => {
    const j = Number(m[1]);
    assert.equal(j, expectJ[bi], `block ${bi} distance index`);
    assert.equal(Number(m[2]), bi < 64 ? 1 : 2, `block ${bi} single/double si step`);
    assert.equal(Number(m[3]),
      Math.trunc(16 * Math.sin(j * 3.1415926535 * 2 * 3 / 192)) - 240,
      `block ${bi} zwave[${j}]-240`);
    assert.equal(Number(m[4]), 140 - Math.trunc(j / 8), `block ${bi} colour base 140-j/8`);
    assert.equal(parseInt(m[5], 16) >>> 0, wflip(j * 2560), `block ${bi} step flip(${j}*2560)`);
    assert.equal(m[6] !== undefined, bi >= 64, `block ${bi} seeko double-add`);
  });
}

// 4. Functional gates and behaviour of the port itself.
const coman = await import('../sinfield.js');
await coman.loadSinfield();

// Palette: independently re-derived from the MAIN.C generator (entries
// 240..255 keep the red tail because `palette[x]=combg[16+x]` reads the
// 16-byte combg stub that directly precedes palette[] — a no-op).
{
  const sin = i => Math.trunc(Math.sin((i & 1023) * Math.PI * 2 / 1024) * 256);
  const t = Math.trunc;
  const pal = new Uint8Array(768);
  for (let a = 0; a < 256; a++) {
    const uc = (223 - t(a * 22 / 26)) * 3;
    let b = t((230 - a) / 4) + t(sin(a * 4) / 32);
    pal[uc + 1] = Math.min(63, Math.max(0, b));
    pal[uc + 2] = Math.min(63, t((255 - a) / 3));
    b = Math.min(40, Math.abs(a - 220));
    pal[uc + 0] = t((40 - b) / 3);
  }
  for (let i = 0; i < 720; i++) pal[i] = Math.min(63, t(pal[i] * 9 / 6));
  for (let a = 0; a < 24; a++) {
    const uc = (255 - a) * 3;
    pal[uc + 0] = t(Math.max(0, a - 4) / 2);
    pal[uc + 1] = 0;
    pal[uc + 2] = 0;
  }
  pal[0] = pal[1] = pal[2] = 0;
  coman.sinfieldReset();
  assert.deepEqual(Uint8Array.from(coman.sinfieldPal), pal,
    'COMAN palette generator matches MAIN.C formulas');
}

// Entry busy-wait: nothing draws while dis_musplus()<0.
coman.sinfieldReset();
const blank = hash(coman.sinfieldVram);
const waitThenStart = seconds => (seconds < 5 / 70 ? -32 : Math.round(seconds * 70) - 5);
coman.sinfieldStepTo(4 / 70, true, waitThenStart);
assert.equal(hash(coman.sinfieldVram), blank, '3DSINFLD holds before musplus>=0');
coman.sinfieldStepTo(6 / 70, true, waitThenStart);
assert.equal(coman.sinfieldEnded(), false);
// The landscape starts fully below the visible window (startrise=160): the
// screen must stay black until startrise+70 < 200, i.e. 30 frames in.
coman.sinfieldStepTo(20 / 70, true, waitThenStart);
assert.equal(hash(coman.sinfieldVram), blank, 'descent starts below the visible window');
coman.sinfieldStepTo(80 / 70, true, waitThenStart);
assert.notEqual(hash(coman.sinfieldVram), blank, 'landscape has risen into view');

// Exit gate: musplus -8 must NOT exit (exclusive window), -7 must.
coman.sinfieldReset();
const edge = seconds => {
  const f = Math.round(seconds * 70);
  if (f < 100) return f;
  return f < 105 ? -8 : -7;
};
coman.sinfieldStepTo(104 / 70, true, edge);
assert.equal(coman.sinfieldEnded(), false, 'musplus=-8 does not break the loop');
const beforeExit = hash(coman.sinfieldVram);
coman.sinfieldStepTo(120 / 70, true, edge);
assert.equal(coman.sinfieldEnded(), true, 'musplus=-7 breaks the loop');
assert.equal(coman.sinfieldDurationS(), 105 / 70, 'duration pinned at the exit frame');
assert.equal(hash(coman.sinfieldVram), beforeExit, 'exit tested before drawing');

// Rise-out: musplus in (-30,0) pulls the landscape back down one row/frame.
{
  const topRow = vram => {
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 320; x++) if (vram[y * 320 + x]) return y;
    return 200;
  };
  coman.sinfieldReset();
  const tail = seconds => {
    const f = Math.round(seconds * 70);
    return f < 400 ? f : Math.min(-29 + (f - 400), -1);
  };
  coman.sinfieldStepTo(399 / 70, true, tail);
  const before = topRow(coman.sinfieldVram);
  coman.sinfieldStepTo(415 / 70, true, tail);
  const after = topRow(coman.sinfieldVram);
  assert.ok(after >= before + 14 && after <= before + 17,
    `startrise+=1 per (-30,0) frame sinks the horizon (${before} -> ${after})`);
  coman.sinfieldStepTo(430 / 70, true, tail);
  assert.equal(coman.sinfieldEnded(), true, 'run-out reaches the -7..-1 window');
  assert.equal(coman.sinfieldDurationS(), 422 / 70, 'exit on the first -7 frame');
}

// Replay must reproduce the live stepping exactly (minvball.js:430 convention)
// and only colours 0..127 may ever be drawn (`shr dl,1` of a low byte), which
// also proves palette entries 128..255 are invisible.
{
  const script = seconds => Math.round(seconds * 70);
  coman.sinfieldReset();
  for (let f = 0; f <= 300; f++) coman.sinfieldStepTo(f / 70, false, script);
  const live = hash(coman.sinfieldVram);
  let maxColour = 0;
  for (const v of coman.sinfieldVram) if (v > maxColour) maxColour = v;
  coman.sinfieldReset();
  coman.sinfieldStepTo(300 / 70, true, script);
  assert.equal(hash(coman.sinfieldVram), live, 'replay == live stepping');
  assert.ok(maxColour < 128, `drawn colours stay below 128 (got ${maxColour})`);
}

// Regression hashes (REGRESSION-ONLY: they pin the current port output so
// refactors cannot silently change pixels; they are not derived from COMAN).
{
  coman.sinfieldReset();
  const script = seconds => Math.round(seconds * 70);
  coman.sinfieldStepTo(110 / 70, true, script);
  assert.equal(hash(coman.sinfieldVram),
    '1832005b57aac87e75bf588e0a72cb368d4bcee15e3fd23fb76523b1675d0c83',
    'regression: descent frame 110');
  coman.sinfieldStepTo(740 / 70, true, script);
  assert.equal(hash(coman.sinfieldVram),
    '008eef278622c2b999b4d37ef0a7a1e1760248344a9fca09f4c32a07831ae56f',
    'regression: flight frame 740');
}

console.log('WATER/COMAN validation passed: exact assets, wave provenance, theloop tables, palette and gates');
