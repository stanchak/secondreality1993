// Regenerate every U2A ("Alkutekstit II", the spaceship flyby) asset the
// browser port consumes, straight from the 1993 source drop. Closes the last
// gap in the extractor coverage: u2a_geo.json / u2a_anim.bin / u2a_bg.bin used
// to be non-regenerable binaries with no tool behind them.
//
//   node tools/extract_u2a_assets.mjs [--check]
//
// --check writes nothing; it only reports whether the committed assets already
// match what the source produces.
//
// Inputs (all verbatim from the drop):
//   MAIN/DATA/U2A.00M      scene master: DAC palette + the object instance list
//   MAIN/DATA/U2A.001-003  VISU object files (the three ship/escort models)
//   MAIN/DATA/U2A.0AA      animation index (names the single scene, "0AB")
//   MAIN/DATA/U2A.0AB      the keyframe animation byte-code stream
//   VISU/C/_BG.OBK         the background picture, OMF-linked into U2A.EXE
//   VISU/C/U2ABG.UH        the same picture as a standalone dev file (cross-check)
//
// Formats, all read out of the source rather than guessed:
//
//   Object file (VISU.C vis_loadobject): a chunk stream. Each chunk is a
//   4-char tag + u32 payload length, then that many payload bytes.
//     VERS  u32 version (0x100)
//     NAME  the object's quoted name
//     VERT  u16 vnum, u16 pad, then vnum * s_vlist {i32 x,y,z; i16 normal,pad}
//     NORM  u16 nnum, u16 nnum1, then nnum * s_nlist {i16 x,y,z,pad}
//     POLY  polydata (CD.H): a leading zero word, then records
//           {u8 sides, u8 flags, u8 color, u8 pad, u16 normal, u16 v[sides]}
//     ORD0  polylist (CD.H): u16 length-in-words, u16 centre vertex,
//           then u16 byte-offsets into polydata, terminated by 0
//     ORDE  the same, once per precalculated sort direction (1..8)
//     END   stops the parse
//   nnum1 splits the normals: 0..nnum1 are face normals, nnum1..nnum are the
//   per-vertex gouraud normals that s_vlist.normal indexes.
//
//   Scene master (U2A.C main): u32 at offset 4 is the byte offset of the
//   object list; that list is u16 conum followed by conum-1 model indices
//   (co[0] is the camera). Bytes 16..784 are the 256-entry 6-bit DAC palette,
//   whose top 64 entries U2A.C overwrites from the background's own palette
//   (memcpy(scene0+16+192*3, bg+16, 64*3)) before programming the DAC.
//
//   Background (U2ABG.UH / _BG.OBK payload): 16-byte header, 768-byte palette,
//   then 64000 linear 320x200 pixels. U2A.C re-orders those pixels into mode-X
//   plane order for its planar blit; a linear framebuffer needs them as-is, so
//   the port stores the linear form and the de-planarisation is a no-op here.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const ROOT = join(WEB, '..');
const DATA = join(ROOT, 'MAIN', 'DATA');
const ASSETS = join(WEB, 'assets');
const CHECK = process.argv.includes('--check');

const rd = (...p) => new Uint8Array(readFileSync(join(...p)));
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const i16 = (b, o) => (u16(b, o) << 16) >> 16;
const i32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
const u32 = (b, o) => i32(b, o) >>> 0;

// ---- VISU object file ------------------------------------------------------

function loadObject(buf) {
  const o = { name: '', v: [], vn: [], n: [], nnum1: 0, p: [], ord: [] };
  let pd = null, ord0 = null; const orde = [];
  for (let d = 0; d + 8 <= buf.length;) {
    const tag = String.fromCharCode(buf[d], buf[d + 1], buf[d + 2], buf[d + 3]);
    const len = u32(buf, d + 4);
    const p = d + 8;
    if (tag === 'END ') break;
    else if (tag === 'VERS') {
      const ver = u32(buf, p);
      if (ver !== 0x100) throw new Error(`object version ${ver.toString(16)} != 100`);
    } else if (tag === 'NAME') {
      o.name = String.fromCharCode(...buf.subarray(p, p + len)).replace(/[\0"]/g, '');
    } else if (tag === 'VERT') {
      const vnum = u16(buf, p);
      for (let i = 0, q = p + 4; i < vnum; i++, q += 16) {
        o.v.push([i32(buf, q), i32(buf, q + 4), i32(buf, q + 8)]);
        o.vn.push(i16(buf, q + 12));
      }
    } else if (tag === 'NORM') {
      const nnum = u16(buf, p);
      o.nnum1 = u16(buf, p + 2);
      for (let i = 0, q = p + 4; i < nnum; i++, q += 8)
        o.n.push([i16(buf, q), i16(buf, q + 2), i16(buf, q + 4)]);
    } else if (tag === 'POLY') {
      pd = buf.subarray(p, p + len);
    } else if (tag === 'ORD0') {
      ord0 = buf.subarray(p, p + len);
    } else if (tag.startsWith('ORD')) {
      orde.push(buf.subarray(p, p + len));
    } else throw new Error(`unknown object chunk "${tag}"`);
    d = p + len;
  }
  if (!pd || !ord0) throw new Error('object missing POLY or ORD0');

  // ORD0's polygon offsets are the object's authored ("unsorted") draw order,
  // and word 1 is the centre vertex vis_drawobject/U2A.C z-sort against.
  const readList = (l) => {
    const words = u16(l, 0), offs = [];
    for (let w = 2; w < words; w++) {
      const off = u16(l, w * 2);
      if (off === 0) break;
      offs.push(off);
    }
    return { centre: u16(l, 2), offs };
  };
  const l0 = readList(ord0);
  o.centre = l0.centre;
  // decode each polygon record once, keyed by its polydata byte offset
  const byOff = new Map();
  for (const off of l0.offs) {
    const sides = pd[off], flags = pd[off + 1], colour = pd[off + 2];
    const nrm = u16(pd, off + 4);
    const vs = [];
    for (let k = 0; k < sides; k++) vs.push(u16(pd, off + 6 + k * 2));
    byOff.set(off, { c: colour, n: nrm, v: vs, f: flags });
  }
  o.p = l0.offs.map((off) => {
    const r = byOff.get(off);
    return { c: r.c, n: r.n, v: r.v };
  });
  // the precalculated per-direction draw orders, as indices into o.p
  const idxOf = new Map(l0.offs.map((off, i) => [off, i]));
  for (const l of orde) {
    const li = readList(l);
    o.ord.push({ centre: li.centre, order: li.offs.map((off) => idxOf.get(off) ?? -1) });
  }
  return o;
}

// ---- OMF LEDATA payload (same trick TECHNO/_CIRCLE.OBK needed) -------------

function omfPayload(buf) {
  const out = [];
  let hi = 0;
  for (let p = 0; p + 3 <= buf.length;) {
    const rec = buf[p], len = u16(buf, p + 1), body = p + 3;
    if (rec === 0xa0 || rec === 0xa1) {           // LEDATA / LIDATA
      // byte: segment index, word: enumerated data offset, then the bytes
      const off = u16(buf, body + 1);
      const n = len - 1 - 2 - 1;                  // minus segidx, offset, checksum
      for (let i = 0; i < n; i++) out[off + i] = buf[body + 3 + i];
      hi = Math.max(hi, off + n);
    }
    p = body + len;
  }
  const flat = new Uint8Array(hi);
  for (let i = 0; i < hi; i++) flat[i] = out[i] ?? 0;
  return flat;
}

// ---- assemble --------------------------------------------------------------

const master = rd(DATA, 'U2A.00M');
const listOff = u32(master, 4);
const conum = u16(master, listOff);
const co = [0];
for (let c = 1; c < conum; c++) co.push(u16(master, listOff + c * 2));

// background: prefer the OBK actually linked into U2A.EXE, but prove the
// standalone .UH dev file agrees before trusting either.
const bgObk = omfPayload(rd(ROOT, 'VISU', 'C', '_BG.OBK'));
const bgUh = rd(ROOT, 'VISU', 'C', 'U2ABG.UH');
const bgLen = 16 + 768 + 64000;
if (bgObk.length < bgLen) throw new Error(`_BG.OBK payload short: ${bgObk.length}`);
for (let i = 0; i < bgLen; i++) {
  if (bgObk[i] !== bgUh[i]) throw new Error(`_BG.OBK and U2ABG.UH differ at ${i}`);
}
const bg = bgObk.subarray(0, bgLen);
const bgPixels = bg.subarray(16 + 768, bgLen);

// palette: the master's own 256 entries, top 64 replaced from the background
const palette = Array.from(master.subarray(16, 16 + 768));
for (let i = 0; i < 64 * 3; i++) palette[192 * 3 + i] = bg[16 + i];

const models = {};
const seen = new Set(co.slice(1));
for (const e of [...seen].sort((a, b) => a - b)) {
  const name = `U2A.${String(e).padStart(3, '0')}`;
  models[String(e)] = loadObject(rd(DATA, name));
}

// animation: U2A.0AA indexes the scene streams; U2A.C builds each name as
// "0" + (a/10 + 'A') + (a%10 + 'A') and stops at the first 0 (or -1).
const idx = rd(DATA, 'U2A.0AA');
const scenes = [];
for (let p = 0; p + 2 <= idx.length; p += 4) {
  const a = i16(idx, p);
  if (a === 0 || a === -1) break;
  scenes.push(`U2A.0${String.fromCharCode(65 + Math.floor(a / 10))}${String.fromCharCode(65 + (a % 10))}`);
}
if (scenes.length !== 1) throw new Error(`expected 1 animation scene, got ${scenes.join(',')}`);
const anim = rd(DATA, scenes[0]);

const geo = { conum, co, palette, models: {} };
for (const [k, m] of Object.entries(models)) {
  geo.models[k] = {
    v: m.v, vn: m.vn, n: m.n, nnum1: m.nnum1,
    p: m.p, centre: m.centre, ord: m.ord, name: m.name,
  };
}

// ---- emit / check ---------------------------------------------------------

const outs = [
  ['u2a_geo.json', Buffer.from(JSON.stringify(geo))],
  ['u2a_anim.bin', Buffer.from(anim)],
  ['u2a_bg.bin', Buffer.from(bgPixels)],
];

let bad = 0;
for (const [name, buf] of outs) {
  const path = join(ASSETS, name);
  if (CHECK) {
    let cur = null;
    try { cur = readFileSync(path); } catch { /* missing */ }
    const same = cur && cur.equals(buf);
    if (!same) bad++;
    console.log(`${same ? 'ok  ' : 'DIFF'} ${name} (${buf.length} bytes${cur ? `, on disk ${cur.length}` : ', absent'})`);
  } else {
    writeFileSync(path, buf);
    console.log(`wrote ${name} (${buf.length} bytes)`);
  }
}

console.log(`conum=${conum} co=[${co}] models=${Object.keys(models).join(',')}`);
for (const [k, m] of Object.entries(models))
  console.log(`  U2A.00${k} "${m.name}": ${m.v.length} verts, ${m.n.length} normals ` +
    `(${m.nnum1} face + ${m.n.length - m.nnum1} gouraud), ${m.p.length} polys, ` +
    `centre vertex ${m.centre}, ${m.ord.length} sort dirs`);
if (CHECK && bad) process.exitCode = 1;
